// scene.js
// 对应 deobfuscated/manager/SceneManager.as（场景中枢）+ manager/PanelManager.as + scene/* + panel/*
// 三个场景：登录 / 主城(地图) / 战斗。轻量 SceneManager 切换分层显示。
//
// 战斗舞台严格对齐 deobfuscated/scene/BattleScene.as：
//   - 800×600 舞台，battle_background 背景（中文资源未提取，用 CSS 竞技场兜底，真实图命中自动覆盖）
//   - 分层：characterLayer(角色) / nameLayer+hpbarLayer(名字+血条，由 Fighter 自带) /
//           numberLayer(伤害飘字) / skillNameLayer(技能名) / panelLayer(底部指令条 BattlePanel)
//   - 站位用 CharacterManager.getFightPoint(value) 的 800×600 坐标（玩家右、敌人左，俯视斜排）
//   - 指令条对齐 BattlePanel.as：自动/技能/道具/防御/召唤/捕捉/爆气/逃跑/召回
//   - ★ 「捕捉」指令（BATTLE_CATCH=256）按 AS3 真实协议复刻，规格全部有出处：
//       · RequestCommand.as::sendBattleCatch(value) → writeShort(CS_BATTLE_CATCH=38) + writeShort(reversePosition(value))
//         value = 被点选敌人的 pid（BattleScene.as:356-357 `case BATTLE_CATCH: sendBattleCatch(_loc2_.pid)`）
//       · HandlerConnection05.as::receiveCatchResult(bytes)（SC_CATCH_RESULT=54）读取顺序：
//         attackerPos(short) → defenderPos(short) → result(int) → changeMp(int) → skillImageId(string)，并置 effectTime=3000
//       · BattleInitializer19.step() 编排真源（毫秒）：25 前冲 → 550 施法帧 + 在 defender 身上叠
//         GlobalsLoader.getCharacter("catch") 特效 + 攻击者回蓝飘字(500ms) → 1400 攻击者退回 → 1500 起按 result 分叉
//         → 2200/2250 失败侧归位 → 2800 攻击者 STAND → 2900 result==1 时 defender.destroy()
//       · result 语义：1=成功 / 0=失败（客户端仅据此分叉；失败侧给一次"被拉近再退回"的挣扎演出）
//       · 选目标态提示文案 = GlobalsGlobal04.CATCH_SELECT ← GlobalsGlobal06.GM_CATCH_SELECT(30051)
//         = zh_CN.as lang["30051"]「请选择你要进行捕捉的目标<br>右键取消操作」⇒ 必须支持右键取消
//     ★ 注意：原版客户端在捕捉成功后**只销毁 defender，不自己造宠物对象**（宠物由服务器另行下发）。
//       单机版要"真发一只宠物"必须先定「被捕捉物种的原型从哪来」——见 _grantCaughtPet 的说明。
//   - 顶部 跳过战斗 / 逃跑 按钮 + 回合计数（对应 showSkipBattleBtn / showEscapeBattleBtn / showCountImg）

import { Config, url, absUrl, ACTION, occlusionOpacityAt } from '../core/globals.js?v=20261007c';
import { requestCommand, CMD } from '../core/net.js?v=20261007c';
import { ChatBubbleManager } from '../ui/chat-bubble.js?v=20261007c';   // 头顶聊天气泡（照搬 AS3 face/PromptFace.as）
import { NpcQuestMarks } from '../entities/npc-quest-mark.js?v=20261007c';   // NPC 头顶任务提示标记（yem/yqm，对齐 AS3 CurrentPanelNpc.stateSprite）
import { playChar, playEffect, playSkill, playStatus, clearContainer, skillResourceExists, loadEffect, mount, destroyCanvas, anchorOrigin, skillFitScaleAsync, skillVisibleSize } from '../core/loader.js?v=20261007c';
import { customCursor } from '../ui/custom-cursor.js?v=20261007c';
import { MapSystem, AStar } from '../core/map.js?v=20261007c';
import { MapFX } from '../core/mapfx.js?v=20261007c';
import { variantMatrix, resolveVariantMatrix } from '../core/color-matrix.js?v=20261007c';   // 变异野猫群：按索引均分色相环生成不同颜色矩阵
import { Fighter } from '../entities/fighter.js?v=20261007c';
import { talkSys } from '../quest/talk.js?v=20261007c';   // 任务杀怪条件框架（挑战/conditionItem 推进度）
import { isVisibleNow, isGated } from '../quest/quest-actions.js?v=20261007c';   // 任务状态 → NPC/传送门显隐门控
// 完整存档：boot 时从存档点恢复 ext（等级/金币/技能/任务/客户端状态）与世界（地图/坐标）
import { restoreExtOnBoot, applyWorldOnBoot } from '../save/game-save.js?v=20261007c';

// ── 像素命中测试：专用离屏画布（★ 灵昌城卡顿治理，13q 引入 / 13r 修正）────────────────
// 角色主画布的 2D 上下文由 fanvas 在 mount 时创建，且【未】带 willReadFrequently。
// 在它上面调用 getImageData 会把该画布永久钉入 Chrome「慢速回读」模式，之后每帧
// drawImage 这张画布都走慢路径 ≈ 每帧多耗 ~100ms（灵昌城 NPC 同屏即感知为"卡死/右键无菜单"）。
// 13o 给 _revealText 加 willReadFrequently 无效（已存在的上下文忽略该标志）、13p 移除了 _revealText 的回读。
// ★ 13q 的做法：不在角色主画布上读像素，改把主画布 drawImage 到一张独立 willReadFrequently 离屏画布再读数。
// ⚠⚠ 13r 实测修正（13q 的原始注释有误，勿再据此推断）：
//   原文写"drawImage(主画布→离屏) 是普通 GPU 操作、不钉源画布"——**不成立**。
//   真机 trace 实证：把 **GPU 加速画布** drawImage 进 willReadFrequently（软件）画布，**仍会触发
//   GPU→CPU 回读**（`GLES2::ReadPixels` 39 次、单次最高 32.2ms，并伴随 WaitForCmd 同步阻塞主线程）；
//   13q 只是把回读粒度从"整画布"降到"1 像素"，**回读本身并未消除**。
//   ⇒ 所以本函数真正要优化的量是【回读面积】：只拷贝光标附近 HIT_PAD*2+1 见方的小块。
//     实测整画布回读 248×244 时单次 avg 5.36ms / max 31.6ms；缩到 33×33 后拷贝面积降约 60×。
let __hitMaskCanvas = null;
const HIT_PAD = 16;                          // 回读块半径（像素）→ 33×33
function _readFighterAlpha(cv, px, py) {
  if (!__hitMaskCanvas) __hitMaskCanvas = document.createElement('canvas');
  // 只取光标附近小块，避免整画布 GPU→CPU 拷贝
  const sx = Math.max(0, Math.min(cv.width - 1, px - HIT_PAD));
  const sy = Math.max(0, Math.min(cv.height - 1, py - HIT_PAD));
  const sw = Math.min(cv.width - sx, HIT_PAD * 2 + 1);
  const sh = Math.min(cv.height - sy, HIT_PAD * 2 + 1);
  if (__hitMaskCanvas.width !== sw || __hitMaskCanvas.height !== sh) {
    __hitMaskCanvas.width = sw;
    __hitMaskCanvas.height = sh;
  }
  const mctx = __hitMaskCanvas.getContext('2d', { willReadFrequently: true });
  mctx.clearRect(0, 0, sw, sh);
  try { mctx.drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh); } catch (e) { return 0; }
  try { return mctx.getImageData(px - sx, py - sy, 1, 1).data[3]; } catch (e) { return 0; }
}

// ★ 13r：摘除临时 cell 前，先停掉其中所有画布的 fanvas Timer 再摘 DOM。
// 背景：`playStatus(loop:false)` 走的是"不自动销毁"通道（loader 明确要求调用方自行销毁），
//   而 fanvas 不尊重 loop:false ⇒ 只 cell.remove() 会让该 Timer 永久空转成孤儿
//   （实测：灵昌城静置时约 41% 的在动画布已脱离 DOM）。
function _disposeCell(cell) {
  if (!cell) return;
  try { cell.querySelectorAll('canvas').forEach((c) => { try { destroyCanvas(c); } catch (e) {} }); } catch (e) {}
  if (cell.parentNode) cell.parentNode.removeChild(cell);
}
import { RolePool } from '../core/role-pool.js?v=20261007c';   // 角色对象池（移植 RolePoolManager）：地图 NPC 借还复用 DOM，避免高频 new/destroy
import { applyPlayerAttrs, genUnit, lookupChar } from '../char/char-gen.js?v=20261007c';   // 玩家属性公式驱动 + 捕捉转资质型
import { calcDamage, rollDrops, rollDropsByDropId, evalFormula, getCombat } from '../core/rt.js?v=20261007c';
import { castSkill, applyIncoming, redirectTarget, hasTaunt, statusAtTurnStart, emitEvent, EVENTS, applyPassiveBuffs, reapplyPassiveBuffs } from '../skill/skill-engine.js?v=20261007c';
import { resolveCastPlays } from '../skill/cast-visual-config.js?v=20261007c';   // 技能演出落点统一解析（与主游戏/测试页共用）
import { buildNumberSprite, preloadBattleNumbers, FLOAT_RISE, FLOAT_DUR, NUM_TYPE } from '../core/battle-number.js?v=20261007c';   // 战斗飘字数字图片（对齐 AS3 BattleInitializer14 / UtilUpdater02）

// 战斗表现动画（对齐 AS3 GlobalsLoader.getCharacter(name)，资源在 resource/battle/{name}/）
// 时长取各 Initializer 的复位时机：闪避/招架 800ms(BattleInitializer03)、受击/防御 500ms(BattleInitializer15)、
// 数值飘字 550ms(BattleInitializer14)。
// ★ catch = 3000：真源不是 BattleInitializer19 自身，而是 HandlerConnection05.receiveCatchResult 里写死的
//   `_loc7_.effectTime = 3000`（演出末尾 2900ms 才销毁 defender，故 3000 与之自洽）。
const BATTLE_FX = {
  jook_phy: 800, jook_mag: 800,
  miss_phy: 800, miss_mag: 800,
  baoji: 550,
  defend_lr: 500, defend_rl: 500,
  attack: 500,
  catch: 3000,
  flower: 700,
  uplevel: 1200,   // 升级在 resource/effect/uplevel（走 playEffect 通道）
};
// 一次性表现特效（播一遍即定格末帧，见 _floatAnim）：防御盾牌主动画 f6 用 rE 移除盾牌元素、f6-f9 为真空帧，
//   用户确认防御特效「播放一次即可」，故按一次性处理：loop:false + freezeLast，在 BATTLE_FX 的 500ms 销毁计时后统一回收。
const ONE_SHOT_FX = new Set(['defend_lr', 'defend_rl']);

// ★ 受击联动类集合：这些 buff/状态在【受击这一次事件】里会产生防御之外的额外演出（中毒跳血/回春回血/
//   护盾吸收·破盾反射/减伤分担/伤害池/吸血/受击回血/物理削减/反伤/反击/昏睡苏醒等）。存在其一即视为"有其他触发"，
//   此时不再叠加防御专属姿势 defend_lr/rl（让触发自身演出独占，避免冲突），仅保留基础受击演出。
//   未列出的纯属性类（stun/weak/slow/breakarmor/insight/…）只改属性、不算触发。
const UNDERFIRE_EXTRA_KINDS = new Set([
  'haotian', 'link', 'chuanxin', 'fugu', 'xianqi', 'bahuang', 'thorns', 'counter', 'sleep',
]);
import { buildFormation, clampFormationCount, nextFreeSlot, darkEncounterCount } from '../battle/formation.js?v=20261007c';   // 站位管理器：友方 0-9 / 敌方 10-19 的出场战斗点分配（中心扩展）
import { insertImmediate as aqInsert, resortQueue as aqResort, appendTurn as aqAppend } from '../battle/action-queue.js?v=20261007c';   // 行动队列改写原语（TCA 阶段1）
import { UI } from '../ui/ui.js?v=20261007c';
import { getLinkName, panelManager } from '../ui/panel-manager.js?v=20261007c';   // AS getLinkName：资源名大写转小写、去下划线
import { playSfx } from '../core/sound.js?v=20261007c';
// 宠物系统三层数据流（战斗侧唯一取数口径）：
//   静态原型 Config.pets(config/pets.json) --实例化--> petState().list(13 契约键) --合并--> petView()
//   ★ 战斗侧拿到的永远是**实例**，静态资质/外观必须经 petView() 现查原型，绝不直读实例字段。
import { pet as petView } from '../pet/pet.js?v=20261007c';
import { petState } from '../pet/pet-state.js?v=20261007c';
// 物品/背包系统（战斗侧取数口径）：
//   ★ 战斗 bag（{itemId,count}）只是视图；权威数据是 bootInventory 绑定的 InventoryManager（{id,count}）。
//   战斗内「用道具」「战斗奖励」都必须走权威管理器 + commit，否则刷新/战后会把背包抹回登录快照（丢档）。
import { effectForItem, hasItemEffect, applyItemEffect } from '../item/item-effects.js?v=20261007c';
import { classifyItem, categoriesReady } from '../item/item-category.js?v=20261007c';
import { showItemTip, hideItemTip, itemIconSrcs, iconImg, wireIconFallback } from '../ui/panels.js?v=20261007c';
import { booted as inventoryBooted, commit as inventoryCommit } from '../item/player-bridge.js?v=20261007c';

// 右侧独立栏宽度（与 css/style.css 的 --sidebar-w 保持一致；游戏主窗口左缩、聊天列/指令条入住侧栏，互不遮挡）
// ★ ca：右侧消息栏宽度 = 视口 15%（与 css --sidebar-w:15vw 同步）。镜头/视口计算必须用动态值，
//   否则窗口缩放时游戏主区与消息栏宽度不一致（角色被遮挡或留黑边）。
const SIDEBAR_W = () => Math.round((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.15);

// ★ 相机「检测框」（deadzone）用【相对视口比例】而非绝对像素（用户：现在是绝对大小，
//   手机小屏上无法正常移动摄像机）。比例直接取 AS3 死区占其固定视口的比例：
//   AS3 视口 800×600，X 死区 [250,550]（宽 300）→ 300/800 = 0.375；
//   Y 死区 [200,400]（高 200）→ 200/600 = 0.333（Player.isMapMoveX/isMapMoveY）。
//   ★ 绝对像素在 vw < 400 的窄屏（如 390×844 手机）会让框比视口还宽 → 玩家永远在框内 → 相机永不移动。
//   ⚠ 旧值 0.245/0.278 是误把 AS3 的「中心偏移 400」当框半宽换算（AS3 框半宽是 150，不是 400），
//     导致死区偏窄、相机跟随过早；2026-10-05 对齐 AS3 摄像机时按真实比例修正。
const CAM_BOX_W = 0.375;
const CAM_BOX_H = 0.333;

// ── 到点归中缓动（对齐 AS3 GameMap.moveToCenter：dx += (toDx-dx)*0.035，每 enterFrame 一次）──
// ⚠ 原版 SWF 帧率 = 24fps（读 `数据解析/.../swf/loading|main-game/*.swf` 头部实测，
//   3 个 SWF 一致），而本端口主循环是 requestAnimationFrame ≈ 60fps ⇒ 直接照搬「每帧 ×0.035」
//   会让墙钟速度快 2.5 倍（用户实测「像弹射一样」）。故按帧率无关化：
//   每秒残留比 = (1-0.035)^24 ≈ 0.4188，实际每帧系数 k = 1 - 0.4188^dt。
//   （60fps 下 k ≈ 0.0144，与「24fps 每帧 0.035」的墙钟速度完全一致；24fps 下 k ≈ 0.0356 ✓）
const CENTER_EASE_PER_FRAME = 0.035;   // AS3 原值：每帧系数
const CENTER_EASE_FPS = 24;            // AS3 原版帧率（SWF 头实测）
// 用户体感调速（2026-10-05）：AS3 原速在大屏幕上仍偏快，整体时间轴放慢。
//   语义 = 把 AS3 的 24fps 回放速度乘以 SCALE（0.5 = 慢放一倍）：
//   每秒残留比 (1-0.035)^(24×SCALE)，尾部线性段速度 24×SCALE px/s。
const CENTER_EASE_SPEED_SCALE = 0.5;
const CENTER_EASE_DECAY_PER_SEC = Math.pow(1 - CENTER_EASE_PER_FRAME, CENTER_EASE_FPS * CENTER_EASE_SPEED_SCALE);   // ≈0.652（SCALE=0.5）

// ── F6 懒加载 IO 调度参数（对齐 AS3 架构哲学：按需加载 + 队列背压 + 长期去重缓存） ──
const IO_LOAD_M = 240;          // 加载带余量（世界像素）：单位进入「视口+IO_LOAD_M」才排入加载
const IO_MAX_PER_TICK = 4;      // 稳态每 tick（≈8Hz）最多加载单位数（背压，避免甩镜几十个并发 fetch）
const IO_BURST_MAX = 24;        // burst（进图/传送落点/镜头瞬移）放宽上限（可见集合本就有界）

// ── 长按人物跟随（对齐 AS3 GameWorld._leftClickTime = 1000）──────────────────────
//   按住（鼠标/手指）超过该时长 → 切换进入「跟随态」：人物持续走向当前指针位置；
//   松手保持跟随，再次按下左键/右键 → 切换退出，恢复「点击终点模式」。
const LONG_PRESS_MS = 1000;     // 长按阈值（毫秒），同 AS3 _leftClickTime
const FOLLOW_RETARGET_MS = 150; // 跟随态重算寻路的最小间隔（保底节流，主判据是目标格变化）

// 暗雷遇敌按【行走距离】判定（用户 2026-09-30 23:05）：每走 ENC_STEP_PX 像素掷一次 rate，
//   站着不动不累加 ⇒ 永不遇敌。速度 200px/s 时每秒走 200px ⇒ 每秒 2 次掷骰，
//   rate=0.05 时期望约 10 秒遇一局（对齐旧的"每 0.5s 掷一次"节奏）。
const ENC_STEP_PX = 100;
// 单帧位移上限：超过则视为传送/战斗归位/切图等坐标跳变，不计入遇敌距离（正常单帧 ≤ speed*dt ≤ 20px）
const ENC_JUMP_PX = 150;

// 暗雷怪物表（darkGroup）加权抽取：返回 mob id 或 null。
//   ★ 每次调用都是一次独立掷骰 —— 生成规则就是「这张表」本身：
//     darkPick=perUnit（默认）时每个敌人单独调一次 ⇒ 同场出现混合怪群；
//     darkPick=once 时只在 _rollEncounter 抽一次（monsterNpc.monsterId），整场同一只。
//   权重非法按 1 计；mob 在 Config.data.monsters 里不存在的条目跳过（防 _spawnEnemy 抛错）。
function _pickDarkMob(table) {
  const group = Array.isArray(table) ? table : [];
  const monsters = Config.data.monsters || {};
  const valid = group.filter(g => g && g.mob && monsters[g.mob]);
  if (!valid.length) return null;
  const total = valid.reduce((s, g) => s + (Math.max(0, Number(g.weight)) || 1), 0);
  let r = Math.random() * total;
  for (const g of valid) { r -= (Math.max(0, Number(g.weight)) || 1); if (r <= 0) return g.mob; }
  return valid[valid.length - 1].mob;
}

// 数值归一（宠物实例/原型取值专用）：非法值一律 0，绝不把 undefined 带进 Fighter 数值面板
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 战斗指令常量（对齐 AS GlobalsGlobal08.BATTLE_*）
const B = {
  ATTACK: 'attack', CAST: 'cast', ITEM: 'item', DEFEND: 'defend',
  SUMMON: 'summon', CATCH: 'catch', BAOQI: 'baoqi', FLEE: 'flee', AUTO: 'auto', RECALL: 'recall'
};

// 简单事件总线
const bus = { _m: {}, on(e, f) { (this._m[e] || (this._m[e] = [])).push(f); }, emit(e, d) { (this._m[e] || []).forEach(f => f(d)); } };

// ★★ 翻转命中镜像的轴 = 【画布元素自身的盒中心】，不是 transform-origin。
//   铁律（勿回退）：把 canvas 当 DOM 元素看，_bodyWrap 的 scaleX(-1) 只是把该元素【左右边互换】显示，
//   元素自己的 getBoundingClientRect() 已如实反映这一点 ⇒ 由 (clientX-rect.left)/rect.width*W 得到的 px
//   本身就是"镜像坐标系"里的读数，恢复真实画布像素只需再翻转一次：px = W - px（±1 取整）。
//   该式与翻转轴【无关】（因为 rect 已经跟着轴变了），故【不需要、也不应该】引入 fighter 的锚点轴。
//   ── 反例（2026-09-12c 曾据"与画面同轴"改成 2*axis-px-1，实测为回归，已撤销）──
//   210071 LB：W=154、锚点轴 _flipAxisCvPx=39（= −tx），画布盒实测 [el.x−115, el.x+39]（未翻转时是 [el.x−39, el.x+115]）
//   ⇒ 显示确实以红十字为轴镜像；但 rect.left 同步变成了 el.x−115，于是 W−px 依旧正确，而 2*39−px−1 = 77−px 会整体偏 77px。
//   验证脚本用"可见像素投影"对比两式时曾因角色 alpha 剪影近似左右对称而误判（raw 与 W−px 命中数都 ≈100%），
//   故判定必须用 rect 几何（见 _verify/probe_flip_bars_20260912c.mjs 的 C1：rect.left ≈ 红十字 − (tx+W)）。
//   命中判定与画面同轴这件事【由 rect 自动保证】，刻意"共用一个轴变量"反而会脱轴。

// Q3：寿命池——战斗结束后自动用池补寿命（补到满，池不够就补到池空）
//   宠物寿命储存水晶（+10000 寿命池）把寿命存进 pet.lifePool，战斗结束回写寿命后调用本函数。
function _refillLifeFromPool(pet) {
  const pool = Math.max(0, Math.trunc(Number(pet && pet.lifePool) || 0));
  if (pool <= 0) return;
  const life = Math.max(0, Math.trunc(Number(pet && pet.life) || 0));
  const cap = Math.max(1, Math.trunc(Number(pet && pet.lifeMax) || 1));
  if (life >= cap) return;
  const draw = Math.min(cap - life, pool);
  pet.life = life + draw;
  pet.lifePool = pool - draw;
}

class SceneManager {
  constructor() {
    this.layers = {
      loading: document.getElementById('loading-layer'),
      world:   document.getElementById('world'),
      ui:      document.getElementById('ui-layer')
    };
    this.ui = new UI(this.layers.ui);
    this.ui.sm = this;        // 让 UI / 面板 / 调试面板能反过来驱动场景（如触发战斗）
    // 把 SceneManager 注入 panelManager 运行期上下文（供 NPC 距离巡检 playerXY() 取玩家坐标）
    panelManager.bindContext({ sm: this, ui: this.ui });
    this.current = null;
    this._main = null;       // 当前主城实例（战斗期间冻结保留，战后恢复，避免重建地图）
    this.player = null;
    this.questState = [];
    this.defeated = new Set();
  }

  async login() {
    this._show('loading');
    const sc = new LoginScene(this);
    this.current = sc; sc.enter();
  }

  enterMain() {
    this._show('world');
    this._killLingeringBattleLayer();          // 回到主城：杜绝残留战斗层吞点击
    // 复用已存在的主城实例（战斗恢复时不应重建地图）；仅首次（登录后）创建
    let sc = this._main;
    if (!sc || sc._destroyed) { sc = new MainScene(this); this._main = sc; sc.enter(); }
    this.current = sc;
  }

  enterBattle(monsterNpc, dungeonDef) {
    if (this.current instanceof BattleScene) return;   // 已在战斗中，避免重复进入
    // 进战斗前清掉地图遮挡半透明（mask===2 时主角变 0.4），避免把透明状态带入战斗立绘
    // ★ 遮挡半透明现已统一施加在 _bodyWrap（身体+全部叠加层整体），故此处清 _bodyWrap；兼容旧 canvasWrap 一并复位
    if (this.player) {
      if (this.player._bodyWrap) this.player._bodyWrap.style.opacity = '1';
      if (this.player.canvasWrap) this.player.canvasWrap.style.opacity = '1';
      // ★ 记录战前未走完的寻路（点地移动命令）与爆发点：战后 _resume 据此续走，
      //   避免上一版"移动命令全取消"误伤玩家原本要去的目标。
      //   地图走路靠 player.path + 主城 _loop，与战斗内 moveTo 位移闸门无关，故此处仅保存、不清除。
      this._preBattlePath = (this.player.path && this.player.path.length) ? this.player.path.slice() : null;
      this._preBattlePos = { x: this.player.x, y: this.player.y };
    }
    this._show('world');
    this._main = this.current;          // 冻结当前主城实例（地图/玩家/NPC 全部保留），战后恢复
    // 进战即清键：出战时按住的移动键/方向键不应让角色在战斗结束回城后继续漂移（见 _clearKeys）
    if (this._main && typeof this._main._clearKeys === 'function') this._main._clearKeys();
    // ★ 进战即退出长按跟随 + 自绘光标复位 default：mousemove 的跟随分支挂 window 不随场景解绑，
    //   战斗中仍会 _moveFollowMarker 把自绘光标设成 nopass（穿透到战斗层）；且手势若一直按着，
    //   战后回城会跟着"幽灵指针"继续走（对齐 blur 兜底语义）。
    if (this._main && typeof this._main._exitFollow === 'function') this._main._exitFollow();
    try { if (customCursor.on) customCursor.setState('default'); } catch (e) {}
    const sc = new BattleScene(this, monsterNpc, dungeonDef);
    this.current = sc;
    // ★ 进战即隐藏终点光圈：光圈挂 body 最高 fixed 层，战斗层盖不住（会穿透到战斗场景）。
    //   ★ 必须在 this.current = sc 之后调：_positionDestMarker 的场景守卫靠 sm.current 判定，
    //     切换前调守卫不成立、光圈不会被隐藏。loading 在途的异步 resolve 也走同一守卫。
    if (this._main && typeof this._main._positionDestMarker === 'function') this._main._positionDestMarker();
    // ★★ 防"硬锁死"兜底（2026-09-12）：enter() 是 async 且此处【未 await】，
    //   一旦它内部抛出（典型：_spawnEnemy 拿不到怪物数据 → 读 undefined.name），异常只会变成
    //   unhandled rejection，而 sm.current 已经停在 BattleScene ⇒ 三重后果同时发生：
    //     ① MainScene._loop 首行 `sm.current !== this` 成立 → 主城渲染循环退出，角色不再更新；
    //     ② _bindInput 的 mousedown/mouseup 守卫 `current 是 BattleScene → return` → 所有点击被吞；
    //     ③ 战斗 UI 根本没建起来 → 玩家看不见任何按钮，无从自救。
    //   表现即 user 反馈的"移动一会就卡住，不能移动也无法点击任何东西"，且完全无法恢复。
    //   故在此统一兜底：enter 失败就回滚主城、重启循环并提示，保证游戏永远处于可操作状态。
    Promise.resolve(sc.enter()).catch((err) => {
      console.error('[battle] 进入战斗失败，已回滚大地图：', err);
      // 复位战斗 HUD（技能栏遮罩/显隐由 _setBattleHud 管理，战斗 DOM 销毁不会自动复位）
      try { sc._setBattleHud('end'); } catch (e3) {}
      try {
        // 撤销 enter() 抛错前已经造成的副作用，否则即便把场景切回主城也是"残废"状态：
        //   ① 主城 actor 层被 display:none（NPC 与玩家全不可见）② 玩家立绘被搬进战斗 characterLayer
        //   ③ battleScale/血条/头顶血条停留在战斗态。
        if (sc._mainActorLayer) sc._mainActorLayer.style.display = '';
        if (sc._mainHint) sc._mainHint.style.display = '';
        const p = this.player;
        if (p) {
          p.battleScale = null;                       // 回主城缩放(1)，否则立绘停在 0.72
          p.showBars = false;
          if (p.hpBar) p.hpBar.style.display = 'none';
          p.hpAbove = false;                          // 血条回落到脚底（主城玩家血条本就隐藏）
          if (typeof p.setRideVisible === 'function') p.setRideVisible(true);   // 回滚也需恢复骑宠层
          if (p._bodyWrap) p._bodyWrap.style.opacity = '1';
          if (typeof p.allowMove === 'function') p.allowMove();
        }
        const bl = this.layers.world.querySelector('#battle-layer');
        if (bl && bl.parentNode) bl.parentNode.removeChild(bl);
        const main = this._main;
        if (main) {
          if (main.actorLayer && p && p.el) main.actorLayer.appendChild(p.el);
          if (p && this._preBattlePos) p.setPos(this._preBattlePos.x, this._preBattlePos.y);
          this.current = main;
          if (typeof main._resume === 'function') main._resume();
        } else {
          this.enterMain();
        }
        if (this.ui && typeof this.ui.toast === 'function') this.ui.toast('进入战斗失败，已返回大地图');
      } catch (e2) { console.error('[battle] 回滚失败：', e2); }
    });
  }

  // 从副本规则编辑器(dungeons 域)发起副本：首波作为首发敌人，余下波次在其倒下后陆续进场
  startDungeon(dungeonDef) {
    if (!dungeonDef || !dungeonDef.waves || !dungeonDef.waves.length) { if (this.ui) this.ui.toast('副本无有效波次'); return; }
    const w = dungeonDef.waves[0];
    const monsterNpc = { id: 'dungeon_' + dungeonDef.id, monsterId: w.mob, name: dungeonDef.name, type: 'monster' };
    this.enterBattle(monsterNpc, dungeonDef);
  }

  _show(which) {
    for (const k in this.layers) this.layers[k].style.display = (k === which || k === 'ui') ? '' : 'none';
  }

  // ★ 防御（2026-09-13，修复"点不了但能动、overlay=0"）：仅当当前不是战斗场景时，
  //   移除任何"可见"(未带 hidden)的 #battle-layer。透明全屏层(pointer-events:auto)若残留会盖在大地图
  //   之上吞掉所有点击、却放行键盘移动（主循环仍在跑）——典型来源是 _end 中途异常留下的残层。
  //   在每次回到主城 / 切图时主动清一遍，作为 _end finally 兜底的双重保险。
  _killLingeringBattleLayer() {
    if (this.current instanceof BattleScene) return;       // 真在战斗，层本来就该在
    const W = this.layers && this.layers.world;
    if (!W) return;
    const bl = W.querySelector('#battle-layer');
    if (bl && !bl.classList.contains('hidden')) {
      console.warn('[scene] 清除残留 #battle-layer（非战斗场景不应存在）');
      if (bl.parentNode) bl.parentNode.removeChild(bl);
    }
  }
}

// ───────────────────────── 登录场景 ─────────────────────────
class LoginScene {
  constructor(sm) { this.sm = sm; }
  enter() {
    const L = this.sm.layers.loading;
    L.innerHTML = `
      <div class="login-box">
        <h1>天书奇谈</h1>
        <p class="sub">单机版 · HTML5 重制（美术资源取自原始 SWF 反编译产物）</p>
        <div class="server-list"></div>
        <button class="start-btn">进入游戏</button>
        <p class="tip">键盘 WASD/方向键移动 · 鼠标点击地面寻路 · 靠近 NPC/怪物自动交互</p>
      </div>`;
    const list = L.querySelector('.server-list');
    // 防御：Config.servers 在 servers.json 缺失时回落为 {}（非数组），直接 forEach 会抛错并阻断登录。
    const servers = Array.isArray(Config.servers) ? Config.servers : [];
    servers.forEach(s => {
      const row = document.createElement('div');
      row.className = 'server-row' + (s.id === 3 ? ' on' : '');
      row.innerHTML = `<span>${s.name}</span><span class="st">${s.status}</span>`;
      row.onclick = () => { list.querySelectorAll('.server-row').forEach(r => r.classList.remove('on')); row.classList.add('on'); L._picked = s.id; };
      list.appendChild(row);
    });
    L._picked = 3;
    L.querySelector('.start-btn').onclick = async () => {
      const res = await requestCommand(CMD.LOGIN, { serverId: L._picked });
      if (!res.ok) { alert('登录失败'); return; }
      const p = res.player;
      // 把 Config.player（= player.json 全量字段）完整透传给 Fighter，避免"属性全是空的"。
      // 字段名与 js/entities/attrs.js DERIVED_KEYS 及玩家配置保持一致；缺省项由 Fighter.initState 兜底。
      const fig = new Fighter({
        id: (p.id != null ? p.id : p.charId), name: p.name, charId: p.charId, portrait: p.portrait,
        level: p.level,
        // 当前资源 / 上限
        hp: p.hp, mp: p.mp, maxHp: p.maxHp, maxMp: p.maxMp,
        rage: (p.rage != null ? p.rage : (p.sp || 0)), rageMax: p.rageMax,
        // 战斗属性（完整透传，勿漏 magDef/phyHit/magHit/magDodge/magCrit/recover）
        atk: p.atk, def: p.def, mag: p.mag, magDef: p.magDef,
        spd: p.spd,
        phyHit: p.phyHit, magHit: p.magHit,
        phyDodge: (p.phyDodge != null ? p.phyDodge : (p.dodge || 0)), magDodge: p.magDodge,
        phyCrit: p.phyCrit, magCrit: p.magCrit,
        crit: p.crit, toughness: p.toughness, recover: p.recover, xiuwei: p.xiuwei,
        // 主属性（派生源：供属性面板五格展示与 applyDerived 使用）
        stamina: p.stamina, intellect: p.intellect, strength: p.strength,
        agility: p.agility, faith: p.faith,
        potential: p.potential, leftPoint: (p.leftPoint != null ? p.leftPoint : p.potential),
        // 经济 / 进度 / 社交
        exp: p.exp, expNext: p.expNext, silver: p.silver, gold: p.gold,
        bindGold: p.bindGold, guild: p.guild,
        profession: p.profession, prestige: p.prestige, job: p.job,
        equip: p.equip,
        enhance: p.enhance || {},
        side: 'player', showBars: false, dir: 'right'
      });
      fig.bag = p.bag; fig.skills = p.skills;
      // ★ 逐技能习得等级：必须在 applyPlayerAttrs 【之前】赋值 —— 首次派生就会走 applyEquip 的被动加成层，
      //   缺少 skillLevels 会回退单位等级，被动加成被严重放大。
      fig.skillLevels = p.skillLevels || null;
      // ★ aw：玩家属性切公式（职业资质 × 成长率150%，3 点自由属性点已并入资质成长）。
      //   派生失败（职业表缺记录）时保留配置值，绝不阻塞登录。
      //   ★ bd：派生链 applyEquip 末尾会自动挂上被动技能加成（战斗内外一致，进战不再跳变）。
      try {
        if (applyPlayerAttrs(fig)) { fig.hp = fig.maxHp; fig.mp = fig.maxMp; }
        else console.warn('[player] 未找到职业资质记录，属性保留配置值：', fig.profession, fig.sex);
      } catch (e) { console.warn('[player] 公式属性派生失败：', e); }
      this.sm.player = fig;
      this.sm.ui.bindPlayer(fig);
      this.sm.questState = Object.values(Config.quests).map(q => ({
        id: q.id, name: q.name, desc: q.desc,
        target: (q.target && Number.isFinite(q.target.count)) ? q.target.count
                : (Number.isFinite(q.target) ? q.target : 0),
        progress: 0, accepted: false, done: false, reward: q.reward
      }));
      this.sm.ui.setQuestState(this.sm.questState);
      // ★ 完整存档 boot 恢复（两段式，顺序不可颠倒）：
      //   ① 进主城【前】恢复 ext —— 等级/经验/金币/技能/任务进度/仓库/队伍/设置直接落到运行期对象；
      //      若存档带世界坐标，顺带把 Config.currentMapId 设为存档地图，使主城直接建在正确地图上
      //      （MainScene 构造时读 Config.currentMapId，避免落地后再 changeMap 重建一次）。
      //   ② 进主城【后】落位 —— 那时才有场景实例可 setPos。
      //   全程 try/catch：存档异常绝不阻断登录（铁律：登录不可被杀）。
      let _sv = null;
      try { _sv = restoreExtOnBoot(); } catch (e) { console.warn('[save] boot 恢复 ext 失败（已忽略）', e); }
      this.sm.enterMain();
      if (_sv && _sv.world) {
        try { applyWorldOnBoot(_sv.world); } catch (e) { console.warn('[save] boot 落位失败（已忽略）', e); }
      }
    };
  }
}

// ───────────────────────── 主城场景 ─────────────────────────
  class MainScene {
  constructor(sm) {
    this.sm = sm;
    // 头顶聊天气泡管理器（照搬 AS3 face/PromptFace.as）：
    // 战斗期内 layer=.battle-chatLayer(场景级,z70)；地图内无该层 → 气泡挂 fig.el 随父自动跟随。
    this.chatBubbles = new ChatBubbleManager(null);
    window.__chatBubbles = this.chatBubbles;   // 调试：控制台可 window.__chatBubbles.speak(fig, '...')
    // NPC 头顶任务提示标记管理器（yem=可接任务黄叹号 / yqm=可交付任务黄问号，对齐 AS3 stateSprite）
    this.marks = new NpcQuestMarks(this);
    // 多地图：优先 Config.currentMapId（由 map_info.json 的 start_map_id 设定），否则首图
    this.map = (Config.maps || []).find(m => m.id === Config.currentMapId) || Config.maps[0];
    this.tileW = this.map.tileW; this.tileH = this.map.tileH;
    this.cols = this.map.cols; this.rows = this.map.rows;
    // 镜头可显示区域 = 格子拼合尺寸（数据解析"发现"：GX*RP_W × GY*(RP_H/2)），
    // 比贴图矩形(cols*tileW=2800×2100)更贴内容、避免滚到贴图外空白边；无 map_info 时回退贴图世界
    this.worldW = this.map.stitchedW || (this.cols * this.tileW);
    this.worldH = this.map.stitchedH || (this.rows * this.tileH);
    this.camera = { x: 0, y: 0 };
    this.tileMap = {};
    this.actors = [];
    this.npcs = [];
    this.portals = [];     // 传送门触发点（纯数据，无 DOM 标记；走近自动触发）
    this.spawners = [];    // 明雷刷怪区
    this._portalCooldown = 0;
    // F6 懒加载 IO：地图 NPC/明雷不进图全量加载，登记为待加载，由 _ioCull 按视口按需 spawn；
    //   已加载单位不因离屏卸载（只由 _animCull 暂停动画），切图时随 _teardownActors 一次性清空
    //   （= AS3 LoaderManager：资源缓存长期、去重、无淘汰，地图切换时 dispose）。
    this._npcPending = [];   // 待加载单位 {n: npcDef, spawner?: spawner}
    this._ioCullT = 0;       // 上次 _ioCull 巡检时间（ms）
    // ── 长按跟随 = 状态切换机（严格对齐 AS3 GameWorld）──────────────────────────────
    // AS3 原版（三处铁证）：
    //   ① sceneMouseDownHandler：按下【翻转】_isMouseDown（true→false / false→true）
    //      并立即 setPlayerXY(localX,localY)——按下即走一次点击移动；
    //   ② onStageMouseUp：仅当距按下 < _leftClickTime(1000ms) 才把 _isMouseDown 复位
    //      （短按=普通点击移动；长按超过 1 秒则松手【保持】跟随态）；
    //   ③ enterFrameHandler：`_isMouseDown && isPlayerMove() && 时长>=1000` → 每帧
    //      movePlayerToXY2(stage.mouseX, stage.mouseY)（走向当前光标位置）；
    //   ④ rightClick：_isMouseDown = false（右键退出跟随，切回点击终点模式）。
    // 本端口等价状态机：
    //   _ptr.down/_ptr.t：物理按下态与按下时刻（用于 1 秒阈值判定，不再有摄像机拖拽）；
    //   _following：当前是否处于「跟随态」（长按 ≥1s 后进入，松手保持，左/右键按下退出）。
    // 摄像机不需要拖拽——_update 的 deadzone 跟随（出框硬同步）+ 到点归中会把玩家锁在视口里。
    this._ptr = { down: false, x: 0, y: 0, t: 0, id: null };
    this._following = false;        // 跟随状态机当前态（长按切换进入，左/右键切换退出）
    this._followCell = null;        // 上次跟随寻路的目标格（格变化才重算路径，节流）
    this._followTarget = null;      // 上次跟随寻路的世界坐标（终点光圈定位用）
    this._followRetargetT = 0;      // 上次重算路径时间（ms，保底节流）
    // ── 到点归中（对齐 AS3 Player.pathFinding→removePointer→GameMap.moveToCenter）──────────
    // AS3：路径走完时 removePointer() 置 isMoveToCenter=true，之后每帧 dx += (toDx-dx)*0.035
    //   缓动到「玩家居中」，到达即停。新寻路（addPointer）/ WASD 移动 / 镜头瞬移会取消它。
    //   ⚠ 缓动按【帧】×0.035 而非 dt——与 AS3 完全同速（AS3 本身就是 enterFrame 驱动、不含 dt）。
    this._moveToCenter = false;     // 是否正在归中缓动
    this._toCamX = 0;               // 归中目标 camera.x（已钳制）
    this._toCamY = 0;               // 归中目标 camera.y（已钳制）
    this._pathDone = true;          // 玩家路径是否已走完（边沿检测：仅「有路径→空」那一帧触发归中）
    this._centerPending = false;    // 本帧走到终点、待判定是否归中（判定延后到镜头更新之后）
    // ★ 对齐 AS3 GameMap.isMapMove()：寻路起点记录的镜头偏移。走到终点时若与当前相同，
    //   说明本次行走【没动过镜头】（玩家全程在死区内）⇒ 不归中（AS3 removePointer 的守卫）。
    this._pathStartCamX = 0;
    this._pathStartCamY = 0;
    this.keys = {};
    this.player = sm.player;
    this.target = null;
    this.moving = false;
    this.nearest = null;
    this.lastTime = performance.now();
    this._hovered = null;
    this._loopRunning = false;
    this._encAcc = 0;        // 暗雷/明雷累计行走距离（像素；按走路判定，不移动不遇敌）
    this._encPrevX = null;   // 上一帧玩家坐标（用于算本帧行走距离）；null = 尚未采样
    this._encPrevY = null;
    this._encCooldown = 0;   // 遇敌后冷却（秒），避免连刷
  }

  enter() {
    const W = this.sm.layers.world;
    W.innerHTML = `
      <div id="viewport">
        <div id="world-scroll">
          <div id="map-layer"></div>
          <div id="actor-layer"></div>
        </div>
        <div id="main-hint">点击地面移动 · 长按 1 秒进入跟随（松手保持，再点一次或按右键取消）· 靠近怪物自动开战</div>
      </div>`;
    this.viewport = W.querySelector('#viewport');
    this.scroll = W.querySelector('#world-scroll');
    this.mapLayer = W.querySelector('#map-layer');
    this.actorLayer = W.querySelector('#actor-layer');

    this._setupMap();
    this._bindInput();

    this._loop = this._loop.bind(this);
    this._scheduleLoop();
  }

  // 【战斗结束后主城循环停止时同步清空键盘状态】
  //   战斗期间本场景的 rAF 循环已退出（_loop 首行 `sm.current !== this` 即 return），
  //   故战斗内按下的 WASD/方向键只写到 this.keys、无人清空：
  //     · keyup 在战斗中仍会正常到达（keyup 不受焦点影响）→ 多数情况能清；
  //     · 但玩家"长按方向键移动 → 点怪物进战 → 战斗结束后才松手"时，keyup 落在
  //       BattleScene 期间/窗口失焦期间，本场景的 keyup 监听虽在 window 上仍会触发——
  //       真正会漏的是「浏览器窗口切走/系统弹窗抢焦点」导致 keyup 永远收不到。
  //   残留的 keys['w']=true 会让 _update 每帧走 no-keys 分支之外的"按键直移"分支，
  //   于是角色持续向上漂移且不播放行走动画（该分支不调 p.walk()），
  //   直到撞上寻路障碍层（_update 只做世界边界 clamp、不做格子碰撞）才停。
  //   修复：每次恢复主城循环前清空 keys，杜绝残留按键状态跨场景存活。
  _clearKeys() { this.keys = {}; }

  // 加载/重建当前 this.map 对应的世界：切片尺寸、寻路网格、玩家落点、本图 NPC、镜头、小地图
  _setupMap() {
    const m = this.map;
    this.tileW = m.tileW; this.tileH = m.tileH;
    this.cols = m.cols; this.rows = m.rows;
    // 镜头可显示区域 = 格子拼合尺寸（数据解析"发现"：GX*RP_W × GY*(RP_H/2)），无则回退贴图世界
    this.worldW = m.stitchedW || (this.cols * this.tileW);
    this.worldH = m.stitchedH || (this.rows * this.tileH);
    this.scroll.style.width = this.worldW + 'px';
    this.scroll.style.height = this.worldH + 'px';

    MapSystem.load(m);
    this.player.speed = this.player.speed || 200;
    this.player.setPos(m.spawn.x, m.spawn.y);
    this.player.path = [];
    this._clearDestMarker();   // 切图：旧寻路的终点光圈不带入新图
    this.moving = false;
    this.player.showBars = false;
    if (this.player.hpBar) this.player.hpBar.style.display = 'none';
    if (!this.actors.includes(this.player)) {
      this.actorLayer.appendChild(this.player.el);
      this.actors.push(this.player);
    }
    this.player.stand();

    // F6 懒加载：不立即生成 NPC，只登记为待加载，由 _ioCull 按视口范围按需 spawn
    //   （loader.loadChar = fetch(.swf)+fetch(.html)+evalSwf+parse 是重 IO；进图全量加载是卡顿主因之一）。
    //   已击败的明雷怪物直接丢弃，不占 pending 槽位（_spawnNpc 内的 defeated 守卫仍保留作防御）。
    //   ★ 任务显隐门控（quest-actions）：被任务动过且当前应隐藏的实体不登记，自然不生成。
    //     「离开」等未被任务动过的实体不进表，恒可见（默认安全，不会把玩家关在图里）。
    (Config.npcs || [])
      .filter(n => (!n.mapId || n.mapId === m.id)
        && !(n.type === 'monster' && this.sm.defeated.has(n.id))
        && !this._isQuestHidden(n))
      .forEach(n => this._npcPending.push({ n, spawner: null }));
    this._centerCameraOn(this.player.x, this.player.y);
    this._renderTiles();

    this.sm.ui.setMinimapMap(m.id);
    this.sm.ui._curMapId = m.id;   // 同步世界地图面板高亮

    // 氛围与地图特效（天气/暗度/特效粒子/音频）：数据源 map.environment + map.mapEffects
    MapFX.apply(this, m);
    // 传送门触发点 + 明雷刷怪区
    this._spawnPortals();
    this._spawnSpawners();

    // F6：镜头已落位、刷怪区已登记 → 立即按当前视口 burst 加载可见单位（不等 8Hz 首次巡检）
    this._ioCull(performance.now(), true);
    // ★ 任务显隐门控：进图后按当前任务状态校正被门控实体（隐藏的摘掉、该显示的补回）
    this._refreshQuestGates();

    this.sm.ui.log('欢迎来到 ' + m.name + '！', 'sys');
  }

  // 切换地图：释放当前 NPC、清空切片缓存、重建新图世界（多地图核心）
  // opts.spawnPortalId：到达后用该 spawn_point 作为落点（传送门 targetPortal）；否则用默认出生点
  changeMap(mapId, opts) {
    opts = opts || {};
    this.sm._killLingeringBattleLayer();     // 切图前：清掉任何残留战斗层，避免跨图吞点击
    const m = (Config.maps || []).find(x => x.id === mapId);
    if (!m) { this.sm.ui.toast('地图不存在：' + mapId); return; }
    if (this.map && this.map.id === mapId && !opts.spawnPortalId && !opts.spawnPos) return;   // 已在当前图（非指定落点）
    this._teardownActors();
    this.map = m;
    this._setupMap();
    // 暗雷按走路距离判定：切图落地坐标与旧图末位坐标无关，重置采样基点，
    //   避免跨图位移被计为"走路"而瞬间触发遇敌（_encAcc 保留，规则不同的图自行掷骰）
    this._encPrevX = null; this._encPrevY = null;
    // 传送落点：
    //   spawnPos —— 像素坐标直落（传送法阵：落在目标图上指回的传送圈位置，由 globals 预解析）
    //   spawnPortalId —— 目标地图的指定 spawn_point（找不到则退回默认出生点）
    if (opts.spawnPos) {
      this.player.setPos(opts.spawnPos.x, opts.spawnPos.y);
      this.player.path = [];
      this.player.stand();
      this._centerCameraOn(opts.spawnPos.x, opts.spawnPos.y);
      this._portalCooldown = 1.5;   // 防抖：避免落点紧邻传送门被立即弹回
    } else if (opts.spawnPortalId && m.spawnPoints) {
      const sp = m.spawnPoints.find(s => s.id === opts.spawnPortalId);
      if (sp) {
        this.player.setPos(sp.x, sp.y);
        this.player.path = [];
        this.player.dir = sp.dir;
        this.player.stand();
        this._centerCameraOn(sp.x, sp.y);
        this._portalCooldown = 1.5;   // 防抖：避免到达瞬间又被同点传送门弹回
      }
    }
    // 小地图面板：切图后旧实例仍按旧图底图/_worldW 在跑 rAF → 尺寸会错乱。
    // 按需求销毁旧实例并重建，从新图 scene.map 重新初始化（init+onOpen 重算尺寸与底图）。
    // ★ 销毁前记住屏幕位置（默认 .tsqt-panel 居中，拖拽后 left/top+transform:none），
    //   重开后还原到原位置，避免面板跳回视口正中央挡住游戏区。
    if (panelManager.isOpened('minimap')) {
      const old = panelManager._getInstance && panelManager._getInstance('minimap');
      const savedPos = old && old.dom ? {
        left: old.dom.style.left, top: old.dom.style.top, transform: old.dom.style.transform
      } : null;
      panelManager.destroy('minimap');
      panelManager.open('minimap');
      const nw = panelManager._getInstance && panelManager._getInstance('minimap');
      if (nw && nw.dom && savedPos && savedPos.left) {
        nw.dom.style.left = savedPos.left;
        nw.dom.style.top = savedPos.top;
        nw.dom.style.transform = savedPos.transform || 'none';
      }
    }
    this.sm.ui.toast('已进入 ' + m.name);
  }

  _teardownActors() {
    // 任务提示标记随单位一并停 Timer（池实例保留 DOM，但 fanvas Timer 必须停）
    if (this.marks) this.marks.clear();
    // 闲聊定时器随单位一并停（RolePool 会复用 Fighter 实例，_chatToken 防止旧定时器串到新 NPC 上）
    this._clearChatTimers();
    // 释放 NPC（保留玩家常驻实例）
    for (const a of this.actors) {
      if (a === this.player) continue;
      if (a._poolable && RolePool) RolePool.release(a);
      else if (typeof a.destroy === 'function') a.destroy();
    }
    this.actors = this.actors.filter(a => a === this.player);
    this.npcs = [];
    // F6：待加载队列一并清空（对齐 AS3 LoaderManager 地图切换时 dispose 资源缓存）
    this._npcPending = [];
    // 清理传送门数据与刷怪区（避免跨图残留）。传送门已是纯数据（无 DOM 标记），直接置空即可。
    this.portals = [];
    this.spawners.forEach(sp => { sp.instances.forEach(f => { if (f && f.el && f.el.parentNode) f.el.parentNode.removeChild(f.el); }); });
    this.spawners = [];
    // 清空地图切片缓存
    for (const k in this.tileMap) {
      const el = this.tileMap[k];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    this.tileMap = {};
    if (this.mapLayer) this.mapLayer.innerHTML = '';
  }

  _spawnNpc(n) {
    if (n.type === 'monster' && this.sm.defeated.has(n.id)) return;
    // ★ 任务显隐门控：被任务标记为隐藏的实体不生成（二次守卫，防御热更新配置漏登）
    if (this._isQuestHidden(n)) return;
    const opts = {
      id: n.id, name: n.name, charId: n.charId, portrait: n.portrait,
      side: n.type === 'monster' ? 'enemy' : 'npc',
      level: 1, hp: 100, mp: 50, showBars: n.type === 'monster',
      dir: (n.dir || 'RB'),   // 真实 4 向朝向（来自 op106 npcToward，经 CurrentPanelNpc.as:463 映射 RB/LB/RT/LT）
      isMonster: n.type === 'monster'
    };
    // 传送法阵：反编译客户端 CurrentPanelNpc.as:436-438 当 npcType==NPC_TRANSFER && bodyImg=="150" 时
    // 强制 bodyImg="transport" ⇒ 用地面旋转光圈特效 resource/effect/transport/ 作"身体"（resource/char/150 不存在）。
    // 仍走正常 Fighter 入 this.actors/this.npcs，故像素命中/最近提示/点击对话不写特例、全链路原样生效；
    // Fighter.act 检测到 _bodyEffectId 会把身体渲染成特效而非 char 模型。
    // 传送法阵：反编译客户端 CurrentPanelNpc.as:436-438 当 npcType==NPC_TRANSFER && bodyImg=="150" 时
    // 强制 bodyImg="transport" ⇒ 用地面旋转光圈特效 resource/effect/transport/ 作"身体"（resource/char/150 不存在）。
    // ★ 判定只看 charId==150（= AS3 的 bodyImg 口径）：地图数据里 charId=150 的节点
    //   有 type=npc（180 处，如「灵仙岛 城镇」）与 type=teleport（67 处）两类，
    //   type 由 gen_map_info 派生、不可靠（曾导致 180 个法阵没走特效，去加载不存在的
    //   resource/char/150 而 404 退化成兜底人模）。仍走正常 Fighter 入 this.actors/this.npcs，
    //   故像素命中/最近提示/点击对话不写特例、全链路原样生效；
    //   Fighter.act 检测到 _bodyEffectId 会把身体渲染成特效而非 char 模型。
    if (n.charId === 150) {
      opts.bodyEffectId = 'transport';
      // F9 用户裁决：渲染层不动（仍在 actor-layer，高于地图切片），但【置底且不走 Z 轴深度判定】
      // —— 地面光圈不应压在角色之上；fixedDepth 使 setDepth 恒不重排（含 setPos/移动）。
      opts.fixedDepth = true;
    }
    // 借：同 charId 有空闲实例则复用（保留 DOM），否则新建
    const f = RolePool.acquire(opts);
    f.setPos(n.x, n.y);
    f.npcData = n;
    f.stand();
    // 复用实例的 el 此前被 release 摘离，这里重新挂接回舞台
    this.actorLayer.appendChild(f.el);
    this.actors.push(f); this.npcs.push(f);
    // 闲聊气泡（地图文件 npc.chat 台词池）：配了台词池的 NPC 每隔 10~chatInterval 秒随机冒一句，
    //   递归 setTimeout 重排；换图/销毁时 _clearChatTimers 停止。
    //   ★ 不做"生成即随机冒泡"：旧实现（照搬 AS3 角色随机发言）让每个 NPC 载入时都弹一句
    //     randomLine，同图几十个 NPC 进场瞬间满屏气泡，属测试观感，用户 2026-10-01 要求删除。
    this._scheduleNpcChat(f);
    // 任务提示标记（yem/yqm）：spawn 后即计算并挂头顶；模型包围盒未量到时由管理器自行重试
    if (this.marks) this.marks.refreshOne(f);
    // NPC 静态：一次性按落点网格挂遮挡半透明（与主角每帧逻辑一致，复用同 helper）
    this._applyOcclusion(f);
    return f;
  }

  // ── ★ 任务显隐门控（配合 js/quest/quest-actions.js）────────────────────────────
  // 语义：实体只有「被任务动过」（isGated）才受控；没动过的恒可见。
  //   隐藏 = 从 actors/npcs 摘除并回收池（保留 DOM，下次同模型复用）；
  //   显示 = 若在视口内则立即重新 spawn（走 _spawnNpc 的池复用 + IO 带判定），
  //         视口外不立即生成，登记进 _npcPending 由 _ioCull 按需加载（对齐 F6 懒加载语义）。

  /** 该实体当前是否被任务隐藏：
   *    ① 地图配了 questHide（进图默认隐藏，如白胡子/五石柱）且尚未被 showNpc 动作激活；
   *    ② 或被任务显式 hideNpc 过。
   *    未被动过且无 questHide → false（默认可见，「离开」门走这条路，玩家不会被困） */
  _isQuestHidden(n) {
    if (!n) return false;
    try {
      const mid = this.map ? this.map.id : 0;
      if (isGated(mid, n.id)) return !isVisibleNow(mid, n.id);
      // 未进 gates 表：看地图初始标记 questHide
      return !!n.questHide;
    } catch (e) { return false; }
  }

  /** 应用单个实体的显隐变化（由 quest-actions 在状态变更瞬间调用）。
   *  mapId 不属于当前图 → 只记账（_gates 已在 quest-actions 侧更新），本方法无操作。 */
  _applyQuestGate(mapId, npcId) {
    if (!this.map || this.map.id !== Number(mapId)) return;
    const nid = Number(npcId);
    if (!Number.isFinite(nid)) return;
    const show = isVisibleNow(Number(mapId), nid);
    if (show) {
      // 显示：已在场则免操作；不在场 → 从 pending 找回定义并按视口判定 spawn
      const exists = this.npcs.some((f) => f && f.npcData && Number(f.npcData.id) === nid);
      if (exists) return;
      const def = (Config.npcs || []).find((n) => Number(n.id) === nid && (!n.mapId || n.mapId === this.map.id));
      if (!def) return;
      // 视口内立即生成；否则登记 pending 等 _ioCull（复用 F6 懒加载通道）
      const cam = this.camera || { x: 0, y: 0 };
      const vw = window.innerWidth - SIDEBAR_W(), vh = window.innerHeight;
      const M = IO_LOAD_M;
      const sx = def.x - cam.x, sy = def.y - cam.y;
      if (sx < -M || sx > vw + M || sy < -M || sy > vh + M) {
        if (!this._npcPending.some((p) => p.n === def)) this._npcPending.push({ n: def, spawner: null });
        return;
      }
      const f = this._spawnNpc(def);
      if (f && this.marks) this.marks.refreshOne(f);
    } else {
      // 隐藏：从 pending 摘定义 + 从场地摘实体
      this._npcPending = this._npcPending.filter((p) => !(p.n && Number(p.n.id) === nid));
      const idx = this.npcs.findIndex((f) => f && f.npcData && Number(f.npcData.id) === nid);
      if (idx < 0) return;
      const f = this.npcs[idx];
      this.npcs.splice(idx, 1);
      const ai = this.actors.indexOf(f);
      if (ai >= 0) this.actors.splice(ai, 1);
      // 停掉闲聊/标记 Timer 再回收（池保留 DOM）
      if (f._chatTimer) { clearTimeout(f._chatTimer); f._chatTimer = null; }
      if (this.marks) this.marks._unmount(f);
      if (f._poolable && RolePool) RolePool.release(f);
      else if (typeof f.destroy === 'function') f.destroy();
    }
  }

  /** 进图后全量重算本图被门控实体（切图/读档后状态可能已变）。在 _ioCull burst 之后调 */
  _refreshQuestGates() {
    if (!this.map) return;
    const mid = this.map.id;
    const ids = new Set();
    try {
      // 找出所有被任务动过的本图实体（扫 gates 表）
      const qa = (typeof window !== 'undefined') ? window.__TS_QUEST_ACTIONS : null;
      if (qa && qa.gates) for (const k of qa.gates.keys()) {
        const sep = k.indexOf(':');
        if (Number(k.slice(0, sep)) === mid) ids.add(Number(k.slice(sep + 1)));
      }
    } catch (e) {}
    for (const id of ids) this._applyQuestGate(mid, id);
  }

  // 闲聊气泡定时（用户 2026-09-30 需求）：npcData.chat 台词池非空的 NPC，随机间隔
  //   10 ~ chatInterval 秒（默认上限 180=3 分钟）随机取一句冒头顶气泡（与 AS3 角色随机发言
  //   同一条显示通路）。递归 setTimeout：到点重排下一次，每次都在 10~上限之间重新随机
  //   （用户 2026-10-01 裁决：不是固定等 300 秒，而是 10~180 秒随机一次）。
  //   ★ 守卫（_chatToken）：RolePool 复用 Fighter 实例，单位退场后实例可能被新 NPC 重新 acquire；
  //     每次排程递增 token，火时 token 不匹配即作废，避免旧定时器把台词冒到换图后的新 NPC 头上。
  _scheduleNpcChat(f) {
    if (!f || !f.npcData) return;
    const lines = Array.isArray(f.npcData.chat) ? f.npcData.chat.filter(s => typeof s === 'string' && s.trim()) : [];
    if (!lines.length) return;                       // 无台词池：不参与定时闲聊
    const top = Number(f.npcData.chatInterval) > 0 ? Number(f.npcData.chatInterval) : 180;
    const token = (f._chatToken = (f._chatToken || 0) + 1);
    // 随机区间 [10, top]：下限 10 秒保证进图后最快 ~10 秒就有可能冒泡；上限小于 10 时退化为固定间隔
    const lo = Math.min(10, top);
    const ms = (lo + Math.random() * (top - lo)) * 1000;
    f._chatTimer = setTimeout(() => {
      f._chatTimer = null;
      if (this.sm.current !== this || !this.npcs.includes(f) || f._chatToken !== token) return;
      if (!f.el || !f.el.parentNode) return;
      const cur = Array.isArray(f.npcData.chat) ? f.npcData.chat.filter(s => typeof s === 'string' && s.trim()) : [];
      if (cur.length && this.chatBubbles) this.chatBubbles.speak(f, cur[Math.floor(Math.random() * cur.length)]);
      this._scheduleNpcChat(f);                      // 重排下一次（重读 npcData，复用实例换台词也即时生效）
    }, ms);
  }

  _clearChatTimers() {
    for (const f of this.npcs) {
      if (f._chatTimer) { clearTimeout(f._chatTimer); f._chatTimer = null; }
      f._chatToken = 0;                               // 作废所有在途定时器（防止换图后串到复用实例上）
    }
  }

  /**
   * 半透明遮挡（对齐参考项目 Player.render：落在 mask===2 的遮挡格 → 半透明，
   * 便于在树后/建筑背面仍能看清角色）。mask 语义：0=阻挡,1=可走,2=半透明遮挡但仍可走。
   * 主角每帧调用；NPC 静态只在其 spawn 时调用一次。规则由 globals.occlusionOpacityAt
   * 统一提供（位置驱动，主角/NPC 一致）。
   */
  // 传送门：★ user 2026-09-11 指定「传送阵法模型上不要生成蓝色的圆，删干净点」
  //   → 不再创建任何 .map-portal DOM 标记（连同 mapfx.js 里的蓝色 CSS 一并删除）。
  //   只保留纯数据触发点：this.portals 存像素坐标，走近（_update 的 proximity）或由用户
  //   自行接入点击后调用 _usePortal(p) 切图，逻辑链路不变、仅去掉视觉。
  _spawnPortals() {
    this.portals = [];
    (this.map.portals || []).forEach(p => { this.portals.push({ ...p }); });
  }

  _usePortal(p) {
    if (this._portalCooldown > 0) return;
    const t = (Config.maps || []).find(x => x.id === p.targetMap);
    if (!t) { this.sm.ui.toast('目标地图不存在：' + p.targetMap); return; }
    this.sm.ui.toast('进入 ' + (t.name || ('#' + p.targetMap)));
    this.changeMap(p.targetMap, { spawnPortalId: p.targetPortal });
  }

  // 明雷刷怪区：区域内按上限刷怪，死亡/超时后周期重生
  _spawnSpawners() {
    this.spawners = [];
    (this.map.monsterSpawners || []).forEach(s => {
      const def = (Config.data.monsters || {})[s.monsterId];
      if (!def) { console.warn('[map] 刷怪区怪物不存在，跳过 spawner', s.spawnerId, s.monsterId); return; }
      const sp = { ...s, def, instances: [], cooldown: 0 };
      this.spawners.push(sp);
      this._spawnerRespawn(sp);
    });
  }

  _spawnerRespawn(sp) {
    // 清掉旧实例（避免击杀后残影）
    for (const f of sp.instances) {
      const ai = this.actors.indexOf(f);
      if (ai >= 0) this.actors.splice(ai, 1);
      const ni = this.npcs.indexOf(f);
      if (ni >= 0) this.npcs.splice(ni, 1);
      if (f._poolable && RolePool) RolePool.release(f);
      else if (typeof f.destroy === 'function') f.destroy();
    }
    // F6：丢弃该刷怪区上一轮尚未加载的残余定义（玩家从未来过该区域时会有），避免实例错挂在旧周期
    this._npcPending = this._npcPending.filter(p => p.spawner !== sp);
    sp.instances = [];
    // F6：怪物只登记为待加载，由 _ioCull 按视口按需 spawn（重生不再立即创建模型）
    for (let i = 0; i < sp.maxCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * sp.radius * 64;   // 半径(格) → 像素
      const px = sp.x + Math.cos(ang) * dist;
      const py = sp.y + Math.sin(ang) * dist;
      const mob = {
        id: 'spawner_' + sp.spawnerId + '_' + i + '_' + Math.floor(Math.random() * 1e6),
        name: sp.def.name || sp.monsterId,
        x: Math.round(px), y: Math.round(py),
        charId: sp.def.charId || 300165, portrait: '', type: 'monster',
        dialog: '', monsterId: sp.monsterId, count: 0, desc: '', dir: 'RB',
        mapId: this.map.id, scriptId: ''
      };
      this._npcPending.push({ n: mob, spawner: sp });
    }
  }

  _applyOcclusion(f) {
    if (!f) return;
    // 整体处理：半透明作用于 _bodyWrap（身体 canvasWrap + 全部纸娃娃/装备/翅膀/骑宠等叠加层），
    // 与 _applyFlip 整体翻转同口径——新增的模型层只要挂到 _bodyWrap 即自动一并半透明，无需逐个层处理。
    // 仅半透明"模型本体"，名字/血条/状态/buff 在 _bodyWrap 之外（与翻转一致），保持可读。
    const w = f._bodyWrap || f.canvasWrap;
    if (!w) return;
    w.style.opacity = occlusionOpacityAt(f.x, f.y);
  }

  _bindInput() {
    const vp = this.viewport;

    // ── 战斗层冒泡守卫（mousedown/touchstart 共用）────────────────────────────
    //   #battle-layer 是 #viewport 的子节点，其上的点击会冒泡到这里。若不拦：
    //   点战斗指令条上的任何按钮（攻击/技能/逃跑/跳过）都会把按下态置上，
    //   而 _end() 早已把 sm.current 切回 MainScene，随后的 window mouseup 便通过
    //   BattleScene 守卫 → 用【按钮的屏幕坐标】寻路 → 回城后 player.path 被填上、
    //   角色自动走向那个点（表现为"战斗结束后莫名走动"）。
    //   判据：① 当前场景已是 BattleScene；② 或事件 target 落在 #battle-layer 内。
    //   两者取或——① 覆盖"战斗层尚未建立/已移除但仍是战斗场景"，② 覆盖"场景已切回主城
    //   但战斗层 DOM 尚在（_end 的渐隐期，battle.remove() 之前）"的竞态窗口。
    const isFromBattleLayer = (e) => {
      if (this.sm.current && this.sm.current.constructor.name === 'BattleScene') return true;
      const bl = this.sm.layers.world.querySelector('#battle-layer');
      return !!(bl && e.target && (e.target === bl || bl.contains(e.target)));
    };

    // ── 按下（鼠标）──────────────────────────────────────────────────────────
    //   对齐 AS3 GameWorld.sceneMouseDownHandler：左键落下 = 新手势起点（_mouseDownTime + 指针位置）；
    //   若上一手势仍在跟随 → 「点击确定终点并取消跟随」（原版的 _isMouseDown 翻转 + setPlayerXY）。
    //   右键不在这里处理（见下方 button===2 分支，对齐 AS3 rightClick）。
    vp.addEventListener('mousedown', e => {
      // ★ 触屏合成事件抑制：本手势的 touchstart 已 preventDefault，但部分浏览器/边缘场景
      //   仍可能补发 mousedown。若距上次 touchend 很近则视为合成事件，直接吞掉。
      if (this._lastTouchEndT && performance.now() - this._lastTouchEndT < 700) return;
      if (isFromBattleLayer(e)) return;
      // 右键：对齐 AS3 GameWorld.rightClick —— 退出跟随态（切回点击终点模式），不发起寻路。
      //   随后触发的 contextmenu 监听器会再兜底一次（幂等）；原生右键菜单由 ui.js 全局收口抑制。
      if (e.button === 2) { this._exitFollow(); return; }
      if (e.button !== 0) return;                       // 仅左键驱动移动手势（中键等忽略）
      // ★ 兜底：若按下落在 <img> 上（瓦片/小地图底图等），preventDefault 抑制浏览器原生拖拽启动，
      //   避免拖拽吞掉 mouseup 使按下态永久卡住（2026-09-24 定案的「假卡死」）。
      //   仅在视口交互场景下生效；面板内 img 有各自的 pointer-events/拖拽语义，不经过本监听器。
      if (e.target && e.target.tagName === 'IMG') e.preventDefault();
      const wasFollowing = this._following;
      this._downFighter = this._hitTestFighters(e.clientX, e.clientY);
      this._ptr = { down: true, x: e.clientX, y: e.clientY, t: performance.now(), id: 'mouse' };
      if (wasFollowing) {
        // 退出跟随并把落点定为新终点（对齐原版按下的 setPlayerXY：立即走一次点击移动）
        this._following = false;
        this._followMarkerPos = null;
        this._triggerPathfind(e.clientX, e.clientY);
      }
    });
    window.addEventListener('mouseup', e => {
      if (e.button !== 0) return;                       // 只收尾左键手势
      if (!this._ptr.down || this._ptr.id !== 'mouse') return;
      this._ptr.down = false;
      // ★ 长按跟随的松手：保持跟随（对齐 AS3 onStageMouseUp —— 距按下 >= _leftClickTime 时
      //   不复位 _isMouseDown，松手后 enterFrameHandler 仍每帧 movePlayerToXY2 走向当前光标）。
      //   mousemove 无论按钮状态都刷新 _ptr.x/y，故松手后路径与终点光圈仍持续跟随光标。
      if (this._following) return;
      // 以下为「短按 = 普通点击移动」收尾（对齐 AS3 onStageMouseUp 的短按复位）
      if (this.sm.current && this.sm.current.constructor.name === 'BattleScene') return;
      // ★ 兜底：若本次按下的落点落在战斗层内，绝不在大地图上寻路（覆盖"按下时还在战斗、
      //   松开时战斗已结束"的竞态；mousedown 侧的判据已拦绝大多数，这里是双保险）。
      const bl = this.sm.layers.world.querySelector('#battle-layer');
      if (bl && !bl.classList.contains('hidden') && e.target && (e.target === bl || bl.contains(e.target))) return;
      // 主角(玩家)现已参与像素命中：实体像素命中主角不误触 NPC，仍走寻路(点自己脚边≈原地)；
      // 仅当命中"非玩家实体像素"(NPC/怪物)才交互——玩家透明像素因穿透到下层 NPC 也会被这里捕获。
      if (this._downFighter && this._downFighter !== this.player) {
        const f = this._downFighter;
        if (f.npcData && f.npcData.type === 'monster') this._startBattle(f);
        else if (f.npcData) this._interactNpc(f);
        return;
      }
      this._triggerPathfind(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', e => {
      // 跟随态：指针位置始终刷新（无论按钮是否按下——松手后仍跟随，对齐 AS3 stage.mouseX/Y），
      //   并把终点光圈挪到当前光标处（锚点对准指针顶点，同自绘光标）。
      if (this._following) {
        this._ptr.x = e.clientX; this._ptr.y = e.clientY;
        this._moveFollowMarker();
        return;
      }
      // 按下中但尚未到长按阈值：只记录指针位置（_tickFollow 到阈值才进入跟随）。
      // 摄像机不需要手动拖拽——_update 的 deadzone 平滑跟随会一直把玩家锁在视口中区。
      if (this._ptr.down) { this._ptr.x = e.clientX; this._ptr.y = e.clientY; return; }
      this._updateHover(e.clientX, e.clientY);
    });
    // 右键菜单弹出前：退出跟随（对齐 AS3 GameWorld.rightClick :617 → _isMouseDown = false）。
    //   挂在 viewport（target 层）早于 ui.js 的 window 级 contextmenu 收口，原生菜单由后者抑制。
    vp.addEventListener('contextmenu', () => { this._exitFollow(); });

    // ── 触屏：与鼠标左键同语义（手指 = 鼠标），为"长按人物跟随"提供移动端入口 ──────
    //   viewport 挂 touch-action:none（css/style.css），浏览器不抢手势做滚动/缩放，
    //   touchmove 全程到达。touchstart preventDefault 抑制浏览器补发的合成鼠标事件，
    //   防止一次手指操作被鼠标分支重复处理。
    vp.addEventListener('touchstart', e => {
      if (isFromBattleLayer(e)) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      if (!t) return;
      const wasFollowing = this._following;
      this._downFighter = this._hitTestFighters(t.clientX, t.clientY);
      this._ptr = { down: true, x: t.clientX, y: t.clientY, t: performance.now(), id: t.identifier };
      if (wasFollowing) {
        this._following = false;
        this._followMarkerPos = null;
        this._triggerPathfind(t.clientX, t.clientY);
      }
    }, { passive: false });
    const findTouch = (e, id) => {
      for (const t of e.changedTouches) if (t.identifier === id) return t;
      return null;
    };
    window.addEventListener('touchmove', e => {
      if (!this._ptr.down) return;
      const t = findTouch(e, this._ptr.id);
      if (!t) return;
      e.preventDefault();
      this._ptr.x = t.clientX; this._ptr.y = t.clientY;
      // 跟随态：终点光圈跟随手指（路径重算仍由 _tickFollow 按目标格变化节流）
      if (this._following) this._moveFollowMarker();
    }, { passive: false });
    const onTouchEnd = (e) => {
      if (!this._ptr.down) return;
      const t = findTouch(e, this._ptr.id);
      if (!t) return;                                  // 别的手指抬起，忽略
      e.preventDefault();
      this._lastTouchEndT = performance.now();
      this._ptr.down = false;
      // 松手保持跟随（同 mouseup 语义，对齐 AS3 onStageMouseUp 长按不复位）
      if (this._following) return;
      if (this.sm.current && this.sm.current.constructor.name === 'BattleScene') return;
      const bl = this.sm.layers.world.querySelector('#battle-layer');
      if (bl && !bl.classList.contains('hidden') && e.target && (e.target === bl || bl.contains(e.target))) return;
      if (this._downFighter && this._downFighter !== this.player) {
        const f = this._downFighter;
        if (f.npcData && f.npcData.type === 'monster') this._startBattle(f);
        else if (f.npcData) this._interactNpc(f);
        return;
      }
      this._triggerPathfind(t.clientX, t.clientY);
    };
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    window.addEventListener('keydown', e => {
      this.keys[e.key.toLowerCase()] = true;
      if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(e.key.toLowerCase())) {
        this.player.path = [];
        // 手动移动打断长按跟随（手势仍按着，但不再驱动寻路）
        this._following = false;
        // ★ 打断自动寻路必须一并清终点光圈：快速点按移动键时，帧循环可能再看不到按键
        //   （keyup 已到）→ 走 else 分支只 stand()，光圈会永久留在旧落点循环播放。
        this._clearDestMarker();
      }
    });
    window.addEventListener('keyup', e => { this.keys[e.key.toLowerCase()] = false; });
    // 失焦兜底：窗口切走/系统弹窗抢焦点时 keyup 永远不会到达 → 按键状态永久卡住，
    // 表现为角色回城后持续漂移（见 _clearKeys 注释）。blur 时统一清空；
    // 按住中的长按手势也一并作废（否则回焦点后人物会自己跟着"幽灵指针"走）。
    window.addEventListener('blur', () => {
      this._clearKeys();
      this._ptr.down = false;
      this._following = false;
    });
  }

  // ★ 13r：悬停命中节流（40ms ≈ 25Hz，含尾随补算）
  // 动机：每次 mousemove 都做一次"角色画布 GPU→CPU 回读"（实测单次 avg 5.36ms / max 31.6ms），
  //   鼠标快速扫过 NPC 时会把主线程切碎造成掉帧。悬停提示/光标并不需要 100+Hz 精度。
  // 实现：前沿节流 + 尾随补算（保证停下时最终位置一定被判定，光标不会残留错状态）。
  _updateHover(clientX, clientY) {
    const HOVER_MS = 40;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (now - (this._hoverT || 0) < HOVER_MS) {
      this._hoverPend = { x: clientX, y: clientY };
      if (!this._hoverTimer) {
        this._hoverTimer = setTimeout(() => {
          this._hoverTimer = null;
          const p = this._hoverPend;
          this._hoverPend = null;
          if (p && this.sm.current === this) this._updateHover(p.x, p.y);
        }, HOVER_MS);
      }
      return;
    }
    this._hoverT = now;
    // ★ 光标/悬停穿透面板 —— 根源修复（无差别于自绘光标开关）：
    //   _hitTestFighters 只看世界层 fighter、isWalkable 只看寻路层，两者都不知道面板盖在上面 ——
    //   指针压在面板上时仍会命中面板背后的怪物/地面，连带出现三处穿透：
    //     ① 自绘光标在面板上显示 dialog/battle/nopass 图；
    //     ② 面板背后的 fighter 残留 .hovered 高亮；
    //     ③ viewport 手型被设成 pointer（虽然 viewport 在 #world 层、面板在其上，视觉上不显示，
    //        但状态是错的，移回地图瞬间会闪一下）。
    //   对齐 AS3：gameWorld 的 mouseOver 命中只在「指针直接落在世界显示对象上」时发生；面板/
    //   提示/侧栏都在 gameWorld 之上的层，挡住即不触发。此处用 elementFromPoint 判定该点最顶层
    //   元素是否属于 #ui-layer（其自身 pointer-events:none 不参与命中，故命中的必是面板/提示/侧栏
    //   等真实可交互元素），是 → 跳过整段世界命中：自绘光标切 default 态（UI 层统一默认自绘光标）、
    //   清 hover 高亮、清 viewport 手型；回到地图再由下方正常流程恢复。
    if (customCursor.isOverUi(clientX, clientY)) {
      customCursor.setState('default');
      if (this._hovered) { this._hovered.el.classList.remove('hovered'); this._hovered = null; }
      this.viewport.style.cursor = '';
      return;
    }
    // ★ 场景守卫：本方法由 window 级 mousemove 驱动、不随场景切换解绑。战斗等非主城场景下
    //   世界命中毫无意义且会穿透：#battle-layer 盖在世界层之上，_hitTestFighters/isWalkable 仍按
    //   主城层判定 → 自绘光标被设成 nopass（地面移动语义）穿透到战斗层（用户反馈「战斗层的自绘
    //   光标穿透了 cursornopass」）。战斗中自绘光标统一保持 default（nopass/dialog/battle 都是
    //   主城交互语义），并清掉残留的 hovered 高亮；战斗自己的 _updateBattleHover 另管高亮。
    if (this.sm.current !== this) {
      if (customCursor.on) customCursor.setState('default');
      if (this._hovered) { this._hovered.el.classList.remove('hovered'); this._hovered = null; }
      return;
    }
    const hit = this._hitTestFighters(clientX, clientY);
    // 主角(玩家)参与像素命中后，悬停其"实体像素"时不显示交互指针(避免误导)，透明像素归下层
    const interactive = (hit && hit !== this.player) ? hit : null;
    if (this._hovered !== interactive) {
      if (this._hovered) this._hovered.el.classList.remove('hovered');
      this._hovered = interactive;
      if (this._hovered) this._hovered.el.classList.add('hovered');
    }
    this.viewport.style.cursor = this._hovered ? 'pointer' : 'grab';
    // 自绘光标（设置「自绘光标」开启时）：按悬停对象切换光标图
    //   NPC→dialog / 怪物→battle / 空地→default；空地且落在寻路层障碍格→nopass（禁止点击）
    //   ★ 障碍判定与点击拦截同源（pathfindToWorld 内 isWalkable 判），指针提示与实际行为永远一致。
    if (customCursor.on) {
      if (this._hovered) {
        if (this._hovered.npcData && this._hovered.npcData.type === 'monster') customCursor.setState('battle');
        else customCursor.setState('dialog');
      } else {
        // 落点是否压在障碍格上（client → 世界 → 寻路网格；mask 1/2 可走，0/越界 阻挡）
        const rect = this.viewport.getBoundingClientRect();
        const c = MapSystem.getGridPos(clientX - rect.left + this.camera.x, clientY - rect.top + this.camera.y);
        customCursor.setState(MapSystem.isWalkable(c.col, c.row) ? 'default' : 'nopass');
      }
    }
  }

  // 屏幕像素(client) → 摄像机世界像素，再委托 pathfindToWorld（也可被小地图面板直接调用）
  _triggerPathfind(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    const wx = clientX - rect.left + this.camera.x;
    const wy = clientY - rect.top + this.camera.y;
    this.pathfindToWorld(wx, wy);
  }

  /**
   * 世界像素坐标 → 网格 → A* 寻路并设置玩家路径。
   * 复用于：① 主视口点击（_triggerPathfind 经摄像机换算后调用）
   *        ② 小地图面板点击（直接传入小地图换算出的世界像素，绕过摄像机，对齐 AS3 SmallMapPanel.findingAtSmallMap）
   *        ③ 长按跟随（_tickFollow 每隔目标格变化时调用，传 quiet:true 抑制终点光圈）
   * ★ 落点在寻路层障碍格（mask===0，含越界）时【禁止点击】：直接返回不寻路（视口与小地图同口径，
   *   对齐 AS3 点击不可走区域无反应）。末段在 isPixelLineClear 时回填精确像素端点。
   * opts.quiet=true 时不挂终点光圈（跟随态目标随手在动，光圈会频闪；由调用侧单独控制）。
   */
  pathfindToWorld(targetWorldX, targetWorldY, opts) {
    const quiet = !!(opts && opts.quiet);
    // ★ 玩家主动移动 ⇒ 取消「走向 NPC 自动对话」；_interactNpc 的自动寻路置 _talkAutoPath 跳过本判定
    if (!this._talkAutoPath) this._pendingTalk = null;
    const p = this.player;
    const s = MapSystem.getGridPos(p.x, p.y);
    const t = MapSystem.getGridPos(targetWorldX, targetWorldY);
    if (!MapSystem.isWalkable(t.col, t.row)) return;   // 障碍格：禁止点击
    const raw = AStar.findPath(s.col, s.row, t.col, t.row);
    const path = AStar.optimizePath(raw);
    if (path.length > 0) {
      const lastIdx = path.length - 1;
      const pixelEnd = { x: targetWorldX, y: targetWorldY };
      if (lastIdx === 0) {
        path[lastIdx] = pixelEnd;
      } else {
        const prev = path[lastIdx - 1];
        if (AStar.isPixelLineClear(prev, pixelEnd)) path[lastIdx] = pixelEnd;
      }
      p.path = path;
      // 新寻路 ⇒ 取消进行中的「到点归中」（对齐 AS3 addPointer：isMoveToCenter=false）
      this._cancelMoveToCenter();
      // 记录本次行走的镜头起点（对齐 AS3 addPointer → updateLastPlayerDxy）：走到终点时
      // 与当前镜头比较，相同则说明全程没出死区 ⇒ 不归中。
      this._pathStartCamX = this.camera.x;
      this._pathStartCamY = this.camera.y;
      // ★ 只在多段路径时跳过 path[0]——它是「起点格心」，玩家已在格内，不必先走回格心。
      //   但「落点与玩家同格」时整条路径只有 1 个节点，且它刚被替换成落点 pixelEnd —— 这是
      //   【终点】而非起点，跳过它会让路径整个被清空 → 同格点击人物不动
      //   （user 2026-09-29 报「点击位置与人物不超过 1 格距离时点击无效，跟随态也不跟随」）。
      if (p.path.length > 1) p.path.shift();
      // 寻路层「终点动画」：落点持续循环播放 resource/effect/cursor 的光圈，直到玩家走到终点才消失。
      // 仅当确有移动（落点不在脚下）才挂标记；点到脚下（<2px）立即到达则无需标记，否则异步光圈在
      //   玩家已到位后才 resolve，变成一个永远不会被清除的残留光圈。
      if (quiet) return;
      const arrived = Math.hypot(pixelEnd.x - p.x, pixelEnd.y - p.y) < 2;
      if (!arrived && p.path.length > 0) this._playDestEffect(pixelEnd.x, pixelEnd.y);
      else this._clearDestMarker();
    }
  }

  // 寻路终点光圈：在落点世界坐标【持续循环】播放，直到玩家走到终点才消失。
  // 复用 resource/effect/cursor（20 帧 scale+fade）；cell 挂 actorLayer（世界坐标、随摄像机滚动）。
  // 不再用 playEffect（一次性自动销毁），改走底层 mount(loop:true)+anchorOrigin 手动控制生命周期，
  // 与 playStatus 的持续型状态动画同理；到位 / 新寻路 / 手动打断时由 _clearDestMarker 停止并移除。
  // 代际 _destMarkerGen 防止异步竞态：loadEffect 是异步，若期间又发起新寻路或清标记，旧 resolve 直接作废移除自身 cell。
  // 长按跟随时：光圈已存在则走 _moveDestMarker 直接挪过去（对齐 AS3 addPointer 复用同一指针对象），
  // 仅在光圈尚不存在（首次落点 / 异步加载在途）时才新建；_followMarkerPos 记录在途期间的最新目标，
  // resolve 时一次性落到最新位置，避免异步窗口内的目标漂移。
  // 锚点统一走 anchorOrigin（Flash 原点对齐落点）——原版指针贴图的本意即如此，跟随态与点击态同一套定位。
  _playDestEffect(wx, wy) {
    if (typeof document === 'undefined' || !document.body) return;
    this._clearDestMarker();
    const gen = (this._destMarkerGen = (this._destMarkerGen || 0) + 1);
    this._destMarkerLoading = true;
    const cell = document.createElement('div');
    // ★ 终点光圈挂 document.body 的 fixed 层，z-index 取【世界层之上、UI 层之下】：
    //   #world z5（其内 actor-layer z2 / battle-layer z8 同属它的 stacking context，最高不过 z5）
    //   #ui-layer z20（panelLayer z5000 / promptLayer z6000 / sidebar 都在其内）
    //   ⇒ body 级 fixed 元素取 z-index 15 即「高于所有世界模型、低于所有 UI 面板」。
    //   ⚠ 之前按「和自绘光标同层」取 2147483647，会盖在 panelLayer 之上（用户：终点动画穿透
    //     UI 面板了）。自绘光标才需要最高（它是指针，永远在最前），终点光圈是世界特效，应被 UI 遮挡。
    //   定位坐标走【屏幕 client 坐标】：cell 记录世界锚点 wx/wy，由 _positionDestMarker 每帧
    //   （camera 插值后）换算重定位，视觉效果与挂世界层一致（相机移动时光圈在屏幕上随之滚动）。
    cell.style.position = 'fixed';
    cell.style.left = '0'; cell.style.top = '0';
    cell.style.zIndex = '15';               // 世界层(5)之上、UI 层(20)之下
    cell.style.pointerEvents = 'none';
    cell.style.willChange = 'transform';    // 每帧由 transform 平移（GPU 合成，不触发布局，防布局抖动致渲染崩溃）
    cell.classList.add('dest-marker-layer'); // 标识（探针/遮挡判定用）
    document.body.appendChild(cell);
    loadEffect('cursor').then((rec) => {
      if (gen !== this._destMarkerGen) { _disposeCell(cell); return; }   // 已被新落点/清除取代
      if (!rec) { _disposeCell(cell); this._destMarkerLoading = false; return; }
      const canvas = mount(cell, rec.swfData, rec.main, rec.imagePath, { loop: true, scale: 1 });
      // canvas 在 cell 内锚定 (0,0)（anchorOrigin 只做一次 Flash 原点修正）；
      //   落点的屏幕平移全部由 cell.style.transform 承载（_positionDestMarker 每帧更新）。
      anchorOrigin(canvas, rec.swfData, rec.main, { x: 0, y: 0, scale: 1 });
      // 异步在途期间目标可能已随光标移动（长按跟随）：落到最新记录位置
      const pos = (this._following && this._followMarkerPos) ? this._followMarkerPos : { x: wx, y: wy };
      this._destMarker = { cell, canvas, rec, wx: pos.x, wy: pos.y };
      this._positionDestMarker();
      this._destMarkerLoading = false;
    }).catch((e) => { console.warn('终点光圈加载失败', e); if (gen === this._destMarkerGen) { _disposeCell(cell); this._destMarkerLoading = false; } });
  }

  // 把终点光圈按【世界锚点 → 屏幕 client 坐标】重新定位。挂 fixed 层后必须每帧调一次
  //   （_update 的 camera 步之后），否则相机插值会把光圈甩离落点。
  //   ★ 场景守卫：光圈 z-index 15 仍高于整个 #world（z5，含 battle-layer z8），
  //     战斗层盖不住它，若不隐藏会穿透到战斗场景（用户反馈「战斗场景也出现终点动画」）。
  //     非主城场景一律 display:none；_resume 回主城时由其自身的 _clearDestMarker / _playDestEffect
  //     重建或清空，无需在此恢复。
  //   ★ 光圈低于 #ui-layer(z20)，故打开任何面板都会自然遮挡光圈（用户反馈「终点动画穿透
  //     UI 面板了」——此前 z-index 2147483647 与自绘光标同层导致盖在面板之上）。
  _positionDestMarker() {
    const m = this._destMarker;
    if (!m || !m.cell || !this.viewport) return;
    if (this.sm.current !== this) {
      // ★ 场景守卫：光圈 z15 仍高于整个 #world（z5，含 battle-layer z8），战斗层盖不住，
      //   不隐藏会穿透到战斗场景（用户反馈「战斗场景也出现终点动画」）。
      //   ★ 同时停掉 fanvas Timer（fanvas.pause）：CSS display:none 不感知动画循环，
      //     实测光圈隐藏期间 fanvas 仍在空转（1 秒 25 次 drawImage）。pause 真正停掉
      //     rAF 回调（Timer 内部 this.paused=true ⇒ _stop=true），减少战斗期间的无谓开销。
      //     ⚠ 只在「当前显示中」才 pause，避免重复调用（pause 幂等，但省一次 indexOfCanvas 查找）。
      if (m.cell.style.display !== 'none') {
        m.cell.style.display = 'none';
        if (m.canvas) { try { window.fanvas.pause(m.canvas); } catch (e) {} }
      }
      return;
    }
    if (m.cell.style.display === 'none') {
      m.cell.style.display = '';
      // ★ 恢复显示时同步 resume Timer（与 pause 成对；fanvas.resume 幂等）。
      if (m.canvas) { try { window.fanvas.resume(m.canvas); } catch (e) {} }
    }
    if (m.canvas == null || m.rec == null) return;
    // ★ 平移走 cell 的 transform（合成层，不触发 layout）；canvas 的 style 定位只在 mount 时设一次。
    //   旧实现在世界层用 canvas.style.left/top 每帧改值，挂 fixed 层后同样每帧改 left/top 会造成
    //   布局抖动，实测在长跟随移动时触发渲染进程崩溃（probe_longpress_follow Page crashed）。
    const rect = this.viewport.getBoundingClientRect();
    const cx = m.wx - this.camera.x + rect.left;
    const cy = m.wy - this.camera.y + rect.top;
    m.cell.style.transform = `translate(${Math.round(cx * 10) / 10}px, ${Math.round(cy * 10) / 10}px)`;
  }

  // 移动已有的终点光圈到新世界坐标（对齐 AS3 MainScene.addPointer：同一个指针对象重新定位，
  // 不重建画布、不重发 loadEffect）。供长按跟随的每次目标重算 / mousemove 实时跟手调用。
  _moveDestMarker(wx, wy) {
    const m = this._destMarker;
    if (!m || !m.canvas || !m.rec) return false;
    m.wx = wx; m.wy = wy;
    this._positionDestMarker();
    return true;
  }

  // 停止并移除寻路终点光圈：先 fanvas.pause 停内部 Timer（防泄漏），再移除 canvas 与 cell。
  // 调用时机：①玩家走到终点（line 734 !p.path.length）；②发起新寻路（_playDestEffect 开头先清旧的）；
  //          ③WASD 手动移动打断（line 700 p.path=[]）；④切图/离开场景想顺手清时。
  _clearDestMarker() {
    this._destMarkerGen = (this._destMarkerGen || 0) + 1;   // 令所有在途 resolve 失效
    // ★ 一并复位 _destMarkerLoading：否则「加载在途时被清除」（如玩家在光圈 loadEffect
    //   resolve 前已走到终点、或外部先寻路再立即清标记）会让本标记永久卡在 true，
    //   之后长按跟随的 _tickFollow 因 `if (!this._destMarkerLoading)` 跳过新建 → 跟随态无终点光圈。
    //   新的 _playDestEffect 总是先 clear 再置 true，故此处复位不影响其在途加载的所有权。
    this._destMarkerLoading = false;
    if (this._destMarker) {
      try { destroyCanvas(this._destMarker.canvas); } catch (e) {}
      if (this._destMarker.cell && this._destMarker.cell.parentNode) {
        this._destMarker.cell.parentNode.removeChild(this._destMarker.cell);
      }
      this._destMarker = null;
    }
  }

  _hitTestFighters(clientX, clientY) {
    const sorted = this.actors.slice().sort((a, b) => (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0));
    for (const f of sorted) {
      // 主角也参与像素级命中：透明像素( alpha<=24 )自然 continue 到下层(NPC/地图)，实体像素命中主角
      const cv = f.canvasWrap && f.canvasWrap.querySelector('canvas');
      if (!cv || !cv.width || !cv.height) continue;
      const rect = cv.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      let px = Math.floor((clientX - rect.left) / rect.width * cv.width);
      const py = Math.floor((clientY - rect.top) / rect.height * cv.height);
      if (f.flipX === -1) px = cv.width - px - 1;
      if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
      const alpha = _readFighterAlpha(cv, px, py);
      if (alpha > 24) return f;
    }
    return null;
  }

  _centerCameraOn(x, y) {
    this.camera.x = x - (window.innerWidth - SIDEBAR_W()) / 2;
    this.camera.y = y - window.innerHeight / 2;
    this._clampCamera();
    // 镜头瞬移（进图落点/传送/战斗归位）= 已在正确位置：取消进行中的到点归中，并标记路径已完结
    // （否则归中会把刚瞬移好的镜头再缓动一次）。镜头起点同步刷新，避免下次到点误判「动过镜头」。
    this._moveToCenter = false;
    this._pathDone = true;
    this._centerPending = false;
    this._pathStartCamX = this.camera.x;
    this._pathStartCamY = this.camera.y;
    // F6：镜头瞬移（进图落点/传送到达）后立即按新视口 burst 加载，避免可见区域出现加载缺口
    this._ioCull(performance.now(), true);
  }

  // 启动「到点归中」缓动（对齐 AS3 removePointer→updateMoveToXY→isMoveToCenter）：
  //   目标 = 让玩家落在视口正中（钳制后），由 _update 按 AS3 24fps 墙钟速度缓动逼近
  //   （系数见 CENTER_EASE_* 常量；SCALE=0.5 时 60fps 下 ≈0.0071/帧）。
  //   ⚠ 与 _centerCameraOn 的区别：那个是【瞬时】置中（进图/传送用），这个是【缓动】归中（走到点用），
  //     两者互斥——后者进行中若发生前者，_centerCameraOn 会取消它。
  //   ⚠ 调用点只有一处（_update 的 _centerPending 结算），且已由「本次行走动过镜头」守卫。
  _beginMoveToCenter() {
    const vw = (window.innerWidth - SIDEBAR_W()), vh = window.innerHeight;
    let tx = this.player.x - vw / 2, ty = this.player.y - vh / 2;
    tx = Math.max(0, Math.min(this.worldW - vw, tx));
    ty = Math.max(0, Math.min(this.worldH - vh, ty));
    if (this.worldW < vw) tx = (this.worldW - vw) / 2;
    if (this.worldH < vh) ty = (this.worldH - vh) / 2;
    this._toCamX = tx;
    this._toCamY = ty;
    this._moveToCenter = true;
  }

  // 取消归中（对齐 AS3 addPointer/setXY：任何新移动指令都停掉归中缓动）
  _cancelMoveToCenter() { this._moveToCenter = false; }
  _clampCamera() {
    this.camera.x = Math.max(0, Math.min(this.worldW - (window.innerWidth - SIDEBAR_W()), this.camera.x));
    this.camera.y = Math.max(0, Math.min(this.worldH - window.innerHeight, this.camera.y));
    if (this.worldW < (window.innerWidth - SIDEBAR_W())) this.camera.x = (this.worldW - (window.innerWidth - SIDEBAR_W())) / 2;
    if (this.worldH < window.innerHeight) this.camera.y = (this.worldH - window.innerHeight) / 2;
  }

  _renderTiles() {
    const viewW = (window.innerWidth - SIDEBAR_W()), viewH = window.innerHeight;
    const sCol = Math.max(0, Math.floor(this.camera.x / this.tileW) - 1);
    const sRow = Math.max(0, Math.floor(this.camera.y / this.tileH) - 1);
    const eCol = Math.min(this.cols - 1, Math.floor((this.camera.x + viewW) / this.tileW) + 1);
    const eRow = Math.min(this.rows - 1, Math.floor((this.camera.y + viewH) / this.tileH) + 1);
    const used = {};
    for (let r = sRow; r <= eRow; r++) {
      for (let c = sCol; c <= eCol; c++) {
        const key = r + '_' + c; used[key] = true;
        if (!this.tileMap[key]) {
          const img = new Image();
          // 切片按真实客户端 mapImg（resId）命名文件夹；极少地图仅 mapId 文件夹存在，作兜底
          const tileKey = (this.map.resId != null) ? this.map.resId : this.map.id;
          let tileTriedAlt = false;
          img.onerror = () => {
            if (!tileTriedAlt) { tileTriedAlt = true; img.onerror = null; img.src = url.mapTile(this.map.id, c, r); }
          };
          img.src = url.mapTile(tileKey, c, r);
          img.style.position = 'absolute';
          img.style.left = (c * this.tileW) + 'px';
          img.style.top = (r * this.tileH) + 'px';
          img.style.width = this.tileW + 'px';
          img.style.height = this.tileH + 'px';
          img.decoding = 'async';
          // ★ 瓦片是纯渲染元素，必须禁用原生拖拽：否则按下瓦片 img 轻微移动会触发浏览器
          //   原生 HTML5 拖拽 ⇒ 发 pointercancel 抑制全部鼠标事件并吞掉 mouseup ⇒
          //   按下态永久卡住；拖拽期间本函数又会 removeChild 滑出视野的瓦片（拖拽源被移出 DOM）
          //   ⇒ 永无 dragend ⇒ 输入永久锁死（2026-09-24 定案的「假卡死」根因）。
          img.draggable = false;
          img.style.pointerEvents = 'none';
          this.mapLayer.appendChild(img);
          this.tileMap[key] = img;
        }
      }
    }
    for (const k in this.tileMap) {
      if (!used[k]) { this.mapLayer.removeChild(this.tileMap[k]); delete this.tileMap[k]; }
    }
  }

  // 启动主循环的唯一入口：同一时刻只允许【一条】在飞的 _loop。
  // 旧实现里 enter()/\_resume()/\_loop 末尾各自直接 requestAnimationFrame(this._loop)，
  // 多条链并存时：①每帧重复跑 _update/_renderTiles/updateMinimap（CPU 成倍上升）；
  // ②它们共享 this.lastTime，第一条链已把 lastTime 写成 now，其余链 dt≈0 ⇒ 角色"按了也不动"。
  // 这里用"在飞标记"收口，杜绝重复启动。
  _scheduleLoop() {
    if (this._loopScheduled) return;
    this._loopScheduled = true;
    requestAnimationFrame(this._loop);
  }

  _loop(now) {
    this._loopScheduled = false;
    // 场景已切换（包括进入战斗后被新主场景取代）则本循环立即退出，
    // 避免旧主场景的 requestAnimationFrame 持续累积造成性能泄漏。
    if (this.sm.current !== this) { this._loopRunning = false; return; }
    this._loopRunning = true;
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    // ★★ 主循环"不可杀死"：
    //   旧实现把 requestAnimationFrame 放在函数【末尾】，于是 _update / _renderTiles /
    //   actors.forEach(setDepth) / _updateNearest / updateMinimap 任一抛异常，
    //   续帧那行就永远执行不到 ⇒ 主循环永久停摆。后果与 user 反馈完全吻合：
    //     · 角色不动（_update 不再跑，WASD 与寻路都不消费）
    //     · 点击无反应（path 设上了但没人推进）
    //     · NPC 动画照常播放（fanvas 自带定时器，不依赖主循环）
    //     · 没有任何 UI 提示、玩家无法自救，只能刷新页面
    //   故把续帧移进 finally：异常只打日志，绝不掐断循环。
    // ★★ 逐步独立 try/catch（诊断关键）：
    //   ① 精确定位是哪一步抛的（update / camera / renderTiles / setDepth / updateNearest / updateMinimap）
    //   ② 某一步挂掉不影响其余步骤继续渲染，主循环绝不中断。
    try {
      this._loopStep('update', () => this._update(dt));
      this._loopStep('camera', () => {
        this.scroll.style.transform = `translate3d(${-Math.round(this.camera.x)}px, ${-Math.round(this.camera.y)}px, 0)`;
      });
      this._loopStep('renderTiles', () => this._renderTiles());
      this._loopStep('setDepth', () => this.actors.forEach(a => a.setDepth(a.y)));
      this._loopStep('updateNearest', () => this._updateNearest());
      // ★ HUD 刷新步：左上角城市信息栏（对齐 AS3 CityFace）的城名/坐标随玩家移动刷新。
      //   原「角标小地图」每帧重绘 canvas 的步骤已随小地图移除而停用
      //   （ui.updateMinimap 空操作守卫，不再分配/绘制 canvas）；小地图能力全部在「小地图面板」。
      this._loopStep('hud', () => this.sm.ui.updateHud(this.player));
      // ★ 13r 新增（第 7 步，与原 6 步同构：独立 try/catch，异常绝不外溢、不影响续帧）：
      //   视野外 NPC 动画剔除 —— 灵昌城 39 NPC 中常态仅 7 个在屏内（实测），
      //   其余 32 个的 fanvas Timer 每帧仍重绘 → 白白吃掉主线程。此处按世界坐标暂停/恢复。
      this._loopStep('animCull', () => this._animCull(now));
      // ★ F6 懒加载 IO：8Hz 低频巡检待加载队列，按视口范围 spawn（含背压限流，避免甩镜时
      //   几十个 fetch+parse 并发卡帧）。已加载单位不卸载，离屏暂停由 animCull 步负责。
      this._loopStep('ioCull', () => this._ioCull(now));
      // NPC 头顶任务标记（yem/yqm）：4Hz 巡检 = 懒加载兑现（视口外先记账、进视口才挂）+ 状态兜底
      this._loopStep('questMarks', () => this.marks && this.marks.tick(now));
      // ★ 自动对话：点 NPC 时距离不够会先寻路走近（_interactNpc 注册 _pendingTalk），
      //   走到范围内由 _tickTalkArrive 自动打开交谈面板（对齐 AS3 moveToNpc）。
      this._loopStep('talkArrive', () => this._tickTalkArrive());
    } finally {
      // 无论中间发生什么，都必须续帧 —— 这是"主循环不可被杀死"的最后一道保险。
      this._scheduleLoop();
    }
  }

  // 单个子步骤执行器：抛异常只归集、不外溢（主循环不可被杀死，见 _loop 注释）
  _loopStep(tag, fn) {
    try { fn(); } catch (e) { this._recordLoopErr(tag, e); }
  }

  // 归集主循环异常：
  //   · 全量留在 this._loopErrs / window.__loopErrors（最近 30 条，含完整 stack）
  //   · 控制台按「步骤」去重，避免每帧刷屏（同一 tag 只打第一次，次数另计）
  //   · 玩家可随时在控制台执行 __dumpLoopErrors() 取全部记录
  _recordLoopErr(tag, e) {
    const rec = { at: new Date().toISOString(), tag, msg: String((e && e.message) || e), stack: String((e && e.stack) || e) };
    if (!this._loopErrs) this._loopErrs = [];
    this._loopErrs.push(rec);
    if (this._loopErrs.length > 30) this._loopErrs.shift();
    const buf = (window.__loopErrors = window.__loopErrors || []);
    buf.push(rec);
    if (buf.length > 30) buf.shift();
    this._loopErrN = (this._loopErrN || 0) + 1;
    this._loopErrByTag = this._loopErrByTag || {};
    this._loopErrByTag[tag] = (this._loopErrByTag[tag] || 0) + 1;
    if (this._loopErrByTag[tag] === 1) {
      console.error(`[main] 主循环异常 @${tag}（已跳过该步并续帧，游戏未卡死）：`, e);
    }
  }

  // ── ★★ F6 懒加载 IO（对齐 deobfuscated/架构设计哲学分析.html：资源按需加载 + 队列背压 + 两级缓存） ─────
  // 动机：loader.loadChar 是 fetch(.swf)+fetch(.html)+evalSwf+parseCharActions 的重 IO，且每个单位还要
  //   mount canvas + 建纸娃娃层。旧实现进图即全量生成本图全部 NPC/明雷（灵昌城 39 NPC + 大量传送法阵
  //   特效），其中绝大多数远离视口，IO 与 DOM 建树成本白白浪费（F6 用户裁决：仅当模型可见时才执行加载）。
  // 策略（低成本、玩家无感）：
  //   · 待加载队列 _npcPending（进图/重生时只登记定义，不建模型）；本方法 8Hz 低频巡检，不做逐帧检测；
  //   · 单阈值 IO_LOAD_M：单位进入「视口 + IO_LOAD_M」加载带 → 排入加载；视野外交由 _animCull 暂停动画；
  //   · 背压：稳态每 tick 最多出队 IO_MAX_PER_TICK 个（对齐 AS3 加载侧队列背压，避免一次甩镜
  //     触发几十个并发 fetch+parse 卡帧）；burst（进图/传送落点）放宽到 IO_BURST_MAX，可见集合本就有界；
  //   · 已加载单位【永不因离屏卸载】——只暂停动画、保留 DOM 与池缓存（= AS3「资源缓存长期、去重、
  //     无淘汰」），反复进出同一区域零重复 IO；切图时随 _teardownActors 一次性 dispose（= 地图切换 dispose）。
  // 边界：玩家常驻实例不进队列；战斗内单位不归本队列管；传送门是纯数据不受影响。
  // 失败/已击败的单位（_spawnNpc 返回 undefined）直接从队列丢弃，不留在 pending 里反复判定。
  _ioCull(now, burst) {
    if (!this._npcPending || !this._npcPending.length) return;
    if (!burst && now - (this._ioCullT || 0) < 125) return;   // 稳态 8Hz
    this._ioCullT = now;
    const vw = window.innerWidth - SIDEBAR_W(), vh = window.innerHeight;
    const cam = this.camera;
    const M = IO_LOAD_M;
    let budget = burst ? IO_BURST_MAX : IO_MAX_PER_TICK;
    const still = [];
    for (let i = 0; i < this._npcPending.length; i++) {
      const pend = this._npcPending[i];
      if (budget <= 0) { still.push(pend); continue; }         // 本 tick 额度已尽，留到下一拍
      const n = pend.n;
      const sx = n.x - cam.x, sy = n.y - cam.y;
      if (sx < -M || sx > vw + M || sy < -M || sy > vh + M) { still.push(pend); continue; }
      budget--;
      const f = this._spawnNpc(n);                             // 内部含池复用 + defeated 守卫
      if (f && pend.spawner) pend.spawner.instances.push(f);   // 明雷实例回挂刷怪区（供重生清理）
    }
    this._npcPending = still;
  }

  // ── ★★ 13r：视野外 NPC 动画剔除（灵昌城卡顿治理·收益最大的一处） ─────────────────────
  // 动机（真机实测）：灵昌城 39 NPC，1280×720 视口下常态仅 7 个在屏内（余 32 个在世界另一头），
  //   但每个 NPC 都是一块画布 + 一条 fanvas rAF 链，全图约 70 条链每帧 ~18ms 纯 JS（吃满 60fps 预算）。
  // 做法：按世界坐标判断单位是否远离视口；远离则 fanvas.pause 该单位全部画布，回到视口内 resume。
  //   · 迟滞双阈值（OUT_M 才暂停 / IN_M 以内才恢复，中间地带保持原状）→ 边界单位不抖动；
  //   · 玩家永不剔除；战斗内单位不在 MainScene.actors 里，天然不受影响；
  //   · 8Hz 巡检（相机移动平滑，肉眼无感）——避免自身成为新的每帧开销。
  // 安全性：Fighter.initState() 会清 _current/_fanvasCanvas，池复用必然重挂新画布，
  //   故"暂停旧画布"不会导致复用后动画冻住；被暂停者必定不可见，无视觉副作用。
  //
  // ★★ 13s 修正（真机实证：13r 的「只在状态变化时下发一次」会永久漏掉，剔除率实际为 0）：
  //   两个独立的时序陷阱，都会让"下发一次"的 pause 落空，而 _animCulled 标记又会阻止重试：
  //     ① 预加载竞态：fanvas.play() 内部把画布 push 进其注册数组 b 这一步，发生在图片
  //        预加载【完成之后】。若首次 pause 落在预加载窗口内，indexOfCanvas 找不到画布 ⇒
  //        静默空转；随后 Timer 才 start() ⇒ 该画布永久满速空转。
  //     ② 画布重建：mount()（loader.js）每次切换动作都 createElement('canvas') 建【新】画布
  //        （旧的先 pause 再 remove）。新画布从未被 culled，标记却已是 true ⇒ 同样永久漏掉。
  //   对策：对 want===true（已剔除）的单位，按 reissue 节流【幂等重复】下发 pause；
  //   fanvas.pause 只做 indexOfCanvas + timer.pause，重复调用无副作用、代价可忽略。
  //   （实测：手动 pause 离屏画布后 drawImage 由 3~15 次/700ms 直接归零，证明接口本身有效。）
  _animCull(now) {
    if (!window.fanvas) return;
    if (now - (this._animCullT || 0) < 120) return;
    this._animCullT = now;
    const vw = window.innerWidth - SIDEBAR_W(), vh = window.innerHeight;
    const OUT_M = 260, IN_M = 120;          // 迟滞阈值（世界像素）
    const cam = this.camera, list = this.actors;
    // 每 5 次巡检（≈600ms）补发一次 pause：足以覆盖"预加载窗口"与"切动作重建画布"，
    // 又不至于让 8Hz×N 个画布的重复下发成为新的开销。
    const reissue = ((this._cullTick = (this._cullTick || 0) + 1) % 5) === 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f || f === this.player) continue;
      const sx = f.x - cam.x, sy = f.y - cam.y;
      const far = (sx < -OUT_M) || (sx > vw + OUT_M) || (sy < -OUT_M) || (sy > vh + OUT_M);
      const near = (sx >= -IN_M) && (sx <= vw + IN_M) && (sy >= -IN_M) && (sy <= vh + IN_M);
      const want = far ? true : (near ? false : null);   // null = 中间地带，保持原状
      if (want === null) continue;
      const changed = (f._animCulled !== want);
      // 状态没变时：只有"保持剔除"分支需要按节流补发（覆盖竞态/重建）；恢复分支不重复 resume。
      if (!changed && !(want && reissue)) continue;
      if (changed) f._animCulled = want;
      const cvs = (f.el && f.el.querySelectorAll) ? f.el.querySelectorAll('canvas') : null;
      if (!cvs) continue;
      for (let k = 0; k < cvs.length; k++) {
        const c = cvs[k];
        // 定格模型（loader 的 freezeFirst/freezeLast：单帧 Role、死亡末帧）由 gotoAndStop 主动停住，
        // 既不该被 pause（已是停的），更不该被 resume（会复活定格的死亡姿态）。
        if (c._frozen) continue;
        try { if (want) window.fanvas.pause(c); else window.fanvas.resume(c); } catch (e) {}
      }
    }
  }

  _update(dt) {
    const p = this.player;
    // ★ 防御：speed 缺失/非正数（存档异常或初始化未完成）时退化为 0 步长，
    //   避免 `NaN*dt` 把坐标污染成 NaN 导致"角色被 NaN 冻结、循环却活着、无报错"的静默卡死。
    const sp = (p.speed && p.speed > 0) ? p.speed * dt : 0;
    let dx = 0, dy = 0;
    if (this.keys['a'] || this.keys['arrowleft']) dx -= 1;
    if (this.keys['d'] || this.keys['arrowright']) dx += 1;
    if (this.keys['w'] || this.keys['arrowup']) dy -= 1;
    if (this.keys['s'] || this.keys['arrowdown']) dy += 1;

    // 4 向等距朝向（对齐参考项目 Player.tick：水平分量 + 垂直分量 → RB/LB/RT/LT；
    // 某个分量为 0 时保留上一次的该分量，避免纯水平/纯垂直行走时朝向乱跳）。
    // ★ 垂直分量原先【不保留】（my===0 一律 'T'）⇒ A* 路径里的水平段会把 RB/LB 误判成 RT/LT，
    //   表现为走横线段时朝向突然翻面。与"水平分量保留"对称补齐（同类抖动，一并修）。
    const isoDir = (mx, my) => {
      const h = mx > 0 ? 'R' : mx < 0 ? 'L'
        : ((p.dir && (p.dir[0] === 'L' || p.dir[0] === 'l')) ? 'L' : 'R');
      const v = my > 0 ? 'B' : my < 0 ? 'T'
        : ((p.dir && (p.dir[1] === 'T' || p.dir[1] === 't')) ? 'T' : 'B');
      return h + v;
    };

    if (dx || dy) {
      p.path = [];
      // 手动移动（WASD/方向键）打断长按跟随：按键事件可能早于本次按下注册（先按住 W 再长按
      // 屏幕），keydown 侧的打断到不了本手势，故在帧内再兜一次。
      this._following = false;
      // 手动移动也取消「到点归中」（对齐 AS3：任何新移动指令都会停掉归中缓动），
      // 否则归中会把镜头往回拽、与玩家主动移动打架。
      // ⚠ 同时置 _pathDone=true：手动移动不是「路径走完」，不应触发 removePointer 式归中。
      this._moveToCenter = false;
      this._pathDone = true;
      p.dir = isoDir(dx, dy);
      p.walk();
      p.x += dx * sp; p.y += dy * sp;
      this._clearDestMarker();   // 手动移动（WASD）→ 取消尚未到达的终点光圈
    } else if (p.path && p.path.length) {
      // ★★ 沿路径推进：本帧步长 sp 在【多个航点间连续消耗】，绝不越过航点。
      // 【原实现的两处 bug（user 2026-09-11 报"终点抖来抖去、最后朝向变 LT"）】
      //   旧代码用固定阈值 `if (dist < 4) 到点` 且每帧固定走满 sp：
      //     · sp = speed*dt，dt 上限 0.1 ⇒ 单帧最多走 200*0.1 = 20px；
      //       只要掉帧（dt>0.02 ⇒ sp>4）就会**冲过**航点（越过量最大 sp-4 ≈ 16px）。
      //     · 越过之后 ddx/ddy **双双反号**，下一帧 isoDir 立刻把 RB 算成 LT —— 这正是
      //       "从左上到右下本该 RB、结果变成 LT" 的根因（RB 与 LT 恰好是反向对）。
      //     · 多段路径时越过还会往回折返 ⇒ 视觉上"在终点抖来抖去"。
      // 【修法】①步长取 min(sp, dist)：走得到就**精确吸附**到该航点，把剩余步长结转给下一段；
      //         ②朝向只在"朝该航点确有位移（dist≥0.5）"时按其 delta 更新 ⇒ delta 永不反号，
      //           终点朝向恒为 RB；被整段吸附的短航点也更新朝向（缓慢跟随时朝向不会停在旧方向）。
      let remain = sp;
      let guard = 0;
      const sx = p.x, sy = p.y;                 // 本帧起点：用于判定「本帧是否真的在移动」
      while (remain > 0 && p.path.length && guard++ < 16) {
        const t = p.path[0];
        const ddx = t.x - p.x, ddy = t.y - p.y;
        const dist = Math.hypot(ddx, ddy);
        if (dist <= remain || dist < 0.5) {
          // 本帧剩余步长足够走完这一段 ⇒ 精确落在航点上（不越过），余量继续走下一段
          p.x = t.x; p.y = t.y;
          remain -= dist;
          p.path.shift();
        } else {
          p.x += (ddx / dist) * remain;
          p.y += (ddy / dist) * remain;
          remain = 0;
        }
        // ★ 任何「确有位移」的航点都要更新朝向（含被整段吸附的短航点）：
        //   缓慢跟随时单帧步长总够走完整段路径，旧实现在此分支不更朝向，模型会沿过时朝向走。
        if (dist >= 0.5) p.dir = isoDir(ddx, ddy);
      }
      // ★★ 动作按「是否真的在移动」判定，而非「路径是否走完」（user 2026-09-29 报
      //   「跟随态缓慢移动时模型一直保持等待动画然后直接平移」）：
      //   缓慢跟随时每帧路径都短于单帧步长，航点被整段吸附、路径当帧走空，旧实现随即
      //   stand() → 每帧 stand + 位移 = 原地滑步。现在：路径还有航点，或跟随态本帧确有
      //   位移 → walk()；否则 stand()。点击移动到终点时路径空且非跟随 → 立即 stand（无 1 帧抖动）。
      const moved = Math.hypot(p.x - sx, p.y - sy);
      if (p.path.length > 0 || (this._following && moved > 0.5)) p.walk();
      else p.stand();
      if (!p.path.length) {
        // 走到终点。长按跟随期间不做这两件事——玩家站在光标点上，光圈仍应压在光标处
        // （对齐 AS3：跟随态每帧 setXY 都会重新 addPointer，到点不会移除指针；松手或下次
        // 重算离开本格时再自然更新）。
        if (!this._following) {
          // ★ 仅在「有路径→空」的边沿帧触发一次（_pathDone），避免站着不动时每帧重复启动
          //   （重复启动本身幂等，但边沿触发更贴近 AS3 的 removePointer 单次语义）。
          if (!this._pathDone) {
            this._pathDone = true;
            this._clearDestMarker();
            // 到点归中判定（对齐 AS3 removePointer → isMoveToCenter）延后到本帧镜头更新之后，
            // 由 _centerPending 在 camera 段末尾结算（守卫：只有动过镜头才归中）。
            this._centerPending = true;
          }
        }
      } else {
        // 路径有效 ⇒ 对齐 AS3 addPointer：归中应被取消（兜底——正规入口 pathfindToWorld /
        // _walkToNpc / WASD 已各自调 _cancelMoveToCenter，此处覆盖「直接赋 player.path」的情况）
        this._pathDone = false;
        this._moveToCenter = false;
      }
    } else {
      p.stand();
    }
    p.x = Math.max(0, Math.min(this.worldW, p.x));
    p.y = Math.max(0, Math.min(this.worldH, p.y));
    // ★ 防御：坐标非法（NaN/Infinity，多由速度缺失或异常存档引发）时退回上一帧有效坐标，
    //   阻断 NaN 向摄像机/寻路/碰撞层级的级联污染（否则表现为"键鼠全死、动画照常、无任何报错"）。
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      if (Number.isFinite(this._lastGoodX)) { p.x = this._lastGoodX; p.y = this._lastGoodY; }
      else { p.x = 0; p.y = 0; }
      if (window.__diagLines && this._warnedNaN !== true) {
        this._warnedNaN = true;
        if (window.push) {} // noop
        console.warn('[main] 玩家坐标出现 NaN，已回退上一帧有效位置（疑似 speed/存档异常）');
      }
    } else {
      this._lastGoodX = p.x; this._lastGoodY = p.y;
    }
    p.setPos(p.x, p.y);

    // 半透明遮挡（对齐参考项目 Player.render：主角走到 mask===2 的遮挡格 → 半透明，
    // 便于在树后/建筑背面仍能看清角色。mask 语义：0=阻挡,1=可走,2=半透明遮挡但仍可走）。
    this._applyOcclusion(p);

    const vw = (window.innerWidth - SIDEBAR_W()), vh = window.innerHeight;
    // ★ 检测框 = 视口宽×CAM_BOX_W、高×CAM_BOX_H（相对比例，见文件头注释）
    const boxW = vw * CAM_BOX_W, boxH = vh * CAM_BOX_H;
    const boxL = (vw - boxW) / 2, boxR = (vw + boxW) / 2, boxT = (vh - boxH) / 2, boxB = (vh + boxH) / 2;
    const sx = p.x - this.camera.x, sy = p.y - this.camera.y;
    let tx = this.camera.x, ty = this.camera.y;
    if (this._moveToCenter) {
      // ── 到点归中缓动（对齐 AS3 GameMap.moveToCenter：无视死区，直奔「玩家居中」目标）────
      tx = this._toCamX;
      ty = this._toCamY;
    } else {
      // ── 出框跟随：AS3 硬同步（Player.moveXY：isMapMoveX/Y 为真 ⇒ dx += 玩家本帧速度）──────
      //   玩家一旦走出检测框，镜头【瞬时】贴到框边（玩家被钉在框上），绝无缓动滞后——
      //   之前的 ×0.85×dt 指数缓动在玩家持续移动时会落后，导致模型走出屏幕外看不见。
      //   玩家在框内时镜头完全不动（AS3 死区语义）。
      if (sx < boxL) tx = p.x - boxL; else if (sx > boxR) tx = p.x - boxR;
      if (sy < boxT) ty = p.y - boxT; else if (sy > boxB) ty = p.y - boxB;
    }
    // 钳制（对齐 AS3 MainScene.reviseOffset：dx∈[0,mapW-视口宽]，地图小于视口则居中）
    tx = Math.max(0, Math.min(this.worldW - vw, tx));
    ty = Math.max(0, Math.min(this.worldH - vh, ty));
    if (this.worldW < vw) tx = (this.worldW - vw) / 2;
    if (this.worldH < vh) ty = (this.worldH - vh) / 2;
    if (this._moveToCenter) {
      // ── AS3 GameMap.moveToCenter 的忠实移植（含其「int 截断尾部」）─────────────────────
      //   AS3 原文：xspeed = (toDx - dx) * 0.035（赋给 int ⇒ 截断）；
      //             若 xspeed==0 且 toDx!=dx 则走兜底 dx ± 1（每帧 1px）。
      //   ⚠ 关键：AS3 是【每 enterFrame 一次】，而原版 SWF 帧率 = 24fps（读
      //     Loading/main-game SWF 头实测），本端口主循环是 rAF≈60fps。直接照搬「每帧 ×0.035」
      //     会让墙钟速度快 2.5 倍（用户实测「像弹射」）。故按帧率无关化：
      //     每秒残留比 = 0.965^(24×SCALE)，k = 1 - decay^dt（SCALE=0.5 时 60fps 下 k≈0.0071）。
      //   尾部线性段同理：AS3 在剩余 < 1/0.035 ≈ 28.6px 时切换为 1px/帧 = 24×SCALE px/s。
      //   目标每帧重新钳制一次，窗口缩放/地图变更时也能收敛到合法位置（防卡死在归中态）。
      const k = 1 - Math.pow(CENTER_EASE_DECAY_PER_SEC, dt);
      const easeAxis = (rem) => {
        const gap = Math.abs(rem);
        if (gap < 1 / CENTER_EASE_PER_FRAME) {
          return Math.sign(rem) * Math.min(gap, CENTER_EASE_FPS * CENTER_EASE_SPEED_SCALE * dt);   // AS3 尾部：1px/帧 = 24×SCALE px/s
        }
        return rem * k;
      };
      this.camera.x += easeAxis(tx - this.camera.x);
      this.camera.y += easeAxis(ty - this.camera.y);
      if (Math.abs(tx - this.camera.x) < 0.5 && Math.abs(ty - this.camera.y) < 0.5) {
        this.camera.x = tx; this.camera.y = ty;
        this._moveToCenter = false;
      }
    } else {
      this.camera.x = tx;
      this.camera.y = ty;
    }

    // ── 到点归中判定（延后到本帧镜头更新【之后】执行）──────────────────────────────────
    //   ★ 对齐 AS3 Player.removePointer 的 `if (gameMap.isMapMove())` 守卫：
    //     isMapMove() 比较「寻路起点记录的 dx/dy」与当前 dx/dy —— 本次行走没动过镜头
    //     （= 玩家全程没超出死区）就【不平移也不缓动归中】，死区内的小走不折腾镜头。
    //   放在镜头更新之后，是为了让「恰在最后一帧才出框」也能正确判定。
    if (this._centerPending) {
      this._centerPending = false;
      const camMoved = Math.abs(this.camera.x - this._pathStartCamX) > 0.5
                    || Math.abs(this.camera.y - this._pathStartCamY) > 0.5;
      if (camMoved) this._beginMoveToCenter();
    }

    // ── 跟随态终点光圈：每帧用【本帧最终摄像机坐标】重定位 ──────────────────────────
    //   光圈挂在世界层（随 #world-scroll 的 translate3d 滚动），该 transform 在本帧 _update
    //   之后的 'camera' 步用同一份 this.camera 写入。故在此处（camera 步之后）把光圈
    //   挪到「当前光标 → 世界」的位置，渲染时就是精确贴住指针的屏幕坐标——消除 mousemove
    //   与摄像机移动之间的帧差（大幅甩动指针时动画不再落后）。障碍格上不挪（见 _moveFollowMarker）。
    if (this._following) this._moveFollowMarker();
    // ★ 终点光圈已改挂 body 的 fixed 层（z-index 15：世界层之上、UI 层之下），不再随 #world-scroll 滚动 ⇒
    //   每帧 camera 插值后必须按新的 camera 把世界锚点重算成 client 坐标，否则相机会把光圈甩离落点。
    if (this._destMarker) this._positionDestMarker();

    // ── 长按人物跟随（对齐 AS3 GameWorld.enterFrameHandler）──────────────────────
    //   原版：`if (_isMouseDown && isPlayerMove() && curTime - _mouseDownTime >= _leftClickTime)
    //            movePlayerToXY2(stage.mouseX, stage.mouseY);`
    //   本端口同语义：按下持续 ≥1 秒且本次手势没变成拖镜头/没被打断 → 人物持续走向
    //   【当前指针位置】（指针可随手移动）。_update 仅在主城场景运行（_loop 首行守卫），
    //   故天然只在非战斗的城市场景生效，等价于原版的 isPlayerMove() 门控。
    this._tickFollow();

    // 暗雷/明雷随机事件：按【行走距离】累计（用户 2026-09-30 23:05 —— 不移动不遇敌）
    //   每走 ENC_STEP_PX(100px) 掷一次 rate；单帧位移 > ENC_JUMP_PX 视为传送/归位跳变，不计入。
    this._encCooldown = Math.max(0, this._encCooldown - dt);
    if (this._encPrevX === null) {
      this._encPrevX = p.x; this._encPrevY = p.y;   // 首帧仅采样，不累加
    } else {
      const mvx = p.x - this._encPrevX, mvy = p.y - this._encPrevY;
      this._encPrevX = p.x; this._encPrevY = p.y;
      const moved = Math.hypot(mvx, mvy);
      if (moved > 0.1 && moved < ENC_JUMP_PX) this._encAcc += moved;
      // 坐标出现 NaN 时本轮不累加（_encPrev 已被污染，下一帧重新采样）
      if (!Number.isFinite(this._encPrevX) || !Number.isFinite(this._encPrevY)) {
        this._encPrevX = null; this._encPrevY = null;
      }
    }
    if (this._encCooldown <= 0 && this._encAcc >= ENC_STEP_PX) { this._encAcc = 0; this._rollEncounter(); }

    // 传送门走近自动触发（带防抖冷却）
    if (this._portalCooldown > 0) this._portalCooldown = Math.max(0, this._portalCooldown - dt);
    else if (this.portals.length) {
      for (const p of this.portals) {
        if (Math.hypot(p.x - this.player.x, p.y - this.player.y) < 44) { this._usePortal(p); break; }
      }
    }
    // 刷怪区周期重生
    if (this.spawners.length) {
      for (const sp of this.spawners) {
        sp.cooldown -= dt;
        if (sp.cooldown <= 0) { sp.cooldown = sp.respawnTime; this._spawnerRespawn(sp); }
      }
    }

    this.sm.ui.refresh && this.sm.ui.refresh();
  }

  // 长按人物跟随驱动（每帧由 _update 调用；仅主城场景会运行到此处）。
  // 对齐 AS3：GameWorld.enterFrameHandler 中 `curTime - _mouseDownTime >= _leftClickTime`
  // 成立时每帧 movePlayerToXY2(stage.mouseX, stage.mouseY)。寻路较重，不能每帧重算：
  //   ① 目标格没变 → 复用旧路径；② 路径走完且仍在跟随 → 就近重算；③ 保底 FOLLOW_RETARGET_MS 节流。
  //   状态机：_following 由「按下持续 ≥1 秒」进入，松手保持（_ptr.down 可以为 false），
  //   左/右键再次按下时由 _bindInput 退出。终点光圈由 _moveFollowMarker 每帧（+ 每次 mousemove）
  //   同步到当前光标，这里只在重算路径时兜一次光圈位置。
  _tickFollow() {
    const ptr = this._ptr;
    if (!this._following) {
      // 未进入跟随态：只有左键按下且持续超过阈值才进入（对齐 AS3 长按判定）
      if (!ptr.down) return;
      if (performance.now() - ptr.t < LONG_PRESS_MS) return;
      this._following = true;
      this._followCell = null;
      this._followRetargetT = 0;
      this._followMarkerPos = null;
      this._followLastWalkable = null;
      // 进入跟随态前可能已有短按留下的终点光圈：留着，首次重算时会把它挪到光标处
      // （对齐 AS3 addPointer 复用同一指针对象，不重建）。
    }
    // 按下点在战斗层/战斗场景时根本不会记下 ptr.down（_bindInput 守卫），此处无需再判战斗。
    const now = performance.now();
    const rect = this.viewport.getBoundingClientRect();
    const wx = ptr.x - rect.left + this.camera.x;
    const wy = ptr.y - rect.top + this.camera.y;
    const cell = MapSystem.getGridPos(wx, wy);
    const walkable = MapSystem.isWalkable(cell.col, cell.row);
    // ★ 「最后可抵达位置」：光标在可走格上时持续刷新（即使本次会被节流跳过也照记），
    //   光标进入障碍格后目标锁定到这个最后可走格（用户口径：终点停留在最后的可抵达位置）。
    //   ★ Bug 背景（user 2026-09-27 报「移动快了人物会停在中间」）：重算有 FOLLOW_RETARGET_MS
    //     节流，快划时光标扫过一串可走格但只有较早的格真正重算了路径；随后光标进入障碍格时
    //     旧实现直接 return 停掉刷新 → 目标永久停在落后的旧格 → 玩家走到旧格就停下了。
    //     修法：把「停掉刷新」的时机延后到障碍格上——用最后可走格补一次重算（绕过节流），
    //     让寻路能更新到真正的最后可抵达位置，之后再停。
    let tgtCol, tgtRow, tgtX, tgtY;
    if (walkable) {
      this._followLastWalkable = { col: cell.col, row: cell.row, x: wx, y: wy };
      tgtCol = cell.col; tgtRow = cell.row; tgtX = wx; tgtY = wy;
    } else if (this._followLastWalkable) {
      tgtCol = this._followLastWalkable.col; tgtRow = this._followLastWalkable.row;
      tgtX = this._followLastWalkable.x; tgtY = this._followLastWalkable.y;
    } else {
      // 光标从一开始就在障碍格上（从未经过可走格）：无可跟随目标，保持不动
      return;
    }
    // 节流：距上次重算不足 FOLLOW_RETARGET_MS 且目标格没变 → 跳过
    //   ★ 障碍进入时刻（walkable=false）不受节流：这是目标从「落后旧格」切换到「最后可走格」
    //     的关键一次重算，若被节流掉就又是老 bug。
    const cellKey = tgtCol + ',' + tgtRow;
    const p = this.player;
    const pathEmpty = !p.path || !p.path.length;
    if (cellKey === this._followCell && !pathEmpty) return;
    if (walkable && now - this._followRetargetT < FOLLOW_RETARGET_MS && !pathEmpty) return;
    this._followRetargetT = now;
    this._followCell = cellKey;
    this._followTarget = { x: tgtX, y: tgtY };
    // 寻路（quiet:true：光圈生命周期由本方法/_moveFollowMarker 单独控制，避免 pathfindToWorld
    //   内部重复新建）。落点障碍判定在 pathfindToWorld 内部再做一次（同源，双保险）
    this.pathfindToWorld(tgtX, tgtY, { quiet: true });
    // 终点光圈同步到当前目标（对齐 AS3 Player.setXY 每次重算都 addPointer 到当前目标点）：
    //   光圈已存在 → _moveDestMarker 直接挪过去（复用画布，无闪烁）；
    //   光圈在途（loadEffect 未返回）→ 记 _followMarkerPos，resolve 时落到最新位置；
    //   光圈不存在 → 新建一个。
    if (this._destMarker && this._destMarker.canvas) this._moveDestMarker(tgtX, tgtY);
    else { this._followMarkerPos = { x: tgtX, y: tgtY }; if (!this._destMarkerLoading) this._playDestEffect(tgtX, tgtY); }
  }

  // 退出跟随态（对齐 AS3 GameWorld.rightClick → _isMouseDown = false）：只切状态，
  // 不打断当前路径——人物仍会走完最后一段路，终点光圈在到达后由 _update 自然清除。
  // ★ 同时把当前手势作废（_ptr.down=false）：右键退出时左键可能仍被按住，若保留按下态，
  //   下一帧 _tickFollow 会因「按下且距按下>=1s」立刻重新进入跟随（Flash 不会重复派发
  //   MOUSE_DOWN，原版退出后必须松手再按才可能重新跟随——此处与之同语义）。
  _exitFollow() {
    this._following = false;
    this._ptr.down = false;
    this._followMarkerPos = null;
    // ★ 退出跟随立刻按当前指针位置刷新一次悬停光标：跟随态光标图由 _moveFollowMarker 接管，
    //   退出后若鼠标不动（如右键退出），自绘光标会残留在最后的 nopass 态上。
    if (this.sm.current === this && this._ptr && this._ptr.x !== undefined) {
      this._hoverT = 0;
      this._updateHover(this._ptr.x, this._ptr.y);
    }
  }

  // 跟随态：把终点光圈挪到当前光标位置（anchorOrigin，与点击落点同一套定位）。
  //   路径重算仍由 _tickFollow 按目标格变化节流，这里只动动画。
  //   ★ 每次 mousemove/touchmove 调用一次（即时响应），_update 每帧再调一次（与摄像机
  //     插值后的最终坐标同帧计算，消除「大幅移动指针时动画落后于实际指针」的帧差）。
  //   ★ 光标压在障碍格上时不挪——光圈停在最后一个可寻路位置（与 _tickFollow 同口径）。
  _moveFollowMarker() {
    // ★ 场景守卫：本方法由 window 级 mousemove/touchmove 驱动，战斗场景下仍会被调用；
    //   战斗中不需要跟随光圈/光标态切换（nopass 会穿透到战斗层），直接返回。
    if (this.sm.current !== this) return;
    if (!this.actorLayer) return;
    const rect = this.viewport.getBoundingClientRect();
    const wx = this._ptr.x - rect.left + this.camera.x;
    const wy = this._ptr.y - rect.top + this.camera.y;
    const c = MapSystem.getGridPos(wx, wy);
    const walkable = MapSystem.isWalkable(c.col, c.row);
    // ★ 跟随态自绘光标（用户：跟随态时 cursornopass 没有正常切换）：
    //   跟随态的 mousemove/touchmove 处理器调完本方法就 return、不调 _updateHover，
    //   自绘光标图一直停在进入跟随前的状态，不随落点障碍格切换。此处与 _updateHover
    //   的空地分支同源同口径（client→世界→寻路网格→isWalkable）：光标压 UI 层 → default；
    //   否则按落点格可走性 default/nopass。★ 只切这两个地面移动相关的态，战斗/对话态不在此处理。
    //   本方法有三个调用点（mousemove / touchmove / _update 每帧），一次覆盖全部。
    if (customCursor.on) {
      if (customCursor.isOverUi(this._ptr.x, this._ptr.y)) customCursor.setState('default');
      else customCursor.setState(walkable ? 'default' : 'nopass');
    }
    if (!walkable) return;
    this._followMarkerPos = { x: wx, y: wy };
    if (this._destMarker && this._destMarker.canvas) this._moveDestMarker(wx, wy);
  }

  // 按当前地图的遇敌规则掷暗雷（暗雷怪物组合加权随机），触发即进入战斗（带冷却）
  //   ★ 真源优先：地图文件 dark_encounter 区块（经 deriveFromMapInfo 派生到 this.map.darkEncounter）；
  //     本图未配时回退 config/encounters.json 的同 mapId 规则（旧规则域，编辑器仍可维护兜底规则）。
  _rollEncounter() {
    if (this.sm.current !== this) return;
    const mapId = this.map.id;
    const mapRule = (this.map.darkEncounter && (this.map.darkEncounter.darkGroup || []).length)
      ? this.map.darkEncounter : null;
    const rules = mapRule ? [mapRule] : (() => {
      const encs = Config.data.encounters || {};
      const list = Array.isArray(encs) ? encs : Object.values(encs);
      return list.filter(e => e && e.mapId == mapId);
    })();
    if (!rules.length) return;
    for (const rule of rules) {
      const rate = Number(rule.rate) || 0;
      if (Math.random() >= rate) continue;
      const group = rule.darkGroup || [];
      if (!group.length) return;
      // 主怪（toast/战斗 id 用）；各敌人进场时再按同一张表【逐单位独立】抽取（_pickMob）
      const mobId = _pickDarkMob(group);
      const m = mobId ? (Config.data.monsters || {})[mobId] : null;
      if (mobId && m) {
        this._encCooldown = 3;
        // ★ 逐单位抽怪（perUnit）由 BattleScene._pickMob 按同一张表独立掷骰，遇敌提醒不准——
        //   用户裁决 2026-10-04：暗雷 toast 从代码层删除（实际生成的是混合怪群，只显示主怪名会误导）。
        // ★ darkTable/darkPick 透传怪物生成表：BattleScene._pickMob 按规则逐单位抽怪
        //   （darkPick=perUnit ⇒ 混合怪群；once ⇒ 整场沿用 mobId）
        this.sm.enterBattle({ id: 'enc_' + mapId + '_' + mobId + '_' + Date.now(), monsterId: mobId, name: m.name, type: 'monster', dark: true, darkTable: group, darkPick: rule.darkPick });
        return;
      }
    }
  }

  _updateNearest() {
    let near = null, nd = 90;
    for (const f of this.npcs) {
      const d = Math.hypot(f.x - this.player.x, f.y - this.player.y);
      if (d < nd) { nd = d; near = f; }
    }
    const hint = this.sm.layers.world.querySelector('#main-hint');
    if (near) {
      hint.textContent = near.npcData.type === 'monster'
        ? `【${near.name}】点击展开战斗`
        : `【${near.name}】点击对话`;
      hint.style.opacity = 1;
      this.nearest = near;
    } else {
      hint.textContent = '点击地面移动 · 点击怪物开战';
      hint.style.opacity = 0.7;
      this.nearest = null;
    }
  }

  // ★ AS3 交互距离口径：PanelManager.MaxDistance=150 是「走远自动关面板」的阈值；
  //   点 NPC 时距离 <= NPC_TALK_DISTANCE 直接对话，太远则寻路走近（moveToNpc 语义），进入范围自动开面板。
  static get NPC_TALK_DISTANCE() { return 130; }
  static get NPC_TALK_ARRIVE() { return 170; }   // 到达判定略宽，避免寻路落点卡在阈值边缘（旧欧氏口径，现仅探针兼容）
  // ★ 交互/到达判定统一用【曼哈顿 ≤ 150】，与 PanelManager.MaxDistance(150) 巡检同口径：
  //   旧实现用欧氏判「到达开面板」，斜向落点欧氏 125 时曼哈顿可达 176 > 150 → 开了立刻被巡检关掉
  //   （用户报「能开但自动关」，实测刘大伯旁格 (22,30)：欧氏 125 / 曼哈顿 176）。
  static get NPC_TALK_MANH() { return 150; }

  // 打开交谈面板（对话/任务/功能）。商店/治疗/仓库等功能由面板内 op29 抓包的条目本地路由；
  //   ui.openPanel 注入 npcId（= NPC 模板 id，talk.json 主键）。
  //   距离巡检：面板记录 NPC 位置，玩家走远自动关闭（Player.as:428 + SceneManager.as:1088）。
  _openTalk(f) {
    this._pendingTalk = null;
    panelManager.setCurrentPanelNpc(f);
    const n = f.npcData;
    const opts = { npcId: n.id };
    // 地图配置的闲聊文本/描述：talk.json 未覆盖的 NPC（如 无涯子）用它们兜底显示
    if (n.dialog) opts.dialog = n.dialog;
    if (n.desc) opts.desc = n.desc;
    // hub 传送（蟠龙图腾等）：交谈面板内合成「打开世界地图」功能条目（旧 ui.showDialog 已删除）
    if (n.type === 'teleport' && n.teleport_mode === 'hub') opts.hubTeleport = true;
    this.sm.ui.openPanel('talk', opts);
  }

  _interactNpc(f) {
    const n = f.npcData;
    if (n.type === 'teleport' && n.teleport_mode === 'direct' && n.target_map_id) {
      // ★ 用户要求：传送法阵点击即传送（不弹对话）。落点 = 目标图上指回的传送圈（globals 预解析 n.arrive），
      //   无配对圈则落目标图默认出生点。
      const tname = ((Config.maps || []).find(x => x.id === n.target_map_id) || {}).name || ('#' + n.target_map_id);
      this.sm.ui.toast('传送到 ' + tname);
      this.changeMap(n.target_map_id, n.arrive ? { spawnPos: n.arrive } : {});
      return;   // ★ 直传不弹交谈面板（原实现漏了 return：传送后仍会弹 talk 面板）
    }
    // hub 传送（蟠龙图腾 / 无名传送 / 待逆向）：与普通 NPC 一样走进新交谈面板，
    //   面板内提供「打开世界地图」入口（talk.js 合成条目，旧版 ui.showDialog 已删除）。
    //   其余（quest/普通 NPC）同样落到下方距离/寻路判定。

    // 距离够近：直接对话（★ 曼哈顿 ≤ NPC_TALK_MANH，与面板巡检同口径，避免「能开却被巡检关」）
    const manh = Math.abs(f.x - this.player.x) + Math.abs(f.y - this.player.y);
    if (manh <= this.constructor.NPC_TALK_MANH) { this._openTalk(f); return; }

    // 距离太远：对齐 AS3 Player.moveToNpcByXY —— 寻路到 NPC 所在格（getRoadPoint），
    //   落点取【紧邻 NPC 的一格】（AS3 原版 pop 掉 NPC 脚下格，落点 = 剩余路径末端）。
    //   ★ 落点距 NPC 仅 1 格（曼哈顿 ≈ 96px），远小于面板巡检阈值 MaxDistance=150：
    //     旧实现落点在 NPC 周围 130~190px 的环上，斜向时曼哈顿可达 184+，
    //     _tickTalkArrive 判「到达」开了面板，面板巡检却判「太远」立刻关掉（用户报「打开后立即关掉」）。
    //   ★ AS3 无「双击强制打开」：走的过程中点别的 NPC 只是覆盖目标重新寻路，永远等走到位再开面板。
    //     （旧的 600ms 双击强开会在「已到达 A 后双击远处的 B」时强行打开 B 面板，随即被巡检关闭，已移除。）
    const npcCell = MapSystem.getGridPos(f.x, f.y);
    const myCell = MapSystem.getGridPos(this.player.x, this.player.y);
    let placed = false;
    let walkTx = 0, walkTy = 0;   // 命中的落点（循环外要用：挪终点光圈）
    // ① NPC 格本身可走 ⇒ 直接寻到 NPC 格，去掉 NPC 脚下点后末端即落点（AS3 原口径）
    // ② NPC 格阻挡 ⇒ 对其等距 8 邻域里的可走邻居逐个寻路，取最短路径的邻居作落点
    let raw = AStar.findPath(myCell.col, myCell.row, npcCell.col, npcCell.row);
    if (raw.length > 1) {
      raw = raw.slice(0, -1);                    // 去掉 NPC 脚下点
    } else {
      let best = null, bestLen = Infinity;
      for (const nb of AStar.getArounds(npcCell.col, npcCell.row)) {
        const p = AStar.findPath(myCell.col, myCell.row, nb[0], nb[1]);
        if (p.length > 1 && p.length < bestLen) { best = p; bestLen = p.length; }
      }
      raw = best || [];
    }
    if (raw.length > 1) {
      const last = raw[raw.length - 1];
      walkTx = last.x; walkTy = last.y;          // findPath 返回格心像素，落点天然精确
      const path = AStar.optimizePath(raw);
      path[path.length - 1] = { x: walkTx, y: walkTy };
      path.shift();                              // 去掉起点格（同 pathfindToWorld 口径）
      this.player.path = path;
      this._cancelMoveToCenter();                // 新寻路取消到点归中（同 pathfindToWorld 口径）
      this._pathStartCamX = this.camera.x;       // 记录镜头起点（同 pathfindToWorld 口径）
      this._pathStartCamY = this.camera.y;
      placed = path.length > 0;
    }
    if (!placed && Math.abs(f.x - this.player.x) + Math.abs(f.y - this.player.y) <= this.constructor.NPC_TALK_MANH) {
      this._openTalk(f);   // 寻路过短/失败但已在身边：直接对话（对齐 AS3 路径长度<=2 立即 sendClickNpc）
      return;
    }
    if (placed) {
      this._pendingTalk = f;
      // ★ 目标是 NPC：终点光圈语义不再适用（那是「点地」的落点指示），直接清掉，
      //   不要把光圈挪到 NPC 身前（用户要求：点 NPC 时不要出现终点动画）。
      this._clearDestMarker();
      const hint = this.sm.layers.world.querySelector('#main-hint');
      if (hint) { hint.textContent = '走向【' + (n.name || 'NPC') + '】…'; hint.style.opacity = 1; }
      return;
    }
    // 完全走不到（被障碍围住）：原地对话，不卡玩家
    this._pendingTalk = null;
    this._openTalk(f);
  }

  // 主循环每帧调用：走向 NPC 的寻路走完且进入范围 ⇒ 自动打开交谈面板（对齐 AS3 moveToNpc）。
  _tickTalkArrive() {
    const f = this._pendingTalk;
    if (!f || !f.npcData || !this.player) return;
    if (!this.npcs.includes(f)) { this._pendingTalk = null; return; }   // 切图 / NPC 已移除
    if (this.player.path && this.player.path.length > 0) return;        // 还在走
    const d = Math.abs(f.x - this.player.x) + Math.abs(f.y - this.player.y);   // 曼哈顿，与巡检同口径
    if (d <= this.constructor.NPC_TALK_MANH) { this._openTalk(f); return; }
    // 路走完了仍不在范围内（被障碍卡住 / 玩家手动改道）：取消自动对话
    this._pendingTalk = null;
  }

  _startBattle(f) {
    if (this._inBattle) return;
    this._inBattle = true;
    this.sm.enterBattle(f.npcData);
    setTimeout(() => { this._inBattle = false; }, 50);
  }

  // 战斗结束后恢复主城：玩家立绘已移回 actor 层，这里仅重启渲染循环并把镜头对回玩家
  _resume() {
    this.target = null;
    // 清除战斗/切窗期间残留的按键状态（否则 keys['w'] 等残留会让角色恢复后持续
    // 漂移且无行走动画——_update 的"按键直移"分支不调 p.walk()），见 _clearKeys 注释。
    this._clearKeys();
    // 按下态一并复位：战斗中点指令按钮会把 _ptr.down 置上（战斗层在 viewport 内、事件冒泡），
    // 若不复位，回城后首次松手会走点击移动分支。
    this._downFighter = null;
    // 长按跟随态同样作废：战前若正在跟随，进战打断后手势语义已失效（按钮可能仍被按住），
    // 不复位会在回城瞬间继续驱动寻路。
    this._ptr.down = false; this._following = false;
    // 续走战前未走完的寻路（点击移动命令不被"全取消"误伤）：仅当角色回到战斗爆发点（胜/逃）才续，
    // 战败被传到复活点则不续（避免从复活点往旧路径走）。无战前路径则照常清空。
    if (this.player) {
      const savedPath = this.sm._preBattlePath;
      const savedPos  = this.sm._preBattlePos;
      this.sm._preBattlePath = null; this.sm._preBattlePos = null;
      const backHome = savedPos && Math.abs(this.player.x - savedPos.x) < 0.5 && Math.abs(this.player.y - savedPos.y) < 0.5;
      if (savedPath && savedPath.length && backHome) {
        this.player.path = savedPath;
        const end = savedPath[savedPath.length - 1];
        this._clearDestMarker();
        this._playDestEffect(end.x, end.y);
      } else {
        this.player.path = [];
        this._clearDestMarker();
      }
      this.player.stand();
    }
    // 统一走 _scheduleLoop()：自带"同一时刻仅一条在飞"守卫，
    // 避免与 enter()/\_loop 末尾的续帧叠加出多条循环链。
    this._scheduleLoop();
    this._centerCameraOn(this.player.x, this.player.y);
    // ★ 战斗中触发的任务显隐（如杀完蜃龙同格换门）在 BattleScene 里只记账不应用
    //   （_applyQuestGate 的 map 守卫不匹配战斗场景）；回城瞬间补刷一次本图门控实体，
    //   否则门要等切图才换（用户 bug④）。_refreshQuestGates 只动本图、幂等，无副作用。
    try { this._refreshQuestGates(); } catch (e) { console.warn('[scene] 回城刷任务门控失败', e); }
  }

  destroy() {
    // 玩家是常驻实例（跨场景复用，sm.player 持有引用）：仅摘离舞台，绝不销毁/不入池
    // （原版此处 a.destroy() 会误伤玩家立绘；现改为只摘离 el，enter 时重新 appendChild + stand 即可复用）。
    for (const a of this.actors) {
      if (a === this.player) {
        if (a.el && a.el.parentNode) a.el.parentNode.removeChild(a.el);
        continue;
      }
      // 可池化单位（地图 NPC：_poolable 由 RolePool.acquire 标记）回收到对象池，保留 DOM 复用；
      // 不可池化/无池的临时单位走 destroy 彻底释放。
      if (a._poolable && RolePool) RolePool.release(a);
      else if (typeof a.destroy === 'function') a.destroy();
    }
    this.actors = []; this.npcs = [];
    if (this.marks) this.marks.destroy();   // 场景销毁：停全部标记 Timer 并摘全局引用
  }
}

// ───────────────────────── 战斗场景（对齐 BattleScene.as） ─────────────────────────
class BattleScene {
  // 战场站位（移植 CharacterManager.getFightPoint）：我方 0-9（右）、敌方 10-19（左），各 前排5+后排5=10。
  // 设计坐标在 800×600 逻辑空间；s 随实时舞台尺寸缩放（去掉原 1 的上限），屏幕越大间距越大、越小越收拢。
  static FP = {
    playerX: 457, playerY: 502,            // 我方前排锚点（右）
    enemyX: 136, enemyY: 367,             // 敌方前排锚点（左）
    hStep: 62, vStep: 37,                 // 相邻站位步距（横/纵）
    outerDX: -71, outerDY: -75,           // 后排相对前排偏移
    scale: 1                               // 阵型整体缩放（与屏幕自适应 s 叠加；=1 不变）
  };
  // 站位映射（10/10 对称、线性列排）：前排 value 0-4（敌方 e 0-4）自锚点向右下展开，
  // 后排 5-9（敌方 10-14）加 outer 偏移继续向右下展开；距离随屏缩放（无上限）。
  static getFightPoint(value) {
    const F = BattleScene.FP;
    let x, y;
    if (value <= 9) {                       // 我方（右侧）
      if (value <= 4) { x = F.playerX + value * F.hStep;            y = F.playerY - value * F.vStep; }
      else            { const r = value - 5; x = F.playerX + F.outerDX + r * F.hStep; y = F.playerY + F.outerDY - r * F.vStep; }
    } else {                                // 敌方（左侧）
      const e = value - 10;
      if (e <= 4)      { x = F.enemyX + e * F.hStep;            y = F.enemyY - e * F.vStep; }
      else             { const r = e - 5;   x = F.enemyX + F.outerDX + r * F.hStep; y = F.enemyY + F.outerDY - r * F.vStep; }
    }
    const M = 24;                           // 设计画布安全边距：仅最外单位出血时收拢
    if (x < M) x = M; else if (x > 800 - M) x = 800 - M;
    const stage = (typeof document !== 'undefined') ? document.querySelector('.battle-stage') : null;
    const W = stage ? stage.clientWidth : 800;
    const H = stage ? stage.clientHeight : 600;
    const s = Math.min(W / 800, H / 600) * (F.scale || 1);   // 距离随屏幕缩放（无上限）× 阵型整体缩放 F.scale（默认1，不变）
    const cx = W / 2, cy = H / 2;
    return { x: cx + (x - 400) * s, y: cy + (y - 300) * s };
  }

  constructor(sm, monsterNpc, dungeonDef) {
    this.sm = sm;
    this.player = sm.player;
    this.monsterNpc = monsterNpc;
    this.dungeon = dungeonDef || null;
    this.busy = false;
    this.round = 1;
    this._dmgDealt = 0;   // 本场累计「我方对敌」真实伤害（供战报统计，零臆造）
    this._dmgTaken = 0;   // 本场累计「敌方对我方」真实伤害
    // 自动战斗：默认关，但读取设置面板「自动战斗」开关 → 兑现 UI 承诺"下一场战斗生效"（战斗内「自动」指令仍可在本场随时切换）
    this.auto = !!(this.sm.ui._settings && this.sm.ui._settings.autoBattle);
    this.battleState = B.ATTACK;
    this.pendingSkill = null;
    this.defending = false;
    this.raging = false;     // 爆气状态（对齐 BATTLE_BAOQI：临时大幅提升攻击，战斗结束随场景销毁自动复位）
    this.allies = [];        // 召唤兽 ally Fighter 列表（对齐 addSummonAnimate：玩家侧共占 0-9 战斗点）
    this.summonedPet = null; // 当前已召唤宠物 petId（对齐 PropertyManager 写 battleManager.petId）
    this.catching = false;   // 捕捉选目标模式（对齐 BATTLE_CATCH → sendBattleCatch 前的 CATCH_SELECT 提示态）
    this.SCALE = 1;          // 战斗精灵缩放：与主城 NPC 同款全尺寸（fanvas 统一原点扩展，SCALE=1 即原始尺寸），避免战斗模型比主城小
    // 多敌 / 副本波次 / AI 召唤（对齐 Request C 真实可用）
    this.enemies = [];        // 当前存活敌方 Fighter 列表（eFig 为首个=玩家点击目标）
    this.waveQueue = [];      // 副本待生成波次 [{mob,count}]
    this.dungeon = null;      // 当前副本配置（dungeons 域）
    this._aiSummoned = false; // AI 是否已召唤过小怪（每战一次）
    this._bHovered = null;    // 当前悬停高亮的战斗单位（对齐 MainScene._hovered，NPC 同款 .fighter.hovered 高亮）
    this.chatBubbles = new ChatBubbleManager(null);   // 战斗内头顶气泡（开场挑衅语/技能名；enter() 里 setLayer 到场景级 .battle-chatLayer）
  }

  async enter() {
    const W = this.sm.layers.world;
    // 冻结恢复用：记录玩家在主城的世界坐标与朝向（进入战斗前 setPos 会被改写为战斗坐标）
    this._restorePos = { x: this.player.x, y: this.player.y, dir: this.player.dir };
    let battle = W.querySelector('#battle-layer');
    if (!battle) {
      battle = document.createElement('div');
      battle.id = 'battle-layer';
      W.querySelector('#viewport').appendChild(battle);
    }
    this.battle = battle;
    battle.classList.remove('hidden');
    // 真实客户端战斗资源（i18n/zh_CN/Resource1/icons）：背景 + 指令条面板 + 指令按钮（含悬停态）+ 技能按钮
    // 资源名严格走 AS getLinkName 规则（大写转小写、去下划线）：battle_background→battlebackground.png、
    //   battle_btn_bg→battlebtnbg.png（89×350 指令条竖条，对齐 AS3 BattlePanel.addChild(getResourceImg("battle_btn_bg"))）、
    //   battle_btn_bg_roll→battlebtnbgroll.png（52×34 按钮皮，对齐 AS3 AutoButton 第4参）、battle_skill→battleskill.png
    battle.style.setProperty('--battle-bg-img', `url("${absUrl(url.res1(getLinkName('battle_background')))}")`);
    battle.style.setProperty('--battle-panel-bg', `url("${absUrl(url.res1(getLinkName('battle_btn_bg')))}")`);
    battle.style.setProperty('--battle-btn-bg', 'none');  // 默认态(未悬停)：不挂按钮皮肤，仅 text_battle_* 文字图；悬停才由 CSS :hover 切 battlebtnbgroll.png
    battle.style.setProperty('--battle-btn-bg-roll', `url("${absUrl(url.res1(getLinkName('battle_btn_bg_roll')))}")`);
    battle.style.setProperty('--battle-btn-skill', `url("${absUrl(url.res1(getLinkName('battle_skill')))}")`);
    // 分层严格对齐 AS3 BattleScene.as 的 addChild 顺序：
    //   holySoulLayerDown → characterLayer → holySoulLayerUp → (nameLayer/hpbarLayer 由 Fighter 自带)
    //   → chatLayer → battleStateLayer(回合/倒计时) → areaSkillLayer → skillNameLayer
    //   → numberLayer(飘字) → perfectLayer → panelLayer(指令条)
    //   （AS3 另有 battleTutor = face.tutor.BattleTutor 新手引导箭头，Web 端不实现）
    // 分层严格对齐 AS3 BattleScene.as 的 addChild 顺序（见上）。
    // 注意：.battle-bg 必须是 #battle-layer 的直接子节点（与 .battle-stage 同级），
    // 这样 .battle-stage.pre 初始隐藏期间背景画布仍可累积（世界透出），待累积完成再让舞台出现。
    battle.innerHTML = `
      <div class="battle-stage pre">
        <div class="battle-holySoulDown"></div>
        <div class="battle-characterLayer"></div>
        <div class="battle-holySoulUp"></div>
        <div class="battle-state">
          <div class="battle-round"></div>
          <div class="battle-timer"></div>
        </div>
        <div class="battle-orderbar"></div>
        <div class="battle-areaSkill"></div>
        <div class="battle-skillName"></div>
        <div class="battle-numberLayer"></div>
        <div class="battle-chatLayer"></div>
        <div class="battle-perfect"></div>
        <div class="battle-cmd"></div>
        <div class="battle-bottomPrompt"></div>
        <button class="battle-skip">跳过战斗</button>
        <button class="battle-escape">逃跑</button>
      </div>
      <canvas class="battle-bg"></canvas>`;
    this.characterLayer = battle.querySelector('.battle-characterLayer');
    this.numberLayer    = battle.querySelector('.battle-numberLayer');
    this.skillNameLayer = battle.querySelector('.battle-skillName');
    this.chatLayer      = battle.querySelector('.battle-chatLayer');   // 头顶聊天气泡场景级层(z:70，高于技能横幅/飘字)
    if (this.chatBubbles) this.chatBubbles.setLayer(this.chatLayer);   // 进战：气泡切到场景级层（自带回逐帧跟随）
    this.stateLayer     = battle.querySelector('.battle-state');
    this.roundEl        = battle.querySelector('.battle-round');
    this.timerEl        = battle.querySelector('.battle-timer');
    this.areaSkillLayer = battle.querySelector('.battle-areaSkill');
    this.orderBar      = battle.querySelector('.battle-orderbar');   // 出手顺序条（头像按速度排序）
    this.perfectLayer   = battle.querySelector('.battle-perfect');
    // 底部系统提示（选目标态文案载体，对齐 PromptFace._bottomPrompt 的独立实例）
    this.bottomPromptEl = battle.querySelector('.battle-bottomPrompt');
    this.cmd            = battle.querySelector('.battle-cmd');
    this.battleStage    = battle.querySelector('.battle-stage');
    this.battleBg       = battle.querySelector('.battle-bg');
    // 预加载战斗飘字数字图片（30 张小图，记录自然尺寸以精确计算拼接宽度与堆叠行高）
    preloadBattleNumbers();

    // 站位管理器：先计算友方/敌方出场战斗点（对齐 AS3 抓包：玩家固定 2 / 宠物 7；怪物从后排中心 17
    //   开始向两侧扩展，排满后排再上前排中心 12；友方角色占前排中轴 2→1,3→0,4，
    //   宠物在另一排（后排）中轴 7→6,8→5,9，与人物不同排 —— 用户裁决 2026-09-30 23:05）
    const members = (this.sm.ui._team || []).filter(m => m && (m.kind === 'bot' || m.kind === 'npc'));
    const hasPet = !!(this.sm.ui._activePet || (this.sm.ui._pets || []).some(p => p.state === 1));
    // ★ 暗雷怪物数量按队伍【人数】调整：人数 ~ 人数×2（宠物不计入；1 人 1-2 只、5 人 5-10 只）。
    //   明雷/副本沿用配置的 count（如 野猫群×3、木桩×10）。
    let enemyCount;
    if (this.monsterNpc.dark) enemyCount = darkEncounterCount(1 + members.length);
    else enemyCount = Math.max(1, this.monsterNpc.count || 1);
    this._enemyTotal = enemyCount;   // 供 _spawnEnemy 给变异怪按总数均分色相（每只用不同颜色）
    this._foeFormation = buildFormation('enemy', { chars: enemyCount, pets: 0 });
    this._foeUsed = new Set();
    this._allyFormation = buildFormation('friendly', { chars: 1 + members.length, pets: hasPet ? 1 : 0 });
    // 宠物站位：【另一排中轴扩展】（用户裁决 2026-09-30 23:05）——人物占前排中轴 2→1,3→0,4，
    //   宠物占后排中轴 7→6,8→5,9（7 = 玩家 2 的正后方，对齐 AS3 petPid = pid + 5）。
    //   1 人 1 宠 = 宠物 7；5 人 5 宠 = 前排全人 + 后排全宠。
    //   hasPet=false 时 pets 为空，用手动召唤的统一兜底（_freePlayerBand 走 nextFreeSlot）。
    this._petBand = (this._allyFormation.pets && this._allyFormation.pets[0] != null)
      ? this._allyFormation.pets[0] : nextFreeSlot('friendly', new Set([this._allyFormation.lead].concat(this._allyFormation.members)));

    // 玩家（复用主城 Fighter，移入战斗角色层，右下方站位）
    this.pFig = this.player;
    this._ctrl = null;          // 当前操控对象：null=玩家(pFig)，否则为某个友方单位(宠物)
    this._unitResolve = null;   // 宠物回合等待玩家下令的 resolver
    this.pFig.battleScale = this.SCALE;   // 战斗内统一缩放：stand/attack/cast/hurt/down 都走此值，锚点只测一次（修复点击偏移/缩小）
    this.pFig.showBars = true; this.pFig.hpBar.style.display = 'block';
    this.pFig.hpAbove = true;             // 战斗内血条浮于头顶上方（与主城 NPC 同款像素检测，仅位置不同）
    this.characterLayer.appendChild(this.pFig.el);
    const pp = BattleScene.getFightPoint(this._allyFormation.lead);   // 主角固定战斗点（友方 1 人→2，对齐站位管理器）
    this.pFig.setPos(pp.x, pp.y);
    this.pFig._band = this._allyFormation.lead;   // 记录主角战斗点（0-9），供十字/矩形等按站位范围判定（如沉水润心治疗十字）
    this.pFig._home = { x: pp.x, y: pp.y };   // 记录出生战斗点，攻击后归位
    this.pFig.dir = 'left';
    // ★ 骑宠层在战斗中隐藏（骑宠只在主城有效）：人物也回到普通战斗动作（act 的 ride 标志随 _rideVisible）
    if (typeof this.pFig.setRideVisible === 'function') this.pFig.setRideVisible(false);
    await this._stand(this.pFig);

    // 进战只保留地图层：隐藏主城 actor 层（NPC/其他玩家）与主城提示，避免底层 NPC 透出战斗舞台
    // （对齐 AS3 BattleScene.paint()：paintNumber==0 仅保留地图层，叠加 battle_background 后作为新背景使用）
    const _main = this.sm._main;
    this._mainActorLayer = _main && _main.actorLayer;
    this._mainHint = _main && _main.viewport ? _main.viewport.querySelector('#main-hint') : null;
    if (this._mainActorLayer) this._mainActorLayer.style.display = 'none';
    if (this._mainHint) this._mainHint.style.display = 'none';

    // 敌方（按 monster 模板造 Fighter，左侧站位；明雷怪 count>1 时一次涌出多只；暗雷按队伍人数涌出 1-10 只，
    //   战斗点由站位管理器分配：从后排中心 17 起中心扩展，符合 AS3 原版抓包规律）
    this.eFig = null;
    this.aFig = null;   // 玩家侧（己方/宠物）选中目标，供 ally/enemyOrAlly 技能点选施放
    this._downedAllies = [];   // 墓园：已阵亡被移出 allies 的友方（供「复活」类技能点选施放）
    for (let ei = 0; ei < enemyCount; ei++) {
      const mid = this._pickMob(ei);
      const slot = this._nextFoeSlot();   // 敌方出场战斗点（10-19，站位管理器分配）
      const pt = BattleScene.getFightPoint(slot);
      const fig = await this._spawnEnemy(mid, this.monsterNpc.id + '_' + ei, pt, slot);
      if (ei === 0) this.eFig = fig;                  // 首个敌人作为默认点选目标
    }
    // 若由副本发起，预填波次队列（首个敌人已生成，余下波次在其死亡后陆续进场）
    if (this.dungeon && this.dungeon.waves && this.dungeon.waves.length) {
      this.waveQueue = this.dungeon.waves.slice(1).map(w => ({ mob: w.mob, count: w.count || 1 }));
    }

    // 队伍成员联动：队伍中每个成员（机器人 kind:'bot' 与 NPC 好友 kind:'npc'）均作为玩家侧自动参战单位，
    // 随队伍人数变多而"补位"进场（对齐"队伍越强战斗人员越多"）。战斗点由站位管理器分配（主角占 lead、成员占 members、宠物占 pets 补充排）。
    const memberSlots = this._allyFormation.members;
    let mi = 0;
    for (const m of members) {
      if (mi >= memberSlots.length) { this.mLog('队伍成员过多，仅前 ' + memberSlots.length + ' 名参战（其余为后备）'); break; }
      this._spawnBotAlly(m, memberSlots[mi]); mi++;
    }
    // 出战宠物优先占前排中心（玩家 2 旁的 1；队员补剩余中心扩展位），避免与成员/主角站位重叠
    this._autoSummonActivePet(this._petBand);

    // 点击敌人 → 像素级命中选择 + 派发当前战斗指令（对齐 BattleScene.mouseDownHandler + clickCharacter）。
    // 用 battleStage 统一监听 + 像素命中，避免 512 画板互相覆盖导致点到相邻角色（见 _handleBattleClick / _hitTestEnemy）。
    this._onBattleClick = (e) => this._handleBattleClick(e);
    this.battleStage.addEventListener('click', this._onBattleClick);

    // 右键「取消操作」（★ AS3 提示文案 CATCH_SELECT lang[30051] 明写「右键取消操作」）：
    //   取消当前的选目标态（捕捉/技能/道具）并退回默认「普通攻击」态。
    //   ⚠ 必须 preventDefault：否则浏览器右键菜单会盖住战斗舞台、且 oncontextmenu 在部分环境下触发两次。
    this._onBattleCancel = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      this._cancelTargetSelect();
    };
    this.battleStage.addEventListener('contextmenu', this._onBattleCancel);

    // 跳过 / 逃跑 按钮（对齐 showSkipBattleBtn / showEscapeBattleBtn）
    battle.querySelector('.battle-skip').onclick = () => this._skip();
    battle.querySelector('.battle-escape').onclick = () => this._flee(true);

    // 战斗角色悬停高亮（对齐主城 NPC .fighter.hovered：drop-shadow 发光 + 名字变色）。
    // 监听战斗舞台 mousemove，对存活敌方/我方单位做像素命中，命中的 .fighter 加 .hovered（与 NPC 同款 CSS）；
    // 鼠标移出舞台清除。玩家自身不触发（对齐 MainScene 跳过 this.player）。退出时于 _end 清理监听。
    this._onBattleHover = (e) => this._updateBattleHover(e.clientX, e.clientY);
    this._onBattleHoverLeave = () => {
      if (this._bHovered) { this._bHovered.el.classList.remove('hovered'); this._bHovered = null; }
      if (this.battleStage) this.battleStage.style.cursor = '';
    };
    this.battleStage.addEventListener('mousemove', this._onBattleHover);
    this.battleStage.addEventListener('mouseleave', this._onBattleHoverLeave);

    // 取真实怪物数据（用于遭遇提示，与 _spawnEnemy 同源 GET_MONSTER，杜绝未定义变量 / 臆造）
    // ★ 等级由 GET_MONSTER 按模板类型决定（资质型恒 1 / 数值配置型取模板等级），调用方不再传 level
    let m = { name: this.monsterNpc.name || '敌人', level: 1 };
    try {
      const _mr = await requestCommand(CMD.GET_MONSTER, { monsterId: this.monsterNpc.monsterId });
      if (_mr && _mr.monster) m = _mr.monster;
    } catch (e) { /* 取数失败则用 npc 兜底名，不阻断进场 */ }

    // 战斗背景多层透明叠加动画（严格参考 BattleScene.as paint()/paintBackGround()：
    // 每一步以"上一步累积结果"为底再 drawImage(battle_background) 且 alphaMultiplier=0.05，反复 20 次）。
    // 完成后移除 .pre 让 .battle-stage 出现（对齐 AS3 canvasBitmap.visible=true 的舞台出现动画）。
    await this._paintBackGround();
    this.battleStage.classList.remove('pre');

    this._showRound();
    this.mLog('遭遇 ' + m.name + '（Lv.' + m.level + '）！');
    this._buildCommandBar();
    // ★ 对齐 AS3 startBattle：进战即移除指令条（UtilUpdater.removeChild(panelLayer, battlePanel)），
    //   待轮到玩家单位时由 _playerUnitAct → _setBattleHud('cmd') 显示（= AS3 showPlayerOrPet）。
    //   初始态 'act'：技能栏保持显示但盖遮罩（AS3 startRound 的 setAllMask(true)）。
    this._setBattleHud('act');
    this._startBattleLoop();   // 改为按速度先攻制：全部单位排行动队列，轮到谁谁行动
    this._monsterTaunt();      // 开场挑衅（台词真源 = chars.json 的 char.taunt，net.js 已注入 fig）
  }



  // 开场挑衅语：台词真源 = chars.json 的 char 记录（taunt 台词数组 + tauntRate），
  //   net.js GET_MONSTER 已注入 m.taunt/tauntRate，_spawnEnemy 再挂到 fig 上。
  //   ★ 每个敌人【各自独立】掷自己的 rate（混合怪群时代，不同怪的挑衅词互不干涉）：
  //     命中则随机取一句，错峰 350ms 冒泡（同时多只也不刷屏）；rate=1 为必定挑衅。
  //     未配置 taunt/未命中 ⇒ 该单位静默。复用战斗内头顶气泡（chatBubbles.speak，场景级层随单位移动）。
  _monsterTaunt() {
    if (!this.chatBubbles || !Array.isArray(this.enemies)) return;
    let stagger = 0;
    for (const e of this.enemies) {
      if (!e || e._down || e._monsterId == null) continue;
      const lines = Array.isArray(e.taunt)
        ? e.taunt.filter(s => typeof s === 'string' && s.trim()) : null;
      if (!lines || !lines.length) continue;
      const r = Number(e.tauntRate);
      const rate = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
      if (Math.random() >= rate) continue;   // 该单位未命中：继续下一个单位
      const line = lines[Math.floor(Math.random() * lines.length)];
      const delay = 500 + stagger;            // 多只挑衅怪错峰，避免同时刷屏
      stagger += 350;
      setTimeout(() => {
        // 延迟 500ms 等「战斗开始」演出落定；期间怪已倒/已退场则不冒泡
        if (!this.enemies || this.enemies.indexOf(e) === -1 || e._down) return;
        this.chatBubbles.speak(e, line);
      }, delay);
    }
  }

  // 以战斗缩放播放站立（避免 scale 被主城默认覆盖）
  _stand(fig) { return fig.act(ACTION.STAND, fig.dir, { scale: this.SCALE }); }  _act(fig, base) { return fig.act(base, fig.dir, { scale: this.SCALE }); }

  // 等待普通攻击挥击动画完整播放：playChar 在画布挂载完成后即 resolve，并不等动画播完，
  // 若直接 await atkP 会瞬间返回、紧接着的 _retreat（WALK）会立刻覆盖掉攻击挥击 → 看起来"没攻击动画、只是走过去又走回来"。
  // atkP 为 fig.act(ACTION.ATTACK, …, {loop:false, freezeLast:true}) 的 promise；挂载完成后 fig._fanvasFrames 即为攻击动画帧数，
  // 据此按帧率补等真实时长，让挥击先完整显示再归位。
  async _awaitAttack(fig, atkP) {
    await atkP;                                       // 等画布挂载完成（此时 _fanvasFrames 已是攻击动画帧数）
    const fr = fig._fanvasFrames || 1;
    const rt = fig._fanvasFrameRate || 25;
    const dur = (fr / rt) * 1000;
    if (dur > 0) await this._wait(dur);              // 让挥击真正显示出来再归位
  }

  // 攻击者走向目标附近（播放 walk），用于普通攻击/协同攻击/敌方反击的"先移动再攻击"——对齐 AS3 角色先位移再出手
  async _approach(fig, target) {
    if (this._ending || this._ended) return;             // ★ 战斗已收尾：不再走位
    const home = { x: fig.x, y: fig.y };
    fig._home = home;
    // ★ 站位偏移以【目标】为准（走到目标【正面】= 真正面对面），而非以攻击者自身 side 为准。
    //   旧写法 `tx = target.x + (fig.side==='player' ? 48 : -48)` 用攻击者 side 决定偏移：
    //   混乱后敌方去打另一个敌方时 fig.side 仍是 'enemy' → tx=目标.x-48（落在目标左侧/身后）→ 绕后打。
    //   改为用【目标】的 side 决定：敌方(target.side='enemy')正面在右 → 站 目标.x+48；玩家正面在左 → 站 目标.x-48。
    //   这样无论谁打谁（含混乱同阵营互打）都站在目标正面、与 target 相对而立（用户："走到目标正面再打/真正面对面站位"）。
    const tx = target.x + (target.side === 'enemy' ? 48 : -48);   // 朝目标【正面】一侧偏移，避免与模型重叠
    const ty = target.y;
    // 朝向同样以【目标】为准：终点在目标左侧→攻击者落在目标左侧、面朝左(LT)；反之面朝右(RB)。
    // 与上面的"正面站位"配合 → 移动/出手均【面对面】。
    const dir = target.x < tx ? 'left' : 'right';               // 移动/出手均【面向目标】
    fig.dir = dir;
    await fig.act(ACTION.WALK, dir, { scale: this.SCALE });
    await fig.moveTo(tx, ty);
    if (this._ending || this._ended) return;              // ★ await 期间战斗可能已结束：不再继续（否则会接 _retreat 发起新位移）
    await fig.act(ACTION.STAND, dir, { scale: this.SCALE });
  }
  // 攻击结束后归位到出生战斗点
  async _retreat(fig) {
    // ★ 已倒下的单位（如被"受击反伤"致死的攻击者）不再归位：否则死体会播移动动画而非倒地动画，
    //   表现为"怪物死了却还在走/原地移动"。死亡演出由 onDeath→_onEnemyDown→down() 在【原地】播放。
    if (fig._down) return;
    // ★ 战斗已收尾时【绝不】发起归位位移：这是"回城后被拉回战斗爆发点"的直接元凶。
    //   代际只能打断在飞的 moveTo；被打断的 _approach 会继续往下跑到这里，
    //   而这里的 moveTo 是全新调用（捕获新代际，守卫无效）→ 必须在此显式拦下。
    if (this._ending || this._ended) return;
    const home = fig._home || { x: fig.x, y: fig.y };
    // 归位途中面向"家"方向（朝移动方向走，符合直觉）；但玩家侧 home 在右、敌方 home 在左，
    // 仅看 home.x<fig.x 会让玩家侧 ally 归位后朝右（背离左方敌人），违反"敌我相对"。
    const moveDir = home.x < fig.x ? 'left' : 'right';
    fig.dir = moveDir;
    await fig.act(ACTION.WALK, moveDir, { scale: this.SCALE });
    await fig.moveTo(home.x, home.y);
    // 归位后恢复 idle 相对朝向（等待期/非移动期敌我相对）：玩家侧(右)朝 left 面向左方敌人；敌方(左)朝 right 面向右方玩家。
    // 对齐 AS3 战斗静止态：等待指令时双方相向而立，移动出手后才暂转移动方向、收招归位再转回相对。
    const idleDir = fig.side === 'player' ? 'left' : 'right';
    fig.dir = idleDir;
    await fig.act(ACTION.STAND, idleDir, { scale: this.SCALE });
  }

  // 战斗背景多层透明叠加（严格对齐 AS3 BattleScene.as paint()/paintBackGround()）
  //   AS3：paintNumber<20 时 colorTransform.alphaMultiplier=0.05，反复 canvasBmpData.draw(_background)；
  //   每一步都把"上一帧累积结果"当作底，再叠一层 battle_background（透明叠加），直至约 64% 覆盖，
  //   随后 canvasBitmap.visible=true（舞台出现）。
  //   本移植：世界由主城实时渲染在 #battle-layer 之下透出，故画布只承载累积的 battle_background，
  //   每帧以 globalAlpha=0.05 反复 drawImage 同一张离屏图（画布既有内容即"上一步结果"）。
  _paintBackGround() {
    return new Promise((resolve) => {
      const cv = this.battleBg;
      const stage = this.battleStage;
      if (!cv || !stage) { resolve(); return; }
      const W = stage.clientWidth || (typeof window !== 'undefined' ? (window.innerWidth - SIDEBAR_W()) : 800);
      const H = stage.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600);
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      if (!ctx) { resolve(); return; }
      ctx.clearRect(0, 0, W, H);
      const STEP = 20, ALPHA = 0.05;          // 对齐 AS3：20 步 × 0.05
      const raf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      const img = new Image();
      const finish = () => { ctx.globalAlpha = 1; resolve(); };
      img.onload = () => {
        let n = 0;
        const tick = () => {
          ctx.globalAlpha = ALPHA;
          // 以"上一步累积结果"为底，再叠加一层 battle_background（透明叠加）
          ctx.drawImage(img, 0, 0, W, H);
          if (++n < STEP) raf(tick);
          else finish();
        };
        raf(tick);
      };
      img.onerror = finish;                   // 兜底：图缺失也继续显舞台，不卡进场
      img.src = url.res1('battlebackground.png');
    });
  }

  // 战斗结束反向渐变溶解（严格对齐 AS3 BattleScene.as MIDDLE 态：alphaMultiplier = 0.03 * paintNumber，20→0）
  //   AS3：先把大地图重新画到 canvasBmpData 打底，再以 0.03*paintNumber（60%→0%）反复 draw(_background)，
  //   战斗背景越来越透明，最后完美露底回到大地图。
  //   本移植：主城世界已 live 渲染在 #battle-layer 之下，故画布只需把累积的 battle_background 由 0.6 渐隐到 0，
  //   每帧重画一层（clear 后以当前 alpha 重绘），露出的即为主城世界（与 AS3「截图打底」视觉等价）。
  _fadeOutBackGround() {
    return new Promise((resolve) => {
      const cv = this.battleBg;
      if (!cv) { resolve(); return; }
      const ctx = cv.getContext('2d');
      if (!ctx) { resolve(); return; }
      const W = cv.width, H = cv.height;
      if (!W || !H) { resolve(); return; }
      const raf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      const img = new Image();
      const finish = () => { ctx.clearRect(0, 0, W, H); ctx.globalAlpha = 1; resolve(); };
      img.onload = () => {
        let n = 20;                            // paintNumber 从 20 递减到 0
        const tick = () => {
          ctx.clearRect(0, 0, W, H);
          ctx.globalAlpha = 0.03 * n;          // 0.6 → 0：战斗背景渐隐，露出大地图
          ctx.drawImage(img, 0, 0, W, H);
          if (--n >= 0) raf(tick);
          else finish();
        };
        raf(tick);
      };
      img.onerror = finish;                   // 兜底：图缺失也直接退场，不卡退出
      img.src = url.res1('battlebackground.png');
    });
  }

  // ───────────────────────── 运行期战斗内核（对齐公式/Buff/AI/掉落编辑器）─────────────────────────
  // 统一伤害入口：消耗属性公式编辑器(config.formulas) + Buff 倍率 + 防御 halved + 暴击。
  // 返回 { dmg, crit }：crit 为是否触发暴击（attacker.crit 为 0–100 百分比暴击率）。
  // 注意：返回结构而非单数字，但 rt.js 的 calcDamage 仍保持单数字返回，故战斗模拟器(workbench.js)行为不变。
  _calcDamage(attacker, defender, o = {}) {
    const atkMult = 1 + (attacker.buffAtkPct ? attacker.buffAtkPct() : 0) / 100;
    const defMult = 1 + (defender.buffDefPct ? defender.buffDefPct() : 0) / 100;
    let base = calcDamage(attacker, defender, {
      power: o.power != null ? o.power : 1,
      rage: o.rage != null ? o.rage : 1,
      tdef: defender.def * defMult,
      rand: Math.random(),
      formulaId: o.formulaId || 'phys_damage'
    });
    base = Math.round(base * atkMult);
    if (o.defending) base = Math.round(base * 0.5);
    // 暴击：attacker.crit 为 0–100 百分比暴击率；命中则伤害 × 暴击倍数（默认 1.5，对齐常见 ARPG）。
    // 暴击判定独立于 calcDamage 内的随机浮动，二者互不影响；暴击率来自 Fighter.crit（玩家=Config.player.crit + 装备叠加，怪物=monster.crit）。
    let crit = false;
    const critRate = (attacker.crit || 0);
    if (critRate > 0) crit = Math.random() * 100 < critRate;
    let dmg = Math.max(1, Math.round(base));
    if (crit) dmg = Math.max(1, Math.round(dmg * (o.critMult != null ? o.critMult : getCombat('critMult', 1.5))));
    return { dmg, crit };
  }

  // 回合开始结算某单位的状态（中毒/回血/穿心消失爆发/飘字），供 _unitTurnStart（先攻制行动队列每个单位行动前）调用
  _tickBuffsFor(fig) {
    if (!fig.buffs || !fig.buffs.length) return;
    // ★ 阶段3：buff 自然到期 / 被清除 → 广播 BUFF_EXPIRE（为"穿心蚀骨到期爆发"等提供标准触发源）。
    //   ★ 回调发生在**移除之前**（触发器挂在该 buff 自己身上，移除后事件总线就找不到监听者了）。
    //   payload：value = 结束时该 buff 的池余量（data.pool）；vars 携带原 data 各字段 + __buffId 供条件筛选。
    const onExpire = (f, b, reason) => emitEvent(this, EVENTS.BUFF_EXPIRE, {
      source: f, target: f,
      value: (b.data && (b.data.pool || b.data.value)) || 0,
      vars: Object.assign({ __buffId: b.def.id, __reason: reason }, b.data || {})
    });
    const ev = fig.tickBuffs(this, onExpire);
    ev.floats.forEach(f => this._floatNum(fig, f.text, f.color));
    if (ev.dot) this.mLog(fig.name + ' 受到状态侵蚀 ' + ev.dot + ' 点');
    if (ev.heal) this.mLog(fig.name + ' 状态回复 ' + ev.heal + ' 点');
    this.sm.ui.refresh();
  }

  _firstAliveEnemy() { return this.enemies.find(e => e.hp > 0) || this.eFig; }
  // 敌方全灭：列表已空（倒下者被移出）或剩余者皆死。注意 _onEnemyDown 会移出倒下敌人，
  // 且副本波次在 _awardKill 内异步补场，故判空即代表本场已无可战之敌。
  _allEnemiesDead() { return this.enemies.length === 0 || this.enemies.every(e => e.hp <= 0); }

  // 绑定"点击敌人"交互：不再把 onclick 直接挂在 512×512 画板上（整块画板含透明留白都参与命中，
  // 相邻角色画板互相覆盖时点击会被 Z 序更高的那块画板拦截，导致"点到隔壁角色"）。
  // 真实目标选择在 battleStage 的像素级命中回调 _handleBattleClick 里完成（对齐 _hitTestBattle 的 alpha>24 命中）。
  _bindTargetClick(fig) {
    fig.canvasWrap.style.pointerEvents = 'none';   // 命中交给 battleStage 像素检测，画板本身不拦截点击
    fig.canvasWrap.style.cursor = 'pointer';
  }

  // 战斗角色悬停高亮：收集可命中的战斗单位（玩家 + 我方 ally + 存活敌方），供像素命中测试（对齐 MainScene._hitTestFighters）
  _battleFighters() {
    const list = [];
    if (this.pFig) list.push(this.pFig);
    (this.allies || []).forEach(a => { if (a && a.hp > 0) list.push(a); });
    // 复活类技能待施放时，把墓园中已阵亡友方也纳入可命中集合（用于悬停高亮 + 点选）
    if (this.pendingSkill && this.pendingSkill.revive && this._downedAllies) {
      this._downedAllies.forEach(a => { if (a) list.push(a); });
    }
    (this.enemies || []).forEach(e => { if (e && e.hp > 0) list.push(e); });
    return list;
  }
  // 像素级命中测试（复用 MainScene._hitTestFighters 思路，作用于战斗单位）
  _hitTestBattle(clientX, clientY) {
    const sorted = this._battleFighters().slice().sort((a, b) => (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0));
    for (const f of sorted) {
      // 玩家自身也参与高亮（与其他单位同款 drop-shadow 发光 + 名字变色）
      const cv = f.canvasWrap && f.canvasWrap.querySelector('canvas');
      if (!cv || !cv.width || !cv.height) continue;
      const rect = cv.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      let px = Math.floor((clientX - rect.left) / rect.width * cv.width);
      const py = Math.floor((clientY - rect.top) / rect.height * cv.height);
      if (f.flipX === -1) px = cv.width - px - 1;
      if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
      const alpha = _readFighterAlpha(cv, px, py);
      if (alpha > 24) return f;
    }
    return null;
  }
  // 悬停高亮（对齐 MainScene._updateHover：切换 .fighter.hovered → 发光 + 名字变色）
  _updateBattleHover(clientX, clientY) {
    const hit = this._hitTestBattle(clientX, clientY);
    if (hit !== this._bHovered) {
      if (this._bHovered) this._bHovered.el.classList.remove('hovered');
      this._bHovered = hit;
      if (this._bHovered) {
        this._bHovered.el.classList.add('hovered');
        this.battleStage.style.cursor = 'pointer';
      } else {
        this.battleStage.style.cursor = '';
      }
    }
  }
  // 像素级命中测试（仅敌方，存活）：按 Z 序从高到低遍历，返回点击点存在可见像素(alpha>24)的最高敌人。
  // 与 _hitTestBattle 同款逻辑，但限定敌方——专门解决"512 画板互相覆盖、点到透明留白却被 Z 序更高的画板拦截、
  // 从而选到隔壁角色"的问题：透明留白处 alpha=0 会被跳过，继续向下找真正可见的那只敌人。
  _hitTestEnemy(clientX, clientY) {
    const list = (this.enemies || []).filter(f => f && f.hp > 0)
      .sort((a, b) => (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0));
    for (const f of list) {
      const cv = f.canvasWrap && f.canvasWrap.querySelector('canvas');
      if (!cv || !cv.width || !cv.height) continue;
      const rect = cv.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      let px = Math.floor((clientX - rect.left) / rect.width * cv.width);
      const py = Math.floor((clientY - rect.top) / rect.height * cv.height);
      if (f.flipX === -1) px = cv.width - px - 1;
      if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
      const alpha = _readFighterAlpha(cv, px, py);
      if (alpha > 24) return f;
    }
    return null;
  }
  // 像素级命中测试（己方：玩家 + 出战宠物/机器人，存活）：与 _hitTestEnemy 同款 Z 序 + alpha 逻辑，
  // 但限定玩家侧——专门支持 ally / enemyOrAlly 技能"点击己方目标施放"（对齐用户反馈"游戏只能点敌方，应可点己方"）。
  _hitTestAlly(clientX, clientY, includeDown = false) {
    let base = [this.player, ...(this.allies || [])];
    if (includeDown && this._downedAllies && this._downedAllies.length) base = base.concat(this._downedAllies);
    const list = base.filter(f => f && (includeDown ? true : f.hp > 0))
      .sort((a, b) => (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0));
    for (const f of list) {
      const cv = f.canvasWrap && f.canvasWrap.querySelector('canvas');
      if (!cv || !cv.width || !cv.height) continue;
      const rect = cv.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      let px = Math.floor((clientX - rect.left) / rect.width * cv.width);
      const py = Math.floor((clientY - rect.top) / rect.height * cv.height);
      if (f.flipX === -1) px = cv.width - px - 1;
      if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
      const alpha = _readFighterAlpha(cv, px, py);
      if (alpha > 24) return f;
    }
    return null;
  }
  // battleStage 点击回调：像素级命中真实可见目标作为攻击/技能目标（对齐 MainScene 像素命中 + 用户反馈"512 画板覆盖点到隔壁"）。
  // 仅当点击落在某单位可见像素上才改选目标并派发指令；点到透明留白/空地则不动作（不再误选被覆盖的相邻角色）。
  // 友方/敌我技能（target=ally / enemyOrAlly）：点击命中点选【己方】单位作为施放目标；其余仍限敌方。
  _handleBattleClick(e) {
    if (this.busy) return;
    const tgt = this.pendingSkill && this.pendingSkill.target;
    if (tgt === 'ally') {                       // 纯友方技能：必须点己方单位（己方宠物/机器人/主角）
      const includeDown = !!(this.pendingSkill && this.pendingSkill.revive);   // 复活技能：允许点选已阵亡友方
      const hit = this._hitTestAlly(e.clientX, e.clientY, includeDown);
      if (!hit) return;
      this.aFig = hit;
      this._onTargetClick();
      return;
    }
    if (tgt === 'enemyOrAlly') {                // 敌我皆可：优先己方，其次敌方
      const a = this._hitTestAlly(e.clientX, e.clientY);
      if (a) { this.aFig = a; this.eFig = this.eFig; this._onTargetClick(); return; }
      const en = this._hitTestEnemy(e.clientX, e.clientY);
      if (en) { this.eFig = en; this.aFig = null; this._onTargetClick(); return; }
      return;
    }
    const hit = this._hitTestEnemy(e.clientX, e.clientY);
    if (hit) {
      this.eFig = hit;                 // 仅像素命中真实可见敌人时改选（覆盖画板不再误选）
      this._onTargetClick();           // 派发当前指令（ATTACK/CAST）；未选行动则提示
      return;
    }
    // ★先攻制下操控对象随行动队列自动切换，不再支持"点击己方单位手动切换操控对象"；
    //   点己方单位仅在「技能选友方目标」(ally/enemyOrAlly) 时用于选目标（见上方 tgt 分支），其余情况忽略。
  }

  // 选择第 i 只敌人的 monsterId：优先配置 monsterId / mobs 列表，否则遍历真实 Config.monsters（明雷多怪时混合增加变化）
  _pickMob(i) {
    // ★ 暗雷按怪物生成表【逐单位独立】加权抽取（darkPick=perUnit，默认）：
    //   同一场 10 只可能是 猫×3 + 兔×3 + 羊×3 + 猫妖×1 的混合怪群。
    //   darkPick=once ⇒ 整场沿用 monsterNpc.monsterId（兼容旧规则/主题怪）。
    //   表非法/抽空时回退 monsterNpc.monsterId，再回退 mobs 列表。
    if (this.monsterNpc.dark && this.monsterNpc.darkPick !== 'once'
        && Array.isArray(this.monsterNpc.darkTable) && this.monsterNpc.darkTable.length) {
      const perUnit = _pickDarkMob(this.monsterNpc.darkTable);
      if (perUnit) return perUnit;
    }
    if (this.monsterNpc.monsterId) return this.monsterNpc.monsterId;   // 明雷/普通：用配置怪物模板（10 只同模板）
    if (Array.isArray(this.monsterNpc.mobs) && this.monsterNpc.mobs.length) return this.monsterNpc.mobs[i % this.monsterNpc.mobs.length];
    const keys = Object.keys(Config.monsters || {});
    return keys.length ? keys[i % keys.length] : 'm_boar';
  }

  // 生成一个敌方 Fighter（按 monster 模板），加入 enemies 列表
  async _spawnEnemy(monsterId, npcId, point, slot = null) {
    // ★ 怪物分两类（net.js GET_MONSTER 按 fixedStats 分流）：资质型等级恒 1、属性走公式；
    //   数值配置型直接用模板数值。此处只透传结果，不再插手等级。
    const mres = await requestCommand(CMD.GET_MONSTER, { monsterId });
    const m = mres.monster;
    // ★ 怪物数据缺失时立刻抛明确错误（monsterId 写错/模板被删/协议返回空）。
    //   旧代码直接往下走 m.name → "Cannot read properties of undefined"，
    //   异常在 enter() 里冒出去会让整场游戏硬锁死（见 enterBattle 的兜底注释）。
    if (!m) throw new Error('[battle] 怪物数据缺失，monsterId=' + monsterId);
    // 变异野猫群：怪物模板带 mutant 标志 → 每只敌人按"已生成数量"索引、以总数均分色相环，
    // 得到互不相同颜色（如 10 只 = 每 36° 一色）。矩阵透传给 Fighter，由 _bodyWrap 的 SVG feColorMatrix 套上。
    let colorMatrix = null;
    const tpl = (Config.data.monsters || {})[monsterId];
    if (tpl && tpl.mutant) {
      const total = this._enemyTotal || (this.enemies.length + 1) || 10;
      colorMatrix = variantMatrix(this.enemies.length, total);
    } else if (m.variant) {
      // variant individual: matrix resolved inside Fighter from Config.variant
      colorMatrix = null;
    }
    // 借：同 charId(怪物模型) 有空闲实例则复用（保留 DOM），否则新建
    const fig = RolePool.acquire({
      // ★ 怪物模型 id 取自模板：优先 charId，缺省回退 body（25/29 怪物模板只有 body 字段，
      //   旧代码只读 m.charId ⇒ undefined ⇒ loadChar(undefined) ⇒ 404 的 HTML 被当 JS eval ⇒
      //   SyntaxError；旧构建无 enterBattle 兜底 + 主循环可杀 ⇒ BattleScene.enter 抛错 → 整局硬锁死，
      //   表现即"走几步才卡、键盘鼠标全死、动画照常"。详见本会话排查。）
      id: 'enemy_' + monsterId + '_' + this.enemies.length, name: m.name, charId: m.charId || m.body,
      level: m.level, hp: m.hp, mp: m.mp, atk: m.atk, def: m.def, mag: m.mag, spd: m.spd,
      crit: m.crit, dodge: m.dodge,   // 怪物暴击/闪避率（monster 模板未提供则为 0；运行期被 _calcDamage 消费）
      xiuwei: m.xiuwei != null ? m.xiuwei : Math.round((m.level || 1) * 900), // 修为（缺省按等级缩放，供技能修为比较/持续回合）
      recover: m.recover || 0,
      rageMax: 0, rage: 0,   // 怪物无怒气系统（F4）：rage setter 对 rageMax<=0 的单位是空操作
      colorMatrix,                     // 变异/染色：非 mutant 怪为 null（Fighter 不套滤镜）
      side: 'enemy', dir: 'right', showBars: true,
      variant: !!m.variant,   // cg: variant flag - Fighter resolves the matrix itself (survives pool reuse)
    });
    // 复用实例需清掉上一场战斗遗留的瞬态标记（否则 _onEnemyDown/_awardKill 的早返回守卫会误判）
    fig._down = false; fig._awarded = false;
    fig.maxHp = m.hp; fig.maxMp = m.mp;
    fig._monsterId = monsterId; fig._npcId = npcId;
    // ★ 数值配置型标志（net.js 按 fixedStats 分流）：捕捉时 _grantCaughtPet 据此把宠物转回资质型。
    //   family 记物种基础名，捕捉后可判「同一家族同一类」。
    fig._fixedStats = !!m.fixedStats;
    fig.family = m.family || m.name;
    // ★ 挑衅话真源在 chars.json（net.js 已把 char.taunt 注入 m.taunt）：战斗侧只读 fig，
    //   混合怪群时每只怪各自掷自己的 rate，互不干涉。
    fig.taunt = Array.isArray(m.taunt) ? m.taunt.slice() : null;
    fig.tauntRate = (m.tauntRate != null) ? m.tauntRate : null;
    fig.skills = Array.isArray(m.skills) ? m.skills.slice() : [];   // 怪物技能栏（被动技能/后续怪物主动技能）
    // ★ B6：透传生成器产出的逐技能等级（net.js GET_MONSTER 已注入 m.skillLevels）；
    //   缺省回退 null，applyPassiveBuffs 的 skillLevel(id) 再回退单位等级。
    fig.skillLevels = (m.skillLevels && typeof m.skillLevels === 'object')
      ? Object.assign({}, m.skillLevels) : null;
    if (m.grade) fig.grade = m.grade;
    if (m.variant) fig.variant = m.variant;
    if (fig.variant && !fig.colorMatrix) fig.setColorMatrix(resolveVariantMatrix(Config.variant));
    if (m.growRate) fig.growRate = m.growRate;   // ★ cc：透传成长率，否则捕捉后 _grantCaughtPet 拿不到 → 回退 100%
    reapplyPassiveBuffs(fig);
    // 练功靶（木桩，模板 alwaysDefend:true）→ 永久防御态：
    //   1) _enemyAct 检测到 alwaysDefend 时直接走防御姿态、跳过普攻/施法/逃跑（下方 _enemyAct 顶部短路）；
    //   2) _unitTurnStart 只对【非敌方】重置 defending（scene.js:2115），敌方永不重置 → 置一次即持续生效；
    //   3) skill-engine.applyRaw 有 `!ignoreDefending && target.defending → dmg *= 0.5`（防御减伤，玩家打木桩减半）。
    //   效果：木桩全程只保持防御、不还手（满足"练功木桩永远防御"需求）。
    // 用 !! 显式赋值：RolePool 复用实例时清掉上一场遗留的 defending，避免串味。
    fig.defending = !!m.alwaysDefend;
    fig.alwaysDefend = !!m.alwaysDefend;   // 透传：_enemyAct 据它跳过普攻/施法，永久保持防御
    fig.setPos(0, 0);
    this.characterLayer.appendChild(fig.el);
    fig.battleScale = this.SCALE;   // 敌方统一战斗缩放，锚点只测一次（对齐玩家，修复点击偏移/缩小）
    fig.hpAbove = true;             // 敌方血条浮于头顶上方（与主城 NPC 同款像素检测，仅位置不同）
    fig.setPos(point.x, point.y);
    fig._home = { x: point.x, y: point.y };   // 记录出生战斗点，攻击后归位
    fig._band = slot;               // 记录所占战斗点（10-19），供十字/矩形等按站位范围判定（如恸地神咒/烈焰风暴）；复用实例也需重置
    this._bindTargetClick(fig);
    await this._stand(fig);
    this.enemies.push(fig);
    return fig;
  }

  // 敌人倒下：播放倒地、结算奖励（经验/金币/掉落，消耗掉落权重编辑器）、写回 quest 进度、推进副本波次
  async _onEnemyDown(enemyFig) {
    if (enemyFig._down) return;
    enemyFig._down = true;
    // ★ UNIT_DEATH：置于 clearBuffs 之前（使阵亡者自身的"死亡触发"仍可命中）
    emitEvent(this, EVENTS.UNIT_DEATH, { source: enemyFig, target: enemyFig, skillType: 'death' });
    // 阵亡演出（严格对齐 AS3 BattleInitializer17）：飘字后 500ms 才切倒地帧，随后 500/600/700/800ms
    // 可见性闪动 → 850ms（非清场忽略）→ 900ms。敌方 = isDestroyFighter 为真：闪动后交回本方法收尾。
    // 旧写法 `await enemyFig.down()` 会让倒地与伤害飘字同时发生（原版是飘字先、倒地后 500ms）。
    await enemyFig.die({ isDead: true, clearOnDeath: true });
    enemyFig.clearBuffs();    // 死亡清空所有 buff（停状态动画 + 清栏 + 重置侠义之心）
    await this._awardKill(enemyFig);
    this.enemies = this.enemies.filter(e => e !== enemyFig);
    if (this.eFig === enemyFig) {
      const next = this.enemies.find(e => e.hp > 0);
      this.eFig = next || null;
    }
    RolePool.release(enemyFig);   // 阵亡即回收：暂停动画 + 摘离，保留 DOM 入池（下次同模型怪物复用）
  }

  // 己方队员阵亡：播放阵亡演出并移出 allies 列表（不含任何奖励结算，区别于 _onEnemyDown）。
  // 主角(pFig)阵亡由 _lose 统一处理，此处跳过（见 onDeath 路由）。
  // ★ 演出与主角【完全一致】（user 2026-09-13 拍板「队员和主角一致，按 AS3 的」）：
  //   AS3 `BattleInitializer17.isDestroyFighter()` = isPVE() && fighter.pid > 9 && _isDead，
  //   敌方(pid>9) 真死才清场销毁；我方（pid 0=主角、1~9=队员）恒走非清场分支
  //   ⇒ 850ms 隐 / 900ms 显 + backOriginerPosition() 回原位（躺尸留在原位，不是消失）。
  //   故此处与 _lose() 用同一调用：die({ isDead:true, clearOnDeath:false })。
  //   旧写法 `await allyFig.down()`（纯末帧定格、无闪动、原地不动）与主角不一致，已弃用。
  async _onAllyDown(allyFig) {
    if (allyFig._down) return;
    allyFig._down = true;
    // ★ UNIT_DEATH：置于 clearBuffs 之前（使阵亡者自身的"死亡触发"仍可命中）
    emitEvent(this, EVENTS.UNIT_DEATH, { source: allyFig, target: allyFig, skillType: 'death' });
    // ★ 天赋"死亡后自动复活"（浴火重生）：事件内已复活则 _down 被复位为 false、hp>0。
    //   此时绝不可再播阵亡演出/清 buff/移出 allies，否则"复活被撤销"。
    if (!allyFig._down && allyFig.hp > 0) return;
    // 与主角一致：飘字后 500ms 切倒地帧 + 500/600/700/800ms 闪动 + 850ms 隐 + 900ms 现身回原位
    await allyFig.die({ isDead: true, clearOnDeath: false });
    // ★ 演出窗口内被复活（复活技能 30040000 等）：reviveFighter 已复位 _down/hp、作废演出回调并把该单位放回 allies。
    //   此时【绝不可】再按死者收尾——否则会清掉刚恢复的 buff、把它移出 allies 并塞进墓园，等于"复活被撤销"。
    //   （_down 是本方法开头置 true 的，只有复活路径会把它复位回 false）
    if (allyFig._down === false && allyFig.hp > 0) return;
    allyFig.clearBuffs();    // 死亡清空所有 buff（停状态动画 + 清栏 + 重置侠义之心）
    this.allies = (this.allies || []).filter(a => a !== allyFig);
    if (this.aFig === allyFig) this.aFig = null;   // 若当前点选的己方单位倒下，清空选 targeting
    if (!this._downedAllies) this._downedAllies = [];
    this._downedAllies.push(allyFig);   // 入墓园：供「复活」类技能点选施放
  }

  // 统一死亡演出路由：
  //   - 敌方(enemies 内) → _onEnemyDown（倒地 + 击杀奖励 + 移出）
  //   - 己方队员(allies 内，非主角) → _onAllyDown（仅倒地 + 移出）
  //   - 主角(pFig) → 返回 null（由 _lose 统一处理，不在普通攻击/技能结算里提前倒地）
  // 已 _down 的单位直接返回 null（防重复播放）。返回 Promise 供调用方 await / Promise.all。
  onDeath(fig) {
    if (!fig || fig._down) return null;
    if (fig === this.pFig) { fig.clearBuffs(); return null; }            // 主角阵亡清空 buff，留给 _lose
    if (this.enemies && this.enemies.indexOf(fig) >= 0) return this._onEnemyDown(fig);
    if (this.allies && this.allies.indexOf(fig) >= 0) return this._onAllyDown(fig);
    return null;                                                         // 兜底：未知归属不播放
  }

  // 单只敌人被击败的奖励结算（对齐掉落权重编辑器：rollDrops）
  async _awardKill(enemyFig) {
    if (enemyFig._awarded) return;
    enemyFig._awarded = true;
    const prevLevel = this.player.level;   // 升级判定基线（对齐 AS 升级音效触发）
    this.sm.defeated.add(enemyFig._npcId || enemyFig.id);
    if (enemyFig._monsterId) this._addQuestProgress(enemyFig._monsterId);
    const mres = await requestCommand(CMD.GET_MONSTER, { monsterId: enemyFig._monsterId });
    const m = mres.monster;
    const reward = { exp: m.exp, silver: m.silver, gold: m.gold, items: rollDrops(enemyFig._monsterId) };
    const res = await requestCommand(CMD.BATTLE_END, { win: true, rewards: reward });
    const leveled = !!(res.log && res.log.length && res.log.indexOf('__leveled__') >= 0);
    // ★ 战斗奖励的货币（经验/银子/金子）也在右侧「系统类」聊天窗提示（用户要求，2026-10-03）：
    //   各段 >0 才显示，全 0 不输出；exp 千分位。输出顺序：战斗获得 → 升级 → 获得物品
    const curSegs = [];
    if (Number(reward.exp) > 0) curSegs.push('经验 ' + Number(reward.exp).toLocaleString() + ' 点');
    if (Number(reward.silver) > 0) curSegs.push('银子 ' + Number(reward.silver) + ' 两');
    if (Number(reward.gold) > 0) curSegs.push('金子 ' + Number(reward.gold) + ' 两');
    if (curSegs.length) this.mLog('<font color="#2fae6b">战斗获得：</font>' + curSegs.join('、'));
    if (res.log && res.log.length) res.log.forEach(l => { if (l !== '__leveled__') this.sm.ui.log(l, 'good'); });
    const np = res.player;
    if (np) {
      // ★ aw：属性公式驱动 ⇒ 只回写等级/经验/金币；hp/atk 等不再用后端值
      ['level', 'exp', 'expNext', 'silver', 'gold'].forEach(k => { if (np[k] != null) this.player[k] = np[k]; });
      if (np.sp != null) this.player.rage = np.sp;   // 旧「真气」持久化值并入怒气（合并字段）
      // ★ 不再用服务端快照整体覆盖 player.bag：np.bag 是登录时的静止快照，
      //   覆盖会把「战斗内用掉的药水、启动后新获得的物品」全部抹回去（丢档）。
      //   战斗奖励改走权威 InventoryManager（下方 _giveBattleRewards），保持物品系统单一真源。
      if (leveled) {
        // 升级：按新等级重算属性，hp/mp 按战前比例保留（避免白嫖满血）
        const hpR = this.player.maxHp ? this.player.hp / this.player.maxHp : 1;
        const mpR = this.player.maxMp ? this.player.mp / this.player.maxMp : 1;
        try { applyPlayerAttrs(this.player); } catch (e) { console.warn('[player] 升级重算失败：', e); }
        this.player.hp = Math.max(1, Math.round(this.player.maxHp * hpR));
        this.player.mp = Math.round(this.player.maxMp * mpR);
      }
      // ★ bd：战后按公式整体重算（applyPlayerAttrs → applyDerived → applyEquip）。
      //   装备层与被动加成层都在 applyEquip 内自动重挂，不再手工拼 _base*（旧写法会让装备加成重复叠加）。
      //   主属性由职业资质表重置为洁净值，hp/mp 按比例保留。
      try { applyPlayerAttrs(this.player); } catch (e) { console.warn('[player] 战后属性重算失败：', e); }
    }
    if (np && np.level != null && np.level > prevLevel) {
      playSfx('levelup');   // 升级音
      this._floatAnim(this.pFig, 'uplevel', { effect: true });   // 升级：改走动画通道（resource/effect/uplevel）
    }
    if (reward.items && reward.items.length) {
      playSfx('pickup');              // 掉落拾取音
      this._giveBattleRewards(reward.items);   // ★ 走权威背包（不覆盖 player.bag 快照）
    }
    if (this.sm.ui.recordBattle) this.sm.ui.recordBattle({ win: true, enemy: m.name, reward: '经验 ' + reward.exp + ' / 银子 ' + reward.silver + (Number(reward.gold) > 0 ? ' / 金子 ' + reward.gold : ''), round: this.round, level: this.player.level, enemyLevel: (this.monsterNpc && this.monsterNpc.level) || (this.eFig && this.eFig.level) || null, dmgDealt: this._dmgDealt, dmgTaken: this._dmgTaken });
    // 副本波次推进：当前敌死后生成下一波
    if (this.waveQueue && this.waveQueue.length) {
      const w = this.waveQueue.shift();
      const wslot = this._nextFoeSlot();   // 波次进场也走站位管理器，避免与初始阵型重叠
      const fig = await this._spawnEnemy(w.mob, 'wave_' + w.mob, BattleScene.getFightPoint(wslot), wslot);
      this.mLog('副本下一波：' + fig.name + ' 进场！');
      if (!this.eFig) this.eFig = fig;
    }
  }

  /**
   * 战斗掉落奖励入包（替代旧的「服务端快照覆盖 player.bag」）。
   * ★ 走权威 InventoryManager + commit：单一真源、自动堆叠、落地存档；
   *   背包满则逐件提示（不静默丢弃）。物品系统未启动（异常兜底）时退回直推视图。
   * @param {{itemId:number, count:number, bind?:number}[]} items
   */
  _giveBattleRewards(items) {
    if (!items || !items.length) return;
    const itemName = (id) => {
      const def = (typeof Config !== 'undefined' && Config.items) ? Config.items[id] : null;
      return def ? def.name : ('物品' + id);
    };
    const got = [];
    const boot = inventoryBooted();
    if (boot && boot.inv) {
      let full = 0;
      for (const it of items) {
        const id = Math.trunc(Number(it.itemId));
        const n = Math.trunc(Number(it.count)) || 1;
        if (!Number.isFinite(id)) continue;
        const r = boot.inv.addItem(id, n);
        if (r.ok) got.push(itemName(id) + '×' + n);
        else full += 1;
      }
      inventoryCommit('battle-reward');
      if (full) this.mLog('背包已满，' + full + ' 件掉落未能入包');
    } else {
      if (!Array.isArray(this.player.bag)) this.player.bag = [];
      for (const it of items) {
        const id = Math.trunc(Number(it.itemId));
        const n = Math.trunc(Number(it.count)) || 1;
        const exist = this.player.bag.find(b => b && Number(b.itemId) === id);
        if (exist) exist.count += n;
        else this.player.bag.push({ itemId: id, count: n, bind: it.bind });
        got.push(itemName(id) + '×' + n);
      }
    }
    // ★ 邮件系统删除后：战斗掉落直接入包，并在右侧「系统类」聊天窗逐件提醒
    if (got.length) this.mLog('<font color="#2fae6b">获得物品：</font>' + got.join('、'));
  }

  // 战斗日志：统一路由到右侧「系统类」聊天窗（battle-chat 内战斗面板已移除，避免重复显示）。
  mLog(s) { if (this.sm && this.sm.ui) this.sm.ui.log(s, 'sys'); }

  // ── 操控对象（玩家 ↔ 宠物）──────────────────────────────────────────────
  // 宠物改为【手动操控】：点击场上宠物立绘把操控权交给它，右侧指令面板同步换成宠物指令集；点主角切回。
  // ⚠ 与"技能点选友方目标"的区分：pendingSkill.target 为 ally / enemyOrAlly 时，点己方单位是【选技能目标】，
  //   不触发切换（见 _handleBattleClick）；其余情况点己方单位才是切换操控对象。
  _ctrlFig() {
    return (this._ctrl && this._ctrl.hp > 0) ? this._ctrl : this.pFig;
  }

  // 切换操控对象：换指令集 + 高亮当前操控单位
  _setCtrl(fig) {
    const prev = this._ctrlFig();
    if (prev && prev.el) prev.el.classList.remove('fighter-ctrl');
    this._ctrl = (fig && fig !== this.pFig && fig.hp > 0) ? fig : null;
    const cur = this._ctrlFig();
    if (cur && cur.el) cur.el.classList.add('fighter-ctrl');
    this._buildCommandBar();
    this.mLog('当前操控：' + ((cur && cur.name) || '') + (this._ctrl ? '（宠物）' : ''));
  }

  // 等待玩家为当前操控单位下达指令（行动完成后由 _resolveUnitCmd 唤醒）
  _waitUnitCmd() {
    return new Promise(resolve => { this._unitResolve = resolve; });
  }
  _resolveUnitCmd() {
    if (this._unitResolve) { const r = this._unitResolve; this._unitResolve = null; r(); }
  }

  // 底部指令条（对齐 BattlePanel.as 的 9 指令 + showPlayerOrPet）
  _buildCommandBar() {
    // 指令集随【当前操控对象】切换：宠物为 攻击/技能/防御；玩家为 8 指令（召回 RECALL 按需求在人物指令条隐藏）
    const ctrl = this._ctrlFig();
    const isPet = !!(ctrl && ctrl !== this.pFig);
    const cmds = isPet
      ? [
          { id: B.ATTACK, label: '攻击' },
          { id: B.CAST,   label: '技能' },
          { id: B.DEFEND, label: '防御' }
        ]
      : [
          { id: B.AUTO,   label: '自动' },
          { id: B.CAST,   label: '技能' },
          { id: B.ITEM,   label: '道具' },
          { id: B.DEFEND, label: '防御' },
          { id: B.SUMMON, label: '召唤' },
          { id: B.CATCH,  label: '捕捉' },
          { id: B.BAOQI,  label: '爆气' },
          { id: B.FLEE,   label: '逃跑' }
        ];
    // 对齐 AS3 BattlePanel AutoButton 的 text_battle_* 文字图标签（爆气=explode / 技能=skill / 召回=callback）
    const ICON = {
      [B.AUTO]: 'textbattleauto', [B.CAST]: 'textbattleskill', [B.ITEM]: 'textbattleitem',
      [B.DEFEND]: 'textbattledefense', [B.SUMMON]: 'textbattlesummon', [B.CATCH]: 'textbattlecatch',
      [B.BAOQI]: 'textbattleexplode', [B.FLEE]: 'textbattleflee', [B.RECALL]: 'textbattlecallback'
    };
    this.cmd.innerHTML = '';
    this.subRow = null;
    if (this.itemPanel) { this.itemPanel.remove(); this.itemPanel = null; }   // 指令条重建时一并关掉药品面板
    this.cmdRow = document.createElement('div');
    this.cmdRow.className = 'battle-cmd-row';
    this.cmd.appendChild(this.cmdRow);
    // 指令按钮定位：优先用 debug_cmdbar.html 微调导出的 CMD_POS（按 id 精确落位，对齐 AS3 非整齐布局）；
    // 缺失 id 时回退「居中 + AS3 纵向公式 y=index*25+42」顺延（按钮集变化如宠物无逃跑/有召回时自动续位）。
    const CMD_POS = {
      auto   : { left: 32, top: 49 },
      cast   : { left: 34, top: 72 },
      item   : { left: 35, top: 96 },
      defend : { left: 33, top: 120 },
      summon : { left: 26, top: 147 },
      catch  : { left: 20, top: 172 },
      baoqi  : { left: 16, top: 198 },
      flee   : { left: 15, top: 222 },
      recall : { left: 16, top: 261 }
    };
    const STEP = 25, TOP = 42, LEFT = 19;
    cmds.forEach((c, i) => {
      const b = document.createElement('button');
      // 技能指令（CAST）用真实 battleskill.png 按钮面（CSS .skill 接管）
      b.className = 'battle-cmd-btn' + (c.id === B.CAST ? ' skill' : '');
      b.dataset.cmd = c.id;
      // 按 id 落位；缺失则按序顺延（居中 + AS3 y=index*25+42）。c.id 为小写(B.AUTO='auto')，
      // 导出片段可能用大写键名，统一 toLowerCase 兼容。
      const p = CMD_POS[String(c.id).toLowerCase()] || { left: LEFT, top: i * STEP + TOP };
      b.style.left = p.left + 'px';
      b.style.top  = p.top  + 'px';
      // 禁用判据（见 _cmdDisabled）：沿用各指令处理入口已有的 toast 条件，本地计算
      const off = this._cmdDisabled(c.id, ctrl);
      if (off) b.classList.add('off');
      // 指令标签用真实 text_battle_* 文字图（对齐 AS3 AutoButton 第二参）；无图/图缺失时直接用中文文本，绝不臆造
      // ★ 禁用态对齐 AS3 AutoButton.updateTextImg(false)：文字图换 "key+2" 的禁用变体（如 textbattleskill2.png）
      const icn = ICON[c.id];
      b.innerHTML = icn
        ? `<img class="cmd-ic" src="${url.res((off ? icn + '2' : icn) + '.png')}" alt="${c.label}" onerror="this.outerHTML='<span class=&quot;txt&quot;>${c.label}</span>'">`
        : `<span class="txt">${c.label}</span>`;
      b.onclick = () => this._onCmd(c.id);
      this.cmdRow.appendChild(b);
    });
    this._highlightCmd();
  }

  // 指令禁用判据（对齐 AS3 AutoButton.updateState(mask)：掩码不命中 ⇒ isClick=false + 文字图换禁用变体）。
  //   AS3 的掩码由服务器在 receiveChooseBattleAction 时下发；单机版无服务器，
  //   沿用各指令处理入口已有的 toast 条件作本地判据（用户 2026-10-05 裁决）：
  //     技能 CAST   = 当前操控单位法力 < 1（_onCmd B.CAST / _petCmd B.CAST 的「法力不足」）
  //     爆气 BAOQI  = 未爆气且玩家法力 < 30（_baoqi 的「法力不足（需 30）」；已爆气时点击为「取消爆气」，保持可用）
  //     召唤 SUMMON = 宠物已在场 / 未设置出战伙伴（_summon 的两条 toast）
  //   其余指令（自动/道具/防御/捕捉/逃跑）无本地禁用条件，保持可用。
  _cmdDisabled(id, ctrl) {
    const c = ctrl || this._ctrlFig();
    if (!c) return false;
    if (id === B.CAST) return c.mp < 1;
    if (id === B.BAOQI) return !this.raging && this.player.mp < 30;
    if (id === B.SUMMON) return this.summonedPet != null || !this._activePetInst();
    return false;
  }

  _highlightCmd() {
    if (!this.cmdRow) return;
    const ctrl = this._ctrlFig();
    this.cmdRow.querySelectorAll('.battle-cmd-btn').forEach(b => {
      const dis = this._cmdDisabled(b.dataset.cmd, ctrl);
      b.classList.toggle('on', !dis && (b.dataset.cmd === this.battleState || (this.auto && b.dataset.cmd === B.AUTO)));
    });
  }

  // 指令按钮回调（对齐 BattlePanel.mouseDownHandler）
  _onCmd(id) {
    if (this.busy && id !== B.AUTO) return;
    // 宠物被操控时，指令走宠物指令集（攻击/技能/防御）
    const ctrl = this._ctrlFig();
    if (ctrl && ctrl !== this.pFig) { this._petCmd(id); return; }
    switch (id) {
      case B.AUTO:
        this.auto = !this.auto;
        this.mLog(this.auto ? '开启自动战斗' : '关闭自动战斗');
        this._highlightCmd();
        // 先攻制下：若当前正有单位在等待玩家下令，开启自动即唤醒回合循环，
        // 循环下一轮判定 auto 会直接替该单位自动普攻（无需再点选）。
        if (this.auto && this._unitResolve) this._resolveUnitCmd();
        break;
      case B.CAST:
        if (this.player.mp < 1) { this.sm.ui.toast('法力不足'); break; }
        this._showSkillChooser();
        break;
      case B.ITEM:
        this._showItemChooser();
        break;
      case B.DEFEND:
        this.battleState = B.DEFEND; this.defending = true;
        this.mLog(this.player.name + ' 摆出防御姿态');
        playSfx('defend');   // 防御音
        this._playerTurn('defend');
        break;
      case B.SUMMON: this._summon(); break;
      case B.CATCH:  this._startCatch(); break;
      case B.BAOQI:  this._baoqi(); break;
      case B.RECALL: this._recall(); break;
      case B.FLEE:
        this._flee(false);
        break;
    }
  }

  // ── HUD 技能热键栏桥接（F1 攻击 / F2~F8 技能，战斗中可用）──
  // 对齐 _showSkillChooser 内技能按钮的 onclick 行为：进入对应战斗状态并等待点选敌人（治疗/增益类选即释放）。
  _triggerSkillbarAttack() {
    // 先攻制下只有"当前操控主角"时热键才生效；操控宠物/队友时忽略（避免误用主角技能）
    if (this.busy || this._ended || this._ctrlFig() !== this.pFig) return;
    this._closeSubRow();
    this.battleState = B.ATTACK;
    this._highlightCmd();
  }
  _triggerSkillbarCast(skill) {
    // 热键仅对主角技能有效；操控宠物/队友时不应触发主角技能
    if (this.busy || this._ended || !skill || this._ctrlFig() !== this.pFig) return;
    // ★ 费用校验（法力/怒气/寿命）：怒气仅人物、寿命仅宠物；不足则提示并阻止施放
    if (this.player.mp < (skill.mpCost || 0)) { this.sm.ui.toast('法力不足（需 ' + skill.mpCost + '）'); return; }
    if (skill.rageCost && this.pFig.rageMax > 0 && this.pFig.rage < skill.rageCost) { this.sm.ui.toast('怒气不足（需 ' + skill.rageCost + '）'); return; }
    if (skill.lifeCost && this.pFig.lifeMax > 0 && this.pFig.life < skill.lifeCost) { this.sm.ui.toast('寿命不足（需 ' + skill.lifeCost + '）'); return; }
    this.pendingSkill = skill; this.battleState = B.CAST;
    this._closeSubRow(); this._highlightCmd();
    // 自身/友方治疗与纯增益技能：选即释放，无需点选敌人（与战斗内技能选择子条一致）
    if (skill.heal || ((skill.buffs && skill.buffs.length) && !skill.power)) {
      this._playerTurn('cast');
    } else {
      // 对齐 AS3 BattleManager.useSkill → setBottomPromptText(CAST_SELECT, 220) +
      //   setAllPanelAndFaceVisiable(false)：「请选择你要使用<font color='#F6FA00'>技能的目标</font><br>右键取消操作」（lang[30052]）
      this._showBottomPrompt('请选择你要使用<span style="color:#F6FA00">技能的目标</span><br>右键取消操作');
      this._setBattleHud('select');
    }
  }

  // 爆气（对齐 BATTLE_BAOQI）：进入狂暴状态，本场战斗攻击力提升 40%，消耗 30 法力；再次点击取消。
  _baoqi() {
    if (this.raging) { this.raging = false; this.mLog(this.player.name + ' 收回爆气'); this.sm.ui.toast('已取消爆气'); this._highlightCmd(); return; }
    if (this.player.mp < 30) { this.sm.ui.toast('法力不足（需 30）'); return; }
    this.player.costMp(30);
    this._floatNumber(this.pFig, NUM_TYPE.MP, -30);   // 爆气耗蓝：MP 数字飘字（0 值不显示）
    this.raging = true;
    playSfx('baoqi');   // 爆气蓄力音
    this.mLog(this.player.name + ' 爆气！攻击力大幅提升');
    this.sm.ui.toast('爆气！攻击 +40%');
    this._highlightCmd();
    this.sm.ui.refresh();
  }

  // 取玩家侧"从中心扩展"的第一个未占用战斗点（手动召唤宠物/补位用，避免与已进场成员重叠）：
  //   顺序 2→1,3→0,4→后排 7→6,8→5,9（前排中心优先，向两侧扩展）
  _freePlayerBand() {
    const used = new Set((this.allies || []).map(a => a._band).filter(b => b != null));
    if (this.pFig && this.pFig._band != null) used.add(this.pFig._band);
    return nextFreeSlot('friendly', used);
  }

  // 敌方出场战斗点分配（站位管理器）：优先消耗预设 formation 战斗点，重复/溢出时从 10-19 找未占用点（避免波次/召唤与初始阵型重叠）
  _nextFoeSlot() {
    if (!this._foeUsed) this._foeUsed = new Set();
    const f = this._foeFormation;
    if (f && f.all) {
      for (const s of f.all) if (!this._foeUsed.has(s)) { this._foeUsed.add(s); return s; }
    }
    for (let s = 10; s <= 19; s++) if (!this._foeUsed.has(s)) { this._foeUsed.add(s); return s; }
    // 极端情况（阵型+波次+召唤超过 10 个敌方点）：用取模把点压回敌方 10-19 区间，避免越界到友方侧造成重叠
    const fb = 10 + (this.enemies.length % 10);
    this._foeUsed.add(fb);
    return fb;
  }
  // 生成出战宠物 ally Fighter 置于玩家侧战斗点（被 _summon 与进场自动召唤共用，避免重复实现）
  //
  // ★ 取值口径（宠物系统三层数据流）：传入的 pet 是**实例层**的一条（uid/petId/level/hpCur...
  //   共 13 个契约键），静态资质与外观**不在实例上**，必须经 petView().get(petId) 从原型
  //   config/pets.json 现查。旧代码直读 pet.atk/def/mag/spd/name/charId/monsterId ⇒ 实例上全为
  //   undefined ⇒ 数值全 0、模型 404，且 Config.monsters[undefined] 让本函数提前 return（宠物根本不生成）。
  //   字段名一律用 op572 原生名：bodyImage / attack / defense / magicAttack / speed / hpCur·hpMax ...
  _spawnPetAlly(pet, band = null) {
    if (band == null) band = this._freePlayerBand();   // 手动「召唤」默认挑空位；进场自动召唤传显式 petBand
    const p = petView().get(pet && pet.petId) || {};
    if (!p.petId) { this.sm.ui.toast('伙伴数据缺失'); return null; }
    // 模型：op572 原生 bodyImage（等同 AS3 宠物 charId）；缺省回退怪物模板 charId → body
    //   （25/29 怪物模板只有 body 字段，与 _spawnEnemy 同一兜底规则）
    const m = Config.monsters[p.monsterId] || Config.monsters[p.petId] || {};
    const charId = p.bodyImage || m.charId || m.body;
    if (!charId) { this.sm.ui.toast('伙伴模型数据缺失'); return null; }
    const hpMax = n0(p.hpMax), mpMax = n0(p.mpMax);
    const hpCur = p.hpCur != null ? n0(p.hpCur) : hpMax;   // 实例血量优先，缺则以满血入场
    const mpCur = p.mpCur != null ? n0(p.mpCur) : mpMax;
    const petLevel = n0(p.level) || 1;
    // ★ 寿命（仅宠物，C7）：上限 = 50×等级+500；实例持久值优先，缺省满值入场（F4）
    const lifeMax = n0(p.lifeMax) > 0 ? n0(p.lifeMax) : (50 * petLevel + 500);
    const life = p.life != null ? n0(p.life) : lifeMax;
    // ★ F4：寿命为 0 的宠物无法出战（需宠物食物补充寿命）
    if (lifeMax > 0 && life <= 0) {
      this.sm.ui.toast('「' + (p.name || '宠物') + '」寿命已耗尽，需喂食宠物食物补充寿命');
      return null;
    }
    const fig = new Fighter({
      id: 'pet_' + p.petId, name: p.name, charId, level: petLevel,
      hp: hpCur, mp: mpCur,
      life, lifeMax,
      atk: n0(p.attack), def: n0(p.defense), mag: n0(p.magicAttack), spd: n0(p.speed),
      // ★ 五大主属性 + 暴击/闪避（op572 名 → Fighter 名）：被动公式读 fig.stamina/fig.phyCrit
      //   等真实值，与宠物面板的代理数据同一份，保证战斗内外加成一致。
      strength: n0(p.strong), stamina: n0(p.vitality), agility: n0(p.agile),
      intellect: n0(p.intellect), faith: n0(p.belief),
      phyCrit: n0(p.phyBang), phyDodge: n0(p.phyJook),
      magCrit: n0(p.magicBang), magDodge: n0(p.magicJook),
      // variant pet: matrix resolved inside Fighter (variant option) - non-variant loads no filter
      variant: !!(pet && pet.variant), colorMatrix: null,
      rageMax: 0,   // 宠物无怒气系统（F4）：怒气仅人物，宠物用寿命系统
      side: 'player', dir: 'left', showBars: true
    });
    fig.maxHp = hpMax; fig.maxMp = mpMax;
    fig.hp = hpCur; fig.mp = mpCur;
    // 宠物技能栏：手动操控宠物时，技能指令读 fig.skills（技能 id 数组存于实例 pet.skillList）
    fig.skills = Array.isArray(p.skillList) ? p.skillList.slice() : [];
    // ★ 逐技能习得等级（pets.json 的 {sid, level} 结构 → 纯等级表）：被动技能公式按真实技能等级
    //   计算（智慧守护 8/10/14 级），而非笼统回退单位等级。
    const _sl = p.skillLevels || null;
    fig.skillLevels = _sl
      ? Object.fromEntries(Object.entries(_sl).map(([k, v]) => [k, (v && typeof v === 'object') ? (v.level || 1) : v]))
      : null;
    reapplyPassiveBuffs(fig);          // 被动技能（如智慧守护）进场即挂（须在 skills/skillLevels 就绪后；复用实例先回退旧加成）
    fig.portrait = p.portraitImage || null;   // 出手顺序条头像（缺图自动回退「首字 + 阵营色」）
    fig._cdMap = fig._cdMap || {};
    this.characterLayer.appendChild(fig.el);
    fig.battleScale = this.SCALE;   // 召唤兽统一战斗缩放（对齐玩家/敌方）
    fig.hpAbove = true;             // 出战伙伴血条浮于头顶上方（与主城 NPC 同款像素检测，仅位置不同）
    const pp = BattleScene.getFightPoint(band);   // 玩家侧（band 0-9）；进场时位于机器人之后，避免站位重叠
    fig.setPos(pp.x, pp.y);
    fig._home = { x: pp.x, y: pp.y };   // 记录出生战斗点，协同攻击后归位
    fig._band = band;                    // 记录所占战斗点，供手动召唤挑空位
    this.allies.push(fig); this.summonedPet = p.petId;   // 记 petId（原型的物种 id），供 _recall/_endBattleCleanup 反查实例
    this._applyPillBonus(fig);   // 内丹/坐骑统御编辑器(pills 域)对出战伙伴生效
    this._stand(fig);
    return fig;
  }

  // 生成队伍机器人队友 ally Fighter（玩家侧自动参战单位；战斗人员随队伍机器人变多）
  _spawnBotAlly(m, band) {
    const fig = new Fighter({
      id: 'bot_' + m.id, name: m.name, charId: m.charId, level: m.level || 1,
      hp: m.hp || 500, mp: m.mp || 50, atk: m.atk || 80, def: m.def || 40, mag: m.mag || 30, spd: m.spd || 12,
      side: 'player', dir: 'left', showBars: true
    });
    fig.maxHp = m.hp || 500; fig.maxMp = m.mp || 50;
    fig.skills = m.skills || [];    // 机器人队友技能栏（手动操控时可用）
    reapplyPassiveBuffs(fig);
    fig._cdMap = fig._cdMap || {};
    this.characterLayer.appendChild(fig.el);
    fig.battleScale = this.SCALE;   // 机器人统一战斗缩放（对齐玩家/敌方）
    fig.hpAbove = true;
    const pp = BattleScene.getFightPoint(band);   // 玩家侧 band（1..k），与玩家 band0、敌方 band10+ 物理隔离
    fig.setPos(pp.x, pp.y);
    fig._home = { x: pp.x, y: pp.y };
    fig._isBot = true;
    fig._band = band;                    // 记录所占战斗点，供手动召唤挑空位
    this.allies.push(fig);
    this._applyPillBonus(fig);
    this._stand(fig);
    this.mLog(m.name + ' 加入战斗！');
    return fig;
  }

  // 选出血量百分比最低的存活友方单位（玩家/宠物/机器人），供治疗技能(沉水润心等 target=ally)锁定目标
  _lowestHpAlly() {
    const cand = [this.player, ...(this.allies || [])].filter(f => f && f.hp > 0);
    if (!cand.length) return this.player;
    let best = cand[0];
    for (const f of cand) {
      const r1 = f.maxHp ? f.hp / f.maxHp : 0, r2 = best.maxHp ? best.hp / best.maxHp : 0;
      if (r1 < r2) best = f;
    }
    return best;
  }

  // 出战宠物实例（战斗侧唯一口径）：以**实例层 state===1** 为准。
  //   ★ 不用 ui._activePet —— 它是 UI 构造时缓存的 petId，仅由 ui.refreshActivePet() 刷新，
  //     直接调 petState().setActive() 的路径不会更新它，按它取数会取到「已换下的那只」。
  _activePetInst() {
    const ps = petState();
    return (ps && (ps.active || (ps.deployed && ps.deployed[0]))) || null;
  }

  // 召唤（对齐 BATTLE_SUMMON → sendBattleSummon：手动「召唤」指令生成 ally）
  _summon() {
    if (this.summonedPet != null) { this.sm.ui.toast('宠物已在场'); return; }
    const pet = this._activePetInst();
    if (!pet) { this.sm.ui.toast('未设置出战伙伴：在宠物面板把伙伴设为「出战」'); return; }
    const nm = petView().get(pet.petId).name || '伙伴';
    const fig = this._spawnPetAlly(pet, this._petBand || 1);
    if (fig) {
      this.mLog(nm + ' 召唤参战！'); this.sm.ui.toast('召唤 ' + nm + ' 参战');
      playSfx('summon');   // 召唤音
    }
  }

  // 进场自动召唤出战宠物（对齐原客户端：宠物面板设定「出战」的伙伴随玩家一同入场，无需手动「召唤」）
  _autoSummonActivePet(band = 1) {
    if (this.summonedPet != null) return;
    const pet = this._activePetInst();
    if (!pet) return;                    // 未设置出战伙伴则不自动召唤（不刷"未设置"提示）
    const nm = petView().get(pet.petId).name || '伙伴';
    const fig = this._spawnPetAlly(pet, band);
    if (fig) {
      this.mLog(nm + ' 随你出战！');
      playSfx('summon');   // 召唤音
    }
  }

  // 内丹/坐骑统御编辑器(pills 域)对召唤兽生效：按 controlRule 求百分比加成叠加到攻/防/法
  _applyPillBonus(fig) {
    const pills = Config.data.pills || {};
    const list = Array.isArray(pills) ? pills : Object.values(pills);
    list.forEach(p => {
      if (!p || p.type === '坐骑' && false) { /* 坐骑与内丹均生效 */ }
      const layer = (p.layerEffect && p.layerEffect.length) ? Math.max(...p.layerEffect.map(l => Number(l.layer) || 1)) : 1;
      const growth = Number(p.growth) || 1;
      const expr = p.controlRule || 'layer*5';
      const pct = evalFormula(expr, { atk: fig.atk, def: fig.def, mag: fig.mag, level: fig.level, layer, growth, affection: 0 });
      if (isFinite(pct) && pct !== 0) {
        fig.atk = Math.round(fig.atk * (1 + pct / 100));
        fig.def = Math.round(fig.def * (1 + pct / 100));
        fig.mag = Math.round(fig.mag * (1 + pct / 100));
        this.mLog((p.name || '内丹') + ' 统御：伙伴 攻/防/法 +' + Math.round(pct) + '%');
      }
    });
  }

  // 召回（对齐 BATTLE_CALLBACK → sendBattleFlee：把该召唤单位撤出战斗）
  _recall() {
    if (this.summonedPet == null) { this.sm.ui.toast('没有可召回的宠物'); return; }
    const i = this.allies.findIndex(a => a.id === 'pet_' + this.summonedPet);
    if (i >= 0) {
      const a = this.allies[i];
      const pet = (this.sm.ui._pets || []).find(p => p.petId === this.summonedPet);
      if (pet) {
        pet.hpCur = Math.max(0, Math.round(a.hp));
        pet.mpCur = Math.max(0, Math.round(a.mp));
        if (a.lifeMax > 0) {
          pet.life = Math.max(0, Math.round(a.life)); pet.lifeMax = Math.round(a.lifeMax);
          _refillLifeFromPool(pet);
        }
      }
      a.destroy(); this.allies.splice(i, 1);
    }
    this.summonedPet = null;
    // 召回后宠物已脱离 allies，战斗结束的 _endBattleCleanup 不会再回写它，此处立即落盘
    try { petState().save(); } catch (e) {}
    try { this.sm.ui.refresh(); } catch (e) {}   // 召回后 HUD 立即切回空头像（无参战宠物）
    this.mLog('已召回宠物'); this.sm.ui.toast('已召回宠物');
  }

  // ── 捕捉（BATTLE_CATCH=256）───────────────────────────────────────────────────────
  // 规格全部来自 deobfuscated 反编译源码，逐条有出处，无一处自造：
  //
  //   ① 点指令条「捕捉」→ BattlePanel.as::mouseDownHandler
  //        L101  GlobalsGlobal02.BATTLE_STATE = 按钮 id
  //        L120  case BATTLE_CATCH:
  //        L121     faceManager.promptFace.setBottomPromptText(CATCH_SELECT, 220)
  //        L122     setAllPanelAndFaceVisiable(false)      ← 隐藏全部面板（含指令条本身）
  //      ★ 这一步【不发任何协议】，只进入「选目标态」。
  //   ② 点敌人 → BattleScene.as::mouseDownHandler → characterManager.clickCharacter(stageX,stageY) 命中后
  //        L356  case BATTLE_CATCH: requestCommand.sendBattleCatch(_loc2_.pid)
  //      → RequestCommand.as::sendBattleCatch(value) = writeShort(CS_BATTLE_CATCH=38)
  //        + writeShort(SceneManager.reversePosition(value))（单参 = 被点选敌人的 pid）
  //      → 随后 L361 无条件 clickPlayerOrOtherPlayer(null)：BATTLE_STATE=BATTLE_ATTACK + 隐底部提示 + 恢复面板
  //   ③ 收 SC_CATCH_RESULT=54 → HandlerConnection05.as::receiveCatchResult 读取顺序：
  //        attackerPos(short) → defenderPos(short) → result(int) → changeMp(int) → skillImageId(string)
  //        并置 effectTime=3000 → BattleManager.addCatchAnimate → BattleInitializer19.step() 演出（毫秒编排见下）
  //   ④ 右键取消 → GameWorld.as::rightClick L654 → SceneManager.as::clickPlayerOrOtherPlayer(null)
  //        战斗态分支（L797-803）：BATTLE_STATE=BATTLE_ATTACK + hiddenBottomPrompt() + setAllPanelAndFaceVisiable(true)
  //      —— 这正是 lang[30051]「右键取消操作」的实现，本单机版映射到 _cancelTargetSelect()。
  //
  // ★ 关键事实（决定本功能边界）：原版客户端捕捉成功后【只销毁目标，不自己造宠物对象】
  //   （BattleInitializer19 L158 `this._defender.destroy()`），宠物由服务器另行下发
  //   SC_PET_INFO(57) / SC_PET_LIST(75)（HandlerManager.as::setPetInfo 读到的宠物实例自带全套静态属性，
  //   印证宠物【没有独立物种原型表】）。单机版无服务器 ⇒「是否真发一只宠物」是产品决策，尚未裁决 ⇒
  //   当前严格照 AS3 只做销毁，不发放宠物（无臆造数据）。
  //   相关事实（已核实）：13 个可捕捉物种（九命猫/乖乖兔/硬气鼠/赤练蛇/猪坚强/猫妩媚/蝶舞妹/帅气猴/
  //   小海龟/石棘兽/布袋鼠/玄武/九尾，出自 op688 威望商店 type=51 道具 desc）一个都不在
  //   config/monsters.json（该表仅 29 只头目/精英 + 灰野兔/野猫群/变异野猫群/木桩），
  //   也不在 config/pets.json（op572「观察他人宠物」，100 只 / 38 物种，全是高阶宠）。

  // 选目标态文案 = GlobalsGlobal04.CATCH_SELECT ← GlobalsGlobal06.GM_CATCH_SELECT(30051)，
  //   真源 update/i18n/zh_CN/Lang/zh_CN.as :: lang["30051"] =
  //     "请选择你要进行<font color='#F6FA00'>捕捉的目标</font><br>右键取消操作"
  //   （AS3 htmlText 的 <font color=…> 在此映射为等效 <span style=color>，颜色值原样取自 AS3）
  _startCatch() {
    if (this.busy || this._ended) return;
    // 对齐 BattlePanel.mouseDownHandler case BATTLE_CATCH：只进入选目标态，不发协议
    this.catching = true;
    this.battleState = B.CATCH;
    this._highlightCmd();
    // setBottomPromptText(CATCH_SELECT, 220)：220 = AS3 该参数语义为【最大宽度】不是时长
    this._showBottomPrompt('请选择你要进行<span style="color:#F6FA00">捕捉的目标</span><br>右键取消操作');
    // setAllPanelAndFaceVisiable(false)：隐藏全部面板与全部 face（指令条 / 顺序条 / 技能栏都在其列）
    this._setBattleHud('select');
  }

  // 发送 CS_BATTLE_CATCH 并播放整段演出（② + ③）
  async _doCatch() {
    const target = this.eFig;
    if (this.busy || this._ended) return;
    if (!target || target.hp <= 0) { this.sm.ui.toast('请选择要捕捉的敌人'); return; }
    // 点选完成 ⇒ 退出选目标态并进入行动演出（对齐 BattleScene.mouseDownHandler 末尾无条件
    //   clickPlayerOrOtherPlayer(null) 恢复面板，随后 startRound 移除指令条 + 技能栏盖遮罩）
    this.catching = false;
    this._hideBottomPrompt();
    this._setBattleHud('act');
    this.battleState = B.ATTACK;
    this._highlightCmd();

    this.busy = true;
    const attacker = this._ctrlFig() || this.pFig;
    // pid ↔ 战斗点：formation.js 口径（友方 0-9 / 敌方 10-19）与 AS3 pid 语义一致。
    // reversePosition(SceneManager.as L941)：仅当 player.pid > 9 才重映射；单机版主角 pid=2 ≤ 9 ⇒ 恒等映射，原样发送。
    const attackerPos = (attacker && attacker._band != null) ? attacker._band : 2;
    const defenderPos = (target._band != null) ? target._band : 10;
    this.mLog((attacker ? attacker.name : '你') + ' 尝试捕捉 ' + target.name + '…');
    let res = null;
    try {
      res = await requestCommand(CMD.BATTLE_CATCH, {
        attackerPos, defenderPos,
        monsterId: target._monsterId, npcId: target._npcId,
        name: target.name, hp: target.hp, hpMax: target.maxHp
      });
    } catch (e) {
      console.error('[battle] CS_BATTLE_CATCH 异常', e);
    }
    if (this._ending || this._ended) { this.busy = false; return; }
    await this._playCatchAnim(attacker, target, res || {});
    this.busy = false;
    this._highlightCmd();
  }

  /**
   * 捕捉演出。时间轴严格取自 BattleInitializer19.step()（毫秒）：
   *   25   攻击者 WALK 前冲（AS3: WalkAnimate1(getWalkEndPoint(defender,40), 500ms)）
   *   550  停走 → 攻击者 CAST 帧；defender 叠 GlobalsLoader.getCharacter("catch") 特效；
   *        攻击者回蓝飘字（ANIMATE_HPMPSP(...,changeMp,...,500)，显示 changeMp）
   *   1400 defender 清技能精灵；攻击者 WALK 反向退回 _attackerPoint（AS3 1400ms）
   *   1500 defender 分叉走位：result==1 → 走向 _attackerPoint（1400ms）；
   *                            result!=1 → 走到「攻击者与自身的中点」（700ms）
   *   2200 (失败) defender STAND
   *   2250 (失败) defender 反向 WALK 回 _defenderPoint（650ms）
   *   2800 攻击者 STAND
   *   2900 result==1 → defender.destroy()；result!=1 → defender STAND
   * ★ 唯一简化：走位改用 JS 引擎现成的 _approach/_retreat/moveTo（速度驱动），故实际走位耗时与 AS3
   *   的固定 500/1400/700/650ms 不完全相等；关键节点（25/550/1400/1500/2200/2250/2800/2900）严格按 AS3 计时。
   */
  async _playCatchAnim(attacker, defender, res) {
    const result = (Number(res.result) === 1) ? 1 : 0;
    const changeMp = Math.round(Number(res.changeMp) || 0);
    const homeOf = (f) => {
      if (!f) return null;
      if (f._home) return { x: f._home.x, y: f._home.y };
      return { x: f.x, y: f.y };
    };
    const attackerPoint = homeOf(attacker);
    const defenderPoint = homeOf(defender);
    const actorOk = (f) => !!(f && f.hp > 0 && !f._down && typeof f.moveTo === 'function');

    // ── 25ms：攻击者前冲 ─────────────────────────────────────────────────────
    await this._wait(25);
    if (this._ending || this._ended) return;
    let approachP = null;
    if (actorOk(attacker) && defender) approachP = Promise.resolve(this._approach(attacker, defender)).catch(() => {});

    // ── 550ms：CAST + catch 特效 + 回蓝飘字 ─────────────────────────────────
    await this._wait(525);
    if (this._ending || this._ended) return;
    if (actorOk(attacker) && typeof attacker.act === 'function') {
      try { attacker.act(ACTION.CAST, attacker.dir, { scale: this.SCALE }); } catch (e) {}
    }
    if (defender) this._floatAnim(defender, 'catch', { dur: BATTLE_FX.catch });
    if (actorOk(attacker) && changeMp) this._floatNumber(attacker, NUM_TYPE.MP, changeMp);

    // ── 1400ms：攻击者退回原位 ──────────────────────────────────────────────
    await this._wait(850);
    if (this._ending || this._ended) return;
    if (approachP) { try { await approachP; } catch (e) {} }   // 等前冲真正收敛，避免与退回位移打架
    if (this._ending || this._ended) return;
    if (actorOk(attacker)) Promise.resolve(this._retreat(attacker)).catch(() => {});

    // ── 1500ms：defender 按 result 分叉走位 ─────────────────────────────────
    await this._wait(100);
    if (this._ending || this._ended) return;
    const defenderWalk = (async () => {
      if (!actorOk(defender)) return;
      if (result === 1) {
        if (!attackerPoint) return;
        await defender.act(ACTION.WALK, defender.dir, { scale: this.SCALE });
        await defender.moveTo(attackerPoint.x, attackerPoint.y);
      } else if (attackerPoint && defenderPoint) {
        // AS3：_loc2_ = 0.5*(攻击者 - 自身) + 自身 ⇒ 攻击者与自身的中点
        const midX = 0.5 * (attackerPoint.x - defender.x) + defender.x;
        const midY = 0.5 * (attackerPoint.y - defender.y) + defender.y;
        await defender.act(ACTION.WALK, defender.dir, { scale: this.SCALE });
        await defender.moveTo(midX, midY);
      }
    })().catch(() => {});

    // ── 2200ms（失败侧）：defender STAND ────────────────────────────────────
    await this._wait(700);
    if (this._ending || this._ended) return;
    if (result !== 1 && actorOk(defender) && typeof defender.act === 'function') {
      try { defender.act(ACTION.STAND, defender.dir, { scale: this.SCALE }); } catch (e) {}
    }

    // ── 2250ms（失败侧）：defender 反向走回原点 ─────────────────────────────
    await this._wait(50);
    if (this._ending || this._ended) return;
    if (result !== 1 && actorOk(defender) && defenderPoint) {
      try { defender.dir = (defender.side === 'enemy') ? 'right' : 'left'; } catch (e) {}
      Promise.resolve(defender.moveTo(defenderPoint.x, defenderPoint.y)).catch(() => {});
    }

    // ── 2800ms：攻击者 STAND ────────────────────────────────────────────────
    await this._wait(550);
    if (this._ending || this._ended) return;
    if (actorOk(attacker)) Promise.resolve(this._stand(attacker)).catch(() => {});

    // ── 2900ms：收尾（成功销毁 / 失败归位）──────────────────────────────────
    await this._wait(100);
    try { await defenderWalk; } catch (e) {}
    if (this._ending || this._ended) return;
    if (result === 1) {
      // ★ AS3 原句：this._defender.destroy() —— 客户端只销毁目标，不自己造宠物对象
      //   单机版补发宠物（用户裁决 aw）：物种/等级/品级/成长率/技能与战斗内观察到的一致。
      const caught = this._grantCaughtPet(defender);
      this._removeCaught(defender);
      this.mLog('捕捉成功！' + (caught ? '获得宠物「' + caught.name + '」' : ''));
      if (this.sm.ui && this.sm.ui.toast) this.sm.ui.toast(caught ? '捕捉成功！获得「' + caught.name + '」' : '捕捉成功！');
      if (caught && this.sm.ui && this.sm.ui.refresh) this.sm.ui.refresh();
    } else {
      if (defender && defender.hp > 0 && !defender._down && typeof defender.act === 'function') {
        try { defender.act(ACTION.STAND, (defender.side === 'enemy') ? 'right' : 'left', { scale: this.SCALE }); } catch (e) {}
      }
      this.mLog('捕捉失败…');
      if (this.sm.ui && this.sm.ui.toast) this.sm.ui.toast('捕捉失败…');
    }
  }

  /**
   * 捕捉成功后把目标移出战斗。对应 AS3 BattleInitializer19 L158 `this._defender.destroy()`
   * （Fighter.destroy = 隐藏 + 复位 pid/cid + 回收 SWF 与全部战斗层挂件；JS 侧对应 RolePool.release）。
   * ★ 与 _onEnemyDown 的区别：捕捉【不是击杀】⇒ 不发经验/金币/掉落、不写任务进度、不推进副本波次、不播倒地。
   */
  _grantCaughtPet(fig) {
    if (!fig) return null;
    try {
      // ★ ay：物种键 = family（角色表查表/面板展示用）；唯一编码 petId 由 pet-state.addFromProto 生成。
      const family = fig.family || fig.name;
      // ★ 用户裁决（2026-10-04）：捕捉后的宠物【一律走资质型】——数值配置型怪（BOSS/木桩）
      //   战斗时用的是模板数值，捕捉时转回等级 1、属性由「资质×成长率」公式重新派生；
      //   技能保留战斗中实际携带的（fig.skills），为空则用物种技能池随机派生。
      let level = Math.max(1, Math.floor(Number(fig.level) || 1));
      let hpCur = Math.max(1, Math.round(Number(fig.hp) || 1));
      let mpCur = Math.max(0, Math.round(Number(fig.mp) || 0));
      let grade = fig.grade || null;
      let variant = !!fig.variant;
      let growRate = Number(fig.growRate) || null;
      let skillList = Array.isArray(fig.skills) ? fig.skills.map(x => Number(x)).filter(x => x > 0) : [];
      let skillLevels = (fig.skillLevels && typeof fig.skillLevels === 'object') ? fig.skillLevels : {};
      if (fig._fixedStats) {
        const char0 = lookupChar(family) || { name: String(family), kind: 'monster', race: null, catchable: false, skillPool: [] };
        const unit = genUnit(char0, 1);
        level = 1;
        hpCur = Math.max(1, Math.round(unit.derived.maxHp));
        mpCur = Math.max(0, Math.round(unit.derived.maxMp));
        grade = unit.grade; variant = unit.variant; growRate = unit.growRate;
        if (!skillList.length && Array.isArray(unit.skills)) {
          skillList = unit.skills.map(x => Number(x)).filter(x => x > 0);
          skillLevels = unit.skillLevels || {};
        }
      }
      const proto = {
        family: String(family),
        level, hpCur, mpCur, skillList, skillLevels, grade, variant, growRate,
      };
      const inst = petState().addFromProto(proto);
      petState().save();
      // ★ bi：宠物面板若正打开，立即刷新列表（视图是渲染时的快照，不会自动跟进 live list）
      try {
        const pm = window.__panelManager;
        const pp = pm && pm.panels && pm.panels['pet'];
        if (pp && pp.refresh && pp.dom && pp.dom.style.display !== 'none') pp.refresh();
      } catch (e) { console.warn('[catch] 刷新宠物面板失败（不阻断）：', e); }
      return inst;
    } catch (e) { console.warn('[catch] 登记宠物失败（不阻断战斗）：', e); return null; }
  }

  _removeCaught(fig) {
    if (!fig) return;
    fig._down = true;                                   // 标记已离场，阻断残留受击/位移回调
    try { fig.clearBuffs(); } catch (e) {}
    this.enemies = this.enemies.filter(e => e !== fig);
    if (this.eFig === fig) this.eFig = this.enemies.find(e => e.hp > 0) || null;
    try { RolePool.release(fig); } catch (e) {}
  }

  // 右键取消选目标态（= lang[30051]「右键取消操作」）：
  //   对齐 GameWorld.rightClick L654 → SceneManager.clickPlayerOrOtherPlayer(null) 的战斗态分支（L797-803）：
  //     BATTLE_STATE = BATTLE_ATTACK；hiddenBottomPrompt()；setAllPanelAndFaceVisiable(true)
  //   ★ 仅在确实处于「非默认态」（捕捉/技能选目标、或指令态 ≠ 普攻）时复位——AS3 是无条件复位，
  //     但 JS 侧无条件复位会顺带关掉技能子条等无关 UI；此处按同一语义收窄触发条件，行为等价、副作用更小。
  _cancelTargetSelect() {
    if (this._ended || this._ending) return;
    const dirty = this.catching || this.pendingSkill || this.pendingItem || this.battleState !== B.ATTACK || this.subRow || this.itemPanel;
    if (!dirty) return;
    this.catching = false;
    this.pendingSkill = null;
    this.pendingItem = null;
    this.battleState = B.ATTACK;
    this._hideBottomPrompt();
    // 取消选目标 ⇒ 回到玩家下令窗口（对齐 AS3 clickPlayerOrOtherPlayer(null) 的
    //   setAllPanelAndFaceVisiable(true)：面板与全部 face 恢复显示）
    this._setBattleHud('cmd');
    this._closeSubRow();
    this._highlightCmd();
  }

  // 底部系统提示显示/隐藏（对齐 face/PromptFace.as::setBottomPromptText / hiddenBottomPrompt）
  _showBottomPrompt(html) {
    const el = this.bottomPromptEl;
    if (!el) return;
    el.innerHTML = html;
    el.classList.add('show');
  }
  _hideBottomPrompt() {
    const el = this.bottomPromptEl;
    if (!el) return;
    el.classList.remove('show');
    el.innerHTML = '';
  }
  // 战斗 HUD 三态显隐（严格对齐 AS3 战斗面板 / 快捷键栏的显隐规则）：
  //   'cmd'    玩家下令窗口（= AS3 BattlePanel.showPlayerOrPet 显示 + SceneManager.setAllPanelAndFaceVisiable(true)）
  //            → 指令条与出手顺序条显示，技能热键栏显示且无遮罩
  //   'act'    单位行动 / 回合演出中（= AS3 BattleManager.startRound → stopCounter：移除指令条 + ShortCutFace.setAllMask(true)）
  //            → 指令条与顺序条隐藏，技能栏保持显示但盖半透明遮罩（栏体可见、不可用）
  //   'select' 选目标态（= AS3 SceneManager.setAllPanelAndFaceVisiable(false)：面板与全部 face 一起隐藏）
  //            → 指令条 / 顺序条 / 技能栏全部隐藏
  //   'result' 战斗结算窗口（_win/_lose 的「继续」按钮，Web 版自增交互；AS3 胜负由服务器 battleStop 直接回城）
  //            → 指令条显示（容纳继续按钮）、顺序条隐藏、技能栏撤遮罩
  //   'end'    战斗结束（= AS3 SceneManager.stopBattle：移除指令条 + ShortCutFace.setAllMask(false)）
  //            → 指令条/顺序条随战斗 DOM 销毁，技能栏撤遮罩并恢复主城常显
  // ★ 出手顺序条是 Web 版自增控件（AS3 无），按用户裁决与指令条同步显隐（结算窗口无出手顺序，不显示）。
  // ★ 技能热键栏挂在 #ui-layer（在战斗层之外），战斗 DOM 销毁不会自动复位其显隐/遮罩，必须在此显式管理。
  _setBattleHud(state) {
    // 用户裁决口径（2026-10-05）：技能栏与顺序条「战斗中保持显示，回合演出期间」分别隐藏 / 降至 35% 透明。
    //   act（回合演出）：指令条隐藏、顺序条显示但 .battle-dim(35%)、技能栏隐藏
    //   cmd（下令窗口）：全部正常显示
    //   select（选目标）：技能栏+顺序条保持全显示（用户明确不要在这里隐藏），指令条隐藏
    //   result（结算）：「继续」按钮已删，指令条无需容器；顺序条隐藏；技能栏显示
    //   end（退战）：全部恢复主城常显（技能栏常显、顺序条/指令条隐藏）
    this._hudState = state;
    const showCmd = (state === 'cmd');
    const showOrder = (state === 'cmd' || state === 'act' || state === 'select');
    const dimOrder = (state === 'act');
    const showBar = (state !== 'act');   // 仅回合演出期间隐藏技能栏；退战后恢复主城常显
    if (this.cmd) this.cmd.style.display = showCmd ? '' : 'none';
    if (this.orderBar) {
      this.orderBar.style.display = showOrder ? '' : 'none';
      this.orderBar.classList.toggle('battle-dim', dimOrder);
    }
    const ui = this.sm && this.sm.ui;
    if (ui && ui.skillbar) ui.skillbar.style.display = showBar ? '' : 'none';
  }

  // 兼容旧调用面：flag=true ⇒ 回到下令窗口（'cmd'），false ⇒ 选目标态（'select'）
  _setCmdVisible(flag) { this._setBattleHud(flag ? 'cmd' : 'select'); }

  // 召唤兽协同回合（对齐 addSummonAnimate：ally Fighter 每回合攻击敌人）
  // 宠物指令条回调（攻击 / 技能 / 防御）——宠物被操控时的指令入口
  _petCmd(id) {
    const pet = this._ctrlFig();
    if (!pet || pet === this.pFig) return;
    if (id === B.ATTACK) {
      this.battleState = B.ATTACK; this._highlightCmd();
      this.sm.ui.toast('点击敌人，令 ' + pet.name + ' 发动普通攻击');
    } else if (id === B.CAST) {
      if (pet.mp < 1) { this.sm.ui.toast(pet.name + ' 法力不足'); return; }
      this.battleState = B.CAST; this._highlightCmd();
      this._showSkillChooser(pet);   // 宠物技能栏（与操控对象联动）
    } else if (id === B.DEFEND) {
      this._petTurn('defend');
    }
  }

  /**
   * 宠物行动（手动操控）：攻击 / 技能 / 防御。
   * 攻击＝单独点选目标后普通攻击（与玩家普攻同流程：移动→挥击(与伤害同时)→归位）。
   */
  async _petTurn(kind) {
    const pet = this._ctrlFig();
    if (!pet || pet === this.pFig) { this._playerTurn(kind); return; }
    if (this.busy || this._ended) return;
    this.busy = true;
    this._stopTurnTimer();
    this._closeSubRow();
    // 出手即退出选目标态（同 _playerTurn：隐藏底部提示 + 进入行动演出态）
    this._hideBottomPrompt();
    this._setBattleHud('act');
    try {
      if (kind === 'defend') {
        pet.defending = true;
        // ★ 防御"受击"动画只在被攻击时由 _underfire 播放；此处仅进入防御态，不播受击动画。
        this.mLog(pet.name + ' 摆出防御姿态');
        playSfx('defend');
        await this._act(pet, ACTION.STAND);
      } else if (kind === 'cast') {
        const s = this.pendingSkill;
        if (!s) { this.sm.ui.toast('未选择技能'); return; }
        pet.costMp(s.mpCost);
        if (s.mpCost) this._floatNumber(pet, NUM_TYPE.MP, -s.mpCost);
        if (s.rageCost && pet.rageMax > 0) { pet.costRage(s.rageCost); this._floatNumber(pet, NUM_TYPE.RAGE, -s.rageCost); }   // 怒气（罕见：宠物通常无怒气）
        if (s.lifeCost && pet.lifeMax > 0) { pet.costLife(s.lifeCost); this._floatNumber(pet, NUM_TYPE.HP, -s.lifeCost); }   // 寿命消耗（仅宠物）
        // 目标：纯友方/敌我技能取点选的己方单位(aFig)，否则取点选敌人(eFig)
        let primary = this.eFig;
        if (s && (s.target === 'ally' || s.target === 'enemyOrAlly') && this.aFig) primary = this.aFig;
        await this._engineCast(pet, s, primary);
        this.pendingSkill = null;
        this.aFig = null;
      } else {   // attack
        const tgt = (this.eFig && this.eFig.hp > 0) ? this.eFig : this._firstAliveEnemy();
        if (!tgt) { this.sm.ui.toast('无可用目标'); return; }
        playSfx('attack');
        await this._approach(pet, tgt);              // 走向点选目标
        const atkP = pet.act(ACTION.ATTACK, pet.dir, { scale: this.SCALE, loop: false, freezeLast: true });
        emitEvent(this, EVENTS.BEFORE_ATTACK, { source: pet, target: tgt, skillType: 'normal' });   // ★ 攻击前
        const cres = this._calcDamage(pet, tgt, { formulaId: 'ally_damage' });
        // 伤害数字由引擎唯一出口 applyRaw 飘出（含暴击 1.3x）→ 此处不可再飘
        const got = applyIncoming(this, tgt, cres.dmg, { attacker: pet, viaNormalAttack: true, canDodge: !hasTaunt(pet), crit: cres.crit });
        this._dmgDealt += cres.dmg;
        playSfx('hit');
        if (cres.crit) playSfx('crit');
        this.mLog(pet.name + ' 攻击 ' + tgt.name + '，造成 ' + got + ' 伤害' + (cres.crit ? '（暴击）' : ''));
        await this._awaitAttack(pet, atkP);          // 等挥击播完再归位
        if (tgt.hp <= 0) await Promise.all([ this._retreat(pet), this.onDeath(tgt) || Promise.resolve() ]);
        else { setTimeout(() => { if (tgt.hp > 0) this._stand(tgt); }, 420); await this._retreat(pet); }
        // ★ AFTER_ATTACK：召唤兽普攻结算完毕
        emitEvent(this, EVENTS.AFTER_ATTACK, { source: pet, target: tgt, value: got, skillType: 'normal' });
      }
    } catch (err) {
      console.error('[战斗] 宠物指令执行异常，已安全跳过：', err);
      this.mLog('宠物指令执行异常，已跳过');
    }
    this.busy = false;
    this._resolveUnitCmd();                          // 唤醒等待中的宠物回合
  }

  // 战斗结束：写回召唤兽当前血量并清理 ally（对齐 battleEnd 后回写宠物属性）
  _endBattleCleanup() {
    let petTouched = false;
    this.allies.forEach(a => {
      const pet = petState().byPetId(String(a.id).replace('pet_', ''));   // 实例层反查（ui._pets 即 store.list）
      if (pet) {
        pet.hpCur = Math.max(0, Math.round(a.hp));
        pet.mpCur = Math.max(0, Math.round(a.mp));
        if (a.lifeMax > 0) {
          pet.life = Math.max(0, Math.round(a.life)); pet.lifeMax = Math.round(a.lifeMax);
          _refillLifeFromPool(pet);
        }
        petTouched = true;
      }
      a.destroy();
    });
    // ★ 回写后立即落盘（用户裁决 2026-09-17：与原版一致，宠物血量/法力跨战斗与跨刷新保留）
    if (petTouched) petState().save();
    // ★ 回写后刷新 HUD：右上宠物头像的血/蓝条立即跟随战斗结果，否则仍是战前值
    try { this.sm.ui.refresh(); } catch (e) {}
    this.allies = []; this.summonedPet = null;
    // 复位捕捉选目标态 + 底部提示 + 战斗 HUD（'result'：指令条留给 _win/_lose 的「继续」按钮，技能栏撤遮罩）
    this.catching = false;
    this._hideBottomPrompt();
    this._setBattleHud('result');
    // 清除玩家所有战斗状态：pFig 即 player 本体，buff/状态动画/属性加成/侠义之心会随 .el 带回大地图，
    // 故战斗结束必须清掉；同时移除操控高亮(fighter-ctrl 金边)，否则主角模型在大地图上残留发光与 buff 图标/状态动画
    if (this.player) {
      if (typeof this.player.clearBuffs === 'function') this.player.clearBuffs();
      if (this.player.el) this.player.el.classList.remove('fighter-ctrl');
      // ★ 作废仍在飞行的阵亡演出回调：pFig 是战斗/主城共用的常驻实例，主角阵亡走 _lose() 的
      //   die() 演出；若玩家在 900ms 演出走完前点「返回主城」，残余回调会把主城坐标改回战斗点、
      //   或把模型可见性留成 hidden。此处统一作废 + 复位本体可见性。
      if (typeof this.player._cancelDeathFx === 'function') this.player._cancelDeathFx();
    }
    this._ctrl = null;
  }

  // 战斗结束：存活敌方实例回收到对象池（阵亡的已在 _onEnemyDown 即时回收）。
  // 与 _endBattleCleanup 清 ally 对称；玩家(pFig)是常驻实例、不在 enemies 内，不入池。
  _releaseEnemies() {
    for (const e of this.enemies) {
      if (e === this.pFig) continue;       // 防御：enemies 理论不含玩家
      RolePool.release(e);                 // 暂停动画 + 摘离 el，保留 DOM 待同模型怪物复用
    }
    this.enemies = [];
  }

  // 技能选择子条（对齐 技能指令 → playerSkillPanel2）
  // caster 省略时为玩家技能栏；传入宠物时展示【宠物技能栏】（与操控对象切换联动）
  _showSkillChooser(caster) {
    const unit = caster || this.player;
    const isPet = !!(unit && unit !== this.player);
    this._openSubRow((row) => {
      // cc: passives are never castable - this panel is for picking skills to cast
      const skills = (unit.skills || []).map(id => Config.skills[id]).filter(s => s && !s.passive);
      if (!skills.length) { row.innerHTML = '<span class="empty-tip">无技能</span>'; return; }
      skills.forEach(s => {
        const b = document.createElement('button');
        b.className = 'battle-cmd-btn skill';
        const cd = (unit._cdMap && unit._cdMap[s.id]) || 0;   // 剩余冷却回合（仅作信息展示，不再禁用按钮）
        const cdTxt = cd > 0 ? ' ·冷却' + cd : '';
        b.innerHTML = '<img class="btn-bg" src="' + url.gwImg('img40') + '" alt="" onerror="this.style.display=\'none\'" /><span class="txt"><img class="cmd-ic" src="' + url.icon('skill', s.icon) + '" alt="" onerror="this.style.display=\'none\'" />' + s.name + '<small>蓝' + s.mpCost + cdTxt + '</small></span>';
        // 修复"技能用完就按不了"：冷却不再禁用按钮，仅 MP 不足才置灰；MP 每回合回复(maxMp*0.2，玩家300→+60)保证技能下回合可再次释放
        // 费用包含怒气（仅人物）与寿命（仅宠物）；任一不足即置灰
        const costTxt = ((s.rageCost && unit.rageMax > 0) ? ' 怒' + s.rageCost : '') + (s.lifeCost ? ' 寿' + s.lifeCost : '');
        b.disabled = unit.mp < (s.mpCost || 0)
          || (s.rageCost && unit.rageMax > 0 && unit.rage < s.rageCost)
          || (s.lifeCost && unit.lifeMax > 0 && unit.life < s.lifeCost);
        if (costTxt) { const sm = b.querySelector('small'); if (sm) sm.textContent += costTxt; }
        b.onclick = () => {
          this.pendingSkill = s; this.battleState = B.CAST;
          this._closeSubRow(); this._highlightCmd();
          // 自身/友方治疗与纯增益技能：选即释放，无需点选敌人
          if (s.heal || ((s.buffs && s.buffs.length) && !s.power)) {
            if (isPet) this._petTurn('cast'); else this._playerTurn('cast');
          } else {
            // 对齐 AS3 BattleManager.useSkill → setBottomPromptText(CAST_SELECT, 220) +
            //   setAllPanelAndFaceVisiable(false)：「请选择你要使用<font color='#F6FA00'>技能的目标</font><br>右键取消操作」（lang[30052]）
            this._showBottomPrompt('请选择你要使用<span style="color:#F6FA00">技能的目标</span><br>右键取消操作');
            this._setBattleHud('select');
          }
        };
        row.appendChild(b);
      });
    });
  }

  // 道具选择面板（对齐 道具指令 → showPlayerBattItem；UI 改为和背包一样的格子面板 + 悬浮窗）
  // ★ 可用判据 = 战斗药品类（CategoryType=battleMed）且效果表里真实映射了原子效果（hasItemEffect）：
  //   items.json 的药水 type 是数字 '40'（旧代码误判 'potion' ⇒ 道具菜单恒为空，已修）。
  //   分类配置未加载时退回「全部有效果道具」（旧口径兜底）。
  _showItemChooser() {
    this._closeSubRow();
    const pots = (this.player.bag || []).map(s => ({ slot: s, def: Config.items[s.itemId] }))
      .filter(x => x.def && hasItemEffect(x.slot.itemId) &&
        (!categoriesReady() || classifyItem(x.def).cat === 'battleMed'));
    if (this.cmdRow) this.cmdRow.style.display = 'none';

    const el = document.createElement('div');
    el.className = 'battle-item-panel';
    el.innerHTML =
      '<div class="bip-head"><span>战斗药品</span><button class="bip-close" title="关闭">×</button></div>' +
      '<div class="bip-grid"></div>';
    const grid = el.querySelector('.bip-grid');
    if (!pots.length) {
      grid.innerHTML = '<div class="bag-empty">无可用道具</div>';
    } else {
      for (const { slot, def } of pots) {
        const cell = document.createElement('div');
        cell.className = 'bag-cell';
        cell.innerHTML = iconImg(itemIconSrcs(def), 'bag-ic') +
          (slot.count > 1 ? '<div class="bag-count">' + slot.count + '</div>' : '');
        cell.onmouseenter = () => showItemTip(def, this.player, cell);
        cell.onmouseleave = hideItemTip;
        cell.onclick = (e) => {
          e.stopPropagation();
          // 对齐 AS3 BattleManager.useItem → setBottomPromptText(ITEM_SELECT, 220) +
          //   setAllPanelAndFaceVisiable(false)：「请选择你要使用<font color='#F6FA00'>物品的目标</font><br>右键取消操作」（lang[30053]）；
          //   随后 BattleScene.mouseDownHandler case BATTLE_USE_ITEM → sendBattleUseItem(pid, bagId, itemIndex)。
          //   Web 端道具效果只对自身（heal_hp/heal_mp），故「目标」仅作 AS3 交互对齐，效果仍作用于玩家。
          this.pendingItem = slot.itemId; this.battleState = B.ITEM;
          this._closeSubRow(); this._highlightCmd();
          this._showBottomPrompt('请选择你要使用<span style="color:#F6FA00">物品的目标</span><br>右键取消操作');
          this._setBattleHud('select');
        };
        grid.appendChild(cell);
      }
    }
    // 面板上的点击不穿透到战斗舞台（否则 _handleBattleClick 会把点击误判为「选目标/普攻」）
    el.addEventListener('click', e => e.stopPropagation());
    // 右键不拦截：冒泡到 battleStage 的 _onBattleCancel → _cancelTargetSelect → 关面板（右键取消操作）
    el.querySelector('.bip-close').onclick = (e) => { e.stopPropagation(); this._closeSubRow(); };
    wireIconFallback(grid);

    this.itemPanel = el;
    this.battleStage.appendChild(el);
  }

  /**
   * 战斗内消耗 1 件道具。
   * ★ 必须走权威 InventoryManager（bootInventory 绑定的那个）+ commit：
   *   只改 this.player.bag 视图的话，_awardKill 的奖励/战后刷新会把背包抹回登录快照（扣减白扣、丢档）。
   * 物品系统未启动（异常兜底）时才退回直接改视图，并提示。
   * @returns {boolean} 是否扣减成功
   */
  _consumeBattleItem(itemId) {
    const id = Math.trunc(Number(itemId));
    if (!Number.isFinite(id)) return false;
    const boot = inventoryBooted();
    if (boot && boot.inv) {
      const r = boot.inv.removeItemById(id, 1);
      if (r && r.ok) { inventoryCommit('battle-item'); return true; }
      console.warn('[battle] 道具扣减失败：', r && r.reason);
      return false;
    }
    const slot = (this.player.bag || []).find(s => s && Number(s.itemId) === id);
    if (slot) {
      slot.count -= 1;
      if (slot.count <= 0) this.player.bag = (this.player.bag || []).filter(b => b !== slot);
      return true;
    }
    return false;
  }

  _openSubRow(fill) {
    this._closeSubRow();
    this.subRow = document.createElement('div');
    this.subRow.className = 'battle-cmd-row sub';
    this.cmd.appendChild(this.subRow);
    if (this.cmdRow) this.cmdRow.style.display = 'none';
    fill(this.subRow);
  }
  _closeSubRow() {
    if (this.subRow) { this.subRow.remove(); this.subRow = null; }
    if (this.itemPanel) { this.itemPanel.remove(); this.itemPanel = null; }
    if (this.cmdRow) this.cmdRow.style.display = '';
  }

  // 点击敌人：按当前战斗状态派发（对齐 BattleScene.mouseDownHandler）
  _onTargetClick() {
    if (this.busy) return;
    // 捕捉选目标态优先：对齐 BattleScene.as L356 `case BATTLE_CATCH: sendBattleCatch(_loc2_.pid)`
    //   （AS3 里 BATTLE_STATE=BATTLE_CATCH 时点击命中敌人即发协议，不走普通攻击）
    if (this.catching || this.battleState === B.CATCH) { this._doCatch(); return; }
    // 按【当前操控对象】派发：宠物被操控时走宠物行动，否则走玩家行动
    const ctrl = this._ctrlFig();
    const isPet = !!(ctrl && ctrl !== this.pFig);
    if (this.battleState === B.ATTACK) { if (isPet) this._petTurn('attack'); else this._playerTurn('attack'); }
    else if (this.battleState === B.CAST) { if (isPet) this._petTurn('cast'); else this._playerTurn('cast'); }
    else if (this.battleState === B.ITEM) { if (isPet) this._petTurn('item'); else this._playerTurn('item'); }
    else this.sm.ui.toast('请先在指令条选择行动');
  }

  // 回合横幅（对齐 showCountImg：每回合重新淡入「第 N 回合」）
  _showRound() {
    if (!this.roundEl) return;
    this.roundEl.textContent = '第 ' + this.round + ' 回合';
    this.roundEl.classList.remove('pop'); void this.roundEl.offsetWidth; this.roundEl.classList.add('pop');
  }

  // 每回合倒计时（对齐 updateTimerField：居中数字图刷新回合数倒计时）
  // ★已移除"超时自动施放"：原逻辑在 30 秒无操作时强制 _playerTurn('attack')，
  //   会替玩家擅自出手（宠物改为手动操控后更不可接受）。现仅作纯展示倒计时，归零即停、不触发任何行动。
  _startTurnTimer() {
    this._stopTurnTimer();
    this._turnLeft = 30;
    this._updateTimerField();
    this._turnTimer = setInterval(() => {
      this._turnLeft -= 1;
      this._updateTimerField();
      if (this._turnLeft <= 0) this._stopTurnTimer();   // 归零只停表，不自动行动
    }, 1000);
  }
  _stopTurnTimer() {
    if (this._turnTimer) { clearInterval(this._turnTimer); this._turnTimer = null; }
    this._updateTimerField(true);
  }
  _updateTimerField(clear) {
    if (!this.timerEl) return;
    this.timerEl.textContent = clear ? '' : String(this._turnLeft);
    this.timerEl.classList.toggle('low', !clear && this._turnLeft <= 5);
  }

  // ── 行动顺序（按速度 initiative）────────────────────────────────────────
  // 全部单位（主角 / 伙伴机器人 / 敌人）按 spd 降序排成「行动队列」，每回合从队首走到队尾；
  // 轮到谁谁行动：敌方走 AI，我方可操控单位自动把操控权交给该单位（右侧面板随之切换），玩家直接下令，无需手动选择操控对象。
  // 一个单位在一回合的行动队列里只出现一次（即"一回合只能操纵一次"的约束天然成立），不再有阶段式"先主角→再宠物→再敌人"。
  async _startBattleLoop() {
    // ★ 被动技能（如智慧守护）：开战时为在场全部单位挂上其技能表声明的被动 buff（幂等，重复挂安全）
    for (const f of [this.pFig, ...(this.allies || []), ...(this.enemies || [])].filter(Boolean)) {
      applyPassiveBuffs(this, f);
    }
    while (!this._ended) {
      this._roundStart();                       // 每回合回蓝一次（整队共用同一回合节奏）
      // ── 游标行动队列（TCA 阶段1）：由 for-of 改为 actionQueue + _queueCursor，
      //    使 insertImmediate（疾风/邀战/反击）可在中途插队；已行动段（游标之前）永不被重排。
      this.actionQueue = this._buildTurnOrder();
      this._turnOrder = this.actionQueue;        // 出手顺序条与队列同引用
      this._queueCursor = 0;
      this._extraTurnCount = {};                 // 单回合插队计数（上限见 insertImmediate）
      this._renderOrderBar();                    // 渲染出手顺序条（头像按速度排序，当前回合）
      // ★ ROUND_START：置于队列建成之后广播，使"开局套盾/开局释放"可安全使用 grantTurn 插队
      emitEvent(this, EVENTS.ROUND_START, { source: this.pFig, skillType: 'round' });
      while (this._queueCursor < this.actionQueue.length) {
        if (this._ended) return;
        const u = this.actionQueue[this._queueCursor++];
        if (!u || u.hp <= 0) continue;           // 本回合中途阵亡的单位跳过
        if (this._allEnemiesDead()) { this._win(); return; }
        this._updateOrderState(u);               // 高亮当前行动单位（顺序条）
        this.busy = true;                            // 锁输入：除"我方单位等待玩家下令"的窗口外，全程禁止点击（敌方回合/结算/过场均不可操作）
        // ★ 对齐 AS3 BattleManager.startRound → stopCounter：每个单位行动开始即移除指令条 + 技能栏盖遮罩
        //   （= PanelManager.setAllVisible(true) 后 removeChild(battlePanel) + ShortCutFace.setAllMask(true)）
        this._setBattleHud('act');
        const skip = await this._unitTurnStart(u);   // 状态结算/防御重置/冷却递减/眩晕跳过（内含 TURN_START 广播）
        if (!skip) {
          if (u.side === 'enemy') await this._enemyAct(u);
          else await this._playerUnitAct(u);       // 自动切换操控对象并等玩家下令
        }
        await this._resolveDeaths();             // 批量结算阵亡（群体/反伤可一次清多单位）
        this._updateOrderState(null);            // 刷新阵亡态（顺序条）
        // ★ TURN_END：行动链路（含被眩晕跳过的情况）彻底执行完毕后【显式广播】，时序严格闭环。
        //   不用"下一单位 TURN_START 前广播"的偷懒方案——队列末尾会吞掉、且与插队者 TURN_START 交织错位。
        emitEvent(this, EVENTS.TURN_END, { source: u, target: u, skillType: 'turn' });
        if (this._allEnemiesDead()) { this._win(); return; }
        // ★ await：主角阵亡演出（500ms 飘字等待 + 900ms 时间轴）播完再离开主循环，
        //   与 _onAllyDown 被 await 对称；演出期间 busy=true 且 _ended=true，本就不会推进回合。
        if (this.player.hp <= 0) { await this._lose(); return; }
        await this._wait(360);
      }
      if (this._ended) return;
      this.round += 1;
      this._showRound();                         // 回合数递增横幅
    }
  }

  // ── 行动队列改写原语（TCA 阶段1）：实现见 js/battle/action-queue.js（纯函数，可单测）──
  // ① 即时插队（疾风/邀战/反击）：默认允许再动；oncePerRound 查重；单回合上限 3
  insertImmediate(fighter, opts = {}) {
    if (!this.actionQueue) return false;
    if (!this._extraTurnCount) this._extraTurnCount = {};
    const r = aqInsert(this.actionQueue, this._queueCursor, fighter, this._extraTurnCount, opts);
    if (!r.ok) {
      if (r.reason === 'cap' && fighter) this.mLog(fighter.name + ' 本回合插队已达上限（' + ((opts.cap != null) ? opts.cap : 3) + '），忽略本次额外行动');
      return false;
    }
    this._turnOrder = this.actionQueue;   // 出手顺序条与队列同引用
    this._renderOrderBar();
    this.mLog(fighter.name + ' 获得一次额外行动（插队）');
    return true;
  }

  // ② 重排未行动单位（减速/加速后立即生效）：已行动段冻结
  resortQueue() {
    if (!this.actionQueue) return;
    aqResort(this.actionQueue, this._queueCursor);
    this._turnOrder = this.actionQueue;
    this._renderOrderBar();
  }

  // ③ 延迟追加（残血追击/回合结束追加）：排到队尾
  appendTurn(fighter) {
    if (!this.actionQueue) return false;
    if (!aqAppend(this.actionQueue, fighter)) return false;
    this._turnOrder = this.actionQueue;
    this._renderOrderBar();
    return true;
  }

  // 每回合（行动队列重建前）回蓝一次：对齐原版"每玩家回合回蓝"，原 stage 式下整队共用同一回合节奏
  _roundStart() {
    if (this.player.maxMp) {
      const mpRegen = Math.max(2, Math.round(this.player.maxMp * 0.2));
      this.player.mp = Math.min(this.player.maxMp, this.player.mp + mpRegen);
      this.player.updateBar();
    }
  }

  // 行动队列：全部存活单位按 spd 降序；同速我方优先于敌方（保持稳定，避免抖动）
  _buildTurnOrder() {
    const units = [this.pFig, ...(this.allies || []).filter(a => a && a.hp > 0), ...this.enemies.filter(e => e && e.hp > 0)];
    return units.sort((a, b) => {
      const sa = a.spd || 0, sb = b.spd || 0;
      if (sb !== sa) return sb - sa;                       // 速度高者先手
      const pa = a.side === 'enemy' ? 1 : 0;              // 同速：我方优先
      const pb = b.side === 'enemy' ? 1 : 0;
      return pa - pb;
    });
  }

  // 出手顺序条（按速度先攻制）：用头像代表每个参战单位，按当前回合行动队列从左到右排列。
  // 头像优先取单位 portrait 字段，否则按 charId 拼 Portrait_{charId}.png；加载失败/缺图回退「首字 + 阵营色」CSS 头像。
  _portraitSrc(fig) {
    let id = null;
    if (fig && fig.portrait) id = String(fig.portrait);
    else if (fig && fig.charId) id = 'Portrait_' + fig.charId;
    if (!id) return null;
    if (id.indexOf('.png') === -1) id += '.png';
    return url.icon('portrait', id);
  }
  /** 头像兜底：对齐 AS3 TalkPanel.updateheader —— Portrait_{id}.png 不存在时取
   *  Portrait_npc_{id}.png（npc/ 子目录类名，如兑奖天尊 202019 只有这个文件）。返回 [主图, 兜底图]
   *  config/portraits.json 已覆盖已知 npcOnly id（url.portrait 主图直接命中），兜底仅防御清单过期 */
  _portraitFallbacks(fig) {
    const src = this._portraitSrc(fig);
    if (!src) return [null, null];
    const m = src.match(/Portrait_(\d+)\.png$/);
    if (!m) return [src, null];
    // 命中清单时主图本身就是 npc_ 版本，不再兜底自身
    const list = (Config.portraits && Config.portraits.npcOnly) || [];
    const hit = list.indexOf(m[1]) >= 0;
    if (hit) return [url.portrait(m[1]), null];
    return [src, url.icon('portrait', 'Portrait_npc_' + m[1] + '.png')];
  }

  // 渲染出手顺序条：每个单位一个头像 chip（我方绿框 / 敌方红框），下方名字 + 速度
  _renderOrderBar() {
    if (!this.orderBar) return;
    const order = this._turnOrder || [];
    this.orderBar.innerHTML = '';
    this._orderChips = new Map();
    for (const u of order) {
      const chip = document.createElement('div');
      chip.className = 'order-chip ' + (u.side === 'enemy' ? 'enemy' : 'ally');
      const av = document.createElement('div');
      av.className = 'order-av';
      const [src, fb] = this._portraitFallbacks(u);
      if (src) {
        const img = document.createElement('img');
        img.src = src; img.alt = u.name || '';
        img.onerror = () => {
          if (fb && img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = fb; return; }   // AS3 npc/ 子目录兜底
          av.classList.add('no-img'); img.remove(); av.textContent = (u.name || '?').slice(0, 1);
        };
        av.appendChild(img);
      } else {
        av.classList.add('no-img'); av.textContent = (u.name || '?').slice(0, 1);
      }
      const nm = document.createElement('div'); nm.className = 'order-name'; nm.textContent = u.name || '';
      const spd = document.createElement('div'); spd.className = 'order-spd'; spd.textContent = '速' + (u.spd || 0);
      chip.appendChild(av); chip.appendChild(nm); chip.appendChild(spd);
      if (u.hp <= 0) chip.classList.add('dead');
      this.orderBar.appendChild(chip);
      this._orderChips.set(u, chip);
    }
  }

  // 更新出手顺序条状态：active=当前行动单位（金色高亮上浮），其余按存活刷新；active 为 null 时仅刷新阵亡态
  _updateOrderState(active) {
    if (!this._orderChips) return;
    this._orderChips.forEach((c, f) => {
      c.classList.remove('active');
      if (f.hp <= 0) c.classList.add('dead'); else c.classList.remove('dead');
    });
    const c = active && this._orderChips.get(active);
    if (c) { c.classList.add('active'); c.classList.remove('dead'); }
  }

  // 单位行动开始结算：状态(中毒/回血)、防御态重置、冷却递减、眩晕/昏睡跳过（对齐 Buff 编辑器 trigger='回合开始' 与出手前钩子）
  async _unitTurnStart(u) {
    // ★ TURN_START：早于状态结算广播（支持"环境回合前伤害/回合开始判定"）
    emitEvent(this, EVENTS.TURN_START, { source: u, target: u, skillType: 'turn' });
    this._tickBuffsFor(u);
    if (u.side !== 'enemy') u.defending = false;          // 防御态每行动前重置（出手时再按防御指令置位）
    if (u._cdMap) for (const k in u._cdMap) u._cdMap[k] = Math.max(0, u._cdMap[k] - 1);
    this.sm.ui.refresh();
    if (u.hp <= 0) return true;
    const st = statusAtTurnStart(this, u);
    if (st.skip) { this.mLog(u.name + ' ' + st.reason + '，无法行动'); return true; }
    return false;
  }

  // 我方可操控单位行动：自动把操控权交给该单位（右侧指令面板随之切换），玩家直接下令；自动战斗则直接普攻
  async _playerUnitAct(u) {
    this._setCtrl(u);                               // 切操控对象 → 面板换该单位指令集 + 立绘高亮（无需玩家点选）
    this.battleState = B.ATTACK; this._highlightCmd();
    while (true) {
      if (this.auto) {
        // ★ 与下面的手动分支同理，必须先把 busy 交还：_playerTurn/_petTurn 的入口都有
        //   `if (this.busy || this._ended) return;` 门禁，而行动队列在派发本函数前把 busy 置了 true
        //   （锁敌方回合/过场的输入）。旧代码直接在此调用 ⇒ 玩家与宠物**每回合都被静默吞掉、
        //   永不出手**（自动战斗只剩敌人在动）。
        this.busy = false;
        // 自动战斗：该单位直接普攻（宠物取首个存活敌人）
        if (u === this.pFig) await this._playerTurn('attack');
        else { this.eFig = this._firstAliveEnemy(); await this._petTurn('attack'); }
        return;                                     // 自动模式行动一次即结束本回合
      }
      this.busy = false;                            // 交出操作权（_onCmd/_onTargetClick 以 busy 为门禁）
      // ★ 对齐 AS3 receiveChooseBattleAction → BattlePanel.showPlayerOrPet(typeId, mask)：
      //   轮到我方单位下令 ⇒ 显示指令条（按钮按掩码置灰）+ 出手顺序条，技能栏撤遮罩。
      //   自动战斗模式由系统代打，没有玩家下令窗口（AS3 走 autoBattlePanel），维持 'act' 态。
      this._setBattleHud('cmd');
      this.sm.ui.toast('轮到 ' + u.name + '：点敌人＝普通攻击，或选技能/防御');
      await this._waitUnitCmd();                    // 等待玩家为当前操控单位下令（行动完成后由 _endUnitAction 唤醒）
      return;                                       // 玩家已下令并完成行动 → 本回合结束
    }
  }

  // 回合内批量结算阵亡（群体技能/反伤可一次清空多单位），避免漏播倒地动画
  async _resolveDeaths() {
    this.busy = true;                               // 结算过场锁输入，避免误点触发其他单位行动
    this.sm.ui.refresh();
    await this._wait(200);
    const deadEnemies = this.enemies.filter(e => e && e.hp <= 0 && !e._down);
    if (deadEnemies.length) await Promise.all(deadEnemies.map(e => this._onEnemyDown(e)));
    const deadAllies = (this.allies || []).filter(a => a && a.hp <= 0 && !a._down);
    if (deadAllies.length) await Promise.all(deadAllies.map(a => this._onAllyDown(a)));
  }

  // 行动收尾：手动模式下唤醒回合循环（等待中的单位已行动完毕）；自动模式行动函数已被 await，_unitResolve 为空则无操作
  _endUnitAction() {
    if (this._unitResolve) this._resolveUnitCmd();
  }

  async _playerTurn(kind) {
    if (this.busy || this._ended) return;
    this.busy = true;
    this._stopTurnTimer();
    this._closeSubRow();
    // 出手即退出选目标态：对齐 AS3 clickPlayerOrOtherPlayer(null) 的战斗态分支
    //   （hiddenBottomPrompt + setAllPanelAndFaceVisiable(true)），随后 startRound 移除指令条。
    //   故此处直接进入 'act' 态：指令条/顺序条隐藏，技能栏盖遮罩（= AS3 setAllMask(true)）。
    this._hideBottomPrompt();
    this._setBattleHud('act');
    try {

    if (kind === 'defend') {
      await this._act(this.pFig, ACTION.STAND);
      this.pFig.defending = true;   // 防御态：普攻/技能对其伤害减半（龙破斩无视；onDamaged 处理）
      // ★ 防御"受击"动画(defend_lr/rl)只在【实际被攻击】时由 _underfire 播放（防御单位每次挨打必播，敌我方向不同）；
      //   此处仅进入防御态，不播受击动画——防御动画是"被攻击的效果"，不能仅靠选择防御就播。
      this.mLog(this.pFig.name + ' 摆出防御姿态');
    } else if (kind === 'item') {
      const it = Config.items[this.pendingItem];
      if (!it) { this.sm.ui.toast('未选择道具'); return; }
      await this._act(this.pFig, ACTION.CAST);
      // ★ 走真实原子引擎（config/item_effects.json 的 heal_hp/heal_mp/…），不读 items.json 里并不存在的内联 effect
      //   applyItemEffect 把 fighter 当 player：hp/mp/maxHp/maxMp 字段同构，钳到上限；
      //   返回 applied 明细用于飘字（实际回复量，满血时为 0 → 不飘）
      const r = applyItemEffect({ itemId: this.pendingItem, player: this.player });
      let healedHp = 0, healedMp = 0;
      if (r.ok) {
        for (const a of (r.applied || [])) {
          if (a.type === 'heal_hp') { healedHp = a.gained; if (a.gained > 0) this._floatNumber(this.pFig, NUM_TYPE.HP, a.gained); }
          if (a.type === 'heal_mp') { healedMp = a.gained; if (a.gained > 0) this._floatNumber(this.pFig, NUM_TYPE.MP, a.gained); }
        }
      }
      // 扣减 1 个并落盘（走权威 InventoryManager；扣失败不阻塞演出，只提示）
      const consumed = this._consumeBattleItem(this.pendingItem);
      this.mLog(this.player.name + ' 使用 ' + (it ? it.name : '道具')
        + (r.ok ? '（HP' + (healedHp > 0 ? '+' + healedHp : '满') + '/MP' + (healedMp > 0 ? '+' + healedMp : '满') + '）' : '（无效果配置）')
        + (consumed ? '' : '，扣减失败'));
      await this._castVisual({ effect: healedHp > 0 ? 'flowerEff' : null });
      this.pendingItem = null;
    } else if (kind === 'cast') {
      const s = this.pendingSkill;
      this.player.costMp(s.mpCost);
      if (s.mpCost) this._floatNumber(this.pFig, NUM_TYPE.MP, -s.mpCost);   // 施法耗蓝：MP 数字飘字
      // 怒气/寿命消耗（D 组）：怒气仅人物、寿命仅宠物；飘字复用 RAGE 精灵
      if (s.rageCost) { this.player.costRage(s.rageCost); this._floatNumber(this.pFig, NUM_TYPE.RAGE, -s.rageCost); }
      if (s.lifeCost && this.player.lifeMax > 0) { this.player.costLife(s.lifeCost); this.sm.ui.toast('消耗寿命 ' + s.lifeCost); }
      // 友方/敌我技能：以玩家点选的己方单位(aFig)为施放目标；其余走嘲讽/混乱重定向（默认敌方 eFig）。
      let primary;
      if (s && (s.target === 'ally' || s.target === 'enemyOrAlly') && this.aFig) primary = this.aFig;
      else primary = redirectTarget(this, this.pFig, this.eFig);
      await this._engineCast(this.pFig, s, primary);
      this.pendingSkill = null;
      this.aFig = null;
    } else { // attack
      playSfx('attack');
      // 出手前钩子：嘲讽/混乱重定向（命中目标恒为 eFig，与旧逻辑一致；仅当重定向到敌方时切换 eFig）
      const target = redirectTarget(this, this.pFig, this.eFig);
      if (target && target.side === 'enemy') this.eFig = target;
      const hit = this.eFig;
      if (hit && hit.hp > 0) {
        await this._approach(this.pFig, hit);              // 走向目标（已实现）
        const atkP = this.pFig.act(ACTION.ATTACK, this.pFig.dir, { scale: this.SCALE, loop: false, freezeLast: true });   // 播一次普通攻击挥击（播完冻结末帧），与伤害数字同时
        const rage = this.raging ? 1.4 : 1;
        emitEvent(this, EVENTS.BEFORE_ATTACK, { source: this.pFig, target: hit, skillType: 'normal' });   // ★ 攻击前
        const cres = this._calcDamage(this.pFig, hit, { rage, formulaId: 'phys_damage' });
        // 受击钩子（昊天护盾/同生共死/仙气/腐骨/穿心）由 onDamaged 处理；防御态减半、普攻触发昊天反伤
        // 伤害数字由引擎唯一出口 applyRaw 飘出（含暴击 1.3x）；此处【不可】再飘一次，否则同一击出现两个数字
        const dealt = applyIncoming(this, hit, cres.dmg, { attacker: this.pFig, viaNormalAttack: true, canDodge: !hasTaunt(this.pFig), crit: cres.crit });
        this._dmgDealt += cres.dmg;
        playSfx('hit');
        if (cres.crit) playSfx('crit');   // "暴击!"文字与伤害数字均由引擎侧输出
        this.mLog(this.player.name + ' 普通攻击，造成 ' + dealt + ' 伤害' + (cres.crit ? '（暴击）' : ''));
        // 攻击动画与伤害数字【同时】演出；等挥击真实播放完再归位（补等动画时长，避免被归位动画覆盖）。受击即死亡则倒地动画与归位同时播放。
        await this._awaitAttack(this.pFig, atkP);
        if (hit.hp <= 0) {
          await Promise.all([ this._retreat(this.pFig), this.onDeath(hit) || Promise.resolve() ]);
        } else {
          setTimeout(() => { if (hit.hp > 0) this._stand(hit); }, 420);
          await this._retreat(this.pFig);   // 攻击后归位（已实现）
        }
        // ★ AFTER_ATTACK：普通攻击结算完毕（追击 / 残血追加 的检测点）
        emitEvent(this, EVENTS.AFTER_ATTACK, { source: this.pFig, target: hit, value: dealt, skillType: 'normal' });
      }
    }

    } catch (err) {
      // 安全网：任何指令（含技能演出/结算）异常都不应让 busy 卡死导致"用完就按不了"；记录并安全跳过本回合
      console.error('[战斗] 玩家指令执行异常，已安全跳过本回合：', err);
      this.mLog('指令执行异常，已跳过');
    }
    this._endUnitAction();   // 行动结束：手动模式唤醒回合循环；自动模式无操作（行动函数已被 await）
  }

  // 技能统一执行入口：委托 skill-engine 的 castSkill（含演出、范围判定、逐技能精确公式、增益减益联动）
  async _engineCast(caster, skill, primaryTarget) {
    await castSkill(this, caster, String(skill.id), { primaryTarget });
    if (skill.cd) { caster._cdMap = caster._cdMap || {}; caster._cdMap[skill.id] = skill.cd; }
    // 施法收招：cast 角色动作播一次后（引擎已按真实时长等待并 freezeLast 定格）切回站立（STAND 待机循环），
    // 避免"卡在施法动作一直播放"。玩家/敌方施法均经此路径，故统一在此收尾。
    await this._stand(caster);
  }

  // 单个敌人行动（由 _startBattleLoop 行动队列按速度逐个调用）：
  // 状态结算/防御重置/冷却递减/眩晕跳过已在 _unitTurnStart 完成，这里只做 AI 决策与出手。
  async _enemyAct(e) {
    // 出场即清除上一位操控单位高亮（敌方回合不显示"操控中"）
    const pc = this._ctrlFig();
    if (pc && pc.el) pc.el.classList.remove('fighter-ctrl');
    // 练功木桩(alwaysDefend)：永久保持防御，不普攻/不施法/不逃跑。
    if (e.alwaysDefend) {
      e.defending = true;
      // ★ 永久防御木桩：仅置防御态，不播受击动画（防御动画是"被攻击的效果"，仅靠永久防御不该播）。
      this.sm.ui.refresh();
      return;
    }
    const ai = Config.data.ai && Config.data.ai[e._monsterId];
    // 逃跑
    if (ai && ai.fleeRate && Math.random() < ai.fleeRate) {
      this.mLog(e.name + ' 逃跑了！'); await this._onEnemyDown(e); return;
    }
    // 选目标：默认玩家；依 targetPref 可能攻击召唤兽
    let target = this.pFig;
    if (this.allies.length) {
      if (ai && ai.targetPref === '血量最低') target = [this.pFig, ...this.allies].sort((a, b) => a.hp - b.hp)[0];
      else if (ai && ai.targetPref === '后排') target = this.allies[this.allies.length - 1] || this.pFig;
      else if (ai && ai.targetPref === '前排') target = this.pFig;
      else if (ai && ai.targetPref === '最高威胁') target = [this.pFig, ...this.allies].sort((a, b) => (b.atk + b.mag) - (a.atk + a.mag))[0];
      else if (Math.random() < 0.3) target = this.allies[Math.floor(Math.random() * this.allies.length)];
    }
    // 选技能：阶段/血量阈值触发 > 优先表权重
    let skill = null;
    const pick = (id) => { const sk = id && Config.data.skills[id]; return (sk && e.mp >= (sk.mpCost || 0) && !((e._cdMap && e._cdMap[sk.id]) > 0)) ? sk : null; };
    if (ai) {
      const hpPct = e.hp / e.maxHp * 100;
      const trig = (ai.phase || []).find(x => hpPct <= (x.atHp || 0))
        || (ai.hpThreshold || []).find(x => hpPct <= (x.hp || 0) && x.action === '释放技能');
      if (trig && trig.skill) skill = pick(trig.skill);
      // 召唤小怪（每战一次，血量低于阈值时）
      if (!this._aiSummoned && (ai.summon || []).length && hpPct <= ((ai.hpThreshold && ai.hpThreshold[0] && ai.hpThreshold[0].hp) || 50)) {
        this._aiSummoned = true;
        const s = ai.summon[0];
        const aslot = this._nextFoeSlot();   // AI 召唤也走站位管理器，避免与现有敌阵重叠
        const sf = await this._spawnEnemy(s.mob, 'aisum_' + s.mob, BattleScene.getFightPoint(aslot), aslot);
        this.mLog(e.name + ' 召唤了 ' + sf.name + '！');
      }
      if (!skill && ai.priority && ai.priority.length) {
        const total = ai.priority.reduce((s, p) => s + (Number(p.weight) || 1), 0);
        let r = Math.random() * total, pk = null;
        for (const p of ai.priority) { r -= (Number(p.weight) || 1); if (r <= 0) { pk = p; break; } }
        if (pk && pk.skill) skill = pick(pk.skill);
      }
    }
    // ★ 默认 AI 兜底（F2 简易 AI「随机」）：ai.json 无配置时，怪物若自带主动技能，
    //   60% 概率从可用技能（MP 足、冷却好）里随机选一个施放；否则走普攻。
    //   显式 ai 配置优先级最高（上面 if(ai) 已处理），本兜底只在 ai 缺失时生效。
    if (!skill && !ai && Array.isArray(e.skills) && e.skills.length) {
      const usable = e.skills
        .map(id => Config.data.skills[id] || Config.data.skills[String(id)])
        .filter(sk => sk && !sk.passive && e.mp >= (sk.mpCost || 0) && !((e._cdMap && e._cdMap[sk.id]) || 0));
      if (usable.length && Math.random() < 0.6) {
        skill = usable[Math.floor(Math.random() * usable.length)];
      }
    }
    // 出手前钩子：嘲讽/混乱重定向
    const atkTarget = redirectTarget(this, e, target);
    if (skill) {
      e.costMp(skill.mpCost);
      if (skill.mpCost) this._floatNumber(e, NUM_TYPE.MP, -skill.mpCost);   // 敌方施法耗蓝：MP 数字飘字
      if (skill.rageCost && e.rageMax > 0) { e.costRage(skill.rageCost); this._floatNumber(e, NUM_TYPE.RAGE, -skill.rageCost); }
      if (skill.lifeCost && e.lifeMax > 0) { e.costLife(skill.lifeCost); this._floatNumber(e, NUM_TYPE.HP, -skill.lifeCost); }
      if (skill.cd) { e._cdMap = e._cdMap || {}; e._cdMap[skill.id] = skill.cd; }   // 敌方技能进入冷却
      await this._engineCast(e, skill, atkTarget);   // 委托引擎：范围/精确公式/增益减益联动
    } else {
      playSfx('attack');
      await this._approach(e, atkTarget);              // 敌人走向目标（已实现）
      const atkP = e.act(ACTION.ATTACK, e.dir, { scale: this.SCALE, loop: false, freezeLast: true });   // 播一次普通攻击/反击挥击（播完冻结末帧），与伤害数字同时
      emitEvent(this, EVENTS.BEFORE_ATTACK, { source: e, target: atkTarget, skillType: 'normal' });   // ★ 攻击前
      const cres = this._calcDamage(e, atkTarget, { formulaId: 'enemy_damage' });
      // 受击钩子（昊天护盾/同生共死/仙气/腐骨/穿心）：防御态减半、普攻触发昊天反伤
      // 伤害数字由引擎唯一出口 applyRaw 飘出（含暴击 1.3x）；此处【不可】再飘一次，否则同一击出现两个数字
      const dealt = applyIncoming(this, atkTarget, cres.dmg, { attacker: e, viaNormalAttack: true, canDodge: !hasTaunt(e), crit: cres.crit });
      this._dmgTaken += cres.dmg;
      playSfx('hit');
      if (cres.crit) playSfx('crit');   // "暴击!"文字与伤害数字均由引擎侧输出
      this.mLog(e.name + (atkTarget === this.pFig ? ' 攻击（被防御削减），' : ' 反击，') + '对 ' + atkTarget.name + ' 造成 ' + dealt + ' 伤害' + (cres.crit ? '（暴击）' : ''));
      // 攻击动画与伤害数字【同时】演出；等挥击真实播放完再归位
      await this._awaitAttack(e, atkP);
      if (atkTarget.hp <= 0) {
        await Promise.all([ this._retreat(e), this.onDeath(atkTarget) || Promise.resolve() ]);
      } else {
        setTimeout(() => { if (atkTarget.hp > 0) this._stand(atkTarget); }, 420);
        await this._retreat(e);   // 归位
      }
      // ★ AFTER_ATTACK：敌方普攻结算完毕
      emitEvent(this, EVENTS.AFTER_ATTACK, { source: e, target: atkTarget, value: dealt, skillType: 'normal' });
    }
    this.sm.ui.refresh();
  }

  // 技能演出：优先播放该技能自己的 SWF 演出（resource/skill/{id}，方向片 _lr/_rl），
  // 否则回退到 skills.json 配置的特效资源。定位：单体→作用区域（目标坐标），群体→画面中心。
  // 方向片选择：能取施法者/目标左右关系时按 _lr(左→右)/_rl(右→左) 选片；群攻以画面中心为参照。
  // 屏幕震动（技能 castVisual.shake / levelAnims.shake）：对战斗舞台施加短暂 CSS 抖动
  _screenShake(dur = 360) {
    const st = this.battleStage || this.battle;
    if (!st) return;
    if (!document.getElementById('fx-shake-kf')) {
      const s = document.createElement('style');
      s.id = 'fx-shake-kf';
      s.textContent = '@keyframes fxShake{0%,100%{transform:translate(0,0)}20%{transform:translate(-6px,3px)}40%{transform:translate(5px,-4px)}60%{transform:translate(-4px,-3px)}80%{transform:translate(4px,4px)}}.fx-shake{animation:fxShake .12s linear infinite}';
      document.head.appendChild(s);
    }
    st.classList.remove('fx-shake');
    void st.offsetWidth;               // 强制重排，使动画可重新触发
    st.classList.add('fx-shake');
    setTimeout(() => st.classList.remove('fx-shake'), dur + 60);
  }

  async _castVisual(skill, ctx = {}) {
    // 技能演出层统一挂到「角色层」(characterLayer)：characterLayer 是 z-index:2 的独立堆叠上下文，其内角色按 10000+groundY 排序；
    // 这样技能动画按落点深度设 z-index 后可与角色产生正确前后遮挡，而不是像旧 areaSkillLayer(z-index:6 恒高于角色层)那样永远压在角色之上、无遮挡。
    const layer = this.characterLayer || this.areaSkillLayer;
    // 在角色层内创建带深度 z-index 的子容器：z = 10000 + round(groundY)，与 Fighter.setDepth 同式
    // → 同深度与角色并列、异深度前后遮挡（实现"技能动画也有 Z 轴遮挡关系"）。
    const mkCell = (py, zIndex) => {
      const cell = document.createElement('div');
      cell.style.position = 'absolute'; cell.style.left = '0'; cell.style.top = '0'; cell.style.pointerEvents = 'none';
      // 全屏放大演出（fit）需盖在所有角色之上：调用方可显式传 zIndex 覆盖默认的按深度排序值。
      cell.style.zIndex = String(zIndex != null ? zIndex : (10000 + Math.round(py || 0)));
      layer.appendChild(cell);
      return cell;
    };
    const stage = this.battleStage || this.battle;
    const W = stage ? stage.clientWidth : 800, H = stage ? stage.clientHeight : 600;
    const cx = Math.round(W / 2), cy = Math.round(H / 2);
    const caster = ctx.caster || null;
    const targets = ctx.targets || [];
    const primary = ctx.primary || (targets && targets[0]) || null;
    const tgtFig = primary || (targets && targets[0]) || null;
    // 群攻判定（仅旧逻辑回退用）：多目标 或 配置为群体目标类型 → 画面中心；否则单体→作用区域（目标坐标）。
    // 十字(AOE 以选中目标为几何中心)技能：shape==='cross'，特效对准【点选目标】脚底，而非画面中心
    // （修复"十字技能的中心不是点选目标"：原逻辑把十字当成散攻放到画面正中）。
    // ★ 群体是技能的固有属性（配置声明：params.scope / target=all_enemy / shape=cross），
    //   不随场上剩余存活数量变化：全体攻击只剩 1 个敌人时仍是全体攻击，落点保持画面中心，
    //   不能变成「跟着唯一敌人走」（否则水魔爆等全体技落点跑到单个敌人身上）。
    const isCross = !!(skill && skill.shape === 'cross');
    const skillScopeOn = !!(skill && skill.params && skill.params.scope && skill.params.scope.enabled);
    const isGroup = !isCross && (targets.length > 1 || skillScopeOn || (skill && (skill.target === 'all_enemy' || skill.target === 'cross' || skill.target === 'all_ally')));
    // 统一落点解析：技能可选 castVisual={place,spread} 声明「动画放哪/群体播一个还是每个单位一个」；
    // 缺省走旧逻辑（单体→目标身体中心，群体→舞台中心，并保留 skill.perUnitEffect 逐目标行为）。
    // 主游戏与 battle-test.js 共用此解析器，避免两套实现分歧（曾致攻击动画误放施法者身上）。
    let cv = resolveCastPlays(skill, { caster, primary, targets, stageW: W, stageH: H, groupFallback: isGroup });
    let effName = (skill && skill.effect) || null;
    // ★ base（动作动画资源名）必须声明在【函数作用域】：它在下面的 if 块之外也要用
    //   ——见本函数后段「防重复播放」判定 `if (effName && base && effName === base) effName = null;`。
    //   历史缺陷（至少 2026-09-11 起）：base 被声明在 if (skill && skill.id) 块内，块外引用 →
    //   每次施法都在【特效阶段之前】抛 `ReferenceError: base is not defined`，
    //   ⇒ 技能特效(effect/levelEffects)被静默跳过，只剩动作动画(anim/levelAnims)在播。
    //   还会污染调用方：castSkill 的 Promise.all 因此 reject（技能链路上的异常来源）。
    let base = null;
    let lvAnim = null;   // 命中的逐级动画条目（可携带 shake/scale/place/spread 覆盖，见下方落点与震动逻辑）
    if (skill && skill.id) {
      // 演出动画资源名：优先 skill.anim（编辑器可调，动画可不与ID相符）；否则回退技能ID同名资源
      // 等级动画：skill.levelAnims=[{level,anim}]，运行时取 ≤当前等级 的最高一档覆盖基础动画（动画随等级变化）
      // 等级取值优先级：ctx.L（驱动技等级，随机变体驱动时变体本身无等级，须用驱动技等级分档）
      //   > caster.skillLevel(skill.id)（非驱动场景，直接取本技能等级） > 1
      const lvl = (ctx && typeof ctx.L === 'number') ? ctx.L : ((caster && caster.skillLevel) ? caster.skillLevel(skill.id) : 1);
      base = (skill.anim && String(skill.anim).trim()) || String(skill.id);
      // 逐级动画：lvAnim 可携带 shake/place/spread/scale 覆盖本技能基础设定（动画随等级变化，且每级可单独配动画参数）
      if (Array.isArray(skill.levelAnims) && skill.levelAnims.length) {
        const sorted = skill.levelAnims.filter(a => a && a.anim).sort((a, b) => (a.level || 0) - (b.level || 0));
        let chosen = null;
        for (const a of sorted) { if ((a.level || 0) <= lvl) chosen = a; }
        if (chosen) { base = String(chosen.anim); lvAnim = chosen; }
      }
      // 等级特效：skill.levelEffects=[{tier,effect}]，每 2 级一档（tier=floor((L-1)/2)），
      // 取 ≤当前 tier 的最高一档覆盖基础特效（与 levelAnims 同构）；无 levelEffects 时回退 skill.effect
      if (Array.isArray(skill.levelEffects) && skill.levelEffects.length) {
        const tier = Math.floor(((lvl || 1) - 1) / 2);
        const sortedE = skill.levelEffects.filter(a => a && a.effect).sort((a, b) => (a.tier || 0) - (b.tier || 0));
        let chosenE = null;
        for (const a of sortedE) { if ((a.tier || 0) <= tier) chosenE = a.effect; }
        if (chosenE) effName = String(chosenE);
      }
      // ★ 屏幕震动（D 组）：castVisual.shake 声明，或逐级动画 lvAnim.shake 覆盖；演出期间舞台抖动
      const shakeOn = !!(lvAnim && lvAnim.shake != null ? lvAnim.shake : (skill.castVisual && skill.castVisual.shake));
      if (shakeOn) this._screenShake();
      // ★ 逐级动画覆盖落点（place/spread）时，以合并后的 castVisual 重新解析落点
      if (lvAnim && (lvAnim.place || lvAnim.spread)) {
        cv = resolveCastPlays(Object.assign({}, skill, {
          castVisual: Object.assign({}, skill.castVisual, { place: lvAnim.place, spread: lvAnim.spread })
        }), { caster, primary, targets, stageW: W, stageH: H, groupFallback: isGroup });
      }
      // 基础动作动画：按 castVisual 落点（cv.plays）逐点播放。
      // castVisual 模式下逐单位（spread=perUnit）→ 每个受影响单位各播一个；否则单实例。
      let totalDur = 0;
      for (const p of cv.plays) {
        // 每个落点用独立子容器：mount() 会先清空其容器内已有 canvas，若所有落点共用 layer，
        // 则后一个挂载会销毁前一个目标身上的动画 → 只显示最后一个、且反复闪烁/卡顿。
        // 独立容器使每个受击目标"同时并独立"播放各自的技能动画。
        // 带深度 z-index 的子容器：与角色按 groundY 共排序 → 正确前后遮挡；
        // fit（全屏放大演出）时【不看落点】：固定 19999 盖在所有角色之上（高于任何 10000+groundY 深度），
        // 全屏动画必须覆盖全部角色，不参与 Z 轴深度排序。
        // ★ 非 fit 时必须传落点深度 p.y：与目标角色同深度（10000+groundY），
        //   技能 cell 后追加 → 同深度时盖在目标之上；深度更大/更小的角色仍按 Z 轴正确前后遮挡。
        //   之前误传 0 → 所有单体技能恒为 10000，被目标角色（10000+groundY>10000）整体遮住。
        const cell = mkCell(p.y, cv.fit ? 19999 : null);
        // 方向判定：施法者在落点左侧→动画左→右(_lr)；在右侧→右→左(_rl)
        let dir = null;
        const refX = p.x;
        if (caster && typeof caster.x === 'number') dir = (caster.x <= refX) ? 'lr' : 'rl';
        const cands = [];
        if (dir) { cands.push(base + '_' + dir, base + '_' + (dir === 'lr' ? 'rl' : 'lr')); }
        cands.push(base);   // 无方向片/方向片缺失时回退基础片
        // 若显式 anim 与 ID 不同且该资源缺失，再回退到 ID 同名资源（兜底，保证总有演出）
        if ((skill.anim && String(skill.anim).trim()) && String(skill.anim).trim() !== String(skill.id)) {
          const idBase = String(skill.id);
          if (dir) { cands.push(idBase + '_' + dir, idBase + '_' + (dir === 'lr' ? 'rl' : 'lr')); }
          cands.push(idBase);
        }
        // 显式存在性检测（对齐用户规则"根据方向检查我方/敌方施放方向片 _rl/_lr 是否存在，否则调用原始数字动画"）：
        // 按优先级逐一探测候选动画资源是否真实存在，命中第一个存在的方向片即用；都不存在则回退基础片（{id} 原始数字动画）。
        // 仅对存在的资源发起 playSkill 加载，避免对缺失方向片发起无效 GET + 404 控制台告警。
        // ★ fit（等比例放大铺满舞台，不拉伸）：按舞台尺寸与动画真实内容尺寸算统一缩放系数，
        //   scale = contain→min(W/rw, H/rh)（完整显示，可能留边）/ cover→max(W/rw, H/rh)（完全铺满，可能裁边）。
        //   落点固定为舞台中心（Flash 原点≈内容中部），使放大后的内容关于屏幕中心铺开。
        //   fanvas 令 canvas.width=rw*scale 且 f.x=-rect.x*scale，anchorOrigin 再 translate(-originX*scale)，
        //   三者用同一 rect ⇒ 内容几何中心落在 (cx + 内容中心偏移*scale)，近似居中。
        //   注：rect 是并集包围盒（含透明留白），放大留白同步等比，不会改变内容宽高比 → 不会拉伸变形。
        let playOpts = { scale: 1, x: p.x, y: p.y };
        if (cv.fit) {
          // ★ 等比例放大铺满舞台（不拉伸）：以【真实可见内容】包围盒算系数（contain=完整显示/cover=完全铺满）。
          //   用「可见内容」而非并集 rect：后者含透明留白（如 170601 main rect 顶部 y:-493 的 ~289px 空白），
          //   会把横长内容误算成「高度铺满、水平只覆盖 60%」。
          //   基准还要裁到原版 800×600 可见窗口（以 Flash 原点为中心）：部分全屏技笔触超出原版设计屏幕
          //   （170601 墨迹顶到 y=-492，原版根本不显示 y<-300），不裁的话放大后画面重心会被超出部分拽偏。
          const sFit = await skillFitScaleAsync(base, W, H, cv.fitMode);
          if (sFit && sFit > 0 && isFinite(sFit)) {
            playOpts = { scale: sFit, x: cx, y: cy, fit: true, center: cv.centerBasis || 'content' };   // 落点固定舞台中心；fit 标记交给 anchorOrigin 做内容居中
          }
        }
        let played = null;
        for (const id of cands) {
          if (await skillResourceExists(id)) {
            played = await playSkill(cell, id, playOpts);
            if (played) {
              // 居中已由 anchorOrigin(opts.fit/fitRect) 统一完成：单个 transform 同时含
              // 「画布原点对齐落点」与「可见内容中心对齐落点」，不再事后叠加 translate
              // （旧实现两段 translate 参考系不一致，放大后内容会偏上/偏出舞台）。
              totalDur = Math.max(totalDur, played.dur || 0); break;
            }
          }
        }
        // canvas 由 playSkill 在 dur+60 自行销毁；此处再移除空壳子容器（动画结束稍后）
        if (played && played.dur) setTimeout(() => cell.remove(), played.dur + 120);
        else cell.remove();
      }
      // 等待技能演出播完，使动画完整落在施法者本回合内（不再 fire-and-forget 溢出入敌方回合/下回合，
      // 避免"技能播放后还在播、看起来两回合不能点击"的错觉）；canvas 由 playSkill 在 dur+60 自行销毁
      if (totalDur > 0) await this._wait(totalDur);
    }
    // 防重复播放：若「特效」(effect/levelEffects) 与「动作动画」(anim/levelAnims) 指向同一资源，且两阶段落点一致，
    // 则特效阶段会再播一次同一动画（如烈焰风暴 effect 与 levelAnims.anim 同为 220050001、castVisual.spread=perUnit
    // → 每个受影响单位被连播两次）。资源相同则跳过特效阶段，仅保留动作动画阶段（同源资源不可能呈现两种不同画面）。
    if (effName && base && effName === base) effName = null;
    if (effName) {
      if (cv.hasCV) {
        // 新配置模式：cv.plays 已是落点集合（one→单点 / perUnit→每个受影响单位）
        if (cv.multi) {
          // 逐单位播放：在该技能【每个受影响单位】身上单独播放该动画（而非屏幕中心只播一次）。
          // 动画资源在 resource/skill/ 走 playSkill，在 resource/effect/ 走 playEffect；按存在性自动选择。
          // 每个落点用独立子容器（cell）：否则 mount() 清空同容器旧 canvas 会让后一个挂载销毁前一个动画，
          // 导致"只显示最后一个目标 + 反复闪烁/卡顿"，而非同时独立播放。
          const isSkillRes = await skillResourceExists(effName);
          const proms = cv.plays.map((p) => {
            const cell = mkCell(p.y);   // 带深度 z-index → 与角色共排序，逐单位独立产生遮挡
            const pr = isSkillRes
              ? playSkill(cell, effName, { scale: 1, x: p.x, y: p.y })
              : playEffect(cell, effName, { scale: 1, x: p.x, y: p.y });
            pr.then(r => { if (r && r.dur) setTimeout(() => cell.remove(), r.dur + 120); else cell.remove(); });
            return pr;
          });
          const res = await Promise.all(proms);
          const maxDur = res.reduce((m, r) => Math.max(m, (r && r.dur) || 0), 0);
          if (maxDur > 0) await this._wait(maxDur);
        } else {
          const p0 = cv.plays[0] || cv.center;
          const cell = mkCell(p0.y);   // 带深度 z-index → 单点特效也参与角色遮挡排序
          const re = await playEffect(cell, effName, { scale: 1, x: p0.x, y: p0.y });
          if (re && re.dur) setTimeout(() => cell.remove(), re.dur + 120); else cell.remove();
          if (re && re.dur > 0) await this._wait(re.dur);
        }
      } else if (skill && skill.perUnitEffect && Array.isArray(targets) && targets.length) {
        // 旧回退：逐单位播放（烈焰风暴等）；保留既有行为，零回归。
        // 同样用独立子容器，避免共用 layer 导致后挂载销毁前一个动画的问题。
        const isSkillRes = await skillResourceExists(effName);
        const proms = targets.map((t) => {
          const p = (t && typeof t.x === 'number') ? { x: t.x, y: t.y } : { x: cx, y: cy };
          const cell = mkCell(p.y);   // 带深度 z-index → 逐单位独立遮挡
          const pr = isSkillRes
            ? playSkill(cell, effName, { scale: 1, x: p.x, y: p.y })
            : playEffect(cell, effName, { scale: 1, x: p.x, y: p.y });
          pr.then(r => { if (r && r.dur) setTimeout(() => cell.remove(), r.dur + 120); else cell.remove(); });
          return pr;
        });
        const res = await Promise.all(proms);
        const maxDur = res.reduce((m, r) => Math.max(m, (r && r.dur) || 0), 0);
        if (maxDur > 0) await this._wait(maxDur);
      } else {
        const p0 = cv.plays[0] || cv.center;
        const cell = mkCell(p0.y);   // 带深度 z-index → 兜底单点特效也参与角色遮挡排序
        const re = await playEffect(cell, effName, { scale: 1, x: p0.x, y: p0.y });
        if (re && re.dur) setTimeout(() => cell.remove(), re.dur + 120); else cell.remove();
        if (re && re.dur > 0) await this._wait(re.dur);
      }
    }
  }

  _showSkillName(name, fig) {
    const sp = this.skillNameLayer;
    if (!sp) return;
    // AS3 BattleSprite 只显示技能名文字（无图标），12px 粗体黑色，居中于 battleskill.png 底图
    sp.textContent = name;
    // 定位到【释放技能者头顶】（对齐 AS3 BattleSprite 挂在 caster 上方、ANIMATE_MOVE 上移淡出）；无 fig 时回退居中顶部
    if (fig && typeof fig.x === 'number') {
      const mcH = (fig._mcHeightPx != null) ? fig._mcHeightPx : 120;
      let top = fig.y - mcH - 46;            // 头顶上方约 46px（横幅高 ~34 + 余量）
      if (top < 6) top = 6;
      sp.style.left = fig.x + 'px';
      sp.style.top = top + 'px';
    } else {
      sp.style.left = '50%';
      sp.style.top = '70px';
    }
    sp.classList.add('show');
    clearTimeout(this._skillNameT);
    this._skillNameT = setTimeout(() => sp.classList.remove('show'), 900);
  }

  // ── 战斗飘字 ───────────────────────────────────────────────────────────
  // 对齐 AS3：animate/battle/BattleInitializer14.as（时序/堆叠/上浮）+ util/UtilUpdater02.as
  // updateHpMpSpNumber（数字图片逐位拼接、正负号、暴击 ×1.3）。

  /**
   * 数值飘字（HP/MP/SP 增减）：用 battle{hp|mp|sp}{数字|nega|plus} 图片逐位拼接。
   * ★0 值（0 伤害 / 0 恢复）完全不显示。
   * 横向居中于模型；同类数字依次【向下】错开一行避免重叠；按类型上浮，距离与时长有序。
   * @param {Fighter} fig 目标单位
   * @param {'hp'|'mp'|'rage'} type 数值类型
   * @param {number} value 变化量（负=减少，正=增加）
   * @param {{crit?:boolean}} opts crit=true 时整体放大 1.3
   */
  _floatNumber(fig, type, value, opts = {}) {
    if (!fig) return;
    // ★ 对齐 AS3：飘字动画(BattleInitializer14)是死亡演出的触发载体——它的 500ms 帧才调 handleResult。
    //   所以【飘字一开始就记时】，即使 0 值导致不显示数字（AS3 里 0 值同样走完动画并触发死亡）。
    //   Fighter.die() 据此把"切倒地帧"推迟到飘字后 500ms，实现原版"数字先飘、怪物随后才倒"的节奏。
    fig._lastFloatMs = performance.now();
    if (!this.numberLayer) return;
    const sprite = buildNumberSprite(type, value, { crit: !!opts.crit });
    if (!sprite) return;                                   // ★0 值：不显示
    const t = (type === NUM_TYPE.MP || type === NUM_TYPE.SP) ? type : NUM_TYPE.HP;
    const w = sprite._numW || 0, h = sprite._numH || 30;

    // 同类型数字计数（对齐 AS3 fighter.getNumSprite(type).numChildren，含刚加入的这个）
    if (!fig._numCount) fig._numCount = { hp: 0, mp: 0, sp: 0, rage: 0 };
    fig._numCount[t] = (fig._numCount[t] || 0) + 1;
    const n = fig._numCount[t];

    // 横向：统一对齐角色坐标 fig.x（与血条/名字/气泡/技能横幅同一居中轴；2026-09-14 用户拍板"统一对齐 fig.x"，
    //       不再居中到身体画布中心 _modelCxEl，避免身体未居中模型(如 Role 210071 偏 38px)上飘字与血条横移错位）。
    // 纵向：头顶 + (n-1)×数字高 —— AS3: y = h*numChildren + fighter.y - mcHeight - h
    const cx = fig.x;
    const mcH = (fig._mcHeightPx != null) ? fig._mcHeightPx : 120;
    const baseY = fig.y - mcH + h * (n - 1);

    sprite.style.left = (cx - w / 2) + 'px';   // 直接算好居中，避免与 scale 叠加后偏移
    sprite.style.top = baseY + 'px';
    // ★ 数字 z 轴跟随目标 fighter 的深度（setDepth: 10000+脚底y，与角色层同序）：
    //   后排/靠上目标的数字垫底、前排/靠下目标的数字盖前；群体结算时多个目标的数字也按站位叠放，
    //   而非按追加（结算）顺序——同目标多类型数字（HP/MP/怒气）已用 h*(n-1) 纵向错开，互不遮挡。
    sprite.style.zIndex = (fig.el && fig.el.style.zIndex) || String(10000 + Math.round(fig.y || 0));
    if (opts.crit) { sprite.style.transformOrigin = '50% 50%'; sprite.style.transform = 'scale(1.3)'; }
    this.numberLayer.appendChild(sprite);

    // 上浮（AS3 ANIMATE_MOVE 线性移动到 y - rise），播完移除并回收该类型的堆叠位
    const rise = FLOAT_RISE[t] || 40;
    const dur = FLOAT_DUR[t] || 950;
    requestAnimationFrame(() => {
      sprite.style.transition = 'top ' + dur + 'ms linear';
      sprite.style.top = (baseY - rise) + 'px';
    });
    setTimeout(() => {
      sprite.remove();
      if (fig._numCount && fig._numCount[t] > 0) fig._numCount[t]--;   // 回收堆叠位，避免数字持续下沉
    }, dur + 60);
  }

  // 文字类飘字（闪避/苏醒/暴击/防御/捕捉/升级等非数值提示）：保留文本渲染
  _floatText(fig, text, color) {
    if (!fig || !this.numberLayer) return;
    const f = document.createElement('div');
    f.className = 'float-num'; f.textContent = text; f.style.color = color;
    f.style.left = fig.x + 'px';
    f.style.top = (fig.y - 150) + 'px';
    f.style.zIndex = (fig.el && fig.el.style.zIndex) || String(10000 + Math.round(fig.y || 0));
    this.numberLayer.appendChild(f);
    setTimeout(() => f.remove(), 950);
  }

  /**
   * 统一飘字入口（skill-engine 的 ctx.float 走这里）：
   * 纯数值（如 '-123' / '+50'）→ 数字图片通道（0 值自动不显示）；其余 → 文字通道。
   */
  _floatNum(fig, text, color, opts = {}) {
    const m = /^([+-]?)(\d+)$/.exec(String(text).trim());
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      return this._floatNumber(fig, opts.type || NUM_TYPE.HP, sign * Number(m[2]), opts);
    }
    return this._floatText(fig, text, color);
  }

  // ── 战斗表现动画（替代文字提示，对齐 AS3 GlobalsLoader.getCharacter）─────────
  // AS3 原版中 闪避/暴击/防御/捕捉/升级 都是【动画资源】而非文字：
  //   BattleInitializer14: miss_phy / miss_mag / baoji 挂在角色位置
  //   BattleInitializer15: defend_lr(pid<10 我方) / defend_rl(敌方) + attack（受击）
  //   BattleInitializer19: catch（捕捉，挂在被捕目标身上）
  //   CurrentPanelNpc: uplevel（升级，resource/effect/uplevel）
  /**
   * 在角色位置播放一段战斗表现动画。
   * @param {Fighter} fig 目标单位
   * @param {string} name 动画资源名（默认 resource/battle/{name}/；opts.effect=true 时走 resource/effect/{name}/）
   * @param {{dur?:number, effect?:boolean}} opts
   */
  _floatAnim(fig, name, opts = {}) {
    if (!fig || !name) return null;
    const layer = this.characterLayer || this.areaSkillLayer;
    if (!layer) return null;
    const cell = document.createElement('div');
    cell.style.position = 'absolute'; cell.style.left = '0'; cell.style.top = '0';
    cell.style.pointerEvents = 'none';
    // ★ 表现动画（闪避/未命中/暴击/受击/防御…）必须盖在技能动画之上、伤害数字之下：
    //   技能 cell 深度上限为 19999（fit 全屏演出），此处取 20000+groundY 稳居其上；
    //   伤害数字在 numberLayer（独立层 z:65）里，characterLayer 是 z:2 的堆叠上下文，
    //   故层内任意 z-index 都低于 numberLayer → 自动位于伤害数字之下。
    cell.style.zIndex = String(20000 + Math.round(fig.y || 0));
    layer.appendChild(cell);
    const dur = opts.dur || BATTLE_FX[name] || 800;
    const cx = fig.x;   // 角色原点（脚点=画布中心256,256）；user 2026-09-11：技能叠加按原点而非身体中心
    // ★ 防御特效（defend_lr/defend_rl）按一次性播放：其主动画 f6 用 rE 移除盾牌、f6-f9 为真空帧，
    //   freezeLast 定格在空白末帧（盾牌在内容结束处自然消失，符合"播放一次"的语义），
    //   cell 由 BATTLE_FX 的 500ms 销毁计时统一回收。其余表现特效（闪避/未命中/暴击/受击）
    //   保持原有 loop 行为不变。
    const oneShot = ONE_SHOT_FX.has(name);
    const play = opts.effect
      ? playEffect(cell, name, { x: cx, y: fig.y, scale: this.SCALE })
      : playStatus(cell, name, { x: cx, y: fig.y, scale: this.SCALE, loop: !oneShot });
    Promise.resolve(play).catch(() => {}).then(() => {
      // ★ 13r：必须走 _disposeCell（先 pause 再摘 DOM）——playStatus 分支不会被 loader 自动销毁，
      //   原实现直接 cell.remove() 会让该动画的 fanvas Timer 永久空转。
      setTimeout(() => _disposeCell(cell), dur);
    });
    return cell;
  }

  /**
   * 通用"被击退/闪避位移"：按阵营方向平移后延时复位。
   * 对齐 AS3：敌方(pid>9)左移、我方右移；连锁受击时复用【首次】原位，避免多次位移叠加漂移。
   */
  async _knock(fig, dx, dy, backMs, key, onBack) {
    // ★ 即使 fig 已阵亡(_down) 也必须调用 onBack：
    //   onBack 承担"复位受击半透明 opacity / 归位"等收尾职责，早返回会让 opacity 永久卡在 0.5。
    if (!fig) return;
    // ★ 战斗已结束（逃跑/胜利/失败收尾中或已完成）：绝不再发起位移。
    //   _knock 会在 moveTo 之后挂一个 backMs 的 setTimeout 做"归位"，该定时器在战斗结束
    //   （尤其逃跑：可在任意时刻点击）后仍会触发，并用当时图省事缓存的 home（战斗站位坐标）
    //   调 moveTo —— 而那时 el 已被挂回主城、isConnected 恒为 true，
    //   于是把回城后的角色重新拽向战斗坐标 → 表现为"回城后角色被拖走/漂移，无行走动画"。
    if (this._ended || this._ending) { if (onBack) onBack(); return; }
    if (fig._down) {
      // ★ 阵亡单位仍需"受击反馈"可见：保留刚设下的半透明(0.5)闪现 backMs 后再复位，
      //   对齐 AS3 BattleInitializer15.fighterUnderfire（100ms 半透明、500ms 复位）。
      //   旧逻辑在此即时复位 → 一击毙命的敌方单位永远看不到受击效果（玩家几乎不会被一击致死故照常显示，
      //   敌方却常一击毙命 → 表现为"敌方受击效果消失"）。此处延后复位并跳过位移（死亡单位不再移动，
      //   避免与倒地动画争抢坐标）；onBack 仍会执行，opacity 不会卡在 0.5。
      const tKey = key + 'T';
      clearTimeout(fig[tKey]);
      fig[tKey] = setTimeout(() => { if (onBack) onBack(); }, backMs);
      return;
    }
    const homeKey = key + 'Home', tKey = key + 'T';
    if (!fig[homeKey]) fig[homeKey] = { x: fig.x, y: fig.y };
    const home = fig[homeKey];
    clearTimeout(fig[tKey]);
    const d = (fig.side === 'enemy') ? -1 : 1;
    await fig.moveTo(home.x + d * dx, home.y + d * dy);
    // moveTo await 期间角色可能已阵亡/退场：此时直接收尾，避免残留定时器与半透明
    if (fig._down) { fig[homeKey] = null; if (onBack) onBack(); return; }
    // 归位定时器：回调内再加一道战斗结束守卫，杜绝"定时器在战斗结束后触发归位位移"
    fig[tKey] = setTimeout(() => {
      if (this._ended || this._ending) { fig[homeKey] = null; if (onBack) onBack(); return; }
      if (!fig._down) fig.moveTo(home.x, home.y);
      fig[homeKey] = null;
      if (onBack) onBack();
    }, backMs);
  }

  // 闪避 / 未命中（对齐 AS3 BattleBuilder.as:269 的结果分派）：
  //   闪避/招架(JOOK) → jook_phy / jook_mag 特效（金/蓝「闪避」字）+ 模型后退
  //                     （AS3 BattleInitializer03.fighterMiss：±30/±15，800ms 复位）
  //   未命中(MISS)    → miss_phy / miss_mag 特效（红/青「MISS」字），原地不动、绝不位移
  // opts.retreat===false 即「未命中」：只播 miss 动画、不触发模型后退。
  _showMiss(fig, isMagic, opts = {}) {
    if (!fig) return null;
    const dodge = opts.retreat !== false;
    this._floatAnim(fig, dodge ? (isMagic ? 'jook_mag' : 'jook_phy')
                               : (isMagic ? 'miss_mag' : 'miss_phy'));
    if (!dodge) return null;
    return this._knock(fig, 30, 15, 800, '_dg');
  }

  // ★ 本次受击是否伴随"防御之外"的其他触发（昊天/同生/穿心/腐骨/仙气/八荒/反伤/反击/昏睡苏醒等【受击时】生效的联动）。
  //   存在额外触发时，不再叠加防御专属姿势 defend_lr/rl（让触发自身演出独占）；仅纯防御挨打才播该姿势。
  //   ★ 只判 UNDERFIRE_EXTRA_KINDS（受击联动的 kind）——不可再判 d.dot / d.heal 的「存在」：
  //   中毒/灼烧/流血(持续伤害)与回春(持续回血)是在【单位自己回合开始】时由 _tickBuffsFor 结算的
  //   （_unitTurnStart → _tickBuffsFor，scene.js:3133），与「本次被攻击」完全无关。若按存在性判定，
  //   防御单位一旦在中途获得这类持续状态（如宠物给它挂了回春、被上了毒），_hasUnderfireExtra 便恒为 true，
  //   防御姿势从此一回合都不播——这正是「前几回合有防御特效、过几回合突然消失」的根因。
  _hasUnderfireExtra(fig) {
    const bs = fig && fig.buffs;
    if (!bs || !bs.length) return false;
    for (const b of bs) {
      if (UNDERFIRE_EXTRA_KINDS.has((b.def || {}).kind)) return true;  // 受击联动 / 昏睡苏醒
    }
    return false;
  }

  // 受击：播放 attack 命中特效 + 轻位移与半透明（AS3 BattleInitializer15.fighterUnderfire：±4/±2，alpha .5，500ms 复位）
  _underfire(fig) {
    if (!fig) return;
    this._floatAnim(fig, 'attack');
    // ★ 防御单位挨打、且【无额外触发】时播放防御专属受击姿势（defend_lr/defend_rl，500ms），敌我方向不同：
    //   敌方(defending)→defend_rl，我方(defending)→defend_lr。该姿势意义是"显示处于防御状态"，故只在纯防御挨打时播；
    //   但"被打中时的防御姿势"作为受击反馈若本次受击还带额外触发（_hasUnderfireExtra）则让触发自身演出独占，不再叠加防御姿势（避免冲突）。
    if (fig.defending && !this._hasUnderfireExtra(fig)) {
      this._floatAnim(fig, fig.side === 'enemy' ? 'defend_rl' : 'defend_lr');
    }
    // ★ 半透明只施加、恢复统一交给 _knock 的回调；但必须记录"原始 opacity"而非当前值：
    //   连续受击时若直接读 el.style.opacity，第二次会读到上一次写入的 '0.5' 并把它当作"原值"，
    //   导致恢复后仍停在 0.5（表现为"敌方突然保持半透明"）。用 _baseOpacity 记住真正的基线。
    if (fig._baseOpacity == null) fig._baseOpacity = fig.el.style.opacity || '';
    fig.el.style.opacity = '0.5';
    return this._knock(fig, 4, 2, 500, '_uf', () => {
      fig.el.style.opacity = fig._baseOpacity || '';
      fig._baseOpacity = null;
    });
  }

  _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async _win() {
    if (this._ended) return;
    this._ended = true; this.busy = true;
    this._stopTurnTimer();
    this._endBattleCleanup();
    playSfx('win');    // 战斗胜利音（受设置「音效」开关门控）
    // 结算尚未发奖的敌人（如"跳过战斗"）：正常流程每只敌人倒下时已在 _awardKill 发奖
    for (const e of this.enemies.filter(x => !x._awarded && x.hp > 0)) await this._awardKill(e);
    // 胜利演出：仅残余存活的敌方可定格倒地末帧；玩家已存活，绝不能播放死亡动画
    // （_onEnemyDown 已把阵亡敌人移出 this.enemies 并在最后一只=eFig 时清空 eFig，
    //   故胜利时 eFig 与 this.enemies[0] 均为空，绝不可回退到 this.pFig 播放倒地）
    const winFig = (this.eFig && this.eFig.hp > 0) ? this.eFig
                  : (this.enemies.find(e => e && e.hp > 0) || null);
    if (winFig && winFig !== this.pFig) await winFig.down();
    this.mLog('战斗胜利！');
    // 副本通关掉落（对齐掉落权重编辑器：dropRule 指向 drops 表）—— 走权威背包，不覆盖快照
    if (this.dungeon && this.dungeon.dropRule) {
      const drops = rollDropsByDropId(this.dungeon.dropRule);
      drops.forEach(it => {
        const def = Config.data.items && Config.data.items[it.itemId];
        this.mLog('副本通关掉落：' + (def ? def.name : it.itemId) + ' ×' + it.count);
      });
      this._giveBattleRewards(drops);
      this.sm.ui.bindPlayer(this.player);
      if (this.sm.ui.recordBattle) this.sm.ui.recordBattle({ win: true, enemy: this.dungeon.name, reward: '副本掉落 ' + drops.length + ' 件', round: this.round, level: this.player.level, enemyLevel: (this.monsterNpc && this.monsterNpc.level) || (this.eFig && this.eFig.level) || null, dmgDealt: this._dmgDealt, dmgTaken: this._dmgTaken });
    }
    this.sm.ui.bindPlayer(this.player);
    // 「继续」按钮已按用户要求删除（2026-10-05）：自动淡出回城计时保留，玩家无需手动点
    this._endTimer = setTimeout(() => { if (!this._ending) this._end(true, false); }, 1700);
  }

  // 主角阵亡：与队员 _onAllyDown 的阵亡演出【完全一致】（user 2026-09-13 拍板「两处都改」）。
  //   ① 同样广播 UNIT_DEATH，且必须置于 _endBattleCleanup 的 clearBuffs 之前
  //      ——否则阵亡者自身挂的「死亡触发」buff/技能无法命中（_drain 里 UNIT_DEATH 有专门豁免）。
  //   ② 返回可 await 的 Promise：整段阵亡演出（飘字后 500ms 切倒地帧 + 900ms 时间轴）播完才 resolve，
  //      调用方（战斗主循环）据此等演出结束 —— 与 _onAllyDown 被 Promise.all await 对称。
  //   UI 时序不变：日志 / 1900ms 自动回城计时都在 await【之前】就位，
  //   玩家不会看到"死了之后卡住 1.4s 没反应"。
  //   「返回主城」按钮已于 2026-10-05 按用户要求删除（改由自动计时淡出回城），
  //   故不再有「演出窗口内显式点按钮」的路径；_end → _endBattleCleanup → _cancelDeathFx
  //   作废残余回调仍由自动计时触发。
  async _lose() {
    this._ended = true; this.busy = true;
    this._stopTurnTimer();
    // ★ UNIT_DEATH：置于 _endBattleCleanup 之前（使阵亡者自身的"死亡触发"仍可命中）
    if (this.pFig) emitEvent(this, EVENTS.UNIT_DEATH, { source: this.pFig, target: this.pFig, skillType: 'death' });
    this._endBattleCleanup();
    playSfx('lose');   // 战斗失败音（受设置「音效」开关门控）
    this.mLog('你倒下了……');
    if (this.sm.ui.recordBattle) this.sm.ui.recordBattle({ win: false, enemy: (this.monsterNpc && this.monsterNpc.name) || this.eFig.name, reward: '', round: this.round, level: this.player.level, enemyLevel: (this.monsterNpc && this.monsterNpc.level) || (this.eFig && this.eFig.level) || null, dmgDealt: this._dmgDealt, dmgTaken: this._dmgTaken });
    // 「返回主城」按钮已按用户要求删除（2026-10-05）：自动淡出回城/复活计时保留
    this._endTimer = setTimeout(() => { if (!this._ending) this._end(false, false); }, 1900);
    // ★ 演出置于最后 await：上面 UI 已就位，这里只等演出播完（我方 = 非清场分支，900ms 现身并回原位）。
    if (this.pFig && typeof this.pFig.die === 'function') await this.pFig.die({ isDead: true, clearOnDeath: false });
    else this._act(this.pFig, ACTION.DOWN);
  }

  _addQuestProgress(monsterId) {
    const qs = this.sm.questState;
    qs.forEach(q => {
      const def = Config.quests[q.id];
      if (def && def.target.monster === monsterId && q.accepted && !q.done) {
        q.progress += 1;
        this.sm.ui.log(`任务进度：${q.name} ${q.progress}/${q.target}`, 'story');
      }
    });
    this.sm.ui.setQuestState(qs);
    // ★ 对接 talk 杀怪条件框架（op62 conditionItem 的「名字 (0/N)」条目）：
    //   addKill 按怪物名推进已接任务的计数，返回被推进的任务 id；再统一刷追踪栏/标记/聊天窗。
    try {
      const tpl = (Config.monsters || {})[monsterId];
      const mName = tpl && tpl.name;
      if (mName) {
        const ts = talkSys();
        const advanced = ts.net.state.addKill(mName);
        if (advanced && advanced.length) ts.net.onKillAdvanced(advanced, mName);
      }
    } catch (e) { console.warn('[quest] talk addKill 失败：', e); }
  }

  // 跳过战斗（对齐 requestSkipBattle：直接判胜）
  _skip() {
    if (this._ended) return;
    this.sm.ui.toast('已跳过战斗');
    this._win();
  }

  _flee(escapeBtn) {
    if (this._ended) return;
    this._stopTurnTimer();
    // 逃跑成功率 60%
    const ok = Math.random() < 0.6;
    if (ok) {
      this.mLog(this.player.name + ' 逃走了');
      playSfx('flee');   // 逃跑成功音
      this._end(false, true);
    } else {
      this.mLog('逃跑失败！');
      // 逃跑失败＝消耗当前行动单位的回合，直接唤醒行动队列继续推进到下一单位（不再链式触发整段敌方回合）
      if (this._unitResolve) this._endUnitAction();
    }
  }

  async _end(win, fled) {
    if (this._ending) return;               // 防重入（胜利/失败/逃跑/跳过可能并发触发）
    this._ending = true;
    // ★ 对齐 AS3 stopBattle：移除指令条 + 撤技能栏遮罩（结算按钮随舞台一起淡出，不再可点）
    this._setBattleHud('end');
    // ★ 立刻落下位移闸门（不等后面的 appendChild 复位）：_end 前半段有 await（渐隐等），
    //   期间被打断的异步链（_approach → _retreat）可能发起【新的】moveTo——代际拦不住"后来者"，
    //   必须靠 blockMove 这道硬闸。此处一置位，所有单位后续任何 moveTo 一律直接 resolve 不动。
    {
      const _blk = (f) => { if (f && typeof f.blockMove === 'function') f.blockMove(); };
      _blk(this.pFig);
      for (const f of (this.allies || [])) _blk(f);
      for (const f of (this.enemies || [])) _blk(f);
    }
    if (this._endTimer) clearTimeout(this._endTimer);
    // 清理战斗悬停高亮监听（对齐 enter() 中注册的 mousemove/mouseleave/click/contextmenu）
    if (this.battleStage) {
      this.battleStage.removeEventListener('mousemove', this._onBattleHover);
      this.battleStage.removeEventListener('mouseleave', this._onBattleHoverLeave);
      this.battleStage.removeEventListener('click', this._onBattleClick);
      this.battleStage.removeEventListener('contextmenu', this._onBattleCancel);
    }
    if (this._bHovered) { this._bHovered.el.classList.remove('hovered'); this._bHovered = null; }
    // 恢复主城被隐藏的层（进战时仅保留地图层，隐藏了 actor 层与主城提示）
    if (this._mainActorLayer) this._mainActorLayer.style.display = '';
    if (this._mainHint) this._mainHint.style.display = '';
    this._stopTurnTimer();
    this._endBattleCleanup();              // 写回召唤兽血量并清理 ally（逃跑/跳过等路径同样覆盖）
    this._releaseEnemies();                // 存活敌方实例回收对象池（阵亡的已在 _onEnemyDown 回收）
    clearContainer(this.characterLayer);   // 暂停战斗画布（含敌方）
    if (this.chatBubbles) { this.chatBubbles.clearAll(); this.chatBubbles.setLayer(null); }  // 清战斗气泡并切回地图挂载模式
    // ★ 玩家立绘不入对象池（常驻实例，直接带回主城），需单独复位受击半透明与归位状态：
    //   若最后一击后 500ms 内结束战斗，_underfire 的恢复回调会被 _knock 中断，
    //   opacity 会残留 0.5 并被带到大世界地图上（表现为"人物回到主城还是半透明"）。
    if (this.pFig && this.pFig.el) {
      this.pFig.el.style.opacity = '';
      this.pFig._baseOpacity = null;
      clearTimeout(this.pFig._ufT); clearTimeout(this.pFig._dgT);
      this.pFig._ufHome = null; this.pFig._dgHome = null;
    }
    if (!fled) this.player.hp = this.player.maxHp;
    // ★ 先掐断在飞的战斗位移，再把玩家立绘挂回主城（顺序不可颠倒）：
    //   pFig 与 sm.player 是**同一个 Fighter 实例**（见 enter(): this.pFig = this.player），
    //   共用 x/y。战斗位移由 Fighter.moveTo 的 rAF 循环驱动，其退出条件只有「到达」或「el 摘离」。
    //   若此刻仍有未收敛的 moveTo（玩家/敌人 _approach 途中点逃跑、受击 _knock 的定时复位尚未触发），
    //   下面 appendChild 会让 el.isConnected 重新为 true → 该循环不会退出，
    //   于是在重启的主城循环里持续把刚复位的坐标拽向**战斗站位** → 回城后角色被拖走/漂移，
    //   且走的是裸 setPos（不经 _update 的 p.walk()）→ 无行走动画。
    //   invalidateMove() 递增位移代际，令旧循环下一帧自检退出。
    //   （逃跑路径尤其明显：逃跑按钮可在任何时刻被点击，不等待当前演出收尾。）
    const _stopMove = (f) => { if (f && typeof f.blockMove === 'function') f.blockMove(); else if (f && typeof f.invalidateMove === 'function') f.invalidateMove(); };
    _stopMove(this.pFig);
    for (const f of (this.allies || [])) _stopMove(f);
    for (const f of (this.enemies || [])) _stopMove(f);
    // 冻结恢复：把玩家立绘移回主城 actor 层，复位世界坐标/朝向，重启主城渲染循环（不重建地图）
    this.pFig.showBars = false; this.pFig.hpBar.style.display = 'none';
    this.pFig.battleScale = null;           // 清回主城缩放上下文：stand() 不再误用战斗 SCALE(0.72)
    this.pFig.hpAbove = false;              // 复位血条位置：回到主城后落在脚底下方（与 NPC 一致；主城玩家血条本就隐藏）
    if (typeof this.pFig.setRideVisible === 'function') this.pFig.setRideVisible(true);   // 恢复骑宠层（骑乘中则重新挂上）
    const main = this.sm._main;
    if (main && main.actorLayer) {
      main.actorLayer.appendChild(this.pFig.el);
      // 复活点：战斗失败（非逃跑）优先落 revive_point，否则退回进战前位置
      const isLoss = (!win && !fled);
      const rv = (isLoss && main.map && main.map.revivePoint) ? main.map.revivePoint : this._restorePos;
      this.pFig.setPos(rv.x, rv.y);
      this.pFig.dir = rv.dir;
      this.pFig.stand();                   // 以主城缩放(1)重建立绘；_anchorByOrigin 按(角色,缩放)缓存原点锚点（切换动作不重算、不漂移）
      this.sm.current = main;
      main._resume();
      // ★ 解除位移闸门（关键！）：pFig 是【常驻实例、不入对象池】，不会被 initState/acquire 重新解锁。
      //   上面 blockMove() 已把 _moveBlocked 置 true，若不在此解锁，玩家回城后将【永久无法移动】
      //   （moveTo 入口直接 return）。战斗已彻底收尾、坐标已复位、主城循环已重启，此刻解锁是安全时机。
      //   敌方单位走对象池 release→下次 acquire 的 initState 自会 allowMove，无需在此处理。
      if (this.pFig && typeof this.pFig.allowMove === 'function') this.pFig.allowMove();
    } else {
      this.sm.enterMain();                 // 兜底：主城实例丢失时退回重建
    }
    this.sm.ui.log(fled ? '你逃走了。' : (win ? '战斗胜利，获得奖励。' : '战斗结束，已复活。'), 'sys');
    // 退出渐变溶解（严格对齐 AS3 GAME_STATE==MIDDLE）：
    // 先隐去战斗舞台内容（角色/指令/按钮），仅留背景画布做反向溶解，
    // 待 battle_background 由 0.6→0 渐隐、露出大地图后再移除战斗 DOM，避免硬切回城。
    if (this.battleStage) { this.battleStage.style.opacity = '0'; this.battleStage.style.visibility = 'hidden'; }
    try { await this._fadeOutBackGround(); } catch (e) { console.error('[battle] 退场渐变异常，继续清理', e); }
    // ★ 兜底（2026-09-13，修复"点不了但能动、overlay=0"）：无论上面是否抛异常，
    //   战斗 DOM 必须被隐藏并移除。否则残留的透明 #battle-layer(z8, pointer-events:auto)
    //   会盖在大地图之上吞掉所有点击、却放行键盘移动（主循环仍在跑）→ 表现即用户反馈的卡死。
    //   典型触发：_end 在 remove 之前因 main.actorLayer 等异常中断，而 sm.current 已切回 MainScene。
    const bl = this.battle;
    if (bl) {
      try { bl.classList.add('hidden'); } catch (e) {}
      if (bl.parentNode) bl.parentNode.removeChild(bl);
    }
  }
}

// ── 主循环异常诊断入口（页面加载即存在，不依赖"是否已经发生过异常"）──
//   window.__loopErrors     最近 30 条记录（含 tag/msg/stack/时间）
//   window.__dumpLoopErrors()  取副本；没异常时返回空数组，本身就是"没抛过"的证据
if (typeof window !== 'undefined') {
  window.__loopErrors = window.__loopErrors || [];
  window.__dumpLoopErrors = () => (window.__loopErrors || []).slice();
  window.__loopErrSummary = () => {
    const sc = window.__TS && window.__TS.current;
    return { total: (sc && sc._loopErrN) || 0, byStep: (sc && sc._loopErrByTag) || {}, recent: window.__dumpLoopErrors().slice(-5) };
  };
  // ★ 点击阻断自检（2026-09-13）：卡住时点不了时，在控制台跑 __diagBlocker() 即可打印
  //   覆盖视口中心、pointer-events≠none 的所有元素，定位真正吞点击的透明全屏层（如残留 #battle-layer）。
  window.__diagBlocker = () => {
    const cx = Math.floor(window.innerWidth / 2), cy = Math.floor(window.innerHeight / 2);
    const elc = document.elementFromPoint(cx, cy);
    const top = elc ? (elc.tagName + (elc.id ? '#' + elc.id : '') + '.' + (typeof elc.className === 'string' ? elc.className : '').slice(0, 40)) : 'null';
    const list = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (!(r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy)) continue;
      list.push({
        tag: el.tagName.toLowerCase(), id: el.id || '', cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        pos: cs.position, pe: cs.pointerEvents, z: cs.zIndex, bg: cs.backgroundColor,
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
    console.log('[diag] 视口中心命中:', top, '| 覆盖中心且可点的层数:', list.length);
    console.table(list);
    return { top, blockers: list };
  };
}

export { SceneManager, bus, BattleScene };
