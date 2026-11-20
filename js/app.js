import { db } from './db.js';
import { makePdf } from './pdf.js';

// ページ座標系：幅 1000 × 高さ 1414（A4 比）。描画データはすべてこの単位で保存する
const PW = 1000, PH = 1414;
const MAX_CANVAS_W = 2400; // iPad のキャンバスメモリ上限対策

const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k.startsWith('on')) e[k] = v;
    else if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((k) => k != null));
  return e;
}

// ---------------------------------------------------------------- 設定
const PAPERS = { blank: '無地', ruled: '罫線', grid: '方眼', dots: 'ドット' };
const COVERS = ['#ff9f0a', '#0a7aff', '#34c759', '#ff375f', '#af52de', '#5ac8fa', '#8e8e93', '#1c1c1e'];
const PALETTE = {
  pen: ['#1f1f1f', '#1e5bd8', '#e0352b', '#159447', '#8a3ffc'],
  hl: ['#ffe14d', '#ff9bd2', '#8ef0a6', '#8fd3ff', '#ffb36b'],
};
const SIZES = { pen: [1.2, 2.4, 4.5], hl: [12, 20, 32], eraser: [8, 18, 40] };
const SIZE_DOTS = [5, 9, 14];

const settings = {
  tool: 'pen',
  pen: { color: '#1f1f1f', size: 1 },
  hl: { color: '#ffe14d', size: 1 },
  eraser: { size: 1 },
  finger: false, // 指で書く（オフなら指はスクロール、ペンだけが書ける）
};
try { Object.assign(settings, JSON.parse(localStorage.getItem('tegaki-settings') || '{}')); } catch { /* 既定値 */ }
const saveSettings = () => { try { localStorage.setItem('tegaki-settings', JSON.stringify(settings)); } catch { /* 無視 */ } };

// ---------------------------------------------------------------- UI 部品
let toastT;
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, ms);
}

function openSheet(build) {
  const el = $('#sheet'), bg = $('#sheetBg');
  el.innerHTML = '';
  el.hidden = bg.hidden = false;
  const close = () => { el.hidden = bg.hidden = true; el.innerHTML = ''; bg.onclick = null; };
  bg.onclick = close;
  build(el, close);
  return close;
}

function confirmDialog(msg, ok = 'OK', danger = false) {
  return new Promise((res) => {
    openSheet((el, close) => {
      const done = (v) => { close(); res(v); };
      $('#sheetBg').onclick = () => done(false);
      el.append(
        h('p', { text: msg }),
        h('div', { class: 'actions' },
          h('button', { text: 'キャンセル', onclick: () => done(false) }),
          h('button', { class: danger ? 'danger' : 'primary', text: ok, onclick: () => done(true) })),
      );
    });
  });
}

// 書き出したファイルを共有／保存する。共有はユーザー操作の直後でないと拒否されるため、
// 生成後にボタンを押してもらう
function offerFile(blob, name) {
  openSheet((el, close) => {
    el.append(
      h('h2', { text: '書き出しました' }),
      h('p', { text: `${name}（${Math.max(1, Math.round(blob.size / 1024))} KB）` }),
      h('div', { class: 'actions' },
        h('button', { text: '閉じる', onclick: close }),
        h('button', { class: 'primary', text: '共有・保存', onclick: async () => { close(); await shareOrDownload(blob, name); } })),
    );
  });
}
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}
const safeName = (s) => (s || 'ノート').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

// ---------------------------------------------------------------- 描画
function drawPaper(ctx, type, s) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PW * s, PH * s);
  const step = 40;
  ctx.lineWidth = Math.max(1, 1.1 * s);
  if (type === 'ruled') {
    ctx.strokeStyle = '#c6d4e8';
    ctx.beginPath();
    for (let y = 120; y < PH - 30; y += step) { ctx.moveTo(0, y * s); ctx.lineTo(PW * s, y * s); }
    ctx.stroke();
    ctx.strokeStyle = '#f2c4c4';
    ctx.beginPath(); ctx.moveTo(90 * s, 0); ctx.lineTo(90 * s, PH * s); ctx.stroke();
  } else if (type === 'grid') {
    ctx.strokeStyle = '#dde5ef';
    ctx.beginPath();
    for (let y = step; y < PH; y += step) { ctx.moveTo(0, y * s); ctx.lineTo(PW * s, y * s); }
    for (let x = step; x < PW; x += step) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, PH * s); }
    ctx.stroke();
  } else if (type === 'dots') {
    ctx.fillStyle = '#b9c3d0';
    const r = Math.max(1, 1.7 * s);
    for (let y = step; y < PH; y += step) {
      for (let x = step; x < PW; x += step) { ctx.beginPath(); ctx.arc(x * s, y * s, r, 0, 7); ctx.fill(); }
    }
  }
}

const pf = (pr) => 0.35 + 1.0 * pr; // 筆圧 → 太さ倍率

