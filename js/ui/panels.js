// panels.js
// 对应 deobfuscated/panel/* 下各具体面板。单机版把"游戏面板"实现为 BasePanel 单例，
// 并把 deobfuscated/panel 下全部 AS3 面板类登记进 PanelManager（参考 AS3 的面板全集）。
//
// 数据来源：
//   - 角色/背包/技能：从 ui.player（登录后 Fighter 实例）+ Config.items/skills 读取
//   - 任务：从 ui._questState 读取；结构对齐 TaskListPanel（双标签树）+ DescTaskPanel（详情）
//   - 技能分类：对齐 PlayerSkillPanel 的 8 心法（英勇/坚韧/自信/洞察/热诚/怜悯/迷惑/生活）标签页
//   - 调试：对齐 DebugPanel 的运行期字段（FPS/鼠标/网络/调试开关/GC/重登）
//   - 其余 713 个 AS3 面板：用 As3Panel 占位，显示其 AS3 元数据（包/继承/职责/方法），可召唤查看

import { url, absUrl, Config, RES, UPDATE_DIR, ICON_DIR } from '../core/globals.js?v=20261007c';
import { moneyText } from '../core/money.js?v=20261007c';
import { BasePanel, panelManager } from './panel-manager.js?v=20261007c';
import { PANEL_CATALOG, PANEL_GROUPS, PANEL_GROUP_LABELS } from './as3-catalog.gen.js?v=20261007c';
import { FACE_BY_NAME, FACE_BY_ROOT } from './face-catalog.js?v=20261007c';
import { playSfx } from '../core/sound.js?v=20261007c';
import { Fighter } from '../entities/fighter.js?v=20261007c';   // 装备页居中角色动画（与游戏主城同源，复用真实 Fighter）
// 物品/背包系统：存档契约（权威）+ 纯数据管理器 + 契约↔player 桥接
// 契约结构见 js/item/save-contract.js；type↔部位 映射见 config/item_types.json（_verify/gen_item_types.py 生成）
import { ARM19_KEYS, ARM19_TYPE, ARM19_LABEL, slotKeyToIndex, canEquipToSlotKey, defaultSlotKeyForItem, booted, commit } from '../item/player-bridge.js?v=20261007c';
import { itemConfig, itemIconCandidates } from '../item/item-config.js?v=20261007c';
import { isEquipType, typeGroup, equipSlotName } from '../item/item-type.js?v=20261007c';
import { fmtRemain as fmtSlotRemain } from '../item/item-effects.js?v=20261007c';
import { classifyItem, listCategories, bagItemsIn, categoriesReady, categoryName, subName } from '../item/item-category.js?v=20261007c';

// 统一图标兜底：图片加载失败则隐藏，避免破图
// ch: items.json keeps the art id in `image` (not `icon`); art on disk is
//   update/ItemIcon0/icons/Item_<image>.png. Accept both raw ids and filenames.
function itemIconFile(def) {
  if (!def) return '';
  const raw = def.icon || def.image || def.id;
  if (!raw) return '';
  const s = String(raw);
  if (/\.png$/i.test(s)) return s;
  return 'Item_' + s + '.png';
}

// 道具图标候选源（逐级回退，全 miss 才隐藏，不破图）：
// ★ 2026-09-27 资源已统一：update/ItemIcon0 / update/ItemIcon1 / icon2/ItemIcon 三份
//   互补快照全部并入 update/ItemIcon/icons/（实测 1662 件装备 100% 命中、零孤儿）。
const ITEM_ICON_DIRS = [
  RES.update + UPDATE_DIR.item
];
// AS3 兜底图：GlobalResource.ItemDefault（LoadSprite02.setDefaultBg 的「无美术」占位），
//   随资源统一一并带入 update/ItemIcon/icons/。
const ITEM_DEFAULT_ICON = RES.update + UPDATE_DIR.item + 'ItemDefault.png';
export function itemIconSrcs(def) {
  const f = itemIconFile(def);
  if (!f) return [ITEM_DEFAULT_ICON];          // 连 id 都没有：也给兜底图，不空格
  return ITEM_ICON_DIRS.map(d => d + f).concat([ITEM_DEFAULT_ICON]);
}
// src 先取第一源，失败由 wireIconFallback 逐级换源（末位恒为 AS3 兜底图 ItemDefault）
//   data-cands 用 | 分隔，URL 中不会出现该字符
export function iconImg(srcs, cls) {
  if (!srcs || !srcs.length) return '';
  return `<img class="${cls}" src="${srcs[0]}" alt="" draggable="false" data-cands="${srcs.join('|')}"/>`;
}
function wireOne(img, srcs) {
  if (!img || !srcs || srcs.length < 2) return;
  img.addEventListener('error', () => {
    const i = (+(img.dataset.ci || 0)) + 1;
    if (i < srcs.length) { img.dataset.ci = String(i); img.src = srcs[i]; }
    else { img.style.visibility = 'hidden'; }
  });
}
export function wireIconFallback(root) {
  if (!root) return;
  root.querySelectorAll('img[data-cands]').forEach(img => wireOne(img, img.dataset.cands.split('|')));
}

function imgWithFallback(src, cls) {
  return `<img class="${cls || ''}" src="${src}" onerror="this.style.visibility='hidden'"/>`;
}

// 简易 HTML 转义，避免数据中的 < > & " 破坏面板结构
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 字段/方法名 → 中文友好标签（拆分驼峰/下划线并首字母大写）
function humanize(s) {
  if (!s) return '项';
  const parts = String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_]/g, ' ').trim().split(/\s+/);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
