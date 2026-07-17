//! Embedded PostgreSQL lifecycle for the offline-first desktop app.
//!
//! Responsibilities (all validated by the Task-1 spike before this was written):
//!   1. Locate the portable PostgreSQL 16 binaries (bundled resource in
//!      release; a dev fallback path in debug).
//!   2. First run: `initdb` a fresh cluster under %LOCALAPPDATA%\SLDT\pgdata
//!      with scram-sha-256 auth and a random superuser password; write a
//!      loopback-only postgresql.conf on port 5433 with synchronous_commit on.
//!   3. Every run: `pg_ctl start` (self-heals a stale postmaster.pid + replays
//!      WAL after a power loss — proven in the spike), then poll pg_isready.
//!   4. Ensure the app database exists.
//!   5. On shutdown: `pg_ctl stop -m fast` for a clean checkpoint.
//!
//! Schema creation (drizzle push + migrate) is NOT done here — it runs inside
//! the api.exe sidecar which owns the Drizzle toolchain. This module only
//! guarantees a running, reachable cluster with the database present.
//!
//! The superuser password and the derived DATABASE_URL never touch argv or an
//! inheritable env: they are returned to the caller (lib.rs), which hands them
//! to the sidecar over a stdin handshake.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use rand::Rng;

/// Build a Command that spawns WITHOUT a console window on Windows. Every pg
/// tool (initdb, pg_ctl, postgres, psql, ...) is a console program, so without
/// this a black terminal flashes up on each call in the packaged app. No-op on
/// other platforms.
fn cmd(program: &Path) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Loopback address + port the embedded cluster listens on. 5433 avoids
/// colliding with a system Postgres on 5432 or the Supabase-CLI dev stack.
pub const PG_HOST: &str = "127.0.0.1";
pub const PG_PORT: u16 = 5433;
pub const PG_SUPERUSER: &str = "hoteldesk";
pub const APP_DB: &str = "hoteldesk";

/// Everything the sidecar needs to connect, produced by `start()`.
pub struct DbHandle {
    pub data_dir: PathBuf,
    /// User-relocatable file-storage root (KYC photos, invoice/receipt PDFs,
    /// expense bills) — sibling of pgdata under the configured data root.
    pub storage_dir: PathBuf,
    pub bin_dir: PathBuf,
    /// postgresql://hoteldesk:<pw>@127.0.0.1:5433/hoteldesk
    pub database_url: String,
    /// True when this launch just created the cluster — the caller uses this
    /// to decide whether the sidecar must run the first-time schema build
    /// (drizzle push + migrate) vs. only pending migrations.
    pub fresh: bool,
    /// Session-signing secret for offline auth (persisted on first run).
    pub local_jwt_secret: String,
    /// AES key for at-rest encryption (KYC ciphertext, TOTP secrets). 64-hex.
    pub encryption_key: String,
}

/// Root data directory: %LOCALAPPDATA%\SLDT on Windows, ~/.local/share/SLDT
/// elsewhere (dev on non-Windows). Created if missing.
pub fn app_root() -> Result<PathBuf> {
    let base = dirs_local_data().context("could not resolve a local data dir")?;
    let root = base.join("SLDT");
    fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
    Ok(root)
}

#[cfg(windows)]
fn dirs_local_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

#[cfg(not(windows))]
fn dirs_local_data() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

// ---------- user-configurable data location ----------
//
// config.json lives at the FIXED anchor (%LOCALAPPDATA%\SLDT\config.json) so
// the app can always find it; it points at the (movable) data root holding
// pgdata/ and storage/. Secrets and messaging.env stay at the anchor. The
// Settings UI writes `pendingDataDir`; the actual move runs on the NEXT boot,
// before Postgres starts, so the cluster is never live while its files move.

fn config_path() -> Result<PathBuf> {
    Ok(app_root()?.join("config.json"))
}

fn read_config() -> (Option<PathBuf>, Option<PathBuf>) {
    let Ok(p) = config_path() else { return (None, None) };
    let Ok(raw) = fs::read_to_string(&p) else { return (None, None) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return (None, None) };
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(PathBuf::from);
    (get("dataDir"), get("pendingDataDir"))
}

