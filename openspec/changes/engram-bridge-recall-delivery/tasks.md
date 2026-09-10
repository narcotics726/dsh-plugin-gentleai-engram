# Tasks — engram-bridge-recall-delivery

判据分两类，写作时必须区分：

- **客观判据**：存在性 / 日志坐标（seq、时刻）/ 可 SQL 或可 grep 的计数——不依赖模型输出内容；
- **观察项**：记录数值但**不作 pass/fail**，因为它取决于模型当次行为（例如自恢复回合里的工具调用次数）。

## 1. 配置

- [x] 1.1 `src/config.ts` 新增 `recallWakeup`（Schemastery `z.boolean().default(true)`）；`interface Config` 注明它是「成本退回阀」，关闭后属已知退化模式。
  - 验证：`pnpm typecheck`；`test/config.test.ts` 断言默认值为 `true`、显式 `false` 被保留。

## 2. 投递缝

- [x] 2.1 `src/compaction.ts`：`CompactionOptions`（`src/compaction.ts:14-23`）新增 `recallWakeup: boolean`；投递缝改为携带唤醒位；`onEnd` 在 `turn === null` 时 `wakeup = recallWakeup`，`turn` 为数字时 `wakeup = false`。目标边界不作为本插件的对外契约（宿主可在相位中止时改写边界），因此实现里不依赖某个具体的收件队列名。
  - 验证：`test/compaction.test.ts` 断言四种组合——`turn=null`+`recallWakeup=true` → `wakeup=true`；`turn=null`+`false` → `false`；`turn=3` → `false`；以及三种情况下传入的目标参数一致（不因 `turn` 变化）。
- [x] 2.2 `src/index.ts`：构造 `CompactionRecovery` 处（`src/index.ts:181-215`）传入 `config.recallWakeup`；`AgentLike.send` 的第三参由写死 `false` 改为透传；缺 `send` 时仍只记 warn 且不投递（不回落到不携带唤醒位的路径）。
  - 验证：`pnpm typecheck`；`test/stub-wiring.test.ts`（接线点 `:193-200`）与 `test/live-wiring.test.ts`（`:113-118`）断言手动压缩场景下 `wakeup === true`；另加一例断言缺 `send` 时不调用任何投递入口且产生一条 warn。

## 3. 注入文本

- [x] 3.1 注入文本改为**序无关**的条件式（无用户输入 → 一句轻量确认；有用户输入 → 按它回答、把本段当背景），不改动召回正文与 `recoveryTokenBudget` 截断逻辑。
  - 验证：`test/compaction.test.ts` 断言投递文本同时包含两个分支的表述，且仍受预算截断。

## 4. 文档与注释

- [x] 4.1 `README.md`：压缩恢复行改写为「手动压缩后以唤醒方式投递、成为一轮独立回合」；配置表加 `recallWakeup` 并标注关闭后是**已知退化模式**（停等期间可被生命周期清除）；补成本提示「自恢复回合进行期间再次 `/compact` 会被宿主拒绝」。同时改正 `:17` 的机制句——原句把 seq 303820/303821 的撤销写成「手动压缩收尾时被丢弃」，而宿主契约原文只说 pending 输入可被 **cancellation 或 disposal** 丢弃。
  - 验证：`grep -n 'recallWakeup\|不可压缩\|cancellation' README.md`；逐条比对 2.1 的语义。
- [x] 4.2 `~/.dsh/AGENTS.md` After compaction 段：① 删除与事实矛盾的那句（`recall arrives together with your next message`）；② 把「read the recall → mem_context → continue working」改成「自恢复回合只做一句轻量确认，等用户发言再开工」；③ 明确豁免自恢复回合的 `## Key Learnings:` 收尾。
  - 验证：把改写后的**完整段落原文**写进仓库内镜像 `docs/agents-after-compaction.md`（本变更新增），使审计不依赖仓库外文件；并比对 `~/.dsh/AGENTS.md` 与镜像一致。
- [x] 4.3 修正源码/测试注释里被推翻的因果：`src/compaction.ts:5-11` 与 `test/compaction.test.ts:88-92`。改法统一为「pending 输入可被宿主的 cancellation/disposal 丢弃（宿主契约原文）；本次实测中该撤销先于 `session/end-seed` 17.3 秒，成因未被钉死」。
  - 验证：`grep -rn '收尾' src/compaction.ts test/compaction.test.ts` 无命中。

