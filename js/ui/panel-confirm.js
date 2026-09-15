/**
 * js/ui/panel-confirm.js —— 通用确认弹窗（复刻 AS3 PromptPanel）
 *
 * 对齐 deobfuscated/panel/prompt/PromptPanel.as：
 *   initCenterBackground(null,true,"small")  ⇒ 小金框九宫格（common_small_*）
 *   initField：标题 (0,15) 色 10365710(#9DC9CE) 16号 居中；正文 (0,50) 黑色 14号 居中
 *   initButton：确认/取消按钮（panel_btn_bg4 + text_panel_confirm/cancel），底部居中
 *   resetPompt：正文宽 > bgWidth-10 ⇒ 宽 = textWidth+40；高 = 正文底 + 60
 *   update：x=(800-bgWidth)/2, y=(viewHeight-bgHeight)/2（本工程 .tsqt-panel 默认居中，免设）
 *   buttonHandler：确认 → prompt.doPrompt()，取消 → prompt.cancelPrompt()，随后 close
 *   isRightClickClose = false ⇒ 只能按按钮关闭（本工程同样隐藏 ✕）
 *
 * 用法：ui.openPanel('confirm', { title, content, confirmText, cancelText, confirm(), cancel() })
 */
import { BasePanel } from './panel-manager.js?v=20261007c';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ConfirmPanel extends BasePanel {
  constructor(ui) {
    // AS3 PromptPanel 小金框；isBgBlackSp 模态遮罩（打开期间锁住世界，防误操作）
    super({
      id: 'panel-confirm', title: '', width: 260, height: 130, ui, isBgBlackSp: true,
      // AS3 PromptPanel initCenterBackground(null,true,"small")：common_small_* 薄金框
      bgSkin: {
        background: 'common_background',
        header: 'common_small_corner1',
        footer: 'common_small_corner2',
        headerBorder: 'common_small_sideline3',
        footerBorder: 'common_small_sideline2',
        borderL: 'common_small_sideline1',
        borderR: 'common_small_sideline1',
      },
    });
    this._opts = null;
  }

  init() { this._fit(); }

  // ui.openPanel('confirm', opts) 注入
  applyOpenOpts(opts) {
    this._opts = opts || {};
    this.render();
  }

  onOpen() { this.render(); }

  render() {
    const o = this._opts || {};
    const title = o.title || '提示';
    const content = o.content || '';
    // 隐藏通用面板的标题栏与 ✕（AS3 PromptPanel 无这两样，只能按按钮关闭）
    if (this.titleEl) this.titleEl.style.display = 'none';
    const closeBtn = this.dom && this.dom.querySelector('.pb-close');
    if (closeBtn) closeBtn.style.display = 'none';

    this.setContent(
      '<div class="cf-title">' + esc(title) + '</div>' +
      '<div class="cf-content">' + content + '</div>' +
      '<div class="cf-btns">' +
        '<button class="pb-btn cf-ok" id="cf-ok">' + esc(o.confirmText || '确认') + '</button>' +
        '<button class="pb-btn ghost cf-no" id="cf-no">' + esc(o.cancelText || '取消') + '</button>' +
      '</div>');

    const ok = this.body.querySelector('#cf-ok');
    const no = this.body.querySelector('#cf-no');
    ok.onclick = () => { this.close(); if (o.confirm) try { o.confirm(); } catch (e) {} };
    no.onclick = () => { this.close(); if (o.cancel) try { o.cancel(); } catch (e) {} };
    no.oncontextmenu = (e) => e.preventDefault();
    this._fit();
  }

  // 对齐 AS3 resetPompt：正文宽超过预留则加宽，高度随正文行数自适应；尺寸变化触发九宫格重烘
  _fit() {
    if (!this.dom) return;
    requestAnimationFrame(() => {
      if (!this.dom || this.dom.style.display === 'none') return;
      const content = this.body.querySelector('.cf-content');
      if (!content) return;
      // 宽：正文 scrollWidth 超过预留（面板 260 - 内边距 60）才加宽，上限 420
      const needW = Math.min(420, Math.max(220, content.scrollWidth + 60));
      // 高：标题 40 + 正文高 + 按钮 40 + 边距 24（padding 12×2 + border 2）
      const needH = Math.min(320, Math.max(110, 40 + content.offsetHeight + 40 + 26));
      const w = Math.max(needW, 220), h = Math.max(needH, 110);
      if (this.dom.style.width !== w + 'px' || this.dom.style.height !== h + 'px') {
        this.dom.style.width = w + 'px';
        this.dom.style.height = h + 'px';
        if (this.bgEngine) this.bgEngine.bakeIfVisible();   // 尺寸变了，九宫格重烘（同尺寸零成本）
      }
    });
  }
}
