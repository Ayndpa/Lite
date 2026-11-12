//! Install / uninstall logic, independent of the UI (the silent mode uses it directly).
//!
//! Files are tracked in a manifest inside the install folder: an upgrade removes files the new
//! version no longer ships, and uninstalling deletes exactly what was installed — never the whole
//! folder, so a badly chosen location (say `D:\`) or plugins the user added there are safe.
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

pub use platform::{default_dir, installed_dir, is_chinese, launch};

pub const VERSION: &str = env!("LITE_VERSION");
const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));
const MANIFEST: &str = "install-manifest.txt";
pub const APP_EXE: &str = if cfg!(windows) { "lite.exe" } else { "lite" };
pub const UNINSTALLER: &str = if cfg!(windows) { "uninstall.exe" } else { "uninstall" };

#[derive(Clone, Debug)]
pub struct Options {
    pub dir: PathBuf,
    pub desktop: bool,
    pub start_menu: bool,
    /// "Open with Lite" on folders in the file manager.
    pub context_menu: bool,
    pub add_to_path: bool,
}

/// What is happening, for the progress text (the UI words it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Preparing,
    Copying,
    Integrating,
    Runtime,
    Removing,
}

#[derive(Debug)]
pub enum Error {
    /// Lite is running from the install folder: its files can't be replaced or removed.
    Running,
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    Other(String),
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Other(e.to_string())
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Other(e.to_string())
    }
}

pub struct Installed {
    /// False when the web runtime Lite needs (WebView2 on Windows) is missing and could not be installed.
    pub runtime_ok: bool,
}

type Progress<'a> = &'a dyn Fn(f32, Step);

pub fn install(o: &Options, progress: Progress) -> Result<Installed, Error> {
    // One separator style (C:/a\b -> C:\a\b): the path ends up in shortcuts and the registry.
    let o = &Options { dir: o.dir.components().collect(), ..o.clone() };
    progress(0.0, Step::Preparing);
    fs::create_dir_all(&o.dir)?;
    ensure_not_running(&o.dir)?;
    let previous = read_manifest(&o.dir);

    let mut archive = zip::ZipArchive::new(io::Cursor::new(PAYLOAD))?;
    let total = archive.len();
    let mut installed = BTreeSet::new();
    let mut bytes = 0u64;
    for i in 0..total {
        let mut file = archive.by_index(i)?;
        let Some(rel) = file.enclosed_name() else { continue }; // never write outside the folder
        let dest = o.dir.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        bytes += io::copy(&mut file, &mut fs::File::create(&dest)?)?;
        installed.insert(rel.to_string_lossy().replace('\\', "/"));
        progress(0.05 + 0.8 * (i + 1) as f32 / total as f32, Step::Copying);
    }

    // The uninstaller is this executable.
    let uninstaller = o.dir.join(UNINSTALLER);
    let me = std::env::current_exe()?;
    if !same_file(&me, &uninstaller) {
        fs::copy(&me, &uninstaller)?;
    }
    installed.insert(UNINSTALLER.to_string());

    // Files of the previous version that this one no longer ships.
    let stale: Vec<&String> = previous.difference(&installed).collect();
    remove_files(&o.dir, stale.into_iter());
    fs::write(o.dir.join(MANIFEST), installed.iter().map(|f| format!("{f}\n")).collect::<String>())?;

    progress(0.88, Step::Integrating);
    platform::integrate(o, bytes)?;
    progress(0.94, Step::Runtime);
    let runtime_ok = platform::ensure_runtime();
    progress(1.0, Step::Runtime);
    Ok(Installed { runtime_ok })
}

/// delete_settings: also remove the user's settings (state.json: recent folders, theme, keybindings…).
pub fn uninstall(dir: &Path, delete_settings: bool, progress: Progress) -> Result<(), Error> {
    progress(0.0, Step::Preparing);
    ensure_not_running(dir)?;
    progress(0.1, Step::Removing);
    platform::remove_integration(dir)?;
    progress(0.3, Step::Removing);
    let files = read_manifest(dir);
    remove_files(dir, files.iter());
    let _ = fs::remove_file(dir.join(MANIFEST));
    let _ = fs::remove_dir(dir); // only if nothing else is left in it
    if delete_settings {
        if let Some(settings) = platform::settings_dir() {
            let _ = fs::remove_dir_all(settings);
        }
    }
    progress(1.0, Step::Removing);
    Ok(())
}

/// A running executable can't be opened for writing.
fn ensure_not_running(dir: &Path) -> Result<(), Error> {
    let exe = dir.join(APP_EXE);
    if exe.is_file() && fs::OpenOptions::new().write(true).open(&exe).is_err() {
        return Err(Error::Running);
    }
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn read_manifest(dir: &Path) -> BTreeSet<String> {
    fs::read_to_string(dir.join(MANIFEST))
        .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("..")).map(String::from).collect())
        .unwrap_or_default()
}

