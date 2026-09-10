# engram 升级回归清单

本插件的若干行为**依赖 engram 的具体语义**，且已观察到文档与实现不一致。升级 engram（或换版本线，如 v2.0.0-rc）后，按本清单逐条复测；任何一条变化都要同步 spec / design。

基线：engram **1.20.0**、dsh **0.1.2-rc.1**、node **v26.7.0**（2026-09-09 实测）。

## 0. 准备

所有 engram 侧复测都用**隔离的 engram 数据目录**，不要碰 `~/.engram`。engram **没有** `ENGRAM_DATA_DIR` 之类的数据目录变量（1.20.0 实测：只认 `$HOME/.engram/engram.db`），隔离靠把子进程的 `HOME` 指到临时目录：

```bash
export PROBE_HOME="$(pwd)/.upgrade-probe-home"
mkdir -p "$PROBE_HOME"
HOME="$PROBE_HOME" /opt/homebrew/bin/engram mcp    # 或 spawn 时把 env.HOME 换成它
```

（写实验前先 `mem_session_start` 建会话行，否则 `mem_capture_passive` 以 `FOREIGN KEY constraint failed (787)` 失败。）

## 1. project 解析来源（决定连接池与注入策略）

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| `mem_current_project`（cwd = 某仓库） | `project_source` 为 `git_root` / `git_remote` 等 cwd 派生值 |
| `mem_session_start({id, directory})` | 用 **directory** 解析；设置 `ENGRAM_PROJECT` 时 directory 仍胜出 |
| `mem_save({session_id})` | `project_source: session` |
| `mem_capture_passive({session_id})` | **用 cwd**（`project_source: git_root`），忽略 session |
| `mem_session_end({id})` | **用 cwd** |

**若 `mem_capture_passive` 开始尊重 `project` / session 的项目** → 可以简化"按工作区池化"的决定（design 决策 1）。

## 2. session 语义

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| `mem_session_start` 用**不存在**的 id | 成功，创建会话 |
| `mem_save` 用不存在的 `session_id` | 硬失败 `unknown_session` |
| `mem_session_end` 之后 `mem_save` / `mem_capture_passive` / `mem_session_summary` | 1.20.0 **全部仍成功** |
| `mem_session_end` 之后再次 `mem_session_start` 同 id | 1.20.0 **成功**（文档声称 `session_already_ended`） |

**若"已结束会话不可重开"开始生效** → 必须重新评估 design 决策 6（P0 不结束会话），并考虑 `agent/disposed` 收尾的替代方案。

## 3. 被动捕获

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| 20 字符多词条目 | `extracted=0`（**静默丢弃**） |
| ~28 字符多词条目 | `extracted=1` |
| 26 字符单词（无空格） | `extracted=0` |
| **纯 CJK 整句（无空格）** | `extracted=0`（整句 = **1 个 token**，静默丢弃） |
| 同一批句子，词间插入空格 | `extracted=4`（门槛是**空白分隔的 token 数**，不是字符数） |
| 10 条带标识符的条目 | `extracted=10`（**无条数上限**） |
| 重复提交同一文本 | `duplicates>0`，不重复写入 |
| `mem_capture_passive({source: 'X'})` 的落点 | `observations.tool_name` = `'X'`（该表**没有** `source` 列，也没有回合列）；marker 同时出现在 `title`/`content` 里 |

**若阈值变化** → 更新 README / spec 的说明（插件本身不重实现提取）。

**落库判据**：真机验收用 `observations.tool_name='dsh-turn-stopping'` 定位桥的自动捕获（已由隔离实验证实 `source` → `tool_name`）。若该映射变化 → 判据改走 `title`/`content` 定位，并同步 README。

## 4. 多进程并发

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| 6 个进程 × 8 并发写同一 DB | 全部成功（WAL） |
| 一个进程正在退出时启动另一个 | 可能瞬时 `pragma journal_mode = WAL: database is locked`（池靠串行启动 + 重试吸收） |

## 5. dsh 侧（换 dsh 版本时）

```bash
./scripts/probe/run-probe.sh smoke smoke "hello"   # runner 自建仓库外的 throwaway DSH_HOME
```

复测四项（详见 `docs/event-findings.md`）：中止回合是否触发 `agent/turn-stopping`、`agent/created` 窗口能否 `restrict`、`session-start` 的 source 集合、`session-start` 是否先于首个回合。

再加两项（2026-09-10 由 `engram-bridge-p0-fixes` 补入，判据见 `docs/event-findings.md` 的「Session-event envelope anchors」）：

1. **会话事件仍是信封**：随机解压一个会话日志，确认 `assistant/message` 事件的 key 集合仍含 `data`（而不是把 `turn`/`message` 平铺到顶层）。若宿主改变该形状，插件会以一条 warn（每会话每事件类型一条）暴露，而不是静默失效。
2. **工具面声明块的位置**：`request/header.data.header.system` 里 `mcp__engram__*` 的唯一名字数应等于 `~/.dsh/storages/engram-bridge/tools.json` 的声明数 **减 1**（被动捕获工具不注册）；`data.header.tools` 在 web/ptc 档只有 `run_code`，不能当判据。
3. **压缩事务的所有者与投递边界**：`compaction/end` 的 `data.turn` 仍应为 `number | null`（`null` = turn 之间的独立手动事务），且 `agent.send(message, target, wakeup)` 仍应是公开成员。手动 `/compact` 后，会话日志里的 `agent/inbox/spliced` 应出现 `target: 'next-turn'` 且随后**没有** `outcome: 'canceled'` 的撤销。若 `send` 消失或 turn 语义变化 → 插件记一条 warn 且不投递（不会静默复现「投递后被丢弃」）。

## 6. 端到端

```bash
pnpm typecheck && ENGRAM_LIVE=1 pnpm test
```

再按已归档变更的验收记录跑一次宿主验收（`openspec/changes/archive/2026-09-10-engram-bridge-p0-fixes/tasks.md` 的「验收证据」段：新会话绑定 / 会话不串档 / 学习条目落库一次 / 压缩后摘要落 `observations.session_summary` + 召回投递到 `next-turn` / `engram doctor` 无 mismatch / 卸载无残留）。
