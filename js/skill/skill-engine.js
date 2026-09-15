// skill-engine.js
// 技能引擎核心（对齐 _pdf_text.txt 的 26 个 AS3 派生精确公式 + 回合各阶段事件）。
// 这是战斗内"技能执行"与"受击/被受击/出手前后/增益减益联动"的唯一真源：
//   - rollFloat():    ×(0.9~1.1) 随机浮动（从 {0.9,0.91,…,1.1} 等距取一个）
//   - ceilDiv/floorDiv: 持续回合数取整（无下划线=向上取整，带下划线=向下取整）
//   - resolveTargets(): 技能范围判定（单体/横排/竖排/十字/矩形/1~6，10级与11级扩展，三圣箴言加成）
//   - castSkill():    执行技能（按 SKILLS 表逐技能公式落地伤害/治疗/buff/联动）
//   - onDamaged():    受击钩子（昊天罡气护盾吸收、同生共死分担+侠义之心、仙气护体受击回血、腐骨蚀心吸血、穿心蚀骨伤害池）
//   - statusAtTurnStart(): 回合开始钩子（眩晕/昏睡跳过行动）
//   - redirectTarget():     出手前钩子（嘲讽强制目标、混乱随机目标）
// 不臆造任何数值：所有公式系数均来自 PDF；"有概率"类未给精确百分比处用 PROB 常量并标注。

import { Config, url, ACTION } from '../core/globals.js?v=20261007c';
import { rint as _rint } from '../entities/attrs.js?v=20261007c';   // 属性加成统一取整
import { getCombat } from '../core/rt.js?v=20261007c';

// ───────────────────────── 基础工具 ─────────────────────────
// ×(0.9~1.1) 浮点：等距 21 档
const ROLL_STEPS = (() => { const a = []; for (let v = 0.9; v <= 1.1001; v += 0.01) a.push(Math.round(v * 100) / 100); return a; })();
export function rollFloat(rng) {
  rng = rng || Math.random;
  return ROLL_STEPS[Math.floor(rng() * ROLL_STEPS.length)];
}
// 持续回合数取整：无下划线=向上取整（ceil），带下划线=向下取整（floor）
export function ceilDiv(a, b) { return Math.ceil(a / b); }
export function floorDiv(a, b) { return Math.floor(a / b); }
// 持续回合数取整：PDF 约定"除法 a/b 无下划线=向上取整，带下划线=向下取整"。
// 引擎内 dur(x) 始终接收"已算好的整段持续值"（如 3+修为/12000、1+L/3），向上取整即 ceil(x)。
export function dur(a) { return Math.ceil(a); }

// "有概率"类未给精确百分比的统一概率（PDF 仅写"有概率"，无数值时保守取值，标注于审计）
const PROB = 0.4;

function xw(fig) { return fig.xiuwei || 0; }            // 修为
function cishan(fig) { return fig.cishan || 0; }         // 慈悲心怀等级
function findFig(scene, id) {
  // ★ 宽松比较：forceTarget 写回的是 String(id)，而单位 id 可能是 number（如玩家 charId 派生的 id），
  //   严格 === 会让 findFig('135002') 漏掉 id=135002 的玩家 ⇒ 嘲讽强制目标解析失败（敌人跑去打友方）。
  return [scene.pFig, ...(scene.allies || []), ...scene.enemies].filter(f => f && (f.id === id || String(f.id) === String(id)))[0] || null;
}
function aliveFoesOf(scene, caster) {
  return caster.side === 'player'
    ? scene.enemies.filter(e => e && e.hp > 0)
    : [scene.pFig, ...(scene.allies || [])].filter(f => f && f.hp > 0);
}
function aliveFriendsOf(scene, caster) {
  return caster.side === 'player'
    ? [scene.pFig, ...(scene.allies || [])].filter(f => f && f.hp > 0)
    : scene.enemies.filter(e => e && e.hp > 0);
}
// 读取技能是否配置了自定义"释放目标/范围"（测试页可调参数 params.scope）。
// 仅当显式 enabled 时返回该配置，否则返回 null → 由下方 switch 按原版逻辑判定（主游戏零回归）。
function skillScope(skill) {
  const p = skill && skill.params;
  return (p && p.scope && p.scope.enabled) ? p.scope : null;
}

// 给单位挂一个 buff（def 可被 opts 覆盖 duration/level/data）。statAdd 类在 addBuff 时即时叠加，过期时回退。
function giveBuff(fig, def, opts = {}) {
  const d = Object.assign({}, def);
  if (opts.duration != null) d.duration = opts.duration;
  if (opts.level != null) d.level = opts.level;
  if (opts.silent) d.silent = true;   // 被动技能挂的永久 buff：不显示头顶图标（效果照常）
  // ★ 阶段3：技能模板常直接构造"内联 def"挂 buff（如 { id:'xianqi', kind:'xianqi', ... }）。
  //   此处让内联 def 自动继承 config/buffs.json 中**同名 id** 的字段：
  //   ① 内联缺失的字段（如 dot/color/immune…）从 config 补齐 —— 修复"四相诀的灼烧内联 def 缺 dot，导致毒伤为 0"；
  //   ② triggers（内联自带则不覆盖）。
  if (d.id) {
    const cfg = (Config.data && Config.data.buffs && Config.data.buffs[d.id]) || null;
    if (cfg) {
      for (const k in cfg) {
        if (k === 'id' || k === 'triggers') continue;
        if (d[k] === undefined) d[k] = cfg[k];   // 内联值优先，缺失才补
      }
      if ((!d.triggers || !d.triggers.length) && cfg.triggers && cfg.triggers.length) d.triggers = cfg.triggers;
    }
  }
  fig.addBuff(d, opts.stack || 1, opts.data || null, opts);
  return d;
}

// ───────────────────────── 被动技能挂载（D 组·被动技能）─────────────────────────
// 战斗启动/单位进场时调用：扫描单位技能表，把「被动技能」声明的 buff 永久挂到单位身上。
//   技能配置：skill.passive = true; skill.passiveBuffs = [{ buff:'<buffId>', target:'self',
//     stack?, duration?, data?, dataFormula?: { 字段: '表达式' } }]
//   ★ dataFormula：以 L=技能等级、fig=单位 在沙箱内求值（与 evalBuffProb 同一策略，异常→丢弃该字段）。
//     解决 JSON 无法表达 1/(2-0.1×L) 之类的公式、且 _valueOf 强制取整不能算小数比例的问题。
//   ★ 幂等：同一单位重复调用不重复挂（__passiveApplied）。
// ★ reapplyPassiveBuffs(fig)：先回退旧被动 buff 的加成再重挂 —— 用于池复用的敌人/宠物
//   （clearBuffs 保留被动 buff，故同一 Fighter 被重新分配给别的怪物时必须先回退再重算）。
export function reapplyPassiveBuffs(fig) {
  if (!fig) return;
  if (Array.isArray(fig.buffs) && fig.buffs.length) {
    const kept = [];
    for (const b of fig.buffs) {
      if (!b._passive) { kept.push(b); continue; }
      if (b.def && b.def.statAdd && typeof fig._applyStatAdd === 'function') fig._applyStatAdd(b.def.statAdd, -1);
      if (typeof fig._stopStatusAnim === 'function') { try { fig._stopStatusAnim(b); } catch (e) {} }
    }
    fig.buffs = kept;
    if (typeof fig._refreshBuffIcons === 'function') fig._refreshBuffIcons();
  }
  fig.__passiveApplied = false;
  applyPassiveBuffs(null, fig);
}
export function applyPassiveBuffs(scene, fig) {
  if (!fig || fig.__passiveApplied) return;
  fig.__passiveApplied = true;
  const skills = (Config.data && Config.data.skills) || null;
  if (!skills) return;
  const list = Array.isArray(fig.skills) ? fig.skills
    : (Array.isArray(fig.skillList) ? fig.skillList : []);
  for (const id of list) {
    const sk = skills[id] || skills[String(id)];
    if (!sk || !sk.passive || !Array.isArray(sk.passiveBuffs)) continue;
    const L = (typeof fig.skillLevel === 'function') ? (fig.skillLevel(id) || 1) : (fig.level || 1);
    for (const spec of sk.passiveBuffs) {
      if (spec.target && spec.target !== 'self') continue;      // 被动只挂自身
      // ★ restrict：限定能拥有该被动的单位种类（人物 lifeMax=0 / 宠物 lifeMax>0 / 人物 rageMax>0）
      //   智慧守护消耗寿命 ⇒ restrict:'life' ⇒ 仅宠物；玩家的 fig.skills 是全技能目录，必须靠它排除。
      if (spec.restrict) {
        const ok = (spec.restrict === 'life') ? ((fig.lifeMax || 0) > 0)
          : (spec.restrict === 'rage') ? ((fig.rageMax || 0) > 0) : true;
        if (!ok) continue;
      }
      let def = lookupBuffDef(spec.buff, spec.duration != null ? spec.duration : undefined);
      if (!def) continue;
      // 属性类被动（物理防御上升 等）：statAddFormula 按等级公式算出 statAdd，挂到 def 副本上
      //   （def 是全局共享对象，必须拷贝再改，否则同 id buff 会被串改）
      if (spec.statAddFormula) {
        const sa = _evalDataFormula(spec.statAddFormula, fig, L);
        const clean = {};
        for (const k in sa) if (Number.isFinite(Number(sa[k]))) clean[k] = Number(sa[k]);
        def = Object.assign({}, def, { statAdd: clean });
      }
      let data = (spec.data != null) ? Object.assign({}, spec.data) : {};
      if (spec.dataFormula) data = Object.assign(data, _evalDataFormula(spec.dataFormula, fig, L));
      if (data.level == null) data.level = L;
      giveBuff(fig, def, { stack: spec.stack || 1, data, silent: true, passive: true });   // ★ 被动 buff：无图标（用户裁决）
    }
  }
}
// 战斗外（宠物面板/角色面板）汇总被动技能提供的属性加成：与 applyPassiveBuffs 同一公式口径。
//   fig：Fighter 实例，或字段名对齐 Fighter 的代理对象（面板侧由 op572 宠物字段映射而来：
//     atk←attack / def←defense / mag←magicAttack / magDef←magicDef / spd←speed /
//     maxHp←hpMax / maxMp←mpMax / phyCrit←phyBang / phyDodge←phyJook /
//     magCrit←magicBang / magDodge←magicJook / strength←strong / stamina←vitality /
//     agility←agile / intellect←intellect / faith←belief）。
//   返回 { atk, def, mag, maxHp, stamina, ... } 加成总和（公式异常/未命中不贡献）。
export function sumPassiveStatAdd(fig, list, skillLevels) {
  const out = {};
  const skills = (Config.data && Config.data.skills) || null;
  if (!skills || !fig || !Array.isArray(list) || !list.length) return out;
  const sl = (skillLevels && typeof skillLevels === 'object') ? skillLevels : null;
  const L = (id) => {
    if (sl && sl[id] != null) {
      // 兼容两种存储结构：pets.json 的 {sid, level} 对象 / 已扁平化的纯等级表
      const v = sl[id];
      return Number((v && typeof v === 'object') ? v.level : v) || 1;
    }
    if (typeof fig.skillLevel === 'function') return fig.skillLevel(id) || 1;
    return fig.level || 1;
  };
  for (const id of list) {
    const sk = skills[id] || skills[String(id)];
    if (!sk || !sk.passive || !Array.isArray(sk.passiveBuffs)) continue;
    for (const spec of sk.passiveBuffs) {
      if (spec.target && spec.target !== 'self') continue;
      if (spec.restrict) {   // 与 applyPassiveBuffs 同一限定口径
        const ok = (spec.restrict === 'life') ? ((fig.lifeMax || 0) > 0)
          : (spec.restrict === 'rage') ? ((fig.rageMax || 0) > 0) : true;
        if (!ok) continue;
      }
      if (!spec.statAddFormula) continue;
      const sa = _evalDataFormula(spec.statAddFormula, fig, L(id));
      for (const k in sa) {
        const n = _rint(Number(sa[k]));          // ★ 加成四舍五入为整数
        if (Number.isFinite(n)) out[k] = (out[k] || 0) + n;
      }
    }
  }
  return out;
}

// 被动 buff 数据负载的公式沙箱：提供 L（技能等级）/ fig（单位），返回数值字段；任何异常丢弃该字段。
function _evalDataFormula(formula, fig, L, ctx) {
  const out = {};
  for (const k in formula) {
    try { out[k] = new Function('L', 'fig', 'ctx', 'return (' + formula[k] + ');')(L, fig, ctx); }
    catch (e) { /* 表达式写错：保持 data 原值，不中断战斗 */ }
  }
  return out;
}

// 复活：把已阵亡单位恢复为存活状态（反向 _onEnemyDown/_onAllyDown 的状态变更）。
// 恢复 HP/MP → 复位 _down → 重新加入对应存活数组 → 姿态/血条/出手顺序条复位。
// 仅友方/宠物可复活；主角(pFig)阵亡走 _lose，不在技能内复活（避免战斗已结束态冲突）。返回是否成功。
function reviveFighter(scene, fig, hpPct, mpPct, opts = {}) {
  if (!fig) return false;
  if (scene && fig === scene.pFig) return false;        // 主角阵亡由 _lose 统一处理
  const maxHp = fig.maxHp || 1;
  fig.hp = Math.max(1, Math.round(maxHp * Math.max(0.01, hpPct != null ? hpPct : 0.3)));
  const maxMp = (fig.maxMp != null) ? fig.maxMp : 0;
  if (maxMp > 0) fig.mp = Math.round(maxMp * Math.max(0, mpPct != null ? mpPct : 0.3));
  fig._down = false;
  // ★ 作废仍在飞行的阵亡演出回调（Fighter.die() 的 500~900ms 定时器：闪动隐显 + 900ms 回原位）。
  //   阵亡演出全程 ~1.4s（飘字等待 500ms + 900ms 时间轴），若在窗口内被复活，残余定时器仍会
  //   把已复活的单位【藏一下】（850ms 隐）并【挪回出生点】（900ms setPos(_home)）——复活了却闪烁/瞬移。
  //   复活是"该单位已存活"的最终事实，故此处必须取消演出代际（_dieGen++ 并复位本体可见性）。
  //   与 release()/destroy()/initState() 同一处理（Fighter._cancelDeathFx）。
  if (typeof fig._cancelDeathFx === 'function') fig._cancelDeathFx();
  if (fig.buffs) fig.buffs = [];                        // 死亡时已 clearBuffs；确保干净
  if (fig._pendingTurnStartBuffs) fig._pendingTurnStartBuffs = [];
  // ★ 被动技能重挂：死亡 clearBuffs 已回退被动属性加成并复位 __passiveApplied，
  //   复活必须把被动 buff（属性加成/智慧守护减伤等）挂回，否则复活单位永久失去被动。
  if (scene) { try { applyPassiveBuffs(scene, fig); } catch (e) { /* 复活不应被被动挂载失败否决 */ } }
  if (scene) {
    if (scene.allies && fig.side !== 'enemy' && scene.allies.indexOf(fig) < 0) scene.allies.push(fig);
    if (scene.enemies && fig.side === 'enemy' && scene.enemies.indexOf(fig) < 0) {
      scene.enemies.push(fig);
      if (!scene.eFig) scene.eFig = fig;
    }
    if (scene._downedAllies) scene._downedAllies = scene._downedAllies.filter(a => a !== fig);  // 移出墓园
  }
  // 姿态/血条/图标/出手顺序条复位（方法缺失时安全跳过）
  try { if (fig.stand) fig.stand(); } catch (e) {}
  if (fig.updateBar) fig.updateBar();
  if (fig._refreshBuffIcons) fig._refreshBuffIcons();
  if (scene && typeof scene._updateOrderState === 'function') { try { scene._updateOrderState(null); } catch (e) {} }
  return true;
}

// ───────────────────────── 受击钩子（onDamaged）─────────────────────────
// 统一伤害落点：护盾吸收 → 同生共死分担 → 仙气护体受击回血 → 腐骨蚀心吸血 → 穿心蚀骨伤害池 → 扣血。
// 返回实际对 target 造成的 HP 损失（用于战斗统计）。
function onDamaged(ctx, target, dmg, o = {}) {
  const attacker = o.attacker || null;
  let remaining = dmg;
  // 详尽战斗日志（仅测试页 scene.detailedLog=true 时；主游戏 BattleScene 不开启，避免刷屏）
  const L = (msg) => { if (ctx.scene && ctx.scene.detailedLog && ctx.scene.mLog) ctx.scene.mLog(msg); };

  // 1) 昊天罡气 / 护盾吸收
  // ★ 阶段3 双轨：已配置 triggers 的护盾/昊天由 BEFORE_DAMAGE 触发器接管，此处跳过旧分支（避免双份吸收）
  for (const b of target.buffs.filter(x => (x.def.kind === 'shield' || x.def.kind === 'haotian') && !(x.def.triggers && x.def.triggers.length))) {
    if (b.data && b.data.shield > 0) {
      const absorb = Math.min(b.data.shield, remaining);
      b.data.shield -= absorb; remaining -= absorb;
      if (absorb > 0) L(target.name + ' 【' + (b.def.name || '护盾') + '】吸收 ' + Math.round(absorb) + ' 伤害');
      if (b.def.kind === 'haotian' && b.data.level >= 6 && o.viaNormalAttack && attacker) {
        const reflect = 0.05 * (b.data.level - 3 + Math.max(0, b.data.level - 9)) * b.data.maxShield;
        if (reflect > 0) { applyRaw(ctx, attacker, reflect); L('【' + (b.def.name || '昊天罡气') + '】破盾反射 ' + Math.round(reflect) + ' 伤害给 ' + attacker.name); }
      }
      if (b.data.shield <= 0) b._expire = true;
    }
  }

  // 2) 同生共死：承受者(带 link 的友方)受伤时减伤，减掉的部分由施法者(使用者)分担，施法者获 1 侠义之心
  // ★ 阶段3 双轨：已配置 triggers 的 link 由 BEFORE_DAMAGE 触发器接管，此处跳过旧分支
  const link = target.buffs.find(x => x.def.kind === 'link' && !(x.def.triggers && x.def.triggers.length));
  if (link) {
    const reducePct = link.data.reducePct;            // 22.5 + 2.5*level（真正减伤比例）
    const reduced = remaining * reducePct / 100;      // 减掉、转由使用者扛的部分
    const unreduced = remaining - reduced;            // 承受者实际承担
    const user = findFig(ctx.scene, link.data.userId);
    if (user && user.hp > 0) { applyRaw(ctx, user, reduced); ctx.addValor(user, 1); }
    remaining = unreduced;                            // 承受者只承担减伤后的部分
    L(target.name + ' 【同生共死】减伤 ' + Math.round(reduced) + '（承受者承 ' + Math.round(unreduced) + '）' + (user ? ('，' + user.name + ' 分担 ' + Math.round(reduced) + '，获 1 侠义之心') : ''));
  }

  // 2.5) 八荒六合：物理伤害削减（甚至完全抵御 100%）。仅对非魔法（物理）伤害生效。
  // ★ 阶段3 双轨：已配置 triggers 的 bahuang 由 BEFORE_DAMAGE 触发器接管（法术增幅/治疗增幅另留在 deal/heal 内，未迁移）
  const bah = target.buffs.find(x => x.def.kind === 'bahuang' && !(x.def.triggers && x.def.triggers.length));
  if (bah && bah.data && !o.isMagic) {
    const pr = Math.min(100, bah.data.physReduce || 0);
    if (pr > 0) {
      const cut = remaining * pr / 100;
      remaining -= cut;
      L(target.name + ' 【八荒六合】物理伤害削减 ' + Math.round(cut) + '（减伤 ' + pr + '%）');
    }
  }

  // 3) 仙气护体：受击时回复生命（buff 上记录的每击回血量）
  // ★ 阶段3 双轨：已配置 triggers 的 xianqi 由 TAKE_DAMAGE 触发器接管，此处跳过旧分支（避免双份回血）
  for (const b of target.buffs.filter(x => x.def.kind === 'xianqi' && !(x.def.triggers && x.def.triggers.length))) {
    if (b.data && b.data.heal > 0) {
      const amt = Math.max(1, Math.round(b.data.heal));
      ctx.heal(target, amt, { magic: true });
      L(target.name + ' 【' + (b.def.name || '仙气护体') + '】受击回复 ' + amt + ' 生命');
    }
  }

  // 4) 腐骨蚀心：己方对其造成【物理】伤害时回复（攻击者吸血）。仅物理伤害生效，法术伤害不触发。
  // ★ 阶段3 双轨：已配置 triggers 的 fugu 由 TAKE_DAMAGE 触发器接管，此处跳过旧分支
  const fugu = target.buffs.find(x => x.def.kind === 'fugu' && !(x.def.triggers && x.def.triggers.length));
  if (fugu && attacker && attacker.hp > 0 && !o.isMagic) {
    const lvl = fugu.data.level;
    const h = (0.29 + 0.01 * lvl) * dmg + 200 + 100 * lvl + (attacker.recover || 0);
    const amt = Math.max(1, Math.round(h));
    ctx.heal(attacker, amt);
    L(attacker.name + ' 【腐骨蚀心】吸血 ' + amt + ' 生命');
  }

  // 5) 穿心蚀骨：每次受击累计伤害池，达阈值附加固定伤害并扣减池
  // ★ 阶段3 双轨：已配置 triggers 的 chuanxin 由 BEFORE_DAMAGE 触发器接管
  const cx = target.buffs.find(x => x.def.kind === 'chuanxin' && !(x.def.triggers && x.def.triggers.length));
  if (cx && attacker) {
    cx.data.pool += dmg;
    if (cx.data.pool >= cx.data.threshold) {
      const burst = cx.data.extra;
      cx.data.pool -= cx.data.extra;
      applyRaw(ctx, target, burst);
      L(target.name + ' 【穿心蚀骨】触发爆发 ' + Math.round(burst) + ' 伤害');
    }
  }

  // 6) 扣血（先取整，确保任何伤害落点都是整数）
  const hpLoss = Math.round(remaining);
  applyRaw(ctx, target, hpLoss, { crit: !!o.crit });   // 唯一飘字出口；暴击时数字放大 1.3
  // 7) 受击联动（反击 / 反伤 / 阈值触发）已改为【事件总线驱动】（阶段2）：
  //    由 deal() 在伤害落地后广播 TAKE_DAMAGE，联动由 buff 配置的 triggers[] 声明，
  //    派发走下方 TCA 运行时的「入队 + 单一循环」迭代内核（调用栈恒定，可跑满 50000 硬上限）。
  //    旧版此处的 kind-switch + enqueueReactions/_collect/_flush 已彻底移除。
  return hpLoss;
}

