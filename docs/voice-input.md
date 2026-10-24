# 语音输入：客户端录音契约

链路是「按住说话 → 客户端录音 → `POST /api/asr/transcribe` → 转写结果**自动发送**」。
服务端只收音频字节，不关心是谁录的。`public/js/voice.js` 按能力自己选录音方式：

| 页面环境 | 录音方式 | 说明 |
|---|---|---|
| Android 套壳 App（WebView） | **原生录音 + JS 桥** | WebView 没有 Web Speech API；http 页面也允许 `getUserMedia` 的替代路径 |
| 浏览器 / PWA（HTTPS） | `MediaRecorder` | 标准 `getUserMedia`，不用改壳 |
| 纯浏览器（`http://<IP>`） | 不可用 | 非安全上下文，浏览器拒绝开麦 |

**发送键的四种状态**（`sessions.js` 的 `updateSendBtn` 决定）：

| `data-state` | 什么时候 | 点击行为 |
|---|---|---|
| `stop` | 生成中且输入框为空 | 停止当前回合（优先级最高，不被语音入口顶掉） |
| `voice` | 空闲、无文字无附件、且语音可用 | 进入语音模式 |
| `keyboard` | 已在语音模式 | 回键盘模式，聚焦输入框（移动端弹键盘） |
| `send` | 其余情况 | 发送 |

「语音可用」= ①有录音能力（原生桥，或安全上下文下的 `MediaRecorder`）②`GET /api/asr/status`
返回 `enabled !== false`。所以**套壳 App 里即使页面是 `http://`，只要桥注入成功，麦克风入口照样出现**；
纯浏览器 `http://<IP>` 不会出现（非安全上下文，浏览器禁止开麦）。

语音模式下输入框被 `#voice-hold` 取代（只有居中文字，无按钮外观）：按住后整块输入区被
**全宽遮罩**盖住（`#voice-overlay`，向左右各扩到屏幕边缘），遮罩里是「实时电平声波 + 提示文案」。
手指上滑进入文案区域 → 取消态（声波与文案变红，文案改为「松开取消」），滑回下方恢复；
松手时取消态则**直接丢弃**（不弹 toast——它会盖住声波，取消本身已经有变色/文案反馈），否则转写并直接发送。
松手后遮罩保持到识别结束，文案换成「正在识别…」。发送键变成键盘按钮。

---

