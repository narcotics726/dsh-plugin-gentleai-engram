---
id: engram-passive-capture
title: Engram Passive Capture
type: technical.contract
status: draft
triggers:
  keywords:
    - Key Learnings
    - 被动捕获
    - mem_capture_passive
  read_when:
    - 实现或评审回合收尾学习条目落库
    - 排查学习条目未落库
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  events:
    - agent/turn-stopping
  config_keys:
    - capturePassive
related:
  specs:
    - engram-session-binding
    - engram-bridge-runtime
---
# engram-passive-capture Specification

## Purpose
定义任务收尾学习条目的被动捕获契约：在回合收尾把该回合的最终回复交给 engram 提取，每个回合至多一次，跳过被中断的回合，且捕获的任何失败都不改变用户可见的回复。

## Requirements

### Requirement: 捕获挂点与粒度
插件 SHALL 在回合收尾时把该回合的最终助手回复文本提交给 engram 的被动捕获入口；每个回合 SHALL 至多提交一次。

#### Scenario: 一个回合多个步骤
- **WHEN** 一个回合内模型产生多条助手消息，且最终回复含学习段落
- **THEN** 只提交一次，提交的是该回合的最终回复文本

#### Scenario: 一回合内多段学习段落
- **WHEN** 最终回复中出现多段学习段落
- **THEN** 插件仍只提交一次，条目拆分由 engram 完成

#### Scenario: 回合收尾被重复触发
- **WHEN** 同一回合的回合收尾被触发多次（例如收尾处理本身使该回合又产生一步）
- **THEN** 该回合仍只提交一次

### Requirement: 被中止的回合不产生捕获
被中止的回合 SHALL NOT 产生被动捕获。

#### Scenario: 用户中止回合
- **WHEN** 用户在生成过程中中止了当前回合
- **THEN** 不调用被动捕获入口，记忆不新增条目

### Requirement: 捕获归属
被动捕获产生的条目 SHALL 归属当前会话。

#### Scenario: 捕获后的归属
- **WHEN** 一次捕获成功写入条目
- **THEN** 该条目的会话标识等于当前 dsh 会话标识

#### Scenario: 同工作区两个会话并发收尾
- **WHEN** 同一工作区的两个会话各自收尾并各自提交捕获
- **THEN** 两条条目分别归属各自的会话，且都落在该工作区所属项目下

### Requirement: 不改变可见输出
捕获失败、超时或延迟 SHALL NOT 改变用户可见的回复，SHALL NOT 阻断回合收尾。

#### Scenario: 捕获时 engram 不可用
- **WHEN** 提交捕获时 engram 不可用
- **THEN** 用户可见回复完整显示，日志中记录一次捕获失败

### Requirement: 捕获结果可观测
当回合文本包含学习段落而 engram 提取到的条目数为零时，插件 SHALL 记录一条日志。

#### Scenario: 条目被 engram 丢弃
- **WHEN** 回复含学习段落但 engram 返回提取数为零
- **THEN** 日志中出现一条可定位的记录，说明该回合未产生条目

### Requirement: 捕获开关
`capturePassive` 为 false 时插件 SHALL NOT 调用被动捕获入口。

#### Scenario: 关闭捕获
- **WHEN** `capturePassive` 为 false 且回复含学习段落
- **THEN** 不调用捕获入口，记忆不新增条目

### Requirement: 模型侧不得直接提交被动捕获

插件 SHALL NOT 注册被动捕获工具（未注册的名字由宿主以未知工具错误拒绝），因此它 SHALL NOT 出现在任何 agent（主 agent 与子 agent）的模型可见工具清单中；该工具被调用时 SHALL 以未知工具错误失败，SHALL NOT 产生任何记忆写入，SHALL NOT 改变用户可见回复。桥自身的回合收尾捕获 SHALL NOT 受此限制——它不经工具面。

#### Scenario: 主 agent 的工具清单
- **WHEN** 一个主 agent 会话开始
- **THEN** 该 agent 的模型可见工具清单不含被动捕获工具，其余 engram 工具照常可见

#### Scenario: 子 agent 的工具清单
- **WHEN** 一个子 agent 会话开始
- **THEN** 该子 agent 的模型可见工具清单同样不含被动捕获工具

#### Scenario: 显式调用被拒绝
- **WHEN** 模型显式调用被动捕获工具
- **THEN** 该调用以未知工具错误失败，engram 中不新增条目

#### Scenario: 经折叠工具的旁路
- **WHEN** 模型通过折叠工具（如 `mcp_call`）间接调用被动捕获工具
- **THEN** 该调用被拒绝，且不产生任何记忆写入

#### Scenario: 桥自身的捕获不受影响
- **WHEN** 一个回合收尾且该回合最终回复含学习段落
- **THEN** 桥仍提交一次被动捕获，落库条目可归因于自动路径（该工具未注册也不影响）
