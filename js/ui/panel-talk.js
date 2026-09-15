// panel-talk.js
// 对话/任务面板 —— 1:1 绝对坐标复刻 AS3（方案 A：layout.xml 原始像素，各阶段面板尺寸随 AS3 变化）
//   deobfuscated/panel/task/TalkPanel.as        （updatePanel 状态机：resetSize / resetHeader / resetContentSize）
//   deobfuscated/panel/task/TalkRight.as        （右侧任务列表 scrollPane：分组标题 + FigureSprite 行）
//   deobfuscated/panel/task/DescTaskPanel.as    （任务描述：难度星 / 适宜等级 / 五段正文 / 奖励）
//   deobfuscated/panel/task/FinishItem.as       （可选奖励网格，点击选中 → currItemId）
//   deobfuscated/panel/task/EquipItemPanel.as   （上交装备单格）
//   deobfuscated/panel/task/TaskContribution.as （帮派贡献）
//   deobfuscated/panel/MallPanel.as             （resetHeader=标题图 text_panel_title_*；setXY 居中 400,300）
//
// 坐标真源：config/talk.json ← D:/tsqt/Game/update/i18n/zh_CN/layout.xml
// 渲染容器：BasePanel.body 内联全 bleed（inset:0 / padding:0 / overflow:visible），
//          全部子元素 position:absolute 用 AS3 原始坐标；面板尺寸随阶段切换（resetSize），
//          九宫格底板按尺寸缓存重烘焙（bgEngine.bakeIfVisible）。
// 文案真源：config/talk.json ← update/i18n/zh_CN/Lang/zh_CN.as（经 GlobalsGlobal06 常量值索引）
// 资源名→文件：去下划线 + 小写 + .png；目录由 config.res 实测决定（Resource/icons 或 LoginResource/icons）
//
// ⚠ 严禁触碰战斗系统：本文件不引用 battle/*、不改 skill-engine.js。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import { talkSys, S, ACT } from '../quest/talk.js?v=20261007c';
import { panelManager } from './panel-manager.js?v=20261007c';
import { pet as petView } from '../pet/pet.js?v=20261007c';
import { petState } from '../pet/pet-state.js?v=20261007c';
// 滚动区复用项目自带组件库（对齐 AS3 fl.containers.ScrollPane 的自定义滚动条）
import './components/index.js?v=20261007c';
import { showItemTip, hideItemTip } from './panels.js?v=20261007c';

// ───────────────────────── 配置读取 ─────────────────────────
const CFG = () => Config.talk || {};
const L = (g, k) => ((CFG().layout || {})[g] || {})[k] || {};
const ZH = (k) => (((CFG().lang || {})[k]) || {}).zh ?? '';
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** 资源图：目录由 config.res（生成器逐目录实测）决定，缺失不臆造 */
const IMG = (k) => {
  const tag = (CFG().res || {})[k];
  if (!tag) return '';
  const f = String(k).replace(/_/g, '').toLowerCase() + '.png';
  return tag === 'loginResource' ? url.resLogin(f) : url.res(f);
};

// 物品图标：抓包 bonusItem/choiceItem 的 image 是道具模板 id，美术在
//   update/ItemIcon/icons/Item_<9位补零>.png（与 panels.js itemIconSrcs 同源，实测 100% 命中）
const itemIcon = (id) => {
  const n = String(id || '').replace(/[^0-9]/g, '');
  if (!n) return '';
  return url.icon('item', 'Item_' + n.padStart(9, '0') + '.png');
};
const stripTags = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** 解析任务超链接 event:x:X,y:Y,m:M,n:N（顺序可乱，AS3 固定 x,y,m,n）→ {x,y,m,n}；缺字段返回 null */
function parseNpcLink(href) {
  const s = String(href || '');
  if (!/^event:/i.test(s)) return null;
  const g = (k) => { const m = new RegExp('\\b' + k + ':(-?\\d+)').exec(s); return m ? Number(m[1]) : NaN; };
  const x = g('x'), y = g('y'), m = g('m'), n = g('n');
  if (![x, y, m, n].every(Number.isFinite)) return null;
  return { x, y, m, n };
}

