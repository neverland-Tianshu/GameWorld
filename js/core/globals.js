// globals.js
// 对应 deobfuscated/globals/*（GlobalsGlobal* 常量 / GlobalResource_* 资源链接类）
// 这里把"运行期全局常量 + 美术资源调用规则"集中管理，等价于原客户端的 globals 层。
// 所有相对路径都以本 HTML 所在目录（GameWorld 根）为基准；resource/ update/ fanvas3-transparent.js 等同级目录直接相对引用。

import { MapSystem } from './map.js?v=20261007c';   // 仅用于遮挡判定（occlusionOpacityAt），无循环依赖（map.js 不反向 import 本文件）

// ── 资源根目录（对齐 scripts 的 GlobalResource_* 链接类）──────────────
// 游戏已整体上移至 GameWorld 根目录，与 index.html 同级的 resource/ update/ 等直接相对引用即可（无需 "../"）。
export const RES = {
  char:     'resource/char/',     // 角色模型 swfData.js + images/
  map:      'resource/map/',      // 地图切片 Map_{c}_{r}.jpg
  effect:   'resource/effect/',   // 特效 swfData.js + images/
  skill:    'resource/skill/',    // 技能演出 swfData.js + images/
  battle:   'resource/battle/',   // 战斗状态动画(减速/虚弱/眩晕/中毒等) swfData.js + images/
  icon:     'resource/icon2/',    // 兜底图标（update 没有时回退到这里）
  update:   'update/',            // 真实客户端资源（图标更全、含 HUD 精灵）
  fanvas:   'fanvas3-transparent.js'  // Fanvas 运行时（腾讯，透明版，支持 char512/真透明）
};

// ── update/ 子目录（来自"原始客户端"导出，资源更完整） ──
export const UPDATE_DIR = {
  smallmap:  'SmallMap/icons/',                 // 各地图小地图 PNG（Smallmap_{mapId}.png）
  skill:     'SkillIcon/icons/',                // 技能图标（Skill_{id}.png），比 icon2 多 355 张
  item:      'ItemIcon/icons/',                 // 道具图标（Item_{id}.png）—— 2026-09-27 起 ItemIcon0/ItemIcon1/icon2 三份快照已全部并入此目录
  portrait:  'PortraitIcon/icons/',             // 头像（Portrait_{id}.png）
  gwImg:     'GameWorld/images/'                // GameWorld.swf 拆出的真实客户端 HUD 精灵（img1..img43）
};

// 图标子目录（icon2 下，兜底）
export const ICON_DIR = {
  skill:    'SkillIcon/icons/',
  item:     'ItemIcon/icons/',
  portrait: 'PortraitIcon/icons/',
  smallmap: 'SmallMap/icons/'
};

// ── 资源 URL 构造（调用点集中在此，方便日后换源）────────────────────
// 图标默认优先 update/（更全），失败回退 icon2/。
export const url = {
  icon:        (type, file)   => RES.update + UPDATE_DIR[type] + file,   // 默认 update（更全）
  iconFallback:(type, file)   => RES.icon + ICON_DIR[type] + file,       // icon2 兜底
  // 真实客户端 UI 图集（i18n/zh_CN/Resource*/icons）：原 Resource → Resource1 → Resource2 三级兜底。
  // 实际资源已统一合并到 Resource/icons（Resource1/icons 已清空、Resource2/icons 仅剩 2 个同源副本），
  // 故 res/res1/res2 三级现全部指向 Resource/icons，保证 HUD/战斗背景/指令按钮等位图都能加载到。
  // ★ 路径必须文档相对（无前导 /，等价于 ./）：返回值既用于 <img src>，也用于行内样式
  //   background-image:url()（如 --bag-cell-bg 等 CSS 变量），两者都按文档所在目录（GameWorld 根）解析，
  //   故 'update/...' 恒正确；部署到子路径（GitHub Pages neverland-tianshu.github.io/<子目录>/）时
  //   根相对（前导 /）会指到域名根而 404，文档相对不受影响。
  //   ⚠ 静态 CSS 文件（css/*.css）里的 url() 以样式表自身目录为基准，须写 '../update/...'。
  res:  (file, lang) => RES.update + 'i18n/' + (lang || 'zh_CN') + '/Resource/icons/' + file,
  res1: (file, lang) => RES.update + 'i18n/' + (lang || 'zh_CN') + '/Resource/icons/' + file,
  res2: (file, lang) => RES.update + 'i18n/' + (lang || 'zh_CN') + '/Resource/icons/' + file,
  // 登录资源图集（common_* 九宫格面板背景 / 标题栏图标等都在这里，真实存在）
  resLogin: (file, lang) => RES.update + 'i18n/' + (lang || 'zh_CN') + '/LoginResource/icons/' + file,
  // 小地图：update/SmallMap/icons（240 张，含新区图 1050 等）优先；
  // icon2/SmallMap/icons（165 张，含旧图 1 等）兜底。两源互补（update 缺 1、icon2 缺 1050），故需双源回退。
  // 文件名按真实客户端 mapImg（resId）命名：Smallmap_<resId>.png（非自增 mapId）。
  smallmap:    (id) => RES.update + UPDATE_DIR.smallmap + 'Smallmap_' + id + '.png',   // 主源：update
  smallmapAlt: (id) => RES.icon   + ICON_DIR.smallmap  + 'Smallmap_' + id + '.png',   // 兜底：icon2
  // GameWorld.swf 拆出的真实客户端 HUD 精灵（img1..img43.png），参考 update/GameWorld/index.html
  gwImg:       (name)         => RES.update + UPDATE_DIR.gwImg + name + '.png',
  charSwf:     (id)           => RES.char + id + '/swfData.js',
  charHtml:    (id)           => RES.char + id + '/index.html',
  charImages:  (id)           => RES.char + id + '/images/',
  effectSwf:   (name)         => RES.effect + name + '/swfData.js',
  effectHtml:  (name)         => RES.effect + name + '/index.html',
  effectImages:(name)         => RES.effect + name + '/images/',
  skillSwf:    (id)           => RES.skill + id + '/swfData.js',
  skillHtml:   (id)           => RES.skill + id + '/index.html',
  skillImages: (id)           => RES.skill + id + '/images/',
  // 战斗状态动画（减速/虚弱/眩晕/中毒等）：resource/battle/{n}/ 下 swfData.js + images/，与 effect/skill 同款 fanvas 布局
  battleSwf:    (n)           => RES.battle + n + '/swfData.js',
  battleHtml:   (n)           => RES.battle + n + '/index.html',
  battleImages: (n)           => RES.battle + n + '/images/',
  mapTile:     (mapId, c, r)  => RES.map + mapId + '/Map_' + c + '_' + r + '.jpg',
  // NPC 头像（对齐 AS3 TalkPanel.updateheader）：默认 Portrait_{id}.png；
  //   命中 config/portraits.json 的 npcOnly（实测只有 Portrait_npc_{id}.png、
  //   主图不存在的 id，如兑奖天尊 202019）时直接取 npc/ 子目录版本，免去每次 404 再回退。
  //   id 一律补零到 6 位（与真实文件名一致）。
  portrait:    (id) => {
    const m = String(id || '').match(/\d+/);
    if (!m) return '';
    const digits = m[0];
    const padded = digits.length < 6 ? digits.padStart(6, '0') : digits;
    let list = null;
    try { list = Config.portraits && Config.portraits.npcOnly; } catch (e) { list = null; }
    list = Array.isArray(list) ? list : [];
    if (list.indexOf(padded) >= 0 || list.indexOf(digits) >= 0) {
      return RES.update + UPDATE_DIR.portrait + 'Portrait_npc_' + padded + '.png';
    }
    return RES.update + UPDATE_DIR.portrait + 'Portrait_' + padded + '.png';
  }
};

