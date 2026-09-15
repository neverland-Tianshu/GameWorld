// js/ui/chat-bubble.js
// ─────────────────────────────────────────────────────────────────────────
// 头顶聊天气泡（照搬 AS3 face/PromptFace.as + component/BottomPrompt.as）
//
// 严格对齐源码（未做任何臆测）：
//   · 容器/调度 → face/PromptFace.as :: setChatPromptText / onChatTimer（30 对象池、6s 回收、最新置底、旧气泡去尾向上堆叠）
//   · 视觉       → component/BottomPrompt.as :: paintBackground（圆角矩形 + 底中三角 = 同一条 graphics 路径）
//   · 文本框     → face/prompt/PromptClass.as extends BottomPrompt，content→setChatText(text,156,true)；
//                 FACE 文本走 TextAreaClassSprite（硬性 <font size='12'>），故真实字号 12px 白字、定位(6,6)。
//   · 参数       → 填充 beginFill(0,0.65)；描边 lineStyle(1,14739081,1)→rgb(224,230,137)(#E0E689) 1px；
//                 圆角 _loc4_=3；宽=textW+16(≤156) 高=textH+16；三角 宽10 高5；restTime=6000ms。
//
// 渲染要点（本文件核心）：
//   ★ 圆角矩形 + 底中三角「融合」为同一条 SVG path，填充与描边都在该 path 上
//     → 黄线描边作用于【融合轮廓】，与 AS3 单一 paintBackground 路径一致（非 CSS border+伪元素分离）。
//   ★ 场景级层 z-index:70，高于技能声明面板(z:60) 与 飘字层(z:65)，故气泡显示于「血条 + 技能声明面板」之上。
//   ★ 战斗内为场景级层，自带 rAF 每帧锚定到释放者头顶（角色移动/演出均跟随）；
//     地图内直接挂 fig.el（0×0 脚底锚），随父节点自动跟随相机/移动。
//   ★ 仅最底部(最新)气泡带底中三角，旧气泡重绘去尾（照搬 AS3 重绘循环）。
// ─────────────────────────────────────────────────────────────────────────

// 复刻 AS3 paintBackground：圆角矩形 + 底中三角 融合为同一条 path，填充+描边统一（黄线描边作用于融合轮廓）
function paintBubble(el, tail) {
  const old = el.querySelector('.bubble-bg');
  if (old) old.remove();
  const W = el.offsetWidth, H = el.offsetHeight;   // 边界框 = 文本 + 内边距（盒模型）
  const r = 3;                                     // _loc4_ = 3
  let d = `M ${r} 0 L ${W - r} 0 Q ${W} 0 ${W} ${r} L ${W} ${H - r} Q ${W} ${H} ${W - r} ${H}`;
  if (tail) {
    // 底中三角(宽10 高5) 作为同路径的一部分向下凸出（照搬 AS3 把三角画进同一 graphics 路径）
    d += ` L ${W / 2 + 5} ${H} L ${W / 2} ${H + 5} L ${W / 2 - 5} ${H}`;
  }
  d += ` L ${r} ${H} Q 1 ${H} 0 ${H - r} L 0 ${r} Q 1 0 ${r} 0 Z`;
  const fill = 'rgba(0,0,0,0.65)';                 // 高画质 beginFill(0,0.65)
  el.insertAdjacentHTML('afterbegin',
    `<svg class="bubble-bg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<path d="${d}" fill="${fill}"></path></svg>`);
}

export class ChatBubbleManager {
  constructor(layer) {
    this.layer = layer || null;   // 战斗期 = .battle-chatLayer（场景级）；否则 null（气泡挂 fig.el 随父自动跟随）
    this.active = new Map();      // fig -> { stackEl, bubbles:[el...], sceneLevel:bool }   index0=最新(置底)
    this._raf = null;
  }

  setLayer(layer) { this.layer = layer || null; }