## 一、桥的契约

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
  startVoice(),   // 开始录音；失败/拒绝通过 onNativeVoiceError 回报
  stopVoice(),    // 结束录音；结果通过 onNativeVoiceResult 回传
  cancelVoice()   // 放弃本次录音（无回调；页面自己已经把状态复位了）
};
```

**线程模型**：这三个方法都跑在 WebView 的 JavaBridge 子线程上，**不是主线程**。
`MediaRecorder` 的所有调用必须收敛到主线程：方法入口先 `mainHandler.post(...)`，
读临时文件 + Base64 才放回子线程。

### 3. 回调（页面定义，壳调用）

```js
window.onNativeVoiceResult(base64, mime)   // mime 例：'audio/mp4'
window.onNativeVoiceError(code, message)   // 见下方错误码表
window.onNativeVoiceState('recording')     // 建议实现：真正开始录时调一次
window.onNativeVoiceAmp(amp)               // 建议实现：原始幅度 0~32767，驱动遮罩里的声波
```

- `onNativeVoiceAmp(amp)`：壳只上报 `MediaRecorder.getMaxAmplitude()` 的**原始值**
  （0~32767，主线程每 100ms 一次），**不要做任何换算**。dB 归一化、静音门限、快攻慢放平滑
  全部在页面侧——浏览器（RMS）和壳（峰值）两条路的规则只存在一份。
  旧名 `onNativeVoiceLevel` 仍作为别名接受（同样按原始幅度解释）。
  不实现也能用：声波静默停在基线上（不空转、不假动）。
  JS 侧还要自己做快攻慢放平滑，壳不需要平滑。
- `onNativeVoiceState('recording')`：**按住说话的时长判定依赖它**。页面用这个回调重置
  「60 秒上限」和「太短丢弃」的起点，避免首次授权弹窗的时间被算进录音。不实现也不会崩：
  页面按点击时刻计时，代价是首次授权那一次会被当成「太短」丢弃（用户再按一次即可）。
- 页面收到 `onNativeVoiceResult` 后会直接发送消息（不经过输入框、不可编辑）。
- 所有回调都必须在**主线程**调 `webView.evaluateJavascript`。
- 字符串一律用 `JSONObject.quote(...)` 拼，不要手写 `'` 转义——异常 message 里可能有
  `\`、换行、U+2028，会把整段脚本打断。

### 4. 状态机与错误码

壳侧状态：`IDLE → (WAITING_PERMISSION) → RECORDING → ENCODING → IDLE`。
`startVoice` 只在 `IDLE` 生效，`stopVoice` 只在 `RECORDING` 生效（其余静默忽略）。

| code | 触发时机 | 页面表现 |
|---|---|---|
| `no_permission` | 用户拒绝 / 取消授权弹窗 | toast「需要麦克风权限」 |
| `start_failed` | `prepare()` / `start()` 抛异常（含回退 MIC 后仍失败） | toast |
| `too_short` | `stop()` 抛异常（录音 < ~1s） | toast「说话时间太短，请按住再说」，**不上传** |
| `read_failed` | 读临时文件失败 | toast |
| `cancelled` | 生命周期打断（切后台 / 换页） | **静默复位，不弹提示** |
| 其他未知 code | — | toast 里显示 `message`，没有就显示 code |

**取消语义**：页面在 `stopVoice()` 之后会一直等结果（直到点击后 90 秒的硬超时），
所以壳在生命周期里取消录音时**必须**回调 `onNativeVoiceError('cancelled','')`，
否则按钮会卡在「录音中」。`cancelVoice()` 是页面主动发起的，壳不需要回报。

### 5. 体积与时序

- 16kHz / 32kbps / 单声道 AAC：60 秒 ≈ **240KB**，Base64 后 ≈ **320KB**。
- `evaluateJavascript` 走 Binder，单次约 1MB 上限；320KB 安全，但**不要再延长单次时长**。
  真要 2 分钟以上，改成按段回传或本地 HTTP 回传。
- 松开后页面最多等 3 秒拿音频（等不到就复位，覆盖「壳还在等权限」的情况）；
  拿到后上传+识别，正常 1~2 秒。
- 按住时间 < 500ms 视为误触：页面直接丢弃，不上传；壳自己的 `too_short` 是第二道保险。

---

## 二、Java 参考骨架（纯 Java / minSdk 21）

只演示契约要求的部分；`UrlPolicy`、埋点、通知等按各自工程接。

```java
// AndroidManifest.xml
//   <uses-permission android:name="android.permission.RECORD_AUDIO" />

public final class VoiceBridge {
    private static final int REQ_MIC = 1001;
    private static final long MAX_MS = 60_000;

    private enum State { IDLE, WAITING_PERMISSION, RECORDING, ENCODING }

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable autoStop = this::stopOnMain;

    // 实时电平：每 100ms 读一次 getMaxAmplitude() 交给页面画声波
    private static final long LEVEL_INTERVAL_MS = 100;
    private final Runnable levelTick = this::tickLevel;

    private void tickLevel() {
        MediaRecorder r = recorder;
        if (state != State.RECORDING || r == null) return;
        int amp = 0;
        try { amp = r.getMaxAmplitude(); } catch (Exception ignored) { }
        // 原始幅度直接给页面：dB 归一化/门限/平滑全在 JS，壳不做任何数学
        js("window.onNativeVoiceAmp && window.onNativeVoiceAmp(" + amp + ")");
        main.postDelayed(levelTick, LEVEL_INTERVAL_MS);
    }

    private State state = State.IDLE;
    private MediaRecorder recorder;
    private File file;

