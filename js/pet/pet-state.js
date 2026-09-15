// pet-state.js
// 玩家持有宠物实例层（PlayerState.pets）—— 宠物系统三层数据流的**中间层**。
//
// ★ 分层（用户裁决 2026-09-17）：
//   [静态原型表] Config.pets ← config/pets.json（gen_game_data.py 生成：物种资质/外观/携带等级/技能表）
//        │ clone（实例化 = 本文件 boot()）
//        ▼
//   [运行时实例] PlayerState.pets ← 本文件
//        ├─► js/ui/panel-pet.js          主面板：渲染当前选中 / 出战宠物
//        ├─► js/ui/panel-pet-advance.js  进阶：消费丹药 → 改该实例的 advanceState
//        └─► js/scenes/scene.js          战斗：读 skillList 与 attack/defense 计算出招
//
// ★ 契约（红线，assertPetsSave 强制）—— 实例只准装「会变的数据」：
//
//   interface PetInstance {
//     uid: string;                     // 玩家侧唯一实例 id（'pi_1' 递增）
//     petId: string;                   // 物种索引 → Config.pets 查静态数据（name/attack/bodyImage/...）
//     level: number;
//     hpCur: number;                   // 当前生命
//     mpCur: number;                   // 当前法力
//     exp: number;                     // 当前经验
//     state: number;                   // 0 未出战 / 1 出战（★ 战斗侧 scene.js 按 state===1 选出战宠物）
//     bind: number;                    // 0 未绑 / 1 已绑
//     loyality: number;                // 忠诚
//     spiritual: number;               // 修为
//     skillList: number[];             // 技能 id 数组（战斗侧 Config.skills[id] 取定义）
//     skillLevels: { "<id>": { sid, level } };   // 技能等级实例明细（op573 真值）
//     advanceState: object;            // 进阶态（悟性加成/内丹/成长率…），由 pet-advance.js 写入
//     life: number;                    // 当前寿命（F4：仅宠物；战斗开始为满值，寿命技能消耗，食物补充）
//     lifeMax: number;                 // 寿命上限 = 50×等级+500（C7）
//     lifePool: number;                // 寿命池（Q3：寿命储存水晶补充；战斗结束后自动补满寿命并扣减池）
//   }
//
//   静态字段（name/desc/image/icon/attack/defense/growUpRate/...）一律**禁存**，用时查 Config.pets / Config.skills。
//   理由与物品系统同构：存档只存「会被玩变的数据」，静态表可随时由生成器重建。
//
// ★ 存档：localStorage['tsqt.save.pets']
//   绝不能用 'tsqt.cfg.' 前缀 —— globals.js 的 CONFIG_OVERRIDE_SCHEMA 闸在版本不符时会遍历删除所有
//   'tsqt.cfg.*' 键，存档会被连带清空（与物品系统同一坑，已踩过一次）。
//
// ★ 不臆造：原型缺字段就地取 0/默认，绝不编造数值；战斗所需静态资质一律从 Config.pets 现查。

import { Config } from '../core/globals.js?v=20261007c';

// ★ bo：最多同时参战宠物数（用户裁决 2026-09-19）
export const MAX_DEPLOYED = 5;

// ★ bv：抛弃池上限（放生的宠物暂存于此，以后做「恢复」功能时取回）
export const MAX_ABANDONED = 20;

export const SAVE_SCHEMA = 2;   // ★ aw：实例层新增 grade/variant/growRate（宠物全靠捕捉，物种/品级/变异/成长率需落档）
export const SAVE_KEY = 'tsqt.save.pets';
export const SAVE_STRICT = true;

// 实例上的允许字段（白名单，与上面的 interface 一一对应）
// 寿命上限公式（C7 用户裁决）：lifeMax = 50 × 等级 + 500
export function petLifeMax(level) { return 50 * Math.max(1, Math.trunc(Number(level) || 1)) + 500; }

