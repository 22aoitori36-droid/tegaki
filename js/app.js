import { db } from './db.js';
import { makePdf } from './pdf.js';

// ページ座標系：幅 1000 × 高さ 1414（A4 比）。描画データはすべてこの単位で保存する
const PW = 1000, PH = 1414;
const TILE = 1024; // ページを分割して描くタイルの大きさ（実ピクセル）。見えている所だけ作る

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
  folder: 'all', // 一覧で選んでいるフォルダ（'all' | 'none' | フォルダID）
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
// すべてページ単位（1000×1414）の座標で描く。ctx には「s 倍＋平行移動」の変換をかけておく
function drawPaper(ctx, type, s, r) { // r = 描く範囲（ページ単位）
  ctx.fillStyle = '#fff';
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const step = 40, lw = Math.max(1, 1.1 * s) / s, pad = 3;
  const inY = (y) => y >= r.y0 - pad && y <= r.y1 + pad;
  const inX = (x) => x >= r.x0 - pad && x <= r.x1 + pad;
  ctx.lineWidth = lw;
  if (type === 'ruled') {
    ctx.strokeStyle = '#c6d4e8';
    ctx.beginPath();
    for (let y = 120; y < PH - 30; y += step) if (inY(y)) { ctx.moveTo(r.x0, y); ctx.lineTo(r.x1, y); }
    ctx.stroke();
    if (inX(90)) { ctx.strokeStyle = '#f2c4c4'; ctx.beginPath(); ctx.moveTo(90, r.y0); ctx.lineTo(90, r.y1); ctx.stroke(); }
  } else if (type === 'grid') {
    ctx.strokeStyle = '#dde5ef';
    ctx.beginPath();
    for (let y = step; y < PH; y += step) if (inY(y)) { ctx.moveTo(r.x0, y); ctx.lineTo(r.x1, y); }
    for (let x = step; x < PW; x += step) if (inX(x)) { ctx.moveTo(x, r.y0); ctx.lineTo(x, r.y1); }
    ctx.stroke();
  } else if (type === 'dots') {
    ctx.fillStyle = '#b9c3d0';
    const rad = Math.max(1, 1.7 * s) / s;
    ctx.beginPath();
    for (let y = step; y < PH; y += step) {
      if (!inY(y)) continue;
      for (let x = step; x < PW; x += step) if (inX(x)) { ctx.moveTo(x + rad, y); ctx.arc(x, y, rad, 0, Math.PI * 2); }
    }
    ctx.fill();
  }
}

const pf = (pr) => 0.35 + 1.0 * pr; // 筆圧 → 太さ倍率

// 入力点を「中点を結ぶ二次曲線」でなめらかにし、細かく刻んだ [x, y, 半径, ...] にする
function densePoints(st, step, minR) {
  const p = st.p, n = p.length / 3, out = [];
  const R = (pr) => Math.max(minR, (st.w * pf(pr)) / 2);
  const X = (k) => p[3 * k], Y = (k) => p[3 * k + 1], P = (k) => p[3 * k + 2];
  if (n === 1) return [X(0), Y(0), R(P(0))];
  const mx = (k) => (X(k - 1) + X(k)) / 2, my = (k) => (Y(k - 1) + Y(k)) / 2, mp = (k) => (P(k - 1) + P(k)) / 2;
  const line = (x0, y0, p0, x1, y1, p1, first) => {
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = first ? 0 : 1; j <= k; j++) { const t = j / k; out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, R(p0 + (p1 - p0) * t)); }
  };
  const quad = (x0, y0, cx, cy, x1, y1, p0, p1) => {
    const k = Math.max(1, Math.ceil((Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy)) / step));
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t;
      out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1, R(p0 + (p1 - p0) * t));
    }
  };
  line(X(0), Y(0), P(0), mx(1), my(1), mp(1), true);
  for (let i = 1; i <= n - 2; i++) quad(mx(i), my(i), X(i), Y(i), mx(i + 1), my(i + 1), mp(i), mp(i + 1));
  line(mx(n - 1), my(n - 1), mp(n - 1), X(n - 1), Y(n - 1), P(n - 1), false);
  return out;
}

