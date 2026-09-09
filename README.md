# dsh-plugin-gentleai-engram

> **非官方（unofficial）**：本仓库是第三方为 DeepSeek Harness 写的接入层，不是 Gentleman Programming 的官方项目。

把 [engram](https://github.com/Gentleman-Programming/engram)（本地 SQLite 持久记忆，agent-agnostic）以 **Cordis 插件**形式接入 **dsh**，补齐官方 Claude Code / OpenCode / Pi 插件才有、而 dsh 侧一直缺失的三件事——这正是 engram 官方文档 [What you lose without a plugin](https://engram.gentlemanprogramming.com/agent-setup/other-mcp-agents/) 列出的三项：**生命周期钩子、会话编排、压缩恢复**。

定位是**接入层**，不是记忆系统：不 fork engram、不改它的 DB、不做检索/图谱/清理策略。

## 为什么需要它

2026-09-09 在本机实测（`~/.engram/engram.db` + 旧草稿插件）：

| 缺口 | 实测证据 |
| --- | --- |
| 记忆串档 | 新记忆全部落进该项目**最近一个** session；`engram doctor` 报 `session_project_directory_mismatch` |
| 被动捕获从未发生 | `~/.dsh/AGENTS.md` 声称 `## Key Learnings:` 会被自动保存，DB 里 0 条 |
| 压缩后无恢复 | 压缩只留 `session/event compaction/*`，没有任何钩子把摘要写回记忆 |

根因是 dsh **单进程服务多个工作区**，而 engram 的 project 默认取**它自己进程的 cwd**：实测 `mem_current_project` 返回的是另一个项目。更麻烦的是 `mem_capture_passive` / `mem_session_end` **只认 cwd 且忽略 session**，所以单一进程无论怎么注入参数都必然把记忆写进错误的项目。

## 提供什么

| 能力 | 行为 |
| --- | --- |
| 按工作区连接池 | 每个会话工作区一个 engram 子进程（cwd = 工作区），懒启动、single-flight、串行启动 + 重试、空闲回收、上限淘汰 |
| 会话绑定 | `agent/session-start` → `mem_session_start({id: dsh 会话 id, directory: 工作区})`，读回 engram 解析的 project；绑定是工具调用的屏障 |
| 隐式参数注入 | 声明 `project` / `session_id` 的工具自动带上正确值；显式传参优先；`mem_save_prompt` 的 `project` 例外（只用于歧义恢复） |
| 被动捕获 | `agent/turn-stopping` 把回合最终回复交给 `mem_capture_passive`，每回合一次（steer 二次触发也去重）；中止的回合不触发该钩子，天然跳过 |
| 压缩恢复 | `compaction/summary` → `mem_session_summary`（摘要内容直接用，不自己生成）；`compaction/end` 后注入一段有界记忆上下文 |
| 子 agent 遮蔽 | 子 agent 会话中 engram 工具从模型可见工具面消失，经 `mcp_call` 之类旁路调用也会被拒 |
| 失败降级 | engram 缺失 / 握手失败 / 超时 → 零注册 + 一条日志，不阻断模型轮次 |

## Model Experience

本插件对模型输入的影响（dsh 插件 README 规范要求）：

- **工具**：把 engram 声明的工具以 `mcp__engram__*` 注册进 dsh，名称、描述、参数 schema 与 engram 声明一致（本机 1.20.0 为 22 个）。
- **隐式参数**：为声明 `project` 的工具注入项目名；`mem_session_start` 注入 `directory`；声明 `session_id` 的工具注入当前 dsh 会话 id。**调用方显式传参一律不覆盖**。
- **提示词**：P0 **不新增**任何 system prompt 段（KV cache 无影响）；压缩恢复通过 `agent.inject()` 注入一条 user 消息，落在会话日志里可重建。
- **会话日志**：**不新增**事件类型（未标记的未知事件类型会让 dsh 会话日志报 `SessionFormatUnsupportedError`）。
- **子 agent**：engram 工具对子 agent 不可见，也不为其建立 engram 会话。
- **失败**：engram 不可用时相关能力失效并记日志，**不阻断**模型轮次。

## 安装

```bash
# 三个 profile 都要装（以 link: 方式）
dsh plugin --profile web         add <repo>
dsh plugin --profile headless    add <repo>
dsh plugin --profile open-design add <repo>
```

包自带 `dsh.bundle.patch`（`cordis.patch.yml`），安装后由它插入 `engram-bridge` entry。
`~/.dsh/cordis.patch.yml` **只保留对该 entry 的 config 覆盖**，不要再手写 `insert`。

> **迁移注意**：旧的手抄副本 `dsh-engram-session-v2` 与本插件都注册 `mcp__engram__*`，**不能并存**（同层重名会让注册失败）。切换必须"装新 + 关旧"在同一次重启前完成。

## 配置

| key | 默认 | 说明 |
| --- | --- | --- |
| `command` | 必填 | engram 可执行文件路径（如 `/opt/homebrew/bin/engram`） |
| `args` | `["mcp"]` | 传给 engram 的参数 |
| `env` | `{}` | 叠加到最小继承环境之上的额外变量 |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 调用超时 |
| `poolMaxConnections` | `8` | 同时活跃的 engram 子进程上限（按工作区） |
| `poolMaxIdleMs` | `600000` | 空闲多久关闭该工作区的连接 |
| `projectOverrides` | `{}` | 工作区绝对路径 → engram 项目名，优先级最高 |
| `injectSessionProject` | `true` | 是否注入 `project` / `directory` |
| `injectSessionId` | `true` | 是否注入 `session_id` |
| `capturePassive` | `true` | 是否解析回合收尾的 `## Key Learnings:` 并送 `mem_capture_passive` |
| `compactionRecovery` | `true` | 压缩时持久化摘要并在压缩后注入记忆 |
| `recoveryTokenBudget` | `800` | 压缩后注入的 token 预算 |

项目名解析顺序：**显式参数 > `projectOverrides` > 该会话由 engram 解析出的项目名 > `ENGRAM_PROJECT` > 不注入**。插件**永不**用目录名兜底——engram 对未认账的项目名会硬失败（实测 `unknown_project`）。

## 开发

```bash
pnpm install
pnpm typecheck              # tsc --noEmit
pnpm test                   # 构建后跑单测
ENGRAM_LIVE=1 pnpm test     # 追加真实 engram 集成测试（临时 ENGRAM_DATA_DIR，不碰 ~/.engram）
pnpm build                  # tsc → dist/
```

加载/卸载验证：

```bash
dsh --profile web --dump-config | grep engram-bridge   # 应恰好出现一次
dsh web                                                # 看启动日志中的插件加载行
```

## Spec-first

走 OpenSpec（`openspec/`），但**不走 Theseus 完整工作流**（无 gate 链）。当前变更：`openspec/changes/engram-bridge-p0/`。

```bash
openspec list
openspec validate engram-bridge-p0 --strict
openspec view
```

## 与 engram 版本的关系

当前针对 engram **1.20.0**（本机 Homebrew 版）。升级前请按 `docs/engram-upgrade-checklist.md` 回归——本插件的关键行为依赖 engram 的解析与 session 语义，而这些语义在版本间有过变化（例如文档声明"已结束会话不可重开"，1.20.0 实测却可重开）。
