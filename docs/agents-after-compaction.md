# Mirror: `~/.dsh/AGENTS.md` → `## After compaction`

This file mirrors the `## After compaction` section of the machine-local protocol file
`~/.dsh/AGENTS.md`, which is **not** in this repository. The mirror exists so the wording this
plugin's behavior depends on is auditable and versioned alongside the code; keep the two in sync
whenever either side changes (task 4.2 of the archived change that introduced the wake-on-
compaction behavior).

```markdown
## After compaction

The plugin persists each compaction summary to engram automatically
(`compaction/summary` → `mem_session_summary`; engram stores it as an
`observations` row of type `session_summary` — its `sessions.summary` column is never
written), so you do NOT need to re-save the summary yourself.

After `compaction/end` the plugin delivers a bounded recall of recent memory. How it
arrives depends on who owns the compaction:

- **A standalone manual `/compact`** (a transaction between turns) **wakes you into a
  self-recovery turn of its own**, immediately — it does not wait for the user. In that
  turn reply with ONE short sentence saying what you recovered and any obvious gap, and
  start no new work. Do not append a `## Key Learnings:` section: that turn is not a task.
  The user's next message is then handled as a normal turn of its own.
- **A compaction owned by a running turn** delivers the recall into that same turn at its
  next step boundary — no extra turn is created.

If user input accompanies the recall turn (the wake can race the user's next message),
answer that input and treat the recall as background instead of replying to it separately.

To recover more context: call `mcp__engram__mem_context` (or `mem_search`), then continue.
Setting `recallWakeup: false` makes a manual compaction deliver without waking — the recall
then waits for the user's next message, which is a degraded mode (it can be discarded).
```