export const INSTANCE_KEYS = [
  'uid', 'petId', 'level', 'hpCur', 'mpCur', 'exp', 'state', 'bind',
  'loyality', 'spiritual', 'skillList', 'skillLevels', 'advanceState',
  'life', 'lifeMax', 'lifePool',
  'grade',      // 品级（普通/优秀/杰出/卓越/完美）
  'variant',    // 是否变异（战斗内变色滤镜口径）
  'growRate',   // 成长率（百分比数值，影响属性公式）
  // ★ ay：物种键——petId 改为唯一编码后，物种（查角色信息表/原型表）由 family 承载。
  'family',
];

// 禁存字段：既包含「静态展示字段」（name/desc/image…），也包含「出厂资质」（attack/defense…）
// —— 防手滑把 Config.pets 的整条原型对象塞进实例档。
export const FORBIDDEN_INSTANCE_KEYS = [
  'name', 'desc', 'describe', 'image', 'imageDesc', 'icon', 'iconPath', 'path', 'url',
  'stats', 'effect', 'prop', 'price', 'linkName', 'item', 'config', 'data',
  'attack', 'defense', 'speed', 'magicAttack', 'magicDef', 'bodyImage', 'portraitImage',
  'growUpRate', 'carryLevel', 'variation', 'wuRate', 'closeVal',
];

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ★ ay：每只宠物分配一个唯一编码（原版服务端下发的是 UUID；单机版由本地生成）。
//   实例的 petId = 唯一编码；物种（查角色信息表/原型表）另存 family 字段。
//   修复「同物种多只宠物 petId 相同 ⇒ 面板点选/高亮/详情全部串到第一只」。
export function newPetId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  const h = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return h() + h() + '-' + h() + '-' + h() + '-' + h() + '-' + h() + h() + h();
}

function warnOrThrow(msg) {
  if (SAVE_STRICT) throw new Error('[pet-state] ' + msg);
  console.warn('[pet-state] ' + msg);
}

// ───────────────────────── 原型表查询 ─────────────────────────
/** petId → Config.pets 原型条目（静态数据唯一出口）。 */
export function protoOf(petId) {
  const all = Array.isArray(Config.pets) ? Config.pets : [];
  const hit = all.find((p) => String(p.petId) === String(petId));
  if (hit) return hit;
  // ★ aw：config/pets.json 已清空（宠物全靠捕捉）⇒ 回退查统一角色信息表 Config.chars。
  //   按 name 匹配；返回带 _char 标记的种子，由 js/pet/pet.js 的 view() 调 charToPetProto 合成完整视图。
  const chars = (Config.chars && typeof Config.chars === 'object') ? Config.chars : {};
  const key = String(petId);
  for (const k in chars) {
    if (k[0] === '_') continue;
    const c = chars[k];
    if (c && c.name != null && String(c.name) === key) {
      return { petId: key, name: String(c.name), _char: c };
    }
  }
  return null;
}

/** 静态展示/资质取值的唯一出口：先查原型，缺则返回 fallback（不臆造）。 */
export function protoVal(petId, key, fallback = null) {
  const p = protoOf(petId);
  if (!p) return fallback;
  const v = p[key];
  return v == null || v === '' ? fallback : v;
}

// ───────────────────────── 实例构造 ─────────────────────────
/** 构造一个契约内的宠物实例（唯一合法构造入口）。 */
export function makeInstance(proto, uid) {
  return {
    uid: String(uid),
    petId: String(proto.petId),
    family: String(proto.family || proto.petId || ''),   // ★ ay：物种键（petId 为唯一编码，物种另存）
    level: num(proto.level, 1),
    hpCur: num(proto.hpCur != null ? proto.hpCur : proto.hpMax),
    mpCur: num(proto.mpCur != null ? proto.mpCur : proto.mpMax),
    exp: num(proto.expCur),
    state: 0,     // ★ 实例默认「未出战」（用户裁决）；出战由面板「设为出战」置 1
    bind: 1,      // ★ 实例默认「已绑定」（用户裁决）
    loyality: num(proto.loyality, 100),
    spiritual: num(proto.spiritual),
    skillList: Array.isArray(proto.skillList)
      ? proto.skillList.map((x) => num(x)).filter((x) => x > 0) : [],
    skillLevels: (proto.skillLevels && typeof proto.skillLevels === 'object')
      ? JSON.parse(JSON.stringify(proto.skillLevels)) : {},
    advanceState: {},
    // ★ aw：个体特征（捕捉时与战斗内观察一致）。
    grade: proto.grade || null,
    variant: !!proto.variant,
    growRate: Number.isFinite(Number(proto.growRate)) ? Number(proto.growRate) : null,
    // 寿命（仅宠物）：实例化时按 C7 公式取满值；战斗中消耗后由 scene.js 回写
    lifeMax: petLifeMax(proto.level),
    life: petLifeMax(proto.level),
    lifePool: Math.max(0, Math.trunc(Number(proto.lifePool) || 0)),   // 寿命池（寿命储存水晶补充，初始 0）
  };
}

