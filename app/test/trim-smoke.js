// 临时冒烟：重负载占位裁剪（跑完即删）。
const assert = require('assert');
const llm = require('../server/llm');

const big = n => 'x'.repeat(n);
const mk = (id, role, extra) => Object.assign({ id, role, type: null, content: '' }, extra);
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const rows = [
  mk(1, 'user', { content: '抓X存notes再写summary' }),
  mk(2, 'assistant', { tool_calls: JSON.stringify([call('c1', 'fetch', { url: 'https://e.com/x' })]) }),
  mk(3, 'tool', { tool_call_id: 'c1', name: 'fetch', content: 'HTTP 200\n' + big(8000) }),
  mk(4, 'assistant', { tool_calls: JSON.stringify([call('c2', 'write_file', { path: 'notes.md', content: big(12000) })]) }),
  mk(5, 'tool', { tool_call_id: 'c2', name: 'write_file', content: '已创建文件 notes.md（12003 字节）' }),
  mk(6, 'assistant', { tool_calls: JSON.stringify([call('c3', 'write_file', { path: 'summary.md', content: '小内容' })]) }),
  mk(7, 'tool', { tool_call_id: 'c3', name: 'write_file', content: '已创建文件 summary.md（9 字节）' }),
  mk(8, 'assistant', { content: '两篇已写好' }),
];
const session = () => ({ history: rows.slice(), profile_snapshot: '', blocksCache: new Map() });

// A) 全历史：距尾够远 → fetch 回执与 write_file(大) 参数被占位；write_file(小)/回执/收尾不动
let msgs = llm.buildMessages(session(), 'Simplified Chinese', null, null);
const a = msgs.filter(m => m.role === 'assistant' && m.tool_calls);
const argsNotes = JSON.parse(a.find(m => m.tool_calls[0].id === 'c2').tool_calls[0].function.arguments);
assert(/^\[正文省略：本调用已写入 notes\.md，12000 字\]$/.test(argsNotes.content), 'write_file 大参数应占位: ' + argsNotes.content);
const argsSum = JSON.parse(a.find(m => m.tool_calls[0].id === 'c3').tool_calls[0].function.arguments);
assert.strictEqual(argsSum.content, '小内容', '低于 TRIM_MIN 不裁');
const t = msgs.find(m => m.role === 'tool' && m.tool_call_id === 'c1');
assert(/^\[fetch 省略：https:\/\/e\.com\/x｜HTTP 200｜原 8009 字\]$/.test(t.content), 'fetch 回执应占位: ' + t.content);
assert(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'c2').content.includes('已创建文件'), 'write 回执不动');

// B) 截到第 5 行（write 刚落盘的当次调用）：都太新鲜，不裁
msgs = llm.buildMessages({ history: rows.slice(0, 5), profile_snapshot: '', blocksCache: new Map() }, 'Simplified Chinese', null, null);
assert(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'c1').content.length > 7000, 'fetch 距尾 1 轮应保留');
assert.strictEqual(JSON.parse(msgs.filter(m => m.tool_calls).pop().tool_calls[0].function.arguments).content.length, 12000, 'write 参数距尾 0 轮应保留');

// C) 压缩回合不裁
const cm = llm.compressMessages(session(), 'Simplified Chinese', null, null);
assert(cm.find(m => m.role === 'tool' && m.tool_call_id === 'c1').content.length > 7000, '压缩回合保留原文');

// D) read_file 回执同款
const r3orig = rows[2];
rows[2] = mk(3, 'tool', { tool_call_id: 'c1', name: 'read_file', content: 'HTTP 200\n' + big(8000) });
rows[1] = mk(2, 'assistant', { tool_calls: JSON.stringify([call('c1', 'read_file', { path: 'a.md' })]) });
msgs = llm.buildMessages(session(), 'Simplified Chinese', null, null);
assert(/^\[read_file 省略：a\.md｜原 8009 字\]$/.test(msgs.find(m => m.tool_call_id === 'c1' && m.role === 'tool').content), 'read_file 应占位');
rows[2] = r3orig;
rows[1] = mk(2, 'assistant', { tool_calls: JSON.stringify([call('c1', 'fetch', { url: 'https://e.com/x' })]) });

// E) 开关：0=关
llm.setPayloadTrim({ trim_write_rounds: 0, trim_result_rounds: 0 });
msgs = llm.buildMessages(session(), 'Simplified Chinese', null, null);
assert(msgs.find(m => m.role === 'tool' && m.tool_call_id === 'c1').content.length > 7000, '0=关');
llm.setPayloadTrim({}); // 回落默认 1/2

// F) 非法/缺失参数不炸（arguments 非 JSON、无 url 的 fetch；需距尾够远）
rows.push(mk(9, 'assistant', { tool_calls: JSON.stringify([call('c9', 'fetch', {})]) }));
rows.push(mk(10, 'tool', { tool_call_id: 'c9', name: 'fetch', content: 'HTTP 404\n' + big(700) }));
rows.push(mk(11, 'assistant', { content: '页面不存在，换个 url？' }));
rows.push(mk(12, 'assistant', { tool_calls: JSON.stringify([call('c12', 'read_file', { path: 'notes.md' })]) }));
msgs = llm.buildMessages(session(), 'Simplified Chinese', null, null);
assert(/\[fetch 省略：\?｜HTTP 404/.test(msgs.find(m => m.tool_call_id === 'c9').content), '缺 url 仍占位: ' + msgs.find(m => m.tool_call_id === 'c9').content);

console.log('TRIM-SMOKE-OK');
