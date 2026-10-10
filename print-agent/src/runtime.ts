// THE RUNNING AGENT'S STATE (tasks/print-agent-installer T-03).
//
// The installer starts the agent before anyone has typed a printer address, and
// the owner can change the printer later — on the till's Printer page (PUT
// /printers) or on the agent's own setup page. So the queue and the drawer are
// no longer built once at start-up: this runtime builds them when a receipt
// printer exists, answers `no_printer` while none does, and REBUILDS them around
// new printers without a restart.
//
// A rebuild is the dangerous moment, for two reasons the risk panel named:
// - the queue and the drawer CAPTURE their printer when built (queue.ts), so a
//   config change alone would leave jobs and the drawer pulse going to the old
//   address while /status reported the new one — hence close, then rebuild;
// - a queued job is ALREADY ESC/POS bytes for the printer width it was queued
//   at, so a paper-width change is REFUSED while that printer has jobs waiting
//   (decision 2 of the plan) instead of printing them wrapped mid-number.
//
// While a rebuild runs, jobs, pulses and status reads wait for it and then use
// the new queue and drawer. A pulse that waited is still judged by the drawer's
// own 30-second window, so a slow rebuild refuses it as too_late rather than
// opening the drawer late (invariant 9). The seen-id store is re-read from
// data/seen.json by the new queue, so a job printed before the rebuild is still
// a duplicate after it.
import { parseConfig, parseOrigin, saveConfig, type AgentConfig } from './config.ts';
import { createDrawer, createQueue, type Drawer, type Queue, type QueueOptions } from './queue.ts';
import {
	AGENT_FEATURES,
	type AgentDeps,
	type AgentStatus,
	type SetPrintersOutcome
} from './server.ts';

export type Runtime = {
	/** The config as it is now — the server reads it per request. */
	config: () => AgentConfig;
	deps: Omit<AgentDeps, 'claimPairing'>;
	/** Answer another app origin from now on (the setup page; tills under the old one must pair again). */
	setOrigin: (origin: string) => Promise<void>;
	/** Replace the pairing token (the setup page's "Reset the pairing key"; every till pairs again). */
	setToken: (token: string) => Promise<void>;
	/** Stop the queue; an in-flight print finishes and queued files stay on disk. */
	close: () => Promise<void>;
};

type Tuning = Partial<Omit<QueueOptions, 'dataDir' | 'printers'>>;

/** The printer a target's jobs are encoded for: kitchen jobs ride the receipt printer when there is no kitchen one. */
function widths(printers: AgentConfig['printers']): { receipt: number; kitchen: number } | null {
	const receipt = printers.receipt;
	if (!receipt) return null;
	return { receipt: receipt.width, kitchen: (printers.kitchen ?? receipt).width };
}

export function createRuntime(args: {
	configPath: string;
	config: AgentConfig;
	queue?: Tuning;
}): Runtime {
	let config = args.config;
	let queue: Queue | null = null;
	let drawer: Drawer | null = null;
	/** Set synchronously when a rebuild starts; requests wait on it. */
	let rebuilding: Promise<void> | null = null;
	/** Config writes run one at a time. */
	let chain: Promise<unknown> = Promise.resolve();

	function build(): void {
		const receipt = config.printers.receipt;
		if (!receipt) {
			queue = null;
			drawer = null;
			return;
		}
		const built = createQueue({
			...args.queue,
			dataDir: config.dataDir,
			printers: { receipt, kitchen: config.printers.kitchen }
		});
		queue = built;
		drawer = createDrawer({
			receipt,
			seen: built.seen,
			log: built.log,
			now: args.queue?.now,
			sendTimeoutMs: args.queue?.sendTimeoutMs
		});
	}

	/** Wait out any rebuild. The caller must use queue/drawer WITHOUT an await after this resolves. */
	async function settled(): Promise<void> {
		while (rebuilding) await rebuilding;
	}

	function serial<T>(work: () => Promise<T>): Promise<T> {
		const run = chain.then(work, work);
		chain = run.catch(() => undefined);
		return run;
	}

	function save(next: AgentConfig): void {
		saveConfig(args.configPath, next);
		config = parseConfig(next);
	}

	build();

	const noPrinterStatus = (): AgentStatus => ({
		agentVersion: 2,
		features: AGENT_FEATURES,
		printers: { receipt: null, kitchen: null }
	});

	return {
		config: () => config,
		deps: {
			submitJob: async (job) => {
				await settled();
				return queue ? queue.submit(job) : 'no_printer';
			},
			pulseDrawer: async (request) => {
				await settled();
				return drawer ? drawer.pulse(request) : 'no_printer';
			},
			status: async () => {
				await settled();
				return queue ? queue.status() : noPrinterStatus();
			},
			setPrinters: (next) =>
				serial(async (): Promise<SetPrintersOutcome> => {
					const before = widths(config.printers);
					const after = widths(next);
					if (queue && before) {
						const waiting = queue.queuedByTarget();
						for (const target of ['receipt', 'kitchen'] as const) {
							const changed = after === null || after[target] !== before[target];
							if (changed && waiting[target] > 0) {
								return { ok: false, error: 'jobs_waiting', target, queued: waiting[target] };
							}
						}
					}
					// From here to the end, nothing may submit to the queue being replaced.
					let done = () => {};
					rebuilding = new Promise((resolve) => (done = resolve));
					try {
						save({ ...config, printers: next });
						const old = queue;
						await old?.close();
						build();
					} finally {
						rebuilding = null;
						done();
					}
					return { ok: true };
				})
		},
		setOrigin: (origin) =>
			serial(async () => {
				save({ ...config, origin: parseOrigin(origin) });
			}),
		setToken: (token) =>
			serial(async () => {
				// saveConfig's parse refuses anything but 64 lowercase hex.
				save({ ...config, token });
			}),
		close: async () => {
			await chain;
			await settled();
			await queue?.close();
		}
	};
}
