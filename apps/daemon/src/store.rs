use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::Mutex,
};

/// Inspect ownership without initializing or changing retained state.
pub fn verify_runtime_stopped(state: &Path) -> anyhow::Result<()> {
    let path = state.join("daemon.sqlite");
    if !path.exists() {
        return Ok(());
    }
    dewbow_sdk::private::regular(&path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM records WHERE kind='meta' AND id='owner'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        let owner: Value = serde_json::from_str(&raw)?;
        if !owner.is_null() {
            let pid = owner["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0)
                .ok_or_else(|| {
                    anyhow::anyhow!("Invalid native ownership record; recovery is required")
                })?;
            anyhow::ensure!(
                !dewbow_sdk::private::process_alive(pid)?,
                "The previously owned native process is still alive; recover the selected daemon before upgrading"
            );
        }
    }
    Ok(())
}

type Records = BTreeMap<(String, String), Value>;
type Events = BTreeMap<String, (u64, VecDeque<Value>)>;

const INVALID_STATE: &str =
    "RECOVERY_REQUIRED: unsupported or malformed management state; preserve it for recovery";

fn fields(kind: &str, id: &str) -> anyhow::Result<&'static [&'static str]> {
    Ok(match kind {
        "session" => &[
            "sessionId",
            "codexThreadId",
            "workDir",
            "sessionConfig",
            "createdAt",
            "activeTurnId",
        ],
        "turn" => &[
            "turnId",
            "sessionId",
            "requestId",
            "codexTurnId",
            "mode",
            "createdAt",
        ],
        "operation" => &[
            "requestId",
            "commandId",
            "operation",
            "sessionId",
            "turnId",
            "status",
            "createdAt",
            "error",
            "fingerprint",
        ],
        "meta" if id == "owner" => &["pid"],
        "interaction" => &[],
        _ => anyhow::bail!(INVALID_STATE),
    })
}

fn text(value: &Value) -> bool {
    value.as_str().is_some_and(|v| !v.trim().is_empty())
}

fn nullable_text(value: &Value) -> bool {
    value.is_null() || text(value)
}

fn object_fields(value: &Value, allowed: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.keys().all(|key| allowed.contains(&key.as_str()))
            && allowed
                .iter()
                .all(|key| optional.contains(key) || object.contains_key(*key))
    })
}

fn valid_config(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let resolved = &value["resolved"];
    let sandbox = &resolved["sandbox"];
    object_fields(value, &["resolved"], &[])
        && object_fields(
            resolved,
            &[
                "model",
                "modelProvider",
                "reasoningEffort",
                "developerInstructions",
                "approvalPolicy",
                "approvalsReviewer",
                "sandbox",
            ],
            &[],
        )
        && text(&resolved["model"])
        && text(&resolved["modelProvider"])
        && nullable_text(&resolved["reasoningEffort"])
        && resolved["developerInstructions"].is_string()
        && resolved["approvalPolicy"] == "on-request"
        && resolved["approvalsReviewer"] == "user"
        && object_fields(
            sandbox,
            &[
                "type",
                "writableRoots",
                "networkAccess",
                "excludeTmpdirEnvVar",
                "excludeSlashTmp",
            ],
            &[],
        )
        && sandbox["type"] == "workspaceWrite"
        && sandbox["writableRoots"]
            .as_array()
            .is_some_and(|roots| roots.iter().all(text))
        && ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]
            .iter()
            .all(|key| sandbox[*key].is_boolean())
}

