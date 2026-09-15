// ts-scrollbar.js — 滚动条
// 移植自：fl.controls.ScrollBar（AS3 原版 WIDTH=15，复古木质皮肤加宽到 17）
// + fl.controls.UIScrollBar（DefaultComponent.swf + UIComponent.swf）
//
// 关键对齐点：
//   - 静态 WIDTH = 17（= CSS --ts-scroll-w，皮肤宽度；BaseScrollPane 也引用它）
//   - setScrollProperties(pageSize, minScrollPosition, maxScrollPosition, pageScrollSize)
//   - updateThumb()：滑块长度 = max(38, pageSize / (max-min+pageSize) * 轨道长度)
//     （38 = CSS min-height:38px，JS 与渲染同源，否则拖拽比例错位）
//   - 箭头按钮 autoRepeat（repeatDelay=500 / repeatInterval=35）
//   - 拖拽滑块、点击轨道翻页、滚轮（对齐 AS3 scrollPressHandler / handleThumbDrag）
//   - 派发 ScrollEvent(direction, delta, position)
//
// 自定义元素：<ts-scrollbar direction="vertical|horizontal">
//           <ts-uiscrollbar direction="vertical|horizontal">（绑定目标元素版）

import {
  UIComponent,
  InvalidationType,
  ScrollEvent,
  ScrollBarDirection,
  styleToCssVar,
} from './ts-base.js?v=20261007c';

// 复古木质皮肤宽度（= CSS --ts-scroll-w；AS3 原版为 15，皮肤加宽后全项目同源）
export const SCROLL_BAR_WIDTH = 17;
// 最小滑块尺寸（= CSS .ts-thumb min-height/min-width:38px，JS 与渲染同源）
export const MIN_THUMB_SIZE = 38;

export class TsScrollBar extends UIComponent {
  static get observedAttributes() {
    return [...super.observedAttributes, 'direction'];
  }

  // 对齐 fl.controls.ScrollBar.defaultStyles
  static defaultStyles = {
    downArrowDisabledSkin: 'ScrollArrowDown_disabledSkin',
    downArrowDownSkin: 'ScrollArrowDown_downSkin',
    downArrowOverSkin: 'ScrollArrowDown_overSkin',
    downArrowUpSkin: 'ScrollArrowDown_upSkin',
    thumbDisabledSkin: 'ScrollThumb_disabledSkin',
    thumbDownSkin: 'ScrollThumb_downSkin',
    thumbOverSkin: 'ScrollThumb_overSkin',
    thumbUpSkin: 'ScrollThumb_upSkin',
    thumbIcon: 'ScrollBar_thumbIcon',
    trackDisabledSkin: 'ScrollTrack_disabledSkin',
    trackDownSkin: 'ScrollTrack_downSkin',
    trackOverSkin: 'ScrollTrack_overSkin',
    trackUpSkin: 'ScrollTrack_upSkin',
    upArrowDisabledSkin: 'ScrollArrowUp_disabledSkin',
    upArrowDownSkin: 'ScrollArrowUp_downSkin',
    upArrowOverSkin: 'ScrollArrowUp_overSkin',
    upArrowUpSkin: 'ScrollArrowUp_upSkin',
    repeatDelay: 500,
    repeatInterval: 35,
  };

