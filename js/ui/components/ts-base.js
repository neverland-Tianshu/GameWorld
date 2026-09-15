// ts-base.js — AS3 fl.core 基础设施的 Web Components 移植
// 移植自反编译源：fl/core/UIComponent.as、fl/core/InvalidationType.as、
// fl/managers/StyleManager.as、fl/events/*.as（DefaultComponent.swf + UIComponent.swf）
//
// 提供：
//   - InvalidationType      失效类型常量（对齐 fl.core.InvalidationType）
//   - UIComponent           组件基类：invalidate/callLater/draw 失效重绘、双层样式、尺寸/移动、焦点
//   - StyleManager          全局组件样式注册（对齐 fl.managers.StyleManager）
//   - ComponentEvent        组件事件（对齐 fl.events.ComponentEvent）
//   - ScrollEvent           滚动事件（对齐 fl.events.ScrollEvent）
//   - ListEvent             列表事件（对齐 fl.events.ListEvent）
//   - DataGridEvent         表格事件（对齐 fl.events.DataGridEvent）
//   - DataChangeEvent       数据变更事件（对齐 fl.events.DataChangeEvent）
//   - DataChangeType        数据变更类型常量（对齐 fl.events.DataChangeType）

// ---------------------------------------------------------------------------
// 失效类型（fl.core.InvalidationType）
// ---------------------------------------------------------------------------
export const InvalidationType = Object.freeze({
  ALL: 'all',
  SIZE: 'size',
  STYLES: 'styles',
  RENDERER_STYLES: 'rendererStyles',
  STATE: 'state',
  DATA: 'data',
  SCROLL: 'scroll',
  SELECTED: 'selected',
});

// ---------------------------------------------------------------------------
// 全局失效调度（对齐 AS3 的 callLater + 下一帧 draw 机制）
// ---------------------------------------------------------------------------
const _invalidQueue = new Set();
let _validateScheduled = false;

function _scheduleValidate() {
  if (_validateScheduled) return;
  _validateScheduled = true;
  requestAnimationFrame(() => {
    _validateScheduled = false;
    // 复制后先清空，validate 内部可能再次触发新一轮失效（进入下一帧）
    const q = Array.from(_invalidQueue);
    _invalidQueue.clear();
    for (const comp of q) {
      if (comp.isConnected) comp.validate();
    }
  });
}

// ---------------------------------------------------------------------------
// 事件：fl.events.ComponentEvent
// ---------------------------------------------------------------------------
export class ComponentEvent extends CustomEvent {
  static BUTTON_DOWN = 'buttonDown';
  static LABEL_CHANGE = 'labelChange';
  static HIDE = 'hide';
  static SHOW = 'show';
  static RESIZE = 'resize';
  static MOVE = 'move';
  static ENTER = 'enter';

  constructor(type, bubbles = false, cancelable = false) {
    super(type, { bubbles, cancelable, detail: { type } });
  }

  clone() {
    return new ComponentEvent(this.type, this.bubbles, this.cancelable);
  }
}

// ---------------------------------------------------------------------------
// 事件：fl.events.ScrollEvent
// ---------------------------------------------------------------------------
export class ScrollEvent extends CustomEvent {
  static SCROLL = 'scroll';

  constructor(direction, delta, position, bubbles = false, cancelable = false) {
    super(ScrollEvent.SCROLL, {
      bubbles,
      cancelable,
      detail: { direction, delta, position },
    });
  }

  get direction() {
    return this.detail.direction;
  }
  get delta() {
    return this.detail.delta;
  }
  get position() {
    return this.detail.position;
  }

  clone() {
    return new ScrollEvent(
      this.detail.direction,
      this.detail.delta,
      this.detail.position,
      this.bubbles,
      this.cancelable
    );
  }
}

// 滚动条方向（fl.controls.ScrollBarDirection）
export const ScrollBarDirection = Object.freeze({
  VERTICAL: 'vertical',
  HORIZONTAL: 'horizontal',
});

// 滚动策略（fl.controls.ScrollPolicy）
export const ScrollPolicy = Object.freeze({
  ON: 'on',
  AUTO: 'auto',
  OFF: 'off',
});

// ---------------------------------------------------------------------------
// 事件：fl.events.ListEvent（AS3 中继承 MouseEvent，这里携带原鼠标事件引用）
// ---------------------------------------------------------------------------
export class ListEvent extends CustomEvent {
  static ITEM_ROLL_OUT = 'itemRollOut';
  static ITEM_ROLL_OVER = 'itemRollOver';
  static ITEM_CLICK = 'itemClick';
  static ITEM_DOUBLE_CLICK = 'itemDoubleClick';

