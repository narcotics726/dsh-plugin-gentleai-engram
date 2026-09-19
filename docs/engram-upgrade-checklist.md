# engram 升级回归清单

本插件的若干行为**依赖 engram 的具体语义**，且已观察到文档与实现不一致。升级 engram（或换版本线，如 v2.0.0-rc）后，按本清单逐条复测；任何一条变化都要同步 spec / design。

基线：engram **1.20.0**、dsh **0.1.2-rc.1**、node **v26.7.0**（2026-09-09 实测）。
**本机 2026-09-17 的宿主已是 dsh 0.1.5-rc.1**：第 5 组里依赖宿主形状的判据已按新版本就地改写（见该组第 2 条与第 6 条），engram 侧各组的读数仍是 1.20.0 基线下实测的。

## 0. 准备

所有 engram 侧复测都用**隔离的 engram 数据目录**，不要碰 `~/.engram`。engram **没有** `ENGRAM_DATA_DIR` 之类的数据目录变量（1.20.0 实测：只认 `$HOME/.engram/engram.db`），隔离靠把子进程的 `HOME` 指到临时目录：

```bash
export PROBE_HOME="$(pwd)/.upgrade-probe-home"
mkdir -p "$PROBE_HOME"
HOME="$PROBE_HOME" engram mcp    # engram 需在 PATH 上（或写它的绝对路径）；spawn 时等价于把 env.HOME 换成它
```

（写实验前先 `mem_session_start` 建会话行，否则 `mem_capture_passive` 以 `FOREIGN KEY constraint failed (787)` 失败。）

## 1. project 解析来源（决定连接池与注入策略）

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| `mem_current_project`（cwd = 某仓库） | `project_source` 为 `git_root` / `git_remote` 等 cwd 派生值 |
| `mem_session_start({id, directory})` | 用 **directory** 解析；设置 `ENGRAM_PROJECT` 时 directory 仍胜出 |
| `mem_save({session_id})` | `project_source: session` |
| `mem_capture_passive({session_id})` | **用 cwd**（`project_source: git_root`），忽略 session |
| `mem_session_end({id})` | **用 cwd** |

**若 `mem_capture_passive` 开始尊重 `project` / session 的项目** → 可以简化"按工作区池化"的决定（design 决策 1）。

## 2. session 语义

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| `mem_session_start` 用**不存在**的 id | 成功，创建会话 |
| `mem_save` 用不存在的 `session_id` | 硬失败 `unknown_session` |
| `mem_session_end` 之后 `mem_save` / `mem_capture_passive` / `mem_session_summary` | 1.20.0 **全部仍成功** |
| `mem_session_end` 之后再次 `mem_session_start` 同 id | 1.20.0 **成功**（文档声称 `session_already_ended`） |

**若"已结束会话不可重开"开始生效** → 必须重新评估 design 决策 6（P0 不结束会话），并考虑 `agent/disposed` 收尾的替代方案。

## 3. 被动捕获

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| 20 字符多词条目 | `extracted=0`（**静默丢弃**） |
| ~28 字符多词条目 | `extracted=1` |
| 26 字符单词（无空格） | `extracted=0` |
| **纯 CJK 整句（无空格）** | `extracted=0`（整句 = **1 个 token**，静默丢弃） |
| 同一批句子，词间插入空格 | `extracted=4`（门槛是**空白分隔的 token 数**，不是字符数） |
| 10 条带标识符的条目 | `extracted=10`（**无条数上限**） |
| 重复提交同一文本 | `duplicates>0`，不重复写入 |
| `mem_capture_passive({source: 'X'})` 的落点 | `observations.tool_name` = `'X'`（该表**没有** `source` 列，也没有回合列）；marker 同时出现在 `title`/`content` 里 |

**若阈值变化** → 更新相关 spec 与本清单（插件本身不重实现提取）。

**落库判据**：真机验收用 `observations.tool_name='dsh-turn-stopping'` 定位桥的自动捕获（已由隔离实验证实 `source` → `tool_name`）。若该映射变化 → 判据改走 `title`/`content` 定位，并同步本清单。

## 4. 多进程并发

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| 6 个进程 × 8 并发写同一 DB | 全部成功（WAL） |
| 一个进程正在退出时启动另一个 | 可能瞬时 `pragma journal_mode = WAL: database is locked`（池靠串行启动 + 重试吸收） |

