// player-skill.js
// 玩家技能面板子系统（PlayerSkillPanel2） —— 单机版本地实现（对齐 AS3）
//
// 对应原版：
//   deobfuscated/panel/skill/PlayerSkillPanel2.as        （主面板：TabView 聚合 7 子视图）
//   deobfuscated/panel/skill/skill2/ViewFightSkill.as     （战斗：8 心法分类 + 当前技能 + 描述/经验）
//   deobfuscated/panel/skill/skill2/ViewLifeSkill.as      （生活：技能列表）
//   deobfuscated/panel/skill/skill2/ViewPassiveSkill.as   （被动：被动技能列表）
//   deobfuscated/panel/skill/skill2/ViewSpecialSkill.as   （特殊：特殊技能列表）
//   deobfuscated/panel/skill/skill2/ViewTalentSkill.as    （天赋：天赋技能 + 描述/经验）
//   deobfuscated/panel/skill/skill2/ViewTransferSkill.as  （转换：转换技能）
//   deobfuscated/panel/skill/skill2/ViewShengji.as        （升级：升级技能系统）
//
// 铁律同 ridepet-advance / player.js：数据来自 config/player_skill_panel.json（布局=layout.xml / 文案=Lang / 协议=NetNet）；
// 服务端公式/明细不臆造；不触碰战斗系统。

import { Config } from '../core/globals.js?v=20261007c';

const cfg = () => Config.player_skill_panel || {};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// 协议号（NetNet.as）：open→CS_INITIATIVE_GETDATA(804) 等 SC_SKILL_LIST2(224)；
// 转换→CS_TRANSFERSKILL_SHOW(932)；升级→CS_SHENGJI_PANEL(1005) 等 SC_SHENGJI(1018)
export const CMD = {
  GET_SKILL_LIST: num((cfg().proto || {}).CS_INITIATIVE_GETDATA, 804),
  TRANSFER_SKILL: num((cfg().proto || {}).CS_TRANSFERSKILL_SHOW, 932),
  SHENGJI_PANEL: num((cfg().proto || {}).CS_SHENGJI_PANEL, 1005),
};
export const SC = {
  SKILL_LIST2: num((cfg().proto || {}).SC_SKILL_LIST2, 224),
  TRANSFER_SHOW: num((cfg().proto || {}).CS_TRANSFERSKILL_SHOW, 932), // 转换展示响应（无独立 SC 常量，复用 CS 号标注）
  SHENGJI: num((cfg().proto || {}).SC_SHENGJI, 1018),
};

// ───────────────────────── 本地「服务端」mock ─────────────────────────
// 任何分支都不 reject（对齐 ridepet-advance / player 的「任何分支不 reject」铁律）。
//
// ★ 数据真源：config/skills.json（含 descRich 抓包富文本段落）+ 玩家已学技能列表
//   （Config.player.skills）。技能定义 100% 来自配置，不臆造。
//   分桶规则对齐 AS3 PlayerSkillPanel2.as:259-274：
//     subType==life → 生活；80~87 → 战斗；1~10 → 特殊；11 → 天赋。
//   desc 富文本来源 descRich（由 _work/gen_skill_desc.mjs 从抓包 SC_SKILL_LIST2 的
//   1 级 sdesc 解析，消耗数值占位 XX）；mpCost/cd 等数值字段仍以配置为准。
const SUBTYPE_LIFE = 0;   // GlobalsGlobal05.life
function bucketOf(s) {
  const st = num(s.subType, 0);
  if (st === SUBTYPE_LIFE) return 'life';
  if (st >= 80 && st <= 87) return 'fight';
  if (st >= 1 && st <= 10) return 'special';
  if (st === 11) return 'talent';
  return null;
}
function skillDataOf(id, player) {
  const map = (Config && Config.skills) || {};
  const s = map[String(id)] || map[id];
  if (!s) return null;
  const lv = (player && player.skillLevels && (player.skillLevels[String(id)] || player.skillLevels[id])) || 1;
  return {
    id: String(id), name: s.name || ('技能' + id), icon: s.icon || ('Skill_' + id + '.png'),
    subType: num(s.subType, 0), mpCost: num(s.mpCost, 0), cd: num(s.cd, 0),
    level: num(lv, 1), desc: s.desc || '', descRich: s.descRich || null,
  };
}
export class PlayerSkillNet {
  constructor(state) { this.state = state; }

