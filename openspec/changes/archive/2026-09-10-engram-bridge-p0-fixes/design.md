## Context

两条缝从未生效（见 proposal.md - Why）。本设计只依赖下面这些**实测/已读**事实；每条标注它是"实测"还是"源码读取"，不做未标注的推断：

| 事实 | 类型 | 位置 / 证据 |
|---|---|---|
| 宿主事件是信封 `{type, seq, time, data, …surfaceMetadata}` | 源码 | `@deepseek-ai/dsh-session/lib/index.js:1416-1422` |
| `snapshotEvents()` 原样返回信封；`session/event` 监听器收到 `[session, envelope]` | 源码 | 同文件 `:1342-1347`、`:1427-1435` |
| 真实日志的信封 key | 实测 | 真实会话 `session-632a0f3e`：`assistant/message` = `[type,seq,time,data,sourceEventSeqs,surfaceOp]`、`data={turn,step,message,usage}` |
| `agent/turn-stopping` 载荷是 `{agent, turn, signal}`；`agent/session-start` = `{agent, source}`；`agent/created` = `{agent}` | 源码 | `dsh-agent/lib/types/runtime-types.d.ts:305`、`dsh-agent/lib/index.js:335-339`；插件读法均正确 |
| `compaction/summary` 载荷含 `compactionId` / `summary`；`compaction/end` 含 `error?`；`summary` 允许空数组 | 源码 | `dsh-compaction/lib/types/types.d.ts:35-78` |
| 同一次压缩内 `compaction/summary` 至多出现一次 | 源码 | `dsh-compaction/lib/invariant.js:153` |
| `SessionEvent` 是 `SessionEventMap` 的判别联合；`dsh-session` 的 map **不含** `compaction/*`（由 `dsh-compaction` 声明合并补入） | 源码 | `dsh-session/lib/types/types.d.ts:435-442` + `dsh-compaction/lib/types/types.d.ts:14` |
| `restrict({deny})` 对未注册的名字抛错 | 源码 | `dsh-tools/lib/index.js:2802-2804`；`restrictableNames` 只收集继承层已注册名字（`:2865-2870`） |
| 工具可见面是**惰性**求值的（每次查询重算作用域视图） | 源码 | `dsh-tools/lib/index.js` 的 `view(scope)` 调用点：`:2727`、`:2892`、`:2920`、`:2924` —— 因此"后装的限制"对后续步骤生效（D8 的机制依据，仍需 spike 端到端确认） |
| **web/ptc 档下工具面不在 `header.tools` 里** | 实测 | 会话 `session-632a0f3e`：`data.header.tools` 是**对象数组**且只有 `[{name:"run_code",…}]`；模型可见声明块在 `data.header.system`（68 KB，`mcp__engram__*` 22 个唯一名 / 44 次出现，均在声明上下文） |
| 该声明块不含 AGENTS.md 文本（前提，写进判据） | 实测 | 同会话：`system` 含 `Key Learnings`（来自工具描述）但不含 `Persistent Memory Protocol` |
| **`mem_capture_passive` 的 `source` 落在 `observations.tool_name`** | **实测（隔离实验）** | 隔离 `ENGRAM_DATA_DIR`（`mktemp -d`）跑 `engram mcp`：`mem_session_start` → `mem_capture_passive({content, session_id, source:'SOURCE-MARKER-QQQ'})` → 落库行 `tool_name='SOURCE-MARKER-QQQ'`（`type='passive'`；该 marker 同时出现在 `title` 与 `content` 里） |
| `observations` 无 `source` 列、也无回合列；被动捕获「每条学习项各存一条 observation」 | 源码 + 实测 | 本机 `~/.engram/engram.db` schema（23 列）+ `mem_capture_passive` 的声明 |
| 下游插件用未标记事件类型会让会话日志读不出来 | 源码 | `dsh-session/lib/types/known-event-types.d.ts` |

约束：零运行时依赖（`import type` 不算）；不新增会话事件类型；不改 engram 与 DB schema。

## Goals / Non-Goals

**Goals:**

- 两条缝在运行时真的生效，且失效时**响亮**（warn 级、每会话每类型一条）而不是静默。
- 「同类 bug 在默认门禁里失败」——不设 `ENGRAM_LIVE` 也能覆盖到「提交了什么 / 注入了什么」这一层。
- 真机判据只用**相对量与环境前提**，不写死绝对值、不依赖 LLM 输出条数。
- 被动捕获的写入者唯一，落库判据收敛成单一口径。

**Non-Goals:**

- 不重构 MCP 客户端与连接池的整体设计，不改工具面折叠策略。
- 不引入第三方运行时依赖，不动 engram 侧去重/检索。
- 不碰记忆卫生（遗忘端）、P2 prompt 捕获、云同步。

## Decisions

