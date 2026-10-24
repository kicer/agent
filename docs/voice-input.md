# 语音输入：客户端录音契约

链路是「按住说话 → 端上持续送 PCM → 页面按停顿切段并逐段转写 → 松手后一次性写入输入框并**自动发送**」。

`public/js/voice.js` 按能力自己选录音方式：

| 页面环境 | 录音方式 | 实时断句 | 说明 |
|---|---|---|---|
| Android 套壳 App（WebView） | **原生 `AudioRecord` + JS 桥流式推 PCM** | ✅ | WebView 没有 Web Speech API；`http://` 页面也能用 |
| 浏览器 / PWA（HTTPS） | **`AudioContext` + `ScriptProcessor` 采 PCM** | ✅ | 降采样到 16k 后与套壳走**完全同一套** VAD/切段/上传 |
| 纯浏览器（`http://<IP>`） | 不可用 | — | 非安全上下文，浏览器拒绝开麦 |

**为什么必须要流式**：录音只在松手后才上传的话，识别要等整段录完 + 整段识别，长语音尤其慢。
流式之后，说话过程中的每个停顿都会立刻切段上传，**松手时通常只剩最后一段要等**。

两条录音路径只在「PCM 从哪来」上不同，进到 `pushChunk(pcm, rate)` 之后一模一样：
电平、静音门限、断句、逐段上传、最后合并发送，代码只有一份。

---

## 一、交互与页面行为（壳只需要知道这些）

1. 用户按住 `#voice-hold` → 页面开始录音（套壳调 `startVoice()`，浏览器自己 `getUserMedia`），同时把整块输入区换成全宽遮罩（实时声波 + 提示文案）。
2. 壳推 / 浏览器采的 PCM 进来后，页面自己判停顿（连续静音 ≥0.5s）→ 立即 POST 该段 → 结果攒在内存里。
3. 手指上滑进入文案区 = 取消态；松手时处于取消态则**整轮丢弃**（已上传段的结果也丢掉），输入框保持原样。
4. 松手 → 页面把尾巴里**有声音的部分**发出去（纯静音的尾巴不发，否则只会换来一次「没有可识别人声」）
   → 等所有段回来 → **一次性**写进输入框 → 自动发送。
5. 识别结果**不会边识别边显示**：遮罩/发送键本来就盖住了输入框，渐进文本用户看不到，
   所以统一在最后落到输入框里，用户拿到的是完整一句话。

### 浏览器 / PWA（HTTPS）的实现要点

- 采集：`getUserMedia` → `createMediaStreamSource` → `createScriptProcessor(1024, 1, 1)`。
  不用 `AudioWorklet` 是因为要多加载一个模块文件、且 `addModule` 是异步的（按下才加载会把开头几个字吞掉）；
  `ScriptProcessor` 虽已标废弃，但 Chrome/Safari/Firefox 都还在，这点开销可忽略。
- 降采样：浏览器采样率通常是 44.1k/48k，`downsampleTo16k()` 按「一个输出周期内取均值」降到 16k，
  小数相位跨分片累计（整数倍抽取会越录越快/越慢）。**不能**把 44.1k 直接喂进 VAD ——
  0.5s 停顿与 25s 段长都是按 16k 估算的。
- iOS Safari：`AudioContext` 必须在手势里创建/resume；`await getUserMedia` 之后已脱离手势，
  所以按下（`pointerdown`）时就先把 ctx 建好，拿到麦克风后复用。
- 浏览器只在安全上下文开麦：`http://<IP>` 下麦克风按钮不会出现，只有 HTTPS 域名（或套壳壳内）可用。

---

## 二、桥的契约

### 1. 注入时机

必须在 **`loadUrl()` 之前**注册，不要在 `onPageFinished` 里用 `evaluateJavascript` 注入：

```java
webView.setWebViewClient(/* ... */);
webView.addJavascriptInterface(new VoiceBridge(activity, webView), "AgentNative");
webView.loadUrl(startUrl);
```

`addJavascriptInterface` 的绑定对所有后续导航生效；在 `onPageFinished` 里再注入，首屏那次
加载会拿不到 `window.AgentNative`（页面脚本已经跑完了）。

### 2. 方法（壳实现）

```js
window.AgentNative = {
  startVoice(),   // 开始录音（可能先弹权限）；失败通过 onNativeVoiceError 回报
  stopVoice(),    // 结束录音；**没有返回值**，页面自己等已发出的分段的识别结果
  cancelVoice()   // 放弃本次录音（无回调；页面自己已经把状态复位了）
};
```

### 3. 回调（页面定义，壳调用）

