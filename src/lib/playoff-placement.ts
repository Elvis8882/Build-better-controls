type PlayoffPlacementMatch = {
	id: string;
	round: number;
	bracket_type: "WINNERS" | "LOSERS" | null;
	next_match_id: string | null;
	bracket_slot: number | null;
	home_participant_id: string | null;
	away_participant_id: string | null;
	metadata?: Record<string, unknown> | null;
};

const PLACEMENT_CLASSIFICATION_KEY = "placement_classification";
const LEGACY_PLACEMENT_CLASSIFICATION_KEY = "classification";
const FIFTH_SIXTH_CLASSIFICATIONS = new Set(["placement_5_6", "fifth_sixth_place_game", "fifth_place_game"]);
const EXTRA_SEVENTH_EIGHTH_CLASSIFICATIONS = new Set(["extra_7th_place_game"]);

function resolvePlacementMetadata(match: PlayoffPlacementMatch): Record<string, unknown> | null {
	return (match.metadata ?? null) as Record<string, unknown> | null;
}

function resolvePlacementClassification(match: PlayoffPlacementMatch): string | null {
	const metadata = resolvePlacementMetadata(match);
	const classification =
		metadata?.[PLACEMENT_CLASSIFICATION_KEY] ?? metadata?.[LEGACY_PLACEMENT_CLASSIFICATION_KEY] ?? null;
	return typeof classification === "string" ? classification : null;
}

function isAdditionalPlacementMatch(match: PlayoffPlacementMatch): boolean {
	return Boolean(resolvePlacementMetadata(match)?.is_additional_placement);
}

function isGrandFinalPlacementMatch(match: PlayoffPlacementMatch): boolean {
	const metadata = resolvePlacementMetadata(match);
	return Boolean(metadata?.is_gf1) || Boolean(metadata?.is_gf2);
}

