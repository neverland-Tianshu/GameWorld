// ui/minimap-panel.js
// 小地图面板，逐像素对齐 deobfuscated/panel/map/SmallMapPanel.as：
//   - 背景改用 AS3 fillBackground(bgW,bgH,...,"small") 的 common_small_* 薄金框
//     （7x7 角 / 5px 边 / common_background 中填），bgW = 地图宽+12，bgH = 地图高+56
//     （SmallMapPanel layout {w:12,h:56}）；地图贴 (6,6)（SmallMapPanel_map）
//   - 坐标条 panel_map_xy（86x20）@ (0,-20) 伸出面板顶边，X/Y 白字 12px @ (16,-19)/(55,-19)
//     （SmallMapPanel_xy / _x / _y + getTextFieldXY(#ffffff,12)）
//   - 四类图层勾选框（商人/任务/资源/传送点）@ 地图下方 2x2：(12,mapH+10)/(72,mapH+10)/
//     (12,mapH+28)/(72,mapH+28)（businessCB/missionCB/sourceCB/pointCB）
//   - 世界地图按钮 @ (bgW-32,-10)（panel_map_world，文字图→CSS 文字按钮）→ 点击关闭小地图并打开世界地图面板
//   - 飞行按钮 @ (bgW-95,bgH-40)（panel_btn_bg4→CSS .tsqt-btn-orange）
//   - 点击地图→scene.pathfindToWorld（AS3 mapSpriteMouseHandler DOWN→findingAtSmallMap）；
//     悬停→RP 坐标（updateRoadPointXY + transformXYToRP）；
//     玩家球（map_ball）/寻路旗（map_flag）/红色 2px 折线（paintPath lineStyle(2,0xFF0000)）

import { BasePanel } from './panel-manager.js?v=20261007c';
import { Config, url, loadSmallmap } from '../core/globals.js?v=20261007c';
import { MapSystem } from '../core/map.js?v=20261007c';
import { playSfx } from '../core/sound.js?v=20261007c';

// AS3 layout.xml 常量（panels_repro/map__SmallMapPanel.html 逐项核对）
// ★ 这些是**默认值**；面板编辑器（minimap-editor/）把覆盖写入
//   localStorage['tsqt.paneledit.minimap']，本面板 init/onOpen 时读取合并。
//   锚点口径（元素贴哪条边，地图尺寸变化时跟着动）：
//     xy/txtX/txtY/map → 左上角绝对坐标（x,y）
//     world            → 右上角：(bgW+dx, dy)  —— 骑跨面板右上、突出顶边
//     fly              → 右下角：(bgW+dx, bgH+dy)
//     cb[4]            → 左下角：(x, mapH+dy)  —— dy 相对地图底边
const MM_LAYOUT_KEY = 'tsqt.paneledit.minimap';
export const DEFAULT_LAYOUT = {
  pad:   { w: 12, h: 56 },           // SmallMapPanel {w:12,h:56}：bg = 地图 + 内边距
  map:   { x: 6, y: 6 },             // SmallMapPanel_map
  xy:    { x: 0, y: -20 },           // SmallMapPanel_xy（panelmapxy.png 86x20，伸出面板顶边）
  txtX:  { x: 18, y: -17 },          // SmallMapPanel_x（白 12px）
  txtY:  { x: 58, y: -17 },          // SmallMapPanel_y
  world: { dx: -63, dy: -20 },       // SmallMapPanel_bigMapBtn：x=bgW+dx, y=dy（骑跨右上角）
  fly:   { dx: -95, dy: -40 },       // SmallMapPanel_flyBtn：x=bgW-95, y=bgH-40
  cb: [                               // 勾选框（businessCB/missionCB/sourceCB/pointCB）：dy 相对地图底边
    { key: 'shop',     label: '商人',   x: 12, dy: 7 },
    { key: 'quest',    label: '任务',   x: 72, dy: 7 },
    { key: 'monster',  label: '怪物',   x: 12, dy: 25 },
    { key: 'teleport', label: '传送点', x: 72, dy: 25 },
  ],
};

