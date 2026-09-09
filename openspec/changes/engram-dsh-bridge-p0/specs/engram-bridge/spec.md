## Purpose

定义 engram 后端与 dsh 会话之间的绑定契约：让每次 dsh 会话在 engram 里有独立、可追溯的 session，让任务收尾的学习条目真正落库，并保证 engram 不可用时不损害 dsh 会话。

## ADDED Requirements

### Requirement: 会话生命周期绑定

插件 SHALL 在 dsh 会话开始时为该会话在 engram 中建立对应 session，并把该 dsh 会话标识作为 `session_id` 提供给所有声明该参数的 engram 工具调用；同一 dsh 会话内的多次保存 SHALL 归属同一 engram session，不同会话 SHALL NOT 互相串档。

#### Scenario: 新会话首次保存

- **WHEN** 在一个新的 dsh 会话中第一次调用 `mem_save`
- **THEN** engram 中该 observation 的 `session_id` 等于该 dsh 会话标识，且 `sessions` 表中存在该 id 的记录

#### Scenario: 会话间不串档

- **WHEN** 连续两个不同的 dsh 会话各自保存一条 observation
- **THEN** 两条 observation 归属两个不同的 engram session，且各自 session 的 `directory` 等于各自会话的工作区

### Requirement: 项目注入

插件 SHALL 为声明 `project` 参数的 engram 工具注入当前会话工作区解析出的项目名，解析优先级为：调用方显式参数 > `projectOverrides[工作区绝对路径]` > `ENGRAM_PROJECT` > 就近 `.engram/config.json` 的 `project_name` > 工作区目录名。

#### Scenario: 显式参数优先

- **WHEN** 调用方显式传入 `project`
- **THEN** 插件不改写该参数

#### Scenario: vault 工作区命中配置

- **WHEN** 会话工作区为 `<home>/Documents/Obsidian Vault`
- **THEN** 注入的 `project` 为 `obsidian-vault`

### Requirement: 任务学习被动捕获

当助手回复中出现符合约定的 `## Key Learnings:` 段落时，插件 SHALL 将该段落送交 engram 的被动捕获入口；同一回复 SHALL 最多触发一次捕获，且捕获失败 SHALL NOT 改变用户可见的回复内容。

#### Scenario: 捕获成功

- **WHEN** 助手回复包含带编号条目的 `## Key Learnings:` 段落
- **THEN** engram 中新增由被动捕获产生的 observation，且其 `session_id` 为该 dsh 会话

#### Scenario: 无学习段落

- **WHEN** 助手回复不含该段落
- **THEN** 插件不调用被动捕获入口，且 engram 不新增 observation

### Requirement: 单一源交付

插件 SHALL 以 dsh bundle 包形式安装：仓库是唯一源码，profile 侧只保留 `link:` 依赖与配置覆盖；多个 profile 之间的插件行为 SHALL 由同一份构建产物决定。

#### Scenario: 改一处多 profile 生效

- **WHEN** 修改仓库源码并重新构建后重启 dsh
- **THEN** `web` / `headless` / `open-design` 三个 profile 加载的是同一份构建产物

#### Scenario: 卸载无残留

- **WHEN** 停用并移除该插件
- **THEN** `dsh --profile web --dump-config` 中不再出现 `engram-bridge`，且会话启动无错误

### Requirement: 失败降级

当 engram 可执行文件缺失、MCP 握手失败或调用超时时，插件 SHALL 记录明确错误并使对应能力失效，同时 SHALL NOT 阻断 dsh 会话的模型轮次。

#### Scenario: engram 不可用

- **WHEN** 配置的 `command` 指向的可执行文件不存在
- **THEN** 会话仍可正常对话，日志中出现一次明确的连接失败记录

#### Scenario: 单次调用超时

- **WHEN** 一次 MCP 工具调用超过 `toolCallTimeoutMs`
- **THEN** 该调用返回超时错误，会话继续
