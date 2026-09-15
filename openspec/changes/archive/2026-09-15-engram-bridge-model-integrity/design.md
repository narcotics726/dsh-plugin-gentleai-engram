# 设计：让「检索跑的是哪一套权重与运行时」成为可断言的性质

## D0 要断言的性质：判据来自仓库内的声明，不是安装记录

第一版把期望值取自 `MANIFEST.json`（安装过程刚写下的字节的现算结果），断言因此退化成同义反复。**本版把期望身份声明在仓库内**，与安装过程无关；`MANIFEST.json` 降级为「实际装了什么」的审计记录，**不参与判定**（实测：全仓只有安装脚本写它，`src/` 与 `test/` 都不读）。

**能说什么、不能说什么**（第一版措辞过宽）：仓库内的声明使**判据**不再随某台机器的安装产物变化；**判定结论当然因机器而异**——那正是判定的意义。

## D1 判定的时机、落点、成本与**打不住的窗口**

### 落点：必须在 `start()` 的异步体**之前**

`process.ts:110` 的形状是 `const starting = (async () => {…})(); this.starting = starting.finally(…)`。若把判定放进那个异步体，它抛出的 rejection 会先落到 `this.starting` 上，而**没有任何调用者处理这个派生 promise** → `unhandledRejection`；而 dsh 的 `installFailLoud` 常驻 `unhandledRejection → exit(1)`。**那会把"一个 110 MB 制品没装好"升级成"整个 dsh 死掉"——正是 D4 要避免的结果。** 所以判定放在 `start()` 的**既有 `closed` / `child !== undefined` / `starting !== undefined` 三处守卫之后、`const starting = (async () => {…})()` 之前**（等价地：`query()`/`rebuild()` 里 spawn 之前），失败沿正常调用路径抛出。**落点必须钉到这三位之间**——若放到守卫之前，就退化成"每次 `query()` 都哈希 109 MB"，直接违背 D1 的成本表与 spec 的"判定 SHALL NOT 使每次检索都读取全部内容"。

回归断言（任务 2.4）：判定失败后**不得出现无人处理的 rejection**（宿主不退出）。

### 频率与成本

| 位置 | 频率 | 后果 |
|---|---|---|
| 宿主每次 `query()` 前（既有存在性检查） | 每次检索 | 109 MB 比对（实测约 48–52 ms）会让热调用从 17–27 ms 退化到约 **65–79 ms** |
| **每次启动检索子进程之前（本设计）** | 每次子进程启动 | 只在冷路径付费，热调用零影响 |
| 插件加载期 | 每次宿主启动 | 见 D4：会让整个 dsh 起不来 |

两处 spawn 点已核定为**恰好两处**：`process.ts:111`（常驻 worker）与 `process.ts:259`（`--rebuild`）；`mcp-client.ts:114` 不加载模型。

**成本记在宿主侧**：比对在宿主进程内同步执行，以约 51 ms 阻塞事件循环，**不是**落在子进程的模型加载里（归档唯一在册的加载读数是 ≈1 s；独立评审实测页缓存热时 `Embedder.loadMs` 只有 45–141 ms。前稿写的"2 s"无出处，已撤）。

### 性质的精确定义：**校验时刻**语义

> 在每次启动检索子进程之前，对将要使用的那套内容做一次判定。

**不是**"此后加载的字节必然经过校验"。实测反例（本机 `/tmp` 用模型副本）：判定通过后把 `tokenizer_config.json` 换成 22 B 的**合法**内容，`Embedder.create` 成功、`maxLength=8`、推理照跑、零错误、退出 0。

**窗口比 20–160 ms 更宽，且不结构性有界**（第一版写窄了）：worker 在**首次 query** 时才加载模型，而在建模之前还要先跑 `engine.ts:94` 的 `readSourceState`（读全库并哈希）——**窗口随语料增长**。因此本设计不声称任何有界窗口，只声明"判定发生在使用之前"这一时序事实。

### 热 worker 的文件改动检测不到**不是缺陷**

