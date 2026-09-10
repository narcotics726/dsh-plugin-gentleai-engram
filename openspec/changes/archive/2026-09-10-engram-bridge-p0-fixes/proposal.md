## Why

P0/P1 交付的能力表里有三项在运行时从未生效：被动捕获与压缩恢复读错了宿主事件的形状（dsh 会话事件是信封 `{type, seq, time, data}`，插件读顶层字段 → 恒 `undefined`），连接池的空闲回收没有任何调用者（`sweep()` 只在单测里被调）。而默认门禁 54 tests 报「50 pass / 4 skipped」全绿：唯一触碰这两条缝的 `live-wiring` 就在那 4 个 skip 里，`turnFinalText` 零覆盖。结果是「spec 有 SHALL、README 有宣称、运行时没接线」，且失败是静默的。

## What Changes

- **事件读取改经信封**：读取侧改为读 `event.data.*`，并以宿主生成的 `SessionEvent` 类型约束读取侧（`import type`，不进运行时依赖）——形状再变会是 `pnpm typecheck` 失败，而不是静默 `undefined`。压缩事件类型由 `@deepseek-ai/dsh-compaction` 经声明合并提供，该包以**显式钉死版本**的 devDependency 引入（禁止用 `latest`）。
- **失配必须响亮且级别固定**：载荷缺失**或读取点字段缺失/类型不符**时记 warn 级日志，限流范围为**每会话每事件类型至多一条**；空摘要同样不静默（不提交 + 带 `compactionId` 的一条 warn）。
- **被动捕获改为单一写入者**：桥**不注册** `mem_capture_passive`（engram 声明的 N 个工具里注册 N-1 个），因此它不出现在任何 agent 的模型可见清单里，被调用时由宿主以未知工具错误拒绝；桥自己的回合收尾捕获不经工具面，是唯一写入者。落库判据统一为 `tool_name='dsh-turn-stopping'`（该映射已由隔离实验证实，见 design Context）。
- **空闲回收接线**：定时驱动 sweep（新配置 `poolSweepIntervalMs`，默认 60000、下限 1000，缺键也要按默认生效），连接池新增「在用」计数与**结算时刷新空闲时钟**；空闲回收不关闭在用连接，连接上限的淘汰仍按上限执行（不因忙碌豁免）。
- **顺带补齐同类时序缺口**：工具面注册晚于子 agent 创建时，注册完成后对已存在的子 agent 补装遮蔽（原实现只依赖创建时的名单，为空时静默跳过）。**该机制先做 spike 验证，不可行则按 design D8 的降级路径处理。**
- **测试闸门**：默认门禁新增两类装置——用宿主真实 `Context` + `SessionStore` 产出**真信封**的契约测试，以及一个**桩 engram**（最小 stdio MCP server，隔离 `$DSH_HOME`），使「摘要真的被提交」「召回真的被注入」在默认门禁里也能断言；`live-wiring` 的 fixture 同步改为信封形状。

**验收（可观察）**：

- **落库前置校验**：先用隔离 `ENGRAM_DATA_DIR` 跑一次「`mem_capture_passive` 带 marker source → 查库」确认当前 engram 版本仍把 `source` 落进 `tool_name`（本机已实测成立）；该前置失败时判据改为按 `title`/`content` 定位，而不是当成功能没修好。
- **捕获（真机）**：`pnpm build` 后重启 dsh，按固定话术走两个回合——明确要求每回合输出**至少一条**、≥28 字符、且两回合文本不同的学习条目；判据为**存在性 + 增量**：turn1 后该会话出现 `tool_name='dsh-turn-stopping'` 的条目，turn2 后计数 **大于** turn1 后的计数。**不用「恰好一条」这类会被 LLM 输出条数（0/2 条）直接打崩的绝对计数**，回合级"至多一次"由单测（`test/capture.test.ts:33-45`）与桩测试承担。
- **单一写入者（真机，相对判据）**：解压本会话 `request/header` 事件的 `data.header.system` 声明块（web/ptc 档下 `data.header.tools` 只有 `run_code`）：`mcp__engram__mem_capture_passive` 出现 **0 次**，且 `mcp__engram__*` 唯一名字数 == 从 `~/.dsh/storages/engram-bridge/tools.json` 读到的声明数 **减 1**（不写死 22）。前提写在判据里：按 `mcp__engram__` 前缀计数（AGENTS.md 里的裸名不计入），且基线实测该声明块不含 AGENTS.md 文本。
- **被拒调用（测试层，非真机）**：在接线/桩测试里经宿主派发直接调用该工具名，断言得到未知工具错误且桩 engram 未收到调用。真机不做这一条——模型看不到它，无法可靠制造这种调用。
- **压缩后**：桩 engram 记录到该会话的摘要提交，且 `compaction/end` 之后注入一段不超过 `recoveryTokenBudget` 的记忆；真机同一判据在 engram 的 `sessions.summary` 上可查。
- **连接池**：空闲超过 `poolMaxIdleMs` 的连接被关闭；在用连接不被空闲回收、且结算后重新计时；调用超时只表示桥不再等待——**不重试、不重复提交**，engram 侧可能迟到落库（SQLite 事务保证无半写）；上限淘汰是例外（仍按上限执行，被淘汰连接上的在途调用以错误结算并记一条 warn）。
- 默认 `pnpm test`（不设 `ENGRAM_LIVE`）即覆盖上述两条缝的读取与接线、压缩缝的提交与注入，且不污染真实 `$DSH_HOME`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `engram-bridge-runtime`：ADDED「宿主会话事件载荷契约」「空闲回收由插件自主驱动」；MODIFIED「工具面注册」（不注册被动捕获工具，主 agent 看到 N-1 个）、「工具面缓存与首个请求可见」（缓存保留原始声明、注册面为 N-1）、「空闲回收与连接上限」（在用保护、结算刷新时钟、上限淘汰不豁免并承认代价）、「子 agent 遮蔽」（注册晚于创建时补齐遮蔽）。
- `engram-passive-capture`：ADDED「模型侧不得直接提交被动捕获」（不注册该工具 + 调用被拒 + 桥自身捕获不受影响）。
- `engram-compaction-recovery`：ADDED「空摘要不静默」（不提交、带 `compactionId` 的一条 warn、不影响同次压缩的 `compaction/end` 处理）。

## Impact

新增 `src/host-events.ts`；改 `src/index.ts`（读取侧、定时器接线与卸载、注册完成后补齐子 agent 遮蔽）、`src/pool.ts`（`withConnection` 与在用计数、结算刷新时钟、定时 sweep、上限淘汰）、`src/subagent.ts`（补齐遮蔽的入口）、`src/compaction.ts`（空摘要告警）、`src/config.ts`（`poolSweepIntervalMs`）、`src/tools.ts`（注册面去掉被动捕获）；测试侧新增契约测试与桩 engram fixture（须隔离 `$DSH_HOME`），`live-wiring` fixture 改形状；`package.json` 增 devDependency `@deepseek-ai/dsh-compaction`（**必须显式指定 `0.1.2-rc.1`，不得依赖 dist-tag**；该包声明的 cordis / dsh-llm / dsh-brand / dsh-session / dsh-commands / dsh-invariants 等 peer 会因 `autoInstallPeers: true` 连带进 dev 树，运行时 `dependencies` 不变）。不改 engram 二进制、DB schema 或云同步；不新增会话事件类型。
