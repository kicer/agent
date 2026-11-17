# Context Relay

把「每轮重传全量历史」换成「只传增量」。挡在 `workbuddy2api` 前面，对上游透明。

**为什么不改上游**：`workbuddy2api` 一天几十个提交，fork 维护不起。这层只在两者之间做
「查表 + 拼数组 + pipe」，不改协议、不改 SSE。

---

## 协议

客户端多带两个头：

| header | 说明 |
|---|---|
| `X-Context-Id` | `<core_id>:<user>:<session_id>`，会话级唯一标识 |
| `X-Context-Hash` | 客户端认为本服务已存的那段消息的 sha256；**空字符串 = 全量替换** |

请求体的 `messages` **只放新增**（首轮/压缩后放全量），其余字段原样。

### 三种走向

| 条件 | 行为 |
|---|---|
| 没带 `X-Context-Id`，或模型没开 store | 完全透明转发，和直连一致 |
| `X-Context-Hash` 为空 | 整段替换缓存 |
| 缓存存在且 hash 命中 | 缓存 + 新增拼起来转发 |
| 其他 | **409** `{"code":"context_mismatch"}`，客户端改发全量 |

409 是唯一的重试信号：会话被压缩、本服务重启、缓存过期，全都走这一条路，客户端不需要
自己判断「该不该发全量」。

---

## 配置

`config.json`（部署时放，不入库；模板见 `config.example.json`）：

```jsonc
{
  "port": 7865,
  "upstream": "http://workbuddy2api:7863",
  "max_body_mb": 64,
  "store": {
    "ttl_ms": 604800000,        // 7 天
    "max_bytes": 5242880,        // 单个会话上限，超了该会话不缓存（不影响别人）
    "max_total_bytes": 268435456,// 全部会话总量闸，超了 LRU 淘汰
    "models": { "cn:*": true, "global:*": false }
  }
}
```

- **单会话上限**：超过就不缓存这个会话，下次请求 409 → 全量，行为仍然正确
- **不设条数上限**：条数上限会在「会话最长、最需要增量」的时候把人打回全量，正好反着来
- **模型白名单**：精确匹配优先，其次只认尾部 `*` 的前缀通配；不写 = 不开

---

## 部署

```yaml
# docker-compose.yml
  ctx-relay:
    build: ./relay
    container_name: ctx-relay
    restart: unless-stopped
    volumes:
      - ./relay/config.json:/app/config.json:ro
    networks: [agent-mcp-net]
```

nginx 侧只新增一条路径，不影响现有的 `/`：

```nginx
location /v1c/ {
    proxy_pass http://ctx-relay:7865/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

客户端 base URL 改成 `https://<host>/v1c`。

---

## 观测

每个带 context 的请求打一行：

```
19:38:27 [relay] kicer:task-xxx delta=2 total=51 上传 3.1KB 省 196.9KB 缓存 1.2MB/256.00MB
```

`/health` 返回当前会话数与占用字节。

---

## 边界

- **内存态**：进程重启缓存即丢 → 一次全量重建，之后恢复增量
- **并发**：同一 `X-Context-Id` 串行（core 本来就串行，这把锁只防两个客户端同时打）
- **流式**：响应原样 `pipe`，不解析、不改帧、不缓冲
- **压缩**：等价于一次全量替换，无需特殊处理
