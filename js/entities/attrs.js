// attrs.js
// 属性派生体系 —— 公式真源 config/attr_formula.json
// （由 _verify/gen_attr_formula_cfg.py 从原版「二级属性加成表」生成；改公式只改 JSON，不动代码）
//
// 三层模型（严格对齐用户裁决的天书奇谈属性体系）：
//   ① 资质（五维固定值，来自统一角色信息表）→ primaryAttr()
//        主属性 = 资质×(等级-1)×成长率/800000 + 资质/500
//        成长率：人物固定 150（原「每级 3 点自由属性点」已并入资质自然成长，A3 裁决）；
//                宠物/怪物按品级 普通100/优秀170/杰出230/卓越280/完美320，变异再 ×1.25（400% 封顶仅陈述不判定）。
//   ② 主属性（五维）→ conv 表 → 九项二级属性：生命/法力/怒气上限/速度/恢复/物攻/物防/法攻/法防
//   ③ 战斗类型（侠客/刺客/术士/修真/人形/妖怪/精灵/野兽/神兽）→ combat 表
//        命中/闪避/暴击 = 等级系数×等级 + 属性系数×主属性，受「等级上限×等级」封顶
//
// 怒气：仅人物（侠客/刺客/术士/修真）。宠物/怪物怒气上限恒为 0（hasRage 判定，derive 内统一归零）。
// 寿命：仅宠物，lifeMax(level)=50×等级+500；为 0 不能出战，需食物补充；怪物无寿命。
// 战斗初始状态：怒气从 0 开始，寿命从满值开始。
//
// 兼容：derive(primary, level[, combatType]) 返回 maxHp/maxMp/atk/def/mag/magDef/spd/rageMax/recover/
//      phyHit/phyDodge/phyCrit/magHit/magDodge/magCrit/crit/toughness/xiuwei，
//      Fighter.applyDerived 与人物属性页直接消费，字段一个没变。

import { Config } from '../core/globals.js?v=20261007c';
// ★ 静态回退公式表。原先用 import attributes（with type:json）加载，
//   但 Chrome <123 不支持该语法会导致整个 attrs.js 解析失败（B6 链路的启动依赖）。
//   改为 fetch 异步加载 + 模块级可变变量：加载完成前 formula() 用空对象兜底，
//   运行期 Config.attr_formula（loadConfig 载入）正常后由覆盖优先分支接管。
// ★ 静态回退公式表（同步优先，保证 import 期即被调用的代码拿到真公式）：
//   - Node（单测）：createRequire 同步读 config/attr_formula.json；
//   - 浏览器：fetch 异步读（相对文档根，SimpleHTTP 剥离 query）；
//   - 都失败则空对象兜底，运行期由 Config.attr_formula 覆盖分支接管。
//   原先用 import attributes（with type:json），Chrome <123 不支持会导致整个模块解析失败。
let FALLBACK = {};
try {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { createRequire } = await import('node:module');
    FALLBACK = createRequire(import.meta.url)('../../config/attr_formula.json');
  } else if (typeof fetch === 'function') {
    fetch('config/attr_formula.json')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j && j.conv && j.combat) FALLBACK = j; })
      .catch(() => {});
  }
} catch (e) { /* 兜底：空对象 */ }

// 公式表 schema 版本（与 config/attr_formula.json 的 _schema 同步）。
// 不一致只告警不阻断（仍读 Config 覆盖值），避免配置编辑器调试被卡死；实例需 recompute() 刷新。
const SCHEMA = '20260918';
let _schemaWarned = false;

// 取公式表：Config 覆盖优先（支持配置编辑器热改 + tsqt.cfg.attr_formula 持久化），
// 未加载/为空时回退静态导入（保证 Fighter 与 Node 单测在任何启动顺序下都拿到真公式，而不是 0）。
function formula() {
  const f = Config && Config.attr_formula;
  if (f && f._schema !== SCHEMA && !_schemaWarned) {
    _schemaWarned = true;
    console.warn('[attrs] attr_formula._schema 与代码不符（' + f._schema + ' != ' + SCHEMA +
      '），公式可能已更新而实例未重算；调用 recompute() 刷新');
  }
  return (f && f.conv && f.combat) ? f : FALLBACK;
}

