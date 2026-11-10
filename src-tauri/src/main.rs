#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Lite kernel (Rust side).
//! Knows nothing about editors, file trees or layouts. It only:
//!   - discovers plugins on disk and serves their files to the UI kernel
//!   - persists kernel state (disabled plugins, recent workspaces)
//!   - owns the workspace of each window (one window = one project folder)
//!   - exposes fs primitives, scoped to the window's workspace

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

mod pty;

type R<T> = Result<T, String>;

const MAX_RECENT: usize = 10;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Default)]
struct Kernel {
    /// window label -> canonical workspace root
    workspaces: Mutex<HashMap<String, PathBuf>>,
    /// serializes read-modify-write of state.json across windows
    state_lock: Mutex<()>,
    next_window: AtomicUsize,
}

/// Plugin directory: $LITE_PLUGINS_DIR, else `plugins/` next to the exe, else the dev tree.
fn plugins_dir() -> PathBuf {
    if let Ok(p) = std::env::var("LITE_PLUGINS_DIR") {
        return p.into();
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join("plugins");
        if p.is_dir() {
            return p;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins")
}

fn state_file() -> PathBuf {
    plugins_dir().join("state.json")
}

/// Strip the Windows `\\?\` prefix that canonicalize() adds, for display and round-tripping.
fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => rest.to_string(),
        _ => s.into_owned(),
    }
}

fn load_state() -> Value {
    fs::read_to_string(state_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_state(state: &Value) -> R<()> {
    let text = serde_json::to_string_pretty(state).map_err(err)?;
    fs::write(state_file(), text).map_err(err)
}

// ---------- plugin host ----------

#[tauri::command]
fn list_plugins() -> R<Vec<Value>> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(plugins_dir()) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("manifest.json");
        let Ok(text) = fs::read_to_string(&manifest) else {
            continue;
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(mut v) if v.is_object() => {
                v["dir"] = json!(entry.file_name().to_string_lossy());
                out.push(v);
            }
            _ => eprintln!("[lite] invalid manifest: {}", manifest.display()),
        }
    }
    Ok(out)
}

/// A file inside one plugin's directory; refuses anything that escapes it (`..`, links).
fn plugin_path(dir: &str, file: &str) -> R<PathBuf> {
    let base = plugins_dir().join(dir).canonicalize().map_err(err)?;
    let target = base.join(file).canonicalize().map_err(err)?;
    if !target.starts_with(&base) {
        return Err(format!("{file} escapes plugin directory"));
    }
    Ok(target)
}

#[tauri::command]
fn read_plugin_file(dir: String, file: String) -> R<String> {
    fs::read_to_string(plugin_path(&dir, &file)?).map_err(err)
}

fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `lite-plugin://localhost/<plugin dir>/<file>` (served as `http://lite-plugin.localhost/...` on Windows).
/// Plugin code and assets are fetched by the webview on demand instead of being read into JS strings,
/// so nothing is held in memory twice and unused files (e.g. language parsers) are never loaded.
fn serve_plugin_file(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let path = percent_decode(request.uri().path());
    let (dir, file) = path.trim_start_matches('/').split_once('/').unwrap_or(("", ""));
    let found = plugin_path(dir, file).and_then(|p| fs::read(&p).map(|b| (p, b)).map_err(err));
    let builder = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    match found {
        Ok((p, body)) => {
            let mime = match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
                "js" | "mjs" => "text/javascript",
                "css" => "text/css",
                "json" => "application/json",
                "wasm" => "application/wasm",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            builder.header(header::CONTENT_TYPE, mime).body(body)
        }
        Err(e) => builder.status(StatusCode::NOT_FOUND).body(e.into_bytes()),
    }
    .unwrap()
}

#[tauri::command]
fn read_state() -> Value {
    load_state()
}

#[tauri::command]
fn write_state(kernel: State<Kernel>, state: Value) -> R<()> {
    let _guard = kernel.state_lock.lock().unwrap();
    save_state(&state)
}

// ---------- workspace ----------

#[derive(Serialize)]
struct WorkspaceInfo {
    root: Option<String>,
    name: Option<String>,
}

