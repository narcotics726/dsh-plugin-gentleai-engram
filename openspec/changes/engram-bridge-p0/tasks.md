## 1. 探针收尾（结论回填设计）

- [x] 1.1 汇总探针报告 `docs/event-findings.md`；结果：Q1 中止回合**不触发** `turn-stopping`、Q2 `agent/created` 窗口 + `restrict` 生效（26→23，`UNKNOWN_TOOL`）、Q3 `clear`/`compact` 无生产者、Q4 `session-start` 先于首个回合；`resume` 标注 UNKNOWN（headless 无入口）
- [x] 1.2 子 agent 遮蔽采用 `agent/created` 窗口的 `restrict` + per-agent `guard` 兜底；`design.md` Decisions 8 已按证据更新
- [x] 1.3 捕获挂点确认为 `agent/turn-stopping`，并因 steer 会二次触发而加 (会话, 回合) 闩锁；`engram-passive-capture` 的中止场景改为"不产生捕获"，不读 `interrupted`

## 2. 仓库骨架

- [x] 2.1 `package.json`（含 `dsh.bundle.patch`）+ `cordis.patch.yml`（`id: engram-bridge`）+ `tsconfig.json` 就位；验证：`pnpm install && pnpm typecheck` 通过
- [ ] 2.3 校准池默认值：在普通 shell 用 `ps -o rss= -p $(pgrep -f "engram mcp")` 实测每进程 RSS（本会话沙箱禁用 `ps`），据此定 `poolMaxConnections`/`poolMaxIdleMs`；完成标准：≥3 进程实测数据 + 写入 design 的取值理由；验证：design Risks 中"先验值"条目被实测值替换
- [x] 2.2 `src/index.ts` 导出 `name`/`inject`/`apply` 与 Schemastery `Config`（含 `command`/`args`/`env`/`toolCallTimeoutMs`/`poolMaxIdleMs`/`poolMaxConnections`/`projectOverrides`/`injectSessionProject`/`injectSessionId`/`capturePassive`）；验证：`pnpm build` 产出 `dist/index.js` 且可 `import`

## 3. MCP 客户端与连接池

- [x] 3.1 移植草稿的 stdio JSON-RPC 客户端并补齐：子进程 `exit` 处理、请求级取消、`cwd` 参数、启动重试；验证：单测用假 stdio 服务器覆盖 initialize/listTools 分页/callTool 错误/子进程退出
- [x] 3.2 按工作区连接池：懒启动、single-flight、串行启动、空闲回收、上限淘汰；验证：单测断言"同工作区复用/不同工作区隔离/空闲关闭/超限淘汰"
- [x] 3.3 降级路径：可执行文件缺失、握手失败、工具列表失败 → 零注册 + 一条日志；验证：单测断言不抛错且注册数为 0

## 4. 工具面与子 agent 遮蔽

- [x] 4.1 注册 `mcp__engram__*`，名称/描述/参数 schema 与 engram 声明一致，结果按 dsh 形状返回；验证：实测 `dsh` 中模型可见工具数与 engram `tools/list` 一致
- [x] 4.2 子 agent 遮蔽（按 1.2 结论实现）+ 旁路兜底；验证：创建子代理后其工具面不含 `mcp__engram__*`（或经 `mcp_call` 调用被拒）
- [ ] 4.4 旁路探针：验证 `mcp_call({tool:'mcp__engram__mem_save'})` 在子 agent 中是否绕过 `restrict`；"不能绕过"则删除 per-agent `guard`（去掉无失效模式的防御），"能绕过"则保留并让 spec 的旁路场景有实现支撑；验证：探针日志 + design Decisions 8 更新
- [x] 4.3 卸载回收：`ctx.effect` 关闭全部子进程并注销工具；验证：停用后无 engram 子进程残留（`pgrep -f 'engram mcp'` 为空）

## 5. 会话绑定

- [x] 5.1 `agent/session-start` → `mem_session_start({id: dsh会话id, directory: 工作区})`，并建立"工具调用前必须已完成绑定"的屏障；验证：新会话后 `sqlite3 ~/.engram/engram.db "select id,directory from sessions order by started_at desc limit 1"` 正确，且首次 `mem_save` 不报 `unknown_session`
- [x] 5.2 任意 `source` 幂等复用，不新建会话；验证：resume 同一会话后 `sessions` 表行数不增
- [x] 5.3 向声明 `session_id` 的工具注入当前会话标识，显式传值优先；验证：两个会话各存一条，`session_id` 不同且互不串档

## 6. 项目解析与注入

