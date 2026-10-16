use rusqlite::Connection;

pub const VERSION: i64 = 2;
pub const RECORDS_SQL: &str = "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));";
pub const SQL: &str = include_str!("schema.sql");

fn objects(db: &Connection) -> anyhow::Result<Vec<(String, String, String)>> {
    Ok(db
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Compare the actual DDL, including checks, indexes and references, before writes.
pub fn inspect(db: &Connection) -> anyhow::Result<i64> {
    let version = db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?;
    let actual = objects(db)?;
    if version == 0 && actual.is_empty() {
        return Ok(0);
    }
    anyhow::ensure!(
        matches!(version, 1 | VERSION),
        super::super::store::INVALID_STATE
    );
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(RECORDS_SQL)?;
    if version == VERSION {
        expected.execute_batch(SQL)?;
    }
    anyhow::ensure!(
        actual == objects(&expected)?,
        super::super::store::INVALID_STATE
    );
    if version == VERSION {
        let broken: bool = db.prepare("PRAGMA foreign_key_check")?.exists([])?;
        anyhow::ensure!(!broken, super::super::store::INVALID_STATE);
        let settings: i64 = db.query_row(
            "SELECT count(*) FROM network_settings WHERE singleton_id=1",
            [],
            |r| r.get(0),
        )?;
        anyhow::ensure!(settings == 1, super::super::store::INVALID_STATE);
    }
    Ok(version)
}
