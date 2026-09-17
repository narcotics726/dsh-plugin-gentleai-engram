组序**按 design 的 Migration Plan 排**：搬运与注册 → 验证 → 删除手抄件 → 内容修订。不要按「先改完好再删」的直觉排——那会让「搬运是搬运」这条中间判据失去有效窗口。

## 1. 载体与加载（迁移第 1 步：搬运）

- [x] 1.1 建 `protocol/` 目录：`engram-memory.skill.md` 是手抄件 `~/.agents/skills/engram-memory/SKILL.md` 的**逐字节**副本（含 frontmatter）；`resident.md` 是把 `~/.dsh/AGENTS.md` 里 engram 那一行的「什么时候必须做」与「流程」两格内容拼成的**纯文本、不带 frontmatter**（那行本身没有 frontmatter，加了就无法逐字对比，且段名与顺序号是代码里的字面量、不需要它）。验证：技能文件与手抄件 `sha256` 相同；常驻段与从该行抽出的文本 `diff` 为空。
- [x] 1.2 实现加载器：读资产、拆分 frontmatter、返回 `{ name, description, body }`；输入无 frontmatter 时返回空 description 与整份正文。验证：单测覆盖「有 frontmatter」「无 frontmatter」「文件缺失且抛出并指名文件」三种输入。
- [x] 1.3 `package.json` 的 `files` 加上 `protocol`；开发依赖加 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-skill`（仅类型用途）。验证：`pnpm install && pnpm typecheck` 通过；`npm pack --dry-run` 的清单里含 `protocol/` 下两个文件。
- [x] 1.4 资产读取发生在 `apply()` 内（模块作用域不得有进程级副作用），缺失在加载点抛。验证：`grep` 确认模块作用域无 `readFileSync`；单测在资产缺失时 `apply()` 抛出。

## 2. 注册（迁移第 1 步：生效）

- [x] 2.1 系统提示词段：`ctx.inject(['systemPrompt'], …)` 内 `ctx.effect(() => ctx.systemPrompt.section({ name: 'engram:protocol', order: 350, text }))`，`text` 为固定正文、对子 agent 返回空串（D4）。验证：单测断言 `order` 有限且等于 350、主 agent 得到正文、子 agent 得到空串、卸载后该段被移除。
- [x] 2.2 子 agent 判定复用 `src/subagent.ts` 的 `isSubagentSession`（与工具面遮蔽同一判定）；`agent` 缺失（诊断组装）时按「给」。验证：单测覆盖 main / subagent / agent 缺失三种输入。
- [x] 2.3 技能注册：`ctx.inject(['skills'], …)` 内 `ctx.effect(() => ctx.skills.register({ name, description, source: 'runtime', content }))`。注意 `source` 是**必填**（`SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'>`，只有这两个有默认值），漏了过不了 typecheck。验证：单测断言 `source === 'runtime'`、`content` 不含 frontmatter 块且 `description` 非空；`pnpm typecheck` 通过。
- [x] 2.4 两条注入都不写进插件的 `inject` 数组；宿主没有这两个服务时插件其余能力照常。验证：用一个不含 `systemPrompt`/`skills` 的最小 ctx 跑既有 wiring 测试桩，`apply()` 不抛且 engram 工具仍注册。

## 3. 探针与升级清单

- [x] 3.1 给 `scripts/probe/probe-events.mjs` 增加 `system/message`（它的 `KEEP` 集合现在没有这一项，全文也没有读 `header.system` 的地方）。验证：探针输出里能看到该类型事件及其正文。
- [x] 3.2 段位断言：探针监听 `system-prompt/assemble`（或读等价产物），断言我们的段夹在 persona 段之后、第一方政策段（`PLAN_POLICY = 500`）之前。验证：探针输出里能看到断言结果与**实测**的紧邻段名（本机预期前邻居是 `tool:mcp:atlassian`，不是 persona）。
- [x] 3.3 修 `docs/engram-upgrade-checklist.md` §5 第 2 条：它读 `request/header.data.header.system`，在本机 0.1.5 下**永远失配**（该字段已随 `EpochHeader` 一起删掉，本机实测该会话 66 个 step 只有 1 条 `request/header`、其 key 集合为 `{config, adapterDefaults, tools}`）。改成 `system/message` 或工具面缓存判据，并新增段位指纹一条（实测邻居名 + 「撞号在运行期静默」这一事实）。验证：清单里读得到新判据，旧字段名不再作为判据出现。
- [x] 3.4 更新升级清单的基线行（dsh 版本与实测日期）。验证：能读到。

