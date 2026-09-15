// ts-button.js — 按钮组件
// 移植自：fl.controls.BaseButton / fl.controls.LabelButton / fl.controls.Button
// （DefaultComponent.swf + UIComponent.swf）
//
// 皮肤状态机严格对齐 AS3：mouseState ∈ {up, over, down, disabled}，
// 选中态前缀 selected（selectedUpSkin / selectedOverSkin / ...），
// 全部由 data-mouse-state / data-selected 属性驱动 CSS（见 ts-components.css）。
//
// 自定义元素：<ts-button>

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
} from './ts-base.js?v=20261007c';

// 按钮标签相对图标的位置（fl.controls.ButtonLabelPlacement）
export const ButtonLabelPlacement = Object.freeze({
  BOTTOM: 'bottom',
  TOP: 'top',
  LEFT: 'left',
  RIGHT: 'right',
});

// 鼠标状态（fl.controls.BaseButton 的 mouseState 取值）
export const MouseState = Object.freeze({
  UP: 'up',
  OVER: 'over',
  DOWN: 'down',
  DISABLED: 'disabled',
});

/**
 * 按钮基类（对齐 fl.controls.BaseButton）。
 * 实现鼠标状态机、autoRepeat 重复点击、皮肤状态计算、点击/选中事件。
 *
 * 子类化层次：BaseButton → LabelButton（加文字/图标）→ Button（加 emphasized）
 */
export class TsBaseButton extends UIComponent {
  // 对齐 AS3 LabelButton.defaultStyles
  static defaultStyles = {
    upSkin: 'Button_upSkin',
    downSkin: 'Button_downSkin',
    overSkin: 'Button_overSkin',
    disabledSkin: 'Button_disabledSkin',
    selectedDisabledSkin: 'Button_selectedDisabledSkin',
    selectedUpSkin: 'Button_selectedUpSkin',
    selectedDownSkin: 'Button_selectedDownSkin',
    selectedOverSkin: 'Button_selectedOverSkin',
    textFormat: null,
    disabledTextFormat: null,
    textPadding: 5,
    embedFonts: null,
    // LabelButton 特有
    icon: null,
    label: 'Label',
    // Button 特有
    emphasizedSkin: 'Button_emphasizedSkin',
    emphasizedPadding: 2,
  };

  static get observedAttributes() {
    return [...super.observedAttributes, 'selected', 'auto-repeat'];
  }

