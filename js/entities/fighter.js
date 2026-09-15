// fighter.js
// 对应 deobfuscated/characters/Fighter.as + Player.as + CharactersSprite.as
// 战斗/地图上"一个参战单位"的运行时表现：属性(HP/MP/SP/攻防) + 立绘(canvas 动画) + 姓名/血条/状态。
// 朝向 dir: 'left' | 'right'（与 globals.ACTION 的方向约定一致）

import { playChar, playRideLayer, clearContainer, playStatus, loadEffect, anchorOrigin, mount, resolveFoot, actionPoolSet } from '../core/loader.js?v=20261007c';
import { ensureColorMatrixFilter, removeColorMatrixFilter, toSVGValues, resolveVariantMatrix } from '../core/color-matrix.js?v=20261007c';   // 变异/染色颜色矩阵滤镜（套到 _bodyWrap，覆盖身体+纸娃娃层）
import { ACTION, Config, resolveAction } from '../core/globals.js?v=20261007c';
import { HPBAR } from '../core/battle-number.js?v=20261007c';   // 血条图片资源（对齐 AS3 Fighter.initHpbar：框 battlehpbar.png + 填充 battlehp.png）
import { derive as _deriveAttrs, rint as _rint } from './attrs.js?v=20261007c';
import { equipStats as equipStatsOf } from '../item/equip-stats.js?v=20261007c';   // 装备属性解析（desc → 数值表，1180 件装备覆盖）
import { applyPassiveBuffs } from '../skill/skill-engine.js?v=20261007c';   // 被动技能加成层（派生后叠加）   // _rint：统一取整口径（属性/伤害一律四舍五入）
import { getRidepetType, getRidepetLift, invalidateRidepetTypeCache, STAND_LIFT_DEFAULT } from '../ridepet/ridepet-type.js?v=20261007c';   // 骑宠显示类型（乘骑型/站立型）+ per-model 站立抬升量（均 async，读模型 index.html）

// 状态 kind → resource/battle/{n} 动画目录（用户指定：1=减速 / 2=虚弱 / 4=眩晕 / 8=中毒）
// 状态持续期间，对应动画"直接贴着模型头顶上方"循环播放（无偏移）；buff 移除时停止 Timer 并移除 canvas。
const STATUS_ANIM = { slow: '1', weak: '2', stun: '4', poison: '8' };

// 兜底模型 charId：真实角色模型未载入/跨域污染时，渲染此模型并量其包围盒
// （user 2026-09-11 指定：兜底默认模型 = 301000，resource/char/301000 存在完整资源）
const FALLBACK_CHAR_ID = 301000;

// ★★ 锚定唯一基准 = 「模型的 Flash 符号原点 (0,0)」——不再有任何 "512 画布中心 256" 魔法常数。
//   user 2026-09-12：「我在这里看到0,0的坐标是正确的，所有的256,256都错，然后这个可见脚底方案导致偏移出现，
//   能不能从根本上去掉它」⇒ 旧的 (CANVAS_CENTER − foot) 口径（对单 Role 精灵 foot=(0,0) 会推出 (256,256)，
//   把红叉/名字/纸娃娃层整体推到模型右下角）已彻底删除。
//
//   统一口径（本文件内所有锚定量的单一真源）：
//     · foot = resolveFoot(...) —— 模型被 pin 到地图格的那一点（渲染池局部坐标）。
//       常规角色 = (256,256)（原始根时间轴 tx=ty=−256 的补偿）；单个 Role 精灵 = (0,0)（符号原点）。
//     · canvasWrap 平移把 foot 钉到 .el(0,0) ⇒ .el(0,0) ≡ 锚点 ≡ 脚点（红叉 originEl 恒在此）。
//     · 身体 flash 原点(0,0) 在 .el 的像素位置 = (−footX*scale, −footY*scale)（= _originDX/_originDY，与 rect 无关）。
//       纸娃娃/武器层只需把【自身 flash 原点】对齐到这一点（层算式见 _applyLayerPos）。
//   对常规角色 foot=(256,256) ⇒ _originDX = −256*scale，与旧式「(256−foot) − 256」展开后恒等 ⇒ 层位置零变化。

export class Fighter {
  constructor(opts) {
    this.initState(opts);    // 数据初始化（与 reinit 共用，单一真源）
    this.initDisplay();      // 首次建 DOM（对象池复用走 acquire → Fighter.reinit，不重建 DOM）
  }

  // ── 数据初始化（单一真源：构造期与池复用 reinit 共用）──
  // 只设置"数据/状态"字段，不碰 DOM。复用的实例(this.el 已存在，来自对象池)会先清掉纸娃娃层与残留 buff，保证回收后干净。
  initState(opts = {}) {
    // 复用前清理：仅当本实例已建过 DOM（来自对象池）才需清旧状态
    if (this.el) {
      if (this.layers && Object.keys(this.layers).length) this.clearLayers();
      if (this.buffs && this.buffs.length) this.clearBuffs();
      // ★ 兜底复位受击半透明/归位定时器：即便实例未经 release() 被复用（如异常路径），
      //   也保证新单位不以残留的 opacity=0.5 出场。
      this.el.style.opacity = '';
      clearTimeout(this._ufT); clearTimeout(this._dgT);
      this._ufHome = null; this._dgHome = null;
      // 复用前作废上一轮残留的位移循环（对手若未经 release 直接被复用，旧 moveTo 不得再回写坐标）
      this.blockMove();
    }
    // 身份 / 阵营
    this.id = opts.id;
    this.name = opts.name || '';
    this.charId = opts.charId;
    this.portrait = opts.portrait || null;
    this.sex = opts.sex || null;
    this.profession = opts.profession || null;
    this.prestige = opts.prestige || null;
    this.job = opts.job || null;
    this.side = opts.side || 'player';
    this.isMonster = !!opts.isMonster;
    this._noModel = !!opts._noModel;
    // 身体为特效（传送法阵 transport 等）：Fighter 仍正常进入 actors/npcs（像素命中/最近提示/点击对话原样生效），
    // 但其"身体"渲染成 resource/effect/<id>/ 特效而非 char 模型（对应反编译 CurrentPanelNpc.as:436-438
    // npcType==NPC_TRANSFER && bodyImg=="150" ⇒ bodyImg="transport"；resource/char/150 不存在）。
    this._bodyEffectId = opts.bodyEffectId || null;
    // 固定深度（F9：传送法阵等地面贴附特效）：置底且不参与 Y 轴深度排序，
    // 避免法阵压在角色/地面物件之上；渲染层仍在 actor-layer（高于 map-layer）。
    this._fixedDepth = !!opts.fixedDepth;
    if (this.el && this._fixedDepth) this.el.style.zIndex = '0';   // 池复用时也立即置底
    // 等级 / 主属性（派生战斗属性由 applyDerived 计算，通常进入战斗前调用）
    this.level = opts.level || 1;
    this.stamina = opts.stamina || 0;
    this.intellect = opts.intellect || 0;
    this.strength = opts.strength || 0;
    this.agility = opts.agility || 0;
    this.faith = opts.faith || 0;
    this.crit = opts.crit || 0;
    // ★ 爆击（crit）在 derive 中是【透传输入】（out.crit = 输入 crit），applyEquip 再在其上叠加装备暴击：
    //   this.crit = _baseCrit + c。若 applyDerived 直接把 this.crit 当输入，重算时 _baseCrit 会吃进
    //   上一轮的装备暴击，每重算一次涨一遍 c。故派生输入必须用「角色基础值」而非「当前叠加值」。
    this._srcCrit = this.crit;
    this.toughness = opts.toughness || 0;
    this.potential = opts.potential || 0;
    this.leftPoint = opts.leftPoint || 0;
    // 战斗资源（先 max 后 current：hp/mp setter 依赖 maxHp/maxMp 夹取）
    this.maxHp = (opts.maxHp != null) ? opts.maxHp : (opts.hp != null ? opts.hp : 100);
    this.hp    = (opts.hp != null) ? opts.hp : 100;
    this.maxMp = (opts.maxMp != null) ? opts.maxMp : (opts.mp != null ? opts.mp : 50);
    this.mp    = (opts.mp != null) ? opts.mp : 50;
    this.rageMax = (opts.rageMax != null) ? opts.rageMax : 100;
    this._rage = (opts.rage != null) ? opts.rage : 0;   // 怒气：底层 setter 的备份字段（见下方 get/set rage）。构造期直接写 _rage，不触发展示。
    // 寿命（仅宠物；人物/怪物 lifeMax=0 即「无寿命系统」）：战斗开始为满值，耗尽则不能出战（食物补充）
    this.lifeMax = (opts.lifeMax != null) ? opts.lifeMax : 0;
    this.life    = (opts.life != null) ? opts.life : this.lifeMax;
    this.valor = 0;   // 侠义之心（独立状态，非 buff）
    this.__passiveApplied = false;   // 被动挂载幂等标志：新建/池复用统一从这里开始
    // 战斗属性（可由 applyDerived + applyEquip 在进入战斗时覆盖）
    this.atk = opts.atk || 0;
    this.def = opts.def || 0;
    this.mag = opts.mag || 0;
    this.magDef = opts.magDef || 0;
    this.spd = opts.spd || 0;
    this.phyHit = opts.phyHit || 0;
    this.magHit = opts.magHit || 0;
    this.phyDodge = (opts.phyDodge != null) ? opts.phyDodge : (opts.dodge || 0);
    this.magDodge = opts.magDodge || 0;
    this.phyCrit = opts.phyCrit || 0;
    this.magCrit = opts.magCrit || 0;
    this.recover = opts.recover || 0;
    this.xiuwei = (opts.xiuwei != null) ? opts.xiuwei : _rint((this.level || 1) * 900);
    // 进度 / 经济
    this.exp = opts.exp || 0;
    this.expNext = opts.expNext || 0;
    this.silver = opts.silver || 0;
    this.gold = opts.gold || 0;       // 金子（第二货币；银子 silver 为主交易货币）
    this.bindGold = opts.bindGold || 0;
    // 装备 / 技能 / 背包
    this.equip = opts.equip || null;
    this.enhance = opts.enhance || {};
    this.skillLevels = opts.skillLevels || null;
    this.skills = opts.skills || null;
    this.bag = opts.bag || null;
    this._attrOverrides = opts._attrOverrides || null;
    this.invincible = !!opts.invincible;
    // 运行时
    this.buffs = [];
    this._cdMap = {};
    this.dir = opts.dir || 'right';
    this.z = (opts.z != null) ? opts.z : 5;
    this.path = opts.path || null;
    this.speed = (opts.speed != null) ? opts.speed : 200;
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    // 显示开关
    this.showBars = opts.showBars !== false;
    this.showWings = opts.showWings !== false;
    this.hpAbove = !!opts.hpAbove;
    // 骑宠系统：_riding=是否骑乘中；_ridepetId=骑宠模型 id；_rideVisible=骑宠两层是否显示
    //   （进战时临时隐藏：战斗立绘与主城共用同一 Fighter，骑宠层不应出现在战斗站位上）
    //   _rideType=该骑宠的显示类型（ride 乘骑 / stand 站立，见 js/ridepet/ridepet-type.js）：
    //     ride  → 人物播 base+'ride' 乘骑帧 + 武器层隐藏（武器无乘骑动画会穿帮）
    //     stand → 人物播普通 stand/walk（站在骑宠上）+ 武器层保留（用户明确要显示武器）
    this._riding = false;
    this._ridepetId = null;
    this._rideVisible = true;
    this._rideType = 'ride';
    this._rideStandLift = STAND_LIFT_DEFAULT;   // 站立抬升（flash px）：mountRide 时一次性 await 读模型 index.html，热路径只读它
    // 渲染/锚定缓存（每次（重）初始化清零；复用同 charId 实例时由 act 重新填充）
    this.layers = {};
    this._current = null;
    // ★ 13r：视野外动画剔除的同步标记复位为「未知」→ 下一次 _animCull 强制重新施加暂停/恢复
    //   （池复用出的单位可能停在"已暂停"状态，必须无条件重算一次，避免复用后动画冻住）。
    this._animCulled = null;
    this._anchor = null;
    this._anchorScale = null;
    this._anchorMap = null;
    this._standAnchorCache = null;
    this._unionRectCache = null;
    this._bbox = null;
    this._fanvasCanvas = null;
    this._fanvasFrames = null;
    this._fanvasFrameRate = null;
    this._fallback = false;
    this.battleScale = null;
    this._mcHeightPx = null;
    this._shownForCharId = null;
    this._revealTries = 0;
    this._originDX = null;
    this._originDY = null;
    this._modelCxEl = null;
    this._modelHeadY = null;
    this._modelFootY = null;
    // ★ 变异/染色颜色矩阵（20 元 4×5 数组，null=不套滤镜）：日后"变异(换色)系统"对接点。
    //   构造期由 opts.colorMatrix 带入；applyColorMatrix 把滤镜套到 _bodyWrap（覆盖身体+纸娃娃叠加层整体）。
    // cg: variant is a first-class option now - resolve the tunable matrix from
    //   Config.variant here so every char model (battle scene, pet panel, player panel,
    //   showcase, role pool) just passes variant:true. Explicit colorMatrix still wins.
    this.variant = !!(opts.variant || (opts.colorMatrix ? 0 : 0));
    this.colorMatrix = opts.colorMatrix
      || (this.variant ? resolveVariantMatrix(Config.variant) : null);
    this._cmFilterId = null;   // 本实例专属 SVG <filter> id（每实例独立，多怪不同色互不串味）
    // 战斗瞬态标记（复用前必须清零，否则上场战斗遗留的 _down/_awarded 会让 _onEnemyDown/_awardKill 的早返回守卫误判）
    this._down = false;
    this._awarded = false;
    // ★ 最近一次数值飘字的时间戳：AS3 里死亡不是伤害结算那一刻触发的——
    //   飘字动画(BattleInitializer14)的 step 在【500ms 帧】才调 handleResult → 发起 ANIMATE_DEAD。
    //   故阵亡演出须"飘字出现后 500ms"才开始（见 die()）。
    this._lastFloatMs = 0;
    // 阵亡演出代际（作废未走完的 die() 回调）：复用前必须自增，避免旧闪动回调污染本实例
    this._cancelDeathFx();
    this._band = null;
    this._home = null;
    this._monsterId = null;
    this._npcId = null;
    this._ctrl = null;
    this._pendingTurnStartBuffs = null;
    // ★ 解锁位移闸门：进场/复用的单位必须能移动（上一条先 blockMove 掐断旧循环，这条再把新一段放开）
    this.allowMove();
  }

  // ★ 怒气底层 setter（2026-09-15）：任何对 fig.rage 的赋值（普攻回怒 / 暴击 / 反击 / 反噬 / 技能加怒 / 封顶钳制）
  //   都自动按差值飘字，与 HP/MP 受击飘字同源（battle-number.js → battlesp{数字}.png）。
  //   此前只在「凝神聚气」单点手动 ctx.floatNum('sp',...)，普攻/暴击/反击/反噬等加怒路径全部漏掉
  //   → 表现为「怒气变了但没有动画跳出」。现改为属性层统一触发，无需在每个调用点手动加飘字。
  //   触发条件：delta≠0 且当前是战场、本单位是战场参与者、且战斗未结束 → 走 scene._floatNumber(fig,'sp',delta)。
  get rage() { return this._rage || 0; }
  set rage(v) {
    // ★ 宠物/怪物无怒气系统（rageMax<=0）：任何增减（普攻回怒/暴击/反击/技能加怒/凝神聚气/消耗）
    //   一律不生效，_rage 恒为 0 ⇒ 也不会触发飘字。怒气仅人物拥有（F4 裁决）。
    if (this.rageMax <= 0) { this._rage = 0; return; }
    const old = this._rage || 0;
    const nv = (typeof v === 'number' && !isNaN(v)) ? v : old;
    this._rage = nv;
    const delta = nv - old;
    if (!delta) return;
    const sc = (typeof window !== 'undefined') && window.__TS && window.__TS.current;
    if (sc && sc._floatNumber && !sc._ended && !sc._ending &&
        (sc.pFig === this || sc.eFig === this || (sc.enemies && sc.enemies.indexOf(this) >= 0))) {
      sc._floatNumber(this, 'sp', delta);
    }
  }