worker 在首次 query 时把所需字节读进内存；此后改动盘上文件检测不到。**实测反证**：`Embedder.create` 之后删除或写坏 glue `.mjs`/`.wasm`、甚至把整个 `onnxruntime-common` 改名，`run` 仍成功（dims 1/4/512，threads 1/4）。既然内存中那套正是判定通过的那套，检索确实跑在期望的向量空间里。spec 用**正面时序义务**表达这一点（"判定 SHALL 发生在该次检索实际读取之前"）；本条说明它为何仍留下一个窗口（判定与实际读取之间）。

### 自愈

判定失败时**不起子进程、不缓存子进程**。因此原因消除后，紧接着的下一次调用会重新判定并通过。

## D2 期望身份的来源与复核证据

### 运行时（4 文件 + 1 目录）

锚是**精确锁版本的依赖** `onnxruntime-web@1.29.0`。复核：从 `node_modules/.pnpm/onnxruntime-web@1.29.0/…` **独立重算**，4 个受检文件 4/4 一致；`onnxruntime-common` 子树从同一源重算，**193/193 逐文件相同**（该源整包有 509 个文件，已安装只有 4 个——裁剪是设计，所以"源与已安装逐文件相同"这句话**只对受检项与 common 子树成立**，不能笼统地说）。离线可复现。

### 模型（3 文件）

锚是 `Qdrant/bge-small-zh-v1.5` @ `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`。

**（1）从来源重取——已完成。** 经代理 `<proxy>`（本机**直连 HF 不通**：`curl` 超时、Node `fetch` 报 `UND_ERR_CONNECT_TIMEOUT`），从上述 revision 重新取来三个文件，与已安装目录**逐字节相同**：

| 文件 | 字节 | sha256 |
|---|---|---|
| `model_optimized.onnx` | 94,781,076 | `1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38` |
| `tokenizer.json` | 439,125 | `48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26` |
| `tokenizer_config.json` | 367 | `e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a` |

取法：`curl -x <proxy> -L https://huggingface.co/Qdrant/bge-small-zh-v1.5/resolve/46fbe35f…/<file>`（HF 会 307 跳到 `/api/resolve-cache/…`，`-L` 必须带）。

**（2）本地缓存布局的独立佐证（离线，无需网络）。** fastembed 缓存位于仓库外的本机目录：`<cache-root>/models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35f…/`（定位方式：`find <cache-root> -type d -name 'models--Qdrant--bge-small-zh-v1.5'`；**在 `.tmp` 下，随时可能被清**，故不写机器绝对路径——仓库门禁也会拒绝）：**该缓存已于 2026-09-15 清理删除**，所以这条离线佐证现在需要先把模型重新下载到本机（`scripts/verify-model-expected.mjs` 找不到缓存时会明确报「未复核」，不静默通过）。

- `blobs/1294ea4b6331115a…` 的**文件名就是** `model_optimized.onnx` 的 sha256；
- `trees/46fbe35f….json` 显式记 `lfs_sha256: 1294ea4b…`（比第一版引用的物证更直接）；
- 两个 JSON 的 blob 名是 Git `hash-object`(sha1)，与 `files_metadata.json` 里的记录自洽。

**（3）第一版口径偏强的更正**：已安装的模型是走 `--model-from` 从该缓存复制来的（`MANIFEST.json` 里没有 `huggingfaceRepo`），所以"已安装 == 缓存"这一比对**只证明复制无损**。上面的 (1) 才是独立复核；(2) 是次强的离线佐证。

## D3 判定范围：受检作用域、集合对齐与**解析遮蔽**

第一版要求"实际文件集合与期望清单精确对齐、多出即不一致"，**会否掉它自己刚装出的目录**（安装脚本把 `MANIFEST.json` 写进同一个模型目录，实测 201 vs 200）。故范围必须定死：

| | 规则 |
|---|---|
| 受检作用域 | 期望清单里的**每个路径**；外加 `node_modules/` 以下**直到成组内容之前**的每一层 |
| 成组内容（`onnxruntime-common`） | 视为**不透明单条目**：它的整体指纹**就是**该组的全部判据，不要求逐层枚举其内部条目 |
| 加载解析路径上的层 | 每一层的条目集合（子目录 + 文件）**精确等于**清单在该层定义的那一组；模型目录的**根层不要求**无额外文件 |
| 排除项 | 仅 `.DS_Store` 与 `._*` |
| 符号链接 | **不跟随**；常规文件被换成链接时报**不符**（不是"缺失"——它存在，只是不是那一份） |

