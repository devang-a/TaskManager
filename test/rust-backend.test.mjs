import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const project = resolve(import.meta.dirname, '..');
const rustBin = join(project, 'backend-rs', 'target', 'release', 'nitc-hq-backend');

function waitForUrl(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Rust server did not start: ${stdout}`)), 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolvePromise(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Rust server exited (${code}): ${stdout}`)); });
  });
}
function nextMcpMessage(rl) {
  return new Promise(resolvePromise => rl.once('line', line => resolvePromise(JSON.parse(line))));
}

test('Rust backend has full REST, MCP, theme, and study timer parity', { skip: !existsSync(rustBin) }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nitc-hq-rust-'));
  const dbFile = join(temp, 'tasks.sqlite');
  const server = spawn(rustBin, [], { env: { ...process.env, PORT: '0', NITC_TASKS_DB: dbFile, NITC_PROJECT_ROOT: project }, stdio: ['ignore', 'pipe', 'pipe'] });
  let mcp;
  try {
    const base = await waitForUrl(server);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.timezone, 'Asia/Kolkata');

    const themeResp = await fetch(`${base}/themes/night-reef.svg`);
    assert.equal(themeResp.status, 200);
    assert.equal(themeResp.headers.get('content-type'), 'image/svg+xml');
    assert.match(themeResp.headers.get('cache-control') || '', /max-age=86400/);

    const seeded = await (await fetch(`${base}/api/tasks?view=all`)).json();
    assert.equal(seeded.tasks.length, 15);
    const seedSnapshot = JSON.parse(await readFile(join(project, 'data', 'seed.json'), 'utf8'));
    const normalize = task => ({ id: task.id, title: task.title, course: task.course, type: task.type, dueDate: task.dueDate, notes: task.notes, priority: task.priority, done: task.done });
    assert.deepEqual(seeded.tasks.map(normalize).sort((a, b) => a.id.localeCompare(b.id)), seedSnapshot.map(normalize).sort((a, b) => a.id.localeCompare(b.id)));

    const invalid = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Bad priority', type: 'Coursework', course: 'Mechanics', priority: 11 }) });
    assert.equal(invalid.status, 400);
    const invalidDate = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Bad date', type: 'Coursework', course: 'Mechanics', priority: 3, dueDate: '2026-02-31' }) });
    assert.equal(invalidDate.status, 400);

    const created = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Rust mechanics task', type: 'Coursework', course: 'Mechanics', priority: 6, dueDate: null, notes: 'Rust parity check' }) })).json();
    const taskId = created.task.id;
    assert.equal(created.task.course, 'Mechanics');

    const multiSearch = await (await fetch(`${base}/api/tasks?view=all&q=Rust%20parity`)).json();
    assert.equal(multiSearch.tasks.length, 1);

    const patched = await (await fetch(`${base}/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'Miscellaneous', notes: 'Updated via Rust' }) })).json();
    assert.equal(patched.task.course, null);
    await fetch(`${base}/api/tasks/${taskId}/complete`, { method: 'POST' });
    assert.equal((await (await fetch(`${base}/api/tasks/${taskId}`)).json()).task.done, true);
    await fetch(`${base}/api/tasks/${taskId}/reopen`, { method: 'POST' });
    assert.equal((await (await fetch(`${base}/api/tasks/${taskId}`)).json()).task.done, false);

    // Study timer endpoints
    const started = await (await fetch(`${base}/api/study/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(started.running, true);
    await new Promise(r => setTimeout(r, 1100));
    const ended = await (await fetch(`${base}/api/study/end-day?days=7`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(ended.running, false);
    assert.equal(ended.endedDay, true);
    assert.ok(ended.todaySavedSeconds >= 1);
    assert.equal(ended.summary.streak, 1);

    // MCP stdio parity
    mcp = spawn(rustBin, ['--mcp'], { env: { ...process.env, NITC_TASKS_DB: dbFile, NITC_PROJECT_ROOT: project }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: mcp.stdout, crlfDelay: Infinity });
    let requestId = 1;
    const send = async (method, params = {}) => {
      const id = requestId++;
      const p = nextMcpMessage(rl);
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return (await p).result;
    };
    const init = await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.serverInfo.name, 'nitc-hq-tasks');
    const searched = await send('tools/call', { name: 'search_tasks', arguments: { q: 'Rust Updated' } });
    assert.equal(searched.structuredContent.tasks.length, 1);
    const studySummary = await send('tools/call', { name: 'get_study_summary', arguments: { days: 7 } });
    assert.equal(studySummary.structuredContent.summary.streak, 1);
  } finally {
    if (mcp) mcp.kill('SIGTERM');
    server.kill('SIGTERM');
    await rm(temp, { recursive: true, force: true });
  }
});
