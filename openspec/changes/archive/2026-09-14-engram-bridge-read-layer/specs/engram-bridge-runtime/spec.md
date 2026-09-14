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
---

## MODIFIED Requirements

### Requirement: 工具面注册

插件 SHALL 把 engram 声明的工具以 `mcp__engram__<name>` 注册给模型，工具名、描述与参数 schema SHALL 与 engram 声明一致，调用结果 SHALL 以 dsh 工具结果形状返回。存在一组**刻意不注册**的 engram 工具（按精确名判定）：被动捕获工具（见 `engram-passive-capture` 的「模型侧不得直接提交被动捕获」）、重复提示词写入工具、以及被桥自身检索入口取代的检索工具；这组工具 SHALL NOT 出现在任何 agent 的工具清单里。插件自有工具（如检索入口）SHALL 作为插件自己的工具定义注册，SHALL NOT 冒充 engram 声明；它的名字 SHALL 沿用 `mcp__engram__` 前缀以便与其余工具同组、且便于按前缀施加可见性限制。

#### Scenario: 工具面与 engram 声明一致
- **WHEN** engram 声明 N 个工具，其中 M 个属于刻意不注册的那组
- **THEN** 主 agent 看到 N-M 个来自 engram 声明的工具，且它们每个的参数 schema 与 engram 声明相同

#### Scenario: 结果透传
- **WHEN** 一次工具调用返回结构化内容
- **THEN** dsh 侧得到可渲染的工具结果，内容不被改写

#### Scenario: 被取代的检索工具不在册
- **WHEN** 插件自有的检索入口已注册
- **THEN** engram 声明中的检索工具不出现在主 agent 的工具清单里，且它的名字被调用时以未知工具错误失败

#### Scenario: 自带前缀的插件工具受同样的可见性限制
- **WHEN** 一个子 agent 被创建，且插件的自有工具已注册
- **THEN** 该子 agent 的模型可见工具清单不含插件的自有工具，规则与 engram 工具相同

### Requirement: 工具面缓存与首个请求可见

插件 SHALL 把成功发现的工具面缓存到 `$DSH_HOME/storages/engram-bridge/tools.json`（记录 `command`/`args` 指纹），并在后续加载时**同步**注册缓存中的工具面。缓存文件 SHALL 保留 engram 的原始声明（含刻意不注册的那组工具），注册面 SHALL NOT 包含它们。

#### Scenario: 缓存命中
- **WHEN** 上一次运行成功发现过工具面，本次启动后发出会话的第一个模型请求
- **THEN** 该请求的工具面已包含全部**已注册的** engram 工具（即 engram 声明的工具去掉刻意不注册的那组），数量为 N-M

#### Scenario: 冷启动且无缓存
- **WHEN** 从未成功发现过工具面，且第一个请求早于发现完成
- **THEN** 该请求不含 engram 工具；发现完成后工具面对后续请求可见，并写入缓存

#### Scenario: 指纹不匹配
- **WHEN** 缓存记录的 `command`/`args` 与当前配置不同
- **THEN** 不使用该缓存，改用本次发现的结果

## ADDED Requirements

### Requirement: 工具面在一次加载内固定

一次加载过程中，注册给模型的工具面 SHALL 在第一次注册后固定：其后到达的、不同的工具声明 SHALL NOT 改变已注册的工具面，且该不一致 SHALL 被记录为警告。工具面的构成变化 SHALL 只在插件被重新加载后生效——**不要求也不承诺**宿主进程整体重启。

#### Scenario: 注册后到达的不同工具面
- **WHEN** 工具面已注册，随后一次发现返回了不同的工具声明集合
- **THEN** 已注册的工具面保持不变，且日志中出现警告

#### Scenario: 缓存与首次发现不一致
- **WHEN** 加载时从缓存注册了工具面，之后首次发现返回的工具声明与之不同
- **THEN** 注册面仍为缓存中的那份，且该不一致被记录为警告

