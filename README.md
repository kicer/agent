# 自用通用 Agent 系统——完整设计方案

## 一、项目概述

构建一个运行在自有 Docker 服务器上的**通用任务 Agent**，带 H5 移动端友好的 Web 界面。用户可以创建会话、与 AI 对话讨论需求、上传文件、让 AI 执行任务（生成文件、处理数据、搜索信息、执行脚本等），并可下载结果文件。

### 核心特性

- 多模型账号并行调度（ds1、ds2、ds3…）
- 任务目录自动创建，文件隔离
- 流式输出展示
- 任务状态开关（规划 / 执行）
- 排队机制，用户可离线输入
- 工具调用（文件操作、终端、网络抓取、网页搜索）
- 多模态图片识别（模型配置 vision: true 时，read_file 读图会压缩回传图片内容；用户上传仅存任务目录，不自动发送）
- 借鉴 Zed agent 的 system prompt 和工具定义

---

## 二、模型与并发

### 2.1 模型池配置

配置文件（如 `config.yml`）中定义模型列表：

```yaml
models:
  - id: ds1
    display_name: "AMD DeepSeek 1"
  - id: ds2
    display_name: "AMD DeepSeek 2"
  - id: ds3
    display_name: "AMD DeepSeek 3"
```

- 所有模型 ID 使用**同一个上游 URL**（由 cli-proxy-api 代理）。
- 每个模型 ID 对应一个独立账号，互不共享。
- 同时活跃会话数上限 = 模型 ID 数量。

### 2.2 调度规则

- 会话创建时尝试绑定空闲模型：
  - 有空闲 → 立即绑定，进入活跃状态。
  - 无空闲 → 会话进入排队状态，用户可输入但 AI 不应答。
- 任务执行期间，该会话内所有模型请求**始终使用同一个模型 ID**（保证前缀缓存命中）。
- 模型释放后立即检查全局等待队列，按 **FIFO** 取出最早排队的会话绑定。

---

## 三、任务阶段状态机

### 3.1 阶段定义

| 阶段 | 含义 | 驱动方式 |
|---|---|---|
| **规划（Planning）** | 用户与 AI 讨论需求，澄清细节 | 用户点击「开始执行」→ 切换到执行 |
| **执行（Execution）** | AI 按 task.md 实际干活 | AI 完成任务 或 用户点击「终止」→ 结束 |

### 3.2 界面开关

界面顶部固定一个状态按钮（物理开关样式）：

- **规划阶段**：按钮显示「▶ 开始执行」
  - 点击后：系统自动追加一条 user 消息（见下文），阶段切换为执行。
- **执行阶段**：按钮显示「■ 终止」
  - 点击后：设置终止标志，kill 当前进程（如有），模型释放，任务结束。

### 3.3 追加的 user 消息模板

用户点击「开始执行」时，系统向消息流中追加：

```
我说完了，你可以开始干活了。先把我上面说的需求整理成 task.md 文件写入任务目录，然后按照 task.md 开始执行。
```

此消息走正常发送流程（若会话活跃则实时发送；若排队则进入待发送队列）。

---

## 四、会话状态模型

| 状态 | 含义 | 模型绑定 | 用户输入行为 |
|---|---|---|---|
| **排队中** | 无模型空闲，用户可输入，消息暂存并进入全局等待队列 | 无 | 可输入，AI 不应答（灰色图标） |
| **活跃中** | 已绑定模型，实时对话/执行 | 有 | 消息实时发给模型 |
| **保持中（held）** | AI 已答完，在租约内继续占用模型等待追问 | 有（临时保持） | 消息直接复用已绑模型，免排队 |
| **已完成/已取消** | 租约到期释放、任务结束或用户终止，模型已释放 | 无 | 可继续输入，自动再次进入排队 |

> held 租约规则（`model_hold` 可配置）：页面无观看者超过 `idle_release_ms`（默认 3 分钟）即释放；有人观看最长保持 `active_max_ms`（默认 30 分钟），防止挂着页面霸占模型池。「绑定模型但闲置」的会话（如新建后从未发言）同受此租约管理，到期自动变已完成并释放模型。

> 「已完成」和「已取消」本质相同，都回到“空闲”状态，仅记录一个结束原因。

### 4.1 核心流程

1. **创建会话**：生成任务 ID，创建任务目录，尝试绑定空闲模型。
2. **用户输入**：
   - 活跃中 / 保持中 → 实时发送（held 直接复用已绑模型）。
   - 排队中 / 已完成 → 消息暂存，会话自动进入全局等待队列。
3. **模型分配**：模型空闲时，从全局队列 FIFO 取会话，绑定，将暂存消息一次性发出。
4. **回合结束**：AI 答完，会话进入 held（模型不释放，可无缝追问）；租约到期无追问 → 释放变 completed；用户终止 → cancelled 并立即释放。

---

## 五、任务目录

