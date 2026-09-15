// loader.js
// 对应 deobfuscated/loaders/*（LoaderManager）+ animate/*（AnimateManager）+ cache/*（CacheManager）
// 职责：
//   1) 解析每个模型目录 index.html 里的"动作→definitionPool 下标"映射（角色用 const labels，特效/技能用 var GENERIC_MAIN）
//   2) 用 fanvas.play() 把 swfData 画到 <canvas>，imagePath 指向该模型的 images/ 目录（fanvas 自动 new Image() 预加载）
//   3) 缓存 swfData，避免重复下载解压

import { url, resolveAction } from './globals.js?v=20261007c';

// ── 角色脚点/锚点覆盖表（渲染池局部坐标）──
// 极少数无法用通用规则判定的模型才逐项覆盖（由 foot_calibrate.html 标定后回填）。
// 210071 现已被通用规则（无顶层 place + 内容居中于原点 ⇒ (0,0)）自动覆盖，此处保留作显式留档。
export const FOOT_OVERRIDE = {
  210071: { x: 0, y: 0 },       // 用户标定：单 Role 模型，锚点=符号原点(0,0)；rect 底边中心(38,40) 沉 40px 落影。
  // 以下 4 个为多动作(通用 char)模型：dp[0] 无顶层 place、站立池内容中心 cx≈250(≥128)，
  // 原本靠 rootAnchor ③(256,256) 兜底拿 256,256。删 ③ 兜底后显式钉回 (256,256)，避免被带成 (0,0)。
  // （user 2026-09-12：「190019/190020/190053/190054 这四个是锚点 256,256 的多动作模型，其余都应是 0,0」）
  190019: { x: 256, y: 256 },
  190020: { x: 256, y: 256 },
  190053: { x: 256, y: 256 },
  190054: { x: 256, y: 256 },
};

// ★★ 模型锚点单一真源（user 2026-09-11：「有的模型是单个 Role 精灵，它的定位要和技能定位一样找原点脚点」）★★
//
// 原理（原始 SWF 根时间轴取证）：转换模型渲染时以「某个动作池」为 rootDef 直接作根，丢掉了
// 原始根时间轴(dp[0])的整体偏移 ⇒ 必须把这个偏移补回来，才能让模型落在原版的位置上。
//
//   · 常规角色：dp[0] 顶层 PlaceObject 把角色精灵放在 (-256,-256)（= 半个 512 舞台），
//     使「精灵本地(256,256)」恰好对应舞台原点 ⇒ 锚点 = (256,256)。全量 1151 个模型属此类。
//   · 单个 Role 精灵（蟠龙图腾/传送法阵/装饰物/公告牌…）：dp[0] **没有**顶层 PlaceObject，
//     精灵自身就挂在根时间轴上 ⇒ 锚点 = 精灵本地(0,0)。这与技能/特效/状态动画的锚定口径
//     （loader.anchorOrigin 把 Flash 原点(0,0) 对齐到落点）完全一致 —— 即 user 说的"和技能定位一样"。
//
// 判据（可离线复算，脚本 _verify/scan_anchor_src.mjs）：
//   ① dp[0] 顶层 place == (-256,-256)              ⇒ (256,256)（常规角色，1151 个）
//   ② 否则，渲染池内容中心 |cx| < 128（内容以原点为中心）⇒ (0,0)（单 Role 精灵 + 已修正模型）
//   ③ 兜底已删（2026-09-12）：原 "无 place 仍按 256 约定" 一律改为 (0,0)。
//      例外：190019/190020/190053/190054 经 FOOT_OVERRIDE 显式钉 (256,256)（user 指定这四个多动作保持 256,256）。
// ★ 单 Role 盲推（user 2026-09-12：「role 盲推 0,0」）：resolveFoot 在 rootAnchor 之前再加一道闸——
//   凡「无命名动作」(hasNamed===false) 的模型一律 (0,0)，**覆盖规则① rootPlace**（常规角色 (256,256) 的由来）。
//   故 300732–300767 等 33 个单 Role（其 dp[0] 顶层 place 在 -256）现在也落到 (0,0)。
// 优先级：FOOT_OVERRIDE(显式钉) > 单 Role 盲推(0,0) > rootAnchor(结构判定)。
const ROLE_CX_GUARD = 128;

// 取某个 def 的「顶层 PlaceObject」（任意关键帧中第一个 pE）。返回 {x,y,id} 或 null。
function firstPlaceOf(d0) {
  if (!d0) return null;
  const lists = [];
  if (Array.isArray(d0.frameActionList)) lists.push(d0.frameActionList);
  const dl = d0.displayList || d0.frames;
  if (Array.isArray(dl)) lists.push(dl);
  for (const list of lists) {
    for (const fr of list) {
      if (!Array.isArray(fr)) continue;
      for (const a of fr) {
        if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) {
          const m = a[1].m || a[1].matrix;
          const x = (a[1].x != null) ? a[1].x : (Array.isArray(m) ? m[4] : 0);
          const y = (a[1].y != null) ? a[1].y : (Array.isArray(m) ? m[5] : 0);
          return { x: x || 0, y: y || 0, id: a[1].id };
        }
      }
    }
  }
  return null;
}

// 由动作表（loader.parseCharActions 的产物）抽取「动作池集合」——即 index.html 里 const labels 的全部 pool。
// 仅供 findRootTimelinePool 定位真根时间轴用；empty 的 label 也计入（它们同样指向真实存在的动作池）。
export function actionPoolSet(actions) {
  const s = new Set();
  if (actions) for (const k in actions) { const a = actions[k]; if (a && a.pool != null) s.add(a.pool); }
  return s;
}

// ★★ 定位「真根时间轴 def」（2026-09-17 修复 300692 类误判）
//
// 【背景】常规模型 dp[0] 就是原始根时间轴。但有 73 个模型（190019/190020 + 300623~300722 段 +
//   300768~300770 + 600103/600104）的 **dp[0] 是空壳**（totalFrames:1 / rect 0×0 / 无动画数据），
//   转换器把真正的根时间轴 **append 到了数组末尾**（实测 73/73 全中）——它们的顶层 place 仍是
//   (-256,-256)，信息完好，只是 topLevelPlace 原先只读 dp[0] 而看不见它。
//   ⇒ 规则① 恒不命中 → 规则② (|cx|<128 用「内容包围盒中心」) 也不命中 → 规则③ 已于 2026-09-12 删除
//     ⇒ 一路落到末行 return (0,0)/'roleOrigin'，锚点被错钉为符号原点（正确值应为 (256,256)，差 256px）。
//   受害面实测：全量 1428 个模型中 73 个（其中 190019/190020 曾被 FOOT_OVERRIDE 手动钉住，约 71 个裸奔）。
//
// 【判据】真根时间轴 def 的特征：它的 frameActionList 里 pE 引用的正是**各动作池**。
//   ⇒ 某 def 的 pE 引用 id 命中「动作池集合」的个数 ≥ min(2, 池集大小) 即认定为根时间轴。
//   可靠性：动作池的 pE 引用的是 Shape（不是其它动作池），故只有根时间轴能同时命中多个池；
//   离线可复算（见 _verify/_scan_rootdef_index.mjs，73/73 的命中数恰等于 labels 的 pool 总数）。
export function findRootTimelinePool(sd, poolSet) {
  const dp = sd && sd.definitionPool;
  if (!dp || !poolSet || !poolSet.size) return -1;
  const need = Math.min(2, poolSet.size);
  for (let i = 0; i < dp.length; i++) {
    const d = dp[i];
    if (!d || !Array.isArray(d.frameActionList) || !d.frameActionList.length) continue;
    const ids = new Set();
    for (const kf of d.frameActionList) {
      if (!Array.isArray(kf)) continue;
      for (const a of kf.slice(1)) if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) ids.add(a[1].id);
    }
    if (ids.size < need) continue;
    let hit = 0; for (const id of ids) if (poolSet.has(id)) hit++;
    if (hit >= need) return i;
  }
  return -1;
}