// 方法签名字符串：name(params):ret（源于 AS3 源码，用于按钮/列表展示真实契约）
function sigOf(meth) {
  if (!meth) return '';
  return meth.name + '(' + (meth.params || '') + ')' + (meth.ret ? ':' + meth.ret : '');
}
// 由字段角色/类型/默认值推导「真实默认值」（仅源于 AS3 源码 def，绝不随机）
function defValue(role, type, def) {
  if (def != null && def !== '') {
    const d = String(def).trim();
    if (/^-?\d+(\.\d+)?$/.test(d)) return Number(d);
    if (/^(true|false)$/i.test(d)) return d.toLowerCase() === 'true';
    if (/^["'].*["']$/.test(d)) return d.slice(1, -1);
  }
  if (role === 'check') return false;
  if (role === 'slider') return 50;                 // 确定性中点值
  if (/bool/i.test(type || '')) return false;
  if (/(int|number|float|double|uint)/i.test(type || '')) return 0;
  return '';                                        // text/select 默认空（占位由 placeholder 提示）
}
// select 候选选项：确定性、源于面板真实元数据（子视图/动作名），兜底按字段语义
function selectOptions(m, f) {
  const cand = [];
  (m.subviews || []).forEach(s => cand.push(humanize(s)));
  (m.actions || []).forEach(a => { const h = humanize(a); if (!cand.includes(h)) cand.push(h); });
  if (cand.length) return cand.slice(0, 6);
  if (/enable|open|show|visible|on|switch/i.test(f.name || '')) return ['开启', '关闭'];
  if (/mode|type|kind|status|state/i.test(f.name || '')) return ['默认', '进阶'];
  return ['未设置', '已设置'];
}
// 列表行：数据域组用真实 Config；其余用本面板真实元数据（动作/字段/子视图/方法）填充，全部源于 AS3 源码
function mockRows(m, fieldName, dom) {
  if (dom) {
    const src = dom.src() || {};
    const list = Array.isArray(src) ? src : Object.values(src);
    return list.slice(0, 8).map(d => ({ name: (d.name || d.id || '项'), desc: (d.desc || d.title || '') }));
  }
  const rows = [];
  if (m.actions && m.actions.length) {
    m.actions.slice(0, 8).forEach(a => {
      const meth = (m.methods || []).find(x => x.name === a);
      rows.push({ name: humanize(a), desc: meth ? sigOf(meth) : '动作方法' });
    });
  } else if (m.fields && m.fields.length) {
    m.fields.slice(0, 8).forEach(f => rows.push({ name: f.name, desc: ':' + f.type + (f.def != null && f.def !== '' ? ' = ' + f.def : '') }));
  } else if (m.subviews && m.subviews.length) {
    m.subviews.forEach(s => rows.push({ name: humanize(s), desc: '子视图' }));
  } else if (m.methods && m.methods.length) {
    m.methods.slice(0, 8).forEach(x => rows.push({ name: x.name, desc: sigOf(x) }));
  } else {
    rows.push({ name: humanize(fieldName || m.title), desc: '（列表字段，单机版暂未建模真实条目，可在此接入 Config 数据源）' });
  }
  return rows;
}

// ───────────────────────── 角色属性面板（对齐 property/PlayerPanel：6 子面板 TabView）─────────────────────────
// AS3：PlayerPanel.initTab() 严格定义 5 个分页（顺序固定，不可增删）：
//   装备 BUTTON_PLAYER_ARM → viewArm / 属性 BUTTON_PLAYER_PROPERTY → viewProperty /
//   守护 BUTTON_PLAYER_ANTI → viewHeart / 徽章 BUTTON_PLAYER_BAGDE → viewBagde /
//   元神 BUTTON_PLAYER_YUANSHEN → viewEssence
// TabView 背景：panel_no_select(未选) / panel_select(选中)；标签图：text_panel_player_gear/property/heart/bagde/essence
// 面板背景：initBackground("playerinfo")（无独立 PNG，复用 BasePanel 的 common_* 九宫格）
// 帧色：ComponentBuilder.createFrame 颜色 4071424 = #3E2000
const CHAR_TABS = [
  { key: 'arm',      label: '装备', img: 'textpanelplayergear.png',       dir: 'res' },
  { key: 'property', label: '属性', img: 'textpanelplayerproperty.png',   dir: 'res' },
  { key: 'anti',     label: '心法', img: 'textpanelheart.png',            dir: 'res' },
  { key: 'bagde',    label: '徽章', img: 'textpanelbagde.png',            dir: 'res' },
];
// 心法页技能格布局（对齐 人物属性.html「心法」页 / character-attrs.js buildXin）
// 上排 5（XINFA_TOP）+ 中排 5 红底（XINFA_MID）+ 「英勇」加成 4（XINFA_BUFF），索引对应玩家已学技能列表。
const XINFA_TOP  = [0, 1, 2, 3, 4];
const XINFA_MID  = [5, 6, 7, 8, 9];
const XINFA_BUFF = [10, 11, 12, 13];
// 装备槽位（严格对齐 ViewArm.initGridPointArray 的 26 槽：img 底图名 + 部位 info + 顺序）
// 顺序与 AS3 完全一致：武器(08)→头饰(00)→项链(05)→衣(01)→手镯(03)×2→腰带(02)→戒指(04)×2
//   →裤(06)→鞋(07)→首饰(10)×4→时装(09)→护肩(11)→披风(12)→翅膀(13)→法宝(10)×6→如意(10)
// 注：首饰/法宝/如意 共用同一底图 panel_equip10（与 AS3 一致）；双手镯/双戒指/首饰2-4/法宝2-6 为真实存在的独立槽位。
// key 为装备存储键（多槽位部位一律带序号后缀，避免重复部位名碰撞），name 为展示名。
// ★ 名称口径 = 物品 desc「绑定部位」（2026-09-17 依 Lang+desc 实证重定）：
//   下标1 = 头饰（旧名「护腕」已证伪，type1 的 144 条 desc 全写「绑定头饰」）
//   下标4/5 = 手镯（type4，desc 写「手镯」，AS3 常量 VIEW_ARM_BG_BRACELET）
//   下标11-14 = 首饰（type9，desc 30/30 写「首饰」；面板底图口径为「饰品」）
const ARM_SLOTS = [
  { name: '武器', key: '武器',  img: 'panelequip08.png' },
  { name: '头饰', key: '头饰',  img: 'panelequip00.png' },
  { name: '项链', key: '项链',  img: 'panelequip05.png' },
  { name: '衣服', key: '衣服',  img: 'panelequip01.png' },
  { name: '手镯', key: '手镯1', img: 'panelequip03.png' },
  { name: '手镯', key: '手镯2', img: 'panelequip03.png' },
  { name: '腰带', key: '腰带',  img: 'panelequip02.png' },
  { name: '戒指', key: '戒指1', img: 'panelequip04.png' },
  { name: '戒指', key: '戒指2', img: 'panelequip04.png' },
  { name: '裤子', key: '裤子',  img: 'panelequip06.png' },
  { name: '鞋子', key: '鞋子',  img: 'panelequip07.png' },
  { name: '首饰', key: '首饰1', img: 'panelequip10.png' },
  { name: '首饰', key: '首饰2', img: 'panelequip10.png' },
  { name: '首饰', key: '首饰3', img: 'panelequip10.png' },
  { name: '首饰', key: '首饰4', img: 'panelequip10.png' },
  { name: '时装', key: '时装',  img: 'panelequip09.png' },
  { name: '护肩', key: '护肩',  img: 'panelequip11.png' },
  { name: '披风', key: '披风',  img: 'panelequip12.png' },
  { name: '翅膀', key: '翅膀',  img: 'panelequip13.png' },
  { name: '法宝', key: '法宝1', img: 'panelequip10.png' },
  { name: '法宝', key: '法宝2', img: 'panelequip10.png' },
  { name: '法宝', key: '法宝3', img: 'panelequip10.png' },
  { name: '法宝', key: '法宝4', img: 'panelequip10.png' },
  { name: '法宝', key: '法宝5', img: 'panelequip10.png' },
  { name: '法宝', key: '法宝6', img: 'panelequip10.png' },
  { name: '如意', key: '如意',  img: 'panelequip10.png' },
];
// 资源标签图：命中真实 textpanel* 图，失败回退纯文本（对齐 AS3 getLinkName 资源调用）
const tabLbl = (file, dir, text) =>
  `<img class="tabimg" src="${url[dir](file)}" alt="${text}" onerror="this.replaceWith(document.createTextNode('${text}'))"/>`;
// 装备槽位 → 物品 type（已确证，来自 config/item_types.json，勿手改）
// 旧版这里是 { '武器':'weapon', '衣服':'armor' }，只认 2 个槽位；且 items.json 的 type 是
// 数字码而这里比的是字符串，`it.type === need` 恒为 false —— 换装菜单与拖拽类型判定实际是死代码。
// 现用逆向出的 type↔部位 映射（0~13 已确证）替代，19 个装备位全部可穿戴。
// key(存储键) -> 数字 type；非装备栏键（法宝/如意）不在表中，保持只读展示。
const SLOT_TYPE = (() => {
  const m = {};
  ARM19_KEYS.forEach((key, i) => { m[key] = ARM19_TYPE[i]; });
  return m;
})();
// 物品是否可穿到该槽（契约权威判定）
function slotAccepts(key, itemId) {
  if (slotKeyToIndex(key) < 0) return false;
  return !!canEquipToSlotKey(itemId, key).ok;
}

// 背包堆叠原子操作（合并同 id）：对齐 AS3 BAG 背包堆叠语义（同一 itemId 占一格、count 累加）
// ★ 自 2026-09-17 起：写入走存档契约（js/item/inventory.js 的 InventoryManager），
//   player.bag 退化为契约的投影视图；未启动（booted() 为 null）时保留旧的直接改数组行为兜底。
function bagAddOne(p, itemId) {
  const b = booted();
  if (b && b.inv) {
    const r = b.inv.addItem(itemId, 1);
    if (!r.ok && r.reason === 'bag-full') ui_toastIfAny('背包已满，无法放入');
    commit('bagAddOne');
    return;
  }
  const bag = p.bag || (p.bag = []);
  const s = bag.find(x => x.itemId === itemId);
  if (s) s.count += 1; else bag.push({ itemId, count: 1 });
}
function bagRemoveOne(p, itemId) {
  const b = booted();
  if (b && b.inv) {
    const r = b.inv.removeItemById(itemId, 1);
    commit('bagRemoveOne');
    return !!r.ok;
  }
  const bag = p.bag || (p.bag = []);
  const s = bag.find(x => x.itemId === itemId);
  if (!s) return false;
  s.count -= 1;
  if (s.count <= 0) p.bag = bag.filter(x => x !== s);
  return true;
}
// 轻提示：桥接层不在 UI 上下文时静默（避免为了提示反引 UI 依赖）
function ui_toastIfAny(msg) {
  const bp = panelManager.panels['bag'];
  if (bp && bp.ui && typeof bp.ui.toast === 'function') bp.ui.toast(msg);
}

// 装备穿戴/脱下共享逻辑：背包面板与角色面板装备页共用同一事实来源。
// 核心不变量（对齐 AS3：「装备其实就是特殊的背包格子，穿戴即从背包移走」）：
//   同一物品【不会】既在背包又在身上——穿戴则背包 -1，脱下则背包 +1，换装先回旧装再戴新装。
// 写 player.equip[槽位] → 重算战斗属性(applyEquip) → 同步 角色面板/背包面板/HUD（对齐 AS3 背包穿戴联动属性面板）
export function equipWear(ui, slotName, itemId, on) {
  const p = ui.player; if (!p) return false;
  const itemsMap = Config.items || {};
  const b = booted();

  // ── 契约路径（权威）：背包与装备位都写在 save-contract 的结构上 ──
  if (b && b.inv) {
    const save = b.save;
    const idx = slotKeyToIndex(slotName);
    if (idx < 0) { ui.toast(slotName + '：该槽位不属于装备栏（本版未接管）'); return false; }

    if (on) {
      const idVal = Number(itemId);
      const chk = canEquipToSlotKey(idVal, slotName);          // 类型校验（旧版无校验）
      if (!chk.ok) {
        ui.toast('「' + slotName + '」只能装备 ' + ARM19_LABEL[idx] + ' 类物品');
        return false;
      }
      const prev = save.equipments[idx].itemId;
      const bagIdx = save.inventory.findIndex((s) => s && s.id === idVal);
      if (bagIdx < 0) { ui.toast('背包里没有这件物品'); return false; }
      b.inv.removeItem(bagIdx, 1);                             // 「装备即从背包移走」
      if (prev != null && prev !== idVal) b.inv.addItem(prev, 1);  // 旧装退回背包
      save.equipments[idx].itemId = idVal;
      const it = itemsMap[idVal];
      ui.toast('已装备「' + (it ? it.name : '装备') + '」到 ' + slotName);
      playSfx('equip');
    } else {
      const cur = save.equipments[idx].itemId;
      if (cur != null) {
        const r = b.inv.addItem(cur, 1);                       // 脱下 → 退回背包
        if (!r.ok) { ui.toast('背包已满，无法脱下'); return false; }
      }
      save.equipments[idx].itemId = null;
      ui.toast('已脱下 ' + slotName + (cur != null ? '（已放回背包）' : ''));
      playSfx('unequip');
    }

    commit('equipWear');                                       // 投影回 player + 落盘
    if (typeof p.applyEquip === 'function') p.applyEquip();
    // ★ 只重绘角色面板的【装备层】（_refreshEquip），不整面板 render：
    //   后者会重建居中模型/重绑全部元素，造成「所有装备都在闪」的视觉
    const cp = panelManager.panels['playerpanel'];
    if (cp && cp.dom && cp.dom.style.display !== 'none') {
      if (typeof cp._refreshEquip === 'function' && cp._tab === 'arm') cp._refreshEquip();
      else cp.render();
    }
    const bpl = panelManager.panels['bag'];
    if (bpl && bpl.dom && bpl.dom.style.display !== 'none') bpl.render();
    if (ui.refresh) ui.refresh();
    return true;
  }

  // ── 兜底路径（系统未启动：保持旧行为，直接改 player）──
  p.equip = p.equip || {}; p.bag = p.bag || [];
  if (on) {
    const idVal = String(itemId).match(/^\d+$/) ? Number(itemId) : itemId;   // id 归一为数字，与 player.json 一致
    const prev = p.equip[slotName];
    if (prev != null && prev !== idVal) bagAddOne(p, prev);   // 目标槽已穿 → 旧装退回背包
    p.equip[slotName] = idVal;                                // 戴上新装
    bagRemoveOne(p, idVal);                                   // 从背包移除（「装备即从背包移走」）
    const it = itemsMap[idVal];
    ui.toast('已装备「' + (it ? it.name : '装备') + '」到 ' + slotName);
    playSfx('equip');
  } else {
    const cur = p.equip[slotName];
    if (cur != null) bagAddOne(p, cur);                       // 脱下 → 退回背包
    delete p.equip[slotName];
    ui.toast('已脱下 ' + slotName + (cur != null ? '（已放回背包）' : ''));
    playSfx('unequip');
  }
  if (typeof p.applyEquip === 'function') p.applyEquip();   // 立即把加成叠回 atk/def/maxHp/maxMp，影响后续战斗
  const charPanel = panelManager.panels['playerpanel'];
  if (charPanel && charPanel.dom && charPanel.dom.style.display !== 'none') charPanel.render();
  const bagPanel = panelManager.panels['bag'];
  if (bagPanel && bagPanel.dom && bagPanel.dom.style.display !== 'none') bagPanel.render();
  if (ui.refresh) ui.refresh();
  return true;
}

// ───────────────────────── 跨面板拖拽（对齐 AS3 cursorManager.itemPanel + LoadSprite 跟随光标）─────────────────────────
// 行为：背包物品 mousedown 后跟随光标（幽灵图标）；落到装备格（SLOT_TYPE 类型匹配）即穿戴（并从背包移除）；
//   已穿戴物品拖到背包格即脱下回背包；拖到另一装备格即换装。带 4px 阈值的「点击/拖拽」区分，未过阈值按点击处理。
let _drag = null;        // 进行中：{ def, from:'bag'|'equip', ui, bagIndex?, slot? }
let _pending = null;     // 阈值前：{ def, from, info, sx, sy, onClick }
let _ghost = null;       // 跟随光标的幽灵图标
let _hlSlot = null;      // 当前高亮的装备格
let _shopHl = null;     // 拖拽悬停的商店面板（出售落点）

function _clearHl() {
  if (_hlSlot) { _hlSlot.classList.remove('drop-ok', 'drop-bad'); _hlSlot = null; }
}
function _clearDrag() {
  if (_ghost) { _ghost.remove(); _ghost = null; }
  document.body.classList.remove('item-dragging');
  _drag = null; _pending = null; _clearHl();
  if (_shopHl) { _shopHl.style.outline = ''; _shopHl = null; }
}
function _makeGhost(def) {
  const g = document.createElement('img');
  const _gs = itemIconSrcs(def);
  g.src = _gs[0] || url.icon('item', def.icon);
  g.dataset.cands = _gs.join('|');
  g.className = 'item-drag-ghost';
  g.alt = '';
  g.draggable = false;
  wireOne(g, _gs);   // 图标缺失不破图
  document.body.appendChild(g);
  _ghost = g;
}
// 鼠标/触摸事件统一取点（TouchEvent 取主触点；鼠标事件直接取 clientX/Y）
function _ptOf(e) {
  const t = (e.touches && e.touches.length) ? e.touches[0]
    : (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0] : null;
  return t ? { clientX: t.clientX, clientY: t.clientY } : { clientX: e.clientX, clientY: e.clientY };
}
function _moveGhost(pt) {
  if (!_ghost) return;
  _ghost.style.left = pt.clientX + 'px';
  _ghost.style.top = pt.clientY + 'px';
}
function _slotUnder(pt) {
  const t = document.elementFromPoint(pt.clientX, pt.clientY);
  return (t && t.closest) ? t.closest('.pp-dropzone, .eq-slot.pick') : null;
}
function _bagUnder(pt) {
  const t = document.elementFromPoint(pt.clientX, pt.clientY);
  // ★ 限定在背包面板内：商店购买网格也复用了 .bag-cell 类，不限定会误触发背包重排
  return (t && t.closest) ? t.closest('#panel-bag .bag-cell') : null;
}
// 拖到商店面板上 = 出售落点（面板可见时才算；返回面板实例）
function _shopUnder(pt) {
  const t = document.elementFromPoint(pt.clientX, pt.clientY);
  const el = (t && t.closest) ? t.closest('#panel-npcshop') : null;
  if (!el || el.style.display === 'none') return null;
  return panelManager.panels['npcshop'] || null;
}
function _hlUpdate(pt) {
  const slot = _slotUnder(pt);
  const shop = slot ? null : _shopUnder(pt);
  if (slot === _hlSlot && shop === _shopHl) return;
  _clearHl();
  if (_shopHl) { _shopHl.style.outline = ''; _shopHl = null; }
  if (slot && _drag) {
    const ok = slotAccepts(slot.dataset.slot, _drag.def.id);   // 类型匹配才绿，否则红（对齐 AS3 showGrid 高亮）
    slot.classList.add(ok ? 'drop-ok' : 'drop-bad');
    _hlSlot = slot;
  } else if (shop && _drag && _drag.from === 'bag') {
    shop.dom.style.outline = '2px solid #6fe07a';   // 背包物品拖到商店 = 出售，绿框提示
    shop.dom.style.outlineOffset = '2px';
    _shopHl = shop.dom;
  }
}
function _bagRearrange(ui, fromIdx, toIdx) {
  const bag = ui.player && ui.player.bag; if (!bag || fromIdx === toIdx) return;
  const item = bag[fromIdx]; if (!item) return;
  if (toIdx < 0 || toIdx > bag.length) return;            // 越界忽略
  if (toIdx === bag.length) { bag.splice(fromIdx, 1); bag.push(item); }              // 拖到末尾之后：追加
  else if (!bag[toIdx]) { bag.splice(fromIdx, 1); bag.splice(toIdx, 0, item); }       // 目标空格：移动过去
  else { const tmp = bag[toIdx]; bag[toIdx] = item; bag[fromIdx] = tmp; }             // 目标有物：交换
  if (ui.refresh) ui.refresh();
  const bp = panelManager.panels['bag'];
  if (bp && bp.dom && bp.dom.style.display !== 'none') bp.render();
}
function _onDragMove(e) {
  if (e.touches) e.preventDefault();                        // 触屏拖拽时阻止页面滚动/双击缩放
  const pt = _ptOf(e);
  if (_pending) {
    const dx = pt.clientX - _pending.sx, dy = pt.clientY - _pending.sy;
    if (dx * dx + dy * dy < 16) return;                    // 阈值 4px：未过阈值保持 pending（按点击处理）
    _drag = _pending; _pending = null;
    _makeGhost(_drag.def);
    document.body.classList.add('item-dragging');
    _moveGhost(pt);
  }
  if (!_drag) return;
  _moveGhost(pt);
  _hlUpdate(pt);
}
function _onDragUp(e) {
  window.removeEventListener('mousemove', _onDragMove);
  window.removeEventListener('mouseup', _onDragUp);
  window.removeEventListener('touchmove', _onDragMove);
  window.removeEventListener('touchend', _onDragUp);
  window.removeEventListener('touchcancel', _clearDrag);
  if (_pending && !_drag) {                                // 未达阈值 = 点击：交还点击处理者
    const p = _pending; _pending = null;
    if (p.onClick) p.onClick();
    return;
  }
  if (!_drag) return;
  const d = _drag;
  const pt = _ptOf(e);
  const slot = _slotUnder(pt);
  const bagCell = slot ? null : _bagUnder(pt);
  const shopPanel = (slot || bagCell) ? null : _shopUnder(pt);
  if (slot) {
    if (slotAccepts(slot.dataset.slot, d.def.id)) {          // 类型匹配 → 装备
      if (d.from === 'bag') {
        const bp = panelManager.panels['bag']; if (bp) bp._sel = -1;   // 先清失效选中索引，再触发重渲染
        equipWear(d.ui, slot.dataset.slot, d.def.id, true);   // 内部从背包移除
      } else if (d.from === 'equip' && d.slot !== slot.dataset.slot) {
        equipWear(d.ui, d.slot, null, false);              // 旧槽回背包
        equipWear(d.ui, slot.dataset.slot, d.def.id, true); // 戴到新槽（从背包移除）
      }
    } else {
      const idx = slotKeyToIndex(slot.dataset.slot);
      d.ui.toast('「' + slot.dataset.slot + '」只能装备' + (idx >= 0 ? (' ' + ARM19_LABEL[idx] + ' 类物品') : '对应类物品'));
    }
  } else if (bagCell) {
    if (d.from === 'equip') equipWear(d.ui, d.slot, null, false);          // 拖回背包 = 脱下
    else if (d.from === 'bag') _bagRearrange(d.ui, d.bagIndex, +bagCell.dataset.gi);  // 背包内重排
  } else if (shopPanel) {
    if (d.from === 'bag' && typeof shopPanel.requestSell === 'function') shopPanel.requestSell(d.def, d.bagIndex);  // 背包拖到商店 = 出售
  }
  _clearDrag();
}
// 在元素上挂拖拽起点（mousedown / touchstart，鼠标与触屏同走一套 _onDragMove/_onDragUp）。
// onClick：未达拖动阈值时的点击回调（如打开换装菜单）。
export function wireItemDrag(el, def, from, info, onClick) {
  const begin = (sx, sy) => {
    _pending = { def, from, ui: info.ui, bagIndex: info.bagIndex, slot: info.slot, sx, sy, onClick };
  };
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    begin(e.clientX, e.clientY);
    window.addEventListener('mousemove', _onDragMove);
    window.addEventListener('mouseup', _onDragUp);
  });
  el.addEventListener('touchstart', (e) => {
    if (!e.touches.length) return;
    e.preventDefault();                       // 抑制触屏的鼠标仿真与后续滚动
    const t = e.touches[0];
    begin(t.clientX, t.clientY);
    window.addEventListener('touchmove', _onDragMove, { passive: false });
    window.addEventListener('touchend', _onDragUp);
    window.addEventListener('touchcancel', _clearDrag);
  }, { passive: false });
}

