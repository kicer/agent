// 按会话分组的 SSE 事件总线；前端通过 GET /api/sessions/:id/stream 订阅。
// 另有一组「内部订阅者」（onInternal）：同进程的桥接功能（如微信推送 wechat.js）监听回合事件；
// 与 HTTP 客户端不同，内部订阅者不受「无观看者早退」影响——微信会话常常没有任何 Web 页面在看。
function createBus() {
  const clients = new Map(); // session_id -> Set<res>
  const internal = new Set(); // fn(sessionId, event, data)

  // 高频事件的合并缓冲：LLM 每吐一个 token 就是一条 assistant_delta，一次 res.write 就是一个
  // TCP 包（Node 默认 TCP_NODELAY）。手机热点 / 跨境链路上包数比字节数更伤——每包都要射频调度，
  // 拥塞窗口也容易被小包拖住。摍 50ms 或 8 条合并成一次 write。
  // 其他事件立即发，但发前先 flush，保证前端看到的顺序和产生顺序一致。
  const MERGE_EVENTS = new Set(['assistant_delta', 'reasoning_delta', 'tool_call_args']);
  const FLUSH_MS = 50;
  const FLUSH_COUNT = 8;
  const pending = new Map(); // session_id -> { parts: string[], timer }

  function writeAll(sessionId, payload) {
    const set = clients.get(sessionId);
    if (!set || set.size === 0) return;
    for (const res of Array.from(set)) {
      try { res.write(payload); } catch (_) { removeClient(sessionId, res); }
    }
  }

  function flush(sessionId) {
    const p = pending.get(sessionId);
    if (!p) return;
    pending.delete(sessionId);
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p.parts.length) writeAll(sessionId, p.parts.join(''));
  }

  function onInternal(fn) {
    internal.add(fn);
    return () => internal.delete(fn);
  }

  function addClient(sessionId, res) {
    if (!clients.has(sessionId)) clients.set(sessionId, new Set());
    clients.get(sessionId).add(res);
  }

  function removeClient(sessionId, res) {
    const set = clients.get(sessionId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      clients.delete(sessionId);
      flush(sessionId); // 没人看了，把还摍着的清掉，避免 pending 常驻
    }
  }

  // event 名称 + 任意 JSON data。无客户端时静默丢弃（消息本身已持久化，重连可回放）。
  // 内部订阅者先跑（单个抛错不影响投递其余），再发 HTTP 客户端。
  function emit(sessionId, event, data) {
    if (internal.size) {
      for (const fn of Array.from(internal)) {
        try { fn(sessionId, event, data); } catch (_) { /* 内部监听不干扰正常广播 */ }
      }
    }
    const set = clients.get(sessionId);
    if (!set || set.size === 0) return;

    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';

    if (MERGE_EVENTS.has(event)) {
      let p = pending.get(sessionId);
      if (!p) { p = { parts: [], timer: null }; pending.set(sessionId, p); }
      p.parts.push(payload);
      if (p.parts.length >= FLUSH_COUNT) { flush(sessionId); return; }
      if (!p.timer) p.timer = setTimeout(() => flush(sessionId), FLUSH_MS);
      return;
    }

    // 非合并事件：先把摍着的发掉，保证顺序不乱
    flush(sessionId);
    writeAll(sessionId, payload);
  }

  function closeAll(sessionId) {
    flush(sessionId);
    const set = clients.get(sessionId);
    if (!set) return;
    for (const res of Array.from(set)) {
      try { res.end(); } catch (_) {}
    }
    clients.delete(sessionId);
  }

  function clientCount(sessionId) {
    const set = clients.get(sessionId);
    return set ? set.size : 0;
  }

  // 进程退出前用：掐断所有会话的 SSE 流，让 server.close() 能等到连接清零
  // （SSE 是长连接，不主动结束的话 close 回调永远不来）。
  function closeAllSessions() {
    for (const sessionId of Array.from(clients.keys())) closeAll(sessionId);
  }

  return { addClient, removeClient, emit, closeAll, closeAllSessions, clientCount, onInternal };
}

module.exports = { createBus };
