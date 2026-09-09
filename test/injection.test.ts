import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyInjection, chooseProject, injectionForTool, type InjectionInputs } from '../dist/injection.js';

const base: InjectionInputs = {
  workspace: '/ws',
  sessionId: 's1',
  sessionProject: 'from-session',
  overrides: {},
  envProject: 'from-env',
  injectProject: true,
  injectSessionId: true,
};

test('project precedence: explicit > overrides > session > env > none', () => {
  assert.equal(chooseProject({ ...base, overrides: { '/ws': 'from-override' } }).source, 'projectOverrides');
  assert.equal(chooseProject(base).source, 'session');
  assert.equal(chooseProject({ ...base, sessionProject: undefined }).source, 'ENGRAM_PROJECT');
  assert.equal(
    chooseProject({ ...base, sessionProject: undefined, envProject: undefined }).source,
    'none',
  );
  assert.equal(chooseProject({ ...base, injectProject: false }).source, 'disabled');
});

test('a tool that declares project gets it, explicit arguments win', () => {
  const tool = { name: 'mem_save', inputSchema: { properties: { project: {}, session_id: {} } } };
  const out = applyInjection(tool, { title: 't' }, base);
  assert.equal(out.project, 'from-session');
  assert.equal(out.session_id, 's1');
  const explicit = applyInjection(tool, { project: 'mine', session_id: 'other' }, base);
  assert.equal(explicit.project, 'mine');
  assert.equal(explicit.session_id, 'other');
});

test('mem_session_start receives directory, not project', () => {
  const plan = injectionForTool({ name: 'mem_session_start', inputSchema: { properties: { id: {}, directory: {} } } });
  assert.deepEqual(plan, { project: false, sessionId: false, directory: true });
  const out = applyInjection({ name: 'mem_session_start' }, { id: 'x' }, base);
  assert.equal(out.directory, '/ws');
  assert.equal(out.project, undefined);
});

test('mem_save_prompt keeps project injection off but still gets session_id', () => {
  const tool = { name: 'mem_save_prompt', inputSchema: { properties: { project: {}, session_id: {} } } };
  const out = applyInjection(tool, {}, base);
  assert.equal(out.project, undefined);
  assert.equal(out.session_id, 's1');
});

test('switches disable injection', () => {
  const tool = { name: 'mem_save', inputSchema: { properties: { project: {}, session_id: {} } } };
  const out = applyInjection(tool, {}, { ...base, injectProject: false, injectSessionId: false });
  assert.equal(out.project, undefined);
  assert.equal(out.session_id, undefined);
});