- [x] 6.1 在会话绑定时用**该会话的工作区**驱动 engram 解析一次，并把 `project`/`project_source` 缓存在**该会话**上（同工作区结果相同，但归属按会话）；验证：在含 `.engram/config.json` 的工作区注入值与 engram 返回一致；且设置 `ENGRAM_PROJECT` 时目录解析仍胜出（实测 `project_source: git_root`）
- [x] 6.2 注入优先级 + `mem_save_prompt` 例外 + 歧义恢复不破坏；验证：单测覆盖 5 级优先级与例外分支，实测歧义恢复重试不被改写
- [x] 6.3 `injectSessionProject` / `injectSessionId` 开关；验证：关闭后请求不含对应参数

## 7. 被动捕获

- [x] 7.1 `agent/turn-stopping` 提交该回合最终回复文本，每回合一次，跳过被中断回合；验证：单测覆盖"多步一回合只提交一次""中断不提交"
- [x] 7.2 `extracted=0` 且存在学习段落时记日志；验证：用短条目触发后日志出现该记录
- [x] 7.3 `capturePassive: false` 时不调用；验证：单测 + 实测记忆不新增

## 8. 压缩恢复

- [x] 8.1 探针：扩展现有 `scripts/probe` 验证 `agent.inject()` 在 `compaction/end` 之后同一回合内进入后续模型请求；结果：`agent.inject()` 于 `compaction/end` 注入的 marker 出现在下一个 step 的模型可见序列（`scripts/probe/out/inject.jsonl`，t=35198.5 在 step/start 35197.9 之后）
- [x] 8.2 摘要持久化：`session/event` → `compaction/summary` → `mem_session_summary`（归属当前会话），按 `compactionId` 幂等；验证：单测 + 实测压缩后 engram 该会话 summary 等于摘要内容
- [x] 8.3 压缩后注入：`compaction/end` 成功后取 `mem_context`，按 `recoveryTokenBudget` 截断后注入；验证：实测压缩后请求含上下文，超预算时被截断
- [x] 8.4 开关与降级：`compactionRecovery=false` 不处理；失败只记日志；验证：单测覆盖两分支
- [x] 8.5 校准 `recoveryTokenBudget`：用真实压缩摘要长度实测并给出取值理由；结果：实测 `mem_context` 输出 4635 字符 ≈ 1159 tokens，默认 800 保留约 2/3；已写入 design Risks

## 9. 交付与迁移

- [ ] 9.1 `dsh plugin --profile {web,headless,open-design} add <repo>`；验证：`dsh plugin --profile web list` 可见且为 `link:`
- [ ] 9.2 删除 home patch 手写 `insert`，改为对 `engram-bridge` 的 config 覆盖；**新旧桥不能并存**（两者都注册 `mcp__engram__*`，同层重名会让注册失败），故 9.1 与 9.2 必须在同一次重启前完成；验证：`dsh --profile web --dump-config | grep -E "engram-bridge|mcp-engram"` 只出现 `engram-bridge` 一次，且启动日志无重复注册错误
- [ ] 9.3 备份并退役三份 `node_modules/dsh-engram-session-v2/`；验证：目录不存在且 `dsh web` 启动无错
- [ ] 9.4 端到端验收：新会话绑定 / 两会话不串档 / 学习条目落库一次 / 压缩后摘要落库且请求含记忆上下文 / `engram doctor` 无 mismatch / 卸载无残留；验证：命令输出记录到本 change 的验收小节
- [ ] 9.5 archive 后元数据回填：`openspec archive` 会丢弃 delta 的 frontmatter（实测归档产物只有 `# <cap> Specification` + `## Purpose` + `## Requirements`）；归档后把 `id/title/type/status/anchors/triggers/related` 补回 `openspec/specs/<cap>/spec.md`；验证：归档后 6 个 capability 的 spec 均含 `type:` 行

## 10. 文档与约定

- [x] 10.1 README（Model Experience + 安装 + 配置表）与 `docs/engram-upgrade-checklist.md`；验证：按 README 在干净 profile 上装通
- [ ] 10.2 清理 `~/.dsh/AGENTS.md` 中与插件行为重叠/已漂移的段落（指向插件，含 cwd 路径 vs directory 路径的说明）；验证：重叠描述只剩一处来源
- [x] 10.3 修复 README 的 openspec 指针（仍指向已删除的 `engram-dsh-bridge-p0`）；验证：README 中的 `openspec validate` 命令可直接跑通
- [x] 10.4 给 `docs/event-findings.md` 补版本戳（dsh 包版本 + engram 版本 + node 版本 + 探测日期 + 安装目录无 `.git` 的说明）；验证：报告首节含四项版本事实