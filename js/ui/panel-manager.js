// panel-manager.js
// 对应 deobfuscated/manager/PanelManager.as（全局面板单例）+ deobfuscated/panel/BasePanel.as
// 以及 Game/resource/js/panel.js 的 BasePanel / PanelBgEngine 参考实现。
//
// 单机版把 AS 的「PanelManager 单例 + BasePanel 基类 + 九宫格背景引擎」移植为 ES module：
//   - PanelManager：注册 / 开关 / 锁定 / 统一调度所有面板（register/open/close/lock/isOpened/closeAllNormal）
//   - BasePanel：统一 DOM 骨架（#panelLayer 容器、拖拽手柄、标题、关闭按钮、内容区、按钮区），
//                九宫格背景用 common_* 资源名映射（getLinkName）叠加真实图，图缺失时回退 CSS 风格。
//   - 中文 client 的 common_* 九宫格图未从 SWF 提取（仅有 ru_RU 版本含俄文），故默认走 CSS 羊皮纸+
//     金边风格，真实图一旦存在会自动 onload 覆盖。

import { url } from '../core/globals.js?v=20261007c';

// 资源名 → 小写去下划线 + .png（严格对齐 AS getLinkName / panel.js）
export function getLinkName(as3Name) {
  if (!as3Name) return '';
  return as3Name.replace(/_/g, '').toLowerCase() + '.png';
}

// 默认标题栏图标：按面板 id 映射真实客户端 face*/panel* 图标（dir 指定图集来源，避免跨目录 404）。
// 面板未在 super() 显式传 icon 时，用此表兜底，确保「每个面板」都带真实美术图标。
export const PANEL_TITLE_ICON = {
  'panel-char':      { dir: 'res',      file: 'faceportraitbg.png' },
  'panel-bag':       { dir: 'res',      file: 'facechest.png' },
  'panel-skill':     { dir: 'res',      file: 'facejineng.png' },
  'panel-quest':     { dir: 'res',      file: 'faceboard.png' },
  'panel-shop':      { dir: 'res',      file: 'faceshop.png' },
  'panel-npcshop':   { dir: 'res',      file: 'faceshop.png' },   // NPC 商店（与商城独立）
  'panel-warehouse': { dir: 'res',      file: 'facechest.png' },
  'panel-forge':     { dir: 'res2',     file: 'panelshengji100000001.png' },   // 强化=升级图标（Resource2）
  'panel-pet':       { dir: 'res',      file: 'facepetchest.png' },
  'panel-worldmap':  { dir: 'res',      file: 'facemap.png' },
  'panel-minimap':   { dir: 'res',      file: 'facemap.png' },
  'panel-bestiary':  { dir: 'res',      file: 'facenpc.png' },
  'panel-achv':      { dir: 'res',      file: 'faceexp.png' },
  'panel-medal':     { dir: 'res1',     file: 'panelmedal0.png' },   // 勋章槽位精灵（Resource1/icons）
  'panel-settings':  { dir: 'res',      file: 'facesystem.png' },
  'panel-team':      { dir: 'res',      file: 'faceplayershortcut.png' },
  'panel-battlelog': { dir: 'res',      file: 'facebattlepoints.png' },
  'panel-rank':      { dir: 'res',      file: 'facetopleft2.png' },
  'panel-title':     { dir: 'res',      file: 'facetopleft1.png' },
  'panel-mount':     { dir: 'res',      file: 'panelridepetbg.png' },
  'panel-emote':     { dir: 'res',      file: 'faceemote.png' },
  'panel-activity':  { dir: 'resLogin', file: 'panelbtnactivity.png' },        // LoginResource
  'panel-skillbook': { dir: 'res',      file: 'facejineng.png' },
  'panel-help':      { dir: 'resLogin', file: 'panelbtnhelp.png' },            // LoginResource
  'panel-debug':     { dir: 'res',      file: 'facesystem.png' },
};

// 九宫格背景引擎：build(config) 把 background/header/footer/border 资源名映射到 9 个分块。
// 真实图（中文版 common_* 在 LoginResource/icons 真实存在）延迟加载；图缺失时保留 CSS 风格。
// 烘焙缓存：同尺寸 + 同皮肤配置的面板复用同一张合成图（key = "WxH|cfg"）
const BAKE_CACHE = new Map();

