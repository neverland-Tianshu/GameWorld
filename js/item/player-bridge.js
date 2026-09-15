// player-bridge.js
// 契约 ↔ 运行期 player 的桥接层：让 save-contract 成为 player.bag / player.equip 的唯一真源。
//
// 背景（为什么需要桥）：
//   工程既有实现（js/ui/panels.js）用派生形态表达背包与装备：
//     player.bag  = [{ itemId, count }]      稠密数组，无空格
//     player.equip = { 槽位key: itemId }     字典，把手镯2/戒指2/首饰2-4 等用序号后缀 key 区分
//   而契约（save-contract.js）用服务端同构形态：
//     save.inventory  = (null | {id,count})[18]
//     save.equipments = { slot, itemId }[19]   下标 == bagId=0 的 index
//   两者信息量等价，只差表示法。本模块负责无损双向投影，使契约成为权威、既有形态成为视图。
//
// ★ 19 槽映射（逐位已验证，多重独立证据互相印证）：
//   证据1：bagId=0(=BAG_PLAYER_ATTR 装备栏) 实测 index 0..18 与物品 type 逐位 1:1，
//          槽位重数 手镯×2 / 戒指×2 / 首饰×4；1+1+1+1+2+1+2+1+1+4+1+1+1+1 == 19。
//   证据2：panels.js 的 ARM_SLOTS 取自 AS3 ViewArm.initGridPointArray（26 个布局位），
//          扣掉不属于装备栏的 法宝×6 + 如意 = 7，余 19，其顺序与证据1 的 index 顺序一致。
//   证据3：items.json 中 type 0~13 的 1182 条装备，desc 均含「装备后绑定XXX」且每个 type 唯一。
//   命名更正（2026-09-17）：AS3 的 VIEW_ARM_BG_TIRE = lang[20242] =「头饰」（TIARA 拼写变体，
//   非「轮胎」）；旧名「护腕」已证伪 —— type1 的 144 条 desc 全部写「绑定头饰」。
//   同理 下标4/5 =「手镯」(VIEW_ARM_BG_BRACELET)、下标11-14 =「首饰」(desc 口径) /「饰品」(面板口径)。

import { Config } from '../core/globals.js?v=20261007c';
import {
  BAG_PLAYER_ATTR, SLOTS_PER_BAG, EQUIP_SLOT_TOTAL, makeSlot, toItemId,
  ARM19_KEYS, ARM19_TYPE, ARM19_LABEL, NON_BAG_ARM_KEYS, slotKeyToIndex, indexToSlotKey,
  normalizeSlotKey, normalizeSlotName, migrateSlotKeys, migrateSave, SLOT_KEY_ALIASES,
} from './save-contract.js?v=20261007c';
import { InventoryManager, bindInventory } from './inventory.js?v=20261007c';
import { itemConfig } from './item-config.js?v=20261007c';
import {
  isEquipType, equipSlotName, equipSlotPanelName, equipSlotAliases, equipSlotAs3,
  typeName, typeGroup, isBaGuaType, isFiveElementType, isPetType, isRidePetType,
  isPartnerType, isNurseryType, isHurtUpType, isLockableType, itemPanelRoute,
} from './item-type.js?v=20261007c';
import { loadOrSeed, saveGame, installConsoleApi, hasSave } from './save-store.js?v=20261007c';

// 19 装备位的 UI 存储键与 type 映射已下沉到 save-contract.js（共享，避免与 inventory.js 循环依赖），此处转出。
export { ARM19_KEYS, ARM19_TYPE, ARM19_LABEL, NON_BAG_ARM_KEYS, slotKeyToIndex, indexToSlotKey };
export { normalizeSlotKey, normalizeSlotName, migrateSlotKeys, migrateSave };

// ───────────────────────── 投影：契约 → player（权威 → 视图）─────────────────────────
/**
 * 把契约投影到运行期 player（覆盖 p.bag / p.equip 的装备栏部分）。
 * 非装备栏键（法宝/如意）原样保留，不丢。
 */
