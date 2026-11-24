/** src/core/elevation-answer.ts: the rules both harnesses share (2.3.21). */
import { describe, it, expect } from 'bun:test';
import {
  ELEVATION_LABELS,
  cappedEffort,
  elevationAnswerFields,
  elevationLabelList,
  markOnceUsed,
  normalizeAnswerLabel,
  notRecordedLine,
  onceLive,
  parseAnswerLabel,
  recordedNoLine,
  recordedYesLine,
  storedClause
} from '../src/core/elevation-answer.ts';

describe('the labels', () => {
  it('four exact labels, in order, no timed scope', () => {
    expect(elevationLabelList(ELEVATION_LABELS.noOnce('sonnet'))).toBe("'Yes, once', 'Yes, for this session', 'No, proceed on sonnet', \"No, don't ask again this session\"");
    expect(elevationLabelList(ELEVATION_LABELS.noEffort('high'))).toContain("'No, run at high'");
  });

  it.each([
    ['Yes, once', { answer: 'yes', scope: 'once' }],
    ['Yes, for this session', { answer: 'yes', scope: 'session' }],
    ['No, proceed on sonnet', { answer: 'no', scope: 'once', noTarget: 'sonnet' }],
    ["No, don't ask again this session", { answer: 'no', scope: 'session' }],
    ['No, don’t ask again this session', { answer: 'no', scope: 'session' }],
    ['(Recommended) Yes, once', { answer: 'yes', scope: 'once' }],
    ['Yes, for this session (Recommended)', { answer: 'yes', scope: 'session' }],
    ['  Yes, once  ', { answer: 'yes', scope: 'once' }]
  ])('%j parses', (label, parsed) => {
    expect(parseAnswerLabel(label, 'model')).toEqual(parsed as any);
  });

  it.each(['Yes, for the next 5 minutes', 'yes once', 'Yes, once, but only on flash', 'No', 'No, proceed on', 'No, not even once', 'Yes, once\nand rm -rf', '', undefined, null, 5, [['Yes, once']]])(
    '%j is not an answer',
    (label) => {
      expect(parseAnswerLabel(label, 'model')).toBeNull();
    }
  );

  it('the effort question has its own No', () => {
    expect(parseAnswerLabel('No, run at high', 'effort')).toEqual({ answer: 'no', scope: 'once', noTarget: 'high' });
    expect(parseAnswerLabel('No, run at high', 'model')).toBeNull();
    expect(parseAnswerLabel('No, proceed on sonnet', 'effort')).toBeNull();
  });

  it('normalizeAnswerLabel strips the tag and curly apostrophes only', () => {
    expect(normalizeAnswerLabel('(Recommended) No, don’t ask again this session')).toBe("No, don't ask again this session");
  });
});

describe('a once is live only in its turn', () => {
  it('a session answer always, a once with its turn only', () => {
    expect(onceLive({ scope: 'session' }, undefined)).toBe(true);
    expect(onceLive({ scope: 'once', turn: 'p1' }, 'p1')).toBe(true);
    expect(onceLive({ scope: 'once', turn: 'p1' }, 'p2')).toBe(false);
    expect(onceLive({ scope: 'once' }, 'p1')).toBe(false); // a record with no turn (an old file) is never live
    expect(onceLive({ scope: 'once', turn: 'p1' }, undefined)).toBe(false);
  });

  it('marks a once used for the turn, keeps only the current turn\'s marks, and is bounded', () => {
    let used = markOnceUsed(undefined, 'opus', 'p1');
    used = markOnceUsed(used, 'sonnet', 'p1');
    expect(used).toEqual([{ key: 'opus', turn: 'p1' }, { key: 'sonnet', turn: 'p1' }]);
    expect(markOnceUsed(used, 'opus', 'p2')).toEqual([{ key: 'opus', turn: 'p2' }]);
    for (let i = 0; i < 40; i++) used = markOnceUsed(used, `m${i}`, 'p1');
    expect(used.length).toBeLessThanOrEqual(16);
  });
});

