# 任务

## 1. 期望身份（仓库侧声明）

- [x] 1.1 新增期望身份模块（`src/recall/model-expected.ts`）：导出必需内容的相对路径 → 摘要、`onnxruntime-common` 的目录指纹及其算法版本、所锚定的来源（模型 repo + revision、运行时依赖版本）。取值见 `design.md` D9；算法**逐字**照 D8（基准为 `node_modules/onnxruntime-common`、UTF-16 码元序、只计常规文件、不跟随符号链接、排除 `.DS_Store` 与 `._*`）。须能被宿主、安装脚本与测试三处引用。
  - 验证：单测断言条目数为 8（7 文件 + 1 目录）；**断言来源字段存在且指向** `Qdrant/bge-small-zh-v1.5@46fbe35f…` 与 `onnxruntime-web@1.29.0`；**负向对照**——若干自然变体（换排序方式、换基准）各自算出的指纹**必须等于各自独立重算的值、且互不相同**（只断言"不等于 `8aeb72b1…`"不足以证明基准被钉死）。**排除项那一对变体必须在一个真的含 `.DS_Store`/`._*` 的夹具上比**——真实安装树里没有这类文件，含与不含排除项会给出**同一个值**，负例在那里没有判别力；`pnpm check:boundary` 仍通过。
- [x] 1.2 **离线复核**：运行时的 4 个受检文件与 `onnxruntime-common` 的**目录指纹**可由锁定版本的依赖独立重算（就地读 `node_modules/.pnpm/onnxruntime-web@1.29.0/…`）。**注意"逐文件相同"只对受检项与 common 子树成立**（该源整包 509 个文件，已安装只有 4 个——裁剪是设计），断言要写成"受检 4 文件 4/4 相同 + common 子树 193/193 相同 + 指纹等于 `8aeb72b1…`"（指纹编码的是**相对路径集合**，不是文件内容之和，故必须单独断言）。
  - 验证：一段脚本或测试重算并逐条比对；把任一条期望值或算法的任一处（排序方式、基准）改坏时必须失败。
- [x] 1.3 **模型半的复核**：
  - (a) 本地佐证（离线，无需网络）：断言 `<cache-root>/…/snapshots/46fbe35f…/blobs/<模型 sha256>` 存在且与已安装 `model_optimized.onnx` 摘要一致；断言 `trees/46fbe35f….json` 记的 `lfs_sha256` 等于同一值。**不要写字面绝对路径**（仓库门禁拒本机路径）；路径以可定位形式给出（`find` 或环境变量）。该缓存位于另一个仓库的 `.tmp` 下、随时可能被清，脚本找不到时应**跳过并明确报告「未复核」**，而不是静默通过。
  - (b) 远端重取（**已完成**，读数记于 `design.md` D2/D12：三个文件与已安装逐字节相同）。保留为可复跑步骤，方法：`curl -x <proxy> -L https://huggingface.co/Qdrant/bge-small-zh-v1.5/resolve/46fbe35f…/<file>`（本机直连 HF 不通；Node `fetch` 不读 env 代理）。
  - 验证：记录命令与两侧摘要；不一致即说明期望值或来源有误。
- [x] 1.4 **安装脚本如何引用这份声明**（`design.md` D11 定 (b)）：脚本从 `dist/` 引用；**先检查 `dist/` 是否存在**，缺失时以"先运行 `pnpm build`"的明确信息退出。
  - 验证：删除 `dist/` 后运行安装命令，断言失败信息指向先 build，**而不是** `ERR_MODULE_NOT_FOUND`；`pnpm build` 之后同一条命令正常工作。

## 2. 判定与失败路径

- [x] 2.1 `src/recall/model-dir.ts` 新增按期望身份的判定：区分「缺失」与「不符」，返回项含相对路径、期望与实际（目录给出目录指纹）。判定**不得读 `MANIFEST.json`**。**判定函数只由 `process.ts` 在两处 spawn 前调用，不得挂进 `assertModelDir`**——后者是 `Embedder.create` 的自然调用点，挂上去会让 `recall-embed` 的三个夹具一起变红，并把判定重新拖回每次调用/每个 worker 的路径上。
  - 验证：单测覆盖正常 / 改一字节 / 截断 / 删文件 / 期望值本身被改坏；断言「缺失」与「不符」被分别标注；对 `MANIFEST.json` 的读取打桩断言**零次**（`createRequire` 改 CJS `node:fs` + `syncBuiltinESMExports()`）。
