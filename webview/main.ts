import type { FromWebview, Row, ToWebview, ViewState, CommitAction, RefAction, Comparison } from '../src/protocol';
import type { CommitDetails, FileChange, Ref } from '../src/git';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

const WORKING_TREE = '*';
const LANE = 16;
const ROW = 26;
const MAX_LANES = 24;

let rows: Row[] = [];
let state: ViewState | null = null;
let hasMore = false;
let loadingMore = false;
let expanded: string | null = null;
let comparing: string | null = null;
let graphLanes = 1;

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="toolbar">
    <select id="repo" title="Repository" hidden></select>
    <label class="toggle" title="Show all branches or only the current one">
      <input type="checkbox" id="allRefs" checked> All branches
    </label>
    <input id="search" type="search" placeholder="Search commit messages" spellcheck="false">
    <span class="spacer"></span>
    <span id="head" class="head"></span>
    <button id="pro" class="pro" title="Branchline Pro: compare commits, file history" hidden>★ Pro</button>
    <button id="fetch" title="Fetch from all remotes">Fetch</button>
    <button id="refresh" title="Refresh">Refresh</button>
  </header>
  <div id="error" class="error" hidden></div>
  <div id="pathbar" class="pathbar" hidden><span id="pathlabel"></span><button id="clearPath">Show all history</button></div>
  <main id="scroller">
    <table id="graph">
      <thead><tr><th class="c-graph">Graph</th><th>Description</th><th class="c-date">Date</th><th class="c-author">Author</th><th class="c-hash">Commit</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="status" class="status">Loading…</div>
  </main>
  <div id="menu" class="menu" hidden></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tbody = $('rows');
const statusEl = $('status');
const menu = $('menu');
const repoSelect = $<HTMLSelectElement>('repo');
const allRefs = $<HTMLInputElement>('allRefs');
const search = $<HTMLInputElement>('search');

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  if (state?.dateFormat === 'absolute') return d.toLocaleString();
  const s = Math.round(Date.now() / 1000 - unix);
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

// ---------- graph drawing ----------

const x = (col: number) => col * LANE + LANE / 2;

function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

function graphSvg(row: Row): string {
  const mid = ROW / 2;
  const w = graphLanes * LANE;
  let paths = '';
  for (const s of row.layout.segments) {
    if (Math.max(s.from, s.to) >= MAX_LANES) continue;
    const d = s.half === 'top' ? curve(x(s.from), 0, x(s.to), mid) : curve(x(s.from), mid, x(s.to), ROW);
    paths += `<path d="${d}" class="lane c${s.color % 10}"${row.hash === WORKING_TREE ? ' stroke-dasharray="3 3"' : ''}/>`;
  }
  const col = Math.min(row.layout.col, MAX_LANES - 1);
  const isHead = row.hash === state?.head;
  if (row.stash) {
    return `<svg width="${w}" height="${ROW}" viewBox="0 0 ${w} ${ROW}">${paths}<rect x="${x(col) - 4}" y="${mid - 4}" width="8" height="8" rx="1.5" class="node stash c${row.layout.color % 10}"/></svg>`;
  }
  const cls = row.hash === WORKING_TREE ? 'node wt' : `node c${row.layout.color % 10}${isHead ? ' head' : ''}${row.parents.length > 1 ? ' merge' : ''}`;
  const r = isHead ? 5 : 4;
  return `<svg width="${w}" height="${ROW}" viewBox="0 0 ${w} ${ROW}">${paths}<circle cx="${x(col)}" cy="${mid}" r="${r}" class="${cls}"/></svg>`;
}

// ---------- rendering ----------

function refBadge(ref: Ref): string {
  const current = ref.type === 'head' && ref.name === state?.branch;
  const icon = ref.type === 'tag' ? '🏷' : ref.type === 'remote' ? '☁' : ref.type === 'stash' ? '⚑' : '⎇';
  return `<span class="ref ${ref.type}${current ? ' current' : ''}" data-ref="${esc(JSON.stringify(ref))}" title="${esc(ref.name)}">${icon} ${esc(ref.name)}</span>`;
}

