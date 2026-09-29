import { describe, expect, it } from 'vitest';
import { targetSize } from './image-resize';

// The pure part only: resizePhoto needs a browser (createImageBitmap, canvas)
// and is exercised by the e2e journey that uploads a photo through /menu.
describe('targetSize (menu-and-printing T-12)', () => {
	it('scales the longer edge down to 1024, keeping the ratio', () => {
		expect(targetSize(4000, 3000)).toEqual({ width: 1024, height: 768 });
		expect(targetSize(3000, 4000)).toEqual({ width: 768, height: 1024 });
	});

	it('never scales up', () => {
		expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
		expect(targetSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
	});

	it('never returns less than 1 on either side', () => {
		expect(targetSize(1, 5000)).toEqual({ width: 1, height: 1024 });
		expect(targetSize(5000, 1)).toEqual({ width: 1024, height: 1 });
	});

	it('honours a custom edge and rounds', () => {
		expect(targetSize(3000, 2000, 300)).toEqual({ width: 300, height: 200 });
		expect(targetSize(1000, 333, 100)).toEqual({ width: 100, height: 33 });
	});

	it('imports in the node environment without touching the DOM', async () => {
		// The static import above already ran; a fresh dynamic import proves the
		// module body itself reaches for no document, window or canvas.
		await expect(import('./image-resize')).resolves.toHaveProperty('resizePhoto');
	});
});
