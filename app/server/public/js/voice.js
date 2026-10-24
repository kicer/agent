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
// 录音在客户端，两条路，下游是同一套：
//   · 套壳原生桥（http 页面也能用）：壳把 16k/单声道 PCM 以 ~100ms 分片推给页面。
//   · 浏览器（需 HTTPS）：AudioContext + ScriptProcessor 自己采 PCM，降采样到 16k 后约 20ms 一片。
// 两条路都汇到 pushChunk()：判停顿、切段、逐段上传、最后合并发送，只有一份实现。
// 于是大部分识别在说话过程中就做完了，松手通常只剩最后一段要等。
// 电平在页面侧算（PCM 峰值），壳和浏览器都不做任何换算。
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
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && (window.AudioContext || window.webkitAudioContext));

  const MAX_MS = 180000;       // 单次录音上限（流式上传后不再受 60s 限制）
  const MIN_MS = 500;          // 短于这个时长按误触处理，不上传
  const FLUSH_MS = 60000;      // 松手后等尾段识别完的上限（超过就当失败）
  const OUT_RATE = 16000;      // 页面内部统一按 16k 处理：VAD 时长与段长上限都按它算
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
  let stream = null;
  // 浏览器采集：ScriptProcessor 直接给 Float32 PCM，这里降到 16k 后喂 pushChunk
  let procNode = null;
  let capRate = 0;             // AudioContext 的真实采样率（通常 44.1k/48k）
  let dsAcc = 0;               // 降采样：当前输出周期内的样本和
  let dsN = 0;
  let dsPhase = 0;             // 小数相位，跨分片累计 → 长期不漂移

  // 流式：壳推的分片 / 浏览器自己采的分片，都在这里断句后逐段上传
  let pcmRate = 16000;         // 当前流的采样率（契约要求 16k）
  let segChunks = [];          // 当前段的 PCM 分片（Int16Array）
  let segLen = 0;              // 当前段总采样数
  let silLen = 0;              // 段尾连续静音采样数
  let textParts = [];          // 各段识别结果（按顺序）
  let chain = Promise.resolve(); // 串行上传链：保证拼接顺序 = 说话顺序
  let gen = 0;                 // 会话代号：取消/重录后迟到结果直接丢弃
  let streamOn = false;        // 是否接受 PCM 分片
  let flushTimer = null;

  // VAD 参数（页面侧唯一一份：改完刷新页面即生效，不用重打 APK）
  const VAD_SILENCE_DB = -42;     // 低于这个音量算“没人说话”（正常说话峰值约 -10~-30dB）
  const VAD_PAUSE_SEC = 0.5;      // 连续静音这么久 → 断句（与壳无关）
  const VAD_MIN_SPEECH_SEC = 0.3; // 一段短于这个 → 当噪声丢掉
  const VAD_MAX_SEG_SEC = 25;     // 单段上限：连续说话没停顿就硬切（上游单次上限）

  // 电平与渲染
  let rafId = 0;
  let levelTarget = 0;
  let levelCur = 0;
  let lastRealLevelAt = 0;
  let audioCtx = null;
  let srcNode = null;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // 电平归一化的唯一实现：两条录音路径的 PCM 峰值都在这里落到 0~1。
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

    // 电平只有一个来源：pushChunk() 每收到一片 PCM 就更新 levelTarget。
    // 超过 300ms 没有新数据（授权还没给 / 已经停了）→ 静默停在基线，不假动。
    if (Date.now() - lastRealLevelAt > 300) {
      levelCur = 0;
      renderBars(0, false);
      return;
    }

    // 快攻慢放：起音跟得紧，收音回落慢，柱体不抽筋
    levelCur += (levelTarget - levelCur) * (levelTarget > levelCur ? 0.55 : 0.18);
    renderBars(levelCur, true);
    rafId = requestAnimationFrame(tickMeter);
  }

  // iOS Safari 只允许在用户手势里真正启动 AudioContext；getUserMedia 之后那条异步链已经
  // 脱离手势，那时才 new AudioContext 有可能一直 suspended（一点声音都采不到）。
  // 所以在 pointerdown 里先把 ctx 建好并 resume，拿到麦克风后直接复用。
  function primeAudioCtx() {
    if (audioCtx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return true;
    } catch (_) {
      audioCtx = null;
      return false;
    }
  }

  // 浏览器：拿 PCM 只能靠 ScriptProcessor（已标废弃，但 Chrome/Safari/Firefox 都还在，
  // 且不需要额外加载文件）。AudioWorklet 要 addModule，异步加载会吞掉开头几个字。
  function startCapture() {
    if (!stream || !primeAudioCtx()) return false;
    try {
      capRate = audioCtx.sampleRate || 48000;
      dsAcc = 0; dsN = 0; dsPhase = 0;
      srcNode = audioCtx.createMediaStreamSource(stream);
      procNode = audioCtx.createScriptProcessor(1024, 1, 1);
      procNode.onaudioprocess = function (ev) {
        const pcm = downsampleTo16k(ev.inputBuffer.getChannelData(0));
        if (pcm.length) pushChunk(pcm, OUT_RATE);
      };
      srcNode.connect(procNode);
      // 必须接到 destination 才会被驱动；输出缓冲区不写，所以不会外放
      procNode.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') audioCtx.resume();
      startLoop();
      return true;
    } catch (_) {
      stopMeter(false);
      return false;
    }
  }

  // Float32（任意采样率）→ 16k Int16。按「输出周期内取均值」降采样：既是抽点也能压一点高频，
  // 且 dsPhase 跨分片累计，长时间录不会整体越走越快/越慢（整数倍抽取会）。
  function downsampleTo16k(input) {
    const out = new Int16Array(Math.ceil(input.length * OUT_RATE / capRate) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      dsAcc += input[i];
      dsN++;
      dsPhase += OUT_RATE;
      if (dsPhase >= capRate) {
        dsPhase -= capRate;
        const v = Math.round((dsAcc / dsN) * 32767);
        out[n++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        dsAcc = 0;
        dsN = 0;
      }
    }
    return n === out.length ? out : out.subarray(0, n);
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
    if (procNode) {
      try { procNode.disconnect(); } catch (_) { /* 已断 */ }
      procNode.onaudioprocess = null;
      procNode = null;
    }
    if (srcNode) { try { srcNode.disconnect(); } catch (_) { /* 已断 */ } srcNode = null; }
    // 采集节点也挂在这个 ctx 上：关掉它浏览器这边就彻底不再送 PCM 了
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
    abortStream();
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
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
      // 原生侧即使要弹权限也先当「已开始」：页面已经开始收分片，壳真开录后会推数据。
      // 首次授权那一次的分片要等用户点允许才会到，之前的静音不计入。
      phase = 'recording';
      recordStartAt = Date.now();
      gen++;                 // 新会话：让上一轮迟到的结果全部失效
      streamOn = true;
      pcmRate = 16000;
      clearSeg();
      textParts = [];
      stopTimer = setTimeout(finishHold, MAX_MS);
      try {
        native.startVoice();
      } catch (e) {
        resetUI();
        toast('无法开始录音：' + String((e && e.message) || e));
      }
      return;
    }

    // 浏览器：先拿麦克风（可能要等用户授权），拿到后 startCapture 开始往里推 PCM
    phase = 'arming';
    primeAudioCtx(); // 必须在手势里建（见 primeAudioCtx 注释）
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

    // 与套壳同一套状态，只是换成了「自己采 PCM」而不是「等壳推」
    phase = 'recording';
    recordStartAt = Date.now();
    gen++;
    pcmRate = OUT_RATE;
    streamOn = true;
    clearSeg();
    textParts = [];
    if (!startCapture()) {
      streamOn = false;
      releaseStream();
      resetUI();
      toast('无法开始录音：当前浏览器采不到音频');
      return;
    }
    stopTimer = setTimeout(finishHold, MAX_MS);
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

    if (discard) {
      abortStream();
      releaseStream();
      nativeStop(false); // 只停采集，不用管壳知不知道“被丢弃”（页面已经不再收分片）
      resetUI();
      toast('说话时间太短');
      return;
    }

    // 两条路收口完全一样：把不足一个停顿的尾巴发走（纯静音的尾巴不发），再等所有段回来。
    // 大部分段在说话过程中已经识别完了，这里通常只等最后一段。
    flushTail();
    if (native) {
      try {
        native.stopVoice();
      } catch (e) {
        resetUI();
        toast('结束录音失败：' + String((e && e.message) || e));
        return;
      }
    } else {
      releaseStream(); // 采集节点已经由上面的 stopMeter() 拆掉了
    }
    waitFlush();
  }

  // 让壳停止采集：优先 cancelVoice（语义明确），壳没实现时退回 stopVoice——
  // 否则麦克风会在壳侧一直开着（页面这边已经不再收分片了，但录音还在跑）。
  function nativeStop(cancel) {
    if (!native) return;
    try {
      if (cancel && native.cancelVoice) native.cancelVoice();
      else if (native.stopVoice) native.stopVoice();
    } catch (_) { /* 已停 */ }
  }

  // 放弃本次录音（切模式 / 离开页面 / 上滑取消 / 壳回调 cancelled）
  function cancelHold() {
    if (phase === 'idle') return;
    abortStream();      // 丢弃已发在途的结果，也不碰输入框
    releaseStream();    // 浏览器：停麦克风轨道（采集节点由 resetUI → stopMeter 拆）
    nativeStop(true);
    resetUI();
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

  // ---------- PCM 处理（两条录音路径共用） ----------
  // 壳每 ~100ms 推一片 16bit/单声道小端 PCM；浏览器自己采。采样率、分片大小、门限全部不在别处算。
  function b64ToI16(b64) {
    const bin = atob(String(b64 || ''));
    const n = bin.length >> 1;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
    return out;
  }

  // 这一片 PCM 的峰值电平（dBFS）。用峰值而不是 RMS：与原先 getMaxAmplitude 的尺度一致。
  function peakDb(arr) {
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i] < 0 ? -arr[i] : arr[i];
      if (v > peak) peak = v;
    }
    return peak <= 0 ? -Infinity : 20 * Math.log10(peak / 32767);
  }

  function encodeWav(samples, rate) {
    const b = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(b);
    const str = function (off, s) { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);            // PCM
    v.setUint16(22, 1, true);            // mono
    v.setUint32(24, rate, true);         // 采样率
    v.setUint32(28, rate * 2, true);     // byte rate
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0, o = 44; i < samples.length; i++, o += 2) v.setInt16(o, samples[i], true);
    return new Blob([b], { type: 'audio/wav' });
  }

  // 从当前段取前 n 个采样（拼成一段连续 PCM）
  function takeSeg(n) {
    const out = new Int16Array(n);
    let off = 0;
    for (const c of segChunks) {
      if (off >= n) break;
      const k = Math.min(c.length, n - off);
      out.set(k === c.length ? c : c.subarray(0, k), off);
      off += k;
    }
    return out;
  }

  function clearSeg() { segChunks = []; segLen = 0; silLen = 0; }

  // 把当前段的前 n 个采样作为一段发出去（太短当噪声丢掉）。
  // 注意：必须在 clearSeg() 之前调，takeSeg 要读 segChunks。
  function emitSegment(n) {
    if (n < pcmRate * VAD_MIN_SPEECH_SEC) return;
    emit(encodeWav(takeSeg(n), pcmRate));
  }

  // 串行上传：一段没回来不发下一段（2 vCPU 上并发只会互相拖慢，而且顺序也没法保证）
  function emit(blob) {
    const my = gen;
    chain = chain.then(function () {
      if (my !== gen) return;   // 已取消/重录：不再发
      return req('POST', '/api/asr/transcribe', blob, true, 120000)
        .then(function (r) {
          if (my !== gen) return;
          const t = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
          if (t) textParts.push(t);
        })
        .catch(function () { /* 单段失败不连坐，其余段照常出字 */ });
    });
  }

  // 拼接各段：中文直接相连；两侧都是西文字母/数字时补一个空格，
  // 否则英文被切开后会粘成 "helloworld"。
  function joinText(parts) {
    let out = '';
    for (const s of parts) {
      if (!s) continue;
      if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(s)) out += ' ';
      out += s;
    }
    return out;
  }

  // 丢弃本轮的一切（段缓冲 + 已发在途结果）：取消 / 误触 / 超时都走这里
  function abortStream() {
    streamOn = false;
    clearSeg();
    textParts = [];
    gen++;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  // 一片 16bit 单声道 PCM：两条录音路径的唯一汇合点。
  // 电平、静音判定、断句、上传全在页面侧；壳和浏览器都不做任何判断。
  function pushChunk(pcm, rate) {
    if (!streamOn || phase !== 'recording') return;
    const r = Number(rate);
    if (r > 0 && r !== pcmRate) pcmRate = r;
    if (!pcm.length) return;

    // 电平：直接用这片 PCM 的峰值
    const db = peakDb(pcm);
    lastRealLevelAt = Date.now();
    levelTarget = db === -Infinity ? 0 : dbToLevel(db);
    startLoop();

    segChunks.push(pcm);
    segLen += pcm.length;
    // 静音按「整片」判：一片约 20~100ms，足够分辨 0.5s 的停顿（再细也没意义）
    silLen = db < VAD_SILENCE_DB ? silLen + pcm.length : 0;

    if (silLen >= pcmRate * VAD_PAUSE_SEC) {
      // 停顿够了 → 把静音之前的部分发走，静音本身丢掉（不浪费上游额度）
      const tail = segLen - silLen;
      emitSegment(tail);
      clearSeg();
    } else if (segLen >= pcmRate * VAD_MAX_SEG_SEC) {
      // 一口气说了 25 秒没停顿：硬切（宁可切开也不能超上游上限）
      emitSegment(segLen);
      clearSeg();
    }
  }

  // 壳每 ~100ms 推一片 16bit/单声道小端 PCM（契约见 docs/voice-input.md）
  window.onNativeVoiceChunk = function (b64, rate) {
    if (!native) return;
    pushChunk(b64ToI16(b64), rate);
  };

  // 松手/超时：把不足一个停顿的尾巴也发出去，然后等全部段回来。
  // 必须剔掉尾巴上的静音：停顿那一下已经把缓冲清空了，之后累积的可能全是静音
  //（用户停一会儿才松手），发出去只会换来一次「没有可识别语音」。
  function flushTail() {
    streamOn = false;
    const speech = segLen - silLen;
    if (speech > 0) emitSegment(speech);
    clearSeg();
  }

  function waitFlush() {
    const my = gen;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      if (my !== gen) return;
      gen++; // 让迟到结果失效
      resetUI();
      toast('语音识别超时');
    }, FLUSH_MS);
    chain = chain.then(function () {
      if (my !== gen) return;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const text = joinText(textParts);
      // 先收遮罩再做后续：toast 固定在 bottom:96px，遮罩还在时弹出来会压住声波
      resetUI();
      if (!text) { toast('没有识别到内容'); return; }
      ta.value = text;
      send();
    });
  }

  window.onNativeVoiceState = function (s) {
    if (!native || s !== 'recording' || phase !== 'recording') return;
    // 真正开录：180s 与「太短」判定从这一刻算（首次授权弹窗的时间不算）
    recordStartAt = Date.now();
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(finishHold, MAX_MS);
    if (!pressing) finishHold(); // 弹窗期间已经松手：立刻收口（held≈0 → 丢弃）
  };

  window.onNativeVoiceError = function (code, message) {
    if (phase === 'idle') return;
    abortStream();
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
