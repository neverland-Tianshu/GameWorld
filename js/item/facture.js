// facture.js
// 装备制造与强化系统（ItemPanel03）容器 · 单机版本地实现（对齐 AS3 panel.item.facture.ItemPanel03）
//
// 对应原版：
//   deobfuscated/panel/item/facture/ItemPanel03.as  —— 容器：14 按钮网格 + 标题 + 内容头 + makeEffect + 14 子面板路由器
//   14 子面板：StoneMake/ArmStud/ArmUnStud/ArmMake/SourceMix/ArmAddstar/ArmPoke/ArmDecompose/
//             PotionBrew/ArmUpgrade/ArmChangeHole/EquipEnchant/TransformCard/RevelationPanel02
//             —— 各自为独立 RevelationPanel 深类（见同目录 *_panel 源码），本容器不逆向其内部合成/材料/成功率。
//
// 铁律同 ridepet-advance / player / player-skill：数据来自 config/item_panel03.json（布局=layout.xml / 协议=NetNet）；
// 服务端公式/明细不臆造；不触碰战斗系统。

import { Config } from '../core/globals.js?v=20261007c';

const cfg = () => Config.item_panel03 || {};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// 协议号（NetNet.as）：sendItemRemark → CS_ITEM_REMAKE(206)
export const CMD = { ITEM_REMAKE: num((cfg().proto || {}).CS_ITEM_REMAKE, 206) };
export const SC = { ITEM_REMAKE: num((cfg().proto || {}).SC_ITEM_REMAKE, 206) };

// ───────────────────────── 本地「服务端」mock ─────────────────────────
// 任何分支都不 reject（对齐 ridepet-advance / player / player-skill 的「任何分支不 reject」铁律）。
export class FactureNet {
  constructor(state) { this.state = state; }

  async request(cmd, args = {}) {
    const st = this.state;
    st._push('CS', String(cmd), args);
    let resp = { ok: true, cs: cmd, sc: null, data: {} };
    switch (Number(cmd)) {
      case CMD.ITEM_REMAKE:
        // 单机版合成回执（原版 sendItemRemark 关闭备注，服务端无独立 SC ⇒ 合成一个回执 echo）
        resp = { ...resp, sc: SC.ITEM_REMAKE, data: { remark: args.remark, ack: '单机版合成回执（原版无独立 SC）' } }; break;
      default:
        resp = { ...resp, sc: null };
    }
    if (resp.sc) st._push('SC', String(resp.sc), resp.data || {});
    return resp;
  }
}

// ───────────────────────── 打造面板状态 ─────────────────────────
export class FactureState {
  constructor() {
    this.currSub = cfg().defaultSub || 'armMake'; // 默认子面板 = 装备打造（对齐 curSubPanel = BUTTON_ARM_MAKE）
    this.log = [];
    this.net = new FactureNet(this);
    // 14 按钮（顺序严格对齐 AS3 initButtons 累加步进）
    const G = (cfg().buttonGrid) || { x: 16, y: 50, w: 72, h: 25 };
    const BW = cfg().btnWidth || 65;
    this.buttons = (cfg().buttons || []).map((b) => ({
      id: b.id, gid: b.gid, zh: b.zh, img: b.img,
      x: num(G.x) + num(G.w) * b.col, y: num(G.y) + num(G.h) * b.row, w: BW, h: num(G.h),
    }));
    // 14 子面板
    this.subPanels = (cfg().subPanels || []).map((s) => ({ id: s.id, zh: s.zh, cls: s.cls, bag: s.bag }));
  }

  _push(dir, op, payload) {
    this.log.unshift({ t: Date.now(), dir, op, payload });
    if (this.log.length > 60) this.log.pop();
  }

  // 切换子面板（对齐 switchPanel：仅切当前视图，子面板深类内部待逆向）
  select(id) { this.currSub = id; return this; }

  // 关闭面板：对齐 doBehaviar(Behaviar_Close) → sendItemRemark(3,-1) → CS_ITEM_REMAKE(206)
  async close() {
    const r = await this.net.request(CMD.ITEM_REMAKE, { remark: 3, value2: -1, value3: 0 });
    return r;
  }
}

let _inst = null;
export function facture() {
  if (!_inst) _inst = new FactureState();
  return _inst;
}