// ペンの1区間。点 P0..Pn-1 の中点を結ぶ二次曲線でなめらかにする
function drawSeg(ctx, st, i, s, final) {
  const p = st.p;
  const n = p.length / 3;
  const X = (k) => p[k * 3] * s, Y = (k) => p[k * 3 + 1] * s, P = (k) => p[k * 3 + 2];
  const MX = (k) => (X(k - 1) + X(k)) / 2, MY = (k) => (Y(k - 1) + Y(k)) / 2;
  ctx.beginPath();
  let pr;
  if (final) {
    ctx.moveTo(MX(i), MY(i)); ctx.lineTo(X(i), Y(i)); pr = P(i);
  } else if (i === 0) {
    ctx.moveTo(X(0), Y(0)); ctx.lineTo(MX(1), MY(1)); pr = (P(0) + P(1)) / 2;
  } else {
    ctx.moveTo(MX(i), MY(i)); ctx.quadraticCurveTo(X(i), Y(i), MX(i + 1), MY(i + 1)); pr = P(i);
  }
  if (n === 0) return;
  ctx.lineWidth = Math.max(0.6, st.w * pf(pr) * s);
  ctx.stroke();
}

function hlPath(ctx, st, s) {
  const p = st.p, n = p.length / 3;
  ctx.beginPath();
  ctx.moveTo(p[0] * s, p[1] * s);
  if (n === 1) ctx.lineTo(p[0] * s + 0.01, p[1] * s);
  for (let i = 1; i < n - 1; i++) {
    const mx = (p[i * 3] + p[i * 3 + 3]) / 2, my = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
    ctx.quadraticCurveTo(p[i * 3] * s, p[i * 3 + 1] * s, mx * s, my * s);
  }
  if (n > 1) ctx.lineTo(p[(n - 1) * 3] * s, p[(n - 1) * 3 + 1] * s);
}

function drawStroke(ctx, st, s, live = false) {
  const n = st.p.length / 3;
  if (!n) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = st.c;
  if (st.t === 'hl') {
    if (!live) { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; }
    ctx.lineWidth = st.w * s;
    hlPath(ctx, st, s);
    ctx.stroke();
  } else if (n === 1) {
    ctx.beginPath();
    ctx.arc(st.p[0] * s, st.p[1] * s, Math.max(0.6, st.w * pf(st.p[2]) * s) / 2, 0, 7);
    ctx.fill();
  } else {
    for (let i = 0; i < n - 1; i++) drawSeg(ctx, st, i, s, false);
    drawSeg(ctx, st, n - 1, s, true);
  }
  ctx.restore();
}

function renderPageTo(ctx, page, s) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawPaper(ctx, page.paper, s);
  for (const st of page.strokes) drawStroke(ctx, st, s);
}