// ── 中文标签（UI 展示用）──
export const ATTR_LABELS = {
  name: '名称', sex: '性别', level: '等级', exp: '经验', expNext: '经验上限',
  hp: '生命', mp: '法力', rage: '怒气', rageMax: '怒气上限',
  atk: '物理攻击', def: '物理防御', mag: '法术攻击', magDef: '法术防御',
  phyHit: '物理命中', phyDodge: '物理闪避', phyCrit: '物理暴击',
  magHit: '法术命中', magDodge: '法术闪避', magCrit: '法术暴击',
  spd: '速度', recover: '恢复', xiuwei: '修为',
  crit: '爆击', toughness: '韧性',
  // 主属性键与资资质键同名（五维），便于统一角色信息表读写
  strength: '强壮', stamina: '耐力', agility: '敏捷', intellect: '智力', faith: '信仰',
  aptitude: '资质', grade: '品级', variant: '变异', growRate: '成长率', life: '寿命'
};

// 主属性键 = 资质键（五维）
export const PRIMARY_KEYS = ['strength', 'stamina', 'agility', 'intellect', 'faith'];
export const APTITUDE_KEYS = PRIMARY_KEYS;

// 派生二级属性键（只读展示 / 战斗消费）
export const DERIVED_KEYS = [
  'maxHp', 'maxMp', 'atk', 'def', 'mag', 'magDef', 'spd', 'rageMax', 'recover',
  'phyHit', 'phyDodge', 'phyCrit', 'magHit', 'magDodge', 'magCrit',
  'crit', 'toughness', 'xiuwei'
];

// conv 表换算的九项二级属性（纯五维加权，原版「二级属性加成表」）
const CONV_KEYS = ['maxHp', 'maxMp', 'rageMax', 'spd', 'recover', 'atk', 'def', 'mag', 'magDef'];
// combat 表的六项（命中/闪避/暴击 × 物理/法术）
const COMBAT_KEYS = ['phyCrit', 'phyDodge', 'phyHit', 'magCrit', 'magDodge', 'magHit'];
// 人物战斗类型（有怒气）；人形/妖怪/精灵/野兽/神兽为宠物/怪物，一律无怒气
const HUMAN_COMBAT_TYPES = ['侠客', '刺客', '术士', '修真'];

// ── 待裁决占位系数（原版表中无出处，集中单一常量，确定后只改这里）──
// 爆击点数 → 物理/法术暴击双加（用户规格：「爆击：同时增加物理暴击与法术暴击」，每点贡献值无出处）
const CRIT_PER_POINT = 1.0;
// 修为每级（修为不在原版二级属性表内，作为升级货币的口径待裁决）
const XIUWEI_PER_LEVEL = 150;