// ペンの形：各点の円＋隣どうしの円をつなぐ台形を1つの図形として塗る。
// 区切りの継ぎ目が出ないので、筆圧で太さが変わってもなめらか
function penPath(st, step) {
  const d = densePoints(st, step, step * 0.15), path = new Path2D();
  for (let i = 0; i < d.length; i += 3) {
    const x = d[i], y = d[i + 1], r = d[i + 2];
    path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2);
    if (i === 0) continue;
    const x1 = d[i - 3], y1 = d[i - 2], r1 = d[i - 1];
    const dx = x - x1, dy = y - y1, dist = Math.hypot(dx, dy);
    if (dist <= Math.abs(r1 - r) + 1e-6) continue;
    const ux = dx / dist, uy = dy / dist, c = (r1 - r) / dist, sn = Math.sqrt(1 - c * c);
    const ax = ux * c - uy * sn, ay = uy * c + ux * sn; // 片側の接点方向
    const bx = ux * c + uy * sn, by = uy * c - ux * sn; // 反対側
    // 円（arc）と同じ回り方向にそろえる（nonzero で塗ると和集合になる）
    path.moveTo(x1 + r1 * ax, y1 + r1 * ay);
    path.lineTo(x1 + r1 * bx, y1 + r1 * by);
    path.lineTo(x + r * bx, y + r * by);
    path.lineTo(x + r * ax, y + r * ay);
    path.closePath();
  }
  return path;
}

function hlPath(st) {
  const p = st.p, n = p.length / 3, path = new Path2D();
  path.moveTo(p[0], p[1]);
  if (n === 1) path.lineTo(p[0] + 0.01, p[1]);
  for (let i = 1; i < n - 1; i++) path.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2);
  if (n > 1) path.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  return path;
}

// 刻み幅は画面上でおよそ 2px（拡大するほど細かく）。線ごとにキャッシュする
const stepFor = (s) => 2 ** Math.round(Math.log2(Math.max(0.2, 2 / s)));
const pathCache = new WeakMap();
function strokePath(st, s, live) {
  if (st.t === 'hl') return hlPath(st);
  const step = stepFor(s);
  if (live) return penPath(st, step);
  let c = pathCache.get(st);
  if (!c || c.step !== step) { c = { step, path: penPath(st, step) }; pathCache.set(st, c); }
  return c.path;
}

function drawStroke(ctx, st, s, live = false) {
  if (!st.p.length) return;
  const path = strokePath(st, s, live);
  ctx.save();
  if (st.t === 'hl') {
    if (!live) { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = st.w; ctx.strokeStyle = st.c;
    ctx.stroke(path);
  } else {
    ctx.fillStyle = st.c;
    ctx.fill(path);
  }
  ctx.restore();
}

const hits = (b, r) => !(b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1);

// ページの一部（ページ単位の矩形 r）を、r の左上が原点になるように s 倍で描く
function renderRegion(ctx, page, s, r) {
  ctx.setTransform(s, 0, 0, s, -r.x0 * s, -r.y0 * s);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawPaper(ctx, page.paper, s, r);
  for (const st of page.strokes) if (hits(bbox(st), r)) drawStroke(ctx, st, s);
}
function renderPageTo(ctx, page, s) { renderRegion(ctx, page, s, { x0: 0, y0: 0, x1: PW, y1: PH }); }

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
    pathCache.delete(st);
  }
}

// ================================================================ ノート一覧
async function showLibrary() {
  await closeEditor();
  $('#editor').hidden = true;
  $('#library').hidden = false;
  await renderShelf();
}

let folders = [];
const folderOf = (nb) => folders.find((f) => f.id === nb.folderId) || null;

