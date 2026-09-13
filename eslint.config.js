import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import svelteConfig from './svelte.config.js';

export default ts.config(
	{
		// Generated or vendored — not hand-maintained code. Migrations in
		// particular are generated SQL that is never hand-edited once it has run.
		ignores: [
			'.svelte-kit/',
			'build/',
			'dist/',
			'node_modules/',
			'coverage/',
			'backups/',
			'src/lib/server/db/migrations/'
		]
	},

	ts.configs.eslintRecommended,
	ts.configs.recommended,
	svelte.configs.recommended,

	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig
			}
		}
	},

	// CLAUDE.md's house convention, enforced. SvelteKit already fails the build
	// when CLIENT code imports $lib/server/**, but it does not police lib/pos/,
	// which is ordinary TypeScript importable from either side.
	{
		files: ['src/lib/pos/**/*.{ts,svelte}', 'src/routes/(pos)/**/*.{ts,svelte}'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$lib/server/*', '$lib/server/**', '../server/*', '**/lib/server/**'],
							message:
								'lib/pos and the (pos) routes must work offline and must never import lib/server. ' +
								'SvelteKit build-blocks $lib/server from the browser, so this import cannot work ' +
								'offline. If you need shared logic (money arithmetic, for example), move the pure ' +
								'function into an isomorphic module both sides import — do NOT copy it. Spec 17 ' +
								'requires one rounding rule in one function used by POS, server and reports.'
						}
					]
				}
			]
		}
	},

	// eslint-config-prettier MUST stay last among the rule-setting configs, or it
	// cannot turn off the stylistic rules it exists to disable.
	prettier,
	svelte.configs.prettier
);