export function computePlacementByParticipantId(
	playoffMatches: PlayoffPlacementMatch[],
	resolveWinnerLoser: (
		matchId: string,
		homeId: string | null,
		awayId: string | null,
	) => {
		winner: string;
		loser: string;
	} | null,
): Map<string, number> {
	const placementByParticipantId = new Map<string, number>();
	const comparePlacementMatchDesc = (a: PlayoffPlacementMatch, b: PlayoffPlacementMatch): number =>
		b.round - a.round || (b.bracket_slot ?? 0) - (a.bracket_slot ?? 0) || a.id.localeCompare(b.id);
	const selectTopPlacementMatch = (matches: PlayoffPlacementMatch[]): PlayoffPlacementMatch | null =>
		matches.length === 0 ? null : [...matches].sort(comparePlacementMatchDesc)[0];
	const resolvedOutcomeByMatchId = new Map<string, { winner: string; loser: string }>();
	const resolveOutcome = (match: PlayoffPlacementMatch) => {
		const cached = resolvedOutcomeByMatchId.get(match.id);
		if (cached) return cached;
		const resolved = resolveWinnerLoser(match.id, match.home_participant_id, match.away_participant_id);
		if (resolved) resolvedOutcomeByMatchId.set(match.id, resolved);
		return resolved;
	};
	const assignRankBand = (outcome: { winner: string; loser: string } | null, winnerRank: number, loserRank: number) => {
		if (!outcome) return new Set<string>();
		if (!placementByParticipantId.has(outcome.winner)) placementByParticipantId.set(outcome.winner, winnerRank);
		if (!placementByParticipantId.has(outcome.loser)) placementByParticipantId.set(outcome.loser, loserRank);
		return new Set([outcome.winner, outcome.loser]);
	};

	const finals = playoffMatches.filter((match) => !match.next_match_id && match.bracket_type !== "LOSERS");
	const finalRound = finals.length > 0 ? Math.max(...finals.map((item) => item.round)) : null;
	const goldFinal =
		finalRound === null ? null : (finals.find((item) => item.round === finalRound && resolveOutcome(item)) ?? null);

	assignRankBand(goldFinal ? (resolveOutcome(goldFinal) ?? null) : null, 1, 2);

	const placementMatches = playoffMatches.filter((match) => match.bracket_type === "LOSERS");
	// Versioned graphs have explicit terminal roles. Intermediate round numbers
	// describe scheduling, not a final placement, and must never imply #5/#6.
	if (placementMatches.some((match) => match.metadata?.placement_graph_version === 2)) {
		for (const match of placementMatches) {
			if (match.next_match_id) continue;
			const classification = resolvePlacementClassification(match);
			if (classification === "extra_7th_place_game") assignRankBand(resolveOutcome(match), 7, 8);
			else if (FIFTH_SIXTH_CLASSIFICATIONS.has(classification ?? "")) assignRankBand(resolveOutcome(match), 5, 6);
			else if (match.metadata?.placement_bye) {
				const participant = match.home_participant_id ?? match.away_participant_id;
				if (participant) placementByParticipantId.set(participant, 3);
			} else assignRankBand(resolveOutcome(match), 3, 4);
		}
		return placementByParticipantId;
	}
	if (placementMatches.length === 0) return placementByParticipantId;
	const nonGrandFinalPlacementMatches = placementMatches.filter((item) => !isGrandFinalPlacementMatch(item));
	const feederMatchesByNextMatchId = new Map<string, PlayoffPlacementMatch[]>();
	for (const match of nonGrandFinalPlacementMatches) {
		if (!match.next_match_id) continue;
		const feederMatches = feederMatchesByNextMatchId.get(match.next_match_id) ?? [];
		feederMatches.push(match);
		feederMatchesByNextMatchId.set(match.next_match_id, feederMatches);
	}
	const earliestLosersRound =
		nonGrandFinalPlacementMatches.length > 0
			? Math.min(...nonGrandFinalPlacementMatches.map((match) => match.round))
			: null;
	const hasEarliestLosersPathOrigin = (match: PlayoffPlacementMatch): boolean => {
		if (earliestLosersRound === null) return false;
		const feeders = feederMatchesByNextMatchId.get(match.id) ?? [];
		return feeders.some((feederMatch) => feederMatch.round === earliestLosersRound);
	};
	const compareLosersPathPriority = (a: PlayoffPlacementMatch, b: PlayoffPlacementMatch): number =>
		Number(hasEarliestLosersPathOrigin(b)) - Number(hasEarliestLosersPathOrigin(a)) || comparePlacementMatchDesc(a, b);

	const markedExtraMatch =
		placementMatches.find(
			(item) =>
				isAdditionalPlacementMatch(item) ||
				EXTRA_SEVENTH_EIGHTH_CLASSIFICATIONS.has(resolvePlacementClassification(item) ?? ""),
		) ?? null;
	const participantPairKey = (match: PlayoffPlacementMatch): string | null => {
		if (!match.home_participant_id || !match.away_participant_id) return null;
		const [left, right] = [match.home_participant_id, match.away_participant_id].sort();
		return `${left}:${right}`;
	};
	const duplicatePairExtraMatch = (() => {
		const grouped = new Map<string, PlayoffPlacementMatch[]>();
		for (const item of placementMatches) {
			if (isGrandFinalPlacementMatch(item) || !resolveOutcome(item)) continue;
			const key = participantPairKey(item);
			if (!key) continue;
			const items = grouped.get(key) ?? [];
			items.push(item);
			grouped.set(key, items);
		}
		let candidate: PlayoffPlacementMatch | null = null;
		for (const items of grouped.values()) {
			if (items.length < 2) continue;
			const latest = [...items].sort(comparePlacementMatchDesc)[0];
			if (!candidate) {
				candidate = latest;
				continue;
			}
			if (comparePlacementMatchDesc(candidate, latest) > 0) candidate = latest;
		}
		return candidate;
	})();
	const terminalPlacementMatches = nonGrandFinalPlacementMatches.filter((item) => !item.next_match_id);
	const terminalPlacementFinalRound =
		terminalPlacementMatches.length > 0 ? Math.max(...terminalPlacementMatches.map((item) => item.round)) : null;
	const slotTwoTerminalMatches =
		terminalPlacementFinalRound === null
			? []
			: terminalPlacementMatches.filter(
					(item) => item.round === terminalPlacementFinalRound && (item.bracket_slot ?? 0) === 2,
				);
	const slotTwoConflictExtraMatch =
		slotTwoTerminalMatches.length >= 2 ? [...slotTwoTerminalMatches].sort(compareLosersPathPriority)[0] : null;
	const loserPathOriginExtraMatch =
		slotTwoTerminalMatches.length === 1 && hasEarliestLosersPathOrigin(slotTwoTerminalMatches[0])
			? slotTwoTerminalMatches[0]
			: null;
	const inferredExtraMatch =
		markedExtraMatch ?? slotTwoConflictExtraMatch ?? loserPathOriginExtraMatch ?? duplicatePairExtraMatch;

	const classificationMatches = placementMatches.filter(
		(item) => !isGrandFinalPlacementMatch(item) && item.id !== inferredExtraMatch?.id,
	);
	const placementFinalRound =
		classificationMatches.length > 0 ? Math.max(...classificationMatches.map((item) => item.round)) : null;
	const terminalClassificationMatches = classificationMatches.filter((item) => !item.next_match_id);
	const compareFifthGamePriority = (a: PlayoffPlacementMatch, b: PlayoffPlacementMatch): number => {
		const byRound = b.round - a.round;
		if (byRound !== 0) return byRound;
		const aSlot = a.bracket_slot ?? Number.POSITIVE_INFINITY;
		const bSlot = b.bracket_slot ?? Number.POSITIVE_INFINITY;
		if (aSlot !== bSlot) return aSlot - bSlot;
		return a.id.localeCompare(b.id);
	};
	const fifthGameFromMetadata =
		[...terminalClassificationMatches]
			.filter((item) => FIFTH_SIXTH_CLASSIFICATIONS.has(resolvePlacementClassification(item) ?? ""))
			.sort(compareFifthGamePriority)[0] ?? null;
	const highestPriorityStructuralFifthGame =
		[...terminalClassificationMatches]
			.sort(compareFifthGamePriority)
			.find((item) => (item.bracket_slot ?? Number.POSITIVE_INFINITY) > 1) ?? null;
	const canonicalRoles = {
		gold_final: goldFinal,
		bronze_game:
			placementFinalRound === null
				? null
				: (selectTopPlacementMatch(
						classificationMatches.filter(
							(item) => item.round === placementFinalRound && (item.bracket_slot ?? 0) === 1,
						),
					) ?? null),
		fifth_game: fifthGameFromMetadata ?? (placementFinalRound === null ? null : highestPriorityStructuralFifthGame),
		extra_7th_8th_game: inferredExtraMatch,
	};

	assignRankBand(
		canonicalRoles.bronze_game
			? resolveWinnerLoser(
					canonicalRoles.bronze_game.id,
					canonicalRoles.bronze_game.home_participant_id,
					canonicalRoles.bronze_game.away_participant_id,
				)
			: null,
		3,
		4,
	);

	const extraSeventhOutcome = canonicalRoles.extra_7th_8th_game
		? resolveWinnerLoser(
				canonicalRoles.extra_7th_8th_game.id,
				canonicalRoles.extra_7th_8th_game.home_participant_id,
				canonicalRoles.extra_7th_8th_game.away_participant_id,
			)
		: null;
	const lockedSeventhEighthParticipants = assignRankBand(extraSeventhOutcome, 7, 8);

	const fifthOutcome =
		canonicalRoles.fifth_game && canonicalRoles.fifth_game.id !== canonicalRoles.extra_7th_8th_game?.id
			? resolveWinnerLoser(
					canonicalRoles.fifth_game.id,
					canonicalRoles.fifth_game.home_participant_id,
					canonicalRoles.fifth_game.away_participant_id,
				)
			: null;
	if (fifthOutcome) {
		if (
			!lockedSeventhEighthParticipants.has(fifthOutcome.winner) &&
			!placementByParticipantId.has(fifthOutcome.winner)
		) {
			placementByParticipantId.set(fifthOutcome.winner, 5);
		}
		if (!lockedSeventhEighthParticipants.has(fifthOutcome.loser) && !placementByParticipantId.has(fifthOutcome.loser)) {
			placementByParticipantId.set(fifthOutcome.loser, 6);
		}
	}

	return placementByParticipantId;
}