async function renderShelf() {
  const [all, fl] = await Promise.all([db.notebooks(), db.folders()]);
  folders = fl.sort((a, b) => a.created - b.created);
  const unfiled = all.filter((nb) => !folderOf(nb));
  let cur = settings.folder;
  if ((cur !== 'all' && cur !== 'none' && !folders.some((f) => f.id === cur)) || (cur === 'none' && !unfiled.length)) {
    cur = settings.folder = 'all';
    saveSettings();
  }
  const curFolder = folders.find((f) => f.id === cur) || null;

  // フォルダのタブ。選択中のフォルダをもう一度押すとメニュー
  const bar = $('#folders');
  bar.innerHTML = '';
  const chip = (key, label, count, color) => {
    const on = key === cur;
    const folder = folders.find((f) => f.id === key);
    bar.append(h('button', {
      class: `chip${on ? ' on' : ''}`,
      onclick: () => {
        if (on && folder) { folderMenu(folder); return; }
        settings.folder = key; saveSettings(); renderShelf();
      },
    },
    color ? h('span', { class: 'dot', style: `background:${color}` }) : null,
    h('span', { text: label }),
    h('span', { class: 'n', text: String(count) }),
    on && folder ? h('span', { class: 'gear', text: '⋯' }) : null));
  };
  chip('all', 'すべて', all.length);
  for (const f of folders) chip(f.id, f.name, all.filter((nb) => nb.folderId === f.id).length, f.color);
  if (folders.length && unfiled.length) chip('none', '未分類', unfiled.length);
  bar.append(h('button', { class: 'chip add', text: '＋ フォルダ', onclick: newFolder }));

  const list = (cur === 'all' ? all : cur === 'none' ? unfiled : all.filter((nb) => nb.folderId === cur))
    .sort((a, b) => b.updated - a.updated);
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  if (curFolder) {
    shelf.append(h('div', { class: 'shelf-head' },
      h('span', { class: 'dot', style: `width:14px;height:14px;border-radius:50%;background:${curFolder.color}` }),
      h('h2', { text: curFolder.name }),
      list.length ? h('button', { class: 'btn', text: 'まとめてPDF', onclick: () => exportFolderPdf(curFolder) }) : null));
  }
  const msg = $('#emptyMsg');
  msg.hidden = list.length > 0;
  msg.textContent = all.length ? 'このフォルダにはまだノートがありません。「＋ 新しいノート」で作ると、このフォルダに入ります。'
    : 'まだノートがありません。「＋ 新しいノート」から作成できます。分野ごとに分けたいときは「＋ フォルダ」でフォルダを作れます。';
  for (const nb of list) {
    const d = new Date(nb.updated);
    const f = cur === 'all' ? folderOf(nb) : null;
    const card = h('div', { class: 'card' },
      h('button', {
        class: 'thumb', 'aria-label': nb.title,
        style: `--cover:${nb.cover};${nb.thumb ? `background-image:url(${nb.thumb})` : ''}`,
        onclick: () => openNotebook(nb.id),
      }),
      h('div', { class: 'name', text: nb.title }),
      h('div', { class: 'meta', text: `${f ? `${f.name}・` : ''}${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}・${nb.pageIds.length}ページ` }),
      h('button', { class: 'more', text: '…', 'aria-label': 'ノートのメニュー', onclick: () => notebookMenu(nb) }),
    );
    shelf.append(card);
  }
}

function notebookForm({ title, placeholder, cover, paper, folderId = null, submit, onSubmit }) {
  openSheet((el, close) => {
    let c = cover, pp = paper, fid = folderId;
    const folderRow = h('div', { class: 'row wrap' });
    const drawFolders = () => {
      folderRow.innerHTML = '';
      for (const f of [{ id: null, name: '未分類' }, ...folders]) {
        folderRow.append(h('button', { class: f.id === fid ? 'on' : '', text: f.name, onclick: () => { fid = f.id; drawFolders(); } }));
      }
    };
    drawFolders();
    const input = h('input', { type: 'text', value: title, placeholder: placeholder || 'ノートの名前', enterkeyhint: 'done', autocomplete: 'off' });
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
      folders.length ? h('div', { class: 'label', text: 'フォルダ（分野）' }) : null, folders.length ? folderRow : null,
      h('div', { class: 'actions' },
        h('button', { text: 'キャンセル', onclick: close }),
        h('button', { class: 'primary', text: submit, onclick: () => { close(); onSubmit({ title: input.value.trim() || placeholder || '無題のノート', cover: c, paper: pp, folderId: fid }); } })),
    );
    // 新規作成は空欄にカーソルを置いてすぐ書けるようにする（押した操作の中で focus するとキーボードが出る）
    if (!title) input.focus();
  });
}

