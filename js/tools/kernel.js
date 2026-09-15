// kernel.js — 配置编辑器内核（schema 驱动）
// 天书奇谈单机版「研发/运营工具台」的通用编辑引擎。
// 设计目标：让大部分配置工具（技能/Buff/怪物/掉落/成就/装备/…）成为「声明式 schema」，
//   内核负责 列表(对象域/数组域) + 表单渲染 + 新建/保存(persistConfig)/删除/复制/导出，
//   无需每个工具重复写 DOM。复杂工具（模拟器/一致性检测/GM/兑换码）用 def.render 自定义。
//
// 字段类型 field.type：
//   text | number | textarea | select | multiselect | boolean
//   idref   —— 引用另一配置域的某个 id（下拉选 id+名称）
//   idlist  —— 引用另一配置域的多个 id（多选）
//   json    —— 原始 JSON 文本（保存时 JSON.parse 校验）
//   list    —— 简单字符串数组（每行一项）
//   table   —— 对象数组（sub: { 子字段 schema }），可增删行
//   kv      —— 键值对数组 [{k,v}]
//   expression —— 公式/表达式文本（仅做非空校验，运行期由公式编辑器求值）
//
// 所有数据域均经 persistConfig 写回 Config.data + localStorage，刷新后保留（globals.loadConfig 已加载这些域）。

import { BasePanel } from '../ui/panel-manager.js?v=20261007c';
import { Config, persistConfig } from '../core/globals.js?v=20261007c';
import { getDefaultSkillParams } from '../skill/skill-engine.js?v=20261007c';
import { buildParamsEditor } from '../skill/skill-params-ui.js?v=20261007c';

// 取某配置域的「id→名称」映射，供 idref/idlist 下拉使用
export function domainIdNames(domain) {
  const d = Config.data[domain];
  const map = {};
  if (!d) return map;
  const list = Array.isArray(d) ? d : Object.values(d);
  for (const r of list) {
    if (r && r.id != null) map[r.id] = r.name || String(r.id);
  }
  return map;
}

// 确保配置域存在（首次使用从 localStorage 覆盖恢复，否则用种子/空对象）
function ensureDomain(def) {
  const key = def.domain;
  if (Config.data[key] != null) return Config.data[key];
  let seed = def.seed;
  if (seed == null) seed = def.array ? [] : {};
  try {
    const ov = localStorage.getItem('tsqt.cfg.' + key);
    if (ov) seed = JSON.parse(ov);
  } catch (e) {}
  Config.data[key] = seed;
  return seed;
}

export class SchemaEditor extends BasePanel {
  constructor(opts = {}) {
    super({
      id: opts.def.id,
      title: opts.def.title,
      width: opts.def.width || 760,
      height: opts.def.height || 560,
      ui: opts.ui,
      icon: opts.def.icon
    });
    this.def = opts.def;
    this._sel = null;     // 当前选中的 key（对象域=id，数组域=index）
    this._draft = null;   // 当前编辑中的记录副本
  }

  init() { this.render(); }
  onOpen() { this.render(); }

  _data() { return ensureDomain(this.def); }

  // 返回 [{key, rec}] 统一列表
  _records() {
    const d = this._data();
    if (Array.isArray(d)) return d.map((rec, i) => ({ key: i, rec }));
    return Object.keys(d).map(k => ({ key: k, rec: d[k] }));
  }

  _nameOf(rec) {
    const nf = this.def.nameField || 'name';
    if (typeof nf === 'function') return nf(rec);
    return (rec && rec[nf] != null) ? rec[nf] : '(未命名)';
  }