## 5. 门禁与契约核对

- [x] 5.1 `pnpm typecheck && pnpm test && pnpm build`；`ENGRAM_LIVE=1 pnpm test`；`pnpm check:hygiene`；`openspec validate --all --strict`。
  - 验证：命令输出；测试数不低于改动前的 73 项且 0 fail。
- [x] 5.2 变异验证：把 `dist/compaction.js` 的唤醒位强制为 `false`，确认「手动压缩必须唤醒」用例变红，再还原。
  - 验证：给出变红时的断言文本与还原后重新全绿的输出。
- [x] 5.3 宿主契约核对（替代不可构造的 Path B 真机项）：在 `docs/engram-upgrade-checklist.md` §5 记录本次依赖的三条宿主语义及其原文出处——① `send` 的 `wakingAfterAbort` 会在相位已中止时把目标重分类；② `wakeDriver` 的锁存条件 `reason?.kind !== 'disposed' && (kind === 'maintenance' || wakeAfterAbort)`；③ `a disposed cancel leaves it parked`。每条写明「若改动则退化为哪种行为」。
  - 验证：`grep -n 'wakingAfterAbort\|wakeRequested\|parked' docs/engram-upgrade-checklist.md` 命中三条。

## 6. 真机验收（阻塞项）

- [ ] 6.1 重建 + 重启 dsh，手动 `/compact` 一次，**不要发言**。
  - **客观判据**（全部不依赖模型输出）：
    - 自该次 `compaction/end` 起、到下一个 `turn/start` 为止，**不存在**任何 `source.kind === 'user'` 的 `user/message` 事件（即该回合不是被用户输入开启的）；
    - 该 `turn/start` 出现在该次 `command/done` 之后；
    - 该回合的 `user/message` 中**存在**召回文本（存在性，不比条数）；且其中不存在任何用户来源的消息；
    - 若该回合没有任何 `user/message`（宿主在领取前清除了该输入时的合法形状），记为「宿主清除」并按 `spec` 的「上下文在领取之前被清除」场景判定为通过，不算失败。
  - **观察项**（记录，不作 pass/fail）：该回合的 `step` 数、`tool/call` 数、助手正文长度。模型为核实缺口而调用 `mem_context`/`mem_search` 属预期行为，不计失败。
  - 验证：给出 `compaction/end`、`command/done`、`turn/start`、`user/message` 的 seq 与时刻。
- [ ] 6.2 在该回合结束后发一句话，确认它被当成独立回合处理。
  - 验证：该用户消息的 `user/message` 出现在**新的** `turn/start` 之下；不存在「召回占用了一个回合、用户消息仍被推到再下一回」的排布。
- [ ] 6.3 连续压缩的反馈：自恢复回合进行中再触发一次 `/compact`。
  - 验证（可复现的计数差分）：记录尝试前后 `sqlite3 ~/.engram/engram.db "select count(*) from observations where type='session_summary'"` 的值，断言**不变**；并记录命令层返回的文案为「不可压缩」而非静默失败。
- [ ] 6.4 关闭开关的行为：在 `~/.dsh/cordis.patch.yml` 的 `engram-bridge` entry 的 `config` 下加 `recallWakeup: false`（该文件热重载），手动 `/compact`。
  - 验证：该次 `compaction/end` 之后**没有**新的 `turn/start`，直到用户输入出现。
  - **复位步骤（必须做）**：删除该键；`dsh --profile web --dump-config | grep -A20 engram-bridge` 不再出现 `recallWakeup: false`；再压缩一次确认唤醒恢复。残留该键会让默认行为永久失效，且该文件不在仓库内、不进变更记录。

## 7. 归档与回写

- [ ] 7.1 `openspec archive engram-bridge-recall-delivery`，delta 落到 `openspec/specs/engram-compaction-recovery/`；回写 Obsidian 项目主档与 engram（`decision` + 真机验收结论）。
  - 验证：`openspec validate --all --strict` 全绿；主档状态块与 changelog 与实际行为逐条一致；归档后确认长期规格的 `anchors.config_keys` 仍含 `recallWakeup`。