// ---------------------------------------------------------------- 幾何
const bboxCache = new WeakMap();
function bbox(st) {
  let b = bboxCache.get(st);
  if (b) return b;
  const p = st.p;
  b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < b.x0) b.x0 = p[i]; if (p[i] > b.x1) b.x1 = p[i];
    if (p[i + 1] < b.y0) b.y0 = p[i + 1]; if (p[i + 1] > b.y1) b.y1 = p[i + 1];
  }
  const pad = st.w; b.x0 -= pad; b.y0 -= pad; b.x1 += pad; b.y1 += pad;
  bboxCache.set(st, b);
  return b;
}
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
function hitStroke(st, x, y, r) {
  const b = bbox(st);
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  const p = st.p, rr = (r + st.w / 2) ** 2;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr;
  for (let i = 0; i + 3 < p.length; i += 3) {
    if (segDist2(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= rr) return true;
  }
  return false;
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function translate(strokes, dx, dy) {
  for (const st of strokes) {
    for (let i = 0; i < st.p.length; i += 3) { st.p[i] = r1(st.p[i] + dx); st.p[i + 1] = r1(st.p[i + 1] + dy); }
    bboxCache.delete(st);
  }
}

// ================================================================ ノート一覧
async function showLibrary() {
  await closeEditor();
  $('#editor').hidden = true;
  $('#library').hidden = false;
  await renderShelf();
}

async function renderShelf() {
  const list = (await db.notebooks()).sort((a, b) => b.updated - a.updated);
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  $('#emptyMsg').hidden = list.length > 0;
  for (const nb of list) {
    const d = new Date(nb.updated);
    const card = h('div', { class: 'card' },
      h('button', {
        class: 'thumb', 'aria-label': nb.title,
        style: `--cover:${nb.cover};${nb.thumb ? `background-image:url(${nb.thumb})` : ''}`,
        onclick: () => openNotebook(nb.id),
      }),
      h('div', { class: 'name', text: nb.title }),
      h('div', { class: 'meta', text: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}・${nb.pageIds.length}ページ` }),
      h('button', { class: 'more', text: '…', 'aria-label': 'ノートのメニュー', onclick: () => notebookMenu(nb) }),
    );
    shelf.append(card);
  }
}

function notebookForm({ title, cover, paper, submit, onSubmit }) {
  openSheet((el, close) => {
    let c = cover, pp = paper;
    const input = h('input', { type: 'text', value: title, placeholder: 'ノートの名前' });
    const covers = h('div', { class: 'covers' });
    const drawCovers = () => {
      covers.innerHTML = '';
      for (const col of COVERS) {
        covers.append(h('button', { class: col === c ? 'on' : '', style: `background:${col}`, 'aria-label': '表紙の色', onclick: () => { c = col; drawCovers(); } }));
      }
    };
    drawCovers();
    const papers = h('div', { class: 'row' });
    const drawPapers = () => {
      papers.innerHTML = '';
      for (const [k, v] of Object.entries(PAPERS)) papers.append(h('button', { class: k === pp ? 'on' : '', text: v, onclick: () => { pp = k; drawPapers(); } }));
    };
    drawPapers();
    el.append(
      h('h2', { text: submit === '作成' ? '新しいノート' : 'ノートの設定' }),
      input,
      h('div', { class: 'label', text: '表紙の色' }), covers,
      paper != null ? h('div', { class: 'label', text: '用紙' }) : null, paper != null ? papers : null,
      h('div', { class: 'actions' },
        h('button', { text: 'キャンセル', onclick: close }),
        h('button', { class: 'primary', text: submit, onclick: () => { close(); onSubmit({ title: input.value.trim() || '無題のノート', cover: c, paper: pp }); } })),
    );
  });
}

function newNotebook() {
  const d = new Date();
  notebookForm({
    title: `ノート ${d.getMonth() + 1}/${d.getDate()}`,
    cover: COVERS[Math.floor(Math.random() * 6)],
    paper: 'ruled',
    submit: '作成',
    onSubmit: async ({ title, cover, paper }) => {
      const now = Date.now();
      const page = { id: uid(), notebookId: null, paper, strokes: [] };
      const nb = { id: uid(), title, cover, paper, created: now, updated: now, pageIds: [page.id], thumb: null };
      page.notebookId = nb.id;
      await db.putPages([page], nb);
      openNotebook(nb.id);
    },
  });
}

function notebookMenu(nb) {
  openSheet((el, close) => {
    el.append(
      h('h2', { text: nb.title }),
      h('button', {
        class: 'item', text: '名前と表紙を変更', onclick: () => {
          close();
          notebookForm({
            title: nb.title, cover: nb.cover, submit: '保存',
            onSubmit: async ({ title, cover }) => { Object.assign(nb, { title, cover }); await db.putNotebook(nb); renderShelf(); },
          });
        },
      }),
      h('button', { class: 'item', text: 'PDFで書き出す', onclick: () => { close(); exportPdf(nb); } }),
      h('button', {
        class: 'item danger', text: '削除', onclick: async () => {
          close();
          if (await confirmDialog(`「${nb.title}」を削除しますか？\nこの操作は元に戻せません。`, '削除', true)) {
            await db.deleteNotebook(nb); renderShelf(); toast('削除しました');
          }
        },
      }),
    );
  });
}

function libraryMenu() {
  openSheet((el, close) => {
    el.append(
      h('h2', { text: 'バックアップ' }),
      h('button', {
        class: 'item', text: 'すべてのノートを書き出す（.json）', onclick: async () => {
          close();
          const data = await db.exportAll();
          const d = new Date();
          const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          offerFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `tegaki-backup-${stamp}.json`);
        },
      }),
      h('button', { class: 'item', text: 'バックアップから復元', onclick: () => { close(); $('#importFile').click(); } }),
      h('p', { style: 'font-size:13px;color:var(--sub)', text: 'ノートはこの端末のブラウザ内に保存されます。機種変更や万一に備えて、ときどき書き出しておくと安心です。' }),
    );
  });
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'tegaki' || !Array.isArray(data.notebooks) || !Array.isArray(data.pages)) throw new Error('形式が違います');
    if (!(await confirmDialog(`${data.notebooks.length}冊のノートを復元します。同じノートがある場合は上書きされます。`, '復元'))) return;
    await db.importAll(data);
    await renderShelf();
    toast('復元しました');
  } catch (e) {
    toast(`復元できませんでした：${e.message}`, 3000);
  }
}

// ================================================================ エディタ
const ed = {
  nb: null, pages: [], map: new Map(), // pageId → { page, div, canvas, ctx, scale }
  zoom: 1, baseW: 800, pageW: 800, cur: 0,
  undo: [], redo: [], dirty: new Set(), saveT: 0,
  live: null, io: null, renderQ: new Set(),
};
let act = null;   // 描画中の操作
let sel = null;   // なげなわ選択 { entry, strokes, box, div }
let pinch = null; // 2本指ジェスチャ
let fingers = 0;  // 画面に触れている指の数（ペンを除く）

const scroller = $('#scroller');
const pagesEl = $('#pages');
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

async function openNotebook(id) {
  const nb = await db.notebook(id);
  if (!nb) return;
  ed.nb = nb;
  ed.pages = await db.pages(nb);
  if (!ed.pages.length) { // 念のため（空のノート）
    const page = { id: uid(), notebookId: nb.id, paper: nb.paper || 'blank', strokes: [] };
    ed.pages = [page]; nb.pageIds = [page.id];
    await db.putPages([page], nb);
  }
  ed.undo = []; ed.redo = []; ed.zoom = 1; ed.cur = 0;
  $('#library').hidden = true;
  $('#editor').hidden = false;
  $('#nbTitle').textContent = nb.title;
  renderToolbar();
  rebuildPages();
  scroller.scrollTop = 0; scroller.scrollLeft = 0;
  updateUndoButtons();
}

async function closeEditor() {
  if (!ed.nb) return;
  cancelAct();
  clearSel();
  await flush();
  if (ed.io) ed.io.disconnect();
  for (const e of ed.map.values()) releaseCanvas(e);
  ed.map.clear();
  pagesEl.innerHTML = '';
  ed.nb = null; ed.pages = [];
}

function rebuildPages() {
  clearSel();
  if (ed.io) ed.io.disconnect();
  for (const e of ed.map.values()) releaseCanvas(e);
  ed.map.clear();
  pagesEl.innerHTML = '';
  ed.io = new IntersectionObserver((items) => {
    for (const it of items) {
      const e = ed.map.get(it.target.dataset.id);
      if (!e) continue;
      if (it.isIntersecting) ensureCanvas(e);
      else if (!(act && act.entry === e)) releaseCanvas(e);
    }
  }, { root: scroller, rootMargin: '120% 60%' });
  ed.pages.forEach((page, i) => {
    const div = h('div', { class: 'page', 'data-id': page.id }, h('span', { class: 'pno', text: `${i + 1}` }));
    pagesEl.append(div);
    ed.map.set(page.id, { page, div, canvas: null, ctx: null, scale: 1 });
    ed.io.observe(div);
  });
  layout();
  updatePageNo();
}

function layout() {
  const avail = Math.max(200, scroller.clientWidth - 32);
  ed.baseW = Math.min(avail, 1100);
  ed.pageW = Math.round(ed.baseW * ed.zoom);
  const ph = Math.round(ed.pageW * PH / PW);
  for (const e of ed.map.values()) { e.div.style.width = `${ed.pageW}px`; e.div.style.height = `${ph}px`; }
  if (sel) placeSelMenu();
}

function ensureCanvas(e, force = false) {
  const w = Math.min(MAX_CANVAS_W, Math.round(ed.pageW * dpr()));
  const hgt = Math.round(w * PH / PW);
  if (!e.canvas) {
    e.canvas = h('canvas');
    e.div.prepend(e.canvas);
    e.ctx = e.canvas.getContext('2d');
    force = true;
  }
  if (force || e.canvas.width !== w) {
    e.canvas.width = w; e.canvas.height = hgt;
    e.scale = w / PW;
    renderPageTo(e.ctx, e.page, e.scale);
  }
}
function releaseCanvas(e) {
  if (!e.canvas) return;
  e.canvas.width = e.canvas.height = 0; // iOS ではこれでメモリが解放される
  e.canvas.remove();
  e.canvas = e.ctx = null;
}
function scheduleRender(e) {
  if (!ed.renderQ.size) {
    requestAnimationFrame(() => {
      for (const x of ed.renderQ) if (x.ctx) renderPageTo(x.ctx, x.page, x.scale);
      ed.renderQ.clear();
    });
  }
  ed.renderQ.add(e);
}
let reresT;
function reresolve() { // ズーム・回転後に解像度を合わせ直す
  clearTimeout(reresT);
  reresT = setTimeout(() => { for (const e of ed.map.values()) if (e.canvas) ensureCanvas(e); }, 120);
}

function updatePageNo() {
  const mid = scroller.scrollTop + scroller.clientHeight / 2;
  let best = 0;
  ed.pages.forEach((p, i) => {
    const e = ed.map.get(p.id);
    if (e && e.div.offsetTop <= mid) best = i;
  });
  ed.cur = best;
  $('#pageNo').textContent = `${best + 1} / ${ed.pages.length}`;
}
let scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePageNo(); if (sel) placeSelMenu(); });
});
window.addEventListener('resize', () => { if (ed.nb) { layout(); reresolve(); } });

// ---------------------------------------------------------------- ツールバー
function renderToolbar() {
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === settings.tool);
  const t = settings.tool;
  const colors = $('#colors'), sizes = $('#sizes');
  colors.innerHTML = ''; sizes.innerHTML = '';
  if (t === 'pen' || t === 'hl') {
    const cur = settings[t].color;
    for (const c of PALETTE[t]) {
      colors.append(h('button', {
        class: `swatch${c === cur ? ' on' : ''}`, 'aria-label': '色', onclick: () => { settings[t].color = c; saveSettings(); renderToolbar(); },
      }, h('i', { style: `background:${c}` })));
    }
    const custom = !PALETTE[t].includes(cur);
    const input = h('input', { type: 'color', value: cur, 'aria-label': '色を選ぶ' });
    input.oninput = () => { settings[t].color = input.value; saveSettings(); };
    input.onchange = () => renderToolbar();
    colors.append(h('label', { class: `swatch custom${custom ? ' on' : ''}` }, h('i', { style: custom ? `background:${cur}` : null }), input));
  }
  if (t !== 'lasso') {
    SIZE_DOTS.forEach((d, i) => {
      const on = settings[t].size === i;
      sizes.append(h('button', {
        class: `size${on ? ' on' : ''}`, 'aria-label': ['細', '中', '太'][i],
        onclick: () => { settings[t].size = i; saveSettings(); renderToolbar(); },
      }, h('i', { style: `width:${d}px;height:${d}px;${t === 'eraser' ? 'background:none;border:2px solid currentColor' : ''}` })));
    });
  }
  scroller.classList.toggle('finger', settings.finger);
}
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('.tool');
  if (!b) return;
  settings.tool = b.dataset.tool;
  saveSettings();
  clearSel();
  renderToolbar();
});

// ---------------------------------------------------------------- 入力（ペン・指）
function point(e) {
  const r = act.rect;
  let pr = 0.5;
  if (e.pointerType === 'pen') pr = Math.max(0.05, Math.min(1, e.pressure || 0.05));
  return { x: ((e.clientX - r.left) / r.width) * PW, y: ((e.clientY - r.top) / r.height) * PH, p: pr };
}

function liveCanvas(e, cls) {
  if (!ed.live) { ed.live = h('canvas'); ed.liveCtx = ed.live.getContext('2d'); }
  const c = ed.live;
  c.className = `live ${cls}`;
  if (c.width !== e.canvas.width || c.height !== e.canvas.height) { c.width = e.canvas.width; c.height = e.canvas.height; }
  else ed.liveCtx.clearRect(0, 0, c.width, c.height);
  e.div.append(c);
  return ed.liveCtx;
}
function clearLive() {
  if (!ed.live) return;
  ed.liveCtx.clearRect(0, 0, ed.live.width, ed.live.height);
  ed.live.remove();
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (!ed.nb) return;
  if (e.pointerType === 'touch' && (!settings.finger || pinch || fingers > 1)) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (act) {
    if (e.pointerType === 'pen' && act.ptype === 'touch') cancelAct(); // ペンが来たら手のひらの線は捨てる
    else return;
  }
  const div = e.target.closest('.page');
  if (!div) { clearSel(); return; }
  const entry = ed.map.get(div.dataset.id);
  e.preventDefault();
  ensureCanvas(entry);
  act = { id: e.pointerId, ptype: e.pointerType, entry, rect: div.getBoundingClientRect(), tool: settings.tool };
  const pt = point(e);
  const t = act.tool;
  if (t === 'pen' || t === 'hl') {
    if (sel) clearSel();
    act.stroke = { t, c: settings[t].color, w: SIZES[t][settings[t].size], p: [] };
    act.ctx = liveCanvas(entry, t === 'hl' ? 'hl' : '');
    addPoint(pt);
  } else if (t === 'eraser') {
    if (sel) clearSel();
    act.r = SIZES.eraser[settings.eraser.size];
    act.removed = [];
    act.last = pt;
    act.ctx = liveCanvas(entry, '');
    eraseAt(pt);
  } else if (t === 'lasso') {
    if (sel && sel.entry === entry && pt.x >= sel.box.x0 && pt.x <= sel.box.x1 && pt.y >= sel.box.y0 && pt.y <= sel.box.y1) {
      act.mode = 'move'; act.last = pt; act.dx = 0; act.dy = 0;
      $('#selMenu').hidden = true;
    } else {
      clearSel();
      act.mode = 'lasso'; act.poly = [pt];
      act.ctx = liveCanvas(entry, '');
    }
  }
});

window.addEventListener('pointermove', (e) => {
  if (!act || e.pointerId !== act.id) return;
  const list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const ev of list.length ? list : [e]) moveAct(point(ev));
});
window.addEventListener('pointerup', (e) => { if (act && e.pointerId === act.id) endAct(); });
window.addEventListener('pointercancel', (e) => {
  if (!act || e.pointerId !== act.id) return;
  if (act.ptype === 'touch') cancelAct(); else endAct();
});

function addPoint(pt) {
  const st = act.stroke, p = st.p;
  if (p.length) {
    const dx = pt.x - p[p.length - 3], dy = pt.y - p[p.length - 2];
    if (dx * dx + dy * dy < 0.36) { p[p.length - 1] = Math.max(p[p.length - 1], r2(pt.p)); return; }
  }
  p.push(r1(pt.x), r1(pt.y), r2(pt.p));
  const n = p.length / 3, s = act.entry.scale, ctx = act.ctx;
  if (st.t === 'hl') {
    ctx.clearRect(0, 0, ed.live.width, ed.live.height);
    drawStroke(ctx, st, s, true);
  } else if (n === 1) {
    drawStroke(ctx, st, s);
  } else {
    ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = st.c;
    drawSeg(ctx, st, n - 2, s, false);
    ctx.restore();
  }
}

function eraseAt(pt) {
  const page = act.entry.page, r = act.r;
  const from = act.last;
  const dist = Math.hypot(pt.x - from.x, pt.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (r / 2)));
  let changed = false;
  for (let k = 1; k <= steps; k++) {
    const x = from.x + ((pt.x - from.x) * k) / steps, y = from.y + ((pt.y - from.y) * k) / steps;
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      if (hitStroke(page.strokes[i], x, y, r)) {
        act.removed.push({ stroke: page.strokes[i], index: i });
        page.strokes.splice(i, 1);
        changed = true;
      }
    }
  }
  act.last = pt;
  if (changed) scheduleRender(act.entry);
  // 消しゴムの円を表示
  const ctx = act.ctx, s = act.entry.scale;
  ctx.clearRect(0, 0, ed.live.width, ed.live.height);
  ctx.beginPath(); ctx.arc(pt.x * s, pt.y * s, r * s, 0, 7);
  ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fill();
  ctx.lineWidth = Math.max(1, s); ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
}

function moveAct(pt) {
  const t = act.tool;
  if (t === 'pen' || t === 'hl') addPoint(pt);
  else if (t === 'eraser') eraseAt(pt);
  else if (act.mode === 'lasso') {
    const last = act.poly[act.poly.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < 2) return;
    act.poly.push(pt);
    const ctx = act.ctx, s = act.entry.scale;
    ctx.clearRect(0, 0, ed.live.width, ed.live.height);
    ctx.beginPath();
    act.poly.forEach((q, i) => (i ? ctx.lineTo(q.x * s, q.y * s) : ctx.moveTo(q.x * s, q.y * s)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,122,255,.06)'; ctx.fill();
    ctx.setLineDash([6 * s, 5 * s]); ctx.lineWidth = Math.max(1, 1.5 * s); ctx.strokeStyle = '#0a7aff'; ctx.stroke();
    ctx.setLineDash([]);
  } else if (act.mode === 'move') {
    const dx = pt.x - act.last.x, dy = pt.y - act.last.y;
    act.last = pt;
    act.dx += dx; act.dy += dy;
    translate(sel.strokes, dx, dy);
    sel.box.x0 += dx; sel.box.x1 += dx; sel.box.y0 += dy; sel.box.y1 += dy;
    placeSelBox();
    scheduleRender(act.entry);
  }
}

function endAct() {
  const a = act;
  act = null;
  const e = a.entry;
  if (a.tool === 'pen' || a.tool === 'hl') {
    clearLive();
    if (a.stroke.p.length) {
      e.page.strokes.push(a.stroke);
      if (e.ctx) drawStroke(e.ctx, a.stroke, e.scale);
      pushUndo({ type: 'add', pageId: e.page.id, strokes: [a.stroke] });
      markDirty(e);
    }
  } else if (a.tool === 'eraser') {
    clearLive();
    if (a.removed.length) { pushUndo({ type: 'erase', pageId: e.page.id, items: a.removed }); markDirty(e); }
  } else if (a.mode === 'lasso') {
    clearLive();
    const poly = a.poly;
    if (poly.length < 3) return;
    const picked = e.page.strokes.filter((st) => {
      const p = st.p, n = p.length / 3;
      let inside = 0;
      for (let i = 0; i < p.length; i += 3) if (inPoly(p[i], p[i + 1], poly)) inside++;
      return inside * 2 >= n && inside > 0;
    });
    if (picked.length) setSel(e, picked);
  } else if (a.mode === 'move') {
    if (a.dx || a.dy) {
      pushUndo({ type: 'move', pageId: e.page.id, strokes: sel.strokes, dx: a.dx, dy: a.dy });
      markDirty(e);
    }
    placeSelMenu();
  }
}

function cancelAct() {
  if (!act) return;
  const a = act;
  act = null;
  clearLive();
  if (a.tool === 'eraser' && a.removed.length) { // 消した線を戻す
    for (let i = a.removed.length - 1; i >= 0; i--) a.entry.page.strokes.splice(a.removed[i].index, 0, a.removed[i].stroke);
    scheduleRender(a.entry);
  }
  if (a.mode === 'move' && (a.dx || a.dy)) {
    translate(sel.strokes, -a.dx, -a.dy);
    scheduleRender(a.entry);
    setSel(a.entry, sel.strokes);
  }
}

// ---------------------------------------------------------------- 2本指：ズーム・スクロール・タップで取り消し
const fingerList = (tl) => [...tl].filter((t) => t.touchType !== 'stylus');
scroller.addEventListener('touchstart', (e) => {
  if ([...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault(); // ペンでスクロールさせない
  const f = fingerList(e.touches);
  fingers = f.length;
  if (f.length >= 2 && !(act && act.ptype === 'pen')) {
    e.preventDefault();
    if (act && act.ptype === 'touch') cancelAct();
    startPinch(f);
  }
}, { passive: false });
scroller.addEventListener('touchmove', (e) => {
  const f = fingerList(e.touches);
  if (act && (act.ptype === 'pen' || act.ptype === 'touch')) { e.preventDefault(); return; } // 書いている間は手のひらでスクロールしない
  if (pinch && f.length >= 2) { e.preventDefault(); movePinch(f); }
}, { passive: false });
const touchEnd = (e) => {
  fingers = fingerList(e.touches).length;
  if (pinch && fingers < 2) endPinch();
};
scroller.addEventListener('touchend', touchEnd);
scroller.addEventListener('touchcancel', touchEnd);

function pinchGeom(f) {
  const [a, b] = f;
  return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}
function startPinch(f) {
  const g = pinchGeom(f);
  const r = scroller.getBoundingClientRect();
  pinch = {
    d0: g.d, z0: ed.zoom, t0: Date.now(), moved: 0, x0: g.x, y0: g.y,
    cx: (scroller.scrollLeft + g.x - r.left) / ed.zoom, cy: (scroller.scrollTop + g.y - r.top) / ed.zoom, r,
  };
}
function movePinch(f) {
  const g = pinchGeom(f);
  pinch.moved = Math.max(pinch.moved, Math.hypot(g.x - pinch.x0, g.y - pinch.y0), Math.abs(g.d - pinch.d0));
  const z = Math.min(4, Math.max(0.5, pinch.z0 * (g.d / pinch.d0)));
  if (Math.abs(z - ed.zoom) > 0.002) { ed.zoom = z; layout(); }
  scroller.scrollLeft = pinch.cx * ed.zoom - (g.x - pinch.r.left);
  scroller.scrollTop = pinch.cy * ed.zoom - (g.y - pinch.r.top);
}
function endPinch() {
  const p = pinch;
  pinch = null;
  if (Date.now() - p.t0 < 280 && p.moved < 12) { undo(); return; } // 2本指タップ＝取り消し
  if (Math.abs(ed.zoom - 1) < 0.06) { ed.zoom = 1; layout(); }
  reresolve();
}
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------------------------------------------------------------- 選択
function setSel(entry, strokes) {
  clearSel();
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const st of strokes) {
    const b = bbox(st);
    box.x0 = Math.min(box.x0, b.x0); box.y0 = Math.min(box.y0, b.y0);
    box.x1 = Math.max(box.x1, b.x1); box.y1 = Math.max(box.y1, b.y1);
  }
  box.x0 -= 6; box.y0 -= 6; box.x1 += 6; box.y1 += 6;
  sel = { entry, strokes, box, div: h('div', { class: 'sel' }) };
  entry.div.append(sel.div);
  placeSelBox();
  placeSelMenu();
}
function placeSelBox() {
  const b = sel.box, d = sel.div.style;
  d.left = `${(b.x0 / PW) * 100}%`; d.top = `${(b.y0 / PH) * 100}%`;
  d.width = `${((b.x1 - b.x0) / PW) * 100}%`; d.height = `${((b.y1 - b.y0) / PH) * 100}%`;
}
function placeSelMenu() {
  const m = $('#selMenu');
  const r = sel.div.getBoundingClientRect();
  const top = Math.max(r.top - 8, scroller.getBoundingClientRect().top + 50);
  m.style.left = `${Math.min(window.innerWidth - 90, Math.max(90, r.left + r.width / 2))}px`;
  m.style.top = `${top}px`;
  m.hidden = false;
}
function clearSel() {
  if (!sel) return;
  sel.div.remove();
  sel = null;
  $('#selMenu').hidden = true;
}
$('#selMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !sel) return;
  const { entry, strokes } = sel;
  const page = entry.page;
  if (b.dataset.act === 'delete') {
    const items = [];
    for (const st of strokes) {
      const i = page.strokes.indexOf(st);
      if (i >= 0) { items.push({ stroke: st, index: i }); page.strokes.splice(i, 1); }
    }
    clearSel();
    pushUndo({ type: 'erase', pageId: page.id, items });
  } else if (b.dataset.act === 'copy') {
    const copies = strokes.map((st) => ({ ...st, p: st.p.slice() }));
    translate(copies, 24, 24);
    page.strokes.push(...copies);
    pushUndo({ type: 'add', pageId: page.id, strokes: copies });
    setSel(entry, copies);
  }
  scheduleRender(entry);
  markDirty(entry);
});

// ---------------------------------------------------------------- 取り消し・やり直し
function pushUndo(op) {
  ed.undo.push(op);
  if (ed.undo.length > 300) ed.undo.shift();
  ed.redo = [];
  updateUndoButtons();
}
function applyOp(op, reverse) {
  const e = ed.map.get(op.pageId);
  if (!e) return;
  const s = e.page.strokes;
  const remove = (list) => { for (const st of list) { const i = s.indexOf(st); if (i >= 0) s.splice(i, 1); } };
  if (op.type === 'add') {
    if (reverse) remove(op.strokes); else s.push(...op.strokes);
  } else if (op.type === 'erase') {
    if (reverse) for (let i = op.items.length - 1; i >= 0; i--) s.splice(op.items[i].index, 0, op.items[i].stroke);
    else remove(op.items.map((x) => x.stroke));
  } else if (op.type === 'move') {
    translate(op.strokes, reverse ? -op.dx : op.dx, reverse ? -op.dy : op.dy);
  } else if (op.type === 'paper') {
    e.page.paper = reverse ? op.from : op.to;
  }
  scheduleRender(e);
  markDirty(e);
}
function undo() {
  if (act) return;
  const op = ed.undo.pop();
  if (!op) return;
  clearSel();
  applyOp(op, true);
  ed.redo.push(op);
  updateUndoButtons();
}
function redo() {
  if (act) return;
  const op = ed.redo.pop();
  if (!op) return;
  clearSel();
  applyOp(op, false);
  ed.undo.push(op);
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#undo').disabled = !ed.undo.length;
  $('#redo').disabled = !ed.redo.length;
}
$('#undo').onclick = undo;
$('#redo').onclick = redo;
document.addEventListener('keydown', (e) => {
  if (!ed.nb || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

// ---------------------------------------------------------------- 保存
function markDirty(e) {
  ed.dirty.add(e.page);
  ed.nb.updated = Date.now();
  clearTimeout(ed.saveT);
  ed.saveT = setTimeout(flush, 700);
}
async function flush() {
  clearTimeout(ed.saveT);
  if (!ed.nb || !ed.dirty.size) return;
  const pages = [...ed.dirty];
  ed.dirty.clear();
  if (pages.includes(ed.pages[0])) ed.nb.thumb = thumbnail(ed.pages[0]);
  try { await db.putPages(pages, ed.nb); } catch (err) {
    for (const p of pages) ed.dirty.add(p);
    toast(`保存できませんでした：${err.message}`, 4000);
  }
}
function thumbnail(page) {
  const c = h('canvas');
  c.width = 300; c.height = Math.round(300 * PH / PW);
  renderPageTo(c.getContext('2d'), page, 300 / PW);
  return c.toDataURL('image/jpeg', 0.75);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('pagehide', () => flush());

// ---------------------------------------------------------------- ページ操作
async function addPage() {
  const curPage = ed.pages[ed.cur];
  const page = { id: uid(), notebookId: ed.nb.id, paper: curPage ? curPage.paper : ed.nb.paper, strokes: [] };
  const at = ed.cur + 1;
  ed.pages.splice(at, 0, page);
  ed.nb.pageIds = ed.pages.map((p) => p.id);
  ed.nb.updated = Date.now();
  await flush();
  await db.putPages([page], ed.nb);
  const top = scroller.scrollTop;
  rebuildPages();
  scroller.scrollTop = top;
  const div = ed.map.get(page.id).div;
  scroller.scrollTo({ top: div.offsetTop - 16, behavior: 'smooth' });
  toast(`${at + 1}ページ目を追加しました`);
}

async function deletePage() {
  const page = ed.pages[ed.cur];
  if (ed.pages.length === 1) {
    if (!(await confirmDialog('このページの書き込みをすべて消しますか？', '消去', true))) return;
    const items = page.strokes.map((st, i) => ({ stroke: st, index: i })).reverse();
    page.strokes.splice(0);
    pushUndo({ type: 'erase', pageId: page.id, items });
    const e = ed.map.get(page.id);
    scheduleRender(e); markDirty(e);
    return;
  }
  if (!(await confirmDialog(`${ed.cur + 1}ページ目を削除しますか？\nこの操作は元に戻せません。`, '削除', true))) return;
  ed.pages.splice(ed.cur, 1);
  ed.nb.pageIds = ed.pages.map((p) => p.id);
  ed.nb.updated = Date.now();
  ed.dirty.delete(page);
  ed.undo = ed.undo.filter((op) => op.pageId !== page.id);
  ed.redo = ed.redo.filter((op) => op.pageId !== page.id);
  updateUndoButtons();
  if (ed.cur === 0) ed.nb.thumb = thumbnail(ed.pages[0]);
  await db.deletePage(page.id, ed.nb);
  const top = scroller.scrollTop;
  rebuildPages();
  scroller.scrollTop = top;
  toast('ページを削除しました');
}

function setPaper(type, all) {
  const targets = all ? ed.pages : [ed.pages[ed.cur]];
  for (const page of targets) {
    if (page.paper === type) continue;
    const op = { type: 'paper', pageId: page.id, from: page.paper, to: type };
    applyOp(op, false);
    pushUndo(op);
  }
  ed.nb.paper = type;
}

function editorMenu() {
  openSheet((el, close) => {
    const cur = ed.pages[ed.cur];
    const paperRow = h('div', { class: 'row' });
    for (const [k, v] of Object.entries(PAPERS)) {
      paperRow.append(h('button', { class: cur.paper === k ? 'on' : '', text: v, onclick: () => { setPaper(k, false); close(); } }));
    }
    const sw = h('span', { class: `switch${settings.finger ? ' on' : ''}` });
    el.append(
      h('div', { class: 'label', text: `用紙（${ed.cur + 1}ページ目）` }), paperRow,
      h('button', { class: 'item', text: 'すべてのページをこの用紙にする', onclick: () => { setPaper(cur.paper, true); close(); toast('すべてのページに適用しました'); } }),
      h('button', { class: 'item', text: 'このページの後にページを追加', onclick: () => { close(); addPage(); } }),
      h('button', { class: 'item danger', text: ed.pages.length > 1 ? 'このページを削除' : 'このページを消去', onclick: () => { close(); deletePage(); } }),
      h('button', {
        class: 'item', onclick: () => {
          settings.finger = !settings.finger; saveSettings();
          sw.classList.toggle('on', settings.finger);
          scroller.classList.toggle('finger', settings.finger);
          toast(settings.finger ? '指でも書けます（2本指でスクロール）' : 'ペンだけで書けます（指でスクロール）', 2500);
        },
      }, h('span', { text: '指で書く' }), sw),
      h('button', { class: 'item', text: 'ズームをリセット', onclick: () => { close(); ed.zoom = 1; layout(); reresolve(); } }),
      h('button', { class: 'item', text: 'PDFで書き出す', onclick: () => { close(); exportPdf(ed.nb); } }),
      h('button', { class: 'item', text: 'このページを画像で保存', onclick: () => { close(); exportPng(); } }),
    );
  });
}

// ---------------------------------------------------------------- 書き出し
async function exportPdf(nb) {
  toast('PDFを作成中…', 60000);
  try {
    if (ed.nb && ed.nb.id === nb.id) await flush();
    const pages = ed.nb && ed.nb.id === nb.id ? ed.pages : await db.pages(nb);
    const W = 1654, H = Math.round(W * PH / PW); // A4 200dpi
    const c = h('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const images = [];
    for (const page of pages) {
      renderPageTo(ctx, page, W / PW);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: W, h: H });
    }
    c.width = c.height = 0;
    $('#toast').hidden = true;
    offerFile(makePdf(images), `${safeName(nb.title)}.pdf`);
  } catch (err) {
    toast(`PDFを作れませんでした：${err.message}`, 4000);
  }
}
async function exportPng() {
  const page = ed.pages[ed.cur];
  const W = 2000, c = h('canvas');
  c.width = W; c.height = Math.round(W * PH / PW);
  renderPageTo(c.getContext('2d'), page, W / PW);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  c.width = c.height = 0;
  offerFile(blob, `${safeName(ed.nb.title)}-p${ed.cur + 1}.png`);
}

// ---------------------------------------------------------------- ボタン類
$('#back').onclick = showLibrary;
$('#edMenu').onclick = editorMenu;
$('#addPageFab').onclick = addPage;
$('#newNb').onclick = newNotebook;
$('#libMenu').onclick = libraryMenu;
$('#importFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
$('#nbTitle').onclick = () => {
  const nb = ed.nb;
  notebookForm({
    title: nb.title, cover: nb.cover, submit: '保存',
    onSubmit: async ({ title, cover }) => {
      Object.assign(nb, { title, cover });
      $('#nbTitle').textContent = title;
      await db.putNotebook(nb);
    },
  });
};

// ---------------------------------------------------------------- 起動
if ('standalone' in navigator && !navigator.standalone) $('#installTip').hidden = false;
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
renderShelf();

// テスト用
window.__tegaki = { ed, db, openNotebook, showLibrary, settings };
