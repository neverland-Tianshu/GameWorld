// ui/city-face.js
// 左上角「城市信息/功能」浮层，1:1 对齐 deobfuscated/face/CityFace.as
// （原混淆类名 _08925b27c43768b003e4f4f4db0d5b33；继承 FaceSprite）。
//
// ── 拼装真源（CityFace.as）────────────────────────────────────────────
// initBG(:66-72)：5 张底图按 addChild 顺序自下而上叠加
//     face_topleft_1(0,0) → face_topleft_2(23,0) → face_topleft_3(99,0)
//     → face_topleft_4(119,7) → face_city(0,1,230×34，卷轴条，压最上)
//   ★ 4 张 topleft 是竖向下垂的镂空花样装饰件（不是横条），左边缘首尾相接
//     拼成 x=0..136、下垂到 y=132 的底衬；卷轴条盖住其上半部。
// 文本（UtilUtil02.getTextField(color,12,false)，左对齐 autoSize=LEFT）：
//     cityField  (60−textWidth/2, 4)  色 26112=#006600  按实测字宽居中于 x=60
//     roadPointX (148,4) / roadPointY (188,4)  色 13056=#003300
//     lineField  (Face_Line.x+24=156, 32)  色 13056=#003300  = SERVER_NAME 末 2 字
//     ★ 卷轴图 face_city 内已自带 "X"/"Y" 字样，故坐标文本只显数字。
// initButton(:85-118)：ShowplayerButton(图标画在 layout.x/y，位图原尺寸)，
//     布局真源 = layout.xml（在 D:/tsqt/Game/update/i18n/zh_CN/layout.xml，不在本仓库）：
//     Face_Chest(0,28) / Face_Map(83,30) / Face_Mall(32,30) / Face_NPC(37,74)
//     Face_System(3,62) / Face_Board(13,99) / Face_Line(132,28) / Face_Petchest(78,89)
//     Face_Guide(38,120) / Face_Hideplayer(93,60)
//   ★ z 序：5 底图 → 坐标文本 → 按钮(创建序) → lineSprite → lineField → cityField；
//     showplayerButton 第 89 行建、第 116 行才挂 ⇒ 叠在所有按钮最上层。
//   ★ ISHAD_PETCHEST 无初值 ⇒ 默认 false ⇒ 宠物仙葫按钮默认不创建（同 AS3）。
// initLine(:170-185)：换线箭头 face_arrow0~3(12×12) @ (188,36)，一次只显一档；
//     setRate 阈值 ≤200/≤500/≤1000/>1000ms。单机版无服务器延迟 ⇒ 恒显 0 档（绿）。
//
// ── 资源命名规则（本工程统一）────────────────────────────────────────
// AS3 符号名去下划线 + 大写转小写：face_topleft_1 → facetopleft1.png …
// 出口 url.res('xxx.png')（globals.js）；箭头在 LoginResource/icons/（url.resLogin）。
//
// ── 迁移口径（需求）────────────────────────────────────────────────────
// 「有的功能对接，没有的功能占位」：
//     Face_Map     → panelManager.toggle('minimap')  打开/关闭小地图面板（点击打开，再点关闭）
//     Face_System  → settings 面板（快捷键 S 的功能）
//     Face_Mall    → shop 面板（商城）
//     Face_Chest   → chest 面板（仙葫/宝箱）
//     其余按钮     → 占位：toast「（功能未实装）」，视觉保持原版
// 城名取当前地图名（Config.maps / scene.map.name）；坐标取玩家 RP 格（MapSystem.getGridPos），
//   与小地图面板悬浮读数同口径。lineField（区名）单机版无服务器 ⇒ 留空（AS3 默认亦无初值）。

import { url, Config } from '../core/globals.js?v=20261007c';
import { MapSystem } from '../core/map.js?v=20261007c';
import { panelManager } from './panel-manager.js?v=20261007c';
import { playSfx } from '../core/sound.js?v=20261007c';

// [layout 组, x, y, 图标文件, 悬停提示, 点击行为]
//   行为：{panel:'xxx'} = 对接已有面板（toggle）；{ph:'中文名'} = 占位 toast。
const BUTTONS = [
  ['Face_Chest',       0,   28, 'facechest',     '打开仙葫（快捷键 R）',   { panel: 'chest' }],
  ['Face_Map',        83,   30, 'facemap',       '查看地图（快捷键 Tab）', { panel: 'minimap' }],
  ['Face_Mall',       32,   30, 'faceshop',      '道具商场（快捷键 M）',   { panel: 'shop' }],
  ['Face_NPC',        37,   74, 'facenpc',       '路人列表（快捷键 W）',   { ph: '路人列表' }],
  ['Face_System',      3,   62, 'facesystem',    '系统设置（快捷键 S）',   { panel: 'settings' }],
  ['Face_Board',      13,   99, 'faceboard',     '公告（快捷键 G）',       { ph: '公告' }],
  ['Face_Line',      132,   28, 'facelineframe', '换线',                   { ph: '换线' }],
  // Face_Petchest：ISHAD_PETCHEST 默认 false ⇒ 不创建（对齐 AS3）
  ['Face_Guide',      38,  120, 'faceyin',       '玩法指引',               { ph: '玩法指引' }],
  // Face_Hideplayer：第 89 行建、116 行才挂 ⇒ z 序最高，放最后
  ['Face_Hideplayer', 93,   60, 'facehideplayer', '显示/隐藏玩家',         { ph: '隐藏玩家' }],
];

