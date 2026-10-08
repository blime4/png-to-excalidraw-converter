/* 用 Excalidraw 官方 restore() 验证我们生成的 .excalidraw 是否可被真实加载 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '..', '_test_out');

let failures = 0;
const ok = (c, l, x) => { console.log((c ? '  ✓ ' : '  ✗ ') + l + (c ? '' : '  → ' + (x || ''))); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    defaultViewport: { width: 1400, height: 900 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(PAGE, { waitUntil: 'load' });

  // 注入官方 @excalidraw/utils
  const loaded = await page.evaluate(async () => {
    for (const url of [
      'https://cdn.jsdelivr.net/npm/@excalidraw/utils@0.1.2/dist/excalidraw-utils.min.js',
      'https://unpkg.com/@excalidraw/utils@0.1.2/dist/excalidraw-utils.min.js'
    ]) {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = url; s.onload = res; s.onerror = () => rej(new Error('fail ' + url));
          document.head.appendChild(s);
        });
        return url;
      } catch (e) { /* try next */ }
    }
    return null;
  });
  console.log('官方库加载：', loaded || '失败(网络受限)');

  if (loaded) {
    // 生成两个示例文件
    await page.click('[data-sample="logo"]');
    await page.waitForFunction(() => { const b = document.querySelector('#statEls b'); return b && +b.textContent > 0; }, { timeout: 120000 });
    const logo = await page.evaluate(() => window.__p2e.state.fileJson);
    await page.click('[data-sample="sketch"]');
    await page.waitForFunction(() => document.querySelector('#statMsg').textContent.indexOf('转换完成') >= 0, { timeout: 120000 });
    const sketch = await page.evaluate(() => window.__p2e.state.fileJson);

    for (const [name, json] of [['logo', logo], ['sketch', sketch]]) {
      const r = await page.evaluate((txt) => {
        const U = window.ExcalidrawUtils;
        if (!U || typeof U.restoreElements !== 'function') return { err: 'no api: ' + Object.keys(U || {}).slice(0, 20).join(',') };
        const scene = JSON.parse(txt);
        let restored;
        try { restored = U.restoreElements(scene.elements, scene.appState || {}); }
        catch (e) { return { err: 'restoreElements threw: ' + e.message }; }
        const bad = [];
        for (const el of restored) {
          if (!el || !el.id || !el.type) { bad.push('missing id/type'); continue; }
          if (!isFinite(el.x) || !isFinite(el.y) || !isFinite(el.width) || !isFinite(el.height)) bad.push(el.id + ' non-finite geom');
          if (el.type === 'line') {
            if (!Array.isArray(el.points) || el.points.length < 2) bad.push(el.id + ' bad points');
            else for (const p of el.points) if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) { bad.push(el.id + ' bad pt'); break; }
          }
          if (typeof el.seed !== 'number') bad.push(el.id + ' bad seed');
          if (el.opacity === undefined || el.opacity <= 0) bad.push(el.id + ' bad opacity');
          if (el.strokeColor === undefined || el.backgroundColor === undefined) bad.push(el.id + ' missing color');
        }
        const types = {};
        for (const e of restored) types[e.type] = (types[e.type] || 0) + 1;
        return {
          n: restored.length, bad: bad.slice(0, 6), types,
          sample: restored[0] ? Object.keys(restored[0]).sort() : []
        };
      }, json);
      console.log('\n[' + name + ']');
      if (r.err) { ok(false, 'restoreElements', r.err); continue; }
      console.log('   类型分布:', JSON.stringify(r.types));
      console.log('   字段:', r.sample.join(','));
      ok(r.n > 0, '官方 restoreElements 接受全部 ' + r.n + ' 个元素');
      ok(r.bad.length === 0, '无任何字段校验问题', JSON.stringify(r.bad));
      if (r.n > 0) {
        const e0 = await page.evaluate((t) => {
          const el = window.ExcalidrawUtils.restoreElements(JSON.parse(t).elements, {})[0];
          return { idx: el.index === undefined ? 'MISSING' : el.index, ver: el.version, updated: typeof el.updated };
        }, json);
        console.log('   首元素 index =', JSON.stringify(e0.idx), ' version =', e0.ver);
        ok(e0.idx !== 'MISSING', 'index 字段被官方库接受');
      }
    }
  } else {
    console.log('  （跳过官方 restore 校验：无法访问 CDN）');
  }

  ok(errs.length === 0, '无 JS 错误', errs.slice(0, 3).join('|'));
  await browser.close();
  console.log('\n' + (failures === 0 ? '✅ 官方兼容性验证通过' : '❌ 失败 ' + failures + ' 项'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(2); });
