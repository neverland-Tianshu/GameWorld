// rt.js — 运行期内核：属性公式求值 + 伤害计算 + 掉落掷表
// 让「属性公式编辑器 / Buff编辑器 / 战斗AI编辑器 / 掉落权重编辑器 / 暗雷明雷 / 副本」的配置
// 真正驱动战斗与地图行为（对应 Request C「工具要实现,真实可用」）。
//
// 设计原则（对齐 AS3 保真 + 不造假）：
//  - 公式求值器为纯算术递归下降解析，无 eval / 无函数调用，仅消费传入的 params（atk/def/mag/...），
//    安全且可在战斗模拟器与真实战斗间共用同一套求值，保证"模拟=真实"。
//  - 防御减免仍由 Fighter.takeDamage(def*0.25) 统一承担；公式只表达"进攻侧"期望伤害，
//    编辑器可自由引用 tdef 做额外削减（如 atk*power - tdef*0.5），与 takeDamage 叠加由设计者决定。
//  - 默认公式与 config/formulas.json 中的公式并存：配置存在则优先，缺省回退到下面的 DEFAULT_FORMULAS，
//    因此即使不打开公式编辑器，战斗也照常运行（向后兼容）。

import { Config } from './globals.js?v=20261007c';

// ───────────────────────── 公式求值器 ─────────────────────────
// 支持：+ - * / % ^  (幂) 、一元负号 - 、括号 () 、小数、标识符(取 params)。
// 不支持函数调用/赋值/比较，避免注入风险。

function tokenizeFormula(expr) {
  const toks = [];
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (isDigit(c) || c === '.') {
      let num = '';
      while (i < expr.length && (isDigit(expr[i]) || expr[i] === '.')) { num += expr[i]; i++; }
      const v = parseFloat(num);
      if (isNaN(v)) throw new Error('无效数字: ' + num);
      toks.push({ t: 'num', v });
      continue;
    }
    if (isAlpha(c)) {
      let id = '';
      while (i < expr.length && (isAlpha(expr[i]) || isDigit(expr[i]))) { id += expr[i]; i++; }
      toks.push({ t: 'id', v: id });
      continue;
    }
    if ('+-*/%^()'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('公式含非法字符: "' + c + '"');
  }
  return toks;
}

// 调度场算法 → 逆波兰；支持一元负号（记为 'u-'）
function toRPN(toks) {
  const out = [];
  const ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, 'u-': 4 };
  const rightAssoc = { '^': true, 'u-': true };
  let prev = null; // 判断负号：运算符/左括号/(开头 之后的 - 是一元
  for (const tk of toks) {
    if (tk.t === 'num' || tk.t === 'id') {
      out.push(tk);
    } else if (tk.v === '(') {
      ops.push(tk);
    } else if (tk.v === ')') {
      while (ops.length && ops[ops.length - 1].v !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('括号不匹配');
      ops.pop(); // 丢弃 '('
    } else { // 运算符
      let op = tk.v;
      if (op === '-' && (prev === null || (prev.t === 'op' && prev.v !== ')') || (prev.t === 'op' && prev.v === '('))) {
        op = 'u-';
      } else if (op === '-' && prev.t === 'op' && prev.v === '(') {
        op = 'u-';
      }
      const o1 = op;
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t === 'op' && top.v === '(') break;
        const p1 = prec[o1], p2 = prec[top.v];
        if ((p2 > p1) || (p2 === p1 && !rightAssoc[o1])) out.push(ops.pop());
        else break;
      }
      ops.push({ t: 'op', v: o1 });
    }
    prev = tk;
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.v === '(' || top.v === ')') throw new Error('括号不匹配');
    out.push(top);
  }
  return out;
}

export function evalFormula(expr, params = {}) {
  if (!expr || !String(expr).trim()) return 0;
  let rpn;
  try { rpn = toRPN(tokenizeFormula(String(expr))); }
  catch (e) { console.warn('[rt] 公式解析失败，按 0 处理:', expr, e.message); return 0; }
  const stack = [];
  for (const tk of rpn) {
    if (tk.t === 'num') { stack.push(tk.v); continue; }
    if (tk.t === 'id') {
      const v = params[tk.v];
      stack.push((typeof v === 'number' && isFinite(v)) ? v : 0); // 未提供的参数按 0
      continue;
    }
    // 运算符
    if (tk.v === 'u-') {
      const a = stack.pop(); stack.push(-a);
    } else {
      const b = stack.pop(), a = stack.pop();
      if (a === undefined || b === undefined) { console.warn('[rt] 公式参数不足:', expr); return 0; }
      let r;
      switch (tk.v) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = b === 0 ? 0 : a / b; break;
        case '%': r = b === 0 ? 0 : a % b; break;
        case '^': r = Math.pow(a, b); break;
        default: r = 0;
      }
      stack.push(r);
    }
  }
  const res = stack.pop();
  return (typeof res === 'number' && isFinite(res)) ? res : 0;
}

