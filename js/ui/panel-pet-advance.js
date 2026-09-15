// panel-pet-advance.js
// 宠物详情面板（对齐 AS3 PetAdvancePanelNew 壳，分区按用户裁决 2026-09-19 重划）：
//   壳真源：deobfuscated/panel/property/pet/advance/PetAdvancePanelNew.as（背景 + 3 分区框 + 顶部 6 按钮）
//   坐标真源：config/pet_advance.json ← update/i18n/zh_CN/layout.xml
//     面板 480×500；frame1(14,55,175,405)；frame2(207,55,260,250)；frame3(内丹) 删除
//   分区：
//     frame1 资质区：五维资质 + 成长率彩色文字 + 品级 + 变异 + 寿命
//     frame2 技能区：12 图标格 + 等级徽章，悬停卡片显示描述（点击可固定描述，便于触屏）
//     frame3 内丹区：删除（单机版无内丹系统）
//
// ⚠ 不引用 battle/*、不改 skill-engine.js。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url } from '../core/globals.js?v=20261007c';
import { pet, DASH } from '../pet/pet.js?v=20261007c';
import { petState } from '../pet/pet-state.js?v=20261007c';
import { petAdvance } from '../pet/pet-advance.js?v=20261007c';
import { getSkillRich, sanitizeRichText } from './panels.js?v=20261007c';

// ───────────────────────── 常量 ─────────────────────────
// 成长率档位颜色（对齐 AS3 下发串 <font color='#xxxxxx'>品级</font>，与 panel-pet.js 同源）
const GROWTH_COLOR = {
  '普通': '#ffffff', '优秀': '#00FF00', '杰出': '#43F8E9', '卓越': '#CB40F1', '完美': '#FD5908',
};
// 五维资质键 → 中文名（角色信息表 aptitude 字段名）
const APT_KEYS = [
  ['strong', '力量'], ['vitality', '体质'], ['agile', '敏捷'],
  ['intellect', '智力'], ['belief', '信仰'],
];
// 技能格：6 列 × 2 行 = 12 格，格间距 42px（对齐 ViewPetSkill_new_skillItem(5,13) 的 12 格排布）
const SKILL_COLS = 6, SKILL_CELL = 42, SKILL_BOX = 38;
const SKILL_MAX = 12;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const skillIcon = (id) => url.icon('skill', 'Skill_' + id + '.png');
const skillDef = (id) => (Config.skills || {})[String(id)] || (Config.skills || {})[id] || null;

// ───────────────────────── 面板 ─────────────────────────
export class PetAdvancePanelNewPanel extends BasePanel {
  constructor(ui) {
    // 尺寸严格 480×500（= layout PetAdvancePanel_new 的 bgWidth/bgHeight）
    super({ id: 'panel-pet-advance', title: '宠物详情', width: 480, height: 500, ui });
    this._init();
  }

  // ⚠ BasePanel 构造体在 super() 内就调 init()→render()，此时子类字段尚未赋值 ⇒ 惰性 _init()
  _init() {
    if (this.__inited) return;
    this.__inited = true;
    this._petsCache = null;   // pet() 合并视图（渲染内缓存，render/refresh 失效）
    this._pinSkill = null;    // 固定展示的技能 id（触屏点选）
  }
  get sys() { return petAdvance(); }

  init() { this.render(); }
  onOpen() { this.refresh(); }
  refresh() { this._init(); this._petsCache = null; this._pinSkill = null; this._pendingDel = null; this.render(); }

  get pets() {
    this._init();
    if (!this._petsCache) this._petsCache = pet().list;
    return this._petsCache;
  }
  get selId() {
    const st = this.sys.state;
    if (st && st.selectPetId && st.selectPetId !== '-1') return String(st.selectPetId);
    const p = this.pets[0];
    return p ? String(p.petId) : '-1';
  }
  get cur() { return pet().get(this.selId) || {}; }

  _layer() {
    if (this._pp) return this._pp;
    this.dom.classList.add('pa-asis');
    const d = document.createElement('div');
    d.className = 'pa-layer';
    this.dom.appendChild(d);
    this._pp = d;
    return d;
  }

  render() {
    this._init();
    const lay = this._layer();
    const all = this.pets;
    const p = this.cur;
    const hasPet = all.length > 0 && p && p.petId != null;

    // ── 顶部：宠物选择行（对齐 AS3 由父面板携带 selectPetId；本版可就地切换）──
    const sel = `<select class="pa-sel" id="pa-pet" data-petsel>`
      + all.map((pt) => `<option value="${esc(pt.petId)}"${String(pt.petId) === this.selId ? ' selected' : ''}>`
        + `${esc(pt.name)}${pt.level ? ' Lv' + pt.level : ''}</option>`).join('')
      + `</select>`;

    // ── frame1：资质区 ──
    const f1 = this._frameApt(p, hasPet);
    // ── frame2：技能区 ──
    const f2 = this._frameSkill(p, hasPet);

    lay.innerHTML = `
      ${hasPet ? sel : `<div class="pa-empty">暂无宠物（捕获宠物后可在此查看详情）</div>`}
      ${f1}
      ${f2}
      <div class="pa-tip" style="display:none"></div>`;

    this._wire();
  }

