// cast-visual-config.js
// ─────────────────────────────────────────────────────────────────────────
// 技能「演出落点」统一解析器。
// 供 scene.js（主游戏 BattleScene）与 battle-test.js（战斗测试页）共用，
// 避免两套实现分歧导致「动画该在敌人身上却显示在施法者身上」之类的问题。
//
// 每个技能可在 config/skills.json 中声明可选字段（缺省则沿用旧逻辑）：
//
//   "castVisual": {
//     "place":  "target" | "self" | "ally" | "enemy" | "screen",   // 单实例落点基准
//     "spread": "one"    | "perUnit",                            // 群体播放方式
//     "fit":    true | false,                                    // 动画等比例放大铺满舞台（不拉伸，保持宽高比）
//     "fitMode":"contain" | "cover"                              // contain=完整显示（可能上下/左右留边）［缺省］/ cover=完全铺满（可能裁掉边缘）
//   }
//
//   place（单实例动画放在哪一侧 / 哪点）：
//     "target" - 主目标（按技能实际影响自动：敌方技→敌人、己方技→队友/自己）［缺省］
//     "self"   - 仅施法者自己（己方单体 buff 用）
//     "ally"   - 己方（队友/自己）；spread=perUnit 时覆盖全部受影响己方单位
//     "enemy"  - 敌方；spread=perUnit 时覆盖全部受影响敌方单位
//     "screen" - 全屏居中覆盖（单实例大演出，如全屏光效）
//
//   spread（群体/多目标时怎么播）：
//     "one"     - 只播放一个实例（落于 place 基准处）［缺省］
//     "perUnit" - 对【每个受影响单位】单独播放一个实例
//                （敌方群攻→每个敌人；己方群疗/群buff→每个队友；自动取 targets 集合，无需手填）
//
// 旧逻辑（无 castVisual）回退：单体→主目标身体中心，群体/十字→舞台中心，
// 并保留 skill.perUnitEffect（烈焰风暴等）逐目标的既有行为（由调用方负责）。

export function resolveCastPlays(skill, opts = {}) {
  const { caster = null, primary = null, targets = [], stageW = 800, stageH = 600 } = opts;
  const cx = Math.round(stageW / 2);
  const cy = Math.round(stageH / 2);

  // 落点对准模型【脚点 = 原点(画布中心 256,256) = 各动画原点】：fig.x/fig.y 即 .el(0,0)（脚底/地面接触点），
  // 常规模型脚点=原点(256,256) ⇒ 技能/特效的 Flash 原点与身体/武器/纸娃娃/各动画共用同一基准点；
  // 单 Role 模型(210071) 脚点=(0,0)≠原点(256,256)，同样按其脚点锚定（与身体动画同源，不偏到身体中心）。
  // user 2026-09-11：技能落点统一为脚点/原点，不再用 _modelCxEl 居中到身体（避免与身体动画原点错位）。
  const figAnchor = (fig) => {
    if (!fig || typeof fig.x !== 'number') return null;
    return { x: fig.x, y: fig.y };
  };
  const valid = (f) => f && typeof f.x === 'number';

  const cfg = skill && skill.castVisual;

  // ── 无 castVisual：沿用旧逻辑（groupFallback 由调用方按 isCross/多目标/target 计算好传入）──
  if (!cfg) {
    const isGroup = !!opts.groupFallback;
    let px = cx, py = cy;
    if (!isGroup) {
      const t = primary || (targets && targets[0]) || null;
      const fc = figAnchor(t) || figAnchor(caster);
      if (fc) { px = fc.x; py = fc.y; }
    }
    return { plays: [{ x: px, y: py }], group: isGroup, center: { x: cx, y: cy }, multi: isGroup, hasCV: false, fit: false };
  }

  const place = cfg.place || 'target';
  const spread = cfg.spread || 'one';

  // 全屏居中（无论群体与否都只一个，但标记为 group 以走中心演出）
  if (place === 'screen') {
    // fit：等比例放大铺满舞台（不拉伸）；fitMode：contain=完整显示/cover=完全铺满。供 scene._castVisual 计算 scale。',
    // center：fit 时的居中基准（content=可见内容包围盒中心 / origin=Flash 原点，后者保持
    //   不缩放时的定位整体放大，适合亮像素重心本就在原点附近的特效）。
    return { plays: [{ x: cx, y: cy }], group: true, center: { x: cx, y: cy }, multi: false, hasCV: true,
             fit: !!cfg.fit, fitMode: cfg.fitMode || 'contain', centerBasis: cfg.center || 'content' };
  }

  // 逐单位：直接遍历「实际受影响集合」targets（敌方技→敌人，己方技→队友，已含正确一侧）
  if (spread === 'perUnit') {
    const list = (targets || []).filter(valid).map(u => figAnchor(u) || { x: u.x, y: u.y });
    if (!list.length) list.push({ x: cx, y: cy });
    return { plays: list, group: true, center: { x: cx, y: cy }, multi: true, hasCV: true,
             fit: !!cfg.fit, fitMode: cfg.fitMode || 'contain' };
  }

  // 单实例：落点由 place 决定（ally/enemy 在 one 模式下均取主目标/首个受影响单位）
  let anchor = null;
  if (place === 'self') anchor = caster;
  else anchor = primary || (targets && targets[0]) || caster;   // target / ally / enemy 单实例：取主目标
  const fc = figAnchor(anchor) || (anchor ? { x: anchor.x, y: anchor.y } : { x: cx, y: cy });
  return { plays: [fc], group: false, center: { x: cx, y: cy }, multi: false, hasCV: true,
           fit: !!cfg.fit, fitMode: cfg.fitMode || 'contain' };
}

export default resolveCastPlays;
