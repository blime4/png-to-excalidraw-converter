/* 导出两份可直接拖进 excalidraw.com 的示例文件 */
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
    defaultViewport: { width: 1400, height: 900 }
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(PAGE, { waitUntil: 'load' });

  const grab = async (sampleBtn) => {
    const before = await page.evaluate(() => {
      const b = document.querySelector('#statEls b');
      return b ? +b.textContent : -1;
    });
    await page.click(sampleBtn);
    // 等元素数量真的变化，避免上一张的 statMsg 残留造成假等待
    await page.waitForFunction(
      (prev) => { const b = document.querySelector('#statEls b'); return b && +b.textContent > 0 && +b.textContent !== prev; },
      { timeout: 120000 }, before
    );
    await new Promise(r => setTimeout(r, 400));
    return page.evaluate(() => ({
      els: window.__p2e.state.elements,
      n: document.querySelector('#statEls b').textContent,
      colors: document.querySelector('#statColors b').textContent,
      ms: document.querySelector('#statTime b').textContent
    }));
  };

  const logo = await grab('[data-sample="logo"]');
  console.log('logo:', logo.n, '个元素,', logo.colors, '种颜色,', logo.ms, 'ms');
  fs.writeFileSync(path.join(OUT, 'sample-logo.excalidraw'), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
    elements: logo.els, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {}
  }));

  const sketch = await grab('[data-sample="sketch"]');
  console.log('sketch:', sketch.n, '个元素,', sketch.colors, '种颜色,', sketch.ms, 'ms');
  fs.writeFileSync(path.join(OUT, 'sample-sketch.excalidraw'), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
    elements: sketch.els, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {}
  }));

  // 校验两份确实不同
  const a = fs.statSync(path.join(OUT, 'sample-logo.excalidraw')).size;
  const b = fs.statSync(path.join(OUT, 'sample-sketch.excalidraw')).size;
  console.log('文件大小: logo=' + a + ' B, sketch=' + b + ' B' + (a !== b ? '  ✓ 两份内容不同' : '  ✗ 异常：两份相同'));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.message); process.exit(1); });