// ── 数值整数化（全引擎统一口径）──
// 用户裁决：所有属性都是四舍五入的整数 —— 一级属性先取整，二级属性用取整后的一级属性
//   计算并把结果再取整；战斗侧的 hp/mp/伤害（fighter.js）也复用本函数，不另写 Math.round，
//   避免散落各处的取整口径漂移（例如「面板显示 148.05、战斗里按 148 算」）。
export function rint(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// ── ① 资质 → 主属性（用户裁决的成长公式）──
// aptitude: 单维资质；level: 等级；growRate: 成长率（百分数原值，人物 150 / 品级系数 / 变异后）
export function primaryAttr(aptitude, level, growRate) {
  const f = formula().primary;
  const L = Math.max(1, Math.floor(Number(level) || 1));
  const apt = Number(aptitude) || 0;
  const g = Number(growRate);
  const rate = (Number.isFinite(g) && g > 0) ? g : f.humanGrowRate;
  return rint(apt * (L - 1) * rate / f.divisor + apt / f.baseDivisor);   // ★ 一级属性四舍五入取整
}

// ── 品级 / 变异 / 成长率（宠物/怪物生成用）──
export function gradeRates() {
  const g = formula().grade, out = {};
  for (const k of formula().gradeOrder) out[k] = g[k] ? g[k].rate : 0;
  return out;
}
export function gradeWeights() {
  const g = formula().grade, out = {};
  for (const k of formula().gradeOrder) out[k] = g[k] ? g[k].weight : 0;
  return out;
}
// 按权重随机品级：普通29 / 优秀30 / 杰出25 / 卓越15 / 完美1
export function rollGrade(rng) {
  const g = formula().grade, order = formula().gradeOrder;
  let r = (rng || Math.random)() * order.reduce((s, k) => s + (g[k] ? g[k].weight : 0), 0);
  for (const k of order) { r -= (g[k] ? g[k].weight : 0); if (r <= 0) return k; }
  return order[order.length - 1];
}
// 变异判定：仅 杰出(0.1%) / 卓越(0.4%) / 完美(1.5%) 可变异；普通/优秀恒 false
//   ★ 用户裁决：变异概率全局缩小 10 倍（原 1%/3%/30%，全局总变异率 1.00% -> 0.10%）
export function rollVariant(grade, rng) {
  const g = formula().grade[grade];
  return !!(g && g.variant && (rng || Math.random)() < g.variant);
}
// 成长率 = 品级系数 × (变异 ? variantMultiplier : 1)；400% 上限仅陈述、此处不判定
export function growRateOf(grade, variant) {
  const g = formula().grade[grade];
  if (!g) return formula().primary.humanGrowRate;
  return g.rate * (variant ? formula().primary.variantMultiplier : 1);
}
// 一次摇完：{ grade, variant, growRate }；grade 留空则先按权重摇品级
export function rollGrowth(grade, rng) {
  const g2 = grade || rollGrade(rng);
  const v = rollVariant(g2, rng);
  return { grade: g2, variant: v, growRate: growRateOf(g2, v) };
}

// ── 战斗类型映射（种类 → combat 表键）──
// 男侠客→侠客 / 女修真→修真 / 神兽→神兽 / 人形→人形 …；未映射的种类若自身就是 combat 键则直用
export function combatTypeOf(kind) {
  if (!kind) return null;
  // ★ 归一化：去掉「(一转)」等转生/阶段后缀（与 char-gen.playerProfessionChar 同口径）。
  //   否则 profession='术士(一转)' 命中不到映射表 → 回退'人形' → hasRage 误判为否 → 玩家怒气被归零。
  const k = String(kind).replace(/（.*?）|\(.*?\)/g, '').trim();
  if (!k) return null;
  const m = formula().combatTypeMap;
  if (m[k]) return m[k];
  return formula().combat[k] ? k : null;
}
// 是否人物战斗类型（仅人物有怒气；宠物/怪物一律无怒气）
export function hasRage(combatType) {
  return HUMAN_COMBAT_TYPES.includes(combatTypeOf(combatType));
}

// ── 寿命（仅宠物）：50×等级+500 ──
export function lifeMax(level) {
  const l = formula().life;
  return l.perLevel * Math.max(1, Math.floor(Number(level) || 1)) + l.base;
}

// ── ②③ 主属性 → 全部二级属性（conv + combat，公式全部来自配置表）──
// primary: { strength, stamina, agility, intellect, faith[, crit, toughness, combatType] }
// combatType: 可选，人物职业或宠物种类（男侠客/神兽/人形…）；缺省回退 primary.combatType，再缺省回 '人形'
export function derive(primary, level, combatType) {
  const F = formula();
  const L = Math.max(1, Math.floor(Number(level) || 1));
  const p = { strength: 0, stamina: 0, agility: 0, intellect: 0, faith: 0, crit: 0, toughness: 0 };
  Object.assign(p, primary || {});

  // conv：五维加权九项二级属性
  const out = {};
  for (const dk of CONV_KEYS) out[dk] = 0;
  for (const pk of PRIMARY_KEYS) {
    const c = F.conv[pk];
    const v = rint(p[pk]);          // ★ 二级属性用【整数】一级属性计算
    if (!c || !v) continue;
    for (const dk of CONV_KEYS) out[dk] += (c[dk] || 0) * v;
  }

  // combat：命中/闪避/暴击（按战斗类型），受等级上限封顶
  const ct = combatTypeOf(combatType) || combatTypeOf(p.combatType) || '人形';
  const cb = F.combat[ct] || F.combat['人形'] || {};
  for (const k of COMBAT_KEYS) {
    const cf = cb[k] || {};
    const av = cf.attr ? rint(p[cf.attr]) : 0;
    let v = (cf.lvl || 0) * L + (cf.per || 0) * av;
    const cap = (cf.capLvl || 0) * L;
    if (cap > 0 && v > cap) v = cap;          // 超出等级上限的部分不生效
    out[k] = v;
  }

  // 爆击（combined）：同时加物理/法术暴击（在封顶之外叠加，装备爆击永远生效）
  const critPt = Number(p.crit) || 0;
  out.phyCrit += critPt * CRIT_PER_POINT;
  out.magCrit += critPt * CRIT_PER_POINT;
  out.crit = critPt;
  out.toughness = Number(p.toughness) || 0;

  // 怒气：仅人物。宠物/怪物怒气上限恒为 0（战斗中也不产生/不消耗）
  if (!hasRage(ct)) out.rageMax = 0;

  // 修为（待裁决占位）
  out.xiuwei = XIUWEI_PER_LEVEL * L;

  // 整数化：全部二级属性四舍五入（recover 可为负，Math.round 对负数同样四舍五入）
  for (const k of ['maxHp', 'maxMp', 'atk', 'def', 'mag', 'magDef', 'spd', 'rageMax', 'recover',
                   'phyHit', 'phyDodge', 'phyCrit', 'magHit', 'magDodge', 'magCrit',
                   'crit', 'toughness', 'xiuwei']) {
    out[k] = rint(out[k]);
  }
  out._combatType = ct;
  return out;
}

// ── 资质一步到位（怪物/宠物生成管线用）：返回主属性 + 派生 + 寿命 ──
// apt: 五维资质；growRate: 品级成长率（rollGrowth 得到）或人物 150；combatType: 种类/职业
// 资质键归一化：chars.json（源自「宠物资质总表.csv」）用 op572 名 strong/vitality/agile/intellect/belief，
//   而 PRIMARY_KEYS 用 Fighter 名 strength/stamina/agility/intellect/faith。
//   两种键序在此统一归一化，否则除 intellect（恰好同名）外全部取 0，公式派生值全为垃圾。
const APT_KEY_ALIAS = { strong: 'strength', vitality: 'stamina', agile: 'agility', intellect: 'intellect', belief: 'faith' };
function normalizeApt(apt) {
  if (!apt || typeof apt !== 'object') return {};
  const out = {};
  for (const k in apt) {
    const to = APT_KEY_ALIAS[k] || (PRIMARY_KEYS.indexOf(k) >= 0 ? k : null);
    const v = Number(apt[k]);
    if (to && v > 0) out[to] = v;
  }
  return out;
}

export function deriveFromAptitude(apt, level, growRate, combatType) {
  const a = normalizeApt(apt);
  const primary = {};
  for (const k of PRIMARY_KEYS) primary[k] = primaryAttr(a[k], level, growRate);
  const derived = derive(Object.assign({ combatType: combatType || null }, primary), level, combatType);
  return {
    primary, derived,
    aptitudes: a,
    growRate: (Number(growRate) > 0) ? Number(growRate) : formula().primary.humanGrowRate,
    life: lifeMax(level)          // 宠物寿命（怪物不消费，统一表按 kind 决定是否下发）
  };
}