**为什么把成组内容定为不透明单条目**（第一版的规则在此处是空头）：D9 只给该目录一个聚合指纹，没有列出它的 5 层（实测条目数 `4 / 2 / 85 / 85 / 21`），所以"每一层都受检"在该子树内**无定义**。而且 D8 的指纹只数常规文件，**看不见**新增的目录与符号链接——独立评审实测：在子树内加入 `dist/cjs/node_modules → …`、一个空目录、一个悬空链接之后，指纹**仍是** `8aeb72b1…`。把该组定为不透明条目，是把"覆盖不到"如实写成限度，而不是声称覆盖全部。

**这为什么仍可接受**：成组内容内部多出的 `node_modules` 要能被加载，得有谁去解析它；独立评审逐层查过 `onnxruntime-common` 的 `dist/cjs/esm/lib`，**没有任何裸说明符 import**，所以那条路径当前不可利用。这是"已界定的限度 + 当前不可利用"，不是"规则保证了它"。

**为什么要管 `node_modules/` 的两层**（独立评审指出的真实绕过路径）：`ort.node.min.mjs` 用**裸说明符** `import 'onnxruntime-common'`，Node 的解析顺序是 `<pkg>/dist/node_modules` → `<pkg>/node_modules` → 上一级 `node_modules`。在 `node_modules/onnxruntime-web/node_modules/onnxruntime-common` 放一份**别的**副本会被真正加载，而它既不在清单里、也不在成组内容的路径上——**"根层免检"的写法**会放过它（不是第一版：v1 的"全树精确对齐"恰会抓多余文件，实测的 201 vs 200 就是它抓 MANIFEST.json 的证据；前稿的归因写反了，此处更正）。安装脚本本来就只产出那两个包目录，所以收紧不会误伤。（替换整个 `onnxruntime-web` 目录则**会**被清单的 4 个文件抓住。）

理由总述：要防的失效模式是"必需的字节不是那一份"，不是"目录里没有别的东西"。旧运行时变体、来源记录留在根目录都无害。

## D4 刻意不做：不在插件加载期判定

**查实的宿主语义。** `@deepseek-ai/cordis-plugin-loader` 的条目组 `update()` 对条目 `Promise.allSettled`，任一失败即回滚（删新建、重建旧条目），随后 **`throw error`**（`lib/index.js:121`）；经 `cordis-plugin-include`（不 catch）→ `dsh-app-boot` 的 `assertEntriesActivated`（不 catch，rethrow）→ `profile-boot`（唯一 `boot` 调用者）→ `bin.js` 顶层 `await` 无 catch → **退出码 1**（评审用隔离 `boot()` 复现：`EXIT=1`）。**没有任何一层 catch 后只让该条目失效。** 该包**不在本仓库 `node_modules`**，位于全局 dsh 安装下（定位：`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/`；不写字面绝对路径——仓库门禁会拒绝）。插件今天已有加载期抛错（`index.ts:470`），该路径是活的。

## D5 刻意不做：不做运行期 Node 断言；`engines` 与仓库基线对齐

`node:sqlite` **不在宿主 import 闭包**（枚举宿主的 17 个模块，不含 `dist/recall/index-db.js`）。**证据强度须说清**：`pnpm check:boundary` 只断言闭包不触及 `onnxruntime-*` 与 `embed.js`/`worker.js`，它**不检查** `node:sqlite`；"不在闭包"是逐模块枚举得出的。

因此老 Node 上宿主照常启动，失败发生在检索子进程。已知不精确：那种失败会归一成 `internal` 而非 `runtime-missing`（D7 的兜底只覆盖模型原因）。本期不改。