export class PanelBgEngine {
  constructor(dom) {
    this.dom = dom;
    // 9 个分块：中心 + 4 角 + 4 边
    this.parts = ['bg-center', 'corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'border-t', 'border-b', 'border-l', 'border-r'];
    this.parts.forEach(p => {
      const i = document.createElement('i');
      i.className = 'pb-' + p;
      this.dom.appendChild(i);
    });
    this._imgs = {};      // part -> HTMLImageElement（已成功加载）
    this._pending = 0;    // 尚未决出（成功/失败）的分块数
    this._baked = false;  // 已烘焙（防重复）
  }

  build(config) {
    // part -> { name(资源名), key(写 CSS 变量的分组) }
    // key 决定 onload 时写 --pb-corner-t-w/h、--pb-border-t/l 等到面板根（厚度 = image.naturalWidth/Height）
    const map = {
      'bg-center':  { name: config.background,         key: 'bg-center' },
      'corner-tl':  { name: config.header,             key: 'corner-t' },
      'corner-tr':  { name: config.header,             key: 'corner-t' },
      'corner-bl':  { name: config.footer,             key: 'corner-b' },
      'corner-br':  { name: config.footer,             key: 'corner-b' },
      'border-t':   { name: config.headerBorder,       key: 'border-t' },
      'border-b':   { name: config.footerBorder,       key: 'border-b' },
      'border-l':   { name: config.borderL || config.border, key: 'border-l' },
      'border-r':   { name: config.borderR || config.border, key: 'border-r' }
    };
    this._cfgKey = JSON.stringify({
      background: config.background, header: config.header, footer: config.footer,
      headerBorder: config.headerBorder, footerBorder: config.footerBorder,
      borderL: config.borderL || config.border, borderR: config.borderR || config.border
    });
    for (const part in map) {
      const el = this.dom.querySelector('.pb-' + part);
      if (!el || !map[part].name) continue;
      this._pending++;
      const file = getLinkName(map[part].name);
      // ⚠ 本工程 url.res / res1 / res2 三者都别名到 update/i18n/<lang>/Resource/icons，
      //   而 common_* 九宫格图（commonbackground / commonpanelcorner1 / commoncorner2 /
      //   commonpanelsideline3 / commonsideline2 / commonsideline1）实际只存在于
      //   LoginResource/icons（已逐张实测：Resource/icons 下 6 张全部 404）。
      //   若按 AS3 GlobalsLoader.getImg 的 resource→loginResource 顺序探测，**每个面板每次打开**
      //   都会先吃 6 个 404 再回退 ⇒ 控制台刷满 "Failed to load resource"。
      //   故把 resLogin 提前到首位并去重：最终取到的图与 AS3 完全一致，只是少了 404。
      const candidates = [...new Set([url.resLogin(file), url.res(file), url.res1(file), url.res2(file)])];
      this._tryLoad(el, candidates, map[part].key, part);
    }
  }

  // 顺序尝试若干路径，首个成功 200 的图设为该分块背景 + 写入面板根 CSS 变量（厚度/角尺寸 = 图自然尺寸）。
  // CSS 已按 part 设好 background-repeat（corner:no-repeat / border-t/b:repeat-x / border-l/r:repeat-y / bg-center:repeat），
  // 不再设 background-size，保证真实 sideline 图 TILE 而非 100%×100% 拉伸糊图。
  _tryLoad(el, candidates, partKey, part) {
    let i = 0;
    const next = () => {
      if (i >= candidates.length) { this._pending--; this._maybeBake(); return; }   // 全部源失败：也计入决出
      const src = candidates[i++];
      const img = new Image();
      img.onload = () => {
        el.style.backgroundImage = `url("${src}")`;
        const root = this.dom.parentElement;
        if (root) {
          if (partKey === 'corner-t') {
            root.style.setProperty('--pb-corner-t-w', img.naturalWidth + 'px');
            root.style.setProperty('--pb-corner-t-h', img.naturalHeight + 'px');
          } else if (partKey === 'corner-b') {
            root.style.setProperty('--pb-corner-b-w', img.naturalWidth + 'px');
            root.style.setProperty('--pb-corner-b-h', img.naturalHeight + 'px');
          } else if (partKey === 'border-t') {
            root.style.setProperty('--pb-border-t', img.naturalHeight + 'px');
          } else if (partKey === 'border-b') {
            root.style.setProperty('--pb-border-b', img.naturalHeight + 'px');
          } else if (partKey === 'border-l') {
            root.style.setProperty('--pb-border-l', img.naturalWidth + 'px');
          } else if (partKey === 'border-r') {
            root.style.setProperty('--pb-border-r', img.naturalWidth + 'px');
          }
        }
        this._imgs[part] = img;      // 记录位图，供烘焙合成
        this._pending--;
        this._maybeBake();           // 所有分块决出后烘焙成单图
      };
      img.onerror = next;
      img.src = src;
    };
    next();
  }

  // 所有分块决出（成功或失败）后尝试烘焙；面板隐藏时 offsetWidth=0，等 open() 再触发
  _maybeBake() {
    if (this._baked || this._pending > 0) return;
    this.bakeIfVisible();
  }

  bakeIfVisible() {
    if (this._pending > 0) return;   // 图未加载完不烤（否则烤成空画布）
    if (!Object.keys(this._imgs).length) return;    // 全部源失败：保留 CSS 回退，不烤
    const root = this.dom.parentElement;
    if (!root) return;
    const W = root.offsetWidth, H = root.offsetHeight;
    if (!W || !H) return;           // display:none：尺寸 0，等 open() 再烤
    // ★ 尺寸变化必须重烘：可变尺寸面板（如小地图，随地图长宽比变化）首次烘焙后
    //   _baked 永置 true，旧 backgroundSize 盖不住新尺寸的底部 → 露黑。
    //   尺寸没变则直接返回（_fitAll 每次都调，零额外成本）。
    if (this._baked && this._bakedW === W && this._bakedH === H) return;
    this._bake(W, H);
  }

  // 把 9 个分块合成到单张 canvas（对齐 CSS 九宫格几何），再贴回 .pb-bg 作唯一背景图。
  // 单图渲染消除分块间的子像素缝隙（拖拽时不再出现拼合缝隙），并隐藏已绘制的分块元素。
  _bake(W, H) {
    const key = W + 'x' + H + '|' + (this._cfgKey || '');
    let dataUrl = BAKE_CACHE.get(key);
    if (!dataUrl) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const img = p => this._imgs[p];
      const ct = img('corner-tl'), cb = img('corner-bl');
      const bt = img('border-t'), bb = img('border-b');
      const bl = img('border-l'), br = img('border-r'), bc = img('bg-center');
      const cw = ct ? ct.naturalWidth : 0, ch = ct ? ct.naturalHeight : 0;
      const cbw = cb ? cb.naturalWidth : 0, cbh = cb ? cb.naturalHeight : 0;
      const bth = bt ? bt.naturalHeight : 0, bbh = bb ? bb.naturalHeight : 0;
      const blw = bl ? bl.naturalWidth : 0, brw = br ? br.naturalWidth : 0;
      const tile = (i, x, y, w, h, flipX) => {
        if (!i || !w || !h) return;
        ctx.save();
        // 平铺相位必须以本分块矩形左上角为原点（对齐 CSS background-position:0 0）。
        // createPattern 的图案空间以画布原点(0,0)为基准；若不先 translate，底边条(y=H-bbh)
        // 的纹理相位会随 H mod 图高 漂移：只有 H 恰好整除图高时才正常（背包 464%8=0 正常，
        // 人物 465%8=1 / 宠物 500%8=4 / 技能 470%8=6 / 小地图 356%5=1 全部错位、底边拼接异常）。
        if (flipX) { ctx.translate(x + w, y); ctx.scale(-1, 1); }
        else { ctx.translate(x, y); }
        const pat = ctx.createPattern(i, 'repeat');
        if (!pat) { ctx.restore(); return; }
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      };
      const once = (i, x, y, flipX) => {
        if (!i) return;
        ctx.save();
        if (flipX) { ctx.translate(x + i.naturalWidth, y); ctx.scale(-1, 1); x = 0; y = 0; }
        ctx.drawImage(i, x, y);
        ctx.restore();
      };
      // 中心（AS3 几何 rect(5,5,w-10,h-10)）→ 4 边 → 4 角，与 CSS 分层顺序一致
      tile(bc, 5, 5, W - 10, H - 10, false);
      tile(bl, 0, ch, blw, H - ch - cbh, false);
      tile(br, W - brw, ch, brw, H - ch - cbh, true);
      tile(bt, cw, 0, W - cw - cbw, bth, false);
      tile(bb, cw, H - bbh, W - cw - cbw, bbh, false);
      once(ct, 0, 0, false);
      once(img('corner-tr'), W - (img('corner-tr') ? img('corner-tr').naturalWidth : 0), 0, true);
      once(cb, 0, H - cbh, false);
      once(img('corner-br'), W - (img('corner-br') ? img('corner-br').naturalWidth : 0), H - (img('corner-br') ? img('corner-br').naturalHeight : 0), true);
      dataUrl = cv.toDataURL();
      BAKE_CACHE.set(key, dataUrl);
    }
    this.dom.style.backgroundImage = `url("${dataUrl}")`;
    this.dom.style.backgroundRepeat = 'no-repeat';
    this.dom.style.backgroundSize = W + 'px ' + H + 'px';
    // 隐藏已合成进烘焙图的分块（失败的保留 CSS 回退）
    for (const p in this._imgs) {
      const el = this.dom.querySelector('.pb-' + p);
      if (el) el.style.display = 'none';
    }
    this._baked = true;
    this._bakedW = W; this._bakedH = H;
  }
}

