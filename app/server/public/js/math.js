// 数学公式渲染（KaTeX 本地化，vendor/katex/）。
// 所有 markdown 入口（聊天气泡 / md 文件预览 / 流式增量）都走 core.js 的 mdHtml()，
// 公式处理收在这一个文件里，不散落到各处。
//
// 支持：
//   $$...$$  块级（可换行）
//   $...$    行内（$ 后不能是空白、前不能是数字/字母，避免「$5 ... $6」被当公式）
//
// 实现方式：占位符往返，而不是 marked 扩展。
//   1) markdown 解析前，把公式抠成 @@MATHn@@ 占位（跳过围栏代码与行内代码）
//   2) 交给 marked 正常解析
//   3) 输出 HTML 里把占位换回 KaTeX 渲染结果
// 这样公式里的 * _ \ { } 不会被 marked 当成强调/转义吃掉。

const MATH_PH = /@@MATH(\d+)@@/g;

// 从 markdown 源里抠出公式，返回 { md, store }
function mathExtract(src) {
  const text = String(src || '');
  const store = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    // 围栏代码块整段跳过（三个反引号）
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    // 行内代码跳过
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // 块级 $$...$$
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end > i + 2) {
        const latex = text.slice(i + 2, end).trim();
        if (latex) {
          store.push({ latex: latex, display: true });
          out += '@@MATH' + (store.length - 1) + '@@';
          i = end + 2;
          continue;
        }
      }
    }
    // 行内 $...$
    if (text[i] === '$') {
      const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/.exec(text.slice(i));
      if (m) {
        const before = i > 0 ? text[i - 1] : '';
        const after = text[i + m[0].length] || '';
        // 前后紧邻字母/数字时不当公式：$5 和 $6、a$b$c 之类
        if (!/[0-9A-Za-z]/.test(before) && !/[0-9A-Za-z]/.test(after)) {
          store.push({ latex: m[1], display: false });
          out += '@@MATH' + (store.length - 1) + '@@';
          i += m[0].length;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return { md: out, store: store };
}

function mathEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// 单个公式 → HTML。KaTeX 不存在或 LaTeX 有错时原样吐回，用户能看见哪里写错了。
function mathRenderOne(latex, display) {
  const wrap = display ? '$$' : '$';
  if (typeof katex === 'undefined') {
    return '<span class="math-fallback">' + wrap + mathEsc(latex) + wrap + '</span>';
  }
  try {
    const html = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      strict: false,
    });
    // 块级公式自己占一行；行内公式保持内联
    return display ? '<span class="math-block">' + html + '</span>' : '<span class="math-inline">' + html + '</span>';
  } catch (e) {
    return '<span class="math-error" title="' + mathEsc(String((e && e.message) || e)) + '">' +
      wrap + mathEsc(latex) + wrap + '</span>';
  }
}

// 把 HTML 里的占位换回渲染结果
function mathExpand(html, store) {
  if (!store || !store.length) return html;
  return String(html || '').replace(MATH_PH, function (all, idx) {
    const item = store[Number(idx)];
    return item ? mathRenderOne(item.latex, item.display) : all;
  });
}

// 一步到位：markdown → 含公式的 HTML。markedRef 由调用方传入（core.js 里的全局 marked）
function mdParseWithMath(text, markedRef) {
  const r = mathExtract(text);
  const html = markedRef.parse(r.md);
  return mathExpand(html, r.store);
}
