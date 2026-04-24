import { computePlacementByParticipantId } from "@/lib/db";

type FixtureMatch = {
	id: string;
	round: number;
	bracket_type: "WINNERS" | "LOSERS" | null;
	next_match_id: string | null;
	bracket_slot: number | null;
	home_participant_id: string | null;
	away_participant_id: string | null;
	metadata?: Record<string, unknown> | null;
};

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function runFixture(
	matches: FixtureMatch[],
	results: Record<string, { home_score: number; away_score: number }>,
): Map<string, number> {
	return computePlacementByParticipantId(matches, (matchId, homeId, awayId) => {
		const result = results[matchId];
		if (!result || !homeId || !awayId || result.home_score === result.away_score) return null;
		return result.home_score > result.away_score
			? { winner: homeId, loser: awayId }
			: { winner: awayId, loser: homeId };
	});
}

export function runPlacementFixtureAssertions(): void {
	const normalMatches: FixtureMatch[] = [
		{
			id: "gold",
			round: 3,
			bracket_type: "WINNERS",
			next_match_id: null,
			bracket_slot: 1,
			home_participant_id: "A",
			away_participant_id: "B",
		},
		{
			id: "bronze",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 1,
			home_participant_id: "C",
			away_participant_id: "D",
		},
		{
			id: "fifth",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "E",
			away_participant_id: "F",
		},
	];
	const normalPlacements = runFixture(normalMatches, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		fifth: { home_score: 5, away_score: 2 },
	});
	assert(normalPlacements.get("A") === 1 && normalPlacements.get("B") === 2, "normal path should set #1/#2");
	assert(normalPlacements.get("C") === 3 && normalPlacements.get("D") === 4, "normal path should set #3/#4");
	assert(normalPlacements.get("E") === 5 && normalPlacements.get("F") === 6, "normal path should set #5/#6");

	const extraPlacementMatches: FixtureMatch[] = [
		...normalMatches,
		{
			id: "extra-78",
			round: 4,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 3,
			home_participant_id: "E",
			away_participant_id: "F",
			metadata: { is_additional_placement: true, classification: "extra_7th_place_game" },
		},
	];
	const extraPlacements = runFixture(extraPlacementMatches, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		fifth: { home_score: 5, away_score: 2 },
		"extra-78": { home_score: 1, away_score: 2 },
	});
	assert(extraPlacements.get("E") === 8 && extraPlacements.get("F") === 7, "extra path should force #7/#8");
	assert(extraPlacements.get("E") !== 5 && extraPlacements.get("F") !== 6, "extra path cannot leak into #5/#6");
}
