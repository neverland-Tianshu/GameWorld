// ts-list.js — 列表组件
// 移植自：fl.data.DataProvider / fl.controls.listClasses.ListData /
//         fl.controls.listClasses.CellRenderer / fl.controls.SelectableList /
//         fl.controls.List（UIComponent.swf）
//
// 关键对齐点：
//   - DataProvider 完整 API + 双事件（PRE_DATA_CHANGE / DATA_CHANGE）
//   - SelectableList 选中语义：单击单选；Ctrl 单击切换；Shift 单击范围选择
//   - List：rowHeight=20、labelField='label'、iconField='icon'、rowCount 派生高度
//   - 虚拟化行渲染（只渲染可视区行 + 渲染器对象池，对齐 AS3 drawList）
//   - 键盘导航：上/下/PgUp/PgDn/Home/End + 首字母定位（getNextIndexAtLetter）
//   - 事件：change / itemClick / itemDoubleClick / itemRollOver / itemRollOut
//
// 自定义元素：<ts-list>（列表）、<ts-cell-renderer>（行渲染器，一般不直接使用）

import {
  UIComponent,
  InvalidationType,
  ComponentEvent,
  ListEvent,
  DataChangeEvent,
  DataChangeType,
} from './ts-base.js?v=20261007c';
import { TsLabelButton } from './ts-button.js?v=20261007c';
import { TsScrollBar } from './ts-scrollbar.js?v=20261007c';

// 滚动条占用的宽度（= ts-scrollbar.js SCROLL_BAR_WIDTH / CSS --ts-scroll-w）
const SCROLL_BAR_WIDTH = 17;

// ===========================================================================
// DataProvider（fl.data.DataProvider）
// ===========================================================================
export class DataProvider {
  /**
   * @param {Array|DataProvider|Document|String} value 初始数据
   */
  constructor(value = null) {
    this.data = [];
    if (value != null) this.data = this.getDataFromObject(value);
  }