- [x] 2.2 判定范围与集合对齐（`design.md` D3）：受检作用域 = 期望清单每个路径 + `node_modules/` 以下**直到成组内容之前**的每一层；**成组内容（`onnxruntime-common`）视为不透明单条目**（其整体指纹就是全部判据，不逐层枚举——D8 的指纹看不见内部新增的目录/链接，这是已界定的限度）；成组内容**之上**每一层的条目集合精确相等；模型目录**根层**不要求无额外文件；只计常规文件（不跟随符号链接）；仅排除 `.DS_Store` / `._*`。
  - 验证：单测——（a）在 `/tmp` 用安装脚本做一次全新安装（**不读真机目录**），其产物判定为**一致**（含安装过程写下的 `MANIFEST.json`）；（b）在**加载解析路径上**的某层加一个文件 → 失败；（c）删一个受检文件 → 失败并报缺失；（d）**解析遮蔽**：在 `node_modules/onnxruntime-web/node_modules/` 与 `node_modules/onnxruntime-web/dist/node_modules/` **两处**各放一份别的 `onnxruntime-common` → 均失败（这两处是解析路径上的**兄弟分支**，不是组内容的祖先；覆盖它们的是"解析路径上的每一层"这条规则）；（e）在根目录加一个无关文件 → **仍一致**；（f）把某个受检文件换成符号链接 → 报**不符**（不是"缺失"——它存在，只是不是那一份）；**负例要能区分"跟随/不跟随"**：链接的目标内容须与期望**不同**（若指向正确目标，两种策略结果相同，这个负例就没有判别力）；（g）成组内容内部新增一个链接/空目录 → 指纹**不变**、判定仍一致（**把这条限度也断言下来**）；（h）解析路径上放一份**内容相同**的同名副本 → 仍失败（多一层即不是声明的安装）。
- [x] 2.3 `ModelUnavailableError` 的消息模板区分「缺失」与「不符」（现模板硬编码"缺少：…/请运行 install"，承载不符时自相矛盾）。
  - 验证：单测断言两种情形各自的消息、不符时同时出现期望与实际；**并更新既有消息断言**——`test/recall-runtime.test.ts:201` 与 `test/recall-embed.test.ts:162`。
- [x] 2.4 判定落在**两处 spawn 之前**：常驻 worker 与 `--rebuild`。**位置钉死在 `start()` 的三处早返回守卫（`closed` / `child !== undefined` / `starting !== undefined`）之后、`const starting = (async () => …)()` 之前**——放在守卫之前会退化成"每次 `query()` 都哈希 109 MB"（违背 D1 成本表与 spec 的"判定 SHALL NOT 使每次检索都读取全部内容"）；放在异步体内部则 `this.starting = starting.finally(…)` 会产出无人处理的 rejection，而 dsh 常驻 `unhandledRejection → exit(1)`（见 `design.md` D1）。失败即抛 `runtime-missing`、**不起子进程、不缓存任何子进程**。
  - 验证：单测对两处分别注入不符的模型目录，断言（a）抛 `RecallUnavailableError` 且 `kind === 'runtime-missing'`；（b）spawn 未被调用；（c）**判定失败后不出现无人处理的 rejection**（挂 `process.on('unhandledRejection')` 断言零次）；（d）把目录改回后，紧接着的下一次调用成功（自愈，不依赖回收）。
- [x] 2.5 **worker 侧补丁（`design.md` D6）**：**让 `worker.ts:110` 的 `??=` 在失败后可复位**（失败时清掉 `embedderPromise`），使任何原因的嵌入加载失败都能在下一次检索重新加载。**不选**"停 worker"：worker→host 的帧只有 `{kind, message}`，"`internal` 且来自建模阶段"在契约上无法区分，要区分就得动协议。
  - 验证：**先写红**——不施补丁时，「让 worker 首次加载失败（分别用 `runtime-missing` 与 `internal` 两种原因）→ 改回文件 → 紧接着再检索」必须返回**同一条缓存错误**；施补丁后两条都重新加载并成功。