### D1 事件读取经类型化信封适配层（type-only 引用宿主类型）

新增 `src/host-events.ts`：会话事件读取的唯一入口（窄化载荷 + 读取点字段校验），`turnFinalText` 与 `session/event` 监听器只经它取字段；类型来自宿主的 `SessionEvent` / `SessionEventMap`，以 `import type` 引入。

- **范围诚实**：`assistant/message` 的类型在已依赖的 `@deepseek-ai/dsh-session` 里；压缩事件类型在 `@deepseek-ai/dsh-compaction` 里（未依赖）——不加它，`event.type === 'compaction/summary'` 连编译都过不去，只能 cast，等于放弃编译期保护。
- 决定：把 `@deepseek-ai/dsh-compaction` 加进 devDependencies 并**显式指定 `0.1.2-rc.1`**（不用 dist-tag，避免拿到与该版本不同的历史版本）；它声明的 peer 会因仓库 `autoInstallPeers: true` 连带进 dev 树，运行时 `dependencies` 不变。装不上时降级为「压缩缝只有运行时字段级告警」，并在 README 标注。
- 备选：就地改 `event.data.*`（形状约定只活在人脑里）；自写增补声明（等于手抄宿主类型）；运行时 schema 校验（收益不抵成本）。

### D2 契约测试由宿主真实 `SessionStore` 产出事件

默认门禁新增契约测试：用 `@deepseek-ai/cordis` 的 `Context` + `@deepseek-ai/dsh-session` 的 `SessionStore` 真实 append（实测可在纯 node 进程里跑，无需 dsh、无需 engram），把**真实信封**投给插件的 `session/event` / `turn-stopping` 监听器；另加反向断言：扁平形状不被接受且触发告警。`test/live-wiring.test.ts` 的假事件改为同一来源。

- 备选：手写信封 fixture（形状仍由人保证）；只靠 `ENGRAM_LIVE=1`（现状 = 默认不测）。
- 理由：消灭「fixture 与实现共享同一错误假设」——这正是 54 tests 全绿而功能已死的原因。

### D3 失配必须响亮：warn 级、每会话每类型一条、覆盖字段级与空摘要

在 `host-events` 的读取点检查该事件类型所依赖的字段是否存在、类型是否对（`assistant/message` 要 `turn` 与 `message.content`；`compaction/summary` 要 `compactionId` 与 `summary`；`compaction/end` 要 `compactionId`），缺失或类型不符 → 一条 **warn** 级日志后继续。**限流键是 (会话, 事件类型)**：插件是进程级长生命周期对象，若按进程只响一次，持续的失配（例如宿主升级）会在第一个会话之后再无声息——那正是本变更要消灭的静默的新形态。

- 级别必须钉死：仓库既有连接关闭日志走 `log.debug`，而 debug 在宿主默认级别不可见、测试假宿主也把它实现为空操作——选 debug 等于"响亮"落空而测试仍绿。
- 边界（空摘要）：`summary` 为空数组/不含 text 块是**合法形状**，不算漂移；此时按 `engram-compaction-recovery` 的新要求处理——不提交、记一条**带 `compactionId`** 的 warn。日志带 id 是为了让"驱动器的正常空摘要"与"读取/构造异常"在事后可区分；插件在事件内无法区分两者，所以既不重试也不静默。该要求是采纳评审建议中"记一条 warn"这一支（另一支"把判空前置到去重标记之前"在契约下是行为无关的：同一 compactionId 不会有第二次 `compaction/summary`，因此标记位置不改变任何可观察行为）。

### D4 连接池把「取用」改成 `withConnection(workspace, fn)`，并在结算时刷新空闲时钟

在用计数在池内维护：进入 +1、调用结算的 `finally` 里 -1，**同一个 `finally` 里刷新 `lastUsed`**；`sweep()` 跳过在用连接；池外不再能拿到裸 client。

- 备选：保留 `acquire()` + 显式 `release()`（忘了 release → 永久 busy）；只把空闲时钟挂在 acquire（一次超过 `poolMaxIdleMs` 的调用结束后，下一次自主 sweep 会立刻关掉刚在用的连接——sweep 改成定时必然触发后，这条从理论变为常态）。
- 理由：让「忘记归还」在类型层面不存在；JS 单线程 + 定时器走 macrotask ⇒ 不存在「已发出但被判定空闲」的窗口。
- 约束：`withConnection` 只把**建连**放进池既有的串行链（`#serialized`），调用体 SHALL NOT 进入该链——否则同一工作区的并发调用会被串行化，链内互相等待还会死锁。

### D5 sweep 由定时器自主驱动，间隔显式配置、有下界、缺键有默认

