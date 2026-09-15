// ridepet-type.js
// 骑宠显示类型（乘骑型 / 站立型）+ 站立型人物抬升量。
//
// AS3 取证（CurrentPanelNpc.as / GlobalsGlobal08.as）：
//   CHARSTATE_RIDE(33554432)       乘骑：loadRidePetSwf → addRidePetSwf → destoryWeapon + bodyLayer 挂到
//                                    骑宠 rider 挂点 + setRideFrame（人物播 base+dir+'ride' 乘骑帧）
//   CHARSTATE_STAND_RIDE(67108864) 站立：loadStandRidepetSwf → addStandRidepetSwf → 人物播普通 stand 帧
//                                    + checkStandRideY 抬高 30px（AS3 里同样 destoryWeapon，原版站立骑宠无武器）
//   两者原由**服务端下发** state 位决定；本地单机版无服务端 ⇒ 本地配置。
//
// 配置口径（2026-10-05 用户定）：配置**随模型走**——写在每个骑宠模型目录的
//   resource/char/{id}/index.html 里的一行 `const ridepetMeta={"rideType":"stand","standLift":-15};`
//   （ride 型 / 无抬升不写，缺省 = 乘骑型 + 抬升 0）。config/chars.json 只保留造型/技能/属性等。
// ⚠ 模型结构无法自动区分类型：400000(乘骑) 与 400013(站立) 的 labels 结构完全一致
//    （同为 walkRB/RidewalkRT/... 8 标签、同样的 bg/fg/flip 布局），必须人工配置。
// ⚠ 读 index.html 需 loadChar（异步网络）⇒ getRidepetType/getRidepetLift 均为 **async**；
//    fighter 在 mountRide/applyRideType 时一次性 await 读回，缓存在 this._rideType/this._rideStandLift，
//    渲染热路径（_standLiftPx）只读内存字段，不再每帧 await。

import { getRidepetMeta, invalidateRidepetMetaCache } from '../core/loader.js?v=20261007c';
import { ridepetState } from './ridepet-state.js?v=20261007c';

// 站立型人物抬升默认值（flash 像素，y 负=上）。0 = 锚点对齐：骑宠层与人物/武器层共用
// 同一个 Flash 原点叠加，不施加任何偏移。各模型的踩点高度差异由 index.html 的
// per-model standLift 覆盖（用户直接编辑 resource/char/{id}/index.html）。
export const STAND_LIFT_DEFAULT = 0;

// 按骑宠模型 id 查显示类型。优先级：
//   ① 游戏内面板的手动覆盖（ridepetState.rideTypeMap，持久化，同步）
//   ② 模型 index.html 的 ridepetMeta.rideType（异步，需 loadChar）
//   ③ 兜底 'ride'（乘骑型）
export async function getRidepetType(modelId) {
  const id = String(modelId || '');
  if (!id) return 'ride';
  const override = ridepetState.getRideType(id);
  if (override) return override;
  const meta = await getRidepetMeta(id);
  return (meta && meta.rideType === 'stand') ? 'stand' : 'ride';
}

export async function isStandRidepet(modelId) { return (await getRidepetType(modelId)) === 'stand'; }

// 站立型骑乘的人物抬升量（flash 像素，y 负=上）。未配置 standLift → STAND_LIFT_DEFAULT(0)。
export async function getRidepetLift(modelId) {
  const id = String(modelId || '');
  if (!id) return STAND_LIFT_DEFAULT;
  const meta = await getRidepetMeta(id);
  if (!meta || meta.standLift == null) return STAND_LIFT_DEFAULT;
  const lift = Number(meta.standLift);
  return isFinite(lift) ? lift : STAND_LIFT_DEFAULT;
}

// 游戏内面板切换显示类型：写持久化 override（null = 清除覆盖，回退模型配置默认值）
export function setRidepetType(modelId, type) {
  ridepetState.setRideType(modelId, type || null);
}

// 清类型/抬升缓存（模型 index.html 是静态文件，一般无需清；保留给热更新场景）
export function invalidateRidepetTypeCache() { invalidateRidepetMetaCache(); }
