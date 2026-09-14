## 1. 范围与非目标（先落规则，再动代码）

- [x] 1.1 修订 `openspec/config.yaml` 的 `context`：非目标由「不做记忆系统本身（检索/向量/图谱/清理策略）」收窄为「不成为记忆的第二个真相来源」；同步"零运行时依赖（只用 Node 内置模块）"的表述。
  - 验证：`grep -n "不做记忆系统本身" openspec/config.yaml` 无输出；新句与 `AGENTS.md` 硬规则 7 不矛盾（人工比对两处）。
- [x] 1.2 核对 `AGENTS.md` 里与 `config.yaml` 重复的那句表述（硬规则 7 已在 `9f4095d` 改为分层），确保两处不再互相矛盾。
  - 结论：`AGENTS.md` 硬规则 7 已是"按危害分层"（宿主进程内不加载原生 addon / host 提供的 `@deepseek-ai/*` 优先 / 纯 JS+WASM 只在子进程内且需机制证明 / 大制品走显式安装），`config.yaml` 的 `context` 已改成同一分层表述。两处不再互相矛盾：都不再声称"零运行时依赖"，且都把"子进程内 + 精确锁版本 + 证明宿主入口未加载"作为允许第三方的条件。
  - 验证：人工比对 `AGENTS.md` 硬规则 7 与 `config.yaml` 的 `context` 各读一遍，结论记入本任务（此核对**不**用 grep，因为该段同时含大量仍需保留的表述）。
- [x] 1.3 写 `README.md` 的迁移说明与新安装步骤：`mem_search` 不再注册、新工具名、"用户侧文件不随插件分发"、**显式安装步骤**（模型 + 裁剪后运行时，合计约 110 MB）、以及"缓存缺失时在调用点失败而不是静默下载"。
  - 验证：README 含 `mem_bridge_recall` 与 `mem_search` 两个名字；含安装步骤与安装体积数字；含"给用户侧文件改什么"的指引但**不含**本机行号；`grep -n "静默\|下载" README.md` 能读到"不静默下载"的表述。
- [x] 1.4 核对仓库内不再把用户侧文件当成仓库文件（此前 design 与 tasks 各错标过一处）。
  - 结论：仓库里只剩两处带行号的引用（`~/.dsh/AGENTS.md`、`~/.dsh/skills/engram-memory/SKILL.md`，见 design D1 与第 9 组），两处都标明是用户侧；README 只说"去哪里改什么"，不含本机行号。`grep -c "mem_" AGENTS.md` 输出 **0**（本仓库的 `AGENTS.md` 不含任何工具名），这一事实已写在 design D1。
  - 验证：逐条把文档里出现的 `AGENTS.md` 行号引用与其**实际所属文件**核对一遍，确认全部指向 `~/.dsh/AGENTS.md`；`grep -c "mem_" AGENTS.md` 输出为 0，这一事实在文档里如实呈现（不要用会匹配自身验证文本的递归 grep 做这条检查）。

## 2. 索引：扩列、常量收敛、增量同步

- [x] 2.1 `docs` 表扩列 `title / content / type / project / scope`，与既有列同一事务写入；`algo_version` 递增。
  - 结果：`docs` 现为 11 列（新增 title/content/type/project/scope），`algo_version` = `bigram-live-v2`；单测对 `docs`/`terms`/`postings`/`vectors`/`meta` 五张表做"增量 ≡ 全量重建"逐行比对，全部相等。
  - 验证：单测（合成语料）断言增量后与全量重建的 `docs` 表逐行相等（含新列）；`sqlite3 <index> "PRAGMA table_info(docs)"` 列出全部新列。
- [x] 2.2 打分常量的**唯一作准处**：`k1` / `b` / `title_weight` / `evidence_weight` 存索引 `meta`（沿用既有键名 `scoring_*`），打分器从 meta 读取、代码内不重复声明。
  - 结果：四个常量只在 `src/recall/index-db.ts` 的 `SCORING` 声明一次；`scoringParamsFromMeta` 内**不含任何数值字面量**（连兜底默认值都没有，缺键即报"索引应重建"）。单测逐个改 meta 的四个键，词法排序每次都变。
  - 验证：单测改 meta 里四个常量**各一次**，断言排序结果随之变化（这条同时证明打分器确实读了它们，而不是只读 `k1`）；`grep -rn "TITLE_W\|EVID_W\|title_weight = \|evidence_weight = " src/` 在打分器里只出现从 meta 读出的变量，不出现字面量。
  - 注意：**不要**用 `0\.2` 之类模式做这条检查——`searchW` 的默认值 `0.20` 必须出现在 config schema 里（见 design D6），会被误命中。