  constructor() {
    super();
    this._direction = ScrollBarDirection.VERTICAL;
    this._pageSize = 10;
    this._pageScrollSize = 0;
    this._minScrollPosition = 0;
    this._maxScrollPosition = 100;
    this._scrollPosition = 0;
    this._lineScrollSize = 1;
    this._inDrag = false;
    // 箭头/轨道按住的自动重复（对齐 AS3 pressTimer）
    this._repeatToken = 0;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === 'direction') {
      this._direction = newValue === ScrollBarDirection.HORIZONTAL ? ScrollBarDirection.HORIZONTAL : ScrollBarDirection.VERTICAL;
      this.dataset.direction = this._direction;
      this.invalidate(InvalidationType.SIZE);
    }
  }

  configUI() {
    super.configUI();
    this.dataset.direction = this._direction;
    this.innerHTML =
      '<div class="ts-track"></div>' +
      '<div class="ts-thumb"></div>' +
      '<div class="ts-arrow ts-arrow-up"></div>' +
      '<div class="ts-arrow ts-arrow-down"></div>';
    this._trackEl = this.querySelector('.ts-track');
    this._thumbEl = this.querySelector('.ts-thumb');
    this._arrowUpEl = this.querySelector('.ts-arrow-up');
    this._arrowDownEl = this.querySelector('.ts-arrow-down');

    // 箭头自动重复点击（对齐 AS3：upArrow.autoRepeat = true）
    this._bindRepeat(this._arrowUpEl, () => this.scrollPosition -= this._lineScrollSize);
    this._bindRepeat(this._arrowDownEl, () => this.scrollPosition += this._lineScrollSize);

    // 点击轨道翻页（对齐 AS3 scrollPressHandler）
    this._trackEl.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const step = this._pageScrollSize || this._pageSize;
      const at = this._isVertical() ? e.clientY : e.clientX;
      if (at < this._thumbViewPos()) this.scrollPosition -= step;
      else this.scrollPosition += step;
      // 按住轨道持续翻页（对齐 AS3 scrollPressHandler 的 autoRepeat 语义）
      this._stopRepeat();
      const tick = () => {
        const a = this._isVertical() ? this.lastPointerY : this.lastPointerX;
        if (a < this._thumbViewPos()) this.scrollPosition -= step;
        else this.scrollPosition += step;
        this._repeatToken = setTimeout(tick, this.repeatInterval || 35);
      };
      this._repeatToken = setTimeout(tick, this.repeatDelay || 500);
      // 指针捕获用于在按住轨道期间稳定接收 mouseup（合成 MouseEvent 无活动指针，
      // setPointerCapture 会抛 NotFoundError —— 防御式调用，失败不阻断翻页）
      if (e.pointerId != null) {
        try { this._trackEl.setPointerCapture(e.pointerId); } catch (_) { /* 无活动指针，忽略 */ }
      }
    });
    // window 级指针位置/松开监听：实例级绑定一次，断开连接时移除（避免面板反复
    // render 重建滚动条导致 window 监听器累积泄漏）
    this._onWinMove = (e) => {
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
    };
    this._onWinUp = () => this._stopRepeat();
    window.addEventListener('mousemove', this._onWinMove);
    window.addEventListener('mouseup', this._onWinUp);

    // 拖拽滑块（对齐 AS3 thumbPressHandler / handleThumbDrag）
    this._thumbEl.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      this._inDrag = true;
      this._dragOffset = (this._isVertical() ? e.clientY : e.clientX) - this._thumbPos();
      this._thumbEl.dataset.mouseState = 'down';
      const onMove = (ev) => {
        const at = this._isVertical() ? ev.clientY : ev.clientX;
        const span = this._trackSpan() - this._thumbSize();
        const ratio = span > 0 ? (at - this._dragOffset) / span : 0;
        let pos = this._minScrollPosition + ratio * (this._maxScrollPosition - this._minScrollPosition);
        this.scrollPosition = pos;
      };
      const onUp = () => {
        this._inDrag = false;
        this._thumbEl.dataset.mouseState = 'up';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this._dragMove = this._dragUp = null;
      };
      this._dragMove = onMove;
      this._dragUp = onUp;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 滚轮（AS3 中由 TextArea/ScrollPane 处理 wheel，这里一并在滚动条上支持）
    this.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.scrollPosition -= e.deltaY * this._lineScrollSize;
    });
  }

  disconnectedCallback() {
    // 移除 window 级监听，防止面板反复重建滚动条时累积泄漏
    if (this._onWinMove) window.removeEventListener('mousemove', this._onWinMove);
    if (this._onWinUp) window.removeEventListener('mouseup', this._onWinUp);
    if (this._dragMove) window.removeEventListener('mousemove', this._dragMove);
    if (this._dragUp) window.removeEventListener('mouseup', this._dragUp);
    this._stopRepeat();
  }

  // ---- 属性 -------------------------------------------------------------
  get direction() {
    return this._direction;
  }

  set direction(value) {
    if (value === this._direction) return;
    this._direction = value;
    this.dataset.direction = value;
    this.invalidate(InvalidationType.SIZE);
  }

  get pageSize() {
    return this._pageSize;
  }

  get minScrollPosition() {
    return this._minScrollPosition;
  }

  set minScrollPosition(value) {
    this._minScrollPosition = value;
    this.invalidate(InvalidationType.SIZE);
  }

  get maxScrollPosition() {
    return this._maxScrollPosition;
  }

  set maxScrollPosition(value) {
    this._maxScrollPosition = value;
    this.invalidate(InvalidationType.SIZE);
  }

  get scrollPosition() {
    return this._scrollPosition;
  }

  set scrollPosition(value) {
    this.setScrollPosition(value);
  }

  get lineScrollSize() {
    return this._lineScrollSize;
  }

  set lineScrollSize(value) {
    this._lineScrollSize = value;
  }

  get pageScrollSize() {
    return this._pageScrollSize;
  }

  set pageScrollSize(value) {
    this._pageScrollSize = value;
  }

  // 自动重复时延（对齐 AS3 样式 repeatDelay / repeatInterval）
  get repeatDelay() {
    return this.getStyleValue('repeatDelay') || 500;
  }

  get repeatInterval() {
    return this.getStyleValue('repeatInterval') || 35;
  }

  /**
   * 配置滚动范围（对齐 AS3 ScrollBar.setScrollProperties）。
   * @param pageSize 一页尺寸（决定滑块长度）
   * @param minScrollPosition 最小位置
   * @param maxScrollPosition 最大位置
   * @param pageScrollSize 点击轨道时的翻页量（0 表示用 pageSize）
   */
  setScrollProperties(pageSize, minScrollPosition, maxScrollPosition, pageScrollSize = 0) {
    this._pageSize = Math.max(0, pageSize);
    this._minScrollPosition = minScrollPosition;
    this._maxScrollPosition = maxScrollPosition;
    this._pageScrollSize = pageScrollSize || 0;
    this.invalidate(InvalidationType.SIZE);
  }

  /**
   * 设置滚动位置（对齐 AS3 setScrollPosition，派发 ScrollEvent）。
   */
  setScrollPosition(value, dispatchEvent = true) {
    const min = this._minScrollPosition;
    const max = this._maxScrollPosition;
    let pos = value;
    if (isNaN(pos)) pos = min;
    pos = Math.min(max, Math.max(min, pos));
    if (pos === this._scrollPosition) {
      // 即便位置没变，也确保滑块位置同步
      this._updateThumb();
      return;
    }
    const delta = pos - this._scrollPosition;
    this._scrollPosition = pos;
    this._updateThumb();
    if (dispatchEvent) {
      this.dispatchEvent(new ScrollEvent(this._direction, delta, pos, false));
    }
  }

  // ---- 重绘 -------------------------------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.updateThumb();
    }
    super.draw(invalidHash);
  }

  /**
   * 重算滑块尺寸与位置（对齐 AS3 ScrollBar.updateThumb）。
   */
  updateThumb() {
    this._updateThumb();
  }

  _isVertical() {
    return this._direction === ScrollBarDirection.VERTICAL;
  }

  // 轨道可用长度（扣除两端箭头）
  _trackSpan() {
    const size = this._isVertical() ? this.height : this.width;
    return Math.max(0, size - SCROLL_BAR_WIDTH * 2);
  }

  // 滑块尺寸（对齐 AS3：max(13, pageSize/(max-min+pageSize) * trackHeight)）
  _thumbSize() {
    const range = this._maxScrollPosition - this._minScrollPosition + this._pageSize;
    if (range <= 0) return MIN_THUMB_SIZE;
    return Math.max(MIN_THUMB_SIZE, Math.round((this._pageSize / range) * this._trackSpan()));
  }

  // 滑块距轨道起边的像素位置
  _thumbPos() {
    const track = this._trackEl;
    const rect = track.getBoundingClientRect();
    const thumbRect = this._thumbEl.getBoundingClientRect();
    return this._isVertical() ? thumbRect.top - rect.top : thumbRect.left - rect.left;
  }

  // 滑块起边在视口中的坐标（点击轨道时判断点在滑块上方/下方）
  _thumbViewPos() {
    const rect = this._trackEl.getBoundingClientRect();
    return (this._isVertical() ? rect.top : rect.left) + this._thumbPos();
  }

  _thumbStart() {
    return this._thumbPos();
  }

  _updateThumb() {
    if (!this._thumbEl || !this.isConnected) return;
    const vertical = this._isVertical();
    const size = this._thumbSize();
    const span = this._trackSpan() - size;
    const range = this._maxScrollPosition - this._minScrollPosition;
    const ratio = range > 0 ? (this._scrollPosition - this._minScrollPosition) / range : 0;
    const offset = Math.round(Math.min(span, Math.max(0, ratio * span)));
    // 滑块与轨道同级，轨道两端内缩 SCROLL_BAR_WIDTH 给箭头让位，
    // 故滑块坐标需叠加该内缩量：最上方时不压上箭头、最下方时贴住下箭头
    const pos = SCROLL_BAR_WIDTH + offset;
    if (vertical) {
      this._thumbEl.style.height = size + 'px';
      this._thumbEl.style.top = pos + 'px';
      this._thumbEl.style.left = '';
      this._thumbEl.style.width = '';
    } else {
      this._thumbEl.style.width = size + 'px';
      this._thumbEl.style.left = pos + 'px';
      this._thumbEl.style.top = '';
      this._thumbEl.style.height = '';
    }
    // 滑块始终显示（用户要求「默认不隐藏」，2026-10-03）：
    // 范围不足以滚动时滑块按公式占满整条轨道，看起来是完整的木质条而非空轨道；
    // 拖拽/点击此时无效（span=0），但视觉上不再缺一块。AS3 原版会隐藏滑块，此处有意偏离
    this._thumbEl.style.visibility = 'visible';
  }

  // ---- 自动重复工具（对齐 AS3 BaseButton.pressTimer）--------------------
  _bindRepeat(el, action) {
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      action();
      this._stopRepeat();
      const tick = () => {
        action();
        this._repeatToken = setTimeout(tick, this.repeatInterval || 35);
      };
      this._repeatToken = setTimeout(tick, this.repeatDelay || 500);
    });
  }

  _stopRepeat() {
    if (this._repeatToken) {
      clearTimeout(this._repeatToken);
      this._repeatToken = 0;
    }
  }
}

