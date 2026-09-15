// save-store.js
// 第三步：存盘 / 读盘（localStorage 单机落盘）。
//
// ★ 键名铁律：用 'tsqt.save.player'，绝不能用 'tsqt.cfg.' 前缀 ——
//   globals.js:431 的 CONFIG_OVERRIDE_SCHEMA 闸在版本不符时会遍历删除所有 'tsqt.cfg.*'，
//   存档会被连带清掉（静默丢档）。
//
// 版本策略：SAVE_SCHEMA 不符时【丢弃旧档并按配置重新播种】，不做隐式猜测迁移。
//   需要迁移时在此显式写 migrate(old) 并逐版升级，不靠"看起来像"。
//   例外：纯命名迁移（部位名 头盔/护腕→头饰、上衣→衣服、饰品→首饰）不改结构、不动 schema，
//   由 save-contract.migrateSave() 在读档时**原地改名**，因此旧档不会因改名而丢。
//   旧 UI 存储键（player.equip 的 护腕/佩饰N/手镯/戒指）由 normalizeSlotKey/migrateSlotKeys 吸收。

import { Config, loadConfig } from '../core/globals.js?v=20261007c';
import { saveContext } from '../save/game-save.js?v=20261007c';
import {
  SAVE_SCHEMA, SAVE_KEY, createInitialSave, seedSaveFromConfigPlayer,
  assertSaveShape, toPlainSave, migrateSave, migrateBagSlotsV1,
} from './save-contract.js?v=20261007c';

/** 读原始字符串（localStorage 不可用时返回 null，不抛）。 */
function rawGet() {
  try { return localStorage.getItem(SAVE_KEY); } catch (e) { return null; }
}

function rawSet(s) {
  try { localStorage.setItem(SAVE_KEY, s); return true; } catch (e) {
    console.warn('[save] 写入失败：', e && e.message);
    return false;
  }
}

export function hasSave() { return rawGet() != null; }

/** 清档。 */
export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); return true; } catch (e) { return false; }
}

/**
 * 落盘。写的是 toPlainSave() 的纯净快照，确保即便有代码绕过 makeSlot 塞了脏字段，
 * 落盘的也一定是契约结构。
 * @returns {{ok:boolean, bytes:number, error?:string}}
 */
export function saveGame(save) {
  if (!save) return { ok: false, bytes: 0, error: 'no-save-object' };
  let plain;
  try {
    plain = toPlainSave(save);
    assertSaveShape(plain, 'saveGame');
  } catch (e) {
    return { ok: false, bytes: 0, error: 'contract-violation: ' + (e && e.message) };
  }
  const s = JSON.stringify(plain);
  const ok = rawSet(s);
  return { ok, bytes: s.length, error: ok ? undefined : 'quota-or-denied' };
}

/**
 * 读盘。
 * @returns {{ok:boolean, save?:object, reason?:string}}
 *   reason: 'no-save' | 'bad-json' | 'schema-mismatch' | 'shape-violation'
 */
export function loadGame() {
  const raw = rawGet();
  if (raw == null) return { ok: false, reason: 'no-save' };
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'bad-json' }; }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'bad-json' };
  // ★ 版本闸前先跑「显式迁移」：schema 1→2（背包 18→216 格，补 null 不丢档）。
  //   迁移在版本检查之前，否则旧档会被 schema-mismatch 直接丢弃（播种后丢光玩家物品）。
  //   无法识别的版本（非 1）一律不迁移，继续走下面的丢弃逻辑（不做隐式猜测）。
  try { migrateBagSlotsV1(obj); } catch (e) { /* 迁移失败交给下面 assert 报错 */ }
  if (Number(obj.schema) !== SAVE_SCHEMA) {
    return { ok: false, reason: 'schema-mismatch', found: obj.schema, expect: SAVE_SCHEMA };
  }
  // ① 「只改名不动结构」的部位名迁移（旧名 头盔/护腕/上衣/饰品 -> 头饰/头饰/衣服/首饰）。
  //    schema 不变，故旧档无需丢弃；迁移在 assert 之前，避免旧名被 isKnownSlot 判为非法而误丢档。
  try { migrateSave(obj); } catch (e) { /* 迁移失败不致命，交给下面 assert 报错 */ }
  try { assertSaveShape(obj, 'loadGame'); } catch (e) {
    return { ok: false, reason: 'shape-violation', error: e && e.message };
  }
  // 补齐缺失顶层字段（只补契约内字段，不猜额外字段）
  const save = createInitialSave({ name: obj.name, level: obj.level, hp: obj.hp, maxHp: obj.maxHp });
  save.inventory = obj.inventory.map((s) => (s ? Object.assign(
    { id: Number(s.id), count: Number(s.count) },
    (Number(s.expireAt) > 0 ? { expireAt: Number(s.expireAt) } : {})) : null));
  save.equipments = obj.equipments.map((e) => ({ slot: String(e.slot), itemId: e.itemId == null ? null : Number(e.itemId) }));
  return { ok: true, save };
}

