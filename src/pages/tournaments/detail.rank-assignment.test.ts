import { assignUnresolvedStandings } from "@/pages/tournaments/detail.rank-assignment";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

export function runDetailRankAssignmentAssertions(): void {
	const standingByParticipantId = new Map<string, number>([
		["p1", 1],
		["p2", 2],
		["p3", 3],
		["p4", 4],
		["p7", 7],
		["p8", 8],
	]);

	assignUnresolvedStandings(standingByParticipantId, ["uA", "uB"]);

	assert(standingByParticipantId.get("uA") === 5, "first unresolved participant should receive rank #5");
	assert(standingByParticipantId.get("uB") === 6, "second unresolved participant should receive rank #6");
}