// ───────────────────────── 联动链长控制（阶段2）─────────────────────────
// 受击联动（反击/反伤/阈值触发）已完全由下方 TCA 事件总线承载；本段只保留"链长上限"的对外 API，
// 语义 **1:1 继承旧版**：计数的不是"事件嵌套深度"，而是"已处理的 trigger 触发次数"。
//   CHAIN_DEPTH_LIMIT 正常上限（防意外卡死）；CHAIN_HARD_CAP 硬上限，∞ 模式下仍生效。
// 实际计量变量 _chainProcessed / 迭代队列 _evQueue 定义在下方 TCA 运行时（迭代派发内核）。
let CHAIN_DEPTH_LIMIT = 24;
const CHAIN_HARD_CAP = 50000;
// 设置联动深度上限（测试页"联动深度上限"输入 / "∞ 真无限"开关调用）。
// 传 Infinity 表示解除正常上限，仅受 CHAIN_HARD_CAP 保护（用于验证系统可无限联动）。
export function setChainDepthLimit(n) {
  if (n === Infinity) { CHAIN_DEPTH_LIMIT = Infinity; return; }
  if (n == null || isNaN(n)) return;
  CHAIN_DEPTH_LIMIT = Math.max(1, Math.floor(n));
}
export function getChainDepth() { return _chainProcessed; }
export function resetChainDepth() { _chainProcessed = 0; _evQueue.length = 0; }


// ═════════════════════ TCA 运行时：全局事件总线（迭代派发） + 条件/动作解释器 ═════════════════════
// 设计依据：《原子化设计文档_技能与buff_TCA增补.md》 + 《..._TCA阶段2_迁移方案.md》。三条铁律：
//   ① filter 以【监听者自己】为坐标原点：self=我自身 / ally=与我同阵营者 / enemy=我的敌对目标 / all=无条件；
//   ② ★ 派发为「入队 + 单一循环」**迭代**模型（阶段2 起彻底废除递归 emitEvent）：
//      触发器的动作若再产生伤害 → 只是把新的 TAKE_DAMAGE 任务**入队**，由同一 while 循环继续消费，
//      调用栈恒定（≈6 帧），不随链长增长；因此可安全跑满 CHAIN_HARD_CAP=50000 深链而不爆栈。
//      链长上限沿用 CHAIN_DEPTH_LIMIT / CHAIN_HARD_CAP（语义 = 已处理 trigger 触发次数，1:1 继承旧版）。
//   ③ isCounter（反击不可反击）/ isDirect（间接伤害不触发）双守卫默认拦截，可用 allowOnCounter / allowOnIndirect 显式放行。
// ★ 兼容闸（双轨）：无任何 buff 配置 triggers 时，emitEvent 在收集阶段即返回 → 对既有战斗零行为变化。
export const EVENTS = {
  ROUND_START: 'ROUND_START',       // 大回合开始
  TURN_START: 'TURN_START',         // 某单位回合开始
  TURN_END: 'TURN_END',             // 某单位回合结束（行动链路彻底执行完毕后【显式】广播）
  BEFORE_ATTACK: 'BEFORE_ATTACK',   // 攻击/施法前
  AFTER_ATTACK: 'AFTER_ATTACK',     // 攻击/施法后（追击检测点）
  BEFORE_DAMAGE: 'BEFORE_DAMAGE',   // 伤害落地前（可改值 / 挡刀）—— 同步内联派发
  TAKE_DAMAGE: 'TAKE_DAMAGE',       // 伤害落地后（反击点）—— 入队迭代派发
  HEAL: 'HEAL',                     // 治疗落地
  BEFORE_HEAL: 'BEFORE_HEAL',       // 治疗落地前（可改值：八荒法术治疗增幅）
  UNIT_DEATH: 'UNIT_DEATH',         // 任意单位阵亡
  BUFF_EXPIRE: 'BUFF_EXPIRE',       // buff 自然到期 / 被驱散（阶段3：为"穿心蚀骨到期爆发"等提供标准触发源）
  BEFORE_TARGETING: 'BEFORE_TARGETING', // 出手选目标前（可强制目标：嘲讽/混乱；同步内联，由 redirectTarget 广播）
};

const MAX_SYNC_DEPTH = 8;       // 同步内联派发（BEFORE_*：需要即时返回值）的嵌套上限
const EVENT_HARD_CAP = 200000;  // 单次顶层派发的绝对硬上限（兜底；正常由 CHAIN_HARD_CAP 生效）

let _chainProcessed = 0;        // 本次链已处理的 trigger 触发次数（≈旧版 _chainDepth）
let _evQueue = [];              // 迭代派发队列：[{ hits, ctx, event }]
let _draining = false;          // 是否已在下沉循环中（避免嵌套下沉）
let _syncDepth = 0;             // BEFORE_* 同步派发嵌套深度
let _derivedDepth = 0;          // >0 表示正处于"事件派生的二次动作"（反击/追击/邀约）中 → 产出的伤害自动标记 isCounter
let _eventLog = [];
let _eventLogOn = false;

export function setEventLogEnabled(on) { _eventLogOn = !!on; }
export function isEventLogEnabled() { return _eventLogOn; }
export function getEventLog() { return _eventLog.slice(); }
export function clearEventLog() { _eventLog = []; }
function _rec(o) { if (!_eventLogOn) return; _eventLog.push(o); if (_eventLog.length > 800) _eventLog.shift(); }

function _sameSide(a, b) { return !!a && !!b && (a.side || 'player') === (b.side || 'player'); }
// 全场单位（去重）：pFig 在多数场景下【不在】 allies 中，但测试替身/异常调用可能重复传入，
// 若不去重会导致同一 buff 的 triggers 被收集两次 → 触发器重复触发（曾致 event.value 被累计 2 倍）。
function _allFighters(scene) {
  if (!scene) return [];
  const out = [];
  const seen = new Set();
  const push = (f) => { if (f && !seen.has(f)) { seen.add(f); out.push(f); } };
  push(scene.pFig);
  for (const a of (scene.allies || [])) push(a);
  for (const e of (scene.enemies || [])) push(e);
  return out;
}
// 引用解析：配置 target 字段的显式枚举（禁止字符串路径求值，见增补文档 §8.3）
function _resolveRef(ref, ctx) {
  switch (ref) {
    case 'self': case 'listener': return ctx.listener || null;
    case 'source': case 'eventSource': return ctx.source || null;
    case 'target': case 'eventTarget': return ctx.target || null;
    case 'primaryTarget': return ctx.primaryTarget || ctx.target || null;
    case 'buffOwner': return _buffOwner(ctx);   // 本 buff 记录的关联单位（如 link 的 userId = 同生共死的承担者）
    default: return ctx.target || null;
  }
}
// 本 buff 的"关联单位"：读 buff.data.userId / ownerId / taunterId 并经 findFig 解析（供 buffOwner 目标模式/条件使用）
function _buffOwner(ctx) {
  const d = ctx.buff && ctx.buff.data;
  const id = d && (d.userId || d.ownerId || d.taunterId);
  return id ? findFig(ctx.scene, id) : null;
}
function _compare(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '=': case '==': return a === b;
    case '!=': case '<>': return a !== b;
    default: return false;
  }
}

// ── 取值器（阶段2 E1/E2/E3/D7）──────────────────────────────────────────────
// 数值字段支持三种写法：① 数字字面量；② { ref: '<白名单路径>' } 只读引用；③ 字符串数字。
// ★ 白名单路径（严禁表达式求值 / 反射，与 §8.3「禁止字符串路径求值」一致）：
//   event.value | buff.data.<key> | buffVar.<name> | self.<attr> | eventSource.<attr> | eventTarget.<attr>
function _refRaw(path, ctx) {
  const p = String(path || '').split('.');
  switch (p[0]) {
    case 'event': {
      if (p[1] === 'value') return ctx.value || 0;
      if (p[1] === 'delta') return ctx.__delta || 0;                        // 最近一次改值的净变化
      if (p[1] === 'loss') return ctx.loss != null ? ctx.loss : (ctx.value || 0);
      return 0;
    }
    case 'buff': { if (p[1] !== 'data') return undefined; return ((ctx.buff && ctx.buff.data) || {})[p[2]]; }
    case 'buffVar': return _varStore('buff', ctx)[p[1]];
    case 'self': case 'listener': return (ctx.listener || {})[p[1]];
    case 'eventSource': case 'source': return (ctx.source || {})[p[1]];
    case 'eventTarget': case 'target': return (ctx.target || {})[p[1]];
    default: return undefined;
  }
}
function _resolveRefValue(path, ctx) {
  const v = _refRaw(path, ctx);
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
// 任意类型取值（用于 buffId / skillId 等字符串型字段）
function _resolveAny(v, ctx) {
  return (v && typeof v === 'object' && v.ref) ? _refRaw(v.ref, ctx) : v;
}
// 动作数值的等级公式沙箱：{ formula: '1.0 + 0.05*L' } → new Function('L','ctx') 求值；异常返回 0（同 _evalDataFormula 策略）
//   用于宠物天赋等「每级效果加 0.05」的技能：flat/coef/plus 等数值字段都可写成等级公式。
const _formulaCache = new Map();
function _evalLevelFormula(f, ctx) {
  let fn = _formulaCache.get(f);
  if (!fn) {
    try { fn = new Function('L', 'ctx', 'return (' + String(f) + ');'); } catch (e) { return 0; }
    _formulaCache.set(f, fn);
  }
  try { return Number(fn((ctx && ctx.L) || 1, ctx)) || 0; } catch (e) { return 0; }
}

function _num(v, ctx) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if (v.formula) return _evalLevelFormula(v.formula, ctx);
    if (v.ref) return _resolveRefValue(v.ref, ctx);
  }
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
// 变量作用域：缺省(事件链 ctx.vars) / 'battle'(scene._tcaVars) / 'buff'(本 buff 实例 data.__vars) / 'buffData'(直接读写 buff.data 字段)
function _varStore(scope, ctx) {
  if (scope === 'battle') {
    return (ctx.scene && (ctx.scene._tcaVars || (ctx.scene._tcaVars = {}))) || (ctx.vars || (ctx.vars = {}));
  }
  if (scope === 'buffData') {
    // ★ 直接操作 buff.data 的字段本身（如 chuanxin 的 data.pool）——生产端/场景侧也读写同一字段，必须同源
    if (!ctx.buff) return ctx.vars || (ctx.vars = {});
    return ctx.buff.data || (ctx.buff.data = {});
  }
  if (scope === 'buff') {
    if (!ctx.buff) return ctx.vars || (ctx.vars = {});
    const d = ctx.buff.data || (ctx.buff.data = {});
    return d.__vars || (d.__vars = {});
  }
  return ctx.vars || (ctx.vars = {});
}
// 统一取值：value = flat + plus + coef × base
//   base 由 scaleFrom 决定：'eventValue'=本次事件值 / 'buffVar'=本 buff 变量 / 缺省=施动者属性(scaleAttr)
//   coef 缺省：给了 flat 或 plus 则为 0（纯固定值），否则为 1
//   plus：额外加项（可引用），用于 flat + 引用项 的组合（如"固定基数 + 攻击者恢复"）
function _valueOf(a, ctx, actor) {
  const flat = _num(a.flat, ctx) + _num(a.plus, ctx);
  const coef = (a.coef != null) ? _num(a.coef, ctx) : ((a.flat != null || a.plus != null) ? 0 : 1);
  let base;
  if (a.scaleFrom === 'eventValue') base = _num(ctx.value, ctx);
  else if (a.scaleFrom === 'buffVar') base = _num(_varStore('buff', ctx)[a.fromVar || a.varName], ctx);   // fromVar：源变量 ≠ 目标变量时的读取源
  else base = (actor && actor[a.scaleAttr || 'atk']) || 0;
  return Math.max(0, Math.round(flat + base * coef));
}
// 日志模板渲染：**固定占位符白名单**，绝不引入表达式解析器（保证复刻原文、杜绝注入）
function _renderLog(tpl, ctx) {
  return String(tpl == null ? '' : tpl).replace(/\{([A-Za-z0-9_.]+)\}/g, (m, path) => {
    switch (path) {
      case 'source': case 'eventSource': return (ctx.source && ctx.source.name) || '';
      case 'target': case 'eventTarget': return (ctx.target && ctx.target.name) || '';
      case 'victim': return (ctx.target && ctx.target.name) || (ctx.listener && ctx.listener.name) || '';
      case 'listener': case 'self': return (ctx.listener && ctx.listener.name) || '';
      case 'value': return String(Math.round(ctx.value || 0));
      case 'before': return String(Math.round(ctx.__before != null ? ctx.__before : (ctx.value || 0)));  // 最近一次改值前的值
      case 'delta': return String(Math.round(Math.abs(ctx.__delta || 0)));   // 最近一次改值原子的净变化（吸收量/削减量）
      case 'absorbed': return String(Math.round(ctx.__absorbed || 0));
      case 'buffOwner': return (_buffOwner(ctx) || {}).name || '';
      case 'buff': return (ctx.buff && ctx.buff.def && (ctx.buff.def.name || ctx.buff.def.id)) || '';
      default: {
        const p = path.split('.');
        if (p[0] === 'buff' && p[1] === 'data') return String((ctx.buff && ctx.buff.data && ctx.buff.data[p[2]]) ?? '');
        if (p[0] === 'buffVar') return String(_varStore('buff', ctx)[p[1]] ?? '');
        return '';
      }
    }
  });
}
// filter 匹配：★ 以【监听者自己】为坐标原点（队友受击我触发 = filter:'ally'）
// 参照对象由 filterOn 决定：'target'（默认，看事件承受者）/ 'source'（看事件发起者）。
//   - filterOn:'target' + ally → 队友受击我触发（受击联动）
//   - filterOn:'source' + ally → 队友出手后我触发（协战/追击）
//   - filterOn:'source' + self → 我自己出手后我触发（斩杀追加）
function _filterMatches(filter, listener, ctx, filterOn) {
  const t = (filterOn === 'source') ? ctx.source : ctx.target;
  switch (filter) {
    case 'self': return listener === t;
    case 'ally': return !!t && listener !== t && _sameSide(listener, t);
    case 'enemy': return !!t && !_sameSide(listener, t);
    case 'all': return true;
    default: return false;   // 未知 filter 一律不触发（配置容错）
  }
}
// ── D 组·原子化效果链：技能声明 actions 数组时按序执行，纯配置、无需公式模板 ──
// 每个 action 由 executeAction 执行（damage/heal/drain/rawDamage/applyBuff/dispel/resource/playAnim/castSkill…）；
// targetMode 以施法者为坐标原点：self=施法者 / primaryTarget=主目标 / target / allEnemies / allAllies / allFighters。
// 单条动作失败只告警不阻断后续动作；返回是否走了原子链（供 castSkill 决定是否回退旧模板）。
function runSkillActions(effSkill, ctx, caster, primary, targets) {
  const acts = Array.isArray(effSkill && effSkill.actions) ? effSkill.actions : null;
  if (!acts || !acts.length) return false;
  const actx = Object.assign({}, ctx, {
    primaryTarget: primary, target: primary, source: caster, listener: caster, targets,
    _hitResults: new Map(),   // ★ 目标 → 本次技能是否命中（damage/drain 记录，applyBuff 消费）
  });
  for (const a of acts) {
    if (!a || !a.type) continue;
    // ★ 动作级条件（与 _runTrigger 同语义）：不满足则跳过【该动作】，其余动作继续
    if (a.conditions && !evaluateCondition(a.conditions, actx)) continue;
    try { executeAction(a, actx); }
    catch (e) { console.warn('[skill] 动作执行失败，已跳过：' + (a && a.type), e && e.message); }   // 不阻断后续动作
  }
  return true;
}

// 收集订阅者：扫描全场单位身上 buff 的 triggers[]（返回空数组 = 无订阅者，调用方零开销返回）
// 顺序：先按 trigger.priority 升序（数值小者先触发），同优先级保持"发现顺序"（稳定排序）。
//   —— 用于复刻旧版「反伤(10) → 反击(20) → 阈值触发(30)」的固定顺序。
function _collectTriggers(scene, event, ctx) {
  const out = [];
  for (const f of _allFighters(scene)) {
    if (!f || !f.buffs || !f.buffs.length) continue;
    for (const b of f.buffs) {
      const trs = b.def && b.def.triggers;
      if (!trs || !trs.length) continue;
      for (const tr of trs) {
        if (!tr || tr.event !== event) continue;
        if (!_filterMatches(tr.filter || 'self', f, ctx, tr.filterOn)) continue;
        out.push({ listener: f, buff: b, trigger: tr });
      }
    }
  }
  out.sort((a, b) => ((a.trigger.priority || 0) - (b.trigger.priority || 0)));
  return out;
}

