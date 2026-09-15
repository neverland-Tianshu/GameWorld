// js/quest/quest-actions.js —— 任务事件 → 世界动作 的分发层
//
// 为什么需要这一层（架构诊断）：
//   talk.js 的 TalkState 是纯状态机（accepted/finished/kills），原本只有 3 个出口
//  （追踪栏 UI / 头顶任务标记 / 发奖励）。任何「任务状态改变世界」的新需求
//   （NPC 显隐、传送门切换、以后要加的给队友/给宠物/播 NPC 动画）都得回去改
//   talk.js 的 taskAction，改动面大、容易互相踩。
//   本层把「状态变化」与「世界动作」彻底解耦：
//     talk.js 只在 accept/finish/kill 三处发一个轻事件 →
//     quest-actions 按 taskId 查配置的动作表 → 逐个派发给已注册的 handler。
//   加新动作类型 = 注册一个 handler + 配置里写一行，talk.js 零改动。
//
// 动作配置真源：config/talk.json 的 data.questActions
//   {
//     "501003": {                          // taskId
//       "finish": [                        // 触发时机：accept | finish | kill
//         { "type": "showNpc", "mapId": 1001, "ids": [501005] },
//         { "type": "showNpc", "mapId": 1001, "ids": [50100001] }
//       ]
//     }
//   }
//   「同格换门」（原服招牌机制）：两张门本来就在同一格，
//     showNpc + hideNpc 成对配置即可，无需专门 swap 类型。
//
// handler 注册：register(type, fn(ctx, action))
//   ctx = { scene, talkState, ui, taskId, event } —— 运行期上下文，按需取用
//   返回值仅用于日志。handler 内部自行判空（场景未就绪时静默）。

import { Config } from '../core/globals.js?v=20261007c';

const CFG = () => (Config.talk && Config.talk.data && Config.talk.data.questActions) || {};

const _handlers = new Map();
const _log = [];

/** 注册动作 handler（幂等：同 type 覆盖） */
export function register(type, fn) {
  if (typeof fn !== 'function') throw new Error('quest-actions handler 必须是函数：' + type);
  _handlers.set(String(type), fn);
}

/** 取某任务在指定事件下的动作列表（配置缺省 → []） */
export function actionsOf(taskId, event) {
  const list = CFG()[String(taskId)];
  if (!list) return [];
  const a = list[String(event)];
  return Array.isArray(a) ? a : [];
}

/** 派发单个动作。scene/talkState 由调用方注入，缺失时 handler 自行短路 */
function _dispatch(ctx, action) {
  const type = String((action && action.type) || '');
  const fn = _handlers.get(type);
  if (!fn) { _log.push({ warn: '无 handler', type, taskId: ctx.taskId }); return; }
  try { fn(ctx, action); }
  catch (e) { console.warn('[quest-actions] handler 异常', type, e); }
}

/** 任务事件入口（talk.js 在 accept/finish/kill 三处调）
 *  payload = { taskId, event, killName? }
 *  event 取值：'accept'（接取）/ 'finish'（完成交付）/ 'kill'（击杀推进） */
export function fireEvent(payload) {
  const p = payload || {};
  const taskId = String(p.taskId || '');
  const event = String(p.event || '');
  if (!taskId || !event) return;
  const list = actionsOf(taskId, event);
  if (!list.length) return;
  const ctx = {
    taskId, event,
    killName: p.killName || null,
    scene: _scene(),
    talkState: _talkState(),
    ui: _ui(),
  };
  for (const a of list) _dispatch(ctx, a);
  _log.push({ taskId, event, n: list.length });
  if (_log.length > 200) _log.splice(0, _log.length - 200);
}

// ── 运行期上下文获取（与 talk.js 同款口径） ──

function _ui() {
  try { return (window.__TS && window.__TS.ui) || null; } catch (e) { return null; }
}
function _scene() {
  try {
    // ⚠ window.__TS 本身就是 SceneManager（game.js: window.__TS = sm），
    //   当前场景在 __TS.current；旧代码误写成 __TS.sm.current 导致永远拿不到场景，
    //   gate 只记账不应用（同图接任务时门不显形，必须切图才刷）。
    //   与 fighter.js / scene.js 同一口径。
    const sm = window.__TS;
    return (sm && sm.current) || null;
  } catch (e) { return null; }
}
function _talkState() {
  try { return (window.__TS_TALK_SYS && window.__TS_TALK_SYS.state) || window.__TS_TALK_STATE || null; }
  catch (e) { return null; }
}