- [x] 2.6 **兜底**：`--rebuild` 子进程因模型/运行时而失败时以**独立退出码**退出，宿主映射为 `runtime-missing`；其它原因仍 `internal`。
  - 验证：**保留**既有「重建失败 → internal」用例（`test/recall-process.test.ts:199-215`，它用通用 exit 1），**另加**一条模型原因的用例断言 `runtime-missing`。
- [x] 2.7 每次调用前的既有存在性检查（`assertInstalled`）保持**每调用一次**、不读期望清单、不做摘要比对。
  - 验证：**这是热路径边界的行为断言**（与 spec 的"已加载进内存的副本视为已通过判定"一致）——同一次子进程生命周期内改动盘上文件后，第二次检索**仍成功**；同时断言 `assertInstalled` 不触碰期望清单。

## 3. 安装脚本（`scripts/install-recall-model.mjs`）

- [x] 3.1 安装完成即**自证**：按期望身份判定，不符即以非零状态退出并指名内容。
  - 验证：正向——从本机缓存安装到 `/tmp`，退出 0；负向——把 `--model-from` 指向一份**被篡改的副本**（改一字节），断言非零退出并指名该文件。负例必须真的能失败。
- [x] 3.2 `--check` 升级为按期望身份比对内容，并区分缺失与不符。
  - 验证：改一字节 → 非零、输出含期望与实际；删一个文件 → 输出把它标为缺失；**同一次输出里同时存在两种标注**；还原后退出 0。
