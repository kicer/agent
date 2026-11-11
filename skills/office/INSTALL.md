# 本机安装 officecli（office 技能）

技能三件套：本文件同目录的 `SKILL.md`（用法）、`scripts/office`（Node 封装层，已在 `PATH` 里）、
`bin/officecli`（.NET 单文件二进制，**不入库**）。

服务器上由镜像构建 / `agent-executor-init` 跑同目录的 `install.sh`（只处理 linux-x64）。
**本机不要跑 `install.sh`**，按下面自己下：先装才用，不需要重启 agent（封装层每次执行时才解析二进制路径）。

下文「技能目录」= `$(dirname "$AGENT_SKILLS_DEPS")/office`（本地形态 `AGENT_SKILLS_DEPS` 指向 `<仓库>/skills/deps`）。

## 1. 下载对应平台的资产

| 平台 | 资产名 |
|---|---|
| macOS Apple Silicon | `officecli-mac-arm64` |
| macOS Intel | `officecli-mac-x64` |
| Linux x64 | `officecli-linux-x64` |
| Linux arm64 | `officecli-linux-arm64` |

```bash
mkdir -p "$(dirname "$AGENT_SKILLS_DEPS")/office/bin"
curl -fL --progress-bar \
  -o "$(dirname "$AGENT_SKILLS_DEPS")/office/bin/officecli" \
  https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/officecli-mac-x64
```

- 用 `latest` 就够（officecli 首次运行也会把自己更新到 latest），不用对齐服务器 pin 的版本。
- 国内慢就换源：`https://gh-proxy.com/https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/<资产>`。
- 约 34MB，超时/断流就重试；`curl -fL` 失败时不会留下半截文件可用。

## 2. 赋可执行位并验证

```bash
chmod +x "$(dirname "$AGENT_SKILLS_DEPS")/office/bin/officecli"
office --version     # 或 office help
```

`office` 命令由本地启动器注入 `PATH` 提供（`skills/office/scripts` 目录），不需要建软链、不需要 root。
如果 `office` 不在 PATH（例如手工起 core 没带启动器），可以直接跑
`node "$(dirname "$AGENT_SKILLS_DEPS")/office/scripts/office" help`。

## 3. 装不上怎么办

封装层会报 `office.core binary missing: <路径>`，说明二进制没到位；文档的创建/编辑/读取全部依赖它，
没有它就用别的路子（例如要 PDF 用 `x2pdf` 技能）。**不要**为此改系统目录或去装 .NET 运行时——
该二进制是自包含的。
