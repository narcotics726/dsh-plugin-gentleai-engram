---
id: engram-memory-continuity
title: Engram Memory Continuity
type: capability.behavior
status: draft
triggers:
  keywords:
    - 记忆连续性
    - 会话归属
    - Key Learnings
    - memory continuity
  read_when:
    - 判断 dsh 会话的记忆归属与落库是否按预期
    - 评审 engram 桥对使用者的可观察结果
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  events:
    - agent/session-start
    - agent/turn-stopping
related:
  specs:
    - engram-bridge-runtime
    - engram-session-binding
    - engram-context-injection
    - engram-passive-capture
---
# engram-memory-continuity Specification

## Purpose
让使用者在 dsh 里获得可预期的记忆连续性：一次会话产生的记忆归属清晰、任务收尾写下的学习条目真的被记住、记忆后端不可用时对话照常，且记忆不会越界写进别的项目。

## Requirements

### Requirement: 会话级记忆归属
同一次 dsh 会话产生的记忆 SHALL 只归属于该会话对应的记忆会话；不同会话的记忆 SHALL NOT 互相混入。

#### Scenario: 同一工作区的两个会话各自保存
- **WHEN** 在同一工作区先后开启两个会话，并各保存一条记忆
- **THEN** 按会话查看时，每个会话只看到自己保存的那一条，且两条不会同时出现在同一个会话下

#### Scenario: 会话恢复后继续保存
- **WHEN** 重新打开之前的一个会话并再保存一条记忆
- **THEN** 这条记忆与之前那条归属同一个会话，不新建另一个会话

### Requirement: 学习条目落库
当助手回复按约定在收尾写下学习条目时，这些条目 SHALL 随后续会话可检索到；不写该段落时 SHALL NOT 新增条目。

#### Scenario: 回复含学习段落
- **WHEN** 助手回复以约定的学习段落收尾，段落内包含若干条目
- **THEN** 这些条目出现在记忆里，且归属该次会话，后续会话可检索到

#### Scenario: 回复不含学习段落
- **WHEN** 助手回复没有该段落
- **THEN** 记忆里不新增任何条目

### Requirement: 记忆不可用不阻断对话
记忆后端不可执行、握手失败或单次操作超时时，使用者 SHALL 仍能完成对话与工具调用。

#### Scenario: 记忆后端不可执行
- **WHEN** 配置指向的记忆可执行文件不存在
- **THEN** 会话仍能完成一轮完整对话，且使用者看不到因记忆导致的中断

#### Scenario: 单次记忆操作超时
- **WHEN** 一次记忆操作超过约定时限
- **THEN** 该操作失败，会话继续，使用者可见回复不受影响

### Requirement: 写入范围限定
会话产生的记忆 SHALL 只出现在该会话工作区所属的项目下，SHALL NOT 出现在其他项目下。

#### Scenario: 工作区与进程环境不一致
- **WHEN** 会话工作区为 A，而记忆后端进程所处的环境指向项目 B
- **THEN** 该会话新产生的记忆出现在 A 下，且不出现在 B 下