- [x] 2.3 调用参数（`top_k` / `coverage` / `w`）只由 config 提供，不进 meta；引擎按调用解析。**返回条数上限（`limit`）不在此列**：它是工具输入，默认值写在该工具的输入 schema 里（10），config 不提供第二个默认。
  - 验证：单测改 config 的 `top_k` 后同一次查询的候选池规模随之变化，而索引文件不变（比对索引字节）；`grep -n "0.20" src/config.ts` 有一条 schema 默认值，且 `grep -rn "0.20" src/` 在打分器里没有第二处；`grep -n "limit" src/config.ts` 无输出。
- [x] 2.4 新鲜度判定：全量内容哈希与 `source_hash` 比对，不等则增量同步（照搬已验证形状，不加新闸门）。
  - 结果：单测覆盖新增 / 修改 / 删除各一次，均在下一次查询可见；撕裂的阳性对照改成**确定性**复现（两次独立读之间插入一次提交），不再依赖概率。一致性读用显式 `BEGIN`/`COMMIT`（`node:sqlite` 默认是 autocommit）。
  - 验证：单测覆盖新增 / 修改 / 删除三类变化各一次，均在下一次查询可见；并保留"无事务读"的阳性对照测试（它能复现撕裂，证明该判定有区分力）。
- [x] 2.5 计量：每次调用记录 `source_changed` / `rows_scanned` / `hash_ms` / `sync_ms` / `embed_docs` / `total_ms`，并聚合为周期性摘要行。
  - 结果：计量同时进读层的规范化值（`metering`）与子进程日志的滚动摘要（每 20 次或每 60 s 一行，含 `sourceChanged` / `rowsScanned` / `docsTouched` / `hashMs` / `syncMs` / `embedDocs` / `totalMs` 与当前语料规模）。
  - 验证：跑 N 次连续检索后日志里出现一条滚动摘要且数值非零；`grep` 确认计量同时进入读层的规范化值（而不仅是日志）。计量值的**当前**语料规模要一并记录，因为该成本随语料线性增长。
- [x] 2.6 崩溃安全与损坏自愈：进程中途被杀后索引可用、无残留标记；索引文件存在但不可读或损坏时由重建恢复（对应 spec 的「派生数据损坏」场景）。
  - 结果：子进程在 `BEGIN IMMEDIATE` + 写入进度标记 + 清空表之后被 SIGKILL；重开索引 `integrity_check` = ok、**无** `update_prefix` 残留、各表逐行等于更新前，随后一次增量同步正常完成。损坏索引（写入非数据库字节）走"要求重建"而不是报运行时缺失。
  - 验证：① 单测对子进程发 SIGKILL 后用同一索引再查一次成功，且 `PRAGMA integrity_check` 返回 `ok`；② 单测把索引文件截断/改字节后检索仍返回结果，且日志显示发生了重建；③ 该文件里原有的阳性对照测试（无事务读能复现撕裂）仍然通过。
- [x] 2.7 增量更新的原子性（对应 `engram-bridge-recall` 的「派生数据的更新是原子的」）：一次更新要么整体生效、要么整体不生效；批内某条嵌入失败时不得留下半应用的索引。
  - 结果：注入"批内第 2 条嵌入抛错"后索引逐行不变、无残留标记，下一次更新正常完成。嵌入发生在写事务**之前**，所以失败天然留不下半应用状态。
  - 验证：单测注入一次"批内第 N 条嵌入抛错"，断言索引内容与更新前逐行相等、且下一次更新能正常完成；`PRAGMA integrity_check` 仍为 `ok`。
