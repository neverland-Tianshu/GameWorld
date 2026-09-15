/**
 * js/quest/talk.js —— TalkPanel（对话/任务面板）子系统
 *
 * 对齐 AS3：
 *   panel/task/TalkPanel.as          —— 7 个交互阶段的状态机（updatePanel）
 *   panel/task/TalkRight.as          —— 右侧任务列表（3 分组：功能/可接/已接）
 *   panel/task/DescTaskPanel.as      —— 任务描述子面板（难度星/等级/正文/奖励）
 *   panel/task/FinishItem.as         —— 可选奖励网格（点击选中，currItemId）
 *   panel/task/EquipItemPanel.as     —— 上交装备单格
 *   panel/task/TaskContribution.as   —— 帮派贡献
 *   net/handler/HandlerHandler02.as  —— SC 解包字段顺序（权威）+ 派发序列（权威）
 *   net/RequestCommand.as            —— CS 封包字段顺序（权威）
 *
 * 铁律：
 *   ① 所有 SC 由本地 mock 应答，任一分支都不 reject（单机不假死）。
 *   ② 抓包没覆盖的字段一律留空/标「待逆向」，绝不臆造数值。
 *   ③ 只碰任务/对话，不碰任何战斗代码。
 */
import { Config } from '../core/globals.js?v=20261007c';
import { panelManager } from '../ui/panel-manager.js?v=20261007c';
import { inventory } from '../item/inventory.js?v=20261007c';
import { booted as inventoryBooted, commit as inventoryCommit } from '../item/player-bridge.js?v=20261007c';
import { gainCopper } from '../core/money.js?v=20261007c';
import { applyPlayerAttrs } from '../char/char-gen.js?v=20261007c';
import { expToNext, maxUnawakenedLevel } from '../core/net.js?v=20261007c';
import { fireEvent as questFireEvent } from './quest-actions.js?v=20261007c';

const CFG = () => Config.talk || {};
const STG = () => CFG().stage || {};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** 阶段常量（GlobalsGlobal08） */
export const S = {
  LIST: 1, DESCRIBE: 2, OVER: 3, PROCESS: 4, DIAGNOSES: 5, CARRYOVER: 6, GANG: 7, CHAT: 8,
};
/** 任务动作（GlobalsGlobal08.TASK_ACCEPTID_*） */
export const ACT = { ACCEPTED: 0, OVER: 1, GOON: 2 };
/** 节点类型（任务流程改造：节点化框架预留） */
export const NODE_TYPE = {
  TALK: 'talk',       // 对话（接取/交付均走对话）
  QUIZ: 'quiz',       // 答题（S.DIAGNOSES，待逆向）
  SUBMIT_ITEM: 'submitItem', // 提交物品（装备上交，待逆向）
  SUBMIT_PET: 'submitPet',   // 提交宠物（待逆向）
  CHALLENGE: 'challenge',    // 挑战（对话窗出「挑战它/稍作准备」，挑战它→进入战斗）
  FINISH: 'finish',     // 完成（纯交付节点）
};
/** nodeType 合法值集合（makeTaskObj 兜底用） */
const VALID_NODE_TYPE = new Set(Object.values(NODE_TYPE));

/* ══════════════════════════ 数据模型 ══════════════════════════ */

/** 对应 AS3 panel.task.data.TaskObj（33 字段；抓包缺的留空） */
export function makeTaskObj(o = {}) {
  return {
    taskId: String(o.taskId ?? ''),
    npcId: num(o.npcId), npcName: String(o.npcName ?? ''), npcImg: String(o.npcImg ?? ''),
    title: String(o.title ?? ''), desc: String(o.desc ?? ''), target: String(o.target ?? ''),
    showAccept: num(o.showAccept), finish: num(o.finish), status: String(o.status ?? ''),
    level: String(o.level ?? ''), kuozhan: String(o.kuozhan ?? ''),
    difficulty: num(o.difficulty, 1), condignLevel: num(o.condignLevel),
    conditionItem: String(o.conditionItem ?? ''), finishNpc: String(o.finishNpc ?? ''),
    infoType: num(o.infoType), bonusCoin: String(o.bonusCoin ?? ''), bonusExp: num(o.bonusExp),
    bonusItemNum: num(o.bonusItemNum), bonusItem: Array.isArray(o.bonusItem) ? o.bonusItem : [],
    time: num(o.time), times: String(o.times ?? ''), bonusRep: num(o.bonusRep), bonusAct: num(o.bonusAct),
    costNotice: String(o.costNotice ?? ''),
    choiceItem: Array.isArray(o.choiceItem) ? o.choiceItem : [], choiceItemNum: num(o.choiceItemNum),
    memberList: String(o.memberList ?? ''), giveUp: num(o.giveUp), thread: String(o.thread ?? ''),
    // op30 抓包字段（6.5 节并入 talk.json；AS3 TaskObj 无对应字段，仅单机版展示用）
    story: String(o.story ?? ''), rewardText: String(o.rewardText ?? ''),
    location: String(o.location ?? ''), npcDesc: String(o.npcDesc ?? ''),
    // 任务流程改造（重做）：nodeType 节点类型 + phase 阶段标记 + 输出语句 storyAccept/storyFinish/rewardLine
    //   （编辑器可配，空=运行时回退节点 story/默认模板；奖励 rewardLine 空=自动生成清单）
    //   nodes = 节点框架 [{phase, story, nodeType, storyAccept, storyFinish}]，交付小窗正文取 nodes[1].story
    nodeType: VALID_NODE_TYPE.has(String(o.nodeType)) ? String(o.nodeType) : NODE_TYPE.TALK,
    phase: num(o.phase) || 0,
    storyAccept: String(o.storyAccept ?? ''), storyFinish: String(o.storyFinish ?? ''),
    rewardLine: String(o.rewardLine ?? ''),
    // 兼容旧数据：finishStory = 交付节点 NPC 描述（nodes[1].story 缺失时兜底）
    finishStory: String(o.finishStory ?? ''),
    // 交付 NPC（op30 type1 发包 NPC，数字直存），优先于 finishNpc 超链接解析
    finishNpcId: num(o.finishNpcId) || null,
  };
}

export class TalkState {
  constructor() {
    this.stage = 0;              // curPanel
    this.npcId = 0;
    this.npcName = '';
    this.npcImg = '';
    this.taskId = '';
    this.tag = '';               // 问答 tag
    this.options = [];           // 选项按钮（挑战对话的 ◆挑战它/◆.稍作准备，DIAGNOSES 阶段渲染）
    this.content = '';           // contentArea.htmlText
    this.contentInteractive = false;
    this.taskObj = null;         // 当前查看的 TaskObj
    this.taskOver = false;       // PROCESS 小窗是否为「交付任务」模式（按钮改「完成任务」）
    this.groups = [];            // [DataClass02 × 3]
    this.equipIndex = -1;        // 上交装备格（EquipItemPanel 单格）
    this.choiceSel = -1;         // FinishItem.currItemId
    this.accepted = new Set();   // 已接任务 id
    this.finished = new Set();   // 已完成
    // ★ 杀怪条件进度：taskId -> Map<怪物名, {got, need}>
    //   真源 = op62 conditionItem（如「雪噬灵 (0/1),火噬灵 (0/1),魅惑噬灵 (0/1),」）。
    //   接取时解析注册；addKill(怪物名) 推进度；全部满额 ⇒ 该任务在交付 NPC 处变「可交付」；
    //   交付/弃任务时清掉。本系为通用框架，不局限天音洞。
    this.kills = new Map();
    this.contrib = null;         // 帮派贡献面板数据
    this.log = [];               // 协议流水（调试用）
  }

  get acceptedCount() { return this.accepted.size; }

  /** 解析 conditionItem 的杀怪条目（形如「雪噬灵 (0/1),火噬灵 (0/1)」），返回 [{name,need}]。
   *  非此格式（道具名/空）返回 []。⚠ 只认带括号进度元组的条目，避免误吞道具条件。 */
  static parseKillConds(conditionItem) {
    const s = String(conditionItem || '').trim();
    if (!s) return [];
    const out = [];
    for (const part of s.split(',')) {
      const m = /^\s*(.+?)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/.exec(part);
      if (m) out.push({ name: m[1].trim(), got: Number(m[2]), need: Number(m[3]) });
    }
    return out;
  }

  /** 注册某任务的杀怪进度（接取时调）。无杀怪条件的任务不建表。
   *  skipNames：已登记为「物品条件」的名字（见 regItems），杀怪表要跳过，
   *  否则同名条目会被 regItems 覆盖或反过来（同一名字只能有一种语义）。 */
  regKills(taskId, conditionItem, skipNames) {
    const conds = TalkState.parseKillConds(conditionItem);
    if (!conds.length) return;
    const skip = (skipNames instanceof Set) ? skipNames : null;
    const m = new Map();
    for (const c of conds) {
      if (skip && skip.has(c.name)) continue;             // 物品条件，交给 regItems
      m.set(c.name, { got: 0, need: c.need || 1 });
    }
    if (m.size) this.kills.set(String(taskId), m);
  }

