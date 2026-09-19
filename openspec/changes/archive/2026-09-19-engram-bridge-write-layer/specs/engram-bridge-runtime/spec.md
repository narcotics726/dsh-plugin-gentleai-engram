---
id: engram-bridge-runtime
title: Engram Bridge Runtime
type: technical.contract
status: draft
triggers:
  keywords:
    - engram 子进程
    - 连接池
    - 工具面
    - 降级
  read_when:
    - 实现或评审 engram 桥的进程与连接生命周期
    - 排查 engram 不可用时的会话行为
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  files:
    - src/index.ts
    - src/mcp-client.ts
    - src/tools.ts
  config_keys:
    - command
    - args
    - env
    - toolCallTimeoutMs
    - poolMaxIdleMs
    - poolMaxConnections
related:
  specs:
    - engram-memory-continuity
    - engram-session-binding
    - engram-bridge-save
---

## MODIFIED Requirements

### Requirement: 工具面注册

插件 SHALL 把 engram 声明的工具以 `mcp__engram__<name>` 注册给模型，工具名、描述与参数 schema SHALL 与 engram 声明一致，调用结果 SHALL 以 dsh 工具结果形状返回。存在一组**刻意不注册**的 engram 工具（按精确名判定）：被动捕获工具（见 `engram-passive-capture` 的「模型侧不得直接提交被动捕获」）、重复提示词写入工具、被桥自身检索入口取代的检索工具、以及被桥自身保存入口取代的写入工具；这组工具 SHALL NOT 出现在任何 agent 的工具清单里。插件自有工具（如检索入口与保存入口）SHALL 作为插件自己的工具定义注册，SHALL NOT 冒充 engram 声明；它的名字 SHALL 沿用 `mcp__engram__` 前缀以便与其余工具同组、且便于按前缀施加可见性限制。桥并 SHALL 在转发前拒绝一类会被后端写成**自反关系**的请求——两个标识取自同一条记忆的关系写入——以明确错误结算，SHALL NOT 让它落到后端。

#### Scenario: 工具面与 engram 声明一致
- **WHEN** engram 声明 N 个工具，其中 M 个属于刻意不注册的那组
- **THEN** 主 agent 看到 N-M 个来自 engram 声明的工具，且它们每个的参数 schema 与 engram 声明相同

#### Scenario: 结果透传
- **WHEN** 一次工具调用返回结构化内容
- **THEN** dsh 侧得到可渲染的工具结果，内容不被改写

#### Scenario: 被取代的检索工具不在册
- **WHEN** 插件自有的检索入口已注册
- **THEN** engram 声明中的检索工具不出现在主 agent 的工具清单里，且它的名字被调用时以未知工具错误失败

#### Scenario: 被取代的写入工具不在册
- **WHEN** 插件自有的保存入口已注册
- **THEN** engram 声明中的写入工具不出现在主 agent 的工具清单里，且它的名字被调用时以未知工具错误失败

#### Scenario: 自反关系被挡在门外
- **WHEN** 一次关系写入请求的两个标识取自同一条记忆
- **THEN** 该请求以明确错误结算，后端的关系记录里不出现自反行

#### Scenario: 自带前缀的插件工具受同样的可见性限制
- **WHEN** 一个子 agent 被创建，且插件的自有工具已注册
- **THEN** 该子 agent 的模型可见工具清单不含插件的自有工具，规则与 engram 工具相同