## 5. dsh 侧（换 dsh 版本时）

```bash
./scripts/probe/run-probe.sh smoke smoke "hello"   # runner 自建仓库外的 throwaway DSH_HOME
```

复测四项（详见 `docs/event-findings.md`）：中止回合是否触发 `agent/turn-stopping`、`agent/created` 窗口能否 `restrict`、`session-start` 的 source 集合、`session-start` 是否先于首个回合。

再补八条（1–2 于 2026-09-10 由 `engram-bridge-p0-fixes` 补入，3 被 `engram-bridge-recall-delivery` 改写，4–5 由后者新增，6 由 `engram-protocol-hosting` 新增，7–8 由 `engram-protocol-rollout` 新增；判据见 `docs/event-findings.md` 的「Session-event envelope anchors」）：

1. **会话事件仍是信封**：随机解压一个会话日志，确认 `assistant/message` 事件的 key 集合仍含 `data`（而不是把 `turn`/`message` 平铺到顶层）。若宿主改变该形状，插件会以一条 warn（每会话每事件类型一条）暴露，而不是静默失效。
2. **工具面声明的规模**（2026-09-17 改写 —— 旧判据用了**已被宿主删掉的字段**）：判据不再是 `request/header.data.header.system`：`dsh-session` 0.1.5 的 `EpochHeader` 只剩 `config` / `adapterDefaults` / `tools`（0.1.2 才有 `system?: string`），而且 `request/header` 只在 header **变化**时追加——本机实测一个 66 step 的会话只有 **1 条**，所以它本来就不是「每次请求都有」的东西。改判据：读 `system/message` 事件的正文（渲染后的系统提示词，本机实测每会话 1 条），或在没有会话日志时直接以 `$DSH_HOME/storages/engram-bridge/tools.json` 的声明数为准；被动捕获工具不注册，所以模型可见的工具名数是声明数 **减 1**。`data.header.tools` 在 web/ptc 档只有 `run_code`，不能当判据。
3. **压缩事务的所有者与投递边界**：`compaction/end` 的 `data.turn` 仍应为 `number | null`（`null` = turn 之间的独立手动事务），且 `agent.send(message, target, wakeup)` 仍应是公开成员。
   **判据（2026-09-10 由 `engram-bridge-recall-delivery` 改写）**：手动 `/compact` 之后、用户输入**之前**，会话日志里出现由该召回开启的 `turn/start`（自该次 `compaction/end` 起到它为止不存在任何 `source.kind === 'user'` 的 `user/message`）。
   旧判据「`agent/inbox/spliced` 出现 `target: 'next-turn'` 且随后没有 `outcome: 'canceled'`」已废弃：改动后仍会通过，却证明不了投递被保住——`outcome: 'canceled'` 也可由宿主生命周期清除或插件 `inbox.remove` 产生（日志里 seq 398372 就是 `dsh-agent-instructions` 的 remove，不是压缩收尾）。
   若 `send` 消失或 turn 语义变化 → 插件记一条 warn 且不投递（不会静默复现「投递后被丢弃」）。
4. **宿主收件队列的批次规则**：`Inbox.claim(target, turn)` 应仍是「取走**整列** `next-step` + **1 条** `next-turn`」（`dsh-agent/lib/types/inbox.js`）。这决定了每条 `next-turn` 消息自成一个回合，也决定了插件为何把召回投到 `next-step`。若改成「整列 next-turn」→ 手动压缩后的召回会与用户消息合并，自恢复回合消失（退化不致命，但行为变化）。
5. **唤醒与相位的三条语义**：`send` 在**相位已 abort** 时会把 `wakeup=true` 的目标重分类为 `next-turn`；`wakeDriver` 的锁存条件是 `reason?.kind !== 'disposed' && (kind === 'maintenance' || wakeAfterAbort)`；**agent 已 disposal** 时唤醒输入停在队列无人领取（`a disposed cancel leaves it parked`）。任一改动的影响：边界重分类 → 插件不依赖队列名，无影响；锁存条件变化 → 维护相位期间的唤醒可能不再重放，自恢复回合延迟到下一次唤醒；disposed 停放 → 该次压缩不产生回合（宿主语义，插件已按通过处理）。
6. **加载期与 schema 子集**（`engram-bridge-write-layer` 新增，2026-09-19 实测）：宿主执行的是 **JSON schema 的一个子集**（`dsh-tools/json-schema`：一个标量 `type`、对象 `properties`/`required`/布尔 `additionalProperties`、数组 `items`、标量 `enum`/`const`、恰好一个 `oneOf`）。越界的工具 schema 会在 `ctx.tools.register` 里被拒 ⇒ **整棵插件树加载失败**，装了插件的 profile 全部开不了机。复测判据：`node --test test/tool-schema-subset.test.ts`（用宿主自己的校验器跑遍我们交给宿主的每个 schema 与一个真实结果值），**外加在真宿主里 boot 一次**。
   - `--dump-config` **不加载模块**（只打印组合树），所以它通过不代表能开机；**冷工具缓存也会假绿**（`registerTools` 由缓存水合或发现触发，冷缓存时 boot 可能先死在别处，工具定义根本没交给宿主）。
   - 可复制的最小真机 harness：throwaway `DSH_HOME` + 从 `headless`/`web` 模板起的 profile，`node_modules/<plugin>` 符号链接指回仓库；`--profile <p>` 起 web 档看它能不能打印 URL。判据用**热缓存**（先放好 `storages/engram-bridge/tools.json`）。
