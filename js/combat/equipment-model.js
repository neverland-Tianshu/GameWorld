// equipment-model.js
// 装备代偿系统 —— ★ 本版按需求「不做装备」仅保留结构占位，不写死任何数值。
//
// 已确认（用户 2026-09-16）：本版不实现 EquipmentModel 的属性生成 / 强化加成公式。
// 此处仅登记「已知装备部位」（来源：现有工程 js/char-attrs/character-attrs.js 的 EQUIP_LAYOUT），
// 作为后续接入的锚点；所有加成函数返回 0 / 明确标注 TODO，绝不臆造系数。

// 装备部位（与游戏内真实槽位一致；背包格不计入属性加成）
export const EQUIP_SLOTS = [
  '武器', '衣服', '裤子', '头盔', '鞋子', '项链', '戒指', '护腕', '腰带', '披风'
];

// ★ TODO（本版未实现）：各部位基础属性生成公式
//   genBaseAttr(slot, itemLevel) -> { atk, def, mag, magDef, hp, mp, spd, ... }
// ★ TODO（本版未实现）：强化加成函数
//   enhanceBonus(slot, enhanceLevel) -> 在基础属性上的增量（线性/分段待定）

export class EquipmentModel {
  constructor(owner) {
    this.owner = owner;                 // 关联的 RoleModel / 战斗单位
    this.slots = {};                   // slot -> { itemId, enhance }
  }

  equip(slot, itemId, enhance = 0) {
    if (!EQUIP_SLOTS.includes(slot)) throw new Error('EquipmentModel: unknown slot "' + slot + '"');
    this.slots[slot] = { itemId, enhance: enhance | 0 };
  }

  // 返回当前装备对属性的总加成 —— 本版未实现，返回全 0。
  // 接入真实公式后替换为 genBaseAttr + enhanceBonus 的求和。
  totalBonus() {
    const zero = {
      atk: 0, def: 0, mag: 0, magDef: 0,
      hp: 0, mp: 0, spd: 0, recover: 0,
      phyHit: 0, phyDodge: 0, phyCrit: 0,
      magHit: 0, magDodge: 0, magCrit: 0
    };
    // TODO: 遍历 this.slots，调用 genBaseAttr / enhanceBonus 累加
    return zero;
  }
}
