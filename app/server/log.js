// 统一日志接口:log.debug/info/warn/error(category, ...args)
// 输出格式:<timestamp> [<level>] [<category>] <args...>
// category 作为该条日志的标签(原 "[xxx]" 前缀的独立参数化版本),便于日志分类/过滤。
// 等级阈值由 config.yml 的 log_level 控制(debug < info < warn < error),
// 只有 消息等级 >= 阈值 才输出;配成 none(或 off)则全部静默,含 error。
// 启动时 server.js 调 setLevel(cfg.log_level) 注入;改配置需重启生效(与其他配置一致,无热重载)。
// 约定:关键动作 info;可预期的异常状况 warn;未预期异常 error;排查细节 debug。
// Error 对象等原生参数透传给 console 走 util.format,不会被字符串化。
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
  // 第一个参数固定为 category(允许为空串但不建议);其余原样透传 console
  const category = String(args[0] == null ? '' : args[0]);
  const rest = Array.prototype.slice.call(args, 1);
  const head = stamp() + ' [' + level + '] [' + category + ']';
  if (typeof rest[0] === 'string') rest[0] = head + ' ' + rest[0];
  else rest.unshift(head);
  fn.apply(console, rest);
}

module.exports = {
  setLevel,
  isDebugEnabled() { return LEVELS.debug >= threshold; },
  debug() { emit(console.log, 'debug', arguments); },
  info() { emit(console.log, 'info', arguments); },
  warn() { emit(console.warn, 'warn', arguments); },
  error() { emit(console.error, 'error', arguments); },
};