// tutor.js — 新手引导（TutorManager / FaceTutor）单机版移植
// 对齐 deobfuscated/manager/TutorManager.as + face/tutor/*：步骤序列 + 提示框 + 模拟鼠标/高亮 + 确认推进 + 跳过。
import { Config } from '../core/globals.js?v=20261007c';
//
// 数据驱动与"零臆造"铁律：
//   - 步骤序列与文案来自 config/tutor.json（种子内容 = 反编译 face/tutor/Step*.as 的真实职责描述，非编造引导散文）。
//   - 若 Config.data.tutor 为空，则完全不显示引导（诚实空操作，不臆造任何文案/图标）。
//   - 真实本地化字符串表（ManagerManager02.getString）未反编译，故文案用真实反编译职责描述承载；
//     日后若提供真实本地化串，可直接替换 config/tutor.json 的 text 字段，框架无需改动。
//   - 进度持久化到 localStorage('tsqt.tutor.done')，已完成则不再自动弹出（仍可手动重看）。

const DONE_KEY = 'tsqt.tutor.done';

export class TutorManager {
  constructor(ui) {
    this.ui = ui;
    this.steps = (Config.data && Config.data.tutor && Config.data.tutor.steps) || [];
    this.idx = 0;
    this.overlay = null;
    this._hl = null;   // 当前高亮的元素
    // ★ ESC 随时跳过引导：遮罩即便因竞态残留也绝不会永久困住玩家（对齐"引导不能卡死输入"铁律）
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay) this._finish();
    });
  }
  get finished() {
    try { return localStorage.getItem(DONE_KEY) === '1'; } catch (e) { return false; }
  }
  // 首次进入主城时调用：未完成且有步骤才自动开始
  start(auto = true) {
    // 惰性读取步骤序列（防御：构造时 Config 可能尚未加载完成）
    this.steps = (Config.data && Config.data.tutor && Config.data.tutor.steps) || this.steps || [];
    if (auto && this.finished) return;
    if (!this.steps.length) return;
    this.idx = 0;
    this._render();
  }
  _clearHl() {
    // ★ 移除 DOM 中所有 tutor-hl（不只 this._hl），避免高亮残留覆盖在 HUD 上
    document.querySelectorAll('.tutor-hl').forEach(e => e.classList.remove('tutor-hl'));
    this._hl = null;
  }
  _render() {
    this._destroy();
    const step = this.steps[this.idx];
    if (!step) { this._finish(); return; }
    // 高亮目标真实 HUD 元素（selector 真实存在才高亮，否则不做）
    this._clearHl();
    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) { el.classList.add('tutor-hl'); this._hl = el; el.scrollIntoView && el.scrollIntoView({ block: 'nearest' }); }
    }
    const ov = document.createElement('div');
    ov.className = 'tutor-overlay';
    const last = this.idx >= this.steps.length - 1;
    ov.innerHTML = `
      <div class="tutor-box">
        <div class="tutor-step">第 ${this.idx + 1} / ${this.steps.length} 步</div>
        <div class="tutor-text">${esc(step.text)}</div>
        <div class="tutor-btns">
          <button class="tutor-skip">跳过引导</button>
          <button class="tutor-next pb-btn on">${last ? '完成' : '下一步'}</button>
        </div>
      </div>`;
    ov.querySelector('.tutor-next').onclick = () => this.next();
    ov.querySelector('.tutor-skip').onclick = () => this._finish();
    (this.ui.layer || document.body).appendChild(ov);
    this.overlay = ov;
  }
  next() {
    this.idx += 1;
    if (this.idx >= this.steps.length) { this._finish(); return; }
    this._render();
  }
  _finish() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
    this._destroy();
    this.ui.toast('新手引导完成');
  }
  _destroy() {
    this._clearHl();
    // ★ 防御：移除 DOM 中所有 .tutor-overlay（不仅是 this.overlay 单引用）。
    //   任何异步竞态 / 重复 start() 若产生第二个全屏 pointer-events:auto 遮罩，
    //   只删单引用会漏掉它，导致它永久残留并吞掉所有点击（= 用户反馈的"跳过后点不了"）。
    document.querySelectorAll('.tutor-overlay').forEach(e => e.remove());
    this.overlay = null;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
