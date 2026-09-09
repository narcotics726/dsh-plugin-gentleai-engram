# engram 升级回归清单

本插件的若干行为**依赖 engram 的具体语义**，且已观察到文档与实现不一致。升级 engram（或换版本线，如 v2.0.0-rc）后，按本清单逐条复测；任何一条变化都要同步 spec / design。

基线：engram **1.20.0**、dsh **0.1.2-rc.1**、node **v26.7.0**（2026-09-09 实测）。

## 0. 准备

所有 engram 侧复测都用**隔离数据目录**，不要碰 `~/.engram`：

```bash
export ENGRAM_DATA_DIR="$(pwd)/.upgrade-probe"
mkdir -p "$ENGRAM_DATA_DIR"
```

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
| 重复提交同一文本 | `duplicates>0`，不重复写入 |

**若阈值变化** → 更新 README / spec 的说明（插件本身不重实现提取）。

## 4. 多进程并发

| 复测 | 期望（1.20.0 基线） |
| --- | --- |
| 6 个进程 × 8 并发写同一 DB | 全部成功（WAL） |
| 一个进程正在退出时启动另一个 | 可能瞬时 `pragma journal_mode = WAL: database is locked`（池靠串行启动 + 重试吸收） |

## 5. dsh 侧（换 dsh 版本时）

```bash
DSH_HOME="$(pwd)/scripts/probe/tmp/dsh-home" ./scripts/probe/run-probe.sh smoke smoke "hello"
```

复测四项（详见 `docs/event-findings.md`）：中止回合是否触发 `agent/turn-stopping`、`agent/created` 窗口能否 `restrict`、`session-start` 的 source 集合、`session-start` 是否先于首个回合。

## 6. 端到端

```bash
pnpm typecheck && ENGRAM_LIVE=1 pnpm test
```

再按 change 的 tasks 9.4 跑一次宿主验收（新会话绑定 / 两会话不串档 / 学习条目落库一次 / 压缩后摘要 + 注入 / `engram doctor` 无 mismatch / 卸载无残留）。