// ── AS3 原版富文本浮窗 ──────────────────────────────────────────
// 真值：deobfuscated/panel/item/LoadSprite.as getInfo() = "<font size='12'>" + this.desc + "</font>"（htmlText 渲染）；
//      容器 face/PromptFace.as showInfoPrompt → component/BottomPrompt.as setInfoText(text, 360, false)：
//      宽 = textWidth+15（上限 360）、深色半透明底、描边色 14739081(≈#E0E689)、白字默认、锚点下方居中、越底翻上。
// 富文本来源：Config.items[id].descRich（globals.js 从 config/item_rich.json 写入，
//      由 _work/gen_item_rich.cjs 从 op178 玩家背包 / op102 NPC店 / op136 商城 抓包逐字导出，不改 desc）。
// 无抓包富文本的装备：richifyItemDesc 把纯文本 desc 按 AS3 段落结构重排——
//      数值/文案逐字取自 desc，仅套用实证配色与段落顺序，不臆造任何数据。

// 富文本标签白名单：只放行 <font color size> / <br> / <b><i><u>，其余一律转义（防注入）
const _RICH_TAG = /^<\/?(font|b|i|u|br)\b[^>]*>$/i;
export function sanitizeRichText(t) {
  if (!t) return '';
  return String(t).split(/(<[^>]{0,200}>)/)
    .map(x => {
      if (!_RICH_TAG.test(x)) return x.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // AS3/Flash 的 <font size='12'> 是「像素」；浏览器 <font size> 是 1~7 旧字号档，
      // size='12' 会被夹到最大档 7（约 40px+）→ 必须转成内联 px 样式才与原版一致
      return x.replace(/\bsize=(["']?)(\d+)\1/g, 'style="font-size:$2px"');
    })
    .join('');
}

// 名字品质后缀 → 颜色（op178 抓包 324 条实证：神品红 / 玄·灵·极品橙 / 凡·良·精品绿 / 其余白）
function _qualityColor(name) {
  if (/神品/.test(name)) return '#FF0000';
  if (/玄品|灵品|极品/.test(name)) return '#EF9C00';
  if (/凡品|良品|精品/.test(name)) return '#00FF00';
  return '#FFFFFF';
}

// 富文本来源优先级：descRich（抓包）> desc 自带富文本（商店/商城临时对象）> 装备重排 > 非装备重排
export function getItemRich(it) {
  if (!it) return '';
  if (typeof it.descRich === 'string' && it.descRich.indexOf('<font') >= 0) return it.descRich;
  if (typeof it.desc === 'string' && it.desc.indexOf('<font') >= 0) return it.desc;
  if (isEquipType(Number(it.type))) return richifyItemDesc(it);
  return richifyConsumeDesc(it);   // 非装备（药水/材料/内丹…）：按抓包同款结构重排，无段落结构时返回 ''
}

// 纯文本装备 desc → AS3 风格富文本（数值/文案逐字取自 desc，配色与段落顺序按抓包实证）
export function richifyItemDesc(it) {
  let s = String(it.desc || '').replace(/\r\n?/g, '\n');
  const name = String(it.name || it.id || '');
  const L = ["<font size='12'>"];

  // 名字头：desc 开头到【第一个结构关键词】或【首个多空格】为止，即服务器侧完整名字（含品质后缀）
  const NAME_STOP = ['已绑定', '装备后绑定', '获取后绑定', '未绑定', '物品耐久：', '等级需求：', '职业需求：', '转生需求：',
    '性别需求：', '属性需求：', '基础属性', '增强属性', '绑定属性', '当前孔数', '出售单价：', '【状态】', '★', '◆'];
  let nameEnd = s.length;
  for (const k of NAME_STOP) { const i = s.indexOf(k); if (i >= 0 && i < nameEnd) nameEnd = i; }
  const sp = s.match(/\s{2,}/);
  if (sp && sp.index < nameEnd) nameEnd = sp.index;
  let dispName = s.slice(0, nameEnd).trim();
  if (dispName) s = s.slice(nameEnd);
  if (!dispName) dispName = name;                       // desc 无名字头时退回 items.json 名字
  s = s.trim();
  L.push("<font color='" + _qualityColor(dispName) + "'><font size='14'>" + esc(dispName) + "</font></font>"
    + "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<br>");

  // 星级 / 铭刻等级符（◆）
  const starM = s.match(/^([★]{1,20})\s*(◆*)/);
  if (starM) {
    s = s.slice(starM[0].length).trim();
    if (starM[1]) L.push("<font color='#DFDD05'>" + starM[1] + "</font><br>");
    if (starM[2]) L.push("<font color='#DFDD05'><b>" + starM[2] + "</b></font><br>");
  }

  // 取「key 到 stops 之前」的段落并从 s 中移除（剩余文本自然留作描述）
  const take = (key, stops) => {
    const i = s.indexOf(key);
    if (i < 0) return null;
    let j = s.length;
    for (const st of stops) { const k = s.indexOf(st, i + key.length); if (k >= 0 && k < j) j = k; }
    const seg = s.slice(i, j);
    s = s.slice(0, i) + s.slice(j);
    return seg.replace(/\s+/g, ' ').trim();
  };

  // 绑定状态 + 部位（一并匹配并整体移除，避免部位名残留在描述里；部位名取 desc 实证）
  const bindM = s.match(/(已绑定|装备后绑定|获取后绑定|未绑定)(?:\s*\t*\s*(武器|头饰|衣服|上衣|裤子|鞋子|手镯|腰带|项链|首饰|饰品|披风|时装|肩膀|翅膀))?/);
  if (bindM) s = s.replace(bindM[0], '').trim();
  const slotTxt = (bindM && bindM[2]) || equipSlotName(Number(it.type)) || '';
  if (bindM || slotTxt) {
    if (bindM) L.push("<font color='" + (bindM[1] === '已绑定' ? '#00FF00' : '#D50503') + "'>" + bindM[1] + "</font>");
    if (bindM && slotTxt) L.push('\t');
    if (slotTxt) L.push("<font color='#00FF00'>" + slotTxt + "</font>");
    L.push('<br>');
  }

  // 耐久（耐久率 ≥80% 绿，否则橙 —— 抓包实证阈值）
  const dur = take('物品耐久：', ['等级需求', '职业需求', '转生需求', '性别需求', '属性需求', '基础属性', '增强属性', '绑定属性', '当前孔数', '出售单价']);
  if (dur) {
    const dm = dur.match(/(\d+)\s*\/\s*(\d+)/);
    if (dm) {
      const ratio = Number(dm[2]) ? Number(dm[1]) / Number(dm[2]) : 1;
      L.push("物品耐久：<font color='" + (ratio >= 0.8 ? '#00FF00' : '#EF9C00') + "'>" + dm[1] + '/' + dm[2] + "</font><br>");
    } else L.push(esc(dur) + '<br>');
  }

  // 需求行（等级/职业/转生/性别/属性）：同段 &nbsp; 分隔（未做玩家条件判定，统一绿色）
  const REQ_STOPS = ['等级需求', '职业需求', '转生需求', '性别需求', '属性需求', '基础属性', '增强属性', '绑定属性', '当前孔数', '出售单价'];
  const reqs = [];
  for (const k of ['等级需求', '职业需求', '转生需求', '性别需求', '属性需求']) {
    const seg = take(k, REQ_STOPS);
    if (seg) reqs.push("<font color='#00FF00'>" + esc(seg) + "</font>");
  }
  if (reqs.length) L.push(reqs.join('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;') + '<br>');

  // 属性段（基础/增强/绑定）：只取「+N 属性」连续列表，其余文本留在描述里
  //   抓包实证：基础属性默认色；增强属性 #8888FF；绑定属性 #00FF00；条间 &nbsp; 分隔
  // 属性段正则（字面量）：匹配「key：+N 属性 +N 属性 …」的连续属性列表
  const ATTR_RE = {
    '基础属性': /基础属性：((?:\+\d+[‰]?\s*[^\s+]+)(?:\s*\+\d+[‰]?\s*[^\s+]+)*)/,
    '增强属性': /增强属性：((?:\+\d+[‰]?\s*[^\s+]+)(?:\s*\+\d+[‰]?\s*[^\s+]+)*)/,
    '绑定属性': /绑定属性：((?:\+\d+[‰]?\s*[^\s+]+)(?:\s*\+\d+[‰]?\s*[^\s+]+)*)/,
  };

  const attrList = (key, color, sep) => {
    const m = s.match(ATTR_RE[key]);
    if (!m) return false;
    s = s.replace(m[0], '').trim();
    const parts = [...m[1].matchAll(/\+\d+[‰]?\s*[^\s+]+/g)].map(x => x[0].trim());
    if (color) L.push(parts.map(x => "<font color='" + color + "'>" + esc(x) + "</font>").join(sep) + '<br>');
    else L.push(parts.map(esc).join(sep) + '<br>');
    return true;
  };
  attrList('基础属性', null, '&nbsp;&nbsp;&nbsp;');
  attrList('增强属性', '#8888FF', '&nbsp;&nbsp;');
  attrList('绑定属性', '#00FF00', '&nbsp;&nbsp;');

  // 铭刻 / 附魔（紫 #CB40F1）+ 宝石（●○ 青色 #08E6E3）—— 逐条扫描并从 s 移除
  const gemRe = /(?:\d+级铭刻：\S*?‰\s*[^\s●○]+|\d+级附魔：[+-]?\d+\s*[^\s●○]+|[●○]【[^】]+】(?:\s*[+-]?\d+[‰]?\s*[^\s●○]*)?)/g;
  for (const m of [...s.matchAll(gemRe)]) {
    const rec = m[0].trim();
    const i = s.indexOf(rec);
    if (i >= 0) s = s.slice(0, i) + s.slice(i + rec.length).trim();
    if (rec[0] === '●' || rec[0] === '○') {
      L.push("<font color='#D6FC50'>" + rec[0] + "</font><font color='#08E6E3'>" + esc(rec.slice(1)) + "</font><br>");
    } else {
      L.push("<font color='#CB40F1'>" + esc(rec) + "</font><br>");
    }
  }

  // 当前孔数/最大孔数（绿）
  const holes = take('当前孔数', ['出售单价']);
  if (holes) L.push("<font color='#00FF00'>" + esc(holes) + "</font><br>");

  // 先移除出售单价，剩余文本即描述（橙黄 #F4B757），再把出售单价放最后（AS3 顺序）
  const sell = take('出售单价', []);
  const descTxt = s.replace(/\s+/g, ' ').trim();
  if (descTxt) L.push("<font color='#F4B757'>" + esc(descTxt).replace(/\n/g, '<br>') + "</font>");
  if (sell) L.push(esc(sell) + '<br>');

  L.push('</font>');
  return L.join('');
}

// 纯文本非装备 desc（药水/材料/内丹…，通用 【状态】【描述】【用途】 段落结构）→ AS3 风格富文本。
// 结构与配色逐条取自 op178 等抓包样本（如 110000222 大瓶生命药水、110000871 未绑定样本）：
//   <font size='12'><font color='#品质'><font size='14'>名字</font></font>&nbsp;×6<br><br>
//   【状态】 <font color='#00FF00(已绑定)|#D50503(未绑定)'>状态</font><br>
//   【描述】 …<br>【用途】 …<br><br><br>[+N 属性 <br>]出售单价：…
// 数值/文案逐字取自 desc，仅套用实证配色与段落顺序，不臆造任何数据；无段落结构返回 ''。
export function richifyConsumeDesc(it) {
  let s = String(it.desc || '').replace(/\r\n?/g, '\n');
  if (!/【状态】|【描述】/.test(s)) return '';
  const name = String(it.name || it.id || '');

  // 名字头：到首个【段标签】或首个多空格为止（服务器侧完整名字，含品质后缀）
  let nameEnd = s.length;
  for (const k of ['【状态】', '【描述】', '【用途】']) { const i = s.indexOf(k); if (i >= 0 && i < nameEnd) nameEnd = i; }
  const sp = s.match(/\s{2,}/);
  if (sp && sp.index < nameEnd) nameEnd = sp.index;
  let dispName = s.slice(0, nameEnd).trim();
  if (dispName) s = s.slice(nameEnd);
  if (!dispName) dispName = name;
  s = s.trim();

  const L = ["<font size='12'>"];
  L.push("<font color='" + _qualityColor(dispName) + "'><font size='14'>" + esc(dispName) + "</font></font>"
    + "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<br><br>");

  // 【状态】之前的前置额外段（内丹「装备等级：… 内丹形状：■ …」等）默认色保留
  const stI = s.indexOf('【状态】');
  if (stI > 0) {
    const pre = s.slice(0, stI).replace(/[ \t]+/g, ' ').trim();
    if (pre) L.push(esc(pre).replace(/\n/g, '<br>') + '<br>');
    s = s.slice(stI).trim();
  }

  // 取「key 到 stops 之前」的段落并从 s 中移除（剩余文本留作属性行/出售单价）
  const take = (key, stops) => {
    const i = s.indexOf(key);
    if (i < 0) return null;
    let j = s.length;
    for (const st of stops) { const k = s.indexOf(st, i + key.length); if (k >= 0 && k < j) j = k; }
    const seg = s.slice(i + key.length, j);
    s = s.slice(0, i) + s.slice(j);
    return seg.replace(/[ \t]+/g, ' ').trim();
  };

  // 状态行：已绑定绿 #00FF00 / 未绑定（含装备后/获取后绑定）红 #D50503（抓包实证）
  const st = take('【状态】', ['【描述】', '【用途】', '出售单价：', '+']);
  if (st) {
    const bindM = st.match(/^(已绑定|装备后绑定|获取后绑定|未绑定)$/);
    if (bindM) L.push("【状态】 <font color='" + (bindM[1] === '已绑定' ? '#00FF00' : '#D50503') + "'>" + bindM[1] + "</font><br>");
    else L.push("【状态】 " + esc(st).replace(/\n/g, '<br>') + '<br>');
  }

  // 描述行（默认色；\n 变 <br>）——AS3 htmlText 的换行表现
  const desc = take('【描述】', ['【用途】', '出售单价：', '+']);
  if (desc) L.push("【描述】 " + esc(desc).replace(/\n/g, '<br>') + '<br>');

  // 用途行（默认色；抓包：用途后 <br><br> 间隔再接属性行/出售单价）
  const use = take('【用途】', ['出售单价：', '+']);
  if (use) L.push("【用途】 " + esc(use).replace(/\n/g, '<br>') + '<br><br><br>');

  // 剩余：属性行（+N XX）/ 评价等零散文本（默认色）→ 出售单价置末（抓包实证顺序）
  const sell = take('出售单价：', []);
  const rest = s.replace(/\s+/g, ' ').trim();
  if (rest) L.push(esc(rest) + ' <br>');
  if (sell) L.push('出售单价：' + esc(sell));

  L.push('</font>');
  return L.join('');
}
let _itemTipEl = null;
export function showItemTip(it, p, anchorEl) {
  if (!it) return;
  if (!_itemTipEl) { _itemTipEl = document.createElement('div'); _itemTipEl.className = 'item-tip item-tip-as3'; document.body.appendChild(_itemTipEl); }

  const rich = getItemRich(it);
  if (rich) {
    _itemTipEl.innerHTML = sanitizeRichText(rich);     // AS3：直接以 htmlText 渲染服务器下发的富文本
  } else {
    // 无抓包富文本且非装备：保留结构化兜底（名称+类型+effect+当前强化+描述）
    const e = it.effect || {};
    const lv = (p && p.enhance && p.enhance[it.id]) || 0;
    const step = e.atk || e.def || 0;   // 强化每级增益（对齐 ForgePanel step）
    const lines = [];
    const fld = (k, label) => {
      if (e[k] == null) return;
      let v = label + ' +' + e[k];
      if (lv && (k === 'atk' || k === 'def')) v += '（强化 +' + (lv * step) + '）';
      lines.push(v);
    };
    fld('atk', '攻击'); fld('def', '防御'); fld('mag', '法攻'); fld('spd', '速度');
    fld('hp', '生命'); fld('mp', '魔法'); fld('crit', '暴击'); fld('rage', '怒气');
    if (!lines.length) lines.push('无属性加成');
    let html = '<div class="itip-h">' + esc(it.name) + '<span class="itip-t">' + esc(it.type || '道具') + '</span></div>';
    if (lv) html += '<div class="itip-lv">强化 +' + lv + '（每级 +' + step + '）</div>';
    html += '<div class="itip-lines">' + lines.map(l => '<div class="itip-line">' + l + '</div>').join('') + '</div>';
    if (it.desc) html += '<div class="itip-desc">' + esc(it.desc) + '</div>';
    _itemTipEl.innerHTML = html;
  }

  _itemTipEl.style.display = 'block';
  // AS3 定位（BottomPrompt）：锚点水平中线下方居中；越出视口底则翻到锚点上方；左右夹回视口内
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    const sx = window.scrollX || 0, sy = window.scrollY || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = _itemTipEl.offsetWidth, h = _itemTipEl.offsetHeight;
    let x = sx + r.left + r.width / 2 - w / 2;
    let y = sy + r.bottom + 12;                       // 锚点下方（AS3 为锚点 y+50，本版格子更高，收紧到 12px）
    if (y + h > sy + vh) y = sy + r.top - h - 8;      // 越底翻上
    x = Math.max(sx + 4, Math.min(x, sx + vw - w - 4));
    _itemTipEl.style.left = x + 'px';
    _itemTipEl.style.top = y + 'px';
  } else {
    _itemTipEl.style.left = '50%';
    _itemTipEl.style.top = '80px';
  }
}
export function hideItemTip() { if (_itemTipEl) _itemTipEl.style.display = 'none'; }


// ── 技能悬浮提示（对齐 AS3 Skill2Sprite.onMouseOver/onMouseOut：
//    悬停【图标】→ 在该图标全局坐标处弹出技能信息提示（_info，由 updateSkillInfo 写入 = 技能描述）；移出即清除。
//    本版复用 .item-tip 外观（避免另造一套皮），数据只取真实技能字段，不臆造。）
//
// ★ 富文本来源：Config.skills[id].descRich —— 由 _work/gen_skill_desc.mjs 从抓包
//   SC_SKILL_LIST2(224) 的 1 级 sdesc 解析而来的结构化段落 [{c,sz,v}]（保留服务器实证
//   配色与字号；消耗数值已占位化为 XX，与 mpCost 解耦）。渲染时重新生成 <font> 富文本，
//   与 AS3「htmlText = sdesc」同口径；无 descRich 时回落到结构化兜底。
function skillSegsToRich(segs) {
  // 段落 → <font> 富文本；\n → <br>；default 色不包 font（AS3 默认白）
  const out = [];
  for (const sg of segs) {
    const parts = String(sg.v).split('\n');
    parts.forEach((p, i) => {
      if (i > 0) out.push('<br>');
      if (!p) return;
      const attrs = [];
      if (sg.c) attrs.push("color='" + sg.c + "'");
      if (sg.sz && String(sg.sz) !== '12') attrs.push("size='" + sg.sz + "'");
      out.push(attrs.length ? '<font ' + attrs.join(' ') + '>' + esc(p) + '</font>' : esc(p));
    });
  }
  return out.join('');
}
export function getSkillRich(s) {
  if (!s) return '';
  if (Array.isArray(s.descRich) && s.descRich.length) return skillSegsToRich(s.descRich);
  return '';
}
let _skillTipEl = null;
function showSkillTip(s, anchorEl) {
  if (!s) return;
  const rich = getSkillRich(s);
  if (rich) {
    // AS3：sdesc 以 htmlText 直接渲染（外层 <font size='12'> 包裹，与抓包一致）
    // ★ 与物品浮窗同底（item-tip-as3：rgba(0,0,0,.65) 黑底白字，对齐 BottomPrompt.setInfoText）
    if (!_skillTipEl) { _skillTipEl = document.createElement('div'); _skillTipEl.className = 'item-tip item-tip-as3 skill-tip'; document.body.appendChild(_skillTipEl); }
    _skillTipEl.innerHTML = sanitizeRichText("<font size='12'>" + rich + '</font>');
  } else {
    // 无抓包富文本：保留结构化兜底（名称+耗蓝+冷却+描述）
    let html = '<div class="itip-h">' + esc(s.name) + '<span class="itip-t">技能</span></div>';
    html += '<div class="itip-lv">耗蓝 ' + (s.mpCost != null ? s.mpCost : 0) + (s.cd ? (' · 冷却 ' + s.cd) : '') + '</div>';
    html += '<div class="itip-desc">' + esc(s.desc || '（暂无描述）') + '</div>';
    if (!_skillTipEl) { _skillTipEl = document.createElement('div'); _skillTipEl.className = 'item-tip item-tip-as3 skill-tip'; document.body.appendChild(_skillTipEl); }
    _skillTipEl.innerHTML = html;
  }
  _skillTipEl.style.display = 'block';
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    _skillTipEl.style.left = ((window.scrollX || 0) + r.right + 8) + 'px';
    _skillTipEl.style.top = ((window.scrollY || 0) + r.top) + 'px';
  }
}
function hideSkillTip() { if (_skillTipEl) _skillTipEl.style.display = 'none'; }
export { showSkillTip, hideSkillTip };

const BAG_GRID_MAX = 216;   // PlayerItemPanel.gridMax（存档契约容量上限；UI 不再按页切分，改为一列到底的滚动网格）
const BAG_COLS = 6;         // 网格列数（AS3 36 格/页 = 6×6，本版取消分页）
// 背包面板：六大类（CategoryType）+ 二级明细（SubType）+ 每类可竖滚动的无限网格。
// 分类真源 = config/item_categories.json（js/item/item-category.js）；配置缺失时回退「全物品单网格」。
export class BagPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-bag', title: '背包', width: 348, height: 480, ui });   // AS3 原生量级：格 37px、图标 32px（= 装备页），gap 2px
    this._cat = null;   // 当前大类 key（失效时取第一个有物品的分类）
    this._sub = null;   // 当前子类 key（null = 该大类「全部」）
    this._sel = -1;     // 选中物品全局索引（-1=未选；跨分类保留，按钮栏按它操作）
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  // 全局索引 → 物品（取 itemId 反查 Config.items 定义；缺定义则跳过展示）
  _items(p) {
    const map = Config.items || {};
    const out = [];
    (p.bag || []).forEach((s, i) => {
      const def = map[s.itemId];
      if (def) out[i] = { slot: s, def, gi: i };
    });
    return out;
  }
  render() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    const items = this._items(p);                    // 稀疏全量（下标 = 稠密索引 gi，_actUse/_actDrop 按它取选中件）
    const cats = categoriesReady() ? listCategories(p.bag) : [];
    if (!cats.some(c => c.key === this._cat)) this._cat = cats.length ? cats[0].key : null;
    const cur = cats.find(c => c.key === this._cat) || null;
    if (cur && !cur.subs.some(s => s.key === this._sub)) this._sub = null;

    // 当前视图物品：有分类 → 按大类/子类筛；无分类配置 → 全物品（旧逻辑兜底）
    const view = cur
      ? bagItemsIn(p.bag, this._cat, this._sub)
      : items.filter(Boolean);

    // 注入真实格底/选中高亮图（panel_item_bg / item_select）
    this.body.style.setProperty('--bag-cell-bg', `url("${absUrl(url.res('panelitembg.png'))}")`);
    this.body.style.setProperty('--bag-sel-bg', `url("${absUrl(url.res('panelitemselect.png'))}")`);

    // 六大类签（短名 + 拥有计数）
    const catTabs = cats.map(c =>
      `<button class="bag-cat ${c.key === this._cat ? 'on' : ''}" data-cat="${c.key}" title="${esc(c.name)}">${esc(c.short)}<span class="bag-cat-n">${c.count}</span></button>`).join('');

    // 二级明细 chips：「全部」+ 各子类（零物品的子类不显示，如预留的「特殊效果·复活」）
    const subChips = cur && cur.subs.length
      ? [`<button class="bag-sub ${this._sub === null ? 'on' : ''}" data-sub="">全部<span class="bag-sub-n">${cur.count}</span></button>`]
          .concat(cur.subs.filter(s => s.count > 0)
            .map(s => `<button class="bag-sub ${s.key === this._sub ? 'on' : ''}" data-sub="${s.key}" title="${esc(s.name)}">${esc(s.short)}<span class="bag-sub-n">${s.count}</span></button>`))
          .join('')
      : '';

    // 货币栏（对齐 AS3 PlayerItemPanel 的 silverInput/goldInput；图标 panel_coin_D_s / panel_coin_D_g）
    //   字段口径：silver = 银子（可交易，商店/强化消耗），gold = 金子。
    const _MONEY = [
      { label: '银子', icon: 'panelcoinds.png', key: 'silver' },
      { label: '金子', icon: 'panelcoindg.png', key: 'gold' },
    ];
    const moneyRows = _MONEY.map(m =>
      `<div class="bag-money"><img class="bag-money-ic" src="${url.res(m.icon)}" alt="" onerror="this.style.display='none'"/><span>${m.label}</span><b>${esc(moneyText(p, m.key))}</b></div>`).join('');

    this.setContent(`
      <div class="bag-cats">${catTabs}</div>
      ${subChips ? `<div class="bag-subs">${subChips}</div>` : ''}
      <div class="bag-grid"></div>
      <div class="bag-actions">
        <button class="bag-act" id="bag-use" ${this._sel < 0 ? 'disabled' : ''}>
          <img src="${url.res('panelitemuse.png')}" alt="使用" onerror="this.outerHTML='使用'"/>使用</button>
        <button class="bag-act" id="bag-drop" ${this._sel < 0 ? 'disabled' : ''}>
          <img src="${url.res('panelitemdrop.png')}" alt="丢弃" onerror="this.outerHTML='丢弃'"/>丢弃</button>
        <button class="bag-act" id="bag-tidy">
          <img src="${url.res('textpanelzhengli.png')}" alt="整理" onerror="this.outerHTML='整理'"/>整理</button>
      </div>
      ${moneyRows}`);

    // 绑定分类签 / 子类 chips
    this.body.querySelectorAll('.bag-cat').forEach(t =>
      t.onclick = () => { this._cat = t.dataset.cat; this._sub = null; this.render(); });
    this.body.querySelectorAll('.bag-sub').forEach(t =>
      t.onclick = () => { this._sub = t.dataset.sub || null; this.render(); });

    // 格子区：只显示当前视图物品（无物品给空态），整区可竖滚动（「无限」背包）
    const grid = this.body.querySelector('.bag-grid');
    if (!view.length) {
      grid.innerHTML = '<div class="bag-empty">暂无物品</div>';
    } else {
      for (const it of view) {
        const gi = it.gi;
        const cell = document.createElement('div');
        cell.className = 'bag-cell';
        cell.dataset.gi = gi;
        const remain = fmtSlotRemain(it.slot);   // F3② 限时物品倒计时（非限时返回 ''）
        cell.innerHTML = `
          ${iconImg(itemIconSrcs(it.def), 'bag-ic')}
          ${it.slot.count > 1 ? `<div class="bag-count">${it.slot.count}</div>` : ''}
          ${remain ? `<div class="bag-timer">${remain}</div>` : ''}
          ${gi === this._sel ? '<div class="bag-sel"></div>' : ''}`;
        cell.onmouseenter = () => showItemTip(it.def, p, cell);
        cell.onmouseleave = hideItemTip;
        // 对齐 AS3：mousedown 抓取物品 → 跟随光标 → 落到装备格即穿戴（从背包移除）；未拖动则按点击选中
        wireItemDrag(cell, it.def, 'bag', { ui: this.ui, bagIndex: gi }, () => { this._sel = gi; this.render(); });
        // 右键 = 使用物品（对齐 AS3 右键用物品）：preventDefault 抑制原生菜单；stopPropagation 阻止全局收口（render 会脱离文档，若仅靠 defaultPrevented 拦截，非可取消事件/监听器异常都会让 target 被误判为「游戏区空白」而关面板）。
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          hideItemTip();
          this._sel = gi; this.render();        // 选中该格（按钮栏同步启用）
          this._actUse(items);                  // 使用：装备→穿戴；可右键使用类→原子效果
        });
        grid.appendChild(cell);
      }
    }
    wireIconFallback(grid);

    // 动作栏（对齐 AS3 buttonHandler：BUTTON_USE / BUTTON_DROP / text_panel_zhengli 整理）
    const useBtn = this.body.querySelector('#bag-use');
    const dropBtn = this.body.querySelector('#bag-drop');
    const tidyBtn = this.body.querySelector('#bag-tidy');
    useBtn.onclick = () => this._actUse(items);
    dropBtn.onclick = () => this._actDrop(items, p);
    // 整理（按六大类→子类顺序聚合；配置缺失时回退旧的 typeGroup 排序）
    tidyBtn.onclick = () => this._actTidy();
  }
  // 整理：分类配置在 → 按大类顺序→子类顺序→type→id 聚合；否则回退旧的 equip/usable/material 分组排序
  _actTidy() {
    const bag = this.ui.player.bag || [];
    const map = Config.items || {};
    if (categoriesReady()) {
      const cats = (Config.item_categories && Config.item_categories.categories) || [];
      const catIdx = {}, subIdx = {};
      cats.forEach((c, ci) => { catIdx[c.key] = ci; (c.subTypes || []).forEach((s, si) => { subIdx[c.key + ':' + s.key] = si; }); });
      const key = (id) => {
        const def = map[id];
        const cl = def ? classifyItem(def) : null;
        if (!cl || cl.cat === 'other') return [98, 98];
        return [catIdx[cl.cat] ?? 98, cl.sub != null ? (subIdx[cl.cat + ':' + cl.sub] ?? 98) : 98];
      };
      bag.sort((a, b) => {
        const ka = key(a.itemId), kb = key(b.itemId);
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        if (ka[1] !== kb[1]) return ka[1] - kb[1];
        const ta = Number((map[a.itemId] || {}).type) || 0, tb = Number((map[b.itemId] || {}).type) || 0;
        if (ta !== tb) return ta - tb;
        return a.itemId - b.itemId;
      });
    } else {
      const grp = { equip: 0, usable: 1, material: 2, unknown: 3 };
      bag.sort((a, b) => {
        const ta = (map[a.itemId] || {}).type, tb = (map[b.itemId] || {}).type;
        const ra = grp[typeGroup(ta)] ?? 3, rb = grp[typeGroup(tb)] ?? 3;
        if (ra !== rb) return ra - rb;
        const na = Number(ta) || 0, nb = Number(tb) || 0;
        if (na !== nb) return na - nb;
        return a.itemId - b.itemId;
      });
    }
    this._sel = -1; this.render(); if (this.ui.refresh) this.ui.refresh();
    this.ui.toast('已整理背包');
  }
  /** 稠密背包索引(p.bag) → 契约稀疏索引(save.inventory)：第 N 个非空格 */
  _contractSlot(denseIdx) {
    const b = booted();
    if (!b || !b.save) return -1;
    const inv = b.save.inventory || [];
    let seen = 0;
    for (let i = 0; i < inv.length; i++) {
      if (inv[i] !== null) {
        if (seen === denseIdx) return i;
        seen++;
      }
    }
    return -1;
  }

  // 使用：装备类(0~13 已确证)→按 type 推导目标槽穿戴；可右键使用类→走契约 useItem（原子效果）；其余不支持（不臆造）
  _actUse(items) {
    const it = this._sel >= 0 ? items[this._sel] : null;
    if (!it) return;
    const def = it.def;
    const b = booted();
    const t = Number(def.type);

    if (isEquipType(t)) {
      // 目标槽由 type 推导（手镯/戒指/首饰 优先空位），而非硬编码 武器/衣服
      const key = defaultSlotKeyForItem(def.id, b && b.save);
      if (!key) { this.ui.toast('找不到对应装备槽'); return; }
      equipWear(this.ui, key, def.id, true);          // 内部会重渲染本面板
      return;
    }

    if (b && b.inv) {
      const ci = this._contractSlot(it.gi);          // 稠密索引 → 契约稀疏索引
      if (ci < 0) { this.ui.toast('背包数据不同步，请整理后重试'); return; }
      const r = b.inv.useItem(ci, { player: this.ui.player });   // 契约权威：执行原子效果并扣减
      if (r.ok && r.kind === 'consume') {
        commit('bagUse');
        // 效果明细：回血/回蓝/寿命的具体数值
        const d = (r.detail || []).filter((x) => x.ok).map((x) => {
          if (x.type === 'heal_life') return `寿命 +${x.gained}（${x.cur}/${x.max}）`;
          if (x.gained > 0) return `${x.type === 'heal_mp' ? '法力' : '生命'} +${x.gained}`;
          return null;
        }).filter(Boolean).join('，');
        this.ui.toast('已使用「' + def.name + '」' + (d ? '（' + d + '）' : ''));
      } else if (r.reason === 'expired') {
        this.ui.toast('「' + def.name + '」已过期并移除');
      } else if (r.reason === 'effect-not-configured') {
        this.ui.toast('「' + def.name + '」使用效果尚未配置（见 item_effects.json 的 _pending），未扣减');
      } else if (r.reason === 'no-target') {
        this.ui.toast('「' + def.name + '」找不到作用目标（宠物未选中/角色不存在）');
      } else {
        this.ui.toast('该物品暂不支持使用');
      }
      this.render(); if (this.ui.refresh) this.ui.refresh();
      return;
    }

    this.ui.toast('该物品暂不支持使用');
  }
  // 丢弃：单机版直接移除该格物品（对齐 BUTTON_DROP 的丢弃语义；无服务器故本地移除）
  _actDrop(items, p) {
    const it = this._sel >= 0 ? items[this._sel] : null;
    if (!it) return;
    const b = booted();
    if (b && b.inv) {
      const ci = this._contractSlot(it.gi);               // 稠密索引 → 契约稀疏索引
      if (ci >= 0) b.inv.removeItem(ci, it.slot.count);      // 整格丢弃（含堆叠数量）
      commit('bagDrop');
    } else if (this._sel < (p.bag || []).length) {
      p.bag.splice(this._sel, 1);
    }
    this._sel = -1;
    this.render(); if (this.ui.refresh) this.ui.refresh();
  }
}

