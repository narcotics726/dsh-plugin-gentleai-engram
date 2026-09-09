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

## Purpose

压缩会丢弃会话历史：本能力把压缩摘要持久化到 engram，并在压缩完成后把最近的相关记忆重新提供给模型，使压缩之后的对话仍然带着记忆继续。

## ADDED Requirements

### Requirement: 压缩摘要持久化
插件 SHALL 在收到 `compaction/summary` 事件时，把该事件携带的摘要内容提交给 engram 的会话摘要入口并归属当前会话；插件 SHALL NOT 自行生成摘要文本。

#### Scenario: 一次压缩完成
- **WHEN** 一次压缩产生 `compaction/summary` 事件
- **THEN** engram 中当前会话的 summary 等于该事件的摘要内容

#### Scenario: 压缩失败
- **WHEN** `compaction/end` 携带错误
- **THEN** 插件不提交摘要，engram 中该会话的 summary 不变

### Requirement: 压缩后恢复记忆上下文
在 `compaction/end` 成功之后，插件 SHALL 通过 engram 的上下文入口取当前项目最近的记忆并作为一条模型可见上下文注入；注入内容 SHALL NOT 超过 `recoveryTokenBudget`。

#### Scenario: 压缩后继续同一回合
- **WHEN** 压缩完成且回合继续
- **THEN** 后续模型请求包含一条来自 engram 的记忆上下文

#### Scenario: 超过预算
- **WHEN** 可用记忆超出 `recoveryTokenBudget`
- **THEN** 注入内容被截断到预算之内，回合继续

#### Scenario: 记忆不可用
- **WHEN** 注入时 engram 不可用
- **THEN** 不注入，回合继续，日志记录一次失败

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
