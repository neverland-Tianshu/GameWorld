// combat-system.js
// 人宠双单位回合制战斗引擎（按策划案 §4.1 伤害 / §4.2 行动队列+保护 / §4.3 命中闪避暴击）
//
// 已确认规则（用户 2026-09-16）：
//   · 暴击倍率 = 2.0（以 §4.3 为准，§4.1 草稿里的 1.80 作废）
//   · 行动队列：每回合收集所有存活单位，按 spd 降序各行动一次（占位：player 侧 tie-break 优先）
//   · 保护判定：宠物可替主人承伤（target.linkedProtector 指向存活且 canProtect 的单位时，宠物成为实际承伤目标）
//   · 宠物资质取最高档、成长率占位、职业系数中性（见 role-model.js）
//
// 占位 / 默认（明确标注，非臆测）：
//   · DfdCritResist 未定义 → 默认 0
//   · SkillRate 普攻 = 1.0（技能可传各自倍率）
//   · 目标选择：敌方存活单位中当前 HP 最低者（简单 AI）

import { RoleModel } from './role-model.js?v=20261007c';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── §4.1 伤害结算 ──────────────────────────────────────────
// RawDmg = max(AtkPower*0.15, AtkPower - DefPower*0.65) * SkillRate
export function computeRawDamage(atkPower, defPower, skillRate = 1.0) {
  return Math.max(atkPower * 0.15, atkPower - defPower * 0.65) * skillRate;
}
// FinalDmg = RawDmg * (IsCrit ? 2.0 : 1.0) * uniform(0.95, 1.05)
export function rollFloat(rng) {
  rng = rng || Math.random;
  return 0.95 + rng() * 0.10;
}
export function finalDamage(raw, isCrit, rng) {
  const critMul = isCrit ? 2.0 : 1.0; // ★ 以 §4.3 的 2.0 为准
  return Math.max(1, Math.round(raw * critMul * rollFloat(rng)));
}

// ── §4.3 命中 / 闪避 / 暴击 三阶段 ─────────────────────────
// 命中阶段：MissRate = clamp(0.35 - AtkHit/(Latk*80), 0, 0.35)
export function rollMiss(atkHit, latk, rng) {
  rng = rng || Math.random;
  const missRate = clamp(0.35 - atkHit / (latk * 80.0), 0.0, 0.35);
  return rng() < missRate;
}
// 闪避阶段：DodgeRate = min(0.65, DfdDodge/(Latk*100))
export function rollDodge(dfdDodge, latk, rng) {
  rng = rng || Math.random;
  const dodgeRate = Math.min(0.65, dfdDodge / (latk * 100.0));
  return rng() < dodgeRate;
}
// 暴击阶段：CritRate = AtkCrit/(100*Latk) - DfdCritResist*0.0001；物理上限75%、法术上限100%
export function rollCrit(atkCrit, latk, isMag, dfdCritResist = 0, rng) {
  rng = rng || Math.random;
  let critRate = atkCrit / (100.0 * latk) - dfdCritResist * 0.0001;
  const cap = isMag ? 1.0 : 0.75;
  critRate = Math.min(critRate, cap);
  return rng() < Math.max(0, critRate);
}

// ── 战斗单位 ──────────────────────────────────────────────
// 由 RoleModel 派生结果构造战斗单位
export function combatantFromRole(role, opt = {}) {
  const s = role.toCombatStats();
  return {
    id: opt.id != null ? opt.id : role.name,
    name: opt.name || role.name,
    side: opt.side || 'player',           // 'player' | 'enemy'
    atkType: role.atkType || 'phy',        // 'phy' | 'mag'
    level: role.level,
    stats: s,
    hp: opt.hp != null ? opt.hp : s.maxHp,
    mp: opt.mp != null ? opt.mp : s.maxMp,
    rage: opt.rage != null ? opt.rage : Math.min(100, s.rageMax || 100),
    linkedProtector: opt.linkedProtector != null ? opt.linkedProtector : null,
    canProtect: opt.canProtect != null ? opt.canProtect : false,
    alive: true
  };
}

// ── CombatSystem ──────────────────────────────────────────
export class CombatSystem {
  constructor(opt = {}) {
    this.units = [];
    this.rng = opt.rng || Math.random;
    this.maxRounds = opt.maxRounds || 200;
    this.log = [];          // 每回合状态日志
    this.round = 0;
    this.winner = null;     // 'player' | 'enemy' | null(平局/超限)
    this.dfdCritResist = opt.dfdCritResist != null ? opt.dfdCritResist : 0; // ★ 占位默认 0
  }

