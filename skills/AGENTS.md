# 技能排错：国内网络

各技能自己的 `AGENTS.md` 只写它特有的问题；凡是网络类的（直连超时、装包失败、下载卡住），按这里换源，
别反复重试或长时间干等：

- pip：加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`
- npm：加 `--registry=https://registry.npmmirror.com`
- GitHub 下载：地址前加 `https://gh-proxy.com/`（备用 `https://ghfast.top/`）
- brew：换清华/中科大镜像，或让用户自己装
- 缺运行时/系统包用本机包管理器（`apt` / `dnf` / `pacman` / `brew` / `winget`）；需要密码时先问用户

本文件不被 core 读取，只在技能报错信息里被间接指向。
