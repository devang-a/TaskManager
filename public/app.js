let courseNames = [
  'General Physics Lab', 'Thermodynamics', 'Engineering Graphics', 'Mechanics',
  'Mechanical Workshop', 'Mathematics I', 'Chemical Structure and Bonding',
  'IIT Madras — Programming with Python', 'IIT Madras — English 1'
];
const state = { view: 'todo', course: '', search: '', tasks: [], month: firstOfMonth(new Date()) };
const $ = selector => document.querySelector(selector);
const taskList = $('#task-list');
const calendarView = $('#calendar-view');
const dialog = $('#task-dialog');
const form = $('#task-form');
let toastTimer;
const pendingToggles = new Set();

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function firstOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = name => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function formatDate(dateString, options = { month: 'short', day: 'numeric' }) {
  if (!dateString) return '';
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-IN', options);
}
function courseClass(course) { return course?.startsWith('IIT Madras') ? 'iit' : ''; }
function dueClass(task) {
  if (!task.dueDate || task.done) return '';
  if (task.dueDate < todayISO()) return 'overdue';
  const days = (Date.parse(`${task.dueDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86400000;
  return days <= 2 ? 'due-soon' : '';
}
function relativeDue(dateString) {
  if (!dateString) return '';
  if (dateString === todayISO()) return 'Today';
  const tomorrow = new Date(`${todayISO()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (dateString === tomorrow.toISOString().slice(0, 10)) return 'Tomorrow';
  return formatDate(dateString);
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}
function showUndoToast(message, onUndo) {
  const toast = $('#toast');
  toast.textContent = '';
  const label = document.createElement('span');
  label.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Undo';
  button.className = 'toast-undo';
  button.addEventListener('click', async () => {
    toast.classList.remove('show');
    await onUndo();
  });
  toast.append(label, button);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}
async function request(url, options) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function matchesView(task, view) {
  if (view === 'all') return true;
  if (view === 'done') return task.done;
  if (view === 'calendar') return true;
  return !task.done;
}
function visibleTasks() {
  const tokens = state.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return state.tasks.filter(task => {
    const inView = matchesView(task, state.view);
    const inCourse = !state.course || task.course === state.course;
    const searchable = `${task.title} ${task.notes} ${task.course ?? ''}`.toLocaleLowerCase();
    return inView && inCourse && tokens.every(token => searchable.includes(token));
  });
}
function renderMetrics() {
  const open = state.tasks.filter(task => !task.done);
  const done = state.tasks.filter(task => task.done);
  const setText = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
  setText('#open-metric', open.length);
  setText('#done-metric', done.length);
  setText('#side-open', open.length);
  setText('#side-done', done.length);
  setText('#due-metric', open.filter(task => task.dueDate === todayISO()).length);
  setText('#todo-count', open.length);
}
function currentViewText() {
  return ({ todo: ['To do', '', '', 'To do', ''], done: ['Done', '', '', 'Done', ''], all: ['All tasks', '', '', 'All tasks', ''], calendar: ['Calendar', '', '', 'Calendar', ''], study: ['Study', '', '', 'Study', ''] })[state.view];
}
function renderHeader() {
  const [name] = currentViewText();
  const pageTitle = $('#page-title');
  if (pageTitle) pageTitle.textContent = state.course || name;
  if (state.view !== 'study') document.title = `${name} · NITC HQ Tasks`;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  const inStudy = state.view === 'study';
  document.body.classList.toggle('study-mode', inStudy);
  const studyStage = $('#study-stage');
  if (studyStage) studyStage.hidden = !inStudy;
  const musicDock = $('#music-dock');
  if (musicDock) musicDock.hidden = !inStudy;
  if (!inStudy && typeof music !== 'undefined') music.queueOpen = false;
}
function renderCourseNav() {
  const courseNav = $('#course-nav');
  if (!courseNav) return;
  courseNav.innerHTML = courseNames.map(course => `<button class="course-link ${courseClass(course)} ${state.course === course ? 'selected' : ''}" data-course="${escapeHTML(course)}"><i class="course-dot" aria-hidden="true"></i><span>${escapeHTML(course)}</span></button>`).join('');
}
function syncCourseSelects() {
  const filter = $('#course-filter');
  const currentFilter = filter.value;
  filter.innerHTML = `<option value="">All courses</option>${courseNames.map(course => `<option value="${escapeHTML(course)}">${escapeHTML(course)}</option>`).join('')}`;
  filter.value = courseNames.includes(currentFilter) ? currentFilter : state.course;
  const taskCourse = $('#task-course');
  const currentTaskCourse = taskCourse.value;
  taskCourse.innerHTML = courseNames.map(course => `<option value="${escapeHTML(course)}">${escapeHTML(course)}</option>`).join('');
  if (courseNames.includes(currentTaskCourse)) taskCourse.value = currentTaskCourse;
}
function taskRow(task) {
  const title = escapeHTML(task.title);
  const course = task.course
    ? `<span class="course-pill ${courseClass(task.course)}"><i class="course-mini-dot" aria-hidden="true"></i>${escapeHTML(task.course)}</span>`
    : '<span class="course-pill misc"><i class="course-mini-dot" aria-hidden="true"></i>Miscellaneous</span>';
  const dueText = relativeDue(task.dueDate);
  const priority = task.priority == null
    ? '<span class="priority-tag none" aria-label="No priority"></span>'
    : `<span class="priority-tag ${task.priority >= 9 ? 'high' : ''}">P${task.priority}</span>`;
  return `<article class="task-row ${task.done ? 'is-done' : ''}" data-task-row="${escapeHTML(task.id)}">
    <button class="task-check" type="button" data-toggle-task="${escapeHTML(task.id)}" aria-pressed="${task.done}" aria-label="${task.done ? 'Reopen' : 'Complete'} ${title}">${task.done ? '✓' : ''}</button>
    <div class="task-main" role="button" tabindex="0" data-open-task="${escapeHTML(task.id)}" aria-label="Edit ${title}"><div class="task-title">${title}</div><div class="task-meta">${course}</div></div>
    <time class="task-date ${dueClass(task)}" datetime="${escapeHTML(task.dueDate ?? '')}">${escapeHTML(dueText)}</time>
    ${priority}
  </article>`;
}
function renderList() {
  const tasks = visibleTasks();
  $('#list-count').textContent = state.view === 'calendar' ? tasks.filter(task => task.dueDate).length : tasks.length;
  taskList.classList.toggle('done-view', state.view === 'done');
  taskList.hidden = state.view === 'calendar';
  calendarView.hidden = state.view !== 'calendar';
  if (state.view === 'calendar') { renderCalendar(tasks); return; }
  if (!tasks.length) {
    const title = state.search || state.course ? 'No tasks match this view' : state.view === 'done' ? 'Nothing completed just yet' : 'You’re all caught up';
    const description = state.search || state.course ? 'Try a different search or course filter.' : state.view === 'done' ? 'Completed tasks will stay here for your reference.' : 'Enjoy the breathing room, or add something new when you are ready.';
    taskList.innerHTML = `<div class="empty-state"><span class="empty-icon">✳</span><strong>${title}</strong><p>${description}</p></div>`;
    return;
  }
  taskList.innerHTML = tasks.map(taskRow).join('');
}
function renderCalendar(tasks) {
  const y = state.month.getFullYear();
  const m = state.month.getMonth();
  const monthName = state.month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const monthStart = new Date(y, m, 1);
  const mondayOffset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(y, m, 1 - mondayOffset);
  const monthTasks = tasks.filter(task => task.dueDate && task.dueDate.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`));
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let cells = dayNames.map(day => `<div class="calendar-weekday">${day}</div>`).join('');
  for (let index = 0; index < 42; index++) {
    const date = new Date(gridStart); date.setDate(gridStart.getDate() + index);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dayTasks = monthTasks.filter(task => task.dueDate === iso);
    cells += `<div class="calendar-day ${date.getMonth() !== m ? 'muted' : ''} ${iso === todayISO() ? 'today' : ''}" role="listitem" aria-label="${escapeHTML(formatDate(iso, { month: 'long', day: 'numeric' }))}"><span class="day-number">${date.getDate()}</span>${dayTasks.map(task => `<button type="button" class="calendar-task ${courseClass(task.course)} ${task.done ? 'done' : ''}" data-open-task="${escapeHTML(task.id)}" aria-label="${escapeHTML(task.title)}${task.done ? ', completed' : ''}">${escapeHTML(task.title)}</button>`).join('')}</div>`;
  }
  calendarView.innerHTML = `<div class="calendar-head"><strong>${escapeHTML(monthName)}</strong><div class="calendar-nav"><button type="button" data-month="-1" aria-label="Previous month">‹</button><button type="button" data-month="1" aria-label="Next month">›</button></div></div><div class="calendar-grid" role="list" aria-label="${escapeHTML(monthName)} calendar">${cells}</div>`;
}
function render() { renderHeader(); renderMetrics(); renderCourseNav(); syncCourseSelects(); renderList(); }
async function loadTasks() {
  try {
    const data = await request('/api/tasks?view=all');
    state.tasks = data.tasks;
    render();
  } catch (error) { taskList.innerHTML = `<div class="empty-state"><strong>Could not load tasks</strong><p>${escapeHTML(error.message)}</p></div>`; }
}
function openTask(task = null) {
  form.reset();
  $('#form-error').hidden = true;
  $('#dialog-title').textContent = task ? 'Edit task' : 'New task';
  $('#save-task').textContent = task ? 'Save changes' : 'Save task';
  $('#task-form [name=id]').value = task?.id ?? '';
  $('#task-title').value = task?.title ?? '';
  $('#task-type').value = task?.type ?? (state.course ? 'Coursework' : 'Coursework');
  $('#task-course').value = task?.course ?? state.course ?? courseNames[0];
  $('#task-due').value = task?.dueDate ?? '';
  $('#task-priority').value = task ? (task.priority ?? '') : '5';
  $('#task-notes').value = task?.notes ?? '';
  syncCourseField();
  dialog.showModal();
  $('#task-title').focus();
}
function syncCourseField() {
  const coursework = $('#task-type').value === 'Coursework';
  $('#course-field').hidden = !coursework;
  $('#task-course').disabled = !coursework;
}
async function saveForm(event) {
  event.preventDefault();
  const id = $('#task-form [name=id]').value;
  const type = $('#task-type').value;
  const payload = {
    title: $('#task-title').value.trim(),
    type,
    course: type === 'Coursework' ? $('#task-course').value : null,
    dueDate: $('#task-due').value || null,
    priority: $('#task-priority').value ? Number($('#task-priority').value) : null,
    notes: $('#task-notes').value
  };
  try {
    await request(id ? `/api/tasks/${encodeURIComponent(id)}` : '/api/tasks', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    dialog.close();
    await loadTasks();
    showToast(id ? 'Changes saved' : 'Task added');
  } catch (error) {
    $('#form-error').textContent = error.message;
    $('#form-error').hidden = false;
  }
}
async function toggleTask(id) {
  if (pendingToggles.has(id)) return;
  const task = state.tasks.find(item => item.id === id);
  if (!task) return;
  pendingToggles.add(id);
  document.querySelectorAll(`[data-toggle-task="${CSS.escape(id)}"]`).forEach(button => { button.disabled = true; });
  try {
    await request(`/api/tasks/${encodeURIComponent(id)}/${task.done ? 'reopen' : 'complete'}`, { method: 'POST', body: '{}' });
    await loadTasks();
    if (task.done) {
      showToast('Task reopened');
    } else {
      showUndoToast('Nice work — task completed', async () => {
        try {
          await request(`/api/tasks/${encodeURIComponent(id)}/reopen`, { method: 'POST', body: '{}' });
          await loadTasks();
        } catch (error) { showToast(error.message); }
      });
    }
  } catch (error) { showToast(error.message); }
  finally {
    pendingToggles.delete(id);
    document.querySelectorAll(`[data-toggle-task="${CSS.escape(id)}"]`).forEach(button => { button.disabled = false; });
  }
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.view === 'study') {
    if (state.view !== 'study') study.lastView = state.view;
    state.view = 'study';
    renderHeader();
    loadStudy();
    loadMusicState();
    return;
  }
  state.view = button.dataset.view;
  state.course = '';
  $('#course-filter').value = '';
  render();
}));
$('#course-nav')?.addEventListener('click', event => {
  const button = event.target.closest('[data-course]');
  if (!button) return;
  state.course = state.course === button.dataset.course ? '' : button.dataset.course;
  $('#course-filter').value = state.course;
  if (state.view === 'calendar') state.view = 'todo';
  render();
});
document.querySelector('.brand')?.addEventListener('click', event => {
  event.preventDefault();
  state.view = 'todo';
  state.course = '';
  $('#course-filter').value = '';
  render();
});
$('#course-filter').addEventListener('change', event => { state.course = event.target.value; if (state.view === 'calendar') state.view = 'todo'; render(); });
$('#search').addEventListener('input', event => { state.search = event.target.value; renderHeader(); renderMetrics(); renderList(); });
$('#new-task').addEventListener('click', () => openTask());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
$('#task-type').addEventListener('change', syncCourseField);
form.addEventListener('submit', saveForm);
$('#task-priority').innerHTML = '<option value="">No priority</option>' + Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1}${index === 9 ? ' · Highest' : index === 0 ? ' · Lowest' : ''}</option>`).join('');
document.addEventListener('click', event => {
  const toggle = event.target.closest('[data-toggle-task]');
  if (toggle) { toggleTask(toggle.dataset.toggleTask); return; }
  const open = event.target.closest('[data-open-task]');
  if (open) { const task = state.tasks.find(item => item.id === open.dataset.openTask); if (task) openTask(task); return; }
  const month = event.target.closest('[data-month]');
  if (month) { state.month.setMonth(state.month.getMonth() + Number(month.dataset.month)); renderList(); }
});
document.addEventListener('keydown', event => {
  const target = event.target.closest('[data-open-task][role="button"]');
  if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); const task = state.tasks.find(item => item.id === target.dataset.openTask); if (task) openTask(task); }
});
function maybeAutoReload() {
  if (dialog.open) return;
  loadTasks();
  loadStudy();
  if (state.view === 'study') loadMusicState();
}

/* Study Timer & Daily Progress Graph */
const study = {
  range: 14,
  running: false,
  runningSince: null,
  today: todayISO(),
  todaySavedSeconds: 0,
  days: [],
  summary: { todaySeconds: 0, weekSeconds: 0, totalSeconds: 0, avgSeconds: 0, streak: 0, bestDaySeconds: 0, activeDays: 0 },
  graphOpen: false,
  busy: false,
  lastView: 'todo'
};
const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 7 5.2Z"/></svg>';
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.4"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.4"/></svg>';

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function formatShortClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function formatDurationHuman(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s === 0) return '0m';
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
function istMidnightMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00Z`) - 330 * 60 * 1000;
}
function liveDeltaTodaySeconds() {
  if (!study.running || !study.runningSince) return 0;
  const startMs = Math.max(Date.parse(study.runningSince), istMidnightMs(todayISO()));
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}
function liveTodaySeconds() {
  const currentDay = todayISO();
  const base = study.today === currentDay ? study.todaySavedSeconds : 0;
  return base + liveDeltaTodaySeconds();
}
function applyStudyPayload(data) {
  study.today = data.today;
  study.running = Boolean(data.running);
  study.runningSince = data.runningSince || null;
  study.todaySavedSeconds = Number(data.todaySavedSeconds || 0);
  study.days = Array.isArray(data.days) ? data.days : [];
  study.summary = data.summary || study.summary;
  renderStudy();
}
async function loadStudy() {
  try {
    const data = await request(`/api/study?days=${study.range}`);
    applyStudyPayload(data);
  } catch { /* ignore transient background poll errors */ }
}
function formatWallClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date).toUpperCase();
}
function renderStudyClockOnly() {
  const currentDay = todayISO();
  if (study.today && study.today !== currentDay) {
    loadStudy();
    return;
  }
  const todaySecs = liveTodaySeconds();
  const clockEl = $('#study-clock');
  if (clockEl) {
    clockEl.textContent = formatClock(todaySecs);
    clockEl.classList.toggle('is-running', study.running);
  }
  const dayEl = $('#study-day-label');
  if (dayEl) dayEl.textContent = formatWallClock();
  const badge = $('#study-nav-badge');
  if (badge) {
    badge.hidden = !study.running;
    if (study.running) badge.textContent = formatShortClock(todaySecs);
  }
  if (state.view === 'study') {
    document.title = study.running ? `${formatClock(todaySecs)} · Study · NITC HQ` : 'Study timer · NITC HQ Tasks';
  }
  if (study.graphOpen && study.running) {
    renderStudyGraph();
  }
}
function renderStudy() {
  const todaySecs = liveTodaySeconds();
  const dayEl = $('#study-day-label');
  if (dayEl) dayEl.textContent = formatWallClock();
  const pulse = $('#study-pulse');
  if (pulse) pulse.classList.toggle('is-live', study.running);

  const toggleBtn = $('#study-toggle');
  const toggleIcon = $('#study-toggle-icon');
  const toggleLabel = $('#study-toggle-label');
  if (toggleBtn && toggleIcon && toggleLabel) {
    toggleBtn.classList.toggle('is-running', study.running);
    toggleIcon.innerHTML = study.running ? PAUSE_ICON : PLAY_ICON;
    toggleLabel.textContent = study.running ? 'Pause' : todaySecs > 0 ? 'Resume' : 'Start studying';
  }

  const finishBtn = $('#study-finish');
  if (finishBtn) finishBtn.hidden = !(study.running || todaySecs > 0);

  const graphPanel = $('#study-graph-panel');
  const graphToggle = $('#study-graph-toggle');
  if (graphPanel && graphToggle) {
    graphPanel.hidden = !study.graphOpen;
    graphToggle.setAttribute('aria-expanded', String(study.graphOpen));
  }

  renderStudyClockOnly();
  if (study.graphOpen) renderStudyGraph();
}
function renderStudyGraph() {
  const todaySecs = liveTodaySeconds();
  const baseToday = study.summary.todaySeconds || 0;
  const extra = Math.max(0, todaySecs - baseToday);
  const weekSecs = (study.summary.weekSeconds || 0) + extra;
  const totalSecs = (study.summary.totalSeconds || 0) + extra;
  const bestSecs = Math.max(study.summary.bestDaySeconds || 0, todaySecs);
  const streak = todaySecs > 0 ? Math.max(1, study.summary.streak || 0) : (study.summary.streak || 0);

  const days = study.days.map(d => d.date === study.today ? { ...d, seconds: todaySecs } : d);
  const rangeTotal = days.reduce((sum, d) => sum + d.seconds, 0);
  const avgSecs = days.length ? Math.round(rangeTotal / days.length) : 0;

  $('#stat-study-today').textContent = formatDurationHuman(todaySecs);
  $('#stat-study-week').textContent = formatDurationHuman(weekSecs);
  $('#stat-study-avg').textContent = formatDurationHuman(avgSecs);
  $('#stat-study-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`;

  document.querySelectorAll('[data-study-range]').forEach(btn => {
    btn.setAttribute('aria-selected', String(Number(btn.dataset.studyRange) === study.range));
  });

  const foot = $('#study-graph-foot');
  if (foot) {
    if (totalSecs === 0) {
      foot.textContent = 'Start your first session — every minute shows up here.';
    } else {
      foot.textContent = `${formatDurationHuman(totalSecs)} studied all time · best day ${formatDurationHuman(bestSecs)}`;
    }
  }

  const chart = $('#study-chart');
  if (!chart || !days.length) return;
  const W = 640;
  const H = 200;
  const padL = 36;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxSecs = Math.max(...days.map(d => d.seconds), 0);
  const maxHoursRaw = maxSecs / 3600;
  const scaleHours = maxHoursRaw <= 1 ? 1 : maxHoursRaw <= 2 ? 2 : maxHoursRaw <= 4 ? 4 : maxHoursRaw <= 6 ? 6 : maxHoursRaw <= 8 ? 8 : Math.ceil(maxHoursRaw / 2) * 2;
  const maxScaleSecs = scaleHours * 3600;

  const gridTicks = [0, 0.5, 1];
  const gridLines = gridTicks.map(ratio => {
    const y = padT + plotH * (1 - ratio);
    const val = scaleHours * ratio;
    const label = val === 0 ? '0h' : Number.isInteger(val) ? `${val}h` : `${val.toFixed(1)}h`;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="chart-grid-line"/><text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" class="chart-y-label">${label}</text>`;
  }).join('');

  const step = days.length > 1 ? plotW / (days.length - 1) : plotW;
  const labelEvery = days.length <= 7 ? 1 : days.length <= 14 ? 2 : 5;
  const baselineY = padT + plotH;

  const avgY = avgSecs > 0 ? padT + plotH * (1 - Math.min(1, avgSecs / maxScaleSecs)) : null;
  const avgLine = avgY !== null
    ? `<line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${W - padR}" y2="${avgY.toFixed(1)}" class="chart-avg-line"/>`
    : '';

  const points = days.map((d, i) => {
    const x = days.length > 1 ? padL + step * i : padL + plotW / 2;
    const ratio = Math.min(1, d.seconds / maxScaleSecs);
    const y = padT + plotH * (1 - ratio);
    return { ...d, i, x, y, isToday: d.date === study.today };
  });

  // Smooth monotone-clamped cubic Bezier line path (never dips below baseline)
  let linePath = '';
  if (points.length === 1) {
    linePath = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  } else {
    linePath = points.map((pt, idx) => {
      if (idx === 0) return `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      const prev = points[idx - 1];
      const midX = ((prev.x + pt.x) / 2).toFixed(1);
      return `C ${midX} ${prev.y.toFixed(1)}, ${midX} ${pt.y.toFixed(1)}, ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    }).join(' ');
  }
  const areaPath = points.length > 1
    ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${baselineY.toFixed(1)} L ${points[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`
    : '';

  const hitW = days.length > 1 ? step : plotW;
  const nodes = points.map(pt => {
    const showLabel = pt.isToday || pt.i === 0 || pt.i % labelEvery === 0;
    const shortDate = pt.isToday ? 'Today' : formatDate(pt.date, { day: 'numeric', month: 'short' });
    const fullDate = formatDate(pt.date, { weekday: 'short', day: 'numeric', month: 'short' });
    const tipText = `${fullDate} · ${pt.seconds > 0 ? formatDurationHuman(pt.seconds) : 'No study logged'}`;
    const dotCls = pt.isToday ? 'chart-dot is-today' : pt.seconds > 0 ? 'chart-dot' : 'chart-dot is-empty';
    const hitX = Math.max(padL, pt.x - hitW / 2);
    const hitWidth = Math.min(W - padR - hitX, hitW);
    return `<g class="chart-col" tabindex="0" data-tip="${escapeHTML(tipText)}" data-cx="${pt.x.toFixed(1)}" data-top="${pt.y.toFixed(1)}" aria-label="${escapeHTML(tipText)}">
      <line x1="${pt.x.toFixed(1)}" y1="${padT}" x2="${pt.x.toFixed(1)}" y2="${baselineY.toFixed(1)}" class="chart-guide"/>
      <rect x="${hitX.toFixed(1)}" y="${padT}" width="${Math.max(12, hitWidth).toFixed(1)}" height="${plotH}" class="chart-hit"/>
      ${pt.isToday ? `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="7" class="chart-dot-halo"/>` : ''}
      <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${pt.isToday ? 4 : pt.seconds > 0 ? 3 : 2.2}" class="${dotCls}"/>
      ${showLabel ? `<text x="${pt.x.toFixed(1)}" y="${H - 7}" class="chart-x-label ${pt.isToday ? 'is-today' : ''}">${escapeHTML(shortDate)}</text>` : ''}
    </g>`;
  }).join('');

  chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Study hours over the last ${days.length} days">
    <defs>
      <linearGradient id="reef-area-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    ${gridLines}
    ${avgLine}
    ${areaPath ? `<path d="${areaPath}" class="chart-area"/>` : ''}
    <path d="${linePath}" class="chart-line"/>
    ${nodes}
  </svg>`;
}
async function toggleStudyTimer() {
  if (study.busy) return;
  study.busy = true;
  try {
    const endpoint = study.running ? '/api/study/pause' : '/api/study/start';
    const data = await request(`${endpoint}?days=${study.range}`, { method: 'POST', body: '{}' });
    applyStudyPayload(data);
  } catch (error) { showToast(error.message); }
  finally { study.busy = false; }
}
async function finishStudyDay() {
  if (study.busy) return;
  study.busy = true;
  try {
    const data = await request(`/api/study/end-day?days=${study.range}`, { method: 'POST', body: '{}' });
    study.graphOpen = true;
    applyStudyPayload(data);
    showToast(`Saved ${formatDurationHuman(data.todayTotalSeconds)} for today`);
  } catch (error) { showToast(error.message); }
  finally { study.busy = false; }
}
$('#study-toggle')?.addEventListener('click', toggleStudyTimer);
$('#study-finish')?.addEventListener('click', finishStudyDay);
$('#study-exit')?.addEventListener('click', () => {
  study.graphOpen = false;
  state.view = study.lastView || 'todo';
  render();
});
$('#study-graph-toggle')?.addEventListener('click', () => {
  study.graphOpen = !study.graphOpen;
  renderStudy();
});
$('#study-graph-close')?.addEventListener('click', () => {
  study.graphOpen = false;
  renderStudy();
});
document.querySelectorAll('[data-study-range]').forEach(btn => btn.addEventListener('click', () => {
  study.range = Number(btn.dataset.studyRange);
  loadStudy();
}));
const chartContainer = $('#study-chart');
const chartTooltip = $('#study-chart-tooltip');
function showChartTip(col) {
  if (!col || !chartTooltip || !chartContainer) return;
  chartTooltip.textContent = col.dataset.tip;
  chartTooltip.hidden = false;
  const svg = chartContainer.querySelector('svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const xRatio = Number(col.dataset.cx) / 640;
  const yRatio = Number(col.dataset.top) / 200;
  chartTooltip.style.left = `${Math.max(56, Math.min(rect.width - 56, rect.width * xRatio))}px`;
  chartTooltip.style.top = `${Math.max(4, rect.height * yRatio - 10)}px`;
}
chartContainer?.addEventListener('pointerover', e => { const col = e.target.closest('.chart-col'); if (col) showChartTip(col); });
chartContainer?.addEventListener('focusin', e => { const col = e.target.closest('.chart-col'); if (col) showChartTip(col); });
chartContainer?.addEventListener('pointerleave', () => { if (chartTooltip) chartTooltip.hidden = true; });
chartContainer?.addEventListener('focusout', () => { if (chartTooltip) chartTooltip.hidden = true; });

document.addEventListener('keydown', event => {
  if (state.view !== 'study' || dialog.open) return;
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.code === 'Space' && !event.target.closest('button')) {
    event.preventDefault();
    toggleStudyTimer();
  } else if ((event.key === 'g' || event.key === 'G') && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    study.graphOpen = !study.graphOpen;
    renderStudy();
  } else if ((event.key === 't' || event.key === 'T') && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    cycleTheme();
  } else if (event.key === 'Escape') {
    if (music.queueOpen) {
      music.queueOpen = false;
      renderMusic();
    } else if (study.graphOpen) {
      study.graphOpen = false;
      renderStudy();
    } else {
      state.view = study.lastView || 'todo';
      render();
    }
  }
});
setInterval(renderStudyClockOnly, 1000);

/* Apple Music Study Connector */
const music = {
  running: false,
  state: 'stopped',
  shuffle: false,
  repeat: 'off',
  volume: 80,
  position: 0,
  syncedAt: 0,
  track: null,
  playlist: null,
  queueOpen: false,
  queueTracks: [],
  artTrackId: '',
  busy: false
};

function formatTrackTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}
function liveMusicPosition() {
  if (!music.track) return 0;
  const dur = Number(music.track.duration) || 0;
  if (music.state !== 'playing') return Math.min(dur, music.position);
  const elapsed = Math.max(0, (Date.now() - music.syncedAt) / 1000);
  return Math.min(dur, music.position + elapsed);
}
function applyMusicState(data) {
  music.running = Boolean(data?.running);
  music.state = data?.state || 'stopped';
  music.shuffle = Boolean(data?.shuffle);
  music.repeat = data?.repeat || 'off';
  music.volume = Number.isFinite(Number(data?.volume)) ? Number(data.volume) : music.volume;
  music.position = Number(data?.position) || 0;
  music.syncedAt = Date.now();
  music.track = data?.track || null;
  music.playlist = data?.playlist || null;
  renderMusic();
}
async function loadMusicState() {
  try {
    const data = await request('/api/music/state');
    applyMusicState(data);
    if (music.queueOpen && music.running) loadMusicQueue();
  } catch { /* ignore if backend unavailable */ }
}
async function loadMusicQueue() {
  try {
    const data = await request('/api/music/queue');
    music.queueTracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (data.playlist) music.playlist = data.playlist;
    renderMusicQueue();
  } catch { /* ignore */ }
}
async function sendMusicControl(payload) {
  if (music.busy) return;
  music.busy = true;
  try {
    const data = await request('/api/music/control', { method: 'POST', body: JSON.stringify(payload) });
    applyMusicState(data);
    if (music.queueOpen && music.running) loadMusicQueue();
  } catch (error) { showToast(error.message); }
  finally { music.busy = false; }
}
const MUSIC_PLAY_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 5.4c0-.72.78-1.17 1.4-.81l11.2 6.6c.61.36.61 1.26 0 1.62l-11.2 6.6c-.62.36-1.4-.09-1.4-.81V5.4z"/></svg>';
const MUSIC_PAUSE_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4.4" height="15" rx="1.6"/><rect x="13.6" y="4.5" width="4.4" height="15" rx="1.6"/></svg>';

function renderMusicProgress() {
  if (!windowVisible || document.visibilityState === 'hidden') return;
  if (state.view !== 'study' || !music.running || !music.track) return;
  const dur = Number(music.track.duration) || 0;
  const pos = liveMusicPosition();
  if (music.state === 'playing' && dur > 0 && pos >= dur - 0.5 && Date.now() - music.syncedAt > 2000) {
    loadMusicState();
  }
}
function renderMusic() {
  const dock = $('#music-dock');
  if (!dock) return;
  dock.hidden = state.view !== 'study';
  const idleBar = $('#music-idle-bar');
  const playerBar = $('#music-player-bar');
  const queuePanel = $('#music-queue-panel');
  const hasTrack = music.running && Boolean(music.track);
  if (idleBar) idleBar.hidden = hasTrack;
  if (playerBar) playerBar.hidden = !hasTrack;
  if (queuePanel) queuePanel.hidden = !(hasTrack && music.queueOpen);
  const queueBtn = $('#music-queue-btn');
  if (queueBtn) queueBtn.setAttribute('aria-expanded', String(Boolean(hasTrack && music.queueOpen)));
  if (!hasTrack) return;

  $('#music-title').textContent = music.track.name || 'Unknown track';
  $('#music-artist').textContent = music.track.artist || music.track.album || 'Apple Music';
  $('#music-play').innerHTML = music.state === 'playing' ? MUSIC_PAUSE_ICON : MUSIC_PLAY_ICON;
  $('#music-play').setAttribute('aria-label', music.state === 'playing' ? 'Pause' : 'Play');
  $('#music-shuffle').setAttribute('aria-pressed', String(music.shuffle));
  $('#music-repeat').setAttribute('aria-pressed', String(music.repeat !== 'off'));
  $('#music-repeat-one').hidden = music.repeat !== 'one';
  $('#music-fav').setAttribute('aria-pressed', String(Boolean(music.track.favorited)));
  const vol = $('#music-volume');
  if (vol && document.activeElement !== vol) vol.value = String(music.volume);

  const artEl = $('#music-art');
  const artFallback = $('#music-art-fallback');
  const trackKey = `${music.track.id || ''}|${music.track.name}|${music.track.album}`;
  if (music.track.hasArtwork && artEl && artFallback) {
    if (music.artTrackId !== trackKey) {
      music.artTrackId = trackKey;
      artEl.onload = () => { artEl.hidden = false; artFallback.hidden = true; };
      artEl.onerror = () => { artEl.hidden = true; artFallback.hidden = false; };
      artEl.src = `/api/music/artwork?id=${encodeURIComponent(trackKey)}`;
    }
  } else if (artEl && artFallback) {
    music.artTrackId = '';
    artEl.hidden = true;
    artFallback.hidden = false;
  }
  renderMusicProgress();
}
function renderMusicQueue() {
  const nameEl = $('#music-playlist-name');
  const metaEl = $('#music-playlist-meta');
  const listEl = $('#music-queue-list');
  if (!listEl) return;
  const plName = music.playlist?.name || 'Current playlist';
  const count = music.playlist?.count ?? music.queueTracks.length;
  if (nameEl) nameEl.textContent = plName;
  if (metaEl) metaEl.textContent = `${count} tracks${music.shuffle ? ' · shuffle on' : ''}`;
  if (!music.queueTracks.length) {
    listEl.innerHTML = '<div class="music-queue-empty">No playlist tracks available.</div>';
    return;
  }
  listEl.innerHTML = music.queueTracks.map(t => `<button type="button" class="music-queue-item ${t.current ? 'is-current' : ''}" data-music-track="${t.index}" role="listitem">
    <span class="music-q-num">${t.current ? '▶' : t.index}</span>
    <span class="music-q-meta"><span class="music-q-name">${escapeHTML(t.name)}</span><span class="music-q-artist">${escapeHTML(t.artist)}</span></span>
    <span class="music-q-dur">${formatTrackTime(t.duration)}</span>
  </button>`).join('');
}

$('#music-open')?.addEventListener('click', () => sendMusicControl({ action: 'open' }));
$('#music-play')?.addEventListener('click', () => sendMusicControl({ action: 'playpause' }));
$('#music-next')?.addEventListener('click', () => sendMusicControl({ action: 'next' }));
$('#music-prev')?.addEventListener('click', () => sendMusicControl({ action: 'previous' }));
$('#music-shuffle')?.addEventListener('click', () => sendMusicControl({ action: 'shuffle' }));
$('#music-repeat')?.addEventListener('click', () => sendMusicControl({ action: 'repeat' }));
$('#music-fav')?.addEventListener('click', () => sendMusicControl({ action: 'favorite' }));
$('#music-queue-btn')?.addEventListener('click', () => {
  music.queueOpen = !music.queueOpen;
  renderMusic();
  if (music.queueOpen) loadMusicQueue();
});
$('#music-queue-list')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-music-track]');
  if (!btn) return;
  sendMusicControl({ action: 'playTrack', index: Number(btn.dataset.musicTrack) });
});
let volTimer;
$('#music-volume')?.addEventListener('input', event => {
  const val = Number(event.target.value);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => sendMusicControl({ action: 'volume', volume: val }), 120);
});
window.__nitcMusicChanged = () => {
  if (state.view === 'study') loadMusicState();
};
setInterval(renderMusicProgress, 1000);
const themeButton = $('#theme-button');
const themeMenu = $('#theme-menu');
const themeBg = $('#theme-bg');
const THEME_KEY = 'nitc-theme';
const THEME_CATALOG = [
  { id: 'night-reef', label: 'Night Reef', canvas: '#0a1430', accent: '#78d4ed', input: '#162746', video: '/themes/night-reef.mp4', poster: '/themes/night-reef.jpg' },
  { id: 'paper-garden', label: 'Paper Garden', canvas: '#35312a', accent: '#c3b58c', input: '#433f38', video: '/themes/paper-garden.mp4', poster: '/themes/paper-garden.jpg' },
  { id: 'block-clouds', label: 'Block Clouds', canvas: '#0d173f', accent: '#8cb9ef', input: '#1e274c', video: '/themes/block-clouds.mp4', poster: '/themes/block-clouds.jpg' },
  { id: 'braille-stars', label: 'Braille Stars', canvas: '#0a1430', accent: '#9bbcf5', input: '#1b243e', video: '/themes/braille-stars.mp4', poster: '/themes/braille-stars.jpg' },
  { id: 'aurora', label: 'Aurora', canvas: '#14123a', accent: '#a9a7eb', input: '#242247', video: '/themes/aurora.mp4', poster: '/themes/aurora.jpg' },
  { id: 'blueprint', label: 'Blueprint', canvas: '#0c2444', accent: '#81bce4', input: '#1d3351', video: '/themes/blueprint.mp4', poster: '/themes/blueprint.jpg' },
  { id: 'deep-water', label: 'Deep Water', canvas: '#062c3a', accent: '#66d5d0', input: '#173a47', video: '/themes/deep-water.mp4', poster: '/themes/deep-water.jpg' },
  { id: 'departure-board', label: 'Departure Board', canvas: '#1a120b', accent: '#e5b96d', input: '#2a221c', video: '/themes/departure-board.mp4', poster: '/themes/departure-board.jpg' },
  { id: 'dither-dunes', label: 'Dither Dunes', canvas: '#1c1712', accent: '#d7a777', input: '#2c2722', video: '/themes/dither-dunes.mp4', poster: '/themes/dither-dunes.jpg' },
  { id: 'ember', label: 'Ember', canvas: '#2a0d12', accent: '#ef946a', input: '#381e22', video: '/themes/ember.mp4', poster: '/themes/ember.jpg' },
  { id: 'halftone-dusk', label: 'Halftone Dusk', canvas: '#1f2336', accent: '#a9a9e5', input: '#2e3244', video: '/themes/halftone-dusk.mp4', poster: '/themes/halftone-dusk.jpg' },
  { id: 'plotter-tide', label: 'Plotter Tide', canvas: '#141a27', accent: '#79b6c4', input: '#242a36', video: '/themes/plotter-tide.mp4', poster: '/themes/plotter-tide.jpg' },
  { id: 'snow-pines', label: 'Snow Pines', canvas: '#14143a', accent: '#a5c9e2', input: '#242447', video: '/themes/snow-pines.mp4', poster: '/themes/snow-pines.jpg' },
  { id: 'vector-range', label: 'Vector Range', canvas: '#0e2f27', accent: '#8ac9a4', input: '#1f3d36', video: '/themes/vector-range.mp4', poster: '/themes/vector-range.jpg' },
  { id: 'midnight', label: 'Midnight', canvas: '#0e131b', accent: '#d9b36a', input: '#161e2b', video: null, poster: null },
  { id: 'nova', label: 'Nova', canvas: '#09090b', accent: '#f2f2f0', input: '#141418', video: null, poster: null }
];
const THEME_MAP = new Map(THEME_CATALOG.map(item => [item.id, item]));
const LEGACY_THEMES = { white: 'night-reef', system: 'night-reef', light: 'night-reef', editorial: 'night-reef', dark: 'midnight' };
let activeThemeId = 'night-reef';
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function buildThemeMenu() {
  if (!themeMenu) return;
  themeMenu.innerHTML = THEME_CATALOG.map(t => `<button type="button" role="menuitemradio" aria-checked="false" data-theme-option="${t.id}"><span class="theme-option-left"><i class="theme-swatch" style="background:${t.accent};box-shadow:0 0 0 2px ${t.canvas}" aria-hidden="true"></i>${escapeHTML(t.label)}</span><span class="theme-check" aria-hidden="true">✓</span></button>`).join('');
}
function storedTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY) || 'night-reef';
    if (THEME_MAP.has(raw)) return raw;
    const mapped = LEGACY_THEMES[raw] || 'night-reef';
    try { localStorage.setItem(THEME_KEY, mapped); } catch { /* private mode */ }
    return mapped;
  } catch { return 'night-reef'; }
}
function resolveTheme(choice) {
  const mapped = LEGACY_THEMES[choice] || choice;
  return THEME_MAP.has(mapped) ? mapped : 'night-reef';
}
let windowVisible = true;
function syncThemeBackgroundVisibility() {
  if (!themeBg) return;
  const entry = THEME_MAP.get(activeThemeId);
  const hasVideo = Boolean(entry?.video);
  const isVisible = document.visibilityState !== 'hidden' && windowVisible;
  themeBg.hidden = !hasVideo;
  if (!hasVideo) {
    themeBg.pause();
    return;
  }
  if (isVisible && !reducedMotionQuery?.matches) {
    themeBg.muted = true;
    const p = themeBg.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } else {
    themeBg.pause();
  }
}
reducedMotionQuery?.addEventListener?.('change', syncThemeBackgroundVisibility);
window.__nitcSetWindowVisible = visible => {
  windowVisible = Boolean(visible);
  syncThemeBackgroundVisibility();
  if (windowVisible) maybeAutoReload();
};
function applyTheme(choice, { announce = false } = {}) {
  const resolved = resolveTheme(choice);
  const entry = THEME_MAP.get(resolved) || THEME_CATALOG[0];
  activeThemeId = entry.id;
  const root = document.documentElement;
  root.dataset.theme = entry.id;
  root.style.setProperty('--bg', entry.canvas);
  root.style.setProperty('--paper', entry.input);
  root.style.setProperty('--input-bg', entry.input);
  root.style.setProperty('--accent', entry.accent);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', entry.canvas);
  if (themeBg) {
    if (entry.video) {
      if (entry.poster && themeBg.getAttribute('poster') !== entry.poster) {
        themeBg.setAttribute('poster', entry.poster);
      }
      if (themeBg.getAttribute('src') !== entry.video) {
        themeBg.setAttribute('src', entry.video);
        themeBg.load();
      }
    } else {
      themeBg.pause();
      themeBg.removeAttribute('src');
      themeBg.removeAttribute('poster');
    }
    syncThemeBackgroundVisibility();
  }
  const studyLabel = $('#study-theme-label');
  if (studyLabel) studyLabel.textContent = entry.label;
  document.querySelectorAll('[data-theme-option]').forEach(option => option.setAttribute('aria-checked', String(option.dataset.themeOption === entry.id)));
  if (announce) showToast(entry.label);
}
function selectTheme(id, opts) {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* private mode */ }
  applyTheme(id, opts);
}
function cycleTheme() {
  const idx = THEME_CATALOG.findIndex(item => item.id === activeThemeId);
  const next = THEME_CATALOG[(idx + 1) % THEME_CATALOG.length];
  selectTheme(next.id, { announce: true });
}
function setThemeMenu(open) {
  themeMenu.hidden = !open;
  themeButton.setAttribute('aria-expanded', String(open));
}
buildThemeMenu();
themeButton.addEventListener('click', () => setThemeMenu(themeMenu.hidden));
$('#theme-cycle')?.addEventListener('click', cycleTheme);
$('#study-theme-cycle')?.addEventListener('click', cycleTheme);
themeMenu.addEventListener('click', event => {
  const option = event.target.closest('[data-theme-option]');
  if (!option) return;
  selectTheme(option.dataset.themeOption);
  setThemeMenu(false);
  themeButton.focus();
});
document.addEventListener('click', event => {
  if (!themeMenu.hidden && !event.target.closest('.theme-wrapper')) setThemeMenu(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !themeMenu.hidden) { setThemeMenu(false); themeButton.focus(); }
});
applyTheme(storedTheme());
document.addEventListener('visibilitychange', () => {
  syncThemeBackgroundVisibility();
  if (document.visibilityState === 'visible') maybeAutoReload();
});
async function loadCourses() {
  try {
    const data = await request('/api/courses');
    if (Array.isArray(data.courses) && data.courses.length) {
      courseNames = data.courses;
      syncCourseSelects();
    }
  } catch { /* fallback to built-in course list */ }
}
loadCourses();
loadTasks();
loadStudy();