- [x] 3.3 两种安装模式都记录**实际来源**：远端记 repo + revision，本地记解析到的目录位置。
  - 验证：`--model-from` 指向带 `snapshots/<rev>/` 结构的临时目录，断言记录的来源等于解析出的目录。**远端模式**：本机直连 HF 不通、脚本自身用 `fetch` 且不支持代理 ⇒ 该场景在本机**不可真验**，只能靠**子进程 `--import` preload** 打桩（脚本顶层 `await main()`，进程内打桩改不到已发出的请求）。**不得**退化成"断言来源字段等于我们传进去的串"——那正是 D0 批过的同义反复；若决定不装 preload，就在 `design.md` 里把该场景标注为**本机不可观察**，而不是假装验过。
  - 结果：**本地模式**：`--model-from` 指向带 `snapshots/<rev>/` 的目录 → 记录 `{kind:'local', dir:<解析出的 snapshot 目录>}`，与解析结果逐字相同。**远端模式（原按任务退路准备标注为「本机不可真验」，实际做成了真验）**：Node ≥ 24 的 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=<proxy>` 能让**脚本自身**的 `fetch` 走代理（此前"fetch 不读环境代理"只对不开该开关的默认行为成立），于是无 `--model-from` 的下载路径在 `/tmp` 跑通：三个文件从 `Qdrant/bge-small-zh-v1.5@46fbe35f…` 下载 → 自证一致 `exit 0`、`--check` `exit 0`、`verifyModelDir` 0 项、`totalBytes=109811376` 与 D9 的字节账逐位相同（而且这次是**全新下载**，等于把字节账又独立复核了一遍）；记录 `{"kind":"remote","repo":"Qdrant/bge-small-zh-v1.5","revision":"46fbe35f…"}`。既不需要 `--import` preload 打桩，也没有退化成「断言来源字段等于传进去的串」。
- [x] 3.4 来源缺少必需内容时以非零状态退出并指名缺失项（含成组内容）。
  - 验证：删掉一个必需文件、再单独删掉 `onnxruntime-common` 的一个文件，各断言非零退出与输出。
- [x] 3.5 **复制语义两处修正（`design.md` D15）**：`cpSync` 加 `dereference: true`（源为符号链接时别把目标装成链接）；安装前**清空目标 `node_modules/` 整棵子树**（不只是 `onnxruntime-common`——`cpSync` 是合并不清空，而 `onnxruntime-web/dist` 只做 4 次 `copyFileSync`，那里的旧残留同样会让 2.2 的逐层精确相等永久失败，且用户用同一条命令修不好）。
  - 验证：源为符号链接时断言目标是真实文件；**在两棵子树的各一层**预置旧文件后重跑安装，断言残留被清掉且判定一致。
- [x] 3.6 **中断不留可用安装**：安装中途失败（只写了一部分）时，该位置随后不得被判为可用。
  - 验证：在复制阶段注入一次失败后断言（a）退出码非零；（b）紧接着跑 `--check` 判定为不一致。若实现选择"先装到临时目录再原子替换"，则断言临时目录不残留、目标目录保持原状。

## 4. 接缝与既有测试

- [x] 4.0 **注入接缝（先于 4.1）**：`RecallProcessManager` 增可选 `expected`（默认取仓库声明）；`apply(ctx, config, deps?)` 透传 `deps.expectedModel`。**不得做成配置键**（`design.md` D11）。
  - 验证：断言不传 `expected` 时用的是仓库声明；断言插件配置 schema（`Config`/`Schema`）里**不存在**任何期望身份相关键。**负例**：注入一份不同的期望时判定按注入值走；另外**声明对象须深冻结**（`Object.freeze` 是浅的，挡不住嵌套属性被改——前稿把"ESM 绑定不可改写"当成理由，那是错的：绑定确实不可重新赋值，但**对象属性可以**）。
- [x] 4.1 更新 `test/recall-support.ts` 的 `fakeModelDir`（约 `:169-186`）：**注入一份与该 fixture 内容匹配的测试期望**，使走 `RecallProcessManager` 的用例（`recall-process.test.ts:45,226`、`recall-wiring.test.ts:142`）在判定路径**真的执行且通过**；并加一条内容不符的负例夹具。
  - 验证：`node --test test/recall-process.test.ts test/recall-wiring.test.ts test/recall-embed.test.ts` 全绿；负例夹具按预期抛错。
- [x] 4.2 覆盖「安装产物不参与判定」：删掉或改写一份安装的记录后，「它是不是这一份」的结论不变。
  - 验证：同一模型目录，分别在记录存在 / 被删 / 被改写三种状态下判定，结论相同。

## 5. 包元数据与仓库基线

- [x] 5.1 `package.json` 声明 `engines.node = ">=24"`（**实测下限**：24.16.0 与 26.7.0 均端到端通过；见 `design.md` D5）；**不做运行期断言**。
  - 验证：断言 `engines.node` 的值**等于该字面量**；`npm pack --dry-run` 退出 0（**不是** `pnpm pack --dry-run`——pnpm 9.15.9 不认该选项，实测 exit 1）；grep 断言 `src/` 下没有对该字段的运行期读取。
- [x] 5.2 **把下限的依据写进文档**（`design.md` D5：`engines.node = ">=24"`，实测下限）：`README.md` 与 `AGENTS.md` 写明"检索需要无需 flag 的 `node:sqlite`；实测 24.16.0 与 26.7.0 可用"。
  - 验证：两处文档都能读到该下限与实测依据；`config.yaml` 里"Node >= 22"那句要么改成与 `engines` 一致，要么保留 22 但**注明它说的是 `node:sqlite` 可用、未区分是否需要 flag**（不能两处各自声称一个未实测的更宽范围）。

## 6. 文档

- [x] 6.1 `README.md` 的显式安装一节补：安装会自证、`--check` 比对内容、期望身份在仓库内且可独立复核、Node 版本要求、以及"安装模型前需要先 build"。
  - 验证：五个要点逐条能在 README 中读到。
- [x] 6.2 `AGENTS.md` 的安装说明同步：运行时或模型**不符**时也响亮失败，且失败限于该次检索。
  - 验证：该节文字与 `specs/engram-bridge-recall` 的要求一致。

## 7. 索引与模型身份的绑定

- [x] 7.1 把**覆盖模型权重**的摘要（至少 `model_optimized.onnx` + 两个 tokenizer；建议对整份 8 项声明取摘要——**不要**用 D8 的 `onnxruntime-common` 目录指纹，那个换模型时不变）写进派生索引的 `meta`，并作为 `inspectIndex` 的 `needsFullBuild` 条件之一（复用既有 `algo-mismatch` 形状）。**必须走 `needsFullBuild`，不能只重嵌变更文档**（`sync` 的增量路径只在源库变化时重嵌，模型换代而源库未变会返回 `noop` 复用旧向量；若期间有增量同步，会得到同一索引混两套向量空间）。缺该键（更早版本建的索引）同样视为需要重建。
  - 验证：单测——（a）**只改模型文件**（tokenizer 与运行时不动）后 `needsFullBuild === true`（负例必须只差在模型权重上，否则会为错实现放行）；（b）删掉该 meta 键后同样为 true；（c）身份一致时为 false；（d）**端到端**：按新声明重装模型后紧接着的检索发生**重建**，而不是用旧向量作答；（e）**更新既有测试** `test/recall-index.test.ts:292-310`（它手写 `source_hash` 后断言 `needsFullBuild === false`，加必填键后必红）。
  - 记入影响面：既有索引因缺该键都会被判需要重建 ⇒ 升级后第一次检索触发一次全量重建。读数按归档原配对：**冻结语料量级 ≈11.96 s（16 线程）**；冷启动含重建 15,878 ms。

## 8. 验收与归档

- [x] 8.1 **失败作用域（热路径，决定性）**：备份真机模型目录中的一个文件 → 改动一个字节 → 确保**没有常驻 worker**（判据：等过 `searchIdleMs` 并确认进程不在；或改用一次冷启动并把"pid 不变"的参照点记为冷启动后的 pid）→ 发起检索。**注意真机模型目录被多 profile 共享**，操作期间同机其它会话的检索会失败。
  - 验证：该次检索返回明确错误并指名文件；**宿主进程未退出、pid 不变**；同一会话的后续回合正常；工具面不变（会话日志 `request/header` 的 `data.header.tools` 名字列表、前缀计数不变）；该失败在**会话日志里可读**（给出读取命令与判定方式，沿用上一变更的做法）。收尾：还原备份并确认恢复。
  - 结果：**隔离宿主**（`scripts/probe/run-model-integrity.sh`：真实插件 + 真实 worker 子进程 + 真实会话日志）。**一处偏离需说明**：本机沙箱不允许写共享模型目录，所以破坏的是该目录的**副本**（110 MB，逐字节相同）。harness 把模型目录做成参数，字面版本由有写权限的 shell 用 `MODEL_INTEGRITY_MODEL_DIR=<真机目录>` 重跑即可。读数：篡改一个字节后冷启动 → 宿主启动成功，工具面 45 项（`mcp__engram__*` 20 项、含 `mem_bridge_recall`、不含 `mem_search`）；第一次检索返回 `Error: engram-bridge: 检索所需的运行时或模型不可用。… 不可用项：不符 分词器配置 tokenizer_config.json（…）：期望 sha256 e6f3b96d…（367 B）；实际 sha256 ab5cb362…（367 B）`；**紧接着同一进程里 `bash` 调用成功**（宿主未退出）；还原后同一进程内下一次检索返回 3 条命中（`exit=0`）。会话日志读取：`zstd -dc <home>/sessions/*/session-*/session.v3.jsonl.zstd`，判据 = `request/header` 的 `data.header.tools` 名字列表 + `tool/result` 文本。**未取到 pid 数值**（bash 里 `$PPID` 恒为 `1`），"pid 不变"以行为替代：失败之后同进程仍服务了 `bash` 与第二次检索，整轮 exit 0。
- [x] 8.2 **冷启动 + 不符内容（`design.md` D4 的风险，必须真验一次）**：**重复 8.1 的破坏步骤且不还原** → **重启宿主**。
  - 验证：宿主**启动成功**、工具面注册完整、首次检索以明确错误失败。收尾：还原备份。这条与 8.1 观察的是两件不同的事（8.1 是"不打死运行中的宿主"，本条是"不阻止宿主启动"）。
  - 结果：与 8.1 是**同一次运行**——tamper 在 boot **之前**完成，宿主照样启动成功、工具面完整、首次检索以明确错误失败。
- [x] 8.3 **自愈**：**在 8.2 的还原完成之后**、同一宿主进程内立刻检索一次。
  - 验证：返回正常结果。**worker 侧两条原因（`runtime-missing` 与 `internal`）的活体复现不在验收范围**——稳定触发需要在"spawn 之后、首次加载之前"改文件，没有可操作的窗口；该覆盖由单测 2.5 承担，此处只验"冷启动路径上的自愈"。
  - 结果：`mv model/tokenizer_config.json.good model/tokenizer_config.json` 之后**同一进程内**立刻检索成功（3 条命中，得分 0.6699 / 0.5437 / 0.5314），无需重启。收尾核对：副本的 `tokenizer_config.json` 与真机正本同摘要 `e6f3b96d…`。
- [x] 8.4 **热调用延迟**：连做 10 次检索，记录中位耗时。
  - 验证：**基线在同一宿主进程内、8.1 的破坏之前**取（写明采样次数与是否预热）——8.2 重启过宿主，"同一会话"的口径不成立，基线必须与测量处在同一进程；读数**记录**。若仍要保留"中位值不超过基线 2 倍"这条哨兵，须先把它写进 `proposal.md` 的验收信号（现在那里只写了"判定耗时只记录"），否则就是无验收信号支撑的判据。
  - 结果：10 次热调用在**同一宿主进程**内完成（逐次用不同 query，绕开宿主"连续 5 次相同调用"的反循环保护）。host 观测的 `tool/call`→`tool/result` 间隔：**270 / 20 / 19 / 19 / 19 / 20 / 19 / 20 / 19 / 20 ms，中位 20 ms**（首次 270 ms = 起 worker + 开索引 + 一次判定）。与 design D12 的 17–27 ms 热调用读数一致；也印证了判定只在 spawn 时付费——10 次调用只付了一次。**只记录，不设哨兵**（按你的决定）。
- [x] 8.5 **安装侧端到端**：在 `/tmp` 完成一次真实安装（`--model-from`，本机缓存），随后 `--check` 退出 0；再篡改其中一个已安装文件，`--check` 非零退出。
  - 验证：两次退出码与输出；`MANIFEST.json` 里**本地模式**的来源字段非空且指向解析出的目录。
  - 结果：`/tmp` 全新安装（`--model-from` 指向本机 fastembed 缓存）→ 安装自证一致 `exit 0`；`--check` `exit 0`；改一字节 + 删一个文件 → `--check` `exit 1`，**同一次输出里**「不符」（含期望与实际两个摘要）与「缺失」并现；还原后 `exit 0`。`MANIFEST.json` 的本地来源 `{kind:'local', dir:<解析出的 snapshot 目录>}` 非空，`ortVersion=1.29.0`、`files=7`、`totalBytes=109811376`。同一份自断言脚本（26 条断言，全过）同时覆盖 3.1–3.6：源根为符号链接时目标落成真实目录、两处旧残留被清空、来源缺件分别 exit 2/exit 1 并指名、复制阶段失败 exit 1 且随后 `--check` 判不一致、缺 `dist/` 时指向先构建而不是 `ERR_MODULE_NOT_FOUND`。
- [x] 8.6 **归档后回填元数据**（`design.md` D14，实测：archive 会丢弃 delta 的 frontmatter）：为 `engram-bridge-model-install` 补 `id/title/type/status/triggers/scope/anchors/related` 与真实 `## Purpose`；为 `engram-bridge-recall` 主 spec 补本变更新增决定的 anchors（`src/recall/model-expected.ts`、`src/recall/process.ts`）。
  - 验证：归档后 `openspec validate --all --strict` 通过；新主 spec 有 frontmatter 且 Purpose 不是 `TBD`；两份主 spec 的 anchors 含上述文件。
  - 结果：归档产出 `openspec/changes/archive/2026-09-15-engram-bridge-model-integrity/`；新建的 `openspec/specs/engram-bridge-model-install/spec.md` 如 D14 所料**只有标题与 TBD Purpose、没有 frontmatter**，已补齐 `id/title/type/status/triggers/scope/anchors/related` 与真实 `## Purpose`；`engram-bridge-recall` 主 spec 的 frontmatter 原样保留（archive 不覆盖已有 spec 的元数据），已把 `src/recall/model-expected.ts`、`src/recall/process.ts` 补进 anchors。`openspec validate --all --strict` 通过。**归档需 `-y`**：8.6 本身是归档后任务，归档时的完整性检查必然看到 1 条未完成，交互式确认没有非交互出路。