```js
window.onNativeVoiceChunk(base64Pcm, sampleRate)  // 必需：流式 PCM 分片
window.onNativeVoiceState('recording')            // 建议：真正开始录时调一次
window.onNativeVoiceError(code, message)          // 出错/被打断时调
```

#### `onNativeVoiceChunk(base64Pcm, sampleRate)`

- 内容：**裸 PCM**，`16bit 小端 / 单声道 / 16kHz`（小端是 `AudioRecord` 的原始字节序，直接转 Base64 即可）。
- 节奏：约 **100ms 一片**（1600 采样 = 3200 字节，Base64 后约 4.3KB）。50~200ms 都可接受。
- 壳**不做任何数学**：不判静音、不切段、不算音量。dB 归一化、静音门限、停顿判定、切段
  全部在页面侧（`voice.js`），规则只存在一份。
- 声波也是页面用这片 PCM 的峰值算的——**不再需要** `onNativeVoiceAmp` / `getMaxAmplitude`。
- 页面已经复位（用户松手/取消）后再来的分片会被忽略，壳不用刻意等待。

#### `onNativeVoiceState('recording')`

**按住时长判定依赖它**：页面用这个回调重置「180 秒上限」与「太短丢弃」的起点，
避免首次授权弹窗的时间被算进录音。不实现也不会崩，但首次授权那一次可能被当成「太短」丢掉。

#### `onNativeVoiceError(code, message)`

| code | 触发时机 | 页面表现 |
|---|---|---|
| `no_permission` | 用户拒绝 / 取消授权弹窗 | toast「录音失败：…」 |
| `start_failed` | `AudioRecord` 初始化/启动失败（含 16k 不支持） | toast |
| `read_failed` | 采集线程读失败 | toast |
| `forbidden` | 非白名单 URL / 应用不在前台 | toast |
| `cancelled` | 生命周期打断（切后台 / 换页） | **静默复位，不弹提示** |
| 其他未知 code | — | toast 里显示 `message`，没有就显示 code |

**取消语义**：页面在 `stopVoice()` 之后只等自己发出的分段请求（不再等壳回音频），
所以壳在生命周期里中断录音时**仍建议**回调 `onNativeVoiceError('cancelled','')`，
让页面立刻收遮罩，不必干等。`cancelVoice()` 是页面主动发起的，壳不需要回报。

### 4. 体积与时序

- 每秒 32KB 原始 PCM（16k × 2 字节），Base64 后约 43KB/s；一片 100ms 约 4.3KB。
  `evaluateJavascript` 走 Binder，单次约 1MB 上限，4.3KB 远低于上限。
- 一次 60 秒的听写 = 约 600 次桥调用、2.6MB 字符串。Android WebView 完全吃得住，
  但**不要**把分片缩到 20ms 以下（调用次数会翻 5 倍，收益为零）。
- 页面侧开销：每片扫一遍峰值（1600 个 short），可忽略。

### 5. 壳侧状态机

`IDLE → (WAITING_PERMISSION) → RECORDING → IDLE`

`startVoice` 只在 `IDLE` 生效，`stopVoice` / `cancelVoice` 在非 `RECORDING` 时静默忽略。

---

## 三、Java 参考骨架（纯 Java / minSdk 21）

只演示契约要求的部分；`UrlPolicy`、埋点、通知等按各自工程接。

