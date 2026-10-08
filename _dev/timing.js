/* 计时探针：不同分辨率/参数下 ImageTracer 的耗时 */
const path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 900, height: 700 }
  });
  const page = await browser.newPage();
  await page.goto('file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });

  const rows = await page.evaluate(() => {
    const out = [];
    // 画一张中等复杂度的图作为基准
    function makeImg(W, H) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
      for (let i = 0; i < 40; i++) {
        c.fillStyle = 'hsl(' + (i * 37) + ',70%,55%)';
        c.beginPath(); c.arc(Math.random() * W, Math.random() * H, 10 + Math.random() * 50, 0, 7); c.fill();
      }
      c.font = '700 30px Arial'; c.fillStyle = '#333';
      c.fillText('Timing probe 0123', 40, 80);
      return c.getImageData(0, 0, W, H);
    }
    for (const dim of [900, 1400, 1800, 2400]) {
      const imgd = makeImg(dim, Math.round(dim * 0.68));
      for (const cycles of [3, 6, 10]) {
        const opts = { ltres: 0.15, qtres: 0.15, pathomit: 2, rightangleenhance: false,
          colorsampling: 2, numberofcolors: 16, mincolorratio: 0, colorquantcycles: cycles,
          layering: 0, strokewidth: 1, linefilter: false, scale: 1, roundcoords: 2,
          viewbox: false, desc: false, lcpr: 0, qcpr: 0, blurradius: 0, blurdelta: 20 };
        const t0 = performance.now();
        const td = ImageTracer.imagedataToTracedata(imgd, opts);
        const ms = Math.round(performance.now() - t0);
        let n = 0; for (const l of td.layers) n += l.length;
        out.push({ dim, cycles, ms, paths: n, colors: td.palette.length });
      }
    }
    return out;
  });

  for (const r of rows) console.log(`${r.dim}px  cycles=${r.cycles}  ${r.ms} ms  paths=${r.paths} colors=${r.colors}`);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
