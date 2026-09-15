// battle-number.js
// ─────────────────────────────────────────────────────────────────────────
// 战斗飘字与血条的图片资源与构建。
//
// 严格对齐 AS3 原版三处实现：
//   1) animate/battle/BattleInitializer14.as
//      - 0ms：若 changeHp/changeMp/changeSp != 0 则各飘一个数字，并交给 ANIMATE_MOVE 上浮
//      - 上浮距离/时长按类型有序：HP -110px/(950+200)ms、MP -75px/(950+100)ms、SP -40px/950ms
//      - 100ms 刷新血蓝条、500ms 处理状态表现
//      - getNumSprite：x = fighter.x - width/2（横向居中）；
//        y = 数字高 × 同类型已有个数 + fighter.y - fighter.mcHeight - 数字高
//          = 头顶 + (n-1)×数字高 → 同类数字依次【向下】错开一行，互相不重叠
//   2) util/UtilUpdater02.as updateHpMpSpNumber
//      - 用 battle{hp|mp|sp}_{数字} 图片逐位拼接；负数前置 nega、正数前置 plus
//      - 资源 key 去掉下划线即 PNG 文件名：battle_hp_0 → battlehp0.png
//      - 暴击(RESULT_BAOJI)时整体 setSacle(1.3, 1.3)
//      - 注意：原版 value==0 时不加符号但仍拼出数字 "0"；本移植按需求改为【0 值完全不显示】
//   3) characters/Fighter.as initHpbar / updateHpbar
//      - 血条框 battle_hpbar → battlehpbar.png(45×9)
//      - 血条底/填充 battle_hp → battlehp.png(37×3)，在框内偏移 (4,3)
//      - 按比例遮罩：遮罩宽 = 填充图宽 × (hp/max)，其余部分不显示
//
// 资源实测尺寸（update/i18n/zh_CN/Resource1/icons/）：
//   hp 数字 21×30、hp 符号 26×30 ｜ mp/sp 数字 19×30、mp/sp 符号 24×30
//   battlehp.png 37×3（填充） ｜ battlehpbar.png 45×9（框）

import { url } from './globals.js?v=20261007c';

// 数值类型（与 AS3 GlobalsGlobal08.HP/MP/SP 对应）
// ★ SP = 怒气/真气飘字资源（battlesp0.png 等数字图）；RAGE 仅作语义别名（无独立资源，rage 实际复用 SP 数字图）。
export const NUM_TYPE = { HP: 'hp', MP: 'mp', SP: 'sp', RAGE: 'sp' };

// 上浮距离(px) 与 时长(ms)：AS3 ANIMATE_MOVE 目标 (x, y-rise)，时长 spDuration(+200/+100/+0)
export const FLOAT_RISE = { hp: 110, mp: 75, rage: 40 };
export const FLOAT_DUR = { hp: 1150, mp: 1050, rage: 950 };

// 实测尺寸作为未加载完成时的兜底度量，保证布局从第一帧起就确定
const DEFAULT_METRICS = {
  hp: { digit: { w: 21, h: 30 }, sign: { w: 26, h: 30 } },
  mp: { digit: { w: 19, h: 30 }, sign: { w: 24, h: 30 } },
  rage: { digit: { w: 19, h: 30 }, sign: { w: 24, h: 30 } },
};

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 数字图片 URL：battle{hp|mp|sp}{key}.png（key 为数字字符或 nega/plus） */
export function battleNumSrc(type, key) {
  return url.res1('battle' + type + key + '.png');
}

// 预加载后的真实尺寸缓存：`${type}${key}` -> {w,h}
const METRICS = {};

/**
 * 预加载全部数字图片并记录自然尺寸（30 张小图，几乎瞬时完成）。
 * 未调用也可正常使用——未命中时回退 DEFAULT_METRICS。
 */
export function preloadBattleNumbers() {
  for (const type of [NUM_TYPE.HP, NUM_TYPE.MP, NUM_TYPE.SP]) {
    const keys = DIGITS.concat(['nega', 'plus']);
    for (const key of keys) {
      const im = new Image();
      im.onload = () => { METRICS[type + key] = { w: im.naturalWidth, h: im.naturalHeight }; };
      im.onerror = () => { /* 缺失时保持回退度量 */ };
      im.src = battleNumSrc(type, key);
    }
  }
}

// 取单张图片度量（优先预加载实测值）
function metrics(type, key) {
  const m = METRICS[type + key];
  if (m && m.w > 0 && m.h > 0) return m;
  const d = DEFAULT_METRICS[type] || DEFAULT_METRICS.hp;
  return (key === 'nega' || key === 'plus') ? d.sign : d.digit;
}

/**
 * 构建一段"数值飘字"精灵（AS3 updateHpMpSpNumber 的 DOM 版）。
 * @param {string} type  'hp' | 'mp' | 'rage'
 * @param {number} value 变化量（负=减少、正=增加）；为 0（含取整后为 0）时返回 null → 不显示
 * @param {{crit?:boolean}} opts  crit=true 时整体放大 1.3（AS3 RESULT_BAOJI）
 * @returns {HTMLElement|null} 已拼好数字图片的容器；附带 _numW/_numH 度量
 */
export function buildNumberSprite(type, value, opts = {}) {
  const v = Math.round(value || 0);
  if (!v) return null;                                  // ★0 伤害/0 恢复：完全不显示

  const t = (type === NUM_TYPE.MP || type === NUM_TYPE.SP) ? type : NUM_TYPE.HP;
  const parts = [v < 0 ? 'nega' : 'plus'];              // 负号/正号图
  for (const ch of String(Math.abs(v))) parts.push(ch); // 逐位数字图

  const el = document.createElement('div');
  el.className = 'battle-num' + (opts.crit ? ' battle-num-crit' : '');
  let w = 0, h = 0;
  for (const key of parts) {
    const m = metrics(t, key);
    const im = document.createElement('img');
    im.className = 'battle-num-img';
    im.src = battleNumSrc(t, key);
    im.width = m.w; im.height = m.h;
    im.style.width = m.w + 'px';
    im.style.height = m.h + 'px';
    im.draggable = false;
    el.appendChild(im);
    w += m.w;
    if (m.h > h) h = m.h;
  }
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el._numW = w;
  el._numH = h;
  return el;
}

// ── 血条图片（AS3 Fighter.initHpbar）─────────────────────────────────────
// 框 battlehpbar.png(45×9)；填充 battlehp.png(37×3) 偏移 (4,3)，按 hp/max 裁剪宽度
export const HPBAR = {
  frame: { src: url.res1('battlehpbar.png'), w: 45, h: 9 },
  fill: { src: url.res1('battlehp.png'), w: 37, h: 3, ox: 4, oy: 3 },
};

export default { NUM_TYPE, FLOAT_RISE, FLOAT_DUR, battleNumSrc, buildNumberSprite, preloadBattleNumbers, HPBAR };
