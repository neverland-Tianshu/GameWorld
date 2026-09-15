// item-type.js
// 物品 type 数字码语义的运行时 API。
//
// 数据源：config/item_types.json（由 _verify/gen_item_types.py 生成，勿手改）。
//
// ★ 装备区间 0~14 ——「确证」（三方独立证据一致）：
//   ① desc 实证：config/items.json 中 type 0~13 的 1182 条装备，desc 全部含「装备后绑定XXX」，
//      且每个 type **只出现一个部位名**（type0 武器 401/401、type1 头饰 144/144、…、type13 翅膀 1/1）。
//   ② Lang 实证：update/i18n/zh_CN/Lang/zh_CN.as 中 type 0~10 == lang[20241+type]（连续无缺口）；
//      type 11/12/13 == lang[129]/lang[130]/lang[404]。
//   ③ AS3 实证：GlobalsGlobal06 的 VIEW_ARM_BG_* 常量自带英文语义（ARM/TIRE/BRACELET/GIRDLE/
//      FINGERRING/PANTS/SHOES/ACCOUTERMENT/FASHION/SHOULDER/MANTLE/WING）；ViewArm.as
//      initGridPointArray 逐槽给出 layoutKey 与底图，槽位重数 1+1+1+1+2+1+2+1+1+4+1+1+1+1 == 19。
//      ItemManager.isEquipedItem(v) = (v>=0 && v<=14) 是装备的专用判定式（CursorManager 复用它做加锁）。
//
// ★ 部位名口径：主名取 desc 口径（玩家在物品上实际看到的字），而非面板底图口径。
//   仅 2 处不同：type3 desc「衣服」/面板「上衣」；type9 desc「首饰」/面板「饰品」。
//   面板口径走 equipSlotPanelName()。
//
// ★ 谓词族（ItemManager.as，条件机器提取 + 消费者面板反证）：
//   isEquipedItem(0~14 装备) / isBaGuaItem(200~208 八卦) / isFiveElementItem(=18 五元素符) /
//   isPetItem(20~40 除 30,31) / isRidePetItem(=30,31) / isPartnerItem(=17,67,68) /
//   isNurseryItem(=144) / isHurtUpItem(=68)
//
// ★ 不使用同名的另一套编号：GlobalsGlobal05 的 reamer/doubleSword/... (1..17) 是
//   「装备打造·种类」下拉框的编码空间（含剑/双刀/鞭/琴/扇/飞轮等武器细分），
//   与物品 type 不是同一套，切勿混用。

import { Config } from '../core/globals.js?v=20261007c';

export const EQUIP_TYPE_MIN = 0;
export const EQUIP_TYPE_MAX = 14;   // ItemManager.isEquipedItem: 0 <= v <= 14

const cfg = () => Config.item_types || {};
const equipTable = () => cfg().equip || {};
const otherTable = () => cfg().other || {};
const predTable = () => cfg().predicates || {};

// ───────────────────────── 通用谓词求值 ─────────────────────────
// 与 AS3 判定式一一对应：range 段为 && 连接，exclude 为 &&! 连接，eq 为 == 或连接。
//   · 只有 range  → t ∈ range 且 t ∉ exclude（如 isEquipedItem / isPetItem）
//   · 只有 eq     → t ∈ eq（如 isFiveElementItem / isRidePetItem）
function predHit(pred, t) {
  if (!pred || !Number.isFinite(t)) return false;
  const ranges = pred.range || [];
  const eqs = pred.eq || [];
  const excl = pred.exclude || [];
  let base;
  if (ranges.length) {
    base = ranges.some(([lo, hi]) => t >= lo && t <= hi);
    if (eqs.length) base = base || eqs.indexOf(t) >= 0;
  } else {
    base = eqs.indexOf(t) >= 0;
  }
  if (base && excl.indexOf(t) >= 0) return false;
  return base;
}

/** 取某谓词在 items.json/抓包里的真实样本（供 UI 兜底判定，避免配置缺失时误判）。 */
function pred(name, t) {
  const p = predTable()[name];
  if (p) return predHit(p, t);
  // 配置未加载时的兜底：与 AS3 判定式等价的硬编码
  switch (name) {
    case 'isEquipedItem': return t >= 0 && t <= 14;
    case 'isBaGuaItem': return t >= 200 && t <= 208;
    case 'isFiveElementItem': return t === 18;
    case 'isPetItem': return t >= 20 && t <= 40 && t !== 30 && t !== 31;
    case 'isRidePetItem': return t === 30 || t === 31;
    case 'isPartnerItem': return t === 67 || t === 68 || t === 17;
    case 'isNurseryItem': return t === 144;
    case 'isHurtUpItem': return t === 68;
    default: return false;
  }
}

// ───────────────────────── 装备 ─────────────────────────
/** 该 type 是否为装备（0~14；14 无样本但 AS3 判定式算装备）。 */
export function isEquipType(type) {
  const t = Number(type);
  return Number.isFinite(t) && t >= EQUIP_TYPE_MIN && t <= EQUIP_TYPE_MAX;
}

/** type -> 中文部位名（主名，desc 口径）；未知返回 null，不猜。 */
export function equipSlotName(type) {
  const e = equipTable()[String(Number(type))];
  return e && e.isEquip ? e.zh : null;
}

/** type -> 面板底图口径部位名（仅 type3 上衣 / type9 饰品 与主名不同）。 */
export function equipSlotPanelName(type) {
  const e = equipTable()[String(Number(type))];
  return e && e.isEquip ? (e.as3BgText || e.zh) : null;
}

