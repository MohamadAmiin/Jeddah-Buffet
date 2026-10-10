import { error, type RequestHandler } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { downloadsDir, openDownload } from '$lib/server/print-agent-downloads';

// GET /downloads/print-agent/<file> — one print agent installer (tasks/
// print-agent-installer T-12).
//
// PUBLIC on purpose (src/lib/public-routes.ts): a customer's till PC downloads it
// before anything is paired. SAFE because the name is only COMPARED with the
// build manifest's names (openDownload) and never joined onto a path: SvelteKit
// decodes %2F inside params.file, and a joined '../../.env' would stream the
// server's database credentials. The file is STREAMED, never read into memory —
// an installer is about 100 MB and this runs on the production server.

export const GET: RequestHandler = async ({ params }) => {
	const opened = await openDownload(downloadsDir(), params.file ?? '');
	if (!opened) error(404, 'Not found');
	const { entry, stream } = opened;
	return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(entry.bytes),
			'Content-Disposition': `attachment; filename="${entry.name}"`,
			'X-Content-Type-Options': 'nosniff',
			// The file changes on every deploy whose origin or agent changed.
			'Cache-Control': 'no-store'
		}
	});
};
