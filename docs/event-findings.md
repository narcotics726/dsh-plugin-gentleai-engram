# dsh runtime event findings (probe report)

Runtime probe of the installed dsh build, answering four questions about the
agent-plane event surface. Everything here is **observed**, not inferred from
source, unless a paragraph says otherwise.

- Harness: `@deepseek-ai/dsh@0.1.2-rc.1` at the global install root
  (`<dsh-install-root>`, typically `$(npm root -g)/@deepseek-ai/dsh`)
- Profile: a throwaway `headless` profile (`@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-headless`), booted with
  `dsh --profile headless --patch scripts/probe/probe.cordis.yml "<task>"`
- Probe plugin: `scripts/probe/probe-events.mjs` (global `ctx.on` listeners on
  `agent/*` and `session/event`), logs to `scripts/probe/out/` — **gitignored, the
  raw logs are not committed**; every excerpt below is quoted from a real run
- dsh package version: `0.1.2-rc.1`; the global install has **no `.git`**, so no commit hash exists
- engram: `1.20.0` (`/opt/homebrew/bin/engram` → `Cellar/engram/1.20.0/bin/engram`)
- node: `v26.7.0`; probed 2026-09-09
- Timestamps: `t` = milliseconds since the probe plugin's `apply` ran
- Method and re-run instructions: `scripts/probe/README.md`

**Why a throwaway DSH home:** `dsh` rewrites
`$DSH_HOME/profiles/<name>/cordis.yml` on every boot, and this session's file
sandbox forbids writes under `~/.dsh`. All runs therefore use a throwaway
home **outside the repository** (`DSH_HOME=${TMPDIR:-/tmp}/dsh-engram-probe-home`)
with only
`.credentials.yaml`/`settings.yaml` copied in. `~/.dsh` was never written
(its `profiles/headless/cordis.yml` mtime stayed `Sep 7 14:29`).

---

## Q1 — Does `agent/turn-stopping` fire for an aborted turn? (blocking)