fn write_config(data_dir: Option<&Path>, pending: Option<&Path>) -> Result<()> {
    let mut obj = serde_json::Map::new();
    if let Some(d) = data_dir {
        obj.insert(
            "dataDir".into(),
            serde_json::Value::String(d.to_string_lossy().into_owned()),
        );
    }
    if let Some(p) = pending {
        obj.insert(
            "pendingDataDir".into(),
            serde_json::Value::String(p.to_string_lossy().into_owned()),
        );
    }
    fs::write(
        config_path()?,
        serde_json::to_string_pretty(&serde_json::Value::Object(obj))?,
    )?;
    Ok(())
}

/// The data root (pgdata + storage). Applies a pending move first — called
/// once at boot, before Postgres starts.
pub fn data_root() -> Result<PathBuf> {
    let anchor = app_root()?;
    let (cfg_dir, pending) = read_config();
    let current = cfg_dir.unwrap_or_else(|| anchor.clone());
    let Some(target) = pending else {
        return Ok(current);
    };
    if target == current {
        let _ = write_config(Some(&current), None);
        return Ok(current);
    }
    log::info!(
        "moving data root {} -> {}",
        current.display(),
        target.display()
    );
    match move_data(&current, &target) {
        Ok(()) => {
            write_config(Some(&target), None)?;
            Ok(target)
        }
        Err(e) => {
            // Clear the pending flag so a broken target can't crash-loop every
            // boot; the desk keeps running from the old location and the
            // Settings card shows where the data actually lives.
            log::error!("data move failed, staying at {}: {e:#}", current.display());
            let _ = write_config(Some(&current), None);
            Ok(current)
        }
    }
}

fn move_data(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for name in ["pgdata", "storage"] {
        let src = from.join(name);
        let dst = to.join(name);
        if !src.exists() {
            continue;
        }
        if dst.exists() {
            bail!("{} already exists — refusing to overwrite", dst.display());
        }
        // Same-volume: instant rename. Cross-volume: full copy, then archive
        // the original with a timestamp suffix instead of deleting hotel data
        // outright — the operator removes the backup once satisfied.
        if fs::rename(&src, &dst).is_ok() {
            continue;
        }
        copy_dir(&src, &dst)
            .with_context(|| format!("copy {} -> {}", src.display(), dst.display()))?;
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = from.join(format!("{name}.old-{epoch}"));
        fs::rename(&src, &backup)
            .with_context(|| format!("archive old {}", src.display()))?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let d = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &d)?;
        } else {
            fs::copy(entry.path(), &d)?;
        }
    }
    Ok(())
}

/// Settings UI: (current, pending, default) locations as display strings.
pub fn data_dir_info() -> Result<(String, Option<String>, String)> {
    let anchor = app_root()?;
    let (cfg, pending) = read_config();
    let current = cfg.unwrap_or_else(|| anchor.clone());
    Ok((
        current.to_string_lossy().into_owned(),
        pending.map(|p| p.to_string_lossy().into_owned()),
        anchor.to_string_lossy().into_owned(),
    ))
}

/// Settings UI: request a data-folder move (applied on the next launch).
///
/// The chosen folder is always given an `SLDT` subfolder unless the operator
/// already picked one — otherwise selecting a drive root or a shared folder
/// would scatter bare `pgdata`/`storage` directories among their own files.
pub fn request_data_dir(path: &str) -> Result<()> {
    let picked = PathBuf::from(path.trim());
    if !picked.is_absolute() {
        bail!("Path must be absolute (e.g. D:\\SLDT)");
    }
    let already_named = picked
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("SLDT"))
        .unwrap_or(false);
    let target = if already_named {
        picked
    } else {
        picked.join("SLDT")
    };
    let (cfg, _) = read_config();
    let current = cfg.unwrap_or(app_root()?);
    if target == current {
        // Selecting the current folder = cancel any pending move.
        write_config(Some(&current), None)?;
        return Ok(());
    }
    if target.starts_with(&current) || current.starts_with(&target) {
        bail!("New folder must not be inside the current data folder (or vice versa)");
    }
    fs::create_dir_all(&target).with_context(|| format!("create {}", target.display()))?;
    let probe = target.join(".sldt-write-test");
    fs::write(&probe, b"ok").context("target folder is not writable")?;
    let _ = fs::remove_file(&probe);
    write_config(Some(&current), Some(&target))?;
    Ok(())
}