7. **热加载是两半，互相独立**（同上，2026-09-19 实测）：`dsh.profile.patchReload: live` 只 watch **profile 与 home 两个 patch 文件**（配置即时生效）；**代码**要热加载得自己挂 `hmr` 行（`dsh-base` 自带一行 `disabled: true`、`root: ['.']`）并把 `root` 指向构建产物。两者都不需要重启 dsh，但都需要重新 `apply`（插件 ctx 副作用重建；某一步的工具面在该步组装时已冻结，新面从下一次请求可见）。
   - **坏状态的代价（实测）**：写进坏代码的瞬间 entry 会先卸载再重建——加载期抛错 ⇒ `apply()` 进了但没走完；依赖语法错误 ⇒ 连 `apply()` 都没进；两种情况下宿主都活着、插件工具短暂不可用，下一次成功构建当场自愈。**磁盘停留坏代码 + 重启**才会开不了机（与 HMR 无关），恢复用 `--patch` 叠一层 `disabled: true` 把插件停掉起来修（`--patch` 要放在 `--profile` 之后、app 旗标之前）。一次真实构建（重写全部产物）只引起**一次**重载且能走完（debounce 合并写盘风暴），所以「构建过程中的半成品」不是问题，「产物本身坏」才是。
8. **常驻协议段的位置**（`engram-protocol-hosting` 新增，2026-09-17 实测）：探针的 `assemble` 记录里，段名序列中 `engram:protocol` 应仍夹在 `deployment:persona-prefix` 之后、`plan:policy` 之前。
   - **实测（dsh 0.1.5-rc.1，base+headless 探针 profile）**：`index=2`，前 `deployment:persona-prefix`、后 `plan:policy`；该段正文 193 字符；渲染出的系统提示词 4727 字符、标记出现 **1** 次（内容修订后的读数；修订前为 181 / 4715）。删掉使用者家目录里的两份手抄件后再跑一次，这三项**逐字节不变**。
   - **指纹是 profile 相关的**：使用者的 web profile 里另有第三方插件注册了 `tool:mcp:atlassian`（order **118**），所以那里的紧邻前段不是 persona。**复测时按实测记录，不要照抄这里的名字。**
   - **为什么必须复测**：宿主允许 order 重复且**不报错**——同号只按 name 的 code-unit 排序。第一方或第三方往 `(0, 500)` 里插值时，插件那一段的位置会**静默**改变，只有这条断言能发现。
   - **同一次探针还能看到另外两个信号**：`system/message` 的 `markerCount` 在**主会话**为 1、在**子 agent 会话**为 0（子 agent 没有 engram 工具，不该收到这段义务；`assemble` 记录里该段 `chars` 也是 0）；技能目录那条 `user/message`（`source: skill-catalog`）里出现技能描述。
   - 用法：`PROBE_WITH_BRIDGE=1 PROBE_MARKER='不等用户开口' ./scripts/probe/run-probe.sh <name> protocol '<task>'`（`PROBE_WITH_BRIDGE=1` 才会把本插件挂进 throwaway profile；后端指向仓库的 stub，且关掉被动捕获与压缩恢复，不会写真库）。
