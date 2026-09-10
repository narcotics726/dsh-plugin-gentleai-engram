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
    - 排查学习条目未落库或重复落库
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

## ADDED Requirements

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
