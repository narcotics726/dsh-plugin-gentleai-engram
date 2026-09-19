## Context

动机见 `proposal.md`。影响做法的现状：

- 文本今天在两处用户文件里：`~/.dsh/AGENTS.md`（962 B，其中 engram 一行）与 `~/.agents/skills/engram-memory/SKILL.md`（4806 B，v2）。插件版本与它们之间没有任何约束。
- 那行文本由 `dsh-agent-instructions` 作为**一条 durable instructions 消息**发出（原文：one durable baseline message with the user-global `$DSH_HOME/AGENTS.md` followed by the project chain），**不是**系统提示词段。所以这次改动同时换了通道。
- 宿主给的两个注册点：`ctx.systemPrompt.section()`（系统提示词段）与 `ctx.skills`（技能注册表）。两者都由 `dsh-base` 全局挂载（其 `cordis.patch.yml` 里有 `system-prompt` / `skill` / `skill-filesystem` / `tool-skill` 四行）。
- 既有约束被本变更推翻：`openspec/config.yaml` 的 context 写着「P0 不新增 system prompt 段（KV cache）」，`README.md`「模型看到什么」一节写着「**提示词**：不新增 system prompt 段」。两处都要一起改。
- 工具面已对子 agent 遮蔽（`guardEngramTools` / `shadowEngramTools`）。

### 版本事实（做法的直接依据）

仓库 devDeps 钉的是 `dsh-system-prompt@0.1.2-rc.1`（由 `dsh-agent` 传递进 `node_modules/.pnpm`），本机在跑的是 `0.1.5-rc.1`。两者的 `SECTION_ORDERS` 不同：

| | 0.1.2-rc.1 | 0.1.5-rc.1 |
|---|---|---|
| persona | `DEPLOYMENT_PERSONA: 0` | `DEPLOYMENT_PERSONA_PREFIX: 0` + `_SUFFIX: 10200` |
| 环境后缀 | `HARNESS_SOURCE: -900` / `WEB_SURFACE: -800` | `10000` / `10100` |
| 导出常量 | `PERSONA_SECTION = "deployment:persona"` | `PERSONA_PREFIX_SECTION = "deployment:persona-prefix"` |

**同一代换代还删掉了请求头里的系统提示词字段。** `dsh-session@0.1.5-rc.1` 的 `EpochHeader` 只剩 `config` / `adapterDefaults` / `tools`（`lib/types/types.d.ts:208-215`），0.1.2 才带 `system?: string`（同文件 :201-210）。`dsh-system-prompt@0.1.5-rc.1` 的 README 也写明了：渲染后的提示词以**派生历史里的一条 system 角色消息**到达模型，`neither the loop request nor request/header carries a separate system field`。本机实测：一个 66 个 step 的真实会话只追加了 **1 条** `request/header`（它只在 header 变化时追加，见 `dsh-agent-loop/lib/index.js` 的 `requestHeaderLogged` 分支），其 `data.header` 的 key 集合是 `{config, adapterDefaults, tools}`；同一会话里有 **1 条** `system/message`。

因此：**任何以 `request/header.data.header.system` 为判据的验收信号在本机都不可观察**，正确观察物是 `system/message` 事件，或探针侧监听 `system-prompt/assemble` 读 `assembly.sections`。本仓库 `docs/engram-upgrade-checklist.md` §5 第 2 条正是一条这样的失效判据（任务组 3 一并修）。

## Goals / Non-Goals

**Goals:**

- 文本的唯一真相在插件里，随插件版本分发；使用者机器上不再需要任何 engram 文本。
- 常驻层只放「什么时候必须做」，做法按需加载。
- 没有能力执行这套义务的 agent（子 agent）不承担它，且这条与「工具不可见」是同一个判定。
- 顺手补齐模型面的对话规则，并把「判无冲突不落库」的理由换成站得住的那些。

**Non-Goals:**

