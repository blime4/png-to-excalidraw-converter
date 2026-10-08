/* 用用户提供的刺猬图跑完整管线，输出三视图截图 + 元素统计 */
(function () {
  'use strict';
  const { launch } = require('puppeteer-core');
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.resolve(__dirname, '..');
  const OUT = path.resolve(ROOT, '..', '_test_out');
  const IMG = path.join(__dirname, 'user-hedgehog.png');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p));

  async function main() {
    const browser = await launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });

    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

    const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));

    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');

    // 注入图片（走 #fileInput change → handleFiles 同款管线）
    await page.evaluate(async (du) => {
      const blob = await (await fetch(du)).blob();
      const file = new File([blob], 'user-hedgehog.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, dataUrl);

    await new Promise(r => setTimeout(r, 8000));

    const report = { errors };
    const save = () => { try { fs.writeFileSync(path.join(__dirname, 'hedgehog-report.json'), JSON.stringify(report, null, 2)); } catch (e) {} };

    try {
      report.stats = await page.evaluate(() => {
        const st = window.__p2e.state;
        return {
          elements: st.elements.length,
          colors: st.tracedInfo.colors,
          paths: st.tracedInfo.paths,
          ms: st.lastMs,
          warnings: st.warnings,
          bg: document.querySelector('#bgColor').value
        };
      });
    } catch (e) { report.statsErr = e.message; }
    save();

    // 矢量视图截图
    try {
      await page.evaluate(() => document.querySelector('#viewTabs [data-view="svg"]').click());
      await new Promise(r => setTimeout(r, 500));
      await page.screenshot({ path: path.join(OUT, 'H-svg.png') });
    } catch (e) { report.svgShotErr = e.message; }
    save();

    // Excalidraw 预览截图（默认 roughness=0 → 精确渲染）
    try {
      await page.evaluate(() => document.querySelector('#viewTabs [data-view="excalidraw"]').click());
      await new Promise(r => setTimeout(r, 500));
      await page.screenshot({ path: path.join(OUT, 'H-exc.png') });
    } catch (e) { report.excShotErr = e.message; }
    save();

    // 关闭预览手绘开关，确认精确渲染
    try {
      await page.evaluate(() => {
        const cb = document.querySelector('#roughPreview');
        if (cb.checked) { cb.click(); }
      });
      await new Promise(r => setTimeout(r, 500));
      await page.screenshot({ path: path.join(OUT, 'H-exc-exact.png') });
    } catch (e) { report.exactShotErr = e.message; }
    save();

    // 导出 .excalidraw
    try {
      const json = await page.evaluate(() => window.__p2e.state.fileJson);
      if (json) fs.writeFileSync(path.join(OUT, 'hedgehog.excalidraw'), json);
      report.exported = !!json;
      report.bytes = json ? json.length : 0;
    } catch (e) { report.exportErr = e.message; }
    save();

    await browser.close();
  }

  main().catch(e => { console.error('FATAL', e); process.exit(1); });
})();
