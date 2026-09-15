// color-matrix.js
// 角色"变异 / 染色"颜色矩阵滤镜工具（与 color-matrix-filter-demo_2.html 同源机制）。
//
// 机制：用 SVG <filter><feColorMatrix type="matrix"></filter> 经 CSS `filter: url(#id)`
// 套到角色立绘容器上。相比直接改每个 canvas 像素，SVG 滤镜是非破坏性、GPU 加速、且能
// 覆盖【身体 canvas + 全部纸娃娃/装备叠加层】整体（套在 _bodyWrap 上）。
//
// 矩阵为 4×5（20 个数）：前 4 列是 R/G/B/A 的线性组合系数（1.0=不变），第 5 列是偏移量。
// 注意 feColorMatrix 的第 5 列偏移是 0..1 的小数（= 0..255 的归一化），故写入 SVG 时偏移要 /255。
//
// 后续"变异(换色)系统"对接点：
//   · 变异：dealWithVariation(variation) → 调色板索引 → 取 selectedColorArray[key][i].value 矩阵；
//   · 染色：玩家选色 → ridePetChangeColor 协议 → 矩阵。
// 本模块只提供底层"套一个矩阵"能力 + 生成不同颜色的辅助函数，业务判定交给调用方。

// 单位矩阵（无变化）
export const IDENTITY = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
// Default variant matrix (config/variant.json absent or malformed fallback):
//   R unchanged; G += 0.20R; B += 0.50R + 1.00G. Tunable in config/variant.json.
export const DEFAULT_VARIANT_MATRIX = [1,0,0,0,0, 0.20,1,0,0,0, 0.50,1,1,0,0, 0,0,0,1,0];
// pick variant matrix from a config object (Config.variant): validate 20 finite numbers, else default
export function resolveVariantMatrix(cfg) {
  const m = cfg && cfg.matrix;
  if (Array.isArray(m) && m.length === 20 && m.every(v => Number.isFinite(+v))) return m.map(v => +v);
  return DEFAULT_VARIANT_MATRIX;
}
// 写入 SVG 时第 5 列(偏移)的默认值（0，不变）
const IDENTITY_SVG = IDENTITY.map((v,i)=> (i % 5 === 4) ? 0 : v).join(' ');

// 20 元矩阵 → SVG values 字符串（第 5 列偏移 /255，因 feColorMatrix 偏移是 0..1）
export function toSVGValues(m) {
  return m.map((v, i) => (i % 5 === 4) ? +(v / 255).toFixed(6) : v).join(' ');
}

// 矩阵乘法（4×5 × 4×5，标准颜色矩阵乘法；参考 demo multiplyColorMatrix）
export function multiplyColorMatrix(a, b) {
  const out = new Array(20);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 5 + k] * b[k * 5 + c];
      if (c === 4) s += a[r * 5 + 4];
      out[r * 5 + c] = s;
    }
  }
  return out;
}

// HSB 旋转矩阵（port 自 demo createHSBMatrix）：hue 角度、sat 0..2、lumOffset 偏移量(0..255 量级)
export function hsbMatrix(hue, sat = 1, lumOffset = 0) {
  const angle = hue * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rw = 0.213, gw = 0.715, bw = 0.072;
  const hueMat = [
    rw + c * (1 - rw) + s * (-rw),    gw + c * (-gw) + s * (-gw),     bw + c * (-bw) + s * (1 - bw),  0, 0,
    rw + c * (-rw) + s * (0.143),   gw + c * (1 - gw) + s * (0.140),  bw + c * (-bw) + s * (-0.283),0, 0,
    rw + c * (-rw) + s * (-(1 - rw)), gw + c * (-gw) + s * (gw),      bw + c * (1 - bw) + s * (bw),   0, 0,
    0, 0, 0, 1, 0
  ];
  const invSat = 1 - sat;
  const satMat = [
    invSat * rw + sat, invSat * gw,       invSat * bw,       0, 0,
    invSat * rw,       invSat * gw + sat, invSat * bw,       0, 0,
    invSat * rw,       invSat * gw,       invSat * bw + sat, 0, 0,
    0, 0, 0, 1, 0
  ];
  let finalMat = multiplyColorMatrix(satMat, hueMat);
  finalMat[4]  += lumOffset;
  finalMat[9]  += lumOffset;
  finalMat[14] += lumOffset;
  return finalMat;
}

