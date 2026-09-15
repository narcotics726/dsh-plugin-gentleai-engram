# scripts/probe — throwaway runtime probe for dsh agent/session events

Self-contained probe harness used to answer four runtime questions about dsh's
event surface (results in `docs/event-findings.md`). Everything here is
throwaway: nothing under `openspec/`, `src/`, `~/.dsh` or `~/.engram` is touched.

## Files

| file | role |
| --- | --- |
| `probe-events.mjs` | the Cordis plugin under test: subscribes to the agent-plane events and to `session/event`, appends one JSONL line per fact |
| `probe.cordis.yml` | `--patch` overlay **template** that inserts the plugin as a global row; `run-probe.sh` substitutes the `@@…@@` tokens into a rendered copy inside the throwaway DSH home, so the checked-in file holds no local path. It cannot use `!!js` for `name`: the loader interpolates `!!js` only inside an entry's `config` (cordis-plugin-loader's `internal/config` handler), so a `!!js` `name` reaches `Entry.import` as a plain object — `failed to import loader entry probe-events ([object Object]): name.startsWith is not a function` |
| `probe-compact.cordis.yml` | second overlay that forces `compaction-basic` into pressure (tiny threshold + one-token retained tail) |
| `run-probe.sh` | bounded runner: builds a throwaway DSH home, boots `dsh --profile headless`, cleans up |
| `out/` | probe run artifacts — **gitignored, never committed**; the findings quote excerpts instead. Machine paths are redacted to `<repo>`/`~` when written |

## Why a throwaway DSH home

`dsh` rewrites `$DSH_HOME/profiles/<name>/cordis.yml` on **every** boot
(`prepareProfile` in `@deepseek-ai/dsh-app-boot`), so booting a profile under
`~/.dsh` mutates it. `run-probe.sh` therefore sets a throwaway home
**outside the repository** (`DSH_HOME=${TMPDIR:-/tmp}/dsh-engram-probe-home`),
copies only the two documents a
headless run needs (`~/.dsh/.credentials.yaml`, `~/.dsh/settings.yaml`), and
deletes the home when the run ends. Bundle rows resolve installation-first, so
the throwaway profile needs no `pnpm install`:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }
```

The throwaway profile deliberately loads **no** third-party plugins (no MCP
bridge, no engram), so probe runs never touch `~/.engram`.

## Re-run

```bash
cd <repo>

# 1. baseline: one-step turn, session-start + turn-stopping ordering
./scripts/probe/run-probe.sh smoke observe \
  "Reply with exactly the word: pong. Do not use any tools."

# 2. multi-step turn: turn-stopping fires once, after the turn's last assistant/message
./scripts/probe/run-probe.sh multistep observe \
  "First use the bash tool to run exactly: echo probe-ok. Then reply with the single word: done. Do not use any other tool."

# 3. abort mid-stream (Q1): cancel the turn after N text-delta chars
PROBE_ABORT_AFTER_CHARS=12 ./scripts/probe/run-probe.sh abort abort \
  "Write a very long, detailed essay (at least 900 words) about the history of tea. Do not use any tools. Output only prose."

# 4. real subagent + child-scope restriction (Q2)
PROBE_DENY=web_search,web_fetch,todo_write ./scripts/probe/run-probe.sh subagent-restrict restrict \
  "Call the subagent tool exactly once with prompt: 'Reply with exactly the word: child-ok' and run_in_background: false. After it returns, reply with the single word: parent-done."

# 5. force real compaction (Q3): does a compaction emit a session-start?
PROBE_EXTRA_PATCHES=probe-compact.cordis.yml ./scripts/probe/run-probe.sh compact observe \
  "Use the bash tool to run 'seq 1 400' and show the output. Then use the bash tool again to run 'seq 1 400' and show the output. Then reply with the single word: compacted-done."

# 6. steer at the stop boundary: shows turn-stopping can fire twice in one turn
./scripts/probe/run-probe.sh steer steer \
  "Reply with the single word: base. Do not use any tools."
```

Each run prints `probe: out=… lines=N` and exits with the headless runner's
status. All runs above complete in under ~8 minutes; wrap them in `timeout`
when running unattended.

## Scenarios

| `PROBE_SCENARIO` | behaviour |
| --- | --- |
| `observe` | log only |
| `abort` | on the root agent's first N text-delta chars of `assistant/chunk`, call `agent.cancel({ kind: 'user' })` (N = `PROBE_ABORT_AFTER_CHARS`) |
| `restrict` | on `agent/created` for a child (`header.origin === 'subagent'`), install `agent.ctx.tools.restrict({ deny: PROBE_DENY })`, log `schemas()` before/after and try executing each denied tool — the **EARLY** install |
| `restrict-late` | do nothing at `agent/created`; install the same mask on the child only at its **first `step/end`**, i.e. after one request was already composed and sent from the unrestricted catalog. Also calls `restrict()` with never-registered names and records the verbatim outcome (throw text or silence) — the **LATE** install |
| `restrict-in-prestep` | install the mask inside the child's **own `agent/pre-step`** waterfall, i.e. after that step's tool directory is already frozen — the **TIGHTEST** late install, which prices the freeze boundary |
| `steer` | on the first `agent/turn-stopping` for the root agent, `agent.steer(...)` once |

## Install-timing runs (per-agent tool masking)

The child task must call a tool at least once: a step that calls a tool is always
followed by another step, so a "one command per step" prompt guarantees a second
`request/header` for the child.

```bash
cd <repo>

CHILD='Run these three bash commands one per step, waiting for each result before starting the next: first echo child-step-one, then echo child-step-two, then echo child-step-three. Then reply with the single word: child-done. Never put two bash calls in the same step.'
TASK="Call the subagent tool exactly once with prompt: '$CHILD' and run_in_background: false. After the subagent returns, reply with the single word: parent-done."

