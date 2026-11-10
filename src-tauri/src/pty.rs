//! Pseudo-terminals for the UI (the terminal plugin). Each PTY belongs to the window that started it,
//! runs the user's default shell in that window's workspace folder, and is killed with the window.
//! Output is streamed as raw bytes over a channel (no JSON), input is written as text.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager,
};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

struct Pty {
    owner: String, // window label
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyHost {
    ptys: Mutex<HashMap<u32, Pty>>,
    next: AtomicU32,
}

#[derive(Serialize)]
pub struct Spawned {
    id: u32,
    shell: String,
}

/// Same choice as VS Code: PowerShell on Windows (PowerShell 7 if installed), $SHELL elsewhere.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        let on_path = |exe: &str| {
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).any(|dir| dir.join(exe).is_file()))
                .unwrap_or(false)
        };
        if on_path("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

impl PtyHost {
    pub fn spawn(
        &self,
        app: AppHandle,
        owner: &str,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        on_data: Channel<InvokeResponseBody>,
        on_exit: Channel<i32>,
    ) -> Result<Spawned, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(err)?;
        let shell = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Lite");
        let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
        drop(pair.slave); // the child holds its own end now

        let mut reader = pair.master.try_clone_reader().map_err(err)?;
        let writer = pair.master.take_writer().map_err(err)?;
        let killer = child.clone_killer();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.ptys.lock().unwrap().insert(id, Pty { owner: owner.into(), writer, master: pair.master, killer });

        // Output -> UI, as raw bytes.
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Exit is detected by waiting on the process, not by EOF: on Windows the ConPTY output pipe stays
        // open after the shell exits. Dropping the master afterwards closes it and ends the reader.
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            app.state::<PtyHost>().ptys.lock().unwrap().remove(&id);
            let _ = on_exit.send(code);
        });

        Ok(Spawned { id, shell })
    }

    fn with<T>(&self, owner: &str, id: u32, f: impl FnOnce(&mut Pty) -> Result<T, String>) -> Result<T, String> {
        let mut ptys = self.ptys.lock().unwrap();
        match ptys.get_mut(&id) {
            Some(p) if p.owner == owner => f(p),
            _ => Err(format!("no terminal {id} in this window")),
        }
    }

    pub fn write(&self, owner: &str, id: u32, data: &str) -> Result<(), String> {
        self.with(owner, id, |p| {
            p.writer.write_all(data.as_bytes()).map_err(err)?;
            p.writer.flush().map_err(err)
        })
    }

    pub fn resize(&self, owner: &str, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        self.with(owner, id, |p| p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(err))
    }

    /// The exit (and cleanup) is then reported by the waiter thread.
    pub fn kill(&self, owner: &str, id: u32) -> Result<(), String> {
        self.with(owner, id, |p| p.killer.kill().map_err(err))
    }

    /// Window closed: its shells go with it.
    pub fn kill_owned_by(&self, owner: &str) {
        for p in self.ptys.lock().unwrap().values_mut().filter(|p| p.owner == owner) {
            let _ = p.killer.kill();
        }
    }
}
