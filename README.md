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
pnpm install          # 安装 schemastery / dsh-llm / onnxruntime-web 等依赖
pnpm build            # 生成 dist/（.gitignore 忽略，未入库）
dsh plugin --profile <profile> add "$PWD"
```

包自带 `dsh.bundle.patch`，安装后自动成为该 profile 的一层；卸载用 `dsh plugin --profile <profile> remove dsh-plugin-gentleai-engram`。
若 profile 侧 `pnpm` 报错（workspace 根检查或版本不兼容），可手工完成等效安装：把 `"dsh-plugin-gentleai-engram": "link:<repo>"` 写进该 profile 的 `package.json`，并把包名加入其中 `dsh.profile.bundles`。

### 检索层还需要一步显式安装（约 110 MB）

检索要走本地嵌入模型，模型与**裁剪后的运行时**都**不在仓库里**（第三方制品，且体积远大于代码）：

```bash
# 从本机的 HuggingFace/fastembed 缓存复制（推荐，离线可用）
node scripts/install-recall-model.mjs --model-dir ~/.dsh/storages/engram-bridge/model \
     --model-from ~/.cache/huggingface

# 或省略 --model-from，从 Qdrant/bge-small-zh-v1.5 的固定 revision 下载
node scripts/install-recall-model.mjs --model-dir ~/.dsh/storages/engram-bridge/model

