## 1. 固化实测锚点与读取入口

- [x] 1.1 在 `docs/event-findings.md` 补一节「会话事件信封实测锚点」：信封 key 集合（含真实日志的 `assistant/message` key）、`assistant/message` / `compaction/*` 的载荷字段、`SessionEvent` 是 `SessionEventMap` 的判别联合、以及各出处（`dsh-session/lib/index.js:1416-1422`、`dsh-session/lib/types/types.d.ts:435-442`、`dsh-compaction/lib/types/types.d.ts:14,35,73`）；验证：每条锚点都能对到具体文件行或实测命令，且与本 change 的 design.md Context 表一致（表内如实标注"实测"与"源码读取"）
- [x] 1.2 新增 `src/host-events.ts`（会话事件读取的唯一入口：窄化载荷 + 读取点字段校验）；类型经 `import type` 取自 `@deepseek-ai/dsh-session/types` 与 `@deepseek-ai/dsh-compaction/types`，后者以 `pnpm add -D @deepseek-ai/dsh-compaction@0.1.2-rc.1` **显式指定版本**引入（不得用 dist-tag）；验证：`pnpm typecheck` 通过且 `event.type === 'compaction/summary'` 无需 cast 即通过编译；运行时 `dependencies` 未新增条目；`pnpm-lock.yaml` 中该包恰为 `0.1.2-rc.1`
- [x] 1.3 安装不可行时按 design D1 降级（压缩缝只留运行时字段级告警）：验证：若走降级，`pnpm install` 与 `pnpm typecheck` 的结果与 README/design/Risks 记录的降级口径一致；若未降级，README 不出现降级措辞

## 2. 信封契约修复（先红后绿）

- [x] 2.1 新增契约测试：用 `@deepseek-ai/cordis` 的 `Context` + `@deepseek-ai/dsh-session` 的 `SessionStore` 真实 append `assistant/message`，断言 `turnFinalText` 取到该回合文本；验证：该用例在修复前失败（红）
- [x] 2.2 同一契约测试补齐 `compaction/summary` / `compaction/end` 真实信封：断言摘要提交与 `compaction/end` 后的召回注入被触发；验证：该用例在修复前失败（红）
- [x] 2.3 把 `turnFinalText` 与 `session/event` 监听器改为经 `src/host-events.ts` 读取载荷；验证：2.1 / 2.2 转绿，`pnpm typecheck && pnpm test` 通过
- [x] 2.4 反向断言（形状）：载荷被平铺到顶层时不产生任何捕获；验证：断言 engram 侧无写入，且在**该会话内恰好一条 warn**（断言 warn 通道，不把 debug 算作"响亮"）
- [x] 2.5 字段级与空摘要边界：`data` 存在但读取点字段缺失/类型不符时同样一条 warn；空 `summary`（空数组或不含 text 块）不提交、记一条带 `compactionId` 的 warn、且不影响同次压缩的 `compaction/end`；验证：三个用例（缺 `summary`、`message.content` 类型不符、空 `summary`）各自断言 warn 内容与写入行为；**同会话同类型重复投递不重复告警、新会话会重新告警**（限流键为 (会话, 事件类型)）
- [x] 2.6 桩 engram（最小 stdio MCP server：`initialize` / `notifications/initialized` / `tools/list`（回放真实声明）/ `tools/call`（记录调用并按用例回放受控结果），响应 id 为 number）：把 `config.command` 指向它，使默认门禁能端到端断言"提交了什么"；**进程级隔离 `$DSH_HOME` 到临时目录**（照 `test/live-wiring.test.ts:106-108`），fixture 内不得出现机器路径（`scripts/check-hygiene.mjs` 会拦）；验证：新接线测试断言捕获提交的 `content` / `source='dsh-turn-stopping'` / `session_id`、压缩摘要的 `content` 与 `session_id`、`compaction/end` 后 `agent.inject` 收到不超过 `recoveryTokenBudget` 的文本；并断言工具面缓存写在临时 `$DSH_HOME` 下、真实 `tools.json` 未被改写
- [x] 2.7 未新增事件类型：驱动全部监听器后，真实 `Session` 的 `seq`（事件条数）不变；验证：该断言在契约测试中通过

## 3. 连接池：在用语义、结算计时与定时回收

