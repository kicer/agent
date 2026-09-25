# Skills 开发指南

本指南面向所有希望在 Agent 系统中创建、发布和维护技能（Skill）的开发者。技能是可复用的任务处理单元，Agent 可以通过统一的 Skill Manager 工具发现并调用它们。遵循本指南，可以让你的技能易于发现、可靠执行且便于维护。

---

## 1. 什么是技能？

技能是一个自包含的目录，通常存放在技能根目录（默认为 `skills/`）下。每个技能包含一个描述文件（`SKILL.md`）和一个可执行入口（`run.py` 或 `run.sh`）。Agent 通过以下流程使用技能：

1. 调用 `skill`（op=list）查看所有可用技能的名称和简介；
2. 调用 `skill`（op=get）获取某个技能的详细说明；
3. 调用 `skill`（op=run）执行技能，传入所需参数。

技能可以处理任何任务，例如文件格式转换、数据处理、网页抓取等。

---

## 2. 技能目录结构

```
skills/
└── <skill-name>/
    ├── SKILL.md          # 技能描述文件（必须）
    ├── run.py            # 技能主入口（Python 脚本，推荐）或 run.sh
    ├── requirements.txt  # Python 依赖（可选，若需要第三方包）
    ├── install.sh        # 系统级依赖安装脚本（可选，如 apt-get）
    └── ...               # 其他技能相关文件（如字体、模板等）
```

> **技能名称**只能包含字母、数字、下划线或连字符，不能包含路径分隔符（`/`、`\`）或 `..`，以避免安全风险。

---

## 3. SKILL.md 规范

`SKILL.md` 是技能的门面，Agent 通过它判断技能是否适用于当前任务。文件使用 Markdown 编写，建议包含 YAML Front Matter 以提供结构化元数据。

### 3.1 Front Matter

支持以下字段（均为可选，但推荐至少提供 `description`）：

```yaml
---
name: my-skill
description: 一句话描述技能功能
input_schema:
  type: object
  properties:
    # 定义输入参数
  required:
    # 必填参数列表
output_schema:
  # 输出描述
visit_url: /app/{task_id}/   # 可选：页面类技能的访问路径模板
---
```

- `name`：技能名称，应与目录名一致。
- `description`：一句话描述技能功能，用于 `skill` op=list 展示。
- `input_schema`：输入参数的 JSON Schema 定义，用于参数校验和文档生成。
- `output_schema`：输出结果的描述（可选）。
- `visit_url`：（可选）页面类技能声明的访问路径模板，`{task_id}` 占位执行时替换为会话 id。`op=run` 成功后由 core（tools/executor.js）拼上 `public_link.base_url`，在输出末尾追加一行「访问地址：<完整 URL>」——技能进程跑在 executor 隔离视图里不知道公网地址，完整链接只能 core 补；AI 拿到相对路径会原样转给用户，而相对路径打不开。
- 若未提供 Front Matter，系统会尝试从正文第一行提取描述。

### 3.2 正文内容

正文是给 Agent 阅读的使用说明，应**简洁明了**，避免技术细节过多。建议包含：

- 功能简介（支持哪些能力）
- 参数说明（对应 `input_schema` 中的字段，注明必填/可选）
- 使用示例（可选）
- 注意事项（如依赖要求、执行时间等）

示例：

```markdown
## 功能
- 支持某某操作
- 自动处理某某

## 使用说明
通过 `skill`（op=run）调用，参数：
- `input`：某某路径（必填）
- `output`：某某路径（可选，默认与输入同名）
```

---

## 4. 入口脚本

### 4.1 格式要求

- **推荐**使用 Python 编写，入口文件命名为 `run.py`。
- 也可以使用 Shell 脚本，命名为 `run.sh`。
- Skill Manager 会优先查找 `run.py`，其次 `run.sh`。

### 4.2 参数传递

技能入口必须接收**一个 JSON 字符串作为唯一命令行参数**，其中包含所有输入参数。例如：

```bash
python3 run.py '{"input": "/path/to/file", "output": "/path/to/out"}'
```

在 `run.py` 中，应解析该 JSON 并提取所需参数。示例：

```python
import sys, json

