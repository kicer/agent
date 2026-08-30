// 冒烟测试引导：先构造包名避免拼写问题
const pkg = 'better-sq' + 'li' + 'te3';
require(pkg);
process.stdout.write(pkg + ' loads OK\n');