**ANSWER: NO.** For a turn aborted mid-stream, `agent/turn-stopping` does **not**
fire at all. In a normal turn it fires exactly **once**, **after** the turn's last
`assistant/message` (and after that step's `step/end`), **before** `turn/end`.
The "exactly once" guarantee has one documented and now demonstrated exception:
a `turn-stopping` listener that steers causes another step and a second
`turn-stopping` for the same turn.

### Trigger

`PROBE_ABORT_AFTER_CHARS=12 ./scripts/probe/run-probe.sh abort abort "<write a 900-word essay>"`.
The probe counts `text-delta` chars on `session/event assistant/chunk` for the
root agent and calls `agent.cancel({ kind: 'user' })` at 14 chars — i.e. strictly
mid-stream, while the adapter is still producing output.

### Evidence — aborted turn (the `abort` run, 15 lines total)

```jsonl
84.3  {"ev":"agent","type":"agent/session-start",…,"source":"startup"}
85.7  {"ev":"session","type":"turn/start",…,"turn":1}
155.1 {"ev":"session","type":"step/start",…,"turn":1,"step":1}
1130.5 {"ev":"probe","type":"probe/abort-request",…,"turn":1,"step":1,"charsSeen":14,"cause":{"kind":"user"}}
1135.7 {"ev":"session","type":"assistant/message",…,"turn":1,"step":1,"interrupted":true,"blocks":["reasoning","text"],"text":"The history of",…}
1136.7 {"ev":"session","type":"step/end",…,"turn":1,"step":1}
1138.0 {"ev":"session","type":"turn/end",…,"turn":1,"reason":{"kind":"aborted","reason":{"kind":"user"}}}
1139.7 {"ev":"agent","type":"agent/status",…,"status":"idle"}
```

The `assistant/message` carries `interrupted: true` and the partial content
assembled before cancellation. **No `agent/turn-stopping` line exists anywhere in
this log** — the only agent-plane events are `agent/created`, `agent/session-start`,
`agent/status(running)`, `agent/status(idle)`.

### Evidence — normal 2-step turn (the `multistep` run)

```jsonl
928.2  {"ev":"session","type":"assistant/message",…,"step":1,"interrupted":false,"blocks":["tool-call"]}
986.6  {"ev":"session","type":"step/end",…,"turn":1,"step":1}
993.3  {"ev":"session","type":"step/start",…,"turn":1,"step":2}
1539.8 {"ev":"session","type":"assistant/message",…,"step":2,"interrupted":false,"blocks":["text"],"text":"done"}
1541.3 {"ev":"session","type":"step/end",…,"turn":1,"step":2}
1543.0 {"ev":"agent","type":"agent/turn-stopping",…,"turn":1}      ← exactly one
1543.8 {"ev":"session","type":"turn/end",…,"turn":1,"reason":{"kind":"completed"}}
```

One `turn-stopping` for the whole 2-step turn, after the turn's last
`assistant/message` (1539.8) and `step/end` (1541.3), before `turn/end` (1543.8).
Same ordering in the 1-step `smoke` run (message 697.4 → step/end 698.6
→ turn-stopping 699.4 → turn/end 699.6) and in the child/parent turns of the
`subagent-restrict` run.

### Evidence — the "exactly once" exception (the `steer` run)

The probe steers once from inside the first `turn-stopping` listener:

```jsonl
676.8  {"ev":"session","type":"assistant/message",…,"step":1,"text":"base"}
677.8  {"ev":"agent","type":"agent/turn-stopping",…,"turn":1}      ← 1st
678.9  {"ev":"probe","type":"probe/steer",…,"turn":1}
695.3  {"ev":"session","type":"step/start",…,"turn":1,"step":2}
1415.9 {"ev":"session","type":"assistant/message",…,"step":2,"text":"base steered-extra"}
1418.2 {"ev":"agent","type":"agent/turn-stopping",…,"turn":1}      ← 2nd, SAME turn
1418.9 {"ev":"session","type":"turn/end",…,"turn":1,"reason":{"kind":"completed"}}
```

So: once per stop-boundary evaluation, and a listener that steers earns a second
evaluation for the same turn. Listeners that must act once per turn need their
own per-turn latch.

### Source corroboration (read, not run)

`@deepseek-ai/dsh-agent-loop/lib/index.js:570` dispatches
`agent/turn-stopping` only inside the normal path
(`if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial(…); signal.throwIfAborted() }`).
An abort throws out of the step loop first, is caught as `{kind:'aborted'}`, and
re-thrown, so the dispatch is never reached — which is exactly what the log shows.

---

## Q2 — Is `origin`/`delegationDepth` readable at `agent/created`, and does `restrict()` there remove tools from the child's catalog? (blocking)

**ANSWER: YES to both.**
At `agent/created` the child's `agent.session.header` already exposes
`origin: 'subagent'` and `delegationDepth: 1` (plus `parentSession`), and a
`restrict({ deny: [...] })` installed in that window through
`payload.agent.ctx.tools.restrict(...)` **removes exactly those global tools from
the child's model-facing catalog** (26 → 23 tool schemas in its logged
`request/header`) **and makes them refuse to execute** (`UNKNOWN_TOOL`).

### Trigger

`PROBE_DENY=web_search,web_fetch,todo_write ./scripts/probe/run-probe.sh subagent-restrict restrict "Call the subagent tool exactly once …"`.
A real in-process spawn through the base `subagent` tool
(`@deepseek-ai/dsh-tool-subagent` → `@deepseek-ai/dsh-subagent-spawn-in-process`).

### Evidence — header readable at `agent/created` (the `subagent-restrict` run)