// ───────────────────────── 技能面板（对齐 panel/skill/PlayerSkillPanel2）─────────────────────────
// 结构（对齐 AS3 PlayerSkillPanel2.initTab 的 createTab 0~6）：
//   顶部 7 个功能分页：战斗(0)/生活(1)/被动(2)/特殊(3)/天赋(4)/转换(5)/升级(6)；
//   「战斗」页内左侧为 8 心法导航(ViewFightSkill + SkillButtonNav)，右侧该心法技能列表 + 心法标题图；
//   底部两项说明：心法说明(descInput，对应 showGoodAt/心法描述) + 技能经验(expInput，对应 updateSkillExp)。
// 战斗态：对齐 AS3 openForBattle —— 禁用 被动(2)/特殊(3) 并强制切回 战斗(0)。
// 转换/升级 的标签图(textpanelviewtransfer.png / textpanelshengji.png)资源缺失，按 onerror 回退中文文字。
const SKILL_TABS = [
  { key: 'fight',    label: '战斗', img: 'textpanelskillviewfight.png' },
  { key: 'life',     label: '生活', img: 'textpanelskillviewlife.png' },
  { key: 'passive',  label: '被动', img: 'textpanelskillviewpassive.png' },
  { key: 'special',  label: '特殊', img: 'textpanelskillviewspecial.png' },
  { key: 'talent',   label: '天赋', img: 'textpaneltalent.png' },
  { key: 'transfer', label: '转换', img: 'textpanelviewtransfer.png' },
  { key: 'shengji',  label: '升级', img: 'textpanelshengji.png' },
];
// 8 心法：顺序严格对齐 AS3 ViewFightSkill.initSkillButsData
//   (brave→diligency→confident→penetrate→kind→confuse→mercy→pity)，
//   该顺序决定职业默认下标 XIA_KE=0(侠→英勇)/CI_KE=2(刺→自信)/SHU_SHI=4(术→热诚)/XIU_ZHEN=6(修→慈悲)。
// desc 为官方心法说明（用户提供的 8 系设定，含各系加强的技能）。
const XINFA = [
  { key: 'brave',     label: '英勇', ic: 'panelheartbrave.png',     title: 'textpanelskilltitlebrave.png',
    desc: '此系心法注重大幅提升人物的攻击力（加强 破釜沉舟、六脉神剑、伏魔刀法）' },
  { key: 'diligency', label: '坚韧', ic: 'panelheartdiligency.png', title: 'textpanelskilltitledeligency.png',
    desc: '此系心法注重提升人物的防御力（加强 冷嘲热讽、一朝归元、君临天下）' },
  { key: 'confident', label: '自信', ic: 'panelheartconfident.png', title: 'textpanelskilltitleconfident.png',
    desc: '此系心法注重提升人物攻击时的暴击率（加强 暗影迷踪拳、千蛛万毒手、化功绵掌）' },
  { key: 'penetrate', label: '洞察', ic: 'panelheartpenetrate.png', title: 'textpanelskilltitlepenetrate.png',
    desc: '此系心法注重提升人物的命中率（加强 疾影袭心、飞花溅玉、八荒六合）' },
  { key: 'kind',      label: '热诚', ic: 'panelheartkind.png',      title: 'textpanelskilltitlekind.png',
    desc: '此系心法注重提升人物的法术伤害（加强 四相诀、恸地神咒、唤灭破）' },
  { key: 'confuse',   label: '迷惑', ic: 'panelheartconfuse.png',   title: 'textpanelskilltitleconfuse.png',
    desc: '此系心法注重提升人物控制法术的效果（加强 摄魂咒、魅惑术、暗影魔咒）' },
  { key: 'mercy',     label: '慈悲', ic: 'panelheartmercy.png',     title: 'textpanelskilltitlemercy.png',
    desc: '此系心法注重人物治疗法术效果（加强 慈悲咒、沉水润心、仙音化雨）' },
  { key: 'pity',      label: '怜悯', ic: 'panelheartpity.png',      title: 'textpanelskilltitlepity.png',
    desc: '此系心法注重提升人物法力值上限（加强 天地极乐、圣灵附体、昊天罡气）' },
];
export class SkillPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-skill', title: '技能', width: 560, height: 470, ui });
    this._tab = 'fight';                                   // 对齐 AS3 initTab：默认选中 0 号(战斗)
    this._xinfa = SkillPanel.defaultXinfaForProf(ui && ui.player && ui.player.profession);
  }
  // 职业 → 默认心法（对齐 AS3 ViewFightSkill 常量 XIA_KE=0/CI_KE=2/SHU_SHI=4/XIU_ZHEN=6）
  static defaultXinfaForProf(prof) {
    if (!prof) return 'brave';
    if (prof.includes('刺')) return 'confident';
    if (prof.includes('术')) return 'kind';
    if (prof.includes('修') || prof.includes('绣')) return 'mercy';
    return 'brave';
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    const skillsMap = (Config && Config.data && Config.data.skills) || {};
    // 战斗态判定：当前场景为 BattleScene
    const inBattle = !!(this.ui.sm && this.ui.sm.current && this.ui.sm.current.constructor.name === 'BattleScene');
    // 对齐 AS3 openForBattle：战斗态禁用 被动(2)/特殊(3) 并强制切回 战斗(0)
    let tab = (this._tab || 'fight');
    if (inBattle && (tab === 'passive' || tab === 'special')) tab = 'fight';
    const isOff = k => inBattle && (k === 'passive' || k === 'special');
    // 玩家已学技能（严格读 Fighter.skills，经 Config.data.skills 解析；缺失 id 静默过滤）
    const all = (p && p.skills ? p.skills : []).map(id => skillsMap[String(id)]).filter(Boolean);

    this.setContent(`
      <div class="sk2-tabs"></div>
      <div class="sk2-body"></div>`);

    const tabsEl = this.body.querySelector('.sk2-tabs');
    SKILL_TABS.forEach(t => {
      const b = document.createElement('button');
      const off = isOff(t.key);
      b.className = 'sk2-tab' + (t.key === tab ? ' on' : '') + (off ? ' disabled' : '');
      // 标签用真实 text_panel_skill_view* 图；图缺失(转换/升级)由 onerror 回退中文文字
      b.innerHTML = `<img class="sk2-tab-ic" src="${url.res(t.img)}" alt="${esc(t.label)}" onerror="this.outerHTML='${t.label}'"/>`;
      if (off) b.title = '战斗态下不可用';
      else b.onclick = () => { this._tab = t.key; this.render(); };
      tabsEl.appendChild(b);
    });

    const body = this.body.querySelector('.sk2-body');
    // 生活/被动/特殊/天赋/转换/升级：单机版无对应数据源，给空态提示（不臆造数据）
    if (tab !== 'fight') {
      const t = SKILL_TABS.find(x => x.key === tab) || SKILL_TABS[0];
      body.innerHTML = `<div class="empty-tip">单机版：「${esc(t.label)}」暂无数据（该页数据由服务器下发，单机版未内置）</div>`;
      return;
    }
    if (!all.length) {
      body.innerHTML = '<div class="empty-tip">尚未习得技能</div>';
      return;
    }
    // 按技能真实 xinfa 分桶（对齐 AS3 ViewFightSkill.updateSkillList 按 subType 分桶）
    const bucket = {};
    XINFA.forEach(x => { bucket[x.key] = []; });
    all.forEach(s => {
      const k = s.xinfa || 'brave';
      (bucket[k] = bucket[k] || []).push(s);
    });
    const xf = XINFA.some(x => x.key === this._xinfa) ? this._xinfa : SkillPanel.defaultXinfaForProf(p && p.profession);
    const xdef = XINFA.find(x => x.key === xf) || XINFA[0];
    // 职业擅长（对齐 AS3 showGoodAt：goodAtDic 按职业取擅长心法文案）
    const prof = p ? p.profession : '';
    const goodLabel = (XINFA.find(x => x.key === SkillPanel.defaultXinfaForProf(prof)) || XINFA[0]).label;
    const goodAt = prof ? `${prof} · 擅长${goodLabel}心法` : '（未设置职业）';

    body.innerHTML = `
      <div class="sk2-fight">
        <div class="sk2-nav"></div>
        <div class="sk2-main">
          <div class="sk2-title">
            <img class="sk2-title-ic" src="${url.res(xdef.title)}" alt="${esc(xdef.label)}" onerror="this.replaceWith(document.createTextNode('${xdef.label}'))"/>
            <span class="sk2-count">${(bucket[xf] || []).length} 个技能</span>
          </div>
          <div class="sk2-list"></div>
        </div>
      </div>
      <div class="sk2-foot">
        <div class="sk2-desc"><b>${esc(xdef.label)}心法：</b>${esc(xdef.desc)}</div>
        <div class="sk2-exp">职业擅长：<b>${esc(goodAt)}</b> · 技能经验：—</div>
      </div>`;

    const nav = body.querySelector('.sk2-nav');
    XINFA.forEach(x => {
      const b = document.createElement('button');
      const n = (bucket[x.key] || []).length;
      b.className = 'sk2-nav-btn' + (x.key === xf ? ' on' : '') + (n ? '' : ' empty');
      b.title = `${x.label}（${n}）\n${x.desc}`;
      b.innerHTML = `<img class="sk2-nav-ic" src="${url.res(x.ic)}" alt="${esc(x.label)}" onerror="this.outerHTML='${x.label}'"/>`;
      b.onclick = () => { this._xinfa = x.key; this.render(); };
      nav.appendChild(b);
    });

    const list = body.querySelector('.sk2-list');
    const items = bucket[xf] || [];
    if (!items.length) {
      list.innerHTML = `<div class="empty-tip">「${esc(xdef.label)}」心法暂无已学技能</div>`;
      return;
    }
    items.forEach(s => {
      const row = document.createElement('div');
      row.className = 'sk2-row';
      // 熟练度进度条：对齐 AS3 Skill2Sprite.updateSkillExp(value,value2) → progressBar.setProgress(value,value2)
      //   + subLevelExpText = "value/value2"。原版 value=profCurr/profMax 由服务器下发的熟练度经验。
      //   单机版无该数据源，改用真实存在的「技能当前等级 / 最大等级」填充（不臆造经验数值）：
      //     当前 = Fighter.skillLevel(skillId)（优先 player.skillLevels[id]，缺省回退单位等级）
      //     上限 = Config.data.skillLevels[id].maxLevel || skills.json 的 maxLevel || 10
      const slv = (Config.data && Config.data.skillLevels) ? Config.data.skillLevels[s.id] : null;
      const maxLv = (slv && slv.maxLevel) || s.maxLevel || 10;
      const curLv = Math.max(1, Math.min(maxLv, (p && p.skillLevel) ? p.skillLevel(s.id) : 1));
      const pct = Math.max(0, Math.min(100, Math.round(curLv / maxLv * 100)));
      row.innerHTML = `
        ${imgWithFallback(url.icon('skill', s.icon), 'sk2-ic')}
        <div class="sk2-meta">
          <div class="sk2-name">${esc(s.name)}<span class="sk2-lv">Lv.${curLv}</span><span class="sk2-mp">耗蓝 ${s.mpCost != null ? s.mpCost : 0}</span></div>
          <div class="sk2-bar" title="技能等级 ${curLv}/${maxLv}">
            <div class="sk2-bar-face" style="width:${pct}%;background-image:url('${url.res('statecollectprogressbar.png')}')"></div>
            <span class="sk2-bar-tx">${curLv}/${maxLv}</span>
          </div>
        </div>`;
      // 悬停【图标】→ 悬浮窗展示技能描述（对齐 AS3 Skill2Sprite.onMouseOver/onMouseOut 挂在图标上）
      const ic = row.querySelector('.sk2-ic');
      if (ic) {
        ic.onmouseenter = () => showSkillTip(s, ic);
        ic.onmouseleave = hideSkillTip;
      }
      list.appendChild(row);
    });
  }
}