  // ── 首次构建 DOM（仅新建实例调用一次；池复用经 reinit 重置数据，不重建 DOM）──
  initDisplay() {
    // DOM
    this.el = document.createElement('div');     // 脚底锚点容器（宽高0）
    this.el.className = 'fighter';
    this.el.style.position = 'absolute';
    this.el.style.width = '0'; this.el.style.height = '0';
    this.el.style.zIndex = String(this.z);

    // ★ 视觉整体容器（_bodyWrap）：包裹【身体 canvasWrap + 全部纸娃娃/装备叠加层】。
    //   4 向朝向的合成方向(LB/RT) = 对 _bodyWrap 整体做一次 scaleX(-1)，
    //   使身体与所有叠加层作为【一个整体】镜像（相对位置完全不变，绝不互相错位）。
    //   名字/血条/状态/buff 图标留在 .el 下、wrap 之外 → 不会被镜像成反字。
    // 外层发光容器（_glowWrap）：包裹整个视觉模型（身体 canvasWrap + 全部纸娃娃/装备叠加层），
    // 只给 hover 高亮的 drop-shadow 用。★ 它必须位于【颜色矩阵滤镜之外】（_bodyWrap 是它的子）：
    //   CSS 滤镜由内向外合成 ⇒ 内层(_bodyWrap)先套变异/染色颜色矩阵，外层(_glowWrap)再画金色发光；
    //   发光颜色是 drop-shadow 指定的金色常量，故【不会】被颜色矩阵改色（修 user"发光也跟着变色"）。
    //   名字/血条/状态/buff 仍挂 .el（wrap 之外），不受影响。
    this._glowWrap = document.createElement('div');
    this._glowWrap.className = 'fighter-glow';
    this._glowWrap.style.position = 'absolute';
    this._glowWrap.style.left = '0'; this._glowWrap.style.top = '0';
    this._glowWrap.style.width = '0'; this._glowWrap.style.height = '0';
    this._glowWrap.style.zIndex = '1';
    this.el.appendChild(this._glowWrap);

    this._bodyWrap = document.createElement('div');
    this._bodyWrap.className = 'fighter-body';
    this._bodyWrap.style.position = 'absolute';
    this._bodyWrap.style.left = '0'; this._bodyWrap.style.top = '0';
    this._bodyWrap.style.width = '0'; this._bodyWrap.style.height = '0';
    this._bodyWrap.style.zIndex = '1';
    this._glowWrap.appendChild(this._bodyWrap);

    // 立绘容器：画布由 fanvas 统一原点扩展分支按 rect 尺寸创建（内容偏移 -rect.x*scale）；脚底锚点平移 + 名字/血条相对它定位
    this.canvasWrap = document.createElement('div');
    this.canvasWrap.className = 'fighter-canvas';
    this.canvasWrap.style.zIndex = '1';   // 身体层：纸娃娃层(z>1)叠在其上、名字/血条(z=60)在最上
    this._bodyWrap.appendChild(this.canvasWrap);

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'fighter-name';
    this.nameEl.style.zIndex = '60';   // 名字/血条恒在纸娃娃叠加层之上
    this.nameEl.style.visibility = 'hidden';   // 渲染顺序对齐原版：模型(mc)先入 layer，文字/血条随后显于上层（等画布首帧绘制后再显，避免"先见文字不见模型"）
    this.nameEl.textContent = this.name;
    // 名字/血条挂到 0×0 脚底锚点容器(this.el)，与 .fighter-status 同层；
    // 不随 canvasWrap 的模型锚定 translate 偏移，确保锚定到模型自身脚底中心/头顶（修复嵌套 0×0 导致的错位）
    this.el.appendChild(this.nameEl);

    // 血条：对齐 AS3 Fighter.as initHpbar / updateHpbar
    //   _hpbarSprite(45×9) = 框 battlehpbar.png + 填充 battlehp.png(37×3, 偏移 4,3)
    //   填充宽按 hp/max 由「裁剪容器」裁掉（等价 AS3 的 _hpMask 遮罩），不再用纯色 CSS 条
    this.hpBar = document.createElement('div');
    this.hpBar.className = 'fighter-hpbar';
    this.hpBar.style.zIndex = '60';
    this.hpBar.style.visibility = 'hidden';   // 与 nameEl 一同在模型首帧后再显（对齐原版渲染顺序）
    this.hpBarFrame = document.createElement('img');
    this.hpBarFrame.className = 'fighter-hpbar-frame';
    this.hpBarFrame.src = HPBAR.frame.src;
    this.hpBarFrame.width = HPBAR.frame.w;
    this.hpBarFrame.height = HPBAR.frame.h;
    this.hpBarFrame.draggable = false;
    this.hpBar.appendChild(this.hpBarFrame);
    this.hpFill = document.createElement('div');          // 裁剪容器（充当 AS3 _hpMask）
    this.hpFill.className = 'fighter-hpfill';
    this.hpFillImg = document.createElement('img');
    this.hpFillImg.className = 'fighter-hpfill-img';
    this.hpFillImg.src = HPBAR.fill.src;
    this.hpFillImg.width = HPBAR.fill.w;
    this.hpFillImg.height = HPBAR.fill.h;
    this.hpFillImg.draggable = false;
    this.hpFill.appendChild(this.hpFillImg);
    this.hpBar.appendChild(this.hpFill);
    this.hpBar.style.display = this.showBars ? 'block' : 'none';   // 按 showBars 决定血条是否渲染（名字由 _revealText 控制显隐）
    this.el.appendChild(this.hpBar);

    // 状态动画层：挂在 0×0 脚底锚点(this.el)下，定位到模型头顶上方；
    // 按 buff kind 播放对应 resource/battle/{n} 动画，直接贴着模型、无偏移（column-reverse 让多个状态从头顶向上堆叠）。
    this._statusLayer = document.createElement('div');
    this._statusLayer.className = 'fighter-status';
    this.el.appendChild(this._statusLayer);
    this._layoutStatusLayer();   // 先用兜底坐标定位，模型量到包围盒后 _placeBars 会重定位

    // Buff/Debuff 图标条（横排 5 个/行、15px 图标；满 5 后 wrap-reverse 向上堆叠，避免压到血条；
    // 每个图标显示 buff 色块+名首+剩余回合；addBuff/tickBuffs/removeBuffKind 时刷新）
    this._buffBar = document.createElement('div');
    this._buffBar.className = 'fighter-buffs';
    this._buffBar.style.display = 'none';
    this.el.appendChild(this._buffBar);

    // 对齐原点标记（受 Fighter._originOn 控制，默认不显示：设置面板「模型锚点」或 URL ?origin=1 开启）：画在脚底锚点 .el(0,0)，
    // 即模型脚底被 pin 的位置。用于核对"名字/血条是否对准模型"——原点应落在模型脚底中心。
    this.originEl = document.createElement('div');
    this.originEl.className = 'fighter-origin';
    const _od = document.createElement('div'); _od.className = 'fighter-origin-dot';
    this.originEl.appendChild(_od);
    this.originEl.style.display = (Fighter._originOn !== false) ? 'block' : 'none';
    this.el.appendChild(this.originEl);
    (Fighter._instances = Fighter._instances || new Set()).add(this);   // 实例登记表（仅首建时登记；reinit 不重复）

    this.updateBar();   // DOM 已建好，同步初始血条
    // 纸娃娃：穿戴了装备则按 modelId 生成叠加层（DOM 已就绪，this.el/this.layers 已建）
    if (this.equip && Object.keys(this.equip).length) this.refreshPaperDoll();
    // 变异/染色：_bodyWrap 已建好 → 套颜色矩阵滤镜（首建实例在此生效）
    this._applyColorMatrix();
  }

  // ── 池复用入口：重置数据并同步随数据变化的展示部分（不重建 DOM）──
  // 由 role-pool.js 的 acquire 在拿到空闲实例后调用；调用方随后 appendChild(el) + stand() 即可。
  reinit(opts) {
    this.initState(opts);
    // 复用 DOM：补上 initDisplay 首建时才跑、但依赖数据变化的展示同步
    if (this.nameEl) this.nameEl.textContent = this.name;
    if (this.hpBar) this.hpBar.style.display = this.showBars ? 'block' : 'none';
    if (this.originEl) this.originEl.style.display = (Fighter._originOn !== false) ? 'block' : 'none';
    if (this._buffBar) { this._buffBar.innerHTML = ''; this._buffBar.style.display = 'none'; }
    this.updateBar();
    if (this.equip && Object.keys(this.equip).length) this.refreshPaperDoll();
    // 变异/染色：池复用实例 _bodyWrap 已存在 → 重新套颜色矩阵（initState 已刷新 this.colorMatrix）
    this._applyColorMatrix();
  }

