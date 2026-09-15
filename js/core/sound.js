// sound.js
// 自包含 WebAudio 合成音效系统（无外部音频资源，对齐"禁止臆造资源"铁律）。
// 让设置面板「音效」开关从"谎言"变为可用：playSfx 受 ui._settings.sound 门控。
//
// 设计要点：
//  - 不依赖任何 .mp3/.wav，全部用 OscillatorNode + GainNode 包络合成，零资源依赖。
//  - AudioContext 懒建（首次 playSfx 触发），天然落在用户手势内（点击），满足浏览器自动播放策略。
//  - 运行期音效开关由 bindUI(ui) 注入的 UI 实例实时读取，避免开关与播放割裂。

let _ctx = null;            // 懒建的 AudioContext
let _ui = null;             // 可选：用于读取运行期 ui._settings.sound（开关单一事实来源）
let _enabled = true;        // 未绑定 UI 时的兜底开关（与 _settings.sound 默认一致）

// 绑定 UI 实例，使 playSfx 实时读取 ui._settings.sound（开关由设置面板统一写入）
export function bindUI(ui) { _ui = ui; }

// 显式设定开关（单测/兜底用）
export function setEnabled(on) { _enabled = !!on; }

// 读取当前是否允许播放音效：优先 UI 的运行期设置，兜底用模块级 _enabled
function isEnabled() {
  if (_ui && _ui._settings && typeof _ui._settings.sound === 'boolean') return _ui._settings.sound;
  return _enabled;
}

// 懒建 AudioContext（首次在用户手势内创建，满足浏览器策略；已存在则恢复 suspended 状态）
export function initAudio() {
  if (_ctx) {
    if (_ctx.state === 'suspended' && typeof _ctx.resume === 'function') {
      try { _ctx.resume(); } catch (e) { /* 忽略 */ }
    }
    return _ctx;
  }
  const AC = (typeof AudioContext !== 'undefined') ? AudioContext
           : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
  if (!AC) return null;       // 环境无 WebAudio（如 jsdom）→ 静默降级
  try { _ctx = new AC(); } catch (e) { _ctx = null; }
  return _ctx;
}

// 音效配方：短促合成音；arp 为上行/下行琶音（半音偏移序列）。
const RECIPES = {
  click:   { type: 'square',   f: 540, dur: 0.05, gain: 0.10, slide: 0 },
  equip:   { type: 'triangle', f: 440, dur: 0.13, gain: 0.16, slide: 240 },   // 上扬：穿戴
  unequip: { type: 'triangle', f: 440, dur: 0.13, gain: 0.15, slide: -200 },  // 下抑：脱下
  attack:  { type: 'square',   f: 320, dur: 0.06, gain: 0.12, slide: -70 },   // 攻击挥击
  hit:     { type: 'sawtooth', f: 200, dur: 0.08, gain: 0.18, slide: -90 },   // 命中受击
  win:     { type: 'triangle', f: 523, dur: 0.46, gain: 0.18, arp: [0, 4, 7, 12] },   // 上行大三和弦琶音
  lose:    { type: 'sawtooth', f: 330, dur: 0.52, gain: 0.16, arp: [0, -3, -7, -12] }, // 下行小调叹息
  levelup: { type: 'triangle', f: 523, dur: 0.55, gain: 0.20, arp: [0, 4, 9, 12] },    // 升级：更亮的大三+六度上行
  pickup:  { type: 'square',   f: 700, dur: 0.08, gain: 0.11, slide: 220 },             // 拾取：短促上扬叮
  catch:   { type: 'triangle', f: 660, dur: 0.40, gain: 0.18, arp: [0, 7, 12] },       // 捕捉成功：大三度+八度清脆
  flee:    { type: 'sawtooth', f: 420, dur: 0.18, gain: 0.13, slide: -260 },            // 逃跑：下行呼啸
  heal:    { type: 'sine',     f: 523, dur: 0.22, gain: 0.13, slide: 120 },             // 治疗：柔和上扬微光
  defend:  { type: 'triangle', f: 392, dur: 0.14, gain: 0.13, slide: 30 },              // 防御：轻柔举盾
  baoqi:   { type: 'sawtooth', f: 200, dur: 0.32, gain: 0.15, slide: 380 },             // 爆气：蓄力上行扫频
  summon:  { type: 'triangle', f: 523, dur: 0.42, gain: 0.16, arp: [0, 5, 9] },        // 召唤：魔法三音上行
  crit:    { type: 'square',   f: 880, dur: 0.10, gain: 0.16, slide: 420 },            // 暴击：明亮上扬短促"叮"
};

