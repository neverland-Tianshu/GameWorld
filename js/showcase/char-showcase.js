// char-showcase.js
// 模型展示（游戏引擎同款）：直接复用游戏内的 Fighter + loader.playChar + artOrigin 脚底锚，不做任何假数据/重实现。
// 两页：① 模型展示（锚点 + 战斗 + 纸娃娃 合并页） ② NPC 模块（地图切片 + 可放置 NPC）。
//
// 关键设计（用户 2026-08-20 指令）：
// - 模型展示页只维护【一个持久 Fighter 实例】，切动作走 act()（不重建）→ setLayer 纸娃娃层跨动作/跨页/换模型均保留。
// - 锚点显示开关（checkbox）控制脚底红叉显隐。
// - 切到 NPC 模块时【不 destroy】模型 Fighter（仅隐藏 model-layer、显示 npc-layer），回来图层仍在。
// - 仅「载入」换底层模型才重建 Fighter，且重建时按 this._dolls 真源重放纸娃娃层（图层不丢）。

import { Fighter } from '../entities/fighter.js?v=20261007c';
import { loadChar, resolveFoot, actionPoolSet } from '../core/loader.js?v=20261007c';
import { url, Config, loadConfig, resolveAction } from '../core/globals.js?v=20261007c';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

class Showcase {
  constructor() {
    this.stage = null;
    this.modelLayer = null;     // 模型展示页容器（持久 Fighter 常驻其中）
    this.npcLayer = null;       // NPC 模块容器
    this.cur = 'model';
    this.common = null;
    // —— 模型展示页持久状态 ——
    this.baseFig = null;        // 持久 Fighter（切动作/切页/换模型均不销毁，除非"载入"重建）
    this._hit = null;           // 模型页拖拽命中层
    this._originMark = null;    // 脚底原点红叉
    this._originMarkX = 400;
    this._originMarkY = 500;
    this._dolls = [];           // 纸娃娃层（真源：跨动作/跨页/换模型保留，重建时重放）
    this.dollSeq = 0;
    // —— NPC 模块状态（切出时不销毁模型 Fighter，仅隐藏）——
    this._mapBg = null;
    this._npcFigs = [];
    this._npcHits = [];
    this._npcBuilt = false;
    this.selected = null;
  }

  async init() {
    this.stage = $('#stage');
    if (!window.fanvas) { this.toast('Fanvas 运行时未加载'); return; }
    try { await loadConfig(); } catch (e) { /* 配置非必需，失败忽略 */ }
    this.modelLayer = $('#model-layer');
    this.npcLayer = $('#npc-layer');
    this._wireTabs();
    this._wireCommon();
    this._wireModel();
    this._wireNpc();
    this._wireStageClick();
    this.common = this._readCommon();
    this.switchTo('model');
  }

  // ── 工具 ──────────────────────────────────────────────
  toast(msg) {
    const t = $('#showcase-toast'); if (!t) return;
    t.textContent = msg; t.style.opacity = 1;
    clearTimeout(this.toast._t);
    this.toast._t = setTimeout(() => { t.style.opacity = 0; }, 1600);
  }
  _setHint(msg) { const h = $('#stage-hint'); if (h) h.textContent = msg || ''; }

  _readCommon() {
    return {
      id: parseInt($('#char-id').value, 10) || 100000,
      name: $('#char-name').value.trim() || '主角',
      dir: $('#char-dir').value || 'right',
      action: $('#char-action').value || 'stand'
    };
  }

