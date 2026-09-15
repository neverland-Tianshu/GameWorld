// panel-player-skill.js
// 玩家技能面板（新版 PlayerSkillPanel2） —— 1:1 对齐 AS3
//   deobfuscated/panel/skill/PlayerSkillPanel2.as（TabView 聚合 7 子视图：战斗/生活/被动/特殊/天赋/转换/升级）
//
// ★ 坐标模型（关键）：
//   PlayerSkillPanel2 extends MallPanel；7 子视图 viewFightSkill…viewShengji 由
//   TabView.createTab(value,flag,text,display,display2=this.tabBar,…) 挂载 ⇒
//   TabView.as:121 `display2.addChild(display)` ⇒ **子视图的原点 = tabBar 的原点**，
//   而 initTab 把 tabBar 放在 layout("PlayerSkillPanel2_tab") = (14,45)；
//   子视图自身坐标 = getLayout("ViewX").x/y（fight/life/talent = (-2,21)，其余无布局 ⇒ 0,0）。
//   ⇒ 子视图内所有 layout 坐标 = (14,45) + 子视图自身偏移 + 内部 layout 坐标。
//   面板自身空间 = stage(295×444)；frame (12,65,270×360)、tabBar (14,45)。
//
// 资源图真源：config.res（逐目录实测 AS3 取图顺序 resource→loginResource→resource1→resource2）。
// ⚠ 不触碰战斗系统。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import { playerSkill, CMD, SC } from '../player/player-skill.js?v=20261007c';
import { getSkillRich, sanitizeRichText, showSkillTip, hideSkillTip } from './panels.js?v=20261007c';

