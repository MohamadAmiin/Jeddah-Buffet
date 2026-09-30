<script lang="ts" module>
	export type IconName =
		| 'bag'
		| 'store'
		| 'calendar'
		| 'lock'
		| 'clock'
		| 'check-circle'
		| 'table'
		| 'search'
		| 'clipboard'
		| 'info'
		| 'plus-circle'
		| 'trash'
		| 'wifi'
		| 'wifi-off'
		| 'grid'
		| 'utensils'
		| 'chevron-down'
		| 'delivery'
		| 'printer'
		| 'arrow-left'
		| 'arrow-right'
		| 'backspace'
		| 'card'
		| 'cash'
		| 'check'
		| 'chevron-left'
		| 'chevron-right'
		| 'chevron-up'
		| 'log-out'
		| 'menu'
		| 'minus'
		| 'monitor'
		| 'moon'
		| 'phone'
		| 'plus'
		| 'refresh'
		| 'sun'
		| 'user-plus'
		| 'x';
</script>

<script lang="ts">
	// The ONE line-icon set, for the till and the dashboard alike (docs/redesign
	// Phase 0). Decorative ONLY: every icon sits beside the words that carry its
	// meaning, so each one is aria-hidden and never a control's only label. It
	// draws in currentColor, so the caller's text token colours it. The stroke is
	// 1.8 by default and 1.6 on the rail.
	let {
		name,
		class: className = 'size-5',
		stroke = 1.8
	}: { name: IconName; class?: string; stroke?: number } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
	class="shrink-0 {className}"