// 原始根时间轴的顶层 PlaceObject。返回 {x,y,id} 或 null。
// ★ 2026-09-17：新增可选 poolSet（动作池集合，来自 loader.actionPoolSet(rec.actions)）。
//   取值顺序（**顺序即成败，勿改成"根 def 优先"**）：
//     ① 先读 dp[0]。常规模型 dp[0] 就是原始根时间轴（其 place 承载 512 舞台归一化偏移），
//        实测 1159 个模型属此类 ⇒ 行为与旧版逐位一致，零回归。
//        ⚠ 不能改成"先定位放动作池的 def"：实测有 239 个模型是 `dp[0] → 中间 MC → 动作池` 的三层结构，
//          "放动作池的 def"只是**中间层**（place 非 -256,-256），优先读它会把这 239 个正确判定打回 (0,0)。
//     ② 仅当 dp[0] **取不到**任何 pE 时才动用 poolSet：定位「真根时间轴 def」并取其 place ——
//        这批模型（72 个）的 dp[0] 是空壳，根时间轴被转换器 append 到数组末尾，info 完好只是位置不同。
//   定位失败时（无 poolSet / labels 为空的真单 Role 185 个）返回 null，与旧版一致。
export function topLevelPlace(sd, poolSet) {
  const dp = sd && sd.definitionPool;
  if (!dp) return null;
  const p0 = firstPlaceOf(dp[0]);
  if (p0) return p0;
  if (poolSet && poolSet.size) {
    const i = findRootTimelinePool(sd, poolSet);
    if (i >= 0) return firstPlaceOf(dp[i]);
  }
  return null;
}

// 锚点（渲染池局部坐标）—— 模型放置时被 pin 到地面格的那一点。
// 2026-09-17：新增可选 poolSet 透传给 topLevelPlace（修「dp[0] 空壳」类模型的规则① 失灵）。
export function rootAnchor(sd, rct, poolSet) {
  const pl = topLevelPlace(sd, poolSet);
  if (pl && pl.x === -256 && pl.y === -256) return { x: 256, y: 256, src: 'rootPlace' };
  const cx = rct ? (rct.x + rct.width / 2) : 0;
  if (Math.abs(cx) < ROLE_CX_GUARD) return { x: 0, y: 0, src: 'roleOrigin' };
  // ③ (256,256) 兜底已删：无顶层 place 且内容中心 |cx|>=128 的模型，默认锚点 = 符号原点 (0,0)
  return { x: 0, y: 0, src: 'roleOrigin' };
}

// 脚点（渲染池局部坐标）单一真源。返回 {x,y,top,src}。
//   override > 单 Role(无命名动作)盲推 (0,0) > rootAnchor（顶层 place / 256 约定）
// 说明：sd 为模型的 swfData（缺省时退化为"内容中心判定"，足以为常规/单 Role 给出正确结果）。
// ao / aoBloated 为历史参数（旧版 artOrigin 口径），保留签名以兼容 foot_calibrate.html 等调用方，现不再参与判定。
// hasNamed：模型是否含【非空的命名动作】（来自 index.html 的 const labels）。true=多动作，false=单 Role 精灵。
//   ★ user 2026-09-12：「role 盲推 0,0」——所有单 Role（无命名动作）模型一律锚点 = 符号原点 (0,0)，
//     覆盖 rootAnchor 的规则① rootPlace 兜底（常规角色 (256,256) 的来源），与技能/特效 anchorOrigin 同源。
// ★ 2026-09-17 新增 poolSet（第 7 参 = loader.actionPoolSet(rec.actions)）：透传给 rootAnchor → topLevelPlace，
//   用于把「dp[0] 是空壳」的 73 个模型上失灵的规则① 救回来（详见 findRootTimelinePool 注释）。
//   不传时行为与旧版逐位一致（向后兼容）。
export function resolveFoot(charId, ao, rct, aoBloated, sd, hasNamed, poolSet) {
  const ov = FOOT_OVERRIDE[Number(charId)];
  if (ov) return { x: ov.x, y: ov.y, top: rct ? rct.y : 0, src: 'override' };
  // ★ 单 Role（无命名动作）盲推符号原点 (0,0)：覆盖规则① rootPlace（常规角色 (256,256) 的由来）
  if (hasNamed === false) return { x: 0, y: 0, top: rct ? rct.y : 0, src: 'roleOrigin' };
  const a = rootAnchor(sd, rct, poolSet);
  return { x: a.x, y: a.y, top: rct ? rct.y : 0, src: a.src };
}

const F = () => window.fanvas;

// 缓存：modelId -> { swfData, actions, imagePath }
const cache = { char: {}, effect: {}, skill: {}, status: {} };

// ─────────────────────────────────────────────────────────────────────────────
// ★ fanvas 图片缓存桶补丁（user 2026-09-11 报：「快速切换动作时模型会消失一小会，
//   尤其是移动过程中的转向动画切换」，并追问"不是有占存桶吗，为什么还加载不及时"）
//
// 【根因】fanvas 的 Preloader.load 对缓存桶 `fanvas.imageList` 是**只写不读**：
//     b.load = function(urls, cache, done, ...) {
//       for (...) { var d = document.createElement("img");
//                   d.onload = ...;                 // 等【全部】onload 才回调
//                   d.src = url + "?max_age=604800";
//                   cache[url] = d;  }              // ← 只写，从不先查
//     };
//   ⇒ 每次 fanvas.play() 都把该模型的【每一张位图重新 new Image()】，必须等所有 img.onload
//     异步回调齐了才 `new Stage()` + 画首帧。而我们的 mount() 在调 play() **之前**就已经把
//     旧 canvas 从容器 remove 了 ⇒ 中间这段「旧画布已移除、新画布还没画」就是模型消失的空窗。
//   单个角色模型常含 40~60 张位图，几十个 onload 至少要跨好几个事件循环 —— 肉眼可见。
//   转向会切 dir ⇒ act() 判定 _current.dir 变了 ⇒ 重新 playChar ⇒ 又走一遍完整预加载，
//   所以「移动中转向」闪烁最明显（原地 stand 循环不会重播，反而不闪）。
//
// 【修法】让 load 先查缓存桶：img 已 complete 且 naturalWidth>0（已解码可用）就直接计数，
//   不再新建 Image。全部命中时回调在循环内**同步**完成 ⇒ play() 返回前首帧已画好 ⇒ 零空窗。
//   ※ 不直接改 fanvas3-transparent.js（第三方 minified 源码），在自家代码里覆盖原型方法，
//     便于升级引擎时保留、也便于排查。
// ※ 键一致：Stage 侧取图为 fanvas.imageList[this._imagePath + name]，与这里 cache[url] 同键。
// ※ 冷启动（首次播某模型）仍有一次真实加载，属正常；同一模型后续切动作/转向全部命中缓存。
// ─────────────────────────────────────────────────────────────────────────────
let _preloaderPatched = false;
export function patchFanvasPreloader() {
  if (_preloaderPatched) return true;
  const fv = (typeof window !== 'undefined') ? window.fanvas : null;
  const P = fv && fv.Preloader && fv.Preloader.prototype;
  if (!P || typeof P.load !== 'function') return false;   // fanvas 尚未就绪，稍后再试
  if (P.__tsPatched) { _preloaderPatched = true; return true; }
  P.__tsOriginal = P.load;    // 保留原实现（回归测试可临时还原做反证，也便于排障）
  P.load = function (urls, cache2, onDone, onProgress, onError) {
    const store = cache2 || (window.fanvas && window.fanvas.imageList) || {};
    const total = urls.length;
    if (total === 0) { onDone(); return; }     // 原实现此处漏了 return，补上
    let done = 0;
    const tick = () => {
      done++;
      if (onProgress) { try { onProgress(done / total); } catch (e) {} }
      if (done === total && onDone) onDone();
    };
    for (let i = 0; i < total; i++) {
      const url = urls[i];
      const hit = store[url];
      // ★ 命中缓存桶：已解码完成的位图直接复用，不再新建 Image、不再等 onload
      if (hit && hit.complete && hit.naturalWidth > 0) { tick(); continue; }
      const img = document.createElement('img');
      img.onload = tick;
      img.onerror = () => { if (onError) onError(); };
      img.src = url + '?max_age=604800';
      store[url] = img;
    }
  };
  P.__tsPatched = true;
  _preloaderPatched = true;
  return true;
}

// 还原 fanvas 原始 Preloader.load（仅供回归测试做反证，运行时不调用）
export function unpatchFanvasPreloader() {
  const P = window.fanvas && window.fanvas.Preloader && window.fanvas.Preloader.prototype;
  if (P && P.__tsOriginal) { P.load = P.__tsOriginal; P.__tsPatched = false; _preloaderPatched = false; return true; }
  return false;
}

function evalSwf(text) {
  // swfData.js: var swfData = {...}; 放进 Function 作用域取回
  const fn = new Function(text + '\n;return swfData;');
  return fn();
}

