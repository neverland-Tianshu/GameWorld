// panel-pet.js
// 宠物主面板 —— 1:1 对齐 AS3（渲染数据由复现管线直出，不再手抄坐标）
//   AS3 源：deobfuscated/panel/property/PetPanel.as（extends MallPanel）
//   结构：宠物列表(List) + 左 9 / 右 6 属性 + 底部 5 项（类型/修为/变异/进化/评定）+
//         法术组合框(5 系) + 9 个操作按钮 + 加点 +/- + 宠物形象(headerSprite) +
//         状态图标(stateSprite) + 携带数/经验输入
//
// ★ 布局真源：js/ui/petpanel-as3.js（AUTO-GENERATED，由 _verify/extract_petpanel_as3.mjs
//   直接抓取 _composite/PetPanel.html 的 1:1 DOM 烘焙绝对坐标）
//   舞台 = PetPanel.rect (295×500)；PetPanel 为「嵌套堆叠」面板（无 TabView 分页）。
//   本文件只补「运行时动态元素」的坐标，真源 = 原版 layout.xml（经 D:/tsqt/Game/update/i18n/zh_CN/layout.xml 核对）：
//     PetPanel_leftPro  (15,205)   PetPanel_rightPro (155,205)   PetPanel_magicProp (153,373)
//     PetPanel_state   (20,50)     PetPanel_countInput(101,151,w124)  PetPanel_expInput(-49,465,w275)
//     PetPanel_addBtn x+96 / PetPanel_minusBtn x+111（相对 _x=_leftPro.x 或 _rightPro.x）
//
// ★ 数据真源（三层，用户裁决 2026-09-17）：
//   config/pets.json（op572 原型表） → js/pet/pet-state.js（实例层） → 本面板（pet() 合并视图）
//   字段名一律 **op572 原生名**：level / carryLevel / petId / growUpRate / maxLevel / closeVal /
//   loyality / life / savvy / strong / vitality / agile / intellect / belief / leftPoint /
//   hpCur / mpCur / speed / restore / attack / defense / phyHit / phyJook / phyBang /
//   magicAttack / magicDef / magicHit / magicJook / magicBang / antiReel... / antiToic / aptUp /
//   outLineType / spiritual / variation / evoLevel / petEvaluate
//
// ★ 显示格式真源：deobfuscated/manager/PropertyManager.as updateAllPetProperty()
//   （cur/max 成对、"(+悟性%)" 着色对齐、变异/未变异、类型名+觉醒态、petId 截断 …）
//   属性 id 常量真源：deobfuscated/globals/GlobalsGlobal05.as
//   文案真源：update/i18n/zh_CN/Lang/zh_CN.as + deobfuscated/globals/GlobalsGlobal06.as
//
// ⚠ 不触碰战斗系统。
// ⚠ 不臆造：原型/实例都没有的字段（如 evoLevel / petEvaluate / 携带数上限 petMax）一律 '—'。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { url } from '../core/globals.js?v=20261007c';
import { pet, DASH } from '../pet/pet.js?v=20261007c';
import { petState, MAX_DEPLOYED } from '../pet/pet-state.js?v=20261007c';
import { petAdvance } from '../pet/pet-advance.js?v=20261007c';
import { PET_STAGE, PET_PANE, PET_PAGES } from './petpanel-as3.js?v=20261007c';
import { PP_TOP_HIDE } from './panel-player.js?v=20261007c';
import { Fighter } from '../entities/fighter.js?v=20261007c';
import { sumPassiveStatAdd } from '../skill/skill-engine.js?v=20261007c';   // 被动属性加成（战斗外面板与战斗内同一口径）

// 宠物形象展示锚点：对齐 AS3 PetPanel_header(76,140)（headerSprite 容器原点，addChild(mc) 无偏移）。
// 引擎已修正单 Role 宠物脚点推断（resolveFoot 盲推 (0,0) / 部分模型落点偏移），故直接把锚点 pin 到 (76,140)
// 即与 AS3 对齐，不再需要面板侧「内容中心包围盒补偿」（那是为绕过引擎 bug 的临时 workaround，现已回退）。
const PET_PORTRAIT = { x: 76, y: 140 };

// 状态图标容器原点 = layout PetPanel_state(20,50)；子图标偏移 = UtilUpdater02 里的 getResourceImgXY。
const STATE_ORIGIN = { x: 20, y: 50 };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HEX = (c) => '#' + ('000000' + ((Number(c) | 0) >>> 0).toString(16)).slice(-6);
const IMG = (k) => url.res(String(k).replace(/_/g, '').toLowerCase() + '.png');

// ═══════════════════ AS3 属性表（源码直录，勿改勿猜） ═══════════════════
//
// PetPanel.initProperty() 的 propArray 顺序（id 名 → GlobalsGlobal05 常量）：
//   [0.. 8] level carryLevel petId growUpRate maxLevel closeVal loyality life savvy   ← setAddProperty(9)              左列
//   [9..14] strong vitality agile intellect belief leftPoint                          ← setAddProperty(6,POINT_PROP)   右列
//   [15..]  hpCur mpCur speed restore | attack defense phyHit phyJook phyBang |
//           magicAttack magicDef magicHit magicJook magicBang |
//           antiReel antiSleep antiDrunck antiChaos | antiSlow antiWeak antiToic | aptUp
//                     ↑ 依次 基础4 / 物理5 / 法术5 / 控制4 / 弱点3 / 无名1（ARM_*，flag=false 先不入显示列表，
//                       由 onComboxChange → layoutProp(list, PetPanel_magicProp(153,373)) 按选中系布局）
const PROP_LEFT = ['level', 'carryLevel', 'petId', 'growUpRate', 'maxLevel', 'closeVal', 'loyality', 'life', 'savvy'];
const PROP_RIGHT = ['strong', 'vitality', 'agile', 'intellect', 'belief', 'leftPoint'];
// 底部 5 项 = propList（addPropertyNew(propList)，ViewPetInfo_prop 起 y=357，行高 22）
const PROP_BOTTOM = ['outLineType', 'spiritual', 'variation', 'evoLevel', 'petEvaluate'];