  constructor() {
    super();
    this._mouseState = MouseState.UP;
    // 锁定状态（对齐 AS3 mouseStateLocked / unlockedMouseState）
    this.mouseStateLocked = false;
    this._unlockedMouseState = MouseState.UP;
    // 选中态
    this._selected = false;
    // 自动重复（对齐 AS3 pressTimer：repeatDelay=500, repeatInterval=35）
    this._autoRepeat = false;
    this.repeatDelay = 500;
    this.repeatInterval = 35;
    this._pressTimerToken = 0;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === 'selected') {
      this._selected = this.hasAttribute('selected');
      this.invalidate(InvalidationType.STATE);
      this.dispatchEvent(new ComponentEvent(ComponentEvent.LABEL_CHANGE, false));
    } else if (name === 'auto-repeat') {
      this._autoRepeat = this.hasAttribute('auto-repeat');
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    // 对齐 AS3 BaseButton.setupMouseEvents()
    this.addEventListener('mouseover', this._onRollOver);
    this.addEventListener('mousedown', this._onMouseDown);
    this.addEventListener('mouseup', this._onMouseUp);
    this.addEventListener('mouseleave', this._onRollOut);
    // stage 级别的 MOUSE_UP（对齐 AS3 在 stage 上监听 MOUSE_UP）
    this._stageMouseUp = (e) => this._onMouseUp(e);
    this.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this._onMouseDown({ preventDefault() {} });
      }
    });
    this.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        this._onMouseUp();
      }
    });
  }

  // ---- 鼠标状态机（对齐 AS3 BaseButton.setMouseState）-------------------
  get mouseState() {
    return this._mouseState;
  }

  /**
   * 设置鼠标状态。mouseStateLocked 时只记录到 unlockedMouseState。
   */
  setMouseState(state) {
    if (this.mouseStateLocked) {
      this._unlockedMouseState = state;
      return;
    }
    if (state === this._mouseState) return;
    this._mouseState = state;
    this.invalidate(InvalidationType.STATE);
  }

  // ---- 选中态 -----------------------------------------------------------
  get selected() {
    return this._selected;
  }

  set selected(value) {
    const b = !!value;
    if (b !== this._selected) {
      this._selected = b;
      this.toggleAttribute('selected', b);
      this.invalidate(InvalidationType.STATE);
    }
  }

  // ---- 自动重复（对齐 AS3 pressTimer）------------------------------------
  get autoRepeat() {
    return this._autoRepeat;
  }

  set autoRepeat(value) {
    this._autoRepeat = !!value;
    this.toggleAttribute('auto-repeat', this._autoRepeat);
  }

  /**
   * 按下（对齐 AS3 BaseButton.startPress）。
   */
  _startPress() {
    if (!this.enabled) return;
    this.dispatchEvent(new ComponentEvent(ComponentEvent.BUTTON_DOWN, false));
    if (this.autoRepeat) {
      // 对齐 AS3：首次延迟 repeatDelay，之后每 repeatInterval 触发一次
      this._stopPressTimer();
      const tick = () => {
        this.dispatchEvent(new ComponentEvent(ComponentEvent.BUTTON_DOWN, false));
        this._pressTimerToken = setTimeout(tick, this.repeatInterval);
      };
      this._pressTimerToken = setTimeout(tick, this.repeatDelay);
    }
  }

  _stopPressTimer() {
    if (this._pressTimerToken) {
      clearTimeout(this._pressTimerToken);
      this._pressTimerToken = 0;
    }
  }

  /**
   * 松开（对齐 AS3 BaseButton.endPress）。
   */
  _endPress() {
    this._stopPressTimer();
  }

  // ---- 鼠标事件处理（对齐 AS3 setupMouseEvents 的各 handler）-------------
  _onRollOver(e) {
    if (!this.enabled) return;
    this.setMouseState(this._mouseState === MouseState.DOWN ? MouseState.DOWN : MouseState.OVER);
    if (this._mouseState === MouseState.DOWN) {
      // 从外部按下时拖入：AS3 会在 stage 上监听 MOUSE_UP
      window.addEventListener('mouseup', this._stageMouseUp, { once: true });
    }
  }

  _onRollOut(e) {
    if (!this.enabled) return;
    this.setMouseState(MouseState.UP);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    e && e.preventDefault && e.preventDefault();
    this.setMouseState(MouseState.DOWN);
    window.addEventListener('mouseup', this._stageMouseUp, { once: true });
    this._startPress();
    this.toggleSelected(e);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this.setMouseState(MouseState.UP);
    this._endPress();
    window.removeEventListener('mouseup', this._stageMouseUp);
  }

  /**
   * 切换选中（对齐 AS3 LabelButton.toggleSelected，子类可覆盖）。
   * CellRenderer 会覆盖为空（选中由列表控制）。
   */
  toggleSelected(e) {
    if (this._toggle && this.enabled) {
      this.selected = !this.selected;
    }
  }

  // ---- 重绘 -------------------------------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.STATE] || invalidHash[InvalidationType.ALL]) {
      this.drawBackground();
    }
    super.draw(invalidHash);
  }

  /**
   * 计算当前皮肤状态名（对齐 AS3 BaseButton.drawBackground）：
   *   enabled ? mouseState : 'disabled'，选中时前缀 'selected'。
   */
  _currentSkinState() {
    let state = this.enabled ? this._mouseState : MouseState.DISABLED;
    if (this._selected) {
      state = 'selected' + state.charAt(0).toUpperCase() + state.slice(1);
    }
    return state;
  }

  drawBackground() {
    // 皮肤是 CSS：把状态写到属性上，由 ts-components.css 的规则呈现
    const baseState = this.enabled ? this._mouseState : MouseState.DISABLED;
    this.dataset.mouseState = baseState;
    this.dataset.selected = this._selected ? 'true' : 'false';
  }
}

