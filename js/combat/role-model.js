// role-model.js
// 角色 / 宠物 属性系统（按策划案 §1.1 / §1.2 / §2.1 / §2.2 / §2.3）
//
// 设计原则：
// - 所有数值系数严格来自策划案，不臆造。
// - 宠物相关未定义项用「占位常量 + 明确 TODO」：
//     · PET_GROWTH 宠物成长率（CSV 未给，默认借用 0.40，待补真实值）
//     · 宠物职业系数 PET_COEFF 中性 1.0（CSV 无职业列，待补）
//     · 宠物 atk_type 由最高主资质推断（str→phy / int→mag）
// - 浏览器接入时 import 需带 ?v=<BUILD_STAMP>（本目录未接入 index.html，暂不强制）。

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v);

// ── §1.1 常量 ──────────────────────────────────────────────
export const HUMAN_GROWTH = 0.40;
// ★ 占位：宠物成长率。CSV 未提供，默认借用 0.40 仅作可跑基准，真实值待补。
export const PET_GROWTH = 0.40; // TODO: 真实宠物成长率（见游戏数据）

// 未转生初始总资质 22000
export const CHARACTER_APT = {
  '男侠客': { str: 7200, con: 6400, agi: 2800, int: 1600, spi: 4000, job: '侠客', atk_type: 'phy' },
  '女侠客': { str: 6800, con: 6400, agi: 3200, int: 1600, spi: 4000, job: '侠客', atk_type: 'phy' },
  '男刺客': { str: 6400, con: 4800, agi: 6800, int: 2000, spi: 2000, job: '刺客', atk_type: 'phy' },
  '女刺客': { str: 6000, con: 4800, agi: 7000, int: 2200, spi: 2000, job: '刺客', atk_type: 'phy' },
  '男术士': { str: 3200, con: 4800, agi: 3600, int: 7600, spi: 2800, job: '术士', atk_type: 'mag' },
  '女术士': { str: 3200, con: 4400, agi: 3600, int: 8000, spi: 2800, job: '术士', atk_type: 'mag' },
  '男修真': { str: 3600, con: 5200, agi: 4000, int: 6000, spi: 3200, job: '修真', atk_type: 'mag' },
  '女修真': { str: 3600, con: 4800, agi: 4000, int: 6400, spi: 3200, job: '修真', atk_type: 'mag' }
};

// ── §1.2 职业专属转化系数 ──────────────────────────────────
export const JOB_COEFF = {
  '刺客': { agi_to_phy_dodge: 1.87, agi_to_phy_crit: 5.00, spi_to_mag_dodge: 0.50, spi_to_mag_crit: 1.50 },
  '侠客': { agi_to_phy_dodge: 1.00, agi_to_phy_crit: 3.50, spi_to_mag_dodge: 1.00, spi_to_mag_crit: 2.20 },
  '修真': { agi_to_phy_dodge: 1.00, agi_to_phy_crit: 2.20, spi_to_mag_dodge: 1.87, spi_to_mag_crit: 3.50 },
  '术士': { agi_to_phy_dodge: 0.50, agi_to_phy_crit: 1.50, spi_to_mag_dodge: 1.00, spi_to_mag_crit: 2.20 }
};

// 宠物中性系数（CSV 无职业列，占位）
export const PET_COEFF = {
  agi_to_phy_dodge: 1.0, agi_to_phy_crit: 1.0,
  spi_to_mag_dodge: 1.0, spi_to_mag_crit: 1.0
}; // TODO: 宠物职业系数待补

// 五个主属性键顺序（与 §1.1 / §2.x 一致）
export const PRIMARY_KEYS = ['str', 'con', 'agi', 'int', 'spi'];

// ── §2.1 一级属性（升级自动增长）───────────────────────────
// PrimaryStat = apt * GROWTH / 1000 * L
function primaryStat(apt, growth, L) {
  return r1((apt * growth) / 1000 * L);
}

