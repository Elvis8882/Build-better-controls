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
import { getTeamLogoUrl } from "@/lib/teamLogos";
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
	participantFieldsLocked,
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
	participantFieldsLocked: boolean;
	editingParticipantIds: Set<string>;
	inviteQuery: string;
	inviteOptions: Array<{ id: string; username: string }>;
	newGuestName: string;
	onInviteQueryChange: (value: string) => void;
	onNewGuestNameChange: (value: string) => void;
	onInvite: () => Promise<void>;
	onAddGuest: () => Promise<void>;
	onTeamChange: (participant: TournamentParticipant, teamId: string | null) => Promise<void>;
	onRandomizeTeam: (participant: TournamentParticipant, teamFilter: TeamFilter) => Promise<void>;
	onLockParticipant: (participantId: string) => Promise<void>;
	onEditParticipant: (participantId: string) => void;
	onClearParticipant: (participant: TournamentParticipant) => Promise<void>;
}) {
	const [teamFilterByParticipantId, setTeamFilterByParticipantId] = useState<Record<string, TeamFilter>>({});
	const hasOpenSlots = participants.length < tournament.default_participants;

	return (
		<section className="space-y-3 rounded-lg border p-3 md:p-4">
			<h2 className="text-lg font-semibold">Participants & Teams</h2>
			{hasOpenSlots && !participantFieldsLocked && (
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
				<table className="w-full min-w-[640px] text-sm md:min-w-[760px]">
					<thead>
						<tr className="border-b">
							<th className="px-2 py-2 text-center">Participant</th>
							<th className="px-2 py-2 text-center">Team</th>
							<th className="px-2 py-2 text-center">Actions</th>
						</tr>
					</thead>
					<tbody>
						{participants.map((participant) => {
							const teamFilter = teamFilterByParticipantId[participant.id] ?? "ALL";
							const filteredTeams = teams.filter((team) => teamFilter === "ALL" || team.ovr_tier === teamFilter);
							return (
								<tr key={participant.id} className="border-b">
									<td className="px-2 py-2 text-center align-middle">{participant.display_name}</td>
									<td className="px-2 py-2 align-middle">
										<div className="flex flex-col items-center justify-center gap-2 md:flex-row">
											<span className="text-xs text-muted-foreground">Filter</span>
											<select
												className="h-8 rounded-md border px-2 text-xs"
												disabled={participant.locked && !editingParticipantIds.has(participant.id)}
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
											<select
												className="h-9 min-w-[120px] max-w-full rounded-md border px-2"
												disabled={
													participantFieldsLocked || (participant.locked && !editingParticipantIds.has(participant.id))
												}
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
												<>
													<img
														src={getTeamLogoUrl(participant.team.code, participant.team.team_pool)}
														alt={`${participant.team.name} logo`}
														className="h-7 w-7 rounded-sm object-contain"
													/>
													<p className="text-center text-xs text-muted-foreground md:text-left">
														OVR {participant.team.overall} • OFF {participant.team.offense} • DEF{" "}
														{participant.team.defense} • GOA {participant.team.goalie}
													</p>
												</>
											)}
										</div>
									</td>
									<td className="px-2 py-2 align-middle">
										<div className="flex flex-wrap justify-center gap-2">
											<Button
												size="sm"
												variant="outline"
												disabled={
													participantFieldsLocked || (participant.locked && !editingParticipantIds.has(participant.id))
												}
												onClick={() => void onRandomizeTeam(participant, teamFilter)}
											>
												🎲
											</Button>
											<Button
												size="sm"
												disabled={
													participantFieldsLocked ||
													(!editingParticipantIds.has(participant.id) && participant.locked) ||
													!participant.team_id
												}
												onClick={() => void onLockParticipant(participant.id)}
											>
												{editingParticipantIds.has(participant.id)
													? "Save & lock"
													: participant.locked
														? "Locked"
														: "Lock in"}
											</Button>
											{participant.locked && isHostOrAdmin && !participantFieldsLocked && (
												<Button size="sm" variant="outline" onClick={() => onEditParticipant(participant.id)}>
													Edit
												</Button>
											)}
											{isHostOrAdmin && !participantFieldsLocked && (
												<Button
													size="sm"
													variant="ghost"
													disabled={saving}
													onClick={() => void onClearParticipant(participant)}
												>
													×
												</Button>
											)}
										</div>
									</td>
								</tr>
							);
						})}
						{placeholderRows.map((row) => (
							<tr key={row.id} className="border-b border-dashed bg-muted/20">
								<td className="px-2 py-3 text-center text-muted-foreground">{row.label}</td>
								<td className="px-2 py-3 text-center text-muted-foreground">-</td>
								<td className="px-2 py-3 text-center text-muted-foreground">Invite or add guest</td>
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
	showPlacement,
	groupMatches,
}: {
	groups: TournamentGroup[];
	standings: GroupStanding[];
	teamById: Map<string, Team>;
	showPlacement: boolean;
	groupMatches: MatchWithResult[];
}) {
	const overallPlacementByParticipantId = useMemo(() => {
		if (!showPlacement) return new Map<string, number>();
		const sorted = [...standings].sort((a, b) => {
			if (b.points !== a.points) return b.points - a.points;
			if (b.goal_diff !== a.goal_diff) return b.goal_diff - a.goal_diff;
			if (b.shots_diff !== a.shots_diff) return b.shots_diff - a.shots_diff;
			return a.rank_in_group - b.rank_in_group;
		});
		return new Map(sorted.map((row, index) => [row.participant_id, index + 1]));
	}, [standings, showPlacement]);

	const standingsByGroupId = useMemo(() => {
		const map = new Map<string, GroupStanding[]>();
		for (const standing of standings) {
			const current = map.get(standing.group_id) ?? [];
			current.push(standing);
			map.set(standing.group_id, current);
		}
		return map;
	}, [standings]);
	const statsByParticipantId = useMemo(() => {
		const map = new Map<string, { gamesPlayed: number; wins: number; losses: number }>();
		for (const match of groupMatches) {
			if (!match.result?.locked || !match.home_participant_id || !match.away_participant_id) continue;
			const home = map.get(match.home_participant_id) ?? { gamesPlayed: 0, wins: 0, losses: 0 };
			const away = map.get(match.away_participant_id) ?? { gamesPlayed: 0, wins: 0, losses: 0 };
			home.gamesPlayed += 1;
			away.gamesPlayed += 1;
			if ((match.result.home_score ?? 0) > (match.result.away_score ?? 0)) {
				home.wins += 1;
				away.losses += 1;
			}
			if ((match.result.away_score ?? 0) > (match.result.home_score ?? 0)) {
				away.wins += 1;
				home.losses += 1;
			}
			map.set(match.home_participant_id, home);
			map.set(match.away_participant_id, away);
		}
		return map;
	}, [groupMatches]);

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Group standings</h2>
			<div className="grid gap-3 md:grid-cols-2">
				{groups.map((group) => (
					<div key={group.id} className="rounded border p-3">
						<h4 className="mb-2 font-medium">Group {group.group_code}</h4>
						<div className="overflow-x-auto">
							<table className="w-full min-w-[460px] text-sm">
								<thead>
									<tr className="border-b">
										<th className="w-[28%] py-1 text-left">Team</th>
										<th className="w-[9%] py-1 text-right">GP</th>
										<th className="w-[9%] py-1 text-right">W</th>
										<th className="w-[9%] py-1 text-right">L</th>
										<th className="w-[14%] py-1 text-right">GF:GA</th>
										<th className="w-[12%] py-1 text-right">Pts</th>
										{showPlacement && <th className="w-[19%] py-1 text-right">Placement</th>}
									</tr>
								</thead>
								<tbody>
									{(standingsByGroupId.get(group.id) ?? [])
										.sort((a, b) => a.rank_in_group - b.rank_in_group)
										.map((row) => {
											const team = row.team_id ? teamById.get(row.team_id) : null;
											const placement = overallPlacementByParticipantId.get(row.participant_id);
											return (
												<tr key={row.participant_id} className="border-b">
													<td className="py-1 pr-2">{team?.name ?? `Participant ${row.participant_id.slice(0, 6)}`}</td>
													<td className="py-1 pl-2 text-right">
														{statsByParticipantId.get(row.participant_id)?.gamesPlayed ?? 0}
													</td>
													<td className="py-1 pl-2 text-right">
														{statsByParticipantId.get(row.participant_id)?.wins ?? 0}
													</td>
													<td className="py-1 pl-2 text-right">
														{statsByParticipantId.get(row.participant_id)?.losses ?? 0}
													</td>
													<td className="py-1 pl-2 text-right">
														{row.goals_for}:{row.goals_against}
													</td>
													<td className="py-1 pl-2 text-right font-semibold">{row.points}</td>
													{showPlacement && <td className="py-1 pl-2 text-right font-semibold">#{placement}</td>}
												</tr>
											);
										})}
								</tbody>
							</table>
						</div>
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
	onEditResult,
}: {
	matches: MatchWithResult[];
	teamById: Map<string, Team>;
	resultDrafts: Record<string, EditableResult>;
	saving: boolean;
	canEditMatch: (match: MatchWithResult) => boolean;
	onResultDraftChange: (matchId: string, next: EditableResult) => void;
	onLockResult: (matchId: string) => Promise<void>;
	onEditResult?: (matchId: string) => void;
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
					const winningSide =
						match.result?.locked && (match.result.home_score ?? 0) !== (match.result.away_score ?? 0)
							? (match.result.home_score ?? 0) > (match.result.away_score ?? 0)
								? "HOME"
								: "AWAY"
							: null;
					const disabled = !canEditMatch(match);

					return (
						<div
							key={match.id}
							className="rounded-xl border bg-gradient-to-b from-card to-muted/10 p-3 shadow-sm md:p-4"
						>
							<div className="mb-4 flex items-center justify-between gap-3">
								<h3 className="text-xl font-bold">
									Game {match.round}
									{match.bracket_slot ? `.${match.bracket_slot}` : ""}
								</h3>
								{match.result?.locked && <Badge className="text-xs">Locked</Badge>}
							</div>
							<div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
								<div
									className={`rounded-lg border border-primary/20 p-3 text-left ${winningSide === "HOME" ? "bg-green-100/80" : ""}`}
								>
									<p className="text-xs font-semibold uppercase tracking-wide text-primary">Home Team</p>
									<div className="mt-1 flex items-center gap-2">
										{homeTeam && (
											<img
												src={getTeamLogoUrl(homeTeam.code, homeTeam.team_pool)}
												alt={`${homeTeam.name} logo`}
												className="h-14 w-14 object-contain"
											/>
										)}
										<p className="text-base font-semibold">{homeTeam?.name ?? match.home_participant_name}</p>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.home_score ?? "-"} • SOG: {match.result?.home_shots ?? "-"}
									</p>
								</div>
								<div className="hidden flex-col items-center justify-center gap-2 md:flex">
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
								<div className="flex justify-center md:hidden">
									<span className="text-2xl font-black">VS</span>
								</div>
								<div
									className={`rounded-lg border border-primary/20 p-3 text-right ${winningSide === "AWAY" ? "bg-green-100/80" : ""}`}
								>
									<p className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">Away Team</p>
									<div className="mt-1 flex items-center justify-end gap-2">
										<p className="text-base font-semibold">{awayTeam?.name ?? match.away_participant_name}</p>
										{awayTeam && (
											<img
												src={getTeamLogoUrl(awayTeam.code, awayTeam.team_pool)}
												alt={`${awayTeam.name} logo`}
												className="h-14 w-14 object-contain"
											/>
										)}
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.away_score ?? "-"} • SOG: {match.result?.away_shots ?? "-"}
									</p>
								</div>
								<div className="flex justify-center md:hidden">
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
							</div>
							<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">Home Goal</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_score: e.target.value })}
									/>
									<p className="text-xs font-medium text-muted-foreground">Home SOG</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_shots: e.target.value })}
									/>
								</div>
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground text-right">Away Goal</p>
									<Input
										type="number"
										min={0}
										className="text-right"
										disabled={disabled}
										value={draft.away_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_score: e.target.value })}
									/>
									<p className="text-xs font-medium text-muted-foreground text-right">Away SOG</p>
									<Input
										type="number"
										min={0}
										className="text-right"
										disabled={disabled}
										value={draft.away_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_shots: e.target.value })}
									/>
								</div>
							</div>
							<div className="mt-3 flex gap-2">
								<Button disabled={saving || disabled} onClick={() => void onLockResult(match.id)}>
									{match.result?.locked ? "Save & lock" : "Lock in"}
								</Button>
								{onEditResult && Boolean(match.result?.locked) && (
									<Button size="sm" variant="outline" onClick={() => onEditResult(match.id)}>
										Edit
									</Button>
								)}
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
		<div className="overflow-x-auto">
			<div className="min-w-[760px] space-y-4 md:min-w-0">
				{standingsTable}
				{matchesTable}
			</div>
		</div>
	);
}
