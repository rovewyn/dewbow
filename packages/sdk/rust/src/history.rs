use crate::discovery::database;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use dewbow_protocol::{ManagementError, error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

fn scope(home: &Path, thread: &str) -> String {
    dewbow_protocol::hex(&Sha256::digest(
        format!("{}:{thread}", home.display()).as_bytes(),
    ))
}
pub fn persisted_items(
    home: &Path,
    thread: &str,
    ids: &[String],
) -> anyhow::Result<std::collections::HashSet<String>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    anyhow::ensure!(ids.len() <= 1000, "Live item capacity exceeded");
    let db = database(home, "thread_history_")?;
    let sql = format!(
        "SELECT item_id FROM thread_items WHERE thread_id=? AND completed_at_ms IS NOT NULL AND item_id IN ({})",
        vec!["?"; ids.len()].join(",")
    );
    let mut query = db.prepare(&sql)?;
    let params = std::iter::once(thread).chain(ids.iter().map(String::as_str));
    Ok(query
        .query_map(rusqlite::params_from_iter(params), |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}
pub fn read(home: &Path, thread: &str, input: &Value) -> Result<Value, ManagementError> {
    let limit = input["limit"].as_u64().unwrap_or(50);
    if !(1..=500).contains(&limit) {
        return Err(error("INVALID_INPUT", "History limit must be 1 to 500."));
    }
    let cursors = ["beforeCursor", "afterCursor", "updateCursor"]
        .into_iter()
        .filter(|key| input.get(key).is_some_and(|v| !v.is_null()))
        .collect::<Vec<_>>();
    if cursors.len() > 1 {
        return Err(error("INVALID_INPUT", "Choose one native cursor."));
    }
    let direction = cursors.first().copied().unwrap_or("beforeCursor");
    let scoped = scope(home, thread);
    let mut ordinal = None;
    let mut anchor = String::new();
    if let Some(key) = cursors.first() {
        let parsed = input[*key]
            .as_str()
            .filter(|s| s.len() <= 1024)
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
            .filter(|v| v["scope"] == scoped && v["direction"] == direction);
        let parsed = parsed
            .ok_or_else(|| error("INVALID_INPUT", "Invalid native cursor scope or direction."))?;
        ordinal = Some(
            parsed["ordinal"]
                .as_i64()
                .filter(|n| *n >= 0)
                .ok_or_else(|| error("INVALID_INPUT", "Invalid native cursor ordinal."))?,
        );
        anchor = parsed["id"]
            .as_str()
            .filter(|s| s.len() <= 384)
            .ok_or_else(|| error("INVALID_INPUT", "Invalid native cursor item."))?
            .into();
    }
    let encode = |n: i64, id: &str, dir: &str| {
        URL_SAFE_NO_PAD
            .encode(json!({"scope":scoped,"ordinal":n,"id":id,"direction":dir}).to_string())
    };
    let query = || -> anyhow::Result<Value> {
        let db = database(home, "thread_history_")?;
        db.execute_batch("BEGIN")?;
        let order = "CASE WHEN i.completed_at_ms IS NOT NULL AND (i.item_type='plan' OR (i.item_type='agentMessage' AND json_valid(i.item_json) AND json_extract(i.item_json,'$.phase')='final_answer')) THEN i.updated_at_ordinal ELSE i.rollout_ordinal END";
        let page_order = if direction == "updateCursor" {
            "i.updated_at_ordinal"
        } else {
            order
        };
        let before = direction == "beforeCursor";
        let comparison = if before { "<" } else { ">" };
        let sorting = if before { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT i.item_id,i.turn_id,{order},i.updated_at_ordinal,i.created_at_ms,i.completed_at_ms,CASE WHEN length(CAST(i.item_json AS BLOB))<=8388608 THEN i.item_json ELSE NULL END,t.status FROM thread_items i LEFT JOIN thread_turns t ON i.thread_id=t.thread_id AND i.turn_id=t.turn_id WHERE i.thread_id=?1 AND i.item_type<>'reasoning' AND (?2 IS NULL OR {page_order} {comparison} ?2 OR ({page_order}=?2 AND i.item_id {comparison} ?3)) ORDER BY {page_order} {sorting},i.item_id {sorting} LIMIT ?4"
        );
        let mut statement = db.prepare(&sql)?;
        let mut records=statement.query_map(rusqlite::params![thread,ordinal,anchor,limit as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"turnId":r.get::<_,String>(1)?,"ordinal":r.get::<_,i64>(2)?,"updatedOrdinal":r.get::<_,i64>(3)?,"createdAtMs":r.get::<_,i64>(4)?,"completedAtMs":r.get::<_,Option<i64>>(5)?,"itemJson":r.get::<_,String>(6)?,"turnStatus":r.get::<_,Option<String>>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
        let mut bytes = 0;
        for record in &mut records {
            let raw = record["itemJson"].as_str().unwrap();
            bytes += raw.len();
            anyhow::ensure!(bytes <= 8 * 1024 * 1024, "History page capacity exceeded");
            record["item"] = serde_json::from_str(raw)?;
            record.as_object_mut().unwrap().remove("itemJson");
        }
        let update_tail = records
            .iter()
            .max_by_key(|r| {
                (
                    r["updatedOrdinal"].as_i64().unwrap(),
                    r["id"].as_str().unwrap(),
                )
            })
            .cloned();
        records.sort_by(|a, b| {
            (a["ordinal"].as_i64(), a["id"].as_str())
                .cmp(&(b["ordinal"].as_i64(), b["id"].as_str()))
        });
        let has = |expression: &str, op: &str, n: i64, id: &str| -> anyhow::Result<bool> {
            Ok(db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM thread_items i WHERE i.thread_id=?1 AND i.item_type<>'reasoning' AND ({expression} {op} ?2 OR ({expression}=?2 AND i.item_id {op} ?3)))"),rusqlite::params![thread,n,id],|r|r.get(0))?)
        };
        let mut previous = Value::Null;
        let mut next = Value::Null;
        if direction != "updateCursor" {
            if let Some(first) = records.first() {
                let n = first["ordinal"].as_i64().unwrap();
                let id = first["id"].as_str().unwrap();
                if has(order, "<", n, id)? {
                    previous = json!(encode(n, id, "beforeCursor"));
                }
            }
            if let Some(last) = records.last() {
                let n = last["ordinal"].as_i64().unwrap();
                let id = last["id"].as_str().unwrap();
                if has(order, ">", n, id)? {
                    next = json!(encode(n, id, "afterCursor"));
                }
            }
        }
        let tail: Option<(i64, String)> = if direction == "updateCursor" {
            update_tail
                .map(|r| {
                    (
                        r["updatedOrdinal"].as_i64().unwrap(),
                        r["id"].as_str().unwrap().into(),
                    )
                })
                .or_else(|| ordinal.map(|n| (n, anchor.clone())))
        } else {
            use rusqlite::OptionalExtension;
            db.query_row("SELECT updated_at_ordinal,item_id FROM thread_items WHERE thread_id=? AND item_type<>'reasoning' ORDER BY updated_at_ordinal DESC,item_id DESC LIMIT 1",[thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()?
        };
        let updates = tail
            .as_ref()
            .map(|(n, id)| json!(encode(*n, id, "updateCursor")))
            .unwrap_or(Value::Null);
        let more = if direction == "updateCursor" {
            tail.as_ref()
                .map(|(n, id)| has("i.updated_at_ordinal", ">", *n, id))
                .transpose()?
                .unwrap_or(false)
        } else {
            false
        };
        Ok(
            json!({"items":records,"beforeCursor":previous,"afterCursor":next,"updateCursor":updates,"hasMoreUpdates":more}),
        )
    };
    query().map_err(|_| {
        error(
            "UNAVAILABLE",
            "Native history could not be read; storage may be unavailable or incompatible.",
        )
    })
}
