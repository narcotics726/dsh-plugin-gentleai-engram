## Why

dsh 侧的 engram 接入目前只是「bare MCP + project 注入 shim」：没有 session 生命周期、没有被动捕获、没有 compaction 恢复、没有上次上下文注入。2026-09-09 实测三条证据：

1. 新记忆全部落进该项目**最近一个** session，且该 session 的 `directory` 属于另一个工作区（`engram doctor` 报 `session_project_directory_mismatch`）；
2. `~/.dsh/AGENTS.md` 声称 `## Key Learnings:` 会被自动保存，但 DB 里 `mem_capture_passive` 记录 **0 条**；
3. compaction 恢复只有文字指示，没有任何 hook。

同时插件本身只以三份手抄副本存在于各 profile 的 `node_modules/`，无源码仓库、无版本、无测试。上游无 dsh 支持计划（`engram setup` 覆盖 12 个 agent 不含 dsh，仓库内检索 `cordis` 零命中），因此需要自建。

## What Changes

- 新建独立仓库，以 **dsh bundle 包**交付（`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml` 提供 `engram-bridge` entry），用 `dsh plugin --profile <p> add <path>` 以 `link:` 安装，**替换三份手抄副本**。
- **P0-1 会话绑定**：`agent/session-start` → `mem_session_start`（`directory` = 会话工作区）；把 dsh 会话 id 注入所有声明 `session_id` 的 engram 工具。
- **P0-2 被动捕获**：`assistant/message` 检测 `## Key Learnings:` → `mem_capture_passive`，按 (session_id, message_id) 去重。
- 保留草稿已验证的能力：MCP stdio 客户端、22 个工具注册、`project` / `directory` 注入、超时与 abort。
- **失败降级**：engram 缺失 / 握手失败 / 调用超时 → 相关能力失效并记日志，**不阻断**模型轮次。

## Capabilities

### New Capabilities

- `engram-bridge`: engram 后端与 dsh 会话之间的绑定与捕获契约——会话生命周期绑定、项目注入、任务学习被动捕获、单一源交付、失败降级。

### Modified Capabilities

（无）

## Impact

- 新增仓库 `~/workspace/dsh-plugin-gentleai-engram`；**不修改** engram 二进制或 DB。
- 修改 `~/.dsh/cordis.patch.yml`：删除手写 `insert`，改为对 `engram-bridge` entry 的 config 覆盖。
- 三个 profile（`web` / `headless` / `open-design`）的 `node_modules/dsh-engram-session-v2/` 目录退役。
- 依赖：仅 Node 内置模块（无运行时依赖）；devDeps 为 `typescript` + `@types/node`。