  addUnit(u) { this.units.push(u); return u; }
  get alivePlayer() { return this.units.filter(u => u.side === 'player' && u.alive); }
  get aliveEnemy()  { return this.units.filter(u => u.side === 'enemy' && u.alive); }

  _unitById(id) { return this.units.find(u => u.id === id || String(u.id) === String(id)) || null; }

  // §4.2 行动队列：存活单位按 spd 降序；同速 player 侧优先（占位 tie-break）
  _buildQueue() {
    return this.units.filter(u => u.alive)
      .sort((a, b) => (b.stats.spd - a.stats.spd) || (a.side === 'player' ? -1 : 1));
  }

  // 目标选择：敌方存活单位中当前 HP 最低者
  _selectTarget(attacker) {
    const foes = (attacker.side === 'player' ? this.aliveEnemy : this.alivePlayer);
    if (!foes.length) return null;
    return foes.reduce((m, u) => (u.hp < m.hp ? u : m), foes[0]);
  }

  // 单次行动：命中→闪避→暴击→伤害→承伤
  _act(attacker, round) {
    const target = this._selectTarget(attacker);
    if (!target) return;

    // §4.2 保护判定：target 有存活且可承伤的 linkedProtector → 宠物替主人承伤
    let defender = target;
    let protectedBy = null;
    if (target.linkedProtector != null) {
      const prot = this._unitById(target.linkedProtector);
      if (prot && prot.alive && prot.canProtect) { defender = prot; protectedBy = prot.name; }
    }

    const isMag = attacker.atkType === 'mag';
    const atkPow = isMag ? attacker.stats.mag : attacker.stats.atk;
    const defPow = isMag ? defender.stats.magDef : defender.stats.def;
    const atkHit = isMag ? attacker.stats.magHit : attacker.stats.phyHit;
    const dfdDodge = isMag ? defender.stats.magDodge : defender.stats.phyDodge;
    const atkCrit = isMag ? attacker.stats.magCrit : attacker.stats.phyCrit;

    const entry = {
      round, attacker: attacker.name, target: target.name,
      defender: defender.name, damageType: isMag ? 'mag' : 'phy',
      result: 'HIT', damage: 0, targetHpAfter: defender.hp,
      protectedBy
    };

    // 命中阶段
    if (rollMiss(atkHit, attacker.level, this.rng)) {
      entry.result = 'MISS';
      this.log.push(entry);
      return;
    }
    // 闪避阶段（defender 的闪避）
    if (rollDodge(dfdDodge, attacker.level, this.rng)) {
      entry.result = 'DODGE';
      this.log.push(entry);
      return;
    }
    // 暴击阶段
    const isCrit = rollCrit(atkCrit, attacker.level, isMag, this.dfdCritResist, this.rng);
    // 伤害
    const raw = computeRawDamage(atkPow, defPow, 1.0); // ★ 普攻 SkillRate=1.0
    const dmg = finalDamage(raw, isCrit, this.rng);
    defender.hp = Math.max(0, defender.hp - dmg);
    entry.result = isCrit ? 'CRIT' : 'HIT';
    entry.damage = dmg;
    entry.targetHpAfter = defender.hp;
    if (defender.hp <= 0) {
      defender.alive = false;
      entry.targetDown = true;
    }
    this.log.push(entry);
  }

  // 运行整场对决，返回 {log, rounds, winner, final}
  run() {
    this.log = [];
    this.round = 0;
    this.winner = null;
    while (this.round < this.maxRounds) {
      this.round++;
      const queue = this._buildQueue();
      if (!queue.length) break;
      for (const u of queue) {
        if (!u.alive) continue;
        if (!this.aliveEnemy.length || !this.alivePlayer.length) break;
        this._act(u, this.round);
      }
      if (!this.aliveEnemy.length || !this.alivePlayer.length) break;
    }
    if (!this.aliveEnemy.length && this.alivePlayer.length) this.winner = 'player';
    else if (!this.alivePlayer.length && this.aliveEnemy.length) this.winner = 'enemy';
    else this.winner = null; // 双方同灭或达 maxRounds
    return {
      log: this.log,
      rounds: this.round,
      winner: this.winner,
      final: this.units.map(u => ({
        id: u.id, name: u.name, side: u.side, alive: u.alive,
        hp: u.hp, maxHp: u.stats.maxHp
      }))
    };
  }

  // 人类可读日志
  formatLog() {
    return this.log.map(e => {
      const prot = e.protectedBy ? ` (${e.protectedBy}承伤)` : '';
      const dmg = e.damage > 0 ? ` -${e.damage}` : '';
      return `R${e.round} ${e.attacker} → ${e.target}${prot} [${e.damageType}/${e.result}]${dmg} 余血${e.targetHpAfter}`;
    }).join('\n');
  }
}
