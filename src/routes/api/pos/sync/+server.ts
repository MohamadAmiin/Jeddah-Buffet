// POST /api/pos/sync — the till hands the server one queued operation and the
// server records it inside ONE all-or-nothing transaction (spec 13, invariant
// 4). The route does five things and nothing more: (1) requireDevice, (2)
// content type, (3) body parse, (4) envelope schema, (5) hand to handleOp
// and return its answer with cache-control: no-store. The tenant is the
// device row's; the employee named inside a device-sourced op is checked by
// the module on the tender class (assumption R9 / invariant 8).

import { json, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db/client';
import { requireDevice } from '$lib/server/auth/pos-context';
import { requestContext } from '$lib/server/audit';
import { handleOp } from '$lib/server/orders/sync';
import { OP_KINDS, type OpEnvelope, type OpKind } from '$lib/sync-ops';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const envelopeSchema = z.object({
	kind: z.enum(OP_KINDS as unknown as [OpKind, ...OpKind[]]),
	clientOpId: z.string().uuid(),
	deviceId: z.string().uuid(),
	employeeId: z.string().uuid(),
	occurredAt: z.string().datetime({ offset: true }),
	seq: z.number().int().min(0),
	payload: z.unknown()
});

export const POST: RequestHandler = async (event) => {
	const device = await requireDevice(event);

	const contentType = event.request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('application/json')) {
		return json({ error: 'unsupported_media_type' }, { status: 415, headers: NO_STORE });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
	}

	const parsed = envelopeSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
	}

	const result = await handleOp(
		db,
		device,
		requestContext(event),
		parsed.data as OpEnvelope<OpKind, unknown>
	);
	return json(result.body, { status: result.http, headers: NO_STORE });
};
