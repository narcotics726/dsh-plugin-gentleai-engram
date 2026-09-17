# 设计：托管落地、两处覆盖缺口的判定、以及比对纪律

## Context

`engram-protocol-hosting`（已归档）把 engram 的协议文本从"两台机器上的手抄件"改成**随包资产**：常驻触发段（系统提示词）＋ 按需加载的流程技能，由 `src/protocol.ts` 在 `apply()` 里读取、缺失即抛。它在**一台**机器上完成了落地（含删手抄件），另一台机器只留下一条未完成任务。

本机就是那台没落地的机器，四件事都还没做：两个新开发依赖只在提交里声明、没安装（因此本机 `pnpm typecheck` 跑不过）；`dist/` 里没有协议承载；`~/.dsh/AGENTS.md` 的 engram 段与 `~/.dsh/skills/engram-memory/SKILL.md` 仍是手抄件，也是当前模型所见的唯一来源。

落地前逐条对读了两份文本，发现托管文本相对手抄件少了两处覆盖。本设计记录这两处的判定与理由。

## D1 两处覆盖缺口，判定为有意不补

### 1. 压缩后的手动兜底

- 手抄件有 `AFTER COMPACTION OR CONTEXT RESET`：看到压缩消息就立即 `mem_session_summary` 存压缩前工作 → `mem_context` 恢复 → 再继续。
- 托管文本没有这一节：流程技能只有「会话收尾」，常驻段只有 **记 / 查 / 收尾** 三个触发。
- 本机为什么在意：本机 patch 把 `compactionRecovery` 设成 `false`（插件默认 `true`），而同一个开关同时门禁写入端与召回端；那份 patch 的注释原文写着"手动召回由 `~/.dsh/AGENTS.md` 协议兜底"。迁移之后，两边都不做这件事。
- **判定：不补。** 理由三条：
  1. 开关打开时插件自己做——文本再写一遍等于给同一行为两个所有者，而契约里"关闭即不写不注入"会变成半开。
  2. 关闭是本机的有意选择，判据已经在 patch 注释里：宿主压缩本身自足（选材 → 一次摘要调用 → 老区间 shadowed → 摘要重新注入，全程不依赖 engram）；`onSummary()` 落的那条与宿主 summary 字符串全等、信息增量 0；`onEnd()` 的召回报文约 7 个槽、第 1 槽恒为刚写的摘要，而读侧是 recency-only + 不分词 CJK，结构上不可能浮出"久远但相关"的记忆。
  3. 唯一净损失是跨机器 / 跨 agent 的摘要可见性，已由别的方式承担。
- **代价照实记**：从此"压缩后 engram 里没有这次摘要"是**预期行为**，看到它不要当缺陷。
- **落点**：写进 `engram-compaction-recovery` 的「压缩恢复开关」（关闭即完全关闭 + 一份文本不兜底的场景），让这个行为只有一个所有者。

### 2. 连显式追赶也放不下时的 `/engram-sync` 转交

- 手抄件有第三步：若显式追赶自己的错误说"连一次显式追赶也放不下"，它会点出操作者命令 `/engram-sync`——转告用户并停止重试。
- 托管技能第 5 节只写：索引积压时用 `mem_bridge_recall_sync` 追索引（可能数分钟，先告诉用户要等，完成后重发原检索），"细则见该工具自身描述"。
- **判定：不补**，但性质与上一条不同——这不是放弃覆盖，而是**把信息留在需要它的那一刻**：拒绝文案本身会点出 `/engram-sync`（`engram-bridge-recall` 的契约已要求"连显式入口也放不下时指出操作者命令"），模型在使用该工具时必然看得到；把三步复述进技能，只是同一契约的第二份副本。
- **落点**：design（文本内容决定，不是契约）。

## D2 被否的路：用户侧提示词的指纹基线 + 机械检查

本变更前曾做过一版相反方向的尝试，值得留档：它是本仓库第一次记录"**逐字断言为什么不够**"。

- 方案：把"本插件强加的要求"写成逐字句断言与禁止说法表，对 `$DSH_HOME/AGENTS.md` 与 `$DSH_HOME/skills/engram-memory/SKILL.md` 跑检查；另建"上次重推导"的指纹基线（节标题与节正文各一个 sha256 前缀，基线只存指纹）。
- **两个实测反例**（都在原稿里跑过）：
  1. 给流程技能加一节「被拒就重试，第二次通常成功」→ 契约句**逐字全在**，逐字断言**通过**——而这是最该报警的一条（它直接推翻拒绝契约）。
  2. 只把 `### If a recall refuses (backlog)` 改名 → 要求其实仍成立，断言**失败**。
  即：**危险的变化被放过，无害的变化被报警。**