// ★ 绝对化资源 URL：供「行内 style 的 CSS 自定义属性」专用。
// CSS 自定义属性（--var）里 url() 的相对路径按【消费该变量的样式表】基准解析，不是文档基准：
//   本工程 --battle-* / --bag-* 都在 css/style.css 里 var() 消费 ⇒ 基准 = css/，
//   直接塞 'update/...' 会被解析成 css/update/... 而 404（battleskill.png 精灵不显示的根因）。
// 转成基于 document.baseURI 的绝对 URL 后，基准不再参与解析，根部署与 GitHub Pages 子路径部署均正确。
// <img src> / 直接 el.style.backgroundImage= 都按文档基准，不需要走这里。
export function absUrl(p) {
  if (!p) return p;
  try { return new URL(p, document.baseURI).href; } catch (e) { return p; }
}

// 小地图底图加载：update 优先，失败回退 icon2；两源皆缺失则触发 onFail（占位，绝不黑屏/破图）
export function loadSmallmap(img, id, { onLoad, onFail } = {}) {
  let triedAlt = false;
  const primary = url.smallmap(id);
  const alt = url.smallmapAlt(id);
  img.onerror = () => {
    if (!triedAlt) { triedAlt = true; img.onerror = () => { if (onFail) onFail(); }; img.src = alt; }
    else if (onFail) onFail();
  };
  img.onload = () => { if (onLoad) onLoad(); };
  img.src = primary;
}

// ── 动作方向约定（参照 scripts/characters + 各 char/index.html 的 labels）──
// 真实素材只有 4 个对角方向：LT(左上) / RB(右下)；LB / RT 由水平翻转生成（empty）。
// 本单机版直接取 LT(朝左) / RB(朝右) 两个有独立素材的方向，不再做镜像。
export const ACTION = {
  STAND:  'stand',
  WALK:   'walk',
  ATTACK: 'attack',
  CAST:   'cast',
  HURT:   'damage',
  DOWN:   'down'
};

// 给定基础动作 + 朝向，从 actions 表解析出要播放的 definitionPool 下标
// actions: { 'standRB': {pool, empty, frames}, ... }
// ── 地图行走：半透明遮挡判定（对齐参考项目 Player.render）──────────────
// 角色(主角每帧 / NPC 静态 spawn)落在 mask===2 的遮挡格 → 半透明，便于在树后/建筑背面仍能看清。
// mask 语义：0=阻挡, 1=可走, 2=半透明遮挡但仍可走。本函数【位置驱动、与具体角色无关】，
// 主角与 NPC 共用同一规则，故抽到 globals 便于 Node 单测。
export function occlusionOpacityAt(x, y) {
  if (!MapSystem.data || !MapSystem.data.mask || !MapSystem.data.mask.length) return '1';
  const g = MapSystem.getGridPos(x, y - 5);
  if (!g || g.col < 0 || g.col >= MapSystem.data.grid_x || g.row < 0 || g.row >= MapSystem.data.grid_y) return '1';
  const m = MapSystem.data.mask[g.row * MapSystem.data.grid_x + g.col];
  return (m === 2) ? '0.4' : '1';
}