/// Bind a folder to the calling window. `folder: None` + `restore` reopens the most recent
/// workspace (only for the first window); otherwise the window stays without a workspace.
#[tauri::command]
fn init_workspace(window: Window, kernel: State<Kernel>, folder: Option<String>, restore: bool) -> WorkspaceInfo {
    let _guard = kernel.state_lock.lock().unwrap();
    let mut state = load_state();
    let mut recent: Vec<String> = state["recent"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let wanted = match folder.filter(|f| !f.is_empty()) {
        Some(f) => Some(f),
        None if restore && window.label() == "main" => recent.first().cloned(),
        None => None,
    };
    let root = wanted.and_then(|f| Path::new(&f).canonicalize().ok()).filter(|p| p.is_dir());

    let Some(root) = root else {
        kernel.workspaces.lock().unwrap().remove(window.label());
        let _ = window.set_title("Lite");
        return WorkspaceInfo { root: None, name: None };
    };

    let shown = display(&root);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| shown.clone());
    kernel.workspaces.lock().unwrap().insert(window.label().into(), root);
    let _ = window.set_title(&format!("{name} — Lite"));

    recent.retain(|r| !r.eq_ignore_ascii_case(&shown));
    recent.insert(0, shown.clone());
    recent.truncate(MAX_RECENT);
    state["recent"] = json!(recent);
    if let Err(e) = save_state(&state) {
        eprintln!("[lite] cannot save state: {e}");
    }

    WorkspaceInfo { root: Some(shown), name: Some(name) }
}

#[tauri::command]
async fn pick_folder(window: Window) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| display(&p))
}

fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Open a new window, optionally bound to a folder. Must be async: creating windows from a
/// sync command deadlocks on Windows.
#[tauri::command]
async fn open_window(app: tauri::AppHandle, kernel: State<'_, Kernel>, folder: Option<String>) -> R<()> {
    let n = kernel.next_window.fetch_add(1, Ordering::Relaxed) + 1;
    let url = format!("index.html?folder={}", encode_query(folder.as_deref().unwrap_or("")));
    // Same as the main window: start frameless and hidden; the UI kernel decides on
    // decorations once it knows whether a plugin draws the title bar, then shows the window.
    let mut builder = WebviewWindowBuilder::new(&app, format!("w{n}"), WebviewUrl::App(url.into()))
        .title("Lite")
        .inner_size(1100.0, 720.0)
        .decorations(false)
        .visible(false);
    // All webviews share one WebView2 environment, so they must use identical browser args.
    if let Some(args) = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    configure_webview(&builder.build().map_err(err)?);
    Ok(())
}

// ---------- keyboard ----------

/// Which of these combos ("ctrl+shift+x") are registered as global hotkeys by another program?
/// Such keys never reach our window. Returns combo -> taken; combos we can't check are omitted.
/// Only detects RegisterHotKey users, not apps using low-level keyboard hooks.
#[tauri::command]
fn hotkeys_taken(combos: Vec<String>) -> HashMap<String, bool> {
    combos
        .into_iter()
        .filter_map(|c| hotkey::is_taken(&c).map(|taken| (c, taken)))
        .collect()
}

#[cfg(windows)]
mod hotkey {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };

    fn vk(key: &str) -> Option<u32> {
        let named = match key {
            "escape" => 0x1B, "enter" => 0x0D, "tab" => 0x09, " " | "space" => 0x20, "backspace" => 0x08,
            "delete" => 0x2E, "insert" => 0x2D, "home" => 0x24, "end" => 0x23, "pageup" => 0x21, "pagedown" => 0x22,
            "arrowleft" => 0x25, "arrowup" => 0x26, "arrowright" => 0x27, "arrowdown" => 0x28,
            "," => 0xBC, "." => 0xBE, "/" => 0xBF, "-" => 0xBD, "=" => 0xBB, ";" => 0xBA, "'" => 0xDE,
            "[" => 0xDB, "]" => 0xDD, "\\" => 0xDC, "`" => 0xC0,
            _ => 0,
        };
        if named != 0 {
            return Some(named);
        }
        let b = key.as_bytes();
        match (b.len(), b.first()) {
            (1, Some(c @ b'a'..=b'z')) => Some((c - b'a' + b'A') as u32),
            (1, Some(c @ b'0'..=b'9')) => Some(*c as u32),
            _ => key.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)).map(|n| 0x6F + n),
        }
    }

    pub fn is_taken(combo: &str) -> Option<bool> {
        let (mut mods, mut key) = (MOD_NOREPEAT, None);
        for part in combo.split('+') {
            match part {
                "ctrl" => mods |= MOD_CONTROL,
                "alt" => mods |= MOD_ALT,
                "shift" => mods |= MOD_SHIFT,
                "meta" => mods |= MOD_WIN,
                k => key = vk(k),
            }
        }
        let key = key?;
        const PROBE_ID: i32 = 0x4C49; // arbitrary, released immediately
        // SAFETY: plain Win32 calls with a null window (thread-associated hotkey), no pointers passed.
        unsafe {
            if RegisterHotKey(std::ptr::null_mut(), PROBE_ID, mods, key) != 0 {
                UnregisterHotKey(std::ptr::null_mut(), PROBE_ID);
                Some(false)
            } else {
                Some(true)
            }
        }
    }
}

#[cfg(not(windows))]
mod hotkey {
    pub fn is_taken(_combo: &str) -> Option<bool> {
        None
    }
}