## 实现期发现（记录，供后续变更参考）

### F1 任务 2.2(f) 的负例方向写反了
原文说「链接的目标内容须与期望**不同**」才有判别力。反了：目标内容**相同**时，"跟随链接"会放行、"不跟随"才报不符——那才是能区分两种实现的负例。若目标内容不同，两种实现都报不符，等于没有判别力。实现取的是更强的那种（同名链接指向**字节相同**的内容仍判不符）。

### F2 层级条目集合：只报"多出"，且符号链接也算条目
任务 2.2 的措辞「只计常规文件（不跟随符号链接）」来自 D8 的**目录指纹**，把它照搬到**层级条目集合**上会漏掉一条真实的遮蔽路径：`node_modules/onnxruntime-web/node_modules` 若是个**符号链接**指向别处的 `onnxruntime-common`，只数常规文件就看不见它，而解析顺序照样会走到它。实现按 spec 的「该层的**条目集合**与声明一致」处理：目录、常规文件、链接都算条目（只是不跟随），缺失方向不重复报（已由文件/组检查更精确地报出）。

### F3 全新 DSH home + 一次性任务时，首个请求的工具面里没有 engram 工具
`tools.json` 缓存为空时，插件的 engram 工具要等 MCP 连接完成才注册；headless 一次性任务在 boot 后立刻组第一个请求，于是首个 `request/header` 只有宿主自带工具（实测 25 项、`mcp__engram__*` 0 项），模型因此看不到 `mem_bridge_recall`。第二次运行（缓存已写入）即为 45 项 / 20 项。活宿主不受影响（人打字之前连接早已完成）。**不是本次变更引入的**，但验收脚本首次运行会踩到——`scripts/probe/run-model-integrity.sh` 的首次运行需先热一次。

