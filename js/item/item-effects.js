// item-effects.js
// 物品效果原子化执行引擎（F3① 效果表 / F3② 限时物品 / F11 宠物食物）。
//
// 数据源：config/item_effects.json（由 _work/gen_item_effects.py 从 items.json 的 desc 实证生成）。
//   effects: { <effectId>: { id, name, desc, target, actions:[ 原子 ], consume, timed? } }
//   itemEffectMap: { <itemId>: <effectId> }（items.json 不动，反向映射）
//
// 原子（与技能体系同构的「取值 + 作用」两层）：
//   heal_hp / heal_mp / heal_life / heal_pet_hp / heal_pet_mp
//   取值：{ flat: 固定值 } 或 { pct: 最大值百分比 }（两者可叠加：先 flat 后 pct）
//
// 限时物品（F3②）：效果带 timed.durationSec 时，拾取入包在背包格上打 expireAt；
//   到期整格移除。stackPolicy: refresh=续期至满（默认）｜extend=按数量叠加时长。
//
// ⚠ 不臆造：未映射的物品（_pending）没有效果，useItem 一律拒绝，不扣减。

import { Config } from '../core/globals.js?v=20261007c';
import { itemConfig, itemName } from './item-config.js?v=20261007c';
import { saveContext } from '../save/game-save.js?v=20261007c';
import { petState } from '../pet/pet-state.js?v=20261007c';
import { pet as petView } from '../pet/pet.js?v=20261007c';

// ───────────────────────── 效果查询 ─────────────────────────
function table() { return (Config.data && Config.data.item_effects) || {}; }

/** 物品 id → 效果定义（无映射返回 null，绝不返回占位对象）。 */
export function effectForItem(itemId) {
  const t = table();
  const eid = (t.itemEffectMap || {})[String(itemId != null ? Math.trunc(Number(itemId)) : '')];
  if (!eid) return null;
  const e = (t.effects || {})[eid];
  return e && typeof e === 'object' ? e : null;
}

export function hasItemEffect(itemId) { return !!effectForItem(itemId); }

/** 限时规格（无 timed 或 durationSec<=0 返回 null）。 */
export function timedSpec(itemId) {
  const e = effectForItem(itemId);
  const sec = e && Number(e.timed && e.timed.durationSec);
  return (e && Number.isFinite(sec) && sec > 0) ? { durationSec: sec, stackPolicy: e.timed.stackPolicy || 'refresh' } : null;
}

export function isTimedItem(itemId) { return !!timedSpec(itemId); }

// ───────────────────────── 限时实例（F3②）─────────────────────────
/**
 * 给背包格打 expireAt（拾取入包时调用）。
 * @param {object} slot 背包格（{ id, count, expireAt? }，原地修改）
 * @param {number} itemId 物品 id
 * @param {number} count 本次拾取数量（extend 策略按时长叠加）
 * @returns {boolean} 是否是限时物品
 */
export function stampExpiry(slot, itemId, count = 1, now = Date.now()) {
  const spec = timedSpec(itemId);
  if (!spec) return false;
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  const add = spec.durationSec * 1000 * (spec.stackPolicy === 'extend' ? n : 1);
  const base = (slot.expireAt && spec.stackPolicy === 'extend') ? Number(slot.expireAt) : now;
  slot.expireAt = base + add;
  return true;
}

export function slotExpiry(slot) { return (slot && Number(slot.expireAt)) || 0; }
export function isExpired(slot, now = Date.now()) { const e = slotExpiry(slot); return e > 0 && now >= e; }
export function remainMs(slot, now = Date.now()) { const e = slotExpiry(slot); return e > 0 ? Math.max(0, e - now) : Infinity; }

/** 毫秒 → 「剩余 X天Y小时」「剩余 X小时Y分」「剩余 X分」「剩余 X秒」；非限时返回 ''。 */
export function fmtRemain(slot, now = Date.now()) {
  const ms = remainMs(slot, now);
  if (!Number.isFinite(ms)) return '';
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d > 0) return `剩余 ${d}天${h}小时`;
  if (h > 0) return `剩余 ${h}小时${m}分`;
  if (m > 0) return `剩余 ${m}分${sec}秒`;
  return `剩余 ${sec}秒`;
}

/**
 * 扫描并移除全部已过期格（使用/整理/存档/打开背包时调用）。
 * @param {(object|null)[]} inventory 背包数组（原地修改）
 * @returns {{removed:{slotIndex:number,itemId:number,name:string}[]}}
 */
export function sweepExpired(inventory, now = Date.now()) {
  const removed = [];
  if (!Array.isArray(inventory)) return { removed };
  for (let i = 0; i < inventory.length; i++) {
    const s = inventory[i];
    if (s && isExpired(s, now)) {
      removed.push({ slotIndex: i, itemId: s.id, name: itemName(s.id) });
      inventory[i] = null;
    }
  }
  return { removed };
}