function rowHtml(row: Row, i: number): string {
  const wt = row.hash === WORKING_TREE;
  const refs = [...row.refs].sort((a, b) => order(a) - order(b)).map(refBadge).join('');
  return `<tr class="commit${wt ? ' wt' : ''}${row.hash === expanded ? ' selected' : ''}" data-i="${i}">
    <td class="c-graph">${graphSvg(row)}</td>
    <td class="c-desc">${row.hash === state?.head && !state.branch ? '<span class="ref detached">HEAD</span>' : ''}${row.stash ? `<span class="ref stash">⚑ ${esc(row.stash)}</span>` : ''}${refs}<span class="subject">${esc(row.subject)}</span></td>
    <td class="c-date">${wt ? '' : esc(formatDate(row.date))}</td>
    <td class="c-author" title="${esc(row.email)}">${esc(row.author)}</td>
    <td class="c-hash">${wt ? '*' : row.hash.slice(0, 7)}</td>
  </tr>`;
}

const order = (r: Ref) => (r.type === 'head' ? (r.name === state?.branch ? 0 : 1) : r.type === 'remote' ? 2 : 3);

function render(): void {
  graphLanes = Math.min(MAX_LANES, Math.max(1, ...rows.map(r => r.layout.width)));
  document.documentElement.style.setProperty('--graph-width', `${graphLanes * LANE + 8}px`);
  tbody.innerHTML = rows.map(rowHtml).join('');
  if (expanded) {
    const i = rows.findIndex(r => r.hash === expanded);
    if (i === -1) expanded = null;
    else send({ type: 'details', hash: expanded });
  }
  renderStatus();
}

function appendRows(newRows: Row[]): void {
  const start = rows.length;
  rows.push(...newRows);
  const lanes = Math.min(MAX_LANES, Math.max(graphLanes, ...newRows.map(r => r.layout.width)));
  if (lanes !== graphLanes) return render(); // graph got wider: redraw everything at the new width
  tbody.insertAdjacentHTML('beforeend', newRows.map((r, k) => rowHtml(r, start + k)).join(''));
  renderStatus();
}

function renderStatus(): void {
  if (!state?.repo) statusEl.textContent = 'No git repository found in this workspace.';
  else if (rows.length === 0) statusEl.textContent = state.search ? 'No commits match your search.' : 'No commits yet.';
  else statusEl.textContent = hasMore ? 'Loading more…' : `${rows.filter(r => r.hash !== WORKING_TREE).length} commits`;
}

function renderToolbar(): void {
  if (!state) return;
  repoSelect.hidden = state.repos.length < 2;
  repoSelect.innerHTML = state.repos
    .map(r => `<option value="${esc(r)}"${r === state!.repo ? ' selected' : ''}>${esc(r.split(/[\\/]/).pop()!)}</option>`)
    .join('');
  allRefs.checked = state.allRefs;
  if (document.activeElement !== search) search.value = state.search;
  $('pro').hidden = state.pro;
  $('pathbar').hidden = !state.path;
  $('pathlabel').textContent = state.path ? `History of ${state.path}` : '';
  $('head').textContent = state.branch ? `⎇ ${state.branch}` : state.head ? `detached @ ${state.head.slice(0, 7)}` : '';
}

// ---------- details ----------

function statusLabel(s: string): string {
  return ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' } as Record<string, string>)[s] ?? s;
}

