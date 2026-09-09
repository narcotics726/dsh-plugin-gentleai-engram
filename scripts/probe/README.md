# scripts/probe — throwaway runtime probe for dsh agent/session events

Self-contained probe harness used to answer four runtime questions about dsh's
event surface (results in `docs/event-findings.md`). Everything here is
throwaway: nothing under `openspec/`, `src/`, `~/.dsh` or `~/.engram` is touched.

## Files

| file | role |
| --- | --- |
| `probe-events.mjs` | the Cordis plugin under test: subscribes to the agent-plane events and to `session/event`, appends one JSONL line per fact |
| `probe.cordis.yml` | `--patch` overlay that inserts the plugin as a global row; config comes from `PROBE_*` env |
| `probe-compact.cordis.yml` | second overlay that forces `compaction-basic` into pressure (tiny threshold + one-token retained tail) |
| `run-probe.sh` | bounded runner: builds a throwaway DSH home, boots `dsh --profile headless`, cleans up |
| `out/*.jsonl` | the raw probe logs the findings quote (kept as evidence) |

## Why a throwaway DSH home

`dsh` rewrites `$DSH_HOME/profiles/<name>/cordis.yml` on **every** boot
(`prepareProfile` in `@deepseek-ai/dsh-app-boot`), so booting a profile under
`~/.dsh` mutates it. `run-probe.sh` therefore sets
`DSH_HOME=<repo>/scripts/probe/tmp/dsh-home`, copies only the two documents a
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
| `restrict` | on `agent/created` for a child (`header.origin === 'subagent'`), install `agent.ctx.tools.restrict({ deny: PROBE_DENY })`, log `schemas()` before/after and try executing each denied tool |
| `steer` | on the first `agent/turn-stopping` for the root agent, `agent.steer(...)` once |

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