### F4 归档必须带 `-y`
8.6 是**归档后**任务，归档时的完整性检查必然看到 1 条未完成，而交互式确认没有非交互出路（`openspec archive <name> -y`）。

## 活宿主补测（2026-09-15，真机模型目录）

- [x] 8.1 / 8.2 的**真机目录**版本（**不需要重启活宿主**）：把一个**新鲜宿主**直接指向真机模型目录、并让该目录保持被动过一字节 → 宿主**启动成功**（工具面 45 项，`mcp__engram__*` 20 项）；第一次检索返回 `Error: engram-bridge: 检索所需的运行时或模型不可用。模型目录 <真机目录> 不可用项：不符 分词器配置 tokenizer_config.json（…）：期望 sha256 e6f3b96d…（367 B）；实际 sha256 ab5cb362…（367 B）`；紧接着同一进程里 `bash` 返回 `host-alive`（宿主未退出、其它工具照常）；整轮 `exit=0`。还原那个字节后：`--check` `exit=0`，新鲜宿主检索正常返回命中。
- **F5 证伪了一条想当然的捷径**：先篡改、再删掉派生索引、然后指望「索引缺失 → 走 `rebuild()` → 在它的 spawn 前判定」——**不成立**。常驻 worker 早已把 `index.db` **打开**着（删文件对已打开的进程无效），引擎状态与**已通过判定的字节**都在它内存里，于是既不重建、也不判定，检索照样成功。这正是契约 2.7 的行为（热 worker 存在时，盘上文件的改动在契约上就是看不见的），不是判定失效。要让判定发生，必须让 worker 消失：冷启动，或等空闲回收（实测 600–660 s）。
