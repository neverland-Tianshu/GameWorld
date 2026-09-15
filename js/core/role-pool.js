// role-pool.js
// 移植自 deobfuscated/manager/RolePoolManager.as（角色精灵对象池）。
// 原版按资源 key(模型 ID) 分组缓存可复用显示对象，借/还避免反复 create/dispose。
// 这里 key = charId（角色模型 ID），缓存空闲 Fighter 实例：
//   - 借 acquire：同 charId 有空闲实例则复用(reinit 重置数据，保留 DOM)，否则 new Fighter。
//   - 还 release：暂停动画 + 摘离舞台，保留 DOM 入池（受 MAX_IDLE 上限约束，超额才真销毁）。
// 适用场景：地图 NPC 高频增删（切图/遇敌恢复时大量 new/ destroy）。玩家等常驻实例不入池。

import { Fighter } from '../entities/fighter.js?v=20261007c';

const MAX_IDLE_PER_KEY = 8;   // 每个 charId 最多缓存的空闲实例数（防内存无界增长）

class RolePoolManager {
  constructor() {
    this._pools = new Map();   // charId -> Fighter[]（空闲可复用，栈尾为最近归还）
  }

  // 借一个 Fighter：有空闲同 charId 实例则复用，否则新建。
  acquire(opts) {
    const key = opts.charId;
    const bucket = this._pools.get(key);
    if (bucket && bucket.length) {
      const fig = bucket.pop();
      fig._inPool = false;   // 离池：清除空闲标记（防御二次释放时重复入桶）
      fig._poolable = true;
      fig.reinit(opts);     // 重置数据（保留 DOM），不重建 DOM
      return fig;
    }
    const fig = new Fighter(opts);
    fig._inPool = false;
    fig._poolable = true;
    return fig;
  }

  // 还回一个 Fighter：暂停动画 + 摘离舞台，保留 DOM 入池（超额则彻底释放）。
  // 已空闲的实例重复 release 直接跳过（防御 _onEnemyDown 与 _releaseEnemies 极端重叠导致的重复入桶/池污染）。
  release(fig) {
    if (!fig || fig._inPool) return;
    fig.release();   // Fighter.release：暂停 + 摘离
    const key = fig.charId;
    let bucket = this._pools.get(key);
    if (!bucket) { bucket = []; this._pools.set(key, bucket); }
    if (bucket.length < MAX_IDLE_PER_KEY) { bucket.push(fig); fig._inPool = true; }
    else if (typeof fig.destroy === 'function') { fig._inPool = false; fig.destroy(); }   // 超额：彻底释放该 DOM，避免无限堆积
  }

  // 场景销毁时清空整个池（彻底释放所有空闲实例 DOM）。
  clear() {
    for (const bucket of this._pools.values()) {
      for (const fig of bucket) if (typeof fig.destroy === 'function') fig.destroy();
    }
    this._pools.clear();
  }

  // 诊断：返回各 charId 当前空闲数（对齐原版 RolePoolManager.toString）。
  stats() {
    const out = {};
    for (const [k, v] of this._pools) out[k] = v.length;
    return out;
  }

  get size() { return this._pools.size; }
}

// 全局单例（与 scene 单例生命周期一致；跨场景复用 NPC 池）。
export const RolePool = new RolePoolManager();
export default RolePoolManager;
