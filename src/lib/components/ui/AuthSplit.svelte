<script lang="ts">
	// THE SPLIT DOOR — the shell behind both public pages, /login and /register.
	//
	// Two panels, roughly 5:4, each filling the viewport: the FORM half on bg-raise
	// and the BRAND half on bg-accent. The two doors differ only in their words and
	// in the specimen they show, so the layout lives here exactly once — two copies
	// of one grid is precisely how two pages drift apart.
	//
	// THE STACKING MOVE IS `order`, NEVER SOURCE ORDER. The DOM keeps the form panel
	// FIRST at every width, so the first tab stop on the page is the first field. A
	// keyboard user never tabs through the brand half to reach the door. Below the
	// two-column breakpoint the brand half moves ABOVE the form visually, because it
	// is the smaller of the two and a form pushed under a full screen of brand is a
	// form nobody reaches.
	//
	// THE BREAKPOINT IS `lg` (64rem), NOT the sample's 54rem. There is no
	// --breakpoint-* token in the token layer and this file may not invent one, so
	// the split uses a stock breakpoint. lg rather than md because the form half is
	// 5/9 of the width: at md (48rem) the seven-field registration form would get
	// about 380px of content, narrower than the sample ever allowed it to be.
	//
	// ONE INK ON THE ACCENT GROUND. The token layer guarantees exactly one pair
	// against bg-accent — text-accent-ink — so every level of hierarchy in the brand
	// half is size, weight or tracking. text-ink-2 and text-ink-3 are page-ground
	// roles and are NOT legible there; a faded colour on this panel is a bug, and so
	// is `opacity`, which fades ink and ground together and defeats the audit.

	let {
		title,
		caption,
		eyebrow,
		statement,
		form,
		brand
	}: {
		/**
		 * The form half's h1. A REAL heading element: the e2e journey locates
		 * "Set up your restaurant" with getByRole('heading', …), so this must never
		 * become a styled div carrying a heading role.
		 */
		title: string;
		/** The single line under the h1. */
		caption: string;
		/** The brand half's eyebrow. */
		eyebrow: string;
		/** The brand half's one-line statement. Different on each door; never reused. */
		statement: string;
		/**
		 * The form half's body, rendered under the head. Pass it as an ATTRIBUTE from
		 * a top-level snippet, not as a child named `form` — a snippet written inside
		 * this component's block would shadow the page's own `form` prop (the action
		 * result) throughout its own body.
		 */
		form: import('svelte').Snippet;
		/** The brand half's body: the specimen check and the line saying it is one. */
		brand: import('svelte').Snippet;
	} = $props();
</script>

<main class="grid min-h-screen grid-cols-1 lg:grid-cols-9">
	<!-- The form half. px-5 is the narrow-width gutter and it is the floor: nothing
	     inside may be wider than its column, which is what min-w-0 enforces on a grid
	     child whose default min-width:auto would otherwise let a long string push the
	     whole page sideways. -->
	<div
		class="bg-raise order-2 flex min-w-0 items-center justify-center px-5 py-10 sm:px-8 sm:py-14 lg:order-1 lg:col-span-5 lg:px-14"
	>
		<div class="max-w-form flex w-full min-w-0 flex-col gap-6">
			<div class="flex flex-col gap-1">
				<!-- The mark, not a heading: the landing page owns the only <h1>matcami</h1>
				     in the product and a second one here would collide with it by name. The
				     dot is decoration and is hidden from assistive technology, so the
				     accessible text stays exactly "matcami". -->
				<p class="font-display text-ink text-section">
					matcami<span aria-hidden="true" class="text-accent">.</span>
				</p>
				<h1 class="text-ink text-title">{title}</h1>
				<p class="text-ink-2 text-caption">{caption}</p>
			</div>

			{@render form()}
		</div>
	</div>

	<!-- The brand half. aria-labelledby would need an id handed in from outside; the
	     statement is a real h2 instead, so the panel is already named by its own
	     heading in the document outline. -->
	<aside
		class="bg-accent text-accent-ink order-1 flex min-w-0 items-center justify-center px-5 py-10 sm:px-8 sm:py-14 lg:order-2 lg:col-span-4 lg:px-12"
	>
		<div class="max-w-form flex w-full min-w-0 flex-col gap-5">
			<p class="text-eyebrow font-mono uppercase">{eyebrow}</p>
			<h2 class="text-title">{statement}</h2>
			<!-- A short, full-strength rule rather than a faded full-width one: the
			     accent ground has one legal ink and no faded variant of it. -->
			<hr class="border-accent-ink w-10 border-t-2" />
			{@render brand()}
		</div>
	</aside>
</main>
