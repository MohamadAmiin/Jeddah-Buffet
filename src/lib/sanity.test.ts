import { describe, it, expect } from 'vitest';

// One trivial assertion, so the `unit` project is proven to run and report
// before anything depends on it. None of spec 29's six mandatory suites lives
// here; those arrive with the code they cover.
describe('unit test harness', () => {
	it('runs and reports', () => {
		expect(1 + 1).toBe(2);
	});
});
