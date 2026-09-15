// skill-params-ui.js — 技能公式系数编辑器的共享 UI（被 battle-test.js 与 Workbench 技能编辑器复用）
// 抽出自 battle-test.js，避免两处重复维护同一套「逐字段中文注释 + 递归参数编辑」逻辑。
// 不依赖引擎内部常量：默认系数由调用方通过 defParams 注入（现统一来自 getDefaultSkillParams(id)），自身无外部副作用。

// ── 内部小工具（与 battle-test 版等价，独立副本避免跨文件耦合）──
function _deepClone(o) { return JSON.parse(JSON.stringify(o)); }
// 把数组文本（"1,2,4" 或 "burn,freeze"）按默认值类型还原成真实数组
function _parseArray(def, str) {
  const arr = String(str).split(',').map(s => s.trim()).filter(s => s !== '');
  if (def.length && typeof def[0] === 'number') return arr.map(Number);
  return arr;
}

// ── 可调参数的中文注释：key = 参数路径（支持 "技能ID.路径" 精确覆盖，否则按通用路径）──
export const PARAM_GROUP_LABELS = {
  stun: '眩晕关联', taunt: '嘲讽关联', poison: '中毒', breakarmor: '破甲',
  feihua: '飞花溅玉', burn: '灼烧'
};
export const PARAM_LABELS = {
  // 通用：伤害 / 属性加值
  'dmgBase': '伤害系数·基础', 'dmgPerL': '伤害系数·每级增量',
  'atkBase': '攻击加值·基础', 'atkPerL': '攻击加值·每级增量',
  'magBase': '法术加值·基础', 'magPerL': '法术加值·每级增量',
  'lowHpPct': '低生命阈值(比例)', 'lowHpMult': '低生命伤害倍率',
  'hpRatioFloor': '生命比例下限',
  'buffBonusKind': '增伤触发状态(列表: xianqi/haotian/defending)', 'buffBonusMult': '增伤倍率',
  'breakarmorMult': '破甲态伤害倍率',
  'valorCost': '消耗侠义之心', 'perValorMult': '每点侠义之心增益',
  'reduceBase': '同生共死·减免基础%', 'reducePerL': '同生共死·减免每级%',
  'minLevel': '满额减免最低等级', 'fullProb': '满额减免触发概率',
  'dur': '持续回合', 'durBase': '持续·基础回合', 'durXwPer': '持续·每点修为增量',
  'constTerm': '常数项', 'constPerL': '常数·每级增量',
  'prob': '施加概率',
  // 眩晕（伏魔刀法）
  'stun.link': '是否施加眩晕', 'stun.prob': '眩晕施加概率', 'stun.dur': '眩晕持续回合',
  'stun.xwCmp': '触发条件(修为比较 >)',
  // 嘲讽（冷嘲热讽）
  'taunt.successNormal': '嘲讽成功率(普通)', 'taunt.successInsight': '嘲讽成功率(被识破)',
  'taunt.dur': '嘲讽持续回合', 'taunt.addValor': '命中获侠义之心',
  // 中毒（千蛛万毒手）
  'poison.dur': '中毒持续回合', 'poison.dotBase': '中毒伤害·基础系数', 'poison.dotPerL': '中毒伤害·每级系数',
  // 破甲（龙破斩）
  'breakarmor.prob': '破甲施加概率', 'breakarmor.durBase': '破甲持续·基础', 'breakarmor.durXwPer': '破甲持续·每点修为',
  // 八荒六合
  'physReduceBase': '八荒·物理减伤基础%', 'physReducePerL': '八荒·物理减伤每级%',
  'magHealBase': '八荒·法术回血增基础%', 'magHealPerL': '八荒·法术回血增每级%',
  'magAtkBase': '八荒·法术攻击增基础%', 'magAtkPerL': '八荒·法术攻击增每级%',
  'bahuangDurBase': '八荒持续·基础', 'bahuangDurDiv': '八荒持续·每级除数',
  'neiliMult': '内力充沛持续倍数', 'spdPct': '内力速度加成比例',
  // 飞花溅玉
  'feihua.dur': '飞花持续回合', 'feihua.dotBaseBase': '飞花dot·基础系数', 'feihua.dotBasePerL': '飞花dot·每级系数',
  'feihua.mults': '飞花逐跳倍率(列表)',
  // 穿心蚀骨
  'thrBase': '穿心阈值·基础系数', 'thrPerL': '穿心阈值·每级',
  'extBase': '穿心爆发·基础系数', 'extPerL': '穿心爆发·每级',
  'ext2Base': '穿心二段·基础系数', 'ext2PerL': '穿心二段·每级',
  // 四相诀
  'elemBuffs': '四相元素(列表)', 'elemProb': '四相元素施加概率', 'elemDur': '四相元素持续',
  // 唤灭破
  'layerBonus': '每层增益系数', 'maxLayers': '最大层数', 'elemKinds': '层数判定状态(列表)',
  // 恸地神咒
  'coefPrimaryBase': '选中目标系数·基础', 'coefPrimaryPerL': '选中目标系数·每级',
  'coefOtherBase': '其余目标系数·基础', 'coefOtherPerL': '其余目标系数·每级',
  'selfDur': '自身护体持续', 'defAddPct': '自身防御加成%',
  // 烈焰风暴
  'burn.prob': '灼烧施加概率', 'burn.durBase': '灼烧持续·基础', 'burn.durXwPer': '灼烧持续·每点修为',
  // 魅惑术
  'confProb': '混乱施加概率',
  // 暗影魔咒
  'atkBaseCoef': '攻击系数·基础', 'atkPerLCoef': '攻击系数·每级', 'defFactor': '防御=攻击比例',
  // 梦魔咒
  'sleepProb': '昏睡施加概率',
  // 圣灵附体
  'defBaseCoef': '防御系数·基础', 'defPerLCoef': '防御系数·每级',
  'atkFactor': '攻击=防御比例', 'magFactor': '法术=防御比例', 'recoverFactor': '回复=防御比例', 'spdDiv': '速度=防御除数',
  // 昊天罡气
  'shieldBase': '护盾系数·基础', 'shieldPerL': '护盾系数·每级',
  // 凝神聚气
  'rageBase': '怒气·基础', 'ragePerL': '怒气·每级', 'ragePctBase': '怒气%·基础', 'ragePctPerL': '怒气%·每级',
  // 持续(11+级 / 低级) 通用
  'highDurBase': '持续(11+级)·基础', 'highDurCishanDiv': '持续(11+级)·慈悲每除数',
  'lowDurBase': '持续(低级)·基础', 'lowDurXwPer': '持续(低级)·每点修为',
  // 仙音化雨
  'friendSuccessNormal': '己方成功率', 'friendSuccessInsight': '己方(被识破)成功率',
  'enemySuccessNormal': '敌方成功率', 'enemySuccessInsight': '敌方(被识破)成功率',
  'enemyXwGap': '敌方修为差距阈值', 'dispelLPlus': '驱散等级附加',
  'critRate': '暴击治疗率%',
  // 化功绵掌（70030000）
  'drainBase': '化功系数·基础', 'drainPerL': '化功系数·每级', 'defReducePct': '防御减免法力比例',
  '70030000.dmgPerL': '伤害=等级×实际化功 系数',
  // 暗影迷踪拳（70020000）
  'speedRatioCap': '速度比上限', 'selfDmgPct': '自身反伤比例',
  // 技能专属：healBase / healPerL（含义随技能不同，精确覆盖）
  '20040000.healBase': '梦魔·回血基础系数', '20040000.healPerL': '梦魔·回血每级系数',
  '30020000.healBase': '沉水·治疗系数基础', '30020000.healPerL': '沉水·治疗系数每级',
  '30020000.critHealBase': '沉水·暴击治疗系数基础', '30020000.critHealPerL': '沉水·暴击治疗系数每级',
  '30030000.healBase': '仙音·己方回血常数项', '30030000.healPerL': '仙音·己方回血每级',
  '30060000.healBase': '仙气·治疗系数基础', '30060000.healPerL': '仙气·治疗系数每级',
  '30060000.critHealBase': '仙气·暴击治疗系数基础', '30060000.critHealPerL': '仙气·暴击治疗系数每级'
};
export function paramLabel(skillId, path) { return PARAM_LABELS[skillId + '.' + path] || PARAM_LABELS[path] || path; }
export function paramGroupLabel(path) { return PARAM_GROUP_LABELS[path] || path; }

