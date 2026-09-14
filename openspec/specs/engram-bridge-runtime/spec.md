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
# engram-bridge-runtime Specification

## Purpose
定义 engram 后端与 dsh 之间的运行时契约：按会话工作区建立与回收 engram 子进程、把 engram 工具面暴露给模型、处理超时与取消、校验配置，并在 engram 不可用时对会话降级。

## Requirements

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

插件 SHALL 在连接空闲超过配置时长后关闭它，插件 SHALL 在每次调用结算时刷新该连接的空闲计时（空闲时长自最后一次调用结算起算），SHALL NOT 关闭正在被调用的连接（调用进行中的连接在结算前不受空闲回收影响）；插件并 SHALL 保证同时活跃的连接数不超过配置上限，超出时按最久未用者淘汰——上限淘汰不受「正在被调用」保护，仍按上限执行。

#### Scenario: 空闲超时回收
- **WHEN** 某工作区的连接空闲超过 `poolMaxIdleMs`，且该连接上没有进行中的调用
- **THEN** 该 engram 子进程被关闭，engram 侧已有的会话记录不受影响

#### Scenario: 调用进行中的连接不被回收
- **WHEN** 一个连接上有调用尚未结算，且该连接的空闲时长已超过 `poolMaxIdleMs`
- **THEN** 该连接在调用结算前不被关闭；结算后若再次超过阈值则被关闭

#### Scenario: 调用结算后恢复可回收
- **WHEN** 一次调用以超时或失败结算
- **THEN** 该连接不再被视为在用，空闲计时自结算时刻重新开始，再次超过阈值后才可被回收

#### Scenario: 超过连接上限
- **WHEN** 活跃连接数达到 `poolMaxConnections` 且出现新的工作区
- **THEN** 最久未使用的连接被关闭（即使它正在被调用），活跃连接数不超过上限，新工作区的会话仍可正常使用

#### Scenario: 空闲回收被关闭
- **WHEN** `poolMaxIdleMs` 为 0
- **THEN** 不进行任何空闲回收（连接只在超过上限、插件卸载或进程退出时关闭），连接上限仍然生效

#### Scenario: 上限淘汰时的在途调用
- **WHEN** 上限淘汰选中的连接上还有未结算的调用
- **THEN** 该连接仍被关闭，该次调用以错误结算（不静默挂起），会话继续，日志中出现一条可归因的记录

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

在子 agent 会话中，插件 SHALL 使 engram 工具从该子 agent 的模型可见工具清单中消失；该遮蔽 SHALL 在工具面注册**晚于**子 agent 创建时同样成立（注册完成后 SHALL 对已存在的子 agent 补齐遮蔽）；若某个 engram 工具仍可被调用，插件 SHALL 使其以未知工具错误失败且不产生任何写入。

#### Scenario: 子 agent 工具面
- **WHEN** 主代理创建子代理
- **THEN** 子代理的模型可见工具清单不包含任何 `mcp__engram__*` 工具，且主代理的工具面不受影响

#### Scenario: 注册晚于子 agent 创建
- **WHEN** 子 agent 被创建时插件尚未注册任何 engram 工具，注册在随后完成
- **THEN** 注册完成后该子 agent 的模型可见工具清单仍不含任何 `mcp__engram__*` 工具

#### Scenario: 被隐藏的工具仍被调用
- **WHEN** 子代理设法调用一个已被隐藏的 engram 工具
- **THEN** 该调用以未知工具错误失败，且不产生任何记忆写入

#### Scenario: 经旁路触达
- **WHEN** 子代理通过其他 MCP 折叠工具间接调用 engram 工具
- **THEN** 该调用被拒绝，且不产生任何记忆写入

### Requirement: 宿主会话事件载荷契约

插件订阅的宿主事件分两类：写入会话日志的会话事件（`session/event`，形状 `{type, seq, time, data, …}`）与 agent 平面事件（如 `agent/turn-stopping`，其载荷直接是监听器入参，不受本契约约束）。对会话事件，插件 SHALL 从**载荷字段** `data` 读取所需数据，SHALL NOT 依赖会话事件对象的顶层字段承载载荷；插件 SHALL NOT 新增会话事件类型。当某类被订阅的会话事件不符合本契约时——载荷字段缺失，或插件在该事件读取点上所依赖的字段缺失/类型不符——插件 SHALL 记录一条 **warn 级**日志并继续运行，SHALL NOT 静默丢弃（debug 级不计入"响亮"）；限流范围为**每个会话、每个事件类型至多一条**（新会话重新计数，避免持续失配在会话之间彻底无声）。

#### Scenario: 载荷位于信封的 data 字段
- **WHEN** 宿主投递一个被订阅的会话事件（如 `assistant/message`、`compaction/summary`、`compaction/end`），其形状为 `{type, seq, time, data}`
- **THEN** 插件从 `data` 读取字段，并产生与该事件类型契约一致的行为

#### Scenario: 形状不符时响亮失败
- **WHEN** 收到的会话事件缺少载荷字段（例如载荷被平铺到顶层）
- **THEN** 该会话内记录恰一条 warn 级形状告警，会话继续，且不产生任何 engram 写入；同一会话内重复投递同类失配不再重复记录，而另一个新会话会重新记录

### Requirement: 空闲回收由插件自主驱动

插件 SHALL 按固定间隔自主检查并关闭空闲连接，SHALL NOT 依赖后续工具调用或外部触发来执行回收；该间隔 SHALL 由配置项 `poolSweepIntervalMs` 给定（默认 60000），SHALL 为正数且不小于 1000 毫秒（更小的值在加载期被拒绝）；配置未提供该键时（例如直接构造配置的调用方绕过了 schema）实现 SHALL 按默认值生效，SHALL NOT 把缺失值透传给定时器而退化成忙轮询。当 `poolMaxIdleMs` 为 0（空闲回收被关闭，见下）时本要求不生效。插件卸载后 SHALL 停止该定时回收。

#### Scenario: 无人使用时的空闲回收
- **WHEN** 某工作区的连接空闲超过 `poolMaxIdleMs`，且期间没有任何工具调用发生
- **THEN** 该连接被关闭、对应 engram 子进程消失，engram 侧已有会话记录不受影响

#### Scenario: 卸载后停止回收
- **WHEN** 插件被停用
- **THEN** 不再存在定时回收，也无残留子进程

### Requirement: 工具面在一次加载内固定

一次加载过程中，注册给模型的工具面 SHALL 在第一次注册后固定：其后到达的、不同的工具声明 SHALL NOT 改变已注册的工具面，且该不一致 SHALL 被记录为警告。工具面的构成变化 SHALL 只在插件被重新加载后生效——**不要求也不承诺**宿主进程整体重启。

#### Scenario: 注册后到达的不同工具面
- **WHEN** 工具面已注册，随后一次发现返回了不同的工具声明集合
- **THEN** 已注册的工具面保持不变，且日志中出现警告

#### Scenario: 缓存与首次发现不一致
- **WHEN** 加载时从缓存注册了工具面，之后首次发现返回的工具声明与之不同
- **THEN** 注册面仍为缓存中的那份，且该不一致被记录为警告

