// THE IDLE WATCH — spec 7: "The POS returns to the employee selection screen after
// a set idle time (default 2 minutes, configurable)".
//
// Pure and DOM-free, so it unit-tests in the node environment vitest provides. It
// attaches NO listeners: the page wires pointerdown and keydown to poke() and
// removes them in its own cleanup.
//
// The number of seconds is the restaurant setting pos_idle_lock_seconds, which is
// NULLABLE with no default anywhere (CLAUDE.md, "Decisions already made",
// 2026-09-15): spec 7's "2 minutes" is the value an owner would type, not one the
// code assumes. So `null` gives an INERT watch — no timer is armed and onIdle
// never fires — and there is deliberately no fallback number in this file. A
// default written here would answer the setting silently for every restaurant
// whose owner never chose one.

export interface IdleWatch {
	/** Restart the idle period — call it on every interaction. */
	poke(): void;
	/** Cancel the watch for good. */
	stop(): void;
}

export function createIdleWatch(options: {
	seconds: number | null;
	onIdle: () => void;
}): IdleWatch {
	const { seconds, onIdle } = options;

	if (seconds === null) {
		return {
			poke() {
				// Inert: no idle lock is configured, so there is nothing to restart.
			},
			stop() {
				// Inert: no timer was ever armed.
			}
		};
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	// One timer at a time; onIdle fires at most once per armed period.
	const arm = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			onIdle();
		}, seconds * 1000);
	};
	arm();

	return {
		poke() {
			if (!stopped) arm();
		},
		stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		}
	};
}
