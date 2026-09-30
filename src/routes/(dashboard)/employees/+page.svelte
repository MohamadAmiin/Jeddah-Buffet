<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import {
		Alert,
		Button,
		Card,
		CreatePanel,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		PinField,
		SelectField,
		StatusMark,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// The create panel is open below xl when the URL asks for it (?add=1), when the
	// list is empty, or when this page's one form has just produced a result —
	// success or failure — so the outcome is on screen with or without JavaScript.
	let opened = $state(false);
	const asideOpen = $derived(
		opened ||
			page.url.searchParams.get('add') === '1' ||
			data.employees.length === 0 ||
			form?.message !== undefined
	);

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('displayName')?.focus();
	}

	const activeCount = $derived(data.employees.filter((employee) => employee.isActive).length);
	const peopleCaption = $derived(
		`${data.employees.length} ${data.employees.length === 1 ? 'person' : 'people'} · ${activeCount} active`
	);

	const columns = [
		{ key: 'name', label: 'Name' },
		{ key: 'role', label: 'Role' },
		{ key: 'pin', label: 'PIN' },
		{ key: 'status', label: 'Status' }
	];

	function formatLockedUntil(value: Date | string, timeZone: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			timeZone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(new Date(value));
	}
</script>

<svelte:head>
	<title>Employees · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="Employees"
	description="The people who sign in at the till, what each may do there, and the PIN each one types. The owner's PIN also approves refunds, voids and the other sensitive actions."
>
	{#snippet actions()}
		<Button href={resolve('/employees/roles')}>Manage roles</Button>
		<Button href="?add=1#add-employee" variant="primary" class="xl:hidden" onclick={openPanel}>
			Add an employee
		</Button>
	{/snippet}
</PageHeader>

<PageBody>
	<PageColumns collapsible {asideOpen}>
		<Card class="flex flex-col gap-2">
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h3 id="staff-h" class="text-section">Staff</h3>
				<p class="text-caption text-ink-2">{peopleCaption}</p>
			</div>

			<Table
				caption="Staff"
				{columns}
				rows={data.employees}
				empty="No staff yet. Add the first person with Add an employee."
			>
				{#snippet cell(employee, key)}
					{#if key === 'name'}
						<a
							class={`font-medium underline-offset-2 hover:underline ${
								employee.isActive ? 'text-ink' : 'text-ink-3'
							}`}
							href={resolve(`/employees/${employee.id}`)}
						>
							{employee.displayName}
						</a>
					{:else if key === 'role'}
						<div class="flex items-center gap-2">
							<span class={employee.isActive ? 'text-ink' : 'text-ink-3'}>
								{employee.roleName ?? employee.kind}
							</span>
							{#if employee.roleArchived}
								<StatusMark status="blocked" label="archived" />
							{/if}
						</div>
					{:else if key === 'pin'}
						<StatusMark
							status={employee.hasPin ? 'done' : 'not-started'}
							label={employee.hasPin ? 'PIN set' : 'No PIN yet'}
						/>
					{:else if key === 'status'}
						<div class="flex flex-wrap items-center gap-2">
							<StatusMark
								status={employee.isActive ? 'done' : 'not-started'}
								label={employee.isActive ? 'Active' : 'Inactive'}
							/>
							{#if employee.lockedUntil}
								<StatusMark
									status="blocked"
									label={`Locked until ${formatLockedUntil(employee.lockedUntil, data.timeZone)}`}
								/>
							{/if}
						</div>
					{/if}
				{/snippet}
			</Table>
		</Card>

		{#snippet aside()}
			<CreatePanel id="add-employee" title="Add an employee" icon="user-plus">
				<form method="POST" action="?/createEmployee" class="flex flex-col gap-4" use:enhance>
					{#if form?.message}
						<Alert {tone}>{form.message}</Alert>
					{/if}

					<Field id="displayName" name="displayName" label="Name" required />

					{#if data.roles.length > 0}
						<SelectField
							id="roleId"
							name="roleId"
							label="Role"
							placeholder="Choose a role"
							options={data.roles.map((role) => ({
								value: role.id,
								label: role.name
							}))}
							hint="What a role may do at the till is set under Manage roles."
							required
						/>
					{:else}
						<SelectField
							id="roleId"
							name="roleId"
							label="Role"
							placeholder="Choose a role"
							options={[]}
							disabled
							disabledReason="Create a role first"
							hint="Create a role first under Manage roles."
						/>
					{/if}

					<PinField id="new-employee-pin" name="pin" label="PIN" hint="4 to 6 digits." required />

					<div>
						<Button type="submit" variant="primary">Create employee</Button>
					</div>
				</form>
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
