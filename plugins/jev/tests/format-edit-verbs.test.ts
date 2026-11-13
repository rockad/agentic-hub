/**
 * Formatting and insertion verbs count as edits when the task names a file-like object, so a stage such as
 * "Reformat the table in docs/x.md" goes to a tier that can edit, not to jev_execute_free (text only).
 * Without a file-like object ("Format this paragraph as bullet points") the stage stays free-tier text work.
 */
import { describe, it, expect } from 'bun:test';
import { taskNeedsEdit } from '../src/core/heuristics.ts';
import { classifyBatchTier, editsFiles, keepEditsOffFreeTier } from '../src/tools/dispatch.ts';

const finalTier = (task: string) => keepEditsOffFreeTier(classifyBatchTier(task), editsFiles({ task }));

describe('format, reformat and insert with a file-like object are edits', () => {
  it.each([
    ['Reformat the table in docs/x.md'],
    ['Format the JSON config'],
    ['Insert a heading into README.md'],
    ['Format src/index.ts'],
    ['Reformatting notes.md'],
    ['Format all the files'],
    ['Please format ./scripts/run.sh'],
    ['Insert a row into the config']
  ])('%j needs an edit', (task) => {
    expect(taskNeedsEdit(task)).toBe(true);
  });

  it('does not let the free tier take a formatting stage that edits a file', () => {
    expect(classifyBatchTier('Reformat the table in docs/x.md')).toBe('openrouter_free');
    expect([finalTier('Reformat the table in docs/x.md'), finalTier('Format the JSON config')]).toEqual(['flash_lite', 'flash_lite']);
  });
});

describe('the same verbs without a file-like object stay as they were', () => {
  it.each([
    ['Format this paragraph as bullet points'],
    ['Summarise the table'],
    ['Pick the output format for the report'],
    ['Review the dump format decision'],
    ['Choose the file format'],
    ['Insert a joke into the story'],
    ['Do not format the files, just list them'],
    ['Without reformatting the config, explain it'],
    ['Reformat this and/or that list']
  ])('%j is not an editing task', (task) => {
    expect(taskNeedsEdit(task)).toBe(false);
  });

  it('keeps a text-only formatting stage on the free tier', () => {
    expect(finalTier('Format this paragraph as bullet points')).toBe('openrouter_free');
  });

  it('does not move a read-only stage', () => {
    expect(finalTier('Summarise the table')).toBe(classifyBatchTier('Summarise the table'));
  });
});
