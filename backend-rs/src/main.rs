use chrono::{Datelike, FixedOffset, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::net::TcpListener;
use std::os::unix::io::FromRawFd;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server};
use uuid::Uuid;

const COURSES: &[&str] = &[
    "General Physics Lab",
    "Thermodynamics",
    "Engineering Graphics",
    "Mechanics",
    "Mechanical Workshop",
    "Mathematics I",
    "Chemical Structure and Bonding",
    "IIT Madras — Programming with Python",
    "IIT Madras — English 1",
];

const IST_OFFSET_SECS: i32 = 5 * 3600 + 30 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    course: Option<String>,
    #[serde(rename = "type")]
    task_type: String,
    due_date: Option<String>,
    notes: String,
    priority: Option<i64>,
    done: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedTask {
    id: String,
    title: String,
    course: Option<String>,
    #[serde(rename = "type")]
    task_type: String,
    due_date: Option<String>,
    notes: String,
    priority: Option<i64>,
    done: bool,
}

#[derive(Debug)]
struct ApiError {
    status: u16,
    message: String,
}

impl ApiError {
    fn bad_request(msg: impl Into<String>) -> Self {
        Self { status: 400, message: msg.into() }
    }
    fn not_found(msg: impl Into<String>) -> Self {
        Self { status: 404, message: msg.into() }
    }
    fn internal(msg: impl Into<String>) -> Self {
        Self { status: 500, message: msg.into() }
    }
}

struct ArtworkCache {
    key: String,
    mime: String,
    bytes: Vec<u8>,
}

struct AppState {
    db: Mutex<Connection>,
    public_dir: PathBuf,
    public_hosts: HashSet<String>,
    artwork_cache: Mutex<Option<ArtworkCache>>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ist_offset() -> FixedOffset {
    FixedOffset::east_opt(IST_OFFSET_SECS).unwrap()
}

fn ist_date_from_ms(ms: i64) -> String {
    let dt = Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now);
    dt.with_timezone(&ist_offset()).format("%Y-%m-%d").to_string()
}

fn valid_date_only(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string() == s)
        .unwrap_or(false)
}

fn add_days_iso(date_str: &str, delta: i64) -> String {
    let d = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").unwrap();
    let shifted = d + chrono::Duration::days(delta);
    format!("{:04}-{:02}-{:02}", shifted.year(), shifted.month(), shifted.day())
}

fn ist_day_end_ms(date_str: &str) -> i64 {
    let next_day = add_days_iso(date_str, 1);
    let d = NaiveDate::parse_from_str(&next_day, "%Y-%m-%d").unwrap();
    let dt = ist_offset()
        .with_ymd_and_hms(d.year(), d.month(), d.day(), 0, 0, 0)
        .single()
        .unwrap();
    dt.timestamp_millis()
}

fn split_elapsed_by_ist_day(start_ms: i64, end_ms: i64) -> BTreeMap<String, i64> {
    let mut buckets = BTreeMap::new();
    let mut cursor = start_ms;
    while cursor < end_ms {
        let day = ist_date_from_ms(cursor);
        let next_midnight = ist_day_end_ms(&day);
        let seg_end = end_ms.min(next_midnight);
        let secs = (seg_end - cursor) / 1000;
        if secs > 0 {
            *buckets.entry(day).or_insert(0) += secs;
        }
        if seg_end <= cursor {
            break;
        }
        cursor = seg_end;
    }
    buckets
}

fn resolve_project_root() -> PathBuf {
    if let Ok(p) = env::var("NITC_PROJECT_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("public").is_dir() {
            return pb;
        }
    }
    if let Ok(cwd) = env::current_dir() {
        if cwd.join("public").is_dir() {
            return cwd;
        }
    }
    if let Ok(exe) = env::current_exe() {
        for anc in exe.ancestors().skip(1) {
            if anc.join("public").is_dir() {
                return anc.to_path_buf();
            }
        }
    }
    PathBuf::from("/Users/devangagarwal/Developer/nitc-hq-tasks")
}

