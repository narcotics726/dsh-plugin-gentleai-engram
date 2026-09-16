import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { errorMessage } from './log.js';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from './recall/protocol.js';

/**
 * The operator path: a human command in the session, not a model tool.
 *
 * It exists for the one case the model-facing entry cannot cover — work larger
 * than any single call may do — and it is the ONLY uncapped path (design D8).
 * Two consequences of running it as a human command rather than a shell script:
 * it reuses the live manager (same paths, same threads, same lock, the resident
 * is quiesced properly) and its lifecycle lands in the session log for free.
 *
 * The registry's abort only stops WAITING and discards the handler's return, so
 * the handler must observe the signal itself (the manager does: it kills the
 * child's process group and waits for it to exit).
 */

export interface RecallCommandDeps {
  run: (exec: { signal?: AbortSignal }) => Promise<string>;
}

export function buildRecallCommandDefinition(deps: RecallCommandDeps): CommandDefinition {
  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    // No arguments: any free text would otherwise be recorded as `command/run`
    // args for a command that has no input.
    recordInput: false,
    handler: async (invocation) => {
      try {
        const summary = await deps.run({ signal: invocation.signal });
        return { kind: 'success', text: `派生索引已追到最新。${summary}` };
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) };
      }
    },
  };
}