- [x] 2.8 筛选与返回条数（对应 `engram-bridge-recall` 的「筛选与返回条数的先后关系」）：筛选在打分排序之后应用，被筛掉的条目不占返回名额，且触顶判定必须继续扫完剩余排序。
  - 结果：四条用例全部通过；第 ④ 条（被排除的条目排在已返回条目之前、但匹配项恰好 `limit` 条）判为**不提示截断**。这条同时暴露了本变更 spec 的一处自相矛盾，见文末「实现期发现」。
  - 验证：单测构造四条——① 一个不匹配的条目排在首位时，结果仍补足到要求的条数；② 触顶且仍有被排除的条目排在已返回条目之前时，结果说明还有未返回的；③ 触顶但被排除的条目都已排在已返回条目之后时，结果**不**报告短少；④ **恰好 `limit` 条匹配项且上限之后不再有任何匹配项时不提示截断**。第④条是唯一能逼出"触顶后继续扫完剩余排序"的用例——只按"被排除条目数 >0"实现的版本能通过①②③，会在④上暴露"分不清恰好够与还有更多"。

## 3. 嵌入运行时与子进程边界

- [x] 3.1 从 spike 提取可复用件（分词器、`[CLS]+510+[SEP]` 截断、Cc∪Cf∪Co 控制字符、CLS+L2 池化、批 32 上限）。
  - 验证：单测用固定样例断言分词输出与参考逐条相等（含触顶样例与含控制字符样例）。
- [x] 3.2 `onnxruntime-web` 精确锁版本；安装步骤把裁剪后的运行时与模型落到模型目录；缺失时在调用点抛明确错误。
  - 结果：`onnxruntime-web` 锁精确版本 `1.29.0`（package.json 无 `^`/`~`）；安装脚本落到模型目录后 `--check` 报"完整（109.8 MB）"，其中运行时 14.59 MB。
  - 验证：把模型目录指向空目录后检索返回明确错误且会话仍可用；`package.json` 中该依赖为精确版本（无 `^`/`~`）。
- [x] 3.3 边界机制：断言宿主入口的静态 import 闭包不包含嵌入运行时。
  - 结果：`scripts/check-recall-boundary.mjs` 走 `dist/index.js` 的静态 import 闭包（17 个模块），未触及 `onnxruntime-web`/`-common`/`-node`，也未触及 `embed.js`/`worker.js`；额外加一行 `import "./embed.js"` 或 `import "onnxruntime-web"` 都让它以 exit 1 失败（阴性对照已固定在单测里）。
  - 验证：一条自动化检查（测试或脚本）在"宿主入口 import 了该依赖"时失败；人为加一行 import 可复现该失败。
- [x] 3.4 线程数：配置键与运行时参数一一对应（配置 `embedThreads` ⇒ `ort.env.wasm.numThreads`），且显式设置、不吃 Node 默认值。
  - 结果：`ort.env.wasm.numThreads` 显式写入且等于配置值（单测用 stub 运行时把写入值读回来：配置 7 得到 7；Node 默认是 4）。
  - 验证：脚本读出实际生效线程数等于配置值（默认不是 4）；改配置后生效值随之变化。
- [x] 3.5 **config schema（硬规则 5）**：导出 `interface Config` + 同名 `Schema`，新键全部带默认值且**用 `search*` 前缀**（`searchEnabled` / `searchDbPath` / `searchIndexDir` / `searchModelDir` / `embedThreads` / `searchIdleMs` / `searchSweepIntervalMs` / `searchTimeoutMs` / `searchW` / `searchTopK` / `searchCoverage`）——**不要**用 `recall*`：`recallWakeup` 已存在且指压缩恢复，两者语义不相干。
  - 结果：11 个新键全部有默认值且类型正确；`Object.keys(config)` 里匹配 `/limit/i` 的键为 **0** 个，匹配 `/recall/i` 的只剩既有的 `recallWakeup`。
  - 验证：`test/config.test.ts` 断言每个新键都有默认值且类型正确；`grep -n "interface Config" -A 40 src/config.ts` 能逐一对应到 schema 的键；`grep -n "recall" src/config.ts` 只命中既有的 `recallWakeup`（属另一功能），不含本次新增的键。
- [x] 3.6 全量重建必须分批（批 32），不能单批全量。
  - 验证：单测断言批 32 与小批样本输出一致（位相等或最大差 < 1e-6），且超过批上限的请求被拆成多批。

## 4. 常驻进程生命周期

