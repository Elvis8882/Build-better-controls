import type { Team } from "@/lib/db";
import { getTeamLogoUrl, handleTeamLogoImageError } from "@/lib/teamLogos";
import type { DuelHistoryRow } from "@/pages/tournaments/goal-difference-duel";

type DuelParticipantView = {
	id: string;
	name: string;
	teamId: string | null;
	tier: string;
};

type Props = {
	target: number;
	cumulative: number;
	leaderLabel: string;
	winnerLabel: string | null;
	participantA: DuelParticipantView;
	participantB: DuelParticipantView;
	teamById: Map<string, Team>;
	history: DuelHistoryRow[];
};

function TeamBadge({ teamId, teamById }: { teamId: string | null; teamById: Map<string, Team> }) {
	if (!teamId) return <span className="text-xs text-muted-foreground">TBD</span>;
	const team = teamById.get(teamId);
	if (!team) return <span className="text-xs text-muted-foreground">Unknown</span>;
	return (
		<div className="flex items-center gap-2">
			<img
				className="h-5 w-5 rounded-sm border bg-background p-0.5"
				src={getTeamLogoUrl(team.code, team.team_pool)}
				alt={`${team.name} logo`}
				onError={handleTeamLogoImageError}
			/>
			<span className="text-xs">{team.short_name}</span>
		</div>
	);
}

export function GoalDifferenceDuelPage(props: Props) {
	return (
		<div className="space-y-4">
			<section className="rounded-lg border p-4">
				<div className="flex flex-wrap items-center justify-between gap-3 text-sm">
					<div>
						Target: <span className="font-semibold">±{props.target}</span>
					</div>
					<div>
						Cumulative GD:{" "}
						<span className="font-semibold">{props.cumulative >= 0 ? `+${props.cumulative}` : props.cumulative}</span>
					</div>
					<div>
						Leader: <span className="font-semibold">{props.leaderLabel}</span>
					</div>
				</div>
				{props.winnerLabel && (
					<p className="mt-2 text-sm font-semibold text-emerald-600">Winner: {props.winnerLabel}</p>
				)}
			</section>

			<section className="grid gap-3 md:grid-cols-2">
				{[props.participantA, props.participantB].map((participant) => (
					<div key={participant.id} className="rounded-lg border p-3 text-sm">
						<p className="font-medium">{participant.name}</p>
						<p className="text-muted-foreground">Tier: {participant.tier}</p>
						<div className="mt-2">
							<TeamBadge teamId={participant.teamId} teamById={props.teamById} />
						</div>
					</div>
				))}
			</section>

			<section className="rounded-lg border p-4">
				<h2 className="mb-3 text-lg font-semibold">Match history</h2>
				<div className="overflow-x-auto">
					<table className="w-full min-w-[780px] text-sm">
						<thead>
							<tr className="border-b text-left">
								<th className="py-2">#</th>
								<th className="py-2">Home</th>
								<th className="py-2">Away</th>
								<th className="py-2">Score</th>
								<th className="py-2">Impact</th>
								<th className="py-2">Cumulative</th>
							</tr>
						</thead>
						<tbody>
							{props.history.map((row) => (
								<tr key={row.matchId} className="border-b align-middle">
									<td className="py-2">{row.round}</td>
									<td className="py-2">
										<div className="flex items-center gap-2">
											<span>{row.homeParticipantName}</span>
											<TeamBadge teamId={row.homeTeamId} teamById={props.teamById} />
										</div>
									</td>
									<td className="py-2">
										<div className="flex items-center gap-2">
											<span>{row.awayParticipantName}</span>
											<TeamBadge teamId={row.awayTeamId} teamById={props.teamById} />
										</div>
									</td>
									<td className="py-2">
										{row.homeScore}-{row.awayScore}
									</td>
									<td className="py-2">{row.impact >= 0 ? `+${row.impact}` : row.impact}</td>
									<td className="py-2">{row.cumulativeAfter >= 0 ? `+${row.cumulativeAfter}` : row.cumulativeAfter}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}
