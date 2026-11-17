'use strict';
// 实例标识：跨 core 隔离用，作 relay 的 X-Context-Id 前缀。
// 首次启动生成并落盘到 <data_root>/instance-id，之后只读同一个值。
// 删了数据目录会换新 id —— 旧缓存成孤儿，由 relay 的 TTL 自行清理，不影响正确性。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cache = new Map(); // dataRoot -> id

function instanceId(dataRoot) {
  const root = path.resolve(String(dataRoot || '.'));
  if (cache.has(root)) return cache.get(root);
  const file = path.join(root, 'instance-id');
  let id = '';
  try {
    id = fs.readFileSync(file, 'utf8').trim();
  } catch (_) {}
  if (!/^[0-9a-f]{12}$/.test(id)) {
    id = crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(file, id + '\n');
    } catch (_) {}
  }
  cache.set(root, id);
  return id;
}

module.exports = { instanceId };
