// map.js
// 严格移植自 D:/tsqt/Game/resource/js/MapAndPath.js（MapSystem + AStar）。
//
// ⚠ 坐标体系说明（关键，对齐原始 AS3 客户端）：
//   原版天书奇谈的"碰撞/寻路网格"与"贴图网格"是【两套分离的坐标系】：
//     - 贴图：14x14 俯视矩形切片（tileW=200, tileH=150），用于 _renderTiles 渲染；
//     - 寻路：42x126 等距菱形(RP)网格（tile_width=64, tile_height=32，2:1 视角），
//       即 config/map/map_info.json 的 pathfinding_mask。
//   原 AS3 用 UtilInitializer.transformXYToRP / transformRPToCXY 在"屏幕像素"与"菱形格(RP)"
//   之间互转（见 deobfuscated/util/UtilInitializer.as、map/GameMask.as、astar/AStar.as）。
//
//   本单机版：渲染继续走矩形 14x14（this.map.cols/rows/tileW/tileH，由 _renderTiles 读取）；
//   寻路/碰撞走真实 RP 网格（MapSystem.data，由 deriveFromMapInfo 注入的 pathMask 提供）。
//   两者坐标系分离——即"坐标与图像分离"。
//
//   ⚠ 世界尺寸（数据解析"发现"，已落地到 deriveFromMapInfo → map.stitchedW/stitchedH）：
//     镜头可显示区域的地图大小 = 格子拼合 = pathCols*RP_W × pathRows*(RP_H/2)
//       = grid_x*64 × grid_y*16（像素；新月村 42×64 × 126×16 = 2688×2016）。
//     贴图矩形世界(cols*tileW × rows*tileH = 2800×2100)仅用于渲染切片，是"名义尺寸"，
//     比真实内容(等距菱形映射后落在 ~2656×2000)略大；相机边界改用格子拼合更贴内容。
//
//   当 map.pathMask（42x126）存在时，MapSystem 走 RP 模式（isRP=true）：
//     getGridPos   = transformXYToRP(px)        屏幕像素 -> RP 格
//     getPixelPos  = transformRPToCXY(col,row)   RP 格 -> 屏幕像素(格心)
//     isWalkable   = mask 值 1 或 2 可走（0=阻挡；与 AS3 GameMask.isBlock 一致）
//     A* 邻居       = 等距交错 8 邻域（对齐 AStar.as getArounds）
//   否则退回旧矩形 14x14 模式（兼容无 pathMask 的地图）。

// ───────────── 等距菱形(RP)坐标变换（严格对齐 AS3 UtilInitializer） ─────────────
// 注：原版 transformXYToRP 含 masks 方向微调表（基于 map_path 资源图，对格内亚像素位置 ±1 修正）。
// 本单机版用基础公式：对菱形格【中心】完全精确（与 transformRPToCXY 互逆），对格内亚像素位置为近似——
// 满足单机寻路精度，且玩家/出生点/NPC 均落在格心，无误差。
const RP_W = 64;   // 菱形格宽（= map_info.tile_width）
const RP_H = 32;   // 菱形格高（= map_info.tile_height，2:1）

function transformRPToCXY(col, row) {
  if (row % 2 === 0) {
    return { x: col * RP_W, y: (row - 1) * RP_H / 2 + RP_H / 2 };
  }
  return { x: col * RP_W + RP_W / 2, y: (row - 1) * RP_H / 2 + RP_H / 2 };
}

function transformXYToRP(x, y) {
  const col = Math.floor(x / RP_W);
  const row = Math.floor(y / RP_H) * 2 + 1;
  return { col, row };
}

