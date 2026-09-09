## Why

dsh 侧对 engram 只有「bare MCP + project 注入 shim」：记忆全落进该项目最近一个 session（`engram doctor` 报 `session_project_directory_mismatch`）、被动捕获 0 条、压缩后无恢复；插件仅以三份手抄副本存在于 profile 的 `node_modules/`。本 change 三项都解决。

## What Changes

- 以 dsh bundle 包交付替换三份副本；零运行时依赖，自实现最小 MCP stdio 客户端。
- 按工作区池化 engram 子进程（cwd = 会话工作区）：`mem_capture_passive` / `mem_session_end` 只认 cwd，单进程多工作区必然写错项目。
- 会话绑定：`agent/session-start` → `mem_session_start({id, directory})` 并读回 project；向声明 `session_id` 的工具注入会话 id。
- 隐式参数：project 由 engram 解析一次后缓存，此后全程显式注入，显式传参优先。
- 被动捕获：`agent/turn-stopping` 把回合最终回复交给 `mem_capture_passive`，每回合一次、跳过中断回合。
- 压缩恢复：监听 `session/event` 的 `compaction/summary` 把摘要写入 engram 会话摘要，`compaction/end` 后注入一段有界记忆上下文。
- 子 agent 遮蔽：子 agent 会话中 engram 工具不可见。
- 失败降级：engram 缺失 / 握手失败 / 超时 → 能力失效并记日志，不阻断轮次。

**验收**：新会话在 `sessions` 表出现且 directory 正确；两会话各存一条互不串档；含学习条目的回合落库恰好一次；压缩后摘要落库且后续请求含记忆上下文；`engram doctor` 无 mismatch；停用后 `--dump-config` 无 `engram-bridge` 且无孤儿进程。

## Capabilities

### New Capabilities

- `engram-memory-continuity`: 会话级记忆归属、学习条目落库、不可用不阻断、写入范围限定。
- `engram-bridge-runtime`: 按工作区连接池、工具面、超时 / 取消、配置校验、卸载、降级日志。
- `engram-session-binding`: 会话建立与幂等、按 `source` 行为、会话隔离、`session_id` 注入。
- `engram-context-injection`: 项目解析委托与注入优先级、`mem_save_prompt` 例外、`directory` 注入、开关。
- `engram-passive-capture`: 捕获挂点与粒度、跳过中断、归属、可见输出不变、可观测、开关。
- `engram-compaction-recovery`: 压缩摘要持久化、压缩后记忆注入、幂等、开关与降级。

### Modified Capabilities

（无）

## Impact

新增 `src/`、测试与构建产物；`~/.dsh/cordis.patch.yml` 改为对 `engram-bridge` entry 的 config 覆盖；三个 profile 的 `node_modules/dsh-engram-session-v2/` 退役。不改 engram 二进制与 DB；仅 Node 内置模块。