/** 品级旧名→新名（位置式改名：良好170→优秀、优秀230→杰出；费率/权重/变异随档位保留）。 */
const GRADE_ALIAS = { '良好': '优秀', '优秀': '杰出' };
/** 归一化一条（可能来自旧档 / 外部塞入）实例：只保留契约字段，剔除多余键。 */
export function normalizeInstance(raw, uid) {
  const out = {};
  for (const k of INSTANCE_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
  out.uid = String(uid != null ? uid : (raw.uid || ''));
  out.petId = String(raw.petId || '');
  out.level = num(out.level, 1);
  out.hpCur = num(out.hpCur);
  out.mpCur = num(out.mpCur);
  out.exp = num(out.exp);
  out.state = num(out.state) === 1 ? 1 : 0;   // 只认 0/1
  out.bind = num(out.bind) === 0 ? 0 : 1;
  out.loyality = num(out.loyality, 100);
  out.spiritual = num(out.spiritual);
  out.skillList = Array.isArray(raw.skillList) ? raw.skillList.map((x) => num(x)).filter((x) => x > 0) : [];
  out.skillLevels = (raw.skillLevels && typeof raw.skillLevels === 'object') ? raw.skillLevels : {};
  out.advanceState = (raw.advanceState && typeof raw.advanceState === 'object') ? raw.advanceState : {};
  // 寿命：旧档无此字段 → lifeMax 缺省按 C7 补，life 缺省取满值（F4：战斗开始为满值）
  out.lifeMax = Number(out.lifeMax) > 0 ? Number(out.lifeMax) : petLifeMax(out.level);
  out.life = (out.life != null && Number.isFinite(Number(out.life)))
    ? Math.max(0, Math.min(Number(out.life), out.lifeMax))
    : out.lifeMax;
  out.lifePool = Math.max(0, Math.trunc(Number(out.lifePool) || 0));
  // ★ aw：个体特征归一化（旧档 schema=1 无此字段 ⇒ 取默认，不阻断读档）。
  out.grade = (out.grade != null && out.grade !== '')
    ? (GRADE_ALIAS[out.grade] || out.grade)   // ★ az：旧档品级名迁移（良好→优秀、优秀→杰出）
    : null;
  out.variant = !!out.variant;
  out.growRate = Number.isFinite(Number(out.growRate)) ? Number(out.growRate) : null;
  // ★ ay 旧档迁移：早期捕捉的宠物把物种名直接存成 petId（非唯一编码）。
  //   ⇒ 物种名移入 family，petId 换成新生成的唯一编码，同物种多只才能区分。
  //   原版导入档的 petId 是 UUID（含 '-'），保持原样不动。
  const _hadFamily = (raw.family != null && String(raw.family) !== '');
  if (!_hadFamily && out.petId) {
    if (!String(out.petId).includes('-')) { out.family = String(out.petId); out.petId = newPetId(); }
    else out.family = '';                    // UUID：原版导入档，family 留空
  }
  return out;
}

// ───────────────────────── 红线校验 ─────────────────────────
/** 校验单条实例：不许出现契约外字段，不许混入静态资质/展示字段。 */
export function assertInstance(inst, at = '?') {
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) warnOrThrow(`pets[${at}] 必须是对象`);
  const keys = Object.keys(inst);
  const bad = keys.filter((k) => FORBIDDEN_INSTANCE_KEYS.indexOf(k) >= 0);
  if (bad.length) warnOrThrow(`pets[${at}] 混入禁存字段 ${JSON.stringify(bad)}（静态数据一律查 Config.pets）`);
  const extra = keys.filter((k) => INSTANCE_KEYS.indexOf(k) < 0);
  if (extra.length) warnOrThrow(`pets[${at}] 有契约外字段 ${JSON.stringify(extra)}`);
  if (!inst.uid) warnOrThrow(`pets[${at}].uid 为空`);
  if (!inst.petId) warnOrThrow(`pets[${at}].petId 为空`);
  if (!Array.isArray(inst.skillList)) warnOrThrow(`pets[${at}].skillList 必须是 id 数组`);
  else inst.skillList.forEach((s, i) => {
    if (!Number.isFinite(Number(s))) warnOrThrow(`pets[${at}].skillList[${i}] 不是数字（技能 id 数组，勿塞对象）`);
  });
  return true;
}

