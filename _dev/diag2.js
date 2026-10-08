/* 诊断：traceRegions 是否工作 + convert 后真实管线数据 */
(function () {
  'use strict';
  const { launch } = require('puppeteer-core');
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.resolve(__dirname, '..');
  const OUT = path.resolve(ROOT, '..', '_test_out');
  const IMG = path.join(__dirname, 'user-hedgehog.png');

  const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p));

  async function main() {
    const browser = await launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 950 });

    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

    const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));

    // 1) 合成用例直接测 traceRegions
    const synthetic = await page.evaluate(() => {
      if (!window.ExcalidrawCore || typeof window.ExcalidrawCore.traceRegions !== 'function') {
        return { err: 'traceRegions 缺失, keys=' + Object.keys(window.ExcalidrawCore || {}).join(',') };
      }
      // 4x4: 左半 1, 右半 2, 下排 3
      const labels = new Int32Array([
        1, 1, 2, 2,
        1, 1, 2, 2,
        3, 3, 3, 3,
        3, 3, 3, 3
      ]);
      const loops = window.ExcalidrawCore.traceRegions(labels, 4, 4, 1);
      return {
        n: loops.length,
        detail: loops.map(l => ({ label: l.label, hole: l.hole, area: l.area, pts: l.pts.length }))
      };
    });

    // 2) 注入图片
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');
    await page.evaluate(async (du) => {
      const blob = await (await fetch(du)).blob();
      const file = new File([blob], 'h.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, dataUrl);
    await new Promise(r => setTimeout(r, 4000));

    // 3) 给 traceRegions 打补丁并手动 convert
    const diag = await page.evaluate(async () => {
      const C = window.ExcalidrawCore;
      const out = { trCalls: 0, trLoops: 0, rdpCalls: 0 };
      const origTR = C.traceRegions;
      C.traceRegions = function (labels, w, h, minArea) {
        out.trCalls++;
        const loops = origTR(labels, w, h, minArea);
        out.trLoops = loops.length;
        out.trSample = loops.slice(0, 5).map(l => ({ label: l.label, hole: l.hole, area: Math.round(l.area), npts: l.pts.length }));
        // 标签分布
        const tally = {};
        for (let i = 0; i < labels.length; i++) tally[labels[i]] = (tally[labels[i]] || 0) + 1;
        out.labelTally = Object.entries(tally).map(([k, v]) => ({ k: +k, v })).sort((a, b) => b.v - a.v).slice(0, 8);
        return loops;
      };
      const st = window.__p2e.state;
      out.hasImage = !!st.imageData;
      out.imgDims = st.imageData ? (st.imageData.width + 'x' + st.imageData.height) : '';
      const s = window.__p2e.settings();
      out.settings = { fidelity: s.fidelity, mode: s.mode, colorCount: s.colorCount, pathomit: s.pathomit, blur: s.blur, detail: s.detail, removeBg: s.removeBg, bgColor: s.bgColor };
      try {
        await window.__p2e.convert();
      } catch (e) {
        out.convertErr = e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n');
      }
      out.after = {
        elements: st.elements.length,
        tracedInfo: st.tracedInfo,
        svgLen: (st.tracedSvg || '').length,
        ms: st.lastMs,
        warnings: st.warnings
      };
      return out;
    });

    const report = { synthetic, diag, errors };
    fs.writeFileSync(path.join(__dirname, 'diag2-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }

  main().catch(e => { console.error('FATAL', e); process.exit(1); });
})();