// 宠物变异/染色调色板（与 color-matrix-filter-demo_2.html 的 selectedColorArray.pet 同款）：
// 每项是 20 元 4×5 矩阵，用【通道增益 + 偏移】给模型上色（R/G/B 各自缩放加偏移）。
//
// ★ 为何不用 hsbMatrix 色相旋转：色相旋转矩阵的系数行和为 1 ⇒ 只旋转"彩色"，对灰色/低饱和像素
//   几乎无变化（灰→灰）。而游戏里很多模型（如野猫 300022）整体偏灰，用色相旋转会"看起来没变色"，
//   只有模型上饱和的发光/高光被旋转 → 表现为"变的是发光特效、模型没变"。故换厂通道增益调色板：
//   对角增益≠1 ⇒ 灰色也会被染成对应色调，任何模型都能明显变色。
export const PET_PALETTE = [
  [1.3,0,0,0,40,   0,0.8,0,0,0,    0,0,0.7,0,0,    0,0,0,1,0],   // 赤焰
  [1.2,0,0,0,30,   0,1.1,0,0,20,   0,0,0.6,0,0,    0,0,0,1,0],   // 金鳞
  [1.1,0,0,0,20,   0,0.7,0,0,0,    0,0,1.2,0,30,   0,0,0,1,0],   // 紫电
  [0.7,0,0,0,0,    0,1.2,0,0,20,   0,0,1.2,0,20,   0,0,0,1,0],   // 碧波
  [0.3,0.59,0.11,0,0, 0.3,0.59,0.11,0,0, 0.3,0.59,0.11,0,0, 0,0,0,1,0], // 墨黑
  [0.8,0,0,0,60,   0,0.8,0,0,60,   0,0,0.8,0,60,   0,0,0,1,0],   // 霜白
  [0.6,0,0,0,0,    0,0.7,0,0,0,    0,0,1.3,0,40,   0,0,0,1,0],   // 幽蓝
  [1.4,0,0,0,50,   0,1.0,0,0,10,   0,0,0.5,0,0,    0,0,0,1,0],   // 赤金
  [0.9,0.1,0.1,0,20, 0.1,0.9,0.1,0,20, 0.1,0.1,0.9,0,20, 0,0,0,1,0], // 幻彩
  [0.6,0,0,0,0,    0,1.3,0,0,40,   0,0,0.6,0,0,    0,0,0,1,0],   // 青翠（补足 10，绿调）
];

// 色相染色矩阵：按 hue 给 R/G/B 三通道设不同增益（灰→该色相色调），并按亮度归一化使平均亮度不变。
// 与纯 hsbMatrix 色相旋转的关键区别：色相旋转的通道行和为 1（灰→灰、无变化）；此处对角增益互不相等，
// 因此**即使是灰色模型也会被染成对应色调**，任何模型都能明显变色。用于"变异怪群"这类需要同屏多色区分的场景。
export function tintMatrix(hue, amp = 0.7) {
  const a = hue * Math.PI / 180;
  const gains = [Math.cos(a), Math.cos(a - 2 * Math.PI / 3), Math.cos(a + 2 * Math.PI / 3)].map(d => 1 + amp * d);
  const L = 0.213 * gains[0] + 0.715 * gains[1] + 0.072 * gains[2];   // Rec.709 亮度权重
  const g = gains.map(v => v / L);                                     // 归一化：保持灰度亮度
  return [g[0],0,0,0,0,  0,g[1],0,0,0,  0,0,g[2],0,0,  0,0,0,1,0];
}

// 变异配色：把 total 只怪均分色相环 → 互不相同、且对灰色模型也鲜明上色（10 只 = 红/橙/黄绿/绿/青/
// 蓝/紫/品红/粉…）。适合"变异怪群"同屏多色；正式"变异/染色系统"请改用 dealWithVariation + PET_PALETTE。
export function variantMatrix(i, total) {
  const t = Math.max(1, total || 1);
  return tintMatrix(((i % t) / t) * 360);
}

// ── 每 Fighter 一个独立 <filter> 元素（同一 feColorMatrix 只能存一组值，多怪不同色必须各用各的 id）──
// 所有 filter 挂在 document.body 下一个隐藏 <svg id="__cmfilters"> 容器里，按 id 引用。

export function ensureColorMatrixFilter(id) {
  let svg = document.getElementById('__cmfilters');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = '__cmfilters';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.left = '-9999px';
    svg.style.top = '0';
    svg.setAttribute('aria-hidden', 'true');
    document.body.appendChild(svg);
  }
  let filter = document.getElementById(id);
  if (!filter) {
    filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const fe = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    fe.setAttribute('values', IDENTITY_SVG);
    filter.appendChild(fe);
    svg.appendChild(filter);
  }
  return { filter, fe: filter.querySelector('feColorMatrix') };
}

export function removeColorMatrixFilter(id) {
  const f = document.getElementById(id);
  if (f && f.parentNode) f.parentNode.removeChild(f);
}
