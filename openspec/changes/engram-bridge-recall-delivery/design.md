## Context

压缩恢复的注入在 2026-09-10 修好了「投递被丢弃」，真机复验随即暴露第二个问题：**时机**。动机见 `proposal.md - Why`；本节只记约束与技术依据。

### 宿主收件队列的规则

`@deepseek-ai/dsh-agent/lib/types/inbox.js`：

    claim(target, turn) {
        const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false);
        if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false));
    }

一次回合边界取走**整列 `next-step`**，但只取 **1 条 `next-turn`**。类型注释把语义写死：`nextTurn` = "Prompts awaiting individual turns"，`followup` = "becomes the sole ordinary message of its own turn"，`steer` = "An idle driver starts a turn; a running driver consumes it at its next step boundary"。

`send()` 一律先入队再唤醒（`agent-loop/lib/index.js:398-399`）：`inbox.splice(target, Infinity, 0, [message])` 是**追加**，且存在两个会改写结果的宿主分支（见 D2）。`Inbox` 另有 `prepend/remove/replace/claim/clear/splice` 公开方法（`inbox.js:50-127`），一等方插件 `dsh-agent-instructions` 就直接用 `agent.inbox.prepend/remove/replace`。

### 实测形状（session `c1f66fd4`）

| seq | 时刻（UTC） | 事件 | 含义 |
| --- | --- | --- | --- |
| 420715 | 05:50:32.939 | `spliced next-turn start 0` | 召回入队（3,227 字符） |
| 420716 | 05:51:11.995 | `spliced next-turn start 1` | 用户消息被排到召回之后 |
| 420717 / 420718 | 05:51:11.99x | `turn/start` / 取走 1 条 | turn 28 的请求里只有召回（`user/message` 420720 即召回） |
| 437498 / 437499 / 437501 | 05:52:50.3 | `turn/start` / 取走 1 条 / `user/message` | 用户消息直到 turn 29 才被消费，rpcId 与 420716 相同 |

### 关于 303820/303821 的因果：证据强度分层

| seq | 时刻（UTC） | 事件 |
| --- | --- | --- |
| 303820 | 05:31:17.273 | 召回插入待领取队列 |
| 303821 | 05:31:43.487 | `{removedCount:1, inserted:[], outcome:'canceled'}` |
| 303822 | 05:32:00.780 | `session/end-seed`（带 seed 构造 Session，即进程/会话 resume 标记） |
| 303831 | 05:32:21.571 | `request/header reason:"resume"` |

**能确证的**（宿主契约原文，强证据）：`inject` 的契约注释是 "…pending context. **Cancellation or disposal may discard pending context.**"（`runtime-types.d.ts:132`）——丢弃的触发条件是 **cancellation 或 disposal**，与「压缩事务收尾」无关。产生 `outcome:'canceled'` 的路径只有 `agent.cancel()→inbox.clear()` 与 `inbox.remove()/replace()`；web 的用户中断走 `keepInbox:true` 不清队列。**因此「投 next-step 的召回在手动压缩收尾时必然被丢弃」这一旧结论不成立**——这正是上一轮 D10 的依据，本变更予以更正。

**不能确证的**（弱证据，只作推断）：这次撤销发生在 `end-seed` **之前 17.3 秒**，两者之间无任何事件。时间线只支持「撤销之后不久发生了重启」，**不支持「撤销由重启引起」**。旧解读（闲置 26.2 秒后被某种超时清除）与新解读在时间线上同等自洽；宿主源码里也找不到 26 秒量级的超时路径。因此本节只主张「成因未被钉死」，**不主张**「next-step 不会因久等被丢弃」是从日志读出来的——那条结论来自上面的宿主契约原文。

对设计的影响：**不能把「换个队列更稳」当理由**。两条队列的丢弃条件相同（`inbox.clear()` 清 next-step 与 next-turn 两条）。真正让方案稳的是**把召回留在队列里的时间压到最短**。

## Goals / Non-Goals

**Goals:**

