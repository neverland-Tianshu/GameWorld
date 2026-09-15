// ts-datagrid.js — 表格
// 移植自：fl.controls.DataGrid / fl.controls.dataGridClasses.DataGridColumn /
//         fl.controls.dataGridClasses.HeaderRenderer（UIComponent.swf）
//
// 关键对齐点：
//   - DataGridColumn：dataField/headerText/width(100)/minWidth(20)/visible/
//     resizable/sortable/sortDescending/labelFunction/cellRenderer/colNum
//   - DataGrid：columns/addColumn/addColumnAt/removeColumnAt/getColumnAt/
//     getColumnCount/getColumnIndex/spaceColumnsEqually/showHeaders/
//     headerHeight(25)/rowHeight(20)/sortableColumns/resizableColumns/editable
//   - 表头点击排序 + 排序箭头（HeaderSortArrow_ascIcon/descIcon）
//   - 列拉伸分隔条（columnDividerSkin + ColumnStretch_cursor）
//   - 单元格编辑：editedItemPosition/editField/itemEditBegin/itemEditEnd
//   - 行渲染对象池 + 像素级虚拟化（对齐 AS3 drawList 的渲染器回收）
//   - 事件：headerRelease / columnStretch / itemEditBeginning / itemEditBegin /
//     itemEditEnd / itemFocusIn / itemFocusOut / itemClick / change
//
// 自定义元素：<ts-datagrid>

import {
  UIComponent,
  InvalidationType,
  ListEvent,
  DataGridEvent,
  DataGridEventReason,
  ScrollBarDirection,
} from './ts-base.js?v=20261007c';
import { TsSelectableList, TsCellRenderer, ListData, DataProvider } from './ts-list.js?v=20261007c';
import { TsScrollBar } from './ts-scrollbar.js?v=20261007c';

// 滚动条占用的宽度（= ts-scrollbar.js SCROLL_BAR_WIDTH / CSS --ts-scroll-w）
const SCROLL_BAR_WIDTH = 17;

// ===========================================================================
// DataGridColumn（fl.controls.dataGridClasses.DataGridColumn）
// ===========================================================================
export class DataGridColumn {
  constructor(name = null) {
    this.dataField = name;
    this._headerText = name;
    this._width = 100; // 对齐 AS3 默认 width
    this._minWidth = 20; // 对齐 AS3 默认 minWidth
    this._visible = true;
    this.explicitWidth = null;
    this.colNum = NaN;
    this.owner = null;
    this.resizable = true;
    this.sortable = true;
    this.sortDescending = false;
    this.sortOptions = 0;
    this.editable = true;
    this.editorDataField = 'text';
    this.itemEditor = null;
    this._cellRenderer = null;
    this._headerRenderer = null;
    this._labelFunction = null;
    this._sortCompareFunction = null;
    this._imeMode = null;
  }

  get headerText() {
    return this._headerText != null ? this._headerText : this.dataField;
  }

  set headerText(value) {
    this._headerText = value;
    if (this.owner) this.owner.invalidate(InvalidationType.DATA);
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this.explicitWidth = value;
    if (this.owner != null) {
      const wasResizable = this.resizable;
      this.resizable = false;
      this.owner.resizeColumn(this.colNum, value);
      this.resizable = wasResizable;
    } else {
      this._width = value;
    }
  }

  setWidth(value) {
    this._width = value;
  }

  get minWidth() {
    return this._minWidth;
  }

  set minWidth(value) {
    this._minWidth = value;
    if (this._width < value) this._width = value;
    if (this.owner) this.owner.invalidate(InvalidationType.SIZE);
  }

  get visible() {
    return this._visible;
  }

  set visible(value) {
    if (this._visible !== value) {
      this._visible = value;
      if (this.owner) this.owner.invalidate(InvalidationType.SIZE);
    }
  }

  get labelFunction() {
    return this._labelFunction;
  }

  set labelFunction(value) {
    if (this._labelFunction === value) return;
    this._labelFunction = value;
    if (this.owner) this.owner.invalidate(InvalidationType.DATA);
  }

  get sortCompareFunction() {
    return this._sortCompareFunction;
  }

  set sortCompareFunction(value) {
    this._sortCompareFunction = value;
  }

  get cellRenderer() {
    return this._cellRenderer;
  }

  set cellRenderer(value) {
    this._cellRenderer = value;
    if (this.owner) this.owner.invalidate(InvalidationType.DATA);
  }