  render() {
    if (!this.def) return;   // 构造期 super() 内首次 init 时 def 尚未赋值，跳过；open()→onOpen 会再次触发
    const d = this._data();
    const recs = this._records();
    const listHtml = recs.map(r => {
      const on = (r.key === this._sel) ? ' on' : '';
      const tag = this.def.tagField ? (r.rec[this.def.tagField] ? ` <i class="te-tag">${r.rec[this.def.tagField]}</i>` : '') : '';
      return `<div class="te-item${on}" data-key="${r.key}"><span class="te-ic">${this._glyph(r.rec)}</span>${this._escape(this._nameOf(r.rec))}${tag}</div>`;
    }).join('');
    const count = Array.isArray(d) ? d.length : Object.keys(d).length;
    this.setContent(`
      <div class="te-wrap">
        <div class="te-list">
          <div class="te-list-h">${this._escape(this.def.title)} · ${count}</div>
          <div class="te-list-b">${listHtml || '<div class="te-empty">（空，点右下「新建」）</div>'}</div>
          <div class="te-list-f">
            <button class="pb-btn te-new">＋ 新建</button>
            <button class="pb-btn ghost te-import">导入JSON</button>
          </div>
        </div>
        <div class="te-editor">${this._sel != null ? this._formHtml() : '<div class="te-empty">← 选择左侧条目编辑</div>'}</div>
      </div>`);
    this.body.querySelector('.te-list-b').addEventListener('click', (e) => {
      const it = e.target.closest('.te-item'); if (!it) return;
      this._select(it.dataset.key);
    });
    this.body.querySelector('.te-new').onclick = () => this._new();
    const imp = this.body.querySelector('.te-import'); if (imp) imp.onclick = () => this._import();
    this._bindForm();
    if (this.def.levelEditor) this._renderLevelEditor();
  }

  _glyph(rec) {
    if (this.def.glyphField && rec[this.def.glyphField]) return String(rec[this.def.glyphField]).slice(0, 1);
    return '◆';
  }

  _select(key) {
    const recs = this._records();
    const found = recs.find(r => String(r.key) === String(key));
    if (!found) return;
    this._sel = found.key;
    // 深拷贝为草稿
    this._draft = JSON.parse(JSON.stringify(found.rec));
    // 数组域的 key 是数字 index，但编辑用副本即可
    if (Array.isArray(this._data())) this._draft._key = found.key;
    this.render();
  }

  _formHtml() {
    const rec = this._draft;
    const rows = Object.keys(this.def.schema).map(k => this._fieldHtml(k, this.def.schema[k], rec[k])).join('');
    return `<div class="te-form">
      <div class="te-form-h">编辑：${this._escape(this._nameOf(rec))}</div>
      <div class="te-fields">${rows}</div>
      ${this.def.levelEditor ? '<div id="te-level-host" class="te-level"></div>' : ''}
      <div class="te-form-f">
        <button class="pb-btn te-save">保存</button>
        <button class="pb-btn ghost te-dup">复制</button>
        <button class="pb-btn ghost te-del">删除</button>
        <button class="pb-btn ghost te-exp">导出JSON</button>
      </div>
      <div class="te-prev"><div class="te-prev-h">实时资产预览（保存即落地）</div><pre class="te-prev-b">${this._escape(JSON.stringify(rec, null, 2))}</pre></div>
    </div>`;
  }

  // 实时资产预览：把当前草稿序列化为 JSON（保存前即所见即所得，降低无代码出错率）
  _refreshPreview() {
    const pre = this.body && this.body.querySelector('.te-prev-b');
    if (!pre) return;
    try { pre.textContent = JSON.stringify(this._draft, null, 2); } catch (e) { pre.textContent = '（草稿无法序列化）'; }
  }