/// Delete manifest entries, then the folders they leave empty (deepest first; non-empty ones stay).
fn remove_files<'a>(dir: &Path, files: impl Iterator<Item = &'a String>) {
    let mut folders = BTreeSet::new();
    for rel in files {
        let path = dir.join(rel);
        let _ = fs::remove_file(&path);
        let mut parent = Path::new(rel).parent();
        while let Some(p) = parent.filter(|p| !p.as_os_str().is_empty()) {
            folders.insert(p.to_path_buf());
            parent = p.parent();
        }
    }
    let mut folders: Vec<PathBuf> = folders.into_iter().collect();
    folders.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for folder in folders {
        let _ = fs::remove_dir(dir.join(folder));
    }
}

// ---------- Windows ----------

#[cfg(windows)]
mod platform {
    use super::{Error, Options, APP_EXE, UNINSTALLER, VERSION};
    use std::{
        fs,
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::Command,
    };
    use windows_sys::{
        core::GUID,
        Win32::{
            Globalization::GetUserDefaultUILanguage,
            System::Com::CoTaskMemFree,
            UI::{
                Shell::{FOLDERID_Desktop, FOLDERID_Programs, SHGetKnownFolderPath},
                WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE},
            },
        },
    };
    use winreg::{
        enums::{RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE},
        RegKey, RegValue,
    };

    // Everything is per user (HKCU, %LOCALAPPDATA%): no administrator rights needed.
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Lite";
    const CONTEXT_KEYS: [(&str, &str); 2] = [
        (r"Software\Classes\Directory\shell\Lite", "%1"),            // right-click a folder
        (r"Software\Classes\Directory\Background\shell\Lite", "%V"), // right-click inside a folder
    ];
    const WEBVIEW2_CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const WEBVIEW2_BOOTSTRAPPER: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn other<E: std::fmt::Display>(e: E) -> Error {
        Error::Other(e.to_string())
    }

    fn env_dir(name: &str) -> Option<PathBuf> {
        std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
    }

    pub fn is_chinese() -> bool {
        // Primary language id (low 10 bits): 0x04 = Chinese.
        unsafe { GetUserDefaultUILanguage() & 0x3ff == 0x04 }
    }

    pub fn default_dir() -> PathBuf {
        env_dir("LOCALAPPDATA").unwrap_or_else(|| PathBuf::from(r"C:\")).join("Programs").join("Lite")
    }

    pub fn settings_dir() -> Option<PathBuf> {
        env_dir("APPDATA").map(|d| d.join("Lite"))
    }

    /// Where Lite is installed now, if it is.
    pub fn installed_dir() -> Option<PathBuf> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(UNINSTALL_KEY).ok()?;
        let dir: String = key.get_value("InstallLocation").ok()?;
        Some(PathBuf::from(dir)).filter(|d| d.join(APP_EXE).is_file())
    }

    pub fn launch(dir: &Path) {
        let _ = Command::new(dir.join(APP_EXE)).current_dir(dir).spawn();
    }

    fn known_folder(id: &GUID) -> Option<PathBuf> {
        unsafe {
            let mut raw = std::ptr::null_mut();
            if SHGetKnownFolderPath(id, 0 as _, std::ptr::null_mut(), &mut raw) != 0 {
                return None;
            }
            let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
            let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
            CoTaskMemFree(raw as _);
            Some(path.into())
        }
    }

    fn shortcut_paths() -> [Option<PathBuf>; 2] {
        [known_folder(&FOLDERID_Desktop), known_folder(&FOLDERID_Programs)].map(|d| d.map(|d| d.join("Lite.lnk")))
    }

    fn set_shortcut(link: Option<PathBuf>, wanted: bool, dir: &Path) -> Result<(), Error> {
        let Some(link) = link else { return Ok(()) };
        if !wanted {
            let _ = fs::remove_file(link);
            return Ok(());
        }
        let mut shortcut = mslnk::ShellLink::new(dir.join(APP_EXE)).map_err(other)?;
        shortcut.set_working_dir(Some(dir.to_string_lossy().into_owned()));
        shortcut.create_lnk(link).map_err(other)
    }

    pub fn integrate(o: &Options, installed_bytes: u64) -> Result<(), Error> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = o.dir.join(APP_EXE);
        let exe_str = exe.to_string_lossy().into_owned();
        let uninstaller = o.dir.join(UNINSTALLER).to_string_lossy().into_owned();

        let [desktop, programs] = shortcut_paths();
        set_shortcut(desktop, o.desktop, &o.dir)?;
        set_shortcut(programs, o.start_menu, &o.dir)?;

        // Settings > Apps (and the old "Programs and Features").
        let (key, _) = hkcu.create_subkey(UNINSTALL_KEY)?;
        key.set_value("DisplayName", &"Lite")?;
        key.set_value("DisplayVersion", &VERSION)?;
        key.set_value("Publisher", &"Lite")?;
        key.set_value("DisplayIcon", &exe_str)?;
        key.set_value("InstallLocation", &o.dir.to_string_lossy().into_owned())?;
        key.set_value("UninstallString", &format!("\"{uninstaller}\" --uninstall"))?;
        key.set_value("QuietUninstallString", &format!("\"{uninstaller}\" --uninstall /S"))?;
        key.set_value("EstimatedSize", &((installed_bytes / 1024) as u32))?;
        key.set_value("NoModify", &1u32)?;
        key.set_value("NoRepair", &1u32)?;

        for (path, arg) in CONTEXT_KEYS {
            if !o.context_menu {
                let _ = hkcu.delete_subkey_all(path);
                continue;
            }
            let (key, _) = hkcu.create_subkey(path)?;
            key.set_value("", &if is_chinese() { "用 Lite 打开" } else { "Open with Lite" })?;
            key.set_value("Icon", &exe_str)?;
            let (command, _) = key.create_subkey("command")?;
            command.set_value("", &format!("\"{exe_str}\" \"{arg}\""))?;
        }

        set_on_path(&o.dir, o.add_to_path)?;
        Ok(())
    }

    pub fn remove_integration(dir: &Path) -> Result<(), Error> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for link in shortcut_paths().into_iter().flatten() {
            let _ = fs::remove_file(link);
        }
        for (path, _) in CONTEXT_KEYS {
            let _ = hkcu.delete_subkey_all(path);
        }
        set_on_path(dir, false)?;
        let _ = hkcu.delete_subkey_all(UNINSTALL_KEY);
        Ok(())
    }

    /// Add or remove `dir` in the user's PATH. The value keeps its registry type (usually
    /// REG_EXPAND_SZ, so entries like %USERPROFILE%\bin keep working).
    fn set_on_path(dir: &Path, wanted: bool) -> Result<(), Error> {
        let (env, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;
        let (old, vtype) = match env.get_raw_value("Path") {
            Ok(v) => {
                let wide: Vec<u16> = v.bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                (String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string(), v.vtype)
            }
            Err(_) => (String::new(), RegType::REG_EXPAND_SZ),
        };
        let dir = dir.to_string_lossy();
        let is_dir = |entry: &str| entry.trim().trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'));
        let mut entries: Vec<&str> = old.split(';').filter(|e| !e.trim().is_empty() && !is_dir(e)).collect();
        if wanted {
            entries.push(&dir);
        }
        let new = entries.join(";");
        if new == old {
            return Ok(());
        }
        let bytes = new.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
        env.set_raw_value("Path", &RegValue { bytes, vtype })?;
        // Tell running programs (Explorer, so new terminals) that the environment changed.
        let name: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, name.as_ptr() as isize, SMTO_ABORTIFHUNG, 2000, std::ptr::null_mut());
        }
        Ok(())
    }

    fn webview2_installed() -> bool {
        let version = |root: RegKey, path: String| root.open_subkey(path).and_then(|k| k.get_value::<String, _>("pv")).ok();
        [
            version(RegKey::predef(HKEY_LOCAL_MACHINE), format!(r"SOFTWARE\WOW6432Node\{WEBVIEW2_CLIENT}")),
            version(RegKey::predef(HKEY_LOCAL_MACHINE), format!(r"SOFTWARE\{WEBVIEW2_CLIENT}")),
            version(RegKey::predef(HKEY_CURRENT_USER), format!(r"Software\{WEBVIEW2_CLIENT}")),
        ]
        .into_iter()
        .flatten()
        .any(|v| !v.is_empty() && v != "0.0.0.0")
    }

    /// Lite renders with WebView2. Windows 11 ships it; elsewhere fetch Microsoft's small bootstrapper
    /// (with the curl.exe that comes with Windows 10 1803+) and let it install the runtime for this user.
    pub fn ensure_runtime() -> bool {
        if webview2_installed() {
            return true;
        }
        let setup = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
        let downloaded = Command::new("curl.exe")
            .args(["-L", "--fail", "--silent", "--max-time", "120", "-o"])
            .arg(&setup)
            .arg(WEBVIEW2_BOOTSTRAPPER)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|s| s.success());
        if downloaded {
            let _ = Command::new(&setup).args(["/silent", "/install"]).status();
            let _ = fs::remove_file(&setup);
        }
        webview2_installed()
    }
}

// ---------- other systems: not implemented yet ----------

#[cfg(not(windows))]
mod platform {
    use super::{Error, Options};
    use std::path::{Path, PathBuf};

    pub fn is_chinese() -> bool {
        std::env::var("LANG").is_ok_and(|l| l.starts_with("zh"))
    }

    pub fn default_dir() -> PathBuf {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local").join("opt").join("lite")
    }

    pub fn settings_dir() -> Option<PathBuf> {
        None
    }

    pub fn installed_dir() -> Option<PathBuf> {
        None
    }

    pub fn launch(_dir: &Path) {}

    pub fn integrate(_o: &Options, _installed_bytes: u64) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    pub fn remove_integration(_dir: &Path) -> Result<(), Error> {
        Err(Error::Unsupported)
    }

    pub fn ensure_runtime() -> bool {
        true
    }
}
