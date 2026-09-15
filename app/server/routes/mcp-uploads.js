// MCP 上传文件的公网只读中转（agent-core 侧）。
//
// 为什么需要这一层：
//   无域名部署时对外只开 agent-core 一个端口（AGENT_PORT，默认 8090）。但 video_gen 的
//   /uploads/<file> 那一跳是【智谱的服务器】去拉的 —— 它不带 cookie、不带 Authorization，
//   必须是公网匿名可达。而 video_gen 自己不该占一个公网端口（那样它的 POST /upload 也会一起
//   暴露，写入口就跑到公网上了）。所以由 core 代拉：智谱拿到的地址是
//     http://<服务器IP>:<AGENT_PORT>/mcp-uploads/uploads/<file>
//   这一跳只读、只走 video_gen 的【只读监听】(容器内 3001)，写路径永远不经公网。
//
// 安全边界（改这里务必保持）：
//   1. 只转发 GET/HEAD，其余方法一律 405：POST /upload 不可能从这个路由穿过去。
//   2. 上游固定为 video_gen 的只读监听（PUBLIC_PORT），那边压根没有 /upload 路由（纵深防御）。
//   3. 文件名只放行 video_gen 生成的形态（randomUUID + 可选后缀），挡住目录穿越与探测。
//   4. 本路由挂在 auth.middleware 之前（智谱不带凭据），因此是【匿名可读】的。
//      它等同于"随机文件名 + 有 TTL"的能力链接：不要在这里挂任何敏感或可枚举的东西。
'use strict';

const http = require('http');
const https = require('https');
const express = require('express');
const log = require('../log');

// video_gen 的文件名：randomUUID() + 可选扩展名（见 mcp/video_gen/src/mcp-server.js 的 multer storage）
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// 只透传与"取文件"有关的响应头，避免把上游的协商/凭据类头部带出去
const PASS_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag', 'accept-ranges', 'content-range'];

// target 形如 http://mcp_video_gen:3001（环境变量 MCP_UPLOADS_URL）
function createRouter(target, options) {
  const timeoutMs = (options && options.timeout_ms) || 30000;
  const router = express.Router();
  const base = new URL(target);
  const client = base.protocol === 'https:' ? https : http;
  const basePath = base.pathname.replace(/\/+$/, '');

  function relay(req, res) {
    const file = req.params.file;
    if (!FILE_RE.test(file) || file.includes('..')) {
      return res.status(400).json({ error: 'bad file name' });
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range; // 大图/视频拖动时支持分片

    const up = client.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path: basePath + '/uploads/' + encodeURIComponent(file),
      headers,
    }, (upRes) => {
      for (const h of PASS_HEADERS) {
        if (upRes.headers[h] !== undefined) res.setHeader(h, upRes.headers[h]);
      }
      res.status(upRes.statusCode || 502);
      upRes.pipe(res);
    });

    up.setTimeout(timeoutMs, () => up.destroy(new Error('upstream timeout')));
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      // 只说地址不通，不把上游内部细节吐给公网
      log.warn('mcp-uploads', '中转失败 ' + file + ': ' + err.message);
      res.status(502).json({ error: 'upstream unavailable' });
    });
    req.pipe(up);
  }

  router.get('/uploads/:file', relay);
  router.head('/uploads/:file', relay);

  // 其余方法/路径一律就地回掉，别落到后面的登录中间件上（那样智谱会拿到 401 页面而不是 404）
  router.use((req, res) => {
    if (/^\/uploads\/[^/]+$/.test(req.path)) {
      res.set('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'method not allowed' });
    }
    res.status(404).json({ error: 'not found' });
  });

  return router;
}

module.exports = { createRouter };