  // —— 对齐 AS3 getDataFromObject ——
  getDataFromObject(value) {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const t = typeof item;
        if (t === 'string' || t === 'number' || t === 'boolean') return { label: item, data: item };
        return item;
      });
    }
    if (value instanceof DataProvider) return value.toArray();
    // XML：支持 XMLDocument / XML 字符串 / XML 元素节点
    let doc = value;
    if (typeof value === 'string') {
      try {
        doc = new DOMParser().parseFromString(value, 'application/xml');
      } catch (e) {
        return [];
      }
    }
    if (doc && doc.documentElement) {
      const out = [];
      Array.from(doc.documentElement.children).forEach((el) => {
        const label = el.getAttribute('label') || el.getAttribute('data') || el.localName;
        out.push({
          label,
          data: el.getAttribute('data') != null ? el.getAttribute('data') : el.textContent,
        });
      });
      return out;
    }
    return [];
  }

  get length() {
    return this.data.length;
  }

  // —— 增删改（全部派发 PRE_DATA_CHANGE + DATA_CHANGE，对齐 AS3 双事件）——
  addItem(item) {
    this.addItemAt(item, this.data.length);
  }

  addItemAt(item, index) {
    this.checkIndex(index, this.data.length);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.ADD, index, index, [item]));
    this.data.splice(index, 0, item);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.ADD, index, index, [item]));
  }

  addItems(items) {
    this.addItemsAt(items, this.data.length);
  }

  addItemsAt(items, index) {
    this.checkIndex(index, this.data.length);
    const arr = Array.from(items);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.ADD, index, index + arr.length - 1, arr));
    this.data.splice(index, 0, ...arr);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.ADD, index, index + arr.length - 1, arr));
  }

  removeItem(item) {
    const index = this.getItemIndex(item);
    if (index !== -1) return this.removeItemAt(index);
    return null;
  }

  removeItemAt(index) {
    this.checkIndex(index, this.data.length - 1);
    const item = this.data[index];
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.REMOVE, index, index, [item]));
    this.data.splice(index, 1);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.REMOVE, index, index, [item]));
    return item;
  }

  removeAll() {
    const items = this.data.concat();
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.REMOVE_ALL, 0, this.data.length - 1, items));
    this.data = [];
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.REMOVE_ALL, 0, 0, items));
  }

  replaceItem(newItem, oldItem) {
    const index = this.getItemIndex(oldItem);
    if (index !== -1) return this.replaceItemAt(newItem, index);
    return null;
  }

  replaceItemAt(newItem, index) {
    this.checkIndex(index, this.data.length - 1);
    const old = this.data[index];
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.REPLACE, index, index, [old]));
    this.data[index] = newItem;
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.REPLACE, index, index, [newItem]));
    return old;
  }

  getItemAt(index) {
    this.checkIndex(index, this.data.length - 1);
    return this.data[index];
  }

  getItemIndex(item) {
    return this.data.indexOf(item);
  }

  sort(...args) {
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.SORT, 0, this.data.length - 1, this.data.concat()));
    const r = this.data.sort(...args);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.SORT, 0, this.data.length - 1, this.data.concat()));
    return r;
  }

  sortOn(fieldName, options = null) {
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.PRE_DATA_CHANGE, DataChangeType.SORT, 0, this.data.length - 1, this.data.concat()));
    const fields = Array.isArray(fieldName) ? fieldName : [fieldName];
    const r = this.data.sort((a, b) => {
      for (const f of fields) {
        const av = a[f], bv = b[f];
        if (av === bv) continue;
        return av > bv ? 1 : -1;
      }
      return 0;
    });
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.SORT, 0, this.data.length - 1, this.data.concat()));
    return r;
  }

  merge(newData) {
    const items = this.getDataFromObject(newData);
    items.forEach((item) => {
      if (this.getItemIndex(item) === -1) this.addItem(item);
    });
  }

  concat(newData) {
    const items = this.getDataFromObject(newData);
    return new DataProvider(this.data.concat(items));
  }

  clone() {
    return new DataProvider(this.data.map((item) => Object.assign({}, item)));
  }

  toArray() {
    return this.data.concat();
  }

  // —— 局部失效（对齐 AS3 invalidate / invalidateItem / invalidateItemAt）——
  invalidate() {
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.INVALIDATE, 0, this.data.length - 1, this.data.concat()));
  }

  invalidateItem(item) {
    const index = this.getItemIndex(item);
    if (index !== -1) this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.INVALIDATE_ITEM, index, index, [item]));
  }

  invalidateItemAt(index) {
    this.checkIndex(index, this.data.length - 1);
    this.dispatchEvent(new DataChangeEvent(DataChangeEvent.DATA_CHANGE, DataChangeType.INVALIDATE_ITEM, index, index, [this.data[index]]));
  }

  // —— 事件（对齐 AS3 EventDispatcher）——
  addEventListener(type, listener, options) {
    if (!this._listeners) this._listeners = Object.create(null);
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push({ listener, options });
  }

  removeEventListener(type, listener) {
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((l) => l.listener !== listener);
  }

  dispatchEvent(event) {
    if (!this._listeners || !this._listeners[event.type]) return true;
    for (const entry of this._listeners[event.type].concat()) {
      const fn = typeof entry.listener === 'function' ? entry.listener : entry.listener.handleEvent;
      if (fn) fn.call(this, event);
    }
    return !event.defaultPrevented;
  }

  checkIndex(index, max) {
    if (index > max || index < 0) {
      throw new RangeError('DataProvider 索引越界：' + index + '（长度 ' + this.data.length + '）');
    }
  }
}

// ===========================================================================
// ListData（fl.controls.listClasses.ListData）
// ===========================================================================
export class ListData {
  constructor(label, icon, owner, index, row, column = 0) {
    this._label = label;
    this._icon = icon;
    this._owner = owner;
    this._index = index;
    this._row = row;
    this._column = column;
  }

  get label() {
    return this._label;
  }
  get icon() {
    return this._icon;
  }
  get owner() {
    return this._owner;
  }
  get index() {
    return this._index;
  }
  get row() {
    return this._row;
  }
  get column() {
    return this._column;
  }
}