  /** 注册某任务的「物品提交」条件（接取时调）。
   *  conditionItems = [{id, num, name}]（config/talk.json 显式标注；id = Config.items 的 key）。
   *  ⚠ 物品与杀怪共用同一张 kills 表（条目形如「貂涎花瓣 0/1」），显示/追踪口径完全一致；
   *    got 不由 addKill 推进，而是实时取背包数量（见 syncItemGot）。
   *  ⚠ 自动分类「名字是物品还是怪物」不可靠（sqlite 物品表不全），所以必须显式配置。 */
  regItems(taskId, conditionItems) {
    const list = Array.isArray(conditionItems) ? conditionItems : [];
    if (!list.length) return;
    let m = this.kills.get(String(taskId));
    if (!m) { m = new Map(); this.kills.set(String(taskId), m); }
    for (const c of list) {
      const id = String((c && (c.id || c.itemId)) || '');
      const need = Math.max(1, Number((c && (c.num || c.need)) || 1) || 1);
      const name = String((c && c.name) || '').trim() || id;
      if (!id) continue;
      m.set(name, { got: 0, need, item: id });
    }
  }

  /** 按背包实时重算全部物品条件的 got（clamp 到 need）。
   *  拾取/消耗物品后由 ts-inventory-changed 事件触发；killsDone/killsText 也会先调一次兜底。 */
  syncItemGot() {
    if (!this.kills.size) return;
    const inv = (typeof inventory === 'function') ? inventory() : null;
    if (!inv || typeof inv.countOf !== 'function') return;
    for (const m of this.kills.values()) {
      for (const v of m.values()) {
        if (!v.item) continue;
        const have = Math.max(0, Number(inv.countOf(v.item)) || 0);
        v.got = Math.min(have, v.need);
      }
    }
  }

  /** 清掉某任务的杀怪/物品进度（交付/弃任务时调） */
  clearKills(taskId) { this.kills.delete(String(taskId)); }

  /** 该任务的条件是否全部满足（无表/全满 ⇒ true）。先同步一次物品进度，保证判定是实时的。 */
  killsDone(taskId) {
    this.syncItemGot();
    const m = this.kills.get(String(taskId));
    if (!m) return true;
    for (const v of m.values()) if (v.got < v.need) return false;
    return true;
  }
  /** 该任务的条件进度文本（任务追踪栏用），无表返回 '' */
  killsText(taskId) {
    this.syncItemGot();
    const m = this.kills.get(String(taskId));
    if (!m || !m.size) return '';
    return [...m.entries()].map(([n, v]) => `${n} ${v.got}/${v.need}`).join('、');
  }

  /** 击杀怪物推进度（BattleScene._awardKill 调）。
   *  返回本次推进的任务 id 数组（供调用方刷新标记/追踪）。怪物名按 Config.monsters.name 匹配。
   *  ⚠ 物品条件（v.item）不参与击杀推进——它的进度来自背包。 */
  addKill(monsterName) {
    const name = String(monsterName || '').trim();
    if (!name) return [];
    const advanced = [];
    for (const [tid, m] of this.kills) {
      if (this.finished.has(tid)) continue;
      const cur = m.get(name);
      if (!cur || cur.item || cur.got >= cur.need) continue;
      cur.got++;
      advanced.push(tid);
    }
    return advanced;
  }
  /** 取某任务未完成的杀怪条目（挑战标记/追踪用）。物品条件不算挑战目标。 */
  killTargets(taskId) {
    const m = this.kills.get(String(taskId));
    if (!m) return [];
    return [...m.entries()].filter(([, v]) => !v.item && v.got < v.need).map(([n]) => n);
  }

  /** 取某任务的物品提交条件（面板/追踪/探针用）：[{item, name, got, need}] */
  itemConds(taskId) {
    const m = this.kills.get(String(taskId));
    if (!m) return [];
    this.syncItemGot();
    return [...m.entries()].filter(([, v]) => v.item).map(([name, v]) => ({ item: v.item, name, got: v.got, need: v.need }));
  }

  /** 交付时扣掉全部物品条件所需的道具（调用方已保证 killsDone）。
   *  返回实际扣除清单 [{name, num}]，供聊天窗「提交了 XXX×N」提示。 */
  consumeItems(taskId) {
    const m = this.kills.get(String(taskId));
    if (!m) return [];
    const inv = (typeof inventory === 'function') ? inventory() : null;
    const out = [];
    for (const [name, v] of m.entries()) {
      if (!v.item || !inv || typeof inv.removeItemById !== 'function') continue;
      const r = inv.removeItemById(v.item, v.need);
      if (r && r.ok) out.push({ name, num: v.need });
    }
    return out;
  }

  logPush(dir, op, note) { this.log.push({ dir, op, note, t: Date.now() }); if (this.log.length > 200) this.log.shift(); }
}

/* ══════════════════════════ Mock 服务端 ══════════════════════════ */

export class TalkNet {
  constructor(state) { this.state = state; this._handlers = []; }

  /** 注册 SC 派发监听（面板实现；语义等价 HandlerManager.register） */
  on(fn) { this._handlers.push(fn); return () => { this._handlers = this._handlers.filter((f) => f !== fn); }; }
  _emit(op, pkt) { for (const f of this._handlers) { try { f(op, pkt); } catch (e) { console.warn('[talk] SC 派发异常', op, e); } } }

  _data() { return (CFG().data || {}); }
  _proto() { return (CFG().proto || {}); }

  _talkOf(npcId) {
    const t = (this._data().talks || []).find((x) => x.npcId === npcId);
    return t || null;
  }
  _taskOf(taskId) {
    return (this._data().tasks || []).find((x) => String(x.taskId) === String(taskId)) || null;
  }
  _funcEntryOf(npcId) {
    return (this._data().functions || []).find((x) => x.npcId === npcId) || null;
  }
  /** 头像 key（= op29/op31 npcHeadId；对齐 AS3 updateheader 首参）。缺抓包样本时退回 npcId */
  _headOf(npcId) {
    const talk = this._talkOf(npcId);
    if (talk && talk.npcHeadId) return String(talk.npcHeadId);
    const fn = this._funcEntryOf(npcId);
    if (fn && fn.npcHeadId) return String(fn.npcHeadId);
    return String(npcId);
  }
  /** finishNpc 名字 → npcId 反向索引（talks 的 npcId→npcName 反查）。
   *  ⚠ 同名 NPC 取「与接取人不同 id」者（跨 NPC 交付语义上必然是另一个人），
   *    都同名则取最小 id。talks 没覆盖的名字再退 Config.data.npcs。 */
  static _NAME2NPC_CACHE = { ver: null, map: null };
  _finishNpcByName(name, task) {
    if (!name) return null;
    const d = this._data();
    const talks = (d && d.talks) || [];
    // Config.data.npcs 不是每次都稳定可比，talks 是任务配置自带的主数据源
    let m = TalkNet._NAME2NPC_CACHE.map;
    if (!m || TalkNet._NAME2NPC_CACHE.ver !== talks.length) {
      m = new Map();
      for (const tk of talks) {
        const nm = String((tk && tk.npcName) || '').trim();
        if (!nm || tk.npcId == null) continue;
        if (!m.has(nm)) m.set(nm, []);
        m.get(nm).push(Number(tk.npcId));
      }
      TalkNet._NAME2NPC_CACHE = { ver: talks.length, map: m };
    }
    const cands = m.get(name);
    if (cands && cands.length) {
      const selfId = Number((task && task.npcId) || 0);
      const diff = cands.filter((id) => id !== selfId);
      return Math.min(...(diff.length ? diff : cands));
    }
    return null;
  }

  /** 从任务 finishNpc（desc 超链接 event:x:..,y:..,m:..,n:NNN）解出交付 NPC id；
   *  抓不到（纯名字 / 给=交同一人）时回退任务自身 npcId。与 npc-quest-mark.finishNpcIdOf 同口径。 */
  _finishNpcIdOf(t) {
    if (!t) return null;
    // 节点合并：finishNpcId 为数字直存（op30 type1 发包 NPC），优先于 finishNpc 超链接解析
    if (t.finishNpcId != null && Number.isFinite(Number(t.finishNpcId)) && Number(t.finishNpcId) > 0) return Number(t.finishNpcId);
    const str = String((t && t.finishNpc) || '');
    let m = /[,;]n:(\d+)/.exec(str);
    if (!m) m = /\bn:(\d+)/.exec(str);
    if (m) return Number(m[1]);
    // ★ 纯名字（如「刘丰」）反查 talks 名字→id；查不到才回退任务自身 npcId。
    //   ⚠ 回退 npcId 会让「A 接 / B 交」的任务错把 A 当交付人（用户报的 BUG 2/3/4 根因）。
    const nm = str.trim();
    if (nm && !/[<,;:]/.test(nm)) {
      const byName = this._finishNpcByName(nm, t);
      if (byName != null && byName > 0) return byName;
    }
    return (t.npcId != null && String(t.npcId) !== '') ? Number(t.npcId) : null;
  }

