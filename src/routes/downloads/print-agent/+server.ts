import { json, type RequestHandler } from '@sveltejs/kit';
import { publicManifest, readManifest } from '$lib/server/print-agent-downloads';

// GET /downloads/print-agent — the print agent installers that exist, with their
// sizes, SHA-256s and download URLs (tasks/print-agent-installer T-12). The till's
// Printer page reads it to offer the right file for its PC.
//
// PUBLIC on purpose (src/lib/public-routes.ts): the till PC fetches it before
// anything is paired. It carries the app's public origin and no secret.

export const GET: RequestHandler = async () => {
	const manifest = await readManifest();
	if (!manifest) {
		return json({ error: 'not_built' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	}
	return json(publicManifest(manifest), { headers: { 'Cache-Control': 'no-store' } });
};
