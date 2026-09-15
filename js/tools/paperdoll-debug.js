// paperdoll-debug.js — 纸娃娃叠加层 编辑/调试 面板（研发/运营工具台工具之一）
// 入口在工具台「六、研发调试与运营后台」分组；UI / 关闭 / 拖动全部复用通用 BasePanel（panel-manager.js），
// 与游戏其它面板观感、行为一致（不再自造 DOM / 自造拖拽）。
// 功能：实时调试 Fighter 的纸娃娃叠加层（z 层级 / dx·dy 偏移 / 可见性 / 增删 / 翅膀显隐 / 模型缩放预览）。
// 无任何假数据/臆造：只读 Fighter 真实 layers 并调用其真实 setLayer/setLayerOffset/refreshPaperDoll 接口。
import { BasePanel } from '../ui/panel-manager.js?v=20261007c';
import { Fighter } from '../entities/fighter.js?v=20261007c';

export class PaperDollPanel extends BasePanel {
  constructor(opts = {}) {
    super({
      id: 'tool-pdoll',
      title: '纸娃娃叠加层调试',
      width: 320, height: 460,
      ui: opts.ui,
      icon: { dir: 'res', file: 'facesystem.png' }
    });
    this.target = null;
  }

  init() { this.render(); }
  onOpen() { this.render(); }   // 每次打开刷新（角色可能已变化）

  // ── 渲染面板内容 ──
  render() {
    this.setContent(`
      <div class="pdd">
        <div class="pdd-line"><label>调试目标</label>
          <select id="pdd-target"></select>
          <button class="pdd-btn" id="pdd-scan">刷新</button></div>
        <div class="pdd-line">
          <label class="pdd-inline"><input type="checkbox" id="pdd-wing"> 显示翅膀</label>
          <label class="pdd-inline">缩放<input type="range" id="pdd-scale" min="0.3" max="1.6" step="0.01" value="1"><span id="pdd-scale-val">1.00</span></label>
        </div>
        <div class="pdd-sep">叠加层</div>
        <div id="pdd-layers" class="pdd-layers"></div>
        <div class="pdd-line pdd-add">
          <label>加图层 ID</label>
          <input id="pdd-add-id" type="number" placeholder="charId">
          <button class="pdd-btn" id="pdd-add">叠加</button>
        </div>
        <div class="pdd-toast" id="pdd-toast"></div>
      </div>`);

    this._wire();
    this.scan();
  }

  // ── 枚举调试目标（Fighter._instances：游戏内全部存活 Fighter）──
  scan() {
    const sel = this.body.querySelector('#pdd-target');
    if (!sel) return;
    const insts = (Fighter._instances && Fighter._instances.size) ? Array.from(Fighter._instances) : [];
    sel.innerHTML = '';
    if (!insts.length) {
      sel.innerHTML = '<option value="">（无存活 Fighter）</option>';
      this.target = null;
    } else {
      insts.forEach((f, i) => {
        const op = document.createElement('option');
        op.value = String(i);
        op.textContent = (f.charId || '?') + (f.name ? (' · ' + f.name) : '') + ' #' + i;
        sel.appendChild(op);
      });
      let idx = 0;
      if (this.target) { const j = insts.indexOf(this.target); if (j >= 0) idx = j; }
      sel.value = String(idx);
      this.target = insts[idx];
    }
    this._renderLayers();
  }

  _selectTarget(f) { this.target = f; this._renderLayers(); }

