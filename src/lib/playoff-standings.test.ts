import { test } from "node:test";
import type { MatchWithResult } from "@/lib/db";
import { computePlacementByParticipantId } from "@/lib/playoff-placement";
import { arePlayoffMatchesResolved, computePlayoffStandings } from "@/lib/playoff-standings";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function match(
	id: string,
	bracket: "WINNERS" | "LOSERS",
	round: number,
	home: string,
	away: string | null,
	next: string | null = null,
): MatchWithResult {
	return {
		id,
		tournament_id: "tournament",
		stage: "PLAYOFF",
		bracket_type: bracket,
		round,
		bracket_slot: 1,
		next_match_id: next,
		next_match_side: next ? "HOME" : null,
		home_participant_id: home,
		away_participant_id: away,
		home_participant_name: home,
		away_participant_name: away ?? "BYE",
		home_team_id: null,
		away_team_id: null,
		created_at: "2026-10-22T00:00:00Z",
		metadata: bracket === "LOSERS" ? { placement_graph_version: 2 } : null,
		result: away
			? {
					match_id: id,
					home_score: 3,
					away_score: 1,
					home_shots: 10,
					away_shots: 10,
					decision: "R",
					locked: true,
					home_team_id: null,
					away_team_id: null,
				}
			: null,
	};
}

