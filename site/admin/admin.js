'use strict';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'national-day-board-admin';
const formatNumber = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
let lastRegistrationId = null, lastRegistrationMode = null;
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
function button(text, action, values) {
  const element = node('button', text, 'secondary'); element.type = 'button';
  element.disabled = actionBusy;
  element.addEventListener('click', () => mutate(action, values));
  return element;
}
function cell(row, text, className) { row.append(node('td', text, className)); }
function emptyRow(body, columns, text) {
  const row = node('tr'), item = node('td', text, 'muted'); item.colSpan = columns; row.append(item); body.append(row);
}
function renderProblems() {
  const fragment = document.createDocumentFragment();
  for (const problem of state.config.problems || []) {
    const row = node('tr');
    cell(row, problem.label || '—'); cell(row, problem.id); cell(row, problem.title || '—', 'problem-title-cell'); cell(row, formatNumber.format(problem.rating ?? 0));
    const actions = node('td'); actions.append(button('删除', 'remove_problem', {problem_id: String(problem.id)})); row.append(actions); fragment.append(row);
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
    if (!players.some(player => String(player.handle).toLowerCase() === String(handle).toLowerCase())) players.push({handle, status: 'banned'});
  }
  const query = $('player-search').value.trim().toLowerCase();
  const matches = players.filter(player => String(player.handle || '').toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const player of matches.slice(0, 100)) {
    const banned = player.status === 'banned' || bannedUsers.has(String(player.user_id)) || bannedHandles.has(String(player.handle).toLowerCase());
    const row = node('tr'); cell(row, player.handle || '—');
    const status = node('td'); status.append(node('span', banned ? '已封禁' : player.status === 'pending' ? '待处理' : '正常', `badge${banned ? ' banned' : ''}`)); row.append(status);
    const actions = node('td'); actions.append(button(banned ? '解封' : '封禁', banned ? 'unban_player' : 'ban_player', {handle: player.handle, ...(player.user_id == null ? {} : {user_id: player.user_id})})); row.append(actions); fragment.append(row);
  }
  if (!fragment.children.length) emptyRow(fragment, 3, query ? '没有找到选手。' : '暂无选手。');
  $('player-rows').replaceChildren(fragment);
  $('player-count').textContent = `${matches.length} 位选手${matches.length > 100 ? ' · 显示前 100 位，请搜索定位' : ''}`;
}
function renderSubmissions() {
  const ignored = new Set((state.config.moderation?.ignored_submission_ids || []).map(String));
  const query = $('submission-search').value.trim().toLowerCase();
  const matches = (state.snapshot.submissions || []).filter(submission => [submission.id, submission.handle, submission.problem_id].some(value => String(value ?? '').toLowerCase().includes(query))).slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const fragment = document.createDocumentFragment();
  for (const submission of matches.slice(0, 100)) {
    const isIgnored = submission.ignored === true || ignored.has(String(submission.id));
    const row = node('tr', undefined, isIgnored ? 'status-ignored' : '');
    cell(row, submission.id); cell(row, submission.handle || '未注册'); cell(row, submission.problem_id); cell(row, String(submission.result ?? '—')); cell(row, submission.score == null ? '—' : formatNumber.format(submission.score)); cell(row, time(submission.created_at));
    const actions = node('td'); actions.append(button(isIgnored ? '恢复' : '忽略', isIgnored ? 'restore_submission' : 'ignore_submission', {submission_id: String(submission.id)})); row.append(actions); fragment.append(row);
  }
  if (!fragment.children.length) emptyRow(fragment, 7, query ? '没有找到提交记录。' : '暂无提交记录。');
  $('submission-rows').replaceChildren(fragment);
  $('submission-count').textContent = `${matches.length} 条记录${matches.length > 100 ? ' · 显示最近 100 条，请搜索定位' : ''}`;
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
  $('config-summary').textContent = `模式：${modes[config.mode] || config.mode || '—'} · 来源：${config.source_scope || '—'}${config.start_at ? ` · ${time(config.start_at)} 至 ${time(config.end_at)}` : ''}`;
  const registrationId = String(config.registration_problem_id || '10595'), registrationMode = config.registration_mode || 'template';
  if (lastRegistrationId === null || $('registration-id').value === lastRegistrationId) $('registration-id').value = registrationId;
  if (lastRegistrationMode === null || $('registration-mode').value === lastRegistrationMode) $('registration-mode').value = registrationMode;
  lastRegistrationId = registrationId; lastRegistrationMode = registrationMode;
  $('registration-error').textContent = config.registration_error || '';
  $('registration-error').hidden = !config.registration_error;
  const unmapped = state.snapshot.unmapped_registration_count ?? state.snapshot.unmapped_registration_submissions?.length ?? 0;
  $('unmapped-note').hidden = !unmapped;
  $('unmapped-note').textContent = `${unmapped} 条签到提交尚未绑定可信学号，请上传身份映射后同步。`;
  $('registration-note').textContent = config.registration_mode === 'template' ? '固定 C 模板：需采用题面规定的模板，只修改 puts 中的公开 ID。后台解析源码，不运行学生程序。' : '实际标准输出：需要服务端接入 OJ 的真实输出数据。是否可用以同步结果为准。';
  renderProblems(); renderPlayers(); renderSubmissions();
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
      if (action === 'add_problem') $('problem-id').value = '';
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
onForm('add-problem-form', () => mutate('add_problem', {problem_id: $('problem-id').value.trim()}));
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
$('player-search').addEventListener('input', () => {if (state) renderPlayers();});
$('submission-search').addEventListener('input', () => {if (state) renderSubmissions();});
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
