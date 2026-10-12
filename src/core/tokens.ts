/**
 * Conservative token estimation.
 *
 * `pi`'s estimateTokens uses chars/4, which underestimates Japanese (about 1
 * to 1.5 tokens per character) and digit/hex runs (1 to 2 characters per
 * token). This estimator is deliberately conservative: estimates must be
 * greater than or equal to the measured provider usage.
 */

export function estimateTokens(text: string): number {
	let letters = 0;
	let other = 0;
	let nonAscii = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 128) nonAscii++;
		else if (/[A-Za-z]/.test(char)) letters++;
		else other++;
	}
	return Math.ceil(letters / 3 + other / 2 + nonAscii * 1.5);
}