def main():
    if len(sys.argv) != 2:
        print("Usage: python3 run.py '<json_string>'")
        sys.exit(1)
    args = json.loads(sys.argv[1])
    # 获取参数
    input_path = args.get("input")
    output_path = args.get("output")  # 可能为 None
    # ... 执行任务
```

### 4.3 输出

- 成功时，将结果信息打印到标准输出（`stdout`），Skill Manager 会将其返回给 Agent。
- 失败时，将错误信息打印到标准错误（`stderr`），并以非零退出码退出。

---

## 5. 依赖管理

### 5.1 Python 依赖

在技能目录下放置 `requirements.txt` 文件，列出所有需要的第三方包。服务启动前，`agent-executor-init`（`executor/init-skills.js`）会逐行**离线探测**：镜像已预烘的包（见 `executor/Dockerfile`）直接跳过，只把缺的装到共享 `deps` 目录（技能根目录下的 `deps/`），运行期由 executor 容器 env 的 `PYTHONPATH` 可见（技能脚本与 AI 终端命令都能 import，无需 rebuild 镜像）；结果按 `requirements.txt` 的 hash 缓存（`.deps_installed`），未变化则整个技能跳过。

示例 `requirements.txt`：

```
requests==2.28.1
beautifulsoup4==4.11.1
```

- 依赖安装使用 `pip install --target`，不会污染系统全局；镜像已带的包不会重复装。
- 所有技能**共享**同一个 `deps` 目录，请注意版本冲突（后装的覆盖先装的）。建议锁定精确版本。
- 运行期 skills 目录只读；若上线后经 UI 改了 `requirements.txt`，需重启（`docker compose up -d`）触发重新 init，否则该技能会因依赖未就绪而失败。

### 5.2 系统级依赖

如果需要系统库或字体等，提供一个 `install.sh` 脚本。它在两处执行：

- **镜像构建**（`executor/Dockerfile` 的 `skills` 阶段，`build.target: skills`）：此处安装的系统包（`apt-get` 等）会烘进派生镜像 M'，持久且对命令只读——**系统包必须走这里**。
- **服务启动前的 init**（`executor/init-skills.js`）：用于生成技能自带资产（如从系统字体提取 `fonts/cjk.ttf`）。init 容器根文件系统只读，`apt-get install` 在这里不生效，不要依赖它。

示例 `install.sh`：

```bash
#!/bin/bash
set -e
apt-get update -y -qq
apt-get install -y -qq some-package
```

- `install.sh` 必须可执行（`chmod +x install.sh`）。
- 请保持幂等：init 侧以内容 hash 缓存（`.deps_installed`），构建侧靠 Docker 层缓存；脚本应在“依赖已就绪”时快速跳过。
- 想两处都跑不报错：apt 类语句加 `|| true` 容错，并在脚本末尾自行校验“要的东西是否就绪”，就绪则 exit 0、否则 exit 1（参考 `img-utils/install.sh`）。否则 init 阶段（根文件系统只读）的 apt 失败会让整个技能被标记为“未就绪”。
- 改动 `install.sh` 后：系统包需 `docker compose build agent-executor`，资产需 `docker compose up -d`（或两者一起 `build && up`）。

### 5.3 缓存机制

`agent-executor-init` 会为每个技能生成一个 `.deps_installed` 标记文件，记录依赖文件的哈希值。只有当 `requirements.txt` 或 `install.sh` 内容改变时，才会重新安装/重新生成资产。手动删除该文件可强制重跑（core 运行期不再读写依赖，标记只由 init 维护）。

---

## 6. 路径处理

Agent 调用技能时，传入的文件路径可能是相对路径（相对于任务目录）。Skill Manager 会在执行前自动将相对路径转换为绝对路径，因此**技能脚本无需关心路径解析**，直接使用传入的路径即可。但请注意：

- **运行时的工作目录是「会话任务目录」，不是技能目录**（远端模式下即 executor 隔离视图里的 `/workspace/tasks/<会话>`）。技能进程只能看到当前会话的数据，看不到其他会话。
- 因此技能内部引用**自身资源**（模板、字体、配置等）时，**必须**基于脚本位置取绝对路径，不要依赖 cwd：Python 用 `Path(__file__).resolve().parent`，Shell 用 `"$(dirname "$0")"`。
- 读写会话数据用 `input_args` 里传入的路径即可；相对路径会被预转绝对路径，且在隔离视图里与 Agent 看到的是同一份数据。

---

## 7. 最佳实践

1. **单一职责**：一个技能只做一件事，便于维护和复用。
2. **参数校验**：在 `run.py` 中校验输入参数，给出清晰的错误提示。
3. **错误处理**：捕获异常并输出可读错误信息，避免堆栈直接暴露给 Agent。
4. **超时控制**：如果任务可能耗时较长，考虑在脚本内部实现进度输出或分段处理。
5. **日志输出**：适度输出进度信息，但不要过于啰嗦，避免淹没关键结果。
6. **测试**：在提交前，手动测试技能的常见路径和边界情况。

---

## 8. 调试与测试

你可以直接在技能目录下运行入口脚本，模拟 Skill Manager 的调用方式：

```bash
cd skills/my-skill
python3 run.py '{"input": "/path/to/test", "output": "/tmp/out"}'
```

> 注意：手工调试时的 cwd 是技能目录，而**线上运行的 cwd 是会话任务目录**（见第 6 节）。所以脚本对自身资源的引用要用 `__file__`/`$0` 定位，手工调试才能与线上行为一致。

如果需要测试依赖安装，可以删除 `.deps_installed` 和 `deps/` 目录后重新执行。

---

## 9. 示例：一个最简单的技能

假设我们要创建一个 `echo` 技能，它接收一个字符串并原样返回。

**目录**：`skills/echo/`

**SKILL.md**：

```markdown
---
name: echo
description: 原样返回输入的字符串
input_schema:
  type: object
  properties:
    text:
      type: string
      description: 要回显的文本
  required: [text]