**决定：`engines.node = ">=24"`（按实测下限）。** 依据：本机 **24.16.0** 与 **26.7.0** 都实测通过——24.16 上 `node --test test/*.test.ts` 0 fail，且用**真实模型 + 真实正本**跑 `dist/recall/worker.js --rebuild` → exit 0。⚠️ 前稿写"检索子进程需要 26"是**错的**：那是把本机 `node -v` 当成了要求，被独立评审用 24.16 端到端证伪。宿主闭包不含 `node:sqlite`（17 个模块逐个枚举），但**子进程与宿主必然是同一个二进制**（`process.ts:111/260` 读 `this.options.execPath ?? process.execPath`，而全仓无一处传 `execPath`），所以只能声明**一条**范围；`openspec/config.yaml` 的"Node >= 22"来自归档（说的是 `node:sqlite` **可用**，未区分是否需要 flag），22/23 未实测，故下限锚在实测过的 24。文档写"检索子进程需要无需 flag 的 `node:sqlite`；实测 24.16 与 26.7 可用"。

## D6 失败作用域与自愈的补丁（范围已扩大）

- 判定失败 → 不 spawn、不缓存 → 自愈（D1）。
- **补丁**：`worker.ts:110` 的 `this.embedderPromise ??= Embedder.create(…)` 会把失败**永久记住**（rejection 被缓存），而 `process.ts:168-173` 收到错误帧只 reject 不 stop、`query()` 的 catch 只处理 `rebuild-needed`。
  **第一版把补丁写窄了**：只对 `runtime-missing` 停 worker。但 TOCTOU 窗口内若被换成**损坏**（而非合法）的内容，`errorKind` 会归成 `internal`，worker 照样被永久毒化 → 原因消除后仍失败（`searchIdleMs<=0` 时永不恢复），违反「恢复后无需重启」。
  **改为**：**让 `??=` 在失败后可复位**——即失败时清掉 `embedderPromise`，下一次检索重新加载。
  **为什么选复位而不是"停 worker"**：独立评审实测，两种原因（`runtime-missing` 与 `internal`）在失败后第二次检索都会返回**同一条缓存错误**（永久毒化复现），而复位让两种原因都重新加载。更关键的是，**线上的 worker→host 帧只有 `{kind, message}`**（`protocol.ts`），"`internal` 且来自建模阶段"在契约上**无法区分**（损坏内容的加载失败确实归 `internal`）；要区分就得动协议，而 D7/D13 的口径恰恰是避免动协议。复位既不动协议、也不重启子进程、也没有分类问题。

## D7 兜底：只做**失败归一**，并明说它抓不到什么

`--rebuild` 子进程失败时宿主硬编码 `'internal'`（`process.ts:283-289`，`test/recall-process.test.ts:199-215` 固化了它），子进程侧顶层 catch 一律 `exit(1)`（`worker.ts:265-273`）。这会把 spec 保留的场景「两者同时不满足 → 报运行时或模型缺失」推成错的种类。

**兜底**：模型/运行时原因用**独立退出码**，宿主映射为 `runtime-missing`；其它原因仍 `internal`。既有那条测试**保留**，另加一条模型原因的用例。

**抓不到什么**：换成**合法**内容（如 22 B 的 `tokenizer_config.json`）时子进程成功退出 0——判定与兜底都不报错。该窗口由 D1 如实界定。

## D8 目录指纹算法（定死到可复现）

基准 = `<模型目录>/node_modules/onnxruntime-common`：

```
递归列出该子树下的**常规文件**（不跟随符号链接；目录/链接/其它类型不计入）
相对路径转 POSIX 分隔符；按 **UTF-16 码元序**（JS 默认的 < 比较）升序排序
依次拼接 `${相对路径}\n${该文件 sha256 十六进制}\n`
对整个拼接串取 sha256
排除：仅 `.DS_Store` 与 `._*`
```

**两种自然读法确实给出不同结果**（说明"钉死"是必要的）：

| 读法 | 结果 |
|---|---|
| 本设计（字节序 + common 基准） | `8aeb72b1bbfbed33f8d9e614b4c63ebf95328595e6640885dd2082bd0cf8024c` |
| 用 `localeCompare` 排序 | `035f366e1b2c09b454472b988464ef6229eba7c2f03a5b9154256f567d073bda` |

