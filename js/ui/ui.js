// ui.js
// 对应 deobfuscated/component/*（自绘控件）+ panel/*（UI 面板）
// 负责：顶部 HUD（头像/等级/血蓝/经验）、右上小地图、底部聊天与系统日志、
//       技能热键栏、NPC 对话弹窗，以及把「角色/背包/技能/任务/调试」面板注册进 PanelManager 单例。
//
// 面板系统对齐 AS：PanelManager（单例调度）+ BasePanel（九宫格背景基类），
// 具体面板实现见 ui/panels.js，统一通过 panelManager.open/close/toggle 开关。

import { url, Config, loadSmallmap } from '../core/globals.js?v=20261007c';
import { MapSystem } from '../core/map.js?v=20261007c';
import { requestCommand, CMD } from '../core/net.js?v=20261007c';
import { panelManager } from './panel-manager.js?v=20261007c';
import { BagPanel, SkillPanel, QuestPanel, DebugPanel, registerCatalog } from './panels.js?v=20261007c';
import { registerGamePanels } from './game-panels.js?v=20261007c';
import { registerPetAdvancePanel } from './panel-pet-advance.js?v=20261007c';
import { registerRidePetAdvancePanel } from './panel-ridepet-advance.js?v=20261007c';
import { registerRidePetPanel } from './panel-ridepet.js?v=20261007c';
import { registerTalkPanel } from './panel-talk.js?v=20261007c';
import { registerPlayerPanel } from './panel-player.js?v=20261007c';
import { player } from '../player/player.js?v=20261007c';   // 人物面板状态机（属性页接 Fighter 真实值）
import { registerPetPanel } from './panel-pet.js?v=20261007c';
import { registerPlayerSkillPanel } from './panel-player-skill.js?v=20261007c';
import { registerItemFacturePanel } from './panel-item-facture.js?v=20261007c';
// 完整存档（全量游戏状态：存档点 / 备份槽 / 导入导出）——面板 + 运行期上下文注入
import { registerSavePanel } from './panel-save.js?v=20261007c';
import { bindSaveContext, installSaveApi } from '../save/game-save.js?v=20261007c';
// 左上角「城市信息/功能」浮层（1:1 对齐 AS3 face/CityFace.as）——替代原 HUD 角标小地图，
// 「地图」按钮（face_map）承担打开/关闭小地图面板的入口。
import { CityFace } from './city-face.js?v=20261007c';
import { registerTools } from '../tools/workbench.js?v=20261007c';
import { playSfx, initAudio, bindUI } from '../core/sound.js?v=20261007c';
import { TutorManager } from './tutor.js?v=20261007c';
// 物品/背包系统启动：读档（或按 config/player.json 播种）→ 绑定 InventoryManager → 投影到 player
import { bootInventory } from '../item/player-bridge.js?v=20261007c';
// 宠物实例层（PlayerState.pets）：宠物系统三层数据流的中间层，承载玩家持有实例 + 存档
import { petState } from '../pet/pet-state.js?v=20261007c';
import { pet } from '../pet/pet.js?v=20261007c';               // 宠物视图（原型+实例合并，头像 HUD 取 hpMax/portraitImage）
import { ridepetState } from '../ridepet/ridepet-state.js?v=20261007c';   // 骑宠状态（持久化，登录恢复）

const $ = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };

