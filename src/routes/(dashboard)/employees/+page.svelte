<script lang="ts">
	// THE EMPLOYEES PAGE. A PIN is typed here once and hashed on the server; this
	// page never shows one, and its load carries only whether one is set.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Alert, Button, Card, Field, PageHeader, StatusMark } from '$lib/components/ui';

	let { data, form } = $props();

	// Tone follows the outcome: page.status is 400 after a fail() and 200 otherwise.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	const ROLE_LABEL: Record<string, string> = {
		owner: 'Owner',
		cashier: 'Cashier',
		waiter: 'Waiter'
	};
</script>

<svelte:head>
	<title>Employees · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="Employees"
	description="The people who sign in at the till, and the PIN each one types there. The owner’s PIN also approves refunds, voids and the other sensitive actions."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<!-- EXACTLY ONE role="alert" region: the form's message, and nothing else. -->
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card class="max-w-form">
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Staff</h3>
			<ul class="flex flex-col">
				{#each data.employees as employee (employee.id)}
					<li class="border-line flex flex-col gap-3 border-t py-4 first:border-t-0">
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span class="text-ink font-semibold">{employee.displayName}</span>
							<span class="text-ink-2">{ROLE_LABEL[employee.role] ?? employee.role}</span>
							<!-- Glyph AND words: colour never carries meaning alone. -->
							<StatusMark
								status={employee.hasPin ? 'done' : 'not-started'}
								label={employee.hasPin ? 'PIN set' : 'No PIN yet'}
							/>
						</div>
						<!-- The owner's row is here too: it is how the owner's approval PIN is set. -->
						<form
							method="POST"
							action="?/setPin"
							class="flex flex-wrap items-end gap-3"
							use:enhance
						>
							<input type="hidden" name="userId" value={employee.id} />
							<Field
								id={`pin-${employee.id}`}
								name="pin"
								label="New PIN"
								type="password"
								inputmode="numeric"
								autocomplete="off"
								required
							/>
							<Button type="submit" variant="secondary">Set PIN</Button>
						</form>
					</li>
				{/each}
			</ul>
		</div>
	</Card>

	<Card class="max-w-form">
		<form method="POST" action="?/createEmployee" class="flex flex-col gap-5" use:enhance>
			<h3 class="text-ink font-semibold">Add an employee</h3>
			<Field id="displayName" name="displayName" label="Name" required />

			<!-- Field renders an <input> only, so the radios are built here. -->
			<fieldset class="flex flex-col gap-2">
				<legend class="text-ink-2 text-sm font-medium">Role</legend>
				<label class="text-ink flex items-center gap-2">
					<input type="radio" name="role" value="cashier" required />
					Cashier
				</label>
				<label class="text-ink flex items-center gap-2">
					<input type="radio" name="role" value="waiter" />
					Waiter
				</label>
			</fieldset>

			<!-- No email and no password: the database refuses both on a non-owner. -->
			<Field
				id="new-employee-pin"
				name="pin"
				label="PIN"
				type="password"
				inputmode="numeric"
				autocomplete="off"
				required
				hint="4 to 6 digits. The employee chooses their name at the till, then types it."
			/>

			<p class="text-caption text-ink-2">
				The MVP is designed around one cashier and one waiter, but a second of either can be added:
				there is no way to remove an employee yet, so a mistyped name would otherwise be a dead end.
			</p>

			<div>
				<Button type="submit" variant="primary">Create employee</Button>
			</div>
		</form>
	</Card>
</div>
