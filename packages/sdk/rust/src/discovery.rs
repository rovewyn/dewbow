use crate::{Runtime, private};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::Path,
};

pub fn database(home: &Path, prefix: &str) -> anyhow::Result<Connection> {
    private::no_links(home)?;
    let path = fs::read_dir(home)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix(prefix)?
                .strip_suffix(".sqlite")?
                .parse::<u64>()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .ok_or_else(|| anyhow::anyhow!("Native database is unavailable"))?
        .1;
    private::regular(&path)?;
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(std::time::Duration::from_secs(1))?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    Ok(db)
}
fn timestamp(value: &Value) -> Value {
    value
        .as_i64()
        .and_then(|v| {
            chrono::DateTime::from_timestamp(if v > 10_000_000_000 { v / 1000 } else { v }, 0)
        })
        .map(|v| json!(v.to_rfc3339()))
        .unwrap_or(Value::Null)
}
pub fn native(row: &Value, home: &Path) -> Value {
    let source = row.get("source").cloned().unwrap_or(Value::Null);
    let source = if let Some(s) = source.as_str() {
        serde_json::from_str::<Value>(s).unwrap_or(source.clone())
    } else {
        source
    };
    let parent = row
        .get("parentThreadId")
        .or_else(|| source.pointer("/subagent/thread_spawn/parent_thread_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let id = row["id"].as_str().unwrap_or("");
    let name = ["name", "title", "agent_nickname"]
        .iter()
        .find_map(|key| row[key].as_str().filter(|s| !s.is_empty()))
        .unwrap_or(id);
    json!({"id":id,"codexHome":home,"name":name,"workDir":row.get("cwd").unwrap_or(&Value::Null),
        "createdAt":timestamp(row.get("createdAt").or_else(|| row.get("created_at_ms")).or_else(|| row.get("created_at")).unwrap_or(&Value::Null)),
        "updatedAt":timestamp(row.get("updatedAt").or_else(|| row.get("updated_at_ms")).or_else(|| row.get("updated_at")).unwrap_or(&Value::Null)),
        "archived":row.get("archived").map(|v| if v.is_boolean() { v.clone() } else {json!(v.as_i64()==Some(1))}).unwrap_or(Value::Null),
        "kind":if !parent.is_null() || source.get("subagent").is_some() {"child_session"} else {"session"},"parentId":parent,
        "forkedFromId":row.get("forkedFromId").unwrap_or(&Value::Null),
        "runtimeStatus":row.pointer("/status/type").unwrap_or(&json!("unknown")),"hasActiveWriter":null})
}
pub async fn discover(runtime: &Runtime, home: &Path, executable: &Path) -> Value {
    let mut sessions = BTreeMap::<String, Value>::new();
    let mut sources = Vec::new();
    let read = || -> anyhow::Result<Vec<Value>> {
        let db = database(home, "state_")?;
        let columns: Vec<String> = db
            .prepare("SELECT name FROM pragma_table_info('threads')")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        anyhow::ensure!(
            columns.iter().any(|s| s == "id"),
            "Unsupported native schema"
        );
        let fields: Vec<&str> = [
            "id",
            "name",
            "title",
            "agent_nickname",
            "cwd",
            "source",
            "created_at",
            "updated_at",
            "created_at_ms",
            "updated_at_ms",
            "archived",
        ]
        .into_iter()
        .filter(|field| columns.iter().any(|s| s == field))
        .collect();
        let sql = format!(
            "SELECT {} FROM threads LIMIT 10001",
            fields
                .iter()
                .map(|s| format!("substr(\"{s}\",1,8192) AS \"{s}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut statement = db.prepare(&sql)?;
        let rows = statement
            .query_map([], |r| {
                let mut row = serde_json::Map::new();
                for (i, field) in fields.iter().enumerate() {
                    let value = match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Text(s) => {
                            let s = String::from_utf8_lossy(s);
                            if field.ends_with("_at")
                                || field.ends_with("_ms")
                                || *field == "archived"
                            {
                                s.parse::<i64>().map(|v| json!(v)).unwrap_or(json!(s))
                            } else {
                                json!(s)
                            }
                        }
                        _ => Value::Null,
                    };
                    row.insert(field.to_string(), value);
                }
                Ok(Value::Object(row))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        anyhow::ensure!(rows.len() <= 10000, "Native inventory exceeds capacity");
        if db
            .prepare("SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges LIMIT 10000")
            .is_ok()
        {
            let edges = db
                .prepare(
                    "SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges LIMIT 10000",
                )?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            return Ok(rows
                .into_iter()
                .map(|mut row| {
                    if let Some(parent) = edges.get(row["id"].as_str().unwrap_or("")) {
                        row["parentThreadId"] = json!(parent);
                    }
                    row
                })
                .collect());
        }
        Ok(rows)
    };
    match read() {
        Ok(rows) => { for row in rows { if uuid::Uuid::parse_str(row["id"].as_str().unwrap_or("")).is_ok() { let value=native(&row,home); sessions.insert(value["id"].as_str().unwrap().into(),value); } } sources.push(json!({"source":"database","state":"success","error":null})); }
        Err(_) => sources.push(json!({"source":"database","state":"unavailable","error":"Native database inspection unavailable."})),
    }
    let mut api_ok = true;
    for archived in [false, true] {
        let mut cursor = Value::Null;
        for _ in 0..100 {
            match runtime.request("thread/list",json!({"limit":100,"cursor":cursor,"archived":archived,"sourceKinds":[],"useStateDbOnly":true})).await {
                Ok(page) => { if let Some(rows)=page["data"].as_array() { for row in rows { let mut value=native(row,home); value["archived"]=json!(archived); let key=value["id"].as_str().unwrap_or("").to_string(); if let Some(saved)=sessions.get(&key) { for field in ["parentId","forkedFromId"] { if value[field].is_null() { value[field]=saved[field].clone(); } } } sessions.insert(key,value); } }
                    cursor=page["nextCursor"].clone(); if cursor.is_null() {break;} }
                Err(_) => {api_ok=false;break;}
            }
        }
    }
    sources.push(json!({"source":"app-server","state":if api_ok {"success"} else {"partial"},"error":if api_ok {Value::Null} else {json!("Native inventory API unavailable.")}}));
    // Read only first metadata records for missing parent/fork relationships.
    for root in [home.join("sessions"), home.join("archived_sessions")] {
        let mut paths = vec![root];
        let mut visited = 0;
        while let Some(path) = paths.pop() {
            visited += 1;
            if visited > 30000 {
                break;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if private::no_links(&path).is_ok()
                    && let Ok(entries) = fs::read_dir(path)
                {
                    paths.extend(entries.filter_map(Result::ok).map(|e| e.path()));
                }
                continue;
            }
            if path.extension().is_none_or(|e| e != "jsonl") || private::regular(&path).is_err() {
                continue;
            }
            let Ok(file) = fs::File::open(&path) else {
                continue;
            };
            let mut header = Vec::new();
            let mut reader = std::io::Read::take(BufReader::new(file), 1_048_577);
            if reader.read_until(b'\n', &mut header).is_err() || header.len() > 1_048_576 {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&header) else {
                continue;
            };
            if value["type"] != "session_meta" {
                continue;
            }
            let row = &value["payload"];
            let key = row["id"].as_str().unwrap_or("");
            if let Some(session) = sessions.get_mut(key) {
                if session["parentId"].is_null() {
                    session["parentId"] = row
                        .get("parent_thread_id")
                        .or_else(|| row.pointer("/source/subagent/thread_spawn/parent_thread_id"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                if session["forkedFromId"].is_null() {
                    session["forkedFromId"] =
                        row.get("forked_from_id").cloned().unwrap_or(Value::Null);
                }
            }
        }
    }
    sources.push(json!({"source":"lineage","state":"success","error":null}));
    crate::observations::augment(&mut sessions, &mut sources, executable, home).await;
    for session in sessions.values_mut() {
        if !session["parentId"].is_null() {
            session["kind"] = json!("child_session");
        }
    }
    json!({"sessions":sessions.into_values().collect::<Vec<_>>(),"sources":sources,"observedAt":dewbow_protocol::now(),"nextCursor":null})
}
