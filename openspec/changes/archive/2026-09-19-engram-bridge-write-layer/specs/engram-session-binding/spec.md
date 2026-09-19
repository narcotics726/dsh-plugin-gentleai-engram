---
id: engram-session-binding
title: Engram Session Binding
type: technical.contract
status: draft
triggers:
  keywords:
    - session 绑定
    - session_id 注入
    - 会话隔离
  read_when:
    - 实现或评审 dsh 会话与 engram 会话的绑定
    - 排查记忆串档
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  events:
    - agent/session-start
    - agent/disposed
  database_tables:
    - sessions
  config_keys:
    - injectSessionId
related:
  specs:
    - engram-bridge-runtime
    - engram-context-injection
    - engram-bridge-save
---

## MODIFIED Requirements

### Requirement: 会话标识注入

对声明 `session_id` 参数的 engram 工具，插件 SHALL 注入当前 dsh 会话标识；调用方显式传入的值 SHALL 优先且不被改写。

桥自有的保存入口 SHALL 声明 `session_id` 参数，因此与 engram 工具走**同一套**注入：调用方显式传值优先，否则注入当前 dsh 会话标识。它 SHALL NOT 另立第二条取值规则。注入被关闭、调用方又没有显式传值时，该次保存 SHALL 由它自己的规格以明确原因拒绝——不是"自带一个值继续写"，也不是让后端丢出一个含糊的错误。

#### Scenario: 保存入口按同一套注入取得会话标识

- **WHEN** 会话标识注入开着，调用方发起一次保存且没有传 `session_id`
- **THEN** 写入请求携带当前 dsh 会话标识，保存成功并归属该会话

#### Scenario: 注入关闭且没有显式传值

- **WHEN** 会话标识注入被关闭，且调用方没有传 `session_id`
- **THEN** 该次保存以明确原因被拒绝（结果里说明缺哪个值、有哪两条出路），正本里不新增任何记忆

#### Scenario: engram 工具的会话标识注入

- **WHEN** 模型调用一个声明了 `session_id` 参数的 engram 工具而没有传该参数，且会话标识注入未被关闭
- **THEN** 实际请求携带当前 dsh 会话标识

#### Scenario: 显式传值优先

- **WHEN** 模型调用时显式传了 `session_id`
- **THEN** 插件不改写该值

#### Scenario: 项目取值链给不出非空项目名

- **WHEN** 该会话的项目取值链每一环都是空，或只给出空的项目名
- **THEN** 保存以明确原因失败，而不是写出一行没有项目归属的记忆
