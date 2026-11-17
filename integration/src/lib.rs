//! How Lite hooks into the desktop: shortcuts, "Open with Lite" context menus, PATH and the
//! "Open with" registration. One implementation for the installer (which sets them up and removes
//! them) and the app (whose settings show and change them afterwards).
//!
//! Everything is per user (HKCU, the user's own folders): no administrator rights needed.
//! Only Windows is implemented; elsewhere `supported()` is false and nothing is read or written.
use std::path::Path;

pub const APP_EXE: &str = if cfg!(windows) { "lite.exe" } else { "lite" };

/// The optional hooks — the installer's checkboxes, the app's switches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Integration {
    pub desktop: bool,
    pub start_menu: bool,
    /// "Open with Lite" on files, folders and the background of a folder in the file manager.
    pub context_menu: bool,
    pub add_to_path: bool,
}

pub fn supported() -> bool {
    cfg!(windows)
}

/// What is set up now for the copy of Lite in `dir`.
pub fn current(dir: &Path) -> Integration {
    platform::current(dir)
}

/// Make it so, for the copy of Lite in `dir`: creates what is wanted, removes what is not.
pub fn apply(dir: &Path, wanted: Integration) -> Result<(), String> {
    platform::apply(dir, wanted)
}

/// Offer Lite in the file manager's "Open with" (never as the default program for anything).
pub fn register_open_with(dir: &Path) -> Result<(), String> {
    platform::register_open_with(dir)
}

/// Undo everything above (uninstalling).
pub fn remove(dir: &Path) -> Result<(), String> {
    platform::remove(dir)
}

/// Is the system's display language Chinese? (The installer and the shell's menu entries follow it.)
pub fn is_chinese() -> bool {
    platform::is_chinese()
}

// ---------- Windows ----------

#[cfg(windows)]
mod platform {
    use super::{Integration, APP_EXE};
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use windows_sys::{
        core::GUID,
        Win32::{
            Globalization::GetUserDefaultUILanguage,
            System::Com::CoTaskMemFree,
            UI::{
                Shell::{FOLDERID_Desktop, FOLDERID_Programs, SHChangeNotify, SHGetKnownFolderPath, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
                WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE},
            },
        },
    };
    use winreg::{
        enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
        RegKey, RegValue,
    };

    const CONTEXT_KEYS: [(&str, &str); 3] = [
        (r"Software\Classes\*\shell\Lite", "%1"),                    // right-click a file (any type)
        (r"Software\Classes\Directory\shell\Lite", "%1"),            // right-click a folder
        (r"Software\Classes\Directory\Background\shell\Lite", "%V"), // right-click inside a folder
    ];
    // "Open with": registering the executable makes Lite a choice for every file type ("Choose another
    // app"), and the ProgID listed under an extension's OpenWithProgids puts it straight into that
    // type's "Open with" menu. Nothing here makes Lite the default for anything.
    const APP_KEY: &str = r"Software\Classes\Applications\lite.exe";
    const PROG_ID: &str = "Lite.File";
    const PROG_KEY: &str = r"Software\Classes\Lite.File";
    /// File types that get Lite in their "Open with" menu.
    const OPEN_WITH: &[&str] = &[
        "txt", "log", "md", "markdown", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
        "xml", "svg", "csv", "tsv", "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts",
        "mts", "cts", "tsx", "vue", "svelte", "py", "pyw", "rs", "go", "java", "kt", "kts", "c", "h", "cpp", "cc",
        "cxx", "hpp", "cs", "php", "rb", "lua", "swift", "dart", "sql", "sh", "bash", "zsh", "ps1", "psm1", "bat",
        "cmd", "gradle", "properties", "lock", "gitignore", "gitattributes", "editorconfig", "diff", "patch",
    ];

