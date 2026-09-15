/*
 * diag-banner.js — 冻结自诊断横幅（经典脚本，先于游戏模块执行）
 * 目的：把"无任何报错提示"变成"立刻看到真实报错"。
 *   · window.onerror / unhandledrejection 全部捕获并显示在屏幕底部红条
 *   · 每秒扫描被 _loopStep 吞掉的循环异常（window.__loopErrors）并弹出最新一条
 *     → 若 _update 每帧抛错导致"角色不动但循环活着"，这里会显示真实错误与行号
 *   · 实时心跳时间戳：若时间戳冻结 = 主线程硬卡死（按排除法判定）
 *   · 实时显示 px/py：若为 NaN = 位置被 NaN 污染（存档/速度异常类静默冻结）
 * 横幅 pointer-events:none，绝不会自己吞输入。
 */
(function () {
  function ensure() {
    if (window.__diagBanner) return;
    var b = document.createElement('div');
    b.id = 'diag-banner';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;max-height:42vh;overflow:auto;' +
      'background:rgba(24,0,0,.92);color:#ffb4b4;font:12px/1.5 Consolas,Menlo,monospace;' +
      'padding:6px 10px;pointer-events:none;white-space:pre-wrap;display:none;';
    (document.body || document.documentElement).appendChild(b);
    window.__diagBanner = b;
    window.__diagLines = [];
  }
  function render(beat) {
    ensure();
    var b = window.__diagBanner;
    b.textContent = (window.__diagLines.join('\n') ? window.__diagLines.join('\n') + '\n' : '') + beat;
    b.style.display = 'block';
  }
  function push(line) {
    ensure();
    var L = window.__diagLines;
    L.push('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (L.length > 40) L.shift();
  }
  // ★ 13u：冻结诊断输出开关（设置「冻结诊断→系统」，默认关）。
  //   freezeSettingOn() 读取运行期 ui._settings.freezeToSystem（设置面板实时翻转，无需持久化）。
  //   freezeOut()：开关开启时把冻结诊断（心跳/FREEZE/SLOW/LONGTASK/STUCK/上次卡死回显）路由到
  //   游戏内「系统」聊天窗（ui.log(line,'sys')）；关闭时完全静默（不打红条、不刷系统窗）。
  //   注意：WINDOW.ERROR / unhandledrejection / LOOP_ERR 这类「崩溃捕获」仍走 push() 留红条兜底，
  //   不属「冻结诊断」，默认也显示，避免静默吞掉真实报错。
  function freezeSettingOn() {
    var ts = window.__TS;
    var ui = ts && (ts.ui || (ts.current && ts.current.ui));
    return !!(ui && ui._settings && ui._settings.freezeToSystem);
  }
  function freezeOut(line) {
    if (!freezeSettingOn()) return;
    var ts = window.__TS;
    var ui = ts && (ts.ui || (ts.current && ts.current.ui));
    if (!ui || typeof ui.log !== 'function') return;
    String(line).split('\n').forEach(function (l) {
      try { ui.log(l, 'sys'); } catch (_) {}
    });
  }
  // 在游戏加载前就装好全局错误捕获
  window.addEventListener('error', function (e) {
    var m = (e.error && e.error.stack) ? e.error.stack : (e.message || String(e));
    push('WINDOW.ERROR: ' + m);
    render('（错误已捕获，见上方）');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var m = (r && (r.stack || r.message)) ? (r.stack || r.message) : String(r);
    push('UNHANDLED.REJECTION: ' + m);
    render('（未处理 Promise 拒绝，见上方）');
  });

  window.__lastBeat = Date.now();
  var _stuckN = 0, _lastPx = null, _lastPy = null;
  setInterval(function () {
    window.__lastBeat = Date.now();
    var tt = new Date().toLocaleTimeString();
    var s = window.__TS && window.__TS.current;
    var beat;
    if (s && s.player) {
      var px = s.player.x, py = s.player.y;
      var speed = s.player.speed;
      var pathLen = s.player.path ? s.player.path.length : 0;
      beat = '心跳 ' + tt + ' | ' + s.constructor.name +
        ' | map=' + (s.map && (s.map.map_name || s.map.id)) +
        ' | loop=' + !!s._loopRunning + ' | loopErrN=' + (s._loopErrN || 0) +
        ' | speed=' + (speed === undefined ? 'undef' : (Number.isFinite(speed) ? speed : 'NaN!')) +
        ' | path=' + pathLen +
        ' | px=' + (Number.isFinite(px) ? Math.round(px) : 'NaN!') +
        ' | py=' + (Number.isFinite(py) ? Math.round(py) : 'NaN!') +
        // ★ 13r：逐帧 JS 总量 / 并发 rAF 链数 / longtask —— 专治"卡但红条什么都不显示"
        (function () {
          var out = '';
          var st = window.__wdStats;
          if (st) out += ' | 帧JS=' + st.frameAvg + '(峰值' + st.framePeak + ')ms | 链=' + st.chainPeak;
          var lt = window.__wdLT;
          if (lt && lt.n) out += ' | LT=' + lt.n + '/max' + Math.round(lt.max) + 'ms';
          return out;
        })();
      // STUCK 侦测：循环活着 + 有寻路路径 + 位置长时间不变 = 静默冻结（用户症状精确信号）
      if (s._loopRunning && s.constructor.name === 'MainScene' && pathLen > 0) {
        if (px === _lastPx && py === _lastPy) {
          _stuckN++;
          if (_stuckN >= 5 && !window.__diagStuck) {
            window.__diagStuck = true;
            freezeOut('[STUCK] 有寻路(path=' + pathLen + ')但位置 ' + _stuckN + 's 未变化：speed=' + speed +
              ' → 主循环存活但玩家不动，疑似 _update 被吞异常或速度/坐标异常（NaN 防御是否触发见上方预警）');
          }
        } else { _stuckN = 0; window.__diagStuck = false; }
      } else { _stuckN = 0; window.__diagStuck = false; }
      _lastPx = px; _lastPy = py;
      // 扫描被 _loopStep 吞掉的循环异常
      var buf = window.__loopErrors || [];
      if (buf.length && buf.length !== window.__diagLastLoopN) {
        window.__diagLastLoopN = buf.length;
        var last = buf[buf.length - 1];
        push('LOOP_ERR @' + last.tag + ': ' + last.msg + ' | ' + (last.stack || '').split('\n').slice(0, 2).join(' '));
      }
    } else if (s) {
      beat = '心跳 ' + tt + ' | ' + s.constructor.name + ' | 无 player';
    } else {
      beat = '心跳 ' + tt + ' | 尚未初始化 __TS';
    }
    if (freezeSettingOn()) render(beat);   // ★ 13u：开关关时心跳也静默，红条仅在真实报错时由 push() 弹出
  }, 1000);

  window.__dumpDiag = function () {
    var s = window.__TS && window.__TS.current;
    return {
      scene: s && s.constructor.name,
      map: s && s.map && (s.map.map_name || s.map.id),
      loopRunning: !!(s && s._loopRunning),
      loopErrN: s && s._loopErrN,
      loopErrByTag: s && s._loopErrByTag,
      loopErrors: window.__loopErrors || [],
      winerr: window.__winerr || [],
      lastBeat: new Date(window.__lastBeat).toLocaleTimeString(),
      now: new Date().toLocaleTimeString(),
      px: s && s.player && Math.round(s.player.x),
      py: s && s.player && Math.round(s.player.y),
      speed: s && s.player && s.player.speed,
      pathLen: s && s.player && (s.player.path ? s.player.path.length : -1),
      wdStats: window.__wdStats,          // ★ 13r：逐帧 JS / 并发链
      longtask: window.__wdLT             // ★ 13r：原生 longtask 统计
    };
  };

  // ───────────────────────── 主线程卡死看门狗（13n 新增） ─────────────────────────
  // 旧横幅的 setInterval 心跳与主线程同线程，主线程一旦被同步长任务阻塞就一起停摆，
  // 故「卡死时红条什么都不显示」。本看门狗改用 Web Worker（独立线程）做心跳：
  //   主线程每 150ms 向 Worker ping 一次；Worker 超过 FREEZE_MS 未收到 ping 即判定主线程被阻塞，
  //   解除阻塞后把「卡死前最近一次慢操作的函数栈」回传并打到红条/控制台/localStorage。
  // 同时包裹 requestAnimationFrame 与重事件监听：任一回调耗时 > SLOW_MS 即抓取 new Error().stack，
  //   这样即便卡死发生在 fanvas 内部 rAF / 任意事件处理里，也能精确定位到函数与行号。
  (function installFreezeWatchdog() {
    try {
      var SLOW_MS = 100;     // 单帧/单事件超过 100ms 即记录（排除正常抖动）
      var FREEZE_MS = 800;   // 主线程超过 800ms 无心跳即判定为「卡死」
      var slowBuf = [];
      var lastFpush = 0;
      function recSlow(kind, dt, stack) {
        slowBuf.push({ t: Date.now(), kind: kind, dt: Math.round(dt), stack: (stack || '').slice(0, 1600) });
        if (slowBuf.length > 12) slowBuf.shift();
        freezeOut('[SLOW ' + kind + '] ' + Math.round(dt) + 'ms — ' + (stack || '').split('\n').slice(1, 3).join(' '));
      }
      window.__freezeSlow = function () { return slowBuf.slice(); };

      // 1) 包裹 requestAnimationFrame：捕获慢帧（含 fanvas 内部回调，因其也走本全局 patch）
      //    ★ 13p 修正：原先在 finally 里 new Error().stack 只抓到本 wrapper 自身栈，定位不到真凶；
      //      改为在【调度时刻】捕获调用栈（看是谁 requestAnimationFrame 了这个慢回调）+ 记录 cb 名，
      //      这样 [SLOW rAF] 直接告诉你慢的是 _loop / fanvas 渲染 / _revealText 还是别的。
      var _raf = window.requestAnimationFrame.bind(window);
      // ★ 13r 新增：每帧 JS 总量 / 每帧并发链数 —— 旧模型只看"单次回调是否 >100ms"，
      //   而真机卡顿形态是「数十个中等开销回调叠加」（实测灵昌城约 70 条 fanvas Timer 链、
      //   每帧 ~18ms 纯 JS），单次都 <30ms ⇒ 旧模型永远测不到。这里改为按帧汇总，能直接暴露该形态。
      var frameJs = 0, frameJsMax = 0, frameJsSum = 0, frameN = 0, chainSet = new Set(), chainPeak = 0;
      var _statsTick = function () {
        if (frameN) {
          var avg = frameJsSum / frameN;
          if (avg > frameJsMax) frameJsMax = avg;
          window.__wdStats = {
            frameAvg: Math.round(avg * 10) / 10,
            framePeak: Math.round(frameJsMax * 10) / 10,
            chainPeak: chainPeak,        // 本秒内"同一帧注册过 rAF 的不同回调"峰值 ≈ 并发动画链数
            frames: frameN
          };
        }
        frameJs = 0; frameJsSum = 0; frameN = 0; chainPeak = chainSet.size; chainSet.clear();
        _raf(_statsTick);
      };
      _raf(_statsTick);
      window.requestAnimationFrame = function (cb) {
        var schedStack = new Error().stack;
        var cbLabel = (cb && cb.name) ? cb.name : (cb && cb.toString ? cb.toString().slice(0, 90) : '<anon>');
        try { chainSet.add(cb); } catch (_) {}
        return _raf(function (t) {
          var t0 = performance.now();
          try { return cb(t); } finally {
            var dt = performance.now() - t0;
            frameJs += dt; frameJsSum += dt; frameN++;
            if (dt > SLOW_MS) recSlow('rAF:' + cbLabel, dt, schedStack);
          }
        });
      };
      // 2) 包裹重事件监听：捕获慢事件处理（click/mousemove/contextmenu/keydown…）
      // ⚠ add/remove 必须成对包裹：add 时把 fn 包成 w（性能计时）后注册到浏览器，
      //   remove 时若仍传原 fn，浏览器按回调引用匹配 w ⇒ 移除失败，window 级
      //   mousemove/mouseup 永久泄漏（滚动条「松开鼠标后仍跟随移动、无法取消」即此因，
      //   2026-10-07 定位）。WeakMap 以 fn 为 key 复用同一个 w，保证 add/remove 引用一致。
      var HEAVY = { click: 1, mousedown: 1, mouseup: 1, mousemove: 1, contextmenu: 1, keydown: 1, keyup: 1, wheel: 1, dblclick: 1, pointerdown: 1, pointermove: 1, touchstart: 1, touchmove: 1 };
      var _add = EventTarget.prototype.addEventListener;
      var _rm = EventTarget.prototype.removeEventListener;
      var _wmap = new WeakMap();
      function _wrapHeavy(type, fn) {
        var rec = _wmap.get(fn);
        if (rec) {
          if (rec.types.indexOf(type) < 0) rec.types += '|' + type;
          return rec.w;
        }
        var types = type;
        var w = function () {
          var t0 = performance.now();
          try { return fn.apply(this, arguments); } finally {
            var dt = performance.now() - t0;
            if (dt > SLOW_MS) recSlow('evt:' + types, dt, new Error().stack);
          }
        };
        _wmap.set(fn, { w: w, types: types });
        return w;
      }
      EventTarget.prototype.addEventListener = function (type, fn, opt) {
        if (typeof fn === 'function' && HEAVY[type]) {
          return _add.call(this, type, _wrapHeavy(type, fn), opt);
        }
        return _add.call(this, type, fn, opt);
      };
      EventTarget.prototype.removeEventListener = function (type, fn, opt) {
        if (typeof fn === 'function' && HEAVY[type]) {
          var rec = _wmap.get(fn);
          if (rec) return _rm.call(this, type, rec.w, opt);
        }
        return _rm.call(this, type, fn, opt);
      };

      // 2.5) ★ 13r 新增（补盲区，三件）：
      //   a. longtask 观察：浏览器原生判定 >50ms 的任务，覆盖"多个中等回调被浏览器合并成一个长任务"的情形——
      //      正是看门狗旧模型测不到的真机卡顿形态（实测 8s 内 52 条 longtask、最长 201ms，而旧模型一条都没报）。
      //   b. setTimeout / setInterval 包裹：旧模型只包 rAF，走定时器的同步长任务完全在盲区。
      //   c. 逐帧统计见上方 __wdStats。
      window.__wdLT = { n: 0, max: 0, recent: [] };
      try {
        if (window.PerformanceObserver) {
          new PerformanceObserver(function (list) {
            var es = list.getEntries();
            for (var i = 0; i < es.length; i++) {
              var d = es[i].duration;
              window.__wdLT.n++;
              if (d > window.__wdLT.max) window.__wdLT.max = d;
              if (d >= 100) {
                window.__wdLT.recent.push(Math.round(d));
                if (window.__wdLT.recent.length > 8) window.__wdLT.recent.shift();
                freezeOut('[LONGTASK] 主线程单任务 ' + Math.round(d) + 'ms（>100ms，是"卡一下"的直接证据；' +
                  '若伴随帧JS升高说明是 CPU 叠加，若帧JS很低则偏 GPU/合成）');
              }
            }
          }).observe({ entryTypes: ['longtask'] });
        }
      } catch (_) {}
      var _st = window.setTimeout, _si = window.setInterval;
      window.setTimeout = function (fn, ms) {
        if (typeof fn !== 'function') return _st.apply(window, arguments);
        var args = Array.prototype.slice.call(arguments, 2);
        return _st(function () {
          var t0 = performance.now();
          try { return fn.apply(this, args); } finally {
            var dt = performance.now() - t0;
            if (dt > SLOW_MS) recSlow('timeout', dt, new Error().stack);
          }
        }, ms);
      };
      window.setInterval = function (fn, ms) {
        if (typeof fn !== 'function') return _si.apply(window, arguments);
        var args = Array.prototype.slice.call(arguments, 2);
        return _si(function () {
          var t0 = performance.now();
          try { return fn.apply(this, args); } finally {
            var dt = performance.now() - t0;
            if (dt > SLOW_MS) recSlow('interval', dt, new Error().stack);
          }
        }, ms);
      };

      // 3) Worker 心跳：主线程定时 ping；Worker 超过 FREEZE_MS 未收到 ping 即判定卡死
      var src = "var L=Date.now();onmessage=function(e){if(e.data==='p')L=Date.now();else if(e.data&&e.data.t==='i'){setInterval(function(){var g=Date.now()-L;if(g>" + FREEZE_MS + ")postMessage({type:'f',ms:g});},300);}};";
      var wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      wk.postMessage({ t: 'i' });
      wk.onmessage = function (e) {
        if (e.data && e.data.type === 'f') {
          var now = Date.now();
          if (now - lastFpush < 2000) return;   // 同一段卡死只报一次
          lastFpush = now;
          var last = slowBuf[slowBuf.length - 1];
          var msg = '[FREEZE] 主线程被同步长任务阻塞约 ' + Math.round(e.data.ms) + 'ms（右键/点击无响应即此因）';
          if (last) msg += '\n卡死前最近慢操作: ' + last.kind + ' 耗时 ' + last.dt + 'ms\n' + (last.stack || '');
          else msg += '\n（无慢操作记录：可能是未被 rAF/事件包裹的纯同步循环，请把此条发给我）';
          freezeOut(msg);
          try { localStorage.setItem('tsqt.freeze.last', JSON.stringify({ at: Date.now(), ms: e.data.ms, last: last || null })); } catch (_) {}
        }
      };
      setInterval(function () { try { wk.postMessage('p'); } catch (_) {} }, 150);

      // 跨刷新：若上一次会话曾卡死并写入 localStorage，本次启动直接回显
      try {
        var prev = localStorage.getItem('tsqt.freeze.last');
        if (prev) {
          var p = JSON.parse(prev);
          freezeOut('[上一次会话曾卡死] 约 ' + Math.round(p.ms) + 'ms @ ' + new Date(p.at).toLocaleString() +
            (p.last ? (' | 最近慢操作 ' + p.last.kind + ' ' + p.last.dt + 'ms') : '') + ' —— 复现后系统窗会显示精确函数栈');
        }
      } catch (_) {}
    } catch (e) {
      freezeOut('[watchdog] 初始化失败: ' + (e && e.message));
    }
  })();

  ensure();
  freezeOut('冻结自诊横幅已启用：开启「设置→冻结诊断→系统」后，卡死/慢帧诊断将输出到右侧「系统」聊天窗（默认关闭=静默）');
  // ★ 13u：默认关闭，启动时不强制弹红条；开启开关后冻结诊断走系统窗
})();