- 手动压缩后召回以**可预期的时机**成为模型输入：插件不引入额外等待，压缩一结束就打开一轮回合。
- 该回合是明确的「自恢复回合」，模型知道自己在做什么、也知道不要做什么（且该文本与「用户是否已抢先发言」无关）。
- 不改变运行中压缩（`turn` 为数字）的既有路径与已验证行为。

**Non-Goals:**

- 不解决「召回文本里应该放什么记忆」——检索与排序属于 engram 与 `engram-memory-continuity`。
- 不引入新的会话事件类型，也不新增 system prompt 段。
- 不改动 `Inbox` 的宿主语义（不 `prepend`、不 `remove` 别人的队列项），也不依赖某个具体的收件队列名——边界可能被宿主改写（D2）。

## Decisions

### D1 投递路径：五条候选，逐条给依据

| # | 路径 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 压缩时投 `next-step`、**不唤醒**（上一轮 D10 的形状） | 否决（**产品**） | 机制上可用：idle 时它停在队列里，等到用户下一条消息触发回合，`claim` 会把整列 `next-step` 拼在该回合批次**最前面**——召回与用户消息同回合。但用户明确要的是「压缩后的一轮自省」，而不是让召回搭车；且停等期间暴露于 cancellation/disposal |
| 2 | 监听 `agent/inbox/inserted`，用户消息入队时补投 | 否决（可行性未证） | 事件确实存在且是同步 emit（`runtime-types.d.ts:177-187` `@mode emit`，`Inbox.mutate` 在 `send()` 内、`wakeDriver` 之前发出）。但它是 **scope 过滤**的，根 ctx 注册的监听器能否收到未实测；且它把「何时投递」变成被动响应，收益只是省一次回合 |
| 3 | `agent/pre-step` waterfall 前置到该步 messages | 否决（**产品**） | 契约可行（"replace the messages that enter it"，返回的 `messages` 会被 `turn()` 逐条记成 `user/message`），确定性最好；但它把召回塞进用户提问的那一步，模型没有机会先自查，用户也看不到「记忆已恢复」 |
| 4 | `send(recall, 'next-turn', true)` | 否决（**竞态下更差**） | idle 时与 (5) 同形；但用户消息若已排在队首，`claim` 先取走的是**用户消息**，召回被留到用户回合**之后**另起一回——用户的问题先被回答，随后冒出一个孤儿召回回合 |
| **5** | **`send(recall, 'next-step', true)`（≡ `steer`）** | **采纳** | idle 时 "An idle driver starts a turn" → 与 (4) 同形的一轮自省回合；用户消息已入队时，`claim` 把整列 `next-step`（召回）与那 1 条 `next-turn`（用户消息）**合进同一回合**，召回在前——竞态下反而最自然 |

**统一规则**：注入的**唤醒位**只在「该次压缩不属于任何回合」（`turn === null`）时打开；两处的可观察差异完全来自驱动器相位。

⚠️ **「目标恒为 next-step」不是实现层的保证**：`send()` 的 `wakingAfterAbort` 分支会在**相位非 idle 且已 abort**时把目标重分类为 `next-turn`（`agent-loop:395-398`）。因此规范与实现都以「唤醒位 + 不引入等待」为契约，把边界当作宿主细节，不写进 SHALL。

代价是每次手动 `/compact` 多一个 LLM 回合；由 D3 的开关允许拒绝。

### D2 宿主侧的三条分支（本插件的义务止于「投了什么、带什么唤醒位」）

| 分支 | 宿主行为 | 出处 | 对本插件的影响 |
| --- | --- | --- | --- |
| **A 相位空闲** | `wakeDriver` 直接 `setPhase(running)` 并同步走到 `claim` | `agent-loop:449-463`、`dsh-agent/lib/index.js:491-493` | 实测走这条：`command/done`（420714 05:50:32.932）早于交付（420715 .939）7ms，而 `command/done` 是结算后写 → 维护相位已让出 |
| **B 维护相位锁存** | `wakeDriver` 只置 `wakeRequested`，唤醒在 `runMaintenance` 的 `finally` 重放 | `agent-loop:450-452`、`:436` | 仍会立刻起回合，但延迟 = 交付延时 **+ 该维护相位的剩余时长（无上限）** |
| **C 目标重分类 / 停放** | 相位已 abort → 目标改判为 `next-turn`；agent 已 disposal → 唤醒输入停放，无人领取 | `agent-loop:395-398`；`runtime-types.d.ts` 的 send 契约 "a `disposed` cancel leaves it parked" | 本插件不依赖目标名，故 C① 无影响；C② 下「立即成为独立回合」在该分支**不成立**，属宿主语义，spec 用单独的 scenario 承认 |

