---
id: engram-protocol
title: Engram Protocol
type: technical.contract
status: draft
triggers:
  keywords:
    - 常驻协议段
    - 技能正文
    - 提示词段
  read_when:
    - 修改随包分发的常驻协议文本或技能正文
    - 排查模型看不到义务文本或看到失效的工具名
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  files:
    - protocol/resident.md
    - protocol/engram-memory.skill.md
    - src/protocol.ts
related:
  specs:
    - engram-bridge-runtime
    - engram-bridge-save
---

## ADDED Requirements

### Requirement: 文本里要求模型调用的记忆工具都在场

常驻触发段与随包分发、按需加载的做法正文里**要求模型调用**的每个记忆工具 SHALL 是模型当时可见的工具之一。文本可以提到一个不在场的名字，但 SHALL 同时说明它不可调用——通常是因为它正是「刻意不注册」的解释对象。

#### Scenario: 某个工具被撤下之后

- **WHEN** 一个记忆工具被刻意不注册
- **THEN** 文本里不再**要求**模型调用它，取代它的那个名字确实出现在模型可见的工具面上

#### Scenario: 提到不在场的名字时说明不可调用

- **WHEN** 文本为了说明「刻意不注册」而提到一个不在工具面上的名字
- **THEN** 该处同时写明它不可调用，因此该提及与「要求模型调用」是可区分的两回事

#### Scenario: 一致性检查的基线

- **WHEN** 在未改动的随包文本上运行该一致性检查
- **THEN** 它通过；把某个已撤下的名字改成「要求模型调用」的写法之后，它失败并指名那个名字
