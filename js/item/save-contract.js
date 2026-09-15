// save-contract.js
// ★ 第一步：动态数据结构契约（存档契约）。本文件【只有结构定义与校验】，没有任何增减/存盘逻辑。
//
// 为什么单独一个文件？
//   契约是「红线」：背包格只准装 { id, count }，装备只准装 { slot, itemId }。
//   任何业务代码（inventory.js）都必须对这个结构读写，禁止把 name/desc/image 塞进来。
//   红线由 assertSaveShape / sanitizeSlot 强制检查，违反即抛错（见文件末尾 SAVE_STRICT）。
//
// 结构不是拍脑袋定的，每一条都有工程实证（详见 config/item_types.json 的 meta）：
//   · 背包格数 216       ← deobfuscated/panel/item/PlayerItemPanel.as  gridMax = 216（6 页 × 36）
//     （旧值 18 取自 ItemManager.MAX_EQUIP_ITEM，但该常量在反编译源码里**声明了却无任何引用**；
//      背包面板的 216 格网格才是真实容量，且 js/ui/panels.js 的 BAG_GRID_MAX 早已按 216 渲染分页）
//   · 装备位 19 个       ← bagId=0 实测（bagId=0 == GlobalsGlobal08.BAG_PLAYER_ATTR 装备栏）
//   · 装备位 index↔部位  ← bagId=0 的 index 0..18 与物品 type 逐位 1:1（含手镯×2/戒指×2/首饰×4）
//   · 槽位寻址 bagId|index ← ItemManager.getEquipByType(type, bagId=0, 18)
//   · 物品 id 为整数     ← config/items.json 主键（'110000056' 等，均 < 2^53，数值安全）

import { Config } from '../core/globals.js?v=20261007c';

// ───────────────────────── 契约版本 ─────────────────────────
// 结构一旦不兼容变更就 +1；save-store 读档时版本不符则丢弃旧档（不做隐式猜测迁移）。
//   例外：schema 升级【只伴随「可以无损迁移」的变更】时，save-store.loadGame 内显式补齐
//   （如 1→2 仅是把背包格数从 18 扩到 216，旧档右侧补 null 即可，绝不丢档）。
export const SAVE_SCHEMA = 2;

// ───────────────────────── 槽位常量（全部有实证，勿改）─────────────────────────
export const BAG_PLAYER_ATTR = 0;    // 装备栏     (GlobalsGlobal08.BAG_PLAYER_ATTR = 0)
export const BAG_PLAYER_BAG = 1;     // 主背包     (GlobalsGlobal08.BAG_PLAYERBAGITEM = 1)
export const SLOTS_PER_BAG = 216;    // 每包格数   (PlayerItemPanel.gridMax = 216 = 6 页 × 36)
export const EQUIP_SLOT_TOTAL = 19;  // 装备位总数 (bagId=0 实测 19 槽)
export const EQUIP_TYPE_MAX = 14;    // 装备类型码上限 (ItemManager.isEquipedItem: 0<=v<=14)

// 存档 localStorage 键。
// ★ 绝不能用 'tsqt.cfg.' 前缀：globals.js 的 CONFIG_OVERRIDE_SCHEMA 闸在 schema 不符时
//   会遍历删除所有 'tsqt.cfg.*' 键，存档会被连带清空。
export const SAVE_KEY = 'tsqt.save.player';