7. **`scope` 的取值档数**（`engram-protocol-rollout` 新增，2026-09-17 实测）：在用 engram **1.20.0** 自己的说明是**两档**（`Filter by scope: project (default) or personal`、`New scope: project or personal`），二进制里**没有** `or global`；三档（`project, personal, or global`）只出现在**上游 main** 的 tool schema 里。CLI 对 `--scope` 不做取值校验（`--scope bogus` 也照存）。协议文本写两档与**在用版本**一致，不是漂移。**升级 engram 后复测**：若已支持 `global`，再决定是否写进协议文本；拿上游 HEAD 当基线会得出错误的"漂移"结论。
8. **同名技能共存时谁胜出**（`engram-protocol-rollout` 新增，2026-09-17 实测）：**文件技能压住插件自带的 runtime 技能**。实测：真实 home 里 `~/.dsh/skills/engram-memory/SKILL.md` 与插件注册的 runtime 技能同时存在时，技能目录给出的是**文件那份**的描述（插件那份不出现）；删掉文件后目录才切换为插件那份。因此"删掉使用者机器上的手抄件"不是清理，而是**托管文本真正生效的前提**。复测方式：同时放两份，看目录给谁。

## 6. 写层：HTTP 写入面与保存入口

保存现在走 engram 的 HTTP 面（`POST /observations`），因此这一组的读数会随 engram 版本变化。1.20.0 的基线如下。

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| `POST /observations` 的 body 字段 | `session_id` / `type` / `title` / `content` / `tool_name` / `project` / `scope` / `topic_key`；`session_id`/`title`/`content` 三者缺一即 400 |
| 成功响应 | **201**，body 是 `{"id": <int>, "status": "saved"}` —— 「本次落库标识」只能从这里拿 |
| 错误响应 | 4xx/5xx 都是 `{"error": "<msg>"}`；项目与会话不一致时是 **400** + `code=session_project_mismatch`（另有 `session_project` / `project` 两个字段） |
| 会话不存在时 | 带非空 `project` 的写入**先校验会话**：会话不存在 ⇒ **404**（因此桥必须在写入前先绑定会话） |
| 与 MCP 保存逐项一致 | FTS 触发器 / 内容去重 / `topic_key` 升版 / `review_after` / 同步入队 / session 归属都相同；**只有 `tool_name` 是我们的**（MCP 那条不带 `tool_name`） |
| HTTP 路径是否插待判行 | **不插**（`AddObservation` 不跑候选扫描）；MCP 路径**插一行**，且**同一对**重复保存会再插一行 |
| `/health` | `{"service":"engram","status":"ok","version":"0.1.0"}` —— 这个 `version` **不是** engram 版本，**只能判可达性**，不能用来做版本特征检测 |

**两条与本插件行为直接相关的约束**（一条既有、一条是写层刻意引入的）：

1. **`projectOverrides` 与后端为该会话记录的项目不一致时，写入会被后端拒绝**（400 `session_project_mismatch`）。这不是新行为——上游保存工具今天同样如此——但配错覆盖时会从「写进去了」变成「明确报错」，且桥**不回退**（4xx 是请求本身有问题）。
2. **两个注入开关关闭时会挡掉保存**：`injectSessionProject=false` / `injectSessionId=false` 且调用方没有显式传值时，保存被明确拒绝（结果里说明缺哪个值、有哪两条出路）。项目那一支是**写层刻意引入的行为变化**（旧路径靠后端自己从会话推项目，仍能写成功）。两条出路：显式传值，或打开对应开关。

**去重键与时间窗决定「超时回退只落一条」是否成立**：去重要求 `normalized_hash` + `project` + `scope` + `type` + `title` 全等**且落在时间窗内**（1.20.0 默认 15 分钟）。因此：桥必须**在两条路径之前**把 `observation` 别名与缺省 `type` 归一化（否则两条路写出的 `type` 不同，去重键不等，超时回退会落成两行）；超过窗口的补写会落成**第二行**，这是设计接受的结果。

## 7. 端到端

```bash
pnpm typecheck && ENGRAM_LIVE=1 pnpm test
```

再按已归档变更的验收记录跑一次宿主验收（`openspec/changes/archive/2026-09-10-engram-bridge-p0-fixes/tasks.md` 的「验收证据」段：新会话绑定 / 会话不串档 / 学习条目落库一次 / 压缩后摘要落 `observations.session_summary` + 召回投递到 `next-turn` / `engram doctor` 无 mismatch / 卸载无残留）。