// 读 localStorage 覆盖并与默认值合并（任何非法值都安全回落默认）
export function loadMiniMapLayout() {
  try {
    const raw = localStorage.getItem(MM_LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const ov = JSON.parse(raw);
    if (!ov || typeof ov !== 'object') return DEFAULT_LAYOUT;
    const L = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    for (const k of ['pad', 'map', 'xy', 'txtX', 'txtY', 'world', 'fly']) {
      if (ov[k] && typeof ov[k] === 'object') Object.assign(L[k], ov[k]);
    }
    if (Array.isArray(ov.cb) && ov.cb.length === 4) {
      // key 由默认值决定（编辑器只允许改 label/x/dy，不允许改 key），避免旧存档把 key 退化回已废弃的 source；
      // 废弃的 source 槽位若 label 仍是旧默认名「资源」也一并改成新默认名（几何位置保留，自定义名不动）
      L.cb = ov.cb.map((c, i) => {
        const d = DEFAULT_LAYOUT.cb[i];
        const o = { ...d, ...(c || {}), key: d.key };
        if (c && c.key === 'source' && c.label === '资源') o.label = d.label;
        return o;
      });
    }
    return L;
  } catch (_) { return DEFAULT_LAYOUT; }
}

// 对齐 AS3 updateMap：底图超 400x300 等比压入框内，更小保持原尺寸（绝不放大）
const MAX_MAP_W = 400, MAX_MAP_H = 300;
// 用户要求：短边最小 200px（仅极小图触发）
const MIN_SHORT = 200;
// 窗口可用空间安全边距（小屏不溢出）
const RESERVE_W = 120, RESERVE_H = 210;

// 悬停命中半径（屏幕 px）：标记图标约 11px，给手指/鼠标一点容差
const HIT_R = 12;

export class MiniMapPanel extends BasePanel {
  constructor(ui) {
    super({
      id: 'panel-minimap', title: '小地图', width: 412, height: 356, ui,
      // AS3 fillBackground(...,"small")：common_small_* 薄金框（LoginResource/icons）
      bgSkin: {
        background: 'common_background',
        header: 'common_small_corner1',
        footer: 'common_small_corner2',
        headerBorder: 'common_small_sideline3',
        footerBorder: 'common_small_sideline2',
        borderL: 'common_small_sideline1',
        borderR: 'common_small_sideline1',
      },
    });
  }

  init() {
    // 世界像素尺寸 = 格子拼合尺寸（与 HUD 角标小地图、scene.worldW/H 同源）。
    //   不能用 map_info.totalWidth/Height(2800x2100 贴图名义尺寸)，否则寻路层错位。
    const sc0 = this._scene();
    const wm0 = (sc0 && sc0.map) || null;
    this._worldW = (wm0 && wm0.stitchedW) || 2800;
    this._worldH = (wm0 && wm0.stitchedH) || 2100;
    this._dispW = 400; this._dispH = 300;
    this._sx = this._dispW / this._worldW;
    this._sy = this._dispH / this._worldH;
    this._raf = 0;
    this._onResize = null;

    this.L = loadMiniMapLayout();      // 布局覆盖（面板编辑器写入）
    this._buildChrome();
  }

  // 构建 stage 内容（init 与 onOpen 检测到布局变化时调用）
  // ★ 不能叫 _build —— 那是 BasePanel 创建面板根 DOM 的方法，同名覆盖会导致
  //   构造器里 this.dom 还没创建就跑到这里（this.dom.insertAdjacentHTML 崩）
  _buildChrome() {
    const L = this.L;
    // 内容直接挂在面板根上（AS3 局部坐标，含伸出面板的坐标条），不用 pb-body。
    // ★ 所有"伸出/超出地图"的元素（坐标条、世界地图按钮、飞行按钮、勾选框）
    //   必须挂在 .mm-stage 下、不能进 .mm-mapwrap —— wrap 是 overflow:hidden 且
    //   尺寸只有地图大，进去的元素会被裁掉（曾因模板里 mm-mapwrap 块重复，
    //   勾选框/世界地图按钮全嵌进 wrap 而消失/错位）。
    this.dom.insertAdjacentHTML('beforeend', `
      <div class="mm-stage">
        <img class="mm-xy" alt="" draggable="false" />
        <div class="mm-tx mm-x"></div>
        <div class="mm-tx mm-y"></div>
        <div class="mm-mapwrap">
          <img class="mm-map" alt="小地图" draggable="false" />
          <canvas class="mm-cv"></canvas>
        </div>
        <div class="mm-tip" hidden></div>
        ${L.cb.map(c => `<label class="mm-cb" data-layer="${c.key}"><i></i>${c.label}</label>`).join('')}
        <button class="mm-btn mm-world" type="button">世界地图</button>
        <button class="mm-btn mm-fly tsqt-bar-btn tsqt-btn-orange" type="button">飞行</button>
      </div>`);

    this.stage    = this.dom.querySelector('.mm-stage');
    this.xyImg    = this.dom.querySelector('.mm-xy');
    this.xTx      = this.dom.querySelector('.mm-x');
    this.yTx      = this.dom.querySelector('.mm-y');
    this.wrap     = this.dom.querySelector('.mm-mapwrap');
    this.img      = this.dom.querySelector('.mm-map');
    this.cv       = this.dom.querySelector('.mm-cv');
    this.ctx      = this.cv.getContext('2d');
    this.tip      = this.dom.querySelector('.mm-tip');
    this.cbEls    = [...this.dom.querySelectorAll('.mm-cb')];
    this.worldBtn = this.dom.querySelector('.mm-world');
    this.flyBtn   = this.dom.querySelector('.mm-fly');

    this.xyImg.src = url.res('panelmapxy.png');

    // 当前地图 id：优先 scene.map.id，兜底 maps[0]；底图用 resId 拼 Smallmap_<resId>.png
    const scene = this._scene();
    const map = (scene && scene.map) || (Config.maps && Config.maps[0]) || null;
    const mapId = (map && map.id) || 1;
    const resId = (map && map.resId != null) ? map.resId : mapId;
    this._mapId = String(mapId);
    this._resId = String(resId);
    this._imgFailed = false;
    loadSmallmap(this.img, this._resId, {
      onLoad: () => { this._imgFailed = false; if (this.img) this.img.style.visibility = ''; this._fitAll(); },
      onFail: () => { this._imgFailed = true;  if (this.img) this.img.style.visibility = 'hidden'; this._fitAll(); }
    });

    this._setupLayers();
    this._setupEvents();
    this._rafLoop = this._rafLoop.bind(this);
    this.img.addEventListener('load', () => this._fitAll(), { once: true });
    this.img.addEventListener('error', () => this._fitAll(), { once: true });
  }

  // 重建 stage（布局覆盖变化时）
  _rebuild() {
    if (this.stage) this.stage.remove();
    this._setHoverMark && this._setHoverMark(null);
    this._hovering = false; this._hoverMark = null; this._marks = [];
    this._buildChrome();
    this._fitAll();
  }

  _scene() { return this.ui && this.ui.sm && this.ui.sm.current; }

  // ── 图层勾选框（状态与 HUD 角标共用 ui._miniLayersVisible）──
  _setupLayers() {
    if (!this.ui._miniLayersVisible) {
      this.ui._miniLayersVisible = { shop: true, quest: true, monster: true, teleport: true };
    }
    this.cbEls.forEach(el => {
      const k = el.dataset.layer;
      el.classList.toggle('on', !!this.ui._miniLayersVisible[k]);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.ui._miniLayersVisible[k] = !this.ui._miniLayersVisible[k];
        el.classList.toggle('on', this.ui._miniLayersVisible[k]);
        playSfx('click');
      });
    });
  }

  _setupEvents() {
    // 悬停标记 → 坐标条/高亮/浮动提示（AS3 MapSprite.overHandler）；
    // 点击标记 → 寻路到 NPC 精确坐标（AS3 MapSprite.clickHandler → moveToNpcByPoint）。
    // 本地坐标 → 世界像素（与 _drawOverlay 的 sx/sy 反算一致）
    const toWorld = (e) => {
      const rect = this.wrap.getBoundingClientRect();
      return {
        mx: e.clientX - rect.left,
        my: e.clientY - rect.top,
        wx: (e.clientX - rect.left) / this._dispW * this._worldW,
        wy: (e.clientY - rect.top) / this._dispH * this._worldH,
      };
    };

    this._hovering = false;
    this._hoverMark = null;     // {x,y,n} 当前悬停的标记（屏幕坐标 + npcData）
    this._marks = [];           // 本帧绘制的可见标记 {x,y,n}

    this.wrap.addEventListener('click', (e) => {
      const p = toWorld(e);
      const m = this._hitMark(p.mx, p.my);
      const sc = this._scene();
      if (!sc || typeof sc.pathfindToWorld !== 'function') return;
      if (m) {
        // AS3 clickHandler：点到标记 → 走到 NPC 身边（用 NPC 精确世界坐标，非点击像素）
        sc.pathfindToWorld(m.n.x, m.n.y);
      } else {
        sc.pathfindToWorld(p.wx, p.wy);
      }
    });
    this.wrap.addEventListener('mousemove', (e) => {
      this._hovering = true;
      const p = toWorld(e);
      const m = this._hitMark(p.mx, p.my);
      this._setHoverMark(m);
      if (m) {
        // AS3 overHandler：坐标条锁定到标记的 RP 坐标（isMove=true，rAF 不再覆盖）
        const rp = MapSystem.getGridPos(m.n.x, m.n.y);
        this._setXY(rp.col, rp.row);
      } else {
        const rp = MapSystem.getGridPos(p.wx, p.wy);   // RP 模式下即 transformXYToRP
        this._setXY(rp.col, rp.row);
      }
    });
    this.wrap.addEventListener('mouseleave', () => {
      this._hovering = false;
      this._setHoverMark(null);
      this._updateCoordFromPlayer();   // 离开后回落为玩家当前坐标
    });
    // 世界地图：对齐 AS3 SmallMapPanel.buttonHandler 的 BUTTON_BIG_MAP
    //   （deobfuscated/panel/map/SmallMapPanel.as:134-136：this.close(); panelManager.bigMapPanel.open();）
    //   —— 关闭小地图，打开世界地图面板（WorldMapPanel，可切图传送）。
    this.worldBtn.addEventListener('click', () => {
      playSfx('click');
      this.close();
      if (this.ui && this.ui.openPanel) this.ui.openPanel('worldmap');
    });
    this.flyBtn.addEventListener('click', () => {
      playSfx('click');
      if (this.ui && this.ui.toast) this.ui.toast('飞行尚未实装');
    });
  }

  // 在本帧已绘制的标记里找命中（最近一个，半径 HIT_R 内）
  _hitMark(mx, my) {
    let best = null, bestD = HIT_R * HIT_R;
    for (const m of this._marks) {
      const dx = m.x - mx, dy = m.y - my;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // 切换悬停标记：高亮重绘 + 浮动名字提示（AS3 overHandler/outHandler）
  // 帧间标记对象是新建的，按 id+坐标 判等，避免每帧重定位提示
  _setHoverMark(m) {
    const cur = this._hoverMark;
    const same = !!cur && !!m && cur.n.id === m.n.id && cur.x === m.x && cur.y === m.y;
    if (same) return;
    this._hoverMark = m;
    if (!this.tip) return;
    if (!m) {
      this.tip.hidden = true;
      if (this.wrap) this.wrap.style.cursor = 'crosshair';
      return;
    }
    // AS3 promptFace.showInfoPrompt(globalX+width, globalY-ballHeight, "<font size='12'>describe</font>")
    // 提示挂在面板 stage 上（wrap 有 overflow:hidden 会裁掉边缘提示），坐标 = 面板内坐标
    this.tip.textContent = m.n.name || '';
    this.tip.hidden = false;
    const tipW = this.tip.offsetWidth || 60;
    const px = this.L.map.x + m.x + 10;                 // 标记右侧
    const py = this.L.map.y + m.y - 26;                 // 标记上方
    const maxL = Math.max(4, (this.dom.offsetWidth || 300) - tipW - 4);
    this.tip.style.left = Math.min(Math.max(4, px), maxL) + 'px';
    this.tip.style.top = Math.max(2, py) + 'px';
    if (this.wrap) this.wrap.style.cursor = 'pointer';
  }

  _setXY(x, y) {
    if (this.xTx) this.xTx.textContent = String(x);
    if (this.yTx) this.yTx.textContent = String(y);
  }

  // ── 自适应 + AS3 布局定位 ──
  _fitAll() {
    if (!this.dom || this.dom.style.display === 'none') return;   // 隐藏中测量为 0，onOpen 会再调
    const L = this.L;
    const nw = this.img.naturalWidth || 400;
    const nh = this.img.naturalHeight || 300;
    const shortSide = Math.min(nw, nh) || 300;
    let scale = Math.min(1, MAX_MAP_W / nw, MAX_MAP_H / nh);
    const availW = Math.max(280, window.innerWidth - RESERVE_W);
    const availH = Math.max(200, window.innerHeight - RESERVE_H);
    scale = Math.min(scale, availW / nw, availH / nh);
    scale = Math.max(scale, MIN_SHORT / shortSide);
    const W = Math.max(1, Math.round(nw * scale));
    const H = Math.max(1, Math.round(nh * scale));
    this._dispW = W; this._dispH = H;
    this._sx = W / this._worldW; this._sy = H / this._worldH;

    // AS3 bg 尺寸 = 地图 + pad（默认 12x56）
    const bgW = W + L.pad.w, bgH = H + L.pad.h;
    this.dom.style.width = bgW + 'px';
    this.dom.style.height = bgH + 'px';

    // 地图 @ (6,6)
    this.wrap.style.left = L.map.x + 'px';
    this.wrap.style.top = L.map.y + 'px';
    this.wrap.style.width = W + 'px';
    this.wrap.style.height = H + 'px';
    this.img.style.width = W + 'px'; this.img.style.height = H + 'px';
    this.cv.width = W; this.cv.height = H;

    // 坐标条 @ (0,-20) 伸出面板；X/Y 白字 @ (16,-19)/(55,-19)
    this.xyImg.style.left = L.xy.x + 'px'; this.xyImg.style.top = L.xy.y + 'px';
    this.xTx.style.left = L.txtX.x + 'px'; this.xTx.style.top = L.txtX.y + 'px';
    this.yTx.style.left = L.txtY.x + 'px'; this.yTx.style.top = L.txtY.y + 'px';

    // 勾选框 @ 地图下方 2x2（锚左下：x 绝对，y = 地图底边 + dy）
    this.cbEls.forEach((el, i) => {
      const c = L.cb[i];
      el.style.left = c.x + 'px';
      el.style.top = (H + L.map.y + c.dy) + 'px';
    });

    // 世界地图 @ (bgW-32,-10) 骑跨右上角；飞行 @ (bgW-95,bgH-40)
    this.worldBtn.style.left = (bgW + L.world.dx) + 'px';
    this.worldBtn.style.top = L.world.dy + 'px';
    this.flyBtn.style.left = (bgW + L.fly.dx) + 'px';
    this.flyBtn.style.top = (bgH + L.fly.dy) + 'px';

    // 背景九宫格按新尺寸重烘（面板可见时立即烘，否则等 open() 触发）
    if (this.bgEngine) this.bgEngine.bakeIfVisible();
    this._updateCoordFromPlayer();
  }

  onOpen() {
    // 布局覆盖可能被面板编辑器改过 → 重开时热重载（不用刷新页面）
    const nl = loadMiniMapLayout();
    if (this.L && JSON.stringify(nl) !== JSON.stringify(this.L)) {
      this.L = nl;
      this._rebuild();
    }
    // 地图可能在面板关闭期间切换 → 重开时若地图变了，刷新底图
    const scene = this._scene();
    const map = (scene && scene.map) || (Config.maps && Config.maps[0]) || null;
    if (map) {
      const resId = (map.resId != null) ? map.resId : map.id;
      if (String(resId) !== this._resId) {
        this._resId = String(resId);
        this._mapId = String(map.id);
        this._imgFailed = false;
        this.img.style.visibility = '';
        loadSmallmap(this.img, this._resId, {
          onLoad: () => { this._imgFailed = false; if (this.img) this.img.style.visibility = ''; this._fitAll(); },
          onFail: () => { this._imgFailed = true;  if (this.img) this.img.style.visibility = 'hidden'; this._fitAll(); }
        });
      }
      // 世界尺寸同步（格子拼合），否则寻路层按旧图尺寸缩放 → 错位
      this._worldW = (map.stitchedW) || 2800;
      this._worldH = (map.stitchedH) || 2100;
    }
    this._fitAll();
    this._onResize = () => this._fitAll();
    window.addEventListener('resize', this._onResize);
    // 九宫格边框图异步加载，onload 才定厚 → 延迟再算一次保证首开贴合
    clearTimeout(this._refitT);
    this._refitT = setTimeout(() => this._fitAll(), 250);
    this._raf = requestAnimationFrame(this._rafLoop);
  }

  onClose() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    clearTimeout(this._refitT); this._refitT = 0;
    this._setHoverMark(null);     // 关面板时收起浮动提示（AS3 close → clearInfoPrompt）
    if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
  }

  _rafLoop() {
    if (!this._hovering) this._updateCoordFromPlayer();
    this._drawOverlay();
    this._raf = requestAnimationFrame(this._rafLoop);
  }

  // 玩家当前 RP 格写入坐标条；无玩家时清空
  _updateCoordFromPlayer() {
    const sc = this._scene();
    const p = sc && sc.player;
    if (!p) { this._setXY('', ''); return; }
    const rp = MapSystem.getGridPos(p.x, p.y);
    this._setXY(rp.col, rp.row);
  }

  _drawOverlay() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this._dispW, this._dispH);
    if (this._imgFailed) {
      // 底图缺失：占位底，绝不黑屏
      const W = this._dispW, H = this._dispH;
      ctx.fillStyle = '#1a2233';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#3a4a66'; ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, W - 2, H - 2);
      ctx.fillStyle = '#9fb4d8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '16px sans-serif';
      ctx.fillText('小地图资源缺失', W / 2, H / 2 - 12);
      ctx.font = '13px sans-serif'; ctx.fillStyle = '#7e90b0';
      ctx.fillText('(地图 #' + (this._resId || this._mapId) + ')', W / 2, H / 2 + 12);
      return;
    }
    const sc = this._scene();
    if (!sc || !sc.player) return;
    if (sc.constructor && sc.constructor.name !== 'MainScene') return;   // 仅主城场景绘制
    const sx = this._sx, sy = this._sy;

    // 悬停高亮（AS3 MapSprite.overHandler → UtilUtil03.setBrightness(this,50)）：
    // 先画在标记下层，径向提亮光晕 + 白色描边圈，明显但不遮图标
    if (this._hoverMark) {
      const hm = this._hoverMark;
      const g = ctx.createRadialGradient(hm.x, hm.y, 2, hm.x, hm.y, 16);
      g.addColorStop(0, 'rgba(255,244,190,.95)');
      g.addColorStop(0.55, 'rgba(255,220,120,.45)');
      g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(hm.x, hm.y, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hm.x, hm.y, 10, 0, Math.PI * 2); ctx.stroke();
    }

    const drawImg = (img, x, y, anchor) => {
      if (!img || !img.complete || !img.naturalWidth) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      const dx = x - (anchor === 'bottom' ? 0 : w / 2);
      const dy = y - (anchor === 'bottom' ? h : h / 2);
      ctx.drawImage(img, dx, dy);
    };

    // ① NPC 标记（与 HUD 角标一致；可见性受本面板勾选框控制）
    //    F6 懒加载后，远离视口、尚未加载的 NPC 不在 sc.actors 里；小地图是全图概览，
    //    需把 sc._npcPending 的待加载定义一并画上，否则概览会"丢点"。
    const imgs = this.ui && this.ui._miniImgs;
    const vis = (this.ui && this.ui._miniLayersVisible) || {};
    this._marks = [];
    const drawMark = (d, x, y) => {
      const t = d.type;
      let drawn = false;
      if (t === 'shop'          && vis.shop     !== false && imgs) { drawImg(imgs.shop,     x, y, 'center'); drawn = true; }
      else if (t === 'quest'    && vis.quest    !== false && imgs) { drawImg(imgs.quest,    x, y, 'center'); drawn = true; }
      else if (t === 'teleport' && vis.teleport !== false && imgs) { drawImg(imgs.teleport, x, y, 'center'); drawn = true; }
      else if (t === 'monster'  && vis.monster  !== false && imgs) {
        const mi = imgs.monster;
        if (mi && mi.complete && mi.naturalWidth) { drawImg(mi, x, y, 'center'); }
        else { ctx.fillStyle = '#ff5a5a'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
        drawn = true;
      }
      if (drawn) this._marks.push({ x, y, n: d });
      // 传送点常驻名称（AS3 MapMap05.setNameXY：0x9E2B0E 14px 加粗 + 白色发光描边，
      // 越界保护：底边放不下时翻到标记上方）
      if (t === 'teleport' && vis.teleport !== false && d.name) {
        ctx.font = 'bold 11px SimSun, "宋体", serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const ty = y + 10 + 11 > this._dispH ? y - 22 : y + 10;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.strokeText(d.name, x, ty);
        ctx.fillStyle = '#9e2b0e';
        ctx.fillText(d.name, x, ty);
      }
    };
    (sc.actors || []).forEach(f => { if (f && f.npcData) drawMark(f.npcData, f.x * sx, f.y * sy); });
    (sc._npcPending || []).forEach(pd => { if (pd && pd.n) drawMark(pd.n, pd.n.x * sx, pd.n.y * sy); });

    // 悬停的标记若本帧已不绘制（切图/关图层/离开视野），清除悬停态
    if (this._hoverMark) {
      const hm = this._hoverMark;
      const still = this._marks.some(m => m.n.id === hm.n.id && m.x === hm.x && m.y === hm.y);
      if (!still) this._setHoverMark(null);
    }

    // ② 寻路路径（红色 2px 折线 + 终点旗）：AS3 paintPath lineStyle(2,0xFF0000)
    const player = sc.player;
    if (player.path && player.path.length > 0) {
      ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = 2;
      ctx.beginPath();
      const pts = [{ x: player.x, y: player.y }].concat(player.path);
      pts.forEach((pt, i) => {
        const x = pt.x * sx, y = pt.y * sy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const last = pts[pts.length - 1];
      drawImg(imgs && imgs.flag, last.x * sx, last.y * sy, 'bottom');
    }

    // ③ 玩家位置球：居中（AS3 updatePosition）
    drawImg(imgs && imgs.ball, player.x * sx, player.y * sy, 'center');
  }
}
