/* =========================================================
 * excalidraw-core.js
 * SVG  →  Excalidraw 元素 的转换内核
 * 纯浏览器端实现，无任何外部依赖
 * ========================================================= */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';
  var ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var SKIP_TAGS = {
    defs: 1, symbol: 1, clippath: 1, mask: 1, marker: 1, pattern: 1,
    filter: 1, lineargradient: 1, radialgradient: 1, style: 1, title: 1,
    desc: 1, metadata: 1, script: 1, foreignobject: 1, switch: 1
  };

  /* ---------------------------------------------------------
   * 小工具
   * ------------------------------------------------------- */
  var _idxCounter = 0;

  function resetCounter() { _idxCounter = 0; }

  /** Excalidraw 的 fractional index：定长 base62，保证字典序 == 生成序 */
  function nextIndex() {
    var n = _idxCounter++, s = '';
    do { s = ALPHABET[n % 62] + s; n = Math.floor(n / 62); } while (n > 0);
    return 'a' + s.padStart(6, '0');
  }

  function nanoId(len) {
    var s = '', n = len || 12;
    for (var i = 0; i < n; i++) s += ID_CHARS[(Math.random() * ID_CHARS.length) | 0];
    return s;
  }

  function rnd() { return (Math.random() * 0x7fffffff) | 0; }

  function r2(v) { return Math.round(v * 100) / 100; }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* -------- 颜色 -------- */
  var _cctx = null;
  function colorCtx() {
    if (!_cctx) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      _cctx = cv.getContext('2d');
    }
    return _cctx;
  }

  /** 任意 CSS 颜色 → #rrggbb；none/transparent → null */
  function toHex(input) {
    if (input == null) return null;
    var c = String(input).trim();
    if (!c) return null;
    var lc = c.toLowerCase();
    if (lc === 'none' || lc === 'transparent' || lc === 'currentcolor') return null;
    // url(#gradient) 之类的 paint server 交给调用方单独处理
    if (lc.indexOf('url(') === 0) return null;
    if (lc.charAt(0) === '#') {
      if (lc.length === 4) return '#' + lc[1] + lc[1] + lc[2] + lc[2] + lc[3] + lc[3];
      if (lc.length === 7) return lc;
      if (lc.length === 9) return lc.slice(0, 7);
      return null;
    }
    var m = lc.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(function (t) { return t !== ''; }).map(parseFloat);
      if (p.length >= 3) {
        return '#' + p.slice(0, 3).map(function (v) {
          return clamp(Math.round(v) || 0, 0, 255).toString(16).padStart(2, '0');
        }).join('');
      }
      return null;
    }
    try {
      // 借浏览器解析关键字颜色；用哨兵色判断输入是否真的合法
      var ctx = colorCtx();
      ctx.fillStyle = '#010203';
      ctx.fillStyle = c;
      var out = ctx.fillStyle;
      if (typeof out !== 'string') return null;
      var lo = out.toLowerCase();
      if (lo === '#010203' && lc !== '#010203' && lc !== 'rgb(1,2,3)' && lc !== 'rgb(1, 2, 3)') return null;
      if (lo.charAt(0) === '#' || lo.indexOf('rgb') === 0) return toHex(out);
    } catch (e) { /* ignore */ }
    return null;
  }

  function hexToRgb(hex) {
    if (!hex || hex.charAt(0) !== '#') return null;
    var h = hex.length === 4
      ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
      : hex;
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }

  /* ---------------------------------------------------------
   * 矩阵（[a b c d e f]，列主序同 SVG）
   * ------------------------------------------------------- */
  var M = {
    identity: function () { return [1, 0, 0, 1, 0, 0]; },
    mul: function (m1, m2) {
      return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
      ];
    },
    apply: function (m, p) {
      return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
    },
    translate: function (x, y) { return [1, 0, 0, 1, x, y]; },
    scale: function (x, y) { return [x, 0, 0, y, 0, 0]; },
    rotate: function (deg) {
      var a = deg * Math.PI / 180;
      return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    },
    skewX: function (deg) { return [1, 0, Math.tan(deg * Math.PI / 180), 1, 0, 0]; },
    skewY: function (deg) { return [1, Math.tan(deg * Math.PI / 180), 0, 1, 0, 0]; },
    isAxisAligned: function (m) { return Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6; }
  };

  function parseTransform(str) {
    var m = M.identity();
    if (!str || str === 'none') return m;
    var re = /([a-zA-Z]+)\s*\(([^)]*)\)/g, hit;
    while ((hit = re.exec(str)) !== null) {
      var fn = hit[1].toLowerCase();
      var a = hit[2].split(/[\s,]+/).filter(function (t) { return t !== ''; }).map(parseFloat);
      if (!a.length || a.some(isNaN)) continue;
      var t = null;
      if (fn === 'matrix' && a.length >= 6) t = a.slice(0, 6);
      else if (fn === 'translate') t = M.translate(a[0] || 0, a.length > 1 ? a[1] : 0);
      else if (fn === 'scale') t = M.scale(a[0], a.length > 1 ? a[1] : a[0]);
      else if (fn === 'rotate') {
        t = a.length >= 3
          ? M.mul(M.mul(M.translate(a[1], a[2]), M.rotate(a[0])), M.translate(-a[1], -a[2]))
          : M.rotate(a[0]);
      } else if (fn === 'skewx') t = M.skewX(a[0]);
      else if (fn === 'skewy') t = M.skewY(a[0]);
      if (t) m = M.mul(m, t);
    }
    return m;
  }

  /* ---------------------------------------------------------
   * SVG path 数据解析
   * ------------------------------------------------------- */
  var ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  var NUM_RE = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

  function parsePathData(d) {
    var tokens = [], m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(d)) !== null) {
      tokens.push(m[1] ? m[1] : parseFloat(m[2]));
    }
    var cmds = [], i = 0, prev = null;
    while (i < tokens.length) {
      var cmd;
      if (typeof tokens[i] === 'string') { cmd = tokens[i]; i++; }
      else {
        if (!prev) break;
        cmd = prev === 'M' ? 'L' : (prev === 'm' ? 'l' : prev);
      }
      var upper = cmd.toUpperCase();
      var n = ARG_COUNT[upper];
      if (n === undefined) { i++; continue; }
      var args = [];
      for (var k = 0; k < n; k++) {
        var v = tokens[i + k];
        if (typeof v !== 'number') { args = null; break; }
        args.push(v);
      }
      if (args === null) break;
      i += n;
      cmds.push({ cmd: cmd, args: args });
      prev = cmd;
    }
    return cmds;
  }

  /** 将命令序列按 M 拆成子路径 */
  function splitSubpaths(cmds) {
    var subs = [], cur = null;
    var cx = 0, cy = 0, sx = 0, sy = 0;

    function closeCur() {
      if (cur && cur.cmds.length) {
        cur.end = [cx, cy];
        if (!cur.closed &&
            Math.abs(cx - cur.start[0]) < 0.01 &&
            Math.abs(cy - cur.start[1]) < 0.01) cur.closed = true;
        subs.push(cur);
      }
      cur = null;
    }

    for (var i = 0; i < cmds.length; i++) {
      var cmd = cmds[i].cmd, a = cmds[i].args, u = cmd.toUpperCase();
      var rel = (cmd !== u);

      if (u === 'M') {
        closeCur();
        var mx = rel ? cx + a[0] : a[0];
        var my = rel ? cy + a[1] : a[1];
        cx = sx = mx; cy = sy = my;
        cur = { cmds: [cmd + ' ' + a[0] + ' ' + a[1]], start: [mx, my], closed: false, linear: true, end: [mx, my] };
        continue;
      }
      if (!cur) {
        cur = { cmds: ['M 0 0'], start: [0, 0], closed: false, linear: true, end: [0, 0] };
      }
      cur.cmds.push(cmd + ' ' + a.join(' '));

      if (u === 'Z') {
        cur.closed = true;
        cx = sx; cy = sy;
      } else {
        if (u === 'L' || u === 'T') { cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1]; }
        else if (u === 'H') { cx = rel ? cx + a[0] : a[0]; }
        else if (u === 'V') { cy = rel ? cy + a[0] : a[0]; }
        else if (u === 'C') { cx = rel ? cx + a[4] : a[4]; cy = rel ? cy + a[5] : a[5]; cur.linear = false; }
        else if (u === 'S' || u === 'Q') { cx = rel ? cx + a[2] : a[2]; cy = rel ? cy + a[3] : a[3]; cur.linear = false; }
        else if (u === 'A') { cx = rel ? cx + a[5] : a[5]; cy = rel ? cy + a[6] : a[6]; cur.linear = false; }
        cur.end = [cx, cy];
      }
    }
    closeCur();
    return subs;
  }

  /** 纯直线子路径 → 直接算出顶点（不走 DOM） */
  function linearSubpathPoints(sub) {
    var pts = [[sub.start[0], sub.start[1]]];
    var cx = sub.start[0], cy = sub.start[1];
    for (var i = 1; i < sub.cmds.length; i++) {
      var parts = sub.cmds[i].split(' ');
      var cmd = parts[0], u = cmd.toUpperCase(), rel = (cmd !== u);
      var a = parts.slice(1).map(parseFloat);
      if (u === 'L') { cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1]; }
      else if (u === 'H') { cx = rel ? cx + a[0] : a[0]; }
      else if (u === 'V') { cy = rel ? cy + a[0] : a[0]; }
      else { continue; }
      pts.push([cx, cy]);
    }
    if (sub.closed && pts.length > 2) pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }

  /* ---------------------------------------------------------
   * 离屏测量宿主
   * ------------------------------------------------------- */
  var _host = null, _sampleSvg = null, _samplePath = null, _measureCtx = null;

  function ensureHost() {
    if (_host) return;
    _host = document.createElement('div');
    _host.setAttribute('aria-hidden', 'true');
    _host.setAttribute('style',
      'position:fixed;left:-100000px;top:-100000px;width:0;height:0;' +
      'overflow:hidden;opacity:0;pointer-events:none;');
    document.body.appendChild(_host);

    _sampleSvg = document.createElementNS(SVGNS, 'svg');
    _sampleSvg.setAttribute('xmlns', SVGNS);
    _sampleSvg.setAttribute('width', '100');
    _sampleSvg.setAttribute('height', '100');
    _samplePath = document.createElementNS(SVGNS, 'path');
    _sampleSvg.appendChild(_samplePath);
    _host.appendChild(_sampleSvg);
  }

  function measureText(text, fontSize, family) {
    if (!_measureCtx) {
      var cv = document.createElement('canvas');
      _measureCtx = cv.getContext('2d');
    }
    try {
      _measureCtx.font = '600 ' + fontSize + 'px ' + (family || 'sans-serif');
      return _measureCtx.measureText(text).width;
    } catch (e) { return text.length * fontSize * 0.6; }
  }

  /** 用 DOM 把子路径按弧长重采样成点列 */
  function sampleSubpath(d, step, maxPts, minPts) {
    ensureHost();
    _samplePath.setAttribute('d', d);
    var len;
    try { len = _samplePath.getTotalLength(); } catch (e) { return null; }
    if (!isFinite(len) || len <= 0.0001) return null;
    var n = clamp(Math.ceil(len / step) + 1, minPts || 2, maxPts || 2000);
    var pts = [];
    for (var i = 0; i < n; i++) {
      var p;
      try { p = _samplePath.getPointAtLength(len * i / (n - 1)); } catch (e) { return null; }
      pts.push([p.x, p.y]);
    }
    return pts;
  }

  /* ---------------------------------------------------------
   * 多边形采样（ImageTracer segments → 点列）
   * ------------------------------------------------------- */
  /** 去掉相邻重复点 */
  function dedupePts(pts, tol) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], q = out[out.length - 1];
      if (Math.abs(p[0] - q[0]) > tol || Math.abs(p[1] - q[1]) > tol) out.push(p);
    }
    return out;
  }

  /** Ramer–Douglas–Peucker 轻量抽稀（保形去冗余点） */
  function rdp(pts, eps) {
    if (pts.length < 3 || eps <= 0) return pts;
    var n = pts.length;
    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b - a < 2) continue;
      var ax = pts[a][0], ay = pts[a][1];
      var dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      var len2 = dx * dx + dy * dy;
      var maxD = -1, idx = -1;
      for (var i = a + 1; i < b; i++) {
        var px = pts[i][0] - ax, py = pts[i][1] - ay, d;
        if (len2 < 1e-12) d = Math.hypot(px, py);
        else {
          var t = (px * dx + py * dy) / len2;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          d = Math.hypot(px - t * dx, py - t * dy);
        }
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) { keep[idx] = 1; stack.push([a, idx]); stack.push([idx, b]); }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
    return out;
  }

  /**
   * ImageTracer 的 segments（L / Q）→ 自适应采样点列。
   * Q 段按控制多边形长度细分，保证曲线形状贴合；最后做轻量抽稀。
   */
  function sampleSegments(segs, unit, eps) {
    if (!segs || !segs.length) return null;
    var pts = [[segs[0].x1, segs[0].y1]];
    var step = Math.max(unit, 0.02);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.x3 === undefined) {
        pts.push([s.x2, s.y2]);
      } else {
        var x0 = s.x1, y0 = s.y1, cx = s.x2, cy = s.y2, x1 = s.x3, y1 = s.y3;
        var approx = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(cx - x0, cy - y0);
        var n = Math.max(1, Math.min(32, Math.ceil(approx / step)));
        for (var k = 1; k <= n; k++) {
          var t = k / n, mt = 1 - t;
          pts.push([
            mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
            mt * mt * y0 + 2 * mt * t * cy + t * t * y1
          ]);
        }
      }
    }
    pts = dedupePts(pts, 0.05);
    if (eps > 0) pts = rdp(pts, eps);
    return pts.length >= 3 ? pts : null;
  }

  /* ---------------------------------------------------------
   * 元素工厂
   * ------------------------------------------------------- */
  function baseProps(type, ctx, paint, extra) {
    var el = {
      id: nanoId(12),
      type: type,
      x: 0, y: 0, width: 0, height: 0,
      angle: 0,
      strokeColor: paint.strokeColor,
      backgroundColor: paint.backgroundColor,
      fillStyle: paint.fillStyle,
      strokeWidth: paint.strokeWidth,
      strokeStyle: 'solid',
      roughness: paint.roughness,
      opacity: paint.opacity,
      groupIds: ctx.groupStack.slice().reverse(),
      frameId: null,
      roundness: null,
      seed: rnd(),
      version: 1,
      versionNonce: rnd(),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      index: nextIndex()
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) el[k] = extra[k];
    return el;
  }

  function makeLinear(absPts, closed, paint, ctx, extra) {
    if (!absPts || absPts.length < 2) return null;
    var pts = [], i, p, last;
    for (i = 0; i < absPts.length; i++) {
      p = absPts[i]; last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-4 || Math.abs(last[1] - p[1]) > 1e-4) pts.push(p);
    }
    if (pts.length < 2) return null;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    var w = maxX - minX, h = maxY - minY;
    if (w < 0.01 && h < 0.01) return null;

    var rel = new Array(pts.length);
    var rw = 0, rh = 0;
    for (i = 0; i < pts.length; i++) {
      var rx = r2(pts[i][0] - minX), ry = r2(pts[i][1] - minY);
      rel[i] = [rx, ry];
      if (rx > rw) rw = rx;
      if (ry > rh) rh = ry;
    }

    var extraProps = {
      points: rel,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      polygon: !!closed
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) extraProps[k] = extra[k];

    var el = baseProps('line', ctx, paint, extraProps);
    el.x = r2(minX);
    el.y = r2(minY);
    el.width = rw;
    el.height = rh;
    return el;
  }

  /* 面积度量：用于 maxElements 裁剪 */
  function sizeMetric(el) {
    if (el.type === 'line') {
      var filled = el.backgroundColor && el.backgroundColor !== 'transparent';
      return filled ? Math.max(1, el.width * el.height) : Math.max(el.width, el.height);
    }
    return Math.max(1, el.width * el.height);
  }

  function commonBounds(elements) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.x < minX) minX = el.x;
      if (el.y < minY) minY = el.y;
      if (el.x + el.width > maxX) maxX = el.x + el.width;
      if (el.y + el.height > maxY) maxY = el.y + el.height;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
  }

  /* ---------------------------------------------------------
   * 样式解析
   * ------------------------------------------------------- */
  function cssGet(cs, prop) {
    if (!cs) return '';
    var v = cs.getPropertyValue(prop);
    return v ? String(v).trim() : '';
  }

  function findById(root, id) {
    var list = root.querySelectorAll('[id]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('id') === id) return list[i];
    }
    return null;
  }

  /** 解析 fill="url(#grad)" 这类引用，取一个代表性颜色 */
  function resolvePaintRef(value, root, warnings) {
    var m = String(value).match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
    if (!m) return null;
    var target = findById(root, m[1]);
    if (!target) return null;
    var tag = target.nodeName.toLowerCase();
    if (tag === 'lineargradient' || tag === 'radialgradient') {
      var stops = target.querySelectorAll('stop');
      var acc = { r: 0, g: 0, b: 0, n: 0 };
      for (var i = 0; i < stops.length; i++) {
        var sc = stops[i].getAttribute('stop-color') ||
                 (stops[i].style && stops[i].style.stopColor) || '';
        var hex = toHex(sc);
        var rgb = hexToRgb(hex);
        if (rgb) { acc.r += rgb.r; acc.g += rgb.g; acc.b += rgb.b; acc.n++; }
      }
      if (acc.n) {
        if (warnings) warnings.push('渐变被近似为纯色');
        return rgbToHex(acc.r / acc.n, acc.g / acc.n, acc.b / acc.n);
      }
    }
    return null;
  }

  function parsePaint(node, cs, root, ctx, warnings, alpha) {
    var o = ctx.opts;
    if (alpha === undefined || !isFinite(alpha)) alpha = 1;

    var fillRaw = cssGet(cs, 'fill');
    var strokeRaw = cssGet(cs, 'stroke');

    var fill = toHex(fillRaw);
    if (!fill && fillRaw && fillRaw.indexOf('url(') === 0) {
      fill = resolvePaintRef(fillRaw, root, warnings) || '#cccccc';
    }
    var stroke = toHex(strokeRaw);
    if (!stroke && strokeRaw && strokeRaw.indexOf('url(') === 0) {
      stroke = resolvePaintRef(strokeRaw, root, warnings) || '#999999';
    }

    var fillOpacity = parseFloat(cssGet(cs, 'fill-opacity'));
    if (!isFinite(fillOpacity)) fillOpacity = 1;
    var strokeOpacity = parseFloat(cssGet(cs, 'stroke-opacity'));
    if (!isFinite(strokeOpacity)) strokeOpacity = 1;

    var svgStrokeWidth = parseFloat(cssGet(cs, 'stroke-width'));
    if (!isFinite(svgStrokeWidth) || svgStrokeWidth <= 0) svgStrokeWidth = 1;

    var mode = o.styleMode;
    var strokeColor, backgroundColor, fillStyle;

    if (mode === 'stroke') {
      strokeColor = o.monochrome || stroke || fill || '#1e1e1e';
      backgroundColor = 'transparent';
      fillStyle = 'solid';
    } else if (mode === 'both') {
      strokeColor = o.monochrome || '#1e1e1e';
      backgroundColor = fill || 'transparent';
      fillStyle = o.fillStyle;
    } else { // fill
      strokeColor = o.fillStyle === 'solid' ? (fill || '#ffffff') : 'transparent';
      backgroundColor = fill || 'transparent';
      fillStyle = o.fillStyle;
    }

    if (o.monochrome && mode === 'fill' && o.monochromeFill) backgroundColor = o.monochrome;

    var effAlpha;
    if (mode === 'stroke') effAlpha = strokeOpacity;
    else if (mode === 'both') effAlpha = Math.min(fillOpacity, strokeOpacity);
    else effAlpha = fillOpacity;

    var opacity = clamp(Math.round(o.opacity * alpha * effAlpha * 100), 1, 100);

    // 色块模式下描边只是用来补色缝，保持最细
    var strokeW = (mode === 'fill') ? 1 : o.strokeWidth;

    return {
      strokeColor: strokeColor,
      backgroundColor: backgroundColor,
      fillStyle: fillStyle,
      strokeWidth: strokeW,
      roughness: o.roughness,
      opacity: opacity,
      hasFill: backgroundColor !== 'transparent',
      hasStroke: strokeColor !== 'transparent',
      svgStrokeWidth: svgStrokeWidth
    };
  }

  function safeStyle(node) {
    try { return global.getComputedStyle(node); } catch (e) { return null; }
  }

  function num(node, attr, dflt) {
    var v = node.getAttribute(attr);
    if (v === null || v === '') return dflt;
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------------------------------------------------
   * 遍历
   * ------------------------------------------------------- */
  function traverse(node, matrix, ctx) {
    if (!node || node.nodeType !== 1) return;
    if (ctx.depth++ > 200) { ctx.depth--; return; }
    try { traverseInner(node, matrix, ctx); }
    finally { ctx.depth--; }
  }

  function traverseInner(node, matrix, ctx) {
    var tag = node.nodeName.toLowerCase();
    if (SKIP_TAGS[tag]) return;

    var o = ctx.opts;

    var styleTransform = (node.style && node.style.transform) ? node.style.transform : '';
    var attrTransform = node.getAttribute('transform') || '';
    var m = M.mul(matrix, parseTransform(styleTransform || attrTransform));

    var cs = safeStyle(node);
    var nodeAlpha = parseFloat(cssGet(cs, 'opacity'));
    if (!isFinite(nodeAlpha)) nodeAlpha = 1;
    var alpha = ctx.alpha * nodeAlpha;

    if (tag === 'use') { emitUse(node, m, alpha, ctx); return; }

    if (tag === 'svg') {
      var sx = num(node, 'x', 0), sy = num(node, 'y', 0);
      if (sx || sy) m = M.mul(m, M.translate(sx, sy));
      var savedSvgAlpha = ctx.alpha; ctx.alpha = alpha;
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) traverse(kids[i], m, ctx);
      ctx.alpha = savedSvgAlpha;
      return;
    }

    if (tag === 'g' || tag === 'a') {
      var gid = null;
      if (o.grouping) { gid = nanoId(10); ctx.groupStack.push(gid); }
      var before = ctx.elements.length;
      var savedAlpha = ctx.alpha; ctx.alpha = alpha;
      var cn = node.childNodes;
      for (var j = 0; j < cn.length; j++) traverse(cn[j], m, ctx);
      ctx.alpha = savedAlpha;
      if (gid) {
        ctx.groupStack.pop();
        var produced = ctx.elements.length - before;
        if (produced < 2) {
          for (var k = before; k < ctx.elements.length; k++) {
            var gi = ctx.elements[k].groupIds.indexOf(gid);
            if (gi >= 0) ctx.elements[k].groupIds.splice(gi, 1);
          }
        }
      }
      return;
    }

    var paint = parsePaint(node, cs, ctx.root, ctx, ctx.warnings, alpha);

    if (tag === 'text') { emitText(node, m, ctx, cs, paint); return; }
    if (tag === 'image') { ctx.warnings.push('<image> 位图元素不支持，已跳过'); return; }
    if (tag === 'line' || tag === 'polyline' || tag === 'polygon') {
      emitPoly(node, tag, m, ctx, paint);
      return;
    }
    if (tag === 'rect' || tag === 'circle' || tag === 'ellipse') {
      emitBoxy(node, tag, m, ctx, paint);
      return;
    }
    if (tag === 'path') { emitPath(node, m, ctx, paint); return; }

    // 未知容器：继续往下走
    var gc = node.childNodes;
    for (var q = 0; q < gc.length; q++) traverse(gc[q], m, ctx);
  }

  function emitUse(node, matrix, alpha, ctx) {
    var href = node.getAttribute('href') || node.getAttributeNS(XLINK, 'href') ||
               node.getAttribute('xlink:href') || '';
    if (!href || href.charAt(0) !== '#') return;
    var id = href.slice(1);
    if (ctx.useStack.indexOf(id) >= 0) return;
    var target = findById(ctx.root, id);
    if (!target) return;
    var x = num(node, 'x', 0), y = num(node, 'y', 0);
    var m = M.mul(matrix, M.translate(x, y));
    ctx.useStack.push(id);
    var savedAlpha = ctx.alpha; ctx.alpha = alpha;
    var clone = target.cloneNode(true);
    clone.removeAttribute('id');
    var kids = clone.childNodes;
    for (var i = 0; i < kids.length; i++) traverse(kids[i], m, ctx);
    ctx.alpha = savedAlpha;
    ctx.useStack.pop();
  }

  function emitPoly(node, tag, m, ctx, paint) {
    var pts = [], raw = node.getAttribute('points') || '';
    var nums = raw.split(/[\s,]+/).filter(function (t) { return t !== ''; }).map(parseFloat);
    for (var i = 0; i + 1 < nums.length; i += 2) {
      if (isFinite(nums[i]) && isFinite(nums[i + 1])) pts.push([nums[i], nums[i + 1]]);
    }
    if (tag === 'line') {
      pts = [[num(node, 'x1', 0), num(node, 'y1', 0)], [num(node, 'x2', 0), num(node, 'y2', 0)]];
    }
    if (pts.length < 2) return;

    var abs = pts.map(function (p) { return M.apply(m, p); });
    var closed = tag === 'polygon';
    var isArea = closed && paint.hasFill;

    var el = makeLinear(abs, closed, {
      strokeColor: isArea && !paint.hasStroke ? 'transparent' : paint.strokeColor,
      backgroundColor: isArea ? paint.backgroundColor : 'transparent',
      fillStyle: paint.fillStyle,
      strokeWidth: paint.strokeWidth,
      roughness: paint.roughness,
      opacity: paint.opacity
    }, ctx);
    if (el) ctx.elements.push(el);
  }

  function emitBoxy(node, tag, m, ctx, paint) {
    var o = ctx.opts;

    if (tag === 'rect') {
      var x = num(node, 'x', 0), y = num(node, 'y', 0);
      var w = num(node, 'width', 0), h = num(node, 'height', 0);
      if (w <= 0 || h <= 0) return;
      if (M.isAxisAligned(m)) {
        var p0 = M.apply(m, [x, y]), p1 = M.apply(m, [x + w, y + h]);
        var rx = Math.min(p0[0], p1[0]), ry = Math.min(p0[1], p1[1]);
        var rw = Math.abs(p1[0] - p0[0]), rh = Math.abs(p1[1] - p0[1]);
        var corner = num(node, 'rx', NaN);
        if (!isFinite(corner)) corner = num(node, 'ry', 0);
        var el = baseProps('rectangle', ctx, paint, {
          roundness: corner > 0 ? { type: 3 } : null
        });
        el.x = r2(rx); el.y = r2(ry); el.width = r2(rw); el.height = r2(rh);
        if (corner > 0 && Math.abs(rw - rh) > 0.5) el.roundness = { type: 3 };
        ctx.elements.push(el);
        return;
      }
      // 旋转 / 斜切 → 退化成多边形
      var d = 'M ' + x + ' ' + y + ' H ' + (x + w) + ' V ' + (y + h) + ' H ' + x + ' Z';
      emitPathFromData(d, m, ctx, paint);
      return;
    }

    var cx = num(node, 'cx', 0), cy = num(node, 'cy', 0);
    var rx2, ry2;
    if (tag === 'circle') { rx2 = ry2 = num(node, 'r', 0); }
    else { rx2 = num(node, 'rx', 0); ry2 = num(node, 'ry', 0); }
    if (rx2 <= 0 || ry2 <= 0) return;

    if (M.isAxisAligned(m)) {
      var c = M.apply(m, [cx, cy]);
      var scaleX = Math.abs(m[0]), scaleY = Math.abs(m[3]);
      var w2 = rx2 * scaleX * 2, h2 = ry2 * scaleY * 2;
      if (w2 < 0.01 || h2 < 0.01) return;
      var el2 = baseProps('ellipse', ctx, paint);
      el2.x = r2(c[0] - w2 / 2);
      el2.y = r2(c[1] - h2 / 2);
      el2.width = r2(w2);
      el2.height = r2(h2);
      ctx.elements.push(el2);
      return;
    }

    var d2 = tag === 'circle'
      ? circlePathData(cx, cy, rx2)
      : ellipsePathData(cx, cy, rx2, ry2);
    emitPathFromData(d2, m, ctx, paint);
  }

  function circlePathData(cx, cy, r) {
    return 'M ' + (cx - r) + ' ' + cy +
           ' a ' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0' +
           ' a ' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0 Z';
  }
  function ellipsePathData(cx, cy, rx, ry) {
    return 'M ' + (cx - rx) + ' ' + cy +
           ' a ' + rx + ' ' + ry + ' 0 1 0 ' + (2 * rx) + ' 0' +
           ' a ' + rx + ' ' + ry + ' 0 1 0 ' + (-2 * rx) + ' 0 Z';
  }

  function emitPath(node, m, ctx, paint) {
    var d = node.getAttribute('d') || '';
    if (!d.trim()) return;
    emitPathFromData(d, m, ctx, paint);
  }

  function emitPathFromData(d, m, ctx, paint) {
    var o = ctx.opts;
    var cmds;
    try { cmds = parsePathData(d); } catch (e) { return; }
    if (!cmds.length) return;
    var subs = splitSubpaths(cmds);

    // 自动采样步长：以画布尺度为准
    var unit = ctx.unit;

    for (var i = 0; i < subs.length; i++) {
      var sub = subs[i];
      var localPts;

      if (sub.linear) {
        localPts = linearSubpathPoints(sub);
      } else {
        localPts = sampleSubpath(sub.cmds.join(' '), unit, 2000, 4);
        if (!localPts) continue;
        if (sub.closed && localPts.length > 2) {
          var f = localPts[0], l = localPts[localPts.length - 1];
          if (Math.abs(f[0] - l[0]) > 1e-3 || Math.abs(f[1] - l[1]) > 1e-3) {
            localPts.push([f[0], f[1]]);
          }
        }
      }
      if (!localPts || localPts.length < 2) continue;

      // 最小尺寸过滤
      if (o.minSize > 0) {
        var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (var q = 0; q < localPts.length; q++) {
          var lp = localPts[q];
          if (lp[0] < mnx) mnx = lp[0];
          if (lp[0] > mxx) mxx = lp[0];
          if (lp[1] < mny) mny = lp[1];
          if (lp[1] > mxy) mxy = lp[1];
        }
        if (Math.max(mxx - mnx, mxy - mny) < o.minSize) continue;
      }

      var abs = new Array(localPts.length);
      for (var j = 0; j < localPts.length; j++) abs[j] = M.apply(m, localPts[j]);

      // 面积块：闭合 + 有填充 → polygon，描边透明
      var treatAsArea = sub.closed && paint.hasFill;
      if (treatAsArea && abs.length > 2) {
        var a0 = abs[0], an = abs[abs.length - 1];
        if (Math.abs(a0[0] - an[0]) > 1e-3 || Math.abs(a0[1] - an[1]) > 1e-3) abs.push([a0[0], a0[1]]);
      }

      var style = treatAsArea
        ? {
            strokeColor: paint.hasStroke ? paint.strokeColor : 'transparent',
            backgroundColor: paint.backgroundColor,
            fillStyle: paint.fillStyle,
            strokeWidth: paint.strokeWidth,
            roughness: paint.roughness,
            opacity: paint.opacity
          }
        : {
            strokeColor: paint.hasStroke ? paint.strokeColor : (paint.hasFill ? paint.backgroundColor : '#1e1e1e'),
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: paint.strokeWidth,
            roughness: paint.roughness,
            opacity: paint.opacity
          };

      var el = makeLinear(abs, treatAsArea, style, ctx);
      if (el) ctx.elements.push(el);
    }
  }

  function emitText(node, m, ctx, cs, paint) {
    var o = ctx.opts;
    var text = (node.textContent || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    if (!text) return;

    var fontSizeSvg = parseFloat(cssGet(cs, 'font-size'));
    if (!isFinite(fontSizeSvg) || fontSizeSvg <= 0) fontSizeSvg = 16;
    var family = cssGet(cs, 'font-family') || 'sans-serif';
    var anchor = cssGet(cs, 'text-anchor') || 'start';
    var baseline = (cssGet(cs, 'dominant-baseline') || cssGet(cs, 'alignment-baseline') || 'auto').toLowerCase();

    var sx = Math.hypot(m[0], m[1]);
    var sy = Math.hypot(m[2], m[3]);
    var scale = (sx + sy) / 2 || 1;
    var fontSize = Math.max(6, Math.round(fontSizeSvg * scale));

    var lines = text.split('\n');
    var widest = 0;
    for (var i = 0; i < lines.length; i++) {
      widest = Math.max(widest, measureText(lines[i], fontSizeSvg, family));
    }
    var blockW = widest * scale;
    var blockH = lines.length * fontSizeSvg * 1.25 * scale;

    var ax = num(node, 'x', 0), ay = num(node, 'y', 0);
    var anchorOffset = anchor === 'middle' ? -widest / 2 : (anchor === 'end' ? -widest : 0);
    var baseOffset;
    if (baseline === 'middle' || baseline === 'central') baseOffset = -fontSizeSvg * 0.35;
    else if (baseline === 'hanging' || baseline === 'text-before-edge') baseOffset = 0;
    else if (baseline === 'text-after-edge') baseOffset = -fontSizeSvg * 0.85;
    else baseOffset = -fontSizeSvg * 0.8;

    var origin = M.apply(m, [ax + anchorOffset, ay + baseOffset]);

    var flat = rgbToHex.apply(null, (function () {
      var h = hexToRgb(paint.strokeColor !== 'transparent' ? paint.strokeColor : '#1e1e1e') || { r: 30, g: 30, b: 30 };
      return [h.r, h.g, h.b];
    })());

    var famLower = family.toLowerCase();
    var fontFamily = 1;
    if (famLower.indexOf('mono') >= 0 || famLower.indexOf('courier') >= 0 || famLower.indexOf('consol') >= 0) fontFamily = 3;
    else if (famLower.indexOf('sans') >= 0 || famLower.indexOf('arial') >= 0 ||
             famLower.indexOf('helvet') >= 0 || famLower.indexOf('roboto') >= 0 ||
             famLower.indexOf('segoe') >= 0 || famLower.indexOf('pingfang') >= 0) fontFamily = 2;

    var angle = Math.atan2(m[1], m[0]);

    var el = baseProps('text', ctx, {
      strokeColor: flat,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: paint.strokeWidth,
      roughness: paint.roughness,
      opacity: paint.opacity
    }, {
      x: r2(origin[0]),
      y: r2(origin[1]),
      width: r2(blockW),
      height: r2(blockH),
      angle: angle,
      fontSize: fontSize,
      fontFamily: fontFamily,
      text: text,
      originalText: text,
      textAlign: anchor === 'middle' ? 'center' : (anchor === 'end' ? 'right' : 'left'),
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25
    });
    ctx.elements.push(el);
  }

  /* ---------------------------------------------------------
   * 元素收尾：过滤 / 裁剪 / 缩放 / 原点归零
   * ------------------------------------------------------- */
  function finalizeElements(elements, opts, warnings) {
    var kept = elements.filter(function (el) {
      return el && el.width >= 0 && el.height >= 0 && (el.width > 0.02 || el.height > 0.02);
    });

    var truncated = 0;
    if (opts.maxElements > 0 && kept.length > opts.maxElements) {
      var scored = kept.map(function (el, i) { return { i: i, m: sizeMetric(el) }; });
      scored.sort(function (a, b) { return b.m - a.m; });
      var keepIdx = {};
      for (var s = 0; s < opts.maxElements; s++) keepIdx[scored[s].i] = 1;
      var out = [];
      for (var t = 0; t < kept.length; t++) if (keepIdx[t]) out.push(kept[t]);
      truncated = kept.length - out.length;
      kept = out;
    }
    if (truncated > 0) {
      warnings.push('超出元素上限，已丢弃 ' + truncated + ' 个最小图形');
    }

    var sc = opts.scale;
    if (sc && sc !== 1) {
      for (var k = 0; k < kept.length; k++) {
        var e2 = kept[k];
        e2.x *= sc; e2.y *= sc;
        e2.width *= sc; e2.height *= sc;
        if (e2.type === 'line') {
          for (var pi = 0; pi < e2.points.length; pi++) {
            e2.points[pi][0] *= sc;
            e2.points[pi][1] *= sc;
          }
        }
        if (e2.type === 'text') { e2.fontSize = Math.max(6, Math.round(e2.fontSize * sc)); }
      }
    }

    var b = commonBounds(kept);
    var ox = Math.round(b.minX * 100) / 100;
    var oy = Math.round(b.minY * 100) / 100;
    for (var n2 = 0; n2 < kept.length; n2++) {
      kept[n2].x = r2(kept[n2].x - ox);
      kept[n2].y = r2(kept[n2].y - oy);
    }

    kept = kept.filter(function (el) {
      if (el.type === 'text') return true;
      return el.backgroundColor !== 'transparent' || el.strokeColor !== 'transparent';
    });
    return kept;
  }

  /* ---------------------------------------------------------
   * 形状（带孔洞感知的已采样多边形）→ Excalidraw 元素
   * shape: { color:'#rrggbb', pts:[[x,y]...] }
   * ------------------------------------------------------- */
  function shapesToElements(shapes, options) {
    var opts = {};
    for (var dk in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, dk)) opts[dk] = DEFAULTS[dk];
    if (options) for (var ok in options) if (Object.prototype.hasOwnProperty.call(options, ok)) opts[ok] = options[ok];

    resetCounter();
    var warnings = [];
    var elements = [];
    var ctx = { groupStack: [], opts: opts };

    // 按颜色分组（同色元素归为一组，方便整体选中/改色）
    var groupOf = {}, groupCount = {}, groupOrder = [];
    if (opts.grouping) {
      for (var g = 0; g < shapes.length; g++) {
        var c = shapes[g] && shapes[g].color;
        if (!c) continue;
        if (!groupOf[c]) { groupOf[c] = nanoId(10); groupOrder.push(c); groupCount[c] = 0; }
        groupCount[c]++;
      }
    }

    for (var i = 0; i < shapes.length; i++) {
      var sh = shapes[i];
      if (!sh || !sh.pts || sh.pts.length < 3) continue;
      var color = sh.color || '#1e1e1e';
      var op = clamp(Math.round(opts.opacity * 100), 1, 100);
      var paint;

      if (opts.styleMode === 'stroke') {
        paint = {
          strokeColor: opts.monochrome || color, backgroundColor: 'transparent',
          fillStyle: 'solid', strokeWidth: opts.strokeWidth,
          roughness: opts.roughness, opacity: op
        };
      } else if (opts.styleMode === 'both') {
        paint = {
          strokeColor: opts.monochrome || '#1e1e1e', backgroundColor: color,
          fillStyle: opts.fillStyle, strokeWidth: opts.strokeWidth,
          roughness: opts.roughness, opacity: op
        };
      } else {
        // 实心色块：同色细描边用于弥合相邻色块之间的缝
        paint = {
          strokeColor: opts.fillStyle === 'solid' ? color : 'transparent',
          backgroundColor: color, fillStyle: opts.fillStyle,
          strokeWidth: 1, roughness: opts.roughness, opacity: op
        };
      }

      var el = makeLinear(sh.pts, true, paint, ctx);
      if (!el) continue;
      if (opts.grouping && groupCount[color] >= 2) el.groupIds = [groupOf[color]];
      elements.push(el);
    }

    elements = finalizeElements(elements, opts, warnings);
    return { elements: elements, warnings: dedupe(warnings) };
  }

  /** 形状 → SVG 字符串（与元素完全同源，用作"矢量图"视图与下载） */
  function shapesToSvg(shapes, w, h) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
            '" viewBox="0 0 ' + w + ' ' + h + '" shape-rendering="geometricPrecision">';
    for (var i = 0; i < shapes.length; i++) {
      var sh = shapes[i];
      if (!sh || !sh.pts || sh.pts.length < 3) continue;
      var d = 'M ' + r2(sh.pts[0][0]) + ' ' + r2(sh.pts[0][1]);
      for (var j = 1; j < sh.pts.length; j++) {
        d += ' L ' + r2(sh.pts[j][0]) + ' ' + r2(sh.pts[j][1]);
      }
      d += ' Z';
      s += '<path fill="' + (sh.color || '#1e1e1e') + '" d="' + d + '"/>';
    }
    return s + '</svg>';
  }

  /* ---------------------------------------------------------
   * 标签图区域边界追踪（有向边拼接，interior-on-left 约定）
   *
   * labels: Int32Array(w*h)，任意整型标签（不同标签即不同区域）
   * 返回:  [{ label, pts:[[x,y]...], hole:bool, area }]
   *   - pts 为像素角点坐标（相邻区域共享边界，铺贴无缝）
   *   - 外圈 wound 负（shoelace，y 向下坐标系），孔洞为正
   *   - area = |shoelace| / 2（px²）
   * ------------------------------------------------------- */
  function traceRegions(labels, w, h, minArea) {
    var W1 = w + 1;
    var NP = w * h;

    /* pass 1：统计有向边界边总数 */
    var count = 0;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var L = labels[row + x];
        if (x + 1 >= w || labels[row + x + 1] !== L) count++;
        if (x === 0 || labels[row + x - 1] !== L) count++;
        if (y + 1 >= h || labels[row + x + w] !== L) count++;
        if (y === 0 || labels[row + x - w] !== L) count++;
      }
    }

    var ES = new Int32Array(count);
    var ET = new Int32Array(count);
    var EL = new Int32Array(count);
    var e = 0;

    /* pass 2：生成有向边（区域内部在行进方向左侧） */
    for (var y2 = 0; y2 < h; y2++) {
      var row2 = y2 * w;
      for (var x2 = 0; x2 < w; x2++) {
        var L2 = labels[row2 + x2];
        if (x2 + 1 >= w || labels[row2 + x2 + 1] !== L2) {   // 右邻异色 → 沿竖边向上
          ES[e] = (y2 + 1) * W1 + x2 + 1; ET[e] = y2 * W1 + x2 + 1; EL[e++] = L2;
        }
        if (x2 === 0 || labels[row2 + x2 - 1] !== L2) {      // 左邻异色 → 沿竖边向下
          ES[e] = y2 * W1 + x2; ET[e] = (y2 + 1) * W1 + x2; EL[e++] = L2;
        }
        if (y2 + 1 >= h || labels[row2 + x2 + w] !== L2) {   // 下邻异色 → 沿横边向右
          ES[e] = (y2 + 1) * W1 + x2; ET[e] = (y2 + 1) * W1 + x2 + 1; EL[e++] = L2;
        }
        if (y2 === 0 || labels[row2 + x2 - w] !== L2) {      // 上邻异色 → 沿横边向左
          ES[e] = y2 * W1 + x2 + 1; ET[e] = y2 * W1 + x2; EL[e++] = L2;
        }
      }
    }

    /* CSR：起点顶点 → 出边表 */
    var NV = W1 * (h + 1);
    var off = new Int32Array(NV + 1);
    for (var i = 0; i < count; i++) off[ES[i] + 1]++;
    for (var v = 0; v < NV; v++) off[v + 1] += off[v];
    var fillPos = off.slice(0, NV);
    var outT = new Int32Array(count);
    var outE = new Int32Array(count);
    for (var i2 = 0; i2 < count; i2++) {
      var sv = ES[i2];
      var slot = fillPos[sv]++;
      outT[slot] = ET[i2];
      outE[slot] = i2;
    }
    var used = new Uint8Array(count);
    /* 方向编号（y 向下屏幕坐标，顺时针环序）：E=0, S=1, W=2, N=3 */
    function dirIdx(dx, dy) {
      return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
    }

    var loops = [];
    for (var v2 = 0; v2 < NV; v2++) {
      var start = off[v2], end = off[v2 + 1];
      for (var si = start; si < end; si++) {
        if (used[outE[si]]) continue;

        /* 沿出边走一整圈：只走同标签的边，内域恒在左侧 */
        var lbl = EL[outE[si]];
        var flat = [v2 % W1, (v2 / W1) | 0];
        var area2 = 0;
        var px = flat[0], py = flat[1];
        var slot2 = si;
        var guard = count + 1;
        var closed = false;

        while (guard-- > 0) {
          used[outE[slot2]] = 1;
          var nv = outT[slot2];
          if (nv === v2) { closed = true; break; }
          var nx = nv % W1, ny = (nv / W1) | 0;
          area2 += px * ny - nx * py;
          flat.push(nx, ny);
          var dIn = dirIdx(nx - px, ny - py);
          px = nx; py = ny;

          /* 从「反向入边方向」开始按顺时针环序扫描，
             选第一条同标签的未用出边（4-连通区域 / 8-连通孔洞约定） */
          var r0 = (dIn + 2) % 4;
          var found = -1;
          for (var k = 0; k < 4 && found < 0; k++) {
            var want = (r0 + k) % 4;
            for (var q = off[nv]; q < off[nv + 1]; q++) {
              if (used[outE[q]] || EL[outE[q]] !== lbl) continue;
              var t2 = outT[q];
              if (dirIdx(t2 % W1 - nx, ((t2 / W1) | 0) - ny) === want) { found = q; break; }
            }
          }
          if (found < 0) break;
          slot2 = found;
        }
        if (!closed) continue;   // 走不闭合的残环直接丢弃

        /* 闭合项 */
        area2 += px * flat[1] - flat[0] * py;

        var nPts = flat.length / 2;
        var area = Math.abs(area2) / 2;
        if (nPts < 3 || area < minArea) continue;
        if (Math.abs(area2) < 1e-9) continue;

        var pts = new Array(nPts);
        for (var p3 = 0; p3 < nPts; p3++) pts[p3] = [flat[p3 * 2], flat[p3 * 2 + 1]];
        loops.push({
          label: EL[outE[si]],
          pts: pts,
          hole: area2 > 0,
          area: area
        });
      }
    }
    return loops;
  }

  /* ---------------------------------------------------------
   * 主入口
   * ------------------------------------------------------- */
  var DEFAULTS = {
    styleMode: 'fill',        // fill | both | stroke
    fillStyle: 'solid',       // solid | hachure | cross-hatch | zigzag
    roughness: 1,
    strokeWidth: 2,
    opacity: 1,               // 0~1
    scale: 1,
    maxElements: 3000,
    grouping: true,
    minSize: 0,
    monochrome: null,         // 强制统一描边色
    curveDetail: 5            // 1~10
  };

  function parseSvgLength(str, fallback) {
    if (!str) return fallback;
    var v = parseFloat(str);
    return isFinite(v) && v > 0 ? v : fallback;
  }

  /**
   * SVG 字符串 → Excalidraw 元素数组
   * @returns {{elements:Array, warnings:Array, svgSize:{width:number,height:number}}}
   */
  function svgToElements(svgString, options) {
    var opts = {};
    for (var dk in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, dk)) opts[dk] = DEFAULTS[dk];
    if (options) for (var ok in options) if (Object.prototype.hasOwnProperty.call(options, ok)) opts[ok] = options[ok];

    resetCounter();
    ensureHost();

    var doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    var perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) throw new Error('SVG 解析失败，文件可能已损坏或不是合法 SVG。');
    var root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('文件根节点不是 <svg>。');

    var live = document.importNode(root, true);
    _host.appendChild(live);

    var warnings = [];
    var elements = [];

    try {
      // 估算画布尺度 → 采样步长
      var vb = (live.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
      var canvasW = 0, canvasH = 0;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { canvasW = vb[2]; canvasH = vb[3]; }
      else {
        canvasW = parseSvgLength(live.getAttribute('width'), 0);
        canvasH = parseSvgLength(live.getAttribute('height'), 0);
      }
      if (!canvasW || !canvasH) {
        var bb = null;
        try { bb = live.getBBox(); } catch (e) { bb = null; }
        if (bb && bb.width > 0 && bb.height > 0) { canvasW = bb.width; canvasH = bb.height; }
        else { canvasW = canvasH = 400; }
      }
      var maxDim = Math.max(canvasW, canvasH);
      var detail = clamp(opts.curveDetail, 1, 10);
      var unit = Math.max(maxDim / (150 + detail * 60), 0.02);

      var ctx = {
        opts: opts,
        elements: elements,
        warnings: warnings,
        groupStack: [],
        useStack: [],
        alpha: 1,
        root: live,
        depth: 0,
        unit: unit
      };

      var kids = live.childNodes;
      for (var i = 0; i < kids.length; i++) traverse(kids[i], M.identity(), ctx);

      elements = finalizeElements(elements, opts, warnings);

      return {
        elements: elements,
        warnings: dedupe(warnings),
        svgSize: { width: canvasW, height: canvasH }
      };
    } finally {
      if (live.parentNode === _host) _host.removeChild(live);
    }
  }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  /** 生成 .excalidraw 文件对象 */
  function buildFile(elements, appState) {
    return {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: elements,
      appState: Object.assign({
        gridSize: null,
        viewBackgroundColor: '#ffffff'
      }, appState || {}),
      files: {}
    };
  }

  /** 生成剪贴板格式（可直接 Ctrl+V 粘进 Excalidraw） */
  function buildClipboard(elements) {
    return {
      type: 'excalidraw/clipboard',
      elements: elements,
      files: {}
    };
  }

  global.ExcalidrawCore = {
    svgToElements: svgToElements,
    shapesToElements: shapesToElements,
    shapesToSvg: shapesToSvg,
    sampleSegments: sampleSegments,
    rdp: rdp,
    traceRegions: traceRegions,
    buildFile: buildFile,
    buildClipboard: buildClipboard,
    commonBounds: commonBounds,
    toHex: toHex,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    DEFAULTS: DEFAULTS
  };

})(window);
