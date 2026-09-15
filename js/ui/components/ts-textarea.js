// ts-textarea.js — 多行文本域
// 移植自：fl.controls.TextArea（DefaultComponent.swf）
//
// 属性：text / htmlText（富文本只读渲染）/ editable / wordWrap
//       verticalScrollPolicy / horizontalScrollPolicy（on|auto|off）
//       maxChars / restrict / displayAsPassword / condenseWhite
//       verticalScrollPosition / horizontalScrollPosition / maxVerticalScrollPosition
// 方法：appendText / setSelection / getLineMetrics
// 事件：change / enter / scroll（ScrollEvent）/ textInput
//
// 内置两条 ts-uiscrollbar（对齐 AS3 中的 _verticalScrollBar/_horizontalScrollBar，
// 默认 ScrollPolicy.AUTO，按内容是否溢出自动显隐）。
//
// 自定义元素：<ts-textarea>

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
  ScrollEvent,
  ScrollPolicy,
  ScrollBarDirection,
  escapeHtml,
} from './ts-base.js?v=20261007c';
import { TsUIScrollBar } from './ts-scrollbar.js?v=20261007c';
import { restrictToPattern } from './ts-textinput.js?v=20261007c';

// TextArea.drawLayout 中滚动条占用的宽度（= ts-scrollbar.js SCROLL_BAR_WIDTH）
const SCROLL_BAR_WIDTH = 17;