// ── 条件解释器：10 个原子 + all/any/not 组合；任何异常一律判 false（配置写错不得中断战斗）──
export function evaluateCondition(cond, ctx) {
  if (cond == null) return true;
  if (Array.isArray(cond)) return cond.every(c => evaluateCondition(c, ctx));
  if (cond.all) return (cond.all || []).every(c => evaluateCondition(c, ctx));
  if (cond.any) return (cond.any || []).some(c => evaluateCondition(c, ctx));
  if (cond.not) return !evaluateCondition(cond.not, ctx);
  try {
    switch (cond.type) {
      case 'hpThreshold': {
        const f = _resolveRef(cond.target, ctx);
        if (!f) return false;
        const maxHp = f.maxHp || 1;
        const tv = _num(cond.val, ctx);
        const v = (cond.val != null && tv <= 1 && cond.abs !== true) ? (f.hp / maxHp) : f.hp;
        return _compare(v, cond.op || '<', tv);
      }
      case 'chance': return Math.random() < (cond.rate || 0);
      case 'skillType': return (cond.is || []).indexOf(ctx.skillType) >= 0;
      case 'hasBuff': {
        const f = _resolveRef(cond.target, ctx);
        if (!f || !f.buffs) return false;
        const has = f.buffs.some(b => b.def && (b.def.id === cond.buffId || b.def.kind === cond.buffId));
        return cond.has === false ? !has : has;
      }
      case 'buffLayers': {
        const f = _resolveRef(cond.target, ctx);
        if (!f || !f.buffs) return false;
        const b = f.buffs.find(x => x.def && (x.def.id === cond.buffId || x.def.kind === cond.buffId));
        return _compare(b ? (b.stack || 0) : 0, cond.op || '>=', cond.val);
      }
      case 'isDirect': return !!ctx.isDirect === (cond.value !== false);
      case 'isCounter': return !!ctx.isCounter === (cond.value !== false);
      case 'isMagic': return !!ctx.isMagic === (cond.value !== false);
      case 'isNormalAttack': return !!ctx.viaNormalAttack === (cond.value !== false);
      // compareRef：与 compareVar 同类，但左侧取"引用值"（如 buff.data.shield），可读 buff 实例 data（不是 __vars）
      case 'compareRef': {
        const left = _num(cond.left, ctx);
        const isPlainStr = (typeof cond.val === 'string' && isNaN(Number(cond.val)));
        return _compare(left, cond.op || '>=', isPlainStr ? cond.val : _num(cond.val, ctx));
      }
      case 'side': {
        const f = _resolveRef(cond.target, ctx);
        if (!f) return false;
        if (cond.is === 'self') return f === ctx.listener;
        if (cond.is === 'ally') return f !== ctx.listener && _sameSide(f, ctx.listener);
        if (cond.is === 'enemy') return !_sameSide(f, ctx.listener);
        return false;
      }
      case 'isAlive': {
        const f = _resolveRef(cond.target, ctx);
        return !!f && f.hp > 0;
      }
      case 'compareVar': {
        const store = _varStore(cond.scope, ctx);            // 默认 / 'battle' / 'buff'
        const v = store[cond.varName];
        // val 兼容两类：数值 / 引用；**非数值字符串按原样比较**（如 __buffId == 'chuanxin'），否则会被强转为 0 而恒不成立
        const isPlainStr = (typeof cond.val === 'string' && isNaN(Number(cond.val)));
        const rhs = isPlainStr ? cond.val : _num(cond.val, ctx);
        return _compare(v, cond.op || '>=', rhs);
      }
      default: return false;
    }
  } catch (e) { return false; }
}

// 动作目标解析：显式枚举（禁止字符串路径求值）
function _resolveActionTargets(mode, ctx, listener) {
  const scene = ctx.scene;
  switch (mode) {
    case 'self': return [listener];
    case 'source': case 'eventSource': return ctx.source ? [ctx.source] : [];
    case 'target': case 'eventTarget': return ctx.target ? [ctx.target] : [];
    case 'primaryTarget': return [ctx.primaryTarget || ctx.target].filter(Boolean);
    case 'targets': return (ctx.targets || []).filter(f => f && f.hp > 0);
    case 'buffOwner': return [_buffOwner(ctx)].filter(Boolean);   // 本 buff 的关联单位（link 的承担者等）
    case 'allEnemies': return aliveFoesOf(scene, listener);
    case 'allAllies': return [listener].concat(aliveFriendsOf(scene, listener).filter(f => f !== listener));
    case 'allFighters': return _allFighters(scene).filter(f => f.hp > 0);
    default: return [ctx.target || listener].filter(Boolean);
  }
}

// ── 动作执行器：效果原子（damage/heal/applyBuff/drain/resource/dispel）
//                + 时序原子（grantTurn/modifyVar/castSkill/resortQueue/emit）
//                + 表现原子（playAnim / log）──
export function executeAction(a, ctx) {
  if (!a || !a.type) return;
  const scene = ctx.scene;
  const listener = ctx.listener;
  const caster = ctx.caster || listener;
  const tgts = (mode) => _resolveActionTargets(mode, ctx, listener);
  switch (a.type) {
    case 'damage': {
      const isMagic = a.dmgType === 'magic';
      const base = _valueOf(a, ctx, caster);
      for (const t of tgts(a.targetMode || 'primaryTarget')) {
        if (!t || t.hp <= 0) continue;
        _derivedDepth++;
        try {
          const c2 = makeCtx(scene, caster, (caster && caster.level) || 1, false, isMagic, null);
          // ★ 暴击加怒去重袋：整次施放共享（deal() 内据此只发一次暴击怒气，群攻不逐目标累加）
          c2.castRage = ctx.castRage || (ctx.castRage = {});
          deal(c2, t, base, {
            attacker: caster, isMagic, viaNormalAttack: !!a.viaNormalAttack,
            hitCheck: true, critCheck: !!a.critCheck, ignoreDefending: !!a.ignoreDefending,
            afterDeal: (hit) => { if (a.hitGate !== false && ctx._hitResults) ctx._hitResults.set(t, hit); },
            // 派生动作的 skillType：显式优先；否则随 viaNormalAttack → 'normal'（复刻旧版 _flush 传 viaNormalAttack:true，
            // 使"反击能被再次反击"在 allowOnCounter 放行时仍成立），否则视为 'passive'
            skillType: a.skillType || (a.viaNormalAttack ? 'normal' : 'passive')
          });
        } finally { _derivedDepth--; }
        // ★ 二级伤害（反伤/反击）致死路由：deal 不负责死亡演出、且调用方不知道本次派生伤害打死了谁，
        //   故在此统一路由 scene.onDeath（敌→_onEnemyDown 倒地+移出队列；友→_onAllyDown）。
        //   ——与 applyRaw 末尾的死亡路由一致；否则 hp=0 却 _down=false 残留队列→战斗结束判定卡死。
        //   主角(pFig)死亡由 _lose 处理，此处不路由。_down 守卫防重复播放。
        //   （rx_thorns / 火焰环绕 等"受击反伤"即用本动作：怪物普攻带反伤的玩家→本动作把伤害反弹给怪物→可能打死怪物→走此路由）
        if (t.hp <= 0 && !t._down && t !== scene.pFig && typeof scene.onDeath === 'function') scene.onDeath(t);
      }
      break;
    }
    case 'heal': {
      const isMagic = a.dmgType === 'magic';
      const amt = _valueOf(a, ctx, caster);
      for (const t of tgts(a.targetMode || 'self')) {
        if (!t || t.hp <= 0) continue;
        const c2 = makeCtx(scene, caster, (caster && caster.level) || 1, false, isMagic, null);
        c2.heal(t, amt, { magic: isMagic });
      }
      break;
    }
    case 'applyBuff': {
      // ★ 天赋扩展：chance=逐目标概率；data 内 {ref} 在此解析（如 taunterId:{ref:'self.id'}）；
      //   dataFormula/statAddFormula 以 L=技能等级、fig=承受方 求值（拷贝 def，避免共享对象被串改）。
      const base = lookupBuffDef(_resolveAny(a.buffId, ctx), a.duration);
      if (!base) break;
      for (const t of tgts(a.targetMode || 'primaryTarget')) {
        if (!t || t.hp <= 0) continue;
        // ★ 命中门控（用户裁决 2026-09-19）：本技能的伤害未命中/被闪避的目标，buff 不生效；
        //   a.hitGate=false 可在配置里显式关闭该门控（必定命中的纯增益/特殊设计）。
        //   仅当同一动作链上有 damage/drain 动作且记录了该目标的命中结果时才门控（无伤害动作的纯 buff 技能不受影响）。
        if (a.hitGate !== false && ctx._hitResults && ctx._hitResults.get(t) === false) continue;
        if (a.chance != null && Math.random() >= a.chance) continue;   // 逐目标概率（AoE 各自判定）
        let def = base;
        let data = (a.data != null) ? Object.assign({}, a.data) : null;
        // ★ data 内引用：id 类（taunterId/userId）用 _resolveAny 保留原值字符串；_resolveRefValue 会把非数字吞成 0
        if (data) for (const k in data) if (data[k] && typeof data[k] === 'object' && data[k].ref) data[k] = _resolveAny(data[k], ctx);
        if (a.dataFormula) data = Object.assign((data || {}), _evalDataFormula(a.dataFormula, t, (ctx && ctx.L) || 1, ctx));
        if (a.statAddFormula) {
          const sa = _evalDataFormula(a.statAddFormula, t, (ctx && ctx.L) || 1);
          const clean = {};
          for (const k in sa) if (Number.isFinite(Number(sa[k]))) clean[k] = Number(sa[k]);
          if (Object.keys(clean).length) def = Object.assign({}, def, { statAdd: clean });
        }
        giveBuff(t, def, { stack: a.layers || 1, data });
      }
      break;
    }
    case 'revive': {
      // ★ 复活动作（九转回魂/神圣之光 主动复活；浴火重生被动 UNIT_DEATH 复活）。
      //   allyOnly 默认 true：仅复活己方/宠物 —— 敌方复活会与 _onEnemyDown 的击杀结算/出队冲突。
      const hpPct = (a.hpPct != null) ? _num(a.hpPct, ctx) : 0.3;
      const mpPct = (a.mpPct != null) ? _num(a.mpPct, ctx) : 0.3;
      for (const t of tgts(a.targetMode || 'primaryTarget')) {
        if (!t || t.hp > 0) continue;                       // 仅处理已阵亡单位
        if (a.allyOnly !== false && t.side === 'enemy') continue;
        reviveFighter(scene, t, hpPct, mpPct);
      }
      break;
    }
    case 'drain': {
      const isMagic = a.dmgType === 'magic';
      const base = _valueOf(a, ctx, caster);
      let total = 0;
      for (const t of tgts(a.targetMode || 'primaryTarget')) {
        if (!t || t.hp <= 0) continue;
        _derivedDepth++;
        try {
          const c2 = makeCtx(scene, caster, (caster && caster.level) || 1, false, isMagic, null);
          c2.castRage = ctx.castRage || (ctx.castRage = {});   // 暴击加怒去重袋（同 damage）
          total += (deal(c2, t, base, { attacker: caster, isMagic, hitCheck: true, critCheck: !!a.critCheck,
            afterDeal: (hit) => { if (a.hitGate !== false && ctx._hitResults) ctx._hitResults.set(t, hit); } }) || 0);
        } finally { _derivedDepth--; }
      }
      const pct = (a.pct != null) ? a.pct : 0.3;
      if (total > 0 && caster && caster.hp > 0) {
        const c2 = makeCtx(scene, caster, (caster && caster.level) || 1, false, isMagic, null);
        c2.heal(caster, Math.round(total * pct), { magic: isMagic });
      }
      break;
    }
    case 'resource': {
      // ★ 数值字段一律走 _num（支持 {ref:...} 引用 buff 变量/单位字段）。
      //   mp：正数=回蓝、负数=扣蓝，钳制 [0, maxMp]（旧版负数无下界，可把蓝扣成负数）。
      //   mpCost：显式扣蓝（正数=扣除量）。
      //   lifeCost：寿命消耗（正数=扣除量）——仅宠物 lifeMax>0 生效（人物/怪物 costLife 内部已守卫）。
      for (const t of tgts(a.targetMode || 'self')) {
        if (!t) continue;
        if (a.rage) t.rage = (t.rage || 0) + _num(a.rage, ctx);
        if (a.mp) {
          const d = _num(a.mp, ctx);
          const cap = t.maxMp != null ? t.maxMp : (t.mp + d);
          t.mp = Math.max(0, Math.min(cap, t.mp + d));
        }
        if (a.mpCost) t.mp = Math.max(0, (t.mp || 0) - Math.max(0, _num(a.mpCost, ctx)));
        if (a.lifeCost) {
          const d = Math.max(0, _num(a.lifeCost, ctx));
          if (typeof t.costLife === 'function') t.costLife(d);
          else if (t.lifeMax) t.life = Math.max(0, (t.life || 0) - d);
          if (d > 0) { try { emitEvent(scene, 'LIFE_COST', { source: listener, target: t, value: d }); } catch (e) {} }
        }
        if (a.valor) t.valor = (t.valor || 0) + _num(a.valor, ctx);
        if (t.updateBar) t.updateBar();
        if (t._refreshBuffIcons) t._refreshBuffIcons();
      }
      break;
    }
    case 'dispel': {
      const ids = a.buffIds || a.kinds || [];
      if (!ids.length) break;
      for (const t of tgts(a.targetMode || 'target')) {
        if (!t || !t.buffs) continue;
        // ★ 阶段3：被驱散也派发 BUFF_EXPIRE（"到期/消失"的标准出口之一）
        const removed = t.buffs.filter(b => b.def && (ids.indexOf(b.def.id) >= 0 || ids.indexOf(b.def.kind) >= 0));
        t.buffs = t.buffs.filter(b => !(b.def && (ids.indexOf(b.def.id) >= 0 || ids.indexOf(b.def.kind) >= 0)));
        if (t._refreshBuffIcons) t._refreshBuffIcons();
        for (const b of removed) {
          emitEvent(scene, EVENTS.BUFF_EXPIRE, {
            source: t, target: t,
            value: (b.data && (b.data.pool || b.data.value)) || 0,
            vars: Object.assign({ __buffId: b.def.id, __reason: 'dispelled' }, b.data || {})
          });
        }
      }
      break;
    }
    case 'rawDamage': {
      // 二级伤害：直接 applyRaw 扣血（**不经**护盾/分担/减伤/联动钩子）——复刻旧版"破盾反射/穿心爆发"等
      const amt = _valueOf(a, ctx, caster);
      if (amt <= 0) break;
      for (const t of tgts(a.targetMode || 'eventSource')) {
        if (!t || t.hp <= 0) continue;
        const c2 = makeCtx(scene, caster, (caster && caster.level) || 1, false, a.dmgType === 'magic', null);
        applyRaw(c2, t, amt, { crit: false });
      }
      break;
    }
    case 'modifyValue': {
      // ★ 改值原子（BEFORE_DAMAGE 链式流水线专用）：**就地**改写 ctx.value。
      //   由于同一事件的所有触发器共享同一个 ctx 对象，后一个触发器读到的就是前一个改写后的值，
      //   从而形成 val0 →(护盾吸收)→ val1 →(同生减免)→ val2 →(八荒增减)→ … → finalVal 的流水线。
      const cur = Number(ctx.value) || 0;
      ctx.__before = cur;   // 记录改值前的值（供 {before} 日志占位符）
      let v = cur;
      switch (a.op) {
        case 'mul': v = cur * _num((a.coef != null ? a.coef : a.value), ctx); break;
        case 'add': v = cur + _num(a.value, ctx) + _num(a.plus, ctx); break;
        case 'sub': v = cur - (_num(a.value, ctx) + _num(a.plus, ctx)); break;
        case 'cutPct': v = cur * (1 - _num((a.pct != null ? a.pct : a.value), ctx) / 100); break;  // 按百分比减免
        case 'addPct': v = cur * (1 + _num((a.pct != null ? a.pct : a.value), ctx) / 100); break;  // 按百分比增幅（八荒法术/治疗增幅）
        case 'set': v = _valueOf(a, ctx, listener); break;
        case 'absorb': {
          // 护盾吸收：从本 buff 的 **data 字段**（默认 data.shield）按余量吸收，扣减池，耗尽时标记该 buff 到期。
          // 复刻旧 onDamaged 第1步：absorb = min(shield, remaining); shield -= absorb; remaining -= absorb; 若 <=0 → _expire。
          // ★ 注意：护盾量由施加方写入 data.shield（不是 __vars），故此处直接读写 ctx.buff.data。
          const d = (ctx.buff && ctx.buff.data) || null;
          if (!d) break;
          const key = a.varName || 'shield';
          const avail = Math.max(0, _num(d[key], ctx));
          const taken = Math.min(avail, cur);
          if (taken > 0) {
            d[key] = avail - taken;
            v = cur - taken;
            ctx.__absorbed = (ctx.__absorbed || 0) + taken;
            if (a.expireOnEmpty !== false && d[key] <= 0 && ctx.buff) ctx.buff._expire = true;
          }
          break;
        }
        default: v = cur;
      }
      if (a.min != null) v = Math.max(_num(a.min, ctx), v);
      if (a.max != null) v = Math.min(_num(a.max, ctx), v);
      // ★ 保留浮点、**不在每步取整** —— 旧版 onDamaged 全程用浮点 remaining，只在最后 hpLoss 取整；
      //   若此处每步 round，多步流水线（护盾→同生→八荒）会累积 ±1 偏差。最终由 deal 读回时统一 round。
      ctx.value = Math.max(0, v);
      ctx.__delta = cur - ctx.value;   // 本次改值的净变化（供 {delta} 日志占位符：吸收量/削减量）
      break;
    }
    case 'forceTarget': {
      // 强制出手目标（BEFORE_TARGETING 专用）：写回 ctx.vars，由 redirectTarget 读取。
      //   嘲讽：{ forceTarget, idRef:{ref:'buff.data.taunterId'} }；
      //   混乱：{ forceTarget, random:'all' }（无差别随机攻击，敌我通吃）/ 'allies'（同阵营）/ 'enemies'（敌对）
      if (!ctx.vars) ctx.vars = {};
      if (a.random) { ctx.vars.__forcedTargetRandom = String(a.random); break; }   // 'all'（无差别）/ 'allies'（同阵营）/ 'enemies'（旧语义）
      const id = _resolveAny((a.idRef != null ? a.idRef : a.targetId), ctx);
      if (id != null && id !== '') ctx.vars.__forcedTargetId = String(id);
      break;
    }
    case 'grantTurn': {   // 即时插队（疾风/邀战）：默认允许再动，oncePerRound 可显式查重
      for (const t of tgts(a.targetMode || 'primaryTarget')) {
        if (!t || t.hp <= 0 || !scene) continue;
        if (a.immediate !== false && typeof scene.insertImmediate === 'function') {
          scene.insertImmediate(t, { oncePerRound: !!a.oncePerRound });
        } else if (typeof scene.appendTurn === 'function') {
          scene.appendTurn(t);
        }
      }
      break;
    }
    case 'modifyVar': {
      // 变量作用域：缺省=本次事件链 vars / 'battle'=scene._tcaVars / 'buff'=本 buff 实例 data.__vars
      const store = _varStore(a.scope, ctx);
      const cur = store[a.varName] || 0;
      // 取值优先级：显式 from（引用路径） > 取值表达式(scaleFrom/coef/flat) > 固定 value
      let from;
      if (a.from != null) from = _num((typeof a.from === 'string') ? { ref: a.from } : a.from, ctx);
      else if (a.scaleFrom != null || a.coef != null || a.flat != null) from = _valueOf(a, ctx, ctx.listener);
      else from = _num(a.value, ctx);
      if (a.op === 'set') store[a.varName] = from;
      else if (a.op === 'sub') store[a.varName] = cur - from;
      else if (a.op === 'mul') store[a.varName] = cur * from;
      else store[a.varName] = cur + from;
      break;
    }
    case 'playAnim': {   // 表现原子：播一次动画（复刻旧版反击的"原地普攻 + 延时复位站姿"）
      const anim = a.anim || 'attack';
      for (const t of tgts(a.targetMode || 'self')) {
        if (!t) continue;
        // via:'scene' → 走场景的具名表现动画（如 'flower' 苏醒 / 'baoji' 暴击），等价旧 ctx.floatAnim
        if (a.via === 'scene') { if (scene && scene._floatAnim) scene._floatAnim(t, anim); continue; }
        if (t._down || typeof t[anim] !== 'function') continue;
        t[anim]();
        if (a.resetStand && typeof t.stand === 'function') {
          const fr = t._fanvasFrames || 12, rt = t._fanvasFrameRate || 25;
          // 主角若因本次受击阵亡，_lose 会播倒地动画，此处不再复位站立（避免覆盖倒地）
          setTimeout(() => { if (t && !t._down && (!scene || t !== scene.pFig || t.hp > 0)) t.stand(); }, (fr / rt) * 1000 + 80);
        }
      }
      break;
    }
    case 'skipTurn': {   // 状态原子：令目标本回合无法行动（由 scene._unitTurnStart → statusAtTurnStart 消费）
      const reason = (a.reason != null) ? String(_resolveAny(a.reason, ctx)) : '状态';
      for (const t of tgts(a.targetMode || 'self')) {
        if (t) t._tcaSkipTurn = reason;
      }
      break;
    }
    case 'log': {   // 表现原子：按固定占位符白名单渲染战斗日志（保证复刻原文，杜绝表达式注入）
      const txt = _renderLog(a.text, ctx);
      if (txt && scene && scene.mLog) scene.mLog(txt);
      break;
    }
    case 'floatNum': {   // 表现原子：目标头顶飘字（扣蓝/特殊提示），文本走 _renderLog 占位符白名单
      const txt = _renderLog(a.text, ctx);
      for (const t of tgts(a.targetMode || 'self')) {
        if (!t || !scene || !scene._floatNum) continue;
        scene._floatNum(t, txt == null ? '' : String(txt), a.color || '#cfe8ff');
      }
      break;
    }
    case 'castSkill': {   // 强制施放技能（反击/邀战核心）：targetOverride 为显式枚举，skillId 支持 {ref}
      const sid = _resolveAny(a.skillId, ctx);
      if (!sid) break;
      const t = tgts(a.targetOverride || 'eventSource')[0] || null;
      _derivedDepth++;
      try { castSkillSync(scene, listener, String(sid), { primaryTarget: t }); }
      finally { _derivedDepth--; }
      break;
    }
    case 'resortQueue': if (scene && typeof scene.resortQueue === 'function') scene.resortQueue(); break;
    case 'emit': emitEvent(scene, a.event, { source: listener, target: ctx.target, value: ctx.value, skillType: 'passive', vars: ctx.vars }); break;
    default: break;
  }
}

