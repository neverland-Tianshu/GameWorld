// panel-ridepet-advance.js
// 骑宠进阶面板 —— 1:1 对齐 AS3
//   deobfuscated/panel/property/ridePet/RidePetAdvancePanel.as（5 页签 TabView：信息/仙丹/技能/命格/天赋）
//
// ★ 坐标模型（关键，别再搞错）：
//   RidePetAdvancePanel extends MallPanel；子视图 RidePetInfo/RidePetWuRate/ViewRidePetSkill/RidePetFate/RidePetTalent
//   由 TabView.createTab(value, flag, text, display, display2=this.tabBar, ...) 挂载 ⇒
//   TabView.as:121 `display2.addChild(display)` ⇒ **子视图的原点 = tabBar 的原点**，
//   而 tabBar 由 RidePetAdvancePanel.initTab 定位在 layout("RidePetAdvancePanel_tab") = (12,45)。
//   ⇒ 子视图内所有 layout 坐标都要再叠加 tabBar 原点 (12,45)。
//   panel 自身原点 = stage(295×500 = bgWidth/bgHeight) 的左上角；frame / tabBar 直接位于该空间。
//
//   各子视图内部坐标一律取自 layout.xml（config/ridepet_advance.json → layout.*），不做视觉臆造；
//   未覆盖的运行时数据以「抓包未覆盖 / 未臆造」文案占位。
//
// 资源图真源：config.res（生成时逐目录实测 AS3 取图顺序 resource→loginResource→resource1→resource2）。
// ⚠ 不触碰战斗系统。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import {
  ridePetAdvance, CMD, CACHE_TYPE, INFO_PROPS, WU_PROPS, ZH, BP_KEYS,
} from '../pet/ridepet-advance.js?v=20261007c';

const CFG = () => Config.ridepet_advance || {};
const L = (g, k) => ((CFG().layout || {})[g] || {})[k] || { x: 0, y: 0, w: 0, h: 0 };
const IMG = (k) => {
  const e = (CFG().res || {})[k];
  const dir = (e && e.dir) || 'res';
  const file = (e && e.file) || String(k).replace(/_/g, '').toLowerCase() + '.png';
  return (url[dir] || url.res)(file);
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// AS3 TextField.htmlText 语义：Lang 文案与服务端下发值含 <font color=/<font size=/>/<br>，NPC 链接用 <a href="event:...">。
// 映射规则（DOM 与 AS3 的差异必须显式转换，否则会走样）：
//   <font size='12'> → <font style="font-size:12px">（HTML 的 size 属性是 1..7 档位，直接透传会被当成最大号 ⇒ 文字巨大）
//   <a href='event:...'>…</a> → 剥标签留文本（避免任意 href 注入；原版点击跳 NPC 详情，属非本面板范围）
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
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const px = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// AS3 用 TextField.textWidth 决定「值」列起点（addProperty: 值.x = prop.x + 名称.textWidth + 10）。
// 12px 宋体度量：CJK/全角 = 12px，ASCII/半角 = 6px（与 panels_repro 解释器的口径一致：
// "类    型:" → 12+4*6+12+6 = 54 ⇒ 值列 = 15+54+10 = 79，已与复现页解析结果逐值核对）。
const textW = (s, size = 12) => [...String(s == null ? '' : s)]
  .reduce((a, ch) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? size : size / 2), 0);

// tabBar 原点（TabView.createTab 把子视图 addChild 到 tabBar ⇒ 子视图坐标基准）
const TB = () => { const t = L('RidePetAdvancePanel', 'RidePetAdvancePanel_tab'); return { x: px(t.x), y: px(t.y) }; };
const A = (r) => ({ x: TB().x + px(r.x), y: TB().y + px(r.y) });

// 5 个页签（RidePetAdvancePanel.initTab，标签为资源图 text_panel_*）
const TABS = [
  { id: 0, key: 'text_panel_player_property', name: '信息' },
  { id: 1, key: 'text_panel_petWu', name: '仙丹' },
  { id: 2, key: 'text_panel_pet_skill', name: '技能' },
  { id: 3, key: 'text_panel_fateTabBtn', name: '命格' },
  { id: 4, key: 'text_panel_talentBtn', name: '天赋' },
];
// 技能页内丹子页签（ViewRidePetSkill.initTab：两个 createTab 均用 text_panel_ridepet_ningshen 图）
const SKILL_TABS = [
  { id: 0, key: 'text_panel_ridepet_ningshen', name: '凝神丹' },
  { id: 1, key: 'text_panel_ridepet_ningshen', name: '其他丹' },
];
// ViewRidePetSkill.grid：SKILL_COUNT_ROW=2 / SKILL_COUNT_COL=5，格尺寸 = grid.width/height = 48×45
const GRID_COL = 5, GRID_ROW = 2;
// NingshenDan 绘制偏移（源码 selectFrame.x = point.x + 8 / y = point.y + 81 ⇒ 格位实际落点）
const DAN_DX = 8, DAN_DY = 81;

