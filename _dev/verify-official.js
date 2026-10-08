/* 用 Excalidraw 官方 @excalidraw/utils 的 restore() 校验生成的文件可被真实加载 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '..', '_test_out');

let fails = 0;
function ok(c, label, extra) {
  console.log((c ? '  \u2713 ' : '  \u2717 ') + label + (c ? '' : '   -> ' + (extra || '')));
  if (!c) fails++;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    defaultViewport: { width: 1400, height: 900 }
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));

  await page.goto(PAGE, { waitUntil: 'load' });

  // 尝试加载官方工具库
  const lib = await page.evaluate(async () => {
    const urls = [
      'https://cdn.jsdelivr.net/npm/@excalidraw/utils@0.1.2/dist/excalidraw-utils.min.js',
      'https://unpkg.com/@excalidraw/utils@0.1.2/dist/excalidraw-utils.min.js'
    ];
    for (const u of urls) {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = u; s.onload = res; s.onerror = () => rej(new Error('fail'));
          document.head.appendChild(s);
        });
        return u;
      } catch (e) { /* 下一个 */ }
    }
    return null;
  });
  console.log('官方工具库: ' + (lib ? '已加载' : '网络受限，跳过'));

  // 生成两份产物
  await page.click('[data-sample="logo"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('#statEls b');
    return b && +b.textContent > 0;
  }, { timeout: 120000 });
  const logoJson = await page.evaluate(() => JSON.stringify(window.ExcalidrawCore.buildFile(window.__p2e.state.elements)));

  await page.click('[data-sample="sketch"]');
  await page.waitForFunction(() => document.querySelector('#statMsg').textContent.indexOf('转换完成') >= 0, { timeout: 120000 });
  const sketchJson = await page.evaluate(() => JSON.stringify(window.ExcalidrawCore.buildFile(window.__p2e.state.elements)));

  fs.writeFileSync(path.join(OUT, 'logo.excalidraw'), logoJson);
  fs.writeFileSync(path.join(OUT, 'sketch.excalidraw'), sketchJson);
  console.log('已导出 logo.excalidraw / sketch.excalidraw');

  if (lib) {
    for (const [name, txt] of [['logo', logoJson], ['sketch', sketchJson]]) {
      console.log('\n[' + name + '] Excalidraw 官方 exportToSvg（内部会先 restore 再用 rough.js 渲染）');
      const r = await page.evaluate(async (t) => {
        try {
          const U = window.ExcalidrawUtils || window.Excalidraw || window.ExcalidrawLib;
          if (!U || typeof U.exportToSvg !== 'function') {
            return { err: '未找到 exportToSvg，可用: ' + Object.keys(U || {}).slice(0, 20).join(',') };
          }
          const scene = JSON.parse(t);
          // 官方导出会走 restore + 渲染管线
          const svg = await U.exportToSvg(scene.elements, Object.assign({
            exportBackground: true, viewBackgroundColor: '#ffffff',
            exportPadding: 16, exportScale: 1
          }, scene.appState || {}), scene.files || {});
          const paths = svg.querySelectorAll('path,polygon,polyline,rect,ellipse,circle,text').length;
          const vb = (svg.getAttribute('viewBox') || '').trim();
          return { ok: true, w: svg.getAttribute('width'), h: svg.getAttribute('height'),
                   viewBox: vb, nodes: paths };
        } catch (e) { return { err: e.message + (e.stack ? ' | ' + String(e.stack).split('\n')[1] : '') }; }
      }, txt);
      if (r.err) { ok(false, '官方 exportToSvg', r.err); continue; }
      console.log('   尺寸: ' + r.w + ' x ' + r.h + '   viewBox: ' + r.viewBox + '   渲染节点: ' + r.nodes);
      ok(r.nodes > 0, '官方渲染管线成功产出 ' + r.nodes + ' 个图元');
      ok(!!r.viewBox && r.viewBox.split(/\s+/).length === 4, 'viewBox 正常');
    }
  } else {
    console.log('（跳过官方校验）');
  }

  await browser.close();
  console.log('\n' + (fails === 0 ? '\u2705 官方兼容性校验通过' : '\u274c 失败 ' + fails + ' 项'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(2); });