// ───────────────────────── 契约正文 ─────────────────────────
//
// interface InventorySlot {          // 背包格内容（null 表示空格）
//   id: number;                      // 物品模板 id（查 ITEM_CONFIG 得 name/desc/image —— 绝不存进来）
//   count: number;                   // 堆叠数量（>=1）
//   expireAt?: number;               // 限时物品的过期时间戳（F3②；拾取时由 item-effects.stampExpiry 打入，仅限时物品有）
// }
//
// interface EquipmentSlot {          // 装备位内容
//   slot: string;                    // 部位名（来自 config/item_types.json equipSlotNames，已确证）
//   itemId: number | null;           // 物品 id，null = 空位
// }
//
// interface PlayerSaveData {
//   schema: number;                  // 契约版本
//   name: string;
//   level: number;
//   hp: number;
//   maxHp: number;
//   inventory: (InventorySlot | null)[];   // 长度 = SLOTS_PER_BAG(216)，下标即格子索引
//   equipments: EquipmentSlot[];           // 长度 = EQUIP_SLOT_TOTAL(19)，下标 == bagId=0 的 index
// }
//
// 红线（assertSaveShape 强制）：inventory 元素只允许 { id, count } 两个键（限时物品额外允许 expireAt，见 ALLOWED_SLOT_EXTRA）；
//   equipments 元素只允许 { slot, itemId } 两个键。出现 name/desc/image/icon/stats 等一律抛错。

// 限时物品（F3②）在背包格上的实例字段：expireAt = 过期时间戳（毫秒）。非限时物品不带此键。
export const ALLOWED_SLOT_EXTRA = ['expireAt'];

// 禁止出现在背包格/装备位上的字段（防「随手把大对象 push 进背包」）// 禁止出现在背包格/装备位上的字段（防「随手把大对象 push 进背包」）
export const FORBIDDEN_SLOT_KEYS = [
  'name', 'desc', 'describe', 'image', 'imageDesc', 'icon', 'iconPath', 'path', 'url',
  'stats', 'effect', 'prop', 'price', 'linkName', 'item', 'config', 'data',
];

// ───────────────────────── 部位表（自 config/item_types.json 取，缺失时用内置兜底）──
// index -> 部位名。顺序即 bagId=0 的 0..18，重数与 AS3 一致（手镯×2 / 戒指×2 / 首饰×4）。
// 名称口径 = 物品 desc「绑定部位」（玩家在物品上看到的字），与 Lang 装备面板底图口径
// 仅 2 处不同（type3 衣服/上衣、type9 首饰/饰品）；另存于 item_types.json 的
// equipSlotNamesPanel。AS3 证据：VIEW_ARM_BG_* + ViewArm.as initGridPointArray。
const FALLBACK_EQUIP_ORDER = [
  '武器', '头饰', '项链', '衣服',
  '手镯', '手镯', '腰带',
  '戒指', '戒指', '裤子', '鞋子',
  '首饰', '首饰', '首饰', '首饰',
  '时装', '护肩', '披风', '翅膀',
];

/** 19 个装备位的部位名（下标 == bagId=0 的 index）。配置未加载时退回内置表。 */
export function equipSlotOrder() {
  const cfg = Config.item_types;
  const names = cfg && cfg.equipSlotNames;
  if (!names) return FALLBACK_EQUIP_ORDER.slice();
  // item_types.json 只给 type->部位名，重数按 equip[t].slots 展开
  const equip = (cfg && cfg.equip) || {};
  const out = [];
  for (let t = 0; t <= EQUIP_TYPE_MAX; t++) {
    const e = equip[String(t)];
    if (!e || !e.isEquip) continue;
    const n = Math.max(1, Number(e.slots) || 1);
    for (let i = 0; i < n; i++) out.push(e.zh);
  }
  return out.length === EQUIP_SLOT_TOTAL ? out : FALLBACK_EQUIP_ORDER.slice();
}

/** 部位名 -> 该部位的装备位下标列表（手镯/戒指/首饰 各有多个）。 */
export function equipIndicesBySlot() {
  const order = equipSlotOrder();
  const m = {};
  order.forEach((slot, i) => { (m[slot] = m[slot] || []).push(i); });
  return m;
}

/** 部位名是否合法（以已确证的部位表为准）。 */
export function isKnownSlot(slot) {
  return equipSlotOrder().indexOf(slot) >= 0;
}

