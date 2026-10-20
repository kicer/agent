// 业务时区单一入口：日记 day、定时任务 cron、存量迁移统一从这里取。
// Dockerfile/compose 的 TZ 只负责进程默认本地时区（日志、文件名、部分统计、第三方工具）；
// 业务语义（day/cron）显式固定上海，不随部署环境或 TZ 覆盖漂移。
// 上海无夏令时：fmtIso 的 +08:00 是安全偏移；Intl 仍用 IANA 时区名。
const TZ = 'Asia/Shanghai';

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // en-CA = ISO 'YYYY-MM-DD'
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const isoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function dayString(ms) { return dayFmt.format(new Date(Number(ms) || Date.now())); }

// 'YYYY-MM-DD HH:MM:SS'（上海时区）；脏/空值返 ''，由调用方退回只显示 day。
function stampString(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return dayFmt.format(d) + ' ' + timeFmt.format(d);
}

function fmtTime(t) {
  return new Date(t).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
}

// ISO 带时区偏移串（schedule 工具回执用）：上海无夏令时，固定 +08:00 安全；
// formatToParts 逐件拼接，不依赖 ICU 区域格式串形状；h23 保证零点为 00:00:00 而非 24 点。
function fmtIso(t) {
  if (!t) return '';
  const p = {};
  const parts = isoFmt.formatToParts(new Date(t));
  for (const { type, value } of parts) p[type] = value;
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + '+08:00';
}

module.exports = { TZ, dayString, stampString, fmtTime, fmtIso };
