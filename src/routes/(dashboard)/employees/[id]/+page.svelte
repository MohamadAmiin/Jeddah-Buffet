<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		PinField,
		SelectField,
		StatusMark
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// Which form produced `form`: an outcome renders inside the card of the form
	// that was submitted. With JavaScript the enhance callback records the action;
	// without it, the POST lands on this URL with the action as its search.
	let submitted = $state<string | null>(null);
	const lastAction = $derived(submitted ?? page.url.search);
	function track({ action }: { action: URL }) {
		submitted = action.search;
	}
	const resultIn = (actions: string[]) =>
		form?.message !== undefined && actions.some((name) => lastAction === `?/${name}`);

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
	crumbs={[{ label: 'Employees', href: resolve('/employees') }]}
	title={data.employee.displayName}
	description={isOwner ? 'Owner · holds every permission' : (data.employee.roleName ?? 'Staff')}
/>

<PageBody>
	<PageColumns>
		{#if !isOwner}
			<Card>
				<form
					method="POST"
					action="?/update"
					class="flex flex-col gap-4"
					use:enhance={(input) => {
						track(input);
						return async ({ update }) => {
							await update({ reset: false });
						};
					}}
				>
					<h3 class="text-section">Details</h3>

					{#if resultIn(['update'])}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<div class="grid gap-4 md:grid-cols-2">
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
					</div>

					<div>
						<Button type="submit" variant="primary">Save</Button>
					</div>
				</form>
			</Card>
		{:else}
			<Card class="flex flex-col gap-2">
				<h3 class="text-section">Details</h3>
				<p class="text-ink-2 text-sm">The owner's name is changed on Settings.</p>
			</Card>
		{/if}

		<Card class="flex flex-col gap-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h3 class="text-section">PIN</h3>
				<StatusMark
					status={data.employee.hasPin ? 'done' : 'not-started'}
					label={data.employee.hasPin ? 'PIN set' : 'No PIN yet'}
				/>
			</div>

			<form method="POST" action="?/setPin" class="flex flex-col gap-4" use:enhance={track}>
				{#if resultIn(['setPin'])}
					<Alert {tone}>{form?.message}</Alert>
				{/if}

				<PinField id="new-pin" name="pin" label="New PIN" hint="4 to 6 digits." required />

				<div>
					<Button type="submit">Set PIN</Button>
				</div>
			</form>
		</Card>

		{#snippet aside()}
			<Card class="flex flex-col gap-4">
				<h3 class="text-section">Status</h3>

				{#if resultIn(['clearLockout', 'deactivate', 'reactivate'])}
					<Alert {tone}>{form?.message}</Alert>
				{/if}

				{#if !isOwner}
					<StatusMark
						status={data.employee.isActive ? 'done' : 'not-started'}
						label={data.employee.isActive ? 'Active' : 'Inactive'}
					/>
				{/if}

				<div class="flex flex-col gap-3">
					{#if data.employee.lockedUntil}
						<StatusMark
							status="blocked"
							label={`Locked until ${formatLockedUntil(data.employee.lockedUntil, data.timeZone)} after 5 wrong attempts`}
						/>

						<form method="POST" action="?/clearLockout" use:enhance={track}>
							<Button type="submit">Clear lockout</Button>
						</form>
					{:else if data.employee.failedPinCount > 0}
						<span class="text-ink-2 text-sm">
							{data.employee.failedPinCount} wrong attempts so far
						</span>

						<form method="POST" action="?/clearLockout" use:enhance={track}>
							<Button type="submit">Clear lockout</Button>
						</form>
					{:else}
						<p class="text-ink-2 text-sm">No lockout.</p>
					{/if}
				</div>

				{#if !isOwner}
					<div class="border-line-soft flex flex-col gap-3 border-t pt-4">
						{#if data.employee.isActive}
							<p class="text-ink-2 text-sm">
								They disappear from the till the next time it loads the staff list; nothing they did
								is deleted.
							</p>

							<form method="POST" action="?/deactivate" use:enhance={track}>
								<Button type="submit" variant="danger">Deactivate</Button>
							</form>
						{:else}
							<form
								method="POST"
								action="?/reactivate"
								class="flex flex-col gap-3"
								use:enhance={track}
							>
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

								<p class="text-ink-2 text-sm">
									They return to the till the next time it loads the staff list.
								</p>

								<div>
									<Button type="submit">Reactivate</Button>
								</div>
							</form>
						{/if}
					</div>
				{/if}
			</Card>
		{/snippet}
	</PageColumns>
</PageBody>