**已删除一行**：前稿曾写"基准换成模型目录根 → `759bd7f3…`"。该值**不可复现**——独立评测试了 30 余种自然变体均无此值。那是我把一份评审报告里的数字直接抄进设计、**没有自己复算**；现予删除，只保留我自己算过、且有第二轮独立复现的那一行（`localeCompare`）。**顺带这也说明"基准必须钉死在 common 子树"**：以模型目录根为基准会含 `MANIFEST.json`，指纹随安装变化。

条目数与本机实测：**193 个文件 / 573,091 字节**。

## D9 期望身份清单（本机实测，全部与已安装目录一致）

| 相对路径 | 字节 | sha256 |
|---|---|---|
| `model_optimized.onnx` | 94,781,076 | `1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38` |
| `tokenizer.json` | 439,125 | `48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26` |
| `tokenizer_config.json` | 367 | `e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a` |
| `node_modules/onnxruntime-web/package.json` | 4,593 | `9c803baa1820e75a82907bbf29c0a4be84d4eaec33693b4ab3bd5051fde85ee9` |
| `node_modules/onnxruntime-web/dist/ort.node.min.mjs` | 27,061 | `d03374770621e06e4750482236ec6dbd6299d0205b9de44b9eebe52a0721ef71` |
| `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs` | 24,218 | `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747` |
| `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` | 13,961,845 | `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d` |
| `node_modules/onnxruntime-common/`（D8 的目录指纹） | 193 文件 / 573,091 | `8aeb72b1bbfbed33f8d9e614b4c63ebf95328595e6640885dd2082bd0cf8024c` |

**字节账**：7 个文件 **109,238,285 B**；8 项（含目录）**109,811,376 B**。

## D10 派生索引必须与模型身份绑定（本期新增范围）

**评审构造出的漏检路径（已由我独立核实）**：索引 `meta` 里**没有任何判定会比较模型身份**，而 `inspectIndex`（`:197-204`）只比 `algo_version === 'bigram-live-v2'` 与 `source_hash` 非空。（前稿写"meta 只写三个键"是**错的**：`recomputeMeta`（`:577-606`）另写 11 个键——`all_cjk_unigrams`、`doc_count`、`total_content_chars`、`n_terms`、`n_postings`、`n_title_tokens`、`n_content_tokens`、`scoring_k1/b/title_weight/evidence_weight`；结论"无模型身份"不受影响，但措辞须准。另注：`VECTOR_MODEL='bge'`（`:122`）与每行向量的 `model` 列（`:529`）只是**粗粒度**标记，同样没有任何判定比较它。）

于是：模型换成项目声明的**另一份**（判定全通过、安装自洽）之后，盘上索引仍是**旧模型**算出的文档向量；新模型算出的查询向量与旧文档向量比较 → **静默地、无限期地在另一个向量空间里作答**。这不在 D1 的 TOCTOU 窗口内，是设计此前完全没覆盖的一条路径。

**修法（三处必须写死，否则实现会恰好漏掉模型换代）**：

1. **取哪个摘要**：必须取**覆盖模型权重**的摘要（至少 `model_optimized.onnx` + 两个 tokenizer；更稳的是对整份 8 项声明取摘要）。**不能**照字面取 D8 的目录指纹——那个只覆盖 `onnxruntime-common`，换 `model_optimized.onnx` 时它**不变**，spec 的场景就恰好不成立。
2. **它怎么到达写入方与检查方**：`EmbedderLike` 只有 `embed()`，`IndexDb.sync`/`inspectIndex` 都不认识模型。该值须由 worker 从期望身份模块（或经环境变量传入）取得，再在写/检两侧使用——这条链路要在实现里明说，否则两侧各取各的。
3. **必须是 `needsFullBuild`，不能只重嵌变更文档**：`sync` 的增量路径只重嵌 **changed** 文档（`:445-478`），模型换代而源库未变时它会返回 `noop`，直接复用旧向量；若期间有增量同步，则会得到**同一索引里混着两套向量空间**。所以判定条件要落在 `needsFullBuild` 上（复用既有 `algo-mismatch` 形状），缺该键（更早版本建的索引）同样视为需要重建。

