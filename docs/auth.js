// 认证与授权中间件
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'xiaocai-secret-2024';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: '未登录' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: '登录已过期' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可执行此操作' });
  next();
}

module.exports = { authMiddleware, adminOnly, JWT_SECRET };
