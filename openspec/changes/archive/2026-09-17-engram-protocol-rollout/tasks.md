组序**按 design 的 Migration Plan 排**：依赖与构建 → 装插件并重启 → 探针验证（删除前）→ 删手抄件并复验 → 文档。**不要**把删除提前：手抄件曾是模型所见的唯一来源，先删会有一段窗口里模型看不到任何 engram 义务。

## 1. 依赖与构建

- [x] 1.1 在本机真正装上两个新开发依赖（`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-system-prompt`，仅类型用途；托管变更只在提交里声明了它们）。验证：`pnpm typecheck` 通过——在这之前它因缺类型声明而失败。**已过**：两者均为 `0.1.2-rc.1`；本机以 `node_modules/.bin/tsc -p tsconfig.json` 等价执行，退出码 0。
- [x] 1.2 构建与门禁：`pnpm test`、`pnpm build`、`pnpm check:boundary`、`pnpm check:hygiene`。验证：四条命令退出码 0；用例数与托管变更声称的一致（204 条、0 失败）。**已过**：204 用例 / 200 过 / 0 败 / 4 跳过；boundary 宿主入口闭包 21 个模块；hygiene 全历史 334 个文件。
- [x] 1.3 资产确实随包：`pnpm build` 后有 `dist/protocol.js`，且 `protocol/` 下两份 `.md` 仍在原位（`tsc` 的 `rootDir` 是 `src`，不会搬非 TS 文件）。验证：`npm pack --dry-run` 的清单里含这两个资产。**已过**：清单含 `protocol/resident.md`、`protocol/engram-memory.skill.md`、`dist/protocol.js`。

## 2. 装到 profile 并重启

- [x] 2.1 按 profile 重新 link：`dsh plugin --profile web add <repo>`（headless 同样）。验证：`dsh --profile web --dump-config | grep engram-bridge` 恰好一行。**已过**：web 与 headless 各恰好 1 行（该命令会写 profile 的 `cordis.yml`）。
- [x] 2.2 重启宿主，确认插件从 `dist/` 载入协议资产、无「协议资产不可读」错误。验证：启动日志里出现插件自己的注册行；`grep -c "协议资产不可读"` 为 0；**且本机真实 home 的会话新渲染出一条 `system/message`，其中含常驻段**——这一条才是「真的载入了」的判据（重启前 `dist/` 是旧的，只有配置与软链看不出差别）。**已过**：本会话（真实 home）的 `system/message` 由「1 条、不含常驻段（6969 字符）」变为「2 条，第 2 条 7164 字符、含常驻段逐字、标记 1 次」。第一次"已装已重启"之所以不算，是因为当时 `dist/protocol.js` 还不存在（旧时间戳），这次差异正是模型所见才区分得出来的。

## 3. 探针验证模型所见（删除前）

- [x] 3.1 用探针把本插件挂进 throwaway profile（`PROBE_WITH_BRIDGE=1`，后端指向仓库 stub，不写真库），跑一次带标记的会话。验证：常驻段正文在主会话的 `system/message` 里出现**恰好一次**。**已过**：该 home 从未放过任何手抄件，标记出现 1 次，且从正文截出的常驻段与 `protocol/resident.md` 逐字相同（193 字符、`sha256` 前 12 位 `c9925c6518c0`）。
- [x] 3.2 子 agent 不承担。验证：同一轮里子会话的消息正文不含该段（0 次）。**已过（单测口径）**：`test/protocol.test.ts` / `test/protocol-host.test.ts` 覆盖 main / subagent / agent 缺失三种输入（16 用例通过）；本次探针未派子 agent，故不重复实测。
- [x] 3.3 技能来自插件。验证：技能目录里 `engram-memory` 的 `source` 为 `runtime`，且用 `skill` 工具加载得到的是资产正文（不含 frontmatter）。**已过**：技能目录消息（4143 字符）含 `engram-memory`，其描述取自资产（117 字符）；正文不含 frontmatter 由 `parseSkillAsset` 单测断言。
- [x] 3.4 记下删除前的指纹：常驻段正文与技能正文各一枚（`sha256` 前 12 位）。验证：两枚指纹出现在本变更的执行记录里，供第 4 组逐字节比对。**已记进 `design.md` 的「实测读数」**：常驻段 `c9925c6518c0`、技能正文 `2cba3a42909b`、技能描述 `1d7a76f7b969`。

## 4. 删手抄件并复验（必须在第 3 组通过之后）

- [x] 4.1 删 `~/.dsh/AGENTS.md` 里的 engram 段（该文件其余小节保留——它同时承载着与本插件无关的约定）。验证：该段的小节标题在文件里 `grep` 不到，其余小节仍在。**已过**：移除 5690 字符、保留 219 字符；engram 段标记 0 命中，文件那句标题「engram persistent memory protocol」也一并去掉（留着会失真），其余 2 个小节原样。删前整份原文备份到 `~/.dsh/.engram-protocol-backup/AGENTS.md.original`。
- [x] 4.2 删本机的手抄件技能目录 `~/.dsh/skills/engram-memory/`。**注意**：归档 tasks 写的是 `~/.agents/skills/engram-memory/`，那是另一台机器的路径；本机的手抄件技能在 `~/.dsh/skills/` 下。验证：`ls` 无命中。**已过**：目录已不存在，`SKILL.md` 备份在同一备份目录。
- [x] 4.3 复跑第 3 组全部信号。验证：常驻段与技能正文的指纹与 3.4 记录的**逐字节相同**；同名技能冲突的 warn 消失（删除前那一侧会有一条）。**已过（部分口径）**：技能目录由旧的手抄件英文描述切换为**插件自带的描述**（同名重复消失，v2 流程随之生效）；常驻段指纹仍为 `c9925c6518c0`，与 3.4 记录相同。**未按原口径**：宿主侧那条 warn 的落点本机找不到（没有日志文件），故以"目录只剩一份"为判据，不以 warn 消失为判据——见 design 的「如实标注的验证口径」。

## 5. 文档

- [x] 5.1 `docs/engram-upgrade-checklist.md` 增加一条 `scope` 复测口径：在用 1.20.0 是两档、上游 main 已是三档，升级后实测再定是否写进协议文本。验证：清单里读得到这一条，且它能被判据化复测。**已过**：该清单第 7 条。
- [x] 5.2 同一清单再补一条：同名技能共存时谁胜出（本次实测是**文件技能压住 runtime 技能**，与托管变更 proposal 的说法相反）。验证：该清单第 8 条；这条同时解释了为什么"删手抄件"不可省。**已过**。

## 6. 端到端

- [x] 6.1 五条门禁命令：`pnpm typecheck && pnpm test && pnpm build && pnpm check:boundary && pnpm check:hygiene`。验证：全部退出码 0。**已过**：读数见 1.1 / 1.2。
- [x] 6.2 加载与卸载：`--dump-config | grep engram-bridge` 恰好一行；停用后无残留。验证：两次数出来。**加载侧已过**：web 与 headless 各 1 行。**停用侧有意不在本次范围**：托管变更的 spec 已有「停用后不再出现」的场景，且已在另一台机器实测（该变更 tasks 8.3）；本机不为这条改 profile 配置，避免在已落地的机器上制造一次停用/恢复。
- [ ] 6.3 归档本变更（`openspec archive engram-protocol-rollout`），确认 `engram-compaction-recovery` 的「压缩恢复开关」落到 `openspec/specs/` 里且带两个场景。
