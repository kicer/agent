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
// 转写走上游的 OpenAI 兼容 /audio/transcriptions（任何平台都行）。上游三要素——key、base_url、
// model——一律由调用方随请求 header 带入，本容器不存任何平台密钥、也不认任何平台默认值。
// 音频一律先经 ffmpeg 归一化成 16kHz 单声道 wav：WebView 录出来是 webm/opus，iOS 是 mp4/aac，
// 上游只认 wav/mp3，归一化后两端都自由。
//
// 超长兜底：只有超过单次上限（默认 25s）才断开重发，切点尽量落在停顿上。
// 套壳是流式的（客户端已按停顿切好，一次请求就是一句话），所以这里多数请求不会被切；
// 真正用得上的是浏览器整段上传与 /mcp 转写已有长音频。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── 配置 ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);

// 上游参数逐请求带入（与 mcp/image_task 同构：密钥由调用方提供，服务端不保存）：
//   Authorization: Bearer <key>      ← 免鉴权的自建服务可省
//   X-ASR-Base-Url: https://.../v1
//   X-ASR-Model: whisper-1
// 为什么不留 env 兜底：两条来源会让「到底生效的是哪个 key」变成靠猜，而且密钥越少地方存越好
//（容器 env 用 docker inspect 就能看，config.yml 至少还受登录态保护）。
const HDR_AUTH = 'authorization';
const HDR_BASE = 'x-asr-base-url';
const HDR_MODEL = 'x-asr-model';
// 单次上传上限。60s 的 AAC 约 240KB、16k wav 约 1.9MB，20MB 是给长音频留的余量。
const MAX_BYTES = Math.max(1024 * 1024, Number(process.env.ASR_MAX_BYTES || 20 * 1024 * 1024));
// ── 超长兜底切分 ──────────────────────────────────────────────────────
// 谁需要它：套壳是流式的（客户端已经按停顿切好，每次请求就是一句话），
// 所以这里绝大多数请求都 ≤ 25s 直接一次送出去；真正用得上的只有
// 「浏览器整段上传」和「/mcp 转写已有长音频」——它们可能一次给几分钟。
// 切点尽量落在停顿上：硬切会把字劈成两半，而两段之间又没有上下文，接缝处的字就丢了。
// 0.5s 是句子边界：换气/想词的停顿通常 0.3~0.8s，而 0.5s 以下是词内间隔。
const PAUSE_SEC = Math.max(0.1, Number(process.env.ASR_PAUSE_SEC || 0.5));
// 判定为「没人说话」的音量门限：正常语音约 -20dB，安静房间底噪 -60dB 以下。
const SILENCE_DB = Number(process.env.ASR_SILENCE_DB || -35);
// 单段最短：避免最后切出一个没法识别的碎片（并进前一段）。
const MIN_SEG_SEC = Math.max(0, Number(process.env.ASR_MIN_SEG_SEC || 1));
// 单段最长（≈ 上游单次能吃的大致上限）：超过它就必须断开。
// 16k/16bit 单声道 wav 恒为 32000 B/s，所以用文件大小就能估时长，不用再起 ffprobe。
const CHUNK_SEC = Math.max(1, Number(process.env.ASR_MAX_CHUNK_SEC || 25));
// 切点搜索窗：只在「距上限还差这么多秒」的范围里找停顿。
// 不从头找是为了每段都尽量接近 25s——否则开头一个 2s 的停顿也会被拿来切，
// 段数无谓变多（请求开销远大于多切一刀的收益）。
const CUT_LOOKBACK_SEC = Math.max(0, Number(process.env.ASR_CUT_LOOKBACK_SEC || 6));
// 同时转写数：2 vCPU 上并发再高只会互相拖慢。
const MAX_CONCURRENT = Math.max(1, Number(process.env.ASR_MAX_CONCURRENT || 2));

const FFMPEG = String(process.env.FFMPEG_BIN || 'ffmpeg').trim();
const LOG_LEVEL = String(process.env.ASR_LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, none: 99 };

function log(level, msg) {
  if ((LEVELS[level] || 20) < (LEVELS[LOG_LEVEL] == null ? 20 : LEVELS[LOG_LEVEL])) return;
  console.log('[asr ' + level + '] ' + msg);
}

