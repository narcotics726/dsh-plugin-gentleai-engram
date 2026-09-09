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

## Purpose

定义 engram 后端与 dsh 之间的运行时契约：按会话工作区建立与回收 engram 子进程、把 engram 工具面暴露给模型、处理超时与取消、校验配置，并在 engram 不可用时对会话降级。

## ADDED Requirements

### Requirement: 按工作区建立连接
插件 SHALL 以会话工作区的绝对路径作为 engram 子进程的工作目录建立连接；同一工作区的多个会话 SHALL 共享同一连接，不同工作区 SHALL 各自独立。

#### Scenario: 同一工作区两个会话
- **WHEN** 两个会话的工作区相同且都已开始
- **THEN** 只存在一个 engram 子进程，两个会话共用它

#### Scenario: 不同工作区两个会话
- **WHEN** 两个会话的工作区不同
- **THEN** 各自存在一个 engram 子进程，其工作目录分别等于各自的工作区

### Requirement: 懒启动与并发去重
工作区连接 SHALL 在会话首次需要时建立，SHALL NOT 在插件加载时为尚未出现的工作区预建；同一工作区的并发首次使用 SHALL 只启动一次。

#### Scenario: 无会话时不建立工作区连接
- **WHEN** dsh 已启动但还没有任何会话
- **THEN** 不存在任何工作区连接（加载期的一次性工具面发现连接已在注册后关闭）

#### Scenario: 并发首次使用同一工作区
- **WHEN** 两个会话同时进入同一个此前未使用的工作区
- **THEN** 只启动一个 engram 子进程，两个会话都能正常使用

### Requirement: 启动失败可重试
当 engram 子进程因瞬时原因启动失败时，插件 SHALL 允许重试；重试成功后该工作区的会话 SHALL 可正常使用。

#### Scenario: 瞬时启动失败后重试成功
- **WHEN** 首次启动因数据库被占用而失败，随后重试成功
- **THEN** 该工作区的会话可正常使用，且日志中记录一次启动失败

### Requirement: 空闲回收与连接上限
插件 SHALL 在连接空闲超过配置时长后关闭它，并 SHALL 保证同时活跃的连接数不超过配置上限，超出时按最久未用者淘汰。

#### Scenario: 空闲超时回收
- **WHEN** 某工作区的连接空闲超过 `poolMaxIdleMs`
- **THEN** 该 engram 子进程被关闭，engram 侧已有的会话记录不受影响

#### Scenario: 超过连接上限
- **WHEN** 活跃连接数达到 `poolMaxConnections` 且出现新的工作区
- **THEN** 最久未使用的连接被关闭，新工作区的会话仍可正常使用

### Requirement: 工具面注册
插件 SHALL 把 engram 声明的工具以 `mcp__engram__<name>` 注册给模型，工具名、描述与参数 schema SHALL 与 engram 声明一致，调用结果 SHALL 以 dsh 工具结果形状返回。

#### Scenario: 工具面与 engram 声明一致
- **WHEN** engram 声明 N 个工具
- **THEN** 模型看到 N 个 `mcp__engram__*` 工具，且每个工具的参数 schema 与 engram 声明相同

#### Scenario: 结果透传
- **WHEN** 一次工具调用返回结构化内容
- **THEN** dsh 侧得到可渲染的工具结果，内容不被改写

### Requirement: 工具面缓存与首个请求可见
插件 SHALL 把成功发现的工具面缓存到 `$DSH_HOME/storages/engram-bridge/tools.json`（记录 `command`/`args` 指纹），并在后续加载时**同步**注册缓存中的工具面。

#### Scenario: 缓存命中
- **WHEN** 上一次运行成功发现过工具面，本次启动后发出会话的第一个模型请求
- **THEN** 该请求的工具面已包含全部 engram 工具

#### Scenario: 冷启动且无缓存
- **WHEN** 从未成功发现过工具面，且第一个请求早于发现完成
- **THEN** 该请求不含 engram 工具；发现完成后工具面对后续请求可见，并写入缓存

#### Scenario: 指纹不匹配
- **WHEN** 缓存记录的 `command`/`args` 与当前配置不同
- **THEN** 不使用该缓存，改用本次发现的结果

### Requirement: 调用超时与取消
单次工具调用超过 `toolCallTimeoutMs` SHALL 失败；调用被取消时插件 SHALL 结束该调用，且 SHALL NOT 使会话失败。

#### Scenario: 调用超时
- **WHEN** 一次 engram 工具调用超过 `toolCallTimeoutMs`
- **THEN** 该调用返回超时错误，会话继续

#### Scenario: 调用被取消
- **WHEN** 调用方取消了正在进行的 engram 调用
- **THEN** 该调用结束并返回取消错误，不留下未结算的等待

### Requirement: 配置契约与加载期校验
插件 SHALL 导出带默认值的配置 schema；非法配置 SHALL 在插件加载时失败并给出明确错误。

#### Scenario: 缺少必填配置
- **WHEN** 配置缺少 `command`
- **THEN** 插件加载失败，错误信息指明缺失的配置项

#### Scenario: 默认值生效
- **WHEN** 配置只提供 `command`
- **THEN** `args` 默认为空数组、`toolCallTimeoutMs` 默认为 60000、连接上限与空闲回收使用 schema 默认值

### Requirement: 卸载回收
插件卸载时 SHALL 关闭全部 engram 子进程并注销全部工具注册。

#### Scenario: 卸载后无残留
- **WHEN** 插件被停用
- **THEN** 不存在残留的 engram 子进程，且模型侧不再有 `mcp__engram__*` 工具

### Requirement: engram 不可用时降级
当 engram 可执行文件缺失、握手失败或工具列表获取失败时，插件 SHALL NOT 使会话失败，SHALL 记录一条明确日志，并 SHALL 让相关能力不可用。

#### Scenario: 可执行文件缺失
- **WHEN** 配置的 `command` 指向不存在的文件
- **THEN** 会话仍可正常对话，日志中出现一条明确的连接失败记录，模型看不到 engram 工具

#### Scenario: 握手失败
- **WHEN** engram 进程启动但握手失败
- **THEN** 同上：会话不受影响，日志记录失败，相关能力不可用

### Requirement: 子 agent 遮蔽
在子 agent 会话中，插件 SHALL 使 engram 工具从该子 agent 的模型可见工具清单中消失；若某个 engram 工具仍可被调用，插件 SHALL 使其以未知工具错误失败且不产生任何写入。

#### Scenario: 子 agent 工具面
- **WHEN** 主代理创建子代理
- **THEN** 子代理的模型可见工具清单不包含任何 `mcp__engram__*` 工具，且主代理的工具面不受影响

#### Scenario: 被隐藏的工具仍被调用
- **WHEN** 子代理设法调用一个已被隐藏的 engram 工具
- **THEN** 该调用以未知工具错误失败，且不产生任何记忆写入

#### Scenario: 经旁路触达
- **WHEN** 子代理通过其他 MCP 折叠工具间接调用 engram 工具
- **THEN** 该调用被拒绝，且不产生任何记忆写入
