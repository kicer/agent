#!/bin/sh
# macOS 双击入口：在 Finder 里双击本文件，会用「终端」打开并执行 ../local/start.sh。
#
# 为什么不直接 exec：脚本失败时要留窗口给人看错误（双击启动的窗口默认一退出就关）。
# 为什么要补 PATH：双击启动的进程不继承登录 shell 的环境，Homebrew 装的 node/ffmpeg
# 常常不在默认 PATH 里（Apple Silicon 是 /opt/homebrew，Intel 是 /usr/local）。
cd "$(dirname "$0")/.." || exit 1
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

./local/start.sh
code=$?
if [ "$code" -ne 0 ] && [ -t 0 ]; then
  printf '\n按回车关闭窗口…'
  read -r _
fi
exit "$code"