- 更根本的两条：
  - **判据会腐，而机械部分无法知道**。当依据是 patch 里的配置键时（`compactionRecovery`、`capturePassive`），键改回去、句子一个字没动、要求已经失效。
  - **"该补一段"问不出来**。插件新增一个模型可见行为，用户侧就该多一段——本次托管变更本身就是例子；检查器只能检查上次想到的东西。
- 被取代的直接原因：文本进仓库后，变更追踪由 git 承担，指纹基线是**第二套真相**。
- 保留下来的判断：机械部分能可靠回答的只有"**变了没有**"（节内容变了 / 改名搬家 / 新增 / 删除、上游修订是否移动），"**还对不对**"必须由重推导（人 / LLM）回答。

## D3 上游血缘与比对纪律（基线必须钉在"在用的版本"）

- **上游有两个**：
  - **A** ＝ [engram](https://github.com/Gentleman-Programming/engram) 自身：协议文本是文件（`plugin/claude-code/skills/memory/SKILL.md`、`plugin/codex/skills/memory/SKILL.md`），MCP 层指令由 `internal/mcp/mcp.go` 的 `buildServerInstructions()` 生成。
  - **B** ＝ npm `gentle-engram`（pi 插件）：协议以 persona 在运行时注入，**没有文件形态**。
- 托管前的本机手抄件是两者的**混血**：与 A 的 claude-code 版都是 129 行、**63 行不同**，而 `scope` 等细节取自 B。
- 取回方式（隔离 HOME，不碰本机 agent 配置与 engram 数据）：`HOME=<probe-home> engram setup claude-code` 把整仓（含 Go 源码）克隆进 `<probe-home>/.claude/plugins/marketplaces/engram/`；`engram setup pi` 拉 B。
- **纪律：结论只能对着"在用的版本"下。** 反面例子就是下一节的 `scope`：拿上游 HEAD 当基线会得出"我们的文本漂移了"这个**错误**结论。

## D4 `scope` 的核对结果

- 事实：在用的 engram **1.20.0** 自己的说明是两档（`Filter by scope: project (default) or personal`、`New scope: project or personal`），二进制里**没有** `or global` 这个串；三档（`project, personal, or global`）出现在**上游 main** 的 tool schema 里。CLI 对 `--scope` 不做取值校验（`--scope bogus` 也照存）。
- 结论：协议文本写两档**与在用版本一致**，不是漂移。升级 engram 后按升级清单复测；若已支持 `global`，再决定是否写进文本。

## Migration Plan（tasks 的组序按此排）

1. **依赖与构建**：装两个新 devDependency（`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-system-prompt`，均**仅类型**用途）→ typecheck / test / build / boundary / hygiene。
2. **装到 profile 并重启**：`dsh plugin --profile <p> add <repo>`；`--dump-config` 恰好一行；重启后插件从 `dist/` 载入协议资产。
3. **探针验证模型所见**（删除前）：`PROBE_WITH_BRIDGE=1` 把本插件挂进 throwaway profile（后端指向仓库 stub，不写真库），断言常驻段在主会话出现恰好一次、子 agent 0 次、技能 `source` 为 `runtime`；记下常驻段与技能正文的指纹。
4. **删手抄件并复验**（必须在第 3 组通过之后）：删 `~/.dsh/AGENTS.md` 的 engram 段与 `~/.dsh/skills/engram-memory/`，复跑第 3 组，读数与删除前逐字节一致。
5. **文档**：升级清单加一条 `scope` 复测口径。

顺序不能反（第 4 组不得提前到第 3 组之前）：手抄件曾是模型所见的**唯一**来源，先删会有一段窗口里模型看不到任何 engram 义务。

## 已知未知与回滚

- **删手抄件后没有第二来源**：插件加载失败（资产缺失会在 `apply()` 抛）时，模型完全看不到义务文本。这是托管变更的既定取舍，此处只记回滚：从归档的 tasks 与其提交取回文本、恢复手抄件，且**先停插件再放回**——同名技能同时存在时插件自带的那份按层内次序胜出，宿主只留一条 warn。
- **上游 B 没有文件形态**，无法逐字 diff，只能读它注入的 persona 文本；对本变更无影响（文本已是我们自己的）。
- **`global` 一旦可用**：`scope` 是否写第三档，等升级后实测再定；本变更只记口径。
- **归档里的路径与另一台机器不一致**：归档 tasks 写 `~/.agents/skills/engram-memory/`，本机的手抄件技能在 `~/.dsh/skills/engram-memory/`。两处都要删，且删除后要确认同名冲突的 warn 消失——否则留下的那份是旧副本，正是这次要消灭的漂移。

## 实测读数（本机）

**探针 run（throwaway home，从未放过任何手抄件）**——这是「义务的告知随插件分发」那条需求的直接判据：

- 渲染出的 `system/message` 里常驻段出现 **1 次**，且与 `protocol/resident.md` **逐字相同**：193 字符、`sha256` 前 12 位 `c9925c6518c0`（从正文截出的片段再哈希也一致）。
- 拼接后的正文 4810 字符（6 个字符串块），探针记录的 `textChars = 4723`；托管变更 design 记的是 4727——**差 4，来源未判定**，照实并列。
- 技能目录消息（4143 字符）含 `engram-memory`，描述取自资产（117 字符），因此这条是插件自带的 runtime 技能，而不是任何机器上的文件。

**构建与依赖**：`@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-system-prompt` 均 `0.1.2-rc.1` 已装；`tsc -p tsconfig.json` 退出码 0（`pnpm typecheck` 的等价执行），`dist/protocol.js` 产出且 `engram:protocol` 在其中。

**门禁**：套件 204 用例 / 200 过 / 0 败 / 4 跳过；`check:boundary` 宿主入口闭包 21 个模块；`check:hygiene` 全历史 334 个文件；`npm pack --dry-run` 清单含 `protocol/resident.md`、`protocol/engram-memory.skill.md`、`dist/protocol.js`。

**注入文本指纹（删手抄件前后比对用）**：常驻段正文 `sha256` 前 12 位 `c9925c6518c0`（193 字符）；技能正文 `2cba3a42909b`（2882 字符）；技能描述 `1d7a76f7b969`（117 字符）。

## 落地读数（真实 home）

- **重启前后的差别只有模型所见能区分**：会话日志里 `system/message` 由 1 条（6969 字符，不含常驻段）变为 2 条，第 2 条 7164 字符、含常驻段逐字、标记 1 次。前一次"已装已重启"不算数，是因为当时 `dist/` 还是旧的（`dist/protocol.js` 不存在），而软链与配置都看不出差别——这就是任务 2.2 的判据写成"真实 home 新渲染出含常驻段的 `system/message`"的原因。
- **删除手抄件**：`~/.dsh/AGENTS.md` 移除 5690 字符、保留 219 字符（engram 段与那句已失真的 H1 一并去掉，其余两节原样）；`~/.dsh/skills/engram-memory/` 删除。删前把整份原文与技能正文备份到 `~/.dsh/.engram-protocol-backup/`（本机路径，不入库）。
- **删除后**：技能目录由旧的手抄件英文描述切换为资产描述；常驻段指纹仍为 `c9925c6518c0`，与删除前记录相同。
- **加载侧**：`--dump-config | grep engram-bridge` 在 web 与 headless 各恰好 1 行。

## 修正：同名技能共存时，文件技能压住插件自带的 runtime 技能

托管变更的 proposal 写"同名时插件自带的那份按层内次序胜出，宿主日志里只会留一条 warn"。**本机实测与此相反**：真实 home 里两份同时存在时，技能目录给出的是 `~/.dsh/skills/engram-memory/SKILL.md` 的描述（旧英文那份），插件注册的 runtime 技能**不出现**；删掉文件后目录才切换为插件那份。

- **影响**：「删掉使用者机器上的手抄件」不是清理，而是**托管文本真正生效的前提**——在那之前模型拿到的仍是旧流程。托管变更的 tasks 5.1–5.3 因此不是可选项。
- **处置**：归档变更不回写，所以修正记在这里；升级清单新增第 8 条，换 dsh 版本后按"同时放两份、看目录给谁"复测该次序。
- **未解**：宿主侧那条 warn 的落点未知（本机找不到日志文件），所以这条以"技能目录只剩一份"为判据，不以 warn 为准。

## 如实标注的验证口径

- **子 agent 拿空段**（任务 3.2）：单测口径（main / subagent / agent 缺失三种输入），本次探针未派子 agent。
- **停用后不再出现**（任务 6.2 后半）：沿用托管变更在另一台机器的实测，本机不为此改 profile 配置。
- **宿主侧 warn**（任务 4.3 后半）：落点未知，见上一节。