- [x] 4.1 懒启动：首次检索才建立；同一插件实例内复用；空闲超过配置时长后回收。
  - 结果：脚本断言"未检索时无子进程"、"连续两次检索只有一个进程"、"空闲超时后子进程消失且真的不在进程表里（`kill(pid, 0)` 失败）"。
  - 验证：脚本断言"未检索时无子进程"、"连续两次检索只有一个进程"、"空闲超时后子进程消失"。
- [x] 4.2 回收由插件定时器自主驱动，且卸载时清理（含在途调用不被误回收）。
  - 验证：接线测试断言卸载后无残留子进程；在途调用期间的空闲回收不关闭该进程。
- [x] 4.3 回收使用**独立的配置键**（不复用 engram 连接池的 `poolMaxIdleMs` / `poolSweepIntervalMs`）。
  - 结果：`searchIdleMs` / `searchSweepIntervalMs` 与 `poolMaxIdleMs` / `poolSweepIntervalMs` 互不影响（单测用未来时间戳驱动 `sweep(now)`，两者各自独立）。
  - 验证：单测断言两个键互不影响——改连接池的空闲值不改变嵌入进程的回收时机，反之亦然。

## 5. 工具面：读层结果形状与注册

- [x] 5.1 `src/recall-tool.ts`：读层自己的规范化值 + `output.schema` + render（含截断行与"类型不存在时给出实际取值"）。
  - 验证：单测喂入构造结果，断言字段齐全；渲染文本在有未显示项时出现截断提示、**恰好达到上限时**不出现；断言"共 N 条候选"这类措辞不出现。渲染只测构造结果不足以判定第 2.8 条，故触顶判定由 2.8 的单测负责，本条只测措辞。
- [x] 5.2 输入 schema：单串 `query`、`limit`（默认 10，**落在本工具的 schema 里**）、`project`、`all_projects`、`type`、`scope`、`match_mode`（忽略并在描述写明）；`since`/`until` 不出现。
  - 验证：单测断言 `project` 键存在（注入的前提）、`since`/`until` 不存在、`limit` 的 schema 默认值为 10；描述文本含 `match_mode` 已忽略的说明。
- [x] 5.3 注册与不注册：`mem_search` 加入 `UNREGISTERED_ENGRAM_TOOLS`（精确名匹配）；读层工具在 engram 工具面注册时一并注册，卸载时干净移除。
  - 结果：单测断言注册名含 `mcp__engram__mem_bridge_recall`、不含 `mcp__engram__mem_search`；注册面 = 声明面 − 刻意不注册 + 1（stub 语料 7−3+1 = 5）。**绝对计数 20 留给活宿主验收**（真实 engram 声明 22 个）。
  - 验证：单测断言注册名集合含 `mcp__engram__mem_bridge_recall`、不含 `mcp__engram__mem_search`；带 `mcp__engram__` 前缀的注册名**计数为 20**（19 来自 engram 声明 + 1 插件自有）；卸载后注册表无残留。
- [x] 5.4 子 agent 遮蔽对新工具同样成立（两层：不出现在清单里 + 即使被调用也被拒绝）。
  - 验证：单测断言子 agent 的可见工具清单不含 `mem_bridge_recall`，且它已进入 `registeredNames`；再断言一次**对该工具的调用**被子 agent 侧的守卫以明确原因拒绝（现有实现按 `mcp__engram__` 前缀拒绝，见 `src/subagent.ts`）。
- [x] 5.5 引擎开关：配置门在**调用点**拒绝（明确原因、不静默改实现、不使会话失败）。
  - 验证：单测断言开关关闭时调用返回明确错误且未触发任何检索工作。
