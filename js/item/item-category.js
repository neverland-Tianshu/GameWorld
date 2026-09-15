// item-category.js
// 物品六大类（CategoryType）+ 二级明细（SubType）的运行时 API。
//
// 数据源：config/item_categories.json（由 globals.loadConfig 加载到 Config.item_categories）。
//   分类按物品 type 数字码（config/item_types.json 的语义码）映射；
//   items.json 与 item_types.json 一律不动（type 是逆向产物）。
//
// 匹配规则（见配置 _meta.rules）：
//   1. overrides 优先（逐件例外，如宠物内丹从 type23 按名字挑出归穿戴装备类）；
//   2. 按 categories 顺序找 type 命中的大类，再在其 subTypes 里按顺序匹配
//      （配了 match 的要求 name/desc 正则命中；未配 match 的是该类型的兜底桶）；
//   3. 都没命中 → { cat: 'other' }，背包仅在该类有物品时显示「未分类」签。
//
// 缓存：按配置对象身份缓存编译结果；配置运行期被编辑器替换（identity 变化）时自动重建。

import { Config } from '../core/globals.js?v=20261007c';

const OTHER = 'other';

let _cfgId;               // 上次构建时的配置对象引用（identity 变化即重建；undefined=未构建过）
let _overrideRx = null;   // 编译后的 overrides：[{ types:Set, nameRx, descRx, cat, sub }]
let _cats = null;         // 编译后的 categories：[{ key, id, name, short, types:Set, subTypes:[{key,name,short,types:Set,nameRx,descRx}] }]

function compile() {
  const cfg = Config.item_categories || null;
  if (cfg === _cfgId) return;
  _cfgId = cfg;
  if (!cfg) { _overrideRx = null; _cats = null; return; }

  _overrideRx = (cfg.overrides || []).map(ov => ({
    types: new Set((ov.types || (ov.type != null ? [ov.type] : [])).map(Number)),
    nameRx: ov.match && ov.match.name ? new RegExp(ov.match.name) : null,
    descRx: ov.match && ov.match.desc ? new RegExp(ov.match.desc) : null,
    cat: ov.category, sub: ov.subType,
  }));

  _cats = (cfg.categories || []).map(c => ({
    key: c.key, id: c.id, name: c.name, short: c.short || c.name,
    types: new Set((c.types || []).map(Number)),
    subTypes: (c.subTypes || []).map(s => ({
      key: s.key, name: s.name, short: s.short || s.name,
      types: new Set((s.types || []).map(Number)),
      nameRx: s.match && s.match.name ? new RegExp(s.match.name) : null,
      descRx: s.match && s.match.desc ? new RegExp(s.match.desc) : null,
    })),
  }));
}

/**
 * 单件物品分类。
 * @param {object} def Config.items[id] 物品定义（含 type/name/desc）
 * @returns {{cat:string, sub:string|null}|null} cat=大类 key（'other'=未归类），sub=子类 key
 */
export function classifyItem(def) {
  if (!def) return null;
  compile();
  const t = Number(def.type);
  if (!Number.isFinite(t)) return { cat: OTHER, sub: null };

  // ① overrides（逐件例外）
  for (const ov of _overrideRx || []) {
    if (!ov.types.has(t)) continue;
    if (ov.nameRx && !ov.nameRx.test(def.name || '')) continue;
    if (ov.descRx && !ov.descRx.test(def.desc || '')) continue;
    return { cat: ov.cat, sub: ov.sub };
  }

  // ② categories
  for (const c of _cats || []) {
    if (!c.types.has(t)) continue;
    for (const s of c.subTypes) {
      if (!s.types.has(t)) continue;
      if (s.nameRx && !s.nameRx.test(def.name || '')) continue;
      if (s.descRx && !s.descRx.test(def.desc || '')) continue;
      return { cat: c.key, sub: s.key };
    }
    // type 在大类内但无子类命中（所有子类都配了 match 却没命中）：归大类、子类空
    return { cat: c.key, sub: null };
  }
  return { cat: OTHER, sub: null };
}

/** 是否已启用分类配置（未加载时一切回退旧逻辑）。 */
export function categoriesReady() { compile(); return !!(_cats && _cats.length); }

/**
 * 背包分类视图：各大类（含「未分类」，仅在有物品时出现）+ 其下子类的物品计数。
 * @param {Array} bag player.bag（[{itemId,count}] 稀疏槽位）
 * @returns {Array<{key,id,name,short,count,subs:[{key,name,short,count}]}>}
 */
export function listCategories(bag) {
  compile();
  const map = Config.items || {};
  const out = (_cats || []).map(c => ({ key: c.key, id: c.id, name: c.name, short: c.short, count: 0, subs: c.subTypes.map(s => ({ key: s.key, name: s.name, short: s.short, count: 0 })) }));
  const other = { key: OTHER, id: 0, name: '未分类', short: '未分类', count: 0, subs: [] };
  const subOf = {};   // 'catKey:subKey' → subs 数组引用
  out.forEach(c => c.subs.forEach(s => { subOf[c.key + ':' + s.key] = s; }));

  (bag || []).forEach(s => {
    if (!s) return;
    const def = map[s.itemId];
    if (!def) return;
    const cl = classifyItem(def);
    const c = cl && cl.cat !== OTHER ? out.find(x => x.key === cl.cat) : other;
    if (!c) return;
    c.count += 1;
    if (cl.sub != null) {
      const sref = subOf[c.key + ':' + cl.sub];
      if (sref) sref.count += 1;
    }
  });

  return out.filter(c => c.count > 0).concat(other.count > 0 ? [other] : []);
}

/**
 * 背包中属于某大类（可缩到子类）的物品列表。
 * @param {Array} bag player.bag
 * @param {string} catKey 大类 key（'other' 亦可用）
 * @param {string|null} subKey 子类 key；null=该大类全部
 * @returns {Array<{slot,def,gi}>}
 */
export function bagItemsIn(bag, catKey, subKey) {
  if (!catKey) return [];
  const map = Config.items || {};
  const out = [];
  (bag || []).forEach((s, i) => {
    if (!s) return;
    const def = map[s.itemId];
    if (!def) return;
    const cl = classifyItem(def);
    if (!cl || cl.cat !== catKey) return;
    if (subKey != null && cl.sub !== subKey) return;
    out.push({ slot: s, def, gi: i });
  });
  return out;
}

/** 大类名（key → name；未知返回 key）。 */
export function categoryName(key) {
  compile();
  const c = (_cats || []).find(x => x.key === key);
  return c ? c.name : (key === OTHER ? '未分类' : key);
}

/** 子类名（catKey/subKey → name；未知返回 null）。 */
export function subName(catKey, subKey) {
  compile();
  const c = (_cats || []).find(x => x.key === catKey);
  if (!c) return null;
  const s = c.subTypes.find(x => x.key === subKey);
  return s ? s.name : null;
}

/** 调试用：整张表快照。 */
export function dumpCategories() {
  compile();
  return {
    categories: (_cats || []).map(c => ({
      key: c.key, name: c.name, short: c.short,
      types: [...c.types],
      subTypes: c.subTypes.map(s => ({ key: s.key, name: s.name, short: s.short, types: [...s.types] })),
    })),
    overrides: (_overrideRx || []).map(ov => ({ types: [...ov.types], cat: ov.cat, sub: ov.sub })),
  };
}

// 探针/控制台调试句柄（同款 __CONFIG / __chatBubbles）
try {
  window.__catApi = { classifyItem, listCategories, bagItemsIn, categoriesReady, categoryName, subName, dumpCategories };
} catch (e) {}