// ───────────────────────── 面板基类 ─────────────────────────
// 面板开关状态机常量。逐字对齐 deobfuscated/globals/GlobalsGlobal08.as:470/472
//   PANEL_STATE_OPEN:uint = 1  /  PANEL_STATE_CLOSE:uint = 2
export const PANEL_STATE = { OPEN: 1, CLOSE: 2 };

let _zTop = 5000;
// 打开栈（末尾 = 最顶层）。等价于 AS3 gameWorld.panelLayer 的显示列表顺序：
//   AS3 用 addChild 把面板压到最上层（拖拽时也会重新 addChild，见 MallPanel MOUSE_DOWN 分支），
//   此处用「栈序 + zIndex 递增」代替，供 removePanelLayerTopChild / closeTopMost 定位「最顶层面板」。
const _openStack = [];

export class BasePanel {
  constructor(opts = {}) {
    this.id = opts.id || ('panel-' + Math.random().toString(36).slice(2, 8));
    this.title = opts.title || '';
    // 标题栏图标：显式传 icon 优先，否则按 id 查 PANEL_TITLE_ICON 兜底（真实客户端 face*/panel* 图）
    this.icon = opts.icon || PANEL_TITLE_ICON[this.id] || null;
    // 显式传的 icon 可能是 {dir,file} 或纯文件名（默认按 res 目录）；统一规范化为 {dir,file}
    if (this.icon && typeof this.icon === 'string') this.icon = { dir: 'res', file: this.icon };
    this.width = opts.width || 470;
    this.height = opts.height || 340;
    this.ui = opts.ui || null;          // 持有 UI 引用，便于读取 player / questState
    this.draggable = opts.draggable !== false;
    this.bgSkin = opts.bgSkin || null;     // 自定义九宫格皮肤（资源名映射见 PanelBgEngine.build）

    // ── MallPanel 特性标志（逐项对齐 deobfuscated/panel/MallPanel.as）──
    //   panelId           : AS3 `panelId:int = -1`(:40)   面板数字 id（-1 = 未编号）
    //   status            : AS3 `_status:int = 2`(:46)    PANEL_STATE_OPEN/CLOSE，仅 open()/close() 两处写入
    //   isRightClickClose : AS3 (:86, 默认 true)          允许「右键关闭」；全 AS3 20 处显式置 false
    //   isForLock         : AS3 `_isForLock`(:84, 默认 true)  打开时登记进 currentOpenPanel（供 lockCurrentOpenPanel）
    //   isNpcPanel        : AS3 `_isNpcPanel`(:88, 默认 false) 由 NPC 对话打开 ⇒ 玩家走远自动关
    //   isBgBlackSp       : AS3 (:100, 默认 false)         打开时叠加全屏半透明黑遮罩（全 AS3 仅 2 处 true）
    //   keepOnCloseAll    : 本工程扩展，承载 AS3 `_freePanelList`（自由面板）语义 ⇒ closeAllNormal 不关它
    this.panelId = opts.panelId != null ? opts.panelId : -1;
    this.status = PANEL_STATE.CLOSE;
    this.isRightClickClose = opts.isRightClickClose !== false;
    this.isForLock = opts.isForLock !== false;
    this.isNpcPanel = !!opts.isNpcPanel;
    this.isBgBlackSp = !!opts.isBgBlackSp;
    this.keepOnCloseAll = !!opts.keepOnCloseAll;
    // AS3 `public var isClose:Boolean = true`(:52)：名字叫 isClose，语义实为「非拖拽态」闸——
    // MallPanel.close()(:461) 整函数体包在 `if(this.isClose)` 内，拖拽期间 close() 空转。
    this.isClose = true;
    this.bgBlackSp = null;   // 黑遮罩 DOM（AS3 bgBlackSp:Sprite，:98）
    this._pmName = null;     // 由 PanelManager.open() 回填，供管理器按名定位/关闭

    this._build();
    this.init && this.init();
  }

