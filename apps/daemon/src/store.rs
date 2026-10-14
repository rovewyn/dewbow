use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{path::Path, sync::Mutex};

pub struct Store {
    journal: Mutex<Connection>,
    content: Mutex<Connection>,
}
impl Store {
    pub fn open(state: &Path) -> anyhow::Result<Self> {
        for name in ["daemon.sqlite", "content.sqlite"] {
            dewbow_sdk::private::no_links(&state.join(name))?;
        }
        let journal = Connection::open(state.join("daemon.sqlite"))?;
        journal.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_session ON events(session_id,cursor);")?;
        let content = Connection::open(state.join("content.sqlite"))?;
        content.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS contents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,item_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,complete INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS content_chunks(content_id TEXT NOT NULL,byte_offset INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(content_id,byte_offset));")?;
        Ok(Self {
            journal: Mutex::new(journal),
            content: Mutex::new(content),
        })
    }
    pub fn put(&self, kind: &str, id: &str, value: &Value) -> anyhow::Result<()> {
        self.journal.lock().unwrap().execute("INSERT INTO records VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",rusqlite::params![kind,id,value.to_string()])?;
        Ok(())
    }
    pub fn get(&self, kind: &str, id: &str) -> anyhow::Result<Option<Value>> {
        let raw: Option<String> = self
            .journal
            .lock()
            .unwrap()
            .query_row(
                "SELECT data FROM records WHERE kind=? AND id=?",
                [kind, id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|r| serde_json::from_str(&r).map_err(Into::into))
            .transpose()
    }
    pub fn list(&self, kind: &str) -> anyhow::Result<Vec<Value>> {
        let db = self.journal.lock().unwrap();
        let mut statement = db.prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")?;
        let rows = statement
            .query_map([kind], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|r| serde_json::from_str(&r).map_err(Into::into))
            .collect()
    }
    pub fn event(&self, session: &str, value: &Value) -> anyhow::Result<u64> {
        let db = self.journal.lock().unwrap();
        let mut metadata = value.clone();
        if let Some(payload) = metadata["payload"].as_object_mut() {
            for key in ["text", "details", "activity", "delta"] {
                payload.remove(key);
            }
        }
        db.execute(
            "INSERT INTO events(session_id,data) VALUES(?,?)",
            rusqlite::params![session, metadata.to_string()],
        )?;
        Ok(db.last_insert_rowid() as u64)
    }
    pub fn events(&self, session: &str, cursor: u64) -> anyhow::Result<Vec<Value>> {
        let db = self.journal.lock().unwrap();
        let mut statement=db.prepare("SELECT cursor,data FROM events WHERE session_id=? AND cursor>? ORDER BY cursor LIMIT 501")?;
        let rows = statement
            .query_map(rusqlite::params![session, cursor as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(cursor, raw)| {
                let mut value: Value = serde_json::from_str(&raw)?;
                value["cursor"] = serde_json::json!(cursor);
                Ok(value)
            })
            .collect()
    }
    pub fn save_content(
        &self,
        session: &str,
        item: &str,
        kind: &str,
        body: &str,
        complete: bool,
    ) -> anyhow::Result<String> {
        use sha2::{Digest, Sha256};
        let id = dewbow_protocol::hex(&Sha256::digest(
            format!("{session}:{item}:{kind}").as_bytes(),
        ));
        self.content.lock().unwrap().execute("INSERT INTO contents VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET body=excluded.body,complete=excluded.complete",rusqlite::params![id,session,item,kind,body,complete])?;
        Ok(id)
    }
    pub fn append_output(&self, session: &str, item: &str, delta: &str) -> anyhow::Result<()> {
        use sha2::{Digest, Sha256};
        if delta.is_empty() {
            return Ok(());
        }
        let id = dewbow_protocol::hex(&Sha256::digest(
            format!("{session}:{item}:output").as_bytes(),
        ));
        let mut db = self.content.lock().unwrap();
        let transaction = db.transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO contents VALUES(?1,?2,?3,'output','',0)",
            rusqlite::params![id, session, item],
        )?;
        let offset:i64=transaction.query_row("SELECT COALESCE(MAX(byte_offset+length(body)),0) FROM content_chunks WHERE content_id=?",[&id],|r|r.get(0))?;
        anyhow::ensure!(
            offset as usize + delta.len() <= 64 * 1024 * 1024,
            "Output capture capacity exceeded"
        );
        transaction.execute(
            "INSERT INTO content_chunks VALUES(?1,?2,?3)",
            rusqlite::params![id, offset, delta.as_bytes()],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn content_meta(
        &self,
        session: &str,
        item: &str,
    ) -> anyhow::Result<Option<(String, usize, bool, bool)>> {
        Ok(self.content.lock().unwrap().query_row("SELECT id,CASE WHEN EXISTS(SELECT 1 FROM content_chunks WHERE content_id=contents.id) THEN (SELECT MAX(byte_offset+length(body)) FROM content_chunks WHERE content_id=contents.id) ELSE length(CAST(body AS BLOB)) END,complete,EXISTS(SELECT 1 FROM content_chunks WHERE content_id=contents.id) FROM contents WHERE session_id=? AND item_id=? AND kind='output'",[session,item],|r|Ok((r.get(0)?,r.get::<_,i64>(1)? as usize,r.get(2)?,r.get(3)?))).optional()?)
    }
    pub fn finish_capture(&self, id: &str) -> anyhow::Result<()> {
        self.content
            .lock()
            .unwrap()
            .execute("UPDATE contents SET complete=1 WHERE id=?", [id])?;
        Ok(())
    }
    pub fn chunk(
        &self,
        session: &str,
        id: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<(String, usize, bool)> {
        let db = self.content.lock().unwrap();
        let (bytes,complete,captured):(i64,bool,bool)=db.query_row("SELECT CASE WHEN EXISTS(SELECT 1 FROM content_chunks WHERE content_id=contents.id) THEN (SELECT MAX(byte_offset+length(body)) FROM content_chunks WHERE content_id=contents.id) ELSE length(CAST(body AS BLOB)) END,complete,EXISTS(SELECT 1 FROM content_chunks WHERE content_id=contents.id) FROM contents WHERE session_id=? AND id=?",[session,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||dewbow_protocol::error("NOT_FOUND","Content is unavailable for this conversation."))?;
        anyhow::ensure!(
            cursor <= bytes as usize,
            dewbow_protocol::error("INVALID_INPUT", "Content cursor exceeds the output.")
        );
        let end = (cursor + limit).min(bytes as usize);
        let mut buffer = Vec::new();
        if captured {
            let mut statement=db.prepare("SELECT substr(body,max(?2-byte_offset,0)+1,?3-max(?2,byte_offset)) FROM content_chunks WHERE content_id=?1 AND byte_offset+length(body)>?2 AND byte_offset<?3 ORDER BY byte_offset")?;
            for bytes in statement
                .query_map(rusqlite::params![id, cursor as i64, end as i64], |r| {
                    r.get::<_, Vec<u8>>(0)
                })?
            {
                buffer.extend(bytes?);
            }
        } else {
            buffer = db.query_row(
                "SELECT substr(CAST(body AS BLOB),?2+1,?3) FROM contents WHERE id=?1",
                rusqlite::params![id, cursor as i64, (end - cursor) as i64],
                |r| r.get(0),
            )?;
        }
        match std::str::from_utf8(&buffer) {
            Ok(_) => {}
            Err(cause) => {
                anyhow::ensure!(
                    cause.error_len().is_none() && cause.valid_up_to() > 0,
                    dewbow_protocol::error(
                        "INVALID_INPUT",
                        "Content cursor is not a UTF-8 boundary."
                    )
                );
                buffer.truncate(cause.valid_up_to());
            }
        }
        Ok((String::from_utf8(buffer)?, bytes as usize, complete))
    }
    pub fn content(&self, session: &str, id: &str) -> anyhow::Result<Option<(String, bool)>> {
        Ok(self
            .content
            .lock()
            .unwrap()
            .query_row(
                "SELECT body,complete FROM contents WHERE session_id=? AND id=?",
                [session, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
}
