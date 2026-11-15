# tunnel · 通用反向隧道

把本机（家里）的 HTTP 服务，经一台有公网 IP 的服务器中转出去。对访问方**完全透明**——
浏览器看到的仍是标准 HTTP/SSE，服务本身不需要任何改造。

```
手机/浏览器 ──https──> nginx:443 ──> server.js ──WebSocket──> client.js ──> 127.0.0.1:<port>
                                       (服务器)                  (家里)
```

- **server.js** 不认识任何业务：只按 `Host` 头（或固定端口）把字节搬给 client
- **client.js** 按 `services` 配置把请求映射到本地端口
- 新增服务 = 改 client 配置一行，**两边代码都不用动**

## 启动顺序

没有严格要求。client 连不上会 1s→30s 指数退避重连，先起谁都能自动接上。
第一次配置建议先起 server，日志会直接告诉你 client 是否连上、token 对不对。

## 快速验证（本机，不碰 nginx）

```bash
cd tunnel && npm install                # 国内慢就加 --registry=https://registry.npmmirror.com
cp client.example.yml client.yml        # server 改成 ws://127.0.0.1:19000/tunnel，token 先留空
node server.js &                        # 首次启动生成 server.yml，日志打印 TOKEN
# 把 TOKEN 填进 client.yml 的 token，再：
node client.js &
curl -H "Host: agent.home.example.com" http://127.0.0.1:19000/api/health
curl -s http://127.0.0.1:19000/__tunnel/health     # {"ok":true,"client":"online",...}
```

## 服务器部署

```bash
cd tunnel
docker compose up -d
docker compose logs | grep TOKEN        # 首次启动自动生成，记下来填到家里 client.yml
```

**不需要先写配置**：首次启动会自动生成 `./data/server.yml`，里面带一个随机 token 并打印到日志。
第二次启动直接复用，token 不会变。

裸跑也行（不写配置同样自动生成）：

```bash
node server.js                         # 配置落在 ./server.yml
TUNNEL_CONFIG=/path/to/server.yml node server.js
```

## 请求怎么找到对应的服务

一台服务器、一个端口，请求进来后要决定「这个请求是给 agent 还是给 NAS」。三种做法：

### 1. 看域名（有域名时最自然）

```
agent.home.example.com  → 家里 8090
nas.home.example.com    → 家里 5000
```

隧道读请求里的 `Host` 头决定转发给谁。配置就是 `client.yml` 的 `host` 字段：

```yaml
services:
  - host: agent.home.example.com
    port: 8090
```

需要 DNS 泛解析 `*.home.example.com` 指到服务器，前面再套一层 nginx 做 TLS。

### 2. 一个端口钉一个服务（没有域名，又要多个服务）

隧道同时监听好几个端口，每个端口只认一个服务名：

```
http://<服务器IP>:19001  → 固定给 agent
http://<服务器IP>:19002  → 固定给 NAS
```

`server.yml` 声明端口归属：

```yaml
routes:
  - port: 19001
    service: agent
  - port: 19002
    service: nas
```

`client.yml` 用 `name` 对上：

```yaml
services:
  - name: agent
    port: 8090
  - name: nas
    port: 5000
```

`docker-compose.yml` 里把 19001/19002 的 `ports` 放开。**完全不看 Host 头**。

### 3. 一个端口 + 通配（没有域名，只有一个服务）

最简单：所有请求都给同一个服务。

```yaml
services:
  - host: "*"
    port: 8090
```

浏览器开 `http://<服务器IP>:19000` 就是它。

### 怎么选

| 你的情况 | 用哪个 |
|---|---|
| 有域名 | 方式 1 |
| 没域名，只暴露一个服务 | 方式 3（一行配置） |
| 没域名，要暴露多个服务 | 方式 2（一个服务一个端口） |

方式 1 和 2 **可以同时开**：19000 走 Host 路由，19001/19002 各钉死一个服务，互不干扰。

## 家里部署

```bash
node client.js                    # 读同目录 client.yml
node client.js /path/to/client.yml
```

```yaml
server: "wss://agent.home.example.com/tunnel"
token: "<和服务器同一个>"
userAgent: "Mozilla/5.0 (...) Chrome/131.0.0.0 Safari/537.36"
services:
  - name: agent
    host: agent.home.example.com
    port: 8090
```

- `name`：固定端口路由用的服务标识（有域名时可省略）
- `host`：`域名` / `*.example.com` / `"*"`（兜底）
- `userAgent`：可选，握手时伪装浏览器 UA，降低被 DPI 盯上的概率
- 断线自动重连，启动时自检每个端口可达性（不可达只告警不退出）

## 隧道协议

一条 WebSocket 承载所有请求，用 `id` 多路复用。

```jsonc
// 服务器 → 家里
{"id":"r1","op":"req","method":"POST","path":"/api/x","headers":{...},"service":"agent"}
{"id":"r1","op":"body","b64":"..."}          // 请求体分帧
{"id":"r1","op":"end"}
{"id":"r1","op":"abort"}                     // 浏览器提前断开

// 家里 → 服务器（响应分帧，边收边转）
{"id":"r1","ev":"head","status":200,"headers":{...}}
{"id":"r1","ev":"data","b64":"..."}
{"id":"r1","ev":"end"}
{"id":"r1","ev":"error","msg":"..."}
```

`service` 只在「固定端口路由」时出现；没有它 client 就按 Host 头匹配。

## 已知边界

| 能力 | 状态 |
|---|---|
| 普通 HTTP / 大 body（测过 27 MB） | ✅ |
| SSE / 流式响应 | ✅ 逐帧透传（800ms/帧测试，间隔与直连一致） |
| 重定向（302） | ✅ 原样透传，不在隧道里跟跳 |
| 未知 Host | 502 |
| client 离线 | 503（快速失败，不挂住） |
| 固定端口路由 / `*` 通配 | ✅ |
| **WebSocket 升级** | ❌ 未实现（需双向字节流，二期） |
| HTTP/2 | ❌ 对外仍是 1.1，影响不大 |

## 排错

```bash
curl -s http://127.0.0.1:19000/__tunnel/health    # client 在不在线
tail -f /tmp/tunnel-client.log                     # 家里端
tail -f /tmp/tunnel-server.log                     # 服务器端
```

- **502 没有匹配的本地服务**：`services[].host` 和请求 Host 不一致；无域名时用 `"*"` 或固定端口
- **SSE 憋着不出来**：nginx 少了 `proxy_buffering off`
- **大 body 报 `expect header not supported`**：旧版本才有，client 现在会剥掉 `Expect` 头
- **握手 401**：两边 token 不一致
