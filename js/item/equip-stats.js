// equip-stats.js
// 装备属性解析 —— 把物品 desc 里的结构化属性文本解析成数值表。
//
// ★ 数据真源：config/items.json 的 desc 字段。1661 条物品中 1183 条是装备（type 0~13），
//   其中 1180 条 desc 含「基础属性：+N 属性名」格式的结构化属性段；属性不是臆造的，
//   是从 desc 逐字提取的（见 _verify/test_equip_stats.mjs 的 1180/1180 全量断言）。
//
// desc 的属性区段格式（实测样本：威凛披风 / 观心戒指 / 灵宝无量冠）：
//   基础属性：+463 防御	（每件装备恒有 1 条；type 决定是 攻击/法术攻/防御/法术防/HP上限/速度）
//   增强属性：+26 强壮  +320 HP上限  +65 物理命中 …（0~N 条）
//   绑定属性：+5000 HP上限（0~N 条；「绑定属性」只在已绑定装备出现）
//   N级铭刻：+15‰ HP上限（千分比，仅加到 HP上限/MP上限；解析为小数乘子）
//   N级附魔：+864 防御（0~N 条；与增强属性同口径累加）
//   ●【X级YY石】 +119 敏捷（宝石孔属性；只有已镶嵌宝石才有，0~N 条）
//   ○【宝石孔】（空孔，无数值）
//
// 解析口径（不臆造、不丢数）：
//   · 一律从「基础属性」起点切到段尾（出售单价/当前孔数之前），覆盖上述全部子段。
//   · 属性名 = 数值后的非空白非符号 token；数值可带小数点；‰ 单列。
//   · 未解析出任何属性的装备返回 null（调用方按「无加成」处理，不伪造 0）。
//   · 忽视类属性（忽视目标物防/忽视物理闪避/忽视法术闪避）是独立属性，单独存 key，
//     不并入 def/phyDodge —— 它们是伤害公式里的独立乘区，混入会导致面板与战斗不一致。

import { Config } from '../core/globals.js?v=20261007c';

// 属性名 → 引擎键（与 js/entities/attrs.js DERIVED_KEYS / Fighter 字段一一对齐）
// 未列出的属性名（如 土属性防）保留原中文键，不参与属性加成但可在调试输出里查到。
const NAME_TO_KEY = {
  // 五维主属性
  '强壮': 'strength', '耐力': 'stamina', '敏捷': 'agility', '智力': 'intellect', '信仰': 'faith',
  // 二级属性
  '攻击': 'atk', '物理攻击': 'atk',
  '防御': 'def', '物理防御': 'def',
  '法术攻': 'mag', '法术攻击': 'mag',
  '法术防': 'magDef', '法术防御': 'magDef',
  'HP上限': 'maxHp', 'MP上限': 'maxMp',
  '速度': 'spd', '恢复': 'recover',
  // 命中/闪避/暴击
  '物理命中': 'phyHit', '物理闪避': 'phyDodge', '物理爆击': 'phyCrit',
  '法术命中': 'magHit', '法术闪避': 'magDodge', '法术爆击': 'magCrit',
  '爆击': 'crit',   // 「爆击」点数：同时加物理/法术暴击（见 attrs.js derive 的 crit 分支）
  // 忽视类（独立属性，不并入 def/dodge）
  '忽视目标物防': 'ignoreDef', '忽视物理闪避': 'ignorePhyDodge', '忽视法术闪避': 'ignoreMagDodge',
  // 元素抗性（仅记录，暂不并入属性面板）
  '土属性防': 'earthDef',
};

// 千分比属性（铭刻）：只作用于上限类属性，按当前值乘算后叠加
const PERMILLE_KEYS = new Set(['maxHp', 'maxMp']);