export function projectToPlayer(save, p) {
  if (!p || !save) return p;
  // 背包：稠密化（跳过空格），沿用既有的 { itemId, count } 形状
  p.bag = save.inventory
    .filter((s) => s !== null)
    .map((s) => {
      const o = { itemId: s.id, count: s.count };
      if (Number(s.expireAt) > 0) o.expireAt = s.expireAt;   // F3② 限时物品实例时间戳（倒计时显示用）
      return o;
    });

  // 装备：装备栏 19 槽按 key 写入，法宝/如意等他处键保留
  const eq = {};
  for (const k of Object.keys(p.equip || {})) {
    if (slotKeyToIndex(k) < 0) eq[k] = p.equip[k];   // 非装备栏键原样带过
  }
  save.equipments.forEach((e, i) => {
    const key = indexToSlotKey(i);
    if (key && e.itemId != null) eq[key] = e.itemId;
  });
  p.equip = eq;

  // 同步刷新 Config.player（= config/player.json 的运行期副本）：
  // 既有独立页面（如 人物属性.html / character-attrs.js 读 Config.data.player.equip）
  // 由此零改动即被契约接管，不会读到过期装备。
  const cp = Config.data && Config.data.player;
  if (cp) {
    cp.equip = Object.assign({}, eq);
    cp.bag = p.bag.map((s) => Object.assign({}, s));
  }
  return p;
}

// ───────────────────────── 投影：player → 契约（视图 → 权威）─────────────────────────
/**
 * 把运行期 player 的 bag/equip 回收进契约。用于兼容「仍有代码直接改 player.bag/equip」的过渡期，
 * 以及首次从 config/player.json 播种后的对齐。
 * @returns {{invLost:number, eqLost:number}} 因超容量而未能落进契约的条目数（不静默丢弃，向外报数）
 */
export function absorbFromPlayer(save, p) {
  const out = { invLost: 0, eqLost: 0 };
  if (!p || !save) return out;

  // 背包：按顺序铺进 18 格，超出的计入 invLost
  save.inventory = new Array(SLOTS_PER_BAG).fill(null);
  let i = 0;
  for (const s of (p.bag || [])) {
    const id = toItemId(s && s.itemId);
    const n = Math.trunc(Number(s && s.count) || 0);
    if (id == null || n <= 0) continue;
    if (i >= SLOTS_PER_BAG) { out.invLost++; continue; }
    save.inventory[i++] = makeSlot(id, n, Number(s && s.expireAt) > 0 ? Number(s.expireAt) : undefined);   // F3② 保留限时时间戳
  }

  // 装备：先清空，再按 key 回填
  save.equipments.forEach((e) => { e.itemId = null; });
  const equipDict = p.equip || {};
  for (const key of Object.keys(equipDict)) {
    const idx = slotKeyToIndex(key);
    const id = toItemId(equipDict[key]);
    if (id == null) continue;
    if (idx < 0) { out.eqLost++; continue; }        // 法宝/如意等非装备栏键：不接管
    save.equipments[idx].itemId = id;
  }
  return out;
}

// ───────────────────────── 校验：装备是否匹配该槽 ─────────────────────────
/**
 * 某物品能否穿到某装备位（依据已确证的 type↔部位 映射）。
 * 取代 panels.js 原先只认 武器/衣服 的 SLOT_TYPE。
 * @returns {{ok:boolean, reason?:string, wantType?:number, gotType?:number}}
 */
export function canEquipToSlotKey(itemId, slotKey) {
  const idx = slotKeyToIndex(slotKey);
  if (idx < 0) return { ok: false, reason: 'not-bag-slot' };
  const cfg = itemConfig(itemId);
  if (!cfg) return { ok: false, reason: 'unknown-item' };
  const want = ARM19_TYPE[idx];
  if (!isEquipType(cfg.type)) {
    return { ok: false, reason: 'not-equip', wantType: want, gotType: cfg.type };
  }
  if (Number(cfg.type) !== want) {
    return { ok: false, reason: 'type-mismatch', wantType: want, gotType: Number(cfg.type) };
  }
  return { ok: true, wantType: want, gotType: Number(cfg.type), slotName: equipSlotName(want) };
}

