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
related:
  specs:
    - engram-session-binding
    - engram-bridge-runtime
    - engram-memory-continuity
---
# engram-compaction-recovery Specification

## Purpose
压缩会丢弃会话历史：本能力把压缩摘要持久化到 engram，并在压缩完成后把最近的相关记忆重新提供给模型，使压缩之后的对话仍然带着记忆继续。

## Requirements

### Requirement: 压缩摘要持久化
插件 SHALL 在收到 `compaction/summary` 事件时，把该事件携带的摘要内容提交给 engram 的会话摘要入口并归属当前会话；插件 SHALL NOT 自行生成摘要文本。

#### Scenario: 一次压缩完成
- **WHEN** 一次压缩产生 `compaction/summary` 事件
- **THEN** engram 中该会话下出现一条会话摘要记录，其内容等于该事件的摘要内容

#### Scenario: 压缩失败
- **WHEN** `compaction/end` 携带错误
- **THEN** 插件不提交摘要，engram 中该会话的 summary 不变

### Requirement: 压缩后恢复记忆上下文
在 `compaction/end` 成功之后，插件 SHALL 通过 engram 的上下文入口取当前项目最近的记忆并作为一条模型可见上下文注入；注入内容 SHALL NOT 超过 `recoveryTokenBudget`。注入 SHALL 投递到该次压缩所归属的收件边界：该次 `compaction/end` 的 `turn` 为 `null`（宿主定义为 turn 之间的独立手动事务）时投递 `next-turn`，为数字时投递 `next-step`；插件 SHALL NOT 使用会在该次事务收尾时被丢弃的边界（宿主契约里 `agent.inject()` 等价于 `send(message, 'next-step', false)`，其队列明示可被 cancellation/disposal 丢弃）。宿主不提供 `send` 时 SHALL 记一条 warn 且不投递（SHALL NOT 以 `inject` 顶替）。

#### Scenario: 压缩后继续同一回合
- **WHEN** 压缩完成且回合继续（`compaction/end` 的 `turn` 为数字）
- **THEN** 后续模型请求包含一条来自 engram 的记忆上下文

#### Scenario: 手动压缩（turn 之间的独立事务）
- **WHEN** 手动触发压缩且 `compaction/end` 的 `turn` 为 `null`
- **THEN** 该记忆上下文被投递到 `next-turn` 边界并在下一个回合的模型请求里出现，且不唤醒空闲的驱动器

#### Scenario: 超过预算
- **WHEN** 可用记忆超出 `recoveryTokenBudget`
- **THEN** 注入内容被截断到预算之内，回合继续

#### Scenario: 记忆不可用
- **WHEN** 注入时 engram 不可用
- **THEN** 不注入，回合继续，日志记录一次失败

#### Scenario: 宿主不提供 send 边界
- **WHEN** 宿主 agent 没有 `send` 方法
- **THEN** 不注入，且记一条 warn（不用 `inject()` 顶替，避免静默复现投递被丢弃的缺陷）

### Requirement: 压缩处理幂等
同一次压缩（同一 compactionId）SHALL 至多产生一次摘要写入与一次上下文注入。

#### Scenario: 事件重复到达
- **WHEN** 同一 compactionId 的 `compaction/summary` 或 `compaction/end` 被投递多次
- **THEN** 只处理一次，engram 中不出现重复摘要，模型侧不出现重复注入

### Requirement: 不改写压缩的替换事件
插件 SHALL NOT 修改或替换 `compaction/summary` 之后紧跟的 `user/message` 替换事件。

#### Scenario: 压缩后的历史替换
- **WHEN** 压缩完成并产生替换历史的消息
- **THEN** 该消息由 dsh 写入，插件未插入或改写任何会话事件

### Requirement: 压缩恢复开关
`compactionRecovery` 为 false 时，插件 SHALL NOT 写入摘要、SHALL NOT 注入上下文。

#### Scenario: 关闭压缩恢复
- **WHEN** `compactionRecovery` 为 false 且发生压缩
- **THEN** engram 中该会话 summary 不变，模型侧无注入

### Requirement: 压缩恢复失败不阻断回合
摘要写入或上下文注入失败 SHALL NOT 阻断回合，SHALL NOT 改变用户可见回复。

#### Scenario: 写入失败
- **WHEN** 提交摘要时 engram 返回错误
- **THEN** 回合照常完成，用户可见回复不受影响，日志记录一次失败

### Requirement: 空摘要不静默

当 `compaction/summary` 的摘要**文本**为空时（`summary` 为空数组，或不含任何 `text` 块），插件 SHALL NOT 向 engram 提交摘要，SHALL 记录一条 warn 级日志（日志 SHALL 带上该次 `compactionId`，使"正常的无可摘要"与"摘要构造/读取异常"在事后可区分），且 SHALL NOT 因此产生任何记忆写入。

（"空"是合法形状 `summary: ContentBlock[]` 的取值之一，成因至少两种：驱动器的正常空摘要，或读取/构造侧的异常。插件无法在事件里区分两者，因此 SHALL NOT 把它当成错误处理（不提交、不重试），也 SHALL NOT 完全无声。同一 compactionId 的 `compaction/summary` 在压缩契约下至多出现一次，因此无需为"后续再补一次"保留去重位。）

#### Scenario: 空摘要
- **WHEN** 收到 `compaction/summary` 且其摘要文本为空（空数组或不含 text 块）
- **THEN** engram 中不出现该会话的摘要写入，日志中出现一条带 `compactionId` 的 warn 级记录，且该次压缩后续的 `compaction/end` 仍按正常路径处理
