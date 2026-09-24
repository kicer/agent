// 统计看板配置 —— 按你的表结构修改
window.PAGE_CONFIG = {
  table: 'items',
  pk: 'id',
  title: '数据看板',
  groupBy: 'category',        // 分组维度
  // 指标定义：count = 计数（默认）；sum = 对某列求和
  metric: { type: 'count' },
  // metric: { type: 'sum', column: 'amount', label: '总金额' },
  detailColumns: ['name', 'category', 'qty'],  // 明细表展示的列
  detailLimit: 20,
};