- [x] 5.6 **实测开关是否需要重启宿主生效**，并按实测结果修正 spec 中该条要求的措辞。
  - 验证：在活宿主上改开关（不改工具声明集合），观察下一次检索是否立刻按新值行为；把结论写回 `specs/engram-bridge-recall/spec.md` 的同一条要求与 `design.md` 的迁移计划第 5 条。**若发现需要重启，如实写明，不要为了保住原措辞而软化结论。**
  - 结果：**不需要重启宿主，改动即时生效。** 在 `~/.dsh/cordis.patch.yml` 的 `engram-bridge` 条目下临时加 `searchEnabled: false`，紧接着的调用被以 `检索能力已关闭（searchEnabled=false）` 拒绝；删掉那一行后检索立刻恢复。宿主进程（pid 省略，启动 <时刻>）**全程未变**。
  - 机制（观测）：两次改动各让 `apply()` 重跑一次——`tools.json` 只在 discovery 里被写，其 mtime 是 **<时刻>**（加那行）与 **<时刻>**（删那行）。所以宿主走的是"配置变更 → 重建插件条目"。
  - 已写回：`specs/engram-bridge-recall/spec.md` 那条要求改成"改动该开关后紧接着的调用 SHALL 按新值行为；宿主进程本身 SHALL NOT 需要重启"，并加了一个对应场景；`design.md` 的迁移计划第 5 条改成实测结论。
  - **未确定（如实标注）**：重建时宿主是"注销旧注册再接受新注册"还是"保留旧注册、而旧闭包读到被就地改写的配置对象"。两者本轮可观察行为一致，区分需要读宿主日志或注入探针，没做。design 里那条"宿主没有注销路径"的**理由**因此被削弱（**结论**仍成立），已在 design 的风险条目下补注。
- [x] 5.7 注入接线：自有工具按自身 schema 接受项目注入，显式传值优先。
  - 验证：单测断言未传 `project` 时注入会话项目；显式传值不被改写；未声明该键的工具不被注入。
- [x] 5.8 **与 `injectSessionProject` 关闭时的交叉语义**：该开关关闭时不注入 `project`，则"默认只返回当前项目"无从判定。按 `design.md` 的 D3，实现 **SHALL 拒绝检索并说明原因**（给出"显式传 `project`"或"打开注入"两条出路），**SHALL NOT** 以未限定项目运行——那是 D3 明确否决的替代（会让默认隔离在这个配置下静默失效）。
  - 结果：`injectSessionProject=false` 且未显式传 `project` 时调用被拒绝，错误文本同时给出"显式传 project"与"打开注入 / 传 all_projects"两条出路，且**没有发生任何检索**（连派生索引目录都没被创建）。
  - 验证：单测覆盖"`injectSessionProject=false` 且调用未传 `project`"这一组合，断言调用被**拒绝**、错误文本同时提到两条出路，且**没有**发生跨项目检索。

## 6. 仓库侧测试与门禁

- [x] 6.1 单测全部用**合成语料**，不得引入真实语料或二进制夹具；并补项目过滤语义的单测。
  - 验证：`pnpm test` 通过；`git status --short` 无新增未跟踪夹具；单测文件里含"只返回当前项目的条目"与"跨项目开关打开后可见其他项目"两项断言。
- [x] 6.2 类型检查与构建、门禁全绿。
  - 结果：`pnpm typecheck` / `pnpm test` / `pnpm build` 全绿（138 个用例：134 通过 / 4 跳过 / 0 失败；跳过的 4 个是既有的真实 engram `live-wiring` 用例）；`node scripts/check-hygiene.mjs --history`：全部历史 190 个文件，无密钥 / 本机路径 / 个人邮箱 / 禁止路径。
  - 验证：`pnpm typecheck && pnpm test && pnpm build` 通过；`node scripts/check-hygiene.mjs --history` 通过（若 `pnpm check:hygiene` 因沙箱无法建临时安装目录，则以该 node 调用替代并在报告中注明）。

## 7. 验收（仓库外，对冻结语料）

> 本组的脚本与语料在**仓库外**（一个本机的临时工作目录），下面的路径以 `~` 起头——**不写成绝对路径**，因为仓库的 hygiene 门禁禁止把本机 home 目录写进仓库（会误伤真实路径，也会泄漏机器布局），而相对仓库根的 `ops/...` 又解析不到。`~` 在这里是无歧义的：本组只在发起这台机器上跑。

- [x] 7.1 **词法表逐行比对**（主要判据）：把实现指向冻结语料重建索引，与参考索引的 `docs` / `terms` / `postings` 逐行比对。
  - 结果：`docs` 346 / `terms` 28181 / `postings` 79157 **三表逐行相等**；参考的 12 个可比 meta 键全等（`algo_version` 为有意递增）；新增列 346 行与正本逐字节相等、不符 0；`source_hash` 与参考一致 `a3fa6aaa…`；向量 346 × 512。物证 `ops/readlayer-eng/accept/work/acceptance.json`。
  - 验证：与参考实现建出的索引比对——除新增列外，`docs` / `terms` / `postings` 三张表逐行相等（参考侧规模为 346 文档 / 28181 词项 / 79157 posting，见 仓库外 `readlayer-eng/REPORT.md` 的 V5）；新增列（title/content/type/project/scope）与正本逐字节相等。