```jsonl
1072.1 {"ev":"agent","type":"agent/created","sid":"f2e15d83-a64d-4001-a9c1-e7d1c9e13725",
        "origin":"subagent","delegationDepth":1,
        "parentSession":"session-a7156a2b-30ad-407d-aac4-c00d7f8b969e",
        "isSeeded":false,"agentPreset":null,"cwd":"<repo>"}
```

`headerKeys` on that child record: `["version","id","createdAt","cwd","parentSession","isSeeded","origin","delegationDepth"]`
— i.e. `origin` and `delegationDepth` are present on the header at creation
time, before `agent/session-start` (1077.0) and before the child's first
`step/start` (1134.8).

### Evidence — the restriction actually filters the model-facing catalog

Installed in the `agent/created` window as
`agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: [...] }))`:

```jsonl
1075.5 {"ev":"probe","type":"probe/restrict","sid":"f2e15d83-…","deny":["web_search","web_fetch","todo_write"],
        "installed":true,"installError":null,"removed":["web_search","web_fetch","todo_write"]}
```

`ctx.tools.schemas(child)` (the registry's own model-facing projection):

```
before (26): job_output job_list job_kill glob grep skill web_search web_fetch exit_plan_mode
             todo_write send_message interrupt_agent list_agents get_goal create_goal update_goal
             bash read write edit str_replace_editor workflow ralph subagent subagent_fork read_image
after  (23): …same list minus web_search, web_fetch, todo_write
```

The child's own durable request header confirms the same set reached the model:

```jsonl
1136.6 {"ev":"session","type":"request/header","sid":"f2e15d83-…","origin":"subagent","reason":"initial","toolCount":23,
        "tools":["bash","create_goal","edit","exit_plan_mode","get_goal","glob","grep","interrupt_agent",
                 "job_kill","job_list","job_output","list_agents","ralph","read","read_image","send_message",
                 "skill","str_replace_editor","subagent","subagent_fork","update_goal","workflow","write"]}
```

Parent's first request header in the same run, for contrast, has `toolCount: 26`
and includes `web_search`, `web_fetch`, `todo_write`.

### Evidence — denied tools also refuse to execute in the child's scope

The probe called `ctx.tools.execute({ name, agent: child, … })` for each denied name:

```jsonl
1112.4 {"ev":"probe","type":"probe/execute-denied","name":"web_search","outcome":{"isError":true,
        "error":{"message":"unknown tool \"web_search\"","info":{"name":"ToolNotFoundError","code":"UNKNOWN_TOOL"}}}}
1120.9 … "web_fetch"  → UNKNOWN_TOOL
1121.4 … "todo_write" → UNKNOWN_TOOL
```

The child then ran normally (`turn/end` reason `completed`, 2173.0) and was
disposed at 2182.1 (`agent/disposed`), so the child-scoped restriction did not
disturb the parent or the child's own lifecycle.

---

## Q3 — Are the `agent/session-start` sources `clear` and `compact` actually produced?

**ANSWER: NO for `compact` (demonstrated: real compaction ran twice with no new
session-start), and NO for `clear` (no producer and no command exists in this
build; could not be triggered because nothing can trigger it).** The only source
value observed in any run is `'startup'` (root and subagent children alike).
`'resume'` has a producer (`AgentLoop.resumeWith` → `setupAndPublish(…, "resume")`)
but **UNKNOWN — not triggered** here: the headless one-shot app exposes no
resume entry point, so this probe could not exercise it.

### Trigger — real compaction

`PROBE_EXTRA_PATCHES=probe-compact.cordis.yml ./scripts/probe/run-probe.sh compact observe "…seq 1 400…"`,
where `probe-compact.cordis.yml` overrides the `compaction-basic` row
(`auto: true`, `thresholdRatio: 0.001`, `retainTokens: 1`) so the step-boundary
pressure check fires on a short conversation.

### Evidence — compaction happened, no session-start (the `compact` run)

```jsonl
80.4   {"ev":"agent","type":"agent/session-start",…,"source":"startup","commands":["compact","feedback","goal","permission","plan"]}
156.2  {"ev":"session","type":"step/start",…,"turn":1,"step":1}
1313.1 {"ev":"session","type":"step/end",…,"turn":1,"step":1}
1321.9 {"ev":"session","type":"compaction/start",…}
4827.2 {"ev":"session","type":"compaction/summary",…}
4829.1 {"ev":"session","type":"compaction/end",…}
4831.9 {"ev":"session","type":"compaction/start",…}     ← second cycle
7372.5 {"ev":"session","type":"compaction/summary",…}
7375.6 {"ev":"session","type":"compaction/end",…}
7389.2 {"ev":"session","type":"step/start",…,"turn":1,"step":2}
7828.2 {"ev":"session","type":"turn/end",…,"turn":1,"reason":{"kind":"completed"}}
```

Two complete `compaction/start → summary → end` cycles landed between step 1 and
step 2 of the **same turn**, and the log contains **exactly one
`agent/session-start`** — the initial `'startup'` at 80.4. Compaction does not
restart the session lifecycle and never emits `source: 'compact'`.

### Evidence — no `clear` command exists to trigger

`ctx.commands.list(agent)` at `agent/session-start`, logged verbatim:

```
["compact","feedback","goal","permission","plan"]
```

There is no `clear`. Static sweep of the installed packages:
`grep -rn "name: \"clear\"" --include=*.js` across all
`@deepseek-ai/*` packages finds exactly one hit — `@deepseek-ai/dsh-command-goal`
registers `/goal clear`, a *goal* operation (`GoalOperation = …|'clear'`), which
never touches the session lifecycle. The web profile's composition (checked with
`DSH_HOME=<throwaway> dsh --profile web --dump-config`) mounts the same
`commands` + `command-compact` rows and adds no clear command.

