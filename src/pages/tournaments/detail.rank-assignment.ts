export const assignUnresolvedStandings = (
	standingByParticipantId: Map<string, number>,
	unresolvedRanked: string[],
): void => {
	const assignedStandings = new Set<number>();
	for (const standing of standingByParticipantId.values()) {
		if (Number.isInteger(standing) && standing > 0) {
			assignedStandings.add(standing);
		}
	}

	let nextStanding = 1;
	for (const participantId of unresolvedRanked) {
		while (assignedStandings.has(nextStanding)) {
			nextStanding += 1;
		}
		standingByParticipantId.set(participantId, nextStanding);
		assignedStandings.add(nextStanding);
		nextStanding += 1;
	}
};