  _build() {
    const layer = document.getElementById('panelLayer');
    if (!layer) { console.error('[BasePanel] 找不到 #panelLayer 容器'); return; }

    const html = `
      <div class="tsqt-panel" id="${this.id}" style="width:${this.width}px;height:${this.height}px;display:none">
        <div class="pb-bg"></div>
        <div class="pb-drag"></div>
        <div class="pb-title"><span class="pb-title-txt">${this.title}</span></div>
        <button class="pb-close" title="关闭"><img class="pb-close-ic" src="${url.res('panelbtnclose.png')}" alt="" onload="this.nextElementSibling.style.display='none'" onerror="this.style.display='none'"/><span class="pb-close-x">✕</span></button>
        <div class="pb-body"></div>
        <div class="pb-btns"></div>
      </div>`;
    layer.insertAdjacentHTML('beforeend', html);

    this.dom = document.getElementById(this.id);
    this.dom.__panel = this;   // DOM → 实例反查：右键收口按「鼠标所在面板」关闭时用
    this.bg = this.dom.querySelector('.pb-bg');
    this.body = this.dom.querySelector('.pb-body');
    this.btns = this.dom.querySelector('.pb-btns');
    this.titleEl = this.dom.querySelector('.pb-title');

    // 九宫格背景（默认 CSS 渐变金边；真实图命中才覆盖）
    // 严格对齐 D:/tsqt/Game/resource/js/panel.js 的 BasePanel.initEngine 默认 config：
    //   header=common_panel_corner1(19×47) / footer=common_corner2(19×19) /
    //   headerBorder=common_panel_sideline3(18×36) / footerBorder=common_sideline2(1×8) /
    //   borderL/R=common_sideline1(8×1)；边由 JS 用图自然尺寸写 CSS 变量（--pb-border-t/l 等），
    //   CSS 用 repeat-x/y TILE 真实 sideline 图，不再 100%×100% 拉伸糊图。
    // bgSkin：面板可传自定义九宫格皮肤（资源名同 GlobalsLoader 键）。默认通用大框；
    //   小地图面板传 common_small_* 薄金框（对齐 AS3 fillBackground(...,"small")）。
    this.bgEngine = new PanelBgEngine(this.bg);
    this.bgEngine.build(this.bgSkin || {
      background: 'common_background',
      header: 'common_panel_corner1',
      footer: 'common_corner2',
      headerBorder: 'common_panel_sideline3',
      footerBorder: 'common_sideline2',
      borderL: 'common_sideline1',
      borderR: 'common_sideline1'
    });

    // 关闭
    this.dom.querySelector('.pb-close').addEventListener('click', () => this.close());

    // 拖拽（鼠标 + 触控：手机/触屏点按面板上栏即可拖动）
    if (this.draggable) {
      const handle = this.dom.querySelector('.pb-drag');
      let sx, sy, ox, oy, dragging = false, tid = null;
      const down = (e) => {
        if (e.touches) {
          if (tid !== null) return;               // 已在拖拽中，忽略后续触点，防多指跳动
          tid = e.touches[0].identifier;
        }
        dragging = true;
        // AS3 MallPanel MOUSE_DOWN 分支：startDrag() + `this.isClose = false` + `this.addChild(...)`(置顶)。
        //   ⇒ 拖拽起始即置顶，且拖拽期间 close() 被 isClose 闸挡住。
        this.isClose = false;
        this._raise();
        const p = e.touches ? e.touches[0] : e;
        // 面板默认用 transform:translate(-50%,-50%) 居中；offsetLeft/Top 不受 transform 影响，
        // 故先按当前可视位置（含居中 transform）把 left/top 烘焙到相对 offsetParent 的坐标，再清除 transform，
        // 避免 mousedown 瞬间面板向右下角跳半格。
        const rect = this.dom.getBoundingClientRect();
        const off = this.dom.offsetParent ? this.dom.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
        ox = rect.left - off.left;
        oy = rect.top - off.top;
        this.dom.style.left = ox + 'px';
        this.dom.style.top = oy + 'px';
        this.dom.style.transform = 'none';
        sx = p.clientX; sy = p.clientY;
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', up);
        window.addEventListener('touchcancel', up);
        // 窗口失焦兜底：AS3 的 MOUSE_UP 挂在 stage 上必达，浏览器里若在窗口外松手则收不到 mouseup，
        // 会让 isClose 永久停在 false（面板再也关不掉）。补一个 blur 复位，不改变正常路径语义。
        window.addEventListener('blur', up);
        e.preventDefault();
      };
      const move = (e) => {
        if (!dragging) return;
        let p;
        if (e.touches) {
          // 只跟随本拖拽的触点（其它手指滑动不干扰）
          p = Array.from(e.touches).find(t => t.identifier === tid);
          if (!p) return;
        } else p = e;
        this.dom.style.left = (ox + p.clientX - sx) + 'px';
        this.dom.style.top = (oy + p.clientY - sy) + 'px';
        if (e.cancelable) e.preventDefault();   // 触控拖动时阻止页面滚动/回弹
      };
      const up = () => {
        dragging = false; tid = null;
        this.isClose = true;   // AS3 MOUSE_UP：isClose = true
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', up);
        window.removeEventListener('touchcancel', up);
        window.removeEventListener('blur', up);
      };
      handle.addEventListener('mousedown', down);
      handle.addEventListener('touchstart', down, { passive: false });   // passive:false 才能阻止滚动
    }
  }

