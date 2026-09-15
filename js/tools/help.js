// help.js — 研发/运营工具台「工具使用帮助」面板
// 覆盖工具台 6 大类 23 个工具的使用说明：用途 / 编辑配置域 / 关键字段 / 使用步骤 / 运行期效果 / 提示。
// 内容严格对齐 workbench.js 的 TOOLS schema 与 scene.js/fighter.js 等运行期接线，禁止任何假数据。
// 为避免与 workbench.js 形成循环依赖，TOOLS / TOOL_GROUPS 由 registerToolHelp 从外部注入。

import { BasePanel, panelManager } from '../ui/panel-manager.js?v=20261007c';

// ───────────────────────── 工具使用帮助数据 ─────────────────────────
// 每个条目：purpose(用途) / domain(编辑配置域，覆盖显示用) / steps(使用步骤) / runtime(运行期效果) / tips(提示)
// schema 工具的「关键字段」自动从 TOOLS[key].schema 生成；custom 工具若另有字段说明，用 fields 补充。
export const TOOL_HELP = {
  // ===== 一、战斗核心体系 =====
  skill: {
    domain: 'skills',
    purpose: '定义技能的基础属性、伤害系数、作用目标、法力/冷却消耗、挂载 Buff 与联动触发。所有战斗技能均从此域读取。',
    steps: [
      '在左侧选已有技能，或点「新建」创建一条。',
      '填写「技能ID」(必填，需与 SkillIcon 资源名一致) 与「名称」(必填)。',
      '设「目标选择」(单体/群体/十字/随机/血量最低/自身/友方)、「伤害系数 power」「法力消耗」「冷却回合」「怒气消耗」。',
      '如需命中附加状态，在「挂载buff」勾选 buffs 域中的状态(自身命中时挂自身，否则挂敌方)。',
      '点「保存」写回 Config.data.skills 并持久化(localStorage)，下次进战斗即用新配置。'
    ],
    runtime: '战斗中技能伤害由 calcDamage 按 power 计算（skill_damage 公式：atk*rage*power + mag*0.3）；target 决定作用范围；buffs 命中时挂到目标(或 self 挂自身)。配置即时影响战斗。',
    tips: [
      '伤害系数 power 只表达「进攻侧」期望伤害；防御减免由 Fighter.takeDamage 的 def*0.25 统一承担。',
      '「封印命中抗性公式」为运行期可求值的表达式（由公式编辑器求值），此处仅做非空校验。',
      '「联动触发」填套装/经脉/符石 id（如 ["set_烈火套","meridian_3"]）。'
    ]
  },
  buff: {
    domain: 'buffs',
    purpose: '定义 Buff/Debuff/封印/中毒/灼烧的持续时间、叠加层数、免疫规则，以及真实影响战斗的加成(atkPct/defPct)与每回合效果(dot/heal)。',
    steps: [
      '新建/选一条状态，填「状态ID」「名称」(必填)。',
      '设「类型」(buff/debuff/seal/poison/burn) 与「持续回合」「叠加层数」「生效时机」。',
      '填真实战斗字段：「攻击加成%」「防御加成%」(按叠加层放大伤害/减免)、「每回合持续伤害」(中毒/灼烧)、「每回合回复」(再生/护盾)。',
      '点「保存」。技能通过「挂载buff」引用此状态后，命中即生效。'
    ],
    runtime: 'Fighter.tickBuffs() 在回合开始结算 dot/heal 并到期移除；buffAtkPct/buffDefPct 按叠加层数放大伤害与防御减免；技能 buff 命中时挂上。',
    tips: [
      'atkPct/defPct 为百分比，按 stack 叠加：如 2 层 +10% = 实际 +20%。',
      '中毒/灼烧的 dot 与再生的 heal 属真实运行期效果，每回合在回合开始飘字结算。',
      '「免疫规则」每行一个免疫的状态类型（如 seal），用于驱散/免疫判定。'
    ]
  },
  ai: {
    domain: 'ai',
    purpose: '为怪物配置战斗 AI：目标选择偏好、技能释放优先级、阶段与血量阈值触发、召唤小怪、逃跑概率。',
    steps: [
      '选「怪物」(必填，引用 monsters 域)。',
      '设「目标选择偏好」(血量最低/随机/前排/后排/最高威胁) 与「逃跑概率」(0-1)。',
      '在「技能释放优先级」表填技能与权重（权重越高越优先）。',
      '可选：在「血量阈值触发」「阶段切换机制」「召唤小怪」表填触发条件与动作。',
      '点「保存」。下次该怪物参战即按此 AI 行动。'
    ],
    runtime: 'BattleScene._enemyTurn 读取 Config.data.ai[monsterId]：按 targetPref 选目标、priority 权重选技能、hpPct<=阈值触发技能/召唤/逃跑/阶段切换；召唤小怪每战仅一次(_aiSummoned 守卫)。',
    tips: [
      '逃跑概率填 0-1（0.2 = 20% 概率在轮到自己时逃跑）。',
      '优先级权重越高越优先；最大权重项更易被选中。',
      '召唤小怪每场战斗每个怪物只触发一次，避免刷屏。'
    ]
  },

  // ===== 二、宠物/召唤兽体系 =====
  monsterpet: {
    domain: 'monsters',
    purpose: '定义怪物/宠物模板：等级、生命、攻防、经验金币、技能、资质/成长/变异等养成参数。战斗、暗雷、副本、掉落、伙伴宠物均由此派生。',
    steps: [
      '新建/选一条怪物，填「ID」「名称」(必填)。',
      '填基础属性：模型charId、等级、生命/法力/攻击/防御/法攻/速度、经验/金币。',
      '在「技能」「天生技能池」引用 skills 域；设携带等级、资质/成长上下限、技能格、变异概率与加成。',
      '点「保存」。下次该怪物进战斗即生效。'
    ],
    runtime: '怪物用于 enterBattle 普通战斗、MainScene._rollEncounter 暗雷、副本 waveQueue 波次、rollDrops 掉落来源；伙伴宠物由 monsterId 派生。属性直接决定战斗强度。',
    tips: [
      '字段集与战斗实际消费的怪物模板严格一致，未引入任何未被消费的冗余字段。',
      '修改后下次进入该怪物战斗即生效，无需重启。'
    ]
  },
  pillmount: {
    domain: 'pills',
    purpose: '配置内丹/坐骑的层数效果与统御加成规则：出战伙伴按 controlRule 表达式获得 atk/def/mag 百分比加成。',
    steps: [
      '新建/选一条，填「ID」「名称」(必填)，设「类型」(内丹/坐骑)。',
      '在「层数效果」表填每层效果描述。',
      '写「统御加成规则」表达式（如 atk*(1+layer*0.05)），可引用 atk/def/mag/level/layer/growth/affection。',
      '点「保存」。伙伴出战召唤时自动套用。'
    ],
    runtime: '出战伙伴召唤时 _applyPillBonus 按 controlRule 表达式对 atk/def/mag 百分比加成（layer 取最大层）。',
    tips: [
      '统御规则为安全表达式，仅支持 + - * / % ^、括号、小数、标识符，无函数调用。',
      '表达式可引用 atk/def/mag/level/layer/growth/affection 等变量。'
    ]
  },

  // ===== 三、任务剧情与副本生产 =====
  quest: {
    domain: 'quests',
    purpose: '配置任务：发布 NPC、完成条件、分支跳转、奖励、NPC 对话跳转与任务追踪。',
    steps: [
      '新建/选任务，填「任务ID」「名称」(必填)，设「类型」(主线/支线/师门/环任务)。',
      '设「发布NPC」(引用 npcs 域) 与「条件」(kv：type/monster/count)。',
      '设「奖励」(kv：exp/silver/item) 与「分支选择」「NPC对话跳转」(可选)。',
      '点「保存」。任务出现在任务追踪与 NPC 对话。'
    ],
    runtime: '任务数据驱动任务追踪 UI 与 NPC 对话；奖励 kv 在任务完成时发放到玩家。',
    tips: [
      '条件格式：type=monster / monster=m_boar / count=10。',
      '奖励格式：exp=500 / silver=200 / item=11030001。',
      '分支/对话跳转的 next 填目标任务 ID。'
    ]
  },
  story: {
    domain: 'stories',
    purpose: '编辑剧情时间轴(steps JSON) 并在主线场景上叠层播放：对话气泡、镜头移动、NPC 走位、特效触发、背景音乐、黑屏。',
    fields: [
      { label: '剧情ID', hint: '必填，保存键' },
      { label: '名称', hint: '展示名' },
      { label: '时间轴 steps(JSON)', hint: '每步含 action / t(停留秒) / npc / pos / text / effect / bgm' },
      { label: '▶ 播放', hint: '在主线场景 world 层叠 .story-play 逐帧演出' },
      { label: '保存 / 删除', hint: '写回 Config.data.stories 并持久化' }
    ],
    steps: [
      '新建/选剧情，填「剧情ID」「名称」。',
      '在 steps 文本框写时间轴 JSON（数组，每步一个对象）。',
      '点「▶ 播放」在主线场景预览演出效果。',
      '满意后点「保存」。'
    ],
    runtime: 'playStory 在 ui.sm.layers.world 上叠 .story-play 层逐帧演出；action 支持：对话气泡 / 镜头移动 / NPC走位 / 特效触发 / 背景音乐 / 黑屏。',
    tips: [
      'steps 为 JSON 数组；单步停留秒数由 t 控制（默认 1.2 秒）。',
      '镜头移动需主线场景 camera 存在；黑屏仅黑屏无其他内容。',
      'action 枚举：对话气泡 / 镜头移动 / NPC走位 / 特效触发 / 背景音乐 / 黑屏。'
    ]
  },
  dungeon: {
    domain: 'dungeons',
    purpose: '配置副本：准入条件、战斗波次、BOSS 阶段机制、掉落分配、通关条件与每周次数限制。',
    steps: [
      '新建/选副本，填「副本ID」「名称」(必填)。',
      '设「准入条件」(kv：level/count/pre)。',
      '在「战斗波次」表填怪物组(mob)与数量；首条为首发敌人，其余为补场。',
      '设「BOSS阶段机制」与「掉落分配」(引用 drops 域的掉落表ID)。',
      '点「保存」。用 GM 后台「开始副本」拉起。'
    ],
    runtime: 'GM 后台「开始副本」→ ui.sm.startDungeon 拉起首波；首敌倒下后 waveQueue 异步补场；通关按 dropRule 走 rollDropsByDropId 掉落。',
    tips: [
      '波次首条为首发敌人，其余波次在敌人倒下后补场。',
      '掉落分配引用 drops 域的掉落表 ID（非怪物 ID）。',
      '每周次数 / 进度保存为副本运行参数。'
    ]
  },
  encounter: {
    domain: 'encounters',
    purpose: '按地图配置暗雷遇敌概率与怪物组合、以及明雷 NPC 的巡逻路线与触发条件。',
    steps: [
      '新建/选规则，选「地图」(必填，引用 maps 域)。',
      '设「遇敌概率」(0-1)。',
      '在「暗雷怪物组合」表填怪物(mob)与权重(weight)。',
      '可选：在「明雷NPC」表填怪物、巡逻路线(x1,y1;x2,y2)、触发条件。',
      '点「保存」。进入该地图走动即按概率遇暗雷。'
    ],
    runtime: 'MainScene._rollEncounter 按 mapId 匹配规则，按 rate 概率触发暗雷；怪物由 darkGroup 权重表生成——darkPick=perUnit（默认）时每个敌人独立按权重抽（同场混合怪群），once 时整场同一只；冷却 3 秒避免连刷。资质型怪物等级恒 1（属性由 chars.json 资质×成长率派生），等级不在此配。',
    tips: [
      '遇敌概率填 0-1（0.15 = 15%）。',
      '暗雷组合权重越高越易遇到；明雷为地图上可见的怪物 NPC。',
      '冷却 3 秒机制避免连续遇敌刷屏。'
    ]
  },

  // ===== 四、经济与社交系统 =====
  drop: {
    domain: 'drops',
    purpose: '配置怪物/副本的掉落表：物品、权重、数量区间、绑定、保底次数与稀有保护。',
    steps: [
      '新建/选掉落表，填「掉落表ID」「名称」(必填)。',
      '设「来源」(引用 monsters 域，或指向 dungeons)。',
      '在「掉落表」加物品行：物品(引用items)、权重、数量下限/上限、绑定(否/是/随机)、保底次数、稀有保护。',
      '点「保存」。怪物被击败时按权重掷掉落。'
    ],
    runtime: '怪物被击败 _awardKill 调 rollDrops(monsterId) 按权重掷掉落；副本通关走 dropRule → rollDropsByDropId。',
    tips: [
      '权重越高掉落概率越大；数量下限/上限为区间随机。',
      '绑定：否/是/随机 决定物品绑定状态。',
      '保底次数 0 = 无保底。'
    ]
  },
  trade: {
    domain: 'trade',
    purpose: '配置交易行规则：可交易分类、摆摊税率、公示期、价格上下限、交易冷却、是否跨服。',
    fields: [
      { label: '规则名', hint: '必填' },
      { label: '可交易分类', hint: '每行一个物品 type，如 weapon / armor' },
      { label: '摆摊税率(%)', hint: '上架手续费比例' },
      { label: '公示期(天)', hint: '上架公示天数' },
      { label: '价格下限 / 价格上限', hint: '上架价格限制区间' },
      { label: '交易冷却(秒)', hint: '两次交易间隔' },
      { label: '跨服交易', hint: '布尔开关' }
    ],
    steps: [
      '新建/选规则，填「规则名」(必填)。',
      '在「可交易分类」填允许交易的物品 type（每行一个）。',
      '设摆摊税率、公示期、价格下限/上限、交易冷却、跨服交易。',
      '点「保存」。'
    ],
    runtime: '交易行买卖按此规则校验分类/税率/价格区间（经济系统消费）。',
    tips: [
      '物品 type 指 weapon / armor / potion / gem / rune 等。',
      '价格区间限制上架价格；超出则无法上架。'
    ]
  },
  shop: {
    domain: 'shop',
    purpose: '配置商城商品 / 限购礼包 / 折扣活动 / 充值档位。',
    steps: [
      '新建/选商品，填「商品ID」「名称」(必填)。',
      '选「道具」(引用 items 域) 与「类型」(商品/限购礼包/折扣活动/充值档位)。',
      '设「价格」「限购数量」(0=不限)「折扣」(0-1，1=原价)「限时上架」(时间区间)「渠道专属」。',
      '点「保存」。商城面板即展示并售卖。'
    ],
    runtime: '商城面板按此展示与售卖；折扣=购买价系数（0.8=8 折）；限购数量限制购买次数。',
    tips: [
      '限时上架格式：2026-08-01~2026-08-31。',
      '渠道专属留空 = 全渠道。',
      '限购数量 0 = 不限购。'
    ]
  },
  guild: {
    domain: 'guild',
    purpose: '配置帮派建筑升级规则、帮派技能、帮战匹配、跑商规则、福利与竞赛奖励。',
    fields: [
      { label: '配置ID / 名称', hint: '必填' },
      { label: '建筑升级规则', hint: 'JSON' },
      { label: '帮派技能', hint: '引用 skills 域(多选)' },
      { label: '帮战匹配规则 / 跑商规则 / 帮派福利 / 竞赛奖励', hint: '文本规则' }
    ],
    steps: [
      '新建/选配置，填「配置ID」「名称」(必填)。',
      '填「建筑升级规则」(JSON) 与「帮派技能」(引用 skills 域)。',
      '在文本字段填帮战/跑商/福利/竞赛规则。',
      '点「保存」。'
    ],
    runtime: '帮派系统按此配置运作：建筑升级、帮派技能、帮战匹配、跑商、福利发放、竞赛奖励。',
    tips: [
      '帮派技能引用 skills 域。',
      '建筑升级规则为 JSON 结构。'
    ]
  },
  bot: {
    domain: 'bots',
    purpose: '配置地图上的机器人 NPC：行为模式、巡逻路线、发言内容、等级与战斗 AI。',
    fields: [
      { label: 'ID / 名称', hint: '必填' },
      { label: '地图', hint: '引用 maps 域' },
      { label: '行为', hint: '巡逻 / 站桩 / 追击' },
      { label: '巡逻路线', hint: '每行 x,y' },
      { label: '发言', hint: '列表，每行一条' },
      { label: '等级 / AI', hint: 'AI 引用 ai 域' }
    ],
    steps: [
      '新建/选机器人，填「ID」「名称」(必填)。',
      '选「地图」与「行为」(巡逻/站桩/追击)。',
      '填「巡逻路线」(每行 x,y) 与「发言」列表。',
      '设「等级」与「AI」(引用 ai 域)。点「保存」。'
    ],
    runtime: '地图按此生成机器人 NPC（行为/巡逻/发言），AI 引用 ai 域控制其战斗表现。',
    tips: [
      '巡逻路线每行 x,y。',
      'AI 引用 ai 域（见「战斗AI编辑器」）。'
    ]
  },

  // ===== 五、角色养成线 =====
  equip: {
    domain: 'items',
    purpose: '编辑物品/装备：类型、基础属性、价格，以及打造/熔炼/镶嵌/套装/特技等养成规则。',
    steps: [
      '新建/选物品，填「物品ID」「名称」(必填)，设「类型」(weapon/armor/potion/quest/gem/rune)。',
      '在「基础属性」填 JSON（如 {"atk":15}）。',
      '设「价格」与养成规则（打造/熔炼属性区间/宝石镶嵌/开孔数/符石组合/特技/特效触发概率/套装集齐效果/修理失败规则）。',
      '点「保存」。装备穿戴后属性进角色面板。'
    ],
    runtime: '装备穿戴后属性汇总进角色面板(CharPanel._renderArm)；打造/熔炼/镶嵌/套装由养成系统消费。',
    tips: [
      '基础属性 JSON 如 {"atk":15}。',
      '套装集齐效果为 JSON；符石组合为安全表达式。',
      '开孔数决定可镶嵌宝石孔位。'
    ]
  },
  heart: {
    domain: 'xinfa',
    purpose: '配置心法层级、升级消耗(经验/银两)、解锁等级、门派特色与奇经八脉节点。',
    fields: [
      { label: '心法ID / 名称', hint: '必填' },
      { label: '层级', hint: '心法总层数' },
      { label: '升级消耗', hint: '表：层级 + 经验 + 银两' },
      { label: '解锁等级', hint: '角色解锁所需等级' },
      { label: '门派特色', hint: '文本' },
      { label: '奇经八脉节点', hint: '表：节点 + 效果 + 分支' }
    ],
    steps: [
      '新建/选心法，填「心法ID」「名称」(必填)。',
      '设「层级」与「升级消耗」表（按层级填经验与银两）。',
      '设「解锁等级」与「奇经八脉节点」表。',
      '点「保存」。'
    ],
    runtime: '心法升级按消耗表扣经验/银两；技能面板(8 心法分类标签)展示心法分类。',
    tips: [
      '升级消耗表按层级填经验与银两。',
      '奇经八脉为分支节点效果。'
    ]
  },
  formula: {
    domain: 'formulas',
    purpose: '编辑战斗伤害/属性公式：参数清单与表达式。战斗运行时按公式 ID 求值。',
    steps: [
      '新建/选公式，填「公式ID」「名称」(必填)。',
      '在「参数」填每行一个参数名（如 atk / def / level）。',
      '在「公式」写表达式（如 atk*power - def*0.5）。',
      '点「保存」。战斗按 getFormula(formulaId) 求值。'
    ],
    runtime: '战斗按 calcDamage 调 getFormula(formulaId) 求值（缺省回退 DEFAULT_FORMULAS）。公式只表达进攻侧期望伤害。',
    tips: [
      '安全表达式：仅 + - * / % ^、括号、小数、标识符，无函数调用。',
      '参数为 evalFormula 的变量；内置公式ID：phys_damage / skill_damage / enemy_damage / ally_damage。',
      '不打开本编辑器时战斗仍用默认公式，向后兼容。'
    ]
  },
  achievement: {
    domain: 'achievements / titles',
    purpose: '双域内联编辑成就(触发条件/成就点/奖励/称谓加成) 与称谓(属性加成/有效期)。',
    fields: [
      { label: '成就：ID / 名称', hint: '必填' },
      { label: '成就：触发条件(表达式)', hint: '运行期判定' },
      { label: '成就：成就点 / 奖励(kv) / 称谓属性加成', hint: 'reward 格式 exp=100 / item=11030001' },
      { label: '成就：有效期(天, 0=永久)', hint: '数字' },
      { label: '称谓：ID / 称谓', hint: '必填' },
      { label: '称谓：属性加成 / 有效期(天, 0=永久)', hint: '文本/数字' }
    ],
    steps: [
      '左侧选「成就」或「称谓」列表(双域)。',
      '新建/选条目，填对应字段。',
      '点「保存」写回 Config.data.achievements / titles 并持久化。'
    ],
    runtime: '成就进度由战斗/击杀等真实行为派生(achv 面板展示)；称谓与成就点影响角色属性与展示。',
    tips: [
      '成就触发条件为表达式。',
      '奖励 kv 如 exp=100 / item=11030001。',
      '有效期 0 = 永久有效。'
    ]
  },

  // ===== 六、研发调试与运营后台 =====
  sim: {
    domain: '（只读模拟，引用 skills/monsters）',
    purpose: '纯数值模拟「攻方怪物 × 技能 × 守方怪物 × 回合」的伤害与胜负，用于平衡性预估。',
    fields: [
      { label: '攻方怪物', hint: '下拉选 monsters' },
      { label: '守方怪物', hint: '下拉选 monsters' },
      { label: '技能', hint: '下拉选 skills（无则普攻）' },
      { label: '回合数', hint: '模拟轮数' },
      { label: '▶ 开始模拟', hint: '输出逐回合伤害日志' }
    ],
    steps: [
      '选攻方怪物、守方怪物与技能。',
      '设回合数（默认 5）。',
      '点「▶ 开始模拟」查看逐回合伤害与胜负日志。'
    ],
    runtime: '与真实战斗共用同一套 calcDamage（phys_damage，rand 固定取平均 0.5），因此模拟≈真实期望伤害。',
    tips: [
      'rand 固定取 0.5（平均伤害），便于稳定对比。',
      '模拟不消耗实际进度；改公式/技能后重跑可见变化。'
    ]
  },
  gm: {
    domain: '（即时写运行期 player / Config）',
    purpose: '运营/调试即时指令：刷物品、设等级、加金币、传送地图、召唤怪物战斗、开始副本、改属性、重置玩家。',
    fields: [
      { label: '刷物品(输入ID)', hint: '输入物品ID 入背包' },
      { label: '设等级 / 加金币', hint: '即时改 player' },
      { label: '传送地图 / 召唤怪物战斗', hint: '改 _curMapId / 进 enterBattle' },
      { label: '开始副本', hint: '调 ui.sm.startDungeon' },
      { label: '改属性 / 重置玩家', hint: '直接改 player 字段 / 清零' }
    ],
    steps: [
      '打开面板（需已登录，显示当前等级/金币）。',
      '点对应指令按钮，按提示输入 ID/数值。',
      '指令即时生效，写入运行期 player 与 Config（部分持久化）。'
    ],
    runtime: '刷物品入 p.bag；设等级/加金币即时改 player；传送改 _curMapId；召唤战斗进 enterBattle；开始副本进 startDungeon；改属性直接改 player 字段；重置清空等级/金币/背包/装备。',
    tips: [
      '指令即时生效，部分写入 Config 持久化。',
      '重置玩家会把等级/金币/背包/装备清零，谨慎使用。'
    ]
  },
  checker: {
    domain: '（只读扫描全量 Config）',
    purpose: '扫描全量配置，找出断链引用、价格异常与图标缺失，辅助排错。',
    fields: [
      { label: '扫描全量配置', hint: '点按钮开始' },
      { label: '问题清单', hint: '逐条列出：技能→buff / 怪物→技能 / 掉落→物品 / 副本→怪物 / 物品价格 / 图标缺失' }
    ],
    steps: [
      '打开面板，点「扫描全量配置」。',
      '查看问题清单（无问题显示通过）。'
    ],
    runtime: '只读检测，不改数据。检测：技能引用缺失 buff、怪物引用缺失技能/先天技能、掉落表引用缺失物品、副本波次引用缺失怪物、物品价格异常、技能/怪物未配置 icon。',
    tips: [
      '图标仅检查配置声明（不访问网络），运行时图标可达性需另行确认。',
      '发现问题后回到对应编辑器修正引用即可。'
    ]
  },
  economy: {
    domain: '（只读估算，引用 monsters/items/shop）',
    purpose: '只读估算货币产消比：怪物金币产出、物价区间、商城条目与高价物品 Top5。',
    fields: [
      { label: '仪表盘', hint: '怪物种类 / 金币产出合计 / 单怪平均 / 可交易物品 / 物价区间 / 商城条目' },
      { label: '高价物品 Top5', hint: '按 price 排序' }
    ],
    steps: [
      '打开面板查看仪表盘数值。',
      '调整掉落权重/商城价格可间接影响产消比（重开面板看变化）。'
    ],
    runtime: '只读展示：怪物 silver 求和估算产出、商城/商店 price 估算消耗、可交易物品与物价区间、高价物品 Top5。',
    tips: [
      '产出按怪物 silver 求和；消耗按商城 price 估算。',
      '实时金价波动需运行时采集，此处为静态估算。'
    ]
  },
  redeem: {
    domain: 'redeems',
    purpose: '生成与测试兑换码(TSQ 码)：礼包内容 = 物品ID=数量 + 金币。',
    fields: [
      { label: '礼包内容', hint: '物品ID=数量，每行一条' },
      { label: '金币 / 数量', hint: '附带金币 / 生成份数' },
      { label: '生成兑换码', hint: '写入 redeems 域并持久化' },
      { label: '测试兑换', hint: '粘贴码点兑换，即时入背包' }
    ],
    steps: [
      '填礼包内容（物品ID=数量，每行一条）与金币、数量。',
      '点「生成兑换码」，复制生成的 TSQ 码。',
      '点「兑换」可在此测试；玩家在兑换界面使用同码即生效。'
    ],
    runtime: '生成的码存入 Config.data.redeems 并持久化；玩家兑换时物品入 p.bag、金币累加，码即作废(删除)。',
    tips: [
      '礼包内容格式：物品ID=数量（每行一条）。',
      '兑换码前缀 TSQ；兑换一次后失效。'
    ]
  },
  pdoll: {
    domain: '（实时调试 Fighter 叠加层，引用 entities/fighter.js）',
    purpose: '研发期实时调试角色的纸娃娃叠加层：调整各叠加图层(z 层级 / dx·dy 偏移 / 可见性)、增删图层、切换翅膀显隐、预览模型缩放。所有操作直接作用于游戏内真实 Fighter 的 layers，关闭后会按设置保持。',
    fields: [
      { label: '调试目标', hint: '下拉选游戏内存活的 Fighter（Fighter._instances 枚举）' },
      { label: '刷新', hint: '重新枚举存活 Fighter' },
      { label: '显示翅膀 / 缩放', hint: '翅膀槽显隐(gated by showWings) / battleScale 预览' },
      { label: '叠加层列表', hint: '每个图层：Z / dx / dy / 可见 / 移除' },
      { label: '加图层 ID', hint: '输入 charId 叠加一个 doll: 图层' }
    ],
    steps: [
      '从工具台「六、研发调试与运营后台」打开本面板。',
      '在「调试目标」选一个存活角色（无则先进入战斗/主城）。',
      '在下方列表调整每个叠加层的 Z / dx / dy / 可见性，或点「移除」删层。',
      '用「显示翅膀」开关验证翅膀槽显隐；用「缩放」滑块预览 battleScale。',
      '输入 charId 点「叠加」可临时加一层做对照。'
    ],
    runtime: '直接调用 Fighter.setLayer / setLayerOffset / removeLayer / refreshPaperDoll：Z 改 el.style.zIndex；dx/dy 走 setLayerOffset 重定位；翅膀走 showWings + refreshPaperDoll 重建装备层；缩放写 battleScale 后 act 重放。',
    tips: [
      'z 层级对齐 AS3：身(底) < 武器 < 翅膀 < 法宝/如意(顶)。',
      '关闭面板不撤销已做的改动，刷新战斗/换模型会重建叠加层。'
    ]
  }
};

