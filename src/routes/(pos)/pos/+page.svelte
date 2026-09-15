<script lang="ts">
	// EMPLOYEE SELECT — /pos, the till's landing screen (spec 7: "Select Employee /
	// Cashier / Waiter / PIN").
	//
	// The directory comes from GET /api/pos/employees, and the SERVER decides who
	// may see it: this screen renders the answer, it does not make it. The response
	// carries each employee's PIN hash (pinPhc), deliberately — spec 6's offline
	// employee switching needs it cached on this device. This screen NEVER renders
	// it, never puts it in the DOM and never logs the response: it keeps only
	// whether a PIN is set, and the one other place the hash may go is the device's
	// IndexedDB store (src/lib/pos/store.ts).
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { cacheEmployees, cacheSettings, readCachedEmployees } from '$lib/pos/store';

	type Role = 'owner' | 'cashier' | 'waiter';
	type DirectoryEntry = {
		id: string;
		displayName: string;
		role: Role;
		isActive: boolean;
		pinPhc: string | null;
	};
	/** What the markup may see — the hash is dropped the moment the response is read. */
	type Choice = { id: string; displayName: string; role: Role; hasPin: boolean };

	const ROLE_LABEL: Record<Role, string> = {
		owner: 'Owner',
		cashier: 'Cashier',
		waiter: 'Waiter'
	};

	let status = $state<'loading' | 'ready' | 'cached' | 'not-registered' | 'offline' | 'error'>(
		'loading'
	);
	let employees = $state<Choice[]>([]);
	let cacheWarning = $state(false);

	const toChoices = (entries: DirectoryEntry[]): Choice[] =>
		entries.map((entry) => ({
			id: entry.id,
			displayName: entry.displayName,
			role: entry.role,
			hasPin: entry.pinPhc !== null
		}));

	async function loadDirectory() {
		status = 'loading';
		let response: Response;
		try {
			response = await fetch('/api/pos/employees');
		} catch {
			// No network: the list cached on this device, if there is one. A cached list
			// is marked as such on screen — it must not look like a live one — and the
			// "no cached list" message is shown only when the cache is genuinely empty.
			let cached: DirectoryEntry[] = [];
			try {
				cached = await readCachedEmployees();
			} catch {
				// No readable cache (a private window, storage refused): same as empty.
			}
			if (cached.length > 0) {
				employees = toChoices(cached);
				status = 'cached';
			} else {
				status = 'offline';
			}
			return;
		}
		// 403 is the ONE device-related status the endpoint returns, and it covers all
		// three device states — no cookie, an unknown cookie, a revoked device — so
		// there is deliberately no 401 branch.
		if (response.status === 403) {
			status = 'not-registered';
			return;
		}
		if (!response.ok) {
			status = 'error';
			return;
		}
		const body = (await response.json()) as {
			employees: DirectoryEntry[];
			settings: { posIdleLockSeconds: number | null };
		};
		employees = toChoices(body.employees);
		status = 'ready';
		// Write BOTH halves of this one response through to the device, so the till can
		// switch employees offline (spec 6) and the PIN screen can arm its idle watch.
		// The rows go in exactly as they arrived, and the idle lock is cached AS IT
		// ARRIVED — null stays null (no default exists; CLAUDE.md, 2026-09-15).
		cacheWarning = false;
		try {
			await cacheEmployees(body.employees);
			await cacheSettings([{ key: 'posIdleLockSeconds', value: body.settings.posIdleLockSeconds }]);
		} catch {
			// The live list still works; what fails is starting offline later, and a
			// till that silently forgets is worse than one that says so.
			cacheWarning = true;
		}
	}

	onMount(() => {
		void loadDirectory();
	});

	function choose(id: string) {
		// An employee id is not a secret — it is already on this list — and the PIN
		// never appears in a URL.
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path IS resolve()d; the rule only accepts a bare resolve() call, and an employee id has to travel as a query string
		void goto(resolve('/pos/pin') + '?employee=' + encodeURIComponent(id));
	}
</script>

<svelte:head>
	<title>Select employee · matcami</title>
</svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
	<h1 class="text-title text-ink">Who is signing in?</h1>

	{#if status === 'loading'}
		<p class="text-ink-2">Loading the staff list…</p>
	{:else if status === 'not-registered'}
		<div
			role="alert"
			class="bg-danger-bg text-danger rounded-control flex flex-col gap-2 px-3 py-2"
		>
			<p>
				<span aria-hidden="true" class="font-mono">✕</span>
				This device is not registered as a till, or its registration was revoked. Register it again to
				use it as a till.
			</p>
			<a
				href={resolve('/pos/register')}
				class="min-h-touch-lg bg-accent text-accent-ink border-control-line rounded-control text-pos grid place-items-center border font-semibold"
			>
				Register this device
			</a>
		</div>
	{:else if status === 'offline'}
		<div
			role="alert"
			class="bg-st-offline-bg text-st-offline rounded-control flex flex-col gap-2 px-3 py-2"
		>
			<p>
				<span aria-hidden="true" class="font-mono">◆</span>
				No connection, and this device has not cached an employee list yet.
			</p>
			<button
				type="button"
				onclick={loadDirectory}
				class="min-h-touch-lg bg-raise text-ink border-control-line rounded-control text-pos border"
			>
				Retry
			</button>
		</div>
	{:else if status === 'error'}
		<div
			role="alert"
			class="bg-danger-bg text-danger rounded-control flex flex-col gap-2 px-3 py-2"
		>
			<p>
				<span aria-hidden="true" class="font-mono">✕</span>
				The staff list could not be loaded.
			</p>
			<button
				type="button"
				onclick={loadDirectory}
				class="min-h-touch-lg bg-raise text-ink border-control-line rounded-control text-pos border"
			>
				Retry
			</button>
		</div>
	{:else}
		{#if status === 'cached'}
			<!-- A cached list must not look like a live one. -->
			<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
				<span aria-hidden="true" class="font-mono">◆</span>
				No connection — this is the staff list saved on this device.
			</p>
		{/if}
		{#if cacheWarning}
			<p role="alert" class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
				<span aria-hidden="true" class="font-mono">◆</span>
				This device could not save the staff list, so it cannot sign anyone in offline.
			</p>
		{/if}
		{#if employees.length === 0}
			<p class="text-ink-2">
				No active staff yet. The owner adds staff on the dashboard’s Employees page.
			</p>
		{/if}
		<ul class="grid grid-cols-2 gap-2 sm:grid-cols-3">
			{#each employees as employee (employee.id)}
				<li>
					<!-- An employee with no PIN is SHOWN, as unavailable with the reason in
					     words: hiding them would make "why is Sam missing from the till?"
					     unanswerable from the screen. -->
					<button
						type="button"
						disabled={!employee.hasPin}
						onclick={() => choose(employee.id)}
						class={`min-h-touch-lg border-control-line rounded-control flex w-full flex-col items-start justify-center border px-3 py-2 text-left ${
							employee.hasPin ? 'bg-raise' : 'bg-disabled-bg'
						}`}
					>
						<span class={employee.hasPin ? 'text-ink font-semibold' : 'text-disabled-ink'}>
							{employee.displayName}
						</span>
						<span class={employee.hasPin ? 'text-ink-2' : 'text-disabled-ink'}>
							{ROLE_LABEL[employee.role]}{employee.hasPin ? '' : ' — no PIN set yet'}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>