// ───────────────────── 19 装备位的 UI 存储键（与既有 panels.js ARM_SLOTS[0..18] 对齐）─────────────────────
// 契约内部用「部位名」（item_types.json 的 equip[type].zh）；运行期 player.equip 用带序号
// 后缀的 UI 存储键，二者必须无损互转。顺序 == ARM_SLOTS[0..18] == bagId=0 的 index 0..18。
//
// ★ 命名规则（2026-09-17 依 Lang + desc 实证重定，旧名已证伪）：
//   规则：多槽位部位（手镯/戒指/首饰）一律带序号后缀；单槽位部位无后缀。
//   · 下标 1 = type1 = 头饰。旧名「护腕」已证伪 —— 依据三方一致：items.json 中 type1 的 144 条
//     desc 全写「绑定头饰」（灵宝无量冠/红玉头巾/兽皮小帽…）、lang[20242]=「头饰」、
//     AS3 常量 VIEW_ARM_BG_TIRE（TIARA，非“轮胎”）。
//   · 下标 4/5 = type4 = 手镯。依据：desc 写「手镯」（虎纹护腕 这件装备的类型声明就是手镯）、
//     lang[20245]=「手镯」、AS3 常量 VIEW_ARM_BG_BRACELET。
//   · 下标 11-14 = type9 = 首饰。主名取 desc 口径（30/30 条写「首饰」）；
//     面板底图口径为 lang[20250]=「饰品」，存 zhAliases。
//   · 下标 3 = type3 = 衣服。主名取 desc 口径（144/144 条写「衣服」）；
//     面板底图口径为 lang[20244]=「上衣」，存 zhAliases。
//   旧存档键名由 SLOT_KEY_ALIASES / migrateSlotKeys() 无损迁移。
export const ARM19_KEYS = [
  '武器', '头饰', '项链', '衣服',
  '手镯1', '手镯2', '腰带',
  '戒指1', '戒指2', '裤子', '鞋子',
  '首饰1', '首饰2', '首饰3', '首饰4',
  '时装', '护肩', '披风', '翅膀',
];

/** 19 装备位对应的物品 type（已确证；与 item_types.json 的 equipSlotIndexType 一致）。 */
export const ARM19_TYPE = [0, 1, 2, 3, 4, 4, 5, 6, 6, 7, 8, 9, 9, 9, 9, 10, 11, 12, 13];

/** 存储键 → 契约部位名（去序号后缀：手镯2→手镯，首饰1→首饰）。等价 equipSlotOrder()。 */
export const ARM19_LABEL = ARM19_KEYS.map((k) => k.replace(/\d+$/, ''));

/** 不属于装备栏 19 槽的 ARM_SLOTS 尾部键（法宝×6 / 如意）——独立系统，本契约不接管。 */
export const NON_BAG_ARM_KEYS = ['法宝1', '法宝2', '法宝3', '法宝4', '法宝5', '法宝6', '如意'];

// 旧键名 -> 新键名。源：config/item_types.json 的 equipSlotKeyAliases（生成器产出）。
// 覆盖本版之前的 UI 键（护腕/佩饰1-4/手镯/戒指）与曾被考虑过的面板口径名（上衣/饰品N）。
const FALLBACK_KEY_ALIASES = {
  '头盔': '头饰', '护腕': '头饰', '上衣': '衣服',
  '手镯': '手镯1', '戒指': '戒指1',
  '饰品1': '首饰1', '饰品2': '首饰2', '饰品3': '首饰3', '饰品4': '首饰4',
  '佩饰1': '首饰1', '佩饰2': '首饰2', '佩饰3': '首饰3', '佩饰4': '首饰4',
};

/** 旧 UI 存储键 -> 新 UI 存储键（已是新键则原样返回）。 */
export function SLOT_KEY_ALIASES() {
  const cfg = Config.item_types;
  return (cfg && cfg.equipSlotKeyAliases) || FALLBACK_KEY_ALIASES;
}

/** 规范化 UI 存储键：旧键名一律映射到当前键名。 */
export function normalizeSlotKey(key) {
  if (ARM19_KEYS.indexOf(key) >= 0) return key;
  const a = SLOT_KEY_ALIASES()[key];
  return a || key;
}