fn init_db(db_file: &Path, data_dir: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_file).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            course TEXT,
            type TEXT NOT NULL CHECK(type IN ('Coursework', 'Miscellaneous')),
            due_date TEXT,
            notes TEXT NOT NULL DEFAULT '',
            priority INTEGER CHECK(priority IS NULL OR (priority BETWEEN 1 AND 10)),
            done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_done_priority_due ON tasks(done, priority DESC, due_date ASC);
        CREATE INDEX IF NOT EXISTS tasks_course ON tasks(course);
        CREATE TABLE IF NOT EXISTS study_days (
            date TEXT PRIMARY KEY,
            seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds >= 0),
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS study_timer (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            running_since TEXT,
            updated_at TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| e.to_string())?;

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count == 0 {
        let seed_path = data_dir.join("seed.json");
        if seed_path.exists() {
            let raw = fs::read_to_string(&seed_path).map_err(|e| e.to_string())?;
            let seed: Vec<SeedTask> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let ts = now_iso();
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO tasks (id,title,course,type,due_date,notes,priority,done,created_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    )
                    .map_err(|e| e.to_string())?;
                for t in seed {
                    stmt.execute(params![
                        t.id,
                        t.title,
                        t.course,
                        t.task_type,
                        t.due_date,
                        t.notes,
                        t.priority,
                        if t.done { 1 } else { 0 },
                        ts,
                        ts
                    ])
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
    }
    Ok(conn)
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let done_int: i64 = row.get(7)?;
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        course: row.get(2)?,
        task_type: row.get(3)?,
        due_date: row.get(4)?,
        notes: row.get(5)?,
        priority: row.get(6)?,
        done: done_int != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const SELECT_COLS: &str = "id, title, course, type, due_date, notes, priority, done, created_at, updated_at";

fn task_by_id(conn: &Connection, id: &str) -> Result<Option<Task>, ApiError> {
    let sql = format!("SELECT {SELECT_COLS} FROM tasks WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_task)
        .optional()
        .map_err(|e| ApiError::internal(e.to_string()))
}

fn list_tasks(
    conn: &Connection,
    view: &str,
    course: &str,
    q: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Task>, ApiError> {
    if !matches!(view, "all" | "todo" | "done") {
        return Err(ApiError::bad_request("view must be all, todo, or done"));
    }
    let mut clauses: Vec<String> = Vec::new();
    let mut bind_values: Vec<String> = Vec::new();

    if view == "todo" {
        clauses.push("done = 0".into());
    } else if view == "done" {
        clauses.push("done = 1".into());
    }
    if !course.is_empty() {
        bind_values.push(course.to_string());
        clauses.push(format!("course = ?{}", bind_values.len()));
    }
    for token in q.split_whitespace() {
        bind_values.push(token.to_string());
        let idx = bind_values.len();
        clauses.push(format!(
            "(instr(lower(title), lower(?{idx})) > 0 OR instr(lower(notes), lower(?{idx})) > 0 OR instr(lower(coalesce(course, '')), lower(?{idx})) > 0)"
        ));
    }
    if !from.is_empty() {
        bind_values.push(from.to_string());
        clauses.push(format!("due_date >= ?{}", bind_values.len()));
    }
    if !to.is_empty() {
        bind_values.push(to.to_string());
        clauses.push(format!("due_date <= ?{}", bind_values.len()));
    }

    let ordering = if view == "done" {
        "COALESCE(due_date, '0000-00-00') DESC, updated_at DESC"
    } else {
        "CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority DESC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at ASC"
    };

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!("SELECT {SELECT_COLS} FROM tasks {where_sql} ORDER BY {ordering}");
    let mut stmt = conn.prepare(&sql).map_err(|e| ApiError::internal(e.to_string()))?;
    let param_refs: Vec<&dyn rusqlite::ToSql> =
        bind_values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), row_to_task)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| ApiError::internal(e.to_string()))?);
    }
    Ok(out)
}

struct ValidatedTask {
    title: String,
    task_type: String,
    course: Option<String>,
    due_date: Option<String>,
    notes: String,
    priority: Option<i64>,
}

fn validate_task_obj(obj: &serde_json::Map<String, Value>) -> Result<ValidatedTask, ApiError> {
    let title = match obj.get("title") {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            let trimmed = s.trim();
            if trimmed.chars().count() > 180 {
                return Err(ApiError::bad_request("title must be at most 180 characters"));
            }
            trimmed.to_string()
        }
        _ => return Err(ApiError::bad_request("title is required")),
    };

    let task_type = match obj.get("type") {
        Some(Value::String(s)) if s == "Coursework" || s == "Miscellaneous" => s.clone(),
        _ => return Err(ApiError::bad_request("type must be Coursework or Miscellaneous")),
    };

    let course = if task_type == "Coursework" {
        match obj.get("course") {
            Some(Value::String(s)) => {
                let trimmed = s.trim();
                if COURSES.contains(&trimmed) {
                    Some(trimmed.to_string())
                } else {
                    return Err(ApiError::bad_request(format!(
                        "a valid course is required for Coursework ({})",
                        COURSES.join(", ")
                    )));
                }
            }
            _ => {
                return Err(ApiError::bad_request(format!(
                    "a valid course is required for Coursework ({})",
                    COURSES.join(", ")
                )));
            }
        }
    } else {
        None
    };

    let due_date = match obj.get("dueDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if !valid_date_only(s) {
                return Err(ApiError::bad_request("dueDate must be a date in YYYY-MM-DD format or null"));
            }
            Some(s.clone())
        }
        _ => return Err(ApiError::bad_request("dueDate must be a date in YYYY-MM-DD format or null")),
    };

    let notes = match obj.get("notes") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => {
            if s.chars().count() > 5000 {
                return Err(ApiError::bad_request("notes must be at most 5000 characters"));
            }
            s.clone()
        }
        _ => return Err(ApiError::bad_request("notes must be a string")),
    };

    let priority = match obj.get("priority") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                if (1..=10).contains(&i) && n.as_f64().map(|f| f.fract() == 0.0).unwrap_or(true) {
                    Some(i)
                } else {
                    return Err(ApiError::bad_request("priority must be an integer from 1 to 10 or null"));
                }
            } else {
                return Err(ApiError::bad_request("priority must be an integer from 1 to 10 or null"));
            }
        }
        _ => return Err(ApiError::bad_request("priority must be an integer from 1 to 10 or null")),
    };

    Ok(ValidatedTask {
        title,
        task_type,
        course,
        due_date,
        notes,
        priority,
    })
}

fn insert_task(conn: &Connection, body: &Value) -> Result<Task, ApiError> {
    let obj = body.as_object().ok_or_else(|| ApiError::bad_request("Invalid JSON body"))?;
    let v = validate_task_obj(obj)?;
    let id = Uuid::new_v4().to_string();
    let ts = now_iso();
    conn.execute(
        "INSERT INTO tasks (id,title,course,type,due_date,notes,priority,done,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9)",
        params![id, v.title, v.course, v.task_type, v.due_date, v.notes, v.priority, ts, ts],
    )
    .map_err(|e| ApiError::internal(e.to_string()))?;
    task_by_id(conn, &id)?
        .ok_or_else(|| ApiError::internal("Failed to read created task"))
}

