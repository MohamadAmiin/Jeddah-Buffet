// THE DISK QUEUE, THE SEEN-ID STORE AND THE DRAWER (spec 11; tasks/menu-and-printing T-26).
//
// Spec 11: "Queues jobs when a printer is offline or out of paper, and prints
// them when it recovers." A job is on disk BEFORE the till hears 'queued', so a
// crash between the two loses nothing and a retry of the same id is a
// 'duplicate', not a second receipt — the seen-id store remembers every printed
// job and every drawer pulse for 48 hours, across restarts.
//
// The drawer is deliberately NOT a job. A pulse is sent now or refused now:
// it is never written to queue/, never retried, never replayed — a queued pulse
// would be a drawer that opens by itself when the printer comes back
// (invariant 9; the plan's risk panel called this MAJOR). A stale pulse — its
// sale completed more than 30 s ago — is refused as too_late for the same
// reason.
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, PrinterConfig } from './config.ts';
import { DRAWER_PULSE, encodeJob } from './escpos.ts';
import { paperStatus, reachable, send } from './printer.ts';
import type { AgentStatus, DrawerOutcome, DrawerRequest, Job, SubmitOutcome } from './server.ts';

export type Target = 'receipt' | 'kitchen';
export type QueuedJob = { id: string; target: Target; bytesBase64: string; enqueuedAt: string };

export const SEEN_TTL_MS = 48 * 60 * 60 * 1000;
export const DRAWER_WINDOW_MS = 30_000;
const SEEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const REACHABLE_CACHE_MS = 5000;

/** Write to `<path>.tmp`, then rename: the file is whole or absent, never half. */
function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

function isoAt(now: () => number): string {
	return new Date(now()).toISOString();
}

// ── The seen-id store ───────────────────────────────────────────────────────

export type SeenStore = {
	has: (id: string) => boolean;
	record: (id: string) => void;
	prune: () => number;
	size: () => number;
};

export function createSeenStore(dataDir: string, now: () => number): SeenStore {
	const path = join(dataDir, 'seen.json');
	let seen: Record<string, string> = {};
	if (existsSync(path)) {
		try {
			const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
			if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
				for (const [id, at] of Object.entries(raw)) {
					if (typeof at === 'string') seen[id] = at;
				}
			}
		} catch {
			// An unreadable seen.json is treated as empty and rewritten on the next record.
			seen = {};
		}
	}
	const save = () => writeAtomic(path, JSON.stringify(seen, null, '\t') + '\n');
	return {
		has: (id) => Object.hasOwn(seen, id),
		record: (id) => {
			seen[id] = isoAt(now);
			save();
		},
		prune: () => {
			const cutoff = now() - SEEN_TTL_MS;
			let removed = 0;
			for (const [id, at] of Object.entries(seen)) {
				const t = Date.parse(at);
				if (Number.isNaN(t) || t < cutoff) {
					delete seen[id];
					removed += 1;
				}
			}
			if (removed > 0) save();
			return removed;
		},
		size: () => Object.keys(seen).length
	};
}

// ── The queue ───────────────────────────────────────────────────────────────

export type QueueOptions = {
	dataDir: string;
	printers: AgentConfig['printers'];
	now?: () => number;
	/** Retry back-off: first wait, doubling to the cap. Defaults 2 s → 30 s. */
	retry?: { baseMs: number; maxMs: number };
	/** How long to wait for the paper-status byte before printing anyway. Default 1 s. */
	paperStatusTimeoutMs?: number;
	sendTimeoutMs?: number;
};

export type Queue = {
	submit: (job: Job) => SubmitOutcome;
	status: () => Promise<AgentStatus>;
	seen: SeenStore;
	log: (line: string) => void;
	/** Stop the workers and timers; queued files stay on disk for the next start. */
	/** Stop the workers and timers and wait for an in-flight print to finish; queued files stay on disk. */
	close: () => Promise<void>;
};

type Worker = {
	target: Target;
	printer: PrinterConfig;
	jobs: Array<{ file: string; job: QueuedJob }>;
	running: boolean;
	delayMs: number;
	timer: ReturnType<typeof setTimeout> | null;
	wake: (() => void) | null;
	/** The running loop, so close() can wait for a print already on the wire. */
	loop: Promise<void> | null;
};

const FILE_RE = /^(\d{12})-[0-9a-f]{40}\.json$/;