```java
// AndroidManifest.xml
//   <uses-permission android:name="android.permission.RECORD_AUDIO" />

public final class VoiceBridge {
    private static final int REQ_MIC = 1001;
    private static final int RATE = 16000;        // 契约固定：16k / 单声道 / 16bit
    private static final int CHUNK_MS = 100;      // 每 100ms 推一片
    private static final long MAX_MS = 180_000;   // 页面也会自己停，这里是兜底

    private enum State { IDLE, WAITING_PERMISSION, RECORDING }

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable autoStop = this::stopOnMain;

    private State state = State.IDLE;
    private AudioRecord record;
    private Thread worker;
    private volatile boolean running;

    public VoiceBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ---- JS 入口：JavaBridge 线程 → 主线程 ----
    @JavascriptInterface public void startVoice()  { main.post(this::startOnMain); }
    @JavascriptInterface public void stopVoice()   { main.post(this::stopOnMain); }
    @JavascriptInterface public void cancelVoice() { main.post(() -> cancelOnMain(true)); }

    // ---- 生命周期：由 Activity / WebViewClient 调用 ----
    // 只在真正录音时取消。授权弹窗期间某些 ROM 会走 onPause，
    // 那里一并取消的话，首次授权的两段式流程就断了。
    public void onPause() {
        main.post(() -> { if (state == State.RECORDING) cancelOnMain(true); });
    }
    public void onDestroy()     { main.post(() -> cancelOnMain(false)); }
    public void onPageChanged() { main.post(() -> cancelOnMain(true)); }

    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != REQ_MIC) return;
        main.post(() -> {
            if (state != State.WAITING_PERMISSION) return;
            state = State.IDLE;
            boolean ok = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (!ok) { fail("no_permission", "需要麦克风权限"); return; }
            beginRecording();   // 授权后直接开录，不让用户再点一次
        });
    }

    private void startOnMain() {
        if (state != State.IDLE) return;
        // 第三方 CDN 脚本同样能调这个桥：只允许自家页面 + 前台时录音
        if (!UrlPolicy.isAllowed(webView.getUrl()) || !activity.hasWindowFocus()) {
            fail("forbidden", "当前页面不允许录音");
            return;
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            state = State.WAITING_PERMISSION;
            ActivityCompat.requestPermissions(
                    activity, new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        beginRecording();
    }

    private void beginRecording() {
        int minBuf = AudioRecord.getMinBufferSize(
                RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuf <= 0) { fail("start_failed", "设备不支持 16kHz 录音"); return; }

        // VOICE_RECOGNITION 关掉 AGC/降噪，对 ASR 更友好；个别机型不支持则回退 MIC
        final AudioRecord r = createRecord(minBuf);
        if (r == null) { fail("start_failed", "无法开始录音"); return; }

        record = r;
        running = true;
        state = State.RECORDING;
        main.postDelayed(autoStop, MAX_MS);

        final int samplesPerChunk = RATE * CHUNK_MS / 1000;   // 1600
        worker = new Thread(() -> captureLoop(r, samplesPerChunk), "voice-capture");
        worker.start();

        // 让页面的 180s 从“真的开始录”算（授权弹窗的时间不算）
        js("window.onNativeVoiceState && window.onNativeVoiceState('recording')");
    }

    private AudioRecord createRecord(int minBuf) {
        int[] sources = {MediaRecorder.AudioSource.VOICE_RECOGNITION,
                         MediaRecorder.AudioSource.MIC};
        for (int source : sources) {
            try {
                AudioRecord t = new AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf * 2, 8192));
                if (t.getState() == AudioRecord.STATE_INITIALIZED) return t;
                t.release();
            } catch (Exception ignored) { /* 换下一个 source */ }
        }
        return null;
    }

    /** 采集线程：阻塞 read → 小端字节 → Base64 → 推给页面。不判静音、不切段。 */
    private void captureLoop(AudioRecord r, int samplesPerChunk) {
        short[] pcm = new short[samplesPerChunk];
        byte[] bytes = new byte[samplesPerChunk * 2];
        try {
            r.startRecording();
            while (running) {
                int n = r.read(pcm, 0, pcm.length);
                if (n <= 0) continue;
                for (int i = 0; i < n; i++) {
                    bytes[i * 2]     = (byte) (pcm[i] & 0xff);
                    bytes[i * 2 + 1] = (byte) ((pcm[i] >> 8) & 0xff);
                }
                String b64 = Base64.encodeToString(bytes, 0, n * 2, Base64.NO_WRAP);
                // 字符串一律 JSONObject.quote，避免任何转义问题（Base64 本身安全，这里是统一规矩）
                js("window.onNativeVoiceChunk(" + JSONObject.quote(b64) + "," + RATE + ")");
            }
        } catch (Exception e) {
            if (running) fail("read_failed", "录音中断：" + e.getMessage());
        } finally {
            try { r.stop(); } catch (Exception ignored) { }
            try { r.release(); } catch (Exception ignored) { }
        }
    }

    private void stopOnMain() {
        if (state != State.RECORDING) return;
        main.removeCallbacks(autoStop);
        stopCapture();
        state = State.IDLE;
        // 注意：这里不再回传音频，识别分段已经在录音过程中发完了
    }

    /** notify=true：页面在等收尾，回 cancelled 让它立刻收遮罩；onDestroy 时页面已走，不必回。 */
    private void cancelOnMain(boolean notify) {
        main.removeCallbacks(autoStop);
        boolean wasActive = state != State.IDLE;
        stopCapture();
        state = State.IDLE;
        if (notify && wasActive) js("window.onNativeVoiceError('cancelled','')");
    }

    private void stopCapture() {
        running = false;
        AudioRecord r = record;
        record = null;
        if (r != null) {
            // 打断阻塞中的 read()；stop/release 由采集线程的 finally 做，
            // 避免跨线程操作同一个 AudioRecord
            try { r.stop(); } catch (Exception ignored) { }
        }
        Thread w = worker;
        worker = null;
        if (w != null) w.interrupt();
    }

    private void fail(String code, String message) {
        js("window.onNativeVoiceError(" + JSONObject.quote(code) + ","
                + JSONObject.quote(message) + ")");
    }

    private void js(String script) {
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
```

