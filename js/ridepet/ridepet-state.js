// ridepet-state.js
// 骑宠系统状态（单机版）：当前骑宠模型 id、骑乘中的角色 charId、是否上骑、
// 各骑宠的显示类型覆盖（乘骑/站立）。
// 持久化到 localStorage，跨场景/重载保留。
//
// 约定：
//   ridepetId = resource/char/4xxxxx 的骑宠模型 id（67 个）
//   charId    = 骑手的角色模型 id；不填（null）= 当前主角模型（scene.player.charId）
//   riding    = 是否处于骑乘状态（决定 fighter 播 ride 动作 + 挂 bg/fg 层）
//   rideTypeMap = { '400013': 'stand', ... } 显示类型的手动覆盖；
//                 未覆盖的骑宠读模型 index.html 的 ridepetMeta.rideType（默认乘骑型）

const LS_KEY = 'tsqt.ridepet.state';

const state = {
  ridepetId: null,    // '400000' ...
  charId: null,       // null = 跟随当前主角
  riding: false,
  rideTypeMap: {},    // modelId → 'ride' | 'stand'（游戏内面板切换的覆盖值）
};

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      state.ridepetId = j.ridepetId || null;
      state.charId = j.charId || null;
      state.riding = !!j.riding;
      if (j.rideTypeMap && typeof j.rideTypeMap === 'object') state.rideTypeMap = j.rideTypeMap;
    }
  } catch (e) { /* ignore */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
load();

export const ridepetState = {
  get ridepetId() { return state.ridepetId; },
  get charId() { return state.charId; },
  get riding() { return state.riding; },
  get rideTypeMap() { return state.rideTypeMap; },

  set(ridepetId, charId) {
    state.ridepetId = ridepetId || null;
    state.charId = charId || null;
    save();
  },
  setRiding(v) {
    state.riding = !!v;
    save();
  },
  // 覆盖某骑宠的显示类型（游戏内面板「乘骑态/站立态」切换）；type 传 null 则清除覆盖
  setRideType(modelId, type) {
    const id = String(modelId || '');
    if (!id) return;
    if (type === 'ride' || type === 'stand') state.rideTypeMap[id] = type;
    else delete state.rideTypeMap[id];
    save();
  },
  getRideType(modelId) {
    const id = String(modelId || '');
    const t = id ? state.rideTypeMap[id] : null;
    return (t === 'ride' || t === 'stand') ? t : null;
  },
  clear() {
    state.ridepetId = null;
    state.charId = null;
    state.riding = false;
    save();
  },
};
