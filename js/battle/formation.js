// formation.js —— 站位管理器（对齐 BattleScene.as CharacterManager.getFightPoint 的"战斗点分配"）
//
// 战斗点编号（0-19，与 BattleScene.getFightPoint 的 slot 参数一一对应）：
//   友方：前排 0 1 2 3 4 / 后排 5 6 7 8 9        （共 0-9）
//   敌方：前排 10 11 12 13 14 / 后排 15 16 17 18 19（共 10-19）
//
// ★ 站位规则对齐 AS3 原版抓包实证（op42 SC_BATTLE_START 258 场战斗，100% 一致）：
//   ① 玩家固定 2（前排中轴），宠物固定 7 = 玩家位 + 5（正后方，AS3 battleManager.petPid = pid + 5）
//   ② 怪物【从后排开始】：先后排中心 17 向两侧扩展（17 → 16,18 → 15,19），排满 5 只后
//      再上前排中心 12 向两侧扩展（12 → 11,13 → 10,14）
//      （n=1→[17] / n=2→[16,17] / n=3→[16,17,18] / n=6→[15-19]+[12] / n=10→全占，逐档吻合）
//   ③ 抓包里 op42 第 3 个 short 字段被自动解析器误标为 "pid"，实为 AS3 的 position
//      （HandlerConnection05: _loc9_ → _loc30_.position），故 monsters 表的 "pid" 列才是站位。
//
// ★★ 用户裁决 2026-09-30 23:05（宠物去另一排）：
//    游戏是【面对面】站着的 —— 敌方后排与友方后排隔场对称。宠物【不应和人物同一排】：
//    人物在友方前排（中轴 2 → 1,3 → 0,4），宠物就在【另一排】（友方后排）从中轴 7
//    （= 玩家 2 的正后方，恰好还原 AS3 的 pid+5）向两侧扩展（7 → 6,8 → 5,9）；
//    后排排满 5 只仍有剩余宠物时，才溢出到前排剩余空位（中轴优先）。
//    ⇒ 1 人 1 宠 = 玩家 2 / 宠物 7；5 人 5 宠 = 前排全人 + 后排全宠，10 点恰好用满。
//    （旧裁决 2026-09-30 03:45「宠物优先占前排中心」已被本条取代）

// 友方【角色】顺序：前排中轴 → 前排两侧 → 后排中轴 → 后排两侧
//   （角色钳到 5 人，恒占满前排 0-4；玩家 lead 恒为 2）
export const FRIENDLY_CHAR_ORDER = [2, 1, 3, 0, 4, 7, 6, 8, 5, 9];
// 友方【宠物】顺序：另一排（后排）中轴 7 → 两侧 6,8 → 5,9，溢出回前排中轴 1,3 → 0,4
//   （不含 2：玩家位，宠物永不相争）
export const FRIENDLY_PET_ORDER  = [7, 6, 8, 5, 9, 1, 3, 0, 4];
// 敌方：【先后排中轴扩展】，再前排中轴扩展（对齐原版：怪物从 17 起）
export const ENEMY_ORDER         = [17, 16, 18, 15, 19, 12, 11, 13, 10, 14];

// 取一侧"从中心扩展"的顺序表（nextFreeSlot 查空位用）。
//   ★ 友方当前唯一调用方是【放置宠物】（手动召唤 / 进场兜底），故用宠物顺序 —— 优先另一排中轴。
export function slotOrder(side) {
  return side === 'friendly' ? FRIENDLY_PET_ORDER : ENEMY_ORDER;
}

// 数量钳制：友方角色上限 5（玩家+队员），敌方角色上限 10（暗雷可按队伍人数翻倍）
export function clampFormationCount(n, max = 5) {
  n = n | 0;
  if (n < 1) n = 1;
  if (n > max) n = max;
  return n;
}

// 取一侧"从中心扩展"的第一个空闲战斗点（手动召唤/补位等需要跳过已占位的场景）。
//   used = 已占用 band 集合（Set 或数组）；全满时返回该侧顺序最后一个点。
export function nextFreeSlot(side, used) {
  const order = slotOrder(side);
  const s = used instanceof Set ? used : new Set(used || []);
  for (const b of order) if (!s.has(b)) return b;
  return order[order.length - 1];
}

// 计算一侧出场战斗点。
// opts: { chars=1, pets=0 }
//   chars = 角色数（友方含主角，钳到 1-5；敌方含暗雷，钳到 1-10）
//   pets  = 宠物数（仅友方； pets 钳到余量）
// 返回 { lead, members:[], pets:[], all:[] }
//   lead   = 队长战斗点（友方主角恒为 2 / 敌方首怪恒为 17，即顺序表首项）
//   members= 其余角色战斗点（友方=队员；敌方=其余怪）
//   pets   = 宠物战斗点
//   all    = lead + members + pets 的扁平序列（供"依次取未占用点"式分配；敌方 _nextFoeSlot 用）
// ★ 友方分配（用户裁决 2026-09-30 23:05）：角色占前排（中轴 2 → 1,3 → 0,4），
//   宠物占【另一排】（后排中轴 7 → 6,8 → 5,9），后排溢出才回前排空位。
//   1 人 1 宠 = 玩家 2 / 宠物 7（玩家正后方）；5 人 5 宠 = 前排全人 + 后排全宠。
//   敌方无宠物（pets 恒 0），退化为 lead → 其余怪，与旧实现逐位一致。
export function buildFormation(side, { chars = 1, pets = 0 } = {}) {
  const isFriend = side === 'friendly';
  const charN = clampFormationCount(chars, isFriend ? 5 : 10);
  const charOrder = isFriend ? FRIENDLY_CHAR_ORDER : ENEMY_ORDER;
  const lead = charOrder[0];
  const memberSlots = charOrder.slice(1, charN);

  if (!isFriend) {
    return { lead, members: memberSlots, pets: [], all: [lead].concat(memberSlots) };
  }

  // 宠物：另一排（后排）中轴优先，跳过角色已占的点，取够 petN 个
  const used = new Set([lead].concat(memberSlots));
  const maxPets = Math.max(0, 10 - charN);
  const petN = Math.max(0, Math.min(pets | 0, maxPets));
  const petSlots = [];
  for (const b of FRIENDLY_PET_ORDER) {
    if (petSlots.length >= petN) break;
    if (!used.has(b)) { petSlots.push(b); used.add(b); }
  }
  // 极端兜底：FRIENDLY_PET_ORDER 遍历完仍不足 petN（理论上 9 个候选 ≥ 余量，不会发生）
  for (let b = 0; b <= 9 && petSlots.length < petN; b++) {
    if (!used.has(b)) { petSlots.push(b); used.add(b); }
  }

  return { lead, members: memberSlots, pets: petSlots, all: [lead].concat(petSlots, memberSlots) };
}

// 暗雷怪物数量：队伍【人数】~ 人数×2（宠物不计入；1 人 → 1-2 只，5 人 → 5-10 只）。
//   partyHumans = 玩家 + 队伍内人参（机器人/NPC 好友），钳到 1-5。
export function darkEncounterCount(partyHumans) {
  const humans = clampFormationCount(partyHumans, 5);
  return humans + Math.floor(Math.random() * (humans + 1));
}
