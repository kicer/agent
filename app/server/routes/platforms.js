// 平台级 API:余额查询。按 platform.type 分发适配器(适配器见 ../balance.js)。
// 余额由「平台名 + Key」槽位决定,故用有效配置下标 pi/ki 定位;上游调用实时代理,不落库不缓存。
// 注意:这里用 engine.getConfig() 的原始配置(真 api_key),与 GET /api/config 的脱敏视图无关。
const express = require('express');
const engine = require('../engine');
const { ADAPTERS } = require('../balance');

const router = express.Router();

router.get('/balance', async (req, res) => {
  try {
    const cfg = engine.getConfig();
    const pi = parseInt(req.query.pi, 10);
    const ki = parseInt(req.query.ki, 10);
    const p = (cfg.platforms || [])[pi];
    const k = p ? (p.keys || [])[ki] : null;
    if (!p || !k) return res.status(404).json({ error: '平台/Key 不存在(配置可能已改,刷新页面后重试)' });
    const type = String(p.type || '').trim();
    const fn = ADAPTERS[type];
    if (!fn) return res.status(400).json({ error: '类型「' + (type || '未设置') + '」暂未接入余额查询' });
    if (!k.api_key) return res.status(400).json({ error: '该 Key 未配置 api_key,无法查询' });
    const balance = await fn(p, k);
    res.json({ ok: true, type, platform: p.name, balance });
  } catch (e) {
    const msg = String(e && e.message || e);
    // 只回传摘要,api_key 理论上不会出现在异常里,双保险兜底
    res.status(502).json({ error: msg.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300) });
  }
});

module.exports = router;