// 链长超限时的截断日志（文案与旧版一字不差，供 battle-test 演示页正则/文本匹配）
function _truncateChain(scene, reason) {
  const mLog = (m) => { if (scene && scene.mLog) scene.mLog(m); };
  if (reason === 'CHAIN_DEPTH_LIMIT') {
    mLog('系统可无限联动（已达深度上限 ' + CHAIN_DEPTH_LIMIT + '，安全截断）');
    _rec({ phase: 'truncate', reason, limit: CHAIN_DEPTH_LIMIT });
  } else {
    mLog('系统可无限联动（已达硬上限 ' + CHAIN_HARD_CAP + '，强制截断）');
    _rec({ phase: 'truncate', reason, limit: CHAIN_HARD_CAP });
  }
}

// 执行单条 trigger：条件 → 双守卫 → 链长计量 → 动作（每个动作可再带自己的 conditions）
// 返回值：false = 已触发链长截断（调用方应立即停止消费队列）；true = 正常（含"未通过条件/被守卫拦下"）
function _runTrigger(hit, ctx, countLayer = true) {
  const { listener, buff, trigger } = hit;
  const tctx = Object.assign({}, ctx, { listener, buff, self: listener, vars: ctx.vars || {} });
  if (!evaluateCondition(trigger.conditions, tctx)) return true;
  const acts = trigger.actions || [];
  const offensive = acts.some(a => a && (a.type === 'damage' || a.type === 'castSkill' || a.type === 'drain'));
  if (offensive) {   // ★ 双守卫：反击不可反击 / 间接伤害不触发（可显式放行）
    if (ctx.isCounter && !trigger.allowOnCounter) { _rec({ phase: 'block', reason: 'isCounter', listener: listener.name, buff: buff.def.id || buff.def.kind }); return true; }
    if (ctx.isDirect === false && !trigger.allowOnIndirect) { _rec({ phase: 'block', reason: 'isDirect=false', listener: listener.name, buff: buff.def.id || buff.def.kind }); return true; }
  }
  // ★ 链长计量（1:1 对齐旧版"入队才计数"）：只有【条件通过且未被守卫拦下】的触发器才计一层。
  //   纯记账型触发器（如"仅累积阈值池"）可声明 countAsLayer:false 而不占用层数。
  if (countLayer && trigger.countAsLayer !== false) {
    if (CHAIN_DEPTH_LIMIT !== Infinity && _chainProcessed >= CHAIN_DEPTH_LIMIT) { _truncateChain(ctx.scene, 'CHAIN_DEPTH_LIMIT'); return false; }
    if (_chainProcessed >= CHAIN_HARD_CAP || _chainProcessed >= EVENT_HARD_CAP) { _truncateChain(ctx.scene, 'CHAIN_HARD_CAP'); return false; }
    _chainProcessed++;
  }
  _rec({ phase: 'fire', event: ctx.event, listener: listener.name, buff: buff.def.id || buff.def.kind, depth: ctx.depth, actions: acts.map(a => a && a.type) });
  for (const a of acts) {
    if (!a) continue;
    // ★ 动作级条件（E4）：不满足则跳过【该动作】，其余动作继续
    if (a.conditions && !evaluateCondition(a.conditions, tctx)) continue;
    try { executeAction(a, tctx); }
    catch (e) { if (ctx.scene && ctx.scene.mLog) ctx.scene.mLog('[TCA] 动作异常（已跳过）：' + a.type + ' — ' + (e && e.message)); }
  }
  // ★ BEFORE_DAMAGE 流水线回写：tctx 是 ctx 的浅拷贝，modifyValue 改的是 tctx.value；
  //   此处把结果回写到共享 ctx，使**后一个触发器**（以及 deal 的读回）看到前一个改写后的值，
  //   从而形成 val0 →(护盾)→ val1 →(同生)→ val2 →(八荒)→ … → finalVal 的链式流水线。
  if (tctx.value !== ctx.value) ctx.value = tctx.value;
  return true;
}

// 构造事件上下文（isCounter 在【构造时】定型，保证入队后延迟消费仍保持原语义）
function _mkEventCtx(scene, event, o) {
  return {
    event, scene,
    source: o.source || null,
    target: o.target || null,
    targets: o.targets || (o.target ? [o.target] : []),
    primaryTarget: o.primaryTarget || null,
    skillId: o.skillId || null,
    skillType: o.skillType || null,
    value: o.value != null ? o.value : 0,
    isCrit: !!o.isCrit,
    isMagic: !!o.isMagic,          // ★ 物理/法术判定（八荒仅物理减伤、腐骨仅物理吸血等）
    viaNormalAttack: !!o.viaNormalAttack,   // ★ 是否来自"普通攻击"（昊天破盾反射仅普攻触发）
    isDirect: o.isDirect !== false,
    isCounter: (o.isCounter != null) ? !!o.isCounter : (_derivedDepth > 0),
    loss: (o.loss != null) ? o.loss : null,   // ★ 实际 HP 损失（TAKE_DAMAGE 专用；value 为名义伤害，对齐旧版 onDamaged 的 dmg）
    depth: o.depth != null ? o.depth : 0,
    origin: o.origin || event,
    vars: o.vars || {}
  };
}

// ── 迭代派发内核（E8）────────────────────────────────────────────────────────
// 入队 + 单一 while 循环消费；触发器动作产生的后续事件只是再次入队，不递归 → 调用栈恒定。
// 链长受 CHAIN_DEPTH_LIMIT（正常）/ CHAIN_HARD_CAP（硬）双重保护，语义 = 已处理 trigger 次数。
function _drain(scene) {
  if (_draining) return;              // 已在下沉中 → 由外层循环继续消费（不递归）
  _draining = true;
  try {
    // 迭代消费：链长计量与上限判定在 _runTrigger 内（"条件通过才计一层"，1:1 对齐旧版）
    outer:
    while (_evQueue.length) {
      const job = _evQueue.shift();
      for (const h of job.hits) {
        // 对齐旧版 `if (r.victim.hp > 0)`：链过程中已阵亡的单位不再产生联动
        // （UNIT_DEATH 例外：阵亡者自身的"死亡触发"仍需生效，且其 buff 尚未被 clearBuffs）
        if (job.event !== EVENTS.UNIT_DEATH && h.listener && h.listener.hp <= 0) continue;
        if (!_runTrigger(h, job.ctx)) break outer;   // 返回 false = 链长已达上限，停止消费
      }
    }
  } finally {
    _draining = false;
    _evQueue.length = 0;   // 截断残留清理（与旧版 _flush 尾部一致）
    _chainProcessed = 0;   // 一条链彻底跑完即归零，不污染下一次派发
  }
}

// 事件派发入口（迭代）：无订阅者时零开销直返（双轨兼容）
export function emitEvent(scene, event, o = {}) {
  const ctx = _mkEventCtx(scene, event, o);
  const hits = _collectTriggers(scene, event, ctx);
  if (!hits.length) return ctx;                 // ★ 双轨闸：无订阅者 → 零行为变化
  _rec({ phase: 'emit', event, source: ctx.source && ctx.source.name, target: ctx.target && ctx.target.name, value: ctx.value, depth: ctx.depth, listeners: hits.length });
  _evQueue.push({ hits, ctx, event });
  _drain(scene);
  return ctx;
}

// 同步内联派发（仅供 BEFORE_DAMAGE / BEFORE_ATTACK 这类"需要即时返回值"的事件）：
// 内联执行其触发器（深度受 MAX_SYNC_DEPTH 保护），但其产生的伤害仍走【入队】路径（不递归链）。
export function emitEventSync(scene, event, o = {}) {
  const ctx = _mkEventCtx(scene, event, o);
  const hits = _collectTriggers(scene, event, ctx);
  if (!hits.length) return ctx;
  if (_syncDepth >= MAX_SYNC_DEPTH) {
    _rec({ phase: 'truncate', reason: 'MAX_SYNC_DEPTH', event });
    return ctx;
  }
  _syncDepth++;
  try { for (const h of hits) _runTrigger(h, ctx, false); }   // 同步事件（BEFORE_*）不计入联动层数
  finally { _syncDepth--; }
  return ctx;
}

// ── 技能路径的事件广播（阶段3）────────────────────────────────────────────────
// 普攻路径早已广播；此处补齐【主动技能】的 BEFORE_ATTACK / AFTER_ATTACK，使
// "队友普攻或放技能后追击（如姑获鸟协战）"、"技能斩杀后追加 AOE（如鬼切）" 这类被动可纯配置落地。
//   BEFORE_ATTACK：走同步内联（施法前可施加自身增益，从而影响本次伤害）
//   AFTER_ATTACK ：走入队派发；event.value = 本次技能对全体目标的实际总伤害，event.target = 主目标
export function skillBeforeAttack(scene, caster, skillId, primary, targets) {
  emitEventSync(scene, EVENTS.BEFORE_ATTACK, {
    source: caster, target: primary, targets, skillId, skillType: 'active'
  });
  return (targets || []).map(t => (t ? t.hp : 0));   // 供 after 阶段计算实际伤害
}
export function skillAfterAttack(scene, caster, skillId, primary, targets, hpBefore) {
  let dealt = 0;
  const arr = targets || [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (t) dealt += Math.max(0, ((hpBefore && hpBefore[i]) || 0) - t.hp);
  }
  emitEvent(scene, EVENTS.AFTER_ATTACK, {
    source: caster, target: primary, targets: arr, skillId, skillType: 'active', value: dealt
  });
  return dealt;
}

// 直接对单位扣血/飘字（不触发护盾分流，仅用于反伤/分担/穿心爆发等"二级伤害"）
// ★这里是【所有】扣血的唯一飘字出口（普攻/技能/反伤/分担/穿心爆发都经此），
//   调用方不得再自行飘一次伤害数字，否则同一次伤害会出现两个数字（曾致"普攻出现两个伤害数字"）。
//   opts.crit：暴击时数字（图片版）整体放大 1.3（对齐 AS3 RESULT_BAOJI）。
function applyRaw(ctx, fig, amt, opts = {}) {
  amt = Math.max(0, Math.round(amt));
  if (amt <= 0) return;
  fig.hp = Math.max(0, fig.hp - amt);
  fig.updateBar();
  // ★★ 顺序铁律（2026-09-13 修「用技能打死的，飘字和倒地一起」）：必须先【飘字】、后【死亡路由】。
  //   原因：死亡演出 Fighter.die() 以"目标最近一次飘字时刻"(_lastFloatMs) 为基准，把"切倒地帧"推迟到飘字后 500ms
  //   （对齐 AS3 BattleInitializer14 的 HPMPSP 飘字在 500ms 帧才 handleResult → ANIMATE_DEAD）。
  //   若本函数先调 onDeath（→_onEnemyDown→die()），die() 读到的 _lastFloatMs 还是【上一次】伤害的旧值（首击时为 0），
  //   于是判定"本次没飘过字"→ 跳过等待 → 倒地帧与伤害数字同帧出现 ⇒ 用户看到"飘字和倒地一起来"。
  //   故飘字块必须在本函数内前置。切勿把 onDeath 挪回飘字之前。
  // ① 飘字：优先走"指定类型"的数字图片通道（可带暴击放大）；场景未提供时回退旧文本通道，避免数字静默丢失。
  //    （_floatNumber 首行即写 fig._lastFloatMs = now，即便 0 值/无 numberLayer 也照记——正是 die() 的计时基准。）
  if (ctx.scene && ctx.scene._floatNumber) ctx.scene._floatNumber(fig, 'hp', -amt, { crit: !!opts.crit });
  else ctx.float(fig, '-' + amt, '#ff6b6b');
  // ② 二级伤害致死路由（反射/穿心爆发/同生共死分担/drain 等经本函数的路径）：
  //   扣血后若目标 hp<=0 且未倒下，路由 scene.onDeath（敌→_onEnemyDown 移出战斗队列、友→_onAllyDown），
  //   否则目标会停在 hp=0 且 _down=false（典型：昊天罡气破盾反射打死怪物），导致战斗结束判定卡死。
  //   —— 对齐 castSkill 末尾对 targets 的死亡路由，统一收敛到 onDeath 这一出口（_down 守卫防重复播放）。
  //   主角(pFig)死亡由 _lose 统一处理，此处不路由（避免提前 clearBuffs 干扰战斗结算）。
  if (fig.hp <= 0 && !fig._down && ctx.scene && fig !== ctx.scene.pFig && typeof ctx.scene.onDeath === 'function') {
    ctx.scene.onDeath(fig);
  }
  // 受击表现：命中特效 + 轻位移/半透明（防御态另加 defend_lr/defend_rl），对齐 AS3 BattleInitializer15
  // ★ 反伤/反击等【二级派生伤害】(isCounter / _derivedDepth>0)：本次伤害打在「正处自己行动回合」的攻击者身上，
  //   其位移由 _approach/_retreat 脚本接管；若再触发 _underfire→_knock 的「击退+500ms 拉回」，会把攻击者
  //   在【被反伤瞬间(已逼近玩家身边)】的位置当成 home 拉回 → 与 _retreat 回出生点抢位移 → 怪物卡在玩家身边。
  //   故派生伤害【不】触发受击表现（命中特效/击退/半透明），仅保留飘字与死亡路由；主伤害(isCounter=false)照常。
  if (ctx.underfire && !ctx.isCounter && _derivedDepth === 0) ctx.underfire(fig);
  const sl = fig.buffs.find(b => b.def.kind === 'sleep');
  // 苏醒：改走动画通道（resource/battle/flower），替代文字提示
  // ★ 阶段3 双轨：若该 sleep buff 已配置 triggers（受击苏醒改由 TAKE_DAMAGE 触发器驱动），此处跳过旧逻辑，避免重复播/重复清
  const slMigrated = !!(sl && sl.def.triggers && sl.def.triggers.length);
  if (sl && !slMigrated) {
    sl._expire = true;
    if (ctx.floatAnim) ctx.floatAnim(fig, 'flower'); else ctx.float(fig, '苏醒', '#fff');
    if (ctx.scene && ctx.scene.detailedLog && ctx.scene.mLog) ctx.scene.mLog(fig.name + ' 因受击提前苏醒（昏睡解除）');
  }
}

