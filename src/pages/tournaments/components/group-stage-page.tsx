import { type ReactNode, useMemo, useState } from "react";
import type {
	GroupStanding,
	MatchParticipantDecision,
	MatchWithResult,
	Team,
	Tournament,
	TournamentGroup,
	TournamentParticipant,
} from "@/lib/db";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

type EditableResult = {
	home_score: string;
	away_score: string;
	home_shots: string;
	away_shots: string;
	decision: MatchParticipantDecision;
};

type TeamFilter = "ALL" | Team["ovr_tier"];

export function ParticipantsTable({
	tournament,
	participants,
	placeholderRows,
	teams,
	assignedTeams,
	saving,
	isHostOrAdmin,
	editingParticipantIds,
	inviteQuery,
	inviteOptions,
	newGuestName,
	onInviteQueryChange,
	onNewGuestNameChange,
	onInvite,
	onAddGuest,
	onTeamChange,
	onRandomizeTeam,
	onLockParticipant,
	onEditParticipant,
	onClearParticipant,
}: {
	tournament: Tournament;
	participants: TournamentParticipant[];
	placeholderRows: Array<{ id: string; label: string }>;
	teams: Team[];
	assignedTeams: Set<string>;
	saving: boolean;
	isHostOrAdmin: boolean;
	editingParticipantIds: Set<string>;
	inviteQuery: string;
	inviteOptions: Array<{ id: string; username: string }>;
	newGuestName: string;
	onInviteQueryChange: (value: string) => void;
	onNewGuestNameChange: (value: string) => void;
	onInvite: () => Promise<void>;
	onAddGuest: () => Promise<void>;
	onTeamChange: (participant: TournamentParticipant, teamId: string | null) => Promise<void>;
	onRandomizeTeam: (participantId: string) => Promise<void>;
	onLockParticipant: (participantId: string) => Promise<void>;
	onEditParticipant: (participantId: string) => void;
	onClearParticipant: (participant: TournamentParticipant) => Promise<void>;
}) {
	const [teamFilterByParticipantId, setTeamFilterByParticipantId] = useState<Record<string, TeamFilter>>({});
	const hasOpenSlots = participants.length < tournament.default_participants;

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Participants & Teams</h2>
			{hasOpenSlots && (
				<div className="grid gap-3 md:grid-cols-2">
					<div className="space-y-2">
						<p className="text-sm">Invite registered user</p>
						<div className="flex gap-2">
							<Input
								value={inviteQuery}
								onChange={(e) => onInviteQueryChange(e.target.value)}
								list="invite-user-options"
							/>
							<Button
								disabled={saving || participants.length >= tournament.default_participants}
								onClick={() => void onInvite()}
							>
								Add
							</Button>
						</div>
						<datalist id="invite-user-options">
							{inviteOptions.map((option) => (
								<option key={option.id} value={option.username} />
							))}
						</datalist>
					</div>
					<div className="space-y-2">
						<p className="text-sm">Create guest</p>
						<div className="flex gap-2">
							<Input
								value={newGuestName}
								onChange={(e) => onNewGuestNameChange(e.target.value)}
								placeholder="Guest name"
							/>
							<Button
								disabled={saving || participants.length >= tournament.default_participants}
								onClick={() => void onAddGuest()}
							>
								Add
							</Button>
						</div>
					</div>
				</div>
			)}
			<div className="overflow-x-auto">
				<table className="w-full min-w-[760px] text-sm">
					<thead>
						<tr className="border-b">
							<th className="px-2 py-2 text-left">Participant</th>
							<th className="px-2 py-2 text-left">Team</th>
							<th className="px-2 py-2 text-left">Actions</th>
						</tr>
					</thead>
					<tbody>
						{participants.map((participant) => {
							const teamFilter = teamFilterByParticipantId[participant.id] ?? "ALL";
							const filteredTeams = teams.filter((team) => teamFilter === "ALL" || team.ovr_tier === teamFilter);
							return (
								<tr key={participant.id} className="border-b">
									<td className="px-2 py-2">{participant.display_name}</td>
									<td className="px-2 py-2">
										<div className="mb-2 flex items-center gap-2">
											<span className="text-xs text-muted-foreground">Filter</span>
											<select
												className="h-8 rounded-md border px-2 text-xs"
												value={teamFilter}
												onChange={(event) =>
													setTeamFilterByParticipantId((previous) => ({
														...previous,
														[participant.id]: event.target.value as TeamFilter,
													}))
												}
											>
												<option value="ALL">All teams</option>
												<option value="Top 5">Top 5</option>
												<option value="Top 10">Top 10</option>
												<option value="Middle Tier">Middle Tier</option>
												<option value="Bottom Tier">Bottom Tier</option>
											</select>
										</div>
										<select
											className="h-9 rounded-md border px-2"
											disabled={participant.locked && !editingParticipantIds.has(participant.id)}
											value={participant.team_id ?? ""}
											onChange={(event) => void onTeamChange(participant, event.target.value || null)}
										>
											<option value="">Select team</option>
											{filteredTeams.map((team) => (
												<option
													key={team.id}
													value={team.id}
													disabled={assignedTeams.has(team.id) && participant.team_id !== team.id}
												>
													{team.name}
												</option>
											))}
										</select>
										{participant.team && (
											<p className="mt-1 text-xs text-muted-foreground">
												OVR {participant.team.overall} • OFF {participant.team.offense} • DEF {participant.team.defense}{" "}
												• GOA {participant.team.goalie}
											</p>
										)}
									</td>
									<td className="flex gap-2 px-2 py-2">
										<Button size="sm" variant="outline" onClick={() => void onRandomizeTeam(participant.id)}>
											🎲
										</Button>
										<Button
											size="sm"
											disabled={participant.locked || !participant.team_id || editingParticipantIds.has(participant.id)}
											onClick={() => void onLockParticipant(participant.id)}
										>
											{participant.locked ? "Locked" : "Lock in"}
										</Button>
										{participant.locked && isHostOrAdmin && (
											<Button size="sm" variant="outline" onClick={() => onEditParticipant(participant.id)}>
												Edit
											</Button>
										)}
										{isHostOrAdmin && (
											<Button
												size="sm"
												variant="ghost"
												disabled={saving}
												onClick={() => void onClearParticipant(participant)}
											>
												×
											</Button>
										)}
									</td>
								</tr>
							);
						})}
						{placeholderRows.map((row) => (
							<tr key={row.id} className="border-b border-dashed bg-muted/20">
								<td className="px-2 py-3 text-muted-foreground">{row.label}</td>
								<td className="px-2 py-3 text-muted-foreground">-</td>
								<td className="px-2 py-3 text-muted-foreground">Invite or add guest</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

export function GroupStandings({
	groups,
	standings,
	teamById,
}: {
	groups: TournamentGroup[];
	standings: GroupStanding[];
	teamById: Map<string, Team>;
}) {
	const standingsByGroupId = useMemo(() => {
		const map = new Map<string, GroupStanding[]>();
		for (const standing of standings) {
			const current = map.get(standing.group_id) ?? [];
			current.push(standing);
			map.set(standing.group_id, current);
		}
		return map;
	}, [standings]);

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Group standings</h2>
			<div className="grid gap-3 md:grid-cols-2">
				{groups.map((group) => (
					<div key={group.id} className="rounded border p-3">
						<h4 className="mb-2 font-medium">Group {group.group_code}</h4>
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b">
									<th className="py-1 text-left">Team</th>
									<th className="py-1 text-right">GF:GA</th>
									<th className="py-1 text-right">Pts</th>
								</tr>
							</thead>
							<tbody>
								{(standingsByGroupId.get(group.id) ?? [])
									.sort((a, b) => a.rank_in_group - b.rank_in_group)
									.map((row) => {
										const team = row.team_id ? teamById.get(row.team_id) : null;
										return (
											<tr key={row.participant_id} className="border-b">
												<td className="py-1">{team?.name ?? `Participant ${row.participant_id.slice(0, 6)}`}</td>
												<td className="py-1 text-right">
													{row.goals_for}:{row.goals_against}
												</td>
												<td className="py-1 text-right font-semibold">{row.points}</td>
											</tr>
										);
									})}
							</tbody>
						</table>
					</div>
				))}
			</div>
		</section>
	);
}

export function GroupMatchesTable({
	matches,
	teamById,
	resultDrafts,
	saving,
	canEditMatch,
	onResultDraftChange,
	onLockResult,
}: {
	matches: MatchWithResult[];
	teamById: Map<string, Team>;
	resultDrafts: Record<string, EditableResult>;
	saving: boolean;
	canEditMatch: (match: MatchWithResult) => boolean;
	onResultDraftChange: (matchId: string, next: EditableResult) => void;
	onLockResult: (matchId: string) => Promise<void>;
}) {
	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Group matches</h2>
			<div className="space-y-3">
				{matches.map((match) => {
					const draft = resultDrafts[match.id] ?? {
						home_score: "",
						away_score: "",
						home_shots: "",
						away_shots: "",
						decision: "R" as MatchParticipantDecision,
					};
					const homeTeam = match.home_team_id ? teamById.get(match.home_team_id) : null;
					const awayTeam = match.away_team_id ? teamById.get(match.away_team_id) : null;
					const disabled = !canEditMatch(match);

					return (
						<div key={match.id} className="rounded-xl border bg-gradient-to-b from-card to-muted/10 p-4 shadow-sm">
							<div className="mb-4 flex items-center justify-between gap-3">
								<h3 className="text-xl font-bold">
									Game {match.round}
									{match.bracket_slot ? `.${match.bracket_slot}` : ""}
								</h3>
								{match.result?.locked && <Badge className="text-xs">Locked</Badge>}
							</div>
							<div className="grid grid-cols-[1fr_auto_1fr] items-start gap-4">
								<div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-left">
									<p className="text-xs font-semibold uppercase tracking-wide text-primary">Home Team</p>
									<p className="mt-1 text-base font-semibold">{homeTeam?.name ?? match.home_participant_name}</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.home_score ?? "-"} • SOG: {match.result?.home_shots ?? "-"}
									</p>
								</div>
								<div className="flex flex-col items-center justify-center gap-2">
									<span className="text-2xl font-black">VS</span>
									<select
										className="h-10 rounded-md border bg-background px-3 text-sm"
										disabled={disabled}
										value={draft.decision}
										onChange={(e) =>
											onResultDraftChange(match.id, { ...draft, decision: e.target.value as MatchParticipantDecision })
										}
									>
										<option value="R">R</option>
										<option value="OT">OT</option>
										<option value="SO">SO</option>
									</select>
								</div>
								<div className="rounded-lg border border-secondary/40 bg-secondary/10 p-3 text-right">
									<p className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">Away Team</p>
									<p className="mt-1 text-base font-semibold">{awayTeam?.name ?? match.away_participant_name}</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.away_score ?? "-"} • SOG: {match.result?.away_shots ?? "-"}
									</p>
								</div>
							</div>
							<div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Home Score</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_score: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Away Score</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.away_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_score: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Home SOG</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_shots: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Away SOG</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.away_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_shots: e.target.value })}
									/>
								</div>
							</div>
							<div className="mt-3">
								<Button
									disabled={saving || disabled || Boolean(match.result?.locked)}
									onClick={() => void onLockResult(match.id)}
								>
									Lock in
								</Button>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

export function GroupStagePage({
	standingsTable,
	matchesTable,
}: {
	standingsTable: ReactNode;
	matchesTable: ReactNode;
}) {
	return (
		<div className="space-y-4">
			{standingsTable}
			{matchesTable}
		</div>
	);
}