  // 改标题：只写 .pb-title-txt，保留标题栏图标（旧实现直接覆写 .pb-title 会把 <img> 图标冲掉）
  setTitle(t) {
    this.title = t;
    if (this.titleEl) {
      const txt = this.titleEl.querySelector('.pb-title-txt');
      if (txt) txt.textContent = t; else this.titleEl.textContent = t;
    }
  }

  // 内容区写入 HTML，返回 body 供进一步操作
  setContent(html) { this.body.innerHTML = html; return this.body; }

  // 按钮区：追加一个按钮（返回该按钮元素）
  addButton(label, onClick) {
    const b = document.createElement('button');
    b.className = 'pb-btn';
    b.textContent = label;
    if (onClick) b.onclick = onClick;
    this.btns.appendChild(b);
    return b;
  }

  // 置顶：对齐 AS3 每次 addChild 的置顶效果（open() 与拖拽起始都走这里）
  _raise() {
    if (this.dom) { _zTop += 1; this.dom.style.zIndex = _zTop; }
    const i = _openStack.indexOf(this);
    if (i >= 0) _openStack.splice(i, 1);
    _openStack.push(this);
  }
  _detach() { const i = _openStack.indexOf(this); if (i >= 0) _openStack.splice(i, 1); }

  // 打开面板。逐段对齐 deobfuscated/panel/MallPanel.as::open()(:428)
  open() {
    if (!this.dom) return this;
    this.dom.style.display = 'flex';
    if (this.bgEngine) this.bgEngine.bakeIfVisible();   // 显示后尺寸可测：烘焙九宫格背景
    this._raise();
    this.status = PANEL_STATE.OPEN;                       // AS3 :433
    panelManager._notifyOpen(this);                       // 同步 PanelManager.opened（✕ 直关也能回写）
    panelManager.setRightClickPanel(this);                // AS3 :434  RIGHT_CLICK_PANEL_ID = this.panelId
    if (this.isForLock) panelManager.addCurrentOpenPanel(this);   // AS3 :435-438
    if (this.isNpcPanel) panelManager.setNpcPanel(this);          // AS3 :439-442
    // AS3 :447-454：isBgBlackSp && !bgBlackSp 才建遮罩，并 setChildIndex(numChildren-2)
    //   ⇒ 遮罩插到「本面板正下方」，既盖住世界又不盖住本面板。此处用 insertBefore 等价实现。
    if (this.isBgBlackSp && !this.bgBlackSp) {
      const sp = document.createElement('div');
      sp.className = 'pb-black-sp';
      const layer = document.getElementById('panelLayer') || this.dom.parentElement;
      if (layer) layer.insertBefore(sp, this.dom);   // 插到本面板之前（DOM 顺序在下）
      // 遮罩置于「本面板正下方」（对齐 AS3 setChildIndex(numChildren-2)）：zIndex = 面板 zIndex - 1，
      // 既盖住世界 / 其它面板（模态），又不盖住本面板自身。
      const z = parseInt(this.dom.style.zIndex, 10);
      sp.style.zIndex = isNaN(z) ? 1 : (z - 1);
      this.bgBlackSp = sp;
    }
    this.onOpen && this.onOpen();
    return this;
  }