// ───────────────────────── 帮助面板 ─────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 由外部注入 TOOLS / TOOL_GROUPS，避免循环依赖
export function createToolHelpPanel(TOOLS, TOOL_GROUPS) {
  return class ToolHelpPanel extends BasePanel {
    constructor(ui) {
      super({ id: 'panel-toolhelp', title: '工具台使用帮助', width: 880, height: 640, ui, icon: { dir: 'res', file: 'facesystem.png' } });
      this._cat = 'all';
      this._sel = 'skill';
    }
    init() { this.render(); }
    onOpen() { this.render(); }

    _toolsOf(cat) {
      if (cat === 'all') return TOOL_GROUPS.reduce((a, g) => a.concat(g.tools), []);
      const g = TOOL_GROUPS.find(x => x.key === cat);
      return g ? g.tools : [];
    }

    _fieldHtml(key) {
      const def = TOOLS[key];
      const h = TOOL_HELP[key] || {};
      if (def && def.schema) {
        // schema 工具：自动从 schema 生成字段说明
        return Object.keys(def.schema).map(fk => {
          const f = def.schema[fk];
          const req = f.required ? ' <i class="th-req">*</i>' : '';
          const hint = f.hint ? `<span class="th-f-hint">${esc(f.hint)}</span>` : '';
          return `<div class="th-f"><b>${esc(f.label || fk)}</b>${req}${hint}</div>`;
        }).join('');
      }
      if (h.fields && h.fields.length) {
        return h.fields.map(f => `<div class="th-f"><b>${esc(f.label)}</b>${f.hint ? `<span class="th-f-hint">${esc(f.hint)}</span>` : ''}</div>`).join('');
      }
      return '<div class="th-f-note">无表单：通过按钮 / 文本框直接操作（见下方使用步骤）。</div>';
    }

    render() {
      if (!this.ui) return;
      const cats = [{ key: 'all', label: '全部工具' }].concat(TOOL_GROUPS.map(g => ({ key: g.key, label: g.label })));
      const tools = this._toolsOf(this._cat);
      const catHtml = cats.map(c => `<button class="th-cat ${c.key === this._cat ? 'on' : ''}" data-cat="${c.key}">${esc(c.label)}</button>`).join('');
      const toolHtml = tools.map(t => {
        const d = TOOLS[t];
        return `<button class="th-tool ${t === this._sel ? 'on' : ''}" data-tool="${t}">${esc(d.title)}</button>`;
      }).join('');

      const h = TOOL_HELP[this._sel] || {};
      const dom = h.domain || (TOOLS[this._sel] && TOOLS[this._sel].domain) || '—';
      const steps = (h.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
      const tips = (h.tips || []).map(s => `<li>${esc(s)}</li>`).join('');
      const detail = `
        <div class="th-d-h">${esc(TOOLS[this._sel] ? TOOLS[this._sel].title : this._sel)}</div>
        <div class="th-d-sec"><h4>用途</h4><p>${esc(h.purpose || '—')}</p></div>
        <div class="th-d-sec"><h4>编辑配置域</h4><p class="th-dom">${esc(dom)}</p></div>
        <div class="th-d-sec"><h4>关键字段</h4><div class="th-fields">${this._fieldHtml(this._sel)}</div></div>
        <div class="th-d-sec"><h4>使用步骤</h4><ol>${steps || '<li>—</li>'}</ol></div>
        <div class="th-d-sec"><h4>运行期效果</h4><p>${esc(h.runtime || '—')}</p></div>
        <div class="th-d-sec"><h4>提示</h4><ul>${tips || '<li>—</li>'}</ul></div>
        <button class="pb-btn th-open" data-open="tool_${esc(this._sel)}">打开此工具</button>`;

      this.setContent(`
        <div class="th-wrap">
          <div class="th-side">
            <div class="th-cats">${catHtml}</div>
            <div class="th-tools">${toolHtml}</div>
          </div>
          <div class="th-main">${detail}</div>
        </div>`);

      this.body.querySelectorAll('.th-cat').forEach(b => b.onclick = () => { this._cat = b.dataset.cat; this.render(); });
      this.body.querySelectorAll('.th-tool').forEach(b => b.onclick = () => { this._sel = b.dataset.tool; this.render(); });
      const openBtn = this.body.querySelector('.th-open');
      if (openBtn) openBtn.onclick = () => { try { panelManager.open(openBtn.dataset.open); } catch (e) {} };
    }
  };
}

// 注册「工具台使用帮助」面板（key: toolhelp）
export function registerToolHelp(panelManager, ui, TOOLS, TOOL_GROUPS) {
  const Cls = createToolHelpPanel(TOOLS, TOOL_GROUPS);
  panelManager.register('toolhelp', () => new Cls(ui));
}
