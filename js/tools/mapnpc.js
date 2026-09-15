// mapnpc.js — 地图·NPC 可视化合并编辑器（参考 可视化地图遮罩编辑器.html，但对齐本单机版运行期真实消费）
//
// 运行期真实模型（严禁臆造）：
//   - 地图：maps.json 数组条目 { id, name, cols, rows, tileW, tileH, spawn{x,y}, bgm, desc, mask? }
//     底图 = resource/map/{id}/Map_{c}_{r}.jpg（c∈[0,cols), r∈[0,rows)），切片在屏幕像素 (c*tileW, r*tileH)，
//     整图尺寸 = cols*tileW × rows*tileH（对齐 scene.js _renderTiles）。
//   - 寻路掩码：长度 cols*rows 的一维数组，index = row*cols+col；0=障碍，1/2=可走（MapSystem.isWalkable 消费）。
//   - NPC：npcs.json 数组条目 { id, name, charId, portrait, type, x, y, dialog, monsterId?, count?, desc? }，
//     x/y 为世界像素坐标（对齐 _spawnNpc 的 f.setPos(n.x,n.y)）；本编辑器新增 mapId 字段把 NPC 归属到指定地图
//     （运行期 scene.js 已按 mapId 过滤生成，使「按地图放置」真正生效；无 mapId 的 NPC 视为全局、所有地图都生成）。
//
// 与参考编辑器的关键差异：参考用等距菱形(64x32+stagger)网格；本单机版是俯视矩形切片，故遮罩用矩形网格、
// 无错位偏移，网格换算与 MapSystem.getGridPos 完全一致（col=floor(x/tileW), row=floor(y/tileH)）。

import { url, Config, persistConfig } from '../core/globals.js?v=20261007c';

const NPC_TYPE_COLOR = { shop: '#37d67a', quest: '#ffd54a', teleport: '#42a5f5', monster: '#ff6b6b' };
const BRUSH_COLOR = { 0: 'rgba(244,67,54,0.45)', 1: 'rgba(76,175,80,0.05)', 2: 'rgba(33,150,243,0.45)' };