// 解析单件物品的 desc → 属性表
// 返回 null 表示「无装备属性」（非装备 / desc 无基础属性 / 解析结果为空）
export function parseEquipStats(itemId) {
  const it = Config.items && Config.items[String(itemId)];
  if (!it) return null;
  const t = Number(it.type);
  if (!(t >= 0 && t <= 13)) return null;     // 非装备类型（type 0~13 才是可穿戴装备）
  const desc = String(it.desc || '');
  const baseIdx = desc.indexOf('基础属性');
  if (baseIdx < 0) return null;

  // 属性区段：从「基础属性」到「出售单价」之前（若没有则到尾）
  let seg = desc.slice(baseIdx);
  const stopIdx = seg.indexOf('出售单价');
  if (stopIdx >= 0) seg = seg.slice(0, stopIdx);

  const out = {};
  let baseOk = false;      // 基础属性必须命中至少 1 条，否则视为格式不符
  let permille = null;     // 铭刻千分比：{ maxHp: 0.015, maxMp: ... }

  const re = /(\d+(?:\.\d+)?)\s*(‰)?\s*([^\s+●○\d]+)/g;
  let m;
  while ((m = re.exec(seg))) {
    const val = Number(m[1]);
    const isPermille = m[2] === '‰';
    const zh = m[3];
    const key = NAME_TO_KEY[zh];
    if (key == null) continue;               // 未知属性名（如「耐久」里的数字）跳过
    if (isPermille) {
      if (!PERMILLE_KEYS.has(key)) continue;
      permille = permille || {};
      permille[key] = (permille[key] || 0) + val / 1000;
      baseOk = true;
      continue;
    }
    out[key] = (out[key] || 0) + val;
    baseOk = true;
  }
  if (!baseOk) return null;
  return permille ? { ...out, _permille: permille } : out;
}

// 解析结果缓存（itemId → 结果；null 也缓存，避免对 1180 条装备重复正则）
const _cache = Object.create(null);
let _cacheStamp = -1;

function stamp() {
  const d = Config.items;
  return d ? (d.__stamp || 1) : 0;
}

/** 带**缓存的解析**（物品栏/装备栏高频调用，Config.items 被热替换时自动重建缓存）。 */
export function equipStats(itemId) {
  const k = String(itemId == null ? '' : itemId);
  if (!k) return null;
  const s = stamp();
  if (s !== _cacheStamp) { for (const kk in _cache) delete _cache[kk]; _cacheStamp = s; }
  if (k in _cache) return _cache[k];
  const r = parseEquipStats(k);
  _cache[k] = r;
  return r;
}

/**
 * 汇总当前装备的全部属性加成（面板/战斗共用，保证「面板看到的 = 战斗生效的」）。
 * @param {object} equip 槽位键 → itemId（player.equip / save.equipments 投影后的字典）
 * @param {object} [base]   派生基准值（maxHp/maxMp 等，用于铭刻千分比乘算）；不传则千分比不生效
 * @returns {object} 加成表（键 = NAME_TO_KEY 的引擎键；_permille 在内部已折算进 maxHp/maxMp）
 */
export function sumEquipStats(equip, base) {
  const out = {};
  if (!equip || typeof equip !== 'object') return out;
  const bs = base || null;
  for (const slot of Object.keys(equip)) {
    const id = equip[slot];
    if (id == null || id === '') continue;
    const st = equipStats(id);
    if (!st) continue;
    for (const k of Object.keys(st)) {
      if (k === '_permille') continue;
      out[k] = (out[k] || 0) + Number(st[k]) || 0;
    }
    // 铭刻千分比：在基准上限上乘算后叠加（无基准时按 0 计，不臆造）
    if (st._permille && bs) {
      for (const k of Object.keys(st._permille)) {
        const b = Number(bs[k]) || 0;
        out[k] = (out[k] || 0) + Math.round(b * st._permille[k]);
      }
    }
  }
  return out;
}

// 是否为可穿戴装备类型（与 parseEquipStats 同口径，供 UI 判定用）
export function isEquipStatsItem(itemId) {
  return equipStats(itemId) != null;
}

// 调试/探针出口：导出映射表与缓存信息
export const EQUIP_NAME_TO_KEY = NAME_TO_KEY;
export function equipStatsCacheInfo() {
  return { stamp: _cacheStamp, size: Object.keys(_cache).length };
}
