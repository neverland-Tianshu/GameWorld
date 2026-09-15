// player.js
// 角色主面板子系统 —— 单机版本地实现（对齐 AS3）
//
// 对应原版：
//   deobfuscated/panel/property/PlayerPanel.as        （主面板：5 页签 TabView：装备/角色/守护/徽章/元神）
//   deobfuscated/panel/property/player/ViewProperty.as（角色：38 项属性 + 潜力分配 + 改名/经验）
//   deobfuscated/panel/property/player/ViewArm.as      （装备：约 20 装备槽 + 基础/魔法属性列表）
//   deobfuscated/panel/property/player/ViewHeart.as    （守护：七心 + 升级）
//   deobfuscated/panel/property/player/ViewBagde.as    （徽章：手风琴 + 列表 + 详情）
//   deobfuscated/panel/property/player/ViewEssence.as  （元神：玄冰火毒 + 升级）
//   deobfuscated/net/RequestCommand.as                 （协议发送）
//
// 铁律同 ridepet-advance.js：数据来自 config/player_panel.json（抓包真源 = op20_SC_ROLE_INFO.csv 何雅璇档案），
// 服务端公式不臆造；不触碰战斗系统。

import { Config } from '../core/globals.js?v=20261007c';
import { equipStats } from '../item/equip-stats.js?v=20261007c';

// op572 抓包字段名 → Fighter 引擎字段名（人物面板属性页对齐 attrs.js DERIVED_KEYS）
// 装备加成键直接用 equip-stats.js 解析出的引擎键。
const PROP_TO_FIGHTER = {
  strong: 'strength', vitality: 'stamina', agile: 'agility', intellect: 'intellect', belief: 'faith',
  hpCur: 'hp', hpMax: 'maxHp', mpCur: 'mp', mpMax: 'maxMp',
  spCur: 'rage', spMax: 'rageMax',
  speed: 'spd', restore: 'recover', spiritual: 'xiuwei', spirit: 'vigor',
  attack: 'atk', defense: 'def', magicAttack: 'mag', magicDef: 'magDef',
  phyHit: 'phyHit', phyJook: 'phyDodge', phyBang: 'phyCrit',
  magicHit: 'magHit', magicJook: 'magDodge', magicBang: 'magCrit',
};
const EQUIP_BONUS_KEYS = [
  'maxHp', 'maxMp', 'atk', 'def', 'mag', 'magDef', 'spd', 'recover', 'crit',
  'phyHit', 'phyDodge', 'phyCrit', 'magHit', 'magDodge', 'magCrit',
  'strength', 'stamina', 'agility', 'intellect', 'faith',
];

const cfg = () => Config.player_panel || {};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// 协议号（NetNet.as）
export const CMD = {
  GET_ROLE_INFO: num((cfg().proto || {}).CS_GET_ROLE_INFO, 203),
  QUERY_ROLE_INFO: num((cfg().proto || {}).CS_QUERY_ROLE_INFO, 21),
  UPGRADE_HEART: num((cfg().proto || {}).CS_UPGRADE_HEART, 189),
  BAGUA_UPGRADE: num((cfg().proto || {}).CS_BAGUA_UPGRADE, 949),
  WINGSHOW_INFO: num((cfg().proto || {}).CS_WINGSHOW_INFO, 884),
  APPLY_POINT: num((cfg().proto || {}).CS_ROLE_MOVE, 20), // 潜力分配（原版 sendApplyPoint 复用 CS 20 通道，单机版单独标记）
};
export const SC = {
  ROLE_INFO: num((cfg().proto || {}).SC_ROLE_INFO, 20),
  UPGRADE_HEART: num((cfg().proto || {}).SC_UPGRADE_HEART, 189),
  BAGUA_INFO: num((cfg().proto || {}).SC_BAGUA_INFO, 957),
  WING_EVOLUTION: num((cfg().proto || {}).SC_WING_EVOLUTION, 772),
};

// ───────────────────────── 本地「服务端」mock ─────────────────────────
// 任何分支都不 reject（对齐 ridepet-advance / pet-advance 的「任何分支不 reject」铁律）。
export class PlayerNet {
  constructor(state) { this.state = state; }

