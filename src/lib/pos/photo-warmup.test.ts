import { describe, expect, it } from 'vitest';
import { warmMenuPhotos } from './photo-warmup';

// A fetch stub that records every URL and the most requests ever in flight.
function stubFetch(answer: (url: string) => Promise<Response>) {
	const urls: string[] = [];
	let inFlight = 0;
	let peak = 0;
	const fn = (async (url: string) => {
		urls.push(url);
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		try {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return await answer(url);
		} finally {
			inFlight -= 1;
		}
	}) as unknown as typeof fetch;
	return { fn, urls, peak: () => peak };
}

const ok = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

describe('warmMenuPhotos (menu-and-printing T-15)', () => {
	it('fetches each distinct photo once, at its till URL, and reads the body', async () => {
		const fetchStub = stubFetch(ok);
		const result = await warmMenuPhotos(
			[{ imageId: 'a' }, { imageId: 'b' }, { imageId: 'a' }, { imageId: null }],
			fetchStub.fn
		);
		expect(result).toEqual({ warmed: 2, failed: 0 });
		expect([...fetchStub.urls].sort()).toEqual(['/api/menu/images/a', '/api/menu/images/b']);
	});

	it('counts a 404 and a rejected fetch as failed, and never throws', async () => {
		const fetchStub = stubFetch(async (url) => {
			if (url.endsWith('/gone')) return new Response('', { status: 404 });
			if (url.endsWith('/boom')) throw new TypeError('network down');
			return ok();
		});
		const result = await warmMenuPhotos(
			[{ imageId: 'fine' }, { imageId: 'gone' }, { imageId: 'boom' }],
			fetchStub.fn
		);
		expect(result).toEqual({ warmed: 1, failed: 2 });
	});

	it('never has more than four requests in flight', async () => {
		const fetchStub = stubFetch(ok);
		const items = Array.from({ length: 12 }, (_, i) => ({ imageId: `p${i}` }));
		const result = await warmMenuPhotos(items, fetchStub.fn);
		expect(result).toEqual({ warmed: 12, failed: 0 });
		expect(fetchStub.peak()).toBeLessThanOrEqual(4);
		expect(fetchStub.peak()).toBe(4);
	});

	it('honours a custom concurrency and does nothing with no photos', async () => {
		const two = stubFetch(ok);
		await warmMenuPhotos(
			Array.from({ length: 6 }, (_, i) => ({ imageId: `q${i}` })),
			two.fn,
			2
		);
		expect(two.peak()).toBe(2);

		const none = stubFetch(ok);
		expect(await warmMenuPhotos([{ imageId: null }], none.fn)).toEqual({ warmed: 0, failed: 0 });
		expect(none.urls).toEqual([]);
	});
});