// 伤害施加入口（技能/普攻共用）：防御态减半；物理按 def、法术按 magDef 减免；命中/闪避；暴击（受韧性减免）。
// hitCheck/critCheck/isMagic 为 opt-in：主游戏普攻路径(applyIncoming 不传这些 flag)保持原行为；技能经 ctx.deal 默认开启。
function deal(ctx, target, amount, opts = {}) {
  let dmg = amount;
  if (!opts.ignoreDefending && target.defending) dmg *= 0.5;                 // 防御态减半（龙破斩无视）
  const isMagic = !!opts.isMagic;
  if (isMagic) {
    // 法术伤害受【法术防御】减免（缺省回退 def，向后兼容无 magDef 的单位）
    dmg = Math.max(1, Math.round(dmg - (target.magDef != null ? target.magDef : (target.def || 0)) * 0.25));
    // 八荒六合：法术攻击增幅作用于【承受方（被攻击目标）】——携带 bahuang 的目标，其承受的法术伤害按 magAtkInc 放大
    // ★ 阶段3 双轨：该 bahuang 已配 triggers 时跳过（由 BEFORE_DAMAGE 触发器的 addPct 接管）
    if (target && target.buffs) {
      const bah = target.buffs.find(x => x.def && x.def.kind === 'bahuang' && !(x.def.triggers && x.def.triggers.length));
      if (bah && bah.data && bah.data.magAtkInc) {
        const before = dmg;
        dmg = Math.max(1, Math.round(dmg * (1 + bah.data.magAtkInc / 100)));
        if (ctx.scene && ctx.scene.detailedLog && ctx.scene.mLog) {
          ctx.scene.mLog((target.name || '目标') + ' 【八荒六合】承受法术攻击增幅 +' + bah.data.magAtkInc + '%（' + before + ' → ' + dmg + '）');
        }
      }
    }
  } else if (opts.viaNormalAttack) {
    dmg = Math.max(1, Math.round(dmg - (target.def || 0) * 0.25));          // 普攻原有的界防减免（技能公式已显式，不叠加）
  }
  dmg = Math.max(1, Math.round(dmg));
  // 命中 / 闪避：物理用 phyHit/phyDodge，法术用 magHit/magDodge（缺省回退 crit）。
  // 命中率基础值由技能基础命中率（opts.baseHit，缺省 90）决定；alwaysHit（必定命中）直接跳过闪避判定。
  if (opts.hitCheck) {
    if (opts.alwaysHit) {
      // 必定命中：跳过闪避判定（技能 alwaysHit / 必中开关）
    } else {
      const atkHit = isMagic ? (ctx.caster.magHit || 0) : (ctx.caster.phyHit || 0);
      const tgtDodge = isMagic ? (target.magDodge || 0) : (target.phyDodge || 0);
      const base = (opts.baseHit != null) ? opts.baseHit : 90;
      const cn = (ctx.caster && ctx.caster.name) || '攻击者';
      const tn = (target.name || '目标');
      // 1) 闪避判定（目标闪避属性）：走闪避通道（jook_phy / jook_mag 特效）+ 模型后退（对齐 AS3 JOOK 分派）
      const dodgeChance = Math.max(0, Math.min(95, tgtDodge));
      if (Math.random() * 100 < dodgeChance) {
        if (ctx.miss) ctx.miss(target, isMagic); else ctx.float && ctx.float(target, '闪避', '#cfcfcf');
        if (ctx.scene && ctx.scene.detailedLog) ctx.scene.mLog && ctx.scene.mLog(cn + ' → ' + tn + ' 未命中（被闪避）');
        // 怒气：③ 对方闪避→出手方(攻击者)+30；⑥ 闪避→受击方(防御者)+20
        if (ctx.caster) ctx.addRage(ctx.caster, 30);
        ctx.addRage(target, 20);
        ctx.lastDealHit = false;   // ★ 被闪避
        if (opts.afterDeal) opts.afterDeal(false);
        return 0;
      }
      // 2) 命中率判定（攻击者命中不足）：播放 miss_phy / miss_mag 特效（红/青 MISS 字），不触发模型后退
      //    ——对齐 AS3 MISS 分派：未命中=原地 miss 特效，闪避=jook 特效+后退，两者表现完全区分开。
      const hitChance = Math.max(5, Math.min(100, base + atkHit));
      if (Math.random() * 100 > hitChance) {
        if (ctx.miss) ctx.miss(target, isMagic, { retreat: false }); else ctx.float && ctx.float(target, '未命中', '#cfcfcf');
        if (ctx.scene && ctx.scene.detailedLog) ctx.scene.mLog && ctx.scene.mLog(cn + ' → ' + tn + ' 未命中（命中不足）');
        ctx.lastDealHit = false;   // ★ 命中不足
        if (opts.afterDeal) opts.afterDeal(false);
        return 0;
      }
    }
  }
  // 暴击：物理用 phyCrit，法术用 magCrit；受 target.toughness 降低几率与伤害
  // opts.crit 为调用方【已预先判定】的暴击（普攻走 _calcDamage 先算出 cres.crit，不再重复掷骰），
  // 仅用于让伤害数字按 AS3 RESULT_BAOJI 放大 1.3，不参与伤害倍率（倍率已含在传入的 dmg 里）。
  let crit = !!opts.crit;
  if (opts.critCheck) {
    const baseCrit = isMagic
      ? (ctx.caster.magCrit || ctx.caster.crit || 0)
      : (ctx.caster.phyCrit || ctx.caster.crit || 0);
    const cr = Math.max(0, baseCrit - (target.toughness || 0));
    if (Math.random() * 100 < cr) {
      crit = true;
      const mult = (ctx.scene ? getCombat('critMult', 1.5) : 1.5);
      dmg = Math.max(1, Math.round(dmg * mult));
      if (target.toughness) dmg = Math.max(1, Math.round(dmg * (1 - Math.min(0.5, target.toughness / 200))));
    }
  }
  // ── 事件总线：伤害落地前（可改值 / 挡刀）；★ 派生伤害（_derivedDepth>0，即反击/追击产出）自动标记 isCounter ──
  const _isCounter = (opts.isCounter != null) ? !!opts.isCounter : (_derivedDepth > 0);
  const _isDirect = opts.isDirect !== false;
  // skillType 三级回落（E7）：显式 opts > 施法上下文 > 由 viaNormalAttack 判定
  const _skillType = opts.skillType || (ctx && ctx.skillType) || (opts.viaNormalAttack ? 'normal' : 'active');
  // BEFORE_DAMAGE 需要【即时返回值】来改写伤害 → 走同步内联派发（不入队）
  // ★ 链式流水线：ctx.value 在同一 ctx 上被各触发器**依次改写**（护盾吸收→同生减免→八荒增减→…），
  //   后一个触发器的输入即前一个的输出；全部执行完后由本函数读回最终值。
  const _preEv = emitEventSync(ctx.scene, EVENTS.BEFORE_DAMAGE, {
    source: opts.attacker, target, value: dmg, skillId: opts.skillId, skillType: _skillType,
    isDirect: _isDirect, isCounter: _isCounter, isMagic, viaNormalAttack: !!opts.viaNormalAttack, crit
  });
  if (_preEv && _preEv.value != null && _preEv.value !== dmg) dmg = Math.max(0, Math.round(_preEv.value));
  ctx.lastDealHit = true;                                   // ★ 已通过命中/闪避判定
  if (opts.afterDeal) opts.afterDeal(true);
  if (dmg <= 0) return 0;                                   // 被"挡刀/完全减免"拦截
  // ── 怒气(rage)获取：按用户规则(2026-09-15) ──
  //   出手方(attacker = ctx.caster) 获取：①暴击+10 ②对方防御+15 ④普通攻击+5 ⑦反击+10
  //   受击方(target) 获取：⑤防御但受击+15（⑥闪避+20 见上方闪避分支）
  const _atkR = ctx.caster;
  // ★ 统一结算（2026-09-15）：一次攻击事件内，同一单位的多项加怒规则（暴击/对方防御/普通/反击）
  //   先累加，最后每个单位只调一次 addRage → 只飘【一个数字】。否则暴击+防御+普攻会各自跳出数字（用户报"跳两个数字"）。
  let _atkRage = 0, _tgtRage = 0;
  if (crit) {
    // ① 暴击+10 —— ★ 群攻去重（用户 2026-09-20）：群攻对每个目标各调一次 deal()，
    //   若逐目标累加，暴击 3 个目标就 +30。规则应为「任一目标被暴击即 +10」：
    //   同一次技能施放共享一个加怒袋子（ctx.castRage，由 damage/drain 动作循环注入），
    //   首个暴击目标发放一次，后续目标的暴击不再重复加怒。
    //   普攻/applyIncoming 路径无共享袋（每次调用独立一个本地袋）→ 行为不变，仍是每次暴击 +10。
    const _rageBag = ctx.castRage || (ctx.castRage = {});
    if (!_rageBag.crit) { _rageBag.crit = true; _atkRage += 10; }
  }
  if (target.defending && !opts.ignoreDefending) {         // ② 对方防御(出手方) / ⑤ 防御但受击(受击方)
    _atkRage += 15;
    _tgtRage += 15;
  }
  if (opts.viaNormalAttack) {                              // ④ 普通攻击(+5) / ⑦ 反击(+10，_isCounter 由二级派生_depth>0 标记)
    _atkRage += _isCounter ? 10 : 5;
  }
  if (_atkRage) ctx.addRage(_atkR, _atkRage);
  if (_tgtRage) ctx.addRage(target, _tgtRage);
  const got = onDamaged(ctx, target, dmg, { attacker: opts.attacker, viaNormalAttack: !!opts.viaNormalAttack, isMagic: !!isMagic, crit });
  if (crit) {
    // 暴击：改走动画通道（resource/battle/baoji），替代文字提示（对齐 AS3 getCharacter("baoji")）
    if (ctx.floatAnim) ctx.floatAnim(target, 'baoji'); else ctx.float && ctx.float(target, '暴击!', '#ffd54f');
    if (ctx.scene && ctx.scene.detailedLog) {
      const cn = (ctx.caster && ctx.caster.name) || '攻击者';
      ctx.scene.mLog && ctx.scene.mLog(cn + ' → ' + (target.name || '目标') + ' 暴击！造成 ' + dmg + ' 伤害');
    }
  }
  // ── 事件总线：伤害落地后（反击点）—— 走【入队迭代派发】，其触发的反击伤害不会递归爆栈 ──
  // ★ value = 名义伤害（= 传入 onDamaged 的 dmg，对齐旧版 _collect/腐骨吸血所用的 dmg）
  //   loss  = 实际 HP 损失（经护盾/分担/减伤折算后的净扣血）
  emitEvent(ctx.scene, EVENTS.TAKE_DAMAGE, {
    source: opts.attacker, target, value: dmg, loss: got, skillId: opts.skillId, skillType: _skillType,
    isDirect: _isDirect, isCounter: _isCounter, isMagic, viaNormalAttack: !!opts.viaNormalAttack, crit
  });
  return got;
}

// ───────────────────────── 技能范围判定 ─────────────────────────
export function resolveTargets(scene, skill, L, sansheng, caster, primary) {
  const id = String(skill.id);
  const foes = aliveFoesOf(scene, caster);
  const friends = aliveFriendsOf(scene, caster);
  const pick = (arr, n) => {
    const out = [];
    if (primary && arr.indexOf(primary) >= 0 && primary.hp > 0) out.push(primary);
    for (const f of arr) { if (out.length < n && f !== primary && f.hp > 0) out.push(f); }
    return out;
  };
  const only = () => [primary].filter(f => f && f.hp > 0);
  const sideArr = (primary && primary.side === caster.side) ? friends : foes;

  // ── 可调参数 params.scope 优先（测试页"释放目标/范围"配置）──
  // 仅当显式 enabled 时覆盖，否则完全走下方原 switch（主游戏零回归）。
  const scope = skillScope(skill);
  if (scope) {
    let pool;
    if (scope.side === 'ally') pool = friends;
    else if (scope.side === 'self') pool = [caster];
    else pool = foes;                       // 默认 enemy
    const n = Math.max(1, parseInt(scope.count, 10) || 1);
    if (scope.shape === 'cross') return crossTargets(foes, friends, primary);   // 十字几何选点
    const out = [];
    // 优先包含原 primary（若是同侧/选中目标），保持原行为直觉
    if (primary && pool.indexOf(primary) >= 0 && primary.hp > 0) out.push(primary);
    for (const f of pool) { if (out.length < n && f !== primary && f.hp > 0) out.push(f); }
    return out;
  }

  switch (id) {
    case '50020000': return pick(foes, 6);                       // 六脉神剑：1~6（10级矩形6，仍取6）
    case '50050000': return L >= 11 ? pick(foes, 2) : only();    // 龙破斩 11级竖排2
    case '60010000': return L >= 11 ? pick(foes, 4) : only();    // 冷嘲热讽 11级十字4
    case '60040000': return L >= 11 ? pick(friends, 5) : only(); // 同生共死 11级横排5
    case '160040000': return L >= 11 ? pick(friends, 5) : only(); // 【同生共死】进阶版（同 60040000）
    case '70020000': return L >= 11 ? pick(foes, 2) : only();    // 暗影迷踪拳 11级竖排2
    case '70040000': return L >= 11 ? pick(foes, 2) : only();    // 腐骨蚀心 11级竖排2
    case '80020000': return L >= 11 ? pick(sideArr, 2) : only(); // 八荒六合 11级竖排2（友/敌皆可）
    case '80030000': return L >= 11 ? pick(foes, 2) : only();    // 飞花溅玉 11级竖排2
    case '80040000': return L >= 11 ? pick(foes, 2) : only();    // 穿心蚀骨 11级竖排2
    case '10030017': return (L >= 11 && sansheng) ? pick(foes, 2) : only(); // 四相诀 三圣+11级竖排2
    case '10020000': return (L >= 11 && sansheng) ? pick(foes, 2) : only(); // 唤灭破 三圣+11级竖排2
    case '10030000': return (L >= 11 && sansheng) ? pick(foes, 6) : crossTargets(foes, friends, primary); // 恸地神咒 十字4(几何) / 三圣+11级矩形6
    case '10040000': return (L >= 11 && sansheng) ? pick(foes, 6) : crossTargets(foes, friends, primary); // 烈焰风暴 十字4(几何) / 三圣+11级矩形6
    case '110040000': return (L >= 11 && sansheng) ? pick(foes, 6) : crossTargets(foes, friends, primary); // 【烈焰风暴】玩家进阶版：同十字4(几何) / 三圣+11级矩形6
    case '30040000': return [primary].filter(Boolean);     // 妙法莲华：单体复活（含已阵亡友方）
    case '20010000': return (L >= 11 && sansheng) ? pick(foes, 2) : only(); // 摄魂咒 三圣+11级竖排2
    case '20020000': return (L >= 11 && sansheng) ? pick(foes, 2) : only(); // 魅惑术 三圣+11级竖排2
    case '20030000': return petRowTargets(friends, caster, primary); // 暗影魔咒：己方宠物（排除主角那一排）
    case '20040000': return pick(foes, 5);                       // 梦魔咒 横排5
    case '120040000': return pick(foes, 5);                       // 【梦魔咒】进阶版（同 20040000）
    case '30020000': return L >= 11 ? pick(friends, 6) : (L >= 10 ? crossTargets(foes, friends, primary) : pick(friends, 3)); // 沉水润心 3 / 10级十字4(几何) / 11级矩形6
    case '30030000': return L >= 11 ? pick(sideArr, 2) : only(); // 仙音化雨 11级竖排2
    case '30060000': return L >= 11 ? pick(friends, 5) : only(); // 仙气护体 11级横排5
    case '130060000': return L >= 11 ? pick(friends, 5) : only(); // 【仙气护体】进阶版（同 30060000）
    case '40020000': return L >= 11 ? pick(friends, 5) : only(); // 圣灵附体 11级横排5
    case '40030000': return L >= 11 ? pick(friends, 5) : only(); // 昊天罡气 11级横排5
    case '40050000': return [primary];                          // 火焰环绕：反伤 buff 施于【选中友方】(点选友方)；castSkill 在 target:'ally' 下未点选友方时回退施法者自身
    case '40040000': return L >= 11 ? pick(friends, 5) : only(); // 凝神聚气 11级横排5
    case '140040000': return L >= 11 ? pick(friends, 5) : only(); // 【凝神聚气】进阶版（同 40040000）
    default: return only();
  }
}

// 十字范围：选中个体的"那排 3 个"（同排 ±1）+ 相邻排的"相邻个体"（±5），共 4 个（端点会少）。
// 友方 0-9（前排0-4/后排5-9），敌方 10-19（前排10-14/后排15-19）；依赖 Fighter._band（进场/生成均已记录）。
// 选中的那排取同排相邻 3 个（含选中个体），再加正前/正后方 1 个，构成十字（plus）形状。
function crossTargets(foes, friends, primary) {
  const p = primary && primary._band;
  const pool = (primary && foes.indexOf(primary) >= 0) ? foes : friends;   // 十字作用于与选中个体同侧的单位
  if (p == null) {                 // 无战斗点信息兜底：选中 + 同侧随机补齐到 4
    const out = [];
    if (primary && primary.hp > 0) out.push(primary);
    for (const f of pool) { if (out.length < 4 && f !== primary && f.hp > 0) out.push(f); }
    return out;
  }
  const bySlot = new Map();
  for (const f of pool) { if (f && f._band != null && f.hp > 0) bySlot.set(f._band, f); }
  const inFront = (p % 10) <= 4;                                  // 0-4 / 10-14 → 前排
  const rowBase = inFront ? (p - (p % 10)) : (p - (p % 10) + 5);  // 该行起始战斗点
  const sameRow = [p - 1, p, p + 1].filter(s => s >= rowBase && s <= rowBase + 4);  // 同排相邻 3 个
  const perp = inFront ? p + 5 : p - 5;                           // 相邻排正前/正后方 1 个
  const out = [];
  for (const s of sameRow.concat([perp])) { const f = bySlot.get(s); if (f) out.push(f); }
  if (primary && primary.hp > 0 && out.indexOf(primary) < 0) out.push(primary);   // 保底含选中个体
  return out;
}

// 己方宠物目标：排除施法者（主角）所在的那一排，取另一排全部存活己方单位。
// 友方 0-9（前排0-4/后排5-9）；施法者 _band 判定其所在排，另一排即"宠物排"。
// 若 _band 缺失，回退为全部存活己方单位（排除施法者自身）。
function petRowTargets(friends, caster, primary) {
  const cb = caster && caster._band;
  if (cb == null) {
    // 兜底：全部存活己方（排除施法者自身），优先含 primary
    const out = [];
    if (primary && primary.hp > 0 && primary !== caster) out.push(primary);
    for (const f of friends) { if (out.length < 5 && f !== caster && f !== primary && f.hp > 0) out.push(f); }
    return out;
  }
  const casterInFront = (cb % 10) <= 4;        // 施法者在前排(0-4) → 宠物排在后排(5-9)，反之亦然
  const petRowStart = casterInFront ? (cb - (cb % 10) + 5) : (cb - (cb % 10));  // 宠物排起始 band
  const out = [];
  // 优先包含 primary（若 primary 在宠物排）
  if (primary && primary.hp > 0 && primary._band != null) {
    const pb = primary._band % 10;
    if ((pb <= 4) !== casterInFront) out.push(primary);   // primary 在宠物排
  }
  for (const f of friends) {
    if (f === caster || f.hp <= 0) continue;
    const fb = f._band != null ? (f._band % 10) : null;
    if (fb == null) continue;
    if ((fb <= 4) !== casterInFront && out.indexOf(f) < 0) out.push(f);
  }
  return out;
}
// 出手前：嘲讽强制目标为嘲讽者（且此类攻击不可被闪避）；混乱随机选敌。
export function redirectTarget(scene, attacker, intended) {
  // 详尽战斗日志（仅测试页 scene.detailedLog=true 时；主游戏 BattleScene 不开启，避免刷屏）
  const L = (msg) => { if (scene && scene.detailedLog && scene.mLog) scene.mLog(msg); };
  // ★ 阶段3 配置驱动：同步广播 BEFORE_TARGETING，触发器可用 forceTarget 原子写回强制目标
  const ev = emitEventSync(scene, EVENTS.BEFORE_TARGETING, { source: attacker, target: intended, vars: {} });
  const fv = (ev && ev.vars) || {};
  if (fv.__forcedTargetId) {   // 嘲讽（优先于混乱，与旧版同序）
    const t = findFig(scene, fv.__forcedTargetId);
    if (t && t.hp > 0) { attacker._tauntLock = true; L(attacker.name + ' 【嘲讽】强制攻击 ' + t.name); return t; }
  }
  if (fv.__forcedTargetRandom === 'allies') {   // ★ 混乱（经典语义）：改为攻击**同阵营**单位 → 敌方被混乱会自相残杀
    const mates = aliveFriendsOf(scene, attacker).filter(f => f !== attacker);
    if (mates.length) {
      const r = mates[Math.floor(Math.random() * mates.length)];
      L(attacker.name + ' 【混乱】攻击目标偏移为 ' + r.name);
      return r;
    }
  }
  if (fv.__forcedTargetRandom === 'enemies') {   // 旧语义（随机换一个敌对目标）：保留以兼容
    const foes = aliveFoesOf(scene, attacker);
    if (foes.length) {
      const r = foes[Math.floor(Math.random() * foes.length)];
      L(attacker.name + ' 【混乱】攻击目标偏移为 ' + r.name);
      return r;
    }
  }
  if (fv.__forcedTargetRandom === 'all') {   // ★ 无差别随机攻击：从全场存活单位（敌我通吃、排除自身）中随机取一个
    const pool = [scene.pFig, ...(scene.allies || []), ...(scene.enemies || [])].filter(f => f && f.hp > 0 && f !== attacker);
    if (pool.length) {
      const r = pool[Math.floor(Math.random() * pool.length)];
      L(attacker.name + ' 【混乱】无差别攻击 ' + r.name);
      return r;
    }
  }
  // ② 旧 kind 回退（未迁移的 buff 仍生效，双轨零回归）
  const taunt = attacker.buffs.find(b => b.def.kind === 'taunt' && !(b.def.triggers && b.def.triggers.length));
  if (taunt && taunt.data && taunt.data.taunterId) {
    const t = findFig(scene, taunt.data.taunterId);
    if (t && t.hp > 0) { attacker._tauntLock = true; L(attacker.name + ' 【嘲讽】强制攻击 ' + t.name); return t; }
  }
  const conf = attacker.buffs.find(b => b.def.kind === 'confusion' && !(b.def.triggers && b.def.triggers.length));
  if (conf) {
    const foes = aliveFoesOf(scene, attacker);
    if (foes.length) {
      const r = foes[Math.floor(Math.random() * foes.length)];
      L(attacker.name + ' 【混乱】攻击目标偏移为 ' + r.name);
      return r;
    }
  }
  return intended;
}
export function hasTaunt(attacker) { return attacker.buffs.some(b => b.def.kind === 'taunt'); }

