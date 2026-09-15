// ts-textinput.js — 单行文本输入
// 移植自：fl.controls.TextInput（DefaultComponent.swf）
//
// 属性：text/value/htmlText（单行不支持富文本，htmlText 等价 text）
//       editable / restrict / maxChars / displayAsPassword / alwaysShowSelection
// 方法：appendText / setSelection / getLineMetrics（单行只有一行）
// 事件：change（内容变化）、enter（回车，对齐 ComponentEvent.ENTER）、textInput
//
// 自定义元素：<ts-textinput>

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
  escapeHtml,
} from './ts-base.js?v=20261007c';

export class TsTextInput extends UIComponent {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'value',
      'text',
      'editable',
      'max-chars',
      'restrict',
      'display-as-password',
      'placeholder',
    ];
  }

  // 对齐 fl.controls.TextInput.defaultStyles
  static defaultStyles = {
    upSkin: 'TextInput_upSkin',
    disabledSkin: 'TextInput_disabledSkin',
    focusRectSkin: null,
    focusRectPadding: null,
    textFormat: null,
    disabledTextFormat: null,
    textPadding: 0,
    embedFonts: null,
    textWidth: 100,
    textHeight: 22,
  };

  constructor() {
    super();
    this._text = '';
    this._editable = true;
    this._maxChars = 0;
    this._restrict = null;
    this._displayAsPassword = false;
    this._html = false;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'value':
      case 'text':
        this.text = newValue == null ? '' : String(newValue);
        break;
      case 'editable':
        this._editable = this.hasAttribute('editable');
        this.invalidate(InvalidationType.STATE);
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
    this.innerHTML = '<div class="ts-bg"></div><input class="ts-field" type="text">';
    this._bgEl = this.querySelector('.ts-bg');
    this._fieldEl = this.querySelector('.ts-field');
    // 回填挂载前暂存的 text（先 createElement 设属性、后 appendChild 的场景）
    this._fieldEl.value = this._text;
    this._fieldEl.addEventListener('input', (e) => this._handleChange(e));
    this._fieldEl.addEventListener('keydown', (e) => this._handleKeyDown(e));
    this._fieldEl.addEventListener('focus', () => this.focusInHandler());
    this._fieldEl.addEventListener('blur', () => this.focusOutHandler());
  }

  // ---- 属性 -------------------------------------------------------------
  get text() {
    return this._fieldEl ? this._fieldEl.value : this._text;
  }

  set text(value) {
    const v = value == null ? '' : String(value);
    this._text = v;
    this._html = false;
    if (this._fieldEl && this._fieldEl.value !== v) this._fieldEl.value = v;
    this.invalidate(InvalidationType.DATA);
    this.invalidate(InvalidationType.STYLES);
  }

  // value 是 text 的别名，方便表单场景
  get value() {
    return this.text;
  }

  set value(v) {
    this.text = v;
  }

  // 单行输入不支持富文本，htmlText 与 text 等价（对齐 AS3 的 htmlText 行为降级）
  get htmlText() {
    return this.text;
  }

  set htmlText(v) {
    this.text = v;
  }

  get editable() {
    return this._editable;
  }

  set editable(value) {
    this._editable = !!value;
    this.toggleAttribute('editable', this._editable);
    this.invalidate(InvalidationType.STATE);
  }

  get restrict() {
    return this._restrict;
  }

  set restrict(value) {
    this._restrict = value;
    this.invalidate(InvalidationType.STATE);
  }

  get maxChars() {
    return this._maxChars;
  }

  set maxChars(value) {
    this._maxChars = Math.max(0, value | 0);
    this.invalidate(InvalidationType.STATE);
  }

  get displayAsPassword() {
    return this._displayAsPassword;
  }

  set displayAsPassword(value) {
    this._displayAsPassword = !!value;
    this.toggleAttribute('display-as-password', this._displayAsPassword);
    this.invalidate(InvalidationType.STATE);
  }

  get length() {
    return this.text.length;
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
    return this._fieldEl ? this._fieldEl.offsetHeight : 0;
  }

  // ---- 方法（对齐 AS3 TextInput）-----------------------------------------
  appendText(newText) {
    this.text = this.text + String(newText == null ? '' : newText);
  }

  setSelection(beginIndex, endIndex) {
    if (this._fieldEl) {
      try {
        this._fieldEl.setSelectionRange(beginIndex, endIndex);
      } catch (e) {
        // 非 type=text 时浏览器不支持，忽略
      }
    }
  }

  getLineMetrics(index) {
    // 单行组件只有第 0 行
    return { ascent: 9, descent: 2, height: 12, leading: 0, width: this.textWidth, x: 0 };
  }

  // ---- 重绘 -------------------------------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.STATE] || invalidHash[InvalidationType.ALL]) {
      this.updateTextFieldType();
    }
    if (invalidHash[InvalidationType.STYLES] || invalidHash[InvalidationType.ALL]) {
      this.drawTextFormat();
    }
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.drawLayout();
    }
    super.draw(invalidHash);
  }

  // 对齐 AS3 TextInput.updateTextFieldType
  updateTextFieldType() {
    const f = this._fieldEl;
    if (!f) return;
    f.readOnly = !(this.enabled && this._editable);
    f.disabled = !this.enabled;
    f.type = this._displayAsPassword ? 'password' : 'text';
    // ⚠ 无限制时必须移除属性：maxLength=0 在浏览器里表示「最多 0 个字符」，
    // 会拒绝所有键盘输入（程序化 .value 赋值不受限，极易漏测）；
    // 规范的无限制值是 -1，但部分严格 DOM 环境（jsdom）对 -1 抛 IndexSizeError
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
    } else {
      f.style.fontFamily = '';
      f.style.fontSize = '';
      f.style.color = '';
      f.style.fontWeight = '';
    }
  }

  drawLayout() {
    // 对齐 AS3 TextInput.drawLayout：内边距 textPadding，输入框占满
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    const f = this._fieldEl;
    if (!f) return;
    f.style.left = padding + 'px';
    f.style.top = padding + 'px';
    f.style.width = Math.max(0, this.width - padding * 2) + 'px';
    f.style.height = Math.max(0, this.height - padding * 2) + 'px';
  }

  // ---- 事件处理 ---------------------------------------------------------
  _handleChange(e) {
    this._text = this._fieldEl.value;
    // 对齐 AS3：stopPropagation + 冒泡 CHANGE
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
    this.invalidate(InvalidationType.DATA);
  }

  _handleKeyDown(e) {
    if (e.key === 'Enter') {
      // 对齐 AS3 TextInput.handleKeyDown：派发 ComponentEvent.ENTER
      this.dispatchEvent(new ComponentEvent(ComponentEvent.ENTER, true));
    }
  }

  // 供外部把焦点转给内部输入框（对齐 AS3 focusInHandler 把 stage.focus 给 textField）
  focus() {
    if (this._fieldEl) this._fieldEl.focus();
  }

  select() {
    if (this._fieldEl) this._fieldEl.select();
  }
}

customElements.define('ts-textinput', TsTextInput);

/**
 * 把 AS3 restrict 语法转成正则字符串（用于 input.pattern）。
 * 支持：'0-9'、'a-zA-Z'、'^0-9'（取反）、'0-9._-' 等。
 */
function restrictToPattern(restrict) {
  let s = String(restrict);
  if (!s) return '';
  let negate = false;
  if (s.charAt(0) === '^') {
    negate = true;
    s = s.slice(1);
  }
  // 转义字符类里的特殊字符
  s = s.replace(/[\\\]]/g, '\\$&');
  return negate ? '^[^' + s + ']*$' : '^[' + s + ']*$';
}

export { restrictToPattern, escapeHtml };
export default TsTextInput;