// ───────────────────────── 任务面板（对齐 task/TaskListPanel：双标签树 + DescTaskPanel 详情）─────────────────────────
export class QuestPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-quest', title: '任务', width: 540, height: 440, ui });
    this._tab = 'receipt';   // receipt=已接任务 / npc=任务NPC列表
    this._sel = null;
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  // 任务追踪条点击跳转：定位到指定任务并刷新详情（对齐 AS3 TaskListPanel.setSelectedTask）
  focusQuest(id) { this._sel = id; this._tab = 'receipt'; this.render(); }
  render() {
    const qs = this.ui._questState || [];
    const defs = Config.quests || {};
    const tab = this._tab || 'receipt';   // 构造期 init() 会先于 this._tab 赋值就调用 render，需兜底默认标签
    this.setContent(`
      <div class="quest-tabs">
        <button class="quest-tab ${tab==='receipt'?'on':''}" data-t="receipt"><img class="quest-tab-ic" src="${url.res('textpanelreceipttask.png')}" alt="已接任务" onerror="this.outerHTML='已接任务'"/></button>
        <button class="quest-tab ${tab==='npc'?'on':''}" data-t="npc"><img class="quest-tab-ic" src="${url.res('textpaneltasknpclist.png')}" alt="任务NPC列表" onerror="this.outerHTML='任务NPC列表'"/></button>
        <span class="quest-extra">
          <button class="pb-btn ghost" id="q-giveup"><img class="quest-btn-ic" src="${url.res('textpaneldeletemission.png')}" alt="放弃任务" onerror="this.outerHTML='放弃任务'"/></button>
          <button class="pb-btn ghost" id="q-daily"><img class="quest-btn-ic" src="${url.res('textpaneldaymission.png')}" alt="每日任务" onerror="this.outerHTML='每日任务'"/></button>
          <button class="pb-btn ghost" id="q-act"><img class="quest-btn-ic" src="${url.res('textpanelactives.png')}" alt="活动" onerror="this.outerHTML='活动'"/></button>
        </span>
      </div>
      <div class="quest-split">
        <div class="quest-tree"></div>
        <div class="quest-detail"></div>
      </div>`);
    this.body.querySelectorAll('.quest-tab').forEach(b =>
      b.onclick = () => { this._tab = b.dataset.t; this._sel = null; this.render(); });
    const giveup = this.body.querySelector('#q-giveup');
    if (giveup) giveup.onclick = () => {
      if (this._sel) { this.ui.giveupQuest ? this.ui.giveupQuest(this._sel) : this.ui.toast('单机版：放弃任务'); }
      else this.ui.toast('请先在左侧选择一个任务');
      this.render();
    };
    const daily = this.body.querySelector('#q-daily');
    if (daily) daily.onclick = () => this.ui.toast('单机版：打开每日任务（演示）');
    const act = this.body.querySelector('#q-act');
    if (act) act.onclick = () => this.ui.toast('单机版：打开活动中心（演示）');
    const tree = this.body.querySelector('.quest-tree');
    const detail = this.body.querySelector('.quest-detail');
    const list = tab === 'receipt'
      ? qs.filter(q => q.accepted && !q.done)
      : Object.values(defs);
    if (!list.length) { tree.innerHTML = '<div class="empty-tip">暂无任务</div>'; detail.innerHTML = ''; return; }
    list.forEach(q => {
      const def = defs[q.id]
        || ((Config.talk && Config.talk.data) ? (Config.talk.data.tasks || []).find((t) => String(t.taskId) === String(q.id)) : null)
        || {};
      const node = document.createElement('div');
      node.className = 'quest-node' + (this._sel === q.id ? ' on' : '');
      const prog = q.accepted ? `${q.progress}/${q.target}` : '未接';
      node.innerHTML = `<span class="qn-name">${q.name}</span><span class="qn-prog">${prog}</span>`;
      node.onclick = () => { this._sel = q.id; this._showDetail(detail, q, def); tree.querySelectorAll('.quest-node').forEach(n=>n.classList.remove('on')); node.classList.add('on'); };
      tree.appendChild(node);
    });
    if (this._sel) {
      const q = qs.find(x => x.id === this._sel) || Object.values(defs).find(x => x.id === this._sel);
      if (q) this._showDetail(detail, q, defs[q.id]
        || ((Config.talk && Config.talk.data) ? (Config.talk.data.tasks || []).find((t) => String(t.taskId) === String(q.id)) : null)
        || {});
    }
  }
  _showDetail(detail, q, def) {
    const status = q.accepted ? (q.done ? '已完成' : `进行中 ${q.progress}/${q.target}`) : '未接取';
    // 奖励：对齐 AS3 DescTaskPanel/BonusSprite（物品+经验+金币），仅展示真实存在的字段，不臆造
    const rw = def.reward || {};
    const rwParts = [];
    if (rw.exp != null) rwParts.push(rw.exp + ' 经验');
    if (rw.silver != null) rwParts.push(rw.silver + ' 银子');
    if (rw.item != null) {
      const itemDef = (Config.items || {})[rw.item];
      rwParts.push('物品：' + (itemDef ? itemDef.name : ('#' + rw.item)));
    }
    const rewardText = rwParts.length ? rwParts.join(' / ') : '—';
    // 发布 NPC（def.giver）对齐 AS3 DescTaskPanel 的 finishNpc/接取 NPC 展示；无则隐藏不臆造
    detail.innerHTML = `
      <div class="qd-name">${q.name}</div>
      <div class="qd-status">[${status}]</div>
      <div class="qd-desc">${def.desc || q.desc || ''}</div>
      ${def.giver ? `<div class="qd-giver">发布 NPC：${esc(def.giver)}</div>` : ''}
      <div class="qd-reward">奖励：${rewardText}</div>
      <div class="qd-acts"></div>`;
    const acts = detail.querySelector('.qd-acts');
    if (!q.accepted && !q.done) {
      const b = document.createElement('button'); b.className = 'pb-btn'; b.textContent = '接取';
      b.onclick = () => { this.ui.acceptQuest && this.ui.acceptQuest(q.id); this.render(); }; acts.appendChild(b);
    } else if (q.accepted && !q.done && q.progress >= q.target) {
      const b = document.createElement('button'); b.className = 'pb-btn'; b.textContent = '提交';
      b.onclick = () => { this.ui.submitQuest && this.ui.submitQuest(q.id); this.render(); }; acts.appendChild(b);
    }
    if (q.accepted && !q.done) {
      const b = document.createElement('button'); b.className = 'pb-btn ghost';
      b.innerHTML = `<img class="quest-btn-ic" src="${url.res('textpaneldeletemission.png')}" alt="放弃" onerror="this.outerHTML='放弃'"/>`;
      b.onclick = () => { this.ui.giveupQuest ? this.ui.giveupQuest(q.id) : this.ui.toast('单机版：放弃任务'); this.render(); }; acts.appendChild(b);
    }
  }
}

