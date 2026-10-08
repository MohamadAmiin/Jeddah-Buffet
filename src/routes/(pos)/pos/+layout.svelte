<script lang="ts">
	// THE POS SHELL — the till's device surface, at the REAL /pos URL prefix.
	//
	// It lives on this INNER pos/ layout, not on the (pos) group layout, and both
	// reasons matter:
	//   - A route GROUP is not a URL segment. The group layout wraps whatever sits in
	//     the group regardless of URL, so stamping the surface there would also stamp
	//     a page someone later adds at src/routes/(pos)/anything/+page.svelte — which
	//     serves at /anything, outside the service worker's scope, outside the
	//     manifest's scope and outside the /pos opening in the route guard. That page
	//     would LOOK right while being unreachable offline and guarded differently.
	//     Here the prefix is structural: to get the POS shell you must be under /pos.
	//   - The group layout is the written record of the group's two hard constraints
	//     (never import $lib/server; no server load). It stays where it is.
	//
	// THE POS SURFACE IS LIGHT AND PINNED IN BOTH THEMES. [data-surface="pos"] in
	// tokens.css pins the COMPLETE palette — grounds, inks, accent, status, the
	// aliases, the rail family and the shadow rungs. A surface pinned one way whose
	// inks still theme is the defect that has shipped twice (1.08:1, then 1.21:1).
	// `bg-bg text-ink` are NOT redundant: this element must resolve the PINNED values
	// itself. <body> is stamped too (tillBody, below), so overscroll around the till
	// never shows the viewer's dark ground — no server change, handleTheme untouched.
	//
	// EVERY PRESSABLE POS SURFACE TAKES A `border border-control-line` EDGE. A white
	// key (--c-raise) on the POS ground (--c-bg) measures 1.12:1, so elevation alone
	// cannot carry a control's boundary, and WCAG 1.4.11 asks 3:1 of one.
	// --c-control-line resolves to --c-ink-3, 5.16:1 on that ground. `border-line`
	// is decorative only and never a control edge.
	import { onMount, setContext } from 'svelte';
	import { dev } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { createIdleWatch } from '$lib/pos/idle';
	import {
		countUnsynced,
		onUnsyncedChange,
		readBoundDeviceId,
		readCachedIdleSeconds,
		readCachedSetting,
		readMenuSyncError,
		type LocalSession
	} from '$lib/pos/store';
	import TillBar from '$lib/components/pos/TillBar.svelte';
	import {
		RESTORED_CONTEXT,
		restoreFromMirror,
		signedIn,
		signOut,
		touch
	} from '$lib/pos/employee.svelte';
	import { flush, lastSkewMs, onFlushResult, onSkew, parkedCount } from '$lib/pos/queue';
	import { agentStatus, printerChip, type AgentState } from '$lib/pos/print-client';
	import { startAutoPrint } from '$lib/pos/printing';
	import { readLocalSession } from '$lib/pos/session';
	import { captureInstallPrompt } from '$lib/pos/install.svelte';

	let { children } = $props();

	// <body> takes the till's pinned palette and color-scheme while the till is
	// mounted, and gives it back on the way out.
	function tillBody(node: HTMLElement) {
		node.setAttribute('data-surface', 'pos');
		return {
			destroy() {
				node.removeAttribute('data-surface');
			}
		};
	}

	// T-30: RESTORE GATE. Published synchronously so child pages can await it
	// before their sign-in guard runs. `restoreFromMirror` runs from an onMount
	// below; when it settles, the promise resolves and the page guards fire.
	let markRestored: (() => void) | null = null;
	const restored = new Promise<void>((done) => {
		markRestored = done;
	});
	setContext(RESTORED_CONTEXT, restored);

	let parked = $state(0);
	async function refreshParked() {
		try {
			parked = await parkedCount();
		} catch {
			parked = 0;
		}
	}

	// THE CONNECTION INDICATOR — permanent chrome on every POS screen, which is why
	// it lives in this layout and not in a page, and never a toast (spec 6). Both
	// the glyph and the word, always: colour never carries meaning alone.
	//
	// Initialised to `true` so server-rendered HTML does not claim "Offline" before
	// any listener exists; navigator does not exist during SSR, so it is read only
	// in onMount.
	let online = $state(true);

	onMount(() => {
		online = navigator.onLine;
		const up = () => (online = true);
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
		};
	});

	// THE UNSYNCED COUNT sits beside it, for the same reason: spec 6 and invariant 5
	// want the number of unsynced operations on screen at all times, and an offline
	// sign-in is unsynced work from the moment it is recorded (offline_logins,
	// synced: false). It is read from IndexedDB after mount and again on every
	// change the store signals, and only the NEWEST read may land, so a slow read
	// cannot put an older number back. Nothing is shown before the first read, and a
	// store that cannot be read is named as such: never a 0 that may be false.
	let unsynced = $state<number | null>(null);
	let unsyncedUnreadable = $state(false);

	onMount(() => {
		let latest = 0;
		const recount = () => {
			const mine = ++latest;
			countUnsynced().then(
				(count) => {
					if (mine !== latest) return;
					unsynced = count;
					unsyncedUnreadable = false;
				},
				() => {
					if (mine !== latest) return;
					unsynced = null;
					unsyncedUnreadable = true;
				}
			);
		};
		recount();
		const stop = onUnsyncedChange(recount);
		return () => {
			// Bumping `latest` discards any read still in flight.
			latest++;
			stop();
		};
	});

	// T-30: RESTORE + FLUSH TRIGGERS. Restore the signed-in mirror using the
	// cached idle lock (null -> no restore, ever); mark the gate resolved so
	// child pages can guard. Trigger the flush once at mount and on every
	// `online` event; T-25's single-flight makes this coalesce.
	// `null` is the inert case: no idle return and the chip says so. There is no
	// fallback number of seconds anywhere in this file (invariant 12).
	let idleSeconds = $state<number | null>(null);

	onMount(() => {
		void (async () => {
			try {
				idleSeconds = await readCachedIdleSeconds();
			} catch {
				idleSeconds = null;
			}
			restoreFromMirror(idleSeconds);
			markRestored?.();
		})();
		void flush().catch(() => {});
		const onOnline = () => {
			void flush().catch(() => {});
		};
		addEventListener('online', onOnline);
		// A queued op flushes shortly after it is written, while the till is online.
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const stopQueued = onUnsyncedChange(() => {
			if (!navigator.onLine) return;
			clearTimeout(debounce);
			debounce = setTimeout(() => void flush().catch(() => {}), 500);
		});
		const stopFlush = onFlushResult(() => {
			void refreshParked();
			void refreshSession();
		});
		void refreshParked();
		skewMs = lastSkewMs();
		const stopSkew = onSkew((value) => {
			skewMs = value;
		});
		return () => {
			removeEventListener('online', onOnline);
			clearTimeout(debounce);
			stopQueued();
			stopFlush();
			stopSkew();
		};
	});

	// THE IDLE WATCH re-arms whenever the employee, the route or the seconds
	// change. /pos/pin keeps its own watch; employee-select needs none.
	$effect(() => {
		const here = page.url.pathname;
		const armed = signedIn.current !== null && here !== '/pos' && here !== '/pos/pin';
		if (!armed) return;
		const watch = createIdleWatch({
			seconds: idleSeconds,
			onIdle: () => {
				signOut();
				void goto(resolve('/pos'));
			}
		});
		const poke = () => {
			watch.poke();
			touch();
		};
		addEventListener('pointerdown', poke);
		addEventListener('keydown', poke);
		return () => {
			removeEventListener('pointerdown', poke);
			removeEventListener('keydown', poke);
			watch.stop();
		};
	});

	// THE SESSION CHIP reads the till's local session. A page writes the session
	// store and then navigates, so the navigation is a re-read signal too; only
	// the newest read may land.
	let session = $state<LocalSession | null>(null);
	let latestSessionRead = 0;
	async function refreshSession() {
		const mine = ++latestSessionRead;
		try {
			const deviceId = await readBoundDeviceId();
			const row = deviceId === null ? null : await readLocalSession(deviceId);
			if (mine === latestSessionRead) session = row;
		} catch {
			if (mine === latestSessionRead) session = null;
		}
	}
	$effect(() => {
		void page.url.pathname;
		void refreshSession();
	});
	onMount(() => onUnsyncedChange(() => void refreshSession()));

	// THE PRINTER CHIP (menu-and-printing T-29): permanent chrome like the
	// connection indicator, because a receipt that silently never printed is
	// found by the customer. The agent is local, so this does not depend on the
	// internet. Polled at mount, every 30 s and on every navigation (the owner
	// pairs on /pos/printer and leaves); only the newest read may land. Nothing
	// is shown before the first read completes.
	let printer = $state<AgentState | null>(null);
	let latestPrinterRead = 0;
	async function refreshPrinter() {
		const mine = ++latestPrinterRead;
		try {
			const state = await agentStatus();
			if (mine === latestPrinterRead) printer = state;
		} catch {
			if (mine === latestPrinterRead) printer = { state: 'unreachable' };
		}
	}
	const printerPill = $derived(printer === null ? null : printerChip(printer));
	onMount(() => {
		void refreshPrinter();
		const every = setInterval(() => void refreshPrinter(), 30_000);
		const changed = () => void refreshPrinter();
		addEventListener('matcami:printer-changed', changed);
		return () => {
			clearInterval(every);
			removeEventListener('matcami:printer-changed', changed);
			latestPrinterRead++;
		};
	});
	$effect(() => {
		void page.url.pathname;
		void refreshPrinter();
	});
	// THE AUTO-PRINTER (T-30): card and mobile sales print when the flush reports
	// the server's acceptance; the catch-up on start reprints missing originals.
	// Its return value is the unsubscribe.
	onMount(() => startAutoPrint());

	// CLOCK SKEW, measured by the flush from each response's Date header.
	let skewMs = $state<number | null>(null);
	const skewMinutes = $derived(
		skewMs !== null && Math.abs(skewMs) > 5 * 60 * 1000
			? Math.round(Math.abs(skewMs) / 60000)
			: null
	);

	// THE SERVICE WORKER — registered BY HAND, from this layout and from nowhere
	// else. svelte.config.js turns SvelteKit's automatic registration off: its
	// default scope is '/', which would put the till's worker in charge of
	// /dashboard and leave authenticated HTML in Cache Storage that /logout does not
	// clear.
	//
	// THE SCOPE IS '/pos', NOT '/pos/', and that is the trap in the whole decision.
	// Scope matching is a plain STRING prefix on the client URL (the ServiceWorker
	// specification's "Match Service Worker Registration"; MDN's prose implies a
	// path-segment match and is wrong on this point). '/pos/' would not match the
	// till's own landing screen at /pos, which would then fail to load offline.
	// The same string-prefix rule is why NO route outside the (pos) group may have
	// a path beginning with the characters "pos" — this worker would control it.
	// A script at /service-worker.js may NARROW its scope to /pos with no
	// Service-Worker-Allowed header; only widening would need one.
	//
	// `type: 'module'` in dev, where the worker is served unbundled; the production
	// build is classic. onMount often runs after `load` has already fired, when a
	// bare load listener would never run — hence the readyState check.
	// THE CONTEXT STRIP: which restaurant and till this is, and the time where the
	// till stands (the restaurant's zone once cached — invariant 11). Read from the
	// settings employee-select caches; re-read on every navigation, which is cheap.
	let restaurantName = $state<string | null>(null);
	let deviceCode = $state<string | null>(null);
	let timeZone = $state<string | null>(null);
	// A menu snapshot this till could not parse (menu-and-printing T-15): shown as
	// permanent chrome while online, because every syncMenu caller swallows the
	// error and the menu would otherwise go stale in silence.
	let menuSyncError = $state<string | null>(null);
	let now = $state(new Date());
	$effect(() => {
		void page.url.pathname;
		void (async () => {
			const [name, code, zone, syncError] = await Promise.all([
				...['restaurantName', 'deviceCode', 'timeZone'].map((key) =>
					readCachedSetting(key).catch(() => null)
				),
				readMenuSyncError().catch(() => null)
			]);
			restaurantName = typeof name === 'string' ? name : null;
			deviceCode = typeof code === 'string' ? code : null;
			timeZone = typeof zone === 'string' ? zone : null;
			menuSyncError = typeof syncError === 'string' ? syncError : null;
		})();
	});
	onMount(() => {
		const tick = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(tick);
	});
	const zoneOption = $derived(timeZone === null ? {} : { timeZone });
	const today = $derived(
		new Intl.DateTimeFormat('en-US', {
			...zoneOption,
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(now)
	);
	const clockTime = $derived(
		new Intl.DateTimeFormat('en-US', { ...zoneOption, hour: '2-digit', minute: '2-digit' }).format(
			now
		)
	);
	const onSales = $derived(page.url.pathname.startsWith('/pos/sales'));
	const roleLabel = $derived(
		signedIn.current === null ? '' : signedIn.current.isOwner ? 'Owner' : signedIn.current.roleName
	);
	const initials = $derived(
		signedIn.current === null
			? ''
			: signedIn.current.displayName
					.split(/\s+/)
					.filter((word) => word.length > 0)
					.slice(0, 2)
					.map((word) => word[0].toUpperCase())
					.join('')
	);

	// Every till warning that is not the connection or the unsynced count, merged
	// into the bar's ONE warnings chip. Each is written out in full in its panel.
	const warnings = $derived(
		[
			unsyncedUnreadable ? 'Unsynced count unavailable' : null,
			parked > 0 ? `${parked} operations from a previous registration` : null,
			skewMinutes !== null ? `Clock is off by ${skewMinutes} min` : null,
			menuSyncError !== null && online ? 'Menu update failed — reload the till' : null,
			signedIn.current !== null && idleSeconds === null ? 'Idle lock not set' : null,
			printerPill !== null && (printerPill.tone === 'offline' || printerPill.tone === 'danger')
				? printerPill.text
				: null
		].filter((warning): warning is string => warning !== null)
	);

	// The browser's install prompt is captured from the shell, which is mounted
	// before any screen: Chromium fires it once, soon after the worker registers,
	// and a listener attached later would miss it. The sign-in screen offers it.
	onMount(() => captureInstallPrompt());

	onMount(() => {
		if (!('serviceWorker' in navigator)) return;
		const register = () => {
			navigator.serviceWorker
				.register('/service-worker.js', { scope: '/pos', type: dev ? 'module' : 'classic' })
				.catch(() => {
					// No worker (an insecure origin, a blocked registration): the till
					// still works online; it just cannot start offline.
				});
		};
		if (document.readyState === 'complete') register();
		else addEventListener('load', register, { once: true });
	});
</script>

<svelte:head>
	<!-- Linked from the POS shell ONLY, so no dashboard page advertises the till as
	     installable. The manifest carries the PNG icons Chromium and Android want;
	     iOS Safari ignores manifest icons and reads the apple-touch-icon link and
	     the apple-* metas below instead, so an iPad home-screen install gets the
	     same mark and opens without Safari's chrome. -->
	<link rel="manifest" href="/pos.webmanifest" />
	<link rel="apple-touch-icon" href="/pos-icon-apple-180.png" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-title" content="matcami POS" />
	<meta name="apple-mobile-web-app-status-bar-style" content="default" />
</svelte:head>

<svelte:body use:tillBody />

<!-- THE SHELL (docs/redesign Phase 1): the viewport is the frame. h-dvh and
     overflow-hidden, so the document never scrolls on the till; each screen
     scrolls inside its own panes. The wrapper's overflow-y-auto is the safety
     net for a screen that does not fit yet — a rebuilt screen fits, so it never
     scrolls. -->
<div data-surface="pos" class="text-pos bg-bg text-ink flex h-dvh flex-col overflow-hidden">
	<TillBar
		{restaurantName}
		{deviceCode}
		{online}
		unsynced={unsynced !== null
			? { count: unsynced }
			: unsyncedUnreadable
				? { unreadable: true }
				: null}
		{warnings}
		printer={printerPill}
		{clockTime}
		{today}
		session={session === null
			? null
			: { state: session.state, businessDate: session.businessDate ?? null }}
		employee={signedIn.current === null
			? null
			: {
					name: signedIn.current.displayName,
					role: roleLabel,
					initials,
					isOwner: signedIn.current.isOwner
				}}
		current={onSales ? 'sales' : page.url.pathname === '/pos/order' ? 'order' : 'other'}
	/>
	<div class="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
		{@render children()}
	</div>
</div>