- 关系注解、读层索引、engram 正本库的任何读取——本次一概不碰。
- 中文写侧候选生成：不做 workaround，也不在本次记录。使用者已定：将来用「替换保存入口」的方式（与今天用自有检索替换 engram 的 `mem_search` 同形）从根上解决。**已完成**：2026-09-19 的变更 `engram-bridge-write-layer` 就是那件事——上游写入工具不再注册，保存走桥自有的入口，候选在写入之前由读层的派生索引算出（见 `openspec/specs/engram-bridge-save/`）。
- 不改 engram 后端，不动 `src/recall/scoring.ts` 的排序，不新增会话事件类型。

## Decisions

### D1 通道：常驻走系统提示词段，做法走技能注册表

| 备选 | 否掉的理由 |
|---|---|
| 继续用 durable instructions 消息（今天的形态） | 它需要一份用户文件；而且它是历史里的一条消息，可被历史重写替换，不是每步重渲染 |
| 只靠技能目录摘要 | 摘要有 500 字符上限，且目录模板自己写着「不要从摘要推断指令」——摘要只能是路由，不能承担触发条件 |
| 动态上下文（`ctx.systemPrompt.context()`） | 它是带来源的 user 角色快照，语义上是「运行期事实」而不是「义务」；段才是提示词文本 |

### D2 载体：随包 markdown + 加载点拆分 frontmatter

被否：TS 字面量。理由是编辑与评审体验——正文是 4.8 KB 中文 markdown，字面量要逐个转义反引号（写这份 design 时就被它咬过一次），评审时看到的是一个巨型表达式而不是渲染后的文档。

随包 md 的五个必须处理的点（都不是坑，但都要做对）：

1. `tsconfig.json` 是 `rootDir: src` + `include: ["src/**/*.ts"]`，`tsc` **不会**拷 `.md` ⇒ 资产放在 `protocol/`（`src/` 之外），代码里不能按 `../src/…` 找它。
2. `package.json` 的 `files: ["dist","cordis.patch.yml"]` 要加上该目录。本机是 `link:` 安装，**能掩盖这个遗漏** ⇒ 判据是声明本身，不是「本机能跑」。
3. 解析从 `dist/<module>.js` 出发：`new URL('../protocol/<file>.md', import.meta.url)`。
4. 读取放在 `apply()` 里（硬规则 2：模块作用域不得有进程级副作用）；缺失**在加载点抛**（硬规则 4）。
5. frontmatter 拆分：技能那份沿用今天的 frontmatter 形态（`name` / `description` 有消费者）；**常驻段那份不带 frontmatter**——段名与顺序号是代码里的字面量，它的 frontmatter 没有消费者，而 `~/.dsh/AGENTS.md` 那一行本身就是纯 markdown，加 frontmatter 就再也无法逐字对比。

两个文件：`protocol/resident.md`（常驻段，纯正文）与 `protocol/engram-memory.skill.md`（流程，带 frontmatter）。加载器对「无 frontmatter」的输入返回空 description 与整份正文。

### D3 order：写死字面值 350，位置靠实测指纹而不是靠计算

**被否：用 `getSectionOrder(命名槽)`。** 不只是「本机没这个键」，而是这个表在两版之间改过名和值（见 Context 的表）。照命名槽写会**过 typecheck、在本机运行期抛**：

```js
section(section) {
  if (!Number.isFinite(section.order))
    throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
}
getSectionOrder(name) { return SECTION_ORDERS[name]; }   // 查不到返回 undefined，不抛
```

**被否：运行期自动找一个空槽。** 做不到，也不需要：

- `SECTION_ORDERS` 在两版都**不导出**（导出清单只有 `PERSONA_*_SECTION`、`SystemPrompt`、`TOOL_ORDER_REST`、`joinContextSections`、`renderContextSections`、`renderContextSnapshot`、`renderPrompt`）。
- `section()` 只校验「有限」，**不校验「占用」**——order 重复合法，同号按 name 的 code-unit 排。所以「空槽」在宿主契约里不是概念，重复顺序不是正确性问题。
- 唯一的自动化入口 `getSectionOrder(name)` 的 name 类型是各版本自己的联合类型，无法枚举。

