// pet.js —— 宠物主面板数据模型（对齐 AS3 propertyManager._petList / petPanelPropValue）
//
// ★ 三层数据流（用户裁决 2026-09-17）—— 本文件是**合并视图层**：
//
//   [静态原型表] Config.pets ← config/pets.json（gen_game_data.py 生成）
//        物种资质 / 外观 / 携带等级 / 出厂技能表，字段名一律 op572 原生名
//        （attack / defense / magicAttack / speed / bodyImage / portraitImage / growUpRate / carryLevel ...）
//        │ 实例化（js/pet/pet-state.js）
//        ▼
//   [运行时实例] petState().list —— uid / level / hpCur / mpCur / exp / state / bind /
//        loyality / spiritual / skillList / skillLevels / advanceState
//        │ 合并视图（本文件 view()）
//        ▼
//   [面板取数] 面板只认一个 id（petId），静态字段查原型、易变字段用实例覆盖
//
//   ⇒ 静态字段**不复制进实例**（避免脏数据与存档膨胀）；实例有值则覆盖原型。
//
// ⚠ 铁律：不臆造。原型缺字段、实例缺字段，val() 一律返回 '—'。
// ⚠ 本文件只读不写战斗。

import { Config } from '../core/globals.js?v=20261007c';
import { petState, protoOf } from './pet-state.js?v=20261007c';
import { charToPetProto } from '../char/char-gen.js?v=20261007c';   // ★ aw：pets.json 清空后原型来自角色信息表

const DASH = '—';

let _sel = null;

/** 合并视图：原型打底 + 实例覆盖（面板取数的唯一出口）。 */
function view(inst) {
  // ★ ay：petId 是唯一编码 ⇒ 原型/角色表按 family（物种）查，旧档无 family 时回退 petId。
  const proto = protoOf(inst.family || inst.petId);
  if (proto && proto._char) {
    // ★ aw：原型 = 角色信息表记录 ⇒ 属性全部由公式派生（等级/品级/变异/成长率来自实例）。
    const seed = charToPetProto(proto._char, inst);
    delete seed._char;
    return Object.assign({}, seed, inst);
  }
  return Object.assign({}, proto || {}, inst);
}

const sameId = (a, b) => String(a) === String(b);

export function pet() {
  const ps = petState();
  const insts = (ps && ps.list) || [];
  const all = insts.length
    ? insts.map(view)
    : (Config.pets || []).map((p) => Object.assign({ uid: p.petId }, p));   // 无实例层时退回纯原型

  if (!_sel && all.length) _sel = all[0].uid || all[0].petId;   // ★ ay：按 uid 选中（petId 唯一编码，name 可能重复）

  const self = {
    list: all,
    raw: insts,                                   // 可写实例（进阶子系统 / 出战设置直接改它）
    get selectedId() { return _sel; },
    select(id) {
      if (all.some((p) => sameId(p.petId, id) || sameId(p.uid, id))) _sel = id;
    },
    get(id) {
      return all.find((p) => sameId(p.petId, id) || sameId(p.uid, id)) || {};
    },
    current() { return this.get(_sel); },
    /** 该 id 对应的可写实例（进阶 mock / 设为出战 用）。 */
    instanceOf(id) {
      return insts.find((p) => sameId(p.petId, id) || sameId(p.uid, id)) || null;
    },
    /**
     * 取某宠物某字段的展示值（对齐 AS3 petPanelPropValue 的取值口径）。
     * 字段名一律用 op572 原生名；缺失返回 '—'（不臆造）。
     */
    val(petId, field) {
      const p = this.get(petId) || {};
      const v = p[field];
      if (v == null || v === '') return DASH;
      return v;
    },
  };
  return self;
}

export { DASH };