// 角色：从 index.html 里抠出 const labels=[{label,pool,empty}]
function parseCharActions(html, swfData) {
  const out = {};
  const m = html.match(/const labels\s*=\s*(\[[\s\S]*?\]);/);
  if (m) {
    try {
      const labels = JSON.parse(m[1]);
      for (const L of labels) {
        const pool = L.pool;
        const frames = (swfData.definitionPool[pool] && swfData.definitionPool[pool].totalFrames) || 1;
        out[L.label] = { pool, empty: !!L.empty, frames };
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

// 骑宠层：从 const labels 里抠出每个动作的 bg/fg/flip（骑宠模型 4xxxxx 专用）。
// 返回 { 'walkRB': {bg,fg,flip,empty}, ... }，供 fighter 播前后景两层。
// 缺 bg/fg 字段（普通角色）返回 null，调用方据此判定该模型不是骑宠。
export function parseCharRideLayers(html) {
  const m = html.match(/const labels\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return null;
  let labels;
  try { labels = JSON.parse(m[1]); } catch (e) { return null; }
  if (!Array.isArray(labels)) return null;
  const out = {};
  let any = false;
  for (const L of labels) {
    if (!L || L.label == null) continue;
    if (L.bg != null || L.fg != null) any = true;
    out[L.label] = { bg: L.bg != null ? L.bg : null, fg: L.fg != null ? L.fg : null, flip: !!L.flip, empty: !!L.empty };
  }
  return any ? out : null;
}

// 骑宠层解析结果缓存（loadChar 已缓存 html，此处只缓存 parse 结果，避免每次重播都正则）
const _rideLayerCache = {};
export function getCharRideLayers(modelId, html) {
  if (_rideLayerCache[modelId] !== undefined) return _rideLayerCache[modelId];
  const v = parseCharRideLayers(html);
  _rideLayerCache[modelId] = v;
  return v;
}

// 骑宠模型配置（显示类型 + 站立抬升）：从该模型 index.html 的
//   const ridepetMeta={"rideType":"stand","standLift":-15};  抠出。
// 缺省（无此行 / 非 4xxxxx 模型）= 乘骑型、抬升 0。配置随模型走，见 js/ridepet/ridepet-type.js。
const _metaCache = {};   // modelId → meta | null（undefined = 尚未加载）
export function parseRidepetMeta(html) {
  const m = html.match(/const ridepetMeta\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}
export async function getRidepetMeta(modelId) {
  const id = String(modelId || '');
  if (!id) return null;
  if (_metaCache[id] !== undefined) return _metaCache[id];
  try {
    const rec = await loadChar(id);          // loadChar 内部已缓存 html，不会重复下载
    const meta = parseRidepetMeta(rec.html);
    _metaCache[id] = meta || null;
    return _metaCache[id];
  } catch (e) { _metaCache[id] = null; return null; }
}
export function invalidateRidepetMetaCache() {
  for (const k of Object.keys(_metaCache)) delete _metaCache[k];
}

// 特效/技能：从 index.html 里抠出 var GENERIC_MAIN = N（主精灵下标）
function parseMain(html) {
  const m = html.match(/var GENERIC_MAIN\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

// 判定某 def 是否为"合法 MovieClip 根"（可作 rootDef 挂载）：必须有 frameActionList 或 totalFrames。
// 纯 Shape（仅 graphics）不是合法 MC 根——以其建根 MovieClip 会在 _getCurrentAction 每帧读 actionList.length 抛错。
// ★ 注意：fanvas 的 _prebuildShapes 会把 definitionPool[i].graphics 从"数组"原地替换为"预构建 Shape 的 graphics 对象"，
//   故判定"有图形"不能再用 Array.isArray(graphics)，必须用 graphics != null（数组或对象均算有图形）。
function isValidMCRoot(dp, i) {
  const d = dp && dp[i];
  return !!(d && (Array.isArray(d.frameActionList) || typeof d.totalFrames === 'number'));
}
// 单帧 Role 模型兜底：index.html 既无 const labels 也无 GENERIC_MAIN 时（如 210014），
// 扫描 definitionPool 找"播放 Role 图形"的主动画：def 含 frameActionList 且其中 pE 引用了一个带 graphics 的 def。
// 退而求其次：首个带 graphics 的 Role 单帧 def；再退：首个合法 MC def。都找不到返回 null（真"无动画"）。
// ★ 关键修正：所有"有图形/是否 MC"判定改用 graphics != null / isValidMCRoot，避免被 _prebuildShapes 的原地 mutation 欺骗
//   （此前 isGraphic 用 Array.isArray(graphics)，首次播放后 graphics 变对象 → 判 false → 兜底链退化到 Shape def → 每帧崩溃。
//   见 char 210115：labels.pool=-1 → 首播解析到 def[2] 正常，二次渲染 findCharMainPool 退化到 def[1](Shape) → 崩溃）。
function findCharMainPool(swfData) {
  const dp = (swfData && swfData.definitionPool) || [];
  const isGraphic = i => !!(dp[i] && dp[i].graphics != null);   // 不要求 Array.isArray（_prebuildShapes 后变对象）
  const isMC = i => isValidMCRoot(dp, i);
  // 1) 主动画：frameActionList 里 pE 引用了一个 graphic Role
  for (let i = 1; i < dp.length; i++) {
    const d = dp[i];
    if (!isMC(i)) continue;
    let ok = false;
    for (const kf of d.frameActionList) {
      if (!Array.isArray(kf)) continue;
      for (const a of kf.slice(1)) {
        if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null && isGraphic(a[1].id)) { ok = true; break; }
      }
      if (ok) break;
    }
    if (ok) return i;
  }
  // 2) 首个 graphic Role 单帧
  for (let i = 1; i < dp.length; i++) if (isGraphic(i)) return i;
  // 3) 首个合法 MC def（可作 root，绝不再退化到 Shape）
  for (let i = 1; i < dp.length; i++) if (isMC(i)) return i;
  return null;
}

// 判断 Role 池是否"定格首帧"：单帧 Role / 瞬时"放置→移除"动画(末态被移除、循环会闪烁)应定格首帧保持显示；
// 真正多帧持续动画(末态仍有内容)则照常循环播放。判定：模拟各关键帧的 pE/rE 放置，看末态是否还有内容。
// ⚠ 实例名格式：pE 的实例信息在 a[1]（{id,n}），rE 在 a[1] 可能是字符串名(如 "1-1")或 {id,n}；统一按实例名追踪。
function rolePoolLeavesEmpty(swfData, pool) {
  const d = swfData && swfData.definitionPool && swfData.definitionPool[pool];
  if (!d || !Array.isArray(d.frameActionList)) return true;            // 无动画数据 ⇒ 视为静态
  const total = d.totalFrames || d.frameActionList.length || 1;
  if (total <= 1) return false;                                       // 单帧 ⇒ 播放本身即静止，无需冻结
  const instName = (a) => {
    if (!a) return null;
    if (typeof a === 'string') return a;
    if (a.n != null) return a.n;
    if (a.id != null) return String(a.id);
    return null;
  };
  const placed = new Set();
  for (const kf of d.frameActionList) {
    if (!Array.isArray(kf)) continue;
    for (const a of kf.slice(1)) {
      if (!Array.isArray(a)) continue;
      if (a[0] === 'pE') { const n = instName(a[1]); if (n != null) placed.add(n); }
      else if (a[0] === 'rE') { const n = instName(a[1]); if (n != null) placed.delete(n); }
    }
  }
  return placed.size === 0;
}

async function loadJsonp(modelId, swfUrl, htmlUrl) {
  const [swfText, htmlText] = await Promise.all([
    fetch(swfUrl).then(r => r.text()),
    fetch(htmlUrl).then(r => r.text())
  ]);
  const swfData = evalSwf(swfText);
  return { swfData, html: htmlText };
}

export async function loadChar(modelId) {
  if (cache.char[modelId]) return cache.char[modelId];
  const { swfData, html } = await loadJsonp(modelId, url.charSwf(modelId), url.charHtml(modelId));
  const rec = { swfData, actions: parseCharActions(html, swfData), imagePath: url.charImages(modelId), html };
  cache.char[modelId] = rec;
  return rec;
}

export async function loadEffect(name) {
  if (cache.effect[name]) return cache.effect[name];
  const { swfData, html } = await loadJsonp(name, url.effectSwf(name), url.effectHtml(name));
  let main = parseMain(html);
  // ★ 防御：GENERIC_MAIN 可能越界（如 skill/173608 的 18 而 dpLen=18）或指向非 MC def；
  //   直接 mount 会以 undefined/Shape 建根 → 抛错。无效时回退 findCharMainPool 找合法 MC 根。
  if (!isValidMCRoot(swfData.definitionPool, main)) {
    const fb = findCharMainPool(swfData);
    if (fb != null) main = fb;
  }
  const frames = (swfData.definitionPool[main] && swfData.definitionPool[main].totalFrames) || 1;
  const rec = { swfData, main, frames, imagePath: url.effectImages(name) };
  cache.effect[name] = rec;
  return rec;
}

export async function loadSkill(id) {
  // 技能目录以数字 id 命名（与 icon 的 Skill_{id} 对应）
  if (cache.skill[id]) return cache.skill[id];
  const { swfData, html } = await loadJsonp(id, url.skillSwf(id), url.skillHtml(id));
  let main = parseMain(html);
  // ★ 防御：GENERIC_MAIN 可能越界（如 skill/173608 的 18 而 dpLen=18）或指向非 MC def；
  //   直接 mount 会以 undefined/Shape 建根 → 抛错。无效时回退 findCharMainPool 找合法 MC 根。
  if (!isValidMCRoot(swfData.definitionPool, main)) {
    const fb = findCharMainPool(swfData);
    if (fb != null) main = fb;
  }
  const frames = (swfData.definitionPool[main] && swfData.definitionPool[main].totalFrames) || 1;
  const rec = { swfData, main, frames, imagePath: url.skillImages(id) };
  cache.skill[id] = rec;
  return rec;
}

// 把 swfData 画到容器里的一个新 canvas 上；返回 { canvas, frames }
export function mount(container, swfData, rootDef, imagePath, opts) {
  // 清掉容器里旧的 canvas（切换动作时重建，避免 fanvas 状态污染）
  container.querySelectorAll('canvas').forEach(c => { try { F().pause(c); } catch (e) {} c.remove(); });

  const canvas = document.createElement('canvas');
  // 画布像素尺寸：fanvas 运行时(原点扩展分支)按 definitionPool[rootDef].rect 直接设画布尺寸并写入
  // originX/originY(= -rect.x / -rect.y，Flash 原点(0,0) → 画布像素 (-rect.x*scale, -rect.y*scale))；此处仅先给一个同步初值
  // (避免 canvas 默认 300×150 被 anchorOrigin 误用)，运行时首帧即覆盖为正确尺寸，故 fighter.js 直接以 originX/originY 锚定，无需再扫描像素。
  const _rd0 = swfData.definitionPool[rootDef];
  const _rr0 = _rd0 && _rd0.rect ? _rd0.rect : null;
  const _sc0 = opts.scale || 1;
  canvas.width = (_rr0 ? _rr0.width : (swfData.stageWidth || 300)) * _sc0;
  canvas.height = (_rr0 ? _rr0.height : (swfData.stageHeight || 150)) * _sc0;
  container.appendChild(canvas);

  // ★ 位图缓存倍率：fanvas 的 cache 即位图栅格化倍率（drawFromCache 以 cacheScale 栅格化、
  //   再按舞台 scale 绘制）。cache<scale 时位图被拉伸 → "位图被拉伸"的糊感。
  //   取 ceil(scale) 并夹在 [1,2]：scale<=1 用 1（省内存），放大时用 2 保证密度 ≥ 显示密度。
  //   （fanvas 内部对超出画布的形状会强制 l=1，此处只是给可达的上限）
  const _sc = opts.scale || 1;
  // 显式 opts.cache 优先（诊断/对比用）；否则按 scale 取 ceil，保证栅格密度 ≥ 显示密度
  const _cache = (opts.cache != null) ? opts.cache : Math.max(1, Math.min(2, Math.ceil(_sc)));
  const cfg = {
    rootDef: rootDef,
    transparent: true,
    cache: _cache,
    autoPlay: true,
    loop: opts.loop !== false,
    scale: opts.scale || 1,
    imagePath: imagePath
  };
  // 末帧定格（freezeLast）：fanvas 不尊重 loop:false（其 Timer 永远循环），故用 onFrame 在逻辑帧数到达
  // 动作总帧数时主动 gotoAndStop(末帧) 冻结——用于死亡倒地等"播完停最后静止帧"的动作，杜绝循环"复活"。
  // onFrame 收到的 frame 是 play 内 k.frame 整数计数（每次 tick +1），故 frame>=total 即首轮播完。
  if (opts.freezeFirst) {
    // 单帧 Role 模型：停在第一帧（首帧即"放置 Role"），杜绝 >1 帧"放置→移除"动画循环闪烁（如蟠龙图腾 def2）。
    let done = false;
    cfg.onFrame = (frame) => {
      if (!done) { done = true; canvas._frozen = true; try { F().gotoAndStop(canvas, 0); } catch (e) {} }
    };
  } else if (opts.freezeLast) {
    const dp = swfData.definitionPool[rootDef];
    const total = (dp && dp.totalFrames) || 1;
    cfg.onFrame = (frame) => {
      // ★ 13s：同样打 _frozen —— MainScene 的视野剔除(_animCull)据此跳过 resume，
      //   否则"死亡倒地定格"这类画布一旦被 resume 就会复活重播。
      if (frame >= total) { canvas._frozen = true; try { F().gotoAndStop(canvas, total - 1); } catch (e) {} }
    };
  }
  // 每次 play 前确保图片缓存桶补丁已装上（fanvas 是普通 script，模块首次执行时未必就绪，
  // 故放在这里 lazy 补装；__tsPatched 保证只覆盖一次）。
  patchFanvasPreloader();
  F().play(canvas, swfData, cfg);
  _trackLiveCanvas(canvas);
  return canvas;
}

// ── ★★ 13r：fanvas Timer 空转巡检（灵昌城真机实测根因之一） ─────────────────────────
// 【实测】灵昌城静置时约 68 条 fanvas Timer 在跑，其中约 28 条（41%）所对应的画布【已脱离 DOM】
//   却仍每帧 drawImage 绘制 → 纯 CPU 浪费（无任何可见输出）。1s 窗口实测：createElement('canvas')
//   累计 1124 个、DOM 中仅 42 个。
// 【成因】fanvas.Timer 的 rAF 循环只检查自身 paused 标志；画布被 remove() 后没有任何人调用
//   fanvas.pause()，实现上又只有 fanvas.pause(canvas) 能停（其内部数组条目永不移除，故 pause 有效）。
//   另有竞态：mount 里 fanvas.play 的 Timer 是在图片预加载【之后】才创建的，若画布在预加载期间
//   被摘离 DOM，那一刻调 pause 会因"尚未注册"而空转失败 → 之后 Timer 才启动 ⇒ 永久孤儿。
// 【对策】登记每张 play 过的画布；每 1s 巡检一次，凡 isConnected===false 就补 pause；
//   并在 6s 宽限期内【反复】补 pause，以覆盖上述异步注册竞态。注册表随巡检自然有界。
const _liveCanvases = new Map();     // canvas -> 首次发现脱网的时刻
let _canvasSweepInstalled = false;
function _trackLiveCanvas(canvas) {
  if (!canvas) return;
  _liveCanvases.set(canvas, 0);
  if (_canvasSweepInstalled) return;
  _canvasSweepInstalled = true;
  setInterval(() => {
    const fv = window.fanvas;
    if (!fv || !_liveCanvases.size) return;
    const now = Date.now();
    for (const [c, t0] of _liveCanvases) {
      if (c.isConnected) { _liveCanvases.set(c, 0); continue; }   // 仍挂 DOM：正常播放，重置计时
      if (!t0) { _liveCanvases.set(c, now); }
      try { fv.pause(c); } catch (e) {}                            // 脱网即停（可反复调用，幂等）
      if (now - (t0 || now) > 6000) _liveCanvases.delete(c);        // 宽限期过后不再跟踪
    }
  }, 1000);
}

// 并集包围盒：递归收集 def 自身 rect + 其 frameActionList/displayList 里所有被放置子图(pose 图)的 rect。
// 转换模型的动画 MovieClip 只存「第 0 帧 pose 的 rect」而非整段并集，fanvas 按此 rect 设画布尺寸会导致
// 后续更大的 pose（如挥刀/抬手）超出画布被裁切；用并集覆盖 rd.rect 后画布足够大、整段动画不裁切。
// 纯 JS 计算，无 getImageData；结果缓存到 def._unionRect 避免每次切动作重复遍历。
function mergeRect(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
// 并集包围盒：递归收集 def 自身 rect + 其 frameActionList/displayList 里所有被放置子图(pose 图) 的 rect。
// ★★ 关键修正：子图内容必须按「放置偏移(pE.x/pE.y)」平移后再并入（旧版漏加偏移，且用全局 seen 跳过同一子图
//   ⇒ 对带偏移子图如 210060001 帧2 的 def2@(-74.2,9.4)、210124 的 def13@(-268.7) 算错并集，覆盖后画布仍过小、动画被裁）。
//   现用 memo(缓存每个 def 的局部并集，与放置位置无关) + path-stack(仅防递归环，不阻断多偏移放置)。
// 转换模型动画 MovieClip 只存「第 0 帧 pose 的 rect」而非整段并集，fanvas 按此 rect 设画布尺寸会导致后续更大的
// pose（挥刀/抬手）超出画布被裁切；用并集覆盖 rd.rect 后画布足够大、整段动画不裁切。
// 纯 JS 计算，无 getImageData；结果由 unionRectFor 缓存到 def._unionRect 避免每次切动作重复遍历。
function unionRectOf(dp, idx, memo, stack) {
  memo = memo || new Map();
  stack = stack || new Set();
  if (memo.has(idx)) return memo.get(idx);
  if (stack.has(idx)) return null;            // 递归环：跳过该边，避免无限递归
  stack.add(idx);
  const d = dp[idx];
  if (!d) { stack.delete(idx); return null; }
  let r = (d.rect && (d.rect.width || d.rect.height)) ? { x: d.rect.x, y: d.rect.y, width: d.rect.width, height: d.rect.height } : null;
  const fal = d.frameActionList;
  if (fal && Array.isArray(fal)) {
    for (const kf of fal) {
      if (!kf) continue;
      const acts = Array.isArray(kf) ? kf.slice(1) : [];
      for (const a of acts) {
        if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) {
          const p = a[1];
          const m = p.m || p.matrix;
          const ox = (p.x != null) ? p.x : (Array.isArray(m) ? m[4] : 0);
          const oy = (p.y != null) ? p.y : (Array.isArray(m) ? m[5] : 0);
          const cr = unionRectOf(dp, p.id, memo, stack);
          if (cr) r = mergeRect(r, { x: cr.x + ox, y: cr.y + oy, width: cr.width, height: cr.height });
        }
      }
    }
  }
  const dl = d.displayList || d.frames;
  if (dl && Array.isArray(dl)) {
    for (const fr of dl) {
      if (!Array.isArray(fr)) continue;
      for (const a of fr) {
        if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) {
          const p = a[1];
          const m = p.m || p.matrix;
          const ox = (p.x != null) ? p.x : (Array.isArray(m) ? m[4] : 0);
          const oy = (p.y != null) ? p.y : (Array.isArray(m) ? m[5] : 0);
          const cr = unionRectOf(dp, p.id, memo, stack);
          if (cr) r = mergeRect(r, { x: cr.x + ox, y: cr.y + oy, width: cr.width, height: cr.height });
        }
      }
    }
  }
  stack.delete(idx);
  memo.set(idx, r);
  return r;
}
// 该池(动作)总共放置过几个不同的子图 —— 用于区分「单姿势」与「多帧动画」。
// 单姿势(Role/装饰物)：整段只放一张位图 ⇒ 子图并集 == 那张位图的矩形（含四周透明留白）。
// 多帧动画：不同帧放不同 pose ⇒ 需要「整段并集」防裁切。
function placedChildIds(dp, pool) {
  const d = dp[pool];
  const set = new Set();
  if (!d || !Array.isArray(d.frameActionList)) return [];
  for (const kf of d.frameActionList) {
    if (!kf) continue;
    const acts = Array.isArray(kf) ? kf.slice(1) : [];
    for (const a of acts) if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) set.add(a[1].id);
  }
  return Array.from(set);
}

// 是否「单姿势」池（供 fighter.js 锚定与 playChar 共用同一判据，避免两边算法漂移）
export function isSinglePosePool(swfData, pool) {
  const dp = (swfData && swfData.definitionPool) || [];
  return placedChildIds(dp, pool).length <= 1;
}

function unionRectFor(dp, pool) {
  const d = dp[pool];
  if (d && d._unionRect) return d._unionRect;
  const ur = unionRectOf(dp, pool);
  if (d && ur) d._unionRect = ur;
  return ur;
}

// 技能/特效/角色 共用：用真实并集包围盒覆盖存储 rect，防止多帧动画因 pose 超出第 0 帧 rect 被画布裁切。
// 单姿势(Role/装饰物)不覆盖（并集 == 单张位图矩形含透明留白，会比真实内容大一圈 ⇒ 顶起浮空）。
// 锚点安全：fanvas 用同一 rect 同时定画布尺寸(f.x=-rect.x*scale)与内容平移，anchorOrigin 也用同一 rect 定 canvasWrap 平移，
// 二者抵消 ⇒ 模型屏幕位置不变（仅画布变大/透明留白），见 playChar 462-464 注释。纯 JS 计算、无 getImageData。
// 始终留档原始 rect（=磁盘真实内容包围盒）到 _rawRect，供 char-origin.js 读取（不可被并集覆盖覆盖掉）。
export function applyUnionOverride(swfData, pool) {
  const dp = (swfData && swfData.definitionPool) || [];
  const d = dp[pool];
  if (!d) return;
  if (!d._rawRect) d._rawRect = d.rect;
  const ur = unionRectFor(dp, pool);
  const diskOK = d.rect && (d.rect.width > 0 || d.rect.height > 0);
  if (ur && ur.width > 0 && ur.height > 0 && !(diskOK && isSinglePosePool(swfData, pool))) d.rect = ur;
}

// 角色：播放某个基础动作（stand/walk/attack/cast…）+ 朝向
// container: 角色容器 div；返回绘制信息或 null
export async function playChar(container, modelId, base, dir, opts = {}) {
  let rec;
  try { rec = await loadChar(modelId); }
  catch (e) { console.warn('角色加载失败', modelId, e); return null; }
  let a = resolveAction(rec.actions, base, dir);
  // ★ 骑乘状态（opts.ride）：骑宠系统的第①种表现 —— 角色有乘骑动画时优先播 base+ISO方向+'ride'
  //   （骑宠帧名格式 = base+dir+'ride'，如 standRBride/walkRBride）。
  //   ⚠ dir 是【渲染朝向】renderDir，只可能是 right/left/RB/LT 四值（fighter 的 FLIP_DIR 已把
  //     LB→RB、RT→LT 折叠，合成方向由 _bodyWrap 整体 scaleX(-1) 生成）。
  //     骑乘标签只有 RB/LT 两系，故按「左侧(LT/left) / 右侧(RB/right)」选优先序展开。
  //   无任一 ride 标签时保持上面的回退结果（第②种表现：人物播普通 stand/walk）。
  if (opts.ride) {
    const sideLT = (dir === 'left' || dir === 'LT');
    const order = sideLT ? ['LT', 'LB', 'RT', 'RB'] : ['RB', 'RT', 'LB', 'LT'];
    let ra = null;
    for (const s of order) {
      const cand = rec.actions && rec.actions[base + s + 'ride'];
      if (cand && !cand.empty) { ra = cand; break; }
    }
    if (ra) a = ra;
  }
  // ★ 防御：labels 里 pool 可能是非法占位值（如 -1 / 越界 / 指向纯 Shape 的 def），
  //   此时绝不能当成有效 rootDef 直接 mount（fanvas 会以该 def 建根 MovieClip，每帧读 actionList.length 抛错）。
  //   必须以"是否合法 MC 根"校验（isValidMCRoot：有 frameActionList 或 totalFrames），否则视为 null，
  //   走下方 GENERIC_MAIN / findCharMainPool 兜底链。
  //   （例：char 210115 的 "standRB" 标签 pool=-1；又如某标签 pool 误指向纯 Shape def[1] → 必须拒绝并回退）。
  let pool = (a && a.pool != null && isValidMCRoot(rec.swfData.definitionPool, a.pool)) ? a.pool : null;
  let roleFallback = false;   // 命中 Role 兜底(单帧精灵)时置 true ⇒ 停第一帧
  // 兜底：命名动画缺失（单帧 Role 模型，如蟠龙图腾/若干传送/装饰物）→ 用 GENERIC_MAIN 指向的 Role 单帧精灵。
  // 与技能加载动画(playSkill 走 GENERIC_MAIN)一致；只有 Role 也没有（index.html 不显式含 GENERIC_MAIN）才是真"无动画"。
  // 注意：必须要求 index.html 显式含 GENERIC_MAIN，不能用 parseMain 的默认 1 —— 普通角色(有 const labels)不写 GENERIC_MAIN，
  // 若误用默认 1 会在 resolveAction 失败时错误回退到身体图(def1)，造成错位显示。
  if (pool == null) {
    const gm = (rec.html.match(/var\s+GENERIC_MAIN\s*=\s*(\d+)/) || [])[1];
    if (gm != null) {
      const g = parseInt(gm, 10);
      if (rec.swfData.definitionPool[g]) { pool = g; roleFallback = true; }
    }
  }
  // 仍无：扫描 definitionPool 找"播放 Role 的主动画"（labels 空且无 GENERIC_MAIN 的单帧模型，如 210014）。
  // 此类模型 index.html 仅 const labels=[] 且无 GENERIC_MAIN，需兜底扫描才能定位主精灵。
  if (pool == null) {
    const m = findCharMainPool(rec.swfData);
    if (m != null) { pool = m; roleFallback = true; }
  }
  if (pool == null) return null;
  // 冻结判定：仅当命中 Role 兜底 且 该 Role 池是"单帧/放置→移除"瞬时动画(末态为空、循环闪烁)时定格首帧；
  // 真正多帧持续动画(末态仍有内容)照常循环播放。普通命名动画不受此影响。
  const freezeFirst = roleFallback && rolePoolLeavesEmpty(rec.swfData, pool);
  // 用真实并集包围盒覆盖存储 rect，避免攻击/施法等动画因 pose 超出第 0 帧 rect 被画布裁切（与 char 查看器同因同果）。
  // 安全性：fanvas 用同一 rect 同时定画布尺寸(f.x=-rect.x*scale)与内容平移，_anchorByOrigin 也用同一 rect 定 canvasWrap 平移，
  // 二者抵消 ⇒ 模型屏幕位置不变，仅画布变大(透明留白)、不再裁切。
  applyUnionOverride(rec.swfData, pool);
  const canvas = mount(container, rec.swfData, pool, rec.imagePath, { loop: opts.loop, scale: opts.scale, freezeLast: opts.freezeLast, freezeFirst });
  const frames = (rec.swfData.definitionPool[pool] && rec.swfData.definitionPool[pool].totalFrames) || 1;
  return { canvas, frames, rec, pool, roleFallback };
}

// 统一原点叠加（对齐 origin_overlay.html 的"非 char 分支" + 使用说明.html 的"多动画原点叠加"）：
// 把画布 Flash 原点(0,0) 经 translate(-originX*scale, -originY*scale) 对齐到 (opts.x, opts.y)。
// 与 effect/skill/status 同源且【不做内容中心(vcenter)扫描】——所有动画都按 Flash 原点锚定，
// 使其 Flash 原点落在角色脚底原点(fig.x,fig.y)，与模型原点重合、可叠加（origin_overlay.html 对 status/skill/effect 即走此分支）；
// 这样技能/特效与状态一样走纯 Flash 原点叠加，不会因内容中心扫描而偏离到身体中心、整体错乱。
export function anchorOrigin(canvas, swfData, rootDef, opts) {
  const x = (opts.x != null) ? opts.x : 0;
  const y = (opts.y != null) ? opts.y : 0;
  const dp = swfData.definitionPool && swfData.definitionPool[rootDef];
  const rect = dp && dp.rect ? dp.rect : null;
  const scale = opts.scale || 1;
  // fanvas 运行时（非 char512）令 f.x = -rect.x*scale 并把「逻辑(0,0)」放在画布像素
  // (-rect.x*scale, -rect.y*scale) 处，故画布左上角需再 translate(-originX*scale) 才能把
  // 逻辑原点对到 (x,y)。originX 由 fanvas 运行时写入 dp（= -rect.x），此处与之同源。
  let ox = 0, oy = 0;
  if (dp && dp.originX != null) ox = dp.originX; else if (rect) ox = -Math.min(0, rect.x);
  if (dp && dp.originY != null) oy = dp.originY; else if (rect) oy = -Math.min(0, rect.y);
  let tx = -ox * scale, ty = -oy * scale;
  // ★ fit 居中基准（opts.center，缺省 "content"）：
  //   "content" - 可见内容包围盒中心对齐 (x,y)。适合内容在画布内不对称占位者
  //               （如 170601 内容 y:-343..201，原点偏上，不修正会顶出舞台外）。
  //   "origin"  - 仅把 Flash 原点对齐 (x,y)，不做内容中心修正（等价于「不缩放时的定位」
  //               整体放大）。适合亮像素重心本就在原点附近者（如 173701 雷电：包围盒中心
  //               在逻辑 x=55.5，但亮像素重心≈原点，用 content 反而把内容左推 ~55px）。
  if (opts.fit && (opts.center || 'content') === 'content' && opts.fitRect && opts.fitRect.width > 0) {
    const ccx = (opts.fitRect.x + opts.fitRect.width / 2) * scale;
    const ccy = (opts.fitRect.y + opts.fitRect.height / 2) * scale;
    tx -= ccx; ty -= ccy;
  }
  canvas.style.position = 'absolute';
  canvas.style.left = x + 'px';
  canvas.style.top = y + 'px';
  canvas.style.transform = `translate(${tx}px, ${ty}px)`;
}

// ── 骑宠层播放（ fighter 骑乘系统的渲染原语 ）──────────────────────────────────
// 骑宠模型（4xxxxx）的每个动作由 bg(骑手身后) + fg(骑手身前) 两个独立池组成；
// 本函数按 layer('bg'/'fg') 播对应池，返回与 playChar 同构的 {canvas, frames, rec, pool}，供 fighter 做纸娃娃锚定。
// resolveAction 的回退序与 playChar 完全一致（LB/RT 合成方向由 fighter 的 _bodyWrap 整体翻转处理，此处只按真实素材方向播）。
// 空标签（Ride*RT/Ride*LB）的 bg/fg 已在 labels 里指向内容标签的池（生成器推导），故无需特判。
export async function playRideLayer(container, modelId, base, dir, layer, opts = {}) {
  let rec;
  try { rec = await loadChar(modelId); }
  catch (e) { console.warn('[ridepet] 加载失败', modelId, e); return null; }
  const rideLayers = getCharRideLayers(modelId, rec.html);
  if (!rideLayers) return null;                      // 非骑宠模型
  // resolveAction 只回 {pool,frames}，而骑宠标签的池在 bg/fg 字段（不在 pool 里）
  // ⇒ 把 bg/fg 映射成 pool 字段再造一张动作表，复用同一套方向回退序
  const layerActions = {};
  for (const k in rideLayers) layerActions[k] = { pool: rideLayers[k][layer], empty: rideLayers[k].empty };
  const a = resolveAction(layerActions, base, dir);
  const pool = a && a.pool != null ? a.pool : null;
  if (pool == null || !isValidMCRoot(rec.swfData.definitionPool, pool)) return null;
  applyUnionOverride(rec.swfData, pool);
  const canvas = mount(container, rec.swfData, pool, rec.imagePath, { loop: opts.loop, scale: opts.scale, freezeLast: opts.freezeLast });
  const frames = (rec.swfData.definitionPool[pool] && rec.swfData.definitionPool[pool].totalFrames) || 1;
  return { canvas, frames, rec, pool, roleFallback: false };
}

// 播完销毁：先 fanvas.pause 停止内部 Timer，再移除 canvas（单页 App 必须，否则 Timer 常驻→内存泄漏 + 性能浪费）。
// pause 必须传入与 play 对应的同一个 canvas dom（fanvas 按 canvas 索引 Timer）。
// 导出：供调用方手动停止"持续型"演出（寻路终点光圈 / 状态动画等需要自行控制生命周期的场景）。
export function destroyCanvas(canvas) {
  if (!canvas) return;
  try { F().pause(canvas); } catch (e) {}
  if (canvas.parentNode) canvas.remove();
}

// 特效 / 技能演出：一次性播放，播完自动 pause + 移除 canvas（fanvas 按包围盒自适应画布尺寸）
export async function playEffect(container, name, opts = {}) {
  let rec;
  try { rec = await loadEffect(name); }
  catch (e) { console.warn('特效加载失败', name, e); return null; }
  applyUnionOverride(rec.swfData, rec.main);   // 防多帧动画 pose 超出第 0 帧 rect 被画布裁切（与 playChar 同因）
  const canvas = mount(container, rec.swfData, rec.main, rec.imagePath, { loop: false, freezeLast: true, scale: opts.scale || 1 });
  anchorOrigin(canvas, rec.swfData, rec.main, opts);
  const dur = (rec.frames / (rec.swfData.frameRate || 25)) * 1000;
  // 播完销毁：freezeLast 已让动画在末帧定格（杜绝 fanvas 无视 loop:false 的回卷重播 → 播完又闪第一帧），
  // 此处再 pause 停掉内部 Timer 并移除 canvas（单页 App 删除 canvas 前务必先 pause，见使用说明.html）。
  setTimeout(() => { destroyCanvas(canvas); if (opts.onEnd) opts.onEnd(); }, dur + 60);
  return { canvas, frames: rec.frames, dur };
}

// 技能动画「真实内容尺寸」（逻辑单位，未乘 scale）：返回 main 精灵经 applyUnionOverride 后的并集包围盒，
// 供调用方按舞台尺寸做等比例放大（如水魔爆全屏演出：scale = min(stageW/rect.width, stageH/rect.height)）。
// fanvas 非 char512 分支令 canvas.width = rect.width*scale、f.x = -rect.x*scale，
// 故以该 rect 计算 scale 即可让动画铺满舞台；rect 含的透明留白会同步放大，不会改变内容宽高比（不拉伸）。
// 缓存：loadSkill 内部已缓存 swfData，此处再缓存算出的 rect，避免每次施法重复遍历并集。
const _skillContentSize = {};
// 可见内容包围盒：递归遍历 rootDef 每帧放置的【可见子图】(有 graphics 的 shape)，
// 按放置偏移平移后求所有帧的并集 —— 剥离透明留白后的「真实可见内容」范围。
// 用途：fit 等比例放大时按真实内容算 min(W/w, H/h)，避免被并集 rect 里的透明留白
//       （如 170601 main rect 顶部 y:-493 的 289px 空白）误导成「高度铺满、水平只覆盖 60%」。
// 与 unionRectOf 的区别：后者含子图自身 rect 的透明区且含无 graphics 的空 def。
function visibleRectOf(dp, idx, memo, stack) {
  memo = memo || new Map(); stack = stack || new Set();
  if (memo.has(idx)) return memo.get(idx);
  if (stack.has(idx)) return null;
  stack.add(idx);
  const d = dp[idx];
  let r = null;
  // 自身可直接绘制内容（shape/bitmap）：其 rect 即位图包围盒
  if (d && d.graphics && d.rect && (d.rect.width > 0 || d.rect.height > 0)) {
    r = { x: d.rect.x, y: d.rect.y, width: d.rect.width, height: d.rect.height };
  }
  const push = (cr, ox, oy) => {
    if (!cr) return;
    const m = { x: cr.x + ox, y: cr.y + oy, width: cr.width, height: cr.height };
    r = r ? mergeRect(r, m) : m;
  };
  const scan = (list) => {
    if (!Array.isArray(list)) return;
    for (const fr of list) {
      if (Array.isArray(fr)) {
        for (const a of fr) {
          if (Array.isArray(a) && a[0] === 'pE' && a[1] && a[1].id != null) {
            const pp = a[1]; const mm = pp.m || pp.matrix;
            const ox = (pp.x != null) ? pp.x : (Array.isArray(mm) ? mm[4] : 0);
            const oy = (pp.y != null) ? pp.y : (Array.isArray(mm) ? mm[5] : 0);
            push(visibleRectOf(dp, pp.id, memo, stack), ox, oy);
          }
        }
      } else if (fr && typeof fr === 'object') {
        // frameActionList 的关键帧可能是对象（含 place/tween/remove 条目），取其 actions 数组
        const acts = fr.actions || fr.place || fr.list;
        if (Array.isArray(acts)) scan([acts]);
      }
    }
  };
  if (d) {
    // frameActionList 每个关键帧是数组：[frame, action, action, ...]
    if (Array.isArray(d.frameActionList)) {
      for (const kf of d.frameActionList) {
        if (!kf) continue;
        const acts = Array.isArray(kf) ? kf.slice(1) : (kf && Array.isArray(kf.actions) ? kf.actions : []);
        scan([acts]);
      }
    }
    scan(d.displayList || d.frames);
  }
  stack.delete(idx); memo.set(idx, r);
  return r;
}
const _skillVisibleSize = {};
// ★★ 实测墨迹包围盒（运行时像素采集，替代结构推算的 visibleRect）★★
// visibleRectOf 只按 pE 放置点 + 子图 rect 做结构并集，忽略了子图缩放(sX/sY)、补间位移(_tE)、
// 滤镜扩展与位图自身透明区，实测其中心可与真实墨迹中心差 10~96px
// （171001 差 96px、173701 差 56px、170601 纵向差 82px）。用它做放大居中基准必然偏移。
// 这里改为真正离屏播放一遍该动画，采集全程非透明像素并集，换算回逻辑坐标后缓存，
// 供 skillFitScale（缩放系数）与 anchorOrigin（居中基准）使用，做到像素级精确。
const _skillInkRect = {};
// 同步取【已实测】的墨迹包围盒（逻辑坐标）；尚未实测返回 null，调用方回退到结构推算
export function skillInkRect(id) {
  const key = String(id);
  if (!Object.prototype.hasOwnProperty.call(_skillInkRect, key)) return null;
  return _skillInkRect[key];
}
// 离屏实测：scale=1 真实播放一遍，跨 2 轮采样全程非透明像素并集，换算回逻辑坐标并缓存。
// 幂等 + 并发安全：已实测（含"无墨迹"的 null）直接返回；进行中的并发请求等同一个 Promise。
// 首次约花动画时长（~1.5s），由 scene._prewarmFitSkills 在战斗开始时后台预热，施法时零延迟命中缓存。
const _inkJobs = {};
export function skillInkRectAsync(id) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(_skillInkRect, key)) return Promise.resolve(_skillInkRect[key]);
  if (_inkJobs[key]) return _inkJobs[key];
  _inkJobs[key] = (async () => {
    let rec;
    try { rec = await loadSkill(key); } catch (e) { _skillInkRect[key] = null; return null; }
    applyUnionOverride(rec.swfData, rec.main);
    const R = skillContentSize(key);                 // 逻辑 rect（与画布几何同源）
    if (!R || !(R.width > 0) || !(R.height > 0)) { _skillInkRect[key] = null; return null; }
    if (typeof document === 'undefined') { _skillInkRect[key] = null; return null; }
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0';
    document.body.appendChild(holder);
    let canvas = null;
    try {
      const p = await playSkill(holder, key, { scale: 1, x: 0, y: 0 });
      canvas = p && p.canvas;
      if (!canvas) { _skillInkRect[key] = null; return null; }
      const total = p.frames || 1;
      const interval = Math.max(1000 / (rec.swfData.frameRate || 25), 30);
      let union = null;
      const sample = () => {
        try {
          if (!canvas.isConnected) return;
          const w = canvas.width, h = canvas.height;
          if (w < 10 || h < 10) return;
          const ctx = canvas.getContext('2d');
          const img = ctx.getImageData(0, 0, w, h).data;
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (img[(y * w + x) * 4 + 3] > 16) {              // alpha>16 视为可见墨迹
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
          if (maxX < 0) return;                              // 本帧无墨迹
          if (!union) union = { minX, maxX, minY, maxY };
          else {
            if (minX < union.minX) union.minX = minX; if (maxX > union.maxX) union.maxX = maxX;
            if (minY < union.minY) union.minY = minY; if (maxY > union.maxY) union.maxY = maxY;
          }
        } catch (e) {}
      };
      // 采 2 轮（fanvas 循环播放，跨循环取并集可覆盖偶发帧的极端位置）
      const count = Math.max(Math.min(total * 2, 90), 8);
      for (let i = 0; i < count; i++) {
        await new Promise(r => setTimeout(r, interval));
        sample();
      }
      // canvas 像素 (px,py) ↔ 逻辑 (R.x + px/scale, R.y + py/scale)；scale=1 直接相加
      if (union) {
        _skillInkRect[key] = {
          x: R.x + union.minX, y: R.y + union.minY,
          width: union.maxX - union.minX + 1, height: union.maxY - union.minY + 1
        };
      } else _skillInkRect[key] = null;
    } catch (e) { _skillInkRect[key] = null; }
    finally {
      if (canvas) destroyCanvas(canvas);                    // 停 Timer 防泄漏（playSkill 的自销毁可能已抢先）
      if (holder.parentNode) holder.remove();
      delete _inkJobs[key];
    }
    return _skillInkRect[key];
  })();
  return _inkJobs[key];
}

export function skillVisibleSize(id) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(_skillVisibleSize, key)) return _skillVisibleSize[key];
  const rec = cache.skill[key];
  let r = null;
  if (rec && rec.swfData && rec.main != null) {
    r = visibleRectOf(rec.swfData.definitionPool, rec.main);
  }
  _skillVisibleSize[key] = r;
  return r;
}
// 原版游戏设计屏幕尺寸：美术资源按此可见区域创作。部分全屏技的笔触会故意超出该区域
// （如 170601 水魔爆墨迹顶到 y=-492，而原版 800×600 屏幕只显示 y>=-300，超出部分玩家根本看不见）。
// swfData 里的 stageWidth/stageHeight=256 是转换工具的默认值、不是设计尺寸；scene.js 的战场布局
// 函数另用 800×600 设计坐标系（中心(400,300)），与逻辑坐标系原点居中完全对应，故以此常量为准。
// 逻辑坐标系中该屏幕以 Flash 原点(0,0) 为中心：x∈[-400,+400], y∈[-300,+300]
// （全量统计佐证：519 个技能动画 67.2% 完整落在该窗口、X 方向 90.0% 落在 [-400,+400]）。
const DESIGN_W = 800, DESIGN_H = 600;
// fit（等比放大）基准矩形 = 原版 800×600 设计屏幕本身（以 Flash 原点为中心）。
// ★ 与技能无关：所有技能都按同一窗口缩放（用户 2026-09-20：「把它们视为 800×600，
//   然后再把这个 800×600 进行缩放」），系数统一为 min/max(W/800, H/600)，
//   且画面在原版屏幕里的相对位置原样保留（超出窗口的笔触仍在画布上，只是可能被舞台裁切）。
export function skillFitRect(id) {
  return { x: -DESIGN_W / 2, y: -DESIGN_H / 2, width: DESIGN_W, height: DESIGN_H };
}
export function skillFitScale(id, stageW, stageH, mode) {
  const r = skillFitRect(id);
  if (!r || !(r.width > 0) || !(r.height > 0)) return 1;
  return (mode === 'cover') ? Math.max(stageW / r.width, stageH / r.height)
                            : Math.min(stageW / r.width, stageH / r.height);
}
// 异步版：资源尚未加载时先 loadSkill（网络请求），用于施法前预先算放大系数。
// 系数只与舞台尺寸和原版窗口有关，无需加载资源/实测墨迹 → 施法时零延迟、零网络请求。
export async function skillFitScaleAsync(id, stageW, stageH, mode) {
  return skillFitScale(String(id), stageW, stageH, mode);
}
// 并集 rect（画布几何同源）的异步版：资源尚未加载时先 loadSkill。
export async function skillContentSizeAsync(id) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(_skillContentSize, key)) return _skillContentSize[key];
  try { await loadSkill(key); } catch (e) { return null; }
  return skillContentSize(key);
}
export function skillContentSize(id) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(_skillContentSize, key)) return _skillContentSize[key];
  const rec = cache.skill[key];
  let r = null;
  if (rec && rec.swfData && rec.main != null) {
    applyUnionOverride(rec.swfData, rec.main);   // 与 playSkill 同一覆盖，保证尺寸一致
    const dp = rec.swfData.definitionPool[rec.main];
    r = (dp && dp.rect) ? { x: dp.rect.x, y: dp.rect.y, width: dp.rect.width, height: dp.rect.height } : null;
  }
  _skillContentSize[key] = r;
  return r;
}