  // ── 池回收：暂停动画 + 摘离舞台，保留 DOM 供下次复用（与 destroy 区别：不销毁、不入 _instances 移除）──
  release() {
    // 暂停当前立绘动画（idle 期间不空转 RAF，省 CPU；下次 act 由 mount 重建画布并播放）
    if (this._fanvasCanvas && this._fanvasCanvas.isConnected) {
      try { window.fanvas && window.fanvas.pause(this._fanvasCanvas); } catch (e) {}
    }
    // 停掉仍播放的状态动画（防 Timer 泄漏）
    if (this.buffs) this.buffs.forEach(b => this._stopStatusAnim(b));
    // ★ 清除"受击半透明"残留（_underfire 设的 el.style.opacity='0.5'）。
    //   若角色在受击 500ms 内阵亡/战斗结束/逃跑，_underfire 的恢复回调 (_knock setTimeout) 会被吞掉，
    //   opacity 卡在 0.5 并随实例入池；下次复用同一 charId 的怪物就"一进场就半透明"。
    //   在此池回收边界统一复位，保证复用的实例永远是干净的。
    this.el.style.opacity = '';
    // ★ 复位"死亡闪动"残留的可见性：die() 在 500~850ms 会把【本体】设为 hidden，
    //   若此刻被中断（战斗提前结束 / 回城），hidden 会随实例入池 → 下次同模型怪物"隐身出场"。
    //   与上面的 opacity 残留同类，必须在池回收边界统一复位。
    this._setBodyVisible(true);
    this._lastFloatMs = 0;
    // 复位受击/闪避的位移 Home 缓存（_knock 若被中断会残留，导致下次归位坐标错乱）
    this._ufHome = null; this._dgHome = null;
    // 清掉未兑现的受击/闪避归位定时器，避免跨战斗触发陈旧回调
    clearTimeout(this._ufT); clearTimeout(this._dgT);
    this._cancelReveal();   // ★ 取消尚未触发的名字/血条显隐定时器（防切图风暴下孤儿 rAF 累积回读）
    // 作废仍在飞的位移循环（release 后再复用/回城，旧 moveTo 不得继续回写坐标）
    this.blockMove();
    // 清掉变异/染色滤镜：池复用实例必须是干净的，否则下一只怪会串上上只的颜色
    this._destroyColorMatrixFilter();
    // ★ 清骑宠状态：骑乘中的角色若被池回收（如进战），下个复用此实例的单位不得残留骑宠层/ride 动作
    this._riding = false;
    this._ridepetId = null;
    // 从舞台摘离（保留 DOM 树，等下次 acquire 重新 appendChild）
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // ── 变异/染色颜色矩阵 ──
  // 把 20 元 4×5 颜色矩阵经 SVG feColorMatrix 套到 _bodyWrap（覆盖【身体 canvas + 全部纸娃娃/装备叠加层】整体，
  // 与 demo 的 canvasWrap 单身体不同：用户要求"套在纸娃娃叠加层之上"=整套模型一起变色）。
  // filter 与 transform 是独立 CSS 属性，互不冲突（_bodyWrap 的 scaleX(-1) 翻转照常生效）。
  _applyColorMatrix() {
    if (!this._bodyWrap) return;                 // 首建实例在 initDisplay 建好 _bodyWrap 后才调；reinit 复用实例 _bodyWrap 已存在
    if (!this.colorMatrix) { this._destroyColorMatrixFilter(); return; }
    if (!this._cmFilterId) this._cmFilterId = 'cmf-' + ((Fighter._cmSeq = (Fighter._cmSeq || 0) + 1));
    const { fe } = ensureColorMatrixFilter(this._cmFilterId);
    fe.setAttribute('values', toSVGValues(this.colorMatrix));
    this._bodyWrap.style.filter = `url(#${this._cmFilterId})`;
  }

  // 移除本实例的滤镜（清 filter 样式 + 删 SVG <filter> 元素，防 document.body 泄漏）
  _destroyColorMatrixFilter() {
    if (this._bodyWrap) this._bodyWrap.style.filter = '';
    if (this._cmFilterId) { removeColorMatrixFilter(this._cmFilterId); this._cmFilterId = null; }
  }

  // 公开 API（供日后"变异(换色)系统"调用）：设置/清除颜色矩阵并即时生效
  setColorMatrix(m) { this.colorMatrix = m || null; this._applyColorMatrix(); }
  clearColorMatrix() { this.colorMatrix = null; this._destroyColorMatrixFilter(); }

  // 放到世界坐标 (x,y)（脚底锚点）；每次落位都重算深度，使移动/换位时层级即时变化（地图与战斗通用）
  setPos(x, y) { this.x = x; this.y = y; this.el.style.left = x + 'px'; this.el.style.top = y + 'px'; this.setDepth(y); }

  // 深度排序（对齐 2D 俯视：脚底 y 越大=越靠下=越靠近镜头=应越靠前显示 → z-index 越大）
  // 旧公式 10000-groundY 方向相反（靠下反而被压到后面），导致重叠时层级错乱；改为 10000+groundY。
  setDepth(groundY) {
    if (this._fixedDepth) return;   // F9：地面贴附特效固定置底，不参与深度排序
    this.el.style.zIndex = String(10000 + Math.round(groundY));
  }

  // 直线移动到目标坐标（rAF 驱动，战斗内"走向目标→攻击→归位"使用）。
  // 不改动朝向（朝向由调用方在移动前后用 act(dir) 设定），仅按速度插值 setPos。
  //
  // ⚠ 位移代际（_moveGen）：本循环唯一的自然退出条件是「到达目标」或「el 摘离 DOM」。
  //   但战斗结束 _end() 会先把 el **重新挂回主城 actor 层**（isConnected 又变 true）、
  //   再 setPos 复位到进战前坐标；此时若仍有未收敛的 moveTo（攻击位移/受击 _knock 等）
  //   在飞，它会继续每帧把已复位的坐标拽向**战斗站位** → 回城后角色被拖走/持续漂移，
  //   且因为走的是裸 setPos（不经 MainScene._update 的 p.walk()）表现为【无行走动画】。
  //   故用代际标记让旧循环自检退出：invalidateMove() 递增代际，旧 step 下一帧即 resolve。
  invalidateMove() { this._moveGen = (this._moveGen || 0) + 1; }

  // ★ 位移闸门（比"代际"更强的一道）：
  //   代际只能让【已经在飞】的 moveTo 退出，却拦不住"被打断的异步链继续往下跑、再发起一个新 moveTo"——
  //   典型场景：战斗收尾 _end() 调 invalidateMove() → 在飞的 _approach.moveTo 立即 resolve →
  //   但 _approach 之后会继续 await 到 _retreat()，而 _retreat 里又是一个【全新】的 moveTo
  //   （它捕获的是递增后的新代际，gen === _moveGen 恒成立，代际守卫对它形同虚设）→
  //   于是回城后这个新循环把玩家从战斗站位一路拉回战斗爆发点（无行走动画的裸 setPos 漂移）。
  //   故在 _end() 掐代际的同一时刻置 _moveBlocked，moveTo 入口直接否决，任何"后来者"都动不了。
  blockMove() { this._moveBlocked = true; this.invalidateMove(); }
  allowMove() { this._moveBlocked = false; }

  moveTo(tx, ty) {
    return new Promise((resolve) => {
      // 闸门：战斗已收尾（_end 已置位）后发起的任何位移一律否决，绝不回写坐标
      if (this._moveBlocked) { resolve(); return; }
      const raf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      const gen = (this._moveGen = this._moveGen || 0);   // 捕获本次位移代际
      const step = () => {
        if (this._moveBlocked) { resolve(); return; }      // 闸门：收尾后被置位 → 退出
        if (gen !== this._moveGen) { resolve(); return; }  // 代际已失效（战斗结束/被新位移接管）：退出，不再回写坐标
        if (!this.el.isConnected) { resolve(); return; }   // 战斗已退出/角色已移除：停止移动，避免回写已脱离 DOM 的角色
        const dx = tx - this.x, dy = ty - this.y;
        const dist = Math.hypot(dx, dy);
        const move = (this.speed || 200) * (this.battleScale != null ? 4 : 1) * 16 / 1000;  // 战斗内移动提速 3 倍（battleScale 进场置、退场清）
        if (dist <= move || dist < 0.5) { this.setPos(tx, ty); resolve(); return; }
        this.setPos(this.x + dx / dist * move, this.y + dy / dist * move);
        raf(step);
      };
      raf(step);
    });
  }

  // 播放动作（异步，首次会下载 swfData）
  // opts.loop：false 时停在最后一帧（如死亡倒地），其余循环播放
  async act(base, dir, opts = {}) {
    this.dir = dir || this.dir;
    // 4 向等距朝向（RB/LB/RT/LT）：真实素材只有 RB/LT 两个对角方向，LB/RT 是 empty（globals.js 注释明确
    // "LB/RT 由水平翻转生成"）——原实现"直接取 LT/RB 两个、不再做镜像"，故转向动画只剩两向。
    // 此处把逻辑朝向合成成"基准素材方向 + 水平翻转"：LB→RB+flip、RT→LT+flip，从而真实渲染出四个朝向。
    // ★ 翻转的视觉效果只作用在 _bodyWrap（见 _applyFlip）。命中判定【不需要】共用翻转轴：
    //   scene._hitTestFighters 用 canvas 自己的 getBoundingClientRect() 取样，而翻转元素的左右边
    //   在屏幕上本就互换 ⇒ `px = cv.width - px - 1` 与翻转轴无关地恒正确（详细论证见 scene.js 顶部该处注释）。
    const FLIP_DIR = { LB: 'RB', RT: 'LT' };
    const renderDir = FLIP_DIR[this.dir] || this.dir;
    this._renderDir = renderDir;
    this.flipX = (this.dir === 'LB' || this.dir === 'RT') ? -1 : 1;
    // 调用方显式给 scale 优先；否则回退 battleScale（战斗内统一 SCALE），保证同一角色所有动作缩放一致 → 锚点稳定不跳变
    const scale = (opts.scale != null) ? opts.scale : (this.battleScale != null ? this.battleScale : 1);
    // 早期返回：仅当「动作+朝向+缩放」都未变且为循环播放时跳过（避免重启已播放的循环动画/重锚）。
    // ⚠ 必须校验缩放(this._anchorScale === scale)：battleScale 在 主城(1)↔战斗(0.72) 间切换，
    //   若仅按 base+dir+loop 跳过，回城时主角(主城与战斗共享同一 Fighter 对象)会沿用战斗缩放的锚点 →
    //   名字/血条停留在缩放 0.72 的位置（"地图里不正常 / 主角效果有点不一样" 的根因）。
    // ⚠ opts.force：上骑/下骑时 base/dir/scale 全未变，但人物的动画池变了（stand→standRBride），
    //   必须强制重播，否则要等下次走路才切换。
    const loopNow = opts.loop !== false;
    // 身体为特效（传送法阵 transport 等）：直接渲染特效、不加载 char 模型。
    // 该分支有独立 early-return 守卫，避免与常规 char 动画的 _current/_anchorScale 串味。
    if (this._bodyEffectId) {
      if (!opts.force && this._current && this._current.base === base && this._current.dir === this.dir && this._anchorScale === scale && loopNow) return;
      this._current = { base, dir: this.dir, loop: loopNow };
      return await this._renderBodyEffect(base, this.dir, scale, opts);
    }
    if (!opts.force && this._current && this._current.base === base && this._current.dir === this.dir && this._anchorScale === scale && loopNow) return;
    this._current = { base, dir: this.dir, loop: loopNow };
    // ★ 骑乘状态：playChar 的 opts.ride 令人物优先播 base+dir+'ride'（如 standRBride）；
    //   模型无 ride 标签时 playChar 内部回退到普通动作（用户 2026-10-04 指定的第②种表现：
    //   人物播 stand/walk，整个 body 包在骑宠前后景之间）。
    //   _rideVisible=false（如进战）时也不播 ride 动作，保持普通战斗立绘。
    //   ★ 站立型骑宠（_rideType==='stand'）人物始终播普通 stand/walk（站在骑宠上，AS3
    //     CHARSTATE_STAND_RIDE 的 setStandRideFrame 即用普通 standXX 帧），不进入 ride 分支。
    //   ★ 站立型骑乘时人物【恒定播 stand】——移动的是骑宠，人物走起来会变成"骑宠上跑"的
    //     穿帮（用户明确指出）。AS3 setStandRideFrame 里无论 curAction 是 stand/walk，人物都
    //     gotoAndStop("stand"+方向)，只有骑宠播 walk。此处把人物与纸娃娃层统一改用 charBase，
    //     骑宠层（_playRideLayers）仍用真实 base。
    const ride = !!(this._riding && this._rideVisible) && this._rideType !== 'stand';
    const standRiding = !!(this._riding && this._rideVisible && this._rideType === 'stand');
    const charBase = standRiding ? 'stand' : base;
    let r = await playChar(this.canvasWrap, this.charId, charBase, renderDir, { loop: opts.loop, scale, freezeLast: opts.freezeLast, ride });
    // 真实角色模型未载入/加载失败 → 回退兜底模型 301000
    if (!r) {
      this._fallback = true;
      r = await playChar(this.canvasWrap, FALLBACK_CHAR_ID, charBase, renderDir, { loop: opts.loop, scale, freezeLast: opts.freezeLast, ride });
      if (!r) return;
      this._anchor = null; this._anchorScale = null;   // 兜底模型需重新锚定（不复用真实模型的缓存映射）
    }
    const cv = r.canvas;
    // mount 已清空旧 canvas 并暂停，此处仅更新引用（不裁切，画布始终完整渲染）
    this._fanvasCanvas = cv;
    this._fanvasFrames = r.frames;
    this._fanvasFrameRate = r.rec && r.rec.swfData && r.rec.swfData.frameRate;
    // 原点锚定：Flash 原点(0,0) 直接落在 .el 脚底锚点（用户指定），用 definitionPool[pool] 的 rect 底边中心(逐方向脚点)，
    // 不再扫描像素；按(方向 pool, 缩放)缓存，切换动作不重算、不漂移。模型上方的血条/状态坐标由 rect 推出。
    const _akey = r.pool + '@' + scale;
    if (this._anchorMap && this._anchorMap[_akey]) {
      this._anchor = this._anchorMap[_akey];
      this._anchorPool = r.pool; this._anchorScale = scale;
      this._applyAnchor(cv, scale);
    } else {
      this._anchorByFoot(r, scale);
    }
    // 4 向镜像（★ user 2026-09-10 明确方案）：合成方向(LB/RT) 由 RB/LT「把身体与所有叠加层
    //   当作一个整体」做一次水平镜像得到 —— 即对 _bodyWrap 施加 scaleX(-1)（不是每层各自翻转）。
    //   整体镜像 ⇒ 身体与武器的【相对位置恒不变】，绝无错位（这是"按一个整体计算"的字面实现）。
    //   镜像轴 = 角色原点（红十字）在 .el 的 x = 0，与 scene._hitTestFighters 的命中镜像严格同轴（见 _applyFlip）。
    //   名字/血条/状态/buff 图标在 _bodyWrap 之外、仍挂 .el → 不会被镜像成反字。
    //   无论上面走缓存(_applyAnchor)还是重算(_anchorByFoot)，都在此统一覆盖，保证翻面不残留。
    this._applyFlip();
    // 渲染顺序对齐原版 Fighter.as：模型(mc)先入 layer，文字/血条随后置于上层。
    // 仅当「角色换人(新 charId)」时先把名字/血条隐藏，等画布首帧绘制完成后再显 —— 避免"先见文字不见模型"；
    // 同一角色切动作/场景复用同一 Fighter 时不重隐藏，避免战斗中动作切换文字闪一下。
    if (this.charId !== this._shownForCharId) {
      this._shownForCharId = this.charId;
      this.nameEl.style.visibility = 'hidden';
      this.hpBar.style.visibility = 'hidden';
      this._revealTries = 0;
      this._revealText();
    }
    // 纸娃娃：身体锚定完成后，把每个叠加层同步到相同 base/dir/scale（同一 Role 原点 → 自然重合于脚底）
    //   ★ 用 charBase：站立型骑乘时人物恒 stand，武器/法宝等纸娃娃层也要跟着 stand，否则武器还在走
    if (this.layers) {
      for (const key of Object.keys(this.layers)) {
        if (key.indexOf('ridepet:') === 0) continue;   // 骑宠层走 _playRideLayers（动作名无 ride 后缀，见下）
        this._playLayer(key, charBase, this._renderDir, scale, { loop: loopNow, freezeLast: opts.freezeLast });
      }
    }
    // 骑宠层：与身体同动作但用【无 ride 后缀】的动作名（骑宠帧名不带 ride，AS3 取证）
    //   隐藏期间（进战）不重播，避免无意义的 fanvas Timer；回城后 setRideVisible(true) + stand() 会重建
    if (this._riding && this._rideVisible) this._playRideLayers(base);
    // 名字/血条元素已在构造期挂载到 this.el（位于 canvasWrap 之上，zIndex 60），此处仅做落位；显隐由 _revealText 控制
    return r;
  }

  // 身体为特效（传送法阵 transport 等）：把 resource/effect/<id>/ 特效直接渲染进 canvasWrap，
  // 用 anchorOrigin 把特效 flash 原点(地面/环心) 落到 .el(0,0)（= fig.x,fig.y 地面格），呈"地面旋转光圈"贴花。
  // 与常规 char 动画的区别：①不加载 char 模型；②不做 4 向镜像/纸娃娃叠加；③canvasWrap 复位到 .el 原点、不按"站立脚"pin。
  // Fighter 仍在 this.actors/this.npcs，故像素命中(_hitTestFighters 取 canvasWrap 内 canvas)、最近提示、点击对话全链路原样生效。
  async _renderBodyEffect(base, dir, scale, opts = {}) {
    let rec;
    try { rec = await loadEffect(this._bodyEffectId); }
    catch (e) { console.warn('身体特效加载失败', this._bodyEffectId, e); return null; }
    if (!rec) return null;
    const cv = mount(this.canvasWrap, rec.swfData, rec.main, rec.imagePath, { loop: opts.loop !== false, scale });
    // canvasWrap 复位到 .el 原点（脚底锚点），特效 flash 原点落到 (0,0) ⇒ 环居中在 NPC 地面格
    if (this.canvasWrap) this.canvasWrap.style.transform = 'translate(0px, 0px)';
    anchorOrigin(cv, rec.swfData, rec.main, { x: 0, y: 0, scale });
    this._fanvasCanvas = cv;
    this._fanvasFrames = rec.frames;
    this._fanvasFrameRate = rec.swfData && rec.swfData.frameRate;
    this._anchorScale = scale;
    // 名字/血条显隐（与常规 act 同款逻辑：新 charId 先隐藏文字、首帧后显）
    if (this.charId !== this._shownForCharId) {
      this._shownForCharId = this.charId;
      this.nameEl.style.visibility = 'hidden';
      this.hpBar.style.visibility = 'hidden';
      this._revealTries = 0;
      this._revealText();
    }
    return { canvas: cv, frames: rec.frames, rec, pool: rec.main };
  }

  // ── 角色锚定：以"模型内容包围盒(并集 rect)的脚底(底边中心)"为锚点，对齐到 .el 原点(fig.x,fig.y) ──
  // 关键事实（实测 100000/340020/116401 等转换模型）：definitionPool[pool].rect 的原点(0,0) 位于【模型内容左上外侧】，
  // 内容整体落在正 flash 坐标(x>0,y>0)。若按"Flash 原点"锚定(旧实现)会把模型整体推到脚点右下 → 出屏/偏移
  // （即用户所见：展示页原点落在画面左上角、非站立动作整体跑到右下角）。
  // 【一劳永逸锚点】脚与身体中心只由「站立姿势」算一次，是模型级常量；与当前动作、与新增技能/特效完全脱钩。
  // 旧实现：脚取 artOrigin[r.pool](当前动作脚) + 身体中心取全动作并集 rect → 切动作脚变 / 新特效撑偏并集 → 红叉·血条大幅跳、且加特效要重调偏移。
  // 现实现：脚取「同朝向 stand 脚」、身体中心取「同朝向 stand 池 rect 中心」(均为模型级恒定，只随朝向变、不随动作变)；
  // canvasWrap 也 pin 这个恒定 stand 脚(而非当前动作脚) ⇒ 切动作时模型本体水平/垂直都不漂移；红叉·血条·技能共用同一 modelCxEl ⇒ 三者落点一致且恒定。
  // 纯数据/纯结构、不扫描像素；按 (pool,scale) 缓存复用，切动作不重算不漂移。与 effect/skill/status 同源(脚底原点叠加)。
  _anchorByFoot(r, scale) {
    this._anchorScale = scale;
    this._anchorPool = r.pool;
    const sd = r.rec && r.rec.swfData;
    const dp = sd && sd.definitionPool;
    const def = dp && r.pool != null ? dp[r.pool] : null;
    const rect = (def && def.rect && (def.rect.width > 0 || def.rect.height > 0))
      ? { x: def.rect.x, y: def.rect.y, width: def.rect.width, height: def.rect.height }
      : { x: 0, y: 0, width: 512, height: 512 };
    // 内容底边中心(flash 坐标) = (rect.x+rect.width/2, rect.y+rect.height) → pin 到 .el(0,0)
    // 推导：内容 flash(px,py) → .el((px-rect.x)*scale + tx, (py-rect.y)*scale + ty)；令脚底 → 0 得 tx/ty。
    // ── 一劳永逸：脚与身体中心只取「同朝向 stand 姿势」，模型级常量，与当前动作/新增特效脱钩 ──
    // canvasWrap 也 pin 这个恒定 stand 脚(而非当前动作脚) ⇒ 切动作时模型本体不漂移；红叉/血条/技能共用同一 modelCxEl ⇒ 落点一致恒定。
    // 朝向 → 站立脚锚点：left 系(LT/LB)用左脚、right 系(RB/RT)用右脚；
    // 4 向等距朝向(RB/LB/RT/LT)下也能正确取脚，避免上下走时模型水平漂移。
    // 注意：必须用"渲染方向" _renderDir（LB→RB / RT→LT），使脚锚取自实际被绘制的 RB/LT 池，
    // 而非逻辑方向的空池(LB/RT 为 empty)，否则合成方向的脚位会取到错误的素材。
    const facing = (this._renderDir === 'left' || (this._renderDir && this._renderDir[0] === 'L')) ? 'LT' : 'RB';
    const canon = this._standAnchor(sd, r.rec && r.rec.actions, r.pool)[facing];
    const footX = canon.footX, footY = canon.footY, footTop = canon.top;
    // 固定血条高度：对齐原版 mcHeight = min(模型包围盒高, 120)；用「站立池包围盒高」(模型级常量)，
    // 与当前动作/缩放/新增特效脱钩 ⇒ 血条高度恒定、不浮空偏高、加新特效永不需重调。
    this._mcHeightPx = Math.min(canon.rectH, 120) * scale;
    // ★ 未封顶的原版 mcHeight（= AS3 CurrentPanelNpc.as:556 `mcHeight = mc.height`，站立帧包围盒高）。
    //   血条封顶 120 是 Fighter.as:317 的战斗特例；NPC 头顶状态图标的 AS3 口径不封顶
    //   （CurrentPanelNpc.as:2077 只有 `mcHeight>450 ? -90 : -mcHeight+20`），
    //   故任务标记（yem/yqm/gqm）必须取本字段，而不是 _modelHeadY——
    //   二者相差「rect 底边到 AS3 原点」一段（脚锚 rootAnchor(256,256) 通常在 rect 底边上方），
    //   用错会让标记整体偏低（如 202036 差 11px）。
    this._mcHeightRaw = canon.rectH * scale;
    const tx = -(footX - rect.x) * scale;
    const ty = -(footY - rect.y) * scale;
    // ★ 站立型骑乘：人物整体上移 standToY=-30（AS3 CurrentPanelNpc.as::checkStandRideY：
    //   characterSprite.y = -30; suitLayer.y = -30; positionCorrection(-30 + rider.y)）。
    //   人物站在骑宠上、骑宠模型有离地高度，不移人物会陷进骑宠里（用户报"位置偏下"）。
    //   y 负 = 向上。⚠ 只移人物部件（身体 + 非骑宠纸娃娃层），骑宠层与名字/血条/红十字不动。
    this.canvasWrap.style.transform = `translate(${tx}px, ${ty + this._standLiftPx()}px)`;
    this._modelFootY = 0;
    this._modelHeadY = (footTop - footY) * scale;   // 头顶在脚底上方(stand top - stand foot)，模型级恒定
    // 身体中心水平偏移：同朝向 stand 池「rect 中心」相对「stand 脚」的差（角色级恒定，不随动作/特效变）
    const bodyCx = canon.bodyCx;
    this._modelCxEl = (bodyCx - footX) * scale;
    // ★ 身体 flash 原点(0,0) 在 .el 的像素位置（纸娃娃/装备层的对齐基准）：
    //   flash 点 (fx,fy) 落在 .el 的 (tx + (fx-rect.x)*scale, ty + (fy-rect.y)*scale)；令 fx=fy=0
    //   ⇒ (tx - rect.x*scale, ty - rect.y*scale) ≡ (-footX*scale, -footY*scale)（因 tx = -(footX-rect.x)*scale，两式恒等）。
    // ★ 必须是「flash 原点」，不是 canvasWrap 的平移量 tx —— 二者相差 rect.x*scale。
    //   曾误写成 tx，导致装备层整体偏移 rect.x*scale（"武器与人物错位"的直接根因）。
    // ★★ 2026-09-12 根因修复：旧版此处用「512 画布中心(256,256) − 脚点」当基准（所谓的"像素方案"），
    //   对常规角色（脚点=(256,256)）恰好等于 flash 原点 → 看不出问题；但单个 Role 精灵的脚点 = 符号原点(0,0)，
    //   于是基准被推到 .el(256,256) —— 红叉（以及所有以它为基准的派生量）整体错到模型右下角 256px。
    //   现直接取「flash 原点(0,0)」= (-footX*scale, -footY*scale)，不再有 256 这个魔法常数：
    //     · 常规角色：footX=256 ⇒ -256*scale（与旧式 baseX 展开后完全等价，层位置不变，已验证）；
    //     · 单 Role  ：footX=0   ⇒ 0（红叉落回 .el(0,0) = 模型锚点/脚点）。
    this._originDX = -footX * scale;
    this._originDY = -footY * scale;
    // ★ 红叉 = 模型「锚点(原点=脚点)」= 模型被 pin 到地图格的那一点（= canvasWrap 平移后脚点所在处 = .el(0,0)）。
    //   与画廊页标记口径一致：常规角色 (256,256) 与单 Role 精灵 (0,0) 的红叉都落在「脚点」上，不再有 modelId 特例。
    if (this.originEl) {
      this.originEl.style.left = '0px';
      this.originEl.style.top  = '0px';
    }
    // 供排查用的自证数据：bodyFlashOriginFromRect = tx - rect.x*scale = -footX*scale（=画布左上原点）；
    //   _originDX 现=画布中心(256-footX)*scale，二者差 256*scale（即本次修正引入的偏移）。
    this._bodyAnchorDbg = {
      footX, footY, rx: rect.x, ry: rect.y, rw: rect.width, rh: rect.height, scale,
      tx, ty,
      fromFoot: { x: -footX * scale, y: -footY * scale },
      fromRect: { x: tx - rect.x * scale, y: ty - rect.y * scale }
    };
    const anchor = {
      dx: tx, dy: ty,
      bbox: { minX: 0, minY: 0, maxX: rect.width * scale, maxY: rect.height * scale },
      modelHeadY: this._modelHeadY, modelFootY: 0, modelCxEl: this._modelCxEl,
      modelMcHeight: this._mcHeightPx,
      modelMcHeightRaw: this._mcHeightRaw,
      originDX: this._originDX, originDY: this._originDY   // ★ 与上面同源：身体 flash 原点在 .el 的位置
    };
    this._anchorMap = this._anchorMap || {};
    this._anchorMap[r.pool + '@' + scale] = anchor;
    this._anchor = anchor;
    this._bbox = anchor.bbox;
    this._placeBars(0, 0, this._modelHeadY);
    // ★ cx 恒传 0（= 锚点/红十字在 .el 的 x）：名字/血条/状态面板必须【居中在角色坐标点】上，
    //   原版权威依据 deobfuscated/characters/Fighter.as:516~523（setXY）：
    //     nameSprite.x = x - nameField.width/2;  _hpbarSprite.x = x - _hpbarBitmap.width/2;
    //     _battleStatePanel.x = x - width/2;                （x = 角色坐标 = 本实现的 .el(0,0)）
    //   旧版传 _modelCxEl（身体画布中心）⇒ 对"内容没居中于原点"的模型（单 Role 210071 偏 38px、
    //   常规角色偏 13~35px）名字就跑到红十字的右侧（user 报"名字不在十字光标正下方"）。
    //   _modelCxEl 仍保留：伤害飘字等"头顶 UI"按需取身体中心（见 scene.js）。
    // ★ 身体原点刚落地 ⇒ 立即用它重算所有叠加层位置（见 _reanchorLayers 说明）。
    //   修"层先于身体锚定 ⇒ 位置错、跑到边边角角，切一次动画才对"的竞态。
    this._reanchorLayers();
  }

  // 取本模型任一已烘焙 artOrigin（角色脚位在 flash 坐标近似恒定，不同朝向/动作仅 ±几 px），
  // 供缺失 artOrigin 的 pool 回退，避免使用被 playChar 覆盖成"并集 rect"的当前 pool rect 中心/底边。
  firstArtOrigin(sd) {
    if (sd && sd.artOrigin) { for (const k in sd.artOrigin) return sd.artOrigin[k]; }
    return null;
  }

  // 模型级「站立锚点」（一劳永逸）：只由站立姿势算一次并缓存，与当前动作/新增技能特效完全无关。
  // 返回 { RB:{footX,footY,top,bodyCx}, LT:{...} }，每个朝向取「同朝向 stand 池」的脚(artOrigin)与该池 rect 中心(身体中心)。
  // 用途：_anchorByFoot 用它(而非当前动作 pool)算 modelCxEl 并 pin canvasWrap ⇒ 切动作只在同朝向内、偏移恒定不跳；
  //       新增技能/特效只往"非 stand 池"加帧，站立 rect 不变 ⇒ 身体中心不变 ⇒ 永不需为新特效改偏移。
  // 缺失 stand 标签时回退：任意 stand 标签 → 当前 pool rect 中心。
  _standAnchor(sd, actions, rolePool) {
    if (this._standAnchorCache && this._standAnchorCache.sd === sd && this._standAnchorCache.rolePool === rolePool) return this._standAnchorCache.val;
    const dp = (sd && sd.definitionPool) || [];
    const ao = (sd && sd.artOrigin) || {};
    // ★ 单 Role（无命名动作）盲推 (0,0)（user 2026-09-12：「role 盲推 0,0」）：覆盖 rootAnchor 规则① rootPlace。
    //   actions 由 index.html 的 const labels 解析而来；空/全空 ⇒ 单 Role ⇒ hasNamed=false。
    const hasNamed = !!(actions && Object.keys(actions).some(k => actions[k] && !actions[k].empty));
      // ★ 2026-09-17：动作池集合（loader.actionPoolSet），供 resolveFoot→rootAnchor→topLevelPlace 定位真根时间轴
      //   救回 dp[0] 是空壳的 73 个模型（否则规则① 失灵、脚点退回 (0,0)）
      const poolSet = actionPoolSet(actions);
    const make = (dir) => {
      let pool = null;
      if (actions) {
        const left = (dir === 'left' || (dir && dir[0] === 'L'));
        const order = left ? ['LT', 'LB', 'RT', 'RB'] : ['RB', 'RT', 'LB', 'LT'];
        for (const s of order) { const a = actions['stand' + s]; if (a && !a.empty) { pool = a.pool; break; } }
      }
      if (pool == null && actions) {
        for (const k in actions) { if (/stand/i.test(k) && !actions[k].empty) { pool = actions[k].pool; break; } }
      }
      // 单帧 Role 模型(蟠龙图腾/若干装饰物)无 const labels ⇒ actions 为空、无 stand 池；
      // 回退到实际渲染的 Role 池(playChar 的 r.pool，其 rect 已被 unionRectFor 覆盖为真实并集)算脚底原点，
      // 否则落到默认 (256,256) 导致地图里脚点偏到包围盒外、模型错位。
      if (pool == null && rolePool != null && dp[rolePool] && dp[rolePool].rect && dp[rolePool].rect.width > 0) {
        pool = rolePool;
      }
      const def = pool != null ? dp[pool] : null;
      const rct = (def && def.rect && def.rect.width > 0) ? def.rect : null;
      const a = pool != null ? ao[pool] : null;
      // ★ artOrigin 若烘焙自「位图矩形(含四周透明留白)」，其 y 会比真实内容底边低 ⇒ 模型浮空。
      //   判据：a.y 比【当前 rect 底边】还低 2px 以上。
      //   · 多帧动画：rect 已被 unionRectFor 撑成整段并集 ⇒ 底边 ≥ 各帧底边 ⇒ 不会命中，行为不变。
      //   · 单姿势：rect 保留磁盘真实内容（playChar 已不覆盖）⇒ 位图底边会明显更低 ⇒ 命中并纠正。
      //   实测命中 22 个模型（210133/134 浮 96px、210071 浮 47px、500020 浮 31px），其余零影响。
      const diskBottom = rct ? rct.y + rct.height : null;
      const aoBloated = !!(a && diskBottom != null && (a.y - diskBottom) > 2);
      // ★ 脚点/锚点单一真源（loader.resolveFoot → rootAnchor）：
      //   ① dp[0] 顶层 place==(-256,-256) ⇒ (256,256)（常规角色）
      //   ② 无顶层 place 且内容居中于原点 ⇒ (0,0)（单个 Role 精灵，与技能/特效 anchorOrigin 同源）
      //   ③ 其余 ⇒ (256,256)
      //   必须传 sd：判定依赖模型的 dp[0]（原始根时间轴）。
      const f = resolveFoot(this.charId, a, rct, aoBloated, sd, hasNamed, poolSet);
      const footX = f.x, footY = f.y, top = f.top;
      const bodyCx = rct ? (rct.x + rct.width / 2) : 256;
      const rectY = rct ? rct.y : 0;   // 站立池 rect.y
      const rectH = rct ? rct.height : 512;   // 站立池包围盒高（原版 mc.height 等价：角色 MovieClip 包围盒高）
      return { footX, footY, top, bodyCx, rectY, rectH, pool, src: f.src };
    };
    const val = { RB: make('right'), LT: make('left') };
    this._standAnchorCache = { sd, rolePool, val };
    return val;
  }

  // 模型级并集包围盒：definitionPool 中所有【非退化】 rect(w>0 且 h>0) 的 union。
  // 这是模型级常量(与当前动作无关)，供名字/血条/头顶落位使用，确保切换动作时 ID/血条不跳动。
  // 按 swfData 引用缓存：同一模型只算一次；换模型(sd 变化)自动重算。
  _getUnionRect(sd, dp) {
    if (this._unionRectCache && this._unionRectCache.sd === sd) return this._unionRectCache.rect;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cnt = 0;
    if (dp) {
      for (const k in dp) {
        const d = dp[k];
        const r = d && d.rect;
        if (!r || !(r.width > 0) || !(r.height > 0)) continue;   // 跳过退化/空容器 rect(如 EMPTY_ROLE 的 def[0]=(0,0,0,0))
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.width > maxX) maxX = r.x + r.width;
        if (r.y + r.height > maxY) maxY = r.y + r.height;
        cnt++;
      }
    }
    if (cnt === 0) {
      // 兜底：没有任何可用 rect 时，回退到 512 标准包围盒(避免 NaN)
      const dr = (sd && sd.definitionPool && dp && dp[0] && dp[0].rect) ? dp[0].rect : { x: -256, y: -256, width: 512, height: 512 };
      minX = dr.x; minY = dr.y; maxX = dr.x + dr.width; maxY = dr.y + dr.height;
    }
    const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    this._unionRectCache = { sd, rect };
    return rect;
  }