/** 迁移一份 player.equip 形态的字典（{旧键: itemId} -> {新键: itemId}）。原地返回新对象。 */
export function migrateSlotKeys(map) {
  const out = {};
  for (const k of Object.keys(map || {})) out[normalizeSlotKey(k)] = map[k];
  return out;
}

/** 旧「部位名」-> 规范部位名（用于迁移契约 equipments[].slot）。 */
export function normalizeSlotName(name) {
  const order = equipSlotOrder();
  if (order.indexOf(name) >= 0) return name;
  const cfg = Config.item_types;
  const a = (cfg && cfg.equipSlotNameAliases) || { '头盔': '头饰', '护腕': '头饰', '上衣': '衣服', '饰品': '首饰' };
  return a[name] || name;
}

/**
 * 迁移整份存档到当前命名：equipments[].slot 走 normalizeSlotName。
 * 只为「旧名 -> 新名」改名，不改结构、不改 schema 版本（故无需丢档）。
 */
export function migrateSave(save) {
  if (!save || !Array.isArray(save.equipments)) return save;
  for (const e of save.equipments) {
    if (e && typeof e.slot === 'string') e.slot = normalizeSlotName(e.slot);
  }
  return save;
}

/** UI 存储键 → 契约装备位下标；非装备栏键返回 -1。自动吃旧键名。 */
export function slotKeyToIndex(key) {
  return ARM19_KEYS.indexOf(normalizeSlotKey(key));
}

/** 契约装备位下标 → UI 存储键；越界返回 null。 */
export function indexToSlotKey(i) {
  return ARM19_KEYS[i] || null;
}

// ───────────────────────── 初始状态 ─────────────────────────
/**
 * 生成一个全新的纯净存档（不读 localStorage，不写 localStorage）。
 * @param {{name?:string,level?:number,hp?:number,maxHp?:number}} seed
 * @returns {object} PlayerSaveData
 */
export function createInitialSave(seed = {}) {
  const order = equipSlotOrder();
  return {
    schema: SAVE_SCHEMA,
    name: seed.name != null ? String(seed.name) : '测试角色',
    level: Number(seed.level) || 1,
    hp: Number(seed.hp) || 0,
    maxHp: Number(seed.maxHp) || 0,
    inventory: new Array(SLOTS_PER_BAG).fill(null),
    equipments: order.map((slot) => ({ slot, itemId: null })),
  };
}

/**
 * 由「既有玩家配置」派生初始存档：把 Config.player.equip（部位名 -> 物品id）
 * 落进契约的 equipments，使得接管后画面与接管前一致（不丢现有数据）。
 * 注意：Config.player.equip 的值在配置里是字符串（如 "1250100"），此处统一归一化为 number。
 */
export function seedSaveFromConfigPlayer() {
  const p = (Config.data && Config.data.player) || {};
  const save = createInitialSave({
    name: p.name, level: p.level, hp: p.hp, maxHp: p.maxHp,
  });
  const src = p.equip || {};
  const idx = equipIndicesBySlot();
  const used = {};   // 部位名 -> 已占用到第几个同部位槽
  for (const rawKey of Object.keys(src)) {
    const raw = src[rawKey];
    if (raw == null || raw === '') continue;
    // 先按 UI 存储键（含旧键名别名）定位；不中再按部位名定位；两者都不中 → 不猜，跳过
    let i = slotKeyToIndex(rawKey);
    if (i < 0) {
      const name = normalizeSlotName(rawKey);
      const list = idx[name];
      if (!list) continue;
      const k = used[name] = (used[name] || 0);
      i = list[Math.min(k, list.length - 1)];
      used[name] = k + 1;
    }
    if (save.equipments[i]) save.equipments[i].itemId = toItemId(raw);
  }
  // 背包：从 Config.player.bag 播种（[{itemId, count}] → inventory 槽，超容量不丢、报数）。
  //   用于「开局发一套测试装备」；老存档不受影响（仅无存档/schema 不符重新播种时走这里）。
  const bag = Array.isArray(p.bag) ? p.bag : [];
  let bi = 0, bagLost = 0;
  for (const s of bag) {
    const id = toItemId(s && s.itemId);
    const n = Math.trunc(Number(s && s.count) || 0);
    if (id == null || n <= 0) continue;
    if (bi >= SLOTS_PER_BAG) { bagLost++; continue; }
    save.inventory[bi++] = makeSlot(id, n);
  }
  if (bagLost) console.warn('[save] 播种背包超容量（' + SLOTS_PER_BAG + ' 格），丢弃 ' + bagLost + ' 件');
  return save;
}