// 元素表里 ph 占位槽位的实测坐标（顺序与上面的 AS3 渲染顺序 1:1，同一坐标表驱动映射）
const LEFT_XY = [[60, 205], [72, 221], [72, 237], [60, 253], [72, 269], [60, 285], [60, 301], [60, 317], [60, 333]];
const RIGHT_XY = [[200, 205], [200, 221], [200, 237], [200, 253], [200, 269], [200, 284]];
const BOTTOM_XY = [[79, 357], [79, 379], [79, 401], [79, 423], [91, 445]];

const PH_FIELD = {};
LEFT_XY.forEach((xy, i) => { PH_FIELD[xy.join(',')] = PROP_LEFT[i]; });
RIGHT_XY.forEach((xy, i) => { PH_FIELD[xy.join(',')] = PROP_RIGHT[i]; });
BOTTOM_XY.forEach((xy, i) => { PH_FIELD[xy.join(',')] = PROP_BOTTOM[i]; });

// 法术组合框 5 系（PetPanel.initCombox 的 _magicInfo 顺序 + GlobalsGlobal06 文案；默认 selectedIndex=1 → 物理）
const ARM = [
  { key: 'basic', label: '基础属性', props: ['hpCur', 'mpCur', 'speed', 'restore'] },
  { key: 'physic', label: '物理', props: ['attack', 'defense', 'phyHit', 'phyJook', 'phyBang'] },
  { key: 'magic', label: '法术', props: ['magicAttack', 'magicDef', 'magicHit', 'magicJook', 'magicBang'] },
  { key: 'contral', label: '控制抗性', props: ['antiReel', 'antiSleep', 'antiDrunck', 'antiChaos'] },
  { key: 'week', label: '衰弱抗性', props: ['antiSlow', 'antiWeak', 'antiToic'] },
];

// 属性名文案（GlobalsGlobal06 → zh_CN.lang，换行符 U+3000 原样保留）
const ARM_LABEL = {
  hpCur: '生　命:', mpCur: '法　力:', speed: '速　度:', restore: '恢　复:',
  attack: '物理攻击:', defense: '物理防御:', phyHit: '物理命中:', phyJook: '物理闪避:', phyBang: '物理爆击:',
  magicAttack: '法术攻击:', magicDef: '法术防御:', magicHit: '法术命中:', magicJook: '法术闪避:', magicBang: '法术爆击:',
  antiReel: '眩晕抗性:', antiSleep: '睡眠抗性:', antiDrunck: '酒醉抗性:', antiChaos: '混乱抗性:',
  antiSlow: '迟缓抗性:', antiWeak: '弱化抗性:', antiToic: '中毒抗性:',
};

// 类型名（PropertyManager.getMonsterType）+ 觉醒态（getWakeUpState）
const MONSTER_TYPE = { 1: '野兽 ', 2: '人形 ', 3: '精灵 ', 4: '妖怪 ', 5: '神兽 ' };
const VARIATION_BASE = 10;   // GlobalsGlobal08.BASE —— variation >= 10 判「变异」

// UtilUtil.stringAlignLayout 的两个着色常量（源码硬编码）
const C_CUR = '#9E2B0E';
const C_EXT = '#03723D';

// ★ ay：成长率显示为品级文字 + 颜色（对齐抓包的 <font color='#xxxxxx'>品级</font>）。
//   色板真源：deobfuscated/panel/property/pet/advance/ViewEvoluNew.as::getGrowup（1~6 档），
//   本工程 5 档（普通/优秀/杰出/卓越/完美）= AS3 原名原色，超凡档（#FD1901）已废弃。
const GROWTH_COLOR = {
  '普通': '#ffffff',   // AS3 第 1 档
  '优秀': '#00FF00',   // AS3 第 2 档
  '杰出': '#43F8E9',   // AS3 第 3 档
  '卓越': '#CB40F1',   // AS3 第 4 档
  '完美': '#FD5908',   // AS3 第 5 档
};

// ═══════════════════ 取值 / 格式化（对齐 updateAllPetProperty） ═══════════════════

const raw = (p, f) => { const v = p[f]; return v == null || v === '' ? null : v; };
const plain = (v) => (v == null ? null : esc(v));

/**
 * AS3 TextField.htmlText → DOM。映射规则（DOM 与 AS3 必须显式转换，否则走样）：
 *   <font size='12'> → <font style="font-size:12px">（HTML 的 size 属性是 1..7 档位，直传会被当最大号 ⇒ 文字巨大）
 *   <a href='event:...'>…</a> → 剥标签留文本
 */
