# AGENTS.md — dsh-plugin-gentleai-engram

## 这是什么

dsh（Cordis）插件：把 engram MCP 后端接入 dsh。**接入层，不是记忆系统。**

## 硬规则（dsh-plugin-dev 标准）

1. **接口以生成参考为准**。事件签名（`agent/session-start`、`assistant/message`、`agent/turn-stopping`、`session/event` 的 `compaction/*`）与 ctx 键以本机 `@deepseek-ai/*` 生成物为准，不要凭记忆或旧代码推断。
2. **所有贡献都是副作用**。注册一律走 ctx（`ctx.on` / `ctx.tools.register` / `ctx.effect`），卸载必须干净；模块作用域不得创建进程级副作用。
3. **waterfall 监听器必须 `await next()`**（除非有意短路）。
4. **失败要响亮**：配置非法在加载时抛错；engram 不可用时对**会话**降级，但日志必须明确。
5. **配置一律 Schemastery**：导出 `interface Config` + 同名 `Schema`，默认值写进 schema。
6. **模型可见即已记录**：任何新增的模型可见输入必须能被会话日志重建；**禁止新增未标记的 session 事件类型**（宿主按判别联合解析事件，未标记的类型会 brick 会话日志）。
7. **运行时依赖按危害分层，不按"零第三方"划线**：
   - **宿主进程内绝不加载原生扩展/addon**（这是这条规则唯一的不变量）。
   - **host 提供的 `@deepseek-ai/*` 优先**：目前用了 `@deepseek-ai/schemastery`（配置校验，硬规则 5 强制）与 `@deepseek-ai/dsh-llm`（`createUserMessage`）；用 host 提供的包意味着版本必须跟 host 走。
   - **纯 JS / WASM 依赖只在子进程内**：允许，但每次引入都要写明理由、精确锁版本、在文档里给出安装体积；并且要有**机制**证明它没被宿主入口加载（宣言不是保证）。
   - **大体积制品（模型、运行时）与代码依赖分开**：走显式安装步骤，缺失时**在加载/调用点响亮失败**，不静默下载。
   - 其余情况（Node 内置模块够用就用内置）是**默认而非戒律**：不要为了守住"零依赖"而放弃比较——本仓库的 MCP 客户端是自实现的，理由是**拓扑**（每个工作区一个长驻 stdio 子进程 + 多路复用），不是这条规则。

## 流程（spec-first，轻量）

- 任何**行为**变更先写 `openspec/changes/<change>/`（proposal → specs → design → tasks），再动代码。
- 命令：`openspec list` / `openspec validate <change> --strict` / `openspec view`。
- 完成后 `openspec archive <change>`，specs 落到 `openspec/specs/`。
- 这套轻量流程就是全部纪律，不额外引入评审 gate 链。
- 命令形状：`openspec new change <name>` 生成骨架（**不要手建** `openspec/changes/` 目录）→ `openspec status --change <name> --json` → `openspec instructions <proposal|specs|design|tasks> --change <name> --json` 按模板落盘。

### 各文件装什么（spec 与 design 分工）

- **spec 写契约与理由，design 写推导与数据。** 把两者混同，spec 会最快腐烂。
- **proposal**：为什么、改什么、**可观察的验收信号**，以及影响面（代码/测试/文档/成本）。不写设计与算法。
- **specs**：不变量与安全策略、外部可观察的名字与判定式、**无需枚举的策略决定**（"刻意不做 X"）。数字只留**契约性常量**（改了就是行为变更的那种）。
- **design**：决定与推导、备选与被否方案及理由、测量值与指纹、已知未知、退回条件。**数值参数的原始出处是 config schema 的默认值**，design 引用而不重述。
- **tasks**：可完成条目，每条写验证方式（命令/测试/可观察产物）。数值只在够用时才写。

### spec 场景的写法（长期 spec 的自检）

- 场景只写**可观察的行为与结果**，用白话，不用模块名、表名、函数名或我们的内部术语。
- 术语留或走的判据：**这个名字不是我们能改的**（宿主 dsh、engram、MCP 线上契约）就留；是我们自己的设计就移到 design。
- 合格线：**换掉存储、数据结构与进程模型后，这条场景仍然成立**。不成立就是 design 内容。
- 腐烂搬去显眼处：frontmatter 的 `status` / `triggers.read_when` / `anchors` 只锚**决定这份 spec 是否还成立**的东西（别把"提到过的"都锚上）；易腐内容（测量值、指纹、版本号、行号、第三方行为描述）不进 spec。
- 示例：不写「`source_hash` 不等时走增量同步」，写「上次检索之后 engram 里的内容变了，**紧接着的**下一次检索就能看到变化，不需要重建整个索引」。

## 命令

```bash
pnpm typecheck && pnpm test && pnpm build
pnpm check:boundary           # 硬规则 7 的机制：宿主入口的 import 闭包不得触及嵌入运行时
pnpm check:hygiene            # 门禁：全历史扫密钥/本机路径/个人邮箱/禁止路径
```

- 读层的模型与裁剪后的运行时**不在仓库里**，走显式安装：`node scripts/install-recall-model.mjs --model-dir <dir> [--model-from <本机缓存>]`（约 110 MB）。**先 `pnpm build`**（脚本从 `dist/` 读仓库里的期望身份声明）。缺失**或内容与声明不符**时检索**在调用点**响亮失败：该次检索失败、宿主不退出、同一会话后续回合照常，恢复文件后**紧接着的下一次检索**即可用（不需要重启）。不静默下载，也不自动重装。安装与 `--check` 都按该声明判定并区分「缺失/不符」；`node scripts/verify-model-expected.mjs` 可独立复核声明本身。
- 同一台机器上的所有 profile 请保持同一插件版本：模型目录与索引目录是共享的，判定依据却是各 profile 自己的声明；声明不同的两个版本会互相判失败、互相触发全量重建（本期不解决，根治方向是按身份分目录）。
- Node 下限见 `package.json` 的 `engines`（`>=24`，实测下限），不做运行期断言。
- 内存判据复测：`node scripts/mem-profile.mjs [--threads 1] [--queries 500]`——量常驻 worker 的 floor / 稳态 / 采样峰值，判据 **1 线程稳态 ≤ 600 MB**（方法与边界见内部笔记）。它量的是**上线 worker**（含引擎、打开的索引与打分器），所以比旧 spike 只量裸嵌入器的读数高。

- 门禁：`.githooks/pre-commit`（暂存区 + 提交身份）与 `.githooks/pre-push`（全历史）由 `pnpm install` 的 `prepare` 自动启用（`core.hooksPath=.githooks`）；推送前 `pnpm check:hygiene` 必须通过。
- 加载验证：`dsh --profile web --dump-config | grep engram-bridge`（恰好一次）→ 启动 `dsh web` 看加载日志。
- 卸载验证：停用后 `--dump-config` 无残留，且会话不报错。

## 禁止

- **不要手改** `~/.dsh/profiles/*/node_modules/`：先改仓库，再用 `dsh plugin --profile <p> add <path>` 重新 link。
- 不要修改 engram 的 DB schema，也不要用 SQL 直接写 `~/.engram/engram.db`。
- 不要把 engram 的失败升级成会话失败（记忆是 bookkeeping，用户可见回复优先）。