/** 全校验（存盘前 / 读档后调用）。 */
export function assertPetsSave(save, at = 'save') {
  if (!save || typeof save !== 'object') warnOrThrow(`${at} 不是对象`);
  if (Number(save.schema) !== SAVE_SCHEMA) warnOrThrow(`${at}.schema=${save.schema} 与当前契约 ${SAVE_SCHEMA} 不符`);
  if (!Array.isArray(save.pets)) warnOrThrow(`${at}.pets 必须是数组`);
  save.pets.forEach((p, i) => assertInstance(p, i));
  return true;
}

// ───────────────────────── 实例仓库 ─────────────────────────
class PetStateStore {
  constructor() {
    this.list = [];          // PetInstance[]（引用被 ui._pets 持有，战斗侧直接读写）
    this.activeUid = null;   // 出战实例 uid
    this.abandoned = [];     // ★ bv：抛弃池（放生宠物的快照，上限 MAX_ABANDONED）
    this._booted = false;
  }

  /**
   * 首次播种：有存档则读档（保留玩家进度），否则从 Config.pets 实例化。
   * 幂等 —— 重复调用不再播种。
   */
  boot(protos) {
    if (this._booted) return this;
    this._booted = true;

    const saved = this.loadRaw();
    if (saved && Array.isArray(saved.pets) && saved.pets.length) {
      this.list = saved.pets.map((p, i) => normalizeInstance(p, p.uid || ('pi_' + (i + 1))));
      this.activeUid = saved.activeUid || null;
      this.abandoned = Array.isArray(saved.abandoned) ? saved.abandoned.slice(-MAX_ABANDONED) : [];   // ★ bv
      this.syncActiveFromState();
      return this;
    }

    const src = Array.isArray(protos) ? protos : [];
    this.list = src.map((p, i) => makeInstance(p, 'pi_' + (i + 1)));
    this.activeUid = null;
    return this;
  }

  /** 让 activeUid 与 state===1 保持一致（读档/外部改动后调用）。允许多只参战，activeUid 指向首只。 */
  syncActiveFromState() {
    const dep = this.list.filter((p) => p.state === 1);
    if (dep.length > MAX_DEPLOYED) {   // 上限保护：超出部分撤下
      dep.slice(MAX_DEPLOYED).forEach((p) => { p.state = 0; });
    }
    this.activeUid = (this.activeUid && dep.some((p) => p.uid === this.activeUid))
      ? this.activeUid
      : (dep.length ? dep[0].uid : null);
  }

  get active() { return this.list.find((p) => p.uid === this.activeUid) || null; }
  get activePetId() { const a = this.active; return a ? a.petId : null; }
  /** 战斗侧口径：state===1 的宠物（scene.js 判据）。 */
  get deployed() { return this.list.filter((p) => p.state === 1); }
  byUid(uid) { return this.list.find((p) => p.uid === String(uid)) || null; }
  byPetId(pid) { return this.list.find((p) => String(p.petId) === String(pid)) || null; }

