import { computePlacementByParticipantId, type MatchWithResult } from "@/lib/db";
import { applyUnresolvedStandingsFallback } from "@/pages/tournaments/detail.playoff-standings";

type FixtureMatch = MatchWithResult;

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

const buildLockedMatch = (
	id: string,
	bracketType: "WINNERS" | "LOSERS",
	round: number,
	home: string,
	away: string,
	homeScore: number,
	awayScore: number,
	bracketSlot: number,
	metadata?: Record<string, unknown>,
): FixtureMatch => ({
	id,
	tournament_id: "t-1",
	stage: "PLAYOFF",
	bracket_type: bracketType,
	round,
	bracket_slot: bracketSlot,
	next_match_id: null,
	next_match_side: null,
	home_participant_id: home,
	away_participant_id: away,
	home_participant_name: home,
	away_participant_name: away,
	home_team_id: null,
	away_team_id: null,
	created_at: "2026-04-27T00:00:00.000Z",
	metadata: metadata ?? null,
	result: {
		match_id: id,
		home_score: homeScore,
		away_score: awayScore,
		home_shots: null,
		away_shots: null,
		decision: "R",
		locked: true,
		home_team_id: null,
		away_team_id: null,
	},
});

const resolveFromResults = (matches: FixtureMatch[]): Map<string, number> => {
	const winners = matches.filter((match) => match.bracket_type === "WINNERS");
	const losers = matches.filter((match) => match.bracket_type === "LOSERS");
	const standings = new Map<string, number>();

	const winnersFinal = [...winners].sort((a, b) => b.round - a.round)[0];
	const winnersFinalResult = winnersFinal?.result;
	if (winnersFinal && winnersFinalResult) {
		if ((winnersFinalResult.home_score ?? 0) > (winnersFinalResult.away_score ?? 0)) {
			standings.set(winnersFinal.home_participant_id as string, 1);
			standings.set(winnersFinal.away_participant_id as string, 2);
		} else if ((winnersFinalResult.away_score ?? 0) > (winnersFinalResult.home_score ?? 0)) {
			standings.set(winnersFinal.away_participant_id as string, 1);
			standings.set(winnersFinal.home_participant_id as string, 2);
		}
	}

	const placementByParticipantId = computePlacementByParticipantId(matches, (matchId, homeId, awayId) => {
		const match = matches.find((item) => item.id === matchId);
		if (!match?.result?.locked || !homeId || !awayId) return null;
		const homeScore = match.result.home_score ?? 0;
		const awayScore = match.result.away_score ?? 0;
		if (homeScore === awayScore) return null;
		return homeScore > awayScore ? { winner: homeId, loser: awayId } : { winner: awayId, loser: homeId };
	});
	for (const [participantId, placement] of placementByParticipantId.entries()) {
		if (!standings.has(participantId)) standings.set(participantId, placement);
	}

	applyUnresolvedStandingsFallback(standings, [...winners, ...losers]);
	return standings;
};

export function runDetailPlayoffStandingsAssertions(): void {
	const fixture: FixtureMatch[] = [
		buildLockedMatch("gold", "WINNERS", 3, "A", "B", 4, 2, 1),
		buildLockedMatch("bronze", "LOSERS", 3, "C", "D", 3, 1, 1),
		buildLockedMatch("extra-78", "LOSERS", 3, "G", "H", 2, 1, 2, {
			is_additional_placement: true,
			classification: "extra_7th_place_game",
		}),
		buildLockedMatch("fifth-sixth", "LOSERS", 3, "E", "F", 2, 2, 3, {
			placement_classification: "fifth_sixth_place_game",
		}),
	];

	const standings = resolveFromResults(fixture);
	const resolvedRanks = [...standings.entries()]
		.filter(([participantId]) => ["A", "B", "C", "D", "E", "F", "G", "H"].includes(participantId))
		.map(([, rank]) => rank)
		.sort((left, right) => left - right);
	assert(
		resolvedRanks.length === 8 && resolvedRanks.every((rank, index) => rank === index + 1),
		"8-player full-with-losers final state should resolve uniquely to #1..#8",
	);
	assert(standings.get("E") === 5 && standings.get("F") === 6, "5/6 game participants should resolve to #5/#6");
	assert(
		(standings.get("G") === 7 && standings.get("H") === 8) || (standings.get("G") === 8 && standings.get("H") === 7),
		"extra 7/8 game participants should resolve to #7/#8 without duplicates",
	);

	const nonContiguousPrefilled = new Map<string, number>([
		["A", 1],
		["B", 2],
		["C", 3],
		["D", 4],
		["G", 7],
		["H", 8],
	]);
	applyUnresolvedStandingsFallback(nonContiguousPrefilled, fixture);
	assert(
		nonContiguousPrefilled.get("E") === 5 && nonContiguousPrefilled.get("F") === 6,
		"fallback should fill non-contiguous rank gaps before assigning new placements",
	);
}