// ───────────────────────── 归一化 / 红线校验 ─────────────────────────
/** 物品 id 归一化为整数（配置侧主键是字符串，存档侧一律整数）。 */
export function toItemId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 构造一个合法背包格（唯一的合法构造入口，防手写大对象）。expireAt 为限时物品实例字段，可省。 */
export function makeSlot(id, count, expireAt) {
  const s = { id: Math.trunc(Number(id)), count: Math.trunc(Number(count)) || 1 };
  if (Number.isFinite(Number(expireAt)) && Number(expireAt) > 0) s.expireAt = Math.trunc(Number(expireAt));
  return s;
}

/** 构造一个合法装备位。 */
export function makeEquipSlot(slot, itemId) {
  return { slot: String(slot), itemId: toItemId(itemId) };
}

// 严格模式：违反红线直接抛错（开发期暴露问题），关闭时只做静默裁剪。
export const SAVE_STRICT = true;

function warnOrThrow(msg) {
  if (SAVE_STRICT) throw new Error('[save-contract] ' + msg);
  console.warn('[save-contract] ' + msg);
}

/** 校验单个背包格：只准 { id, count }。返回 true / 抛错。 */
export function assertInventorySlot(slot, at = '?') {
  if (slot === null) return true;
  if (typeof slot !== 'object' || Array.isArray(slot)) {
    warnOrThrow(`inventory[${at}] 必须是 null 或 { id, count } 对象，实为 ${typeof slot}`);
  }
  const keys = Object.keys(slot);
  const bad = keys.filter((k) => FORBIDDEN_SLOT_KEYS.indexOf(k) >= 0);
  if (bad.length) {
    warnOrThrow(`inventory[${at}] 混入了禁存字段 ${JSON.stringify(bad)}（背包格只准有 id 与 count）`);
  }
  const extra = keys.filter((k) => k !== 'id' && k !== 'count' && ALLOWED_SLOT_EXTRA.indexOf(k) < 0);
  if (extra.length) {
    warnOrThrow(`inventory[${at}] 有契约外字段 ${JSON.stringify(extra)}（只准 id、count 与 ${ALLOWED_SLOT_EXTRA.join('/')}）`);
  }
  // expireAt 必须是正整数时间戳
  if ('expireAt' in slot && (!Number.isFinite(Number(slot.expireAt)) || Number(slot.expireAt) <= 0)) {
    warnOrThrow(`inventory[${at}].expireAt 必须是大于 0 的时间戳`);
  }
  if (!Number.isFinite(Number(slot.id))) warnOrThrow(`inventory[${at}].id 不是数字`);
  if (!Number.isFinite(Number(slot.count)) || Number(slot.count) < 1) {
    warnOrThrow(`inventory[${at}].count 必须 >= 1`);
  }
  return true;
}

