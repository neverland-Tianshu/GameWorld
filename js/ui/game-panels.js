// game-panels.js
// 真实可交互的「游戏面板」（对齐原版玩家常用系统），背靠 Config / ui.player / ui 客户端状态。
// 与 As3Panel（反编译结构视图）不同：这里不展示任何 AS3 源码，只提供玩家真正能用的功能。
//
// 数据来源：
//   - Config.items / Config.monsters / Config.maps / Config.npcs / Config.quests 真实后台数据
//   - ui.player（登录后的 Fighter：silver/bag/skills/level…）
//   - ui 客户端状态：_warehouse 仓库 / _enhance 强化等级 / _pets 伙伴 / _team 队伍 /
//                     _battleLog 战报 / _killCount 击杀数 / _settings 设置 / _curMapId 当前地图
//   - ui.sm.defeated：已击败怪物集合（图鉴"已发现"判定）

import { url, absUrl, Config, persistConfig } from '../core/globals.js?v=20261007c';
import { BasePanel, panelManager } from './panel-manager.js?v=20261007c';
import { initAudio } from '../core/sound.js?v=20261007c';
import { customCursor } from './custom-cursor.js?v=20261007c';
import { MiniMapPanel } from './minimap-panel.js?v=20261007c';
import { ConfirmPanel } from './panel-confirm.js?v=20261007c';
import { copper, payCopper, gainCopper, moneyText, fmtCopper } from '../core/money.js?v=20261007c';
import { itemIconSrcs, iconImg, wireIconFallback, showItemTip, hideItemTip, showSkillTip, hideSkillTip } from './panels.js?v=20261007c';
import { Fighter } from '../entities/fighter.js?v=20261007c';   // 模型锚点开关：setShowOrigin 统一翻转所有 Fighter 的红十字标记

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function imgWithFallback(src, cls) {
  return `<img class="${cls || ''}" src="${src}" onerror="this.style.visibility='hidden'"/>`;
}
// 装备/道具效果文案
function statText(eff) {
  if (!eff) return '—';
  const parts = [];
  if (eff.atk) parts.push('攻+' + eff.atk);
  if (eff.def) parts.push('防+' + eff.def);
  if (eff.hp) parts.push('HP+' + eff.hp);
  if (eff.mp) parts.push('MP+' + eff.mp);
  if (eff.mag) parts.push('法+' + eff.mag);
  return parts.join(' ') || '—';
}

// ───────────────────────── 商店（买 / 卖，金币结算）─────────────────────────
// ───────────────────────── 商城（对齐 AS3 主商城 MallPanel02：多层级的商店）─────────────────────────
// 反编译依据：deobfuscated/panel/mall/MallPanel02.as（panelId=PANEL_MALL_ITEM）
//   一级页签(5)：高级(100)/中级(200)/银币(400)/积分(300)/时装(500)  →  text_panel_mall_senior_store…clothesshop
//   二级页签(8，每级通用)：热卖/玩家/宠物/制造/强化/玩家技能/宠物技能/活动 → text_panel_mall_hot_goods…
//   商品网格：非时装 3 列 / 时装 2 列（预创建 200 格虚拟化）；购买读对应货币(金/银/银票/积分)，活动页 buildActivityMall 否则 buildMall
//   按钮：购买 / 充值 / 神秘商店(BUTTON_MYSTERY_SHOP) / 随意购(BUTTON_RANDOMBUY) / 搜索(BUTTON_SEARCH)
//   时装页内嵌 ClothesContainer（角色模型 + 时尚值 + 达人等级 + 折扣进度条）→ 前往外观店打开 FaceShop(5 分类)
// 红线：商城商品由服务器下发（getData(bid,secondBid)→baleDict 缓存，对应 op 待逆向），故商品位为占位，绝不臆造道具名。
// ------------------------------------------------------------------
// 商城（MallPanel02 结构）：按货币分类的真实商店浏览器
//   ★ 数据口径：op305/SC_MALL_ACTIVITY 等商城协议【未抓到包】——原版商城商品由服务端按页签
//     动态下发（AS3 getData(bid,secondBid)→saleDict），无包不臆造。
//   ★ 但 op688 声望商店（徽章购物）与 op102 银币/金币商店有完整抓包：把真实数据按货币
//     分组呈现在本面板，玩家能浏览到全部 72 家店 / 2293 件商品（含骑宠洗髓丹、还童丹等）。
//   银币/金币商品可购买（走 money 两级扣款）；徽章/特殊货币游戏未实装，仅浏览并标注。
//   与 NpcShopPanel（NPC 绑定商店，260×430）的区别：本面板是全量商店浏览器，760×560。
// ------------------------------------------------------------------
// ── 商城（对齐 AS3 MallPanel02：一级页签 高级/中级/银币/积分/时装；二级页签 热销/玩家/宠物…）──
// 数据真源：config/mall.json（op136 SC_COUNTER_INFO 抓包，见 _work/gen_mall.cjs）。
//   抓包实证：8 份抓包文件里 op136 只有 1 个包 = 高级(100)/热销(6) 页签，123 件商品全部
//   currncy=12（金子，price 单位「文」，与 desc【价格】实证一致：price=101000 ↔ "101两金"）。
//   其余页签（中级200/银币400/积分300/时装500）未抓到包，面板内如实标注「未抓取」，绝不臆造。
//   与 NpcShopPanel（NPC 绑定商店，260×430，数据来自 config/shop.json）的区别：本面板是
//   AS3 PANEL_MALL_ITEM 主商城，商品位为占位、由服务端按页签下发（op136）。
const MALL_L1 = [
  { key: '100', label: '金币商店' },   // AS3 MALL_LABEL_FIR_SENIOR=100（高级）：已接入 op136 真实数据
  { key: '200', label: '银币商店' },   // AS3 MALL_LABEL_FIR_SECONDARY=200（中级）：未抓到包
  { key: '400', label: '银子商店' },   // AS3 MALL_LABEL_FIR_SILVER=400（银币）：未抓到包，待重抓
  { key: '300', label: '积分商店' },   // AS3 MALL_LABEL_FIR_INTEGRAL=300（积分）：未抓到包
  { key: '500', label: '时装商店' },   // AS3 MALL_LABEL_FIR_CLOTHES=500（时装）：服务端按页签下发，未抓到包
];
// AS3 二级页签常量（GlobalsGlobal08.as）：热销=6/玩家=10/宠物技能=12/玩家用=17/宠物用=18/强化=19/玩家技能=20/活动=21
const MALL_L2_LABEL = { 6: '热销', 10: '玩家', 12: '宠物技能', 17: '玩家用', 18: '宠物用', 19: '强化', 20: '玩家技能', 21: '活动' };
const MALL_PER_PAGE = 48;   // 6列×8行，与背包/NPC商店网格一致

export class ShopPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-shop', title: '商城', width: 760, height: 560, ui });
    this._l1 = '100';       // MALL_L1 key（一级页签）
    this._l2 = null;        // 二级页签 key（mallTabId）
    this._page = 0;
    this._sel = -1;         // 选中商品在当前二级页签内的全局 index
  }
  init() { this._initTab(); this.render(); }
  onOpen() { this._initTab(); this.render(); }
  _mall() { return Config.data.mall || {}; }
  _l1Data(k) { const t = this._mall().tabs; return t ? t[k] : null; }
  _l2Keys(k) { const d = this._l1Data(k); return d && d.sub ? Object.keys(d.sub) : []; }
  _initTab() {
    const ks = this._l2Keys(this._l1);
    this._l2 = ks.length ? ks[0] : null;
  }
  _items() {
    const d = this._l1Data(this._l1);
    if (!d || !d.sub || !this._l2) return [];
    return d.sub[this._l2].items || [];
  }
  render() {
    const p = this.ui.player;
    const l1 = this._l1Data(this._curL1);
    const l2Keys = this._l2Keys(this._curL1);
    if (!l1 || !l2Keys.length) {
      // 该页签无抓包数据：如实提示，不臆造商品
      const t = MALL_L1.find(x => x.key === this._curL1) || MALL_L1[0];
      this.setContent(
        '<div class="mall-wrap">' + this._l1Bar() +
        '<div class="mall-nodata">【' + esc(t.label) + '】<br>' +
        '该页签商品由服务端按页签下发（AS3 getData→sendViewCounter→op136），<br>' +
        '抓包内未覆盖此页签，暂无真实数据。<br>' +
        '<span>已接入的真实数据见「金币商店」（高级/热销，123 件金子商品）。</span></div></div>');
      this._wireL1();
      return;
    }
    if (!l2Keys.includes(this._l2)) this._l2 = l2Keys[0];
    const all = this._items();
    const pageItems = all.filter(it => Math.floor((it.index || 0) / MALL_PER_PAGE) === this._page);
    const nPages = Math.max(1, Math.ceil(all.length / MALL_PER_PAGE));
    const sel = this._sel >= 0 ? all[this._sel] : null;
    this.setContent(
      '<div class="mall-wrap">' + this._l1Bar() +
      '<div class="ml-body">' +
        '<div class="ml-shops" id="ml-l2">' + l2Keys.map(k =>
          '<button class="ml-shop ' + (String(k) === String(this._l2) ? 'on' : '') + '" data-k="' + k + '">' +
          esc(MALL_L2_LABEL[k] || ('页签' + k)) + ' <span class="ml-shop-n">' + (this._l1Data(this._curL1).sub[k].items || []).length + '</span></button>').join('') +
        '</div>' +
        '<div class="ml-main">' +
          '<div class="ns-tabs">' + Array.from({ length: nPages }, (_, i) =>
            '<button class="bag-tab ' + (i === this._page ? 'on' : '') + '" data-page="' + i + '">' +
            '<span class="bag-pageno">' + (i + 1) + '</span></button>').join('') +
            '<span class="ml-money">金子 <b>' + esc(moneyText(p, 'gold')) + '</b></span>' +
          '</div>' +
          '<div class="ns-grid"></div>' +
          '<div class="ml-bar"><button class="pb-btn ml-buy" ' + (sel ? '' : 'disabled') + '>购买</button></div>' +
          '<div class="ns-note">' + esc(this._noteFor(sel)) + '</div>' +
        '</div>' +
      '</div></div>');
    this.body.style.setProperty('--bag-cell-bg', 'url("' + absUrl(url.res('panelitembg.png')) + '")');
    this.body.style.setProperty('--bag-sel-bg', 'url("' + absUrl(url.res('panelitemselect.png')) + '")');
    const grid = this.body.querySelector('.ns-grid');
    for (let c = 0; c < MALL_PER_PAGE; c++) {
      const it = pageItems[c];
      const cell = document.createElement('div');
      cell.className = 'bag-cell ns-cell' + (it ? '' : ' empty');
      if (it) {
        cell.innerHTML = iconImg(itemIconSrcs(this._defOf(it)), 'bag-ic') +
          (all.indexOf(it) === this._sel ? '<div class="bag-sel"></div>' : '');
        cell.onmouseenter = () => showItemTip({ name: it.name, type: '金币商品', desc: it.desc || it.brief || '', effect: this._effectOf(it) }, p, cell);
        cell.onmouseleave = hideItemTip;
        cell.onclick = () => { this._sel = all.indexOf(it); this.render(); };
      }
      grid.appendChild(cell);
    }
    wireIconFallback(grid);
    this._wireL1();
    this.body.querySelectorAll('#ml-l2 .ml-shop').forEach(b => b.onclick = () => { this._l2 = b.dataset.k; this._page = 0; this._sel = -1; this.render(); });
    this.body.querySelectorAll('.bag-tab').forEach(t => t.onclick = () => { this._page = +t.dataset.page; this._sel = -1; this.render(); });
    const buy = this.body.querySelector('.ml-buy');
    if (buy) buy.onclick = () => this._buyFlow();
  }
  get _curL1() { return this._l1; }
  _l1Bar() {
    const counts = {};
    for (const t of MALL_L1) { const ks = this._l2Keys(t.key); counts[t.key] = ks.length ? this._l1Data(t.key).sub[ks[0]].items.length : 0; }
    return '<div class="mall-l1" id="mall-l1">' + MALL_L1.map(t =>
      '<button class="mall-tab ' + (t.key === this._curL1 ? 'on' : '') + '" data-k="' + t.key + '">' +
      esc(t.label) + (counts[t.key] ? ' <span class="ml-cnt">' + counts[t.key] + '</span>' : '') +
      '</button>').join('') + '</div>';
  }
  _wireL1() {
    this.body.querySelectorAll('#mall-l1 .mall-tab').forEach(b => b.onclick = () => {
      this._l1 = b.dataset.k; this._l2 = null; this._page = 0; this._sel = -1; this._initTab(); this.render();
    });
  }
  _defOf(it) {
    if (it.itemId) { const d = (Config.data.items || {})[it.itemId]; if (d) return d; }
    return { image: it.image, name: it.name, id: 'mall_' + it.id };
  }
  _effectOf(it) { if (it.itemId) { const d = (Config.data.items || {})[it.itemId]; return (d && d.effect) || {}; } return {}; }
  _noteFor(it) {
    if (!it) return '点击格子选中商品后购买';
    const pt = it.priceText || fmtCopper(Number(it.price) || 0, '金');
    return '【' + it.name + '】' + pt + ' · ' + (it.brief || '').slice(0, 52);
  }
  _buyFlow() {
    const p = this.ui.player;
    if (!p) { this.ui.toast('尚未登录'); return; }
    const all = this._items();
    const it = this._sel >= 0 ? all[this._sel] : null;
    if (!it) { this.ui.toast('请先点击选中要购买的商品'); return; }
    const unit = Number(it.discountPrice != null ? it.discountPrice : it.price) || 0;
    if (unit <= 0) { this.ui.toast('该商品价格异常，无法购买'); return; }
    const maxQ = Math.floor(copper(p, 'gold') / unit);
    if (maxQ < 1) { this.ui.toast('金子余额不足（需 ' + fmtCopper(unit, '金') + '）'); return; }
    const box = document.createElement('div');
    box.className = 'ns-qty';
    box.innerHTML =
      '<div class="ns-qty-t">购买【' + esc(it.name) + '】</div>' +
      '<div class="ns-qty-p">单价 ' + esc(fmtCopper(unit, '金')) + ' · 最大 ' + maxQ + ' 件</div>' +
      '<input class="ns-qty-in" type="number" min="1" max="' + maxQ + '" value="1"/>' +
      '<div class="ns-qty-sum">合计 <b>' + esc(fmtCopper(unit, '金')) + '</b></div>' +
      '<div class="ns-qty-btns"><button class="pb-btn" id="nsq-ok">确定</button>' +
      '<button class="pb-btn ghost" id="nsq-no">取消</button></div>';
    this.body.appendChild(box);
    const inp = box.querySelector('.ns-qty-in');
    const sum = box.querySelector('.ns-qty-sum');
    inp.oninput = () => {
      const n = Math.max(1, Math.min(maxQ, Math.floor(+inp.value || 1)));
      inp.value = n;
      sum.innerHTML = '合计 <b>' + esc(fmtCopper(unit * n, '金')) + '</b>';
    };
    box.querySelector('#nsq-no').onclick = () => box.remove();
    box.querySelector('#nsq-ok').onclick = () => {
      const n = Math.max(1, Math.min(maxQ, Math.floor(+inp.value || 1)));
      if (!payCopper(p, 'gold', unit * n)) { this.ui.toast('金子余额不足'); return; }
      this._addToBag(it, n);
      box.remove();
      this.ui.toast('已购买 ' + n + ' 件【' + it.name + '】');
      if (this.ui.refresh) this.ui.refresh();
      const bag = panelManager.panels['bag'];
      if (bag && panelManager.isOpened('bag')) bag.render();
      this.render();
    };
    inp.focus();
  }
  _addToBag(it, n) {
    const p = this.ui.player;
    p.bag = p.bag || [];
    const id = it.itemId || ('mall_' + it.id);
    const exist = p.bag.find(b => b.itemId === id);
    if (exist) exist.count = (exist.count || 0) + n;
    else p.bag.push({ itemId: id, count: n, bind: 0 });
  }
}

