## Context

动机与证据见 `proposal.md`。当前实现是 290 行 JS 草稿（MCP stdio 客户端 + 工具注册 + 注入），只存在于三份 `node_modules` 副本中。

已在本机 `@deepseek-ai/dsh` 核实存在的扩展点：`agent/session-start`、`assistant/message`、`agent/turn-stopping`、`session/event`（持久事件含 `compaction/start`、`compaction/summary`）、`ctx.systemPrompt.section()`。先例：`dsh-context-mode-precompact`（监听 `session/event` 的 `compaction/start`）。

## Goals / Non-Goals

**Goals:** P0 两项能力（会话绑定、被动捕获）+ 单一源交付 + 失败降级；保持零运行时依赖。

**Non-Goals:** P1 的上下文注入与 compaction 恢复（本期只保留扩展点与回归清单）；prompt 捕获；工具面收敛到 18 个。

## Decisions

1. **engram session id 使用 dsh 的会话标识**，而不是让 engram 自行合成。理由：天然一一对应、可追溯；engram 已支持 `mem_session_start({id, project, directory})`。替代方案（现状：不传 session_id）会导致所有保存串到"最近一个 session"。
2. **在 `agent/session-start` 建 session，而非首次保存时懒建**。理由：`directory` 只有此时可靠；懒建会把目录写成 engram 服务进程的 cwd（`$HOME`）。
3. **被动捕获挂 `assistant/message`**，而不是扫描最终文本。理由：能拿到完整消息与去重边界。去重键 = (session_id, message_id)。
4. **捕获失败静默降级**（只记日志）。理由：记忆是 bookkeeping，不能影响用户可见回复（与 engram 官方 DELIVERY GUARANTEE 同精神）。
5. **零运行时依赖，自实现最小 JSON-RPC 客户端**。理由：草稿已验证；避免把 MCP SDK 的版本约束引进 dsh profile。
6. **不新增 dsh 会话事件类型**。理由：未标记的未知事件类型会让会话日志报 `SessionFormatUnsupportedError`（theseus 已踩过）。
7. **KV cache**：P0 不注入任何 system prompt 段，故无影响；P1 再讨论"按会话缓存一次"。

## Risks / Trade-offs

- [engram 升级到 v2 会改 session/ownership 语义] → 交付时附 `docs/engram-upgrade-checklist.md`，升级前跑一遍。
- [`assistant/message` 的载荷字段可能与假设不符] → 任务 1.1 先用探针插件 dump 真实字段，再实现。
- [被动捕获重复计数] → (session_id, message_id) 去重 + 单回复一次。
- [`link:` 安装让 profile 依赖本地路径] → 个人项目可接受；若日后发布则改为正式包。

## Migration Plan

1. 仓库 + P0 实现 + 测试通过（`pnpm typecheck && pnpm test && pnpm build`）。
2. `dsh plugin --profile {web,headless,open-design} add <repo>`，确认生成 `link:` 依赖。
3. 删除 `~/.dsh/cordis.patch.yml` 里的手写 `insert`，保留对 `engram-bridge` 的 config 覆盖。
4. 删除三份 `node_modules/dsh-engram-session-v2/`（先备份到 `~/engram-backups/`）。
5. 验收：新会话建 session / Key Learnings 落库 / 卸载无残留。

**回滚**：恢复手写 `insert` + 三份副本目录，重启 dsh。

## Open Questions

无阻塞项。`assistant/message` 的载荷字段在任务 1.1 的探针中确认后再写实现。