// ===========================================================================
// CellRenderer（fl.controls.listClasses.CellRenderer extends LabelButton）
// 选中由列表控制，toggleSelected 覆盖为空（对齐 AS3）
// ===========================================================================
export class TsCellRenderer extends TsLabelButton {
  // 对齐 CellRenderer.defaultStyles
  static defaultStyles = {
    upSkin: 'CellRenderer_upSkin',
    downSkin: 'CellRenderer_downSkin',
    overSkin: 'CellRenderer_overSkin',
    disabledSkin: 'CellRenderer_disabledSkin',
    selectedDisabledSkin: 'CellRenderer_selectedDisabledSkin',
    selectedUpSkin: 'CellRenderer_selectedUpSkin',
    selectedDownSkin: 'CellRenderer_selectedDownSkin',
    selectedOverSkin: 'CellRenderer_selectedOverSkin',
    textFormat: null,
    disabledTextFormat: null,
    embedFonts: null,
    textPadding: 5,
  };

  constructor() {
    super();
    this._toggle = true;
    this.focusEnabled = false;
    this._data = null;
    this._listData = null;
  }

  get data() {
    return this._data;
  }

  set data(value) {
    this._data = value;
  }

  get listData() {
    return this._listData;
  }

  set listData(value) {
    this._listData = value;
    // 对齐 AS3 CellRenderer.listData setter
    this.label = value.label;
    this.icon = value.icon;
  }

  // 对齐 AS3：列表的选中状态外部设置，点击不自行切换
  toggleSelected(e) {}

  // 对齐 AS3 CellRenderer.drawLayout：图标在左、文字在右、垂直居中
  drawLayout() {
    if (!this._contentEl) return;
    this._iconEl.style.order = 1;
    this._labelEl.style.order = 2;
    this._contentEl.style.flexDirection = 'row';
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    this._labelEl.style.padding = '0 ' + padding + 'px';
    this._bgEl.style.inset = '0';
  }
}

customElements.define('ts-cell-renderer', TsCellRenderer);

// ===========================================================================
// SelectableList（fl.controls.SelectableList extends UIComponent）
// ===========================================================================
export class TsSelectableList extends UIComponent {
  // 对齐 AS3 SelectableList.defaultStyles（List 继承）
  static defaultStyles = {
    cellRenderer: TsCellRenderer,
    focusRectSkin: null,
    focusRectPadding: null,
    skin: 'List_skin',
  };

  constructor() {
    super();
    this._dataProvider = null;
    this._selectedIndices = [];
    this._allowMultipleSelection = false;
    this._selectable = true;
    this._invalidItems = new Map();
    // 渲染器样式（对齐 AS3 rendererStyles）
    this.rendererStyles = Object.create(null);
    // 渲染器对象池
    this._activeCellRenderers = [];
    this._availableCellRenderers = [];
    // 水平滚动（对齐 AS3 maxHorizontalScrollPosition）
    this._maxHorizontalScrollPosition = 0;
    this._horizontalScrollPosition = 0;
    this._anchorIndex = -1;
  }

  // ---- 数据提供者 -------------------------------------------------------
  get dataProvider() {
    return this._dataProvider;
  }

  set dataProvider(value) {
    if (this._dataProvider) {
      this._dataProvider.removeEventListener(DataChangeEvent.DATA_CHANGE, this._handleDataChange);
      this._dataProvider.removeEventListener(DataChangeEvent.PRE_DATA_CHANGE, this._onPreChange);
    }
    this._dataProvider = value instanceof DataProvider ? value : new DataProvider(value);
    this._handleDataChange = (e) => this.handleDataChange(e);
    this._onPreChange = (e) => this.onPreChange(e);
    this._dataProvider.addEventListener(DataChangeEvent.DATA_CHANGE, this._handleDataChange);
    this._dataProvider.addEventListener(DataChangeEvent.PRE_DATA_CHANGE, this._onPreChange);
    this.clearSelection();
    this.invalidateList();
  }

  get length() {
    return this._dataProvider ? this._dataProvider.length : 0;
  }

  // ---- 选中 -------------------------------------------------------------
  get allowMultipleSelection() {
    return this._allowMultipleSelection;
  }

