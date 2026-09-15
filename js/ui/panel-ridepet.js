// panel-ridepet.js
// 骑宠系统面板（2026-10-04，用户需求：给游戏加入一个简单的骑宠系统）。
//
// 功能：
//   ① 输入骑宠ID（4xxxxx，67 个骑宠模型）与角色ID（空 = 当前主角模型）；
//   ② 面板内预览合成效果 —— 骑宠 bg(骑手身后) + 人物 + 骑宠 fg(骑手身前)，可切换 站立/行走 与 4 向朝向；
//      两种表现自动呈现：人物有 ride 动画（如 110100 的 standRBride）→ 人物播乘骑动画；
//      无 ride 动画（如主角 100000）→ 人物播普通 stand/walk，整个 body 包在骑宠前后景之间；
//   ③ 「上骑 / 下骑」按钮：对主城主角切换骑乘状态（fighter.mountRide / dismount），按钮文字两态切换；
//   ④ 骑乘状态持久化（ridepet-state.js），登录后自动恢复。
//
// 渲染原语复用 loader.js：playChar（人物，opts.ride 优先乘骑动画）+ playRideLayer（骑宠 bg/fg 池）。
// 锚定：三张画布的 Flash 原点(0,0) 对齐到同一点（与 fighter 纸娃娃层同源：left = 原点X + rect.x*scale），
//   LB/RT 朝向由 rp-flip 整体 scaleX(-1) 生成（绕 Flash 原点轴，与 fighter._applyFlip 一致）。

import { BasePanel } from './panel-manager.js?v=20261007c';
import { playChar, playRideLayer, destroyCanvas } from '../core/loader.js?v=20261007c';
import { ridepetState } from '../ridepet/ridepet-state.js?v=20261007c';
import { getRidepetType, setRidepetType, getRidepetLift } from '../ridepet/ridepet-type.js?v=20261007c';   // 骑宠显示类型（乘骑型/站立型）+ per-model 站立抬升量