// ───────────────────────── 调试面板（对齐 debug/DebugPanel：运行期字段）─────────────────────────
// AS3：addChild fpsField/mouseField/netStateField/isDebugField/garbageField/reLoginField/chatTest
export class DebugPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-debug', title: '调试面板', width: 560, height: 480, ui, draggable: true });
    this._raf = 0; this._frames = 0; this._last = performance.now(); this._fps = 0;
    // 对齐 AS3 DebugPanel：isRightClickClose = true（右键关闭面板）
    if (this.dom) this.dom.addEventListener('contextmenu', (e) => { e.preventDefault(); this.close(); });
  }
  init() { this.render(); this._startMonitor(); }
  onOpen() { this.render(); this._startMonitor(); }
  onClose() { this._stopMonitor(); }
  _startMonitor() {
    this._stopMonitor();
    const tick = (now) => {
      this._frames++;
      if (now - this._last >= 500) { this._fps = Math.round(this._frames * 1000 / (now - this._last)); this._frames = 0; this._last = now; this._paint(); }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    window.addEventListener('mousemove', this._mm = (e) => { this._mx = e.clientX; this._my = e.clientY; });
  }
  _stopMonitor() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; if (this._mm) window.removeEventListener('mousemove', this._mm); }
  _paint() {
    const el = this.body && this.body.querySelector('.dbg-fps');
    if (el) el.textContent = this._fps;
    const mx = this.body && this.body.querySelector('.dbg-mouse');
    if (mx) mx.textContent = `${this._mx||0}, ${this._my||0}`;
  }
  render() {
    const sm = this.ui.sm;
    const pm = window.__panelManager;
    this.setContent(`
      <div class="dbg-runtime">
        <div class="dbg-field"><span>FPS</span><b class="dbg-fps">—</b></div>
        <div class="dbg-field"><span>鼠标</span><b class="dbg-mouse">0, 0</b></div>
        <div class="dbg-field"><span>网络</span><b>单机 mock（在线）</b></div>
        <div class="dbg-field"><span>调试开关</span>
          <button class="dbg-toggle ${window.__debug ? 'on' : ''}" id="dbg-toggle" type="button">
            <i class="dbg-knob"></i><span class="dbg-toggle-txt">${window.__debug ? '开' : '关'}</span>
          </button>
        </div>
        <div class="dbg-field"><span>GC</span><b>${performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576)+'MB' : 'n/a'}</b></div>
        <div class="dbg-field"><span>重登</span><button class="pb-btn ghost" id="dbg-relog">重登</button></div>
        <div class="dbg-field"><span>聊天测试</span><button class="pb-btn ghost" id="dbg-chat">发送</button></div>
      </div>
      <div class="dbg-section"><div class="dbg-h">游戏面板（已实现）</div><div class="dbg-grid" id="dbg-core"></div></div>
      <div class="dbg-section"><div class="dbg-h">AS3 面板全集（占位浏览 · ${PANEL_CATALOG.length} 个）</div><div class="dbg-catalog" id="dbg-cat"></div></div>`);
    const relog = this.body.querySelector('#dbg-relog');
    if (relog) relog.onclick = () => this.ui.toast('单机版：重新登录（演示）');
    const chat = this.body.querySelector('#dbg-chat');
    if (chat) chat.onclick = () => this.ui.toast('单机版：聊天测试（演示）');
    const tog = this.body.querySelector('#dbg-toggle');
    if (tog) tog.onclick = () => {
      const on = !window.__debug;
      this.ui.setDebug(on);             // 切换 window.__debug + 启停常驻 DEBUG 浮标
      tog.classList.toggle('on', on);
      const txt = tog.querySelector('.dbg-toggle-txt'); if (txt) txt.textContent = on ? '开' : '关';
    };
    const core = this.body.querySelector('#dbg-core');
    ['bag','skill','quest','debug','shop','warehouse','forge','itemfacture','pet','petadvance','ridepetadvance','talk','playerpanel','playerskillpanel','worldmap','bestiary','achv','settings','team','battlelog'].forEach(n => {
      const b = document.createElement('button'); b.className = 'pb-btn dbg-summon'; b.textContent = '召唤 ' + n;
      b.onclick = () => pm && pm.open(n); core.appendChild(b);
    });
    const cat = this.body.querySelector('#dbg-cat');
    PANEL_GROUPS.forEach(g => {
      const items = PANEL_CATALOG.filter(c => c.group === g);
      if (!items.length) return;
      const sec = document.createElement('div'); sec.className = 'catalog-group';
      sec.innerHTML = `<div class="catalog-ghead">${g}（${items.length}）</div>`;
      const grid = document.createElement('div'); grid.className = 'catalog-grid';
      items.forEach(c => {
        const b = document.createElement('button'); b.className = 'pb-btn cat-btn'; b.textContent = c.title; b.title = c.desc;
        b.onclick = () => pm && pm.open('as3_' + c.key);
        grid.appendChild(b);
      });
      sec.appendChild(grid); cat.appendChild(sec);
    });
    this._paint();
  }
}

