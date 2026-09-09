import type { McpToolDeclaration } from './mcp-client.js';

export interface InjectionInputs {
  /** Session workspace (absolute); the child process cwd and `mem_session_start.directory`. */
  workspace: string | undefined;
  /** dsh session id; engram session identity and `session_id` argument. */
  sessionId: string | undefined;
  /** Project engram itself resolved for this session (binding result). */
  sessionProject: string | undefined;
  overrides: Record<string, string>;
  envProject: string | undefined;
  injectProject: boolean;
  injectSessionId: boolean;
}

export interface ProjectChoice {
  project: string | undefined;
  source: 'projectOverrides' | 'session' | 'ENGRAM_PROJECT' | 'none' | 'disabled';
}

/**
 * Project name precedence. The session-resolved value comes from engram itself
 * (`mem_session_start`), because a git repository's project name can be a label
 * engram stored earlier and cannot be reproduced from the filesystem. The bridge
 * never invents a directory basename: engram rejects unbacked names outright.
 */
export function chooseProject(inputs: InjectionInputs): ProjectChoice {
  if (!inputs.injectProject) return { project: undefined, source: 'disabled' };
  const override = inputs.workspace !== undefined ? inputs.overrides[inputs.workspace] : undefined;
  if (typeof override === 'string' && override !== '') {
    return { project: override, source: 'projectOverrides' };
  }
  if (typeof inputs.sessionProject === 'string' && inputs.sessionProject !== '') {
    return { project: inputs.sessionProject, source: 'session' };
  }
  if (typeof inputs.envProject === 'string' && inputs.envProject !== '') {
    return { project: inputs.envProject, source: 'ENGRAM_PROJECT' };
  }
  return { project: undefined, source: 'none' };
}

export interface ToolInjectionPlan {
  project: boolean;
  sessionId: boolean;
  directory: boolean;
}

/** Which implicit argument a tool accepts. Explicit caller arguments always win. */
export function injectionForTool(tool: McpToolDeclaration): ToolInjectionPlan {
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const declares = (key: string): boolean => Object.prototype.hasOwnProperty.call(properties, key);
  if (tool.name === 'mem_session_start') {
    return { project: false, sessionId: false, directory: true };
  }
  if (tool.name === 'mem_save_prompt') {
    // `project` here is reserved for ambiguous-project recovery, never injected;
    // `session_id` still is.
    return { project: false, sessionId: declares('session_id'), directory: false };
  }
  return { project: declares('project'), sessionId: declares('session_id'), directory: false };
}

export function applyInjection(
  tool: McpToolDeclaration,
  args: Record<string, unknown>,
  inputs: InjectionInputs,
): Record<string, unknown> {
  const plan = injectionForTool(tool);
  const out: Record<string, unknown> = { ...args };
  const setIfAbsent = (key: string, value: unknown): void => {
    if (value !== undefined && out[key] === undefined) out[key] = value;
  };
  if (plan.directory) setIfAbsent('directory', inputs.workspace);
  if (plan.project) setIfAbsent('project', chooseProject(inputs).project);
  if (plan.sessionId && inputs.injectSessionId) setIfAbsent('session_id', inputs.sessionId);
  return out;
}
