// ts-scrollpane.js — 滚动面板
// 移植自：fl.containers.BaseScrollPane + fl.containers.ScrollPane
// （DefaultComponent.swf + UIComponent.swf）
//
// 关键对齐点：
//   - source（类/URL/HTML 字符串/DOM 节点）、content、update()、refreshPane()
//   - contentPadding（ScrollPane 默认 0）
//   - horizontalScrollPolicy / verticalScrollPolicy（默认 AUTO）
//   - defaultLineScrollSize = 4（对齐 AS3 BaseScrollPane）
//   - 滚动条宽度 ScrollBar.WIDTH = 15
//   - scrollDrag（拖动内容滚动）、滚轮、键盘（Home/End/PgUp/PgDn/方向键）
//   - disabledAlpha = 0.5（对齐 AS3 BaseScrollPane.disabledSkin 的禁用态）
//   - 派发 scroll（ScrollEvent）、complete、init、resize、progress（加载场景）
//
// 用法一（声明式，内容直接写在标签里）：
//   <ts-scrollpane style="width:300px;height:200px">
//     <div style="width:600px;height:800px">大块内容</div>
//   </ts-scrollpane>
//
// 用法二（source 属性）：
//   const pane = document.createElement('ts-scrollpane');
//   pane.source = '<p>HTML 片段</p>';        // 或图片 URL、DOM 节点
//
// 自定义元素：<ts-scrollpane>

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
  ScrollEvent,
  ScrollPolicy,
  ScrollBarDirection,
} from './ts-base.js?v=20261007c';
import { TsScrollBar } from './ts-scrollbar.js?v=20261007c';

// 滚动条占用的宽度（= ts-scrollbar.js SCROLL_BAR_WIDTH / CSS --ts-scroll-w）
const SCROLL_BAR_WIDTH = 17;

