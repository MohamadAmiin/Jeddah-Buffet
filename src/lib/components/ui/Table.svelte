<script lang="ts" generics="Row extends { id: string }">
	let {
		caption,
		columns,
		rows,
		cell,
		empty = 'No records'
	}: {
		caption: string;
		columns: { key: string; label: string; numeric?: boolean }[];
		rows: Row[];
		cell: import('svelte').Snippet<[Row, string]>;
		empty?: string;
	} = $props();
</script>

<table class="w-full">
	<caption class="sr-only">{caption}</caption>

	{#if rows.length > 0}
		<thead class="bg-raise-2 hidden md:table-header-group">
			<tr>
				{#each columns as column (column.key)}
					<th
						class={`text-ink-2 px-6 py-3 text-start text-xs font-medium ${
							column.numeric ? 'md:text-end' : ''
						}`}
					>
						{column.label}
					</th>
				{/each}
			</tr>
		</thead>

		<tbody>
			{#each rows as row (row.id)}
				<tr class="border-line block border-t py-3 md:table-row md:py-0">
					{#each columns as column (column.key)}
						<td
							class={`flex items-baseline justify-between gap-3 md:table-cell md:px-6 md:py-3 ${
								column.numeric ? 'font-mono tabular-nums md:text-end' : ''
							}`}
						>
							<span class="text-ink-3 text-xs md:hidden">{column.label}</span>
							{@render cell(row, column.key)}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	{:else}
		<tbody>
			<tr>
				<td colspan={columns.length} class="text-ink-2 py-3">○ {empty}</td>
			</tr>
		</tbody>
	{/if}
</table>