# 检查是否完整
node scripts/install-recall-model.mjs --model-dir ~/.dsh/storages/engram-bridge/model --check
```

装完是 **109.8 MB**：模型 94.8 MB + 分词器 0.4 MB + 运行时 **14.59 MB**（`onnxruntime-web` 标准安装是 142 MB / 509 文件，这里只保留 CPU-WASM 在 Node 上真正打开的那几个文件；三个其它 `.wasm` 变体与全部 `.map`/`lib` 被裁掉）。
安装步骤会把裁剪后的运行时落到 `<模型目录>/node_modules/`，因此检索用的是**这一份**，而不是 `node_modules/` 里的完整安装。

**不会静默下载**：运行时或模型缺失时，检索在**调用点**抛明确错误（含本脚本的命令与体积），会话继续可用；插件不会在后台拉 95 MB 模型，也不会退化成另一种检索。

## 迁移：`mem_search` → `mem_bridge_recall`

engram 自带的 `mem_search` **不再注册**（FTS5 的中文分词按标点切整段、默认 AND，实测 R@10 = 0.0000 / 0.0520），取代它的是 `mcp__engram__mem_bridge_recall`：同一套 `mcp__engram__` 前缀、只读派生索引、默认项目隔离、截断可见。直接调用 `mem_search` 会以**未知工具**错误失败——这是刻意的，避免留一条坏的检索路径。

**用户侧文件不随插件分发**，插件只能保证旧名响亮失败。要让模型改叫新名字，请自行修改两处（内容不同，不能套用同一份 diff）：

- `~/.dsh/AGENTS.md` 的记忆协议段里提到 `mem_search` 的地方；
- `~/.dsh/skills/engram-memory/SKILL.md`：把 `mem_search` 换成 `mem_bridge_recall`，并把"FTS5 全文检索"改为事实表述（它是 bigram 词法覆盖 + 语义向量的混合检索），同时补一句"省略范围时两种范围都可以出现"。

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
| `searchEnabled` | `true` | 检索引擎开关。在**调用点**判定：关闭后调用被以明确原因拒绝，不静默换回别的检索 |
| `searchDbPath` | `~/.engram/engram.db` | engram 正本数据库（读层只读它） |
| `searchIndexDir` | `$DSH_HOME/storages/engram-bridge/index` | 派生索引目录；可删除，下次检索重建 |
| `searchModelDir` | `$DSH_HOME/storages/engram-bridge/model` | 模型与裁剪后运行时目录（见上面的显式安装） |
| `embedThreads` | `1` | `ort.env.wasm.numThreads`。常驻内存几乎完全由它决定（1 线程实测 512 MB） |
| `searchIdleMs` | `600000` | 检索子进程空闲多久被回收；`0` = 不回收 |
| `searchSweepIntervalMs` | `60000` | 空闲回收的检查间隔，下限 `1000` |
| `searchTimeoutMs` | `60000` | 单次检索超时；超时会终止检索子进程 |
| `searchW` | `0.20` | 覆盖率提升权重（P2 调参、P3 留出确认，勿随手改） |
| `searchTopK` | `50` | 覆盖率提升所及的排序深度；不是候选集上限 |
| `searchCoverage` | `field_cov` | 覆盖率变体：`field_cov` / `cov_n` / `idf_cov` |

返回条数上限 `limit` **不是**配置项：它是 `mem_bridge_recall` 的输入参数，默认值只写在工具的输入 schema 里（10）。
建索引侧的四个打分常量（`k1` / `b` / `title_weight` / `evidence_weight`）也不在配置里——它们决定排序，随索引版本走，由索引自己的 `meta` 单方面作准。

项目名解析顺序：**显式参数 > `projectOverrides` > 该会话由 engram 解析出的项目名 > `ENGRAM_PROJECT` > 不注入**。插件不用目录名兜底。

## 模型看到什么

- **工具**：engram 的工具以 `mcp__engram__*` 出现在模型工具面；对子 agent 不可见（含 `mcp_call` 之类旁路）。
- **检索**：`mcp__engram__mem_bridge_recall` 是插件自有的只读检索入口（不是 engram 声明的工具）：本地派生索引、默认只返回当前项目的记忆、要求跨项目须显式 `all_projects`、结果被截断时会说明还有未显示的条目、类型取值不做枚举（传了不存在的取值会换来实际取值）。它不写记忆、不改正本、删掉索引即可恢复原状。
- **隐式参数**：声明 `project` / `session_id` 的工具由插件补齐当前会话的项目与会话 id，显式传参优先；`mem_session_start` 的 `id` 由插件持有，模型改不了。检索工具同样按自己声明的参数接受注入；**项目注入被关闭且未显式传 `project` 时，检索被拒绝**（附两条出路），不会以未限定项目运行。
- **压缩**：`compaction/summary` 自动落库，模型无需自己再存摘要；`compaction/end` 后注入一段有界召回。手动 `/compact` 会立即开启一轮独立的自恢复回合。
- **提示词**：不新增 system prompt 段；召回是一条 user 消息，会话日志可完整重建。
- **engram 不可用时**：相关能力失效并记日志，不阻断模型轮次。

## 已知代价

- **每次手动 `/compact` 多一个 LLM 回合**（自恢复回合同样以 `agent/turn-stopping` 收尾，会多一次被动捕获）。`recallWakeup: false` 可拒绝该成本，代价是召回要等用户下一条消息，且可能被取消或会话销毁丢弃。
- **自恢复回合进行期间无法再次压缩**：压缩需要宿主 idle，这一轮跑完前 `/compact` 会被拒绝。

## 深入阅读

| 文档 | 内容 |
| --- | --- |
| `openspec/specs/` | 行为规格：连接池与降级、会话绑定、参数注入、被动捕获、压缩恢复、记忆连续性 |
| `openspec/changes/engram-bridge-read-layer/` | 读层这次变更的 proposal / design / specs / tasks（归档后才落到 `openspec/specs/`）。`design.md` 记录了词法+向量打分的取舍与实测指纹，`specs/engram-bridge-recall/` 是检索入口的行为契约 |
| `docs/event-findings.md` | dsh 宿主事件探针报告——本插件接口契约的依据 |
| `docs/engram-upgrade-checklist.md` | 升级 engram / dsh 后的回归清单（含 engram 自身的语义坑） |
| `AGENTS.md` | 开发约束与命令 |
| `scripts/check-recall-boundary.mjs` | 硬规则 7 的边界机制：断言宿主入口的静态 import 闭包不包含嵌入运行时 |