fn update_task(conn: &Connection, id: &str, patch: &Value) -> Result<Option<Task>, ApiError> {
    let current = match task_by_id(conn, id)? {
        Some(t) => t,
        None => return Ok(None),
    };
    let patch_obj = patch.as_object().ok_or_else(|| ApiError::bad_request("Invalid JSON body"))?;
    let mut merged = serde_json::to_value(&current)
        .map_err(|e| ApiError::internal(e.to_string()))?
        .as_object()
        .unwrap()
        .clone();
    for (k, v) in patch_obj {
        merged.insert(k.clone(), v.clone());
    }
    let validated = validate_task_obj(&merged)?;
    let next_done = match patch_obj.get("done") {
        None => current.done,
        Some(Value::Bool(b)) => *b,
        _ => return Err(ApiError::bad_request("done must be boolean")),
    };

    let has_any = ["title", "course", "type", "dueDate", "notes", "priority", "done"]
        .iter()
        .any(|k| patch_obj.contains_key(*k));
    if !has_any {
        return Ok(Some(current));
    }

    let ts = now_iso();
    conn.execute(
        "UPDATE tasks SET title=?1, course=?2, type=?3, due_date=?4, notes=?5, priority=?6, done=?7, updated_at=?8 WHERE id=?9",
        params![
            validated.title,
            validated.course,
            validated.task_type,
            validated.due_date,
            validated.notes,
            validated.priority,
            if next_done { 1 } else { 0 },
            ts,
            id
        ],
    )
    .map_err(|e| ApiError::internal(e.to_string()))?;
    task_by_id(conn, id)
}

fn get_timer_running_since(conn: &Connection) -> Result<Option<String>, ApiError> {
    let res: Option<Option<String>> = conn
        .query_row("SELECT running_since FROM study_timer WHERE id = 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(res.flatten())
}

fn upsert_study_day(conn: &Connection, date_str: &str, delta_secs: i64, ts: &str) -> Result<(), ApiError> {
    if delta_secs <= 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO study_days (date, seconds, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(date) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = excluded.updated_at",
        params![date_str, delta_secs, ts],
    )
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(())
}

fn get_study_state(conn: &Connection, days_arg: i64) -> Result<Value, ApiError> {
    let span = days_arg.clamp(7, 90);
    let now_ms = Utc::now().timestamp_millis();
    let today = ist_date_from_ms(now_ms);
    let running_since = get_timer_running_since(conn)?;
    let live_buckets = if let Some(ref iso) = running_since {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
            split_elapsed_by_ist_day(dt.timestamp_millis(), now_ms)
        } else {
            BTreeMap::new()
        }
    } else {
        BTreeMap::new()
    };

    let mut saved_map: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT date, seconds FROM study_days ORDER BY date ASC")
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        for r in rows {
            let (d, s) = r.map_err(|e| ApiError::internal(e.to_string()))?;
            saved_map.insert(d, s);
        }
    }

    let mut combined = saved_map.clone();
    for (d, s) in &live_buckets {
        *combined.entry(d.clone()).or_insert(0) += *s;
    }

    let mut series = Vec::with_capacity(span as usize);
    let mut range_total: i64 = 0;
    for i in (0..span).rev() {
        let d = add_days_iso(&today, -i);
        let secs = *combined.get(&d).unwrap_or(&0);
        range_total += secs;
        series.push(json!({ "date": d, "seconds": secs }));
    }

    let today_saved = *saved_map.get(&today).unwrap_or(&0);
    let today_total = *combined.get(&today).unwrap_or(&0);
    let mut week_secs: i64 = 0;
    for i in 0..7 {
        week_secs += *combined.get(&add_days_iso(&today, -i)).unwrap_or(&0);
    }

    let mut total_secs: i64 = 0;
    let mut best_day: i64 = 0;
    let mut active_days: i64 = 0;
    for &s in combined.values() {
        total_secs += s;
        if s > best_day {
            best_day = s;
        }
        if s > 0 {
            active_days += 1;
        }
    }

    let mut streak: i64 = 0;
    let mut check_day = if today_total > 0 {
        today.clone()
    } else {
        add_days_iso(&today, -1)
    };
    while *combined.get(&check_day).unwrap_or(&0) > 0 {
        streak += 1;
        check_day = add_days_iso(&check_day, -1);
    }
    let avg_secs = ((range_total as f64) / (span as f64)).round() as i64;

    Ok(json!({
        "today": today,
        "running": running_since.is_some(),
        "runningSince": running_since,
        "todaySavedSeconds": today_saved,
        "todayTotalSeconds": today_total,
        "days": series,
        "summary": {
            "todaySeconds": today_total,
            "weekSeconds": week_secs,
            "totalSeconds": total_secs,
            "avgSeconds": avg_secs,
            "streak": streak,
            "bestDaySeconds": best_day,
            "activeDays": active_days
        }
    }))
}

