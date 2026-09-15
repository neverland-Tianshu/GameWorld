// ridepet-advance.js
// 骑宠进阶子系统 —— 单机版本地实现（对齐 AS3）
//
// 对应原版：
//   deobfuscated/panel/property/ridePet/RidePetAdvancePanel.as   （主面板：5 页签 TabView）
//   deobfuscated/panel/property/ridePet/RidePetInfo.as           （信息：10 属性 + 锁定/解锁 + 悟性操作区）
//   deobfuscated/panel/property/ridePet/RidePetWuRate.as         （仙丹：5 属性 + 5 格 + 3 按钮）
//   deobfuscated/panel/property/ridePet/ViewRidePetSkill.as      （技能：4 类型页签 + 修炼/遗忘）
//   deobfuscated/panel/property/ridePet/RidePetFate.as           （命格：寻访/出售/吞噬全部）
//   deobfuscated/panel/property/ridePet/RidePetTalent.as         （天赋：洗练/保存/培养）
//   deobfuscated/net/RequestCommand.as                           （协议发送）
//
// 铁律同 pet-advance.js：数据来自 config/ridepet_advance.json（抓包真源），
// 服务端公式不臆造；不触碰战斗系统。

import { Config } from '../core/globals.js?v=20261007c';

const cfg = () => Config.ridepet_advance || {};
const C = (k, d) => { const v = (cfg().consts || {})[k]; return v === undefined || v === null ? d : v; };
const P = (k, d) => { const v = (cfg().proto || {})[k]; return v === undefined || v === null ? d : v; };
const ZH = (k) => { const e = (cfg().lang || {})[k]; return e && e.zh != null ? e.zh : `[${k}]`; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const BP_KEYS = ['bpVitality', 'bpIntellect', 'bpStrong', 'bpAgile', 'bpBelief'];

// 协议号
export const CMD = {
  XIANDAN_AUTOPUT: P('CS_PET_XIANDAN_AUTOPUT', 205),
  FEED_UPGRADE: P('CS_PET_FEED_UPGRADE', 237),
  PET_UNLOCK: P('CS_PET_UNLOCK', 257),
  RIDEPET_SKILL: P('CS_RIDEPET_SKILL', 336),
  FIND_FATE: P('CS_RIDEPET_FIND_FATE', 350),
  TALENT_OP: P('CS_RIDEPET_TALENT_OP', 976),
  TALENT_SAVE: P('CS_RIDEPET_TALENT_SAVE', 977),
  TALENT_ALL: P('CS_RIDEPET_TALENT_ALL', 979),
};
export const SC = {
  PET_XIANDAN: P('SC_PET_XIANDAN', 210),
  PET_FEED_LIST: P('SC_PET_FEED_LIST', 230),
  RIDEPET_INFO: P('SC_RIDEPET_INFO', 292),
  RIDEPET_LIST: P('SC_RIDEPET_LIST', 293),
  FIND_FATE_INFO: P('SC_RIDEPET_FIND_FATE_INFO', 755),
  SLOT_OPEN: P('SC_RIDEPET_SLOT_OPEN', 757),
};

// 缓存类型（CacheCache08）：喂丹/悟性分两类，原版 sendPetFeedUpgrade 的第 2 参即此值
export const CACHE_TYPE = { WU: C('RIDE_PET_ADV_PANEL_WU', 3), BP: C('RIDE_PET_ADV_PENEL_BP', 4) };
export const PANEL_RIDEPET_ADVANCE = C('PANEL_RIDEPET_ADVANCE', 229);

// RidePetInfo.initProperty 的 10 行属性（id 取 GlobalsGlobal05，name 取 Lang）
export const INFO_PROPS = [
  { key: 'outLineType', id: 10018, zh: 'VIEW_PET_TYPE', from: 'outLineType' },
  { key: 'maxLevel', id: 40, zh: 'VIEW_PET_MAXLEVEL', from: 'level', copy: true },
  { key: 'gender', id: 10020, zh: 'VIEW_PET_GENDER', from: 'gender' },
  { key: 'closeVal', id: 41, zh: 'VIEW_PET_CLOSEVAL', from: 'loyality', copy: true },
  { key: 'spiritual', id: 42, zh: 'VIEW_PET_SPIRITUAL', from: 'spirit' },
  { key: 'savvy', id: 44, zh: 'VIEW_PET_SAVVY', from: 'savvy', copy: true },
  { key: 'variation', id: 45, zh: 'VIEW_PET_VARIATION', from: 'variation' },
  { key: 'carryLevel', id: 113, zh: 'VIEW_PET_CARRYLEVEL', from: 'carryLevel', copy: true },
  { key: 'growUpRate', id: 10011, zh: 'VIEW_PET_RATE', from: 'ridePlusRate', copy: true },
  { key: 'rideSoulshift', id: 10017, zh: 'RIDE_SOULSHIFT', from: 'rideSoulshift' },
];
export const PROP_ZH = (k) => ZH(k);

// RidePetWuRate.initProp 的 5 行属性
export const WU_PROPS = [
  { key: 'bpVitality', zh: 'VIEW_PET_BPVITALITY', from: 'vitality' },
  { key: 'bpIntellect', zh: 'VIEW_PET_BPINTELLECT', from: 'intellect' },
  { key: 'bpStrong', zh: 'VIEW_PET_BPSTRONG', from: 'strong' },
  { key: 'bpAgile', zh: 'VIEW_PET_BPAGLIE', from: 'agile' },
  { key: 'bpBelief', zh: 'VIEW_PET_BPBELIEF', from: 'belief' },
];

// ───────────────────────── 本地「服务端」存档 ─────────────────────────
export class RidePetAdvanceState {
  constructor() {
    this.selectedId = '';        // AS3 ridePetPanel.selectedRidePetID（空串 = 未选）
    this.list = [];              // 坐骑列表（真实抓包）
    this.prop = new Map();       // id -> 属性字典
    this.modifier = new Map();   // id -> 仙丹加成 { bpKey: n }
    this.wuDan = [];             // 悟性丹列表（SC_PET_FEED_LIST 复用宠物那一份）
    this.wuLevel = 1;            // 悟性档位（initWuData 1..20）
    this.locked = new Map();     // id -> 是否锁定
    this.log = [];
    this._seed();
  }

  _seed() {
    const d = (cfg().data || {});
    this.list = (d.ridepets || []).map((x) => ({ ...x }));
    if (this.list.length) this.selectedId = String(this.list[0].ridePetID || '');
    for (const r of this.list) {
      this.prop.set(String(r.ridePetID), this._derive(r));
      this.modifier.set(String(r.ridePetID), { bpVitality: 0, bpIntellect: 0, bpStrong: 0, bpAgile: 0, bpBelief: 0 });
      this.locked.set(String(r.ridePetID), false);
    }
    // 悟性丹列表：与宠物共用同一份 SC_PET_FEED_LIST 抓包（pet_advance.json）
    const pa = Config.pet_advance || {};
    this.wuDan = ((pa.data || {}).feedList || []).map((x) => ({ ...x }));
  }

  // 抓包样本里的字段名 → 面板属性名（未覆盖的字段置「—」，不臆造）
  _derive(r) {
    const o = {};
    for (const p of INFO_PROPS.concat(WU_PROPS)) {
      o[p.key] = (r[p.from] !== undefined && r[p.from] !== '') ? r[p.from] : '—';
    }
    return o;
  }

  get cur() { return this.prop.get(this.selectedId) || {}; }
  get curRaw() { return this.list.find((r) => String(r.ridePetID) === this.selectedId) || null; }
  getModifier(id) { return this.modifier.get(id || this.selectedId) || null; }

  _push(dir, op, payload) {
    this.log.unshift({ t: Date.now(), dir, op, payload });
    if (this.log.length > 60) this.log.pop();
  }
}

// ───────────────────────── Mock 协议层 ─────────────────────────
export class RidePetAdvanceNet {
  constructor(state) { this.state = state; }
  async request(cmd, args = {}) {
    await delay(60 + Math.random() * 100);
    const st = this.state;
    st._push('CS', cmd, args);
    try {
      switch (cmd) {
        // 237 喂丹提升（骑宠走 RIDE_PET_ADV_PANEL_WU=3）
        case CMD.FEED_UPGRADE: return this._feedUpgrade(args);
        // 205 自动放入悟性丹
        case CMD.XIANDAN_AUTOPUT: return this._autoput(args);
        // 257 解锁骑宠
        case CMD.PET_UNLOCK: {
          st.locked.set(args.id, false);
          return this._ok(SC.RIDEPET_INFO, { id: args.id, locked: false });
        }
        // 336 骑宠技能操作（修炼/遗忘）
        case CMD.RIDEPET_SKILL:
          return this._ok(null, { op: 'skill', id: args.id, type: args.type, index: args.index },
            '骑宠技能：抓包缺技能明细报文，未臆造数值');
        // 350 寻访命格
        case CMD.FIND_FATE:
          return this._ok(SC.FIND_FATE_INFO, { id: args.id }, '命格寻访结果表在服务端，抓包未覆盖');
        // 976/977/979 天赋洗练 / 保存 / 一键
        case CMD.TALENT_OP:
        case CMD.TALENT_SAVE:
        case CMD.TALENT_ALL:
          return this._ok(null, { op: cmd, id: args.id }, '骑宠天赋：抓包缺天赋明细报文，未臆造数值');
        default: return { ok: false, msg: '未知协议号 ' + cmd };
      }
    } catch (e) {
      console.warn('[ridepet-advance] 协议异常（已兜底）', cmd, e);
      return { ok: false, msg: String((e && e.message) || e) };
    }
  }

  _ok(sc, data, msg) {
    this.state._push('SC', sc, data);
    const r = { ok: true, sc, data };
    if (msg) r.msg = msg;
    return r;
  }

  _autoput({ id }) {
    const st = this.state;
    const fd = st.wuDan[0] || null;
    return this._ok(SC.PET_XIANDAN, { id, put: fd ? { name: fd.name, tempIp: fd.tempIp } : null });
  }

  // ⚠ 提升幅度/成功率原版在服务端 ⇒ 本地只做「请求-应答」闭环，不改数值
  _feedUpgrade({ id, type, auto, tempId, value, level }) {
    const st = this.state;
    return this._ok(SC.PET_XIANDAN, {
      id, type: num(type), auto: !!auto, tempId: num(tempId, 0), value: num(value, 0), level: num(level, 0),
    });
  }
}

let _inst = null;
export function ridePetAdvance() {
  if (!_inst) _inst = { state: new RidePetAdvanceState(), net: null };
  if (!_inst.net) _inst.net = new RidePetAdvanceNet(_inst.state);
  try { window.__TS_RIDEPET_ADVANCE_STATE = _inst.state; } catch (e) {}
  return _inst;
}
export { ZH };