export function resolveAction(actions, base, dir) {
  if (!actions) return null;
  // 4 向等距朝向（RB/LB/RT/LT）直接精确命中（地图行走按参考项目实现 4 向切换）；
  // 否则退回 'left'/'right' 的侧优先序（战斗代码只传左右，保持兼容）。
  const ISO = ['RB', 'LB', 'RT', 'LT'];
  if (ISO.includes(dir)) {
    const exact = actions[base + dir];
    if (exact && !exact.empty) return { pool: exact.pool, frames: exact.frames };
    const order = dir[0] === 'L' ? ['LT', 'LB', 'RT', 'RB'] : ['RB', 'RT', 'LB', 'LT'];
    for (const s of order) {
      const a = actions[base + s];
      if (a && !a.empty) return { pool: a.pool, frames: a.frames };
    }
  } else {
    const order = dir === 'left' ? ['LT', 'LB', 'RT', 'RB'] : ['RB', 'RT', 'LB', 'LT'];
    for (const s of order) {
      const a = actions[base + s];
      if (a && !a.empty) return { pool: a.pool, frames: a.frames };
    }
  }
  // 退而求其次：任意同名前缀
  for (const k in actions) {
    if (k.indexOf(base) === 0 && !actions[k].empty)
      return { pool: actions[k].pool, frames: actions[k].frames };
  }
  // 攻击动作缺失时（如部分宠物模型只有 cast/stand，没有 attack），回退到 cast 也比直接 stand 更有"出手"观感；
  // 对拥有 attack 的模型（玩家/敌人）无影响——上面已命中 attack*。
  if (base === 'attack') {
    for (const s of order) {
      const a = actions['cast' + s];
      if (a && !a.empty) return { pool: a.pool, frames: a.frames };
    }
    for (const k in actions) {
      if (k.indexOf('cast') === 0 && !actions[k].empty)
        return { pool: actions[k].pool, frames: actions[k].frames };
    }
  }
  // 最后退到 stand
  for (const s of ['standRB', 'standLT', 'stand']) {
    if (actions[s]) return { pool: actions[s].pool, frames: actions[s].frames };
  }
  return null;
}

// ── NPC/出生点/传送门朝向码（0~7）映射到 4 向等距（RB/LB/RT/LT）──
// 原客户端 op106 npcToward 用 0~7 八向码；本单机版角色仅取 4 个对角朝向。
// 下列映射为按"北起顺时针分四象限"的合理推断，若与实测不符以客户端为准（待确认）。
const DIR_ISO = ['LT', 'LT', 'RT', 'RT', 'RB', 'RB', 'LB', 'LB'];
export function dirToIso(d) {
  if (typeof d === 'string' && ['RB', 'LB', 'RT', 'LT', 'left', 'right'].includes(d)) return d;
  const n = Number(d);
  if (!Number.isFinite(n) || n < 0 || n > 7) return 'RB';
  return DIR_ISO[n];
}

// ── 全局配置（等价于"后台"下发的全局表，由 net/RequestCommand 拉取）──
export const Config = {
  loaded: false,
  data: {},
  get player()    { return this.data.player; },
  get maps()      { return this.data.maps; },
  get npcs()      { return this.data.npcs; },
  get monsters()  { return this.data.monsters; },
  get items()     { return this.data.items; },
  get skills()    { return this.data.skills; },
  get quests()    { return this.data.quests; },
  get servers()   { return this.data.servers; },
  get bots()      { return this.data.bots; },
  // 宠物 / 宝箱 / 技能分表 / 宠物进阶子系统（14 面板 1:1 复刻用）
  get pets()        { return this.data.pets; },
  get chests()      { return this.data.chests; },
  get skillLevels() { return this.data.skillLevels; },
  get pet_advance() { return this.data.pet_advance; },
  get ridepet_advance() { return this.data.ridepet_advance; },
  get talk() { return this.data.talk; },
  // 角色主面板子系统（PlayerPanel / ViewProperty / ViewArm / ViewHeart / ViewBagde / ViewEssence）：由 _verify/gen_player_panel_cfg.mjs 生成
  get player_panel() { return this.data.player_panel; },
  // 玩家技能面板子系统（PlayerSkillPanel2 / 7 子视图）：由 _verify/gen_player_skill_cfg.mjs 生成
  get player_skill_panel() { return this.data.player_skill_panel; },
  // 装备制造与强化系统容器（ItemPanel03 / 14 按钮网格 + 14 子面板路由器）：由 _verify/gen_item_panel03_cfg.mjs 生成
  get item_panel03() { return this.data.item_panel03; },
  // 物品 type 数字码语义枚举（装备部位 0~13 已确证 + 非装备码推定）：由 _verify/gen_item_types.py 生成
  get item_types() { return this.data.item_types; },
  // 属性公式真源（主属性成长/五维换算/暴击命中闪避/品级变异寿命）：由 _verify/gen_attr_formula_cfg.py 生成；js/entities/attrs.js 派生的唯一数据源
  get attr_formula() { return this.data.attr_formula; },
  // 统一角色信息表（人物/宠物/怪物/骑宠同表，由 _work/gen_chars.py 生成）：
  //   kind=系别(human|monster|ridepet)；race=种类；aptitude=资质；growthRate=成长率；
  //   bodyImage=角色形象编号；skillPool=技能池(B6)；maps=出现地。怪物生成/宠物捕捉/骑宠挂件均从此表取数。
  get chars() { return this.data.chars; },
  // 物品效果原子化效果表（F3①/F3②/F11）：effects 原子定义 + itemEffectMap 物品→效果反向映射；
  //   由 _work/gen_item_effects.py 从 items.json 的 desc 实证生成，items.json 保持不动。
  get item_effects() { return this.data.item_effects; },
  // 物品六大类（CategoryType）+ 二级明细（SubType）映射表（config/item_categories.json）：
  //   type 数字码 → 分类；背包面板与战斗药品面板的分类均从此派生。缺失时 item-category.js 回退「不分类」。
  get item_categories() { return this.data.item_categories || null; },
  // variant color matrix (user-tunable via config/variant.json); null if absent
  get variant()     { return this.data.variant || null; },
  // 头像清单：npcOnly = 只存在 Portrait_npc_{id}.png 的 id（数字字符串）。
  //   渲染层据此决定主路径用 Portrait_{id}.png 还是 Portrait_npc_{id}.png。
  get portraits()   { return this.data.portraits || { npcOnly: [] }; },
  // 未觉醒升级经验表（资料库「天书奇谈-升级经验表」）：maxLevel 封顶 +
  //   expNext{ 等级N: 从 N−1 升到 N 所需经验 }（源表「累计总经验(N) = Σ table[2..N]」）。
  //   js/core/net.js 升级循环查它（等级 L 的 expNext = table[L+1]，见 net.js::expToNext）；
  //   缺失时 net.js 回退到旧的 ×1.35 兜底（不崩）。
  get level_exp()   { return this.data.level_exp || null; },
};