**取值 350**：它落在两版第一方表的空区间 `(0, 500)` 内。但**不能**据此说「这一段位置没有竞争者」——order 是任意第三方都能挑的自由值，本机 web profile 里一个第三方 OAuth MCP 客户端插件就注册了 `tool:mcp:atlassian`，**order 118**。所以：

- 本机实测的**紧邻前段是 `tool:mcp:atlassian`（118），不是 persona**；
- 「取非整百以免撞号」不是有效缓解（第三方照样挑 118 这种值），它只是降低与第一方撞号的概率，而第一方现有槽里也有非 50 倍数的值（`TOOL_PWSH = 1010`）。

**位置靠断言与实测指纹**：`PromptAssembly.sections` 是公开的，名字都在里面。探针 assemble 一次，读回段名序列，断言我们的段夹在 persona 段之后、第一方政策段（`PLAN_POLICY = 500`）之前，**并把实测的紧邻段名记进 `docs/engram-upgrade-checklist.md` 当指纹**。**实测 2026-09-17（dsh 0.1.5-rc.1）**：base+headless 探针 profile 下该段 `index=2`，前 `deployment:persona-prefix`、后 `plan:policy`，正文 193 字符（修订前 181），渲染出的系统提示词 4727 字符、标记出现 1 次（修订前 4715）；子 agent 会话里该段 `chars=0`、标记 0 次。删除两份手抄件后重跑，section 与 `system/message` 三项完全相同；而**不挂插件**时该段消失、技能目录也变空（手抄件曾是它在缺席时的唯一来源）。**指纹是 profile 相关的**——使用者的 web profile 另挂第三方 `tool:mcp:atlassian`（order 118），那里的紧邻前段是它而不是 persona；复测时按实测记，不要照抄。这是必需的一半，因为撞号在运行期是**静默**的。

### D4 子 agent 返空：一个全局注册 + 文本提供者按 agent 判定

依据两处生成物：

```ts
// dsh-agent/lib/types/runtime-types.d.ts —— AssembleContext 由 dsh-agent 增补
interface AssembleContext { agent?: Agent }   // "absent on diagnostics. When present, `scope` must identify the same agent."
// dsh-agent/lib/index.js:258
function assembleContextFor(agent, signal) { return { agent, scope: agent, ... } }
```

所以 `text: ({ agent }) => isSubagentSession(agent?.session?.header) ? '' : RESIDENT_TEXT`——一个注册覆盖所有 agent，而不是逐 agent 注册再遮蔽。README 保证「Empty sections disappear」。

判定复用 `src/subagent.ts` 既有的 `isSubagentSession`（工具面遮蔽用的是同一个判定）。`agent` 缺失（诊断组装）时按「给」。

类型用 `import type { Agent } from '@deepseek-ai/dsh-agent'`：`tsc` 会擦除，不进宿主入口的运行期 import 闭包（`scripts/check-recall-boundary.mjs` 已有 `import type` 擦除的先例）。

### D5 注入：两条可选注入，各自包在 `ctx.effect` 里

`ctx.inject(['systemPrompt'], …)` 与 `ctx.inject(['skills'], …)`。**不写进插件的 `inject` 数组**：宿主没有该服务时会让整个插件失效，而这两样都只是能力增强——沿用 `commands` 那条注释已经写下的先例与理由。

本机已有活先例：那个注册 order 118 段的第三方插件用的正是 `ctx.inject(['systemPrompt'], (promptCtx) => promptCtx.systemPrompt.section({ … }))`。

### D6 技能用 `ctx.skills.register()`，不用 `registerProvider()`