/** 某物品的默认装备位键（首个空位优先，否则首个同类型位）。 */
export function defaultSlotKeyForItem(itemId, save) {
  const cfg = itemConfig(itemId);
  if (!cfg || !isEquipType(cfg.type)) return null;
  const t = Number(cfg.type);
  const idxs = [];
  ARM19_TYPE.forEach((v, i) => { if (v === t) idxs.push(i); });
  if (!idxs.length) return null;
  if (save) {
    const free = idxs.find((i) => save.equipments[i].itemId == null);
    if (free != null) return indexToSlotKey(free);
  }
  return indexToSlotKey(idxs[0]);
}

/** 可穿戴的装备位清单 [{key,label,type}]（供 UI 判定 pickable）。 */
export function wearableSlotKeys() {
  return ARM19_KEYS.map((key, i) => ({ key, label: ARM19_LABEL[i], type: ARM19_TYPE[i] }));
}

// ───────────────────────── 启动 ─────────────────────────
let _boot = null;

// 一次性发放的标记键（与存档同前缀 tsqt.save.*，绝不碰 tsqt.cfg.*）
//   ★ 不存进契约（toPlainSave 只留固定字段，额外键会被剥掉），故用独立键；
//     清档不清本键 ⇒ 不会因「清档重建」反复发放。
const GRANT_KEY = 'tsqt.save.grants';
const GRANT_HPMP_100 = 'hpmp_potions_100_v1';   // 用户需求：所有 HP/MP 补充药水 ×100

/**
 * 一次性发放：把 config/item_effects.json 里所有「target=player 且含 heal_hp/heal_mp 原子」的
 * 物品各 100 个放进背包（即全部 59 种 type40 玩家药水）。
 *   · 数据驱动，不硬编码物品列表（config 加新药水自动跟进）；
 *   · 已发放过的浏览器（按 GRANT_KEY 标记）不再重复发；
 *   · 背包满时跳过剩余（216 格够，不期望失败）；
 *   · 返回本次发放的条目数（0 = 已发放过 / 无可发物品）。
 */
function oneTimeGrants(save, inv) {
  if (typeof localStorage === 'undefined') return 0;
  let done = [];
  try { done = JSON.parse(localStorage.getItem(GRANT_KEY) || '[]'); } catch (e) { done = []; }
  if (!Array.isArray(done) || done.indexOf(GRANT_HPMP_100) >= 0) return 0;

  const t = (Config.data && Config.data.item_effects) || {};
  const effects = t.effects || {};
  const map = t.itemEffectMap || {};
  const ids = [];
  for (const itemId of Object.keys(map)) {
    const e = effects[map[itemId]];
    if (!e || e.target !== 'player' || !Array.isArray(e.actions)) continue;
    if (!e.actions.some((a) => a && (a.type === 'heal_hp' || a.type === 'heal_mp'))) continue;
    ids.push(Math.trunc(Number(itemId)));
  }
  let given = 0;
  for (const id of ids) {
    if (!Number.isFinite(id)) continue;
    const r = inv.addItem(id, 100);
    if (r.ok) given++;
    else console.warn('[inventory] 一次性发放失败（背包满？）：', id, r.reason);
  }
  done.push(GRANT_HPMP_100);
  try { localStorage.setItem(GRANT_KEY, JSON.stringify(done)); } catch (e) {}
  console.log('[inventory] 一次性发放：HP/MP 药水 ×100 共 ' + given + ' 种（标记 ' + GRANT_HPMP_100 + ' 已写入 ' + GRANT_KEY + '）');
  return given;
}

/**
 * 启动物品/背包系统：读档（无档则按 config/player.json 播种）→ 绑定管理器 → 投影到 player → 挂控制台入口。
 * @param {object} player 运行期玩家对象（scene 里的那个）；省略则不投影
 * @param {{quiet?:boolean}} opts
 * @returns {{save:object, inv:InventoryManager, booted:true}}
 */