  constructor(
    type,
    bubbles = false,
    cancelable = false,
    columnIndex = -1,
    rowIndex = -1,
    index = -1,
    item = null,
    mouseEvent = null
  ) {
    super(type, {
      bubbles,
      cancelable,
      detail: { columnIndex, rowIndex, index, item, mouseEvent },
    });
  }

  get columnIndex() {
    return this.detail.columnIndex;
  }
  get rowIndex() {
    return this.detail.rowIndex;
  }
  get index() {
    return this.detail.index;
  }
  get item() {
    return this.detail.item;
  }
  get mouseEvent() {
    return this.detail.mouseEvent;
  }

  clone() {
    return new ListEvent(
      this.type,
      this.bubbles,
      this.cancelable,
      this.detail.columnIndex,
      this.detail.rowIndex,
      this.detail.index,
      this.detail.item,
      this.detail.mouseEvent
    );
  }
}

// ---------------------------------------------------------------------------
// 事件：fl.events.DataGridEvent（继承 ListEvent）
// ---------------------------------------------------------------------------
export class DataGridEvent extends ListEvent {
  static COLUMN_STRETCH = 'columnStretch';
  static HEADER_RELEASE = 'headerRelease';
  static ITEM_EDIT_BEGINNING = 'itemEditBeginning';
  static ITEM_EDIT_BEGIN = 'itemEditBegin';
  static ITEM_EDIT_END = 'itemEditEnd';
  static ITEM_FOCUS_IN = 'itemFocusIn';
  static ITEM_FOCUS_OUT = 'itemFocusOut';

  constructor(
    type,
    bubbles = false,
    cancelable = false,
    columnIndex = -1,
    rowIndex = -1,
    itemRenderer = null,
    dataField = null,
    reason = null
  ) {
    super(type, bubbles, cancelable, columnIndex, rowIndex, rowIndex, null, null);
    this.detail.itemRenderer = itemRenderer;
    this.detail.dataField = dataField;
    this.detail.reason = reason;
  }

  get itemRenderer() {
    return this.detail.itemRenderer;
  }
  get dataField() {
    return this.detail.dataField;
  }
  get reason() {
    return this.detail.reason;
  }

  clone() {
    return new DataGridEvent(
      this.type,
      this.bubbles,
      this.cancelable,
      this.detail.columnIndex,
      this.detail.rowIndex,
      this.detail.itemRenderer,
      this.detail.dataField,
      this.detail.reason
    );
  }
}

// DataGridEventReason（fl.events.DataGridEventReason）
export const DataGridEventReason = Object.freeze({
  CANCELLED: 'cancelled',
  NEW_ROW: 'newRow',
  OTHER: 'other',
  ITEM_EDIT_END: 'itemEditEnd',
});

// ---------------------------------------------------------------------------
// 事件：fl.events.DataChangeEvent
// ---------------------------------------------------------------------------
export class DataChangeEvent extends CustomEvent {
  static DATA_CHANGE = 'dataChange';
  static PRE_DATA_CHANGE = 'preDataChange';

  constructor(
    type,
    changeType,
    startIndex,
    endIndex,
    items,
    bubbles = false,
    cancelable = false
  ) {
    super(type, {
      bubbles,
      cancelable,
      detail: { changeType, startIndex, endIndex, items },
    });
  }

  get changeType() {
    return this.detail.changeType;
  }
  get startIndex() {
    return this.detail.startIndex;
  }
  get endIndex() {
    return this.detail.endIndex;
  }
  get items() {
    return this.detail.items;
  }

  clone() {
    return new DataChangeEvent(
      this.type,
      this.detail.changeType,
      this.detail.startIndex,
      this.detail.endIndex,
      this.detail.items,
      this.bubbles,
      this.cancelable
    );
  }
}

// fl.events.DataChangeType
export const DataChangeType = Object.freeze({
  ADD: 'add',
  REMOVE: 'remove',
  REMOVE_ALL: 'removeAll',
  REPLACE: 'replace',
  INVALIDATE: 'invalidate',
  INVALIDATE_ITEM: 'invalidateItem',
  SORT: 'sort',
  RESET: 'reset',
});