因此 spec 的「立即」被定义为**插件侧不引入等待**（不轮询、不延时、不等用户），而不是端到端延迟上界——后者在 B 分支下由宿主决定。

### D3 注入文本序无关，并配一个退回开关

注入文本 SHALL NOT 假设「本回合没有用户输入」——反序竞态下它可能是错的（用户消息先入队，召回被并入用户那一回合）。文本写成条件式：本回合若无其他用户输入，只做一句轻量确认（说明恢复了哪些近期记忆、有无明显缺口）；若有用户输入，按它回答、把本段当背景。

新增 `recallWakeup`（默认 `true`）。置 `false` = 不唤醒，召回停在待领取队列**等待用户下一条消息搭车**，即 D1 候选 (1) 的旧行为。它是**已知退化模式**而非等价选项：停等期间召回会被 cancellation/disposal 清除。放开关的理由是成本真实（每次手动 `/compact` 一个 LLM 回合），用户应当能拒绝。

### D4 「不携带唤醒位的投递」才是被禁止的形状

上一轮的规范句写成「SHALL NOT 使用会在该次事务收尾时被丢弃的边界（= `inject()`）」——这个理由**不成立**：宿主契约里 `steer` 用的是同一条队列，丢弃条件（cancellation/disposal）也相同；而本设计允许的 `recallWakeup=false` 分支与 `inject()` 是同一个形状。

真正被禁止的是**「只投递、不唤醒、并指望它靠自己的存活等到下一次用户输入」这种默认行为**：它把召回的可达性交给一个明示可被清除的队列。规范句据此改写为对**唤醒位**与**已知退化模式标注**的约束，不再提「收尾丢弃」。

### D5 保留「宿主无 `send` 只记 warn、不投递」

不变，继续禁止回落到任何不携带唤醒位的投递方式——那会静默复现本变更系列要修的原始缺陷。

## Risks / Trade-offs

- **每次手动 `/compact` 多一个 LLM 回合**（用户不打算继续时也一样）→ `recallWakeup` 开关；文档里写成既定成本。
- **连续两次 `/compact` 报不可用**（新增的用户可见失败）：`compactNow` 用 `agent.runMaintenance` 包住整个过程，而 `runMaintenance` 在相位非 idle 时**同步抛错**（`agent-loop:418`），命令层文案是 "Compaction is unavailable because this process has an active compaction, or the agent is not idle."（`dsh-command-compact/lib/index.js:19-22`）。改动前 `/compact` 结束后 agent 立即回到 idle，连按两次可行；改动后自恢复回合期间会撞上。→ 保持该回合极短 + README 写明「压缩后需等这一轮跑完才能再次压缩」。
- **B 分支下延迟无上界**（维护相位剩余时长）→ 不作为插件义务；在清单 §5 记录宿主语义（tasks 5.3），若将来相位模型改变则重新评估。
- **C② 分支（agent 已 disposal）下「立即」落空** → spec 单列场景承认，插件不报错、不重试。
- **唤醒输入在领取前被清除** → 宿主仍会开启一个不含消息的回合（`runtime-types.d.ts` 的 send 契约明示）；spec 单列场景，验收时按通过处理。
- **自恢复回合「开工」** → 注入文本约束 + `~/.dsh/AGENTS.md` 改措辞；**不设绝对计数判据**（模型为核实缺口调用 `mem_context` 属预期），只记观察项。
- **反序竞态** → 注入文本序无关；召回与用户消息同回合，不产生孤儿回合。该窗口（Path A 实测 18–20ms）无法在真机人为构造，故不设真机项，只由 3.1 的单测覆盖措辞。
- **额外一次被动捕获写入**：自恢复回合同样以 `agent/turn-stopping` 收尾，会触发一次 `mem_capture_passive`；若模型按 `AGENTS.md` 惯例输出 Key Learnings，会多出一次观测写入。→ AGENTS.md 明确豁免该回合，并在 Risks 承认噪声写入。
- **因果证据强度不足**：303820/303821 的成因只有排除法与相邻性，未钉死 → 归档记录**不改写**（见修订记录与 tasks 7.2），只在长期清单里记录依赖的宿主语义。