/// Resolve the directory holding initdb/pg_ctl/postgres/pg_isready.
///
/// Release: the binaries are bundled as a Tauri resource under
/// `<resource_dir>/pgsql/bin`. Debug: fall back to the developer's EDB
/// binaries-only install (the same one the spike used), overridable via
/// SLDT_PG_BIN for CI.
fn resolve_bin_dir(resource_dir: Option<&Path>) -> Result<PathBuf> {
    if let Some(env_dir) = std::env::var_os("SLDT_PG_BIN") {
        let p = PathBuf::from(env_dir);
        if p.join(exe("postgres")).exists() {
            return Ok(p);
        }
    }
    if let Some(res) = resource_dir {
        // Tauri's resource_dir() is a `\\?\` extended-length (verbatim) path on
        // Windows. Passing initdb.exe with that prefix breaks initdb's own
        // "find postgres.exe next to me" logic (it can't parse the verbatim
        // dir). Strip the prefix so the bundled binaries get a normal path.
        let bundled = strip_verbatim(&res.join("pgsql").join("bin"));
        if bundled.join(exe("postgres")).exists() {
            return Ok(bundled);
        }
    }
    // Dev fallback: the EDB portable install used during the spike.
    if let Some(local) = dirs_local_data() {
        // %LOCALAPPDATA% on Windows already points at ...\Local; the EDB layout
        // is ...\Local\PostgreSQL\pgsql\bin.
        let dev = local.join("PostgreSQL").join("pgsql").join("bin");
        if dev.join(exe("postgres")).exists() {
            return Ok(dev);
        }
    }
    bail!("could not locate PostgreSQL binaries (set SLDT_PG_BIN or bundle pgsql/bin)")
}

#[cfg(windows)]
fn exe(name: &str) -> String {
    format!("{name}.exe")
}
#[cfg(not(windows))]
fn exe(name: &str) -> String {
    name.to_string()
}

fn tool(bin_dir: &Path, name: &str) -> PathBuf {
    bin_dir.join(exe(name))
}

/// Strip the Windows `\\?\` verbatim (extended-length) prefix from a path.
/// Tauri resource paths carry it, and some bundled tools (initdb locating
/// its sibling postgres.exe) can't handle it. No-op on non-Windows or paths
/// without the prefix. Also exposed for the sidecar resolver.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else if let Some(rest) = s.strip_prefix("//?/") {
        // Some layers normalize backslashes to forward slashes.
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// Start (and first-run-initialize) the embedded cluster. Returns a handle
/// with the connection URL and whether the cluster was freshly created.
pub fn start(resource_dir: Option<&Path>) -> Result<DbHandle> {
    let root = app_root()?;
    // Movable data root (applies any pending relocation BEFORE the cluster
    // starts). Secrets stay at the fixed anchor.
    let droot = data_root()?;
    let data_dir = droot.join("pgdata");
    let storage_dir = droot.join("storage");
    let secrets_dir = root.join("secrets");
    fs::create_dir_all(&secrets_dir).ok();
    let bin_dir = resolve_bin_dir(resource_dir)?;

    let pw_file = secrets_dir.join("pg_superuser");
    // A cluster is "complete" only if PG_VERSION exists. If pgdata exists but
    // has no PG_VERSION, a previous initdb crashed partway (e.g. the app was
    // killed mid-init) — the directory is a non-empty half-init that initdb
    // refuses to run into ("directory exists but is not empty"). That produces
    // a start-fails-every-launch loop. So: treat missing PG_VERSION as fresh
    // AND wipe any partial pgdata first so initdb gets a clean directory.
    let is_fresh = !data_dir.join("PG_VERSION").exists();

    if is_fresh {
        if data_dir.exists() {
            log::warn!(
                "partial/incomplete pgdata at {} (no PG_VERSION) — removing before initdb",
                data_dir.display()
            );
            fs::remove_dir_all(&data_dir)
                .with_context(|| format!("remove partial pgdata {}", data_dir.display()))?;
        }
        log::info!("no cluster found — running initdb at {}", data_dir.display());
        let password = generate_password();
        // Persist the superuser password so restarts reuse the cluster. It
        // lives under %LOCALAPPDATA%\SLDT\secrets, readable by the desk user
        // only via NTFS defaults (this is a single-user desk box; tighten with
        // icacls if the machine is shared). PGPASSWORD is passed to child psql
        // processes below — acceptable here since they're same-user loopback
        // and the alternative (a .pgpass file) has the same at-rest exposure.
        fs::write(&pw_file, &password).context("write superuser password file")?;
        run_initdb(&bin_dir, &data_dir, &pw_file)?;
        write_conf(&data_dir)?;
    } else {
        log::info!("existing cluster found at {}", data_dir.display());
    }

    // Start the cluster, tolerating an already-running or stale instance.
    //
    //   - If our port is ALREADY accepting connections, a prior instance is
    //     live (e.g. a previous app run that didn't shut down cleanly, or two
    //     launches racing). Reuse it — DON'T run pg_ctl start, which would hang
    //     on "another server might be running; trying to start server anyway".
    //   - Otherwise, a leftover postmaster.pid with no live server is stale
    //     (hard power-off / kill). Remove it so pg_ctl start doesn't wait on a
    //     dead PID, then start.
    if is_ready(&bin_dir) {
        log::info!("embedded Postgres already running on {PG_PORT} — reusing it");
    } else {
        let pid_file = data_dir.join("postmaster.pid");
        if pid_file.exists() {
            log::warn!("stale postmaster.pid with no live server — removing before start");
            let _ = fs::remove_file(&pid_file);
        }
        start_cluster(&bin_dir, &data_dir)?;
    }

    // From here Postgres is RUNNING. If any subsequent step fails we must stop
    // it before returning Err — otherwise the cluster is left live, and the
    // next launch's pg_ctl start would bail on the running postmaster,
    // bricking startup. Do the fallible work in a closure and stop-on-error.
    let finish = || -> Result<String> {
        wait_ready(&bin_dir, Duration::from_secs(30))?;
        let password = fs::read_to_string(&pw_file)
            .context("read superuser password")?
            .trim()
            .to_string();
        ensure_database(&bin_dir, &password)?;
        Ok(password)
    };

    let password = match finish() {
        Ok(pw) => pw,
        Err(e) => {
            log::error!("post-start step failed, stopping cluster: {e:#}");
            let _ = stop_cluster(&bin_dir, &data_dir);
            return Err(e);
        }
    };

    let database_url = format!(
        "postgresql://{user}:{pw}@{host}:{port}/{db}",
        user = PG_SUPERUSER,
        pw = urlencode(&password),
        host = PG_HOST,
        port = PG_PORT,
        db = APP_DB,
    );

    // Offline secrets — generated once and persisted alongside the DB password.
    // LOCAL_JWT_SECRET signs session tokens + peppers the PIN hash;
    // ENCRYPTION_KEY (64-hex / 32 bytes) is the at-rest AES key. Keeping them
    // stable across launches is required so existing sessions/hashes/ciphertext
    // stay valid.
    let local_jwt_secret = load_or_create_secret(&secrets_dir.join("local_jwt"), 48)?;
    let encryption_key = load_or_create_hex_key(&secrets_dir.join("encryption_key"))?;

    Ok(DbHandle {
        data_dir,
        storage_dir,
        bin_dir,
        database_url,
        fresh: is_fresh,
        local_jwt_secret,
        encryption_key,
    })
}

