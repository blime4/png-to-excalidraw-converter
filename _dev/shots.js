const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '..', '_test_out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(PAGE, { waitUntil: 'load' });

  await page.click('[data-sample="logo"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('#statEls b');
    return b && +b.textContent > 0;
  }, { timeout: 120000 });

  // 导出矢量 SVG 与 excalidraw 文件
  const data = await page.evaluate(() => ({
    svg: window.__p2e.state.tracedSvg,
    els: window.__p2e.state.elements,
    json: window.__p2e.state.fileJson
  }));
  fs.writeFileSync(path.join(OUT, 'traced-logo.svg'), data.svg);
  fs.writeFileSync(path.join(OUT, 'logo.excalidraw'), data.json);

  // Excalidraw 预览（手绘）
  await page.click('#viewTabs button[data-view="excalidraw"]');
  await new Promise(r => setTimeout(r, 500));
  await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, 'A-excalidraw-rough.png') }));

  // 关闭手绘 → 精确渲染
  await page.evaluate(() => {
    const el = document.querySelector('#roughPreview');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 500));
  await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, 'B-excalidraw-exact.png') }));

  // 矢量图
  await page.click('#viewTabs button[data-view="svg"]');
  await new Promise(r => setTimeout(r, 400));
  await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, 'C-svg.png') }));

  // 原图
  await page.click('#viewTabs button[data-view="original"]');
  await new Promise(r => setTimeout(r, 400));
  await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, 'D-original.png') }));

  // 黑白草图
  await page.click('[data-sample="sketch"]');
  await page.waitForFunction(() => document.querySelector('#statMsg').textContent.indexOf('转换完成') >= 0, { timeout: 120000 });
  await new Promise(r => setTimeout(r, 600));
  await page.click('#viewTabs button[data-view="excalidraw"]');
  await new Promise(r => setTimeout(r, 500));
  await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, 'E-sketch.png') }));
  fs.writeFileSync(path.join(OUT, 'sketch.excalidraw'),
    JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
      elements: (await page.evaluate(() => window.__p2e.state.elements)),
      appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} }));

  console.log('OK ->', OUT);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
