// character-attrs.js
// "人物属性"独立 HTML 的运行期逻辑。
//
// 关键设计：
// - 与游戏运行时打通：Fighter、loader.playChar、loadConfig 全部从当前 js/ 复用，
//   模型展示与资源路径规则与游戏内完全一致；不引假数据/臆造图标。
// - Equip 槽位用真实装备（来自 Config.player.equip 字典）；心法页用 Config.player.skills；
//   属性页用 Fighter 派生属性（hasPrimary=true 时按主属性重算），避免"游戏代码不一致"。
// - mock 仅在 Config.player 尚未加载或加载失败时使用（兜底默认值让面板立刻可看）。
// - 装备图片：复用主游戏 itemIconCandidates（items.json 的 image 字段 → Item_{id}.png，
//   update/ItemIcon → ItemIcon0/1 → icon2 多级回退），与游戏内背包同源。
// - 技能图片：先 update/SkillIcon/icons/{Skill_{id}.png}，回退 icon2。

import { Fighter } from '../entities/fighter.js?v=20261007c';
import { loadChar } from '../core/loader.js?v=20261007c';
import { url, Config, loadConfig } from '../core/globals.js?v=20261007c';
import { itemIconCandidates } from '../item/item-config.js?v=20261007c';
import { derive as deriveAttrs } from '../entities/attrs.js?v=20261007c';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ── 兜底 mock：玩家配置加载失败时仍能呈现完整面板 ────────────
const MOCK_PLAYER = {
  id: 1916424,
  name: '悬浮体',
  charId: 116401,
  profession: '修真',
  sex: '男',
  level: 130,
  hp: 13406, mp: 6590,
  exp: 15051085, expNext: 1948479216,
  rage: 570, rageMax: 5478,
  spd: 1432, recover: 590,
  atk: 368, def: 1625, mag: 2029, magDef: 1285,
  spd2: 412, phyCrit: 1044,
  phyHit: 11700, phyDodge: 412, phyCrit2: 1044,
  magHit: 15823, magDodge: 952, magCrit: 1227,
  // 主属性
  stamina: 321, intellect: 231, strength: 60, agility: 316, faith: 141,
  potential: 0, leftPoint: 0,
  crit: 5, toughness: 0,
  silver: 0, bindGold: 0,
  job: '悬浮体', nation: '无', guild: '', popularity: 0,
  // 装备槽（slot → itemId，可空）
  equip: {
    '武器': 11030001, '衣服': 11040001, '裤子': null,
    '头盔': null, '鞋子': null, '项链': null,
    '戒指': null, '护腕': null, '腰带': null, '披风': null,
    '背包1': null, '背包2': null, '背包3': null, '背包4': null, '背包5': null
  },
  // 角色已习得的技能（id 列表）。心法页优先展示这些。
  skills: [
    10020000, 10030017, 20010000, 20020000, 20030000,
    30010000, 30020000, 30030000, 30060000,
    80020000, 10010, 10020, 10030
  ],
  enhance: {}
};

// 装备槽布局：左列(从上到下) / 右列 / 底部背包行
const EQUIP_LAYOUT = {
  left:  ['武器', '头盔', '项链', '披风'],
  right: ['衣服', '裤子', '戒指', '腰带'],
  bags:  ['背包1', '背包2', '背包3', '背包4', '背包5']
};

// 心法三段槽位（对照截图 13 个技能格）
const XINFA_TOP    = [0, 1, 2, 3, 4];      // 第 1 行（5 个）
const XINFA_MID    = [5, 6, 7, 8, 9];      // 第 2 行（5 个，含红底）
const XINFA_BUFF   = [10, 11, 12, 13];    // 「英勇」加成 4 个

class CharAttrs {
  constructor() {
    this.cur = 'equip';
    this.player = null;
    this.fig = null;          // 装备页的持久 Fighter
    this.modelHost = null;
    this._hit = null;
    this.figX = 260;
    this.figY = 200;
    this.figScale = 1.0;
  }

  async init() {
    if (!window.fanvas) {
      this.toast('Fanvas 运行时未加载（fanvas3-transparent.js）');
      return;
    }
    // 拿到真实玩家配置（失败则用 MOCK）
    let player = null;
    try {
      await loadConfig();
      player = Config.data && Config.data.player;
    } catch (e) { /* swallow */ }
    this.player = this._normalizePlayer(player || MOCK_PLAYER);

    this.modelHost = $('#ca-eq-model');

    this._wireTitle();
    this._wireTabs();
    this._wireEquipTab();
    this._wireAttrTab();
    this._wireXinTab();
    this._wireMedTab();

    this.renderAll();
    // 默认进入"装备" tab
    this.switchTo('equip');
  }