- [x] 7.2 逻辑指纹作为**辅助**判据：同一内容跨实现相等。
  - 结果：三个独立构建（7.1 的一次性全量、7.2 的一次性全量、"先少 40 行再增量同步"）指纹相同 `1f8893806502d2e2`；增量那一步 `docsTouched=37` / `embedDocs=37`。
  - 验证：用 `<spike>/logical_digest.py` 比对两个独立构建，指纹相同；**不**把"等于旧值"当判据（扩列后必然改变）。
- [x] 7.3 排序一致：668 条冻结查询与参考排名比对。
  - 结果：668 条查询 depth 10 / 20 / 23 各 **668/668** 完全一致；depth 24 差异 **1** 条（qi=566 第 24 位 ours=523 ref=236），与已记录的 float32 累加顺序边界一致；候选池规模 668/668 一致；单条嵌入 vs 批量 32 最大分量差 **0**（所以批量测量不影响结论）。
  - 验证：depth 10 / 20 / 23 各 668/668 完全一致；depth 24 允许 1 条差异并注明是已知边界；报告实际使用的 float32 累加顺序。
- [x] 7.4 检索质量：两个冻结代理（322 + 346）上的 R@10 / MRR，以及**载荷重测**。
  - 结果：P2 R@10 **0.7764** / MRR **0.6453**，P3 R@10 **0.9538** / MRR **0.8923**，与 design 表「软加权（默认）」一行逐位相同。载荷（limit 10、668 条）：渲染文本均值 **3,163.3 字符**（中位 3,161），嵌入分词器均值 **1,804.5 token**（中位 1,816）——design D3 的估算 2,740 字符 / 1,712 token 偏低（字符低约 13%），D3 里那个无出处的转述值依然没有被独立复现。
  - 验证：R@10 不低于 design 中"软加权（默认）"那一行的量级（P2 0.7764 / P3 0.9538）；并给出新渲染形状下每次检索的实际字符/词元读数，替代 design 里那个无出处的转述值。
- [x] 7.5 内存判据（跨平台，唯一可能翻盘的量）。
  - 结果：1 线程——就绪 **505 MB**、稳态（500 次查询后）**514 MB RSS**、全量重索引峰值 622 MB HWM；判据「稳态 ≤ 600 MB」**通过**。物证 `accept/work/mem-profile-1thread.txt`。Mac/arm64 仍未测。
  - 验证：在目标机器上跑 `<spike>/wasmspike/mem_profile.ts`，1 线程稳态 **≤ 600 MB**；超过则记录并回到 design 的 D4 重评线程档与路线。

## 8. 活宿主行为验收（必须重新加载插件后）

- [x] 8.1 插件重新加载后工具面正确。
  - 验证：`~/.dsh/storages/engram-bridge/tools.json` **保留 engram 的 22 个原始声明**（含 `mem_search`，**不含** `mem_bridge_recall`——插件自有工具不是 engram 声明），而**会话日志里该回合的工具清单**不含 `mem_search`、含 `mem_bridge_recall`，且带 `mcp__engram__` 前缀的工具数为 20；直接调用 `mem_search` 得到未知工具错误。
  - 结果（活宿主，重启后）：会话日志的三个 `request/header` 事件里，`data.header.tools` 的 `mcp__engram__*` 名字数 **20 → 20 → 20**；前两个（重启前 seq 12 / 1391）含 `mcp__engram__mem_search`、不含 `mem_bridge_recall`，第三个（重启后 seq 2733）**含 `mcp__engram__mem_bridge_recall`、不含 `mcp__engram__mem_search`**。直接调用旧名得到 `Error: unknown tool "mcp__engram__mem_search"`。
  - 注意（会误判的检查法）：该事件里仍能 `grep` 到 `mem_search` 字样，但只在**别的工具 description 的散文里**（`mem_compare` 的参数说明写着 "from mem_search or mem_get_observation"）——那是 engram 声明的原文，规格要求原样透传。判据必须比对**名字列表**。
  - tools.json 的实况见 F2：`declaredByEngram=22`、`declaredIncludesSearch=true`、`declaredIncludesRecall=false`（缓存是 engram 的原始声明，不含插件自有工具）。
