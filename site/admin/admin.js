'use strict';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'national-day-board-admin';
const formatNumber = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const PAGE_SIZE = 10;
const listPages = {player: 0, submission: 0};
let lastRegistrationId = null, lastRegistrationMode = null, luoguSignature = null;
let apiBase = '', session = null, state = null, stateBusy = false, actionBusy = false, expiryTimer;
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function message(text, success = false) {
  $('message').textContent = text;
  $('message').classList.toggle('success', success);
  $('message').hidden = !text;
}
function time(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', {hour12: false});
}
function clearSession(text = '') {
  session = null; state = null; clearTimeout(expiryTimer);
  listPages.player = 0; listPages.submission = 0;
  sessionStorage.removeItem(SESSION_KEY);
  $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('password').value = '';
  if (text) message(text);
}
function expiry(value) {
  return typeof value === 'number' ? value < 1e12 ? value * 1000 : value : Date.parse(value);
}
function setSession(value) {
  const expires = expiry(value.expires_at);
  if (typeof value.token !== 'string' || !value.token || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('登录凭证无效或已过期，请重新登录。');
  session = {token: value.token, expires_at: expires};
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => clearSession('登录已到期，请重新登录。'), Math.min(expires - Date.now(), 2147483647));
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
}
async function request(path, {body, auth = false} = {}) {
  if (auth && (!session || session.expires_at <= Date.now())) {
    clearSession('登录已到期，请重新登录。'); throw new Error('登录已到期，请重新登录。');
  }
  const headers = {Accept: 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${session.token}`;
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25000)});
  } catch (_) { throw new Error('无法连接管理服务，请稍后重试；操作是否完成可刷新状态核对。'); }
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('管理服务返回了无效数据。'); }
  if (response.status === 401 && auth) clearSession('登录已失效，请重新登录。');
  if (!response.ok || result.ok === false) throw new Error(typeof result.message === 'string' ? result.message : response.status === 401 ? '账号或密码错误，或登录已失效。' : `操作失败（${response.status}）。`);
  return result;
}
function button(text, action, values, path) {
  const element = node('button', text, 'secondary'); element.type = 'button';
  element.disabled = actionBusy;
  element.addEventListener('click', () => mutate(action, values, path));
  return element;
}
function cell(row, text, className) { row.append(node('td', text, className)); }
function emptyRow(body, columns, text) {
  const row = node('tr'), item = node('td', text, 'muted'); item.colSpan = columns; row.append(item); body.append(row);
}
function pageRows(kind, matches) {
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  listPages[kind] = Math.min(listPages[kind], Math.max(0, pages - 1));
  const start = listPages[kind] * PAGE_SIZE;
  $(`${kind}-page-label`).textContent = matches.length ? `第 ${listPages[kind] + 1} / ${pages} 页 · ${start + 1}–${Math.min(start + PAGE_SIZE, matches.length)} / ${matches.length}` : '0 / 0';
  $(`${kind}-prev`).disabled = actionBusy || listPages[kind] === 0;
  $(`${kind}-next`).disabled = actionBusy || start + PAGE_SIZE >= matches.length;
  return matches.slice(start, start + PAGE_SIZE);
}
function renderProblems() {
  const fragment = document.createDocumentFragment();
  for (const problem of state.config.problems || []) {
    const row = node('tr');
    cell(row, problem.label || '—'); cell(row, problem.id); cell(row, problem.title || '—', 'problem-title-cell'); cell(row, `${formatNumber.format(problem.rating ?? 0)}${problem.rating_pending ? '（待检测）' : ''}`);
    const actions = node('td');
    if (state.config.contest_auto_sync) actions.textContent = '自动同步';
    else actions.append(button('删除', 'remove_problem', {problem_id: String(problem.id)}));
    row.append(actions); fragment.append(row);
  }
  for (const item of state.config.pending_problems || []) {
    const problem = typeof item === 'object' ? item : {id: item};
    const row = node('tr');
    cell(row, '—'); cell(row, problem.id);
    cell(row, problem.status === 'error' || problem.error ? problem.error || '读取失败，请删除后重新加入。' : '正在读取题目 Rating…', 'problem-title-cell');
    cell(row, '—'); const actions = node('td'); actions.append(button('删除', 'remove_problem', {problem_id: String(problem.id)})); row.append(actions); fragment.append(row);
  }
  if (!fragment.children.length) emptyRow(fragment, 5, '暂无计分题目。');
  $('problem-rows').replaceChildren(fragment);
}
function renderPlayers() {
  const moderation = state.config.moderation || {};
  const bannedUsers = new Set((moderation.banned_user_ids || []).map(String));
  const bannedHandles = new Set((moderation.banned_handles || []).map(handle => String(handle).toLowerCase()));
  const players = [...(state.snapshot.participants || [])];
  for (const handle of moderation.banned_handles || []) {
    if (!players.some(player => String(player.handle).toLowerCase() === String(handle).toLowerCase())) players.push({handle, status: 'banned', placeholder: true});
  }
  const query = $('player-search').value.trim().toLowerCase();
  const matches = players.filter(player => [player.handle, player.name, player.student_id, player.user_id].some(value => String(value ?? '').toLowerCase().includes(query)));
  const fragment = document.createDocumentFragment();
  for (const player of pageRows('player', matches)) {
    const starred = player.starred === true;
    const banned = player.status === 'banned' || bannedUsers.has(String(player.user_id)) || bannedHandles.has(String(player.handle).toLowerCase());
    const row = node('tr'); cell(row, player.handle || '—'); cell(row, player.name || '待获取', 'identity-name'); cell(row, String(player.user_id).startsWith('luogu:') ? `洛谷 UID ${String(player.user_id).slice(6)}` : player.student_id || '—', 'identity-student');
    const status = node('td'); status.append(node('span', banned ? '已封禁' : player.status === 'pending' ? '待处理' : '正常', `badge${banned ? ' banned' : ''}`));
    if (starred) status.append(node('span', '打星', 'badge starred'));
    row.append(status);
    const actions = node('td', undefined, 'player-actions');
    const starButton = button(starred ? '取消打星' : '打星', 'starred', {handle: player.handle, user_id: player.user_id, starred: !starred}, '/api/admin/starred');
    if (String(player.user_id).startsWith('luogu:')) {starButton.disabled = true; starButton.title = '洛谷参赛者固定打星';}
    if (player.placeholder) {starButton.disabled = true; starButton.title = '等待可信选手记录后可设置打星';}
    actions.append(starButton);
    actions.append(button(banned ? '解封' : '封禁', banned ? 'unban_player' : 'ban_player', player.user_id == null ? {handle: player.handle} : {user_id: player.user_id}));
    row.append(actions); fragment.append(row);
  }
  if (!fragment.children.length) emptyRow(fragment, 5, query ? '没有找到选手。' : '暂无选手。');
  $('player-rows').replaceChildren(fragment);
  $('player-count').textContent = `${matches.length} 位选手 · 每页 ${PAGE_SIZE} 行`;
}
function renderSubmissions() {
  const ignored = new Set((state.config.moderation?.ignored_submission_ids || []).map(String));
  const query = $('submission-search').value.trim().toLowerCase();
  const identities = new Map();
  for (const player of state.snapshot.participants || []) {
    if (player.user_id != null) identities.set(`user:${player.user_id}`, player);
    if (player.handle) identities.set(`handle:${String(player.handle).toLowerCase()}`, player);
  }
  const matches = (state.snapshot.submissions || []).filter(submission => {
    const player = identities.get(`user:${submission.user_id}`) || identities.get(`handle:${String(submission.handle || '').toLowerCase()}`);
    return [submission.id, submission.handle, submission.problem_id, submission.user_id, submission.name, submission.student_id, player?.name, player?.student_id].some(value => String(value ?? '').toLowerCase().includes(query));
  }).slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const fragment = document.createDocumentFragment();
  for (const submission of pageRows('submission', matches)) {
    const isIgnored = submission.ignored === true || ignored.has(String(submission.id));
    const row = node('tr', undefined, isIgnored ? 'status-ignored' : '');
    cell(row, submission.id); cell(row, submission.handle || '未注册'); cell(row, submission.problem_id); cell(row, String(submission.result ?? '—')); cell(row, submission.score == null ? '—' : formatNumber.format(submission.score)); cell(row, time(submission.created_at));
    const actions = node('td'); actions.append(button(isIgnored ? '恢复' : '忽略', isIgnored ? 'restore_submission' : 'ignore_submission', {submission_id: String(submission.id)})); row.append(actions); fragment.append(row);
  }
  if (!fragment.children.length) emptyRow(fragment, 7, query ? '没有找到提交记录。' : '暂无提交记录。');
  $('submission-rows').replaceChildren(fragment);
  $('submission-count').textContent = `${matches.length} 条记录 · 每页 ${PAGE_SIZE} 行`;
}
function renderLuogu() {
  const config = state.config, settings = config.luogu || {};
  const problems = [{id:config.registration_problem_id,label:'A'}, ...(config.problems || [])];
  const signature = JSON.stringify([settings,problems.map(p => [p.id,p.label])]);
  if (signature !== luoguSignature && !$('luogu-form').contains(document.activeElement)) {
    $('luogu-team').value = settings.team_id || '137778'; $('luogu-contest').value = settings.contest_id || ''; $('luogu-enabled').checked = settings.enabled === true;
    const fragment = document.createDocumentFragment();
    for (const problem of problems) {
      const row = node('tr'); cell(row, problem.label); cell(row, problem.id);
      const item = node('td'), input = node('input'); input.dataset.target = String(problem.id); input.placeholder = '例如 T123456'; input.pattern = '[PTU][1-9][0-9]{0,11}'; input.maxLength = 13;
      input.value = Object.entries(settings.problem_map || {}).find(([,id]) => id === String(problem.id))?.[0] || '';
      item.append(input); row.append(item); fragment.append(row);
    }
    $('luogu-mapping').replaceChildren(fragment); luoguSignature = signature;
  }
  const health = state.snapshot.source_status?.luogu;
  $('luogu-status').textContent = !settings.enabled ? '未启用：等待创建洛谷比赛。' : health?.status === 'error' ? `采集暂不可用（${health.code || '读取失败'}），保留已有成绩并自动重试。` : health?.last_success_at ? `最近成功采集：${time(health.last_success_at)}` : '已启用，等待首次采集。';
}
function renderState() {
  const config = state.config, sync = state.sync || {};
  const statuses = {idle: '等待同步', running: '正在同步…', in_progress: '正在同步…', queued: '同步已排队', waiting: '等待同步', requested: '等待同步', success: '同步成功', completed: '同步已结束', failed: '同步失败', error: '同步失败', pending: '等待同步'};
  if (sync.status === 'completed') statuses.completed = sync.conclusion === 'success' ? '同步成功' : sync.conclusion === 'failure' || sync.conclusion === 'timed_out' ? '同步失败' : sync.conclusion === 'cancelled' ? '同步已取消' : '同步已结束';
  $('sync-status').textContent = statuses[sync.status] || sync.status || '等待同步';
  $('sync-updated').textContent = time(state.snapshot.generated_at);
  $('sync').disabled = actionBusy || ['running', 'in_progress', 'queued', 'pending', 'requested', 'waiting'].includes(sync.status);
  const runLink = $('run-link'); runLink.hidden = true;
  if (sync.last_run_url) {
    try { const url = new URL(sync.last_run_url); if (url.protocol === 'https:') {runLink.href = url.href; runLink.hidden = false;} } catch (_) { /* No invalid link rendered. */ }
  }
  const modes = {live: '实时采集', standby: '待配置', demo: '演示'};
  $('config-summary').textContent = `模式：${modes[config.mode] || config.mode || '—'} · ${config.contest_auto_sync ? `自动同步比赛 ${config.contest_id}` : `来源：${config.source_scope || '—'}`}${config.start_at ? ` · ${time(config.start_at)} 至 ${time(config.end_at)}` : ''}`;
  if (document.activeElement !== $('contest-id')) $('contest-id').value = config.contest_id || '1317';
  $('registration-id').disabled = config.contest_auto_sync || actionBusy;
  $('registration-form').querySelector('button').hidden = config.contest_auto_sync;
  const registrationId = String(config.registration_problem_id || '10595'), registrationMode = config.registration_mode || 'template';
  if (lastRegistrationId === null || $('registration-id').value === lastRegistrationId) $('registration-id').value = registrationId;
  if (lastRegistrationMode === null || $('registration-mode').value === lastRegistrationMode) $('registration-mode').value = registrationMode;
  lastRegistrationId = registrationId; lastRegistrationMode = registrationMode;
  $('registration-error').textContent = config.registration_error || '';
  $('registration-error').hidden = !config.registration_error;
  const unmapped = state.snapshot.unmapped_registration_count ?? state.snapshot.unmapped_registration_submissions?.length ?? 0;
  $('unmapped-note').hidden = !unmapped;
  $('unmapped-note').textContent = `${unmapped} 条签到提交尚未绑定可信学号，请上传身份映射后同步。`;
  $('registration-note').textContent = config.registration_mode === 'template' ? '固定 C 模板：需采用题面规定的模板，只修改 puts 中的公开 ID。后台解析源码，不运行学生程序。' : '标准输出：云端在禁用网络的隔离容器中重跑首次 AC 的签到程序，读取实际输出；支持 C、C++、Python 2/3 和 Java。';
  renderLuogu(); renderProblems(); renderPlayers(); renderSubmissions();
}
async function refreshState({silent = false} = {}) {
  if (!session || stateBusy || actionBusy) return;
  stateBusy = true;
  try {
    const incoming = await request('/api/admin/state', {auth: true});
    if (!session) return;
    if (!incoming.config || !incoming.snapshot || incoming.revision == null) throw new Error('管理状态格式不完整。');
    state = incoming; renderState(); $('connection').textContent = '管理服务已连接';
  } catch (error) { if (!silent || session) message(error.message); }
  finally {stateBusy = false;}
}
async function mutate(action, values = {}, path = '/api/admin/action') {
  if (actionBusy || !session || !state) return;
  actionBusy = true;
  const controls = [...$('workspace').querySelectorAll('button,input,select')];
  const previousDisabled = controls.map(control => control.disabled);
  controls.forEach(control => {control.disabled = true;});
  message('');
  try {
    const result = await request(path, {auth: true, body: {...(path === '/api/admin/action' ? {action} : {}), ...values, revision: state.revision}});
    if (session) {
      message(result.message || '操作已保存，正在更新状态。', true);
      if (action === 'ban_player') $('ban-handle').value = '';
      if (action === 'roster') $('roster-file').value = '';
      if (action === 'set_registration') lastRegistrationId = null;
      if (action === 'set_registration_mode') lastRegistrationMode = null;
    }
  } catch (error) {message(error.message);}
  finally {
    actionBusy = false;
    controls.forEach((control, index) => {control.disabled = previousDisabled[index];});
    await refreshState({silent: true});
  }
}
function onForm(id, handler) {
  $(id).addEventListener('submit', event => {event.preventDefault(); if (!actionBusy) handler(event);});
}
onForm('login-form', async () => {
  if (!apiBase || $('login-submit').disabled) return;
  $('login-submit').disabled = true; message('');
  try {
    const result = await request('/api/login', {body: {username: $('username').value.trim(), password: $('password').value}});
    setSession(result); $('password').value = ''; await refreshState();
  } catch (error) {message(error.message);}
  finally {$('login-submit').disabled = false;}
});
onForm('submission-action-form', event => mutate(event.submitter?.value === 'restore_submission' ? 'restore_submission' : 'ignore_submission', {submission_id: $('manual-submission-id').value.trim()}));
onForm('luogu-form', () => {
  const mapping = {};
  for (const input of $('luogu-mapping').querySelectorAll('input')) {
    const pid = input.value.trim(); if (!pid) continue;
    if (Object.hasOwn(mapping,pid)) {message('同一个洛谷题号不能映射到两道题。'); return;}
    mapping[pid] = input.dataset.target;
  }
  mutate('set_luogu', {team_id:$('luogu-team').value.trim(),contest_id:$('luogu-contest').value.trim(),enabled:$('luogu-enabled').checked,problem_map:mapping});
});
onForm('contest-form', () => mutate('set_contest', {contest_id: $('contest-id').value.trim()}));
onForm('registration-form', () => mutate('set_registration', {problem_id: $('registration-id').value.trim()}));
onForm('registration-mode-form', () => mutate('set_registration_mode', {value: $('registration-mode').value}));
onForm('roster-form', async () => {
  const file = $('roster-file').files[0];
  if (!file) return;
  if (file.size > 512 * 1024) {message('CSV 超过 512 KB，请缩小文件后上传。'); return;}
  try {
    const csv = await file.text();
    await mutate('roster', {csv}, '/api/admin/roster');
  } catch (_) {message('无法读取 CSV 文件，请重新选择。');}
});
onForm('ban-player-form', () => mutate('ban_player', {handle: $('ban-handle').value.trim()}));
$('logout').addEventListener('click', () => {clearSession(); message('已退出。', true);});
$('sync').addEventListener('click', () => mutate('sync'));
for (const [kind, renderList] of [['player', renderPlayers], ['submission', renderSubmissions]]) {
  $(`${kind}-search`).addEventListener('input', () => {listPages[kind] = 0; if (state) renderList();});
  for (const [direction, step] of [['prev', -1], ['next', 1]]) {
    $(`${kind}-${direction}`).addEventListener('click', () => {
      if (!state || actionBusy) return;
      listPages[kind] = Math.max(0, listPages[kind] + step); renderList();
    });
  }
}
document.addEventListener('visibilitychange', () => {if (!document.hidden) refreshState({silent: true});});
setInterval(() => {if (!document.hidden) refreshState({silent: true});}, 10000);
async function initialize() {
  try {
    const response = await fetch('../admin-config.json', {cache: 'no-store', signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('管理服务尚未配置。');
    const config = await response.json();
    const url = new URL(config.api_base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || config.origin !== url.origin || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('管理服务地址配置无效。');
    apiBase = url.href.replace(/\/$/, '');
    await request('/api/health'); $('connection').textContent = '管理服务已连接'; $('login-submit').disabled = false;
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {try {setSession(JSON.parse(saved)); await refreshState();} catch (_) {clearSession('登录已到期，请重新登录。');}}
  } catch (error) {$('connection').textContent = '管理服务未连接'; message(error.message);}
}
initialize();