// 回合开始：眩晕/昏睡跳过行动。
// ★ 阶段3 双轨：优先取「配置驱动」结果（buff 的 TURN_START 触发器执行 skipTurn 原子时置位 fig._tcaSkipTurn），
//   未迁移的 buff 再走下方 kind 回退 —— 保证已迁移/未迁移配置都正确、且零行为变化。
export function statusAtTurnStart(scene, fig) {
  if (fig._tcaSkipTurn) {
    const r = fig._tcaSkipTurn;
    fig._tcaSkipTurn = null;      // 消费一次
    return { skip: true, reason: r };
  }
  if (fig.buffs.some(b => b.def.kind === 'stun')) return { skip: true, reason: '眩晕' };
  if (fig.buffs.some(b => b.def.kind === 'sleep')) return { skip: true, reason: '昏睡' };
  return { skip: false };
}

// 普攻/技能的统一伤害落点（供 scene 调用，attacker 可空）
export function applyIncoming(scene, target, dmg, opts = {}) {
  const ctx = makeCtx(scene, opts.attacker || null, opts.attacker ? (opts.attacker.level || 1) : 1, false, opts.isMagic);
  return deal(ctx, target, dmg, {
    ignoreDefending: opts.ignoreDefending, canDodge: opts.canDodge,
    viaNormalAttack: opts.viaNormalAttack, attacker: opts.attacker,
    hitCheck: opts.hitCheck, critCheck: opts.critCheck, isMagic: opts.isMagic,
    crit: opts.crit,   // 调用方预判的暴击（普攻 cres.crit），仅用于数字放大，不影响倍率
    isDirect: opts.isDirect, isCounter: opts.isCounter,   // ★ 双守卫透传（间接伤害/反击链防护）
    skillType: opts.skillType                            // ★ 事件上下文用（普攻 'normal' / 技能 'active' / 派生 'passive'）
  });
}

// ───────────────────────── 上下文工厂 ─────────────────────────
function makeCtx(scene, caster, L, sansheng, isMagic, skill) {
  const ctx = {
    scene, caster, L, sansheng, isMagic: !!isMagic,
    // 事件上下文 skillType（E7）：带 skill 对象=主动技能 'active'；否则由调用方/普攻路径决定（默认 'normal'）
    skillType: skill ? 'active' : 'normal',
    // 技能基础命中率 / 必定命中（由 skills.json 配置，注入到每次 deal 的命中判定）
    baseHit: (skill && skill.baseHitRate != null) ? skill.baseHitRate : undefined,
    alwaysHit: !!(skill && skill.alwaysHit),
    roll: () => rollFloat(),
    float: (fig, text, color) => scene._floatNum && scene._floatNum(fig, text, color),
    // 数值飘字（指定类型 hp/mp/sp）：走数字图片通道，0 值不显示
    floatNum: (fig, type, value, opts) => scene._floatNumber && scene._floatNumber(fig, type, value, opts),
    // 战斗表现动画（resource/battle/{name}）：暴击/苏醒/防御等 —— 替代文字提示（对齐 AS3 getCharacter）
    floatAnim: (fig, name, opts) => scene._floatAnim && scene._floatAnim(fig, name, opts),
    // 闪避/未命中：闪避播 jook_phy/jook_mag + 模型后退（AS3 BattleInitializer03 / BattleBuilder JOOK 分派）；
    // opts.retreat===false 时只播 miss_phy/miss_mag 不后退（未命中，AS3 MISS 分派）
    miss: (fig, isMagic, opts) => scene._showMiss && scene._showMiss(fig, isMagic, opts),
    // 受击：命中特效 + 轻位移/半透明 + 防御态动画（AS3 BattleInitializer15）
    underfire: (fig) => scene._underfire && scene._underfire(fig),
    log: (m) => scene.mLog && scene.mLog(m),
    // 技能伤害默认开启 法术判定 / 命中 / 暴击（普通攻击走 applyIncoming，由调用方显式控制，互不干扰）
    deal(target, amount, opts) {
      return deal(ctx, target, amount, Object.assign(
        { attacker: caster, isMagic: ctx.isMagic, hitCheck: true, critCheck: true,
          baseHit: ctx.baseHit, alwaysHit: ctx.alwaysHit, skillType: ctx.skillType }, opts));
    },
    // 法术治疗增幅：heal 判定为"法术"时（opts.magic 显式标记，或本次施法技能 dtype==='magic' 即 ctx.isMagic），
    // 八荒六合·法术治疗增幅：作用于【承受方（被治疗者）】——携带 bahuang 的被治疗者，其承受的法术治疗
    // （含沉水润心/仙音化雨等 dtype=magic 治疗、以及仙气护体受击回血 magic:true）按 magHealInc 放大。
    // 与"物理减伤"同理，法术增幅也以"承受方(携带 buff 的单位)"为判定对象（与用户确认的设计一致）。
    heal(fig, amt, opts) {
      let a = Math.max(1, Math.round(amt));
      const isMagHeal = !!((opts && opts.magic) || ctx.isMagic);
      // ★ 阶段3：治疗前同步广播（before-heal 可改值）——八荒"承受法术治疗增幅"可由触发器接管
      const _preH = emitEventSync(scene, EVENTS.BEFORE_HEAL, { source: caster, target: fig, value: a, isMagic: isMagHeal });
      if (_preH && _preH.value != null && _preH.value !== a) a = Math.max(0, Math.round(_preH.value));
      if (a <= 0) return;
      // 旧版法术治疗增幅（八荒：作用于被治疗者）；★ 双轨：该 bahuang 已配 triggers 时跳过（由 BEFORE_HEAL 触发器接管）
      if (isMagHeal) {
        const figBah = (fig && fig.buffs) ? fig.buffs.find(x => x.def && x.def.kind === 'bahuang' && !(x.def.triggers && x.def.triggers.length)) : null;
        const inc = (figBah && figBah.data && figBah.data.magHealInc) || 0;
        if (inc) a = Math.max(1, Math.round(a * (1 + inc / 100)));
      }
      fig.heal(a); scene._floatNum && scene._floatNum(fig, '+' + a, '#7CFC9B');
      // 事件总线：治疗落地（被动"被治疗时"联动）
      emitEvent(scene, EVENTS.HEAL, { source: caster, target: fig, value: a });
    },
    // ★ 体力流失（自伤/反噬/环境扣血）：**只扣 HP**，不经 deal/onDamaged → 不触发任何受击钩子
    //   （不触发仙气护体回血、不被昊天护盾吸收、不被八荒减伤、不被同生共死分摊、不参与命中/闪避/暴击）
    drain(fig, amt) { return applyRaw(ctx, fig, amt); },
    giveBuff(fig, def, opts) { return giveBuff(fig, def, opts); },
    addValor(fig, n) { fig.valor = (fig.valor || 0) + (n || 0); if (fig && fig._refreshBuffIcons) fig._refreshBuffIcons(); },
    consumeValor(fig, n) { const t = Math.min(n, fig.valor || 0); fig.valor = (fig.valor || 0) - t; return t; },
    // 怒气获取（统一出口）：累加并钳制到 rageMax（与 fighter.js:1293 怒气上限一致）。此前为死方法，本次(2026-09-15)首次接入 7 类战斗行为。
    // ★ 一次性带封顶赋值：若分两步（先 =旧+amt 再 =上限）会经底层 rage setter 触发「+amt 然后 -(amt-净增)」双飘字；
    //   这里直接算净增后的封顶值单次写入，只飘一次净变化（与 HP/MP 单值飘字一致）。
    addRage(fig, amt, pct) {
      // ★ 无怒气系统的单位（宠物/怪物，rageMax<=0）整体跳过：不加怒、不累计 ragePct、不飘字
      if (!fig || (fig.rageMax || 0) <= 0) return;
      const old = fig.rage || 0;
      const nv = (fig.rageMax != null) ? Math.min(fig.rageMax, old + (amt || 0)) : old + (amt || 0);
      fig.rage = nv;
      fig.ragePct = (fig.ragePct || 0) + (pct || 0);
    },
    xw(fig) { return xw(fig); },
    targets: []
  };
  return ctx;
}