  // 关闭面板。逐段对齐 MallPanel.as::close()(:461)
  //   ★ 主体整段包在 `if(this.isClose)` 内 ⇒ **拖拽期间 close() 空转**（AS3 原样行为）；
  //     黑遮罩清理写在闸外，故拖拽中也能收掉遮罩。
  close() {
    if (!this.dom) return;
    if (this.isClose) {
      this.dom.style.display = 'none';
      this._detach();
      this.status = PANEL_STATE.CLOSE;                    // AS3 :470
      panelManager._notifyClose(this);                    // 同步 PanelManager.opened（✕ 直关也能回写）
      if (this.isForLock) panelManager.removeCurrentOpenPanel(this);  // AS3 :472-475
      if (this.isNpcPanel) panelManager.removeNpcPanel();            // AS3 :478-481
      panelManager._dropFromRightClick(this);                       // 清除可能指向本面板的右键引用（防 stale 导致误关其它面板）
      this.onClose && this.onClose();
    }
    if (this.isBgBlackSp && this.bgBlackSp) {              // AS3 :489-493
      this.bgBlackSp.remove();
      this.bgBlackSp = null;
    }
  }

  destroy() {
    this._detach();
    if (this.bgBlackSp) { this.bgBlackSp.remove(); this.bgBlackSp = null; }
    if (this.dom) { this.dom.remove(); this.dom = null; }
  }
}

// ───────────────────────── 面板单例管理器 ─────────────────────────
// 对应 AS PanelManager：集中注册所有面板，提供开关/锁定/调度。
export class PanelManager {
  constructor() {
    this.factories = {};   // name -> () => BasePanel
    this.panels = {};      // name -> instance（单例，懒创建）
    this.opened = {};      // name -> bool（与面板 status 同步，由 _notifyOpen/_notifyClose 维护）
    this.locked = {};      // name -> bool（锁定的面板不随 closeAllNormal 关闭）

    // ── 对齐 AS3 PanelManager.as 的四张表 + 三个运行期状态 ──
    //   _panelList(:316)        普通面板
    //   _freePanelList(:318)    自由面板 —— closeAllNormalPanel(:3089) **不扫它**，只有 closeAll(:3067) 扫
    //   messageBoxList(:322)    消息框（本工程暂无消息框宿主，见 MEMORY.md §10 未落地）
    //   currentOpenPanel(:548)  已打开且 _isForLock 的面板，供 lockCurrentOpenPanel 统一冻结
    this.freePanels = {};              // name -> true（addFreePanel 登记）
    this.currentOpenPanel = [];        // BasePanel[]
    this.isWorldLock = true;           // AS3 GameWorld._isWorldLock：true = 未锁（GameWorld.as:746）
    this.rightClickPanelName = null;   // AS3 GlobalsGlobal02.RIGHT_CLICK_PANEL_ID（-1 ⇔ null）
    this.context = null;               // 运行期上下文 { sm, ui }，由 UI 注入（供 NPC 巡检取玩家坐标）

    // ── NPC 面板距离自动关（对齐 PanelManager.as:496-500 常量 + 3302-3356 方法）──
    this.MaxDistance = 150;    // AS3 `public const MaxDistance:int = 150`(:498)
    this.currentNpcPanel = null;   // BasePanel[] | null
    this.currentPanelNpc = null;   // 触发对话的 NPC（须带 .x/.y）
    this._npcTimer = 0;
  }

  static getInstance() {
    if (!PanelManager._inst) PanelManager._inst = new PanelManager();
    return PanelManager._inst;
  }

  // 注册面板工厂（首次 open 时实例化，之后常驻为单例）
  register(name, factory) { this.factories[name] = factory; }

  // 注册「自由面板」。对齐 AS3 addFreePanel(:3009)：自由面板不被 closeAllNormalPanel 批量关闭，
  //   只能被 closeAll() 或显式 close 关掉。原版 9 处全部在 initGame()（7 个 relation 面板 +
  //   placard.PlacardPanel + battle.AutoBattlePanel）。
  addFreePanel(name, factory) {
    this.register(name, factory);
    this.freePanels[name] = true;
  }

