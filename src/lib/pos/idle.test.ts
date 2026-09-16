import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleWatch } from './idle';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const TEN_MINUTES = 10 * 60 * 1000;

describe('createIdleWatch', () => {
	// The assertion that stops a default sneaking back in: with no idle lock
	// configured, nothing ever fires.
	it('is inert when no idle lock is configured', () => {
		const onIdle = vi.fn();
		const watch = createIdleWatch({ seconds: null, onIdle });

		vi.advanceTimersByTime(TEN_MINUTES);

		expect(onIdle).toHaveBeenCalledTimes(0);
		expect(() => {
			watch.poke();
			watch.stop();
		}).not.toThrow();
	});

	it('fires at exactly the configured number of seconds', () => {
		const onIdle = vi.fn();
		createIdleWatch({ seconds: 120, onIdle });

		vi.advanceTimersByTime(119_999);
		expect(onIdle).toHaveBeenCalledTimes(0);
		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('restarts the period on poke()', () => {
		const onIdle = vi.fn();
		const watch = createIdleWatch({ seconds: 120, onIdle });

		vi.advanceTimersByTime(100_000);
		watch.poke();
		vi.advanceTimersByTime(119_999);
		expect(onIdle).toHaveBeenCalledTimes(0);
		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('never fires after stop()', () => {
		const onIdle = vi.fn();
		const watch = createIdleWatch({ seconds: 120, onIdle });

		vi.advanceTimersByTime(10_000);
		watch.stop();
		vi.advanceTimersByTime(TEN_MINUTES);

		expect(onIdle).toHaveBeenCalledTimes(0);
	});

	it('fires once per armed period, not repeatedly', () => {
		const onIdle = vi.fn();
		createIdleWatch({ seconds: 120, onIdle });

		vi.advanceTimersByTime(120_000);
		expect(onIdle).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(TEN_MINUTES);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});
});