customElements.define('ts-scrollbar', TsScrollBar);

/**
 * 绑定到目标元素的滚动条（对齐 fl.controls.UIScrollBar）。
 * 目标可以是 <textarea> 或任意可滚动元素（有 scrollTop/scrollHeight）。
 *
 * 双向同步：
 *   - 目标滚动 → 同步滑块位置（对齐 AS3 handleTargetScroll）
 *   - 滑块拖动/点击 → 写回目标 scrollTop/scrollLeft（对齐 AS3 updateTargetScroll）
 */
export class TsUIScrollBar extends TsScrollBar {
  constructor() {
    super();
    this._scrollTarget = null;
    this._inEdit = false;
  }

  get scrollTarget() {
    return this._scrollTarget;
  }

  set scrollTarget(target) {
    if (this._scrollTarget) {
      this._scrollTarget.removeEventListener('scroll', this._onTargetScroll);
      this._scrollTarget.removeEventListener('input', this._onTargetChange);
    }
    this._scrollTarget = target;
    if (this._scrollTarget) {
      this._onTargetScroll = () => this.handleTargetScroll();
      this._onTargetChange = () => this.handleTargetChange();
      this._scrollTarget.addEventListener('scroll', this._onTargetScroll);
      this._scrollTarget.addEventListener('input', this._onTargetChange);
    }
    this.invalidate(InvalidationType.DATA);
  }