**代价（应写进 proposal 的影响面）**：所有既有索引都会因缺该键而被判需要重建 ⇒ 升级后第一次检索触发**一次全量重建**。读数要按归档的原配对引用：**冻结语料量级 ≈11.96 s（16 线程）**；冷启动含重建 15,878 ms——前稿把"12 s"与语料条数拼在一起，查无出处。判定为**值得**：失效是静默且无限期的，而重建是既有的、一次性的恢复路径。

这条进了 `engram-bridge-recall` 的 delta（新增 requirement）。**测试注意**：`test/recall-index.test.ts:292-310` 手写 `source_hash` 后断言 `needsFullBuild === false`（`:302`），加必填键后必红，必须一并更新。

## D11 期望身份必须可注入；安装脚本如何引用它

### 为什么不能是配置项

判定依据是钉死的真实摘要，而 `test/recall-support.ts` 的 `fakeModelDir` 造的是 `'stub model bytes'` 这类合成字节，**永远匹配不上**。实测会红的是走 `RecallProcessManager` 的用例（`recall-process.test.ts:45,226`、`recall-wiring.test.ts:142`），**不是**直接调 `Embedder.create` 的 `recall-embed`。

接缝：`RecallProcessManager` 增可选 `expected`（默认取仓库声明）；`apply(ctx, config, deps?)` 透传 `deps.expectedModel`。**生产路径拿不到它**——评审核实 cordis 只以 `(this.ctx, this.config)` 调 plugin（第三参 `getOuterStack` 不进 callback），全仓只有测试直接调 `apply`。

**做成配置键 = 把 D0 的同义反复请回来**（"与验收时那一套一致"退化成"与使用者声明的那一套一致"）。spec 里已把它写成硬约束（使用者无法改写判据）。

### 安装脚本如何引用同一份声明

`dist/` 被 gitignore，而安装脚本要能在**新克隆**上工作。三选一，**定 (b)**：

- (a) 声明放仓库根 JSON 让两边共用——需打开 `resolveJsonModule`，而 NodeNext 下 Node 的 ESM JSON import 还要带 `with { type: 'json' }`，TS emit 与它容易错位；不引 JSON import 就得再加一步"build 时拷进 dist"，为一个不需要的能力引入两处机制。
- (b) **脚本从 `dist/` 引用，并在缺失时显式失败**，要求先 `pnpm build`。(b) 不新增任何要求——README 已写明"必须先构建再安装"（`dist/` 未入库 + `link:` 不触发构建），安装模型本来就排在其后。单一真值来源不动，零管道。
- (c) 脚本自己生成期望值——**直接把同义反复请回来**，排除。

验证方式：删掉 `dist/` 后运行安装命令，断言失败信息指向"先运行 `pnpm build`"，而不是 `ERR_MODULE_NOT_FOUND`。

## D12 实测读数与物证

| 项 | 读数 | 方法 / 出处 |
|---|---|---|
| 逐文件比对 7 文件（109,238,285 B） | **约 48–52 ms** | 本机多次测量：作者 52 ms；第四轮独立评审 7 文件 48.0–51.1 ms、**全量作用域**（7+193 文件）50.3–51.1 ms。前稿写的上界 56.2 ms 未复现，已去掉。**注**：前稿还把两个"评审甲/乙"区间写成三方独立测量，但那两个数值在盘上**查无产物**（本仓库无任何评审记录文件）——即便与实测吻合，也应按二手读数看待，故不再署名 |
| 运行时 4 文件 vs 锁定依赖 | 4/4 一致 | 从 `.pnpm` 源重算，离线 |
| 目录指纹 vs `.pnpm` 源 | 一致；受检 4 文件与 `common` 子树 193/193 逐文件相同（该源整包 509 文件，裁剪是设计） | D8 算法，离线 |
| 模型 3 文件 vs **远端重取** | 3/3 逐字节一致 | 经代理从钉死 revision 重取（D2），**已完成** |
| 模型 3 文件 vs 本地缓存 | 3/3 一致 | 缓存为符号链接，按目标读 |
| 缓存布局佐证 | `blobs/1294ea4b…`、`trees/<rev>.json` 的 `lfs_sha256` | 目录布局本身 |
| 热 worker 豁免 | 破坏 glue/`.wasm`、改名 `onnxruntime-common` 后 `run` 仍成功 | 实测 |
| 边界（判定后的替换） | 换入合法 22 B `tokenizer_config.json` → 成功、`maxLength=8`、退出 0 | 实测；窗口随语料增长（D1） |
| 对照 | 冷启动 15,878 ms；热调用 17–27 ms | 上一变更归档的活宿主读数（`archive/2026-09-14-engram-bridge-read-layer/design.md`） |