// 商店（NPC 买 / 卖）：对齐 AS3 panel.item.shop.ShopItemPanel
//   与上方 ShopPanel（主商城 MallPanel02）严格区分：本面板由商店 NPC 的「进入商店」打开，
//   数据背靠 Config.data.shopCatalog（op102/op688 真实货品：72 家店 / 2293 件商品）。
//   shopId == NPC 模板 id（实证：1003 杂货商曹雪 ↔ op102 shopId 1003）。
//
// ★ AS3 几何真值（deobfuscated/panel/item/shop/ShopItemPanel.as）：
//     bgWidth=260 bgHeight=430；网格 6列×8行 = 48 格/页；格 37px；起点 (20,69)；
//     TabView 在 (21,45)，6 个页签（text_panel_lab_1..6）；updateItemData 按 index/48 分页；
//     按钮：购买(160,365) 修理单个(30,365) 修理全部(30,393) 修理耐久(160,393)，宽 74；
//     update(npcId, hasRepair, taskId)：hasRepair==1 才显示修理按钮，否则只有「购买」且 y=378。
//     修理相关协议无抓包数据 ⇒ 本版 hasRepair 恒为 0，只显示「购买」按钮（对齐 AS3 无修理态）。
//     选择高亮复用 mall_select（本工程 .bag-sel 选中图）；格底 panel_item_bg（与背包同源）。
// ------------------------------------------------------------------
const NS_PER_PAGE = 48;   // ShopItemPanel 网格 6×8 = 48 格/页
const NS_PAGES = 6;       // AS3 TabView 6 个页签

export class NpcShopPanel extends BasePanel {
  constructor(ui) {
    // 260×430 = AS3 原生尺寸 1:1
    super({ id: 'panel-npcshop', title: '商店', width: 260, height: 430, ui, isNpcPanel: true });
    this._tab = 'buy';       // 'buy' | 'sell'
    this._shopId = null;     // catalog 店 id（= NPC 模板 id）
    this._page = 0;          // AS3 tabBar.selectIndex（0..5）
    this._sel = -1;          // 选中商品在店内的全局 index（-1=未选；对齐 AS3 currentItemIndex）
  }
  init() { this._initShop(); this.render(); }
  onOpen() { if (this._shopId == null) this._initShop(); this.render(); }
  // 由 ui.openPanel('npcshop', { shopId }) 注入：直接打开指定 NPC 的店
  applyOpenOpts(opts) {
    if (!opts || opts.shopId == null) return;
    this._shopId = String(opts.shopId);
    this._page = 0; this._sel = -1; this._tab = 'buy';
    const sc = Config.data.shopCatalog || {};
    this.setTitle((sc[this._shopId] && sc[this._shopId].name) || '商店');
    this.render();
  }
  _initShop() {
    const sc = Config.data.shopCatalog || {};
    const ids = Object.keys(sc).sort((a, b) => (+a) - (+b));
    this._shopId = ids.length ? ids[0] : null;
    if (this._shopId) { const s0 = sc[this._shopId]; if (s0 && s0.name) this.setTitle(s0.name); }
  }
  _curShop() {
    const sc = Config.data.shopCatalog || {};
    return this._shopId != null ? sc[String(this._shopId)] : null;
  }

  render() {
    if (this._tab === 'sell') { this._renderSellView(); return; }
    const sc = Config.data.shopCatalog || {};
    const shop = this._curShop();
    const p = this.ui.player;
    const all = shop ? (shop.items || []) : [];
    // AS3 updateItemData：itemAllArray[ Math.floor(index/48) ] 分页
    const pages = [];
    for (let i = 0; i < NS_PAGES; i++) pages.push(all.filter(it => Math.floor((it.index || 0) / NS_PER_PAGE) === i));
    const pageItems = pages[this._page] || [];
    // 店内无任何抓包商品：如实提示（不臆造）
    if (!all.length) {
      this.setContent(
        '<div class="ns-tabs">' + this._tabBarHtml(pages) + '</div>' +
        '<div class="ns-empty">该商店暂无商品数据<br><span>（抓包未覆盖此 NPC，op102/op688 无此 shopId）</span></div>');
      this._wireTabs(pages);
      return;
    }
    const sel = this._sel >= 0 ? all[this._sel] : null;
    // ★ 无滚动条布局：pb-body 内容盒 = 364 - padding24 - border2 = 338；
    //   tabs 单行 24 + grid 8行×34px=288 + bar 26 = 338，严丝合缝零溢出。
    //   AS3 ShopItemPanel 本就无 note 栏（260×430 固定几何），选中提示改由悬停 tip +
    //   购买按钮启停承担；全量店 select 压到 58px（title 显示全名，调试向入口）。
    this.setContent(
      '<div class="ns-tabs" style="flex-wrap:nowrap;height:24px;padding:0;gap:1px">' + this._tabBarHtml(pages) + '</div>' +
      '<div class="ns-grid" style="display:grid;width:auto;grid-template-columns:repeat(6,30px);grid-auto-rows:34px;gap:2px;padding:2px 2px 0"></div>' +
      '<div class="ns-bar" style="height:26px;padding:0 8px">' +
        '<span class="ns-money">银子 <b>' + esc(moneyText(p, 'silver')) + '</b></span>' +
        '<span class="ns-money-g">金子 <b>' + esc(moneyText(p, 'gold')) + '</b></span>' +
        '<button class="pb-btn ns-buy" ' + (sel ? '' : 'disabled') + '>购买</button>' +
      '</div>');
    // 网格（48 格，含空格；对齐 AS3 initGridBackground 的 panel_item_bg 格底）
    this.body.style.setProperty('--bag-cell-bg', 'url("' + absUrl(url.res('panelitembg.png')) + '")');
    this.body.style.setProperty('--bag-sel-bg', 'url("' + absUrl(url.res('panelitemselect.png')) + '")');
    const grid = this.body.querySelector('.ns-grid');
    for (let c = 0; c < NS_PER_PAGE; c++) {
      const it = pageItems[c];
      const cell = document.createElement('div');
      cell.className = 'bag-cell ns-cell' + (it ? '' : ' empty');
      cell.style.minWidth = '0'; cell.style.overflow = 'hidden';
      if (it) {
        const def = this._defOf(it);       // 链接到 items.json 的定义（用于图标候选源）
        cell.innerHTML = iconImg(itemIconSrcs(def), 'bag-ic') +
          (all.indexOf(it) === this._sel ? '<div class="bag-sel"></div>' : '');
        cell.onmouseenter = () => showItemTip({ name: it.name, type: this._typeLabel(it), desc: it.desc || it.brief || it.plain || '', effect: this._effectOf(def) }, p, cell);
        cell.onmouseleave = hideItemTip;
        cell.onclick = () => { this._sel = all.indexOf(it); this.render(); };
      }
      grid.appendChild(cell);
    }
    wireIconFallback(grid);
    grid.querySelectorAll('img.bag-ic').forEach(function (im) { im.style.maxWidth = '100%'; im.style.maxHeight = '100%'; });
    this._wireTabs(pages);
    const buyBtn = this.body.querySelector('.ns-buy');
    if (buyBtn) buyBtn.onclick = () => this._buyFlow();
  }

  // 页签：全量店下拉 + 6 个分页签 + 售按钮（对齐 AS3 TabView 6 页签）
  // 页签：全量店下拉 + 【有商品的页】才渲染页签（多数店仅 1 页；260 宽面板内容盒仅 196px，
  //   6 个空页签 + 58px 下拉会把 tabs 行撑到 214px 横向溢出 36px → pb-body 出现水平滚动条）
  _tabBarHtml(pages) {
    const sc = Config.data.shopCatalog || {};
    const ids = Object.keys(sc).sort((a, b) => (+a) - (+b));
    const shopSel = '<select class="ns-shop" id="ns-shop" title="全量店浏览" style="width:42px;flex:0 0 auto;padding:0 1px">' +
      ids.map(id => '<option value="' + id + '"' + (id === String(this._shopId) ? ' selected' : '') + '>' +
        esc((sc[id].name || ('商店#' + id)).slice(0, 12)) + '</option>').join('') + '</select>';
    const tabs = pages.map((pg, i) =>
      (pg && pg.length) ?
        '<button class="bag-tab ' + (i === this._page ? 'on' : '') + '" data-page="' + i + '" style="width:20px;height:20px;flex:0 0 auto;padding:0">' +
        '<span class="bag-pageno">' + (i + 1) + '</span></button>' : '').join('');
    return shopSel + tabs + '<span style="flex:1;min-width:0"></span>' + this._sellTabBtn();
  }
  _sellTabBtn() {
    return '<button class="ns-selltab ' + (this._tab === 'sell' ? 'on' : '') + '" title="出售" style="width:22px;flex:0 0 auto">售</button>';
  }
  _wireTabs(pages) {
    this.body.querySelectorAll('.bag-tab').forEach(t =>
      t.onclick = () => { this._page = +t.dataset.page; this._sel = -1; this.render(); });
    const sel = this.body.querySelector('#ns-shop');
    if (sel) sel.onchange = () => { this._shopId = sel.value; this._page = 0; this._sel = -1; this.render(); };
    const st = this.body.querySelector('.ns-selltab');
    // 售按钮：买页点→切出售页；卖页点→切回买页
    if (st) st.onclick = () => { this._tab = (this._tab === 'sell') ? 'buy' : 'sell'; this._sel = -1; this.render(); };
  }