export class TsScrollPane extends UIComponent {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'source',
      'scroll-drag',
      'vertical-scroll-policy',
      'horizontal-scroll-policy',
    ];
  }

  // 对齐 fl.containers.ScrollPane.defaultStyles
  static defaultStyles = {
    upSkin: 'ScrollPane_upSkin',
    disabledSkin: 'ScrollPane_disabledSkin',
    focusRectSkin: null,
    focusRectPadding: null,
    contentPadding: 0,
    // 对齐 fl.containers.BaseScrollPane.defaultStyles
    disabledAlpha: 0.5,
    repeatDelay: 500,
    repeatInterval: 35,
    skin: 'ScrollPane_upSkin',
  };

  constructor() {
    super();
    this._source = '';
    this._scrollDrag = false;
    this._verticalScrollPolicy = ScrollPolicy.AUTO;
    this._horizontalScrollPolicy = ScrollPolicy.AUTO;
    this._lineScrollSize = 4; // 对齐 AS3 defaultLineScrollSize
    this._currentContent = null;
    this._contentWidth = 0;
    this._contentHeight = 0;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'source':
        this.source = newValue;
        break;
      case 'scroll-drag':
        this._scrollDrag = this.hasAttribute('scroll-drag');
        this.invalidate(InvalidationType.STATE);
        break;
      case 'vertical-scroll-policy':
        this._verticalScrollPolicy = normalizePolicy(newValue);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'horizontal-scroll-policy':
        this._horizontalScrollPolicy = normalizePolicy(newValue);
        this.invalidate(InvalidationType.SIZE);
        break;
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<div class="ts-content-clip"><slot></slot></div>' +
      '<ts-scrollbar class="ts-v-scroll" direction="vertical"></ts-scrollbar>' +
      '<ts-scrollbar class="ts-h-scroll" direction="horizontal"></ts-scrollbar>';
    this._bgEl = this.querySelector('.ts-bg');
    this._contentClip = this.querySelector('.ts-content-clip');
    this._vScroll = this.querySelector('.ts-v-scroll');
    this._hScroll = this.querySelector('.ts-h-scroll');

    this._vScroll.addEventListener('scroll', (e) => this._handleScroll(e));
    this._hScroll.addEventListener('scroll', (e) => this._handleScroll(e));
    this.addEventListener('wheel', (e) => this._handleWheel(e), { passive: false });
    this.addEventListener('keydown', (e) => this._keyDownHandler(e));
  }

  // ---- source / content（对齐 AS3 ScrollPane.source）---------------------
  get source() {
    return this._source;
  }

  set source(value) {
    this.clearContent();
    if (value == null || value === '') {
      this._source = '';
      return;
    }
    this._source = value;
    const content = this._instantiateSource(value);
    if (content) {
      this._currentContent = content;
      this._contentClip.appendChild(content);
      this.dispatchEvent(new CustomEvent('init', { bubbles: false }));
      this.update();
    }
  }

  /**
   * 把 source 转成 DOM 节点（对齐 AS3 getDisplayObjectInstance + load 分支）：
   *   - DOM 节点：原样使用
   *   - HTML 字符串（含 < 开头）：解析为节点
   *   - 图片 URL（.png/.jpg/.jpeg/.gif/.webp/.svg）：创建 <img>
   *   - 其它 URL：fetch 取回后插入（派发 progress/complete）
   */
  _instantiateSource(value) {
    if (value instanceof HTMLElement) return value;
    const s = String(value);
    if (s.trim().charAt(0) === '<') {
      const holder = document.createElement('div');
      holder.innerHTML = s;
      return holder.firstElementChild || holder;
    }
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(s)) {
      const img = document.createElement('img');
      img.src = s;
      img.addEventListener('load', () => {
        this.update();
        this.dispatchEvent(new CustomEvent('complete', { bubbles: false }));
      });
      return img;
    }
    // 远程文本：异步加载
    const holder = document.createElement('div');
    holder.textContent = '加载中…';
    fetch(s)
      .then((r) => r.text())
      .then((text) => {
        holder.innerHTML = text;
        this.update();
        this.dispatchEvent(new CustomEvent('complete', { bubbles: false }));
      })
      .catch(() => {
        holder.textContent = '加载失败：' + s;
      });
    this.dispatchEvent(new CustomEvent('progress', { bubbles: false, detail: { bytesLoaded: 0 } }));
    return holder;
  }

  get content() {
    return this._currentContent;
  }

  /**
   * 重测内容尺寸（对齐 AS3 ScrollPane.update）。
   */
  update() {
    const first = this._contentClip.firstElementChild;
    if (!first) return;
    this._contentWidth = first.scrollWidth || first.offsetWidth || 0;
    this._contentHeight = first.scrollHeight || first.offsetHeight || 0;
    this.invalidate(InvalidationType.SIZE);
  }

  refreshPane() {
    const s = this._source;
    this._source = '';
    this.source = s;
  }

  clearContent() {
    // 保留 <slot>，移除 source 插入的内容
    Array.from(this._contentClip.children).forEach((child) => {
      if (child.tagName !== 'SLOT') this._contentClip.removeChild(child);
    });
    this._currentContent = null;
    this._contentWidth = 0;
    this._contentHeight = 0;
  }

  // ---- 滚动策略 ---------------------------------------------------------
  get verticalScrollPolicy() {
    return this._verticalScrollPolicy;
  }

  set verticalScrollPolicy(value) {
    this._verticalScrollPolicy = normalizePolicy(value);
    this.invalidate(InvalidationType.SIZE);
  }

  get horizontalScrollPolicy() {
    return this._horizontalScrollPolicy;
  }

  set horizontalScrollPolicy(value) {
    this._horizontalScrollPolicy = normalizePolicy(value);
    this.invalidate(InvalidationType.SIZE);
  }

  get scrollDrag() {
    return this._scrollDrag;
  }

  set scrollDrag(value) {
    this._scrollDrag = !!value;
    this.toggleAttribute('scroll-drag', this._scrollDrag);
    this.invalidate(InvalidationType.STATE);
  }

  // ---- 滚动位置 ---------------------------------------------------------
  get verticalScrollPosition() {
    return this._contentClip ? this._contentClip.scrollTop : 0;
  }

  set verticalScrollPosition(value) {
    if (this._contentClip) this._contentClip.scrollTop = value;
  }

  get horizontalScrollPosition() {
    return this._contentClip ? this._contentClip.scrollLeft : 0;
  }

  set horizontalScrollPosition(value) {
    if (this._contentClip) this._contentClip.scrollLeft = value;
  }

  get maxVerticalScrollPosition() {
    this.drawNow();
    if (!this._contentClip) return 0;
    return Math.max(0, this._contentClip.scrollHeight - this._contentClip.clientHeight);
  }

  get maxHorizontalScrollPosition() {
    this.drawNow();
    if (!this._contentClip) return 0;
    return Math.max(0, this._contentClip.scrollWidth - this._contentClip.clientWidth);
  }

  get lineScrollSize() {
    return this._lineScrollSize;
  }

  set lineScrollSize(value) {
    this._lineScrollSize = value;
  }

  // ---- 重绘（对齐 AS3 BaseScrollPane.draw / drawLayout）-------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.STYLES] || invalidHash[InvalidationType.ALL]) {
      this.drawBackground();
    }
    if (invalidHash[InvalidationType.STATE] || invalidHash[InvalidationType.ALL]) {
      this.setScrollDrag();
    }
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.drawLayout();
    }
    super.draw(invalidHash);
  }

  drawBackground() {
    // 皮肤由 CSS .ts-bg 呈现；禁用态半透明（对齐 AS3 disabledAlpha）
    this._bgEl.style.opacity = this.enabled ? '1' : String(this.getStyleValue('disabledAlpha') || 0.5);
  }

  setScrollDrag() {
    if (this._scrollDrag) {
      if (!this._dragBound) {
        this._dragBound = true;
        this._contentClip.addEventListener('mousedown', (e) => this._doStartDrag(e));
        window.addEventListener('mouseup', () => this._endDrag());
      }
    }
    this._contentClip.style.cursor = this._scrollDrag ? 'pointer' : '';
  }

  _doStartDrag(e) {
    if (!this.enabled || !this._scrollDrag) return;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._dragScrollH = this.horizontalScrollPosition;
    this._dragScrollV = this.verticalScrollPosition;
    this._dragging = true;
    const onMove = (ev) => {
      if (!this._dragging) return;
      this.verticalScrollPosition = this._dragScrollV - (ev.clientY - this._dragStartY);
      this.horizontalScrollPosition = this._dragScrollH - (ev.clientX - this._dragStartX);
    };
    window.addEventListener('mousemove', onMove);
    this._dragMoveHandler = onMove;
  }

  _endDrag() {
    this._dragging = false;
    if (this._dragMoveHandler) {
      window.removeEventListener('mousemove', this._dragMoveHandler);
      this._dragMoveHandler = null;
    }
  }

  // 对齐 AS3 BaseScrollPane.calculateAvailableSize / drawLayout
  drawLayout() {
    const clip = this._contentClip;
    if (!clip) return;
    const pad = Number(this.getStyleValue('contentPadding')) || 0;
    const W = SCROLL_BAR_WIDTH;

    // ⚠ 滚动条显隐会改变内容可用宽高 → 内容的 scrollHeight/scrollWidth 随之变化，
    //   所以 needV/needH 与 clip 高宽互相依赖，单次判定不收敛：
    //   首轮 needV 读到的是「旧 clip 高度」下的 maxV（通常为 0 → 误判不需要滚动条），
    //   clip 按新 availH 落地后 maxV 才变正。此处迭代到 needV/needH 稳定（最多 4 次），
    //   保证一次 drawNow 内滚动条显隐与内容裁剪一致。
    let needV = false, needH = false;
    let availW = 0, availH = 0;
    for (let i = 0; i < 4; i++) {
      needV = this.needVScroll();
      availW = this.width - pad * 2 - (needV ? W : 0);
      needH = this.needHScroll();
      availH = this.height - pad * 2 - (needH ? W : 0);
      clip.style.left = pad + 'px';
      clip.style.top = pad + 'px';
      clip.style.width = availW + 'px';
      clip.style.height = availH + 'px';
      const nV = this.needVScroll();
      const nH = this.needHScroll();
      if (nV === needV && nH === needH) break;
      needV = nV;
      needH = nH;
    }

    // 内容尺寸由内容自身决定（Web 用 overflow + scrollTop 天然支持裁剪滚动，
    // 不像 AS3 需要显式 setContentSize）
    if (needV) {
      this._vScroll.style.display = '';
      this._vScroll.style.left = this.width - SCROLL_BAR_WIDTH + 'px';
      this._vScroll.style.top = pad + 'px';
      this._vScroll.style.width = SCROLL_BAR_WIDTH + 'px';
      this._vScroll.style.height = availH + 'px';
      this._vScroll.setScrollProperties(availH, 0, Math.max(0, this.maxVerticalScrollPosition), availH);
      this._vScroll.scrollPosition = this.verticalScrollPosition;
      this._vScroll.lineScrollSize = this._lineScrollSize;
    } else {
      this._vScroll.style.display = 'none';
    }
    // 横向滚动条
    if (needH) {
      this._hScroll.style.display = '';
      this._hScroll.style.left = pad + 'px';
      this._hScroll.style.top = this.height - SCROLL_BAR_WIDTH + 'px';
      this._hScroll.style.width = availW + 'px';
      this._hScroll.style.height = SCROLL_BAR_WIDTH + 'px';
      this._hScroll.setScrollProperties(availW, 0, Math.max(0, this.maxHorizontalScrollPosition), availW);
      this._hScroll.scrollPosition = this.horizontalScrollPosition;
      this._hScroll.lineScrollSize = this._lineScrollSize;
    } else {
      this._hScroll.style.display = 'none';
    }
  }

  needVScroll() {
    if (this._verticalScrollPolicy === ScrollPolicy.OFF) return false;
    if (this._verticalScrollPolicy === ScrollPolicy.ON) return true;
    return this.maxVerticalScrollPosition > 0;
  }

  needHScroll() {
    if (this._horizontalScrollPolicy === ScrollPolicy.OFF) return false;
    if (this._horizontalScrollPolicy === ScrollPolicy.ON) return true;
    return this.maxHorizontalScrollPosition > 0;
  }

  // ---- 事件 -------------------------------------------------------------
  _handleScroll(e) {
    // 滚动条位置 → 内容滚动（对齐 AS3 setVerticalScrollPosition 写 scrollRect）
    if (e.detail.direction === ScrollBarDirection.VERTICAL) {
      this.verticalScrollPosition = e.detail.position;
    } else {
      this.horizontalScrollPosition = e.detail.position;
    }
    // 转发滚动事件（对齐 AS3 ScrollPane.handleScroll 的 passEvent）。
    // ⚠ 事件正在派发中，不能直接重投同一个实例（InvalidStateError），必须 clone
    this.dispatchEvent(e.clone ? e.clone() : new ScrollEvent(e.detail.direction, e.detail.delta, e.detail.position));
  }

  _handleWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.verticalScrollPosition -= e.deltaY * this._lineScrollSize;
  }

  // 对齐 AS3 ScrollPane.keyDownHandler
  _keyDownHandler(e) {
    if (!this.enabled) return;
    const page = this.height;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.verticalScrollPosition += this._lineScrollSize;
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.verticalScrollPosition -= this._lineScrollSize;
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.horizontalScrollPosition += this._lineScrollSize;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.horizontalScrollPosition -= this._lineScrollSize;
        break;
      case 'End':
        e.preventDefault();
        this.verticalScrollPosition = this.maxVerticalScrollPosition;
        break;
      case 'Home':
        e.preventDefault();
        this.verticalScrollPosition = 0;
        break;
      case 'PageUp':
        e.preventDefault();
        this.verticalScrollPosition -= page;
        break;
      case 'PageDown':
        e.preventDefault();
        this.verticalScrollPosition += page;
        break;
    }
  }

  // 内容变化时重算（slot 子元素尺寸改变时由外部调用）
  invalidateContent() {
    this.update();
  }
}

function normalizePolicy(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'on' || v === 'off' || v === 'auto') return v;
  return ScrollPolicy.AUTO;
}

customElements.define('ts-scrollpane', TsScrollPane);

export default TsScrollPane;