- 会话创建时立即创建目录：`/workspace/tasks/{task_id}/`
- 目录永久保留，用户可在 Web 端删除任务时勾选同时删除目录。
- 上传的文件直接存入该目录。
- `task.md` 由 AI 在用户确认开始执行后通过 `write_file` 工具生成。

---

## 六、终止机制

- 用户点击「终止」：设置 `cancelled` 标志。
- 若模型正在流式输出：等待当前输出完成，不再继续。
- 若正在执行 `terminal` 或脚本进程：立即 kill。
- 之后不再发起新的模型请求或工具调用。
- 模型 ID 立即释放。

---

## 七、借鉴 Zed 的 System Prompt 与工具定义

> 以下内容从 Zed 实际请求日志中提取，直接沿用，保持与 Zed 一致以利用缓存和验证过的行为。

### 7.1 System Prompt（完整）

```
# /app/server/templates/system-prompt.txt
```

> 注：system prompt 完全静态（所有会话共用，利于前缀缓存）。动态会话信息（日期、任务目录、模型显示名）在新建会话时作为首条 user 消息自动发送，跟会话走。`<available_skills>` 当前为空，预留扩展。

### 7.2 内置工具定义（12 个；去掉 diagnostics、skill、spawn_agent；web_search 移至 MCP 服务）

以下工具定义沿用 Zed 原始 JSON Schema，**保持字段完全一致以利于缓存**。

#### 1. `copy_path`