`ctx.effect` 内 `setInterval(...).unref?.()`，卸载时清除。新配置键 `poolSweepIntervalMs`（默认 60000，schema 下限 1000）；空闲回收的总开关仍是 `poolMaxIdleMs`（`<= 0` 表示关闭）。实现取 `Math.max(1000, config.poolSweepIntervalMs ?? 60000)`：现有接线测试直接传配置字面量、绕过 schema，缺键时 `setInterval(fn, undefined)` 会退化成约 1ms 的忙轮询。

- 备选：`acquire` 时顺带 sweep（无人调用时永不触发）；间隔从 `poolMaxIdleMs` 派生（隐含行为、不可测）。

### D6 上限淘汰不因忙碌豁免

`#evictOverLimit()` 仍按最久未用淘汰，即使该连接在用；被淘汰连接上的在途调用会以错误结算，此时记一条 warn。

- 备选：全忙时允许临时超限——与 runtime 的「不超过配置上限」SHALL 冲突。

### D7 被动捕获单一写入者：不注册该工具

桥在注册面**跳过** `mem_capture_passive`（engram 声明 N 个，注册 N-1 个），因此它天然不出现在任何 agent 的模型可见清单里；被调用时宿主以未知工具错误拒绝，折叠工具也解析不到目标。桥自身的捕获走 `client.callTool`，不经工具面。

- 为什么不用 `restrict({ deny })`：该 API 对**未注册**的名字抛错，而注册时机可能是晚的（无缓存且加载期发现未完成时要等首次成功建连），错误又被吞成一条 warn → 遮蔽从未安装，等自愈注册后该工具**中途出现**。「不注册」对时序免疫。

### D8 子 agent 遮蔽：执行期硬闸 + 可见面尽力（两层）

原实现只在 `agent/created` 用**当时**的名单装一次 `restrict`，名单为空时直接返回、注册之后不再补。本次改成两层：

- **第一层·执行期 guard（硬保证"不可调用"，与注册时序无关）**：宿主提供 `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`（`dsh-tools/lib/types/index.d.ts:489`），经 `agent.ctx.tools.guard(fn)` 注册为**作用域级**守卫（`lib/index.js:2817-2822`），在**每次调用时**沿作用域链求值（`guardReason` → `:3128`）——与"目录在步骤组装时冻结"无关。子 agent 的 guard 按 `mcp__engram__` 前缀拒绝执行，**不依赖 `registeredNames` 是否已知**，因此冷启动窗口内也能立即装上。
- **第二层·可见面（尽力，需要 spike）**：工具可见面经 `view(scope)` **惰性**求值（`dsh-tools/lib/index.js:2892,2920,2924`），限制层是 effect，所以"注册完成后对已存在的子 agent 补装 `restrict`"理论上能收敛其后续步骤的目录；但这一步没有端到端证据 → 4.1 的 spike **只判定可见面能否收敛**，不再判定整体可行性。
- **预授权回退**：若 spike 结论为不可行，撤回 R6 里「注册晚于创建时同样遮蔽」的**可见面子句**（改为 README 已知限制 + 另开提案跟进），"不可调用"仍由 guard 保证；该回退不阻塞其余任务。
- 备选：只在创建时装（冷启动窗口内子 agent 会看到全部已注册的 engram 工具，与「子 agent 遮蔽」的 SHALL 冲突）。

### D9 调用超时只表示「桥不再等待」

超时/失败结算后连接可被回收或复用，但**不重试、不重复提交**；engram 子进程侧可能仍在完成该次写入并迟到落库（SQLite 事务原子性 ⇒ 不会出现半写）。规格不需要新要求（既有「调用超时与取消」「不改变可见输出」已覆盖桥侧语义），但验收要断"无重试/无重复"，而不是只断"可回收"。

### D10 压缩后召回按 `compaction/end.turn` 选择收件边界

**实测（2026-09-10 真机手动 `/compact`，本会话 session log）**：`compaction/end`（`turn: null`）之后由 `agent.inject()` 投递的召回是 `agent/inbox/spliced {target:'next-step', inserted:[…]}`，紧接着被 `{target:'next-step', start:0, removedCount:1, inserted:[], outcome:'canceled'}` 撤销——宿主 `foldConsumedWork` 正是把这个形状读作「投入了但没被运行就丢弃」；模型侧确认未收到该上下文。

**源码**：`agent.inject(message)` 等价于 `send(message, 'next-step', false)`，其类型文档写明空闲驱动器只把它留在队列、且 cancellation/disposal 可丢弃；`send(message, target, wakeup)` 是公开成员（`dsh-agent/lib/types/runtime-types.d.ts:112,135`），而 `compaction/start|end` 的 `turn: number | null` 被宿主自己定义为「数字 = 被该回合严格包住 / `null` = turn 之间的独立手动事务」。

**决定**：`turn === null` → 投递 `next-turn`（`wakeup=false`，不新建回合）；`turn` 为数字 → 投递 `next-step`（进行中的驱动器会在下一个 step boundary 领取）。宿主缺少 `send` 时记一条 warn 且不投递——**不回落 `inject()`**，否则等于静默复现本缺陷。