function newNotebook() {
  const d = new Date();
  notebookForm({
    title: '',
    placeholder: `ノート ${d.getMonth() + 1}/${d.getDate()}`,
    cover: COVERS[Math.floor(Math.random() * 6)],
    paper: 'ruled',
    folderId: folders.some((f) => f.id === settings.folder) ? settings.folder : null,
    submit: '作成',
    onSubmit: async ({ title, cover, paper, folderId }) => {
      const now = Date.now();
      const page = { id: uid(), notebookId: null, paper, strokes: [] };
      const nb = { id: uid(), title, cover, paper, folderId, created: now, updated: now, pageIds: [page.id], thumb: null };
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
        class: 'item', text: folders.length ? '名前・表紙・フォルダを変更' : '名前と表紙を変更', onclick: () => {
          close();
          notebookForm({
            title: nb.title, cover: nb.cover, folderId: folderOf(nb) ? nb.folderId : null, submit: '保存',
            onSubmit: async ({ title, cover, folderId }) => { Object.assign(nb, { title, cover, folderId }); await db.putNotebook(nb); renderShelf(); },
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

// ---------------------------------------------------------------- フォルダ（分野）
function folderForm({ name, color, submit, onSubmit }) {
  openSheet((el, close) => {
    let c = color;
    const input = h('input', { type: 'text', value: name, placeholder: '例：数学、物理、英語' });
    const covers = h('div', { class: 'covers' });
    const drawCovers = () => {
      covers.innerHTML = '';
      for (const col of COVERS) covers.append(h('button', { class: col === c ? 'on' : '', style: `background:${col}`, 'aria-label': '色', onclick: () => { c = col; drawCovers(); } }));
    };
    drawCovers();
    el.append(
      h('h2', { text: submit === '作成' ? '新しいフォルダ' : 'フォルダの設定' }),
      input,
      h('div', { class: 'label', text: '色' }), covers,
      h('div', { class: 'actions' },
        h('button', { text: 'キャンセル', onclick: close }),
        h('button', { class: 'primary', text: submit, onclick: () => { const v = input.value.trim(); if (!v) { input.focus(); return; } close(); onSubmit({ name: v, color: c }); } })),
    );
  });
}

function newFolder() {
  folderForm({
    name: '', color: COVERS[folders.length % COVERS.length], submit: '作成',
    onSubmit: async ({ name, color }) => {
      const f = { id: uid(), name, color, created: Date.now() };
      await db.putFolder(f);
      settings.folder = f.id; saveSettings();
      renderShelf();
      toast(`フォルダ「${name}」を作りました`);
    },
  });
}

function folderMenu(f) {
  openSheet((el, close) => {
    el.append(
      h('h2', { text: f.name }),
      h('button', {
        class: 'item', text: '名前と色を変更', onclick: () => {
          close();
          folderForm({ name: f.name, color: f.color, submit: '保存', onSubmit: async ({ name, color }) => { Object.assign(f, { name, color }); await db.putFolder(f); renderShelf(); } });
        },
      }),
      h('button', { class: 'item', text: 'このフォルダのノートをまとめてPDFにする', onclick: () => { close(); exportFolderPdf(f); } }),
      h('button', {
        class: 'item danger', text: 'フォルダを削除', onclick: async () => {
          close();
          if (!(await confirmDialog(`フォルダ「${f.name}」を削除しますか？\n中のノートは消えずに「未分類」へ移ります。`, '削除', true))) return;
          const inside = (await db.notebooks()).filter((nb) => nb.folderId === f.id);
          await db.deleteFolder(f, inside);
          settings.folder = 'all'; saveSettings();
          renderShelf();
          toast('フォルダを削除しました');
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
  nb: null, pages: [], map: new Map(), // pageId → { page, div, tiles: Map, wd, hd }
  zoom: 1, baseW: 800, pageW: 800, wd: 800, hd: 1131, cur: 0,
  undo: [], redo: [], dirty: new Set(), saveT: 0,
  renderQ: new Map(),
};
let act = null;   // 描画中の操作
let sel = null;   // なげなわ選択 { entry, strokes, box, div }
let pinch = null; // 2本指ジェスチャ
let fingers = 0;  // 画面に触れている指の数（ペンを除く）
let lastPen = 0;  // 最後にペンが動いた時刻（手のひら対策）
let unlockT = 0;

const scroller = $('#scroller');
const pagesEl = $('#pages');
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
const penRecent = (ms = 600) => Date.now() - lastPen < ms;

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
  scroller.scrollTop = 0; scroller.scrollLeft = 0;
  rebuildPages();
  updateUndoButtons();
}

async function closeEditor() {
  if (!ed.nb) return;
  cancelAct();
  clearSel();
  await flush();
  for (const e of ed.map.values()) freeTiles(e.tiles);
  ed.map.clear();
  pagesEl.innerHTML = '';
  ed.nb = null; ed.pages = [];
}

function rebuildPages() {
  clearSel();
  for (const e of ed.map.values()) freeTiles(e.tiles);
  ed.map.clear();
  pagesEl.innerHTML = '';
  ed.pages.forEach((page, i) => {
    const div = h('div', { class: 'page', 'data-id': page.id }, h('span', { class: 'pno', text: `${i + 1}` }));
    pagesEl.append(div);
    ed.map.set(page.id, { page, div, tiles: new Map(), wd: 0, hd: 0 });
  });
  layout();
  updateTiles();
  updatePageNo();
}

// ページの大きさは「実ピクセルで整数」になるように決める（タイルの継ぎ目を出さないため）
function layout() {
  const avail = Math.max(200, scroller.clientWidth - 32);
  const k = dpr();
  ed.baseW = Math.min(avail, 1100);
  ed.wd = Math.round(ed.baseW * ed.zoom * k);
  ed.hd = Math.round(ed.wd * PH / PW);
  ed.pageW = ed.wd / k;
  for (const e of ed.map.values()) { e.div.style.width = `${ed.wd / k}px`; e.div.style.height = `${ed.hd / k}px`; }
  if (sel) placeSelMenu();
}

// ---------------------------------------------------------------- タイル（見えている所だけ実解像度で描く）
function freeTiles(tiles) {
  for (const t of tiles.values()) { t.c.width = t.c.height = 0; t.c.remove(); } // iOS ではこれでメモリが解放される
  tiles.clear();
}
const tileRect = (e, t) => { const s = e.wd / PW; return { x0: t.x0 / s, y0: t.y0 / s, x1: (t.x0 + t.w) / s, y1: (t.y0 + t.h) / s }; };
function renderTile(e, t) { renderRegion(t.ctx, e.page, e.wd / PW, tileRect(e, t)); }
function makeTile(e, i, j) {
  const x0 = i * TILE, y0 = j * TILE, w = Math.min(TILE, e.wd - x0), hh = Math.min(TILE, e.hd - y0);
  const c = h('canvas', { class: 'tile' });
  c.width = w; c.height = hh;
  // % 指定なので、ピンチ中はそのまま伸び縮みする
  c.style.cssText = `left:${(x0 / e.wd) * 100}%;top:${(y0 / e.hd) * 100}%;width:${(w / e.wd) * 100}%;height:${(hh / e.hd) * 100}%`;
  const t = { c, ctx: c.getContext('2d'), x0, y0, w, h: hh };
  renderTile(e, t);
  e.div.prepend(c);
  return t;
}
function updateTiles() {
  if (!ed.nb || pinch) return;
  const sr = scroller.getBoundingClientRect();
  const mx = sr.width * 0.25, my = sr.height * 0.6;
  for (const e of ed.map.values()) {
    let old = null;
    if (e.wd !== ed.wd || e.hd !== ed.hd) { old = e.tiles; e.tiles = new Map(); e.wd = ed.wd; e.hd = ed.hd; }
    const dr = e.div.getBoundingClientRect();
    const vx0 = Math.max(sr.left - mx, dr.left), vx1 = Math.min(sr.right + mx, dr.right);
    const vy0 = Math.max(sr.top - my, dr.top), vy1 = Math.min(sr.bottom + my, dr.bottom);
    const need = new Set();
    if (vx1 > vx0 && vy1 > vy0 && dr.width > 0) {
      const k = e.wd / dr.width;
      const ni = Math.ceil(e.wd / TILE), nj = Math.ceil(e.hd / TILE);
      const i0 = Math.max(0, Math.floor(((vx0 - dr.left) * k) / TILE)), i1 = Math.min(ni - 1, Math.floor(((vx1 - dr.left) * k) / TILE));
      const j0 = Math.max(0, Math.floor(((vy0 - dr.top) * k) / TILE)), j1 = Math.min(nj - 1, Math.floor(((vy1 - dr.top) * k) / TILE));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = `${i},${j}`;
          need.add(key);
          if (!e.tiles.has(key)) e.tiles.set(key, makeTile(e, i, j));
        }
      }
    }
    for (const [key, t] of e.tiles) if (!need.has(key)) { t.c.width = t.c.height = 0; t.c.remove(); e.tiles.delete(key); }
    if (old) freeTiles(old); // 新しい解像度を描き終えてから古いタイルを外す（ちらつき防止）
  }
}
// 変更のあった範囲（ページ単位。null なら全体）のタイルを次のフレームで描き直す
function scheduleRender(e, box = null) {
  if (!ed.renderQ.size) {
    requestAnimationFrame(() => {
      for (const [x, b] of ed.renderQ) for (const t of x.tiles.values()) if (!b || hits(b, tileRect(x, t))) renderTile(x, t);
      ed.renderQ.clear();
    });
  }
  if (ed.renderQ.has(e)) {
    const b = ed.renderQ.get(e);
    ed.renderQ.set(e, b && box ? { x0: Math.min(b.x0, box.x0), y0: Math.min(b.y0, box.y0), x1: Math.max(b.x1, box.x1), y1: Math.max(b.y1, box.y1) } : null);
  } else ed.renderQ.set(e, box);
}
// 書き終えた線を、重なるタイルにだけ上描きする
function drawOnTiles(e, st) {
  const b = bbox(st), s = e.wd / PW;
  for (const t of e.tiles.values()) {
    if (!hits(b, tileRect(e, t))) continue;
    t.ctx.setTransform(s, 0, 0, s, -t.x0, -t.y0);
    drawStroke(t.ctx, st, s);
  }
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
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePageNo(); updateTiles(); if (sel) placeSelMenu(); });
});
window.addEventListener('resize', () => { if (ed.nb) { layout(); updateTiles(); } });

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

// ---------------------------------------------------------------- 書いている途中の線（画面全体の実解像度レイヤー）
const live = { c: h('canvas', { id: 'live', hidden: '' }), ox: 0, oy: 0, raf: 0 };
live.ctx = live.c.getContext('2d');
document.body.append(live.c);
function liveStart(cls) {
  const sr = scroller.getBoundingClientRect(), k = dpr();
  const w = Math.round(sr.width * k), hh = Math.round(sr.height * k);
  if (live.c.width !== w || live.c.height !== hh) { live.c.width = w; live.c.height = hh; }
  live.c.style.cssText = `left:${sr.left}px;top:${sr.top}px;width:${sr.width}px;height:${sr.height}px`;
  live.c.className = cls;
  live.ox = sr.left; live.oy = sr.top;
  live.c.hidden = false;
}
function liveClear() {
  cancelAnimationFrame(live.raf); live.raf = 0;
  live.ctx.setTransform(1, 0, 0, 1, 0, 0);
  live.ctx.clearRect(0, 0, live.c.width, live.c.height);
  live.c.hidden = true;
}
function requestLive() {
  if (!live.raf) live.raf = requestAnimationFrame(() => { live.raf = 0; if (act) drawLive(); });
}
// いまのページ位置（act.rect）から毎回変換を作り直すので、途中でページが動いてもずれない
function drawLive() {
  const ctx = live.ctx, k = dpr(), r = act.rect, s = (r.width * k) / PW;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, live.c.width, live.c.height);
  ctx.setTransform(s, 0, 0, s, (r.left - live.ox) * k, (r.top - live.oy) * k);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip();
  if (act.stroke) {
    drawStroke(ctx, act.stroke, s, true);
  } else if (act.tool === 'eraser' && act.last) {
    ctx.beginPath(); ctx.arc(act.last.x, act.last.y, act.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fill();
    ctx.lineWidth = (1.5 * k) / s; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
  } else if (act.mode === 'lasso') {
    ctx.beginPath();
    act.poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,122,255,.06)'; ctx.fill();
    ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a7aff'; ctx.stroke();
  }
  ctx.restore();
}

// ペンで書いている間とその直後は、手のひらでスクロール・ズームしないように固定する
function lockScroll() { clearTimeout(unlockT); scroller.classList.add('lock'); }
function unlockSoon() { clearTimeout(unlockT); unlockT = setTimeout(() => scroller.classList.remove('lock'), 500); }

// ---------------------------------------------------------------- 入力（ペン・指）
function point(e) {
  const r = act.rect;
  let pr = 0.5;
  if (e.pointerType === 'pen') pr = Math.max(0.05, Math.min(1, e.pressure || 0.05));
  return { x: ((e.clientX - r.left) / r.width) * PW, y: ((e.clientY - r.top) / r.height) * PH, p: pr };
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (!ed.nb || pinch) return;
  if (e.pointerType === 'pen') lastPen = Date.now();
  // 指は「指で書く」がオンのときだけ。ペンを使った直後の指（手のひら）は無視
  if (e.pointerType === 'touch' && (!settings.finger || fingers > 1 || penRecent(1500))) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (act) {
    if (e.pointerType === 'pen' && act.ptype === 'touch') cancelAct(); // ペンが来たら手のひらの線は捨てる
    else return;
  }
  const div = e.target.closest('.page');
  if (!div) { clearSel(); return; }
  const entry = ed.map.get(div.dataset.id);
  e.preventDefault();
  act = { id: e.pointerId, ptype: e.pointerType, entry, rect: div.getBoundingClientRect(), tool: settings.tool };
  if (e.pointerType === 'pen' || e.pointerType === 'touch') lockScroll();
  const pt = point(e);
  const t = act.tool;
  if (t === 'pen' || t === 'hl') {
    if (sel) clearSel();
    act.stroke = { t, c: settings[t].color, w: SIZES[t][settings[t].size], p: [] };
    liveStart(t === 'hl' ? 'hl' : '');
    addPoint(pt);
  } else if (t === 'eraser') {
    if (sel) clearSel();
    act.r = SIZES.eraser[settings.eraser.size];
    act.removed = [];
    act.last = pt;
    liveStart('');
    eraseAt(pt);
  } else if (t === 'lasso') {
    if (sel && sel.entry === entry && pt.x >= sel.box.x0 && pt.x <= sel.box.x1 && pt.y >= sel.box.y0 && pt.y <= sel.box.y1) {
      act.mode = 'move'; act.last = pt; act.dx = 0; act.dy = 0;
      $('#selMenu').hidden = true;
    } else {
      clearSel();
      act.mode = 'lasso'; act.poly = [pt];
      liveStart('');
    }
  }
  requestLive();
});

window.addEventListener('pointermove', (e) => {
  if (!act || e.pointerId !== act.id) return;
  if (e.pointerType === 'pen') lastPen = Date.now();
  act.rect = act.entry.div.getBoundingClientRect(); // ページが動いていても正しい位置に書く
  const list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const ev of list.length ? list : [e]) moveAct(point(ev));
  requestLive();
});
window.addEventListener('pointerup', (e) => { if (act && e.pointerId === act.id) endAct(); });
window.addEventListener('pointercancel', (e) => {
  if (!act || e.pointerId !== act.id) return;
  if (act.ptype === 'touch') cancelAct(); else endAct();
});

function addPoint(pt) {
  const p = act.stroke.p;
  let pr = pt.p;
  if (p.length) {
    const dx = pt.x - p[p.length - 3], dy = pt.y - p[p.length - 2];
    const min = 0.8 / ((act.rect.width * dpr()) / PW); // 画面上で約 0.8px 未満の動きは間引く
    if (dx * dx + dy * dy < min * min) return;
    pr = p[p.length - 1] * 0.5 + pr * 0.5; // 筆圧のゆらぎをならす
  }
  p.push(r1(pt.x), r1(pt.y), r2(pr));
}

function eraseAt(pt) {
  const page = act.entry.page, r = act.r;
  const from = act.last;
  const dist = Math.hypot(pt.x - from.x, pt.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (r / 2)));
  let box = null;
  for (let k = 1; k <= steps; k++) {
    const x = from.x + ((pt.x - from.x) * k) / steps, y = from.y + ((pt.y - from.y) * k) / steps;
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const st = page.strokes[i];
      if (hitStroke(st, x, y, r)) {
        act.removed.push({ stroke: st, index: i });
        page.strokes.splice(i, 1);
        const b = bbox(st);
        box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : { ...b };
      }
    }
  }
  act.last = pt;
  if (box) scheduleRender(act.entry, box);
}

function moveAct(pt) {
  const t = act.tool;
  if (t === 'pen' || t === 'hl') addPoint(pt);
  else if (t === 'eraser') eraseAt(pt);
  else if (act.mode === 'lasso') {
    const last = act.poly[act.poly.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 2) act.poly.push(pt);
  } else if (act.mode === 'move') {
    const dx = pt.x - act.last.x, dy = pt.y - act.last.y;
    const b0 = { ...sel.box };
    act.last = pt;
    act.dx += dx; act.dy += dy;
    translate(sel.strokes, dx, dy);
    sel.box.x0 += dx; sel.box.x1 += dx; sel.box.y0 += dy; sel.box.y1 += dy;
    placeSelBox();
    scheduleRender(act.entry, { x0: Math.min(b0.x0, sel.box.x0), y0: Math.min(b0.y0, sel.box.y0), x1: Math.max(b0.x1, sel.box.x1), y1: Math.max(b0.y1, sel.box.y1) });
  }
}

function endAct() {
  const a = act;
  act = null;
  if (a.ptype === 'pen' || a.ptype === 'touch') unlockSoon();
  const e = a.entry;
  if (a.tool === 'pen' || a.tool === 'hl') {
    if (a.stroke.p.length) {
      e.page.strokes.push(a.stroke);
      drawOnTiles(e, a.stroke);
      pushUndo({ type: 'add', pageId: e.page.id, strokes: [a.stroke] });
      markDirty(e);
    }
    liveClear();
  } else if (a.tool === 'eraser') {
    liveClear();
    if (a.removed.length) { pushUndo({ type: 'erase', pageId: e.page.id, items: a.removed }); markDirty(e); }
  } else if (a.mode === 'lasso') {
    liveClear();
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
  unlockSoon();
  liveClear();
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
  // ペンで書いている最中・直後に触れた指は手のひらとみなし、スクロールもズームもさせない
  if (f.length && ((act && act.ptype === 'pen') || penRecent())) { e.preventDefault(); return; }
  if (f.length >= 2) {
    e.preventDefault();
    if (act && act.ptype === 'touch') cancelAct();
    startPinch(f);
  }
}, { passive: false });
scroller.addEventListener('touchmove', (e) => {
  const f = fingerList(e.touches);
  if (act || (!pinch && penRecent())) { e.preventDefault(); return; } // 書いている間は手のひらでスクロールしない
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
  updateTiles(); // 新しい倍率の解像度で描き直す
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
      h('button', { class: 'item', text: 'ズームをリセット', onclick: () => { close(); ed.zoom = 1; layout(); updateTiles(); } }),
      h('button', { class: 'item', text: 'PDFで書き出す', onclick: () => { close(); exportPdf(ed.nb); } }),
      h('button', { class: 'item', text: 'このページを画像で保存', onclick: () => { close(); exportPng(); } }),
    );
  });
}