- [x] 3.1 把池的取用 API 改为 `withConnection(workspace, fn)`，在用计数在池内维护（进入 +1、`finally` -1），池外不再暴露裸 client；验证：`src/index.ts` 全部调用点改为新 API，`pnpm typecheck && pnpm test` 通过，且新单测断言两个不同工作区的调用可并发进行（不因串行链互相等待）
- [x] 3.2 结算语义：`finally` 里同时刷新 `lastUsed`，`sweep()` 跳过在用连接；验证：新单测「调用未结算且空闲超阈值 → 不回收」「结算后立即 sweep 也不回收（计时自结算重置）」「结算后再等满阈值 → 回收」三条通过
- [x] 3.3 超时/失败语义：一次调用以超时或失败结算后，在用计数归零、计时已刷新、连接可回收；且**不重试、不产生第二次提交**；验证：新单测（桩/假 client 故意不回包，触发 `toolCallTimeoutMs`）断言以上四点；不需要断言 engram 侧迟到写入（由 SQLite 事务原子性保证无半写，写在 design D9）
- [x] 3.4 上限淘汰保持按上限执行（即使候选在用）并记一条 warn；验证：新单测「达到上限且其余连接全在用 → 最久未用者仍被关闭、活跃数不超过上限、被淘汰连接上的在途调用以错误结算且有一条 warn、淘汰后在新工作区发起的调用成功」通过
- [x] 3.5 定时回收接线：`ctx.effect` 内 `setInterval(...).unref?.()`，间隔取 `Math.max(1000, config.poolSweepIntervalMs ?? 60000)`，schema 为 `z.number().min(1000).default(60000)`；验证：接线测试（小间隔 + 真实定时器）断言空闲连接被关闭、调用中的连接不被关闭、卸载后不再回收、`poolMaxIdleMs=0` 时不回收；另两条断言：`poolSweepIntervalMs` 配 0/负数在加载期被拒，且**配置缺该键时按 60000 生效**（不出现 ~1ms 的忙轮询）

## 4. 被动捕获单一写入者与子 agent 遮蔽时序

- [x] 4.1 **spike（只判定可见面）**：用 `scripts/probe/run-probe.sh` 的子代理场景验证「子 agent 创建后再装 `restrict({deny})`」能否作用到它后续步骤的模型可见清单；验证：spike 报告给出"可见面可收敛 / 不可收敛"的结论并留下复现命令；不可收敛时按 design D8 的**预授权回退**处理（撤回 R6 可见面子句 + README 已知限制），不阻塞 4.2 起的任务
- [x] 4.2 **执行期 guard（硬保证"不可调用"，与注册时序无关）**：在子 agent 的作用域上装 `agent.ctx.tools.guard`，按 `mcp__engram__` 前缀拒绝执行；验证：新用例构造「先 `agent/created`（名单为空）、后注册完成」的顺序，断言该子 agent 调用任一 engram 工具都以未知工具错误/拒绝失败，且桩 engram 未收到该调用（改动前该断言失败）
- [x] 4.3 注册面跳过 `mem_capture_passive`（engram 声明 N 个 → 注册 N-1 个）；验证：接线测试断言注册名集合里没有该工具，且（有/无工具面缓存两条路径下）任何 agent 的模型可见清单都不含它
- [x] 4.4 未注册名字的调用被拒绝（测试层，非真机）：在接线/桩测试里经宿主派发直接调用该名字；验证：得到未知工具错误，且桩 engram 未收到该调用
- [x] 4.5 注册完成后对已存在的子 agent 补装遮蔽（4.1 判定可见面可收敛时）：验证：新用例构造「先 `agent/created`（名单为空）、后注册完成」的顺序，断言该子 agent 的模型可见清单不含任何 `mcp__engram__*` 工具
- [x] 4.6 子 agent 的既有两条场景在"注册晚于创建"时序下同样成立：被隐藏的工具仍被调用 → 未知工具错误、不产生写入；经折叠工具旁路 → 被拒绝；验证：两条用例在同一时序构造下通过（4.1 不可收敛时，这条以 guard 路径通过并记录可见面缺口）
- [x] 4.7 `test/live-wiring.test.ts` 的假事件改为真信封来源，并加落库断言；验证：`ENGRAM_LIVE=1 pnpm test` 通过，且桩/契约测试驱动两个回合时提交次数为 2（回合级去重由 `test/capture.test.ts:33-45` 承担，此处只断言接线次数）

## 5. 验收、文档与归档

