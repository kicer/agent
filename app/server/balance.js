// 余额查询适配器:按 platform.type 分发(已接 deepseek、bigmodel)。
// routes/platforms.js 用它执行查询;routes/config.js 把已接入类型列表(types)返给前端,
// 前端据此决定分组要不要显示余额行(未接入类型不显示,避免自动查询刷一堆「不支持」)。
// 新平台类型:在 ADAPTERS 加一项即可。

// 上游根地址:去掉尾部斜杠与 /v1 后缀。
// 例:https://api.deepseek.com/v1 → https://api.deepseek.com(余额端点在站点根,不在 /v1 下)。
function rootOf(url) {
  return String(url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

// 金额统一保留 2 位小数(上游多带长尾零,渲染更整齐;空值归零)。
function money(v) {
  return (Number(v) || 0).toFixed(2);
}

const ADAPTERS = {
  deepseek: async (p, k) => {
    const res = await fetch(rootOf(p.url) + '/user/balance', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + k.api_key },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* 非 JSON 按失败处理 */ }
    if (!res.ok || !j) throw new Error('上游返回 HTTP ' + res.status + ' ' + text.slice(0, 200));
    const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
    const sum = f => infos.reduce((s, b) => s + (Number(b[f]) || 0), 0).toFixed(2);
    return {
      is_available: !!j.is_available,
      currency: infos.length ? String(infos[0].currency || '') : '',
      total_balance: sum('total_balance'),
      granted_balance: sum('granted_balance'),
      topped_up_balance: sum('topped_up_balance'),
    };
  },
  // 智谱 bigmodel:GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report
  // 余额端点是站点绝对路径,不与 /v1 兼容端点共 host 协议,直接写死避开 p.url。
  // 成功判据 code===200 && success===true;失败回传 msg 便于排查。
  // data.balance = 总余额(充值+赠送);rechargeAmount/giveAmount 分别记录;availableBalance 为可用部分。
  bigmodel: async (p, k) => {
    const res = await fetch('https://www.bigmodel.cn/api/biz/account/query-customer-account-report', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + k.api_key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* 非 JSON 按失败处理 */ }
    if (!res.ok || !j) throw new Error('上游返回 HTTP ' + res.status + ' ' + text.slice(0, 200));
    if (!j.success || j.code !== 200) throw new Error('查询失败: ' + (j.msg || ('HTTP ' + res.status)));
    const d = j.data || {};
    // creditStatus = NOT_OPEN 时信用字段为 null,availableCreditBalance 同理;
    // 仅在有信用额度时计入 total_balance,否则仅展示现金余额。
    const hasCredit = d.creditStatus && d.creditStatus !== 'NOT_OPEN' && d.creditBalance != null;
    const total = Number(d.balance || 0) + (hasCredit ? Number(d.creditBalance || 0) : 0);
    return {
      is_available: true,
      currency: 'CNY',
      total_balance: money(total),
      granted_balance: money(d.giveAmount),
      topped_up_balance: money(d.rechargeAmount),
    };
  },
};

module.exports = { ADAPTERS, types: () => Object.keys(ADAPTERS) };