### Evidence — only two producers of `source`

`grep -rn "publish(" @deepseek-ai/dsh-agent-loop/lib/index.js` yields exactly:

```
1291: return prepared.publish("startup").agent;                        // AgentLoop.create
1331: return prepared.publish(source);                                 // setupAndPublish
```

and the only `setupAndPublish` call sites pass `"startup"` (createAgent, :1315)
or `"resume"` (resumeWith, :1378). `SessionStartSource` is
`'startup' | 'resume' | 'clear' | 'compact'`, but nothing in this build ever
constructs `'clear'` or `'compact'`.

**UNKNOWN — could not trigger:** `'clear'` (no trigger exists) and `'resume'`
(no resume entry point in the headless app; producer confirmed only by reading
`agent-loop`). No claim is made about whether a future or third-party layer
could call `publish('clear')`.

---

## Q4 — Does `agent/session-start` fire before the first `step/start`?

**ANSWER: YES — and before the first `turn/start` as well.** In every run the
ordering was `agent/created` → `agent/session-start` → `agent/status(running)`
→ `turn/start` → `step/start`.

### Evidence

| run | `agent/session-start` | first `turn/start` | first `step/start` |
| --- | --- | --- | --- |
| `smoke` | 88.8 (`startup`) | 90.4 | 162.2 |
| `multistep` | 81.4 (`startup`) | 82.7 | 154.1 |
| `abort` | 84.3 (`startup`) | 85.7 | 155.1 |
| `compact` | 80.4 (`startup`) | 81.9 | 156.2 |
| `subagent-restrict` (child) | 1077.0 (`startup`) | 1080.3 | 1134.8 |

Verbatim from the `smoke` run:

```jsonl
88.5 {"ev":"agent","type":"agent/created",…}
88.8 {"ev":"agent","type":"agent/session-start",…,"source":"startup"}
90.1 {"ev":"agent","type":"agent/status",…,"status":"running"}
90.4 {"ev":"session","type":"turn/start",…,"turn":1}
162.2 {"ev":"session","type":"step/start",…,"turn":1,"step":1}
```

