import { describe, it, expect } from 'vitest';
import { EVENT_TEXT } from './event-text';
// Relative, not $lib: the unit project defines no $lib alias (vitest.config.ts sets
// one on the integration project only).
import { AUDIT_EVENT_NAMES } from '../../../lib/server/audit/events';

describe('EVENT_TEXT', () => {
	it('gives every audit event a non-empty sentence', () => {
		for (const name of AUDIT_EVENT_NAMES) {
			expect(EVENT_TEXT[name], `no sentence for ${name}`).toMatch(/\S/);
		}
	});

	// Catches the other direction too: a stale sentence for an event that was
	// removed from the union.
	it('has exactly one entry per audit event name', () => {
		expect(Object.keys(EVENT_TEXT).sort()).toEqual([...AUDIT_EVENT_NAMES].sort());
	});
});
