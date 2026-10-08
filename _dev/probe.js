/* 探针：检查 traced SVG 的 path 结构与 excalidraw 元素产出 */
const path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1400, height: 900 }
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(PAGE, { waitUntil: 'load' });

  await page.evaluate(() => {
    const W = 900, H = 620, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#e8590c'; c.beginPath(); c.arc(150, 260, 90, 0, 7); c.fill();
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(150, 260, 52, 0, 7); c.fill();
    c.strokeStyle = '#2f9e44'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(150, 480, 62, 0, 7); c.stroke();
    c.fillStyle = '#f7b500';
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 32 : 80;
      const x = 370 + Math.cos(a) * r, y = 200 + Math.sin(a) * r;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath(); c.fill();
    const g = c.createLinearGradient(520, 420, 760, 420);
    g.addColorStop(0, '#e03131'); g.addColorStop(1, '#1971c2');
    c.fillStyle = g; c.fillRect(520, 420, 240, 110);
    c.strokeStyle = '#c2255c'; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(560, 560); c.bezierCurveTo(610, 500, 700, 620, 760, 555); c.stroke();

    const url = cv.toDataURL('image/png');
    return fetch(url).then(r => r.blob()).then(blob => {
      const file = new File([blob], 'probe.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  await page.waitForFunction(() => {
    const m = document.querySelector('#statMsg').textContent;
    return m.indexOf('转换完成') >= 0 || m.indexOf('失败') >= 0;
  }, { timeout: 120000 });

  const info = await page.evaluate(() => {
    const st = window.__p2e.state;
    const doc = new DOMParser().parseFromString(st.tracedSvg, 'image/svg+xml');
    const paths = doc.querySelectorAll('path');
    const subs = [];
    for (let i = 0; i < paths.length; i++) {
      const d = paths[i].getAttribute('d') || '';
      subs.push({
        fill: paths[i].getAttribute('fill'),
        mCount: (d.match(/M /g) || []).length,
        hasQ: d.indexOf('Q') >= 0 || d.indexOf(' L') >= 0,
        len: d.length,
        head: d.slice(0, 60)
      });
    }
    const els = st.elements;
    const byType = {};
    let transparentBoth = 0, nan = 0, tiny = 0;
    for (const e of els) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.backgroundColor === 'transparent' && e.strokeColor === 'transparent') transparentBoth++;
      if (!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.width) || !isFinite(e.height)) nan++;
      if (e.width < 1 && e.height < 1) tiny++;
    }
    const big = els.slice().sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 14)
      .map(e => ({ t: e.type, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width),
                   h: Math.round(e.height), bg: e.backgroundColor, st: e.strokeColor,
                   pts: e.points ? e.points.length : 0 }));
    return { palette: st.tracedInfo, pathEls: paths.length, subs: subs.slice(0, 30),
             nEls: els.length, byType, transparentBoth, nan, tiny, big };
  });

  console.log(JSON.stringify(info, null, 1));
  require('fs').writeFileSync(path.join(__dirname, 'probe-out.json'), JSON.stringify(info, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