export async function playSkill(container, id, opts = {}) {
  let rec;
  try { rec = await loadSkill(id); }
  catch (e) { console.warn('技能加载失败', id, e); return null; }
  applyUnionOverride(rec.swfData, rec.main);   // 防多帧动画 pose 超出第 0 帧 rect 被画布裁切（与 playChar 同因）
  // 转发 opts.cache（显式诊断/对比）与 scale：mount 按需以 ceil(scale) 提高栅格倍率，避免放大后位图被拉伸
  const canvas = mount(container, rec.swfData, rec.main, rec.imagePath, { loop: false, freezeLast: true, scale: opts.scale || 1, cache: opts.cache });
  // fit（等比放大铺满）：把「可见内容包围盒」交给 anchorOrigin 做居中（见其 fit 分支注释）
  // fitRect 用「裁到原版 800×600 可见窗口」的墨迹基准：anchorOrigin 据此把可见内容中心对齐落点
  if (opts.fit) opts.fitRect = skillFitRect(id);
  anchorOrigin(canvas, rec.swfData, rec.main, opts);
  const dur = (rec.frames / (rec.swfData.frameRate || 25)) * 1000;
  // 播完销毁：freezeLast 已让动画在末帧定格（杜绝 fanvas 无视 loop:false 的回卷重播 → 播完又闪第一帧），
  // 此处再 pause 停掉内部 Timer 并移除 canvas（单页 App 删除 canvas 前务必先 pause，见使用说明.html）。
  setTimeout(() => { destroyCanvas(canvas); if (opts.onEnd) opts.onEnd(); }, dur + 60);
  return { canvas, frames: rec.frames, dur };
}

