import * as pdfjsLib from './lib/pdf.min.js';
import { makeEngine, mul, apply } from './engine.js';
import { initPageTools } from './pagetools.js';

const L = window.PDFLib;
const { PDFDocument, rgb, degrees } = L;
const fontkit = window.fontkit;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.js', import.meta.url).href;
const E = makeEngine(L);
const BASE = new URL('./', import.meta.url).href;
const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
let cmapData = null, stdFontData = null;
class CMapFactory {
  constructor() {}
  async fetch({ name }) {
    if (!cmapData) cmapData = (await import('./lib/cmapdata.js')).default;
    if (!cmapData[name]) throw new Error('Unknown CMap ' + name);
    return { cMapData: b64(cmapData[name]), isCompressed: true };
  }
}
class StdFontFactory {
  constructor() {}
  async fetch({ filename }) {
    if (!stdFontData) stdFontData = (await import('./lib/stdfontdata.js')).default;
    if (!stdFontData[filename]) throw new Error('Unknown font ' + filename);
    return b64(stdFontData[filename]);
  }
}

// ---------- state ----------
let bytes = null;          // current PDF bytes
let fileName = 'document.pdf';
let libDoc = null;         // pdf-lib document of current bytes (analysis + editing)
let pjDoc = null;          // pdf.js document of current bytes
let version = 0;
let undoStack = [], redoStack = [];
let views = [];
let scale = 1;
let tool = 'select';
let busy = false;
let selection = null;      // {v, img, el}
let editor = null;         // {v, block, els}
let pendingImage = null;   // {bytes, type, w, h}
let downloads = null;

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages'), viewer = $('viewer');

try {
  if (window.claude && window.claude.use) window.claude.use('downloads').then((d) => { downloads = d; }).catch(() => {});
} catch (e) { /* standalone */ }

// ---------- helpers ----------
function toast(msg, err = false, ms = 2800) {
  const t = $('toast');
  t.textContent = msg; t.className = 'on' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = err ? 'err' : ''), ms);
}
function setBusy(on) { busy = on; $('busy').classList.toggle('on', on); }
const HINTS = {
  select: 'Клик по строке текста — изменить или удалить. Клик по картинке — переместить, изменить размер (за углы, Shift — без сохранения пропорций), заменить или удалить (Delete).',
  addText: 'Кликните на странице там, где должен начинаться новый текст.',
  addImage: 'Кликните на странице — изображение будет вставлено в эту точку. Потом его можно двигать и масштабировать в режиме «Править».',
  erase: 'Обведите область мышью — весь текст и изображения внутри будут удалены из файла.',
  whiteout: 'Обведите область — она будет закрашена выбранным цветом (удобно для сканов).',
};
function updateHint() { $('hint').textContent = bytes ? HINTS[tool] : 'Откройте PDF-файл, чтобы начать.'; }
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function rgb2hex(c) { return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join(''); }

// ---------- fonts ----------
const FONT_FILES = {
  sans: ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSans-BoldItalic'],
  serif: ['NotoSerif-Regular', 'NotoSerif-Bold', 'NotoSerif-Italic', 'NotoSerif-BoldItalic'],
};
const fontBytesCache = new Map();
const embeddedFonts = new WeakMap();
async function getFont(doc, family, bold, italic) {
  const file = FONT_FILES[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
  let m = embeddedFonts.get(doc); if (!m) { m = new Map(); embeddedFonts.set(doc, m); }
  if (m.has(file)) return m.get(file);
  if (!fontBytesCache.has(file)) {
    const r = await fetch(BASE + 'fonts/' + file + '.ttf');
    if (!r.ok) throw new Error('Не удалось загрузить шрифт ' + file);
    fontBytesCache.set(file, new Uint8Array(await r.arrayBuffer()));
  }
  const f = await doc.embedFont(fontBytesCache.get(file), { subset: true });
  m.set(file, f);
  return f;
}
function guessStyle(base) {
  const b = (base || '').replace(/^[A-Z]{6}\+/, '');
  const low = b.toLowerCase();
  return {
    family: /times|serif|georgia|garamond|cambria|book|roman|minion|palatino|baskerville/.test(low) && !/sans/.test(low) ? 'serif' : 'sans',
    bold: /bold|black|heavy|semibold|demi|,b\b/.test(low),
    italic: /italic|oblique|,i\b/.test(low),
  };
}

// ---------- loading ----------
async function openFile(file) {
  if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...buf.subarray(0, 1024)).indexOf('%PDF') < 0) { toast('Это не PDF-файл', true); return; }
  await openBytes(buf, file.name || 'document.pdf');
}

