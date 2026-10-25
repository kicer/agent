// 视口适配：软键盘高度 → CSS 变量 --kb-page（纯页面侧兜底，不依赖套壳 App 改代码）
// ----------------------------------------------------------------------------
// 症状：套壳 App（Android WebView / ArkWeb）开了 edge-to-edge 后，
//   1) 顶部内容压在状态栏下面 —— 安卓 WebView 的 env(safe-area-inset-top) 只反映屏幕
//      挖孔(display cutout)，不含状态栏高度，基本恒为 0；壳不额外注入就顶不上去。
//      这一条由壳注入 CSS 变量解决，见下方「注入约定」，本文件不处理。
//   2) 键盘弹起、输入框被盖住 —— Chromium 默认 interactive-widget=resizes-visual，只缩
//      visual viewport，layout viewport 不动。本页是 height:100% 的固定 shell，footer 全靠
//      layout viewport 变矮才会被顶上来，于是原地不动被键盘压住（看起来像「没给键盘留位置」）。
//
// 本文件只解决第 2 条：用 visualViewport 与 innerHeight 的差值算出键盘实际占用的高度，
// 写进 --kb-page；#app 按 --kb（= max(--kb-page, --kb-native)）收缩，footer 自动落在键盘上沿。
// 壳若已正确 resize（adjustResize / resizes-content 生效），innerHeight 会同步变矮，
// 差值恒为 0，本逻辑自动失效，不会二次收缩。
//
// 注入约定（壳侧，loadUrl 之后或 WindowInsets 变化时）：
//   document.documentElement.style.setProperty('--sat', '36px');        // 状态栏高度
//   document.documentElement.style.setProperty('--sab', '20px');        // 导航栏/手势条高度
//   document.documentElement.style.setProperty('--kb-native', '300px'); // IME 高度（可选）
// --kb-native 用于「WebView 完全感知不到键盘」的情况（窗口不 resize、visualViewport 也不缩），
// 此时本文件量不到任何东西，只能靠壳把 IME insets 报进来；页面与壳各写各的变量，互不覆盖。
(function () {
  'use strict';

  const root = document.documentElement;
  const vv = window.visualViewport;
  // 没有 visualViewport 的老 WebView：只剩 interactive-widget / 壳 resize 两条路
  if (!vv) return;

  // 键盘判定阈值：地址栏/浏览器 UI 收起通常 < 60px，软键盘一般 > 150px，
  // 取 80 让两者之间留足余量，避免把浏览器 UI 收起误判成键盘。
  const KB_MIN = 80;
  // 贴底判定：与 chat.js 的 SCROLL_BOTTOM_THRESHOLD 同量级即可，不必严格一致
  const STICK_PX = 80;

  let kb = 0;
  let raf = 0;

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
  }

  function measure() {
    raf = 0;
    // 键盘占掉的高度 = layout viewport 高度 -（visual viewport 顶部偏移 + 可视高度）。
    // 浏览器为露出光标会把 visual viewport 上推（offsetTop > 0），这部分要一并扣掉，
    // 否则会按「整段键盘」收缩，footer 反而被顶得比键盘上沿更高。
    let next = Math.round(window.innerHeight - vv.offsetTop - vv.height);
    // 双指缩放时 vv.height 被压缩，不代表键盘（user-scalable=no 下基本走不到）
    if (vv.scale > 1.01 || next < KB_MIN) next = 0;
    // 兜底上限：横屏 + 大字号等极端情况下别把整个 shell 收没
    next = Math.min(next, Math.round(window.innerHeight * 0.7));

    if (next === kb) return;

    const box = document.getElementById('chat-view');
    // 只在「键盘弹起导致变矮」时继续贴底；收键盘时保持当前阅读位置不动
    const stick = next > kb && !!box && nearBottom(box);
    kb = next;
    root.style.setProperty('--kb-page', kb + 'px');

    if (stick) {
      // 等一次布局：#app 收缩后 scrollHeight / clientHeight 才是新值
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(measure);
  }

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule); // 浏览器平移 visual viewport 时 offsetTop 会变
  // 转屏后尺寸与 inset 都变了，等系统栏动画结束再量一次
  window.addEventListener('orientationchange', () => setTimeout(measure, 200));
})();