// ---------- git ----------

#[derive(Serialize)]
struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Run `git` (from PATH) in the window's workspace folder, off the main thread. No console window,
/// no interactive prompts (they would hang invisibly; credential helpers with their own UI still work),
/// and no optional locks so background status refreshes don't fight with the user's own git commands.
#[tauri::command]
async fn git_run(window: Window, kernel: State<'_, Kernel>, args: Vec<String>, stdin: Option<String>) -> R<GitOutput> {
    let cwd = kernel
        .workspaces
        .lock()
        .unwrap()
        .get(window.label())
        .map(|p| PathBuf::from(display(p)))
        .ok_or("no workspace is open in this window")?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new("git");
        cmd.args(&args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("git: {e}"))?;
        if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(text.as_bytes()).map_err(err)?;
        } // pipe dropped here: EOF for git
        let out = child.wait_with_output().map_err(err)?;
        Ok(GitOutput {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(err)?
}

/// Open a web page in the default browser. Only http(s): nothing local, no other schemes.
#[tauri::command]
fn open_external(url: String) -> R<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.chars().any(char::is_control) {
        return Err("only http(s) URLs can be opened".into());
    }
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(err)
}

// ---------- terminals (see pty.rs) ----------

/// The shell starts in the window's workspace folder (home without one) — the UI can't pick a directory.
#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    window: Window,
    kernel: State<Kernel>,
    host: State<pty::PtyHost>,
    cols: u16,
    rows: u16,
    on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    on_exit: tauri::ipc::Channel<i32>,
) -> R<pty::Spawned> {
    // Plain form, not the canonical `\\?\C:\…` one: shells show the cwd verbatim (PowerShell would
    // print "Microsoft.PowerShell.Core\FileSystem::\\?\C:\…" as its prompt).
    let cwd = kernel.workspaces.lock().unwrap().get(window.label()).map(|p| PathBuf::from(display(p))).unwrap_or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| ".".into())
    });
    host.spawn(app, window.label(), cwd, cols.max(1), rows.max(1), on_data, on_exit)
}

#[tauri::command]
fn pty_write(window: Window, host: State<pty::PtyHost>, id: u32, data: String) -> R<()> {
    host.write(window.label(), id, &data)
}

#[tauri::command]
fn pty_resize(window: Window, host: State<pty::PtyHost>, id: u32, cols: u16, rows: u16) -> R<()> {
    host.resize(window.label(), id, cols.max(1), rows.max(1))
}

#[tauri::command]
fn pty_kill(window: Window, host: State<pty::PtyHost>, id: u32) -> R<()> {
    host.kill(window.label(), id)
}

#[tauri::command]
fn pty_default_shell() -> String {
    pty::default_shell()
}

// ---------- memory ----------

/// While a window is minimized, ask WebView2 to trim caches and hand freed memory back to the OS
/// (Chromium otherwise keeps freed pages for reuse); restore normal behaviour when it comes back.
#[cfg(windows)]
fn set_low_memory(window: &Window, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let Some(webview) = window.app_handle().get_webview_window(window.label()) else { return };
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    let _ = webview.with_webview(move |pw| {
        // SAFETY: COM calls on the webview's own thread (with_webview runs there); errors are ignored
        // because this is only an optimization (older WebView2 runtimes lack ICoreWebView2_19).
        unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn set_low_memory(_window: &Window, _low: bool) {}

/// Per-webview settings, applied to every window:
/// - no built-in browser context menu (Back/Reload/Inspect) anywhere — the UI provides its own menus,
///   and this holds even before the page's scripts run;
/// - clipboard reads allowed without a prompt (our own "Paste" menu items use navigator.clipboard).
#[cfg(windows)]
fn configure_webview(webview: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;
    let _ = webview.with_webview(|pw| {
        // SAFETY: COM calls on the webview's own thread (with_webview runs there).
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetAreDefaultContextMenusEnabled(false.into());
                #[cfg(debug_assertions)]
                {
                    let mut enabled = Default::default();
                    let _ = settings.AreDefaultContextMenusEnabled(&mut enabled);
                    eprintln!("[lite] webview default context menus enabled: {}", enabled.as_bool());
                }
            }
            let handler = PermissionRequestedEventHandler::create(Box::new(
                |_, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                    Ok(())
                },
            ));
            let mut token = Default::default();
            let _ = core.add_PermissionRequested(&handler, &mut token);
        }
    });
}

#[cfg(not(windows))]
fn configure_webview(_webview: &tauri::WebviewWindow) {}

// ---------- fs primitives (scoped to the window's workspace) ----------

