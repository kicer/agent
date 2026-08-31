// 按会话分组的 SSE 事件总线；前端通过 GET /api/sessions/:id/stream 订阅。
function createBus() {
  const clients = new Map(); // session_id -> Set<res>

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
  function emit(sessionId, event, data) {
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

  return { addClient, removeClient, emit, closeAll, clientCount };
}

module.exports = { createBus };