/**
 * 启动入口：优先读存档；没有/损坏/版本不符则按 config/player.json 重新播种。
 * 播种时会把 Config.player.equip 现有的装备搬进契约的 equipments（不丢现有数据）。
 * @returns {object} 可用的纯净存档
 */
export function loadOrSeed() {
  const r = loadGame();
  if (r.ok) return r.save;
  if (r.reason && r.reason !== 'no-save') {
    console.warn('[save] 存档不可用（' + r.reason + (r.error ? ' · ' + r.error : '') + '），按配置重新播种');
  }
  return seedSaveFromConfigPlayer();
}

/** 存档摘要（控制台排查用）。 */
export function saveInfo() {
  const raw = rawGet();
  if (raw == null) return { exists: false, key: SAVE_KEY };
  let schema = null, bytes = raw.length;
  try { schema = JSON.parse(raw).schema; } catch (e) {}
  return { exists: true, key: SAVE_KEY, bytes, schema, schemaOk: Number(schema) === SAVE_SCHEMA };
}

/**
 * 挂控制台入口（用户要求「在控制台直接调一次」）。
 * 暴露：__SAVE(存档对象) / __save() / __load() / __inv(InventoryManager) / __saveInfo()
 * 以及便捷的 __give(id,count) / __use(i) / __equip(i)
 */
export function installConsoleApi(save, inv, opts = {}) {
  if (typeof window === 'undefined') return null;
  // 变更后提交：投影回 player + 落盘。由调用方注入（避免 save-store ←→ player-bridge 循环依赖）。
  const commit = typeof opts.commit === 'function' ? opts.commit : (() => {});
  const wrap = (fn) => (...a) => { const r = fn(...a); commit('console'); return r; };
  const api = {
    save,
    inv,
    saveGame: () => saveGame(save),
    loadGame: () => loadGame(),
    loadOrSeed: () => loadOrSeed(),
    info: () => saveInfo(),
    // 以下写操作成功后自动提交（投影 + 落盘），控制台调一次即端到端生效
    give: wrap((id, count = 1) => inv.addItem(id, count)),
    take: wrap((id, count = 1) => inv.removeItemById(id, count)),
    use: wrap((i) => { const sc = saveContext(); return inv.useItem(i, { player: sc && sc.player }); }),
    equip: wrap((i) => inv.equip(i)),
    unequip: wrap((i) => inv.unequip(i)),
    bag: () => inv.snapshotInventory(),
    eq: () => inv.snapshotEquipments(),
  };
  window.__SAVE = save;
  window.__INV = inv;
  window.__gameSave = api;
  if (opts.quiet !== true) {
    console.log('%c[save] 控制台入口已就绪', 'color:#0a0',
      '\n  __gameSave.info()        存档摘要',
      '\n  __gameSave.give(110000056, 5)  加道具',
      '\n  __gameSave.use(0)        使用/穿戴第 0 格',
      '\n  __gameSave.bag()         背包快照',
      '\n  __gameSave.eq()          装备快照',
      '\n  __gameSave.saveGame()    立即落盘（localStorage: ' + SAVE_KEY + '）');
  }
  return api;
}
