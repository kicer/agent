# 国内网络

pip / npm / GitHub / brew 超时或装不上时换源：

- pip：加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`
- npm：加 `--registry=https://registry.npmmirror.com`
- GitHub 下载：地址前加 `https://gh-proxy.com/`（备用 `https://ghfast.top/`）
- brew：换清华/中科大镜像，或让用户自己装
- 缺运行时/系统包用本机包管理器（`apt` / `dnf` / `pacman` / `brew` / `winget`）；需要密码时先问用户