被否 `registerProvider()`：它要求实现 `list()`/`get()` 与自带 rank，而我们要的只是「一条插件自带的技能」；内存注册就是为这个场景提供的。

字段要求：`SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'>`，所以 `name` / `description` / **`source`** / `content` 都得给（只有 `invocation` 与 `provider` 有默认值）。`source` 必填是 typecheck 会拦的，而验收信号「来源为插件自带」看的正是它。

两条与部署有关的 rank 事实（同一层内）：

```
PROJECT_DSH 100 < PROJECT_AGENTS 200 < RUNTIME 250 < CUSTOM 300 < USER_DSH 400 < USER_AGENTS 500 < BUNDLED 600
```

- 插件自带的那份（`RUNTIME` 250）胜过 `~/.agents/skills/`（`USER_AGENTS` 500）⇒ **删漏了手抄件不会报错**。
- `list()`/`snapshot()` 只返回 **winning summaries**，**插件无法用 API 查询被遮蔽的那一份**（README：`a nearer layer shadows a farther one silently; there is no API to inspect all shadowed definitions`）。但遮蔽**不是完全静默**：输家会在宿主日志里留一条 warn（`dsh-skill/lib/index.js:320`：`skill "<name>" from <source> ignored because a higher-priority skill already exists`）。所以准确说法是「插件检测不到，只有人工读宿主日志才看得到」——这仍然要求 tasks 里的删除自带验证。

### D7 内容补齐的落点

- **对话规则（上游形状里的 DELIVERY GUARANTEE）**：记忆操作是内部账务，不是给用户的回答；先把必须做的记忆工作做完，再用完整回答收尾，此后再没有工具调用；记忆工作失败也要给出回答。今天这一条只在仓库 `AGENTS.md`（给开发者看），模型看不到。上游 Memory Protocol 的五个形状里，我们缺的正是这一个（`AFTER COMPACTION` 缺失是刻意的，见下）。
- **「判无冲突不落库」的理由重述。** 原理由「同一对会被反复提为候选」不成立，但**不能**用「44 条 pending 里只有 3 对同时有 judged 行」去反驳：判无冲突不落库时一行都不留，这个统计量天然测不到该命题。真正的反证在上游自己那行（`docs/PLUGINS.md`，main 分支，2026-09-17 取；**本机 1.20.0 的等价行为未复核**）：`not_conflict` verdicts persist as judged relations and return their `sync_id`, **suppressing future candidate scans**。换成两条站得住的理由：(1) 否定**不是关系**——`not_conflict` 断言的是「两者无关」，把「没找到关系」当成一条关系存下来，会让 `judged` 这个口径失去意义（本机 152 行 `not_conflict` 对 8 行 `supersedes`）；(2) 候选生成器没有阈值、多数候选是噪声。**注意不要**把理由写成「不产生注解行所以不记」——上游把 `compatible` / `related` / `scoped` / `not_conflict` **一起**列为不产生注解行，那三者我们照样要记。
  （计数口径：`not_conflict` 是 **152 行**、按有序 pair 去重是 **151 对**；`supersedes` 8 行。）
- **不写压缩后描述**：`compactionRecovery` 不是插件不变量（schema 默认 `true`，本机靠 `~/.dsh/cordis.patch.yml` 关掉）。由此得到一条通用规则：**常驻段只写模型的义务，不写插件的自动行为**——凡是受配置支配的能力都不进文本。

## Risks / Trade-offs