    fn err<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }

    pub fn is_chinese() -> bool {
        // Primary language id (low 10 bits): 0x04 = Chinese.
        unsafe { GetUserDefaultUILanguage() & 0x3ff == 0x04 }
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

    fn set_shortcut(link: Option<PathBuf>, wanted: bool, dir: &Path) -> Result<(), String> {
        let Some(link) = link else { return Ok(()) };
        if !wanted {
            let _ = fs::remove_file(link);
            return Ok(());
        }
        let mut shortcut = mslnk::ShellLink::new(dir.join(APP_EXE)).map_err(err)?;
        shortcut.set_working_dir(Some(dir.to_string_lossy().into_owned()));
        shortcut.create_lnk(link).map_err(err)
    }

    fn exe_string(dir: &Path) -> String {
        dir.join(APP_EXE).to_string_lossy().into_owned()
    }

    pub fn current(dir: &Path) -> Integration {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let [desktop, programs] = shortcut_paths();
        // A menu entry counts only if it starts this copy (another copy's entry is not ours to show as on).
        // Any of them is enough: older versions only added the folder entries, and switching it on
        // (or updating) completes the set.
        let exe = exe_string(dir).to_lowercase();
        let starts_this_copy = |path: &str| {
            hkcu.open_subkey(format!(r"{path}\command"))
                .and_then(|key| key.get_value::<String, _>(""))
                .is_ok_and(|command| command.to_lowercase().contains(&exe))
        };
        Integration {
            desktop: desktop.is_some_and(|link| link.is_file()),
            start_menu: programs.is_some_and(|link| link.is_file()),
            context_menu: CONTEXT_KEYS.iter().any(|(path, _)| starts_this_copy(path)),
            add_to_path: read_path().is_some_and(|(path, _)| path.split(';').any(|entry| same_dir(entry, dir))),
        }
    }

    pub fn apply(dir: &Path, wanted: Integration) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = exe_string(dir);

        let [desktop, programs] = shortcut_paths();
        set_shortcut(desktop, wanted.desktop, dir)?;
        set_shortcut(programs, wanted.start_menu, dir)?;

        for (path, arg) in CONTEXT_KEYS {
            if !wanted.context_menu {
                let _ = hkcu.delete_subkey_all(path);
                continue;
            }
            let (key, _) = hkcu.create_subkey(path).map_err(err)?;
            key.set_value("", &if is_chinese() { "用 Lite 打开" } else { "Open with Lite" }).map_err(err)?;
            key.set_value("Icon", &exe).map_err(err)?;
            let (command, _) = key.create_subkey("command").map_err(err)?;
            command.set_value("", &format!("\"{exe}\" \"{arg}\"")).map_err(err)?;
        }

        set_on_path(dir, wanted.add_to_path)
    }

    pub fn register_open_with(dir: &Path) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = exe_string(dir);
        let open_command = format!("\"{exe}\" \"%1\"");
        let register = || -> std::io::Result<()> {
            let (app, _) = hkcu.create_subkey(APP_KEY)?;
            app.set_value("FriendlyAppName", &"Lite")?;
            app.create_subkey("DefaultIcon")?.0.set_value("", &exe)?;
            app.create_subkey(r"shell\open\command")?.0.set_value("", &open_command)?;
            let (prog, _) = hkcu.create_subkey(PROG_KEY)?;
            prog.set_value("", &"Lite")?;
            prog.create_subkey("DefaultIcon")?.0.set_value("", &exe)?;
            prog.create_subkey(r"shell\open\command")?.0.set_value("", &open_command)?;
            for ext in OPEN_WITH {
                let (key, _) = hkcu.create_subkey(format!(r"Software\Classes\.{ext}\OpenWithProgids"))?;
                key.set_value(PROG_ID, &"")?;
            }
            Ok(())
        };
        register().map_err(err)?;
        associations_changed();
        Ok(())
    }

    pub fn remove(dir: &Path) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for link in shortcut_paths().into_iter().flatten() {
            let _ = fs::remove_file(link);
        }
        for (path, _) in CONTEXT_KEYS {
            let _ = hkcu.delete_subkey_all(path);
        }
        let _ = hkcu.delete_subkey_all(APP_KEY);
        let _ = hkcu.delete_subkey_all(PROG_KEY);
        for ext in OPEN_WITH {
            // Only our value: the key may hold other programs' entries.
            if let Ok(key) = hkcu.open_subkey_with_flags(format!(r"Software\Classes\.{ext}\OpenWithProgids"), KEY_WRITE) {
                let _ = key.delete_value(PROG_ID);
            }
        }
        associations_changed();
        set_on_path(dir, false)
    }

    /// Tell Explorer that file associations changed, so the menus are right without signing out.
    fn associations_changed() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) }
    }

    fn same_dir(entry: &str, dir: &Path) -> bool {
        let dir = dir.to_string_lossy();
        entry.trim().trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'))
    }

    /// The user's PATH and its registry type, if there is one.
    fn read_path() -> Option<(String, RegType)> {
        let env = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment").ok()?;
        let value = env.get_raw_value("Path").ok()?;
        let wide: Vec<u16> = value.bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        Some((String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string(), value.vtype))
    }

    /// Add or remove `dir` in the user's PATH. The value keeps its registry type (usually
    /// REG_EXPAND_SZ, so entries like %USERPROFILE%\bin keep working).
    fn set_on_path(dir: &Path, wanted: bool) -> Result<(), String> {
        let (old, vtype) = read_path().unwrap_or((String::new(), RegType::REG_EXPAND_SZ));
        let dir_str = dir.to_string_lossy();
        let mut entries: Vec<&str> = old.split(';').filter(|e| !e.trim().is_empty() && !same_dir(e, dir)).collect();
        if wanted {
            entries.push(&dir_str);
        }
        let new = entries.join(";");
        if new == old {
            return Ok(());
        }
        let (env, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags("Environment", KEY_READ | KEY_WRITE).map_err(err)?;
        let bytes = new.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
        env.set_raw_value("Path", &RegValue { bytes, vtype }).map_err(err)?;
        // Tell running programs (Explorer, so new terminals) that the environment changed.
        let name: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, name.as_ptr() as isize, SMTO_ABORTIFHUNG, 2000, std::ptr::null_mut());
        }
        Ok(())
    }
}

// ---------- other systems: not implemented yet ----------

#[cfg(not(windows))]
mod platform {
    use super::Integration;
    use std::path::Path;

    pub fn is_chinese() -> bool {
        std::env::var("LANG").is_ok_and(|l| l.starts_with("zh"))
    }

    pub fn current(_dir: &Path) -> Integration {
        Integration::default()
    }

    pub fn apply(_dir: &Path, _wanted: Integration) -> Result<(), String> {
        Err("not supported on this system".into())
    }

    pub fn register_open_with(_dir: &Path) -> Result<(), String> {
        Err("not supported on this system".into())
    }

    pub fn remove(_dir: &Path) -> Result<(), String> {
        Err("not supported on this system".into())
    }
}
