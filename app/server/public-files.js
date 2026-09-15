// 公网临时文件：短 ID 能力链接。
//
// 为什么不用签名 URL：外部服务（如智谱）那一跳只需要「随机不可猜 + 会过期」，而签名 URL 必须把
// 会话名、文件名、过期时间、64 位签名全塞进 URL —— 又长又满是 %XX，模型抄进工具参数容易抄错，
// 而且这条 URL 会留在会话历史里每轮重发，白烧 token。这里只发一个 22 字符的随机 ID：
//   http://<IP>:8090/p/9fQ2mZ7xK4tR1vBn
//
// 状态放本进程内存：重启即全部失效 —— 与签名方案语义一致（签名密钥本来就是进程内随机的），
// 所以不是退步，而是把「不可猜」从 HMAC 换成了随机 ID 本身。
//
// 边界：只有内网签发入口（routes/public-link.js，不映射宿主机）能 mint；
//       取用侧（routes/public-files.js）只按 ID 查表，查不到/过期一律 404。
'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000; // 兜底上限：内网签发，正常远达不到

const entries = new Map(); // id -> { sessionId, rel, expires }

function sweep(now) {
    for (const [id, e] of entries) {
        if (e.expires <= now) entries.delete(id);
    }
}

function mint({ sessionId, rel, ttlMs }) {
    const now = Date.now();
    sweep(now);
    while (entries.size >= MAX_ENTRIES) {
        // 满了就丢最老的（Map 保持插入顺序）
        entries.delete(entries.keys().next().value);
    }
    const id = crypto.randomBytes(16).toString('base64url'); // 22 字符，URL 安全
    entries.set(id, {
        sessionId,
        rel,
        expires: now + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS),
    });
    return id;
}

// 命中且未过期才返回 {sessionId, rel, expires}；过期即顺手删掉
function resolve(id) {
    const key = String(id || '');
    const e = entries.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) {
        entries.delete(key);
        return null;
    }
    return e;
}

module.exports = { mint, resolve };
