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
  await page.click('[data-sample="logo"]');
  await page.waitForFunction(() => { const b = document.querySelector('#statEls b'); return b && +b.textContent > 0; }, { timeout: 120000 });

  const info = await page.evaluate(() => {
    const els = window.__p2e.state.elements;
    const first = els.find(e => e.backgroundColor && e.backgroundColor !== 'transparent');
    const svg = document.querySelector('#paneExcalidraw svg');
    const out = { first, svgChildren: [] };
    if (svg) {
      for (const c of Array.from(svg.children).slice(0, 10)) {
        out.svgChildren.push({
          tag: c.tagName,
          fill: c.getAttribute('fill'),
          stroke: c.getAttribute('stroke'),
          opacity: c.getAttribute('opacity'),
          fillOpacity: c.getAttribute('fill-opacity'),
          strokeWidth: c.getAttribute('stroke-width'),
          d: (c.getAttribute('d') || '').slice(0, 60)
        });
      }
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
