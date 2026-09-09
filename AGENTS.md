# AGENTS.md — dsh-plugin-gentleai-engram

## 这是什么

dsh（Cordis）插件：把 engram MCP 后端接入 dsh。**接入层，不是记忆系统。**

## 硬规则（dsh-plugin-dev 标准）

1. **接口以生成参考为准**。事件签名（`agent/session-start`、`assistant/message`、`agent/turn-stopping`、`session/event` 的 `compaction/*`）与 ctx 键以本机 `@deepseek-ai/*` 生成物为准，不要凭记忆或旧代码推断。
2. **所有贡献都是副作用**。注册一律走 ctx（`ctx.on` / `ctx.tools.register` / `ctx.effect`），卸载必须干净；模块作用域不得创建进程级副作用。
3. **waterfall 监听器必须 `await next()`**（除非有意短路）。
4. **失败要响亮**：配置非法在加载时抛错；engram 不可用时对**会话**降级，但日志必须明确。
5. **配置一律 Schemastery**：导出 `interface Config` + 同名 `Schema`，默认值写进 schema。
6. **模型可见即已记录**：任何新增的模型可见输入必须能被会话日志重建；**禁止新增未标记的 session 事件类型**（会 brick 会话日志，theseus 已踩过）。
7. **运行时依赖仅限 host 提供的 `@deepseek-ai/*`**：目前只有 `@deepseek-ai/schemastery`（配置校验，硬规则 5 强制）与 `@deepseek-ai/dsh-llm`（`createUserMessage`，压缩恢复注入用）；其余一律 Node 内置模块——MCP 走 stdio，自实现最小 JSON-RPC 客户端（沿用草稿的已验证实现）。不引第三方运行时依赖（先例：`dsh-plugin-theseus-crew` 同样只依赖 `@deepseek-ai/schemastery`）。

## 流程（spec-first，轻量）

- 任何**行为**变更先写 `openspec/changes/<change>/`（proposal → specs → design → tasks），再动代码。
- 命令：`openspec list` / `openspec validate <change> --strict` / `openspec view`。
- 完成后 `openspec archive <change>`，specs 落到 `openspec/specs/`。
- 不走 Theseus 的 gate 链（那是 intranet-aio 的纪律，不是这里的）。

## 命令

```bash
pnpm typecheck && pnpm test && pnpm build
```

- 加载验证：`dsh --profile web --dump-config | grep engram-bridge`（恰好一次）→ 启动 `dsh web` 看加载日志。
- 卸载验证：停用后 `--dump-config` 无残留，且会话不报错。

## 禁止

- **不要手改** `~/.dsh/profiles/*/node_modules/`（三副本时代已结束：改仓库 + `dsh plugin --profile <p> add <path>`）。
- 不要修改 engram 的 DB schema，也不要用 SQL 直接写 `~/.engram/engram.db`。
- 不要把 engram 的失败升级成会话失败（记忆是 bookkeeping，用户可见回复优先）。
