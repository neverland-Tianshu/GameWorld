// inventory.js
// 第二步：背包与物品业务逻辑（纯数据管理模块，不碰 DOM、不碰 localStorage）。
//
// 铁律：
//   · 只读写 save-contract.js 定义的纯净结构（背包格 {id,count} / 装备位 {slot,itemId}）。
//     任何 name/desc/image 都靠 ITEM_CONFIG 现查，绝不写回存档。
//   · 所有写操作结束后自动过一遍契约守卫（assertSaveShape 的轻量版），越界即抛错。
//   · 装备属性加成：维持 2026-09-16 裁决「本版不做装备公式」——getEquipBonus() 恒返回全 0 + TODO，
//     getPlayerAtk() 只回配置里客户端下发的最终攻击力，不做任何重算。绝不臆造系数。
//
// 堆叠上限（★ 如实标注来源，不臆造）：
//   · 装备 type 0~13：上限 1（确证 —— bagId=0 装备栏 19 件实测 count 全部 == 1）
//   · 非装备：上限未逆向。用「观测下界」9999（真实实例里观测到的最大叠加数）。
//     这是下界而非确证上限；调用方可显式覆盖（setStackLimitResolver）。

import {
  SLOTS_PER_BAG, makeSlot, toItemId, equipIndicesBySlot, equipSlotOrder,
  assertInventorySlot, assertEquipSlot, ARM19_KEYS, ARM19_LABEL,
} from './save-contract.js?v=20261007c';
import { itemConfig, itemName } from './item-config.js?v=20261007c';
import {
  effectForItem, hasItemEffect, isTimedItem, stampExpiry, sweepExpired, applyItemEffect,
} from './item-effects.js?v=20261007c';
import { isEquipType, equipSlotName, typeName, typeGroup, isUsableType } from './item-type.js?v=20261007c';

// 非装备堆叠上限的「观测下界」（来源：数据解析 item__物品实例.json 中 count 最大值 9999）。
export const OBSERVED_STACK_CEILING = 9999;

let _stackResolver = null;
/** 覆盖堆叠上限解析（返回 null 表示走默认规则）。 */
export function setStackLimitResolver(fn) { _stackResolver = fn; }

export class InventoryManager {
  /**
   * @param {object} save 由 save-contract.createInitialSave() 产出的纯净存档对象（引用，原地读写）
   */
  constructor(save) {
    if (!save) throw new Error('InventoryManager: 需要传入存档对象（save-contract 的契约结构）');
    this.save = save;
  }

  // ───────────────────────── 内部工具 ─────────────────────────
  get inventory() { return this.save.inventory; }
  get equipments() { return this.save.equipments; }

  /** 物品堆叠上限。装备=1（确证）；非装备=观测下界 9999（可被 resolver 覆盖）。 */
  stackLimit(itemId) {
    if (_stackResolver) {
      const v = _stackResolver(itemId, itemConfig(itemId));
      if (v != null) return Math.max(1, Math.trunc(Number(v)) || 1);
    }
    const cfg = itemConfig(itemId);
    if (!cfg) return 1;
    return isEquipType(cfg.type) ? 1 : OBSERVED_STACK_CEILING;
  }