  // 复用某 (方向,缩放) 缓存的锚定映射：直接重设画布平移与名字/血条落位（无像素扫描、不建 disp、不复制循环）
  _applyAnchor(cv, scale) {
    const a = this._anchor;
    // ★ 站立型骑乘时人物整体上移（见 _standLiftPx）；走缓存路径同样要施加
    this.canvasWrap.style.transform = `translate(${a.dx}px, ${a.dy + this._standLiftPx()}px)`;
    this._modelHeadY = a.modelHeadY; this._modelCxEl = a.modelCxEl;   // 同步给 bodyAnchor（切换方向复用缓存时仍准确）
    this._mcHeightPx = a.modelMcHeight;   // 同步固定血条高度（复用缓存时准确）
    this._mcHeightRaw = a.modelMcHeightRaw;   // 同步未封顶 mcHeight（NPC 头顶状态图标用）
    // ★ 必须同步 flash 原点：缓存是按 (pool,scale) 存的，换方向即换 pool ⇒ _originD* 必须跟着缓存里那份更新，
    //   否则纸娃娃/武器层会沿用上一方向的基准 → 换成 LB/RT/LT 后整层错位（"武器与人物错位"的第二根因）。
    if (a.originDX != null) { this._originDX = a.originDX; this._originDY = a.originDY; }
    // 注：命中判定的翻转镜像不需要缓存任何"轴"——scene 用 canvas 自己的 rect 取样，天然与画面同轴（见 scene.js 顶部注释）。
    // ★ 红叉 = 模型锚点(.el 0,0)。走缓存路径也必须重设：换方向时 originEl 绝不可跟随 _originD*，
    //   那已是"flash 原点"而非"锚点"——锚点恒在 .el(0,0)（与 _anchorByFoot 同口径）。
    if (this.originEl) { this.originEl.style.left = '0px'; this.originEl.style.top = '0px'; }
    this._placeBars(0, a.modelFootY, a.modelHeadY);   // cx=0：同 _anchorByFoot，名字/血条/状态居中在锚点(角色坐标)上
    // ★ 同上：走缓存路径更新了身体原点后，也必须重算所有叠加层（换朝向 = 换 pool = 原点变）。
    this._reanchorLayers();
  }

  // 注：fanvas 原画布完整保留并每帧自绘，仅通过 _anchor 平移锚定；不裁切、无 disp 复制层与裁切循环。

  // 名字/血条/状态面板落位。cx=锚点(角色坐标)在 .el 的 x，调用方恒传 0；footY=脚底(恒 0)、headY=头顶(负)。
  // ★ 权威口径 deobfuscated/characters/Fighter.as:516~523（setXY）—— 三者都是【以角色坐标 x 为居中轴】：
  //     nameSprite.x = x - nameField.width/2; _hpbarSprite.x = x - _hpbarBitmap.width/2; _battleStatePanel.x = x - width/2;
  //   故本实现 nameEl/hpBar/_buffBar 统一 `left = cx(=0)` + `translate(-50%,…)`（= 居中在红十字正上/正下方）。
  //   ⚠ 绝不可再传"身体画布中心(_modelCxEl)"：内容未居中于原点的模型（单 Role 210071 偏 38px）名字会右移。
  // 计算一次后由 _anchor 缓存复用，切换动作不重算、不漂移。
  // 血条高度：对齐原版 Fighter.as —— mcHeight = mc.height(模型包围盒高, 封顶 120)，血条顶贴角色包围盒顶(y - mcHeight)，
  // 即「固定高度」而非像素检测；模型级常量，与动作/缩放/新增特效脱钩，加新特效永不需重调。
  _placeBars(cx, footY, headY) {
    this.nameEl.style.left = cx + 'px';
    this.nameEl.style.top = (footY + 10) + 'px';   // 对齐原版 nameSprite.y = y+10（脚底下方 10px）
    this.nameEl.style.transform = 'translate(-50%, 0)';
    // 固定血条高度（CSS px）：mcHeight = min(站立池包围盒高, 120)；顶贴角色包围盒顶(略下 3px，对齐原版 _hpBitmap.y=3)
    const mcH = (this._mcHeightPx != null) ? this._mcHeightPx : (-headY);   // 正高度（fallback：旧结构性 headY 取反）
    this.hpBar.style.left = cx + 'px';
    if (this.hpAbove) {
      this.hpBar.style.top = (-mcH + 3) + 'px';        // 顶锚定：血条顶贴包围盒顶(略下 3px)，对齐原版 hpbarSprite.y = y - mcHeight
      this.hpBar.style.transform = 'translate(-50%, 0)';
    } else {
      this.hpBar.style.top = (footY + 10) + 'px';       // 脚底下方（与原版名字同区）
      this.hpBar.style.transform = 'translate(-50%, 0)';
    }
    // 模型(重)锚定时同步把状态动画层贴回头顶（缓冲像素映射，无需再乘缩放）
    this._layoutStatusLayer();
    // Buff 图标条定位：对齐 AS3 BattleStatePanel y = y - mcHeight + 10（头顶上方）。
    // 用 translate(-50%, -100%) 把容器"底"锚定在头顶上方 18px 处；配合 CSS wrap-reverse，
    // 第一行(1~5)贴着该底，满 5 个后新行向上堆叠，不会向下压到血条。
    const mcH2 = (this._mcHeightPx != null) ? this._mcHeightPx : (-headY);
    this._buffBar.style.left = cx + 'px';
    this._buffBar.style.top = (-mcH2 - 18) + 'px';
    this._buffBar.style.transform = 'translate(-50%, -100%)';
  }

  // 渲染顺序对齐原版 Fighter.as：模型(mc)先入 layer，文字/血条随后显于上层。
  // 轮询当前画布首帧是否绘制完成（取非透明像素即视为已绘），完成后再显名字/血条；
  // 兜底：超时(~40 帧≈660ms)或跨域读取失败则直接显（不影响战斗）。仅用于"显隐"判定，与血条高度无关。
  // 名字/血条显隐：模型画布首帧绘出后再显示。
  // ★★★ 13p 根治（灵昌城持续 ~100ms 卡顿 / 右键无菜单）：彻底移除逐帧 getImageData 回读。
  //   根因：fanvas 创建角色画布上下文时【未】设 willReadFrequently，故本函数即便带该标志浏览器也会忽略；
  //   而在角色画布上调用 getImageData 会把该画布永久钉入 Chrome 的"慢速回读"模式——
  //   此后 fanvas 每帧绘制 40 个角色全部走慢路径 ≈ 主线程每帧多耗 ~100ms（即用户感知的"卡死"）。
  //   改为纯时间触发（spawn 后短延时显示，模型即绘出），零回读、零慢模式触发；
  //   池回收/销毁时 _cancelReveal 清掉定时器，杜绝切图风暴下的孤儿 rAF 累积。
  _revealText() {
    if (this._revealTimer) return;            // 已在排队，避免重复
    this._revealTimer = setTimeout(() => {
      this._revealTimer = null;
      this._showText();
    }, 100);
  }
  _cancelReveal() {
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
  }

  _showText() {
    this.nameEl.style.visibility = '';
    this.hpBar.style.visibility = '';
    this._shownForCharId = this.charId;
    this._revealTries = 0;
  }

  // 模型"身体中心"屏幕锚点（供技能/特效按视觉中心对准）：脚底锚点(fig.x,fig.y) 上移半个身高。
  // _modelHeadY = 头顶在 .el 坐标系的 y（脚底=0，故为负），_modelCxEl = 身体水平中心(相对 .el 原点，=0)。
  // 故身体中心 = (fig.x + _modelCxEl, fig.y + _modelHeadY*0.5)（._modelHeadY 已含缩放，直接进屏幕像素）。
  // 未量到包围盒(尚未 act)时回退脚底，避免 NaN。
  bodyAnchor() {
    const h = (this._modelHeadY != null) ? this._modelHeadY : 0;   // 负：头顶在脚底上方
    const cx = (this._modelCxEl != null) ? this._modelCxEl : 0;
    return { x: this.x + cx, y: this.y + h * 0.5 };
  }

  // ── 状态动画层（统一原点叠加，持续循环，buff 移除时停 Timer）──
  // 状态层挂在 this.el 局部 (0,0) = 模型脚底原点(fig.x,fig.y)。各状态 canvas 由 playStatus+anchorOrigin 把
  // 自身 Flash 原点对齐到 (0,0)（即该层原点，不做内容中心扫描），从而状态动画 Flash 原点与模型原点重合（原点叠加，对齐 origin_overlay.html）。
  // 不再用头顶 flex / translate(-50%,-100%) 定位——那不是原点叠加，会让状态动画相对模型偏移、与 effect/skill 坐标系不一致。
  _layoutStatusLayer() {
    const layer = this._statusLayer;
    if (!layer) return;
    layer.style.position = 'absolute';
    layer.style.left = '0px';
    layer.style.top = '0px';
    layer.style.transform = 'none';
    layer.style.display = 'block';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '50';
  }

  // 启动某个 buff 的状态动画：每个 buff 各自一个 wrap 容器（避免 mount 互相清掉对方 canvas），循环播放。
  // 动画资源优先用 buff 自身的 anim 字段（编辑器可调、可不与 kind 默认同名）；否则回退 kind→resource/battle/{n} 默认映射。
  _startStatusAnim(b) {
    const n = (b.def.anim && String(b.def.anim).trim()) || STATUS_ANIM[b.def.kind];
    if (!n || b._statusCanvas || !this._statusLayer) return;
    const wrap = document.createElement('div');
    wrap.className = 'fighter-status-item';
    this._statusLayer.appendChild(wrap);
    const scale = (this.battleScale != null ? this.battleScale : 1);
    // 状态层挂在 this.el 局部 (0,0)=模型脚底原点(fig.x,fig.y)；playStatus 经 anchorOrigin(纯 Flash 原点，不做内容中心扫描) 把状态 canvas 的
    // Flash 原点对齐到 (0,0)，即状态动画 Flash 原点与模型原点重合（统一原点叠加），与 effect/skill 同坐标系、可叠加。
    playStatus(wrap, n, { loop: true, scale, x: 0, y: 0 }).then((res) => {
      if (res && res.canvas) {
        b._statusCanvas = res.canvas;   // 记录 canvas，移除时 fanvas.pause(this._statusCanvas) 停 Timer
        b._statusWrap = wrap;
        this._layoutStatusLayer();      // 动画就位后重排（确保贴紧头顶）
      } else {
        wrap.remove();
      }
    }).catch(() => { wrap.remove(); });
  }

