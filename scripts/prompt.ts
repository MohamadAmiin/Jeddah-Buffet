import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Prompting that works both interactively and from a pipe.
 *
 * On a TTY it uses readline and masks secrets. When stdin is PIPED — a script, a
 * smoke test, CI — it consumes stdin ONCE and answers from it in order: readline's
 * question() hangs on the second call against a piped stream, and masking has
 * nothing to hide from anyway.
 */
export type Prompter = {
	ask(question: string): Promise<string>;
	askSecret(question: string): Promise<string>;
	close(): void;
};

export function makePrompter(): Prompter {
	if (!stdin.isTTY) {
		const lines = (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of stdin) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString('utf8').split('\n');
		})();
		let i = 0;
		const next = async (question: string, echo: boolean) => {
			const all = await lines;
			const value = all[i++] ?? '';
			stdout.write(question + (echo ? value : '') + '\n');
			return value;
		};
		return {
			ask: (q) => next(q, true),
			askSecret: (q) => next(q, false),
			close: () => {}
		};
	}

	const rl = createInterface({ input: stdin, output: stdout });
	return {
		ask: (q) => rl.question(q),
		async askSecret(question) {
			const output = rl.output as NodeJS.WriteStream;
			const original = output.write.bind(output);
			let muted = false;
			output.write = ((chunk: string, ...rest: unknown[]) =>
				muted ? true : original(chunk, ...(rest as []))) as typeof output.write;
			const promise = rl.question(question);
			muted = true;
			const answer = await promise;
			muted = false;
			output.write = original;
			stdout.write('\n');
			return answer;
		},
		close: () => rl.close()
	};
}
