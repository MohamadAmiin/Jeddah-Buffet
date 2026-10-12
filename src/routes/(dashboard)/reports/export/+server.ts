import { error, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requirePermission } from '$lib/server/permissions';
import { defaultReportDate } from '$lib/server/reports/sales';
import {
	buildExport,
	CurrencyNotSet,
	EXPORT_SECTIONS,
	ExportTooLarge
} from '$lib/server/reports/export';
import { resolveRange } from '../range';

// GET /reports/export?from&to&section — one section of the sales report as a
// CSV file (tasks/sales-report-export T-09). The URL begins with /reports,
// never /pos: the POS service worker's scope is a string prefix.
//
// GUARDED BY THE ROUTE ITSELF (invariant 8, reads included): the hook already
// refuses a non-owner a dashboard route, but +layout.server.ts never runs for a
// +server.ts, so requirePermission runs FIRST, before anything is parsed or
// read. The tenant is the session's (event.locals.restaurantId), never a query
// parameter. No audit row: report reads are not audited (gate decision 3).

const sectionSchema = z.enum(EXPORT_SECTIONS);

export const GET: RequestHandler = async (event) => {
	requirePermission(event, 'admin.reports');
	const restaurantId = event.locals.restaurantId;
	if (!restaurantId) error(500, 'No restaurant in scope');

	const section = sectionSchema.safeParse(event.url.searchParams.get('section') ?? undefined);
	if (!section.success) error(400, 'Unknown report section.');
	const range = await resolveRange(event.url.searchParams, () =>
		defaultReportDate(db, restaurantId, new Date())
	);

	let file: { filename: string; csv: string };
	try {
		file = await buildExport(db, restaurantId, range, section.data);
	} catch (e) {
		if (e instanceof ExportTooLarge) {
			error(413, 'That range has too many rows for one file. Choose a shorter date range.');
		}
		if (e instanceof CurrencyNotSet) {
			error(409, 'Set the currency in Settings before exporting reports.');
		}
		throw e;
	}

	return new Response(file.csv, {
		status: 200,
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			// The name is built from validated dates and the section enum: ASCII only.
			'Content-Disposition': `attachment; filename="${file.filename}"`,
			'Cache-Control': 'private, no-store',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin'
		}
	});
};
