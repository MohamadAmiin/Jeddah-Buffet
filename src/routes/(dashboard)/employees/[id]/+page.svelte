<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageHeader,
		PinField,
		SelectField,
		StatusMark
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	function formatLockedUntil(value: Date | string, timeZone: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			timeZone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(new Date(value));
	}

	const roleOptions = $derived(
		data.roles.map((role) => ({
			value: role.value,
			label: role.label,
			disabled: role.disabled
		}))
	);

	const isOwner = $derived(data.employee.kind === 'owner');
</script>

<svelte:head>
	<title>{data.employee.displayName} · Employees · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Employees"
	title={data.employee.displayName}
	description={isOwner ? 'Owner · holds every permission' : (data.employee.roleName ?? 'Staff')}
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

	{#if !isOwner}
		<Card class="max-w-form">
			<form method="POST" action="?/update" class="flex flex-col gap-5" use:enhance>
				<h3 class="text-ink font-semibold">Details</h3>

				<Field
					id="displayName"
					name="displayName"
					label="Name"
					value={data.employee.displayName}
					required
				/>

				<SelectField
					id="roleId"
					name="roleId"
					label="Role"
					value={data.employee.roleId ?? ''}
					options={roleOptions}
					placeholder="Choose a role"
					required
				/>

				<div>
					<Button type="submit" variant="primary">Save</Button>
				</div>
			</form>
		</Card>
	{:else}
		<Card class="max-w-form">
			<h3 class="text-ink font-semibold">Details</h3>
			<p class="text-ink-2 mt-2 text-sm">The owner's name is changed on Settings.</p>
		</Card>
	{/if}

	<Card class="max-w-form">
		<div class="flex flex-col gap-5">
			<div>
				<h3 class="text-ink font-semibold">PIN</h3>

				<div class="mt-2">
					<StatusMark
						status={data.employee.hasPin ? 'done' : 'not-started'}
						label={data.employee.hasPin ? 'PIN set' : 'No PIN yet'}
					/>
				</div>
			</div>

			<form method="POST" action="?/setPin" class="flex flex-col gap-5" use:enhance>
				<PinField id="new-pin" name="pin" label="New PIN" hint="4 to 6 digits." required />

				<div>
					<Button type="submit" variant="secondary">Set PIN</Button>
				</div>
			</form>

			<div class="border-line flex flex-col gap-3 border-t pt-4">
				{#if data.employee.lockedUntil}
					<div class="flex flex-wrap items-center gap-2">
						<StatusMark
							status="blocked"
							label={`Locked until ${formatLockedUntil(data.employee.lockedUntil, data.timeZone)} after 5 wrong attempts`}
						/>

						<form method="POST" action="?/clearLockout" use:enhance>
							<Button type="submit" variant="secondary">Clear lockout</Button>
						</form>
					</div>
				{:else if data.employee.failedPinCount > 0}
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-ink-2 text-sm">
							{data.employee.failedPinCount} wrong attempts so far
						</span>

						<form method="POST" action="?/clearLockout" use:enhance>
							<Button type="submit" variant="secondary">Clear lockout</Button>
						</form>
					</div>
				{:else}
					<p class="text-ink-2 text-sm">No lockout.</p>
				{/if}
			</div>
		</div>
	</Card>

	{#if !isOwner}
		<Card class="max-w-form">
			<div class="flex flex-col gap-5">
				<h3 class="text-ink font-semibold">Status</h3>

				{#if data.employee.isActive}
					<StatusMark status="done" label="Active" />

					<form method="POST" action="?/deactivate" use:enhance>
						<Button type="submit" variant="danger">Deactivate</Button>
					</form>

					<p class="text-ink-2 text-sm">
						They disappear from the till the next time it loads the staff list; nothing they did is
						deleted.
					</p>
				{:else}
					<StatusMark status="not-started" label="Inactive" />

					<form method="POST" action="?/reactivate" class="flex flex-col gap-5" use:enhance>
						{#if data.employee.roleArchived}
							<SelectField
								id="reactivate-roleId"
								name="roleId"
								label="Role"
								options={roleOptions.filter((role) => !role.disabled)}
								placeholder="Choose a role"
								hint={`${data.employee.roleName} is archived; choose a role to reactivate.`}
								required
							/>
						{/if}

						<div>
							<Button type="submit" variant="secondary">Reactivate</Button>
						</div>
					</form>
				{/if}
			</div>
		</Card>
	{/if}
</div>
