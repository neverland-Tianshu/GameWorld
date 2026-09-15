
// js/entities/npc-quest-mark.js —— 地图 NPC 头顶任务提示特效（yem 黄叹号 / yqm 黄问号）
//
// 对齐 AS3（deobfuscated/characters/CurrentPanelNpc.as）：
//   · NPC 持有 stateSprite:Sprite（构造 :1891，addChild :325），y = stateBitmapY（:2080~2097）：
//       mcHeight > 450 ? -90 : -mcHeight + 20   （模型头顶，脚底为 0 的负值坐标）
//       mcHeight = mc.height（:556，stand 帧包围盒高，【不封顶】；封顶 120 是 Fighter.as:317
//       战斗血条特例）⇒ 本端口对应 fighter._mcHeightRaw（站立池包围盒高，与血条同源）
//   · updateState(value:int) 按位掩码判断：CHARSTATE_GQM=4096(灰问号) / CHARSTATE_YEM=8192(黄叹号=可接)
//     / CHARSTATE_YQM=16384(黄问号=可交付)；命中调 addState('yem'/'yqm', stateBitmapY)
//   · addState（:2106-2140）：GlobalsLoader.getCharacter(text) 取 Fanvas MovieClip 挂入 stateSprite；
//     yem/yqm 还会按 NPC suitImg(EVERYDAY/ACTIVE) 做变色（单机版无该字段，播原色动画）。
//   · state 本身由服务端协议经 CharacterManager.updateCharacterSate 下发——单机版没有服务端，
//     故此处改由 config/talk.json + TalkState 本地推导（见下方 questMarkOf）。
//
// 单机推导口径（与 talk.js::clickNpc 列表同数据源、同判定，保证标记与面板一致）：
//   yem（可接）：data.tasks 中该 npcId 有「未接且未完成、前置任务已满足」的任务
//   yqm（可交付）：data.tasks 中有「已接且未完成、且交付 NPC 指向本 NPC」的任务
//   gqm（进行中）：data.tasks 的 nodes 里有 nodeType=challenge 节点指向本 NPC，且任务已接未完成、
//     对应怪物尚未杀够（用户需求：挑战目标 NPC 头顶标「任务进行中」，NPC 一直可见只改标记）
//   并存优先级：yqm（可交付）> gqm（进行中）> yem（可接）——取更可操作的图标，避免同锚点重叠
//   ⚠ 不再索引 listTasks（它只是任务名/图标的更准来源，clickNpc 不用它做出行判定），
//     否则 listTasks 独有条目会出现「头顶有标记、面板无任务行」的不一致。
//
// 懒加载（对齐 F6「仅当模型可见时才执行加载」）：
//   effect 的 swfData/images 由 loader.loadEffect 统一缓存，只有 NPC 落进「视口 + IO 带」
//   才 mount 画布；离屏已加载单位不卸载，其标记画布留在 f.el 内，由现有 _animCull 统一
//   pause/resume（不在本模块重复实现剔除）。切图时 _teardownActors 调 clear() 一次性停掉。

import { loadEffect, mount, destroyCanvas, anchorOrigin } from '../core/loader.js?v=20261007c';
import { Config } from '../core/globals.js?v=20261007c';

const IO_BAND = 300;   // 视口外余量（世界像素）：与 _ioCull 的 IO_LOAD_M 同量级
const TICK_MS = 250;   // 巡检频率 4Hz（覆盖相机移动 / 模型量测完成的延迟）
const RETRY_MS = 350;  // 模型头顶(_modelHeadY)尚未量到时的重试间隔

// ── 任务标记推导（纯函数，可脱离场景单测）──────────────────────────

let _idx = null;       // npcId(数字) → 该 NPC 相关条目 [{kind:'accept'|'task'|'challenge', t}]
let _byTask = null;    // taskId(String) → data.tasks 记录（列表条目反查交付人）

/** finishNpc 名字 → npcId 反向索引（talks 的 npcId→npcName 反查）。
 *  ⚠ 同名 NPC 取「与接取人不同 id」者（跨 NPC 交付语义上必然是另一个人），
 *    都同名则取最小 id。与 talk.js::_finishNpcByName 同口径。 */