  get headerRenderer() {
    return this._headerRenderer;
  }

  set headerRenderer(value) {
    this._headerRenderer = value;
    if (this.owner) this.owner.invalidate(InvalidationType.DATA);
  }

  get imeMode() {
    return this._imeMode;
  }

  set imeMode(value) {
    this._imeMode = value;
  }

  /**
   * 取单元格显示文本（对齐 AS3 DataGridColumn.itemToLabel）。
   */
  itemToLabel(item) {
    if (!item) return ' ';
    if (this._labelFunction != null) return this._labelFunction(item);
    if (this.owner && this.owner.labelFunction != null) return this.owner.labelFunction(item, this);
    let data = item;
    if (typeof item === 'object') {
      data = item[this.dataField];
    }
    if (data == null) return ' ';
    return String(data);
  }

  toString() {
    return '[object DataGridColumn]';
  }
}

// ===========================================================================
// DataGrid（fl.controls.DataGrid extends SelectableList）
// ===========================================================================
export class TsDataGrid extends TsSelectableList {
  static get observedAttributes() {
    return [
      ...super.observedAttributes,
      'show-headers',
      'header-height',
      'row-height',
      'sortable-columns',
      'resizable-columns',
      'editable',
    ];
  }

  // 对齐 fl.controls.DataGrid.defaultStyles
  static defaultStyles = {
    headerUpSkin: 'HeaderRenderer_upSkin',
    headerDownSkin: 'HeaderRenderer_downSkin',
    headerOverSkin: 'HeaderRenderer_overSkin',
    headerDisabledSkin: 'HeaderRenderer_disabledSkin',
    headerSortArrowDescSkin: 'HeaderSortArrow_descIcon',
    headerSortArrowAscSkin: 'HeaderSortArrow_ascIcon',
    columnStretchCursorSkin: 'ColumnStretch_cursor',
    columnDividerSkin: null,
    headerTextFormat: null,
    headerDisabledTextFormat: null,
    headerTextPadding: 5,
    headerRenderer: null,
    focusRectSkin: null,
    focusRectPadding: null,
    skin: 'DataGrid_skin',
    cellRenderer: TsCellRenderer,
    rowHeight: 20,
  };

  constructor() {
    super();
    this._columns = [];
    this._visibleColumns = [];
    this._displayableColumns = [];
    this._showHeaders = true;
    this._headerHeight = 25; // 对齐 AS3 maxHeaderHeight/_headerHeight
    this._rowHeight = 20;
    this._minColumnWidth = NaN;
    this._labelFunction = null;
    this.sortableColumns = true;
    this.resizableColumns = true;
    this.editable = false;
    this._sortIndex = -1;
    this._lastSortIndex = -1;
    this._sortDescending = false;
    this._columnsInvalid = true;
    this._verticalScrollPosition = 0;
    this._horizontalScrollPosition = 0;
    // 列渲染器池：{ colNum: { available:[], active:[] } }
    this._rendererPools = Object.create(null);
    this._editedItemPosition = null;
    this._proposedEditedItemPosition = null;
    this._editedItemPositionChanged = false;
    this._itemEditorInstance = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback(name, oldValue, newValue);
    switch (name) {
      case 'show-headers':
        this._showHeaders = this.hasAttribute('show-headers');
        this.dataset.showHeaders = String(this._showHeaders);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'header-height':
        this._headerHeight = Math.max(1, parseFloat(newValue) || 25);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'row-height':
        this._rowHeight = Math.max(1, parseFloat(newValue) || 20);
        this.invalidate(InvalidationType.SIZE);
        break;
      case 'sortable-columns':
        this.sortableColumns = this.hasAttribute('sortable-columns');
        break;
      case 'resizable-columns':
        this.resizableColumns = this.hasAttribute('resizable-columns');
        break;
      case 'editable':
        this.editable = this.hasAttribute('editable');
        break;
    }
  }

