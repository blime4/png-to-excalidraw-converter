/* 分析导出文件：元素创建顺序 vs index 排序，找出遮挡关系 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', '_test_out', 'hedgehog.excalidraw');
if (!fs.existsSync(FILE)) {
  console.log('MISSING ' + FILE);
  process.exit(1);
}
const scene = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const els = scene.elements;

function bboxArea(el) {
  if (el.type === 'line' && el.points) {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of el.points) {
      mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]);
      mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]);
    }
    return (mxx - mnx) * (mxy - mny);
  }
  return el.width * el.height;
}

const rows = els.map((el, i) => ({
  i,
  id: el.id.slice(0, 6),
  idx: el.index,
  type: el.type,
  fill: el.backgroundColor,
  stroke: el.strokeColor,
  w: Math.round(el.width),
  h: Math.round(el.height),
  area: Math.round(bboxArea(el)),
  x: Math.round(el.x),
  y: Math.round(el.y),
  npts: el.points ? el.points.length : 0,
  poly: el.polygon === true
}));

// index 字典序是否与数组顺序一致
const byIdx = rows.slice().sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : 0));
let mismatch = 0;
for (let i = 0; i < byIdx.length; i++) if (byIdx[i].i !== i) mismatch++;

const out = {
  total: els.length,
  indexOrderMatchesArray: mismatch === 0,
  mismatches: mismatch,
  firstIndex: rows[0] && rows[0].idx,
  lastIndex: rows[rows.length - 1] && rows[rows.length - 1].idx,
  indexLen: rows[0] ? rows[0].idx.length : 0,
  // 按绘制顺序列出（数组顺序）
  order: rows.map(r => `${r.i} idx=${r.idx} ${r.type} fill=${r.fill} ${r.w}x${r.h} area=${r.area} @(${r.x},${r.y}) pts=${r.npts}`)
};
fs.writeFileSync(path.join(__dirname, 'order-report.json'), JSON.stringify(out, null, 1));
console.log('OK total=' + els.length + ' indexOrderOK=' + (mismatch === 0));