  // 停止并移除某个 buff 的状态动画：先 fanvas.pause（停内部 Timer，防泄漏），再移除 canvas 与 wrap。
  _stopStatusAnim(b) {
    if (!b) return;
    if (b._statusCanvas) {
      try { window.fanvas && window.fanvas.pause(b._statusCanvas); } catch (e) {}
      if (b._statusCanvas.parentNode) b._statusCanvas.remove();
    }
    if (b._statusWrap && b._statusWrap.parentNode) b._statusWrap.parentNode.removeChild(b._statusWrap);
    b._statusCanvas = null; b._statusWrap = null;
  }

  // ── Buff/Debuff 图标条刷新（对齐 AS3 BattleStatePanel.updateStateIcon）──
  // 全量重绘 this.buffs → 15×15 色块图标，横排 5 个/行（wrap-reverse 满行向上堆叠）；
  // 每个图标显示 buff 色块+名首字+剩余回合。
  // debuff（含 dot/kind=poison/burn/stun 等）红框，增益(buff kind)绿框，其余中性。
  _refreshBuffIcons() {
    if (!this._buffBar) return;
    this._buffBar.innerHTML = '';
    if ((!this.buffs || !this.buffs.length) && !(this.valor > 0)) { this._buffBar.style.display = 'none'; return; }
    this._buffBar.style.display = 'flex';
    const DEBUFF_KINDS = ['poison','burn','stun','taunt','confusion','sleep','breakarmor','freeze','weak','slow',
      'fugu','chuanxin','feihua','dongdi','bahuang'];
    for (const b of this.buffs) {
      const d = b.def;
      if (!d) continue;
      // ★ 被动技能挂的永久 buff（silent）：不画图标，效果照常生效（用户裁决：战斗被动无 buff 图标）
      if (d.silent) continue;
      const isDebuff = DEBUFF_KINDS.includes(d.kind) || !!d.dot;
      const cat = isDebuff ? 'debuff' : 'buff';
      const icon = document.createElement('div');
      icon.className = 'fighter-buff-icon ' + cat;
      icon.title = d.name + (b.turnsLeft > 0 ? ' (' + b.turnsLeft + '回合)' : '');
      const color = document.createElement('div');
      color.className = 'bf-color';
      color.style.background = d.color || '#888';
      icon.appendChild(color);
      const label = document.createElement('div');
      label.className = 'bf-name';
      label.textContent = (d.name || '?').slice(0, 1);
      icon.appendChild(label);
      if (b.turnsLeft > 0 && b.turnsLeft < 99) {
        const turns = document.createElement('div');
        turns.className = 'bf-turns';
        turns.textContent = b.turnsLeft;
        icon.appendChild(turns);
      }
      if (b.stack > 1) {
        const stk = document.createElement('div');
        stk.className = 'bf-turns';
        stk.textContent = '×' + b.stack;
        stk.style.left = '0'; stk.style.bottom = '0'; stk.style.right = 'auto';
        icon.appendChild(stk);
      }
      this._buffBar.appendChild(icon);
    }
    // 侠义之心：独立状态（非 buff），按层数显示在 buff 栏（满足"施放者获得侠义之心状态图标"需求）
    if (this.valor > 0) {
      const vi = document.createElement('div');
      vi.className = 'fighter-buff-icon buff';
      vi.title = '侠义之心 ×' + this.valor;
      const vc = document.createElement('div');
      vc.className = 'bf-color';
      vc.style.background = '#E8C84B';
      vi.appendChild(vc);
      const vl = document.createElement('div');
      vl.className = 'bf-name';
      vl.textContent = '侠';
      vi.appendChild(vl);
      const vt = document.createElement('div');
      vt.className = 'bf-turns';
      vt.textContent = this.valor;
      vi.appendChild(vt);
      this._buffBar.appendChild(vi);
    }
  }
  stand() { return this.act(ACTION.STAND, this.dir); }
  walk()  { return this.act(ACTION.WALK, this.dir); }
  attack(){ return this.act(ACTION.ATTACK, this.dir); }
  cast()  { return this.act(ACTION.CAST, this.dir); }
  hurt()  { return this.act(ACTION.HURT, this.dir); }
  // 纯"倒下"演出：切倒地帧并定格末帧（不含 AS3 的可见性闪动/收尾分支）。
  // 用于非阵亡的倒地场景（如胜利演出里残余敌人的定格倒地）；真正的阵亡走 die()。
  // 关键：fanvas 的 Timer 永远循环、不尊重 loop:false，故 act 内部走 freezeLast 通道——
  // 由 fanvas.onFrame 在逻辑帧数到达总帧数时主动 gotoAndStop(末帧) 冻结（并暂停 Timer）。
  // 此处 await 整段动画时长，确保倒地演出完整可见、归位/胜负判定在定格后发生。
  async down() {
    await this.act(ACTION.DOWN, this.dir, { loop: false, freezeLast: true });
    const frames = this._fanvasFrames || 1;
    const rate = this._fanvasFrameRate || 25;
    const dur = (frames / rate) * 1000;
    await new Promise((res) => setTimeout(res, dur + 60));
  }

  // ── 阵亡演出（严格对齐 AS3 animate/battle/BattleInitializer17 + 触发时机）──────
  // 【触发时机】AS3 里阵亡并非发生在伤害结算那一刻：所有掉血/回血都经 ANIMATE_HPMPSP
  //   (BattleInitializer14)，其 step 在【500ms 帧】才调 animateManager.handleResult()
  //   → 由 AnimateManager.handleResult 按 result 位掩码发起 ANIMATE_DEAD。
  //   ⇒ 飘字出现后 500ms 才切倒地帧（这就是"数字先飘、怪物随后才倒"的原版节奏）。
  // 【900ms 时间轴】(BattleInitializer17.step)
  //     0ms  切 DOWN 帧（原版同时播 fighter.deadsound；本项目音效为纯 WebAudio 合成、无该音效资源，未接）
  //   500ms  真死→隐 / 假倒地→显
  //   600ms  显
  //   700ms  真死→隐 / 假倒地→显
  //   800ms  显
  //   850ms  若【非清场销毁】→隐
  //   900ms  destroyFighter()：清场销毁→消失；否则→显 + 回原位
  //   isDestroyFighter() = PVE && 敌方(pid>9) && 真死　⇒　本移植的 clearOnDeath 参数。
  // 【闪动范围】AS3 的 fighter.visible 只隐藏 Fighter 本体：名字/血条/状态面板挂在 battleScene 的
  //   独立 layer(nameLayer/hpbarLayer)上，不随闪动隐藏。本项目这几样在 .el 内、_bodyWrap 之外
  //   ⇒ 只对 _bodyWrap 设 visibility 即完全等价。
  // @param {boolean} isDead        是否真死（AS3 _isDead）。false=假倒地（仅 850ms 闪一下，重新现身）
  // @param {boolean} clearOnDeath  是否清场销毁（AS3 isDestroyFighter）：true=敌方真死→900ms 消失；
  //                                false=我方死者→850ms 隐、900ms 现身并回原位
  // @param {number}  fromFloat     飘字后多久触发（AS3 固定 500ms）
  async die({ isDead = true, clearOnDeath = false, fromFloat = 500 } = {}) {
    // ① 对齐 BattleInitializer14：飘字 500ms 帧才触发死亡演出。
    //    未曾飘过字（毒发/反噬等直接致死）则不等待，立即倒地。
    // ★ 代际守卫（_dieGen）：pFig 是常驻实例（战斗与主城共用同一个 .el），演出中途若战斗收尾
    //   （_end / RolePool.release / 池复用 / initState），必须作废余下回调——否则会在主城把角色
    //   坐标改回战斗点、或把本体可见性残留成 hidden。代际在 release()/initState() 里自增。
    const gen = ++this._dieGen;
    const alive = () => gen === this._dieGen;
    const step = (ms, fn) => setTimeout(() => { if (alive()) fn(); }, ms);
    const last = this._lastFloatMs || 0;
    if (last && fromFloat > 0) {
      const rest = fromFloat - (performance.now() - last);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
      if (!alive()) return;                     // 等待飘字期间战斗已收尾：整段演出作废
    }
    // ② 0ms：切倒地帧（不 await 整段——AS3 是同帧切帧后继续走 900ms 时间轴，不阻塞后续闪动）
    this.act(ACTION.DOWN, this.dir, { loop: false, freezeLast: true });
    // ③ 可见性闪动 + ④ 收尾（与 AS3 逐帧 isExecute 的时间点一一对应）
    await new Promise((resolve) => {
      step(500, () => this._setBodyVisible(!isDead));
      step(600, () => this._setBodyVisible(true));
      step(700, () => this._setBodyVisible(!isDead));
      step(800, () => this._setBodyVisible(true));
      if (!clearOnDeath) step(850, () => this._setBodyVisible(false));
      step(900, () => {
        // 900ms destroyFighter() 等价物：
        //   非清场（我方死者）→ 显现并回原位（AS3 visible=true + backOriginerPosition）
        //   清场销毁（敌方真死）→ 本体原样交回调用方，由 _onEnemyDown 的 RolePool.release 摘离（= AS3 destroy）
        if (!clearOnDeath) {
          this._setBodyVisible(true);
          if (this._home) this.setPos(this._home.x, this._home.y);
        }
      });
      setTimeout(resolve, 960);                 // 兜底：代际即使失效也必须让 await 返回，避免调用方悬挂
    });
  }

  // die() 用：只切换【角色本体】可见性（_bodyWrap 含身体 canvas + 全部纸娃娃/装备叠加层）。
  // 名字/血条/状态/buff 挂在 _bodyWrap 之外（.el 下），故不受影响——与 AS3 fighter.visible 语义一致。
  _setBodyVisible(v) {
    const wrap = this._bodyWrap || this.el;
    if (wrap) wrap.style.visibility = v ? '' : 'hidden';
  }

  // 作废仍在飞行的阵亡演出回调（die() 的 500~900ms 定时器）并把本体可见性复位。
  // 三个公共边界都要调：release()（池回收）、destroy()（彻底销毁）、initState()（复用前重置）。
  _cancelDeathFx() {
    this._dieGen = (this._dieGen || 0) + 1;
    this._setBodyVisible(true);
  }

  // ── HP/MP 存取：所有写入强制取整 + 夹取，从源头杜绝小数/越界 ──
  get hp() { return this._hp; }
  set hp(v) { this._hp = Math.max(0, Math.min(this.maxHp != null ? this.maxHp : Infinity, _rint(v))); }
  get mp() { return this._mp; }
  set mp(v) { this._mp = Math.max(0, Math.min(this.maxMp != null ? this.maxMp : Infinity, _rint(v))); }
  get maxHp() { return this._maxHp; }
  set maxHp(v) { this._maxHp = Math.max(1, _rint(v)); }
  get maxMp() { return this._maxMp; }
  set maxMp(v) { this._maxMp = Math.max(0, _rint(v)); }

  takeDamage(dmg) {
    dmg = Math.max(1, _rint(dmg - this.def * 0.25));
    this.hp = Math.max(0, this.hp - dmg);
    this.updateBar();
    if (this.hp > 0) this.hurt();   // 受击播放受身动作（无独立受身帧的角色回退为站立）
    return dmg;
  }
  heal(v) { this.hp = Math.min(this.maxHp, this.hp + v); this.updateBar(); }
  costMp(v) { this.mp = Math.max(0, this.mp - v); this.updateBar(); }
  // 怒气消耗（仅人物：爆气与怒气技能）；rageMax=0 的单位（宠物/怪物）无怒气，消耗不生效
  costRage(v) { if (!v || this.rageMax <= 0) return; this.rage = Math.max(0, this.rage - v); this.updateBar(); }
  // 寿命消耗（仅宠物：寿命技能）；lifeMax=0 的单位（人物/怪物）无寿命，消耗不生效
  costLife(v) { if (!v || this.lifeMax <= 0) return; this.life = Math.max(0, this.life - v); this.updateBar(); }

  // 装备/强化加成：把已穿戴部位的属性叠加到战斗属性（对齐角色面板「装备属性」展示，确保 UI 与战斗一致）。
  // ★ 属性真源 = equip-stats.js 从物品 desc 解析的真实数值（基础属性/增强属性/绑定属性/铭刻/附魔/宝石），
  //   覆盖 items.json 全部 1180 件可解析装备；旧 it.effect 分支保留兼容（仅「新月法杖」1 条手工数据）。
  // 强化：每级按 ForgePanel 的 step(=effect.atk||effect.def) 叠加到对应攻/防，使面板「当前加成：+lv*step」真实生效。
  // 基础值(_base*)来自后端/等级成长；在其上叠加，故后端覆盖 atk 后需重新调用以补回装备/强化层。
  applyEquip() {
    // ★ 先回退上一轮被动技能 buff 的属性加成并摘除，再重算装备层。
    //   必须在下方 _base* 绝对重置【之前】回退：atk/def/mag/magDef/spd/maxHp/maxMp/crit 会被下面的
    //   赋值整体覆盖（回退早一步晚一步都一样），但 phyDodge/phyCrit/magDodge/magCrit/phyHit/magHit/
    //   recover 不在重置名单内 —— 若不回退就重挂（_reapplyPassives → applyPassiveBuffs），被动加成
    //   （多为 fig.xxx*(0.05+0.05*L) 的乘算）会在当前值上反复叠加，穿脱几次后闪避/暴击指数级膨胀。
    this._stripPassiveBuffs();
    if (this.equip && Config.items) {
    let a = 0, d = 0, h = 0, m = 0, c = 0, mg = 0, md = 0, sp = 0;
    // 装备属性：主属性（力量/耐力/敏捷/智力/信仰）单独累加，走 _basePrim 叠加口径
    let pStr = 0, pSta = 0, pAgi = 0, pInt = 0, pFai = 0;
    for (const itemId of Object.values(this.equip)) {
      const it = Config.items[itemId];
      if (!it) continue;
      // ★ 新口径：desc 解析的真实装备属性（1180/1183 件装备覆盖）
      const st = equipStatsOf(itemId);
      if (st) {
        if (st.strength) pStr += st.strength;
        if (st.stamina) pSta += st.stamina;
        if (st.agility) pAgi += st.agility;
        if (st.intellect) pInt += st.intellect;
        if (st.faith) pFai += st.faith;
        if (st.atk) a += st.atk;
        if (st.def) d += st.def;
        if (st.mag) mg += st.mag;
        if (st.magDef) md += st.magDef;
        if (st.spd) sp += st.spd;
        if (st.maxHp) h += st.maxHp;
        if (st.maxMp) m += st.maxMp;
        if (st.crit) c += st.crit;
        // 铭刻千分比：在当前派生上限上乘算（基准存在才折算，不臆造）
        if (st._permille) {
          if (st._permille.maxHp) h += Math.round(((this._baseMaxHp || 0) + h) * st._permille.maxHp);
          if (st._permille.maxMp) m += Math.round(((this._baseMaxMp || 0) + m) * st._permille.maxMp);
        }
      }
      // 旧口径兼容：it.effect（仅「新月法杖」等手工数据）
      const e = it.effect;
      if (!e) continue;
      const lv = (this.enhance && this.enhance[itemId]) || 0;   // 锻造强化等级
      if (e.atk) a += e.atk + lv * e.atk;        // 武器：每级 +atk（对齐 ForgePanel step=effect.atk）
      else if (e.def) d += e.def + lv * e.def;  // 护甲：每级 +def（对齐 ForgePanel step=effect.def）
      if (e.mag) mg += e.mag + lv * e.mag;       // 法术攻击装备
      if (e.magDef) md += e.magDef + lv * e.magDef; // 法术防御装备
      if (e.spd) sp += e.spd + lv * e.spd;       // 速度装备
      if (e.hp) h += e.hp; if (e.mp) m += e.mp;
      if (e.crit) c += e.crit;                  // 装备暴击率累加（对齐 AS3 装备暴击贡献，运行期被 BattleScene._calcDamage 消费）
    }
    // 装备主属性加成叠加到人物五维：先剔除上一轮的装备主属性加成（避免重算时重复累加），
    // 再叠加本轮。基准 = _basePrim（applyDerived 在调用本方法前刚写入的洁净派生值）。
    if (pStr || pSta || pAgi || pInt || pFai || this._equipPrimAdd) {
      const bp = this._basePrim || (this._basePrim = {});
      const prev = this._equipPrimAdd || {};
      const add = { strength: pStr, stamina: pSta, agility: pAgi, intellect: pInt, faith: pFai };
      for (const k of ['strength', 'stamina', 'agility', 'intellect', 'faith']) {
        this[k] = (Number(bp[k]) || 0) + (Number(add[k]) || 0);
      }
      this._equipPrimAdd = add;   // 记录本轮装备主属性加成，供 _reapplyPassives / 下次重算回退
    }
    // 防御：_base* 可能未初始化（如战斗主角 Fighter 由显式字段构造、未经 applyDerived）。
    // 直接相加会得到 NaN 并污染后续（出手顺序排序比较 / 伤害公式 / 面板显示"0"），故统一 || 0 兜底。
    this.atk = (this._baseAtk || 0) + a;
    this.def = (this._baseDef || 0) + d;
    this.mag = (this._baseMag || 0) + mg;
    this.magDef = (this._baseMagDef || 0) + md;
    this.spd = (this._baseSpd || 0) + sp;
    this.maxHp = (this._baseMaxHp || 0) + h;
    this.maxMp = (this._baseMaxMp || 0) + m;
    this.crit = (this._baseCrit || 0) + c;       // 基础暴击率 + 装备暴击（展示/战斗同源，避免"展示有暴击、战斗无暴击"退化）
    if (this.hp > this.maxHp) this.hp = this.maxHp;   // 脱装备上限下降时夹取当前值
    if (this.mp > this.maxMp) this.mp = this.maxMp;
    }
    // ★ 被动技能加成层：在派生/装备之后叠加。此时二级属性刚由 _base* 重算为洁净值，
    //   主属性回退到 _basePrim ⇒ 被动公式对洁净值求值，不会重复乘算（装备变化/升级/战后重算均幂等）。
    //   ★ 效果：被动加成战斗内外一致，进入战斗不再「属性突然跳变」。
    this._reapplyPassives();
    this.refreshPaperDoll();   // 纸娃娃：按穿戴装备的 modelId 重建叠加层（脱/穿装备即时生效）
  }