- [x] 8.2 默认项目隔离与范围语义。
  - 结果：在项目 `dsh-plugin-gentleai-engram` 的工作区不指定项目检索时，结果只含该项目（`filteredOut>0`）；显式 `all_projects` 时其它项目的条目也出现。范围：省略 `scope` 时两种范围都可以出现；`scope: personal` + `all_projects` 返回的条目**全部**是 personal 范围——与契约一致（省略时两种范围**都可以**出现，而不是保证同时出现）。「注入被关闭时按 D3 拒绝」由单测与接线测试覆盖。物证 `accept/work/live-surface.json`。
  - 验证：在项目 A 工作区不指定项目检索，结果无其他项目条目；省略范围时两种范围都**可以**出现（既不保证同时出现，也不因范围本身被整体排除）；显式指定范围时只出现该范围；项目注入被关闭时按 design D3 的决定被拒绝并说明原因。
- [x] 8.3 截断可见与提高条数。
  - 结果：`limit 1` → 1 条且说明还有未显示的；`limit 5` → 5 条，原先未显示的 id（567/568/569/363）出现。
  - 验证：先小 `limit` 检索看到截断提示，再提高 `limit` 后见到新条目。
- [x] 8.4 内容变化可见且非全量重建。
  - 结果（隔离，物证 `accept/work/incremental-visibility.json`）：对**正本副本**写入一条观察后，紧接着的检索里它排在第 1（`visible=true`），`mode=incremental`、`sourceChanged=true`、`embedDocs=1`、**没有发生全量重建**，再下一次是 `noop`。
  - 结果（活宿主，走正规写入路径）：`mem_save` 落一条之后**紧接着**的 `mem_bridge_recall` 就把它作为第 1 条返回（得分 0.8678）。索引侧：`doc_count` 前进、`vectors` 同步、`source_hash` 前进、`update_prefix` 无残留；耗时是亚秒级（全量重建要 ~13 s，未发生）。
  - 一处容易误读的观测：主文件 `index.db` 的 mtime/大小**没变**（仍是 21:43 / 4,939,776 B），因为索引是 WAL 模式，增量落在 `index.db-wal`（0 → 1.27 MB，mtime 21:44）。**别用主文件 mtime 判断有没有更新**，要看 `meta.doc_count` / `source_hash`。
  - 插件的规范化值（含 `metering.mode` / `sourceChanged`）**不进会话日志**：日志里的 `tool/result` 存的是渲染文本（模型可见的那部分，硬规则 6 成立）。所以"日志显示 source_changed"这一句只能从插件自己的日志读；本轮从模型侧读不到宿主终端的输出。
  - 验证：写入一条新观察后紧接着检索能看到它；日志显示 `source_changed=true` 且未发生全量重建。
- [x] 8.5 开关行为（与 5.6 同一实测的活宿主确认）。
  - 验证：关闭开关后检索调用以明确原因被拒绝、会话继续；开关恢复后检索恢复。
  - 结果：关闭后调用返回 `Error: engram-bridge: 检索能力已关闭（searchEnabled=false）。本次调用没有执行任何检索，也不会静默改用别的检索实现。`——**会话继续**（后续调用与其它工具照常）；恢复后同一查询正常返回结果。配置文件已按 sha256 校验恢复原样（`38816afe…`，与备份逐字节一致）。

## 9. 文档与用户侧同步

- [x] 9.1 更新本机两份**用户侧**文件里的 9 处工具名（两份文件**内容不同**，不能套用同一份 diff）：`~/.dsh/skills/engram-memory/SKILL.md` 第 8 / 60 / 76 / 77 / 82 行，`~/.dsh/AGENTS.md` 第 26 / 37 / 38 / 43 行。同时把 SKILL.md 第 60 行的"FTS5 全文检索"改为事实表述，并补上"省略范围时两种范围都可以出现"。
  - 结果：两份用户侧文件各 4 / 5 处、合计 **9 行 / 9 次** 工具名已改完，`grep -c "mem_search"` 两份都是 **0**；SKILL.md 的"FTS5 全文检索"改成事实表述（本地只读派生索引：bigram 词法覆盖 + 语义向量），并补了"省略 scope 时两种范围都可以出现"；第 86 行的"BM25 over FTS5"（engram 自己的冲突扫描）**保留**。备份在本仓库的 `.pnpm-store/tmp/*.user-side.bak`（未入库）。
  - 验证：`grep -c "mem_search" ~/.dsh/AGENTS.md` 与 `grep -c "mem_search" ~/.dsh/skills/engram-memory/SKILL.md` 均为 0，合计 **9 行 / 9 次**（不是 11 次）；`grep -n "FTS5 全文检索" ~/.dsh/skills/engram-memory/SKILL.md` 无输出——**但不要**用裸 `grep -n "FTS5"`：SKILL.md 第 86 行的"BM25 over FTS5"是对 engram 冲突扫描的真实描述，必须保留。