  // 商品 → 物品定义（用于图标；未链接的用抓包 image 兜底渲染）
  _defOf(it) {
    if (it.itemId) {
      const d = (Config.data.items || {})[it.itemId];
      if (d) return d;
    }
    return { image: it.image, name: it.name, id: 'shop_' + this._shopId + '_' + it.index };
  }
  _typeLabel(it) {
    const c = it.cur;
    if (c === 'gold') return '金币货物';
    if (c === 'badge') return (it.append || '徽章') + '兑换';
    if (c === 'special') return '特殊兑换';
    return '货物';
  }
  _effectOf(def) { return (def && def.effect) || {}; }
  _noteFor(it) {
    if (!it) return '点击格子选中商品后购买';
    const ul = it.cur === 'gold' ? '金' : '银';
    const pt = it.priceText || fmtCopper(Number(it.price) || 0, ul);   // 装备店商品 desc 无【价格】段时回落 price（文单位）
    if (it.cur === 'badge') return '【' + it.name + '】' + pt + '（' + (it.append || '徽章') + '兑换，游戏未实装该货币，仅供浏览）';
    if (it.cur === 'special') return '【' + it.name + '】' + pt + '（特殊货币兑换，游戏未实装，仅供浏览）';
    return '【' + it.name + '】' + pt + ' · ' + (it.brief || it.plain || '').slice(0, 46);
  }

  // ── 购买流程（对齐 AS3 Prompt34：数量输入 → 确认 → 扣款入包）──
  _buyFlow() {
    const p = this.ui.player;
    if (!p) { this.ui.toast('尚未登录'); return; }
    const shop = this._curShop();
    const all = shop ? (shop.items || []) : [];
    const it = this._sel >= 0 ? all[this._sel] : null;
    if (!it) { this.ui.toast('请先点击选中要购买的商品'); return; }
    if (it.cur !== 'silver' && it.cur !== 'gold') {
      this.ui.toast('该商品需「' + (it.append || '特殊货币') + '」兑换，游戏未实装该货币');
      return;
    }
    const unit = Number(it.price) || 0;
    if (unit <= 0) { this.ui.toast('该商品价格异常，无法购买'); return; }
    const ul = it.cur === 'gold' ? '金' : '银';
    const have = copper(p, it.cur);
    const maxQ = Math.floor(have / unit);
    if (maxQ < 1) { this.ui.toast('银子不足（需 ' + fmtCopper(unit, ul) + '）'); return; }
    // 内联数量输入（Prompt34 语义：数量 + 合计 + 双货币显示）
    const box = document.createElement('div');
    box.className = 'ns-qty';
    box.innerHTML =
      '<div class="ns-qty-t">购买「' + esc(it.name) + '」</div>' +
      '<div class="ns-qty-p">单价 ' + esc(it.priceText || fmtCopper(unit, ul)) + ' · 最多 ' + maxQ + ' 件</div>' +
      '<input class="ns-qty-in" type="number" min="1" max="' + maxQ + '" value="1"/>' +
      '<div class="ns-qty-sum">合计 <b>' + esc(fmtCopper(unit, ul)) + '</b></div>' +
      '<div class="ns-qty-btns"><button class="pb-btn" id="nsq-ok">确定</button>' +
      '<button class="pb-btn ghost" id="nsq-no">取消</button></div>';
    this.body.appendChild(box);
    const inp = box.querySelector('.ns-qty-in');
    const sum = box.querySelector('.ns-qty-sum');
    inp.oninput = () => {
      const n = Math.max(1, Math.min(maxQ, Math.floor(+inp.value || 1)));
      inp.value = n;
      sum.innerHTML = '合计 <b>' + esc(fmtCopper(unit * n, ul)) + '</b>';
    };
    box.querySelector('#nsq-no').onclick = () => box.remove();
    box.querySelector('#nsq-ok').onclick = () => {
      const n = Math.max(1, Math.min(maxQ, Math.floor(+inp.value || 1)));
      if (!payCopper(p, it.cur, unit * n)) { this.ui.toast('余额不足'); return; }
      this._addToBag(it, n);
      box.remove();
      this.ui.toast('已购买 ' + n + ' 件「' + it.name + '」');
      if (this.ui.refresh) this.ui.refresh();
      const bag = panelManager.panels['bag'];
      if (bag && panelManager.isOpened('bag')) bag.render();
      this.render();
    };
    inp.focus();
  }

  // 入包：已链接走 items.json 真实定义；未链接（材料/技能书等）用抓包真实字段在内存派生定义。
  //   id 稳定 = shop_<shopId>_<index>，重复购买正确堆叠；仅内存、不写盘、不污染 config/items.json。
  _addToBag(it, n) {
    const p = this.ui.player;
    p.bag = p.bag || [];
    let id = it.itemId;
    if (!id) {
      id = 'shop_' + this._shopId + '_' + it.index;
      const items = Config.data.items || (Config.data.items = {});
      if (!items[id]) items[id] = {
        id, name: it.name || '未知道具', image: it.image || '',
        type: it.type != null ? String(it.type) : 'other',
        price: Number(it.price) || 0,
        desc: it.brief || it.plain || it.desc || '',
      };
    }
    const exist = p.bag.find(b => b.itemId === id);
    if (exist) exist.count = (exist.count || 0) + n;
    else p.bag.push({ itemId: id, count: n, bind: 0 });
  }

  // ── 出售页（AS3 无出售按钮，本页为单机版便利功能；紧凑列表适配 260 宽）──
  // ── 出售页（AS3 无出售功能，本页为单机版便利；与买页同构的 6×8 网格：
  //    260×430 内容盒 338 = tabs 24 + grid 8×34=288 + bar 26，零滚动条；物品 >48 分页）──
  _renderSellView() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="ns-empty">尚未登录</div>'); return; }
    const itemsMap = Config.items || {};
    const slots = (p.bag || []).map((s, i) => {
      const def = itemsMap[s.itemId];
      return def ? { slot: s, def, gi: i } : null;
    }).filter(Boolean);
    if (this._sel >= slots.length) this._sel = -1;
    const pages = [];
    for (let i = 0; i < NS_PAGES; i++) pages.push(slots.filter((_, idx) => Math.floor(idx / NS_PER_PAGE) === i));
    const pageItems = pages[this._page] || [];
    if (!slots.length) {
      this.setContent(
        '<div class="ns-tabs" style="flex-wrap:nowrap;height:24px;padding:0;gap:1px">' + this._tabBarHtml(pages) + '</div>' +
        '<div class="ns-empty">背包为空，无可出售道具</div>');
      this._wireTabs(pages);
      return;
    }
    const sel = this._sel >= 0 ? slots[this._sel] : null;
    this.setContent(
      '<div class="ns-tabs" style="flex-wrap:nowrap;height:24px;padding:0;gap:1px">' + this._tabBarHtml(pages) + '</div>' +
      '<div class="ns-grid" style="display:grid;width:auto;grid-template-columns:repeat(6,30px);grid-auto-rows:34px;gap:2px;padding:2px 2px 0"></div>' +
      '<div class="ns-bar" style="height:26px;padding:0 8px">' +
        '<span class="ns-money">银子 <b>' + esc(moneyText(p, 'silver')) + '</b></span>' +
        '<span class="ns-money-g">' + (sel ? esc(sel.def.name).slice(0, 8) : '未选') + '</span>' +
        '<button class="pb-btn ns-sell-go" ' + (sel ? '' : 'disabled') + '>出售</button>' +
      '</div>');
    this.body.style.setProperty('--bag-cell-bg', 'url("' + absUrl(url.res('panelitembg.png')) + '")');
    this.body.style.setProperty('--bag-sel-bg', 'url("' + absUrl(url.res('panelitemselect.png')) + '")');
    const grid = this.body.querySelector('.ns-grid');
    for (let c = 0; c < NS_PER_PAGE; c++) {
      const it = pageItems[c];
      const cell = document.createElement('div');
      cell.className = 'bag-cell ns-cell' + (it ? '' : ' empty');
      cell.style.minWidth = '0'; cell.style.overflow = 'hidden';
      if (it) {
        cell.innerHTML = iconImg(itemIconSrcs(it.def), 'bag-ic') +
          (it.slot.count > 1 ? '<div class="bag-count">' + it.slot.count + '</div>' : '') +
          (slots.indexOf(it) === this._sel ? '<div class="bag-sel"></div>' : '');
        cell.onmouseenter = () => showItemTip({ name: it.def.name, desc: it.def.desc || '', effect: it.def.effect }, p, cell);
        cell.onmouseleave = hideItemTip;
        cell.onclick = () => { this._sel = slots.indexOf(it); this.render(); };
      }
      grid.appendChild(cell);
    }
    wireIconFallback(grid);
    grid.querySelectorAll('img.bag-ic').forEach(function (im) { im.style.maxWidth = '100%'; im.style.maxHeight = '100%'; });
    this._wireTabs(pages);
    const go = this.body.querySelector('.ns-sell-go');
    if (go) go.onclick = () => this._sellFlow(slots);
  }

  // 出售选中物品：弹 AS3 复刻确认面板（与拖拽出售 requestSell 同口径，半价回收）
  _sellFlow(slots) {
    const p = this.ui.player;
    const it = this._sel >= 0 ? slots[this._sel] : null;
    if (!p || !it) { this.ui.toast('请先点击选中要出售的物品'); return; }
    const base = Number(it.def.price) || 0;
    const sell = base > 0 ? Math.max(1, Math.floor(base / 2)) : 1;
    const shopName = ((this._curShop() || {}).name) || '商店';
    const total = sell * (it.slot.count || 1);
    this.ui.openPanel('confirm', {
      title: '出售物品',
      content: '将【' + esc(it.def.name) + '】×' + (it.slot.count || 1) + ' 出售给「' + esc(shopName) + '」？<br>可获得 <b>' + fmtCopper(total, '银') + '</b>（半价回收）',
      confirmText: '出售',
      cancelText: '返回',
      confirm: () => this._sellItem(it.gi, total),
    });
  }
  // 拖拽出售：背包物品拖到本面板 → 弹 AS3 复刻确认面板，确认后走 _sellItem
  requestSell(def, bagIndex) {
    const p = this.ui.player;
    if (!p || !def) return;
    const bag = p.bag || [];
    const s = bag[bagIndex];
    // ★ itemId 类型不统一（背包数值 / 配置表字符串），用字符串比较
    if (!s || String(s.itemId) !== String(def.id)) { this.ui.toast('物品已发生变化，请重试'); this.render(); return; }
    const base = Number(def.price) || 0;
    const sell = base > 0 ? Math.max(1, Math.floor(base / 2)) : 1;   // 与 _renderSellView 同口径（半价回收）
    const shopName = ((this._curShop() || {}).name) || '商店';
    const total = sell * (s.count || 1);
    this.ui.openPanel('confirm', {
      title: '出售物品',
      content: '将【' + esc(def.name) + '】×' + (s.count || 1) + ' 出售给「' + esc(shopName) + '」？<br>可获得 <b>' + fmtCopper(total, '银') + '</b>（半价回收）',
      confirmText: '出售',
      cancelText: '返回',
      confirm: () => this._sellItem(bagIndex, total),
    });
  }
  _sellItem(gi, sell) {
    const p = this.ui.player;
    if (!p || gi < 0 || gi >= (p.bag || []).length) return;
    gainCopper(p, 'silver', sell);
    p.bag.splice(gi, 1);
    this._sel = -1;
    this.ui.toast('已出售，获得 ' + fmtCopper(sell, '银'));
    if (this.ui.refresh) this.ui.refresh();
    const bag = panelManager.panels['bag'];
    if (bag && panelManager.isOpened('bag')) bag.render();
    this.render();
  }
}