>
	{#if name === 'bag'}
		<path d="M5.5 8h13l-1.2 12.2a1 1 0 0 1-1 .8H7.7a1 1 0 0 1-1-.8L5.5 8z" />
		<path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
	{:else if name === 'store'}
		<path d="M3 9.5 4.6 4h14.8L21 9.5" />
		<path d="M3 9.5h18v1a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" />
		<path d="M5 13v7h14v-7" />
		<path d="M10 20v-4h4v4" />
	{:else if name === 'calendar'}
		<rect x="3.5" y="5" width="17" height="15.5" rx="2" />
		<path d="M3.5 10h17M8 3v4M16 3v4" />
		<path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
	{:else if name === 'lock'}
		<rect x="5" y="10.5" width="14" height="10" rx="2" />
		<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
	{:else if name === 'clock'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7v5l3 2" />
	{:else if name === 'check-circle'}
		<circle cx="12" cy="12" r="9" />
		<path d="m8 12.2 2.8 2.8L16 9.5" />
	{:else if name === 'table'}
		<path d="M3 9h18" />
		<path d="M5 9 4 20M19 9l1 11" />
		<path d="M4.5 14h15" />
		<path d="M8 5h8" />
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="6.5" />
		<path d="m20 20-4.2-4.2" />
	{:else if name === 'clipboard'}
		<rect x="5" y="4.5" width="14" height="16.5" rx="2" />
		<path d="M9 3h6v3.5H9z" />
		<path d="M9 11h6M9 15h4" />
	{:else if name === 'info'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 11v5M12 8h.01" />
	{:else if name === 'plus-circle'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 8v8M8 12h8" />
	{:else if name === 'trash'}
		<path d="M4 7h16" />
		<path d="M9.5 7V4.5h5V7" />
		<path d="m6 7 1 13h10l1-13" />
		<path d="M10 11v5M14 11v5" />
	{:else if name === 'wifi'}
		<path d="M2.5 9a14 14 0 0 1 19 0" />
		<path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" />
		<path d="M8.8 16a5 5 0 0 1 6.4 0" />
		<path d="M12 19.5h.01" />
	{:else if name === 'wifi-off'}
		<path d="M8.8 16a5 5 0 0 1 6.4 0" />
		<path d="M12 19.5h.01" />
		<path d="M5.5 12.5a9.5 9.5 0 0 1 5-2.4M2.5 9a14 14 0 0 1 5.3-3.1" />
		<path d="m3 3 18 18" />
	{:else if name === 'grid'}
		<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
	{:else if name === 'utensils'}
		<path d="M6 3v8M4 3v4.5a2 2 0 0 0 4 0V3M6 11v10" />
		<path d="M18 21V3c-2.2 0-3.5 2.4-3.5 5.5V13H18" />
	{:else if name === 'chevron-down'}
		<path d="m6 9 6 6 6-6" />
	{:else if name === 'delivery'}
		<!-- A scooter: two wheels, the deck, the steering column and a box on the back. -->
		<circle cx="6" cy="17" r="2.5" />
		<circle cx="18" cy="17" r="2.5" />
		<path d="M8.5 17h7" />
		<path d="M15.5 17 13 8.5h-3" />
		<path d="M13 8.5 15.5 5h3" />
		<rect x="3" y="9" width="6" height="5" rx="1" />
	{:else if name === 'printer'}
		<!-- A receipt printer: the paper feeding in, the body, the printed slip coming out. -->
		<path d="M7 8.5V4h10v4.5" />
		<rect x="3.5" y="8.5" width="17" height="8" rx="2" />
		<path d="M7 14h10v6H7z" />
		<path d="M17 11.5h.01" />
	{:else if name === 'arrow-left'}
		<path d="M19 12H5" />
		<path d="M11 6l-6 6 6 6" />
	{:else if name === 'arrow-right'}
		<path d="M5 12h14" />
		<path d="M13 6l6 6-6 6" />
	{:else if name === 'backspace'}
		<path d="M21 6H9l-6 6 6 6h12z" />
		<path d="M12.5 9.5l5 5" />
		<path d="M17.5 9.5l-5 5" />
	{:else if name === 'card'}
		<path d="M3 6h18v12H3z" />
		<path d="M3 10h18" />
		<path d="M7 14.5h4" />
	{:else if name === 'cash'}
		<path d="M3 6.5h18v11H3z" />
		<path d="M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
		<path d="M6.5 10v4" />
		<path d="M17.5 10v4" />
	{:else if name === 'check'}
		<path d="M5 12.5l4.5 4.5L19 7.5" />
	{:else if name === 'chevron-left'}
		<path d="M15 6l-6 6 6 6" />
	{:else if name === 'chevron-right'}
		<path d="M9 6l6 6-6 6" />
	{:else if name === 'chevron-up'}
		<path d="M6 15l6-6 6 6" />
	{:else if name === 'log-out'}
		<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
		<path d="M9.5 16.5 5 12l4.5-4.5" />
		<path d="M5 12h11" />
	{:else if name === 'menu'}
		<path d="M4 6.5h16" />
		<path d="M4 12h16" />
		<path d="M4 17.5h16" />
	{:else if name === 'minus'}
		<path d="M5 12h14" />
	{:else if name === 'monitor'}
		<path d="M3 5h18v11H3z" />
		<path d="M8.5 20h7" />
		<path d="M12 16v4" />
	{:else if name === 'moon'}
		<path d="M20 14.2A8.3 8.3 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" />
	{:else if name === 'phone'}
		<path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M11 18h2" />
	{:else if name === 'plus'}
		<path d="M12 5v14" />
		<path d="M5 12h14" />
	{:else if name === 'refresh'}
		<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
		<path d="M4 3.5V8h4.5" />
		<path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />
		<path d="M20 20.5V16h-4.5" />
	{:else if name === 'sun'}
		<path d="M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z" />
		<path d="M12 2.5v2" />
		<path d="M12 19.5v2" />
		<path d="M4.2 4.2l1.4 1.4" />
		<path d="M18.4 18.4l1.4 1.4" />
		<path d="M2.5 12h2" />
		<path d="M19.5 12h2" />
		<path d="M4.2 19.8l1.4-1.4" />
		<path d="M18.4 5.6l1.4-1.4" />
	{:else if name === 'user-plus'}
		<path d="M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
		<path d="M3.5 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
		<path d="M19 8v6" />
		<path d="M16 11h6" />
	{:else if name === 'x'}
		<path d="M6 6l12 12" />
		<path d="M18 6L6 18" />
	{/if}
</svg>
