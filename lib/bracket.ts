export type WinnerMap = Record<string, string>;

export type MatchRef = {
	round: number;
	match: number;
	a: string;
	b: string;
};

function isPowerOfTwo(n: number) {
	return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function totalRounds(size: number) {
	if (!isPowerOfTwo(size)) throw new Error("Bracket size must be power of two");
	return Math.log2(size);
}

export function matchKey(round: number, match: number) {
	return `r${round}m${match}`;
}

export function matchCount(size: number, round: number) {
	return size / 2 ** (round + 1);
}

export function resolveMatchParticipants(
	size: number,
	tracks: string[],
	winners: WinnerMap,
	round: number,
	match: number,
): { a: string; b: string } | null {
	if (tracks.length !== size) return null;
	if (round < 0) return null;
	if (round === 0) {
		const a = tracks[match * 2];
		const b = tracks[match * 2 + 1];
		if (!a || !b) return null;
		return { a, b };
	}

	const prevRound = round - 1;
	const prevA = winners[matchKey(prevRound, match * 2)];
	const prevB = winners[matchKey(prevRound, match * 2 + 1)];
	if (!prevA || !prevB) return null;
	return { a: prevA, b: prevB };
}

export function nextOpenMatch(size: number, tracks: string[], winners: WinnerMap) {
	const rounds = totalRounds(size);
	for (let r = 0; r < rounds; r++) {
		const matches = matchCount(size, r);
		for (let m = 0; m < matches; m++) {
			const k = matchKey(r, m);
			if (winners[k]) continue;
			const participants = resolveMatchParticipants(size, tracks, winners, r, m);
			if (!participants) continue;
			return { round: r, match: m, ...participants } satisfies MatchRef;
		}
	}
	return null;
}

export function bracketWinner(size: number, winners: WinnerMap) {
	const rounds = totalRounds(size);
	const k = matchKey(rounds - 1, 0);
	const winner = winners[k];
	if (!winner) return null;
	return winner;
}

export function computeRanking(size: number, tracks: string[], winners: WinnerMap) {
	const rounds = totalRounds(size);
	const finalWinner = bracketWinner(size, winners);
	if (!finalWinner) return null;

	const loserByRound: string[][] = Array.from({ length: rounds }, () => []);
	let runnerUp: string | null = null;

	for (let r = 0; r < rounds; r++) {
		const matches = matchCount(size, r);
		for (let m = 0; m < matches; m++) {
			const participants = resolveMatchParticipants(size, tracks, winners, r, m);
			if (!participants) return null;

			const win = winners[matchKey(r, m)];
			if (!win) return null;

			const lose = win === participants.a ? participants.b : participants.a;
			if (r === rounds - 1) runnerUp = lose;
			else loserByRound[r].push(lose);
		}
	}

	if (!runnerUp) return null;

	const ranking: string[] = [finalWinner, runnerUp];
	for (let r = rounds - 2; r >= 0; r--) {
		ranking.push(...loserByRound[r]!);
	}
	return ranking;
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seededShuffle<T>(arr: T[], seed: number) {
	const out = arr.slice();
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}
