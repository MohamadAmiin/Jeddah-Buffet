<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageHeader,
		PinField,
		SelectField,
		StatusMark,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');

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
		<Button href="/employees/roles" variant="secondary">Manage roles</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card class="max-w-page">
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Staff</h3>

			<Table
				caption="Staff"
				{columns}
				rows={data.employees}
				empty="No staff yet. Add the first person below."
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
		</div>
	</Card>

	<Card class="max-w-form">
		<form method="POST" action="?/createEmployee" class="flex flex-col gap-5" use:enhance>
			<h3 class="text-ink font-semibold">Add an employee</h3>

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
	</Card>
</div>