- [x] 7.2 记录上一轮归档变更的因果更正——**默认不修改 archive**。archive 目录对应已提交的审计快照，追加修订会让它与历史提交分叉、失去「当时如何」的快照性质。落点：本变更 `design.md` 的「成因更正」与「修订记录」两节（已有），加 `docs/engram-upgrade-checklist.md`（7.3 / 5.3）。
  - 验证：本变更 `design.md` 含该两节；`git log --oneline -- openspec/changes/archive/2026-09-10-engram-bridge-p0-fixes/` 在本变更内**无新增提交**。
  - **可选（需用户明确同意）**：若要改 archive，先说明 archive 从此作为「活文档」的新语义并取得同意，再单独提交，注明它是对快照的勘误而非改写。
- [x] 7.3 `docs/engram-upgrade-checklist.md` 的复核触发器：`:78` 已有 `turn` 语义与 `agent.send` 公开性两条，补第三条 `Inbox.claim` 的批次规则（整列 next-step / 1 条 next-turn）；并把 `:78` 现有判据「随后没有 `outcome:'canceled'` 的撤销」改写为可判定式——**手动 `/compact` 后在用户输入之前出现由召回开启的 `turn/start`**（旧判据改动后仍会通过，但它已不能证明投递被保住：`outcome:'canceled'` 也可由生命周期清除或插件 `inbox.remove` 产生）。
  - 验证：清单 §5 三条齐全，每条写明「若改动则退化为哪种行为」。

## 8. 已知副作用

- [x] 8.1 自恢复回合会额外触发一次 `agent/turn-stopping` → `mem_capture_passive`（`src/index.ts:250-260` → `src/capture.ts:27-38`）。在 `README.md` 与 `design.md` 的 Risks 中承认这次额外写入，并在 4.2 的 AGENTS.md 改写里豁免该回合的 Key Learnings。
  - 验证：6.1 之后查 `observations` 中该回合是否产生条目（SQL 计数差分，可复现）；若产生，确认其为预期噪声而非重复写入。

## 执行结果（2026-09-10，实现与门禁）

- **配置/投递缝/文本**：`src/config.ts` 新增 `recallWakeup`（默认 true）；`CompactionOptions` 新增同名字段，投递缝签名变为 `deliver(sessionId, text, target, wakeup)`；`src/index.ts` 透传唤醒位，并对缺键兜底到 schema 默认值（直接构造的 config 可能省略该键）。目标边界统一为 `next-step`，不再随 `turn` 变化。
- **注入文本**：加自述框架（约 90 token）；预算先扣框架份额再截断召回正文，因此框架不会被截断掉。措辞为条件式（无用户输入 / 有用户输入两分支），不假设该回合是空的。
- **测试**：`pnpm test` 79 项 / 75 pass / 4 skipped / 0 fail（改动前 73 项）；`ENGRAM_LIVE=1 pnpm test` 79/79。新增 6 例：手动压缩必须唤醒、运行中压缩不唤醒、目标不随 turn 变化、`recallWakeup=false` 只投不唤醒、注入文本自述且序无关、极小预算下框架仍存活；另加一例「宿主无 send 时不回落到无唤醒位投递」。
- **先红后绿**：新用例在实现前对旧 dist 变红（`actual: undefined, expected: true`），实现后全绿。
- **变异验证（5.2）**：把 `dist/compaction.js` 的 `const wakeup = turn === null && this.#options.recallWakeup;` 改成 `const wakeup = false;`，用例以 `AssertionError: a turn-less transaction must wake the driver` 变红；重新 `pnpm build` 后恢复全绿。
- **门禁**：`pnpm typecheck` 通过；`pnpm check:hygiene` ok（全历史 156 文件）；`openspec validate --all --strict` 7/7。
- **一处未复现的抖动（诚实记录）**：在 `pnpm typecheck && pnpm test && ENGRAM_LIVE=1 pnpm test` 的首次执行中，默认套件报 74 pass / 1 fail；此后相同命令序列与单独 `pnpm test` 共连跑 12 次均 0 fail，未能复现，且**当时没有捕获失败用例名**（操作失误）。已挂后台循环继续观察。候选：池回收的定时器用例，或本变更新增的第二会话（多一次 engram 子进程往返）。

## 待办（等待真机验收）

- 6.1–6.4 需要重建 + 重启 dsh + 手动 `/compact`；7.1 归档与回写在其后。
