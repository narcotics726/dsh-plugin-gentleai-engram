# dsh-plugin-gentleai-engram

把 [engram](https://github.com/Gentleman-Programming/engram)（本地 SQLite 持久记忆）的 MCP 后端接入 **dsh**：按会话工作区连接 engram、绑定会话、注入项目与会话参数、把回合收尾与压缩摘要写回记忆，并在压缩后注入有界记忆上下文。

> 非官方第三方插件（unofficial），当前针对 engram `1.20.0`。

## 能力

| 能力 | 行为 |
| --- | --- |
| 工具接入 | 把 engram 声明的工具以 `mcp__engram__*` 注册进 dsh，名称、描述、参数 schema 与 engram 声明一致（engram 1.20.0 声明 22 个，注册 **21** 个：被动捕获工具刻意不注册，见「被动捕获」行） |
| 工具面就绪 | 加载时用一次性短连接发现工具面并缓存到 `$DSH_HOME/storages/engram-bridge/tools.json`（含 `command`/`args` 指纹；**缓存保留 engram 的原始声明**，注册面才是 N−1），下次启动的首个请求即带全部已注册工具；工作区连接保持懒启动 |
| 按工作区连接池 | 每个会话工作区一个 engram 子进程（cwd = 工作区）：懒启动、single-flight、串行启动 + 重试、**插件自主定时回收空闲连接**（`poolSweepIntervalMs`；空闲时长自最后一次调用结算起算，**在用连接不回收**）、按上限 LRU 淘汰（**上限是硬约束**：即使候选正在被调用也关闭，该次调用以错误结算并记一条 warn） |
| 会话绑定 | `agent/session-start` → `mem_session_start({ id: dsh 会话 id, directory: 工作区 })`，读回 engram 解析出的 project；绑定是工具调用的屏障 |
| 隐式参数注入 | 声明 `project` 的工具注入项目名；`mem_session_start` 注入 `directory`，其 `id` 由插件强制；声明 `session_id` 的工具注入当前 dsh 会话 id。调用方显式传参优先 |
| 被动捕获 | `agent/turn-stopping` 取该回合最后一条未被中断的助手文本，交给 `mem_capture_passive`（`source: dsh-turn-stopping`）；同一 (会话, 回合) 只捕获一次。**桥是唯一写入者**：该工具对模型不可见、被调用时由宿主以未知工具错误拒绝（桥自身的写入走后端调用，不经工具面）。落库判据：`observations.tool_name='dsh-turn-stopping'`。engram 的抽取门槛是**空白分隔的 token 数**（纯 CJK 整句 = 1 个 token，会被判为太短而丢弃；条目要用空格分开的词 + 具体标识符，且无条数上限：实测 10 条全留） |
| 压缩恢复 | `compaction/summary` → `mem_session_summary`（摘要文本直接落库；**摘要文本为空时不提交，但记一条带 `compactionId` 的 warn**；engram 不写 `sessions.summary` 列，摘要在 `observations` 的 `session_summary` 行）；`compaction/end` 未报错时用 `mem_context` 取最近记忆，按 `recoveryTokenBudget` 截断后**投递到该次压缩所归属的收件边界**：`turn === null`（turn 之间的独立手动事务）投 `next-turn`、否则投 `next-step`。**不用 `agent.inject()`**——它等价于投 `next-step`，会在手动压缩收尾时被丢弃（实测 `outcome: canceled`） |
| 子 agent 隔离 | 两层：**执行期 guard**（按 `mcp__engram__` 前缀拒绝调用，与工具注册时序无关）+ **可见面 restrict**（注册完成后对已存在的子 agent 补装）；经 `mcp_call` 之类旁路的调用同样被拒 |
| 事件契约 | 只从宿主会话事件的**信封载荷**（`event.data.*`）读取；载荷缺失、或读取点依赖的字段缺失/类型不符时记一条 **warn**（每会话每事件类型至多一条），不静默丢弃；不新增会话事件类型 |
| 失败降级 | engram 缺失 / 握手失败 / 超时 → 不注册工具 + 一条错误日志，不阻断模型轮次。调用超时只表示桥不再等待：**不重试、不重复提交**，后端可能迟到落库（事务原子性保证无半写） |
| 卸载 | 连接池、会话状态与已注册工具随插件卸载一并释放 |

## 安装

```bash
# <repo> = 本仓库的绝对路径
dsh plugin --profile web         add <repo>
dsh plugin --profile headless    add <repo>
dsh plugin --profile open-design add <repo>
```

包自带 `dsh.bundle.patch`（`cordis.patch.yml`），安装后由它插入 `engram-bridge` entry；`~/.dsh/cordis.patch.yml` 只保留对该 entry 的 config 覆盖，不要重复写 `insert`。

## 配置

| key | 默认 | 说明 |
| --- | --- | --- |
| `command` | 必填 | engram 可执行文件路径（如 `/opt/homebrew/bin/engram`） |
| `args` | `["mcp"]` | 传给 engram 的参数 |
| `env` | `{}` | 叠加到最小继承环境之上的额外变量 |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 调用超时 |
| `poolMaxConnections` | `8` | 同时活跃的 engram 子进程上限（按工作区） |
| `poolMaxIdleMs` | `600000` | 空闲多久关闭该工作区的连接（`0` = 关闭空闲回收；空闲时长自最后一次调用结算起算） |
| `poolSweepIntervalMs` | `60000` | 插件自主回收空闲连接的检查间隔，下限 `1000`（回收精度为 `poolMaxIdleMs + 该间隔`；缺省值不会被透传给定时器，避免退化成忙轮询） |
| `projectOverrides` | `{}` | 工作区绝对路径 → engram 项目名，优先级最高 |
| `injectSessionProject` | `true` | 是否注入 `project` / `directory` |
| `injectSessionId` | `true` | 是否注入 `session_id` |
| `capturePassive` | `true` | 是否解析回合收尾的 `## Key Learnings:` 并送 `mem_capture_passive` |
| `compactionRecovery` | `true` | 压缩时持久化摘要并在压缩后注入记忆 |
| `recoveryTokenBudget` | `800` | 压缩后注入的 token 预算 |

项目名解析顺序：**显式参数 > `projectOverrides` > 该会话由 engram 解析出的项目名 > `ENGRAM_PROJECT` > 不注入**。插件不用目录名兜底；`mem_save_prompt` 的 `project` 不注入（保留给歧义恢复）。

## 模型可见影响

- **工具**：engram 工具以 `mcp__engram__*` 出现在模型工具面（N−1：被动捕获工具不注册）；对子 agent 不可见。
- **隐式参数**：见「能力」表与项目名解析顺序；调用方显式传参一律不覆盖，`mem_session_start` 的 `id` 由插件持有。
- **提示词**：不新增 system prompt 段；压缩恢复通过 `agent.send(message, target, false)` 注入一条 user 消息（`target` 见「压缩恢复」行；不唤醒空闲驱动器），落在会话日志里可重建。
- **会话日志**：不新增事件类型。
- **失败**：engram 不可用时相关能力失效并记日志，不阻断模型轮次。
