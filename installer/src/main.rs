// Lite's installer: one executable with the app and its plugins embedded (see build.rs).
//
//   lite-setup.exe                      install wizard
//   lite-setup.exe /S [/D=<folder>]     silent install; --no-desktop, --no-start-menu,
//                                       --no-context-menu, --add-to-path change the defaults
//   uninstall.exe --uninstall [/S]      uninstall (the installer copies itself into the install folder
//                                       under that name); --delete-settings also removes the user's settings
#![cfg_attr(windows, windows_subsystem = "windows")]

mod install;

use install::{Error, Integration, Options, Step};
use std::path::PathBuf;

slint::include_modules!();

#[derive(Default)]
struct Args {
    uninstall: bool,
    silent: bool,
    dir: Option<PathBuf>,
    /// Internal: this is the temporary copy the uninstaller runs from (see relocate).
    relocated: bool,
    no_desktop: bool,
    no_start_menu: bool,
    no_context_menu: bool,
    add_to_path: bool,
    delete_settings: bool,
}

fn parse_args() -> Args {
    let mut args = Args::default();
    for arg in std::env::args().skip(1) {
        let lower = arg.to_ascii_lowercase();
        match lower.as_str() {
            "/s" | "--silent" => args.silent = true,
            "--uninstall" => args.uninstall = true,
            "--relocated" => args.relocated = true,
            "--no-desktop" => args.no_desktop = true,
            "--no-start-menu" => args.no_start_menu = true,
            "--no-context-menu" => args.no_context_menu = true,
            "--add-to-path" => args.add_to_path = true,
            "--delete-settings" => args.delete_settings = true,
            _ => {
                if lower.starts_with("/d=") {
                    args.dir = Some(arg[3..].trim_matches('"').into());
                } else if lower.starts_with("--dir=") {
                    args.dir = Some(arg[6..].trim_matches('"').into());
                }
            }
        }
    }
    args
}

fn main() {
    let mut args = parse_args();
    if args.uninstall {
        // The folder to remove: given, else the one this uninstaller sits in, else the registered one.
        args.dir = args.dir.take().or_else(own_install_dir).or_else(install::installed_dir);
        if !args.relocated {
            if let Some(code) = relocate(&args) {
                std::process::exit(code);
            }
        }
    }
    let code = if args.silent { run_silent(&args) } else { run_ui(&args) };
    if args.relocated {
        clean_up_later(args.dir.as_deref());
    }
    std::process::exit(code);
}

/// The folder this executable is in, if it is an installed copy's uninstaller.
fn own_install_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    dir.join(install::APP_EXE).is_file().then_some(dir)
}

/// A running executable can't delete itself or its folder, so the uninstaller continues from a copy
/// in the temp folder. Returns the exit code to end with, or None to carry on in this process.
fn relocate(args: &Args) -> Option<i32> {
    if !cfg!(windows) {
        return None;
    }
    let me = std::env::current_exe().ok()?;
    let dir = args.dir.as_ref()?;
    if !me.starts_with(dir) {
        return None;
    }
    let copy = std::env::temp_dir().join(format!("lite-uninstall-{}.exe", std::process::id()));
    std::fs::copy(&me, &copy).ok()?;
    let mut child = std::process::Command::new(&copy);
    child.args(std::env::args().skip(1)).arg("--relocated").arg(format!("--dir={}", dir.display()));
    let mut child = child.spawn().ok()?;
    // Silent: whoever started us waits for our exit code. With the window: just hand over.
    Some(if args.silent { child.wait().ok().and_then(|s| s.code()).unwrap_or(1) } else { 0 })
}