// ───────────────────────── AS3 面板（其余 713 个面板类，渲染反编译结构视图）─────────────────────────
// 每个被召唤的面板都基于其 .as 反编译结果渲染真实结构：包/系统/继承链/职责/子视图/字段/方法/主要方法/依赖/协议，
// 数据域组(item/skill/task/map/monster/npc/raid/placard/tasktutor)额外叠加真实后台数据行。
// 面板 → face（UI 皮肤/浮层）匹配：face 里放着真实 UI 层，按 cls 根或 group 别名映射到对应 face 类
const FACE_ALIAS = {
  guild: 'GroupFace', chat: 'MessageFace',
  partner: 'PetFace', property: 'PlayerFace', player: 'PlayerFace',
  raid: 'RaidFace', prompt: 'PromptFace', map: 'CityFace', home: 'CityFace',
  battle: 'BattleListFace', skill: 'ActionFace', item: 'CommonInfoFace', vippanel: 'GiftFace',
  task: 'TaskFace', phone: 'PhoneFace',
};
function matchFace(m) {
  if (!FACE_BY_NAME) return null;
  const clsRoot = (m.cls || '').replace(/(List|View|Sprite|Panel|02)$/g, '').toLowerCase();
  if (FACE_BY_ROOT[clsRoot]) return FACE_BY_ROOT[clsRoot];
  const g = m.group || '';
  if (FACE_ALIAS[g]) return FACE_ALIAS[g];
  for (const k of [m.cls, m.title]) {
    if (k && FACE_BY_NAME[k]) return k;
    if (k && FACE_BY_NAME[k + 'Face']) return k + 'Face';
  }
  return null;
}

// 由按钮字段名模糊匹配其触发的动作方法（与 gen_panel_catalog.mjs 的判定保持一致）
function matchAction(fieldName, actions) {
  if (!actions || !actions.length) return '';
  const base = String(fieldName || '').replace(/^(btn|btm|button|ibtn)/i, '').replace(/(btn|button|btm)$/i, '').toLowerCase();
  if (!base) return actions[0];
  const hit = actions.find(a => a.toLowerCase().includes(base));
  if (hit) return hit;
  const hit2 = actions.find(a => a.toLowerCase().replace(/^(on|do|handle)/, '') === base);
  if (hit2) return hit2;
  return '';
}

const DATA_DOMAINS = {
  item:     { src: () => Config.items,   label: '道具' },
  skill:    { src: () => Config.skills,  label: '技能' },
  task:     { src: () => Config.quests,  label: '任务' },
  tasktutor:{ src: () => Config.quests,  label: '任务教学' },
  map:      { src: () => Config.maps,    label: '地图' },
  raid:     { src: () => Config.monsters,label: '副本怪物' },
  monster:  { src: () => Config.monsters,label: '怪物' },
  npc:      { src: () => Config.npcs,    label: 'NPC' },
  placard:  { src: () => Config.npcs,    label: 'NPC / 公告' },
};

