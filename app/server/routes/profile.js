// 用户画像 API（账户设置 → 用户画像）：读写均按登录用户隔离（req.user 由认证中间件挂上，
// 不信客户端传的 user）。未启用认证时 req.user 为空 = 空串键的隐式单用户（与 sessions.user 同语义）。
const express = require('express');
const engine = require('../engine');
const profile = require('../user-profile');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const user = String(req.user || '');
    res.json(Object.assign({ user }, profile.getProfile(engine.getDb(), user)));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

router.put('/', (req, res) => {
  try {
    const db = engine.getDb();
    const user = String(req.user || '');
    const patch = profile.sanitizePatch(req.body);
    profile.saveProfile(db, user, patch);
    // 停用画像时顺带清掉现存会话的快照（本会话内即不再注入；重新启用只影响新会话/清空后的会话）
    if (patch.enabled === false) {
      db.prepare("UPDATE sessions SET profile_snapshot = '' WHERE user = ? AND profile_snapshot != ''").run(user);
    }
    res.json({ ok: true, profile: profile.getProfile(db, user) });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

module.exports = router;
