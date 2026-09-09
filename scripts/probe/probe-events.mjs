/**
 * Throwaway runtime probe for dsh agent/session events.
 *
 * Loaded as a global Cordis plugin through scripts/probe/probe.cordis.yml. It
 * subscribes to the agent-plane events ('agent/created', 'agent/session-start',
 * 'agent/turn-stopping', 'agent/disposed', 'agent/status', 'agent/error') and
 * to the durable 'session/event' feed, and appends one JSONL line per observed
 * fact to the file named by config.out.
 *
 * Scenario flags (env -> plugin config through probe.cordis.yml):
 *   PROBE_SCENARIO             comma list of: observe, abort, restrict, steer
 *   PROBE_DENY                 comma list of GLOBAL tool names denied on children
 *   PROBE_ABORT_AFTER_CHARS    text-delta chars to accumulate before aborting turn 1
 *
 * Every contribution is a ctx-owned side effect; nothing happens at module scope.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'probe-events'
export const inject = ['tools']

export function apply(ctx, config) {
  const out = config.out
  const scenarios = new Set(
    String(config.scenario || 'observe')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const denyNames = String(config.deny || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const abortAfterChars = Number(config.abortAfterChars ?? 8)

  mkdirSync(dirname(out), { recursive: true })

  // Probe logs are committed as evidence, so machine-specific paths are
  // redacted on write: the repository root becomes '<repo>' and the home
  // directory becomes '~'.
  const repoRoot = process.env.PROBE_REPO_ROOT ?? process.cwd()
  const homeDir = process.env.HOME ?? ''
  const redactPath = (value) => {
    if (typeof value !== 'string') return value ?? null
    const out = homeDir && value.startsWith(homeDir) ? '~' + value.slice(homeDir.length) : value
    return out.split(repoRoot).join('<repo>')
  }

  const t0 = process.hrtime.bigint()
  let i = 0
  const write = (record) => {
    appendFileSync(
      out,
      JSON.stringify({ i: i++, t: Number(process.hrtime.bigint() - t0) / 1e6, wall: Date.now(), ...record }) + '\n',
    )
  }

  const agentBySession = new Map()
  const aborted = new Set()
  const charCount = new Map()
  const steered = new Set()
  const injected = new Set()

  const headerOf = (agent) => agent?.session?.header ?? {}
  const sidOf = (agent) => String(agent?.session?.id ?? 'unknown')
  const toolNames = (agent) => {
    try {
      return ctx.tools.schemas(agent).map((s) => s.name)
    } catch (error) {
      return ['<schemas-error:' + String(error && error.message ? error.message : error) + '>']
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const header = headerOf(agent)
    agentBySession.set(sidOf(agent), agent)
    write({
      ev: 'agent',
      type: 'agent/created',
      sid: sidOf(agent),
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? null,
      parentSession: header.parentSession ?? null,
      isSeeded: header.isSeeded ?? null,
      agentPreset: header.agentPreset ?? null,
      cwd: redactPath(header.cwd),
      headerKeys: Object.keys(header),
      catalog: toolNames(agent),
    })

    if (scenarios.has('restrict') && header.origin === 'subagent' && denyNames.length > 0) {
      const before = toolNames(agent)
      let installed = false
      let installError = null
      try {
        agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: denyNames }), 'probe-events:child-deny')
        installed = true
      } catch (error) {
        installError = String(error && error.message ? error.message : error)
      }
      const after = toolNames(agent)
      write({
        ev: 'probe',
        type: 'probe/restrict',
        sid: sidOf(agent),
        deny: denyNames,
        installed,
        installError,
        before,
        after,
        removed: before.filter((n) => !after.includes(n)),
      })
      void (async () => {
        for (const name of denyNames) {
          let outcome
          try {
            const result = await ctx.tools.execute({
              callId: 'probe-denied-' + name,
              name,
              arguments: {},
              agent,
              signal: new AbortController().signal,
            })
            outcome = {
              isError: result.isError === true,
              error: result.isError === true ? result.error : null,
            }
          } catch (error) {
            outcome = { threw: String(error && error.message ? error.message : error) }
          }
          write({ ev: 'probe', type: 'probe/execute-denied', sid: sidOf(agent), name, outcome })
        }
      })()
    }
  })

  ctx.on('agent/session-start', ({ agent, source }) => {
    let commands = null
    try {
      const runtime = ctx.get('commands')
      if (runtime !== undefined) commands = runtime.list(agent).map((c) => c.name)
    } catch (error) {
      commands = ['<list-error:' + String(error && error.message ? error.message : error) + '>']
    }
    write({
      ev: 'agent',
      type: 'agent/session-start',
      sid: sidOf(agent),
      origin: headerOf(agent).origin ?? null,
      source,
      commands,
    })
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    write({
      ev: 'agent',
      type: 'agent/turn-stopping',
      sid: sidOf(agent),
      origin: headerOf(agent).origin ?? null,
      turn,
    })
    // Scenario 'steer': object once at the first stop boundary, which the loop
    // contract says runs another step and re-evaluates the same boundary.
    if (scenarios.has('steer') && headerOf(agent).origin !== 'subagent' && !steered.has(sidOf(agent))) {
      steered.add(sidOf(agent))
      try {
        const llm = await import(config.llmModule)
        agent.steer(
          llm.createUserMessage({
            content: [{ type: 'text', text: 'Also include the word: steered-extra.' }],
            source: { kind: 'plugin', plugin: 'probe-events' },
          }),
        )
        write({ ev: 'probe', type: 'probe/steer', sid: sidOf(agent), turn })
      } catch (error) {
        write({
          ev: 'probe',
          type: 'probe/steer-failed',
          sid: sidOf(agent),
          error: String(error && error.message ? error.message : error),
        })
      }
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const names = toolNames(payload.agent)
    write({
      ev: 'agent',
      type: 'agent/pre-step',
      sid: sidOf(payload.agent),
      turn: payload.turn,
      step: payload.step,
      catalog: names.length,
      engram: names.filter((n) => n.startsWith('mcp__engram__')).length,
      hasNext: typeof next === 'function',
    })
    return await next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    write({ ev: 'agent', type: 'agent/status', sid: sidOf(agent), status })
  })

  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    write({
      ev: 'agent',
      type: 'agent/error',
      sid: sidOf(agent),
      turn,
      step,
      error: String(error && error.message ? error.message : error),
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    agentBySession.delete(sidOf(agent))
    write({ ev: 'agent', type: 'agent/disposed', sid: sidOf(agent) })
  })

  const KEEP = new Set([
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'request/header',
    'compaction/start',
    'compaction/summary',
    'compaction/end',
    'compaction/prune',
  ])

  ctx.on('session/event', (session, event) => {
    const sid = String(session.id)
    const agent = agentBySession.get(sid)
    const origin = agent ? (headerOf(agent).origin ?? null) : null

    if (scenarios.has('abort') && agent !== undefined && origin === null && event.type === 'assistant/chunk') {
      const chunk = event.data?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const seen = (charCount.get(sid) ?? 0) + chunk.text.length
        charCount.set(sid, seen)
        if (seen >= abortAfterChars && !aborted.has(sid)) {
          aborted.add(sid)
          write({
            ev: 'probe',
            type: 'probe/abort-request',
            sid,
            turn: event.data?.turn ?? null,
            step: event.data?.step ?? null,
            charsSeen: seen,
            cause: { kind: 'user' },
          })
          agent.cancel({ kind: 'user' })
        }
      }
      return
    }

    // Scenario 'inject': prove that agent.inject() issued at compaction/end is
    // delivered to the model-visible surface before the next step.
    if (
      scenarios.has('inject') &&
      event.type === 'compaction/end' &&
      agent !== undefined &&
      origin === null &&
      !injected.has(sid)
    ) {
      injected.add(sid)
      void (async () => {
        try {
          const llm = await import(config.llmModule)
          agent.inject(
            llm.createUserMessage({
              content: [{ type: 'text', text: 'PROBE-INJECT-MARKER: compaction recall context.' }],
              source: { kind: 'plugin', plugin: 'probe-events' },
            }),
          )
          write({ ev: 'probe', type: 'probe/inject', sid, at: 'compaction/end' })
        } catch (error) {
          write({
            ev: 'probe',
            type: 'probe/inject-failed',
            sid,
            error: String(error && error.message ? error.message : error),
          })
        }
      })()
    }

    if (!KEEP.has(event.type)) return

    const record = { ev: 'session', type: event.type, sid, origin }
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        record.turn = data.turn
        break
      case 'turn/end': {
        record.turn = data.turn
        record.reason = data.reason ?? null
        // Late catalog check: proves whether tools registered asynchronously
        // (e.g. after a load-time capability discovery) ever reach this agent.
        if (agent !== undefined) {
          const names = toolNames(agent)
          record.catalogAfter = names.length
          record.engramAfter = names.filter((n) => n.startsWith('mcp__engram__')).length
        }
        break
      }
      case 'step/start':
      case 'step/end':
        record.turn = data.turn
        record.step = data.step
        break
      case 'assistant/message':
        record.turn = data.turn
        record.step = data.step
        record.interrupted = data.interrupted === true
        record.blocks = Array.isArray(data.message?.content) ? data.message.content.map((b) => b.type) : null
        record.text = Array.isArray(data.message?.content)
          ? data.message.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
              .slice(0, 120)
          : null
        record.usage = data.usage ?? null
        break
      case 'request/header':
        record.reason = data.reason ?? null
        record.tools = Array.isArray(data.header?.tools) ? data.header.tools.map((t) => t.name) : null
        record.toolCount = Array.isArray(data.header?.tools) ? data.header.tools.length : null
        record.model = data.header?.config?.model ?? null
        break
      case 'tool/call':
        record.name = data.name ?? data.call?.name ?? null
        break
      case 'tool/result':
        record.name = data.name ?? null
        record.isError = data.isError ?? null
        break
      case 'user/message':
        record.source = data.source?.kind ?? null
        record.text = Array.isArray(data.content)
          ? data.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
              .slice(0, 120)
          : null
        break
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
      case 'compaction/prune':
        record.keys = Object.keys(data)
        break
      default:
        break
    }
    write(record)
  })
}
