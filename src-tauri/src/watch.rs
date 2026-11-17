//! File watching: one recursive watcher per window, on its workspace folder.
//!
//! Raw notifications are batched (a save or a `git checkout` is a burst of them) and sent to the
//! window as one `lite://fs-changed` event: `{ all, paths, structural }`.
//!   paths       everything that changed (content, or existence)
//!   structural  the subset that was created, removed or renamed — what a file tree cares about
//!   all         too much happened to list it: treat everything as changed
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "lite://fs-changed";
/// A batch ends after this much silence…
const QUIET: Duration = Duration::from_millis(120);
/// …or at the latest this long after its first notification (a build writing files non-stop).
const MAX_WAIT: Duration = Duration::from_millis(600);
/// More paths than this in one batch: just say "everything".
const MAX_PATHS: usize = 400;

#[derive(Serialize, Clone, Default)]
struct Changes {
    all: bool,
    paths: BTreeSet<String>,
    structural: BTreeSet<String>,
}

#[derive(Default)]
pub struct Watchers {
    /// window label -> (watched folder, its watcher); dropping the watcher stops it and its thread.
    active: Mutex<HashMap<String, (PathBuf, RecommendedWatcher)>>,
}

impl Watchers {
    /// Watch `root` for the window (replacing what it watched before). Failing is not fatal: the
    /// window just doesn't refresh by itself.
    pub fn watch(&self, app: AppHandle, label: &str, root: &Path) {
        let mut active = self.active.lock().unwrap();
        if active.get(label).is_some_and(|(watched, _)| watched == root) {
            return; // e.g. the window was reloaded
        }
        active.remove(label);
        match start(app, label.to_string(), root) {
            Ok(watcher) => {
                active.insert(label.to_string(), (root.to_path_buf(), watcher));
            }
            Err(e) => eprintln!("[lite] cannot watch {}: {e}", root.display()),
        }
    }

    pub fn unwatch(&self, label: &str) {
        self.active.lock().unwrap().remove(label);
    }
}

fn start(app: AppHandle, label: String, root: &Path) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    // Ends when the watcher (the sender) is dropped.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut changes = Changes::default();
            add(&mut changes, first);
            let deadline = Instant::now() + MAX_WAIT;
            while let Ok(next) = rx.recv_timeout(QUIET.min(deadline.saturating_duration_since(Instant::now()))) {
                add(&mut changes, next);
                if Instant::now() >= deadline {
                    break;
                }
            }
            if changes.paths.len() > MAX_PATHS {
                changes = Changes { all: true, ..Default::default() };
            }
            if changes.all || !changes.paths.is_empty() {
                let _ = app.emit_to(label.as_str(), EVENT, changes);
            }
        }
    });
    Ok(watcher)
}

fn add(changes: &mut Changes, event: notify::Result<notify::Event>) {
    let Ok(event) = event else {
        changes.all = true; // e.g. the OS dropped notifications: we no longer know what changed
        return;
    };
    if event.need_rescan() {
        changes.all = true;
    }
    let structural = match event.kind {
        EventKind::Access(_) => return,
        EventKind::Modify(ModifyKind::Name(_)) => true,
        EventKind::Modify(_) => false,
        _ => true, // created, removed, or unknown
    };
    for path in event.paths {
        let path = path.to_string_lossy().into_owned();
        if structural {
            changes.structural.insert(path.clone());
        }
        changes.paths.insert(path);
    }
}