  set allowMultipleSelection(value) {
    this._allowMultipleSelection = !!value;
    if (!value && this._selectedIndices.length > 1) {
      this._selectedIndices = this._selectedIndices.slice(0, 1);
      this.invalidate(InvalidationType.SELECTED);
    }
  }

  get selectable() {
    return this._selectable;
  }

  set selectable(value) {
    this._selectable = !!value;
  }

  get selectedIndex() {
    return this._selectedIndices.length > 0 ? this._selectedIndices[0] : -1;
  }

  set selectedIndex(value) {
    this.selectedIndices = value < 0 ? [] : [value];
  }

  get selectedIndices() {
    return this._selectedIndices.concat();
  }

  set selectedIndices(value) {
    if (!this._selectable) return;
    const arr = (Array.isArray(value) ? value : [value]).filter((i) => i >= 0 && i < this.length);
    if (!this._allowMultipleSelection && arr.length > 1) arr.length = 1;
    this._selectedIndices = arr;
    this._anchorIndex = arr.length > 0 ? arr[0] : -1;
    this.invalidate(InvalidationType.SELECTED);
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
  }

  get selectedItem() {
    const i = this.selectedIndex;
    return i < 0 ? null : this._dataProvider.getItemAt(i);
  }

  set selectedItem(value) {
    const i = this._dataProvider ? this._dataProvider.getItemIndex(value) : -1;
    this.selectedIndex = i;
  }

  get selectedItems() {
    return this._selectedIndices.map((i) => this._dataProvider.getItemAt(i));
  }

  set selectedItems(value) {
    this.selectedIndices = value.map((item) => this._dataProvider.getItemIndex(item));
  }

  clearSelection() {
    this._selectedIndices = [];
    this._anchorIndex = -1;
    this.invalidate(InvalidationType.SELECTED);
  }

  isItemSelected(item) {
    const i = this._dataProvider ? this._dataProvider.getItemIndex(item) : -1;
    return i !== -1 && this._selectedIndices.indexOf(i) !== -1;
  }

  scrollToSelected() {
    const i = this.selectedIndex;
    if (i >= 0) this.scrollToIndex(i);
  }

  scrollToIndex(newIndex) {
    // 子类（List/DataGrid）覆盖以实现真正的滚动
  }

