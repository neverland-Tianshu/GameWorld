// ts-tree.js — 树组件
// 移植自：component.Tree + component.treeClasses.TreeDataProvider +
//         component.treeClasses.TreeCellRenderer（UIComponent.swf 中的自定义组件，
//         另有 com.yahoo.astra.fl.controls.Tree 同名实现，二选一取 component 包版本）
//
// 关键对齐点：
//   - TreeDataProvider：XML 解析成节点表（nodeLevel/nodeType/nodeState/
//     nodeChildren/parentNode），toggleNode(index) 展开/折叠
//   - Tree 继承 List：节点点击即切换展开折叠（nodeClick），open(label) 按标签展开
//   - TreeCellRenderer：按 nodeLevel 缩进 + 展开/折叠图标（▶/▼）
//
// 数据格式（对齐 AS3 TreeDataProvider 的节点对象）：
//   { label, nodeLevel, nodeType: 'branchNode'|'leafNode',
//     nodeState: 'openNode'|'closedNode', nodeChildren: [...], parentIndex }
//   或直接给 XML 字符串 / Document。
//
// 自定义元素：<ts-tree>

import { UIComponent, InvalidationType, ListEvent, DataChangeEvent, DataChangeType } from './ts-base.js?v=20261007c';
import { TsList, DataProvider } from './ts-list.js?v=20261007c';
import { TsCellRenderer } from './ts-list.js?v=20261007c';

// 节点类型/状态常量（对齐 component.treeClasses.TreeDataProvider）
export const OPEN_NODE = 'openNode';
export const CLOSED_NODE = 'closedNode';
export const BRANCH_NODE = 'branchNode';
export const LEAF_NODE = 'leafNode';
const INDENT = 18; // 每级缩进像素

// ===========================================================================
// TreeDataProvider（component.treeClasses.TreeDataProvider extends DataProvider）
// ===========================================================================
export class TreeDataProvider extends DataProvider {
  constructor(value = null) {
    super(value);
  }

  // 对齐 AS3 getDataFromObject：只接受 XML（或已是 TreeDataProvider/空数组）
  getDataFromObject(value) {
    if (value instanceof TreeDataProvider) return value.toArray();
    if (Array.isArray(value)) {
      // 允许直接给节点数组（补全缺失的树字段）
      return value.map((item) => normalizeNode(item));
    }
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
      Array.from(doc.documentElement.children).forEach((el) => parseXMLNode(el, null, 0, out));
      return out;
    }
    return [];
  }

  /**
   * 展开/折叠节点（对齐 AS3 toggleNode）。
   * @param {number} index 节点在扁平表中的索引
   */
  toggleNode(index) {
    const node = this.getItemAt(index);
    if (!node || node.nodeType !== BRANCH_NODE) return;
    if (node.nodeState === CLOSED_NODE) {
      node.nodeState = OPEN_NODE;
      this.expandNode(index);
    } else {
      node.nodeState = CLOSED_NODE;
      this.collapseNode(index);
    }
    // 通知视图重绘（用 DataChangeEvent，让 List.handleDataChange 能读到字段）
    this.dispatchEvent(
      new DataChangeEvent(
        DataChangeEvent.DATA_CHANGE,
        DataChangeType.INVALIDATE,
        0,
        this.length - 1,
        this.data.slice()
      )
    );
  }

  // 对齐 AS3 expandNode：把子节点插入到父节点之后
  expandNode(index) {
    const node = this.getItemAt(index);
    const toAdd = [];
    collectOpenChildren(node, toAdd);
    toAdd.forEach((child, i) => this.addItemAt(child, index + 1 + i));
  }

  // 对齐 AS3 collapseNode：移除该节点之后所有更深层级的节点
  collapseNode(index) {
    const nodeLevel = this.getItemAt(index).nodeLevel;
    let cursor = index + 1;
    while (cursor < this.length && this.getItemAt(cursor).nodeLevel > nodeLevel) {
      this.removeItemAt(cursor);
    }
  }

  getBranchNodes() {
    return this.data.filter((n) => n.nodeType === BRANCH_NODE);
  }

  isBranch(index) {
    const n = this.getItemAt(index);
    return n && n.nodeType === BRANCH_NODE;
  }

  isOpen(index) {
    const n = this.getItemAt(index);
    return n && n.nodeState === OPEN_NODE;
  }
}

function collectOpenChildren(node, out) {
  if (!node || !node.nodeChildren) return;
  for (const child of node.nodeChildren) {
    out.push(child);
    if (child.nodeType === BRANCH_NODE && child.nodeState === OPEN_NODE) {
      collectOpenChildren(child, out);
    }
  }
}

function normalizeNode(item) {
  const node = Object.assign({}, item);
  if (node.nodeLevel == null) node.nodeLevel = 0;
  if (node.nodeType == null) node.nodeType = node.nodeChildren ? BRANCH_NODE : LEAF_NODE;
  if (node.nodeState == null) node.nodeState = CLOSED_NODE;
  if (node.parentIndex == null) node.parentIndex = -1;
  return node;
}