const rich = (s) => {
  if (s == null || s === '') return null;
  const str = String(s);
  const re = /<a\b[^>]*>|<\/a>|<\/?[ubi]>|<font\b[^>]*>|<\/font>|<br\s*\/?>/gi;
  let out = '', last = 0, m;
  while ((m = re.exec(str))) {
    out += esc(str.slice(last, m.index));
    const tag = m[0];
    if (/^<\/a/i.test(tag)) out += '';
    else if (/^<a\b/i.test(tag)) out += '';
    else if (/^<\/font/i.test(tag)) out += '</font>';
    else if (/^<br/i.test(tag)) out += '<br/>';
    else if (/^<\/?[ubi]>/i.test(tag)) out += tag.toLowerCase();
    else {
      const c = (tag.match(/color\s*=\s*["']?([#\w(),.%\s-]+)["']?/i) || [])[1];
      const z = (tag.match(/size\s*=\s*["']?(\d+)["']?/i) || [])[1];
      out += '<font' + (c ? ` color="${esc(c)}"` : '') + (z ? ` style="font-size:${z}px"` : '') + '>';
    }
    last = re.lastIndex;
  }
  return out + esc(str.slice(last));
};

/** PropertyManager.getPercent(savvy)：悟性 → 加成百分比字符串（分段线性，源码照抄）。 */
function pct(savvy) {
  const v = Number(savvy == null || savvy === '' ? 0 : savvy);
  let p;
  if (v < 15) p = v * 0.5;
  else if (v < 18) p = 7 + (v - 14);
  else if (v < 20) p = 10 + (v - 17) * 1.5;
  else p = 13 + (v - 19) * 2;
  return p + '%';
}

/**
 * UtilUtil.stringAlignLayout(main, extra, width)：主值 #9E2B0E + 补空格 + 附加 #03723D。
 * 空格数：源码 `while(c < width - (main.length+extra.length)) { 加 1 空格; c += 2; }`
 * ⇒ 空格数 = ceil((width − len)/2)。用 &nbsp; 还原同样的视觉间距。
 */
function alignHtml(main, extra, width) {
  const s = String(main), x = String(extra);
  let sp = '';
  for (let c = 0; c < width - (s.length + x.length); c += 2) sp += '&nbsp;';
  return `<font color="${C_CUR}">${esc(s)}</font>${sp}<font color="${C_EXT}">${esc(x)}</font>`;
}

/** 成对「当前/上限」（updateAllPetProperty 里 `dict[id] + "/" + dict[id+1]`，无色无对齐）。 */
function pairPlain(p, f, maxF) {
  const a = raw(p, f);
  if (a == null) return null;
  const b = raw(p, maxF);
  return esc(a) + (b == null ? '/' + DASH : '/' + esc(b));
}

/** 成对 + 悟性百分比对齐（hpCur/mpCur 专用：stringAlignLayout(cur/max, _loc3_, 14)）。 */
function pairAlign(p, f, maxF) {
  const a = raw(p, f), b = raw(p, maxF);
  if (a == null) return null;
  return alignHtml(a + '/' + (b == null ? DASH : b), '(+' + pct(raw(p, 'savvy')) + ')', 14);
}

/** 属性加点项：stringAlignLayout(值, "(+加成)", 8) —— 加成为 strongAdd/vitalityAdd/... */
function addPointHtml(p, f, addF) {
  const v = raw(p, f);
  if (v == null) return null;
  const add = raw(p, addF);
  return alignHtml(v, '(+' + (add == null ? 0 : add) + ')', 8);
}

/** 战斗数值项：stringAlignLayout(值, "(+悟性%)", width) —— attack/defense/speed/restore 等。
 *   ★ ay：悟性缺失/为 0 时不显示 (+0%) 噪音，只显数值。 */
function pctAlign(p, f, width) {
  const v = raw(p, f);
  if (v == null) return null;
  const sv = Number(raw(p, 'savvy')) || 0;
  return sv > 0 ? alignHtml(v, '(+' + pct(sv) + ')', width) : plain(v);
}

// ── 被动技能属性加成（战斗外）：与战斗内 applyPassiveBuffs 同一公式口径 ──
//   被动公式读 fig.xxx（Fighter 字段名），故把 op572 宠物字段映射成 Fighter 字段代理。
//   mapping: attack→atk / defense→def / magicAttack→mag / magicDef→magDef / speed→spd /
//     hpMax→maxHp / mpMax→maxMp / phyBang→phyCrit / phyJook→phyDodge /
//     magicBang→magCrit / magicJook→magDodge / strong→strength / vitality→stamina /
//     agile→agility / intellect→intellect / belief→faith
const PET2FIG = {
  attack: 'atk', defense: 'def', magicAttack: 'mag', magicDef: 'magDef', speed: 'spd',
  hpMax: 'maxHp', mpMax: 'maxMp', phyBang: 'phyCrit', phyJook: 'phyDodge',
  magicBang: 'magCrit', magicJook: 'magDodge',
  strong: 'strength', vitality: 'stamina', agile: 'agility', intellect: 'intellect', belief: 'faith',
};
function petFigProxy(p) {
  const o = { level: Number(raw(p, 'level')) || 1, lifeMax: Number(raw(p, 'lifeMax')) || 0 };
  for (const k in PET2FIG) {
    const v = raw(p, k);
    o[PET2FIG[k]] = v == null ? 0 : (Number(v) || 0);
  }
  return o;
}
// 被动加成汇总（render() 算一次挂在视图上供 VALUE 各项读取；异常时返回空字典不中断渲染）
function passiveBonus(p) {
  if (!p) return {};
  const list = Array.isArray(p.skillList) ? p.skillList : [];
  const sl = (p.skillLevels && typeof p.skillLevels === 'object') ? p.skillLevels : null;
  try { return sumPassiveStatAdd(petFigProxy(p), list, sl); } catch (e) { return {}; }
}
const pbOf = (p, key) => Number(p && p._pb && p._pb[key]) || 0;

// ★ ay（用户裁决）：被动加成直接并入合计数字显示，不再显示 "(+数字)" 后缀。
//   五大主属性：合计 = 基础 + 加点 + 被动，只显示总数。
function pbAddPoint(p, f, addF, pbKey) {
  const v = raw(p, f);
  if (v == null) return null;
  const ap = Number(raw(p, addF)) || 0;
  const b = pbOf(p, pbKey);
  return plain(Math.round(Number(v) + ap + b));
}
/** 战斗数值（攻击/防御/速度…）：合计 = 基础 + 被动；悟性后缀仅在确有悟性时显示。 */
function pbAlign(p, f, pbKey, width) {
  const v = raw(p, f);
  if (v == null) return null;
  const total = Math.round(Number(v) + pbOf(p, pbKey));
  const sv = Number(raw(p, 'savvy')) || 0;
  return sv > 0 ? alignHtml(total, '(+' + pct(sv) + ')', width) : plain(total);
}
/** 命中/闪避/暴击（AS3 原本无后缀）：合计 = 基础 + 被动。 */
function pbPlain(p, f, pbKey) {
  const v = raw(p, f);
  if (v == null) return null;
  return plain(Math.round(Number(v) + pbOf(p, pbKey)));
}
/** 成对 cur/max（生命/法力）：上限计入被动加成。 */
function pbPairAlign(p, f, maxF, pbKey) {
  const a = raw(p, f), b0 = raw(p, maxF);
  if (a == null) return null;
  const b = pbOf(p, pbKey);
  const mx = b0 == null ? DASH : Math.round(Number(b0) + b);
  const sv = Number(raw(p, 'savvy')) || 0;
  return sv > 0 ? alignHtml(a + '/' + mx, '(+' + pct(sv) + ')', 14) : plain(a + '/' + mx);
}
/** 寿命（pairPlain 版）：上限计入「长寿」类被动加成，无后缀。 */
function pbLife(p) {
  const a = raw(p, 'life'), b0 = raw(p, 'lifeMax');
  if (a == null) return null;
  const b = pbOf(p, 'lifeMax');
  return esc(a) + (b0 == null ? '/' + DASH : '/' + esc(Math.round(Number(b0) + b)));
}

/** 悟性（savvy）专用格式：petType==2 只显示数值，否则追「(属性+x%)」。 */
function savvyHtml(p) {
  const v = raw(p, 'savvy');
  if (v == null) return null;
  const head = `<font style="font-size:12px"><font color="${C_CUR}">${esc(v)}</font>`;
  if (Number(raw(p, 'petType')) === 2) return head + '</font>';
  return head + `<font color="${C_EXT}">(属性+${pct(v)})</font></font>`;
}

/** 每字段 → 展示 HTML（null 表示原型/实例都没有 ⇒ 面板填 '—'，不臆造）。 */
const VALUE = {
  // ── 左列（9）：AS3 走 `dict2[id].text = dict[id]` 兜底分支，除 savvy/growUpRate/petId 特例外无格式 ──
  level: (p) => plain(raw(p, 'level')),
  carryLevel: (p) => plain(raw(p, 'carryLevel')),
  // petId：AS3 `if(len > 8) text = slice(0,8) + ".."`
  petId: (p) => {
    const v = raw(p, 'petId');
    if (v == null) return null;
    const s = String(v);
    return esc(s.length > 8 ? s.slice(0, 8) + '..' : s);
  },
  // growUpRate：AS3 htmlText = `"<font size='12'>" + value + "</font>"`，value 是服务端下发的
  //   <font color='#xxxxxx'>品级</font> 彩色串。单机版由 grade（品级）+ GROWTH_COLOR 现拼。
  growUpRate: (p) => {
    const g = raw(p, 'grade');
    if (g && GROWTH_COLOR[g]) {
      return `<font style="font-size:12px"><font color="${GROWTH_COLOR[g]}">${esc(g)}</font></font>`;
    }
    const v = raw(p, 'growUpRate');
    return v == null ? null : `<font style="font-size:12px">${rich(v)}</font>`;
  },
  maxLevel: (p) => plain(raw(p, 'maxLevel')),
  closeVal: (p) => plain(raw(p, 'closeVal')),
  loyality: (p) => pairPlain(p, 'loyality', 'loyalityMax'),
  life: (p) => pbLife(p),
  savvy: (p) => savvyHtml(p),
  // ── 右列（6）──
  strong: (p) => pbAddPoint(p, 'strong', 'strongAdd', 'strength'),
  vitality: (p) => pbAddPoint(p, 'vitality', 'vitalityAdd', 'stamina'),
  agile: (p) => pbAddPoint(p, 'agile', 'agileAdd', 'agility'),
  intellect: (p) => pbAddPoint(p, 'intellect', 'intellectAdd', 'intellect'),
  belief: (p) => pbAddPoint(p, 'belief', 'beliefAdd', 'faith'),
  leftPoint: (p) => plain(raw(p, 'leftPoint')),
  // ── 基础属性（ARM_BASIC，宽 14）──
  hpCur: (p) => pbPairAlign(p, 'hpCur', 'hpMax', 'maxHp'),
  mpCur: (p) => pbPairAlign(p, 'mpCur', 'mpMax', 'maxMp'),
  speed: (p) => pbAlign(p, 'speed', 'spd', 14),
  restore: (p) => pctAlign(p, 'restore', 14),
  // ── 物理（ARM_PHYSIC）──
  attack: (p) => pbAlign(p, 'attack', 'atk', 12),
  defense: (p) => pbAlign(p, 'defense', 'def', 12),
  phyHit: (p) => plain(raw(p, 'phyHit')),
  phyJook: (p) => pbPlain(p, 'phyJook', 'phyDodge'),
  phyBang: (p) => pbPlain(p, 'phyBang', 'phyCrit'),
  // ── 法术（ARM_MAGIC）──
  magicAttack: (p) => pbAlign(p, 'magicAttack', 'mag', 12),
  magicDef: (p) => pbAlign(p, 'magicDef', 'magDef', 12),
  magicHit: (p) => plain(raw(p, 'magicHit')),
  magicJook: (p) => pbPlain(p, 'magicJook', 'magDodge'),
  magicBang: (p) => pbPlain(p, 'magicBang', 'magCrit'),
  // ── 控制抗性（ARM_CONTRAL）──
  antiReel: (p) => plain(raw(p, 'antiReel')),
  antiSleep: (p) => plain(raw(p, 'antiSleep')),
  antiDrunck: (p) => plain(raw(p, 'antiDrunck')),
  antiChaos: (p) => plain(raw(p, 'antiChaos')),
  // ── 衰弱抗性（ARM_WEEK）──
  antiSlow: (p) => plain(raw(p, 'antiSlow')),
  antiWeak: (p) => plain(raw(p, 'antiWeak')),
  antiToic: (p) => plain(raw(p, 'antiToic')),
  // ── 无名称列单项（aptUp）──
  aptUp: (p) => plain(raw(p, 'aptUp')),
  // ── 底部 5 项（propList）──
  outLineType: (p) => {
    const t = raw(p, 'outLineType');
    if (t == null) return null;
    const name = MONSTER_TYPE[Number(t)];
    if (name == null) return null;   // 1~5 之外的码：不臆造
    return esc(name + (Number(raw(p, 'wakeUpState')) === 1 ? '(已觉醒)' : ''));
  },
  spiritual: (p) => pairPlain(p, 'spiritual', 'spiritualMax'),
  variation: (p) => {
    const v = raw(p, 'variation');
    if (v == null) return null;
    return Number(v) >= VARIATION_BASE ? esc('变异 ') : esc('未变异 ');
  },
  evoLevel: (p) => {
    const a = raw(p, 'evoLevel');
    if (a == null) return null;      // pets.json 未覆盖进化字段 → '—'
    const b = raw(p, 'evoMaxLevel');
    return esc(a) + (b == null ? '/' + DASH : '/' + esc(b));
  },
  petEvaluate: (p) => plain(raw(p, 'petEvaluate')),
};

// 12px 字体度量（CJK/全角 = 12，半角 = 6）—— 复刻 AS3 用 textWidth 定位「值」列的口径
const textW = (s, size = 12) => [...String(s == null ? '' : s)]
  .reduce((a, ch) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? size : size / 2), 0);

// 9 操作按钮：标签资源 key → 动作名
const ACT_BTN = {
  textpanelfree: 'free', textpanelrename: 'rename', textpanelfight: 'fight', textpanelrest: 'rest',
  textpanelinfo: 'info', textpaneluseitem: 'useitem', textpanelconfirm2: 'confirm', textpaneltrain: 'train',
  textpanelbtnpetgroup: 'group',
};
// 加点按钮：y 坐标 → 属性（对齐 AS3 addProperty 里 data.id：strong/vitality/agile/intellect/belief）
const ADDPOINT = { 205: '强壮', 221: '耐力', 237: '敏捷', 253: '智力', 269: '信仰' };

export class PetPanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-pet', title: '宠物 / 召唤兽', width: PET_STAGE.w, height: PET_STAGE.h, ui,
      icon: { dir: 'res', file: 'facepetchest.png' },
    });
    this._init();
  }
  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._sys = 'physic';          // 法术组合框默认选中「物理」（对齐 AS3 selectedIndex=1）
    this._showPt = false;          // 加点 +/- 是否可见（AS3 showOrHidePoint：leftPoint > 0 才显示）
    this._phMiss = [];             // 未映射到的 ph 槽位（用于暴露元素表结构变化）
    this._ensureSel();   // bo: init selects the first real (caught) pet; with no real pet the model stays hidden
  }
  get sys() { return pet(); }
  init() { this.render(); }
  onOpen() { this.refresh(); }
  refresh() { this._init(); this.render(); }

  _layer() {
    if (this._pp) return this._pp;
    this.dom.classList.add('pp-asis');
    const d = document.createElement('div');
    d.className = 'pp-layer';
    this.dom.appendChild(d);
    this._pp = d;
    return d;
  }

  // ───────────── 元素绘制 ─────────────
  // AS3 visible=false ≙ CSS display:none（元素仍在显示列表里，只是不可见）——
  // 故加/减点按钮**保留在 DOM**（结构计数与元素表一致），只切 display，不整块剔除。
  _E(e, fill) {
    const hid = (e.k === 'IMG' && (e.r === 'panelbtnadd' || e.r === 'panelbtncut') && !this._showPt) ? ';display:none' : '';
    const st = `left:${e.x}px;top:${e.y}px${hid}`;
    // panelbtnbg4 按钮 → 纯 CSS 橙红拟物皮（.tsqt-btn-orange），整体缩到 90% 居中收缩避免拥挤；
    //   文字标签仍是独立元素（坐标不动），点击绑定不受影响
    if (e.k === 'IMG' && e.r === 'panelbtnbg4') {
      const w = e.w != null ? e.w : 0, h = e.h != null ? e.h : 0;
      const sw = Math.round(w * 0.9), sh = Math.round(h * 0.9);
      const st90 = `left:${e.x + Math.round((w - sw) / 2)}px;top:${e.y + Math.round((h - sh) / 2)}px`;
      return `<button class="pp-e tsqt-bar-btn tsqt-btn-orange" style="${st90};width:${sw}px;height:${sh}px;padding:0"></button>`;
    }
    if (e.k === 'IMG') {
      const wh = (e.w != null ? `;width:${e.w}px` : '') + (e.h != null ? `;height:${e.h}px` : '');
      // ★ 资源图走文档相对路径（url.res / IMG()）：e.r 是游戏资源 key，IMG(e.r) → update/i18n/.../icons/xxx.png，
      //   任意主机（localhost / 局域网 IP / 域名 / GitHub Pages 子路径）都能解析；e.u 兜底值同样为 update/...
      //   （petpanel-as3.js 已不再烘焙带 host 的绝对 URL）。
      const src = e.r ? IMG(e.r) : (e.u || '');
      return `<img class="pp-e" src="${esc(src)}" alt="" data-res="${esc(e.r || '')}" style="${st}${wh}" onerror="this.style.visibility='hidden'"/>`;
    }
    if (e.k === 'FRAME') {
      const wh = (e.w != null ? `;width:${e.w}px` : '') + (e.h != null ? `;height:${e.h}px` : '');
      return `<i class="pp-e pp-fr" style="${st}${wh};border-color:${HEX(e.c == null ? 0x66471B : e.c)}"></i>`;
    }
    if (e.k === 'TEXT') {
      const s = e.s || 12;
      // ★ bu：标签覆盖表（不改自动生成的元素表）—— 成长率栏改名为「品级」（值已按品级彩色显示）
      const LABEL_OVERRIDE = { PROPERTY_GROWUPRATE: '品级:' };
      if (!e.ph && LABEL_OVERRIDE[e.key]) e = Object.assign({}, e, { t: LABEL_OVERRIDE[e.key] });
      const w = e.w != null ? `;width:${e.w}px` : '';
      const txt = fill != null && fill !== '' ? fill : (e.ph ? DASH : esc(e.t || ''));
      return `<div class="pp-tx${e.ph ? ' dyn' : ''}" style="${st}${w};color:${HEX(e.c == null ? 0 : e.c)};`
        + `font-size:${s}px;line-height:${s + 2}px">${txt}</div>`;
    }
    return '';   // LIST / COMBO 由 _extra 用真实控件替换
  }

  // 当前选中宠物是否为「出战」宠物（实例层 state===1 ⇔ petState().activeUid 命中）
  _isActivePet() {
    // ★ bo：多只参战口径 —— state===1 即出战（按钮显「休息」），activeUid 只决定战斗召唤首选
    const st = this.sys;
    const selId = st && st.selectedId;
    if (!selId) return false;
    const inst = st.instanceOf && st.instanceOf(selId);
    if (!inst) return false;
    return inst.state === 1;
  }

  // 静态元素显隐（只处理 AS3 里根本不会 addChild 的那批）：
  //   x=153 / y∈[375,441] 的 5 个「法术属性名」—— AS3 setAddProperty(...,flag=false) 不入显示列表
  //   （复现页按默认系烘焙出来的产物），实际由 _extra 按 _sys 的 ARM 组重画 ⇒ 直接不渲染。
  //   ★ 出战/休息 互斥：textpanelfight 与 textpanelrest 共用同一槽位(113,176)，按出战态二选一
  //     （对齐 AS3 PetPanel.buttonClickHandler：未出战显「出战」、已出战显「休息」），否则两按钮叠在一起。
  _visible(e) {
    if (e.visible === false) return false;            // 面板编辑器隐藏的元素（live 覆盖）
    if (e.k === 'TEXT' && e.x === 153 && e.y >= 375 && e.y <= 441) return false;
    const active = this._isActivePet();
    if (e.r === 'textpanelfight') return !active;   // 未出战 → 显「出战」
    if (e.r === 'textpanelrest') return active;      // 已出战 → 显「休息」
    return true;
  }

  // 面板编辑器 live 覆盖：读取 localStorage['tsqt.paneledit.pet'] 里由编辑器保存的
  // 「有效元素数组」（含 x/y/w/h/visible/locked 覆盖 + z 轴顺序），使编辑器改动即时在游戏内生效。
  // 缺失/非法时回退到 AS3 元素表原值，绝不抛错影响正常渲染。
  _editedElements() {
    try {
      const raw = localStorage.getItem('tsqt.paneledit.pet');
      if (!raw) return null;
      const ov = JSON.parse(raw);
      if (!ov || !Array.isArray(ov.elements)) return null;
      return ov.elements;
    } catch (_) { return null; }
  }

  // ───────────── 渲染主流程 ─────────────
  render() {
    this._init();
    const p = this.sys.current() || {};
    p._pb = passiveBonus(p);   // 被动技能属性加成（供 VALUE 各项计入合计）
    this._showPt = Number(p.leftPoint || 0) > 0;

    const base = this._editedElements() || PET_PAGES.main;
    // ★ 标题/帮助/关闭图也在 main 页内（PET_PANE 为空）：在此统一过滤帮助按钮
    const els = (base || []).filter((e) => this._visible(e)).filter(PP_TOP_HIDE);
    const slots = els.filter((e) => e.k === 'TEXT');
    const fills = this._fills(slots, p);

    let n = -1;
    const body = els.map((e) => (e.k === 'TEXT' ? this._E(e, fills[++n]) : this._E(e))).join('');

    const lay = this._layer();
    // ★ bi：记住列表滚动位置 —— innerHTML 整体重写会把 .pp-petlist 的 scrollTop 归零，
    //   导致每次点选都滚回顶部（列表长时体验极差）。
    const _prevList = lay.querySelector('.pp-petlist');
    const _prevScroll = _prevList ? _prevList.scrollTop : 0;
    lay.innerHTML = `
      <div class="pp-top">${PET_PANE.filter(PP_TOP_HIDE).map((e) => this._E(e)).join('')}</div>
      <div class="pp-page" data-page="main">
        ${body}
        ${this._extra(els, p)}
      </div>
      <div class="pp-note">元素表 1:1 来自 AS3 复现管线（petpanel-as3.js·DOM 抓取）· 坐标未手抄</div>`;
    this._wire();
    this._syncModel();   // 挂真实宠物模型（Fighter 立绘，脚点 PetPanel_header(76,140)）
    // ★ bi：渲染后把滚动位置写回新列表（新 DOM 节点 scrollTop 默认 0）
    const _newList = lay.querySelector('.pp-petlist');
    if (_newList && _prevScroll > 0) _newList.scrollTop = _prevScroll;
  }

  // ───────────── ph 槽位填数 ─────────────
  _fills(slots, p) {
    return slots.map((e) => {
      if (!e.ph) return null;                        // 静态标签（元素表已带文案）
      const key = e.x + ',' + e.y;
      const f = PH_FIELD[key];
      if (!f) {                                      // 元素表新增了未映射槽位：暴露出来，不静默
        if (this._phMiss.indexOf(key) < 0) {
          this._phMiss.push(key);
          console.warn('[panel-pet] 元素表出现未映射的 ph 槽位：', key, '（PH_FIELD 需按 AS3 顺序补录）');
        }
        return DASH;
      }
      const fn = VALUE[f];
      const html = fn ? fn(p) : null;
      return html == null || html === '' ? DASH : html;
    });
  }

  // ───────────── 动态复合控件 ─────────────
  // 真源：initList / initCombox+onComboxChange→layoutProp / initInput / initExpInput / updateHeader→stateSprite
  _extra(els, p) {
    const st = this.sys;
    const all = st.list || [];
    const selId = st.selectedId;

    // 宠物列表（替换 LIST 160,50,124,100）：AS3 addListItem → list.addItem({label:name, id:petId})，只显示名字
    // ★ ay：选中/高亮一律按 uid（petId 是唯一编码；同物种多只时按 petId 会全部高亮）。
    // ★ bo：参战（state===1）宠物置顶，并加出战角标。
    const _sorted = all.slice().sort((a, b) => {
      const fa = Number(a.state) === 1 ? 0 : 1, fb = Number(b.state) === 1 ? 0 : 1;
      return fa - fb;
    });
    const list = `<div class="pp-petlist" style="left:160px;top:50px;width:124px;height:100px">`
      + _sorted.map((pt) => `<div class="pp-petrow${String(pt.uid) === String(selId) ? ' on' : ''}" data-uid="${esc(pt.uid)}">`
        + `${Number(pt.state) === 1 ? '<span class="pp-fight-mark">战</span>' : ''}${esc(pt.name)}</div>`).join('')
      + `</div>`;

    // 法术组合框（替换 COMBO 150,355,135,22）
    const combo = `<select class="pp-combo" data-combo style="left:150px;top:355px;width:135px;height:22px">`
      + ARM.map((m) => `<option value="${m.key}"${this._sys === m.key ? ' selected' : ''}>${esc(m.label)}</option>`).join('')
      + `</select>`;

    // 法术属性区：layoutProp(list, PetPanel_magicProp(153,373))
    //   name.x = 153；name.y = 373 + i*propText.height(16) + propText.y(2) = 375 + 16i
    //   value.x = 153 + name.width + 5；value.y 同行
    const sys = ARM.find((m) => m.key === this._sys) || ARM[1];
    const mag = sys.props.map((key, i) => {
      const y = 375 + i * 16;
      const label = ARM_LABEL[key] || key;
      const vx = 153 + textW(label, 12) + 5;
      const fn = VALUE[key];
      const html = fn ? fn(p) : null;
      const txt = html == null || html === '' ? DASH : html;
      return `<div class="pp-tx" style="left:153px;top:${y}px;color:#c8c2b6;font-size:12px">${esc(label)}</div>`
        + `<div class="pp-tx" style="left:${vx}px;top:${y}px;color:#c8c2b6;font-size:12px">${txt}</div>`;
    }).join('');

    // 携带数（BenplayerText(PetPanel_countInput(101,151),w=124) → 无标签分支 textBg.x=59 ⇒ 可见左边界 160）
    //   AS3 updateCountInput：VIEW_PET_TAKENUM + list.length + "/" + getPlayerProp(petMax)
    //   ⚠ 玩家侧 petMax 未接入（js 无该属性）⇒ 上限填 '—'（不臆造）
    const cnt = `<input class="pp-input" style="left:160px;top:151px;width:124px;height:19px" readonly `
      + `value="${esc('携带数量: ' + all.length + '/' + DASH)}"/>`;

    // 经验（BenplayerText(PetPanel_expInput(-49,465),w=275) → 可见左边界 = -49+59 = 10，文本 x = 15）
    //   AS3：petPanelPropValue[expCur].htmlText = PROPERTYMANAGER_EXP + expCur + "/" + expMax
    const expA = raw(p, 'expCur'), expB = raw(p, 'expMax');
    const expTxt = expA == null ? '经验值: ' + DASH : '经验值: ' + expA + '/' + (expB == null ? DASH : expB);
    const exp = `<input class="pp-input" style="left:10px;top:465px;width:275px;height:19px" readonly value="${esc(expTxt)}"/>`;

    // 状态图标（stateSprite，容器原点 PetPanel_state(20,50)）：
    //   ① 出战/休息：选中宠物 == 出战宠物 → panelpetfight.png，否则 panelpetrest.png（均在 (0,0)）
    //   ② 绑定：bind==1 → panelpetbind.png，偏移 (22,0)
    //   ③ 锁定：petLockState==1 → panelpetprotect.png，偏移 (110,0)
    //   ⚠ 雇佣图标（rentFlag>0 → pet_employ）—— op572 原型无 rentFlag ⇒ 不画（不臆造）
    // ★ bo：多只参战口径 —— state===1 即出战，activeUid 只决定战斗召唤的首选。
    const _inst0 = st.instanceOf && st.instanceOf(selId);
    const isFight = _inst0 ? (_inst0.state === 1) : false;
    const icons = [
      `<img class="pp-state-ic" src="${esc(IMG(isFight ? 'panel_pet_fight' : 'panel_pet_rest'))}" alt=""/>`,
    ];
    if (Number(p.bind) === 1) icons.push(`<img class="pp-state-ic" style="left:22px" src="${esc(IMG('panel_pet_bind'))}" alt=""/>`);
    if (Number(p.petLockState) === 1) icons.push(`<img class="pp-state-ic" style="left:110px" src="${esc(IMG('panel_pet_protect'))}" alt=""/>`);
    const state = `<div class="pp-state" style="left:${STATE_ORIGIN.x}px;top:${STATE_ORIGIN.y}px">${icons.join('')}</div>`;

    return list + combo + mag + cnt + exp + state;
  }

  // ───────────── 宠物形象（对齐 AS3 headerSprite）─────────────
  // AS3：headerSprite = LoadSprite02，load(pet.bodyImage) 后落 PetPanel_header(76,140)（脚点=注册点）。
  // 真机复用游戏内 Fighter（与场景/主角同源渲染管线），不触碰战斗代码。
  // bo: selection guard -- only real (caught) pets show a model. Returns false when the
  //     player owns no pet instance (pet() then falls back to Config.pets prototypes).
  _ensureSel() {
    const st = this.sys;
    const real = (st && st.raw) || [];
    if (!real.length) return false;
    const cur = st.current();
    const ok = !!cur && real.some((r) =>
      String(r.uid) === String(cur.uid) || String(r.petId) === String(cur.petId));
    if (!ok) st.select(real[0].uid != null ? real[0].uid : real[0].petId);
    return true;
  }

  _ensureModel() {
    const st = this.sys;
    if (!this._ensureSel()) {                        // no real pet: destroy old figure, show no model
      if (this._fig) { try { this._fig.destroy(); } catch (e) {} this._fig = null; this._figPetId = null; }
      return null;
    }
    const p = (st && st.current && st.current()) || {};
    const charId = p.bodyImage || 300000;   // ★ op572 原生名：形象字段 = bodyImage（原 charId 已废）
    // 切换宠物：销毁旧模型再重建，避免残留上一只立绘
    if (this._fig && this._figPetId === p.petId) return this._fig;
    if (this._fig) { try { this._fig.destroy(); } catch (e) {} this._fig = null; }

    const dir = 'RB';   // 固定 RB：面板展示模型，不跟随主角转向
    const fig = new Fighter({
      id: 'pet-model-' + (p.petId || charId), name: p.name || '宠物',
      charId, dir, side: 'player', equip: null, showBars: false, hpAbove: false, z: 0,
      variant: !!p.variant,   // cg: preview shows the variant tint (resolved from Config.variant in Fighter)
    });
    // 面板里只显示立绘：隐藏原点红叉 / 名字 / 血条 / 状态层
    if (fig.originEl) fig.originEl.style.display = 'none';
    if (fig.nameEl) { fig.nameEl.style.visibility = 'hidden'; fig.nameEl.style.display = 'none'; }
    if (fig.hpBar) { fig.hpBar.style.display = 'none'; fig.hpBar.style.visibility = 'hidden'; }
    if (fig._statusLayer) fig._statusLayer.style.display = 'none';
    fig.el.classList.add('pp-figure');
    fig.el.style.opacity = '0';   // 锚定完成前隐藏，避免「脚点→内容」跳变闪一下
    this._fig = fig;
    this._figPetId = p.petId;
    // 引擎已修正脚点推断 ⇒ 直接把锚点 pin 到 PetPanel_header(76,140)，与 AS3 对齐（无需内容中心补偿）。
    const place = () => { fig.setPos(PET_PORTRAIT.x, PET_PORTRAIT.y); fig.el.style.opacity = '1'; };
    fig.act('stand', dir).then(place).catch(() => place());
    if (fig._anchor) place();   // 已缓存（同 charId 复用）立即定位
    return fig;
  }

  // render() 重写 innerHTML 会移除旧 fig.el → 每次渲染后重新挂入 .pp-page 最前
  _syncModel() {
    const lay = this._pp;
    if (!lay) return;
    if (this.dom && this.dom.style.display === 'none') return;   // 面板隐藏中：不重建
    const fig = this._ensureModel();
    if (!fig) return;                                // no real pet: nothing to mount
    const page = lay.querySelector('.pp-page');
    if (page && fig.el.parentNode !== page) page.insertBefore(fig.el, page.firstChild);
  }

  // 关闭面板：销毁模型（fanvas.pause 停 Timer，防 rAF/内存泄漏）
  onClose() {
    if (this._fig) { try { this._fig.destroy(); } catch (e) {} this._fig = null; this._figPetId = null; }
  }

  // ───────────── 事件 ─────────────
  _wire() {
    const st = this.sys;
    const lay = this._pp;
    if (!lay) return;
    const A = (sel, fn) => lay.querySelectorAll(sel).forEach(fn);

    // 关闭（AS3 自带）——帮助按钮已按需求移除
    A('img.pp-e[data-res="panelbtnclose"]', (im) => { im.classList.add('pp-hit'); im.onclick = () => this.close(); });


    // 9 操作按钮（按标签资源 key 识别）
    for (const res in ACT_BTN) {
      A(`img.pp-e[data-res="${res}"]`, (im) => { im.classList.add('pp-hit'); im.onclick = () => this._act(ACT_BTN[res]); });
    }

    // 加点 +/-（panelbtnadd/panelbtncut，按 y 定位属性）
    const ptHandler = (delta) => (im) => {
      const y = Math.round(parseFloat((im.style.top || '0').replace('px', '')));
      const attr = ADDPOINT[y];
      if (!attr) return;
      im.classList.add('pp-hit');
      im.onclick = () => this.ui && this.ui.toast((delta > 0 ? '加点 ' : '减点 ') + attr + '（演示：单机版未接 sendApplyPoint/sendDelPoint 下发）');
    };
    A('img.pp-e[data-res="panelbtnadd"]', ptHandler(1));
    A('img.pp-e[data-res="panelbtncut"]', ptHandler(-1));

    // 宠物列表选择
    A('.pp-petrow', (row) => {
      row.onclick = () => {
        st.select(row.dataset.uid);
        this.render();
        // ★ cc：详情面板若打开，跟随列表选中即时更新
        const pm = this.ui && this.ui.panelManager;
        const adv = pm && pm.panels && pm.panels['petadvance'];
        if (adv && pm.isOpened('petadvance')) {
          const inst = st.instanceOf(row.dataset.uid);
          if (inst) { try { petAdvance().state.selectPetId = String(inst.petId); } catch (_) {} }
          adv.refresh();
        }
      };
    });

    // 法术组合框切换
    const cb = lay.querySelector('select.pp-combo[data-combo]');
    if (cb) cb.onchange = () => { this._sys = cb.value; this.render(); };
  }

  // AS3 PetPanel.buttonClickHandler 的 9 个动作（sendPetFree/sendPetBattle/sendPetRest/…）
  _act(name) {
    const ui = this.ui;
    const t = (m) => ui && ui.toast && ui.toast(m);
    const open = (k) => ui && ui.panelManager && ui.panelManager.open(k);
    const st = this.sys;
    const sel = st.selectedId;
    switch (name) {
            // ★ bv：放生 —— 从列表移除，快照丢入抛弃池（上限 20，以后做恢复功能）
      case 'free': {
        const inst = st.instanceOf && st.instanceOf(sel);
        if (!inst) { t('请先选择宠物'); break; }
        const nm = (this.sys.get(sel) || {}).name || (inst.petId || sel);
        if (petState().abandon(inst.uid)) {
          if (ui && ui.refreshActivePet) ui.refreshActivePet();
          t('已放生：' + nm + '（进入抛弃池，以后可恢复）');
          this.render();
        } else { t('放生失败：未找到该宠物'); }
        break;
      }
      case 'rename': t('改名（演示）'); break;
      // ★ 设为出战 = AS3 sendPetBattle → 实例层 state=1（战斗侧 scene.js 按 state===1 选宠物参战）
      case 'fight': {
        const inst = st.instanceOf && st.instanceOf(sel);
        if (!inst) { t('请先选择宠物'); break; }
        const before = inst.state === 1;
        const ok = petState().setActive(inst.uid);
        if (!before && ok) {
          const ev = petState().consumeEvicted();   // 队列满员时被顶替的那只
          if (ev) {
            const evName = (this.sys.get(ev) || {}).name || '宠物';
            t('参战已满：' + evName + ' 已退出参战，' + (inst.petId || sel) + ' 顶替出战');
          } else t('已设为出战：' + (inst.petId || sel));
        } else {
          t(ok ? '已设为出战：' + (inst.petId || sel) : '已撤下出战：' + (inst.petId || sel));
        }
        if (ui && ui.refreshActivePet) ui.refreshActivePet();
        this.render();
        break;
      }
      // ★ 休息 = AS3 sendPetRest → 全部 state=0
      case 'rest': {
        const inst = st.instanceOf && st.instanceOf(sel);
        if (!inst) { t('请先选择宠物'); break; }
        petState().undeploy(inst.uid);
        if (ui && ui.refreshActivePet) ui.refreshActivePet();
        t('已休息：' + (inst.petId || sel));
        this.render();
        break;
      }
      // ★ 详情 = AS3 BUTTON_DETAIL：先携带选中宠物到进阶面板
      //   （petAdvancePanelNew.petSkill.updateSkillItemList(selectPetId)），
      //   再 openOrClose(PANEL_PET_ADVANCE_NEW)。本版无独立 ViewPetInfo 顶层面板——
      //   详情即宠物进阶面板（内含属性/技能/悟性/内丹子视图），故直接 open('petadvance')。
      case 'info': {
        const inst = st.instanceOf && st.instanceOf(sel);
        if (inst) { try { petAdvance().state.selectPetId = String(inst.petId); } catch (_) {} }
        open('petadvance');
        break;
      }
      case 'useitem': t('喂养（演示：petitem 面板未接入）'); break;
      case 'confirm': t('确认加点（演示：sendApplyPoint）'); break;
      case 'train': t('训练（演示：pettraining 面板未接入）'); break;
      case 'group': t('组队（演示：sentPetGroup）'); break;
    }
  }
}

// 注册：覆盖 generic As3Panel 的 'pet'（与 PlayerPanel 覆盖 'playerpanel' 同理），
// 使 HUD「伙伴」按钮（data-panel="pet"）打开 1:1 复刻的 PetPanel。
// 注意：必须用 (panelManager, ui) 收口，不能在模块作用域直接 new PetPanel(ui)——
// 模块级 ui 未定义，会导致工厂闭包捕获不到 ui（参考 panel-player.js 的 registerPlayerPanel）。
export function registerPetPanel(panelManager, ui) {
  panelManager.register('pet', () => new PetPanel(ui));
}
