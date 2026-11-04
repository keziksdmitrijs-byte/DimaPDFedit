// PDF content-stream engine: parses page content, locates text pieces and images,
// and rewrites streams to truly remove / move / replace objects.
// Matrices are [a,b,c,d,e,f] with PDF row-vector convention: p' = p × M.

export const I = [1, 0, 0, 1, 0, 0];
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
export function fmt(n) {
  if (!isFinite(n)) n = 0;
  let s = (Math.round(n * 10000) / 10000).toFixed(4);
  s = s.replace(/\.?0+$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}
const fmtM = (m) => m.map(fmt).join(' ');

function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

// ---------------- Tokenizer / parser ----------------
const WS = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach((c) => (WS[c] = 1));
const DELIM = new Uint8Array(256); '()<>[]{}/%'.split('').forEach((c) => (DELIM[c.charCodeAt(0)] = 1));

export function parseContent(b) {
  const ops = [];
  const n = b.length;
  let i = 0;
  let operands = [];
  let opStart = -1;
  const stack = []; // nested arrays / dicts

  function push(v, start) {
    if (stack.length) {
      stack[stack.length - 1].items.push(v);
    } else {
      if (opStart < 0) opStart = start;
      operands.push(v);
    }
  }

  while (i < n) {
    const c = b[i];
    if (WS[c]) { i++; continue; }
    const start = i;
    if (c === 37) { // % comment
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    if (c === 47) { // name
      i++;
      let s = '';
      while (i < n && !WS[b[i]] && !DELIM[b[i]]) {
        if (b[i] === 35 && i + 2 < n) { // #xx
          const h = String.fromCharCode(b[i + 1], b[i + 2]);
          if (/^[0-9a-fA-F]{2}$/.test(h)) { s += String.fromCharCode(parseInt(h, 16)); i += 3; continue; }
        }
        s += String.fromCharCode(b[i]); i++;
      }
      push({ t: 'name', v: s }, start);
      continue;
    }
    if (c === 40) { // literal string
      i++;
      let depth = 1;
      const out = [];
      while (i < n) {
        let ch = b[i];
        if (ch === 92) { // backslash
          i++;
          ch = b[i];
          if (ch === 110) out.push(10);
          else if (ch === 114) out.push(13);
          else if (ch === 116) out.push(9);
          else if (ch === 98) out.push(8);
          else if (ch === 102) out.push(12);
          else if (ch === 13) { if (b[i + 1] === 10) i++; }
          else if (ch === 10) { /* line continuation */ }
          else if (ch >= 48 && ch <= 55) {
            let v = ch - 48;
            if (b[i + 1] >= 48 && b[i + 1] <= 55) { i++; v = v * 8 + (b[i] - 48);
              if (b[i + 1] >= 48 && b[i + 1] <= 55) { i++; v = v * 8 + (b[i] - 48); } }
            out.push(v & 255);
          } else if (ch !== undefined) out.push(ch);
          i++;
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41) { depth--; if (depth === 0) { i++; break; } }
        out.push(ch);
        i++;
      }
      push({ t: 'str', b: Uint8Array.from(out) }, start);
      continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) { // dict start
        i += 2;
        if (!stack.length && opStart < 0) opStart = start;
        stack.push({ kind: 'dict', items: [], start });
        continue;
      }
      // hex string
      i++;
      let hex = '';
      while (i < n && b[i] !== 62) { if (!WS[b[i]]) hex += String.fromCharCode(b[i]); i++; }
      i++;
      if (hex.length % 2) hex += '0';
      const out = new Uint8Array(hex.length / 2);
      for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
      push({ t: 'str', b: out, hex: true }, start);
      continue;
    }
    if (c === 62 && b[i + 1] === 62) { // dict end
      i += 2;
      const top = stack.pop();
      if (top) {
        const d = {};
        for (let k = 0; k + 1 < top.items.length; k += 2) {
          const key = top.items[k];
          if (key && key.t === 'name') d[key.v] = top.items[k + 1];
        }
        push({ t: 'dict', v: d }, top.start);
      }
      continue;
    }
    if (c === 91) { // [
      i++;
      if (!stack.length && opStart < 0) opStart = start;
      stack.push({ kind: 'arr', items: [], start });
      continue;
    }
    if (c === 93) { // ]
      i++;
      const top = stack.pop();
      if (top) push(top.items, top.start);
      continue;
    }
    if (c === 123 || c === 125 || c === 41 || c === 62) { i++; continue; } // stray
    // number or keyword
    let s = '';
    while (i < n && !WS[b[i]] && !DELIM[b[i]]) { s += String.fromCharCode(b[i]); i++; }
    if (/^[+\-]?(\d+\.?\d*|\.\d+)$/.test(s) || /^[+\-.\d]+$/.test(s)) {
      const v = parseFloat(s);
      push(isNaN(v) ? 0 : v, start);
      continue;
    }
    if (s === 'true' || s === 'false') { push(s === 'true', start); continue; }
    if (s === 'null') { push(null, start); continue; }
    if (stack.length) { stack[stack.length - 1].items.push({ t: 'kw', v: s }); continue; }
    // operator
    if (s === 'BI') {
      // inline image: dict until ID, then binary data until EI
      const biStart = opStart >= 0 ? opStart : start;
      const idPos = findKeyword(b, i, 'ID');
      if (idPos < 0) break;
      let p = idPos + 2;
      if (WS[b[p]]) p++;
      // find EI preceded by whitespace and followed by whitespace / EOF
      let q = p;
      let end = -1;
      while (q < n - 1) {
        if (b[q] === 69 && b[q + 1] === 73 && (q === 0 || WS[b[q - 1]]) && (q + 2 >= n || WS[b[q + 2]] || DELIM[b[q + 2]])) {
          end = q + 2; break;
        }
        q++;
      }
      if (end < 0) end = n;
      ops.push({ op: 'BI', operands: [], start: biStart, end });
      i = end;
      operands = []; opStart = -1;
      continue;
    }
    ops.push({ op: s, operands, start: opStart >= 0 ? opStart : start, end: i });
    operands = []; opStart = -1;
  }
  return ops;
}
function findKeyword(b, from, kw) {
  const k0 = kw.charCodeAt(0), k1 = kw.charCodeAt(1);
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === k0 && b[i + 1] === k1 && (WS[b[i - 1]] || i === from) && (i + 2 >= b.length || WS[b[i + 2]])) return i;
  }
  return -1;
}

