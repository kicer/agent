// 按会话分组的 SSE 事件总线；前端通过 GET /api/sessions/:id/stream 订阅。
// 另有一组「内部订阅者」（onInternal）：同进程的桥接功能（如微信推送 wechat.js）监听回合事件；
// 与 HTTP 客户端不同，内部订阅者不受「无观看者早退」影响——微信会话常常没有任何 Web 页面在看。
function createBus() {
  const clients = new Map(); // session_id -> Set<res>
  const internal = new Set(); // fn(sessionId, event, data)

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
    if (set.size === 0) clients.delete(sessionId);
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
    for (const res of Array.from(set)) {
      try { res.write(payload); } catch (_) { removeClient(sessionId, res); }
    }
  }

  function closeAll(sessionId) {
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
