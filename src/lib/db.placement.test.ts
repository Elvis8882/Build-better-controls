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

	const extraPlacementRoundMatches: FixtureMatch[] = [
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
			id: "extra-78-with-meta",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "E",
			away_participant_id: "F",
			metadata: { is_additional_placement: true, classification: "extra_7th_place_game" },
		},
	];
	const extraPlacementRoundWithMetadataPlacements = runFixture(extraPlacementRoundMatches, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		"extra-78-with-meta": { home_score: 1, away_score: 2 },
	});
	assert(
		extraPlacementRoundWithMetadataPlacements.get("E") === 8 &&
			extraPlacementRoundWithMetadataPlacements.get("F") === 7,
		"same-round extra path with metadata should force #7/#8",
	);
	assert(
		extraPlacementRoundWithMetadataPlacements.get("E") !== 5 &&
			extraPlacementRoundWithMetadataPlacements.get("F") !== 6,
		"same-round extra path with metadata cannot leak into #5/#6",
	);

	const extraPlacementRoundWithoutMetadataMatches: FixtureMatch[] = [
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
			id: "extra-78-no-meta",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "E",
			away_participant_id: "F",
		},
	];
	const extraPlacementRoundWithoutMetadataPlacements = runFixture(extraPlacementRoundWithoutMetadataMatches, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		"extra-78-no-meta": { home_score: 2, away_score: 1 },
	});
	assert(
		extraPlacementRoundWithoutMetadataPlacements.get("E") === 7 &&
			extraPlacementRoundWithoutMetadataPlacements.get("F") === 8,
		"same-round extra path without metadata should still force #7/#8",
	);
	assert(
		extraPlacementRoundWithoutMetadataPlacements.get("E") !== 5 &&
			extraPlacementRoundWithoutMetadataPlacements.get("F") !== 6,
		"same-round extra path without metadata cannot leak into #5/#6",
	);

	const extraPlacementMatchesLegacyCompat: FixtureMatch[] = [
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
	const extraPlacementsLegacyCompat = runFixture(extraPlacementMatchesLegacyCompat, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		fifth: { home_score: 5, away_score: 2 },
		"extra-78": { home_score: 1, away_score: 2 },
	});
	assert(
		extraPlacementsLegacyCompat.get("E") === 8 && extraPlacementsLegacyCompat.get("F") === 7,
		"legacy extra path should force #7/#8",
	);
	assert(
		extraPlacementsLegacyCompat.get("E") !== 5 && extraPlacementsLegacyCompat.get("F") !== 6,
		"legacy extra path cannot leak into #5/#6",
	);

	const slotTwoConflictMatches: FixtureMatch[] = [
		{
			id: "gold",
			round: 4,
			bracket_type: "WINNERS",
			next_match_id: null,
			bracket_slot: 1,
			home_participant_id: "A",
			away_participant_id: "B",
		},
		{
			id: "bronze",
			round: 4,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 1,
			home_participant_id: "C",
			away_participant_id: "D",
		},
		{
			id: "slot2-extra",
			round: 4,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "E",
			away_participant_id: "F",
		},
		{
			id: "slot2-fifth",
			round: 4,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "G",
			away_participant_id: "H",
		},
		{
			id: "l1-a",
			round: 1,
			bracket_type: "LOSERS",
			next_match_id: "slot2-extra",
			bracket_slot: 1,
			home_participant_id: "L1",
			away_participant_id: "L2",
		},
		{
			id: "l1-b",
			round: 1,
			bracket_type: "LOSERS",
			next_match_id: "slot2-extra",
			bracket_slot: 2,
			home_participant_id: "L3",
			away_participant_id: "L4",
		},
		{
			id: "l2-a",
			round: 2,
			bracket_type: "LOSERS",
			next_match_id: "slot2-fifth",
			bracket_slot: 1,
			home_participant_id: "L5",
			away_participant_id: "L6",
		},
		{
			id: "l2-b",
			round: 2,
			bracket_type: "LOSERS",
			next_match_id: "slot2-fifth",
			bracket_slot: 2,
			home_participant_id: "L7",
			away_participant_id: "L8",
		},
	];
	const slotTwoConflictResults = {
		gold: { home_score: 4, away_score: 1 },
		bronze: { home_score: 3, away_score: 0 },
		"slot2-extra": { home_score: 2, away_score: 1 },
		"slot2-fifth": { home_score: 1, away_score: 3 },
		"l1-a": { home_score: 1, away_score: 0 },
		"l1-b": { home_score: 1, away_score: 0 },
		"l2-a": { home_score: 1, away_score: 0 },
		"l2-b": { home_score: 1, away_score: 0 },
	};
	const slotTwoConflictPlacements = runFixture(slotTwoConflictMatches, slotTwoConflictResults);
	assert(
		slotTwoConflictPlacements.get("E") === 7 && slotTwoConflictPlacements.get("F") === 8,
		"loser-path origin should infer slot-2 extra game as #7/#8",
	);
	assert(
		slotTwoConflictPlacements.get("H") === 5 && slotTwoConflictPlacements.get("G") === 6,
		"remaining slot-2 game should keep #5/#6 semantics",
	);

	const reversedSlotTwoConflictPlacements = runFixture([...slotTwoConflictMatches].reverse(), slotTwoConflictResults);
	assert(
		reversedSlotTwoConflictPlacements.get("E") === 7 && reversedSlotTwoConflictPlacements.get("F") === 8,
		"slot-2 conflict inference should be deterministic regardless of array order",
	);
	assert(
		reversedSlotTwoConflictPlacements.get("H") === 5 && reversedSlotTwoConflictPlacements.get("G") === 6,
		"slot-2 fifth-game assignment should be deterministic regardless of array order",
	);

	const eightParticipantFinalDisplayRoundMatches: FixtureMatch[] = [
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
			id: "extra-78-display",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 2,
			home_participant_id: "G",
			away_participant_id: "H",
			metadata: {
				is_additional_placement: true,
				placement_classification: "extra_7th_place_game",
				classification: "extra_7th_place_game",
			},
		},
		{
			id: "fifth-sixth-display",
			round: 3,
			bracket_type: "LOSERS",
			next_match_id: null,
			bracket_slot: 3,
			home_participant_id: "E",
			away_participant_id: "F",
			metadata: {
				placement_classification: "fifth_sixth_place_game",
			},
		},
	];
	const eightParticipantFinalDisplayRoundPlacements = runFixture(eightParticipantFinalDisplayRoundMatches, {
		gold: { home_score: 4, away_score: 2 },
		bronze: { home_score: 3, away_score: 1 },
		"extra-78-display": { home_score: 2, away_score: 1 },
		"fifth-sixth-display": { home_score: 5, away_score: 3 },
	});
	assert(
		eightParticipantFinalDisplayRoundPlacements.get("A") === 1 &&
			eightParticipantFinalDisplayRoundPlacements.get("B") === 2 &&
			eightParticipantFinalDisplayRoundPlacements.get("C") === 3 &&
			eightParticipantFinalDisplayRoundPlacements.get("D") === 4 &&
			eightParticipantFinalDisplayRoundPlacements.get("E") === 5 &&
			eightParticipantFinalDisplayRoundPlacements.get("F") === 6 &&
			eightParticipantFinalDisplayRoundPlacements.get("G") === 7 &&
			eightParticipantFinalDisplayRoundPlacements.get("H") === 8,
		"8-player final display round should resolve uniquely to #1..#8 when 5/6 and extra 7/8 both exist",
	);
	const eightParticipantRanks = [...eightParticipantFinalDisplayRoundPlacements.values()].sort((a, b) => a - b);
	assert(
		eightParticipantRanks.length === 8 && eightParticipantRanks.every((rank, index) => rank === index + 1),
		"8-player final display round should not produce duplicate placement values",
	);
}
