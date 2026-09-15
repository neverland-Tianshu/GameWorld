// workbench.js — 研发/运营工具台：7 大类 26 个配置/调试工具
// 数据编辑类工具（schema 驱动）→ SchemaEditor；功能类工具（模拟/检测/GM/兑换码/监控）→ ToolPanel 自定义。
// 全部面板注册到 panelManager，由 WorkbenchPanel 统一入口按大类分组。

import { BasePanel, panelManager } from '../ui/panel-manager.js?v=20261007c';
import { Config, persistConfig } from '../core/globals.js?v=20261007c';
import { calcDamage } from '../core/rt.js?v=20261007c';
import { SchemaEditor, ToolPanel } from './kernel.js?v=20261007c';
import { registerToolHelp } from './help.js?v=20261007c';
import { renderMapNpc } from './mapnpc.js?v=20261007c';
import { PaperDollPanel } from './paperdoll-debug.js?v=20261007c';

// 右侧独立栏宽度（与 css/style.css --sidebar-w、scene.js SIDEBAR_W 保持一致；研发工具台镜头预览对齐缩小后的游戏主窗口）
const SIDEBAR_W = () => Math.round((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.15);

// ───────────────────────── 工具定义 ─────────────────────────
// 每个 schema 工具的字段严格对齐游戏运行期实际消费的字段 + 工具所需的扩展字段（真实配置扩展，非假数据）。

export const TOOLS = {
  // ===== 一、战斗核心体系 =====
  skill: {
    id: 'tool-skill', title: '技能编辑器', domain: 'skills', width: 820, height: 600,
    icon: { dir: 'res', file: 'facejineng.png' },
    nameField: 'name', tagField: 'xinfa',
    levelEditor: true,   // 启用「逐等级」分表编辑：下方自动出现等级 chip + 逐等级 法力/CD/威力/治疗 + 公式系数覆盖
    schema: {
      id: { label: '技能ID', type: 'text', required: true, hint: '与 SkillIcon 资源名一致；同时决定技能演出资源 resource/skill/{id}（方向片 {id}_lr / {id}_rl，施法者居左→_lr、居右→_rl）' },
      name: { label: '名称', type: 'text', required: true },
      icon: { label: '图标', type: 'text', hint: 'Skill_xxxx.png' },
      charId: { label: '门派(charId)', type: 'number' },
      xinfa: { label: '心法', type: 'select', options: ['brave', 'diligent', 'confident', 'penetrate', 'mercy', 'pity', 'confuse', 'life'] },
      dtype: { label: '伤害类型', type: 'select', options: ['phys', 'magic'], default: 'phys', hint: 'physical/magic：genericCast 依此判 isMagic，magic 走魔攻 mag、phys 走物攻 atk' },
      effect: { label: '施法特效', type: 'text', hint: 'fanvas 特效名（技能自带 SWF 缺失时的回退演出）' },
      anim: { label: '演出动画资源', type: 'text', hint: 'resource/skill/{anim} 目录名；留空=与技能ID同名的演出资源（动画可不与ID相符，编辑器可调）' },
      target: { label: '目标选择', type: 'select', options: ['enemy', 'all_enemy', 'cross', 'random', 'lowhp', 'self', 'ally', 'enemyOrAlly'], default: 'enemy', hint: '单体/群体/十字/随机/血量最低/自身/友方/敌我皆可（enemyOrAlly：施放时由玩家在敌/友间选择目标）' },
      shape: { label: '几何形状', type: 'select', options: ['', 'cross'], default: '', hint: '十字技能选 cross：特效落点对准点选目标而非屏幕中心（scene._castVisual 据此短路 isGroup）；留空=常规。与 target=cross 配合即「点选目标的十字」' },
      mpCost: { label: '法力消耗(默认)', type: 'number', default: 0, hint: '未在该等级单独设定时使用的默认值；逐等级覆盖见下方「逐等级数值」' },
      power: { label: '伤害系数(默认)', type: 'number', step: 0.1, default: 1, hint: '最终伤害 = atk*power - def；未在该等级单独设定时使用的默认值' },
      heal: { label: '治疗量(默认)', type: 'number', default: 0, hint: '未在该等级单独设定时使用的默认值' },
      cd: { label: '冷却回合(默认)', type: 'number', default: 0, hint: '未在该等级单独设定时使用的默认值' },
      rage: { label: '怒气消耗', type: 'number', default: 0 },
      baseHitRate: { label: '基础命中率(%)', type: 'number', default: 90, hint: '技能命中判定的基础命中率（在 90 基准上；必定命中勾选后此值失效）。与承受者闪避/施法者命中共同决定实际命中' },
      alwaysHit: { label: '必定命中', type: 'boolean', default: false, hint: '勾选后该技能无视闪避判定（如必中控制技）' },
      buffs: {
        label: 'buff 添加（结构化）', type: 'table',
        hint: '每个条目 = 一次 buff 添加：添加时机 / 添加目标 / 添加概率 / 关联 buff。运行期由 skill-engine 的 applyBuffSpecs 在对应时机统一施加。',
        sub: {
          timing: { label: '添加时机', type: 'select', options: ['onCast', 'onHit', 'onKill', 'turnStart'], default: 'onCast' },
          target: { label: '添加目标', type: 'select', options: ['self', 'primary', 'targets', 'allAllies', 'allEnemies', 'all', 'randomEnemy'], default: 'targets' },
          prob: { label: '概率类型', type: 'select', options: ['guaranteed', 'chance', 'formula'], default: 'guaranteed', hint: '必定 / 指定概率(0-1) / 公式' },
          chance: { label: '概率值(0-1)', type: 'number', default: 1, step: 0.05, hint: 'prob=chance 时生效' },
          formula: { label: '概率公式', type: 'text', hint: 'prob=formula 时生效；可用 rand()/caster/target/xw(fig)，如 xw(caster)>xw(target) && rand()<0.4' },
          buff: { label: 'buff', type: 'idref-ref', ref: 'buffs', hint: '指向 buffs.json 的状态 ID' },
          link: { label: '关联buff', type: 'text', hint: '逗号分隔的 buff ID，与本 buff 同时施加（如 freeze,weak,slow）' },
          side: { label: '侧别过滤', type: 'select', options: ['none', 'self', 'ally', 'enemy'], default: 'none', hint: '本条目施加时的侧别限制：none=不限 / self=仅施法者 / ally=同侧（含施法者）/ enemy=异侧。例：八荒六合 neili 仅友方→选 ally' },
          duration: { label: '时长覆盖', type: 'number', default: 0, hint: '0=用 buffs.json 默认时长' }
        }
      },
      sealResist: { label: '封印命中抗性公式', type: 'expression', hint: '如 hit*(1-sealRes/100)，运行期由公式编辑器求值' },
      link: { label: '联动触发(套装/经脉/符石)', type: 'json', hint: '[\"set_烈火套\",\"meridian_3\"]' },
      desc: { label: '描述', type: 'textarea' },
      maxLevel: { label: '最大等级', type: 'number', default: 1, hint: '技能可学最高等级（等级动画选档参考；运行期按 caster.skillLevels[技能ID] 取当前等级）' },
      levelAnims: { label: '等级动画(随等级换演出)', type: 'table', sub: { level: { label: '等级', type: 'number', default: 1 }, anim: { label: '动画资源', type: 'text', hint: '该等级使用的 resource/skill/{anim} 目录名（取 ≤当前等级 的最高一档）' } } }
    }
  },
  buff: {
    id: 'tool-buff', title: 'Buff/状态编辑器', domain: 'buffs', width: 760, height: 580,
    icon: { dir: 'res', file: 'facesystem.png' },
    seed: {}, nameField: 'name', tagField: 'kind',
    schema: {
      id: { label: '状态ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      icon: { label: '状态图标', type: 'text' },
      anim: { label: '状态动画资源', type: 'text', hint: 'resource/battle/{anim} 目录名；留空=按 kind 默认映射(1减速/2虚弱/4眩晕/8中毒)。可不与 kind 的默认资源同名，编辑器可调' },
      kind: { label: '类型', type: 'select', options: ['buff', 'debuff', 'seal', 'poison', 'burn', 'stun', 'sleep', 'taunt', 'confusion', 'breakarmor', 'insight', 'neili', 'link', 'fugu', 'chuanxin', 'feihua', 'xianqi', 'haotian', 'xianyin', 'dongdi', 'ningshen', 'bahuang', 'statbuff', 'freeze', 'weak', 'slow'], default: 'buff', hint: '运行期实际消费的 kind（taunt/confusion/stun/sleep/feihua/chuanxin/statbuff/link 等均有专属逻辑）' },
      duration: { label: '持续回合', type: 'number', default: 2 },
      stack: { label: '叠加层数', type: 'number', default: 1 },
      trigger: { label: '生效时机', type: 'select', options: ['回合开始', '受击时', '施法前', '回合结束'], default: '回合开始' },
      dispelPriority: { label: '驱散优先级', type: 'number', default: 0, hint: '数值高者优先被驱散' },
      immune: { label: '免疫规则', type: 'list', hint: '每行一个免疫的状态类型，如 seal；Fighter.hasBuffType 据此判定免疫' },
      color: { label: '状态颜色', type: 'text', hint: 'buffs.json color 字段，状态条/图标着色' },
      // 以下字段真实影响战斗运行期（Fighter.tickBuffs / _calcDamage / _applyStatAdd 消费）
      atkPct: { label: '攻击加成(%)', type: 'number', default: 0, hint: '按叠加层数放大进攻侧伤害' },
      defPct: { label: '防御加成(%)', type: 'number', default: 0, hint: '按叠加层数放大防御侧减免' },
      dot: { label: '每回合持续伤害', type: 'number', default: 0, hint: '中毒/灼烧每回合掉血' },
      heal: { label: '每回合回复', type: 'number', default: 0, hint: '再生/护盾每回合回血' },
      statAdd: { label: '即时属性加成', type: 'json', hint: '{"atk":0,"def":0,"mag":0,"spd":0,"recover":0}：addBuff 时叠加、过期/破盾时回退（圣灵/暗影魔咒/恸地等）' },
      floatText: { label: '飘字', type: 'text', hint: '受击/生效时飘出的文字' },
      desc: { label: '描述', type: 'textarea' }
    }
  },
  ai: {
    id: 'tool-ai', title: '战斗AI编辑器', domain: 'ai', width: 860, height: 620,
    icon: { dir: 'res', file: 'facebattlepoints.png' },
    seed: {}, nameField: 'monsterId', tagField: 'kind',
    schema: {
      monsterId: { label: '怪物', type: 'idref', ref: 'monsters', required: true },
      kind: { label: '类型', type: 'select', options: ['普通', '精英', 'BOSS'], default: '普通' },
      targetPref: { label: '目标选择偏好', type: 'select', options: ['血量最低', '随机', '前排', '后排', '最高威胁'], default: '随机' },
      priority: { label: '技能释放优先级', type: 'table', sub: { skill: { label: '技能', type: 'idref-ref', ref: 'skills' }, weight: { label: '权重', type: 'number', default: 1 } } },
      hpThreshold: { label: '血量阈值触发', type: 'table', sub: { hp: { label: '血量%', type: 'number', default: 50 }, action: { label: '动作', type: 'select', options: ['释放技能', '召唤小怪', '逃跑', '阶段切换'] }, skill: { label: '技能', type: 'idref-ref', ref: 'skills' } } },
      phase: { label: '阶段切换机制', type: 'table', sub: { phase: { label: '阶段', type: 'number', default: 2 }, atHp: { label: '触发血量%', type: 'number', default: 30 }, skill: { label: '技能', type: 'idref-ref', ref: 'skills' } } },
      summon: { label: '召唤小怪', type: 'table', sub: { mob: { label: '怪物', type: 'idref-ref', ref: 'monsters' }, count: { label: '数量', type: 'number', default: 1 } } },
      fleeRate: { label: '逃跑概率(0-1)', type: 'number', step: 0.05, default: 0 }
    }
  },

  // ===== 二、宠物/召唤兽体系 =====
  monsterpet: {
    id: 'tool-monsterpet', title: '怪物宠物全属性编辑器', domain: 'monsters', width: 860, height: 620,
    icon: { dir: 'res', file: 'facepetchest.png' },
    nameField: 'name',
    schema: {
      id: { label: 'ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      charId: { label: '模型(charId)', type: 'number' },
      level: { label: '等级', type: 'number', default: 1 },
      hp: { label: '生命', type: 'number', default: 100 }, mp: { label: '法力', type: 'number', default: 0 },
      atk: { label: '攻击', type: 'number', default: 10 }, def: { label: '防御', type: 'number', default: 5 },
      mag: { label: '法攻', type: 'number', default: 0 }, spd: { label: '速度', type: 'number', default: 5 },
      exp: { label: '经验', type: 'number', default: 10 }, silver: { label: '银子', type: 'number', default: 1 },
      skills: { label: '技能', type: 'idlist', ref: 'skills' },
      carryLevel: { label: '携带等级', type: 'number', default: 1 },
      aptMin: { label: '资质下限', type: 'number', default: 100 }, aptMax: { label: '资质上限', type: 'number', default: 150 },
      growthMin: { label: '成长下限', type: 'number', default: 1 }, growthMax: { label: '成长上限', type: 'number', default: 1.5 },
      innateSkills: { label: '天生技能池', type: 'idlist', ref: 'skills' },
      skillSlots: { label: '技能格数量', type: 'number', default: 3 },
      mutation: { label: '变异概率(0-1)', type: 'number', step: 0.05, default: 0 },
      aptBonus: { label: '变异资质加成', type: 'number', default: 20 },
      taunt: { label: '开场挑衅语', type: 'list', hint: '每行一句；开局按下方概率随机发一句（复用战斗内头顶气泡）。同类怪多只时各自独立掷骰' },
      tauntRate: { label: '挑衅概率(0-1)', type: 'number', step: 0.05, default: 0, hint: '1=必定挑衅；0=从不；混合怪群中每个单位按自己模板的概率独立判定' }
    }
  },
  pillmount: {
    id: 'tool-pillmount', title: '内丹/坐骑统御编辑器', domain: 'pills', width: 820, height: 600,
    icon: { dir: 'res', file: 'panelridepetbg.png' },
    seed: {}, nameField: 'name', tagField: 'type',
    schema: {
      id: { label: 'ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      type: { label: '类型', type: 'select', options: ['内丹', '坐骑'], default: '内丹' },
      layerEffect: { label: '层数效果', type: 'table', sub: { layer: { label: '层数', type: 'number', default: 1 }, effect: { label: '效果', type: 'text' } } },
      mountSkill: { label: '坐骑技能', type: 'idref', ref: 'skills' },
      controlRule: { label: '统御加成规则', type: 'expression', hint: '如 atk*(1+layer*0.05)' },
      growth: { label: '坐骑成长', type: 'number', default: 1, step: 0.1 },
      affection: { label: '好感度影响', type: 'expression', hint: '好感度对属性的影响公式' },
      desc: { label: '描述', type: 'textarea' }
    }
  },

  // ===== 三、任务剧情与副本生产 =====
  quest: {
    id: 'tool-quest', title: '可视化任务编辑器', domain: 'quests', width: 860, height: 620,
    icon: { dir: 'res', file: 'faceboard.png' },
    nameField: 'name', tagField: 'type',
    schema: {
      id: { label: '任务ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      type: { label: '类型', type: 'select', options: ['主线', '支线', '师门', '环任务'], default: '支线' },
      giver: { label: '发布NPC', type: 'idref', ref: 'npcs' },
      target: { label: '条件', type: 'kv', hint: 'type=monster / monster=m_boar / count=10' },
      branch: { label: '分支选择', type: 'table', sub: { cond: { label: '条件', type: 'text' }, next: { label: '跳转任务', type: 'text' } } },
      reward: { label: '奖励', type: 'kv', hint: 'exp=500 / silver=200 / item=11030001' },
      dialogue: { label: 'NPC对话跳转', type: 'table', sub: { npc: { label: 'NPC', type: 'idref-ref', ref: 'npcs' }, text: { label: '对话', type: 'text' }, next: { label: '下一任务', type: 'text' } } },
      track: { label: '任务追踪UI', type: 'boolean', default: true },
      desc: { label: '描述', type: 'textarea' }
    }
  },
  story: {
    id: 'tool-story', title: '剧情演出编辑器', domain: 'stories', width: 880, height: 620,
    icon: { dir: 'res', file: 'faceboard.png' }, custom: 'story'
  },
  dungeon: {
    id: 'tool-dungeon', title: '副本规则编辑器', domain: 'dungeons', width: 880, height: 640,
    icon: { dir: 'res', file: 'facenpc.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '副本ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      entry: { label: '准入条件', type: 'kv', hint: 'level=30 / count=5 / pre=quest_1' },
      waves: { label: '战斗波次', type: 'table', sub: { mob: { label: '怪物组', type: 'idref-ref', ref: 'monsters' }, count: { label: '数量', type: 'number', default: 1 } } },
      bossPhase: { label: 'BOSS阶段机制', type: 'table', sub: { phase: { label: '阶段', type: 'number', default: 2 }, atHp: { label: '触发血量%', type: 'number', default: 50 }, skill: { label: '技能', type: 'idref-ref', ref: 'skills' } } },
      dropRule: { label: '掉落分配', type: 'idref', ref: 'drops' },
      clearCond: { label: '通关条件', type: 'text' },
      saveProgress: { label: '进度保存', type: 'boolean', default: true },
      weeklyLimit: { label: '每周次数', type: 'number', default: 3 }
    }
  },
  encounter: {
    id: 'tool-encounter', title: '暗雷/明雷规则编辑器', domain: 'encounters', width: 860, height: 620,
    icon: { dir: 'res', file: 'facemap.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '规则ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      mapId: { label: '地图', type: 'idref', ref: 'maps', required: true },
      rate: { label: '遇敌概率(0-1)', type: 'number', step: 0.05, default: 0.15 },
      darkGroup: { label: '暗雷怪物组合', type: 'table', sub: { mob: { label: '怪物', type: 'idref-ref', ref: 'monsters' }, weight: { label: '权重', type: 'number', default: 1 } } },
      darkPick: { label: '抽怪方式', type: 'select', options: ['perUnit', 'once'], default: 'perUnit', hint: 'perUnit=每个敌人按权重独立抽（混合怪群，默认）；once=整场同一只' },
      bright: { label: '明雷NPC', type: 'table', sub: { mob: { label: '怪物', type: 'idref-ref', ref: 'monsters' }, route: { label: '巡逻路线', type: 'text', hint: 'x1,y1;x2,y2' }, cond: { label: '触发条件', type: 'text' } } },
      cond: { label: '触发战斗条件', type: 'text' }
    }
  },

  // ===== 四、经济与社交系统 =====
  drop: {
    id: 'tool-drop', title: '掉落权重编辑器', domain: 'drops', width: 880, height: 640,
    icon: { dir: 'res', file: 'faceshop.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '掉落表ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      source: { label: '来源', type: 'idref', ref: 'monsters', hint: '也可指向副本(dungeons)' },
      table: { label: '掉落表', type: 'table',
        sub: {
          item: { label: '物品', type: 'idref-ref', ref: 'items' },
          weight: { label: '权重', type: 'number', default: 10 },
          qmin: { label: '数量下限', type: 'number', default: 1 },
          qmax: { label: '数量上限', type: 'number', default: 1 },
          bind: { label: '绑定', type: 'select', options: ['否', '是', '随机'], default: '否' },
          floor: { label: '保底次数', type: 'number', default: 0, hint: '0=无保底' },
          rare: { label: '稀有保护', type: 'boolean', default: false }
        } }
    }
  },
  trade: {
    id: 'tool-trade', title: '商会/交易行配置', domain: 'trade', width: 800, height: 560,
    icon: { dir: 'res', file: 'faceshop.png' },
    seed: [], array: true, nameField: 'name',
    schema: {
      name: { label: '规则名', type: 'text', required: true },
      categories: { label: '可交易分类', type: 'list', hint: '每行一个物品 type，如 weapon' },
      tax: { label: '摆摊税率(%)', type: 'number', default: 5 },
      showDays: { label: '公示期(天)', type: 'number', default: 1 },
      priceMin: { label: '价格下限', type: 'number', default: 1 },
      priceMax: { label: '价格上限', type: 'number', default: 999999 },
      cooldown: { label: '交易冷却(秒)', type: 'number', default: 0 },
      crossServer: { label: '跨服交易', type: 'boolean', default: false }
    }
  },
  shop: {
    id: 'tool-shop', title: '商城与礼包编辑器', domain: 'shop', width: 860, height: 600,
    icon: { dir: 'res', file: 'faceshop.png' },
    seed: {}, nameField: 'name', tagField: 'type',
    schema: {
      id: { label: '商品ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      item: { label: '道具', type: 'idref', ref: 'items' },
      type: { label: '类型', type: 'select', options: ['商品', '限购礼包', '折扣活动', '充值档位'], default: '商品' },
      price: { label: '价格', type: 'number', default: 0 },
      limit: { label: '限购数量', type: 'number', default: 0, hint: '0=不限' },
      discount: { label: '折扣(0-1)', type: 'number', step: 0.1, default: 1 },
      time: { label: '限时上架', type: 'text', hint: '如 2026-08-01~2026-08-31' },
      channel: { label: '渠道专属', type: 'text', hint: '留空=全渠道' }
    }
  },
  guild: {
    id: 'tool-guild', title: '帮派系统配置', domain: 'guild', width: 840, height: 600,
    icon: { dir: 'res', file: 'faceplayershortcut.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '配置ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      buildRule: { label: '建筑升级规则', type: 'json' },
      skill: { label: '帮派技能', type: 'idlist', ref: 'skills' },
      warRule: { label: '帮战匹配规则', type: 'text' },
      tradeRule: { label: '跑商规则', type: 'text' },
      welfare: { label: '帮派福利', type: 'text' },
      contestReward: { label: '竞赛奖励', type: 'text' }
    }
  },
  bot: {
    id: 'tool-bot', title: '机器人配置', domain: 'bots', width: 820, height: 560,
    icon: { dir: 'res', file: 'facepetchest.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: 'ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      mapId: { label: '地图', type: 'idref', ref: 'maps' },
      behavior: { label: '行为', type: 'select', options: ['巡逻', '站桩', '追击'], default: '站桩' },
      route: { label: '巡逻路线', type: 'list', hint: '每行 x,y' },
      chat: { label: '发言', type: 'list' },
      level: { label: '等级', type: 'number', default: 1 },
      ai: { label: 'AI', type: 'idref', ref: 'ai' }
    }
  },

  // ===== 七、世界与基础数据（地图·NPC / 物品） =====
  mapnpc: {
    id: 'tool-mapnpc', title: '地图·NPC可视化编辑器', domain: 'maps', width: 1180, height: 780,
    icon: { dir: 'res', file: 'facemap.png' },
    custom: 'mapnpc',
    hint: '地图选取路遮罩(0障碍/1可走/2遮挡) + 放置/拖动NPC + 编辑NPC功能；保存写回 maps.json 与 npcs.json'
  },
  item: {
    id: 'tool-item', title: '物品编辑器', domain: 'items', width: 880, height: 640,
    icon: { dir: 'res', file: 'facechest.png' },
    nameField: 'name', tagField: 'type',
    schema: {
      id: { label: '物品ID', type: 'text', required: true, hint: '数字 ID（如 11010001）；同时决定图标 Item_{id}.png 命名' },
      name: { label: '名称', type: 'text', required: true },
      icon: { label: '图标', type: 'text', hint: 'Item_xxxx.png' },
      type: { label: '类型', type: 'select', options: ['potion', 'weapon', 'armor', 'quest', 'gem', 'rune', 'material'], default: 'potion', hint: 'potion 消耗品/weapon 武器/armor 防具/quest 任务/gem 宝石/rune 符石/material 材料（shop/drop/trade 按 type 过滤）' },
      desc: { label: '描述', type: 'textarea' },
      effect: { label: '效果属性', type: 'json', default: {}, hint: '{"hp":200}回血/{"mp":150}回蓝/{"atk":15}加攻/{"def":20}加防；运行期按 key 直接加成（net/fighter/scene 消费）' },
      price: { label: '价格', type: 'number', default: 0 },
      stack: { label: '最大堆叠', type: 'number', default: 1, hint: '背包内同物品可叠加数量（fighter 背包逻辑消费）' },
      bind: { label: '绑定', type: 'select', options: ['否', '是', '随机'], default: '否', hint: '绑定后不可交易（bag/掉落逻辑消费）' }
    }
  },

  // ===== 五、角色养成线 =====
  equip: {
    id: 'tool-equip', title: '装备深度编辑器', domain: 'items', width: 880, height: 640,
    icon: { dir: 'res', file: 'facechest.png' },
    nameField: 'name', tagField: 'type',
    schema: {
      id: { label: '物品ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      type: { label: '类型', type: 'select', options: ['weapon', 'armor', 'potion', 'quest', 'gem', 'rune'], default: 'weapon' },
      effect: { label: '基础属性', type: 'json', hint: '{\"atk\":15}' },
      price: { label: '价格', type: 'number', default: 0 },
      forgeRule: { label: '打造规则', type: 'text' },
      meltRange: { label: '熔炼属性区间', type: 'text', hint: '如 atk+5~15' },
      gemRule: { label: '宝石镶嵌规则', type: 'text', hint: '可镶嵌孔数/类型' },
      holes: { label: '开孔数', type: 'number', default: 0 },
      runeCombo: { label: '符石组合效果', type: 'expression' },
      teji: { label: '特技', type: 'text' },
      texiaoRate: { label: '特效触发概率(0-1)', type: 'number', step: 0.05, default: 0 },
      setEffect: { label: '套装集齐效果', type: 'json' },
      repair: { label: '修理失败规则', type: 'text' }
    }
  },
  heart: {
    id: 'tool-heart', title: '心法消耗编辑器', domain: 'xinfa', width: 860, height: 620,
    icon: { dir: 'res', file: 'facejineng.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '心法ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      levels: { label: '层级', type: 'number', default: 10 },
      cost: { label: '升级消耗', type: 'table', sub: { lv: { label: '层级', type: 'number', default: 1 }, exp: { label: '经验', type: 'number', default: 100 }, silver: { label: '银两', type: 'number', default: 50 } } },
      unlockLevel: { label: '解锁等级', type: 'number', default: 1 },
      feature: { label: '门派特色', type: 'text' },
      meridian: { label: '奇经八脉节点', type: 'table', sub: { node: { label: '节点', type: 'text' }, effect: { label: '效果', type: 'text' }, branch: { label: '分支', type: 'text' } } }
    }
  },
  formula: {
    id: 'tool-formula', title: '属性公式编辑器', domain: 'formulas', width: 820, height: 560,
    icon: { dir: 'res', file: 'faceexp.png' },
    seed: {}, nameField: 'name',
    schema: {
      id: { label: '公式ID', type: 'text', required: true },
      name: { label: '名称', type: 'text', required: true },
      params: { label: '参数', type: 'list', hint: '每行一个参数名，如 atk/def/level' },
      expr: { label: '公式', type: 'expression', required: true, hint: '如 atk*power - def*0.5' },
      desc: { label: '说明', type: 'textarea' }
    }
  },
  achievement: {
    id: 'tool-achv', title: '成就与称谓编辑器', domain: 'achievements', width: 900, height: 620,
    icon: { dir: 'res', file: 'faceexp.png' }, custom: 'achv'
  },

  // ===== 六、研发调试与运营后台 =====
  sim: { id: 'tool-sim', title: '战斗模拟器', domain: 'skills', icon: { dir: 'res', file: 'facebattlepoints.png' }, custom: 'sim' },
  gm: { id: 'tool-gm', title: 'GM指令后台', domain: 'player', icon: { dir: 'res', file: 'facesystem.png' }, custom: 'gm' },
  pdoll: { id: 'tool-pdoll', title: '纸娃娃叠加层调试', domain: 'items', icon: { dir: 'res', file: 'facesystem.png' } },
  checker: { id: 'tool-checker', title: '数据一致性检测', domain: 'monsters', icon: { dir: 'res', file: 'facesystem.png' }, custom: 'checker' },
  economy: { id: 'tool-economy', title: '经济监控后台', domain: 'monsters', icon: { dir: 'res', file: 'faceshop.png' }, custom: 'economy' },
  redeem: { id: 'tool-redeem', title: '兑换码后台', domain: 'redeems', icon: { dir: 'res', file: 'facenpc.png' }, custom: 'redeem', seed: {} }
};

// 成就与称谓：双域(achievements/titles)内联编辑器
function renderAchv(root, ui) {
  const achSchema = {
    id: 'ID', name: '名称', cond: '触发条件(表达式)', points: '成就点', reward: '奖励(kv)', titleBonus: '称谓属性加成', expire: '有效期(天,0=永久)'
  };
  const titleSchema = { id: 'ID', name: '称谓', attr: '属性加成', valid: '有效期(天,0=永久)' };
  function ensure(d) { if (!Config.data[d]) { try { const o = localStorage.getItem('tsqt.cfg.' + d); Config.data[d] = o ? JSON.parse(o) : {}; } catch (e) { Config.data[d] = {}; } } return Config.data[d]; }
  function save(d, obj) { ensure(d); Config.data[d] = obj; persistConfig(d, obj); }
  function draw() {
    const ach = ensure('achievements'), tit = ensure('titles');
    const achRows = Object.keys(ach).map(k => `<div class="te-item" data-d="achievements" data-k="${k}">${k}</div>`).join('') || '<div class="te-empty">空</div>';
    const titRows = Object.keys(tit).map(k => `<div class="te-item" data-d="titles" data-k="${k}">${k}</div>`).join('') || '<div class="te-empty">空</div>';
    root.innerHTML = `<div class="te-wrap"><div class="te-list"><div class="te-list-h">成就 ${Object.keys(ach).length}</div><div class="te-list-b">${achRows}</div><button class="pb-btn te-new" data-d="achievements">＋ 成就</button></div>
      <div class="te-list"><div class="te-list-h">称谓 ${Object.keys(tit).length}</div><div class="te-list-b">${titRows}</div><button class="pb-btn te-new" data-d="titles">＋ 称谓</button></div>
      <div class="te-editor" id="achv-ed">← 选择条目</div></div>`;
    root.querySelectorAll('.te-item').forEach(it => it.onclick = () => edit(it.dataset.d, it.dataset.k));
    root.querySelectorAll('.te-new').forEach(b => b.onclick = () => edit(b.dataset.d, null));
  }
  function edit(d, k) {
    const obj = ensure(d);
    const sch = d === 'achievements' ? achSchema : titleSchema;
    const rec = k ? JSON.parse(JSON.stringify(obj[k] || {})) : {};
    const fields = Object.keys(sch).map(fk => {
      let v = rec[fk];
      if (fk === 'reward' && typeof v === 'object') v = Object.entries(v || {}).map(([a, b]) => a + '=' + b).join('\n');
      return `<div class="te-field"><label class="te-fl">${sch[fk]}</label>${fk === 'reward' ? `<textarea class="te-in" data-f="${fk}" rows="3">${v || ''}</textarea>` : `<input class="te-in" data-f="${fk}" value="${v == null ? '' : v}"/>`}</div>`;
    }).join('');
    const ed = root.querySelector('#achv-ed');
    ed.innerHTML = `<div class="te-form"><div class="te-form-h">${k ? '编辑 ' + k : '新建'}</div>${fields}<div class="te-form-f"><button class="pb-btn te-save">保存</button><button class="pb-btn ghost te-del">删除</button></div></div>`;
    ed.querySelector('.te-save').onclick = () => {
      const out = {};
      ed.querySelectorAll('[data-f]').forEach(el => {
        let val = el.value;
        if (el.dataset.f === 'reward') { const o = {}; val.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); val = o; }
        else if (['points', 'expire', 'valid'].includes(el.dataset.f)) val = Number(val) || 0;
        out[el.dataset.f] = val;
      });
      if (!out.id) { ui.toast('ID 必填'); return; }
      obj[out.id] = out; save(d, obj); draw(); ui.toast('已保存');
    };
    ed.querySelector('.te-del').onclick = () => { if (k) { delete obj[k]; save(d, obj); draw(); } };
  }
  draw();
}

// 战斗模拟器
function renderSim(root, ui) {
  const names = (d) => { const o = Config.data[d] || {}; const m = {}; Object.values(o).forEach(r => { if (r && r.id != null) m[r.id] = r.name || r.id; }); return m; };
  const mobs = names('monsters'), skills = names('skills');
  const mobOpts = Object.keys(mobs).map(id => `<option value="${id}">${id} · ${mobs[id]}</option>`).join('');
  const skOpts = Object.keys(skills).map(id => `<option value="${id}">${id} · ${skills[id]}</option>`).join('') || '<option>无技能</option>';
  root.innerHTML = `<div class="te-sim">
    <div class="te-sim-row">攻方怪物 <select id="sim-a">${mobOpts}</select></div>
    <div class="te-sim-row">守方怪物 <select id="sim-d">${mobOpts}</select></div>
    <div class="te-sim-row">技能 <select id="sim-s">${skOpts}</select></div>
    <div class="te-sim-row">回合数 <input id="sim-r" type="number" value="5" min="1" style="width:80px"/></div>
    <button class="pb-btn te-sim-go">▶ 开始模拟</button>
    <div class="te-sim-log" id="sim-log"></div></div>`;
  root.querySelector('.te-sim-go').onclick = () => {
    const a = Config.data.monsters[root.querySelector('#sim-a').value];
    const d = Config.data.monsters[root.querySelector('#sim-d').value];
    const sid = root.querySelector('#sim-s').value;
    const sk = Config.data.skills[sid];
    const rounds = Math.max(1, +root.querySelector('#sim-r').value || 5);
    if (!a || !d) { ui.toast('请选择怪物'); return; }
    let ah = a.hp, dh = d.hp, log = '';
    for (let r = 1; r <= rounds; r++) {
      // 与真实战斗共用同一套公式求值（phys_damage，rand 取平均 0.5）
      const dmgA = calcDamage(a, d, { power: sk ? (sk.power || 1) : 1, rand: 0.5, formulaId: 'phys_damage', rage: 1 });
      dh = Math.max(0, dh - dmgA);
      log += `R${r} ${a.name} → ${d.name} 伤害 ${dmgA}（剩余 ${dh}）\n`;
      if (dh <= 0) { log += `★ ${a.name} 在第 ${r} 回合击败 ${d.name}\n`; break; }
      const dmgD = calcDamage(d, a, { power: 1, rand: 0.5, formulaId: 'phys_damage', rage: 1 });
      ah = Math.max(0, ah - dmgD);
      log += `R${r} ${d.name} → ${a.name} 伤害 ${dmgD}（剩余 ${ah}）\n`;
      if (ah <= 0) { log += `★ ${d.name} 在第 ${r} 回合击败 ${a.name}\n`; break; }
    }
    root.querySelector('#sim-log').textContent = log;
  };
}

// GM 指令后台
function renderGM(root, ui) {
  root.innerHTML = `<div class="te-gm">
    <div class="te-gm-sec">玩家：Lv <b id="gm-lv">${ui.player ? ui.player.level : '—'}</b> · 银子 <b id="gm-silver">${ui.player ? ui.player.silver : '—'}</b> · 金子 <b id="gm-gold">${ui.player ? ui.player.gold : '—'}</b></div>
    <div class="te-gm-btns">
      <button class="pb-btn" data-gm="item">刷物品(输入ID)</button>
      <button class="pb-btn" data-gm="level">设等级</button>
      <button class="pb-btn" data-gm="silver">加银子</button><button class="pb-btn" data-gm="gold">加金子</button>
      <button class="pb-btn" data-gm="teleport">传送地图</button>
      <button class="pb-btn" data-gm="spawn">召唤怪物战斗</button>
      <button class="pb-btn" data-gm="dungeon">开始副本</button>
      <button class="pb-btn" data-gm="attr">改属性</button>
      <button class="pb-btn ghost" data-gm="reset">重置玩家</button>
    </div>
    <div class="te-gm-log" id="gm-log">GM 指令即时生效，写入运行期 player 与 Config。</div></div>`;
  const log = (t) => { root.querySelector('#gm-log').textContent = t; ui.toast(t); };
  root.querySelectorAll('[data-gm]').forEach(b => b.onclick = () => {
    const p = ui.player; if (!p) { log('未登录'); return; }
    const g = b.dataset.gm;
    if (g === 'item') { const id = prompt('物品ID（如 11030001）'); if (id && Config.data.items[id]) { p.bag = p.bag || []; p.bag.push({ itemId: id, count: 1 }); log('已获得 ' + Config.data.items[id].name); } else log('物品不存在'); }
    else if (g === 'level') { const lv = +prompt('等级'); if (lv > 0) { p.level = lv; log('等级设为 ' + lv); } }
    else if (g === 'silver') { const n = +prompt('银子'); if (!isNaN(n)) { p.silver = (p.silver || 0) + n; log('银子 ' + (n >= 0 ? '+' : '') + n); } }
      else if (g === 'gold') { const n = +prompt('金子'); if (!isNaN(n)) { p.gold = (p.gold || 0) + n; log('金子 ' + (n >= 0 ? '+' : '') + n); } }
    else if (g === 'teleport') { const all = Config.maps || []; const id = prompt('地图ID（如 ' + (all[0] && all[0].id) + '）'); const m = all.find(x => String(x.id) === String(id)); if (m) { ui.enterMap(m.id); log('已传送至 ' + m.name); } else log('地图不存在'); }
    else if (g === 'spawn') { const mobs = Config.data.monsters || {}; const id = prompt('怪物ID（如 m_boar）'); if (id && mobs[id] && ui.sm) { ui.sm.enterBattle && ui.sm.enterBattle(mobs[id]); log('已进入战斗：' + mobs[id].name); } else log('怪物不存在或不可战斗'); }
    else if (g === 'dungeon') { const dgs = Config.data.dungeons || {}; const ids = Object.keys(dgs); if (!ids.length) log('无副本配置（用副本规则编辑器新建）'); else { const id = prompt('副本ID（如 ' + ids[0] + '）'); if (id && dgs[id] && ui.sm) { ui.sm.startDungeon(dgs[id]); log('已进入副本：' + dgs[id].name); } else log('副本不存在'); } }
    else if (g === 'attr') { const k = prompt('属性名(atk/def/mag/spd/hp/mp)'); const v = +prompt('值'); if (k && !isNaN(v)) { p[k] = v; log(k + '=' + v); } }
    else if (g === 'reset') { p.level = 1; p.silver = 0; p.bag = []; p.equip = {}; log('玩家已重置'); }
    if (ui.refresh) ui.refresh();
    root.querySelector('#gm-lv').textContent = p.level; root.querySelector('#gm-silver').textContent = p.silver; root.querySelector('#gm-gold').textContent = p.gold;
  });
}

// 数据一致性检测
function renderChecker(root, ui) {
  root.innerHTML = `<button class="pb-btn te-chk-go">扫描全量配置</button><div class="te-chk" id="chk-out">点击开始扫描…</div>`;
  root.querySelector('.te-chk-go').onclick = () => {
    const issues = [];
    const D = Config.data;
    const refOk = (ref, id) => D[ref] && (Array.isArray(D[ref]) ? D[ref].some(r => r.id == id) : D[ref][id]);
    // 技能引用的 buff（兼容结构化对象数组与旧版纯 id 字符串数组）
    Object.values(D.skills || {}).forEach(s => {
      (s.buffs || []).forEach(b => {
        if (typeof b === 'string') { if (!refOk('buffs', b)) issues.push(`技能[${s.name}] 引用缺失 buff: ${b}`); }
        else if (b && typeof b === 'object') {
          if (b.buff && !refOk('buffs', b.buff)) issues.push(`技能[${s.name}] 引用缺失 buff: ${b.buff}`);
          if (b.link) String(b.link).split(',').map(x => x.trim()).filter(Boolean).forEach(l => { if (!refOk('buffs', l)) issues.push(`技能[${s.name}] 关联 buff 缺失: ${l}`); });
        }
      });
    });
    // 怪物引用的技能
    Object.values(D.monsters || {}).forEach(m => (m.skills || []).forEach(sk => { if (!refOk('skills', sk)) issues.push(`怪物[${m.name}] 引用缺失技能: ${sk}`); }));
    // 怪物宠物引用的先天技能
    Object.values(D.monsters || {}).forEach(m => (m.innateSkills || []).forEach(sk => { if (!refOk('skills', sk)) issues.push(`怪物[${m.name}] 引用缺失先天技能: ${sk}`); }));
    // 掉落表引用物品
    Object.values(D.drops || {}).forEach(dp => (dp.table || []).forEach(t => { if (!refOk('items', t.item)) issues.push(`掉落表[${dp.name}] 引用缺失物品: ${t.item}`); }));
    // 副本波次引用怪物
    Object.values(D.dungeons || {}).forEach(dg => (dg.waves || []).forEach(w => { if (!refOk('monsters', w.mob)) issues.push(`副本[${dg.name}] 引用缺失怪物: ${w.mob}`); }));
    // 物品价格
    Object.values(D.items || {}).forEach(it => { if (it.type === 'quest') return; if (!it.price || it.price < 0) issues.push(`物品[${it.name}] 价格异常: ${it.price}`); });
    // 图标缺失（仅检查配置声明，不访问网络）
    const missIcon = (domain) => Object.values(D[domain] || {}).filter(r => !r.icon && r.id != null).map(r => r.name || r.id);
    const mi = missIcon('skills').concat(missIcon('monsters'));
    if (mi.length) issues.push(`以下 ${mi.length} 条记录未配置 icon 字段：${mi.slice(0, 10).join('、')}${mi.length > 10 ? '…' : ''}`);
    const out = issues.length ? issues.map((t, i) => `${i + 1}. ${t}`).join('\n') : '✅ 未发现一致性问题（图标网络可达性需运行时确认）。';
    root.querySelector('#chk-out').textContent = out;
    ui.toast(issues.length ? ('发现 ' + issues.length + ' 处问题') : '检测通过');
  };
}

// 经济监控后台（只读估算）
function renderEconomy(root, ui) {
  const D = Config.data;
  const mobs = Object.values(D.monsters || {});
  const totalSilver = mobs.reduce((s, m) => s + (m.silver || 0), 0);
  const avgSilver = mobs.length ? Math.round(totalSilver / mobs.length) : 0;
  const items = Object.values(D.items || {});
  const sellable = items.filter(it => it.type !== 'quest');
  const priceMin = sellable.length ? Math.min(...sellable.map(it => it.price || 0)) : 0;
  const priceMax = sellable.length ? Math.max(...sellable.map(it => it.price || 0)) : 0;
  const shops = Object.values(D.shop || {});
  root.innerHTML = `<div class="te-econ">
    <div class="te-econ-grid">
      <div><b>${mobs.length}</b><span>怪物种类</span></div>
      <div><b>${totalSilver}</b><span>怪物银子产出合计</span></div>
      <div><b>${avgSilver}</b><span>单怪平均银子</span></div>
      <div><b>${sellable.length}</b><span>可交易物品</span></div>
      <div><b>${priceMin}~${priceMax}</b><span>物价区间</span></div>
      <div><b>${shops.length}</b><span>商城条目</span></div>
    </div>
    <div class="te-econ-note">说明：货币「产出」按怪物 silver 求和估算，「消耗」按商城/商店 price 估算；实时银价波动需运行时采集。调整掉落权重/商城可影响产消比。</div>
    <div class="te-econ-list">高价物品 Top5：${sellable.slice().sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, 5).map(it => `${it.name}(${it.price})`).join('、') || '无'}</div>
  </div>`;
}

// 兑换码后台
function renderRedeem(root, ui) {
  function ensure() { if (!Config.data.redeems) { try { const o = localStorage.getItem('tsqt.cfg.redeems'); Config.data.redeems = o ? JSON.parse(o) : {}; } catch (e) { Config.data.redeems = {}; } } return Config.data.redeems; }
  function save(o) { Config.data.redeems = o; persistConfig('redeems', o); }
  root.innerHTML = `<div class="te-redeem">
    <div class="te-redeem-row">礼包内容(物品ID=数量，每行)：<br/><textarea id="rd-items" class="te-in" rows="3" placeholder="11030001=1&#10;11010001=5"></textarea></div>
    <div class="te-redeem-row">银子：<input id="rd-silver" type="number" value="0" style="width:90px"/></div>
    <div class="te-redeem-row">数量：<input id="rd-n" type="number" value="1" min="1" style="width:70px"/> <button class="pb-btn" id="rd-gen">生成兑换码</button></div>
    <div class="te-redeem-row">测试兑换：<input id="rd-code" class="te-in" placeholder="粘贴兑换码"/> <button class="pb-btn ghost" id="rd-use">兑换</button></div>
    <div class="te-redeem-list" id="rd-list">已生成兑换码：</div>
  </div>`;
  const list = () => { const r = ensure(); root.querySelector('#rd-list').innerHTML = '已生成兑换码：<br/>' + Object.keys(r).map(c => `<div>${c} → ${(r[c].items ? Object.entries(r[c].items).map(([a, b]) => a + 'x' + b).join(',') : '')}${r[c].silver ? ' +' + r[c].silver + '银' : ''}</div>`).join('') || '（无）'; };
  list();
  root.querySelector('#rd-gen').onclick = () => {
    const items = {}; root.querySelector('#rd-items').value.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) items[l.slice(0, i).trim()] = +(l.slice(i + 1).trim()) || 1; });
    const silver = +(root.querySelector('#rd-silver').value) || 0;
    const n = Math.max(1, +(root.querySelector('#rd-n').value) || 1);
    const r = ensure();
    for (let i = 0; i < n; i++) { const code = 'TSQ' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).slice(2, 6).toUpperCase(); r[code] = { items, silver }; }
    save(r); list(); ui.toast('已生成 ' + n + ' 个兑换码');
  };
  root.querySelector('#rd-use').onclick = () => {
    const code = root.querySelector('#rd-code').value.trim(); const r = ensure();
    if (!r[code]) { ui.toast('兑换码无效'); return; }
    const p = ui.player; if (!p) { ui.toast('未登录'); return; }
    p.bag = p.bag || []; Object.entries(r[code].items || {}).forEach(([id, n]) => { if (Config.data.items[id]) p.bag.push({ itemId: id, count: n }); });
    if (r[code].silver) p.silver = (p.silver || 0) + r[code].silver;
    delete r[code]; save(r); list(); ui.refresh(); ui.toast('兑换成功');
  };
}

// 剧情演出编辑器（自定义：可编辑 steps + 真机播放）
function renderStory(root, ui) {
  function ensure() { if (!Config.data.stories) { try { const o = localStorage.getItem('tsqt.cfg.stories'); Config.data.stories = o ? JSON.parse(o) : {}; } catch (e) { Config.data.stories = {}; } } return Config.data.stories; }
  function save(o) { Config.data.stories = o; persistConfig('stories', o); }
  function draw() {
    const S = ensure();
    const rows = Object.keys(S).map(k => `<div class="te-item" data-k="${k}">${k} · ${S[k].name || ''}</div>`).join('') || '<div class="te-empty">空</div>';
    root.innerHTML = `<div class="te-wrap"><div class="te-list"><div class="te-list-h">剧情 ${Object.keys(S).length}</div><div class="te-list-b">${rows}</div><button class="pb-btn te-new">＋ 新建</button></div>
      <div class="te-editor" id="story-ed">← 选择/新建剧情</div></div>`;
    root.querySelectorAll('.te-item').forEach(it => it.onclick = () => edit(it.dataset.k));
    root.querySelector('.te-new').onclick = () => edit(null);
  }
  function edit(k) {
    const S = ensure();
    const rec = k ? JSON.parse(JSON.stringify(S[k] || {})) : { steps: [] };
    const jesc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (!Array.isArray(rec.steps)) rec.steps = [];
    const ed = root.querySelector('#story-ed');
    ed.innerHTML = `<div class="te-form"><div class="te-form-h">${k ? '编辑 ' + k : '新建剧情'}</div>
      <div class="te-field"><label class="te-fl">剧情ID</label><input class="te-in" data-f="id" value="${rec.id || ''}"/></div>
      <div class="te-field"><label class="te-fl">名称</label><input class="te-in" data-f="name" value="${rec.name || ''}"/></div>
      <div class="te-field"><label class="te-fl">时间轴 steps(JSON)</label><textarea class="te-in" data-f="steps" rows="10">${JSON.stringify(rec.steps, null, 1)}</textarea></div>
      <div class="te-prev"><div class="te-prev-h">实时资产预览（保存即落地）</div><pre class="te-prev-b" id="story-prev">${jesc(JSON.stringify(rec, null, 2))}</pre></div>
      <div class="te-form-f"><button class="pb-btn te-play">▶ 播放</button><button class="pb-btn te-save">保存</button><button class="pb-btn ghost te-del">删除</button></div></div>`;
    const parse = () => {
      let steps; try { steps = JSON.parse(ed.querySelector('[data-f="steps"]').value); } catch (e) { ui.toast('steps JSON 解析失败'); return null; }
      return { id: ed.querySelector('[data-f="id"]').value.trim(), name: ed.querySelector('[data-f="name"]').value.trim(), steps: Array.isArray(steps) ? steps : [] };
    };
    ed.querySelector('.te-play').onclick = () => { const r = parse(); if (r) { if (!r.id) { ui.toast('请先填ID'); return; } playStory(r, ui); } };
    ed.querySelector('.te-save').onclick = () => { const r = parse(); if (!r) return; if (!r.id) { ui.toast('ID 必填'); return; } const S = ensure(); S[r.id] = r; save(S); draw(); ui.toast('已保存'); };
    ed.querySelector('.te-del').onclick = () => { if (k) { const S = ensure(); delete S[k]; save(S); draw(); } };
    // 实时资产预览：编辑 ID/名称/steps 时同步刷新（降低无代码写出非法 steps 资产的概率）
    const prev = ed.querySelector('#story-prev');
    const upPrev = () => { try { const steps = JSON.parse(ed.querySelector('[data-f="steps"]').value); prev.textContent = jesc(JSON.stringify({ id: ed.querySelector('[data-f="id"]').value.trim(), name: ed.querySelector('[data-f="name"]').value.trim(), steps: Array.isArray(steps) ? steps : [] }, null, 2)); } catch (e) { prev.textContent = '（steps JSON 暂不可解析）'; } };
    ed.querySelector('[data-f="steps"]').addEventListener('input', upPrev);
    ed.querySelector('[data-f="id"]').addEventListener('input', upPrev);
    ed.querySelector('[data-f="name"]').addEventListener('input', upPrev);
  }
  draw();
}

// 剧情演出播放（对齐剧情演出编辑器：在主线场景上叠层演时间轴；t 为单步停留秒数）
function playStory(story, ui) {
  const layer = (ui && ui.sm && ui.sm.layers && ui.sm.layers.world) || document.body;
  const ov = document.createElement('div'); ov.className = 'story-play';
  layer.appendChild(ov);
  const steps = story.steps || [];
  let i = 0;
  const finish = () => { ov.remove(); ui && ui.toast('剧情播放结束'); };
  const run = () => {
    if (i >= steps.length) { finish(); return; }
    const s = steps[i++]; if (!s) { finish(); return; }
    ov.innerHTML = '';
    ov.className = 'story-play' + (s.action === '黑屏' ? ' black' : '');
    if (s.action === '对话气泡' && s.text) {
      const b = document.createElement('div'); b.className = 'story-dlg';
      b.textContent = (s.npc ? (s.npc + '：') : '') + s.text; ov.appendChild(b);
    } else if (s.action === '镜头移动' && ui && ui.sm && ui.sm._main && ui.sm._main.camera) {
      const [x, y] = (s.pos || '0,0').split(',').map(Number);
      const main = ui.sm._main; main.camera.x = x - (window.innerWidth - SIDEBAR_W()) / 2; main.camera.y = y - window.innerHeight / 2;
      const cap = document.createElement('div'); cap.className = 'story-cap'; cap.textContent = '镜头移动 → ' + (s.pos || '0,0'); ov.appendChild(cap);
    } else if (s.action === '特效触发' && s.effect) {
      const cap = document.createElement('div'); cap.className = 'story-cap'; cap.textContent = '【特效】' + s.effect; ov.appendChild(cap);
    } else if (s.action === '背景音乐' && s.bgm) {
      const cap = document.createElement('div'); cap.className = 'story-cap'; cap.textContent = '♪ ' + s.bgm; ov.appendChild(cap);
    } else if (s.action === 'NPC走位' && s.npc) {
      const cap = document.createElement('div'); cap.className = 'story-cap'; cap.textContent = s.npc + ' 走位至 ' + (s.pos || '—'); ov.appendChild(cap);
    } else if (s.action === '黑屏') { /* 仅黑屏 */ }
    else {
      const cap = document.createElement('div'); cap.className = 'story-cap'; cap.textContent = s.action || '（空镜）'; ov.appendChild(cap);
    }
    const dwell = (Number(s.t) > 0 ? Number(s.t) : 1.2) * 1000;
    setTimeout(run, dwell);
  };
  run();
}

// 自定义工具分发
const CUSTOM = { achv: renderAchv, sim: renderSim, gm: renderGM, checker: renderChecker, economy: renderEconomy, redeem: renderRedeem, story: renderStory, mapnpc: renderMapNpc };

// ───────────────────────── 工具台 hub 面板 ─────────────────────────
export const TOOL_GROUPS = [
  { key: 'battle', label: '一、战斗核心体系', icon: 'facebattlepoints.png', tools: ['skill', 'buff', 'ai'] },
  { key: 'pet', label: '二、宠物/召唤兽体系', icon: 'facepetchest.png', tools: ['monsterpet', 'pillmount'] },
  { key: 'quest', label: '三、任务剧情与副本生产', icon: 'faceboard.png', tools: ['quest', 'story', 'dungeon', 'encounter'] },
  { key: 'econ', label: '四、经济与社交系统', icon: 'faceshop.png', tools: ['drop', 'trade', 'shop', 'guild', 'bot'] },
  { key: 'grow', label: '五、角色养成线', icon: 'faceexp.png', tools: ['equip', 'heart', 'formula', 'achievement'] },
  { key: 'ops', label: '六、研发调试与运营后台', icon: 'facesystem.png', tools: ['sim', 'gm', 'pdoll', 'checker', 'economy', 'redeem'] },
  { key: 'world', label: '七、世界与基础数据', icon: 'facemap.png', tools: ['mapnpc', 'item'] }
];

export class WorkbenchPanel extends BasePanel {
  constructor(opts = {}) {
    super({ id: 'panel-workbench', title: '研发/运营工具台', width: 760, height: 560, ui: opts.ui, icon: { dir: 'res', file: 'facesystem.png' } });
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    const cards = TOOL_GROUPS.map(g => {
      const btns = g.tools.map(t => {
        const d = TOOLS[t];
        return `<button class="wb-tool" data-tool="tool_${t}"><img class="wb-ic" src="" data-ic="${g.icon}" alt="" onerror="this.style.display='none'"/><span>${d.title}</span></button>`;
      }).join('');
      return `<div class="wb-card"><div class="wb-card-h">${g.label}</div><div class="wb-card-b">${btns}</div></div>`;
    }).join('');
    this.setContent(`<div class="wb-head"><span class="wb-head-t">7 大类 · 26 个配置/调试工具</span><button class="wb-help" data-tool="toolhelp">❓ 工具使用帮助</button></div><div class="wb-wrap">${cards}</div>`);
    this.body.querySelectorAll('.wb-tool').forEach(b => b.onclick = () => panelManager.open(b.dataset.tool));
    const hb = this.body.querySelector('.wb-help');
    if (hb) hb.onclick = () => panelManager.open('toolhelp');
  }
}

// 注册全部工具 + 工具台
export function registerTools(panelManager, ui) {
  panelManager.register('workbench', () => new WorkbenchPanel({ ui }));
  // 自定义「类面板」工具：不走 ToolPanel/CUSTOM 渲染函数分发，直接以类形式注册单例面板
  const CLASS_TOOLS = { pdoll: PaperDollPanel };
  for (const key in TOOLS) {
    const def = TOOLS[key];
    // 工具面板统一命名空间 tool_，避免与真实游戏面板（shop/quest/skill…）裸 key 冲突而被覆盖
    const tkey = 'tool_' + key;
    if (CLASS_TOOLS[key]) {
      // 纸娃娃调试等类面板工具：直接 register 类工厂，由类自身负责渲染 / 拖拽 / 关闭（复用通用 BasePanel）
      panelManager.register(tkey, () => new CLASS_TOOLS[key]({ ui }));
      continue;
    }
    if (def.custom) {
      panelManager.register(tkey, () => new ToolPanel({ def: { ...def, render: CUSTOM[def.custom] }, ui }));
    } else {
      panelManager.register(tkey, () => new SchemaEditor({ def, ui }));
    }
  }
  // 工具台使用帮助（覆盖全部 23 个工具）
  registerToolHelp(panelManager, ui, TOOLS, TOOL_GROUPS);
}