  _funcListOf(npcId) {
    const f = (this._data().functions || []).find((x) => x.npcId === npcId);
    return f ? (f.funcs || []) : [];
  }
  _funcOf(npcId, funcId) {
    return this._funcListOf(npcId).find((f) => String(f.taskId) === String(funcId)) || null;
  }
  _listTaskOf(taskId) {
    return (this._data().listTasks || []).find((x) => String(x.taskId) === String(taskId)) || null;
  }

  /* ─────────── CS 入口（RequestCommand 字段顺序对齐） ─────────── */

  /** CS_CLICK_NPC(22) → SC_SHOW_TASK_LIST(29) + open() */
  // ctx = { dialog, desc, hubTeleport, npcName }：scene._openTalk 从地图 npcData 带入。
  //   talk.json 未覆盖的 NPC（如 无涯子）用 dialog 兜底进闲聊阶段；hub 传送（蟠龙图腾）
  //   合成「打开世界地图」功能条目——旧版 ui.showDialog 已删除，全部走新交谈面板。
  clickNpc(npcId, ctx) {
    const P = this._proto();
    const st = this.state;
    st.logPush('CS', P.CS_CLICK_NPC, 'npcId=' + npcId);
    ctx = ctx || {};
    const talk = this._talkOf(npcId);
    const d = this._data();
    // NPC 功能（op29 抓包 taskState=-1 条目：商店/治疗/仓库等）：单机版由面板本地路由，
    //   taskId 命名空间 'F'+原 id，避免与真实任务 id 冲突；恒落入「功能」分组。
    const fnEntry = this._funcEntryOf(npcId);
    const fn = fnEntry ? fnEntry.funcs : [];
    // ★ 列表按 base 合并（.1/.2 节点已在配置层合并为单条 base 任务，见 gen_talk_cfg 6.3a）：
    //   已完成 → 不出行；已接 → 在交付 NPC 处出「可交付」行、在接取 NPC 处出「继续」行；
    //   未接 → 仅接取 NPC 且前置满足才出「可接」行。任务名/图标取 listTasks 抓包行（更准）。
    const ltByBase = new Map();
    for (const lt of (d.listTasks || [])) ltByBase.set(String(lt.taskId), lt);
    const at = Number(npcId);
    const rowSeen = new Set();
    const list = [];
    for (const t of (d.tasks || [])) {
      const base = String(t.taskId);
      if (rowSeen.has(base)) continue;
      rowSeen.add(base);
      if (st.finished.has(base)) continue;                 // 已完成：不出行
      const acceptNpc = Number(t.npcId) || 0;
      const finId = this._finishNpcIdOf(t);
      const fin = (finId != null && finId > 0) ? finId : acceptNpc;
      const lt = ltByBase.get(base);
      const taskName = (lt && (lt.taskName || lt.title)) || t.taskName || t.title || ('任务 ' + base);
      const icon = String((lt && lt.icon) || t.icon || '');
      if (st.accepted.has(base)) {
        // ★ 杀怪条件未满 ⇒ 即使在交付 NPC 处也不出「可交付」（对齐原服 op29 的 taskFinish 判定）
        const canFinish = st.killsDone(base);
        if (canFinish && fin === at) list.push({ taskName, taskId: base, taskState: 1, icon, taskFinish: 1 });      // 可交付
        else if (acceptNpc === at) list.push({ taskName, taskId: base, taskState: 1, icon, taskFinish: 0 });         // 继续（同分组）
        // ★ 挑战行（nodeType=challenge 节点）：已接未完成 + 本 NPC 是该任务的挑战目标，
        //   且对应怪物尚未杀够 ⇒ 追加「挑战：怪物名」行。
        //   taskId = base + '@C' + phase（@C 标记交 selectTask 走挑战分发，避免与交付/继续行冲突）。
        //   ⚠ 同一任务的多个挑战 NPC 各自出条目（3 boss 并行的语义），全部共享同一 base 任务的击杀对话。
        if (!st.finished.has(base)) {
          for (const cn of this._challengeNodes(t)) {
            if (Number(cn.npcId) !== at) continue;
            const mn = String(cn.monster || '');
            if (!st.killTargets(base).includes(mn)) continue;     // 已杀够 ⇒ 不再出挑战行
            list.push({ taskName: '挑战：' + (mn || taskName), taskId: base + '@C' + Number(cn.phase), taskState: 1, icon, taskFinish: 0 });
          }
        }
      } else if (acceptNpc === at && this._preTaskOk(t) && !this._mutexBlocked(t)) {
        list.push({ taskName, taskId: base, taskState: 0, icon, taskFinish: 0 });                             // 可接
      }
    }
    const npcName = talk ? talk.npcName : (fnEntry && fnEntry.npcName) || (list[0] && list[0].taskName) || ctx.npcName || ('NPC ' + npcId);
    // 头像 key：对齐 AS3 TalkPanel.updateheader(_loc4_=npcHeadId, name) —— SC_SHOW_TASK_LIST /
    //   SC_SHOW_TALK_DLG 的第 3 字段才是头像资源 id（如 兑奖天尊 npcId=1043 → npcHeadId=202019），
    //   直接用 npcId 会拼出 Portrait_001043.png（不存在）。缺抓包 head 时才退回 npcId。
    const npcImg = String((talk && talk.npcHeadId) || (fnEntry && fnEntry.npcHeadId) || npcId);
    // hub 传送（teleport_mode=hub）：合成「打开世界地图」功能条目，跟功能条目同走 'F' 命名空间。
    this._hubFn = ctx.hubTeleport ? { npcId, funcId: 'WORLDMAP', taskName: '打开世界地图' } : null;
    const hubFn = this._hubFn ? [{ taskName: this._hubFn.taskName, taskId: 'F' + this._hubFn.funcId, taskState: -1, icon: '', taskFinish: 0 }] : [];
    // ★ 挑战行与「继续」行去重（用户 bug③）：同一任务既在本 NPC 出「继续」行、又出
    //   「挑战：X」行（接取人=挑战目标同一 NPC，如「装腔作势的噬灵」）时，「继续」行冗余
    //   （挑战本身就是继续），并列两条会让玩家疑惑点哪条、且出现「没接过的 挑战xx 任务」。
    const chBases = new Set();
    for (const r of list) { const ci = this._parseChallengeTaskId(r.taskId); if (ci) chBases.add(ci.base); }
    if (chBases.size) {
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (chBases.has(String(r.taskId)) && !this._parseChallengeTaskId(r.taskId) && num(r.taskFinish, 0) === 0) list.splice(i, 1);
      }
    }
    // ★ 去重后本 NPC 只剩一条挑战行、且无功能/世界地图条目 → 直接派发挑战选择对话框，
    //   不再列任务清单（用户要求：挑战节点点 NPC 直接弹出挑战选择）。
    if (list.length === 1 && !fn.length && !hubFn.length && this._parseChallengeTaskId(list[0].taskId)) {
      this.selectTask(npcId, list[0].taskId);
      return;
    }
    // 兜底正文：地图 npcData.dialog；hub 传送无 dialog 时退到 desc（蟠龙图腾 desc=「开启传送点」）
    const ctxText = String((ctx.dialog || (ctx.hubTeleport ? ctx.desc : '')) || '').trim();
    const hasContent = !!(talk || (fnEntry && fnEntry.talkText));
    // ★ 真三无（无正文、无功能、无任务、无地图兜底）：不弹空面板、不用全表样本占位。
    //   派发 _empty，面板收到后直接关闭并 toast，不给空列表单独占一栏。
    if (!hasContent && !list.length && !fn.length && !hubFn.length && !ctxText) {
      this._emit('SC_SHOW_TASK_LIST', {
        npcId, npcName, npcImg: npcImg, npcDesc: '',
        content: '', tasks: [], _empty: true,
      });
      return;
    }
    // ★ 无抓包数据、但有地图配的闲聊文本（如 无涯子）：走闲聊阶段（PROCESS），不弹空任务列表占一栏。
    //   hub 传送即便无文本也要进列表阶段（要露出「打开世界地图」入口）。
    if (!hasContent && !list.length && !fn.length && !ctx.hubTeleport && ctxText) {
      this._emit('SC_SHOW_TALK_DLG', {
        npcId, npcName, npcImg: npcImg, content: ctxText,
      });
      return;
    }
    // 正文优先级：NPC 对话样本 > 功能抓包 talkText（商店/治疗 NPC 的台词只出现在 op29）> 地图兜底文本
    const content = talk ? talk.text : ((fnEntry && fnEntry.talkText) || ctxText);
    this._emit('SC_SHOW_TASK_LIST', {
      npcId, npcName, npcImg: npcImg, npcDesc: '',
      content,
      // list 已按 base 合并并带运行期 taskState（见上方构造）；功能条目走 'F' 命名空间
      tasks: list.map((t) => ({
        taskName: t.taskName, taskId: String(t.taskId),
        taskState: num(t.taskState, 0), icon: String(t.icon || ''), taskFinish: num(t.taskFinish, 0),
      })).concat(fn.map((f) => ({
        taskName: f.taskName,
        taskId: 'F' + String(f.taskId),
        taskState: -1,
        icon: String(f.icon || ''),
        taskFinish: 0,
      }))).concat(hubFn),
    });
  }

  /** CS_SELECT_TASK(23) → SC_SHOW_TASK_DLG(30) */
  selectTask(npcId, taskId) {
    const P = this._proto();
    this.state.logPush('CS', P.CS_SELECT_TASK, 'npcId=' + npcId + ' taskId=' + taskId);
    // 功能条目（商店/治疗/仓库等）：AS3 由服务端响应打开对应功能面板；单机版派发 SC_NPC_FUNCTION
    //   交 TalkPanel 本地路由（店类→npcshop、治疗→回满、仓库→bag，其余 toast 待接入）。
    if (String(taskId).startsWith('F')) {
      const fn = this._funcOf(npcId, String(taskId).slice(1));
      if (fn) {
        this._emit('SC_NPC_FUNCTION', {
          npcId, taskId: String(taskId), funcId: String(fn.taskId),
          taskName: fn.taskName, icon: String(fn.icon || ''),
          // ★ 功能条目可挂 teleport（如诸葛庭「进入天音洞上层」→ 1001），由面板 _doFunction 路由传送。
          //   x/y 为 op85 抓包真源落点（与目标图默认出生点可能不同），一并透传给 changeMap 作 spawnPos。
          teleport: (fn.teleport && fn.teleport.mapId) ? {
            mapId: Number(fn.teleport.mapId),
            x: Number.isFinite(Number(fn.teleport.x)) ? Number(fn.teleport.x) : null,
            y: Number.isFinite(Number(fn.teleport.y)) ? Number(fn.teleport.y) : null,
          } : null,
        });
        return;
      }
      // hub 传送合成的「打开世界地图」条目：派发功能事件，交 TalkPanel 本地打开世界地图面板。
      if (this._hubFn && this._hubFn.npcId === npcId && String(taskId) === 'F' + this._hubFn.funcId) {
        this._emit('SC_NPC_FUNCTION', {
          npcId, taskId: String(taskId), funcId: this._hubFn.funcId,
          taskName: this._hubFn.taskName, icon: '',
        });
        return;
      }
    }
    const raw = this._taskOf(taskId);
    // ★ 挑战行（taskId='base@Cphase'）：派发挑战对话（S.DIAGNOSES + 「◆挑战它 / ◆.稍作准备」两选项），
    //   不走普通任务详情。多个挑战 NPC 共享同一 base 任务 ⇒ 对话文案取该 phase 节点的 story。
    const chInfo = this._parseChallengeTaskId(taskId);
    if (chInfo) {
      const craw = this._taskOf(chInfo.base);
      const cnode = craw && this._challengeNodes(craw).find((n) => Number(n.phase) === chInfo.phase);
      if (!cnode) { this._emit('SC_TALK_CLOSE', {}); return; }
      const cName = this._npcNameOf(npcId, craw);
      const monster = String(cnode.monster || '');
      // ★ 战前询问文案：节点的 story 是【击败后】文案（如「地上只剩下一堆雪粉。」），
      //   战前弹它会剧透（用户 bug②/③）。战前用 ask（可配的战前台词），未配则兜底
      //   「是否挑战 X？」；击败后文案改由 onKillAdvanced 在该怪物杀够时播（见下方）。
      const ask = String((cnode.ask != null ? cnode.ask : cnode.storyAsk) || '').trim();
      this._emit('SC_SHOW_OPTION_DLG', {
        npcId, npcName: cName, npcImg: this._headOf(npcId),
        tag: 'challenge:' + chInfo.base + ':' + chInfo.phase,
        taskId: chInfo.base,
        content: ask || ('是否挑战 ' + esc2(monster) + '？'),
        // ★ 选项文案按 boss 定制（op30 field13/field14 抓包真源）：
        //   蜃龙=「◆无论如何先让他安静下来/◆.我也无能为力啊」、五石柱=「◆打破噩梦/◆.我还要等一下」、
        //   刘丰=「◆刘大侠。。。。我准备好了/◆.我还需要准备一下」，3 小噬灵=「◆挑战它/◆.稍作准备」。
        //   节点未配 optA ⇒ 兜底默认「◆挑战它/◆.稍作准备」。selectOption 按「选中项 === optA」判定进攻。
        options: this._challengeOptions(cnode),
      });
      return;
    }
    if (!raw) {
      // 原版：服务端对任一列表任务必回 SC_SHOW_TASK_DLG。
      // 单机版缺失该任务抓包详情时，用列表行已知字段合成 type=0(描述) 详情，
      // 明确标注「未抓包」，不臆造 desc/奖励/条件 —— 面板仍进入 DESCRIBE 阶段（与原版一致）。
      const lt = this._listTaskOf(taskId);
      const obj = makeTaskObj({
        taskId,
        npcId: npcId || (lt && lt.npcId),
        npcName: (lt && lt.npcName) || '',
        title: (lt && (lt.taskName || lt.title)) || ('任务 ' + taskId),
        level: lt ? lt.level : '',
        condignLevel: lt ? num(lt.level) : 0,
        difficulty: lt ? 1 : 1,
      });
      obj._noDetail = true;
    this._emit('SC_SHOW_TASK_DLG', {
        npcId, npcName: obj.npcName, npcImg: this._headOf(npcId), taskId: String(taskId),
        type: 0, taskObj: obj, acceptText: '', cancleText: '', content: '', showAccept: 0,
      });
      return;
    }
    // 需求4：节点类型分流（框架预留）。talk/finish 走主流程；
    //   quiz=答题 / submitItem=提交物品 / submitPet=提交宠物 先走占位分发，保证不崩。
    const ntSel = this._nodeTypeOf(raw, 0);
    if (ntSel === NODE_TYPE.QUIZ || ntSel === NODE_TYPE.SUBMIT_ITEM || ntSel === NODE_TYPE.SUBMIT_PET) {
      this._dispatchNode(ntSel, npcId, raw);
      return;
    }
    const st = this.state;
    const base = String(taskId);
    const obj = makeTaskObj({ ...raw, npcId: npcId || raw.npcId });
    const p0story = this._nodeStory(raw, 0);
    const isAccepted = st.accepted.has(base);
    const isFinish = st.finished.has(base);
    if (!isAccepted || isFinish) {
      // 未接 → .1 DESCRIBE 大面板（已完成任务也走只读描述，不重复发奖励流程）
      // AS3 receiveShowTaskDlg: setContents(field6) = .1 story；desc 只进右侧 DescTaskPanel，不左右重复
      this._emit('SC_SHOW_TASK_DLG', {
        npcId, npcName: raw.npcName || '', npcImg: this._headOf(npcId), taskId: base,
        type: 0, taskObj: obj, acceptText: '', cancleText: '',
        content: p0story,
        showAccept: num(raw.showAccept),
      });
      return;
    }
    // 已接：在交付 NPC 处可交付，他处只能「继续」
    const finId = this._finishNpcIdOf(raw);
    const finNpc = (finId != null && finId > 0) ? finId : (Number(raw.npcId) || Number(npcId));
    // ★ BUG 修复：面板头部名字必须是「当前交谈的 NPC」（交付时=交付 NPC），不是任务配置的
    //   raw.npcName（那是发布任务的 NPC）。跨 NPC 交付时 otherwise 头部会错挂发布人名字。
    const curName = this._npcNameOf(npcId, raw);
    // ★ 杀怪/物品条件未满足 ⇒ 即使在交付 NPC 处也走「继续任务」（用户 bug②）：
    //   不发 taskOver 完成文案，交任务的实际扣物品/发奖由 taskAction(OVER) 的 killsDone 兜底阻断。
    if (finNpc === Number(npcId) && st.killsDone(base)) {
      // 有可选奖励/装备上交 → 仍走 S.OVER 原版大面板（要先选奖励/放装备）
      if (num(raw.choiceItemNum) > 0 || num(raw.needEquip)) {
        this._emit('SC_SHOW_TASK_DLG', {
          npcId, npcName: curName, npcImg: this._headOf(npcId), taskId: base,
          type: 1, taskObj: obj, acceptText: '', cancleText: '',
          content: this._nodeStory(raw, 1) || p0story,
          showAccept: num(raw.showAccept),
        });
      } else {
        // 需求2：交付小窗 = SC_SHOW_TALK_DLG（content = .2 的 story + taskOver 标记，不带默认语句）
        this._emit('SC_SHOW_TALK_DLG', {
          npcId, npcName: curName, npcImg: this._headOf(npcId), taskId: base,
          content: this._nodeStory(raw, 1) || p0story || '',
          taskOver: true,
        });
      }
    } else {
      // 他处 → CARRYOVER（继续任务）
      this._emit('SC_SHOW_TASK_DLG', {
        npcId, npcName: curName, npcImg: this._headOf(npcId), taskId: base,
        type: 2, taskObj: obj, acceptText: '', cancleText: '',
        content: p0story,
        showAccept: 0,
      });
    }
  }

  /** CS_TASK_ACTION(24)：value2 = ACT.*（0 接取 / 1 完成 / 2 继续）；value3/choiceId 为可选奖励 */
  taskAction(npcId, taskId, action, choiceFlag = 0, choiceId = '') {
    const P = this._proto();
    const st = this.state;
    st.logPush('CS', P.CS_TASK_ACTION, 'npcId=' + npcId + ' taskId=' + taskId + ' act=' + action + (choiceId ? ' choice=' + choiceId : ''));
    const raw = this._taskOf(taskId);
    const base = String(taskId);
    const name = raw ? (raw.title || raw.taskName || raw.name) : ('任务 ' + base);
    // ★ 节点类型分流（需求4 框架）：非 talk/finish 的节点类型先走占位，不改变既有主流程
    const nt = this._nodeTypeOf(raw, 0);
    if (nt === NODE_TYPE.QUIZ || nt === NODE_TYPE.SUBMIT_ITEM || nt === NODE_TYPE.SUBMIT_PET) {
      this._dispatchNode(nt, npcId, raw);
      return;
    }
    if (action === ACT.ACCEPTED) {
      // ★ 互斥组兜底：同 mutexGroup 已有任务被接取/完成 ⇒ 拒接（面板列表已过滤，此为编程调用兜底）
      if (this._mutexBlocked(raw)) {
        const ui0 = this._ui();
        if (ui0 && typeof ui0.toast === 'function') ui0.toast('已选择另一条分支，该任务不可接取');
        st.logPush('SC', 0, 'ACCEPT blocked by mutexGroup: task=' + base);
        return;
      }
      st.accepted.add(base);
      st.finished.delete(base);
      // ★ 注册条件进度：op62 conditionItem 的「名字 (0/N)」条目（杀怪）+ 显式 conditionItems（物品提交）。
      //   同名条目只取一种语义：物品条件由 regItems 登记，regKills 跳过。
      const itemNames = new Set((raw && Array.isArray(raw.conditionItems))
        ? raw.conditionItems.map((c) => String((c && c.name) || '').trim()).filter(Boolean) : []);
      st.regKills(base, raw && raw.conditionItem, itemNames);
      st.regItems(base, raw && raw.conditionItems);
      // ★ 任务事件 → 世界动作分发（NPC 显隐 / 传送门切换 / 以后扩展的给队友·宠物·NPC 动画）
      questFireEvent({ taskId: base, event: 'accept' });
      // 需求1：接取语句走剧情聊天窗（chat-story）：storyAccept || p0.story || 默认模板
      //   输出格式对齐 AS3 近聊：<font color='#E16205'>>【地图名】NPC名说：</font>正文
      this._chatStory(npcId, raw, this._outLine(raw, 0, 'accept', name));
      // 对齐 AS3：接取后关面板（不再停留 PROCESS 显示默认语句）
      this._emit('SC_TALK_CLOSE', {});
      this._emit('SC_TASK_STATUS', { taskId: base, status: 1 });
    } else if (action === ACT.OVER) {
      // ★ 交付前置校验：杀怪/物品条件必须全满（面板列表已按 killsDone 过滤「可交付」，
      //   这里兜底——玩家可能在开面板后丢掉了任务物品）。不满足 ⇒ 阻断交付并提示，任务不结束。
      if (!st.killsDone(base)) {
        const ui = this._ui();
        const miss = st.killsText(base);
        if (ui && typeof ui.toast === 'function') ui.toast('任务条件未满足：' + (miss || '请查看任务描述'));
        st.logPush('SC', 0, 'OVER blocked: conditions not met, task=' + base);
        return;
      }
      // ★ 扣除提交的物品（在发奖励之前，保证「交了才给」）
      const submitted = st.consumeItems(base);
      if (submitted.length) {
        this._chat('sys', '提交物品：' + submitted.map((s) => esc2(s.name) + '×' + s.num).join('、'));
      }
      st.accepted.delete(base);
      st.finished.add(base);
      // ★ 清掉杀怪/物品进度（交付完成）
      st.clearKills(base);
      // ★ 任务事件 → 世界动作分发（如 501003 完成 → 白胡子显形、501004 完成 → 同格换门）
      questFireEvent({ taskId: base, event: 'finish' });
      // 需求1（方案A）：完成语句走剧情窗 chat-story；奖励清单单独走系统窗 chat-sys（两窗各一条）
      //   剧情窗正文同样包 AS3 近聊格式（地图名 + NPC 名说：）
      this._chatStory(npcId, raw, this._outLine(raw, 1, 'finish', name));
      const reward = this._rewardLine(raw, choiceId);
      if (reward) this._chat('sys', reward);
      // ★ 邮件系统已删除：任务奖励改为完成时**直接获得**（bonusItem + 已选可选奖励），
      //   并在系统聊天窗逐件提醒；经验/银票类假物品按 descBonus 直接加经验/银子
      this._grantBonus(raw, choiceId);
      // 对齐 AS3：完成后关面板
      this._emit('SC_TALK_CLOSE', {});
      this._emit('SC_TASK_STATUS', { taskId: base, status: 2 });
    } else {
      // GOON（继续）：关面板
      this._emit('SC_TALK_CLOSE', {});
    }
    // A/B 两套任务状态合一：接取/完成同步任务面板与右上追踪
    this._syncQuest(base, raw);
    // 需求3：完成后自动打开下一环（同 NPC 原地切，跨 NPC 提示去向）
    if (action === ACT.OVER) this._autoOpenNext(npcId, base, raw);
    // 任务状态变化 → 刷新地图 NPC 头顶任务提示标记（yem=可接 / yqm=可交付）
    if (typeof window !== 'undefined' && window.__TS_QUEST_MARKS) {
      try { window.__TS_QUEST_MARKS.refresh(); } catch (e) { console.warn('[quest-mark] 刷新失败', e); }
    }
  }

  /** 击杀推进后的统一刷新（BattleScene._awardKill 调 addKill 之后调）：
   *  同步任务追踪栏 + 头顶任务标记 + 聊天窗进度提示。
   *  killName = 本次击杀的怪物名，用于命中挑战节点的「击败后文案」。 */
  onKillAdvanced(advanced, killName) {
    if (!advanced || !advanced.length) return;
    const kName = String(killName || '').trim();
    for (const tid of advanced) {
      const raw = this._taskOf(tid);
      this._syncQuest(tid, raw);
      const txt = this.state.killsText(tid);
      if (txt) this._chat('story', '<font color="#FFD479">任务进度：</font>' + esc2(txt));
      // ★ 挑战节点「击败后文案」（challenge 节点的 story，如「地上只剩下一堆雪粉。」）：
      //   该怪物刚好杀够时播一条聊天窗故事。战前挑战对话框不再剧透（用户 bug②/③）。
      if (kName && raw) {
        const cn = this._challengeNodes(raw).find((n) => String((n && n.monster) || '') === kName);
        const story = cn ? String(cn.story || '').trim() : '';
        if (story) {
          const km = this.state.kills.get(String(tid));
          const ent = km && km.get(kName);
          if (ent && ent.got >= ent.need) this._chat('story', esc2(story));
        }
      }
      // ★ 击杀推进事件 → 世界动作（如杀完蜃龙触发同格换门）
      questFireEvent({ taskId: String(tid), event: 'kill' });
    }
    if (typeof window !== 'undefined' && window.__TS_QUEST_MARKS) {
      try { window.__TS_QUEST_MARKS.refresh(); } catch (e) { console.warn('[quest-mark] 刷新失败', e); }
    }
  }

  /** 把 talk 任务状态同步到任务面板（ui._questState）与右上任务追踪 */
  _syncQuest(taskId, raw) {
    const ui = panelManager.context && panelManager.context.ui;
    if (!ui) return;
    const st = this.state;
    const id = String(taskId);
    let qs = ui._questState || (ui._questState = []);
    let q = qs.find((x) => String(x.id) === id);
    if (!q) {
      q = { id, name: (raw && (raw.title || raw.name)) || ('任务 ' + id),
            accepted: false, done: false, progress: 0, target: 1 };
      qs.push(q);
    }
    if (st.finished.has(id)) { q.accepted = true; q.done = true; q.progress = q.target; }
    else if (st.accepted.has(id)) { q.accepted = true; q.done = false; q.progress = 0; }
    else { q.accepted = false; q.done = false; q.progress = 0; }
    // ★ 杀怪条件任务：追踪栏进度取 kills 表（已完成条目数 / 总条目数），
    //   progressText 优先（ui._renderQuestTracker 优先用它，显示「雪噬灵 1/1、火噬灵 0/1」）
    const km = st.kills.get(id);
    if (km && km.size) {
      let doneN = 0;
      for (const v of km.values()) if (v.got >= v.need) doneN++;
      q.progress = doneN; q.target = km.size;
      q.progressText = st.killsText(id);
    } else {
      q.progressText = null;
    }
    ui.setQuestState(qs);
    // 完成的下一环提示/自动打开统一由 _autoOpenNext 处理（taskAction OVER 分支后调用），此处不再重复 toast
  }

  /** 取 UI 实例（chat-box 输出与玩家等级门控用） */
  _ui() { return panelManager.context && panelManager.context.ui; }
  /** 取主场景实例（取当前地图名 / 场景 NPC 名用）。
   *  ⚠ panelManager.context.sm 是 SceneManager，当前主城/战斗场景在其 .current 上 */
  _scene() {
    const sm = panelManager.context && panelManager.context.sm;
    return (sm && sm.current) || null;
  }

  /** 取说话 NPC 的显示名：场景实体优先（含地图配置的名字），回退任务配置 npcName */
  _npcNameOf(npcId, raw) {
    const sc = this._scene();
    if (sc && Array.isArray(sc.npcs)) {
      const f = sc.npcs.find((x) => x && x.npcData && Number(x.npcData.id) === Number(npcId));
      if (f && f.npcData.name) return String(f.npcData.name);
    }
    if (raw && raw.npcName) return String(raw.npcName);
    const t = this._talkOf(npcId);
    return (t && t.npcName) ? String(t.npcName) : ('NPC ' + npcId);
  }
  /** 取当前地图名（AS3 近聊频道名位置换成地图名） */
  _mapNameOf() {
    const sc = this._scene();
    const m = sc && sc.map;
    return (m && m.name) ? String(m.name) : '';
  }

  /** 需求1：输出到右侧 chat-box（type='story' 剧情 / 'sys' 系统）；ui 未就绪时静默 */
  _chat(type, html) {
    try { const ui = this._ui(); if (ui && typeof ui.log === 'function') ui.log(html, type); } catch (e) { console.warn('[talk] chat-box 输出失败', e); }
  }
  /** 剧情窗输出（需求：格式对齐 AS3 近聊）：
   *    <font color='#E16205'>>【当前地图名】NPC名说：</font>剧情输出文本
   *  颜色码 = AS3 getScopeColor(CHANNEL_ROUND) = #E16205（SystemManager.as:493）；
   *  模板 = chatTemplate + CHARSTRING(30332)「【{0}】{1}说：</font>…{2}</font>」，
   *  频道名换成当前地图名、说话人换成当前交谈 NPC（任务输出本来就是 NPC 在说话）。
   *  正文保持 _outLine 的富文本（编辑器可配 storyAccept/storyFinish/节点 story）。 */
  _chatStory(npcId, raw, content) {
    if (!content) return;
    const mapName = this._mapNameOf();
    const npcName = this._npcNameOf(npcId, raw);
    const head = '<font color="#E16205">>【' + esc2(mapName) + '】' + esc2(npcName) + '说：</font>';
    this._chat('story', head + content);
  }

  /** 奖励清单富文本（完成时单独输出到系统窗 chat-sys）：bonusItem 列表 + 可选奖励选择 */
  _rewardHtml(raw, choiceId) {
    const bonus = (raw && raw.bonusItem) || [];
    let h = '';
    if (bonus.length) h += '<br>获得奖励：' + bonus.map((b) => esc2(b.name || ('物品' + b.id)) + '×' + num(b.num, 1)).join('、');
    if (choiceId && choiceId !== '-1') h += '<br>已选择奖励：' + esc2(choiceId);
    return h;
  }

  /** 奖励输出语句：rewardLine（编辑器可配）优先；空=自动生成奖励清单（去前导 <br>） */
  _rewardLine(raw, choiceId) {
    if (raw && raw.rewardLine) return String(raw.rewardLine);
    return this._rewardHtml(raw, choiceId).replace(/^<br>/, '');
  }

  /* ─────────── 奖励直接发放（邮件系统删除后：物品入包 / 经验银子直接加，系统窗提醒）───────────
   *   bonusItem 抓包结构 {id, num, name, image, descBonus, type}：
   *     id=0 → 经验/元神假物品（descBonus 形如「1000000点经验」「211点元神」）；
   *     id=2 → 银票假物品（descBonus 形如「10两银票」）；
   *     其余 → 真实物品 id，入权威背包（Config.items 无定义 = 数据缺失，跳过不臆造）。 */
  _grantBonus(raw, choiceId) {
    const list = (raw && Array.isArray(raw.bonusItem)) ? raw.bonusItem.slice() : [];
    // 已选的可选奖励一并发放（UI 选择链路见 panel-talk.js 的 choiceSel → choiceId）
    if (choiceId && choiceId !== '-1' && raw && Array.isArray(raw.choiceItem)) {
      const sel = raw.choiceItem.find((c) => c && String(c.id) === String(choiceId));
      if (sel) list.push(sel);
    }
    if (!list.length) return;
    const got = [];
    for (const b of list) {
      const r = this._grantOne(b);
      if (r) got.push(r);
    }
    if (got.length) this._chat('sys', '<font color="#2fae6b">已获得：</font>' + got.join('、'));
  }

  /** 发放单条奖励，成功返回「展示文本」（已转义由 ui._richLog 统一处理，此处保持原文），失败返回 null */
  _grantOne(b) {
    if (!b) return null;
    const id = Math.trunc(Number(b.id));
    const n = Math.max(1, Math.trunc(Number(b.num)) || 1);
    const db = String(b.descBonus || '');
    // 假物品：经验/元神
    if (id === 0) {
      const m = /(\d+)\s*点(?:经验|元神)/.exec(db);
      const amount = m ? Number(m[1]) : 0;
      if (amount > 0 && this._grantExp(amount)) return '经验 ' + amount.toLocaleString() + ' 点';
      return null;
    }
    // 假物品：银票
    if (id === 2) {
      const m = /(\d+)\s*两银票/.exec(db);
      const liang = m ? Number(m[1]) : 0;
      if (liang > 0 && this._grantSilver(liang)) return '银子 ' + liang + ' 两';
      return null;
    }
    if (!Number.isFinite(id) || id <= 0) return null;
    // 真实物品：物品定义缺失 → 跳过（不臆造物品）
    const def = (typeof Config !== 'undefined' && Config.items) ? Config.items[id] : null;
    if (!def) return null;
    const nm = def.name || ('物品' + id);
    const boot = inventoryBooted();
    if (boot && boot.inv) {
      const r = boot.inv.addItem(id, n);
      if (!r || !r.ok) { this._chat('sys', '背包已满，「' + nm + '」未能入包'); return null; }
      inventoryCommit('quest-reward');
    } else {
      // 物品系统未启动（异常兜底）：退回直推视图
      const p = this._ui() && this._ui().player;
      if (!p) return null;
      if (!Array.isArray(p.bag)) p.bag = [];
      const exist = p.bag.find((s) => s && Number(s.itemId) === id);
      if (exist) exist.count += n;
      else p.bag.push({ itemId: id, count: n });
    }
    return nm + '×' + n;
  }

  /** 加经验（含升级重算，口径对齐 net.js BATTLE_END / scene.js::_awardKill：
   *    config/level_exp.json 表为真源（缺失回退 ×1.35）、maxLevel 封顶、升级按比例保留 hp/mp） */
  _grantExp(amount) {
    const ui = this._ui();
    const p = ui && ui.player;
    if (!p || !amount) return false;
    p.exp = Math.max(0, Math.round((Number(p.exp) || 0) + amount));
    let leveled = false;
    const MAX_LV = maxUnawakenedLevel();
    while (Number(p.expNext) > 0 && p.exp >= p.expNext) {
      if (MAX_LV > 0 && (Number(p.level) || 0) >= MAX_LV) break;   // 满级封顶：经验不再消耗
      p.exp -= p.expNext;
      p.level = (Number(p.level) || 0) + 1;
      const nx = expToNext(p.level);
      p.expNext = nx > 0 ? nx : Math.round(p.expNext * 1.35);      // 有表用表，无表回退兜底
      leveled = true;
    }
    if (leveled) {
      try {
        const hpR = p.maxHp ? p.hp / p.maxHp : 1;
        const mpR = p.maxMp ? p.mp / p.maxMp : 1;
        applyPlayerAttrs(p);
        p.hp = Math.max(1, Math.round(p.maxHp * hpR));
        p.mp = Math.round(p.maxMp * mpR);
      } catch (e) { console.warn('[quest] 升级重算失败：', e); }
      this._chat('sys', '<font color="#ffd479">升级！当前 Lv.' + p.level + '</font>');
    }
    if (typeof ui.refresh === 'function') ui.refresh();
    return true;
  }

  /** 加银子（两单位；money 模块按「两×1000+文」两级入库） */
  _grantSilver(liang) {
    const ui = this._ui();
    const p = ui && ui.player;
    if (!p || !liang) return false;
    try { gainCopper(p, 'silver', Math.round(liang * 1000)); } catch (e) { return false; }
    if (typeof ui.refresh === 'function') ui.refresh();
    return true;
  }

  /** 挑战节点的两个选项（op30 field13/field14）：节点配的 optA/optB 优先，兜底「◆挑战它/◆.稍作准备」。
   *   ⚠ optA 恒为「进攻项」——selectOption 用「选中 === options[0]」判定是否开战，与字面解耦。 */
  _challengeOptions(cnode) {
    const a = String((cnode && cnode.optA) || '').trim();
    const b = String((cnode && cnode.optB) || '').trim();
    return [a || '◆挑战它', b || '◆.稍作准备'];
  }

  /** 取任务的全部挑战节点（nodeType==='challenge'，按 phase 升序）。通用框架，不局限天音洞 */
  _challengeNodes(raw) {
    if (!raw || !Array.isArray(raw.nodes)) return [];
    return raw.nodes
      .filter((n) => n && n.nodeType === NODE_TYPE.CHALLENGE && n.npcId != null)
      .sort((a, b) => Number(a.phase) - Number(b.phase));
  }
  /** 挑战行 taskId 解码：'501001@C10' → { base:'501001', phase:10 }；非挑战行返回 null */
  _parseChallengeTaskId(taskId) {
    const s = String(taskId || '');
    const i = s.indexOf('@C');
    if (i <= 0) return null;
    const phase = Number(s.slice(i + 2));
    if (!Number.isFinite(phase)) return null;
    return { base: s.slice(0, i), phase };
  }

  /* ─────────── 节点框架 helpers（nodes 优先，旧数据兜底） ─────────── */

  /** 节点正文：nodes[phase].story 优先；无节点框架时 phase0→story、phase1→finishStory||story */
  _nodeStory(raw, phase) {
    if (!raw) return '';
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const n = nodes.find((x) => x && Number(x.phase) === phase);
    if (n && String(n.story || '') !== '') return String(n.story);
    if (phase === 0) return String(raw.story || '');
    return String((raw.finishStory != null && raw.finishStory !== '') ? raw.finishStory : (raw.story || ''));
  }
  /** 节点 NPC：nodes[phase].npcId 优先；缺省 phase0→raw.npcId */
  _nodeNpcId(raw, phase) {
    if (!raw) return null;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const n = nodes.find((x) => x && Number(x.phase) === phase);
    if (n && n.npcId != null && String(n.npcId) !== '') return Number(n.npcId) || null;
    return phase === 0 ? (Number(raw.npcId) || null) : null;
  }
  /** 节点类型：nodes[phase].nodeType 优先，回退 raw.nodeType（非法值兜底 talk） */
  _nodeTypeOf(raw, phase) {
    if (!raw) return NODE_TYPE.TALK;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const n = nodes.find((x) => x && Number(x.phase) === phase);
    const v = (n && n.nodeType) ? String(n.nodeType) : String(raw.nodeType || '');
    return VALID_NODE_TYPE.has(v) ? v : NODE_TYPE.TALK;
  }
  /** 节点级输出语句：节点 storyAccept/storyFinish 优先于任务级 */
  _nodeOut(raw, phase, kind) {
    const key = kind === 'accept' ? 'storyAccept' : 'storyFinish';
    if (raw) {
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
      const n = nodes.find((x) => x && Number(x.phase) === phase);
      if (n && n[key]) return String(n[key]);
      if (raw[key]) return String(raw[key]);
    }
    return '';
  }
  /** 输出语句最终值：自定义语句 || 节点 story || 默认模板（name 为任务名） */
  _outLine(raw, phase, kind, name) {
    const custom = this._nodeOut(raw, phase, kind);
    if (custom) return custom;
    const story = this._nodeStory(raw, phase);
    if (story) return story;
    return kind === 'accept'
      ? '已接取任务：<font color="#E9DC04">' + esc2(name) + '</font>'
      : '完成任务：<font color="#55D7BD">' + esc2(name) + '</font>';
  }

  /** 需求3：完成后自动打开下一环。
   *  候选：① raw.next → 下一 base；② 同 NPC 且 preTask=刚完成 base 的后置任务。
   *  门控：未接未完成 && 同 NPC(p0.npcId===npcId) && 等级达标 && 依赖道具在背包。
   *  全部通过 → selectTask 自动打开下一环 DESCRIBE；否则 toast 提示去向。 */
  _autoOpenNext(npcId, base, raw) {
    const st = this.state;
    const d = this._data();
    const ui = this._ui();
    const tryOpen = (cand) => {
      if (!cand) return false;
      const cid = String(cand.taskId);
      if (st.accepted.has(cid) || st.finished.has(cid)) return false;
      const p0npc = this._nodeNpcId(cand, 0);
      const sameNpc = (p0npc != null) && Number(p0npc) === Number(npcId);
      const levelOk = this._levelOk(cand);
      const itemOk = this._itemOk(cand);
      if (sameNpc && levelOk && itemOk && this._preTaskOk(cand) && !this._mutexBlocked(cand)) {
        this.selectTask(npcId, cid); return true;
      }
      if (ui) ui.toast('新任务开启：' + (cand.title || cand.taskName || cid) + '（前往寻找 ' + this._npcNameOf(p0npc, cand) + '）');
      return false;
    };
    // ① 链式 next
    if (raw && raw.next && tryOpen(this._taskOf(raw.next))) return true;
    // ② 同 NPC + preTask=刚完成的后置任务（前置完成 ⇒ 同 NPC 后置可接，自动打开）
    //   preTask 支持数组（合流点：任一前置完成即视为本任务的后置候选）。
    const followAll = (d.tasks || []).filter((t) => {
      if (String(t.taskId) === base) return false;
      const pre = t && t.preTask;
      if (!pre) return false;
      const arr = Array.isArray(pre) ? pre : [pre];
      return arr.map(String).includes(base);
    });
    // ★ 分支点：多个后置（如 501021 →「小心翼翼」501022 /「勇往直前」501023 互斥）时，
    //   自动开第一个会剥夺玩家选择权 ⇒ 只 toast 提示去 NPC 处自选，不自动打开。
    if (followAll.length > 1) {
      if (ui) ui.toast('多个分支任务已开启，请与 ' + this._npcNameOf(this._nodeNpcId(followAll[0], 0), followAll[0]) + ' 对话选择其一');
      return true;
    }
    if (followAll.length === 1 && tryOpen(followAll[0])) return true;
    return false;
  }

  /** 前置任务校验：无 preTask 放行；preTask 为字符串或数组（数组=多前置，some 语义：任一完成即可，
   *  用于分支合流点如 501024 魔族援军 preTask=['501022','501023']）。 */
  _preTaskOk(t) {
    const st = this.state;
    const pre = t && t.preTask;
    if (!pre) return true;
    const arr = Array.isArray(pre) ? pre : [pre];
    return arr.some((p) => st.finished.has(String(p)));
  }
  /** 互斥组校验：同 mutexGroup 的其他任务任一被接取/完成 ⇒ 本任务不可接（派生式判定，
   *  零新状态，随 accepted/finished 持久化）。用于天音洞下层「小心翼翼/勇往直前」二选一。 */
  _mutexBlocked(t) {
    const st = this.state;
    const g = t && t.mutexGroup;
    if (!g) return false;
    const d = this._data();
    for (const o of (d.tasks || [])) {
      const oid = String(o.taskId);
      if (oid === String(t.taskId)) continue;
      if (o.mutexGroup !== g) continue;
      if (st.accepted.has(oid) || st.finished.has(oid)) return true;
    }
    return false;
  }

  /** 依赖道具门控：conditionItem 为道具名或 id，反查 Config.items 得 id，查背包数量。
   *   无 conditionItem / 查不到道具定义 → 不阻断（放行）；有定义但背包没有 → 阻断。 */
  _itemOk(cand) {
    const need = String((cand && cand.conditionItem) || '').trim();
    if (!need) return true;
    try {
      let itemId = /^\d+$/.test(need) ? need : null;
      if (itemId == null) {
        const items = (typeof Config !== 'undefined' && Config.items) || {};
        const hit = Object.keys(items).find((k) => items[k] && items[k].name === need);
        if (hit) itemId = hit; else return true;   // 查不到道具定义 → 不阻断
      }
      // 权威背包优先
      try { if (inventory() && typeof inventory().countOf === 'function' && inventory().countOf(itemId) > 0) return true; } catch (e) {}
      // 视图兜底：ui.player.bag
      const ui = this._ui();
      const bag = ui && ui.player && Array.isArray(ui.player.bag) ? ui.player.bag : [];
      return bag.some((s) => s && String(s.itemId) === String(itemId) && Number(s.count || 0) > 0);
    } catch (e) { return true; }
  }

  /** 等级门控：condignLevel<=0 无要求；玩家等级未就绪时放宽（不阻断流程） */
  _levelOk(cand) {
    const need = num(cand && cand.condignLevel, 0);
    if (need <= 0) return true;
    try {
      const ui = this._ui(); const p = ui && ui.player;
      if (p == null || !Number.isFinite(Number(p.level))) return true;
      return Number(p.level) >= need;
    } catch (e) { return true; }
  }

  /** 需求4：节点类型分发框架。talk/finish 走主流程；quiz/submitItem/submitPet 占位不崩 */
  _dispatchNode(nodeType, npcId, raw) {
    const ui = this._ui();
    const tip = {
      [NODE_TYPE.QUIZ]: '答题节点待实装（quiz）',
      [NODE_TYPE.SUBMIT_ITEM]: '提交物品节点待实装（submitItem）',
      [NODE_TYPE.SUBMIT_PET]: '提交宠物节点待实装（submitPet）',
    }[nodeType] || '未知节点类型';
    if (ui && typeof ui.toast === 'function') ui.toast(tip);
    // 占位进问答阶段（S.DIAGNOSES 有返回/放弃按钮可安全退出）
    this._emit('SC_SHOW_OPTION_DLG', {
      npcId, tag: String(nodeType), taskId: raw ? String(raw.taskId) : '',
      content: '（' + tip + '，节点脚本待逆向）', options: [],
    });
  }
  /** CS_SELECT_OPTION(76)：问答选项 → SC_SHOW_OPTION_DLG(92) 或 SC_SHOW_TALK_DLG(31)
   *  ★ 挑战对话（tag='challenge:base:phase'，对齐 op30 field13/field14 两选项按钮）：
   *    选「◆挑战它」→ 派发 SC_CHALLENGE_START（带 monsterNpc），由面板调 sm.enterBattle 进战斗；
   *    选「◆.稍作准备」→ 关面板（对齐原服「稍作准备」= 取消挑战）。
   *  ⚠ talk.js 铁律③「不碰任何战斗代码」：进战斗由面板监听 SC_CHALLENGE_START 执行，本类只组数据。 */
  selectOption(npcId, tag, optionId, taskId) {
    const P = this._proto();
    const st = this.state;
    st.logPush('CS', P.CS_SELECT_OPTION, 'npcId=' + npcId + ' tag=' + tag + ' opt=' + optionId);
    const ts = String(tag || '');
    if (ts.startsWith('challenge:')) {
      const parts = ts.split(':');                       // ['challenge', base, phase]
      const base = parts[1] || '';
      const phase = Number(parts[2]);
      const raw = this._taskOf(base);
      const node = raw && this._challengeNodes(raw).find((n) => Number(n.phase) === phase);
      // ★ 进攻判定 = 「选中项 === 该节点 options[0]」（optA），不再硬编码字面量。
      //   未配 optA 时 options[0] = '◆挑战它'，与旧行为完全一致。
      const opts = this._challengeOptions(node);
      if (String(optionId) === String(opts[0])) {
        const monsterName = node ? String(node.monster || '') : '';
        const mid = monsterName ? this._monsterIdByName(monsterName) : null;
        if (!mid) {
          this._chat('sys', '怪物配置缺失，无法挑战：' + esc2(monsterName || '未知'));
          this._emit('SC_TALK_CLOSE', {});
          return;
        }
        // 关面板再开战（面板与战斗层切换由场景层处理）
        this._emit('SC_TALK_CLOSE', {});
        this._emit('SC_CHALLENGE_START', {
          npcId, taskId: base, phase, monsterId: mid, monsterName,
          monsterNpc: { id: 'challenge_' + base + '_' + mid, monsterId: mid, name: monsterName, type: 'monster' },
        });
        return;
      }
      // ◆.稍作准备 / 其余 ⇒ 关面板
      this._emit('SC_TALK_CLOSE', {});
      return;
    }
    // 抓包无问答脚本样本 ⇒ 末级选项回落到对话，不臆造分支树
    this._emit('SC_SHOW_TALK_DLG', {
      npcId, npcName: st.npcName, npcImg: this._headOf(npcId),
      content: '（问答分支脚本未出现在抓包样本中：已选择选项 ' + esc2(optionId) + '，待逆向）',
    });
  }

  /** 按怪物名反查 Config.monsters 的模板 id（挑战对话 → monsterId）。
   *  ⚠ Config.monsters 是 id→模板 的对象，name 可能重名；取首个匹配并告警重名，不臆造。 */
  _monsterIdByName(name) {
    const ms = (typeof Config !== 'undefined' && Config.monsters) || {};
    let hit = null;
    for (const k of Object.keys(ms)) {
      if (ms[k] && ms[k].name === name) {
        if (hit != null) { console.warn('[talk] 怪物名重名，取首个：' + name, hit, k); break; }
        hit = k;
      }
    }
    return hit;
  }

  /** CS_DENY_TASK(664)：取消任务对话 */
  denyTask(taskId) {
    const P = this._proto();
    this.state.logPush('CS', P.CS_DENY_TASK, 'taskId=' + taskId);
  }

  /** CS_GANG_CONTRIBUTION(953) → SC_GANG_CONTRIBUTION(966) */
  gangContribution(type) {
    const P = this._proto();
    this.state.logPush('CS', P.CS_GANG_CONTRIBUTION, 'type=' + type);
    this._emit('SC_GANG_CONTRIBUTION', { type, contribution: 0, yuanpo: 0, exp: 0 });
  }
  /** CS_CLOSE_CONTRIBUTION_PANEL(954) → SC_CLOSE_CONTRIBUTION_PANEL(969) */
  closeContribution() {
    const P = this._proto();
    this.state.logPush('CS', P.CS_CLOSE_CONTRIBUTION_PANEL, '');
    this._emit('SC_CLOSE_CONTRIBUTION_PANEL', {});
  }
}