// ───────────────────────── 地图系统（切片缓存 + 寻路网格） ─────────────────────────
export const MapSystem = {
  // 地图基础配置数据（由 MainScene 调 load() 注入）
  config: null,
  // 渲染网格引用（矩形 14x14，仅供上层读取，寻路不依赖）
  render: null,
  // 网格元数据：瓦片宽高、网格行列数、寻路掩码（0 障碍，1/2 可行走）、是否 RP 等距模式
  data: { tile_width: 200, tile_height: 150, grid_x: 0, grid_y: 0, maxCol: 0, maxRow: 0, mask: [], isRP: false },
  // 已加载的地图切片缓存集合（key = "row_col"）
  tileMap: {},
  // 俯视矩形地图无错位的偏移校准
  OFFSET_X: 0, OFFSET_Y: 0,

  /**
   * 注入地图配置。优先采用真实等距寻路层 pathMask(42x126)；否则退回矩形 mask(14x14)。
   */
  load(map) {
    this.config = map;
    this.render = { cols: map.cols, rows: map.rows, tileW: map.tileW, tileH: map.tileH };
    if (map.pathMask && map.pathMask.length === map.pathCols * map.pathRows) {
      // —— RP 等距寻路模式（真实 pathfinding_mask）——
      this.data.tile_width = map.pathTileW || RP_W;
      this.data.tile_height = map.pathTileH || RP_H;
      this.data.grid_x = map.pathCols;
      this.data.grid_y = map.pathRows;
      this.data.maxCol = map.pathCols - 1;
      this.data.maxRow = map.pathRows - 1;
      this.data.mask = map.pathMask.slice();
      this.data.isRP = true;
    } else {
      // —— 旧矩形 14x14 模式（兼容无 pathMask 的地图）——
      const total = map.cols * map.rows;
      this.data.tile_width = map.tileW;
      this.data.tile_height = map.tileH;
      this.data.grid_x = map.cols;
      this.data.grid_y = map.rows;
      this.data.maxCol = map.cols - 1;
      this.data.maxRow = map.rows - 1;
      this.data.mask = (map.mask && map.mask.length === total) ? map.mask.slice() : new Array(total).fill(1);
      this.data.isRP = false;
    }
  },

  // 屏幕像素坐标 -> 网格坐标（RP 模式走等距变换，矩形模式走矩形取整）
  getGridPos(px, py) {
    const tx = px - this.OFFSET_X, ty = py - this.OFFSET_Y;
    if (this.data.isRP) {
      const rp = transformXYToRP(tx, ty);
      return { col: rp.col, row: rp.row };
    }
    const col = Math.floor(tx / this.data.tile_width);
    const row = Math.floor(ty / this.data.tile_height);
    return { col, row };
  },

  // 网格坐标 -> 屏幕像素坐标（格心）
  getPixelPos(col, row) {
    if (this.data.isRP) {
      const c = transformRPToCXY(col, row);
      return { x: c.x + this.OFFSET_X, y: c.y + this.OFFSET_Y };
    }
    const px = col * this.data.tile_width + this.data.tile_width / 2 + this.OFFSET_X;
    const py = row * this.data.tile_height + this.data.tile_height / 2 + this.OFFSET_Y;
    return { x: px, y: py };
  },

  // 网格是否可行走（AS3 GameMask 语义：0=阻挡，1/2=可走；越界=阻挡）
  isWalkable(col, row) {
    if (col < 0 || col >= this.data.grid_x || row < 0 || row >= this.data.grid_y) return false;
    const v = this.data.mask[row * this.data.grid_x + col];
    return v === 1 || v === 2;
  },

  // 切换/清理切片缓存（切图时调用）
  clearTiles(mapLayer) {
    if (mapLayer) mapLayer.innerHTML = '';
    for (const k in this.tileMap) delete this.tileMap[k];
  }
};