    public VoiceBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ---- JS 入口：JavaBridge 线程 → 主线程 ----
    @JavascriptInterface public void startVoice()  { main.post(this::startOnMain); }
    @JavascriptInterface public void stopVoice()   { main.post(this::stopOnMain); }
    @JavascriptInterface public void cancelVoice() { main.post(() -> cancelOnMain(true)); }

    // ---- 生命周期：由 Activity / WebViewClient 调用 ----
    // 注意：只取消真正在录/在编码的状态。授权弹窗期间某些 ROM 会走 onPause，
    // 那里如果一并取消，首次授权的两段式流程就断了。
    public void onPause() {
        main.post(() -> {
            if (state == State.RECORDING || state == State.ENCODING) cancelOnMain(true);
        });
    }
    public void onDestroy()       { main.post(() -> cancelOnMain(false)); }
    public void onPageChanged()   { main.post(() -> cancelOnMain(true)); }

    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != REQ_MIC) return;
        main.post(() -> {
            if (state != State.WAITING_PERMISSION) return;
            state = State.IDLE;
            boolean ok = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (!ok) { fail("no_permission", "需要麦克风权限"); return; }
            beginRecording(); // 授权后直接开录（体验优先，不要求用户再点一次）
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

    @SuppressLint("NewApi")
    private void beginRecording() {
        // VOICE_RECOGNITION 关掉 AGC/降噪，对 ASR 更友好；个别机型不支持则回退 MIC
        int[] sources = {MediaRecorder.AudioSource.VOICE_RECOGNITION,
                         MediaRecorder.AudioSource.MIC};
        for (int source : sources) {
            File f = null;
            MediaRecorder r = null;
            try {
                f = File.createTempFile("voice", ".m4a", activity.getCacheDir());
                r = Build.VERSION.SDK_INT >= 31
                        ? new MediaRecorder(activity)   // 无参构造在 API 31 起废弃
                        : new MediaRecorder();
                r.setAudioSource(source);
                r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                r.setAudioSamplingRate(16000);
                r.setAudioEncodingBitRate(32000);
                r.setAudioChannels(1);
                r.setOutputFile(f.getAbsolutePath());
                r.prepare();
                r.start();

                recorder = r;
                file = f;
                state = State.RECORDING;
                main.postDelayed(autoStop, MAX_MS);
                main.postDelayed(levelTick, LEVEL_INTERVAL_MS);
                // 让页面的 60s 从“真的开始录”算（授权弹窗的时间不算）
                js("window.onNativeVoiceState && window.onNativeVoiceState('recording')");
                // 不要再额外弹原生 Toast：页面遮罩已经给了全部反馈，弹窗会压住声波
                return;
            } catch (Exception e) {
                // 局部变量释放：失败时 recorder 字段还没赋值，releaseQuietly() 管不到它
                if (r != null) {
                    try { r.stop(); } catch (Exception ignored) { }
                    try { r.release(); } catch (Exception ignored) { }
                }
                delete(f);
            }
        }
        state = State.IDLE;
        fail("start_failed", "无法开始录音");
    }

    private void stopOnMain() {
        if (state != State.RECORDING) return;
        main.removeCallbacks(autoStop);
        main.removeCallbacks(levelTick);   // 停止上报电平
        state = State.ENCODING;

        MediaRecorder r = recorder;
        File f = file;
        recorder = null;
        file = null;

        boolean stopped = true;
        try { r.stop(); } catch (RuntimeException e) { stopped = false; } // 太短会抛
        try { r.release(); } catch (Exception ignored) { }

        if (!stopped) {
            delete(f);
            state = State.IDLE;
            fail("too_short", "没有录到声音");
            return;
        }
        new Thread(() -> {
            try {
                byte[] bytes = readAll(f);
                String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                delete(f);
                main.post(() -> {
                    state = State.IDLE;
                    js("window.onNativeVoiceResult(" + JSONObject.quote(b64) + ",'audio/mp4')");
                });
            } catch (Exception e) {
                delete(f);
                main.post(() -> { state = State.IDLE; fail("read_failed", "读取录音失败"); });
            }
        }, "voice-encode").start();
    }

    /** notify=true：页面在等结果，必须回 cancelled 让它复位；onDestroy 时页面已走，不必回。 */
    private void cancelOnMain(boolean notify) {
        main.removeCallbacks(autoStop);
        main.removeCallbacks(levelTick);
        boolean wasActive = state != State.IDLE;
        releaseQuietly();
        delete(file);
        file = null;
        state = State.IDLE;
        if (notify && wasActive) js("window.onNativeVoiceError('cancelled','')");
    }

    private void releaseQuietly() {
        if (recorder == null) return;
        try { recorder.stop(); } catch (Exception ignored) { }
        try { recorder.release(); } catch (Exception ignored) { }
        recorder = null;
    }

    private void fail(String code, String message) {
        js("window.onNativeVoiceError(" + JSONObject.quote(code) + ","
                + JSONObject.quote(message) + ")");
    }

    private void js(String script) {
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private static byte[] readAll(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void delete(File f) {
        if (f != null) f.delete();
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
@Override protected void onPause()     { bridge.onPause(); super.onPause(); }
@Override protected void onDestroy()   { bridge.onDestroy(); super.onDestroy(); }
// WebViewClient.onPageStarted：URL 变了就 bridge.onPageChanged()
```

---

## 三、壳侧必须同步的清单

| 项 | 内容 |
|---|---|
| `AndroidManifest.xml` | `<uses-permission android:name="android.permission.RECORD_AUDIO" />` |
| `proguard-rules.pro` | 保留桥：`-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }`，并删掉「本项目未使用 addJavascriptInterface」的注释 |
| README 安全表 | 从「不使用 JS 桥」改为「仅暴露语音桥：三个无参方法，无文件/存储读取能力」 |
| README 权限行 | 「只有 INTERNET」→「INTERNET + RECORD_AUDIO」 |
| 桥的防护 | `UrlPolicy.isAllowed(webView.getUrl())` + `activity.hasWindowFocus()` + 单实例状态机；建议再加一个原生 Toast 提示录音已开始（外部 CDN 脚本与页面同源，能调桥，但用户至少看得见） |
| 页面导航 | `onPageStarted` 且 URL 变化时取消，避免 base64 打到新页面的回调上 |

> 触摸时间戳门槛（最近 N 秒内有触摸才允许录音）能进一步防静默录音，但会让无障碍操作不可用，
> 不建议默认开。

---

## 四、iOS（以后若有 WKWebView 壳）

契约相同，换注入方式：

```swift
// 注入：WKUserScript(source: "window.AgentNative = {...}", injectionTime: .atDocumentStart, ...)
// 录音：AVAudioRecorder（16kHz / 单声道 / m4a）
// 回传：webView.evaluateJavaScript("window.onNativeVoiceResult('\(b64)','audio/mp4')")
```

`Info.plist` 需要 `NSMicrophoneUsageDescription`。

## 五、服务端接口

```http
POST /api/asr/transcribe
Content-Type: audio/mp4        # 或 audio/webm / audio/wav / application/octet-stream
Cookie: <登录态>                # 与页面同一份 HttpOnly cookie

<音频二进制>
```

```json
{ "text": "打开今天的日报", "ms": 842, "model": "glm-asr" }
```

- 上限 20MB，超时 120s；识别失败返回 `{"error": "..."}`（前端直接 toast 出来）。
- `GET /api/asr/status` → `{"enabled": true}`：`ASR_URL` 没接线时为 `false`。

## 六、为什么不用浏览器的 Web Speech API

- Android WebView 没有实现 `SpeechRecognition`；iOS WKWebView 同样不可用（只有 Safari 有）。
- 桌面 Chrome 的识别走 Google 服务，国内基本报 `network`。
- 三端行为不一致、错误码各异，最后还是要留一条服务端通路——不如只留一条。