function concatBytes(arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const latin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
const hexOf = (u) => { let s = '<'; for (const x of u) s += (x < 16 ? '0' : '') + x.toString(16); return s + '>'; };

const STD = {"Helvetica":[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],"Helvetica-Bold":[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],"Times-Roman":[250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541],"Times-Bold":[250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520],"Times-Italic":[250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541],"Times-BoldItalic":[250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,500,389,389,278,556,444,667,500,444,389,348,220,348,570]};
function stdWidths(base) {
  const b = base.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (b.includes('courier') || b.includes('mono')) return () => 600;
  const bold = /bold|black|heavy/.test(b), it = /italic|oblique/.test(b);
  let key;
  if (/times|serif|roman|georgia/.test(b)) key = bold ? (it ? 'Times-BoldItalic' : 'Times-Bold') : it ? 'Times-Italic' : 'Times-Roman';
  else key = bold ? 'Helvetica-Bold' : 'Helvetica';
  const t = STD[key];
  const avg = key.startsWith('Times') ? 480 : 556;
  return (c) => (c >= 32 && c < 127 ? t[c - 32] : avg);
}

// ---------------- Engine ----------------
export function makeEngine(L) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, PDFRef, PDFNumber, decodePDFRawStream } = L;
  const N = (s) => PDFName.of(s);
  const nm = (o) => (o instanceof PDFName ? o.decodeText() : null);
  const num = (o, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);

  function streamBytes(obj) {
    if (!obj) return new Uint8Array(0);
    if (obj instanceof PDFRawStream) {
      if (!obj.dict.get(N('Filter'))) return obj.contents;
      return decodePDFRawStream(obj).decode();
    }
    if (typeof obj.getUnencodedContents === 'function') return obj.getUnencodedContents();
    if (typeof obj.getContents === 'function') return obj.getContents();
    return new Uint8Array(0);
  }

  const fontCache = new WeakMap();
  function fontInfo(fd) {
    if (!(fd instanceof PDFDict)) return { twoByte: false, width: () => 500, base: '' };
    if (fontCache.has(fd)) return fontCache.get(fd);
    const sub = nm(fd.lookup(N('Subtype')));
    let base = nm(fd.lookup(N('BaseFont'))) || '';
    let info;
    if (sub === 'Type0') {
      const descArr = fd.lookup(N('DescendantFonts'));
      const desc = descArr instanceof PDFArray ? descArr.lookup(0) : null;
      const dw = desc instanceof PDFDict ? num(desc.lookup(N('DW')), 1000) : 1000;
      const map = new Map();
      const W = desc instanceof PDFDict ? desc.lookup(N('W')) : null;
      if (W instanceof PDFArray) {
        let k = 0;
        const sz = W.size();
        while (k < sz) {
          const first = num(W.lookup(k));
          const nxt = W.lookup(k + 1);
          if (nxt instanceof PDFArray) {
            for (let j = 0; j < nxt.size(); j++) map.set(first + j, num(nxt.lookup(j)));
            k += 2;
          } else {
            const last = num(nxt); const w = num(W.lookup(k + 2));
            for (let c = first; c <= last && c - first < 70000; c++) map.set(c, w);
            k += 3;
          }
        }
      }
      if (!base && desc instanceof PDFDict) base = nm(desc.lookup(N('BaseFont'))) || '';
      info = { twoByte: true, width: (c) => (map.has(c) ? map.get(c) : dw), base };
    } else {
      const first = num(fd.lookup(N('FirstChar')), 0);
      const Wd = fd.lookup(N('Widths'));
      const desc = fd.lookup(N('FontDescriptor'));
      const missing = desc instanceof PDFDict ? num(desc.lookup(N('MissingWidth')), 0) : 0;
      let scale = 1;
      if (sub === 'Type3') {
        const fm = fd.lookup(N('FontMatrix'));
        if (fm instanceof PDFArray) scale = num(fm.lookup(0), 0.001) * 1000;
      }
      if (Wd instanceof PDFArray) {
        const arr = []; for (let j = 0; j < Wd.size(); j++) arr.push(num(Wd.lookup(j)));
        info = { twoByte: false, width: (c) => { const w = arr[c - first]; return (w === undefined ? missing : w) * scale; }, base };
      } else {
        // standard 14 fonts without /Widths – use built-in metrics
        info = { twoByte: false, width: stdWidths(base), base };
      }
    }
    fontCache.set(fd, info);
    return info;
  }

  function colorFrom(nums) {
    if (nums.length === 1) return [nums[0], nums[0], nums[0]];
    if (nums.length === 3) return nums.slice(0, 3);
    if (nums.length === 4) { const [c, m, y, k] = nums; return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
    return null;
  }

  // Analyse page `pageIndex` of pdf-lib document `doc`.
  function analyzePage(doc, pageIndex) {
    const page = doc.getPage(pageIndex);
    const node = page.node;
    const ctx = doc.context;
    const model = { pageIndex, pieces: [], images: [], streams: new Map(), clean: true };
    // gather page content
    const contents = node.Contents();
    const parts = [];
    if (contents instanceof PDFArray) {
      for (let k = 0; k < contents.size(); k++) { parts.push(streamBytes(contents.lookup(k))); parts.push(latin1('\n')); }
    } else if (contents) parts.push(streamBytes(contents));
    const pageBytes = concatBytes(parts);
    node.autoNormalizeCTM = false;
    const resources = node.normalizedEntries().Resources;
    const end = run(model, ctx, pageBytes, resources, I, 'page', { type: 'page' }, 0, []);
    model.clean = end.clean;
    return model;
  }

  function run(model, ctx, bytes, resources, baseCtm, key, target, depth, chain) {
    let st = model.streams.get(key);
    if (!st) {
      st = { key, bytes, ops: parseContent(bytes), resources, target };
      model.streams.set(key, st);
    }
    const ops = st.ops;
    let gs = { ctm: baseCtm.slice(), Tc: 0, Tw: 0, Th: 1, TL: 0, fd: null, fs: 0, Tr: 0, Ts: 0, fill: [0, 0, 0], fcs: 'DeviceGray' };
    const stack = [];
    let depthQ = 0;
    let Tm = I.slice(), Tlm = I.slice();
    const fontsDict = resources instanceof PDFDict ? resources.lookup(N('Font')) : null;
    const xobjDict = resources instanceof PDFDict ? resources.lookup(N('XObject')) : null;

    const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); };

    const show = (opIndex, elems) => {
      const fi = gs.fd ? fontInfo(gs.fd) : fontInfo(null);
      const fs = gs.fs;
      for (let k = 0; k < elems.length; k++) {
        const e = elems[k];
        if (typeof e === 'number') {
          const tx = (-e / 1000) * fs * gs.Th;
          Tm = mul([1, 0, 0, 1, tx, 0], Tm);
          continue;
        }
        if (!e || e.t !== 'str') continue;
        const by = e.b;
        let tx = 0;
        if (fi.twoByte) {
          for (let j = 0; j + 1 < by.length; j += 2) tx += ((fi.width((by[j] << 8) | by[j + 1]) / 1000) * fs + gs.Tc) * gs.Th;
        } else {
          for (let j = 0; j < by.length; j++) tx += ((fi.width(by[j]) / 1000) * fs + gs.Tc + (by[j] === 32 ? gs.Tw : 0)) * gs.Th;
        }
        if (fs !== 0 && by.length) {
          const M = mul(Tm, gs.ctm);
          const lo = gs.Ts - 0.25 * fs, hi = gs.Ts + 0.85 * fs;
          const bb = bboxOf([apply(M, 0, lo), apply(M, tx, lo), apply(M, tx, hi), apply(M, 0, hi)]);
          const [x0, y0] = apply(M, 0, gs.Ts);
          const [x1, y1] = apply(M, tx, gs.Ts);
          const size = Math.abs(fs) * Math.hypot(M[2], M[3]);
          model.pieces.push({
            id: model.pieces.length, key, opIndex, elemIndex: k,
            adj: fs * gs.Th !== 0 ? (-1000 * tx) / (fs * gs.Th) : 0,
            bbox: bb, x0, y0, x1, y1, size,
            dir: [M[0], M[1]],
            color: gs.fill ? gs.fill.slice() : [0, 0, 0],
            invisible: gs.Tr === 3 || gs.Tr === 7,
            fontBase: fi.base,
          });
        }
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      }
    };

    for (let i = 0; i < ops.length; i++) {
      const { op, operands: a } = ops[i];
      switch (op) {
        case 'q': stack.push({ ...gs, ctm: gs.ctm.slice(), fill: gs.fill && gs.fill.slice() }); depthQ++; break;
        case 'Q': if (stack.length) gs = stack.pop(); depthQ--; break;
        case 'cm': if (a.length >= 6) gs.ctm = mul(a.slice(-6), gs.ctm); break;
        case 'BT': Tm = I.slice(); Tlm = I.slice(); break;
        case 'Tc': gs.Tc = +a[0] || 0; break;
        case 'Tw': gs.Tw = +a[0] || 0; break;
        case 'Tz': gs.Th = (+a[0] || 0) / 100; break;
        case 'TL': gs.TL = +a[0] || 0; break;
        case 'Ts': gs.Ts = +a[0] || 0; break;
        case 'Tr': gs.Tr = +a[0] || 0; break;
        case 'Tf': {
          const fname = a[0] && a[0].t === 'name' ? a[0].v : null;
          gs.fs = +a[1] || 0;
          gs.fd = fname && fontsDict instanceof PDFDict ? fontsDict.lookup(N(fname)) : null;
          break;
        }
        case 'Td': td(+a[0] || 0, +a[1] || 0); break;
        case 'TD': gs.TL = -(+a[1] || 0); td(+a[0] || 0, +a[1] || 0); break;
        case 'Tm': if (a.length >= 6) { Tlm = a.slice(-6); Tm = Tlm.slice(); } break;
        case 'T*': td(0, -gs.TL); break;
        case 'Tj': show(i, [a[a.length - 1]]); break;
        case "'": td(0, -gs.TL); show(i, [a[a.length - 1]]); break;
        case '"': gs.Tw = +a[0] || 0; gs.Tc = +a[1] || 0; td(0, -gs.TL); show(i, [a[2]]); break;
        case 'TJ': show(i, Array.isArray(a[0]) ? a[0] : []); break;
        case 'g': gs.fill = colorFrom([+a[0] || 0]); gs.fcs = 'DeviceGray'; break;
        case 'rg': gs.fill = colorFrom(a.slice(0, 3).map(Number)); gs.fcs = 'DeviceRGB'; break;
        case 'k': gs.fill = colorFrom(a.slice(0, 4).map(Number)); gs.fcs = 'DeviceCMYK'; break;
        case 'cs': gs.fcs = a[0] && a[0].v; gs.fill = [0, 0, 0]; break;
        case 'sc': case 'scn': {
          const nums = a.filter((x) => typeof x === 'number');
          const c = colorFrom(nums); if (c) gs.fill = c; break;
        }
        case 'BI': {
          const bb = bboxOf([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)]);
          model.images.push({ id: model.images.length, key, opIndex: i, ctm: gs.ctm.slice(), bbox: bb, inline: true, resources });
          break;
        }
        case 'Do': {
          const name = a[0] && a[0].t === 'name' ? a[0].v : null;
          if (!name || !(xobjDict instanceof PDFDict)) break;
          const raw = xobjDict.get(N(name));
          const xo = ctx.lookup(raw);
          if (!(xo instanceof PDFStream)) break;
          const sub = nm(xo.dict.lookup(N('Subtype')));
          if (sub === 'Image') {
            const bb = bboxOf([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)]);
            const w = num(xo.dict.lookup(N('Width'))), h = num(xo.dict.lookup(N('Height')));
            model.images.push({ id: model.images.length, key, opIndex: i, ctm: gs.ctm.slice(), bbox: bb, name, resources, pxW: w, pxH: h });
          } else if (sub === 'Form' && depth < 8 && raw instanceof PDFRef) {
            const fkey = 'form:' + raw.objectNumber + '_' + raw.generationNumber;
            if (chain.includes(fkey)) break;
            const mArr = xo.dict.lookup(N('Matrix'));
            let fm = I;
            if (mArr instanceof PDFArray && mArr.size() >= 6) { fm = []; for (let j = 0; j < 6; j++) fm.push(num(mArr.lookup(j))); }
            const fres = xo.dict.lookup(N('Resources'));
            run(model, ctx, streamBytes(xo), fres instanceof PDFDict ? fres : resources, mul(fm, gs.ctm), fkey, { type: 'form', ref: raw }, depth + 1, chain.concat(fkey));
          }
          break;
        }
        default: break;
      }
    }
    const ctmSame = gs.ctm.every((v, j) => Math.abs(v - baseCtm[j]) < 1e-6);
    const clean = depthQ === 0 && ctmSame && gs.Tc === 0 && gs.Tw === 0 && gs.Th === 1 && gs.Ts === 0 && gs.Tr === 0;
    return { clean };
  }

  function uniqueName(dict, prefix) {
    for (let k = 1; k < 100000; k++) {
      const nmx = prefix + k;
      if (!dict.get(N(nmx))) return nmx;
    }
    return prefix + Date.now();
  }

  // Register an XObject (image ref) in `resources`, return its name.
  function addXObject(ctx, resources, ref) {
    let xd = resources.lookup(N('XObject'));
    if (!(xd instanceof PDFDict)) { xd = ctx.obj({}); resources.set(N('XObject'), xd); }
    const name = uniqueName(xd, 'ImEd');
    xd.set(N(name), ref);
    return name;
  }

  /**
   * Rewrite streams of a page.
   * edits = {
   *   removePieces: Set<pieceId>,
   *   removeImages: Set<imageId>,
   *   placeImages: Map<imageId, {matrix:[6] page-space, ref?:PDFRef}>  // move/resize/replace
   * }
   */
  function rewrite(doc, pageIndex, model, edits = {}) {
    const ctx = doc.context;
    const page = doc.getPage(pageIndex);
    const reps = new Map(); // key -> Map(opIndex -> string)
    const setRep = (key, opIndex, s) => {
      if (!reps.has(key)) reps.set(key, new Map());
      reps.get(key).set(opIndex, s);
    };

    // text removal
    const byOp = new Map();
    for (const pid of edits.removePieces || []) {
      const p = model.pieces[pid]; if (!p) continue;
      const k = p.key + '#' + p.opIndex;
      if (!byOp.has(k)) byOp.set(k, { key: p.key, opIndex: p.opIndex, elems: new Map() });
      byOp.get(k).elems.set(p.elemIndex, p.adj);
    }
    for (const { key, opIndex, elems } of byOp.values()) {
      const st = model.streams.get(key);
      const o = st.ops[opIndex];
      const a = o.operands;
      const adjOf = (k) => fmt(elems.get(k));
      let s;
      if (o.op === 'TJ') {
        const arr = Array.isArray(a[0]) ? a[0] : [];
        const parts = arr.map((e, k) => (typeof e === 'number' ? fmt(e) : elems.has(k) ? adjOf(k) : e && e.t === 'str' ? hexOf(e.b) : ''));
        s = '[' + parts.join(' ') + '] TJ';
      } else if (o.op === 'Tj') s = '[' + adjOf(0) + '] TJ';
      else if (o.op === "'") s = 'T* [' + adjOf(0) + '] TJ';
      else if (o.op === '"') s = fmt(+a[0] || 0) + ' Tw ' + fmt(+a[1] || 0) + ' Tc T* [' + adjOf(0) + '] TJ';
      if (s) setRep(key, opIndex, s);
    }

    // images
    for (const id of edits.removeImages || []) {
      const im = model.images[id]; if (im) setRep(im.key, im.opIndex, '');
    }
    for (const [id, pl] of edits.placeImages || []) {
      const im = model.images[id]; if (!im) continue;
      const ic = inv(im.ctm); if (!ic) continue;
      const Lm = mul(pl.matrix, ic);
      const st = model.streams.get(im.key);
      const o = st.ops[im.opIndex];
      let body;
      if (pl.ref) {
        const res = im.resources instanceof PDFDict ? im.resources : page.node.Resources();
        body = '/' + addXObject(ctx, res, pl.ref) + ' Do';
      } else {
        body = new TextDecoder('latin1').decode(st.bytes.subarray(o.start, o.end));
      }
      setRep(im.key, im.opIndex, 'q ' + fmtM(Lm) + ' cm ' + body + ' Q');
    }

    // build each stream
    for (const [key, st] of model.streams) {
      const r = reps.get(key);
      if (key !== 'page' && !r) continue;
      let out;
      if (r) {
        const chunks = [];
        let pos = 0;
        const idxs = [...r.keys()].sort((x, y) => x - y);
        for (const oi of idxs) {
          const o = st.ops[oi];
          chunks.push(st.bytes.subarray(pos, o.start));
          chunks.push(latin1(' ' + r.get(oi) + ' '));
          pos = o.end;
        }
        chunks.push(st.bytes.subarray(pos));
        out = concatBytes(chunks);
      } else out = st.bytes;

      if (st.target.type === 'page') {
        if (!model.clean) out = concatBytes([latin1('q\n'), out, latin1('\nQ\n')]);
        const ref = ctx.register(ctx.flateStream(out));
        page.node.set(N('Contents'), ctx.obj([ref]));
        page.node.autoNormalizeCTM = false;
      } else {
        const old = ctx.lookup(st.target.ref);
        const ns = ctx.flateStream(out);
        for (const [k, v] of old.dict.entries()) {
          const kn = k.decodeText();
          if (['Filter', 'DecodeParms', 'Length', 'DL'].includes(kn)) continue;
          ns.dict.set(k, v);
        }
        ctx.assign(st.target.ref, ns);
      }
    }
  }

  return { analyzePage, rewrite, streamBytes };
}