export function renderMapNpc(root, ui) {
  // ── 样式（自包含，不污染全局 css）──
  if (!root.querySelector('style.mn-style')) {
    const st = document.createElement('style');
    st.className = 'mn-style';
    st.textContent = `
      .mn-root{display:flex;flex-direction:column;height:100%;color:#e8e8e8;font-family:sans-serif;font-size:13px;background:#1c1c1c;}
      .mn-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;background:#2b2b2b;border-bottom:1px solid #444;}
      .mn-top select,.mn-top input[type=text]{background:#111;color:#fff;border:1px solid #555;border-radius:4px;padding:5px 7px;}
      .mn-top label{color:#bbb;margin-right:2px;}
      .mn-btn{padding:6px 10px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;}
      .mn-btn:hover{background:#42a5f5;} .mn-btn.ghost{background:#555;} .mn-btn.danger{background:#e53935;}
      .mn-btn.active{border:2px solid #ffeb3b;box-shadow:0 0 6px rgba(255,235,59,.5);}
      .mn-main{flex:1;display:flex;min-height:0;}
      .mn-canvas-wrap{flex:1;overflow:auto;background:#0d0d0d;border-right:1px solid #444;position:relative;}
      .mn-world{position:relative;}
      .mn-world canvas{position:absolute;top:0;left:0;pointer-events:none;}
      .mn-npclayer{position:absolute;top:0;left:0;pointer-events:none;}
      .mn-npc{position:absolute;transform:translate(-50%,-100%);pointer-events:auto;cursor:grab;
        background:rgba(0,0,0,.6);border:2px solid #fff;border-radius:6px;padding:2px 6px;white-space:nowrap;font-size:12px;}
      .mn-npc.sel{border-color:#ffeb3b;box-shadow:0 0 8px rgba(255,235,59,.7);}
      .mn-npc .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle;}
      .mn-side{width:320px;overflow-y:auto;padding:10px;background:#252525;display:flex;flex-direction:column;gap:12px;}
      .mn-sec{background:#1f1f1f;border:1px solid #444;border-radius:6px;padding:10px;}
      .mn-sec h4{margin:0 0 8px;color:#ffeb3b;font-size:13px;}
      .mn-sec .mn-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
      .mn-sec .mn-row label{width:74px;color:#bbb;flex:0 0 74px;}
      .mn-sec input,.mn-sec textarea,.mn-sec select{flex:1;background:#111;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;min-width:0;}
      .mn-sec textarea{height:54px;resize:vertical;font-family:monospace;}
      .mn-stat{font-size:12px;color:#9cd;line-height:1.6;}
      .mn-legend span{display:inline-block;width:12px;height:12px;border-radius:2px;margin:0 4px -2px 0;}
      .mn-tip{color:#888;font-size:11px;line-height:1.5;}
      .mn-modebtns{display:flex;gap:6px;}
      .mn-hide{display:none;}
    `;
    root.appendChild(st);
  }

  const wrap = document.createElement('div');
  wrap.className = 'mn-root';
  root.appendChild(wrap);

  // ── 状态 ──
  const state = {
    mapId: null,
    map: null,
    cols: 14, rows: 14, tileW: 200, tileH: 150,
    worldW: 0, worldH: 0,
    mask: [],            // 长度 cols*rows，0/1/2
    npcs: [],            // 本地图的 NPC 工作副本（均带 mapId）
    brush: 1,
    mode: 'mask',        // 'mask' | 'place' | 'select'
    selNpc: null
  };

  // ── 顶部工具栏 ──
  const top = document.createElement('div');
  top.className = 'mn-top';
  wrap.appendChild(top);

  const maps = (Config.data.maps && Array.isArray(Config.data.maps)) ? Config.data.maps : [];
  const mapOpts = maps.map(m => `<option value="${m.id}">${m.id} · ${m.name || ''}</option>`).join('')
    || '<option value="">（无地图，请先用地图属性新建）</option>';

  top.innerHTML = `
    <label>地图</label><select id="mn-map">${mapOpts}</select>
    <button class="mn-btn" id="mn-load">加载</button>
    <span style="border-left:1px solid #555;height:22px;margin:0 4px"></span>
    <div class="mn-modebtns">
      <button class="mn-btn active" data-mode="mask">🖌 遮罩</button>
      <button class="mn-btn" data-mode="place">➕ 放置NPC</button>
      <button class="mn-btn" data-mode="select">🖱 选择/移动</button>
    </div>
    <span style="border-left:1px solid #555;height:22px;margin:0 4px"></span>
    <button class="mn-btn ghost" id="mn-clearmask">清空遮罩(全可走)</button>
    <button class="mn-btn" id="mn-save">💾 保存</button>
  `;

  // ── 主区 ──
  const main = document.createElement('div');
  main.className = 'mn-main';
  wrap.appendChild(main);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'mn-canvas-wrap';
  main.appendChild(canvasWrap);

  const world = document.createElement('div');
  world.className = 'mn-world';
  canvasWrap.appendChild(world);

  const bgCanvas = document.createElement('canvas'); bgCanvas.className = 'mn-bg';
  const maskCanvas = document.createElement('canvas'); maskCanvas.className = 'mn-mask';
  const npcLayer = document.createElement('div'); npcLayer.className = 'mn-npclayer';
  world.appendChild(bgCanvas); world.appendChild(maskCanvas); world.appendChild(npcLayer);

  const side = document.createElement('div');
  side.className = 'mn-side';
  main.appendChild(side);

  // ── 加载地图 ──
  function loadMap(id) {
    const m = (Config.data.maps || []).find(x => String(x.id) === String(id));
    if (!m) { state.mapId = null; state.map = null; canvasWrap.innerHTML = '<div style="padding:20px;color:#aaa">未找到地图，请在右侧「地图属性」新建。</div>'; side.innerHTML = ''; return; }
    state.mapId = String(m.id);
    state.map = JSON.parse(JSON.stringify(m));
    state.cols = m.cols || 14; state.rows = m.rows || 14;
    state.tileW = m.tileW || 200; state.tileH = m.tileH || 150;
    state.worldW = state.cols * state.tileW; state.worldH = state.rows * state.tileH;
    const total = state.cols * state.rows;
    state.mask = (m.mask && m.mask.length === total) ? m.mask.slice() : new Array(total).fill(1);
    // 本地图 NPC 工作副本（仅取 mapId 匹配者；无 mapId 的全局 NPC 不在此编辑器内编辑，但保留不被覆盖）
    state.npcs = (Config.data.npcs || []).filter(n => String(n.mapId) === state.mapId).map(n => JSON.parse(JSON.stringify(n)));
    state.selNpc = null;

    world.style.width = state.worldW + 'px';
    world.style.height = state.worldH + 'px';
    bgCanvas.width = state.worldW; bgCanvas.height = state.worldH;
    maskCanvas.width = state.worldW; maskCanvas.height = state.worldH;

    stitchBg();
    drawMask();
    renderNpcs();
    renderSide();
  }

  // 拼接底图切片（对齐 scene.js _renderTiles 的像素位置）
  function stitchBg() {
    const ctx = bgCanvas.getContext('2d');
    ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const img = new Image();
        const px = c * state.tileW, py = r * state.tileH;
        img.onload = () => { try { ctx.drawImage(img, px, py, state.tileW, state.tileH); } catch (e) {} };
        img.onerror = () => {};
        img.src = url.mapTile(state.mapId, c, r);
      }
    }
  }

  // 绘制遮罩网格（矩形、无错位，与 MapSystem 同坐标系）
  function drawMask() {
    const ctx = maskCanvas.getContext('2d');
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const v = state.mask[r * state.cols + c];
        if (v === 1) continue; // 可走：极淡，避免遮挡底图
        ctx.fillStyle = BRUSH_COLOR[v] || 'rgba(255,255,255,0.1)';
        ctx.fillRect(c * state.tileW, r * state.tileH, state.tileW, state.tileH);
      }
    }
    // 网格线
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= state.cols; c++) { ctx.beginPath(); ctx.moveTo(c * state.tileW, 0); ctx.lineTo(c * state.tileW, state.worldH); ctx.stroke(); }
    for (let r = 0; r <= state.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * state.tileH); ctx.lineTo(state.worldW, r * state.tileH); ctx.stroke(); }
  }

  // 渲染 NPC 标记
  function renderNpcs() {
    npcLayer.innerHTML = '';
    npcLayer.style.width = state.worldW + 'px';
    npcLayer.style.height = state.worldH + 'px';
    state.npcs.forEach(n => {
      const d = document.createElement('div');
      d.className = 'mn-npc' + (state.selNpc === n ? ' sel' : '');
      d.style.left = (n.x || 0) + 'px';
      d.style.top = (n.y || 0) + 'px';
      d.innerHTML = `<span class="dot" style="background:${NPC_TYPE_COLOR[n.type] || '#fff'}"></span>${n.name || n.id || 'NPC'}`;
      n._el = d;
      d.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (state.mode === 'select') { selectNpc(n); }
        startDragNpc(e, n, d);
      });
      d.addEventListener('click', (e) => { e.stopPropagation(); if (state.mode === 'select') selectNpc(n); });
      npcLayer.appendChild(d);
    });
  }

  function startDragNpc(e, n, d) {
    let moved = false;
    const rect0 = world.getBoundingClientRect();
    const move = (ev) => {
      moved = true;
      const x = ev.clientX - rect0.left, y = ev.clientY - rect0.top;
      n.x = Math.round(Math.max(0, Math.min(state.worldW, x)));
      n.y = Math.round(Math.max(0, Math.min(state.worldH, y)));
      d.style.left = n.x + 'px'; d.style.top = n.y + 'px';
      if (state.selNpc === n) syncNpcForm();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ── 鼠标交互：遮罩绘制 / 放置 NPC / 选择 ──
  let painting = false;
  function worldPos(ev) {
    const rect = world.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function paintAt(ev) {
    const p = worldPos(ev);
    const col = Math.floor(p.x / state.tileW), row = Math.floor(p.y / state.tileH);
    if (col < 0 || col >= state.cols || row < 0 || row >= state.rows) return;
    const idx = row * state.cols + col;
    if (state.mask[idx] !== state.brush) { state.mask[idx] = state.brush; drawMask(); }
  }
  world.addEventListener('mousedown', (e) => {
    const p = worldPos(e);
    if (state.mode === 'mask') { painting = true; paintAt(e); }
    else if (state.mode === 'place') {
      const npc = { id: 'npc_' + state.mapId + '_' + (state.npcs.length + 1), name: '新NPC', type: 'shop', charId: 0, x: Math.round(p.x), y: Math.round(p.y), mapId: state.mapId, desc: '' };
      state.npcs.push(npc); renderNpcs(); selectNpc(npc);
      setMode('select');
    } else {
      // select：点空白取消选择
      const hit = state.npcs.find(n => Math.abs((n.x || 0) - p.x) < 18 && Math.abs((n.y || 0) - p.y) < 18);
      if (!hit) selectNpc(null);
    }
  });
  world.addEventListener('mousemove', (e) => { if (painting && state.mode === 'mask') paintAt(e); });
  window.addEventListener('mouseup', () => { painting = false; });

  // ── 右侧栏 ──
  function renderSide() {
    if (!state.map) {
      side.innerHTML = `<div class="mn-sec"><h4>地图属性</h4>
        <div class="mn-row"><label>地图ID</label><input id="f-mid" type="text" placeholder="如 180"/></div>
        <div class="mn-row"><label>名称</label><input id="f-mname" type="text" placeholder="新月村"/></div>
        <div class="mn-row"><label>列数</label><input id="f-cols" type="number" value="14"/></div>
        <div class="mn-row"><label>行数</label><input id="f-rows" type="number" value="14"/></div>
        <div class="mn-row"><label>瓦片宽</label><input id="f-tw" type="number" value="200"/></div>
        <div class="mn-row"><label>瓦片高</label><input id="f-th" type="number" value="150"/></div>
        <button class="mn-btn" id="mn-newmap">＋ 新建地图</button></div>`;
      side.querySelector('#mn-newmap').onclick = () => {
        const id = side.querySelector('#f-mid').value.trim();
        if (!id) { ui && ui.toast('请填地图ID'); return; }
        const nm = { id: Number(id) || id, name: side.querySelector('#f-mname').value.trim() || ('地图' + id),
          cols: +side.querySelector('#f-cols').value || 14, rows: +side.querySelector('#f-rows').value || 14,
          tileW: +side.querySelector('#f-tw').value || 200, tileH: +side.querySelector('#f-th').value || 150,
          spawn: { x: 0, y: 0 }, npcs: [] };
        Config.data.maps = Config.data.maps || [];
        Config.data.maps.push(nm); persistConfig('maps', Config.data.maps);
        // 刷新下拉
        const sel = top.querySelector('#mn-map'); sel.innerHTML = (Config.data.maps || []).map(m => `<option value="${m.id}">${m.id} · ${m.name || ''}</option>`).join('');
        sel.value = id; loadMap(id); ui && ui.toast('已新建地图 ' + id);
      };
      return;
    }
    const stat = { 0: 0, 1: 0, 2: 0 };
    state.mask.forEach(v => { stat[v] = (stat[v] || 0) + 1; });
    const sp = state.map.spawn || { x: 0, y: 0 };
    let html = `<div class="mn-sec"><h4>地图属性</h4>
      <div class="mn-row"><label>名称</label><input id="f-mname" type="text" value="${esc(state.map.name || '')}"/></div>
      <div class="mn-row"><label>列数</label><input id="f-cols" type="number" value="${state.cols}"/></div>
      <div class="mn-row"><label>行数</label><input id="f-rows" type="number" value="${state.rows}"/></div>
      <div class="mn-row"><label>瓦片宽</label><input id="f-tw" type="number" value="${state.tileW}"/></div>
      <div class="mn-row"><label>瓦片高</label><input id="f-th" type="number" value="${state.tileH}"/></div>
      <div class="mn-row"><label>出生X</label><input id="f-sx" type="number" value="${sp.x}"/></div>
      <div class="mn-row"><label>出生Y</label><input id="f-sy" type="number" value="${sp.y}"/></div>
      <div class="mn-row"><label>BGM</label><input id="f-bgm" type="text" value="${esc(state.map.bgm || '')}"/></div>
      <div class="mn-row"><label>描述</label><textarea id="f-desc">${esc(state.map.desc || '')}</textarea></div>
      <div class="mn-tip">改列数/行数会按重叠保留旧掩码，其余补为可走(1)。</div>
    </div>`;
    html += `<div class="mn-sec"><h4>遮罩统计</h4>
      <div class="mn-stat">障碍(0)：<b style="color:#ff6b6b">${stat[0] || 0}</b>　可走(1)：<b style="color:#37d67a">${stat[1] || 0}</b>　遮挡(2)：<b style="color:#42a5f5">${stat[2] || 0}</b></div>
      <div class="mn-legend" style="margin-top:6px">
        <span style="background:rgba(244,67,54,.6)"></span>障碍
        <span style="background:rgba(76,175,80,.4)"></span>可走
        <span style="background:rgba(33,150,243,.6)"></span>遮挡
      </div>
      <div class="mn-tip" style="margin-top:6px">当前笔刷：${state.brush}（${state.brush === 0 ? '障碍' : state.brush === 2 ? '遮挡' : '可走'}）。遮罩模式在画布上按住拖动涂抹。</div>
    </div>`;
    html += `<div class="mn-sec"><h4>本图 NPC（${state.npcs.length}）</h4><div id="mn-npclist">${
      state.npcs.length ? state.npcs.map(n => `<div class="mn-row" style="cursor:pointer" data-nid="${esc(n.id)}"><span class="dot" style="background:${NPC_TYPE_COLOR[n.type] || '#fff'};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>${esc(n.name || n.id)}</div>`).join('') : '<div class="mn-tip">暂无，切到「放置NPC」在画布上点击添加。</div>'
    }</div></div>`;
    side.innerHTML = html;
    side.querySelectorAll('#mn-npclist [data-nid]').forEach(el => el.onclick = () => {
      const n = state.npcs.find(x => x.id === el.dataset.nid); if (n) selectNpc(n);
    });
    // 地图属性即时写回 state.map
    const bind = (sel, key, isNum) => { const el = side.querySelector(sel); if (el) el.oninput = () => { state.map[key] = isNum ? (+el.value || 0) : el.value; if (key === 'cols' || key === 'rows') rebuildGrid(); if (key === 'tileW' || key === 'tileH') { state.tileW = state.map.tileW; state.tileH = state.map.tileH; world.style.width = state.worldW + 'px'; world.style.height = state.worldH + 'px'; stitchBg(); drawMask(); } }; };
    bind('#f-mname', 'name', false); bind('#f-cols', 'cols', true); bind('#f-rows', 'rows', true);
    bind('#f-tw', 'tileW', true); bind('#f-th', 'tileH', true); bind('#f-bgm', 'bgm', false); bind('#f-desc', 'desc', false);
    const sx = side.querySelector('#f-sx'), sy = side.querySelector('#f-sy');
    if (sx) sx.oninput = () => { state.map.spawn = state.map.spawn || {}; state.map.spawn.x = +sx.value || 0; };
    if (sy) sy.oninput = () => { state.map.spawn = state.map.spawn || {}; state.map.spawn.y = +sy.value || 0; };

    if (state.selNpc) renderNpcForm();
  }

  function rebuildGrid() {
    const oldCols = state.cols, oldRows = state.rows;   // 改动前的网格尺寸（state.cols/rows 尚未被新值覆盖）
    state.cols = state.map.cols || 14; state.rows = state.map.rows || 14;
    state.worldW = state.cols * state.tileW; state.worldH = state.rows * state.tileH;
    const total = state.cols * state.rows;
    const old = state.mask;
    const next = new Array(total).fill(1);
    for (let i = 0; i < total; i++) {
      const nc = i % state.cols, nr = Math.floor(i / state.cols);
      // 仅当新坐标落在旧网格范围内时复用旧掩码，避免错位映射（旧写法 old.length/(rows) 在改行数时会算错旧列数）
      const oi = nr * oldCols + nc;
      if (nc < oldCols && nr < oldRows && old[oi] != null) next[i] = old[oi];
    }
    state.mask = next;
    world.style.width = state.worldW + 'px'; world.style.height = state.worldH + 'px';
    bgCanvas.width = state.worldW; maskCanvas.width = state.worldW;
    bgCanvas.height = state.worldH; maskCanvas.height = state.worldH;
    stitchBg(); drawMask(); renderSide();
  }

  function selectNpc(n) {
    state.selNpc = n;
    renderNpcs();
    renderSide();
  }

  function renderNpcForm() {
    const n = state.selNpc; if (!n) return;
    const sec = document.createElement('div');
    sec.className = 'mn-sec';
    sec.innerHTML = `<h4>编辑 NPC：${esc(n.name || n.id)}</h4>
      <div class="mn-row"><label>ID</label><input id="f-id" type="text" value="${esc(n.id)}"/></div>
      <div class="mn-row"><label>名称</label><input id="f-name" type="text" value="${esc(n.name || '')}"/></div>
      <div class="mn-row"><label>类型</label><select id="f-type">${['shop', 'quest', 'teleport', 'monster'].map(t => `<option value="${t}" ${n.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="mn-row"><label>模型ID</label><input id="f-char" type="number" value="${n.charId || 0}"/></div>
      <div class="mn-row"><label>头像</label><input id="f-port" type="text" value="${esc(n.portrait || '')}"/></div>
      <div class="mn-row"><label>坐标X</label><input id="f-x" type="number" value="${n.x || 0}"/></div>
      <div class="mn-row"><label>坐标Y</label><input id="f-y" type="number" value="${n.y || 0}"/></div>
      <div class="mn-row" id="f-monster-row" style="${n.type === 'monster' ? '' : 'display:none'}"><label>怪物ID</label><input id="f-mon" type="text" value="${esc(n.monsterId || '')}"/></div>
      <div class="mn-row" id="f-count-row" style="${n.type === 'monster' ? '' : 'display:none'}"><label>数量</label><input id="f-cnt" type="number" value="${n.count || 1}"/></div>
      <div class="mn-row"><label>对话</label><textarea id="f-dlg">${esc(n.dialog || '')}</textarea></div>
      <div class="mn-row"><label>描述</label><textarea id="f-ndesc">${esc(n.desc || '')}</textarea></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="mn-btn danger" id="f-del">删除</button>
        <button class="mn-btn ghost" id="f-spawn">居中出生点</button>
      </div>`;
    side.appendChild(sec);
    const upd = (sel, key) => { const el = sec.querySelector(sel); if (el) el.oninput = () => { n[key] = (el.type === 'number') ? (+el.value || 0) : el.value; if (key === 'name' || key === 'type') renderNpcs(); if (key === 'x' || key === 'y') { if (n._el) { n._el.style.left = (n.x || 0) + 'px'; n._el.style.top = (n.y || 0) + 'px'; } } if (key === 'type') { sec.querySelector('#f-monster-row').style.display = n.type === 'monster' ? '' : 'none'; sec.querySelector('#f-count-row').style.display = n.type === 'monster' ? '' : 'none'; } }; };
    upd('#f-id', 'id'); upd('#f-name', 'name'); upd('#f-type', 'type'); upd('#f-char', 'charId'); upd('#f-port', 'portrait');
    upd('#f-x', 'x'); upd('#f-y', 'y'); upd('#f-mon', 'monsterId'); upd('#f-cnt', 'count'); upd('#f-dlg', 'dialog'); upd('#f-ndesc', 'desc');
    sec.querySelector('#f-del').onclick = () => {
      state.npcs = state.npcs.filter(x => x !== n);
      state.selNpc = null; renderNpcs(); renderSide(); ui && ui.toast('已删除 ' + (n.name || n.id));
    };
    sec.querySelector('#f-spawn').onclick = () => {
      const sp = state.map.spawn || { x: 0, y: 0 }; n.x = sp.x; n.y = sp.y;
      if (n._el) { n._el.style.left = n.x + 'px'; n._el.style.top = n.y + 'px'; }
      sec.querySelector('#f-x').value = n.x; sec.querySelector('#f-y').value = n.y;
    };
  }

  function syncNpcForm() {
    const n = state.selNpc; if (!n) return;
    const x = side.querySelector('#f-x'), y = side.querySelector('#f-y');
    if (x) x.value = n.x; if (y) y.value = n.y;
  }

  // ── 保存 ──
  top.querySelector('#mn-save').onclick = () => {
    if (!state.map) { ui && ui.toast('请先加载/新建地图'); return; }
    // 写回地图（含 mask 与属性）
    const arr = Config.data.maps || [];
    const i = arr.findIndex(m => String(m.id) === state.mapId);
    if (i >= 0) { arr[i] = JSON.parse(JSON.stringify(state.map)); arr[i].mask = state.mask.slice(); }
    persistConfig('maps', arr);
    // 写回 NPC：保留其它地图/全局 NPC，合并本图 NPC
    const all = Config.data.npcs || [];
    const others = all.filter(n => String(n.mapId) !== state.mapId);
    persistConfig('npcs', others.concat(state.npcs.map(n => JSON.parse(JSON.stringify(n)))));
    ui && ui.toast('已保存地图[' + state.mapId + ']与 ' + state.npcs.length + ' 个NPC');
  };
  top.querySelector('#mn-clearmask').onclick = () => {
    if (state.mask.length) { state.mask.fill(1); drawMask(); renderSide(); }
  };
  top.querySelector('#mn-load').onclick = () => { const v = top.querySelector('#mn-map').value; if (v) loadMap(v); };
  top.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));

  function setMode(m) {
    state.mode = m;
    top.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  }

  // ── 工具函数 ──
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function cssEsc(s) { return String(s).replace(/"/g, '\\"'); }

  // 初始
  if (maps.length) loadMap(maps[0].id);
  else renderSide();
}