fn start_study_timer(conn: &Connection, days: i64) -> Result<Value, ApiError> {
    if get_timer_running_since(conn)?.is_none() {
        let ts = now_iso();
        conn.execute(
            "INSERT INTO study_timer (id, running_since, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET running_since = excluded.running_since, updated_at = excluded.updated_at",
            params![ts, ts],
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    get_study_state(conn, days)
}

fn stop_study_timer(conn: &Connection, days: i64) -> Result<Value, ApiError> {
    let ts = now_iso();
    if let Some(running_since) = get_timer_running_since(conn)? {
        let start_ms = chrono::DateTime::parse_from_rfc3339(&running_since)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|_| Utc::now().timestamp_millis());
        let end_ms = chrono::DateTime::parse_from_rfc3339(&ts)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|_| Utc::now().timestamp_millis());
        let buckets = split_elapsed_by_ist_day(start_ms, end_ms);
        let tx = conn.unchecked_transaction().map_err(|e| ApiError::internal(e.to_string()))?;
        for (d, s) in buckets {
            upsert_study_day(&tx, &d, s, &ts)?;
        }
        tx.execute(
            "INSERT INTO study_timer (id, running_since, updated_at) VALUES (1, NULL, ?1)
             ON CONFLICT(id) DO UPDATE SET running_since = NULL, updated_at = excluded.updated_at",
            params![ts],
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;
        tx.commit().map_err(|e| ApiError::internal(e.to_string()))?;
    }
    get_study_state(conn, days)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_decode_path(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let k = percent_decode(parts.next().unwrap_or(""));
        let v = percent_decode(parts.next().unwrap_or(""));
        map.insert(k, v);
    }
    map
}

fn host_allowed(host: Option<&str>, public_hosts: &HashSet<String>) -> bool {
    let Some(h) = host else { return false };
    let h = h.trim().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    let hostname = if h.starts_with('[') {
        let Some(end) = h.find(']') else { return false };
        &h[1..end]
    } else if h == "::1" {
        "::1"
    } else if let Some(colon) = h.find(':') {
        if h[colon + 1..].contains(':') {
            return false;
        }
        &h[..colon]
    } else {
        &h
    };
    matches!(hostname, "127.0.0.1" | "localhost" | "::1") || public_hosts.contains(hostname)
}

fn origin_allowed(origin: Option<&str>, public_hosts: &HashSet<String>) -> bool {
    let Some(raw) = origin else { return true };
    let raw = raw.trim();
    if raw.is_empty() {
        return true;
    }
    let (scheme, rest) = if let Some(r) = raw.strip_prefix("http://") {
        ("http", r)
    } else if let Some(r) = raw.strip_prefix("https://") {
        ("https", r)
    } else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = if authority.starts_with('[') {
        authority.find(']').map(|i| &authority[1..i]).unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    (scheme == "http" && loopback) || (scheme == "https" && public_hosts.contains(&host))
}

fn header_value<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn read_json_body(req: &mut Request) -> Result<Value, ApiError> {
    let mut body = String::new();
    let mut reader = req.as_reader();
    let mut buf = [0u8; 8192];
    loop {
        let n = io::Read::read(&mut reader, &mut buf).map_err(|e| ApiError::bad_request(e.to_string()))?;
        if n == 0 {
            break;
        }
        if body.len() + n > 1024 * 1024 {
            return Err(ApiError::bad_request("request body exceeds 1 MB"));
        }
        body.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    if body.trim().is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|_| ApiError::bad_request("Invalid JSON body"))?;
    if !parsed.is_object() {
        return Err(ApiError::bad_request("Invalid JSON body"));
    }
    Ok(parsed)
}

fn json_response(status: u16, value: &Value) -> Response<io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    Response::from_data(bytes)
        .with_status_code(status)
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap())
        .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap())
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

fn parse_byte_range(header: &str, total: usize) -> Option<Result<(usize, usize), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return Some(Err(()));
    }
    let (start_str, end_str) = spec.split_once('-')?;
    if start_str.is_empty() {
        let suffix: usize = end_str.trim().parse().ok()?;
        if suffix == 0 {
            return Some(Err(()));
        }
        let len = suffix.min(total);
        Some(Ok((total - len, total - 1)))
    } else {
        let start: usize = start_str.trim().parse().ok()?;
        if start >= total {
            return Some(Err(()));
        }
        let end = if end_str.trim().is_empty() {
            total - 1
        } else {
            let e: usize = end_str.trim().parse().ok()?;
            if e < start {
                return Some(Err(()));
            }
            e.min(total - 1)
        };
        Some(Ok((start, end)))
    }
}

