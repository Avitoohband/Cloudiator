import { describe, expect, it } from 'vitest';
import { feedbackItemOf } from '../../src/features/game-info/feedback-review';

// Patch 1.9 (Task 25, carried from the Task 23b review): the owner's feedback list reads each item defensively. A malformed item is left
// out, but a newer server's `answeredVia` value this client does not know is read as none (null): the item, its text and its answer
// still show, with the plain "Answered" status, rather than vanishing from the list.
const item = (over: Record<string, unknown> = {}) => ({ id: 7, category: 'bug', text: 'The Arena timer shows a wrong number.', details: null, status: 'answered',
  createdAtMs: 1_000, gladiatorName: 'Cassia', answer: 'Thanks, fixed.', answeredAtMs: 2_000, answeredVia: 'owner', suggestion: null, suggestedAtMs: null, ...over });

describe('feedbackItemOf', () => {
  it('reads an unknown answeredVia as null instead of dropping the item', () => {
    for (const answeredVia of ['claude-direct', 'mcp', '', 7, true, { by: 'owner' }]) {
      expect(feedbackItemOf(item({ answeredVia })), JSON.stringify(answeredVia)).toEqual({ ...item(), answeredVia: null });
    }
  });

  it('keeps the known values, and an absent field (a server before M36) as none', () => {
    expect(feedbackItemOf(item())).toEqual(item());
    expect(feedbackItemOf(item({ answeredVia: 'claude-approved' }))).toEqual(item({ answeredVia: 'claude-approved' }));
    const { answeredVia: _gone, suggestion: _s, suggestedAtMs: _t, ...older } = item();
    expect(feedbackItemOf(older)).toEqual(item({ answeredVia: null }));
  });

  it('still leaves out an item whose own fields are malformed', () => {
    for (const bad of [item({ id: 0 }), item({ category: 'rant' }), item({ status: 'archived' }), item({ text: 5 }),
      item({ status: 'new', answer: null, answeredAtMs: null, answeredVia: null, suggestion: 'Hi.', suggestedAtMs: null }),
      item({ status: 'new', answer: null, answeredAtMs: null, answeredVia: null, suggestion: null, suggestedAtMs: 5 })]) {
      expect(feedbackItemOf(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
  });
});