/// What the uninstaller can't delete while it runs goes a moment after it exits: this temporary copy,
/// the uninstall.exe that started it (it may still be waiting for us) and then the emptied folder.
#[cfg_attr(not(windows), allow(unused_variables))]
fn clean_up_later(dir: Option<&std::path::Path>) {
    #[cfg(windows)]
    if let Ok(me) = std::env::current_exe() {
        use std::os::windows::process::CommandExt;
        let mut script = format!("ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"", me.display());
        if let Some(dir) = dir.filter(|d| !d.join(install::APP_EXE).exists()) {
            // rmdir without /s: only if nothing else is left in the folder.
            script += &format!(" & del /f /q \"{}\" & rmdir \"{}\"", dir.join(install::UNINSTALLER).display(), dir.display());
        }
        let _ = std::process::Command::new("cmd")
            .raw_arg(format!("/s /c \"{script}\""))
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn();
    }
}

/// The checkboxes' starting values: for a new install the defaults, for an update whatever is set up
/// now (the user may have changed it in Lite's settings); command-line options override both.
fn integration(args: &Args) -> Integration {
    let mut wanted = match install::installed_dir() {
        Some(dir) => lite_integration::current(&dir),
        None => Integration { desktop: true, start_menu: true, context_menu: true, add_to_path: false },
    };
    wanted.desktop &= !args.no_desktop;
    wanted.start_menu &= !args.no_start_menu;
    wanted.context_menu &= !args.no_context_menu;
    wanted.add_to_path |= args.add_to_path;
    wanted
}

fn options(args: &Args) -> Options {
    Options {
        dir: args.dir.clone().or_else(install::installed_dir).unwrap_or_else(install::default_dir),
        integration: integration(args),
    }
}

/// Exit codes: 0 ok, 1 failed, 2 Lite is running, 3 installed but the web runtime is missing.
fn run_silent(args: &Args) -> i32 {
    let result = if args.uninstall {
        match &args.dir {
            Some(dir) => install::uninstall(dir, args.delete_settings, &|_, _| {}).map(|_| 0),
            None => Err(Error::Other("Lite is not installed".into())),
        }
    } else {
        install::install(&options(args), &|_, _| {}).map(|done| if done.runtime_ok { 0 } else { 3 })
    };
    match result {
        Ok(code) => code,
        Err(Error::Running) => 2,
        Err(_) => 1,
    }
}

/// Open a web page in the default browser.
fn open_url(url: &str) {
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = command.spawn();
}

fn step_text(step: Step, zh: bool) -> &'static str {
    match (step, zh) {
        (Step::Preparing, true) => "正在准备…",
        (Step::Preparing, false) => "Preparing…",
        (Step::Copying, true) => "正在复制文件…",
        (Step::Copying, false) => "Copying files…",
        (Step::Integrating, true) => "正在创建快捷方式和打开方式…",
        (Step::Integrating, false) => "Creating shortcuts and file associations…",
        (Step::Runtime, true) => "正在检查 WebView2 运行时…",
        (Step::Runtime, false) => "Checking the WebView2 runtime…",
        (Step::Removing, true) => "正在移除文件…",
        (Step::Removing, false) => "Removing files…",
    }
}

fn error_text(error: &Error, zh: bool) -> String {
    match (error, zh) {
        (Error::Running, true) => "Lite 正在运行。请先关闭它，然后重试。".into(),
        (Error::Running, false) => "Lite is running. Close it and try again.".into(),
        (Error::Unsupported, true) => "暂不支持在这个系统上安装。".into(),
        (Error::Unsupported, false) => "Installing on this system is not supported yet.".into(),
        (Error::Other(message), _) => message.clone(),
    }
}