// ───────────────────────── 26 技能精确公式（TEMPLATES）─────────────────────────
// 每个模板 (ctx, { skill, primary, targets }) 忠实落地 PDF 公式，系数全部来自 skills.json.params
// （经 resolveSkillParams 注入 ctx.params）；技能按 skills.json 的 formula 字段选择对应模板。
export const TEMPLATES = {
  // 50010000 伏魔刀法
  'tpl20001'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk, r = ctx.roll();
    const dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * r;
    ctx.deal(primary, dmg, { attacker: ctx.caster });
    if (p.stun.link && ctx.xw(ctx.caster) > ctx.xw(primary) && Math.random() < p.stun.prob) {
      ctx.giveBuff(primary, { id: 'stun', name: '眩晕', kind: 'stun', duration: p.stun.dur }, { duration: p.stun.dur });
      ctx.log(ctx.caster.name + ' 的伏魔刀法使 ' + primary.name + ' 眩晕');
    }
  },
  // 50020000 六脉神剑
  'tpl20002'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    for (const t of targets) {
      const dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
      ctx.deal(t, dmg, { attacker: ctx.caster });
    }
  },
  // 50030000 破釜沉舟
  'tpl20003'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    let dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
    if (ctx.caster.hp <= ctx.caster.maxHp * p.lowHpPct) dmg *= p.lowHpMult; // 生命不足上限20%翻倍
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 50050000 龙破斩
  'tpl20004'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    for (const t of targets) {
      let dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
      const bonus = (t.buffs.some(b => p.buffBonusKind.includes(b.def.kind)) || t.defending) ? p.buffBonusMult : 1;
      dmg *= bonus; // 仙气/昊天/防御态 +50%（多状态不叠加）
      ctx.deal(t, dmg, { attacker: ctx.caster, ignoreDefending: true }); // 不被防御状态减免
      if (Math.random() < p.breakarmor.prob) {
        const dd = dur(p.breakarmor.durBase + xw(ctx.caster) / p.breakarmor.durXwPer);
        ctx.giveBuff(t, { id: 'breakarmor', name: '破甲', kind: 'breakarmor', duration: dd }, { duration: dd });
      }
    }
  },
  // 60010000 冷嘲热讽
  'tpl20005'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    for (const t of targets) {
      const success = t.buffs.some(b => b.def.kind === 'insight') ? p.taunt.successInsight : p.taunt.successNormal;
      if (Math.random() < success) {
        ctx.giveBuff(t, { id: 'taunt', name: '嘲讽', kind: 'taunt', duration: p.taunt.dur }, { duration: p.taunt.dur, data: { taunterId: ctx.caster.id, level: L, noDodge: true } });
        if (p.taunt.addValor) ctx.addValor(ctx.caster, p.taunt.addValor);
        ctx.log(ctx.caster.name + ' 嘲讽了 ' + t.name);
      }
    }
  },
  // 60020000 君临天下
  'tpl20006'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    const ratio = Math.max(p.hpRatioFloor, ctx.caster.hp / Math.max(1, ctx.caster.maxHp)); // 生命越低伤害越低
    let dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll() * ratio;
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 60030000 一朝归元
  'tpl20007'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    const consumed = ctx.consumeValor(ctx.caster, p.valorCost);
    let dmg = p.dmgBase * (a + p.atkBase + p.atkPerL * L) * ctx.roll() * (1 + p.perValorMult * consumed); // 每消耗1侠义之心 +100%
    ctx.deal(primary, dmg, { attacker: ctx.caster });
    if (consumed) ctx.log(ctx.caster.name + ' 消耗 ' + consumed + ' 侠义之心，伤害提升');
  },
  // 60040000 同生共死
  'tpl20008'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
    for (const t of targets) {
      // 减伤比例 = reduceBase + reducePerL*L（Lv1–10 取值 25%–47.5%）
      const reducePct = p.reduceBase + p.reducePerL * L;
      // ★ 按 PDF 的分摊规则：减免后【剩余部分】由使用者与承受者分担，使用者分担 = 承受者分担 × (50.5−0.5L)%
      //   设 k=(50.5−0.5L)/100、承受者承担 T、使用者分担 U → U = T×k 且 T+U = 剩余 → T = 剩余/(1+k)、U = 剩余×k/(1+k)
      const shareFactor = (p.shareBase + p.sharePerL * L) / 100;
      const keepFactor = 1 / (1 + shareFactor);   // 承受者保留比例（乘在"剩余伤害"上）
      ctx.giveBuff(t, { id: 'link', name: '同生共死', kind: 'link', duration: dd },
        { duration: dd, data: { userId: ctx.caster.id, level: L, reducePct, shareFactor, keepFactor } });
    }
  },
  // 70010000 千蛛万毒手
  'tpl20009'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    const dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
    ctx.deal(primary, dmg, { attacker: ctx.caster });
    ctx.giveBuff(primary, { id: 'poison', name: '中毒', kind: 'poison', duration: p.poison.dur, dot: 0 },
      { duration: p.poison.dur, data: { dot: (p.poison.dotBase + p.poison.dotPerL * L) * a } });
  },
  // 70020000 暗影迷踪拳
  'tpl20010'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    for (const t of targets) {
      const speedRatio = Math.min(p.speedRatioCap, ctx.caster.spd / Math.max(1, t.spd));
      const dmg = (p.dmgBase + p.dmgPerL * L) * (1 + speedRatio) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
      const dealt = ctx.deal(t, dmg, { attacker: ctx.caster });
      // 使用者自伤 15%：属【体力流失】（PDF："使用者自身会受到技能实际造成伤害的15%"），
      // 故用 ctx.drain（只扣 HP）而非 ctx.deal —— 否则会误触发仙气护体受击回血/昊天护盾/八荒减伤/同生共死分摊，
      // 且会参与命中·闪避·暴击判定（自伤"被闪避/暴击"本身即荒谬）。
      ctx.drain(ctx.caster, dealt * p.selfDmgPct);
    }
  },
  // 70030000 化功绵掌
  'tpl20011'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    let drain = (p.drainBase + p.drainPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
    drain = Math.max(1, drain - primary.def * p.defReducePct); // 受击者物防可减免法力损耗
    // 化功：先扣蓝再飘出 MP 数字（实际扣除量，蓝已空时为 0 → 不显示）
    const mpBefore = primary.mp;
    primary.mp = Math.max(0, primary.mp - Math.round(drain));
    if (ctx.floatNum) ctx.floatNum(primary, 'mp', primary.mp - mpBefore);
    const dmg = p.dmgPerL * L * drain; // 0.05×技能等级×实际扣除法力 物理伤害
    ctx.deal(primary, dmg, { attacker: ctx.caster });
    ctx.log(ctx.caster.name + ' 化去 ' + primary.name + ' ' + Math.round(drain) + ' 法力');
  },
  // 70040000 腐骨蚀心
  'tpl20012'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
    for (const t of targets) {
      // coef/flat 为 TCA 触发器预解析的吸血系数：h = coef×名义伤害 + flat + 攻击者.recover
      // （对齐旧 onDamaged 第4步：(0.29+0.01L)·dmg + 200 + 100L + attacker.recover）
      ctx.giveBuff(t, { id: 'fugu', name: '腐骨蚀心', kind: 'fugu', duration: dd },
        { duration: dd, data: { level: L, coef: 0.29 + 0.01 * L, flat: 200 + 100 * L } });
    }
  },
  // 80010000 疾影袭心
  'tpl20013'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    let dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
    if (primary.buffs.some(b => b.def.kind === 'breakarmor')) dmg *= p.breakarmorMult; // 破甲态翻倍
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 80020000 八荒六合
  'tpl20014'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    const physReduce = Math.min(100, p.physReduceBase + p.physReducePerL * L);
    const magHealInc = p.magHealBase + p.magHealPerL * L;
    const magAtkInc = p.magAtkBase + p.magAtkPerL * L;
    const bd = dur(p.bahuangDurBase + L / p.bahuangDurDiv);
    const nd = bd * p.neiliMult;
    for (const t of targets) {
      if (t.buffs.some(b => b.def.kind === 'neili')) continue; // 有内力充沛不可再获八荒
      ctx.giveBuff(t, { id: 'bahuang', name: '八荒六合', kind: 'bahuang', duration: bd },
        { duration: bd, data: { physReduce, magHealInc, magAtkInc } });
      // 己方用获内力充沛（速度 +0.5×使用者敏捷，持续八荒3倍）
      if (t.side === ctx.caster.side) {
        ctx.giveBuff(t, { id: 'neili', name: '内力充沛', kind: 'neili', duration: nd },
          { duration: nd, data: { spdAdd: p.spdPct * ctx.caster.spd } });
      }
    }
  },
  // 80030000 飞花溅玉
  'tpl20015'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    for (const t of targets) {
      const dmg = (p.dmgBase + p.dmgPerL * L) * (a + p.atkBase + p.atkPerL * L) * ctx.roll();
      ctx.deal(t, dmg, { attacker: ctx.caster });
      const dotBase = (p.feihua.dotBaseBase + p.feihua.dotBasePerL * L) * a * ctx.roll();
      ctx.giveBuff(t, { id: 'feihua', name: '飞花溅玉', kind: 'feihua', duration: p.feihua.dur },
        { duration: p.feihua.dur, data: { dotBase, mults: p.feihua.mults.slice(), tick: 0 } });
    }
  },
  // 80040000 穿心蚀骨
  'tpl20016'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, a = ctx.caster.atk;
    const base = a + p.atkBase + p.atkPerL * L;
    const threshold = (p.thrBase + p.thrPerL * L) * base;
    const extra = (p.extBase + p.extPerL * L) * base;
    const extra2 = (p.ext2Base + p.ext2PerL * L) * base;
    const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
    for (const t of targets) {
      ctx.giveBuff(t, { id: 'chuanxin', name: '穿心蚀骨', kind: 'chuanxin', duration: dd },
        { duration: dd, data: { userId: ctx.caster.id, level: L, pool: 0, threshold, extra, extra2 } });
    }
  },
  // 10010000 四相诀
  'tpl10010000'(ctx, { targets, skill }) {
    // 四相诀系数（伤害/元素/怒气/持续时间）已全部进入 skills.json:10030017.params（单一 id，见配置审计），
    // 此处直接读 ctx.params 即可，无需再合并 DEFAULT。
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    // 命中相（变体）的元素异常：一次施放【随机】取一相（冰/火/风/土），还原"四相诀＝四相随机"。
    // 取值优先级（数据驱动，不臆造）：
    //   1) randomVariants 子技能（effSkill）自带 buffs[0].buff → 该变体的专属单一元素（冰/火/风/土各一）；
    //   2) 否则按技能自身 params.elemBuffs（四相诀＝["freeze","burn","weak","slow"]）【随机】取一相。
    // ⚠ 修复：此前无 randomVariants 时恒取 elemBuffs[0]（=freeze），导致四相诀"永远只出冰相"、效果与动画都不随机。
    //   动画层：randomVariants 命中后 effSkill 是子技能（10010001冰/10011001风/10012001火/10013001土），
    //   各子技能自带 levelAnims（冰=230060001~005、风=230070001~005、火=230080001~005、土=230090001~005），
    //   由 _castVisual 按 effSkill.levelAnims 分档播放 → 四相动画各自独立、随机切换。全部 20 张动画资产均已存在。
    const pickElemBuff = () => {
      if (skill && skill.buffs && skill.buffs[0] && skill.buffs[0].buff) return skill.buffs[0].buff;
      const list = p.elemBuffs || [];
      return list.length ? list[Math.floor(Math.random() * list.length)] : null;
    };
    const elemBuff = pickElemBuff();
    for (const t of targets) {
      const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
      ctx.deal(t, dmg, { attacker: ctx.caster });
      if (elemBuff && Math.random() < p.elemProb) {
        ctx.giveBuff(t, { id: elemBuff, name: elemBuff, kind: elemBuff, duration: p.elemDur }, { duration: p.elemDur });
      }
    }
  },
  // 10020000 唤灭破
  'tpl20018'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const layers = p.elemKinds.reduce((s, k) => s + primary.buffs.filter(b => b.def.kind === k).length, 0);
    const lv = Math.min(p.maxLayers, layers);
    const dmg = ((p.dmgBase + p.dmgPerL * L) * (lv + p.layerBonus) + p.constTerm) * (m + p.magBase + p.magPerL * L) * ctx.roll();
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 10030000 恸地神咒
  'tpl20019'(ctx, { targets, primary }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    for (const t of targets) {
      const coef = (t === primary) ? (p.coefPrimaryBase + p.coefPrimaryPerL * L) : (p.coefOtherBase + p.coefOtherPerL * L);
      const dmg = coef * (m + p.magBase + p.magPerL * L) * ctx.roll();
      ctx.deal(t, dmg, { attacker: ctx.caster });
    }
    const sd = dur(p.selfDur);
    ctx.giveBuff(ctx.caster, { id: 'dongdi', name: '恸地神咒', kind: 'dongdi', duration: sd },
      { duration: sd, data: { defAdd: p.defAddPct * (ctx.caster.def || 0) } });
  },
  // 10040000 烈焰风暴
  'tpl20020'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    for (const t of targets) {
      const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
      ctx.deal(t, dmg, { attacker: ctx.caster });
      if (Math.random() < p.burn.prob) {
        const dd = dur(p.burn.durBase + xw(ctx.caster) / p.burn.durXwPer);
        ctx.giveBuff(t, { id: 'burn', name: '灼烧', kind: 'burn', duration: dd }, { duration: dd });
      }
    }
  },
  // 20010000 摄魂咒
  'tpl20021'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 20020000 魅惑术
  'tpl20022'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    for (const t of targets) {
      if (ctx.xw(ctx.caster) > ctx.xw(t) && Math.random() < p.confProb) {
        const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
        ctx.giveBuff(t, { id: 'confusion', name: '混乱', kind: 'confusion', duration: dd }, { duration: dd });
        ctx.log(ctx.caster.name + ' 魅惑了 ' + t.name);
      }
    }
  },
  // 20030000 暗影魔咒
  'tpl20023'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const atkAdd = (p.atkBaseCoef + p.atkPerLCoef * L) * m + p.constPerL * L + p.constTerm;
    const defAdd = atkAdd * p.defFactor;
    const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
    for (const t of targets) {
      ctx.giveBuff(t, { id: 'anYing', name: '暗影魔咒', kind: 'statbuff', duration: dd },
        { duration: dd, data: { atk: atkAdd, def: defAdd } });
    }
  },
  // 20040000 梦魔咒
  'tpl20024'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    for (const t of targets) {
      if (ctx.xw(ctx.caster) > ctx.xw(t) && Math.random() < p.sleepProb) {
        const dd = dur(p.durBase + xw(ctx.caster) / p.durXwPer);
        const heal = (p.healBase + p.healPerL * L) * m;
        ctx.giveBuff(t, { id: 'sleep', name: '昏睡', kind: 'sleep', duration: dd, heal },
          { duration: dd, data: { heal } });
        ctx.log(ctx.caster.name + ' 使 ' + t.name + ' 陷入昏睡');
      }
    }
  },
  // 30010000 慈悲咒
  'tpl20025'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 30020000 沉水润心
  'tpl20026'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const critRate = ctx.caster.crit || 0;
    for (const t of targets) {
      let heal = (p.healBase + p.healPerL * L) * (m + p.magBase + p.magPerL * L) + (t.recover || 0);
      if (critRate > 0 && Math.random() * 100 < critRate) {
        heal = (p.critHealBase + p.critHealPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll() + (t.recover || 0); // 暴击（物理暴击率）
        if (ctx.floatAnim) ctx.floatAnim(t, 'baoji'); else ctx.float(t, '暴击治疗', '#ffd54f');   // 暴击治疗：同用 baoji 动画
      }
      ctx.heal(t, heal);
    }
  },
  // 30030000 仙音化雨
  'tpl20027'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    for (const t of targets) {
      if (t.side === ctx.caster.side) {
        // 己方：解等级≤L的debuff + 加仙音化雨buff每回合回血
        const success = t.buffs.some(b => b.def.kind === 'insight') ? p.friendSuccessInsight : p.friendSuccessNormal;
        if (Math.random() < success) {
          t.buffs = t.buffs.filter(b => !(b.def.kind === 'debuff' && (b.def.level || 1) <= L));
          if (t._refreshBuffIcons) t._refreshBuffIcons();
          const heal = p.healBase + p.healPerL * L + (t.recover || 0);
          ctx.giveBuff(t, { id: 'xianyin', name: '仙音化雨', kind: 'xianyin', duration: p.dur, heal }, { duration: p.dur, data: { heal } });
        }
      } else {
        // 敌方：不可被闪避；修为高于承受者修为-96000 时解等级≤L+3的buff
        const can = ctx.xw(ctx.caster) > ctx.xw(t) - p.enemyXwGap;
        const success = (t.buffs.some(b => b.def.kind === 'insight') || !can || ctx.xw(ctx.caster) < ctx.xw(t)) ? p.enemySuccessInsight : p.enemySuccessNormal;
        if (Math.random() < success) {
          t.buffs = t.buffs.filter(b => !((b.def.kind === 'buff') && (b.def.level || 1) <= L + p.dispelLPlus));
          if (t._refreshBuffIcons) t._refreshBuffIcons();
          ctx.log(ctx.caster.name + ' 驱散了 ' + t.name + ' 的增益');
        }
      }
    }
  },
  // 30060000 仙气护体
  'tpl20028'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const durN = L >= 11 ? dur(p.highDurBase + cishan(ctx.caster) / p.highDurCishanDiv) : dur(p.lowDurBase + xw(ctx.caster) / p.lowDurXwPer);
    for (const t of targets) {
      const heal = (p.healBase + p.healPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll() + (t.recover || 0);
      const critHeal = (p.critHealBase + p.critHealPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll() + (t.recover || 0);
      ctx.giveBuff(t, { id: 'xianqi', name: '仙气护体', kind: 'xianqi', duration: durN },
        { duration: durN, data: { heal, critHeal, critRate: p.critRate } });
    }
  },
  // 40010000 天地极乐
  'tpl20029'(ctx, { primary }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
    ctx.deal(primary, dmg, { attacker: ctx.caster });
  },
  // 40020000 圣灵附体
  'tpl20030'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const durN = L >= 11 ? dur(p.highDurBase + cishan(ctx.caster) / p.highDurCishanDiv) : dur(p.lowDurBase + xw(ctx.caster) / p.lowDurXwPer);
    for (const t of targets) {
      const defAdd = ((p.defBaseCoef + p.defPerLCoef * L) * m + p.constTerm + p.constPerL * L) * ctx.roll();
      ctx.giveBuff(t, { id: 'shengling', name: '圣灵附体', kind: 'statbuff', duration: durN },
        { duration: durN, data: { def: defAdd, atk: defAdd * p.atkFactor, mag: defAdd * p.magFactor, recover: defAdd * p.recoverFactor, spd: defAdd / p.spdDiv } });
    }
  },
  // 40030000 昊天罡气
  'tpl20031'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L, m = ctx.caster.mag;
    const durN = L >= 11 ? dur(p.highDurBase + cishan(ctx.caster) / p.highDurCishanDiv) : dur(p.lowDurBase + xw(ctx.caster) / p.lowDurXwPer);
    for (const t of targets) {
      const shield = (p.shieldBase + p.shieldPerL * L) * (m + p.magBase + p.magPerL * L) * ctx.roll();
      // reflect 为 TCA 触发器预解析的"破盾反射"值（对齐旧 onDamaged：**level>=6 才生效**，公式 0.05×(L-3+max(0,L-9))×maxShield）
      // ★ 必须在生产端做 level>=6 门控：公式在 L=4/5 时也非零，仅靠"reflect>0"会与旧版不等价
      const reflect = (L >= 6) ? Math.round(0.05 * (L - 3 + Math.max(0, L - 9)) * shield) : 0;
      ctx.giveBuff(t, { id: 'haotian', name: '昊天罡气', kind: 'haotian', duration: durN },
        { duration: durN, data: { shield, maxShield: shield, level: L, reflect } });
    }
  },
  // 40040000 凝神聚气
  'tpl20032'(ctx, { targets }) {
    const p = ctx.params;
    const L = ctx.L;
    const durN = L >= 11 ? dur(p.highDurBase + cishan(ctx.caster) / p.highDurCishanDiv) : dur(p.lowDurBase + xw(ctx.caster) / p.lowDurXwPer);
    for (const t of targets) {
      const rageAdd = p.rageBase + p.ragePerL * L;
      const ragePctAdd = p.ragePctBase + p.ragePctPerL * L;
      ctx.giveBuff(t, { id: 'ningshen', name: '凝神聚气', kind: 'ningshen', duration: durN },
        { duration: durN, data: { rageAdd, ragePctAdd } });
      const before = t.rage || 0;
      if ((t.rageMax || 0) > 0) { t.rage = before + rageAdd; }   // 无怒气单位（宠物/怪物）不加怒   // ★ 怒气底层 setter 自动按差值飘 battlesp 数字（与我方/敌方普攻回怒同源，无需手动 ctx.floatNum，否则会重复飘字）
      if ((t.rageMax || 0) > 0) t.ragePct = (t.ragePct || 0) + ragePctAdd;
    }
  },
  // 30040000 妙法莲华：单体复活（直接复活倒下的友方，恢复 HP/MP 至上限一定比例；对存活目标视为治疗）
  'tpl20033'(ctx, { primary, targets }) {
    const p = ctx.params;
    const L = ctx.L;
    const hpPct = Math.min(0.9, (p.reviveHpBase || 0.3) + (p.reviveHpPerL || 0.03) * L);
    const mpPct = Math.min(0.9, (p.reviveMpBase || 0.3) + (p.reviveMpPerL || 0.03) * L);
    const tgt = primary || (targets && targets[0]);
    if (!tgt) return;
    if (tgt.hp <= 0) {
      reviveFighter(ctx.scene, tgt, hpPct, mpPct, { caster: ctx.caster });
      ctx.log(ctx.caster.name + ' 施展妙法莲华，复活了 ' + tgt.name + '（恢复 ' + Math.round(hpPct * 100) + '% 生命）');
    } else {
      const want = Math.round((tgt.maxHp || 1) * hpPct);
      if (want > tgt.hp) ctx.heal(tgt, want - tgt.hp, { magic: true });
    }
  },

  // 10030017 四相诀（驱动 + 4 元素变体共用）：随等级成长的法术伤害 + 命中施加对应元素异常
  // 公式：(0.95 + 0.05×L) × (法攻 - 30 + 50×L) × (0.9~1.1)；系数全部来自 skills.json.params 的 dmgBase/dmgPerL/magBase/magPerL
  'tpl20017'(ctx, { primary, skill }) {
    const p = ctx.params, L = ctx.L, m = (ctx.caster.mag || 0), r = ctx.roll();
    const dmg = (p.dmgBase + p.dmgPerL * L) * (m + p.magBase + p.magPerL * L) * r;
    ctx.deal(primary, dmg, { attacker: ctx.caster });
    // 元素异常：复用变体自身 buffs 的 onHit（冰=freeze/火=burn/风=weak/土=slow），保持四相诀"随机一相"特色
    if (Array.isArray(skill.buffs)) applyBuffSpecs(ctx, skill.buffs, 'onHit', { primary, targets: [primary] });
  },

  // 40050000 火焰环绕：自身反伤物理攻击。给施法者挂 huoyan buff（受物理攻击时反弹 pct 比例的伤害给攻击者）。
  'tpl20034'(ctx, { targets }) {
    const p = ctx.params || {};
    const pct = (p.reflectPct != null) ? p.reflectPct : 0.5;   // 反伤比例（基于承受伤害）
    const dmg = (p.reflectFlat != null) ? p.reflectFlat : 0;    // 反伤固定值（叠加在比例之上）
    for (const t of targets) {
      ctx.giveBuff(t, { id: 'huoyan', name: '火焰环绕', kind: 'thorns', duration: 3 },
        { duration: 3, data: { pct, dmg } });
    }
  }
};

// ───────────────────────── 逐等级参数解析（总表 skills.json + 分表 skillLevels.json）─────────────────────────
// 分表 config/skillLevels.json 结构：{ "<id>": { maxLevel, levels: { "<L>": { mpCost, cd, power, heal, params } } } }。
// params 已由 scripts/gen_skill_levels.mjs 预解析为"该等级的解析值"（XxxBase=base+perL*L，XxxPerL=0），
// 故 EXEC 现有数学（XxxBase + XxxPerL*L）无需改动即可消费逐等级数据；缺失分表/等级时回落 DEFAULT，行为完全不变（零回归）。
export function resolveSkillParams(skillId, L) {
  const def = (Config.data && Config.data.skills && Config.data.skills[skillId] && Config.data.skills[skillId].params) || {};
  const sk = (Config.data && Config.data.skills && Config.data.skills[skillId]) || null;
  const sub = (Config.data && Config.data.skillLevels && Config.data.skillLevels[skillId]) || null;
  const lvl = (sub && sub.levels && sub.levels[L]) || null;
  return Object.assign({}, def,
    (sk && sk.params) || {},
    (lvl && lvl.params) || {});
}


// 取代已删除的 DEFAULT_SKILL_PARAMS：从 skills.json 单一数据源读取某技能的"出厂默认系数"。
// 所有技能系数现已集中在 config/skills.json 的 params 字段（含逐等级分表 skillLevels.json 覆盖），
// 编辑器/测试/battle-test 通过本函数取默认，不再依赖引擎内硬编码常量。
export function getDefaultSkillParams(id) {
  const sk = (Config.data && Config.data.skills && Config.data.skills[id]) || null;
  return (sk && sk.params) || {};
}
// 返回某技能在某等级的"有效技能数据"：合并总表与分表的 mpCost/cd/power/heal + 解析后的 params。
export function getSkillLevelData(skillId, L) {
  const sk = (Config.data && Config.data.skills && Config.data.skills[skillId]) || {};
  const sub = (Config.data && Config.data.skillLevels && Config.data.skillLevels[skillId]) || null;
  const lvl = (sub && sub.levels && sub.levels[L]) || null;
  return {
    mpCost:   (lvl && lvl.mpCost != null) ? lvl.mpCost : (sk.mpCost || 0),
    rageCost: (lvl && lvl.rageCost != null) ? lvl.rageCost : (sk.rageCost || 0),   // 怒气消耗（仅人物）
    lifeCost: (lvl && lvl.lifeCost != null) ? lvl.lifeCost : (sk.lifeCost || 0),   // 寿命消耗（仅宠物）
    cd:       (lvl && lvl.cd != null) ? lvl.cd : (sk.cd || 0),
    power:  (lvl && lvl.power != null) ? lvl.power : (sk.power || 0),
    heal:   (lvl && lvl.heal != null) ? lvl.heal : (sk.heal || 0),
    params: resolveSkillParams(skillId, L)
  };
}

// ───────────────────────── 技能执行入口 ─────────────────────────
export async function castSkill(scene, caster, skillId, opts = {}) {
  const skill = (Config.data && Config.data.skills && Config.data.skills[skillId]) || null;
  if (!skill) return null;
  // 随机变体驱动：四相诀等"一个技能驱动多个子技能"的技能，施放时随机选一个子技能作为实际生效技能
  // （伤害 / buff / 动画 / 名称均取该子技能）。无 randomVariants 时 effSkill === skill。
  const variants = (skill.randomVariants && skill.randomVariants.length) ? skill.randomVariants : null;
  const effSkill = variants ? (Config.data.skills[variants[Math.floor(Math.random() * variants.length)]] || skill) : skill;
  const L = caster.skillLevel ? caster.skillLevel(skillId) : (caster.level || 1);
  const sansheng = !!(caster.sansheng);
  // 法术判定：dtype==='magic' （法术技能统一以 dtype==='magic' 判定，不再按 ID 段）走 magDef/法术命中/法术暴击
  const isMagic = effSkill.dtype === 'magic';
  let primary = opts.primaryTarget || null;
  // 目标侧守卫：杜绝"友方技能误打敌方 / 敌方技能误打己方"。
  // enemy → 强制敌方（传入非敌方目标则回退首个存活敌人）；
  // enemyOrAlly → 尊重玩家点选（任意侧），未点选则默认敌人；
  // self/ally → 强制己方（仅当传入目标与施法者同侧才采纳点选的特定友方，否则回退施法者自身）。
  if (effSkill.target === 'enemy') {
    primary = (primary && primary.side !== caster.side && primary.hp > 0) ? primary : scene._firstAliveEnemy();
  } else if (effSkill.target === 'enemyOrAlly') {
    if (!primary) primary = scene._firstAliveEnemy();
  } else if (effSkill.target === 'self' || effSkill.target === 'ally') {
    // 复活类技能允许选中的友方已阵亡（hp<=0）；其余情况仍要求存活
    primary = (primary && primary.side === caster.side && (primary.hp > 0 || effSkill.revive)) ? primary : caster;
  }
  let targets = resolveTargets(scene, effSkill, L, sansheng, caster, primary);
  // 若 scope 覆盖开启，primary 同步指向首个命中目标（单目标技能也会打到指定范围的首个单位）
  const sc = skillScope(effSkill);
  if (sc && targets.length) primary = targets[0];
  // 演出（对齐原客户端施法名/技能SWF/特效）
  if (scene._showSkillName) scene._showSkillName(effSkill.name, caster);
  // 表现层：若技能配置了"表现时间轴"（测试页可调参数 params.timeline，对应专利 CN115253301A「时间片段集合」：
  // 攻击配置 + 受击配置，由单一时间变量 t 驱动整段节奏，整体乘以 timeScale 即可加速/减速），则由时间轴接管整段演出；
  // 否则走原版：施法者 CAST 动作 + 单次 _castVisual 特效（32 技能零回归）。
  const tl = (effSkill.params && effSkill.params.timeline && Array.isArray(effSkill.params.timeline) && effSkill.params.timeline.length) ? effSkill.params.timeline : null;
  let visualP;
  let castFinishedP = null;   // 施法者 CAST 角色动作 Promise（供末尾等待真实播放时长，对齐普攻 _awaitAttack）
  if (tl) {
    // 时间轴拥有完整演出（cast/hit/fx 片段），不再重复播 CAST 动作
    if (scene._playTimeline) visualP = scene._playTimeline(effSkill, { caster, primary, targets }, tl);
    else visualP = playTimeline(scene, effSkill, { caster, primary, targets }, tl);
  } else {
    // cast 角色动作：loop:false + freezeLast:true → 播一次后定格末帧，不再循环卡住（fanvas 无视 loop:false，freezeLast 用 onFrame 主动 gotoAndStop 末帧）；
    // 播放完由调用方（_engineCast）切回 STAND 站立态。
    if (caster.act) castFinishedP = caster.act(ACTION.CAST, caster.dir, { scale: scene.SCALE, loop: false, freezeLast: true });
    // 演出与伤害【同步】：先启动技能动画（不阻塞伤害结算），伤害飘字随动画一同出现（修复"动画放完才出伤害数字"）；
    // 末尾 await visualP 保证整段动画仍落在施法者本回合内（对齐"技能播放后两回合不能点击"修复，动画不溢出到敌方/下回合）。
    // 透传驱动技等级 L：随机变体驱动场景下 effSkill 是子技能（本身无等级），其 levelAnims/levelEffects 须按驱动技 L 分档
    visualP = scene._castVisual ? scene._castVisual(effSkill, { caster, primary, targets, L }) : Promise.resolve();
  }
  const ctx = makeCtx(scene, caster, L, sansheng, isMagic, effSkill);
  ctx.targets = targets;
  // 注入可调参数：总表 skills.json.params + 分表 skillLevels.json 的
  // levels[L].params 逐字段覆盖。无分表/等级时回落 DEFAULT，主游戏表现零回归。
  ctx.params = resolveSkillParams(skillId, L);
  const fn = TEMPLATES[(skill && skill.formula) || (effSkill && effSkill.formula)];
  // 结构化 buff 仅对无 AS3 精确公式（genericCast）的技能生效；有 EXEC 的 26 个签名技能由各自 EXEC 内硬编码施加（保真），
  // 其 skills.json.buffs 作为可编辑数据模型存在，不在此处重复施加（避免双重挂 buff）。
  const structured = !fn && Array.isArray(effSkill.buffs) && effSkill.buffs.length && typeof effSkill.buffs[0] === 'object';
  // 安全闸：formula 已连上引擎模板，但 skills.json 尚未补 params 系数时，直接回落 genericCast，
  // 避免模板读到 undefined 系数算出 NaN / 对 undefined 嵌套字段抛错（被战斗 catch 吞掉等于仍"失效"）。
  // 一旦 skills.json.params 补齐，模板自动接管、无需改这里。
  const paramsReady = ctx.params && Object.keys(ctx.params).length > 0;
  // ★ BEFORE_ATTACK（技能路径）：施法前同步内联广播，可施加自身增益以影响本次结算
  const _hpBefore = skillBeforeAttack(scene, caster, skillId, primary, targets);
  // ★ D 组：声明了 actions 的技能走原子化效果链（完全配置化）；否则回退旧公式模板 / genericCast
  if (runSkillActions(effSkill, ctx, caster, primary, targets)) {
    // 效果链已在 actions 内执行完毕（伤害/buff/资源/表现全部数据化）
  } else if (fn && paramsReady) await fn(ctx, { skill: effSkill, primary, targets });
  else await genericCast(ctx, { skill: effSkill, primary, targets }, structured && paramsReady ? false : structured); // 旧占位技能（烈火斩等）回退为 power/heal/buff 近似
  // ★ AFTER_ATTACK（技能路径）：伤害结算完毕（追击 / 斩杀追加 的检测点）；event.value = 本次实际总伤害
  skillAfterAttack(scene, caster, skillId, primary, targets, _hpBefore);
  // 受击致死的单位：与技能演出【同时】播放倒地动画（修复"技能放完敌人才倒"的割裂感——原流程等技能动画播完才在 _afterPlayerAction 触发倒地）。
  // 通过 scene.onDeath 路由：敌方→_onEnemyDown（含奖励）、己方队员→_onAllyDown（仅倒地）、主角→null(由 _lose 处理)；_down 守卫防重复播放。
  // 兼容测试页 mock（仅提供 _onEnemyDown 的情况）：无 onDeath 时回退为仅敌方触发。
  const killP = [];
  for (const t of targets) {
    if (t && t.hp <= 0 && !t._down) {
      const dn = (typeof scene.onDeath === 'function')
        ? scene.onDeath(t)
        : (scene.enemies && scene.enemies.indexOf(t) >= 0 ? scene._onEnemyDown(t) : null);
      if (dn) killP.push(dn);
    }
  }
  // 整段（技能动画 + 倒地）落在本回合内，结束时两者都已播完，避免点击穿透到敌方/下回合
  await Promise.all([visualP, ...killP]);
  // 等施法者 CAST 角色动作真实播放完（fanvas 无视 loop:false，freezeLast 仅定格末帧不停止渲染压力）；
  // 此处按真实时长等待，确保"切回站立"不会过早打断 cast 演出，对齐普攻 _awaitAttack 的时长等待。
  if (castFinishedP) {
    const fr = caster._fanvasFrames || 1, rt = caster._fanvasFrameRate || 25;
    await new Promise(r => setTimeout(r, (fr / rt) * 1000));
  }
  return { targets };
}

