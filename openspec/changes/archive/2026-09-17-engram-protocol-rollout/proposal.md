## Why

协议托管（`engram-protocol-hosting`）只在一台机器上落地：本机仍在跑手抄件，而托管文本相对手抄件少了两处覆盖（压缩后的手动兜底、连显式追赶也放不下时的 `/engram-sync` 转交）。这两处在落地前被逐条读过并判定为**有意不补**，而归档变更不回写——决定需要一个新的归属，否则下一个人会把它们当成遗漏去"修"。

## What Changes

- 完成本机落地：装两个新开发依赖、构建、装插件、重启、探针验证，然后删手抄件并复验模型所见逐字节不变。
- 把「压缩恢复关闭即完全关闭」写进契约：关闭时插件不写、不注入，**插件自带的协议文本也不要求模型自己补写**（此前手抄件承担兜底，等于开关有两个所有者）。
- 记录两处覆盖缺口的判定与理由、上游血缘的比对纪律、以及 `scope` 的核对结果。
- 修归档遗留的路径：归档 tasks 只写 `~/.agents/skills/engram-memory/`，本机的手抄件技能实际在 `~/.dsh/skills/engram-memory/`，两处都要删。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `engram-compaction-recovery`: 「压缩恢复开关」补上"关闭即完全关闭、协议文本不兜底"。

## 验收信号（可观察）

| 信号 | 观察方式 |
|---|---|
| 模型所见全部来自插件 | 删掉本机两处手抄件后，探针读到的常驻段与技能正文与删除前**逐字节一致** |
| 插件自带的技能生效且唯一 | 技能目录里 `engram-memory` 来源为 `runtime`，且同名冲突的 warn 在删除后消失 |
| 段位与可见范围 | 常驻段在主会话的 `system/message` 里出现恰好一次；子 agent 会话里 0 次 |
| 关闭即无义务 | 关掉压缩恢复后，插件自带的两份文本里检索不到"压缩后自行补写摘要或恢复上下文"的义务 |
| 门禁 | `pnpm typecheck && pnpm test && pnpm build && pnpm check:boundary && pnpm check:hygiene` 全部退出码 0 |

## Impact

- 代码：无。契约那条约束的是**资产文本**与开关语义的边界，不改实现。
- 依赖：`package.json` 里那两个新 devDependency 需要在**本机**真正装上（提交里只有声明，本机尚未安装，因此本机的 `typecheck` 目前跑不过）。
- 用户侧：本机删 `~/.dsh/AGENTS.md` 的 engram 段与 `~/.dsh/skills/engram-memory/`。
- 文档：`docs/engram-upgrade-checklist.md` 增加一条 `scope` 复测口径。
- 成本与残留：删手抄件后，插件不可用时模型没有任何 engram 义务文本（托管变更的既有取舍）；回滚方式记在 design 的「回滚」。