  // ── 渲染当前目标的叠加层列表 ──
  _renderLayers() {
    const box = this.body.querySelector('#pdd-layers');
    if (!box) return;
    const f = this.target;
    if (!f) { box.innerHTML = '<div class="pdd-empty">请先在上方选择一个 Fighter。</div>'; return; }
    const wing = this.body.querySelector('#pdd-wing'); if (wing) wing.checked = !!f.showWings;
    const sc = this.body.querySelector('#pdd-scale');
    if (sc) sc.value = String((f.battleScale != null ? f.battleScale : 1));
    this.body.querySelector('#pdd-scale-val').textContent = (f.battleScale != null ? f.battleScale : 1).toFixed(2);

    const keys = Object.keys(f.layers || {});
    if (!keys.length) { box.innerHTML = '<div class="pdd-empty">该角色暂无叠加层。</div>'; return; }
    box.innerHTML = '';
    keys.forEach(key => {
      const L = f.layers[key];
      const visible = (L.el && L.el.style.display !== 'none');
      const row = document.createElement('div');
      row.className = 'pdd-row';
      row.innerHTML =
        '<div class="pdd-row-h"><span class="pdd-key" title="' + key + '">' + key + '</span>' +
        '<span class="pdd-cid">ID ' + (L.charId || '?') + '</span>' +
        '<button class="pdd-x" data-rm="' + key + '">移除</button></div>' +
        '<div class="pdd-grid">' +
        '<label>Z<input class="pdd-z" type="number" step="1" value="' + (L.z != null ? L.z : 6) + '"></label>' +
        '<label>dx<input class="pdd-dx" type="number" step="1" value="' + (L.dx || 0) + '"></label>' +
        '<label>dy<input class="pdd-dy" type="number" step="1" value="' + (L.dy || 0) + '"></label>' +
        '<label class="pdd-vis">可见<input class="pdd-visible" type="checkbox"' + (visible ? ' checked' : '') + '></label>' +
        '</div>';
      box.appendChild(row);
      row.querySelector('.pdd-z').addEventListener('change', e => {
        const z = parseInt(e.target.value, 10); if (!isNaN(z)) { L.z = z; L.el.style.zIndex = String(z); }
      });
      row.querySelector('.pdd-dx').addEventListener('change', e => {
        const dx = parseFloat(e.target.value) || 0; f.setLayerOffset(key, dx, L.dy || 0);
      });
      row.querySelector('.pdd-dy').addEventListener('change', e => {
        const dy = parseFloat(e.target.value) || 0; f.setLayerOffset(key, L.dx || 0, dy);
      });
      row.querySelector('.pdd-visible').addEventListener('change', e => {
        if (L.el) L.el.style.display = e.target.checked ? '' : 'none';
      });
      row.querySelector('.pdd-x').addEventListener('click', () => { f.removeLayer(key); this._renderLayers(); });
    });
  }

  _addDoll() {
    const f = this.target; if (!f) return;
    const inp = this.body.querySelector('#pdd-add-id');
    const id = parseInt(inp.value, 10); if (!id) return;
    const key = 'doll:' + Date.now();
    f.setLayer(key, id, { z: 6 });
    this._renderLayers();
    this._toast('已叠加图层 ' + id);
  }

  _setWing(on) {
    const f = this.target; if (!f) return;
    f.showWings = !!on;
    f.refreshPaperDoll();   // 重建装备层（翅膀槽按 showWings 决定去留）
    this._renderLayers();
  }

  _setScale(v) {
    const f = this.target; if (!f) return;
    f.battleScale = v;
    const base = (f._current && f._current.base) || 'stand';
    f.act(base, f.dir).catch(() => {});   // 重新应用缩放（act 读 battleScale 兜底）
    this.body.querySelector('#pdd-scale-val').textContent = v.toFixed(2);
  }

  _toast(t) {
    const el = this.body.querySelector('#pdd-toast');
    if (el) el.textContent = t;
  }

  _wire() {
    const b = this.body;
    b.querySelector('#pdd-target').addEventListener('change', e => {
      const insts = Array.from(Fighter._instances || []);
      this._selectTarget(insts[parseInt(e.target.value, 10)]);
    });
    b.querySelector('#pdd-scan').addEventListener('click', () => this.scan());
    b.querySelector('#pdd-wing').addEventListener('change', e => this._setWing(e.target.checked));
    b.querySelector('#pdd-scale').addEventListener('input', e => this._setScale(parseFloat(e.target.value)));
    b.querySelector('#pdd-add').addEventListener('click', () => this._addDoll());
  }
}