  // 摘除全部被动技能 buff 并【先回退其 statAdd 再丢弃】：装备/派生重算前的洁净化步骤，
  //   随后由 _reapplyPassives → applyPassiveBuffs 在洁净值上重新挂上
  //   （与 skill-engine.reapplyPassiveBuffs 同口径，池复用路径已验证）。
  //   ★ 若只丢弃不回退，phyDodge/phyCrit 等不被 applyEquip 重置的二级属性会每轮重复叠加（穿脱漂移 bug）。
  _stripPassiveBuffs() {
    if (!Array.isArray(this.buffs) || !this.buffs.length) return;
    const kept = [];
    let changed = false;
    for (const b of this.buffs) {
      if (!b._passive) { kept.push(b); continue; }
      if (b.def && b.def.statAdd) this._applyStatAdd(b.def.statAdd, -1);   // ★ 先回退再加，幂等
      if (typeof this._stopStatusAnim === 'function') { try { this._stopStatusAnim(b); } catch (e) {} }
      changed = true;
    }
    if (changed) {
      this.buffs = kept;
      if (typeof this._refreshBuffIcons === 'function') this._refreshBuffIcons();
    }
  }

  // 重挂被动技能加成：被动 buff 已由 applyEquip 开头的 _stripPassiveBuffs 摘除并回退加成，
  //   主属性回退到派生基准（保留装备主属性），再按当前技能表在洁净值上重新计算挂上。
  _reapplyPassives() {
    // ★ 主属性回退到「派生基准 + 装备加成」：装备提供的主属性（力量/耐力/…）是常驻加成，
    //   回退时必须保留，否则脱装备/重算被动会丢失装备主属性（applyEquip 在 _basePrim 之上叠加）。
    const bp = this._basePrim;
    if (bp) {
      for (const k of ['stamina', 'intellect', 'strength', 'agility', 'faith'])
        if (bp[k] != null) this[k] = bp[k] + (Number((this._equipPrimAdd || {})[k]) || 0);
    }
    if (Array.isArray(this.buffs) && this.buffs.length) {
      const kept = this.buffs.filter((b) => !b._passive);
      if (kept.length !== this.buffs.length) {
        this.buffs = kept;
        if (this._refreshBuffIcons) this._refreshBuffIcons();
      }
    }
    this.__passiveApplied = false;
    const before = { stamina: this.stamina, intellect: this.intellect, strength: this.strength,
      agility: this.agility, faith: this.faith };
    try { applyPassiveBuffs(null, this); } catch (e) { console.warn('[fighter] 被动加成重挂失败：', e && e.message); }
    // 记录本轮主属性加成，供下次 applyDerived 入口回退
    this._passivePrimAdd = {};
    for (const k in before) this._passivePrimAdd[k] = (this[k] || 0) - (before[k] || 0);
    this._primDirty = true;   // 主属性已 = 基准 + 装备 + 被动，下次 applyDerived 入口需回退
    if (this.hp > this.maxHp) this.hp = this.maxHp;
    if (this.mp > this.maxMp) this.mp = this.maxMp;
    if (this.rage > this.rageMax) this.rage = this.rageMax;
    this.updateBar();
  }

  // ── 纸娃娃系统（多模型叠加）──
  // 设计（对齐 AS3 CurrentPanelNpc：角色 = 基础身体 + 武器/翅膀/仙化/坐骑等独立 SWF 子精灵，同名帧标签同步 + Role 原点对齐叠加）：
  //   每个叠加层是一个独立 char 模型，挂在 this.el 下与 canvasWrap 平级；层容器用【自身】的 Role 原点
  //   (definitionPool[0].rect 推导的 flash 原点) 经 translate 对齐到 this.el 脚底原点 —— 与身体共用同一原点 ⇒ 自然重合、可叠加。
  //   act() 把各层同步播放与身体【相同 base/dir/scale】，保证装备随角色同动作、同朝向。
  //   层 key 用命名空间前缀隔离：'equip:'+槽位（由 refreshPaperDoll 按穿戴装备自动生成）、'doll:'+N（展示模块手动叠加任意模型）。
  //   层级 z：body(canvasWrap)=1，装备层默认 6（翅膀 7、法宝/如意 8，可经 item.layerZ 覆盖）—— 复刻 AS3 bodyLayer 内 body<weapon<wings 且部件浮于身体之上。
  //   ⚠ 注意「变身卡/套装」(suitImg) 在原版是【替换 characterSprite 本体】(characterSprite.load)，并非叠加层；该机制由 Fighter 换底层模型(charId)实现，不走本纸娃娃系统。
  setLayer(key, charId, opts = {}) {
    if (!this.el) return;
    let layer = this.layers[key];
    if (!layer) {
      const el = document.createElement('div');
      el.className = 'fighter-doll-layer';
      el.style.position = 'absolute';
      el.style.left = '0px'; el.style.top = '0px';
      el.style.width = '0'; el.style.height = '0';
      el.style.pointerEvents = 'none';
      const wrap = document.createElement('div');
      wrap.className = 'fighter-doll-canvas';
      el.appendChild(wrap);
      // ★ 必须挂到 _bodyWrap（而非 this.el）：叠加层要与身体一起被整体镜像。
      //   挂到 this.el 会漏掉 _bodyWrap 的 scaleX(-1) → LB/RT 下武器不翻、与身体错位。
      (this._bodyWrap || this.el).appendChild(el);
      layer = this.layers[key] = { charId, el, wrap, z: (opts.z != null ? opts.z : 6), dx: opts.dx || 0, dy: opts.dy || 0 };
      if (opts.rideHide) layer.rideHide = true;   // 乘骑时隐藏（武器无乘骑动画；翅膀/法宝保留）
    } else {
      layer.charId = charId;
      if (opts.z != null) layer.z = opts.z;
      if (opts.dx != null) layer.dx = opts.dx;
      if (opts.dy != null) layer.dy = opts.dy;
      if (opts.rideHide) layer.rideHide = true;
    }
    layer.el.style.zIndex = String(layer.z);
    // 乘骑中的层按「视觉骑乘」显隐（新层在骑乘中途创建时也要立刻应用）
    if (layer.rideHide) layer.el.style.display = (this._riding && this._rideVisible) ? 'none' : '';
    this._refreshLayer(key);   // 立即按当前动作/朝向/缩放播放本层
  }

  // 把某层同步到当前动作（无动作时回退 stand），与身体同朝向同缩放
  _refreshLayer(key) {
    const layer = this.layers[key];
    if (!layer) return;
    const base = (this._current && this._current.base) || ACTION.STAND;
    // ★ 必须用【渲染朝向】_renderDir（LB→RB / RT→LT），与 act() 保持一致：
    //   合成朝向的 LB/RT 素材是空的，resolveAction 会把 'LB' 回退到 'LT' 池 —— 而身体此时播的是 RB；
    //   源素材朝向不一致 ⇒ 武器与身体对不上（整体翻转也救不回来）。用 _renderDir 才能让层与身体同源。
    const dir = this._renderDir || this.dir;
    const scale = (this.battleScale != null) ? this.battleScale : 1;
    const loop = !(this._current && this._current.loop === false);
    this._playLayer(key, base, dir, scale, { loop, freezeLast: false });
  }

  // 播放单层（与 act 同源：playChar 清本层旧 canvas + Role 原点锚定到脚底）
  async _playLayer(key, base, dir, scale, opts = {}) {
    const layer = this.layers[key];
    if (!layer) return;
    let r = null;
    try { r = await playChar(layer.wrap, layer.charId, base, dir, { loop: opts.loop, scale, freezeLast: opts.freezeLast }); }
    catch (e) { r = null; }
    if (!r) { try { clearContainer(layer.wrap); } catch (e) {} return; }   // 装备模型无此动作/方向：清残留，不报错
    this._anchorLayerCanvas(key, r, scale);
  }

  // ── 整体镜像（★ LB/RT 合成方向的唯一实现方式）──
  // user 2026-09-10 明确："原本RB和LT的动画是正确的,你只要做一个完整的翻转就可以得到另外的动画了,
  //   要把所有的叠加层按一个整体计算"。
  // 因此翻转【只作用在 _bodyWrap 这一个容器上】，_bodyWrap 内包含：
  //   ① 身体 canvasWrap（其自身 transform = 脚底锚定 translate）② 全部纸娃娃/装备/翅膀叠加层。
  // 因为所有成员同处一个被 scaleX(-1) 的坐标系，它们之间的相对位置（武器挂点 = Role 原点）完全不变
  // ⇒ 无论各层画布尺寸/原点如何不同，都不可能错位。这正是"按一个整体计算"的字面实现。
  // 镜像轴 = 【角色坐标点】= .el(0,0) = 红十字（见下方 ★★ 原版权威依据）。
  //   transform 只含 scaleX 与 origin、无 translate ⇒ 层坐标与轴的关系保持刚性，整体镜像的"绝不互相错位"性质不受影响。
  //   ⚠ 命中判定【不受此轴影响、也不需要同步】：scene._hitTestFighters 用 canvas 自己的 rect 取样，
  //     翻转元素的左右边在屏幕上本就互换 ⇒ `px = cv.width - px - 1` 恒正确（详见 scene.js 顶部该处注释与 12c 回归记录）。
  //
  // ★★ 2026-09-12 user：「方向的镜像要根据原点作轴进行镜像，翻转后的原点十字标都出错了」
  //   原版权威依据（deobfuscated/characters/CurrentPanelNpc.as:1555~1574）：镜像就是 `mc.scaleX = -1`，
  //   Flash 的 scaleX 是【绕该 MC 自身注册点】镜像；原版把 MC 的注册点摆在角色坐标 (x,y) 上
  //   ⇒ 镜像轴 = 角色坐标点。本实现里角色坐标点 = .el(0,0) = 红十字（canvasWrap 已把"脚/锚点"钉到这里）。
  //   _bodyWrap 与 .el 同点、0×0 ⇒ 其局部坐标即 .el 坐标 ⇒ transform-origin.x 恒为 0。
  //   ⚠ 旧实现用 `_anchor.dx + cv.width/2`（= 身体画布中心）：只有画布恰好关于锚点对称时才等价。
  //     实测常规角色 201021 的画布中心偏离锚点 13.5px、单 Role 210071 偏 38px ⇒ 一转身模型就相对红十字平移
  //     2 倍偏移量（正是 user 报的"翻转后原点十字标出错"）。
  _applyFlip() {
    if (!this._bodyWrap) return;
    this._bodyWrap.style.transformOrigin = '0px 0';   // 轴 = 锚点/红十字（scaleX 与 y 无关，y 取 0）
    this._bodyWrap.style.transform = (this.flipX === -1) ? 'scaleX(-1)' : '';
  }

  // ★ 站立型骑乘的人物整体抬升量（像素，已按当前 scale 换算；y 负 = 向上）。
  //   AS3 取证（CurrentPanelNpc.as::checkStandRideY）：站立骑乘时 characterSprite.y = standToY = -30、
  //   suitLayer.y = -30、positionCorrection(-30 + rider.y)（specialRidePet 才加骑宠 rider 挂点 y）。
  //   人物站在骑宠上，骑宠模型有离地高度，不抬升人物会陷进骑宠里（用户报"人物模型位置偏下"）。
  //   非站立型 / 未骑乘 / 进战隐藏期间一律 0。
  //   ★★ 统一锚点对齐口径（2026-10-04 用户定）：骑宠层与人物/武器层共用同一个 Flash 原点叠加，
  //      默认不施加抬升（STAND_LIFT_DEFAULT=0）；AS3 固定 -30 与 specialRidePet 特例均废弃——
  //      各模型踩点高度差异大（实证飞剑 -30 偏高、0 偏低），抬升量全由模型 index.html 的
  //      per-model ridepetMeta.standLift 决定（getRidepetLift，async）。
  //   ★★ 热路径口径：mountRide/applyRideType 时一次性 await 读回存 this._rideStandLift，
  //      这里只读内存（渲染每帧都调，不能 await）。
  static get STAND_RIDE_LIFT() { return STAND_LIFT_DEFAULT; }
  _standLiftPx() {
    if (!(this._riding && this._rideVisible && this._rideType === 'stand')) return 0;
    const sc = (this._anchorScale != null) ? this._anchorScale : 1;
    return this._rideStandLift * sc;
  }

  // 层画布锚定（纸娃娃/装备/翅膀）：与身体按 Role 原点重合叠在身上。
  // 身体已改为"脚底锚定"，其 flash 原点随之下移到脚底右下角(.el 的 this._originDX/_originDY)。
  // 装备层须把自身 flash 原点对齐到【身体同一点】(this._originDX/_originDY)，而非 .el(0,0)，
  // 才能保持原设计的 Role 原点叠加关系（不被身体脚底锚定破坏、不脱离身体）。
  // 微调偏移(layer.dx/dy)叠加在 Role 原点基准之上（setLayerOffset 同）。
  //
  // ★ 翻转策略（user 2026-09-10 明确）：RB/LT 两套素材【本身正确】，LB/RT 应由 RB/LT
  //   「把身体与所有叠加层当作一个整体」做一次水平镜像得到 —— 而不是让每一层各自翻转。
  //   各层独立翻转会因「各层画布尺寸/原点不同 → 镜像轴不同」而互相错位（武器滑到手外）。
  //   故本方法【只负责把层对齐到 Role 原点】，翻转统一交给 _bodyWrap（见 _applyFlip）。
  _anchorLayerCanvas(key, r, scale) {
    const layer = this.layers[key];
    if (!layer) return;
    const sd = (r.rec && r.rec.swfData) || null;
    const dp = (sd && sd.definitionPool) || null;
    const def = (dp && r.pool != null) ? dp[r.pool] : null;
    const rect = (def && def.rect) ? { x: def.rect.x, y: def.rect.y, width: def.rect.width, height: def.rect.height } : { x: 0, y: 0, width: 0, height: 0 };
    // 本层"flash 原点(0,0)"在其自身画布内的像素位置。
    // fanvas 运行时（原点扩展分支，见 fanvas3-transparent.js）：
    //   e.width = rect.width*scale;  f.x = -rect.x*scale;  ⇒ flash 原点在画布内像素 = (-rect.x*scale, -rect.y*scale)
    //   （其内部另外写的 originX/originY 恰好就是 -rect.x / -rect.y，是同一件事的另一个载体。）
    // ★★ 必须【从 rect 推导】，不要读 def.originX：
    //   originX 由 fanvas 的 Stage.initialize 写入，而 Stage.initialize 在【图片预加载完成后】才执行；
    //   playChar 返回时它可能仍是 0（实测冷启动 ox=0 / 重放后 ox=-226），
    //   而 _anchorLayerCanvas 每次 play 只跑一次 ⇒ 错误偏移会一直保留 ⇒ 武器整体错位。
    //   而 rect 在 playChar 内（unionRectFor）就已就绪且与画布尺寸同源，无时序依赖。
    const ox = rect ? -rect.x : 0;
    const oy = rect ? -rect.y : 0;
    // ── 对齐（与 loader.js anchorOrigin 的"统一原点叠加"同源）──
    // 目标：本层【flash 原点(0,0)】落在 .el 的【身体 flash 原点】(this._originDX/_originDY)。
    //   本层 flash 原点(0,0) .el = 层平移 + ox*scale（ox = −rect.x = 本层原点在层画布内的像素）
    //   ⇒ 层平移 = 身体 flash 原点 − ox*scale = _originDX − ox*scale
    //   （_applyLayerPos 里实现为 baseX = _originDX − ox*sc；不再有 −256*sc）
    // ★★ 符号铁律：是【减】ox*scale。originX(= -rect.x) 是"flash 原点相对画布左上角的偏移"，
    //   要让 flash 原点落到目标点，必须把画布往反方向挪 ⇒ 负号。
    //   曾误写为 `+ ox*scale`，误差恰为 2*rect.x*scale（武器 100012 实测 rect.x=226 → 偏 452px，全错位）。
    // ★★ 只在这里【记录本层自身的原点偏移】，实际落位交给 _applyLayerPos 统一计算。
    //    这样层位置永远是「当前身体原点」的派生量，可被 _reanchorLayers 随时重算 ⇒ 与加载顺序无关。
    layer._ox = ox; layer._oy = oy; layer._anchorScale = scale;
    this._applyLayerPos(layer);
    layer._baseW = (r.canvas ? r.canvas.width : 0);
  }