fn music_is_running() -> bool {
    Command::new("pgrep")
        .args(["-x", "Music"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run_jxa(script: &str) -> Result<String, ApiError> {
    let out = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .map_err(|e| ApiError::internal(format!("osascript failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(ApiError::bad_request(if stderr.is_empty() {
            "Apple Music command failed".to_string()
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn music_get_state() -> Result<Value, ApiError> {
    if !music_is_running() {
        return Ok(json!({ "running": false, "state": "stopped" }));
    }
    let script = r#"
const m = Application("Music");
const out = { running: true, state: "stopped", shuffle: false, repeat: "off", volume: 100, position: 0, track: null, playlist: null };
try { out.state = String(m.playerState()); } catch(e) {}
try { out.shuffle = Boolean(m.shuffleEnabled()); } catch(e) {}
try { out.repeat = String(m.songRepeat()); } catch(e) {}
try { out.volume = Number(m.soundVolume()); } catch(e) {}
try { out.position = Number(m.playerPosition()) || 0; } catch(e) {}
try {
  const t = m.currentTrack();
  const name = String(t.name());
  if (name) {
    let pid = "";
    try { pid = String(t.persistentID()); } catch(e) { pid = name; }
    let fav = false;
    try { fav = Boolean(t.favorited()); } catch(e) {}
    let idx = 0;
    try { idx = Number(t.index()) || 0; } catch(e) {}
    let artCount = 0;
    try { artCount = Number(t.artworks.length) || 0; } catch(e) {}
    out.track = {
      id: pid,
      name,
      artist: String(t.artist() || ""),
      album: String(t.album() || ""),
      duration: Number(t.duration()) || 0,
      index: idx,
      favorited: fav,
      hasArtwork: artCount > 0
    };
  }
} catch(e) {}
try {
  const p = m.currentPlaylist();
  out.playlist = { name: String(p.name() || ""), count: Number(p.tracks.length) || 0 };
} catch(e) {}
JSON.stringify(out);
"#;
    let raw = run_jxa(script)?;
    serde_json::from_str(&raw).map_err(|e| ApiError::internal(e.to_string()))
}

fn music_get_queue() -> Result<Value, ApiError> {
    if !music_is_running() {
        return Ok(json!({ "running": false, "playlist": null, "tracks": [] }));
    }
    let script = r#"
const m = Application("Music");
const out = { running: true, shuffle: false, playlist: null, tracks: [] };
try { out.shuffle = Boolean(m.shuffleEnabled()); } catch(e) {}
let curIdx = -1;
try { curIdx = Number(m.currentTrack().index()) || -1; } catch(e) {}
try {
  const p = m.currentPlaylist();
  const names = p.tracks.name();
  const artists = p.tracks.artist();
  const durations = p.tracks.duration();
  const total = names.length;
  out.playlist = { name: String(p.name() || ""), count: total };
  const limit = Math.min(total, 200);
  const list = [];
  for (let i = 0; i < limit; i++) {
    list.push({
      index: i + 1,
      name: String(names[i] || ""),
      artist: String(artists[i] || ""),
      duration: Number(durations[i]) || 0,
      current: (i + 1) === curIdx
    });
  }
  out.tracks = list;
} catch(e) {}
JSON.stringify(out);
"#;
    let raw = run_jxa(script)?;
    serde_json::from_str(&raw).map_err(|e| ApiError::internal(e.to_string()))
}

fn music_get_artwork(state: &AppState, cache_key: &str) -> Result<Option<(String, Vec<u8>)>, ApiError> {
    if !music_is_running() {
        return Ok(None);
    }
    if !cache_key.is_empty() {
        if let Ok(guard) = state.artwork_cache.lock() {
            if let Some(ref c) = *guard {
                if c.key == cache_key {
                    return Ok(Some((c.mime.clone(), c.bytes.clone())));
                }
            }
        }
    }
    let tmp_path = env::temp_dir().join(format!("nitc-music-art-{}.img", Uuid::new_v4()));
    let tmp_str = tmp_path.to_string_lossy().replace('"', "\\\"");
    let script = format!(
        r#"tell application "Music"
  if (count of artworks of current track) > 0 then
    set artData to raw data of artwork 1 of current track
    set artFmt to format of artwork 1 of current track as string
    set f to open for access POSIX file "{tmp_str}" with write permission
    set eof f to 0
    write artData to f
    close access f
    return artFmt
  else
    return "NONE"
  end if
end tell"#
    );
    let out = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !out.status.success() {
        let _ = fs::remove_file(&tmp_path);
        return Ok(None);
    }
    let fmt = String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase();
    if fmt == "none" || !tmp_path.exists() {
        let _ = fs::remove_file(&tmp_path);
        return Ok(None);
    }
    let bytes = fs::read(&tmp_path).ok();
    let _ = fs::remove_file(&tmp_path);
    let Some(bytes) = bytes else { return Ok(None) };
    if bytes.is_empty() {
        return Ok(None);
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || fmt.contains("png") {
        "image/png".to_string()
    } else {
        "image/jpeg".to_string()
    };
    if !cache_key.is_empty() {
        if let Ok(mut guard) = state.artwork_cache.lock() {
            *guard = Some(ArtworkCache {
                key: cache_key.to_string(),
                mime: mime.clone(),
                bytes: bytes.clone(),
            });
        }
    }
    Ok(Some((mime, bytes)))
}

fn music_control(body: &Value) -> Result<Value, ApiError> {
    let obj = body.as_object().ok_or_else(|| ApiError::bad_request("Invalid JSON body"))?;
    let action = obj.get("action").and_then(|v| v.as_str()).unwrap_or("");
    if action == "open" {
        let _ = Command::new("open").args(["-a", "Music"]).status();
        thread::sleep(Duration::from_millis(350));
        return music_get_state();
    }
    if !music_is_running() {
        return Ok(json!({ "running": false, "state": "stopped" }));
    }
    match action {
        "playpause" => { let _ = run_jxa("Application('Music').playpause(); 'ok';")?; }
        "next" => { let _ = run_jxa("Application('Music').nextTrack(); 'ok';")?; }
        "previous" => { let _ = run_jxa("Application('Music').backTrack(); 'ok';")?; }
        "shuffle" => { let _ = run_jxa("const m=Application('Music'); m.shuffleEnabled = !m.shuffleEnabled(); 'ok';")?; }
        "repeat" => {
            let _ = run_jxa(
                "const m=Application('Music'); const cur=String(m.songRepeat()); m.songRepeat = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off'; 'ok';",
            )?;
        }
        "favorite" => {
            let _ = run_jxa("const m=Application('Music'); const t=m.currentTrack(); t.favorited = !t.favorited(); 'ok';")?;
        }
        "seek" => {
            let pos = obj
                .get("position")
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or_else(|| ApiError::bad_request("position must be a non-negative number"))?;
            let _ = run_jxa(&format!("Application('Music').playerPosition = {pos:.3}; 'ok';"))?;
        }
        "volume" => {
            let vol = obj
                .get("volume")
                .and_then(|v| v.as_i64())
                .map(|v| v.clamp(0, 100))
                .ok_or_else(|| ApiError::bad_request("volume must be an integer 0..100"))?;
            let _ = run_jxa(&format!("Application('Music').soundVolume = {vol}; 'ok';"))?;
        }
        "playTrack" => {
            let idx = obj
                .get("index")
                .and_then(|v| v.as_i64())
                .filter(|&v| v >= 1 && v <= 10000)
                .ok_or_else(|| ApiError::bad_request("index must be a positive integer"))?;
            let _ = run_jxa(&format!(
                "const m=Application('Music'); m.currentPlaylist().tracks.at({}).play(); 'ok';",
                idx - 1
            ))?;
        }
        _ => return Err(ApiError::bad_request("Unsupported music action")),
    }
    thread::sleep(Duration::from_millis(60));
    music_get_state()
}

fn handle_http(state: &AppState, mut req: Request) {
    let raw_url = req.url().to_string();
    let (raw_path, raw_query) = match raw_url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw_url.as_str(), ""),
    };
    let query = parse_query(raw_query);
    let method = req.method().clone();

    if raw_path.starts_with("/api/") {
        if !host_allowed(header_value(&req, "host"), &state.public_hosts)
            || !origin_allowed(header_value(&req, "origin"), &state.public_hosts)
        {
            let _ = req.respond(json_response(403, &json!({ "error": "Forbidden" })));
            return;
        }

        if method == Method::Get && raw_path == "/api/music/artwork" {
            let key = query.get("id").map(|s| s.as_str()).unwrap_or("");
            match music_get_artwork(state, key) {
                Ok(Some((mime, bytes))) => {
                    let resp = Response::from_data(bytes)
                        .with_status_code(200)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap())
                        .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"public, max-age=3600"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]).unwrap());
                    let _ = req.respond(resp);
                }
                _ => {
                    let _ = req.respond(json_response(404, &json!({ "error": "No artwork" })));
                }
            }
            return;
        }

        if method == Method::Get && raw_path == "/api/music/state" {
            match music_get_state() {
                Ok(val) => { let _ = req.respond(json_response(200, &val)); }
                Err(err) => { let _ = req.respond(json_response(err.status, &json!({ "error": err.message }))); }
            }
            return;
        }

        if method == Method::Get && raw_path == "/api/music/queue" {
            match music_get_queue() {
                Ok(val) => { let _ = req.respond(json_response(200, &val)); }
                Err(err) => { let _ = req.respond(json_response(err.status, &json!({ "error": err.message }))); }
            }
            return;
        }

        if method == Method::Post && raw_path == "/api/music/control" {
            let has_json_ct = header_value(&req, "content-type")
                .map(|ct| ct.to_ascii_lowercase().contains("application/json"))
                .unwrap_or(false);
            if !has_json_ct {
                let _ = req.respond(json_response(400, &json!({ "error": "Content-Type must be application/json" })));
                return;
            }
            match read_json_body(&mut req).and_then(|b| music_control(&b)) {
                Ok(val) => { let _ = req.respond(json_response(200, &val)); }
                Err(err) => { let _ = req.respond(json_response(err.status, &json!({ "error": err.message }))); }
            }
            return;
        }

        let has_json_ct = header_value(&req, "content-type")
            .map(|ct| ct.to_ascii_lowercase().contains("application/json"))
            .unwrap_or(false);
        let is_empty_body = header_value(&req, "content-length")
            .map(|cl| cl.trim().is_empty() || cl.trim() == "0")
            .unwrap_or(true);

        let result: Result<(u16, Value), ApiError> = (|| {
            let conn = state.db.lock().map_err(|_| ApiError::internal("DB lock poisoned"))?;
            if method == Method::Get && raw_path == "/api/health" {
                return Ok((200, json!({ "ok": true, "app": "NITC HQ Tasks", "timezone": "Asia/Kolkata" })));
            }
            if method == Method::Get && raw_path == "/api/courses" {
                return Ok((200, json!({ "courses": COURSES })));
            }
            if method == Method::Get && raw_path == "/api/tasks" {
                let view = query.get("view").map(|s| s.as_str()).unwrap_or("all");
                let course = query.get("course").map(|s| s.as_str()).unwrap_or("");
                let q = query.get("q").map(|s| s.as_str()).unwrap_or("");
                let from = query.get("from").map(|s| s.as_str()).unwrap_or("");
                let to = query.get("to").map(|s| s.as_str()).unwrap_or("");
                let tasks = list_tasks(&conn, view, course, q, from, to)?;
                return Ok((200, json!({ "tasks": tasks })));
            }
            if raw_path.starts_with("/api/tasks/") {
                let rest = &raw_path["/api/tasks/".len()..];
                let pieces: Vec<String> = rest.split('/').map(percent_decode_path).collect();
                let id = pieces.first().map(|s| s.as_str()).unwrap_or("");
                let action = pieces.get(1).map(|s| s.as_str()).unwrap_or("");
                if method == Method::Get && action.is_empty() {
                    return match task_by_id(&conn, id)? {
                        Some(t) => Ok((200, json!({ "task": t }))),
                        None => Err(ApiError::not_found("Task not found")),
                    };
                }
                if method == Method::Patch && action.is_empty() {
                    if !has_json_ct {
                        return Err(ApiError::bad_request("Content-Type must be application/json"));
                    }
                    drop(conn);
                    let body = read_json_body(&mut req)?;
                    let conn = state.db.lock().map_err(|_| ApiError::internal("DB lock poisoned"))?;
                    return match update_task(&conn, id, &body)? {
                        Some(t) => Ok((200, json!({ "task": t }))),
                        None => Err(ApiError::not_found("Task not found")),
                    };
                }
                if method == Method::Post && (action == "complete" || action == "reopen") {
                    if !has_json_ct && !is_empty_body {
                        return Err(ApiError::bad_request("Content-Type must be application/json"));
                    }
                    let done_val = action == "complete";
                    return match update_task(&conn, id, &json!({ "done": done_val }))? {
                        Some(t) => Ok((200, json!({ "task": t }))),
                        None => Err(ApiError::not_found("Task not found")),
                    };
                }
            }
            if method == Method::Post && raw_path == "/api/tasks" {
                if !has_json_ct {
                    return Err(ApiError::bad_request("Content-Type must be application/json"));
                }
                drop(conn);
                let body = read_json_body(&mut req)?;
                let conn = state.db.lock().map_err(|_| ApiError::internal("DB lock poisoned"))?;
                let task = insert_task(&conn, &body)?;
                return Ok((201, json!({ "task": task })));
            }
            let days = query
                .get("days")
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(14);
            if method == Method::Get && raw_path == "/api/study" {
                return Ok((200, get_study_state(&conn, days)?));
            }
            if method == Method::Post && raw_path == "/api/study/start" {
                if !has_json_ct && !is_empty_body {
                    return Err(ApiError::bad_request("Content-Type must be application/json"));
                }
                return Ok((200, start_study_timer(&conn, days)?));
            }
            if method == Method::Post && (raw_path == "/api/study/pause" || raw_path == "/api/study/end-day") {
                if !has_json_ct && !is_empty_body {
                    return Err(ApiError::bad_request("Content-Type must be application/json"));
                }
                let mut val = stop_study_timer(&conn, days)?;
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("endedDay".into(), Value::Bool(raw_path == "/api/study/end-day"));
                }
                return Ok((200, val));
            }
            Err(ApiError::not_found("Not found"))
        })();

        match result {
            Ok((code, val)) => {
                let _ = req.respond(json_response(code, &val));
            }
            Err(err) => {
                let msg = if err.status == 500 {
                    "Internal error".to_string()
                } else {
                    err.message
                };
                let _ = req.respond(json_response(err.status, &json!({ "error": msg })));
            }
        }
        return;
    }

    if method != Method::Get && method != Method::Head {
        let _ = req.respond(json_response(405, &json!({ "error": "Method not allowed" })));
        return;
    }

    let decoded = percent_decode_path(if raw_path == "/" { "/index.html" } else { raw_path });
    let rel = decoded.trim_start_matches('/');
    let mut candidate = state.public_dir.clone();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(p) => candidate.push(p),
            Component::CurDir => {}
            _ => {
                let _ = req.respond(json_response(403, &json!({ "error": "Forbidden" })));
                return;
            }
        }
    }
    if !candidate.starts_with(&state.public_dir) || !candidate.is_file() {
        let _ = req.respond(json_response(404, &json!({ "error": "Not found" })));
        return;
    }

    match fs::read(&candidate) {
        Ok(bytes) => {
            let ct = mime_for(&candidate);
            let cc = if decoded.starts_with("/themes/") {
                "public, max-age=86400"
            } else {
                "no-store"
            };
            let total = bytes.len();
            if let Some(range_hdr) = header_value(&req, "range") {
                match parse_byte_range(range_hdr, total) {
                    Some(Ok((start, end))) => {
                        let slice_len = end - start + 1;
                        let body_bytes = if method == Method::Head {
                            Vec::new()
                        } else {
                            bytes[start..=end].to_vec()
                        };
                        let cr = format!("bytes {start}-{end}/{total}");
                        let resp = Response::from_data(body_bytes)
                            .with_status_code(206)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap())
                            .with_header(Header::from_bytes(&b"Content-Length"[..], slice_len.to_string().as_bytes()).unwrap())
                            .with_header(Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()).unwrap())
                            .with_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Cache-Control"[..], cc.as_bytes()).unwrap())
                            .with_header(Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]).unwrap());
                        let _ = req.respond(resp);
                        return;
                    }
                    Some(Err(())) => {
                        let cr = format!("bytes */{total}");
                        let resp = Response::from_data(Vec::new())
                            .with_status_code(416)
                            .with_header(Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()).unwrap())
                            .with_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap());
                        let _ = req.respond(resp);
                        return;
                    }
                    None => {}
                }
            }
            let body_bytes = if method == Method::Head { Vec::new() } else { bytes };
            let resp = Response::from_data(body_bytes)
                .with_status_code(200)
                .with_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Content-Length"[..], total.to_string().as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Cache-Control"[..], cc.as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]).unwrap());
            let _ = req.respond(resp);
        }
        Err(_) => {
            let _ = req.respond(json_response(500, &json!({ "error": "Internal error" })));
        }
    }
}