## Risks / Trade-offs

- [D8 的「创建后补装遮蔽」未端到端验证——只影响**可见面**] → **2026-09-10 已解**：4.1 的 spike 判定「收敛」（晚装、pre-step 内装都作用到后续 step，冻结点在 assemble()），真机标本亦证实子 agent 的 header.system 里 mcp__engram__ 出现 0 次而父会话 44 次；**预授权回退不触发**。原记录："不可调用"已由执行期 guard 做成时序无关的硬保证；可见面走 4.1 的 spike，不通过则按 D8 的**预授权回退**处理（撤回该可见面子句、记 README 已知限制），不写无法实现的 SHALL。
- [不注册会改变工具面计数（N → N-1）] → 规格已 MODIFIED「工具面注册」「工具面缓存与首个请求可见」；`registeredNames`、缓存与 `sameToolSurface` 仍基于 engram 声明，测试按 N-1 断言。
- [真机验收的判据依赖环境与 profile] → 判据用相对量（N 从 `tools.json` 读、被动捕获出现 0 次）而非写死的 22；并写明前提（按 `mcp__engram__` 前缀计数、基线声明块不含 AGENTS.md 文本）与基线实测值，供漂移时对照。
- [真机捕获判据受 LLM 输出条数影响] → 只用存在性 + 增量（turn2 > turn1），绝对计数不作判据；回合级"至多一次"由单测与桩测试承担。
- [落库字段假设（`source` → `tool_name`）] → 已用隔离 `ENGRAM_DATA_DIR` 实验证实（marker source 出现在 `tool_name`）；验收前再跑一次该前置校验，失败时判据改走 `title`/`content` 定位，而不是当作功能未修好。
- [桩 engram 会污染真实工具面缓存] → 桩测试必须进程级隔离 `$DSH_HOME`（照 `live-wiring` 的做法），并断言缓存写在临时 home 下、真实 `tools.json` 未被改写。
- [桩随宿主 MCP 协议变化而失真] → 桩只实现 `initialize` / `notifications/initialized` / `tools/list` / `tools/call`（响应 id 为 number）；真机由 `ENGRAM_LIVE=1` 的 `live-wiring` 兜底。
- [D1 的编译期保护依赖 devDependency 可安装且版本正确] → 显式钉死 `0.1.2-rc.1`（不用 dist-tag）；peer 连带只进 dev 树；装不上时按降级路径处理。
- [上限淘汰杀在用连接 → 该次工具调用失败] → 只在活跃连接数超上限且出现新工作区时发生（默认 8）；规格新增场景承认代价，实现记一条 warn。
- [回收精度受间隔限制：连接实际存活时间可能达到 `poolMaxIdleMs + poolSweepIntervalMs`（默认最多多 60s）] → README 与配置注释写清口径。
- [warn 告警可能变噪声] → 键为 (会话, 事件类型)，每会话每类型至多一条。
- [模型失去显式被动捕获] → `mem_save` 仍在；若日后确需显式捕获，再以显式来源参数开放。
- [D10 的 next-turn 投递可能长期挂在队列] → 用户不再发消息时该上下文只是待领取（不唤醒驱动器、不新建回合），下次输入时被领取；相比 next-step 在手动压缩里必然被丢弃，这是可接受的代价。

## Migration Plan

- 单仓单插件、无数据迁移：`pnpm typecheck && pnpm test && pnpm build` 后重启 dsh（web/headless 共用同一 checkout，一次构建两边生效）。
- 新配置键有默认值，三 profile 的 patch 无需改动；devDependency 只影响构建与测试。
- 回滚：revert 本 change 的提交并重新 build；engram 与 DB 无 schema 变更，无需回滚数据。
- 验收判据见 proposal.md 的「验收」段；DB 判据为 `observations.tool_name='dsh-turn-stopping'`（本机当前 0 条），回合级判据由桩/契约测试承担。

## Open Questions

三个必须在 apply 期间先解掉、且各自有对应任务与降级路径的开放项（不写"无阻塞项"）：

1. **~~D8 的补装遮蔽是否真的生效~~** → **已解（2026-09-10）**：4.1 的 spike 判定「收敛」，真机标本亦证实（父 44 次 / 子 0 次）；降级路径不触发。
2. **桩 engram 的保真度是否够** → 任务 2.6 用桩跑通"提交/注入"两条断言即算验证通过；`ENGRAM_LIVE=1` 的真 engram 用例作为交叉校验。
3. **真机判据的环境前提是否仍成立**（声明块不含 AGENTS.md 文本、`source` → `tool_name` 映射）→ 任务 5.2 的前置校验 + 5.3 基线对照；不成立时按 Risks 里的替代判据处理。