// ───────────────────────── 默认公式（可被 config/formulas.json 覆盖）─────────────────────────
// 设计对齐原战斗代码：
//   技能:  Math.round(player.atk * rage * (s.power||1) + player.mag*0.3)
//   普攻:  Math.round(player.atk * rage * (0.9+rand*0.3))
//   敌方:  Math.round(eFig.atk * (0.85+rand*0.3))
//   召唤:  Math.round(ally.atk * (0.9+rand*0.3))
// rand 由调用方每击传入（0~1），使"平均伤害"与模拟器一致；设计者可在编辑器里改写这些公式。
export const DEFAULT_FORMULAS = {
  skill_damage: 'atk*rage*power + mag*0.3',
  magic_damage: 'mag*rage*power + atk*0.2',
  phys_damage:  'atk*rage*(0.9+0.3*rand)',
  enemy_damage: 'atk*(0.85+0.3*rand)',
  ally_damage:  'atk*(0.9+0.3*rand)'
};

export function getFormula(id) {
  const f = Config.data && Config.data.formulas && Config.data.formulas[id];
  if (f && f.expr) return f.expr;
  return DEFAULT_FORMULAS[id] || null;
}

// 战斗通用调参（非公式的标量，如暴击倍数）：config/combat.json 优先，缺省回退 DEFAULT_COMBAT。
// 让战斗数值可调，且即使不打开配置编辑器，战斗也照常运行（向后兼容）。
export const DEFAULT_COMBAT = { critMult: 1.5 };
export function getCombat(key, def) {
  const c = Config.data && Config.data.combat;
  if (c && c[key] != null) return c[key];
  if (DEFAULT_COMBAT[key] != null) return DEFAULT_COMBAT[key];
  return def;
}

// 统一伤害计算（不含防御减免，防御减免在 Fighter.takeDamage 内统一处理）
// opts: { power, rage, tdef, rand, formulaId }
export function calcDamage(attacker, defender, opts = {}) {
  const formulaId = opts.formulaId || 'phys_damage';
  const expr = getFormula(formulaId);
  if (!expr) {
    // 极端兜底：无公式也无默认 → 物理近似
    return Math.max(1, Math.round((attacker.atk || 1) * (opts.rage || 1) - (defender.def || 0) * 0.25));
  }
  const v = evalFormula(expr, {
    atk: attacker.atk || 0,
    def: attacker.def || 0,
    mag: attacker.mag || 0,
    spd: attacker.spd || 0,
    level: attacker.level || 1,
    rage: opts.rage || 1,
    power: opts.power != null ? opts.power : 1,
    tdef: defender.def || 0,
    rand: opts.rand != null ? opts.rand : Math.random()
  });
  return Math.max(1, Math.round(v));
}

// ───────────────────────── 掉落掷表（对齐掉落权重编辑器）─────────────────────────
// 规则：monsterId → 在 Config.data.drops 中找 source===monsterId 的掉落表（也可指向副本 dropRule）。
// 单条 {item, weight, qmin, qmax, bind, floor, rare}；按 weight 加权随机，命中则按[qmin,qmax]取数量。
// 返回 [{itemId, count, bind}]。bind: '否'->0 '是'->1 '随机'->随机0/1
export function getMonsterDrops(monsterId) {
  const D = Config.data || {};
  const drops = D.drops || {};
  let table = null;
  for (const id in drops) { if (drops[id].source === monsterId) { table = drops[id].table || []; break; } }
  return table; // 可能为 null（无掉落配置）
}

// 掷一张掉落表（数组）：按 weight 加权随机，命中取 [qmin,qmax] 数量；bind 处理。返回 [{itemId,count,bind}]
function rollDropTable(table) {
  if (!table || !table.length) return [];
  const D = Config.data || {};
  const items = D.items || {};
  const out = [];
  const total = table.reduce((s, r) => s + (Number(r.weight) || 1), 0);
  let roll = Math.random() * total;
  for (const r of table) {
    roll -= (Number(r.weight) || 1);
    if (roll <= 0) {
      const def = items[r.item];
      if (!def) continue; // 物品不存在则跳过（与一致性检测呼应）
      const qmin = Number(r.qmin) || 1, qmax = Number(r.qmax) || qmin;
      const count = qmin + Math.floor(Math.random() * (qmax - qmin + 1));
      let bind = 0;
      if (r.bind === '是') bind = 1;
      else if (r.bind === '随机') bind = Math.random() < 0.5 ? 1 : 0;
      out.push({ itemId: r.item, count, bind });
      break; // 单表每战只掷一次（如需多件可在表内放多条不同 item）
    }
  }
  return out;
}

export function rollDrops(monsterId) {
  return rollDropTable(getMonsterDrops(monsterId));
}

// 按掉落表 ID 掷表（副本 dropRule 引用 drops 域的某张表）
export function rollDropsByDropId(dropId) {
  const D = Config.data || {};
  const t = D.drops && D.drops[dropId] && D.drops[dropId].table;
  return rollDropTable(t);
}