  // ── 逐等级编辑器（仅 def.levelEditor 工具启用，如技能编辑器）──
  // 把"技能总表(skills.json) 的 mpCost/cd/power/heal"与"分表(skillLevels.json) 的逐等级覆盖"打通：
  // 等级 chip 选择当前等级 → 编辑该级的 法力/CD/威力/治疗 + 公式系数（fallback=getDefaultSkillParams）。
  // 全部写入 Config.data.skillLevels[id].levels[L]，经 persistConfig('skillLevels') 落盘；
  // 战斗结算时 castSkill 经 resolveSkillParams → getSkillLevelData 自动取用，主游戏零回归。
  _deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  _deepMerge(t, s) {
    if (Array.isArray(s)) return s.slice();
    if (s && typeof s === 'object') {
      t = (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
      for (const k in s) t[k] = this._deepMerge(t[k], s[k]);
      return t;
    }
    return s;
  }
  _lvlPersist(id, sub) {
    Config.data.skillLevels[id] = sub;
    persistConfig('skillLevels', Config.data.skillLevels);
    this._refreshPreview();
  }
  _renderLevelEditor() {
    const host = this.body && this.body.querySelector('#te-level-host');
    if (!host || !this.def.levelEditor) return;
    const id = (this._draft && this._draft.id != null) ? String(this._draft.id) : null;
    host.innerHTML = '';
    if (!id) { host.innerHTML = '<div class="te-note">保存该技能后即可在下方按等级单独设定数值</div>'; return; }
    const rec = (Config.data.skills && Config.data.skills[id]) || this._draft || {};
    let maxLevel = (rec && rec.maxLevel) ? rec.maxLevel : ((rec && rec.desc && String(rec.desc).indexOf('11级') >= 0) ? 11 : 10);
    Config.data.skillLevels = Config.data.skillLevels || {};
    if (!Config.data.skillLevels[id]) Config.data.skillLevels[id] = { maxLevel, levels: {} };
    const sub = Config.data.skillLevels[id];
    if (sub.maxLevel == null) sub.maxLevel = maxLevel;
    if (this._lvl == null || this._lvl < 1) this._lvl = 1;
    if (this._lvl > sub.maxLevel) this._lvl = sub.maxLevel;

    const h = document.createElement('div'); h.className = 'te-lv-h'; h.textContent = '逐等级数值（分表 skillLevels.json · 每个等级单独设定）'; host.appendChild(h);

    const chips = document.createElement('div'); chips.className = 'te-lv-chips';
    for (let L = 1; L <= sub.maxLevel; L++) {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'te-lv-chip' + (L === this._lvl ? ' on' : ''); c.textContent = L;
      c.onclick = () => { this._lvl = L; this._renderLevelEditor(); };
      chips.appendChild(c);
    }
    host.appendChild(chips);

    const L = this._lvl;
    if (!sub.levels[L]) sub.levels[L] = { mpCost: rec.mpCost || 0, cd: rec.cd || 0, power: rec.power || 0, heal: rec.heal || 0, params: {} };
    const lvl = sub.levels[L];

    const grid = document.createElement('div'); grid.className = 'te-lv-grid';
    [['mpCost', '法力消耗'], ['cd', '冷却回合'], ['power', '伤害系数'], ['heal', '治疗量']].forEach(([k, lab]) => {
      const row = document.createElement('div'); row.className = 'te-lv-row';
      const l = document.createElement('label'); l.textContent = lab; row.appendChild(l);
      const i = document.createElement('input'); i.type = 'number'; i.value = (lvl[k] != null ? lvl[k] : (rec[k] || 0)); i.className = 'te-in';
      i.addEventListener('change', () => { lvl[k] = parseFloat(i.value) || 0; this._lvlPersist(id, sub); });
      row.appendChild(i); grid.appendChild(row);
    });
    host.appendChild(grid);

    const ph = document.createElement('div'); ph.className = 'te-lv-h'; ph.textContent = '公式系数（逐等级覆盖 · 留空/默认=按总表自动）'; host.appendChild(ph);
    const pbox = document.createElement('div'); pbox.className = 'te-lv-params';
    const defParams = getDefaultSkillParams(id);
    const merged = this._deepClone(defParams);
    this._deepMerge(merged, lvl.params || {});
    buildParamsEditor(pbox, defParams, merged, '', () => { lvl.params = merged; this._lvlPersist(id, sub); }, id);
    host.appendChild(pbox);

    const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'pb-btn ghost'; rb.textContent = '重置该级为默认（清空覆盖）';
    rb.onclick = () => { sub.levels[L] = { mpCost: rec.mpCost || 0, cd: rec.cd || 0, power: rec.power || 0, heal: rec.heal || 0, params: {} }; this._lvlPersist(id, sub); this._renderLevelEditor(); };
    host.appendChild(rb);
  }

  _fieldHtml(k, f, val) {
    const v = val == null ? (f.default != null ? f.default : '') : val;
    const lbl = `<label class="te-fl">${this._escape(f.label || k)}${f.required ? '<i class="te-req">*</i>' : ''}</label>`;
    let ctrl = '';
    switch (f.type) {
      case 'textarea':
        ctrl = `<textarea class="te-in" data-field="${k}" rows="${f.rows || 3}">${this._escape(typeof v === 'string' ? v : JSON.stringify(v))}</textarea>`;
        break;
      case 'number':
        ctrl = `<input class="te-in" type="number" data-field="${k}" value="${v}" ${f.min != null ? 'min=' + f.min : ''} ${f.max != null ? 'max=' + f.max : ''} ${f.step ? 'step=' + f.step : ''}/>`;
        break;
      case 'boolean':
        ctrl = `<label class="te-sw"><input type="checkbox" data-field="${k}" ${v ? 'checked' : ''}/> ${v ? '开' : '关'}</label>`;
        break;
      case 'select': {
        const opts = (f.options || []).map(o => `<option value="${this._escape(o)}" ${o === v ? 'selected' : ''}>${this._escape(o)}</option>`).join('');
        ctrl = `<select class="te-in" data-field="${k}">${opts}</select>`;
        break;
      }
      case 'multiselect': {
        const set = Array.isArray(v) ? v : [];
        const opts = (f.options || []).map(o => `<label class="te-chk"><input type="checkbox" data-field="${k}" data-val="${this._escape(o)}" ${set.includes(o) ? 'checked' : ''}/> ${this._escape(o)}</label>`).join('');
        ctrl = `<div class="te-multi">${opts}</div>`;
        break;
      }
      case 'idref': {
        const names = domainIdNames(f.ref);
        const opts = ['<option value="">（无）</option>'].concat(Object.keys(names).map(id => `<option value="${this._escape(id)}" ${String(id) === String(v) ? 'selected' : ''}>${this._escape(id + ' · ' + names[id])}</option>`)).join('');
        ctrl = `<select class="te-in" data-field="${k}">${opts}</select>`;
        break;
      }
      case 'idref-ref': {   // 表格内联引用：与 idref 同款下拉，但强约束目标域必须存在该 id（保存时校验）
        const names = domainIdNames(f.ref);
        const opts = ['<option value="">（无）</option>'].concat(Object.keys(names).map(id => `<option value="${this._escape(id)}" ${String(id) === String(v) ? 'selected' : ''}>${this._escape(id + ' · ' + names[id])}</option>`)).join('');
        ctrl = `<select class="te-in" data-field="${k}">${opts}</select>`;
        break;
      }
      case 'idlist': {
        const names = domainIdNames(f.ref);
        const set = Array.isArray(v) ? v : [];
        const opts = Object.keys(names).map(id => `<label class="te-chk"><input type="checkbox" data-field="${k}" data-val="${this._escape(id)}" ${set.includes(id) ? 'checked' : ''}/> ${this._escape(id + ' · ' + names[id])}</label>`).join('');
        ctrl = `<div class="te-multi">${opts || '<span class="te-empty">（引用域为空）</span>'}</div>`;
        break;
      }
      case 'json':
        ctrl = `<textarea class="te-in te-json" data-field="${k}" rows="${f.rows || 4}">${this._escape(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</textarea>`;
        break;
      case 'list':
        ctrl = `<textarea class="te-in" data-field="${k}" rows="${f.rows || 4}" placeholder="每行一项">${this._escape(Array.isArray(v) ? v.join('\n') : '')}</textarea>`;
        break;
      case 'kv':
        ctrl = this._kvHtml(k, v);
        break;
      case 'table':
        ctrl = this._tableHtml(k, f, v);
        break;
      default: // text / expression
        ctrl = `<input class="te-in" type="text" data-field="${k}" value="${this._escape(v)}" ${f.placeholder ? 'placeholder="' + this._escape(f.placeholder) + '"' : ''}/>`;
    }
    if (f.hint) ctrl += `<div class="te-hint">${this._escape(f.hint)}</div>`;
    return `<div class="te-field te-field-${f.type}"><div class="te-frow">${lbl}${ctrl}</div></div>`;
  }

  _kvHtml(k, v) {
    const rows = Array.isArray(v) ? v : [];
    const body = rows.map((kv, i) => `<div class="te-kvrow" data-i="${i}"><input class="te-in te-k" data-kfield="${k}" data-sub="k" data-i="${i}" value="${this._escape(kv.k || '')}"/><input class="te-in te-v" data-kfield="${k}" data-sub="v" data-i="${i}" value="${this._escape(kv.v != null ? kv.v : '')}"/><button class="pb-btn ghost te-kvdel" data-kfield="${k}" data-i="${i}">✕</button></div>`).join('');
    return `<div class="te-kv" data-kfield="${k}">${body}<button class="pb-btn ghost te-kvadd" data-kfield="${k}">＋ 添加键值</button></div>`;
  }

  _tableHtml(k, f, v) {
    const rows = Array.isArray(v) ? v : [];
    const sub = f.sub || {};
    const head = Object.keys(sub).map(sk => `<th>${this._escape(sub[sk].label || sk)}</th>`).join('') + '<th></th>';
    const body = rows.map((row, i) => {
      const cells = Object.keys(sub).map(sk => {
        const sf = sub[sk];
        const rv = row[sk];
        if (sf.type === 'number') return `<td><input class="te-in te-tnum" data-tfield="${k}" data-col="${sk}" data-i="${i}" type="number" value="${rv != null ? rv : ''}"/></td>`;
        if (sf.type === 'boolean') return `<td><input type="checkbox" data-tfield="${k}" data-col="${sk}" data-i="${i}" ${rv ? 'checked' : ''}/></td>`;
        if (sf.type === 'select') return `<td><select class="te-in" data-tfield="${k}" data-col="${sk}" data-i="${i}">${(sf.options||[]).map(o=>`<option ${o===rv?'selected':''}>${this._escape(o)}</option>`).join('')}</select></td>`;
        if (sf.type === 'idref-ref') { const names = domainIdNames(sf.ref); return `<td><select class="te-in" data-tfield="${k}" data-col="${sk}" data-i="${i}">${['<option value="">（无）</option>'].concat(Object.keys(names).map(id => `<option value="${this._escape(id)}" ${String(id) === String(rv) ? 'selected' : ''}>${this._escape(id + ' · ' + names[id])}</option>`)).join('')}</select></td>`; }
        return `<td><input class="te-in" data-tfield="${k}" data-col="${sk}" data-i="${i}" value="${this._escape(rv != null ? rv : '')}"/></td>`;
      }).join('');
      return `<tr>${cells}<td><button class="pb-btn ghost te-trowdel" data-tfield="${k}" data-i="${i}">✕</button></td></tr>`;
    }).join('');
    return `<div class="te-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><button class="pb-btn ghost te-trowadd" data-tfield="${k}">＋ 添加行</button></div>`;
  }

  _bindForm() {
    const form = this.body.querySelector('.te-form');
    if (!form) return;
    // 键盘即时写草稿
    form.querySelectorAll('[data-field]').forEach(el => {
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(ev, () => this._writeField(el));
    });
    // kv
    form.querySelectorAll('[data-kfield]').forEach(el => {
      if (el.classList.contains('te-kvadd')) { el.onclick = () => this._kvAdd(el.dataset.kfield); return; }
      if (el.classList.contains('te-kvdel')) { el.onclick = () => this._kvDel(el.dataset.kfield, +el.dataset.i); return; }
      const ev = (el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(ev, () => this._writeKv(el));
    });
    // table
    form.querySelectorAll('[data-tfield]').forEach(el => {
      if (el.classList.contains('te-trowadd')) { el.onclick = () => this._tAdd(el.dataset.tfield); return; }
      if (el.classList.contains('te-trowdel')) { el.onclick = () => this._tDel(el.dataset.tfield, +el.dataset.i); return; }
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(ev, () => this._writeT(el));
    });
    form.querySelector('.te-save').onclick = () => this._save();
    form.querySelector('.te-dup').onclick = () => this._dup();
    form.querySelector('.te-del').onclick = () => this._del();
    form.querySelector('.te-exp').onclick = () => this._export();
    this._refreshPreview();
  }

  _writeField(el) {
    const k = el.dataset.field;
    const f = this.def.schema[k];
    let val;
    if (f.type === 'boolean') val = el.checked;
    else if (f.type === 'number') val = el.value === '' ? (f.default != null ? f.default : 0) : Number(el.value);
    else if (f.type === 'multiselect') {
      const set = Array.from(this.body.querySelectorAll(`[data-field="${k}"]`)).filter(c => c.checked).map(c => c.dataset.val);
      val = set;
    } else if (f.type === 'idlist') {
      const set = Array.from(this.body.querySelectorAll(`[data-field="${k}"]`)).filter(c => c.checked).map(c => c.dataset.val);
      val = set;
    } else if (f.type === 'list') val = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    else if (f.type === 'json') {
      // 解析失败：标红 + toast 提示，且不写草稿（避免静默丢弃/写入非法 JSON 破坏资产）
      try { val = JSON.parse(el.value || 'null'); el.classList.remove('te-err'); }
      catch (e) { el.classList.add('te-err'); this.ui && this.ui.toast && this.ui.toast('字段「' + (f.label || k) + '」JSON 解析失败，已暂不保存该项'); return; }
    }
    else val = el.value;
    this._draft[k] = val;
    this._refreshPreview();
  }

  _writeKv(el) {
    const k = el.dataset.kfield, i = +el.dataset.i, sub = el.dataset.sub;
    if (!Array.isArray(this._draft[k])) this._draft[k] = [];
    if (!this._draft[k][i]) this._draft[k][i] = {};
    this._draft[k][i][sub] = (el.type === 'checkbox') ? el.checked : el.value;
    this._refreshPreview();
  }
  _kvAdd(k) { if (!Array.isArray(this._draft[k])) this._draft[k] = []; this._draft[k].push({ k: '', v: '' }); this.render(); }
  _kvDel(k, i) { if (Array.isArray(this._draft[k])) { this._draft[k].splice(i, 1); this.render(); } }

  _writeT(el) {
    const k = el.dataset.tfield, col = el.dataset.col, i = +el.dataset.i;
    if (!Array.isArray(this._draft[k])) this._draft[k] = [];
    if (!this._draft[k][i]) this._draft[k][i] = {};
    const sf = this.def.schema[k].sub[col];
    let v = (el.type === 'checkbox') ? el.checked : el.value;
    if (sf.type === 'number') v = v === '' ? 0 : Number(v);
    this._draft[k][i][col] = v;
    this._refreshPreview();
  }
  _tAdd(k) { if (!Array.isArray(this._draft[k])) this._draft[k] = []; const blank = {}; Object.keys(this.def.schema[k].sub).forEach(s => blank[s] = this.def.schema[k].sub[s].default != null ? this.def.schema[k].sub[s].default : ''); this._draft[k].push(blank); this.render(); }
  _tDel(k, i) { if (Array.isArray(this._draft[k])) { this._draft[k].splice(i, 1); this.render(); } }

  _commit() {
    // 把 form 上的可见值同步进草稿（防漏）
    this.body.querySelectorAll('[data-field]').forEach(el => { if (!el.classList.contains('te-kvadd') && !el.classList.contains('te-kvdel')) this._writeField(el); });
  }

  _save() {
    this._commit();
    // JSON 字段解析错误阻断保存（避免落地非法资产）
    const errEl = this.body && this.body.querySelector('.te-err');
    if (errEl) { this.ui && this.ui.toast && this.ui.toast('存在 JSON 解析错误的字段，请先修正后再保存'); return; }
    // 必填校验
    for (const k in this.def.schema) {
      const f = this.def.schema[k];
      if (f.required && (this._draft[k] == null || this._draft[k] === '')) {
        this.ui && this.ui.toast && this.ui.toast('「' + (f.label || k) + '」为必填项');
        return;
      }
    }
    // 引用完整性校验：idref / idref-ref / idlist（含 table 子字段）指向的 id 必须在目标域存在，否则运行期会 undefined（悬空引用）
    for (const k in this.def.schema) {
      const f = this.def.schema[k];
      if (f.type === 'idref' && f.ref) {
        const v = this._draft[k];
        if (v != null && v !== '' && !this._refExists(f.ref, v)) {
          this.ui && this.ui.toast && this.ui.toast('「' + (f.label || k) + '」引用了不存在的 ' + f.ref + '：' + v);
          return;
        }
      } else if (f.type === 'idref-ref' && f.ref) {
        const v = this._draft[k];
        if (v != null && v !== '' && !this._refExists(f.ref, v)) {
          this.ui && this.ui.toast && this.ui.toast('「' + (f.label || k) + '」引用了不存在的 ' + f.ref + '：' + v);
          return;
        }
      } else if (f.type === 'idlist' && f.ref) {
        const arr = Array.isArray(this._draft[k]) ? this._draft[k] : [];
        for (const id of arr) { if (!this._refExists(f.ref, id)) { this.ui && this.ui.toast && this.ui.toast('「' + (f.label || k) + '」引用了不存在的 ' + f.ref + '：' + id); return; } }
      } else if (f.type === 'table' && f.sub) {
        const rows = Array.isArray(this._draft[k]) ? this._draft[k] : [];
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          for (const ck in f.sub) {
            const sf = f.sub[ck];
            if (sf.type === 'idref-ref' && sf.ref) {
              const v = row[ck];
              if (v != null && v !== '' && !this._refExists(sf.ref, v)) {
                this.ui && this.ui.toast && this.ui.toast('「' + (f.label || k) + '」第 ' + (ri + 1) + ' 行引用了不存在的 ' + sf.ref + '：' + v);
                return;
              }
            }
          }
        }
      }
    }
    const d = this._data();
    const idKey = this.def.idField || 'id';
    if (Array.isArray(d)) {
      const idx = this._draft._key != null ? this._draft._key : d.length;
      delete this._draft._key;
      if (idx >= d.length) d.push(this._draft); else d[idx] = this._draft;
    } else {
      const key = (this._draft[idKey] != null) ? this._draft[idKey] : this._sel;
      d[key] = this._draft;
    }
    persistConfig(this.def.domain, d);
    this._sel = Array.isArray(d) ? d.length - 1 : (this._draft[idKey] != null ? this._draft[idKey] : this._sel);
    this.ui && this.ui.toast && this.ui.toast('已保存：' + this._nameOf(this._draft));
    this.ui && this.ui.refresh && this.ui.refresh();
    this.render();
  }

  // 由 schema 的 default 播种一条「合法骨架」记录（点「新建」即得到可保存的空资产，而非 {}）
  _blankRecord() {
    const rec = {};
    for (const k in this.def.schema) {
      const f = this.def.schema[k];
      if (f.default !== undefined) rec[k] = f.default;
      else if (f.type === 'list' || f.type === 'kv' || f.type === 'table' || f.type === 'idlist' || f.type === 'multiselect') rec[k] = [];
      else if (f.type === 'json') rec[k] = (f.default !== undefined ? f.default : null);
      // text/number/select/boolean/textarea/idref/expression：留空，必填项会在 _save 校验
    }
    return rec;
  }

  // 对象域自动建议一个不重复的 id（数字 id 域取 max+1，字符串 id 域回退时间戳）
  _suggestId() {
    const d = this._data();
    const recs = Array.isArray(d) ? d : Object.values(d);
    const nums = recs.map(r => (r && r.id != null) ? Number(r.id) : NaN).filter(n => !isNaN(n));
    if (nums.length) return String(Math.max(...nums) + 1);
    return 'new_' + Date.now();
  }

  // 引用域是否存在某 id（供保存前悬空引用校验）
  _refExists(ref, id) {
    const d = Config.data[ref];
    if (!d) return false;
    if (Array.isArray(d)) return d.some(r => r && r.id != null && String(r.id) === String(id));
    return d[id] != null;
  }

  _new() {
    const rec = Object.assign(this._blankRecord(), this.def.newRecord ? this.def.newRecord() : {});
    const d = this._data();
    if (Array.isArray(d)) { this._sel = d.length; rec._key = d.length; }
    else { const nk = this._suggestId(); this._sel = nk; rec[this.def.idField || 'id'] = nk; }
    this._draft = rec;
    this.render();
  }

  _dup() {
    if (this._sel == null) return;
    const copy = JSON.parse(JSON.stringify(this._draft));
    const d = this._data();
    if (Array.isArray(d)) { copy._key = d.length; d.push(copy); this._sel = d.length - 1; }
    else { const nk = 'copy_' + Date.now(); copy[this.def.idField || 'id'] = nk; d[nk] = copy; this._sel = nk; }
    persistConfig(this.def.domain, d);
    this.render();
  }

  _del() {
    if (this._sel == null) return;
    const d = this._data();
    if (Array.isArray(d)) { d.splice(this._sel, 1); }
    else { delete d[this._sel]; }
    persistConfig(this.def.domain, d);
    this._sel = null; this._draft = null;
    this.render();
  }

  _export() {
    this._commit();
    const txt = JSON.stringify(this._draft, null, 2);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    console.log('[导出 ' + this.def.title + ']\n' + txt);
    this.ui && this.ui.toast && this.ui.toast('已导出到控制台/剪贴板');
  }

  _import() {
    const txt = prompt('粘贴 JSON（对象或数组）：');
    if (!txt) return;
    try {
      const obj = JSON.parse(txt);
      const d = this._data();
      if (Array.isArray(obj)) { for (const r of obj) d.push(r); }
      else if (Array.isArray(d)) { d.push(obj); }
      else { for (const k in obj) d[k] = obj[k]; }
      persistConfig(this.def.domain, d);
      this.render();
    } catch (e) { alert('JSON 解析失败：' + e.message); }
  }

  _escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
}

// 自定义功能工具基类（模拟器/一致性检测/GM/兑换码/经济监控等）
export class ToolPanel extends BasePanel {
  constructor(opts = {}) {
    super({
      id: opts.def.id,
      title: opts.def.title,
      width: opts.def.width || 720,
      height: opts.def.height || 560,
      ui: opts.ui,
      icon: opts.def.icon
    });
    this.def = opts.def;
  }
  init() { this.render(); }
  onOpen() { this.render(); }
  render() {
    if (!this.def) return;   // 同 SchemaEditor：构造期首次 init 跳过
    this.setContent('<div class="te-custom"></div>');
    if (this.def.render) this.def.render(this.body.querySelector('.te-custom'), this.ui, this);
  }
}