- [x] 5.1 默认门禁覆盖确认：`pnpm typecheck && pnpm test`（不设 `ENGRAM_LIVE`）；验证：第 2、3、4 组的契约/接线/桩测试出现在运行列表中且通过（不再是 skip），且运行后真实 `~/.dsh/storages/engram-bridge/tools.json` 的 mtime/内容未变
- [x] 5.2 真机验收（捕获）：先跑**落库字段前置校验**（隔离 HOME（见 5.10 修正）+ `mem_capture_passive({source: marker})` → 查库 `tool_name` 是否等于 marker；本机已实测成立，此处对当前 engram 版本复验）；随后 `pnpm build` + 重启 dsh，按固定话术走两个回合（明确要求每回合输出至少一条、≥28 字符、两回合文本不同的学习条目）；验证：turn1 后该会话出现 `tool_name='dsh-turn-stopping'` 的条目，turn2 后计数**大于** turn1 后计数；前置校验失败时改为按 `title`/`content` 定位并记录该偏差
- [x] 5.3 真机验收（单一写入者，相对判据）——**2026-09-10 重启后实测通过**：本会话 `request/header.data.header.system` 的 `mcp__engram__*` 唯一名 22→21、出现 44→42、`mem_capture_passive` 0 次：解压本会话 `request/header` 事件，读 `data.header.system` 声明块（web/ptc 档下 `data.header.tools` 只有 `run_code`）；验证：`mcp__engram__mem_capture_passive` 出现 0 次，且 `mcp__engram__*` 唯一名字数 == `tools.json` 里的声明数 − 1（基线实测：22 唯一名 / 44 次出现 / 含被动捕获；前提：按前缀计数，声明块不含 AGENTS.md 文本）
- [x] 5.4 真机验收（压缩恢复·持久化）——**2026-09-10 实测通过，判据已修正**：手动 `/compact` 后 engram `observations` 出现 `type='session_summary'`、`session_id=<本会话>`、内容等于压缩摘要原文（#296）。**修正**：原判据 `sessions.summary` 不成立——engram 1.20.0 从不写该列（全库非空 0 行），摘要落在 `observations`。注入半边见 5.9
- [x] 5.5 子 agent 验收（4.1 通过时）：用 `scripts/probe/run-probe.sh` 的子代理场景跑一次真实子 agent；验证：其 `request/header` 的声明块里 `mcp__engram__*` 出现 0 次；若 4.1 走了降级，则把该缺口写进 README 的已知限制
- [x] 5.6 文档对齐：更新 README 能力表（工具面计数 N-1、`poolSweepIntervalMs` 语义/下限/缺键默认、回收精度为 `poolMaxIdleMs + poolSweepIntervalMs`，以及 4.1 降级时的子 agent 可见性缺口）与 `docs/engram-upgrade-checklist.md` 的回归项（含「事件载荷经信封读取」「失配走 warn」「未注册工具的调用被拒」）；验证：逐条对照本 change 的 specs，措辞与已实现行为一致
### 验收中发现并修复的缺陷（2026-09-10）

- [x] 5.8 **压缩后召回投递边界修复**：`compaction/end` 的读取契约新增 `turn`（新字段类型 `number-or-null`，`null` 是合法取值）；`CompactionRecovery.onEnd` 按 `turn === null ? 'next-turn' : 'next-step'` 投递；`src/index.ts` 的投递缝由 `agent.inject()` 改为 `agent.send(message, target, false)`，宿主缺 `send` 时记 warn 且不投递（不用 `inject()` 顶替）。验证：`test/compaction.test.ts` 新增边界用例（**对旧实现变红**——把 dist 里改回 `'next-step'` 该用例即失败）、`test/host-events.test.ts` 新增 `turn` 契约两例（`null`/数字合法、缺失与错类型各一条 warn）、`test/stub-wiring.test.ts` 与 `test/live-wiring.test.ts` 断言投递目标为 `next-turn` 且 `wakeup=false`；`pnpm typecheck` 通过，默认门禁 73 项（69 pass / 4 skipped / 0 fail），`ENGRAM_LIVE=1` 73/73
- [x] 5.9 **真机复验（压缩后注入）**：重建并重启 dsh，再手动 `/compact` 一次；验证：该会话的 `agent/inbox/spliced` 出现 `target='next-turn'` 且**不被**随后的 `outcome='canceled'` 撤销，下一个回合的模型请求里带上不超过 `recoveryTokenBudget` 的记忆上下文。**基线（2026-09-10 首次实测，失败）**：`next-step` 投递（seq 303820）后 26.2 秒被 `outcome:'canceled'` 撤销（seq 303821），下一回合 prompt 无召回。**2026-09-10 复验通过**：构建 13:48:43 → `dsh web` 启动 13:49:11（运行中的插件确实吃到了新 dist）；手动 `/compact` 产生 `compaction/start|summary|end`（`compactionId=fd4068ab-da44-4baa-b42b-ef84fa5811da`，三者 `turn=null`）→ seq 420715 `agent/inbox/spliced` `target='next-turn'`、载荷 3,227 字符；seq 420716 用户下一条消息以 `start=1` 排在召回之后；seq 420718 `removedCount=1 / inserted=[]` 且**无 `outcome` 字段**（正常领取，非 `canceled`）；召回原文逐字出现在下一回合的模型上下文里，判据成立
- [x] 5.10 **实验装置修正**：隔离 engram 库的正确旋钮是 **HOME 覆盖**（engram 没有 `ENGRAM_DATA_DIR` 之类的数据目录变量；二进制里只有 `.engram/engram.db`），且写实验前必须先用 `mem_session_start` 建会话行，否则 `mem_capture_passive` 以 `FOREIGN KEY constraint failed` 失败。5.2 原文里的 `ENGRAM_DATA_DIR` 措辞按此更正（已就地改注）