// 同步版技能执行（无动画 / 无 await）：供"阈值触发"等联动反应调用，使技能伤害同步重新进入
// onDamaged 形成连锁。主游戏 castSkill 仍走异步演出；本函数仅用于联动场景，零动画、零回归。
// 注意：同步执行意味着调用栈由 _flush 的迭代循环托管（不递归），可安全达到极深联动层数。
export function castSkillSync(scene, caster, skillId, opts = {}) {
  const skill = (Config.data && Config.data.skills && Config.data.skills[skillId]) || null;
  if (!skill) return null;
  // 随机变体驱动：四相诀等"一个技能驱动多个子技能"的技能，施放时随机选一个子技能作为实际生效技能
  // （伤害 / buff / 动画 / 名称均取该子技能）。无 randomVariants 时 effSkill === skill。
  const variants = (skill.randomVariants && skill.randomVariants.length) ? skill.randomVariants : null;
  const effSkill = variants ? (Config.data.skills[variants[Math.floor(Math.random() * variants.length)]] || skill) : skill;
  const L = caster.skillLevel ? caster.skillLevel(skillId) : (caster.level || 1);
  const sansheng = !!(caster.sansheng);
  const isMagic = effSkill.dtype === 'magic';
  let primary = opts.primaryTarget || null;
  // 目标侧守卫：杜绝"友方技能误打敌方 / 敌方技能误打己方"。
  // enemy → 强制敌方（传入非敌方目标则回退首个存活敌人）；
  // enemyOrAlly → 尊重玩家点选（任意侧），未点选则默认敌人；
  // self/ally → 强制己方（仅当传入目标与施法者同侧才采纳点选的特定友方，否则回退施法者自身）。
  if (effSkill.target === 'enemy') {
    primary = (primary && primary.side !== caster.side && primary.hp > 0) ? primary : scene._firstAliveEnemy();
  } else if (effSkill.target === 'enemyOrAlly') {
    if (!primary) primary = scene._firstAliveEnemy();
  } else if (effSkill.target === 'self' || effSkill.target === 'ally') {
    // 复活类技能允许选中的友方已阵亡（hp<=0）；其余情况仍要求存活
    primary = (primary && primary.side === caster.side && (primary.hp > 0 || effSkill.revive)) ? primary : caster;
  }
  let targets = resolveTargets(scene, effSkill, L, sansheng, caster, primary);
  const sc = skillScope(effSkill);
  if (sc && targets.length) primary = targets[0];
  const ctx = makeCtx(scene, caster, L, sansheng, isMagic, effSkill);
  ctx.targets = targets;
  ctx.params = resolveSkillParams(skillId, L);
  const fn = TEMPLATES[(skill && skill.formula) || (effSkill && effSkill.formula)];
  const structured = !fn && Array.isArray(effSkill.buffs) && effSkill.buffs.length && typeof effSkill.buffs[0] === 'object';
  const paramsReady = ctx.params && Object.keys(ctx.params).length > 0;
  // ★ 技能路径事件广播（与 castSkill 同规则，供联动/被动在同步链路下也可被触发）
  const _hpBefore = skillBeforeAttack(scene, caster, skillId, primary, targets);
  // ★ D 组：声明了 actions 的技能走原子化效果链（完全配置化）；否则回退旧公式模板 / genericCast
  if (runSkillActions(effSkill, ctx, caster, primary, targets)) {
    // 效果链已在 actions 内执行完毕
  } else if (fn && paramsReady) fn(ctx, { skill: effSkill, primary, targets });
  else genericCast(ctx, { skill: effSkill, primary, targets }, structured && paramsReady ? false : structured);
  skillAfterAttack(scene, caster, skillId, primary, targets, _hpBefore);
  return { targets };
}

// ───────────────────────── 结构化 buff 应用器 ─────────────────────────
// 技能配置的结构化 buff 数组：每个元素
//   { timing:'onCast'|'onHit'|'onKill'|'turnStart', target:'self'|'primary'|'targets'|'allAllies'|'allEnemies'|'all'|'randomEnemy',
//     prob:'guaranteed'|'chance'|'formula', chance:0-1, formula:'<expr>', buff:'<buffId>', link:'id,id', duration?:number }
// 由 castSkill/genericCast 在对应时机调用 applyBuffSpecs 统一施加；保证 buff 添加"时机/目标/概率/关联"完全数据化、可编辑。
export function applyBuffSpecs(ctx, specs, timing, info) {
  if (!specs || !specs.length) return;
  for (const spec of specs) {
    if (spec.timing !== timing) continue;
    const figs = resolveBuffTargets(ctx, spec.target, info);
    for (const fig of figs) {
      if (!fig || fig.hp <= 0) continue;
      if (!buffProbOk(spec, ctx.caster, fig)) continue;
      grantOne(ctx, fig, spec);
    }
  }
}
function resolveBuffTargets(ctx, target, info) {
  const scene = ctx.scene, caster = ctx.caster;
  const enemies = aliveFoesOf(scene, caster);
  const friends = aliveFriendsOf(scene, caster);
  switch (target) {
    case 'self':        return [caster];
    case 'primary':     return info.primary ? [info.primary] : [];
    case 'targets':     return (info.targets || []).slice();
    case 'allAllies':   return friends;
    case 'allEnemies':  return enemies;
    case 'all':         return friends.concat(enemies);
    case 'randomEnemy': return enemies.length ? [enemies[Math.floor(Math.random() * enemies.length)]] : [];
    default:            return [];
  }
}
function buffProbOk(spec, caster, target) {
  const t = spec.prob || 'guaranteed';
  if (t === 'guaranteed') return true;
  if (t === 'chance') return Math.random() < (spec.chance != null ? Number(spec.chance) : 1);
  if (t === 'formula') return evalBuffProb(spec.formula, caster, target);
  return true;
}
// 概率公式沙箱：提供 rand()/caster/target/xw()，返回布尔。任何异常（语法/越权）→ 安全回退 false。
function evalBuffProb(expr, caster, target) {
  if (!expr) return false;
  try {
    const xw = (f) => (f && f.xiuwei) || 0;
    const fn = new Function('rand', 'caster', 'target', 'xw', 'return (' + expr + ');');
    return !!fn(Math.random, caster, target, xw);
  } catch (e) { return false; }
}
// 八荒六合等级缩放数据（对齐 tpl20014）：物理减伤 / 法术治疗增幅 / 法术攻击增幅 / 内力速度加成
function bahuangData(ctx) {
  const p = resolveSkillParams('80020000', (ctx && ctx.L) || 1);
  const L = ctx.L || 1;
  return {
    physReduce: Math.min(100, (p.physReduceBase || 0) + (p.physReducePerL || 0) * L),
    magHealInc: (p.magHealBase || 0) + (p.magHealPerL || 0) * L,
    magAtkInc: (p.magAtkBase || 0) + (p.magAtkPerL || 0) * L
  };
}
function neiliData(ctx) {
  const p = resolveSkillParams('80020000', (ctx && ctx.L) || 1);
  return { spdAdd: (p.spdPct || 0) * (ctx.caster.spd || 0) };
}
// 结构化 buff 的侧别过滤：self=仅施法者 / ally=同侧（含施法者）/ enemy=异侧 / none=不限
function sideOk(spec, ctx, fig) {
  const s = spec.side;
  if (!s || s === 'none') return true;
  if (s === 'self') return fig === ctx.caster;
  if (s === 'ally') return fig.side === ctx.caster.side;
  if (s === 'enemy') return fig.side !== ctx.caster.side;
  return true;
}
// 取 buff 的数据负载：spec.data 优先（结构化可编辑覆盖）；bahuang/neili 缺省由 tpl20014 参数按等级算出
function buffDataFor(ctx, spec) {
  if (spec.data != null) return spec.data;
  if (spec.buff === 'bahuang') return bahuangData(ctx);
  if (spec.buff === 'neili') return neiliData(ctx);
  return null;
}
function grantOne(ctx, fig, spec) {
  if (!sideOk(spec, ctx, fig)) return;
  const def = lookupBuffDef(spec.buff, spec.duration);
  if (def) {
    let data = buffDataFor(ctx, spec);
    // 嘲讽类 buff 经结构化 spec / 编辑器施加时无法预知施法者，data 可能为 null；
    // 这里补上 taunterId（指向施法者），使其真正生效；无施法者（编辑器木桩）则置 null，
    // 由 redirectTarget 的空值守卫安全跳过（避免 "taunt.data.taunterId" 空指针崩溃）。
    if (def.kind === 'taunt' && !data) data = { taunterId: (ctx.caster && ctx.caster.id) || null };
    if (spec.timing === 'turnStart') { (fig._pendingTurnStartBuffs = fig._pendingTurnStartBuffs || []).push({ def, stack: 1, data }); }
    else ctx.giveBuff(fig, def, { duration: def.duration, data });
  }
  if (spec.link) {
    String(spec.link).split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
      const ld = lookupBuffDef(id);
      if (ld) {
        if (spec.timing === 'turnStart') (fig._pendingTurnStartBuffs = fig._pendingTurnStartBuffs || []).push({ def: ld, stack: 1, data: null });
        else ctx.giveBuff(fig, ld, { duration: ld.duration });
      }
    });
  }
}
function lookupBuffDef(id, durationOverride) {
  if (!id) return null;
  const b = (Config.data && Config.data.buffs && Config.data.buffs[id]) || null;
  if (b) { const d = Object.assign({}, b); if (durationOverride != null) d.duration = durationOverride; return d; }
  return { id, name: id, kind: id, duration: durationOverride != null ? durationOverride : 3 };
}

// 旧占位技能回退（无 AS3 精确公式的 10010/10020/10030 等）：按 power/heal/buffs 近似，避免技能失效。
// buffs 支持两种形态：① 结构化对象数组（推荐，含 timing/target/prob/buff/link，本函数按 onCast/onHit/onKill/turnStart 时机施加）；
// ② 旧版纯 id 字符串数组（['poison',...]，保持向后兼容）。
async function genericCast(ctx, { skill, primary, targets }, structured) {
  const tgt = (skill.target === 'enemy') ? (targets || []) : [primary].filter(f => f && f.hp > 0);
  const isStruct = !!structured && Array.isArray(skill.buffs) && skill.buffs.length && typeof skill.buffs[0] === 'object';
  if (isStruct) {
    // 释放时机：onCast（施法当下）/ turnStart（挂到目标下次回合开始）
    applyBuffSpecs(ctx, skill.buffs, 'onCast', { primary, targets: tgt });
    applyBuffSpecs(ctx, skill.buffs, 'turnStart', { primary, targets: tgt });
  }
  if (skill.heal) { tgt.forEach(t => ctx.heal(t, skill.heal, { magic: isMagic })); return; }
  if (skill.power) {
    const isMagic = skill.dtype === 'magic';
    tgt.forEach(t => ctx.deal(t, (skill.power || 1) * (isMagic ? ctx.caster.mag : ctx.caster.atk) * ctx.roll(), { attacker: ctx.caster }));
    if (isStruct) {
      applyBuffSpecs(ctx, skill.buffs, 'onHit', { primary, targets: tgt });
      const dead = tgt.filter(t => t.hp <= 0);
      if (dead.length) applyBuffSpecs(ctx, skill.buffs, 'onKill', { primary, targets: dead });
    }
    return;
  }
  // 无 power/heal 的纯 buff 技能（如仅挂 buff 的招式）：
  // 结构化 buff 已在上方 onCast / turnStart 时机统一施加（不在此重复）；此处仅兜底处理旧版纯 id 字符串数组。
  if (!isStruct && skill.buffs && skill.buffs.length) {
    tgt.forEach(t => skill.buffs.forEach(b => {
      if (typeof b === 'string') ctx.giveBuff(t, { id: b, name: b, kind: 'buff', duration: 3 });
    }));
  }
}

// ───────────────────────── 表现时间轴（专利 CN115253301A：时间片段集合）─────────────────────────
// 把"一次技能演出"拆成有序的时间片段（segments），每个片段由单一时间变量 t（毫秒）驱动；
// t 统一乘以一个 timeScale（战斗速度），即可整体加速/减速而不改变相对节奏——这正是专利的核心优点。
// 片段类型：
//   cast：攻击配置（在 side 角色上播放出手动作，action 取 ACTION 枚举名，如 'attack'/'cast'）
//   hit ：受击配置（在 side 角色上播放受击反应 ACTION.HURT）
//   fx  ：表现单元（在 focus 处播放特效/粒子/复合特效，resourceId 即 resource/skill|effect/<id>）
// side：caster / primary / targets / all；at（fx 焦点）：primary / caster / targets
// 主游戏不配置 timeline，始终保持原版单段演出（零回归）；仅测试页可调参数 params.timeline 走此路径。
const TL_PLAY_TAIL = 360;   // 末尾留白（ms），让最后一个动作有收尾时间

function tlActors(side, info) {
  if (side === 'caster') return [info.caster].filter(Boolean);
  if (side === 'primary') return [info.primary].filter(Boolean);
  if (side === 'targets') return (Array.isArray(info.targets) ? info.targets : []).filter(Boolean);
  if (side === 'all') return [info.caster, ...(Array.isArray(info.targets) ? info.targets : [])].filter(Boolean);
  return [];
}
function tlFocus(at, info) {
  if (at === 'caster') return info.caster;
  if (at === 'targets') return (Array.isArray(info.targets) && info.targets[0]) || info.primary;
  return info.primary;
}
function tlAction(a) {
  if (typeof a === 'number') return a;
  if (a && ACTION[a.toUpperCase()] != null) return ACTION[a.toUpperCase()];
  return null;
}

// 播放单个时间片段。fx 通过 scene._fx(rid, focus, {shake,scale}) 交由表现层
// （测试页用 Fanvas 特效；主游戏 BattleScene 不配置 timeline，故不会走到这里）。
export async function playSegment(scene, skill, seg, info) {
  if (!seg || typeof seg !== 'object') return;
  const scale = (seg.scale != null) ? seg.scale : (scene && scene.SCALE != null ? scene.SCALE : 1);
  const kind = seg.kind || 'fx';
  if (kind === 'cast') {
    const action = tlAction(seg.action) || ACTION.CAST;
    for (const f of tlActors(seg.side || 'caster', info)) {
      if (f && f.act) { try { await f.act(action, (f.dir || 'right'), { scale }); } catch (e) {} }
    }
  } else if (kind === 'hit') {
    for (const f of tlActors(seg.side || 'targets', info)) {
      if (f && f.act) { try { await f.act(ACTION.HURT, (f.dir || 'right'), { scale }); } catch (e) {} }
    }
  } else { // fx
    const rid = (seg.resourceId && String(seg.resourceId)) || String(skill.id);
    const focus = tlFocus(seg.at || 'primary', info);
    if (scene && scene._fx) { try { scene._fx(rid, focus, { shake: !!seg.shake, scale }); } catch (e) {} }
  }
}

// 播放整条时间轴：按 t 排序，逐个 setTimeout(t*timeScale) 触发；返回 Promise（最后一个片段 + 收尾留白后 resolve）。
export function playTimeline(scene, skill, info, tl) {
  const segs = (Array.isArray(tl) ? tl : (skill && skill.params && skill.params.timeline) || [])
    .filter(s => s && typeof s === 'object')
    .slice()
    .sort((a, b) => (a.t || 0) - (b.t || 0));
  if (!segs.length) return Promise.resolve();
  const ts = Math.max(0.05, (scene && scene.timeScale) || 1);
  let lastAt = 0;
  const runs = segs.map(seg => new Promise(res => {
    const at = (seg.t || 0) * ts;
    lastAt = Math.max(lastAt, at);
    setTimeout(() => { playSegment(scene, skill, seg, info).catch(() => {}).finally(res); }, at);
  }));
  return Promise.all(runs).then(() => new Promise(r => setTimeout(r, TL_PLAY_TAIL)));
}

// 时间轴片段工厂（测试页编辑器复用，保证字段完整）
export function makeSegment(o) {
  return Object.assign({ t: 0, kind: 'fx', side: 'primary', action: 'attack', resourceId: '', at: 'primary', shake: false, scale: null }, o || {});
}
