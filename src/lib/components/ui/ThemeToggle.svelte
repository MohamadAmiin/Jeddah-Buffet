<script lang="ts">
	// Light / Dark / System, written to a cookie by CLIENT JavaScript and read on the
	// server inside handleTheme. There is NO network request, NO form and NO route —
	// if this file ever imports $app/forms, calls fetch, or needs a file under
	// src/routes/, the implementation has gone wrong.
	//
	// Do NOT reach for localStorage. The cookie was chosen precisely so the server can
	// stamp data-theme during SSR, which is what prevents a flash of the wrong theme;
	// localStorage is unreadable from the server, so it would have to repaint after
	// hydration — the defect this design exists to avoid.

	import { onMount } from 'svelte';
	import { THEME_COOKIE, THEME_MAX_AGE_SECONDS, parseTheme, type Theme } from '$lib/theme';

	let selected = $state<Theme | null>(null);

	onMount(() => {
		// Read on mount, never at module top level or in the component body: this
		// component is server-rendered as part of the dashboard layout and `document`
		// does not exist there. Initialised from the ATTRIBUTE the server already
		// stamped — the rendered truth — rather than from the cookie, which is merely
		// how it got there. The first server-rendered frame therefore shows System
		// pressed and hydration corrects it; that settles a button's pressed state
		// only, because the page itself is already correctly themed by the SSR stamp.
		//
		// onMount rather than $effect: `selected` is genuine mutable state — the click
		// handlers below write it too — so svelte/prefer-writable-derived is right
		// that an $effect whose only job is assignment should not be one, and wrong
		// that this could be a $derived.
		selected = parseTheme(document.documentElement.dataset.theme);
	});

	// A Secure cookie sent over plain HTTP is discarded by the browser, and the
	// Playwright suite runs against http://localhost:4173 — an unconditional
	// `; secure` would make the preference silently fail to persist in exactly the
	// environment that tests it.
	function secureFlag(): string {
		return location.protocol === 'https:' ? '; secure' : '';
	}

	function choose(value: Theme) {
		// Order matters: write the cookie, then set the attribute. The attribute is
		// what makes the change visible NOW, with no reload; the cookie is what makes
		// it survive one.
		try {
			document.cookie = `${THEME_COOKIE}=${value}; path=/; max-age=${THEME_MAX_AGE_SECONDS}; samesite=lax${secureFlag()}`;
		} catch {
			// A blocked-cookie exception must not stop the attribute update below.
		}
		document.documentElement.dataset.theme = value;

		// Derive the pressed state from the COOKIE, not from the attribute and not
		// from the value that was clicked. The line above sets the attribute
		// unconditionally, so reading it back always returns what was clicked — only
		// the cookie can disagree. Without this, a blocked write looks like it worked
		// now and comes back wrong tomorrow, which reads as a product bug rather than
		// a browser setting.
		const persisted = document.cookie.split('; ').some((c) => c === `${THEME_COOKIE}=${value}`);
		selected = persisted ? value : parseTheme(document.documentElement.dataset.theme);
	}

	function chooseSystem() {
		try {
			document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax${secureFlag()}`;
		} catch {
			// As above.
		}
		// REMOVE the attribute entirely — that is what hands control back to
		// tokens.css's @media (prefers-color-scheme: dark) block. Setting it to
		// "system" or to "" would leave an attribute matching neither
		// :root[data-theme="dark"] nor :root:not([data-theme="light"]) correctly.
		// There are two cookie values and one absence; keep it that way.
		delete document.documentElement.dataset.theme;

		// The mirror-image check: here the cookie is EXPIRED rather than written, so
		// there is no value to compare — assert its ABSENCE. Without this the same
		// failure hides where it is hardest to notice: the owner clicks System, the
		// deletion is blocked, and the page comes back dark tomorrow.
		const cleared = !document.cookie.split('; ').some((c) => c.startsWith(`${THEME_COOKIE}=`));
		selected = cleared ? null : parseTheme(document.documentElement.dataset.theme);
	}

	// The selected option is distinguishable by a surface AND a border AND weight, not
	// by hue alone — colour never carries meaning alone. aria-pressed is what a
	// screen-reader user gets; a sighted user gets the words.
	const chosen = 'bg-raise-2 border-control-line text-ink font-medium';
	const notChosen = 'border-transparent text-ink-2';
</script>

<!-- Each button's accessible name is EXACTLY its own word. No "Switch to…" prefix and
     no icon-only button leaning on a title attribute. Playwright matches an
     accessible name as a case-insensitive substring, so a label containing
     `Sign out`, `Sign in`, `Save settings` or `Create restaurant` would make an
     existing journey step resolve to two elements; Light, Dark and System contain
     none of them. -->
<div role="group" aria-label="Theme" class="border-line rounded-control flex gap-1 border p-1">
	<button
		type="button"
		aria-pressed={selected === 'light'}
		onclick={() => choose('light')}
		class={`rounded-control border px-2 py-1 text-xs ${selected === 'light' ? chosen : notChosen}`}
	>
		Light
	</button>
	<button
		type="button"
		aria-pressed={selected === 'dark'}
		onclick={() => choose('dark')}
		class={`rounded-control border px-2 py-1 text-xs ${selected === 'dark' ? chosen : notChosen}`}
	>
		Dark
	</button>
	<button
		type="button"
		aria-pressed={selected === null}
		onclick={chooseSystem}
		class={`rounded-control border px-2 py-1 text-xs ${selected === null ? chosen : notChosen}`}
	>
		System
	</button>
</div>
