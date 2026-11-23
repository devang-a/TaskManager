import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = resolve(root, 'public');
const dataDir = resolve(root, 'data');
mkdirSync(dataDir, { recursive: true });
const dbFile = resolve(process.env.NITC_TASKS_DB ?? resolve(dataDir, 'tasks.sqlite'));
mkdirSync(dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`
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
`);

const courses = [
  'General Physics Lab', 'Thermodynamics', 'Engineering Graphics', 'Mechanics',
  'Mechanical Workshop', 'Mathematics I', 'Chemical Structure and Bonding',
  'IIT Madras — Programming with Python', 'IIT Madras — English 1'
];
const now = () => new Date().toISOString();
const IST_OFFSET_MS = 330 * 60 * 1000;
function istDateString(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}
function addDaysISO(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function istDayEndMs(dateStr) {
  return Date.parse(`${addDaysISO(dateStr, 1)}T00:00:00Z`) - IST_OFFSET_MS;
}
function splitElapsedByISTDay(startMs, endMs) {
  const buckets = new Map();
  let cursor = startMs;
  while (cursor < endMs) {
    const day = istDateString(new Date(cursor));
    const nextMidnight = istDayEndMs(day);
    const segmentEnd = Math.min(endMs, nextMidnight);
    const secs = Math.floor((segmentEnd - cursor) / 1000);
    if (secs > 0) buckets.set(day, (buckets.get(day) ?? 0) + secs);
    if (segmentEnd === cursor) break;
    cursor = segmentEnd;
  }
  return buckets;
}
function getTimerRow() {
  return db.prepare('SELECT running_since AS runningSince, updated_at AS updatedAt FROM study_timer WHERE id = 1').get() ?? { runningSince: null, updatedAt: null };
}
function upsertStudyDay(dateStr, deltaSeconds, ts) {
  if (deltaSeconds <= 0) return;
  db.prepare(`INSERT INTO study_days (date, seconds, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = excluded.updated_at`).run(dateStr, deltaSeconds, ts);
}
function getStudyState({ days = 14 } = {}) {
  const span = Math.max(7, Math.min(90, Number.isFinite(Number(days)) ? Math.floor(Number(days)) : 14));
  const nowDate = new Date();
  const nowMs = nowDate.getTime();
  const today = istDateString(nowDate);
  const timer = getTimerRow();
  const liveBuckets = timer.runningSince ? splitElapsedByISTDay(Date.parse(timer.runningSince), nowMs) : new Map();
  const savedRows = db.prepare('SELECT date, seconds FROM study_days ORDER BY date ASC').all();
  const savedMap = new Map(savedRows.map(r => [r.date, Number(r.seconds)]));
  const combinedMap = new Map(savedMap);
  for (const [day, secs] of liveBuckets.entries()) {
    combinedMap.set(day, (combinedMap.get(day) ?? 0) + secs);
  }
  const series = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = addDaysISO(today, -i);
    series.push({ date: d, seconds: combinedMap.get(d) ?? 0 });
  }
  const todaySavedSeconds = savedMap.get(today) ?? 0;
  const todayTotalSeconds = combinedMap.get(today) ?? 0;
  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) weekSeconds += combinedMap.get(addDaysISO(today, -i)) ?? 0;
  let totalSeconds = 0;
  let bestDaySeconds = 0;
  let activeDays = 0;
  for (const secs of combinedMap.values()) {
    totalSeconds += secs;
    if (secs > bestDaySeconds) bestDaySeconds = secs;
    if (secs > 0) activeDays++;
  }
  let streak = 0;
  let checkDay = todayTotalSeconds > 0 ? today : addDaysISO(today, -1);
  while ((combinedMap.get(checkDay) ?? 0) > 0) {
    streak++;
    checkDay = addDaysISO(checkDay, -1);
  }
  const rangeTotal = series.reduce((sum, item) => sum + item.seconds, 0);
  const avgSeconds = Math.round(rangeTotal / span);
  return {
    today,
    running: Boolean(timer.runningSince),
    runningSince: timer.runningSince,
    todaySavedSeconds,
    todayTotalSeconds,
    days: series,
    summary: { todaySeconds: todayTotalSeconds, weekSeconds, totalSeconds, avgSeconds, streak, bestDaySeconds, activeDays }
  };
}
function startStudyTimer(days) {
  const timer = getTimerRow();
  if (!timer.runningSince) {
    const ts = now();
    db.prepare(`INSERT INTO study_timer (id, running_since, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET running_since = excluded.running_since, updated_at = excluded.updated_at`).run(ts, ts);
  }
  return getStudyState({ days });
}
function stopStudyTimer(days) {
  const timer = getTimerRow();
  const ts = now();
  if (timer.runningSince) {
    const startMs = Date.parse(timer.runningSince);
    const endMs = Date.parse(ts);
    const buckets = splitElapsedByISTDay(startMs, endMs);
    db.exec('BEGIN');
    try {
      for (const [day, secs] of buckets.entries()) upsertStudyDay(day, secs, ts);
      db.prepare(`INSERT INTO study_timer (id, running_since, updated_at) VALUES (1, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET running_since = NULL, updated_at = excluded.updated_at`).run(ts);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return getStudyState({ days });
}
function validDateOnly(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}
const columns = `id, title, course, type, due_date AS dueDate, notes, priority, done,
  created_at AS createdAt, updated_at AS updatedAt`;

function validationError(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}
const fail = validationError;

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).trim().toLowerCase();
  if (!h) return false;
  let hostname = h;
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    if (end === -1) return false;
    hostname = hostname.slice(1, end);
  } else if (hostname === '::1') {
    hostname = '::1';
  } else {
    const colon = hostname.indexOf(':');
    if (colon !== -1) {
      const rest = hostname.slice(colon + 1);
      if (rest.includes(':')) return false;
      hostname = hostname.slice(0, colon);
    }
  }
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
  return publicHosts.has(hostname);
}