/// Load a persisted secret, or create a fresh random one (hex) of `bytes`
/// length on first run. Trims whitespace on read.
fn load_or_create_secret(path: &Path, bytes: usize) -> Result<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let s = existing.trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }
    let mut rng = rand::thread_rng();
    let secret: String = (0..bytes).map(|_| format!("{:02x}", rng.gen::<u8>())).collect();
    fs::write(path, &secret).with_context(|| format!("write secret {}", path.display()))?;
    Ok(secret)
}

/// Like load_or_create_secret but always exactly 64 hex chars (32 bytes) to
/// satisfy the ENCRYPTION_KEY format.
fn load_or_create_hex_key(path: &Path) -> Result<String> {
    load_or_create_secret(path, 32)
}

/// Stop a cluster by data dir (used by the error-recovery path in start()).
fn stop_cluster(bin_dir: &Path, data_dir: &Path) -> Result<()> {
    let status = cmd(&tool(bin_dir, "pg_ctl"))
        .arg("-D")
        .arg(data_dir)
        .arg("stop")
        .args(["-m", "fast"])
        .status()
        .context("spawn pg_ctl stop (recovery)")?;
    if !status.success() {
        log::warn!("pg_ctl stop (recovery) exited with {status}");
    }
    Ok(())
}

/// Clean shutdown. `fast` mode rolls back in-flight txns and checkpoints, so
/// the next start needs no WAL replay. Safe to call if already stopped.
pub fn stop(handle: &DbHandle) -> Result<()> {
    let status = cmd(&tool(&handle.bin_dir, "pg_ctl"))
        .arg("-D")
        .arg(&handle.data_dir)
        .arg("stop")
        .args(["-m", "fast"])
        .status()
        .context("spawn pg_ctl stop")?;
    if !status.success() {
        log::warn!("pg_ctl stop exited with {status} (may already be stopped)");
    }
    Ok(())
}

