import type { MatchWithResult, Team, TournamentParticipant } from "@/lib/db";

export const TIER_ORDER = ["Top 5", "Top 10", "Middle Tier", "Bottom Tier"] as const;
export type TierName = (typeof TIER_ORDER)[number];

export type PlannedFixture = {
	homeParticipantId: string;
	awayParticipantId: string;
};

export function generateRoundRobinPairings(participantIds: string[]): Array<{ a: string; b: string }> {
	const slots = [...participantIds];
	if (slots.length % 2 === 1) slots.push("__BYE__");
	const pairings: Array<{ a: string; b: string }> = [];
	const n = slots.length;
	const working = [...slots];
	for (let round = 0; round < n - 1; round += 1) {
		for (let i = 0; i < n / 2; i += 1) {
			const a = working[i];
			const b = working[n - 1 - i];
			if (a !== "__BYE__" && b !== "__BYE__") pairings.push({ a, b });
		}
		working.splice(1, 0, working.pop() as string);
	}
	return pairings;
}

export function assignBalancedHomeAway(pairings: Array<{ a: string; b: string }>): PlannedFixture[] {
	const homeCounts = new Map<string, number>();
	const awayCounts = new Map<string, number>();
	return pairings.map(({ a, b }) => {
		const aHome = homeCounts.get(a) ?? 0;
		const aAway = awayCounts.get(a) ?? 0;
		const bHome = homeCounts.get(b) ?? 0;
		const bAway = awayCounts.get(b) ?? 0;
		const scoreAB = Math.abs(aHome + 1 - aAway) + Math.abs(bHome - (bAway + 1));
		const scoreBA = Math.abs(bHome + 1 - bAway) + Math.abs(aHome - (aAway + 1));
		const pickAB = scoreAB <= scoreBA;
		const home = pickAB ? a : b;
		const away = pickAB ? b : a;
		homeCounts.set(home, (homeCounts.get(home) ?? 0) + 1);
		awayCounts.set(away, (awayCounts.get(away) ?? 0) + 1);
		return { homeParticipantId: home, awayParticipantId: away };
	});
}

export function buildTwoConsoleWaves(fixtures: PlannedFixture[]): PlannedFixture[][] {
	const remaining = [...fixtures];
	const waves: PlannedFixture[][] = [];
	while (remaining.length > 0) {
		const first = remaining.shift() as PlannedFixture;
		const secondIndex = remaining.findIndex(
			(item) =>
				item.homeParticipantId !== first.homeParticipantId &&
				item.homeParticipantId !== first.awayParticipantId &&
				item.awayParticipantId !== first.homeParticipantId &&
				item.awayParticipantId !== first.awayParticipantId,
		);
		if (secondIndex >= 0) {
			const second = remaining.splice(secondIndex, 1)[0];
			waves.push([first, second]);
		} else {
			waves.push([first]);
		}
	}
	return waves;
}

export function getActiveUpcomingMatches(matches: MatchWithResult[]): MatchWithResult[] {
	const unlocked = matches.filter((match) => !match.result?.locked);
	if (unlocked.length === 0) return [];
	const minRound = Math.min(...unlocked.map((match) => match.round));
	return unlocked.filter((match) => match.round === minRound).slice(0, 2);
}

export function resolveTierFromTeam(teamId: string | null, teams: Team[]): TierName {
	const tier = teams.find((team) => team.id === teamId)?.ovr_tier as TierName | undefined;
	return tier ?? "Middle Tier";
}

export function pickRerolledTeam(params: {
	teams: Team[];
	targetTier: TierName;
	previousTeamId: string | null;
	excludedTeamIds?: Set<string>;
}): string | null {
	const bucket = params.teams.filter((team) => team.ovr_tier === params.targetTier);
	if (bucket.length === 0) return null;
	const availableInTier =
		params.excludedTeamIds && params.excludedTeamIds.size > 0
			? bucket.filter((team) => !params.excludedTeamIds?.has(team.id))
			: bucket;
	const candidateBucket = availableInTier.length > 0 ? availableInTier : bucket;
	const candidates =
		candidateBucket.length > 1 && params.previousTeamId
			? candidateBucket.filter((team) => team.id !== params.previousTeamId)
			: candidateBucket;
	const picks = candidates.length > 0 ? candidates : candidateBucket;
	return picks[Math.floor(Math.random() * picks.length)]?.id ?? null;
}

export function computeRoundRobinStandings(matches: MatchWithResult[], participants: TournamentParticipant[]) {
	const board = new Map(
		participants.map((participant) => [
			participant.id,
			{ id: participant.id, name: participant.display_name, pts: 0, gf: 0, ga: 0, w: 0, l: 0, gp: 0 },
		]),
	);
	for (const match of matches) {
		if (!match.result?.locked || !match.home_participant_id || !match.away_participant_id) continue;
		const home = board.get(match.home_participant_id);
		const away = board.get(match.away_participant_id);
		if (!home || !away) continue;
		home.gp += 1;
		away.gp += 1;
		home.gf += match.result.home_score ?? 0;
		home.ga += match.result.away_score ?? 0;
		away.gf += match.result.away_score ?? 0;
		away.ga += match.result.home_score ?? 0;
		const homeScore = match.result.home_score ?? 0;
		const awayScore = match.result.away_score ?? 0;
		const decision = match.result.decision ?? "R";
		if (homeScore > awayScore) {
			home.w += 1;
			home.pts += decision === "R" ? 3 : 2;
			away.l += 1;
			if (decision !== "R") away.pts += 1;
		} else {
			away.w += 1;
			away.pts += decision === "R" ? 3 : 2;
			home.l += 1;
			if (decision !== "R") home.pts += 1;
		}
	}
	return [...board.values()].sort(
		(a, b) => b.pts - a.pts || b.gf - b.ga - (a.gf - a.ga) || b.gf - a.gf || a.name.localeCompare(b.name),
	);
}
