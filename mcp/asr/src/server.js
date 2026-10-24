#!/usr/bin/env node
// ASR（语音转文字）服务。一个进程两个入口，共用同一套转写实现：
//
//   POST /transcribe  普通 HTTP —— 给 agent-core 的输入框用：录完音直接拿文字，
//                     不经过模型、不花 token、延迟 1~3s。
//   POST /mcp         Streamable HTTP MCP —— 工具 transcribe_audio({url})，给模型转写
//                     会话目录里的音频（本地文件先 mint_public_link 换公网短链，与 video_task 同构）。
//
// 为什么不直接用 MCP 工具做语音输入：MCP 是模型协议，走一次工具调用要多一轮模型往返
//（3~10s + token），识别结果还会落进聊天记录而不是输入框，用户没法改错字。输入法级别的
// 功能必须绕开模型。
//
// 为什么零依赖（不用 express / MCP SDK）：core 的 MCP 客户端只发 initialize / tools/list /
// tools/call 三种请求，手写这几十行 JSON-RPC 就够；本机内存只有 2G，省掉 SDK 与 express
// 的常驻开销（本服务空载约 35MB）。
//
// 转写走上游的 OpenAI 兼容 /audio/transcriptions（默认智谱 glm-asr，换平台改 env 即可）。
// 音频一律先经 ffmpeg 归一化成 16kHz 单声道 wav：WebView 录出来是 webm/opus，iOS 是 mp4/aac，
// 上游只认 wav/mp3，归一化后两端都自由。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── 配置（全部走 env，不读 config.yml：本容器按仓库惯例只拿 env） ──────────────
const PORT = Number(process.env.PORT || 3000);

// 上游：任何 OpenAI 兼容的 /audio/transcriptions（智谱 glm-asr、OpenAI whisper-1 等）
const API_BASE = String(process.env.ASR_API_BASE || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/+$/, '');
const API_KEY = String(process.env.ASR_API_KEY || '').trim();
const API_MODEL = String(process.env.ASR_MODEL || 'glm-asr').trim();
// 单次上传上限。60s 的 AAC 约 240KB、16k wav 约 1.9MB，20MB 是给长音频留的余量。
const MAX_BYTES = Math.max(1024 * 1024, Number(process.env.ASR_MAX_BYTES || 20 * 1024 * 1024));
// 云端多数 ASR 单次只吃 ~30s：超长音频按这个秒数切片后逐段识别再拼接（0 = 不切）。
// 16k/16bit 单声道 wav 恒为 32000 B/s，所以用文件大小就能估时长，不用再起 ffprobe。
const CHUNK_SEC = Math.max(0, Number(process.env.ASR_MAX_CHUNK_SEC || 25));
// 同时转写数：2 vCPU 上并发再高只会互相拖慢。
const MAX_CONCURRENT = Math.max(1, Number(process.env.ASR_MAX_CONCURRENT || 2));

const FFMPEG = String(process.env.FFMPEG_BIN || 'ffmpeg').trim();
const LOG_LEVEL = String(process.env.ASR_LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, none: 99 };

function log(level, msg) {
  if ((LEVELS[level] || 20) < (LEVELS[LOG_LEVEL] == null ? 20 : LEVELS[LOG_LEVEL])) return;
  console.log('[asr ' + level + '] ' + msg);
}

// ── 子进程：统一超时 + 收 stdout/stderr ────────────────────────────────────
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      reject(new Error(cmd + ' 超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e); // ENOENT：二进制没装（如没装 ffmpeg）
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(cmd + ' 退出码 ' + code + '：' + ((err || out).slice(-400) || '无输出')));
    });
  });
}

// ── 音频：归一化成 16k 单声道 wav（再把超长音频切片） ───────────────────────
async function toWav(buf, ext) {
  const id = randomUUID();
  const inPath = path.join(os.tmpdir(), 'asr-in-' + id + (ext ? '.' + ext : ''));
  const wavPath = path.join(os.tmpdir(), 'asr-out-' + id + '.wav');
  try {
    await fs.writeFile(inPath, buf);
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
      wavPath,
    ], 60000);
    return wavPath;
  } catch (e) {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(wavPath, { force: true }).catch(() => {});
    // ffmpeg 的 stderr 很有用（定位是封装不对还是文件截断），但只进日志——
    // 回给前端的长英文堆栈对用户毫无意义，toast 里只会显示第一行。
    log('warn', '音频解码失败：' + String(e && e.message || e));
    const err = new Error('音频解码失败（格式不支持或文件损坏）');
    err.status = 400;
    throw err;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
  }
}

