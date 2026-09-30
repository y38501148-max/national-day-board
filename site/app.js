'use strict';
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 0});
const decimal = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
let board, filtered = [], page = 0, detailRequest = 0, busy = false;
let boardSignature = '', problemSignature = '', apiBase = '', detailHandle = '';
let configReady = false, boardProvider = '', checkedAt = null, cacheUpdatedAt = 0;
const PAGE_SIZE = 30;
const RESULT_LABELS = {accepted: '满分', partial: '部分分', failed: '失败', pending: '待评测', unattempted: '未尝试'};
const displayProblems = () => board.registration_problem ? [board.registration_problem, ...board.problems] : board.problems;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function json(url) {
  const response = await fetch(url, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('Data unavailable');
  return response.json();
}
function filter(resetPage = true) {
  const query = $('search').value.trim().toLowerCase();
  filtered = board.participants.filter(p => p.handle.toLowerCase().includes(query));
  if (resetPage) page = 0;
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  render();
}
function renderHeader() {
  const head = document.createDocumentFragment(), columns = document.createDocumentFragment();
  for (const [label, name] of [['排名', 'rank'], ['公开榜单 ID', 'handle'], ['Rating ↓', 'rating'], ['通过数', 'solved']]) {
    const cell = el('th', label, `fixed-${name}${name === 'rating' || name === 'solved' ? ' number' : ''}`);
    cell.scope = 'col';
    if (name === 'rating') cell.setAttribute('aria-sort', 'descending');
    if (name === 'solved') cell.title = '满分通过的计分题目数，不含 A 签到题';
    head.append(cell); columns.append(el('col', undefined, `column-${name}`));
  }
  for (const problem of displayProblems()) {
    const cell = el('th', undefined, 'problem-heading'); cell.scope = 'col';
    cell.append(el('span', problem.label, 'problem-label'), el('span', number.format(problem.rating), 'problem-rating'));
    cell.title = `${problem.label}${problem.title ? ` · ${problem.title}` : ''}\n题目 rating ${number.format(problem.rating)} · 满分 ${decimal.format(problem.max_score)}${String(problem.id) === String(board.registration_problem?.id) ? '\n签到题，不参与 Rating 和通过数计分' : ''}`;
    cell.setAttribute('aria-label', `${problem.label}${problem.title ? `，${problem.title}` : ''}，题目 rating ${number.format(problem.rating)}`);
    head.append(cell); columns.append(el('col', undefined, 'column-problem'));
  }
  $('board-table').style.setProperty('--problem-count', displayProblems().length);
  $('board-head').replaceChildren(head); $('board-columns').replaceChildren(columns);
}
function problemCell(problem, result) {
  const status = RESULT_LABELS[result?.status] ? result.status : 'unattempted';
  const cell = el('td', undefined, `problem-cell ${status}${status === 'partial' && result.qualified ? ' qualified' : ''}`);
  if (status === 'unattempted') {
    cell.title = `${problem.label} · 未尝试`; cell.setAttribute('aria-label', cell.title); return cell;
  }
  const completion = `${decimal.format((result.score_ratio || 0) * 100)}%`;
  const attempts = `${number.format(result.attempts)} 次提交`;
  const score = status === 'pending' ? '待评测' : `${status === 'accepted' ? '✓ ' : status === 'failed' ? '× ' : ''}${completion}`;
  cell.append(el('span', score, 'result-score'), el('span', attempts, 'result-attempts'));
  const registration = String(problem.id) === String(board.registration_problem?.id);
  const text = registration ? `${problem.label} · 签到已完成 · ${attempts}\n不参与 Rating 和通过数计分` : `${problem.label} · ${RESULT_LABELS[status]}${status === 'pending' ? '' : ` · 最高完成度 ${completion}`}\n${attempts}（含 CE 和待评测） · ${result.qualified ? '已达标' : '未达标'}\n${result.qualified ? '最佳贡献对应的' : '累计'}计分罚次 ${number.format(result.penalty_count)} · 最佳贡献 ${decimal.format(result.best_contribution)}`;
  cell.title = text; cell.setAttribute('aria-label', text.replaceAll('\n', '，'));
  return cell;
}
function render() {
  const start = page * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  const previousRows = new Map([...$('rows').children].map(row => [row.dataset.handle, row]));
  const positions = new Map([...previousRows].map(([handle, row]) => [handle, row.getBoundingClientRect().top]));
  const visibleRows = [];
  for (const player of filtered.slice(start, start + PAGE_SIZE)) {
    const key = player.handle.toLowerCase(), signature = JSON.stringify([player, problemSignature]);
    let row = previousRows.get(key);
    if (row?.dataset.signature === signature) {
      fragment.append(row); visibleRows.push(row); continue;
    }
    row = row || el('tr'); row.replaceChildren();
    row.dataset.handle = key; row.dataset.signature = signature;
    const rankCell = el('td', undefined, 'fixed-rank'); rankCell.append(el('span', player.rank, player.rank <= 3 ? 'rank top' : 'rank')); row.append(rankCell);
    const nameCell = el('th', undefined, 'fixed-handle'); nameCell.scope = 'row'; const button = el('button', undefined, 'player');
    button.append(el('span', player.handle));
    button.title = `查看 ${player.handle} 的贡献明细`;
    button.addEventListener('click', () => openDetail(player.handle)); nameCell.append(button); row.append(nameCell);
    row.append(el('td', number.format(player.rating), 'fixed-rating number rating'), el('td', player.full, 'fixed-solved number'));
    const results = new Map((player.problem_results || []).map(result => [String(result.problem_id), result]));
    for (const problem of displayProblems()) row.append(problemCell(problem, results.get(String(problem.id))));
    fragment.append(row); visibleRows.push(row);
  }
  $('rows').replaceChildren(fragment);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const row of visibleRows) {
      const from = positions.get(row.dataset.handle);
      const delta = from === undefined ? 0 : from - row.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) row.animate([{transform: `translateY(${delta}px)`}, {transform: 'translateY(0)'}], {duration: 450, easing: 'cubic-bezier(.2,.7,.2,1)'});
    }
  }
  $('empty').hidden = filtered.length !== 0;
  $('empty').textContent = board.participants.length ? '没有找到该 ID，试试只输入其中一部分。' : '暂无选手。';
  $('results').textContent = `共 ${number.format(filtered.length)} 位选手${$('search').value.trim() ? '符合搜索条件' : ''}`;
  $('page-label').textContent = filtered.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} / ${number.format(filtered.length)}` : '0 / 0';
  $('prev').disabled = page === 0; $('next').disabled = start + PAGE_SIZE >= filtered.length;
}
function updateTime(value) {
  const stamp = Date.parse(value);
  if (Number.isFinite(stamp) && stamp <= Date.now() + 5000 && stamp >= Date.parse(board.generated_at) && (!checkedAt || stamp >= Date.parse(checkedAt))) checkedAt = value;
  $('updated').textContent = new Date(checkedAt || board.generated_at).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
}
function fresh() {
  if (!board) return;
  const age = Date.now() - Date.parse(checkedAt || board.generated_at);
  $('freshness').textContent = board.mode === 'demo' ? '演示快照 · 非真实比赛数据' : board.mode === 'live' && age > 90000 ? '更新已延迟' : '';
}
function mergeDelta(previous, delta, targetVersion) {
  if (!delta || delta.base_generated_at !== previous.generated_at || delta.generated_at !== targetVersion
      || !delta.metadata || typeof delta.metadata !== 'object' || Array.isArray(delta.metadata)
      || 'participants' in delta.metadata || delta.metadata.generated_at !== targetVersion
      || !Array.isArray(delta.upsert) || !Array.isArray(delta.removed) || !Array.isArray(delta.order)) throw new Error('Invalid delta');
  const keyOf = player => {
    if (!player || typeof player.handle !== 'string' || !player.handle || !Number.isSafeInteger(player.rating) || player.rating < 0
        || !Number.isSafeInteger(player.full) || player.full < 0 || (player.problem_results !== undefined && !Array.isArray(player.problem_results))) throw new Error('Invalid participant');
    return player.handle.toLowerCase();
  };
  const rows = new Map();
  for (const player of previous.participants) {
    const key = keyOf(player); if (rows.has(key)) throw new Error('Duplicate cached participant'); rows.set(key, player);
  }
  const removed = new Set(), updated = new Set();
  for (const key of delta.removed) {
    if (typeof key !== 'string' || !key || key !== key.toLowerCase() || removed.has(key)) throw new Error('Invalid removed participant');
    removed.add(key); rows.delete(key);
  }
  for (const player of delta.upsert) {
    const key = keyOf(player); if (updated.has(key) || removed.has(key)) throw new Error('Duplicate delta participant'); updated.add(key); rows.set(key, player);
  }
  if (delta.order.length !== rows.size) throw new Error('Incomplete delta order');
  const ordered = [], seen = new Set(); let previousRating = Infinity, rank = 0;
  for (const key of delta.order) {
    if (typeof key !== 'string' || key !== key.toLowerCase() || seen.has(key) || !rows.has(key)) throw new Error('Invalid delta order');
    seen.add(key); const player = rows.get(key);
    if (player.rating > previousRating) throw new Error('Invalid rating order');
    if (player.rating !== previousRating) rank = ordered.length + 1;
    previousRating = player.rating;
    ordered.push(player.rank === rank ? player : {...player, rank});
  }
  const incoming = {...delta.metadata, participants: ordered};
  if (incoming.schema_version !== 1 || !Array.isArray(incoming.problems) || typeof incoming.title !== 'string'
      || !incoming.statistics || incoming.statistics.registered !== ordered.length || incoming.statistics.problems !== incoming.problems.length) throw new Error('Invalid delta metadata');
  return incoming;
}
async function load() {
  if (busy || !configReady) return; busy = true;
  try {
    let incoming, provider = 'static', liveCheckedAt;
    if (apiBase) {
      try {
        if (board && boardProvider === 'live' && Date.now() - cacheUpdatedAt < 1800000) {
          const version = await json(`${apiBase}/api/live/version`);
          const stamp = Date.parse(version.generated_at);
          if (!Number.isFinite(stamp) || stamp > Date.now() + 5000) throw new Error('Invalid live version');
          if (version.generated_at === board.generated_at) {
            updateTime(version.checked_at); fresh(); $('error').hidden = true; return;
          }
          liveCheckedAt = version.checked_at;
          try {
            const delta = await json(`${apiBase}/api/live/delta?from=${encodeURIComponent(board.generated_at)}`);
            incoming = mergeDelta(board, delta, version.generated_at);
          } catch (_) { /* A missing delta or version gap requires a complete snapshot. */ }
        }
        if (!incoming) {
          incoming = await json(`${apiBase}/api/live/board`);
          // Public scores may remain unchanged for hours. Show the current OJ
          // check on first load rather than waiting for the next browser poll.
          if (!liveCheckedAt) {
            try {
              const version = await json(`${apiBase}/api/live/version`);
              if (version.generated_at === incoming.generated_at) liveCheckedAt = version.checked_at;
            } catch (_) { /* The score snapshot remains available. */ }
          }
        }
        if (!Array.isArray(incoming.participants) || !Array.isArray(incoming.problems) || incoming.schema_version !== 1) throw new Error('Invalid live data');
        provider = 'live';
      } catch (_) {incoming = await json('./data/board.json');}
    } else incoming = await json('./data/board.json');
    if (!Array.isArray(incoming.participants) || !Array.isArray(incoming.problems) || incoming.schema_version !== 1) throw new Error('Invalid data');
    const nextSignature = JSON.stringify([incoming.mode, incoming.participants, incoming.problems, incoming.registration_problem]);
    const nextProblemSignature = JSON.stringify([incoming.problems, incoming.registration_problem]);
    const rowsChanged = nextSignature !== boardSignature, problemsChanged = nextProblemSignature !== problemSignature;
    const previousSnapshot = board?.generated_at;
    board = incoming; boardProvider = provider; checkedAt = null; cacheUpdatedAt = Date.now(); boardSignature = nextSignature; problemSignature = nextProblemSignature;
    document.title = board.title; $('board-heading').textContent = board.title; $('registered').textContent = number.format(board.statistics.registered); $('problem-count').textContent = number.format(board.statistics.problems);
    updateTime(provider === 'live' ? liveCheckedAt : null);
    $('mode-banner').hidden = board.mode !== 'demo';
    $('mode-banner').textContent = `演示榜：以下 ${number.format(board.statistics.registered)} 位选手及所有成绩均为合成数据，用于预览与验证。真实比赛尚未接入，演示日期不代表正式赛程。`;
    const link = $('contest-link'); link.hidden = true;
    if (board.contest_url) {
      const url = new URL(board.contest_url);
      if (url.protocol === 'https:') { link.href = url.href; link.hidden = false; }
    }
    $('registration-intro').textContent = board.registration_mode === 'stdout' ? '使用自己的 OJ 账号提交 A 题。当前设置为读取首次 AC 的实际标准输出，真实输出接入仍需管理员验证。' : '使用自己的 OJ 账号提交 A 题。本场只接受下方固定 C 模板，请只修改 puts 中的公开榜单 ID，保留其他代码。';
    $('registration-mode-note').textContent = board.mode === 'standby' ? '比赛尚未配置，注册暂未开放。' : board.registration_mode === 'template' ? '本场采用固定 C 模板注册，请只修改 puts 中的 ID，保留其他代码。后台读取模板，不运行学生程序。' : '本场设置为按首次 AC 的实际标准输出解析 ID，实际输出接入仍需管理员验证。';
    $('error').hidden = true;
    if (problemsChanged) renderHeader();
    if (rowsChanged) filter(false);
    fresh();
    if (previousSnapshot !== board.generated_at && $('detail-dialog').open && detailHandle) openDetail(detailHandle);
  } catch (_) {
    $('error').hidden = false;
    $('error').textContent = board ? '暂时无法更新，已保留上次成功加载的榜单。' : '榜单暂时无法加载。请稍后刷新页面。';
    if (!board) $('results').textContent = '等待数据恢复';
  } finally { busy = false; }
}
async function openDetail(handle) {
  const current = ++detailRequest; detailHandle = handle; $('detail-title').textContent = handle;
  $('detail-content').replaceChildren(el('p', '正在加载贡献明细…', 'loading'));
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  try {
    const snapshot = board.generated_at;
    const key = encodeURIComponent(handle.toLowerCase());
    const read = async url => {
      const detail = await json(url);
      const player = board.participants.find(item => item.handle.toLowerCase() === handle.toLowerCase());
      if (detail.generated_at !== snapshot || !Array.isArray(detail.problems) || !player || detail.rating !== player.rating || detail.rank !== player.rank) throw new Error('Snapshot mismatch');
      return detail;
    };
    let detail;
    if (apiBase) {
      try {detail = await read(`${apiBase}/api/live/players/${key}`);}
      catch (_) {detail = await read(`./data/players/${key}.json`);}
    } else detail = await read(`./data/players/${key}.json`);
    if (current !== detailRequest) return;
    if (snapshot !== board.generated_at) throw new Error('Snapshot changed');
    const container = document.createDocumentFragment(), stats = el('div', undefined, 'detail-stats');
    for (const [label, value] of [['Rating', number.format(detail.rating)], ['排名', `#${detail.rank}`], ['加权贡献', decimal.format(detail.raw_contribution)], ['达标 / 满分', `${detail.solved} / ${detail.full}`]]) {
      const item = el('div'); item.append(el('span', label), el('strong', value)); stats.append(item);
    }
    container.append(stats);
    if (!detail.problems.length) container.append(el('p', '暂时没有达到 60% 的计分题目。'));
    else {
      const scroll = el('div', undefined, 'table-scroll'), table = el('table', undefined, 'detail-table');
      const head = el('thead'), header = el('tr');
      ['题目', 'CF rating', '最高 / 计分完成度', '计分罚次', '单题贡献', '权重', '加权贡献'].forEach(t => header.append(el('th', t))); head.append(header); table.append(head);
      const body = el('tbody');
      for (const problem of detail.problems) {
        const row = el('tr'), title = el('td', problem.label); title.append(el('span', problem.title, 'problem-title')); row.append(title);
        [number.format(problem.rating), `${decimal.format(problem.highest_completion * 100)}% / ${decimal.format(problem.completion * 100)}%`, problem.penalty_count, decimal.format(problem.contribution), problem.weight.toFixed(3), decimal.format(problem.weighted_contribution)].forEach(value => row.append(el('td', value, 'number')));
        body.append(row);
      }
      table.append(body); scroll.append(table); container.append(scroll);
    }
    $('detail-content').replaceChildren(container);
  } catch (_) { if (current === detailRequest) $('detail-content').replaceChildren(el('p', '该选手当前快照的明细暂时不可用，请稍后重试。')); }
}
$('search').addEventListener('input', () => {if (board) filter();});
$('prev').addEventListener('click', () => {if (page > 0) {page--; render();}});
$('next').addEventListener('click', () => {if ((page + 1) * PAGE_SIZE < filtered.length) {page++; render();}});
$('rules-open').addEventListener('click', () => $('rules-dialog').showModal());
$('register-open').addEventListener('click', () => $('register-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {if (event.target === dialog) {const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) dialog.close();}}));
document.addEventListener('keydown', event => {if (event.key === '/' && !document.querySelector('dialog[open]') && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {event.preventDefault(); $('search').focus();}});
document.addEventListener('visibilitychange', () => {if (!document.hidden) {fresh(); load();}});
setInterval(() => {if (!document.hidden) {fresh(); load();}}, 10000);
async function initialize() {
  try {
    const config = await json('./admin-config.json');
    const url = new URL(config.api_base);
    if (config.origin !== url.origin || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid API config');
    apiBase = url.href.replace(/\/$/, '');
  } catch (_) { /* The published static snapshot remains available. */ }
  configReady = true; load();
}
initialize();