/**
 * 带文字/图标的按钮（对齐 fl.controls.LabelButton）。
 * 属性：label / toggle / labelPlacement / icon
 */
export class TsLabelButton extends TsBaseButton {
  static get observedAttributes() {
    return [...super.observedAttributes, 'label', 'label-placement', 'toggle', 'icon'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === 'label') {
      this._label = newValue == null ? '' : newValue;
      this.invalidate(InvalidationType.DATA);
      this.dispatchEvent(new ComponentEvent(ComponentEvent.LABEL_CHANGE, false));
    } else if (name === 'label-placement') {
      this._labelPlacement = ButtonLabelPlacement[(newValue || 'right').toUpperCase()] || ButtonLabelPlacement.RIGHT;
      this.invalidate(InvalidationType.SIZE);
    } else if (name === 'toggle') {
      this._toggle = this.hasAttribute('toggle');
    } else if (name === 'icon') {
      this._iconSource = newValue;
      this.invalidate(InvalidationType.STYLES);
    }
  }

  constructor() {
    super();
    this._label = 'Label';
    this._labelPlacement = ButtonLabelPlacement.RIGHT;
    this._toggle = false;
    this._iconSource = null;
    this._iconEl = null;
    this._labelEl = null;
  }

  configUI() {
    super.configUI();
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<div class="ts-content">' +
      '<span class="ts-icon" style="display:none"></span>' +
      '<span class="ts-label"></span>' +
      '</div>';
    this._bgEl = this.querySelector('.ts-bg');
    this._contentEl = this.querySelector('.ts-content');
    this._iconEl = this.querySelector('.ts-icon');
    this._labelEl = this.querySelector('.ts-label');
  }

  // ---- 属性 -------------------------------------------------------------
  get label() {
    return this._label;
  }

  set label(value) {
    if (value === this._label) return;
    this._label = value == null ? '' : String(value);
    this.invalidate(InvalidationType.DATA);
    this.dispatchEvent(new ComponentEvent(ComponentEvent.LABEL_CHANGE, false));
  }

  get toggle() {
    return this._toggle;
  }

  set toggle(value) {
    const b = !!value;
    if (b !== this._toggle) {
      this._toggle = b;
      this.toggleAttribute('toggle', b);
      if (!b) this.selected = false;
    }
  }

  get labelPlacement() {
    return this._labelPlacement;
  }

  set labelPlacement(value) {
    if (value === this._labelPlacement) return;
    this._labelPlacement = value;
    this.invalidate(InvalidationType.SIZE);
  }

  /**
   * 图标源：图片 URL 字符串，或 HTMLImageElement/HTMLCanvasElement。
   * 对齐 AS3 的 icon 样式（皮肤对象）。
   */
  get icon() {
    return this._iconSource;
  }

  set icon(value) {
    this._iconSource = value;
    this.invalidate(InvalidationType.STYLES);
  }