export class WarehousePanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-warehouse', title: '仓库', width: 520, height: 420, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    const wh = this.ui._warehouse || (this.ui._warehouse = []);
    const itemsMap = Config.items || {};
    const bagItems = (p.bag || []).map(s => ({ slot: s, def: itemsMap[s.itemId] })).filter(x => x.def);
    const whItems = wh.map(s => ({ slot: s, def: itemsMap[s.itemId] })).filter(x => x.def);
    this.setContent(`
      <div class="wh-bar"><button class="pb-btn ghost" id="wh-tidy"><img class="wh-ic" src="${url.res('textpanelzhengli.png')}" alt="整理" onerror="this.outerHTML='整理'"/>整理</button></div>
      <div class="wh-wrap">
        <div class="wh-col"><div class="wh-h">背包（${bagItems.length}）</div><div class="wh-list" id="wh-bag"></div></div>
        <div class="wh-col"><div class="wh-h">仓库（${whItems.length}）</div><div class="wh-list" id="wh-store"></div></div>
      </div>`);
    const tidyBtn = this.body.querySelector('#wh-tidy');
    if (tidyBtn) tidyBtn.onclick = () => this._tidy();
    const bagBox = this.body.querySelector('#wh-bag');
    bagItems.forEach(({ slot, def }) => {
      const row = document.createElement('div'); row.className = 'wh-row';
      row.innerHTML = `${imgWithFallback(url.icon('item', def.icon), 'wh-icon')}<span class="wh-n">${esc(def.name)} ×${slot.count}</span>`;
      const b = document.createElement('button'); b.className = 'pb-btn ghost'; b.textContent = '存入';
      b.onclick = () => this._move(slot.itemId, slot.count, 'bag'); row.appendChild(b); bagBox.appendChild(row);
    });
    if (!bagItems.length) bagBox.innerHTML = '<div class="empty-tip">背包是空的</div>';
    const storeBox = this.body.querySelector('#wh-store');
    whItems.forEach(({ slot, def }) => {
      const row = document.createElement('div'); row.className = 'wh-row';
      row.innerHTML = `${imgWithFallback(url.icon('item', def.icon), 'wh-icon')}<span class="wh-n">${esc(def.name)} ×${slot.count}</span>`;
      const b = document.createElement('button'); b.className = 'pb-btn ghost'; b.textContent = '取出';
      b.onclick = () => this._move(slot.itemId, slot.count, 'wh'); row.appendChild(b); storeBox.appendChild(row);
    });
    if (!whItems.length) storeBox.innerHTML = '<div class="empty-tip">仓库是空的</div>';
  }
  // 整理：对齐 AS3 仓库整理语义——按类型聚合(weapon→armor→potion→other)+ 同组 id 升序，确定性排序(零随机零臆造)；背包与仓库两列一并归一
  _tidy() {
    const p = this.ui.player;
    const wh = this.ui._warehouse || (this.ui._warehouse = []);
    const map = Config.items || {};
    const rank = { weapon: 0, armor: 1, potion: 2, other: 9 };
    const cmp = (a, b) => {
      const ra = rank[(map[a.itemId] || {}).type] ?? 9;
      const rb = rank[(map[b.itemId] || {}).type] ?? 9;
      return ra !== rb ? ra - rb : (a.itemId - b.itemId);
    };
    if (p.bag) p.bag.sort(cmp);
    wh.sort(cmp);
    this.ui.refresh && this.ui.refresh();
    this.render();
    this.ui.toast('已整理仓库');
  }
  _move(itemId, count, from) {
    const p = this.ui.player, wh = this.ui._warehouse;
    if (from === 'bag') {
      const slot = p.bag.find(b => b.itemId === itemId); if (!slot) return;
      const n = Math.min(count, slot.count);
      slot.count -= n; if (slot.count <= 0) p.bag = p.bag.filter(b => b !== slot);
      const w = wh.find(b => b.itemId === itemId); if (w) w.count += n; else wh.push({ itemId, count: n });
    } else {
      const slot = wh.find(b => b.itemId === itemId); if (!slot) return;
      const n = Math.min(count, slot.count);
      slot.count -= n; if (slot.count <= 0) wh.splice(wh.indexOf(slot), 1);
      const b = p.bag.find(x => x.itemId === itemId); if (b) b.count += n; else p.bag.push({ itemId, count: n });
    }
    this.ui.refresh && this.ui.refresh(); this.render();
  }
}

// ───────────────────────── 强化 / 锻造（背包装备升星）─────────────────────────
export class ForgePanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-forge', title: '强化 / 锻造', width: 520, height: 440, ui }); this._sel = null; }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    const enh = this.ui._enhance || (this.ui._enhance = {});
    const eq = (p.bag || []).map(s => Config.items[s.itemId]).filter(Boolean).filter(it => it.type === 'weapon' || it.type === 'armor');
    if (!eq.length) { this.setContent('<div class="empty-tip">背包里没有可强化的装备</div>'); return; }
    if (!this._sel || !eq.find(it => it.id === this._sel)) this._sel = eq[0].id;
    const cur = Config.items[this._sel];
    const ef = cur.effect || {};                            // 防御性兜底：避免装备缺 effect 字段时崩溃
    const step = ef.atk || ef.def || 0;                     // 每级增益（对齐 applyEquip 同类分支）
    const lv = enh[this._sel] || 0;
    const bonus = lv * step;                                // 与 applyEquip 的 lv*e.atk / lv*e.def 完全一致
    const cost = lv * 50 + 50;
    // 强化后真实战斗属性：逐属性 = 基础 + lv×基础，与 applyEquip 同一公式，
    // 使面板「强化后属性」与战斗消费同源，杜绝"展示有加成、战斗无加成"退化。
    const enhEff = {
      atk: (ef.atk || 0) + lv * (ef.atk || 0),
      def: (ef.def || 0) + lv * (ef.def || 0),
      hp: ef.hp || 0, mp: ef.mp || 0, mag: ef.mag || 0
    };
    this.setContent(`
      <div class="forge-wrap">
        <div class="forge-list" id="forge-list"></div>
        <div class="forge-detail">
          <div class="forge-name">${esc(cur.name)} <span class="forge-lv">+${lv}</span></div>
          <div class="forge-stat">基础属性：${statText(ef)}</div>
          <div class="forge-stat">当前加成：+${bonus}（每级 +${step}）</div>
          <div class="forge-stat">强化后属性：${statText(enhEff)}</div>
          <div class="forge-cost">消耗金币：<b>${cost}</b></div>
          <button class="pb-btn" id="forge-do">强化 +1</button>
        </div>
      </div>`);
    const listBox = this.body.querySelector('#forge-list');
    eq.forEach(it => {
      const b = document.createElement('button');
      b.className = 'forge-pick' + (it.id === this._sel ? ' on' : '');
      b.textContent = it.name + (enh[it.id] ? ' +' + enh[it.id] : '');
      b.onclick = () => { this._sel = it.id; this.render(); };
      listBox.appendChild(b);
    });
    const doBtn = this.body.querySelector('#forge-do');
    if (doBtn) doBtn.onclick = () => {
      const pp = this.ui.player;
      // 强化价格单位=两（与 silver 字段同单位），转文走两级扣款，零头保留到 silverCopper
      if (copper(pp, 'silver') < cost * 1000) { this.ui.toast('银子不足（需 ' + cost + ' 两银）'); return; }
      payCopper(pp, 'silver', cost * 1000); this.ui._enhance[this._sel] = (this.ui._enhance[this._sel] || 0) + 1;
      // 实时把强化层重算进战斗属性（ui._enhance 与 player.enhance 同源，applyEquip 已含强化加成）
      if (this.ui.player && typeof this.ui.player.applyEquip === 'function') this.ui.player.applyEquip();
      this.ui.toast(cur.name + ' 强化至 +' + this.ui._enhance[this._sel]);
      this.ui.refresh && this.ui.refresh(); this.render();
    };
  }
}


// ───────────────────────── 世界地图（切图传送）─────────────────────────
export class WorldMapPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-worldmap', title: '世界地图', width: 480, height: 540, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const maps = Config.maps || [];
    const cur = this.ui._curMapId || 1;
    if (!maps.length) { this.setContent('<div class="empty-tip">暂无地图</div>'); return; }
    // 大地图底图(panel_map_bigmap) + 连线图(panel_map_bigmapLine) 对齐 AS3 BigMapPanel.initBg；
    // 「显隐连线」按钮对齐 initLineBtn/onShowLine（默认显示连线、点击切换文案 隐藏/显示连线）。
    this.setContent(`
      <div class="map-big">
        <img class="map-big-img" src="${url.res('panelmapbigmap.png')}" alt="世界地图" onerror="this.style.display='none'"/>
        <img class="map-big-line" id="map-big-line" src="${url.res('panelmapbigmapline.png')}" alt="" onerror="this.style.display='none'"/>
        <button class="pb-btn ghost map-line-btn" id="map-line-toggle">隐藏连线</button>
      </div>
      <div class="map-list"></div>`);
    const line = this.body.querySelector('#map-big-line');
    const lineBtn = this.body.querySelector('#map-line-toggle');
    lineBtn.onclick = () => {
      const hidden = line.style.display === 'none';
      line.style.display = hidden ? '' : 'none';
      lineBtn.textContent = hidden ? '隐藏连线' : '显示连线';
    };
    const box = this.body.querySelector('.map-list');
    maps.forEach(m => {
      const row = document.createElement('div'); row.className = 'map-row' + (m.id === cur ? ' on' : '');
      // 缩略图：对应 Smallmap_<resId>.png（update 优先 → icon2 兜底 → 均缺失回退 panelmapbigmap 占位）；
      // CSS object-fit:contain 等比缩放，不拉伸
      const rid = (m.resId != null) ? m.resId : m.id;
      row.innerHTML = `<img class="map-thumb" src="${url.smallmap(rid)}" alt=""
        onerror="if(!this.dataset.f1){this.dataset.f1=1;this.src='${url.smallmapAlt(rid)}';}else if(!this.dataset.f2){this.dataset.f2=1;this.src='${url.res('panelmapbigmap.png')}';}"
      /><div class="map-info"><div class="map-name">${esc(m.name)}</div><div class="map-desc">${esc(m.desc || '')}</div></div>`;
      const b = document.createElement('button'); b.className = 'pb-btn';
      if (m.id === cur) { b.textContent = '当前'; b.disabled = true; }
      else b.onclick = () => { this.ui.enterMap(m.id); this.ui.toast('传送到 ' + m.name); if (this.ui.panels && this.ui.panels['worldmap']) this.ui.panels['worldmap'].render(); };
      row.appendChild(b); box.appendChild(row);
    });
  }
}