## 4. 验证模型所见（迁移第 2 步）

- [x] 4.1 常驻段在真实会话的 `system/message` 里出现，且**只出现一次**。验证：探针输出里对资产正文的匹配计数等于 1。（不要用 `request/header`——本机没有 `system` 字段。）
- [x] 4.2 子 agent 会话的 `system/message` 不含该段。验证：探针输出里子会话的消息正文不匹配。
- [x] 4.3 技能目录里该技能来源为 `runtime`（插件自带），且用 `skill` 工具加载得到的是资产正文。验证：目录消息与加载结果。
- [x] 4.4 冷启动：新会话的**第一个**请求就带该段（不依赖先发生任何工具调用）。验证：探针输出里首条 `system/message` 即含。

## 5. 删除手抄件（迁移第 3 步，必须在第 4 组通过之后）

- [x] 5.1 删掉 `~/.dsh/AGENTS.md` 的 engram 行与 `~/.agents/skills/engram-memory/`。验证：两处 `grep` / `ls` 均无命中。
- [x] 5.2 删除后复验第 4 组全部信号，且模型所见与删除前逐字节一致。验证：对比删除前后的探针输出（常驻段与技能正文逐字节相同）。宿主日志里允许出现一条 `skill "…" ignored because a higher-priority skill already exists`（删除前那一侧）。
- [ ] 5.3 第二台机器重复 5.1–5.2。验证：同上。

## 6. 内容修订（迁移第 4 步）

- [x] 6.1 补对话规则：记忆操作是内部账务、先把必须做的记忆工作做完再用完整回答收尾、此后没有工具调用、记忆工作失败也要给出回答。验证：资产文本里能读到该条；真实会话跑一次收尾，末条助手消息之后没有工具调用。
- [x] 6.2 重述「判无冲突不落库」的理由为：否定**不是关系**（把「没找到关系」当成关系存，会让 `judged` 口径失去意义）＋ 候选生成器无阈值。**不要**写成「不产生注解行所以不记」——上游把 `compatible`/`related`/`scoped`/`not_conflict` 一起列为无注解行，而前三者我们照样要记。验证：`grep` 不到「同一对会被反复提为候选」；新理由与 `design.md` D7 一致。
- [x] 6.3 清掉资产里对 `~/.dsh/AGENTS.md` 的引用（手抄件有两处：frontmatter 的 description，以及正文开头那句「常驻层（`~/.dsh/AGENTS.md`）只写…」）。前一处进技能目录、模型可见，删手抄件后会变成悬空引用。验证：`grep -n 'AGENTS.md' protocol/*.md` 无命中。
- [x] 6.4 实测常驻段字节数并记回 `design.md` 的 Open Questions。验证：`wc -c protocol/resident.md` 的数字出现在 design 里。

## 7. 文档与既有决定

- [x] 7.1 `README.md`「模型看到什么」一节删掉「不新增 system prompt 段」，改写为：常驻段与技能由插件提供、子 agent 看不到该段。验证：`grep` 不到旧句，新句可读。
- [x] 7.2 `openspec/config.yaml` 的 context 删掉「P0 不新增 system prompt 段（KV cache）」。验证：`grep` 无命中。
- [x] 7.3 仓库 `AGENTS.md` 记一条开发约定：模型可见文本的唯一真相在 `protocol/` 下，不在代码里就地写。验证：`AGENTS.md` 里能读到该条。

## 8. 端到端

- [x] 8.1 `pnpm typecheck && pnpm test && pnpm build && pnpm check:boundary && pnpm check:hygiene`。验证：全部退出码 0。
- [x] 8.2 加载验证：`dsh --profile web --dump-config | grep engram-bridge`。验证：恰好一行。
- [x] 8.3 卸载验证：停用插件后 `--dump-config` 无残留，且探针输出里常驻段与技能目录条目都消失。验证：两项都观察不到。
- [x] 8.4 改文本即生效：把常驻段改一处措辞 → 重建 → 重载 → 探针里该段正文随之改变，然后改回。验证：前后两次探针输出里该段正文不同；改回后与改前相同。