  // 把某层的【当前落位】按「本层原点偏移 + 当前身体原点 + 微调偏移」重算并写回 DOM。
  // 纯函数式：只依赖 layer._ox/_oy/_anchorScale 与 this._originDX/_originDY，无任何时序假设。
  // _anchorLayerCanvas（层刚播完）与 _reanchorLayers（身体原点变了）共用同一段算式 ⇒ 两条路径永不打架。
  _applyLayerPos(layer) {
    if (!layer || !layer.wrap) return;
    const ox = (layer._ox != null ? layer._ox : 0);
    const oy = (layer._oy != null ? layer._oy : 0);
    const sc = (layer._anchorScale != null ? layer._anchorScale : 1);
    // ★ _originDX/_originDY = 「身体 flash 原点(0,0)」在 .el 的像素位置（= −脚点×scale，见 _anchorByFoot）。
    //   装备/纸娃娃层与身体【共用同一 Flash 坐标系】⇒ 只要把本层 flash 原点对齐到身体 flash 原点即可，
    //   这才是"叠加层与身体永远同轴"的充分条件（不绕道 512 画布中心，也就不会把单 Role 精灵的 256 常量带进来）。
    // ★ 2026-09-12 口径统一：_originDX 由「512 画布中心」改回「flash 原点」，此处同步去掉 −CANVAS_CENTER*sc。
    //   二者恒等：旧 = (256−footX)*sc − ox*sc − 256*sc；新 = (−footX*sc) − ox*sc ⇒ 对任意 foot 完全相同 ⇒ 层位置零变化。
    const baseX = (this._originDX != null ? this._originDX : 0) - ox * sc;
    const baseY = (this._originDY != null ? this._originDY : 0) - oy * sc;
    layer._baseDx = baseX; layer._baseDy = baseY;   // 记录 Role 原点对齐基准，微调偏移在其上叠加
    layer._anchorDbg = { ox, oy, scale: sc, baseX, baseY, originDX: this._originDX, originDY: this._originDY };
    const lx = (layer.dx || 0), ly = (layer.dy || 0);
    // ★ 站立型骑乘的人物抬升只作用于【人物部件】层（武器/法宝/翅膀/如意…），骑宠层(ridepet:*)不动
    //   （AS3 checkStandRideY 移的是 characterSprite/suitLayer/wingsSprite，不含骑宠 _standRider）
    const lift = layer.ridepetLayer ? 0 : this._standLiftPx();
    // 只做 Role 原点对齐平移；水平翻转由 _bodyWrap 整体施加（各层不再自翻转）
    layer.wrap.style.transformOrigin = '';
    layer.wrap.style.transform = `translate(${baseX + lx}px, ${baseY + ly + lift}px)`;
    // ★ 身体原点尚未算出时【先藏起来】，绝不显示一个错误位置：
    //   层比身体先加载完的那一小段时间里，只能"还没出现"，不能"出现在错的地方"。
    //   身体一锚定就会走 _reanchorLayers → 重新调用本方法 → 自动显形。
    //   用 visibility 而非 display：保留布局盒，便于测量/调试。
    const known = (this._originDX != null && this._originDY != null);
    layer.wrap.style.visibility = known ? '' : 'hidden';
  }

  // ★ 用【当前身体原点】重算所有已锚定层的位置。
  // 修复的竞态（user 2026-09-10 报：「刚加载叠加层时位置就是错的，要切换一下动画才会变正确」）：
  //   身体 playChar 与叠加层 playChar 是两条独立的异步链（_createModel 里 stand() 未 await 就 setLayer）；
  //   loadChar 有内存缓存 ⇒ 【武器已缓存 + 身体是冷模型】时层的 _anchorLayerCanvas 先跑，
  //   此时 this._originDX 还是 null ⇒ 层按 0 基准落位 ⇒ 武器被推到几百 px 外（"跑到边边角角"）。
  //   旧实现里这个错误值会一直留到下次重播该层（= 用户口中的"切一下动画才对"）。
  // 修法（底层）：身体原点一旦确定/变化，立刻重算所有层 ⇒ 谁先加载完都不影响最终位置。
  _reanchorLayers() {
    if (!this.layers) return;
    for (const key of Object.keys(this.layers)) {
      const layer = this.layers[key];
      if (layer && layer._ox != null) this._applyLayerPos(layer);
    }
  }

  // 微调某层偏移（X/Y 像素），用于把装备/部件精确对齐到角色身上（对齐 AS3 CharacterWingsPosData 挂点表）。
  // 偏移叠加在 Role 原点基准(_baseDx/_baseDy)之上，不破坏原点对齐。
  // ★ 不再做任何翻转：翻转统一由 _bodyWrap 整体负责（各层自翻转会互相错位）。
  setLayerOffset(key, dx, dy) {
    const layer = this.layers[key];
    if (!layer) return;
    layer.dx = dx; layer.dy = dy;
    const bx = (layer._baseDx || 0), by = (layer._baseDy || 0);
    layer.wrap.style.transformOrigin = '';
    layer.wrap.style.transform = `translate(${bx + dx}px, ${by + dy}px)`;
  }

  removeLayer(key) {
    const layer = this.layers[key];
    if (!layer) return;
    try { clearContainer(layer.wrap); } catch (e) {}
    if (layer.el && layer.el.parentNode) layer.el.parentNode.removeChild(layer.el);
    delete this.layers[key];
  }

  clearLayers() {
    if (!this.layers) return;
    for (const key of Object.keys(this.layers)) this.removeLayer(key);
  }

  // 清掉某前缀的层（如 'equip:' 仅清装备层，不影响 'doll:' 手动叠加）
  clearLayerPrefix(prefix) {
    if (!this.layers) return;
    for (const key of Object.keys(this.layers)) if (key.indexOf(prefix) === 0) this.removeLayer(key);
  }

  // 纸娃娃：按已穿戴装备生成叠加层。equip[slot] → Config.items[itemId].modelId（=resource/char 数字 id）。
  // 装备带 modelId 则该槽叠加对应模型（武器/铠甲/翅膀/坐骑…），否则该槽无层（仅走属性加成）。无 modelId 字段 → 不叠加（不臆造部件 id）。
  //
  // 层级顺序（对齐 AS3 CurrentPanelNpc 显示树）：
  //   bodyLayer 内：body(characterSprite) < weapon(weaponSprite) < wings(wingsSprite) —— 即 翅膀 恒在 武器 之上；
  //   immortalSprite 等为顶层（位于 bodyLayer 之上）。本方法用 slot 默认 z 复刻该序：武器/铠甲=6，翅膀=7（盖住武器），
  //   具体数值可被 Config.items[].layerZ 覆盖。body(canvasWrap) 固定 z=1，故所有装备层都浮于身体之上，与原版一致。
  // 翅膀显隐：对齐 AS3 isHideWings/WingCheck —— showWings=false 时跳过「翅膀」槽叠加层（变身/骑乘等状态也会在 AS3 侧销毁翅膀）。
  refreshPaperDoll() {
    if (!this.el || !this.layers || !this.equip) return;
    const items = Config.items || {};
    // slot → 默认叠加层 z（原版 bodyLayer 内顺序：body<weapon<wings；其余部位与武器同级）。可被 item.layerZ 覆盖。
    const SLOT_DEFAULT_Z = { '翅膀': 7, '法宝1': 8, '法宝2': 8, '法宝3': 8, '法宝4': 8, '法宝5': 8, '法宝6': 8, '如意': 8 };
    this.clearLayerPrefix('equip:');   // 先清装备层，按当前穿戴重建（脱装备即时移除）
    for (const slot of Object.keys(this.equip)) {
      if (slot === '翅膀' && !this.showWings) continue;   // 对齐 AS3 isHideWings：未勾选显示翅膀则不叠加翅膀模型
      const itemId = this.equip[slot];
      const it = items[itemId];
      if (it && it.modelId != null) {
        const z = (it.layerZ != null) ? it.layerZ : (SLOT_DEFAULT_Z[slot] != null ? SLOT_DEFAULT_Z[slot] : 6);
        // ★ 乘骑时隐藏武器层：武器没有乘骑动画，挂在骑手身上会穿帮（对齐 AS3 骑乘时只换 bodyLayer）。
        //   翅膀/法宝/如意保留（用户 2026-10-04 明确：不能简单屏蔽掉所有层）。
        this.setLayer('equip:' + slot, it.modelId, { z, rideHide: slot === '武器' });
      }
    }
  }

  // ── 骑宠系统（纸娃娃层方式实现，2026-10-04）──
  // 骑宠模型（4xxxxx）每个动作 = bg(depth1, 骑手身后) + fg(depth5, 骑手身前) 两个独立池。
  // 关键锚定事实（已取证）：bg/fg 池被主时间轴放在 (-256,-256) ⇒ 池 flash 原点(0,0) = 骑手脚点
  // = 主时间轴原点；而 resolveFoot 对骑宠模型返回 (256,256)（rootPlace）⇒ _originDX = -256*scale。
  // 故 bg/fg 层走标准纸娃娃锚定（自身 flash 原点 → _originDX）即与身体（骑手脚点）重合，无需特殊偏移。
  //
  // 层级：bg z=0（身体 canvasWrap z=1 之下 ⇒ 骑手身后）；fg z=9（装备层最高 8 之上 ⇒ 骑手身前，遮住武器/翅膀）。
  //
  // 动作映射（两种表现，用户 2026-10-04 指定）：
  //   ① 角色有 ride 动画（labels 含 standRBride/walkRBride）⇒ playChar 的 opts.ride 命中 base+dir+'ride'
  //   ② 角色无 ride 动画 ⇒ playChar 回退到普通 stand/walk（整个 body 包裹在骑宠 bg/fg 之间）
  // 骑宠层动作名 = base + dir（骑宠帧名无 ride 后缀，AS3 取证结论）。
  // 合成方向 LB/RT：骑宠空标签 Ride*RT/Ride*LB 的 bg/fg 已在 labels 里指向内容标签池；且 fighter 的
  //   _bodyWrap 整体 scaleX(-1) 会把人物+骑宠两层一起翻 ⇒ 与 AS3 _rider.scaleX=-1 一致。
  //
  // 层 key 命名空间：'ridepet:bg' / 'ridepet:fg'，与 'equip:' / 'doll:' 隔离，clearLayerPrefix('ridepet:') 可单独清。

  // 上骑：挂 bg+fg 两层，并把人物动作切到 ride 版本（若有）。返回是否成功。
  // ridepetId=骑宠模型 id；不传则沿用 this._ridepetId。
  async mountRide(ridepetId) {
    if (!this.el) return false;
    if (ridepetId) this._ridepetId = String(ridepetId);
    const rpId = this._ridepetId;
    if (!rpId) return false;
    this._riding = true;
    // ★ 显示类型 + 站立抬升（js/ridepet/ridepet-type.js，读模型 index.html 的 ridepetMeta，异步）：
    //   stand=站立型（人物站骑宠上，播普通 stand/walk，武器保留——用户明确「要显示出人物武器」）；
    //   ride=乘骑型（人物播 ride 帧，武器隐藏）。
    // ★ 每次上骑清缓存：模型配置改后「下骑再上骑」即生效，不必刷新页面。
    // ★ 一次性 await 读回，缓存到 this._rideType/_rideStandLift；_standLiftPx 热路径只读内存。
    invalidateRidepetTypeCache();
    this._rideType = await getRidepetType(rpId);
    this._rideStandLift = await getRidepetLift(rpId);
    this._applyRideHide();          // 隐藏武器层（仅乘骑型；站立型武器保留）
    // ★ 强制重播人物动作：base/dir/scale 全未变，act 的 early-return 会跳过，
    //   不强制则人物要等下次走路才切到 standRBride（用户反馈"点上下骑动画不立即切换"）。
    //   骑宠两层也在 act 内一并挂上（_playRideLayers），无需在此重复播。
    const base = (this._current && this._current.base) || ACTION.STAND;
    await this.act(base, this.dir, { force: true });
    return true;
  }

  // 下骑：移除骑宠两层，人物回到普通动作
  dismount() {
    this._riding = false;
    this.clearLayerPrefix('ridepet:');
    this._applyRideHide();          // 恢复武器层显示
    // 重播当前动作（恢复非 ride 版本的人物动画；force 同上）
    const base = (this._current && this._current.base) || ACTION.STAND;
    this.act(base, this.dir, { force: true });
  }

  // 乘骑状态切换时，按层标记 rideHide 显隐（武器层乘骑时隐藏，翅膀/法宝/如意不受影响）
  // ★ 判定用「视觉骑乘」= _riding && _rideVisible：进战 setRideVisible(false) 时人物虽保留骑乘状态，
  //   但视觉上已下马，武器层要恢复显示。
  // ★ 站立型骑宠（_rideType==='stand'）武器始终保留（用户明确要求：人物站在骑宠上时要显示武器）。
  _applyRideHide() {
    if (!this.layers) return;
    const hide = !!(this._riding && this._rideVisible) && this._rideType !== 'stand';
    for (const key of Object.keys(this.layers)) {
      const L = this.layers[key];
      if (L && L.rideHide && L.el) L.el.style.display = hide ? 'none' : '';
    }
  }

  isRiding() { return !!this._riding; }
  getRidepetId() { return this._ridepetId || null; }
  getRideType() { return this._rideType; }

  // 游戏内面板切换「乘骑态/站立态」后调用：重读当前骑宠的显示类型并立即应用
  // （_rideType 决定 act 是否播 ride 帧、_applyRideHide 是否隐藏武器），并强制重播当前动作。
  // ⚠ 需在骑乘中调用；未上骑时下次 mountRide 会自动读新类型。
  async applyRideType() {
    if (!this._riding || !this._ridepetId) return;
    this._rideType = await getRidepetType(this._ridepetId);
    this._rideStandLift = await getRidepetLift(this._ridepetId);
    this._applyRideHide();
    const base = (this._current && this._current.base) || ACTION.STAND;
    this.act(base, this.dir, { force: true });
  }

  // 切换角色模型（骑宠面板「角色ID」用）。
  // ★ 必须清 _anchorMap：它按 pool@scale 缓存脚点锚点，跨模型共用同一 pool 下标会取到别人的脚点 → 错位。
  //   _current 置空绕过 act 的 early-return（base/dir 未变时会跳过重播）。
  setCharId(charId) {
    const base = (this._current && this._current.base) || ACTION.STAND;
    this.charId = String(charId);
    this._anchorMap = null;
    this._anchor = null;
    this._anchorScale = null;
    this._shownForCharId = null;
    this._current = null;   // 绕过 act 的 early-return（base/dir 未变会跳过重播）
    this.act(base, this.dir);
  }

  // 骑宠两层显隐（不改变骑乘状态）：进战隐藏、回城恢复。对已挂的层立即生效，之后 _playRideLayers 也尊重它。
  setRideVisible(v) {
    this._rideVisible = !!v;
    if (!this.layers) return;
    for (const key of ['ridepet:bg', 'ridepet:fg']) {
      const L = this.layers[key];
      if (L && L.el) L.el.style.display = this._rideVisible ? '' : 'none';
    }
    this._applyRideHide();   // 进战下马时武器层恢复；回城重新上马时再隐藏
  }

  // 挂/更骑宠两层（bg 在身后、fg 在身前），同步当前动作与朝向
  async _playRideLayers(base) {
    if (!this._riding || !this._ridepetId) return;
    const rpId = this._ridepetId;
    const dir = this._renderDir || this.dir;
    const scale = (this.battleScale != null) ? this.battleScale : 1;
    const loop = !(this._current && this._current.loop === false);
    // bg 层（骑手身后）：先建/更新层定义，再播放
    for (const layer of ['bg', 'fg']) {
      const key = 'ridepet:' + layer;
      if (!this.layers[key]) {
        const el = document.createElement('div');
        el.className = 'fighter-doll-layer fighter-ridepet-' + layer;
        el.style.position = 'absolute';
        el.style.left = '0px'; el.style.top = '0px';
        el.style.width = '0'; el.style.height = '0';
        el.style.pointerEvents = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'fighter-doll-canvas';
        el.appendChild(wrap);
        (this._bodyWrap || this.el).appendChild(el);
        this.layers[key] = { charId: rpId, el, wrap, z: layer === 'bg' ? 0 : 9, dx: 0, dy: 0, ridepetLayer: true };
      } else {
        this.layers[key].charId = rpId;
      }
      this.layers[key].el.style.zIndex = String(this.layers[key].z);
      this.layers[key].el.style.display = this._rideVisible ? '' : 'none';
      const r = await playRideLayer(this.layers[key].wrap, rpId, base, dir, layer, { loop, scale });
      if (r) this._anchorLayerCanvas(key, r, scale);
      else { try { clearContainer(this.layers[key].wrap); } catch (e) {} }   // 该方向无此层：清残留
    }
  }

  // ── 属性派生（对齐 attrs.derive）：主属性 → 全部战斗属性 ──
  // 装备/强化在其上叠加（调用 applyEquip）。hp/mp 按当前比例保留，避免编辑属性时血蓝重置。
  // 把主属性回退到「洁净派生基准」：减掉上一轮叠加在其上的装备加成(_equipPrimAdd)与被动加成(_passivePrimAdd)。
  //   ★ 运行期组成：primary = _basePrim + _equipPrimAdd + _passivePrimAdd（_reapplyPassives 叠加后 _primDirty=true）。
  //   ★ 只有 _primDirty 时才回退。直接把主属性覆写为洁净值的调用方（applyPlayerAttrs / setPrimary）
  //     必须置 _primDirty=false，否则重复扣减会使主属性逐轮漂移（曾导致耐力越打越负）。
  _stripPrimLayers() {
    if (!this._primDirty) return;
    for (const k of ['stamina', 'intellect', 'strength', 'agility', 'faith']) {
      this[k] = (this[k] || 0)
        - (Number((this._equipPrimAdd || {})[k]) || 0)
        - (Number((this._passivePrimAdd || {})[k]) || 0);
    }
    this._primDirty = false;
  }