/** type -> 部位名别名数组（含面板口径；主名本身不在内）。 */
export function equipSlotAliases(type) {
  const e = equipTable()[String(Number(type))];
  return e && e.isEquip ? (e.zhAliases || []).slice() : [];
}

/** type -> AS3 底图证据字符串（常量名=ID(文案)），供报告/调试。 */
export function equipSlotAs3(type) {
  const e = equipTable()[String(Number(type))];
  if (!e || !e.isEquip) return null;
  return `${e.as3BgConst}=${e.as3BgId}(${e.as3BgText})`;
}

/** type -> 该部位的槽位数（手镯 2 / 戒指 2 / 首饰 4，其余 1）。 */
export function equipSlotCount(type) {
  const e = equipTable()[String(Number(type))];
  return e && e.isEquip ? Math.max(1, Number(e.slots) || 1) : 0;
}

/** 19 槽的 UI 存储键（多槽位部位带序号后缀）。配置缺失时返回 []，不猜。 */
export function equipSlotKeys() {
  const k = cfg().equipSlotKeys;
  return Array.isArray(k) ? k.slice() : [];
}

/** 19 槽下标 -> type 数组（[0,1,2,3,4,4,5,6,6,7,8,9,9,9,9,10,11,12,13]）。 */
export function equipSlotIndexType() {
  const a = cfg().equipSlotIndexType;
  return Array.isArray(a) ? a.slice() : [];
}

// ───────────────────────── 类型名 / 置信度 ─────────────────────────
/** type -> 中文类别名（装备取部位名，非装备取推定类别名）。未知返回 null。 */
export function typeName(type) {
  const k = String(Number(type));
  const e = equipTable()[k];
  if (e && e.isEquip) return e.zh;
  const o = otherTable()[k];
  return o ? o.zh : null;
}

/** 该 type 的语义置信度：'确证' | '推定' | '待逆向' | null（未知类型）。 */
export function typeConfidence(type) {
  const k = String(Number(type));
  const e = equipTable()[k];
  if (e) return e.confidence || '确证';
  const o = otherTable()[k];
  return o ? o.confidence : null;
}

/**
 * 是否「可右键使用」。
 * 装备恒为 true（右键即穿戴）；非装备取 gen_item_types.py 从 desc【用途】统计出的
 * rightClickUse 标记（推定）。★ 这只是「能不能点」，不代表已逆向出使用效果数值。
 */
export function isUsableType(type) {
  if (isEquipType(type)) return true;
  const o = otherTable()[String(Number(type))];
  return !!(o && o.rightClickUse);
}

/** 便于 UI 分组：'equip' | 'usable' | 'material' | 'unknown'。 */
export function typeGroup(type) {
  if (isEquipType(type)) return 'equip';
  const o = otherTable()[String(Number(type))];
  if (!o) return 'unknown';
  return o.rightClickUse ? 'usable' : 'material';
}

// ───────────────────────── 谓词族 API（一一对应 ItemManager.as）─────────────────────────
/** 八卦道具（type 200~208；isBaGuaItem）。 */
export function isBaGuaType(type) { return pred('isBaGuaItem', Number(type)); }
/** 五元素符（type 18；isFiveElementItem）。 */
export function isFiveElementType(type) { return pred('isFiveElementItem', Number(type)); }
/** 宠物道具（type 20~40 除 30/31；isPetItem）。 */
export function isPetType(type) { return pred('isPetItem', Number(type)); }
/** 骑宠道具（type 30/31；isRidePetItem）。 */
export function isRidePetType(type) { return pred('isRidePetItem', Number(type)); }
/** 伙伴道具（type 17/67/68；isPartnerItem）。 */
export function isPartnerType(type) { return pred('isPartnerItem', Number(type)); }
/** 蕴灵/培育道具（type 144；isNurseryItem）。 */
export function isNurseryType(type) { return pred('isNurseryItem', Number(type)); }
/** 伤害提升道具（type 68；isHurtUpItem，与 isPartnerType 在 68 上重合）。 */
export function isHurtUpType(type) { return pred('isHurtUpItem', Number(type)); }

/**
 * 是否可在背包里「加锁/保护」。
 * 依据 CursorManager.protectPlayerBag 的原式：
 *   isEquipedItem(t) || t ∈ {15,16,18,19,23,141} || isBaGuaItem(t)
 */
export function isLockableType(type) {
  const t = Number(type);
  if (!Number.isFinite(t)) return false;
  if (pred('isEquipedItem', t) || pred('isBaGuaItem', t)) return true;
  const extra = (cfg().lockableTypes && cfg().lockableTypes.extraTypes) || [15, 16, 18, 19, 23, 141];
  return extra.indexOf(t) >= 0;
}

/** 该 type 在背包里会被镜像进哪个专用面板（'pet'|'ridePet'|'partner'|'nursery'|'fiveElement'|null）。 */
export function itemPanelRoute(type) {
  const t = Number(type);
  if (pred('isPetItem', t)) return 'pet';
  if (pred('isRidePetItem', t)) return 'ridePet';
  if (pred('isPartnerItem', t)) return 'partner';
  if (pred('isNurseryItem', t)) return 'nursery';
  if (pred('isFiveElementItem', t)) return 'fiveElement';
  return null;
}

/** 调试用：整张表快照。 */
export function dumpItemTypes() {
  return {
    equip: equipTable(),
    other: otherTable(),
    predicates: predTable(),
    lockableTypes: cfg().lockableTypes || null,
    meta: cfg().meta || null,
  };
}