// 调试句柄（同款 __PETS / __chatBubbles）：探针/控制台运行期读取或 patch 配置（仅内存，不落盘）
try { window.__CONFIG = Config; } catch (e) {}

// ── JSONC 解析：兼容 config/map/map_info.json 等带 // 行注释、/* */ 块注释的配置文件 ──
export function parseJSONC(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');                 // 去块注释
  let out = '', i = 0, n = text.length, inStr = false, strCh = '';
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c; i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');                       // 去尾随逗号
  return JSON.parse(out);
}

// ── 由 config/map/map_info.json 派生出引擎可用的 maps[0] 与 npcs ──
// map_info 用 42x126 等距菱形(RP)逻辑网格 + grid 坐标；引擎寻路直接吃这份真实 pathfinding_mask
// （坐标体系与贴图矩形网格分离：RP 格经 transformRPToCXY 映射到屏幕像素，见 map.js）。
// 掩码语义对齐 AS3 GameMask：0=阻挡(不可走)，1/2=可走（2=半透明遮蔽但仍可走）。
function deriveFromMapInfo(mi) {
  const GX = mi.map_info.grid_x, GY = mi.map_info.grid_y;     // RP 网格 42 x 126
  const GW = mi.totalWidth, GH = mi.totalHeight;
  const COLS = mi.maxCol + 1, ROWS = mi.maxRow + 1;           // 渲染网格 14 x 14
  const TILEW = mi.slice_width, TILEH = mi.slice_height;
  const RP_W = mi.map_info.tile_width, RP_H = mi.map_info.tile_height;  // 菱形格 64 x 32
  const mask = mi.pathfinding_mask;
  // AS3 GameMask 语义：1/2 可走，0 阻挡；越界视为阻挡
  const walkable = (gx, gy) => (gx >= 0 && gx < GX && gy >= 0 && gy < GY) && (mask[gy * GX + gx] === 1 || mask[gy * GX + gx] === 2);
  // 等距菱形格(RP) -> 屏幕像素(格心)，与 map.js transformRPToCXY 一致
  const rpToCXY = (gx, gy) => {
    if (gy % 2 === 0) return { x: gx * RP_W, y: (gy - 1) * RP_H / 2 + RP_H / 2 };
    return { x: gx * RP_W + RP_W / 2, y: (gy - 1) * RP_H / 2 + RP_H / 2 };
  };

  // 出生点：优先 from_forest_east；若该 RP 格被阻挡则 BFS 取最近可走格（极少见）
  const sd = (mi.spawn_points || []).find(s => s.id === 'from_forest_east') || (mi.spawn_points || [])[0];
  let ax = sd ? sd.grid_x : Math.floor(GX / 2), ay = sd ? sd.grid_y : Math.floor(GY / 2);
  if (!walkable(ax, ay)) {
    const q = [[ax, ay]]; const seen = new Set([`${ax}_${ay}`]);
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    while (q.length) {
      const [x, y] = q.shift();
      if (walkable(x, y)) { ax = x; ay = y; break; }
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy, k = `${nx}_${ny}`;
        if (!seen.has(k) && nx >= 0 && nx < GX && ny >= 0 && ny < GY) { seen.add(k); q.push([nx, ny]); }
      }
    }
  }
  const spawnPx = rpToCXY(ax, ay);

  // 编辑器/兜底用的 14x14 渲染网格掩码：把每个可走 RP 格经等距变换落到其覆盖的矩形瓦片（OR 聚合）。
  // ⚠ 必须保留掩码三态（0 障碍 / 1 可走 / 2 半透明遮挡但可走），否则"遮挡(半透明)层"会丢失：
  //   聚合时若该瓦片覆盖的任一 RP 格为 2，则整块标 2（遮挡），否则标 1（可走）。
  //   —— 早期版本把所有可走格一律压成 1，导致 mapnpc 编辑器只剩「障碍红 / 可走透明」两态，
  //      蓝色的半透明遮挡层整层消失（真实 42x126 层里共有 359 个 2 格）。
  // 注意：这只是给 mapnpc 编辑器/无 pathMask 兜底用的"视图"，真实寻路仍走下方 pathMask(42x126)。
  const tileMask = new Array(COLS * ROWS).fill(0);
  for (let gy = 0; gy < GY; gy++) {
    for (let gx = 0; gx < GX; gx++) {
      if (!walkable(gx, gy)) continue;
      const c = rpToCXY(gx, gy);
      const col = Math.floor(c.x / TILEW), row = Math.floor(c.y / TILEH);
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) continue;
      const ti = row * COLS + col;
      const v = mask[gy * GX + gx];          // 走到这里必然是 1 或 2
      if (v === 2) tileMask[ti] = 2;         // 遮挡优先：任一格遮挡 → 整块标遮挡
      else if (tileMask[ti] === 0) tileMask[ti] = 1;
    }
  }

  // 复活点：spawn_points 中 id==='revive_point' 的落点（战斗失败回城落此）
  const rv = (mi.spawn_points || []).find(s => s.id === 'revive_point');
  const revivePoint = rv ? (() => { const p = rpToCXY(rv.grid_x, rv.grid_y); return { x: Math.round(p.x), y: Math.round(p.y), dir: dirToIso(rv.dir ?? 2) }; })() : null;

  // 出生点清单（保留全部，便于传送落点按 id 反查）
  const spawnPoints = (mi.spawn_points || []).map(s => {
    const p = rpToCXY(s.grid_x, s.grid_y);
    return { id: s.id, x: Math.round(p.x), y: Math.round(p.y), dir: dirToIso(s.dir ?? 4) };
  });

  // 传送门：RP 格坐标 -> 屏幕像素；targetMap 转 Number 供 changeMap 匹配
  const portals = (mi.portals || []).map(p => {
    const c = rpToCXY(p.grid_x, p.grid_y);
    return {
      id: p.id, name: p.name || '',
      x: Math.round(c.x), y: Math.round(c.y),
      targetMap: Number(p.target_map),
      targetPortal: p.target_portal || ''
    };
  });

  // 刷怪区：center 转像素；monsterId 直接引用 Config.monsters 的 key（缺失则引擎静默跳过）
  const monsterSpawners = (mi.monster_spawners || []).map(s => {
    const c = rpToCXY(s.center_grid_x, s.center_grid_y);
    return {
      spawnerId: s.spawner_id, monsterId: s.monster_id || '',
      cx: s.center_grid_x, cy: s.center_grid_y,
      x: Math.round(c.x), y: Math.round(c.y),
      radius: Number(s.radius) || 5, maxCount: Number(s.max_count) || 1,
      respawnTime: Number(s.respawn_time) || 10
    };
  });

  // 地图特效：is_follow_camera=false 用 RP 格坐标转像素（世界固定）；true 为镜头固定（屏幕坐标忽略）
  const mapEffects = (mi.map_effects || []).map(e => {
    const c = rpToCXY(e.grid_x, e.grid_y);
    return {
      name: e.effect_name || '', timeWindow: e.time_window || '00:01 - 23:59',
      followCamera: !!e.is_follow_camera,
      x: Math.round(c.x), y: Math.round(c.y)
    };
  });

  const mapId = Number(mi.map_info.map_id);
  // NPC：把 npcs_and_objects 的 RP(grid) 坐标经等距变换换算成屏幕像素(x,y)（与角色/贴图同一世界）
  const npcs = (mi.npcs_and_objects || []).map(o => {
    const p = rpToCXY(o.grid_x, o.grid_y);
    const col = Math.floor(p.x / TILEW), row = Math.floor(p.y / TILEH);
    // 强制 NPC 所在瓦片可走：仅在原本完全阻挡(0)时置 1；已是 1/2 则保留，避免把遮挡层降级为 1
    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
      const ni = row * COLS + col;
      if (tileMask[ni] === 0) tileMask[ni] = 1;
    }
    return {
      id: o.id, name: o.name, charId: o.charId, portrait: o.portrait || '',
      type: o.type, dialog: o.dialog || '', monsterId: o.monsterId || '',
      count: o.count || 0, desc: o.desc || '',
      // 闲聊气泡（地图文件 npc.chat 台词池）：配了非空台词池的 NPC 每隔 10~chatInterval 秒
      //   随机冒一句头顶气泡；空池/缺失 ⇒ 不参与定时闲聊。
      chat: Array.isArray(o.chat) ? o.chat.filter(s => typeof s === 'string' && s.trim()) : [],
      chatInterval: Number(o.chat_interval) > 0 ? Number(o.chat_interval) : 180,
      mapId,
      // 传送字段（由 gen_map_info 预分类）：mode=direct 时 target_map_name 已由 loadConfig 解析为 target_map_id
      teleport_mode: o.teleport_mode || '',
      target_map_name: o.target_map_name || '',
      target_map_id: o.target_map_id || 0,
      target_unresolved: !!o.target_unresolved,
      // 显式落点（op85 SC_TRANSFER 抓包真源；见下方 arrive 计算的优先分支）
      target_x: Number(o.target_x), target_y: Number(o.target_y),
      x: Math.round(p.x), y: Math.round(p.y),
      dir: dirToIso(o.dir ?? (o.type === 'monster' ? 4 : 6)),
      scriptId: o.script_id || '',
      // ★ 任务显隐初始标记（地图配置 questHide:true）：该实体进图默认隐藏，
      //   等 quest-actions 的 showNpc 动作触发后才显形（如白胡子/蜃龙密室门/五石柱）。
      //   未标的实体不受任务门控，恒可见（「离开」门必须保持可见，否则玩家被困图内）。
      questHide: !!o.questHide,
    };
  });
  // 强制出生点瓦片可走（同样仅在原本阻挡时置 1，保留已有的 1/2 语义）
  const sc = Math.floor(spawnPx.x / TILEW), sr = Math.floor(spawnPx.y / TILEH);
  if (sc >= 0 && sc < COLS && sr >= 0 && sr < ROWS) {
    const si = sr * COLS + sc;
    if (tileMask[si] === 0) tileMask[si] = 1;
  }

  const map = {
    id: mapId,
    name: mi.map_info.map_name,
    // —— 渲染网格（矩形 14x14，供 _renderTiles / mapnpc 编辑器）——
    cols: COLS, rows: ROWS, tileW: TILEW, tileH: TILEH,
    mask: tileMask,
    // —— 真实等距寻路层（42x126 RP），供 MapSystem 寻路/碰撞（坐标与图像分离）——
    pathCols: GX, pathRows: GY, pathTileW: RP_W, pathTileH: RP_H, pathMask: mask,
    // —— 镜头可显示区域的地图大小（格子拼合；数据解析"发现"的落地）——
    //    RP 等距菱形网格包围盒：宽 = grid_x * tile_width，高 = grid_y * (tile_height/2)
    //    （tile_height/2 为等距行间距，见 transformRPToCXY；新月村 42×64 × 126×16 = 2688×2016）
    stitchedW: GX * RP_W,
    stitchedH: GY * (RP_H / 2),
    // —— 资源编号（真实客户端 mapImg，≠ 自增 mapId）：Smallmap_<resId>.png 才是小地图底图 ——
    //    （如 新月村 mapId=3 ↔ resId=180；用 mapId 拼 URL 会 404 黑屏）
    resId: mi.map_info.res_id,
    // —— 贴图矩形渲染世界（cols×tileW × rows×tileH，如 2800×2100），仅用于渲染切片，非镜头世界 ——
    tileWorldW: COLS * TILEW,
    tileWorldH: ROWS * TILEH,
    spawn: { x: Math.round(spawnPx.x), y: Math.round(spawnPx.y) },
    spawnPoints,            // 全部出生点（含 revive_point）供传送落点反查
    revivePoint,           // 死亡复活点（缺省为 null，引擎回退到 spawn）
    portals,               // 传送门触发点（proximity/点击切图）
    monsterSpawners,       // 明雷刷怪区（区域内刷怪 + 上限 + 重生计时）
    mapEffects,            // 地图特效（世界固定点 / 镜头跟随粒子）
    // —— 暗雷遇敌规则（真源 = 地图文件 dark_encounter 区块；null = 本图无暗雷）——
    //   MainScene._rollEncounter 优先读它，未配时才回退 config/encounters.json 的同 mapId 规则。
    //   字段口径与 encounters 域一致：rate(0-1) / darkPick(perUnit|once) / darkGroup 权重表。
    //   ★ 用户裁决（2026-10-04）：删 levelMin..levelMax——资质型怪物等级恒 1（暗雷 level_min/max 随机链路已移除）。
    darkEncounter: mi.dark_encounter ? {
      rate: Math.max(0, Math.min(1, Number(mi.dark_encounter.rate) || 0)),
      darkPick: mi.dark_encounter.dark_pick === 'once' ? 'once' : 'perUnit',
      darkGroup: (Array.isArray(mi.dark_encounter.dark_group) ? mi.dark_encounter.dark_group : [])
        .filter(g => g && g.mob)
        .map(g => ({ mob: String(g.mob), weight: Math.max(0, Number(g.weight)) || 1 }))
    } : null,
    environment: {
      bgm: (mi.environment && mi.environment.bgm) || '',
      ambientSound: (mi.environment && mi.environment.ambient_sound) || '',
      weather: (mi.environment && mi.environment.weather) || 'clear',
      darkness: (mi.environment && Number.isFinite(Number(mi.environment && mi.environment.darkness))) ? Number(mi.environment.darkness) : 0
    },
    bgm: (mi.environment && mi.environment.bgm) || '',
    desc: mi.map_info.map_name
  };
  return { map, npcs };
}