  // ---- 数据操作代理（对齐 AS3 SelectableList 的同名方法）------------------
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
    if (typeof item === 'string' || typeof item === 'number') return String(item);
    if (this.labelFunction) return this.labelFunction(item);
    const field = this._labelField != null ? this._labelField : 'label';
    return item[field] != null ? String(item[field]) : '';
  }

  itemToCellRenderer(item) {
    const index = this._dataProvider.getItemIndex(item);
    return this._activeCellRenderers.find((r) => r.listData && r.listData.index === index) || null;
  }

  // ---- 渲染器样式（对齐 AS3 setRendererStyle / getRendererStyle）----------
  setRendererStyle(name, value, column = 0) {
    this.rendererStyles[name] = value;
    this.invalidate(InvalidationType.RENDERER_STYLES);
  }

  getRendererStyle(name, column = -1) {
    return this.rendererStyles[name];
  }

  clearRendererStyle(name, column = -1) {
    delete this.rendererStyles[name];
    this.invalidate(InvalidationType.RENDERER_STYLES);
  }

  // ---- 失效 -------------------------------------------------------------
  invalidateList() {
    this._invalidItems = new Map();
    this.invalidate(InvalidationType.DATA);
  }

  invalidateItem(item) {
    if (item != null) {
      this._invalidItems.set(item, true);
      this.invalidate(InvalidationType.DATA);
    }
  }

  invalidateItemAt(index) {
    const item = this._dataProvider.getItemAt(index);
    if (item != null) this.invalidateItem(item);
  }

  get maxHorizontalScrollPosition() {
    return this._maxHorizontalScrollPosition;
  }

  set maxHorizontalScrollPosition(value) {
    this._maxHorizontalScrollPosition = value;
  }

  // ---- 数据变更处理（对齐 AS3 handleDataChange / onPreChange）-------------
  handleDataChange(event) {
    // 选中索引随数据变更平移（对齐 AS3 onPreChange 的索引修正逻辑）
    const startIndex = event.startIndex;
    const endIndex = event.endIndex;
    const changeType = event.changeType;
    if (changeType === DataChangeType.ADD || changeType === DataChangeType.REMOVE) {
      const shift = changeType === DataChangeType.ADD ? endIndex - startIndex + 1 : -(endIndex - startIndex + 1);
      const len = this._selectedIndices.length;
      for (let i = 0; i < len; i++) {
        const idx = this._selectedIndices[i];
        if (idx >= startIndex) {
          const ni = idx + shift;
          this._selectedIndices[i] = Math.max(-1, ni);
        }
      }
      this._selectedIndices = this._selectedIndices.filter((i) => i >= 0 && i < this.length);
      this._anchorIndex = this._selectedIndices.length > 0 ? this._selectedIndices[0] : -1;
    } else if (changeType === DataChangeType.REMOVE_ALL) {
      this.clearSelection();
    }
    this.invalidateList();
  }

  onPreChange(event) {
    // AS3 在变更前快照选中项；这里在 handleDataChange 中直接修正
  }

  // ---- 行渲染器工厂（对齐 AS3 getDisplayObjectInstance(cellRenderer)）-----
  getCellRendererClass() {
    const r = this.getStyleValue('cellRenderer');
    return r || TsCellRenderer;
  }

  _createCellRenderer() {
    const RendererClass = this.getCellRendererClass();
    const renderer = RendererClass === TsCellRenderer ? new TsCellRenderer() : new RendererClass();
    renderer.classList.add('ts-cell');
    renderer.addEventListener('click', (e) => this._handleCellRendererClick(e, renderer));
    renderer.addEventListener('dblclick', (e) => this._handleCellRendererDoubleClick(e, renderer));
    renderer.addEventListener('mouseover', (e) => this._handleCellRendererMouseEvent(e, renderer, ListEvent.ITEM_ROLL_OVER));
    renderer.addEventListener('mouseout', (e) => this._handleCellRendererMouseEvent(e, renderer, ListEvent.ITEM_ROLL_OUT));
    renderer.addEventListener('change', (e) => this._handleCellRendererChange(e, renderer));
    // 应用渲染器样式
    for (const name in this.rendererStyles) {
      renderer.setStyle(name, this.rendererStyles[name]);
    }
    return renderer;
  }

  _recycleRenderer(renderer) {
    if (renderer.isConnected) renderer.remove();
    const i = this._activeCellRenderers.indexOf(renderer);
    if (i !== -1) this._activeCellRenderers.splice(i, 1);
    if (this._availableCellRenderers.length < 200) this._availableCellRenderers.push(renderer);
  }

  // ---- 行交互（对齐 AS3 handleCellRendererClick 的多选语义）---------------
  _handleCellRendererClick(e, renderer) {
    const index = renderer.listData ? renderer.listData.index : -1;
    if (index < 0 || !this._selectable) return;
    const item = this._dataProvider.getItemAt(index);
    const mouseEvent = e;

    if (!this._allowMultipleSelection) {
      this._selectedIndices = [index];
    } else if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
      const pos = this._selectedIndices.indexOf(index);
      if (pos !== -1) this._selectedIndices.splice(pos, 1);
      else this._selectedIndices.push(index);
      this._anchorIndex = index;
    } else if (mouseEvent.shiftKey && this._selectedIndices.length > 0) {
      const anchor = this._anchorIndex >= 0 ? this._anchorIndex : this._selectedIndices[0];
      const from = Math.min(anchor, index);
      const to = Math.max(anchor, index);
      this._selectedIndices = [];
      for (let i = from; i <= to; i++) this._selectedIndices.push(i);
    } else {
      this._selectedIndices = [index];
      this._anchorIndex = index;
    }

    this.dispatchEvent(
      new ListEvent(ListEvent.ITEM_CLICK, false, false, 0, index, index, item, mouseEvent)
    );
    this.invalidate(InvalidationType.SELECTED);
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
  }

  _handleCellRendererDoubleClick(e, renderer) {
    const index = renderer.listData ? renderer.listData.index : -1;
    if (index < 0) return;
    const item = this._dataProvider.getItemAt(index);
    this.dispatchEvent(new ListEvent(ListEvent.ITEM_DOUBLE_CLICK, false, false, 0, index, index, item, e));
  }

  _handleCellRendererMouseEvent(e, renderer, type) {
    const index = renderer.listData ? renderer.listData.index : -1;
    const item = index >= 0 ? this._dataProvider.getItemAt(index) : null;
    this.dispatchEvent(new ListEvent(type, false, false, 0, index, index, item, e));
    if (renderer.setMouseState) renderer.setMouseState(type === ListEvent.ITEM_ROLL_OVER ? 'over' : 'up');
  }

  _handleCellRendererChange(e, renderer) {
    // 行内部控件（如内嵌按钮）变化时转发（对齐 AS3）
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: renderer } }));
  }

  // ---- 键盘：首字母定位（对齐 AS3 getNextIndexAtLetter）-------------------
  getNextIndexAtLetter(letter, startIndex = -1) {
    if (!this.length || !letter) return -1;
    letter = String(letter).toLowerCase();
    for (let i = startIndex + 1; i < this.length; i++) {
      const label = this.itemToLabel(this._dataProvider.getItemAt(i)).toLowerCase();
      if (label.charAt(0) === letter) return i;
    }
    for (let i = 0; i <= startIndex; i++) {
      const label = this.itemToLabel(this._dataProvider.getItemAt(i)).toLowerCase();
      if (label.charAt(0) === letter) return i;
    }
    return -1;
  }
}