// ── §2.2 二级基础属性 ──────────────────────────────────────
function computeBase(p) {
  const { str, con, agi, int, spi } = p;
  const hp = r1(2 * str + 24 * con + 3 * agi + 1 * int + 3 * spi);
  const mp = r1(2 * str + 1 * con + 2 * agi + 10 * int + 2 * spi);
  // RageMax 按公式；进场初始怒气按配置折算（本版无技能，初始怒气默认 100，受 RageMax 上限约束）
  const rageMax = r1(2 * str + 8 * con + 2 * agi + 2 * int + 12 * spi);
  const spd = Math.round((0.2 * str + 0.2 * con + 2.0 * agi + 0.1 * int + 0.2 * spi) * 10) / 10;
  const recover = Math.max(0.0, Math.round((-0.2 * str + 0.8 * con + 0.2 * agi - 0.3 * int - 0.1 * spi) * 100) / 100);
  return { hp, mp, rageMax, spd, recover };
}

// ── §2.3 二级战斗属性 ──────────────────────────────────────
function computeCombat(p, coeff) {
  const { str, con, agi, int, spi } = p;
  const atk    = r1(2.2 * str + 0.1 * con + 0.2 * agi + 0.1 * int + 0.2 * spi); // 物攻
  const def    = r1(0.2 * str + 0.1 * con + 0.2 * agi + 0.1 * int + 2.2 * spi); // 物防
  const mag    = r1(1.7 * int);                                                 // 法攻
  const magDef = r1(2.2 * con);                                                 // 法防
  const phyHit = r1(agi * 18.0);   // 物命
  const magHit = r1(spi * 18.0);   // 法命
  const phyDodge = r1(agi * coeff.agi_to_phy_dodge); // 物闪
  const phyCrit  = r1(agi * coeff.agi_to_phy_crit);  // 物暴
  const magDodge = r1(spi * coeff.spi_to_mag_dodge); // 法闪
  const magCrit  = r1(spi * coeff.spi_to_mag_crit);  // 法暴
  return { atk, def, mag, magDef, phyHit, magHit, phyDodge, phyCrit, magDodge, magCrit };
}

// ── RoleModel ──────────────────────────────────────────────
export class RoleModel {
  /**
   * @param {object} opts
   *   kind:    'human' | 'pet'
   *   name:    显示名
   *   apt:     {str,con,agi,int,spi} 已解析的资质（一级属性输入源）
   *   level:   等级 L
   *   job:     职业（human 用；pet 可空）
   *   atkType: 'phy' | 'mag'
   *   growth:  成长率（默认 human=HUMAN_GROWTH, pet=PET_GROWTH）
   */
  constructor(opts) {
    if (!opts || !opts.apt) throw new Error('RoleModel: apt required');
    this.kind = opts.kind || 'human';
    this.name = opts.name || (this.kind === 'pet' ? '宠物' : '角色');
    this.apt = {
      str: +opts.apt.str || 0, con: +opts.apt.con || 0,
      agi: +opts.apt.agi || 0, int: +opts.apt.int || 0, spi: +opts.apt.spi || 0
    };
    this.level = Math.max(1, opts.level | 0);
    this.job = opts.job || null;
    this.atkType = opts.atkType || 'phy';
    this.growth = (opts.growth != null) ? opts.growth
      : (this.kind === 'pet' ? PET_GROWTH : HUMAN_GROWTH);
    if (this.kind === 'human') {
      const c = JOB_COEFF[this.job];
      if (!c) throw new Error('RoleModel: unknown job "' + this.job + '" (need 刺客/侠客/修真/术士)');
      this.coeff = c;
    } else {
      this.coeff = PET_COEFF; // 占位
    }
  }