export function runUnevenPlacementStandingsAssertions(): void {
	// Ten-player completed graph: six R1 BYEs, two played R1 games,
	// seven placement games and four visible placement BYEs. Every source has one path forward.
	const winners = [
		...Array.from({ length: 6 }, (_, index) => match(`bye-${index}`, "WINNERS", 1, `${index + 1}`, null, "qf")),
		match("r1-a", "WINNERS", 1, "8", "9", "qf"),
		match("r1-b", "WINNERS", 1, "7", "10", "qf"),
		match("qf-a", "WINNERS", 2, "1", "8", "sf-a"),
		match("qf-b", "WINNERS", 2, "4", "5", "sf-a"),
		match("qf-c", "WINNERS", 2, "2", "7", "sf-b"),
		match("qf-d", "WINNERS", 2, "3", "6", "sf-b"),
		match("sf-a", "WINNERS", 3, "1", "4", "gold"),
		match("sf-b", "WINNERS", 3, "2", "3", "gold"),
		match("gold", "WINNERS", 4, "1", "2"),
	];
	const placementBye = (id: string, round: number, participant: string, next: string) => {
		const bye = match(id, "LOSERS", round, participant, null, next);
		bye.metadata = { placement_graph_version: 2, placement_bye: true };
		return bye;
	};
	const placement = [
		placementBye("r16-bye-a", 1, "9", "intake-a"),
		placementBye("r16-bye-b", 1, "10", "intake-b"),
		match("intake-a", "LOSERS", 2, "9", "6", "consolidate-a"),
		match("intake-b", "LOSERS", 2, "10", "5", "consolidate-b"),
		placementBye("qf-bye-a", 2, "7", "consolidate-a"),
		placementBye("qf-bye-b", 2, "8", "consolidate-b"),
		match("consolidate-a", "LOSERS", 3, "9", "7", "intake-c"),
		match("consolidate-b", "LOSERS", 3, "10", "8", "intake-d"),
		match("intake-c", "LOSERS", 4, "9", "3", "bronze"),
		match("intake-d", "LOSERS", 4, "10", "4", "bronze"),
		match("bronze", "LOSERS", 5, "9", "10"),
	];
	const standings = computePlayoffStandings(winners, placement);
	assert(standings.get("1") === 1 && standings.get("2") === 2, "Gold final determines #1/#2");
	assert(standings.get("9") === 3 && standings.get("10") === 4, "Placement final determines #3/#4");
	for (const [players, minimum, maximum] of [
		[["3", "4"], 5, 6],
		[["7", "8"], 7, 8],
		[["5", "6"], 9, 10],
	] as const) {
		for (const player of players) {
			const rank = standings.get(player) ?? 0;
			assert(rank >= minimum && rank <= maximum, `Player ${player} must rank by placement elimination`);
		}
	}
	const ranks = [...standings.values()].sort((a, b) => a - b);
	assert(ranks.length === 10 && ranks.every((rank, index) => rank === index + 1), "BYEs must allow final #1..#10");
	const reversed = computePlayoffStandings([...winners].reverse(), [...placement].reverse());
	assert(
		[...standings].every(([id, rank]) => reversed.get(id) === rank),
		"Ranking must be independent of row order",
	);

	const unfinished = placement.map((item) => (item.id === "bronze" ? { ...item, result: null } : item));
	const partial = computePlayoffStandings(winners, unfinished);
	assert(partial.size === 2, "An unlocked placement final must not invent final ranks for active participants");
	const draftFinal = match("draft-gold", "WINNERS", 4, "1", "2");
	if (draftFinal.result) draftFinal.result.locked = false;
	assert(computePlayoffStandings([draftFinal], []).size === 0, "Draft scores must not award gold or silver");

	const pending = match("pending", "LOSERS", 1, "9", null);
	assert(!arePlayoffMatchesResolved([pending]), "A placement game waiting for its second source is unresolved");
	const emptyPending = { ...pending, home_participant_id: null };
	assert(!arePlayoffMatchesResolved([emptyPending]), "An empty placement game is unresolved");
	const emptyWinnersBye = { ...match("empty", "WINNERS", 1, "", null, "higher-bye"), home_participant_id: null };
	const higherBye = match("higher-bye", "WINNERS", 2, "1", null, "later-final");
	const firstBye = match("first-bye", "WINNERS", 1, "1", null, "higher-bye");
	assert(
		arePlayoffMatchesResolved([emptyWinnersBye, firstBye, higherBye]),
		"A genuinely empty feeder permits a later BYE",
	);
	const unresolvedFeeder = match("waiting-source", "WINNERS", 1, "2", "3", "higher-bye");
	unresolvedFeeder.result = null;
	assert(
		!arePlayoffMatchesResolved([firstBye, unresolvedFeeder, higherBye]),
		"A pending feeder must block a later BYE",
	);

	const waitingBye = placementBye("waiting-bye", 1, "9", "intake-a");
	waitingBye.home_participant_id = null;
	assert(!arePlayoffMatchesResolved([waitingBye]), "A placeholder BYE must wait for its actual loser source");
	const byeOnlyRanks = computePlacementByParticipantId(
		placement.filter((item) => item.metadata?.placement_bye),
		() => null,
	);
	assert(byeOnlyRanks.size === 0, "Advancing through a nonterminal placement BYE must not award a medal");

	const undrawnOpeningBye = placementBye("undrawn-opening", 1, "9", "intake-a");
	undrawnOpeningBye.next_match_id = null;
	undrawnOpeningBye.metadata = { placement_graph_version: 2, placement_bye: true, advances_to_round: 2 };
	assert(
		computePlacementByParticipantId([undrawnOpeningBye], () => null).size === 0,
		"An opening loser waiting for the ranked draw must not receive bronze",
	);
	const pendingDraw = match("pending-quarter-draw", "LOSERS", 2, "", null, "qualifier");
	pendingDraw.home_participant_id = null;
	pendingDraw.metadata = { placement_graph_version: 2, placement_seed_pending: true };
	assert(!arePlayoffMatchesResolved([pendingDraw]), "An incomplete ranked quarter-final pool must prevent completion");

	const threeWinners = [
		match("bye", "WINNERS", 1, "1", null, "gold"),
		match("semi", "WINNERS", 1, "2", "3", "gold"),
		match("gold", "WINNERS", 2, "1", "2"),
	];
	const bronzeBye = match("bronze-bye", "LOSERS", 1, "3", null);
	bronzeBye.metadata = { placement_graph_version: 2, placement_bye: true };
	const three = computePlayoffStandings(threeWinners, [bronzeBye]);
	assert(three.size === 3 && three.get("3") === 3, "Three entrants resolve bronze without a phantom opponent");
}

test("uneven placement standings and completion", runUnevenPlacementStandingsAssertions);
