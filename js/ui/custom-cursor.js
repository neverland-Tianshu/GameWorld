// 自绘光标（改样式实现）：隐藏系统鼠标，改用一张图片跟随鼠标，替换系统指针。
// 对齐 AS3 CursorManager：Mouse.hide() + startDrag(true) 自绘 Sprite 跟随鼠标；
// 默认 cursor_default，悬停可交互对象→cursor_dialog / 怪物→cursor_battle。
//
// 资源：resource/cursor/cursor*.png（由 update/i18n/zh_CN/.../icons/cursor*.png 复制而来，游戏自管）。
// 开关：ui._settings.customCursor（默认关，用户要求"目前需要调试"）。
// 通过样式实现：body.custom-cursor-on 全局 cursor:none 隐藏系统鼠标；一个 position:fixed 图片跟随鼠标。
// ★ 面板遮挡：指针落在 #ui-layer 的可见元素（面板/提示/侧栏）上时，_hitTestFighters 只看世界层
//   fighter、不知道面板盖在上面（面板背后的怪物会被误命中，出现「光标在设置面板上却显示 battle 光标」）。
//   由 scene._updateHover 在 UI 遮挡时把自绘光标切到 default 态（用户要求「UI 层也要有默认的自绘光标」），
//   并清掉面板背后 fighter 的 .hovered 高亮与错误的 viewport 手型。
const UI_ROOT_ID = 'ui-layer';

const CURSOR_IMG = {
  default: 'resource/cursor/cursordefault.png',
  dialog:  'resource/cursor/cursordialog.png',
  battle:  'resource/cursor/cursorbattle.png',
  nopass:  'resource/cursor/cursornopass.png',
};

class CustomCursor {
  constructor() {
    this.el = null;
    this.on = false;
    this._lastState = null;
    this._img = new Image();
    this._img.alt = '';
    this._img.draggable = false;
    this._img.style.cssText =
      'position:fixed;left:0;top:0;' +
      'pointer-events:none;user-select:none;z-index:2147483647;' +
      'transform:translate(-2px,-2px);display:none;will-change:left,top;';
    this._img.src = CURSOR_IMG.default;
    // 预载各状态图，切换时不闪（浏览器缓存 + 提前 decode）
    for (const k in CURSOR_IMG) { const im = new Image(); im.src = CURSOR_IMG[k]; }
    this._styleInjected = false;
    this._onMove = this._onMove.bind(this);
    this._onOver = this._onOver.bind(this);
    this._onOut = this._onOut.bind(this);
  }

  _ensureStyle() {
    if (this._styleInjected) return;
    const s = document.createElement('style');
    s.id = 'custom-cursor-style';
    // ★ 自绘光标开启时全局隐藏系统光标（UI 层也用自绘光标，不再恢复系统光标）。
    s.textContent = 'body.custom-cursor-on, body.custom-cursor-on *{cursor:none !important;}';
    document.head.appendChild(s);
    this._styleInjected = true;
  }

  _mount() {
    if (this.el) return;
    this.el = this._img;
    if (!this.el.parentNode) document.body.appendChild(this.el);
  }

  _onMove(e) {
    if (!this.on || !this.el) return;
    this.el.style.left = e.clientX + 'px';
    this.el.style.top = e.clientY + 'px';
  }

  // 悬停可交互对象时切换光标图（由 scene._updateHover 调用）
  _onOver(e) {
    if (!this.on || !this.el) return;
    this.setState(e.detail && e.detail.state ? e.detail.state : 'dialog');
  }
  _onOut() { if (this.on) this.setState('default'); }

  setState(state) {
    if (!this.on || !this.el) return;
    if (state === this._lastState) return;   // 状态未变则不重设（避免重复加载图）
    this._lastState = state;
    this.el.src = CURSOR_IMG[state] || CURSOR_IMG.default;
  }

  // 判定 client 点是否落在 UI 层（面板/提示/侧栏）上。供 scene 侧每次 hover 调用：
  //   命中 UI → 自绘光标切 default 态（UI 层统一显示默认自绘光标，不显示 dialog/battle/nopass）。
  //   ★ elementFromPoint 命中的是文档流最顶层元素：#ui-layer 自身 pointer-events:none 不参与命中，
  //     故命中的必是其内部真实可交互元素（面板/提示/侧栏）；落在地图上则命中 #world 子树。
  isOverUi(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return !!(el && el.closest && el.closest('#' + UI_ROOT_ID));
  }

  setEnabled(on) {
    this.on = !!on;
    if (this.on) {
      this._ensureStyle();
      this._mount();
      document.body.classList.add('custom-cursor-on');
      window.addEventListener('mousemove', this._onMove, true);
      document.addEventListener('cursor:over', this._onOver, true);
      document.addEventListener('cursor:out', this._onOut, true);
      this.el.style.display = 'block';
    } else {
      document.body.classList.remove('custom-cursor-on');
      window.removeEventListener('mousemove', this._onMove, true);
      document.removeEventListener('cursor:over', this._onOver, true);
      document.removeEventListener('cursor:out', this._onOut, true);
      if (this.el) this.el.style.display = 'none';
      this._lastState = null;
    }
  }
}

export const customCursor = new CustomCursor();