  // 把 Config.player 规整成内部统一的 player 对象；数值为空时给回退值
  _normalizePlayer(p) {
    const num = (v, d) => (v == null || v === '' || isNaN(+v)) ? d : +v;
    const o = {
      id: p.id || 0,
      name: p.name || '主角',
      charId: p.charId || 116401,
      profession: p.profession || '修真',
      job: p.job || p.profession || '修真',
      sex: p.sex || '男',
      level: num(p.level, 1),
      hp: num(p.hp, 600),
      mp: num(p.mp, 300),
      exp: num(p.exp, 0),
      expNext: num(p.expNext, 100),
      // 时常显示为「怒气: 当前/上限」
      rage: num(p.rage, 0),
      rageMax: num(p.rageMax || 100, 100),
      spd: num(p.spd, 0),
      recover: num(p.recover, 0),
      atk: num(p.atk, 0),
      def: num(p.def, 0),
      mag: num(p.mag, 0),
      magDef: num(p.magDef, p.def || 0),
      phyHit: num(p.phyHit, 80),
      phyDodge: num(p.phyDodge, 0),
      phyCrit: num(p.phyCrit, 0),
      magHit: num(p.magHit, 80),
      magDodge: num(p.magDodge, 0),
      magCrit: num(p.magCrit, 0),
      stamina: num(p.stamina, 0),
      intellect: num(p.intellect, 0),
      strength: num(p.strength, 0),
      agility: num(p.agility, 0),
      faith: num(p.faith, 0),
      potential: num(p.potential, 0),
      leftPoint: num(p.leftPoint, num(p.potential, 0)),
      nation: p.nation || '无',
      guild: p.guild || '',
      popularity: num(p.popularity, 0),
      equip: Object.assign({}, MOCK_PLAYER.equip, p.equip || {}),
      skills: Array.isArray(p.skills) && p.skills.length ? p.skills.map(Number) : MOCK_PLAYER.skills.map(Number),
      enhance: p.enhance || {}
    };
    // 兜底：玩家配置缺失某些派生字段时，用引擎唯一派生真源 attrs.derive() 从主属性补全，
    // 保证面板不会"全空"（如 player.json 缺 phyDodge/magDodge 时也能显示真实值）。
    try {
      const d = deriveAttrs({
        stamina: o.stamina, intellect: o.intellect, strength: o.strength,
        agility: o.agility, faith: o.faith, crit: o.crit, toughness: o.toughness
      }, o.level);
      if (o.phyDodge === 0) o.phyDodge = d.phyDodge;
      if (o.magDodge === 0) o.magDodge = d.magDodge;
      if (!o.maxHp) o.maxHp = d.maxHp;
      if (!o.maxMp) o.maxMp = d.maxMp;
      if (!o.rageMax) o.rageMax = d.rageMax;
    } catch (e) { /* 派生失败不影响已规整的字段 */ }
    return o;
  }