async function openBytes(buf, name) {
  const prevName = fileName;
  fileName = name;
  setBusy(true);
  try {
    await loadBytes(buf, true);
    undoStack = []; redoStack = [];
    $('bUndo').disabled = true; $('bRedo').disabled = true;
    $('empty').style.display = 'none';
    $('fname').textContent = fileName;
    $('bSave').disabled = false;
    $('bPrint').disabled = false;
    $('bSplit').disabled = false;
    updateHint();
  } catch (e) {
    console.error(e);
    fileName = prevName;
    toast(e && e.message && /encrypt/i.test(e.message) ? 'PDF защищён (зашифрован). Снимите защиту и откройте снова.' : 'Не удалось открыть PDF: ' + (e.message || e), true, 5000);
  } finally { setBusy(false); }
}

async function loadBytes(newBytes, fresh = false) {
  const doc = await PDFDocument.load(newBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const pj = await pdfjsLib.getDocument({
    data: newBytes.slice(),
    cMapUrl: BASE, cMapPacked: true, standardFontDataUrl: BASE,
    CMapReaderFactory: CMapFactory, StandardFontDataFactory: StdFontFactory, useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const old = pjDoc;
  bytes = newBytes; libDoc = doc; pjDoc = pj; version++;
  closeEditor(); clearSelection();
  if (old) old.destroy();
  if (fresh || views.length !== pj.numPages) await buildViews(fresh);
  else { for (const v of views) { v.model = undefined; v.blocks = null; } refreshVisible(); }
  $('bUndo').disabled = !undoStack.length;
  $('bRedo').disabled = !redoStack.length;
}

async function buildViews(fitWidth) {
  pagesEl.innerHTML = '';
  views = [];
  const sizes = [];
  for (let i = 1; i <= pjDoc.numPages; i++) {
    const p = await pjDoc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push([vp.width, vp.height]);
  }
  if (fitWidth) {
    const maxW = Math.max(...sizes.map((s) => s[0]));
    const avail = viewer.clientWidth - 110;
    scale = Math.max(0.4, Math.min(1.5, avail / maxW));
    scale = Math.round(scale * 20) / 20;
  }
  sizes.forEach(([w, h], i) => {
    const wrap = document.createElement('div');
    wrap.className = 'pg';
    const num = document.createElement('div'); num.className = 'num'; num.textContent = i + 1;
    const ov = document.createElement('div'); ov.className = 'ov';
    wrap.append(num, ov);
    pagesEl.append(wrap);
    const v = { i, wrap, ov, w1: w, h1: h, canvas: null, renderedKey: '', vp: null, model: undefined, blocks: null, visible: false };
    wrap._v = v;
    views.push(v);
    attachOverlayEvents(v);
  });
  layout();
  observe();
  $('pageInfo').textContent = '1 / ' + views.length;
}

function layout() {
  for (const v of views) {
    v.wrap.style.width = Math.floor(v.w1 * scale) + 'px';
    v.wrap.style.height = Math.floor(v.h1 * scale) + 'px';
  }
  $('zoomInfo').textContent = Math.round(scale * 100) + '%';
}

let io = null;
function observe() {
  if (io) io.disconnect();
  io = new IntersectionObserver((ents) => {
    for (const e of ents) e.target._v.visible = e.isIntersecting;
    refreshVisible();
  }, { root: viewer, rootMargin: '400px 0px' });
  for (const v of views) io.observe(v.wrap);
}

function refreshVisible() {
  for (const v of views) if (v.visible) renderView(v);
}

async function renderView(v) {
  const key = version + '@' + scale;
  if (v.renderedKey === key || v.rendering === key) return;
  v.rendering = key;
  try {
    const page = await pjDoc.getPage(v.i + 1);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
    const ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (v.rendering !== key) return;
    if (v.canvas) v.canvas.remove();
    v.wrap.insertBefore(c, v.ov);
    v.canvas = c; v.dpr = dpr; v.vp = vp;
    v.renderedKey = key;
    await buildOverlay(v, page);
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.error(e);
  } finally {
    if (v.rendering === key) v.rendering = null;
  }
}

// ---------- page analysis ----------
function getModel(v) {
  if (v.model !== undefined) return v.model;
  try { v.model = E.analyzePage(libDoc, v.i); }
  catch (e) { console.warn('analyze failed', e); v.model = null; }
  return v.model;
}

function buildBlocks(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!it.str) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
    if (!size) continue;
    const ang = Math.atan2(t[1], t[0]);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const ox = t[4], oy = t[5];
    const blank = !it.str.trim();
    // whitespace items may carry a bogus width (gap to the next cell) – never let them stretch a line;
    // also cap glyph runs to a sane width per character
    const w = blank ? 0 : Math.min(it.width || 0, it.str.length * size * 1.25);
    if (cur && Math.abs(ang - cur.ang) < 0.02 && Math.abs(size / cur.size - 1) < 0.4) {
      const dx = ox - cur.ox, dy = oy - cur.oy;
      const along = dx * ux + dy * uy, perp = -dx * uy + dy * ux;
      if (Math.abs(perp) < 0.3 * cur.size && along >= cur.len - 0.8 * cur.size && along <= cur.len + 1.3 * cur.size) {
        const gap = along - cur.len;
        if (!blank) {
          if (gap > 0.18 * cur.size && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
          cur.text += it.str;
        } else if (!cur.text.endsWith(' ')) cur.text += ' ';
        cur.len = Math.max(cur.len, along + w);
        continue;
      }
    }
    if (blank) { cur = null; continue; }
    cur = { text: it.str, ox, oy, ang, ux, uy, size, len: w, pieces: [] };
    lines.push(cur);
  }
  for (const b of lines) {
    b.text = b.text.replace(/\s+$/, '');
    const n = [-b.uy, b.ux];
    const pts = [[0, -0.25], [b.len, -0.25], [b.len, 0.9], [0, 0.9]].map(([a, p]) => [b.ox + b.ux * a + n[0] * p * b.size, b.oy + b.uy * a + n[1] * p * b.size]);
    b.bbox = { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
  }
  return lines.filter((b) => b.text.trim());
}

function assignPieces(blocks, pieces) {
  for (const p of pieces) {
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    let best = null, bestD = Infinity;
    for (const b of blocks) {
      const dx = cx - b.ox, dy = cy - b.oy;
      const along = dx * b.ux + dy * b.uy, perp = -dx * b.uy + dy * b.ux;
      if (along < -0.4 * b.size || along > b.len + 0.4 * b.size) continue;
      if (perp < -0.4 * b.size || perp > 0.6 * b.size) continue;
      const d = Math.abs(perp);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) best.pieces.push(p);
  }
  for (const b of blocks) {
    const vis = b.pieces.filter((p) => !p.invisible);
    b.scan = b.pieces.length > 0 && vis.length === 0;
    const ref = vis[0] || b.pieces[0];
    b.color = ref ? ref.color : [0, 0, 0];
    b.fontBase = ref ? ref.fontBase : '';
  }
}

function pdfRectToView(v, bb) {
  const a = v.vp.convertToViewportPoint(bb.x0, bb.y0), b = v.vp.convertToViewportPoint(bb.x1, bb.y1);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}
function viewRectToPdf(v, r) {
  const a = v.vp.convertToPdfPoint(r.x, r.y), b = v.vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}
function place(el, r) { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = Math.max(r.w, 2) + 'px'; el.style.height = Math.max(r.h, 2) + 'px'; }

async function buildOverlay(v, page) {
  const tc = await page.getTextContent();
  const model = getModel(v);
  const blocks = buildBlocks(tc.items);
  if (model) assignPieces(blocks, model.pieces);
  v.blocks = blocks;
  v.ov.innerHTML = '';
  if (model) {
    // images (largest first so small ones sit on top)
    const imgs = model.images.slice().sort((a, b) => (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0) - (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0));
    for (const im of imgs) {
      const r = pdfRectToView(v, im.bbox);
      if (r.w < 3 || r.h < 3) continue;
      const el = document.createElement('div'); el.className = 'ibox'; place(el, r);
      el.title = 'Изображение';
      el.addEventListener('pointerdown', (e) => { if (tool !== 'select' || busy) return; e.stopPropagation(); e.preventDefault(); selectImage(v, im); });
      v.ov.append(el);
    }
  }
  // smaller boxes on top, so a narrow cell is never hidden under a wider neighbour
  const area = (b) => (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0);
  for (const b of blocks.slice().sort((p, q) => area(q) - area(p))) {
    const r = pdfRectToView(v, b.bbox);
    const el = document.createElement('div'); el.className = 'tbox'; place(el, r);
    el.addEventListener('pointerdown', (e) => { if (tool !== 'select' || busy) return; e.stopPropagation(); e.preventDefault(); openTextEditor(v, b); });
    v.ov.append(el);
  }
}

// ---------- committing edits ----------
async function commit(fn, okMsg) {
  if (busy) return false;
  setBusy(true);
  const prev = bytes;
  try {
    await fn(libDoc);
    const out = await libDoc.save({ updateFieldAppearances: false });
    undoStack.push(prev); if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
    await loadBytes(out);
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    console.error(e);
    toast('Ошибка: ' + (e.message || e), true, 5000);
    try { await loadBytes(prev); } catch (_) { /* ignore */ }
    return false;
  } finally { setBusy(false); }
}
// make page content safe for appending new drawing
function prepPage(doc, v) {
  const m = getModel(v);
  if (m) E.rewrite(doc, v.i, m, {});
  return m;
}
async function undo() {
  if (busy || !undoStack.length) return;
  setBusy(true);
  try { redoStack.push(bytes); await loadBytes(undoStack.pop()); } finally { setBusy(false); }
}
async function redo() {
  if (busy || !redoStack.length) return;
  setBusy(true);
  try { undoStack.push(bytes); await loadBytes(redoStack.pop()); } finally { setBusy(false); }
}

// direction helpers for upright placement relative to the screen
function screenAngle(v) {
  const a = v.vp.convertToPdfPoint(0, 0), b = v.vp.convertToPdfPoint(100, 0);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}


// place a floating panel above (or below) the target rect, never covering it
function placePanel(v, panel, r) {
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const W = v.wrap.clientWidth;
  // keep it on the page horizontally; if wider than the page, centre it
  let left = pw <= W ? Math.min(Math.max(0, r.x - 3), W - pw) : (W - pw) / 2;
  // stay within the visible part of the viewer horizontally too
  const vr = viewer.getBoundingClientRect(), wr = v.wrap.getBoundingClientRect();
  const minL = vr.left - wr.left + 4, maxL = vr.right - wr.left - pw - 4;
  if (maxL >= minL) left = Math.min(Math.max(left, minL), maxL);
  panel.style.left = left + 'px';
  // prefer above; go below when there is no room above in the visible area
  const aboveTop = r.y - ph - 8;
  const visibleTop = vr.top - wr.top;
  panel.style.top = (aboveTop >= Math.max(0, visibleTop) ? aboveTop : r.y + r.h + 8) + 'px';
}

// ---------- text editor ----------
function sampleBg(v, bb) {
  try {
    const r = pdfRectToView(v, bb);
    const d = v.dpr, c = v.canvas.getContext('2d');
    const x = Math.max(0, Math.floor((r.x - 3) * d)), y = Math.max(0, Math.floor((r.y - 3) * d));
    const w = Math.min(v.canvas.width - x, Math.ceil((r.w + 6) * d)), h = Math.min(v.canvas.height - y, Math.ceil((r.h + 6) * d));
    const data = c.getImageData(x, y, w, h).data;
    const rs = [], gs = [], bs = [];
    const take = (px, py) => { const k = (py * w + px) * 4; rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]); };
    for (let i = 0; i < w; i += 2) { take(i, 0); take(i, h - 1); }
    for (let j = 0; j < h; j += 2) { take(0, j); take(w - 1, j); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1] / 255;
    return [med(rs), med(gs), med(bs)];
  } catch (e) { return [1, 1, 1]; }
}

function closeEditor() {
  if (!editor) return;
  editor.els.forEach((e) => e.remove());
  editor = null;
}

function openTextEditor(v, block, at) {
  closeEditor(); clearSelection();
  const st = block ? guessStyle(block.fontBase) : { family: 'sans', bold: false, italic: false };
  const size = block ? Math.round(block.size * 10) / 10 : 12;
  const ed = {
    v, block,
    family: st.family, bold: st.bold, italic: st.italic,
    size, color: block ? rgb2hex(block.color) : '#000000',
  };
  // geometry in view
  let r;
  if (block) r = pdfRectToView(v, block.bbox);
  else r = { x: at.x, y: at.y, w: 10, h: size * 1.2 * scale };
  const ta = document.createElement('textarea');
  ta.className = 'edtext'; ta.spellcheck = false; ta.wrap = 'off';
  ta.value = block ? block.text : '';
  const panel = document.createElement('div'); panel.className = 'fpanel';
  panel.innerHTML = `
    <select data-k="family" title="Шрифт"><option value="sans">Sans</option><option value="serif">Serif</option></select>
    <input type="number" data-k="size" min="2" max="400" step="0.5" title="Размер, pt">
    <button class="btn tog" data-k="bold" title="Жирный"><b>B</b></button>
    <button class="btn tog" data-k="italic" title="Курсив"><i>I</i></button>
    <input type="color" data-k="color" title="Цвет">
    <button class="btn primary" data-a="ok" title="Применить (Ctrl+Enter)">Применить</button>
    ${block ? '<button class="btn danger" data-a="del" title="Удалить строку">Удалить</button>' : ''}
    <button class="btn" data-a="cancel" title="Отмена (Esc)">✕</button>`;
  const q = (s) => panel.querySelector(s);
  q('[data-k=family]').value = ed.family;
  q('[data-k=size]').value = ed.size;
  q('[data-k=color]').value = ed.color;
  const sync = () => {
    q('[data-k=bold]').classList.toggle('on', ed.bold);
    q('[data-k=italic]').classList.toggle('on', ed.italic);
    const px = ed.size * scale;
    ta.style.fontFamily = ed.family === 'serif' ? "'Ed Serif', serif" : "'Ed Sans', sans-serif";
    ta.style.fontWeight = ed.bold ? 700 : 400;
    ta.style.fontStyle = ed.italic ? 'italic' : 'normal';
    ta.style.fontSize = px + 'px';
    ta.style.color = ed.color;
    // auto size
    const lines = ta.value.split('\n');
    const meas = sync.c || (sync.c = document.createElement('canvas').getContext('2d'));
    meas.font = `${ed.italic ? 'italic ' : ''}${ed.bold ? 700 : 400} ${px}px ${ed.family === 'serif' ? "'Ed Serif', serif" : "'Ed Sans', sans-serif"}`;
    const w = Math.max(...lines.map((l) => meas.measureText(l).width), 40);
    ta.style.width = Math.max(w + 14, block ? r.w + 8 : 60) + 'px';
    ta.style.height = (lines.length * px * 1.2 + 4) + 'px';
  };
  // position: textarea top aligned with text top
  ta.style.left = (r.x - 3) + 'px';
  ta.style.top = (r.y - 2) + 'px';
  v.wrap.append(ta, panel);
  sync();
  const reposition = () => placePanel(v, panel, { x: r.x, y: r.y - 2, w: ta.offsetWidth, h: ta.offsetHeight });
  reposition();
  ed.reposition = reposition;

  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  q('[data-k=family]').onchange = (e) => { ed.family = e.target.value; sync(); reposition(); };
  q('[data-k=size]').oninput = (e) => { const n = parseFloat(e.target.value); if (n > 0) { ed.size = n; sync(); reposition(); } };
  q('[data-k=color]').oninput = (e) => { ed.color = e.target.value; sync(); };
  q('[data-k=bold]').onclick = () => { ed.bold = !ed.bold; sync(); reposition(); ta.focus(); };
  q('[data-k=italic]').onclick = () => { ed.italic = !ed.italic; sync(); reposition(); ta.focus(); };
  q('[data-a=ok]').onclick = () => applyText(ed, ta.value);
  q('[data-a=cancel]').onclick = () => closeEditor();
  if (block) q('[data-a=del]').onclick = () => applyText(ed, '');
  ta.addEventListener('input', () => { sync(); reposition(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyText(ed, ta.value); }
  });
  ed.els = [ta, panel];
  ed.at = at;
  editor = ed;
  ta.focus({ preventScroll: true }); if (block) ta.select();
}

async function applyText(ed, text) {
  const { v, block } = ed;
  if (!block && !text.trim()) { closeEditor(); return; }
  if (block && text === block.text && ed.size === Math.round(block.size * 10) / 10 && ed.color === rgb2hex(block.color)) {
    const st = guessStyle(block.fontBase);
    if (st.family === ed.family && st.bold === ed.bold && st.italic === ed.italic) { closeEditor(); return; }
  }
  const bg = block && (block.scan || !block.pieces.length) ? sampleBg(v, block.bbox) : null;
  // baseline origin + angle
  let x, y, ang;
  if (block) { x = block.ox; y = block.oy; ang = block.ang; }
  else {
    ang = screenAngle(v);
    const p = v.vp.convertToPdfPoint(ed.at.x, ed.at.y + ed.size * 0.95 * scale);
    x = p[0]; y = p[1];
  }
  const color = hex2rgb(ed.color);
  const ok = await commit(async (doc) => {
    const page = doc.getPage(v.i);
    const m = getModel(v);
    if (m) E.rewrite(doc, v.i, m, { removePieces: new Set(block ? block.pieces.map((p) => p.id) : []) });
    if (bg) {
      const bb = block.bbox, pad = block.size * 0.08;
      page.drawRectangle({ x: bb.x0 - pad, y: bb.y0 - pad, width: bb.x1 - bb.x0 + 2 * pad, height: bb.y1 - bb.y0 + 2 * pad, color: rgb(...bg) });
    }
    if (text.trim()) {
      const font = await getFont(doc, ed.family, ed.bold, ed.italic);
      page.drawText(text, { x, y, size: ed.size, font, color: rgb(...color), lineHeight: ed.size * 1.2, rotate: degrees((ang * 180) / Math.PI) });
    }
  }, text.trim() ? (block ? 'Текст изменён' : 'Текст добавлен') : 'Текст удалён');
  if (ok) closeEditor();
}

// ---------- image selection ----------
function clearSelection() {
  if (!selection) return;
  selection.els.forEach((e) => e.remove());
  selection = null;
}

function selectImage(v, img) {
  closeEditor(); clearSelection();
  const r0 = pdfRectToView(v, img.bbox);
  const box = document.createElement('div'); box.className = 'sel';
  ['nw', 'ne', 'sw', 'se'].forEach((h) => { const d = document.createElement('div'); d.className = 'h ' + h; d.dataset.h = h; box.append(d); });
  place(box, r0);
  const panel = document.createElement('div'); panel.className = 'fpanel';
  panel.innerHTML = `<button class="btn" data-a="rep">Заменить…</button><button class="btn danger" data-a="del">Удалить</button><button class="btn" data-a="x" title="Снять выделение (Esc)">✕</button>`;
  v.wrap.append(box, panel);
  const posPanel = (r) => placePanel(v, panel, r);
  posPanel(r0);
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.querySelector('[data-a=del]').onclick = () => deleteImage();
  panel.querySelector('[data-a=x]').onclick = () => clearSelection();
  panel.querySelector('[data-a=rep]').onclick = () => { $('imgIn').dataset.mode = 'replace'; $('imgIn').click(); };

  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag = { h: e.target.dataset.h || null, sx: e.clientX, sy: e.clientY, r: { ...cur } };
  });
  let cur = { ...r0 };
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    const r = { ...drag.r };
    if (!drag.h) { r.x += dx; r.y += dy; }
    else {
      const left = drag.h.includes('w'), top = drag.h.includes('n');
      let nw = Math.max(8, drag.r.w + (left ? -dx : dx));
      let nh = Math.max(8, drag.r.h + (top ? -dy : dy));
      if (!e.shiftKey) { const k = Math.max(nw / drag.r.w, nh / drag.r.h); nw = drag.r.w * k; nh = drag.r.h * k; }
      r.w = nw; r.h = nh;
      if (left) r.x = drag.r.x + drag.r.w - nw;
      if (top) r.y = drag.r.y + drag.r.h - nh;
    }
    cur = r; place(box, r); posPanel(r);
  });
  box.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = Math.abs(cur.x - drag.r.x) + Math.abs(cur.y - drag.r.y) + Math.abs(cur.w - drag.r.w) + Math.abs(cur.h - drag.r.h);
    drag = null;
    if (moved > 1.5) moveImage(v, img, cur);
  });
  selection = { v, img, els: [box, panel] };
}

