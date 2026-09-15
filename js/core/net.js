// net.js
// 对应 deobfuscated/net/*（RequestCommand / ServerConnection）
// 单机版没有真实服务器，这里用本地 mock 后台：requestCommand(cmd, data) 返回 Promise，
// 按命令字把 config/ 下的"后台数据"派发回去，并模拟网络延迟。便于日后替换为真实 HTTP/WebSocket。

import { Config } from './globals.js?v=20261007c';
import { gainCopper } from './money.js?v=20261007c';
// B6 统一角色生成器：怪物分两类（模板显式标志 fixedStats 判定）——
//   数值配置型直接用模板数值；资质型等级恒 1、属性全由「资质×成长率」公式派生、技能按数量概率表随机。
import { lookupChar, rollSkillPool, genUnit } from '../char/char-gen.js?v=20261007c';

export const CMD = {
  LOGIN:        'login',
  GET_MAP:      'get_map',
  GET_NPCS:     'get_npcs',
  GET_MONSTER:  'get_monster',
  BATTLE_END:   'battle_end',
  USE_ITEM:     'use_item',
  ACCEPT_QUEST: 'accept_quest',
  SUBMIT_QUEST: 'submit_quest',
  BATTLE_CATCH: 'battle_catch'    // CS_BATTLE_CATCH=38（RequestCommand.as::sendBattleCatch）
};

// ── 捕捉成功率口径（mock 服务端用）────────────────────────────────────────────────
// AS3 铁证：客户端【不做任何本地判定】—— BattleScene.as L356 只发 CS_BATTLE_CATCH=38（被点选敌人的 pid），
//   HandlerConnection05.receiveCatchResult 只按收到的 result 分叉演出（1=成功 / 0=失败）。
//   ⇒ 「成功率」在原版完全由服务器决定，客户端侧没有任何可参照的公式。
// 现有唯一带出处的线索：op688 威望商店 type=51 捕捉道具 desc ——「加强版」= 成功率为100%；
//   普通版 = 有一定的几率捕捉成功（具体数值未给出）。
//   ⚠ 但指令条「捕捉」按钮（BATTLE_CATCH）**不带道具参数** ⇒ 其成功率无任何出处。
// ⚠ 待用户裁决（见 _verify/PET_SYSTEM_STATUS.md 待办 P0）。此处 CATCH_FALLBACK_RATE 为**临时占位**，
//   仅为让功能可用；方案确定后只需改这一个常量，请勿把任何自造公式散到调用方。
const CATCH_FALLBACK_RATE = 0.5;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 未觉醒升级经验（config/level_exp.json，资料库数据表「天书奇谈-升级经验表」1-150 级）──
//   AS3 的 expMax 由服务端逐包下发（HandlerConnection22/26 读 bytes），客户端无表；
//   单机版以 config 表为服务端真源。表缺失时调用方回退旧的 ×1.35 兜底，保证不崩。
//   ★ 表语义（自然读法）：源表「累计总经验(N) = Σ table[2..N]」⇒ table[N] = 从 N−1 升到 N 所需经验。
//     故等级 L 的 expNext（升到 L+1 的成本）= table[L+1]；table[1]=0 仅为占位（cost(0→1) 不存在）。
// 公共升级口径（任务奖励 / 战斗奖励共用，避免两处口径漂移）
function expTableValue(level) {
  const t = Config.level_exp;
  const v = t && t.expNext && t.expNext[String(level)];
  return Number(v) || 0;          // 0 = 表缺失/该级未配
}
export function maxUnawakenedLevel() {
  const t = Config.level_exp;
  return Number(t && t.maxLevel) || 0;   // 0 = 表缺失，不封顶
}
/** 等级 level 升到 level+1 所需经验（= table[level+1]）。
 *  满级（level >= maxLevel）时返回 table[maxLevel] 仅作经验条分母，调用方不再升级；
 *  表缺失返回 0，由调用方回退 ×1.35 兜底。 */
export function expToNext(level) {
  const MAX = maxUnawakenedLevel();
  const lv = Number(level) || 0;
  if (MAX > 0 && lv >= MAX) return expTableValue(MAX);
  return expTableValue(lv + 1);
}

// 模拟服务端"存档"——战斗奖励会写回这里
const serverState = {
  player: null,
  quests: {}   // questId -> { accepted, progress, done }
};

