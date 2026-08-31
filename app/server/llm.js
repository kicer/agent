// 上游调用：OpenAI 兼容 /chat/completions 流式接口（由 cli-proxy-api 代理）。
// 累积 content 与 tool_calls 分片；支持 abort。
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'system-prompt.txt'), 'utf8');

function buildSystemPrompt(session, modelDisplayName) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{动态日期}', dateStr)
    .replace('{任务目录路径}', session.task_dir)
    .replace('{模型显示名}', modelDisplayName || session.model_id || '');
}

// 将 DB 消息行转为 OpenAI messages 数组（不含 system，由调用方拼接）。
function buildMessages(session, modelDisplayName) {
  const messages = [{ role: 'system', content: buildSystemPrompt(session, modelDisplayName) }];
  for (const row of session.history) {
    if (row.role === 'assistant') {
      const m = { role: 'assistant', content: row.content || '' };
      if (row.tool_calls) m.tool_calls = JSON.parse(row.tool_calls);
      if (!m.content) delete m.content;
      messages.push(m);
    } else if (row.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: row.tool_call_id, name: row.name, content: row.content || '' });
    } else {
      messages.push({ role: row.role, content: row.content || '' });
    }
  }
  return messages;
}

// 解析 SSE 行流，对每个 data: JSON 调用 onEvent。
async function forEachSSEData(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return;
        try { onEvent(JSON.parse(data)); } catch (_) { /* 忽略坏帧 */ }
      }
    }
  }
}

// 调模型一次。onText(textDelta) 回调流式文本。
// 返回 { content, tool_calls: [{id,name,arguments(string)}], finish_reason, usage, aborted }
async function callModel(cfg, modelId, messages, tools, options) {
  const opts = options || {};
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort());
  }
  const modelCfg = (cfg.models || []).find(m => m.id === modelId);
  if (!modelCfg || !modelCfg.url) throw new Error('模型未在配置中定义或缺少独立 url: ' + modelId);

  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: cfg.agent.temperature,
  };
  if (tools && tools.length) body.tools = tools;

  const headers = { 'Content-Type': 'application/json' };
  if (modelCfg.api_key) headers.Authorization = 'Bearer ' + modelCfg.api_key;

  const res = await fetch(modelCfg.url + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('上游返回 ' + res.status + ': ' + text.slice(0, 500));
    err.upstream_status = res.status;
    throw err;
  }

  let content = '';
  let finishReason = null;
  let usage = null;
  let aborted = false;
  const toolCalls = new Map(); // index -> {id, name, arguments}

  try {
    await forEachSSEData(res, evt => {
      if (opts.shouldCancel && opts.shouldCancel()) { aborted = true; controller.abort(); return; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices && evt.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length) {
        content += delta.content;
        if (opts.onText) opts.onText(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index || 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', arguments: '' });
        const acc = toolCalls.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function) {
          if (tc.function.name) acc.name += tc.function.name;
          if (tc.function.arguments) acc.arguments += tc.function.arguments;
        }
      }
    });
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true; else throw e;
  }
  if (opts.shouldCancel && opts.shouldCancel()) aborted = true;

  return { content, tool_calls: Array.from(toolCalls.values()), finish_reason: finishReason, usage, aborted };
}

module.exports = { callModel, buildMessages, buildSystemPrompt };