export class TsTextArea extends UIComponent {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'text',
      'html-text',
      'editable',
      'word-wrap',
      'vertical-scroll-policy',
      'horizontal-scroll-policy',
      'max-chars',
      'restrict',
      'display-as-password',
      'placeholder',
    ];
  }

  // 对齐 fl.controls.TextArea.defaultStyles
  static defaultStyles = {
    upSkin: 'TextArea_upSkin',
    disabledSkin: 'TextArea_disabledSkin',
    focusRectSkin: null,
    focusRectPadding: null,
    textFormat: null,
    disabledTextFormat: null,
    textPadding: 3,
    embedFonts: false,
  };

  constructor() {
    super();
    this._html = false;
    this._savedHTML = '';
    this._text = '';
    this._editable = true;
    this._wordWrap = true;
    this._verticalScrollPolicy = ScrollPolicy.AUTO;
    this._horizontalScrollPolicy = ScrollPolicy.AUTO;
    this._maxChars = 0;
    this._restrict = null;
    this._displayAsPassword = false;
    this._condenseWhite = false;
    this._textHasChanged = false;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'text':
        this.text = newValue == null ? '' : String(newValue);
        break;
      case 'html-text':
        if (newValue != null) this.htmlText = newValue;
        break;
      case 'editable':
        this._editable = this.hasAttribute('editable');
        this.invalidate(InvalidationType.STATE);
        break;
      case 'word-wrap':
        this._wordWrap = this.hasAttribute('word-wrap');
        this.invalidate(InvalidationType.STATE);
        break;
      case 'vertical-scroll-policy':
        this._verticalScrollPolicy = normalizeScrollPolicy(newValue);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'horizontal-scroll-policy':
        this._horizontalScrollPolicy = normalizeScrollPolicy(newValue);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'max-chars':
        this._maxChars = Math.max(0, parseInt(newValue, 10) || 0);
        this.invalidate(InvalidationType.STATE);
        break;
      case 'restrict':
        this._restrict = newValue;
        this.invalidate(InvalidationType.STATE);
        break;
      case 'display-as-password':
        this._displayAsPassword = this.hasAttribute('display-as-password');
        this.invalidate(InvalidationType.STATE);
        break;
      case 'placeholder':
        this.invalidate(InvalidationType.STATE);
        break;
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<div class="ts-text-edit"><textarea class="ts-field"></textarea></div>' +
      '<div class="ts-text-html"></div>' +
      '<ts-uiscrollbar class="ts-v-scroll" direction="vertical"></ts-uiscrollbar>' +
      '<ts-uiscrollbar class="ts-h-scroll" direction="horizontal"></ts-uiscrollbar>';
    this._bgEl = this.querySelector('.ts-bg');
    this._editWrapEl = this.querySelector('.ts-text-edit');
    this._fieldEl = this.querySelector('textarea.ts-field');
    this._htmlEl = this.querySelector('.ts-text-html');
    // 回填挂载前暂存的 text
    this._fieldEl.value = this._text;
    this._vScroll = this.querySelector('.ts-v-scroll');
    this._hScroll = this.querySelector('.ts-h-scroll');

    this._fieldEl.addEventListener('input', (e) => this._handleChange(e));
    this._fieldEl.addEventListener('keydown', (e) => this._handleKeyDown(e));
    this._fieldEl.addEventListener('scroll', () => this._syncScrollFromTarget());
    this._fieldEl.addEventListener('focus', () => this.focusInHandler());
    this._fieldEl.addEventListener('blur', () => this.focusOutHandler());

    this._vScroll.scrollTarget = this._fieldEl;
    this._hScroll.scrollTarget = this._fieldEl;
    // 滚动联动事件（对齐 AS3 TextArea.handleScroll 直接转发 ScrollEvent）
    this._vScroll.addEventListener('scroll', (e) => this._handleScroll(e));
    this._hScroll.addEventListener('scroll', (e) => this._handleScroll(e));
  }

  // ---- 属性 -------------------------------------------------------------
  get text() {
    if (this._html) return this._savedHTML;
    if (this._fieldEl) return this._fieldEl.value;
    return this._text;
  }

  set text(value) {
    const v = value == null ? '' : String(value);
    this._text = v;
    this._html = false;
    if (this._fieldEl) this._fieldEl.value = v;
    this.invalidate(InvalidationType.DATA);
    this.invalidate(InvalidationType.STYLES);
    this._textHasChanged = true;
  }

  get htmlText() {
    return this._html ? this._savedHTML : this.text;
  }

  set htmlText(value) {
    if (value == null || value === '') {
      this.text = '';
      return;
    }
    this._html = true;
    this._savedHTML = String(value);
    this.invalidate(InvalidationType.DATA);
    this.invalidate(InvalidationType.STYLES);
    this._textHasChanged = true;
  }

  get editable() {
    return this._editable;
  }

  set editable(value) {
    this._editable = !!value;
    this.toggleAttribute('editable', this._editable);
    this.invalidate(InvalidationType.STATE);
  }

  get wordWrap() {
    return this._wordWrap;
  }

  set wordWrap(value) {
    this._wordWrap = !!value;
    this.toggleAttribute('word-wrap', this._wordWrap);
    this.invalidate(InvalidationType.STATE);
  }

  get verticalScrollPolicy() {
    return this._verticalScrollPolicy;
  }

  set verticalScrollPolicy(value) {
    this._verticalScrollPolicy = normalizeScrollPolicy(value);
    this.setAttribute('vertical-scroll-policy', this._verticalScrollPolicy);
    this.invalidate(InvalidationType.SIZE);
  }

  get horizontalScrollPolicy() {
    return this._horizontalScrollPolicy;
  }

  set horizontalScrollPolicy(value) {
    this._horizontalScrollPolicy = normalizeScrollPolicy(value);
    this.setAttribute('horizontal-scroll-policy', this._horizontalScrollPolicy);
    this.invalidate(InvalidationType.SIZE);
  }

  get maxChars() {
    return this._maxChars;
  }

  set maxChars(value) {
    this._maxChars = Math.max(0, value | 0);
    this.invalidate(InvalidationType.STATE);
  }

  get restrict() {
    return this._restrict;
  }

  set restrict(value) {
    this._restrict = value;
    this.invalidate(InvalidationType.STATE);
  }

  get displayAsPassword() {
    return this._displayAsPassword;
  }

  set displayAsPassword(value) {
    this._displayAsPassword = !!value;
    this.invalidate(InvalidationType.STATE);
  }

  get condenseWhite() {
    return this._condenseWhite;
  }

  set condenseWhite(value) {
    this._condenseWhite = !!value;
    this.invalidate(InvalidationType.DATA);
  }

  get length() {
    return this.text.length;
  }

  get verticalScrollPosition() {
    return this._fieldEl ? this._fieldEl.scrollTop : 0;
  }

  set verticalScrollPosition(value) {
    this.drawNow();
    if (this._fieldEl) this._fieldEl.scrollTop = value;
  }

  get horizontalScrollPosition() {
    return this._fieldEl ? this._fieldEl.scrollLeft : 0;
  }

  set horizontalScrollPosition(value) {
    this.drawNow();
    if (this._fieldEl) this._fieldEl.scrollLeft = value;
  }

  get maxVerticalScrollPosition() {
    this.drawNow();
    if (!this._fieldEl) return 0;
    return Math.max(0, this._fieldEl.scrollHeight - this._fieldEl.clientHeight);
  }

  get maxHorizontalScrollPosition() {
    this.drawNow();
    if (!this._fieldEl) return 0;
    return Math.max(0, this._fieldEl.scrollWidth - this._fieldEl.clientWidth);
  }

  get selectionBeginIndex() {
    return this._fieldEl ? this._fieldEl.selectionStart : 0;
  }

  get selectionEndIndex() {
    return this._fieldEl ? this._fieldEl.selectionEnd : 0;
  }

  get textWidth() {
    this.drawNow();
    return this._fieldEl ? this._fieldEl.scrollWidth : 0;
  }

  get textHeight() {
    this.drawNow();
    return this._fieldEl ? this._fieldEl.scrollHeight : 0;
  }

  // ---- 方法 -------------------------------------------------------------
  appendText(newText) {
    if (this._html) {
      // 富文本模式追加纯文本（转义后追加）
      this.htmlText = this._savedHTML + escapeHtml(newText);
      return;
    }
    this.text = this.text + String(newText == null ? '' : newText);
  }

  setSelection(beginIndex, endIndex) {
    if (this._fieldEl) {
      try {
        this._fieldEl.setSelectionRange(beginIndex, endIndex);
      } catch (e) {}
    }
  }

  getLineMetrics(index) {
    this.drawNow();
    // 浏览器无法精确给出行度量，返回近似值（行高 = font-size * line-height）
    const lh = parseFloat(getComputedStyle(this._fieldEl).lineHeight) || 16;
    return {
      ascent: lh * 0.75,
      descent: lh * 0.25,
      height: lh,
      leading: 0,
      width: this.textWidth,
      x: 0,
    };
  }

  // ---- 重绘（对齐 AS3 TextArea.draw）-------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.STATE] || invalidHash[InvalidationType.ALL]) {
      this.updateTextFieldType();
    }
    if (invalidHash[InvalidationType.STYLES] || invalidHash[InvalidationType.ALL]) {
      this.drawTextFormat();
    }
    if (
      invalidHash[InvalidationType.SIZE] ||
      invalidHash[InvalidationType.DATA] ||
      invalidHash[InvalidationType.ALL]
    ) {
      this.drawLayout();
    }
    super.draw(invalidHash);
  }

  // 对齐 AS3 TextArea.updateTextFieldType
  updateTextFieldType() {
    const f = this._fieldEl;
    if (!f) return;
    f.readOnly = !(this.enabled && this._editable);
    f.disabled = !this.enabled;
    f.wrap = this._wordWrap ? 'soft' : 'off';
    // htmlText 富文本模式：只读渲染
    if (this._html) {
      this._htmlEl.innerHTML = this._condenseWhite
        ? this._savedHTML.replace(/>\s+</g, '><')
        : this._savedHTML;
      this._editWrapEl.style.display = 'none';
      this._htmlEl.style.display = '';
      this._htmlEl.style.pointerEvents = this._editable ? '' : 'none';
      // 富文本滚动也交给 fieldEl 同步：把纯文本写一份进去以便滚动度量
      f.value = this._htmlEl.textContent;
    } else {
      this._editWrapEl.style.display = '';
      this._htmlEl.style.display = 'none';
    }
    // ⚠ 无限制时移除属性：maxLength=0 在浏览器里表示「最多 0 个字符」，
    // 会拒绝所有键盘输入（程序化 .value 赋值不受限，极易漏测）
    if (this._maxChars > 0) f.maxLength = this._maxChars;
    else f.removeAttribute('maxlength');
    if (this._restrict) f.pattern = restrictToPattern(this._restrict);
    else f.removeAttribute('pattern');
    const ph = this.getAttribute('placeholder');
    if (ph != null) f.placeholder = ph;
  }

  drawTextFormat() {
    const tf = this.enabled
      ? this.getStyleValue('textFormat')
      : this.getStyleValue('disabledTextFormat');
    const f = this._fieldEl;
    if (!f) return;
    if (tf) {
      if (tf.font) f.style.fontFamily = tf.font;
      if (tf.size) f.style.fontSize = tf.size + 'px';
      if (tf.color != null) f.style.color = '#' + Number(tf.color).toString(16).padStart(6, '0');
      if (tf.bold != null) f.style.fontWeight = tf.bold ? '700' : '400';
    }
    if (this._html) {
      // 富文本样式同步给渲染层
      this._htmlEl.style.cssText = this._htmlEl.style.cssText.replace(/font[^;]*;?/g, '');
      if (tf) {
        if (tf.font) this._htmlEl.style.fontFamily = tf.font;
        if (tf.size) this._htmlEl.style.fontSize = tf.size + 'px';
        if (tf.color != null) this._htmlEl.style.color = '#' + Number(tf.color).toString(16).padStart(6, '0');
      }
      // 重新渲染（drawTextFormat 后 htmlText 需要重绘，对齐 AS3 drawTextFormat 末尾逻辑）
      this._htmlEl.innerHTML = this._condenseWhite
        ? this._savedHTML.replace(/>\s+</g, '><')
        : this._savedHTML;
    }
  }

  // 对齐 AS3 TextArea.drawLayout：textPadding 内边距 + 按策略显隐滚动条
  drawLayout() {
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    const f = this._fieldEl;
    if (!f) return;
    this._editWrapEl.style.left = this._editWrapEl.style.top = padding + 'px';
    this._htmlEl.style.left = this._htmlEl.style.top = padding + 'px';

    const needV = this.needVScroll();
    let availW = this.width - (needV ? SCROLL_BAR_WIDTH : 0);
    const needH = this.needHScroll(availW);
    let availH = this.height - (needH ? SCROLL_BAR_WIDTH : 0);
    if (needH && !needV && this.needVScroll()) {
      // 对齐 AS3：出现横向滚动条后可能又需要纵向
      availW -= SCROLL_BAR_WIDTH;
    }

    f.style.width = Math.max(0, availW - padding * 2) + 'px';
    f.style.height = Math.max(0, availH - padding * 2) + 'px';
    this._htmlEl.style.width = Math.max(0, availW - padding * 2) + 'px';
    this._htmlEl.style.height = Math.max(0, availH - padding * 2) + 'px';
    f.style.overflow = 'hidden';

    // 纵向滚动条
    if (needV) {
      this._vScroll.style.display = '';
      this._vScroll.style.left = this.width - SCROLL_BAR_WIDTH + 'px';
      this._vScroll.style.top = '0px';
      this._vScroll.style.width = SCROLL_BAR_WIDTH + 'px';
      this._vScroll.style.height = availH + 'px';
      this._vScroll.update();
    } else {
      this._vScroll.style.display = 'none';
    }
    // 横向滚动条
    if (needH) {
      this._hScroll.style.display = '';
      this._hScroll.style.left = '0px';
      this._hScroll.style.top = this.height - SCROLL_BAR_WIDTH + 'px';
      this._hScroll.style.width = availW + 'px';
      this._hScroll.style.height = SCROLL_BAR_WIDTH + 'px';
      this._hScroll.update();
    } else {
      this._hScroll.style.display = 'none';
    }
  }

  // 对齐 AS3 TextArea.needVScroll / needHScroll
  needVScroll() {
    if (this._verticalScrollPolicy === ScrollPolicy.OFF) return false;
    if (this._verticalScrollPolicy === ScrollPolicy.ON) return true;
    return this.maxVerticalScrollPosition > 1;
  }

  needHScroll(availWidth) {
    if (this._horizontalScrollPolicy === ScrollPolicy.OFF) return false;
    if (this._horizontalScrollPolicy === ScrollPolicy.ON) return true;
    if (this._wordWrap) return false; // 自动换行时不需要横向滚动
    return this.maxHorizontalScrollPosition > 0;
  }

  // ---- 事件 -------------------------------------------------------------
  _handleChange(e) {
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
    this.invalidate(InvalidationType.DATA);
    this._textHasChanged = true;
    // 内容变化后重算滚动条（对齐 AS3 的 delayedLayoutUpdate）
    this.callLater(() => this.drawLayout());
  }

  _handleKeyDown(e) {
    if (e.key === 'Enter') {
      // 对齐 AS3 TextArea.handleKeyDown
      this.dispatchEvent(new ComponentEvent(ComponentEvent.ENTER, true));
    }
  }

  _handleScroll(e) {
    // 对齐 AS3 TextArea.handleScroll：转发 ScrollEvent。
    // ⚠ 事件正在派发中，不能重投同一实例（InvalidStateError），必须 clone
    this.dispatchEvent(e.clone ? e.clone() : new ScrollEvent(e.detail.direction, e.detail.delta, e.detail.position));
  }

  _syncScrollFromTarget() {
    // textarea 原生滚动时同步滚动条（UIScrollBar 的 scroll 监听已处理大部分情况）
    this._vScroll.handleTargetScroll && this._vScroll.handleTargetScroll();
  }

  handleWheel(delta) {
    // 对齐 AS3 TextArea.handleWheel
    if (!this.enabled) return;
    this._fieldEl.scrollTop -= delta * (this._vScroll.lineScrollSize || 1);
    this.dispatchEvent(
      new ScrollEvent(ScrollBarDirection.VERTICAL, delta * (this._vScroll.lineScrollSize || 1), this._fieldEl.scrollTop, false)
    );
  }

  focus() {
    if (this._fieldEl) this._fieldEl.focus();
  }
}

function normalizeScrollPolicy(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'on' || v === 'off' || v === 'auto') return v;
  return ScrollPolicy.AUTO;
}

// 滚轮转发：AS3 中 TextArea 监听 MOUSE_WHEEL
function _wheelHandler(e) {
  const ta = e.target.closest ? e.target.closest('ts-textarea') : null;
  if (ta && ta instanceof TsTextArea) {
    ta.handleWheel(e.deltaY);
    e.preventDefault();
  }
}
document.addEventListener('wheel', _wheelHandler, { passive: false });

customElements.define('ts-textarea', TsTextArea);

export default TsTextArea;