  /** 写操作后的契约自检（防越界写入污染存档）。 */
  _guard() {
    this.inventory.forEach((s, i) => assertInventorySlot(s, i));
    this.equipments.forEach((e, i) => assertEquipSlot(e, i));
    // ★ 广播背包变化（任务系统的「物品提交」条件据此实时重算进度；talk.js 订阅，见 quest/talk.js）。
    //   放 _guard 是因为所有增删路径（addItem/removeItem/removeItemById/装备穿脱）都会调它。
    if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
      try { document.dispatchEvent(new CustomEvent('ts-inventory-changed')); } catch (e) {}
    }
  }

  // ───────────────────────── 查询 ─────────────────────────
  freeSlots() {
    return this.inventory.reduce((n, s) => n + (s === null ? 1 : 0), 0);
  }

  /** 某物品在背包中的总数量（跨格累加）。 */
  countOf(itemId) {
    const want = toItemId(itemId);
    if (want == null) return 0;
    return this.inventory.reduce((n, s) => n + (s && s.id === want ? s.count : 0), 0);
  }

  findSlotIndex(itemId) {
    const want = toItemId(itemId);
    if (want == null) return -1;
    return this.inventory.findIndex((s) => s && s.id === want);
  }

  /** 当前是否装备了该部位（返回装备位下标，未装备返回 -1）。 */
  findEquipIndexBySlot(slotName) {
    return this.equipments.findIndex((e) => e.slot === slotName && e.itemId != null);
  }

  // ───────────────────────── 增：添加道具 ─────────────────────────
  /**
   * 添加道具，自动处理堆叠与空格（对齐用户契约的 A/B 两段式）。
   * @returns {{ok:boolean, added:number, remaining:number, reason?:string, touched:number[]}}
   */
  addItem(itemId, count) {
    const id = toItemId(itemId);
    const n = Math.trunc(Number(count));
    if (id == null || !Number.isFinite(n) || n <= 0) {
      return { ok: false, added: 0, remaining: n > 0 ? n : 0, reason: 'bad-args', touched: [] };
    }
    const cfg = itemConfig(id);
    if (!cfg) {
      // 契约红线：背包只准装「配置里真实存在」的物品 id，未知 id 不写入
      return { ok: false, added: 0, remaining: n, reason: 'unknown-item', touched: [] };
    }

    // ★ 写入前预检：若存档里已有脏格子（被绕过 makeSlot 塞了 name/desc 等），
    //   先在【未做任何修改】的状态下抛错，避免"改了一半才报错"留下半截状态。
    this._guard();

    // F3② 限时物品：每格独立计时，不参与「填满已有格」的堆叠，全部落新格
    const timed = isTimedItem(id);
    if (timed) {
      const now = Date.now();
      let remaining2 = n, added2 = 0;
      const touched2 = [];
      for (let i = 0; i < this.inventory.length && remaining2 > 0; i++) {
        if (this.inventory[i] === null) {
          const s = makeSlot(id, 1);
          stampExpiry(s, id, 1, now);
          this.inventory[i] = s;
          remaining2--; added2++; touched2.push(i);
        }
      }
      this._guard();
      return { ok: remaining2 === 0, added: added2, remaining: remaining2, touched: touched2, reason: remaining2 > 0 ? 'bag-full' : undefined };
    }

    const limit = this.stackLimit(id);
    let remaining = n, added = 0;
    const touched = [];

    // A. 可堆叠时先填满已有格
    if (limit > 1) {
      for (let i = 0; i < this.inventory.length && remaining > 0; i++) {
        const s = this.inventory[i];
        if (s && s.id === id && s.count < limit) {
          const put = Math.min(remaining, limit - s.count);
          s.count += put; remaining -= put; added += put;
          if (touched.indexOf(i) < 0) touched.push(i);
        }
      }
    }

    // B. 余量放空格
    for (let i = 0; i < this.inventory.length && remaining > 0; i++) {
      if (this.inventory[i] === null) {
        const put = Math.min(remaining, limit);
        this.inventory[i] = makeSlot(id, put);
        remaining -= put; added += put; touched.push(i);
      }
    }

    this._guard();
    // remaining > 0 即背包已满，余量未进包（不静默丢弃，交由调用方决定）
    return { ok: remaining === 0, added, remaining, touched, reason: remaining > 0 ? 'bag-full' : undefined };
  }

  // ───────────────────────── 减：消耗/移除道具 ─────────────────────────
  /**
   * 按格子下标移除。
   * @returns {{ok:boolean, removed:number, reason?:string}}
   */
  removeItem(slotIndex, count = 1) {
    const i = Math.trunc(Number(slotIndex));
    const n = Math.trunc(Number(count));
    if (!Number.isFinite(i) || i < 0 || i >= this.inventory.length) {
      return { ok: false, removed: 0, reason: 'bad-index' };
    }
    const slot = this.inventory[i];
    if (!slot) return { ok: false, removed: 0, reason: 'empty' };
    if (!Number.isFinite(n) || n <= 0) return { ok: false, removed: 0, reason: 'bad-count' };
    if (slot.count < n) return { ok: false, removed: 0, reason: 'not-enough' };

    slot.count -= n;
    if (slot.count <= 0) this.inventory[i] = null;
    this._guard();
    return { ok: true, removed: n };
  }

  /** 按物品 id 移除（跨格扣减，从前往后）。 */
  removeItemById(itemId, count = 1) {
    const id = toItemId(itemId);
    let need = Math.trunc(Number(count));
    if (id == null || !Number.isFinite(need) || need <= 0) {
      return { ok: false, removed: 0, reason: 'bad-args' };
    }
    if (this.countOf(id) < need) return { ok: false, removed: 0, reason: 'not-enough' };
    let removed = 0;
    for (let i = 0; i < this.inventory.length && need > 0; i++) {
      const s = this.inventory[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(need, s.count);
      s.count -= take; need -= take; removed += take;
      if (s.count <= 0) this.inventory[i] = null;
    }
    this._guard();
    return { ok: true, removed };
  }

  // ───────────────────────── 穿 / 脱 ─────────────────────────
  /**
   * 穿戴背包第 slotIndex 格的装备；该部位已有装备则互换（旧装备回到刚才那格）。
   * 部位由物品 type 决定（type 0~13，已确证），重复部位（手镯/戒指/首饰）取首个空位。
   */
  equip(slotIndex) {
    const i = Math.trunc(Number(slotIndex));
    const slot = this.inventory[i];
    if (!slot) return { ok: false, reason: 'empty' };
    const cfg = itemConfig(slot.id);
    if (!cfg) return { ok: false, reason: 'unknown-item' };
    if (!isEquipType(cfg.type)) {
      return { ok: false, reason: 'not-equip', type: cfg.type, typeName: typeName(cfg.type) };
    }
    const slotName = equipSlotName(cfg.type);
    if (!slotName) return { ok: false, reason: 'unknown-slot', type: cfg.type };

    const cands = equipIndicesBySlot()[slotName] || [];
    if (!cands.length) return { ok: false, reason: 'unknown-slot', slot: slotName };
    let target = cands.find((k) => this.equipments[k].itemId == null);
    if (target == null) target = cands[0];

    const old = this.equipments[target].itemId;
    this.equipments[target].itemId = slot.id;
    this.inventory[i] = old != null ? makeSlot(old, 1) : null;
    this._guard();
    return {
      ok: true, equipIndex: target, slot: slotName,
      equipped: slot.id, equippedName: itemName(slot.id),
      returned: old, returnedName: old != null ? itemName(old) : null,
    };
  }

  /** 脱下第 equipIndex 个装备位，放回第一个空格（背包满则拒绝）。 */
  unequip(equipIndex) {
    const i = Math.trunc(Number(equipIndex));
    if (!Number.isFinite(i) || i < 0 || i >= this.equipments.length) {
      return { ok: false, reason: 'bad-index' };
    }
    const eq = this.equipments[i];
    if (eq.itemId == null) return { ok: false, reason: 'empty' };
    const free = this.inventory.indexOf(null);
    if (free < 0) return { ok: false, reason: 'bag-full' };
    const id = eq.itemId;
    eq.itemId = null;
    this.inventory[free] = makeSlot(id, 1);
    this._guard();
    return { ok: true, itemId: id, name: itemName(id), bagIndex: free, slot: eq.slot };
  }

  // ───────────────────────── 使用 ─────────────────────────
  /**
   * 使用背包第 slotIndex 格的道具。
   *   · 装备（type 0~13，已确证）→ 走 equip()，与身上装备互换。
   *   · 可右键使用类（type 语义由【用途】文本推定）→ ★ 不扣减，直接拒绝。
   *     理由：使用效果数值（回血/加经验…）在 config/items.json 中【不存在】（1661 条仅 1 条带 effect），
   *     客户端也没有可复用的效果表。若先扣减再"效果待补"，等于让道具凭空消失 —— 宁可拒绝也不做有损操作。
   *     效果数值逆向完成后，在此处补 applyEffect() 之后再 removeItem。
   *   · 材料/不可用类 → 拒绝。
   */
  /**
   * 使用背包第 slotIndex 格的道具。
   *   · 装备（type 0~13，已确证）→ 走 equip()，与身上装备互换。
   *   · 可右键使用类 → 先扫过期（F3②），再查 config/item_effects.json 的原子效果执行；
   *     有效果则扣减 1 个并回写数值，无效果仍拒绝（不臆造、不凭空消耗）。
   *   · 材料/不可用类 → 拒绝。
   * @param {number} slotIndex
   * @param {{player?:object, pet?:object}} ctx 效果目标（角色 Fighter；不传则由引擎按 saveContext/pet 面板取）
   */
  useItem(slotIndex, ctx = {}) {
    const slot = this.inventory[Math.trunc(Number(slotIndex))];
    if (!slot) return { ok: false, reason: 'empty' };
    const cfg = itemConfig(slot.id);
    if (!cfg) return { ok: false, reason: 'unknown-item' };

    if (isEquipType(cfg.type)) {
      const r = this.equip(slotIndex);
      return Object.assign({ kind: 'equip' }, r);
    }

    // F3②：限时物品到期先整格移除并回报
    if (isTimedItem(slot.id)) {
      const sw = sweepExpired(this.inventory);
      if (sw.removed.some((r) => r.slotIndex === slotIndex)) {
        return { kind: 'consume', ok: false, consumed: 0, itemId: slot.id, name: cfg.name,
                 reason: 'expired', note: '已过期并移除' };
      }
    }

    if (typeGroup(cfg.type) === 'usable' || hasItemEffect(slot.id)) {
      if (!hasItemEffect(slot.id)) {
        // desc 推定可用但效果表未映射（_pending 中的物品）：不扣减、不改数值
        return {
          kind: 'consume', ok: false, consumed: 0,
          itemId: slot.id, name: cfg.name, typeName: typeName(cfg.type),
          applied: false, reason: 'effect-not-configured',
          note: '该物品的使用效果尚未在 config/item_effects.json 中配置（见 _pending），未扣减',
        };
      }
      const r = applyItemEffect({ itemId: slot.id, player: ctx.player, pet: ctx.pet });
      if (!r.ok) {
        return { kind: 'consume', ok: false, consumed: 0, itemId: slot.id, name: cfg.name,
                 applied: false, reason: r.reason };
      }
      // 扣减 1 个（consume=true 的效果；满血等情形仍扣减，对齐原版药水）
      const willConsume = r.effect.consume !== false;
      if (willConsume) {
        const rm = this.removeItem(slotIndex, 1);
        if (!rm.ok) return { kind: 'consume', ok: false, consumed: 0, itemId: slot.id, name: cfg.name,
                             applied: true, reason: rm.reason };
      }
      return {
        kind: 'consume', ok: true, consumed: willConsume ? 1 : 0,
        itemId: slot.id, name: cfg.name, typeName: typeName(cfg.type),
        applied: true, effect: r.effect, detail: r.applied,
      };
    }

    return {
      kind: 'noop', ok: false, reason: 'not-usable',
      itemId: slot.id, name: cfg.name, typeName: typeName(cfg.type),
    };
  }

  // ───────────────────────── 装备加成（维持裁决：全 0 + TODO）─────────────────────────
  /**
   * 装备对属性的总加成。
   * ★ 维持 2026-09-16 裁决：本版不实现装备属性生成 / 强化加成公式，恒返回全 0。
   *   接入真实公式后在此累加（真实数据里也没有 stats 字段，切勿臆造系数）。
   */
  getEquipBonus() {
    const zero = {
      atk: 0, def: 0, mag: 0, magDef: 0,
      hp: 0, mp: 0, spd: 0, recover: 0,
      phyHit: 0, phyDodge: 0, phyCrit: 0,
      magHit: 0, magDodge: 0, magCrit: 0,
    };
    // TODO(未逆向)：遍历 this.equipments 调用真实 genBaseAttr / enhanceBonus 累加。
    return zero;
  }

  /**
   * 玩家攻击力。
   * 只回「配置里客户端下发的最终攻击力」，不重算（加成维持全 0）。
   * @param {number} baseAtk 基础攻击力（由调用方从角色数据传入）
   */
  getPlayerAtk(baseAtk) {
    const base = Number(baseAtk) || 0;
    const bonus = this.getEquipBonus();
    return { base, equipBonus: bonus, atkBonus: bonus.atk, total: base + bonus.atk };
  }

  // ───────────────────────── 限时物品（F3②）─────────────────────────
  /** 扫描并移除全部已过期格，返回被移除的格信息（供 UI 提示）。 */
  sweepExpired(now) { return sweepExpired(this.inventory, now); }

  // ───────────────────────── 与既有 player.equip 的兼容视图 ─────────────────────────  // ───────────────────────── 与既有 player.equip 的兼容视图 ─────────────────────────
  /**
   * 导出「槽位键 -> itemId」字典（兼容旧形态 player.equip）。
   * ★ 键用 UI 存储键（ARM19_KEYS，如 手镯2/戒指2/首饰1-4），与 player.equip 完全一致；
   *   重复部位在字典里只能表示一个，故取该部位**首个已装备**的。
   *   需要「部位名 -> itemId」或完整 19 槽信息，请用契约字段 this.equipments（含 e.slot 部位名与 index）。
   */
  getEquipDict() {
    const out = {};
    ARM19_KEYS.forEach((key, i) => {
      const label = ARM19_LABEL[i];
      if (!(label in out)) out[label] = null;
      const id = this.equipments[i] ? this.equipments[i].itemId : null;
      if (out[label] == null && id != null) out[label] = id;
    });
    return out;
  }

  /** 「部位名 -> itemId」字典（合同契约的 e.slot 命名，如 头饰/手镯/戒指/首饰）。 */
  getEquipDictBySlotName() {
    const out = {};
    for (const e of this.equipments) {
      if (!(e.slot in out)) out[e.slot] = null;
      if (out[e.slot] == null && e.itemId != null) out[e.slot] = e.itemId;
    }
    return out;
  }

  /** 装备位可读快照（调试/UI 用）。 */
  snapshotEquipments() {
    return this.equipments.map((e, i) => ({
      index: i, slot: e.slot, itemId: e.itemId,
      name: e.itemId != null ? itemName(e.itemId) : null,
    }));
  }

  /** 背包可读快照（调试/UI 用）。 */
  snapshotInventory() {
    return this.inventory.map((s, i) => ({
      index: i,
      empty: s === null,
      id: s ? s.id : null,
      count: s ? s.count : 0,
      name: s ? itemName(s.id) : null,
    }));
  }
}

// ───────────────────────── 模块级单例（绑定到「当前存档」）─────────────────────────
let _active = null;

/** 绑定存档并返回管理器（重复调用同一存档则复用）。 */
export function bindInventory(save) {
  if (!_active || _active.save !== save) _active = new InventoryManager(save);
  return _active;
}

/** 取当前管理器（未绑定时返回 null，不隐式造档）。 */
export function inventory() { return _active; }

export { SLOTS_PER_BAG, equipSlotOrder, isUsableType };