  /**
   * 设为出战 / 撤下出战（切换语义，用户裁决 2026-09-19：最多 MAX_DEPLOYED 只同时参战）。
   *   - 已出战 ⇒ 撤下（state=0），activeUid 顺延到下一只参战宠物
   *   - 未出战 ⇒ 参战（state=1）
   * ★ br：参战是 FIFO 队列 —— 满员时新参战的宠物顶掉「最早参战」的那只（list 顺序即入队顺序）。
   * 返回：操作后该宠物是否处于参战态（恒为 true，除非宠物不存在）。
   */
  setActive(uid) {
    const t = this.byUid(uid);
    if (!t) return false;
    if (t.state === 1) {
      t.state = 0;
      const dep = this.deployed;
      this.activeUid = dep.length ? dep[0].uid : null;
    } else {
      const dep = this.deployed;
      if (dep.length >= MAX_DEPLOYED && dep.length) {
        const oldest = dep[0];             // 队首 = 最早参战
        oldest.state = 0;
        this._evicted = oldest.uid;        // 供调用方提示「替换了谁」
      }
      t.state = 1;
      this.activeUid = t.uid;              // 新参战者成为战斗召唤首选
    }
    this.save();
    return t.state === 1;
  }

  /** 取走最近一次被队列挤出参战的宠物 uid（供面板提示后清空）。 */
  consumeEvicted() { const u = this._evicted || null; this._evicted = null; return u; }

  /**
   * 放生：从列表删除，快照丢入抛弃池（上限 MAX_ABANDONED，溢出丢最早一只）。
   * ★ bv：以后做「恢复」功能时可直接从 this.abandoned 取回。
   */
  abandon(uid) {
    const t = this.byUid(uid);
    if (!t) return false;
    const snap = {};
    for (const k of INSTANCE_KEYS) snap[k] = t[k];
    snap.uid = String(t.uid);
    snap.petId = String(t.petId);
    snap.skillList = Array.isArray(t.skillList) ? t.skillList.slice() : [];
    snap.skillLevels = t.skillLevels || {};
    snap.advanceState = t.advanceState || {};
    snap.abandonAt = Date.now();
    this.list = this.list.filter((p) => p !== t);
    if (this.activeUid === snap.uid) {
      const dep = this.deployed;
      this.activeUid = dep.length ? dep[0].uid : null;
    }
    this.abandoned.push(snap);
    if (this.abandoned.length > MAX_ABANDONED) this.abandoned.shift();
    this.save();
    return true;
  }

  /** 参战是否已满（面板按钮提示用）。 */
  forgetSkill(petId, skillId) {
    // cc: pet detail panel skill-delete button. Removes skill + its level entry and saves.
    // Battle-time blocking is the caller responsibility (no skill-bar edits in battle).
    const t = this.byPetId(petId);
    if (!t) return false;
    const id = num(skillId);
    const key = String(skillId);
    const had = Array.isArray(t.skillList) && t.skillList.some((x) => num(x) === id);
    if (!had) return false;
    t.skillList = t.skillList.filter((x) => num(x) !== id);
    if (t.skillLevels) { delete t.skillLevels[key]; delete t.skillLevels[id]; }
    this.save();
    return true;
  }

  get deployFull() { return this.deployed.length >= MAX_DEPLOYED; }

  /** 撤下指定宠物的出战（不动其它参战宠物）。 */
  undeploy(uid) {
    const t = this.byUid(uid);
    if (!t || t.state !== 1) return false;
    t.state = 0;
    const dep = this.deployed;
    this.activeUid = dep.length ? dep[0].uid : null;
    this.save();
    return true;
  }

  /** 取消出战。 */
  clearActive() {
    this.list.forEach((p) => { p.state = 0; });
    this.activeUid = null;
    this.save();
  }

