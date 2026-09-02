# Skills 开发指南

本指南面向所有希望在 Agent 系统中创建、发布和维护技能（Skill）的开发者。技能是可复用的任务处理单元，Agent 可以通过统一的 Skill Manager 工具发现并调用它们。遵循本指南，可以让你的技能易于发现、可靠执行且便于维护。

---

## 1. 什么是技能？

技能是一个自包含的目录，通常存放在技能根目录（默认为 `skills/`）下。每个技能包含一个描述文件（`SKILL.md`）和一个可执行入口（`run.py` 或 `run.sh`）。Agent 通过以下流程使用技能：

1. 调用 `list_skills` 查看所有可用技能的名称和简介；
2. 调用 `get_skill_info` 获取某个技能的详细说明；
3. 调用 `run_skill` 执行技能，传入所需参数。

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
---
```

- `name`：技能名称，应与目录名一致。
- `description`：一句话描述技能功能，用于 `list_skills` 展示。
- `input_schema`：输入参数的 JSON Schema 定义，用于参数校验和文档生成。
- `output_schema`：输出结果的描述（可选）。
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
通过 `run_skill` 调用，参数：
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

在技能目录下放置 `requirements.txt` 文件，列出所有需要的第三方包。Skill Manager 会**自动安装**这些依赖到共享的 `deps` 目录（位于技能根目录下的 `deps/`），并通过 `PYTHONPATH` 注入运行环境。

示例 `requirements.txt`：

```
requests==2.28.1
beautifulsoup4==4.11.1
```

- 依赖安装使用 `pip install --target`，不会污染系统全局。
- 所有技能**共享**同一个 `deps` 目录，请注意版本冲突（后装的覆盖先装的）。建议锁定精确版本。

### 5.2 系统级依赖

如果技能需要系统库或字体等，可以提供一个 `install.sh` 脚本。Skill Manager 会在首次运行或脚本内容变化时执行它，并缓存结果。

示例 `install.sh`：

```bash
#!/bin/bash
set -e
apt-get update -y -qq
apt-get install -y -qq some-package
```

- `install.sh` 必须可执行（`chmod +x install.sh`）。
- 脚本中的操作应尽量幂等，以避免重复执行时出错。
- 如果安装耗时较长，请耐心等待；Skill Manager 会设置超时（默认 10 分钟）。

### 5.3 缓存机制

Skill Manager 会为每个技能生成一个 `.deps_installed` 标记文件，记录依赖文件的哈希值。只有当 `requirements.txt` 或 `install.sh` 内容改变时，才会重新安装。手动删除该文件可强制重装。

---

## 6. 路径处理

Agent 调用技能时，传入的文件路径可能是相对路径（相对于任务目录）。Skill Manager 会在执行前自动将相对路径转换为绝对路径，因此**技能脚本无需关心路径解析**，直接使用传入的路径即可。但请注意：

- 如果技能内部需要引用其他文件（如模板、字体），请使用基于脚本所在目录的绝对路径（`os.path.dirname(__file__)`）。

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
通过 `run_skill` 调用，参数：
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

查看现有的 `md2pdf` 技能（位于 `skills/md2pdf/`）可以了解一个较为完整的实现，包括如何处理系统级依赖和字体等。但请根据自身技能的实际需求进行设计，不必拘泥于该示例。

图像处理类需求可参考 `skills/img-utils/`：它演示了一个纯 Python + 预装 Pillow 的实现（转换/缩放/裁剪/压缩/水印/切片/拼图，无 requirements.txt，仅靠 install.sh 保证中文字体），并明确区分“确定性图像处理”与“AI 生成/修图”的能力边界。

---

遵循以上规范，你的技能将能够被 Agent 自动发现、正确调用，并在不同环境中稳定运行。如有疑问，请参考现有技能或联系维护者。