// 从请求 header 取上游三要素。Authorization 允许写成裸 key（自动补 Bearer），
// 省得用户还要记各平台前缀有没有写全。
function upstreamOf(req) {
  const h = (req && req.headers) || {};
  const raw = String(h[HDR_AUTH] || '').trim();
  return {
    auth: raw ? (/^bearer\s/i.test(raw) ? raw : 'Bearer ' + raw) : '',
    base: String(h[HDR_BASE] || '').trim().replace(/\/+$/, ''),
    model: String(h[HDR_MODEL] || '').trim(),
  };
}

// 缺参数直接 503：这是部署问题（config.yml 没配），不是用户输入问题——回 4xx 会让人以为音频坏了。
function assertUpstream(up) {
  const miss = !up.base ? 'X-ASR-Base-Url' : !up.model ? 'X-ASR-Model' : '';
  if (!miss) return;
  const e = new Error('语音识别未配置上游：config.yml 的 mcp_servers 里 asr 需要 headers.' + miss);
  e.status = 503;
  throw e;
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

// ── 停顿检测与切点规划 ─────────────────────────────────────────────────
// 用 ffmpeg 的 silencedetect 找静音区间：容器里本来就有 ffmpeg，它的判定也处理过
// 重采样/编码的各种边角，比自己扫 PCM 算 RMS 更省心（一次遍历，30s 音频约 50~150ms）。
// 返回 [{start,end}]（秒）。末尾那段一直静到文件结束的不会有 silence_end，直接丢掉——
// 尾巴不需要切。
function parseSilences(stderr) {
  const out = [];
  let cur = null;
  for (const line of String(stderr || '').split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { cur = { start: Number(s[1]), end: null }; out.push(cur); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && cur) { cur.end = Number(e[1]); cur = null; }
  }
  return out.filter((p) => p.end != null && p.end > p.start && p.start >= 0);
}

async function detectPauses(wavPath) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', wavPath,
    '-af', 'silencedetect=noise=' + SILENCE_DB + 'dB:d=' + PAUSE_SEC,
    '-f', 'null', '-',
  ], 60000);
  return parseSilences(r.stderr);
}

// 由「时长 + 静音区间」规划切点，返回 [0, c1, …, duration]。
// 贪心：每次只在「还没超上限」的范围内挑一个切点，因此段数最少（≈ 时长/CHUNK_SEC）。
// 只在最后 CUT_LOOKBACK_SEC 秒里找停顿；找不到就硬切到上限处。
function planCuts(duration, pauses) {
  const mids = pauses.map((p) => (p.start + p.end) / 2);
  const cuts = [0];
  let cur = 0;
  while (duration - cur > CHUNK_SEC) {
    const limit = cur + CHUNK_SEC;
    const floor = Math.max(cur + MIN_SEG_SEC, limit - CUT_LOOKBACK_SEC);
    let pick = 0;
    for (const t of mids) {
      if (t >= floor && t <= limit && t > pick) pick = t;   // 取窗口内最靠后的停顿中点
    }
    if (!pick) pick = limit;                                // 没有停顿：硬切
    // 别切出一个短于 MIN_SEG_SEC 的尾巴（如 25.6s 不该切成 25 + 0.6）：对半分
    if (duration - pick < MIN_SEG_SEC) pick = cur + (duration - cur) / 2;
    cuts.push(pick);
    cur = pick;
  }
  cuts.push(duration);
  return cuts;
}

// 按规划好的切点切片。16k/单声道/s16le 的 PCM 用 -c copy 无损切（不重编码）。
async function splitWav(wavPath, cuts) {
  const dir = path.dirname(wavPath);
  const base = path.basename(wavPath, '.wav');
  const parts = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const p = path.join(dir, base + '-part-' + String(i).padStart(3, '0') + '.wav');
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(cuts[i]), '-i', wavPath, '-t', String(cuts[i + 1] - cuts[i]),
      '-c', 'copy', p,
    ], 60000);
    parts.push(p);
  }
  return parts;
}

// 拼接各段文本：中文直接相连；两侧都是西文字母/数字时补一个空格，
// 否则英文句子被切开后会粘成 "helloworld"。
function joinText(parts) {
  let out = '';
  for (const s of parts) {
    if (!s) continue;
    if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(s)) out += ' ';
    out += s;
  }
  return out;
}

// ── 引擎 ──────────────────────────────────────────────────────────────────
function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj.text === 'string') return obj.text;
  if (obj.result && typeof obj.result.text === 'string') return obj.result.text;
  return '';
}