/** 校验单个装备位：只准 { slot, itemId }，且 slot 必须是已确证部位名。 */
export function assertEquipSlot(eq, at = '?') {
  if (!eq || typeof eq !== 'object' || Array.isArray(eq)) {
    warnOrThrow(`equipments[${at}] 必须是 { slot, itemId } 对象`);
  }
  const keys = Object.keys(eq);
  const bad = keys.filter((k) => FORBIDDEN_SLOT_KEYS.indexOf(k) >= 0);
  if (bad.length) {
    warnOrThrow(`equipments[${at}] 混入了禁存字段 ${JSON.stringify(bad)}（装备位只准有 slot 与 itemId）`);
  }
  const extra = keys.filter((k) => k !== 'slot' && k !== 'itemId');
  if (extra.length) {
    warnOrThrow(`equipments[${at}] 有契约外字段 ${JSON.stringify(extra)}（只准 slot 与 itemId）`);
  }
  if (!isKnownSlot(eq.slot)) {
    // 不臆测未知部位：宁可报错也不静默接受
    warnOrThrow(`equipments[${at}].slot="${eq.slot}" 不在已确证部位表中`);
  }
  if (eq.itemId !== null && !Number.isFinite(Number(eq.itemId))) {
    warnOrThrow(`equipments[${at}].itemId 必须是数字或 null`);
  }
  return true;
}

/** 全校验：结构 + 长度 + 每个元素。供读档与调试调用。 */
export function assertSaveShape(save, at = 'save') {
  if (!save || typeof save !== 'object') warnOrThrow(`${at} 不是对象`);
  if (Number(save.schema) !== SAVE_SCHEMA) {
    warnOrThrow(`${at}.schema=${save.schema} 与当前契约版本 ${SAVE_SCHEMA} 不符`);
  }
  if (!Array.isArray(save.inventory)) warnOrThrow(`${at}.inventory 必须是数组`);
  if (save.inventory.length !== SLOTS_PER_BAG) {
    warnOrThrow(`${at}.inventory 长度应为 ${SLOTS_PER_BAG}，实为 ${save.inventory.length}`);
  }
  if (!Array.isArray(save.equipments)) warnOrThrow(`${at}.equipments 必须是数组`);
  if (save.equipments.length !== EQUIP_SLOT_TOTAL) {
    warnOrThrow(`${at}.equipments 长度应为 ${EQUIP_SLOT_TOTAL}，实为 ${save.equipments.length}`);
  }
  save.inventory.forEach((s, i) => assertInventorySlot(s, i));
  save.equipments.forEach((s, i) => assertEquipSlot(s, i));
  return true;
}

/**
 * ★ schema 1 → 2 迁移：背包格数 18 → 216（对齐 AS3 PlayerItemPanel.gridMax）。
 *   唯一差异就是 inventory 数组长度；旧档右侧补 null 即可，**不丢任何物品**。
 *   原地修改传入的「待校验对象」（显式迁移，不做隐式猜测）。
 *   @param {object} obj 从 localStorage / 完整档里解析出的原始对象（含 schema 字段）
 *   @returns {object} 原对象（迁移后）
 */
export function migrateBagSlotsV1(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Number(obj.schema) !== 1) return obj;
  obj.schema = 2;
  const inv = obj.inventory;
  if (Array.isArray(inv) && inv.length < SLOTS_PER_BAG) {
    obj.inventory = inv.concat(new Array(SLOTS_PER_BAG - inv.length).fill(null));
  }
  return obj;
}

/**
 * 深拷贝一份「纯数据」快照：只保留契约字段，多余字段一律剔除。
 * 序列化前调用可确保落盘的一定是干净结构（即便有代码绕过 makeSlot 手塞了对象）。
 */
export function toPlainSave(save) {
  return {
    schema: SAVE_SCHEMA,
    name: String(save.name == null ? '' : save.name),
    level: Math.trunc(Number(save.level) || 0),
    hp: Math.trunc(Number(save.hp) || 0),
    maxHp: Math.trunc(Number(save.maxHp) || 0),
    inventory: (save.inventory || []).map((s) => (s ? Object.assign(
      { id: Math.trunc(Number(s.id)), count: Math.trunc(Number(s.count)) },
      (Number(s.expireAt) > 0 ? { expireAt: Math.trunc(Number(s.expireAt)) } : {})) : null)),
    equipments: (save.equipments || []).map((e) => ({ slot: String(e.slot), itemId: toItemId(e.itemId) })),
  };
}