  // ── 布线 ──────────────────────────────────────────────
  _wireTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => this.switchTo(t.dataset.sc)));
  }

  _wireCommon() {
    // 载入/换底层模型：重建模型 Fighter（按 this._dolls 重放纸娃娃层，图层不丢）
    $('#btn-load').addEventListener('click', () => {
      this.common = this._readCommon();
      this._recreateModel();
    });
    // 锚点显示开关
    $('#chk-origin').addEventListener('change', e => {
      if (this._originMark) this._originMark.style.display = e.target.checked ? 'block' : 'none';
    });
    // 切动作 / 切朝向：act() 实时切换，不重建 → 纸娃娃层保留
    $('#char-action').addEventListener('change', () => this._setAction());
    $('#char-dir').addEventListener('change', () => this._setAction());
  }

  _wireModel() {
    // 战斗指令：作用于单个模型（merged 页只有一名单位）
    $('#btn-bat-atk').addEventListener('click', () => this._battleHit());
    $('#btn-bat-heal').addEventListener('click', () => this._battleHeal());
    $('#btn-bat-cast').addEventListener('click', () => { if (this.baseFig) this.baseFig.cast(); });
    $('#btn-bat-down').addEventListener('click', () => { if (this.baseFig) this.baseFig.down(); });
    // 纸娃娃
    $('#btn-doll-add').addEventListener('click', () => this._addDoll());
    $('#btn-doll-clear').addEventListener('click', () => this._clearDolls());
  }

  _wireNpc() {
    $('#btn-map-npc').addEventListener('click', () => {
      if (this.cur !== 'npc') return;
      this._spawnNpc({ id: this.common.id, name: this.common.name, dir: this.common.dir,
        action: this.common.action, x: 400, y: 300 });
    });
    $('#btn-map-clear').addEventListener('click', () => this._clearNpcFigs());
  }

  _wireStageClick() {
    // NPC 模块：点击地图空白处放置当前模型为 NPC
    this.npcLayer.addEventListener('click', e => {
      if (this.cur !== 'npc') return;
      if (e.target !== this._mapBg && !e.target.classList.contains('map-tile')) return;
      const r = this.npcLayer.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this._spawnNpc({ id: this.common.id, name: this.common.name, dir: this.common.dir,
        action: this.common.action, x, y });
    });
  }

  // ── 页面切换 ──────────────────────────────────────────
  switchTo(sc) {
    this.cur = sc;
    $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.sc === sc));
    $$('.sc-block').forEach(b => { b.hidden = b.dataset.sc !== sc; });
    if (sc === 'model') {
      this.modelLayer.style.display = '';
      this.npcLayer.style.display = 'none';
      this.buildModel();
    } else {
      this.modelLayer.style.display = 'none';
      this.npcLayer.style.display = '';
      this.buildNpc();
    }
  }

  // ── ① 模型展示页（持久 Fighter） ─────────────────────
  buildModel() {
    if (!this.baseFig) this._createModel();
    // 确保三个元素都在 model-layer 且显示
    [this._hit, this.baseFig.el, this._originMark].forEach(el => {
      if (!el) return;
      if (el.parentNode !== this.modelLayer) this.modelLayer.appendChild(el);
      el.style.display = (el === this._originMark)
        ? ($('#chk-origin').checked ? 'block' : 'none')
        : '';
    });
    this.selected = this.baseFig;
    this._updateBattleReadout();
    this._setHint('模型展示：名称+血条浮头顶（战斗态），红叉=脚底原点（可开关）；拖动角色/切换动作，纸娃娃层不丢。');
  }

  // 首次创建或"载入"重建底层模型：均按 this._dolls 真源重放纸娃娃层
  _createModel() {
    const { id, name, dir, action } = this.common;
    this.baseFig = new Fighter({
      id, name, charId: id, dir,
      hp: 500, mp: 200, side: 'player',
      hpAbove: true, showBars: true        // 战斗态：名称+血条浮头顶
    });
    this.baseFig.setPos(400, 500);
    this.baseFig.el.classList.add('stage-fighter');
    this.modelLayer.appendChild(this.baseFig.el);   // 持久 Fighter 注入模型层（切出/切动作不销毁）
    if (action === 'stand') this.baseFig.stand();
    else this.baseFig.act(action, dir);
    this._makeOriginMark(400, 500);
    this._makeHit(this.baseFig, 400, 500, 'drag', this.modelLayer);
    // 重放纸娃娃层（跨换模型保留）
    this._dolls.forEach(d => {
      try { this.baseFig.setLayer(d.key, d.id, { z: d.z, dx: d.dx, dy: d.dy }); } catch (e) {}
    });
    this._refreshReadout();
  }

  // "载入"按钮：换底层模型 → 重建 Fighter，但保留并重放纸娃娃层
  _recreateModel() {
    if (this.baseFig) { try { this.baseFig.destroy(); } catch (e) {} this.baseFig = null; }
    if (this._hit && this._hit.parentNode) this._hit.remove(); this._hit = null;
    if (this._originMark && this._originMark.parentNode) this._originMark.remove(); this._originMark = null;
    this._createModel();
  }

  // 切动作 / 切朝向：act() 实时切换（不重建 → 纸娃娃层保留）
  _setAction() {
    this.common.action = $('#char-action').value || 'stand';
    this.common.dir = $('#char-dir').value || 'right';
    if (this.baseFig) this.baseFig.act(this.common.action, this.common.dir);
    this._refreshReadout();
  }

  _makeOriginMark(x, y) {
    const m = document.createElement('div');
    m.className = 'origin-mark';
    m.style.left = x + 'px'; m.style.top = y + 'px';
    m.innerHTML = '<span class="ox"></span><span class="oy"></span><span class="odot"></span>' +
      '<span class="olabel">脚底原点 fig(' + Math.round(x) + ',' + Math.round(y) + ')</span>';
    this.modelLayer.appendChild(m);
    this._originMark = m;
    this._originMarkX = x; this._originMarkY = y;
    m.style.display = $('#chk-origin').checked ? 'block' : 'none';
  }

  async _refreshReadout() {
    const { id, action, dir } = this.common;
    try { $('#origin-readout').textContent = await this._readOrigin(id, action, dir); }
    catch (e) { $('#origin-readout').textContent = '读取 artOrigin 失败：' + e.message; }
  }

  async _readOrigin(id, action, dir) {
    const rec = await loadChar(id);
    const a = resolveAction(rec.actions, action, dir);
    if (!a) return '该模型无 "' + action + ' / ' + dir + '" 动作精灵（将回退兜底模型）。';
    const pool = a.pool;
    const sd = rec.swfData;
    const ao = sd.artOrigin && sd.artOrigin[pool];
    const def = sd.definitionPool[pool];
    const rect = def && def.rect ? { x: def.rect.x, y: def.rect.y, width: def.rect.width, height: def.rect.height } : null;
    const diskBottom = rect ? rect.y + rect.height : null;
    const bloated = ao && diskBottom != null && (ao.y - diskBottom) > 2;
    // ★ 单 Role（无命名动作）盲推 (0,0)（user 2026-09-12：「role 盲推 0,0」）。rec.actions 来自 const labels。
    const hasNamed = !!(rec.actions && Object.keys(rec.actions).some(k => rec.actions[k] && !rec.actions[k].empty));
    const f = resolveFoot(id, ao, rect, bloated, sd, hasNamed, actionPoolSet(rec.actions));
    const foot = { x: f.x, y: f.y };
    const top = f.top;
    const footLabel = { override: '覆盖表(用户标定)', rootPlace: '常规：原始根时间轴 place(-256,-256) ⇒ (256,256)', roleOrigin: '单个 Role 精灵 ⇒ 符号原点(0,0)', center: '256 约定(内容居中于 ~256)' }[f.src] || f.src;
    return [
      '角色 ID：' + id,
      '动作 base：' + action + '   朝向：' + ({RB:'RB(右下)',LB:'LB(左下)',RT:'RT(右上)',LT:'LT(左上)',left:'LT(左)',right:'RB(右)'}[dir] || dir),
      '解析动作精灵 pool：' + pool + '  (frames=' + a.frames + ')',
      '',
      'artOrigin[' + pool + ']：' + (ao
        ? '{ x:' + ao.x + ', y:' + ao.y + ', top:' + ao.top + ' }' + (bloated ? '（⚠ 已判定 bloated：y 比 rect 底边低，回退符号原点）' : '（未 bloated，采用）')
        : '无'),
      '脚底落点(flash 坐标)：' + (foot ? '(' + Math.round(foot.x) + ', ' + Math.round(foot.y) + ')' : '未知') + '  ← ' + footLabel,
      '头顶 top(flash 坐标)：' + (top != null ? Math.round(top) : '未知'),
      '',
      '渲染时脚底 pin 到 fig(' + Math.round(this._originMarkX) + ', ' + Math.round(this._originMarkY) + ')，即红叉。',
      '名称/血条按脚底与头顶定位，不随画布平移偏移。'
    ].join('\n');
  }

  // ── ② NPC 模块（地图切片 + 可放置 NPC） ──────────────
  buildNpc() {
    if (!this._npcBuilt) {
      this._buildMapBgNpc();
      this._spawnNpc({ id: this.common.id, name: this.common.name, dir: this.common.dir,
        action: this.common.action, x: 400, y: 380 });
      this._spawnNpc({ id: this.common.id, name: '巡岛守卫', dir: 'left', action: 'stand', x: 170, y: 250 });
      this._spawnNpc({ id: this.common.id, name: '岛民', dir: 'left', action: 'stand', x: 630, y: 470 });
      this._npcBuilt = true;
    }
    this._setHint('NPC 模块：真实地图切片背景（灵仙岛·主城）；NPC 以主城态呈现（名称在脚底下方，hpAbove=false）。点击地图空白或「添加 NPC」放置当前模型，可拖动。');
  }

  _buildMapBgNpc() {
    const bg = document.createElement('div');
    bg.className = 'map-bg';
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const img = document.createElement('img');
        img.className = 'map-tile';
        img.src = url.mapTile(1, col, row);
        img.style.left = (col * 200) + 'px';
        img.style.top = (row * 150) + 'px';
        img.alt = ''; img.draggable = false;
        bg.appendChild(img);
      }
    }
    this.npcLayer.appendChild(bg);
    this._mapBg = bg;
  }

  _spawnNpc(o) {
    const fig = new Fighter({
      id: o.id, name: o.name, charId: o.id, dir: o.dir,
      hp: o.hp || 100, mp: o.mp || 50,
      side: o.side || 'npc', hpAbove: false, showBars: false
    });
    fig.setPos(o.x, o.y);
    fig.el.classList.add('stage-fighter');
    this.npcLayer.appendChild(fig.el);
    if ((o.action || 'stand') === 'stand') fig.stand();
    else fig.act(o.action, o.dir);
    this._npcFigs.push(fig);
    this._makeHit(fig, o.x, o.y, 'drag', this.npcLayer);
    return fig;
  }

  _clearNpcFigs() {
    this._npcFigs.forEach(f => { try { f.destroy(); } catch (e) {} });
    this._npcFigs = [];
    this._npcHits.forEach(h => h.remove());
    this._npcHits = [];
  }

  // ── 拖拽命中层（canvas pointer-events:none，点击落点交给 hit 层） ──
  _makeHit(fig, x, y, mode, layer) {
    const hit = document.createElement('div');
    hit.className = 'fighter-hit';
    hit.style.position = 'absolute';
    hit.style.width = '180px'; hit.style.height = '230px';
    hit.style.left = (x - 90) + 'px'; hit.style.top = (y - 210) + 'px';
    hit.style.background = 'transparent';
    hit.style.zIndex = '40';
    hit.style.pointerEvents = (mode === 'none') ? 'none' : 'auto';
    hit.style.cursor = (mode === 'drag') ? 'grab' : (mode === 'select' ? 'pointer' : 'default');
    layer.appendChild(hit);
    if (fig === this.baseFig) this._hit = hit;
    else this._npcHits.push(hit);
    hit.addEventListener('mousedown', e => this._onHitDown(e, fig, hit, mode));
    return hit;
  }

  _onHitDown(e, fig, hit, mode) {
    if (mode === 'none') return;
    e.preventDefault();
    const layer = (fig === this.baseFig) ? this.modelLayer : this.npcLayer;
    const r = layer.getBoundingClientRect();
    const gdx = e.clientX - r.left - fig.x, gdy = e.clientY - r.top - fig.y;
    hit.style.cursor = 'grabbing';
    const move = ev => {
      const nx = ev.clientX - r.left - gdx, ny = ev.clientY - r.top - gdy;
      fig.setPos(nx, ny);
      hit.style.left = (nx - 90) + 'px'; hit.style.top = (ny - 210) + 'px';
      if (fig === this.baseFig && this._originMark) {
        this._originMarkX = nx; this._originMarkY = ny;
        this._originMark.style.left = nx + 'px'; this._originMark.style.top = ny + 'px';
        this._originMark.querySelector('.olabel').textContent = '脚底原点 fig(' + Math.round(nx) + ',' + Math.round(ny) + ')';
      }
    };
    const up = () => {
      hit.style.cursor = 'grab';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ── 战斗指令（作用于单个模型） ────────────────────────
  _battleHit() {
    if (!this.baseFig) return;
    const dmg = Math.max(1, Math.round(Math.random() * 30 + 10));
    this.baseFig.takeDamage(dmg);
    this._float(this.baseFig, '-' + dmg, '#ff6b6b');
    this._updateBattleReadout();
  }
  _battleHeal() {
    if (!this.baseFig) return;
    const v = Math.round(Math.random() * 20 + 20);
    this.baseFig.heal(v);
    this._float(this.baseFig, '+' + v, '#7CFC9B');
    this._updateBattleReadout();
  }
  _updateBattleReadout() {
    const f = this.baseFig; if (!f) return;
    $('#battle-readout').textContent =
      f.name + '：HP ' + Math.round(f.hp) + '/' + Math.round(f.maxHp) +
      (f.mp != null ? '   MP ' + Math.round(f.mp) + '/' + Math.round(f.maxMp) : '');
  }

  _float(fig, text, color) {
    const x = fig.x;
    const y = fig.y + (fig._modelHeadY != null ? fig._modelHeadY : -60);
    const el = document.createElement('div');
    el.className = 'float-num'; el.textContent = text; el.style.color = color;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    this.modelLayer.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  // ── 纸娃娃（持久） ────────────────────────────────────
  _addDoll() {
    const id = parseInt($('#doll-id').value, 10);
    if (!id || !this.baseFig) return;
    const key = 'doll:' + (this.dollSeq++);
    this.baseFig.setLayer(key, id, { z: 6 });
    this._dolls.push({ key, id, z: 6, dx: 0, dy: 0 });
    this._renderDollList();
    this.toast('已叠加图层 ' + id);
  }
  _removeDoll(key) {
    if (this.baseFig) this.baseFig.removeLayer(key);
    this._dolls = this._dolls.filter(d => d.key !== key);
    this._renderDollList();
  }
  _clearDolls() {
    if (this.baseFig) this.baseFig.clearLayers();
    this._dolls = [];
    this._renderDollList();
  }
  _renderDollList() {
    const box = $('#doll-list');
    box.innerHTML = '';
    if (!this._dolls.length) { box.innerHTML = '<div class="doll-empty">尚未叠加图层。</div>'; return; }
    this._dolls.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'doll-row';
      row.innerHTML =
        '<span class="doll-no">#' + (i + 1) + '</span>' +
        '<span class="doll-f">ID<input class="doll-id" type="number" value="' + d.id + '" readonly></span>' +
        '<span class="doll-f">Z<input class="doll-z" type="number" value="' + (d.z || 6) + '"></span>' +
        '<span class="doll-f">X<input class="doll-dx" type="number" value="' + (d.dx || 0) + '"></span>' +
        '<span class="doll-f">Y<input class="doll-dy" type="number" value="' + (d.dy || 0) + '"></span>' +
        '<button class="btn-mini btn-danger" data-rm="' + d.key + '">移除</button>';
      box.appendChild(row);
      row.querySelector('.doll-z').addEventListener('change', e =>
        { if (this.baseFig) this.baseFig.setLayer(d.key, d.id, { z: parseInt(e.target.value, 10) || 6 }); });
      row.querySelector('.doll-dx').addEventListener('change', e =>
        { if (this.baseFig) this.baseFig.setLayerOffset(d.key, parseInt(e.target.value, 10) || 0, d.dy || 0); });
      row.querySelector('.doll-dy').addEventListener('change', e =>
        { if (this.baseFig) this.baseFig.setLayerOffset(d.key, d.dx || 0, parseInt(e.target.value, 10) || 0); });
      row.querySelector('[data-rm]').addEventListener('click', () => this._removeDoll(d.key));
    });
  }
}

const app = new Showcase();
// 调试暴露点：与 game.js 的 window.__TS 同理，便于在控制台/自动化探针里拿到当前 Fighter
// （app.baseFig = 底层模型 Fighter，app 本身含 common/_dolls 等真源）。只读用途，不影响逻辑。
window.__showcase = app;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
else app.init();
