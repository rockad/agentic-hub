/**
 * The PostToolUse drift recorder checks the CURRENT Jev mode: a pin written while Jev was on is dropped without any
 * stdout when Jev was switched off before the run ended, but its drift is still written to the decisions log (the
 * decision was made while Jev was on). Ported from cognitive-engine's workflow-pin-mode tests. Dropped there: the
 * cases about a missing, malformed or explicitly-pointed config file (that package derives "off" from the file; here
 * the hook's mode comes from readJevMode, which has its own tests in config.test.ts and mode-cli.test.ts).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPreToolUse, onWorkflowPostToolUse } from '../claude/hook.ts';
import { rig, wf, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());

const post = (file: string, id = 'toolu_01ABC') => ({ hook_event_name: 'PostToolUse', tool_name: 'Workflow', session_id: 's1', tool_use_id: id, tool_input: { scriptPath: file }, tool_response: {} });
const records = () => r.logs.filter((l) => l.event === 'workflow_changed');

/** A workflow file analysed while Jev is on, then edited: the state every case below starts from. */
async function pinnedAndEdited(): Promise<string> {
  r = rig();
  const file = path.join(r.tmp, 'w.js');
  fs.writeFileSync(file, `await agent('p')`);
  await onPreToolUse(wf({ scriptPath: file }, r), r.d);
  expect(fs.readdirSync(r.pins)).toHaveLength(1);
  fs.writeFileSync(file, `await agent('p', { model: 'opus' })`);
  return file;
}

describe('drift is reported only while Jev is on', () => {
  it('control: Jev still on reports the drift', async () => {
    const file = await pinnedAndEdited();

    const res = await onWorkflowPostToolUse(post(file) as any, r.d);

    expect(res.status).toBe('changed');
    expect(JSON.parse(res.output!).systemMessage).toContain('changed');
  });

  for (const mode of ['off', 'on-demand']) {
    it(`no stdout, pin consumed, drift still logged when Jev was switched to ${mode} after the pin`, async () => {
      const file = await pinnedAndEdited();
      r.mode.value = mode;

      const res = await onWorkflowPostToolUse(post(file) as any, r.d);

      expect(res.status).toBe('off');
      expect(res.output).toBeUndefined();
      expect(fs.readdirSync(r.pins)).toHaveLength(0);
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ tool_name: 'Workflow', tool_use_id: 'toolu_01ABC', session_id: 's1', file, decision: 'allow' });
      expect(records()[0].analysed_sha256).not.toBe(records()[0].current_sha256);
    });
  }

  it('Jev switched off and the file unchanged: nothing is logged', async () => {
    r = rig();
    const file = path.join(r.tmp, 'w.js');
    fs.writeFileSync(file, `await agent('p')`);
    await onPreToolUse(wf({ scriptPath: file }, r), r.d);
    r.mode.value = 'off';

    expect((await onWorkflowPostToolUse(post(file) as any, r.d)).status).toBe('off');
    expect(records()).toEqual([]);
  });

  it('Jev switched off and the file deleted: the drift is logged with a null current hash', async () => {
    const file = await pinnedAndEdited();
    fs.rmSync(file);
    r.mode.value = 'off';

    expect((await onWorkflowPostToolUse(post(file) as any, r.d)).output).toBeUndefined();
    expect(records()[0].current_sha256).toBeNull();
  });

  it('a call made while Jev was off leaves nothing to report after a switch back on', async () => {
    r = rig();
    r.mode.value = 'off';
    const file = path.join(r.tmp, 'w.js');
    fs.writeFileSync(file, `await agent('p')`);
    await onPreToolUse(wf({ scriptPath: file }, r), r.d);
    r.mode.value = 'on';
    fs.writeFileSync(file, `await agent('p', { model: 'opus' })`);

    expect((await onWorkflowPostToolUse(post(file) as any, r.d)).status).toBe('no-pin');
    expect(fs.existsSync(r.pins)).toBe(false);
  });
});
