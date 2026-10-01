<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Card,
		CheckField,
		CreatePanel,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		StatusMark
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	const liveRoles = $derived(data.roles.filter((role) => !role.archivedAt));
	const archivedRoles = $derived(data.roles.filter((role) => role.archivedAt));

	// Which form produced `form`, so its outcome renders inside that form's card.
	// With JavaScript the enhance callback records the action and the role; without
	// it, only the action is known (the POST lands on this URL with it as the search).
	let submitted = $state<{ action: string; roleId: string } | null>(null);
	const lastAction = $derived(submitted?.action ?? page.url.search);
	const lastRoleId = $derived(submitted?.roleId ?? '');
	function track({ action, formData }: { action: URL; formData: FormData }) {
		submitted = { action: action.search, roleId: String(formData.get('roleId') ?? '') };
	}

	const hasResult = $derived(form?.message !== undefined);
	const createResult = $derived(hasResult && lastAction === '?/create');
	// A role result belongs to that role's card, or — once archived — to the
	// archived list. A no-JavaScript submit names no role: it shows above the cards.
	const roleResultId = $derived(hasResult && !createResult ? lastRoleId : '');
	const archivedResult = $derived(
		roleResultId !== '' && archivedRoles.some((role) => role.id === roleResultId)
	);
	const unplacedResult = $derived(
		hasResult && !createResult && !data.roles.some((role) => role.id === roleResultId)
	);

	// The create panel: open below xl on ?add=1, when there is no live role, or
	// when the create form has just produced a result.
	let opened = $state(false);
	const asideOpen = $derived(
		opened || page.url.searchParams.get('add') === '1' || liveRoles.length === 0 || createResult
	);

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('new-role-name')?.focus();
	}
</script>

<svelte:head>
	<title>Roles · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Employees', href: resolve('/employees') }]}
	title="Roles"
	description="What each role may do at the till. A change reaches the till the next time it loads the staff list."
>
	{#snippet actions()}
		<Button href="?add=1#new-role" variant="primary" class="xl:hidden" onclick={openPanel}>
			New role
		</Button>
	{/snippet}
</PageHeader>

<PageBody>
	<PageColumns collapsible {asideOpen}>
		{#if unplacedResult}
			<Alert {tone}>{form?.message}</Alert>
		{/if}

		<div class="grid items-start gap-6 lg:grid-cols-2">
			{#each liveRoles as role (role.id)}
				<Card class="flex flex-col gap-4">
					<h3 class="text-section">{role.name}</h3>

					{#if roleResultId === role.id}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<!-- reset: false — a reset would put back the checkboxes as first
					     rendered, and the next save would re-submit unticked permissions. -->
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
						<input type="hidden" name="roleId" value={role.id} />

						<Field
							id={`role-${role.id}-name`}
							name="name"
							label="Name"
							value={role.name}
							required
						/>

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
							<Button type="submit">Save role</Button>
						</div>
					</form>

					<div class="border-line-soft border-t pt-4">
						<form
							method="POST"
							action="?/archive"
							class="flex flex-col gap-2"
							use:enhance={(input) => {
								track(input);
								return async ({ update }) => {
									await update({ reset: false });
								};
							}}
						>
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
		</div>

		<Card class="flex flex-col gap-4">
			<h3 class="text-section">Archived roles</h3>

			{#if archivedResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<div class="flex flex-col gap-3">
				{#if archivedRoles.length > 0}
					{#each archivedRoles as role (role.id)}
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

		{#snippet aside()}
			<CreatePanel id="new-role" title="New role">
				<form method="POST" action="?/create" class="flex flex-col gap-4" use:enhance={track}>
					{#if createResult}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

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
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