export function bootInventory(player, opts = {}) {
  if (_boot && _boot.player === player) return _boot;
  // ★ 启动前先记「是否已有存档」：有老存档时 player.bag 是 Config.player 的登录快照，
  //   绝不能吸收进契约（会把玩家真实背包/装备覆盖回配置种子 = 丢档）；
  //   只有「本次按配置重新播种」（无存档）时才回收 player 数据做播种对齐。
  const hadSave = hasSave();
  const save = loadOrSeed();
  const inv = bindInventory(save);
  if (player) {
    // 首次启动（或播种后）把契约投影到 player；若 player 已有数据则先回收进契约（不丢）
    if (!hadSave && (player.bag || player.equip)) {
      const r = absorbFromPlayer(save, player);
      if (r.invLost || r.eqLost) {
        console.warn('[inventory] 回收 player 数据时有超容量条目：背包丢', r.invLost, '装备丢', r.eqLost);
      }
    }
    // 一次性发放（在投影之前，使发放结果立即进 player.bag）
    const granted = oneTimeGrants(save, inv);
    if (granted > 0) saveGame(save);
    projectToPlayer(save, player);
  }
  // 注入 commit：控制台写操作（give/equip/...）后自动投影回 player 并落盘
  installConsoleApi(save, inv, Object.assign({ commit: (r) => commit(r) }, opts));
  // 调试/探针出口：真实模块实例的 API（供 _verify/probe_inventory.mjs 使用，避免二次 import 拿到空 Config）
  if (typeof window !== 'undefined') window.__ITEMDBG = debugApi();
  _boot = { save, inv, player, booted: true };
  return _boot;
}

/** 取启动结果（未启动返回 null）。 */
export function booted() { return _boot; }

/** 取当前权威存档对象（未启动返回 null）。 */
export function currentSave() { return _boot ? _boot.save : null; }

/**
 * 换绑到另一份契约档（完整存档的读档 / 回滚入口）。
 * ★ 必须走这里而不是直接改 _boot.save：InventoryManager 是被 bindInventory(save) 按对象身份绑定的，
 *   只换 _boot.save 会让管理器继续读写旧档（症状＝"读到新档但一改就写回旧档"）。
 * @param {object} save 新的契约档（调用方需保证已过 assertSaveShape）
 * @param {object} [player] 运行期玩家对象；给了就立即把新档投影过去
 * @returns {object|null} 新的 _boot
 */
export function rebindSave(save, player) {
  if (!_boot || !save) return null;
  _boot.save = save;
  _boot.inv = bindInventory(save);
  if (player) projectToPlayer(save, player);
  installConsoleApi(save, _boot.inv, { commit: (r) => commit(r), quiet: true });
  if (typeof window !== 'undefined') window.__ITEMDBG = debugApi();
  return _boot;
}

/**
 * 调试/探针 API 打包：把「真实模块实例」上的函数暴露出来，
 * 避免探针用动态 import 再取一次模块（无 ?v= 会拿到第二个实例，Config 为空 —— 项目铁律）。
 */
export function debugApi() {
  return {
    // 类型枚举（真实模块实例）
    isEquipType, equipSlotName, equipSlotPanelName, equipSlotAliases, equipSlotAs3,
    typeName, typeGroup,
    // 类型谓词族（一一对应 ItemManager.as）
    isBaGuaType, isFiveElementType, isPetType, isRidePetType,
    isPartnerType, isNurseryType, isHurtUpType, isLockableType, itemPanelRoute,
    // 槽位映射
    ARM19_KEYS, ARM19_TYPE, ARM19_LABEL,
    slotKeyToIndex, indexToSlotKey, canEquipToSlotKey, defaultSlotKeyForItem, wearableSlotKeys,
    // 命名迁移
    normalizeSlotKey, normalizeSlotName, migrateSlotKeys, migrateSave, SLOT_KEY_ALIASES,
    // 物品配置
    itemConfig,
    // 契约
    SLOTS_PER_BAG, EQUIP_SLOT_TOTAL,
    // 启动态
    booted,
  };
}

/**
 * 提交一次变更：投影回 player → 落盘。所有写操作（增删/穿戴）后调用。
 */
export function commit(reason) {
  if (!_boot) return { ok: false, reason: 'not-booted' };
  if (_boot.player) projectToPlayer(_boot.save, _boot.player);
  const r = saveGame(_boot.save);
  if (!r.ok) console.warn('[inventory] 落盘失败（' + reason + '）：', r.error);
  return r;
}

export { SLOTS_PER_BAG, EQUIP_SLOT_TOTAL, BAG_PLAYER_ATTR };