// ───────────────────────── 原子执行 ─────────────────────────
function clampAdd(cur, max, v) {
  const base = Math.max(0, Math.min(Number(cur) || 0, Number(max) || 0));
  return Math.max(0, Math.min(base + v, Number(max) || 0));
}

/** 原子取值：flat + pct×max。 */
function valueOf(atom, max) {
  const flat = Math.max(0, Math.trunc(Number(atom.flat) || 0));
  const pct = Math.max(0, Number(atom.pct) || 0);
  return flat + Math.round(pct / 100 * (Number(max) || 0));
}

/** 选中宠物实例（target=pet_selected 用；无选中退回到出战宠物）。 */
function selectedPetInstance() {
  const view = petView();
  const cur = view.current ? view.current() : null;
  let inst = cur ? view.instanceOf(cur.petId != null ? cur.petId : cur.uid) : null;
  if (!inst) inst = petState().active || null;
  return inst;
}

function targetPet(effect, explicit) {
  if (explicit) return explicit;
  if (effect.target === 'pet_active') return petState().active || null;
  return selectedPetInstance();
}

/**
 * 执行一次物品效果（大地图使用，非战斗内）。
 * @param {{itemId:number, player?:object, pet?:object}} arg
 * @returns {{ok:boolean, reason?:string, effect?:object, applied:object[]}}
 *   ok=false 的 reason：'no-effect'（物品未配置效果）/ 'no-target'（目标不存在）
 */
export function applyItemEffect({ itemId, player, pet }) {
  const e = effectForItem(itemId);
  if (!e) return { ok: false, reason: 'no-effect', applied: [] };

  const ply = player || (saveContext().player) || null;
  const target = e.target === 'player' ? ply : targetPet(e, pet);
  if (e.target !== 'player' && !target) return { ok: false, reason: 'no-target', applied: [] };
  if (e.target === 'player' && !ply) return { ok: false, reason: 'no-target', applied: [] };

  const applied = [];
  for (const atom of (Array.isArray(e.actions) ? e.actions : [])) {
    applied.push(applyAtom(atom, ply, target));
  }
  return { ok: true, effect: e, applied };
}

function applyAtom(atom, ply, pet) {
  const id = atom && atom.type;
  switch (id) {
    case 'heal_hp': {
      const v = valueOf(atom, ply.maxHp);
      const before = ply.hp;
      ply.hp = clampAdd(ply.hp, ply.maxHp, v);
      return { ok: true, type: id, value: v, gained: ply.hp - before, cur: ply.hp, max: ply.maxHp };
    }
    case 'heal_mp': {
      const v = valueOf(atom, ply.maxMp);
      const before = ply.mp;
      ply.mp = clampAdd(ply.mp, ply.maxMp, v);
      return { ok: true, type: id, value: v, gained: ply.mp - before, cur: ply.mp, max: ply.maxMp };
    }
    case 'heal_life': {
      // 寿命上限 = 50×等级+500（C7）；实例无 lifeMax 时按公式补
      const lvl = Math.max(1, Math.trunc(Number(pet.level) || 1));
      const cap = Number(pet.lifeMax) > 0 ? Number(pet.lifeMax) : 50 * lvl + 500;
      const v = valueOf(atom, cap);
      const before = Number(pet.life) || 0;
      pet.life = Math.max(0, Math.min(before + v, cap));
      pet.lifeMax = cap;
      try { petState().save(); } catch (err) {}   // 寿命跨战斗保留，立即落盘
      return { ok: true, type: id, value: v, gained: pet.life - before, cur: pet.life, max: cap };
    }
    case 'heal_pet_hp': {
      const cap = Number(pet.hpMax) || 0;
      const v = valueOf(atom, cap);
      const before = Number(pet.hpCur) || 0;
      pet.hpCur = cap > 0 ? Math.max(0, Math.min(before + v, cap)) : before + v;
      try { petState().save(); } catch (err) {}
      return { ok: true, type: id, value: v, gained: pet.hpCur - before, cur: pet.hpCur, max: cap };
    }
    case 'heal_pet_mp': {
      const cap = Number(pet.mpMax) || 0;
      const v = valueOf(atom, cap);
      const before = Number(pet.mpCur) || 0;
      pet.mpCur = cap > 0 ? Math.max(0, Math.min(before + v, cap)) : before + v;
      try { petState().save(); } catch (err) {}
      return { ok: true, type: id, value: v, gained: pet.mpCur - before, cur: pet.mpCur, max: cap };
    }
    case 'add_life_pool': {
      // Q3：寿命池（寿命储存水晶）——存入池中，战斗结束后自动补寿命并扣减池
      const v = Math.max(0, Math.trunc(Number(atom.flat) || 0));
      const before = Number(pet.lifePool) || 0;
      pet.lifePool = before + v;
      try { petState().save(); } catch (err) {}
      return { ok: true, type: id, value: v, gained: v, cur: pet.lifePool };
    }
    default:
      return { ok: false, type: String(id), reason: 'atom-not-implemented' };
  }
}