// ---------------------------------------------------------------------------
// 样式管理器（fl.managers.StyleManager，简化为按组件标签名的全局样式表）
// ---------------------------------------------------------------------------
export const StyleManager = {
  // key = 组件标签名（或类名），value = { 样式名: 值 }
  _componentStyles: Object.create(null),

  /**
   * 为某类组件设置全局共享样式。
   * @param {string|Function} component 标签名字符串（如 'ts-button'）或组件类
   * @param {string} styleName 样式名（如 'textPadding'）
   * @param {*} value 样式值
   */
  setComponentStyle(component, styleName, value) {
    const key = this._key(component);
    if (!this._componentStyles[key]) this._componentStyles[key] = Object.create(null);
    this._componentStyles[key][styleName] = value;
  },

  getComponentStyle(component, styleName) {
    const key = this._key(component);
    const styles = this._componentStyles[key];
    return styles ? styles[styleName] : undefined;
  },

  clearComponentStyle(component, styleName) {
    const key = this._key(component);
    const styles = this._componentStyles[key];
    if (styles) delete styles[styleName];
  },

  clearAllComponentStyles(component) {
    const key = this._key(component);
    delete this._componentStyles[key];
  },

  _key(component) {
    if (typeof component === 'string') return component;
    if (component && component.tagName) return component.tagName.toLowerCase();
    if (component && component.name) return component.name;
    return String(component);
  },
};

// ---------------------------------------------------------------------------
// 组件基类（fl.core.UIComponent）
// ---------------------------------------------------------------------------
export class UIComponent extends HTMLElement {
  // 子类覆盖：默认样式表（对齐 AS3 defaultStyles 静态对象）
  static defaultStyles = {};

  // 缓存的已合并样式表（含父类默认样式）
  static _resolvedStyles = null;

  // 反射属性
  static get observedAttributes() {
    return ['disabled'];
  }

  /**
   * 取本类完整的默认样式表（合并父类默认样式 + 本类 defaultStyles）。
   * 对齐 AS3 UIComponent.getStyleDefinition() / mergeStyles()。
   */
  static getStyleDefinition() {
    if (this._resolvedStyles && this._resolvedStyles._owner === this) {
      return this._resolvedStyles;
    }
    const parentProto = Object.getPrototypeOf(this);
    const parentStyles =
      parentProto && parentProto.getStyleDefinition ? parentProto.getStyleDefinition() : {};
    const merged = Object.assign({}, parentStyles, this.defaultStyles || {});
    merged._owner = this;
    this._resolvedStyles = merged;
    return merged;
  }

  /**
   * 合并多张样式表（后覆盖先）。对齐 AS3 UIComponent.mergeStyles()。
   */
  static mergeStyles(...sources) {
    return Object.assign({}, ...sources);
  }

  constructor() {
    super();
    this._invalidHash = Object.create(null);
    this._instanceStyles = Object.create(null);
    this._callLaterQueue = null;
    this._tsInited = false;
    this._explicitWidth = null;
    this._explicitHeight = null;
    this._x = 0;
    this._y = 0;
    // 是否参与焦点管理（对齐 AS3 focusEnabled）
    this.focusEnabled = true;
    // 组件是否在失效队列中（供 callLater 的绘制回调辨别）
    this._invalid = false;
    // 焦点框开关（对齐 AS3 _focusRect / drawFocus）
    this._drawFocus = false;
  }

