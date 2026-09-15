// game-save.js — 完整存档（全量游戏状态）：手动存档点 + 备份槽 + 导入导出
//
// ★ 为什么需要这一层？
//   物品系统（js/item/*）与宠物系统（js/pet/*）各自已有独立的 localStorage 落盘，
//   但它们只覆盖「背包 / 装备 / 宠物实例」三样。角色等级·经验·金币·技能、任务进度、
//   当前地图与坐标、以及客户端状态（仓库/强化/队伍/战报/击杀数/设置）此前**完全没有落盘**，
//   刷新即回初始值。本模块把这些汇总成一份**完整档**，并提供玩家可见的存档/备份/导入导出入口。
//
// ★★ 三层落盘口径（本条是设计红线，务必先读懂再改）：
//
//   [实时档·自动]  tsqt.save.player  ← 物品/背包/装备（js/item/save-store.js）
//                  tsqt.save.pets    ← 宠物实例    （js/pet/pet-state.js）
//        · 每次增删/穿戴/宠物变更即时写，防崩溃丢进度；由各自模块自己维护，本模块不改变其职责。
//
//   [完整档·手动]  tsqt.save.full    ← 本模块的**存档点**（内嵌 player + pets + ext 三节）
//        · 只在「完整存档」/「导入」时写入 ⇒ 它是一份可回滚的时间点，不会被后续操作悄悄改掉。
//        · boot 时 **ext 节**（等级/经验/金币/技能/任务/坐标/客户端状态）从此处读取
//          —— 因为 ext 没有别的家；而 player/pets 节以实时档为准（实时档更新）。
//        · 因此刷新页面 = 实时档(物品/宠物最新) + 上次存档点的 ext；
//          想「全部回到存档点」请点面板里的「读取」。
//
//   [备份槽·手动]  tsqt.save.bak.1 / .2 / .3   ← 三个独立快照（各自带时间戳与摘要）
//                  tsqt.save.preimport        ← 导入 JSON 前的自动备份（防误覆盖）
//
// ★ 键名铁律：一律 'tsqt.save.*' 前缀，**绝不能用 'tsqt.cfg.'** ——
//   globals.js 的 CONFIG_OVERRIDE_SCHEMA 闸在版本不符时会遍历删除所有 'tsqt.cfg.*'，存档会被连带清空。
//
// ★ 只存「会变的数据」：静态表（物品名/怪物资质/任务名目标/技能定义）一律不存，用时查 Config.*。
//   任务只存 {id, progress, accepted, done}，name/desc/target/reward 在读取时由 Config.quests 重建。
//
// ★ 不臆造：任何字段都从运行期真实对象读取；缺字段就跳过，绝不编默认值塞进存档。

import { Config } from '../core/globals.js?v=20261007c';
import {
  createInitialSave, toPlainSave, assertSaveShape, migrateSave, migrateBagSlotsV1,
} from '../item/save-contract.js?v=20261007c';
import { saveGame } from '../item/save-store.js?v=20261007c';
import { booted, rebindSave } from '../item/player-bridge.js?v=20261007c';
import { petState, SAVE_SCHEMA as PET_SCHEMA } from '../pet/pet-state.js?v=20261007c';
import { applyPlayerAttrs } from '../char/char-gen.js?v=20261007c';   // ★ aw：读档后按公式重算玩家属性
import { Fighter } from '../entities/fighter.js?v=20261007c';   // 模型锚点开关：读档后按 ui._settings.showOrigin 恢复红十字显隐

// ───────────────────────── 契约 ─────────────────────────
export const SAVE_SCHEMA = 1;
export const SAVE_KIND = 'tsqt-full-save';
export const FULL_KEY = 'tsqt.save.full';
export const BACKUP_PREFIX = 'tsqt.save.bak.';
export const BACKUP_SLOTS = [1, 2, 3];
export const PREIMPORT_KEY = 'tsqt.save.preimport';

// 战报日志保留条数上限（客户端日志不是进度；不设上限会随战斗次数无限膨胀挤爆 localStorage 配额）
export const BATTLE_LOG_KEEP = 200;

