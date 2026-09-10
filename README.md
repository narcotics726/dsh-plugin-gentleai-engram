# dsh-plugin-gentleai-engram

把 [engram](https://github.com/Gentleman-Programming/engram)（本地 SQLite 持久记忆，MCP 后端）接入 **dsh**：按会话工作区连接 engram、绑定会话、注入项目与会话参数，并在回合收尾与压缩时写回记忆。

> 非官方第三方插件（unofficial）。基线：engram `1.20.0`、dsh `0.1.2-rc.1`。

## 前置条件

- `dsh`（含 `dsh plugin`）与 `pnpm`
- engram 可执行文件，`engram mcp` 能作为 stdio MCP 服务启动

## 安装

`dist/` 未入库，而 `dsh plugin add` 对本仓库生成的是 `link:` 依赖（pnpm 不会为它执行构建），所以**必须先构建再安装**：

```bash
git clone <repo-url> && cd dsh-plugin-gentleai-engram
pnpm install          # 安装 schemastery / dsh-llm 等依赖
pnpm build            # 生成 dist/（.gitignore 忽略，未入库）
dsh plugin --profile <profile> add "$PWD"
```

包自带 `dsh.bundle.patch`，安装后自动成为该 profile 的一层；卸载用 `dsh plugin --profile <profile> remove dsh-plugin-gentleai-engram`。
若 profile 侧 `pnpm` 报错（workspace 根检查或版本不兼容），可手工完成等效安装：把 `"dsh-plugin-gentleai-engram": "link:<repo>"` 写进该 profile 的 `package.json`，并把包名加入其中 `dsh.profile.bundles`。

## 配置

自带的 patch 只负责插入 `engram-bridge` 这一行，**不要再手写同名 `insert`**。按机器覆盖配置时，在 home 层（`~/.dsh/cordis.patch.yml`）或对应 profile 的 patch 里按 `id` 覆盖：

```yaml
- id: engram-bridge
  config:
    command: /path/to/engram
```

| key | 默认 | 说明 |
| --- | --- | --- |
| `command` | 必填 | engram 可执行文件路径 |
| `args` | `["mcp"]` | 传给 engram 的参数 |
| `env` | `{}` | 叠加到最小继承环境之上的额外变量 |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 调用超时 |
| `poolMaxConnections` | `8` | 同时活跃的 engram 子进程上限（每个工作区一个） |
| `poolMaxIdleMs` | `600000` | 空闲多久回收该工作区的连接；`0` = 不回收 |
| `poolSweepIntervalMs` | `60000` | 空闲回收的检查间隔，下限 `1000` |
| `projectOverrides` | `{}` | 工作区绝对路径 → engram 项目名 |
| `injectSessionProject` | `true` | 注入 `project` / `directory` |
| `injectSessionId` | `true` | 注入 `session_id` |
| `capturePassive` | `true` | 把回合收尾的 `## Key Learnings:` 写入 engram |
| `compactionRecovery` | `true` | 压缩时持久化摘要，压缩后注入记忆召回 |
| `recoveryTokenBudget` | `800` | 压缩后召回注入的 token 预算 |
| `recallWakeup` | `true` | 手动压缩后是否唤醒一轮独立的自恢复回合；`false` = 只投递不唤醒（已知退化，见下） |

项目名解析顺序：**显式参数 > `projectOverrides` > 该会话由 engram 解析出的项目名 > `ENGRAM_PROJECT` > 不注入**。插件不用目录名兜底。

## 模型看到什么

- **工具**：engram 的工具以 `mcp__engram__*` 出现在模型工具面；对子 agent 不可见（含 `mcp_call` 之类旁路）。
- **隐式参数**：声明 `project` / `session_id` 的工具由插件补齐当前会话的项目与会话 id，显式传参优先；`mem_session_start` 的 `id` 由插件持有，模型改不了。
- **压缩**：`compaction/summary` 自动落库，模型无需自己再存摘要；`compaction/end` 后注入一段有界召回。手动 `/compact` 会立即开启一轮独立的自恢复回合。
- **提示词**：不新增 system prompt 段；召回是一条 user 消息，会话日志可完整重建。
- **engram 不可用时**：相关能力失效并记日志，不阻断模型轮次。

## 已知代价

- **每次手动 `/compact` 多一个 LLM 回合**（自恢复回合同样以 `agent/turn-stopping` 收尾，会多一次被动捕获）。`recallWakeup: false` 可拒绝该成本，代价是召回要等用户下一条消息，且可能被取消或会话销毁丢弃。
- **自恢复回合进行期间无法再次压缩**：压缩需要宿主 idle，这一轮跑完前 `/compact` 会被拒绝。

## 深入阅读

| 文档 | 内容 |
| --- | --- |
| `openspec/specs/` | 6 篇行为规格：连接池与降级、会话绑定、参数注入、被动捕获、压缩恢复、记忆连续性 |
| `docs/event-findings.md` | dsh 宿主事件探针报告——本插件接口契约的依据 |
| `docs/engram-upgrade-checklist.md` | 升级 engram / dsh 后的回归清单（含 engram 自身的语义坑） |
| `AGENTS.md` | 开发约束与命令 |