  // ---- 生命周期 ---------------------------------------------------------
  connectedCallback() {
    if (!this._tsInited) {
      this._tsInited = true;
      this.configUI();
    }
    this.invalidate(InvalidationType.ALL);
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'disabled' && oldValue !== newValue) {
      this.invalidate(InvalidationType.STATE);
    }
  }

  /**
   * 子类覆盖：构建内部 DOM、绑定事件（对齐 AS3 configUI）。
   * 只在首次接入文档时执行一次。
   */
  configUI() {}

  /**
   * 子类覆盖：按失效类型重绘（对齐 AS3 draw()）。
   * @param {Object} invalidHash 当前失效的类型集合 { size:true, data:true, ... }
   */
  draw(invalidHash) {}

  // ---- 失效 / 验证 ------------------------------------------------------
  /**
   * 标记组件失效，下一帧统一重绘（对齐 AS3 invalidate + callLater(draw)）。
   */
  invalidate(type = InvalidationType.ALL) {
    this._invalidHash[type] = true;
    this._invalid = true;
    _invalidQueue.add(this);
    _scheduleValidate();
  }

  /**
   * 立即执行所有待定的重绘（对齐 AS3 drawNow / validate）。
   */
  drawNow() {
    _invalidQueue.delete(this);
    this.validate();
  }

  /**
   * 是否包含指定失效类型（对齐 AS3 isInvalid）。
   */
  isInvalid(...types) {
    if (this._invalidHash[InvalidationType.ALL]) return true;
    return types.some((t) => this._invalidHash[t]);
  }

  validate() {
    // 先执行 callLater 队列（AS3 中 callLater 回调在 draw 之前触发）
    if (this._callLaterQueue) {
      const q = this._callLaterQueue;
      this._callLaterQueue = null;
      for (const fn of q) fn.call(this);
    }
    const hash = this._invalidHash;
    const hasInvalid = Object.keys(hash).length > 0;
    this._invalidHash = Object.create(null);
    this._invalid = false;
    if (hasInvalid) {
      this.draw(hash);
    }
  }

  /**
   * 延后到重绘前执行（对齐 AS3 callLater）。
   */
  callLater(fn) {
    if (!this._callLaterQueue) this._callLaterQueue = [];
    this._callLaterQueue.push(fn);
    _invalidQueue.add(this);
    _scheduleValidate();
  }

  // ---- 样式 -------------------------------------------------------------
  /**
   * 设置实例级样式（对齐 AS3 setStyle，覆盖类默认值与全局共享样式）。
   */
  setStyle(styleName, value) {
    this._instanceStyles[styleName] = value;
    this.invalidate(InvalidationType.STYLES);
  }

  getStyle(styleName) {
    return this.getStyleValue(styleName);
  }

  clearStyle(styleName) {
    delete this._instanceStyles[styleName];
    this.invalidate(InvalidationType.STYLES);
  }

  /**
   * 取样式最终值。查找顺序（对齐 AS3）：
   * 实例样式 → StyleManager 全局组件样式 → 类默认样式表。
   */
  getStyleValue(styleName) {
    if (styleName in this._instanceStyles) return this._instanceStyles[styleName];
    const shared = StyleManager.getComponentStyle(this.tagName, styleName);
    if (shared !== undefined) return shared;
    return this.constructor.getStyleDefinition()[styleName];
  }

  // ---- 启用 / 可见 ------------------------------------------------------
  get enabled() {
    return !this.hasAttribute('disabled');
  }

  set enabled(value) {
    const b = !!value;
    if (b !== this.enabled) {
      this.toggleAttribute('disabled', !b);
      this.invalidate(InvalidationType.STATE);
    }
  }

  get visible() {
    return this.style.display !== 'none';
  }

  set visible(value) {
    const was = this.visible;
    this.style.display = value ? '' : 'none';
    if (was !== !!value) {
      this.dispatchEvent(new ComponentEvent(value ? ComponentEvent.SHOW : ComponentEvent.HIDE, false));
    }
  }

  // ---- 尺寸 / 位置 ------------------------------------------------------
  get width() {
    return this._explicitWidth != null ? this._explicitWidth : this.offsetWidth;
  }

  get height() {
    return this._explicitHeight != null ? this._explicitHeight : this.offsetHeight;
  }

  set width(value) {
    this.setSize(value, this.height);
  }

  set height(value) {
    this.setSize(this.width, value);
  }

  /**
   * 一步设定宽高（对齐 AS3 setSize，触发 RESIZE 事件）。
   */
  setSize(width, height) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    this._explicitWidth = w;
    this._explicitHeight = h;
    this.style.width = w + 'px';
    this.style.height = h + 'px';
    this.invalidate(InvalidationType.SIZE);
    this.dispatchEvent(new ComponentEvent(ComponentEvent.RESIZE, false));
  }

  get x() {
    return this._x;
  }

  get y() {
    return this._y;
  }

  set x(value) {
    this.move(value, this._y);
  }

  set y(value) {
    this.move(this._x, value);
  }

  /**
   * 移动到父容器内坐标（对齐 AS3 move，触发 MOVE 事件）。
   * 需要组件处于定位上下文（组件默认 position:relative，可按需覆盖）。
   */
  move(x, y) {
    this._x = x;
    this._y = y;
    this.style.left = x + 'px';
    this.style.top = y + 'px';
    this.dispatchEvent(new ComponentEvent(ComponentEvent.MOVE, false));
  }

  // ---- 焦点 -------------------------------------------------------------
  /**
   * 绘制/移除焦点框（对齐 AS3 drawFocus）。
   */
  drawFocus(focused) {
    this._drawFocus = !!focused;
    this.classList.toggle('ts-focused', this._drawFocus && this.focusEnabled);
  }

  focusInHandler() {
    this.drawFocus(true);
  }

  focusOutHandler() {
    this.drawFocus(false);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/**
 * 把驼峰样式名转成 CSS 自定义属性名（setStyle('textPadding',5) → --ts-text-padding）。
 * 组件在 draw 中可用 this.style.setProperty(name, value) 应用。
 */
export function styleToCssVar(styleName) {
  return (
    '--ts-' +
    styleName.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase())
  );
}

/**
 * 极简 HTML 转义（富文本场景外部已处理，这里只用于内部文本安全输出）。
 */
export function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