// ── 配置目录定位（统一为单一来源）──
// 唯一配置目录即工程内与 index.html 同级的 config/（即 天书奇谈单机版/config/）。
// 2026-09-10 合并：原 GameWorld/config（上一级目录）的独有配置已全部并入本目录，
// 故移除 '../config/' 兜底，避免双份配置、加载歧义与 stale 副本问题。
const CONFIG_BASES = ['config/'];
async function fetchConfig(fname) {
  let lastErr;
  // ★ 配置文件必须随版本失效：SimpleHTTP 不发 Cache-Control/ETag，浏览器对只有
  //   last-modified 的响应走启发式缓存（可达数小时~一天），导致配置已更新（如
  //   talk.json 重新生成 functions 表）但玩家浏览器仍用旧缓存 —— 所有功能 NPC
  //   被判三无、交谈面板弹出即关。这里给请求带 BUILD_STAMP 作 query：发布升戳
  //   即绕过缓存，同版本内仍可缓存（性能不受影响）。
  const bs = String(window.__TS_BUILD || '');
  const m = bs.match(/\d{8}[a-z]/);   // 从 'v=20260927q · 描述…' 提取纯版本号
  const v = m ? m[0] : 'nocache';
  for (const b of CONFIG_BASES) {
    try {
      const r = await fetch(b + fname + '?v=' + v);
      if (r.ok) return r;
    } catch (e) { lastErr = e; }
  }
  return null; // 调用方按缺失兜底
}