/** AS3 TextField.htmlText 语义：只放行 font(color/size)、br、a(event:x,y,m,n 超链接)、u/b/i；其余转义（防注入） */
function rich(s) {
  const str = String(s == null ? '' : s);
  const re = /<a\b[^>]*>|<\/a>|<\/?(?:u|b|i)>|<font\b[^>]*>|<\/font>|<br\s*\/?>/gi;
  let out = '', last = 0, m, inLink = false;
  while ((m = re.exec(str))) {
    out += esc(str.slice(last, m.index));
    const raw = m[0];
    if (/^<\/a/i.test(raw)) {
      // 只在配对到已放行的 <a> 时输出闭合标签（非法/不支持链接的 <a> 整对丢弃）
      if (inLink) { out += '</a>'; inLink = false; }
    }
    else if (/^<\/font/i.test(raw)) out += '</font>';
    else if (/^<br/i.test(raw)) out += '<br/>';
    else if (/^<a\b/i.test(raw)) {
      // ★ NPC 自动寻路超链接：清洗后重发规范 href，点击由 _wireNpcLinks 委托处理
      const href = (raw.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      const p = parseNpcLink(href);
      if (p) {
        out += '<a href="event:x:' + p.x + ',y:' + p.y + ',m:' + p.m + ',n:' + p.n + '" data-npclink="1">';
        inLink = true;
      } else inLink = false;   // 非任务 NPC 链接：丢弃开标签，其 </a> 也同步丢弃
    }
    else if (/^<\/?(u|b|i)>/i.test(raw)) out += raw.toLowerCase().replace(/\s+/g, '');
    else {
      const c = (raw.match(/color\s*=\s*["']?([#\w(),.%\s-]+)["']?/i) || [])[1];
      const z = (raw.match(/size\s*=\s*["']?(\d+)["']?/i) || [])[1];
      out += '<font' + (c ? ` color="${esc(c)}"` : '') + (z ? ` style="font-size:${Number(z)}px"` : '') + '>';
    }
    last = re.lastIndex;
  }
  return out + esc(str.slice(last));
}

/** 阶段名（调试/断言用） */
const STAGE_NAME = {
  0: '（未打开）', 1: 'TASK_OPERATION_LIST', 2: 'TASK_DESCRIBE', 3: 'TASK_OVER',
  4: 'TASK_PROCESS', 5: 'TASK_DIAGNOSES', 6: 'TASK_CARRYOVER', 7: 'TASK_GANG_CONTRIBUTION',
  8: 'TASK_CHAT',
};

/** 分组颜色（TalkPanel.getFuncList 硬编码 uint） */
const GROUP_COLOR = { '-1': '#902B0E', 0: '#0B911B', 1: '#211160' }; // 9448206=0x902B0E / 757787=0x0B911B / 2165648=0x211160

/** attrSprite 原点（TalkPanel_attr.x=215；y=0）—— DescriTaskPanel / TalkRight / TaskContribution 的父容器 */
const ATTR_X = 215;
/** DescTaskPanel 正文区宽（TaskDescPanel_frame.width = frameWidth，布局实测 250） */
const DESC_W = 250;

/** 阶段 → 面板尺寸键 + 标题图（对齐 AS3 updatePanel 的 resetSize / resetHeader） */
const STAGE_CONF = {
  [S.LIST]:      { size: 'TalkPanel',        title: 'talk',    equip20: false }, // 445×308
  [S.DESCRIBE]:  { size: 'TalkPanel_task',   title: 'mission', equip20: false }, // 489×458
  [S.OVER]:      { size: 'TalkPanel_finish', title: 'mission', equip20: true },  // 230×345（+20 带装备）
  [S.PROCESS]:   { size: 'TalkPanel_step',   title: 'mission', equip20: false }, // 230×345
  [S.DIAGNOSES]: { size: 'TalkPanel_qa',     title: 'talk',    equip20: false }, // 230×345
  [S.CARRYOVER]: { size: 'TalkPanel_tip',    title: 'talk',    equip20: true },  // 230×345（+20 带装备）
  [S.GANG]:      { size: 'TalkPanel',        title: 'talk',    equip20: false }, // 445×308
};

// ───────────────────────── 主面板 ─────────────────────────
export class TalkPanel extends BasePanel {
  constructor(ui) {
    // 最大阶段 489×458（TASK_DESCRIBE：TalkPanel_task）由 _setSize 按阶段切换；
    // isNpcPanel：纳入 PanelManager 的 NPC 距离巡检（远离 NPC 自动关闭，对齐 AS3
    //   PanelManager.caculateNpcPanel：曼哈顿距离 > MaxDistance(150) 即关 currentNpcPanel）。
    super({ id: 'panel-talk', title: '对话', width: 445, height: 308, ui, isNpcPanel: true });
    this._init();
  }

  // ⚠ BasePanel 在 super() 内就会调 init()→render()，子类字段尚未赋值 ⇒ 一律 _init() 惰性化
  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this.sys = talkSys();
    this._equip = null;          // 上交装备（EquipItemPanel 单格）
    this._listSrc = '';          // TalkRight 滚动内容（render 生成、_wire 装入 scrollpane）
    this.sys.net.on((op, pkt) => this._onSC(op, pkt));
  }

  get st() { this._init(); return this.sys.state; }

  init() { this.render(); }
  onOpen() { this._init(); if (!this.st.stage) this.openList(this.st.npcId || 1001); else this.render(); }
  // 由 ui.openPanel('talk', { npcId }) 注入：直接打开指定 NPC 的对话/任务/功能列表
  applyOpenOpts(opts) {
    if (!opts || opts.npcId == null) return;
    // scene._openTalk 从地图 npcData 带入：dialog/desc 闲聊兜底、hubTeleport=hub 传送
    this._ctx = {
      dialog: opts.dialog || '',
      desc: opts.desc || '',
      hubTeleport: !!opts.hubTeleport,
      npcName: opts.npcName || '',
    };
    this.openList(num(opts.npcId, 0));
  }

  // ══════════ SC 派发（语义等价 HandlerHandler02） ══════════
  _onSC(op, p) {
    const st = this.st;
    // ★ 自动开下一环：面板已关闭时收到「内容型 SC」（如 _autoOpenNext 的 selectTask 派发）先打开再渲染。
    //   ⚠ 关面板/状态型 SC（SC_TALK_CLOSE 之后紧跟着的 SC_TASK_STATUS 等）不得触发重开，
    //   否则接取/完成刚关的面板会被 SC_TASK_STATUS 又打开一次（open→onOpen→stage==0→openList）。
    const CONTENT_SC = ['SC_SHOW_TASK_LIST', 'SC_SHOW_TASK_DLG', 'SC_SHOW_TALK_DLG',
      'SC_SHOW_OPTION_DLG', 'SC_GANG_CONTRIBUTION', 'SC_NPC_FUNCTION', 'SC_CHALLENGE_START'];
    if (CONTENT_SC.indexOf(op) >= 0 && this.dom && this.dom.style.display === 'none') this.open();
    switch (op) {
      case 'SC_TALK_CLOSE': {
        // 对齐 AS3：接取/完成/继续任务后服务端关面板（单机由 taskAction 派发）
        this.close();
        break;
      }
      case 'SC_SHOW_TASK_LIST': {
        const P = (CFG().proto || {});
        st.logPush('SC', P.SC_SHOW_TASK_LIST, 'npc=' + p.npcName + ' 任务 ' + p.tasks.length);
        if (p._empty) {
          // 三无 NPC：不弹空面板（列表不再单独占一栏）
          this.close();
          this.ui && this.ui.toast('该 NPC 暂无对话与任务');
          break;
        }
        st.npcId = p.npcId; st.npcName = p.npcName; st.npcImg = p.npcImg;
        this.setContents(p.content);
        this.updateFunctionArea(p.tasks, p.npcId);
        this.updatePanel(S.LIST);
        break;
      }
      case 'SC_SHOW_TASK_DLG': {
        const P = (CFG().proto || {});
        st.logPush('SC', P.SC_SHOW_TASK_DLG, 'task=' + p.taskId + ' type=' + p.type);
        st.npcId = p.npcId; st.npcName = p.npcName; st.npcImg = p.npcImg;
        st.taskOver = false;                       // 清交付小窗标记，防残留
        this.updateDescArea(p.taskObj);
        this.updateChoseItem((p.taskObj && p.taskObj.choiceItem) || []);
        this.setContents(p.content, !!(p.taskObj && p.taskObj.memberList), p.taskObj && p.taskObj.memberList);
        this.updatePanel(p.type === 0 ? S.DESCRIBE : (p.type === 1 ? S.OVER : S.CARRYOVER));
        break;
      }
      case 'SC_SHOW_TALK_DLG': {
        const P = (CFG().proto || {});
        st.logPush('SC', P.SC_SHOW_TALK_DLG, 'npc=' + p.npcName + (p.taskOver ? ' taskOver' : ''));
        st.npcId = p.npcId; st.npcName = p.npcName; st.npcImg = p.npcImg;
        if (p.taskId) st.taskId = String(p.taskId);
        // ★ 需求2：带 taskOver ⇒ 可交付任务的交付小窗（PROCESS 230×345，按钮改「完成任务」）
        st.taskOver = !!p.taskOver;
        this.setContents(p.content);
        this.updatePanel(S.PROCESS);
        break;
      }
      case 'SC_SHOW_OPTION_DLG': {
        const P = (CFG().proto || {});
        st.logPush('SC', P.SC_SHOW_OPTION_DLG, 'tag=' + p.tag + ' 选项 ' + (p.options || []).length);
        // ⚠ updatePanel(S.DIAGNOSES, ...) 内部会用 rest[0..2] 覆盖 tag/npcId/taskId，
        //   必须把 p.tag/p.npcId/p.taskId 一并传入，否则 tag 被覆盖成 undefined（selectOption 分流失效）
        st.options = Array.isArray(p.options) ? p.options.slice() : [];   // 选项按钮（挑战对话的 ◆挑战它/◆.稍作准备）
        // ★ 用户 bug（2026-10-07）：挑战对话的头部必须随所点 NPC 走。
        //   此前本分支只更新 tag/npcId/taskId，没更新 npcName/npcImg ⇒ 头部残留上一个阶段
        //   （如任务列表）的 NPC 名字与头像，与「点的是谁」不一致。talk.js 已保证三个字段同源。
        st.npcName = p.npcName; st.npcImg = p.npcImg;
        this.updatePanel(S.DIAGNOSES, p.tag, p.npcId, p.taskId);
        this.setContents(p.content, true);
        break;
      }
      case 'SC_CHALLENGE_START': {
        // ★ 挑战对话选「◆挑战它」：talk.js 只组数据，进战斗由本面板执行（talk.js 铁律不碰战斗代码）。
        //   关面板 → sm.enterBattle；失败兜底 toast，不硬锁。
        this.close();
        const sm = panelManager.context && panelManager.context.sm;
        if (!sm || typeof sm.enterBattle !== 'function') { this.ui && this.ui.toast('进入战斗失败'); break; }
        try { sm.enterBattle(p.monsterNpc); }
        catch (e) { console.error('[talk] 挑战进战斗失败：', e); this.ui && this.ui.toast('进入战斗失败'); }
        break;
      }
      case 'SC_GANG_CONTRIBUTION': {
        st.contrib = p; this.updateContributionPanel(p.type); break;
      }
      case 'SC_CLOSE_CONTRIBUTION_PANEL': {
        st.contrib = null; this.close(); break;
      }
      case 'SC_NPC_FUNCTION': {
        st.npcId = p.npcId;
        this._doFunction(p);      // 功能条目本地路由（店/治疗/仓库/…）
        break;
      }
      case 'SC_TASK_STATUS': break;
      default: break;
    }
    this.render();
  }

  // ══════════ TalkPanel 公开方法（1:1 对齐 AS3 同名方法） ══════════

  /** updateheader(imgKey, nameText) —— 刷新 NPC 头像与名称 */
  updateheader(imgKey, name) { this.st.npcImg = imgKey; this.st.npcName = name; }

  /** setContents(text, interactive?, memberList?) */
  setContents(text, interactive, memberList) {
    this.st.content = String(text || '');
    this.st.contentInteractive = !!interactive;
    if (memberList) this.st.content += ZH('TASK_MEMBERLIST') + memberList + '</font>';
  }

  /** updateFunctionArea(list, npcId) —— 分组后交给 TalkRight */
  updateFunctionArea(list, npcId) {
    this.st.npcId = npcId;
    this.st.groups = this.getFuncList(list || []);
  }

  /** updateDescArea(taskObj) —— showAccept==1 时隐藏「接取」并把「取消」换成「确认」 */
  updateDescArea(taskObj) {
    this.st.taskObj = taskObj || null;
    this.st.taskId = taskObj ? String(taskObj.taskId) : '';
    this.st.npcId = taskObj ? taskObj.npcId : this.st.npcId;
  }

  /** updateChoseItem(list) —— 可选奖励网格 */
  updateChoseItem(list) {
    this.st.choiceItem = list || [];
    this.st.choiceSel = -1;
  }

  /**
   * updatePanel(stage, ...rest) —— 核心状态机。
   * 每次都先清掉上一步的按钮/子区（对应 AS3 开头 7 行 removeChild）。
   */
  updatePanel(stage, ...rest) {
    this.st.stage = stage;
    // ★ 离开 DIAGNOSES 时清选项（防上一次挑战对话的「◆挑战它」残留到问答/交付阶段）
    if (stage !== S.DIAGNOSES) this.st.options = [];
    this.st.needEquip = stage === S.OVER || stage === S.CARRYOVER ? (rest[0] != null) : false;
    if (stage === S.DIAGNOSES) { this.st.tag = rest[0]; this.st.npcId = rest[1]; this.st.taskId = rest[2]; }
    if (stage === S.CARRYOVER && rest[0] != null) this.st.carryValue = rest[0];
    if (stage === S.OVER) this.st.choiceSel = -1;
    this._equip = null;
  }

  /** updateContributionPanel(type) —— 帮派贡献 */
  updateContributionPanel(type) { this.st.stage = S.GANG; this.st.contribType = type; }

  /** getFuncList(list) —— 按 taskState 分三组：-1 功能 / 0 可接 / 1 已接 */
  getFuncList(list) {
    const g = { '-1': [], 0: [], 1: [] };
    for (const t of list) {
      const s = String(num(t.taskState, 0));
      (g[s] || g[0]).push(t);
    }
    return [
      { title: ZH('TASK_FUNCTION'), color: GROUP_COLOR['-1'], task: g['-1'], defaultIcon: '' },
      { title: ZH('TASK_ACCEPT'), color: '#0B911B', task: g[0], defaultIcon: '10012' },
      { title: ZH('TASK_ACCEPTED'), color: '#211160', task: g[1], defaultIcon: '10015' },
    ];
  }

  /** 单机入口：模拟点击 NPC（CS_CLICK_NPC → SC_SHOW_TASK_LIST） */
  openList(npcId) { this.sys.net.clickNpc(num(npcId, 1001), this._ctx || null); }

  // ══════════ 渲染（1:1 绝对坐标：AS3 layout.xml 原始像素） ══════════
  // 结构（对齐 AS3 显示列表）：
  //   head(25,53) + npcName(87,~95)       ← initHeader
  //   contentArea(x,120,190,h)            ← initContentField + resetContentSize
  //   attrSprite@(215,0)                   ← LIST→TalkRight / DESCRIBE→DescTaskPanel / GANG→TaskContribution
  //   finishSprite / equipItemSprite       ← OVER 分支
  //   阶段按钮                             ← initButton（每阶段显隐）
  render() {
    const st = this.st;
    const conf = STAGE_CONF[st.stage] || STAGE_CONF[S.LIST];
    // 用户原设计：LIST（头像 + 闲聊 + 功能/任务列表）阶段走 295×465 流式分区面板；
    // 只有「切到接取/交付等任务详情」阶段才用下方 AS3 1:1 绝对坐标复刻版
    if (st.stage === S.LIST) return this._renderListLegacy();
    const lay = L('TalkPanel', conf.size);
    hideItemTip();   // 重渲染前清除上一帧的物品富文本窗（面板销毁/阶段切换时跟随关闭）
    const W = num(lay.w, 445);
    const H = num(lay.h, 308) + (conf.equip20 && st.needEquip ? 20 : 0);
    this._setSize(W, H);
    this._setTitle(conf.title);

    // body 全 bleed：绝对定位容器，子元素全部 position:absolute（AS3 Sprite 不裁剪子级）
    this.body.setAttribute('style',
      'position:absolute;inset:0;padding:0;border:0;background:transparent;overflow:visible;z-index:4');

    const parts = [];
    parts.push(this._headHtml());                       // updateheader
    if (this._hasContent()) parts.push(this._contentHtml());   // contentArea
    if (st.stage === S.LIST) parts.push(this._listHtml());     // TalkRight（attrSprite）
    else if (st.stage === S.DESCRIBE) parts.push(this._descHtml());   // DescTaskPanel
    else if (st.stage === S.GANG) parts.push(this._contribHtml());    // TaskContribution
    if (st.stage === S.OVER) parts.push(this._finishHtml());    // finishSprite（可选奖励）
    if (st.stage === S.OVER || st.stage === S.CARRYOVER) parts.push(this._equipHtml()); // equipItemSprite
    const btns = this._buttonsHtml();                            // 阶段按钮
    if (btns) parts.push(btns);

    this.body.innerHTML = parts.join('');
    this._wire();
  }

  /** resetSize(w,h) —— 面板尺寸随阶段切换；九宫格底板按尺寸缓存，尺寸不变不重烘 */
  // ══════════ 用户原设计：LIST 阶段（头像 + 闲聊 + 功能/任务列表）面板 ══════════
  // 295×465 固定尺寸（与人物属性面板同高），流式分区：头像+名字 / 闲聊正文（固定区，
  //   超长限高自身滚动）/ 滚动区（ts-scrollpane 自定义滚动条装任务列表）/ 阶段按钮，
  //   段落之间分隔线隔开；空分组不占行，三分组全空时滚动区整段隐藏。
  // ★ 入口：render() 在 S.LIST 早退到这里；只有「切到接取/交付等任务详情阶段」
  //   才走 AS3 1:1 绝对坐标复刻版（render 主分支，layout.xml 原始坐标）。
  _renderListLegacy() {
    const st = this.st;
    this._setSize(295, 465);             // 原设计尺寸（人物属性面板同款）
    this.dom.style.overflow = 'hidden';
    this._setTitle('talk');             // 从详情阶段的 mission 标题复位
    // body 恢复 BasePanel 默认流式（AS3 分支把它改成了绝对坐标容器）
    this.body.setAttribute('style', '');
    // ⚠ 禁用 pb-body 的全局 overflow:auto（css/style.css）：
    //   LIST 阶段的滚动全部交给 ts-scrollpane 的 ts-scrollbar，body 自带的原生滚动条
    //   会与自定义滚动条并存（苏小胖面板曾同时出现两条原生滚动条）
    this.body.style.overflow = 'hidden';
    const SEP = '<div style="border-top:1px solid #66471B;margin:6px 0"></div>';
    const attr = this._talkRightHtml();  // LIST 滚动区只装任务/功能列表
    const fin = this._finishHtml();      // LIST 阶段恒为空（详情阶段才有），保持调用与旧版一致
    const eq = this._equipHtml();        // 同上
    const btns = this._buttonsHtml();    // 同上
    const hasContent = String(st.content || '').replace(/<[^>]*>/g, '').trim().length > 0;
    // 闲聊正文：有任务列表时并入 pane 的 source（与列表共用 ts-scrollbar，面板全局只保留
    // 这一个自定义滚动条）；纯对话 NPC（listEmpty）无 pane，则作为 wrap 内的普通段直接渲染。
    // 两种情况都不再用 div 自带的 max-height+overflow:auto，那样会冒出浏览器原生滚动条。
    const contentHtml = hasContent
      ? '<div style="flex:none;padding:0 4px;color:#000;font-size:12px;line-height:1.5">' + rich(st.content) + '</div>'
      : '';
    // ⚠ ts-scrollpane::_instantiateSource 对 HTML 字符串只取 firstElementChild，
    //   多个并列顶层节点会被丢弃；正文与列表必须包进同一个根 div。
    const mid = '<div>' + contentHtml +
      '<div style="padding:2px 4px">' +
        (attr ? '<div class="tk-attr" style="position:static">' + attr + '</div>' : '') +
        (fin ? SEP + fin : '') +
        (eq ? SEP + eq : '') +
      '</div></div>';

    const head = '<div style="flex:none;display:flex;align-items:center;gap:8px;padding:2px 4px 0">' +
        '<div class="tk-head" style="position:relative;width:56px;height:56px;flex:0 0 56px">' +
          this._portraitImg() +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="tk-npcname" style="position:static;width:auto;color:#902B0E">' + rich(st.npcName) + '</div>' +
        '</div>' +
      '</div>';

    // 列表为空（三个分组都无条目）时隐藏滚动区，不单独占一栏
    const listEmpty = !(st.groups || []).some((g) => (g.task || []).length);
    // 分隔线只在「两个实际渲染段」之间插入（避免头/尾出现孤立分隔线）
    const parts = [];
    const add = (el) => { if (parts.length) parts.push(SEP); parts.push(el); };
    add(head);
    if (!listEmpty) {
      // 有任务列表：talkText 已在 pane source 内（mid），随 ts-scrollbar 一起滚动
      // flex:none 必须：setSize 设的是「内容自然高度」，作为 flex item 会被容器压缩，
      // 导致 style.height（= this.height，drawLayout 依此布置 clip 与滚动条）与实际渲染高度
      // 不一致 —— clip 比 pane 还高，内容在 clip 里不滚（maxV=0）、滚动条落在 pane 可视区外被裁。
      add('<ts-scrollpane style="min-height:0;width:100%;display:block;overflow:hidden;position:relative;flex:none"></ts-scrollpane>');
    } else if (hasContent) {
      // 纯对话 NPC（三个分组都无条目）：无滚动区，talkText 直接渲染，不进任何滚动条
      add(contentHtml);
    }
    if (btns) {
      add('<div style="flex:none;padding:0 4px"><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' + btns + '</div></div>');
    }

    this.body.innerHTML = '<div class="tk-wrap" style="height:100%;display:flex;flex-direction:column;gap:0;padding:0;box-sizing:border-box">' + parts.join('') + '</div>';
    this._wireLegacy(mid);
    this._fitHeight();
  }

  /** legacy LIST 滚动区内容（= bak_as3 的 _attrHtml LIST 分支：3 分组任务列表，空分组隐藏） */
  _attrHtml() {
    if (this.st.stage === S.GANG) return this._contribHtml();
    return this._talkRightHtml();
  }
  _talkRightHtml() {
    const TR = L('TalkRight');
    const iconX = Math.max(num((TR.TalkRight_icon || {}).x, 3), 0);
    // 没有条目的分组（如「可接任务：」「已接任务：」）自动隐藏，不占行
    const groups = (this.st.groups || []).filter((g) => (g.task || []).length > 0);
    const html = groups.map((grp, i) => {
      const rows = (grp.task || []).map((t) => {
        // FigureSprite.as:56-64 — 资源 key = npc_taskicon_<icon|defaultIcon|10016> ⇒ 文件名 npctaskicon<N>.png
        const ico = String(t.icon || grp.defaultIcon || '10016');
        return `<div class="tk-ti" data-task="${esc(t.taskId)}" style="position:static;max-width:100%;padding-left:${iconX}px">
            <img class="tk-ti-ic" src="${url.res('npctaskicon' + ico + '.png')}" alt="" onerror="this.style.display='none'"/>
            <span class="tk-ti-n" style="color:#000">${esc(t.taskName)}</span>
          </div>`;
      }).join('');
      const sep = i ? '<div style="border-top:1px dotted #3a2a18;margin:6px 0 2px"></div>' : '';
      return sep + `<div class="tk-tg-t" style="position:static;color:${grp.color}">${esc(grp.title)}</div>` + rows;
    }).join('');
    return `<div class="tk-right" style="position:static;width:auto;height:auto;overflow:visible">
        <div class="tk-right-scroll" style="position:static;width:auto;height:auto;overflow:visible">${html}</div>
      </div>`;
  }
  _wireLegacy(mid) {
    const b = this.body;
    const q = (s) => b.querySelector(s);
    const qa = (s) => Array.from(b.querySelectorAll(s));

    // 中间滚动区：ts-scrollpane（复刻原版 fl 自定义滚动条）装载内容
    const pane = q('ts-scrollpane');
    if (pane) {
      // 组件皮肤依赖 ts-components.css，游戏默认未加载，按需注入一次（不改任何 CSS 文件）
      const reflow = () => { pane.invalidateContent(); this._fitHeight(); };   // CSS/图标异步到达后内容高度变化，重算滚动范围 + 重算面板高度
      let css = document.querySelector('link[data-ts-components]');
      if (!css) {
        css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'js/ui/components/ts-components.css';
        css.setAttribute('data-ts-components', '1');
        css.onload = reflow;
        document.head.appendChild(css);
      }
      // 透明化 ScrollPane 自带白底皮肤以贴合本面板深色木纹（仅内联样式）
      const bg = pane.querySelector('.ts-bg');
      if (bg) { bg.style.background = 'transparent'; bg.style.borderColor = 'transparent'; }
      // source 模式插入内容（元素已连接，configUI 已执行，_contentClip 就绪）
      pane.source = mid;
      setTimeout(reflow, 400);
    }

    // 任务列表条目 → sendSelectTask
    qa('[data-task]').forEach((el) => {
      el.onclick = () => this.sys.net.selectTask(this.st.npcId, el.dataset.task);
    });
    // 任务描述里的 NPC 名超链接 → 自动寻路（event:x,y,m,n）
    this._wireNpcLinks(qa);
    // 可选奖励 → FinishItem.showSelectGrid
    qa('[data-choice]').forEach((el) => {
      el.onclick = () => { this.st.choiceSel = num(el.dataset.choice); this.render(); };
    });
    // 上交装备格（拖拽依赖 ItemPanel03，清单内；此处点击放入占位，明确标注）
    qa('[data-equip]').forEach((el) => {
      el.onclick = () => {
        this._equip = this._equip ? null : { name: '（示例装备）' };
        this.ui && this.ui.toast(this._equip ? '已放入装备（示例；真实拖拽依赖 ItemPanel03）' : '已取出');
        this.render();
      };
    });

    qa('[data-act]').forEach((el) => {
      const a = el.dataset.act;
      if (a === 'click') return;
      el.onclick = () => this._buttonHandler(a, el);
    });
  }
  _fitHeight() {
    const dom = this.dom;
    if (!dom) return;
    const wrap = this.body && this.body.querySelector('.tk-wrap');
    if (!wrap) return;
    const pane = wrap.querySelector('ts-scrollpane');
    const kids = Array.from(wrap.children);
    // 滚动区内容自然高度（未被裁剪前）：逐个取 clip 直接子元素的自然高度求和，
    // 不用 clip.scrollHeight —— clip 一旦有显式高度，scrollHeight 会取 max(clip高, 内容高)，
    // 内容放得下时回读成「分配高度」而非「内容高度」，panelH 随之锁死、滚动条永远不出现。
    // ⚠ clip 的 firstElementChild 可能是 <slot> 占位（高度 0），真实列表内容在兄弟节点里，
    //   只取 first 会得到 0 → 内容放得下时面板也被压到 MIN 高度、错误地出现滚动条。
    let paneNat = 0;
    if (pane) {
      const clip = pane.querySelector('.ts-content-clip');
      if (clip) {
        for (const c of clip.children) paneNat += c.scrollHeight || c.offsetHeight || 0;
      } else paneNat = pane.offsetHeight;
    }
    // 除 pane 外各段实际高度
    const otherH = kids.filter((k) => k !== pane).reduce((a, k) => a + k.offsetHeight, 0);
    const cs = getComputedStyle(this.body);
    const padT = parseFloat(cs.top) || 0, padB = parseFloat(cs.bottom) || 0;
    const chromeH = padT + padB + otherH;
    const MIN = Math.round(this.height / 2 * 5 / 3), MAX = this.height;   // 387（原一半再多 2/3）~ 465
    // 自然总高；夹在区间内
    const panelH = Math.max(MIN, Math.min(MAX, chromeH + paneNat));
    // ⚠ pane 分配高度必须用 wrap 的实际可用高度，不能用 panelH - chromeH：
    //   chromeH 只含 body 内的 padding + 兄弟段，不含标题栏/面板边框等「面板级 chrome」，
    //   算出的 paneH 偏大；pane 作为 flex item（已加 flex:none 不被压缩）高度会超出 wrap，
    //   被面板 overflow:hidden 裁掉 → 内容在 clip 里不滚（maxV=0）但视觉上被裁，
    //   或滚动条下端落在可视区外（「下方不显示」）。wrap.clientHeight 是面板高度落定后的真值。
    let changed = dom.style.height !== panelH + 'px';
    if (changed) dom.style.height = panelH + 'px';
    const wrapH = wrap.clientHeight || 0;
    const paneH = Math.max(0, wrapH - otherH);
    if (pane) {
      const cur = parseFloat(pane.style.height) || 0;
      if (cur !== paneH) {
        // 显式高度（不靠 flex：自定义元素 flex 时序不稳）；setSize 会同步 invalidate SIZE
        if (typeof pane.setSize === 'function') pane.setSize(pane.offsetWidth || 100, paneH);
        else pane.style.height = paneH + 'px';
        changed = true;
      }
      // 内容/高度变化后重算滚动条与裁剪
      const defer = () => { try { pane.invalidateContent(); } catch (e) {} };
      if (changed) setTimeout(defer, 0);
      else defer();
    }
    if (changed && this.bgEngine && this.bgEngine.bakeIfVisible) {
      // 面板尺寸变了，九宫格底板需重烘焙（bakeIfVisible 内部按尺寸缓存，同尺寸不重烘）
      this.bgEngine.bakeIfVisible();
    }
  }
  _setSize(w, h) {
    const dom = this.dom;
    if (!dom) return;
    if (dom.style.width === w + 'px' && dom.style.height === h + 'px') return;
    this.width = w; this.height = h;
    dom.style.width = w + 'px';
    dom.style.height = h + 'px';
    // FinishItem 网格在 x=-43（AS3 不裁剪子级），面板需允许溢出
    dom.style.overflow = 'visible';
    if (this.bgEngine && this.bgEngine.bakeIfVisible) this.bgEngine.bakeIfVisible();
  }

  /** resetHeader(kind) —— 标题图：text_panel_title_talk / text_panel_title_mission（53×21，居中） */
  _setTitle(kind) {
    if (!this.titleEl) return;
    if (this._titleKind === kind) return;
    this._titleKind = kind;
    const img = IMG('text_panel_title_' + kind);
    if (img) {
      this.titleEl.innerHTML = '<img src="' + img + '" alt=""'
        + ' style="height:21px;object-fit:contain" onerror="this.style.display=\'none\'"/>';
    } else {
      this.titleEl.textContent = kind === 'mission' ? '任务' : '对话';
    }
  }

  // ── 头部（initHeader + updateheader） ──
  _headHtml() {
    const st = this.st;
    const MARGIN_L = num((CFG().stage || {}).MARGIN_PANEL_L, 20);   // MARGIN_PANEL_L=20
    const head = L('TalkPanel', 'TalkPanel_head');                  // (5,53)
    const nm = L('TalkPanel', 'TalkPanel_npcName');                 // (87,112,w100)
    const hx = MARGIN_L + num(head.x, 5), hy = num(head.y, 53);
    // AS3 updateheader：npcNameText.y = layout.y - textHeight（底部对齐于 y=112，14px）
    const ny = num(nm.y, 112) - 17;
    return '<div class="tk-head" style="left:' + hx + 'px;top:' + hy + 'px;width:64px;height:64px">'
        + this._portraitImg()
      + '</div>'
      + '<div class="tk-npcname" style="left:' + num(nm.x, 87) + 'px;top:' + ny + 'px;width:' + num(nm.w, 100) + 'px;color:#902B0E">'
        + rich(st.npcName)
      + '</div>';
  }

  // ── 主内容区 contentArea（initContentField 定 (15,120,190,290)；resetContentSize 每阶段改 h 与 x） ──
  _hasContent() {
    const c = String(this.st.content || '');
    return c.replace(/<[^>]*>/g, '').trim().length > 0 || /<a\b/i.test(c);
  }
  _contentHtml() {
    const st = this.st;
    const g = this._contentGeom();
    const c = L('TalkPanel', 'TalkPanel_content');   // (15,120,w190,h290)
    return '<div class="tk-content" style="left:' + num(g.x, 20) + 'px;top:' + num(c.y, 120) + 'px;width:'
      + num(c.w, 190) + 'px;height:' + num(g.h, 168) + 'px;border:0;color:#000;font-size:12px;line-height:1.5;'
      + (st.contentInteractive ? 'cursor:pointer' : '') + '">'
      + rich(st.content) + '</div>';
  }
  /** resetContentSize(h, x) —— 各阶段的内容区几何（AS3 updatePanel 内的分支） */
  _contentGeom() {
    const st = this.st;
    if (st.stage === S.DESCRIBE) return L('TalkPanel', 'TalkPanel_content');        // (15,120,190,290)
    if (st.stage === S.OVER) {
      if (st.needEquip) return L('TalkPanel', 'TalkPanel_content3');                // (20,120,190,135)
      if (st.taskObj && num(st.taskObj.choiceItemNum) > 0) return L('TalkPanel', 'TalkPanel_finishtext'); // (20,120,190,120)
      return L('TalkPanel', 'TalkPanel_content2');                                  // (20,120,190,168)
    }
    if (st.stage === S.CARRYOVER && st.needEquip) return L('TalkPanel', 'TalkPanel_content3');
    return L('TalkPanel', 'TalkPanel_content2');
  }

  // ── TalkRight：右侧任务列表（TalkRight.as updateContent 的排版公式 1:1） ──
  //   容器原点 = attrSprite(215,0) + TalkRight(8, MARGIN_PANEL_T=50)
  //   分组标题 y = gi*text.h + cum*icon.h；条目 y = (gi+1)*icon.h + (i+cum)*icon.h + gi*5 - 1
  //   FigureSprite：icon 16×16@(2,18-16)，任务名 12px@(4+iconW,0) 带下划线
  //   空分组不占位（不单独占一栏）；内容超出 200×240 时 ts-scrollpane 出自定义滚动条
  _listHtml() {
    const st = this.st;
    const tr = L('TalkRight');                    // (8,200x240)
    const tx = L('TalkRight', 'TalkRight_text');  // (0,25)
    const ic = L('TalkRight', 'TalkRight_icon');  // (3,20)
    const tH = num(tx.h, 25), iH = num(ic.h, 20);
    const groups = (st.groups || []).filter((g) => (g.task || []).length > 0);
    let html = '', cum = 0, maxH = num(tr.h, 240);
    groups.forEach((grp, gi) => {
      const ty = gi * tH + cum * iH;
      html += '<div style="position:absolute;left:' + num(tx.x, 0) + 'px;top:' + ty + 'px;'
        + 'color:' + grp.color + ';font-size:14px;font-weight:700;white-space:nowrap">'
        + esc(grp.title) + '</div>';
      (grp.task || []).forEach((t, i) => {
        const y = (gi + 1) * iH + (i + cum) * iH + gi * 5 - 1;
        // FigureSprite.as:56-64：icon key = npc_taskicon_<icon|defaultIcon|10016>；
        //   defaultIcon=10015 且 taskFinish!=1 → 10014
        let ico = String(t.icon || grp.defaultIcon || '10016');
        if (ico === '10015' && num(t.taskFinish) !== 1) ico = '10014';
        html += '<div data-task="' + esc(t.taskId) + '" style="position:absolute;left:' + num(ic.x, 3) + 'px;top:' + y + 'px;'
          + 'display:flex;align-items:center;height:20px;cursor:pointer;max-width:190px">'
          + '<img src="' + url.res('npctaskicon' + ico + '.png') + '" alt=""'
          + ' style="width:16px;height:16px;flex:0 0 16px;image-rendering:pixelated" onerror="this.style.display=\'none\'"/>'
          + '<span style="font-size:12px;color:#000;margin-left:4px;'
          + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
          + esc(t.taskName) + '</span></div>';
        maxH = Math.max(maxH, y + iH);
      });
      cum += (grp.task || []).length;
    });
    // 滚动内容：显式高度让 scrollpane 算出滚动范围（内容在 _wire 装入）
    this._listSrc = '<div style="position:relative;width:100%;height:' + maxH + 'px">' + html + '</div>';
    return '<ts-scrollpane style="position:absolute;left:' + (ATTR_X + num(tr.x, 8)) + 'px;top:' + num((CFG().stage || {}).MARGIN_PANEL_T, 50) + 'px;'
      + 'width:' + num(tr.w, 200) + 'px;height:' + num(tr.h, 240) + 'px;overflow:hidden"></ts-scrollpane>';
  }

  // ── DescTaskPanel：任务描述（局部坐标 + attrSprite 偏移 ATTR_X） ──
  //   taskLevelDesc@(10,50) 内含难度文字 + 星级；textArea@(10,85,250,180)；bonus@(10,276)
  //   accept/cancel 按钮 @ DescTaskPanel 局部 (18,416)/(170,416)
  _descHtml() {
    const o = this.st.taskObj;
    const lv = L('TaskDescPanel', 'TaskDescPanel_level');        // (10,50,h32)
    const lt1 = L('TaskDescPanel', 'TaskDescPanel_levelText1');  // (0,10)
    const lt2 = L('TaskDescPanel', 'TaskDescPanel_levelText2');  // (148,10)
    const lt3 = L('TaskDescPanel', 'TaskDescPanel_levelText3');  // (208,10)
    const ta = L('TaskDescPanel', 'TaskDescPanel_textArea');     // (10,85,h180)
    const bn = L('TaskDescPanel', 'TaskDescPanel_bonus');        // (10,276)
    const star = L('StarItem', 'StarItem_star');                 // (53,13,w9)
    const lvX = ATTR_X + num(lv.x, 10), lvY = num(lv.y, 50);
    // 难度星：10 颗，StarItem_star.x + i*width（panel_star1 亮 / panel_star0 暗，9×10）
    const diff = num(o && o.difficulty, 0);
    let stars = '';
    for (let i = 0; i < 10; i++) {
      const s = IMG(i < diff ? 'panel_star1' : 'panel_star0');
      if (!s) continue;
      stars += '<img src="' + s + '" alt="" style="position:absolute;left:' + (lvX + num(star.x, 53) + i * num(star.w, 9)) + 'px;'
        + 'top:' + (lvY + num(star.y, 13)) + 'px;width:9px;height:10px" onerror="this.style.display=\'none\'"/>';
    }
    return ''
      // 分栏竖线（TalkPanel_descFrame：w=0 的 frame ⇒ 1px 竖线，色 0x66525B，y=50 h=360）
      + '<i style="position:absolute;left:' + ATTR_X + 'px;top:50px;width:1px;height:360px;background:#66525B"></i>'
      // 难度/等级行底色（fillBackground3(frameWidth=250, h=32)）
      + '<i style="position:absolute;left:' + lvX + 'px;top:' + lvY + 'px;width:' + DESC_W + 'px;height:' + num(lv.h, 32) + 'px;'
      + 'background:rgba(206,171,129,.14)"></i>'
      + '<div style="position:absolute;left:' + (lvX + num(lt1.x, 0)) + 'px;top:' + (lvY + num(lt1.y, 10)) + 'px;'
      + 'font-size:12px;color:#9E2B0E;white-space:nowrap">' + esc(ZH('TASK_DIFFICULTY')) + '</div>'
      + stars
      + '<div style="position:absolute;left:' + (lvX + num(lt2.x, 148)) + 'px;top:' + (lvY + num(lt2.y, 10)) + 'px;'
      + 'font-size:12px;color:#9E2B0E;white-space:nowrap">' + esc(ZH('TASK_CONDIGNLEVEL')) + '</div>'
      + '<div style="position:absolute;left:' + (lvX + num(lt3.x, 208)) + 'px;top:' + (lvY + num(lt3.y, 10)) + 'px;'
      + 'font-size:12px;color:#9E2B0E;white-space:nowrap">' + esc(o ? o.condignLevel : '') + '</div>'
      // 正文区（createTextArea：可滚、12px、黑字）
      + '<div style="position:absolute;left:' + (ATTR_X + num(ta.x, 10)) + 'px;top:' + num(ta.y, 85) + 'px;'
      + 'width:' + DESC_W + 'px;height:' + num(ta.h, 180) + 'px;overflow-y:auto;font-size:12px;line-height:1.45;color:#000;padding:0 2px">'
      + rich(this._descContent(o)) + '</div>'
      // 奖励区（BonusSprite）
      + '<div style="position:absolute;left:' + (ATTR_X + num(bn.x, 10)) + 'px;top:' + num(bn.y, 276) + 'px;width:' + DESC_W + 'px">'
      + this._bonusHtml(o) + '</div>';
  }

  /** BonusSprite（AS3 1:1）：text_panel_bonus_item 标签底框(70×19) + ResultItemPanel(5列/2行/列距0/行距5)
   *   格 36×36（TaskItemPanel_grid），底图 panel_item_bg@(格-2,-2)，图标 + 右下角白色12px数量（count>1 才显示）。
   *   bonusItem 缺抓包时退回 op30 field9 rewardText 文本（AS3 TaskObj 无该字段，单机版保留以免奖励信息全失）。 */
  _bonusHtml(o) {
    if (!o) return '';
    // 标签：ComponentSprite06(0,0,'text_panel_bonus_item', 70) —— TextLabelBg 拉伸到 70 宽，文字图居中(53×13)
    const bar = url.res('paneltextlabelbg.png');
    const labelImg = IMG('text_panel_bonus_item');
    let h = '<i style="position:absolute;left:0;top:0;width:70px;height:19px;'
      + 'background:url(' + bar + ') 0 0/100% 100%;display:block"></i>'
      + (labelImg ? '<img src="' + labelImg + '" alt="" style="position:absolute;left:8.5px;top:3px"'
        + ' onerror="this.style.display=\'none\'"/>' : '');
    const items = (o.bonusItem || []).filter((b) => b.name || b.image).slice(0, 10);
    if (!items.length) {
      // AS3 此时空格只有底图；单机版 bonusItem 多缺抓包，用 rewardText 兜底
      const rt = String(o.rewardText || '').trim();
      if (!rt) return h + '<div style="position:absolute;left:0;top:24px;font-size:10px;color:#7a6a4a">（抓包无奖励样本）</div>';
      return h + '<div style="position:absolute;left:0;top:24px;font-size:12px;color:#9E2B0E;line-height:1.5">奖励：' + esc(rt) + '</div>';
    }
    const g = L('TaskItemPanel', 'TaskItemPanel_grid');   // {x:70, w:36, h:36}
    const gw = num(g.w, 36), gh = num(g.h, 36);
    const gx = num(g.x, 70);   // ResultItemPanel 内格子起点 x（= TaskItemPanel_grid.x）
    const cellBg = url.res('panelitembg.png');
    items.forEach((b, i) => {
      const col = i % 5, row = Math.floor(i / 5);
      // ResultItemPanel@(1,2)：格 x = 1 + gridX + col*(w+colSpace=0)，y = 2 + row*(h+rowSpace=5)
      const x = 1 + gx + col * gw, y = 2 + row * (gh + 5);
      const ic = itemIcon(b.image);
      const tip = esc((stripTags(b.name) || stripTags(b.descBonus)).slice(0, 120));
      h += '<i style="position:absolute;left:' + (x - 2) + 'px;top:' + (y - 2) + 'px;width:' + gw + 'px;height:' + gh
        + 'px;background:url(' + cellBg + ') 0 0/100% 100%;display:block"></i>'
        // 图标尺寸对齐背包 .bag-ic（32×32，css/style.css:881），在 36 格内 +2,+2 居中
        + (ic ? '<img data-bonus="' + i + '" src="' + ic + '" alt="" style="position:absolute;left:' + (x + 2) + 'px;top:' + (y + 2)
          + 'px;width:32px;height:32px;object-fit:contain;image-rendering:pixelated" onerror="this.style.display=\'none\'"/>' : '');
      if (num(b.num, 1) > 1) {
        // LoadSprite.countField：白字 12px，右下角（x = 32 - textWidth - 2, y = 17）
        h += '<span style="position:absolute;left:' + x + 'px;top:' + (y + 17) + 'px;width:' + (gw - 2) + 'px;'
          + 'text-align:right;font-size:12px;line-height:1;color:#fff;text-shadow:0 0 2px #000,0 0 2px #000;'
          + 'white-space:nowrap;pointer-events:none">' + esc(String(num(b.num, 1))) + '</span>';
      }
    });
    return h;
  }

  /** DescTaskPanel.getContent(data, flag=false)：TalkPanel 调用不带 flag ⇒ 无标题段 */
  //   五段（AS3）：任务描述 / 成员列表 / 所需物品 / 完成任务路人 / 限时；
  //   剧情对话（op30 field6 = story）只进左侧 contentArea（setContents），右侧不重复；
  //   奖励文本（field9）见 _bonusHtml（bonusItem 缺抓包时的兜底）
  /** bonusItem/choiceItem → showItemTip 的物品对象：
   *  descBonus = op30 抓包富文本， getItemRich 走 descRich 分支直接渲染（与背包物品完全同款）；
   *  缺富文本（经验/银票等假物品）时回落结构化兜底（名+类型+无属性加成）。 */
  _tipObj(b) {
    if (!b) return null;
    const nm = stripTags(b.name || '');
    const db = String(b.descBonus || '');
    return {
      id: b.id,
      name: nm || ('物品 ' + b.id),
      type: (num(b.type, -1) >= 0 ? num(b.type) : undefined),
      desc: db,
      descRich: db.indexOf('<font') >= 0 ? db : '',   // 仅当确含富文本标记时启用，否则走结构化兜底
    };
  }

  _descContent(o) {
    let s = ZH('TASK_DESC');
    if (o) {
      s += o.desc;
      // 抓包无该任务详情，仅列表已知信息：明确标注，不臆造内容
      if (o._noDetail) s += '<br><font color="#9E2B0E">（本任务详情未出现在抓包样本中，仅展示列表已知信息；描述/奖励/条件待逆向）</font>';
    }
    s += '</font>';
    if (o && o.memberList) { s += ZH('TASK_MEMBERLIST') + o.memberList + '</font>'; }
    s += ZH('TASK_NEEDITEM');
    if (o) s += o.conditionItem;
    s += '</font>';
    s += ZH('TASK_FINISHNPC');
    if (o) s += o.finishNpc;
    s += '</font>';
    s += ZH('TASK_LIMITTIME');
    if (o) s += (num(o.time) <= 0 ? ZH('MISSIONMANAGER_TIME') : num(o.time) + ZH('MISSIONMANAGER_MINUTE'));
    return s + '</font>';
  }

  // ── finishSprite：可选奖励（OVER 且 choiceItemNum>0 才挂） ──
  //   finishtext「请选择一个奖励」在 finishItem.y-20；FinishItem 网格 @(-43,265)（溢出面板，AS3 不裁剪）
  _finishHtml() {
    const st = this.st;
    if (st.stage !== S.OVER) return '';
    const n = num(st.taskObj && st.taskObj.choiceItemNum);
    if (!n) return '';
    const fi = L('TalkPanel', 'TalkPanel_finishItem');   // (-43,265)
    const ft = L('TalkPanel', 'TalkPanel_finishtext');   // (20,w190,h120)
    const grid = L('TaskItemPanel', 'TaskItemPanel_grid');
    const gw = num(grid.w, 36);
    const items = (st.taskObj && st.taskObj.choiceItem) || [];
    const rows = Array.from({ length: Math.max(n, 1) }, (_, i) => {
      const it = items[i];
      return '<div data-choice="' + i + '" class="tk-slot' + (st.choiceSel === i ? ' on' : '')
        + '" style="width:' + gw + 'px;height:' + gw + 'px">'
        + (it ? '<img src="' + itemIcon(it.image) + '" alt="" onerror="this.style.display=\'none\'"/>'
          + '<span class="tk-slot-n">' + esc(it.name) + '×' + num(it.num, 1) + '</span>'
          : '<span class="tk-slot-e">空</span>')
        + '</div>';
    }).join('');
    return '<div class="tk-finish" style="left:0;top:0">'
      + '<div class="tk-finish-t" style="left:' + num(ft.x, 20) + 'px;top:' + (num(fi.y, 265) - 20) + 'px;'
      + 'width:' + num(ft.w, 190) + 'px;white-space:normal;color:#9E2B0E">' + rich(ZH('SELECT_ONE_BONUS')) + '</div>'
      + '<div style="position:absolute;left:' + num(fi.x, -43) + 'px;top:' + num(fi.y, 265) + 'px;'
      + 'display:flex;gap:4px;flex-wrap:wrap">' + rows + '</div>'
      + '</div>';
  }

  // ── equipItemSprite：上交装备（OVER/CARRYOVER 且 rest[0]!=null） ──
  //   AS3：equipItemSprite.y = 10；含 putItem 标题框 + EquipItemPanel 单格 + submitBtn
  _equipHtml() {
    const st = this.st;
    if (!st.needEquip) return '';
    const fr = L('TalkPanel', 'TalkPanel_submitEquipFrame');   // (28,260,190,50)
    const ip = L('TalkPanel', 'TalkPanel_submitEquipItemPanel');// (25,270)
    const sb = L('TalkPanel', 'TalkPanel_submitBtn');          // (70,315)
    const g = L('TaskItemPanel', 'TaskItemPanel_grid');
    const gw = num(g.w, 36);
    const putImg = IMG('text_panel_putItem');
    return '<div style="position:absolute;left:0;top:10px">'
      // 标题框（createFontWidthFrame：text_panel_putItem 文字图 26×27）
      + '<div style="position:absolute;left:' + num(fr.x, 28) + 'px;top:' + num(fr.y, 260) + 'px;'
      + 'width:' + num(fr.w, 190) + 'px;height:' + num(fr.h, 50) + 'px;border:1px solid #66525B;'
      + 'box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:2px 6px">'
      + (putImg ? '<img src="' + putImg + '" alt="" style="height:14px" onerror="this.style.display=\'none\'"/>' : '')
      + '<span style="font-size:12px;color:#9E2B0E">放入装备</span></div>'
      // 装备槽（EquipItemPanel：单格 36×36）
      + '<div data-equip="0" class="tk-slot" style="left:' + num(ip.x, 25) + 'px;top:' + num(ip.y, 270) + 'px;'
      + 'width:' + gw + 'px;height:' + gw + 'px">'
      + (this._equip ? '<span class="tk-slot-n">' + esc(this._equip.name || '装备') + '</span>'
        : '<span class="tk-slot-e">放入装备</span>')
      + '</div>'
      // 提交按钮（equipItemSprite 内 → y-10）
      + this._btn('submit', 'text_panel_submit', '提交', num(sb.x, 70), num(sb.y, 315) - 10, 'bg1')
      + '</div>';
  }

  // ── TaskContribution：帮派贡献（attrSprite@(215,0) 内的布局坐标） ──
  _contribHtml() {
    const st = this.st;
    const c = L('TaskContribution', 'TaskContribution');   // (10,46,200,241)
    const tt = L('TaskContribution', 'TaskContribution_title');
    const ins = L('TaskContribution', 'TaskContribution_instruction');
    const iv = L('TaskContribution', 'TaskContribution_instructionValue');
    const ac = L('TaskContribution', 'TaskContribution_awardContribution');
    const ay = L('TaskContribution', 'TaskContribution_awardYuanPo');
    const ib = L('TaskContribution', 'TaskContribution_ImageButton');
    const titles = ['', ZH('TALK_TITLE_SKILLBOOK'), ZH('TALK_TITLE_EQUIP'), ZH('TALK_TITLE_CLUTTER'),
      ZH('TALK_TITLE_METERIAL'), ZH('TALK_TITLE_EXP')];
    const t = num(st.contribType, 1);
    const isExp = t === 5;
    return '<div style="position:absolute;left:' + (ATTR_X + num(c.x, 10)) + 'px;top:' + num(c.y, 46) + 'px;'
      + 'width:' + num(c.w, 200) + 'px;height:' + num(c.h, 241) + 'px;border:1px solid #66525B;'
      + 'box-sizing:border-box;background:rgba(0,0,0,.25)">'
      + '<div style="position:absolute;left:' + num(tt.x, 80) + 'px;top:' + num(tt.y, 56) + 'px;'
      + 'color:#E9DC04;font-size:13px;font-weight:700;white-space:nowrap">' + esc(titles[t] || '') + '</div>'
      + (isExp
        ? '<div style="position:absolute;left:' + num(ins.x, 18) + 'px;top:' + num(ins.y, 100) + 'px;'
          + 'font-size:11px;color:#cbb58a;white-space:nowrap">' + esc(ZH('TASK_INSTRUCTION')) + '</div>'
          + '<div style="position:absolute;left:' + num(iv.x, 18) + 'px;top:' + num(iv.y, 121) + 'px;'
          + 'font-size:11px;color:#f3e6c8;white-space:nowrap">0</div>'
        : '')
      + '<div style="position:absolute;left:' + num(ac.x, 30) + 'px;top:' + num(ac.y, 191) + 'px;'
      + 'font-size:11px;color:#cbb58a;white-space:nowrap">' + esc(ZH('TASK_AWARDCONTRIBUTION')) + '0</div>'
      + '<div style="position:absolute;left:' + num(ay.x, 30) + 'px;top:' + num(ay.y, 216) + 'px;'
      + 'font-size:11px;color:#cbb58a;white-space:nowrap">' + esc(ZH('TASK_AWARDYUANPO')) + '0</div>'
      + '<button data-act="contrib" style="position:absolute;left:' + num(ib.x, 86) + 'px;top:' + num(ib.y, 250) + 'px;'
      + 'width:' + num(ib.w, 50) + 'px;height:' + num(ib.h, 22) + 'px;font-size:11px;color:#f3e6c8;'
      + 'background:#3a2a18;border:1px solid #6b5432;border-radius:2px;cursor:pointer">捐献</button>'
      + '</div>';
  }

  // ── 阶段按钮（initButton：每阶段按 updatePanel 显隐；53×27 panelbtnbg4 皮肤） ──
  _buttonsHtml() {
    const st = this.st;
    const out = [];
    const showAccept = !(st.taskObj && num(st.taskObj.showAccept) === 1);
    if (st.stage === S.DESCRIBE) {
      // accept/cancel 挂在 DescTaskPanel 内（局部 +ATTR_X）
      const ab = L('TalkPanel', 'TalkPanel_acceptBtn');   // (18,416)
      const cb = L('TalkPanel', 'TalkPanel_cancelBtn');   // (170,416)
      if (showAccept) out.push(this._btn('accept', 'text_panel_task_accept', '接取', ATTR_X + num(ab.x, 18), num(ab.y, 416)));
      out.push(this._btn('cancel', showAccept ? 'text_panel_cancel' : 'text_panel_confirm',
        showAccept ? '取消' : '确认', ATTR_X + num(cb.x, 170), num(cb.y, 416)));
    }
    if (st.stage === S.OVER && !st.needEquip) {
      const fb = L('TalkPanel', 'TalkPanel_finishBtn');   // (75,305)
      out.push(this._btn('over', 'text_panel_task_over', '完成', num(fb.x, 75), num(fb.y, 305)));
    }
    if (st.stage === S.PROCESS) {
      if (st.taskOver) {
        // ★ 需求2：交付小窗（SC_SHOW_TALK_DLG 带 taskOver）按钮改「完成任务」(data-act=over)
        const fb = L('TalkPanel', 'TalkPanel_finishBtn');   // (75,300)
        out.push(this._btn('over', 'text_panel_task_over', '完成任务', num(fb.x, 75), num(fb.y, 300)));
      } else {
        const bb = L('TalkPanel', 'TalkPanel_backBtn');     // (75,300)
        out.push(this._btn('back', 'text_panel_btn_back', '返回', num(bb.x, 75), num(bb.y, 300)));
      }
    }
    if (st.stage === S.DIAGNOSES) {
      // ★ 选项按钮（挑战对话的「◆挑战它 / ◆.稍作准备」，对齐 op30 field13/field14）：
      //   从内容区底部 (y≈292) 起竖排，h=22 gap=4；有选项时不再出「放弃」（选项自带退出路径）。
      const opts = Array.isArray(st.options) ? st.options : [];
      if (opts.length) {
        const OY = 292, OH = 22, OGAP = 4;
        opts.forEach((o, i) => {
          const y = OY + i * (OH + OGAP);
          out.push('<button class="tk-btn tk-opt" data-act="opt" data-opt="' + esc(String(o)) + '"'
            + ' style="left:20px;top:' + y + 'px;width:190px;height:' + OH + 'px;padding:0 6px;'
            + 'font-size:12px;color:#fff;text-align:left;background:#5a3a1a;border:1px solid #8a6a3a;border-radius:3px;cursor:pointer">'
            + esc(String(o)) + '</button>');
        });
      } else {
        const db = L('TalkPanel', 'TalkPanel_deleteBtn');   // (75,300)
        out.push(this._btn('giveup', 'text_panel_delete_mission', '放弃', num(db.x, 75), num(db.y, 300), 'bg1'));
      }
    }
    if (st.stage === S.CARRYOVER && !st.needEquip) {
      const fw = L('TalkPanel', 'TalkPanel_forwardBtn');  // (75,300)
      out.push(this._btn('carry', 'text_panel_btn_goon', '继续', num(fw.x, 75), num(fw.y, 300)));
    }
    return out.join('');
  }

  /** ViewButton：3×3 图 + 文字图（缺失时露出中文兜底，不臆造皮肤） */
  _btn(act, key, label, x, y, skin) {
    const bg = skin === 'bg1' ? (IMG('panel_btn_bg1') || IMG('panel_btn_bg4'))
      : (IMG('panel_btn_bg4') || IMG('panel_btn_bg1'));
    const img = IMG(key);
    return '<button class="tk-btn" data-act="' + act + '" style="left:' + x + 'px;top:' + y + 'px;'
      + (bg ? 'background-image:url(' + bg + ');background-size:100% 100%' : '') + '">'
      + (img ? '<img src="' + img + '" alt="" onerror="this.style.display=\'none\'"/>' : '')
      + '<span>' + esc(label) + '</span></button>';
  }

  // ══════════ 事件 ══════════
  _wire() {
    const b = this.body;
    const q = (s) => b.querySelector(s);
    const qa = (s) => Array.from(b.querySelectorAll(s));

    // TalkRight 滚动区：ts-scrollpane（复刻原版 fl 自定义滚动条）
    const pane = q('ts-scrollpane');
    if (pane) {
      // 组件皮肤依赖 ts-components.css，游戏默认未加载，按需注入一次（不改任何 CSS 文件）
      const reflow = () => { try { pane.update(); } catch (e) {} };
      let css = document.querySelector('link[data-ts-components]');
      if (!css) {
        css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'js/ui/components/ts-components.css';
        css.setAttribute('data-ts-components', '1');
        css.onload = reflow;
        document.head.appendChild(css);
      }
      // source 模式插入内容（元素已连接，configUI 已执行，_contentClip 就绪）
      pane.source = this._listSrc || '<div style="position:relative;width:100%;height:100%"></div>';
      // 透明化 ScrollPane 自带白底皮肤以贴合本面板深色木纹（仅内联样式）
      const bg = pane.querySelector('.ts-bg');
      if (bg) { bg.style.background = 'transparent'; bg.style.borderColor = 'transparent'; }
      setTimeout(reflow, 400);
    }

    // 任务列表条目 → sendSelectTask（AS3 taskHandler：点击选中该任务）
    qa('[data-task]').forEach((el) => {
      el.onclick = () => this.sys.net.selectTask(this.st.npcId, el.dataset.task);
    });
    // 任务描述里的 NPC 名超链接 → 自动寻路（event:x,y,m,n）
    this._wireNpcLinks(qa);
    // 可选奖励 → FinishItem.showSelectGrid（点击选中 → currItemId）
    qa('[data-choice]').forEach((el) => {
      el.onclick = () => { this.st.choiceSel = num(el.dataset.choice); this.render(); };
    });
    // ★ 奖励/可选奖励图标：悬停弹与背包同款的富文本窗（showItemTip）
    //   op30 descBonus 即抓包富文本（ getItemRich 走 descRich 直接渲染，与背包物品同源同款）
    const tipObj = this.st.taskObj || {};
    qa('[data-bonus]').forEach((el) => {
      const b = (tipObj.bonusItem || [])[num(el.dataset.bonus)];
      if (!b) return;
      el.onmouseenter = () => showItemTip(this._tipObj(b), null, el);
      el.onmouseleave = hideItemTip;
    });
    qa('[data-choice]').forEach((el) => {
      const b = (tipObj.choiceItem || [])[num(el.dataset.choice)];
      if (!b) return;
      el.onmouseenter = () => showItemTip(this._tipObj(b), null, el);
      el.onmouseleave = hideItemTip;
    });
    // 上交装备格（拖拽依赖 ItemPanel03，清单内；此处点击放入占位，明确标注）
    qa('[data-equip]').forEach((el) => {
      el.onclick = () => {
        this._equip = this._equip ? null : { name: '（示例装备）' };
        this.ui && this.ui.toast(this._equip ? '已放入装备（示例；真实拖拽依赖 ItemPanel03）' : '已取出');
        this.render();
      };
    });

    qa('[data-act]').forEach((el) => {
      const a = el.dataset.act;
      if (a === 'click') return;
      el.onclick = () => this._buttonHandler(a, el);
    });
  }

    /** buttonHandler：任务操作按钮主分发（含 costNotice → Prompt18 的分支） */
  _buttonHandler(act, el) {
    const st = this.st;
    // ★ 选项按钮（挑战对话的「◆挑战它 / ◆.稍作准备」）：data-opt = 选项原文，
    //   回 selectOption 由 talk.js 分发（tag='challenge:base:phase' → 进战斗 / 关面板）
    if (act === 'opt' && el) {
      this.sys.net.selectOption(st.npcId, st.tag, el.dataset.opt, st.taskId);
      return;
    }
    const net = this.sys.net;
    const obj = st.taskObj;
    const cost = obj ? String(obj.costNotice || '').trim() : '';
    const confirmCost = (cb) => {
      if (cost) { this.ui && this.ui.toast(cost); if (!window.confirm(cost)) return; }
      cb();
    };
    switch (act) {
      case 'accept':
        confirmCost(() => { net.taskAction(st.npcId, st.taskId, ACT.ACCEPTED); });
        break;
      case 'over': {
        confirmCost(() => {
          // sendTaskAction：完成且 choiceItemNum!=0 ⇒ 带上所选奖励 id（未选 = "-1"）
          const n = num(obj && obj.choiceItemNum);
          if (n) {
            const id = st.choiceSel === -1 ? '-1' : String((obj.choiceItem[st.choiceSel] || {}).id ?? '-1');
            net.taskAction(st.npcId, st.taskId, ACT.OVER, 1, id);
          } else net.taskAction(st.npcId, st.taskId, ACT.OVER);
        });
        break;
      }
      case 'carry': net.taskAction(st.npcId, st.taskId, ACT.GOON); break;
      case 'cancel':
        if (st.stage === S.DESCRIBE) net.denyTask(st.taskId);
        this.close();
        break;
      case 'giveup':
      case 'back':
        this.close();
        break;
      case 'submit':
        if (!this._equip) { this.ui && this.ui.toast('请先放入要上交的装备'); return; }
        net.taskAction(st.npcId, st.taskId, st.stage === S.OVER ? ACT.OVER : ACT.GOON, 1, String(this._equip.index ?? 0));
        break;
      case 'contrib':
        net.gangContribution(num(st.contribType, 1));
        break;
      default: break;
    }
  }

  // ══════════ NPC 超链接自动寻路（任务描述里的 event:x:X,y:Y,m:M,n:N） ══════════
  /** 挂载链接点击委托：body 内所有 a[data-npclink]（_wire / _wireLegacy 共用） */
  _wireNpcLinks(qa) {
    qa('a[data-npclink]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();   // 阻止浏览器把 event: 当未知协议导航
        this._onNpcLink(el.getAttribute('href'));
      };
    });
  }

  /** NPC 显示名：场景实体优先（含地图配置名），回退 talk.json 的 npcName */
  _npcNameOf(npcId) {
    const sm = panelManager.context && panelManager.context.sm;
    const cur = sm && sm.current;
    if (cur && Array.isArray(cur.npcs)) {
      const f = cur.npcs.find((x) => x && x.npcData && Number(x.npcData.id) === Number(npcId));
      if (f && f.npcData.name) return String(f.npcData.name);
    }
    const t = ((CFG().data || {}).talks || []).find((x) => Number(x.npcId) === Number(npcId));
    return (t && t.npcName) ? String(t.npcName) : '';
  }

  /** 点击任务描述里的 NPC 名超链接：
   *    同一张地图 → 关面板 + scene._interactNpc（够近直接对话；太远 A* 寻路，到达自动开交谈面板）；
   *    不同地图   → 仅在系统聊天窗提示（★ 占位：跨地图传送系统用户尚未做好，不做传送）；
   *    找不到实体 → 系统聊天窗提示。 */
  _onNpcLink(href) {
    const p = parseNpcLink(href);
    if (!p) { this.ui && this.ui.toast('无法识别的NPC链接'); return; }
    const ui = (panelManager.context && panelManager.context.ui) || this.ui;
    const log = (html) => { try { ui && ui.log(html, 'sys'); } catch (e) {} };
    const tName = this._npcNameOf(p.n) || ('NPC ' + p.n);
    const tMap = ((Config.maps || []).find((x) => Number(x.id) === Number(p.m)) || {});
    const tMapName = tMap.name || ('地图 ' + p.m);

    const sm = panelManager.context && panelManager.context.sm;
    const sc = sm && sm.current;
    if (!sc || !Array.isArray(sc.npcs) || !sc.map) {
      log('<font color="#9E2B0E">场景未就绪，无法寻路到 ' + esc(tName) + '。</font>');
      return;
    }
    // ★ 跨地图：占位提示，不传送（用户：跨地图传送系统尚未做好）
    if (Number(sc.map.id) !== Number(p.m)) {
      log('<font color="#9E2B0E">【' + esc(tMapName) + '】的 ' + esc(tName) +
        ' 在另一张地图，跨地图自动寻路尚未开放，请先手动前往该地图。</font>');
      return;
    }
    const f = sc.npcs.find((x) => x && x.npcData && Number(x.npcData.id) === Number(p.n));
    if (!f) {
      log('<font color="#9E2B0E">' + esc(tName) + ' 似乎不在当前地图（' + esc(String(sc.map.name || ('地图 ' + p.m))) +
        '），可能尚未刷新。</font>');
      return;
    }
    // 同图：关当前交谈面板 → 走向目标 NPC（_interactNpc：到达后 _tickTalkArrive 自动打开它的交谈面板）
    this.close();
    sc._interactNpc(f);
  }

  // ── SC_NPC_FUNCTION：功能条目本地路由（对齐 AS3 点功能后由服务端打开对应面板） ──
  _doFunction(p) {
    const ui = this.ui;
    const name = String((p && p.taskName) || '');
    const npcId = num(p && p.npcId, 0);
    // ★ 功能条目挂 teleport（talk.json functions 里 {teleport:{mapId[,x,y]}}）：关面板 → 传送
    //   用于副本入口（如诸葛庭「进入天音洞上层」→ 昆仑幻境 1001）。
    //   落点：带 x/y（op85 抓包真源）则直落该点，否则走目标图默认出生点。
    if (p && p.teleport && Number(p.teleport.mapId) > 0) {
      const sm = panelManager.context && panelManager.context.sm;
      const sc = sm && sm.current;
      this.close();
      if (!sc || typeof sc.changeMap !== 'function') { ui && ui.toast('传送失败'); return; }
      const mid = Number(p.teleport.mapId);
      const mname = ((Config.maps || []).find((m) => m.id === mid) || {}).name || ('#' + mid);
      const tx = Number(p.teleport.x), ty = Number(p.teleport.y);
      const opts = (Number.isFinite(tx) && Number.isFinite(ty)) ? { spawnPos: { x: tx, y: ty } } : {};
      ui && ui.toast('传送到 ' + mname);
      sc.changeMap(mid, opts);
      return;
    }
    // 商店类：shopId = NPC 模板 id（实证 op102：1003 曹雪/1005 郭不平/1012 包全誉/1010 丁虎/1013 林远山）
    const shopLike = /商店$/.test(name) || name === '药店' || name === '物品兑换' || name === '挖矿（普通）';
    if (shopLike) { this.close(); ui && ui.openPanel('npcshop', { shopId: npcId }); return; }
    if (name === '打开世界地图') { this.close(); ui && ui.openPanel('worldmap'); return; }
    if (name === '进入仓库') { this.close(); ui && ui.openPanel('bag'); return; }
    if (name === '治疗用户') { this._healPlayer(); this.close(); return; }
    if (name === '治疗宠物' || name === '治疗人宠') { this._healPets(); this.close(); return; }
    if (name === '恢复忠诚') { this._restoreLoyalty(); this.close(); return; }
    ui && ui.toast('「' + name + '」功能待接入');
  }

  /** 治疗用户：人物 hp/mp 回满（fighter.js 的 hp/mp setter 按 max 夹取） */
  _healPlayer() {
    const p = this.ui && this.ui.player;
    if (!p) { this.ui && this.ui.toast('角色数据未就绪'); return; }
    p.hp = p.maxHp; p.mp = p.maxMp;
    try { this.ui.bindPlayer(p); } catch (e) { /* 刷 HUD 失败不阻断 */ }
    this.ui.toast('已恢复全部生命与法力');
  }

  /** 治疗宠物/人宠：全部伙伴 hpCur/mpCur 回满（实例层落档） */
  _healPets() {
    const pv = petView();
    const list = (pv && pv.list) || [];
    if (!list.length) { this.ui.toast('当前没有伙伴'); return; }
    let n = 0;
    list.forEach((v) => {
      const inst = pv.instanceOf(v.petId);
      if (!inst) return;
      const hp = num(v.hpMax, 0), mp = num(v.mpMax, 0);
      if (hp > 0) inst.hpCur = hp;
      if (mp > 0) inst.mpCur = mp;
      n++;
    });
    try { petState().save(); } catch (e) { /* 存档失败不阻断功能 */ }
    this._refreshPetPanel();
    this.ui.toast(n ? ('已为 ' + n + ' 只伙伴恢复生命与法力') : '当前没有伙伴');
  }

  /** 恢复忠诚：全部伙伴 loyality = 100 */
  _restoreLoyalty() {
    const ps = petState();
    const list = (ps && ps.list) || [];
    if (!list.length) { this.ui.toast('当前没有伙伴'); return; }
    list.forEach((inst) => { inst.loyality = 100; });
    try { ps.save(); } catch (e) { /* 存档失败不阻断功能 */ }
    this._refreshPetPanel();
    this.ui.toast('伙伴忠诚度已恢复');
  }

  _refreshPetPanel() {
    try {
      if (panelManager.opened && panelManager.opened['pet'] && panelManager.panels['pet']) {
        panelManager.panels['pet'].render();
      }
    } catch (e) { /* 宠物面板未打开，忽略 */ }
  }

    _portrait() {
      const raw = String(this.st.npcImg || this.st.npcId || '');
      const id = (raw.match(/\d+/) || [])[0];
      if (!id) return '';
      // 实测头像素材在 update/PortraitIcon/icons/Portrait_<6位数字>.png（覆盖 npc 1001-1037 等新月村 NPC）；
      // 只有 Portrait_npc_{id}.png 的 id（见 config/portraits.json）由 url.portrait 直接选对文件名
      return url.portrait(id);
    }

  /** 头像 <img>：对齐 AS3 TalkPanel.updateheader —— Portrait_{id}.png 取不到类时回退
   *  resource/portrait/npc/{id}.png（类名 Portrait_npc_{id}，如兑奖天尊 202019 只有这个文件）。
   *  config/portraits.json 已覆盖已知 npcOnly id（主图直接命中），onerror 兜底仅防御清单过期 */
  _portraitImg() {
    const raw = String(this.st.npcImg || this.st.npcId || '');
    const id = (raw.match(/\d+/) || [])[0];
    if (!id) return '';
    const padded = id.length < 6 ? id.padStart(6, '0') : id;
    const primary = this._portrait();
    const fb = url.icon('portrait', 'Portrait_npc_' + padded + '.png');
    return '<img src="' + primary + '" alt="" data-fb="' + fb + '" '
      + 'style="width:auto;height:auto;max-width:64px;max-height:64px" '
      + 'onerror="if(this.dataset.fb){var f=this.dataset.fb;this.dataset.fb=\'\';this.src=f;}else{this.style.display=\'none\'}"/>';
  }

  close() {
    if (this.st.stage === S.GANG) this.sys.net.closeContribution();
    this.st.stage = 0;
    super.close();
  }
}

// 注册入口
export function registerTalkPanel(panelManager, ui) {
  panelManager.register('talk', () => new TalkPanel(ui));
}
