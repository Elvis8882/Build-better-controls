import { computePlacementByParticipantId, type MatchWithResult } from "@/lib/db";
import { assignUnresolvedStandings } from "@/pages/tournaments/detail.rank-assignment";

const resolveWinner = (match: MatchWithResult): string | null => {
	if (!match.result?.locked || !match.home_participant_id || !match.away_participant_id) return null;
	if ((match.result.home_score ?? 0) > (match.result.away_score ?? 0)) return match.home_participant_id;
	if ((match.result.away_score ?? 0) > (match.result.home_score ?? 0)) return match.away_participant_id;
	return null;
};

const resolveLoser = (match: MatchWithResult): string | null => {
	if (!match.result?.locked || !match.home_participant_id || !match.away_participant_id) return null;
	if ((match.result.home_score ?? 0) > (match.result.away_score ?? 0)) return match.away_participant_id;
	if ((match.result.away_score ?? 0) > (match.result.home_score ?? 0)) return match.home_participant_id;
	return null;
};

export const applyUnresolvedStandingsFallback = (
	standingByParticipantId: Map<string, number>,
	matches: MatchWithResult[],
): void => {
	const unresolvedIds = new Set<string>();
	const eliminationByParticipantId = new Map<string, { bracketType: "WINNERS" | "LOSERS"; round: number }>();
	const playoffStatsByParticipantId = new Map<string, { goalsFor: number; goalsAgainst: number; goalDiff: number }>();
	for (const match of matches) {
		if (match.result?.locked && match.home_participant_id && match.away_participant_id) {
			const home = playoffStatsByParticipantId.get(match.home_participant_id) ?? {
				goalsFor: 0,
				goalsAgainst: 0,
				goalDiff: 0,
			};
			const away = playoffStatsByParticipantId.get(match.away_participant_id) ?? {
				goalsFor: 0,
				goalsAgainst: 0,
				goalDiff: 0,
			};
			home.goalsFor += match.result.home_score ?? 0;
			home.goalsAgainst += match.result.away_score ?? 0;
			home.goalDiff = home.goalsFor - home.goalsAgainst;
			away.goalsFor += match.result.away_score ?? 0;
			away.goalsAgainst += match.result.home_score ?? 0;
			away.goalDiff = away.goalsFor - away.goalsAgainst;
			playoffStatsByParticipantId.set(match.home_participant_id, home);
			playoffStatsByParticipantId.set(match.away_participant_id, away);
		}

		const loser = resolveLoser(match);
		if (loser) {
			const previous = eliminationByParticipantId.get(loser);
			if (!previous || match.round > previous.round) {
				eliminationByParticipantId.set(loser, {
					bracketType: (match.bracket_type ?? "WINNERS") as "WINNERS" | "LOSERS",
					round: match.round,
				});
			}
		}
		if (match.home_participant_id && !standingByParticipantId.has(match.home_participant_id)) {
			unresolvedIds.add(match.home_participant_id);
		}
		if (match.away_participant_id && !standingByParticipantId.has(match.away_participant_id)) {
			unresolvedIds.add(match.away_participant_id);
		}
	}

	const unresolvedRanked = [...unresolvedIds].sort((left, right) => {
		const leftElimination = eliminationByParticipantId.get(left);
		const rightElimination = eliminationByParticipantId.get(right);
		const leftStageScore =
			(leftElimination?.bracketType === "LOSERS" ? 10_000 : 0) + (leftElimination?.round ?? 0) * 100;
		const rightStageScore =
			(rightElimination?.bracketType === "LOSERS" ? 10_000 : 0) + (rightElimination?.round ?? 0) * 100;
		if (rightStageScore !== leftStageScore) return rightStageScore - leftStageScore;
		const leftStats = playoffStatsByParticipantId.get(left) ?? { goalsFor: 0, goalsAgainst: 0, goalDiff: 0 };
		const rightStats = playoffStatsByParticipantId.get(right) ?? { goalsFor: 0, goalsAgainst: 0, goalDiff: 0 };
		if (rightStats.goalDiff !== leftStats.goalDiff) return rightStats.goalDiff - leftStats.goalDiff;
		if (rightStats.goalsFor !== leftStats.goalsFor) return rightStats.goalsFor - leftStats.goalsFor;
		if (leftStats.goalsAgainst !== rightStats.goalsAgainst) return leftStats.goalsAgainst - rightStats.goalsAgainst;
		return left.localeCompare(right);
	});

	assignUnresolvedStandings(standingByParticipantId, unresolvedRanked);
};

export const computeTournamentDetailPlayoffStandings = (
	winnersBracketMatches: MatchWithResult[],
	placementBracketMatches: MatchWithResult[],
): Map<string, number> => {
	const standingByParticipantId = new Map<string, number>();

	const winnersFinal = [...winnersBracketMatches].sort((a, b) => b.round - a.round)[0];
	if (winnersFinal?.result?.locked) {
		const winner = resolveWinner(winnersFinal);
		const loser = resolveLoser(winnersFinal);
		if (winner) standingByParticipantId.set(winner, 1);
		if (loser) standingByParticipantId.set(loser, 2);
	}

	const playoffPlacementStandings = computePlacementByParticipantId(
		[...winnersBracketMatches, ...placementBracketMatches],
		(matchId, homeId, awayId) => {
			const match =
				winnersBracketMatches.find((item) => item.id === matchId) ??
				placementBracketMatches.find((item) => item.id === matchId);
			if (!match?.result?.locked || !homeId || !awayId) return null;
			const homeScore = match.result.home_score ?? 0;
			const awayScore = match.result.away_score ?? 0;
			if (homeScore === awayScore) return null;
			return homeScore > awayScore ? { winner: homeId, loser: awayId } : { winner: awayId, loser: homeId };
		},
	);
	for (const [participantId, placement] of playoffPlacementStandings.entries()) {
		if (!standingByParticipantId.has(participantId)) {
			standingByParticipantId.set(participantId, placement);
		}
	}

	const allPlayoffMatchesLocked =
		(winnersBracketMatches.length > 0 || placementBracketMatches.length > 0) &&
		[...winnersBracketMatches, ...placementBracketMatches].every((match) => Boolean(match.result?.locked));
	if (allPlayoffMatchesLocked) {
		applyUnresolvedStandingsFallback(standingByParticipantId, [...winnersBracketMatches, ...placementBracketMatches]);
	}

	return standingByParticipantId;
};
