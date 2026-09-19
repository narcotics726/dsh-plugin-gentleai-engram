/**
 * The tool surface of the real backend (engram 1.20.0 declares exactly these 22:
 * 18 in its `agent` profile plus 4 in its `admin` profile).
 *
 * It lives in its own module so two consumers share ONE declaration: the stdio
 * stub that answers `tools/list`, and the consistency check that asks whether the
 * shipped protocol text only names tools the model can actually call. A stub that
 * declared only the handful of tools this suite calls would make that check pass
 * vacuously, and duplicating the list would let the two drift.
 */
const schema = (properties, required) => ({ type: 'object', properties, required });

export const TOOLS = [
  {
    name: 'mem_session_start',
    description: 'Start a session',
    inputSchema: schema({ id: { type: 'string' }, directory: { type: 'string' } }, ['id']),
  },
  {
    name: 'mem_capture_passive',
    description: 'Extract learnings from text',
    inputSchema: schema(
      { content: { type: 'string' }, session_id: { type: 'string' }, source: { type: 'string' } },
      ['content'],
    ),
  },
  {
    name: 'mem_save_prompt',
    description: 'Save a user prompt to persistent memory',
    inputSchema: schema({ content: { type: 'string' }, session_id: { type: 'string' } }, ['content']),
  },
  {
    name: 'mem_session_summary',
    description: 'Save an end-of-session summary',
    inputSchema: schema(
      { content: { type: 'string' }, session_id: { type: 'string' }, capture_prompt: { type: 'boolean' } },
      ['content'],
    ),
  },
  {
    name: 'mem_context',
    description: 'Recent memory context',
    inputSchema: schema({ project: { type: 'string' }, limit: { type: 'number' } }, []),
  },
  {
    // The real engram declares a retrieval tool too. The bridge deliberately does
    // NOT register it (the plugin's own entry point replaces it), so the stub has
    // to declare it for that exclusion to be exercised in the default gate.
    name: 'mem_search',
    description: 'Full-text search over memories',
    inputSchema: schema(
      { query: { type: 'string' }, project: { type: 'string' }, match_mode: { type: 'string' }, limit: { type: 'number' } },
      ['query'],
    ),
  },
  {
    name: 'mem_save',
    description: 'Save an observation',
    inputSchema: schema(
      {
        title: { type: 'string' },
        content: { type: 'string' },
        observation: { type: 'string' },
        type: { type: 'string' },
        session_id: { type: 'string' },
        scope: { type: 'string' },
        topic_key: { type: 'string' },
        project: { type: 'string' },
        project_choice_reason: { type: 'string' },
        recovery_token: { type: 'string' },
        capture_prompt: { type: 'boolean' },
      },
      ['title'],
    ),
  },
  {
    name: 'mem_update',
    description: 'Update an existing observation by ID',
    inputSchema: schema(
      {
        id: { type: 'number' },
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string' },
        scope: { type: 'string' },
        topic_key: { type: 'string' },
      },
      ['id'],
    ),
  },
  {
    name: 'mem_get_observation',
    description: 'Full observation content by id',
    inputSchema: schema({ id: { type: 'number' } }, ['id']),
  },
  {
    name: 'mem_suggest_topic_key',
    description: 'Suggest a stable topic_key',
    inputSchema: schema(
      { type: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } },
      [],
    ),
  },
  {
    name: 'mem_session_end',
    description: 'Mark a session completed',
    inputSchema: schema({ id: { type: 'string' }, summary: { type: 'string' } }, ['id']),
  },
  {
    name: 'mem_current_project',
    description: 'Detect the current project',
    inputSchema: schema({}, []),
  },
  {
    name: 'mem_judge',
    description: 'Record a verdict on a pending memory conflict',
    inputSchema: schema(
      {
        judgment_id: { type: 'string' },
        relation: { type: 'string' },
        reason: { type: 'string' },
        evidence: { type: 'string' },
        confidence: { type: 'number' },
        session_id: { type: 'string' },
      },
      ['judgment_id', 'relation'],
    ),
  },
  {
    name: 'mem_compare',
    description: 'Persist a semantic verdict between two observations',
    inputSchema: schema(
      {
        memory_id_a: { type: 'number' },
        memory_id_b: { type: 'number' },
        relation: { type: 'string' },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
        model: { type: 'string' },
      },
      ['memory_id_a', 'memory_id_b', 'relation', 'confidence', 'reasoning'],
    ),
  },
  {
    name: 'mem_doctor',
    description: 'Read-only operational diagnostics',
    inputSchema: schema({ check: { type: 'string' }, project: { type: 'string' } }, []),
  },
  {
    name: 'mem_review',
    description: 'Review observation lifecycle state',
    inputSchema: schema(
      {
        action: { type: 'string' },
        id: { type: 'number' },
        observation_id: { type: 'number' },
        limit: { type: 'number' },
        project: { type: 'string' },
      },
      ['action'],
    ),
  },
  {
    name: 'mem_pin',
    description: 'Pin a local observation',
    inputSchema: schema({ id: { type: 'number' } }, ['id']),
  },
  {
    name: 'mem_unpin',
    description: 'Unpin a local observation',
    inputSchema: schema({ id: { type: 'number' } }, ['id']),
  },
  {
    name: 'mem_delete',
    description: 'Delete an observation by ID',
    inputSchema: schema({ id: { type: 'number' }, hard_delete: { type: 'boolean' } }, ['id']),
  },
  {
    name: 'mem_stats',
    description: 'Memory system statistics',
    inputSchema: schema({ project: { type: 'string' } }, []),
  },
  {
    name: 'mem_timeline',
    description: 'Chronological context around an observation',
    inputSchema: schema(
      { observation_id: { type: 'number' }, before: { type: 'number' }, after: { type: 'number' }, project: { type: 'string' } },
      ['observation_id'],
    ),
  },
  {
    name: 'mem_merge_projects',
    description: 'Merge project name variants (destructive)',
    inputSchema: schema({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
  },
];