```json
{
  "type": "function",
  "function": {
    "name": "copy_path",
    "description": "Copies a file or directory in the project, and returns confirmation that the copy succeeded.\nDirectory contents will be copied recursively.\n\nThis tool should be used when it's desirable to create a copy of a file or directory without modifying the original.\nIt's much more efficient than doing this by separately reading and then writing the file or directory's contents, so this tool should be preferred over that approach whenever copying is the goal.\nThe only supported paths outside the project are descendants of `~/.agents/skills`, for global agent skills.",
    "parameters": {
      "required": ["source_path", "destination_path"],
      "properties": {
        "source_path": {
          "description": "The source path of the file or directory to copy.\nIf a directory is specified, its contents will be copied recursively.\n\n<example>\nIf the project has the following files:\n\n- directory1/a/something.txt\n- directory2/a/things.txt\n- directory3/a/other.txt\n\nYou can copy the first file by providing a source_path of \"directory1/a/something.txt\"\n</example>",
          "type": "string"
        },
        "destination_path": {
          "description": "The destination path where the file or directory should be copied to.\n\n<example>\nTo copy \"directory1/a/something.txt\" to \"directory2/b/copy.txt\", provide a destination_path of \"directory2/b/copy.txt\"\n</example>",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 2. `create_directory`

```json
{
  "type": "function",
  "function": {
    "name": "create_directory",
    "description": "Creates a new directory at the specified path within the project. Returns confirmation that the directory was created.\n\nThis tool creates a directory and all necessary parent directories. It should be used whenever you need to create new directories within the project.\nThe only supported path outside the project is `~/.agents/skills` or a descendant, for global agent skills.",
    "parameters": {
      "required": ["path"],
      "properties": {
        "path": {
          "description": "The path of the new directory.\n\n<example>\nIf the project has the following structure:\n\n- directory1/\n- directory2/\n\nYou can create a new directory by providing a path of \"directory1/new_directory\"\n</example>\n\n<example>\nTo create a global agent skill directory, you may provide a path under `~/.agents/skills`, such as `~/.agents/skills/my-skill`.\n</example>",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 3. `delete_path`

```json
{
  "type": "function",
  "function": {
    "name": "delete_path",
    "description": "Deletes the file or directory (and the directory's contents, recursively) at the specified path in the project, and returns confirmation of the deletion.\n\nThe only supported paths outside the project are descendants of `~/.agents/skills`, for global agent skills.",
    "parameters": {
      "required": ["path"],
      "properties": {
        "path": {
          "description": "The path of the file or directory to delete.\n\n<example>\nIf the project has the following files:\n\n- directory1/a/something.txt\n- directory2/a/things.txt\n- directory3/a/other.txt\n\nYou can delete the first file by providing a path of \"directory1/a/something.txt\"\n</example>",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 4. `edit_file`

```json
{
  "type": "function",
  "function": {
    "name": "edit_file",
    "description": "This is a tool for applying edits to an existing file.\n\nBefore using this tool, use the `read_file` tool to understand the file's contents and context.\nTo create a new file or overwrite an existing one with completely new contents, use the `write_file` tool instead.\n\nThe only supported path outside the project is `~/.agents/skills` or a descendant, for global agent skills.\n\n`read_file` prefixes each line of its output with a line number right-aligned in a\n6-character field followed by a single tab, then the line's actual content. When you\nderive `old_text` or `new_text` from that output, strip this prefix and keep only what\ncomes after the tab, preserving the original indentation (tabs and spaces) exactly.\nNever include any part of the line number prefix in `old_text` or `new_text`.",
    "parameters": {
      "required": ["path", "edits"],
      "properties": {
        "path": {
          "description": "The full path of the file to edit in the project.\n\nWARNING: When specifying which file path need changing, you MUST start each path with one of the project's root directories, unless it's a global agent skill under `~/.agents/skills`.\n\nThe following examples assume we have two root directories in the project:\n- /a/b/backend\n- /c/d/frontend\n\n<example>\n`backend/src/main.rs`\n\nNotice how the file path starts with `backend`. Without that, the path would be ambiguous and the call would fail!\n</example>\n\n<example>\n`frontend/db.js`\n</example>\n\n<example>\nTo edit a global agent skill file, you may provide a path under `~/.agents/skills`, such as `~/.agents/skills/my-skill/SKILL.md`.\n</example>",
          "type": "string"
        },
        "edits": {
          "description": "List of edit operations to apply sequentially.\nEach edit finds `old_text` in the file and replaces it with `new_text`.",
          "type": "array",
          "items": {
            "description": "A single edit operation that replaces old text with new text\nProperly escape all text fields as valid JSON strings.\nRemember to escape special characters like newlines (`\\n`) and quotes (`\"`) in JSON strings.",
            "type": "object",
            "properties": {
              "old_text": {
                "description": "The exact text to find in the file. This will be matched using fuzzy matching\nto handle minor differences in whitespace or formatting.\n\nBe minimal with replacements:\n- For unique lines, include only those lines\n- For non-unique lines, include enough context to identify them",
                "type": "string"
              },
              "new_text": {
                "description": "The text to replace it with",
                "type": "string"
              }
            },
            "required": ["old_text", "new_text"]
          }
        }
      },
      "type": "object"
    }
  }
}
```

#### 5. `fetch`

```json
{
  "type": "function",
  "function": {
    "name": "fetch",
    "description": "Fetches a URL and returns the content as Markdown.\n\nThis tool is not run inside the terminal OS sandbox, but it still refuses to\nreach any host that hasn't been granted network access. It shares the same\nper-host grants as the `terminal` tool: approving a host for one authorizes\nit for the other, whether the grant is for this thread or saved permanently.\nWhen unsandboxed access has been granted, these restrictions are lifted\nentirely, matching the terminal, which is also how loopback and IP-literal\nhosts (which can't be granted individually) become reachable.",
    "parameters": {
      "required": ["url"],
      "properties": {
        "url": {
          "description": "The URL to fetch.",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 6. `find_path`

```json
{
  "type": "function",
  "function": {
    "name": "find_path",
    "description": "Find file paths that match a given pattern.\n\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted alphabetically\n- Prefer the `grep` tool to this tool when searching for symbols unless you have specific information about paths.\n- Use this tool when you need to find files by name patterns\n- Results are paginated with 50 matches per page. Use the optional 'offset' parameter to request subsequent pages.",
    "parameters": {
      "required": ["glob"],
      "properties": {
        "glob": {
          "description": "The glob to match against every path in the project.\n\n<example>\nIf the project has the following root directories:\n\n- directory1/a/something.txt\n- directory2/a/things.txt\n- directory3/a/other.txt\n\nYou can get back the first two paths by providing a glob of \"*thing*.txt\"\n</example>",
          "type": "string"
        },
        "offset": {
          "description": "Optional starting position for paginated results (0-based).\nWhen not provided, starts from the beginning.",
          "type": "integer",
          "default": 0,
          "minimum": 0
        }
      },
      "type": "object"
    }
  }
}
```

#### 7. `grep`

```json
{
  "type": "function",
  "function": {
    "name": "grep",
    "description": "Searches the contents of files in the project with a regular expression\n\n- Prefer this tool to path search when searching for symbols in the project, because you won't need to guess what path it's in.\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\\\s+\\\\w+\", etc.)\n- Pass an `include_pattern` if you know how to narrow your search on the files system\n- Never use this tool to search for paths. Only search file contents with this tool.\n- Use this tool when you need to find files containing specific patterns\n- Results are paginated with 20 matches per page. Use the optional 'offset' parameter to request subsequent pages.\n- DO NOT use HTML entities solely to escape characters in the tool parameters.",
    "parameters": {
      "required": ["regex"],
      "properties": {
        "regex": {
          "description": "A regex pattern to search for in the entire project. Note that the regex will be parsed by the Rust `regex` crate.\n\nDo NOT specify a path here! This will only be matched against the code **content**.",
          "type": "string"
        },
        "include_pattern": {
          "description": "A glob pattern for the paths of files to include in the search.\nSupports standard glob patterns like \"**/*.rs\" or \"frontend/src/**/*.ts\".\nIf omitted, all files in the project will be searched.\n\nThe glob pattern is matched against the full path including the project root directory.\n\n<example>\nIf the project has the following root directories:\n\n- /a/b/backend\n- /c/d/frontend\n\nUse \"backend/**/*.rs\" to search only Rust files in the backend root directory.\nUse \"frontend/src/**/*.ts\" to search TypeScript files only in the frontend root directory (sub-directory \"src\").\nUse \"**/*.rs\" to search Rust files across all root directories.\n</example>",
          "type": "string",
          "nullable": true
        },
        "offset": {
          "description": "Optional starting position for paginated results (0-based).\nWhen not provided, starts from the beginning.",
          "type": "integer",
          "default": 0,
          "minimum": 0
        },
        "case_sensitive": {
          "description": "Whether the regex is case-sensitive. Defaults to false (case-insensitive).",
          "type": "boolean",
          "default": false
        }
      },
      "type": "object"
    }
  }
}
```

#### 8. `list_directory`

```json
{
  "type": "function",
  "function": {
    "name": "list_directory",
    "description": "Lists files and directories in a given path. Prefer the `grep` or `find_path` tools when searching the codebase.\n\nThe only supported path outside the project is `~/.agents/skills` or a descendant, for global agent skills.",
    "parameters": {
      "required": ["path"],
      "properties": {
        "path": {
          "description": "The fully-qualified path of the directory to list in the project.\n\nThis path should never be absolute, and the first component of the path should always be a root directory in a project, unless it's a global agent skill directory under `~/.agents/skills`.\n\n<example>\nIf the project has the following root directories:\n\n- directory1\n- directory2\n\nYou can list the contents of `directory1` by using the path `directory1`.\n</example>\n\n<example>\nIf the project has the following root directories:\n\n- foo\n- bar\n\nIf you wanna list contents in the directory `foo/baz`, you should use the path `foo/baz`.\n</example>\n\n<example>\nTo list a global agent skill directory, you may provide a path under `~/.agents/skills`, such as `~/.agents/skills/my-skill`.\n</example>",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 9. `move_path`

```json
{
  "type": "function",
  "function": {
    "name": "move_path",
    "description": "Moves or rename a file or directory in the project, and returns confirmation that the move succeeded.\n\nIf the source and destination directories are the same, but the filename is different, this performs a rename. Otherwise, it performs a move.\n\nThis tool should be used when it's desirable to move or rename a file or directory without changing its contents at all.\nThe only supported paths outside the project are descendants of `~/.agents/skills`, for global agent skills.",
    "parameters": {
      "required": ["source_path", "destination_path"],
      "properties": {
        "source_path": {
          "description": "The source path of the file or directory to move/rename.\n\n<example>\nIf the project has the following files:\n\n- directory1/a/something.txt\n- directory2/a/things.txt\n- directory3/a/other.txt\n\nYou can move the first file by providing a source_path of \"directory1/a/something.txt\"\n</example>",
          "type": "string"
        },
        "destination_path": {
          "description": "The destination path where the file or directory should be moved/renamed to.\nIf the paths are the same except for the filename, then this will be a rename.\n\n<example>\nTo move \"directory1/a/something.txt\" to \"directory2/b/renamed.txt\",\nprovide a destination_path of \"directory2/b/renamed.txt\"\n</example>",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

#### 10. `read_file`

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Reads the content of the given file in the project.\n\n- Never attempt to read a path that hasn't been previously mentioned.\n- For large files, this tool returns a file outline with symbol names and line numbers instead of the full content.\n  This outline IS a successful response - use the line numbers to read specific sections with start_line/end_line.\n  Do NOT retry reading the same file without line numbers if you receive an outline.\n- This tool supports reading image files. Supported formats: PNG, JPEG, WebP, GIF, BMP, TIFF.\n  Image files are returned as visual content that you can analyze directly.\n\nThe only supported path outside the project is `~/.agents/skills` or a descendant, for global agent skills.",
    "parameters": {
      "required": ["path"],
      "properties": {
        "path": {
          "description": "The relative path of the file to read.\n\nThis path should never be absolute, and the first component of the path should always be a root directory in a project, unless it's a global agent skill under `~/.agents/skills`.\n\n<example>\nIf the project has the following root directories:\n\n- /a/b/directory1\n- /c/d/directory2\n\nIf you want to access `file.txt` in `directory1`, you should use the path `directory1/file.txt`.\nIf you want to access `file.txt` in `directory2`, you should use the path `directory2/file.txt`.\n</example>\n\n<example>\nTo read a global agent skill file, you may provide a path under `~/.agents/skills`, such as `~/.agents/skills/my-skill/SKILL.md`.\n</example>",
          "type": "string"
        },
        "start_line": {
          "description": "Optional line number to start reading on (1-based index)",
          "type": "integer",
          "nullable": true,
          "minimum": 0,
          "default": null
        },
        "end_line": {
          "description": "Optional line number to end reading on (1-based index, inclusive)",
          "type": "integer",
          "nullable": true,
          "minimum": 0,
          "default": null
        }
      },
      "type": "object"
    }
  }
}
```

#### 11. `terminal`

```json
{
  "type": "function",
  "function": {
    "name": "terminal",
    "description": "Executes a shell one-liner and returns the combined output.\n\nThis tool spawns a process using the user's shell, reads from stdout and stderr (preserving the order of writes), and returns a string with the combined output result.\n\nThe output results will be shown to the user already, only list it again if necessary, avoid being redundant.\n\nMake sure you use the `cd` parameter to navigate to one of the root directories of the project. NEVER do it as part of the `command` itself, otherwise it will error.\n\nDo not generate terminal commands that use shell substitutions or interpolations such as `$VAR`, `${VAR}`, `$(...)`, backticks, `$((...))`, `<(...)`, or `>(...)`. Resolve those values yourself before calling this tool, or ask the user for the literal value to use.\n\nDo not pipe output to `head`, `tail`, or similar output-filtering commands just to reduce what you receive. Instead, use `head_lines` and/or `tail_lines`; this keeps the terminal output visible to the user in real time while limiting only the final output sent back to you. When both are specified, the first `head_lines` lines are returned, then a blank line, then the last `tail_lines` lines. Avoid requesting too many lines, or the response may waste tokens or exceed the context window.\n\nDo not use this tool for commands that run indefinitely, such as servers (like `npm run start`, `npm run dev`, `python -m http.server`, etc) or file watchers that don't terminate on their own.\n\nFor potentially long-running commands, prefer specifying `timeout_ms` to bound runtime and prevent indefinite hangs.\n\nRemember that each invocation of this tool will spawn a new shell process, so you can't rely on any state from previous invocations.\n\nThe terminal is an interactive pty, so any command that blocks waiting for input will hang the tool until it times out. To avoid this:\n\n- Always insert `--no-pager` immediately after `git` for any read-only git command, including `git log`, `git diff`, `git show`, `git blame`, and `git stash show`. Example: `git --no-pager log -n 5` (NOT `git log -n 5`).\n- Prefer Git flags that avoid optional metadata writes when possible, such as `git --no-optional-locks status` instead of `git status`.\n- Always prepend `GIT_EDITOR=true ` to any git command that may invoke an editor, including `git rebase`, `git commit`, `git merge`, and `git tag`. Example: `GIT_EDITOR=true git rebase origin/main` (NOT `git rebase origin/main`).\n- For other commands that may open a pager or editor, set `PAGER=cat` and/or `EDITOR=true` similarly.",
    "parameters": {
      "required": ["command", "cd"],
      "properties": {
        "command": {
          "description": "The one-liner command to execute. Do not include shell substitutions or interpolations such as `$VAR`, `${VAR}`, `$(...)`, backticks, `$((...))`, `<(...)`, or `>(...)`; resolve those values first or ask the user for the literal value to use.\n\nREMINDER: read-only git commands (`git log`, `git diff`, `git show`, `git blame`) MUST include `--no-pager` (e.g. `git --no-pager log`). Prefer `git --no-optional-locks status` over `git status` to avoid optional metadata writes. Git commands that may open an editor (`git rebase`, `git commit`, `git merge`, `git tag`) MUST be prefixed with `GIT_EDITOR=true ` (e.g. `GIT_EDITOR=true git rebase origin/main`). Otherwise the terminal will hang.",
          "type": "string"
        },
        "cd": {
          "description": "Working directory for the command. This must be one of the root directories of the project.",
          "type": "string"
        },
        "timeout_ms": {
          "description": "Optional maximum runtime (in milliseconds). If exceeded, the running terminal task is killed.",
          "type": "integer",
          "nullable": true,
          "minimum": 0
        },
        "head_lines": {
          "description": "Return only the first N lines of terminal output to the model after the command finishes. Do not pipe output to `head`; use this parameter instead so the user can still see live output. Avoid requesting too many lines, or the response may waste tokens or exceed the context window.",
          "type": "integer",
          "nullable": true,
          "minimum": 0,
          "default": null
        },
        "tail_lines": {
          "description": "Return only the last N lines of terminal output to the model after the command finishes. Do not pipe output to `tail`; use this parameter instead so the user can still see live output. Avoid requesting too many lines, or the response may waste tokens or exceed the context window.",
          "type": "integer",
          "nullable": true,
          "minimum": 0,
          "default": null
        }
      },
      "type": "object"
    }
  }
}
```

#### 12. `write_file`

```json
{
  "type": "function",
  "function": {
    "name": "write_file",
    "description": "This is a tool for creating a new file or overwriting an existing file with completely new contents.\n\nTo make granular edits to an existing file, prefer the `edit_file` tool instead.\n\nBefore using this tool, verify the directory path is correct (only applicable when creating new files). Use the `list_directory` tool to verify the parent directory exists and is the correct location\n\nThe only supported path outside the project is `~/.agents/skills` or a descendant, for global agent skills.",
    "parameters": {
      "required": ["path", "content"],
      "properties": {
        "path": {
          "description": "The full path of the file to create or overwrite in the project.\n\nWARNING: When specifying which file path need changing, you MUST start each path with one of the project's root directories, unless it's a global agent skill under `~/.agents/skills`.\n\nThe following examples assume we have two root directories in the project:\n- /a/b/backend\n- /c/d/frontend\n\n<example>\n`backend/src/main.rs`\n\nNotice how the file path starts with `backend`. Without that, the path would be ambiguous and the call would fail!\n</example>\n\n<example>\n`frontend/db.js`\n</example>\n\n<example>\nTo create or overwrite a global agent skill file, you may provide a path under `~/.agents/skills`, such as `~/.agents/skills/my-skill/SKILL.md`.\n</example>",
          "type": "string"
        },
        "content": {
          "description": "The entire content for the file.",
          "type": "string"
        }
      },
      "type": "object"
    }
  }
}
```

> 说明：Zed 原始 16 个工具中去掉 `diagnostics`、`skill`、`spawn_agent`、`web_search`，内置保留上述 12 个。`web_search` 等外部能力改由 MCP 服务提供：在 config 的 `mcp_servers`（url + headers）配置，启动时 `tools/list` 自动发现并追加到内置工具之后一起发给模型，与内置工具严格分离。

---

## 八、技术架构

### 8.1 技术栈

- **后端**：Node.js（或 Python FastAPI，二选一，建议 Node.js 因前端同构）
- **前端**：单页 H5 + Vanilla JS + SSE（不引入重型框架）
- **数据库**：SQLite
- **部署**：Docker Compose
- **认证**：内置多用户登录（用户名/明文密码配在 `config.yml` 的 `auth.users`，登录页 + HttpOnly cookie，不做任务隔离；不用 nginx htpasswd，因手机浏览器原生下载不带 Basic 头会失败）

### 8.2 系统组件

```
┌─────────────────────────────────────────────────┐
│                    Web UI (H5)                  │
│  会话列表 │ 聊天界面 │ 任务详情 │ 文件管理       │
└──────────────────┬──────────────────────────────┘
                   │ SSE / REST
┌──────────────────▼──────────────────────────────┐
│              Agent 后端服务 (Docker)             │
│  ┌──────────────────────────────────────────┐   │
│  │  会话管理 & 模型调度器                    │   │
│  │  (模型池: ds1, ds2, ds3...)              │   │
│  └──────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────┐   │
│  │  Agent 核心循环                           │   │
│  │  (模型请求 → 工具调用 → 结果反馈)          │   │
│  └──────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────┐   │
│  │  工具执行器                               │   │
│  │  (文件/终端/fetch/web_search)            │   │
│  └──────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────┐   │
│  │  任务目录管理                             │   │
│  │  /workspace/tasks/{task_id}/             │   │
│  └──────────────────────────────────────────┘   │
└──────────────────┬──────────────────────────────┘
                   │ HTTP (SSE)
┌──────────────────▼──────────────────────────────┐
│           cli-proxy-api (上游代理)              │
│  同一 URL，多个模型 ID 映射不同账号              │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│        上游 AI 服务 (developer.amd.com.cn)      │
└─────────────────────────────────────────────────┘
```

---

## 九、数据模型设计

### 9.1 SQLite 表结构

```sql
-- 会话表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- 任务 ID，如 "task-20260830-001"
  title TEXT DEFAULT '',            -- 会话标题（可由 AI 生成或用户填写）
  status TEXT NOT NULL,             -- queued | active | held | completed | cancelled
  phase TEXT NOT NULL DEFAULT 'planning',  -- planning | execution
  model_id TEXT,                    -- 当前绑定的模型 ID（ds1/ds2/ds3），释放/排队时为空
  last_model_id TEXT,               -- 最近用过的模型；释放后新消息优先回绑，被占才另选空闲
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  held_at INTEGER                   -- 进入 held（保持租约）的时间
);

-- 消息表
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- system | user | assistant | tool
  content TEXT,                     -- 文本内容（assistant 工具调用时可为空）
  tool_calls TEXT,                  -- JSON 字符串，assistant 工具调用
  tool_call_id TEXT,                -- tool 角色消息关联的 tool_call id
  name TEXT,                        -- 工具名称（tool 角色）
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 文件表（记录任务目录中的文件，用于下载）
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  filename TEXT NOT NULL,           -- 相对任务目录的路径
  size INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 模型池配置（也可存配置文件，此处作为运行时状态）
CREATE TABLE model_pool (
  id TEXT PRIMARY KEY,              -- ds1, ds2, ds3
  display_name TEXT,
  is_busy INTEGER DEFAULT 0,
  current_session_id TEXT
);

-- 全局等待队列
CREATE TABLE wait_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### 9.2 任务目录结构

```
/workspace/tasks/
└── {task_id}/
    ├── task.md          # 需求说明（AI 在确认开始后生成）
    ├── ...              # 用户上传的文件和 AI 生成的文件
```

---

## 十、API 设计

### 10.1 会话管理

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions` | 创建会话，生成任务目录，尝试绑定模型 |
| GET | `/api/sessions` | 获取会话列表 |
| GET | `/api/sessions/{id}` | 获取会话详情（含消息、状态、阶段） |
| DELETE | `/api/sessions/{id}?delete_dir=true` | 删除会话，可选删除任务目录 |

### 10.2 消息与交互

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions/{id}/messages` | 发送用户消息（活跃时实时发送，排队时暂存） |
| GET | `/api/sessions/{id}/stream` | SSE 流式获取会话事件（模型输出、工具调用等） |
| POST | `/api/sessions/{id}/start` | 点击「开始执行」：追加 user 消息，阶段切换为 execution |
| POST | `/api/sessions/{id}/stop` | 终止任务：设置取消标志，kill 进程，释放模型 |

### 10.3 文件管理

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions/{id}/files` | 上传文件到任务目录 |
| GET | `/api/sessions/{id}/files` | 列出任务目录文件 |
| GET | `/api/sessions/{id}/files/{filename}` | 下载文件 |
| DELETE | `/api/sessions/{id}/files/{filename}` | 删除文件 |

---

## 十一、Agent 核心循环

### 11.1 伪代码

```
function runAgent(session):
    model_id = session.model_id
    messages = loadMessages(session.id)  # 完整消息历史

    while not session.cancelled:
        # 构建请求
        request = {
            model: model_id,
            messages: messages,
            stream: true,
            stream_options: {include_usage: true},
            temperature: 1.0,
            tools: TOOLS_DEFINITIONS
        }

        # 调用模型（流式）
        response = callModelStreaming(request)

        # 累积模型输出
        assistant_message = {role: "assistant", content: "", tool_calls: []}

        for chunk in response:
            if session.cancelled:
                break  # 停止处理剩余 chunk，但当前 chunk 已完成
            if chunk.delta.content:
                assistant_message.content += chunk.delta.content
                emitSSE(session, "assistant_text", chunk.delta.content)
            if chunk.delta.tool_calls:
                # 累积工具调用参数（分片拼接）
                mergeToolCalls(assistant_message.tool_calls, chunk.delta.tool_calls)

        if session.cancelled:
            break

        # 保存 assistant 消息
        saveMessage(session, assistant_message)

        # 检查是否有工具调用
        if assistant_message.tool_calls and len(assistant_message.tool_calls) > 0:
            # 执行所有工具调用（可并行）
            tool_results = []
            for tool_call in assistant_message.tool_calls:
                if session.cancelled:
                    break
                emitSSE(session, "tool_call", tool_call)
                result = executeTool(tool_call, session)  # 可能触发 kill
                emitSSE(session, "tool_result", result)
                tool_results.append({
                    role: "tool",
                    tool_call_id: tool_call.id,
                    content: result
                })
                saveMessage(session, tool_results[-1])

            # 将工具结果加入消息历史
            messages.append(assistant_message)
            messages.extend(tool_results)
            continue  # 继续循环，让模型处理工具结果
        else:
            # 无工具调用，任务结束
            break

    # 释放模型
    releaseModel(session)
    session.status = "completed"  # 或 "cancelled"
    updateSession(session)

    # 检查等待队列
    dispatchNextQueuedSession()
```

### 11.2 工具执行器要点

- **文件工具**：所有路径必须解析到任务目录内（防路径穿越）。
- **terminal**：使用 `child_process.spawn`，设置超时（默认 30s），输出截断（前 10000 字符）。支持 kill。
- **fetch**：使用 HTTP 客户端抓取，转换为 Markdown 返回。
- **MCP 工具**：外部 MCP 服务在 config 的 `mcp_servers` 配置（url + headers，可多个）；启动时 `tools/list` 发现工具追加到内置工具之后，调用经 `tools/call` 转发（如 web_search）。

### 11.3 模型调度器要点

- 维护模型池状态（is_busy、current_session_id）。
- 会话创建时尝试分配空闲模型。
- 模型释放时从 wait_queue 取最早会话绑定，并发送暂存消息。
- 同一会话内所有模型请求使用同一 model_id。

---

## 十二、前端页面设计

### 12.1 页面结构

```
┌──────────────────────────────────────────┐
│  顶部栏：任务状态开关 + 新建会话按钮      │
├──────────────────────────────────────────┤
│  主区域：                                 │
│  ├─ 会话列表（左侧或抽屉）               │
│  └─ 聊天/任务详情（右侧主视图）          │
│      ├─ 消息气泡（用户/AI/工具调用）     │
│      ├─ 文件上传按钮                     │
│      ├─ 文件列表                         │
│      └─ 输入框                           │
└──────────────────────────────────────────┘
```

### 12.2 移动端交互

- 会话列表与详情通过滑动切换（参考采购清单页交互）。
- 状态开关固定在顶部，规划阶段显示「▶ 开始执行」，执行阶段显示「■ 终止」。
- 排队中时 AI 头像灰色，输入框仍可输入，发送后消息进入暂存队列。

### 12.3 消息展示

- 用户消息：右侧气泡。
- AI 文本：左侧气泡，流式显示。
- 工具调用：特殊卡片，显示工具名和参数摘要。
- 工具结果：折叠显示，可展开查看完整输出。

---

## 十三、Docker 部署

### 13.1 Docker Compose（顶层 `docker-compose.yml`）

```yaml
services:
  agent:
    build: ./app
    restart: unless-stopped
    ports:
      - "${AGENT_PORT:-8090}:8080"      # 直接映射宿主机端口，IP:端口 访问
    volumes:
      - ./tasks:/workspace/tasks        # 持久化：任务目录
      - ./data:/workspace/data          # 持久化：数据目录 + SQLite
      - ./config.yml:/app/config.yml
    environment:
      - PORT=8080
      - AGENT_CONFIG=/app/config.yml
    networks:
      - agent-mcp-net

networks:
  agent-mcp-net:
    name: agent-mcp-net      # 由本仓库创建（固定名字）；mcp 侧 external 加入
    driver: bridge
```

### 13.2 对外暴露（IP:端口）

无域名/反代时，compose 直接把容器 8080 映射到宿主机 8090，浏览器访问 `http://<服务器IP>:8090`（端口可用 `.env` 的 `AGENT_PORT` 改）。网络 `agent-mcp-net` 与 `mcp` 仓库的服务共用、由本仓库创建（无需手动 `docker network create`，但因此要**先起 agent 再起 mcp**）：core 与 executor 都靠它按容器名访问 MCP。认证用应用内置的多用户登录（`config.yml` 的 `auth.users`，登录页 `/login`），多用户共享同一任务库，不做任务隔离。

**对外只开这一个端口**（executor 与 mcp 服务都不映射宿主机）。其中一条是反向入站：外部服务（如智谱）生成视频前要拉参考图，走的是 core 的匿名短链 `GET /p/<id>`——由 AI 在内网 `curl http://agent-core:8081/public-link?path=…` 现签（签发端口不映射宿主机，所以不需要凭据），见 `docs/DEPLOY.md` 第 4.1 节。

HTTP 直连时浏览器不认为这是“安全上下文”：PWA/Service Worker 不注册、`navigator.clipboard` 降级（前端已有回退），登录 cookie 无 `Secure` 标志可正常工作。日后若加 HTTPS 反代，**SSE 需关代理缓冲**（`proxy_buffering off`），详见 `docs/DEPLOY.md`。

---

## 十四、配置文件示例

```yaml
# 模型池:平台(platforms) → Key → 模型 三层。url/type 配在平台,api_key/concurrency 配在 Key,
# 模型只声明 {id, display_name, vision}。加载时打平成全局模型列表。
platforms:
  - name: proxy-a
    url: "https://proxy-a.example.com/v1"
    type: openai                    # openai/deepseek/custom,决定余额查询适配器(预留)
    keys:
      - api_key: "sk-..."
        concurrency: 1              # 该 Key 并发会话数,默认 1(当前仅记录,未参与调度)
        models:
          - id: ds1
            display_name: "AMD DeepSeek 1"
            # vision: true          # 选填,默认 false
  - name: proxy-c
    url: "https://proxy-c.example.com/v1"
    type: custom
    keys:
      - api_key: "sk-..."
        models:
          - id: ds3
            display_name: "AMD DeepSeek 3"

workspace_root: "/workspace/tasks"

terminal:
  default_timeout_ms: 30000
  max_output_chars: 10000

agent:
  temperature: 1.0
  max_tool_iterations: 50
```

---

## 十五、开发阶段规划

1. **阶段一：核心后端**
   - 数据模型与 SQLite 初始化
   - 会话管理 API
   - 模型池与调度器
   - Agent 核心循环（支持工具调用）

2. **阶段二：前端**
   - 会话列表页
   - 聊天界面（SSE 流式）
   - 文件上传/下载
   - 状态开关

3. **阶段三：集成与部署**
   - Docker 化
   - nginx-proxy 集成
   - 基本认证
   - 测试与优化

---

## 十六、备注

- 本方案借鉴 Zed agent 的 system prompt 和工具定义，保持格式一致以利用上游前缀缓存。
- `skill` 和 `spawn_agent` 工具暂不实现，但预留扩展位。
- 所有文件操作必须限制在任务目录内。
- 模型调度遵循 FIFO，同一会话始终使用同一模型 ID。

---

**文档版本**：v1.0  
**最后更新**：2026-08-30