// ───────────────────────── 怪物图鉴（真实怪物数据 + 已发现标记）─────────────────────────
export class BestiaryPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-bestiary', title: '怪物图鉴', width: 540, height: 450, ui }); this._sel = null; }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const ms = Config.monsters || {};
    const all = Object.values(ms);
    if (!all.length) { this.setContent('<div class="empty-tip">暂无怪物记录</div>'); return; }
    const killed = (this.ui.sm && this.ui.sm.defeated) || new Set();
    this.setContent('<div class="best-wrap"><div class="best-grid" id="best-grid"></div><div class="best-detail" id="best-d"></div></div>');
    const grid = this.body.querySelector('#best-grid');
    all.forEach(m => {
      const cell = document.createElement('div');
      cell.className = 'best-cell' + (killed.has(m.id) ? ' killed' : '');
      cell.innerHTML = `<div class="best-badge">${esc((m.name || '?')[0])}</div><div class="best-n">${esc(m.name)}</div><div class="best-lv">Lv.${m.level}</div>`;
      cell.onclick = () => { this._sel = m.id; this._show(grid); };
      grid.appendChild(cell);
    });
    if (!this._sel && all.length) this._sel = all[0].id;
    this._show(grid);
  }
  _show(grid) {
    const ms = Config.monsters || {};
    const m = ms[this._sel]; const d = this.body.querySelector('#best-d');
    if (!m || !d) return;
    const killed = (this.ui.sm && this.ui.sm.defeated) || new Set();
    // 怪物技能：从真实 Config.skills 解析技能名（非臆造）；无技能则显「—」
    const skillNames = (m.skills || []).map(id => { const s = Config.skills && Config.skills[id]; return s ? s.name : ('#' + id); }).filter(Boolean);
    d.innerHTML = `<div class="best-d-name">${esc(m.name)} ${killed.has(m.id) ? '<span class="best-found">已发现</span>' : '<span class="best-unfound">未发现</span>'}</div>
      <div class="best-d-stat">等级 ${m.level} · 生命 ${m.hp} · 攻击 ${m.atk} · 防御 ${m.def}</div>
      <div class="best-d-stat">法攻 ${m.mag} · 速度 ${m.spd} · 经验 ${m.exp} · 银子 ${m.silver}</div>
      <div class="best-d-stat">技能：${skillNames.length ? esc(skillNames.join('、')) : '—'}</div>`;
    grid.querySelectorAll('.best-cell').forEach(c => c.classList.remove('on'));
    const idx = Object.values(ms).findIndex(x => x.id === m.id);
    if (idx >= 0 && grid.children[idx]) grid.children[idx].classList.add('on');
  }
}

// ───────────────────────── 成就（由真实进度派生）─────────────────────────
export class AchievementPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-achv', title: '成就', width: 500, height: 450, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    const qs = this.ui._questState || [];
    const doneQuests = qs.filter(q => q.done).length;
    const kills = this.ui._killCount || 0;
    const skillN = (p.skills || []).length;
    // 由真实进度派生（cur/target 同源 ui._questState/_killCount/player.*，无臆造）
    const list = [
      { name: '初出茅庐', desc: '达到 5 级', cur: p.level, target: 5 },
      { name: '小有所成', desc: '达到 10 级', cur: p.level, target: 10 },
      { name: '江湖老手', desc: '达到 20 级', cur: p.level, target: 20 },
      { name: '初战告捷', desc: '击败 1 只怪物', cur: kills, target: 1 },
      { name: '除妖卫道', desc: '击败 10 只怪物', cur: kills, target: 10 },
      { name: '任务达人', desc: '完成 5 个任务', cur: doneQuests, target: 5 },
      { name: '学富五车', desc: '习得 3 个技能', cur: skillN, target: 3 },
      { name: '腰缠万贯', desc: '持有 1000 银子', cur: Math.round(p.silver), target: 1000 },
    ];
    list.forEach(a => {
      a.cur = Math.max(0, a.cur | 0);
      a.done = a.cur >= a.target;
      a.pct = Math.min(100, Math.round(a.cur / a.target * 100));
    });
    const doneN = list.filter(a => a.done).length;
    const pctAll = Math.round(doneN / list.length * 100);
    this.setContent(`<div class="achv-summary">
        <div class="achv-summary-t">已完成 <b>${doneN}</b>/${list.length} 项成就 · 完成度 ${pctAll}%</div>
        <div class="achv-bar"><i style="width:${pctAll}%"></i></div>
      </div>
      <div class="achv-list"></div>`);
    const box = this.body.querySelector('.achv-list');
    list.forEach(a => {
      const row = document.createElement('div'); row.className = 'achv-row' + (a.done ? ' done' : '');
      row.innerHTML = `<div class="achv-mark">${a.done ? '★' : '☆'}</div>
        <div class="achv-meta"><div class="achv-name">${esc(a.name)}</div><div class="achv-desc">${esc(a.desc)}</div>
          <div class="achv-bar sm"><i style="width:${a.pct}%"></i></div></div>
        <div class="achv-prog">${a.done ? '已达成' : a.cur + '/' + a.target}</div>`;
      box.appendChild(row);
    });
  }
}

// ───────────────────────── 设置（调试 / 音效 / FPS / 自动战斗）─────────────────────────
const SET_LABELS = { debug: '调试浮标', sound: '音效', fps: '显示 FPS', autoBattle: '自动战斗', customCursor: '自绘光标', freezeToSystem: '冻结诊断→系统', showOrigin: '模型锚点' };
export class SettingsPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-settings', title: '设置', width: 460, height: 400, ui }); }
  init() { this.render(); }
  onOpen() {
    this.render();
    // 用户按 F11、面板外切回桌面等途径改变全屏状态时同步按钮文案（init 只跑一次，注册放这里配对 onClose）
    if (!this._fsHandler) {
      this._fsHandler = () => {
        const b = this.body && this.body.querySelector('.fs-btn');
        if (b) b.textContent = document.fullscreenElement ? '退出全屏' : '进入全屏';
      };
      document.addEventListener('fullscreenchange', this._fsHandler);
    }
  }
  onClose() {
    if (this._fsHandler) { document.removeEventListener('fullscreenchange', this._fsHandler); this._fsHandler = null; }
  }
  render() {
    const s = this.ui._settings || (this.ui._settings = { debug: false, sound: true, fps: false, autoBattle: false, customCursor: false, freezeToSystem: false, showOrigin: false });
    const row = (k) => `<div class="set-row"><span>${SET_LABELS[k]}</span>
      <button class="dbg-toggle ${s[k] ? 'on' : ''}" data-k="${k}" type="button"><i class="dbg-knob"></i><span class="dbg-toggle-txt">${s[k] ? '开' : '关'}</span></button></div>`;
    // Fullscreen API 不可用时（如部分内嵌 webview）整行不渲染
    const fsRow = document.fullscreenEnabled
      ? `<div class="set-row"><span>网页全屏</span>
          <button class="pb-btn fs-btn" type="button">${document.fullscreenElement ? '退出全屏' : '进入全屏'}</button></div>`
      : '';
    this.setContent(`<div class="set-list">
        <div class="set-section">
          <div class="set-section-h">通用设置</div>
          ${row('debug')}${row('sound')}${row('fps')}${row('autoBattle')}${row('customCursor')}${row('freezeToSystem')}${row('showOrigin')}
          <div class="set-row"><span>新手引导</span>
            <button class="pb-btn re-tutor-btn" type="button">重新观看</button></div>
          ${fsRow}
        </div>
        <div class="set-section">
          <div class="set-section-h">画面设置</div>
          <div class="set-section-note">单机演示版暂未接入画质 / 特效渲染开关（对应 AS3 画质·形象·战斗特效·天气特效·NPC 停止·隐藏职业特效，均 sendSettingMask 服务器驱动，离线无消费者）。</div>
        </div>
      </div>
      <div class="set-note">设置仅影响本机演示；自动战斗将在下一场战斗生效。</div>`);
    this.body.querySelectorAll('.dbg-toggle').forEach(b => b.onclick = () => {
      const k = b.dataset.k; s[k] = !s[k];
      if (k === 'debug') this.ui.setDebug(s.debug);
      if (k === 'fps') { if (this.ui._applyFpsVisibility) this.ui._applyFpsVisibility(); }
      if (k === 'sound' && s.sound) initAudio();   // 开启音效时即在用户手势内解锁 AudioContext（满足浏览器自动播放策略）
      if (k === 'customCursor') customCursor.setEnabled(s.customCursor);   // 自绘光标：隐藏系统鼠标 + 图片跟随（设置里可调试）
      if (k === 'showOrigin') Fighter.setShowOrigin(s.showOrigin);   // 模型锚点（红十字）：setShowOrigin 幂等，即时作用于已存在的全部 Fighter
      b.classList.toggle('on', s[k]);
      const t = b.querySelector('.dbg-toggle-txt'); if (t) t.textContent = s[k] ? '开' : '关';
      this.ui.toast(SET_LABELS[k] + (s[k] ? ' 已开启' : ' 已关闭'));
    });
    const rt = this.body.querySelector('.re-tutor-btn');
    if (rt) rt.onclick = () => {
      // 清空"已完成"持久化并强制重看（start(false) 跳过 finished 检查）
      try { localStorage.removeItem('tsqt.tutor.done'); } catch (e) {}
      if (this.ui.tutor) { this.close(); this.ui.tutor.start(false); }
      else this.ui.toast('引导未初始化');
    };
    // 网页全屏：点按钮在「进入/退出」间切换；requestFullscreen 必须在用户手势内调用（按钮点击即满足）
    const fsBtn = this.body.querySelector('.fs-btn');
    if (fsBtn) fsBtn.onclick = async () => {
      const act = !document.fullscreenElement
        ? document.documentElement.requestFullscreen()
        : document.exitFullscreen();
      // 个别环境（如 headless / 受限 webview）Promise 既不 resolve 也不 reject，给用户一个兜底反馈
      const timeout = new Promise(res => setTimeout(() => res('__fs_timeout__'), 4000));
      try {
        const r = await Promise.race([act, timeout]);
        if (r === '__fs_timeout__') this.ui.toast('全屏切换超时：浏览器可能不支持或已拦截全屏');
      } catch (err) {
        this.ui.toast('全屏切换失败：' + (err && err.message ? err.message : err));
      }
    };
  }
}

// ───────────────────────── 队伍（队友来自地图 NPC + 机器人选项，机器人随队参战）─────────────────────────
export class TeamPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-team', title: '队伍', width: 480, height: 470, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }

  // 成员归一化：兼容旧版纯字符串队伍（视作 NPC），新成员为对象 {name,kind,id,charId,level,hp,mp,atk,def,mag,spd}
  _norm(m) { return typeof m === 'string' ? { name: m, kind: 'npc' } : m; }
  // 按身份判定是否已入队（字符串/对象统一比对）
  _has(team, pred) { return team.find(m => typeof m === 'string' ? pred({ name: m, kind: 'npc' }) : pred(m)); }

  render() {
    const team = this.ui._team || (this.ui._team = []);
    const npcs = Config.npcs || [];
    const bots = Config.bots || {};
    const botList = bots && !Array.isArray(bots) ? Object.values(bots) : (Array.isArray(bots) ? bots : []);
    const cap = 4;   // 连同玩家最多 5 名战斗单位（玩家 band0 + 4 名 band1~4）
    const teamObjs = team.map(m => this._norm(m));

    this.setContent(`<div class="team-head">队伍 <b>${team.length}</b> / ${cap}</div>
      <div class="team-list" id="team-list"></div>
      <div class="team-add">
        <div class="team-h">机器人选项（随队自动参战，队伍越强战斗人员越多）</div>
        <div class="team-bots" id="team-bots">${botList.length ? '' : '<div class="empty-tip sm">暂无可加入的机器人队友</div>'}</div>
      </div>
      <div class="team-add"><div class="team-h">邀请 NPC 队友（来自地图）</div>
        <div class="team-npcs" id="team-npcs">${npcs.length ? '' : '<div class="empty-tip sm">地图暂无可邀请的 NPC</div>'}</div></div>
      ${team.length ? '<div class="team-foot"><button class="pb-btn ghost team-leave" type="button">退出队伍</button></div>' : ''}`);

    // 当前队伍成员列表（显示身份徽标 + 等级，机器人标"机"、NPC 标"友"）
    const box = this.body.querySelector('#team-list');
    if (!team.length) box.innerHTML = '<div class="empty-tip">队伍空空，加入机器人或邀请 NPC 吧</div>';
    teamObjs.forEach((m, i) => {
      const row = document.createElement('div'); row.className = 'team-row' + (i === 0 ? ' lead' : '');
      const badge = m.kind === 'bot' ? '<span class="team-badge bot">机</span>' : '<span class="team-badge">友</span>';
      const lv = m.level != null ? ' Lv.' + m.level : '';
      // 首名即队长（对齐 AS3 GROUP_MASTER 队长态；离线无服务器移交，首名恒为队长）
      row.innerHTML = `${badge}<span class="team-n">${esc(m.name)}${lv}</span>${i === 0 ? '<span class="team-lead">队长</span>' : ''}`;
      const k = document.createElement('button'); k.className = 'pb-btn ghost'; k.textContent = '请离';
      k.onclick = () => { team.splice(i, 1); this.ui.toast(m.name + ' 已请离队伍'); this.render(); };
      row.appendChild(k); box.appendChild(row);
    });

    // 机器人选项：加入队伍后 enter() 会按 kind==='bot' 生成为玩家侧 ally（band 1..k），战斗人员随之变多
    const botBox = this.body.querySelector('#team-bots');
    botList.forEach(b => {
      const inTeam = this._has(team, m => m.kind === 'bot' && m.id === b.id);
      const btn = document.createElement('button');
      btn.className = 'team-bot' + (inTeam ? ' on' : '');
      btn.textContent = b.name + (b.level != null ? ' Lv.' + b.level : '');
      btn.disabled = !!inTeam;
      btn.onclick = () => {
        if (team.length >= cap) { this.ui.toast('队伍已满（上限 ' + cap + '）'); return; }
        team.push({ name: b.name, kind: 'bot', id: b.id, charId: b.charId, level: b.level,
          hp: b.hp, mp: b.mp, atk: b.atk, def: b.def, mag: b.mag, spd: b.spd });
        this.ui.toast(b.name + ' 加入队伍，将随你出战'); this.render();
      };
      botBox.appendChild(btn);
    });

    // NPC 邀请（kind:'npc'；与机器人同款随队参战，enter() 会生成为玩家侧 ally 补位，战斗人员随之变多）
    const npcBox = this.body.querySelector('#team-npcs');
    npcs.slice(0, 10).forEach(n => {
      const inTeam = this._has(team, m => m.kind === 'npc' && m.name === n.name);
      const b = document.createElement('button');
      b.className = 'team-npc' + (inTeam ? ' on' : '');
      b.textContent = n.name; b.disabled = !!inTeam;
      b.onclick = () => {
        if (team.length >= cap) { this.ui.toast('队伍已满（上限 ' + cap + '）'); return; }
        team.push({ name: n.name, kind: 'npc', id: n.id, charId: n.charId });
        this.ui.toast(n.name + ' 加入队伍'); this.render();
      };
      npcBox.appendChild(b);
    });

    const leave = this.body.querySelector('.team-leave');
    if (leave) leave.onclick = () => { this.ui._team = []; this.ui.toast('已退出队伍'); this.render(); };
  }
}