// 播放单音（带指数包络，避免爆音）
function _tone(ctx, opt, t0) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = opt.type || 'sine';
  const f0 = opt.f;
  const f1 = (opt.slide) ? f0 + opt.slide : f0;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.linearRampToValueAtTime(f1, t0 + opt.dur);
  const peak = (opt.gain != null) ? opt.gain : 0.15;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + opt.dur + 0.02);
}

// 内部播放（已通过门控 & 已有 ctx）
function _play(name, ctx) {
  const r = RECIPES[name]; if (!r) return;
  const t0 = ctx.currentTime;
  if (r.arp && r.arp.length) {
    const step = r.dur / r.arp.length;
    r.arp.forEach((semi, i) => {
      const f = r.f * Math.pow(2, semi / 12);
      _tone(ctx, { type: r.type, f, dur: step * 1.5, gain: r.gain, slide: 0 }, t0 + i * step);
    });
  } else {
    _tone(ctx, r, t0);
  }
}

// 对外入口：受音效开关门控；开关关闭或环境无 WebAudio 时静默跳过
export function playSfx(name) {
  if (!isEnabled()) return;
  const ctx = initAudio();
  if (!ctx) return;
  try { _play(name, ctx); } catch (e) { /* 个别浏览器节点异常不阻断游戏 */ }
}

// ── 背景音乐 / 环境音（同样零外部资源，纯 WebAudio 合成，遵守"不臆造资源"铁律）──
//   playBgm(name)   ：缓慢琶音/和弦循环床，name 仅作音色种子（同名稳定，不同名各异）。
//   playAmbient(name)：环境音床；含 wind/bird 关键字时叠加风声+随机鸟鸣。
//   均由 musicEnabled() 门控（ui._settings.music，默认开）；无 WebAudio 时静默降级。
let _bgm = null;
let _amb = null;

function musicEnabled() {
  if (_ui && _ui._settings && typeof _ui._settings.music === 'boolean') return _ui._settings.music;
  return true;
}
function _clearBgm() { if (_bgm) { try { _bgm.stop(); } catch (e) {} _bgm = null; } }
function _clearAmb() { if (_amb) { try { _amb.stop(); } catch (e) {} _amb = null; } }

// 简易确定性伪随机（同名 bgm 听感稳定）
function _seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

export function playBgm(name) {
  if (!name || !musicEnabled()) return;
  const ctx = initAudio();
  if (!ctx) return;
  _clearBgm();
  const base = 220 * (1 + _seedFrom(String(name)) * 0.5);   // 220~330Hz 基音
  const scale = [1, 1.2, 1.5, 2, 1.5, 1.2];                // 五声风味的音阶比
  let i = 0;
  const step = 1.9;
  const tick = () => {
    if (!_bgm) return;
    const f = base * scale[i % scale.length];
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, ctx.currentTime);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + step * 0.95);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + step);
    i++;
  };
  tick();
  const timer = setInterval(tick, step * 1000);
  _bgm = { stop() { clearInterval(timer); } };
}

export function stopBgm() { _clearBgm(); }

export function playAmbient(name) {
  if (!name || !musicEnabled()) return;
  const ctx = initAudio();
  if (!ctx) return;
  _clearAmb();
  // 风声：低通滤波的棕噪声循环
  const bufSize = 2 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < bufSize; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.2;
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480;
  const g = ctx.createGain(); g.gain.value = 0.035;
  src.connect(lp); lp.connect(g); g.connect(ctx.destination); src.start();
  // 鸟鸣：名称含 bird/niao 时叠加随机短啁啾
  let birdTimer = null;
  if (/bird|niao|鸟/i.test(name)) {
    const chirp = () => {
      if (!_amb) return;
      const o = ctx.createOscillator(), gg = ctx.createGain();
      o.type = 'sine';
      const b = 1700 + Math.random() * 1100;
      o.frequency.setValueAtTime(b, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(b * 1.5, ctx.currentTime + 0.08);
      gg.gain.setValueAtTime(0.0001, ctx.currentTime);
      gg.gain.exponentialRampToValueAtTime(0.025, ctx.currentTime + 0.02);
      gg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      o.connect(gg); gg.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.2);
    };
    birdTimer = setInterval(() => { if (Math.random() < 0.5) chirp(); }, 2600);
  }
  _amb = { stop() { try { src.stop(); } catch (e) {} if (birdTimer) clearInterval(birdTimer); } };
}

export function stopAmbient() { _clearAmb(); }