  /**
   * 新增一只实例（原型 → 实例）。
   * ★ 用途：由「任务物品直接获得宠物」等正规发放入口调用（原战斗内 catch 近似实现已按用户裁决移除）。
   *   传入的 proto 需是 op572 原生名字段（petId/level/hpMax/hpCur/grade/variant/growRate/...），构造后只保留契约键。
   *   ★ aw：原型不必在 Config.pets 中 —— protoOf 会回退查统一角色信息表 Config.chars
   *     （按 name 匹配），pet.js 的 view() 再用 charToPetProto 合成属性视图。
   */
  addFromProto(proto) {
    // ★ ay：每只宠物分配唯一编码（petId）；物种键取 family，缺省回退 proto.petId（兼容旧调用方）。
    const p = proto || {};
    const family = (p.family != null && String(p.family) !== '') ? String(p.family)
      : (p.petId != null ? String(p.petId) : '');
    const n = this.list.length;
    const inst = makeInstance(Object.assign({}, p, { family, petId: newPetId() }),
      'pi_' + (n + 1 + Date.now() % 100000));
    this.list.push(inst);
    return inst;
  }

  // ── 存档 ──
  toPlain() {
    return {
      schema: SAVE_SCHEMA,
      activeUid: this.activeUid,
      abandoned: (this.abandoned || []).slice(-MAX_ABANDONED),   // ★ bv：抛弃池随档持久化
      pets: this.list.map((p) => {
        const o = {};
        for (const k of INSTANCE_KEYS) o[k] = p[k];
        o.uid = String(p.uid);
        o.petId = String(p.petId);
        o.skillList = Array.isArray(p.skillList) ? p.skillList.slice() : [];
        o.skillLevels = p.skillLevels || {};
        o.advanceState = p.advanceState || {};
        return o;
      }),
    };
  }

  /** 落盘。任何异常都不阻断游戏（铁律：主循环/登录不可被杀）。 */
  save() {
    try {
      const plain = this.toPlain();
      assertPetsSave(plain);
      localStorage.setItem(SAVE_KEY, JSON.stringify(plain));
      return true;
    } catch (e) {
      console.warn('[pet-state] 存盘失败（已兜底，不阻断）', e);
      return false;
    }
  }

  loadRaw() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (Number(d.schema) !== SAVE_SCHEMA) {
        console.warn('[pet-state] 存档 schema=' + d.schema + ' 与当前 ' + SAVE_SCHEMA + ' 不符，丢弃旧档');
        return null;
      }
      return d;
    } catch (e) {
      console.warn('[pet-state] 读档失败（已兜底）', e);
      return null;
    }
  }

  /**
   * 用一份宠物存档文档**整体替换**实例层（完整存档的读档/回滚入口）。
   * ★ 注意：会新建 this.list 数组 ⇒ 外部持有旧数组引用处（ui._pets）必须重新指向 store.list。
   * @param {object} doc {schema, activeUid, pets:[]}
   * @returns {boolean} 是否成功（结构不符 / 异常一律返回 false，不抛）
   */
  loadFromSave(doc) {
    try {
      if (!doc || typeof doc !== 'object') return false;
      if (Number(doc.schema) !== SAVE_SCHEMA) {
        console.warn('[pet-state] 读档 schema=' + doc.schema + ' 与当前 ' + SAVE_SCHEMA + ' 不符');
        return false;
      }
      if (!Array.isArray(doc.pets)) return false;
      const list = doc.pets.map((p, i) => normalizeInstance(p, p.uid || ('pi_' + (i + 1))));
      list.forEach((p, i) => assertInstance(p, i));   // 红线校验（禁存字段 / 契约外字段）
      this.list = list;
      this.activeUid = doc.activeUid || null;
      this.abandoned = Array.isArray(doc.abandoned) ? doc.abandoned.slice(-MAX_ABANDONED) : [];   // ★ bv
      this.syncActiveFromState();                     // 出战互斥：以 state===1 为准重算
      this._booted = true;
      this.save();
      return true;
    } catch (e) {
      console.warn('[pet-state] 读档失败（已兜底，不改动当前实例层）', e);
      return false;
    }
  }

  /** 清档并重新播种（调试用）。 */
  reset(protos) {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    this._booted = false;
    this.list = [];
    this.activeUid = null;
    this.boot(protos);
    return this;
  }
}

// ───────────────────────── 单例 ─────────────────────────
let _inst = null;
export function petState() {
  if (!_inst) {
    _inst = new PetStateStore();
    try { window.__PETS = _inst; } catch (e) {}
  }
  return _inst;
}
