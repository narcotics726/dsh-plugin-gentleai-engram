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

## ADDED Requirements

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
