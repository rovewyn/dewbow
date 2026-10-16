use super::schema;
use crate::{config, maintenance, store::INVALID_STATE};
use anyhow::ensure;
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn copy(source: &Path, target: &Path) -> anyhow::Result<String> {
    use std::io::Write;
    dewbow_sdk::private::regular(source)?;
    let bytes = fs::read(source)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(target)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Only schema/database changes occur in 1 -> 2; retained files are not rewritten.
pub fn migrate(db: &mut Connection, state: &Path, source: i64) -> anyhow::Result<()> {
    ensure!(matches!(source, 0..=2), INVALID_STATE);
    if source == schema::VERSION {
        return Ok(());
    }
    if source == 1 {
        crate::store::verify_runtime_stopped(state)?;
        let (busy, remaining): (u32, i64) =
            db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        ensure!(
            busy == 0 && remaining == 0,
            "Management state could not be checkpointed for migration"
        );
        let root = state.join("migration-backups");
        config::secure_directory(&root)?;
        maintenance::sync_directory(state)?;
        let backup = root.join(dewbow_protocol::id());
        config::secure_directory(&backup)?;
        let database_hash = copy(&state.join("daemon.sqlite"), &backup.join("daemon.sqlite"))?;
        let config_hash = if state.join("config.json").exists() {
            Some(copy(
                &state.join("config.json"),
                &backup.join("config.json"),
            )?)
        } else {
            None
        };
        let saved = Connection::open_with_flags(
            backup.join("daemon.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        ensure!(schema::inspect(&saved)? == source, INVALID_STATE);
        ensure!(
            saved.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))? == "ok",
            INVALID_STATE
        );
        config::write_json(
            &backup.join("manifest.json"),
            &json!({"formatVersion":1,"sourceSchema":source,"targetSchema":schema::VERSION,"databaseHash":database_hash,"configHash":config_hash}),
        )?;
        maintenance::sync_directory(&backup)?;
        maintenance::sync_directory(&root)?;
        #[cfg(test)]
        checkpoint("backedUp")?;
    }
    db.execute_batch("PRAGMA foreign_keys=ON;")?;
    let tx = db.transaction()?;
    if source == 0 {
        tx.execute_batch(schema::RECORDS_SQL)?;
    }
    tx.execute_batch(schema::SQL)?;
    #[cfg(test)]
    checkpoint("transformed")?;
    tx.pragma_update(None, "user_version", schema::VERSION)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
thread_local! { static FAULT: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
pub(crate) fn fault_at(phase: Option<&'static str>) {
    FAULT.with(|value| value.set(phase));
}
#[cfg(test)]
pub(crate) fn checkpoint(phase: &str) -> anyhow::Result<()> {
    ensure!(
        !FAULT.with(|value| value.get() == Some(phase)),
        "Injected migration interruption"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn fixture() -> std::path::PathBuf {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "dewbow-network-migration-{}",
                dewbow_protocol::id()
            ));
        config::secure_directory(&root).unwrap();
        let db = Connection::open(root.join("daemon.sqlite")).unwrap();
        db.execute_batch(schema::RECORDS_SQL).unwrap();
        db.pragma_update(None, "user_version", 1).unwrap();
        db.execute("INSERT INTO records VALUES('operation','synthetic-request',?1)", [json!({"requestId":"synthetic-request","commandId":"synthetic-command","operation":"sendMessage","sessionId":"synthetic-session","turnId":null,"status":"unknown","createdAt":"2000-01-01T00:00:00Z","error":null,"fingerprint":"a".repeat(64)}).to_string()]).unwrap();
        root
    }

    #[test]
    fn migration_preserves_receipts_and_retains_a_consistent_backup() {
        let root = fixture();
        let before = Connection::open(root.join("daemon.sqlite"))
            .unwrap()
            .query_row("SELECT data FROM records", [], |r| r.get::<_, String>(0))
            .unwrap();
        let store = Store::open(&root).unwrap();
        assert_eq!(
            store
                .get("operation", "synthetic-request")
                .unwrap()
                .unwrap()["status"],
            "unknown"
        );
        drop(store);
        let db = Connection::open(root.join("daemon.sqlite")).unwrap();
        assert_eq!(schema::inspect(&db).unwrap(), 2);
        assert_eq!(
            db.query_row("SELECT data FROM records", [], |r| r.get::<_, String>(0))
                .unwrap(),
            before
        );
        let backup = fs::read_dir(root.join("migration-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(backup.join("manifest.json").exists());
        assert_eq!(
            schema::inspect(&Connection::open(backup.join("daemon.sqlite")).unwrap()).unwrap(),
            1
        );
        assert!(!root.join("network-keys").exists());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_migration_rolls_back_and_can_restart_without_losing_uncertainty() {
        for phase in ["backedUp", "transformed"] {
            let root = fixture();
            fault_at(Some(phase));
            assert!(Store::open(&root).is_err());
            fault_at(None);
            let db = Connection::open(root.join("daemon.sqlite")).unwrap();
            assert_eq!(schema::inspect(&db).unwrap(), 1);
            drop(db);
            let store = Store::open(&root).unwrap();
            assert_eq!(
                store
                    .get("operation", "synthetic-request")
                    .unwrap()
                    .unwrap()["fingerprint"],
                "a".repeat(64)
            );
            drop(store);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn invalid_source_identity_is_rejected_before_migration_or_backup() {
        let root = fixture();
        let configuration = crate::config::Config {
            contract_version: "v1".into(),
            host_id: "invalid-host".into(),
            name: "Synthetic".into(),
            port: 3000,
            codex_executable: "/synthetic/codex".into(),
            codex_home: "/synthetic/home".into(),
            control_token: "synthetic-only".into(),
        };
        crate::config::write_json(&root.join("config.json"), &configuration).unwrap();
        let before = fs::read(root.join("daemon.sqlite")).unwrap();
        assert!(Store::open(&root).is_err());
        assert_eq!(fs::read(root.join("daemon.sqlite")).unwrap(), before);
        assert!(!root.join("migration-backups").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