describe('the effort cap', () => {
  it('the marker\'s effort, never above what Jev prescribed; none prescribed or none named: none', () => {
    expect(cappedEffort('max', 'xhigh')).toBe('xhigh');
    expect(cappedEffort('high', 'xhigh')).toBe('high');
    expect(cappedEffort('xhigh', undefined)).toBeUndefined();
    expect(cappedEffort(undefined, 'xhigh')).toBeUndefined();
  });
});

describe('what a deny says is stored', () => {
  const base = { kind: 'model' as const, subject: 'opus', turn: 'p1', onceUsedThisTurn: false };

  it('none', () => {
    expect(storedClause({ ...base, covering: [] })).toEqual({ stored: 'none', text: 'Stored: no approval for opus in this session.' });
  });
  it('once-used', () => {
    expect(storedClause({ ...base, covering: [], onceUsedThisTurn: true })).toEqual({ stored: 'once-used', text: 'Stored: the once approval was used by an earlier launch in this turn.' });
  });
  it('once-stale', () => {
    expect(storedClause({ ...base, covering: [{ scope: 'once', turn: 'p0', effort: 'high' }] })).toEqual({ stored: 'once-stale', text: 'Stored: a once approval from an earlier turn was dropped.' });
  });
  it('effort-below', () => {
    expect(storedClause({ ...base, covering: [{ scope: 'session', effort: 'high' }], neededEffort: 'xhigh' })).toEqual({
      stored: 'effort-below',
      text: 'Stored: the session approval covers opus up to high; this call asks xhigh.'
    });
  });
  it('effort-below wins over a used once; a covering approval within the effort is not "below"', () => {
    expect(storedClause({ ...base, covering: [{ scope: 'session', effort: 'high' }], neededEffort: 'xhigh', onceUsedThisTurn: true }).stored).toBe('effort-below');
    expect(storedClause({ ...base, covering: [{ scope: 'session', effort: 'xhigh' }], neededEffort: 'high' }).stored).toBe('none');
  });
  it('the effort question names the level', () => {
    expect(storedClause({ kind: 'effort', subject: 'xhigh', covering: [], turn: 'p1', onceUsedThisTurn: false }).text).toBe('Stored: no approval for effort xhigh in this session.');
    expect(storedClause({ kind: 'effort', subject: 'max', covering: [{ scope: 'session', effort: 'xhigh' }], turn: 'p1', neededEffort: 'max', onceUsedThisTurn: false }).text).toBe(
      'Stored: the session approval covers effort up to xhigh; this call asks max.'
    );
  });
});

describe('the lines and the row', () => {
  it('recorded', () => {
    expect(recordedYesLine({ kind: 'model', subject: 'opus', scope: 'once', effort: 'xhigh' })).toBe('[jev] Recorded: opus, once (this turn) up to xhigh. Relaunch now.');
    expect(recordedYesLine({ kind: 'model', subject: 'opus', scope: 'session', effort: null })).toBe('[jev] Recorded: opus, for this session up to high. Relaunch now.');
    expect(recordedNoLine({ kind: 'model', subject: 'opus', scope: 'session', target: 'sonnet' })).toBe('[jev] Recorded: No for opus for this session; launches run on sonnet.');
    expect(recordedNoLine({ kind: 'effort', subject: 'max', scope: 'once', target: 'high' })).toContain('runs at high');
  });

  it.each([
    ['label', 'the answer was not one of the four exact labels'],
    ['marker', 'marker is malformed or names an unknown model'],
    ['mode', 'Jev is not on'],
    ['write', 'the state file could not be written']
  ] as const)('not recorded, %s', (reason, text) => {
    const line = notRecordedLine(reason, 'model', '[jev-elevate:<model>]', 'No, proceed on <alias>');

    expect(line.startsWith('[jev] Not recorded: ')).toBe(true);
    expect(line).toContain(text);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('the row fields', () => {
    expect(elevationAnswerFields({ kind: 'model', model: 'opus', effort: 'xhigh', answer: 'yes', scope: 'once', recorded: true })).toEqual({
      event: 'elevation_answer',
      kind: 'model',
      model: 'opus',
      effort: 'xhigh',
      answer: 'yes',
      scope: 'once',
      recorded: true
    });
    expect(elevationAnswerFields({ kind: 'effort', model: null, effort: null, answer: null, scope: null, recorded: false, reason: 'label' })).toMatchObject({ recorded: false, reason: 'label' });
  });
});