export class RidePetAdvancePanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-ridepet-advance', title: '骑宠进阶', width: 375, height: 660, ui,
      icon: { dir: 'res', file: 'panelridepetbg.png' },
    });
    this._init();
  }
  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._tab = 0;
    this._skillTab = 0;
    this._logOpen = false;
    this._busy = false;
    this._wuUse = 5;        // _useComboBox.selectedItem.data（5 完美 / 4 卓越）
    this._wuLevel = 1;      // _wuUpComboBox 档位（initBPData 1..20）
    this._autoStop = true;  // _autoStopCheckBox.selected（AS3 默认 true）
    this._kind = null;      // 选中的悟性丹
  }
  get sys() { return ridePetAdvance(); }
  init() { this.render(); }
  onOpen() { this.refresh(); }
  refresh() { this._init(); this.render(); }

  async _send(cmd, args, okMsg) {
    if (this._busy) return;
    this._busy = true;
    try {
      const r = await this.sys.net.request(cmd, args);
      if (r && r.msg && this.ui && this.ui.toast) this.ui.toast(r.msg);
      else if (okMsg && this.ui && this.ui.toast) this.ui.toast(okMsg);
      this.render();
    } finally { this._busy = false; }
  }

  render() {
    this._init();
    const st = this.sys.state;
    const box = L('RidePetAdvancePanel', 'RidePetAdvancePanel');
    const W = box.w || 295, H = box.h || 500;
    const tab = L('RidePetAdvancePanel', 'RidePetAdvancePanel_tab');
    const fr = L('RidePetAdvancePanel', 'RidePetAdvancePanel_frame');
    // tabButton 宽 = tab.width(51)；TabView._space 默认 1 ⇒ 步进 52（createTab 累加规则）
    const step = (tab.w || 51) + 1;

    this.setContent(`
      <div class="rpa-wrap">
        <div class="rpa-sel">
          <label>骑宠</label>
          <select id="rpa-rp">
            ${st.list.map(r => `<option value="${esc(r.ridePetID)}" ${String(r.ridePetID) === st.selectedId ? 'selected' : ''}>${esc(r.name)} Lv.${num(r.level)}</option>`).join('')}
          </select>
          <span class="rpa-hint">selectedRidePetID = <b>${esc(st.selectedId || '(空)')}</b></span>
        </div>
        <div class="rpa-stage" style="width:${W}px;height:${H}px">
          <div class="rpa-frame-out" style="left:${px(fr.x)}px;top:${px(fr.y)}px;width:${px(fr.w)}px;height:${px(fr.h)}px"></div>
          <div class="rpa-tabs" style="left:${px(tab.x)}px;top:${px(tab.y)}px">
            ${TABS.map((t, i) => `<button class="rpa-tab${this._tab === t.id ? ' on' : ''}" data-tab="${t.id}" style="left:${i * step}px;width:${px(tab.w)}px" title="${esc(t.name)}">
              <img src="${IMG(t.key)}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/>
              <span>${esc(t.name)}</span></button>`).join('')}
          </div>
          <div class="rpa-body">${this._tabHtml()}</div>
        </div>
        <div class="rpa-log">
          <div class="rpa-log-h" id="rpa-log-t">数据流 / 协议流水（${st.log.length}）${this._logOpen ? '▾' : '▸'}</div>
          <div class="rpa-log-b" style="display:${this._logOpen ? 'block' : 'none'}">
            ${st.log.length ? st.log.map(l => `<div class="rpa-log-r"><b class="${l.dir}">${l.dir}</b><span>${l.op}</span><i>${esc(JSON.stringify(l.payload).slice(0, 110))}</i></div>`).join('') : '<div class="rpa-empty">暂无协议交互</div>'}
          </div>
        </div>
      </div>`);

    const sel = this.body.querySelector('#rpa-rp');
    if (sel) sel.onchange = () => { this.sys.state.selectedId = String(sel.value); this.render(); };
    this.body.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { this._tab = Number(b.dataset.tab); this.render(); }; });
    const lt = this.body.querySelector('#rpa-log-t');
    if (lt) lt.onclick = () => { this._logOpen = !this._logOpen; this.render(); };
    this._wireTab();
  }

  _tabHtml() {
    switch (this._tab) {
      case 0: return this._infoHtml();
      case 1: return this._wuRateHtml();
      case 2: return this._skillHtml();
      case 3: return this._fateHtml();
      case 4: return this._talentHtml();
      default: return '';
    }
  }

  _btn(id, key, a, w, h, label) {
    return `<button class="rpa-btn" id="${id}" style="left:${a.x}px;top:${a.y}px;width:${w}px;height:${h}px">
      <img src="${IMG(key)}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/><span>${esc(label)}</span></button>`;
  }
  _frame(r) {
    const a = A(r);
    return `<div class="rpa-fr" style="left:${a.x}px;top:${a.y}px;width:${px(r.w)}px;height:${px(r.h)}px"></div>`;
  }

  // ══════════ Tab 0 · RidePetInfo ══════════
  // 帧：initFrame addChild frame1..frame4（frame5 源码未 addChild，不画）
  // 属性：initPropertyBg 10× TextBg(10, 30 + i*22,250×22) + addProperty 名称(15,32+i*22) / 值(x = 15 + 名称宽 + 10)
  _infoHtml() {
    const G = (k) => L('ViewRidePetInfo', 'ViewRidePetInfo_' + k);
    const U = (k) => L('ViewPetUnderstanding', 'ViewPetUnderstanding_' + k);
    const st = this.sys.state;
    const p = st.cur;
    const bg = G('propBg'), pr = G('prop'), desc = G('desc'), lock = G('lockBtn'), sk = G('shortkeyBtn');
    const locked = !!st.locked.get(st.selectedId);

    // 悟性操作区：_sprite(50,260)，子项坐标见 initUnderStanding / initComboBox
    const spr = { x: 50, y: 260 };
    const useCB = A({ x: spr.x, y: spr.y });                             // _useComboBox (0,0)
    const wuCB = A({ x: spr.x + 28, y: spr.y + 22 });                    // _wuUpComboBox (28,22)
    const autoUp = A({ x: spr.x + 127, y: spr.y + 12 });                 // ViewButton(AUTO_UP,127,12)
    const upBtn = A({ x: spr.x + 127, y: spr.y + 50 });                  // ViewButton(UP,127,50)
    const put = A({ x: spr.x - 30, y: spr.y + 47 });                     // initGrids：_putGrid = sprite + (-30,+47)
    const pp = L('ViewPetInfo_point', 'ViewPetInfo_point');
    const putPt = { x: put.x + px(pp.x), y: put.y + px(pp.y) };

    return `
      <div class="rpa-sub">
        ${this._frame(G('frame1'))}${this._frame(G('frame2'))}${this._frame(G('frame3'))}${this._frame(G('frame4'))}
        <!-- 10 行属性：TextBg(10,30+i*22,250×22) + 名称(15,32+i*22) + 值(15+名称宽+10) -->
        ${INFO_PROPS.map((it, i) => {
          const row = A({ x: bg.x, y: bg.y + i * bg.h });
          const nameW = textW(ZH(it.zh));   // AS3：值.x = prop.x + 名称.textWidth + 10
          const nm = A({ x: pr.x, y: pr.y + i * bg.h });
          return `<div class="rpa-prow" style="left:${row.x}px;top:${row.y}px;width:${px(bg.w)}px;height:${px(bg.h)}px">
            <span class="rpa-pk" style="left:${nm.x - row.x}px">${rich(ZH(it.zh))}</span>
            <span class="rpa-pv" style="left:${nm.x - row.x + nameW + 10}px">${rich(p[it.key])}</span>
          </div>`;
        }).join('')}
        <!-- desc：TextField(10,365) 宽 150 -->
        <div class="rpa-txt" style="left:${A(desc).x}px;top:${A(desc).y}px;width:${px(desc.w)}px">
          ${locked ? '已锁定' : '未锁定'}（RIDEPET_LOCK 文案常量未取到，显示状态兜底）
        </div>
        <!-- 锁定/解锁按钮：(162,370) 100×55（原版两按钮同坐标，按状态显示其一）-->
        ${this._btn('rpa-lock', locked ? 'text_panel_petUnlock' : 'text_panel_petLock', A(lock), px(lock.w), px(lock.h), locked ? '解锁' : '锁定')}
        <!-- 快捷：骑宠比例 → 商城宠物专用页签 (215,217) -->
        <button class="rpa-sk" id="rpa-shortkey" style="left:${A(sk).x}px;top:${A(sk).y}px" title="打开商城「宠物专用」页签（MALL_LABEL_SEC_USEFOR_PET）">
          <img src="${IMG('text_panel_ridepet_ratio')}" alt="" onerror="this.style.display='none'"/></button>
        <!-- 悟性操作区 _sprite(50,260) -->
        <select class="rpa-cb" id="rpa-usecb" style="left:${useCB.x}px;top:${useCB.y}px;width:${px(U('useCB').w)}px">
          <option value="">${rich(ZH('VIEW_PET_SELECTPILLS'))}</option>
          ${st.wuDan.map((d, i) => `<option value="${i}" ${this._kind && this._kind.tempIp === d.tempIp ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <select class="rpa-cb" id="rpa-wucb" style="left:${wuCB.x}px;top:${wuCB.y}px;width:${px(U('wuCB').w)}px">
          ${Array.from({ length: 20 }).map((_, i) => `<option value="${i + 1}" ${this._wuLevel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}
        </select>
        ${this._btn('rpa-autoup', 'text_panel_autoUp', autoUp, px(U('autoupBtn').w), px(U('autoupBtn').h), '自动提升')}
        ${this._btn('rpa-up', 'text_panel_up', upBtn, px(U('upBtn').w), px(U('upBtn').h), '提升')}
        <!-- PutGrid：_putGrid(sprite-30, sprite+47) + Stepper 子项(5,5) -->
        <div class="rpa-put" style="left:${put.x}px;top:${put.y}px" title="${esc(ZH('VIEW_PET_SELECTPILLS'))}">
          <span class="rpa-stepper" style="left:${putPt.x - put.x - 4}px;top:${putPt.y - put.y - 4}px"></span>
          ${this._kind ? `<span class="rpa-put-n">${esc(this._kind.name)}</span>` : ''}
        </div>
      </div>`;
  }

  // ══════════ Tab 1 · RidePetWuRate ══════════
  // 帧：createFrame(ViewRidePetWuRate_frame.w, ViewPetWuRate_learnFrame.h) @ ViewRidePetWuRate_frame(5,25)
  // 格点：initGridPoint 6 点 —— point1..5 @ x=232, y=245/323/206/284/362；point6 @ (9,130)
  //       资质格 = point-2；放置格 = point6-5
  _wuRateHtml() {
    const G = (k) => L('ViewPetWuRate', 'ViewPetWuRate_' + k);
    const RG = (k) => L('ViewRidePetWuRate', 'ViewRidePetWuRate_' + k);
    const V = (k) => L('ViewRidepet', 'ViewRidepet' + k);
    const st = this.sys.state;
    const p = st.cur, mod = st.getModifier() || {};
    const f = A(RG('frame')), desc = A(RG('desc'));
    const fh = px(G('learnFrame').h) || 50;
    const ptN = [1, 2, 3, 4, 5].map((i) => G('point' + i));
    const pt6 = G('point');
    const CELL = 40;
    const q = A(G('qualityInput'));
    const put6 = A({ x: pt6.x - 5, y: pt6.y - 5 });

    return `
      <div class="rpa-sub">
        <div class="rpa-fr" style="left:${f.x}px;top:${f.y}px;width:${px(RG('frame').w)}px;height:${fh}px"></div>
        <div class="rpa-desc rpa-desc-box" style="left:${desc.x}px;top:${desc.y}px;width:${px(RG('desc').w)}px;height:${Math.max(20, fh - 6)}px">
          ${rich(ZH('VIEW_RIDEPET_WU_UPRATE'))}${rich(p.growUpRate)}
        </div>
        <!-- 5 个 BP 资质格：gridList[i] = pointN - 2 -->
        ${WU_PROPS.map((it, i) => {
          const a = A({ x: ptN[i].x - 2, y: ptN[i].y - 2 });
          const addv = num(mod[it.key], 0);
          return `<div class="rpa-grid" style="left:${a.x}px;top:${a.y}px;width:${CELL}px;height:${CELL}px">
            <span class="rpa-g-n">${rich(ZH(it.zh))}</span>
            <span class="rpa-g-v">${rich(p[it.key])}${addv ? `<b class="rpa-g-add">+${addv}</b>` : ''}</span>
          </div>`;
        }).join('')}
        <!-- 放置格：putGrid = point6 - 5 -->
        <div class="rpa-grid rpa-put2" style="left:${put6.x}px;top:${put6.y}px;width:${CELL}px;height:${CELL}px" title="${esc(ZH('VIEW_PET_PUTIN_PILLS'))}">
          ${this._kind ? `<span class="rpa-g-n">${esc(this._kind.name)}</span>` : `<span class="rpa-g-ph">${rich(ZH('VIEW_PET_PUTIN_PILLS'))}</span>`}
        </div>
        <!-- CheckBox(155,80,90×20)：自动停止 -->
        <label class="rpa-chk" style="left:${A(G('check')).x}px;top:${A(G('check')).y}px;width:${px(G('check').w)}px;height:${px(G('check').h)}px">
          <input type="checkbox" id="rpa-autostop" ${this._autoStop ? 'checked' : ''}/><span>${rich(ZH('VIEW_PET_WU_STOP'))}</span>
        </label>
        <!-- _useComboBox(76,80) / _wuUpComboBox(76,102) -->
        <select class="rpa-cb" id="rpa-wu-usecb" style="left:${A(G('useCB')).x}px;top:${A(G('useCB')).y}px;width:${px(G('useCB').w)}px">
          <option value="5" ${this._wuUse === 5 ? 'selected' : ''}>${rich(ZH('VIEW_PET_WU_PERFECTION'))}</option>
          <option value="4" ${this._wuUse === 4 ? 'selected' : ''}>${rich(ZH('VIEW_PET_WU_SALIENCE'))}</option>
        </select>
        <select class="rpa-cb" id="rpa-wu-growcb" style="left:${A(G('growCB')).x}px;top:${A(G('growCB')).y}px;width:${px(G('growCB').w)}px">
          <option value="">${rich(ZH('VIEW_PET_WU_TYPR'))}</option>
          ${st.wuDan.map((d, i) => `<option value="${i}" ${this._kind && this._kind.tempIp === d.tempIp ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        ${this._btn('rpa-wu-item', 'text_panel_pet_info_auto', A(G('itemBtn')), px(G('itemBtn').w), px(G('itemBtn').h), '自动放入')}
        ${this._btn('rpa-wu-autoup', 'text_panel_autoUp', A(G('autoupBtn')), px(G('autoupBtn').w), px(G('autoupBtn').h), '自动提升')}
        ${this._btn('rpa-wu-up', 'text_panel_up', A(G('upBtn')), px(G('upBtn').w), px(G('upBtn').h), '提升')}
        <!-- BenplayerText(-51,175)：★ AS3 原坐标为负（浮出面板左边界，AS3 不裁剪）；DOM 会裁剪 ⇒ 贴左 x=2 并登记看板 -->
        <div class="rpa-q" style="left:2px;top:${q.y}px;width:${px(G('qualityInput').w)}px;height:${px(G('qualityInput').h)}px">
          悟性提升率/品质（原坐标 x=-51，越界已按 DOM 裁剪规则贴左）
        </div>
        <!-- 3 个快捷按钮：Dan(211,113) / Ratio(211,185) / BP(45,425) -->
        ${[['Dan', 'text_panel_ridepet_dan', V('Dan')], ['Ratio', 'text_panel_ridepet_ratio', V('Ratio')], ['BP', 'text_panel_add_ridepet_qa', V('BP')]].map(([id, key, r]) => `
          <button class="rpa-sk" data-rpask="${id}" style="left:${A(r).x}px;top:${A(r).y}px" title="打开商城宠物专用页签">
            <img src="${IMG(key)}" alt="" onerror="this.style.display='none'"/></button>`).join('')}
      </div>`;
  }

  // ══════════ Tab 2 · ViewRidePetSkill ══════════
  // 帧：frame1(5,25,261×309) 加在 this；frame2(10,78,251×97)/frame3(10,203,251×126) 在 skillState
  // 格点：pointList = grid(14,5) + (col*48, row*45)，共 2×5；NingshenDan 实际绘制在 point + (8,81)
  // 技能页签：skillTab(10,58) 宽 51；btnTrain(204,26,60) / btnForget(204,50,60)
  _skillHtml() {
    const G = (k) => L('ViewRidePetSkill', 'ViewRidePetSkill_' + k);
    const grid = G('grid'), stab = G('tab'), desc = G('desc'), intro = G('intro');
    const gw = px(grid.w) || 48, gh = px(grid.h) || 45;
    const cells = [];
    for (let r = 0; r < GRID_ROW; r++) {
      for (let c = 0; c < GRID_COL; c++) {
        const a = A({ x: grid.x + c * gw + DAN_DX, y: grid.y + r * gh + DAN_DY });
        cells.push(`<div class="rpa-slot" data-sk="${r * GRID_COL + c}" style="left:${a.x}px;top:${a.y}px;width:${gw}px;height:${gh}px">
          <span class="rpa-slot-e">空</span></div>`);
      }
    }
    const step = (stab.w || 51) + 1;
    return `
      <div class="rpa-sub">
        ${this._frame(G('frame1'))}${this._frame(G('frame2'))}${this._frame(G('frame3'))}
        <!-- 内丹子页签 skillTab(10,58) -->
        <div class="rpa-stabs" style="left:${A(stab).x}px;top:${A(stab).y}px">
          ${SKILL_TABS.map((t, i) => `<button class="rpa-stab${this._skillTab === t.id ? ' on' : ''}" data-stab="${t.id}" style="left:${i * step}px;width:${px(stab.w)}px" title="${esc(t.name)}">
            <img src="${IMG(t.key)}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/><span>${esc(t.name)}</span></button>`).join('')}
        </div>
        ${cells.join('')}
        ${this._btn('rpa-sk-train', 'text_panel_ridepet_train', A(G('btnTrain')), 60, 22, '修炼')}
        ${this._btn('rpa-sk-forget', 'text_panel_ridepet_forget', A(G('btnForget')), 60, 22, '遗忘')}
        <div class="rpa-desc rpa-desc-box" style="left:${A(desc).x}px;top:${A(desc).y}px;width:${px(desc.w)}px;height:${px(desc.h)}px">
          ${rich(ZH('RIDEPET_SKILL_INTRO'))}<div class="rpa-empty">技能明细原版由 SC 下发，抓包未覆盖 ⇒ 未臆造，槽位留空</div>
        </div>
        <div class="rpa-desc rpa-desc-box" style="left:${A(intro).x}px;top:${A(intro).y}px;width:${px(intro.w)}px;height:${px(intro.h)}px">
          ${rich(ZH('RIDEPET_NPC_INFO'))}
        </div>
      </div>`;
  }

  // ══════════ Tab 3 · RidePetFate ══════════
  // 帧：frame1(5,25,261×309) 在 this；frame(20,100,230×40)/default(22,102)/intro(5,339,262×98) 在 _defaultState
  // 三按钮：sell(20,245,65) / eatAll(105,245,65) / find(190,245,65)；fateInfoText(30,223)；horse(60,30)
  _fateHtml() {
    const G = (k) => L('ViewRidePetFate', 'ViewRidePetFate_' + k);
    const intro = G('intro'), fr = G('frame'), def = G('default');
    const btns = [
      { id: 'sell', key: 'text_panel_sellFate', r: G('sellFateBgn'), label: '出售' },
      { id: 'eat', key: 'text_panel_eatAll', r: G('eatAllBtn'), label: '吞噬全部' },
      { id: 'find', key: 'text_panel_findFateBtn', r: G('findFateBtn'), label: '寻访' },
    ];
    return `
      <div class="rpa-sub">
        ${this._frame(G('frame1'))}${this._frame(fr)}${this._frame(def)}
        <img class="rpa-horse" src="${IMG('panel_fateHorse')}" alt="" style="left:${A(G('horse')).x}px;top:${A(G('horse')).y}px" onerror="this.style.display='none'"/>
        <div class="rpa-txt" style="left:${A(G('fateAttr')).x}px;top:${A(G('fateAttr')).y}px;width:200px">
          命格属性区 / 命格袋（RidePetFateAttr / RidePetFateBag；原版由 SC 下发，抓包未覆盖）
        </div>
        <div class="rpa-txt" style="left:${A(G('fateBag')).x}px;top:${A(G('fateBag')).y}px">命格袋</div>
        <div class="rpa-txt" style="left:${A(G('fateInfoText')).x}px;top:${A(G('fateInfoText')).y}px">${rich(ZH('RIDEPET_FATE_INFO'))}</div>
        ${btns.map(b => this._btn('rpa-fate-' + b.id, b.key, A(b.r), 65, 22, b.label)
          .replace(`id="rpa-fate-${b.id}"`, `id="rpa-fate-${b.id}" data-fate="${b.id}"`)).join('')}
        <div class="rpa-desc rpa-desc-box" style="left:${A(intro).x}px;top:${A(intro).y}px;width:${px(intro.w)}px;height:${px(intro.h)}px">
          ${rich(ZH('RIDEPETFATE_NPC_INFO'))}<br/>${rich(ZH('RIDEPET_FATE_INTRO'))}<br/>${rich(ZH('RIDEPET_EATFATE_INTRO'))}
        </div>
      </div>`;
  }

  // ══════════ Tab 4 · RidePetTalent ══════════
  // 帧：仅复用 ViewRidePetFate_frame1/frame/default/intro（RidePetTalent.getLayout 全量即此 4 键）
  // 天赋条目：talentAry[i] @ (15, 25 + i*h)；洗练结果：newTalentAry[i] @ (140 + i*40, 290)
  // 滚动面板：(5,346,262×90)；四按钮 59×26 @ (15,282)(80,282)(15,308)(80,308)
  _talentHtml() {
    const G = (k) => L('ViewRidePetFate', 'ViewRidePetFate_' + k);
    const intro = G('intro'), fr = G('frame'), def = G('default');
    const btns = [
      { id: 'soph', key: 'text_panel_sophisticationBtn', x: 15, y: 282, label: '洗练' },
      { id: 'save', key: 'text_panel_saveBtn', x: 80, y: 282, label: '保存' },
      { id: 'train', key: 'text_panel_trainBtn', x: 15, y: 308, label: '培养' },
      { id: 'soph2', key: 'text_panel_sophisticationBtn', x: 80, y: 308, label: '洗练(对偶)' },
    ];
    const scroll = { x: 5, y: 346, w: 262, h: 90 };
    return `
      <div class="rpa-sub">
        ${this._frame(G('frame1'))}${this._frame(fr)}${this._frame(def)}
        <div class="rpa-txt" style="left:${A({ x: 15, y: 25 }).x}px;top:${A({ x: 15, y: 25 }).y}px;width:220px">
          天赋列表 talentAry（15, 25+i*h）；原版由天赋数据填充，抓包未覆盖 ⇒ 未臆造
        </div>
        <div class="rpa-txt" style="left:${A({ x: 140, y: 290 }).x}px;top:${A({ x: 140, y: 290 }).y}px">洗练结果 newTalentAry（140+i*40, 290）</div>
        <div class="rpa-desc rpa-desc-box" style="left:${A(scroll).x}px;top:${A(scroll).y}px;width:${scroll.w}px;height:${scroll.h}px">
          天赋总览滚动面板 createScrollPane(5,346,262,90) · 6 列网格（40×44）
          <div class="rpa-empty">TalentItem 数据原版由 SC 下发，抓包未覆盖</div>
        </div>
        ${btns.map(b => this._btn('rpa-tal-' + b.id, b.key, A({ x: b.x, y: b.y }), 59, 26, b.label)
          .replace(`id="rpa-tal-${b.id}"`, `id="rpa-tal-${b.id}" data-tal="${b.id}"`)).join('')}
        <div class="rpa-desc rpa-desc-box" style="left:${A(intro).x}px;top:${A(intro).y}px;width:${px(intro.w)}px;height:${px(intro.h)}px">
          骑宠天赋说明（源码内无 getString 调用 ⇒ 无 Lang 文案常量，未臆造）
        </div>
      </div>`;
  }

  // ───────────── 事件绑定 ─────────────
  _wireTab() {
    const st = this.sys.state;
    const id = st.selectedId;

    if (this._tab === 0) {
      const cbU = this.body.querySelector('#rpa-usecb');
      if (cbU) cbU.onchange = () => { this._kind = cbU.value === '' ? null : st.wuDan[Number(cbU.value)] || null; this.render(); };
      const cbW = this.body.querySelector('#rpa-wucb');
      if (cbW) cbW.onchange = () => { this._wuLevel = Number(cbW.value); };
      const lk = this.body.querySelector('#rpa-lock');
      if (lk) lk.onclick = () => {
        if (!id) return;
        if (st.locked.get(id)) this._send(CMD.PET_UNLOCK, { id }, '已发送解锁（CS_PET_UNLOCK 257）');
        else if (this.ui && this.ui.toast) this.ui.toast('锁定：原版弹 Prompt19 二次确认框（不在 14 面板清单内，未复刻）');
      };
      const sk = this.body.querySelector('#rpa-shortkey');
      if (sk) sk.onclick = () => this.ui && this.ui.toast('打开商城「宠物专用」页签（mallPanel 不在 14 面板清单内）');
      // RidePetInfo.buttonHandler：AUTO_UP / UP → sendPetFeedUpgrade(id, RIDE_PET_ADV_PANEL_WU, auto, tempId, value, wuLevel)
      const args = (auto) => ({
        id, type: CACHE_TYPE.WU, auto,
        tempId: this._kind ? this._kind.tempIp : 0, value: 0, level: this._wuLevel,
      });
      const au = this.body.querySelector('#rpa-autoup');
      if (au) au.onclick = () => this._send(CMD.FEED_UPGRADE, args(1), '已请求自动提升悟性');
      const up = this.body.querySelector('#rpa-up');
      if (up) up.onclick = () => this._send(CMD.FEED_UPGRADE, args(0), '已请求提升悟性');
    }

    if (this._tab === 1) {
      const chk = this.body.querySelector('#rpa-autostop');
      if (chk) chk.onchange = () => { this._autoStop = chk.checked; };
      const cbU = this.body.querySelector('#rpa-wu-usecb');
      if (cbU) cbU.onchange = () => { this._wuUse = Number(cbU.value); };
      const cbG = this.body.querySelector('#rpa-wu-growcb');
      if (cbG) cbG.onchange = () => { this._kind = cbG.value === '' ? null : st.wuDan[Number(cbG.value)] || null; this.render(); };
      const it = this.body.querySelector('#rpa-wu-item');
      if (it) it.onclick = () => this._send(CMD.XIANDAN_AUTOPUT, { id }, '已请求自动放入悟性丹');
      // flag：勾选「自动停止」时 0x010000 | useComboBox.data（与宠物版同规则）
      const flag = () => (this._autoStop ? (0x010000 | this._wuUse) : this._wuUse);
      const args = (auto) => ({
        id, type: CACHE_TYPE.WU, auto,
        tempId: this._kind ? this._kind.tempIp : 0, value: 0, level: flag(),
      });
      const au = this.body.querySelector('#rpa-wu-autoup');
      if (au) au.onclick = () => this._send(CMD.FEED_UPGRADE, args(1), '已请求自动提升');
      const up = this.body.querySelector('#rpa-wu-up');
      if (up) up.onclick = () => this._send(CMD.FEED_UPGRADE, args(0), '已请求提升');
      this.body.querySelectorAll('[data-rpask]').forEach(b => {
        b.onclick = () => this.ui && this.ui.toast('打开商城「宠物专用」页签（mallPanel 不在 14 面板清单内）');
      });
    }

    if (this._tab === 2) {
      this.body.querySelectorAll('[data-stab]').forEach(b => { b.onclick = () => { this._skillTab = Number(b.dataset.stab); this.render(); }; });
      this.body.querySelectorAll('[data-sk]').forEach(b => {
        b.onclick = () => this.ui && this.ui.toast(ZH('RIDEPET_OPTION_ALERT'));
      });
      const tr = this.body.querySelector('#rpa-sk-train');
      if (tr) tr.onclick = () => this._send(CMD.RIDEPET_SKILL, { id, type: this._skillTab, index: 0, op: 'train' });
      const fg = this.body.querySelector('#rpa-sk-forget');
      if (fg) fg.onclick = () => this._send(CMD.RIDEPET_SKILL, { id, type: this._skillTab, index: 0, op: 'forget' });
    }

    if (this._tab === 3) {
      this.body.querySelectorAll('[data-fate]').forEach(b => {
        b.onclick = () => {
          const k = b.dataset.fate;
          if (k === 'find') this._send(CMD.FIND_FATE, { id });
          else if (this.ui && this.ui.toast) this.ui.toast(`${k === 'sell' ? '出售命格' : '吞噬全部命格'}：原版走对应 SC 流程，抓包未覆盖，未臆造`);
        };
      });
    }

    if (this._tab === 4) {
      this.body.querySelectorAll('[data-tal]').forEach(b => {
        b.onclick = () => {
          const k = b.dataset.tal;
          const map = { train: CMD.TALENT_ALL, soph: CMD.TALENT_OP, soph2: CMD.TALENT_OP, save: CMD.TALENT_SAVE };
          this._send(map[k], { id });
        };
      });
    }
  }
}

export function registerRidePetAdvancePanel(panelManager, ui) {
  panelManager.register('ridepetadvance', () => new RidePetAdvancePanel(ui));
}
