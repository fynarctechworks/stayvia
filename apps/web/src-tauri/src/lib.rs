mod db_manager;
mod sidecar;

use std::sync::{Arc, Mutex};

use tauri::Manager;

/// Process-wide state we must tear down on exit: the embedded Postgres handle
/// and the api.exe sidecar child. Held in Tauri state so the exit hook can
/// stop them in the right order (sidecar first, then Postgres).
///
/// The sidecar slot is an Arc so the supervisor thread can share it and swap
/// in a fresh child when the API process dies (crash / external kill) — the
/// desk keeps working instead of every page failing until an app restart.
struct AppProcs {
    db: Mutex<Option<db_manager::DbHandle>>,
    sidecar: Arc<Mutex<Option<sidecar::Sidecar>>>,
}

/// Settings → Data Storage: where the data lives now, any pending move, and
/// the built-in default. The frontend invokes this to render the card.
#[tauri::command]
fn get_data_dir() -> Result<serde_json::Value, String> {
    db_manager::data_dir_info()
        .map(|(current, pending, default)| {
            serde_json::json!({ "current": current, "pending": pending, "default": default })
        })
        .map_err(|e| format!("{e:#}"))
}

/// Settings → Data Storage: request a move. Validated + written to
/// config.json as pendingDataDir; the move itself runs on the next launch,
/// before Postgres starts.
#[tauri::command]
fn set_data_dir(path: String) -> Result<(), String> {
    db_manager::request_data_dir(&path).map_err(|e| format!("{e:#}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_data_dir, set_data_dir])
        .manage(AppProcs {
            db: Mutex::new(None),
            sidecar: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Info
                    } else {
                        log::LevelFilter::Warn
                    })
                    .build(),
            )?;

            // Resource dir holds the bundled pgsql/ and api sidecar in release.
            let resource_dir = app.path().resource_dir().ok();

            // 1. Bring up embedded Postgres (initdb on first run, WAL-recover
            //    on a prior power loss, health-gated).
            let db = match db_manager::start(resource_dir.as_deref()) {
                Ok(handle) => handle,
                Err(e) => {
                    log::error!("embedded Postgres failed to start: {e:#}");
                    return Err(format!("database start failed: {e}").into());
                }
            };
            log::info!("embedded Postgres up (fresh={})", db.fresh);

            // 2. Spawn the api.exe sidecar, handing it DATABASE_URL over the
            //    stdin handshake, and health-gate on /health. When the sidecar
            //    binary is not present (pre-Task-2 / pure web-dev), this is a
            //    no-op and the app falls back to the configured VITE_API_URL.
            let sidecar = sidecar::spawn(app.handle(), resource_dir.as_deref(), &db);

            let procs = app.state::<AppProcs>();
            *procs.db.lock().unwrap() = Some(db);
            *procs.sidecar.lock().unwrap() = sidecar;

            // 3. Watch the sidecar: if api.exe ever dies (crash, antivirus,
            //    Task Manager), bring it straight back instead of leaving the
            //    desk staring at connection errors until they restart the app.
            sidecar::supervise(Arc::clone(&procs.sidecar));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let procs = window.state::<AppProcs>();
                // Take both out of their mutexes FIRST so the lock guards drop
                // before we run the (potentially slow) stop logic, and before
                // `procs` itself drops — otherwise a guard would outlive the
                // State borrow. Stop the sidecar first so no new writes hit
                // Postgres, then stop Postgres cleanly.
                let sidecar = procs.sidecar.lock().unwrap().take();
                let db = procs.db.lock().unwrap().take();
                if let Some(mut sc) = sidecar {
                    sc.stop();
                }
                if let Some(db) = db {
                    if let Err(e) = db_manager::stop(&db) {
                        log::warn!("error stopping Postgres: {e:#}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