// 右键是否落在「可交互元素」上：表单控件/链接/按钮，或 CSS 标记为可点击（cursor:pointer）。
//   用于区分「面板空白右键关闭面板」与「元素右键走自身逻辑」（如背包物品格右键使用）。
//   空物品格（.bag-cell.empty，cursor: default）算空白，右键仍关闭面板。
function rightClickInteractive(target, panelEl) {
  let el = target;
  while (el && el !== panelEl) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
    if (el.classList && el.classList.contains('bag-cell') && !el.classList.contains('empty')) return true;
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (e) {}
    el = el.parentElement;
  }
  return false;
}
export class UI {
  constructor(layer) {
    this.layer = layer;                 // #ui-layer
    this.sidebar = document.getElementById('sidebar') || layer;   // 右侧独立栏（聊天列/角色面板/战斗指令条入住）
    this.promptLayer = document.getElementById('promptLayer');
    this.player = null;
    this.sm = null;                      // 由 SceneManager 注入（便于面板/调试触发战斗）
    this.panelManager = panelManager;    // ★ ay：面板内部 open 其它面板的统一出口（如宠物面板的「详情」按钮）
    this.onUseItem = null;
    this.onAcceptQuest = null;
    this.onSubmitQuest = null;
    this._questState = [];
    // 游戏面板客户端状态（仓库/强化/伙伴/队伍/战报/设置/当前地图）
    this._warehouse = [];
    this._enhance = {};
    // 宠物实例层（PlayerState.pets）：由 js/pet/pet-state.js 承载并持久化（localStorage）。
    // 本处只**持引用**（ui._pets 与 store.list 是同一数组）——战斗侧 scenes/scene.js 按
    // ui._pets / ui._activePet 读写宠物，故沿用同名，避免为改名而动战斗代码。
    // ★ aw：config/pets.json 已清空（宠物全靠捕捉）⇒ 无存档时列表为空，捉到再进。
    {
      const proto = (Config.data && Config.data.pets) || [];
      const ps = petState().boot(proto);
      this._pets = ps.list;
      this._activePet = ps.activePetId;   // ★ 口径 = petId（与 scene.js 的 petId 比对保持一致）
      this._petSeq = this._pets.length;
    }
    this._team = [];
    this._battleLog = [];
    this._killCount = 0;
    this._settings = { debug: false, sound: true, fps: false, autoBattle: false, customCursor: false, freezeToSystem: false, showOrigin: false };
    this._curMapId = 1;
    bindUI(this);                 // 音效模块实时读取本 UI 的 _settings.sound（开关单一事实来源）
    this.tutor = new TutorManager(this);   // 新手引导主控（步骤序列来自 config/tutor.json）
    this._build();
    this._registerPanels();
    installSaveApi();                     // 完整存档控制台/探针出口（window.__GAMESAVE）
    window.__panelManager = panelManager; // 调试面板引用
    window.__debug = false;               // 调试开关初始关闭（DEBUG 浮标默认隐藏）

    // ── 右键全局收口（对齐 GameWorld.as::rightClick :617）──
    //   分支 0：新手引导进行中 → 禁用右键（return）；分支 6：默认 → useRightClickPanel() 关最顶层可右键关面板。
    //   ★口径（用户确认）：右键只在「面板空白区域 / 游戏区空白」时关闭面板（复用 ESC 逻辑）；
    //     落在可交互元素上（物品格/按钮/装备槽/链接/表单控件，判定标签名或 cursor:pointer）
    //     交由元素自身逻辑处理（如背包右键使用物品），不关闭面板。
    //   面板/元素若已自行 preventDefault，则全局收口不再介入（面板级 handler 优先）。
    window.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented) return;                                   // 面板/元素已自行处理
      if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;  // 输入框保留原生菜单
      if (e.target.closest && e.target.closest('.battle-stage, .battle-ui')) return;                    // 战斗右键交回 battle handler
      if (this.tutor && this.tutor.overlay) return;                     // 分支 0：引导进行中禁用右键
      const panelEl = e.target.closest && e.target.closest('.tsqt-panel');
      if (!panelEl) {
        // 游戏区空白：抑制原生菜单 + 关最顶层可右键关面板
        e.preventDefault();
        // 口径（用户确认）：右键未落在任何面板上时，不关闭任何面板——「关闭」只发生在
        //   右键所点击的面板内（面板空白/未定义区域）。此处仅抑制浏览器原生菜单。
        return;
      }
      // 面板内空白：可交互元素交由其自身逻辑；空白区域 → 关「鼠标所在的这个面板」
      //   ★口径（用户确认）：右键关的是鼠标所在面板，不是最顶层、也不是全部关闭。
      //   该面板不可右键关（isRightClickClose=false）或反查不到实例时，回退 AS3 useRightClickPanel。
      if (rightClickInteractive(e.target, panelEl)) return;
      e.preventDefault();
      const hit = panelEl.__panel;
      if (hit && hit.isRightClickClose) hit.close();
      else panelManager.useRightClickPanel();
    });
  }

  _build() {
    // ── 顶部左上：系统菜单（角色/背包/技能/任务）──
    // 真实按钮精灵：update/GameWorld/images/img40.png（71×22 奶白圆角按钮，对应原客户端菜单按钮）
    this.menu = $(`
      <div class="hud-menu">
        <button class="hud-menu-btn hud-master tsqt-bar-btn tsqt-btn-gold" title="系统菜单"><span>菜单</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="playerpanel"><span>角色</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="bag"><span>背包</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="skill"><span>技能</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="playerskillpanel"><span>技能面板</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="quest"><span>任务</span></button>
        <span class="hud-menu-sep"></span>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="shop"><span>商店</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="warehouse"><span>仓库</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="chest"><span>宝箱</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="forge"><span>强化</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="itemfacture"><span>打造</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="pet"><span>伙伴</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="petadvance"><span>进阶</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="ridepetadvance"><span>骑宠进阶</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="ridepet"><span>骑宠</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="talk"><span>对话</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="moncfg"><span>怪物</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="bestiary"><span>图鉴</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="achv"><span>成就</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="medal"><span>勋章</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="settings"><span>设置</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="save"><span>存档</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="team"><span>队伍</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="battlelog"><span>战报</span></button>
        <span class="hud-menu-sep"></span>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="rank"><span>排行</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="title"><span>称号</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="mount"><span>坐骑</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="emote"><span>表情</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="activity"><span>活动</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="skillbook"><span>技书</span></button>
        <button class="hud-menu-btn tsqt-bar-btn tsqt-btn-gold" data-panel="help"><span>帮助</span></button>
        <span class="hud-menu-sep"></span>
        <button class="hud-menu-btn wb-entrance tsqt-bar-btn tsqt-btn-orange" data-panel="workbench"><span>工具台</span></button>
        <button class="hud-menu-btn wb-entrance tsqt-bar-btn tsqt-btn-orange" data-panel="toolhelp"><span>工具帮助</span></button>
      </div>`);
    this.layer.appendChild(this.menu);
    this.menu.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        playSfx('click');
        if (b.classList.contains('hud-master')) { this.menu.classList.toggle('open'); return; }
        panelManager.toggle(b.dataset.panel);
        this.menu.classList.remove('open');   // cf: pick an entry -> collapse the grid back to the master button
      };
    });

    // ── 左上：CityFace 城市信息/功能浮层 + 任务追踪 ──
    // ★ 对齐 AS3 face/CityFace.as（详见 city-face.js 头注释）：
    //   5 张底图叠加 + 城名/坐标文本 + 功能按钮（仙葫/地图/商城/路人/系统/公告/换线/指引/隐藏玩家）。
    // ★ 原「HUD 角标小地图」已按需求移除——打开小地图的入口迁到 CityFace 的「地图」按钮
    //   （face_map，对齐 AS3 Face_Map；点击打开小地图面板，面板存在时再次点击关闭），
    //   快捷键 M 入口保持不变。坐标/标记绘制能力全部保留在「小地图面板」（ui/minimap-panel.js）。
    this.hudTray = $(`
      <div class="hud-tray">
        <div class="hud-quest"></div>
      </div>`);
    this.layer.appendChild(this.hudTray);
    this.cityFace = new CityFace(this);
    this.hudTray.insertBefore(this.cityFace.dom, this.hudTray.firstChild);
    this.questTracker = this.hudTray.querySelector('.hud-quest');

    // 小地图标记图标（对齐 AS3 SmallMapPanel：map_ball/map_flag/panel_business/panel_mission/
    // panel_source/panel_sending，均真实存在于 res 域，由 resolve_res 校验，零臆造）。
    // ★ 这些预载图为「小地图面板」共用（minimap-panel.js 读 ui._miniImgs），角标小地图移除后仍保留。
    this._miniImgs = {
      ball:     this._miniLoad(url.res('mapball.png')),
      flag:     this._miniLoad(url.res('mapflag.png')),
      shop:     this._miniLoad(url.res('panelbusiness.png')),
      quest:    this._miniLoad(url.res('panelmission.png')),
      teleport: this._miniLoad(url.res('panelsending.png')),
      monster:  this._miniLoad(url.res('npctaskicon10005.png')),   // 可战斗 NPC（用户指定图标）
    };
    // 四类图层开关（商人/任务/资源/传送点）在「小地图面板」（ui/minimap-panel.js，按 M 或点
    //   CityFace「地图」按钮打开）。状态存于此（ui._miniLayersVisible），面板与 HUD 共用同一可见性真源。
    this._miniLayersVisible = { shop: true, quest: true, monster: true, teleport: true };

    // ── 角色/宠物头像浮层：贴游戏区右上角，1:1 对齐 AS3 PlayerFace / PetFace ──
    // AS3（deobfuscated/face/PlayerFace.as:42 / PetFace.as:26）：x = SCENE_WIDTH - bgWidth = 652、y = 1，
    //   宠物 x = SCENE_WIDTH - 296 = 504（紧邻玩家左侧 148px），都是盖在游戏画面上的独立浮层，**不在右侧聊天面板里**。
    //   Web 端对应：挂 #ui-layer 并绝对定位到游戏区右上角（玩家 right:var(--sidebar-w) 对齐 #world 右边缘、top:1px；
    //   宠物 right:calc(var(--sidebar-w) + 148px)）。布局/位图全部走 css/style.css 的 .hud-face（AS3 原始坐标）。
    // 注：旧「真气(sp)」HUD 条已移除——存档 np.sp 已并入怒气(rage)显示（见 MEMORY.md 角色属性模型），
    //   玩家第三条沿用 AS3 的 SP 条位（facesp.png）显示怒气；宠物无该条（PetFace.initSP 空实现）。
    this.hudChar = $(`
      <div class="hud-face player" title="角色面板（快捷键 C）">
        <div class="portrait-wrap"><img class="portrait" alt="" /></div>
        <div class="level-bg"><span></span></div>
        <div class="name-bg"><span></span></div>
        <div class="bar hp"><i></i><span></span></div>
        <div class="bar mp"><i></i><span></span></div>
        <div class="bar sp"><i></i><span></span></div>
        <div class="bar exp"><i></i><span></span></div>
      </div>`);
    this.layer.appendChild(this.hudChar);
    this.hudChar.onclick = () => { playSfx('click'); panelManager.toggle('playerpanel'); };   // 对齐 AS3 clickHeadHandler（点 PlayerFace 开 PANEL_PLAYER）
    this.portrait = this.hudChar.querySelector('.portrait');
    this.nameEl   = this.hudChar.querySelector('.name-bg span');
    this.levelEl  = this.hudChar.querySelector('.level-bg span');
    this.hpBar = this.hudChar.querySelector('.bar.hp');
    this.hpFill = this.hpBar.querySelector('i'); this.hpTxt = this.hpBar.querySelector('span');
    this.mpBar = this.hudChar.querySelector('.bar.mp');
    this.mpFill = this.mpBar.querySelector('i'); this.mpTxt = this.mpBar.querySelector('span');
    this.rageBar = this.hudChar.querySelector('.bar.sp');
    this.rageFill = this.rageBar.querySelector('i'); this.rageTxt = this.rageBar.querySelector('span');
    this.expBar = this.hudChar.querySelector('.bar.exp');
    this.expFill = this.expBar.querySelector('i'); this.expTxt = this.expBar.querySelector('span');

    // 宠物头像浮层（对齐 AS3 PetFace：贴玩家左侧 148px，HP/MP/EXP 三条，无 SP）。
    //   数据 = 当前出战宠物（petState().active，state===1 首只）；无出战宠物时整体隐藏。
    //   头像优先取 portraitImage，缺图回退 AS3 默认图 panel_pet_default（panelpetdefault.png 40×40）。
    this.hudPet = $(`
      <div class="hud-face pet" title="宠物面板（快捷键 P）" style="display:none">
        <div class="portrait-wrap"><img class="portrait" alt="" /></div>
        <div class="level-bg"><span></span></div>
        <div class="name-bg"><span></span></div>
        <div class="bar hp"><i></i><span></span></div>
        <div class="bar mp"><i></i><span></span></div>
        <div class="bar sp"><i></i><span></span></div>
        <div class="bar exp"><i></i><span></span></div>
      </div>`);
    this.layer.appendChild(this.hudPet);
    this.hudPet.onclick = () => { playSfx('click'); panelManager.toggle('pet'); };   // 对齐 AS3 clickHeadHandler（点 PetFace 开 PANEL_PET）
    this.petPortrait = this.hudPet.querySelector('.portrait');
    this.petNameEl   = this.hudPet.querySelector('.name-bg span');
    this.petLevelEl  = this.hudPet.querySelector('.level-bg span');
    this.petHpBar  = this.hudPet.querySelector('.bar.hp');
    this.petHpFill = this.petHpBar.querySelector('i');  this.petHpTxt  = this.petHpBar.querySelector('span');
    this.petMpBar  = this.hudPet.querySelector('.bar.mp');
    this.petMpFill = this.petMpBar.querySelector('i');  this.petMpTxt  = this.petMpBar.querySelector('span');
    this.petExpBar = this.hudPet.querySelector('.bar.exp');
    this.petExpFill = this.petExpBar.querySelector('i'); this.petExpTxt = this.petExpBar.querySelector('span');

    // ── 底部中央：技能热键栏（F1~F8）──
    this.skillbar = $(`<div class="hud-skillbar"></div>`);
    this.layer.appendChild(this.skillbar);

    // ── 右侧整列：系统类(上) / 剧情类(下) 双聊天窗（替换原单 .logbox）──
    // 标题条(上下框)对齐 _MessageFace_仿制.html：使用原版 LoginResource 位图 strip + 标题；
    // 黄色版本号在左，无频道分页。
    const _verSeg = (window.__TS_BUILD || '').split('·')[0].trim();
    const _verTag = _verSeg.split('-').pop() || _verSeg || '?';
    const _sysTitle = url.resLogin('textfacesystem.png');
    this.chatCol = $(`
      <div class="chat-col msgface">
        <div class="chat-box chat-sys">
          <div class="chat-head"><span class="chat-ver">版本:${_verTag}</span><img class="chat-title-img" src="${_sysTitle}" alt="系统消息"/></div>
          <div class="chat-body"></div>
        </div>
        <div class="chat-box chat-story">
          <div class="chat-head"><span class="chat-title-txt">剧情</span></div>
          <div class="chat-body"></div>
        </div>
      </div>`);
    this.sidebar.appendChild(this.chatCol);
    this.sysChat   = this.chatCol.querySelector('.chat-sys .chat-body');
    this.storyChat = this.chatCol.querySelector('.chat-story .chat-body');
    this.verEl     = this.chatCol.querySelector('.chat-ver');

    // ── 调试入口（浮动按钮，对应原版内部调试）──
    this.debugFab = $(`<button class="hud-debug-fab" title="调试面板">🛠</button>`);
    this.layer.appendChild(this.debugFab);
    this.debugFab.onclick = () => panelManager.toggle('debug');
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F9') { e.preventDefault(); panelManager.toggle('debug'); }
    });
    // F1~F8：战斗中映射 HUD 技能热键栏（攻击 / 技能），对齐槽位标签；主城或面板打开时不触发，避免误触
    window.addEventListener('keydown', (e) => {
      const m = /^F([1-8])$/.exec(e.key);
      if (!m) return;
      const sc = this.sm && this.sm.current;
      const inBattle = sc && sc.constructor.name === 'BattleScene' && !sc._ended;
      if (!inBattle) return;
      const tag = document.activeElement;
      if (tag && (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA' || tag.isContentEditable)) return;
      if (Object.values(panelManager.opened || {}).some(v => v)) return;   // 任意面板打开时不抢热键
      e.preventDefault();
      const idx = parseInt(m[1], 10) - 1;
      const slot = this._skillSlots && this._skillSlots[idx];
      if (slot) { playSfx('click'); this._useSkillbarSlot(slot); }
    });
    // M：开关全屏小地图面板（与角标点击打开同一面板；输入框聚焦或战斗中跳过避免误触）
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      const tag = document.activeElement;
      if (tag && (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA' || tag.isContentEditable)) return;
      const sc = this.sm && this.sm.current;
      if (sc && sc.constructor && sc.constructor.name === 'BattleScene' && !sc._ended) return;
      e.preventDefault();
      if (typeof playSfx === 'function') playSfx('click');
      panelManager.toggle('minimap');
    });
    // ESC：关闭任意打开的面板 / 对话框（兜底，避免模态面板困住玩家——点击被吞、原 ESC 只关引导遮罩）。
    // 与 tutor.js 的 ESC 关闭引导互不冲突：tutor 不是 panelManager 面板，本处理器会跳过。
    // 强制解除所有 UI 锁定（DOM 级，不依赖 panelManager 内部状态）：
    // 无论面板/对话框/引导遮罩以何种方式残留，都直接隐藏并解锁移动。
    const forceClearUI = () => {
      try { panelManager.closeAllNormal(); } catch (_) {}
      document.querySelectorAll('.tsqt-panel').forEach(el => { el.style.display = 'none'; });
      document.querySelectorAll('.tutor-overlay').forEach(el => el.remove());
      try { for (const k in panelManager.opened) panelManager.opened[k] = false; } catch (_) {}
      if (this.player && typeof this.player.allowMove === 'function') {
        try { this.player.allowMove(); } catch (_) {}
      }
    };
    // 暴露到实例：构造函数内的右键全局收口（contextmenu 处理器）与 _build 作用域的 const 本不可见，挂实例后右键空白关闭面板才不会抛 ReferenceError（ESC/自救键仍走局部 const，行为不变）。
    this.forceClearUI = forceClearUI;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const anyPanel = Object.values(panelManager.opened || {}).some(v => v);
      const overlay = document.querySelector('.tutor-overlay');
      const visiblePanel = [...document.querySelectorAll('.tsqt-panel')].some(el => getComputedStyle(el).display !== 'none');
      const sc = this.sm && this.sm.current;
      if (anyPanel || overlay || visiblePanel) {
        e.preventDefault();
        forceClearUI();
        console.log('%c[ESC] 已强制关闭面板/对话框/引导遮罩并解锁移动', 'color:#1f8b4c;font-weight:bold');
        return;
      }
      // 战斗中按 ESC = 尝试逃跑
      if (sc && sc.constructor && sc.constructor.name === 'BattleScene' && !sc._ending) {
        const escBtn = document.querySelector('.battle-escape');
        if (escBtn) { e.preventDefault(); escBtn.click(); }
      }
    });
    // 紧急自救键（` 反引号：键盘左上角、数字 1 左边那个键）：任意软锁/卡死兜底——
    //   解锁玩家移动 + 关闭残留面板/对话框/引导遮罩 + 战斗中尝试逃跑。
    //   与上方 ESC(关面板/对话框) 互补：ESC 关不掉时，按 ` 强制解除。不改变任何正常玩法，仅作卡死逃生。
    window.addEventListener('keydown', (e) => {
      if (e.key !== '`') return;
      forceClearUI();
      const sc = this.sm && this.sm.current;
      if (sc && sc.constructor && sc.constructor.name === 'BattleScene' && !sc._ending) {
        const escBtn = document.querySelector('.battle-escape');
        if (escBtn) escBtn.click();
      }
      console.log('%c[自救] 已强制解除所有 UI 锁定 + 解锁移动' + (sc && sc.constructor && sc.constructor.name === 'BattleScene' ? ' + 战斗中已尝试逃跑' : ''), 'color:#1f8b4c;font-weight:bold');
    });

    // ── 常驻 DEBUG 浮标（调试开关开启时显示：FPS / 场景 / 鼠标）──
    // 对齐 AS3 DebugPanel 的 fpsField/mouseField + SceneManager 当前场景名。
    this.debugHud = $(`
      <div class="dbg-hud-overlay hidden">
        <div class="dhud-row fps-row">FPS <b class="dhud-fps">—</b></div>
        <div class="dhud-row">场景 <b class="dhud-scene">—</b></div>
        <div class="dhud-row">地图 <b class="dhud-map">—</b></div>
        <div class="dhud-row">鼠标 <b class="dhud-mouse">0, 0</b></div>
      </div>`);
    this.layer.appendChild(this.debugHud);
    this._dhudRaf = 0; this._dhudFrames = 0; this._dhudLast = performance.now(); this._dhudFps = 0;
    this._dhudMx = 0; this._dhudMy = 0;
    window.addEventListener('mousemove', (e) => { this._dhudMx = e.clientX; this._dhudMy = e.clientY; });

  }

  // 注册所有面板为单例（首次 open 时实例化，之后常驻）
  _registerPanels() {
      panelManager.register('bag',   () => new BagPanel(this));
    panelManager.register('skill', () => new SkillPanel(this));
    panelManager.register('quest', () => new QuestPanel(this));
    panelManager.register('debug', () => new DebugPanel(this));
    // 真实可交互游戏面板（商店/仓库/强化/伙伴/世界地图/图鉴/成就/设置/队伍/战报）
    registerGamePanels(panelManager, this);
    // 14 面板 1:1 复刻工程：宠物进阶（PetAdvancePanelNew + PetWuRate + PetSkill + PetNeiDan）
    registerPetAdvancePanel(panelManager, this);
    // 14 面板 1:1 复刻工程：骑宠进阶（RidePetAdvancePanel + RidePetInfo/RidePetWuRate/ViewRidePetSkill/RidePetFate/RidePetTalent）
    registerRidePetAdvancePanel(panelManager, this);
    // 骑宠系统（纸娃娃骑乘：输入骑宠ID/角色ID，面板内预览合成，上骑/下骑切换）
    registerRidePetPanel(panelManager, this);
    // 14 面板 1:1 复刻工程：对话/任务（TalkPanel + TalkRight/DescTaskPanel/FinishItem/EquipItemPanel/TaskContribution）
    registerTalkPanel(panelManager, this);
    // 14 面板 1:1 复刻工程：角色主面板（PlayerPanel + ViewProperty/ViewArm/ViewHeart/ViewBagde/ViewEssence）
    registerPlayerPanel(panelManager, this);
    // 14 面板 1:1 复刻工程：宠物主面板（PetPanel，覆盖 generic As3Panel 的 pet）
    registerPetPanel(panelManager, this);
    registerPlayerSkillPanel(panelManager, this);
    // 14 面板 1:1 复刻工程：装备制造与强化系统容器（ItemPanel03 / 14 按钮网格 + 14 子面板路由器）
    registerItemFacturePanel(panelManager, this);
    // 完整存档面板（顶栏「存档」按钮）
    registerSavePanel(panelManager, this);
    // 把 deobfuscated/panel 下全部 AS3 面板类登记为可召唤占位面板
    registerCatalog(panelManager, this);
    // 研发/运营工具台（6 大类 23 个配置/调试工具）
    registerTools(panelManager, this);
  }

  /** 出战宠物变更后同步（面板「设为出战」/ 收服后调用）：让 ui._activePet 与实例层 state 对齐。 */
  refreshActivePet() {
    const ps = petState();
    ps.syncActiveFromState();
    this._activePet = ps.activePetId;
    // ★ 切换出战宠物后立即刷新 HUD（否则面板改了、右上宠物浮层不切换）
    this.refresh();
    return this._activePet;
  }

  bindPlayer(fighter) {
    this.player = fighter;
    // 人物面板的状态机接入运行期主角：属性页由「抓包快照」改为读 Fighter 真实值（含装备加成）
    try { player().bindFighter(fighter || null); } catch (e) { /* 忽略：不阻断登录 */ }
    // 物品/背包系统启动（幂等，仅首次生效）：存档契约成为 player.bag / player.equip 的唯一真源。
    // 用 try/catch 兜底：物品系统异常绝不阻断登录流程（铁律：主循环/登录不可被杀）。
    try {
      if (fighter) bootInventory(fighter);
    } catch (e) {
      console.error('[inventory] 启动失败（已忽略，不影响登录）：', e);
    }
    // 完整存档：注入运行期上下文（ui/sm/player），供 game-save.js 采集与恢复；异常一律不阻断登录
    try { bindSaveContext({ ui: this, sm: this.sm, player: fighter }); } catch (e) { /* 忽略 */ }
    // 新手引导：首次进入主城（玩家绑定成功）且未完成时自动开始；已完成则不再弹出（localStorage 持久化）
    if (this.tutor && !this.tutor.finished) this.tutor.start();
    // 强化层与战斗 Fighter 共用同一对象，避免「面板显示 +lv、战斗无加成」的退化（ForgePanel 写入即生效）
    this._enhance = (fighter && fighter.enhance) || this._enhance || {};
    if (fighter.portrait) {
      // ★ 头像目录文件名一律 Portrait_<6位补零>.png（PortraitIcon/icons 下无纯数字名），
      //   必须走 url.portrait 补零+前缀；旧口径 url.icon('portrait', id) 必 404。
      this.portrait.src = url.portrait(fighter.portrait);
      this.portrait.onerror = () => { this.portrait.style.visibility = 'hidden'; };
    }
    this.refresh();
    this._buildSkillbar();
    if (this._questState.length) this._renderQuestTracker(this._questState);
    // 骑宠系统：恢复持久化的骑乘状态（骑宠只在主城有效；战斗中由 BattleScene 临时隐藏，回城自动恢复）
    try {
      if (ridepetState.riding && ridepetState.ridepetId && fighter) {
        if (ridepetState.charId && String(fighter.charId) !== String(ridepetState.charId)) {
          fighter.setCharId(ridepetState.charId);
        }
        fighter.mountRide(ridepetState.ridepetId);
      }
    } catch (e) { console.warn('[ridepet] 恢复骑乘状态失败（已忽略）：', e); }
    // 邮件系统已删除：原邮件「欢迎信」改为登录时在右侧系统聊天窗显示一次（会话内只一次，防重连重复）
    if (!this._welcomeSaid) {
      this._welcomeSaid = true;
      this.log('欢迎来到天书奇谈单机版！愿你在这方江湖中畅快游历。', 'sys');
    }
  }

  refresh() {
    this._setVersion();
    const p = this.player; if (!p) return;
    // 名字与等级分开显示（对齐 AS3 FaceHandler.setNameText/setLevelText：名字在 face_name_bg、等级在 face_level_bg）
    this.nameEl.textContent = p.name;
    this.levelEl.textContent = p.level;
    this._setBar(this.hpBar, this.hpFill, this.hpTxt, p.hp, p.maxHp, 'HP');
    this._setBar(this.mpBar, this.mpFill, this.mpTxt, p.mp, p.maxMp, 'MP');
    // 第三条显示 SP（对齐 AS3 PlayerFace 的 SP 条）：单机版 np.sp 已并入怒气（见 MEMORY.md），
    //   数据仍取 p.rage/rageMax，仅显示口径改 SP（与 player.js 的 spCur→rage 映射一致）。
    this._setBar(this.rageBar, this.rageFill, this.rageTxt, p.rage, p.rageMax, 'SP');
    this._setBar(this.expBar, this.expFill, this.expTxt, p.exp, p.expNext, 'EXP');
    this.rageBar.style.display = (p.rageMax > 0) ? '' : 'none';
    this._refreshPetHud();
  }

  // 宠物头像浮层刷新（对齐 AS3 PetFace）。
  //   ★ AS3 PetFace 构造即 updateHeadSprite("-1") 显示默认头像 panel_pet_default —— **没有出战宠物时浮层仍显示空头像**，
  //     不隐藏（用户 2026-10-04 裁决：学 AS3 显示空的宠物头像）。
  //   有出战宠物时：数据 = petState().active（state===1 首只）；刷新时机随 refresh() 一起走 ——
  //     场景的伤害/回合/进战/捕捉/读档/战斗结束回写均已调用 ui.refresh()，故战斗中宠物血条实时跟随。
  _refreshPetHud() {
    if (!this.hudPet) return;
    const ps = petState();
    const inst = ps && ps.active;                    // state===1 的首只（petState.active）
    const img = this.petPortrait;
    // 头像统一走 url.portrait（PortraitIcon 目录文件名 = Portrait_<6位补零>.png，无纯数字名，旧口径必 404）
    const setPortrait = (pid) => {
      img.onerror = () => { img.onerror = null; img.src = url.res('panelpetdefault.png'); };   // 回退 AS3 默认图
      img.src = pid ? url.portrait(pid) : url.res('panelpetdefault.png');
    };
    if (!inst) {
      // 无出战宠物：默认头像 + 数据清空（AS3 PetFace 默认态），浮层保持显示
      this.hudPet.style.display = '';
      this.petNameEl.textContent = '';
      this.petLevelEl.textContent = '';
      this._setBar(this.petHpBar, this.petHpFill, this.petHpTxt, 0, 0, 'HP');
      this._setBar(this.petMpBar, this.petMpFill, this.petMpTxt, 0, 0, 'MP');
      this._setBar(this.petExpBar, this.petExpFill, this.petExpTxt, 0, 0, 'EXP');
      setPortrait(null);
      return;
    }
    this.hudPet.style.display = '';
    // 视图（原型 + 实例合并）：name/level/hpMax/mpMax/expMax/portraitImage 从原型/角色表派生，hpCur/mpCur/exp 从实例取
    const v = pet().get(inst.petId) || {};
    this.petNameEl.textContent = v.name || '宠物';
    this.petLevelEl.textContent = Number(v.level) || 1;
    this._setBar(this.petHpBar, this.petHpFill, this.petHpTxt, Number(inst.hpCur) || 0, Number(v.hpMax) || 0, 'HP');
    this._setBar(this.petMpBar, this.petMpFill, this.petMpTxt, Number(inst.mpCur) || 0, Number(v.mpMax) || 0, 'MP');
    this._setBar(this.petExpBar, this.petExpFill, this.petExpTxt, Number(inst.exp) || 0, Number(v.expMax) || 0, 'EXP');
    setPortrait(v.portraitImage || null);
  }

  // 标题条左侧黄色版本号（对齐 _MessageFace_仿制.html）：从全局构建戳取末端 tag（如 2026-09-14j → 14j）
  _setVersion() {
    if (!this.verEl) return;
    const _seg = (window.__TS_BUILD || '').split('·')[0].trim();
    const _tag = _seg.split('-').pop() || _seg;
    this.verEl.textContent = '版本:' + (_tag || '?');
    // 兜底：若 UI 早于 window.__TS_BUILD 赋值就构建，最多重试 ~3s 直到全局戳可读。
    if (!window.__TS_BUILD && (!this._verTries || this._verTries < 10)) {
      this._verTries = (this._verTries || 0) + 1;
      setTimeout(() => this._setVersion(), 300);
    }
  }

  _buildSkillbar() {
    const p = this.player; if (!p) return;
    this.skillbar.innerHTML = '';
    const slots = [{ key: 'F1', name: '攻击', icon: url.icon('skill', 'Skill_10010.png'), attack: true }];
    (p.skills || []).forEach((id) => {
      // cc: passives give bonuses only - never shown on the castable skillbar;
      //   key follows the visible slot order (attack=F1, first castable=F2...) so hidden passives never skip F-keys
      const s = Config.skills[id]; if (!s || s.passive || slots.length >= 8) return;
      slots.push({ key: 'F' + (slots.length + 1), name: s.name, icon: url.icon('skill', s.icon), skill: s });
    });
    if (!slots.length) return;
    this._skillSlots = slots;   // 供 F1~F8 键盘热键映射（战斗中可用）
    for (const sl of slots) {
      const slot = $(`
        <div class="skill-slot" title="${sl.name}（战斗中可用）">
          <img class="skill-slot-bg" src="${url.gwImg('img10')}" alt=""/>
          <img class="skill-ico" src="${sl.icon}" alt=""/>
          <span class="skill-key">${sl.key}</span>
          <span class="skill-name">${sl.name}</span>
        </div>`);
      slot.querySelector('.skill-slot-bg').onerror = () => slot.classList.add('noimg');
      slot.querySelector('.skill-ico').onerror = () => { slot.querySelector('.skill-ico').style.visibility = 'hidden'; };
      slot.onclick = () => {
        playSfx('click');
        // 战斗中：点击热键栏直接驱动 BattleScene 对应指令（对齐战斗指令条）；非战斗态保持原提示
        if (this._useSkillbarSlot(sl)) return;
        this.toast(sl.attack ? '普通攻击（战斗中可用）' : ('技能：' + sl.name + '（战斗中可用）'));
      };
      this.skillbar.appendChild(slot);
    }
  }

  // HUD 技能热键栏槽位桥接：若在战斗中则驱动 BattleScene 对应指令，返回 true 表示已消费（战斗中）
  _useSkillbarSlot(sl) {
    const sc = this.sm && this.sm.current;
    if (!sc || sc.constructor.name !== 'BattleScene' || sc._ended) return false;
    if (sl.attack) sc._triggerSkillbarAttack();
    else if (sl.skill) sc._triggerSkillbarCast(sl.skill);
    return true;
  }

  setMinimapMap(mapId) {
    // ★ HUD 角标小地图已移除（入口迁至 CityFace「地图」按钮）：不再为角标预载底图，
    //   小地图面板（minimap-panel.js）按需在 onOpen 时自载 Smallmap_<resId>.png。
    //   保留方法签名供 enterMap 调用，零开销。
    if (!this.minimapImg) return;
    if (this._miniMapId === mapId) return;
    this._miniMapId = mapId;
    // 资源编号用 map.resId（真实客户端 mapImg），而非自增 mapId，否则 Smallmap_<id>.png 404 黑屏
    const map = (Config.maps || []).find(m => m.id === mapId);
    const resId = (map && map.resId != null) ? map.resId : mapId;
    // update 优先、icon2 兜底（两源互补：update 含新区图 1050，icon2 含旧图 1）
    loadSmallmap(this.minimapImg, resId, {
      onLoad: () => { this._miniImgOk = true;  this.minimapWrap.classList.remove('noimg'); },
      onFail: () => { this._miniImgOk = false; this.minimapWrap.classList.add('noimg'); }
    });
  }

  // 真正切换世界地图：更新小地图 + 驱动 MainScene.changeMap（多地图核心入口）
  // 世界地图面板「传送到 X」、调试传送、hub 传送点打开地图后点选均走这里。
  enterMap(mapId) {
    this._curMapId = mapId;
    this.setMinimapMap(mapId);
    const sc = this.sm && this.sm.current;
    if (sc && typeof sc.changeMap === 'function') sc.changeMap(mapId);
    else this.toast('当前不在地图场景，无法切换');
  }

  // 小地图标记图预加载（同源 http，无需 crossOrigin）
  _miniLoad(src) { const i = new Image(); i.src = src; return i; }

  // HUD 帧刷新（由主循环 _loopStep('hud') 驱动）：左上角城市信息栏的城名/坐标随玩家移动刷新。
  // ★ 角标小地图移除后，原每帧重绘 376×264 canvas 的逻辑已停用（见下方 updateMinimap 守卫）：
  //   不再分配 canvas、不再每帧绘制标记/路径/坐标，零后台开销（需求：确认删掉不占资源）。
  updateHud(player) {
    if (this.cityFace) this.cityFace.tick(player);
  }

  // 旧「HUD 角标小地图」每帧重绘入口。角标小地图已移除（this.minimap 不再创建），
  //   首行守卫直接 return ⇒ 零绘制开销；方法保留供历史调用链兜底，新代码请用 updateHud。
  updateMinimap(mapLayerEl, worldW, worldH, player, npcs) {
    const cv = this.minimap; if (!cv) return;
    const W = cv.width, H = cv.height;
    const ctx = this.minimapCtx;
    ctx.clearRect(0, 0, W, H);
    const sx = W / worldW, sy = H / worldH;
    if (!this._miniImgOk) { ctx.fillStyle = '#0e1424'; ctx.fillRect(0, 0, W, H); }

    // 在画布上绘制一张已加载的标记图标；anchor: center=中心对齐 / bottom=底边对齐（旗）
    const drawImg = (img, x, y, anchor) => {
      if (!img || !img.complete || !img.naturalWidth) return null;
      const w = img.naturalWidth, h = img.naturalHeight;
      const dx = x - (anchor === 'bottom' ? 0 : w / 2);
      const dy = y - (anchor === 'bottom' ? h : h / 2);
      ctx.drawImage(img, dx, dy);
      return { w, h };
    };

    // ① 图层标记（商人/任务/传送点）→ 真实 panel_* 图标，按世界坐标等比映射到小地图
    //    （对齐 AS3 SmallMapPanel.addPoint/setLayer；怪物不在 AS3 小地图图层内，
    //     用 npctaskicon10005 图标作 gameplay 提示，数据真实非臆造；图标未就绪时回落小红点）
    (npcs || []).forEach(n => {
      const t = n.npcData && n.npcData.type;
      let key = null;
      if (t === 'shop') key = 'shop';
      else if (t === 'quest') key = 'quest';
      else if (t === 'teleport') key = 'teleport';
      if (key) {
        if (this._miniLayersVisible[key]) drawImg(this._miniImgs[key], n.x * sx, n.y * sy, 'center');
      } else if (t === 'monster') {
        if (this._miniLayersVisible.monster === false) return;
        const mi = this._miniImgs.monster;
        if (!drawImg(mi, n.x * sx, n.y * sy, 'center')) {
          ctx.fillStyle = '#ff5a5a';
          ctx.beginPath(); ctx.arc(n.x * sx, n.y * sy, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    });

    // ② 玩家寻路路径：红色 2px 折线（对齐 AS3 paintPath lineStyle(2, 0xff0000)），
    //    起点补玩家当前坐标使折线从 ball 出发；终点放置 map_flag（对齐 AS3 flag）
    if (player && player.path && player.path.length > 0) {
      ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = 2;
      ctx.beginPath();
      const pts = [{ x: player.x, y: player.y }].concat(player.path);
      pts.forEach((pt, i) => {
        const x = pt.x * sx, y = pt.y * sy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const last = pts[pts.length - 1];
      drawImg(this._miniImgs.flag, last.x * sx, last.y * sy, 'bottom');
    }

    // ③ 玩家位置点（map_ball，对齐 AS3 ball：value/mapWidth*width 居中）
    if (player) drawImg(this._miniImgs.ball, player.x * sx, player.y * sy, 'center');

    // ④ 坐标文本（roadPointX/Y，对齐 AS3 updateRoadPointXY：玩家地图坐标）
    // 【修复"小地图XY轴看不见"】原 11px → 显示约 5.5px（376×264 backing → 188×132 容器），
    //    字号过小且无衬底，肉眼不可辨。现加大字号 + 半透明深底框 + 高对比文字，一眼可读。
    //    用户明确要求"网格 XY（非像素）"：统一用 MapSystem.getGridPos 反算 RP 格(col/row)，
    //    与【打开后的小地图】悬浮读出的 RP 坐标一致，不再显示世界像素。
    if (player) {
      const rp = MapSystem.getGridPos(player.x, player.y);
      const text = `X: ${rp.col}    Y: ${rp.row}`;
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const padX = 7, padY = 4;
      const tw = ctx.measureText(text).width;
      const lineH = 22;
      const bx = 4, by = H - lineH - padY * 2 - 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, tw + padX * 2, lineH + padY * 2);
      ctx.fillStyle = '#ffe680';
      ctx.fillText(text, bx + padX, by + lineH + 1);
    }
  }

  _setBar(bar, fill, txt, cur, max, label) {
    const pct = max ? Math.max(0, Math.min(1, cur / max)) : 0;
    fill.style.width = (pct * 100) + '%';
    txt.textContent = `${label} ${Math.round(cur)}/${Math.round(max)}`;
  }

  // 任务流程改造：chat-box 富文本过滤——任务语句（编辑器可配的 acceptText/finishText）走标准 HTML，
  //   只放行 font(color/size)/br/b/i/u/a，其余转义，避免配错内容破坏聊天窗 DOM（单机也防畸形标签）。
  _richLog(msg) {
    const str = String(msg == null ? '' : msg);
    const re = /<a\b[^>]*>|<\/a>|<\/?(?:u|b|i)>|<font\b[^>]*>|<\/font>|<br\s*\/?>/gi;
    let out = '', last = 0, m;
    const esc1 = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    while ((m = re.exec(str))) {
      out += esc1(str.slice(last, m.index));
      const raw = m[0];
      if (/^<\/a/i.test(raw)) out += '';
      else if (/^<\/font/i.test(raw)) out += '</font>';
      else if (/^<br/i.test(raw)) out += '<br/>';
      else if (/^<a\b/i.test(raw)) out += '';
      else if (/^<\/?(u|b|i)>/i.test(raw)) out += raw.toLowerCase();
      else {
        const c = (raw.match(/color\s*=\s*["']?([#\w(),.%\s-]+)["']?/i) || [])[1];
        const z = (raw.match(/size\s*=\s*["']?(\d+)["']?/i) || [])[1];
        out += '<font' + (c ? ` color="${c}"` : '') + (z ? ` style="font-size:${Number(z)}px"` : '') + '>';
      }
      last = re.lastIndex;
    }
    return out + esc1(str.slice(last));
  }

  // 聊天日志分流：type='story' → 右侧「剧情类」窗；其余('sys'/'good') → 右侧「系统类」窗。
  log(msg, type = 'sys') {
    const target = (type === 'story') ? this.storyChat : this.sysChat;
    if (!target) return;
    const line = $(`<div class="log-line log-${type}">${this._richLog(msg)}</div>`);
    target.appendChild(line);
    while (target.childNodes.length > 60) target.removeChild(target.firstChild);
    target.scrollTop = target.scrollHeight;
  }

  toast(msg) {
    const t = $(`<div class="toast">${msg}</div>`);
    (this.promptLayer || this.layer).appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
  }

  // ── 调试开关（DEBUG 浮标 开/关）──
  // 由 DebugPanel 的「调试开关」拨钮调用：切换 window.__debug 并启停常驻浮标。
  setDebug(on) {
    window.__debug = !!on;
    if (window.__debug) this._startDebugHud(); else this._stopDebugHud();
  }
  _sceneLabel() {
    const sc = this.sm && this.sm.current;
    if (!sc) return '—';
    const n = sc.constructor.name;
    return ({ LoginScene: '登录', MainScene: '主城', BattleScene: '战斗' })[n] || n;
  }
  // 地图调试行：#编号 · resId · 名称 · 拼合尺寸 · 格子数 · 贴图世界 · NPC 数（原小地图面板的调试信息）
  _mapDebugLine() {
    const sc = this.sm && this.sm.current;
    const map = (sc && sc.map) || (typeof Config !== 'undefined' && Config.maps && Config.maps[0]) || null;
    if (!map) return '无地图';
    const npcCount = (sc && sc.actors || []).filter(f => f && f.npcData).length;
    return [
      `#${map.id}`, `resId=${map.resId != null ? map.resId : '-'}`, `${map.name || ''}`,
      `拼合 ${map.stitchedW}×${map.stitchedH}`, `格子 ${map.pathCols}×${map.pathRows}`,
      `贴图 ${map.tileWorldW}×${map.tileWorldH}`, `NPC ${npcCount}`,
    ].join(' · ');
  }
  _startDebugHud() {
    if (this._dhudRaf) return;
    this.debugHud.classList.remove('hidden');
    this._applyFpsVisibility();   // 按设置面板「显示 FPS」开关控制 FPS 行显隐
    const tick = (now) => {
      this._dhudFrames++;
      if (now - this._dhudLast >= 500) {
        this._dhudFps = Math.round(this._dhudFrames * 1000 / (now - this._dhudLast));
        this._dhudFrames = 0; this._dhudLast = now;
        const f = this.debugHud.querySelector('.dhud-fps'); if (f) f.textContent = this._dhudFps;
        const s = this.debugHud.querySelector('.dhud-scene'); if (s) s.textContent = this._sceneLabel();
        const mp = this.debugHud.querySelector('.dhud-map'); if (mp) mp.textContent = this._mapDebugLine();
        const m = this.debugHud.querySelector('.dhud-mouse'); if (m) m.textContent = `${this._dhudMx}, ${this._dhudMy}`;
      }
      this._dhudRaf = requestAnimationFrame(tick);
    };
    this._dhudRaf = requestAnimationFrame(tick);
  }
  _stopDebugHud() {
    if (this._dhudRaf) cancelAnimationFrame(this._dhudRaf);
    this._dhudRaf = 0;
    this.debugHud.classList.add('hidden');
  }
  // FPS 行门控：由设置面板「显示 FPS」开关控制（对齐 AS3 DebugPanel.fpsField 可隐藏；默认关 → FPS 行不显示）
  _applyFpsVisibility() {
    if (!this.debugHud) return;
    const row = this.debugHud.querySelector('.fps-row');
    if (row) row.style.display = (this._settings && this._settings.fps) ? '' : 'none';
  }

  // ── 面板兼容入口（旧调用可继续用）──
  togglePanel(name) { panelManager.toggle(name); }
  // openPanel(name, opts)：opts 会在面板打开后注入（单例面板也能接收每次打开的参数）
  //   例：openPanel('npcshop', { shopId: 1003 }) → NpcShopPanel.applyOpenOpts 打开对应 NPC 的商店
  openPanel(name, opts) {
    const p = panelManager.open(name);
    if (p && opts && typeof p.applyOpenOpts === 'function') p.applyOpenOpts(opts);
    return p;
  }
  closePanel() { panelManager.closeAllNormal(); }

  setQuestState(state) {
    this._questState = state;
    this._renderQuestTracker(state);
    if (panelManager.isOpened('quest')) panelManager.open('quest'); // 重渲染
  }

  // ── 背包使用道具（对接 net USE_ITEM）──
  async useItem(itemId) {
    const it = Config.items[itemId];
    if (!it || !it.effect) { this.toast('道具无效'); return; }
    // 在持久玩家 Fighter 上按道具 effect 直接回血/回蓝（对齐 AS3 道具生效）。
    // 注：后端 serverState.player.hp 与战斗内 Fighter 不同步，故以 Fighter 当前值为准，避免用后端陈旧值覆盖真实血量。
    if (it.effect.hp) this.player.hp = Math.min(this.player.maxHp, this.player.hp + (it.effect.hp || 0));
    if (it.effect.mp) this.player.mp = Math.min(this.player.maxMp, this.player.mp + (it.effect.mp || 0));
    if ((it.effect.hp || it.effect.mp)) playSfx('heal');   // 道具治疗音
    if (this.player.updateBar) this.player.updateBar();   // 同步立绘/战斗血条
    const res = await requestCommand(CMD.USE_ITEM, { itemId }); // 后端扣道具并持久化
    if (!res.ok) { this.toast('使用失败'); return; }
    this.log(`使用了 ${it.name || '道具'}`, 'good');
    this.bindPlayer(this.player); // 刷新 HUD（hp/mp）
    const pm = panelManager.panels['bag']; if (pm && panelManager.isOpened('bag')) pm.render();
  }

  async acceptQuest(questId) {
    const res = await requestCommand(CMD.ACCEPT_QUEST, { questId });
    if (!res.ok) return;
    const q = this._questState.find(q => q.id === questId);
    if (q) { q.accepted = true; this.log(`已接取任务：${q.name}`, 'story'); }
    this.setQuestState(this._questState);
  }

  async submitQuest(questId) {
    const res = await requestCommand(CMD.SUBMIT_QUEST, { questId });
    if (!res.ok) return;
    const q = this._questState.find(q => q.id === questId);
    const def = Config.quests[questId];
    if (q) {
      q.done = true; q.accepted = true; q.progress = q.target;
      const r = def && def.reward;
      this.log(`任务完成：${q.name}` + (r ? `，获得 ${r.exp} 经验 / ${r.silver} 银子` : ''), 'story');
    }
    this.setQuestState(this._questState);
  }

  // ── 战斗记录（由 BattleScene 在 _win/_lose 调用，战报面板与图鉴/成就读取）──
  recordBattle(r) {
    this._battleLog = this._battleLog || [];
    r.no = this._battleLog.length + 1;
    this._battleLog.push(r);
    if (r.win) this._killCount = (this._killCount || 0) + 1;
  }

  // ── 右上任务追踪（金边花框 + 任务条目，对齐 AS3 TaskListPanel 已接任务树 + DescTaskPanel 目标）──
  _renderQuestTracker(state) {
    if (!this.questTracker) return;
    const active = state.filter(q => q.accepted && !q.done);
    if (!active.length) { this.questTracker.innerHTML = ''; return; }
    this.questTracker.innerHTML = `<div class="qt-title"><img src="${url.gwImg('img34')}" alt=""/><span>任务追踪</span></div>`;
    for (const q of active) {
      // 真实目标文案（对齐 AS3 DescTaskPanel 显示任务目标）：
      //   ① talk 杀怪条件任务的逐条进度（progressText，如「雪噬灵 1/1、火噬灵 0/1」）优先；
      //   ② 击杀类取怪物名 + 进度；其余回退为 进度/目标
      let goal = `${q.progress}/${q.target}`;
      if (q.progressText) {
        goal = q.progressText;
      } else {
        const def = Config.quests ? Config.quests[q.id] : null;
        if (def && def.target && def.target.type === 'kill' && def.target.monster) {
          const mdef = (Config.monsters && Config.monsters[def.target.monster]) || {};
          const mn = mdef.name || def.target.monster;
          goal = `击败 ${mn} ${q.progress}/${q.target}`;
        }
      }
      const row = $(`
        <div class="qt-row" data-qid="${q.id}" title="点击查看任务详情">
          <div class="qt-name">${q.name}</div>
          <div class="qt-prog">${goal}</div>
        </div>`);
      // 可点跳转（对齐 AS3 任务追踪/任务列表点击：打开任务面板并定位该任务）
      row.onclick = () => {
        playSfx('click');
        panelManager.open('quest');
        const qp = panelManager.panels['quest'];
        if (qp && qp.focusQuest) qp.focusQuest(q.id);
      };
      this.questTracker.appendChild(row);
    }
    const img = this.questTracker.querySelector('.qt-title img');
    if (img) img.onerror = () => img.remove();
  }

  // ── NPC 对话：旧版独立 dialog 弹窗已删除，全部走 panel-talk（交谈面板）──
}