async function runCloud(wavPath, up) {
  assertUpstream(up);
  const buf = await fs.readFile(wavPath);
  const form = new FormData();
  form.append('model', up.model);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  let res;
  try {
    res = await fetch(up.base + '/audio/transcriptions', {
      method: 'POST',
      headers: up.auth ? { Authorization: up.auth } : {},
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
    // 上游对「这段里没人声」会回 200 + 空 text（如 glm-asr 的 {duration,text:"",usage}）。
    // 这是**正常结果**，不是故障：给 400 让上层只记一行 warn（5xx 才打堆栈），
    // 前端按「没识别到」处理、页面侧单段失败也会被跳过。
    const err = new Error('没有识别到语音内容（这段音频里没有可识别的人声）');
    err.status = 400;
    err.upstream = raw.slice(0, 300);
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
  const up = (opts && opts.up) || {};
  assertUpstream(up);
  const wavPath = await toWav(buf, opts && opts.ext);
  const parts = [];
  try {
    const st = await fs.stat(wavPath);
    const seconds = st.size / 32000; // 16k/单声道/16bit
    // 每次请求都打一行：原始字节 → 归一化时长。排查“上游说没声音”时第一眼看这个。
    log('info', '归一化：' + buf.length + 'B (' + ((opts && opts.ext) || '?') + ') → '
      + seconds.toFixed(1) + 's wav');

    // 只有超长才切：套壳是流式的，每次请求本来就是一�句话（1~5s），
    // 这里直接一次送出去，不用白白跑一趟 silencedetect。
    let cuts = [0, seconds];
    if (seconds > CHUNK_SEC) {
      const pauses = await detectPauses(wavPath).catch((e) => {
        log('warn', '静音检测失败，按 ' + CHUNK_SEC + 's 硬切：' + String(e && e.message || e).slice(0, 160));
        return [];
      });
      cuts = planCuts(seconds, pauses);
      if (cuts.length > 2) {
        parts.push(...await splitWav(wavPath, cuts));
        log('info', '超长切成 ' + parts.length + ' 段，切点 '
          + cuts.slice(1, -1).map((t) => t.toFixed(1) + 's').join(' / '));
      }
    }
    if (!parts.length) {
      try {
        return (await runCloud(wavPath, up)).trim();
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
    let firstErr = null;
    for (let i = 0; i < parts.length; i++) {
      const t0 = Date.now();
      const range = cuts[i].toFixed(1) + '–' + cuts[i + 1].toFixed(1) + 's';
      // 每段独立识别；单段失败不连累其他段（长录音里偶发静音段常见）
      try {
        const text = (await runCloud(parts[i], up)).trim();
        log('info', '  part ' + (i + 1) + '/' + parts.length + ' ' + range + ' → '
          + text.length + ' 字 / ' + (Date.now() - t0) + 'ms');
        out.push(text);
      } catch (e) {
        if (!firstErr) firstErr = e;
        log('warn', '  part ' + (i + 1) + '/' + parts.length + ' ' + range
          + ' 识别失败（跳过）：' + String(e && e.message || e).slice(0, 200));
      }
    }
    // 全部失败才报错：否则前端只会看到 200 + 空文本，分不清是「没说话」还是「上游挂了」。
    // 部分失败保持静默降级（长录音里某一段坏了不该连坐）。
    if (!out.length && firstErr) throw firstErr;
    return joinText(out);
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
  // 先判配置再读 body：没配上游时不必白读 20MB
  const up = upstreamOf(req);
  assertUpstream(up);
  const buf = await readBody(req, MAX_BYTES);
  if (!buf.length) return json(res, 400, { error: '未收到音频数据' });

  active++;
  const t0 = Date.now();
  try {
    const text = await transcribeBuffer(buf, { ext: extOf(req.headers['content-type']), up });
    log('info', 'transcribed ' + buf.length + 'B → ' + text.length + ' 字，' + (Date.now() - t0) + 'ms');
    json(res, 200, { text, ms: Date.now() - t0, model: up.model });
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
      const text = await transcribeBuffer(buf, { ext, up: upstreamOf(req) });
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
    // 无状态服务：健康 = 进程活着。上游参数逐请求带入，没有全局「configured」可言。
    return json(res, 200, { ok: true, service: 'asr' });
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
  log('info', 'listening on ' + PORT + '（上游 key/base_url/model 由调用方随请求 header 带入）');
});
