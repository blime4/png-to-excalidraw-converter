/* =========================================================
 * preview.js
 * 用 rough.js 模拟 Excalidraw 的手绘渲染，生成预览 SVG
 * ========================================================= */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FONT_STACK = {
    1: '"Virgil","Segoe Print","Bradley Hand",cursive,sans-serif',
    2: '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    3: '"SFMono-Regular",Consolas,Menlo,monospace'
  };

  function el(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) {
      if (attrs[k] === null || attrs[k] === undefined) continue;
      n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  function dashFor(elx) {
    if (elx.strokeStyle === 'dashed') return [8, 8 + elx.strokeWidth];
    if (elx.strokeStyle === 'dotted') return [1.5, 6 + elx.strokeWidth];
    return undefined;
  }

  function roughOpts(elx) {
    var transparentStroke = !elx.strokeColor || elx.strokeColor === 'transparent';
    var transparentFill = !elx.backgroundColor || elx.backgroundColor === 'transparent';
    return {
      seed: elx.seed || 1,
      roughness: elx.roughness === undefined ? 1 : elx.roughness,
      bowing: 1,
      preserveVertices: true,
      stroke: transparentStroke ? 'none' : elx.strokeColor,
      strokeWidth: transparentStroke ? 0 : elx.strokeWidth,
      strokeLineDash: dashFor(elx),
      fill: transparentFill ? undefined : elx.backgroundColor,
      fillStyle: elx.fillStyle || 'solid',
      fillWeight: transparentFill ? 0 : Math.max(0.6, elx.strokeWidth / 2),
      hachureGap: transparentFill ? 0 : Math.max(3, elx.strokeWidth * 3),
      hachureAngle: 41
    };
  }

  function wrapRotation(elx, node) {
    if (!elx.angle) return node;
    var cx = elx.x + elx.width / 2;
    var cy = elx.y + elx.height / 2;
    var g = el('g', {
      transform: 'rotate(' + (elx.angle * 180 / Math.PI).toFixed(4) + ' ' +
                 cx.toFixed(2) + ' ' + cy.toFixed(2) + ')'
    });
    g.appendChild(node);
    return g;
  }

  function absPoints(elx) {
    var pts = new Array(elx.points.length);
    for (var i = 0; i < elx.points.length; i++) {
      pts[i] = [elx.x + elx.points[i][0], elx.y + elx.points[i][1]];
    }
    return pts;
  }

  function pointsToPath(pts, close) {
    if (!pts.length) return '';
    var s = 'M ' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
    for (var i = 1; i < pts.length; i++) {
      s += ' L ' + pts[i][0].toFixed(2) + ' ' + pts[i][1].toFixed(2);
    }
    return close ? s + ' Z' : s;
  }

  /* -------------------------------------------------------
   * 主渲染
   * ------------------------------------------------------- */
  function render(elements, opts) {
    opts = opts || {};
    var useRough = opts.rough !== false;
    var padding = opts.padding === undefined ? 24 : opts.padding;
    var maxRender = opts.maxRender || 2500;

    var list = elements;
    var dropped = 0;
    if (list.length > maxRender) {
      dropped = list.length - maxRender;
      list = list.slice(0, maxRender);
    }

    // bounds
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < elements.length; i++) {
      var e0 = elements[i];
      if (e0.x < minX) minX = e0.x;
      if (e0.y < minY) minY = e0.y;
      if (e0.x + e0.width > maxX) maxX = e0.x + e0.width;
      if (e0.y + e0.height > maxY) maxY = e0.y + e0.height;
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 120; }

    var vbX = minX - padding, vbY = minY - padding;
    var vbW = Math.max(1, maxX - minX + padding * 2);
    var vbH = Math.max(1, maxY - minY + padding * 2);

    var svg = el('svg', {
      xmlns: SVGNS,
      viewBox: [vbX, vbY, vbW, vbH].map(function (v) { return Math.round(v * 100) / 100; }).join(' '),
      preserveAspectRatio: 'xMidYMid meet'
    });

    var maxPx = 900;
    var ratio = vbW / vbH;
    var w = ratio >= 1 ? Math.min(maxPx, Math.round(vbW)) : Math.round(maxPx * ratio);
    var h = ratio >= 1 ? Math.round(maxPx / ratio) : Math.min(maxPx, Math.round(vbH));
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    var bg = el('rect', {
      x: vbX, y: vbY, width: vbW, height: vbH, fill: '#ffffff'
    });
    svg.appendChild(bg);

    var rc = useRough && global.rough ? global.rough.svg(svg) : null;

    for (var j = 0; j < list.length; j++) {
      var elx = list[j];
      var node = null;
      var o = roughOpts(elx);

      try {
        // roughness=0（精准档）直接走精确渲染，杜绝 rough.js 残留抖动
        var rc2 = (rc && elx.roughness !== 0) ? rc : null;
        if (elx.type === 'rectangle') {
          node = rc2
            ? rc2.rectangle(elx.x, elx.y, Math.max(elx.width, 0.01), Math.max(elx.height, 0.01), o)
            : el('rect', {
                x: elx.x, y: elx.y, width: Math.max(elx.width, 0.01), height: Math.max(elx.height, 0.01),
                rx: elx.roundness ? Math.min(32, Math.min(elx.width, elx.height) * 0.25) : 0,
                fill: o.fill || 'none', stroke: o.stroke, 'stroke-width': o.strokeWidth
              });

        } else if (elx.type === 'ellipse') {
          var cx = elx.x + elx.width / 2, cy = elx.y + elx.height / 2;
          node = rc2
            ? rc2.ellipse(cx, cy, Math.max(elx.width, 0.01), Math.max(elx.height, 0.01), o)
            : el('ellipse', {
                cx: cx, cy: cy, rx: Math.max(elx.width / 2, 0.01), ry: Math.max(elx.height / 2, 0.01),
                fill: o.fill || 'none', stroke: o.stroke, 'stroke-width': o.strokeWidth
              });

        } else if (elx.type === 'diamond') {
          var dx = elx.x, dy = elx.y, dw = elx.width, dh = elx.height;
          var dp = [[dx + dw / 2, dy], [dx + dw, dy + dh / 2], [dx + dw / 2, dy + dh], [dx, dy + dh / 2]];
          node = rc2
            ? rc2.polygon(dp, o)
            : el('polygon', {
                points: dp.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
                fill: o.fill || 'none', stroke: o.stroke, 'stroke-width': o.strokeWidth
              });

        } else if (elx.type === 'line' || elx.type === 'arrow' || elx.type === 'freedraw') {
          if (!elx.points || elx.points.length < 2) continue;
          var pts = absPoints(elx);
          var filled = elx.backgroundColor && elx.backgroundColor !== 'transparent';
          if (elx.type === 'freedraw') {
            node = el('path', {
              d: pointsToPath(pts, false),
              fill: 'none',
              stroke: elx.strokeColor,
              'stroke-width': elx.strokeWidth,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round'
            });
          } else if (rc2) {
            node = (elx.polygon || filled) ? rc2.polygon(pts, o) : rc2.linearPath(pts, o);
          } else {
            node = el(elx.polygon || filled ? 'polygon' : 'polyline', {
              points: pts.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' '),
              fill: filled ? o.fill : 'none',
              stroke: o.stroke,
              'stroke-width': o.strokeWidth,
              'stroke-linejoin': 'round'
            });
          }

        } else if (elx.type === 'text') {
          var t = el('text', {
            x: 0, y: 0,
            'font-family': FONT_STACK[elx.fontFamily] || FONT_STACK[1],
            'font-size': elx.fontSize,
            fill: elx.strokeColor,
            'dominant-baseline': 'text-before-edge',
            'text-anchor': elx.textAlign === 'center' ? 'middle' : (elx.textAlign === 'right' ? 'end' : 'start'),
            'xml:space': 'preserve'
          });
          var lines = String(elx.text).split('\n');
          var lh = elx.fontSize * (elx.lineHeight || 1.25);
          var tx = elx.textAlign === 'center' ? elx.width / 2 : (elx.textAlign === 'right' ? elx.width : 0);
          for (var li = 0; li < lines.length; li++) {
            var ts = el('tspan', { x: tx, y: li * lh });
            ts.textContent = lines[li];
            t.appendChild(ts);
          }
          var tg = el('g', { transform: 'translate(' + elx.x + ' ' + elx.y + ')' });
          tg.appendChild(t);
          node = tg;
        }

        if (!node) continue;
        if (elx.opacity !== undefined && elx.opacity < 100) {
          node.setAttribute('opacity', (elx.opacity / 100).toFixed(3));
        }
        node = wrapRotation(elx, node);
        svg.appendChild(node);
      } catch (err) {
        /* 单个元素失败不影响整体 */
      }
    }

    return { svg: svg, dropped: dropped, rendered: list.length };
  }

  global.ExcalidrawPreview = { render: render };

})(window);