const STAGE_W = 372, STAGE_H = 196;
const DIRS = ['RB', 'LB', 'RT', 'LT'];
const DIR_NAME = { RB: '右下', LB: '左下', RT: '右上', LT: '左上' };
const FLIP_DIR = { LB: 'RB', RT: 'LT' };   // 合成方向 → 真实素材方向（LB/RT 由整体翻转生成）

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class RidePetPanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-ridepet', title: '骑宠', width: 424, height: 470, ui,
      icon: { dir: 'res', file: 'panelridepetbg.png' },
    });
    this._rpId = ridepetState.ridepetId || '400000';
    this._charId = ridepetState.charId || '';      // '' = 当前主角
    this._pvBase = 'stand';                        // 预览动作
    this._pvDir = 'RB';                            // 预览朝向（逻辑朝向，含 LB/RT 合成方向）
    this._riding = !!ridepetState.riding;
    this._pvNote = '';
    this._render();
    this._loadIdList();
    this._refreshAll();   // ⚠ 不能用 init() 钩子：BasePanel 在 super() 期间调 init，此时字段还没初始化
  }

  onOpen() { this._refreshAll(); }

  _player() { return (this.ui && this.ui.player) || null; }

  // 有效骑宠ID清单（chars.json 里 kind='ridepet' 的 bodyImage；配置未加载时不影响输入）
  async _loadIdList() {
    // 骑宠模型清单 = chars.json 里 kind='ridepet' 且有 bodyImage 的条目（造型字段仍在 chars.json）
    try {
      const chars = (window.__CONFIG && window.__CONFIG.chars) || null;
      const ids = chars
        ? Object.values(chars).filter(c => c && c.kind === 'ridepet' && c.bodyImage).map(c => String(c.bodyImage)).sort()
        : [];
      const dl = this.dom.querySelector('#rp-id-list');
      if (dl) dl.innerHTML = ids.map(id => `<option value="${esc(id)}"></option>`).join('');
    } catch (e) { /* 配置未加载时退化为纯手工输入 */ }
  }

  _render() {
    const body = this.setContent(`
      <div class="rp-row">
        <label class="rp-lbl">骑宠ID</label>
        <input class="rp-in" id="rp-in-pet" list="rp-id-list" value="${esc(this._rpId)}" placeholder="400000-499999" maxlength="6" inputmode="numeric"/>
        <label class="rp-lbl">角色ID</label>
        <input class="rp-in" id="rp-in-char" value="${esc(this._charId)}" placeholder="空=当前主角" maxlength="6" inputmode="numeric"/>
        <datalist id="rp-id-list"></datalist>
      </div>
      <div class="rp-stage" id="rp-stage">
        <div class="rp-flip" id="rp-flip">
          <div class="rp-layer" id="rp-l-bg"></div>
          <div class="rp-layer" id="rp-l-char"></div>
          <div class="rp-layer" id="rp-l-fg"></div>
        </div>
        <div class="rp-empty" id="rp-empty">预览不可用：请检查骑宠ID是否为 4xxxxx 骑宠模型</div>
      </div>
      <div class="rp-ctl">
        <button class="rp-btn" id="rp-pv-stand">站立</button>
        <button class="rp-btn" id="rp-pv-walk">行走</button>
        <button class="rp-btn" id="rp-pv-dir">方向：右下</button>
      </div>
      <div class="rp-ctl">
        <button class="rp-btn" id="rp-type-ride">乘骑态</button>
        <button class="rp-btn" id="rp-type-stand">站立态</button>
        <span class="rp-note" style="align-self:center">切换人物的骑乘表现（乘骑态=人物骑乘+武器隐藏；站立态=人物站骑宠上+武器保留）</span>
      </div>
      <div class="rp-status" id="rp-status"></div>
    `);
    this._stageEl = body.querySelector('#rp-stage');
    this._flipEl = body.querySelector('#rp-flip');
    this._emptyEl = body.querySelector('#rp-empty');
    this._statusEl = body.querySelector('#rp-status');
    this._dirBtn = body.querySelector('#rp-pv-dir');
    this._petInput = body.querySelector('#rp-in-pet');
    this._charInput = body.querySelector('#rp-in-char');
    this._typeRideBtn = body.querySelector('#rp-type-ride');
    this._typeStandBtn = body.querySelector('#rp-type-stand');

    // ⚠ 只在 change（失焦/回车）时触发：input 事件会在敲到一半时请求
    //   resource/char/40000/（用户在开发者工具看到的"少了个0"的请求就是这个中间态）
    const upd = () => {
      this._rpId = this._petInput.value.trim();
      this._charId = this._charInput.value.trim();
      this._rpMeta = null;          // id 可能变了，强制重读模型配置
      this._refreshAll();
    };
    this._petInput.addEventListener('change', upd);
    this._charInput.addEventListener('change', upd);

    const setBase = (b) => { this._pvBase = b; this._refreshAll(); };
    body.querySelector('#rp-pv-stand').addEventListener('click', () => setBase('stand'));
    body.querySelector('#rp-pv-walk').addEventListener('click', () => setBase('walk'));
    this._dirBtn.addEventListener('click', () => {
      const i = DIRS.indexOf(this._pvDir);
      this._pvDir = DIRS[(i + 1) % DIRS.length];
      this._refreshAll();
    });

    // 底部主按钮：上骑 / 下骑（两态）
    this._mountBtn = this.addButton(this._riding ? '下骑' : '上骑', () => this._toggleRide());
    this._mountBtn.classList.toggle('on', this._riding);

    // 「乘骑态 / 站立态」：切换人物骑乘表现（override 持久化，优先于 chars.json 配置）
    const setType = (t) => {
      const petId = this._petInput.value.trim();
      if (!/^\d{6}$/.test(petId) || petId[0] !== '4') {
        try { this.ui.toast('骑宠ID 需为 4 开头的 6 位数字（骑宠模型 4xxxxx）'); } catch (e) {}
        return;
      }
      this._rpId = petId;
      setRidepetType(petId, t);
      this._rpMeta = null;          // override 变了，强制重读（getRidepetType 先查 override）
      // 已上骑 → 立即作用于主角（重播动作 + 武器显隐）
      const p = this._player();
      if (p && this._riding) {
        p.applyRideType().catch(e => console.warn('[ridepet] 切换显示类型失败', e));
      }
      this._refreshAll();
    };
    this._typeRideBtn.addEventListener('click', () => setType('ride'));
    this._typeStandBtn.addEventListener('click', () => setType('stand'));
  }

  _refreshAll() {
    this._refreshCtl();
    this._renderPreview();
    this._refreshStatus();
  }

  // ★ 模型配置（显示类型 + 站立抬升）读模型 index.html 的 ridepetMeta，需异步 loadChar。
  //   缓存到 this._rpMeta={id,type,lift}：_renderPreview 每次先 await 它，
  //   _refreshCtl/_refreshStatus 同步读缓存（未加载时按兜底 ride/0 显示，加载完会再刷一次）。
  async _loadRpMeta(petId) {
    if (this._rpMeta && this._rpMeta.id === petId) return this._rpMeta;
    const [type, lift] = await Promise.all([getRidepetType(petId), getRidepetLift(petId)]);
    this._rpMeta = { id: petId, type, lift };
    this._refreshCtl();
    this._refreshStatus();
    return this._rpMeta;
  }
  _rpMetaOk(petId) { return (this._rpMeta && this._rpMeta.id === petId) ? this._rpMeta : null; }

  _refreshCtl() {
    this._dirBtn.textContent = '方向：' + (DIR_NAME[this._pvDir] || this._pvDir);
    const standBtn = this.dom.querySelector('#rp-pv-stand');
    const walkBtn = this.dom.querySelector('#rp-pv-walk');
    if (standBtn) standBtn.classList.toggle('on', this._pvBase === 'stand');
    if (walkBtn) walkBtn.classList.toggle('on', this._pvBase === 'walk');
    // 「乘骑态/站立态」高亮当前类型（override 优先于模型 index.html 配置；未加载时暂按兜底）
    const petId = this._rpId.trim();
    const m = this._rpMetaOk(petId);
    const cur = m ? m.type : 'ride';
    if (this._typeRideBtn) this._typeRideBtn.classList.toggle('on', cur === 'ride');
    if (this._typeStandBtn) this._typeStandBtn.classList.toggle('on', cur === 'stand');
  }

  _refreshStatus() {
    const p = this._player();
    const petId = this._rpId.trim() || '—';
    const charId = this._charId.trim() || (p ? esc(String(p.charId)) + '（当前主角）' : '—');
    // ★ 显示类型（模型 index.html 的 ridepetMeta.rideType，未配置 = 乘骑型）
    const idOk = /^\d{6}$/.test(this._rpId.trim());
    const m = idOk ? this._rpMetaOk(this._rpId.trim()) : null;
    const isStand = !!(m && m.type === 'stand');
    const typeTxt = isStand
      ? `站立型（人物站骑宠上 · 抬升${Math.abs(m.lift)}px · 武器保留）`
      : '乘骑型（人物骑乘 · 武器隐藏）';
    this._statusEl.innerHTML =
      `骑宠 <b>${esc(petId)}</b> · 骑手 <b>${charId}</b> · 类型：<b>${typeTxt}</b> · 状态：<b>${this._riding ? '已上骑' : '未上骑'}</b>` +
      (this._pvNote ? `<br/><span class="rp-note">${esc(this._pvNote)}</span>` : '');
  }

  // ── 预览合成 ──
  async _renderPreview() {
    const petId = this._rpId.trim();
    const p = this._player();
    const charId = this._charId.trim() || (p ? String(p.charId) : '') || '100000';
    const base = this._pvBase;
    const dir = this._pvDir;
    const flip = (dir === 'LB' || dir === 'RT');
    const renderDir = FLIP_DIR[dir] || dir;

    // 清掉三层的旧画布（切动作/换 id 时避免残留别的方向的画布）
    this._stageEl.querySelectorAll('canvas').forEach(c => destroyCanvas(c));
    this._emptyEl.style.display = 'none';
    this._pvNote = '';

    // ★ id 合法性校验（都是 6 位数字；骑宠 4 开头）：非法直接提示，不发请求
    //   （避免输入到一半的 "40000" 之类中间态触发 404）
    if (!/^\d{6}$/.test(petId) || petId[0] !== '4') {
      this._emptyEl.textContent = '骑宠ID 需为 4 开头的 6 位数字（骑宠模型 4xxxxx）';
      this._emptyEl.style.display = '';
      this._refreshStatus();
      return;
    }
    if (!/^\d{6}$/.test(charId)) {
      this._emptyEl.textContent = '角色ID 需为 6 位数字（留空 = 当前主角）';
      this._emptyEl.style.display = '';
      this._refreshStatus();
      return;
    }

    const bgEl = this.dom.querySelector('#rp-l-bg');
    const charEl = this.dom.querySelector('#rp-l-char');
    const fgEl = this.dom.querySelector('#rp-l-fg');

    // ★ 显示类型决定人物表现（与 fighter.act 同源口径）：
    //   站立型（stand）→ 人物播普通 stand/walk（不播 ride 帧），与 AS3 setStandRideFrame 一致；
    //     且移动时人物【恒定播 stand】（骑宠播 walk，避免"骑宠上跑"穿帮——AS3 setStandRideFrame
    //     无论 curAction 是什么都给人物播 "stand"+方向）⇒ 预览里行走按钮也只让人物 stand
    //   乘骑型（ride，默认）→ playChar opts.ride 优先播 base+dir+'ride'；模型无 ride 标签则回退普通动作
    // ⚠ 类型/抬升读模型 index.html（异步），_loadRpMeta 缓存到 this._rpMeta
    const rpMeta = await this._loadRpMeta(petId);
    const isStand = rpMeta.type === 'stand';
    const charRide = !isStand;
    const charBase = isStand ? 'stand' : base;

    // 第一遍：scale=1 播一遍仅为拿各池 rect（applyUnionOverride 后的并集包围盒）做 fit
    const rBg1 = await playRideLayer(bgEl, petId, base, renderDir, 'bg', { loop: true, scale: 1 });
    const rChar1 = await playChar(charEl, charId, charBase, renderDir, { loop: true, scale: 1, ride: charRide });
    const rFg1 = await playRideLayer(fgEl, petId, base, renderDir, 'fg', { loop: true, scale: 1 });

    if (!rBg1 && !rFg1) {
      // 骑宠 id 无效 / 不是骑宠模型：清空人物画布并提示
      this._stageEl.querySelectorAll('canvas').forEach(c => destroyCanvas(c));
      this._emptyEl.style.display = '';
      this._pvNote = '';
      this._refreshStatus();
      return;
    }
    // 提示文案（按显示类型分述）
    if (isStand) {
      this._pvNote = '站立型骑宠：人物播普通 stand/walk 站在骑宠上，武器层保留';
    } else {
      const rideLabel = base + renderDir + 'ride';
      const acts = rChar1 && rChar1.rec && rChar1.rec.actions;
      const hasRide = !!(acts && acts[rideLabel] && !acts[rideLabel].empty);
      this._pvNote = hasRide ? '乘骑型：人物有乘骑动画（ride 模式），武器层隐藏' : '乘骑型：人物无乘骑动画（stand 模式：人物被骑宠前后景包裹），武器层隐藏';
    }

    // fit：三层 rect 在同一 Flash 坐标系下求并集，等比缩放进舞台，底边留 16px
    // ★ 站立型人物抬升要预先计入 box，否则抬升后人物顶边可能超出舞台
    //   抬升量来自模型 index.html 的 ridepetMeta.standLift（this._rpMeta.lift，默认 0=锚点对齐）
    const charLift = isStand ? rpMeta.lift : 0;
    const rectOf = (r) => {
      const def = r && r.rec && r.rec.swfData && r.rec.swfData.definitionPool[r.pool];
      return (def && def.rect && def.rect.width > 0 && def.rect.height > 0) ? def.rect : null;
    };
    let box = null;
    for (const r of [rBg1, rChar1, rFg1]) {
      let rr = rectOf(r);
      if (!rr) continue;
      if (r === rChar1 && isStand) rr = { x: rr.x, y: rr.y + charLift, width: rr.width, height: rr.height };
      box = box
        ? { x: Math.min(box.x, rr.x), y: Math.min(box.y, rr.y),
            width: Math.max(box.x + box.width, rr.x + rr.width) - Math.min(box.x, rr.x),
            height: Math.max(box.y + box.height, rr.y + rr.height) - Math.min(box.y, rr.y) }
        : { x: rr.x, y: rr.y, width: rr.width, height: rr.height };
    }
    if (!box) { this._emptyEl.style.display = ''; this._refreshStatus(); return; }
    const s = Math.min(STAGE_W / box.width, (STAGE_H - 16) / box.height, 1.4);
    // Flash 原点(0,0) 落在舞台的坐标（fit 后的等比映射）
    const tx = (STAGE_W - box.width * s) / 2 - box.x * s;
    const ty = (STAGE_H - 16) - (box.y + box.height) * s;

    // 第二遍：按 fit 的 scale 重播（mount 会自动清掉第一遍的画布）
    // ★ 站立型人物抬升 charLift*s（与 fighter._standLiftPx 同源，AS3 checkStandRideY 的 standToY=-30
    //   的 per-model 版），并把抬升量预先计入 fit 的 box，避免人物顶边超出舞台
    const place = (r, liftFlash = 0) => {
      const rr = rectOf(r);
      if (!r || !rr) return;
      const cv = r.canvas;
      cv.style.position = 'absolute';
      // 画布 Flash 原点在其画布像素 (-rect.x*s, -rect.y*s) 处 ⇒ 左上角落在 (tx + rect.x*s, ty + rect.y*s)
      cv.style.left = (tx + rr.x * s) + 'px';
      cv.style.top = (ty + (rr.y + liftFlash) * s) + 'px';
    };
    const rBg = await playRideLayer(bgEl, petId, base, renderDir, 'bg', { loop: true, scale: s });
    const rChar = await playChar(charEl, charId, charBase, renderDir, { loop: true, scale: s, ride: charRide });
    const rFg = await playRideLayer(fgEl, petId, base, renderDir, 'fg', { loop: true, scale: s });
    place(rBg); place(rChar, charLift); place(rFg);
    // 若第二遍某层落空（边界情况），清残留
    [bgEl, charEl, fgEl].forEach(el => {
      el.querySelectorAll('canvas').forEach(c => { if (!c.isConnected) destroyCanvas(c); });
    });

    // LB/RT：整体水平镜像，轴 = Flash 原点的 x（与 fighter._applyFlip 同轴）
    this._flipEl.style.transformOrigin = tx + 'px 0';
    this._flipEl.style.transform = flip ? 'scaleX(-1)' : 'none';
    this._refreshStatus();
  }

  // ── 上骑 / 下骑 ──
  async _toggleRide() {
    const p = this._player();
    if (!p) { try { this.ui.toast('主角尚未载入'); } catch (e) {} return; }
    // 骑宠只在主城有效：战斗中禁止上下骑
    const sc = this.ui && this.ui.sm && this.ui.sm.current;
    const inBattle = !!(sc && sc.constructor && sc.constructor.name === 'BattleScene' && !sc._ended);
    if (inBattle) { try { this.ui.toast('战斗中不能上下骑'); } catch (e) {} return; }

    if (this._riding) {
      // 下骑
      p.dismount();
      ridepetState.setRiding(false);
      this._riding = false;
    } else {
      // 上骑（直接读输入框最新值：用户敲完未失焦时 this._rpId 可能还是旧值）
      const petId = this._petInput.value.trim();
      const charId = this._charInput.value.trim();
      this._rpId = petId; this._charId = charId;
      if (!/^\d{6}$/.test(petId) || petId[0] !== '4') {
        try { this.ui.toast('骑宠ID 需为 4 开头的 6 位数字（骑宠模型 4xxxxx）'); } catch (e) {}
        return;
      }
      ridepetState.set(petId, charId);
      // 指定了骑手模型且与当前主角不同 → 切换主角模型（纸娃娃式试驾）
      if (charId && String(p.charId) !== String(charId)) {
        try { p.setCharId(charId); } catch (e) { console.warn('[ridepet] 切换骑手模型失败', e); }
      }
      const ok = await p.mountRide(petId);
      if (!ok) {
        ridepetState.setRiding(false);
        try { this.ui.toast('上骑失败：骑宠模型 ' + petId + ' 无法加载'); } catch (e) {}
        this._riding = false;
      } else {
        this._riding = true;
        ridepetState.setRiding(true);
      }
    }
    this._mountBtn.textContent = this._riding ? '下骑' : '上骑';
    this._mountBtn.classList.toggle('on', this._riding);
    this._refreshStatus();
  }
}

export function registerRidePetPanel(panelManager, ui) {
  panelManager.register('ridepet', () => new RidePetPanel(ui));
}
