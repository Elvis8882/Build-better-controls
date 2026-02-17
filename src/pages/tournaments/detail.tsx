import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createParticipant,
	fetchTeamsByPool,
	type GroupStanding,
	generateGroupsAndMatches,
	generatePlayoffs,
	getTournament,
	inviteMember,
	listGroupStandings,
	listGroups,
	listMatchesWithResults,
	listParticipants,
	listTournamentMembers,
	lockMatchResult,
	lockParticipant,
	type MatchParticipantDecision,
	type MatchWithResult,
	type ProfileOption,
	removeParticipant,
	searchProfilesByUsername,
	type Tournament,
	type TournamentMember,
	type TournamentParticipant,
	type Team,
	updateParticipant,
	upsertMatchResult,
} from "@/lib/db";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

type EditableResult = {
	home_score: string;
	away_score: string;
	home_shots: string;
	away_shots: string;
	decision: MatchParticipantDecision;
};

const defaultResult: EditableResult = {
	home_score: "0",
	away_score: "0",
	home_shots: "0",
	away_shots: "0",
	decision: "R",
};

function TeamPill({ team, fallback }: { team?: Team | null; fallback: string }) {
	if (!team) return <span>{fallback}</span>;
	return (
		<span
			className="inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold"
			style={{
				backgroundColor: team.primary_color || "#1f2937",
				color: team.text_color || "#ffffff",
				border: `1px solid ${team.secondary_color || team.primary_color || "#4b5563"}`,
			}}
		>
			{team.short_name || team.code}
		</span>
	);
}