// 公式数据说明：把「变量名 → 中文名」以可读列表呈现，便于对照公式系数（随技能切换自动刷新）。
// host: 容器；defParams: 该技能的默认参数对象（决定展示哪些变量）；skillId: 用于精确标签覆盖。
export function buildParamsLegend(host, defParams, skillId) {
  host.innerHTML = '';
  const items = [];
  const walk = (obj, prefix) => {
    for (const k of Object.keys(obj || {})) {
      const def = obj[k];
      const path = prefix + k;
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        const g = document.createElement('div'); g.className = 'se-legend-group'; g.textContent = paramGroupLabel(path); items.push(g);
        walk(def, prefix + k + '.');
      } else {
        const item = document.createElement('div'); item.className = 'se-legend-item';
        const code = document.createElement('code'); code.textContent = path;
        const zh = document.createElement('span'); zh.className = 'se-legend-zh'; zh.textContent = paramLabel(skillId, path);
        item.appendChild(code); item.appendChild(zh); items.push(item);
      }
    }
  };
  walk(defParams, '');
  const det = document.createElement('details'); det.className = 'se-legend';
  const sum = document.createElement('summary'); sum.className = 'se-head'; sum.textContent = '公式数据说明（变量名 → 中文名）';
  det.appendChild(sum);
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'se-note'; empty.textContent = '（该技能无公式系数可调，伤害由总表 power / buffs 驱动）'; det.appendChild(empty);
  } else {
    const body = document.createElement('div'); body.className = 'se-legend-body';
    items.forEach(el => body.appendChild(el)); det.appendChild(body);
  }
  host.appendChild(det);
}

