// item-config.js
// 静态物品配置字典（只读，全量载入内存后按 id 查 name/图标/type/价格）。
//
// 数据源：config/items.json（1661 条真实物品模板，主键为数字字符串，如 '110000056'）。
//   字段实测覆盖（1661/1661 全有）：id / name / desc / image / imageDesc / type / price / tmplId / isprecious / linkName
//   ★ 没有 maxStack，也没有 stats/effect —— 这两项在真实数据里不存在（1661 条中仅 1 条带 effect）。
//     因此本模块【不提供】堆叠上限与属性加成；需要时由调用方显式传入并标注来源，绝不臆造默认值。
//
// 图标文件名（已实测，勿猜）：update/ItemIcon/icons/Item_{image}.png 存在，
//   Item_{itemId}.png 亦可能命中；三级回退 update/ItemIcon → ItemIcon0 → ItemIcon1 → resource/icon2
//   （对应 globals.js 的 UPDATE_DIR.item / itemAlt 与 ICON_DIR.item）。

import { Config, RES, UPDATE_DIR, ICON_DIR } from '../core/globals.js?v=20261007c';

/** 物品 id 归一化为用于查表的字符串键（存档里存 number，配置里是 string）。 */
function key(id) {
  if (id == null) return '';
  const n = Number(id);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(id);
}

let _cache = null;
let _cacheStamp = -1;

/** Config.items 的版本戳（Config.data.items 被替换时重建缓存）。 */
function stamp() {
  const d = Config.data && Config.data.items;
  return d ? (d.__stamp || 1) : 0;
}

/** 惰性构建并缓存 ITEM_CONFIG：id(string) -> 精简配置对象。 */
export function buildItemConfig() {
  const s = stamp();
  if (_cache && _cacheStamp === s) return _cache;
  const src = (Config.data && Config.data.items) || {};
  const out = Object.create(null);
  for (const k of Object.keys(src)) {
    const v = src[k] || {};
    const idNum = Number(v.id != null ? v.id : k);
    out[k] = {
      id: Number.isFinite(idNum) ? Math.trunc(idNum) : k,
      name: v.name || '',
      desc: v.desc || '',
      image: v.image || '',
      type: Number(v.type),
      price: Number(v.price) || 0,
      isprecious: String(v.isprecious || '0') === '1',
      linkName: v.linkName || v.name || '',
      tmplId: v.tmplId || k,
    };
  }
  _cache = out;
  _cacheStamp = s;
  return out;
}

/** ITEM_CONFIG 直取（首次访问时构建）。 */
export function ITEM_CONFIG() {
  return buildItemConfig();
}

/** 按 id 取配置；不存在返回 null（不伪造占位对象）。 */
export function itemConfig(id) {
  const k = key(id);
  if (!k) return null;
  return buildItemConfig()[k] || null;
}

export function itemName(id) {
  const c = itemConfig(id);
  return c ? c.name : '#' + key(id);
}

export function itemType(id) {
  const c = itemConfig(id);
  return c ? c.type : null;
}

export function itemDesc(id) {
  const c = itemConfig(id);
  return c ? c.desc : '';
}

export function itemPrice(id) {
  const c = itemConfig(id);
  return c ? c.price : 0;
}

/** 已载入的物品模板条数（用于探针/自检）。 */
export function itemConfigSize() {
  return Object.keys(buildItemConfig()).length;
}

/**
 * 图标 URL 候选（按优先级从高到低），调用方依次 onerror 回退。
 * ★ 2026-09-27 资源已统一：update/ItemIcon0 / update/ItemIcon1 / icon2/ItemIcon 三份
 *   互补快照全部并入 update/ItemIcon/icons/（实测 1662 件装备 100% 命中、零孤儿），
 *   故只剩一个图标目录 + AS3 兜底图 ItemDefault.png。
 * 文件名：优先 Item_{image}.png（实测命中），再 Item_{id}.png（安全网，实测从未触发）。
 */
export function itemIconCandidates(id) {
  const c = itemConfig(id);
  const files = [];
  if (c && c.image) files.push('Item_' + c.image + '.png');
  files.push('Item_' + key(id) + '.png');
  const dir = RES.update + UPDATE_DIR.item;        // update/ItemIcon/icons/
  const out = files.map((f) => dir + f);
  out.push(dir + 'ItemDefault.png');               // AS3 兜底图（无美术占位）
  // 去重保序
  return out.filter((u, i) => out.indexOf(u) === i);
}
