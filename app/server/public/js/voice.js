// 语音输入（按住说话）
//
// 交互：
//   · 输入框为空时，发送键变成麦克风；点一下进入语音模式
//   · 语音模式下输入框位置变成「按住 说话」：按住后整块输入区被全宽遮罩盖住，
//     显示实时电平声波 + 「松手传送，上滑取消」
//   · 手指上滑进入文案区域 → 取消态（声波与文案变红，文案改「松开取消」），滑回下方恢复
//   · 松手：取消态 → 丢弃 + 轻提示；否则转写后**直接发送**
//   · 发送键位置变成键盘按钮，点一下回文本模式并聚焦输入框（移动端弹键盘）
//
// 录音在客户端：套壳原生桥（http 页面也能用）或 HTTPS 下的 MediaRecorder；
// 转写在服务端 mcp_asr（经 core 的 /api/asr 中转）。
// 电平：浏览器用 AnalyserNode 算 RMS；套壳上报 onNativeVoiceAmp（原始 getMaxAmplitude）。
// 归一化/门限/平滑全部在页面侧做，壳不做任何换算。
//
// 包在 IIFE 里：前端是共享全局作用域的经典脚本，顶层声明会和其他文件撞名。

(function () {
  'use strict';

  const hold = $('voice-hold');
  const ta = $('msg-input');
  const overlay = $('voice-overlay');
  const hintEl = $('voice-hint');
  const waveEl = $('voice-wave');
  if (!hold || !ta) return;

  const native = (window.AgentNative && typeof window.AgentNative.startVoice === 'function')
    ? window.AgentNative : null;
  const webOk = !!(window.isSecureContext && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function' && window.MediaRecorder);

  const MAX_MS = 60000;        // 单次录音上限
  const MIN_MS = 500;          // 短于这个时长按误触处理，不上传
  const NO_RESULT_MS = 3000;   // 松开后壳迟迟不回音频（比如还在等权限）→ 复位
  const BAR_COUNT = 45;        // 声波柱数（要足够宽，手指按住时两侧仍能看到）

  // 两端矮、中间高的包络：看起来像一段声波而不是一排等高柱子
  const WEIGHTS = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    WEIGHTS.push(0.45 + 0.55 * Math.sin(Math.PI * (i + 0.5) / BAR_COUNT));
  }
  const bars = [];
  if (waveEl) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const b = document.createElement('i');
      waveEl.appendChild(b);
      bars.push(b);
    }
  }

  let available = false;       // 有能力 + 服务端接线：发送键才显示麦克风
  let mode = false;            // 是否处于语音模式
  let phase = 'idle';          // idle | arming（等 getMedia）| recording | busy
  let pressing = false;
  let pressY = 0;              // 本次按压的起始 Y（判断“确实上滑了”）
  let cancelArmed = false;     // 已上滑到取消区
  let discard = false;         // 本次录音太短/已取消：结果到了也丢掉
  let recordStartAt = 0;
  let stopTimer = null;
  let hardTimer = null;
  let watchdog = null;
  let rec = null;
  let stream = null;
  let chunks = [];
  let mime = '';

  // 电平与渲染
  let rafId = 0;
  let levelTarget = 0;
  let levelCur = 0;
  let lastRealLevelAt = 0;
  let audioCtx = null;
  let analyser = null;
  let audioBuf = null;
  let srcNode = null;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // 电平归一化的唯一实现：浏览器（RMS）和壳（峰值幅度）都在这里落到 0~1。
  // 低于 -55dB 视为静音，-5dB 及以上视为满幅；要调灵敏度只改这两个常量。
  const LEVEL_FLOOR_DB = -55;
  const LEVEL_RANGE_DB = 50;
  function dbToLevel(db) {
    return clamp01((db - LEVEL_FLOOR_DB) / LEVEL_RANGE_DB);
  }

  function setHoldText(s) {
    if (hold.textContent !== s) hold.textContent = s;
  }

  // ---------- 遮罩 / 声波 ----------
  function setOverlayMode(m) { // 'send' | 'cancel' | 'busy'
    cancelArmed = m === 'cancel';
    if (overlay) overlay.classList.toggle('cancel', m === 'cancel');
    if (hintEl) {
      hintEl.textContent = m === 'cancel' ? '松开取消'
        : m === 'busy' ? '正在识别…' : '松手传送，上滑取消';
    }
  }

  function renderBars(level, animate) {
    if (!bars.length) return;
    const t = Date.now() / 1000;
    // 只有真的收到可听电平（大于门限）才加流动感；安静时保持完全静止，不靠抖动“装活”
    const flow = animate && level > 0.02;
    for (let i = 0; i < bars.length; i++) {
      const ripple = flow ? (0.88 + 0.12 * Math.sin(t * 6 + i * 0.55)) : 1;
      const h = Math.max(0.08, Math.min(1, (0.15 + 0.85 * level) * WEIGHTS[i] * ripple));
      bars[i].style.transform = 'scaleY(' + h.toFixed(3) + ')';
    }
  }

  function startLoop() {
    if (rafId || !overlay || overlay.classList.contains('hidden')) return;
    if (typeof requestAnimationFrame !== 'function') return;
    rafId = requestAnimationFrame(tickMeter);
  }

  function tickMeter() {
    rafId = 0;
    if (!overlay || overlay.classList.contains('hidden')) return;

    let animate = false;
    if (analyser && audioBuf) {
      analyser.getFloatTimeDomainData(audioBuf);
      let sum = 0;
      for (let i = 0; i < audioBuf.length; i++) sum += audioBuf[i] * audioBuf[i];
      const rms = Math.sqrt(sum / audioBuf.length);
      const db = 20 * Math.log10(rms + 1e-7);      // 静音约 -140，正常说话 -35 ~ -12
      levelTarget = dbToLevel(db);
      animate = true;
    } else if (Date.now() - lastRealLevelAt <= 300) {
      animate = true; // 壳刚上报过电平
    }

    if (!animate) {
      // 没有电平来源（壳没实现 onNativeVoiceAmp / AnalyserNode 不可用）：
      // 静默停在基线，不再空转（也绝不能假动）
      levelCur = 0;
      renderBars(0, false);
      return;
    }

    // 快攻慢放：起音跟得紧，收音回落慢，柱体不抽筋
    levelCur += (levelTarget - levelCur) * (levelTarget > levelCur ? 0.55 : 0.18);
    renderBars(levelCur, true);
    rafId = requestAnimationFrame(tickMeter);
  }

  function attachAnalyser() {
    if (!stream) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioBuf = new Float32Array(analyser.fftSize);
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser); // 不接 destination，不会回放
      if (audioCtx.state === 'suspended') audioCtx.resume();
      startLoop(); // 之前可能在静默态停掉了循环
    } catch (_) {
      analyser = null;
      audioBuf = null;
    }
  }

  function startMeter() {
    stopMeter(false);
    levelTarget = 0;
    levelCur = 0;
    lastRealLevelAt = 0;
    startLoop();
  }

  function stopMeter(flatten) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (srcNode) { try { srcNode.disconnect(); } catch (_) { /* 已断 */ } srcNode = null; }
    analyser = null;
    audioBuf = null;
    if (audioCtx) { try { audioCtx.close(); } catch (_) { /* 已关 */ } audioCtx = null; }
    if (flatten !== false) {
      for (let i = 0; i < bars.length; i++) bars[i].style.transform = 'scaleY(.12)';
    }
  }

  function showOverlay() {
    if (overlay) overlay.classList.remove('hidden');
    // 录音期间隐藏输入卡内容（否则透明渐变会把按钮/文字透出来）
    if (document.body) document.body.classList.add('voice-active');
    setOverlayMode('send');
    startMeter();
  }

  function hideOverlay() {
    if (overlay) overlay.classList.add('hidden');
    if (document.body) document.body.classList.remove('voice-active');
    stopMeter();
    cancelArmed = false;
  }

  function resetUI() {
    phase = 'idle';
    pressing = false;
    pressY = 0;
    discard = false;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    hold.classList.remove('recording');
    setHoldText('按住 说话');
    hideOverlay();
    updateSendBtn();
  }

  function releaseStream() {
    if (!stream) return;
    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) { /* 已关 */ }
    stream = null;
  }

  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (let i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (_) { /* 忽略 */ }
    }
    return '';
  }

  // ---------- 模式切换 ----------
  function enter() {
    if (!available || mode) return;
    mode = true;
    ta.classList.add('hidden');
    hold.classList.remove('hidden');
    try { ta.blur(); } catch (_) { /* 忽略 */ }
    resetUI();
    updateSendBtn();
  }

  function exit(focus) {
    if (!mode) return;
    cancelHold();
    mode = false;
    hold.classList.add('hidden');
    ta.classList.remove('hidden');
    autosize();
    updateSendBtn();
    // 必须在点击手势里同步 focus，移动端才会弹键盘
    if (focus) { try { ta.focus(); } catch (_) { /* 忽略 */ } }
  }

  // ---------- 录音 ----------
  function startHold() {
    if (phase !== 'idle') return;
    pressing = true;
    discard = false;
    hold.classList.add('recording');
    setHoldText('松开 结束');
    showOverlay();

    if (native) {
      // 原生侧即使要弹权限也先当「已开始」：松开时 stopVoice()，壳若还在等权限会忽略，
      // 由 watchdog 兜底复位（只有首次授权那一次会遇到）。
      phase = 'recording';
      recordStartAt = Date.now();
      stopTimer = setTimeout(finishHold, MAX_MS);
      hardTimer = setTimeout(function () {
        try { if (native.cancelVoice) native.cancelVoice(); } catch (_) { /* 忽略 */ }
        resetUI();
        toast('录音超时');
      }, MAX_MS + NO_RESULT_MS);
      try {
        native.startVoice();
      } catch (e) {
        resetUI();
        toast('无法开始录音：' + String((e && e.message) || e));
      }
      return;
    }

    phase = 'arming'; // 等 getUserMedia/MediaRecorder 起来
    startWeb();
  }

  async function startWeb() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      resetUI();
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      toast(denied ? '麦克风权限被拒绝' : '无法打开麦克风：' + String((e && e.message) || e));
      return;
    }
    if (!pressing) { releaseStream(); resetUI(); return; } // 松开得比授权快
    attachAnalyser(); // 声波接同一路 MediaStream

    mime = pickMime();
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (_) {
      rec = new MediaRecorder(stream);
      mime = rec.mimeType || '';
    }
    chunks = [];
    rec.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = function () {
      const type = mime || 'audio/webm';
      const blob = new Blob(chunks, { type: type });
      chunks = [];
      rec = null;
      releaseStream();
      if (discard) { discard = false; resetUI(); toast('说话时间太短'); return; }
      upload(blob);
    };
    rec.onerror = function () {
      releaseStream();
      resetUI();
      toast('录音出错');
    };
    try {
      rec.start();
    } catch (e) {
      releaseStream();
      resetUI();
      toast('无法开始录音：' + String((e && e.message) || e));
      return;
    }

    phase = 'recording';
    recordStartAt = Date.now();
    stopTimer = setTimeout(finishHold, MAX_MS);
    hardTimer = setTimeout(resetUI, MAX_MS + NO_RESULT_MS);
  }

  // 松手：结束录音（太短则丢弃）
  function finishHold() {
    if (phase !== 'recording') return;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }

    const held = Date.now() - recordStartAt;
    if (held < MIN_MS) discard = true;
    phase = 'busy';
    hold.classList.remove('recording');
    setHoldText(discard ? '按住 说话' : '正在识别…');
    // 遮罩留着，文案换成「正在识别…」；柱子停在低位，等结果回来再收
    setOverlayMode(discard ? 'send' : 'busy');
    stopMeter();

    if (native) {
      try {
        native.stopVoice();
      } catch (e) {
        resetUI();
        toast('结束录音失败：' + String((e && e.message) || e));
        return;
      }
      // 壳若因为权限弹窗没有真正开录，stopVoice() 会被忽略、结果不会回来
      watchdog = setTimeout(function () {
        if (phase !== 'busy') return;
        try { if (native.cancelVoice) native.cancelVoice(); } catch (_) { /* 忽略 */ }
        resetUI();
      }, NO_RESULT_MS);
      return;
    }

    try {
      if (rec && rec.state !== 'inactive') rec.stop();
      else { releaseStream(); resetUI(); }
    } catch (_) {
      releaseStream();
      resetUI();
    }
  }

  // 放弃本次录音（切模式 / 离开页面 / 上滑取消 / 壳回调 cancelled）
  function cancelHold() {
    if (phase === 'idle') return;
    const r = rec;
    rec = null;
    chunks = [];
    if (r) { r.onstop = null; r.onerror = null; }
    releaseStream();
    resetUI();
    try {
      if (r && r.state !== 'inactive') r.stop();
      else if (native && native.cancelVoice) native.cancelVoice();
    } catch (_) { /* 已停 */ }
  }

  // ---------- 上传 + 自动发送 ----------
  function upload(blob) {
    if (!blob || !blob.size) { resetUI(); toast('没有录到声音'); return; }
    phase = 'busy';
    setOverlayMode('busy');
    req('POST', '/api/asr/transcribe', blob, true, 120000)
      .then(function (r) {
        const text = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
        // 先收遮罩再做后续：toast 固定在 bottom:96px，遮罩还在时弹出来会压住声波
        resetUI();
        if (!text) { toast('没有识别到内容'); return; }
        ta.value = text;
        send();
      })
      .catch(function (e) {
        resetUI();
        toast('语音识别失败：' + String((e && e.message) || e));
      });
  }

  // ---------- 按住 / 滑动 / 松开 ----------
  hold.addEventListener('pointerdown', function (e) {
    if (e && e.button != null && e.button !== 0) return; // 只响应左键/触摸
    e.preventDefault();
    if (phase !== 'idle') return;
    pressY = e.clientY || 0;
    try { hold.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    startHold();
  });

  function onMove(e) {
    if (!pressing) return;
    if (phase !== 'recording' && phase !== 'arming') return;
    if (!overlay || overlay.classList.contains('hidden') || !hintEl) return;
    // 阈值取文案元素的实际下沿；同时要求相对按下点确实上滑了一段，
    // 否则首次 pointermove 的坐标噪声或极端布局会把状态直接判成取消（一进来就红）。
    const line = hintEl.getBoundingClientRect().bottom;
    const limit = pressY ? Math.min(line - 4, pressY - 24) : (line - 4);
    const y = e.clientY;
    if (!cancelArmed && y < limit) setOverlayMode('cancel');
    else if (cancelArmed && y > line + 4) setOverlayMode('send');
  }

  function onRelease(e) {
    // 必须先进 pressing 判断：这个监听器也挂在 window 上，
    // 对无关的 pointerup 调 preventDefault 会吞掉全局 click 事件。
    if (!pressing) return;
    if (e) e.preventDefault();
    pressing = false;

    if (cancelArmed) {
      // 不弹提示：toast 会盖住声波（取消本身已经有颜色/文案反馈）
      cancelHold();
      return;
    }
    if (phase === 'recording') finishHold();
    else if (phase === 'arming') cancelHold(); // 还没真正开录：当误触
  }

  hold.addEventListener('pointerup', onRelease);
  hold.addEventListener('pointercancel', onRelease);
  hold.addEventListener('pointermove', onMove);
  // 兜底：个别环境下 setPointerCapture 不生效，手指移出按钮后也要跟手
  window.addEventListener('pointerup', onRelease);
  window.addEventListener('pointercancel', onRelease);
  window.addEventListener('pointermove', onMove);

  // 长按不弹系统菜单（移动端）
  hold.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // 键盘可达：空格/回车按下开始，松开结束
  hold.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!pressing) startHold();
  });
  hold.addEventListener('keyup', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    onRelease(null);
  });

  // 录音中离开页面：释放麦克风
  window.addEventListener('pagehide', cancelHold);

  // ---------- 原生桥回调（契约见 docs/voice-input.md） ----------
  // 实时幅度：套壳每 ~100ms 上报一次 MediaRecorder.getMaxAmplitude() 的**原始值**（0~32767）。
  // 换算、门限、平滑全部在页面侧做——规则只存在这一份，壳不要做任何数学。
  function onNativeAmp(raw) {
    if (!native) return;
    const amp = Number(raw);
    if (!isFinite(amp)) return;
    lastRealLevelAt = Date.now();
    if (amp <= 0) {
      levelTarget = 0;
    } else {
      const db = 20 * Math.log10(Math.min(amp, 32767) / 32767);
      levelTarget = dbToLevel(db);
    }
    startLoop(); // 静默态下循环已停，下一帧数据到了再启
  }
  window.onNativeVoiceAmp = onNativeAmp;
  window.onNativeVoiceLevel = onNativeAmp; // 旧名兼容：同样按原始幅度解释

  window.onNativeVoiceResult = function (b64, mimeType) {
    if (phase !== 'busy' && phase !== 'recording') return;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (discard) { discard = false; resetUI(); toast('说话时间太短'); return; }
    try {
      const bin = atob(String(b64 || ''));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      upload(new Blob([arr], { type: mimeType || 'audio/mp4' }));
    } catch (_) {
      resetUI();
      toast('语音数据解析失败');
    }
  };

  window.onNativeVoiceState = function (s) {
    if (!native || s !== 'recording' || phase !== 'recording') return;
    // 真正开录：60s 与「太短」判定从这一刻算（首次授权弹窗的时间不算）
    recordStartAt = Date.now();
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(finishHold, MAX_MS);
    if (!pressing) finishHold(); // 弹窗期间已经松手：立刻收口（held≈0 → 丢弃）
  };

  window.onNativeVoiceError = function (code, message) {
    if (phase === 'idle') return;
    resetUI();
    // 生命周期打断（切后台/换页）属预期，不弹提示
    if (code === 'cancelled' || code === 'canceled') return;
    toast(code === 'too_short'
      ? '说话时间太短，请按住再说'
      : '录音失败：' + String(message || code || '未知错误'));
  };

  // ---------- 对外暴露给发送键 / sessions.js 的状态查询 ----------
  window.AgentVoice = {
    isAvailable: function () { return available; },
    isVoiceMode: function () { return mode; },
    enter: enter,
    exit: exit
  };

  // 能力判定：桥优先；没有桥就得是安全上下文（浏览器不允许 http 页面开麦）
  if (!native && !webOk) {
    console.info('[voice] 语音入口未启用：没有 window.AgentNative，且当前不是安全上下文（需 HTTPS，或由套壳 App 注入原生桥）');
    return;
  }
  // 服务端没接线（core 的 ASR_URL 为空，或 config.yml 里没有可用的 asr 段）就不给入口；
  // 探测失败则照常启用（不因一次探测失败就永久藏掉入口）。
  req('GET', '/api/asr/status').then(function (s) {
    if (s && s.enabled === false) {
      console.info('[voice] 语音入口未启用：' + ((s && s.reason) || '服务端未配置语音识别'));
      return;
    }
    available = true;
    updateSendBtn();
  }).catch(function () {
    available = true;
    updateSendBtn();
  });
})();