接线：

```java
// setupWebView() 里，loadUrl 之前
webView.addJavascriptInterface(new VoiceBridge(this, webView), "AgentNative");

@Override public void onRequestPermissionsResult(int code, String[] p, int[] r) {
    super.onRequestPermissionsResult(code, p, r);
    bridge.onRequestPermissionsResult(code, r);
}
@Override protected void onPause()   { bridge.onPause(); super.onPause(); }
@Override protected void onDestroy() { bridge.onDestroy(); super.onDestroy(); }
// WebViewClient.onPageStarted：URL 变了就 bridge.onPageChanged()
```

**和上一版（MediaRecorder）的差别，别照抄旧代码**：

- 不再有 `MediaRecorder`、临时文件、`onNativeVoiceResult`、`getMaxAmplitude`、60 秒自动停止。
- `stopVoice()` 之后没有任何回传动作，页面会自己等已发出的分段请求。
- 必须在**采集线程**里 `read()`，不能读在主线程；`AudioRecord` 的 stop/release 只由该线程的
  `finally` 执行（主线程只调 `stop()` 打断阻塞）。
- 个别设备 16k 不支持时：`getMinBufferSize` 会返回负数。此时要么回滚到 44.1k 并在壳里做
  2 点平均降采样到 16k（多几十行），要么直接 `start_failed`。**不要**改推 44.1k 给页面——
  页面只按 16k 估算时长与切段。

---

## 四、壳侧必须同步的清单

| 项 | 内容 |
|---|---|
| `AndroidManifest.xml` | `<uses-permission android:name="android.permission.RECORD_AUDIO" />` |
| `proguard-rules.pro` | 保留桥：`-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }`，并删掉「本项目未使用 addJavascriptInterface」的注释 |
| README 安全表 | 「不使用 JS 桥」→「仅暴露语音桥：三个无参方法，无文件/存储读取能力」 |
| README 权限行 | 「只有 INTERNET」→「INTERNET + RECORD_AUDIO」 |
| 桥的防护 | `UrlPolicy.isAllowed(webView.getUrl())` + `activity.hasWindowFocus()` + 单实例状态机 |
| 页面导航 | `onPageStarted` 且 URL 变化时取消；分片打到新页面会污染新一轮的缓冲 |
| 录音上限 | 壳侧兜底 180s（页面也会在 180s 时主动 `stopVoice()`），不要做成 60s |

> 触摸时间戳门槛（最近 N 秒内有触摸才允许录音）能进一步防静默录音，但会让无障碍操作不可用，
> 不建议默认开。

---

## 五、iOS（以后若有 WKWebView 壳）

契约相同，只是数据源换成 `AVAudioEngine` 的 tap（`installTapOnBus` 直接把
`AVAudioPCMBuffer` 转成 16bit 小端 PCM，每 ~100ms 一次）：

```swift
// 注入：WKUserScript(source: "window.AgentNative = {...}", injectionTime: .atDocumentStart, ...)
// 推流：webView.evaluateJavaScript("window.onNativeVoiceChunk('\(b64)',16000)")
// 结束：stopVoice() 停 tap 即可，不需要回传文件
```

`Info.plist` 需要 `NSMicrophoneUsageDescription`。

---

## 六、服务端接口

```http
POST /api/asr/transcribe
Content-Type: audio/wav        # 两条路都是 wav：页面自己加的 44 字节头（16k/单声道/16bit）
Cookie: <登录态>                # 与页面同一份 HttpOnly cookie

<音频二进制>
```

```json
{ "text": "打开今天的日报", "ms": 842, "model": "whisper-1" }
```

- 上限 20MB，超时 120s；识别失败返回 `{"error": "..."}`（前端直接 toast 出来）。
- 一次「按住说话」会变成 **多次** 请求（每个停顿一次，套壳与浏览器都是）。页面串行发送，保证拼接顺序。
- 单段失败不影响其他段（页面侧吞掉单段错误，继续等下一段）；全部失败才提示。
- 服务端只做**超长兜底**：一次请求超过 25s 才切，且切点尽量落在停顿处（端上已经按停顿切好了，
  这里多数请求根本不会触发切分）。参数见 `mcp/asr/README.md`。
- `GET /api/asr/status` → `{"enabled": true}`；未接线时 `{"enabled": false, "reason": "..."}`。

## 七、为什么不用浏览器的 Web Speech API

- Android WebView 没有实现 `SpeechRecognition`；iOS WKWebView 同样不可用（只有 Safari 有）。
- 桌面 Chrome 的识别走 Google 服务，国内基本报 `network`。
- 三端行为不一致、错误码各异，最后还是要留一条服务端通路——不如只留一条。