  configUI() {
    super.configUI();
    if (this.focusEnabled) this.tabIndex = 0;
    this.dataset.showHeaders = String(this._showHeaders);
    this.innerHTML =
      '<div class="ts-bg"></div>' +
      '<div class="ts-header"></div>' +
      '<div class="ts-body"><div class="ts-body-inner"></div></div>' +
      '<ts-scrollbar class="ts-v-scroll" direction="vertical"></ts-scrollbar>' +
      '<ts-scrollbar class="ts-h-scroll" direction="horizontal"></ts-scrollbar>';
    this._bgEl = this.querySelector('.ts-bg');
    this._headerEl = this.querySelector('.ts-header');
    this._bodyEl = this.querySelector('.ts-body');
    this._innerEl = this.querySelector('.ts-body-inner');
    this._vScroll = this.querySelector('.ts-v-scroll');
    this._hScroll = this.querySelector('.ts-h-scroll');
    this._vScroll.addEventListener('scroll', (e) => {
      this._verticalScrollPosition = e.detail.position;
      this.invalidate(InvalidationType.DATA);
    });
    this._hScroll.addEventListener('scroll', (e) => {
      this._horizontalScrollPosition = e.detail.position;
      this.invalidate(InvalidationType.DATA);
    });
    this.addEventListener('keydown', (e) => this._keyDownHandler(e));
    this.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._vScroll.scrollPosition -= e.deltaY * 3;
    }, { passive: false });
  }

  // ---- 列管理（对齐 AS3 DataGrid.columns API）----------------------------
  get columns() {
    return this._columns;
  }

  set columns(value) {
    this._columns = [];
    value.forEach((c, i) => this.addColumnAt(c, i));
    this.invalidate(InvalidationType.SIZE);
  }

  /**
   * 添加列（对齐 AS3 addColumn：参数可以是 DataGridColumn 或 dataField 字符串）。
   */
  addColumn(column) {
    return this.addColumnAt(column, this._columns.length);
  }

  addColumnAt(column, index) {
    let col = column;
    if (typeof column === 'string') {
      col = new DataGridColumn(column);
    }
    col.owner = this;
    col.colNum = this._columns.length;
    this._columns.splice(Math.min(index, this._columns.length), 0, col);
    this._columns.forEach((c, i) => (c.colNum = i));
    this.invalidate(InvalidationType.SIZE);
    return col;
  }

  removeColumnAt(index) {
    const col = this._columns.splice(index, 1)[0];
    this._columns.forEach((c, i) => (c.colNum = i));
    this.invalidate(InvalidationType.SIZE);
    return col;
  }

  removeAllColumns() {
    this._columns = [];
    this.invalidate(InvalidationType.SIZE);
  }

  getColumnAt(index) {
    return this._columns[index];
  }

  getColumnCount() {
    return this._columns.length;
  }

  getColumnIndex(name) {
    return this._columns.findIndex((c) => c.dataField === name || c.headerText === name);
  }

  /**
   * 平均分配列宽（对齐 AS3 spaceColumnsEqually）。
   */
  spaceColumnsEqually() {
    if (!this._visibleColumns.length) return;
    const total = this.availableWidth();
    const w = Math.max(this._minColumnWidth || 20, Math.floor(total / this._visibleColumns.length));
    this._visibleColumns.forEach((c) => {
      c.setWidth(w);
      c.explicitWidth = null;
    });
    this.invalidate(InvalidationType.SIZE);
  }

  /**
   * 调整列宽（对齐 AS3 resizeColumn，受 minColumnWidth 约束）。
   */
  resizeColumn(index, width) {
    const col = this._columns[index];
    if (!col) return;
    const min = this._minColumnWidth || col.minWidth;
    col.setWidth(Math.max(min, width));
    col.explicitWidth = col.width;
    this.invalidate(InvalidationType.SIZE);
  }

  get minColumnWidth() {
    return this._minColumnWidth;
  }

  set minColumnWidth(value) {
    this._minColumnWidth = value;
    this.invalidate(InvalidationType.SIZE);
  }

  get showHeaders() {
    return this._showHeaders;
  }

  set showHeaders(value) {
    this._showHeaders = !!value;
    this.dataset.showHeaders = String(this._showHeaders);
    this.invalidate(InvalidationType.SIZE);
  }

  get headerHeight() {
    return this._headerHeight;
  }

  set headerHeight(value) {
    this._headerHeight = Math.max(1, value);
    this.invalidate(InvalidationType.SIZE);
  }

  get rowHeight() {
    return this._rowHeight;
  }

  set rowHeight(value) {
    this._rowHeight = Math.max(1, value);
    this.invalidate(InvalidationType.SIZE);
  }

  get labelFunction() {
    return this._labelFunction;
  }

  set labelFunction(value) {
    this._labelFunction = value;
    this.invalidate(InvalidationType.DATA);
  }

  get sortIndex() {
    return this._sortIndex;
  }

  get sortDescending() {
    return this._sortDescending;
  }

  get rowCount() {
    const availH = this.availableHeight();
    return Math.max(0, Math.floor(availH / this._rowHeight));
  }

  set rowCount(value) {
    const h = this._rowHeight * Math.max(0, value | 0);
    this.setSize(this.width, h + (this._showHeaders ? this._headerHeight : 0));
  }

  // ---- 可视区计算（对齐 AS3 calculateAvailableSize）------------------------
  availableWidth() {
    return this.width - (this.needVScroll() ? SCROLL_BAR_WIDTH : 0);
  }

  availableHeight() {
    return this.height - (this._showHeaders ? this._headerHeight : 0) - (this.needHScroll() ? SCROLL_BAR_WIDTH : 0);
  }

  needVScroll() {
    if (!this._vScroll) return false;
    return this.length * this._rowHeight > this.height - (this._showHeaders ? this._headerHeight : 0);
  }

  needHScroll() {
    if (!this._hScroll) return false;
    const totalW = this._visibleColumns.reduce((s, c) => s + c.width, 0);
    return totalW > this.width - SCROLL_BAR_WIDTH;
  }

  // 对齐 AS3 calculateColumnSizes：显式宽度优先，剩余平均分配
  calculateColumnSizes() {
    this._visibleColumns = this._columns.filter((c) => c.visible);
    if (!this._visibleColumns.length) {
      this._displayableColumns = [];
      return;
    }
    const availW = this.availableWidth();
    const totalExplicit = this._visibleColumns.reduce(
      (s, c) => s + (c.explicitWidth != null ? c.width : 0),
      0
    );
    const flexColumns = this._visibleColumns.filter((c) => c.explicitWidth == null);
    if (flexColumns.length > 0) {
      const remain = Math.max(0, availW - totalExplicit);
      const each = Math.max(this._minColumnWidth || 20, Math.floor(remain / flexColumns.length));
      flexColumns.forEach((c) => c.setWidth(each));
    }
    // 最后一列拉伸填满剩余（对齐 AS3 drawList 的末列补齐）
    const total = this._visibleColumns.reduce((s, c) => s + c.width, 0);
    if (total < availW) {
      const last = this._visibleColumns[this._visibleColumns.length - 1];
      last.setWidth(last.width + (availW - total));
    }
    this._displayableColumns = this._visibleColumns.concat();
  }

  // ---- 数据提供者 ---------------------------------------------------------
  set dataProvider(value) {
    super.dataProvider = value;
  }

  get dataProvider() {
    return super.dataProvider;
  }

  // ---- 单元格取值（对齐 AS3 columnItemToLabel）----------------------------
  columnItemToLabel(colNum, item) {
    const col = this._columns[colNum];
    return col ? col.itemToLabel(item) : ' ';
  }

  getCellRendererAt(row, col) {
    const pool = this._rendererPools[col];
    if (!pool) return null;
    return pool.active.find((r) => r.listData && r.listData.index === row) || null;
  }

  // ---- 重绘 ---------------------------------------------------------------
  draw(invalidHash) {
    if (invalidHash[InvalidationType.SIZE] || invalidHash[InvalidationType.ALL]) {
      this.calculateColumnSizes();
      this.drawLayout();
    }
    // 对齐 AS3 DataGrid.draw：drawList 在 STYLES/SIZE/DATA/SCROLL/SELECTED 任一失效时都执行
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
    this._bgEl.style.inset = '0';
    const showH = this._showHeaders;
    this._headerEl.style.display = showH ? '' : 'none';
    const bodyTop = showH ? this._headerHeight : 0;
    this._headerEl.style.height = this._headerHeight + 'px';
    this._bodyEl.style.top = bodyTop + 'px';
    this._bodyEl.style.left = '0px';
    this._bodyEl.style.right = '0px';
    this._bodyEl.style.bottom = '0px';
    this._headerEl.style.left = -this._horizontalScrollPosition + 'px';

    // 纵向滚动条
    this._vScroll.style.display = '';
    this._vScroll.style.right = '0px';
    this._vScroll.style.top = bodyTop + 'px';
    this._vScroll.style.width = SCROLL_BAR_WIDTH + 'px';
    this._vScroll.style.height = this.height - bodyTop + 'px';
    const availH = this.availableHeight();
    const contentH = Math.max(0, this.length * this._rowHeight);
    this._vScroll.setScrollProperties(availH, 0, Math.max(0, contentH - availH), availH);
    this._vScroll.scrollPosition = this._verticalScrollPosition;

    // 横向滚动条
    const totalW = this._visibleColumns.reduce((s, c) => s + c.width, 0);
    if (totalW > this.width - SCROLL_BAR_WIDTH) {
      this._hScroll.style.display = '';
      this._hScroll.style.left = '0px';
      this._hScroll.style.bottom = '0px';
      this._hScroll.style.width = this.width + 'px';
      this._hScroll.style.height = SCROLL_BAR_WIDTH + 'px';
      this._hScroll.setScrollProperties(this.width, 0, Math.max(0, totalW - this.width), this.width);
      this._hScroll.scrollPosition = this._horizontalScrollPosition;
    } else {
      this._hScroll.style.display = 'none';
    }
  }

  // 对齐 AS3 DataGrid.drawList：表头渲染 + 行渲染池 + 像素级滚动
  drawList() {
    if (!this._innerEl) return;
    this.drawHeader();
    const len = this.length;
    const rowH = this._rowHeight;
    const first = Math.min(Math.max(len - 1, 0), Math.floor(this._verticalScrollPosition / rowH));
    const last = Math.min(Math.max(len - 1, 0), first + this.rowCount + 1);

    // 可视项集合（用 Map 承载对象键，等价 AS3 Dictionary）
    const visibleItems = new Map();
    for (let i = first; i <= last; i++) {
      if (len > 0) visibleItems.set(this._dataProvider.getItemAt(i), true);
    }

    // 回收所有列中不可见的渲染器
    for (const colNum in this._rendererPools) {
      const pool = this._rendererPools[colNum];
      for (let i = pool.active.length - 1; i >= 0; i--) {
        const r = pool.active[i];
        if (!visibleItems.has(r.data) || this._invalidItems.has(r.data)) {
          if (r.isConnected) r.remove();
          pool.active.splice(i, 1);
          pool.available.push(r);
        }
      }
    }

    // 计算各列 x 起点
    let x = 0;
    const colX = [];
    for (const col of this._displayableColumns) {
      colX.push(x);
      x += col.width;
    }
    // body 水平偏移
    this._innerEl.style.transform = `translateX(${-this._horizontalScrollPosition}px)`;

    // 逐列渲染
    this._displayableColumns.forEach((col, cIdx) => {
      const poolKey = col.colNum;
      if (!this._rendererPools[poolKey]) this._rendererPools[poolKey] = { available: [], active: [] };
      const pool = this._rendererPools[poolKey];
      const activeByData = new Map();
      for (const r of pool.active) activeByData.set(r.data, r);

      for (let row = first; row <= last; row++) {
        if (len <= 0) break;
        const itemData = this._dataProvider.getItemAt(row);
        let renderer = activeByData.get(itemData);
        if (!renderer) {
          renderer = pool.available.pop() || this._createCellRenderer(col);
          pool.active.push(renderer);
          if (!renderer.isConnected) this._innerEl.appendChild(renderer);
        }
        renderer.style.position = 'absolute';
        renderer.style.left = colX[cIdx] + 'px';
        renderer.style.top = row * rowH - this._verticalScrollPosition + 'px';
        renderer.style.width = col.width + 'px';
        renderer.style.height = rowH + 'px';
        renderer.data = itemData;
        renderer.listData = new ListData(this.columnItemToLabel(col.colNum, itemData), null, this, row, row, cIdx);
        renderer.selected = this._selectedIndices.indexOf(row) !== -1;
        renderer.enabled = this.enabled;
        this._invalidItems.delete(itemData);
        // 同步重绘渲染器（label/selected 的失效要下一帧才落到 DOM，见 ts-list.js 注释）
        renderer.drawNow();
      }
    });
  }

  // 表头渲染（对齐 AS3 drawList 的 header 部分）
  drawHeader() {
    this._headerEl.innerHTML = '';
    let x = 0;
    const availW = this.availableWidth();
    this._displayableColumns.forEach((col, idx) => {
      const cell = document.createElement('div');
      cell.className = 'ts-header-cell';
      cell.textContent = col.headerText;
      cell.style.left = x + 'px';
      cell.style.width = col.width + 'px';
      cell.dataset.mouseState = 'up';
      // 排序箭头（对齐 AS3 HeaderSortArrow_ascIcon/descIcon）
      if (this._sortIndex === col.colNum || (this._sortIndex === -1 && this._lastSortIndex === col.colNum)) {
        cell.dataset.sort = this._sortDescending ? 'desc' : 'asc';
      }
      // 表头点击排序
      if (this.sortableColumns && col.sortable) {
        cell.addEventListener('mousedown', (e) => {
          cell.dataset.mouseState = 'down';
          e.preventDefault();
        });
        cell.addEventListener('mouseup', (e) => {
          cell.dataset.mouseState = 'over';
          this._headerRelease(col, e);
        });
        cell.addEventListener('mouseover', () => (cell.dataset.mouseState = 'over'));
        cell.addEventListener('mouseout', () => (cell.dataset.mouseState = 'up'));
      }
      this._headerEl.appendChild(cell);

      // 列拉伸分隔条（对齐 AS3 columnDividerSkin + ColumnStretch_cursor）
      if (idx < this._displayableColumns.length - 1 && this.resizableColumns && col.resizable) {
        const stretcher = document.createElement('div');
        stretcher.className = 'ts-col-stretcher';
        stretcher.style.left = x + col.width + 'px';
        stretcher.dataset.mouseState = 'up';
        stretcher.addEventListener('mouseover', () => (stretcher.dataset.mouseState = 'over'));
        stretcher.addEventListener('mouseout', () => (stretcher.dataset.mouseState = 'up'));
        stretcher.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._startColumnStretch(col, e.clientX);
        });
        this._headerEl.appendChild(stretcher);
      }
      x += col.width;
    });
  }

  _createCellRenderer(col) {
    const RendererClass = (col && col.cellRenderer) || this.getStyleValue('cellRenderer') || TsCellRenderer;
    const renderer = new RendererClass();
    renderer.classList.add('ts-cell');
    renderer.addEventListener('click', (e) => this._handleCellRendererClick(e, renderer));
    renderer.addEventListener('dblclick', (e) => this._handleCellRendererDoubleClick(e, renderer));
    renderer.addEventListener('mouseover', (e) =>
      this._handleCellRendererMouseEvent(e, renderer, ListEvent.ITEM_ROLL_OVER)
    );
    renderer.addEventListener('mouseout', (e) =>
      this._handleCellRendererMouseEvent(e, renderer, ListEvent.ITEM_ROLL_OUT)
    );
    for (const name in this.rendererStyles) {
      renderer.setStyle(name, this.rendererStyles[name]);
    }
    return renderer;
  }

  // ---- 表头排序（对齐 AS3 handleHeaderRendererClick + headerRelease）------
  _headerRelease(col, mouseEvent) {
    const dgEvent = new DataGridEvent(
      DataGridEvent.HEADER_RELEASE,
      false,
      true,
      col.colNum,
      -1,
      null,
      col.dataField,
      null
    );
    this.dispatchEvent(dgEvent);
    if (dgEvent.defaultPrevented) return;
    if (!this.sortableColumns || !col.sortable) return;

    if (this._sortIndex === col.colNum) {
      this._sortDescending = !this._sortDescending;
    } else {
      this._lastSortIndex = this._sortIndex;
      this._sortIndex = col.colNum;
      this._sortDescending = false;
    }
    col.sortDescending = this._sortDescending;
    // 排序数据（sortCompareFunction 优先，否则 sortOn(dataField)）
    if (col.sortCompareFunction) {
      this._dataProvider.sort(col.sortCompareFunction);
    } else {
      this._dataProvider.sortOn(col.dataField);
      if (this._sortDescending) this._dataProvider.data.reverse();
    }
    this.invalidate(InvalidationType.DATA);
  }

  // ---- 列拉伸（对齐 AS3 handleHeaderResizeDown / stretchColumn）-----------
  _startColumnStretch(col, startX) {
    const startWidth = col.width;
    const onMove = (e) => {
      const w = startWidth + (e.clientX - startX);
      this.resizeColumn(col.colNum, w);
      this.dispatchEvent(
        new DataGridEvent(DataGridEvent.COLUMN_STRETCH, false, false, col.colNum, -1, null, col.dataField, null)
      );
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ---- 单元格编辑（对齐 AS3 createItemEditor / destroyItemEditor）---------
  get editedItemPosition() {
    return this._editedItemPosition;
  }

  set editedItemPosition(value) {
    this._proposedEditedItemPosition = value;
    this._editedItemPositionChanged = true;
    this.invalidate(InvalidationType.SELECTED);
  }

  get editedItemRenderer() {
    if (!this._editedItemPosition) return null;
    return this.getCellRendererAt(this._editedItemPosition.rowIndex, this._editedItemPosition.columnIndex);
  }

  get itemEditorInstance() {
    return this._itemEditorInstance;
  }

  editField(row, dataField, data) {
    const item = this._dataProvider.getItemAt(row);
    if (item) {
      item[dataField] = data;
      this._dataProvider.invalidateItem(item);
    }
  }

  createItemEditor(colIndex, rowIndex) {
    const col = this._columns[colIndex];
    if (!col) return;
    this.destroyItemEditor();
    const editor = document.createElement('div');
    editor.className = 'ts-cell-editor';
    const input = document.createElement('input');
    input.type = 'text';
    editor.appendChild(input);
    this._innerEl.appendChild(editor);
    editor.style.left = this._columns.slice(0, colIndex).reduce((s, c) => s + c.width, 0) + 'px';
    editor.style.top = rowIndex * this._rowHeight - this._verticalScrollPosition + 'px';
    editor.style.width = col.width + 'px';
    input.value = this.columnItemToLabel(colIndex, this._dataProvider.getItemAt(rowIndex));
    this._itemEditorInstance = editor;
    this._editedItemPosition = { rowIndex, columnIndex: colIndex };

    const commit = (reason) => {
      const newData = input.value;
      const oldData = this._dataProvider.getItemAt(rowIndex)[col.dataField];
      // 派发 itemEditEnd（可取消，对齐 AS3）
      const endEvent = new DataGridEvent(
        DataGridEvent.ITEM_EDIT_END,
        false,
        true,
        colIndex,
        rowIndex,
        this.getCellRendererAt(rowIndex, colIndex),
        col.dataField,
        reason
      );
      this.dispatchEvent(endEvent);
      if (endEvent.defaultPrevented) return;
      if (col.editorDataField) {
        this._dataProvider.getItemAt(rowIndex)[col.dataField] = newData;
      }
      this.destroyItemEditor();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(DataGridEventReason.NEW_ROW);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(DataGridEventReason.CANCELLED);
      }
    });
    input.addEventListener('blur', () => commit(DataGridEventReason.OTHER));
    input.focus();
    this.dispatchEvent(
      new DataGridEvent(DataGridEvent.ITEM_EDIT_BEGIN, false, true, colIndex, rowIndex, null, col.dataField, null)
    );
  }

  destroyItemEditor() {
    if (this._itemEditorInstance) {
      this._itemEditorInstance.remove();
      this._itemEditorInstance = null;
      this._editedItemPosition = null;
    }
  }

  // ---- 单元格交互 ---------------------------------------------------------
  _handleCellRendererDoubleClick(e, renderer) {
    const ld = renderer.listData;
    const col = this._columns[ld.column];
    if (this.editable && col && col.editable) {
      // 对齐 AS3：双击进入编辑
      this.dispatchEvent(
        new DataGridEvent(
          DataGridEvent.ITEM_EDIT_BEGINNING,
          false,
          true,
          ld.column,
          ld.index,
          renderer,
          col.dataField,
          null
        )
      );
      this.createItemEditor(ld.column, ld.index);
      return;
    }
    super._handleCellRendererDoubleClick(e, renderer);
  }

  // ---- 键盘 ---------------------------------------------------------------
  _keyDownHandler(e) {
    if (!this.enabled || this.length === 0) return;
    if (this._itemEditorInstance) return; // 编辑中不处理
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
    }
    if (handled) {
      e.preventDefault();
      if (newIndex !== this.selectedIndex) {
        this.selectedIndex = newIndex;
        this.scrollToIndex(newIndex);
      }
    }
  }

  // ---- 滚动（对齐 AS3 DataGrid.scrollToIndex）-----------------------------
  scrollToIndex(newIndex) {
    if (newIndex < 0 || newIndex >= this.length) return;
    const first = Math.floor(this._verticalScrollPosition / this._rowHeight);
    const last = first + this.rowCount;
    if (newIndex < first) {
      this._vScroll.scrollPosition = newIndex * this._rowHeight;
    } else if (newIndex >= last) {
      this._vScroll.scrollPosition = (newIndex + 1) * this._rowHeight - this.availableHeight();
    }
  }
}

customElements.define('ts-datagrid', TsDataGrid);

export default TsDataGrid;