// ───────────────────────── A* 寻路（含掩码 / 拉线法平滑） ─────────────────────────
export const AStar = {
  /**
   * A* 主函数：返回像素坐标点数组构成的路径。
   */
  findPath(startCol, startRow, targetCol, targetRow) {
    if (!MapSystem.isWalkable(targetCol, targetRow)) return [];
    const openList = [], closedSet = new Set(), nodeMap = new Map();
    openList.push({ col: startCol, row: startRow, g: 0, h: 0, f: 0, parent: null });
    nodeMap.set(`${startCol}_${startRow}`, openList[0]);

    while (openList.length > 0) {
      openList.sort((a, b) => a.f - b.f);
      const curr = openList.shift();
      if (curr.col === targetCol && curr.row === targetRow) {
        const path = []; let node = curr;
        while (node) { path.push(MapSystem.getPixelPos(node.col, node.row)); node = node.parent; }
        return path.reverse();
      }
      closedSet.add(`${curr.col}_${curr.row}`);
      const arounds = this.getArounds(curr.col, curr.row);
      for (const [nc, nr] of arounds) {
        if (closedSet.has(`${nc}_${nr}`)) continue;
        const dx = nc - curr.col, dy = nr - curr.row;
        // 对齐 AS3 AStar：|dx|==1 且 dy==0（横直），或 |dy|==2 且 dx==0（竖直直）代价 14；其余 10
        const tentativeG = curr.g + ((Math.abs(dx) === 1 && dy === 0) || (Math.abs(dy) === 2 && dx === 0) ? 14 : 10);
        let nNode = nodeMap.get(`${nc}_${nr}`);
        if (!nNode) {
          nNode = { col: nc, row: nr };
          nodeMap.set(`${nc}_${nr}`, nNode);
          openList.push(nNode);
        } else if (tentativeG >= nNode.g) {
          continue;
        }
        nNode.parent = curr;
        nNode.g = tentativeG;
        nNode.h = (Math.abs(nc - targetCol) + Math.abs(nr - targetRow)) * 10;
        nNode.f = nNode.g + nNode.h;
      }
    }
    return [];
  },

  /**
   * 取 (c,r) 的可走相邻格（对齐 AS3 AStar.getArounds 的等距交错 8 邻域）。
   * RP 模式：4 个对角邻（行±1，列随奇偶偏移）+ 4 个直行邻（行±2 / 列±1，带拐角切割判定）。
   * 矩形模式：标准 8 邻域。
   */
  getArounds(c, r) {
    if (!MapSystem.data.isRP) {
      const res = [];
      const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
      for (const [dx, dy] of dirs) {
        const nc = c + dx, nr = r + dy;
        if (MapSystem.isWalkable(nc, nr)) res.push([nc, nr]);
      }
      return res;
    }
    const parity = r & 1;            // r % 2
    const d1 = [c + parity,     r + 1];
    const d2 = [c + parity - 1, r + 1];
    const d3 = [c + parity - 1, r - 1];
    const d4 = [c + parity,     r - 1];
    const w1 = MapSystem.isWalkable(d1[0], d1[1]);
    const w2 = MapSystem.isWalkable(d2[0], d2[1]);
    const w3 = MapSystem.isWalkable(d3[0], d3[1]);
    const w4 = MapSystem.isWalkable(d4[0], d4[1]);
    const res = [];
    if (w1) res.push(d1);
    if (w2) res.push(d2);
    if (w3) res.push(d3);
    if (w4) res.push(d4);
    // 直行邻：需两侧对角均可走（防穿墙拐角切割）
    if (w1 && w2 && MapSystem.isWalkable(c,     r + 2)) res.push([c,     r + 2]);
    if (w3 && w2 && MapSystem.isWalkable(c - 1, r))     res.push([c - 1, r]);
    if (w3 && w4 && MapSystem.isWalkable(c,     r - 2)) res.push([c,     r - 2]);
    if (w1 && w4 && MapSystem.isWalkable(c + 1, r))     res.push([c + 1, r]);
    return res;
  },

  /**
   * 路径平滑/优化（拉线法 String Pulling）：消除 A* 锯齿，拉成直线连接。
   */
  optimizePath(path) {
    if (path.length < 3) return path;
    const checkLineOfSight = (p1, p2) => {
      for (let i = 1; i <= 12; i++) {
        const g = MapSystem.getGridPos(
          p1.x + (p2.x - p1.x) * (i / 12),
          p1.y + (p2.y - p1.y) * (i / 12)
        );
        if (!MapSystem.isWalkable(g.col, g.row)) return false;
      }
      return true;
    };
    const opt = [path[0]];
    let currIdx = 0;
    while (currIdx < path.length - 1) {
      let lastVis = currIdx + 1;
      for (let i = currIdx + 2; i < path.length; i++) {
        if (checkLineOfSight(path[currIdx], path[i])) lastVis = i;
        else break;
      }
      opt.push(path[lastVis]);
      currIdx = lastVis;
    }
    return opt;
  },

  /**
   * 广度优先：找距离 (col,row) 最近的可走格（点击到墙里时回退）
   */
  findNearestWalkable(col, row) {
    const visited = new Set();
    const queue = [[col, row]];
    visited.add(`${col}_${row}`);
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    while (queue.length > 0) {
      const [c, r] = queue.shift();
      if (MapSystem.isWalkable(c, r)) return { col: c, row: r };
      for (const [dx, dy] of dirs) {
        const nc = c + dx, nr = r + dy, key = `${nc}_${nr}`;
        if (!visited.has(key)) { visited.add(key); queue.push([nc, nr]); }
      }
    }
    return null;
  },

  /**
   * 像素直线是否全程穿过可行走区（采样 16 点）
   */
  isPixelLineClear(p1, p2) {
    const SAMPLES = 16;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    for (let i = 1; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const g = MapSystem.getGridPos(p1.x + dx * t, p1.y + dy * t);
      if (!MapSystem.isWalkable(g.col, g.row)) return false;
    }
    return true;
  }
};
