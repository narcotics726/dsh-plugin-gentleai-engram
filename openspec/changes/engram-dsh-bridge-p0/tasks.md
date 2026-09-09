## 1. 事件探针（先证实载荷，再写实现）

- [ ] 1.1 写 `scripts/probe-events.mjs` 与 `scripts/probe.cordis.yml`，以临时插件监听 `agent/session-start`、`assistant/message`、`session/event`，把载荷字段名 dump 到 stdout；验证：`dsh --profile web --patch ./scripts/probe.cordis.yml` 启动并发一条消息后，stdout 出现三类事件及其字段名
- [ ] 1.2 把探针结论写入 `docs/event-findings.md`；验证：文件存在，且字段名与 design 的假设一致（不一致则更新 design）

## 2. 仓库骨架

- [ ] 2.1 `package.json`（name / private / type / main / exports / files / scripts / `dsh.bundle.patch`）+ `cordis.patch.yml` + `tsconfig.json` 就位；验证：`pnpm install && pnpm typecheck` 通过（空 `src/`）
- [ ] 2.2 `src/index.ts` 导出 `name` / `inject` / `apply` 骨架 + Schemastery `Config`；验证：`pnpm build` 产出 `dist/index.js` 且 `node -e "import('./dist/index.js')"` 成功

## 3. 移植草稿的 MCP 客户端

- [ ] 3.1 移植 MCP stdio 客户端（initialize / listTools / callTool + 超时 + abort）；验证：单测用假 stdio 服务器跑通 initialize 与一次 callTool
- [ ] 3.2 注册 22 个工具（`mcp__engram__*`）并保留 `project` / `directory` 注入；验证：`dsh web` 中模型可成功调用 `mcp__engram__mem_search`

## 4. 会话绑定（P0-1）

- [ ] 4.1 `agent/session-start` → `mem_session_start({id, project, directory})`；验证：新会话后 `sqlite3 ~/.engram/engram.db "select id,project,directory from sessions order by started_at desc limit 1"` 出现该 dsh 会话 id 且 directory 正确
- [ ] 4.2 为声明 `session_id` 的工具注入当前会话 id；验证：连续两个会话各存一条 observation，`session_id` 不同（对应 spec 场景「会话间不串档」）

## 5. 被动捕获（P0-2）

- [ ] 5.1 `assistant/message` → 解析 `## Key Learnings:` → `mem_capture_passive`，按 (session_id, message_id) 去重；验证：一条含该段落的回复后，`sqlite3` 查到新增 observation
- [ ] 5.2 不含该段落时不调用；验证：单测覆盖该分支，且实测 DB 无新增

## 6. 交付与迁移

- [ ] 6.1 `dsh plugin --profile {web,headless,open-design} add <repo>` 并确认 `link:` 依赖；验证：`dsh plugin --profile web list | grep gentleai-engram`
- [ ] 6.2 删除 `~/.dsh/cordis.patch.yml` 手写 insert、改为 config 覆盖；验证：`dsh --profile web --dump-config | grep engram-bridge` 恰好一行
- [ ] 6.3 备份并退役三份 `node_modules/dsh-engram-session-v2/`；验证：目录不存在且 `dsh web` 启动无错
- [ ] 6.4 端到端验收：新会话建 session / Key Learnings 落库 / 卸载无残留；验证：三条命令输出记录到本 change 的验收小节

## 7. 文档

- [ ] 7.1 README（Model Experience + 安装 + 配置表）与 `docs/engram-upgrade-checklist.md` 与实现一致；验证：按 README 的安装步骤在干净 profile 上能装通
