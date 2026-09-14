// The dashboard primitives, so a screen imports them in one line.
// A ui/ primitive takes its data as PROPS and imports nothing from the server
// module tree. src/lib/components/components.test.ts enforces that, and checks the
// RAW text — so this comment names no server path, deliberately.
export { default as Alert } from './Alert.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as Field } from './Field.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as StatusMark } from './StatusMark.svelte';
export { default as ThemeToggle } from './ThemeToggle.svelte';
