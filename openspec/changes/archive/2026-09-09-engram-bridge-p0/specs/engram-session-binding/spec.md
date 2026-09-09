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
---

## Purpose

定义 dsh 会话与 engram 会话之间的身份契约：在会话开始时建立唯一对应的 engram 会话，把 dsh 会话标识注入到声明该参数的工具，并保证会话之间互不串档。

## ADDED Requirements

### Requirement: 会话建立
在 dsh 会话开始时，插件 SHALL 以该 dsh 会话标识作为 engram 会话 id、以会话工作区作为目录建立 engram 会话；绑定 SHALL 在任何 engram 工具调用之前完成。

#### Scenario: 新会话建立
- **WHEN** 一个新的 dsh 会话开始
- **THEN** engram 的 `sessions` 表中出现该 id 的记录，其 directory 等于会话工作区的绝对路径

#### Scenario: 首个工具调用前的屏障
- **WHEN** 会话开始后模型立即调用一个 engram 工具
- **THEN** 该调用不会因为"会话不存在"而失败

### Requirement: 会话建立幂等
同一 dsh 会话标识的会话开始被重复触发时，插件 SHALL NOT 产生第二个 engram 会话。

#### Scenario: 同一标识的会话开始被重复触发
- **WHEN** 同一 dsh 会话标识的会话开始被触发两次
- **THEN** engram 中该标识仍只有一条会话记录，且第二次不改变其 directory

### Requirement: 会话隔离
同一次 dsh 会话内的保存 SHALL 归属该会话的 engram 会话；不同 dsh 会话 SHALL NOT 共用同一个 engram 会话。

#### Scenario: 两个会话不串档
- **WHEN** 两个 dsh 会话各保存一条记忆
- **THEN** 两条记忆归属两个不同的 engram 会话，且各自会话的 directory 等于各自工作区

### Requirement: 会话标识注入
对声明 `session_id` 参数的 engram 工具，插件 SHALL 注入当前 dsh 会话标识；调用方显式传入的值 SHALL 优先且不被改写。

#### Scenario: 未显式传值
- **WHEN** 模型调用 `mem_save` 时没有传 `session_id`
- **THEN** 实际请求携带当前 dsh 会话标识

#### Scenario: 显式传值优先
- **WHEN** 模型调用时显式传了 `session_id`
- **THEN** 插件不改写该值

### Requirement: 绑定先于写入
在绑定完成之前，插件 SHALL NOT 发出缺少会话标识的保存类调用。

#### Scenario: 冷启动后的第一次保存
- **WHEN** dsh 刚启动，第一个会话第一次保存记忆
- **THEN** 保存成功，不出现"会话不存在"的错误

### Requirement: 子 agent 不建立会话
子 agent 会话 SHALL NOT 建立 engram 会话。

#### Scenario: 子代理开始
- **WHEN** 一个子 agent 会话开始
- **THEN** engram 中不新增由该子代理会话 id 标识的会话记录