let _name2npc = null;
function nameToNpcId(name, task) {
  if (!name) return null;
  if (!_name2npc) {
    _name2npc = new Map();
    const talks = ((Config.talk && Config.talk.data && Config.talk.data.talks) || []);
    for (const tk of talks) {
      const nm = String((tk && tk.npcName) || '').trim();
      if (!nm || tk.npcId == null) continue;
      if (!_name2npc.has(nm)) _name2npc.set(nm, []);
      _name2npc.get(nm).push(Number(tk.npcId));
    }
  }
  const cands = _name2npc.get(name);
  if (cands && cands.length) {
    const selfId = Number((task && task.npcId) || 0);
    const diff = cands.filter((id) => id !== selfId);
    return Math.min(...(diff.length ? diff : cands));
  }
  return null;
}

/** 从 finishNpc 解析「交付 NPC 的 id」：
 *  优先取节点合并写入的 finishNpcId（数字，= op30 type1 发包 NPC）；
 *  其次抓超链接里的 n:NNN（如 "event:x:8,y:83,m:109,n:93182" → 93182，跨 NPC 交付）；
 *  再次把纯名字（如「刘丰」）反查 talks 名字→id；
 *  都不行（给=交同一人）才回退任务自身 npcId。 */
function finishNpcIdOf(t) {
  if (t && t.finishNpcId != null && Number.isFinite(Number(t.finishNpcId)) && Number(t.finishNpcId) > 0) return Number(t.finishNpcId);
  const s = String((t && t.finishNpc) || '');
  let m = /[,;]n:(\d+)/.exec(s);
  if (!m) m = /\bn:(\d+)/.exec(s);
  if (m) return Number(m[1]);
  // ★ 纯名字反查；查不到才回退任务自身 npcId。⚠ 直接回退会让「A 接 / B 交」的任务
  //   错把 A 当交付人（用户报的 BUG 2/3/4 根因），标记与面板都会错。
  const nm = s.trim();
  if (nm && !/[<,;:]/.test(nm)) {
    const byName = nameToNpcId(nm, t);
    if (byName != null && byName > 0) return byName;
  }
  return (t && t.npcId != null && String(t.npcId) !== '') ? Number(t.npcId) : null;
}

function buildIndex() {
  if (_idx) return _idx;
  const d = (Config.talk && Config.talk.data) || {};
  const map = new Map();
  const byId = new Map();
  (d.tasks || []).forEach(t => { if (t && t.taskId != null) byId.set(String(t.taskId), t); });
  const put = (id, o) => {
    const k = Number(id);
    if (!Number.isFinite(k)) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(o);
  };
  // ★ 只按 tasks（任务详情）建索引，与 talk.js::clickNpc 的列表数据源完全一致。
  //   listTasks 只是「任务名/图标」的更准来源，单独索引会导致「头顶有标记、面板无任务行」
  //   的不一致（listTasks 独有条目无 tasks 详情，clickNpc 不出行）。
  //   任务名/图标改由 clickNpc 内部用 ltByBase 合并，标记系统不再需要 listTasks。
  (d.tasks || []).forEach(t => {
    put(finishNpcIdOf(t), { kind: 'task', t });
    // 接取人也索引一条（可接标记 yem 用：未接 + 前置满足）
    if (t.npcId != null) put(t.npcId, { kind: 'accept', t });
    // 挑战节点按 node.npcId 索引（gqm 进行中标记用）
    (t.nodes || []).forEach((n) => {
      if (n && n.nodeType === 'challenge' && n.npcId != null) put(n.npcId, { kind: 'challenge', t, node: n });
    });
  });
  _idx = map;
  _byTask = byId;
  return _idx;
}

/** talk.json 被（热）替换后重算索引 */
export function invalidateIndex() { _idx = null; _byTask = null; _name2npc = null; }

/** 计算 NPC 的任务标记：'yem'（可接 / 黄叹号）| 'yqm'（可交付 / 黄问号）| null
 *  npcId：地图 npcData.id（= talk.json 主键）；st：TalkState（accepted/finished 两个 Set） */