- **[手抄件删漏不会被插件发现]**（层内次序决定它静默胜出；插件查不到输家，只有宿主日志一条 warn）→ 删除与验证都写成任务：删完之后，技能目录里该技能的来源仍是插件自带，且模型所见内容逐字节不变。
- **[第一方或第三方将来往 `(0, 500)` 插值，撞号后顺序由名字决定且运行期静默]** → 探针断言段名序列，指纹（**实测**的紧邻段名）进升级清单第 5 节；这是升级时必须复测的一条。
- **[KV cache：每个请求的系统提示词多一段]** → 段是**静态**的：正文常量、顺序号固定，因此不会因为我们而产生「每回合都变」的前缀。注意**不能**把判据写成「同一会话两个 step 的系统提示词逐字节相同」——紧跟 order 350 的 `PLAN_POLICY`（500）是**按 agent 渲染**的段（`dsh-plan-mode/lib/index.js`：`text: (context) => context.agent === undefined ? "" : …`），而 plan 模式由模型自己调 `exit_plan_mode` 在同回合内切换，所以渲染后的提示词本身会变（`assemble()` 的**段序列**稳定：空段仍留在里面，只有 `renderPrompt` 才丢空段——两者不是同一个东西，不要混同）。正确的判据见 proposal 的验收信号表。
- **[模型可见的输入必须能被会话日志重建（硬规则 6）]** → 文本是随插件版本走的静态常量，不引入新会话事件类型；渲染结果由宿主原生化成 `system/message`，本来就落在日志里。
- **[两个 md 引入加载期失败模式]** → 缺失在加载点抛；`files` 声明 + `pnpm test` 里的加载用例 + `check:hygiene` 覆盖。
- **[推翻一条已记录的约束]** → `openspec/config.yaml` 的 context 与 `README.md` 两处一起改；本条记录就是「为什么现在可以」的出处。
- **[升级清单里已有一条用失效字段的判据]** → `docs/engram-upgrade-checklist.md` §5 第 2 条读 `request/header.data.header.system`，在 0.1.5 下永远失配；本次一并改成 `system/message` 或工具面缓存判据（任务组 3）。

## Migration Plan

分四步，**内容修订放在最后**，这样搬运本身可验证：

1. **搬运**：两份手抄件逐字进插件（技能那句带 frontmatter，常驻段那只是那一段纯文本）。验证：技能正文与 `~/.agents/skills/engram-memory/SKILL.md` 逐字节一致；常驻段与 `~/.dsh/AGENTS.md` 的 engram 行逐字一致。
2. **验证模型所见**：探针跑一次真实请求，断言常驻段在系统提示词里且只出现一次、子 agent 会话里不出现、技能目录里该技能来源为插件自带。
3. **删手抄件**（两台机器各一次）：删 `~/.dsh/AGENTS.md` 的 engram 行与 `~/.agents/skills/engram-memory/`。再跑一次第 2 步，断言模型所见内容与删除前逐字节一致。
4. **内容修订**：补对话规则、重述「判无冲突不落库」的理由、改掉技能里指向 `~/.dsh/AGENTS.md` 的悬空引用；重新记录常驻段字节数。

tasks 的组序**按这四步排**（搬运与注册 → 验证 → 删除 → 内容修订），不要按「先改完好再删」的直觉排——那会让「搬运是搬运」这条中间判据失去有效窗口。

**实现时的调整（2026-09-17）**：实际执行把**内容修订放在删除之前**（搬运 → 验证 → 内容修订 → 删除）。理由与「有效窗口」无关——那个窗口在第 1 步就已经取到并入库了：正在运行的宿主进程加载的是**改动前**的插件，先删手抄件会让当前会话在宿主重载之前既没有手抄件、也还没有协议段。换成这个顺序后，环境在任何时刻都自洽（悬空引用也在删除之前就清掉了）。

回退：停用插件即回到「只有手抄件」的形态。因此第 3 步必须在第 2 步通过之后；且第 1 步的文本在 git 历史里留档，第 3 步之后仍可复原。

## Open Questions

- ~~常驻段的最终字节数~~ **已实测：394 B**（内容修订后；修订前 374 B）。技能摘要未触及目录的 500 字符上限。
- `protocol/` 下的最终文件名（`resident.md` / `engram-memory.skill.md`）以实现为准；tasks 里写的是暂定名，改名不影响任何需求或决定。