  async request(cmd, args = {}) {
    const st = this.state;
    st._push('CS', String(cmd), args);
    let resp = { ok: true, cs: cmd, sc: null, data: {} };
    switch (Number(cmd)) {
      case CMD.GET_ROLE_INFO:
      case CMD.QUERY_ROLE_INFO:
        resp = { ...resp, sc: SC.ROLE_INFO, data: st.profile }; break;
      case CMD.UPGRADE_HEART: {
        const bonus = num(st.profile.heartBonus) + 1;
        st.profile.heartBonus = String(bonus);
        resp = { ...resp, sc: SC.UPGRADE_HEART, data: { heartBonus: st.profile.heartBonus } }; break;
      }
      case CMD.BAGUA_UPGRADE:
        resp = { ...resp, sc: SC.BAGUA_INFO }; break;
      case CMD.WINGSHOW_INFO:
        resp = { ...resp, sc: SC.WING_EVOLUTION }; break;
      case CMD.APPLY_POINT:
        st._applyPending();
        resp = { ...resp, sc: SC.ROLE_INFO, data: st.profile }; break;
      default:
        resp = { ...resp, sc: null };
    }
    if (resp.sc) st._push('SC', String(resp.sc), resp.data || {});
    return resp;
  }
}

// ───────────────────────── 角色状态 ─────────────────────────
export class PlayerState {
  constructor() {
    this.profile = { ...(cfg().profile || {}) };
    this.tab = 'arm';            // 默认选中「装备」（对齐复现页 __TABS__[0] selected）
    this.log = [];
    this.pendingPoints = {};     // 主属性 key → 待分配潜力（本地暂存，APPLY_POINT 时落盘）
    this.net = new PlayerNet(this);
    this._fighter = null;        // 场景主角 Fighter（弱引用：由 ui.bindPlayer 注入，属性页取真实值）
  }

  // 场景主角注入（ui.js bindPlayer 时调用）—— 属性页由此读到【运行期真实值】而非抓包快照
  bindFighter(fig) { this._fighter = fig || null; }
  get fighter() { return this._fighter; }

  // 当前装备：优先取场景主角 Fighter（运行期真值），其次 profile.equip（抓包快照兜底）
  get equip() {
    const f = this._fighter;
    if (f && f.equip && typeof f.equip === 'object' && Object.keys(f.equip).length) return f.equip;
    const e = this.profile.equip;
    return (e && typeof e === 'object') ? e : {};
  }

  // 装备属性加成（面板与战斗同源：此处与 fighter.applyEquip 用同一份 equip-stats 解析结果）
  // 基准取 Fighter 派生上限（铭刻千分比在此折算）； Fighter 不存在时用 profile 的 hpMax/mpMax 兜底。
  get equipBonus() {
    const eq = this.equip;
    if (!eq || !Object.keys(eq).length) return {};
    const f = this._fighter;
    const base = f ? { maxHp: f.maxHp, maxMp: f.maxMp } : { maxHp: Number(this.profile.hpMax) || 0, maxMp: Number(this.profile.mpMax) || 0 };
    const out = {};
    for (const slot of Object.keys(eq)) {
      const id = eq[slot];
      if (id == null || id === '') continue;
      const st = equipStats(id);
      if (!st) continue;
      for (const k of Object.keys(st)) {
        if (k === '_permille') continue;
        out[k] = (out[k] || 0) + Number(st[k]) || 0;
      }
      if (st._permille) {
        for (const k of Object.keys(st._permille)) {
          const b = Number(base[k]) || 0;
          out[k] = (out[k] || 0) + Math.round(b * st._permille[k]);
        }
      }
    }
    return out;
  }

  _push(dir, op, payload) {
    this.log.unshift({ t: Date.now(), dir, op, payload });
    if (this.log.length > 60) this.log.pop();
  }

  // 属性行取值（propItems 一项 → 显示值）
  // ★ 真值来源链：场景主角 Fighter（运行期派生值，含装备/强化/被动加成）
  //   → 无 Fighter 时回退 profile 抓包快照（登录前/独立页兜底，不阻塞显示）
  //   → 二级属性（攻防/命中/暴击/HP上限…）叠加 equip-stats 解析的装备加成后展示，
  //     与 fighter.applyEquip 用同一份解析结果，面板 = 战斗。
  propVal(item) {
    const p = this.profile;
    const f = this._fighter;
    // 双值行（hp/mp/sp 的 当前/上限）
    if (item.v2) {
      const a = this._raw(item.v1), b = this._raw(item.v2);
      const va = (a == null || a === '') ? 0 : a;
      const vb = (b == null || b === '') ? 0 : b;
      return `${va}/${vb}`;
    }
    if (!item.v1) {
      if (item.k === 'VIEW_PROP_COUNTRY') return p.repution || '—';   // 帮会声望（抓包字段 repution）
      return '—';
    }
    let v = this._raw(item.v1);
    if (v === undefined || v === '' || v === null) return '—';
    // ★ 只有回退 profile（无 Fighter 真值）时才补装备加成：
    //   Fighter 的属性已由 applyEquip 叠加过装备加成，再叠一次会重复计算。
    //   五维主属性（strong/vitality/…）无 Fighter 真值时同理补装备主属性加成。
    if (!f || this._rawHitFighter(item.v1) === false) {
      const fkey = PROP_TO_FIGHTER[item.v1];
      const bon = this.equipBonus;
      if (fkey && EQUIP_BONUS_KEYS.indexOf(fkey) >= 0 && bon[fkey]) {
        v = Number(v) + Number(bon[fkey]);
      }
    }
    return String(v);
  }