export class As3Panel extends BasePanel {
  constructor(ui, meta) {
    super({ id: 'panel-as3-' + meta.key, title: meta.title, width: 500, height: 470, ui });
    this.meta = meta;
    this._tab = 'overview';     // 当前标签页
    this._state = {};           // 表单字段当前值（编辑态）
    this._log = [];             // 操作日志
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    // 注意：BasePanel 构造函数在 super() 内会触发 init()→render()，
    // 而此时 this.meta 尚未在子类构造体里赋值（super() 返回后才赋值）。
    // 故构造期首渲染必须容忍 this.meta 为 undefined，真正的实数据渲染发生在 open()→onOpen()→render()。
    const m = this.meta;
    if (!m) { this.setContent('<div class="empty-tip">加载中…</div>'); return; }
    const grpLabel = (PANEL_GROUP_LABELS && PANEL_GROUP_LABELS[m.group]) || (PANEL_GROUP_LABELS && PANEL_GROUP_LABELS[m.group.toLowerCase()]) || m.group;
    const dom = DATA_DOMAINS[m.group];

    // 运行期数据预览（数据域组）
    let dataHtml = '';
    if (dom) {
      const src = dom.src() || {};
      const list = Array.isArray(src) ? src : Object.values(src);
      if (list.length) {
        const rows = list.slice(0, 50).map(d =>
          `<div class="as3-row"><b>${esc(d.name || d.id || '—')}</b><span>${esc(d.desc || d.title || '')}</span></div>`
        ).join('');
        const more = list.length > 50 ? `<div class="as3-row more">… 另有 ${list.length - 50} 条</div>` : '';
        dataHtml = `<div class="as3-sec"><div class="as3-sec-h">运行期数据预览 · ${dom.label}（${list.length}）</div><div class="as3-domain-list">${rows}${more}</div></div>`;
      } else {
        dataHtml = `<div class="as3-sec"><div class="as3-sec-h">运行期数据预览 · ${dom.label}</div><div class="as3-note">（暂无数据）</div></div>`;
      }
    }

    // 继承链
    const chain = (m.inherits && m.inherits.length) ? m.inherits.join(' → ') : (m.parent || '—');
    // 子视图
    const subHtml = (m.subviews && m.subviews.length)
      ? `<div class="as3-chips">${m.subviews.map(s => `<span class="as3-chip">${esc(s)}</span>`).join('')}</div>` : '';
    // 字段
    const fldHtml = (m.fields && m.fields.length)
      ? `<div class="as3-flds">${m.fields.slice(0, 40).map(f => `<div class="as3-fld"><span class="as3-fld-n">${esc(f.name)}</span><span class="as3-fld-t">:${esc(f.type)}</span></div>`).join('')}${m.fields.length > 40 ? `<div class="as3-more">… 另有 ${m.fields.length - 40} 个字段</div>` : ''}</div>` : '';
    // 方法（优先 public）
    const ms = (m.methods || []);
    const pub = ms.filter(x => x.vis === 'public');
    const showMs = (pub.length ? pub : ms).slice(0, 60);
    const mthHtml = showMs.length
      ? `<div class="as3-mths">${showMs.map(x => `<div class="as3-mth"><span class="as3-m-vis">${esc(x.vis)}</span> ${esc(x.name)}(<span class="as3-m-params">${esc(x.params || '')}</span>)${x.ret ? `<span class="as3-m-ret">:${esc(x.ret)}</span>` : ''}</div>`).join('')}${ms.length > 60 ? `<div class="as3-more">… 另有 ${ms.length - 60} 个方法</div>` : ''}</div>` : '';

    const extra = [];
    if (m.sys) extra.push(`<div class="as3-kv"><b>系统</b>${esc(m.sys)}</div>`);
    if (m.deps) extra.push(`<div class="as3-kv"><b>依赖</b>${esc(m.deps)}</div>`);
    if (m.proto) extra.push(`<div class="as3-kv"><b>协议</b>${esc(m.proto)}</div>`);

    // UI 皮肤(face)：面板对应的真实 UI 浮层/皮肤类（face 文件夹），展示其 UI 元素
    let faceHtml = '';
    const faceName = matchFace(m);
    const face = faceName ? (FACE_BY_NAME[faceName] || null) : null;
    if (face) {
      const fkv = [];
      if (face.size) fkv.push(`尺寸 <b>${face.size.w}×${face.size.h}</b>`);
      if (face.bg) fkv.push(`背景 <code>${esc(face.bg)}</code>`);
      fkv.push(`文本条 <b>${face.texts}</b>`);
      fkv.push(`交互 <b>${face.interactive ? '是' : '否'}</b>`);
      const resChips = (face.resources && face.resources.length)
        ? `<div class="as3-res-list">${face.resources.map(r => `<span class="as3-res">${esc(r)}</span>`).join('')}</div>` : '';
      faceHtml = `<div class="as3-sec as3-face"><div class="as3-sec-h">UI 皮肤（face · ${esc(face.title)}）</div>
        <div class="as3-face-kv">${fkv.map(p => `<span class="as3-kv-item">${p}</span>`).join('')}</div>
        ${resChips}
        ${face.desc ? `<div class="as3-note">${esc(face.desc)}</div>` : ''}</div>`;
    }

    // —— 可交互外壳：标签页 + 概览交互控件 + 子视图卡片 ——
    const tabs = [{ key: 'overview', label: '概览' }]
      .concat((m.subviews || []).slice(0, 9).map(s => ({ key: 'sub:' + s, label: humanize(s) })));
    const cur = this._tab || 'overview';
    const overview = cur === 'overview' ? this._overviewWidgets(m, dom) : '';
    const subContent = cur.startsWith('sub:') ? this._subviewContent(m, cur.slice(4), dom) : '';

    this.setContent(`
      <div class="as3-view">
        <div class="as3-head">
          <div class="as3-title">${esc(m.title)} <span class="as3-cls">${esc(m.cls || '')}</span></div>
          <div class="as3-tags"><span class="as3-tag">${esc(grpLabel)}</span><span class="as3-tag dim">${esc(m.group)}</span></div>
        </div>
        <div class="as3-pkg">包 <code>${esc(m.pkg)}</code> · 继承 <code>${esc(chain)}</code></div>
        <div class="as3-tabs">${tabs.map(t => `<button class="as3-tab${t.key === cur ? ' on' : ''}" data-act="tab:${esc(t.key)}">${esc(t.label)}</button>`).join('')}</div>
        <div class="as3-body">
          ${cur === 'overview' ? overview : subContent}
          <details class="as3-struct" open><summary>AS3 结构（反编译契约）</summary>
            <div class="as3-chain"><b>继承链</b> ${esc(chain)}</div>
            ${m.desc ? `<div class="as3-sec"><div class="as3-sec-h">职责</div><div class="as3-desc">${esc(m.desc)}</div></div>` : ''}
            ${faceHtml}
            ${dataHtml}
            ${m.subviews && m.subviews.length ? `<div class="as3-sec"><div class="as3-sec-h">子视图（${m.subviews.length}）</div>${subHtml}</div>` : ''}
            ${m.fields && m.fields.length ? `<div class="as3-sec"><div class="as3-sec-h">字段 / 属性（${Math.min(m.fields.length, 40)}${m.fields.length > 40 ? '+' : ''}）</div>${fldHtml}</div>` : ''}
            ${showMs.length ? `<div class="as3-sec"><div class="as3-sec-h">方法（${showMs.length}${ms.length > 60 ? '+' : ''}）</div>${mthHtml}</div>` : ''}
            ${m.methodsSummary ? `<div class="as3-sec"><div class="as3-sec-h">主要方法（AS3 契约）</div><div class="as3-note">${esc(m.methodsSummary)}</div></div>` : ''}
            ${extra.length ? `<div class="as3-extra">${extra.join('')}</div>` : ''}
            <div class="as3-src">源文件 <code>${esc(m.file)}</code></div>
          </details>
        </div>
        <div class="as3-log"></div>
      </div>`);
    this._renderLog();
    this.bindEvents();
  }

  // 概览页：操作按钮 + 表单 + 列表 + 字段默认值（全部源于 AS3 源码、可交互、无随机）
  _overviewWidgets(m, dom) {
    // 按钮：button 字段 → 关联真实动作；其余动作方法补为按钮（handler 即真实方法名）
    const btns = [];
    (m.fields || []).filter(f => f.role === 'button').slice(0, 8).forEach(f => {
      btns.push({ label: humanize(f.name), field: f.name, handler: matchAction(f.name, m.actions || []) });
    });
    (m.actions || []).forEach(a => {
      if (btns.length >= 12) return;
      if (btns.some(b => b.handler === a)) return;
      btns.push({ label: humanize(a), field: '', handler: a });
    });
    const btnHtml = btns.length
      ? `<div class="as3-sec"><div class="as3-sec-h">操作（AS3 动作方法）</div><div class="as3-actions">${btns.map(b => `<button class="as3-btn" data-act="btn:${esc(b.field)}:${esc(b.handler)}">${esc(b.label)}</button>`).join('')}</div></div>`
      : '';

    // 表单：text/check/slider/select 可编辑，默认值来自 AS3 源码 def
    const formF = (m.fields || []).filter(f => ['text', 'check', 'slider', 'select'].includes(f.role)).slice(0, 10);
    let formHtml = '';
    if (formF.length) {
      formHtml = `<div class="as3-sec"><div class="as3-sec-h">表单（字段默认值来自 AS3 源码）</div><div class="as3-form">` + formF.map(f => {
        const v = (this._state[f.name] !== undefined) ? this._state[f.name] : defValue(f.role, f.type, f.def);
        this._state[f.name] = v;
        if (f.role === 'check') return `<label class="as3-fld-row"><input type="checkbox" data-field="${esc(f.name)}" ${v ? 'checked' : ''}/> <span>${esc(humanize(f.name))}</span></label>`;
        if (f.role === 'slider') return `<label class="as3-fld-row"><span class="as3-fld-n">${esc(humanize(f.name))}</span><input type="range" min="0" max="100" data-field="${esc(f.name)}" value="${v}"/><b class="as3-fval" data-fval="${esc(f.name)}">${v}</b></label>`;
        if (f.role === 'select') { const opts = selectOptions(m, f); return `<label class="as3-fld-row"><span class="as3-fld-n">${esc(humanize(f.name))}</span><select data-field="${esc(f.name)}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`; }
        const ph = (f.def != null && f.def !== '') ? ('placeholder="默认 ' + esc(String(f.def)) + '"') : '';
        return `<label class="as3-fld-row"><span class="as3-fld-n">${esc(humanize(f.name))}</span><input class="as3-input" data-field="${esc(f.name)}" value="${esc(String(v))}" ${ph}/></label>`;
      }).join('') + `</div></div>`;
    }

    // 列表：list 字段 → 真实 Config（数据域组）或 本面板真实元数据（非数据域）
    const listF = (m.fields || []).filter(f => f.role === 'list').slice(0, 4);
    let listHtml = listF.map(f => {
      const rows = mockRows(m, f.name, dom);
      return `<div class="as3-sec"><div class="as3-sec-h">列表 · ${esc(humanize(f.name))}（${rows.length}）</div><div class="as3-list">${rows.map(r => `<div class="as3-li"><b>${esc(r.name)}</b><span>${esc(r.desc || '')}</span></div>`).join('')}</div></div>`;
    }).join('');

    // 字段与默认值（AS3 源码）：忠实展示每个字段的名称/类型/默认值，无随机
    const defs = this._fieldDefaults(m).map(([k, v]) => `<div class="as3-row"><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('');
    const defsHtml = `<div class="as3-sec"><div class="as3-sec-h">字段与默认值（AS3 源码）</div><div class="as3-domain-list">${defs}</div></div>`;

    return btnHtml + formHtml + listHtml + defsHtml;
  }

  // 子视图卡片：展示该子视图在 AS3 源码中的真实关联元素（方法/字段），按钮绑定真实动作
  _subviewContent(m, subKey, dom) {
    const rows = mockRows(m, subKey, dom);
    const openAct = (m.actions || []).find(a => /open|enter|show|switch|tab/i.test(a)) || '';
    const openBtn = openAct
      ? `<button class="as3-btn" data-act="btn::${esc(openAct)}">打开 ${esc(humanize(subKey))}</button>`
      : `<button class="as3-btn" data-act="btn::open">打开 ${esc(humanize(subKey))}</button>`;
    return `<div class="as3-sec"><div class="as3-sec-h">子视图 · ${esc(humanize(subKey))}</div>
      <div class="as3-note">下列元素均来源于 AS3 源码（${esc(subKey)} 的方法 / 字段 / 子视图），单机版数据未建模处标注真实来源。</div>
      <div class="as3-actions">${openBtn}</div>
      <div class="as3-list">${rows.map(r => `<div class="as3-li"><b>${esc(r.name)}</b><span>${esc(r.desc || '')}</span></div>`).join('')}</div></div>`;
  }

  // 字段与默认值表（忠实源于 AS3 源码；无字段时列出真实元信息）
  _fieldDefaults(m) {
    const flds = (m.fields || []).slice(0, 12);
    if (flds.length) return flds.map(f => [f.name, (f.type || '') + (f.def != null && f.def !== '' ? ' = ' + f.def : '')]);
    return [
      ['类名', m.cls || '—'],
      ['分组', m.group],
      ['系统', m.sys || '—'],
      ['字段数', (m.fields || []).length],
      ['方法数', (m.methods || []).length],
      ['动作数', (m.actions || []).length],
    ];
  }

  // 操作日志渲染（不触发整体重渲染，保持输入框焦点）
  _renderLog() {
    const el = this.body && this.body.querySelector('.as3-log');
    if (!el) return;
    el.innerHTML = this._log.length
      ? `<div class="as3-sec-h">操作日志</div>` + this._log.map(l => `<div class="as3-log-line">${esc(l)}</div>`).join('')
      : '<div class="as3-log-empty">（点击面板按钮 / 修改表单以查看日志）</div>';
  }

  // 事件绑定：标签切换 / 按钮调用（展示真实方法签名）/ 表单实时修改
  bindEvents() {
    const root = this.body;
    const m = this.meta;
    if (!root) return;
    root.querySelectorAll('[data-act^="tab:"]').forEach(el => {
      el.onclick = () => { this._tab = el.getAttribute('data-act').slice(4); this.render(); };
    });
    root.querySelectorAll('[data-act^="btn:"]').forEach(el => {
      el.onclick = () => {
        const a = el.getAttribute('data-act').slice(4).split(':');
        const handler = a[1] || a[0];
        const label = el.textContent;
        const meth = (m.methods || []).find(x => x.name === handler);
        const sig = sigOf(meth) || (handler + '()');
        const msg = `点击「${label}」→ 调用 ${sig}`;
        this._log.unshift(msg); if (this._log.length > 8) this._log.pop();
        this._renderLog();
        if (this.ui && this.ui.toast) this.ui.toast(msg);
        el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 150);
      };
    });
    root.querySelectorAll('[data-field]').forEach(el => {
      const nm = el.getAttribute('data-field');
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(ev, () => {
        const v = el.type === 'checkbox' ? el.checked : el.value;
        this._state[nm] = v;
        const fv = root.querySelector(`[data-fval="${nm}"]`);
        if (fv) fv.textContent = v;
        const msg = `修改 ${nm} = ${v}`;
        this._log.unshift(msg); if (this._log.length > 8) this._log.pop();
        this._renderLog();
      });
    });
  }
}

// 把 deobfuscated/panel 下全部 AS3 面板类登记为可召唤面板（跳过 debug 组，已有重构版 DebugPanel 覆盖）
// ownerUI：传入 UI 实例（与 char/bag/skill/quest 同样持 ui 引用），便于面板读取 player / questState。
export function registerCatalog(panelManager, ownerUI) {
  PANEL_CATALOG.forEach(c => {
    if (c.group === 'debug') return; // 自定义 DebugPanel 已覆盖
    const key = 'as3_' + c.key;
    if (panelManager.factories[key]) return;
    panelManager.register(key, (/*ui*/) => new As3Panel(ownerUI, c));
  });
}