function esc2(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ══════════════════════════ 单例 ══════════════════════════ */

let _inst = null;
export function talkSys() {
  if (!_inst) _inst = { state: new TalkState(), net: null };
  if (!_inst.net) _inst.net = new TalkNet(_inst.state);
  return _inst;
}

if (typeof window !== 'undefined') {
  window.__TS_TALK_STATE = _inst ? _inst.state : null;
  Object.defineProperty(window, '__TS_TALK_STATE', {
    get() { return _inst ? _inst.state : null; }, configurable: true,
  });
  // 调试/探针入口（与 __TS_QUEST_MARKS 同一目的）：暴露 talk 系统单例
  Object.defineProperty(window, '__TS_TALK_SYS', {
    get() { return talkSys(); }, configurable: true,
  });
  // ★ 背包变化 → 重算物品条件进度并刷新任务追踪/头顶标记。
  //   解耦：inventory 只发 'ts-inventory-changed' 事件，任务侧订阅（防抖 300ms）。
  //   未接任何物品条件任务时 syncItemGot 是空转，开销可忽略。
  let _invT = null;
  document.addEventListener('ts-inventory-changed', () => {
    if (_invT) clearTimeout(_invT);
    _invT = setTimeout(() => {
      const sys = talkSys();
      try {
        sys.state.syncItemGot();
        // 只重算有物品条件的已接任务，避免全量同步
        for (const tid of sys.state.accepted) {
          if (sys.state.kills.get(tid)) sys.net._syncQuest(tid, sys.net._taskOf(tid));
        }
        if (window.__TS_QUEST_MARKS) window.__TS_QUEST_MARKS.refresh();
      } catch (e) { console.warn('[talk] 背包变化同步任务进度失败', e); }
    }, 300);
  });
}
