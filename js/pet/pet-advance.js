// pet-advance.js
// 宠物进阶子系统 —— 单机版本地实现（对齐 AS3）
//
// 对应原版：
//   deobfuscated/panel/property/pet/advance/PetAdvancePanelNew.as  （主面板壳）
//   deobfuscated/panel/property/pet/advance/PetWuRate.as           （悟性率 / 仙丹）
//   deobfuscated/panel/property/pet/advance/PetNeiDan.as           （内丹 / 丹田）
//   deobfuscated/net/RequestCommand.as                             （协议发送）
//   deobfuscated/manager/PropertyManager.as / ItemManager.as       （数据持有者）
//
// 设计铁律：
//   1. 原版由服务端下发的数据，这里全部由本地 Mock 应答（PetAdvanceNet），
//      保证单机模式下无网络阻断、无假死；应答字段与 SC_* 报文一致（见 config/pet_advance.json）。
//   2. 数值公式（提品/升星消耗、喂丹成功率）原版在服务端，客户端不可见 ⇒ **不臆造**，
//      见 config/pet_advance.json 的 formulas.待逆向。
//   3. 本模块不触及战斗系统（battle/、skill-engine.js 等一律不改）。

import { Config } from '../core/globals.js?v=20261007c';

// ───────────────────────── 常量（全部来自 config/pet_advance.json，可逐条回指 deobfuscated/）─────────────────────────
function cfg() { return Config.pet_advance || {}; }
const C = (k, d) => { const v = (cfg().consts || {})[k]; return v === undefined || v === null ? d : v; };
const P = (k, d) => { const v = (cfg().proto || {})[k]; return v === undefined || v === null ? d : v; };
const ZH = (k) => { const e = (cfg().lang || {})[k]; return e && e.zh != null ? e.zh : `[${k}]`; };

export const BAG = {
  XIANDAN: C('BAG_PET_VIEW_XIANDAN', 1000),   // 仙丹背包（PetWuRate）
  NEIDAN: C('BAG_PET_VIEW_NEIDAN', 1001),     // 内丹背包（PetNeiDan）
};
export const PANEL_STATE = { OPEN: C('PANEL_STATE_OPEN', 1), CLOSE: C('PANEL_STATE_CLOSE', 2) };
export const BP_KEYS = ['bpVitality', 'bpIntellect', 'bpStrong', 'bpAgile', 'bpBelief'];
export const BP_LABEL = { bpVitality: '体力', bpIntellect: '智力', bpStrong: '强壮', bpAgile: '敏捷', bpBelief: '信仰' };

// 内丹操作类型（GlobalsGlobal05 / message 类实参数，见 MessageClass03/14/16）
export const NEIDAN_OP = { OFF: 0, ABSORB_EXP: 1, DIGEST: 2, EAT_ITEM: 3 };