// 递归渲染 params 编辑器（支持 数字 / 字符串 / 布尔 / 数组 / 嵌套对象），每个字段带中文注释
// host: 容器元素；defParams: 默认值（决定类型/标签/结构）；draft: 当前草稿（被原地修改）；
// prefix: 嵌套路径前缀；onEdit: 每次变更回调；skillId: 用于精确标签覆盖
export function buildParamsEditor(host, defParams, draft, prefix, onEdit, skillId) {
  host.innerHTML = '';
  const keys = Object.keys(defParams);
  if (!keys.length) { host.textContent = '（无可调参数）'; return; }
  for (const k of keys) {
    const def = defParams[k];
    const val = (draft && draft[k] !== undefined) ? draft[k] : def;
    const path = prefix + k;
    if (Array.isArray(def)) {
      const row = document.createElement('div'); row.className = 'se-row';
      const l = document.createElement('label'); l.textContent = paramLabel(skillId, path) + '（' + k + '·数组）'; row.appendChild(l);
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = Array.isArray(val) ? val.join(',') : String(val);
      inp.title = path;
      inp.addEventListener('change', () => { draft[k] = _parseArray(def, inp.value); onEdit(); });
      row.appendChild(inp); host.appendChild(row);
    } else if (def && typeof def === 'object') {
      const fs = document.createElement('fieldset'); fs.className = 'se-sub';
      const lg = document.createElement('legend'); lg.textContent = paramGroupLabel(path); fs.appendChild(lg);
      if (!draft[k] || typeof draft[k] !== 'object') draft[k] = _deepClone(def);
      buildParamsEditor(fs, def, draft[k], prefix + k + '.', onEdit, skillId);
      host.appendChild(fs);
    } else if (typeof def === 'boolean') {
      const row = document.createElement('div'); row.className = 'se-row';
      const l = document.createElement('label'); l.textContent = paramLabel(skillId, path); row.appendChild(l);
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!val; inp.title = path;
      inp.addEventListener('change', () => { draft[k] = inp.checked; onEdit(); });
      row.appendChild(inp); host.appendChild(row);
    } else {
      const row = document.createElement('div'); row.className = 'se-row';
      const l = document.createElement('label'); l.textContent = paramLabel(skillId, path); row.appendChild(l);
      const inp = document.createElement('input'); inp.type = (typeof def === 'number') ? 'number' : 'text'; inp.value = val; inp.title = path;
      inp.addEventListener('change', () => { draft[k] = (typeof def === 'number') ? (parseFloat(inp.value) || 0) : inp.value; onEdit(); });
      row.appendChild(inp); host.appendChild(row);
    }
  }
}