export class CityFace {
  constructor(ui) {
    this.ui = ui;
    this._city = '';      // 上次渲染的城名（变化时才重排居中）
    this._rp = '';        // 上次渲染的 "X,Y"（变化时才更新 DOM）
    this._build();
  }

  _build() {
    const dom = document.createElement('div');
    dom.className = 'city-face';
    this.dom = dom;

    // ① 5 张底图（addChild 顺序 = 自下而上）
    const bg = (key, x, y) => {
      const im = document.createElement('img');
      im.className = 'cf-bg'; im.draggable = false;
      im.src = url.res(key.replace(/_/g, '') + '.png');
      im.style.left = x + 'px'; im.style.top = y + 'px';
      dom.appendChild(im);
    };
    bg('face_topleft_1', 0, 0);
    bg('face_topleft_2', 23, 0);
    bg('face_topleft_3', 99, 0);
    bg('face_topleft_4', 119, 7);
    bg('face_city', 0, 1);          // 卷轴条，压在 4 张装饰件之上

    // ② 坐标文本（roadPointX / roadPointY）
    const mkTx = (cls, x, y) => {
      const el = document.createElement('span');
      el.className = 'cf-tx ' + cls;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      dom.appendChild(el);
      return el;
    };
    this.xTx = mkTx('cf-xy', 148, 4);
    this.yTx = mkTx('cf-xy', 188, 4);

    // ③ 按钮（创建序 = z 序）
    BUTTONS.forEach(([grp, x, y, icon, tip, act]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-btn' + (act.ph ? ' cf-ph' : '');
      b.style.left = x + 'px'; b.style.top = y + 'px';
      b.title = tip + (act.ph ? '（未实装）' : '');
      const im = document.createElement('img');
      im.draggable = false;
      im.src = url.res(icon + '.png');
      im.alt = tip;
      b.appendChild(im);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        playSfx('click');
        if (act.panel) {
          // 对接已有面板：toggle —— 点击打开，面板已存在则关闭（需求原话）
          panelManager.toggle(act.panel);
        } else if (this.ui && typeof this.ui.toast === 'function') {
          this.ui.toast('「' + act.ph + '」功能未实装');
        }
      });
      dom.appendChild(b);
    });

    // ④ 换线箭头（face_arrow0~3 @ (188,36)，单机无延迟恒显 0 档）
    const arrow = document.createElement('img');
    arrow.className = 'cf-bg'; arrow.draggable = false;
    arrow.src = url.resLogin('facearrow0.png');
    arrow.style.left = '188px'; arrow.style.top = '36px';
    dom.appendChild(arrow);

    // ⑤ lineField（区名 = SERVER_NAME 末 2 字；单机版无服务器 ⇒ 留空）
    this.lineTx = mkTx('cf-line', 156, 32);

    // ⑥ cityField（最后 addChild ⇒ 最上层；x = 60 − textWidth/2，tick 内动态算）
    this.cityTx = mkTx('cf-city', 60, 4);
  }

  // 主循环驱动（ui.updateHud → cityFace.tick）：刷新城名与坐标。
  // 仅在值变化时写 DOM；无玩家/场景时清空，绝不抛错。
  tick(player) {
    // ── 城名：优先当前场景地图，回退 ui._curMapId → Config.maps ──
    const sc = this.ui && this.ui.sm && this.ui.sm.current;
    const map = (sc && sc.map) || null;
    let city = (map && map.name) || '';
    if (!city) {
      const id = (sc && sc.map && sc.map.id) || (this.ui && this.ui._curMapId);
      const m = (Config.maps || []).find(x => x.id === id);
      city = (m && m.name) || '';
    }
    if (city !== this._city) {
      this._city = city;
      this.cityTx.textContent = city;
      // AS3 setCityText：x = 60 − textWidth/2（按实测字宽居中于 x=60）
      const w = this._textWidth(city);
      this.cityTx.style.left = (60 - w / 2) + 'px';
    }
    // ── 坐标（roadPointX/Y）：玩家 RP 格，与小地图面板同口径 ──
    let rp = '';
    if (player && typeof player.x === 'number') {
      const g = MapSystem.getGridPos(player.x, player.y);
      rp = g.col + ',' + g.row;
    }
    if (rp !== this._rp) {
      this._rp = rp;
      const [cx, cy] = rp.split(',');
      this.xTx.textContent = cx;
      this.yTx.textContent = cy;
    }
  }

  // 量字宽逼近 Flash textWidth（12px 本项目 HUD 字体栈）
  _textWidth(s) {
    if (!s) return 0;
    const cv = CityFace._cv || (CityFace._cv = document.createElement('canvas'));
    const ctx = cv.getContext('2d');
    ctx.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
    return ctx.measureText(s).width;
  }
}