// 技能动画资源存在性探测（带缓存）：播放前按方向选择 _rl/_lr 方向片，
// 方向片不存在时回退到原始数字动画（{id} 基础片）——避免对不存在的方向片发起无效加载请求（及 404 控制台告警）。
// 用 HEAD 探测；个别服务器不支持 HEAD(405) 时回退 GET。结果按 id 缓存，避免重复请求。
const _skillExists = {};
export async function skillResourceExists(id) {
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(_skillExists, key)) return _skillExists[key];
  let ok = false;
  try {
    let r = await fetch(url.skillSwf(key), { method: 'HEAD' });
    if (r.status === 405) r = await fetch(url.skillSwf(key));   // 不支持 HEAD 时回退 GET
    ok = !!r.ok;
  } catch (e) { ok = false; }
  _skillExists[key] = ok;
  return ok;
}

// 战斗状态动画：持续型（减速/虚弱/眩晕/中毒等），循环播放直到 buff 移除。
// n 为 resource/battle/{n} 目录名（用户指定 1减速/2虚弱/4眩晕/8中毒），与 effect/skill 同款 fanvas 布局。
// 注意：此处【不】自动销毁——保持循环播放"状态的持续"；调用方在 buff 移除时必须 destroyCanvas 停止内部 Timer 并移除 canvas，
// 否则 fanvas Timer 常驻 → 内存泄漏 + 性能浪费（与 playEffect/playSkill 播完销毁同理）。
export async function loadStatus(n) {
  if (cache.status[n]) return cache.status[n];
  const { swfData, html } = await loadJsonp(n, url.battleSwf(n), url.battleHtml(n));
  let main = parseMain(html);
  // ★ 防御：GENERIC_MAIN 可能越界（如 skill/173608 的 18 而 dpLen=18）或指向非 MC def；
  //   直接 mount 会以 undefined/Shape 建根 → 抛错。无效时回退 findCharMainPool 找合法 MC 根。
  if (!isValidMCRoot(swfData.definitionPool, main)) {
    const fb = findCharMainPool(swfData);
    if (fb != null) main = fb;
  }
  const frames = (swfData.definitionPool[main] && swfData.definitionPool[main].totalFrames) || 1;
  const rec = { swfData, main, frames, imagePath: url.battleImages(n) };
  cache.status[n] = rec;
  return rec;
}
export async function playStatus(container, n, opts = {}) {
  let rec;
  try { rec = await loadStatus(n); }
  catch (e) { console.warn('状态动画加载失败', n, e); return null; }
  applyUnionOverride(rec.swfData, rec.main);   // 防多帧动画 pose 超出第 0 帧 rect 被画布裁切（与 playChar 同因）
  // ★ fanvas 无视 loop:false（其 Timer 永远循环）：一次性特效（闪避/未命中/暴击/受击/防御/捕捉…）
  //   由 opts.loop===false 触发末帧定格，播一遍即冻在末帧，杜绝在销毁计时（BATTLE_FX）前循环重播
  //   ——「闪避动画播了两次」的根因即此。buff 持续动画 opts.loop=true 不受影响，照常循环。
  const canvas = mount(container, rec.swfData, rec.main, rec.imagePath,
    { loop: opts.loop !== false, scale: opts.scale || 1, freezeLast: opts.loop === false });
  // 统一原点叠加（对齐 origin_overlay.html「非 char 分支」+ 使用说明「多动画原点叠加」）：状态动画按 Flash 原点锚定，
  // 把画布 Flash 原点(0,0) 经 translate(-originX*scale, -originY*scale) 对齐到 (opts.x, opts.y)；
  // 容器挂在角色 (fig.x,fig.y)=模型脚底原点 ⇒ Flash 原点与模型脚底原点重合，可叠加。
  // 【不做内容中心(vcenter)扫描】——那会把状态挪到脚下，偏离原点叠加（status 与 effect/skill 在 origin_overlay.html 同走 Flash 原点分支）。
  anchorOrigin(canvas, rec.swfData, rec.main, opts);
  return { canvas, frames: rec.frames };
}

// 卸载容器里的动画（切场景时调用）
export function clearContainer(container) {
  if (!container) return;
  container.querySelectorAll('canvas').forEach(c => { try { F().pause(c); } catch (e) {} c.remove(); });
}