export async function requestCommand(cmd, data = {}) {
  await delay(100 + Math.random() * 160); // 模拟 RTT
  switch (cmd) {
    case CMD.LOGIN: {
      serverState.player = JSON.parse(JSON.stringify(Config.player));
      return { ok: true, player: serverState.player, servers: Config.servers };
    }
    case CMD.GET_MAP: {
      const map = Config.maps.find(m => m.id === (data.mapId ?? 1)) || Config.maps[0];
      return { ok: true, map };
    }
    case CMD.GET_NPCS: {
      const npcs = Config.npcs.filter(n => (data.mapId ?? 1) === 1);
      return { ok: true, npcs };
    }
    case CMD.GET_MONSTER: {
      const monster = Config.monsters[data.monsterId];
      if (!monster) return { ok: false, msg: '怪物不存在' };
      const m = JSON.parse(JSON.stringify(monster));
      // ★ 怪物分两类（用户裁决 2026-10-04；模板显式标志 fixedStats 判定，不自动猜测——旧模板有脏数据）：
      //   1) 数值配置型（fixedStats:true）：直接用模板配的 level/hp/atk/def/mag/spd 等（BOSS / 测试木桩）；
      //   2) 资质型（默认）：等级恒 1，hp/攻防/速度全由「资质×成长率」公式派生（暗雷怪、宠物）。
      //   两类可同场混合；捕捉后的宠物一律走资质型（scene._grantCaughtPet 转换）。
      const fixed = m.fixedStats === true;
      let char = lookupChar(m.name);
      const baseName = m.name;
      // 无角色表记录的怪物：造同名合成记录（默认资质按等级缩放、不可捕捉）
      const char0 = char || { name: baseName, kind: 'monster', race: null, catchable: false, skillPool: [] };
      m.family = (char && char.name) || baseName;   // 家族=物种名，捕捉后同家族判定
      m.fixedStats = fixed;
      // ★ 挑衅话（用户裁决 2026-10-04）：真源迁到 chars.json 的 char 记录
      //   （taunt 台词数组 + tauntRate）；模板自带 taunt 作为兼容兜底（未迁移的旧数据仍能说话）。
      const tauntSrc = (char && Array.isArray(char.taunt) && char.taunt.length)
        ? char : (Array.isArray(m.taunt) && m.taunt.length ? m : null);
      if (tauntSrc) {
        m.taunt = tauntSrc.taunt.slice();
        if (tauntSrc.tauntRate != null) m.tauntRate = tauntSrc.tauntRate;
      }
      // 技能：模板显式 skills 优先（固定技能怪物）；模板完全没有 skills 键时才按 chars 技能池
      //   走数量概率表随机。⚠ 显式空数组 skills:[] = 「该怪无技能」——数值配置型（木桩/BOSS）
      //   要求模板数值即最终数值，不能被随机被动加成污染（如树桩的困难档 def 会被动 +5 万）。
      const fillSkills = !Array.isArray(m.skills);
      if (fixed) {
        // 数值配置型：模板数值即最终数值；等级取模板 level（缺省 1）
        m.level = Math.max(1, Math.floor(Number(m.level) || 1));
        if (m.mp == null) m.mp = 0;                 // 模板未配 mp 时补 0（ Fighter 侧不再有公式兜底）
        if (fillSkills) {
          const pool = rollSkillPool(char0.skillPool);
          if (pool.skills.length) { m.skills = pool.skills; m.skillLevels = pool.skillLevels; }
        }
      } else {
        // 资质型：等级恒 1，属性全由「资质×成长率」公式派生（抓包固定值废弃）
        m.level = 1;
        const unit = genUnit(char0, 1);
        m.hp = Math.max(1, Math.round(unit.derived.maxHp));
        m.mp = Math.max(0, Math.round(unit.derived.maxMp));
        m.atk = unit.derived.atk;  m.def = unit.derived.def;
        m.mag = unit.derived.mag;  m.magDef = unit.derived.magDef;
        m.spd = unit.derived.spd;  m.recover = unit.derived.recover;
        m.xiuwei = unit.derived.xiuwei;
        m.grade = unit.grade;           // 供面板/AI 显示与判定
        m.variant = unit.variant;
        m.growRate = unit.growRate;
        if (fillSkills && unit.skills && unit.skills.length) {
          m.skills = unit.skills;
          m.skillLevels = unit.skillLevels;
        }
      }
      return { ok: true, monster: m };
    }
    case CMD.BATTLE_END: {
      // data: { win, rewards:{exp,silver,item} }
      const p = serverState.player;
      if (!p) return { ok: false };
      const log = [];
      if (data.win && data.rewards) {
        p.exp += data.rewards.exp || 0;
        // silver/gold 字段单位=两；money 模块按「两×1000+文」两级入库（op102 价格单位是文）
        gainCopper(p, 'silver', (Number(data.rewards.silver) || 0) * 1000);
        gainCopper(p, 'gold', (Number(data.rewards.gold) || 0) * 1000);
        const MAX_LV = maxUnawakenedLevel();   // 未觉醒满级（150；151+ 只有觉醒表，本次不配）
        let leveled = false;
        while (p.exp >= p.expNext) {        // 升级
          if (MAX_LV > 0 && p.level >= MAX_LV) break;  // 满级封顶：经验不再消耗、不再升级
          p.exp -= p.expNext;
          p.level += 1;
          const nx = expToNext(p.level);
          p.expNext = nx > 0 ? nx : Math.round(p.expNext * 1.35);  // 有表用表，无表回退旧兜底
          leveled = true;
          log.push('升级！当前 Lv.' + p.level);
        }
        // ★ aw：属性公式驱动 ⇒ 服务端不再改 hp/atk；客户端据 leveled 标记按新等级重算
        if (leveled) log.push('__leveled__');
        if (data.rewards.items && data.rewards.items.length) {
          data.rewards.items.forEach(it => {
            const exist = p.bag.find(b => b.itemId === it.itemId);
            if (exist) exist.count += (Number(it.count) || 1);
            else p.bag.push({ itemId: it.itemId, count: Number(it.count) || 1, bind: it.bind });
          });
        } else if (data.rewards.item && !p.bag.find(b => b.itemId === data.rewards.item)) {
          p.bag.push({ itemId: data.rewards.item, count: 1 });
        }
      }
      return { ok: true, player: p, log };
    }
    case CMD.USE_ITEM: {
      const p = serverState.player;
      const it = Config.items[data.itemId];
      if (!p || !it) return { ok: false };
      if (it.effect.hp) p.hp = Math.min(p.maxHp || p.hp + it.effect.hp, p.hp + it.effect.hp);
      if (it.effect.mp) p.mp = Math.min(p.maxMp || p.mp + it.effect.mp, p.mp + it.effect.mp);
      // 扣道具
      const slot = p.bag.find(b => b.itemId === data.itemId);
      if (slot) { slot.count -= 1; if (slot.count <= 0) p.bag = p.bag.filter(b => b !== slot); }
      return { ok: true, player: p };
    }
    case CMD.ACCEPT_QUEST: {
      serverState.quests[data.questId] = { accepted: true, progress: 0, done: false };
      return { ok: true, quest: serverState.quests[data.questId] };
    }
    case CMD.SUBMIT_QUEST: {
      const q = serverState.quests[data.questId];
      if (q) { q.done = true; }
      return { ok: true, quest: q };
    }
    case CMD.BATTLE_CATCH: {
      // CS_BATTLE_CATCH=38 → 判定 → SC_CATCH_RESULT=54
      //   data: { attackerPos, defenderPos, monsterId, npcId, name, hp, hpMax }
      //   SC_CATCH_RESULT 字段顺序（HandlerConnection05.as::receiveCatchResult）：
      //     attackerPos(short) → defenderPos(short) → result(int) → changeMp(int) → skillImageId(string)
      //   并置 effectTime=3000（演出总时长，真源即此处，不是 BattleInitializer19 自身）
      const tpl = (data.monsterId != null) ? (Config.monsters || {})[data.monsterId] : null;
      let rate = CATCH_FALLBACK_RATE, rateSource = 'CATCH_FALLBACK_RATE(待裁决)';
      // 怪物模板若显式带 catchRate（0..1 或 0..100 百分数）则优先采用 —— 有出处才用，无则回落
      if (tpl && tpl.catchRate != null && Number.isFinite(Number(tpl.catchRate))) {
        const r = Number(tpl.catchRate);
        rate = r > 1 ? r / 100 : r;
        rateSource = 'monsters[' + data.monsterId + '].catchRate';
      }
      const result = (Math.random() < rate) ? 1 : 0;
      return {
        ok: true,
        attackerPos: data.attackerPos,
        defenderPos: data.defenderPos,
        result,                       // 1=成功 / 0=失败（客户端仅据此分叉）
        changeMp: 0,                  // 捕捉成功回蓝：AS3 由服务器下发，数值无出处 ⇒ 0（0 值飘字不显示）
        skillImageId: 'catch',        // 特效资源名（BattleInitializer19 用 GlobalsLoader.getCharacter("catch")）
        effectTime: 3000,             // 演出总时长（receiveCatchResult 写死值）
        rate, rateSource              // 判定依据（供日志/探针核对，不参与演出）
      };
    }
    default:
      return { ok: false, msg: '未知命令: ' + cmd };
  }
}

export function getServerPlayer() { return serverState.player; }