// ───────────────────────── 战斗记录（由 recordBattle 写入，真实回合/伤害统计）─────────────────────────
export class BattleLogPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-battlelog', title: '战斗记录', width: 500, height: 450, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const log = this.ui._battleLog || (this.ui._battleLog = []);
    if (!log.length) { this.setContent('<div class="empty-tip">还没有战斗记录，去打一场吧</div>'); return; }
    // 汇总头：全部字段由真实战斗记录派生（零臆造）
    const wins = log.filter(r => r.win).length;
    const loses = log.length - wins;
    const rate = log.length ? Math.round(wins / log.length * 100) : 0;
    const kills = this.ui._killCount || 0;
    this.setContent(`<div class="blog-head">总战斗 <b>${log.length}</b> · 胜 <b class="g">${wins}</b> · 负 <b class="r">${loses}</b> · 胜率 <b>${rate}%</b> · 累计击杀 <b>${kills}</b></div><div class="blog-list"></div>`);
    const box = this.body.querySelector('.blog-list');
    log.slice().reverse().forEach(r => {
      const row = document.createElement('div'); row.className = 'blog-row ' + (r.win ? 'win' : 'lose');
      const elv = r.enemyLevel != null ? ' Lv.' + r.enemyLevel : '';
      const rd = r.round ? ' · ' + r.round + ' 回合' : '';
      row.innerHTML = `<span class="blog-no">第${r.no}战</span>
        <span class="blog-res">${r.win ? '胜' : '负'}</span>
        <span class="blog-enemy">${esc(r.enemy)}${elv}</span>
        <span class="blog-meta">${rd}</span>
        <span class="blog-reward">${esc(r.reward || '无奖励')}</span>`;
      row.onclick = () => this._toggle(row, r);
      box.appendChild(row);
    });
  }
  // 点击展开单场明细（我方/敌方等级、回合、造成/承受伤害、奖励，全部真实）
  _toggle(row, r) {
    const ex = row.querySelector('.blog-detail');
    if (ex) { ex.remove(); row.classList.remove('open'); return; }
    const me = r.level != null ? 'Lv.' + r.level : '—';
    const foe = r.enemyLevel != null ? 'Lv.' + r.enemyLevel : '未知';
    const dd = r.dmgDealt != null ? r.dmgDealt : '—';
    const dt = r.dmgTaken != null ? r.dmgTaken : '—';
    const d = document.createElement('div'); d.className = 'blog-detail';
    d.innerHTML = `<div class="bd-line">我方等级：<b>${me}</b> · 敌方等级：<b>${foe}</b></div>
      <div class="bd-line">回合数：<b>${r.round || '—'}</b></div>
      <div class="bd-line">造成伤害：<b class="g">${dd}</b> · 承受伤害：<b class="r">${dt}</b></div>
      <div class="bd-line">奖励：<b>${esc(r.reward || '无')}</b></div>`;
    row.classList.add('open');
    row.appendChild(d);
  }
}

// ───────────────────────── 排行榜（由等级/金币/击杀派生）─────────────────────────
export class RankPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-rank', title: '排行榜', width: 480, height: 440, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    const npcs = Config.npcs || [];
    const monsters = Object.values(Config.monsters || {});
    const score = (o) => (o.level || 0) * 100 + Math.floor((o.silver || 0) / 10) + (o.kills || 0) * 8 + (o.skills || 0) * 5;
    const list = [];
    if (p) list.push({ name: p.name || '你', score: score({ level: p.level, silver: p.silver, kills: this.ui._killCount || 0, skills: (p.skills || []).length }), me: true });
    npcs.slice(0, 6).forEach(n => list.push({ name: n.name, score: score({ level: n.level || 30, silver: 5000, kills: 200, skills: 6 }) }));
    monsters.slice(0, 8).forEach(m => list.push({ name: m.name, score: score({ level: m.level, silver: m.silver || 0, kills: 0, skills: 1 }) }));
    list.sort((a, b) => b.score - a.score);
    this.setContent('<div class="rank-list"></div>');
    const box = this.body.querySelector('.rank-list');
    list.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (r.me ? ' me' : '') + (i < 3 ? ' top' : '');
      row.innerHTML = `<span class="rank-no">${i + 1}</span><span class="rank-n">${esc(r.name)}</span><span class="rank-s">${r.score}</span>`;
      box.appendChild(row);
    });
  }
}

// ───────────────────────── 称号 / 荣誉（由成就派生）─────────────────────────
const TITLE_DEFS = [
  { a: '初出茅庐', t: '江湖新秀' }, { a: '小有所成', t: '初露锋芒' }, { a: '江湖老手', t: '一代侠客' },
  { a: '初战告捷', t: '初试牛刀' }, { a: '除妖卫道', t: '降妖尊者' }, { a: '任务达人', t: '百晓生' },
  { a: '学富五车', t: '术法宗师' }, { a: '腰缠万贯', t: '富甲一方' },
];
// 由真实玩家进度派生成就/勋章状态（与 AchievementPanel/MedalPanel 同口径，零臆造）：
// 等级/击杀/完成任务数/已学技能数/金币均来自运行期真实数据。
export function deriveAchievements(ui) {
  const p = ui.player; if (!p) return [];
  const qs = ui._questState || [];
  const done = new Set();
  if (p.level >= 5) done.add('初出茅庐');
  if (p.level >= 10) done.add('小有所成');
  if (p.level >= 20) done.add('江湖老手');
  if ((ui._killCount || 0) >= 1) done.add('初战告捷');
  if ((ui._killCount || 0) >= 10) done.add('除妖卫道');
  if (qs.filter(q => q.done).length >= 5) done.add('任务达人');
  if ((p.skills || []).length >= 3) done.add('学富五车');
  if (p.silver >= 1000) done.add('腰缠万贯');
  return TITLE_DEFS.map(d => ({ achv: d.a, title: d.t, earned: done.has(d.a) }));
}
export class TitlePanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-title', title: '称号 / 荣誉', width: 480, height: 430, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    // 成就完成状态与 MedalPanel 同口径（统一由 deriveAchievements 派生，避免口径分裂）
    const doneAchv = new Set(deriveAchievements(this.ui).filter(a => a.earned).map(a => a.achv));
    const honor = doneAchv.size * 10;
    this.setContent(`<div class="title-honor">荣誉点：<b>${honor}</b></div><div class="title-list"></div>`);
    const box = this.body.querySelector('.title-list');
    TITLE_DEFS.forEach(d => {
      const got = doneAchv.has(d.a);
      const row = document.createElement('div'); row.className = 'title-row' + (got ? ' got' : '');
      row.innerHTML = `<span class="title-mark">${got ? '✔' : '✘'}</span><span class="title-name">${esc(d.t)}</span><span class="title-desc">${esc(d.a)}</span>`;
      if (got && this.ui._title !== d.t) {
        const b = document.createElement('button'); b.className = 'pb-btn ghost'; b.textContent = '佩戴';
        b.onclick = () => { this.ui._title = d.t; this.ui.toast('佩戴称号：' + d.t); this.render(); };
        row.appendChild(b);
      } else if (got && this.ui._title === d.t) {
        const b = document.createElement('button'); b.className = 'pb-btn on'; b.textContent = '佩戴中';
        b.onclick = () => { this.ui._title = null; this.render(); };
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }
}

// ───────────────────────── 勋章（由真实成就进度派生，对齐 MedalPanel.as）─────────────────────────
// 真实客户端勋章槽位精灵：panelmedal{0..8}.png（点亮）/ panelmedalbg{0..8}.png（未点亮，灰底），来自 update/i18n/zh_CN/Resource1/icons。
// 勋章"内容/名称/达成条件"无独立数据域，故复用 deriveAchievements 的真实进度派生（与称号同口径，零臆造文案与图标）。
export class MedalPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-medal', title: '勋章', width: 480, height: 440, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const achvs = deriveAchievements(this.ui);
    if (!achvs.length) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    const earned = achvs.filter(a => a.earned).length;
    const honor = earned * 10;
    this.setContent(`<div class="medal-head">已点亮 <b>${earned}</b>/${achvs.length} · 荣誉点 <b>${honor}</b></div><div class="medal-grid"></div>`);
    const box = this.body.querySelector('.medal-grid');
    achvs.forEach((a, i) => {
      const icon = a.earned ? url.res1('panelmedal' + i + '.png') : url.res1('panelmedalbg' + i + '.png');
      const cell = document.createElement('div');
      cell.className = 'medal-cell' + (a.earned ? ' on' : '');
      cell.innerHTML = `<img class="medal-ic" src="${icon}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="medal-name">${esc(a.achv)}</div>
        <div class="medal-state">${a.earned ? '已点亮' : '未达成'}</div>`;
      box.appendChild(cell);
    });
    // AS3 第 9 格为锁定占位（panel_medal_no_bg，不可点）；离线无更多服务器勋章 → 用真实 panelmedalnobg.png 占位（无臆造数据）
    const nobg = document.createElement('div');
    nobg.className = 'medal-cell nobg';
    nobg.innerHTML = `<img class="medal-ic" src="${url.res1('panelmedalnobg.png')}" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="medal-name">未解锁</div>
      <div class="medal-state">更多勋章</div>`;
    box.appendChild(nobg);
  }
}

