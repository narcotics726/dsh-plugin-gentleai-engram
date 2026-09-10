---
id: engram-compaction-recovery
title: Engram Compaction Recovery
type: technical.contract
status: draft
triggers:
  keywords:
    - compaction
    - 压缩恢复
    - mem_session_summary
  read_when:
    - 实现或评审压缩后的记忆持久化与恢复
    - 排查压缩后记忆丢失
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  events:
    - compaction/summary
    - compaction/end
  config_keys:
    - compactionRecovery
    - recoveryTokenBudget
    - recallWakeup
related:
  specs:
    - engram-session-binding
    - engram-bridge-runtime
    - engram-memory-continuity
---

## MODIFIED Requirements

### Requirement: 压缩后恢复记忆上下文

在 `compaction/end` 成功之后，插件 SHALL 通过 engram 的上下文入口取当前项目最近的记忆并作为一条模型可见上下文注入；注入内容 SHALL NOT 超过 `recoveryTokenBudget`。

注入的时机 SHALL 由该次压缩所属回合的边界决定：

- `compaction/end` 的 `turn` 为数字（该压缩被该回合包住）时，注入 SHALL 交给该回合，在其下一个 step 边界被领取，且 SHALL NOT 因此新建回合；
- `turn` 为 `null`（宿主定义为 turn 之间的独立手动事务）时，插件 SHALL 以**唤醒**方式投递，使其成为一轮独立回合的模型输入。插件 SHALL NOT 引入额外的等待（不轮询、不延时投递、不等待下一次用户输入）。

（本要求只约束「插件投了什么、以什么唤醒位投、在不等待这件事上做了什么」。投递之后由宿主决定该输入何时被领取——包括维护相位锁存、相位中止时的边界重分类、以及 agent 已 disposal 时唤醒输入停放——那些是宿主语义，插件 SHALL NOT 依赖某个具体的收件队列名。）

该注入 SHALL 自述其来源是压缩后的自恢复访问，且措辞 SHALL NOT 依赖「本回合是否已带用户输入」：本回合没有其他用户输入时，模型 SHALL 只做一句轻量确认（说明恢复了哪些近期记忆、有无明显缺口）；本回合带有用户输入时，模型 SHALL 按该输入回答并把本段当作背景。

插件 SHALL NOT 以「只投递、不唤醒」的方式依赖该上下文在队列中存活：宿主契约明示「pending 输入可被 cancellation 或 disposal 丢弃」。配置 `recallWakeup` 为 `false` 时，手动压缩路径 SHALL 抑制唤醒，该上下文 SHALL 仍被投递并等待下一次用户输入领走——该分支是**已知的退化模式**，其丢失概率高于唤醒分支，SHALL 在文档中如此标注。

宿主不提供 `send` 时，插件 SHALL 记一条 warn 且不投递——SHALL NOT 回落到任何不携带唤醒位的投递方式，那会静默复现本要求要修的缺陷。

#### Scenario: 压缩后继续同一回合
- **WHEN** 压缩完成且回合继续（`compaction/end` 的 `turn` 为数字）
- **THEN** 后续模型请求包含一条来自 engram 的记忆上下文，且不因此新建回合

#### Scenario: 手动压缩（turn 之间的独立事务）
- **WHEN** 手动触发压缩且 `compaction/end` 的 `turn` 为 `null`
- **THEN** 该记忆上下文以唤醒方式被投递，并成为一轮独立回合的模型输入；该回合的所有 `user/message` 中不存在任何用户来源的消息（`source.kind !== 'user'`）

#### Scenario: 用户抢在交付之前发言
- **WHEN** 手动压缩后、召回被投递之前用户已经发言
- **THEN** 该记忆上下文与该用户消息出现在**同一个**回合里，且插件不为此产生额外的孤儿回合

#### Scenario: 自恢复回合的注入内容
- **WHEN** 该上下文被投递并成为模型输入
- **THEN** 文本自述这是压缩后的自恢复上下文，且其措辞在没有用户输入与已有用户输入两种情形下都自洽

#### Scenario: 关闭唤醒
- **WHEN** `recallWakeup` 为 `false` 且手动压缩完成
- **THEN** 该上下文被投递但不唤醒空闲驱动器，等待下一次用户输入领走；文档将其标注为已知退化模式

#### Scenario: 上下文在领取之前被清除
- **WHEN** 投递之后、驱动器领取之前，该上下文被宿主清除（例如进程重启或 agent disposal）
- **THEN** 宿主的唤醒语义可能仍开启一个回合边界而不含任何消息；插件 SHALL NOT 因此报错或重试

#### Scenario: 宿主 agent 已不可用
- **WHEN** 投递时该会话的 agent 已被 disposal
- **THEN** 注入不产生任何回合（宿主持有该语义）；插件不因此报错，也不重复投递

#### Scenario: 连续两次压缩
- **WHEN** 自恢复回合仍在进行时用户再次触发压缩
- **THEN** 宿主给出明确的「当前不可压缩」反馈，插件不因此产生额外的记忆写入或重复注入

#### Scenario: 自恢复回合内触发压缩
- **WHEN** 自恢复回合进行中发生一次被该回合包住的压缩（`turn` 为数字）
- **THEN** 该次注入由进行中的回合领取、不新建回合，且不递归触发新的自恢复回合

#### Scenario: 超过预算
- **WHEN** 可用记忆超出 `recoveryTokenBudget`
- **THEN** 注入内容被截断到预算之内，该回合继续

#### Scenario: 记忆不可用
- **WHEN** 注入时 engram 不可用
- **THEN** 不注入，回合继续，日志记录一次失败

#### Scenario: 宿主不提供 send 边界
- **WHEN** 宿主 agent 没有 `send` 方法
- **THEN** 不注入，且记一条 warn（不回落到不携带唤醒位的投递方式，避免静默复现投递被丢弃的缺陷）
