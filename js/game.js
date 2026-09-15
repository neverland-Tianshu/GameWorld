// game.js — 启动入口，对应 deobfuscated/root/GameWorld.as（DocumentClass / 主入口）
import { loadConfig } from './core/globals.js?v=20261007c';
import { SceneManager } from './scenes/scene.js?v=20261007c';

// ── 构建戳（BUILD STAMP）────────────────────────────────────────────────
//   用途：确定"浏览器当前跑的是哪一版代码"。ES 模块被浏览器强缓存时，
//   改动源码但页面仍跑旧模块（症状是"改了但没生效 / 换了台机器结果不同"）。
//   ★ 任何涉及"修了没生效"的排查，先看控制台这行构建戳。
//   改动 js/ 下任意模块后请同步更新此字符串。
//   ★ 命名规则（用户裁决 2026-09-19）：版本号 = 日期(YYYYMMDD) + 一个英文字母，
//     每天从 a 重新开始（20260919a → 20260920a → …），跨天回到 a（20260920a）。
//     字母后的「 · 中文说明」为本版改动摘要。版本号本身只进位、不回退。
const BUILD_STAMP = "20261007c · 修talkText移入pane后纯对话NPC丢文本+firstElementChild丢多节点(任务列表)";
// ── 漂移一键诊断入口 ────────────────────────────────────────────────────
//   控制台执行 __DIAG_DRIFT() 即可自动跑完整复现流程（进战斗 → 触发走位 → 逃跑
//   → 回城采样 4 秒），并打印"谁在改写玩家坐标"的调用栈。
//   实现体在 漂移诊断-控制台脚本.js，运行时按需拉取（避免把诊断代码打进主包）。
window.__DIAG_DRIFT = async () => {
  try {
    const url = new URL('漂移诊断-控制台脚本.js', document.baseURI).href;
    const src = await (await fetch(url + '?v=' + Date.now())).text();
    // 以函数体方式执行（脚本自身是 async IIFE）
    await new Function(src)();
  } catch (e) {
    console.error('[诊断] 脚本加载/执行失败：', e);
    console.error('[诊断] 也可手动打开「漂移诊断-控制台脚本.js」整段粘贴到本控制台运行。');
  }
};
console.log('%c[天书奇谈] 漂移诊断：在本控制台执行 __DIAG_DRIFT() 即可一键复现并定位', 'color:#1f8b4c');

(async () => {
  // 1) 拉取"后台"示例数据（config/*.json）
  await loadConfig();
  // 2) 实例化场景中枢并进入登录
  const sm = new SceneManager();
  window.__TS = sm; // 调试用
  window.__TS_BUILD = BUILD_STAMP;
  console.log('%c[天书奇谈] 构建戳：' + BUILD_STAMP, 'color:#1f8b4c;font-weight:bold');
  await sm.login();
  // 3) 纸娃娃叠加层调试入口已迁入「研发/运营工具台」：由 registerTools 统一注册到 panelManager，
  //    从 HUD 工具台按钮进入「六、研发调试与运营后台」分组即可打开，无需在此自动初始化。
})();