  /**
   * 让某单位头顶冒出一个聊天气泡。
   * @param {object} fig  目标单位（Fighter 实例，需含 x/y/_modelCxEl/_mcHeightPx/el）
   * @param {string} text 气泡文本
   */
  speak(fig, text) {
    if (!fig) return;
    const sceneLevel = !!this.layer;     // 战斗场景级层 / 地图挂 fig.el
    let entry = this.active.get(fig);
    if (!entry) {
      const stackEl = document.createElement('div');
      stackEl.className = 'chat-stack';
      const mount = sceneLevel ? this.layer : (fig.el || this.layer);
      if (!mount) return;
      mount.appendChild(stackEl);
      entry = { stackEl, bubbles: [], sceneLevel };
      this.active.set(fig, entry);
    }
    const b = document.createElement('div');
    b.className = 'bubble tail';          // 最新气泡带尾
    const txt = document.createElement('span');
    txt.className = 'bubble-txt';
    txt.textContent = String(text);
    b.appendChild(txt);
    entry.stackEl.appendChild(b);          // flex column → 追加即置底(贴近头顶/释放者)
    entry.bubbles.unshift(b);             // index0 = 最新
    entry.bubbles.forEach((o, i) => paintBubble(o, i === 0)); // 重绘：最新带尾、旧气泡去尾(照搬AS3)

    // 地图场景：一次性本地定位（fig.el 为 0×0 脚底锚，模型在其上方；随父节点自动跟随相机/移动）
    // ★ 直接复用战斗内血条高度算法：血条顶 = (-mcH + 3)；气泡底盘(底中三角)比血条顶高「三角形大小(5px)」→ box 底 = (-mcH+3) - 5
    if (!sceneLevel && fig.el) {
      const mcH = (fig._mcHeightPx != null) ? fig._mcHeightPx : 120;
      const cx = 0;  // ★ 地图挂 fig.el：x 对准角色坐标(=el 原点 x)，与血条一致；不再加 _modelCxEl(身体画布中心)，避免相对血条横移
      entry.stackEl.style.left = cx + 'px';
      entry.stackEl.style.top = (-(mcH) + 3) - 5 + 'px';
    }

    // restTime=6000ms 自动消失（照搬 AS3 chatTimer 递减回收）
    setTimeout(() => {
      b.remove();
      entry.bubbles = entry.bubbles.filter(x => x !== b);
      if (entry.bubbles.length) paintBubble(entry.bubbles[0], true);  // 新置底者重绘带尾
      else { entry.stackEl.remove(); this.active.delete(fig); }
    }, 6000);

    if (sceneLevel) this._ensureRaf();
  }

  _ensureRaf() {
    if (this._raf) return;
    const loop = () => {
      this._tick();
      this._raf = (this.active.size > 0) ? requestAnimationFrame(loop) : null;
    };
    this._raf = requestAnimationFrame(loop);
  }

  // 战斗场景级层：每帧把各栈锚定到释放者头顶
  // ★ 复用战斗内血条高度算法：血条顶(screen) = (fig.y - mcH + 3)；气泡底盘(底中三角)比血条顶高「三角形大小(5px)」→ box 底 = (fig.y-mcH+3) - 5
  _tick() {
    this.active.forEach((entry, fig) => {
      if (!entry.sceneLevel) return;       // 地图场景由父节点自动跟随，无需逐帧
      if (!fig || !fig.el || !fig.el.parentNode) { entry.stackEl.remove(); this.active.delete(fig); return; }
      const mcH = (fig._mcHeightPx != null) ? fig._mcHeightPx : 120;
      const cx = fig.x;  // ★ 对准角色坐标 fig.x，与血条/名字同一居中轴(AS3 Fighter.as:516-523)；绝不 +_modelCxEl，否则身体未居中模型(如210071偏38px)气泡相对血条横移
      const anchorY = (fig.y - mcH + 3) - 5; // 紧贴血条上方(仅隔三角形高度)，置于血条+技能声明面板之上
      entry.stackEl.style.left = cx + 'px';
      entry.stackEl.style.top = anchorY + 'px';
    });
  }

  clearAll() {
    this.active.forEach(entry => { if (entry.stackEl && entry.stackEl.parentNode) entry.stackEl.remove(); });
    this.active.clear();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
}