export function questMarkOf(npcId, st) {
  // ★ 物品提交条件的 got 来自背包，先同步一次再判定（killsDone 同口径）
  if (st && typeof st.syncItemGot === 'function') st.syncItemGot();
  const idx = buildIndex();
  const list = idx.get(Number(npcId));
  if (!list) return null;
  const accepted = (st && st.accepted) || new Set();
  const finished = (st && st.finished) || new Set();
  const me = Number(npcId);
  let canAccept = false, canDeliver = false, challengeActive = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const id = String(e.t.taskId);
    if (finished.has(id)) continue;
    if (e.kind === 'accept') {
      // 接取人处：未接 + 前置满足 → 可接（yem）；已接则由下方 'task' 分支按交付人判定
      if (!accepted.has(id) && (!e.t.preTask || finished.has(String(e.t.preTask)))) canAccept = true;
    } else if (e.kind === 'challenge') {
      // 挑战节点：已接未完成 + 对应怪物未杀够 → 本 NPC 可开战，属「有事找你」（yqm）。
      //   ⚠ 用户裁决（2026-10-07）：挑战目标 NPC 显黄问号（点 NPC 即可开战），
      //     「进行中 gqm」只留给交付人未满足条件的场合（见下方 task 分支）。
      if (accepted.has(id)) {
        const mn = String((e.node && e.node.monster) || '');
        const km = st && st.kills ? st.kills.get(id) : null;
        const cur = mn ? (km && km.get(mn)) : null;
        if (!cur || cur.got < cur.need) canDeliver = true;
      }
    } else {
      // 任务详情（按交付人索引）：已接未完成且交付人=本 NPC → 可交付（yqm）
      // ⚠ 跨 NPC 交付（给=A、交=B）：finishNpcIdOf 解析交付人；解析不到时回退任务自身 npcId
      //   （给=交同一人），与 talk.js::_finishNpcIdOf 同口径。
      // ⚠ 杀怪/物品条件未满足时不能交（对齐 clickNpc 的 canFinish 判定）→ 进行中（gqm），
      //   避免头顶可交付但面板点任务出完成文案的不一致（用户 bug①）。
      if (accepted.has(id)) {
        const fin = finishNpcIdOf(e.t);
        if (fin == null || fin === me) {
          if (st && typeof st.killsDone === 'function' && !st.killsDone(id)) challengeActive = true;
          else canDeliver = true;
        }
      }
    }
  }
  return canDeliver ? 'yqm' : (challengeActive ? 'gqm' : (canAccept ? 'yem' : null));
}
// debug/探针用（纯函数，无副作用）
if (typeof window !== 'undefined') window.__TS_QUEST_MARK_OF = questMarkOf;

// ── 场景级管理器（每个 MainScene 一个）──────────────────────────

export class NpcQuestMarks {
  constructor(scene) {
    this.scene = scene;
    this._t = 0;
    if (typeof window !== 'undefined') window.__TS_QUEST_MARKS = this;
  }

  get state() { return (typeof window !== 'undefined') ? window.__TS_TALK_STATE : null; }

  /** NPC 是否落在「视口 + IO 带」内（与 _ioCull/_animCull 同款相机判定） */
  _inView(f) {
    const cam = this.scene.camera;
    if (!cam) return true;
    const vw = window.innerWidth, vh = window.innerHeight;
    const sx = f.x - cam.x, sy = f.y - cam.y;
    return sx > -IO_BAND && sx < vw + IO_BAND && sy > -IO_BAND && sy < vh + IO_BAND;
  }

  /** 低频巡检：把 「想要标记但未挂」 的 NPC 补挂（懒加载的兑现通道） */
  tick(now) {
    if (!now || now - this._t < TICK_MS) return;
    this._t = now;
    const npcs = this.scene.npcs;
    if (!npcs || !npcs.length) return;
    for (let i = 0; i < npcs.length; i++) this.refreshOne(npcs[i]);
  }

  /** 全量刷新（任务状态变化时调用） */
  refresh() {
    const npcs = this.scene.npcs;
    if (!npcs) return;
    for (let i = 0; i < npcs.length; i++) this.refreshOne(npcs[i]);
  }