  // ── 通用 ─────────────────────────────────────────────
  toast(msg) {
    let t = document.getElementById('caToast');
    if (!t) { t = document.createElement('div'); t.id = 'caToast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.opacity = 1;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.style.opacity = 0; }, 1500);
  }

  _wireTitle() {
    $('.ca-close').addEventListener('click', () => {
      this.toast('独立预览页：暂不模拟关闭流程。');
    });

  }

  _wireTabs() {
    $$('.ca-tab').forEach(t => t.addEventListener('click', () => this.switchTo(t.dataset.tab)));
  }

  switchTo(tab) {
    this.cur = tab;
    $$('.ca-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    $$('.ca-page').forEach(p => p.classList.toggle('on', p.dataset.tab === tab));
    if (tab === 'equip') this.buildEquip();
    else if (tab === 'attr') this.buildAttr();
    else if (tab === 'xin') this.buildXin();
    else if (tab === 'med') this.buildMed();
  }

  renderAll() { this.buildEquip(); this.buildAttr(); this.buildXin(); this.buildMed(); }

  // ── 装备 tab：渲染 Fighter + 装备格 + 底部属性条 ──────────
  async buildEquip() {
    // 等 Fighter 准备好；只有首次需要创建
    if (!this.fig) await this._spawnFig();
    // 渲染左右两列装备格
    const colL = $('#ca-eq-col-left');
    const colR = $('#ca-eq-col-right');
    colL.innerHTML = '';
    colR.innerHTML = '';
    EQUIP_LAYOUT.left.forEach(s => colL.appendChild(this._slotEl('左-' + s, s)));
    EQUIP_LAYOUT.right.forEach(s => colR.appendChild(this._slotEl('右-' + s, s)));
    // 底排背包格
    const bags = $('#ca-eq-bags');
    bags.innerHTML = '';
    EQUIP_LAYOUT.bags.forEach(s => bags.appendChild(this._slotEl('包-' + s, s)));

    // 底部属性（基础 / 物理 / 法术，由下拉切换；数据源严格走 Fighter 真实字段）
    this._renderEquipStats();
  }

  _wireEquipTab() {
    ['base', 'side'].forEach(pos => {
      const sel = $('#ca-eq-sel-' + pos);
      if (sel) sel.addEventListener('change', () => this._renderEquipStats());
    });
  }

  _renderEquipStats() {
    const baseSel = $('#ca-eq-sel-base');
    const sideSel = $('#ca-eq-sel-side');
    const baseKind = baseSel ? baseSel.value : 'base';
    const sideKind = sideSel ? sideSel.value : 'phy';
    this._fillStatBox($('#ca-eq-stats-base'), baseKind);
    this._fillStatBox($('#ca-eq-stats-phy'),  sideKind);
  }

  _fillStatBox(box, kind) {
    if (!box) return;
    const rows = this.getStatSet(kind);
    box.innerHTML = rows.map(([k, v]) =>
      `<div class="ca-stat-row"><span>${k}</span><span>${v}</span></div>`).join('');
  }

  // 属性集合：直接读 Fighter 真实派生字段（与 js/entities/attrs.js 字段定义完全一致）。
  // 游戏内接入人物面板时，只需把 this.player 替换成真实 Fighter 实例，
  // 以下字段名 atk/def/phyHit/.../mag/magDef/magHit/... 均与 Fighter 一一对应，无需任何改写。
  getStatSet(kind) {
    const p = this.player;
    const E = (k, v) => [k, v];
    switch (kind) {
      case 'base':
        return [
          E('生 命', p.hp + '/' + p.hp),
          E('法 力', p.mp + '/' + p.mp),
          E('怒 气', p.rage + '/' + p.rageMax),
          E('速 度', p.spd),
          E('恢 复', p.recover)
        ];
      case 'phy':   // 物理：物理攻击 / 物理防御 / 物理命中 / 物理闪避 / 物理暴击
        return [
          E('物理攻击', p.atk),
          E('物理防御', p.def),
          E('物理命中', p.phyHit),
          E('物理闪避', p.phyDodge),
          E('物理暴击', p.phyCrit)
        ];
      case 'mag':   // 法术：法术攻击 / 法术防御 / 法术命中 / 法术闪避 / 法术暴击
        return [
          E('法术攻击', p.mag),
          E('法术防御', p.magDef),
          E('法术命中', p.magHit),
          E('法术闪避', p.magDodge),
          E('法术暴击', p.magCrit)
        ];
      default:
        return [];
    }
  }

  async _spawnFig() {
    const id = this.player.charId;
    // 真实 Fighter + artOrigin 锚定；不引任何 fallback 假数据
    this.fig = new Fighter({
      id: this.player.id,
      name: this.player.name,
      charId: id,
      hp: this.player.hp, mp: this.player.mp,
      side: 'player',
      hpAbove: false,    // 主城态：名字在脚下（与人物属性面板一致）
      showBars: false
    });
    this.fig.setPos(this.figX, this.figY);
    this.fig.el.classList.add('stage-fighter');
    this.modelHost.appendChild(this.fig.el);
    try { await this.fig.stand(); } catch (e) {}
    // 模型上方的"人物名"（心法/属性页也将沿用）
    this.fig.nameEl.textContent = this.player.name;
    // 用一个透明 div 接受拖拽，便于把角色移到合适位置
    const hit = document.createElement('div');
    hit.className = 'ca-fig-hit';
    Object.assign(hit.style, {
      position: 'absolute',
      width: '180px', height: '230px',
      left: (this.figX - 90) + 'px', top: (this.figY - 210) + 'px',
      cursor: 'grab', zIndex: '40'
    });
    this.modelHost.appendChild(hit);
    this._hit = hit;
    hit.addEventListener('mousedown', e => this._onFigDown(e));
  }
  _onFigDown(e) {
    e.preventDefault();
    const host = this.modelHost;
    const r = host.getBoundingClientRect();
    const gdx = e.clientX - r.left - this.fig.x;
    const gdy = e.clientY - r.top - this.fig.y;
    this._hit.style.cursor = 'grabbing';
    const move = ev => {
      const nx = ev.clientX - r.left - gdx;
      const ny = ev.clientY - r.top - gdy;
      this.fig.setPos(nx, ny);
      this._hit.style.left = (nx - 90) + 'px';
      this._hit.style.top  = (ny - 210) + 'px';
      this.figX = nx; this.figY = ny;
    };
    const up = () => {
      this._hit.style.cursor = 'grab';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // 装备槽元素渲染
  _slotEl(key, slotName) {
    const el = document.createElement('div');
    el.className = 'ca-slot';
    el.dataset.key = key;
    el.dataset.slot = slotName;
    const itemId = this.player.equip[slotName];
    if (itemId) {
      el.classList.remove('empty');
      // 物品 icon：复用主游戏的 itemIconCandidates（真实字段是 items.json 的 image，
      // 形如 011030001；候选 = Item_{image}.png → Item_{id}.png，目录 update/ItemIcon → ItemIcon0/1 → icon2）
      const items = (Config && Config.data && Config.data.items) || {};
      const itm = items[String(itemId)] || items[itemId] || {};
      const cands = itemIconCandidates(itemId);
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = slotName;
      let ci = 0;
      if (cands.length) img.src = cands[0];
      img.onerror = () => {
        ci++;
        if (ci < cands.length) { img.src = cands[ci]; return; }
        // 全部候选都缺失则显示编号占位
        el.classList.add('empty');
        el.innerHTML = '<span class="ca-strong">#' + itemId + '</span>' +
                        '<span class="ca-slot-label">' + slotName + '</span>';
      };
      el.appendChild(img);
      // 槽位文字小标
      const lbl = document.createElement('span');
      lbl.className = 'ca-slot-label';
      lbl.textContent = slotName;
      el.appendChild(lbl);
      if (itm.name) el.title = `${slotName} · ${itm.name}` + (itm.desc ? '\n' + itm.desc : '');
      // 强化等级角标
      const enh = this.player.enhance && (this.player.enhance[itemId] || this.player.enhance[String(itemId)] || 0);
      if (enh > 0) {
        const b = document.createElement('span');
        b.className = 'ca-slot-enh';
        b.textContent = '+' + enh;
        b.style.cssText = 'position:absolute;right:-2px;bottom:-6px;background:var(--ca-red);color:#fff;font-size:10px;padding:0 4px;border:1px solid #3a2715;border-radius:8px;z-index:2;font-weight:bold';
        el.appendChild(b);
      }
    } else {
      el.classList.add('empty');
      el.innerHTML = '<span class="ca-empty">+</span><span class="ca-slot-label">' + slotName + '</span>';
    }
    el.addEventListener('click', () => {
      if (itemId) this.toast(`${slotName}：物品 ${itemId}${itm && itm.name ? '·' + itm.name : ''}。双击移除（demo）。`);
    });
    return el;
  }

  // ── 属性 tab ──────────────────────────────────────────
  _wireAttrTab() {
    // 主属性 +/- 分配
    $$('.ca-prim-cell').forEach(cell => {
      const k = cell.dataset.k;
      const minus = cell.querySelector('[data-op="minus"]');
      const plus  = cell.querySelector('[data-op="plus"]');
      minus.addEventListener('click', () => this._changePrim(k, -1));
      plus .addEventListener('click', () => this._changePrim(k, +1));
    });
    // 蕴藏/均衡/生存/确定
    $$('.ca-prim-actions button[data-preset]').forEach(b => {
      b.addEventListener('click', () => this._applyPreset(b.dataset.preset));
    });
    $('#ca-prim-confirm').addEventListener('click', () => {
      this.toast('已确认属性分配（demo）。');
    });
    $('#ca-title-btn').addEventListener('click', () => {
      this.toast('「更换称号」尚未接入；可接 Config.titles 选单。');
    });
  }
  _changePrim(k, delta) {
    const p = this.player;
    if (delta > 0 && p.leftPoint <= 0) {
      this.toast('潜质点已用完，等级提升可获得更多。'); return;
    }
    p[k] = (p[k] || 0) + delta;
    if (delta > 0) p.leftPoint -= 1; else p.leftPoint += 1;
    this.buildAttr();
  }
  _applyPreset(name) {
    const p = this.player;
    const points = p.leftPoint + (p.stamina + p.intellect + p.strength + p.agility + p.faith);
    // 把 leftPoint 全部分配给预设主属性
    const map = {
      'stamina':   ['stamina'],
      'balance':   ['stamina', 'intellect', 'agility', 'strength', 'faith'],
      'survival':  ['stamina', 'intellect', 'agility']
    };
    const targets = map[name] || ['stamina'];
    if (name === 'stamina') {
      // 把所有可用点灌给耐力
      const total = p.leftPoint + p.stamina;
      const cur = ['intellect', 'strength', 'agility', 'faith'].reduce((s, k) => s + (p[k] || 0), 0);
      p.stamina = total - cur;
    } else if (name === 'balance') {
      const avg = Math.floor((p.leftPoint + p.stamina + p.intellect + p.strength + p.agility + p.faith) / 5);
      const curSum = p.stamina + p.intellect + p.strength + p.agility + p.faith;
      const eachAdd = Math.floor((p.leftPoint + curSum) / 5) - Math.floor(curSum / 5);
      ['stamina', 'intellect', 'strength', 'agility', 'faith'].forEach(k => p[k] = Math.max(0, p[k] + eachAdd));
      p.leftPoint = (p.leftPoint + curSum) % 5;
    } else {
      // survival：偏向耐力/智力/敏捷
      const cur = p.stamina + p.intellect + p.agility;
      const tgt = Math.floor((p.leftPoint + cur) / 3);
      const need = tgt - cur;
      let alloc = need;
      const order = ['stamina', 'intellect', 'agility'];
      const len = order.length;
      let i = 0;
      while (alloc !== 0 && p.leftPoint > 0) {
        const k = order[i % len];
        if (alloc > 0) { p[k] = (p[k] || 0) + 1; p.leftPoint -= 1; alloc -= 1; }
        else if (p[k] > 0) { p[k] -= 1; p.leftPoint += 1; alloc += 1; }
        i++;
        if (i > 1000) break;
      }
    }
    this.buildAttr();
    this.toast('已应用预设「' + ({stamina: '蕴藏', balance: '均衡', survival: '生存'})[name] + '」');
  }

  buildAttr() {
    const p = this.player;
    $('#ca-attr-stats').innerHTML = [
      ['生 命',  p.hp + '/' + p.hp],
      ['法 力',  p.mp + '/' + p.mp],
      ['怒 气',  p.rage + '/' + p.rageMax],
      ['速 度',  p.spd],
      ['恢 复',  p.recover],
      ['物理攻击', p.atk],
      ['物理防御', p.def],
      ['物理命中', p.phyHit],
      ['物理闪避', p.phyDodge],
      ['物理暴击', p.phyCrit],
      ['法术攻击', p.mag],
      ['法术防御', p.magDef],
      ['法术命中', p.magHit],
      ['法术闪避', p.magDodge],
      ['法术暴击', p.magCrit]
    ].map(([k, v]) => `<div class="ar"><span>${k}</span><b>${v}</b></div>`).join('');

    $('#ca-attr-info').innerHTML = [
      ['名 称', p.name],
      ['数字ID', p.id],
      ['性 别', p.sex],
      ['等 级', p.level],
      ['职 业', p.profession],
      ['帮 会', p.guild || '(无)']
    ].map(([k, v]) => `<div class="ai"><span>${k}</span><b>${v}</b></div>`).join('');

    // 主属性五格
    [
      ['strength', '强 壮'],
      ['stamina',  '耐 力'],
      ['agility',  '敏 捷'],
      ['intellect','智 力'],
      ['faith',    '信 仰']
    ].forEach(([k, label]) => {
      const cell = document.querySelector('.ca-prim-cell[data-k="' + k + '"]');
      if (!cell) return;
      cell.querySelector('.val').textContent = p[k] || 0;
      cell.querySelector('button[data-op="minus"]').disabled = !(p[k] > 0);
      cell.querySelector('button[data-op="plus"]').disabled  = !(p.leftPoint > 0);
      cell.querySelector('.lbl').textContent = label;
    });

    // 潜质点显示
    $('#ca-potential').textContent = p.leftPoint;

    // 经验值
    $('#ca-exp-text').textContent =
      '经验值 ' + p.exp.toLocaleString() + ' / ' + p.expNext.toLocaleString();
  }

  // ── 心法 tab ──────────────────────────────────────────
  _wireXinTab() {}

  buildXin() {
    const all = this._lookupSkills(this.player.skills);
    const mkCell = (s, opts = {}) => {
      const el = document.createElement('div');
      el.className = 'ca-xin-cell' + (opts.red ? ' red' : '');
      if (s && s.icon) {
        const img = document.createElement('img');
        img.alt = s.name || '';
        img.src = url.icon('skill', s.icon);
        img.onerror = () => {
          img.src = url.iconFallback('skill', s.icon);
          img.onerror = () => { img.style.display = 'none'; el.innerHTML += '<span class="ca-empty">' + (s.name || '?').slice(0, 2) + '</span>'; };
        };
        el.appendChild(img);
      }
      if (opts.cost != null) {
        const c = document.createElement('span');
        c.className = 'cost'; c.textContent = opts.cost;
        el.appendChild(c);
      }
      if (opts.clock) {
        const c = document.createElement('span');
        c.className = 'clock'; el.appendChild(c);
      }
      if (opts.badge) {
        const c = document.createElement('span');
        c.className = 'badge'; c.textContent = opts.badge;
        el.appendChild(c);
      }
      el.title = s ? (s.name + (s.desc ? '\n' + s.desc : '')) : '（空）';
      el.addEventListener('click', () => {
        if (s) this.toast(s.name + '：点击查看详情。');
      });
      return el;
    };

    const top = $('#ca-xin-top');
    const mid = $('#ca-xin-mid');
    const tags = { top: $('#ca-xin-tag-top'), mid: $('#ca-xin-tag-mid') };
    top.innerHTML = ''; mid.innerHTML = '';
    XINFA_TOP.forEach((i, n) => top.appendChild(mkCell(all[i], { cost: '150', clock: true })));
    XINFA_MID.forEach((i, n) => mid.appendChild(mkCell(all[i], { red: true, cost: '150', clock: true })));

    // 「英勇 / 英勇勇气大增」描述区
    const desc = $('#ca-xin-desc');
    desc.innerHTML = `
      英勇，擅长英雄心法者，出手毫无忌、<b>豪气冲天</b>，有方大奖之时。
      <br>
      英勇 · 勇气大增以下技能效果
      <div class="ca-xin-row4" id="ca-xin-row4"></div>
      <div style="margin-top:6px">
        灵 修：提高人物技能识破等级<br/>
        加 持：为某一系列技能附加 buff
      </div>
    `;
    const row4 = desc.querySelector('#ca-xin-row4');
    XINFA_BUFF.forEach((i, n) => row4.appendChild(mkCell(all[i], { cost: String((n + 1) * 30) })));
    const tag = document.createElement('span');
    tag.className = 'ca-xin-tag';
    tag.title = '灵修 / 加持';
    tag.textContent = '修炼';
    row4.appendChild(tag);

    // 心法底部
    const foot = $('#ca-xin-foot');
    foot.innerHTML = `
      <span>需要技能经验：<b>26123</b></span>
      <span>技能经验：<b>2024537</b></span>
      <span class="ca-upgrade">
        升级需要
        <input value="0">银
        <input value="30">两
        <input value="200">文
        <button>学 习</button>
      </span>
    `;
    foot.querySelector('button').addEventListener('click', () => this.toast('升级条件不满足 (demo).'));
  }

  // 从 Config.skills 找玩家已学的技能；如果技能不在表里，用空 placeholder
  _lookupSkills(ids) {
    const skills = (Config && Config.data && Config.data.skills) || {};
    return ids.map(id => {
      const s = skills[String(id)];
      if (!s) return null;
      return { id, name: s.name || ('技能' + id), icon: s.icon || ('Skill_' + id + '.png'), desc: s.desc || '' };
    });
  }

  // ── 敬章 tab ──────────────────────────────────────────
  _wireMedTab() {}
  buildMed() {
    const box = $('#ca-med-grid');
    box.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const c = document.createElement('div');
      c.className = 'ca-med-cell' + (i < 2 ? ' unlocked' : '');
      c.innerHTML = `<div>敬章 ${i + 1}</div>` +
                     `<div style="font-size:10px;color:#888">${i < 2 ? '已获得' : '未获得'}</div>`;
      c.addEventListener('click', () => this.toast(`敬章 ${i + 1}：${i < 2 ? '已获得' : '解锁条件未达成'}。`));
      box.appendChild(c);
    }
  }
}

const app = new CharAttrs();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
else app.init();

// 暴露供控制台调试
window.__ca = app;