// ext.player 的数值字段白名单。
// ★ 顺序有意义：最大值字段（maxHp/maxMp/rageMax）必须排在其当前值之前，
//   因为 Fighter 的 hp/mp setter 会按 max 夹取，反序会把当前值截成旧上限。
const EXT_PLAYER_NUM_KEYS = [
  'level', 'exp', 'expNext', 'silver', 'gold', 'bindGold', 'silverCopper', 'goldCopper',
  'maxHp', 'hp', 'maxMp', 'mp', 'rageMax', 'rage',
  'stamina', 'intellect', 'strength', 'agility', 'faith', 'potential', 'leftPoint',
  'atk', 'def', 'mag', 'magDef', 'spd',
  'phyHit', 'magHit', 'phyDodge', 'magDodge', 'phyCrit', 'magCrit',
  'crit', 'toughness', 'recover', 'xiuwei',
];
const EXT_PLAYER_STR_KEYS = ['name', 'charId', 'portrait', 'profession', 'prestige', 'job', 'guild'];

// ───────────────────────── 运行期上下文 ─────────────────────────
// ui / sm / player 由 ui.js 在 bindPlayer 时注入（scene.js 建好 MainScene 后 player 才有坐标）。
// 不 import scene.js（会造成 scene→ui→game-save→scene 循环），故一律走 setter 注入。
const _ctx = { ui: null, sm: null, player: null };

export function bindSaveContext(o = {}) {
  if (o.ui !== undefined) _ctx.ui = o.ui;
  if (o.sm !== undefined) _ctx.sm = o.sm;
  if (o.player !== undefined) _ctx.player = o.player;
  return _ctx;
}

export function saveContext() { return _ctx; }

