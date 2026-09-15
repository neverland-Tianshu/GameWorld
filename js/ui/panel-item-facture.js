// panel-item-facture.js
// 装备制造与强化系统（ItemPanel03）容器面板 —— 1:1 对齐 AS3
//   deobfuscated/panel/item/facture/ItemPanel03.as（14 按钮网格 + 标题 + 内容头 + makeEffect + 14 子面板路由器）
//
// ★ 坐标模型（关键）：
//   ItemPanel03 直接 extends ItemPanel（非 MallPanel/TabView）；容器本体用 FacturePanel 布局：
//     bgWidth = FacturePanel.width(460)，bgHeight = FacturePanel.height(450) + tempY(25)；
//     定位 initBackground(FacturePanel.x=15, y=70)，内容区 FacturePanel_content(26,113,190,270) + tempY。
//   14 按钮（initButtons）：基座 FacturePanel_button(16,50,72,25)；每按钮宽 65、步进 loc1=72(x) / loc2=25(y)；
//     前 6 个 row0、后 6 个 row1、末 2 个 row2（对齐 AS3 累加 `loc3 + loc1*i, loc4 + loc2*j`）。
//   子面板（14 个 RevelationPanel）：在 initContent 中 y=190+tempY(=215) 或取 FacturePanel_<子面板>.y+tempY 堆叠，
//     仅当前 currSubPanel 通过 switchPanel 的 addChild 显示；本容器不逆向深类内部，统一框占位标注（待逆向）。
//   标题图：textpaneltitleitem.png（titleKey text_panel_title_item）；按钮面图：textpanel*.png（缺则中文名兜底）。
// ⚠ 不触碰战斗系统。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import { facture, CMD, SC } from '../item/facture.js?v=20261007c';

const cfg = () => Config.item_panel03 || {};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const L = (g, k) => ((cfg().layout || {})[g] || {})[k] || { x: 0, y: 0, w: 0, h: 0 };
const px = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 资源图：按钮面图 / 标题图（text_panel_* → textpanel*.png，落在 Resource/icons）
const IMG = (fn) => (fn ? url.res(fn) : '');

export class ItemFacturePanel extends BasePanel {
  constructor(ui) {
    const fr = (cfg().frame) || { x: 15, y: 70, w: 460, h: 450 };
    super({
      id: 'panel-item-facture', title: '装备制造', width: num(fr.w, 460), height: num(fr.h, 450), ui,
      icon: { dir: 'res', file: cfg().title && cfg().title.res ? cfg().title.res : 'textpaneltitleitem.png' },
    });
    this._init();
  }

  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._logOpen = false;
  }
  get sys() { return facture(); }
  init() { this.render(); }
  onOpen() { this._init(); this.render(); }
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
    const fr = (cfg().frame) || { x: 15, y: 70, w: 460, h: 450 };
    const bg = L('FacturePanel', 'FacturePanel');
    const W = num(bg.w, 460), H = num(bg.h, 450);
    const content = L('FacturePanel_content', 'FacturePanel_content');
    const mef = L('FacturePanel_makeEffect', 'FacturePanel_makeEffect');
    const sub = st.subPanels.find((s) => s.id === st.currSub) || st.subPanels[0];

    this.setContent(`
      <div class="ip3-wrap">
        <div class="ip3-stage" style="width:${W}px;height:${H}px">
          <div class="ip3-title">
            <img src="${IMG(cfg().title && cfg().title.res)}" alt="" onerror="this.style.display='none'"/>
            <span>${esc((cfg().title && cfg().title.zh) || '装备制造')}</span>
          </div>
          <div class="ip3-btns">
            ${st.buttons.map((b) => `<button class="ip3-btn${st.currSub === b.id ? ' on' : ''}" data-sub="${b.id}" style="left:${px(b.x)}px;top:${px(b.y)}px;width:${px(b.w)}px;height:${px(b.h)}px">
              <img src="${IMG(b.img)}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/>
              <span>${esc(b.zh)}</span></button>`).join('')}
          </div>
          <div class="ip3-sub" id="ip3-sub">
            <div class="ip3-sub-h">当前子面板：${esc(sub ? sub.zh : '—')}（${esc(sub ? sub.cls : '')}）</div>
            <div class="ip3-sub-body">
              ${this._subGrid(sub)}
              <div class="ip3-note">该子面板为独立 RevelationPanel 深类（${esc(sub ? sub.cls : '')}），内部合成/材料/成功率公式原版在服务端 ⇒ 框占位，待逆向，未臆造。</div>
            </div>
          </div>
          <div class="ip3-make" style="left:${px(mef.x)}px;top:${px(mef.y)}px">
            <div class="ip3-make-t">打造特效区</div>
            <div class="ip3-make-box">makeEffect MovieClip 占位（gotoAndPlay(2) 播放合成动画）</div>
          </div>
          <button class="ip3-close" data-act="close">关闭（sendItemRemark → CS ${CMD.ITEM_REMAKE}）</button>
        </div>
        <div class="ip3-log">
          <div class="ip3-log-h" id="ip3-log-t">数据流 / 协议流水（${st.log.length}）${this._logOpen ? '▾' : '▸'}</div>
          <div class="ip3-log-b" style="display:${this._logOpen ? 'block' : 'none'}">
            ${st.log.length ? st.log.map((l) => `<div class="ip3-log-r"><b class="${l.dir}">${l.dir}</b><span>${l.op}</span><i>${esc(JSON.stringify(l.payload).slice(0, 120))}</i></div>`).join('') : '<div class="ip3-empty">暂无协议交互（点「关闭」触发 CS ' + CMD.ITEM_REMAKE + '）</div>'}
          </div>
        </div>
      </div>`);

    this.body.querySelectorAll('[data-sub]').forEach((b) => { b.onclick = () => { st.select(b.dataset.sub); this.render(); }; });
    const lt = this.body.querySelector('#ip3-log-t');
    if (lt) lt.onclick = () => { this._logOpen = !this._logOpen; this.render(); };
    const cbtn = this.body.querySelector('[data-act="close"]');
    if (cbtn) cbtn.onclick = () => { this._send(CMD.ITEM_REMAKE, { remark: 3, value2: -1, value3: 0 }, '已发送 CS ' + CMD.ITEM_REMAKE); };
  }

  // 子面板 crafting 网格占位（对齐 RevelationPanel 38×38 格 + 材料/结果槽 + 行动按钮；内部待逆向）
  _subGrid(sub) {
    if (!sub) return '';
    const slots = [];
    for (let i = 0; i < 6; i++) slots.push(`<div class="ip3-slot" style="left:${i * 42}px;top:0"></div>`);
    return `
      <div class="ip3-grid" style="left:${px((cfg().content && cfg().content.x) || 26)}px;top:6px">
        <div class="ip3-grid-h">${esc(sub.zh)} · 材料/结果格（38×38 占位）</div>
        <div class="ip3-row">${slots.join('')}<div class="ip3-slot res">结果</div></div>
        <button class="ip3-act" data-act="craft">${esc(sub.zh)}（行动按钮占位）</button>
      </div>`;
  }
}

export function registerItemFacturePanel(panelManager, ui) {
  panelManager.register('itemfacture', () => new ItemFacturePanel(ui));
}
