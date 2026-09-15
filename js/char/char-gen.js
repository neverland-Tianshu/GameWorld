// char-gen.js
// B6 统一角色生成器：从 config/chars.json 的一条记录 + 等级，生成一个完整参战单位的数据。
//   - 基础数据：资质（表内固定）× 成长率 × 主属性公式（attrs.js deriveFromAptitude）
//   - 品级/变异/成长率：按 attr_formula.json 权重随机（普通29/优秀30/杰出25/卓越15/完美1）
//   - 技能池：按数量概率表随机抽取（不区分被动/主动），详见 rollSkillPool
//   - 寿命：所有单位统一 50×等级+500（用户裁决 2026-10-04：怪物也有寿命，取消 isPet 判定）
//   - 怒气：仅人物（attrs.hasRage）
//   ★ 变体（rank）系统已移除（2026-10-04）：变体改为在 chars.json 直接配独立记录
//     （如「猫妖·首领」自成一条），lookupChar 精确命中即可，不再随机 normal/baby/chief。
import { Config } from '../core/globals.js?v=20261007c';
import { rollGrowth, combatTypeOf, deriveFromAptitude } from '../entities/attrs.js?v=20261007c';

// ── 默认资质（按等级缩放）：chars.json 未登记资质的物种/怪物用此兜底 ──
//   用户裁决（aw）：属性全走「资质×成长率」公式，抓包固定值废弃；无资质数据的物种按等级给默认资质。
//   曲线标定与旧抓包血量同量级（lv2≈220 / lv33≈1300~2000 / lv103≈11000），五维等资质，
//   实际强弱仍由等级 + 品级成长率（rollGrowth）拉开。
const DEFAULT_APT_BASE = 3000;      // 1 级基准资质
const DEFAULT_APT_PER_LEVEL = 80;   // 每级增长
export function defaultApt(level) {
  const L = Math.max(1, Math.floor(Number(level) || 1));
  const v = DEFAULT_APT_BASE + DEFAULT_APT_PER_LEVEL * (L - 1);
  return { strong: v, vitality: v, agile: v, intellect: v, belief: v };
}
// 判定一条角色记录是否带可用资质
export function hasApt(apt) {
  if (!apt || typeof apt !== 'object') return false;
  return Object.values(apt).some((v) => Number(v) > 0);
}

// 名称归一化后缀（精英/头目变体 -> 基础名）与前缀（lookupChar 查表用）
const ELITE_SUFFIX = ['（精英）', '(精英)', '头领', '头目', '首领', '统领', '之王'];
const NAME_PREFIX = ['邪恶的', '变异', '疯狂的', '愤怒的'];

