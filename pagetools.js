// Merge several PDFs into one (with user-defined order) and split a PDF into parts.

// ---------- tiny ZIP writer (store, no compression: PDFs are already compressed) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files) { // [{name, data:Uint8Array}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- page ranges ----------
// "1-3, 5, 7-" -> [[0,1,2],[4],[6,...,n-1]]
export function parseRanges(text, n) {
  const out = [];
  const chunks = text.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!chunks.length) throw new Error('Укажите страницы, например: 1-3, 5, 7-9');
  for (const c of chunks) {
    const m = c.replace(/[–—]/g, '-').replace(/\s+/g, '').match(/^(\d*)(-?)(\d*)$/);
    if (!m || (!m[1] && !m[3])) throw new Error(`Непонятный фрагмент «${c}»`);
    let a = m[1] ? +m[1] : 1;
    let b = m[2] ? (m[3] ? +m[3] : n) : a;
    if (a < 1 || b < 1 || a > n || b > n) throw new Error(`«${c}»: в документе ${n} стр.`);
    const arr = [];
    if (a <= b) for (let i = a; i <= b; i++) arr.push(i - 1);
    else for (let i = a; i >= b; i--) arr.push(i - 1);
    out.push(arr);
  }
  return out;
}
const rangeLabel = (arr) => {
  const segs = []; let s = arr[0], p = arr[0];
  for (let i = 1; i <= arr.length; i++) {
    const x = arr[i];
    if (x === p + 1) { p = x; continue; }
    segs.push(s === p ? `${s + 1}` : `${s + 1}-${p + 1}`);
    s = p = x;
  }
  return segs.join(',');
};
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return n + ' ' + (m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initPageTools(api) {
  const { pdfjsLib, PDFDocument } = api;
  const $ = (id) => document.getElementById(id);

  async function renderThumb(page, width) {
    const vp1 = page.getViewport({ scale: 1 });
    const k = (width * Math.min(window.devicePixelRatio || 1, 2)) / vp1.width;
    const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    c.style.width = width + 'px';
    c.style.height = (width * vp1.height / vp1.width) + 'px';
    return c;
  }

  async function buildPdf(sources) { // [{bytes, pages:[idx]|null}]
    const out = await PDFDocument.create();
    const cache = new Map();
    for (const s of sources) {
      let src = cache.get(s.bytes);
      if (!src) { src = await PDFDocument.load(s.bytes, { updateMetadata: false }); cache.set(s.bytes, src); }
      const idx = s.pages || src.getPageIndices();
      const pages = await out.copyPages(src, idx);
      pages.forEach((p) => out.addPage(p));
    }
    return out.save();
  }

  // ================= MERGE =================
  let mergeItems = [];
  let mergeSeq = 0;
  const mergeBack = $('mergeDlg');
  const list = $('mergeList');

  function mergeOpen() { return mergeBack.classList.contains('on'); }

  function openMerge() {
    api.beforeOpen && api.beforeOpen();
    mergeItems = [];
    list.innerHTML = '';
    const cur = api.current();
    if (cur) addItem({ name: cur.name, bytes: cur.bytes, current: true });
    mergeBack.classList.add('on');
    renderMerge();
  }
  function closeMerge() {
    mergeBack.classList.remove('on');
    mergeItems = [];
    list.innerHTML = '';
  }

  async function addItem({ name, bytes, current = false }) {
    const it = { id: ++mergeSeq, name, bytes, current, pages: null, thumb: null, error: null };
    mergeItems.push(it);
    renderMerge();
    try {
      const doc = await pdfjsLib.getDocument(api.pdfjsOptions(bytes.slice())).promise;
      it.pages = doc.numPages;
      it.thumb = await renderThumb(await doc.getPage(1), 46);
      doc.destroy();
      // pdf-lib must be able to read it too (encrypted files fail here)
      await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      it.error = /encrypt|password/i.test((e && (e.message || e.name)) || '') ? 'защищён паролем' : 'не удалось прочитать';
    }
    renderMerge();
  }

  async function addMergeFiles(files) {
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (String.fromCharCode(...buf.subarray(0, 1024)).indexOf('%PDF') < 0) { api.toast(`«${f.name}» — не PDF`, true); continue; }
      addItem({ name: f.name, bytes: buf });
    }
  }

  function move(id, delta) {
    const i = mergeItems.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= mergeItems.length) return;
    const [x] = mergeItems.splice(i, 1);
    mergeItems.splice(j, 0, x);
    renderMerge();
  }

  let dragId = null;
  function renderMerge() {
    list.innerHTML = '';
    mergeItems.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'mrow' + (it.error ? ' bad' : '');
      row.draggable = true;
      row.dataset.id = it.id;
      row.innerHTML = `
        <span class="grip" title="Перетащите, чтобы изменить порядок">⋮⋮</span>
        <span class="mnum">${i + 1}</span>
        <span class="mthumb"></span>
        <span class="mname"><b>${esc(it.name)}</b><small>${it.error ? 'Ошибка: ' + it.error : it.pages == null ? 'читаю…' : plural(it.pages, 'страница', 'страницы', 'страниц')}${it.current ? ' · открытый документ с правками' : ''}</small></span>
        <button class="btn ib" data-a="up" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ib" data-a="down" title="Ниже" ${i === mergeItems.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ib danger" data-a="rm" title="Убрать из списка">✕</button>`;
      if (it.thumb) row.querySelector('.mthumb').append(it.thumb);
      row.querySelector('[data-a=up]').onclick = () => move(it.id, -1);
      row.querySelector('[data-a=down]').onclick = () => move(it.id, 1);
      row.querySelector('[data-a=rm]').onclick = () => { mergeItems = mergeItems.filter((x) => x !== it); renderMerge(); };
      row.addEventListener('dragstart', (e) => { dragId = it.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.id)); });
      row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); list.querySelectorAll('.mrow').forEach((r) => r.classList.remove('before', 'after')); });
      row.addEventListener('dragover', (e) => {
        if (dragId == null) return;
        e.preventDefault(); e.stopPropagation();
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        list.querySelectorAll('.mrow').forEach((x) => x.classList.remove('before', 'after'));
        if (dragId !== it.id) row.classList.add(after ? 'after' : 'before');
      });
      row.addEventListener('drop', (e) => {
        if (dragId == null) return;
        e.preventDefault(); e.stopPropagation();
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        const from = mergeItems.findIndex((x) => x.id === dragId);
        const [x] = mergeItems.splice(from, 1);
        let to = mergeItems.findIndex((y) => y.id === it.id);
        if (to < 0) { mergeItems.splice(from, 0, x); return; }
        if (after) to++;
        mergeItems.splice(to, 0, x);
        dragId = null;
        renderMerge();
      });
      list.append(row);
    });
    if (!mergeItems.length) list.innerHTML = '<div class="mempty">Добавьте PDF-файлы — кнопкой ниже или перетащив их сюда.</div>';
    const ok = mergeItems.filter((x) => !x.error && x.pages != null);
    const pages = ok.reduce((a, b) => a + b.pages, 0);
    const loading = mergeItems.some((x) => x.pages == null && !x.error);
    $('mergeInfo').textContent = mergeItems.length ? `${plural(mergeItems.length, 'файл', 'файла', 'файлов')} · ${plural(pages, 'страница', 'страницы', 'страниц')}` : '';
    const can = ok.length >= 2 && !loading && ok.length === mergeItems.length;
    $('mergeGo').disabled = !can;
    $('mergeSave').disabled = !can;
    $('mergeHint').textContent = mergeItems.some((x) => x.error) ? 'Уберите из списка файлы с ошибкой.' : ok.length < 2 ? 'Нужно хотя бы два файла.' : 'Порядок: перетащите строку или используйте стрелки ↑ ↓.';
  }

  async function doMerge(open) {
    const items = mergeItems.slice();
    api.setBusy(true);
    try {
      const out = await buildPdf(items.map((x) => ({ bytes: x.bytes, pages: null })));
      const base = items[0].name.replace(/(_edited)?\.pdf$/i, '');
      const name = base + '_merged.pdf';
      closeMerge();
      api.setBusy(false);
      if (open) { await api.openBytes(out, name); api.toast(`Объединено: ${plural(items.length, 'файл', 'файла', 'файлов')}`); }
      else await api.saveBlob(name, new Blob([out], { type: 'application/pdf' }));
    } catch (e) {
      console.error(e);
      api.toast('Не удалось объединить: ' + (e.message || e), true, 5000);
    } finally { api.setBusy(false); }
  }

  $('mergeAdd').onclick = () => $('mergeIn').click();
  $('mergeIn').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; addMergeFiles(fs); };
  $('mergeGo').onclick = () => doMerge(true);
  $('mergeSave').onclick = () => doMerge(false);
  mergeBack.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeMerge));

  // ================= SPLIT =================
  const splitBack = $('splitDlg');
  const grid = $('splitGrid');
  let cuts = new Set();      // cut after page index i
  let nPages = 0;
  let mode = 'cuts';
  let thumbToken = 0;

  function splitOpen() { return splitBack.classList.contains('on'); }

  function openSplit() {
    const cur = api.current();
    if (!cur) return;
    api.beforeOpen && api.beforeOpen();
    nPages = cur.pjDoc.numPages;
    cuts = new Set();
    $('splitRanges').value = '';
    $('splitOne').checked = false;
    $('splitN').value = 2;
    setMode('cuts');
    splitBack.classList.add('on');
    buildGrid(cur.pjDoc);
    renderSplit();
  }
  function closeSplit() { splitBack.classList.remove('on'); thumbToken++; grid.innerHTML = ''; }

  function buildGrid(pjDoc) {
    const token = ++thumbToken;
    grid.innerHTML = '';
    const cells = [];
    for (let i = 0; i < nPages; i++) {
      const cell = document.createElement('div'); cell.className = 'scell';
      cell.innerHTML = `<div class="sthumb"></div><div class="slab">${i + 1}</div>`;
      grid.append(cell);
      cells.push(cell);
      if (i < nPages - 1) {
        const gap = document.createElement('button');
        gap.className = 'sgap'; gap.dataset.i = i;
        gap.title = `Разрезать после страницы ${i + 1}`;
        gap.innerHTML = '<span class="sline"></span><span class="ssc">✂</span>';
        gap.onclick = () => { cuts.has(i) ? cuts.delete(i) : cuts.add(i); renderSplit(); };
        grid.append(gap);
      }
    }
    (async () => {
      for (let i = 0; i < nPages; i++) {
        if (token !== thumbToken) return;
        try {
          const c = await renderThumb(await pjDoc.getPage(i + 1), 92);
          if (token !== thumbToken) return;
          cells[i].querySelector('.sthumb').append(c);
        } catch (e) { /* ignore */ }
      }
    })();
  }

  function setMode(m) {
    mode = m;
    splitBack.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('splitCutsPane').style.display = m === 'cuts' ? '' : 'none';
    $('splitRangesPane').style.display = m === 'ranges' ? '' : 'none';
    renderSplit();
  }

  function currentParts() {
    if (mode === 'ranges') {
      const r = parseRanges($('splitRanges').value, nPages);
      return $('splitOne').checked ? [r.flat()] : r;
    }
    const parts = []; let curp = [];
    for (let i = 0; i < nPages; i++) { curp.push(i); if (cuts.has(i)) { parts.push(curp); curp = []; } }
    if (curp.length) parts.push(curp);
    return parts;
  }

  function partName(p, k, total) {
    const base = api.current().name.replace(/(_edited)?\.pdf$/i, '');
    const lab = rangeLabel(p);
    return `${base}_${String(k + 1).padStart(String(total).length, '0')}_${p.length === 1 ? 'p' : 'pp'}${lab}.pdf`;
  }

  function renderSplit() {
    grid.querySelectorAll('.sgap').forEach((g) => g.classList.toggle('on', cuts.has(+g.dataset.i)));
    const box = $('splitParts');
    box.innerHTML = '';
    let parts;
    try { parts = currentParts(); $('splitErr').textContent = ''; }
    catch (e) { parts = []; $('splitErr').textContent = e.message; }
    if (mode === 'cuts' && parts.length < 2) {
      $('splitSummary').textContent = 'Нажмите ✂ между страницами, чтобы поставить разрез, или выберите вариант выше.';
    } else {
      $('splitSummary').textContent = parts.length ? `Получится ${plural(parts.length, 'файл', 'файла', 'файлов')}:` : '';
    }
    const total = parts.length;
    if (total >= 1 && !(mode === 'cuts' && total < 2)) {
      parts.forEach((p, k) => {
        const row = document.createElement('div'); row.className = 'prow';
        row.innerHTML = `<span class="pname">${esc(partName(p, k, total))}</span><small>${plural(p.length, 'стр.', 'стр.', 'стр.')}</small>
          <button class="btn ib" data-a="dl" title="Скачать эту часть">Скачать</button><button class="btn ib" data-a="open" title="Открыть эту часть в редакторе">Открыть</button>`;
        row.querySelector('[data-a=dl]').onclick = () => savePart(p, k, total);
        row.querySelector('[data-a=open]').onclick = () => openPart(p, k, total);
        box.append(row);
      });
    }
    const ok = total >= 1 && !(mode === 'cuts' && total < 2);
    $('splitGo').disabled = !ok;
    $('splitGo').textContent = total > 1 ? `Скачать все (ZIP, ${total})` : 'Скачать';
  }

  async function partBytes(p) { return buildPdf([{ bytes: api.current().bytes, pages: p }]); }
  async function savePart(p, k, total) {
    api.setBusy(true);
    try { const b = await partBytes(p); api.setBusy(false); await api.saveBlob(partName(p, k, total), new Blob([b], { type: 'application/pdf' })); }
    catch (e) { api.toast('Ошибка: ' + (e.message || e), true); }
    finally { api.setBusy(false); }
  }
  async function openPart(p, k, total) {
    api.setBusy(true);
    try { const b = await partBytes(p); const name = partName(p, k, total); closeSplit(); api.setBusy(false); await api.openBytes(b, name); }
    catch (e) { api.toast('Ошибка: ' + (e.message || e), true); }
    finally { api.setBusy(false); }
  }
  async function saveAll() {
    let parts;
    try { parts = currentParts(); } catch (e) { api.toast(e.message, true); return; }
    if (!parts.length) return;
    if (parts.length === 1) { savePart(parts[0], 0, 1); return; }
    api.setBusy(true);
    try {
      const files = [];
      for (let k = 0; k < parts.length; k++) files.push({ name: partName(parts[k], k, parts.length), data: await partBytes(parts[k]) });
      const zipName = api.current().name.replace(/(_edited)?\.pdf$/i, '') + '_split.zip';
      api.setBusy(false);
      await api.saveBlob(zipName, makeZip(files));
    } catch (e) { api.toast('Ошибка: ' + (e.message || e), true); }
    finally { api.setBusy(false); }
  }

  splitBack.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('splitEach').onclick = () => { cuts = new Set(Array.from({ length: nPages - 1 }, (_, i) => i)); renderSplit(); };
  $('splitEveryN').onclick = () => {
    const n = Math.max(1, parseInt($('splitN').value, 10) || 1);
    cuts = new Set(); for (let i = n - 1; i < nPages - 1; i += n) cuts.add(i); renderSplit();
  };
  $('splitClear').onclick = () => { cuts = new Set(); renderSplit(); };
  $('splitRanges').oninput = renderSplit;
  $('splitOne').onchange = renderSplit;
  $('splitGo').onclick = saveAll;
  splitBack.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSplit));

  // close on Escape / backdrop click
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (mergeOpen()) closeMerge();
    if (splitOpen()) closeSplit();
  });
  [mergeBack, splitBack].forEach((b) => b.addEventListener('pointerdown', (e) => { if (e.target === b) (b === mergeBack ? closeMerge : closeSplit)(); }));

  return { openMerge, openSplit, mergeOpen, addMergeFiles, anyOpen: () => mergeOpen() || splitOpen() };
}
