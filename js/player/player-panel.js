// ═══════════════════════════════════════════════════════════════════════════
//  PlayerPanel 子系统（角色面板 · 14 面板清单 #4）
//  真源：deobfuscated/panel/property/PlayerPanel.as + ViewProperty/ViewArm/ViewHeart/ViewBagde/ViewEssence
//  数据：config/player_panel.json（由 _verify/gen_player_panel_cfg.mjs 生成）
//  协议：CS_ROLE_INFO(20) / CS_ROLE_START_POINT(22) / CS_ROLE_UPPOINT(?) 等
//  注：属性点分配/守护升级/徽章/元神消耗公式原版在服务端，客户端不计算；
//      单机版仅做数值展示 + 本地校验，公式待逆向，绝不臆造。
// ═══════════════════════════════════════════════════════════════════════════
import { Config } from '../core/globals.js?v=20261007c';

const P = (k) => (CFG().proto || {})[k];

function CFG() { return Config.player_panel || {}; }

class PlayerPanelState {
  constructor() {
    this.tab = 'prop';                 // 默认进属性页（PlayerPanel.as 默认 curSubPanel=PROPERTY）
    this.profile = JSON.parse(JSON.stringify((CFG().profile) || {}));
    this.allocated = {};               // 已分配的属性点（本地自闭环，不向服务端提交）
    this.reallyRestPoint = Number(this.profile.reallyRestPoint) || 0;
    this.log = [];
  }
  logPush(dir, op, info) { this.log.push({ dir, op, info }); }
  // 本地加点（仅 self 闭环，标注「未提交服务端」）
  addPoint(key) {
    if (this.reallyRestPoint <= 0) return false;
    this.allocated[key] = (this.allocated[key] || 0) + 1;
    this.reallyRestPoint -= 1;
    return true;
  }
  minusPoint(key) {
    if (!(this.allocated[key] > 0)) return false;
    this.allocated[key] -= 1;
    this.reallyRestPoint += 1;
    return true;
  }
  effValue(field) {
    const base = Number(this.profile[field]) || 0;
    // 主属性加点：strength/vitality/agile/intellect/belief 可被本地加点放大（展示用）
    const map = { strong: 'strong', vitality: 'vitality', agile: 'agile', intellect: 'intellect', belief: 'belief' };
    const k = map[field];
    return base + (k ? (this.allocated[k] || 0) : 0);
  }
}

class PlayerPanelNet {
  constructor(state) { this.state = state; }
  /** CS_ROLE_INFO(20) → SC_ROLE_INFO(20)：拉取角色档案（单机版直接回本地 profile） */
  roleInfo() {
    const p = P('CS_ROLE_INFO');
    this.state.logPush('CS', p, 'cid=' + this.state.profile.cid);
    this.state.logPush('SC', P('SC_ROLE_INFO'), 'name=' + this.state.profile.name + ' lv=' + this.state.profile.level);
    return this.state.profile;
  }
  /** CS_ROLE_START_POINT(22)：拉可分配点 */
  startPoint() {
    this.state.logPush('CS', P('CS_ROLE_START_POINT'), 'rest=' + this.state.reallyRestPoint);
    this.state.logPush('SC', P('CS_ROLE_START_POINT'), 'rest=' + this.state.reallyRestPoint);
  }
  /** CS_ROLE_UPPOINT：本地加点（仅 self 闭环，明确标注未提交服务端） */
  upPoint(attr, delta) {
    this.state.logPush('CS', P('CS_ROLE_UPPOINT'), attr + (delta > 0 ? ' +1' : ' -1') + '（本地，未提交服务端）');
    if (delta > 0) this.state.addPoint(attr); else this.state.minusPoint(attr);
  }
}

let _inst = null;
export function playerPanel() {
  if (!_inst) { _inst = { state: new PlayerPanelState(), net: new PlayerPanelNet(null) }; _inst.net.state = _inst.state; }
  return _inst;
}

export const __PlayerPanel = { PlayerPanelState, PlayerPanelNet };