fn validate_record(kind: &str, id: &str, value: &Value) -> anyhow::Result<()> {
    let allowed = fields(kind, id)?;
    if kind == "meta" && value.is_null() {
        return Ok(());
    }
    // An absent native acknowledgement must remain recoverable as unknown delivery.
    let optional: &[&str] = if kind == "turn" {
        &["codexTurnId"]
    } else {
        &[]
    };
    anyhow::ensure!(
        !id.trim().is_empty() && !allowed.is_empty() && object_fields(value, allowed, optional),
        INVALID_STATE
    );
    let valid = match kind {
        "session" => {
            value["sessionId"] == id
                && text(&value["workDir"])
                && nullable_text(&value["codexThreadId"])
                && nullable_text(&value["activeTurnId"])
                && nullable_text(&value["createdAt"])
                && valid_config(&value["sessionConfig"])
        }
        "turn" => {
            value["turnId"] == id
                && ["sessionId", "requestId", "createdAt"]
                    .iter()
                    .all(|key| text(&value[*key]))
                && nullable_text(&value["codexTurnId"])
                && matches!(value["mode"].as_str(), Some("default" | "plan"))
        }
        "operation" => {
            value["requestId"] == id
                && ["commandId", "sessionId", "createdAt"]
                    .iter()
                    .all(|key| text(&value[*key]))
                && nullable_text(&value["turnId"])
                && matches!(
                    value["operation"].as_str(),
                    Some(
                        "createSession"
                            | "connectSession"
                            | "sendMessage"
                            | "steerTurn"
                            | "answerQuestions"
                            | "decideApproval"
                            | "interruptTurn"
                    )
                )
                && matches!(
                    value["status"].as_str(),
                    Some("accepted" | "delivered" | "error" | "unknown")
                )
                && value["fingerprint"].as_str().is_some_and(|fingerprint| {
                    fingerprint.len() == 64
                        && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                && (value["error"].is_null()
                    || serde_json::from_value::<dewbow_protocol::ManagementError>(
                        value["error"].clone(),
                    )
                    .is_ok())
        }
        "meta" => value["pid"]
            .as_u64()
            .is_some_and(|pid| pid > 0 && u32::try_from(pid).is_ok()),
        _ => false,
    };
    anyhow::ensure!(valid, INVALID_STATE);
    Ok(())
}

/// Inspect the entire persisted format before initialization, PRAGMAs or writeback.
fn read_records(db: &Connection) -> anyhow::Result<Option<Records>> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let objects = {
        let mut statement = db.prepare(
            "SELECT type,name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if version == 0 && objects.is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        version == 1 && objects == [("table".into(), "records".into())],
        INVALID_STATE
    );
    let columns = {
        let mut statement = db.prepare("PRAGMA table_info(records)")?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, u32>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    anyhow::ensure!(
        columns
            == [
                ("kind".into(), "TEXT".into(), 1, None, 1),
                ("id".into(), "TEXT".into(), 1, None, 2),
                ("data".into(), "TEXT".into(), 1, None, 0),
            ],
        INVALID_STATE
    );
    let mut statement = db.prepare("SELECT kind,id,data FROM records")?;
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .map(|row| {
            let (kind, id, raw) = row?;
            let value = serde_json::from_str(&raw).map_err(|_| anyhow::anyhow!(INVALID_STATE))?;
            validate_record(&kind, &id, &value)?;
            Ok(((kind, id), value))
        })
        .collect::<anyhow::Result<Records>>()
        .map(Some)
}

/// The caller must hold the daemon lock and verify both owned processes have exited.
pub fn checkpoint_for_upgrade(state: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        !state.join("content.sqlite").exists(),
        "Obsolete storage requires an explicit state reset before upgrading"
    );
    let path = state.join("daemon.sqlite");
    for name in ["daemon.sqlite", "daemon.sqlite-wal", "daemon.sqlite-shm"] {
        let file = state.join(name);
        dewbow_sdk::private::no_links(&file)?;
        if file.exists() {
            dewbow_sdk::private::regular(&file)?;
        }
    }
    if !path.exists() {
        return Ok(());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    anyhow::ensure!(read_records(&db)?.is_some(), INVALID_STATE);
    let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    anyhow::ensure!(
        integrity == "ok",
        "Management state failed its integrity check"
    );
    let (busy, remaining): (u32, i64) =
        db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    anyhow::ensure!(
        busy == 0 && remaining == 0,
        "Management state could not be checkpointed"
    );
    Ok(())
}

pub struct Store {
    journal: Mutex<Connection>,
    records: Mutex<Records>,
    events: Mutex<Events>,
}
impl Store {
    pub fn open(state: &Path) -> anyhow::Result<Self> {
        dewbow_sdk::private::no_links(&state.join("daemon.sqlite"))?;
        anyhow::ensure!(
            !state.join("content.sqlite").exists(),
            "RECOVERY_REQUIRED: obsolete Dewbow storage; stop its daemon and native runtime, preserve the old state, and initialize a fresh state directory"
        );
        let mut journal = Connection::open(state.join("daemon.sqlite"))?;
        let existing = read_records(&journal)?;
        journal.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        if existing.is_none() {
            let transaction = journal.transaction()?;
            transaction.execute_batch("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;")?;
            transaction.commit()?;
        }
        let records = existing.unwrap_or_default();
        Ok(Self {
            journal: Mutex::new(journal),
            records: Mutex::new(records),
            events: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn put(&self, kind: &str, id: &str, value: &Value) -> anyhow::Result<()> {
        // Project an explicit allowlist. Runtime presentation and callbacks never reach SQLite.
        let fields = fields(kind, id)?;
        if !fields.is_empty() {
            let mut saved = if value.is_null() {
                Value::Null
            } else {
                json!({})
            };
            for field in fields {
                if let Some(v) = value.get(*field) {
                    saved[*field] = v.clone();
                }
            }
            if kind == "session" && !saved["sessionConfig"].is_null() {
                saved["sessionConfig"] = json!({"resolved":saved["sessionConfig"]["resolved"]});
            }
            validate_record(kind, id, &saved)?;
            let mut db = self.journal.lock().unwrap();
            let transaction = db.transaction()?;
            transaction.execute("INSERT INTO records VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", rusqlite::params![kind,id,saved.to_string()])?;
            if kind == "session" {
                // Only the active/unresolved turn is durable. Its removal and the session update are atomic.
                transaction.execute("DELETE FROM records WHERE kind='turn' AND json_extract(data,'$.sessionId')=?1 AND (?2 IS NULL OR id<>?2)", rusqlite::params![id,value["activeTurnId"].as_str()])?;
            }
            transaction.commit()?;
        }
        self.records
            .lock()
            .unwrap()
            .insert((kind.into(), id.into()), value.clone());
        Ok(())
    }
    pub fn get(&self, kind: &str, id: &str) -> anyhow::Result<Option<Value>> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .get(&(kind.into(), id.into()))
            .cloned())
    }
    pub fn list(&self, kind: &str) -> anyhow::Result<Vec<Value>> {
        let mut rows = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|((k, _), _)| k == kind)
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
        Ok(rows)
    }
    pub fn event(&self, session: &str, value: &Value) -> anyhow::Result<u64> {
        let mut events = self.events.lock().unwrap();
        let (cursor, rows) = events.entry(session.into()).or_default();
        *cursor += 1;
        let mut event = value.clone();
        event["cursor"] = json!(*cursor);
        if let Some(interaction) = event["payload"]["interaction"].as_object_mut() {
            interaction.remove("details");
        }
        rows.push_back(event);
        while rows.len() > 512 {
            rows.pop_front();
        }
        Ok(*cursor)
    }
    pub fn events(&self, session: &str, cursor: u64) -> anyhow::Result<Vec<Value>> {
        let events = self.events.lock().unwrap();
        let Some((_, rows)) = events.get(session) else {
            return Ok(Vec::new());
        };
        let mut result = Vec::new();
        if let Some(first) = rows.front().and_then(|r| r["cursor"].as_u64())
            && cursor > 0
            && first > cursor.saturating_add(1)
        {
            result.push(json!({"eventId":dewbow_protocol::id(),"cursor":first-1,"sessionId":session,"turnId":null,"timestamp":dewbow_protocol::now(),"type":"history_gap","payload":{"fromCursor":cursor+1,"toCursor":first-1}}));
        }
        result.extend(
            rows.iter()
                .filter(|r| r["cursor"].as_u64().unwrap() > cursor)
                .cloned(),
        );
        Ok(result.into_iter().take(501).collect())
    }
    pub fn forget_interactions(&self, session: &str) {
        self.records
            .lock()
            .unwrap()
            .retain(|(kind, _), value| kind != "interaction" || value["sessionId"] != session);
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    fn receipt() -> Value {
        json!({"requestId":"synthetic-request","commandId":"synthetic-command","operation":"sendMessage",
            "sessionId":"synthetic-session","turnId":"synthetic-turn","status":"unknown",
            "createdAt":"synthetic-time","error":null,"fingerprint":"a".repeat(64)})
    }

    fn session() -> Value {
        json!({"sessionId":"synthetic-session","codexThreadId":"synthetic-native-thread",
            "workDir":"/synthetic/work","activeTurnId":"synthetic-turn","createdAt":null,
            "sessionConfig":{"resolved":{"model":"synthetic-model","modelProvider":"synthetic-provider",
                "reasoningEffort":null,"developerInstructions":"synthetic instructions",
                "approvalPolicy":"on-request","approvalsReviewer":"user",
                "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,
                    "excludeTmpdirEnvVar":false,"excludeSlashTmp":false}}}})
    }

    fn temporary_state() -> std::path::PathBuf {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-storage-test-{}", dewbow_protocol::id()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    fn assert_rejected_unchanged(root: &Path) {
        let path = root.join("daemon.sqlite");
        let before = std::fs::read(&path).unwrap();
        let cause = Store::open(root)
            .err()
            .expect("Invalid state must be rejected");
        assert!(cause.to_string().contains("RECOVERY_REQUIRED"));
        assert!(!cause.to_string().contains("PRIVATE_SYNTHETIC"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!root.join("daemon.sqlite-wal").exists());
    }

    #[test]
    fn startup_rejects_unknown_versions_and_malformed_records_without_writes() {
        for version in [-1, 1, 2, 99] {
            let root = temporary_state();
            let db = Connection::open(root.join("daemon.sqlite")).unwrap();
            db.pragma_update(None, "user_version", version).unwrap();
            drop(db);
            assert_rejected_unchanged(&root);
            std::fs::remove_dir_all(root).unwrap();
        }
        let mut missing_id = session();
        missing_id.as_object_mut().unwrap().remove("sessionId");
        let mut unknown_field = session();
        unknown_field["futureField"] = json!("PRIVATE_SYNTHETIC");
        let mut invalid_config = session();
        invalid_config["sessionConfig"]["resolved"]["sandbox"]["networkAccess"] = json!("invalid");
        let mut missing_config = session();
        missing_config
            .as_object_mut()
            .unwrap()
            .remove("sessionConfig");
        let mut unknown_nested_field = session();
        unknown_nested_field["sessionConfig"]["futureField"] = json!(true);
        let mut wrong_request = receipt();
        wrong_request["requestId"] = json!("another-request");
        let mut invalid_status = receipt();
        invalid_status["status"] = json!("finished");
        for (kind, id, raw) in [
            ("session", "synthetic-session", missing_id.to_string()),
            ("session", "synthetic-session", unknown_field.to_string()),
            ("session", "synthetic-session", invalid_config.to_string()),
            ("session", "synthetic-session", missing_config.to_string()),
            (
                "session",
                "synthetic-session",
                unknown_nested_field.to_string(),
            ),
            ("operation", "synthetic-request", wrong_request.to_string()),
            ("operation", "synthetic-request", invalid_status.to_string()),
            ("turn", "synthetic-turn", "null".into()),
            ("meta", "owner", json!({"pid":u64::MAX}).to_string()),
            (
                "session",
                "synthetic-session",
                "PRIVATE_SYNTHETIC invalid JSON".into(),
            ),
        ] {
            let root = temporary_state();
            drop(Store::open(&root).unwrap());
            let db = Connection::open(root.join("daemon.sqlite")).unwrap();
            db.pragma_update(None, "journal_mode", "DELETE").unwrap();
            db.execute(
                "INSERT INTO records VALUES(?,?,?)",
                rusqlite::params![kind, id, raw],
            )
            .unwrap();
            drop(db);
            assert_rejected_unchanged(&root);
            assert!(checkpoint_for_upgrade(&root).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
        let root = temporary_state();
        let db = Connection::open(root.join("daemon.sqlite")).unwrap();
        db.execute_batch(
            "PRAGMA user_version=1; CREATE TABLE records(kind TEXT,id TEXT,data TEXT);",
        )
        .unwrap();
        drop(db);
        assert_rejected_unchanged(&root);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validated_state_preserves_frozen_configuration_and_uncertain_receipts() {
        let root = temporary_state();
        let store = Store::open(&root).unwrap();
        let pending = json!({"turnId":"synthetic-turn","sessionId":"synthetic-session",
            "requestId":"synthetic-request","mode":"default","createdAt":"synthetic-time"});
        store
            .put("session", "synthetic-session", &session())
            .unwrap();
        store
            .put("operation", "synthetic-request", &receipt())
            .unwrap();
        store.put("turn", "synthetic-turn", &pending).unwrap();
        drop(store);
        let store = Store::open(&root).unwrap();
        assert_eq!(
            store.get("session", "synthetic-session").unwrap(),
            Some(session())
        );
        assert_eq!(
            store.get("operation", "synthetic-request").unwrap(),
            Some(receipt())
        );
        assert_eq!(store.get("turn", "synthetic-turn").unwrap(), Some(pending));
        drop(store);
        checkpoint_for_upgrade(&root).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upgrade_checkpoint_preserves_committed_wal_and_refuses_an_active_writer() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-checkpoint-test-{}", dewbow_protocol::id()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("daemon.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));").unwrap();
        db.execute(
            "INSERT INTO records VALUES('operation','synthetic-request',?)",
            [receipt().to_string()],
        )
        .unwrap();
        assert!(root.join("daemon.sqlite-wal").metadata().unwrap().len() > 0);
        checkpoint_for_upgrade(&root).unwrap();
        std::fs::copy(&path, root.join("snapshot.sqlite")).unwrap();
        let snapshot = Connection::open(root.join("snapshot.sqlite")).unwrap();
        assert_eq!(
            snapshot
                .query_row("SELECT data FROM records", [], |r| r.get::<_, String>(0))
                .unwrap(),
            receipt().to_string()
        );
        drop(snapshot);
        db.execute_batch(
            "BEGIN IMMEDIATE; INSERT INTO records VALUES('operation','unfinished','null');",
        )
        .unwrap();
        assert!(checkpoint_for_upgrade(&root).is_err());
        db.execute_batch("ROLLBACK").unwrap();
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn upgrade_rejects_live_native_ownership_without_reinitializing_storage() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-owner-test-{}", dewbow_protocol::id()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("daemon.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE records(kind TEXT,id TEXT,data TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO records VALUES('meta','owner',?)",
            [json!({"pid":std::process::id()}).to_string()],
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(verify_runtime_stopped(&root).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!root.join("content.sqlite").exists());
        let db = Connection::open(&path).unwrap();
        db.execute("UPDATE records SET data='null'", []).unwrap();
        drop(db);
        verify_runtime_stopped(&root).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