  applyDerived() {
    if (typeof _deriveAttrs !== 'function') return this.applyEquip();
    // ★ 回退上一轮被动加成到主属性，使派生输入洁净（被动公式不会对已加成的主属性重复乘算）
    this._stripPrimLayers();
    // ★ 主属性派生基准（被动加成层的求值/回退基准，applyDerived 时主属性必为洁净值）
    this._basePrim = { stamina: this.stamina, intellect: this.intellect, strength: this.strength,
      agility: this.agility, faith: this.faith };
    const d = _deriveAttrs({
      stamina: this.stamina, intellect: this.intellect, strength: this.strength,
      agility: this.agility, faith: this.faith,
      crit: (this._srcCrit != null ? this._srcCrit : this.crit),   // ★ 基础值，不含装备暴击（见构造器 _srcCrit 注释）
      toughness: this.toughness
    }, this.level, this.profession);   // combatType=职业：命中/闪避/暴击按 combat 表（侠客/刺客/术士/修真…）
    // 记录穿戴前的派生基础（applyEquip 在其上叠加装备）
    this._baseAtk = d.atk; this._baseDef = d.def;
    this._baseMag = d.mag; this._baseMagDef = d.magDef; this._baseSpd = d.spd;
    this._baseMaxHp = d.maxHp; this._baseMaxMp = d.maxMp; this._baseCrit = d.crit;
    // 当前 hp/mp 比例保留
    const hpR = this.maxHp ? this.hp / this.maxHp : 1;
    const mpR = this.maxMp ? this.mp / this.maxMp : 1;
    this.maxHp = d.maxHp; this.maxMp = d.maxMp;
    this.hp = _rint(this.maxHp * hpR); this.mp = _rint(this.maxMp * mpR);
    this.atk = d.atk; this.def = d.def; this.mag = d.mag; this.magDef = d.magDef; this.spd = d.spd;
    this.phyHit = d.phyHit; this.magHit = d.magHit;
    this.phyDodge = d.phyDodge; this.magDodge = d.magDodge;
    this.phyCrit = d.phyCrit; this.magCrit = d.magCrit;
    this.toughness = d.toughness; this.recover = d.recover; this.xiuwei = d.xiuwei; this.rageMax = d.rageMax;
    this.crit = d.crit;
    this.applyEquip();                       // 装备/强化叠加
    if (this.hp > this.maxHp) this.hp = this.maxHp;
    if (this.mp > this.maxMp) this.mp = this.maxMp;
    if (this.rage > this.rageMax) this.rage = this.rageMax;
    this.updateBar();
    return d;
  }
  // 重算（编辑属性后调用）
  recompute() { return this.applyDerived(); }
  // 设定等级并重算（等级影响成长与上限）
  setLevel(L) { this.level = Math.max(1, L | 0); return this.applyDerived(); }
  // 设定单项主属性并重算（clamp 到潜力规则单项上限）
  setPrimary(key, val) {
    val = Math.max(0, val | 0);
    if (key === 'stamina' || key === 'intellect' || key === 'strength' || key === 'agility' || key === 'faith') {
      this._stripPrimLayers();   // 其余四项仍带着上一轮的装备/被动加成，先回退再覆写本项
      this[key] = val;
    }
    return this.applyDerived();
  }

  // ── Buff/状态运行期（对齐 Buff/状态编辑器）──
  // 按 id 从 Config.data.buffs 取定义并挂载；buff def 的 atkPct/defPct/dot/heal 真实影响战斗。
  applyBuff(buffId, stack = 1) {
    const def = Config.data && Config.data.buffs && Config.data.buffs[buffId];
    if (!def) return false;
    return this.addBuff(def, stack);
  }
  addBuff(def, stack = 1, data = null, opts = null) {
    if (!def || !def.id) return false;
    // 防御性默认：buff 实例 data 永远为对象（至少 {}），避免 onDamaged/redirectTarget 等读取
    // buff.data.xxx 时因 data===null 触发空指针崩溃（编辑器/结构化 buff 经 applyBuffSpecs 施加时
    // 往往没有 data 负载，如穿心蚀骨/嘲讽/同生共死/昊天罡气；缺失字段按 undefined 处理，不崩）。
    const safeData = (data != null) ? data : {};
    const ex = this.buffs.find(b => b.def.id === def.id && !(def.kind === 'statbuff' || def.kind === 'link' || def.kind === 'chuanxin' || def.kind === 'taunt'));
    if (ex) {
      ex.stack = Math.min((ex.stack || 1) + stack, 9);
      ex.turnsLeft = Math.max(ex.turnsLeft, def.duration || 1);
      if (data !== null) ex.data = safeData;
    } else {
      const b = { def, stack: stack || 1, turnsLeft: (def.permanent ? 99 : def.duration) || 1, data: safeData,
        _passive: !!(opts && opts.passive) };   // ★ 被动技能挂的永久 buff：clearBuffs 保留、重挂时识别
      this.buffs.push(b);
      // 状态动画：命中 STATUS_ANIM 映射的 kind 时，在模型头顶上方启动对应持续动画（合并堆叠不重启）
      if (def.kind && STATUS_ANIM[def.kind]) this._startStatusAnim(b);
    }
    if (def.statAdd) this._applyStatAdd(def.statAdd);   // 即时叠加属性加成（圣灵/暗影魔咒/恸地等）
    this._refreshBuffIcons();
    return true;
  }
  // 攻击加成%（含堆叠层数）：被 _calcDamage 用于放大进攻侧伤害
  buffAtkPct() { return this.buffs.reduce((s, b) => s + ((b.def.atkPct || 0) * b.stack), 0); }
  // 防御加成%（含堆叠层数）：被 _calcDamage 用于放大防御侧减免基数
  buffDefPct() { return this.buffs.reduce((s, b) => s + ((b.def.defPct || 0) * b.stack), 0); }
  // 即时叠加/回退属性加成（statbuff 类 buff 在 addBuff 时叠加、过期时回退）
  // 即时叠加/回退属性加成（statbuff 类 buff 在 addBuff 时叠加、过期时回退）
  //   全属性口径（宠物天赋属性被动）：二级属性 atk/def/mag/magDef/spd + 上限 maxHp/maxMp +
  //     命中/闪避/暴击（物/法）+ 寿命上限 + 五大主属性（耐力/智力/强壮/敏捷/信仰）
  _applyStatAdd(s, sign = 1) {
    // ★ 加成值一律四舍五入为整数后再叠加（属性口径：展示与计算都不许出现浮点）
    const R = (v) => _rint(v);
    if (s.atk) this.atk += sign * R(s.atk);
    if (s.def) this.def += sign * R(s.def);
    if (s.mag) this.mag += sign * R(s.mag);
    if (s.magDef) this.magDef += sign * R(s.magDef);
    if (s.spd) this.spd += sign * R(s.spd);
    if (s.recover) this.recover = (this.recover || 0) + sign * R(s.recover);
    if (s.maxHp) {
      const add = R(s.maxHp);
      this.maxHp = Math.max(1, this.maxHp + sign * add);
      if (sign > 0) this.hp = Math.min(this.maxHp, this.hp + add);   // 上限上升时当前血量同步抬高
      else this.hp = Math.min(this.hp, this.maxHp);
    }
    if (s.maxMp) {
      const add = R(s.maxMp);
      this.maxMp = Math.max(0, this.maxMp + sign * add);
      if (sign > 0) this.mp = Math.min(this.maxMp, this.mp + add);
      else this.mp = Math.min(this.mp, this.maxMp);
    }
    if (s.phyHit) this.phyHit += sign * R(s.phyHit);
    if (s.magHit) this.magHit += sign * R(s.magHit);
    if (s.phyDodge) this.phyDodge += sign * R(s.phyDodge);
    if (s.magDodge) this.magDodge += sign * R(s.magDodge);
    if (s.phyCrit) this.phyCrit += sign * R(s.phyCrit);
    if (s.magCrit) this.magCrit += sign * R(s.magCrit);
    if (s.lifeMax) this.lifeMax = Math.max(0, this.lifeMax + sign * R(s.lifeMax));
    // 五大主属性（人物自由属性点 / 宠物天赋的 智力·耐力·强壮·敏捷·信仰）
    for (const k of ['stamina', 'intellect', 'strength', 'agility', 'faith']) {
      if (s[k]) this[k] = (this[k] || 0) + sign * R(s[k]);
    }
    if (this.updateBar) this.updateBar();
  }
  // 技能等级：优先取该技能逐技能习得等级(skillLevels[skillId])；缺省回退单位等级
  // （单机版进度可写 skillLevels 实现"技能有等级、动画随等级变化"；11级扩展依赖此值）
  skillLevel(skillId) {
    if (skillId != null && this.skillLevels && this.skillLevels[skillId] != null) return this.skillLevels[skillId];
    return this.level || 1;
  }
  hasBuffKind(k) { return this.buffs.some(b => b.def.kind === k); }
  getBuff(k) { return this.buffs.find(b => b.def.kind === k) || null; }
  removeBuffKind(k) {
    const removed = this.buffs.filter(b => b.def.kind === k);
    removed.forEach(b => this._stopStatusAnim(b));   // 主动移除某类状态时停掉对应动画
    this.buffs = this.buffs.filter(b => b.def.kind !== k);
    this._refreshBuffIcons();
  }
  // 回合开始结算：中毒/灼烧/飞花溅玉掉血、回血、穿心蚀骨消失爆发；过期状态移除并回退 statAdd。
  // scene 可选：提供飘字/日志上下文（穿心消失爆发需写入 scene 飘字）。
  // onExpire 可选：**在移除该 buff 之前**回调 (fig, buff, reason) —— 供上层派发 BUFF_EXPIRE。
  //   ★ 必须在 splice 之前调用：触发器挂在这个 buff 自己身上，移除后事件总线就找不到监听者了。
  tickBuffs(scene, onExpire) {
    const ev = { dot: 0, heal: 0, floats: [], expired: [] };
    // 回合开始施加：上一回合通过"添加时机=turnStart"挂起的 buff（结构化 buff 应用器写入）
    if (this._pendingTurnStartBuffs && this._pendingTurnStartBuffs.length) {
      for (const p of this._pendingTurnStartBuffs) this.addBuff(p.def, p.stack || 1, p.data || null);
      this._pendingTurnStartBuffs = [];
    }
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i];
      if (b._expire) { // 被受击提前清除（昏睡苏醒/破盾）
        if (b.def.statAdd) this._applyStatAdd(b.def.statAdd, -1);
        this._stopStatusAnim(b);          // 停止并移除对应的状态动画（fanvas.pause 停 Timer）
        // ★ 阶段3：记录被清除的 buff，供上层派发 BUFF_EXPIRE（为"到期爆发"类机制提供标准触发源）
        ev.expired.push({ id: b.def.id, name: b.def.name, kind: b.def.kind, data: b.data, reason: 'cleared', fig: this });
        if (onExpire) { try { onExpire(this, b, 'cleared'); } catch (e) {} }   // ★ 移除前回调（触发器此时仍存在）
        this.buffs.splice(i, 1); continue;
      }
      if (b.def.kind === 'feihua') { // 飞花溅玉：本回合/下回合计2倍/下下回合计4倍
        const mult = (b.data.mults || [1, 1, 1])[Math.min(b.data.tick || 0, (b.data.mults || [1]).length - 1)];
        const d = Math.max(1, _rint((b.data.dotBase || 0) * mult));
        this.hp = Math.max(0, this.hp - d); ev.dot += d; ev.floats.push({ text: '-' + d, color: '#9cff7a' });
        b.data.tick = (b.data.tick || 0) + 1;
      } else if (b.def.dot || (b.data && b.data.dot > 0)) {
        // ★ 修复：模板把"按施法者物攻算出的毒伤"写在 data.dot（如千蛛万毒手），而旧实现只读 def.dot（模板里写的 0）
        //   → 中毒 buff 挂了却不掉血。现优先用 data.dot，回退 def.dot（静态表 buffs.json 的 dot 仍生效）。
        const dotSrc = (b.data && b.data.dot > 0) ? b.data.dot : b.def.dot;
        const d = Math.max(1, _rint(dotSrc * b.stack));
        this.hp = Math.max(0, this.hp - d); ev.dot += d; ev.floats.push({ text: '-' + d, color: '#9cff7a' });
      }
      if (b.def.heal) { const h = Math.max(1, _rint(b.def.heal * b.stack)); this.heal(h); ev.heal += h; ev.floats.push({ text: '+' + h, color: '#7CFC9B' }); }
      if (b.def.floatText) ev.floats.push({ text: b.def.floatText, color: '#cfe8ff' });
      if (b.def.permanent) b.turnsLeft = 99; else b.turnsLeft -= 1;   // 永久被动 buff 不随回合过期
      if (b.turnsLeft <= 0) {
        // 穿心蚀骨：debuff 消失时造成 0.5×当前池余量 + (0.725+0.025×L)×基础 固定伤害（仅消失一次，非每回合）
        // ★ 阶段3 双轨：已配置 triggers 的 chuanxin 由 BUFF_EXPIRE 触发器接管，此处跳过旧分支
        const cxMigrated = !!(b.def.triggers && b.def.triggers.length);
        if (b.def.kind === 'chuanxin' && !cxMigrated && b.data && scene) {
          const burst = 0.5 * (b.data.pool || 0) + (b.data.extra2 || 0);
          if (burst > 0) {
            this.hp = Math.max(0, this.hp - _rint(burst));
            ev.dot += _rint(burst);
            ev.floats.push({ text: '-' + _rint(burst), color: '#ff6b6b' });
            if (scene._floatNum) scene._floatNum(this, '穿心爆发 -' + _rint(burst), '#ff6b6b');
          }
        }
        if (b.def.statAdd) this._applyStatAdd(b.def.statAdd, -1);
        this._stopStatusAnim(b);          // 状态到期：停止并移除对应动画（fanvas.pause 停 Timer + 移除 canvas）
        // ★ 阶段3：记录自然到期的 buff，供上层派发 BUFF_EXPIRE
        ev.expired.push({ id: b.def.id, name: b.def.name, kind: b.def.kind, data: b.data, reason: 'expired', fig: this });
        if (onExpire) { try { onExpire(this, b, 'expired'); } catch (e) {} }   // ★ 移除前回调（触发器此时仍存在）
        this.buffs.splice(i, 1);
      }
    }
    this.updateBar();
    this._refreshBuffIcons();
    return ev;
  }
  hasBuffType(t) { return this.buffs.some(b => b.def.kind === t || (b.def.immune || []).includes(t)); }

  updateBar() {
    if (!this.hpFill) return;          // 构造期 DOM 尚未建立时（applyDerived 早于血条 DOM 创建）安全跳过
    // 对齐 AS3 Fighter.updateHpbar：遮罩宽 = 填充图宽 × (hp/max)；此处用裁剪容器宽度实现
    const pct = this.maxHp ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
    this.hpFill.style.width = (HPBAR.fill.w * pct) + 'px';
  }

  // 死亡/退场时清空所有 buff：停状态动画（防 Timer 泄漏）、清空 buff 数组、重置侠义之心、刷新图标栏
  clearBuffs() {
    // ★ 被动技能的永久 buff 保留：其属性加成由 applyEquip 的派生层统一管理，
    //   战斗结束不清掉 ⇒ 回城后属性不回退、再次进战不会「突然跳变」。
    //   池复用的敌人/宠物由 reapplyPassiveBuffs（会回退旧加成）在生成时重挂。
    const kept = [];
    (this.buffs || []).forEach(b => {
      if (b._passive) { kept.push(b); return; }
      this._stopStatusAnim(b);                       // 停状态动画（fanvas.pause 防 Timer 泄漏）
      if (b.def && b.def.statAdd) this._applyStatAdd(b.def.statAdd, -1);  // 回退属性加成，避免永久残留
    });
    this.buffs = kept;
    this.valor = 0;
    // ★ 被动 buff 仍在身上 ⇒ 幂等标志保持 true（_startBattleLoop 的 applyPassiveBuffs 不会重复挂）。
    //   非被动 buff 已清空，死亡/池复用场景若需要重挂被动走 reapplyPassiveBuffs。
    if (this._refreshBuffIcons) this._refreshBuffIcons();
  }

  destroy() {
    this._cancelDeathFx();   // 作废仍在飞行的阵亡演出回调（防销毁后回调再碰 DOM/坐标）
    this._cancelReveal();    // ★ 取消名字/血条显隐定时器，避免销毁后误显或孤儿回读
    // 停止所有仍在播放的状态动画（fanvas.pause 停 Timer，避免泄漏），再清模型层
    this.buffs.forEach(b => this._stopStatusAnim(b));
    if (this._buffBar) { this._buffBar.innerHTML = ''; }
    if (this._fanvasCanvas && this._fanvasCanvas.isConnected) { try { window.fanvas && window.fanvas.pause(this._fanvasCanvas); } catch (e) {} }
    clearContainer(this.canvasWrap);
    this.clearLayers();   // 纸娃娃层一并销毁（fanvas.pause 停 Timer + 移除 DOM，防泄漏）
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    if (Fighter._instances) Fighter._instances.delete(this);
  }
}

// ── 对齐原点标记全局开关 ──
// ★ 默认【不显示】（user 2026-10-01：「游戏里每个模型都有一个十字锚点显示，把它改成默认不显示，
//   然后在设置里进行开关」）。显示途径有二，任一为真即开：
//   ① 设置面板「通用设置 → 模型锚点」开关（写 ui._settings.showOrigin，存档跟随完整档落盘）；
//   ② 调试用 URL 参数 ?origin=1 强制开启（优先级最高，覆盖存档设置）。
//   window.toggleOrigin() 可运行时切换所有模型原点标记的显隐（setShowOrigin 幂等，可重复下发）。
Fighter._instances = new Set();
Fighter._originOn = (typeof location !== 'undefined') ? /[?&]origin=1/.test(location.search) : false;
Fighter.setShowOrigin = function (on) {
  Fighter._originOn = !!on;
  Fighter._instances.forEach(f => { if (f.originEl) f.originEl.style.display = Fighter._originOn ? 'block' : 'none'; });
};
if (typeof window !== 'undefined') {
  window.toggleOrigin = (force) => { Fighter.setShowOrigin(force != null ? force : !Fighter._originOn); return Fighter._originOn; };
}