---

## 使用说明
通过 `skill`（op=run）调用，参数：
- `text`：要回显的文本（必填）
```

**run.py**：

```python
#!/usr/bin/env python3
import sys, json

def main():
    args = json.loads(sys.argv[1])
    text = args.get("text", "")
    print(text)

if __name__ == "__main__":
    main()
```

没有 `requirements.txt` 或 `install.sh`。

---

## 10. 常见问题

**Q：为什么我的技能找不到依赖？**  
A：确保 `requirements.txt` 存在且列出了所有需要的包，并检查 `.deps_installed` 文件是否存在，删除后重试。

**Q：依赖安装失败怎么办？**  
A：检查网络连接和 pip 源是否可用，查看 Skill Manager 输出的错误日志。

**Q：多个技能依赖冲突如何解决？**  
A：目前所有技能共享同一个 `deps` 目录，建议锁定精确版本，或考虑将冲突的技能拆分到不同的环境中（未来可能支持隔离）。

---

## 11. 参考资料

查看现有的 `x2pdf` 技能（位于 `skills/x2pdf/`）可以了解一个较为完整的实现，包括如何自带声明 Python 依赖与系统级依赖（不假设镜像预烘）、按扩展名分派渲染后端、参数化版式 CSS 等。但请根据自身技能的实际需求进行设计，不必拘泥于该示例。

图像处理类需求可参考 `skills/img-utils/`：它演示了一个纯 Python + 预装 Pillow 的实现（转换/缩放/裁剪/压缩/水印/切片/拼图，无 requirements.txt，仅靠 install.sh 保证中文字体），并明确区分“确定性图像处理”与“AI 生成/修图”的能力边界。

---

遵循以上规范，你的技能将能够被 Agent 自动发现、正确调用，并在不同环境中稳定运行。如有疑问，请参考现有技能或联系维护者。