fn scoped(kernel: &Kernel, window: &Window, path: &str) -> R<PathBuf> {
    let root = kernel
        .workspaces
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("no workspace is open in this window")?;
    let p = Path::new(path);
    let canon = if p.exists() {
        p.canonicalize()
    } else {
        // Allow creating a new file inside an existing directory.
        let parent = p.parent().ok_or("invalid path")?;
        let name = p.file_name().ok_or("invalid path")?;
        parent.canonicalize().map(|d| d.join(name))
    }
    .map_err(err)?;
    if !canon.starts_with(&root) {
        return Err(format!("{path} is outside the workspace"));
    }
    Ok(canon)
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn fs_read_dir(window: Window, kernel: State<Kernel>, path: String) -> R<Vec<DirEntry>> {
    let dir = scoped(&kernel, &window, &path)?;
    let mut items: Vec<DirEntry> = fs::read_dir(dir)
        .map_err(err)?
        .flatten()
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: display(&e.path()),
            is_dir: e.path().is_dir(),
        })
        .collect();
    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(items)
}

/// Raw bytes (the UI decodes them as UTF-8). Async so big files are read off the main thread, and a
/// binary response so nothing is JSON-escaped and re-parsed (for 80 MB that alone cost ~0.7 s).
#[tauri::command]
async fn fs_read_text(window: Window, kernel: State<'_, Kernel>, path: String) -> R<tauri::ipc::Response> {
    let bytes = fs::read(scoped(&kernel, &window, &path)?).map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn fs_write_text(window: Window, kernel: State<Kernel>, path: String, text: String) -> R<()> {
    fs::write(scoped(&kernel, &window, &path)?, text).map_err(err)
}

/// Like `scoped`, but refuses the workspace root itself (it can't be renamed, moved or deleted).
fn scoped_entry(kernel: &Kernel, window: &Window, path: &str) -> R<PathBuf> {
    let p = scoped(kernel, window, path)?;
    let root = kernel.workspaces.lock().unwrap().get(window.label()).cloned();
    if root.as_deref() == Some(p.as_path()) {
        return Err("the workspace folder itself can't be changed".into());
    }
    Ok(p)
}

/// New empty file; fails if anything already exists there (never overwrites).
#[tauri::command]
fn fs_create_file(window: Window, kernel: State<Kernel>, path: String) -> R<()> {
    let p = scoped(&kernel, &window, &path)?;
    fs::OpenOptions::new().write(true).create_new(true).open(p).map(|_| ()).map_err(err)
}

#[tauri::command]
fn fs_create_dir(window: Window, kernel: State<Kernel>, path: String) -> R<()> {
    fs::create_dir(scoped(&kernel, &window, &path)?).map_err(err)
}

/// Rename/move within the workspace; fails if the destination exists.
#[tauri::command]
fn fs_rename(window: Window, kernel: State<Kernel>, from: String, to: String) -> R<()> {
    let src = scoped_entry(&kernel, &window, &from)?;
    let dst = scoped_entry(&kernel, &window, &to)?;
    // Case-only renames (a.txt -> A.txt) point at the same file on case-insensitive file systems.
    if dst.exists() && !src.as_os_str().eq_ignore_ascii_case(dst.as_os_str()) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(src, dst).map_err(err)
}

/// Delete by moving to the system recycle bin / trash, so it can be restored.
#[tauri::command]
fn fs_trash(window: Window, kernel: State<Kernel>, path: String) -> R<()> {
    trash::delete(scoped_entry(&kernel, &window, &path)?).map_err(err)
}

/// Show the item in the OS file manager (Explorer / Finder / the folder on Linux).
#[tauri::command]
fn fs_reveal(window: Window, kernel: State<Kernel>, path: String) -> R<()> {
    let p = scoped(&kernel, &window, &path)?;
    let shown = display(&p);
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(format!("/select,{shown}")).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&shown).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    result.map(|_| ()).map_err(err)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("lite-plugin", |_ctx, request| serve_plugin_file(&request))
        .setup(|app| {
            for webview in app.webview_windows().values() {
                configure_webview(webview);
            }
            Ok(())
        })
        .manage(Kernel::default())
        .manage(pty::PtyHost::default())
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => {
                window.state::<Kernel>().workspaces.lock().unwrap().remove(window.label());
                window.state::<pty::PtyHost>().kill_owned_by(window.label());
            }
            // Minimizing/restoring arrives as a resize.
            WindowEvent::Resized(_) => set_low_memory(window, window.is_minimized().unwrap_or(false)),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_plugins,
            read_plugin_file,
            read_state,
            write_state,
            init_workspace,
            pick_folder,
            open_window,
            hotkeys_taken,
            fs_read_dir,
            fs_read_text,
            fs_write_text,
            fs_create_file,
            fs_create_dir,
            fs_rename,
            fs_trash,
            fs_reveal,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_default_shell,
            git_run,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Lite");
}