So a `session-start` listener runs with no turn open: `agent.inject()` there is
in time for the first request, and no `step/start` (or `turn/start`) can be
observed before it. The 71 ms gap between `turn/start` and `step/start` in the
smoke run is the pre-step assembly (system prompt + skill catalog), not reordering.

---

## Surprises worth carrying forward

1. **A real compaction is invisible on the agent plane.** Two full compaction
   cycles ran inside one turn with zero agent-plane events; only durable
   `session/event compaction/*` records exist. Anything that must react to
   compaction has to watch `session/event`, not `agent/*`.
2. **Aborted turns are silent at the turn-stopping seam.** Code that closes
   per-turn bookkeeping in `agent/turn-stopping` will leak for every cancelled
   turn; the durable signal is `turn/end` with `reason.kind === 'aborted'`.
3. **`turn-stopping` is not once-per-turn in the presence of steering** — a
   listener that steers re-arms the same boundary (observed 2 dispatches for
   turn 1). Deduplicate per turn if the listener must act once.
4. **The child's `header.origin`/`delegationDepth` are available *before*
   `agent/session-start`**, which makes `agent/created` a usable place for
   child-only policy — and `restrict()` there provably reaches the child's first
   model request.
5. **Booting any dsh profile rewrites `$DSH_HOME/profiles/<name>/cordis.yml`.**
   Probing `~/.dsh` profiles in place is therefore a write to `~/.dsh`; redirect
   `DSH_HOME` for any probe (this sandbox refuses the write outright).
6. **`ctx.commands.list(agent)` is a cheap runtime truth source** for "which
   slash commands exist" — it settled the `/clear` question without guessing
   from package names.

---

## Session-event envelope anchors (2026-09-10, added by engram-bridge-p0-fixes)

Why this section exists: the probe below already read `event.data.*`, but this document
recorded only the *field names* and not the layer they live in — and the implementation
transcribed the fields as if they were top level. Two capabilities (passive capture,
compaction recovery) were dead for a day as a result. **Every anchor here states which
layer the field sits on.**

| Fact | Evidence |
| --- | --- |
| A session event is an envelope `{type, seq, time, data, …surfaceMetadata}` | `@deepseek-ai/dsh-session/lib/index.js:1416-1422` (`append` builds a `deepFreeze` with `data: dataSnapshot`) |
| `snapshotEvents()` returns those envelopes unchanged | same file `:1342-1347` |
| A `session/event` listener receives `[session, envelope]` | same file `:1427` (`const callbackArgs = [this, event]`) |
| Key set of a real `assistant/message` | `[type, seq, time, data, sourceEventSeqs, surfaceOp]`, with `data = {turn, step, message, usage}` (real session `session-632a0f3e`) |
| `SessionEvent` is the discriminated union over `SessionEventMap` | `dsh-session/lib/types/types.d.ts:435-442` |
| `dsh-session`'s map does **not** contain `compaction/*`; the compaction package declares them by module augmentation | `dsh-compaction/lib/types/types.d.ts:14`, with `compaction/summary` at `:35` and `compaction/end` at `:73` |
| `agent/*` payloads are NOT envelopes | `agent/turn-stopping` = `{agent, turn, signal}` (`dsh-agent/lib/types/runtime-types.d.ts:305`), `agent/session-start` = `{agent, source}`, `agent/created` = `{agent}`; `agent` is fused in by the dispatcher (`dsh-agent/lib/index.js:335-339`) |
| The model-visible tool surface is NOT in `request/header.tools` (web/ptc) | `data.header.tools` holds only `[{name:'run_code',…}]`; the tool declaration block is inside `data.header.system` (22 `mcp__engram__*` names, each occurring twice) |

Reproduce the last two rows: decompress a session log with `zstd -dc` (Node's
`zstdDecompressSync` only yields the first frame) and inspect the `request/header` events.