## D13 刻意保留：requirement 名不改

「运行时或模型缺失时响亮失败」不覆盖"内容不符"。改名需要 `RENAMED` 语义，而本仓库从未用过它（归档只实测过 ADDED/MODIFIED）；收益仅是措辞。选择在正文里定义「不可用」，把归档操作限制在已验证的路径上。

## D14 归档后必须回填元数据（实测）

`openspec archive` 对**新建** capability 只产出标题与 `TBD - created by archiving…` 的 Purpose，**delta 的 frontmatter 被整段丢弃**（1.4.1 实测；源码 `buildSpecSkeleton` 佐证；仓库 p0 亦记过）。本仓库 7 个主 spec 全部有 frontmatter。因此归档后必须：

- 给 `engram-bridge-model-install` 补 frontmatter 与真实 Purpose；
- 给 `engram-bridge-recall` 主 spec 补本变更新增决定的 anchors（`src/recall/model-expected.ts`、`src/recall/process.ts`）。

## D15 已考虑、且**不构成洞**的边界项

逐条走过并留档，省得下一轮再走一遍：

- **根目录放 `tokenizer.json` 的兄弟文件**：运行期只按 `model-dir.ts:33-52` 的显式路径读那 3 个模型文件与 `ortDist` 下的 glue/wasm，兄弟文件永不被读。
- **`.DS_Store` / `._*`**：显式排除（D3）。
- **换行符 / 文本规范化**：比字节，不做规范化；不做规范化即无歧义。
- **macOS 大小写不敏感**：全路径无大小写碰撞、无非 ASCII 名，且判定比的是字节——同一字节即同一份。
- **多 profile / 多工作区共享同一模型目录与索引目录**：判定只读，所以"读它安不安全"没问题；但**共享目录 + 不同声明版本**会产生真问题——两个 profile 装的插件版本若声明不同，共享模型目录时必有一个永远判定失败；共享索引目录时两者会每轮把对方的索引判为需要重建（**每次全量重建**，归档实测约 12 s）。D1/D6 的"字节已在内存里"在这里也**不成立**（每个宿主进程有自己的 worker）。**本期不解决**，作为已知未知记录，并在 README/AGENTS 写明"同一台机器请让所有 profile 保持同一插件版本"；若要根治，方向是按身份分目录（不在本期范围）。
- **`cpSync` 复制语义**：`copyFileSync` 解引用符号链接（把缓存里的链接落成真实文件），这是我们想要的；但 `cpSync(commonSource, target, {recursive:true})` **不解引用**（源若是链接会把目标装成链接，实测），且**合并覆盖不清空**（旧文件残留，实测）。两条都要在实现里修：`dereference: true`（注意它只对**源根本身是链接**有效，**不解引用树内嵌套的文件软链**——验证时链接要放在源根）+ 安装前清空目标 **`node_modules/` 整棵子树**（不只是 `common`：`onnxruntime-web/dist` 只做 4 次 `copyFileSync`，那里的旧残留同样会让逐层精确相等永久失败）。否则 D3 的"集合精确相等"会把残留判成失败，而用户用同一条命令修不好。

## D16 已知未知与退回条件

- **判定后的替换不由本设计覆盖**，且窗口随语料增长（D1）。要收窄需要"子进程自己校验"或"把内容随进程传递"，本期不做。
- **arm64 / 慢盘**：约 51 ms 是本机读数；慢盘上它是 109 MB 顺序读。若在目标机器上超过热调用量级，退回条件是把判定降级为"安装后一次 + 显式 `--check`"。
- **`--rebuild` 的退出码取值**、**安装记录的字段形状**、**索引 `meta` 里模型身份键的名字**由实现定，均须测试固化。
- **`engines` 与 `config.yaml` 的分层表述**（D5）在实现时落定。