// chars.json 按 name 查记录（表本身是 name -> 记录 映射）
//   怪物模板名常带精英后缀（首领/头目/王/邪恶的…），与 chars.json 基础名对不上。
//   查表顺序：精确名 -> 去后缀/前缀 -> 包含关系（取有技能池且池最大者，仅 monster）
export function lookupChar(name) {
  const chars = Config.chars;
  if (!chars || !name) return null;
  const list = [];
  for (const k in chars) {
    if (k[0] === '_') continue;
    const v = chars[k];
    if (v && typeof v === 'object' && v.name) list.push(v);
  }
  // ① 精确名
  let r = list.find(v => v.name === name);
  if (r) return r;
  // ② 去后缀/前缀
  const stripped = (() => {
    let s = String(name);
    for (const suf of ELITE_SUFFIX) if (s.endsWith(suf)) s = s.slice(0, s.length - suf.length);
    for (const pre of NAME_PREFIX) if (s.startsWith(pre)) s = s.slice(pre.length);
    return s.trim();
  })();
  if (stripped && stripped !== name) {
    r = list.find(v => v.name === stripped);
    if (r) return r;
  }
  // ③ 包含关系：chars 名出现在模板名中（如「大山鬼」含「山鬼」），取有池且池最大者
  const contains = list
    .filter(v => v.kind === 'monster' && Array.isArray(v.skillPool) && v.skillPool.length && name.includes(v.name))
    .sort((a, b) => b.skillPool.length - a.skillPool.length);
  if (contains.length) return contains[0];
  // ④ 兜底：去后缀名的包含关系
  if (stripped && stripped !== name) {
    const contains2 = list
      .filter(v => v.kind === 'monster' && Array.isArray(v.skillPool) && v.skillPool.length && stripped.includes(v.name))
      .sort((a, b) => b.skillPool.length - a.skillPool.length);
    if (contains2.length) return contains2[0];
  }
  return null;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// B6 技能池随机：从 pool 派生 { skills, skillLevels }
//   ★ 用户裁决（2026-10-04）：不区分被动/主动，纯按【数量概率表】随机抽：
//       0 技能 28.5% / 1 技能 30% / 2 技能 30% / 3 技能 10% / 4 技能 1% / 5 技能 0.5%
//     池内可用技能数不足时，按池内最高数量（能取多少取多少）。
//     技能等级随机 1..levelMax（各技能表自带，缺省 10）。
const SKILL_COUNT_WEIGHTS = [[0, 0.285], [1, 0.30], [2, 0.30], [3, 0.10], [4, 0.01], [5, 0.005]];
export function rollSkillPool(pool, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  if (!Array.isArray(pool) || !pool.length) return { skills: [], skillLevels: {} };
  const skills = Config.skills || {};
  // 池内有效技能（技能表里有定义的才算）
  const avail = [];
  for (const id of pool) {
    if (skills[id] || skills[String(id)]) avail.push(id);
  }
  if (!avail.length) return { skills: [], skillLevels: {} };
  // 按权重摇携带数量，且不超过池内可用技能数
  const totalW = SKILL_COUNT_WEIGHTS.reduce((s, w) => s + w[1], 0);
  let r = rng() * totalW;
  let n = SKILL_COUNT_WEIGHTS[SKILL_COUNT_WEIGHTS.length - 1][0];
  for (const w of SKILL_COUNT_WEIGHTS) { r -= w[1]; if (r <= 0) { n = w[0]; break; } }
  n = Math.min(n, avail.length);
  const picked = shuffle(avail, rng).slice(0, n);
  const skillLevels = {};
  for (const id of picked) {
    const sk = skills[id] || skills[String(id)];
    const lm = Math.max(1, Math.min(10, Number(sk.levelMax) || 10));
    skillLevels[id] = Math.max(1, Math.min(lm, 1 + Math.round((lm - 1) * rng())));
  }
  return { skills: picked.slice(), skillLevels };
}

// 生成一个完整单位（怪物/宠物通用，资质型）
//   ★ 用户裁决（2026-10-04）：
//     1) 变体系统移除——normal/baby/chief 不再随机，变体请在 chars.json 直接配独立记录
//        （如「猫妖·首领」自成一条），lookupChar 精确命中；
//     2) 资质型等级恒 1（怪物由暗雷表驱动、宠物等级由怪物转化），属性全走「资质×成长率」公式；
//     3) 寿命统一——怪物也有寿命，不再按 isPet 判定（lifeMax = 50×等级+500）。
export function genUnit(char, level, opts) {
  const o = opts || {};
  const L = Math.max(1, Math.floor(Number(level) || 1));
  const rng = o.rng || Math.random;
  const g = rollGrowth(o.grade || null, rng);       // { grade, variant, growRate }
  const combatType = combatTypeOf(char.race) || combatTypeOf(char.kind) || '人形';
  // ★ 无资质数据的物种/怪物用按等级缩放的默认资质兜底（用户裁决：属性全走公式）
  const apt = hasApt(char.aptitude) ? char.aptitude : defaultApt(L);
  const unit = deriveFromAptitude(apt, L, g.growRate, combatType);
  const pool = rollSkillPool(char.skillPool, { rng });
  return {
    name: char.name,
    family: char.name,                                 // 家族=物种名，捕捉后同家族判定
    kind: char.kind, race: char.race,
    level: L,
    grade: g.grade, variant: g.variant, growRate: g.growRate,
    combatType,
    primary: unit.primary, derived: unit.derived,
    aptitudes: unit.aptitudes,
    skills: pool.skills, skillLevels: pool.skillLevels,
    life: unit.life,                                   // 寿命统一（怪物也有，不再按 isPet 判定）
    lifeMax: unit.life,
    charId: char.bodyImage || null,
    portraitImage: char.portraitImage || null,
  };
}

// ── 宠物视图合成（op572 形状）──────────────────────────────────────────
//   用户裁决（aw）：pets.json 清空、宠物全靠捕捉 ⇒ 原型 = 角色信息表记录，属性全部由公式派生。
//   inst 提供：level / grade / variant / growRate / skillList / skillLevels / life / hpCur / mpCur …
//   返回字段名一律 op572 原生名，与旧 pets.json 原型表保持面板兼容。
const RACE_TO_OUTLINE = { 野兽: 1, 人形: 2, 精灵: 3, 妖怪: 4, 神兽: 5 };
export function charToPetProto(char, inst) {
  const L = Math.max(1, Math.floor(Number(inst && inst.level) || 1));
  const growRate = Number(inst && inst.growRate) || 100;
  const apt = hasApt(char.aptitude) ? char.aptitude : defaultApt(L);
  const unit = deriveFromAptitude(apt, L, growRate, combatTypeOf(char.race) || '人形');
  const d = unit.derived, pr = unit.primary;
  const race = char.race || null;
  const out = {
    petId: String(char.name),
    name: String(char.name),
    kind: char.kind || 'monster',
    race,
    bodyImage: char.bodyImage || null,
    portraitImage: char.portraitImage || null,
    level: L,
    grade: (inst && inst.grade) || null,
    growUpRate: growRate,                    // 面板「成长率」展示
    variation: (inst && inst.variant) ? 10 : 0,   // op572 判定口径：>=10 为变异（VARIATION_BASE）
    // 五维（op572 名）
    strong: Math.round(pr.strength), vitality: Math.round(pr.stamina), agile: Math.round(pr.agility),
    intellect: Math.round(pr.intellect), belief: Math.round(pr.faith),
    // 二级属性（op572 名）
    attack: d.atk, defense: d.def, magicAttack: d.mag, magicDef: d.magDef, speed: d.spd,
    hpMax: d.maxHp, mpMax: d.maxMp, restore: d.recover,
    phyHit: d.phyHit, phyJook: d.phyDodge, phyBang: d.phyCrit,
    magicHit: d.magHit, magicJook: d.magDodge, magicBang: d.magCrit,
    lifeMax: 50 * L + 500,                   // C7：寿命上限 = 50×等级+500
    catchable: char.catchable !== false,
    // ★ bk：原始五维资质（角色信息表 aptitude）——供宠物详情面板展示「资质」本身，
    //   与上面已派生的 strong/vitality/...（一级属性）区分开。
    aptitudes: { strong: apt.strong, vitality: apt.vitality, agile: apt.agile, intellect: apt.intellect, belief: apt.belief },
  };
  if (race && RACE_TO_OUTLINE[race]) out.outLineType = RACE_TO_OUTLINE[race];
  return out;
}

// ── 玩家属性公式驱动（成长率固定 150%，无自由属性点）──────────────────────
//   职业基名 = profession 去掉「(一转)」后缀；race = 性别 + 职业基名（女术士 / 男侠客 …）
//   返回角色信息表里的 human 记录；找不到返回 null（调用方保留旧值不破坏游戏）。
export function playerProfessionChar(p) {
  if (!p) return null;
  const prof = String(p.profession || '').replace(/（.*?）|\(.*?\)/g, '').trim();
  const sex = String(p.sex || '男').trim();
  const race = sex + prof;
  const chars = Config.chars || {};
  for (const k in chars) {
    if (k[0] === '_') continue;
    const c = chars[k];
    if (c && c.kind === 'human' && c.race === race) return c;
  }
  return null;
}
// 设置玩家五维后交由 Fighter.applyDerived 派生战斗属性（装备/强化叠加仍走 applyEquip）。
//   ★ 用户裁决：每级 3 点自由属性点并入资质自然成长（成长率 150%），故 potential/leftPoint 恒 0。
export function applyPlayerAttrs(fig) {
  const ch = playerProfessionChar(fig);
  if (!ch || !hasApt(ch.aptitude)) return false;
  const L = Math.max(1, Math.floor(Number(fig.level) || 1));
  const u = deriveFromAptitude(ch.aptitude, L, 150, combatTypeOf(ch.race) || ch.race);
  fig.stamina = u.primary.stamina;
  fig.intellect = u.primary.intellect;
  fig.strength = u.primary.strength;
  fig.agility = u.primary.agility;
  fig.faith = u.primary.faith;
  fig.potential = 0;
  fig.leftPoint = 0;
  // ★ 五维已被公式洁净值覆写（不含装备/被动加成）：必须清掉层叠加脏标记，
  //   否则 applyDerived 入口会重复扣减上一轮的被动加成，主属性逐轮漂移（耐力越打越负）。
  fig._primDirty = false;
  if (typeof fig.applyDerived === 'function') fig.applyDerived();
  return true;
}