// 协议号（CS = 客户端发出，SC = 服务端应答）
export const CMD = {
  PET_EQUIP_MSG: P('CS_PET_EQUIP_MSG', 845),
  PET_RESISTANCE: P('CS_PET_RESISTANCE', 936),
  PET_MELT_INFO: P('CS_PET_MELT_INFO', 1000),
  PET_USESKILLBOOK: P('CS_PET_USESKILLBOOK', 192),
  PET_PRACTICE1: P('CS_PET_PRACTICE1', 681),
  PET_XIANDAN_AUTOPUT: P('CS_PET_XIANDAN_AUTOPUT', 205),
  PET_FEED_UPGRADE: P('CS_PET_FEED_UPGRADE', 237),
  PET_NEIDAN: P('CS_PET_NEIDAN', 335),
  PET_NEIDAN_USEITEM: P('CS_PET_NEIDAN_USEITEM', 334),
  PET_FEED_LIST: P('CS_PET_FEED_LIST', 236),
};
export const SC = {
  PET_XIANDAN: P('SC_PET_XIANDAN', 210),
  PET_FEED_LIST: P('SC_PET_FEED_LIST', 230),
  PET_NEIDAN_LIST: P('SC_PET_NEIDAN_LIST', 582),
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ───────────────────────── 本地「服务端」存档 ─────────────────────────
// 单机版没有真实服务器：PetAdvanceNet 按协议号应答，且应答**回写**本状态，
// 等价于原版 ServerConnection 收到 SC_* 后各 Manager 的落库行为。
export class PetAdvanceState {
  constructor() {
    this.selectPetId = '-1';       // 对齐 AS3：未选中为字符串 "-1"
    this.petProp = new Map();      // petId -> { [bpKey]: 当前值/上限, growUpRate, huanHua }
    this.bags = new Map();         // `${petId}:${bagId}` -> item[]
    this.neidan = new Map();       // petId -> 内丹[]
    this.xiandan = new Map();      // petId -> { bpVitality..bpBelief } 仙丹加成
    this.feedList = [];            // 丹药（SC_PET_FEED_LIST）
    this.log = [];                 // 协议流水（面板「数据流」页可查，用于验证闭环）
    this._seed();
  }

  // 用 config/pet_advance.json 的真实抓包样本初始化。
  // 抓包只覆盖取样到的宠物 ⇒ 对「当前玩家宠物」按样本做一次绑定（保持字段结构真实）。
  _seed() {
    const d = (cfg().data || {});
    this.feedList = (d.feedList || []).map((x) => ({ ...x }));
    for (const x of (d.xiandan || [])) this.xiandan.set(x.petId, { ...x });
    for (const n of (d.neidan || [])) {
      if (!this.neidan.has(n.petId)) this.neidan.set(n.petId, []);
      this.neidan.get(n.petId).push({ ...n });
    }
    this._samplePetId = (d.neidan && d.neidan[0] && d.neidan[0].petId)
      || (d.xiandan && d.xiandan[0] && d.xiandan[0].petId) || null;
    // 悟性加成样本：取加成合计最大的那条（抓包里多数宠物为全 0，取真值样本才有展示意义）
    const sum = (x) => x ? BP_KEYS.reduce((a, k) => a + num(x[k], 0), 0) : -1;
    this._sampleXiandan = (d.xiandan || []).reduce((best, x) => (sum(x) > sum(best) ? x : best), null);
  }

  // 绑定一只宠物（面板打开时，从单机版宠物列表取第一只；也可外部 setPet）
  ensurePet(petId, pet = {}) {
    if (!petId || petId === '-1') return null;
    if (!this.petProp.has(petId)) {
      const gd = (cfg().consts || {});
      const src = this.xiandan.get(this._samplePetId) || null;
      const prop = {
        growUpRate: num(pet.growUpRate, 0),
        huanHua: num(pet.huanHua, 0),
        [gd.bpStrong ?? 10012]: 0,
      };
      // 五属性「当前/上限」——原版由 SC_PET_ADVANCED_INFO 下发；单机用宠物自身属性兜底，标注来源。
      // ⚠ bp→属性的配对为**推定**（原版该映射在服务端；AS3 侧五条 grid 的标签文案相同，无法反推）
      //   —— 字段名一律用 op572 原生名；若日后逆向出真值，只改这一行即可。
      const base = { bpVitality: 'hpCur', bpIntellect: 'mpCur', bpStrong: 'attack', bpAgile: 'defense', bpBelief: 'magicAttack' };
      for (const k of BP_KEYS) {
        const key = gd[k];
        const cur = src ? num(src[k], 0) : num(pet[base[k]], 0);
        prop[key] = { cur, max: Math.max(cur, 1) };
      }
      this.petProp.set(petId, prop);
    }
    if (!this.xiandan.has(petId)) {
      const s = this._sampleXiandan || this.xiandan.get(this._samplePetId);
      this.xiandan.set(petId, s ? { ...s, petId } : { petId, bpVitality: 0, bpIntellect: 0, bpStrong: 0, bpAgile: 0, bpBelief: 0 });
    }
    if (!this.neidan.has(petId)) {
      // 单机模拟映射：抓包样本只覆盖取样宠物 ⇒ 把同一份真实报文绑到当前宠物上，
      // 保证面板拿到的是**真实字段与真实数值结构**（不是臆造值）。来源见 config/pet_advance.json._meta.数据来源
      const sample = this.neidan.get(this._samplePetId) || [];
      this.neidan.set(petId, sample.map((n) => ({ ...n, petId })));
    }
    return petId;
  }

  // ── 对应 AS3 PropertyManager.getPetProperty ──
  getPetProperty(petId) { return this.petProp.get(petId) || {}; }
  // ── 对应 AS3 ItemManager.getPetItemDicArray(petId, bagId) ──
  getPetItemDicArray(petId, bagId) { return this.bags.get(`${petId}:${bagId}`) || null; }
  // ── 对应 AS3 ItemManager.getNeiDanList(petId) ──
  getNeiDanList(petId) { return this.neidan.get(petId) || null; }
  // ── 对应 AS3 ItemManager.getPetModifier(petId)（仙丹加成）──
  getPetModifier(petId) {
    const x = this.xiandan.get(petId);
    if (!x) return null;
    const gd = (cfg().consts || {});
    const d = {};
    BP_KEYS.forEach((k, i) => { d[num(gd[k], 10012 + i)] = num(x[k], 0); });
    return d;
  }

  _pushLog(dir, op, payload) {
    this.log.unshift({ t: Date.now(), dir, op, payload });
    if (this.log.length > 60) this.log.pop();
  }
}

// ───────────────────────── Mock 协议层（对应 ServerConnection + RequestCommand）─────────────────────────
// 每次 request 都返回 Promise，模拟 RTT 后给出与 SC_* 同构的应答，并回写 state。
// 任何分支都不会 reject（单机模式禁止假死/阻断）。
export class PetAdvanceNet {
  constructor(state) { this.state = state; this.rtt = [60, 160]; }

  async _rtt() { const [a, b] = this.rtt; await delay(a + Math.random() * (b - a)); }

  /**
   * 发一条客户端协议。
   * @param {number} cmd  协议号（CMD.*）
   * @param {object} args 参数（与原版 sendXxx 形参一一对应）
   * @returns {Promise<{ok:boolean, sc?:number, data?:object, msg?:string}>}
   */
  async request(cmd, args = {}) {
    await this._rtt();
    const st = this.state;
    st._pushLog('CS', cmd, args);
    try {
      switch (cmd) {
        // 205 仙丹自动放入：把当前可选丹药放入放置格（原版服务端决定放哪个）
        case CMD.PET_XIANDAN_AUTOPUT: return this._autoput(args);
        // 237 喂丹提升：消耗放置格丹药，回推新的悟性加成
        case CMD.PET_FEED_UPGRADE: return this._feedUpgrade(args);
        // 236 拉取丹药列表
        case CMD.PET_FEED_LIST: return this._feedList(args);
        // 335 内丹操作：0 卸下 / 1 吸经验 / 2 消化
        case CMD.PET_NEIDAN: return this._neidanOption(args);
        // 334 吞物品（开物品面板选道具），单机无待吞道具队列 ⇒ 原样应答
        case CMD.PET_NEIDAN_USEITEM: return this._ok(SC.PET_NEIDAN_LIST, { op: 'useitem', index: args.index });
        // 以下 4 条在原版是「开另一个面板 / 拉一次数据」的前置请求，
        // 单机版没有对应子面板实现时只回 ok，绝不阻断（面板侧按 ok 决定是否继续）。
        case CMD.PET_EQUIP_MSG: return this._ok(null, { op: 'equip', value: args.value }, '宠物装备面板尚未复刻（本次 14 面板清单外）');
        case CMD.PET_RESISTANCE: return this._ok(null, { op: 'resistance' }, '宠物抗性面板尚未复刻（本次 14 面板清单外）');
        case CMD.PET_MELT_INFO: return this._ok(null, { op: 'melt' }, '宠物融合面板尚未复刻（本次 14 面板清单外）');
        case CMD.PET_USESKILLBOOK: return this._ok(null, { op: 'skillbook', value: args.value }, '技能书面板尚未复刻');
        case CMD.PET_PRACTICE1: return this._ok(null, { op: 'practice', value: args.value }, '练化面板尚未复刻');
        default: return { ok: false, msg: '未知协议号 ' + cmd };
      }
    } catch (e) {
      console.warn('[pet-advance] 协议处理异常（已兜底，不阻断）', cmd, e);
      return { ok: false, msg: String(e && e.message || e) };
    }
  }

  _ok(sc, data, msg) {
    this.state._pushLog('SC', sc, data);
    const r = { ok: true, sc, data };
    if (msg) r.msg = msg;
    return r;
  }

  // 205 CS_PET_XIANDAN_AUTOPUT → SC_PET_XIANDAN
  _autoput({ petId }) {
    const st = this.state;
    st.ensurePet(petId);
    const bag = st.bags.get(`${petId}:${BAG.XIANDAN}`) || [];
    const fd = st.feedList[0];
    if (fd) {
      bag.push({ index: 5, tempId: fd.tempIp, name: fd.name, desc: fd.desc, image: fd.image, bagId: BAG.XIANDAN });
      st.bags.set(`${petId}:${BAG.XIANDAN}`, bag);
    }
    const x = st.xiandan.get(petId) || { petId };
    return this._ok(SC.PET_XIANDAN, { petId, xiandan: { ...x }, put: fd ? { index: 5, tempId: fd.tempIp, name: fd.name, image: fd.image } : null });
  }

  // 237 CS_PET_FEED_UPGRADE(petId, type, auto, tempId, value, flag) → SC_PET_XIANDAN + SC_PET_FEED_LIST
  // ⚠ 提升幅度/成功率原版在服务端，客户端不可见 ⇒ 本地只做「消耗 + 回推」，不做数值臆造。
  _feedUpgrade({ petId, type, auto, tempId, value, flag }) {
    const st = this.state;
    st.ensurePet(petId);
    const bag = st.bags.get(`${petId}:${BAG.XIANDAN}`) || [];
    const i = bag.findIndex((b) => b.tempId === tempId);
    let consumed = null;
    if (i >= 0) { consumed = bag.splice(i, 1)[0]; st.bags.set(`${petId}:${BAG.XIANDAN}`, bag); }
    const x = st.xiandan.get(petId) || { petId };
    return this._ok(SC.PET_XIANDAN, {
      petId, xiandan: { ...x }, consumed: consumed ? consumed.name : null,
      auto: !!auto, flag: num(flag), type: num(type),
    });
  }

  // 236 CS_PET_FEED_LIST → SC_PET_FEED_LIST
  _feedList({ petId }) {
    return this._ok(SC.PET_FEED_LIST, { petId, list: this.state.feedList.slice() });
  }

  // 335 CS_PET_NEIDAN(op, petId, index) → SC_PET_NEIDAN_LIST
  _neidanOption({ op, petId, index }) {
    const st = this.state;
    const list = st.neidan.get(petId) || [];
    const nd = list.find((n) => num(n.index) === num(index));
    switch (num(op)) {
      case NEIDAN_OP.OFF:      // 0 卸下：原版「消耗大量修炼经验并耗尽元气」
        if (nd) { nd.trainExp = 0; nd.yuanqi = 0; }
        break;
      case NEIDAN_OP.ABSORB_EXP: // 1 吸经验：宠物当前经验 → 内丹修炼经验
        if (nd) { nd.trainExp = num(nd.trainExp) + num(nd.curExp); nd.curExp = 0; }
        break;
      case NEIDAN_OP.DIGEST:   // 2 消化：内丹消失，宠物获得修炼经验与修为
        {
          const j = list.findIndex((n) => num(n.index) === num(index));
          if (j >= 0) list.splice(j, 1);
        }
        break;
      default:
        break;
    }
    st.neidan.set(petId, list);
    return this._ok(SC.PET_NEIDAN_LIST, { petId, op: num(op), index: num(index), list: list.slice() });
  }
}

// ───────────────────────── 单例 ─────────────────────────
let _inst = null;
export function petAdvance() {
  if (!_inst) _inst = { state: new PetAdvanceState(), net: null };
  if (!_inst.net) _inst.net = new PetAdvanceNet(_inst.state);
  // 调试探针用（_verify/probe_pet_advance.mjs）：便于在控制台/自动化里核对协议流水与本地存档
  try { window.__TS_PET_ADVANCE_STATE = _inst.state; } catch (e) {}
  return _inst;
}

// 供面板取文案 / 布局 / 常量
export function layoutOf(group, key) {
  const g = ((cfg().layout || {})[group] || {});
  return g[key] || null;
}
export { ZH };