export async function loadConfig() {
  const files = ['player', 'maps', 'npcs', 'monsters', 'items', 'skills', 'quests', 'servers',
    'pets', 'chests',
    // 宠物进阶子系统（PetAdvancePanelNew / PetWuRate / PetNeiDan）：由 _verify/gen_pet_advance_cfg.mjs 生成
    'pet_advance',
    // 骑宠进阶子系统（RidePetAdvancePanel / RidePetInfo / RidePetWuRate / ViewRidePetSkill / RidePetFate / RidePetTalent）：
    // 由 _verify/gen_ridepet_advance_cfg.mjs 生成
    'ridepet_advance',
    // 对话/任务子系统（TalkPanel / TalkRight / DescTaskPanel）：由 _verify/gen_talk_cfg.mjs 生成
    'talk',
    // 角色主面板子系统（PlayerPanel / ViewProperty / ViewArm / ViewHeart / ViewBagde / ViewEssence）：由 _verify/gen_player_panel_cfg.mjs 生成
    'player_panel',
    // 玩家技能面板子系统（PlayerSkillPanel2 / 7 子视图）：由 _verify/gen_player_skill_cfg.mjs 生成
    'player_skill_panel',
    // 装备制造与强化系统容器（ItemPanel03 / 14 按钮网格 + 14 子面板路由器）：由 _verify/gen_item_panel03_cfg.mjs 生成
    'item_panel03',
    // 物品 type 数字码语义枚举（装备部位 0~13 已确证 + 非装备码推定）：由 _verify/gen_item_types.py 生成
    'item_types',
    // 工具台扩展域（磁盘无文件则 404 兜底为空对象，localStorage 覆盖优先）
    'buffs', 'ai', 'pills', 'stories', 'dungeons', 'encounters', 'drops', 'trade',
    'shop', 'guild', 'bots', 'xinfa', 'formulas', 'achievements', 'titles', 'redeems', 'combat', 'tutor',
    // 物品富文本描述总表（AS3 原版风格）：由 _work/gen_item_rich.cjs 从抓包生成，
    //   只写 Config.items[id].descRich，不动 desc（equip-stats 仍读纯文本 desc）
    'item_rich',
    // 技能分表：与 skills.json（总表）配套的逐等级数据（见 config/skillLevels.json）
    // 属性公式真源（主属性成长 + 五维→二级属性换算 + 暴击/闪避/命中按类型 + 品级/变异/寿命）：
    //   由 _verify/gen_attr_formula_cfg.py 从原版「二级属性加成表」生成；js/entities/attrs.js 属性派生的唯一数据源
    'attr_formula',
    // 统一角色信息表（人物/宠物/怪物/骑宠同表）：由 _work/gen_chars.py 生成；怪物生成/宠物捕捉/骑宠均从此表取数
    'chars',
    // 物品效果原子化效果表（F3① 原子 / F3② 限时 / F11 宠物食物）：effects + itemEffectMap
    'item_effects',
    // 物品六大类（CategoryType）+ 二级明细（SubType）映射：type 数字码 → 分类；
    //   背包面板与战斗药品面板的分类均从此表派生；items.json / item_types.json 不动
    'item_categories',
    'skillLevels',
    // variant color matrix (config/variant.json, 4x5 row-major); null when file missing
    'variant',
    // 商城（op136 SC_COUNTER_INFO 抓包：高级/热销 123 件金子商品，见 _work/gen_mall.cjs；
    //   未收录进 items.json 的商城道具在加载时用抓包真实字段补全，见下方 mall 物品补全）
    'mall',
    // 头像清单（由 _work/gen_portraits.py 生成）：npcOnly = 只有 Portrait_npc_{id}.png、
    //   没有 Portrait_{id}.png 的 id 集合。渲染层据此直接选对文件名，避免每次 404
    //   再回退（对齐 AS3 TalkPanel.updateheader 的 getPortraitIcon→npc/ 回退路径）。
    'portraits',
    // 未觉醒各等级「升级所需经验」（资料库数据表「天书奇谈-升级经验表」1-150 级；异常值按段公式
    //   修正，逐条见文件内 _corrections）：js/core/net.js 升级逻辑的唯一真源，替代旧的 expNext*1.35。
    //   ★ 表语义：等级 N 的值 = 从 N−1 升到 N 所需经验（源表累计列 = Σ table[2..N]），
    //     故等级 L 的 expNext = table[L+1]（net.js::expToNext）
    'level_exp'];
  const out = {};

  // ── 本地覆盖迁移闸：磁盘真源（如本次合并的 skills/buffs）被旧的 localStorage 覆盖
  //    整体遮蔽时，游戏会一直读到过期数据（例：仙气护体曾显示为"点击敌人施放"）。
  //    用 schema 版本号做一次性失效：版本不符即清空所有 tsqt.cfg.* 覆盖，让磁盘生效；
  //    之后用户若用编辑器"保存"，会写入新版本覆盖并正常生效，不会被再次误清。
  const CONFIG_OVERRIDE_SCHEMA = '20260910';
  try {
    const sv = localStorage.getItem('tsqt.cfg.__schema');
    if (sv !== CONFIG_OVERRIDE_SCHEMA) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('tsqt.cfg.')) localStorage.removeItem(k);
      }
      localStorage.setItem('tsqt.cfg.__schema', CONFIG_OVERRIDE_SCHEMA);
      console.warn('[config] 已失效旧版 localStorage 覆盖，改读磁盘 config/ 真源（skills/buffs 等合并生效）');
    }
  } catch (e) {}

  await Promise.all(files.map(async (f) => {
    const r = await fetchConfig(f + '.json');
    if (r) {
      try { out[f] = await r.json(); }
      catch (e) { console.warn('配置解析失败，已用空值兜底：', f, e); out[f] = Array.isArray(out[f]) ? [] : {}; }
    } else {
      out[f] = Array.isArray(out[f]) ? [] : {};
    }
    // 本地覆盖（怪物配置器等编辑器的持久化）：localStorage['tsqt.cfg.<file>']
    try {
      const ov = localStorage.getItem('tsqt.cfg.' + f);
      if (ov) out[f] = JSON.parse(ov);
    } catch (e) {}
  }));

  // ── 商城物品补全：op136 抓包里 items.json 未收录的商城道具，用抓包真实字段（name/image/desc/type/price）
  //    注册成一等物品（id = mall_<商品id>），购买后可进背包、显示真实图标与描述。数据全部来自抓包，不臆造。
  if (out.mall && out.mall.tabs) {
    out.items = out.items || {};
    let n = 0;
    for (const mt of Object.keys(out.mall.tabs)) {
      const sub = out.mall.tabs[mt].sub || {};
      for (const tb of Object.keys(sub)) {
        for (const it of (sub[tb].items || [])) {
          if (it.itemId) continue;
          const id = 'mall_' + it.id;
          if (!out.items[id]) {
            out.items[id] = { id, name: it.name || '未知道具', image: String(it.image || ''),
              type: it.type != null ? String(it.type) : 'other', price: Number(it.price) || 0,
              desc: it.brief || it.desc || '',
              descRich: (it.desc && it.desc.indexOf('<font') >= 0) ? it.desc : undefined };
            n++;
          }
          it.itemId = id;
        }
      }
    }
    if (n) console.log('[config] 商城物品补全 ' + n + ' 件（op136 抓包真实数据，id 前缀 mall_）');
  }

  // ── 物品富文本（item_rich）：写入 Config.items[id].descRich，浮窗(showItemTip)优先读取该字段
  //    数据全部来自抓包（op178 玩家背包 / op102 NPC店 / op136 商城），不臆造；desc 保持纯文本不变。
  if (out.item_rich) {
    out.items = out.items || {};
    let nr = 0;
    for (const id of Object.keys(out.item_rich)) {
      if (out.items[id]) { out.items[id].descRich = out.item_rich[id]; nr++; }
    }
    if (nr) console.log('[config] 物品富文本 descRich 写入 ' + nr + ' 件（抓包真实数据）');
  }
  // ── 地图配置：优先 config/map/map_index.json（索引），按索引逐个加载单图文件 ──
  //    索引结构：{ start_map_id, maps:[ {id,name,file}, ... ] }，file 相对 config/map/ 目录。
  //    单图文件即"新形式"：9 区块（切片/map_info/environment/spawn_points/npcs_and_objects/
  //    portals/monster_spawners/map_effects/pathfinding_mask），详见 config/map/map_template.json。
  //    兜底：无索引时回退旧 config/map/map_info.json（多图 {maps:[...]} 或单图 {map_info,...}）。
  try {
    let derived = [];
    let startIndex = null;
    const idxR = await fetchConfig('map/map_index.json');
    if (idxR && idxR.ok) {
      const idx = parseJSONC(await idxR.text());
      out.mapInfo = idx;
      // 数据真源：config/shop.json（op102/op688 抓包生成的 NPC 商店目录，见 _work/gen_shop_catalog.cjs）
      //   地图索引无 shop_catalog 键时回落独立配置，保证 NPC 商店一定能读到货
      out.shopCatalog = idx.shop_catalog || null;
      if (!out.shopCatalog && out.shop && Object.keys(out.shop).length) out.shopCatalog = out.shop;
      for (const entry of (idx.maps || [])) {
        const mr = await fetchConfig('map/' + entry.file);
        if (!mr || !mr.ok) { console.warn('地图文件缺失，已跳过：', entry.file); continue; }
        let mi;
        try { mi = parseJSONC(await mr.text()); }
        catch (e) { console.warn('地图文件解析失败：', entry.file, e); continue; }
        derived.push(deriveFromMapInfo(mi));
      }
      startIndex = idx.start_map_id;
    } else {
      // 兜底旧形态
      const mr = await fetchConfig('map/map_info.json');
      if (mr && mr.ok) {
        const mi = parseJSONC(await mr.text());
        out.mapInfo = mi;
        out.shopCatalog = mi.shop_catalog || null;
        if (!out.shopCatalog && out.shop && Object.keys(out.shop).length) out.shopCatalog = out.shop;
        const allMaps = Array.isArray(mi.maps) ? mi.maps : [mi];
        derived = allMaps.map(m => deriveFromMapInfo(m));
        startIndex = mi.start_map_id;
      }
    }

    if (derived.length) {
      out.maps = derived.map(d => d.map);
      out.npcs = derived.flatMap(d => d.npcs);
      // 地图名 -> 规范 mapId（同名取最低 id，避开 1014 新月村 等副本实例）
      const nameToId = {};
      for (const m of out.maps) {
        if (!m.name) continue;
        if (!(m.name in nameToId) || m.id < nameToId[m.name]) nameToId[m.name] = m.id;
      }
      Config.data.mapByName = nameToId;
      out.mapByName = nameToId;
      // 解析 NPC direct 传送目标：target_map_name -> target_map_id（找不到则降级 hub + 待逆向）
      for (const n of out.npcs) {
        if (n.type === 'teleport' && n.teleport_mode === 'direct' && n.target_map_name) {
          const tid = nameToId[n.target_map_name];
          if (tid != null) n.target_map_id = tid;
          else { n.teleport_mode = 'hub'; n.target_unresolved = true; }
        }
      }
      // ★ 传送落点（用户要求「传送点直接定在传送法阵上」）：direct 传送到目标图后，落在
      //   目标图上「指回来源图」的那个传送圈位置（来回成对的法阵，如 新月村-北影月 ↔ 北影月-新月村）；
      //   目标图没有回指圈（单向入口，如 古道（25-30级））则退回目标图默认出生点。
      //   ★ 显式落点（target_x/target_y，op85 SC_TRANSFER 抓包真源）优先于上述推导——
      //     副本法阵落点由服务端指定（如 天音洞「离开」→皇城内 (1824,688)），回指法阵/出生点都不对。
      for (const n of out.npcs) {
        if (n.type !== 'teleport' || n.teleport_mode !== 'direct' || !n.target_map_id) continue;
        if (Number.isFinite(Number(n.target_x)) && Number.isFinite(Number(n.target_y))) {
          n.arrive = { x: Number(n.target_x), y: Number(n.target_y) };
          continue;
        }
        const srcName = ((out.maps.find(m => m.id === n.mapId) || {}).name) || '';
        const ret = out.npcs.find(r => r !== n && r.mapId === n.target_map_id
          && r.type === 'teleport' && r.teleport_mode === 'direct'
          && r.target_map_name === srcName);
        const tm = out.maps.find(m => m.id === n.target_map_id);
        n.arrive = ret ? { x: ret.x, y: ret.y }
          : (tm && tm.spawn ? { x: tm.spawn.x, y: tm.spawn.y } : null);
      }
      // 起始地图：优先 start_map_id，否则首图（统一转 Number，避免 "1" 与 1 比较失败）
      const sid = (startIndex != null) ? Number(startIndex) : (out.maps[0] && out.maps[0].id);
      Config.currentMapId = out.maps.some(m => m.id === sid) ? sid : (out.maps[0] && out.maps[0].id);
    }
  } catch (e) {
    console.warn('地图加载/解析失败，沿用 maps.json/npcs.json：', e);
  }

  Config.data = out;
  Config.loaded = true;
  return out;
}

// 编辑器保存：写回运行期 Config 并持久化到 localStorage（下次 loadConfig 自动覆盖）
export function persistConfig(f, obj) {
  Config.data[f] = obj;
  try { localStorage.setItem('tsqt.cfg.' + f, JSON.stringify(obj)); } catch (e) {}
}
