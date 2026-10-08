/* 用 Excalidraw 官方库真实渲染我们的产物，检查眼睛/鼻子是否出现 */
(function () {
  'use strict';
  const { launch } = require('puppeteer-core');
  const fs = require('fs');
  const path = require('path');

  const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  const BUNDLE = path.join(__dirname, 'vendor', 'excalidraw-0.17.6.js');
  const SCENE = path.resolve(__dirname, '..', '..', '_test_out', 'hedgehog.excalidraw');
  const OUT = path.resolve(__dirname, '..', '..', '_test_out');

  async function main() {
    const scene = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
    const browser = await launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200 });
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(__dirname, 'vendor', 'react.js') });
    await page.addScriptTag({ path: path.join(__dirname, 'vendor', 'react-dom.js') });
    await page.addScriptTag({ path: BUNDLE });
    await new Promise(r => setTimeout(r, 600));

    const info = await page.evaluate(async (elsJson) => {
      const out = { hasLib: false, keys: [] };
      const U = window.ExcalidrawLib;
      if (!U) return { err: 'ExcalidrawLib 未挂载' };
      out.hasLib = true;
      out.keys = Object.keys(U).slice(0, 40);
      const elements = JSON.parse(elsJson);
      try {
        const svg = await U.exportToSvg({
          elements: elements,
          appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportPadding: 10 },
          files: {}
        });
        const host = document.createElement('div');
        host.id = 'host';
        host.style.cssText = 'background:#fff;display:inline-block;padding:0';
        document.body.style.margin = '0';
        document.body.appendChild(host);
        svg.setAttribute('width', '820');
        svg.removeAttribute('height');
        host.appendChild(svg);
        out.svgLen = svg.outerHTML.length;
        return out;
      } catch (e) {
        return { err: 'exportToSvg: ' + e.message, keys: out.keys };
      }
    }, JSON.stringify(scene.elements));

    const report = { info, errors };
    if (!info.err) {
      try {
        await page.screenshot({ path: path.join(OUT, 'OFFICIAL-render.png'), fullPage: true });
        report.shot = 'OFFICIAL-render.png';
      } catch (e) { report.shotErr = e.message; }
    }
    fs.writeFileSync(path.join(__dirname, 'official-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }

  main().catch(e => { console.error('FATAL', e); process.exit(1); });
})();