// ───────────────────────── 坐骑（由可骑乘灵兽派生）─────────────────────────
// ───────────────────────── 坐骑（由 player.ridePets 派生）─────────────────────────
// AS3 真源：deobfuscated/manager/RidePetManager.as（ridePetList=玩家拥有的骑宠字典数组）
//   + deobfuscated/panel/property/RidePetPanel.as（列表/骑乘按钮 sendRidePetRide）。
// 骑宠是玩家「拥有」的独立集合（字段对齐 AS3 骑宠字典：id/name/charId/level/hp/spd/bind/state），
// 绝非战斗怪物 —— 故取消原「取前 12 只怪物当坐骑」的臆造。离线演示以 player.ridePets 为权威
// 拥有集合；骑乘态用 player._mount 记录（对齐 sendRidePetRide 的当前骑宠语义）。字段均来自真实数据。
export class MountPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-mount', title: '坐骑', width: 500, height: 430, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    const mounts = (p.ridePets || []).slice();
    if (!mounts.length) {
      this.setContent('<div class="empty-tip">暂无可骑乘的灵兽<br><span style="color:#6b7390;font-size:12px">骑宠需通过收服 / 活动获取，离线演示数据未提供</span></div>');
      return;
    }
    const cur = p._mount;
    this.setContent('<div class="mount-head">已拥有 <b>' + mounts.length + '</b> 只骑宠</div><div class="mount-list"></div>');
    const box = this.body.querySelector('.mount-list');
    mounts.forEach(m => {
      const on = cur === m.id;
      const row = document.createElement('div'); row.className = 'mount-row' + (on ? ' on' : '');
      const bindTxt = m.bind ? '已绑定' : '未绑定';
      row.innerHTML = `<div class="mount-badge">${esc((m.name || '?')[0])}</div>
        <div class="mount-meta"><div class="mount-name">${esc(m.name)} <span class="mount-lv">Lv.${m.level != null ? m.level : 1}</span></div>
        <div class="mount-sub">速度 ${m.spd != null ? m.spd : 0} · 生命 ${m.hp != null ? m.hp : 0} · ${bindTxt}</div></div>`;
      const b = document.createElement('button'); b.className = 'pb-btn' + (on ? ' on' : '');
      b.textContent = on ? '下坐骑' : '骑乘';
      b.onclick = () => { p._mount = (p._mount === m.id ? null : m.id); this.ui.toast(p._mount ? ('骑乘 ' + m.name) : '已下坐骑'); this.render(); };
      row.appendChild(b); box.appendChild(row);
    });
  }
}

// ───────────────────────── 表情（客户端 faceemote 图集）─────────────────────────
const EMOTES = ['微笑', '大笑', '生气', '委屈', '惊讶', '得意', '害羞', '晕', '睡觉', '战斗', '加油', '拜托'];
export class EmotePanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-emote', title: '表情', width: 460, height: 400, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    this.setContent(`<div class="emote-head"><img class="emote-ic" src="${url.res('faceemote.png')}" alt="" onerror="this.style.display='none'"/></div><div class="emote-grid"></div>`);
    const box = this.body.querySelector('.emote-grid');
    EMOTES.forEach(name => {
      const b = document.createElement('button'); b.className = 'emote-cell'; b.textContent = name;
      b.onclick = () => { this.ui.toast('你做出了「' + name + '」表情'); };
      box.appendChild(b);
    });
  }
}

// ───────────────────────── 活动 / 每日（由进度派生）─────────────────────────
export class ActivityPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-activity', title: '活动 / 每日', width: 480, height: 440, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const ui = this.ui, p = ui.player;
    const qs = ui._questState || [];
    const doneQuests = qs.filter(q => q.done).length;
    const kills = ui._killCount || 0;
    const enhN = Object.keys(ui._enhance || {}).length;
    const acts = [
      { name: '完成 3 个任务', cur: Math.min(doneQuests, 3), max: 3, reward: '经验 ×150' },
      { name: '击败 10 只怪物', cur: Math.min(kills, 10), max: 10, reward: '金币 ×200' },
      { name: '强化 1 次装备', cur: Math.min(enhN, 1), max: 1, reward: '荣誉 ×10' },
      { name: '习得 1 个技能', cur: Math.min((p && p.skills ? p.skills.length : 0), 1), max: 1, reward: '灵气 ×30' },
      { name: '组建 1 支队伍', cur: Math.min((ui._team || []).length, 1), max: 1, reward: '友情 ×1' },
    ];
    this.setContent('<div class="act-list"></div>');
    const box = this.body.querySelector('.act-list');
    acts.forEach(a => {
      const done = a.cur >= a.max;
      const pct = Math.round(a.cur / a.max * 100);
      const row = document.createElement('div'); row.className = 'act-row' + (done ? ' done' : '');
      row.innerHTML = `<div class="act-name">${esc(a.name)}</div>
        <div class="act-bar"><i style="width:${pct}%"></i></div>
        <div class="act-prog">${a.cur}/${a.max}</div>
        <div class="act-reward">${esc(a.reward)}</div>`;
      box.appendChild(row);
    });
  }
}

// ───────────────────────── 技能书（由 Config.skills 派生）─────────────────────────
// AS3 真源：deobfuscated/net/RequestCommand.as:651 sendUseSkillBook(value,text)
//   → CS_PET_USESKILLBOOK：技能书是「消耗道具教技能」语义，学习 = 使用对应技能书道具。
// 本数据集 config/skills.json 仅含 id/name/icon/charId/xinfa/effect/mpCost/power/cd/
// target/desc/(heal) —— 无 level/cost/book/prereq 字段；config/items.json 无任何技能书
// 物品；config/xinfa.json 为空 {}。
// 依铁律不臆造等级/前置/技能书道具门槛/金币价格：面板忠实展示真实属性；学习条件严格对齐
// AS3 —— 仅当技能配置了技能书物品(s.book)且背包持有该物品时才可学习并消耗之；否则诚实
// 标注「未开放」（离线演示数据未提供技能书物品，玩家初始已学全 3 技能即真实写真状态）。
const SB_TARGET = { enemy: '敌方单体', self: '自身', ally: '友方', all: '全体' };
export class SkillBookPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-skillbook', title: '技能书', width: 500, height: 440, ui }); }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const p = this.ui.player;
    if (!p) { this.setContent('<div class="empty-tip">尚未登录</div>'); return; }
    const skills = Object.values(Config.skills || {});
    if (!skills.length) { this.setContent('<div class="empty-tip">暂无技能</div>'); return; }
    const owned = new Set(p.skills || []);
    const bag = p.bag || [];
    this.setContent('<div class="sb-list"></div>');
    const box = this.body.querySelector('.sb-list');
    const head = document.createElement('div'); head.className = 'sb-head';
    head.innerHTML = `已习得 <b class="g">${owned.size}</b> / ${skills.length} 技能` +
      (p.profession ? ` · 职业 <b>${esc(p.profession)}</b>` : '');
    box.appendChild(head);
    skills.forEach(s => {
      const isOwned = owned.has(s.id);
      const isHeal = s.heal != null && s.heal > 0;
      const powerTxt = isHeal ? ('治疗 ' + s.heal) : ('伤害 ' + (s.power != null ? (s.power * 100) + '%' : '—'));
      const tgtTxt = SB_TARGET[s.target] || s.target || '—';
      const row = document.createElement('div'); row.className = 'sb-row' + (isOwned ? ' owned' : '');
      row.innerHTML = `${imgWithFallback(url.icon('skill', s.icon || ''), 'sb-ic')}
        <div class="sb-meta">
          <div class="sb-name">${esc(s.name)} <span class="sb-tag sb-tag-${esc(s.target)}">${tgtTxt}</span></div>
          <div class="sb-desc">${esc(s.desc || '')}</div>
          <div class="sb-attr">
            <span class="sb-a">心法 ${esc(s.xinfa || '—')}</span>
            <span class="sb-a">耗蓝 ${s.mpCost != null ? s.mpCost : '—'}</span>
            <span class="sb-a">冷却 ${s.cd != null ? s.cd + ' 回合' : '—'}</span>
            <span class="sb-a">${powerTxt}</span>
            ${s.effect ? `<span class="sb-a">特效 ${esc(s.effect)}</span>` : ''}
          </div>
        </div>`;
      // ★ 抓包富文本悬浮框（AS3 CurrentBar.onMouseOver → showInfoPrompt(sdesc)）：
      //   悬停技能行 → 弹出 1 级 sdesc 富文本（消耗数值占位 XX，数值以本行 sb-attr 为准）
      row.onmouseenter = () => showSkillTip(s, row);
      row.onmouseleave = hideSkillTip;
      const b = document.createElement('button'); b.className = 'pb-btn';
      if (isOwned) { b.textContent = '已学'; b.disabled = true; }
      else if (s.book) {
        const slot = bag.find(it => it.itemId === s.book && it.count > 0);
        b.textContent = slot ? '学习' : '需技能书';
        b.disabled = !slot;
        if (slot) b.onclick = () => this._learn(s);
      } else {
        b.textContent = '未开放'; b.disabled = true; // 数据集无对应技能书物品，离线不臆造门槛
      }
      row.appendChild(b); box.appendChild(row);
    });
  }
  _learn(s) {
    const p = this.ui.player;
    // 对齐 AS3：消耗对应技能书物品，而非臆造金币价格
    const slot = (p.bag || []).find(it => it.itemId === s.book);
    if (!slot || slot.count <= 0) { this.ui.toast('缺少技能书道具'); return; }
    slot.count -= 1;
    p.skills = p.skills || [];
    if (!p.skills.includes(s.id)) p.skills.push(s.id);
    this.ui.toast('习得了 ' + s.name + '！'); this.ui.refresh && this.ui.refresh(); this.render();
  }
}

// ───────────────────────── 帮助 / 系统说明 ─────────────────────────
export class HelpPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-help', title: '帮助', width: 500, height: 440, ui }); this._tab = 'play'; }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const tabs = { play: '操作', battle: '战斗', res: '资源', faq: 'FAQ' };
    const body = {
      play: '· 点击地面移动角色。\n· 左上菜单打开各系统面板。\n· 角色面板查看属性，背包管理道具。\n· 靠近 NPC 可触发对话与任务。',
      battle: '· 走近怪物自动进入战斗（地图冻结）。\n· 战斗指令：攻击/技能/道具/防御/逃跑。\n· 胜利获得经验金币，战败回到原处。',
      res: '· 美术资源取自原始客户端 update/ 图集。\n· 面板九宫格用 common_*，菜单用 face*。\n· 战斗背景用 battlebackground.png。',
      faq: '· 单机演示，数据存于内存。\n· 刷新页面重置进度。\n· 更多面板可在调试面板（F9）查看。',
    };
    this.setContent(`<div class="help-tabs">${Object.keys(tabs).map(k => `<button class="help-tab ${k === this._tab ? 'on' : ''}" data-t="${k}">${tabs[k]}</button>`).join('')}</div>
      <div class="help-body" id="help-body"></div>`);
    this.body.querySelectorAll('.help-tab').forEach(b => b.onclick = () => { this._tab = b.dataset.t; this.render(); });
    const hb = this.body.querySelector('#help-body');
    if (hb) hb.innerHTML = esc(body[this._tab] || '').replace(/\n/g, '<br>');
  }
}

