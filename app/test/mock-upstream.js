// 测试用 mock 上游：OpenAI 兼容 /chat/completions 流式接口（数字最小化写法，规避生成噪声）
// 规则：
//  - 历史里已有 tool 结果 -> 回纯文本收尾
//  - 最后一条 user 消息含 "写文件" -> 返回 write_file 工具调用
//  - 含 "读图" -> 返回 read_file(pic.png) 工具调用（验证 vision 图片回传）
//  - 含 "慢" -> 慢速输出（用于终止测试）
//  - 其他 -> 纯文本 "已收到: <最后一条user消息>"
const http = require('http');

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function streamText(res, text, delayMs) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const queue = Array.from(text);
  const timer = setInterval(() => {
    if (!queue.length) {
      clearInterval(timer);
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      // 尾声 usage 帧(OpenAI stream_options.include_usage 行为),供 token 用量统计测试
      sse(res, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sse(res, { choices: [{ delta: { content: queue.shift() } }] });
  }, delayMs || 5);
  res.on('close', () => clearInterval(timer));
}

function streamToolCall(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sse(res, { choices: [{ delta: { role: 'assistant', content: '好的，我来创建文件。' } }] });
  sse(res, { choices: [{ delta: { tool_calls: [{ id: 'call-test-' + Date.now(), function: { name: 'write_file' } }] } }] });
  sse(res, { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path": "hello.txt",' } }] } }] });
  sse(res, { choices: [{ delta: { tool_calls: [{ function: { arguments: ' "content": "hello from agent"}' } }] } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  sse(res, { usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamReadFileCall(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const id = 'call-img-' + Date.now();
  sse(res, { choices: [{ delta: { role: 'assistant', tool_calls: [{ id, function: { name: 'read_file' } }] } }] });
  sse(res, { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path": "pic.png"}' } }] } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  sse(res, { usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      res.writeHead(400).end('bad json');
      return;
    }
    const msgs = parsed.messages || [];
    const hasToolResult = msgs.some(m => m.role === 'tool');
    const lastUser = msgs.slice().reverse().find(m => m.role === 'user');
    const userText = (lastUser && lastUser.content) || '';
    process.stdout = process.stdout;
    if (hasToolResult) {
      streamText(res, '文件已创建并验证完毕。');
    } else if (userText.includes('读图')) {
      streamReadFileCall(res);
    } else if (userText.includes('写文件')) {
      streamToolCall(res);
    } else if (userText.includes('慢')) {
      streamText(res, '这是一段很长的慢速输出，用来测试终止功能是否生效。', 200);
    } else {
      streamText(res, '已收到: ' + userText);
    }
  });
});

const port = Number(process.env.MOCK_PORT || 9999);
server.listen(port, () => console.info('[mock] listening on ' + port));
