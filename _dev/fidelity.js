/* 保真度诊断：用一张"难题"图量化 PNG→SVG→Excalidraw 两段误差
 * 用法: node fidelity.js [tag]
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '..', '_test_out');
const TAG = process.argv[2] || 'now';
fs.mkdirSync(OUT, { recursive: true });

const SCENES = {
  // 刻意做出细线、圆环孔洞、小字、尖角、曲线、渐变
  hard: `
    const W=900,H=620, cv=document.createElement('canvas');
    cv.width=W; cv.height=H;
    const c=cv.getContext('2d');
    c.fillStyle='#ffffff'; c.fillRect(0,0,W,H);

    // 1) 1px 细线 + 1.5px 斜细线（考验边缘还原）
    c.strokeStyle='#1b2430'; c.lineWidth=1;
    c.beginPath(); c.moveTo(40,40); c.lineTo(860,40); c.stroke();
    c.lineWidth=1.5;
    c.beginPath(); c.moveTo(40,58); c.lineTo(860,110); c.stroke();
    c.lineWidth=2;
    c.beginPath(); c.moveTo(40,128); c.lineTo(860,128); c.stroke();

    // 2) 圆环（孔洞：填错就变成实心圆盘）
    c.fillStyle='#e8590c';
    c.beginPath(); c.arc(150,260,90,0,Math.PI*2); c.fill();
    c.fillStyle='#ffffff';
    c.beginPath(); c.arc(150,260,52,0,Math.PI*2); c.fill();

    // 3) 圆环描边（1.5px）
    c.strokeStyle='#2f9e44'; c.lineWidth=1.5;
    c.beginPath(); c.arc(150,480,62,0,Math.PI*2); c.stroke();

    // 4) 细描边圆（2px）+ 尖角星
    c.strokeStyle='#1864ab'; c.lineWidth=2;
    c.beginPath(); c.arc(370,200,72,0,Math.PI*2); c.stroke();
    c.fillStyle='#f7b500';
    (function(){ c.beginPath();
      for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5; const r=i%2?32:80;
        const x=370+Math.cos(a)*r,y=200+Math.sin(a)*r; i?c.lineTo(x,y):c.moveTo(x,y);}
      c.closePath(); c.fill(); })();

    // 5) 小圆角矩形 + 小字（字号很小）
    c.fillStyle='#7048e8';
    c.beginPath();
    const x0=280,y0=350,w0=210,h0=120,r0=10;
    c.moveTo(x0+r0,y0); c.arcTo(x0+w0,y0,x0+w0,y0+h0,r0);
    c.arcTo(x0+w0,y0+h0,x0,y0+h0,r0); c.arcTo(x0,y0+h0,x0,y0,r0);
    c.arcTo(x0,y0,x0+w0,y0,r0); c.closePath(); c.fill();
    c.fillStyle='#ffffff';
    c.font='700 15px Arial'; c.textAlign='center';
    c.fillText('AaBbCc 0123', 385, 400);
    c.font='400 11px Arial';
    c.fillText('细字测试 fine text', 385, 425);
    c.font='700 24px Arial';
    c.fillText('Bg!', 385, 456);

    // 6) 8px 小方块阵列（考验小元素保留）
    c.fillStyle='#0b7285';
    for(let i=0;i<9;i++){ c.fillRect(560+i*13, 350, 8, 8); }
    for(let i=0;i<9;i++){ c.fillRect(560+i*13, 368, 8, 8); }

    // 7) 渐变矩形（取均值近似）
    const g=c.createLinearGradient(520,420,760,420);
    g.addColorStop(0,'#e03131'); g.addColorStop(1,'#1971c2');
    c.fillStyle=g; c.fillRect(520,420,240,110);

    // 8) 贝塞尔曲线（考验曲线保真）
    c.strokeStyle='#c2255c'; c.lineWidth=2.5;
    c.beginPath(); c.moveTo(560,560);
    c.bezierCurveTo(610,500, 700,620, 760,555);
    c.stroke();

    // 9) 同心细环（0.8px 抗锯齿导致的锯齿）
    c.strokeStyle='#495057';
    for(let k=0;k<5;k++){ c.lineWidth=1; c.beginPath(); c.arc(820,230,20+k*9,0,Math.PI*2); c.stroke(); }

    return cv.toDataURL('image/png');
  `,
  // 线稿：黑白
  line: `
    const W=800,H=560, cv=document.createElement('canvas');
    cv.width=W; cv.height=H;
    const c=cv.getContext('2d');
    c.fillStyle='#ffffff'; c.fillRect(0,0,W,H);
    c.strokeStyle='#1a1a1a'; c.lineCap='round'; c.lineJoin='round';
    c.lineWidth=2;
    c.strokeRect(60,60,220,120);
    c.beginPath(); c.ellipse(430,120,110,66,0,0,7); c.stroke();
    c.beginPath(); c.moveTo(620,60); c.lineTo(710,120); c.lineTo(620,182); c.lineTo(530,120); c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(290,120); c.lineTo(320,120); c.stroke();
    // 手写感曲线
    c.beginPath(); c.moveTo(60,300);
    for(let x=60;x<=740;x+=4){ c.lineTo(x, 330+Math.sin(x/26)*26+Math.cos(x/11)*5); }
    c.stroke();
    // 小字
    c.font='700 20px Arial'; c.textAlign='center';
    c.fillText('步骤 ① ② ③', 400, 440);
    c.font='400 14px Arial';
    c.fillText('lowercase text sample 0O1lI', 400, 480);
    // 网格线（细）
    c.lineWidth=1;
    for(let i=0;i<12;i++){ c.beginPath(); c.moveTo(560+i*16,360); c.lineTo(560+i*16,400); c.stroke(); }
    return cv.toDataURL('image/png');
  `
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE, { waitUntil: 'load' });

  const report = {};

  for (const scene of Object.keys(SCENES)) {
    const dataUrl = await page.evaluate('(function(){' + SCENES[scene] + '})()');
    fs.writeFileSync(path.join(OUT, `F-${TAG}-${scene}-source.png`),
      Buffer.from(dataUrl.split(',')[1], 'base64'));

    await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'probe.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, dataUrl);

    await page.waitForFunction(() => {
      const m = document.querySelector('#statMsg').textContent;
      return m.indexOf('转换完成') >= 0 || m.indexOf('失败') >= 0;
    }, { timeout: 180000 });
    await new Promise(r => setTimeout(r, 500));

    // ---- 量化：把 traced SVG / Excalidraw 元素栅格化，与原图逐像素比较
    const metrics = await page.evaluate(async () => {
      const st = window.__p2e.state;
      const W = st.imgW, H = st.imgH;

      // 参考图：预处理后的原图（透明合成到白底）
      const ref = document.createElement('canvas');
      ref.width = W; ref.height = H;
      const rc = ref.getContext('2d', { willReadFrequently: true });
      rc.fillStyle = '#ffffff'; rc.fillRect(0, 0, W, H);
      rc.putImageData(st.imageData, 0, 0);
      const refData = rc.getImageData(0, 0, W, H).data;

      function rasterize(svgText) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const cc = cv.getContext('2d', { willReadFrequently: true });
            cc.fillStyle = '#ffffff'; cc.fillRect(0, 0, W, H);
            cc.drawImage(img, 0, 0, W, H);
            try { resolve(cc.getImageData(0, 0, W, H).data); }
            catch (e) { resolve(null); }
          };
          img.onerror = () => resolve(null);
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        });
      }

      function diff(a, b) {
        if (!a || !b) return null;
        let sum = 0, n = 0, big = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          sum += d; n++;
          if (d > 48) big++;
        }
        const mae = sum / n;
        const psnr = mae < 0.01 ? 99 : 20 * Math.log10(255 / Math.sqrt(sum / n * (sum / n) === 0 ? 1 : 1));
        return { mae: +mae.toFixed(2), badPct: +(big / n * 100).toFixed(2) };
      }

      const svgPix = await rasterize(st.tracedSvg);

      // Excalidraw 元素 → 精确渲染（roughness 全部视为 0 的等效：直接画折线）
      const out = window.ExcalidrawPreview.render(st.elements, { rough: false, padding: 0 });
      const bb = out.svg.getAttribute('viewBox').split(' ').map(Number);
      // 去掉 padding：把 viewBox 改成元素实际范围
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const e of st.elements) {
        mnx = Math.min(mnx, e.x); mny = Math.min(mny, e.y);
        mxx = Math.max(mxx, e.x + e.width); mxy = Math.max(mxy, e.y + e.height);
      }
      out.svg.setAttribute('viewBox', [mnx, mny, Math.max(0.01, mxx - mnx), Math.max(0.01, mxy - mny)].join(' '));
      const excPix = await rasterize(new XMLSerializer().serializeToString(out.svg));

      // 元素统计
      const byType = {};
      let pts = 0;
      for (const e of st.elements) {
        byType[e.type] = (byType[e.type] || 0) + 1;
        if (e.points) pts += e.points.length;
      }

      return {
        W, H,
        svg: diff(refData, svgPix),
        exc: diff(refData, excPix),
        elements: st.elements.length,
        byType, pts,
        colors: (st.tracedInfo && st.tracedInfo.colors) || 0,
        paths: (st.tracedInfo && st.tracedInfo.paths) || 0
      };
    });

    report[scene] = metrics;
    console.log(`\n[${scene}]  ${metrics.W}x${metrics.H}  元素 ${metrics.elements}  点 ${metrics.pts}  色 ${metrics.colors}`);
    console.log('  类型分布 ' + JSON.stringify(metrics.byType));
    console.log('  PNG→SVG   MAE=' + (metrics.svg ? metrics.svg.mae : 'n/a') +
                '   明显偏差像素=' + (metrics.svg ? metrics.svg.badPct + '%' : 'n/a'));
    console.log('  SVG→EXC   MAE=' + (metrics.exc ? metrics.exc.mae : 'n/a') +
                '   明显偏差像素=' + (metrics.exc ? metrics.exc.badPct + '%' : 'n/a'));

    // 截图
    await page.evaluate(() => { document.querySelector('#viewTabs button[data-view="original"]').click(); });
    await new Promise(r => setTimeout(r, 350));
    await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, `F-${TAG}-${scene}-1-original.png`) }));
    await page.evaluate(() => { document.querySelector('#viewTabs button[data-view="svg"]').click(); });
    await new Promise(r => setTimeout(r, 350));
    await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, `F-${TAG}-${scene}-2-svg.png`) }));
    await page.evaluate(() => { document.querySelector('#viewTabs button[data-view="excalidraw"]').click(); });
    await new Promise(r => setTimeout(r, 500));
    await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, `F-${TAG}-${scene}-3-exc-rough.png`) }));
    await page.evaluate(() => {
      const el = document.querySelector('#roughPreview');
      el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 450));
    await page.$('#canvasWrap').then(n => n.screenshot({ path: path.join(OUT, `F-${TAG}-${scene}-4-exc-exact.png`) }));
    await page.evaluate(() => {
      const el = document.querySelector('#roughPreview');
      el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 300));
  }

  fs.writeFileSync(path.join(OUT, `F-${TAG}-metrics.json`), JSON.stringify(report, null, 2));
  if (errs.length) console.log('\nJS 错误: ' + JSON.stringify(errs.slice(0, 5)));
  console.log('\n完成 → ' + OUT);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