### 验收证据（逐条可复现）

- **4.1 spike**：三条场景（`child-early / child-late / child-prestep`）均显示安装后下一个 `request/header` 的工具数 26 → 23，父 agent 全程 26；未注册名字调用 `restrict` 同步抛错且不落地任何 restriction。
- **5.2 捕获**：本会话 `observations.tool_name='dsh-turn-stopping'` 0 → 3（13:30:18）。5 条学习条目只落 3 条的原因已用隔离库定位：**抽取门槛是空白分隔的 token 数，不是条数上限**——6 条纯中文整句 `extracted=0`，同一批句子只加空格即 `extracted=4`，10 条带标识符 `extracted=10`。
- **5.3 单一写入者**：重启后本会话 `header.system` 的 `mcp__engram__` 唯一名 22 → 21、出现 44 → 42、`mem_capture_passive` 0 次。
- **5.4 摘要持久化**：`observations` #296（`type='session_summary'`，本会话 id，13:31:17）。
- **5.5 子 agent**：真 profile 标本 = 本次 spike 子代理会话（`~/.dsh/sessions/…/333972f4-…`）：父 `header.system` 70,136 字符 / `mcp__engram__` 44 次，子 36,821 字符 / **0** 次。
- **5.9 压缩后注入**：基线与复验的形状对照——**基线 seq 303820/303821**（首次压缩 `442807ca`，05:31:17.273 投 `next-step` → 05:31:43.487 被 `outcome:'canceled'` 撤销，随后 turn 24 的 prompt 只有 `已 compact，检查` + 三条 reminder，**没有召回**）；**复验 seq 420715/420716/420718** = `next-turn` 投递 + 无 `outcome` 的正常领取，召回随后作为 `user/message`（seq 420720，kind=plugin，3,227 字符）真的进入请求体。**注意**：同一日志里的 seq 398371/398372 是 `~/.dsh/AGENTS.md` 变更通知被 step boundary 撤销，与召回无关，最初误引为此处基线。预算：`truncateToTokenBudget` 上限 = `tokenBudget * 4` = 3,200 字符，实测载荷 3,227 = 3,200 + 27（截断标记 `\n…(truncated to 800 tokens)`），正好卡在预算边界并确实执行了截断。压缩摘要本身按 5.4 落 `observations` #320（`type='session_summary'`，13:50:32）

- [x] 5.7 归档与回写：`openspec archive engram-bridge-p0-fixes`，并回写 obsidian 主档（「待交接」两节改为已修复、判据改为 `tool_name` + `header.system`、更正 `~/.dsh/AGENTS.md` 的过期归因、标注 `#267/#268` 已软删）与 engram（`bugfix` / `decision` 各一条）。**2026-09-10 完成**：变更归档为 `2026-09-10-engram-bridge-p0-fixes`（`openspec validate --all --strict` 6/6）；obsidian 主档已回写（状态块、任务计数 32/30、测试数 73、判据两处修正、第 4 处缺陷、抽取门槛实测、changelog）；engram 侧已存 `bugfix` / `decision` / `discovery` 各一条。验证：主档描述与运行时 DB / 工具清单现状逐条一致