  // 派生物属性（一级 + 二级基础 + 二级战斗），返回完整面板
  derive() {
    const p = {};
    for (const k of PRIMARY_KEYS) p[k] = primaryStat(this.apt[k], this.growth, this.level);
    const base = computeBase(p);
    const combat = computeCombat(p, this.coeff);
    return {
      kind: this.kind, name: this.name, job: this.job, atkType: this.atkType,
      level: this.level, growth: this.growth,
      apt: { ...this.apt },
      primary: p,
      // 二级基础
      maxHp: base.hp, maxMp: base.mp, rageMax: base.rageMax,
      spd: base.spd, recover: base.recover,
      // 二级战斗
      atk: combat.atk, def: combat.def, mag: combat.mag, magDef: combat.magDef,
      phyHit: combat.phyHit, magHit: combat.magHit,
      phyDodge: combat.phyDodge, phyCrit: combat.phyCrit,
      magDodge: combat.magDodge, magCrit: combat.magCrit
    };
  }

  // 直接给出战斗单位所需的派生 stat 子集
  toCombatStats() {
    const d = this.derive();
    return {
      maxHp: d.maxHp, maxMp: d.maxMp, rageMax: d.rageMax,
      spd: d.spd, recover: d.recover,
      atk: d.atk, def: d.def, mag: d.mag, magDef: d.magDef,
      phyHit: d.phyHit, magHit: d.magHit,
      phyDodge: d.phyDodge, phyCrit: d.phyCrit,
      magDodge: d.magDodge, magCrit: d.magCrit
    };
  }
}

// ── 工厂：角色 ─────────────────────────────────────────────
export function fromCharacter(className, level) {
  const def = CHARACTER_APT[className];
  if (!def) throw new Error('fromCharacter: unknown class "' + className + '"');
  return new RoleModel({
    kind: 'human', name: className,
    apt: { str: def.str, con: def.con, agi: def.agi, int: def.int, spi: def.spi },
    level, job: def.job, atkType: def.atk_type, growth: HUMAN_GROWTH
  });
}

// ── 工厂：宠物 ─────────────────────────────────────────────
// 由 CSV 行解析资质。CSV 列：耐力/强壮/信仰/敏捷/智力（= con/str/spi/agi/int），各有 _最低/_最高。
// useMax=true 取最高档为基准（默认）；两档都保留在 meta 供查阅。
export function resolvePetAptitude(row, useMax = true) {
  const pick = (base) => {
    const lo = row[base + '_最低'], hi = row[base + '_最高'];
    if (lo == null && hi == null) return 0;
    if (useMax) return (hi != null && hi !== '' && hi !== '不详') ? +hi : +lo;
    return (lo != null && lo !== '' && lo !== '不详') ? +lo : +hi;
  };
  const apt = {
    con: pick('耐力资质'), str: pick('强壮资质'), spi: pick('信仰资质'),
    agi: pick('敏捷资质'), int: pick('智力资质')
  };
  const meta = {
    conMin: +row['耐力资质_最低'] || 0, conMax: +row['耐力资质_最高'] || 0,
    strMin: +row['强壮资质_最低'] || 0, strMax: +row['强壮资质_最高'] || 0,
    spiMin: +row['信仰资质_最低'] || 0, spiMax: +row['信仰资质_最高'] || 0,
    agiMin: +row['敏捷资质_最低'] || 0, agiMax: +row['敏捷资质_最高'] || 0,
    intMin: +row['智力资质_最低'] || 0, intMax: +row['智力资质_最高'] || 0
  };
  return { apt, meta };
}

// atk_type 推断：最高主资质 — str 主导→phy，int 主导→mag（其余默认 phy）
export function inferPetAtkType(apt) {
  return (apt.int >= apt.str) ? 'mag' : 'phy';
}

export function fromPet(row, level, opts = {}) {
  const { apt, meta } = resolvePetAptitude(row, opts.useMax !== false);
  const atkType = opts.atkType || inferPetAtkType(apt);
  const m = new RoleModel({
    kind: 'pet', name: row['宠物名称'] || '宠物',
    apt, level, job: null, atkType, growth: opts.growth != null ? opts.growth : PET_GROWTH
  });
  m.petMeta = meta;
  return m;
}