fn mcp_tools() -> Value {
    let mut course_enum: Vec<Value> = COURSES.iter().map(|c| Value::String((*c).into())).collect();
    course_enum.push(Value::Null);
    let task_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string", "minLength": 1 },
            "course": { "type": ["string", "null"], "enum": course_enum },
            "type": { "type": "string", "enum": ["Coursework", "Miscellaneous"] },
            "dueDate": { "type": ["string", "null"], "description": "Date-only YYYY-MM-DD; interpret relative dates in Asia/Kolkata. Omit when no due date is given." },
            "notes": { "type": "string" },
            "priority": { "type": ["integer", "null"], "minimum": 1, "maximum": 10, "description": "Infer from urgency, consequences, and emphasis; 10 is highest." }
        },
        "required": ["title", "type", "course"]
    });
    json!([
        { "name": "list_tasks", "description": "List tasks in priority-descending, due-date-ascending order for open tasks. Use before creating a task when a possible duplicate may exist. Views: todo, done, all.", "inputSchema": { "type": "object", "properties": { "view": { "type": "string", "enum": ["todo", "done", "all"], "default": "todo" }, "course": { "type": "string", "enum": COURSES }, "q": { "type": "string" } } } },
        { "name": "search_tasks", "description": "Search task titles, notes, and courses to find existing work and disambiguate a completion request before changing anything.", "inputSchema": { "type": "object", "properties": { "q": { "type": "string", "minLength": 1 }, "view": { "type": "string", "enum": ["todo", "done", "all"], "default": "all" } }, "required": ["q"] } },
        { "name": "get_task", "description": "Get one task by its exact id.", "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "create_task", "description": "Create one concrete task the user explicitly says they need to do. Search first to avoid duplicates. Infer Coursework versus Miscellaneous and the matching course; infer priority from urgency (1–10). Do not invent a deadline. Resolve relative dates in Asia/Kolkata. No reminder is scheduled. A course is required for Coursework and must be null for Miscellaneous.", "inputSchema": task_schema },
        { "name": "update_task", "description": "Edit a task by exact id. Do not use this to resolve ambiguous task references; search first and ask the user if multiple tasks match.", "inputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "course": { "type": ["string", "null"], "enum": course_enum }, "type": { "type": "string", "enum": ["Coursework", "Miscellaneous"] }, "dueDate": { "type": ["string", "null"] }, "notes": { "type": "string" }, "priority": { "type": ["integer", "null"], "minimum": 1, "maximum": 10 } }, "required": ["id"] } },
        { "name": "complete_task", "description": "Mark a task complete without deleting it. Search first; if the user reference matches multiple tasks, ask which one before changing it.", "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "reopen_task", "description": "Reopen a completed task by exact id.", "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "list_courses", "description": "List the supported course options and institution tags.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "get_study_summary", "description": "Read daily study hours, current streak, and active study timer state (Asia/Kolkata).", "inputSchema": { "type": "object", "properties": { "days": { "type": "integer", "minimum": 7, "maximum": 90, "default": 14 } } } }
    ])
}

fn mcp_result(value: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string(&value).unwrap_or_else(|_| "{}".into()) }],
        "structuredContent": value
    })
}

