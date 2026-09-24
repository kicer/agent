// 分列看板配置 —— 按你的表结构修改
window.PAGE_CONFIG = {
  table: 'tasks',
  pk: 'id',
  title: '任务看板',
  groupField: 'status',                       // 用来分列的字段
  groups: ['待办', '进行中', '已完成'],         // 列的显示顺序
  titleField: 'title',                        // 卡片主标题字段
  metaFields: ['assignee', 'due'],            // 卡片上显示的次要信息
};