  // ═══════════════ frame1：资质区（14,55,175,405）═══════════════
  _frameApt(p, hasPet) {
    const rows = [];
    const push = (k, vHtml) => rows.push(
      `<div class="pa-row"><span class="pa-k">${esc(k)}</span><span class="pa-v">${vHtml}</span></div>`);

    if (!hasPet) {
      push('等级', DASH);
      APT_KEYS.forEach(([_, label]) => push(label + '资质', DASH));
      push('成长率', DASH); push('品级', DASH); push('变异', DASH); push('寿命', DASH);
    } else {
      push('等级', esc(p.level != null ? p.level : DASH));
      // 五维资质（角色信息表原始值；无角色表来源时回退到已派生的一级属性）
      APT_KEYS.forEach(([key, label]) => {
        const apt = p.aptitudes && p.aptitudes[key] != null ? p.aptitudes[key]
          : (p[key] != null ? p[key] : null);
        push(label + '资质', apt != null ? esc(Math.round(Number(apt))) : DASH);
      });
      // 成长率：AS3 htmlText = <font color='#档位色'>品级</font>（彩色文字，不直接显示数值）
      const grade = p.grade || (p.growUpRate ? null : null);
      const gr = num(p.growUpRate);
      // ★ cc：成长率只显示数值（不着色）；品级另起一行保留彩色文字
      if (gr != null) {
        push('成长率', esc(gr) + '%');
      } else if (grade) {
        push('成长率', esc(grade));   // 无数值时退回品级名兜底
      } else {
        push('成长率', DASH);
      }
      // 品级（彩色文字）
      push('品级', grade && GROWTH_COLOR[grade]
        ? `<font color="${GROWTH_COLOR[grade]}">${esc(grade)}</font>` : DASH);
      // 变异：variant 布尔 / variation>=10（op572 口径）
      const variant = !!p.variant || (num(p.variation) || 0) >= 10;
      push('变异', variant
        ? `<font color="#FD5908">是</font>` : '否');
      // 寿命：当前/上限（当前值缺失时按上限显示）
      const lm = num(p.lifeMax);
      const lc = num(p.life) != null ? num(p.life) : lm;
      push('寿命', lm != null ? esc(Math.round(lc)) + '/' + esc(Math.round(lm)) : DASH);
    }

    return `<div class="pa-frame" style="left:14px;top:55px;width:175px;height:405px">
      <div class="pa-frame-title">资质</div>
      <div class="pa-rows">${rows.join('')}</div>
    </div>`;
  }

  // ═══════════════ frame2：技能区（207,55,260,250）═══════════════
  _frameSkill(p, hasPet) {
    const list = (hasPet && Array.isArray(p.skillList)) ? p.skillList.slice(0, SKILL_MAX) : [];
    const levels = (hasPet && p.skillLevels) || {};
    const cells = [];
    for (let i = 0; i < SKILL_MAX; i++) {
      const id = list[i];
      const def = id != null ? skillDef(id) : null;
      const lv = id != null ? (num(levels[String(id)]) || num(levels[id]) || (def ? 1 : 0)) : 0;
      const col = i % SKILL_COLS, rowN = Math.floor(i / SKILL_COLS);
      const x = 12 + col * SKILL_CELL, y = 30 + rowN * SKILL_CELL;
      if (id == null) {
        cells.push(`<div class="pa-skill-cell empty" style="left:${x}px;top:${y}px;width:${SKILL_BOX}px;height:${SKILL_BOX}px"></div>`);
        continue;
      }
      const name = def ? def.name : ('技能' + id);
      const passive = !!(def && def.passive);
      cells.push(`<div class="pa-skill-cell" data-sid="${esc(id)}" style="left:${x}px;top:${y}px;width:${SKILL_BOX}px;height:${SKILL_BOX}px">
        <img class="pa-skill-ic" src="${esc(skillIcon(id))}" alt="${esc(name)}" onerror="this.classList.add('broken')"/>
        <span class="pa-lv">${lv ? 'Lv' + esc(lv) : ''}</span>
        <button class="pa-skill-del" data-del="${esc(id)}" title="删除技能（需二次确认）">&#10005;</button>
        ${passive ? '<span class="pa-passive">被动</span>' : ''}
      </div>`);
    }
    return `<div class="pa-frame" style="left:207px;top:55px;width:260px;height:250px">
      <div class="pa-frame-title">技能</div>
      ${cells.join('')}
      <div class="pa-learn" data-learndesc>${hasPet ? '悬停或点击技能查看描述' : ''}</div>
    </div>`;
  }

