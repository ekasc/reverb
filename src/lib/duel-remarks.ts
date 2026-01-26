function hashString(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export type DuelRemarkContext = {
	tournamentId: string;
	round: number;
	match: number;
	winnerId: string;
	seedWinner: number;
	seedLoser: number;
	upset: boolean;
	seedGap: number;
};

type RemarkFn = (ctx: DuelRemarkContext) => string;

const RemarkPools: Record<"upset" | "safe" | "close" | "finals", RemarkFn[]> = {
	upset: [
		(c) => `Seed #${c.seedLoser} just got cooked by #${c.seedWinner}.`,
		() => `You benched the favorite. Cold-blooded.`,
		() => `Rankings are a suggestion and you took that personally.`,
		() => `That was an upset. Your taste is a hazard.`,
		() => `The bracket is screaming and you are smiling.`,
		() => `You saw the underdog and said: say less.`,
	],
	safe: [
		() => `Safe pick. Respectable. Slightly boring.`,
		() => `Chalk enjoyer detected.`,
		() => `You chose the obvious one. I can't argue.`,
		() => `No chaos today. Just vibes.`,
		() => `Textbook selection. The committee approves.`,
		() => `You picked with your head, not your heart.`,
	],
	close: [
		() => `That felt like a coin flip with better eyeliner.`,
		() => `Two contenders. You picked a lane.`,
		() => `This matchup had no bad answers. You still chose violence.`,
		() => `You hesitated. I felt it through the screen.`,
		() => `Tough call. Great taste. Mildly unhinged.`,
	],
	finals: [
		() => `Finals energy. Choose like you mean it.`,
		() => `This is where your reputation gets audited.`,
		() => `Historic decision. No pressure.`,
		() => `The jukebox is judging you back.`,
		() => `You are curating a personality right now.`,
	],
};

export function pickDuelRemark(ctx: DuelRemarkContext) {
	const key = `${ctx.tournamentId}|r${ctx.round}m${ctx.match}|${ctx.winnerId}`;
	const h = hashString(key);

	const isFinalish = ctx.round >= 3; // cheap heuristic; feels right for 16+ brackets
	if (isFinalish) {
		const pool = RemarkPools.finals;
		return pool[h % pool.length](ctx);
	}

	if (ctx.upset && ctx.seedGap >= 6) {
		const pool = RemarkPools.upset;
		return pool[h % pool.length](ctx);
	}

	if (ctx.seedGap <= 2) {
		const pool = RemarkPools.close;
		return pool[h % pool.length](ctx);
	}

	const pool = RemarkPools.safe;
	return pool[h % pool.length](ctx);
}
