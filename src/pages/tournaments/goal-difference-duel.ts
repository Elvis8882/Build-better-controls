import type { MatchWithResult, Team, TournamentParticipant } from "@/lib/db";
import {
	pickRerolledTeam,
	resolveTierFromTeam,
	TIER_ORDER,
	type TierName,
} from "@/pages/tournaments/round-robin-tiers";

export type DuelHistoryRow = {
	matchId: string;
	round: number;
	homeParticipantId: string | null;
	awayParticipantId: string | null;
	homeParticipantName: string;
	awayParticipantName: string;
	homeTeamId: string | null;
	awayTeamId: string | null;
	homeScore: number;
	awayScore: number;
	impact: number;
	cumulativeAfter: number;
};

export function buildGoalDifferenceHistory(
	matches: MatchWithResult[],
	participantAId: string | null,
): DuelHistoryRow[] {
	if (!participantAId) return [];
	const locked = matches.filter((match) => match.result?.locked);
	let cumulative = 0;
	return locked.map((match) => {
		const homeScore = match.result?.home_score ?? 0;
		const awayScore = match.result?.away_score ?? 0;
		const delta = homeScore - awayScore;
		const impact = match.home_participant_id === participantAId ? delta : -delta;
		cumulative += impact;
		return {
			matchId: match.id,
			round: match.round,
			homeParticipantId: match.home_participant_id,
			awayParticipantId: match.away_participant_id,
			homeParticipantName: match.home_participant_name,
			awayParticipantName: match.away_participant_name,
			homeTeamId: match.result?.home_team_id ?? match.home_team_id ?? null,
			awayTeamId: match.result?.away_team_id ?? match.away_team_id ?? null,
			homeScore,
			awayScore,
			impact,
			cumulativeAfter: cumulative,
		};
	});
}

export function computeTierShift(homeScore: number, awayScore: number): number {
	return Math.abs(homeScore - awayScore) >= 4 ? 2 : 1;
}

export function nextTierByDelta(currentTier: TierName, delta: number): TierName {
	const currentIndex = TIER_ORDER.indexOf(currentTier);
	const nextIndex = Math.min(TIER_ORDER.length - 1, Math.max(0, currentIndex + delta));
	return TIER_ORDER[nextIndex];
}

export function rerollDuelTeams(params: {
	participants: TournamentParticipant[];
	teams: Team[];
	targetTierByParticipantId: Map<string, TierName>;
}): Map<string, string | null> {
	const nextTeamByParticipantId = new Map<string, string | null>();
	for (const participant of params.participants) {
		const targetTier =
			params.targetTierByParticipantId.get(participant.id) ?? resolveTierFromTeam(participant.team_id, params.teams);
		const excluded = new Set(
			[...nextTeamByParticipantId.values()].filter((teamId): teamId is string => Boolean(teamId)),
		);
		const teamId = pickRerolledTeam({
			teams: params.teams,
			targetTier,
			previousTeamId: participant.team_id,
			excludedTeamIds: excluded,
		});
		nextTeamByParticipantId.set(participant.id, teamId);
	}
	return nextTeamByParticipantId;
}
