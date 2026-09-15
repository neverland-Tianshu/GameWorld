// index.js — AS3 组件库 Web Components 版 · 聚合入口
//
// 用法：
//   import { registerAll, TsButton, DataProvider } from './js/ui/components/index.js?v=20261007c';
//   registerAll();  // 注册全部自定义元素
//
//   或按需引入（注册即生效）：
//   import './js/ui/components/ts-button.js?v=20261007c';

import { UIComponent, InvalidationType, StyleManager } from './ts-base.js?v=20261007c';
import {
  ComponentEvent,
  ScrollEvent,
  ListEvent,
  DataGridEvent,
  DataChangeEvent,
  DataChangeType,
  ScrollBarDirection,
  ScrollPolicy,
} from './ts-base.js?v=20261007c';
import { TsBaseButton, TsLabelButton, TsButton, ButtonLabelPlacement } from './ts-button.js?v=20261007c';
import { TsTextInput } from './ts-textinput.js?v=20261007c';
import { TsTextArea } from './ts-textarea.js?v=20261007c';
import { TsScrollBar, TsUIScrollBar } from './ts-scrollbar.js?v=20261007c';
import { TsScrollPane } from './ts-scrollpane.js?v=20261007c';
import { TsList, TsSelectableList, TsCellRenderer, ListData, DataProvider } from './ts-list.js?v=20261007c';
import { TsComboBox } from './ts-combobox.js?v=20261007c';
import { TsDataGrid, DataGridColumn } from './ts-datagrid.js?v=20261007c';
import { TsTree, TreeDataProvider, TsTreeCellRenderer } from './ts-tree.js?v=20261007c';

/**
 * 注册全部自定义元素（重复注册会抛错，故先检查）。
 * 组件 import 时已各自注册，这里主要保证副作用 import 顺序。
 */
export function registerAll() {
  const defined = (name) => customElements.get(name) != null;
  const names = [
    'ts-button',
    'ts-textinput',
    'ts-textarea',
    'ts-scrollbar',
    'ts-uiscrollbar',
    'ts-scrollpane',
    'ts-list',
    'ts-cell-renderer',
    'ts-combobox',
    'ts-datagrid',
    'ts-tree',
    'ts-tree-cell-renderer',
  ];
  const missing = names.filter((n) => !defined(n));
  if (missing.length) {
    // 各模块在 import 时已注册；若走到这里说明模块加载异常，给出明确报错
    throw new Error('ts-components 注册不完整，缺失：' + missing.join(', '));
  }
  return true;
}

// ---- 再导出全部公共 API ---------------------------------------------------
export {
  // 基础
  UIComponent,
  InvalidationType,
  StyleManager,
  // 事件
  ComponentEvent,
  ScrollEvent,
  ListEvent,
  DataGridEvent,
  DataChangeEvent,
  DataChangeType,
  // 常量
  ScrollBarDirection,
  ScrollPolicy,
  ButtonLabelPlacement,
  // 组件
  TsBaseButton,
  TsLabelButton,
  TsButton,
  TsTextInput,
  TsTextArea,
  TsScrollBar,
  TsUIScrollBar,
  TsScrollPane,
  TsSelectableList,
  TsList,
  TsCellRenderer,
  TsComboBox,
  TsDataGrid,
  DataGridColumn,
  TsTree,
  TsTreeCellRenderer,
  // 数据
  DataProvider,
  TreeDataProvider,
  ListData,
};

export default { registerAll };
