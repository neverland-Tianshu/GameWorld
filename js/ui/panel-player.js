// panel-player.js
// 面板上栏过滤：去掉帮助按钮（panelbtnhelp 文字图 + 其左侧底图 panelbtnbg），只保留标题与关闭
export const PP_TOP_HIDE = (e) => !(e.r === 'panelbtnhelp' || (e.r === 'panelbtnbg' && e.x < 20));
// 角色主面板 —— 1:1 对齐 AS3（渲染数据由复现管线直出，不再手抄坐标）
//   AS3 源：deobfuscated/panel/property/PlayerPanel.as（extends MallPanel）
//           5 分页 TabView：ViewArm / ViewProperty / ViewHeart / ViewBagde / ViewEssence
//
// ★ 布局真源：js/ui/playerpanel-as3.js（AUTO-GENERATED）
//   由 _verify/gen_playerpanel_data.py 从 panels_repro/_composite/PlayerPanel.html
//   （as_sim 静态解释 AS3 的产物）导出，坐标已烘焙：
//     舞台 = PlayerPanel.rect = 295×465
//     分页绝对原点 = tabBar(19,45) + 分页 viewOffset（TabView.as:121 display2.addChild(display)）
//     元素 g 字段 = 归属的直接子面板变量名（内层 TabView 切显依据）
//   因此本文件**不再自算坐标**，只负责：
//     ① 把元素表画出来（IMG 用 AS3 真实资源图 / FRAME 内框 / TEXT 文字）
//     ② 给元素表里标记 ph=1 的「TextField 占位槽位」填游戏内真实数据
//     ③ 补画元素表覆盖不到的复合控件（BenplayerText 输入框、内层 TabView 页签条）
//
// 文字规则（与复现页 panels_repro 的 .tx 完全同口径）：
//   · 非 ph 槽位 → 逐字使用 as_sim 记录的 AS3 字面/文案（不美化、不改写）
//   · ph 槽位     → 填游戏数据；抓包未覆盖的填 '—'（铁律：不臆造），并给 title 标注 AS3 出典
//
// ⚠ 不触碰战斗系统。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import { player, CMD } from '../player/player.js?v=20261007c';
import { Fighter } from '../entities/fighter.js?v=20261007c';
import { PP_STAGE, PP_PANE, PP_TABS, PP_PAGES } from './playerpanel-as3.js?v=20261007c';
import { equipStats } from '../item/equip-stats.js?v=20261007c';          // 装备属性解析（desc → 数值表）
import { itemIconCandidates } from '../item/item-config.js?v=20261007c';  // 装备图标 URL 候选
import { showItemTip, hideItemTip, equipWear, wireIconFallback, wireItemDrag } from './panels.js?v=20261007c';  // AS3 富文本浮窗 + 穿脱装备 + 图标回退 + 拖拽

// 装备页 26 槽位（顺序严格对齐元素表坐标，来源 panels.js ARM_SLOTS 同一口径）：
//   19 个装备栏槽 + 法宝×6 + 如意；key 为存储键（多槽位部位带序号后缀）。
const ARM_SLOTS = [
  { key: '武器', img: 'panel_equip08' }, { key: '头饰', img: 'panel_equip00' },
  { key: '项链', img: 'panel_equip05' }, { key: '衣服', img: 'panel_equip01' },
  { key: '手镯1', img: 'panel_equip03' }, { key: '手镯2', img: 'panel_equip03' },
  { key: '腰带', img: 'panel_equip02' }, { key: '戒指1', img: 'panel_equip04' },
  { key: '戒指2', img: 'panel_equip04' }, { key: '裤子', img: 'panel_equip06' },
  { key: '鞋子', img: 'panel_equip07' }, { key: '首饰1', img: 'panel_equip10' },
  { key: '首饰2', img: 'panel_equip10' }, { key: '首饰3', img: 'panel_equip10' },
  { key: '首饰4', img: 'panel_equip10' }, { key: '时装', img: 'panel_equip09' },
  { key: '护肩', img: 'panel_equip11' }, { key: '披风', img: 'panel_equip12' },
  { key: '翅膀', img: 'panel_equip13' }, { key: '法宝1', img: 'panel_equip10' },
  { key: '法宝2', img: 'panel_equip10' }, { key: '法宝3', img: 'panel_equip10' },
  { key: '法宝4', img: 'panel_equip10' }, { key: '法宝5', img: 'panel_equip10' },
  { key: '法宝6', img: 'panel_equip10' }, { key: '如意', img: 'panel_equip10' },
];

