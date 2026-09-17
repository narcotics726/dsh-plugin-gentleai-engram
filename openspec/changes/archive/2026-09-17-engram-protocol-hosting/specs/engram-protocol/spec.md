---
id: engram-protocol
title: Engram Protocol
type: capability.behavior
status: draft
triggers:
  keywords:
    - 协议文本
    - 常驻触发条件
    - system prompt 段
    - 记忆技能
  read_when:
    - 修改模型面看到的 engram 义务、触发条件或流程文本
    - 排查「模型没有按约定保存或检索记忆」或文本与插件版本不一致
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  packages:
    - '@deepseek-ai/dsh-system-prompt'
    - '@deepseek-ai/dsh-skill'
related:
  specs:
    - engram-bridge-runtime
    - engram-memory-continuity
---

## Purpose

让模型在每个会话里都知道自己有什么 engram 义务、什么时候必须做，而这份告知随插件版本走、不依赖使用者机器上的任何文件。

## ADDED Requirements

### Requirement: 义务的告知随插件分发

模型在任何会话里 SHALL 能看到「什么时候必须做记忆操作」的触发条件，且这份条件 SHALL 由插件本身提供，SHALL NOT 依赖使用者机器上的任何文件存在。

#### Scenario: 全新机器上也有

- **WHEN** 在一个从未放过任何 engram 文本的机器上开启会话
- **THEN** 该会话的模型仍然看到这份触发条件

#### Scenario: 删掉机器上的同名文本不影响模型所见

- **WHEN** 使用者删掉机器上此前手抄的同类文本，再开启会话
- **THEN** 模型看到的内容与删除前逐字一致

#### Scenario: 随插件版本更新

- **WHEN** 插件里的这份文本被修改并更新到机器上
- **THEN** 下一次请求里模型看到的内容随之改变，不需要改动使用者机器上的任何文件

#### Scenario: 停用插件后不再出现

- **WHEN** 插件被停用
- **THEN** 模型不再看到这份触发条件，且它此前占据的位置不留任何残留

### Requirement: 常驻的只有触发条件，做法按需加载

常驻部分 SHALL 只包含「什么时候必须做」；完整做法 SHALL 以可被模型按名加载的技能提供，SHALL NOT 常驻。常驻部分 SHALL NOT 引用使用者机器上的文件作为触发条件的出处。

#### Scenario: 未加载时做法不在上下文里

- **WHEN** 会话开始后模型没有加载该技能
- **THEN** 触发条件在，而完整做法（保存格式的字段清单与逐步流程）不在模型能看到的任何输入里

#### Scenario: 加载后得到完整做法

- **WHEN** 模型按名加载该技能
- **THEN** 它得到完整做法，且与触发条件描述的是同一套义务，不互相矛盾，也没有指向机器上某个文件的悬空引用

### Requirement: 义务文本的可见范围与这套工具一致

这段义务文本与面向模型的这套记忆工具 SHALL 具有相同的可见范围：工具对某个 agent 不可见时，这段文本 SHALL NOT 出现在它的输入里。这条一致性 SHALL 由插件自己维持。

#### Scenario: 子 agent 不承担

- **WHEN** 一次会话派出一个子 agent，而该子 agent 看不到这套工具
- **THEN** 它的输入里不出现这段义务文本

### Requirement: 常驻文本的内容与次序稳定

这段常驻文本的正文 SHALL 是固定的，SHALL NOT 随会话、工作区、回合或记忆后端是否可用而改变；它在提示词中的相对次序 SHALL 由插件固定，SHALL NOT 随会话变化。

#### Scenario: 同一会话的多次请求

- **WHEN** 同一会话在不同步骤各组装一次模型输入
- **THEN** 这段文本的正文逐字相同

#### Scenario: 不同会话之间

- **WHEN** 两个不同的会话（不同工作区）各自组装模型输入
- **THEN** 这段文本相对部署 persona 段与随后第一方政策段的次序相同

#### Scenario: 记忆后端不可用时依然在场

- **WHEN** 记忆后端不可执行，会话照常发起请求
- **THEN** 这段文本仍然出现在提示词里，内容不变