export PROBE_DENY=web_search,web_fetch,todo_write

# early  (agent/created)                  -> child's FIRST header already masked
./scripts/probe/run-probe.sh child-early restrict "$TASK"

# late   (child's first step/end)         -> 1st header unmasked, 2nd masked
./scripts/probe/run-probe.sh child-late restrict-late "$TASK"

# tight  (child's own agent/pre-step)     -> current header unmasked, next masked
./scripts/probe/run-probe.sh child-prestep restrict-in-prestep "$TASK"
```

Read the child's headers out of the JSONL:

```bash
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) {
  const r = JSON.parse(l)
  if (r.type === "request/header" && r.origin === "subagent")
    console.log(r.i, r.t.toFixed(1), r.reason, r.toolCount, JSON.stringify((r.tools||[]).filter((n)=>n.startsWith("web_")||n==="todo_write")))
  else if (r.type === "probe/restrict-late" || r.type === "probe/restrict-in-prestep")
    console.log(r.i, r.t.toFixed(1), r.type, JSON.stringify(r.removed), JSON.stringify(r.unknownOutcomes ?? null))
}' scripts/probe/out/child-late.jsonl
```

## 模型完整性验收（`run-model-integrity.sh`）

`engram-bridge-model-integrity` 的 8.1–8.4 用一套**独立**的 runner：把**真实插件**（本仓库
`dist/index.js`）装进一个一次性 headless 宿主，并让 `searchModelDir` 指向一个宿主**可写**的
模型目录，好让"内容不符"这件事真的发生。

| file | role |
| --- | --- |
| `model-integrity.cordis.yml` | overlay **模板**：插入 `engram-bridge` 行；`command` / `env` / `searchDbPath` / `searchIndexDir` / `searchModelDir` / 回收时长都由 runner 渲染，checked-in 文件不含本机路径 |
| `run-model-integrity.sh` | 建一次性 home（含 engram 库**副本**，免得探测写进用户的真实库）、渲染 overlay、跑 `dsh --profile headless` |

```bash
# 默认：把真机模型目录复制一份进一次性 home，改那一份
./scripts/probe/run-model-integrity.sh hot 'Call the tool mcp__engram__mem_bridge_recall ten times, one call per step …'

# 直接对着真机共享目录跑（需要能写它；期间同机其它 profile 的检索会失败）
MODEL_INTEGRITY_MODEL_DIR=~/.dsh/storages/engram-bridge/model MODEL_INTEGRITY_TAMPER=1 \
  ./scripts/probe/run-model-integrity.sh real-dir '<task>'
```

| var | meaning |
| --- | --- |
| `MODEL_INTEGRITY_MODEL_DIR` | 模型目录；给了就直接用，不给就复制真机那份 |
| `MODEL_INTEGRITY_TAMPER=1` | boot **之前**把 `tokenizer_config.json` 改一个字节，并留下 `.good` 备份 |
| `MODEL_INTEGRITY_HOME` | 一次性 home（默认在 `$TMPDIR`；放仓库内时用 `.accept/`，已 gitignore） |
| `MODEL_INTEGRITY_REUSE_HOME=1` | 复用已有的模型副本（让篡改跨运行存活） |
| `MODEL_INTEGRITY_IDLE_MS` | worker 空闲回收，默认 2000（好让判定在冷路径被触发） |

读它的会话日志（判据 = `request/header` 的 `data.header.tools` 名字列表 + `tool/result` 文本）：

```bash
zstd -dc <home>/sessions/*/session-*/session.v3.jsonl.zstd
```

两点实测注意：

- **在一个全新 home 里第一次跑**：`tools.json` 缓存为空，插件要等 MCP 连接完成才注册 engram
  工具，而一次性任务在 boot 后立刻组第一个请求——于是首个工具面里**没有** `mem_bridge_recall`，
  模型看不到它。第二次运行（缓存已写入）起正常。活宿主不受影响。
- 宿主的 workspace 就是那个一次性 home，所以**只有** home 内的路径能被它的 `bash` 改；要动真机
  模型目录，得从有写权限的 shell 跑（`MODEL_INTEGRITY_MODEL_DIR` 已把这件事做成参数）。

## Env

| var | meaning |
| --- | --- |
| `PROBE_OUT` | JSONL sink (set by the runner) |
| `PROBE_SCENARIO` | comma list of scenarios |
| `PROBE_DENY` | comma list of GLOBAL tool names denied on child scopes |
| `PROBE_ABORT_AFTER_CHARS` | abort threshold (default 8) |
| `PROBE_EXTRA_PATCHES` | extra `--patch` overlays (space separated, relative to `scripts/probe/`) |
| `PROBE_LLM_MODULE` | override for the `@deepseek-ai/dsh-llm` entry used by the `steer` scenario |
| `PROBE_KEEP_HOME=1` | keep the throwaway DSH home for inspection |

## Reading a log

One JSON line per fact, ordered by append time:

```
{"i":0,"t":88.5,"wall":…,"ev":"agent","type":"agent/created","sid":"session-…","origin":null,
 "delegationDepth":null,"parentSession":null,"isSeeded":false,"agentPreset":null,"cwd":"…",
 "headerKeys":[…],"catalog":["bash",…]}
{"i":1,"t":88.8,…,"type":"agent/session-start","source":"startup","commands":["compact",…]}
{"i":3,"t":90.4,…,"ev":"session","type":"turn/start","turn":1}
```

`t` is milliseconds since the probe plugin's `apply` ran; `i` is the global
append index. `ev:"agent"` records an agent-plane event (`agent/*`),
`ev:"session"` a durable `session/event`, `ev:"probe"` a probe action.
