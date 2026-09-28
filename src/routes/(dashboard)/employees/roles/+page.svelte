<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Card,
		CheckField,
		Field,
		PageHeader,
		StatusMark
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
</script>

<svelte:head>
	<title>Roles � matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Employees"
	title="Roles"
	description="What each role may do at the till. A change reaches the till the next time it loads the staff list."
>
	{#snippet actions()}
		<Button href={resolve('/employees')} variant="ghost">All employees</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	{#each data.roles.filter((role) => !role.archivedAt) as role (role.id)}
		<Card class="max-w-form">
			<form method="POST" action="?/update" class="flex flex-col gap-5" use:enhance>
				<input type="hidden" name="roleId" value={role.id} />

				<Field id={`role-${role.id}-name`} name="name" label="Name" value={role.name} required />

				<fieldset class="flex flex-col gap-3">
					<legend class="text-ink-2 text-sm font-medium">Permissions at the till</legend>

					{#each data.keys as permission (permission.key)}
						<CheckField
							id={`role-${role.id}-${permission.key}`}
							name="permissionKeys"
							value={permission.key}
							label={permission.label}
							checked={role.permissionKeys.includes(permission.key)}
						/>
					{/each}
				</fieldset>

				<p class="text-ink-2 text-sm">
					{role.staffCount} staff, {role.activeStaffCount} active
				</p>

				<div class="flex flex-wrap items-start gap-2">
					<Button type="submit" variant="secondary">Save role</Button>
				</div>
			</form>

			<div class="mt-4 border-line border-t pt-4">
				<form method="POST" action="?/archive" class="flex flex-col gap-2" use:enhance>
					<input type="hidden" name="roleId" value={role.id} />

					<Button
						type="submit"
						variant="danger"
						disabled={role.activeStaffCount > 0}
						disabledReason={role.activeStaffCount > 0
							? `In use by ${role.activeStaffCount} active staff`
							: ''}
					>
						Archive
					</Button>
				</form>
			</div>
		</Card>
	{/each}

	<Card class="max-w-form">
		<h3 class="text-ink font-semibold">Archived roles</h3>

		<div class="mt-4 flex flex-col gap-3">
			{#if data.roles.some((role) => role.archivedAt)}
				{#each data.roles.filter((role) => role.archivedAt) as role (role.id)}
					<div class="flex items-center justify-between gap-3">
						<span class="text-ink-2">{role.name}</span>
						<StatusMark status="blocked" label="archived" />
					</div>
				{/each}
			{:else}
				<p class="text-ink-2 text-sm">None.</p>
			{/if}
		</div>
	</Card>

	<Card class="max-w-form">
		<form method="POST" action="?/create" class="flex flex-col gap-5" use:enhance>
			<h3 class="text-ink font-semibold">New role</h3>

			<Field id="new-role-name" name="name" label="Name" required />

			<fieldset class="flex flex-col gap-3">
				<legend class="text-ink-2 text-sm font-medium">Permissions at the till</legend>

				{#each data.keys as permission (permission.key)}
					<CheckField
						id={`new-role-${permission.key}`}
						name="permissionKeys"
						value={permission.key}
						label={permission.label}
					/>
				{/each}
			</fieldset>

			<div>
				<Button type="submit" variant="primary">Create role</Button>
			</div>
		</form>
	</Card>
</div>