// ════════════════════════ 内置 handler：NPC / 传送门显隐 ════════════════════════
//
// 语义：
//   showNpc { mapId, ids:[npcId...] }  —— 这些实体变为可见（当前图即时生成/恢复，他图记账）
//   hideNpc { mapId, ids:[npcId...] }  —— 这些实体变为隐藏（当前图即时摘除，他图记账）
// 记账：显隐状态存在 questGates（taskState 层），scene 进图 + _spawnNpc 判定（见 scene.js 接口）。
//   状态变化的「瞬间」若实体已在当前图，调用 scene 的 _applyQuestGate 即时显隐。

const GATE = { SHOW: 1, HIDE: 0 };

/** 显隐状态表：`<mapId>:<npcId>` → SHOW/HIDE。仅记「被任务动过的」实体，未动过的不进表（默认可见） */
const _gates = new Map();

export function gateOf(mapId, npcId) {
  return _gates.get(mapId + ':' + npcId);
}
/** 该实体是否被任务动过（进表即动过） */
export function isGated(mapId, npcId) {
  return _gates.has(mapId + ':' + npcId);
}
/** 该实体当前是否应可见：被动过按表值，未动过恒可见 */
export function isVisibleNow(mapId, npcId) {
  const g = _gates.get(mapId + ':' + npcId);
  return g == null ? true : (g === GATE.SHOW);
}

function _setVisibility(mapId, ids, visible) {
  if (!Array.isArray(ids) || !ids.length) return;
  const sc = _scene();
  for (const id of ids) {
    const nid = Number(id);
    if (!Number.isFinite(nid)) continue;
    _gates.set(mapId + ':' + nid, visible ? GATE.SHOW : GATE.HIDE);
    // 当前图：即时应用到已生成实体（未生成的会在后续 spawn 时按表判定）
    if (sc && typeof sc._applyQuestGate === 'function') {
      try { sc._applyQuestGate(mapId, nid); } catch (e) { console.warn('[quest-actions] 应用显隐失败', nid, e); }
    }
  }
}

register('showNpc', (ctx, a) => {
  _setVisibility(Number(a.mapId), a.ids, true);
});
register('hideNpc', (ctx, a) => {
  _setVisibility(Number(a.mapId), a.ids, false);
});

// ── 内置 handler：延迟传送（副本结算 / 剧情强制移动） ──
//
// 语义：
//   teleport { mapId, x, y, delay? }  —— delay 秒后把玩家送到目标图的像素落点。
//     x/y 为像素坐标（与副本「离开」传送法阵同口径：changeMap(mapId, {spawnPos:{x,y}})）。
//     delay 缺省为 0（立即传送）。
// 场景守卫：
//   ① BattleScene 没有 changeMap ⇒ 战斗中触发会静默放弃（不补放，避免战后吞玩家操作）；
//   ② 5 秒延迟期间玩家可能自己切图/进战斗 → 到点再取一次 _scene()，拿不到主城就放弃。
register('teleport', (ctx, a) => {
  const mapId = Number(a.mapId);
  const x = Number(a.x);
  const y = Number(a.y);
  const delay = Math.max(0, Number(a.delay) || 0);
  if (!Number.isFinite(mapId) || !Number.isFinite(x) || !Number.isFinite(y)) {
    _log.push({ warn: 'teleport 配置缺 mapId/x/y', taskId: ctx.taskId });
    return;
  }
  const m = (Config.maps || []).find((x2) => x2.id === mapId);
  const mName = (m && (m.name || m.map_name)) || ('地图 ' + mapId);
  if (delay > 0) {
    const ui = ctx.ui;
    if (ui && typeof ui.toast === 'function') {
      try { ui.toast(delay + ' 秒后传送至「' + mName + '」…'); } catch (e) { /* toast 失败不阻断传送 */ }
    }
  }
  const go = () => {
    const sc = _scene();
    if (!sc || typeof sc.changeMap !== 'function') {
      console.warn('[quest-actions] teleport: 主城场景未就绪，取消传送（taskId=' + ctx.taskId + '）');
      return;
    }
    try { sc.changeMap(mapId, { spawnPos: { x, y } }); }
    catch (e) { console.warn('[quest-actions] 传送失败', e); }
  };
  if (delay > 0) setTimeout(go, delay * 1000); else go();
});

// ── 探针/调试口 ──
if (typeof window !== 'undefined') {
  window.__TS_QUEST_ACTIONS = {
    fireEvent, register, actionsOf,
    gates: _gates, gateOf, isGated, isVisibleNow,
    get log() { return _log; },
  };
}

export const GATE_STATE = GATE;