fn run_mcp_tool(conn: &Connection, name: &str, args: &Value) -> Result<Value, ApiError> {
    let empty = serde_json::Map::new();
    let map = args.as_object().unwrap_or(&empty);
    match name {
        "list_tasks" => {
            let view = map.get("view").and_then(|v| v.as_str()).unwrap_or("todo");
            let course = map.get("course").and_then(|v| v.as_str()).unwrap_or("");
            let q = map.get("q").and_then(|v| v.as_str()).unwrap_or("");
            let tasks = list_tasks(conn, view, course, q, "", "")?;
            Ok(mcp_result(json!({ "tasks": tasks })))
        }
        "search_tasks" => {
            let q = map
                .get("q")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| ApiError::bad_request("q must be a non-empty string"))?;
            let view = map.get("view").and_then(|v| v.as_str()).unwrap_or("all");
            let tasks = list_tasks(conn, view, "", q, "", "")?;
            Ok(mcp_result(json!({ "tasks": tasks })))
        }
        "get_task" => {
            let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let task = task_by_id(conn, id)?.ok_or_else(|| ApiError::not_found("Task not found"))?;
            Ok(mcp_result(json!({ "task": task })))
        }
        "create_task" => {
            let task = insert_task(conn, args)?;
            Ok(mcp_result(json!({ "task": task })))
        }
        "update_task" => {
            let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut patch = map.clone();
            patch.remove("id");
            let task = update_task(conn, id, &Value::Object(patch))?
                .ok_or_else(|| ApiError::not_found("Task not found"))?;
            Ok(mcp_result(json!({ "task": task })))
        }
        "complete_task" => {
            let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let task = update_task(conn, id, &json!({ "done": true }))?
                .ok_or_else(|| ApiError::not_found("Task not found"))?;
            Ok(mcp_result(json!({ "task": task })))
        }
        "reopen_task" => {
            let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let task = update_task(conn, id, &json!({ "done": false }))?
                .ok_or_else(|| ApiError::not_found("Task not found"))?;
            Ok(mcp_result(json!({ "task": task })))
        }
        "list_courses" => {
            let list: Vec<Value> = COURSES
                .iter()
                .map(|c| {
                    let is_iit = c.starts_with("IIT Madras");
                    json!({
                        "name": c,
                        "institution": if is_iit { "IIT Madras" } else { "NIT Calicut" },
                        "color": if is_iit { "purple" } else { "green" }
                    })
                })
                .collect();
            Ok(mcp_result(json!({ "courses": list })))
        }
        "get_study_summary" => {
            let days = map.get("days").and_then(|v| v.as_i64()).unwrap_or(14);
            Ok(mcp_result(get_study_state(conn, days)?))
        }
        _ => Err(ApiError::bad_request(format!("Unknown tool: {name}"))),
    }
}