const cfg = () => Config.player_skill_panel || {};
const L = (g, k) => ((cfg().layout || {})[g] || {})[k] || { x: 0, y: 0, w: 0, h: 0 };
const ZH = (k) => { const e = ((cfg().lang || {})[k] || {}); return e.zh || null; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const px = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 资源图：tab 标签图等（text_panel_* → textpanel*.png，落在 Resource/icons）
const IMG = (k) => url.res(String(k).replace(/_/g, '').toLowerCase() + '.png');

const SUBGROUP = { fight: 'ViewFightSkill', life: 'ViewLifeSkill', passive: 'ViewPassiveSkill', special: 'ViewSpecialSkill', talent: 'ViewTalentSkill', transfer: 'ViewTransferSkill', shengji: 'ViewShengji' };

const TABS = (cfg().tabs || [
  { id: 'fight', key: 'text_panel_skill_viewFight', name: '战斗' },
  { id: 'life', key: 'text_panel_skill_viewLife', name: '生活' },
  { id: 'passive', key: 'text_panel_skill_viewPassive', name: '被动' },
  { id: 'special', key: 'text_panel_skill_viewSpecial', name: '特殊' },
  { id: 'talent', key: 'text_panel_talent', name: '天赋' },
  { id: 'transfer', key: 'text_panel_viewtransfer', name: '转换' },
  { id: 'shengji', key: 'text_panel_shengji', name: '升级' },
]);

export class PlayerSkillPanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-player-skill', title: '技能', width: 320, height: 520, ui,
      icon: { dir: 'res', file: 'textpaneltitleskill.png' },
    });
    this._init();
  }

  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._tab = 'fight';
    this._logOpen = false;
  }
  get sys() { return playerSkill(); }
  init() { this.render(); }
  onOpen() {
    this._init();
    this._tab = 'fight';
    if (this.sys.ui) this.sys.ui = this.ui;
    this.sys._player = this.ui && this.ui.player ? this.ui.player : (Config && Config.player) || null;
    this.sys.open().then(() => this.render()).catch(() => this.render());
    this.render();
  }
  refresh() { this._init(); this.render(); }

  async _send(cmd, args, okMsg) {
    const r = await this.sys.net.request(cmd, args);
    if (r && r.sc && this.ui && this.ui.toast) this.ui.toast(okMsg || ('已收到 SC ' + r.sc));
    else if (okMsg && this.ui && this.ui.toast) this.ui.toast(okMsg);
    this.render();
  }

  render() {
    this._init();
    const st = this.sys;
    const lay = (cfg().layout.PlayerSkillPanel2) || {};
    const W = num((lay.PlayerSkillPanel2 || {}).w, 295), H = num((lay.PlayerSkillPanel2 || {}).h, 444);
    const tab = lay.PlayerSkillPanel2_tab || { x: 14, y: 45, w: 50 };
    const fr = lay.PlayerSkillPanel2_frame || { x: 12, y: 65, w: 270, h: 360 };
    const step = (tab.w || 50) + 1;

    this.setContent(`
      <div class="psp-wrap">
        <div class="psp-stage" style="width:${W}px;height:${H}px">
          <div class="psp-frame-out" style="left:${px(fr.x)}px;top:${px(fr.y)}px;width:${px(fr.w)}px;height:${px(fr.h)}px"></div>
          <div class="psp-tabs" style="left:${px(tab.x)}px;top:${px(tab.y)}px">
            ${TABS.map((t, i) => `<button class="psp-tab${this._tab === t.id ? ' on' : ''}" data-tab="${t.id}" style="left:${i * step}px;width:${px(tab.w)}px" title="${esc(t.name)}">
              <img src="${IMG(t.key)}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/>
              <span>${esc(t.name)}</span></button>`).join('')}
          </div>
          <div class="psp-body">${this._tabHtml()}</div>
        </div>
        <div class="psp-log">
          <div class="psp-log-h" id="psp-log-t">数据流 / 协议流水（${st.log.length}）${this._logOpen ? '▾' : '▸'}</div>
          <div class="psp-log-b" style="display:${this._logOpen ? 'block' : 'none'}">
            ${st.log.length ? st.log.map(l => `<div class="psp-log-r"><b class="${l.dir}">${l.dir}</b><span>${l.op}</span><i>${esc(JSON.stringify(l.payload).slice(0, 110))}</i></div>`).join('') : '<div class="psp-empty">暂无协议交互</div>'}
          </div>
        </div>
      </div>`);

    this.body.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { this._tab = b.dataset.tab; this._onTab(); }; });
    const lt = this.body.querySelector('#psp-log-t');
    if (lt) lt.onclick = () => { this._logOpen = !this._logOpen; this.render(); };
    this._wireTab();
  }

  _onTab() {
    const st = this.sys;
    st.tab = this._tab;
    if (this._tab === 'transfer') st.loadTransfer().then(() => this.render()).catch(() => this.render());
    else if (this._tab === 'shengji') st.loadShengji().then(() => this.render()).catch(() => this.render());
    else this.render();
  }

  _tabHtml() {
    switch (this._tab) {
      case 'fight': return this._fightHtml();
      case 'life': return this._lifeHtml();
      case 'passive': return this._passiveHtml();
      case 'special': return this._specialHtml();
      case 'talent': return this._talentHtml();
      case 'transfer': return this._transferHtml();
      case 'shengji': return this._shengjiHtml();
      default: return '';
    }
  }

  // 子视图容器原点 = tabBar + 子视图自身偏移（getLayout("ViewX").x/y）
  _origin(sub) {
    const tb = cfg().tabBar || { x: 14, y: 45 };
    const grp = SUBGROUP[sub];
    const off = ((cfg().layout[grp] || {})[grp] || { x: 0, y: 0 });
    return { x: px(tb.x) + px(off.x), y: px(tb.y) + px(off.y) };
  }
  _fr(r) { return `<div class="psp-fr" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w)}px;height:${px(r.h)}px"></div>`; }
  _el(key, r, cls, extra = '') { return `<div class="${cls}" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w)}px;height:${px(r.h)}px" ${extra}>${key}</div>`; }
  // 当前技能图标（真实 icon，多级回退）
  _icImg(r, cls = 'psp-ic') {
    const s = this.sys.curSkill;
    const icon = (s && s.icon) || '';
    if (!icon) return this._el('', r, cls);
    return `<div class="${cls}" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w)}px;height:${px(r.h)}px">
      <img src="${url.icon('skill', icon)}" alt="" style="width:100%;height:100%;object-fit:contain"
        onerror="this.onerror=null;this.src='${url.iconFallback('skill', icon)}'"/></div>`;
  }
  _txt(s, r, cls = 'psp-txt') { return `<div class="${cls}" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w) || 200}px">${esc(s)}</div>`; }
  // 富文本描述区：有 descRich 走 sanitizeRichText（对齐 AS3 htmlText），否则回落纯文本
  _richTxt(s, r, cls = 'psp-desc') {
    const rich = getSkillRich(s);
    const inner = rich ? sanitizeRichText(rich) : esc(String((s && s.desc) || ''));
    return `<div class="${cls}" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w) || 200}px">${inner}</div>`;
  }

  // ══════════ Tab0 战斗 · ViewFightSkill ══════════
  _fightHtml() {
    const G = (k) => L('ViewFightSkill', 'ViewFightSkill_' + k);
    const st = this.sys;
    const vo = this._origin('fight');
    const btn = G('button'), fr = G('frame'), ic = G('icon'), tx = G(''), dic = G('dic');
    const desc = G('descInput'), exp = G('expInput');
    const titles = st.skillTitles.length ? st.skillTitles : (cfg().skillTitles || []);
    const list = st.lists.fight || [];
    return `
      <div class="psp-sub" style="left:${vo.x}px;top:${vo.y}px">
        <div class="psp-tbar" style="left:${px(btn.x)}px;top:${px(btn.y)}px;height:${px(btn.h || 45)}px">
          ${titles.map((t, i) => `<button class="psp-title${i === 0 ? ' on' : ''}" data-title="${esc(t.zh)}" style="left:${i * 34}px;width:32px;height:${px(btn.h || 45)}px">${esc(t.zh)}</button>`).join('')}
        </div>
        ${this._fr(fr)}
        ${this._icImg(ic)}
        ${this._txt(st.curSkill.name, G(''), 'psp-name')}
        ${this._txt('心法说明', dic, 'psp-dic')}
        ${this._richTxt(st.curSkill, desc)}
        ${this._txt('经验：' + (st.curSkill.exp || '—'), exp, 'psp-exp')}
        <div class="psp-note" style="left:${px(fr.x)}px;top:${px(fr.y) + px(fr.h) + 6}px;width:230px">
          ${list.length ? ('已学战斗技能 ' + list.length + ' 个 · 悬停或点击图标查看说明') : '未学习任何战斗技能'}</div>
      </div>`;
  }

  // ══════════ Tab1 生活 · ViewLifeSkill ══════════
  _lifeHtml() {
    const G = (k) => L('ViewLifeSkill', 'ViewLifeSkill_' + k);
    const vo = this._origin('life');
    const list = G('list'), tx = G('');
    return `
      <div class="psp-sub" style="left:${vo.x}px;top:${vo.y}px">
        <div class="psp-list" style="left:${px(list.x)}px;top:${px(list.y)}px;width:${px(list.w) || 270}px;height:${px(list.h) || 360}px">
          ${'<div class="psp-empty">生活技能列表（SC_SKILL_LIST2 抓包未覆盖）</div>'}
        </div>
        ${this._txt('生活技能', tx, 'psp-name')}
      </div>`;
  }

  // 被动/特殊/转换/升级：抓包未覆盖 ⇒ 列表占位 + 说明
  _passiveHtml() { return this._listPlaceholder('被动', 'ViewPassiveSkill', '被动技能列表（SC_SKILL_LIST2 抓包未覆盖）'); }
  _specialHtml() { return this._listPlaceholder('特殊', 'ViewSpecialSkill', '特殊技能列表（SC_SKILL_LIST2 抓包未覆盖）'); }
  _transferHtml() { return this._listPlaceholder('转换', 'ViewTransferSkill', '转换技能（CS_TRANSFERSKILL_SHOW 932 抓包未覆盖）'); }
  _shengjiHtml() { return this._listPlaceholder('升级', 'ViewShengji', '升级系统（CS_SHENGJI_PANEL 1005 抓包未覆盖）'); }

  _listPlaceholder(name, grp, note) {
    const vo = this._origin(name === '被动' ? 'passive' : name === '特殊' ? 'special' : name === '转换' ? 'transfer' : 'shengji');
    return `
      <div class="psp-sub" style="left:${vo.x}px;top:${vo.y}px">
        <div class="psp-list" style="left:${px(cfg().tabBar ? cfg().tabBar.x : 14)}px;top:4px;width:${px((cfg().layout.PlayerSkillPanel2.PlayerSkillPanel2_frame || {}).w || 270) - 2}px;height:340px">
          <div class="psp-empty">${esc(note)}</div>
        </div>
      </div>`;
  }

  // ══════════ Tab4 天赋 · ViewTalentSkill ══════════
  _talentHtml() {
    const G = (k) => L('ViewTalentSkill', 'ViewTalentSkill_' + k);
    const st = this.sys;
    const vo = this._origin('talent');
    const btn = G('button'), fr = G('frame'), ic = G('icon'), tx = G(''), dic = G('dic');
    const desc = G('descInput'), exp = G('expInput');
    const titles = st.skillTitles.length ? st.skillTitles : (cfg().skillTitles || []);
    const list = st.lists.talent || [];
    return `
      <div class="psp-sub" style="left:${vo.x}px;top:${vo.y}px">
        <div class="psp-tbar" style="left:${px(btn.x)}px;top:${px(btn.y)}px;height:${px(btn.h || 45)}px">
          ${titles.map((t, i) => `<button class="psp-title${i === 0 ? ' on' : ''}" data-title="${esc(t.zh)}" style="left:${i * 34}px;width:32px;height:${px(btn.h || 45)}px">${esc(t.zh)}</button>`).join('')}
        </div>
        ${this._fr(fr)}
        ${this._icImg(ic)}
        ${this._txt('天赋心法', G(''), 'psp-name')}
        ${this._txt('心法说明', dic, 'psp-dic')}
        ${this._richTxt(st.curSkill, desc)}
        ${this._txt('经验：' + (st.curSkill.exp || '—'), exp, 'psp-exp')}
        <div class="psp-note" style="left:${px(fr.x)}px;top:${px(fr.y) + px(fr.h) + 6}px;width:230px">
          ${list.length ? ('已学天赋技能 ' + list.length + ' 个 · 悬停或点击图标查看说明') : '未学习任何天赋技能'}</div>
      </div>`;
  }

  // ───────────── 事件绑定 ─────────────
  _wireTab() {
    const st = this.sys;
    const list = st.lists[this._tab] || [];
    // 心法按钮：按索引切到该分桶内的技能（数据为真，不臆造；超界保留当前）
    this.body.querySelectorAll('.psp-title').forEach((b, i) => {
      b.onclick = () => {
        const s = list[i];
        if (s) { st.curSkill = s; this.render(); }
        else if (this.ui && this.ui.toast) { this.ui.toast('心法：' + b.dataset.title + '（该心法暂无已学技能）'); }
      };
    });
    // 当前技能图标：悬停弹富文本悬浮框（对齐 AS3 CurrentBar.onMouseOver）
    const ic = this.body.querySelector('.psp-ic');
    if (ic) {
      ic.onmouseenter = () => showSkillTip(st.curSkill, ic);
      ic.onmouseleave = hideSkillTip;
      ic.onclick = () => { if (this.ui && this.ui.toast) this.ui.toast('技能：' + (st.curSkill.name || '—')); };
    }
  }
}

export function registerPlayerSkillPanel(panelManager, ui) {
  panelManager.register('playerskillpanel', () => new PlayerSkillPanel(ui));
}