- [x] 9.2 在本次变更的 `proposal.md` 或 `design.md` 记录最终验收读数（词法逐行比对、指纹、rank、代理论量、载荷重测、内存）。
  - 结果：读数写入 `design.md` 的「验收读数（实现后实测）」一节（六项齐全，含每项的达成与否、物证路径与未验项）。
  - 验证：文件里能读到上述六项的具体读数与达成情况。

## 实现期发现（需要改动规划材料，尚未改）

### F2 **tasks 8.1 的措辞错**（不计为任务，已修）
`tools.json` 缓存的是 **engram 的原始声明**（22 个，仍含 `mem_search`），插件自有工具不是 engram 声明，**不应该**出现在里面。8.1 原先要求"`tools.json` 的声明里含 `mem_bridge_recall`"。实测：`declaredByEngram=22`、`declaredIncludesSearch=true`、`declaredIncludesRecall=false`。正确的两句是：*缓存保留 engram 的 22 个原始声明（仍含 `mem_search`）；注册面 20 个里有 `mem_bridge_recall`、没有 `mem_search`。* 8.1 已于活宿主重启后勾选（见该条「结果」），其验证句里的那句错措辞已按本条修正。

### F1 **spec 自相矛盾**（不计为任务，已修）
`specs/engram-bridge-recall/spec.md` 的「筛选与返回条数的先后关系」末段把截断提示的触发条件写成了"是否有被筛选排除的条目排在已返回的条目之前"（记作 `F_before`），而「截断对模型可见」、同条场景「没有更多可返回时不报告短少」、以及本文件第 2.8 条用例 ④ 都把触发条件写成"上限之后是否仍存在匹配项"（记作 `M_after`）。两种判据在**两个方向**上都给出相反答案：

- **方向 i**（`F_before ∧ ¬M_after`）：一个被筛掉的条目排在首位、而匹配项恰好 `limit` 条 → 前者要提示，后者不要。例：语料 `#1(B,0.99) / #2(A,0.9) / #3(A,0.8) / #4(A,0.7)`，筛选 `type=A`、`limit=3`，返回 `#2/#3/#4`。
- **方向 ii**（`¬F_before ∧ M_after`）：**无任何筛选**、匹配项多于上限——这是常规路径 → 末段"仅当被筛掉且排在之前的条目一条都不剩时才 SHALL NOT 报告"推出"不报告"，后者要求报告。活证据：`test/recall-engine.test.ts:178-189` 在**零筛选条目**的语料上断言 `truncated === true`，即一个早已通过的测试直接与该句冲突。

`F_before` 对"该不该报告截断"这个问题**不携带任何信息**：四种组合里两格空转（与正判据结论相同）、两格把答案改成错的，**没有一格因它而变对**。因此实现取 `M_after`（截断 ⇔ 上限之后仍有匹配项）——这也是唯一能让渲染行"提高 limit 可以看到更多"（`src/recall-tool.ts:126`）成为可兑现承诺的判据；取 `F_before` 会让提示指向**提高上限也取不回来**的条目。

  - **处置（已完成，2026-09-14，走 `openspec-update-change`）**：删掉末段那两句，改为"结果是否被截断 SHALL 只由「上限之后是否仍存在匹配项」决定"，并补入反向不变量"被筛选排除的条目 SHALL NOT 触发截断提示"；场景「筛选造成的短少被说明」改写为「被筛掉的条目不触发截断提示」（旧规则的取反）。判据只剩 `M_after`。
  - **对代码零影响**：实现与现有测试本来就站在 `M_after` 一侧，本次只把 spec 对齐到已实现并通过的行为，因此不需要 `openspec-apply-change`。