  open(name, ...args) {
    if (!this.factories[name]) { console.warn('[PanelManager] 未注册面板:', name); return null; }
    if (!this.panels[name]) this.panels[name] = this.factories[name](...args);
    const p = this.panels[name];
    p._pmName = name;      // 回填：BasePanel 据此回报管理器（AS3 用 int panelId 寻址，本工程用名）
    p.open();
    this.opened[name] = true;
    return p;
  }

  // 关闭面板。★ 对齐 AS3 close(value:int):Boolean(:2979)：**仅当该面板 status==OPEN 才真关并返回 true**，
  //   否则返回 false —— useRightClickPanel 正是靠这个返回值决定是否回退到「关最顶层面板」。
  close(name) {
    const p = this.panels[name];
    if (!p || p.status !== PANEL_STATE.OPEN) { this.opened[name] = false; return false; }
    p.close();
    this.opened[name] = false;
    return true;
  }

  // 彻底销毁面板实例：先 onClose（取消 rAF/移除 resize 监听，避免旧实例泄漏）再移除 DOM，
  // 并清掉 this.panels 缓存，使下次 open 重新实例化。区别于 close()：close 仅隐藏、实例常驻单例。
  destroy(name) {
    const p = this.panels[name];
    if (p) {
      if (p.onClose) p.onClose();
      p.status = PANEL_STATE.CLOSE;
      this.removeCurrentOpenPanel(p);
      this._dropFromNpcPanel(p);
      this._dropFromRightClick(p);
      p.destroy();
      delete this.panels[name];
    }
    this.opened[name] = false;
  }

  toggle(name) {
    if (this.opened[name]) this.close(name);
    else this.open(name);
  }

  isOpened(name) { return !!this.opened[name]; }

  // 取已实例化的面板（未实例化返回 null）。供 changeMap 等需要在销毁前读取面板状态（如屏幕位置）的调用方使用。
  _getInstance(name) { return this.panels[name] || null; }

  // ── BasePanel 回调：保持 opened 与面板真实 status 同步 ──
  //   必要性：面板「✕」按钮走的是 BasePanel.close()，不经 PanelManager.close()，
  //   若不回写会让 opened[name] 永久停 true（toggle 反向、isOpened 说谎）。
  _notifyOpen(p) { if (p && p._pmName) this.opened[p._pmName] = true; }
  _notifyClose(p) { if (p && p._pmName) this.opened[p._pmName] = false; }

  // ── 当前打开面板登记（对齐 AS3 addCurrentOpenPanel / removeCurrentOpenPanel）──
  //   由 MallPanel.open()/close() 在 _isForLock 时自动调用 ⇒ 无手写配对负担。
  addCurrentOpenPanel(p) { if (p && this.currentOpenPanel.indexOf(p) < 0) this.currentOpenPanel.push(p); }
  removeCurrentOpenPanel(p) { const i = this.currentOpenPanel.indexOf(p); if (i >= 0) this.currentOpenPanel.splice(i, 1); }
  // 冻结/解冻全部已打开面板（对齐 lockCurrentOpenPanel/unlockCurrentOpenPanel：AS3 置 mouseChildren/mouseEnabled）
  lockCurrentOpenPanel() { this.currentOpenPanel.forEach(p => { if (p.dom) p.dom.style.pointerEvents = 'none'; }); }
  unlockCurrentOpenPanel() { this.currentOpenPanel.forEach(p => { if (p.dom) p.dom.style.pointerEvents = ''; }); }

  // ── 自由面板 / 批量关闭（对齐 AS3 closePanelByList :3073 / closeAllNormalPanel :3089 / closeAll :3067）──
  _instances() { return Object.keys(this.panels).map(n => this.panels[n]).filter(Boolean); }
  _isFreePanel(p) { return !!(this.freePanels[p._pmName] || p.keepOnCloseAll); }
  // AS3 closePanelByList：只关 status==OPEN 的，并把 mouseChildren/mouseEnabled 复位为 true。
  _closePanelByList(list) {
    list.forEach(p => {
      if (!p || p.status !== PANEL_STATE.OPEN) return;
      if (p.dom) p.dom.style.pointerEvents = '';
      p.close();
    });
  }
  // closeAllNormalPanel()：**只扫 _panelList**，不扫 _freePanelList ⇒ 自由面板不被批量关（AS3 原样）。
  closeAllNormal() {
    this._closePanelByList(this._instances().filter(p => !this._isFreePanel(p) && !this.locked[p._pmName]));
  }
  // closeAll()：三张表（普通 + 自由 + 消息框）一起关。
  closeAll() { this._closePanelByList(this._instances()); }

  lock(name) { this.locked[name] = true; }
  unlock(name) { this.locked[name] = false; }