  async request(cmd, args = {}) {
    const st = this.state;
    st._push('CS', String(cmd), args);
    let resp = { ok: true, cs: cmd, sc: null, data: {} };
    switch (Number(cmd)) {
      case CMD.GET_SKILL_LIST:
        // SC_SKILL_LIST2(224)：从 config/skills.json + 玩家已学技能派生真实列表
        resp = { ...resp, sc: SC.SKILL_LIST2, data: st._buildLists() }; break;
      case CMD.TRANSFER_SKILL:
        resp = { ...resp, sc: SC.TRANSFER_SHOW, data: { note: 'CS_TRANSFERSKILL_SHOW(932) 转换技能列表抓包未覆盖' } }; break;
      case CMD.SHENGJI_PANEL:
        resp = { ...resp, sc: SC.SHENGJI, data: { note: 'CS_SHENGJI_PANEL(1005) 升级系统信息抓包未覆盖' } }; break;
      default:
        resp = { ...resp, sc: null };
    }
    if (resp.sc) st._push('SC', String(resp.sc), resp.data || {});
    return resp;
  }
}

// ───────────────────────── 技能面板状态 ─────────────────────────
export class PlayerSkillState {
  constructor() {
    this.tab = 'fight';          // 默认选中「战斗」（对齐复现页 __TABS__[0] selected）
    this.log = [];
    this.net = new PlayerSkillNet(this);
    this.shengjiOpen = true;     // 单机版默认开放「升级」标签（原版按 shengjiIsOpen>0 动态开放）
    this.skillTitles = (cfg().skillTitles || []).map((t) => ({ k: t.k, zh: t.zh }));
    this.lists = { fight: [], life: [], passive: [], special: [], talent: [], transfer: [], shengji: [] };
    this.curSkill = { name: '—', desc: '', descRich: null, exp: '—' };
    this._player = null;         // 由面板 onOpen 注入（Config.player）
  }

  // 从 config/skills.json + 玩家已学技能派生各分桶列表（真实数据，不臆造）
  _buildLists() {
    const p = this._player || (Config && Config.player) || null;
    const ids = (p && Array.isArray(p.skills)) ? p.skills : [];
    const out = { fight: [], life: [], passive: [], special: [], talent: [] };
    ids.forEach(id => {
      const s = skillDataOf(id, p);
      if (!s) return;
      const b = bucketOf(s);
      if (b) out[b].push(s);
    });
    return out;
  }

  _push(dir, op, payload) {
    this.log.unshift({ t: Date.now(), dir, op, payload });
    if (this.log.length > 60) this.log.pop();
  }

  // 打开面板：首次请求技能列表（CS 804 → SC 224）
  async open() {
    const r = await this.net.request(CMD.GET_SKILL_LIST, { subType: 'all' });
    if (r && r.data) {
      this.lists = { ...this.lists, ...r.data };
      // curSkill 取当前 tab 的第一个技能（无则保留占位）
      const list = this.lists[this.tab] || [];
      if (list.length) this.curSkill = list[0];
    }
    if (this.ui && this.ui.toast) this.ui.toast('已拉取技能列表（SC ' + (r.sc || '—') + '）');
    return r;
  }
  // 切到「转换」标签：请求转换技能（CS 932）
  async loadTransfer() {
    return this.net.request(CMD.TRANSFER_SKILL, {});
  }
  // 切到「升级」标签：请求升级面板（CS 1005 → SC 1018）
  async loadShengji() {
    return this.net.request(CMD.SHENGJI_PANEL, {});
  }
}

let _inst = null;
export function playerSkill() {
  if (!_inst) _inst = new PlayerSkillState();
  return _inst;
}
