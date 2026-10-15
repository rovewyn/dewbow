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
        let journal = Connection::open(state.join("daemon.sqlite"))?;
        let existing: bool = journal.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='records')",
            [],
            |r| r.get(0),
        )?;
        let version: u32 = journal.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let obsolete: bool = journal.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name<>'records')",
            [],
            |r| r.get(0),
        )?;
        anyhow::ensure!(
            !obsolete && (!existing || version == 1),
            "RECOVERY_REQUIRED: obsolete Dewbow storage; stop its daemon and native runtime, preserve the old state, and initialize a fresh state directory"
        );
        journal.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;")?;
        let records = {
            let mut statement = journal.prepare("SELECT kind,id,data FROM records")?;
            statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .map(|row| {
                    let (kind, id, raw) = row?;
                    Ok(((kind, id), serde_json::from_str(&raw)?))
                })
                .collect::<anyhow::Result<Records>>()?
        };
        Ok(Self {
            journal: Mutex::new(journal),
            records: Mutex::new(records),
            events: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn put(&self, kind: &str, id: &str, value: &Value) -> anyhow::Result<()> {
        // Project an explicit allowlist. Runtime presentation and callbacks never reach SQLite.
        let fields: &[&str] = match kind {
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
            _ => anyhow::bail!("Unsupported management record"),
        };
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
