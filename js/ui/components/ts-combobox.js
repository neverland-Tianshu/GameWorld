// ts-combobox.js — 下拉框
// 移植自：fl.controls.ComboBox（UIComponent.swf）
//
// 关键对齐点：
//   - editable（默认 false）/ text / prompt / value / selectedLabel
//   - selectedIndex / selectedItem / labelField / labelFunction
//   - rowCount = 5（下拉默认显示行数，对齐 AS3 _rowCount）
//   - buttonWidth = 24（右侧箭头按钮宽度，对齐 AS3 defaultStyles）
//   - dataProvider 代理：addItem/addItemAt/removeItem/.../sortItems/sortItemsOn
//   - open()/close()，失焦自动关闭（对齐 AS3 在 stage 上监听 MOUSE_DOWN）
//   - 事件：change / open / close / enter
//
// 自定义元素：<ts-combobox>

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
} from './ts-base.js?v=20261007c';
import { TsList, DataProvider } from './ts-list.js?v=20261007c';

// 滚动条占用的宽度（= ts-scrollbar.js SCROLL_BAR_WIDTH / CSS --ts-scroll-w）
const SCROLL_BAR_WIDTH = 17;
// 对齐 AS3 ComboBox.defaultStyles
const COMBO_BUTTON_WIDTH = 24;