  // ---- 重绘 -------------------------------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.STYLES] || invalidHash[InvalidationType.ALL]) {
      this.drawIcon();
      this.drawTextFormat();
    }
    if (invalidHash[InvalidationType.DATA] || invalidHash[InvalidationType.ALL]) {
      this.drawLabel();
    }
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.drawLayout();
    }
    super.draw(invalidHash);
  }

  drawLabel() {
    if (this._labelEl) {
      this._labelEl.textContent = this._label;
      this._labelEl.style.display = this._label.length > 0 ? '' : 'none';
    }
  }

  drawIcon() {
    const src = this.getStyleValue('icon');
    if (!src) {
      if (this._iconEl) this._iconEl.style.display = 'none';
      return;
    }
    if (!this._iconEl) return;
    this._iconEl.style.display = '';
    if (typeof src === 'string') {
      if (this._iconEl.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.className = 'ts-icon';
        this._iconEl.replaceWith(img);
        this._iconEl = img;
      }
      if (this._iconEl.src !== src) this._iconEl.src = src;
    } else if (src instanceof HTMLElement) {
      if (this._iconEl !== src) {
        src.classList.add('ts-icon');
        this._iconEl.replaceWith(src);
        this._iconEl = src;
      }
    }
  }

  drawTextFormat() {
    const tf = this.enabled
      ? this.getStyleValue('textFormat')
      : this.getStyleValue('disabledTextFormat');
    if (!tf || !this._labelEl) return;
    if (tf.font) this._labelEl.style.fontFamily = tf.font;
    if (tf.size) this._labelEl.style.fontSize = tf.size + 'px';
    if (tf.color != null) this._labelEl.style.color = '#' + Number(tf.color).toString(16).padStart(6, '0');
    if (tf.bold != null) this._labelEl.style.fontWeight = tf.bold ? '700' : '400';
    if (tf.align) this._labelEl.style.textAlign = tf.align;
  }

  drawLayout() {
    // 对齐 AS3 LabelButton.drawLayout 的图标/文字排布，用 flex 顺序实现
    if (!this._contentEl) return;
    const placement = this._labelPlacement;
    const orderIcon = placement === ButtonLabelPlacement.LEFT || placement === ButtonLabelPlacement.BOTTOM ? 2 : 1;
    const orderLabel = orderIcon === 1 ? 2 : 1;
    this._iconEl.style.order = orderIcon;
    this._labelEl.style.order = orderLabel;
    this._contentEl.style.flexDirection =
      placement === ButtonLabelPlacement.TOP || placement === ButtonLabelPlacement.BOTTOM
        ? 'column'
        : 'row';
    // textPadding（对齐 AS3 textPadding 样式）
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    this._labelEl.style.padding = '0 ' + padding + 'px';
    this._bgEl.style.inset = '0';
  }

  // BaseButton 的背景层引用
  get background() {
    return this._bgEl;
  }
}

/**
 * 标准按钮（对齐 fl.controls.Button）：在 LabelButton 基础上加 emphasized。
 * <ts-button label="确定" emphasized toggle>
 */
export class TsButton extends TsLabelButton {
  static get observedAttributes() {
    return [...super.observedAttributes, 'emphasized'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === 'emphasized') {
      this._emphasized = this.hasAttribute('emphasized');
      this.invalidate(InvalidationType.STYLES);
    }
  }

  constructor() {
    super();
    this._emphasized = false;
  }

  get emphasized() {
    return this._emphasized;
  }

  set emphasized(value) {
    const b = !!value;
    if (b !== this._emphasized) {
      this._emphasized = b;
      this.toggleAttribute('emphasized', b);
      this.invalidate(InvalidationType.STYLES);
    }
  }

  draw(invalidHash) {
    if (invalidHash[InvalidationType.STYLES] || invalidHash[InvalidationType.ALL]) {
      // 对齐 AS3 Button.drawEmphasized：加 emphasized 皮肤类 + padding
      this.classList.toggle('emphasized', this._emphasized);
      const pad = this._emphasized ? Number(this.getStyleValue('emphasizedPadding')) || 2 : 0;
      this._bgEl.style.inset = -pad + 'px';
    }
    super.draw(invalidHash);
  }
}

customElements.define('ts-button', TsButton);

// CellRenderer（对齐 fl.controls.listClasses.CellRenderer extends LabelButton）
// 选中由列表控制，toggleSelected 覆盖为空；在 ts-list.js 中注册为 ts-cell-renderer。
export { TsButton as default };
