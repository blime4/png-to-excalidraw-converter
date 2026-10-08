/* =========================================================
 * app.js — PNG → Excalidraw 转换器 主流程
 * ========================================================= */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* 保真度档位：一次控制两段转换的精度取舍 */
  var FIDELITY = {
    exact: {
      label: '极致还原', dim: 2400, detail: 8, blur: 0, pathomit: 0,
      cycles: 8, roughness: 0, mergeDist: 26, bgDist: 26, rightAngle: false,
      hint: '尽量贴合原图：高分辨率处理、无降噪、无手绘抖动。元素较多，适合 logo、图标、UI 截图。'
    },
    high: {
      label: '高保真', dim: 2000, detail: 7, blur: 0, pathomit: 2,
      cycles: 6, roughness: 0, mergeDist: 32, bgDist: 30, rightAngle: false,
      hint: '保真与体积的平衡，适合大多数素材（默认）。'
    },
    balanced: {
      label: '均衡', dim: 1400, detail: 5, blur: 1, pathomit: 6,
      cycles: 4, roughness: 1, mergeDist: 42, bgDist: 34, rightAngle: false,
      hint: '更快、元素更少，允许轻微简化。'
    },
    sketch: {
      label: '手绘感', dim: 1100, detail: 4, blur: 2, pathomit: 12,
      cycles: 3, roughness: 2, mergeDist: 50, bgDist: 40, rightAngle: true,
      hint: '手绘感优先：边缘更粗、圆角强化，最有 Excalidraw 味道。'
    }
  };

  var state = {
    sourceName: 'drawing',
    sourceMeta: '',
    isSvg: false,
    dataUrl: '',
    svgText: '',
    imageData: null,
    imgW: 0, imgH: 0,
    tracedSvg: '',
    tracedInfo: { paths: 0, colors: 0 },
    elements: [],
    fileJson: '',
    warnings: [],
    lastMs: 0,
    bgTouched: false,
    running: false,
    view: 'original',
    zoom: 1
  };

  /* ---------------------------------------------------------
   * 通用 UI 辅助
   * ------------------------------------------------------- */
  var overlay = $('#overlay');
  var overlayText = $('#overlayText');
  var overlayBar = $('#overlayBar');
  var statMsg = $('#statMsg');

  function nextPaint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { requestAnimationFrame(r); });
    });
  }

  function showOverlay(text, pct) {
    overlay.classList.remove('is-hidden');
    overlayText.textContent = text || '正在处理…';
    overlayBar.style.width = (pct === undefined ? 8 : pct) + '%';
  }
  function hideOverlay() { overlay.classList.add('is-hidden'); }

  var toastEl = null, toastTimer = null;
  function toast(msg, isErr) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isErr ? ' is-err' : '');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-show'); }, 2400);
  }

  function setMsg(msg, kind) {
    statMsg.textContent = msg;
    statMsg.className = 'stat-msg' + (kind ? ' is-' + kind : '');
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* ---------------------------------------------------------
   * 分段控件
   * ------------------------------------------------------- */
  function initSegmented(el) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-value]');
      if (!btn || !el.contains(btn)) return;
      $$('button', el).forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      el.dispatchEvent(new CustomEvent('segchange', { detail: btn.dataset.value }));
    });
  }
  function segValue(el) {
    var active = $(el + ' button.is-active');
    return active ? active.dataset.value : null;
  }
  function setSeg(el, value) {
    $$(el + ' button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.value === String(value));
    });
  }

  /* ---------------------------------------------------------
   * 参数读取
   * ------------------------------------------------------- */
  function readSettings() {
    return {
      fidelity: segValue('#fidelityGroup') || 'high',
      mode: segValue('#modeGroup') || 'color',
      colorCount: +$('#colorCount').value,
      detail: +$('#detail').value,
      blur: +$('#blur').value,
      pathomit: +$('#pathomit').value,
      removeBg: $('#removeBg').checked,
      bgColor: $('#bgColor').value,
      styleMode: segValue('#styleGroup') || 'fill',
      fillStyle: segValue('#fillStyleGroup') || 'solid',
      roughness: +(segValue('#roughGroup') || 1),
      strokeWidth: +(segValue('#strokeGroup') || 2),
      opacity: +$('#opacity').value,
      scale: +$('#scale').value,
      maxElements: +$('#maxElements').value,
      grouping: $('#grouping').checked
    };
  }

  function syncSliderOutputs() {
    $('#colorCountVal').textContent = $('#colorCount').value;
    $('#detailVal').textContent = $('#detail').value;
    $('#blurVal').textContent = $('#blur').value;
    $('#pathomitVal').textContent = $('#pathomit').value;
    $('#opacityVal').textContent = $('#opacity').value + '%';
    $('#scaleVal').textContent = (+$('#scale').value).toFixed(1) + '×';
    $('#maxElementsVal').textContent = (+$('#maxElements').value).toLocaleString('en-US');
  }

  /* ---------------------------------------------------------
   * 位图预处理（灰度 / 黑白阈值 / 透明合成）
   * ------------------------------------------------------- */
  function hexToRgbArr(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function otsuThreshold(data) {
    var hist = new Array(256).fill(0);
    var total = data.length / 4;
    for (var i = 0; i < data.length; i += 4) {
      var lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      hist[Math.min(255, Math.max(0, lum | 0))]++;
    }
    var sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, maxVar = -1, threshold = 128;
    for (var k = 0; k < 256; k++) {
      wB += hist[k];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += k * hist[k];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = k; }
    }
    return threshold;
  }

  function preprocess(imgd, s) {
    var src = imgd.data;
    var out = new Uint8ClampedArray(src.length);
    var bg = hexToRgbArr(s.bgColor || '#ffffff');

    // 1. 透明像素合成到背景色
    for (var i = 0; i < src.length; i += 4) {
      var a = src[i + 3] / 255;
      out[i]     = src[i]     * a + bg[0] * (1 - a);
      out[i + 1] = src[i + 1] * a + bg[1] * (1 - a);
      out[i + 2] = src[i + 2] * a + bg[2] * (1 - a);
      out[i + 3] = 255;
    }

    // 2. 灰度 / 黑白
    if (s.mode === 'gray') {
      for (var g = 0; g < out.length; g += 4) {
        var l = (out[g] * 299 + out[g + 1] * 587 + out[g + 2] * 114) / 1000;
        l = l | 0;
        out[g] = out[g + 1] = out[g + 2] = l;
      }
    } else if (s.mode === 'bw') {
      var th = otsuThreshold(out);
      for (var b = 0; b < out.length; b += 4) {
        var lum = (out[b] * 299 + out[b + 1] * 587 + out[b + 2] * 114) / 1000;
        var v = lum > th ? 255 : 0;
        out[b] = out[b + 1] = out[b + 2] = v;
      }
    }
    return { data: out, width: imgd.width, height: imgd.height };
  }

  /** 统计边框一圈的主色，用来猜背景 */
  function detectBorderColor(imgd) {
    var w = imgd.width, h = imgd.height, d = imgd.data;
    var ringX = Math.max(1, Math.round(w * 0.015));
    var ringY = Math.max(1, Math.round(h * 0.015));
    var buckets = {}, order = [];

    function push(x, y) {
      var i = (y * w + x) * 4;
      var a = d[i + 3] / 255;
      // 透明像素按白底参与统计
      var r = d[i] * a + 255 * (1 - a);
      var g = d[i + 1] * a + 255 * (1 - a);
      var b = d[i + 2] * a + 255 * (1 - a);
      var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      var bk = buckets[key];
      if (!bk) { bk = buckets[key] = { n: 0, r: 0, g: 0, b: 0 }; order.push(key); }
      bk.n++; bk.r += r; bk.g += g; bk.b += b;
    }

    for (var y = 0; y < h; y++) {
      var isYBand = (y < ringY) || (y >= h - ringY);
      if (isYBand) {
        for (var x = 0; x < w; x += 2) push(x, y);
      } else {
        for (var x2 = 0; x2 < w; x2++) {
          if (x2 < ringX || x2 >= w - ringX) push(x2, y);
        }
      }
    }

    var best = null;
    for (var k = 0; k < order.length; k++) {
      var b2 = buckets[order[k]];
      if (!best || b2.n > best.n) best = b2;
    }
    if (!best || !best.n) return null;
    return [
      Math.round(best.r / best.n),
      Math.round(best.g / best.n),
      Math.round(best.b / best.n)
    ];
  }

  function nl(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function arrToHex(a) { return '#' + nl(a[0]) + nl(a[1]) + nl(a[2]); }
  function rgbObjToHex(c) { return arrToHex([c.r, c.g, c.b]); }

  /* ---------------------------------------------------------
   * 矢量化参数
   * ------------------------------------------------------- */
  function currentProfile() {
    return FIDELITY[segValue('#fidelityGroup')] || FIDELITY.high;
  }

  /* ---------------------------------------------------------
   * 位图 → 形状（自研管线，不再依赖 ImageTracer）
   *
   *   盒式模糊 → K-means 调色板 → 逐像素量化
   *   → 抗锯齿混合像素拆分（消灭光晕层）
   *   → 并查集相近色合并 → 区域边界追踪（带孔洞感知）
   *   → RDP 保形抽稀
   * ------------------------------------------------------- */
  function sq(v) { return v * v; }

  function buildPalette(imgd, wantK) {
    var d = imgd.data, W = imgd.width, H = imgd.height;
    var step = Math.max(1, Math.round(Math.sqrt((W * H) / 24000)));
    var sR = [], sG = [], sB = [];
    for (var y = 0; y < H; y += step) {
      var row = y * W;
      for (var x = 0; x < W; x += step) {
        var i = (row + x) * 4;
        sR.push(d[i]); sG.push(d[i + 1]); sB.push(d[i + 2]);
      }
    }
    var n = sR.length;
    if (!n) return [{ r: 0, g: 0, b: 0, a: 255 }];
    var k = Math.max(2, Math.min(wantK, n));

    // 最远点采样初始化
    var centers = [[sR[0], sG[0], sB[0]]];
    var minDist = new Float64Array(n).fill(Infinity);
    while (centers.length < k) {
      var last = centers[centers.length - 1];
      var bestI = -1, bestD = -1;
      for (var si = 0; si < n; si++) {
        var dr = sR[si] - last[0], dg = sG[si] - last[1], db = sB[si] - last[2];
        var dist = dr * dr + dg * dg + db * db;
        if (dist < minDist[si]) minDist[si] = dist;
        if (minDist[si] > bestD) { bestD = minDist[si]; bestI = si; }
      }
      if (bestD <= 1) break;
      centers.push([sR[bestI], sG[bestI], sB[bestI]]);
    }
    k = centers.length;

    // Lloyd 迭代
    for (var it = 0; it < 8; it++) {
      var sums = new Float64Array(k * 3);
      var cnt = new Float64Array(k);
      for (var s2 = 0; s2 < n; s2++) {
        var r = sR[s2], g = sG[s2], b = sB[s2];
        var bi = 0, bd = Infinity;
        for (var c = 0; c < k; c++) {
          var dr2 = r - centers[c][0], dg2 = g - centers[c][1], db2 = b - centers[c][2];
          var dd = dr2 * dr2 + dg2 * dg2 + db2 * db2;
          if (dd < bd) { bd = dd; bi = c; }
        }
        sums[bi * 3] += r; sums[bi * 3 + 1] += g; sums[bi * 3 + 2] += b;
        cnt[bi]++;
      }
      for (var c2 = 0; c2 < k; c2++) {
        if (cnt[c2] > 0) {
          centers[c2] = [sums[c2 * 3] / cnt[c2], sums[c2 * 3 + 1] / cnt[c2], sums[c2 * 3 + 2] / cnt[c2]];
        }
      }
    }

    // 按亮度排序（暗 → 亮），层序稳定
    centers.sort(function (a, b) {
      return (a[0] * 299 + a[1] * 587 + a[2] * 114) - (b[0] * 299 + b[1] * 587 + b[2] * 114);
    });
    return centers.map(function (c) {
      return { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: 255 };
    });
  }

  /** 可分离盒式模糊（只动 RGB） */
  function boxBlur(imgd, radius) {
    if (radius <= 0) return imgd;
    var W = imgd.width, H = imgd.height, d = imgd.data;
    var tmp = new Uint8ClampedArray(d.length);
    var out = new Uint8ClampedArray(d.length);
    var win = radius * 2 + 1;

    for (var y = 0; y < H; y++) {
      var row = y * W;
      for (var ch = 0; ch < 3; ch++) {
        var sum = 0;
        for (var x = -radius; x <= radius; x++) {
          sum += d[(row + Math.min(W - 1, Math.max(0, x))) * 4 + ch];
        }
        for (var x2 = 0; x2 < W; x2++) {
          tmp[(row + x2) * 4 + ch] = sum / win;
          sum += d[(row + Math.min(W - 1, x2 + radius + 1)) * 4 + ch] -
                 d[(row + Math.max(0, x2 - radius)) * 4 + ch];
        }
      }
    }
    for (var x3 = 0; x3 < W; x3++) {
      for (var ch2 = 0; ch2 < 3; ch2++) {
        var sum2 = 0;
        for (var y2 = -radius; y2 <= radius; y2++) {
          sum2 += tmp[(Math.min(H - 1, Math.max(0, y2)) * W + x3) * 4 + ch2];
        }
        for (var y3 = 0; y3 < H; y3++) {
          out[(y3 * W + x3) * 4 + ch2] = sum2 / win;
          sum2 += tmp[(Math.min(H - 1, y3 + radius + 1) * W + x3) * 4 + ch2] -
                  tmp[(Math.max(0, y3 - radius) * W + x3) * 4 + ch2];
        }
      }
    }
    return { data: out, width: W, height: H };
  }

  function traceToShapes(s, warnings) {
    var prof = FIDELITY[s.fidelity] || FIDELITY.high;
    var imgd0 = preprocess(state.imageData, s);
    var blurR = s.mode === 'minimal' ? Math.max(s.blur, 4) : s.blur;
    var imgd = boxBlur(imgd0, blurR);

    var W = imgd.width, H = imgd.height, N = W * H;
    var src = imgd.data;

    /* ---- 1. 调色板 ---- */
    var wantK = s.colorCount;
    if (s.mode === 'gray') wantK = Math.max(3, Math.min(16, s.colorCount));
    else if (s.mode === 'minimal') wantK = Math.max(2, Math.min(8, s.colorCount));
    else if (s.mode === 'bw') wantK = 2;
    var pal = s.mode === 'bw'
      ? [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }]
      : buildPalette(imgd, wantK);
    var k = pal.length;

    /* ---- 2. 抗锯齿混合色识别 ----
     * 某调色板色若近似落在另外两色的连线上（t∈[0.2,0.8]），
     * 判定为抗锯齿过渡色 → 其像素全部拆回两端，光晕层消失 */
    var mixA = new Int32Array(k).fill(-1);
    var mixB = new Int32Array(k).fill(-1);
    var MIX_D2 = 44 * 44;
    for (var m = 0; m < k; m++) {
      var bdM = MIX_D2, bpi = -1, bpj = -1;
      for (var i = 0; i < k; i++) {
        if (i === m) continue;
        for (var j = i + 1; j < k; j++) {
          if (j === m) continue;
          var ar = pal[i].r, ag = pal[i].g, ab = pal[i].b;
          var brv = pal[j].r - ar, bgv = pal[j].g - ag, bbv = pal[j].b - ab;
          var len2 = brv * brv + bgv * bgv + bbv * bbv;
          if (len2 < 1) continue;
          var tt = ((pal[m].r - ar) * brv + (pal[m].g - ag) * bgv + (pal[m].b - ab) * bbv) / len2;
          if (tt < 0.2 || tt > 0.8) continue;
          var cr = ar + brv * tt - pal[m].r;
          var cg = ag + bgv * tt - pal[m].g;
          var cb = ab + bbv * tt - pal[m].b;
          var dMix = cr * cr + cg * cg + cb * cb;
          if (dMix < bdM) { bdM = dMix; bpi = i; bpj = j; }
        }
      }
      if (bpi >= 0) { mixA[m] = bpi; mixB[m] = bpj; }
    }

    /* ---- 3. 逐像素量化（含混合像素拆分） ---- */
    var qidx = new Int32Array(N);
    var counts = new Float64Array(k);
    var cache = {};
    for (var p = 0, po = 0; p < N; p++, po += 4) {
      var r8 = src[po], g8 = src[po + 1], b8 = src[po + 2];
      var ck = ((r8 >> 3) << 10) | ((g8 >> 3) << 5) | (b8 >> 3);
      var bi = cache[ck];
      if (bi === undefined) {
        var bd3 = Infinity;
        bi = 0;
        for (var ci = 0; ci < k; ci++) {
          var dr3 = r8 - pal[ci].r, dg3 = g8 - pal[ci].g, db3 = b8 - pal[ci].b;
          var dd3 = dr3 * dr3 + dg3 * dg3 + db3 * db3;
          if (dd3 < bd3) { bd3 = dd3; bi = ci; }
        }
        if (mixA[bi] >= 0) {
          var da = sq(r8 - pal[mixA[bi]].r) + sq(g8 - pal[mixA[bi]].g) + sq(b8 - pal[mixA[bi]].b);
          var dbx = sq(r8 - pal[mixB[bi]].r) + sq(g8 - pal[mixB[bi]].g) + sq(b8 - pal[mixB[bi]].b);
          bi = da <= dbx ? mixA[bi] : mixB[bi];
        }
        cache[ck] = bi;
      }
      qidx[p] = bi;
      counts[bi]++;
    }

    /* ---- 4. 并查集：相近色合并 + 近背景色并入背景 ---- */
    var BG = k;
    var UF = new Int32Array(k + 1);
    for (var u = 0; u <= k; u++) UF[u] = u;
    function find(x) { while (UF[x] !== x) { UF[x] = UF[UF[x]]; x = UF[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) { if (a < b) UF[b] = a; else UF[a] = b; } }

    var bgArr = hexToRgbArr(s.bgColor || '#ffffff');
    for (var i2 = 0; i2 < k; i2++) {
      var dBg = Math.abs(pal[i2].r - bgArr[0]) + Math.abs(pal[i2].g - bgArr[1]) + Math.abs(pal[i2].b - bgArr[2]);
      if (dBg <= prof.bgDist) union(i2, BG);
    }
    for (var a2 = 0; a2 < k; a2++) {
      for (var b2 = a2 + 1; b2 < k; b2++) {
        var dPair = Math.abs(pal[a2].r - pal[b2].r) + Math.abs(pal[a2].g - pal[b2].g) + Math.abs(pal[a2].b - pal[b2].b);
        if (dPair <= prof.mergeDist) union(a2, b2);
      }
    }

    /* ---- 5. 背景判定 ---- */
    var borderCnt = new Float64Array(k + 1);
    var borderTotal = 0;
    var rootPixels = new Float64Array(k + 1);
    var ringX = Math.max(1, Math.round(W * 0.015));
    var ringY = Math.max(1, Math.round(H * 0.015));
    for (var by = 0; by < H; by++) {
      var yBand = (by < ringY) || (by >= H - ringY);
      var rowB = by * W;
      for (var bx = 0; bx < W; bx++) {
        var rB = find(qidx[rowB + bx]);
        rootPixels[rB]++;
        if (yBand || bx < ringX || bx >= W - ringX) { borderCnt[rB]++; borderTotal++; }
      }
    }
    var bgRoot = find(BG);
    var borderShare = borderTotal ? borderCnt[bgRoot] / borderTotal : 0;
    var pixelShare = N ? rootPixels[bgRoot] / N : 0;
    var dropBg = s.removeBg && (borderShare > 0.2 || pixelShare > 0.25);
    if (s.removeBg && !dropBg) {
      warnings.push('背景色在画面中占比很低，未执行剔除');
    }

    /* ---- 6. 每个 root 的代表色 ---- */
    var repIdx = new Int32Array(k + 1).fill(-1);
    for (var i3 = 0; i3 < k; i3++) {
      var rt0 = find(i3);
      if (repIdx[rt0] < 0 || counts[i3] > counts[repIdx[rt0]]) repIdx[rt0] = i3;
    }
    var bgColorStr = (s.bgColor || '#ffffff').toLowerCase();
    function rootHex(rt) { return rt === bgRoot ? bgColorStr : rgbObjToHex(pal[repIdx[rt]]); }

    /* ---- 7. 区域边界追踪 ---- */
    var minArea = Math.max(1, s.pathomit * s.pathomit);
    var labels = new Int32Array(N);
    for (var p4 = 0; p4 < N; p4++) labels[p4] = find(qidx[p4]);
    var loops = ExcalidrawCore.traceRegions(labels, W, H, minArea);

    var maxDim = Math.max(W, H);
    var tol = Math.max(0.6, maxDim / (320 + s.detail * 280));

    /* 孔洞"透出色"：统计孔洞边界一圈内侧的主色（排除父区域） */
    function holeRevealLabel(lp, parentRt) {
      var tally = {};
      var pts = lp.pts;
      var best = -1, bestN = 0;
      for (var i4 = 0; i4 < pts.length; i4++) {
        var vx = Math.round(pts[i4][0]), vy = Math.round(pts[i4][1]);
        for (var dy = -1; dy <= 0; dy++) {
          for (var dx = -1; dx <= 0; dx++) {
            var xx = vx + dx, yy = vy + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            var rt5 = labels[yy * W + xx];
            if (rt5 === parentRt) continue;
            tally[rt5] = (tally[rt5] || 0) + 1;
            if (tally[rt5] > bestN) { bestN = tally[rt5]; best = rt5; }
          }
        }
      }
      return best;
    }

    /* ---- 8. 组装形状（外圈 + 孔洞补块，铺贴顺序天然正确） ---- */
    var shapes = [];
    var usedColors = {};
    for (var li = 0; li < loops.length; li++) {
      var lp = loops[li];
      var rtR = lp.label;
      var isBg = rtR === bgRoot;

      if (!lp.hole) {
        if (isBg && dropBg) continue;
        var pts = ExcalidrawCore.rdp(lp.pts, tol);
        if (pts && pts.length >= 3) {
          var col = rootHex(rtR);
          usedColors[col] = 1;
          shapes.push({ color: col, pts: pts });
        }
      } else {
        if (isBg) continue;
        var rev = holeRevealLabel(lp, rtR);
        if (rev < 0) continue;
        if (rev === bgRoot && dropBg) continue; // 背景已剔除 → 保持透明
        var pts2 = ExcalidrawCore.rdp(lp.pts, tol);
        if (pts2 && pts2.length >= 3) {
          var col2 = rootHex(rev);
          usedColors[col2] = 1;
          shapes.push({ color: col2, pts: pts2 });
        }
      }
    }

    state.tracedInfo.paths = shapes.length;
    state.tracedInfo.colors = Object.keys(usedColors).length;

    return { shapes: shapes, w: W, h: H };
  }

  /* ---------------------------------------------------------
   * 转换主流程
   * ------------------------------------------------------- */
  var convertToken = 0;

  async function convert(opts) {
    opts = opts || {};
    if (!state.imageData && !state.svgText) return;
    if (state.running) {
      if (opts.auto) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(function () { convert(opts); }, 260);
      }
      return;
    }

    state.running = true;
    var token = ++convertToken;
    var s = readSettings();
    var t0 = performance.now();
    var warnings = [];

    if (!opts.quiet) {
      showOverlay(state.isSvg ? '正在解析矢量路径…' : '正在矢量化（聚类颜色 → 追踪轮廓）…', 12);
      await nextPaint();
    } else {
      setMsg('处理中…');
    }

    try {
      var result;
      if (state.isSvg) {
        if (!opts.quiet) { showOverlay('正在翻译成 Excalidraw 元素…', 60); await nextPaint(); }
        state.tracedSvg = state.svgText;
        state.tracedInfo = { paths: 0, colors: 0 };
        result = ExcalidrawCore.svgToElements(state.svgText, {
          styleMode: s.styleMode,
          fillStyle: s.fillStyle,
          roughness: s.roughness,
          strokeWidth: s.strokeWidth,
          opacity: s.opacity / 100,
          scale: s.scale,
          maxElements: s.maxElements,
          grouping: s.grouping,
          minSize: 0,
          curveDetail: s.detail
        });
      } else {
        if (!opts.quiet) { showOverlay('正在矢量化（聚类颜色 → 追踪轮廓）…', 35); await nextPaint(); }
        var traced = traceToShapes(s, warnings);
        state.tracedSvg = ExcalidrawCore.shapesToSvg(traced.shapes, traced.w, traced.h);

        if (!opts.quiet) { showOverlay('正在翻译成 Excalidraw 元素…', 70); await nextPaint(); }
        result = ExcalidrawCore.shapesToElements(traced.shapes, {
          styleMode: s.styleMode,
          fillStyle: s.fillStyle,
          roughness: s.roughness,
          strokeWidth: s.strokeWidth,
          opacity: s.opacity / 100,
          scale: s.scale,
          maxElements: s.maxElements,
          grouping: s.grouping
        });
      }

      if (token !== convertToken) return;

      state.elements = result.elements;
      state.warnings = warnings.concat(result.warnings || []);

      var file = ExcalidrawCore.buildFile(state.elements);
      state.fileJson = JSON.stringify(file);
      state.lastMs = Math.round(performance.now() - t0);

      renderAll();
      updateStats();

      if (!state.warnings.length) {
        setMsg('转换完成 · ' + state.lastMs + ' ms', 'ok');
      } else {
        setMsg(state.warnings.slice(0, 2).join('；'), 'warn');
      }
    } catch (err) {
      console.error(err);
      state.elements = [];
      state.fileJson = '';
      renderAll();
      updateStats();
      setMsg(err && err.message ? err.message : '转换失败', 'err');
      toast(err && err.message ? err.message : '转换失败', true);
    } finally {
      if (token === convertToken) {
        state.running = false;
        hideOverlay();
      }
    }
  }

  var autoTimer = null;
  function scheduleAutoConvert() {
    if (!state.imageData && !state.svgText) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { convert({ quiet: true, auto: true }); }, 320);
  }

  /* ---------------------------------------------------------
   * 渲染
   * ------------------------------------------------------- */
  function renderAll() {
    renderOriginal();
    renderSvg();
    renderExcalidraw();
    applyZoom();
    updateExportEnabled();
  }

  function renderOriginal() {
    var pane = $('#paneOriginal');
    pane.innerHTML = '';
    if (!state.dataUrl) {
      pane.innerHTML = '<div class="empty-hint">还没有素材</div>';
      return;
    }
    var img = document.createElement('img');
    img.src = state.dataUrl;
    img.alt = '原始素材';
    pane.appendChild(img);
  }

  function renderSvg() {
    var pane = $('#paneSvg');
    pane.innerHTML = '';
    if (!state.tracedSvg) {
      pane.innerHTML = '<div class="empty-hint">还没有矢量结果</div>';
      return;
    }
    var wrap = document.createElement('div');
    wrap.innerHTML = state.tracedSvg;
    var svg = wrap.querySelector('svg');
    if (!svg) {
      pane.innerHTML = '<div class="empty-hint">矢量结果无效</div>';
      return;
    }
    var w = parseFloat(svg.getAttribute('width'));
    var h = parseFloat(svg.getAttribute('height'));
    if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
      var maxW = 860;
      if (w > maxW) { h = h * maxW / w; w = maxW; }
      svg.setAttribute('width', Math.round(w));
      svg.setAttribute('height', Math.round(h));
    } else {
      var vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
      if (vb.length === 4) {
        svg.setAttribute('width', Math.round(vb[2]));
        svg.setAttribute('height', Math.round(vb[3]));
      }
    }
    pane.appendChild(svg);
  }

  function renderExcalidraw() {
    var pane = $('#paneExcalidraw');
    pane.innerHTML = '';
    if (!state.elements.length) {
      pane.innerHTML = '<div class="empty-hint">还没有 Excalidraw 结果</div>';
      return;
    }
    var useRough = $('#roughPreview').checked;
    var out = ExcalidrawPreview.render(state.elements, { rough: useRough, padding: 26 });
    pane.appendChild(out.svg);
    if (out.dropped > 0) {
      var note = document.createElement('div');
      note.className = 'stat-msg';
      note.style.cssText = 'text-align:center;margin-top:10px;font-size:11.5px;color:#8b93a7';
      note.textContent = '预览已省略 ' + out.dropped + ' 个元素以保证流畅（导出文件包含全部）';
      pane.appendChild(note);
    }
  }

  function distinctColors() {
    var set = {};
    for (var i = 0; i < state.elements.length; i++) {
      var e = state.elements[i];
      if (e.backgroundColor && e.backgroundColor !== 'transparent') set[e.backgroundColor] = 1;
      else if (e.strokeColor && e.strokeColor !== 'transparent') set[e.strokeColor] = 1;
    }
    return Object.keys(set).length;
  }

  function updateStats() {
    var els = state.elements;
    var lines = 0, areas = 0, texts = 0;
    for (var i = 0; i < els.length; i++) {
      if (els[i].type === 'line') lines++;
      else if (els[i].type === 'text') texts++;
      else areas++;
    }

    function setStat(id, value, show) {
      var node = $(id);
      if (!show) { node.classList.add('is-hidden'); return; }
      node.classList.remove('is-hidden');
      $('b', node).textContent = value;
    }

    setStat('#statEls', els.length, els.length > 0);
    setStat('#statPaths', lines, els.length > 0);
    setStat('#statColors', distinctColors(), els.length > 0);
    setStat('#statTime', state.lastMs, els.length > 0);
    setStat('#statSize', fmtBytes(new Blob([state.fileJson]).size), els.length > 0);

    updateExportEnabled();
  }

  function updateExportEnabled() {
    var has = state.elements.length > 0;
    $('#copyClipboard').disabled = !has;
    $('#downloadExcalidraw').disabled = !has;
    $('#downloadSvg').disabled = !state.tracedSvg;
    $('#copyJson').disabled = !has;
  }

  /* ---------------------------------------------------------
   * 缩放
   * ------------------------------------------------------- */
  function applyZoom() {
    $('#canvasInner').style.transform = 'scale(' + state.zoom + ')';
    $('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
  }
  function setZoom(z) {
    state.zoom = Math.min(4, Math.max(0.15, z));
    applyZoom();
  }

  /* ---------------------------------------------------------
   * 导出
   * ------------------------------------------------------- */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function copyText(text) {
    return new Promise(function (resolve, reject) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve, function () { fallback(); });
      } else {
        fallback();
      }
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error('复制失败，请手动选择文本'));
        } catch (e) { reject(e); }
      }
    });
  }

  /* ---------------------------------------------------------
   * 素材载入
   * ------------------------------------------------------- */
  function baseName(name) {
    return String(name || 'drawing').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'drawing';
  }

  function setFileChip(name, meta, thumbHtml) {
    $('#fileName').textContent = name;
    $('#fileMeta').textContent = meta;
    $('#fileThumb').innerHTML = thumbHtml || '';
    $('#fileChip').classList.remove('is-hidden');
  }

  function clearSource() {
    state.dataUrl = '';
    state.svgText = '';
    state.imageData = null;
    state.isSvg = false;
    state.tracedSvg = '';
    state.elements = [];
    state.fileJson = '';
    state.warnings = [];
    state.lastMs = 0;
    $('#fileChip').classList.add('is-hidden');
    $('#fileInput').value = '';
    $('#convertBtn').disabled = true;
    $('#emptyState').classList.remove('is-hidden');
    $('#paneOriginal').innerHTML = '<div class="empty-hint">还没有素材</div>';
    $('#paneSvg').innerHTML = '<div class="empty-hint">还没有矢量结果</div>';
    $('#paneExcalidraw').innerHTML = '<div class="empty-hint">还没有 Excalidraw 结果</div>';
    updateStats();
    ['#statEls', '#statPaths', '#statColors', '#statTime', '#statSize'].forEach(function (id) {
      $(id).classList.add('is-hidden');
    });
    setMsg('准备就绪');
  }

  function applyModeUi(mode) {
    var hints = {
      color: '自动聚类出主要颜色，适合 logo、插画、扁平图标。',
      gray: '只保留明暗层次，适合铅笔稿、扫描件、阴影图。',
      bw: '基于大津法自动二值化，笔画线条类素材效果最好，建议搭配「仅轮廓」。',
      minimal: '强平滑 + 少颜色，产出最少的元素、最"手绘"的效果。'
    };
    $('#modeHint').textContent = hints[mode] || hints.color;
    var cc = $('#colorCount');
    cc.disabled = (mode === 'bw');
    cc.parentNode.style.opacity = (mode === 'bw') ? '.45' : '1';
  }

  function applyStyleUi(mode) {
    var hints = {
      fill: '每块颜色成为一个可拖动的闭合图形，最接近原图。',
      both: '色块 + 深色描边，像马克笔勾了边。',
      stroke: '只保留轮廓线，最像手工画的，元素也最"轻"。'
    };
    $('#styleHint').textContent = hints[mode] || hints.fill;
    var fs = $('#fillStyleGroup');
    fs.style.opacity = (mode === 'stroke') ? '.45' : '1';
    fs.style.pointerEvents = (mode === 'stroke') ? 'none' : 'auto';
  }

  function applyFidelityUi(key) {
    var p = FIDELITY[key] || FIDELITY.high;
    $('#fidelityHint').textContent = p.hint;
  }

  /** 切换保真度档位：同步滑杆默认值；位图需按新分辨率重新解码 */
  async function applyFidelity(key, opts) {
    opts = opts || {};
    var p = FIDELITY[key] || FIDELITY.high;
    applyFidelityUi(key);
    $('#detail').value = p.detail;
    $('#blur').value = p.blur;
    $('#pathomit').value = p.pathomit;
    setSeg('#roughGroup', p.roughness);
    syncSliderOutputs();
    if (opts.redecode && state.dataUrl && !state.isSvg) {
      try {
        await loadRaster(state.dataUrl, state.sourceName + guessExt(), state.sourceMeta);
      } catch (e) { /* 忽略重新解码失败 */ }
    }
  }

  function guessExt() {
    return '.png';
  }

  function loadRaster(dataUrl, name, meta) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var prof = currentProfile();
        // 允许放大（最多 4×）：小图也能按高分辨率追踪，边缘更平滑
        var scale = prof.dim / Math.max(w, h);
        scale = Math.min(4, Math.max(0.05, scale));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));

        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);

        var imgd;
        try { imgd = ctx.getImageData(0, 0, cw, ch); }
        catch (e) { reject(new Error('无法读取图片像素（可能受跨域限制）')); return; }

        state.imageData = imgd;
        state.imgW = cw;
        state.imgH = ch;
        state.isSvg = false;
        state.dataUrl = dataUrl;
        state.svgText = '';

        // 自动识别背景色
        if (!state.bgTouched) {
          var det = detectBorderColor(imgd);
          if (det) $('#bgColor').value = arrToHex(det);
        }

        setFileChip(name, meta || (w + ' × ' + h + ' · 处理尺寸 ' + cw + ' × ' + ch),
          '<img src="' + dataUrl + '" alt="">');
        $('#panelTrace').classList.remove('is-hidden');
        $('#convertBtn').disabled = false;
        $('#emptyState').classList.add('is-hidden');
        resolve();
      };
      img.onerror = function () { reject(new Error('图片解码失败')); };
      img.src = dataUrl;
    });
  }

  function loadSvgText(text, name, sizeText) {
    state.isSvg = true;
    state.svgText = text;
    state.imageData = null;
    state.dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    state.bgTouched = false;

    setFileChip(name, sizeText || 'SVG 矢量文件',
      '<div style="width:100%;height:100%;display:grid;place-items:center;font-size:16px;color:#6965db">◇</div>');
    $('#panelTrace').classList.add('is-hidden');
    $('#convertBtn').disabled = false;
    $('#emptyState').classList.add('is-hidden');
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    var file = files[0];
    var name = file.name || 'pasted-image.png';
    var isSvg = /svg/i.test(file.type) || /\.svg$/i.test(name);

    state.sourceName = baseName(name);

    try {
      if (isSvg) {
        var text = await file.text();
        loadSvgText(text, name, fmtBytes(file.size) + ' · SVG');
      } else {
        var dataUrl = await new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(fr.result); };
          fr.onerror = function () { rej(new Error('文件读取失败')); };
          fr.readAsDataURL(file);
        });
        state.sourceMeta = file.size ? fmtBytes(file.size) : '';
        await loadRaster(dataUrl, name, state.sourceMeta);
      }
      await convert();
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : '载入失败', true);
      setMsg(err && err.message ? err.message : '载入失败', 'err');
    }
  }

  /* ---------------------------------------------------------
   * 示例素材
   * ------------------------------------------------------- */
  function drawSampleLogo() {
    var cv = document.createElement('canvas');
    cv.width = 620; cv.height = 400;
    var c = cv.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, cv.width, cv.height);

    // 背景圆角块
    c.fillStyle = '#eef0ff';
    roundRect(c, 40, 50, 540, 300, 28); c.fill();

    // 橙色圆
    c.fillStyle = '#ff9f43';
    c.beginPath(); c.arc(180, 190, 78, 0, Math.PI * 2); c.fill();

    // 紫色圆角方块
    c.fillStyle = '#6965db';
    roundRect(c, 260, 118, 150, 144, 24); c.fill();

    // 青色三角
    c.fillStyle = '#22c1c3';
    c.beginPath(); c.moveTo(480, 262); c.lineTo(540, 152); c.lineTo(410, 152); c.closePath(); c.fill();

    // 深色小圆点
    c.fillStyle = '#2b2f3a';
    c.beginPath(); c.arc(455, 214, 17, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(120, 300, 13, 0, Math.PI * 2); c.fill();

    // 文字
    c.fillStyle = '#2b2f3a';
    c.font = '700 34px "Segoe UI", "PingFang SC", sans-serif';
    c.textAlign = 'left';
    c.fillText('VECTOR', 96, 190);
    c.fillStyle = '#6965db';
    c.font = '600 22px "Segoe UI", "PingFang SC", sans-serif';
    c.fillText('logo sample', 96, 224);

    return cv.toDataURL('image/png');
  }

  function drawSampleSketch() {
    var cv = document.createElement('canvas');
    cv.width = 660; cv.height = 380;
    var c = cv.getContext('2d');
    c.fillStyle = '#fdfcf8';
    c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = '#232a36';
    c.lineWidth = 4;
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // 方框
    roundRect(c, 50, 140, 140, 84, 14); c.stroke();
    c.fillStyle = '#232a36';
    c.font = '700 26px "Segoe Print", "Segoe UI", sans-serif';
    c.textAlign = 'center';
    c.fillText('开始', 120, 192);

    // 椭圆
    c.beginPath();
    c.ellipse(360, 182, 82, 52, 0, 0, Math.PI * 2);
    c.stroke();
    c.fillText('处理', 360, 192);

    // 菱形
    c.beginPath();
    c.moveTo(560, 118); c.lineTo(632, 182); c.lineTo(560, 246); c.lineTo(488, 182);
    c.closePath(); c.stroke();
    c.fillText('完成?', 560, 192);

    // 箭头
    function arrow(x1, y1, x2, y2) {
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      var a = Math.atan2(y2 - y1, x2 - x1);
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 - 14 * Math.cos(a - 0.42), y2 - 14 * Math.sin(a - 0.42));
      c.moveTo(x2, y2);
      c.lineTo(x2 - 14 * Math.cos(a + 0.42), y2 - 14 * Math.sin(a + 0.42));
      c.stroke();
    }
    arrow(196, 182, 272, 182);
    arrow(446, 182, 482, 182);

    // 波浪线 + 下划线
    c.beginPath();
    c.moveTo(60, 300);
    for (var x = 60; x <= 600; x += 10) {
      c.lineTo(x, 300 + Math.sin(x / 34) * 13);
    }
    c.stroke();

    c.lineWidth = 3;
    c.beginPath(); c.moveTo(60, 345); c.lineTo(360, 345); c.stroke();

    return cv.toDataURL('image/png');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  async function loadSample(kind) {
    var dataUrl = kind === 'sketch' ? drawSampleSketch() : drawSampleLogo();
    state.sourceName = kind === 'sketch' ? 'sample-sketch' : 'sample-logo';
    state.bgTouched = false;
    if (kind === 'sketch') {
      setSeg('#modeGroup', 'bw');
      applyModeUi('bw');
      setSeg('#styleGroup', 'stroke');
      applyStyleUi('stroke');
    } else {
      setSeg('#modeGroup', 'color');
      applyModeUi('color');
      setSeg('#styleGroup', 'fill');
      applyStyleUi('fill');
    }
    setSeg('#fidelityGroup', 'high');
    await applyFidelity('high');
    state.sourceMeta = '内置示例';
    await loadRaster(dataUrl, state.sourceName + '.png', state.sourceMeta);
    await convert();
  }

  /* ---------------------------------------------------------
   * 事件绑定
   * ------------------------------------------------------- */
  function bind() {
    ['#fidelityGroup', '#modeGroup', '#styleGroup', '#fillStyleGroup', '#roughGroup', '#strokeGroup']
      .forEach(initSegmented);

    // 拖放
    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dz.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
        dz.classList.remove('is-dragover');
      });
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('is-dragover');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) handleFiles(dt.files);
    });
    dz.addEventListener('click', function () { $('#fileInput').click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
    });

    // 整页也可以拖放
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    window.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    $('#fileInput').addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleFiles(e.target.files);
    });
    $('#fileClear').addEventListener('click', function (e) {
      e.stopPropagation();
      clearSource();
    });

    // 粘贴
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) { handleFiles([f]); return; }
        }
      }
    });

    // 示例
    $$('[data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () { loadSample(btn.dataset.sample); });
    });

    // 滑杆
    var sliderPairs = [
      ['#colorCount', '#colorCountVal', function (v) { return v; }],
      ['#detail', '#detailVal', function (v) { return v; }],
      ['#blur', '#blurVal', function (v) { return v; }],
      ['#pathomit', '#pathomitVal', function (v) { return v; }],
      ['#opacity', '#opacityVal', function (v) { return v + '%'; }],
      ['#scale', '#scaleVal', function (v) { return (+v).toFixed(1) + '×'; }],
      ['#maxElements', '#maxElementsVal', function (v) { return (+v).toLocaleString('en-US'); }]
    ];
    sliderPairs.forEach(function (p) {
      var input = $(p[0]), out = $(p[1]);
      var sync = function () { out.textContent = p[2](input.value); };
      sync();
      input.addEventListener('input', sync);
    });

    // 参数变化 → 自动重算
    ['#colorCount', '#detail', '#blur', '#pathomit', '#opacity', '#scale', '#maxElements']
      .forEach(function (sel) {
        $(sel).addEventListener('change', scheduleAutoConvert);
      });
    ['#modeGroup', '#styleGroup', '#fillStyleGroup', '#roughGroup', '#strokeGroup']
      .forEach(function (sel) {
        $(sel).addEventListener('segchange', function () { scheduleAutoConvert(); });
      });
    ['#grouping', '#removeBg'].forEach(function (sel) {
      $(sel).addEventListener('change', scheduleAutoConvert);
    });

    // 保真度：切档 → 同步滑杆 → 位图按新分辨率重新解码 → 重算
    $('#fidelityGroup').addEventListener('segchange', async function (e) {
      await applyFidelity(e.detail, { redecode: true });
      scheduleAutoConvert();
    });

    $('#modeGroup').addEventListener('segchange', function (e) { applyModeUi(e.detail); });
    $('#styleGroup').addEventListener('segchange', function (e) { applyStyleUi(e.detail); });

    $('#bgColor').addEventListener('input', function () {
      state.bgTouched = true;
    });
    $('#bgColor').addEventListener('change', scheduleAutoConvert);

    $('#roughPreview').addEventListener('change', renderExcalidraw);

    // 视图切换
    $('#viewTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-view]');
      if (!btn) return;
      $$('#viewTabs button').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      state.view = btn.dataset.view;
      ['original', 'svg', 'excalidraw'].forEach(function (v) {
        var paneId = '#pane' + v.charAt(0).toUpperCase() + v.slice(1);
        $(paneId).classList.toggle('is-active', v === state.view);
      });
      setZoom(1);
    });

    // 缩放
    $('#zoomIn').addEventListener('click', function () { setZoom(state.zoom * 1.25); });
    $('#zoomOut').addEventListener('click', function () { setZoom(state.zoom / 1.25); });
    $('#zoomFit').addEventListener('click', function () { setZoom(1); });
    $('#canvasWrap').addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });

    // 操作
    $('#convertBtn').addEventListener('click', function () { convert(); });
    $('#resetBtn').addEventListener('click', function () {
      $('#colorCount').value = 16; 
      $('#detail').value = 7;
      $('#blur').value = 0;
      $('#pathomit').value = 2;
      $('#opacity').value = 100;
      $('#scale').value = 1;
      $('#maxElements').value = 6000;
      $('#removeBg').checked = true;
      $('#grouping').checked = true;
      $('#roughPreview').checked = true;
      setSeg('#fidelityGroup', 'high'); applyFidelityUi('high');
      setSeg('#modeGroup', 'color'); applyModeUi('color');
      setSeg('#styleGroup', 'fill'); applyStyleUi('fill');
      setSeg('#fillStyleGroup', 'solid');
      setSeg('#roughGroup', '0');
      setSeg('#strokeGroup', '2');
      syncSliderOutputs();
      state.bgTouched = false;
      if (state.imageData) {
        var det = detectBorderColor(state.imageData);
        if (det) $('#bgColor').value = arrToHex(det);
      }
      if (state.elements.length || state.imageData || state.svgText) convert();
      toast('参数已重置');
    });

    // 导出
    $('#downloadExcalidraw').addEventListener('click', function () {
      download(state.sourceName + '.excalidraw', state.fileJson, 'application/json');
      toast('已下载 .excalidraw 文件');
    });
    $('#downloadSvg').addEventListener('click', function () {
      download(state.sourceName + '.svg', state.tracedSvg, 'image/svg+xml');
      toast('已下载 SVG 文件');
    });
    $('#copyJson').addEventListener('click', function () {
      copyText(state.fileJson).then(
        function () { toast('已复制 .excalidraw JSON'); },
        function () { toast('复制失败', true); }
      );
    });
    $('#copyClipboard').addEventListener('click', function () {
      var payload = JSON.stringify(ExcalidrawCore.buildClipboard(state.elements));
      copyText(payload).then(
        function () { toast('已复制 · 到 Excalidraw 按 Ctrl+V 粘贴'); },
        function () { toast('复制失败', true); }
      );
    });

    // 帮助
    $('#helpBtn').addEventListener('click', function () { $('#helpModal').classList.remove('is-hidden'); });
    $$('#helpModal [data-close]').forEach(function (n) {
      n.addEventListener('click', function () { $('#helpModal').classList.add('is-hidden'); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('#helpModal').classList.add('is-hidden');
    });
  }

  /* ---------------------------------------------------------
   * 启动
   * ------------------------------------------------------- */
  function boot() {
    bind();
    applyFidelityUi('high');
    applyModeUi('color');
    applyStyleUi('fill');
    setZoom(1);
    clearSource();
    // 调试句柄：方便在控制台检查内部状态
    window.__p2e = { state: state, convert: convert, settings: readSettings, FIDELITY: FIDELITY };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