export class TsComboBox extends UIComponent {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'editable',
      'prompt',
      'row-count',
      'label-field',
      'text',
      'restrict',
      'dropdown-width',
    ];
  }

  static defaultStyles = {
    upSkin: 'ComboBox_upSkin',
    downSkin: 'ComboBox_downSkin',
    overSkin: 'ComboBox_overSkin',
    disabledSkin: 'ComboBox_disabledSkin',
    focusRectSkin: null,
    focusRectPadding: null,
    textFormat: null,
    disabledTextFormat: null,
    textPadding: 1,
    embedFonts: null,
    buttonWidth: COMBO_BUTTON_WIDTH,
  };

  constructor() {
    super();
    this._editable = false;
    this._prompt = null;
    this._rowCount = 5; // 对齐 AS3 _rowCount:uint = 5
    this._selectedIndex = -1;
    this._dataProvider = new DataProvider();
    this._isOpen = false;
    this._labelField = 'label';
    this._labelFunction = null;
    this._text = '';
    this._restrict = null;
    this._dropdownWidth = NaN;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'editable':
        this._editable = this.hasAttribute('editable');
        this.invalidate(InvalidationType.STATE);
        break;
      case 'prompt':
        this._prompt = newValue;
        this.invalidate(InvalidationType.DATA);
        break;
      case 'row-count':
        this._rowCount = Math.max(1, parseInt(newValue, 10) || 5);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'label-field':
        this._labelField = newValue;
        if (this._list) this._list.labelField = newValue;
        this.invalidate(InvalidationType.DATA);
        break;
      case 'text':
        this.text = newValue == null ? '' : String(newValue);
        break;
      case 'restrict':
        this._restrict = newValue;
        this.invalidate(InvalidationType.STATE);
        break;
      case 'dropdown-width':
        this._dropdownWidth = parseFloat(newValue) || NaN;
        this.invalidate(InvalidationType.SIZE);
        break;
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<input class="ts-field" type="text" readonly>' +
      '<div class="ts-arrow-btn"></div>' +
      '<div class="ts-dropdown"><ts-list></ts-list></div>';
    this._bgEl = this.querySelector('.ts-bg');
    this._fieldEl = this.querySelector('.ts-field');
    this._arrowEl = this.querySelector('.ts-arrow-btn');
    this._dropdownEl = this.querySelector('.ts-dropdown');
    this._list = this.querySelector('ts-list');
    // 回填挂载前暂存的 text
    this._fieldEl.value = this._text;

    this._list.labelField = this._labelField;
    this._list.addEventListener('change', () => this._listChange());
    this._list.addEventListener(ListEvent_ITEM_CLICK, (e) => this._itemClick(e));

    // 打开/切换
    this._arrowEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._isOpen ? this.close() : this.open();
    });
    this._fieldEl.addEventListener('mousedown', (e) => {
      if (!this._editable) {
        e.preventDefault();
        this._isOpen ? this.close() : this.open();
      }
    });
    this._fieldEl.addEventListener('input', () => {
      // editable 模式下文本变化（对齐 AS3 ComboBox.handleChange）
      this._text = this._fieldEl.value;
      this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
    });
    this._fieldEl.addEventListener('keydown', (e) => this._fieldKeyDown(e));
    this._fieldEl.addEventListener('focus', () => this.focusInHandler());
    this._fieldEl.addEventListener('blur', () => this.focusOutHandler());

    // 点击组件外关闭（对齐 AS3 在 stage 上监听 MOUSE_DOWN）
    this._outsideMouseDown = (e) => {
      if (!this.contains(e.target)) this.close();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('mousedown', this._outsideMouseDown);
  }

  disconnectedCallback() {
    document.removeEventListener('mousedown', this._outsideMouseDown);
  }

  // ---- 属性 -------------------------------------------------------------
  get editable() {
    return this._editable;
  }

  set editable(value) {
    this._editable = !!value;
    this.toggleAttribute('editable', this._editable);
    this.invalidate(InvalidationType.STATE);
  }

  get prompt() {
    return this._prompt;
  }

  set prompt(value) {
    this._prompt = value;
    this.invalidate(InvalidationType.DATA);
  }

  get rowCount() {
    return this._rowCount;
  }

  set rowCount(value) {
    this._rowCount = Math.max(1, value | 0);
    this.invalidate(InvalidationType.SIZE);
  }

  get labelField() {
    return this._labelField;
  }

  set labelField(value) {
    this._labelField = value;
    if (this._list) this._list.labelField = value;
    this.invalidate(InvalidationType.DATA);
  }

  get labelFunction() {
    return this._labelFunction;
  }

  set labelFunction(value) {
    this._labelFunction = value;
    if (this._list) this._list.labelFunction = value;
    this.invalidate(InvalidationType.DATA);
  }

  get restrict() {
    return this._restrict;
  }

  set restrict(value) {
    this._restrict = value;
    this.invalidate(InvalidationType.STATE);
  }

  get dropdownWidth() {
    return this._dropdownWidth;
  }

  set dropdownWidth(value) {
    this._dropdownWidth = value;
    this.invalidate(InvalidationType.SIZE);
  }

  get dropdown() {
    return this._list;
  }

  get length() {
    return this._dataProvider.length;
  }

  get text() {
    if (this._editable && this._fieldEl) return this._fieldEl.value;
    return this._text;
  }

  set text(value) {
    const v = value == null ? '' : String(value);
    this._text = v;
    if (this._fieldEl) this._fieldEl.value = v;
  }

  // 对齐 AS3 ComboBox.value：选中项的 data（无选中时是 text）
  get value() {
    if (this._selectedIndex >= 0) {
      const item = this._dataProvider.getItemAt(this._selectedIndex);
      return item && item.data != null ? item.data : this.selectedLabel;
    }
    return this.text;
  }

  get selectedLabel() {
    if (this._selectedIndex < 0) return null;
    const item = this._dataProvider.getItemAt(this._selectedIndex);
    return item == null ? null : this.itemToLabel(item);
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  set selectedIndex(value) {
    if (value === this._selectedIndex) return;
    this._selectedIndex = value;
    this._list.selectedIndex = value;
    this.invalidate(InvalidationType.SELECTED);
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
  }

  get selectedItem() {
    return this._selectedIndex >= 0 ? this._dataProvider.getItemAt(this._selectedIndex) : null;
  }

  set selectedItem(value) {
    this.selectedIndex = this._dataProvider.getItemIndex(value);
  }

  // ---- 数据提供者代理（对齐 AS3 ComboBox 的同名方法）-----------------------
  get dataProvider() {
    return this._dataProvider;
  }

  set dataProvider(value) {
    this._dataProvider = value instanceof DataProvider ? value : new DataProvider(value);
    this._list.dataProvider = this._dataProvider;
    this._selectedIndex = this._dataProvider.length > 0 ? 0 : -1;
    this.invalidate(InvalidationType.DATA);
  }

  addItem(item) {
    this._dataProvider.addItem(item);
  }

  addItemAt(item, index) {
    this._dataProvider.addItemAt(item, index);
  }

  removeItem(item) {
    return this._dataProvider.removeItem(item);
  }

  removeItemAt(index) {
    return this._dataProvider.removeItemAt(index);
  }

  removeAll() {
    this._dataProvider.removeAll();
  }

  replaceItemAt(newItem, index) {
    return this._dataProvider.replaceItemAt(newItem, index);
  }

  getItemAt(index) {
    return this._dataProvider.getItemAt(index);
  }

  sortItems(...args) {
    return this._dataProvider.sort(...args);
  }

  sortItemsOn(fieldName, options = null) {
    return this._dataProvider.sortOn(fieldName, options);
  }

  itemToLabel(item) {
    if (item == null) return '';
    if (this._labelFunction) return this._labelFunction(item);
    if (typeof item === 'string' || typeof item === 'number') return String(item);
    return item[this._labelField] != null ? String(item[this._labelField]) : '';
  }

  // ---- 打开/关闭（对齐 AS3 ComboBox.open / close / onListItemUp）----------
  get isOpen() {
    return this._isOpen;
  }

  open() {
    if (this._isOpen || !this.enabled) return;
    this._isOpen = true;
    this.dataset.open = 'true';
    const w = isNaN(this._dropdownWidth) ? this.width : this._dropdownWidth;
    this._dropdownEl.style.width = w + 'px';
    // 对齐 AS3：下拉高度 = rowCount * rowHeight
    this._list.setSize(w, this._rowCount * this._list.rowHeight);
    // 列表此前藏在 display:none 的下拉容器里（高度 0），尺寸变化后立即同步重绘，
    // 否则要等下一帧 rAF 才出选项（用户会看到「先坍缩、过一会才有选项」）
    this._list.drawNow();
    // 对齐 AS3 ComboBox.open：滚动到选中项
    this._list.scrollToSelected();
    // 对齐 AS3：下拉定位在组件下方
    this._dropdownEl.style.top = '100%';
    this.dispatchEvent(new CustomEvent('open', { bubbles: false, detail: { source: this } }));
  }

  close() {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.dataset.open = 'false';
    this.dispatchEvent(new CustomEvent('close', { bubbles: false, detail: { source: this } }));
  }

  _listChange() {
    // 对齐 AS3 ComboBox.onListChange：列表选中变化（点击/键盘导航）时
    // 同步本组件选中索引并失效 SELECTED，以便 drawTextField 刷新输入框文字
    if (!this._list) return;
    this._selectedIndex = this._list.selectedIndex;
    this.invalidate(InvalidationType.SELECTED);
    this.drawNow();
  }

  _itemClick(e) {
    // 对齐 AS3 ComboBox.onListItemUp
    const i = e.detail.index;
    if (i >= 0) {
      const prev = this._selectedIndex;
      this._selectedIndex = i;
      this.invalidate(InvalidationType.SELECTED);
      // 同步重绘，输入框文字立即随选中项更新（不等下一帧）
      this.drawNow();
      if (prev !== i) {
        this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
      }
    }
    this.close();
  }

  _fieldKeyDown(e) {
    switch (e.key) {
      case 'Enter':
        if (this._isOpen) {
          if (this._list.selectedIndex >= 0) {
            this._selectedIndex = this._list.selectedIndex;
            this.invalidate(InvalidationType.SELECTED);
            this.drawNow();
            this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
          }
          this.close();
        } else if (this._editable) {
          // 对齐 AS3 ComboBox.handleKeyDown 的 ENTER 派发
          this.dispatchEvent(new ComponentEvent(ComponentEvent.ENTER, true));
        }
        e.preventDefault();
        break;
      case 'Escape':
        if (this._isOpen) {
          this.close();
          e.preventDefault();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!this._isOpen) this.open();
        else this._list.selectedIndex = Math.min(this.length - 1, this._list.selectedIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this._isOpen) {
          this._list.selectedIndex = Math.max(0, this._list.selectedIndex - 1);
        }
        break;
    }
  }

  // ---- 重绘 -------------------------------------------------------------
  draw(invalidHash) {
    // 对齐 AS3 ComboBox.draw：每次重绘都把选中索引钳制到有效范围并同步到下拉列表
    // （dataProvider 变化等 DATA 失效后，列表选中态才有机会更新）
    let idx = this._selectedIndex;
    if (idx === -1 && (this._prompt != null || this._editable || this.length === 0)) {
      idx = Math.max(-1, Math.min(idx, this.length - 1));
    } else {
      idx = Math.max(0, Math.min(idx, this.length - 1));
    }
    if (this._selectedIndex !== idx) this._selectedIndex = idx;
    if (this._list && this._list.selectedIndex !== idx) {
      this._list.selectedIndex = idx;
      this.invalidate(InvalidationType.SELECTED);
    }
    if (invalidHash[InvalidationType.STATE] || invalidHash[InvalidationType.ALL]) {
      this.updateFieldState();
    }
    if (invalidHash[InvalidationType.DATA] || invalidHash[InvalidationType.ALL]) {
      this.drawTextField();
    }
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.drawLayout();
    }
    if (invalidHash[InvalidationType.SELECTED]) {
      this.drawTextField();
    }
    super.draw(invalidHash);
  }

  updateFieldState() {
    const f = this._fieldEl;
    f.readOnly = !(this.enabled && this._editable);
    f.disabled = !this.enabled;
    if (this._editable && this._restrict) f.pattern = this._restrict;
    else f.removeAttribute('pattern');
  }

  drawTextField() {
    // 对齐 AS3 ComboBox.drawTextField：有选中显示选中标签，否则显示 prompt
    if (this._selectedIndex >= 0) {
      this._fieldEl.value = this.selectedLabel || '';
    } else if (this._prompt != null) {
      this._fieldEl.value = this._prompt;
    } else {
      this._fieldEl.value = this._editable ? this._text : '';
    }
  }

  drawLayout() {
    const btnW = Number(this.getStyleValue('buttonWidth')) || COMBO_BUTTON_WIDTH;
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    this._fieldEl.style.left = padding + 'px';
    this._fieldEl.style.width = Math.max(0, this.width - btnW - padding * 2) + 'px';
    this._arrowEl.style.width = btnW + 'px';
    this._bgEl.style.inset = '0';
  }

  focus() {
    if (this._fieldEl) this._fieldEl.focus();
  }
}

// ListEvent 常量（避免从 ts-base 二次导入名称冲突，直接取常量串）
const ListEvent_ITEM_CLICK = 'itemClick';

customElements.define('ts-combobox', TsComboBox);

export default TsComboBox;