// 对齐 AS3 parseXMLNode：XML → 节点对象（属性成为字段，子节点进 nodeChildren）
function parseXMLNode(xmlNode, parent, level, out) {
  const node = { nodeLevel: level, parentNode: parent };
  const hasChildren = xmlNode.children.length > 0;
  node.nodeType = hasChildren ? BRANCH_NODE : LEAF_NODE;
  node.nodeState = CLOSED_NODE;
  if (hasChildren) node.nodeChildren = [];
  // 属性
  for (const attr of Array.from(xmlNode.attributes)) {
    node[attr.localName] = attr.value;
  }
  // 无属性时用标签名当 label
  if (node.label == null) node.label = xmlNode.localName;
  if (parent == null) {
    out.push(node);
  } else {
    parent.nodeChildren.push(node);
  }
  for (const child of Array.from(xmlNode.children)) {
    parseXMLNode(child, node, level + 1, out);
  }
}

// ===========================================================================
// TreeCellRenderer（component.treeClasses.TreeCellRenderer extends CellRenderer）
// ===========================================================================
export class TsTreeCellRenderer extends TsCellRenderer {
  constructor() {
    super();
  }

  // 覆盖图标绘制：用展开/折叠箭头替代普通图标（对齐 AS3 drawIcon 的节点图标逻辑）
  drawIcon() {
    const data = this._data;
    if (!data || data.nodeType !== BRANCH_NODE) {
      // 叶子节点不显示展开箭头
      if (this._iconEl) this._iconEl.style.display = 'none';
      return;
    }
    if (!this._iconEl) return;
    this._iconEl.style.display = '';
    this._iconEl.className = 'ts-icon ts-node-toggle';
    this._iconEl.textContent = data.nodeState === OPEN_NODE ? '▼' : '▶';
    this._iconEl.style.width = '14px';
    this._iconEl.style.textAlign = 'center';
  }

  // 覆盖布局：按 nodeLevel 缩进（对齐 AS3 TreeCellRenderer 的层级缩进）
  drawLayout() {
    if (!this._contentEl) return;
    const level = (this._data && this._data.nodeLevel) || 0;
    this._iconEl.style.order = 1;
    this._labelEl.style.order = 2;
    this._contentEl.style.flexDirection = 'row';
    this._contentEl.style.paddingLeft = level * INDENT + 'px';
    const padding = Number(this.getStyleValue('textPadding')) || 0;
    this._labelEl.style.padding = '0 ' + padding + 'px';
    this._bgEl.style.inset = '0';
    // 有图标的点击切换（由 Tree 的 itemClick 统一处理，这里不重复）
  }
}

customElements.define('ts-tree-cell-renderer', TsTreeCellRenderer);

// ===========================================================================
// Tree（component.Tree extends List）
// ===========================================================================
export class TsTree extends TsList {
  static get observedAttributes() {
    return [...super.observedAttributes, 'label-field'];
  }

  constructor() {
    super();
    // 对齐 AS3 Tree 构造：默认 cellRenderer = TreeCellRenderer
    this.setStyle('cellRenderer', TsTreeCellRenderer);
    this.addEventListener(ListEvent.ITEM_CLICK, (e) => this._nodeClick(e));
    this.addEventListener(ListEvent.ITEM_DOUBLE_CLICK, (e) => this._nodeClick(e));
    this._suppressToggle = false;
  }

  /**
   * dataProvider 只接受 TreeDataProvider（对齐 AS3 的类型约束）。
   */
  set dataProvider(value) {
    const dp = value instanceof TreeDataProvider ? value : new TreeDataProvider(value);
    // SelectableList 的 dataProvider setter 需要 DataProvider 实例；TreeDataProvider 是其子类
    super.dataProvider = dp;
  }

  get dataProvider() {
    return super.dataProvider;
  }

  // 对齐 AS3 Tree.open(label)：按标签名展开节点
  open(label = null) {
    const dp = this.dataProvider;
    if (!(dp instanceof TreeDataProvider)) return;
    if (label == null) {
      if (dp.length > 0) dp.toggleNode(0);
      return;
    }
    for (let i = 0; i < dp.length; i++) {
      if (dp.getItemAt(i).label === label) dp.toggleNode(i);
    }
  }

  // 对齐 AS3 Tree.nodeClick：点击节点即切换展开/折叠
  _nodeClick(e) {
    if (this._suppressToggle) return;
    const dp = this.dataProvider;
    if (!(dp instanceof TreeDataProvider)) return;
    const idx = e.detail.index;
    if (idx >= 0 && dp.isBranch(idx)) {
      dp.toggleNode(idx);
      // toggleNode 已派发 dataChange，List 会重绘
    }
  }

  // 选中节点时不要因高亮而误触发展开（AS3 中选中与展开是两次独立点击，Web 里点击同时触发，
  // 这里保留 AS3 行为：单击即切换展开，同时选中）
}

customElements.define('ts-tree', TsTree);

export default TsTree;