function moveImage(v, img, r) {
  const nb = viewRectToPdf(v, r), ob = img.bbox;
  const sx = (nb.x1 - nb.x0) / (ob.x1 - ob.x0), sy = (nb.y1 - nb.y0) / (ob.y1 - ob.y0);
  const S = [sx, 0, 0, sy, nb.x0 - ob.x0 * sx, nb.y0 - ob.y0 * sy];
  const M = mul(img.ctm, S);
  const m = getModel(v);
  commit(async (doc) => { E.rewrite(doc, v.i, m, { placeImages: new Map([[img.id, { matrix: M }]]) }); }, 'Изображение перемещено');
}

function deleteImage() {
  if (!selection) return;
  const { v, img } = selection;
  const m = getModel(v);
  commit(async (doc) => { E.rewrite(doc, v.i, m, { removeImages: new Set([img.id]) }); }, 'Изображение удалено');
}

async function readImageFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось прочитать изображение')); i.src = url; });
    if (isPng || isJpg) return { bytes: buf, type: isPng ? 'png' : 'jpg', w: im.naturalWidth, h: im.naturalHeight };
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    c.getContext('2d').drawImage(im, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png', w: im.naturalWidth, h: im.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
const embedImg = (doc, info) => (info.type === 'png' ? doc.embedPng(info.bytes) : doc.embedJpg(info.bytes));

function replaceImage(info) {
  if (!selection) return;
  const { v, img } = selection;
  const c = img.ctm;
  const W = Math.hypot(c[0], c[1]), H = Math.hypot(c[2], c[3]);
  const ratio = info.w / info.h;
  let nW, nH;
  if (W / H > ratio) { nH = H; nW = H * ratio; } else { nW = W; nH = W / ratio; }
  const a = c[0] * nW / W, b = c[1] * nW / W, cc = c[2] * nH / H, d = c[3] * nH / H;
  const [cx, cy] = apply(c, 0.5, 0.5);
  const M = [a, b, cc, d, cx - 0.5 * (a + cc), cy - 0.5 * (b + d)];
  const m = getModel(v);
  commit(async (doc) => {
    const pdfImg = await embedImg(doc, info);
    E.rewrite(doc, v.i, m, { placeImages: new Map([[img.id, { matrix: M, ref: pdfImg.ref }]]) });
  }, 'Изображение заменено');
}

function insertImageAt(v, pt) {
  const info = pendingImage; if (!info) return;
  const pageW = Math.min(v.w1, v.h1);
  let w = Math.min(info.w * 0.75, pageW * 0.5); let h = w * info.h / info.w;
  const vw = w * scale, vh = h * scale;
  const vx = pt.x - vw / 2, vy = pt.y - vh / 2;
  const p0 = v.vp.convertToPdfPoint(vx, vy + vh);
  const ang = screenAngle(v);
  commit(async (doc) => {
    prepPage(doc, v);
    const pdfImg = await embedImg(doc, info);
    doc.getPage(v.i).drawImage(pdfImg, { x: p0[0], y: p0[1], width: w, height: h, rotate: degrees((ang * 180) / Math.PI) });
  }, 'Изображение вставлено').then((ok) => { if (ok) { pendingImage = null; setTool('select'); } });
}

// ---------- erase / whiteout ----------
function eraseArea(v, r) {
  const bb = viewRectToPdf(v, r);
  const m = getModel(v);
  if (!m) { toast('Не удалось разобрать содержимое этой страницы. Используйте «Закрасить».', true); return; }
  const inside = (x, y) => x >= bb.x0 && x <= bb.x1 && y >= bb.y0 && y <= bb.y1;
  const pieces = m.pieces.filter((p) => inside((p.bbox.x0 + p.bbox.x1) / 2, (p.bbox.y0 + p.bbox.y1) / 2)).map((p) => p.id);
  const imgs = m.images.filter((im) => inside((im.bbox.x0 + im.bbox.x1) / 2, (im.bbox.y0 + im.bbox.y1) / 2)).map((im) => im.id);
  if (!pieces.length && !imgs.length) { toast('В выделенной области нет текста или изображений. Для сканов используйте «Закрасить».'); return; }
  commit(async (doc) => { E.rewrite(doc, v.i, m, { removePieces: new Set(pieces), removeImages: new Set(imgs) }); },
    `Удалено: фрагментов текста — ${pieces.length}, изображений — ${imgs.length}`);
}
function whiteoutArea(v, r) {
  const bb = viewRectToPdf(v, r);
  const col = hex2rgb($('wcolor').value);
  commit(async (doc) => {
    prepPage(doc, v);
    doc.getPage(v.i).drawRectangle({ x: bb.x0, y: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0, color: rgb(...col) });
  }, 'Область закрашена');
}

// ---------- overlay events ----------
function attachOverlayEvents(v) {
  let rb = null;
  const pos = (e) => { const b = v.wrap.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  v.ov.addEventListener('pointerdown', (e) => {
    if (busy || !v.vp) return;
    const p = pos(e);
    if (tool === 'select') { closeEditor(); clearSelection(); return; }
    if (tool === 'addText') { e.preventDefault(); openTextEditor(v, null, p); return; }
    if (tool === 'addImage') {
      e.preventDefault();
      if (!pendingImage) { $('imgIn').dataset.mode = 'insert'; $('imgIn').click(); return; }
      insertImageAt(v, p); return;
    }
    if (tool === 'erase' || tool === 'whiteout') {
      e.preventDefault();
      v.ov.setPointerCapture(e.pointerId);
      const el = document.createElement('div'); el.className = 'rubber' + (tool === 'whiteout' ? ' white' : '');
      if (tool === 'whiteout') el.style.background = $('wcolor').value + 'cc';
      v.wrap.append(el);
      rb = { p0: p, el, r: { x: p.x, y: p.y, w: 0, h: 0 } };
      place(rb.el, rb.r);
    }
  });
  v.ov.addEventListener('pointermove', (e) => {
    if (!rb) return;
    const p = pos(e);
    rb.r = { x: Math.min(p.x, rb.p0.x), y: Math.min(p.y, rb.p0.y), w: Math.abs(p.x - rb.p0.x), h: Math.abs(p.y - rb.p0.y) };
    place(rb.el, rb.r);
  });
  const end = () => {
    if (!rb) return;
    const { r, el } = rb; rb = null; el.remove();
    if (r.w < 4 || r.h < 4) return;
    if (tool === 'erase') eraseArea(v, r); else whiteoutArea(v, r);
  };
  v.ov.addEventListener('pointerup', end);
  v.ov.addEventListener('pointercancel', end);
}

// ---------- tools / toolbar ----------
function setTool(t) {
  tool = t;
  document.body.className = 't-' + t;
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  closeEditor(); clearSelection();
  if (t !== 'addImage') pendingImage = null;
  updateHint();
}
document.querySelectorAll('#tools [data-tool]').forEach((b) => b.addEventListener('click', () => {
  setTool(b.dataset.tool);
  if (b.dataset.tool === 'addImage' && bytes) { $('imgIn').dataset.mode = 'insert'; $('imgIn').click(); }
}));

$('bOpen').onclick = $('bOpen2').onclick = () => $('fileIn').click();
$('fileIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
$('imgIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const info = await readImageFile(f);
    if (e.target.dataset.mode === 'replace') replaceImage(info);
    else { pendingImage = info; $('hint').textContent = 'Кликните на странице — изображение «' + f.name + '» будет вставлено в эту точку.'; }
  } catch (err) { toast(err.message || String(err), true); }
};
$('bUndo').onclick = undo;
$('bRedo').onclick = redo;

function zoomTo(s) {
  if (!views.length) return;
  const anchor = viewer.scrollTop / Math.max(1, pagesEl.scrollHeight);
  scale = Math.max(0.3, Math.min(4, Math.round(s * 20) / 20));
  closeEditor(); clearSelection();
  layout();
  viewer.scrollTop = anchor * pagesEl.scrollHeight;
  refreshVisible();
}
$('bZoomIn').onclick = () => zoomTo(scale * 1.2);
$('bZoomOut').onclick = () => zoomTo(scale / 1.2);

viewer.addEventListener('scroll', () => {
  if (!views.length) return;
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let n = 1;
  for (const v of views) if (v.wrap.offsetTop <= mid) n = v.i + 1;
  $('pageInfo').textContent = n + ' / ' + views.length;
}, { passive: true });

async function saveBlob(name, blob) {
  if (downloads) {
    try { await downloads.save({ filename: name, data: blob }); toast('Файл сохранён: ' + name); return true; }
    catch (e) { if (e && e.code === 'declined') return false; toast('Не удалось сохранить: ' + (e.message || e.code || e), true); return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
async function savePdf() {
  if (!bytes) return;
  const name = /_edited\.pdf$/i.test(fileName) ? fileName : fileName.replace(/\.pdf$/i, '') + '_edited.pdf';
  await saveBlob(name, new Blob([bytes], { type: 'application/pdf' }));
}
$('bSave').onclick = savePdf;

// ---------- printing ----------
let printUrls = [];
function clearPrint() {
  printUrls.forEach((u) => URL.revokeObjectURL(u)); printUrls = [];
  $('printArea').innerHTML = '';
  const st = document.getElementById('pageStyle'); if (st) st.remove();
}
async function printDoc() {
  if (!bytes || busy) return;
  closeEditor(); clearSelection();
  setBusy(true);
  clearPrint();
  try {
    const area = $('printArea');
    let first = null;
    for (let i = 1; i <= pjDoc.numPages; i++) {
      const page = await pjDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const k = Math.min(200 / 72, 5000 / Math.max(vp1.width, vp1.height)); // ~200 dpi
      const vp = page.getViewport({ scale: k });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const url = URL.createObjectURL(blob); printUrls.push(url);
      const img = new Image(); img.src = url;
      img.style.width = vp1.width + 'pt'; img.style.height = vp1.height + 'pt';
      await img.decode().catch(() => {});
      area.append(img);
      if (!first) first = vp1;
    }
    const st = document.createElement('style'); st.id = 'pageStyle';
    st.textContent = `@page { size: ${first.width}pt ${first.height}pt; margin: 0; }`;
    document.head.append(st);
  } catch (e) {
    console.error(e); clearPrint(); setBusy(false);
    toast('Не удалось подготовить печать: ' + (e.message || e), true);
    return;
  }
  setBusy(false);
  let opened = false;
  const onBefore = () => { opened = true; };
  window.addEventListener('beforeprint', onBefore);
  try { window.print(); } catch (e) { /* blocked */ }
  setTimeout(() => {
    window.removeEventListener('beforeprint', onBefore);
    if (!opened) { clearPrint(); $('dlg').classList.add('on'); }
  }, 600);
}
window.addEventListener('afterprint', () => setTimeout(clearPrint, 500));
$('bPrint').onclick = printDoc;
$('dlgClose').onclick = () => $('dlg').classList.remove('on');
$('dlgSave').onclick = () => { $('dlg').classList.remove('on'); savePdf(); };

document.addEventListener('keydown', (e) => {
  if (pageTools.anyOpen()) return;
  const inField = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && bytes) { e.preventDefault(); printDoc(); return; }
  if ((e.ctrlKey || e.metaKey) && !inField) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteImage(); return; }
  if (e.key === 'Escape') { $('dlg').classList.remove('on'); closeEditor(); clearSelection(); return; }
  const map = { v: 'select', t: 'addText', i: 'addImage', e: 'erase', w: 'whiteout' };
  const t = map[e.key.toLowerCase()];
  if (t && bytes) setTool(t);
});

// drag & drop
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer.files || [])].filter((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (!files.length) return;
  if (pageTools.mergeOpen()) { pageTools.addMergeFiles(files); return; }
  openFile(files[0]);
});

// ---------- merge / split ----------
const pageTools = initPageTools({
  pdfjsLib, PDFDocument,
  pdfjsOptions: (data) => ({ data, cMapUrl: BASE, cMapPacked: true, standardFontDataUrl: BASE, CMapReaderFactory: CMapFactory, StandardFontDataFactory: StdFontFactory, useWorkerFetch: false, isEvalSupported: false }),
  current: () => (bytes ? { bytes, name: fileName, pjDoc } : null),
  openBytes, saveBlob, toast, setBusy,
  beforeOpen: () => { closeEditor(); clearSelection(); },
});
$('bMerge').onclick = () => pageTools.openMerge();
$('bSplit').onclick = () => pageTools.openSplit();

let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(refreshVisible, 200); });
updateHint();