  // ── 右键分发（对齐 GameWorld.as::rightClick :617 + PanelManager.as::useRightClickPanel :3130）──
  //   AS3 右键是**全局收口**：rightClick() 依 6 个上下文分支择一执行。本工程只实现
  //     分支 0（新手引导进行中 → 直接 return，禁用右键）
  //     分支 6（默认 → useRightClickPanel()，即「面板右键菜单」）
  //   分支 1~5 依赖 USE_ITEM / RIGHT_CLICK_FRIEND / RIGHT_CLICK_HEAD / USE_SHORTCUT —— 这 4 套子系统
  //   本工程尚未移植（好友/快捷栏/右键用物品），故不臆造其行为。
  setRightClickPanel(p) { this.rightClickPanelName = p ? (p._pmName || null) : null; }
  _dropFromRightClick(p) { if (this.panels[this.rightClickPanelName] === p) this.rightClickPanelName = null; }

  // 关掉「最顶层面板」。对齐 GameWorld.as::removePanelLayerTopChild :673：
  //   只取最顶层一个；若它不是「可右键关」的面板就什么都不做（**不向下继续扫描**）。
  closeTopMost() {
    const top = _openStack[_openStack.length - 1];
    if (top && top.status === PANEL_STATE.OPEN && top.isRightClickClose) { top.close(); return true; }
    return false;
  }

  // 对齐 PanelManager.as::useRightClickPanel :3130
  useRightClickPanel() {
    const n = this.rightClickPanelName;
    if (n != null) {
      const p = this.panels[n];
      if (p) {
        if (p.isRightClickClose && this.close(n)) { this.rightClickPanelName = null; return true; }
        return this.closeTopMost();     // AS3 :3142-3144 回退分支
      }
      return false;                     // AS3：getPanelById 返回 null ⇒ 什么都不做
    }
    return this.closeTopMost();         // AS3 :3149
  }

  // ── NPC 面板距离自动关（对齐 PanelManager.as:3302-3356）──
  // setNpcPanel :3305 — 由 MallPanel.open() 在 _isNpcPanel 时调用，把面板压入 currentNpcPanel。
  setNpcPanel(p) {
    if (!p) return;
    if (this.currentNpcPanel == null) this.currentNpcPanel = [];
    this.currentNpcPanel.push(p);
  }
  // removeNpcPanel :3318 — ★ AS3 原样：**无参、整表置空**（不是移除单个）。照抄此行为。
  removeNpcPanel() { this.currentNpcPanel = null; }
  _dropFromNpcPanel(p) {
    if (!this.currentNpcPanel) return;
    const i = this.currentNpcPanel.indexOf(p);
    if (i >= 0) this.currentNpcPanel.splice(i, 1);
    if (!this.currentNpcPanel.length) this.currentNpcPanel = null;
  }

  // 记录「本次由哪个 NPC 打开的面板」，并启动巡检。
  //   对齐 Player.as:428（`currentPanelNpc = characterManager.getCharacterByCid(npcTalkId)`）
  //     + SceneManager.as:1088（`startCaculateNpcPanel()`）。
  setCurrentPanelNpc(npc) {
    this.currentPanelNpc = npc || null;
    if (this.currentPanelNpc) this.startCaculateNpcPanel();
  }

  // caculateNpcPanel :3325 — 玩家与 NPC 的**曼哈顿**距离 > MaxDistance 即关掉 currentNpcPanel 全部面板。
  caculateNpcPanel() {
    // 无面板 / 无 NPC 可巡检 ⇒ 停表（防 setInterval 泄漏），与 AS3 EffectTimer 行为等价
    if (this.currentNpcPanel == null || this.currentPanelNpc == null) { this.stopCaculateNpcPanel(); return; }
    const pl = this.playerXY();
    if (!pl) return;
    const npc = this.currentPanelNpc;
    if (Math.abs(pl.x - npc.x) + Math.abs(pl.y - npc.y) > this.MaxDistance) {
      this.currentNpcPanel.forEach(p => { if (p && p.status === PANEL_STATE.OPEN) p.close(); });
    }
  }

  // initNpcPanelTimer :3352 — EffectTimer(1000) ⇒ 1s 一跳；startCaculateNpcPanel :3346 启动。
  startCaculateNpcPanel() {
    if (this._npcTimer) return;
    this._npcTimer = setInterval(() => {
      try { this.caculateNpcPanel(); } catch (e) { /* 巡检异常绝不外溢（铁律：主循环不可杀） */ }
    }, 1000);
  }
  stopCaculateNpcPanel() { if (this._npcTimer) { clearInterval(this._npcTimer); this._npcTimer = 0; } }

  // 玩家当前坐标（AS3 取 _sceneManager.player.x/y）。上下文未注入或当前场景无玩家时返回 null ⇒ 巡检跳过。
  playerXY() {
    const sm = (this.context && this.context.sm) || null;
    if (!sm) return null;
    const sc = sm.current;
    const p = (sc && sc.player) || sm.player || null;
    return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null;
  }

  // 运行期上下文注入（UI 构造/绑定玩家时调用一次）
  bindContext(ctx) { this.context = Object.assign(this.context || {}, ctx || {}); return this; }

  // 列出所有已注册面板名（调试面板用）
  names() { return Object.keys(this.factories); }
}

export const panelManager = new PanelManager();
