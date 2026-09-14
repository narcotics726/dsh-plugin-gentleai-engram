---
id: engram-context-injection
title: Engram Context Injection
type: technical.contract
status: draft
triggers:
  keywords:
    - project 解析
    - 隐式参数注入
    - projectOverrides
  read_when:
    - 实现或评审 project / directory / session_id 注入
    - 排查记忆写进错误项目
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  files:
    - src/injection.ts
  env:
    - ENGRAM_PROJECT
  config_keys:
    - projectOverrides
    - injectSessionProject
related:
  specs:
    - engram-session-binding
    - engram-bridge-runtime
---
# engram-context-injection Specification

## Purpose
定义项目名与隐式参数的权威来源与注入规则：项目名由 engram 依据会话工作区解析一次后由插件缓存并全程显式注入，调用方显式传参优先，且不破坏 engram 的歧义恢复流程。

## Requirements

### Requirement: 项目解析委托给 engram
插件 SHALL 以会话工作区为输入让 engram 解析项目名，并采用 engram 返回的项目名；插件 SHALL NOT 自行构造项目名。

#### Scenario: 工作区含配置文件
- **WHEN** 会话工作区或其上级存在 `.engram/config.json` 且其中声明了项目名
- **THEN** 插件缓存并注入的项目名等于 engram 依据该工作区解析出的项目名

#### Scenario: 插件不猜测项目名
- **WHEN** 会话已成功解析出项目名
- **THEN** 后续注入使用该名字，而不是工作区目录名或 git 仓库名的插件侧推断

### Requirement: 注入优先级
注入的项目名 SHALL 按以下顺序确定：调用方显式参数 > `projectOverrides[工作区绝对路径]` > 该会话已解析出的项目名 > `ENGRAM_PROJECT` > 不注入。

#### Scenario: 显式参数优先
- **WHEN** 调用方显式传入 `project`
- **THEN** 插件不改写该参数

#### Scenario: 配置覆盖
- **WHEN** `projectOverrides` 中存在当前工作区的映射
- **THEN** 注入该映射值，覆盖会话解析结果

#### Scenario: 会话尚未解析
- **WHEN** 会话解析失败或尚未完成，且没有显式参数与配置覆盖
- **THEN** 插件不注入 `project`，而不是用目录名兜底

### Requirement: mem_save_prompt 的参数例外
`mem_save_prompt` 的 `project` 参数 SHALL NOT 被注入；其 `session_id` SHALL 照常注入。

#### Scenario: 不注入 project
- **WHEN** 模型调用 `mem_save_prompt` 时没有传 `project`
- **THEN** 插件不为该调用注入 `project`

#### Scenario: 仍注入 session_id
- **WHEN** 模型调用 `mem_save_prompt` 时没有传 `session_id`
- **THEN** 插件注入当前会话标识

### Requirement: 不破坏歧义恢复
当 engram 返回项目歧义错误时，插件 SHALL 允许调用方使用返回的候选项目名与恢复令牌重试，且 SHALL NOT 用注入值覆盖调用方的显式选择。

#### Scenario: 歧义恢复重试
- **WHEN** 一次调用返回项目歧义错误，随后调用方带着候选项目名与恢复令牌重试
- **THEN** 插件不改写调用方显式给出的项目名与恢复令牌

### Requirement: 目录注入
`mem_session_start` SHALL 收到会话工作区的绝对路径作为目录参数。

#### Scenario: 建立会话时的目录
- **WHEN** 会话开始并建立 engram 会话
- **THEN** 该调用携带的目录等于会话工作区绝对路径

### Requirement: 注入开关
`injectSessionProject` 为 false 时插件 SHALL NOT 注入 `project` 与目录；`injectSessionId` 为 false 时插件 SHALL NOT 注入 `session_id`。

#### Scenario: 关闭项目注入
- **WHEN** `injectSessionProject` 为 false 且模型未传 `project`
- **THEN** 实际请求不携带 `project`

#### Scenario: 关闭会话标识注入
- **WHEN** `injectSessionId` 为 false 且模型未传 `session_id`
- **THEN** 实际请求不携带 `session_id`

### Requirement: 插件自有工具的注入一致

插件自有工具 SHALL 与 engram 工具遵循同一套注入判定：按该工具自己声明的参数决定注入什么。声明了 `project` 的自有工具 SHALL 接受会话项目注入（与 `injectSessionProject` 的开关一致），调用方显式传值优先；未声明的自有工具 SHALL NOT 收到任何注入。当该开关关闭、因而 `project` 不会被注入时，依赖它做项目隔离的自有工具 SHALL NOT 静默地跨项目返回——它的行为由该工具自己的规格规定。

#### Scenario: 声明了项目的自有工具
- **WHEN** 模型调用一个声明了 `project` 参数的自有工具且没有传该参数，且项目注入未被关闭
- **THEN** 该调用携带当前会话解析出的项目名

#### Scenario: 未声明的自有工具
- **WHEN** 模型调用一个没有声明 `project` 参数的自有工具
- **THEN** 该调用不携带 `project`

#### Scenario: 显式传值优先
- **WHEN** 模型调用自有工具时显式传入了 `project`
- **THEN** 插件不改写该值

#### Scenario: 项目注入被关闭
- **WHEN** 项目注入开关为关闭，且一个依赖项目来限定结果的自有工具被调用
- **THEN** 该调用不携带 `project`，且其行为不违反该工具自己规格中关于项目限定的要求