fn run_initdb(bin_dir: &Path, data_dir: &Path, pw_file: &Path) -> Result<()> {
    let out = cmd(&tool(bin_dir, "initdb"))
        .arg("-D")
        .arg(data_dir)
        .args(["-U", PG_SUPERUSER])
        .args(["--auth", "scram-sha-256"])
        .arg("--pwfile")
        .arg(pw_file)
        .args(["-E", "UTF8"])
        .output()
        .context("spawn initdb")?;
    if !out.status.success() {
        bail!(
            "initdb failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(())
}

/// Append the SLDT-specific settings the spike validated: loopback-only,
/// port 5433, durable commits. Idempotent enough for first run (only called
/// when the cluster is fresh).
fn write_conf(data_dir: &Path) -> Result<()> {
    let conf = data_dir.join("postgresql.conf");
    let mut body = fs::read_to_string(&conf).unwrap_or_default();
    body.push_str(
        "\n# --- SLDT embedded config ---\n\
         listen_addresses = '127.0.0.1'\n\
         port = 5433\n\
         synchronous_commit = on\n",
    );
    fs::write(&conf, body).context("write postgresql.conf")?;
    Ok(())
}

fn start_cluster(bin_dir: &Path, data_dir: &Path) -> Result<()> {
    let log_file = data_dir.join("startup.log");
    // No -w: pg_ctl on Windows can block the parent waiting on a console
    // handle (this bit us in the spike). We start detached and poll
    // pg_isready ourselves for a deterministic readiness gate.
    let status = cmd(&tool(bin_dir, "pg_ctl"))
        .arg("-D")
        .arg(data_dir)
        .arg("-l")
        .arg(&log_file)
        .arg("start")
        .status()
        .context("spawn pg_ctl start")?;
    if !status.success() {
        bail!("pg_ctl start exited with {status}");
    }
    Ok(())
}

/// Single non-blocking readiness probe — true if a server is accepting
/// connections on our loopback port right now.
fn is_ready(bin_dir: &Path) -> bool {
    cmd(&tool(bin_dir, "pg_isready"))
        .args(["-h", PG_HOST])
        .args(["-p", &PG_PORT.to_string()])
        .arg("-q")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn wait_ready(bin_dir: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if is_ready(bin_dir) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("cluster did not become ready within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Create the app database if it doesn't exist. `createdb` errors when the DB
/// already exists, so we check first via psql.
fn ensure_database(bin_dir: &Path, password: &str) -> Result<()> {
    // APP_DB is a compile-time const (no injection risk), so interpolate it
    // directly. psql -c does NOT do :'var' substitution the way an
    // interactive session does, so a bound variable silently produced a
    // "syntax error at or near \":\"" — which made the check always fail and
    // createdb always run. Plain SQL avoids that.
    let query = format!("select 1 from pg_database where datname = '{APP_DB}'");
    let exists = cmd(&tool(bin_dir, "psql"))
        .env("PGPASSWORD", password)
        .args(["-h", PG_HOST])
        .args(["-p", &PG_PORT.to_string()])
        .args(["-U", PG_SUPERUSER])
        .args(["-d", "postgres"])
        .args(["-tAc", &query])
        .output()
        .context("spawn psql (db check)")?;
    if String::from_utf8_lossy(&exists.stdout).trim() == "1" {
        return Ok(());
    }
    let out = cmd(&tool(bin_dir, "createdb"))
        .env("PGPASSWORD", password)
        .args(["-h", PG_HOST])
        .args(["-p", &PG_PORT.to_string()])
        .args(["-U", PG_SUPERUSER])
        .arg(APP_DB)
        .output()
        .context("spawn createdb")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Idempotent: if the DB already exists (e.g. the pre-check raced, or we
        // reused a running cluster whose DB was already created), that's fine —
        // NOT a fatal error. Only real failures abort.
        if stderr.contains("already exists") {
            return Ok(());
        }
        bail!("createdb failed: {stderr}");
    }
    Ok(())
}

fn generate_password() -> String {
    let mut rng = rand::thread_rng();
    // 32 hex chars of entropy; no shell-special or URL-special chars so it is
    // safe in DATABASE_URL and PGPASSWORD.
    (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16u8)))
        .collect()
}

/// Minimal percent-encoding for the password in DATABASE_URL. Our generated
/// password is hex-only so this is belt-and-suspenders, but keep it correct in
/// case the generator changes.
fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}