## Migration Plan

无数据迁移。配置新增项有默认值，旧配置继续有效。回退策略 = 置 `recallWakeup: false`（退回「投递但不唤醒」）或回滚提交；两者都不影响已落库的记忆。

## 修订记录

本变更的规划件经两轮对抗评审后修订，修订内容如下（作为审计锚点；产物在修订前后有实质差异）。

**第一轮（技术挑战者，16 条）：**

1. 更正 303820/303821 的因果表述——**但本次（第二轮）进一步降级为「成因未钉死」**，见下。
2. 修正 delta 规格里互斥的两条 SHALL（「不等用户」vs「关闭开关时不唤醒」）。
3. 删除「等用户消息到达后再补投——时序上没有窗口」这一错误论断，改为「候选存在但 scope 投递未实测」。
4. 补评第 5 条候选（`steer` 形状），据此把投递从 `next-turn`+唤醒改为 `next-step`+唤醒。
5. 验收判据去歧义：区分 reminder 与用户消息（`source.kind === 'user'`）。
6. 判据去主观化（原先的「符合轻量确认约束」不可证伪）。
7. 补反序竞态场景，注入文本改为序无关。
8. 补「连续两次压缩」与「自恢复回合内触发压缩」场景。
9. 量化队列暴露窗口，删掉「不受该窗口影响」的错误断言。
10. 命名两条相位路径；判据以 `command/done` 为锚点。
11. `recallWakeup` 标为已知退化模式，补复位步骤。
12. 点名三处会变成假话的文档/注释（README、`~/.dsh/AGENTS.md`、源码与测试注释）。
13. 改写升级清单里已失效的旧判据。
14. 补 `CompactionOptions` 字段与传参点。
15. proposal 补可观察验收信号、下沉 API 细节。
16. 承认自恢复回合带来的一次额外被动捕获写入。

**第二轮（Business Analyst，12 条）：**

1. 更正计数口径（任务数、`next-turn` 出现处）。
2. **把 303820/303821 的因果从「进程重启」进一步降级**：时间线上撤销先于 `end-seed` 17.3 秒、其间零事件，只能证明「之后不久重启」，不能证明因果；结论改由宿主契约原文支撑（`runtime-types.d.ts:132`）。
3. 改写规范句的禁令理由（删掉「收尾丢弃」），并把禁令对象从「某个队列」改为「不携带唤醒位的投递」。
4. 补三条宿主分支（相位空闲 / 维护锁存 / 目标重分类与停放），并承认「目标恒为 next-step」在实现层不成立。
5. 承认 Path B 的延迟无上界，把 spec 的「立即」定义为插件侧不引入等待。
6. 撤掉「绝对计数」判据（依赖模型行为），改为客观判据 + 观察项两段式。
7. 让 6.3 可判定（SQL 计数差分）。
8. 补「上下文在领取前被清除」「agent 已不可用」两个场景。
9. **不再默认改动 archive**：因果更正落点改到本变更 design + 长期清单；改 archive 需用户明确同意。
10. 不预圈后续挑战范围，也不把「跳过挑战直接 apply」摆上选项。

## Open Questions

- 取消开关、把回滚完全交给 revert 是否更好？当前保留开关，因为「每次压缩付一个回合」是用户可感知的成本。
- 自恢复回合是否值得固定成回执模板（例如由插件在文本里给出格式）？当前只给约束、不给模板，真机跑几轮后再定。
