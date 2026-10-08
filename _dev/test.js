/* 自动化验收测试：用本机 Chrome 跑一遍完整流程 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '..', '_test_out');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
let failures = 0;
function assert(cond, label, extra) {
  if (cond) log('  ✓ ' + label);
  else { failures++; log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
           '--font-render-hinting=none'],
    defaultViewport: { width: 1500, height: 950 }
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  log('\n=== 1. 打开页面 ===');
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.ExcalidrawCore && !!window.ExcalidrawPreview && !!window.ImageTracer);
  assert(true, '依赖库全部就绪');
  assert(errors.length === 0, '无控制台错误', errors.join(' | '));

  /* ---------- 2. 核心：SVG → Excalidraw ---------- */
  log('\n=== 2. 内核转换测试（多形态 SVG）===');
  const coreResult = await page.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
      <defs><linearGradient id="g1"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
      <g transform="translate(20,20)">
        <rect id="r1" x="0" y="0" width="100" height="60" fill="#a5d8ff" stroke="#1e1e1e" stroke-width="2" rx="8"/>
        <circle id="c1" cx="180" cy="40" r="30" fill="url(#g1)"/>
        <ellipse id="e1" cx="300" cy="40" rx="40" ry="22" fill="#b2f2bb"/>
        <line id="l1" x1="0" y1="100" x2="120" y2="100" stroke="#e03131" stroke-width="3"/>
        <polyline id="pl1" points="0,130 40,160 80,130 120,160" fill="none" stroke="#1971c2" stroke-width="2"/>
        <polygon id="pg1" points="200,120 260,120 230,180" fill="#ffec99" stroke="#1e1e1e"/>
        <path id="p1" d="M 300 120 C 340 120 360 160 320 180 A 30 30 0 0 1 280 180 Z" fill="#ffc9c9" stroke="#1e1e1e"/>
        <text id="t1" x="10" y="230" font-family="sans-serif" font-size="24" fill="#2b2f3a">Hello 梯形</text>
      </g>
      <rect id="rot" x="200" y="240" width="80" height="40" fill="#d0bfff" transform="rotate(20 240 260)"/>
    </svg>`;
    const res = window.ExcalidrawCore.svgToElements(svg, {
      styleMode: 'both', fillStyle: 'solid', roughness: 1, strokeWidth: 2,
      opacity: 1, scale: 1, maxElements: 5000, grouping: true, curveDetail: 6
    });
    return {
      count: res.elements.length,
      types: res.elements.map(e => e.type),
      warnings: res.warnings,
      sample: res.elements.map(e => ({
        type: e.type, x: e.x, y: e.y, w: e.width, h: e.height,
        fill: e.backgroundColor, stroke: e.strokeColor,
        groups: e.groupIds.length, pts: e.points ? e.points.length : 0,
        polygon: e.polygon, roundness: e.roundness,
        hasIndex: typeof e.index === 'string', hasSeed: typeof e.seed === 'number',
        p0: e.points ? e.points[0] : null,
        text: e.text, fontSize: e.fontSize, fontFamily: e.fontFamily,
        strokeWidth: e.strokeWidth, updated: typeof e.updated
      })),
      file: window.ExcalidrawCore.buildFile(res.elements)
    };
  });

  log('  元素数：' + coreResult.count + '  类型：' + JSON.stringify(coreResult.types));
  if (coreResult.warnings.length) log('  警告：' + coreResult.warnings.join('；'));
  coreResult.sample.forEach((s, i) => log('   [' + i + '] ' + JSON.stringify(s)));

  const byType = t => coreResult.sample.filter(s => s.type === t);
  assert(byType('rectangle').length >= 1, '识别出 rectangle');
  assert(byType('ellipse').length >= 2, '识别出 circle/ellipse');
  assert(byType('line').length >= 4, '识别出 line/polyline/polygon/path');
  assert(byType('text').length >= 1, '识别出 text');
  assert(byType('text')[0] && byType('text')[0].text.indexOf('梯形') >= 0, '文字内容正确');
  assert(coreResult.sample.some(s => s.groups >= 1), '保留了 groupIds 分组');
  assert(coreResult.sample.filter(s => s.type === 'line').every(s => s.hasIndex), 'line 元素带 index');
  assert(coreResult.sample.every(s => s.hasSeed), '所有元素带 seed');
  assert(coreResult.sample.every(s => s.updated === 'number'), 'updated 是数字时间戳');

  // 渐变被近似成纯色（红+蓝 → 紫）
  const grad = coreResult.sample.find(s => s.type === 'ellipse' && s.w === 60 && s.h === 60);
  assert(!!grad && grad.fill !== '#000000' && grad.fill !== '#cccccc',
    '渐变被解析为真实色（红蓝均值）', JSON.stringify(grad && grad.fill));

  // 旋转矩形退化成多边形
  assert(coreResult.sample.some(s => s.type === 'line' && s.polygon === true), '旋转矩形转为闭合多边形');

  // 文件结构
  const f = coreResult.file;
  assert(f.type === 'excalidraw' && f.version === 2 && f.source === 'https://excalidraw.com', '.excalidraw 文件头正确');
  assert(Array.isArray(f.elements) && f.elements.length === coreResult.count, 'elements 数组完整');
  assert(f.appState && typeof f.appState.viewBackgroundColor === 'string', 'appState 正确');
  assert(f.files && typeof f.files === 'object', 'files 字段存在');

  // 几何合理性
  const bad = coreResult.sample.filter(s => s.type !== 'text' && (s.w < 0 || s.h < 0 || !isFinite(s.x) || !isFinite(s.y)));
  assert(bad.length === 0, '所有几何数值有限且非负', JSON.stringify(bad.slice(0, 2)));
  const badP0 = coreResult.sample.filter(s => s.pts > 0 && !s.p0);
  assert(badP0.length === 0, 'line 元素都带 points');

  // 几何不变量：所有点相对 bbox 左上角非负，且 width/height 与点列 bbox 一致
  let negBad = 0, mismatch = 0;
  for (const e of coreResult.file.elements) {
    if (e.type !== 'line') continue;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of e.points) {
      if (p[0] < -0.011 || p[1] < -0.011) negBad++;
      mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]);
      mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]);
    }
    if (Math.abs(mnx) > 0.011 || Math.abs(mny) > 0.011) negBad++;
    if (Math.abs(mxx - e.width) > 0.05 || Math.abs(mxy - e.height) > 0.05) mismatch++;
  }
  assert(negBad === 0, 'line 点坐标全部相对 bbox 左上角非负');
  assert(mismatch === 0, 'line 的 width/height 与点列 bbox 一致');
  const hexRe = /^#[0-9a-f]{6}$|^transparent$/;
  const badColor = coreResult.sample.filter(s => !hexRe.test(s.fill) || !hexRe.test(s.stroke));
  assert(badColor.length === 0, '颜色全部是 hex 或 transparent', JSON.stringify(badColor.slice(0, 3)));

  /* ---------- 3. 位图全流程 ---------- */
  log('\n=== 3. 位图 → 矢量化 → Excalidraw（示例 Logo）===');
  await page.click('[data-sample="logo"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('#statEls b');
    return b && b.textContent !== '—' && +b.textContent > 0;
  }, { timeout: 120000 });

  let stats = await page.evaluate(() => ({
    els: document.querySelector('#statEls b').textContent,
    paths: document.querySelector('#statPaths b').textContent,
    colors: document.querySelector('#statColors b').textContent,
    time: document.querySelector('#statTime b').textContent,
    size: document.querySelector('#statSize b').textContent,
    msg: document.querySelector('#statMsg').textContent,
    svgHasContent: (document.querySelector('#paneSvg').innerHTML || '').length > 200,
    exSvgNodes: document.querySelectorAll('#paneExcalidraw svg > *').length
  }));
  log('  ' + JSON.stringify(stats));
  assert(+stats.els > 5, '生成了多个 Excalidraw 元素', stats.els);
  assert(stats.svgHasContent, '矢量 SVG 已生成');
  assert(stats.exSvgNodes > 5, '手绘预览已渲染');
  assert(+stats.time > 0, '记录了耗时');

  const dump = await page.evaluate(() => JSON.stringify(window.__p2e.state.elements));
  fs.writeFileSync(path.join(OUT, 'logo.excalidraw'), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
    elements: JSON.parse(dump), appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {}
  }, null, 0));

  await page.screenshot({ path: path.join(OUT, '01-logo-excalidraw-preview.png') });

  // 切到 Excalidraw 预览
  await page.click('#viewTabs button[data-view="excalidraw"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '02-excalidraw-view.png') });

  // 矢量图视图
  await page.click('#viewTabs button[data-view="svg"]');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, '03-svg-view.png') });

  /* ---------- 4. 只描边 + 精准手绘 ---------- */
  log('\n=== 4. 切换「仅轮廓 / 精准」后重算 ===');
  await page.click('#styleGroup button[data-value="stroke"]');
  await page.click('#roughGroup button[data-value="0"]');
  await page.waitForFunction(() => document.querySelector('#statMsg').textContent.indexOf('转换完成') >= 0, { timeout: 120000 });
  await new Promise(r => setTimeout(r, 600));
  await page.click('#viewTabs button[data-view="excalidraw"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '04-stroke-mode.png') });
  const strokeStats = await page.evaluate(() => ({
    els: document.querySelector('#statEls b').textContent,
    fills: window.__p2e.state.elements.filter(e => e.backgroundColor !== 'transparent').length
  }));
  log('  ' + JSON.stringify(strokeStats));
  assert(+strokeStats.fills === 0, '仅轮廓模式下没有填充色', JSON.stringify(strokeStats));

  /* ---------- 5. 草图（黑白模式）---------- */
  log('\n=== 5. 示例草图（黑白模式）===');
  await page.click('#styleGroup button[data-value="fill"]');
  await page.click('#roughGroup button[data-value="1"]');
  await page.click('[data-sample="sketch"]');
  await page.waitForFunction(() => document.querySelector('#statMsg').textContent.indexOf('转换完成') >= 0, { timeout: 120000 });
  await new Promise(r => setTimeout(r, 800));
  await page.click('#viewTabs button[data-view="excalidraw"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '05-sketch-bw.png') });
  const sketch = await page.evaluate(() => ({
    els: document.querySelector('#statEls b').textContent,
    mode: document.querySelector('#modeGroup button.is-active').dataset.value,
    colors: document.querySelector('#statColors b').textContent
  }));
  log('  ' + JSON.stringify(sketch));
  assert(sketch.mode === 'bw', '已切到黑白模式');
  assert(+sketch.els > 3, '草图生成了元素');
  assert(+sketch.colors <= 2, '黑白模式颜色数 <= 2', sketch.colors);

  /* ---------- 6. 边界情况 ---------- */
  log('\n=== 6. 边界情况 ===');
  const edge = await page.evaluate(() => {
    const cases = {
      empty: () => window.ExcalidrawCore.svgToElements('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', {}),
      broken: () => { try { window.ExcalidrawCore.svgToElements('not svg at all', {}); return 'no-throw'; } catch (e) { return 'threw'; } },
      selfclose: () => window.ExcalidrawCore.svgToElements('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0"/></svg>', {}),
      relPath: () => window.ExcalidrawCore.svgToElements('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="m5 5 l10 0 l0 10 z" fill="#123456"/></svg>', {}),
      noSize: () => window.ExcalidrawCore.svgToElements('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="30" height="30" fill="#000"/></svg>', {}),
      cap: () => window.ExcalidrawCore.svgToElements('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">' +
              Array.from({length: 300}, (_, i) => `<rect x="${(i%20)*19}" y="${Math.floor(i/20)*19}" width="14" height="14" fill="#3366${(i%9)}${(i%9)}0"/>`).join('') + '</svg>',
              { maxElements: 50 })
    };
    const r = {};
    for (const k in cases) {
      try {
        const v = cases[k]();
        r[k] = (typeof v === 'string') ? v
          : { n: v.elements.length, warn: v.warnings.length };
      } catch (e) { r[k] = 'ERR: ' + e.message; }
    }
    return r;
  });
  log('  ' + JSON.stringify(edge, null, 0));
  assert(edge.empty && edge.empty.n === 0, '空 SVG 不报错且产 0 元素', JSON.stringify(edge.empty));
  assert(edge.broken === 'threw', '非法 SVG 抛出可捕获错误');
  assert(edge.selfclose && edge.selfclose.n === 0, '退化路径被丢弃');
  assert(edge.relPath && edge.relPath.n === 1, '相对坐标路径被解析');
  assert(edge.noSize && edge.noSize.n === 1, '只有 viewBox 的 SVG 也能处理');
  assert(edge.cap && edge.cap.n === 50 && edge.cap.warn >= 1, 'maxElements 截断生效并给出提示', JSON.stringify(edge.cap));

  /* ---------- 7. 剪贴板 / 导出格式 ---------- */
  log('\n=== 7. 导出格式 ===');
  const exp = await page.evaluate(() => {
    const els = window.__p2e.state.elements;
    const cb = window.ExcalidrawCore.buildClipboard(els);
    let ok = true;
    try { JSON.stringify(cb); } catch (e) { ok = false; }
    return {
      type: cb.type,
      hasElements: Array.isArray(cb.elements),
      hasFiles: !!cb.files,
      jsonOk: ok,
      clipboardBtnDisabled: document.querySelector('#copyClipboard').disabled,
      downloadBtnDisabled: document.querySelector('#downloadExcalidraw').disabled,
      svgBtnDisabled: document.querySelector('#downloadSvg').disabled
    };
  });
  log('  ' + JSON.stringify(exp));
  assert(exp.type === 'excalidraw/clipboard' && exp.hasElements && exp.hasFiles, '剪贴板格式正确');
  assert(exp.jsonOk, '元素可 JSON 序列化');
  assert(!exp.clipboardBtnDisabled && !exp.downloadBtnDisabled && !exp.svgBtnDisabled, '导出按钮已启用');

  /* ---------- 8. 最终错误检查 ---------- */
  log('\n=== 8. 运行期错误 ===');
  assert(errors.length === 0, '全程零 JS 错误', errors.slice(0, 5).join(' | '));
  if (errors.length) errors.slice(0, 10).forEach(e => log('   ! ' + e));

  await browser.close();
  log('\n' + (failures === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures + ' 项'));
  log('截图与产物目录：' + OUT);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