const publicHosts = new Set(String(process.env.NITC_PUBLIC_HOST ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

function originAllowed(originHeader) {
  if (!originHeader) return true;
  const raw = String(originHeader).trim();
  if (!raw) return true;
  let url;
  try { url = new URL(raw); } catch { return false; }
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (url.protocol === 'http:' && loopback) return true;
  return url.protocol === 'https:' && publicHosts.has(hostname);
}

function hasJsonContentType(req) {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && ct.toLowerCase().includes('application/json');
}

function isEmptyBodyRequest(req) {
  const len = req.headers['content-length'];
  return len === undefined || len === '' || Number(len) === 0;
}

function fromRow(row) {
  if (!row) return null;
  return { ...row, done: Boolean(row.done), priority: row.priority === null ? null : Number(row.priority) };
}
function byId(id) { return fromRow(db.prepare(`SELECT ${columns} FROM tasks WHERE id = ?`).get(id)); }

if (Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n) === 0) {
  const seed = JSON.parse(readFileSync(resolve(dataDir, 'seed.json'), 'utf8'));
  const insert = db.prepare(`INSERT INTO tasks
    (id,title,course,type,due_date,notes,priority,done,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ts = now();
  db.exec('BEGIN');
  try {
    for (const task of seed) insert.run(task.id, task.title, task.course, task.type,
      task.dueDate, task.notes, task.priority, Number(task.done), ts, ts);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function listTasks({ view = 'all', course = '', q = '', from = '', to = '' } = {}) {
  if (!['all', 'todo', 'done'].includes(view)) throw fail('view must be all, todo, or done');
  const where = [];
  const args = [];
  if (view === 'todo') where.push('done = 0');
  if (view === 'done') where.push('done = 1');
  if (course) { where.push('course = ?'); args.push(course); }
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    where.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(notes), lower(?)) > 0 OR instr(lower(coalesce(course, '')), lower(?)) > 0)");
    args.push(token, token, token);
  }
  if (from) { where.push('due_date >= ?'); args.push(from); }
  if (to) { where.push('due_date <= ?'); args.push(to); }
  const ordering = view === 'done'
    ? 'COALESCE(due_date, \'0000-00-00\') DESC, updated_at DESC'
    : 'CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority DESC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at ASC';
  return db.prepare(`SELECT ${columns} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${ordering}`)
    .all(...args).map(fromRow);
}

function validateTask(input, { partial = false } = {}) {
  const result = {};
  const has = key => Object.prototype.hasOwnProperty.call(input, key);
  if (!partial || has('title')) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw fail('title is required');
    const title = input.title.trim();
    if (title.length > 180) throw fail('title must be at most 180 characters');
    result.title = title;
  }
  if (!partial || has('type')) {
    if (!['Coursework', 'Miscellaneous'].includes(input.type)) throw fail('type must be Coursework or Miscellaneous');
    result.type = input.type;
  }
  if (!partial || has('course') || has('type')) {
    const type = result.type ?? input.type;
    const course = has('course') ? input.course : undefined;
    if (type === 'Coursework') {
      const selected = typeof course === 'string' ? course.trim() : null;
      if (!courses.includes(selected)) throw fail(`a valid course is required for Coursework (${courses.join(', ')})`);
      result.course = selected;
    } else result.course = null;
  }
  if (!partial || has('dueDate')) {
    const date = input.dueDate ?? null;
    if (date !== null && !validDateOnly(date)) {
      throw fail('dueDate must be a date in YYYY-MM-DD format or null');
    }
    result.dueDate = date;
  }
  if (!partial || has('notes')) {
    const notes = input.notes ?? '';
    if (typeof notes !== 'string') throw fail('notes must be a string');
    if (notes.length > 5000) throw fail('notes must be at most 5000 characters');
    result.notes = notes;
  }
  if (!partial || has('priority')) {
    const priority = input.priority ?? null;
    if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 10)) throw fail('priority must be an integer from 1 to 10 or null');
    result.priority = priority;
  }
  return result;
}

function insertTask(input) {
  const task = validateTask(input);
  const id = randomUUID();
  const ts = now();
  db.prepare(`INSERT INTO tasks (id,title,course,type,due_date,notes,priority,done,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, task.title, task.course, task.type, task.dueDate,
    task.notes, task.priority, 0, ts, ts);
  return byId(id);
}

function updateTask(id, patch) {
  const current = byId(id);
  if (!current) return null;
  const next = validateTask({ ...current, ...patch });
  const propertyMap = { title: 'title', course: 'course', type: 'type', dueDate: 'due_date', notes: 'notes', priority: 'priority' };
  const fields = new Set(Object.keys(patch).filter(field => Object.prototype.hasOwnProperty.call(propertyMap, field)));
  if (patch.type === 'Miscellaneous') fields.add('course');
  const updates = [...fields].map(field => [field, next[field]]);
  if (Object.prototype.hasOwnProperty.call(patch, 'done')) {
    if (typeof patch.done !== 'boolean') throw fail('done must be boolean');
    updates.push(['done', patch.done]);
  }
  if (!updates.length) return current;
  const sql = updates.map(([field]) => `${propertyMap[field] ?? field} = ?`).join(', ');
  const values = updates.map(([field, value]) => field === 'done' ? Number(value) : value);
  db.prepare(`UPDATE tasks SET ${sql}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  return byId(id);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw fail('request body exceeds 1 MB');
  }
  if (!body) return {};
  const parsed = JSON.parse(body);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object' || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw fail('Invalid JSON body');
  }
  return parsed;
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const useLaunchdSocket = process.argv.includes('--launchd') || process.env.NITC_LAUNCHD === '1';
const idleTimeoutMs = Number(process.env.NITC_IDLE_MS ?? (useLaunchdSocket ? 120000 : 0));
let idleTimer = null;
function touchIdleTimer() {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  }, idleTimeoutMs);
  idleTimer.unref?.();
}

const server = http.createServer(async (req, res) => {
  touchIdleTimer();
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'Forbidden' });
      if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'Forbidden' });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'NITC HQ Tasks', timezone: 'Asia/Kolkata' });
      if (req.method === 'GET' && url.pathname === '/api/courses') return json(res, 200, { courses });
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        return json(res, 200, { tasks: listTasks({ view: url.searchParams.get('view') ?? 'all', course: url.searchParams.get('course') ?? '', q: url.searchParams.get('q') ?? '', from: url.searchParams.get('from') ?? '', to: url.searchParams.get('to') ?? '' }) });
      }
      if (url.pathname.startsWith('/api/tasks/')) {
        const pieces = url.pathname.slice('/api/tasks/'.length).split('/').map(decodeURIComponent);
        const id = pieces[0];
        const action = pieces[1];
        if (req.method === 'GET' && !action) {
          const task = byId(id);
          return task ? json(res, 200, { task }) : json(res, 404, { error: 'Task not found' });
        }
        if (req.method === 'PATCH' && !action) {
          if (!hasJsonContentType(req)) return json(res, 400, { error: 'Content-Type must be application/json' });
          const task = updateTask(id, await readBody(req));
          return task ? json(res, 200, { task }) : json(res, 404, { error: 'Task not found' });
        }
        if (req.method === 'POST' && ['complete', 'reopen'].includes(action)) {
          if (!hasJsonContentType(req) && !isEmptyBodyRequest(req)) return json(res, 400, { error: 'Content-Type must be application/json' });
          const task = updateTask(id, { done: action === 'complete' });
          return task ? json(res, 200, { task }) : json(res, 404, { error: 'Task not found' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        if (!hasJsonContentType(req)) return json(res, 400, { error: 'Content-Type must be application/json' });
        return json(res, 201, { task: insertTask(await readBody(req)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/study') {
        return json(res, 200, getStudyState({ days: url.searchParams.get('days') ?? 14 }));
      }
      if (req.method === 'POST' && url.pathname === '/api/study/start') {
        if (!hasJsonContentType(req) && !isEmptyBodyRequest(req)) return json(res, 400, { error: 'Content-Type must be application/json' });
        return json(res, 200, startStudyTimer(url.searchParams.get('days') ?? 14));
      }
      if (req.method === 'POST' && (url.pathname === '/api/study/pause' || url.pathname === '/api/study/end-day')) {
        if (!hasJsonContentType(req) && !isEmptyBodyRequest(req)) return json(res, 400, { error: 'Content-Type must be application/json' });
        return json(res, 200, { ...stopStudyTimer(url.searchParams.get('days') ?? 14), endedDay: url.pathname === '/api/study/end-day' });
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(publicDir, `.${pathname}`);
    if (!file.startsWith(`${publicDir}${sep}`) && file !== publicDir) return json(res, 403, { error: 'Forbidden' });
    if (!existsSync(file)) return json(res, 404, { error: 'Not found' });
    const content = readFileSync(file);
    const cacheControl = pathname.startsWith('/themes/') ? 'public, max-age=86400' : 'no-store';
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'content-length': content.length, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error?.status ?? (error instanceof SyntaxError ? 400 : 500);
    const message = status === 500 ? 'Internal error' : (error.message || 'Invalid request');
    json(res, status, { error: message });
  }
});

const taskSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    course: { type: ['string', 'null'], enum: [...courses, null] },
    type: { type: 'string', enum: ['Coursework', 'Miscellaneous'] },
    dueDate: { type: ['string', 'null'], description: 'Date-only YYYY-MM-DD; interpret relative dates in Asia/Kolkata. Omit when no due date is given.' },
    notes: { type: 'string' },
    priority: { type: ['integer', 'null'], minimum: 1, maximum: 10, description: 'Infer from urgency, consequences, and emphasis; 10 is highest.' }
  }, required: ['title', 'type', 'course']
};
const tools = [
  { name: 'list_tasks', description: 'List tasks in priority-descending, due-date-ascending order for open tasks. Use before creating a task when a possible duplicate may exist. Views: todo, done, all.', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['todo', 'done', 'all'], default: 'todo' }, course: { type: 'string', enum: courses }, q: { type: 'string' } } } },
  { name: 'search_tasks', description: 'Search task titles, notes, and courses to find existing work and disambiguate a completion request before changing anything.', inputSchema: { type: 'object', properties: { q: { type: 'string', minLength: 1 }, view: { type: 'string', enum: ['todo', 'done', 'all'], default: 'all' } }, required: ['q'] } },
  { name: 'get_task', description: 'Get one task by its exact id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_task', description: 'Create one concrete task the user explicitly says they need to do. Search first to avoid duplicates. Infer Coursework versus Miscellaneous and the matching course; infer priority from urgency (1–10). Do not invent a deadline. Resolve relative dates in Asia/Kolkata. No reminder is scheduled. A course is required for Coursework and must be null for Miscellaneous.', inputSchema: taskSchema },
  { name: 'update_task', description: 'Edit a task by exact id. Do not use this to resolve ambiguous task references; search first and ask the user if multiple tasks match.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, course: { type: ['string', 'null'], enum: [...courses, null] }, type: { type: 'string', enum: ['Coursework', 'Miscellaneous'] }, dueDate: { type: ['string', 'null'] }, notes: { type: 'string' }, priority: { type: ['integer', 'null'], minimum: 1, maximum: 10 } }, required: ['id'] } },
  { name: 'complete_task', description: 'Mark a task complete without deleting it. Search first; if the user reference matches multiple tasks, ask which one before changing it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'reopen_task', description: 'Reopen a completed task by exact id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_courses', description: 'List the supported course options and institution tags.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_study_summary', description: 'Read daily study hours, current streak, and active study timer state (Asia/Kolkata).', inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 90, default: 14 } } } }
];
function mcpResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
function mcpError(error) { return { content: [{ type: 'text', text: error.message || 'MCP tool failed' }], isError: true }; }
function callTool(name, args = {}) {
  switch (name) {
    case 'list_tasks': return mcpResult({ tasks: listTasks({ view: args.view ?? 'todo', course: args.course, q: args.q }) });
    case 'search_tasks': {
      if (typeof args.q !== 'string' || !args.q.trim()) throw fail('q must be a non-empty string');
      return mcpResult({ tasks: listTasks({ view: args.view ?? 'all', q: args.q ?? '' }) });
    }
    case 'get_task': { const task = byId(args.id); if (!task) throw new Error('Task not found'); return mcpResult({ task }); }
    case 'create_task': return mcpResult({ task: insertTask(args) });
    case 'update_task': { const { id, ...patch } = args; const task = updateTask(id, patch); if (!task) throw new Error('Task not found'); return mcpResult({ task }); }
    case 'complete_task': { const task = updateTask(args.id, { done: true }); if (!task) throw new Error('Task not found'); return mcpResult({ task }); }
    case 'reopen_task': { const task = updateTask(args.id, { done: false }); if (!task) throw new Error('Task not found'); return mcpResult({ task }); }
    case 'list_courses': return mcpResult({ courses: courses.map(course => ({ name: course, institution: course.startsWith('IIT Madras') ? 'IIT Madras' : 'NIT Calicut', color: course.startsWith('IIT Madras') ? 'purple' : 'green' })) });
    case 'get_study_summary': return mcpResult(getStudyState({ days: args.days ?? 14 }));
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function startMcp() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'notifications/initialized' || message.method?.startsWith('notifications/')) return;
    let result;
    try {
      switch (message.method) {
        case 'initialize': result = { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'nitc-hq-tasks', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call': result = callTool(message.params?.name, message.params?.arguments ?? {}); break;
        default:
          if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
          return;
      }
      if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    } catch (error) {
      const resultError = { content: [{ type: 'text', text: error.message || 'Request failed' }], isError: true };
      if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: resultError })}\n`);
    }
  });
}

if (process.argv.includes('--mcp')) startMcp();
else {
  const port = Number(process.env.PORT ?? 4173);
  server.on('error', error => {
    process.stderr.write(`Server error: ${error.message}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (useLaunchdSocket) {
    touchIdleTimer();
    server.listen({ fd: 0 }, () => process.stdout.write('NITC HQ Tasks listening via launchd socket activation\n'));
  } else {
    server.listen(port, '127.0.0.1', () => process.stdout.write(`NITC HQ Tasks is available at http://127.0.0.1:${server.address().port}\n`));
  }
}