  // 单字段取值：Fighter 优先（运行期真值），回退 profile
  _raw(field) {
    const f = this._fighter;
    if (f) {
      const fk = PROP_TO_FIGHTER[field];
      if (fk && f[fk] != null && f[fk] !== '') return f[fk];
      if (f[field] != null && f[field] !== '') return f[field];
    }
    return this.profile[field];
  }

  // 该字段是否真的从 Fighter 取到了值（用于 propVal 决定是否补装备加成）
  _rawHitFighter(field) {
    const f = this._fighter;
    if (!f) return false;
    const fk = PROP_TO_FIGHTER[field];
    if (fk && f[fk] != null && f[fk] !== '') return true;
    return (f[field] != null && f[field] !== '');
  }

  // 潜力分配：把 1 点潜力暂存到主属性（本地校验，不臆造服务端公式）
  bump(key, delta) {
    const p = this.profile;
    const left = num(p.reallyRestPoint);
    if (delta > 0 && left <= 0) return false;
    if (delta < 0 && !(num(this.pendingPoints[key]) > 0)) return false;
    this.pendingPoints[key] = num(this.pendingPoints[key]) + delta;
    p.reallyRestPoint = String(left - delta);
    return true;
  }
  _applyPending() {
    const p = this.profile;
    for (const k in this.pendingPoints) p[k] = String(num(p[k]) + num(this.pendingPoints[k]));
    this.pendingPoints = {};
  }
  // 撤销未落盘的潜力分配
  cancelPending() {
    const p = this.profile;
    for (const k in this.pendingPoints) p.reallyRestPoint = String(num(p.reallyRestPoint) + num(this.pendingPoints[k]));
    this.pendingPoints = {};
  }

  // 装备槽列表（ViewArm 内所有 ViewArm_equipNN[_2/_3/_4] 坐标，按布局顺序）
  get equipSlots() {
    const L = (cfg().layout.ViewArm) || {};
    const ORDER = ['头饰', '项链', '上衣', '手镯', '腰带', '戒指', '裤子', '鞋子', '饰品',
      '时装', '护肩', '披风', '翅膀', '护符', '灵符', '护身', '纹身', '面具', '肩甲', '背饰'];
    const keys = Object.keys(L).filter((k) => k.startsWith('ViewArm_equip'));
    return keys.map((k) => {
      const idx = parseInt((k.match(/equip(\d+)/) || [0, 0])[1], 10) || 0;
      const isVar = /_\d+$/.test(k);
      return { key: k, parts: ORDER[idx % ORDER.length] + (isVar ? '·强化' : ''), r: L[k] || { x: 0, y: 0 } };
    });
  }

  // 守护七心（抓包字段 braveHeart / diligencyHeart / confidentHeart / penetrateHeart / kindHeart / pityHeart / mercyHeart / confuseHeart）
  get hearts() {
    const p = this.profile;
    return [
      { k: '勇敢', v: p.braveHeart }, { k: '勤勉', v: p.diligencyHeart }, { k: '自信', v: p.confidentHeart },
      { k: '穿透', v: p.penetrateHeart }, { k: '善良', v: p.kindHeart }, { k: '怜悯', v: p.pityHeart },
      { k: '仁慈', v: p.mercyHeart }, { k: '迷惑', v: p.confuseHeart },
    ];
  }

  // 元神四属性（玄/冰/火/毒：field91..field96 等占位；抓包未覆盖数值 ⇒ 用配置占位）
  get essences() {
    const p = this.profile;
    return [
      { k: 'ESSENCE_XUAN', zh: '玄', v: p.field91 }, { k: 'ESSENCE_BING', zh: '冰', v: p.field92 },
      { k: 'ESSENCE_HUO', zh: '火', v: p.field93 }, { k: 'ESSENCE_DU', zh: '毒', v: p.field94 },
    ];
  }

  // 当前元神总量（ViewEssence.updateCurrEssence 的 text；对应 profile.field91）
  get essenceTotal() { return this.profile.field91; }

  // 五行计数（ViewFiveElements.updateInfo 的 5 个 count；对应 profile.field92~field96）
  get fiveElements() {
    const p = this.profile;
    return [p.field92, p.field93, p.field94, p.field95, p.field96];
  }
}

let _inst = null;
export function player() {
  if (!_inst) _inst = new PlayerState();
  return _inst;
}




