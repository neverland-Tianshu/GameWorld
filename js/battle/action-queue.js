// ── 行动队列改写原语（TCA 阶段1）────────────────────────────────────────────
// 抽为【纯函数模块】：不依赖 DOM / BattleScene，便于单测（_verify/tca_phase1.mjs 直接 import）。
// 队列模型：离散速度队列 + 游标消费（非连续 ATB）。
//   queue[0 .. cursor-1] = 本回合【已行动】段（冻结，永不重排）
//   queue[cursor .. ]     = 本回合【未行动】段（可被插队 / 重排）
// 设计依据：《原子化设计文档_技能与buff_TCA增补.md》§3。

// 速度降序；同速我方（player）优先于敌方，保持稳定避免抖动（与 scene._buildTurnOrder 一致）
export function bySpdDesc(a, b) {
  const sa = (a && a.spd) || 0, sb = (b && b.spd) || 0;
  if (sb !== sa) return sb - sa;
  const pa = (a && a.side === 'enemy') ? 1 : 0;
  const pb = (b && b.side === 'enemy') ? 1 : 0;
  return pa - pb;
}

// ① 即时插队：把单位插到"下一个待行动"位置（对应 疾风 / 邀战 / 反击）。
//    默认允许"本回合已行动过"的单位再动（邀战语义）；oncePerRound:true 时显式查重拦截。
//    counts 为单回合插队计数表（按 fighter.id 累计），超过 cap（默认 3）即拒绝。
//    返回 { ok, reason }；ok=true 时已原地改写 queue。
export function insertImmediate(queue, cursor, fighter, counts, opts = {}) {
  if (!fighter || fighter.hp <= 0 || !Array.isArray(queue)) return { ok: false, reason: 'invalid' };
  const cap = (opts.cap != null) ? opts.cap : 3;
  const key = fighter.id || fighter.name || 'u';
  const used = (counts && counts[key]) || 0;
  if (used >= cap) return { ok: false, reason: 'cap' };
  const at = (cursor != null) ? cursor : queue.length;
  if (opts.oncePerRound && queue.slice(0, at).some(f => f === fighter)) return { ok: false, reason: 'once' };
  if (counts) counts[key] = used + 1;
  queue.splice(at, 0, fighter);   // 插到游标处 = "下一个待行动"
  return { ok: true, at };
}

// ② 重排未行动单位（减速 / 加速后立即生效）。
//    ★ 只重排游标之后的部分，已行动段冻结 —— 否则会与出手顺序条 UI / 已播演出不一致。
//    原地改写并返回同一数组引用（保证 scene._turnOrder 引用不失效）。
export function resortQueue(queue, cursor) {
  if (!Array.isArray(queue)) return queue;
  const cur = cursor || 0;
  const done = queue.slice(0, cur);
  const todo = queue.slice(cur).sort(bySpdDesc);
  queue.length = 0;
  for (const f of done) queue.push(f);
  for (const f of todo) queue.push(f);
  return queue;
}

// ③ 延迟追加（残血追击 / 回合结束追加）：排到队尾，本轮稍后执行
export function appendTurn(queue, fighter) {
  if (!fighter || fighter.hp <= 0 || !Array.isArray(queue)) return false;
  queue.push(fighter);
  return true;
}

// 由当前队列快照生成"下一位待行动者"（供测试/调试断言，不参与主流程）
export function peekNext(queue, cursor) {
  if (!Array.isArray(queue)) return null;
  return queue[cursor] || null;
}