function MatchTable({
	title,
	matches,
	saving,
	resultDrafts,
	setResultDrafts,
	onSaveResult,
	onLockResult,
	isHostOrAdmin,
	userId,
}: {
	title: string;
	matches: MatchWithResult[];
	saving: boolean;
	resultDrafts: Record<string, EditableResult>;
	setResultDrafts: Dispatch<SetStateAction<Record<string, EditableResult>>>;
	onSaveResult: (matchId: string) => Promise<void>;
	onLockResult: (matchId: string) => Promise<void>;
	isHostOrAdmin: boolean;
	userId?: string;
}) {
	const canEdit = (match: MatchWithResult) => {
		if (isHostOrAdmin) return true;
		if (!userId || !match.result || match.result.locked) return false;
		return true;
	};

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h3 className="text-lg font-semibold">{title}</h3>
			{matches.length === 0 ? (
				<p className="text-sm text-muted-foreground">No matches yet.</p>
			) : (
				<div className="space-y-3">
					{matches.map((match) => {
						const draft = resultDrafts[match.id] ?? defaultResult;
						const disabled = !canEdit(match);
						return (
							<div key={match.id} className="space-y-2 rounded-md border p-3">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span className="font-medium">
										R{match.round} • {match.home_participant_name} ({match.home_team_id ?? "TBD"}) vs{" "}
										{match.away_participant_name} ({match.away_team_id ?? "TBD"})
									</span>
									{match.result?.locked && <Badge>Locked</Badge>}
								</div>
								<div className="grid gap-2 md:grid-cols-5">
									<Input
										type="number"
										disabled={disabled}
										value={draft.home_score}
										onChange={(event) =>
											setResultDrafts((previous) => ({
												...previous,
												[match.id]: { ...draft, home_score: event.target.value },
											}))
										}
									/>
									<Input
										type="number"
										disabled={disabled}
										value={draft.away_score}
										onChange={(event) =>
											setResultDrafts((previous) => ({
												...previous,
												[match.id]: { ...draft, away_score: event.target.value },
											}))
										}
									/>
									<Input
										type="number"
										disabled={disabled}
										value={draft.home_shots}
										onChange={(event) =>
											setResultDrafts((previous) => ({
												...previous,
												[match.id]: { ...draft, home_shots: event.target.value },
											}))
										}
									/>
									<Input
										type="number"
										disabled={disabled}
										value={draft.away_shots}
										onChange={(event) =>
											setResultDrafts((previous) => ({
												...previous,
												[match.id]: { ...draft, away_shots: event.target.value },
											}))
										}
									/>
									<select
										className="h-10 rounded-md border bg-transparent px-3 text-sm"
										disabled={disabled}
										value={draft.decision}
										onChange={(event) =>
											setResultDrafts((previous) => ({
												...previous,
												[match.id]: { ...draft, decision: event.target.value as MatchParticipantDecision },
											}))
										}
									>
										<option value="R">R</option>
										<option value="OT">OT</option>
										<option value="SO">SO</option>
									</select>
								</div>
								<div className="flex gap-2">
									<Button variant="outline" disabled={saving || disabled} onClick={() => void onSaveResult(match.id)}>
										Save
									</Button>
									<Button
										disabled={saving || !match.result || disabled || match.result.locked}
										onClick={() => void onLockResult(match.id)}
									>
										Lock in
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

export default function TournamentDetailPage() {
	const { id } = useParams();
	const { user, profile } = useAuth();
	const [loading, setLoading] = useState(true);
	const [tournament, setTournament] = useState<Tournament | null>(null);
	const [members, setMembers] = useState<TournamentMember[]>([]);
	const [participants, setParticipants] = useState<TournamentParticipant[]>([]);
	const [teams, setTeams] = useState<Team[]>([]);
	const [groups, setGroups] = useState<{ id: string; tournament_id: string; group_code: string }[]>([]);
	const [standings, setStandings] = useState<GroupStanding[]>([]);
	const [groupMatches, setGroupMatches] = useState<MatchWithResult[]>([]);
	const [playoffMatches, setPlayoffMatches] = useState<MatchWithResult[]>([]);
	const [inviteQuery, setInviteQuery] = useState("");
	const [inviteOptions, setInviteOptions] = useState<ProfileOption[]>([]);
	const [selectedInviteUserId, setSelectedInviteUserId] = useState("");
	const [newGuestName, setNewGuestName] = useState("");
	const [saving, setSaving] = useState(false);
	const [resultDrafts, setResultDrafts] = useState<Record<string, EditableResult>>({});
	const [editingParticipantIds, setEditingParticipantIds] = useState<Set<string>>(new Set());
	const [participantFilters, setParticipantFilters] = useState<Record<string, Team["ovr_tier"] | "ALL">>({});

	const isAdmin = profile?.role === "admin";
	const hostMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && member.role === "host"),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(hostMembership);

	const hasTriggeredAutoPlayoff = useRef(false);
	const displayParticipants = useMemo(() => {
		if (!tournament) return participants;
		const withHostLabel = participants.map((participant) => {
			if (participant.user_id !== tournament.created_by) return participant;
			if (participant.display_name.includes("(Host)")) return participant;
			return { ...participant, display_name: `${participant.display_name} (Host)` };
		});
		return [...withHostLabel].sort((left, right) => {
			const leftIsHost = left.user_id === tournament.created_by;
			const rightIsHost = right.user_id === tournament.created_by;
			if (leftIsHost && !rightIsHost) return -1;
			if (!leftIsHost && rightIsHost) return 1;
			return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
		});
	}, [participants, tournament]);
	const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
	const teamsByTier = useMemo(() => {
		const map: Record<Team["ovr_tier"] | "ALL", Team[]> = {
			ALL: teams,
			"Top 5": teams.filter((team) => team.ovr_tier === "Top 5"),
			"Top 10": teams.filter((team) => team.ovr_tier === "Top 5" || team.ovr_tier === "Top 10"),
			"Middle Tier": teams.filter((team) => team.ovr_tier === "Middle Tier"),
			"Bottom Tier": teams.filter((team) => team.ovr_tier === "Bottom Tier"),
		};
		return map;
	}, [teams]);
	const assignedTeams = new Set(displayParticipants.map((participant) => participant.team_id).filter(Boolean));
	const slots = tournament?.default_participants ?? 0;
	const placeholderRows = useMemo(
		() =>
			Array.from({ length: Math.max(0, slots - displayParticipants.length) }, (_, index) => ({
				id: `placeholder-${index}`,
				label: `Empty slot ${displayParticipants.length + index + 1}`,
			})),
		[displayParticipants.length, slots],
	);
	const allLockedWithTeams =
		displayParticipants.length === slots &&
		displayParticipants.every((participant) => participant.locked && participant.team_id);
	const allGroupMatchesLocked = groupMatches.length > 0 && groupMatches.every((match) => match.result?.locked);
	const canGeneratePlayoffs = tournament?.preset_id === "playoffs_only" ? allLockedWithTeams : allGroupMatchesLocked;
	const canGenerateGroups = tournament?.preset_id === "full_tournament" && allLockedWithTeams && groups.length === 0;
	const groupStageAvailable =
		tournament?.preset_id === "full_tournament" && (groups.length > 0 || groupMatches.length > 0);
	const playoffAvailable = playoffMatches.length > 0;

	const loadAll = useCallback(async () => {
		if (!id) return;
		try {
			setLoading(true);
			const [
				tournamentData,
				memberData,
				participantData,
				groupData,
				standingData,
				groupMatchData,
				playoffMatchData,
				teamData,
			] = await Promise.all([
				getTournament(id),
				listTournamentMembers(id),
				listParticipants(id),
				listGroups(id),
				listGroupStandings(id),
				listMatchesWithResults(id, "GROUP"),
				listMatchesWithResults(id, "PLAYOFF"),
				getTournament(id).then((tournamentRow) => fetchTeamsByPool(tournamentRow?.team_pool ?? "NHL")),
			]);
			setTournament(tournamentData);
			setMembers(memberData);
			setParticipants(participantData);
			setGroups(groupData);
			setStandings(standingData);
			setGroupMatches(groupMatchData);
			setPlayoffMatches(playoffMatchData);
			setTeams(teamData);
			const drafts: Record<string, EditableResult> = {};
			for (const match of [...groupMatchData, ...playoffMatchData]) {
				drafts[match.id] = {
					home_score: String(match.result?.home_score ?? 0),
					away_score: String(match.result?.away_score ?? 0),
					home_shots: String(match.result?.home_shots ?? 0),
					away_shots: String(match.result?.away_shots ?? 0),
					decision: match.result?.decision ?? "R",
				};
			}
			setResultDrafts(drafts);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [id]);

	const onGeneratePlayoffs = useCallback(async () => {
		if (!id || !isHostOrAdmin || !canGeneratePlayoffs) return;
		setSaving(true);
		try {
			await generatePlayoffs(id);
			await loadAll();
			toast.success("Playoff bracket and schedule generated.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	}, [id, isHostOrAdmin, canGeneratePlayoffs, loadAll]);

	useEffect(() => {
		void loadAll();
	}, [loadAll]);

	useEffect(() => {
		if (!id) return;
		hasTriggeredAutoPlayoff.current = false;
	}, [id]);

	useEffect(() => {
		if (!id || !tournament || !isHostOrAdmin) return;
		const hostParticipantExists = participants.some((participant) => participant.user_id === tournament.created_by);
		if (hostParticipantExists || participants.length >= slots) return;
		const hostMember = members.find((member) => member.user_id === tournament.created_by);
		if (!hostMember?.username) return;

		setSaving(true);
		void createParticipant(id, {
			userId: tournament.created_by,
			displayName: `${hostMember.username} (Host)`,
		})
			.then(loadAll)
			.catch((error) => toast.error((error as Error).message))
			.finally(() => setSaving(false));
	}, [id, isHostOrAdmin, members, participants, slots, tournament, loadAll]);

	useEffect(() => {
		if (!id || !isHostOrAdmin || saving || !canGenerateGroups) return;
		setSaving(true);
		void generateGroupsAndMatches(id)
			.then(loadAll)
			.then(() => toast.success("Groups and group schedule generated."))
			.catch((error) => toast.error((error as Error).message))
			.finally(() => setSaving(false));
	}, [id, isHostOrAdmin, saving, canGenerateGroups, loadAll]);

	useEffect(() => {
		if (!id || !isHostOrAdmin || saving || playoffMatches.length > 0 || !canGeneratePlayoffs) return;
		if (hasTriggeredAutoPlayoff.current) return;
		hasTriggeredAutoPlayoff.current = true;
		void onGeneratePlayoffs();
	}, [id, isHostOrAdmin, saving, playoffMatches.length, canGeneratePlayoffs, onGeneratePlayoffs]);

	useEffect(() => {
		if (!canGeneratePlayoffs || playoffMatches.length > 0) return;
		hasTriggeredAutoPlayoff.current = false;
	}, [canGeneratePlayoffs, playoffMatches.length]);

	useEffect(() => {
		if (!user?.id) return;
		const term = inviteQuery.trim();
		if (!term) {
			setInviteOptions([]);
			setSelectedInviteUserId("");
			return;
		}
		const timer = window.setTimeout(() => {
			void searchProfilesByUsername(term, user.id)
				.then((data) => {
					setInviteOptions(data);
					const exactMatch = data.find((option) => option.username.toLowerCase() === term.toLowerCase());
					setSelectedInviteUserId(exactMatch?.id ?? "");
				})
				.catch((error) => toast.error((error as Error).message));
		}, 250);
		return () => window.clearTimeout(timer);
	}, [inviteQuery, user?.id]);

	const onInvite = async () => {
		if (!id || !isHostOrAdmin) return;
		const pickedOption =
			inviteOptions.find((item) => item.id === selectedInviteUserId) ??
			inviteOptions.find((item) => item.username.toLowerCase() === inviteQuery.trim().toLowerCase());
		if (!pickedOption) {
			toast.warning("Select a valid registered user.");
			return;
		}
		setSaving(true);
		try {
			await inviteMember(id, pickedOption.id);
			await createParticipant(id, {
				userId: pickedOption.id,
				displayName: pickedOption.username + (pickedOption.id === tournament?.created_by ? " (Host)" : ""),
			});
			await loadAll();
			setInviteQuery("");
			setInviteOptions([]);
			setSelectedInviteUserId("");
			toast.success("Member invited.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onAddGuest = async () => {
		if (!id || !newGuestName.trim() || !isHostOrAdmin) return;
		if (participants.length >= slots) {
			toast.warning("No empty slots available.");
			return;
		}
		setSaving(true);
		try {
			const guestName = newGuestName.trim();
			const guest = await addTournamentGuest(id, guestName);
			await createParticipant(id, { guestId: guest.id, displayName: `${guestName} (Guest)` });
			await loadAll();
			setNewGuestName("");
			toast.success("Guest added to participant list.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onSaveResult = async (matchId: string) => {
		const draft = resultDrafts[matchId] ?? defaultResult;
		setSaving(true);
		try {
			await upsertMatchResult(
				matchId,
				Number(draft.home_score),
				Number(draft.away_score),
				Number(draft.home_shots),
				Number(draft.away_shots),
				draft.decision,
			);
			await loadAll();
			toast.success("Result saved.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onLockResult = async (matchId: string) => {
		setSaving(true);
		try {
			await lockMatchResult(matchId);
			await loadAll();
			toast.success("Result locked.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onRandomizeTeam = async (participantId: string) => {
		const filterTier = participantFilters[participantId] ?? "ALL";
		const available = (teamsByTier[filterTier] ?? teams).filter((team) => !assignedTeams.has(team.id));
		if (available.length === 0) return toast.error("No unassigned teams left in pool.");
		const pick = available[Math.floor(Math.random() * available.length)];
		const pickId = pick?.id;
		if (!pickId) return;
		await updateParticipant(participantId, pickId);
		await loadAll();
	};

	const onClearParticipant = async (participant: TournamentParticipant) => {
		if (!isHostOrAdmin) return;
		setSaving(true);
		try {
			await removeParticipant(participant.id);
			setEditingParticipantIds((previous) => {
				const next = new Set(previous);
				next.delete(participant.id);
				return next;
			});
			await loadAll();
			toast.success("Participant slot cleared.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading tournament...</div>;
	if (!tournament) return <div className="p-6 text-sm text-muted-foreground">Tournament not found.</div>;

	const standingsByGroup = standings.reduce<Record<string, GroupStanding[]>>((acc, item) => {
		acc[item.group_code] ??= [];
		acc[item.group_code].push(item);
		return acc;
	}, {});
	const winners = playoffMatches.filter((match) => match.bracket_type === "WINNERS");
	const losers = playoffMatches.filter((match) => match.bracket_type === "LOSERS");

	return (
		<div className="space-y-6 p-4 md:p-6">
			<div>
				<h1 className="text-2xl font-semibold">{tournament.name}</h1>
				<p className="text-sm text-muted-foreground">
					Preset: {tournament.preset_id} • Team pool: {tournament.team_pool} • Slots: {tournament.default_participants}
				</p>
			</div>

			<Tabs defaultValue="setup">
				<TabsList>
					<TabsTrigger value="setup">Setup</TabsTrigger>
					{tournament.preset_id === "full_tournament" && (
						<TabsTrigger value="group" disabled={!groupStageAvailable}>
							Group stage
						</TabsTrigger>
					)}
					<TabsTrigger value="playoff" disabled={!playoffAvailable}>
						Playoff bracket
					</TabsTrigger>
				</TabsList>

				<TabsContent value="setup" className="space-y-4">
					<section className="space-y-3 rounded-lg border p-4">
						<h2 className="text-lg font-semibold">Participants</h2>
						<p className="text-sm text-muted-foreground">Fill all slots, pick unique teams, then lock each row.</p>
						<div className="overflow-x-auto">
							<table className="w-full min-w-[700px] text-sm">
								<thead>
									<tr className="border-b">
										<th className="px-2 py-2 text-left">Participant</th>
										<th className="px-2 py-2 text-left">Filter</th>
										<th className="px-2 py-2 text-left">Team</th>
										<th className="px-2 py-2 text-left">Stats</th>
										<th className="px-2 py-2 text-left">Actions</th>
									</tr>
								</thead>
								<tbody>
									{displayParticipants.map((participant) => (
										<tr key={participant.id} className="border-b">
											<td className="px-2 py-2">{participant.display_name}</td>
											<td className="px-2 py-2">
												<select
													className="h-9 rounded-md border px-2"
													disabled={participant.locked && !editingParticipantIds.has(participant.id)}
													value={participantFilters[participant.id] ?? "ALL"}
													onChange={(event) =>
														setParticipantFilters((previous) => ({
															...previous,
															[participant.id]: event.target.value as Team["ovr_tier"] | "ALL",
														}))
													}
												>
													<option value="ALL">All</option>
													<option value="Top 5">Top 5</option>
													<option value="Top 10">Top 10</option>
													<option value="Middle Tier">Middle Tier</option>
													<option value="Bottom Tier">Bottom Tier</option>
												</select>
											</td>
											<td className="px-2 py-2">
												<select
													className="h-9 rounded-md border px-2"
													disabled={participant.locked && !editingParticipantIds.has(participant.id)}
													value={participant.team_id ?? ""}
													onChange={(event) => {
														void updateParticipant(participant.id, event.target.value || null).then(async () => {
															if (editingParticipantIds.has(participant.id)) {
																await lockParticipant(participant.id);
																setEditingParticipantIds((previous) => {
																	const next = new Set(previous);
																	next.delete(participant.id);
																	return next;
																});
															}
															await loadAll();
														});
													}}
												>
													<option value="">Select team</option>
													{(teamsByTier[participantFilters[participant.id] ?? "ALL"] ?? teams).map((team) => (
														<option
															key={team.id}
															value={team.id}
															disabled={assignedTeams.has(team.id) && participant.team_id !== team.id}
														>
															{team.name}
														</option>
													))}
												</select>
											</td>
											<td className="px-2 py-2 text-xs text-muted-foreground">
												{participant.team
													? `OVR: ${participant.team.overall}, OFF: ${participant.team.offense}, DEF: ${participant.team.defense}, GOA: ${participant.team.goalie}`
													: "-"}
											</td>
											<td className="flex gap-2 px-2 py-2">
												<Button size="sm" variant="outline" onClick={() => void onRandomizeTeam(participant.id)}>
													🎲 Team
												</Button>
												<Button
													size="sm"
													disabled={
														participant.locked || !participant.team_id || editingParticipantIds.has(participant.id)
													}
													onClick={() => void lockParticipant(participant.id).then(loadAll)}
												>
													{participant.locked ? "Locked" : "Lock in"}
												</Button>
												{participant.locked && isHostOrAdmin && (
													<Button
														size="sm"
														variant="outline"
														disabled={saving}
														onClick={() =>
															setEditingParticipantIds((previous) => {
																const next = new Set(previous);
																next.add(participant.id);
																return next;
															})
														}
													>
														Edit
													</Button>
												)}
												<Button
													size="icon"
													variant="ghost"
													disabled={saving}
													onClick={() => void onClearParticipant(participant)}
													title="Clear slot"
												>
													×
												</Button>
											</td>
										</tr>
									))}
									{placeholderRows.map((row) => (
										<tr key={row.id} className="border-b border-dashed bg-muted/20">
											<td className="px-2 py-3 text-sm text-muted-foreground">{row.label}</td>
											<td className="px-2 py-3 text-sm text-muted-foreground">-</td>
											<td className="px-2 py-3 text-sm text-muted-foreground">-</td>
											<td className="px-2 py-3 text-sm text-muted-foreground">-</td>
											<td className="px-2 py-3 text-sm text-muted-foreground">Waiting for participant</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{isHostOrAdmin && displayParticipants.length < slots && (
							<p className="text-xs text-muted-foreground">
								{slots - displayParticipants.length} unfilled slots remaining.
							</p>
						)}
						{isHostOrAdmin && displayParticipants.length < slots && (
							<div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
								<div className="space-y-2">
									<h4 className="font-medium">Invite registered user</h4>
									<div className="flex gap-2">
										<Input
											value={inviteQuery}
											onChange={(event) => {
												setInviteQuery(event.target.value);
												setSelectedInviteUserId("");
											}}
											placeholder="Search by nickname"
											list="invite-user-options"
										/>
										<Button disabled={saving || displayParticipants.length >= slots} onClick={() => void onInvite()}>
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
									<h4 className="font-medium">Guest</h4>
									<div className="flex gap-2">
										<Input
											value={newGuestName}
											onChange={(event) => setNewGuestName(event.target.value)}
											placeholder="Guest name"
										/>
										<Button onClick={() => void onAddGuest()}>Add</Button>
									</div>
									<p className="text-xs text-muted-foreground">Guest is added directly into participant slots.</p>
								</div>
							</div>
						)}
						{tournament.preset_id !== "playoffs_only" && allLockedWithTeams && groups.length === 0 && (
							<p className="text-sm text-muted-foreground">Generating groups and schedule automatically...</p>
						)}
						{tournament.preset_id === "playoffs_only" && allLockedWithTeams && playoffMatches.length === 0 && (
							<p className="text-sm text-muted-foreground">Generating playoff bracket automatically...</p>
						)}
					</section>
				</TabsContent>

				{tournament.preset_id !== "playoffs_only" && (
					<TabsContent value="group" className="space-y-4">
						{groups.length > 0 && (
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
														<th className="py-1 text-right">Points</th>
													</tr>
												</thead>
												<tbody>
													{(standingsByGroup[group.group_code] ?? []).map((row) => (
														<tr key={row.participant_id} className="border-b">
															<td className="py-1">
																<TeamPill
																	team={row.team_id ? teamById.get(row.team_id) : null}
																	fallback={row.display_name}
																/>
															</td>
															<td className="py-1 text-right">{row.points}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
								</div>
							</section>
						)}

						<MatchTable
							title="Group stage games"
							matches={groupMatches}
							saving={saving}
							resultDrafts={resultDrafts}
							setResultDrafts={setResultDrafts}
							onSaveResult={onSaveResult}
							onLockResult={onLockResult}
							isHostOrAdmin={isHostOrAdmin}
							userId={user?.id}
						/>
					</TabsContent>
				)}

				<TabsContent value="playoff" className="space-y-4">
					<section className="rounded-lg border p-4">
						<h2 className="text-lg font-semibold">Bracket view</h2>
						<div className="grid gap-4 md:grid-cols-2">
							<div>
								<h3 className="mb-2 font-medium">Winners bracket</h3>
								{winners.length === 0 ? (
									<p className="text-sm text-muted-foreground">Not generated yet.</p>
								) : (
									winners.map((match) => (
										<div key={match.id} className="mb-2 rounded border p-2 text-sm">
											R{match.round}:{" "}
											<TeamPill
												team={match.home_team_id ? teamById.get(match.home_team_id) : null}
												fallback={match.home_participant_name}
											/>{" "}
											vs{" "}
											<TeamPill
												team={match.away_team_id ? teamById.get(match.away_team_id) : null}
												fallback={match.away_participant_name}
											/>
											{match.home_participant_name === "BYE" || match.away_participant_name === "BYE" ? " (BYE)" : ""}
										</div>
									))
								)}
							</div>
							<div>
								<h3 className="mb-2 font-medium">Losers bracket</h3>
								{losers.length === 0 ? (
									<p className="text-sm text-muted-foreground">Not generated yet.</p>
								) : (
									losers.map((match) => (
										<div key={match.id} className="mb-2 rounded border p-2 text-sm">
											R{match.round}:{" "}
											<TeamPill
												team={match.home_team_id ? teamById.get(match.home_team_id) : null}
												fallback={match.home_participant_name}
											/>{" "}
											vs{" "}
											<TeamPill
												team={match.away_team_id ? teamById.get(match.away_team_id) : null}
												fallback={match.away_participant_name}
											/>
										</div>
									))
								)}
							</div>
						</div>
					</section>

					<MatchTable
						title="Playoff games"
						matches={playoffMatches}
						saving={saving}
						resultDrafts={resultDrafts}
						setResultDrafts={setResultDrafts}
						onSaveResult={onSaveResult}
						onLockResult={onLockResult}
						isHostOrAdmin={isHostOrAdmin}
						userId={user?.id}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
