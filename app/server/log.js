// 统一日志接口:log.debug/info/warn/error(...),所有输出自带本地时间戳。
// 等级阈值由 config.yml 的 log_level 控制(debug < info < warn < error),
// 只有 消息等级 >= 阈值 才输出;配成 none(或 off)则全部静默,含 error。
// 启动时 server.js 调 setLevel(cfg.log_level) 注入;改配置需重启生效(与其他配置一致,无热重载)。
// 约定:关键动作 info;可预期的异常状况 warn;未预期异常 error;排查细节 debug。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

function setLevel(l) {
  const s = String(l || 'info').trim().toLowerCase();
  if (s === 'none' || s === 'off') threshold = Infinity;
  else threshold = LEVELS[s] == null ? LEVELS.info : LEVELS[s];
}

const pad = (n, w) => String(n).padStart(w || 2, '0');
function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function emit(fn, level, args) {
  if (LEVELS[level] < threshold) return;
  // 时间戳并入首个字符串参数:不影响 %s 占位符,后续参数(含 Error 对象)保持原生格式化
  if (typeof args[0] === 'string') args[0] = stamp() + ' ' + args[0];
  else args.unshift(stamp());
  fn.apply(console, args);
}

module.exports = {
  setLevel,
  debug() { emit(console.log, 'debug', arguments); },
  info() { emit(console.log, 'info', arguments); },
  warn() { emit(console.warn, 'warn', arguments); },
  error() { emit(console.error, 'error', arguments); },
};