// ===========================================================================
// List（fl.controls.List extends SelectableList）
// ===========================================================================
export class TsList extends TsSelectableList {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'label-field',
      'icon-field',
      'row-height',
      'allow-multiple-selection',
    ];
  }

  // 对齐 fl.controls.List.defaultStyles
  static defaultStyles = {
    cellRenderer: TsCellRenderer,
    focusRectSkin: null,
    focusRectPadding: null,
    skin: 'List_skin',
    labelField: 'label',
    rowHeight: 20,
    iconField: 'icon',
  };

  constructor() {
    super();
    this._rowHeight = 20;
    this._labelField = 'label';
    this._iconField = 'icon';
    this._labelFunction = null;
    this._iconFunction = null;
    this._verticalScrollPosition = 0;
    this._lastSelectedIndex = -1;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'label-field':
        this._labelField = newValue;
        this.invalidate(InvalidationType.DATA);
        break;
      case 'icon-field':
        this._iconField = newValue;
        this.invalidate(InvalidationType.DATA);
        break;
      case 'row-height':
        this._rowHeight = Math.max(1, parseInt(newValue, 10) || 20);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'allow-multiple-selection':
        this.allowMultipleSelection = this.hasAttribute('allow-multiple-selection');
        break;
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<div class="ts-list-holder"><div class="ts-list-inner"></div></div>' +
      '<ts-scrollbar class="ts-v-scroll" direction="vertical"></ts-scrollbar>';
    this._bgEl = this.querySelector('.ts-bg');
    this._holderEl = this.querySelector('.ts-list-holder');
    this._innerEl = this.querySelector('.ts-list-inner');
    this._vScroll = this.querySelector('.ts-v-scroll');
    this._vScroll.addEventListener('scroll', (e) => {
      this._verticalScrollPosition = e.detail.position;
      this.invalidate(InvalidationType.DATA);
    });
    this.addEventListener('keydown', (e) => this._keyDownHandler(e));
    this.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._vScroll.scrollPosition -= e.deltaY * 3;
    }, { passive: false });
  }

  // ---- 属性 -------------------------------------------------------------
  get rowHeight() {
    return this._rowHeight;
  }

  set rowHeight(value) {
    this._rowHeight = Math.max(1, value | 0);
    this.setAttribute('row-height', this._rowHeight);
    this.invalidate(InvalidationType.SIZE);
  }

  get labelField() {
    return this._labelField;
  }

  set labelField(value) {
    this._labelField = value;
    this.setAttribute('label-field', value);
    this.invalidate(InvalidationType.DATA);
  }

  get iconField() {
    return this._iconField;
  }

  set iconField(value) {
    this._iconField = value;
    this.setAttribute('icon-field', value);
    this.invalidate(InvalidationType.DATA);
  }

  get labelFunction() {
    return this._labelFunction;
  }

  set labelFunction(value) {
    this._labelFunction = value;
    this.invalidate(InvalidationType.DATA);
  }

  get iconFunction() {
    return this._iconFunction;
  }

  set iconFunction(value) {
    this._iconFunction = value;
    this.invalidate(InvalidationType.DATA);
  }

  // 对齐 AS3 List.rowCount：高度可容纳的行数
  get rowCount() {
    const availH = this.height - (this._maxHorizontalScrollPosition > 0 ? SCROLL_BAR_WIDTH : 0);
    return Math.max(0, Math.floor(availH / this._rowHeight));
  }

  set rowCount(value) {
    // 对齐 AS3：height = rowHeight*rowCount + 上下 contentPadding + 横向滚动条
    const h = this._rowHeight * Math.max(0, value | 0);
    this.setSize(this.width, h);
  }

  get verticalScrollPosition() {
    return this._verticalScrollPosition;
  }

  set verticalScrollPosition(value) {
    this._vScroll.scrollPosition = value;
  }

  // ---- 滚动（对齐 AS3 List.scrollToIndex）--------------------------------
  scrollToIndex(newIndex) {
    if (newIndex < 0 || newIndex >= this.length) return;
    const first = Math.floor(this._verticalScrollPosition / this._rowHeight);
    const last = first + this.rowCount;
    if (newIndex < first) {
      this._vScroll.scrollPosition = newIndex * this._rowHeight;
    } else if (newIndex >= last) {
      this._vScroll.scrollPosition = (newIndex + 1) * this._rowHeight - this.height;
    }
  }

  // ---- 重绘（对齐 AS3 List.draw）---------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.drawLayout();
    }
    // 对齐 AS3：drawList 在 STYLES/SIZE/DATA/SCROLL/SELECTED 任一失效时都要执行
    // （漏掉 SIZE 会导致尺寸变化后行不重绘：下拉框首次打开时只剩隐藏期间的过期渲染器）
    if (
      invalidHash[InvalidationType.STYLES] ||
      invalidHash[InvalidationType.SIZE] ||
      invalidHash[InvalidationType.DATA] ||
      invalidHash[InvalidationType.SCROLL] ||
      invalidHash[InvalidationType.SELECTED] ||
      invalidHash[InvalidationType.RENDERER_STYLES] ||
      invalidHash[InvalidationType.ALL]
    ) {
      this.drawList();
    }
    super.draw(invalidHash);
  }

  drawLayout() {
    // 背景铺满
    this._bgEl.style.inset = '0';
    this._holderEl.style.inset = '0';
    // 纵向滚动条
    this._vScroll.style.display = '';
    this._vScroll.style.right = '0px';
    this._vScroll.style.top = '0px';
    this._vScroll.style.width = SCROLL_BAR_WIDTH + 'px';
    this._vScroll.style.height = this.height + 'px';
    const availH = this.height;
    const contentH = Math.max(0, this.length * this._rowHeight);
    this._vScroll.setScrollProperties(availH, 0, Math.max(0, contentH - availH), availH);
    this._vScroll.scrollPosition = this._verticalScrollPosition;
  }

  // 对齐 AS3 List.drawList：只渲染可视区行 + 渲染器池复用
  drawList() {
    if (!this._innerEl) return;
    const len = this.length;
    const rowH = this._rowHeight;
    const first = Math.min(Math.max(len - 1, 0), Math.floor(this._verticalScrollPosition / rowH));
    const last = Math.min(Math.max(len - 1, 0), first + this.rowCount + 1);

    // 可视项集合（用 Map 承载对象键，等价 AS3 Dictionary）
    const visibleItems = new Map();
    for (let i = first; i <= last; i++) {
      if (len > 0) visibleItems.set(this._dataProvider.getItemAt(i), true);
    }

    // 回收不在可视区或已失效的渲染器（对齐 AS3 的 Dictionary 回收逻辑）
    for (let i = this._activeCellRenderers.length - 1; i >= 0; i--) {
      const r = this._activeCellRenderers[i];
      if (!visibleItems.has(r.data) || this._invalidItems.has(r.data)) {
        this._availableCellRenderers.push(r);
        this._activeCellRenderers.splice(i, 1);
        if (r.isConnected) r.remove();
      }
    }

    // 建索引：data → 渲染器
    const activeByData = new Map();
    for (const r of this._activeCellRenderers) activeByData.set(r.data, r);

    for (let i = first; i <= last; i++) {
      if (len <= 0) break;
      const itemData = this._dataProvider.getItemAt(i);
      let renderer = activeByData.get(itemData);
      if (!renderer) {
        renderer = this._availableCellRenderers.pop() || this._createCellRenderer();
        this._activeCellRenderers.push(renderer);
        if (!renderer.isConnected) this._innerEl.appendChild(renderer);
      }
      // 行位置（像素级滚动，对齐 AS3：y = rowHeight*i - verticalScrollPosition）
      renderer.style.position = 'absolute';
      renderer.style.left = -this._horizontalScrollPosition + 'px';
      renderer.style.top = i * rowH - this._verticalScrollPosition + 'px';
      renderer.style.width = Math.max(0, this.width - SCROLL_BAR_WIDTH) + 'px';
      renderer.style.height = rowH + 'px';
      renderer.data = itemData;
      const icon = this._iconFunction ? this._iconFunction(itemData) : itemData[this._iconField];
      renderer.listData = new ListData(this.itemToLabel(itemData), icon, this, i, i, 0);
      renderer.selected = this._selectedIndices.indexOf(i) !== -1;
      renderer.enabled = this.enabled;
      this._invalidItems.delete(itemData);
      // 同步重绘渲染器（label/selected 的失效要下一帧才落到 DOM；
      // 下拉框等「打开即见」场景不能等那一帧，否则选项文字迟一帧出现）
      renderer.drawNow();
    }
  }

  // ---- 键盘导航（对齐 AS3 List.moveSelectionVertically + doKeySelection）--
  _keyDownHandler(e) {
    if (!this.enabled || this.length === 0) return;
    const lastIndex = this.length - 1;
    let newIndex = this.selectedIndex;
    let handled = false;
    switch (e.key) {
      case 'ArrowDown':
        newIndex = Math.min(lastIndex, Math.max(0, newIndex < 0 ? 0 : newIndex + 1));
        handled = true;
        break;
      case 'ArrowUp':
        newIndex = Math.max(0, newIndex < 0 ? 0 : newIndex - 1);
        handled = true;
        break;
      case 'PageDown':
        newIndex = Math.min(lastIndex, Math.max(0, newIndex < 0 ? 0 : newIndex + this.rowCount));
        handled = true;
        break;
      case 'PageUp':
        newIndex = Math.max(0, newIndex < 0 ? 0 : newIndex - this.rowCount);
        handled = true;
        break;
      case 'Home':
        newIndex = 0;
        handled = true;
        break;
      case 'End':
        newIndex = lastIndex;
        handled = true;
        break;
      case ' ':
      case 'Enter':
        if (this.selectedIndex >= 0) {
          const item = this._dataProvider.getItemAt(this.selectedIndex);
          this.dispatchEvent(
            new ListEvent(ListEvent.ITEM_CLICK, false, false, 0, this.selectedIndex, this.selectedIndex, item, e)
          );
          this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { source: this } }));
        }
        handled = true;
        break;
      default:
        // 首字母定位（对齐 AS3 doKeySelection）
        if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
          const at = this.getNextIndexAtLetter(e.key, this.selectedIndex);
          if (at !== -1) {
            newIndex = at;
            handled = true;
          }
        }
    }
    if (handled) {
      e.preventDefault();
      if (newIndex !== this.selectedIndex) {
        this.selectedIndex = newIndex;
        this.scrollToIndex(newIndex);
      }
    }
  }
}

customElements.define('ts-list', TsList);

export default TsList;