/// The command-line options preselect the wizard's fields.
fn run_ui(args: &Args) -> i32 {
    let (uninstalling, dir) = (args.uninstall, args.dir.clone());
    let zh = install::is_chinese();
    let ui = App::new().expect("cannot create the window");
    ui.global::<T>().set_zh(zh);
    ui.set_version(install::VERSION.into());
    ui.set_uninstalling(uninstalling);
    ui.set_delete_settings(args.delete_settings);
    let preset = integration(args);
    ui.set_opt_desktop(preset.desktop);
    ui.set_opt_start_menu(preset.start_menu);
    ui.set_opt_context_menu(preset.context_menu);
    ui.set_opt_path(preset.add_to_path);
    let existing = install::installed_dir();
    ui.set_upgrade(existing.is_some());
    match dir.or(if uninstalling { None } else { existing.or_else(|| Some(install::default_dir())) }) {
        Some(dir) => ui.set_install_dir(dir.to_string_lossy().as_ref().into()),
        None => {
            // Uninstalling, but there is nothing to uninstall.
            ui.set_error(if zh { "没有找到已安装的 Lite。" } else { "Lite is not installed." }.into());
            ui.set_page(3);
        }
    }

    // The window has no native frame: move it ourselves while the title bar is dragged.
    let weak = ui.as_weak();
    ui.on_drag(move |dx, dy| {
        let ui = weak.unwrap();
        let window = ui.window();
        let (pos, scale) = (window.position(), window.scale_factor());
        window.set_position(slint::PhysicalPosition::new(pos.x + (dx * scale) as i32, pos.y + (dy * scale) as i32));
    });

    ui.on_open_url(|url| open_url(&url));

    let weak = ui.as_weak();
    ui.on_browse(move || {
        let ui = weak.unwrap();
        let current = PathBuf::from(ui.get_install_dir().as_str());
        let start = current.ancestors().find(|p| p.is_dir()).map(PathBuf::from);
        let mut dialog = rfd::FileDialog::new();
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        if let Some(mut picked) = dialog.pick_folder() {
            // Install into a folder of our own, not loose into whatever was picked.
            if !picked.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Lite")) {
                picked.push("Lite");
            }
            ui.set_install_dir(picked.to_string_lossy().as_ref().into());
        }
    });

    let weak = ui.as_weak();
    ui.on_begin(move || {
        let ui = weak.unwrap();
        if ui.get_page() != 0 {
            return;
        }
        let dir = PathBuf::from(ui.get_install_dir().trim());
        if !dir.is_absolute() {
            ui.set_error(if zh { "请输入完整的安装路径。" } else { "Enter a full path to install to." }.into());
            ui.set_page(3);
            return;
        }
        let options = Options {
            dir,
            integration: Integration {
                desktop: ui.get_opt_desktop(),
                start_menu: ui.get_opt_start_menu(),
                context_menu: ui.get_opt_context_menu(),
                add_to_path: ui.get_opt_path(),
            },
        };
        let delete_settings = ui.get_delete_settings();
        ui.set_progress(0.0);
        ui.set_status(step_text(Step::Preparing, zh).into());
        ui.set_page(1);

        let weak = weak.clone();
        std::thread::spawn(move || {
            let progress_ui = weak.clone();
            let progress = move |value: f32, step: Step| {
                let _ = progress_ui.upgrade_in_event_loop(move |ui| {
                    ui.set_progress(value);
                    ui.set_status(step_text(step, zh).into());
                });
            };
            let result = if uninstalling {
                install::uninstall(&options.dir, delete_settings, &progress).map(|_| true)
            } else {
                install::install(&options, &progress).map(|done| done.runtime_ok)
            };
            let _ = weak.upgrade_in_event_loop(move |ui| match result {
                Ok(runtime_ok) => {
                    ui.set_runtime_missing(!runtime_ok);
                    ui.set_page(2);
                }
                Err(e) => {
                    ui.set_error(error_text(&e, zh).into());
                    ui.set_page(3);
                }
            });
        });
    });

    let weak = ui.as_weak();
    ui.on_dismiss(move || {
        let ui = weak.unwrap();
        if ui.get_page() == 1 {
            return; // not while files are being written
        }
        if ui.get_page() == 2 && !uninstalling && !ui.get_runtime_missing() && ui.get_launch_after() {
            install::launch(&PathBuf::from(ui.get_install_dir().trim()));
        }
        let _ = ui.hide();
        let _ = slint::quit_event_loop();
    });

    ui.run().expect("event loop failed");
    0
}