function renderDetails(hash: string, d: CommitDetails | { hash: string; files: FileChange[] }): void {
  document.querySelector('tr.details')?.remove();
  const tr = tbody.querySelector<HTMLTableRowElement>(`tr.commit[data-i="${rows.findIndex(r => r.hash === hash)}"]`);
  if (!tr || expanded !== hash) return;
  const files = fileList(d.files);
  const meta = 'author' in d
    ? `<div>
        <div><b>Commit</b> <code class="copy" data-copy="${d.hash}">${d.hash}</code></div>
        <div><b>Parents</b> ${d.parents.map(p => `<code class="jump" data-hash="${p}">${p.slice(0, 7)}</code>`).join(' ') || '—'}</div>
        <div><b>Author</b> ${esc(d.author)} &lt;${esc(d.email)}&gt; · ${esc(new Date(d.date * 1000).toLocaleString())}</div>
        ${d.committer !== d.author ? `<div><b>Committer</b> ${esc(d.committer)} &lt;${esc(d.committerEmail)}&gt;</div>` : ''}
        <pre class="message">${esc(d.subject)}${d.body ? `\n\n${esc(d.body)}` : ''}</pre>
      </div>`
    : `<div><b>Uncommitted changes</b></div>`;
  const tip = `<div class="tip">Tip: ${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}-click another commit to compare</div>`;
  const row = detailsRow(rows.find(r => r.hash === hash)!, `<div class="meta">${meta}${tip}</div><ul class="files">${files || '<li class="empty">No file changes</li>'}</ul>`);
  row.querySelectorAll<HTMLElement>('.file').forEach(li =>
    li.addEventListener('click', () => send({ type: 'openDiff', hash, file: d.files[Number(li.dataset.k)] })),
  );
  tr.after(row);
}

function fileList(files: FileChange[]): string {
  return files
    .map((f, k) => `<li class="file" data-k="${k}" title="${esc(statusLabel(f.status))}: ${esc(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}">
        <span class="fs s-${f.status}">${f.status}</span>
        <span class="fp">${f.oldPath ? `${esc(f.oldPath)} → ` : ''}${esc(f.path)}</span>
        ${f.additions !== undefined ? `<span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span>` : ''}
      </li>`)
    .join('');
}

/** A details row below `anchor` whose graph lanes continue through it. */
function detailsRow(anchor: Row, content: string): HTMLTableRowElement {
  const lanes = anchor.layout.segments
    .filter(sg => sg.half === 'bottom' && sg.to < MAX_LANES)
    .map(sg => `<i class="bar b${sg.color % 10}" style="left:${4 + x(sg.to) - 1}px"></i>`)
    .join('');
  const tr = document.createElement('tr');
  tr.className = 'details';
  tr.innerHTML = `<td colspan="5"><div class="details-wrap">${lanes}<div class="panel">${content}</div></div></td>`;
  return tr;
}

const shortOf = (h: string) => (h === WORKING_TREE ? 'working tree' : h.slice(0, 7));

function renderComparison(c: Comparison): void {
  if (!expanded || !comparing) return;
  document.querySelector('tr.details')?.remove();
  const anchor = tbody.querySelector<HTMLTableRowElement>(`tr.commit[data-i="${rows.findIndex(r => r.hash === comparing)}"]`);
  if (!anchor) return;
  const tr = detailsRow(rows.find(r => r.hash === comparing)!, `
      <div class="meta"><div><b>Comparing</b> <code>${shortOf(c.from)}</code> ↔ <code>${shortOf(c.to)}</code></div>
      <div>${c.files.length} file${c.files.length === 1 ? '' : 's'} changed</div>
      <div class="tip">Click a file to open its diff. Press Esc to exit compare.</div></div>
      <ul class="files">${fileList(c.files) || '<li class="empty">No differences</li>'}</ul>`);
  tr.querySelectorAll<HTMLElement>('.file').forEach(li =>
    li.addEventListener('click', () => send({ type: 'openDiff', hash: c.to, base: c.from, file: c.files[Number(li.dataset.k)] })),
  );
  anchor.after(tr);
}

function startCompare(hash: string): void {
  if (!expanded || hash === expanded) return;
  // Without Pro the host only shows the upgrade prompt; stay in normal mode.
  if (!state?.pro) return send({ type: 'compare', from: expanded, to: hash });
  comparing = hash;
  tbody.querySelector('tr.comparing')?.classList.remove('comparing');
  tbody.querySelector(`tr.commit[data-i="${rows.findIndex(r => r.hash === hash)}"]`)?.classList.add('comparing');
  send({ type: 'compare', from: expanded, to: hash });
}

