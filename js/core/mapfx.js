// mapfx.js
// 地图运行时氛围与特效层（数据源：config/map 单图文件的 environment / map_effects）。
// 纯 DOM + CSS 实现，零外部资源依赖。
//   · 暗度(darkness)：全屏黑遮罩，opacity = darkness(0~1)
//   · 天气(weather)：rain=雨丝下落 / fog=雾气漂移 / clear=无
//   · 地图特效(map_effects)：is_follow_camera=true  → 镜头/屏幕固定粒子（挂 viewport，玩家移动不动）
//                          is_follow_camera=false → 世界固定点【不再生成任何 DOM 光斑】
//                          （user 2026-09-11：传送点由用户自行接入，引擎不画 .mapfx-world-point）
//   · 音频：bgm / ambient 委托 sound.js（WebAudio 合成，零资源）
//
// 用法（见 scenes/scene.js MainScene）：
//   _setupMap 中  MapFX.apply(this, this.map);
//   _update   中  MapFX.update(dt, this);
//   changeMap / destroy 中 MapFX.clear();

import { playBgm, stopBgm, playAmbient, stopAmbient } from './sound.js?v=20261007c';

let _styleInjected = false;
function injectStyle() {
  if (_styleInjected) return;
  _styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
.mapfx-root{position:absolute;inset:0;pointer-events:none;z-index:60;overflow:hidden;}
.mapfx-darkness{position:absolute;inset:0;background:#000;pointer-events:none;}
.mapfx-rain{position:absolute;inset:0;pointer-events:none;}
.mapfx-rain span{position:absolute;top:-12%;width:2px;height:16px;background:linear-gradient(transparent,rgba(180,200,255,.75));animation:mapfx-rain-fall linear infinite;}
@keyframes mapfx-rain-fall{to{transform:translateY(120vh);}}
.mapfx-fog{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 35%,rgba(200,210,222,.38),rgba(170,182,198,.16));animation:mapfx-fog-drift 14s ease-in-out infinite alternate;}
@keyframes mapfx-fog-drift{from{transform:translateX(-6%);}to{transform:translateX(6%);}}
.mapfx-screen-petal{position:absolute;width:9px;height:9px;border-radius:50%;background:rgba(255,224,160,.85);box-shadow:0 0 8px rgba(255,224,160,.7);animation:mapfx-petal linear infinite;pointer-events:none;}
@keyframes mapfx-petal{0%{transform:translate(8vw,-12vh) scale(.6);opacity:0;}12%{opacity:.9;}100%{transform:translate(62vw,112vh) scale(1);opacity:0;}}
`;
  document.head.appendChild(s);
}

function _makeRain() {
  const r = document.createElement('div');
  r.className = 'mapfx-rain';
  let html = '';
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(Math.random() * 100);
    const delay = Math.floor(Math.random() * 2000);
    const dur = (0.45 + Math.random() * 0.5).toFixed(2);
    html += `<span style="left:${x}%;animation-delay:${delay}ms;animation-duration:${dur}s"></span>`;
  }
  r.innerHTML = html;
  return r;
}

function _makeScreenPetals(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'mapfx-screen-petal';
    el.style.left = Math.floor(Math.random() * 90) + 'vw';
    el.style.top = Math.floor(Math.random() * 10) + 'vh';
    el.style.animationDuration = (5 + Math.random() * 4).toFixed(2) + 's';
    el.style.animationDelay = (Math.random() * 4).toFixed(2) + 's';
    frag.appendChild(el);
  }
  return frag;
}

export const MapFX = {
  root: null,
  _bgmOn: false,
  _ambOn: false,

  // 应用某地图的氛围/特效；重复调用会先 clear 再重建
  apply(scene, map) {
    this.clear();
    if (!scene || !map) return;
    injectStyle();
    const vp = scene.viewport;
    if (!vp) return;

    const root = document.createElement('div');
    root.className = 'mapfx-root';
    vp.appendChild(root);
    this.root = root;

    // 暗度
    if (map.environment && map.environment.darkness > 0) {
      const d = document.createElement('div');
      d.className = 'mapfx-darkness';
      d.style.opacity = String(Math.min(1, Math.max(0, map.environment.darkness)));
      root.appendChild(d);
    }

    // 天气
    const w = (map.environment && map.environment.weather) || 'clear';
    if (w === 'rain') root.appendChild(_makeRain());
    else if (w === 'fog') { const f = document.createElement('div'); f.className = 'mapfx-fog'; root.appendChild(f); }

    // 地图特效
    // ⚠ user 2026-09-11 指定：世界固定点不再生成 .mapfx-world-point 光斑 div
    //   （传送点/特效点由用户自行接入），此处只保留跟随镜头的屏幕粒子。
    (map.mapEffects || []).forEach(e => {
      if (e.followCamera) root.appendChild(_makeScreenPetals(12));
    });

    // 音频（WebAudio 合成，资源缺失亦不报错）
    if (map.environment && map.environment.bgm) { try { playBgm(map.environment.bgm); this._bgmOn = true; } catch (e) {} }
    if (map.environment && map.environment.ambientSound) { try { playAmbient(map.environment.ambientSound); this._ambOn = true; } catch (e) {} }
  },

  // 每帧驱动（当前粒子均由 CSS 动画完成，这里预留扩展点，如动态调暗/切换天气）
  update(/* dt, scene */) { /* no-op for now */ },

  // 清理所有覆盖层与音频
  clear() {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    if (this._bgmOn) { try { stopBgm(); } catch (e) {} this._bgmOn = false; }
    if (this._ambOn) { try { stopAmbient(); } catch (e) {} this._ambOn = false; }
  }
};