  /** 单个 NPC：按当前任务状态推导想要什么标记，视口内才挂 / 变了才换 */
  refreshOne(f) {
    if (!f || !f.el || !f.el.isConnected) return;
    if (f === this.scene.player) return;
    const n = f.npcData;
    if (!n || n.type === 'monster') return;   // 明雷怪不挂任务标记
    const want = questMarkOf(n.id, this.state);
    const cur = f._qmark ? f._qmark.kind : null;
    if (want === cur) return;                 // 未变（同为 null 也含）
    if (cur) this._unmount(f);                // 换 / 删：先摘旧
    if (!want) return;
    if (!this._inView(f)) return;             // 懒加载：不在视口带内先记账，tick 兜
    this._mount(f, want);
  }

  /** 挂上某个标记动画到模型头顶（对齐 AS3 addState + stateBitmapY） */
  async _mount(f, kind) {
    if (f._qmark) this._unmount(f);
    const headY = f._modelHeadY;              // 负：头顶在脚底上方（量测后才有）
    if (headY == null) {
      // 模型包围盒尚未量到（stand() 异步加载中）→ 稍后重试，tick 也会再进来
      setTimeout(() => { this.refreshOne(f); }, RETRY_MS);
      return;
    }
    // AS3 CurrentPanelNpc.as:2077~2083：stateBitmapY = mcHeight>450 ? -90 : -mcHeight+20，
    //   mcHeight = mc.height = 【站立帧包围盒高】（CurrentPanelNpc.as:556，不封顶；封顶 120 是
    //   Fighter.as:317 战斗血条的特例，与本处无关）。
    //   本端口对应量 = fighter._mcHeightRaw（= canon.rectH*scale，站立池包围盒高），与血条同源。
    // ⚠ 不可用 _modelHeadY（= 头顶到 AS3 原点 = footTop-footY）：它比 mcHeight 少
    //   「rect 底边到原点」一段（脚锚 rootAnchor(256,256) 通常在 rect 底边上方），
    //   用错会让标记整体偏低（如 202036：rectH=171 vs headTop=-160，差 11px）。
    const mcH = (f._mcHeightRaw != null) ? f._mcHeightRaw : (-headY);   // 正高度；fallback 旧口径
    const y = (mcH > 450) ? -90 : (-mcH + 20);
    const npcData = f.npcData;                // 异步竞态锚点（池复用会换 npcData）
    const wrap = document.createElement('div');
    wrap.className = 'npc-quest-mark';
    wrap.style.cssText = 'position:absolute;left:0;top:' + y + 'px;width:0;height:0;pointer-events:none;z-index:55;';
    f.el.appendChild(wrap);
    f._qmark = { kind, wrap, canvas: null };
    let rec;
    try { rec = await loadEffect(kind); }
    catch (e) {
      console.warn('[quest-mark] 特效加载失败', kind, e);
      if (f._qmark && f._qmark.wrap === wrap && f.npcData === npcData) f._qmark = null;
      wrap.remove();
      return;
    }
    // 异步期间可能已切图 / 换标记 / 池复用：校验仍有效再落画布
    if (!f._qmark || f._qmark.wrap !== wrap || !wrap.isConnected || f.npcData !== npcData) {
      if (rec && rec.canvas) destroyCanvas(rec.canvas);
      wrap.remove();
      return;
    }
    const canvas = mount(wrap, rec.swfData, rec.main, rec.imagePath, { loop: true, scale: 1 });
    // Flash 原点(图标底部)落在 stateBitmapY 点（容器已定位到头顶）——与 stateSprite 同语义
    anchorOrigin(canvas, rec.swfData, rec.main, { x: 0, y: 0 });
    f._qmark.canvas = canvas;
  }

  _unmount(f) {
    const m = f._qmark;
    if (!m) return;
    if (m.canvas) destroyCanvas(m.canvas);          // 先 pause 停 Timer，再摘 DOM
    if (m.wrap && m.wrap.parentNode) m.wrap.remove();
    f._qmark = null;
  }

  /** 切图清理：停掉全部已挂标记（池实例保留 DOM，但 Timer 必须停） */
  clear() {
    const npcs = this.scene.npcs || [];
    for (let i = 0; i < npcs.length; i++) this._unmount(npcs[i]);
  }

  /** 场景销毁：clear + 摘除全局引用 */
  destroy() {
    this.clear();
    if (typeof window !== 'undefined' && window.__TS_QUEST_MARKS === this) {
      window.__TS_QUEST_MARKS = null;
    }
  }
}