  draw(invalidHash) {
    if (invalidHash[InvalidationType.DATA]) {
      this.updateScrollTargetProperties();
    }
    super.draw(invalidHash);
  }

  // 对齐 AS3 UIScrollBar.updateScrollTargetProperties
  updateScrollTargetProperties() {
    const t = this._scrollTarget;
    if (!t) {
      this.setScrollProperties(this.pageSize, this.minScrollPosition, this.maxScrollPosition, this.pageScrollSize);
      return;
    }
    if (this._isVertical()) {
      this.setScrollProperties(t.clientHeight, 0, Math.max(0, t.scrollHeight - t.clientHeight), t.clientHeight);
      this.setScrollPosition(t.scrollTop, false);
    } else {
      this.setScrollProperties(t.clientWidth, 0, Math.max(0, t.scrollWidth - t.clientWidth), t.clientWidth);
      this.setScrollPosition(t.scrollLeft, false);
    }
  }

  // 对齐 AS3 UIScrollBar.handleTargetScroll（目标滚动 → 同步滑块，拖拽中跳过）
  handleTargetScroll() {
    if (this._inDrag || !this.enabled) return;
    this._inEdit = true;
    this.updateScrollTargetProperties();
    this.scrollPosition = this._isVertical() ? this._scrollTarget.scrollTop : this._scrollTarget.scrollLeft;
    this._inEdit = false;
  }

  // 对齐 AS3 UIScrollBar.handleTargetChange（内容变化 → 重算范围）
  handleTargetChange() {
    this._inEdit = true;
    this.updateScrollTargetProperties();
    this._inEdit = false;
  }

  setScrollPosition(value, dispatchEvent = true) {
    super.setScrollPosition(value, dispatchEvent);
    if (this._scrollTarget && !this._inEdit) {
      this.updateTargetScroll();
    }
  }

  // 对齐 AS3 UIScrollBar.updateTargetScroll
  updateTargetScroll() {
    if (!this._scrollTarget) return;
    if (this._isVertical()) this._scrollTarget.scrollTop = this.scrollPosition;
    else this._scrollTarget.scrollLeft = this.scrollPosition;
  }

  update() {
    this._inEdit = true;
    this.updateScrollTargetProperties();
    this._inEdit = false;
  }
}

customElements.define('ts-uiscrollbar', TsUIScrollBar);

export default TsScrollBar;