// ---------------------------------------------------------------- 書き出し
async function notebookPages(nb) {
  if (ed.nb && ed.nb.id === nb.id) { await flush(); return ed.pages; }
  return db.pages(nb);
}
async function writePdf(pages, name) {
  const W = 1654, H = Math.round(W * PH / PW); // A4 200dpi
  const c = h('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const images = [];
  for (const [i, page] of pages.entries()) {
    if (pages.length > 3) toast(`PDFを作成中… ${i + 1} / ${pages.length}`, 60000);
    renderPageTo(ctx, page, W / PW);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
    images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: W, h: H });
  }
  c.width = c.height = 0;
  $('#toast').hidden = true;
  offerFile(makePdf(images), name);
}
async function exportPdf(nb) {
  toast('PDFを作成中…', 60000);
  try {
    await writePdf(await notebookPages(nb), `${safeName(nb.title)}.pdf`);
  } catch (err) {
    toast(`PDFを作れませんでした：${err.message}`, 4000);
  }
}
// フォルダ内のノートを名前順に1つのPDFへまとめる
async function exportFolderPdf(f) {
  const nbs = (await db.notebooks()).filter((nb) => nb.folderId === f.id)
    .sort((a, b) => a.title.localeCompare(b.title, 'ja', { numeric: true }));
  if (!nbs.length) { toast('このフォルダにはノートがありません'); return; }
  toast('PDFを作成中…', 60000);
  try {
    const pages = [];
    for (const nb of nbs) pages.push(...(await notebookPages(nb)));
    await writePdf(pages, `${safeName(f.name)}.pdf`);
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
$('#edExport').onclick = () => openSheet((el, close) => {
  el.append(
    h('h2', { text: '書き出し' }),
    h('button', { class: 'item', text: 'ノート全体をPDFで書き出す', onclick: () => { close(); exportPdf(ed.nb); } }),
    h('button', { class: 'item', text: `このページ（${ed.cur + 1}ページ目）を画像で保存`, onclick: () => { close(); exportPng(); } }),
  );
});
$('#addPageFab').onclick = addPage;
$('#newNb').onclick = newNotebook;
$('#libMenu').onclick = libraryMenu;
$('#importFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
$('#nbTitle').onclick = () => {
  const nb = ed.nb;
  notebookForm({
    title: nb.title, cover: nb.cover, folderId: folderOf(nb) ? nb.folderId : null, submit: '保存',
    onSubmit: async ({ title, cover, folderId }) => {
      Object.assign(nb, { title, cover, folderId });
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
window.__tegaki = {
  ed, db, openNotebook, showLibrary, settings, layout, updateTiles,
  // 指定したページ座標の画素（タイルから読む）
  pixel(pageIndex, x, y) {
    const e = ed.map.get(ed.pages[pageIndex].id), s = e.wd / PW;
    const px = Math.floor(x * s), py = Math.floor(y * s);
    for (const t of e.tiles.values()) {
      if (px >= t.x0 && px < t.x0 + t.w && py >= t.y0 && py < t.y0 + t.h) return [...t.ctx.getImageData(px - t.x0, py - t.y0, 1, 1).data];
    }
    return null;
  },
};
