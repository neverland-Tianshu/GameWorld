// char-origin.js —— 角色「美术原点(脚点)」推导（纯函数，无浏览器依赖，可 node 单测）
// ============================================================================
// 与普通 char 同源：主动画(pool) 的第 0 帧会用 pE(PlaceObject) 放若干【子精灵】，
// 角色本体就是这些子精灵 ⇒ 脚点 = 子精灵包围盒并集的「底边中心」。
//
// ★ 关键差异（本次修复的根因）：
//   普通 char 的子精灵是【矢量/紧贴】形状，其 rect 就是真实内容包围盒（实测 100000 各朝向留白 0~1px）。
//   而 Role/装饰物模型（无 const labels，如蟠龙图腾 210071）的子精灵是【整张位图填充】，
//   转换器给它的 rect = 位图矩形（含四周透明留白）。210071 位图 185×389，实际内容只有 154×341，
//   底部 46px 全是透明 ⇒ 直接取"子精灵 rect 并集底边"会把脚点算到空气里，模型整体浮空 46px。
//
//   而【主动画 pool 自己的 rect】是转换器给出的真实内容包围盒（210071 为 154×341，与 PNG 可见像素完全吻合）。
//   ⇒ 正确做法：脚点 = 「子精灵并集」∩「主动画 rect」的底边中心。
//     · 子精灵 rect 更大（位图留白）⇒ 被主动画 rect 截掉留白，脚点落到真实底边；
//     · 主动画 rect 更大（多帧动画的整段并集）⇒ 交集 = 子精灵并集，仍取第 0 帧静止姿态的脚，与普通 char 一致。
//
// 全量实测（206 个 Role 模型，以 PNG 可见像素为真值）：
//   旧(子精灵 rect 并集) 命中 79/206、平均误差 28.6px
//   pool.rect 底中        命中 108/206、平均误差 34.5px
//   本算法(交集)          命中 122/206、平均误差 13.0px   ← 最优，且退化案例 ≤2px
// ============================================================================

// 第 0 帧放置的子精灵：[{id, x, y}]（x/y 为 pE 的放置偏移，缺省 0）
export function frame0Children(dp, pool) {
  const d = dp && dp[pool];
  if (!d || !Array.isArray(d.frameActionList)) return null;
  for (const kf of d.frameActionList) {
    if (!Array.isArray(kf)) continue;
    const pe = kf.slice(1).filter(a => Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null);
    if (pe.length) return pe.map(a => ({ id: a[1].id, x: a[1].x || 0, y: a[1].y || 0 }));
  }
  return null;
}

function merge(a, b) {
  if (!a) return b; if (!b) return a;
  const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  return { x0, y0, x1, y1 };
}
function rectOf(r) {
  if (!r) return null;
  return { x0: r.x, y0: r.y, x1: r.x + (r.width || 0), y1: r.y + (r.height || 0) };
}

// 一个 def 的「子精灵内容包围盒」：叶子(SHAPE)取自身 rect；容器(MC)递归取第 0 帧子精灵并集
function contentRect(dp, id, depth) {
  if (depth > 8) return null;
  const d = dp[id];
  if (!d) return null;
  const kids = frame0Children(dp, id);
  if (!kids || !kids.length) return rectOf(d.rect);
  let u = null;
  for (const k of kids) {
    const c = contentRect(dp, k.id, depth + 1);
    if (!c) continue;
    u = merge(u, { x0: c.x0 + k.x, y0: c.y0 + k.y, x1: c.x1 + k.x, y1: c.y1 + k.y });
  }
  return u;
}

function intersect(a, b) {
  if (!a || !b) return null;
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0, y0, x1, y1 };
}

/**
 * 求主动画 pool 的美术原点(脚点)。
 * @returns {{x:number,y:number,top:number}|null}  x=脚底中心, y=脚底, top=内容顶（均为 pool 局部坐标）
 */
export function charFootOrigin(swfData, pool) {
  if (pool == null) return null;
  const dp = (swfData && swfData.definitionPool) || [];
  const def = dp[pool];
  if (!def) return null;
  // _rawRect = 转换器原始 rect（playChar 用 unionRectFor 覆盖 def.rect 前保留，见 loader.js）
  const clip = rectOf(def._rawRect || def.rect);
  let u = contentRect(dp, pool, 0);
  if (!u) u = clip;
  if (!u) return null;
  const r = intersect(u, clip) || u;
  return {
    x: +((r.x0 + r.x1) / 2).toFixed(1),
    y: +r.y1.toFixed(1),
    top: +r.y0.toFixed(1),
    // 供身体中心/包围盒使用：优先用交集（真实可见范围），否则用内容并集
    bodyX0: r.x0, bodyX1: r.x1, bodyY0: r.y0, bodyY1: r.y1
  };
}