// 按秒切片：只在超过 CHUNK_SEC 时做。切片用 -c copy，纯 PCM 无损。
async function splitWav(wavPath, chunkSec) {
  const dir = path.dirname(wavPath);
  const base = path.basename(wavPath, '.wav');
  const pattern = path.join(dir, base + '-part-%03d.wav');
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath,
    '-f', 'segment', '-segment_time', String(chunkSec), '-c', 'copy',
    pattern,
  ], 60000);
  const files = (await fs.readdir(dir))
    .filter((f) => f.startsWith(base + '-part-') && f.endsWith('.wav'))
    .sort();
  return files.map((f) => path.join(dir, f));
}

// ── 引擎 ──────────────────────────────────────────────────────────────────
function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj.text === 'string') return obj.text;
  if (obj.result && typeof obj.result.text === 'string') return obj.result.text;
  return '';
}

async function runCloud(wavPath) {
  if (!API_KEY) {
    const e = new Error('语音识别未配置：容器环境变量 ASR_API_KEY 为空');
    e.status = 503;
    throw e;
  }
  const buf = await fs.readFile(wavPath);
  const form = new FormData();
  form.append('model', API_MODEL);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  let res;
  try {
    res = await fetch(API_BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + API_KEY },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    const err = new Error('调用上游语音识别失败：' + String(e && e.message || e));
    err.status = 502;
    throw err;
  }
  const raw = await res.text();
  if (!res.ok) {
    // 智谱对“解码后没有可识别语音”的音频回 400/1210 no audio segment found。
    // 这通常不是服务故障（录音是静音、或浏览器只录到空白），给一句人话，别把上游 JSON 丢给用户。
    let upstreamMsg = raw.slice(0, 300);
    let upstreamCode = '';
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.error) {
        upstreamMsg = String(obj.error.message || upstreamMsg);
        upstreamCode = String(obj.error.code || '');
      }
    } catch (_) { /* 非 JSON，保留原文 */ }
    const noSpeech = /no audio segment/i.test(upstreamMsg) || upstreamCode === '1210';
    const err = new Error(noSpeech
      ? '没有识别到语音内容（录到的是静音，或音频解码后为空）'
      : '上游识别失败 HTTP ' + res.status + '：' + upstreamMsg);
    err.status = noSpeech ? 400 : 502;
    err.upstream = upstreamMsg;
    throw err;
  }
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) { return raw.trim(); }
  const text = extractText(obj);
  if (!text) {
    const err = new Error('上游返回为空：' + raw.slice(0, 300));
    err.status = 502;
    throw err;
  }
  return text;
}

// 归一化后 wav 的实测音量（仅 debug 级别调用）：用于区分“文件坏了”和“录到的是静音”。
// volumedetect 跟解码共用一次遍历，开销很小，但只在排查时跑。
async function wavLevel(wavPath) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-',
  ], 30000);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return (mean ? mean[1] : '?') + ' / ' + (max ? max[1] : '?') + ' dB';
}