  // ═══════════════ 事件 ═══════════════
  _wire() {
    const lay = this._pp;
    if (!lay) return;

    // 宠物切换
    const sel = lay.querySelector('[data-petsel]');
    if (sel) {
      sel.onchange = () => {
        try { this.sys.state.selectPetId = sel.value; } catch (_) {}
        this._petsCache = null; this._pinSkill = null; this.render();
      };
    }

    // 技能悬停卡片 + 点击固定
    const tip = lay.querySelector('.pa-tip');
    const learn = lay.querySelector('[data-learndesc]');
    const showTip = (cell) => {
      if (!tip) return;
      const def = skillDef(cell.dataset.sid);
      if (!def) return;
      const p = this.cur;
      const lv = (p.skillLevels && (num(p.skillLevels[String(cell.dataset.sid)]) || num(p.skillLevels[cell.dataset.sid]))) || 1;
      const lmax = num(def.levelMax) || 10;
      tip.innerHTML = `<div class="pa-tip-name">${esc(def.name || '')}${def.passive ? '（被动）' : ''}</div>`
        + `<div class="pa-tip-lv">等级 ${esc(lv)}/${esc(lmax)}</div>`
        + `<div class="pa-tip-desc">${sanitizeRichText(getSkillRich(def)) || esc(def.desc || '描述缺失')}</div>`;
      tip.style.display = '';
      // 贴在格右侧；右边放不下则放左侧
      const cr = cell.getBoundingClientRect(), lr = lay.getBoundingClientRect();
      const w = tip.offsetWidth || 200, h = tip.offsetHeight || 80;
      let tx = cr.left - lr.left + cr.width + 6;
      if (tx + w > lay.clientWidth) tx = cr.left - lr.left - w - 6;
      let ty = cr.top - lr.top;
      if (ty + h > lay.clientHeight) ty = lay.clientHeight - h - 4;
      tip.style.left = Math.max(2, tx) + 'px';
      tip.style.top = Math.max(2, ty) + 'px';
    };
    const writeLearn = (cell) => {
      if (!learn) return;
      const def = skillDef(cell.dataset.sid);
      if (!def) { learn.textContent = '描述缺失'; return; }
      const p = this.cur;
      const lv = (p.skillLevels && (num(p.skillLevels[String(cell.dataset.sid)]) || num(p.skillLevels[cell.dataset.sid]))) || 1;
      learn.innerHTML = `<b>${esc(def.name || '')}</b>${def.passive ? '（被动）' : ''} `
        + `<span class="pa-learn-lv">Lv${esc(lv)}/${esc(num(def.levelMax) || 10)}</span><br/>${esc(def.desc || '描述缺失')}`;
    };
    lay.querySelectorAll('.pa-skill-cell[data-sid]').forEach((cell) => {
      cell.onmouseenter = () => showTip(cell);
      cell.onmouseleave = () => { if (tip) tip.style.display = 'none'; };
      cell.onclick = () => { this._pinSkill = cell.dataset.sid; writeLearn(cell); };
    });
    // 渲染后恢复固定技能的描述
    // cc: skill delete button - disabled in battle; first click arms, second click within 2.5s deletes
    let inBattle = false;
    try { const sc = this.ui && this.ui.sm && this.ui.sm.current; inBattle = !!(sc && sc.constructor.name === 'BattleScene' && !sc._ended); } catch (_) {}
    lay.querySelectorAll('.pa-skill-del').forEach((btn) => {
      const sid = btn.dataset.del;
      if (inBattle) { btn.disabled = true; return; }
      btn.onclick = (e) => {
        e.stopPropagation();
        if (this._pendingDel === sid) {
          clearTimeout(this._pendingTimer); this._pendingDel = null;
          const def = skillDef(sid);
          const nm = def ? def.name : ('skill ' + sid);
          if (petState().forgetSkill(this.selId, sid)) {
            this.ui.toast('已遗忘「' + nm + '」');
            this._pinSkill = null;
            this.refresh();
          } else { this.ui.toast('删除失败：宠物或技能不存在'); }
          return;
        }
        this._pendingDel = sid;
        btn.classList.add('pending'); btn.textContent = '确认?';
        clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(() => {
          if (this._pp) {
            const b2 = this._pp.querySelector('.pa-skill-del[data-del="' + CSS.escape(String(sid)) + '"]');
            if (b2) { b2.classList.remove('pending'); b2.innerHTML = '&#10005;'; }
          }
          if (this._pendingDel === sid) this._pendingDel = null;
        }, 2500);
      };
    });
    if (this._pinSkill) {
      const c = lay.querySelector('.pa-skill-cell[data-sid="' + CSS.escape(String(this._pinSkill)) + '"]');
      if (c) writeLearn(c);
    }
  }
}

export function registerPetAdvancePanel(panelManager, ui) {
  panelManager.register('petadvance', () => new PetAdvancePanelNewPanel(ui));
}