fn start_mcp(state: &AppState) {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        if method == "notifications/initialized" || method.starts_with("notifications/") {
            continue;
        }
        let id = msg.get("id");
        let resp = match method {
            "initialize" => {
                let pv = msg
                    .pointer("/params/protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("2025-03-26");
                json!({
                    "protocolVersion": pv,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "nitc-hq-tasks", "version": "1.0.0" }
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": mcp_tools() }),
            "tools/call" => {
                let name = msg.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
                let args = msg.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
                let conn = state.db.lock().unwrap();
                match run_mcp_tool(&conn, name, &args) {
                    Ok(res) => res,
                    Err(e) => json!({ "content": [{ "type": "text", "text": e.message }], "isError": true }),
                }
            }
            _ => {
                if let Some(id_val) = id {
                    let _ = writeln!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "id": id_val, "error": { "code": -32601, "message": "Method not found" } })
                    );
                    let _ = stdout.flush();
                }
                continue;
            }
        };
        if let Some(id_val) = id {
            let _ = writeln!(stdout, "{}", json!({ "jsonrpc": "2.0", "id": id_val, "result": resp }));
            let _ = stdout.flush();
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let is_mcp = args.iter().any(|a| a == "--mcp");
    let use_launchd = args.iter().any(|a| a == "--launchd") || env::var("NITC_LAUNCHD").as_deref() == Ok("1");

    let root = resolve_project_root();
    let public_dir = root.join("public");
    let data_dir = root.join("data");
    let _ = fs::create_dir_all(&data_dir);
    let db_file = env::var("NITC_TASKS_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("tasks.sqlite"));
    let conn = init_db(&db_file, &data_dir).unwrap_or_else(|e| {
        eprintln!("Failed to initialize SQLite database: {e}");
        std::process::exit(1);
    });

    let public_hosts: HashSet<String> = env::var("NITC_PUBLIC_HOST")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        public_dir,
        public_hosts,
        artwork_cache: Mutex::new(None),
    });

    if is_mcp {
        start_mcp(&state);
        return;
    }

    let listener = if use_launchd {
        unsafe { TcpListener::from_raw_fd(0) }
    } else {
        let port: u16 = env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4173);
        TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
            eprintln!("Server error: {e}");
            std::process::exit(1);
        })
    };

    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(4173);
    let server = Server::from_listener(listener, None).unwrap_or_else(|e| {
        eprintln!("Server error: {e}");
        std::process::exit(1);
    });

    if use_launchd {
        println!("NITC HQ Tasks (Rust) listening via launchd socket activation");
    } else {
        println!("NITC HQ Tasks is available at http://127.0.0.1:{bound_port}");
    }
    let _ = io::stdout().flush();

    let idle_ms: u64 = env::var("NITC_IDLE_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(if use_launchd { 120_000 } else { 0 });

    let last_activity = Arc::new(AtomicU64::new(unix_ms()));
    if idle_ms > 0 {
        let la = Arc::clone(&last_activity);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            let now = unix_ms();
            let last = la.load(Ordering::Relaxed);
            if now.saturating_sub(last) >= idle_ms {
                std::process::exit(0);
            }
        });
    }

    for req in server.incoming_requests() {
        last_activity.store(unix_ms(), Ordering::Relaxed);
        let st = Arc::clone(&state);
        thread::spawn(move || {
            handle_http(&st, req);
        });
    }
}
