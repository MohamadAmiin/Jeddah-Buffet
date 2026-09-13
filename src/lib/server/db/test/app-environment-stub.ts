// Stands in for $app/environment under Vitest, which runs outside SvelteKit.
// `building` is false because a test is a running process, not a build.
export const building = false;
export const dev = false;
export const browser = false;
export const version = 'test';
