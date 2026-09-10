## Context

把 engram（本地 SQLite 记忆后端，本机 1.20.0）以 dsh 插件形式接入。官方对插件的定位是三件事——接线生命周期钩子、编排会话开始与恢复、注入记忆协议指引，**后端逻辑留在 engram**（engram docs: Plugin Architecture）。dsh 的特殊性在于**单进程服务多个工作区**，而 engram 的 project 解析默认来源是**它自己的进程 cwd**。

已核实的运行时事实（本机 engram 1.20.0 + dsh 0.1.2-rc.1 生成物，均为实测/源码锚点，非推断）：

| 事实 | 证据 |
| --- | --- |
| `mem_current_project` 用进程 cwd 解析项目 | 实测返回 MCP 进程 cwd 所在的项目名，与 dsh 会话工作区无关 |
| `mem_session_start(directory=X)` 用 X 解析，返回 `project`/`project_source` | 实测 `config` / `git_root` 均正确 |
| `mem_save` 优先用 session 的项目 | 实测 `project_source: session` |
| `mem_capture_passive` / `mem_session_end` 的**项目**只取 cwd（不接受 `project` 参数）；**归属仍由传入的 `session_id` 决定** | 实测：`project_source: git_root`、落到 cwd 项目，但 observation 的 `session_id` 为传入值 |
| 显式 project 是 validated selection，未支撑则硬失败 | 实测 `unknown_project`；DOCS L830-845 |
| `mem_save` 用不存在的 session_id → `unknown_session` | 实测 |
| 1.20.0 允许对已结束会话再次 `mem_session_start` | 实测（DOCS 所述 `session_already_ended` 在本版本不成立） |
| 多进程同 DB：6 进程 × 8 并发写全成功；但启动期出现一次 `pragma journal_mode = WAL: database is locked` | 实测 |
| 被动捕获对短条目静默丢弃 | 实测：20 字符多词=0、约 28 字符多词=1、26 字符单词=0 |
| dsh 会话日志只持久 session 事件，agent/* 不落盘 | 实测：40 个会话日志中无 agent/* 事件 |
| 本会话 1 turn ≈ 8 step（91 assistant/message vs 11 turn/start） | 实测 |
| 子 agent 由 `composeFrom` 绑定父组合，不能指定另一 preset | dsh-agent-presets index.d.ts:205-231 |
| 可按子 agent 收窄工具面 | dsh-tool-subagent Config.toolFilter；dsh-subagent SubagentStartRequest.toolFilter（经 scoped `tools.restrict()`，"vanish from the child's prompt AND refuse to execute"） |
| `agent/turn-stopping` 在**被中止的回合不触发**；正常回合恰好一次，位于最后一条 `assistant/message` 之后、`turn/end` 之前 | 探针 `out/abort.jsonl` / `out/multistep.jsonl`（`docs/event-findings.md` Q1） |
| 监听器内 `agent.steer()` 会让同一回合**再次**触发 `turn-stopping` | 探针 `out/steer.jsonl`（turn 1 两次） |
| `agent/created` 时子会话 header 已含 `origin:'subagent'` / `delegationDepth` / `parentSession`；该窗口 `agent.ctx.tools.restrict({deny})` 使工具从子 agent 模型可见目录消失（26→23，`request/header.toolCount=23`）且执行返回 `UNKNOWN_TOOL` | 探针 `out/subagent-restrict.jsonl` |
| `session-start` 的 `clear` / `compact` 在本构建**无生产者**；观测到的 source 只有 `startup` | 探针 `out/compact.jsonl`（两次真实压缩仍只有一次 startup）；`commands.list` 无 clear |
| 压缩只体现在 `session/event` 的 `compaction/*`，agent 面无事件 | 探针 `out/compact.jsonl` |
| `agent/session-start` 先于首个 `turn/start` 与 `step/start` | 探针 Q4 表 |
| 启动任意 profile 会重写 `$DSH_HOME/profiles/<name>/cordis.yml` | 探针说明（`docs/event-findings.md` 开头） |

## Goals / Non-Goals

**Goals**：P0 五项能力（记忆连续性、桥运行时、会话绑定、上下文注入、被动捕获）+ 单一源交付 + 失败降级；保持零运行时依赖。

**Non-Goals**：P1 的防腐/遗忘循环驱动与 `agent.inject()` 动态协议指引；P2 的 prompt 捕获与工具面收敛。不修改 engram 二进制或 DB，不做记忆系统本身。

## Decisions

1. **按工作区池化 engram 子进程，cwd = 会话工作区。** 因为 `mem_capture_passive` / `mem_session_end` 的**项目**只认进程 cwd、且没有可注入的 project 参数（归属另由传入的 `session_id` 决定；实测 + DOCS L826），单进程多工作区必然把记忆写进错误的项目。替代方案：单进程 + 全程显式注入（对这两个工具无效）；每会话一进程（进程数随会话增长，收益相同）。
2. **懒启动 + 并发去重 + 串行启动与重试。** 工作区集合在启动时未知（`SessionHeader.cwd` 由会话创建时决定）；实测观察到启动期瞬时数据库锁失败，故启动需串行化并允许重试。空闲回收与连接上限见配置。**工具面另有缓存**：一个 step 的工具清单在该 step 的系统提示组装时即被冻结（dsh-agent-loop:502 组装 → :506 pre-step waterfall → :619 `buildRequest(..., assembly.tools, ...)`），早于任何插件钩子——实测在 `agent/request` 与 `agent/pre-step` 上等待发现完成都改不了该 step 的工具面。因此插件把成功发现的工具面缓存到 `$DSH_HOME/storages/engram-bridge/tools.json`，下次加载同步注册：冷启动的首个请求可能不含 engram 工具，之后每次启动的首个请求都包含（实测冷 26→0、热 48→22）。
3. **项目名由 engram 解析一次，插件缓存并全程显式注入。** git 仓库的项目名可能是 engram 存储的 binding label（DOCS L792-793），插件无法从文件系统复制；且显式 project 是 validated selection，猜错会硬失败（实测 `unknown_project`）。替代方案（插件自判：读 `.engram/config.json` + git + basename）在 git_remote / monorepo / binding 三种情形会错。
4. **注入优先级**：显式参数 > `projectOverrides[工作区]` > 会话解析结果 > `ENGRAM_PROJECT` > 不注入。绝不使用目录名兜底（实测该兜底会产出 engram 不认账的名字）。与 `~/.dsh/AGENTS.md` 不矛盾：AGENTS.md 写的是 engram 的 **cwd 路径**（实测 `ENGRAM_PROJECT` 在该路径胜出，`project_source: process_override`），本插件走的是 **directory 路径**（实测 directory 胜出，`git_root`）。AGENTS.md 需按 tasks 10.2 改写为指向本 spec：旧文描述的是 cwd 路径（`ENGRAM_PROJECT` > 目录检测），本 spec 管的是 directory 路径（directory > `ENGRAM_PROJECT`），且**删除 basename 兜底**（插件永不注入未经 engram 认账的项目名）。
5. **写类工具靠 `session_id`，不靠 cwd。** 显式 session_id 是 engram 官方指定的并发解法（DOCS L839：不带 session_id 时多候选 fail closed），且 `mem_save` 的项目优先取 session 的项目。`mem_save_prompt` 的 `project` 只用于歧义恢复，不注入；其 `session_id` 照常注入。**被动捕获的归属同样靠注入的 `session_id`**：实测同工作区两个会话各带自己的 `session_id` 提交捕获，两条 observation 分别落在各自会话下（项目均取自 cwd）——归属与项目由两条不同机制负责：归属 = 注入的 `session_id`，项目 = 按工作区池化的 cwd。
6. **会话身份 = dsh 会话标识，重复开始一律复用（同 id 幂等）。** 实测本构建只产生 `startup`（子会话亦然），`resume` 有生产者但 headless 无入口，`clear` / `compact` 无生产者——因此幂等要求按"同一标识重复开始不新建"写，并由单元测试覆盖；spec 不为 `clear` / `compact` 写场景（它们无法被触发）。**P0 不调用 `mem_session_end`**。实测（隔离 DB）：对已结束会话，`mem_save` / `mem_capture_passive` / `mem_session_summary` **仍全部成功**，且同 id 可再次 `mem_session_start` —— 所以在本机 1.20.0 上"错判结束"的代价确实很小；不结束的代价同样小（我们始终注入 `session_id`，engram 的"多候选 fail closed"只影响不带 session_id 的路径，观测表本身带 session_id，按会话聚合不受影响；真实代价仅是 `sessions` 表增长与 `ended_at` 长期为空）。留 P0 不结束的决定性理由是**版本风险**：DOCS 声明已结束会话不可重开（本版本不成立），若将来落实而我们在 `agent/disposed` 就结束，resume 会撞 `session_already_ended`，破坏"同一 dsh 会话 = 同一 engram 会话"的不变量。压缩恢复进 P0 后我们会写 `mem_session_summary`，叙事层本就有内容。
7. **被动捕获挂 `agent/turn-stopping`，每回合一次。** 实测：该钩子在**被中止的回合完全不触发**（中止回合在 turn-stopping 处静默），所以"跳过中断回合"由钩子语义天然满足，不需要读 `interrupted`；正常回合恰好一次，位于最后一条 `assistant/message` 之后、`turn/end` 之前，正好拿到最终回复文本。又因**监听器内 steer 会让同一回合二次触发**，捕获必须按 (会话, 回合) 加闩锁。若日后需要在中止回合做簿记，唯一可靠信号是 `turn/end` 的 `reason.kind === 'aborted'`。条目拆分与去重由 engram 完成（DOCS L1001），插件不重实现提取。
8. **子 agent 遮蔽在插件内实现（已由探针证实可行）**：在 `agent/created` 窗口对 `origin === 'subagent'`（或 `delegationDepth > 0`）的 agent 用 `agent.ctx.effect(() => agent.ctx.tools.restrict({deny}))`，工具会从该子 agent 的模型可见目录消失（实测 26→23，其 `request/header.toolCount` 同步为 23），执行被隐藏工具返回 `UNKNOWN_TOOL`。**不需要额外 guard**：折叠工具 `mcp_call` 用**调用者身份**解析目标（`@aiwayds/dsh-mcp-adapter` 源码 `resolve(name, exec.agent)`，并注明 "called with the calling agent so restrictions are respected"），所以同一条 restriction 也覆盖旁路；探针另证 `ctx.tools.execute({name, agent: child})` 对被 deny 的工具返回 `UNKNOWN_TOOL`。preset 级遮蔽不可行（子 agent 经 `composeFrom` bind 父组合）。
9. **降级而非抛错**：engram 不可用时不注册工具、记一条日志；只有配置非法才在加载期抛错。
10. **配置用 Schemastery**（`interface Config` + 同名 `Schema`，默认值进 schema）；**零运行时依赖**，MCP 走 stdio 自实现最小 JSON-RPC 客户端（沿用草稿已验证骨架，补子进程 `exit` 处理、请求级取消、`cwd`、启动重试）。
11. **不新增 dsh 会话事件类型；P0 不新增 system prompt 段。** 协议指引在 P0 仍由 `~/.dsh/AGENTS.md` 承担，但须删除与插件行为重叠/漂移的段落；P1 改用 `agent.inject()`（会话开始注入一条 user 消息，不破坏前缀缓存）。
12. **子进程环境**：默认最小继承（`PATH`/`HOME` + 显式 `env` + engram 相关白名单），对齐官方 MCP client 的 `scrubbedParentEnv` 思路，避免把宿主环境全量泄漏给 engram。
13. **压缩恢复挂 `session/event`，不是 agent 事件。** 实测压缩不重启会话（`source: 'compact'` 无生产者），两次完整 `compaction/start → summary → end` 落在同一回合的 step 之间，agent 面只有一条初始 `startup`。因此：摘要持久化监听 `compaction/summary`（其 `summary` 字段就是摘要内容，直接交 `mem_session_summary`，插件不自己生成摘要）；记忆注入在 `compaction/end` 成功之后（锁已释放）；按 `compactionId` 幂等；`compaction/summary` 之后紧跟的 `user/message` 是 dsh 的表面替换，插件不改写。锚点：`dsh-compaction/lib/types/types.d.ts:21-98`。**已实测**（`scripts/probe/out/inject.jsonl`）：在 `compaction/end` 调用 `agent.inject()` 的消息，会出现在**下一个 step** 的模型可见消息序列里（marker 于 `step/start turn=1 step=3` 之后、下一条 `assistant/message` 之前）；注意注入是**延迟到下一个 step 边界**的，紧跟其后的嵌套压缩周期会把它推迟。

## Risks / Trade-offs

- [多进程同 DB 的启动竞态] → 串行启动 + 重试；写并发实测 48/48 成功，风险集中在启动。
- [池上限 8 与空闲 10 分钟] → 已用 `vmmap`/`footprint` 实测（`ps`/`top` 在本会话被沙箱拒）：engram MCP 子进程 physical footprint 约 **11.5–15.4 MB**（含 dsh 宿主自身那一个），故上限 8 的最坏占用约 **120 MB**，默认保留；空闲 10 分钟与 engram 的会话只存于 DB、连接可随时重建一致。
- [engram 文档与已装版本行为不一致（`session_already_ended`）] → spec 只写实测行为；交付 `docs/engram-upgrade-checklist.md`，升级前回归。
- [被动捕获对短条目静默丢弃] → 不重实现提取；`extracted=0` 且存在学习段落时记日志。
- [子 agent 遮蔽依赖 `restrict` 的**精确工具名**] → 使用插件自己注册的名字列表（未注册时不安装 restriction）；旁路由同一条 restriction 覆盖，前提是折叠工具用调用者身份解析目标（本部署的 `dsh-mcp-adapter` 已核实如此）。
- [冷启动（无缓存）的首个请求可能不含 engram 工具] → 只影响首次运行或一次性 headless；发现完成后即对后续请求可见并写入缓存，交互式会话几乎不会命中。
- [`link:` 安装让 profile 依赖本地路径] → 个人项目可接受；发布时改为正式包。
- [不新增 system prompt 段 → 模型仍依赖 AGENTS.md 的自觉] → P0 清理重叠段落，P1 用 `agent.inject()` 补上。
- [启动任意 dsh profile 会重写 `$DSH_HOME/profiles/<name>/cordis.yml`] → 探针与验证必须重定向 `DSH_HOME`（探针即如此）；安装步骤本身写 `~/.dsh`，属预期行为。
- [压缩后注入依赖 `agent.inject()` 在同一回合内可见] → tasks 8.1 先探针；不可见则退化为"仅持久化摘要"或"下一回合开始注入"。
- [`recoveryTokenBudget` 默认 800] → 实测本项目的 `mem_context` 输出 4635 字符 ≈ 1159 tokens（2026-09-09），故 800 会把注入裁到约 2/3；它只是"提示"，模型仍可 `mem_search` 取更多。若实际项目普遍更大，再调高。

## Migration Plan

1. 仓库实现 + 测试 + 构建通过（`pnpm typecheck && pnpm test && pnpm build`）。
2. `dsh plugin --profile {web,headless,open-design} add <repo>`，确认生成 `link:` 依赖。
3. 删除 `~/.dsh/cordis.patch.yml` 里对 `mcp-engram` 的手写 `insert`，改为对 `engram-bridge` entry 的 config 覆盖。
4. 备份并退役三份 `node_modules/dsh-engram-session-v2/`。
5. 验收：新会话落 `sessions` 表且 directory 正确；两会话不串档；含学习条目的回合落库一次；`engram doctor` 无 `session_project_directory_mismatch`；停用后 `--dump-config` 无 `engram-bridge`、无孤儿进程。

**回滚**：恢复手写 `insert` 与三份副本目录，重启 dsh。

## Open Questions

- 探针 Q1–Q4 已闭环（结论与证据见 `docs/event-findings.md`）：中止回合不触发 `turn-stopping`；`agent/created` 窗口的 `restrict` 生效；`clear`/`compact` 无生产者；`session-start` 先于首个回合。
- `resume` 有生产者但 headless 无入口，尚未实测；幂等逻辑按"同一标识重复开始不新建"实现并单测覆盖，等有入口时补端到端验证。
- 池上限与空闲时长的最终取值（依赖 engram 进程 RSS 实测）。
- archive 行为已实测闭环：`openspec archive` 丢弃 delta 的 frontmatter（产物仅 `# <cap> Specification` + `## Purpose` + `## Requirements`），故不再列为开放项，改为 tasks 9.5 在归档后回填 `id/title/type/status/anchors/triggers/related`。