function toggleDetails(hash: string): void {
  document.querySelector('tr.details')?.remove();
  tbody.querySelector('tr.selected')?.classList.remove('selected');
  tbody.querySelector('tr.comparing')?.classList.remove('comparing');
  comparing = null;
  if (expanded === hash) {
    expanded = null;
    return;
  }
  expanded = hash;
  tbody.querySelector(`tr.commit[data-i="${rows.findIndex(r => r.hash === hash)}"]`)?.classList.add('selected');
  send({ type: 'details', hash });
}

// ---------- context menus ----------

type MenuItem = { label: string; run: () => void; danger?: boolean } | 'sep';

function openMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault();
  menu.innerHTML = items
    .map((it, k) => (it === 'sep' ? '<hr>' : `<div class="item${it.danger ? ' danger' : ''}" data-k="${k}">${esc(it.label)}</div>`))
    .join('');
  menu.querySelectorAll<HTMLElement>('.item').forEach(el =>
    el.addEventListener('click', () => {
      closeMenu();
      (items[Number(el.dataset.k)] as Exclude<MenuItem, 'sep'>).run();
    }),
  );
  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, innerHeight - r.height - 4)}px`;
}

const closeMenu = () => (menu.hidden = true);

function commitMenu(row: Row): MenuItem[] {
  const act = (action: CommitAction) => () => send({ type: 'commitAction', action, hash: row.hash, subject: row.subject, stash: row.stash });
  if (row.stash) {
    return [
      { label: 'Apply Stash', run: act('stashApply') },
      { label: 'Pop Stash', run: act('stashPop') },
      { label: 'Create Branch from Stash…', run: act('stashBranch') },
      'sep',
      { label: 'Drop Stash…', run: act('stashDrop'), danger: true },
      'sep',
      { label: 'Copy Commit Hash', run: act('copyHash') },
    ];
  }
  const compare: MenuItem[] = expanded && expanded !== row.hash
    ? [{ label: `Compare with ${shortOf(expanded)}${state?.pro ? '' : ' (Pro)'}`, run: () => startCompare(row.hash) }, 'sep']
    : [];
  return [
    ...compare,
    { label: 'Create Branch…', run: act('createBranch') },
    { label: 'Create Tag…', run: act('createTag') },
    { label: 'Checkout (detached)', run: act('checkout') },
    'sep',
    { label: 'Cherry-pick onto current branch', run: act('cherryPick') },
    { label: 'Revert…', run: act('revert') },
    'sep',
    { label: 'Reset current branch here (soft)', run: act('resetSoft') },
    { label: 'Reset current branch here (mixed)', run: act('resetMixed') },
    { label: 'Reset current branch here (hard)…', run: act('resetHard'), danger: true },
    'sep',
    { label: 'Copy Commit Hash', run: act('copyHash') },
    { label: 'Copy Subject', run: act('copySubject') },
  ];
}

function refMenu(ref: Ref): MenuItem[] {
  const act = (action: RefAction) => () => send({ type: 'refAction', action, ref });
  const current = ref.type === 'head' && ref.name === state?.branch;
  const items: MenuItem[] = [];
  if (!current && ref.type !== 'stash') items.push({ label: ref.type === 'remote' ? 'Checkout as local branch' : 'Checkout', run: act('checkout') });
  if (!current && ref.type !== 'stash' && state?.branch) {
    items.push({ label: `Merge into ${state.branch}…`, run: act('merge') }, { label: `Rebase ${state.branch} onto this…`, run: act('rebase') });
  }
  if (ref.type === 'head') items.push('sep', { label: 'Rename…', run: act('rename') }, { label: 'Push to origin', run: act('push') });
  if (ref.type === 'tag') items.push('sep', { label: 'Push tag to origin', run: act('push') });
  if (!current && ref.type !== 'stash') items.push({ label: ref.type === 'remote' ? 'Delete remote branch…' : 'Delete…', run: act('delete'), danger: true });
  items.push('sep', { label: 'Copy Name', run: act('copyName') });
  return items.filter((it, k, all) => !(it === 'sep' && (k === 0 || all[k - 1] === 'sep')));
}

// ---------- events ----------

const rowOf = (el: Element | null) => {
  const tr = el?.closest<HTMLElement>('tr.commit');
  return tr ? rows[Number(tr.dataset.i)] : undefined;
};

tbody.addEventListener('click', ev => {
  const target = ev.target as HTMLElement;
  const copy = target.closest<HTMLElement>('.copy');
  if (copy) return send({ type: 'commitAction', action: 'copyHash', hash: copy.dataset.copy!, subject: '' });
  const jump = target.closest<HTMLElement>('.jump');
  if (jump) {
    const i = rows.findIndex(r => r.hash === jump.dataset.hash);
    if (i !== -1) {
      toggleDetails(rows[i].hash);
      tbody.querySelector(`tr.commit[data-i="${i}"]`)?.scrollIntoView({ block: 'center' });
    }
    return;
  }
  const row = rowOf(target);
  if (!row) return;
  if ((ev.metaKey || ev.ctrlKey) && expanded && row.hash !== expanded) startCompare(row.hash);
  else toggleDetails(row.hash);
});

tbody.addEventListener('contextmenu', ev => {
  const target = ev.target as HTMLElement;
  const badge = target.closest<HTMLElement>('.ref[data-ref]');
  if (badge) return openMenu(ev, refMenu(JSON.parse(badge.dataset.ref!)));
  const row = rowOf(target);
  if (row && row.hash !== WORKING_TREE) openMenu(ev, commitMenu(row));
});

tbody.addEventListener('dblclick', ev => {
  const badge = (ev.target as HTMLElement).closest<HTMLElement>('.ref[data-ref]');
  if (badge) send({ type: 'refAction', action: 'checkout', ref: JSON.parse(badge.dataset.ref!) });
});

document.addEventListener('click', ev => {
  if (!menu.contains(ev.target as Node)) closeMenu();
});
window.addEventListener('blur', closeMenu);
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    if (!menu.hidden) closeMenu();
    else if (comparing && expanded) {
      const h = expanded;
      expanded = null;
      toggleDetails(h);
    } else if (expanded) toggleDetails(expanded);
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'f') {
    ev.preventDefault();
    search.focus();
    search.select();
  }
});

let searchTimer: number | undefined;
const sendFilter = () => send({ type: 'setFilter', allRefs: allRefs.checked, search: search.value.trim() });
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(sendFilter, 300);
});
allRefs.addEventListener('change', sendFilter);
repoSelect.addEventListener('change', () => send({ type: 'selectRepo', repo: repoSelect.value }));
$('refresh').addEventListener('click', () => send({ type: 'refresh' }));
$('fetch').addEventListener('click', () => send({ type: 'fetch' }));
$('pro').addEventListener('click', () => send({ type: 'getPro' }));
$('clearPath').addEventListener('click', () => send({ type: 'clearPath' }));

const scroller = $('scroller');
scroller.addEventListener('scroll', maybeLoadMore);
function maybeLoadMore(): void {
  if (!hasMore || loadingMore) return;
  if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - ROW * 40) {
    loadingMore = true;
    send({ type: 'loadMore' });
  }
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'loading':
      if (rows.length === 0) statusEl.textContent = 'Loading…';
      break;
    case 'rows':
      $('error').hidden = true;
      state = m.state;
      hasMore = m.hasMore;
      loadingMore = false;
      renderToolbar();
      if (m.reset) {
        rows = m.rows;
        render();
      } else {
        appendRows(m.rows);
      }
      maybeLoadMore(); // fill the viewport on tall screens
      break;
    case 'details':
      if (!comparing) renderDetails(m.hash, m.details);
      break;
    case 'dirty': {
      const wt = rows.find(r => r.hash === WORKING_TREE);
      if (wt) {
        wt.subject = `Uncommitted changes (${m.count})`;
        const el = tbody.querySelector(`tr.commit[data-i="${rows.indexOf(wt)}"] .subject`);
        if (el) el.textContent = wt.subject;
      }
      break;
    }
    case 'comparison':
      renderComparison(m.comparison);
      break;
    case 'error': {
      loadingMore = false;
      const el = $('error');
      el.textContent = m.message;
      el.hidden = false;
      break;
    }
  }
});

send({ type: 'ready' });