export function createQueue(options: QueueOptions): Queue {
	const now = options.now ?? (() => Date.now());
	const retry = options.retry ?? { baseMs: 2000, maxMs: 30_000 };
	const paperTimeout = options.paperStatusTimeoutMs ?? 1000;
	const sendTimeout = options.sendTimeoutMs ?? 5000;
	const queueDir = join(options.dataDir, 'queue');
	mkdirSync(queueDir, { recursive: true });
	const logPath = join(options.dataDir, 'agent.log');
	const log = (line: string) => appendFileSync(logPath, `${isoAt(now)} ${line}\n`);

	const seen = createSeenStore(options.dataDir, now);
	seen.prune();
	const pruneTimer = setInterval(() => seen.prune(), SEEN_PRUNE_INTERVAL_MS);
	pruneTimer.unref();

	const workers: Record<Target, Worker> = {
		receipt: {
			target: 'receipt',
			printer: options.printers.receipt,
			jobs: [],
			running: false,
			delayMs: retry.baseMs,
			timer: null,
			wake: null,
			loop: null
		},
		kitchen: {
			target: 'kitchen',
			printer: options.printers.kitchen ?? options.printers.receipt,
			jobs: [],
			running: false,
			delayMs: retry.baseMs,
			timer: null,
			wake: null,
			loop: null
		}
	};
	let closed = false;
	let seq = 0;

	/** Delete a queue file; one that is already gone, or held by another process, is not an error. */
	function discard(file: string): void {
		try {
			unlinkSync(file);
		} catch {
			// Left on disk: the id is in `seen`, so the next start drops it again.
		}
	}

	// Resume whatever the last run left on disk, FIFO by file name.
	for (const name of readdirSync(queueDir).sort()) {
		const match = FILE_RE.exec(name);
		if (!match) continue;
		seq = Math.max(seq, Number.parseInt(match[1] ?? '0', 10));
		const file = join(queueDir, name);
		try {
			const job = JSON.parse(readFileSync(file, 'utf8')) as QueuedJob;
			if (typeof job.id !== 'string' || (job.target !== 'receipt' && job.target !== 'kitchen')) {
				continue;
			}
			if (seen.has(job.id)) {
				// Printed by the last run, which recorded the id and then could not
				// delete the file (a crash, or a scanner holding it on Windows). It
				// must NOT print again: a second original is an unmarked duplicate.
				discard(file);
				log(`dropped ${job.id}: already printed`);
				continue;
			}
			workers[job.target].jobs.push({ file, job });
		} catch {
			// A half-written file cannot exist (atomic rename); an unreadable one is left for the owner.
		}
	}

	const queuedIds = () => {
		const ids = new Set<string>();
		for (const w of Object.values(workers)) for (const q of w.jobs) ids.add(q.job.id);
		return ids;
	};

	function sleep(worker: Worker, ms: number): Promise<void> {
		return new Promise((resolve) => {
			worker.wake = () => {
				if (worker.timer) clearTimeout(worker.timer);
				worker.timer = null;
				worker.wake = null;
				resolve();
			};
			worker.timer = setTimeout(() => worker.wake?.(), ms);
			worker.timer.unref();
		});
	}

	function run(worker: Worker): void {
		if (worker.running) return;
		worker.running = true;
		worker.loop = loop(worker).finally(() => {
			worker.running = false;
			worker.loop = null;
			// A job that arrived while the loop was winding down starts it again.
			if (!closed && worker.jobs.length > 0) run(worker);
		});
	}

	/**
	 * The worker's loop. It never rejects: a failure outside printing itself —
	 * the disk refusing seen.json or the log — is written to stderr and stops
	 * this worker; the next start resumes from the files on disk.
	 */
	async function loop(worker: Worker): Promise<void> {
		try {
			while (!closed && worker.jobs.length > 0) {
				const head = worker.jobs[0];
				if (!head) break;
				if (seen.has(head.job.id)) {
					// The second wall behind the resume check: whatever put a printed
					// id back in the list, it is dropped, never sent.
					discard(head.file);
					worker.jobs.shift();
					continue;
				}
				const paper = await paperStatus(worker.printer, paperTimeout);
				if (closed) break;
				if (paper === 'paper_out') {
					await backOff(worker, `paper out on ${worker.target}`);
					continue;
				}
				try {
					await send(worker.printer, Buffer.from(head.job.bytesBase64, 'base64'), sendTimeout);
				} catch (error) {
					if (closed) break;
					await backOff(worker, `${worker.target} unreachable: ${(error as Error).message}`);
					continue;
				}
				// The id is recorded BEFORE the file is deleted: if the delete fails or
				// the PC loses power in between, the next start finds the file, finds
				// the id in `seen`, and drops it instead of printing it again.
				seen.record(head.job.id);
				log(`printed ${head.job.id}`);
				discard(head.file);
				worker.jobs.shift();
				worker.delayMs = retry.baseMs;
			}
		} catch (error) {
			try {
				process.stderr.write(
					`print-agent: ${worker.target} worker stopped: ${(error as Error).message}\n`
				);
			} catch {
				// Nowhere left to report to.
			}
		}
	}

	async function backOff(worker: Worker, reason: string): Promise<void> {
		log(`retry ${worker.target} in ${worker.delayMs} ms: ${reason}`);
		await sleep(worker, worker.delayMs);
		worker.delayMs = Math.min(worker.delayMs * 2, retry.maxMs);
	}

	for (const worker of Object.values(workers)) run(worker);

	const reachableCache: Record<Target, { at: number; value: boolean } | null> = {
		receipt: null,
		kitchen: null
	};
	async function isReachable(target: Target): Promise<boolean> {
		const cached = reachableCache[target];
		if (cached && now() - cached.at < REACHABLE_CACHE_MS) return cached.value;
		const value = await reachable(workers[target].printer);
		reachableCache[target] = { at: now(), value };
		return value;
	}

	return {
		seen,
		log,
		submit: (job) => {
			if (seen.has(job.id) || queuedIds().has(job.id)) return 'duplicate';
			const target: Target =
				job.printer === 'kitchen' && options.printers.kitchen ? 'kitchen' : 'receipt';
			const bytes = encodeJob(job.lines, { cut: job.cut });
			seq += 1;
			const name = `${String(seq).padStart(12, '0')}-${createHash('sha1').update(job.id).digest('hex')}.json`;
			const file = join(queueDir, name);
			const queued: QueuedJob = {
				id: job.id,
				target,
				bytesBase64: Buffer.from(bytes).toString('base64'),
				enqueuedAt: isoAt(now)
			};
			writeAtomic(file, JSON.stringify(queued) + '\n');
			// Only now, with the file on disk, is the job queued.
			const worker = workers[target];
			worker.jobs.push({ file, job: queued });
			if (worker.running) worker.wake?.();
			else run(worker);
			return 'queued';
		},
		status: async () => {
			const receipt = {
				width: options.printers.receipt.width,
				reachable: await isReachable('receipt'),
				queued: workers.receipt.jobs.length
			};
			const kitchen = options.printers.kitchen
				? {
						width: options.printers.kitchen.width,
						reachable: await isReachable('kitchen'),
						queued: workers.kitchen.jobs.length
					}
				: null;
			// With no kitchen printer, kitchen jobs ride the receipt worker — count them there.
			if (!options.printers.kitchen) receipt.queued += workers.kitchen.jobs.length;
			return { agentVersion: 1, printers: { receipt, kitchen } };
		},
		close: async () => {
			closed = true;
			clearInterval(pruneTimer);
			// Waking a sleeping worker clears its timer and lets its loop see `closed`;
			// a worker mid-send finishes that job, records it, and then stops.
			for (const worker of Object.values(workers)) worker.wake?.();
			await Promise.all(Object.values(workers).map((worker) => worker.loop ?? Promise.resolve()));
		}
	};
}

// ── The drawer ──────────────────────────────────────────────────────────────

export type DrawerOptions = {
	receipt: PrinterConfig;
	seen: SeenStore;
	log: (line: string) => void;
	now?: () => number;
	sendTimeoutMs?: number;
};

export type Drawer = { pulse: (request: DrawerRequest) => Promise<DrawerOutcome> };

/**
 * Send the pulse NOW or refuse it. Nothing here writes to queue/, nothing
 * retries, nothing replays: a drawer opens once, at the sale, or not at all.
 */
export function createDrawer(options: DrawerOptions): Drawer {
	const now = options.now ?? (() => Date.now());
	return {
		pulse: async ({ id, completedAt }) => {
			if (options.seen.has(id)) return 'duplicate';
			const completed = Date.parse(completedAt);
			if (Number.isNaN(completed) || Math.abs(now() - completed) > DRAWER_WINDOW_MS) {
				return 'too_late';
			}
			try {
				await send(options.receipt, DRAWER_PULSE, options.sendTimeoutMs ?? 3000);
			} catch {
				return 'printer_unreachable';
			}
			options.seen.record(id);
			options.log(`drawer ${id}`);
			return 'opened';
		}
	};
}