// ───────────────────────── 小工具 ─────────────────────────
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const int = (v, d = 0) => Math.trunc(num(v, d));
const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function readKey(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function writeKey(k, s) {
  try { localStorage.setItem(k, s); return true; }
  catch (e) { console.warn('[save] 写入失败 ' + k + '：' + (e && e.message)); return false; }
}
function removeKey(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

/** 毫秒 → 'YYYY-MM-DD HH:MM:SS'（与 locale 无关，存档内自描述）。 */
export function fmtTime(ms) {
  const d = new Date(num(ms));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 当前构建戳的版本号部分（BUILD_STAMP 形如 '2026-09-17ag · 说明…'）。 */
function buildStamp() {
  try {
    const s = typeof window !== 'undefined' ? window.__TS_BUILD : '';
    return s ? String(s).split('·')[0].trim() : '';
  } catch (e) { return ''; }
}

// ───────────────────────── 采集 ─────────────────────────
/** 物品/装备节：直接取契约的纯净快照（唯一真源，不重复造结构）。 */
function collectPlayerNode() {
  const boot = booted();
  if (boot && boot.save) return toPlainSave(boot.save);
  return toPlainSave(createInitialSave({}));
}

/** 宠物节：直接取实例层的纯净快照。 */
function collectPetsNode() {
  try { return petState().toPlain(); } catch (e) { return { schema: PET_SCHEMA, activeUid: null, pets: [] }; }
}

/** 主城场景实例（坐标/地图的唯一来源）。战斗中 sm._main 即被冻结的主城实例。 */
function mainScene() {
  const sm = _ctx.sm;
  if (!sm) return null;
  const cand = sm._main || sm.current;
  return (cand && typeof cand.changeMap === 'function') ? cand : null;
}

/** ext 节：契约之外的「会变的数据」——角色数值/技能、世界坐标、任务进度、客户端状态。 */
export function collectExt() {
  const ui = _ctx.ui;
  const p = _ctx.player || (ui && ui.player) || null;
  const sm = _ctx.sm;
  const ext = { v: 1, player: null, world: null, quests: [], client: null };

  // ① 角色（★ 排除 bag/equip/equipments —— 它们归 player 节，重复存会分叉）
  if (p) {
    const pl = {};
    for (const k of EXT_PLAYER_STR_KEYS) if (p[k] != null && p[k] !== '') pl[k] = p[k];
    for (const k of EXT_PLAYER_NUM_KEYS) if (k in p) pl[k] = int(p[k]);
    pl.skills = Array.isArray(p.skills) ? p.skills.slice() : [];
    pl.skillLevels = (p.skillLevels && typeof p.skillLevels === 'object') ? copy(p.skillLevels) : {};
    ext.player = pl;
  }

  // ② 世界（当前地图 + 角色落点；刷新后回到这里）
  const main = mainScene();
  if (main && main.map) {
    const fig = main.player || null;
    ext.world = {
      mapId: int(main.map.id),
      mapName: String(main.map.name || ''),
      x: num(fig && fig.x),
      y: num(fig && fig.y),
      dir: (fig && fig.dir) || 'right',
    };
  }

  // ③ 任务：只存「会变的三项」+ id；名称/描述/目标/奖励是静态表，读取时由 Config.quests 重建
  if (sm && Array.isArray(sm.questState)) {
    ext.quests = sm.questState.map((q) => ({
      id: String(q.id), progress: int(q.progress), accepted: !!q.accepted, done: !!q.done,
    }));
  }

  // ④ 客户端状态
  if (ui) {
    ext.client = {
      warehouse: (ui._warehouse || []).map((s) => ({ itemId: int(s.itemId), count: int(s.count) })),
      enhance: copy(ui._enhance || {}),
      team: copy(ui._team || []),
      // 战报日志只留最近 N 条（见 BATTLE_LOG_KEEP）
      battleLog: (ui._battleLog || []).slice(-BATTLE_LOG_KEEP).map((r) => copy(r)),
      killCount: int(ui._killCount),
      curMapId: int(ui._curMapId, ext.world ? ext.world.mapId : 1),
      settings: copy(ui._settings || {}),
      defeated: (sm && sm.defeated && typeof sm.defeated.forEach === 'function')
        ? Array.from(sm.defeated).map((x) => String(x)) : [],
    };
  }
  return ext;
}

/** 摘要（面板列表用；冗余存一份，便于不解析整档即可展示）。 */
function collectMeta(ext, playerNode, petsNode) {
  const bag = (playerNode.inventory || []).filter(Boolean);
  const eq = (playerNode.equipments || []).filter((e) => e && e.itemId != null);
  const pets = (petsNode.pets || []);
  const qs = ext.quests || [];
  return {
    name: playerNode.name || '',
    level: int(playerNode.level),
    hp: int(playerNode.hp), maxHp: int(playerNode.maxHp),
    silver: ext.player ? int(ext.player.silver) : 0,
    gold: ext.player ? int(ext.player.gold) : 0,
    mapId: ext.world ? ext.world.mapId : null,
    mapName: ext.world ? ext.world.mapName : '',
    bagSlots: bag.length,
    bagCount: bag.reduce((a, s) => a + int(s.count), 0),
    equipCount: eq.length,
    petCount: pets.length,
    petDeployed: pets.filter((x) => int(x.state) === 1).length,
    questAccepted: qs.filter((q) => q.accepted).length,
    questDone: qs.filter((q) => q.done).length,
    kills: ext.client ? int(ext.client.killCount) : 0,
    skills: ext.player ? (ext.player.skills || []).length : 0,
  };
}

/** 采集整份完整档（不落盘，纯函数）。 */
export function snapshotAll() {
  const playerNode = collectPlayerNode();
  const petsNode = collectPetsNode();
  const ext = collectExt();
  const at = Date.now();
  return {
    schema: SAVE_SCHEMA,
    kind: SAVE_KIND,
    at,
    atText: fmtTime(at),
    build: buildStamp(),
    meta: collectMeta(ext, playerNode, petsNode),
    player: playerNode,
    pets: petsNode,
    ext,
  };
}

/** 实时进度摘要（面板顶部展示用；与存档点对比，不落盘）。 */
export function liveMeta() {
  const ext = collectExt();
  return collectMeta(ext, collectPlayerNode(), collectPetsNode());
}

// ───────────────────────── 落盘 / 读取 ─────────────────────────
/** 写一份文档到指定键。 */
export function writeDoc(doc, key = FULL_KEY) {
  if (!doc || typeof doc !== 'object') return { ok: false, bytes: 0, error: 'no-doc' };
  const s = JSON.stringify(doc);
  return { ok: writeKey(key, s), bytes: s.length };
}

/** 读一份文档（校验 kind/schema/必需节）。 */
export function readDoc(key = FULL_KEY) {
  const raw = readKey(key);
  if (raw == null) return { ok: false, reason: 'no-save', key, bytes: 0 };
  const d = tryParse(raw);
  if (!d || typeof d !== 'object') return { ok: false, reason: 'bad-json', key, bytes: raw.length };
  if (d.kind !== SAVE_KIND) return { ok: false, reason: 'not-full-save', key, kind: d.kind, bytes: raw.length };
  if (Number(d.schema) !== SAVE_SCHEMA) {
    return { ok: false, reason: 'schema-mismatch', key, found: d.schema, expect: SAVE_SCHEMA, bytes: raw.length };
  }
  if (!d.player || !d.pets) return { ok: false, reason: 'shape-violation', key, bytes: raw.length };
  return { ok: true, doc: d, key, bytes: raw.length };
}

/** 删一份文档（返回是否真的存在过）。 */
export function dropDoc(key) {
  const had = readKey(key) != null;
  removeKey(key);
  return { ok: true, existed: had };
}

/**
 * ★「立即完整存档」：采集全量 → 写 tsqt.save.full。
 * 顺带把实时档也重写一次，保证三份口径在这一刻完全一致。
 * @returns {{ok:boolean, at?:number, atText?:string, bytes?:number, meta?:object, error?:string}}
 */
export function saveFull() {
  const doc = snapshotAll();
  const r = writeDoc(doc, FULL_KEY);
  if (!r.ok) return { ok: false, error: 'quota-or-denied' };
  try { const b = booted(); if (b && b.save) saveGame(b.save); } catch (e) { /* 实时档失败不影响存档点 */ }
  try { petState().save(); } catch (e) { /* 同上 */ }
  return { ok: true, at: doc.at, atText: doc.atText, bytes: r.bytes, meta: doc.meta };
}

/** 当前存档点信息（面板用）。 */
export function fullInfo() {
  const r = readDoc(FULL_KEY);
  if (!r.ok) return { exists: false, key: FULL_KEY, reason: r.reason, bytes: r.bytes || 0 };
  return {
    exists: true, key: FULL_KEY, bytes: r.bytes,
    at: r.doc.at, atText: r.doc.atText, build: r.doc.build, meta: r.doc.meta,
  };
}

// ───────────────────────── 备份槽 ─────────────────────────
/** 三个备份槽的状态列表。 */
export function listSlots() {
  return BACKUP_SLOTS.map((n) => {
    const key = BACKUP_PREFIX + n;
    const r = readDoc(key);
    if (!r.ok) return { slot: n, key, exists: false, reason: r.reason, bytes: r.bytes || 0 };
    return {
      slot: n, key, exists: true, bytes: r.bytes,
      at: r.doc.at, atText: r.doc.atText, build: r.doc.build, meta: r.doc.meta,
    };
  });
}

/** 把**当前进度**存进备份槽（独立快照，与当前存档点解耦）。 */
export function saveToSlot(n) {
  if (BACKUP_SLOTS.indexOf(Number(n)) < 0) return { ok: false, error: 'bad-slot' };
  const doc = snapshotAll();
  const r = writeDoc(doc, BACKUP_PREFIX + Number(n));
  if (!r.ok) return { ok: false, error: 'quota-or-denied' };
  return { ok: true, slot: Number(n), at: doc.at, atText: doc.atText, bytes: r.bytes, meta: doc.meta };
}

export function clearSlot(n) {
  if (BACKUP_SLOTS.indexOf(Number(n)) < 0) return { ok: false, error: 'bad-slot' };
  return dropDoc(BACKUP_PREFIX + Number(n));
}

/** 删除当前存档点。 */
export function dropFull() { return dropDoc(FULL_KEY); }

/** 导入前的自动备份信息。 */
export function preimportInfo() {
  const r = readDoc(PREIMPORT_KEY);
  if (!r.ok) return { exists: false, key: PREIMPORT_KEY, reason: r.reason, bytes: r.bytes || 0 };
  return { exists: true, key: PREIMPORT_KEY, bytes: r.bytes, at: r.doc.at, atText: r.doc.atText, meta: r.doc.meta };
}

// ───────────────────────── 应用（读档 / 回滚 / 导入）─────────────────────────
/** 把存档的 player 节变成一份合法契约档（读档前先做旧部位名迁移，避免旧档被判非法）。 */
function adoptPlayerNode(node) {
  const n = copy(node);
  try { migrateSave(n); } catch (e) { /* 迁移失败交给下面 assert 报错 */ }
  // ★ 旧完整档的 player 节可能是 schema 1（18 格背包）→ 补零到 216 格，不丢档
  try { migrateBagSlotsV1(n); } catch (e) { /* 迁移失败交给下面 assert 报错 */ }
  assertSaveShape(n, 'fullSave.player');       // 借用物品系统的红线校验（schema/长度/元素）
  const save = createInitialSave({ name: n.name, level: n.level, hp: n.hp, maxHp: n.maxHp });
  save.inventory = n.inventory.map((s) => (s ? { id: int(s.id), count: int(s.count) } : null));
  save.equipments = n.equipments.map((e) => ({
    slot: String(e.slot), itemId: e.itemId == null ? null : int(e.itemId),
  }));
  return save;
}

/** ext → 运行期对象。 */
function applyExt(ext) {
  if (!ext) return;
  const ui = _ctx.ui;
  const sm = _ctx.sm;
  const p = _ctx.player || (ui && ui.player) || null;

  // ① 角色数值（按白名单顺序：max 先于当前）
  const pl = ext.player;
  if (p && pl) {
    for (const k of EXT_PLAYER_STR_KEYS) if (pl[k] != null && pl[k] !== '') p[k] = pl[k];
    for (const k of EXT_PLAYER_NUM_KEYS) if (k in pl) p[k] = int(pl[k]);
    // ★ 银子改名兼容：旧档里的 gold 一并迁移到 silver（单一货币，只此一次）
    if (!('silver' in pl) && ('gold' in pl)) p.silver = int(pl.gold);
    // ★ aw：属性公式驱动 ⇒ 存档里的 hp/atk/五维 都是旧值，读到也没意义。
    //   只信任 level/exp/silver/装备/技能，其余按当前等级重算，hp/mp 钳到新上限内。
    let rederived = false;
    try { rederived = applyPlayerAttrs(p); } catch (e) { console.warn('[save] 读档重算属性失败：', e); }
    if (rederived) {
      if (p.hp == null || p.hp > p.maxHp) p.hp = p.maxHp;
      if (p.mp == null || p.mp > p.maxMp) p.mp = p.maxMp;
    }
    if (Array.isArray(pl.skills)) p.skills = pl.skills.slice();
    if (pl.skillLevels && typeof pl.skillLevels === 'object') p.skillLevels = copy(pl.skillLevels);
    // ★ 技能补齐：config/player.json 是技能真源（用户「清技能再补回全部」的口径），
    //   存档只记录「曾学到几级」。此处以 config.skills 为准补齐存档缺失的技能，
    //   已有的等级保留（不回退、不臆造升级），保证老存档也能拿到全部技能。
    const cfgSkills = (Config && Config.skills) || null;
    if (cfgSkills && Array.isArray(p.skills)) {
      const have = new Set(p.skills.map(x => String(x)));
      let added = 0;
      for (const id of Object.keys(cfgSkills)) {
        if (!have.has(id)) { p.skills.push(id); added++; }
        if (p.skillLevels && p.skillLevels[id] == null) p.skillLevels[id] = 1;
      }
      if (added) console.log('[save] 技能补齐：从存档 ' + (p.skills.length - added) + ' 个补到 ' + p.skills.length + ' 个（config 真源）');
    }
    if (ui && ui.refresh) ui.refresh();     // HUD 的 名字/等级/HP/MP/怒气/EXP 立即跟随
  }

  // ② 任务进度（静态字段由 Config.quests 重建，不进存档）
  if (sm && Array.isArray(sm.questState) && Array.isArray(ext.quests)) {
    const byId = {};
    ext.quests.forEach((q) => { byId[String(q.id)] = q; });
    sm.questState.forEach((q) => {
      const s = byId[String(q.id)];
      if (!s) return;                        // 存档里没有的任务保持原状，不猜
      q.progress = int(s.progress);
      q.accepted = !!s.accepted;
      q.done = !!s.done;
    });
    if (ui && ui.setQuestState) ui.setQuestState(sm.questState);
  }

  // ③ 客户端状态
  const c = ext.client;
  if (ui && c) {
    ui._warehouse = (c.warehouse || []).map((s) => ({ itemId: int(s.itemId), count: int(s.count) }));
    ui._enhance = copy(c.enhance || {});
    if (p) p.enhance = ui._enhance;          // 强化层与战斗 Fighter 共用同一对象
    ui._team = copy(c.team || []);
    ui._battleLog = copy(c.battleLog || []);
    ui._killCount = int(c.killCount);
    ui._settings = Object.assign({}, ui._settings || {}, c.settings || {});
    // 模型锚点（红十字）：按存档设置恢复显隐。★ URL ?origin=1 为调试强制开启，优先级高于存档。
    //   setShowOrigin 幂等：boot 时此处在 enterMain 之前（尚无 Fighter 实例，只写静态开关，
    //   后续 initDisplay 读它）；面板「读取」时已在场，直接刷新全部实例的 originEl。
    const _urlOrigin = (typeof location !== 'undefined') && /[?&]origin=1/.test(location.search);
    try { Fighter.setShowOrigin(_urlOrigin || !!ui._settings.showOrigin); } catch (e) { /* 忽略：不阻断读档 */ }
    if (sm && Array.isArray(c.defeated)) sm.defeated = new Set(c.defeated.map((x) => String(x)));
  }
}

/** 世界 → 场景（跳图 + 落位）。 */
function restoreWorld(world, opts) {
  const sm = _ctx.sm;
  if (!sm || !world || !world.mapId) return 'no-world';
  if (typeof sm.enterMain !== 'function') return 'no-enterMain';
  sm.enterMain();                            // 战斗中会回到被冻结的主城实例
  const main = mainScene();
  if (!main) return 'no-main';
  const want = int(world.mapId);
  if (main.map && int(main.map.id) !== want && typeof main.changeMap === 'function') {
    main.changeMap(want);                    // changeMap 会把玩家放到新图出生点
  }
  const fig = main.player;
  if (fig && typeof fig.setPos === 'function') {
    fig.setPos(num(world.x), num(world.y));  // 再覆盖成存档落点
    fig.path = [];
    if (world.dir) fig.dir = world.dir;
    if (typeof fig.stand === 'function') fig.stand();
    if (typeof main._centerCameraOn === 'function') main._centerCameraOn(num(world.x), num(world.y));
  }
  if (sm.ui) sm.ui._curMapId = want;
  return opts && opts.quiet ? 'ok' : 'ok';
}

/**
 * ★ 应用一份完整档：物品/装备 → 宠物 → ext → 世界。
 * 各步独立 try/catch：某一节失败不影响其余节（绝不整档卡死）。
 * @returns {{ok:boolean, steps:string[], error?:string}}
 */
export function applyDoc(doc, opts = {}) {
  if (!doc || typeof doc !== 'object') return { ok: false, steps: [], error: 'no-doc' };
  if (doc.kind !== SAVE_KIND || Number(doc.schema) !== SAVE_SCHEMA) {
    return { ok: false, steps: [], error: 'not-full-save' };
  }
  if (!doc.player || !doc.pets) return { ok: false, steps: [], error: 'shape-violation' };
  const ui = _ctx.ui;
  const out = { ok: true, steps: [] };

  // ① 物品 / 装备：契约档 → 落盘 → 换绑管理器 → 投影到 player
  try {
    const save = adoptPlayerNode(doc.player);
    const w = saveGame(save);
    rebindSave(save, ui && ui.player ? ui.player : null);
    out.steps.push('items:' + (w.ok ? 'ok' : 'fail') + '(' + (w.bytes || 0) + 'B)');
    if (!w.ok) { out.ok = false; out.error = 'player:' + w.error; }
  } catch (e) {
    out.ok = false; out.error = 'player: ' + (e && e.message);
    out.steps.push('items:fail');
  }

  // ② 宠物：整体替换实例层 → 落盘 → 重新指向 ui._pets
  try {
    const ok = petState().loadFromSave(doc.pets);
    if (ui) {
      ui._pets = petState().list;            // ★ 必须重新指向新数组（旧引用会被整体替换掉）
      if (ui.refreshActivePet) ui.refreshActivePet();
      ui._petSeq = ui._pets.length;
    }
    out.steps.push('pets:' + (ok ? 'ok' : 'fail'));
    if (!ok) { out.ok = false; out.error = (out.error || '') + ' pets:fail'; }
  } catch (e) {
    out.ok = false; out.error = (out.error || '') + ' pets: ' + (e && e.message);
    out.steps.push('pets:fail');
  }

  // ③ ext
  try { applyExt(doc.ext); out.steps.push('ext:ok'); }
  catch (e) { out.ok = false; out.error = (out.error || '') + ' ext: ' + (e && e.message); out.steps.push('ext:fail'); }

  // ④ 世界
  try { out.steps.push('world:' + restoreWorld(doc.ext && doc.ext.world, opts)); }
  catch (e) { out.steps.push('world:fail(' + (e && e.message) + ')'); }

  return out;
}

/** 从备份槽回滚。 */
export function restoreSlot(n, opts = {}) {
  if (BACKUP_SLOTS.indexOf(Number(n)) < 0) return { ok: false, steps: [], error: 'bad-slot' };
  const r = readDoc(BACKUP_PREFIX + Number(n));
  if (!r.ok) return { ok: false, steps: [], error: r.reason };
  return applyDoc(r.doc, opts);
}

/** 读取当前存档点（覆盖运行期状态）。 */
export function loadFull(opts = {}) {
  const r = readDoc(FULL_KEY);
  if (!r.ok) return { ok: false, steps: [], error: r.reason };
  return applyDoc(r.doc, opts);
}

/** 回到「导入前」自动备份。 */
export function restorePreimport(opts = {}) {
  const r = readDoc(PREIMPORT_KEY);
  if (!r.ok) return { ok: false, steps: [], error: r.reason };
  return applyDoc(r.doc, opts);
}

/** 删除「导入前」自动备份。 */
export function dropPreimport() { return dropDoc(PREIMPORT_KEY); }

// ───────────────────────── boot 恢复（两段式）─────────────────────────
/**
 * ★ boot 第一段：在**进主城之前**恢复 ext（等级/经验/金币/技能/任务进度/客户端状态）。
 * 顺带把 Config.currentMapId 设为存档地图 —— MainScene 构造时读它，
 * 这样主城直接建在正确地图上，省掉"落地后再 changeMap 重建一次"。
 * @returns {{ok:boolean, at?:number, atText?:string, world?:object, reason?:string, error?:string}}
 */
export function restoreExtOnBoot() {
  const r = readDoc(FULL_KEY);
  if (!r.ok) return { ok: false, reason: r.reason };
  const ext = r.doc.ext;
  if (!ext) return { ok: false, reason: 'no-ext' };
  try { applyExt(ext); } catch (e) { return { ok: false, error: (e && e.message) || 'apply-ext-failed' }; }
  const world = ext.world || null;
  if (world && world.mapId) {
    const maps = (Config && Config.maps) || [];
    if (maps.some((m) => int(m.id) === int(world.mapId))) Config.currentMapId = int(world.mapId);
  }
  return { ok: true, at: r.doc.at, atText: r.doc.atText, world };
}

/** ★ boot 第二段：在**enterMain 之后**落位（那时才有场景实例可 setPos）。 */
export function applyWorldOnBoot(world) {
  if (!world || !world.mapId) return { ok: false, reason: 'no-world' };
  try { return { ok: true, step: restoreWorld(world) }; }
  catch (e) { return { ok: false, error: (e && e.message) || 'restore-world-failed' }; }
}

// ───────────────────────── 导出 / 导入 ─────────────────────────
function exportName(doc) {
  const t = String(doc.atText || '').replace(/[-: ]/g, '');
  return 'tsqt-save-' + (t || Date.now()) + '.json';
}

/** 导出为 .json 文件（浏览器下载）。doc 省略时导出当前存档点。 */
export function exportFile(doc) {
  let d = doc;
  if (!d) {
    const r = readDoc(FULL_KEY);
    if (!r.ok) return { ok: false, error: 'no-save-point' };
    d = r.doc;
  }
  try {
    const text = JSON.stringify(d, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName(d);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); if (a.parentNode) a.remove(); }, 0);
    return { ok: true, file: a.download, bytes: text.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'export-failed' };
  }
}

/**
 * 导入一份 .json 文本。
 * 流程：校验 → 把**当前进度**存进 preimport 自动备份 → 写成本档 → 应用到运行期。
 * @returns {{ok:boolean, error?:string, steps?:string[], meta?:object}}
 */
export function importText(text, opts = {}) {
  const d = tryParse(text);
  if (!d || typeof d !== 'object') return { ok: false, error: 'bad-json' };
  if (d.kind !== SAVE_KIND) return { ok: false, error: 'not-full-save', kind: d.kind };
  if (Number(d.schema) !== SAVE_SCHEMA) return { ok: false, error: 'schema-mismatch', found: d.schema };
  if (!d.player || !d.pets) return { ok: false, error: 'shape-violation' };

  // 导入前的自动备份：把玩家此刻的进度留一份，误覆盖可一键回滚
  if (opts.backup !== false) {
    try { writeDoc(snapshotAll(), PREIMPORT_KEY); } catch (e) { /* 备份失败不阻断导入 */ }
  }
  const w = writeDoc(d, FULL_KEY);            // 导入档即成为当前存档点
  const ap = applyDoc(d, opts);
  return {
    ok: ap.ok, steps: ap.steps, error: ap.error,
    bytes: w.bytes, at: d.at, atText: d.atText, meta: d.meta,
  };
}

/** 读取一个 File 对象（<input type=file>）并导入。 */
export function importFile(file, opts = {}) {
  return new Promise((resolve) => {
    if (!file || typeof FileReader === 'undefined') { resolve({ ok: false, error: 'no-file' }); return; }
    const fr = new FileReader();
    fr.onload = () => resolve(importText(String(fr.result || ''), opts));
    fr.onerror = () => resolve({ ok: false, error: 'read-failed' });
    fr.readAsText(file);
  });
}

// ───────────────────────── 控制台 / 探针出口 ─────────────────────────
/** 把本模块的真实实例 API 暴露到 window（探针用；避免二次 import 拿到空 Config —— 项目铁律）。 */
export function installSaveApi() {
  if (typeof window === 'undefined') return null;
  const api = {
    SAVE_SCHEMA, SAVE_KIND, FULL_KEY, BACKUP_PREFIX, BACKUP_SLOTS, PREIMPORT_KEY,
    snapshotAll, liveMeta, saveFull, fullInfo, loadFull, applyDoc, dropFull,
    listSlots, saveToSlot, clearSlot, restoreSlot,
    preimportInfo, restorePreimport, dropPreimport,
    exportFile, importText, importFile, readDoc, writeDoc, dropDoc, fmtTime,
    bindSaveContext, saveContext, collectExt, restoreExtOnBoot, applyWorldOnBoot,
  };
  window.__GAMESAVE = api;
  return api;
}
