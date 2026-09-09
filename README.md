# dsh-plugin-gentleai-engram

> **非官方（unofficial）**：本仓库是第三方为 DeepSeek Harness 写的接入层，不是 Gentleman Programming 的官方项目。

把 [engram](https://github.com/Gentleman-Programming/engram)（本地 SQLite 持久记忆，agent-agnostic）以 **Cordis 插件**形式接入 **dsh**，补齐官方 Claude Code / OpenCode / Pi 插件才有、而 dsh 侧一直缺失的四件事。

定位是**接入层**，不是记忆系统：不 fork engram、不改它的 DB、不做检索/图谱/清理策略。

## 为什么需要它

2026-09-09 在本机实测（`~/.engram/engram.db` + 当时的 `dsh-engram-session-v2` 草稿）：

| 缺口 | 实测证据 |
| --- | --- |
| session 边界未切分 | 新记忆全部落进该项目**最近一个** session；该 session 的 `directory` 属于另一个工作区（`engram doctor` 报 `session_project_directory_mismatch`） |
| 被动捕获从未发生 | `~/.dsh/AGENTS.md` 声称 `## Key Learnings:` 会被自动保存，但 DB 里 `mem_capture_passive` 记录 **0 条** |
| compaction 无恢复 | 只有 AGENTS.md 的文字指示，没有任何 hook |
| 无上次上下文注入 | 会话开始不注入，靠 agent 主动调 `mem_context` |

engram 官方 `engram setup` 覆盖 12 个 agent，**不含 dsh**；上游仓库检索 `cordis` 零命中（无 issue、无 PR、无 roadmap 项）。

## 提供什么（分期）

- **P0（本期）** — session 绑定（`agent/session-start` → `mem_session_start`，并把 dsh 会话 id 注入所有接受 `session_id` 的 engram 工具）；被动捕获（`assistant/message` → `## Key Learnings:` → `mem_capture_passive`）；以 dsh bundle 包**单一源**交付，替换三份手抄副本。
- **P1** — compaction 恢复（`compaction/start` / `compaction/summary` → `mem_session_summary`）；上次会话上下文注入（`ctx.systemPrompt.section()`，带 token 预算与 KV cache 策略）。
- **P2** — prompt 捕获（隐私开关）；工具面从 22 收敛到 18（agent 档）。

## 非目标

- 不改 engram 后端（不 fork、不打 patch、不直接写库）。
- 不做记忆系统本身（检索、向量、图谱、清理/遗忘策略）。
- 不接管云同步（engram 自带 cloud autosync）。

## 安装

```bash
dsh plugin --profile web add <repo>
# 三个 profile 都要装
dsh plugin --profile headless add  <repo>
dsh plugin --profile open-design add <repo>
```

包自带 `dsh.bundle.patch`（`cordis.patch.yml`），安装后由它插入 `engram-bridge` entry。
`~/.dsh/cordis.patch.yml` **只保留对该 entry 的 config 覆盖**（`command` / `args` / `projectOverrides` …），不要再手写 `insert`，否则重复。

## 配置

| key | 默认 | 说明 |
| --- | --- | --- |
| `command` | `/opt/homebrew/bin/engram` | engram 可执行文件路径 |
| `args` | `["mcp"]` | MCP 子命令参数 |
| `env` | `{}` | 传给 engram 进程的额外环境变量 |
| `projectOverrides` | `{}` | 工作区绝对路径 → engram 项目名 |
| `injectSessionProject` | `true` | 是否注入 `project` / `directory` |
| `injectSessionId` | `true` | 是否注入当前 dsh 会话 id |
| `capturePassive` | `true` | 是否解析 `## Key Learnings:` 并送 `mem_capture_passive` |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 调用超时（毫秒） |

## Model Experience

本插件对模型输入的影响（dsh 插件 README 规范要求）：

- **工具**：把 engram 的 MCP 工具以 `mcp__engram__*` 注册进 dsh（P0 保持 22 个不变）。
- **隐式参数**：为声明 `project` 的工具注入项目名；`mem_session_start` 注入 `directory`；声明 `session_id` 的工具注入当前 dsh 会话 id。调用方显式传参时一律不覆盖。
- **提示词**：P0 **不新增**任何 system prompt 段，因此对 KV cache 无影响；P1 才引入按会话缓存的记忆上下文。
- **会话日志**：**不新增**事件类型（未标记的未知事件类型会让 dsh 会话日志报 `SessionFormatUnsupportedError`）。
- **失败**：engram 不可用时相关能力失效并记日志，**不阻断**模型轮次。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # node --test
pnpm build       # tsc → dist/
```

加载/卸载验证：

```bash
dsh --profile web --dump-config | grep engram-bridge   # 应恰好出现一次
dsh web                                                # 看启动日志中的插件加载行
```

## Spec-first

走 OpenSpec（`openspec/`），但**不走 Theseus 完整工作流**（无 gate 链）。当前变更：`openspec/changes/engram-dsh-bridge-p0/`。

```bash
openspec list
openspec validate engram-dsh-bridge-p0 --strict
openspec view
```

## 与 engram 版本的关系

当前针对 engram **1.20.0**（本机 Homebrew 版）。v2.0.0-rc 线带来 session/ownership 语义变化与 CJK 检索，升级前按 `docs/engram-upgrade-checklist.md` 回归（P0 的 session 绑定逻辑对 `sessions` 语义敏感）。