// ── 装备页居中角色模型（站立循环，与操控主角同源）──
//   AS3 ViewArm：avatarCharacter = new CurrentPanelNpc(CHARACTER_PLAYER) 置于 (130,160)，
//   脚底锚点烘焙到舞台 (152,235) 附近；本实现用真实 Fighter 复刻——脚底 pin 到 .el(0,0)。
//   模型与操控主角共 charId + 纸娃娃(equip) + 完整渲染（身体/武器/纸娃娃/染色滤镜层全开），
//   但【朝向固定 RB、不跟随操控主角转向】；【不缩放】native=1，与主角主城态立绘一致。
const MODEL_FOOT = { x: 150, y: 300 };   // 脚底在 295×465 舞台的坐标（native 59×92 → 居中于装备框）

const cfg = () => Config.player_panel || {};
const L = (g, k) => ((cfg().layout || {})[g] || {})[k] || { x: 0, y: 0, w: 0, h: 0 };
const ZH = (k) => { const e = ((cfg().lang || {})[k] || {}); return e.zh && e.zh !== '【待填】' ? e.zh : null; };
const px = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DASH = '—';

// AS3 TextField.htmlText → DOM（size→font-size:px，color 由外层样式给，<a> 剥标签留文本，<br> 换行）
const rich = (s) => {
  const str = String(s == null ? '' : s);
  const re = /<a\b[^>]*>|<\/a>|<\/?[ubi]>|<font\b[^>]*>|<\/font>|<br\s*\/?>/gi;
  let out = '', last = 0, m;
  while ((m = re.exec(str))) {
    out += esc(str.slice(last, m.index));
    const raw = m[0];
    if (/^<\/(a|font)/i.test(raw)) out += /^<\/a/i.test(raw) ? '' : '</font>';
    else if (/^<br/i.test(raw)) out += '<br/>';
    else if (/^<a\b/i.test(raw)) out += '';
    else if (/^<\/?[ubi]>/i.test(raw)) out += raw.toLowerCase();
    else {
      const c = (raw.match(/color\s*=\s*["']?([#\w(),.%\s-]+)["']?/i) || [])[1];
      const z = (raw.match(/size\s*=\s*["']?(\d+)["']?/i) || [])[1];
      out += '<font' + (c ? ` color="${esc(c)}"` : '') + (z ? ` style="font-size:${z}px"` : '') + '>';
    }
    last = re.lastIndex;
  }
  return out + esc(str.slice(last));
};

const HEX = (c) => '#' + ('000000' + ((Number(c) | 0) >>> 0).toString(16)).slice(-6);
// 资源图 key → 真实路径（as_sim 已逐目录实测：资源名去下划线小写 + .png）
const IMG = (k) => url.res(String(k).replace(/_/g, '').toLowerCase() + '.png');

// 内层 TabView（ViewEssence.tabbar）：4 页签，几何取自 TabView.as（tabSpace=50，_space=0）
//   绝对原点 = ViewEssence 原点(19+(-4), 45+30) + tabbar.x(7) ⇒ (22,75)
const ESS_SUB = [
  { g: 'viewTalent', key: 'text_panel_talent', name: '天赋' },
  { g: 'viewDefender', key: 'text_panel_diling', name: '地灵' },
  { g: 'viewFiveElements', key: 'text_panel_fiveElements', name: '五行' },
  { g: 'viewAcupoint', key: 'text_panel_acupoint', name: '穴位' },
];
const ESS_SUB_ORIGIN = { x: 22, y: 75, w: 50, h: 24, pitch: 50 };

// ph 占位槽位 → AS3 出典（用于 title 提示；坐标 = 唯一键，来自元素表实测）
const SLOT_SRC = {
  arm: { '151,233': "CurrentPanelNpc.nameField（角色名，绿 14px）" },
  heart: { '27,207': "HeartList._textArea（HeartItemList_desc，当前心法说明）" },
  bagde: {
    '154,105': "ViewBagde.textField1", '154,165': "ViewBagde.textField2",
    '154,255': "ViewBagde.textField3", '144,395': "ViewBagde.deleteTip（红字提示）",
  },
  essence: {
    '20,321': "ViewTalent.levelText（天赋等级）",
    '168,115': "PlayerSprite._property",
    '113,80': "ViewAcupoint.acupointLevel（穴位等级）",
  },
};

export class PlayerPanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-player', title: '角色属性', width: PP_STAGE.w, height: PP_STAGE.h, ui,
      icon: { dir: 'res', file: 'faceportraitbg.png' },
    });
    this._init();
  }
  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._tab = 'arm';            // 外层页签（对齐复现页 __TABS__[0] selected）
    this._ess = ESS_SUB[0].g;     // ViewEssence 内层页签（默认天赋，与 AS3 createTab(0,true,...) 一致）
    this._fig = null;             // 装备页居中角色模型 Fighter（单例，随页签显隐 + 关闭销毁）
  }
  get sys() { return player(); }
  init() { this.render(); }
  onOpen() { this.refresh(); }
  refresh() { this._init(); this.render(); }

  // 面板自带标题/关闭图（AS3 在 PP_PANE 里）⇒ 隐藏 BasePanel 的 DOM 标题栏与关闭钮
  _layer() {
    if (this._pp) return this._pp;
    this.dom.classList.add('pp-asis');
    const d = document.createElement('div');
    d.className = 'pp-layer';
    this.dom.appendChild(d);
    this._pp = d;
    return d;
  }

  async _send(cmd, args, okMsg) {
    const r = await this.sys.net.request(cmd, args);
    if (r && r.sc && this.ui && this.ui.toast) this.ui.toast(okMsg || ('已收到 SC ' + r.sc));
    else if (okMsg && this.ui && this.ui.toast) this.ui.toast(okMsg);
    this.render();
  }

  // ───────────── 元素绘制 ─────────────
  // fill = 已解析好的文字（null ⇒ 用元素表里的 AS3 字面文案）
  _E(e, fill) {
    const st = `left:${e.x}px;top:${e.y}px`;
    // panelbtnbg4 按钮 → 纯 CSS 橙红拟物皮（.tsqt-btn-orange），整体缩到 90% 居中收缩避免拥挤；
    //   文字标签仍是独立元素（坐标不动），点击绑定不受影响
    if (e.k === 'IMG' && e.r === 'panelbtnbg4') {
      const w = e.w != null ? e.w : 0, h = e.h != null ? e.h : 0;
      const sw = Math.round(w * 0.9), sh = Math.round(h * 0.9);
      const st90 = `left:${e.x + Math.round((w - sw) / 2)}px;top:${e.y + Math.round((h - sh) / 2)}px`;
      return `<button class="pp-e tsqt-bar-btn tsqt-btn-orange" style="${st90};width:${sw}px;height:${sh}px;padding:0"></button>`;
    }
    if (e.k === 'IMG') {
      const wh = (e.w != null ? `;width:${e.w}px` : '') + (e.h != null ? `;height:${e.h}px` : '');
      // ★ 资源图走文档相对路径（url.res / IMG()）：e.r 是游戏资源 key，IMG(e.r) → update/i18n/.../icons/xxx.png
      //   （文档相对，根目录或 GitHub Pages 子路径部署均可解析）；e.u 兜底值同为该相对路径（playerpanel-as3.js 数据已改文档相对）。
      const src = e.r ? IMG(e.r) : (e.u || '');
      return `<img class="pp-e" src="${esc(src)}" alt="" data-res="${esc(e.r || '')}" style="${st}${wh}" onerror="this.style.visibility='hidden'"/>`;
    }
    if (e.k === 'FRAME') {
      const wh = (e.w != null ? `;width:${e.w}px` : '') + (e.h != null ? `;height:${e.h}px` : '');
      return `<i class="pp-e pp-fr" style="${st}${wh};border-color:${HEX(e.c == null ? 0x66471B : e.c)}"></i>`;
    }
    if (e.k === 'TEXT') {
      const s = e.s || 12;
      const w = e.w != null ? `;width:${e.w}px` : '';
      const txt = fill != null && fill !== '' ? fill : (e.ph ? DASH : esc(e.t || ''));
      const src = ((SLOT_SRC[this._tab] || {})[e.x + ',' + e.y]) || (e.key ? ('文案键 ' + e.key + '（Lang）') : '');
      return `<div class="pp-tx${e.ph ? ' dyn' : ''}" style="${st}${w};color:${HEX(e.c == null ? 0 : e.c)};`
        + `font-size:${s}px;line-height:${s + 2}px"${src ? ` title="${esc(src)}"` : ''}>${txt}</div>`;
    }
    return '';
  }

  // ───────────── 分层（内层 TabView 切显）─────────────
  _visible(e) {
    if (this._tab !== 'essence') return true;
    const g = e.g || '';
    return g === '' || g === this._ess;
  }

  // ViewEssence 消耗区（consumeSprite）只在天赋/地灵页显示（ViewEssence.tabHander case 2/3 → visible=false）
  _essConsumeShown() { return this._ess === 'viewTalent' || this._ess === 'viewDefender'; }

  // ───────────── 渲染主流程 ─────────────
  render() {
    this._init();
    const els = (PP_PAGES[this._tab] || []).filter((e) => this._visible(e));
    const slots = els.filter((e) => e.k === 'TEXT');
    const fills = this._fills(slots);

    let n = -1;
    const body = els.map((e) => (e.k === 'TEXT' ? this._E(e, fills[++n]) : this._E(e))).join('');

    const lay = this._layer();
    lay.innerHTML = `
      <div class="pp-top">${PP_PANE.filter(PP_TOP_HIDE).map((e) => this._E(e)).join('')}</div>
      <div class="pp-page" data-page="${this._tab}">
        ${body}
        ${this._extra(els)}
        <div class="pp-eq-layer">${this._equipLayer()}</div>
      </div>
      ${this._tabBar()}
      <div class="pp-note">元素表 1:1 来自 AS3 复现管线（playerpanel-as3.js）· 坐标未手抄</div>`;

    this._wire();
    this._syncModel();            // 装备页居中角色模型：随页签显隐
  }

  // 装备页：在 26 个槽位底图之上叠加【已穿戴装备的真实图标 + 拖拽落点】
  //   槽位坐标取自元素表（与 ARM_SLOTS 顺序一一对应）；属性取自 equip-stats 的 desc 解析结果。
  //   ★ 图标走与背包同一套多源回退链（itemIconCandidates + data-cands + wireIconFallback）：
  //     千机测试杖/新月法杖等图标只存在 update/ItemIcon0（链上第二个目录），
  //     旧版只取 cands[0] 并 onerror 隐藏 → 装上后图标直接消失。
  //   ★ 每个槽位包一层 .pp-dropzone：拖拽进行中（body.item-dragging）才接收事件，
  //     平时点击穿透到底图/图标，不影响既有悬停与点击。
  _equipLayer() {
    if (this._tab !== 'arm') return '';
    const els = PP_PAGES['arm'] || [];
    const slotImgs = els.filter((e) => e.k === 'IMG' && /^panel_equip\d+$/.test(e.r || ''));
    const eq = (this.sys && this.sys.equip) || {};
    return slotImgs.map((e, i) => {
      const slot = ARM_SLOTS[i];
      if (!slot) return '';
      const w = e.w || 36, h = e.h || 36;
      const itemId = eq[slot.key];
      const cands = (itemId != null && itemId !== '') ? itemIconCandidates(itemId) : [];
      const icon = cands.length
        ? `<img class="pp-e pp-eq" src="${esc(cands[0])}" alt="" draggable="false"`
          + ` data-cands="${esc(cands.join('|'))}"`
          + ` data-slot="${esc(slot.key)}" data-item="${esc(itemId)}"`
          + ` style="left:2px;top:2px;width:${w - 4}px;height:${h - 4}px"/>`
        : '';
      return `<div class="pp-dropzone" data-slot="${esc(slot.key)}"`
        + ` style="left:${e.x}px;top:${e.y}px;width:${w}px;height:${h}px">${icon}</div>`;
    }).join('');
  }

  // 装备属性明细（title 提示）：名称 + 部位 + 逐条属性
  _tabBar() {
    return `<div class="pp-tabs">${PP_TABS.map((t, i) => `
      <button class="pp-tab tsqt-tab-item${this._tab === t.id ? ' on active' : ''}" data-tab="${t.id}"
              style="left:${19 + i * 51}px;top:45px;width:50px;height:24px">
        <img class="pp-tab-lb" src="${IMG(t.key)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/>
        <span class="pp-tab-tx" style="display:none">${esc(t.name)}</span>
      </button>`).join('')}</div>`;
  }

  // ───────────── ph 槽位填数 ─────────────
  _fills(slots) {
    const st = this.sys;
    const out = slots.map(() => null);
    const ph = [];                       // ph 槽位在 slots 中的下标（保持元素表顺序）
    slots.forEach((e, i) => { if (e.ph) ph.push(i); });
    const set = (k, v) => { if (ph[k] != null) out[ph[k]] = v; };

    if (this._tab === 'arm') {
      // 唯一 ph 槽位 = avatarCharacter(CurrentPanelNpc).nameField（绿色角色名）
      set(0, esc(st.profile.name || DASH));
      return out;
    }

    if (this._tab === 'prop') {
      // ViewProperty：38 项属性，可见 31 行（ARM_CONTRAL/ARM_WEEK 两组 flag=false 不入显示列表）
      // 元素表顺序 = 逐行 [名称, 数值]，故 ph[k] 即 propItems[k] 的数值
      const items = cfg().propItems || [];
      ph.forEach((si, k) => {
        const it = items[k];
        if (!it) { out[si] = DASH; return; }
        const v = st.propVal(it);
        const pend = Number(st.pendingPoints[it.v1]) || 0;
        out[si] = esc(String(v)) + (pend ? `<font color="#ffd67a">(+${pend})</font>` : '');
      });
      return out;
    }

    if (this._tab === 'heart') {
      // 说明区（_heartList._textArea）填「灵修等级」——真实模型字段 profile.heartBonus
      //   （8 心法各自数值改由 _extra 渲染在 panelheartXX 图标下方，接 st.hearts）
      set(0, '灵修 Lv.' + esc(st.profile.heartBonus || DASH));
      return out;
    }

    if (this._tab === 'bagde') {
      // ViewBagde.textField1/2/3 = 徽章数量/获取方式/说明；deleteTip = 红字报错
      // 抓包（op20_SC_ROLE_INFO.csv）未覆盖徽章明细 ⇒ 前三格 '—'，报错位留空（AS3 初始即为空）
      set(0, DASH); set(1, DASH); set(2, DASH); set(3, '');
      return out;
    }

    if (this._tab === 'essence') {
      // 五行 5 个 '0' 计数槽位（viewFiveElements 组，t==='0'）→ 接真实模型 field92~96（st.fiveElements）
      const fe = st.fiveElements || [];
      let fi = 0;
      slots.forEach((e, i) => {
        if (e.g === 'viewFiveElements' && e.t === '0') { out[i] = esc(fe[fi] == null ? DASH : fe[fi]); fi++; }
      });
      // ph 槽位：天赋等级(viewTalent) / PlayerSprite 属性(viewAcupoint) / 穴位等级(viewAcupoint)
      //   —— 均依赖 SC 下发（sendUpGradeInhereLevel / updateAcupoint），profile 无对应字段 ⇒ 保持 —（不臆造）
      ph.forEach((si) => { out[si] = DASH; });
      return out;
    }
    return out;
  }

  // ───────────── 元素表覆盖不到的复合控件 ─────────────
  // BenplayerText：AS3 里是「文字底图 + 输入框 + 标签」的复合 Sprite，as_sim 不产出 TEXT，
  // 故按 AS3 构造参数还原可见框（无标签分支：textBg.x=59，sprite.x = -59 ⇒ 可见左边界 = 0）
  _input(x, y, w, h, extra, ph) {
    return `<input class="pp-input" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" `
      + `placeholder="${esc(ph || '')}" ${extra || ''} autocomplete="off"/>`;
  }
  _extra(els) {
    const st = this.sys;
    if (this._tab === 'heart') {
      // 8 心法数值：元素表只画了 panelheartXX 图标（_heartList 组），数值由 HeartList 动态渲染，
      //   as_sim 不产出 ⇒ 在此按「图标坐标 → 数值」接真实模型 st.hearts（profile.braveHeart…）
      const pos = [[116, 107], [156, 107], [196, 107], [236, 107], [116, 160], [156, 160], [196, 160], [236, 160]];
      const hs = st.hearts;
      return hs.map((h, i) => {
        const [x, y] = pos[i] || [12, 12 + i * 22];
        const v = h.v == null || h.v === '' ? DASH : h.v;
        return `<div class="pp-hv" style="left:${x}px;top:${y}px;position:absolute;font:12px SimSun,serif;color:#ffd67a;text-align:center;width:34px;text-shadow:0 0 2px rgba(0,0,0,.6)">${esc(v)}</div>`;
      }).join('');
    }
    if (this._tab === 'prop') {
      const G = (k) => L('ViewProperty', 'ViewProperty_' + k);
      const EI = G('expInput'), NI = G('nameInput');
      const left = (r) => px(r.x) + 59;       // BenplayerText 无标签分支的可见偏移
      const vo = PP_TABS.find((t) => t.id === 'prop');
      const X = vo.ox, Y = vo.oy;
      return this._input(X + left(EI), Y + px(EI.y), px(EI.w) || 194, 19,
        `id="pp-exp" value="${esc(st.profile.expCur || '')}/${esc(st.profile.expMax || '')}" readonly`, '经验')
        + this._input(X + left(NI), Y + px(NI.y), px(NI.w) || 194, 19,
          `id="pp-name" value="${esc(st.profile.name || '')}"`, '角色名');
    }
    if (this._tab === 'essence') {
      const c = this._essConsumeShown();
      const vo = PP_TABS.find((t) => t.id === 'essence');
      const subBar = ESS_SUB.map((s, i) => `
        <button class="pp-subtab tsqt-tab-item${this._ess === s.g ? ' on active' : ''}" data-sub="${s.g}"
                style="left:${ESS_SUB_ORIGIN.x + i * ESS_SUB_ORIGIN.pitch}px;top:${ESS_SUB_ORIGIN.y}px;`
          + `width:${ESS_SUB_ORIGIN.w}px;height:${ESS_SUB_ORIGIN.h}px">
          <img class="pp-tab-lb" src="${IMG(s.key)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/>
          <span class="pp-tab-tx" style="display:none">${esc(s.name)}</span>
        </button>`).join('');
      const row = c
        ? this._input(vo.ox + (-57 + 59), vo.oy + 315, 109, 19, 'id="pp-ess-need" readonly',
            rich(ZH('ESSENCE_UPGRADE_NEED') || '所需精华'))
        + this._input(vo.ox + (68 + 59), vo.oy + 315, 126, 19, `id="pp-ess-curr" readonly value="${esc(st.essenceTotal != null ? st.essenceTotal : DASH)}"`,
            rich(ZH('ESSENCE_CURR') || '当前精华'))
        + this._input(vo.ox + 53, vo.oy + 340, 110, 19, 'id="pp-ess-money"', '银两')
        : '';
      return row + subBar;
    }
    return '';
  }

  // ───────────── 装备页居中角色模型（与操控主角同源）─────────────
  // PlayerPanel 是单例（close 仅隐藏实例、不销毁），故模型 Fighter 也常驻 this._fig，按页签显隐 + 关闭销毁。
  // 复用游戏内 Fighter（与场景主角同一套渲染管线）→ 同 charId + 同朝向 + 同纸娃娃(equip) + 站立循环。
  _ensureModel() {
    if (this._fig) return this._fig;
    const p = this.ui && this.ui.player;
    const st = this.sys;
    const charId = (p && p.charId) || (st && st.profile && st.profile.charId) || 135002;
    const dir = 'RB';   // 固定 RB：展示模型独立，不跟随操控主角转向
    const fig = new Fighter({
      id: charId, name: (st && st.profile && st.profile.name) || '主角',
      charId, dir, side: 'player',
      equip: (st && st.equip && typeof st.equip === 'object') ? st.equip : null,  // 与操控主角一致的纸娃娃
      showBars: false, hpAbove: false, z: 0,
    });
    // 面板里只显示立绘：隐藏原点红叉 / 名字 / 血条 / 状态层
    if (fig.originEl) fig.originEl.style.display = 'none';
    if (fig.nameEl) { fig.nameEl.style.visibility = 'hidden'; fig.nameEl.style.display = 'none'; }
    if (fig.hpBar) { fig.hpBar.style.display = 'none'; fig.hpBar.style.visibility = 'hidden'; }
    if (fig._statusLayer) fig._statusLayer.style.display = 'none';
    fig.el.classList.add('pp-figure');
    fig.setPos(MODEL_FOOT.x, MODEL_FOOT.y);
    this._fig = fig;
    fig.act('stand', dir);   // 站立循环（native 缩放，与主角主城态一致；异步加载资源，加载完即播放）
    return fig;
  }

  // 按当前页签挂/摘模型：装备页显示，其余页摘离（画布由 loader 巡检暂停，避免 Timer 泄漏）
  _syncModel() {
    const lay = this._pp;
    if (!lay) return;
    if (this.dom && this.dom.style.display === 'none') return;   // 面板隐藏中：不重建模型
    if (this._tab === 'arm') {
      const fig = this._ensureModel();
      const page = lay.querySelector('.pp-page');
      if (page) {
        // 插到 .pp-page 最前，使装备槽底图(IMG) 在模型透明留白之上、互不遮挡
        if (fig.el.parentNode !== page) page.insertBefore(fig.el, page.firstChild);
        this._syncFigEquip();          // 换绑纸娃娃字典（面板关闭/隐藏期间发生的换装在此补上）
        this._resumeModel(fig);
      }
    } else if (this._fig && this._fig.el && this._fig.el.parentNode) {
      this._fig.el.parentNode.removeChild(this._fig.el);
    }
  }

  // ★ 装备页模型是独立 Fighter 实例，而 commit()（player-bridge projectToPlayer）每次写档都会
  //   用【新对象】替换 player.equip。若不换绑，装备页模型会一直捏着旧字典 →
  //   地图主角换装即时生效（applyEquip→refreshPaperDoll），装备页立绘却停留在旧装备（新月法杖/翅膀不切换）。
  //   铁律⑱：换权威对象必须同时换绑消费者。
  _syncFigEquip() {
    const fig = this._fig;
    if (!fig) return;
    const st = this.sys;
    const eq = (st && st.equip && typeof st.equip === 'object') ? st.equip : null;
    if (!eq || fig.equip === eq) return;          // 已是最新字典
    fig.equip = eq;
    try { fig.refreshPaperDoll(); } catch (e) { console.warn('[pp] 装备页纸娃娃刷新失败', e); }
  }

  // 画布在隐藏期间被 loader 巡检暂停 → 重新挂 DOM 后强制重播（清 _current 让 act 重新 mount）
  _resumeModel(fig) {
    const cv = fig._fanvasCanvas;
    if (!cv) return;                 // 仍在首次加载：_ensureModel 的 act 会接管
    if (cv.isConnected) return;      // 已在播
    fig._current = null;
    fig.act('stand', fig.dir);   // native 缩放重播
  }

  // 关闭面板：销毁居中模型，停掉 fanvas Timer（避免泄漏）；下次打开再重建
  onClose() {
    if (this._fig) { try { this._fig.destroy(); } catch (e) {} this._fig = null; }
  }

  // ───────────── 事件 ─────────────
  _wire() {
    const st = this.sys;
    const lay = this._pp;
    if (!lay) return;
    const A = (sel, fn) => lay.querySelectorAll(sel).forEach(fn);

    A('[data-tab]', (b) => { b.onclick = () => { this._tab = b.dataset.tab; this.render(); }; });
    A('[data-sub]', (b) => { b.onclick = () => { this._ess = b.dataset.sub; this.render(); }; });

    // 顶部关闭（PP_PANE 内 panelbtnclose）——帮助按钮已按需求移除
    A('.pp-top img.pp-e', (im) => {
      if (/panelbtnclose/.test(im.src)) { im.classList.add('pp-hit'); im.onclick = () => this.close(); }

    });

    if (this._tab === 'arm') {
      // 已穿戴装备的图标：点击显示真实属性明细；右键直接脱下（绑定逻辑见 _wireEquipLayer）
      this._wireEquipLayer();
      // 空装备槽底图：提示槽位名（明细抓包未覆盖）
      A('.pp-page img.pp-e[data-res^="paneelequip"], .pp-page img.pp-e[data-res^="panel_equip"]', (im) => {
        im.classList.add('pp-hit');
        const key = im.dataset.res;
        im.onclick = () => this.ui && this.ui.toast('装备槽 ' + String(key).replace(/panel_?equip/i, '') + '（未穿戴）');
      });
      // 八卦按钮（ViewArm: new ViewButton(1,58,245,"panel_bagua_baguaBtn")）
      A('.pp-page img.pp-e[data-res*="baguabaguabtn"]', (im) => {
        im.classList.add('pp-hit');
        im.onclick = () => this.ui && this.ui.toast('八卦（原版打开八卦面板）');
      });
    }

    if (this._tab === 'prop') {
      // 加点/洗点（ViewProperty.addProperty → panel_btn_add / panel_btn_cut，id=属性 key）
      // AS3：propArray[8..12]（strong/vitality/agile/intellect/belief）带 addpoint=1 ⇒ 5 对按钮
      const items = cfg().propItems || [];
      const bumpKeys = items.slice(8, 13).map((it) => it.v1).filter(Boolean);
      A('.pp-page img.pp-e[data-res="panelbtnadd"]', (im, i) => {
        im.classList.add('pp-hit');
        im.onclick = () => {
          const k = bumpKeys[i] || this._bumpKey || 'strong';
          if (st.bump(k, 1)) this.render(); else if (this.ui && this.ui.toast) this.ui.toast('潜力不足');
        };
      });
      A('.pp-page img.pp-e[data-res="panelbtncut"]', (im, i) => {
        im.classList.add('pp-hit');
        im.onclick = () => {
          const k = bumpKeys[i] || this._bumpKey || 'strong';
          if (st.bump(k, -1)) this.render(); else if (this.ui && this.ui.toast) this.ui.toast('无可撤销分配');
        };
      });
      // 底部 6 个功能按钮（ViewProperty.initButton）
      const BTN = [
        ['textpanelguardguard', '守护（GUARDPANEL_OPEN → sendGuardData）', null],
        ['textpanelconfirm3', '确认加点（BUTTON_ACCEPT → sendApplyPoint）', 'APPLY'],
        ['textpanelhero', '伙伴（BUTTON_PARTNER → sendRecruitPartner）', null],
        ['textpanelresistance', '抗性（BUTTON_PROPERTY_RES → sendResistance）', null],
        ['textpanelprestigelist', '声望（BUTTON_PRESTIGE → 开关声望面板）', null],
        ['textpanelchangetitle', '改名 / 称号（BUTTON_MOD_NICKNAME → 称号·成就列表）', 'RENAME'],
      ];
      A('.pp-page img.pp-e[data-res^="textpanel"]', (im) => {
        const hit = BTN.find((b) => im.dataset.res === b[0]);
        if (!hit) return;
        im.classList.add('pp-hit');
        im.onclick = () => {
          if (hit[2] === 'APPLY') {
            this._send(CMD.APPLY_POINT, { cid: st.profile.cid, pending: st.pendingPoints }, '已提交潜力分配（APPLY_POINT）');
            return;
          }
          if (hit[2] === 'RENAME') {
            const inp = lay.querySelector('#pp-name');
            if (inp && inp.value) { st.profile.name = inp.value.slice(0, 12); if (this.ui && this.ui.toast) this.ui.toast('改名（本地演示，未走协议）'); }
            this.render(); return;
          }
          if (this.ui && this.ui.toast) this.ui.toast(hit[1]);
        };
      });
    }

    if (this._tab === 'heart') {
      // ViewHeart.btn_lingxiu（panel_lingxiu_start → sendLingXiuMSG(6)）
      A('.pp-page img.pp-e[data-res*="lingxiustart"]', (im) => {
        im.classList.add('pp-hit');
        im.onclick = () => this._send(CMD.UPGRADE_HEART, { cid: st.profile.cid }, '已请求灵修升级（CS 189）');
      });
    }

    if (this._tab === 'essence') {
      // ViewEssence.upButton（text_panel_heartLearn → sendUpGradeInhereLevel(0)）
      A('.pp-page img.pp-e[data-res^="textpanel"]', (im) => {
        im.classList.add('pp-hit');
        im.onclick = () => this._send(CMD.BAGUA_UPGRADE, { cid: st.profile.cid }, '已请求元神升级（CS_BAGUA_UPGRADE 949）');
      });
      // ViewAcupoint 穴位按钮：抓包未覆盖
      A('.pp-page img.pp-e[data-res*="acupointbutton"]', (im) => {
        im.classList.add('pp-hit');
        im.onclick = () => this.ui && this.ui.toast('穴位（明细抓包未覆盖）');
      });
    }

    // 装备图标多源回退：cands[0] 失败逐级换源（与背包面板同链，不再一失败就隐藏）
    wireIconFallback(lay);
  }

  // 装备页图标的交互绑定（穿脱/悬停/点击），_wire 与 _refreshEquip 共用。
  //   scope 限定查询范围，避免重绑时选到已脱离文档的旧节点。
  //   ★ 本方法【只绑交互事件】，不绑图标多源回退（wireIconFallback）：
  //     _wire() 末尾会对整个 lay 统一调一次 wireIconFallback，若这里也调，
  //     同一 img 的 error listener 会被绑两次 → 一次 404 连推进两步、
  //     跳过链上真正可用的源（如 update/ItemIcon0 的 Item_<image>.png），
  //     最终错误地走到末位 visibility:hidden（「切页后图标不显示」的根因）。
  //     _refreshEquip 走本方法时，由它在调用后单独补一次 wireIconFallback(holder)。
  _wireEquipLayer(scope) {
    const lay = scope || this._pp;
    if (!lay) return;
    const A = (sel, fn) => lay.querySelectorAll(sel).forEach(fn);
    A('img.pp-eq[data-slot]', (im) => {
      im.classList.add('pp-hit');
      const itemId = im.dataset.item;
      const slot = im.dataset.slot;
      // 悬停 → AS3 富文本浮窗（对齐 LoadSprite.getInfo + PromptFace.showInfoPrompt）
      im.onmouseenter = () => {
        const def = (Config.items || {})[String(itemId)] || { name: '#' + itemId, desc: '' };
        showItemTip(def, this.ui && this.ui.player, im);
      };
      im.onmouseleave = hideItemTip;
      // 右键 = 脱下（对齐背包右键=使用的操作口径；脱下后装备自动放回背包）
      im.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideItemTip();
        equipWear(this.ui, slot, null, false);   // 内部会局部刷新装备层 + 背包面板
      };
      // 拖拽 = 拖到背包格脱下 / 拖到其它装备槽换装（与背包拖拽同一套管线，鼠标+触屏通用）
      const def = (Config.items || {})[String(itemId)] || { id: itemId, name: '#' + itemId, desc: '' };
      wireItemDrag(im, def, 'equip', { ui: this.ui, slot }, null);
      // 点击 = 显示真实属性明细（equip-stats 解析结果）
      im.onclick = () => {
        const st = equipStats(itemId);
        const it = (Config.items || {})[String(itemId)];
        const nm = it ? it.name : ('#' + itemId);
        if (!st) { this.ui && this.ui.toast(nm + '（无属性）'); return; }
        const ZH = {
          strength: '强壮', stamina: '耐力', agility: '敏捷', intellect: '智力', faith: '信仰',
          maxHp: 'HP上限', maxMp: 'MP上限', spd: '速度', recover: '恢复',
          atk: '物攻', def: '物防', mag: '法攻', magDef: '法防',
          phyHit: '物命', phyDodge: '物闪', phyCrit: '物暴',
          magHit: '法命', magDodge: '法闪', magCrit: '法暴', crit: '爆击',
        };
        const parts = [];
        for (const k of Object.keys(st)) {
          if (k === '_permille') continue;
          parts.push('+' + st[k] + ' ' + (ZH[k] || k));
        }
        this.ui && this.ui.toast(nm + '（' + slot + '）：' + parts.join(' '));
      };
    });
  }

  // 穿脱后【只重绘装备层】，不整面板 render（避免模型重挂/全部元素重绑导致的整体闪烁）
  //   调用方：panels.js equipWear 的局部刷新路径（cp._refreshEquip）
  _refreshEquip() {
    const lay = this._pp;
    if (!lay || this._tab !== 'arm') return;
    const holder = lay.querySelector('.pp-eq-layer');
    if (!holder) return;
    hideItemTip();
    holder.innerHTML = this._equipLayer();
    this._wireEquipLayer(holder);
    wireIconFallback(holder);   // 装备层局部重绘：回退链单独绑一次（_wire 路径不走这里，不会重复）
    // 居中模型也用了 equip 纸娃娃：换装后刷新立绘（不重建 Fighter，只换绑字典 + 重建装备层 + 重放当前动作）
    if (this._fig) {
      this._syncFigEquip();
      this._resumeModel(this._fig);
    }
  }
}

export function registerPlayerPanel(panelManager, ui) {
  panelManager.register('playerpanel', () => new PlayerPanel(ui));
}