// 转写一段音频缓冲：归一化 →（超长则切片）→ 逐段识别 → 拼接。
async function transcribeBuffer(buf, opts) {
  const wavPath = await toWav(buf, opts && opts.ext);
  const parts = [];
  try {
    const st = await fs.stat(wavPath);
    const seconds = st.size / 32000; // 16k/单声道/16bit
    // 每次请求都打一行：原始字节 → 归一化时长。排查“上游说没声音”时第一眼看这个。
    log('info', '归一化：' + buf.length + 'B (' + ((opts && opts.ext) || '?') + ') → '
      + seconds.toFixed(1) + 's wav');
    if (CHUNK_SEC > 0 && seconds > CHUNK_SEC * 1.2) {
      parts.push(...await splitWav(wavPath, CHUNK_SEC));
      log('info', '超长音频切成 ' + parts.length + ' 段');
    }
    if (!parts.length) {
      try {
        return (await runCloud(wavPath)).trim();
      } catch (e) {
        // 只在上游判定“没有语音”时量一遍音量（正常路径零开销）：
        // 静音是 -91dB，正常语音 -20dB 上下，一眼就能分清是设备没收到声还是文件坏了。
        if (e && e.status === 400) {
          log('warn', '音量(mean/max): ' + await wavLevel(wavPath).catch(() => '?'));
        }
        throw e;
      }
    }

    const out = [];
    for (const p of parts) {
      // 每段独立识别；单段失败不连累其他段（长录音里偶发静音段常见）
      try {
        out.push((await runCloud(p)).trim());
      } catch (e) {
        log('warn', '切片识别失败（跳过）：' + String(e && e.message || e).slice(0, 200));
      }
    }
    return out.filter(Boolean).join('');
  } finally {
    await fs.rm(wavPath, { force: true }).catch(() => {});
    for (const p of parts) await fs.rm(p, { force: true }).catch(() => {});
  }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────
function json(res, code, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      n += c.length;
      if (n > limit) {
        failed = true;
        const e = new Error('音频过大（上限 ' + Math.round(limit / 1048576) + 'MB）');
        e.status = 413;
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

const EXT_BY_MIME = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/amr': 'amr',
};

function extOf(contentType) {
  const k = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[k] || '';
}

// ── 入口 1：POST /transcribe（普通 HTTP，给输入框） ────────────────────────
let active = 0;

async function handleTranscribe(req, res, url) {
  if (active >= MAX_CONCURRENT) {
    return json(res, 429, { error: '语音识别繁忙，请稍后再试' });
  }
  const buf = await readBody(req, MAX_BYTES);
  if (!buf.length) return json(res, 400, { error: '未收到音频数据' });

  active++;
  const t0 = Date.now();
  try {
    const text = await transcribeBuffer(buf, { ext: extOf(req.headers['content-type']) });
    log('info', 'transcribed ' + buf.length + 'B → ' + text.length + ' 字，' + (Date.now() - t0) + 'ms');
    json(res, 200, { text, ms: Date.now() - t0, model: API_MODEL });
  } finally {
    active--;
  }
}

// ── 入口 2：POST /mcp（Streamable HTTP，给模型） ──────────────────────────
const TOOL = {
  name: 'transcribe_audio',
  description:
    'Transcribe an audio file to text. Provide a publicly reachable http(s) URL '
    + '(mp3 / wav / m4a / webm / ogg / aac / flac, <= 20MB). '
    + 'For a file inside the current task directory, first call the built-in mint_public_link tool '
    + 'to get a temporary public URL, then pass that URL here.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Publicly reachable http(s) URL of the audio file.' },
    },
    required: ['url'],
  },
};

async function fetchAudio(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new Error('url 不是合法链接'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http(s) 链接');
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('下载音频失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到的音频为空');
  if (buf.length > MAX_BYTES) throw new Error('音频过大（上限 ' + Math.round(MAX_BYTES / 1048576) + 'MB）');
  return { buf, ext: extOf(res.headers.get('content-type')) };
}

async function handleMcp(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); } catch (_) {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};
  const ok = (result) => json(res, 200, { jsonrpc: '2.0', id, result });
  const fail = (code, message) => json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return ok({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'asr', version: '1.0.0' },
    });
  }
  // 无状态实现：不返回 Mcp-Session-Id，core 也就不会带；通知直接回空结果（core 不校验）。
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return ok({});
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: [TOOL] });

  if (method === 'tools/call') {
    if (params.name !== TOOL.name) return fail(-32602, 'Unknown tool: ' + params.name);
    const args = params.arguments || {};
    const urlStr = String(args.url || '').trim();
    if (!urlStr) return ok({ isError: true, content: [{ type: 'text', text: '缺少 url 参数' }] });
    try {
      const { buf, ext } = await fetchAudio(urlStr);
      const text = await transcribeBuffer(buf, { ext });
      return ok({ content: [{ type: 'text', text }] });
    } catch (e) {
      return ok({ isError: true, content: [{ type: 'text', text: '转写失败：' + String(e && e.message || e) }] });
    }
  }

  return fail(-32601, 'Method not found: ' + method);
}

// ── 服务 ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) {
    return json(res, 400, { error: 'bad url' });
  }
  const done = (p) => {
    Promise.resolve(p).catch((e) => {
      const code = (e && e.status) || 500;
      // 4xx 是可预期的输入问题（坏音频、没配 key），只记一行；5xx 才带堆栈
      log(code >= 500 ? 'error' : 'warn', String(e && e.message || e) + (code >= 500 && e && e.stack ? '\n' + e.stack : ''));
      if (!res.headersSent) json(res, code, { error: String(e && e.message || e) });
      else try { res.end(); } catch (_) { /* 已断 */ }
    });
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      model: API_MODEL,
      configured: !!API_KEY,
    });
  }
  if (req.method === 'POST' && url.pathname === '/transcribe') return done(handleTranscribe(req, res, url));
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') return json(res, 405, { error: 'only POST /mcp' });
    return done(handleMcp(req, res));
  }
  return json(res, 404, { error: 'not found' });
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', '收到 ' + sig + '，退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'listening on ' + PORT + '，model=' + API_MODEL + ' @ ' + API_BASE);
  if (!API_KEY) log('warn', 'ASR_API_KEY 为空：/transcribe 会返回 503');
});
