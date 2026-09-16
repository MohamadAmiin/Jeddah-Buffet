// THE MENU SNAPSHOT, PURE — parse and validate a GET /api/menu payload, and compare
// versions (spec 5). No IndexedDB and no fetch: store.ts owns both.
//
// This module lives in src/lib/pos and may import nothing from lib/server, so the
// snapshot's types are declared HERE rather than imported from the Drizzle schema.
//
// parseSnapshot VALIDATES AND NEVER CONVERTS. Every *Minor field must be a decimal
// STRING (/^-?\d+$/) and comes back as that same string. A JSON NUMBER in a *Minor
// position is REJECTED with an error naming the field — never coerced — because a
// number there means the server has regressed to Number(), and above 2^53 a number
// is a float that silently changed the amount before it ever reached a bill.
// BigInt() is applied in exactly one place: readMenu() in store.ts.
//
// NO MONEY ARITHMETIC. The till stores and displays in this plan. Totalling a bill
// belongs to the sales plan, which must import src/lib/money — the one rounding
// rule spec 17 requires — and never copy any of it into src/lib/pos.

export type SnapshotCategory = { id: string; name: string; sortOrder: number };

export type SnapshotItem = {
	id: string;
	categoryId: string;
	name: string;
	/** A decimal string of minor units, exactly as the server sent it. */
	priceMinor: string;
	/** Integer basis points, or null — "inherit the restaurant rate". */
	taxRateBp: number | null;
	isAvailable: boolean;
	sortOrder: number;
	modifierGroupIds: string[];
};

export type SnapshotModifier = { id: string; name: string; priceDeltaMinor: string };

export type SnapshotModifierGroup = {
	id: string;
	name: string;
	minSelect: number;
	maxSelect: number;
	modifiers: SnapshotModifier[];
};

export type MenuSnapshot = {
	version: number;
	/** The restaurant this snapshot belongs to: the till replaces its copy when it changes. */
	restaurantId: string;
	currency: string | null;
	currencyExponent: number | null;
	taxMode: string | null;
	taxRateBp: number | null;
	categories: SnapshotCategory[];
	items: SnapshotItem[];
	modifierGroups: SnapshotModifierGroup[];
};

/**
 * 'replace' unless the two versions are equal. A null local version (nothing
 * cached, or a copy from another restaurant) always means replace, and so does a
 * local version AHEAD of the server's: that is corruption, and the answer is still
 * "take the server's".
 */
export function compareVersions(local: number | null, server: number): 'up-to-date' | 'replace' {
	return local !== null && local === server ? 'up-to-date' : 'replace';
}

const MINOR = /^-?\d+$/;

class SnapshotError extends Error {
	constructor(field: string, problem: string) {
		super(`menu snapshot: ${field} ${problem}`);
		this.name = 'SnapshotError';
	}
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new SnapshotError(field, 'is not an object');
	}
	return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new SnapshotError(field, 'is not an array');
	return value;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new SnapshotError(field, 'is not a string');
	return value;
}

function nullableText(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

function integer(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new SnapshotError(field, 'is not an integer');
	}
	return value;
}

function nullableInteger(value: unknown, field: string): number | null {
	return value === null ? null : integer(value, field);
}

function flag(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new SnapshotError(field, 'is not a boolean');
	return value;
}

/** A *Minor field: a decimal STRING, returned unchanged. A number is refused, never coerced. */
function minorText(value: unknown, field: string): string {
	if (typeof value !== 'string' || !MINOR.test(value)) {
		throw new SnapshotError(
			field,
			typeof value === 'number'
				? 'is a JSON number; money must arrive as a decimal string'
				: 'is not a decimal string of minor units'
		);
	}
	return value;
}

export function parseSnapshot(raw: unknown): MenuSnapshot {
	const body = record(raw, 'payload');
	return {
		version: integer(body.version, 'version'),
		restaurantId: text(body.restaurantId, 'restaurantId'),
		currency: nullableText(body.currency, 'currency'),
		currencyExponent: nullableInteger(body.currencyExponent, 'currencyExponent'),
		taxMode: nullableText(body.taxMode, 'taxMode'),
		taxRateBp: nullableInteger(body.taxRateBp, 'taxRateBp'),
		categories: list(body.categories, 'categories').map((entry, i) => {
			const category = record(entry, `categories[${i}]`);
			return {
				id: text(category.id, `categories[${i}].id`),
				name: text(category.name, `categories[${i}].name`),
				sortOrder: integer(category.sortOrder, `categories[${i}].sortOrder`)
			};
		}),
		items: list(body.items, 'items').map((entry, i) => {
			const item = record(entry, `items[${i}]`);
			return {
				id: text(item.id, `items[${i}].id`),
				categoryId: text(item.categoryId, `items[${i}].categoryId`),
				name: text(item.name, `items[${i}].name`),
				priceMinor: minorText(item.priceMinor, `items[${i}].priceMinor`),
				taxRateBp: nullableInteger(item.taxRateBp, `items[${i}].taxRateBp`),
				isAvailable: flag(item.isAvailable, `items[${i}].isAvailable`),
				sortOrder: integer(item.sortOrder, `items[${i}].sortOrder`),
				modifierGroupIds: list(item.modifierGroupIds, `items[${i}].modifierGroupIds`).map((id, j) =>
					text(id, `items[${i}].modifierGroupIds[${j}]`)
				)
			};
		}),
		modifierGroups: list(body.modifierGroups, 'modifierGroups').map((entry, i) => {
			const group = record(entry, `modifierGroups[${i}]`);
			return {
				id: text(group.id, `modifierGroups[${i}].id`),
				name: text(group.name, `modifierGroups[${i}].name`),
				minSelect: integer(group.minSelect, `modifierGroups[${i}].minSelect`),
				maxSelect: integer(group.maxSelect, `modifierGroups[${i}].maxSelect`),
				modifiers: list(group.modifiers, `modifierGroups[${i}].modifiers`).map((m, j) => {
					const modifier = record(m, `modifierGroups[${i}].modifiers[${j}]`);
					const at = `modifierGroups[${i}].modifiers[${j}]`;
					return {
						id: text(modifier.id, `${at}.id`),
						name: text(modifier.name, `${at}.name`),
						priceDeltaMinor: minorText(modifier.priceDeltaMinor, `${at}.priceDeltaMinor`)
					};
				})
			};
		})
	};
}
