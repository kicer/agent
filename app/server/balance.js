// 余额查询适配器:按 platform.type 分发(先只接 deepseek)。
// routes/platforms.js 用它执行查询;routes/config.js 把已接入类型列表(types)返给前端,
// 前端据此决定分组要不要显示余额行(未接入类型不显示,避免自动查询刷一堆「不支持」)。
// 新平台类型:在 ADAPTERS 加一项即可。

// 上游根地址:去掉尾部斜杠与 /v1 后缀。
// 例:https://api.deepseek.com/v1 → https://api.deepseek.com(余额端点在站点根,不在 /v1 下)。
function rootOf(url) {
  return String(url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
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
};

module.exports = { ADAPTERS, types: () => Object.keys(ADAPTERS) };