// ───────────────────────── 怪物配置器（编辑器：对齐原版怪物模板字段）─────────────────────────
// 编辑对象 = Config.monsters（真实后台表）；保存走 persistConfig('monsters', ...) 写回运行期并持久化到 localStorage，
// 下一次 loadConfig 自动覆盖。字段集与战斗中实际消费的怪物模板一致（charId/level/hp/mp/atk/def/mag/spd/exp/silver/skills），
// 不引入任何未在别处被消费的多余字段（避免假数据）。
const MON_FIELDS = [
  { k: 'level', label: '等级', step: 1 },
  { k: 'hp', label: '生命 HP', step: 10 },
  { k: 'mp', label: '法力 MP', step: 5 },
  { k: 'atk', label: '攻击', step: 1 },
  { k: 'def', label: '防御', step: 1 },
  { k: 'mag', label: '法攻', step: 1 },
  { k: 'spd', label: '速度', step: 1 },
  { k: 'exp', label: '经验', step: 5 },
  { k: 'silver', label: '银子', step: 1 },
];
export class MonsterConfigPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-moncfg', title: '怪物配置器', width: 620, height: 500, ui });
    this._sel = null;     // 当前编辑的怪物 id
    this._draft = null;   // 当前编辑表单（深拷贝草稿）
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const ms = Config.monsters || (Config.monsters = {});
    const all = Object.values(ms);
    const list = all.map(m => `<button class="moncfg-item ${m.id === this._sel ? 'on' : ''}" data-id="${esc(m.id)}">${esc(m.name)} <span class="moncfg-lv">Lv.${m.level}</span></button>`).join('');
    this.setContent(`
      <div class="moncfg-wrap">
        <div class="moncfg-list">
          <button class="moncfg-add" id="moncfg-add">+ 新建怪物</button>
          ${list}
        </div>
        <div class="moncfg-detail" id="moncfg-d"></div>
      </div>`);
    // 默认选中第一个（若未选）
    if (!this._sel && all.length) { this._sel = all[0].id; this._draft = this._clone(all[0]); }
    if (this._sel && !this._draft) { const m = ms[this._sel]; if (m) this._draft = this._clone(m); }
    this.body.querySelectorAll('.moncfg-item').forEach(b => b.onclick = () => {
      const m = ms[b.dataset.id]; if (!m) return;
      this._sel = b.dataset.id; this._draft = this._clone(m); this._renderDetail();
    });
    this.body.querySelector('#moncfg-add').onclick = () => this._add();
    this._renderDetail();
  }
  _clone(m) { return JSON.parse(JSON.stringify(m)); }
  _renderDetail() {
    const d = this.body && this.body.querySelector('#moncfg-d');
    if (!d) return;
    if (!this._sel || !this._draft) { d.innerHTML = '<div class="empty-tip">从左侧选择一只怪物，或新建一只</div>'; return; }
    const f = this._draft;
    const head = `
      <div class="moncfg-keys">
        <label class="moncfg-field"><span>ID</span><input type="text" data-f="id" value="${esc(f.id)}"/></label>
        <label class="moncfg-field"><span>名称</span><input type="text" data-f="name" value="${esc(f.name)}"/></label>
        <label class="moncfg-field"><span>角色模型 charId</span><input type="number" data-f="charId" value="${f.charId ?? 0}" step="1"/></label>
      </div>`;
    const grid = '<div class="moncfg-grid">' + MON_FIELDS.map(o => `
        <label class="moncfg-field"><span>${o.label}</span><input type="number" data-f="${o.k}" value="${f[o.k] ?? 0}" step="${o.step}"/></label>`).join('') + '</div>';
    const skills = `<label class="moncfg-field moncfg-full"><span>技能列表（逗号分隔技能ID，如 10010,10020）</span><input type="text" data-f="skills" value="${esc((f.skills || []).join(','))}"/></label>`;
    d.innerHTML = `${head}${grid}${skills}
      <div class="moncfg-actions">
        <button class="pb-btn" id="moncfg-save">保存</button>
        <button class="pb-btn ghost" id="moncfg-del">删除</button>
        <button class="pb-btn ghost" id="moncfg-export">导出 JSON</button>
      </div>`;
    d.querySelectorAll('input[data-f]').forEach(inp => { inp.onchange = () => this._field(inp); });
    d.querySelector('#moncfg-save').onclick = () => this._save();
    d.querySelector('#moncfg-del').onclick = () => this._del();
    d.querySelector('#moncfg-export').onclick = () => this._export();
  }
  _field(inp) {
    const k = inp.dataset.f, v = inp.value;
    if (k === 'id' || k === 'name') this._draft[k] = v;
    else if (k === 'skills') this._draft.skills = v.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n));
    else this._draft[k] = Number(v) || 0;
  }
  _save() {
    const ms = Config.monsters || (Config.monsters = {});
    if (!this._draft.id) { this.ui.toast('ID 不能为空'); return; }
    if (this._draft.id !== this._sel && ms[this._draft.id]) { this.ui.toast('ID 已存在，请换一个'); return; }
    if (this._draft.id !== this._sel) delete ms[this._sel];
    ms[this._draft.id] = this._clone(this._draft);
    persistConfig('monsters', Config.monsters);
    this._sel = this._draft.id;
    this.ui.toast('已保存 ' + this._draft.name);
    this.ui.refresh && this.ui.refresh(); this.render();
  }
  _del() {
    const ms = Config.monsters || {};
    if (!ms[this._sel]) return;
    delete ms[this._sel];
    persistConfig('monsters', Config.monsters);
    this.ui.toast('已删除 ' + (this._draft ? this._draft.name : ''));
    this._sel = null; this._draft = null; this.render();
  }
  _add() {
    const ms = Config.monsters || (Config.monsters = {});
    let id = 'm_new', i = 1;
    while (ms[id]) id = 'm_new' + (++i);
    this._sel = id;
    this._draft = { id, name: '新怪物', charId: 10002, level: 1, hp: 100, mp: 20, atk: 20, def: 10, mag: 5, spd: 8, exp: 10, silver: 5, skills: [] };
    this._renderDetail();
  }
  _export() {
    const data = JSON.stringify(Config.monsters, null, 2);
    try { navigator.clipboard && navigator.clipboard.writeText(data); } catch (e) {}
    console.log('[MonsterConfig] 当前怪物表导出：\n' + data);
    this.ui.toast('已导出到控制台 / 剪贴板');
  }
}

// ───────────────────────── 批量注册 ─────────────────────────
// ───────────────────────── 宝箱（对齐 AS3 ChestItemPanel + ChestPreopenPanel）─────────────────────────
// 原版流程：
//   ChestItemPanel（宝箱列表 + 自动开启勾选 + 获取按钮）
//     → buttonHandler：未勾选自动开启 = sendChestItemGet（直接入包）；勾选 = sendChestOpen(chestID) 打开 ChestPreopenPanel
//   ChestPreopenPanel（宝箱图 + 说明 + 18 格掉落预览 GRID_OPEN + 4 按钮：开启×2 / 获取×2）
// 离线单机无服务器下发掉落（op131/132/226 未解析），故预览格为占位、按钮走"还原交互结构"提示，绝不臆造道具名。
const CHEST_INTRO = '点击宝箱可开启或获取。勾选「自动开启」后点击宝箱进入开启预览；不勾选则直接收入背包。';
const CHEST_INFO_1 = '开启宝箱有两种方式：普通开启与祈福开启，开启后随机获得掉落。';
const CHEST_INFO_2 = '祈福/至尊获取需要服务器状态（qifu/zhiZun）支持，开启结果来自协议 op131/132/226，单机版暂未解析。';

export class ChestPanel extends BasePanel {
  constructor(ui) {
    super({ id: 'panel-chest', title: '宝箱', width: 540, height: 460, ui });
    this._auto = true;   // 对应 AS3 CHECKBOX_AUTO_OPEN（selected=true）
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const chests = (Config.data && Config.data.chests) || [];
    if (!chests.length) { this.setContent('<div class="empty-tip">暂无宝箱数据</div>'); return; }
    this.setContent(`
      <div class="chest-wrap">
        <div class="chest-intro">${esc(CHEST_INTRO)}</div>
        <label class="chest-auto"><input type="checkbox" id="chest-auto" ${this._auto ? 'checked' : ''}/> 自动开启（勾选后点击宝箱直接预览开启）</label>
        <div class="chest-grid" id="chest-grid"></div>
      </div>`);
    const grid = this.body.querySelector('#chest-grid');
    chests.forEach(c => {
      const isItem = String(c.isItemChest) === '1';
      const cell = document.createElement('div');
      cell.className = 'chest-cell';
      cell.innerHTML = `
        <div class="chest-ic">📦</div>
        <div class="chest-n">${esc(c.name || ('宝箱#' + c.id))}</div>
        <div class="chest-meta">ID ${esc(c.id || '?')} · ${isItem ? '道具宝箱' : '普通宝箱'}</div>
        <button class="chest-go pb-btn" type="button">${this._auto ? '开启' : '获取'}</button>`;
      cell.querySelector('.chest-go').onclick = () => this._act(c, isItem);
      grid.appendChild(cell);
    });
    const auto = this.body.querySelector('#chest-auto');
    auto.onchange = () => {
      this._auto = auto.checked;
      grid.querySelectorAll('.chest-go').forEach(b => { b.textContent = this._auto ? '开启' : '获取'; });
    };
  }
  _act(c, isItem) {
    if (!this._auto) {
      // 对应 AS3 sendChestItemGet：直接把宝箱道具入包
      this.ui.toast('已把「' + (c.name || c.id) + '」收入背包（掉落结果待协议逆向）');
      return;
    }
    // 对应 AS3 sendChestOpen(chestID, currentOpenPanel) → 打开 ChestPreopenPanel
    const p = this.ui.openPanel('chest-open');
    if (p && p.setChest) p.setChest(c);
    this.close();   // 镜像 buttonHandler 中的 this.close()
  }
}

export class ChestOpenPanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-chest-open', title: '开宝箱', width: 560, height: 480, ui }); this._chest = null; }
  init() { this.render(); }
  onOpen() { this.render(); }
  setChest(c) { this._chest = c; if (this.dom) this.render(); }
  render() {
    const c = this._chest;
    const name = c ? (c.name || ('宝箱#' + c.id)) : '宝箱';
    const isItem = c && String(c.isItemChest) === '1';
    // 18 格掉落预览：对应 AS3 initGridPointArr 的 6+1+5+1+5（共 18 个掉落位）
    const cells = Array.from({ length: 18 }, (_, i) => `<div class="chest-drop-cell" data-i="${i}"></div>`).join('');
    this.setContent(`
      <div class="cop-wrap">
        <div class="cop-head">
          <div class="cop-img">${imgWithFallback(url.res('panel_chest.png'), 'cop-img-el')}<span class="cop-img-fb">📦</span></div>
          <div class="cop-info">
            <div class="cop-name">${esc(name)}</div>
            <div class="cop-sub">${isItem ? '道具宝箱' : '普通宝箱'} · 开启将随机掉落</div>
          </div>
        </div>
        <div class="cop-tip">${esc(CHEST_INFO_1)}</div>
        <div class="cop-tip dim">${esc(CHEST_INFO_2)}</div>
        <div class="cop-grid">${cells}</div>
        <div class="cop-legend">掉落预览（共 18 格，对应 AS3 GRID_OPEN）。单机版掉落结果依赖协议 op131/132/226，当前尚未解析，故均为占位格。</div>
        <div class="cop-btns" id="cop-btns"></div>
      </div>`);
    const btns = this.body.querySelector('#cop-btns');
    // 对应 ChestPreopenPanel.initButtons：id0/1 = sendChestOpen(0,0/1) 开启；id2/3 = sendGetHigherChest(0/1) 获取
    const defs = [
      { t: '开启（普通）', k: 'open' },
      { t: '开启（祈福）', k: 'open2' },
      { t: '获取（祈福）', k: 'get' },
      { t: '获取（至尊）', k: 'get2' },
    ];
    defs.forEach(d => {
      const b = document.createElement('button');
      b.className = 'pb-btn cop-btn ' + (d.k.indexOf('open') === 0 ? 'cop-open' : 'cop-get');
      b.textContent = d.t;
      b.onclick = () => this._do(d.k);
      btns.appendChild(b);
    });
  }
  _do(kind) {
    const name = this._chest ? (this._chest.name || this._chest.id) : '宝箱';
    const verb = kind.indexOf('open') === 0 ? '开启' : '获取';
    this.ui.toast('已对「' + name + '」发起' + verb + '（掉落结果待协议逆向，演示仅还原交互）');
    this.close();
  }
}

export function registerGamePanels(panelManager, ui) {
  const defs = {
    shop: ShopPanel, npcshop: NpcShopPanel, warehouse: WarehousePanel, forge: ForgePanel,
    confirm: ConfirmPanel,         // AS3 PromptPanel：通用确认弹窗（复刻小金框 + 确认/取消）,
    worldmap: WorldMapPanel, minimap: MiniMapPanel, bestiary: BestiaryPanel, achv: AchievementPanel, settings: SettingsPanel,
    team: TeamPanel, battlelog: BattleLogPanel,
    // 新增面板（背靠 Config / 客户端状态，能实现的都实现）
    rank: RankPanel, title: TitlePanel, mount: MountPanel,
    emote: EmotePanel, activity: ActivityPanel,     skillbook: SkillBookPanel, help: HelpPanel,
    moncfg: MonsterConfigPanel, medal: MedalPanel,
    // 宝箱系统（对齐 AS3 ChestItemPanel + ChestPreopenPanel）
    chest: ChestPanel, 'chest-open': ChestOpenPanel,
  };
  for (const name in defs) {
    if (panelManager.factories[name]) continue;
    panelManager.register(name, () => new defs[name](ui));
  }
}
