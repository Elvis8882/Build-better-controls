import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createParticipant,
	type GroupStanding,
	generateGroupsAndMatches,
	generatePlayoffs,
	getTournament,
	inviteMember,
	listGroupStandings,
	listGroups,
	listMatchesWithResults,
	listParticipants,
	listTournamentGuests,
	listTournamentMembers,
	lockMatchResult,
	lockParticipant,
	type MatchParticipantDecision,
	type MatchWithResult,
	type ProfileOption,
	removeTournamentGuest,
	searchProfilesByUsername,
	type Tournament,
	type TournamentGuest,
	type TournamentMember,
	type TournamentParticipant,
	updateParticipant,
	upsertMatchResult,
} from "@/lib/db";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

const NHL_TEAMS = [
	"BOS",
	"BUF",
	"CAR",
	"CBJ",
	"DET",
	"FLA",
	"MTL",
	"NJD",
	"NYI",
	"NYR",
	"OTT",
	"PHI",
	"PIT",
	"TBL",
	"TOR",
	"WSH",
	"CHI",
	"COL",
	"DAL",
	"MIN",
	"NSH",
	"STL",
	"UTA",
	"WPG",
	"ANA",
	"CGY",
	"EDM",
	"LAK",
	"SJS",
	"SEA",
	"VAN",
	"VGK",
];
const INTL_TEAMS = [
	"CAN",
	"USA",
	"SWE",
	"FIN",
	"CZE",
	"SVK",
	"GER",
	"SUI",
	"LAT",
	"NOR",
	"DEN",
	"AUT",
	"FRA",
	"ITA",
	"GBR",
	"POL",
];

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
	const [guests, setGuests] = useState<TournamentGuest[]>([]);
	const [participants, setParticipants] = useState<TournamentParticipant[]>([]);
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

	const isAdmin = profile?.role === "admin";
	const hostMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && member.role === "host"),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(hostMembership);

	const teamPool = tournament?.team_pool ?? "NHL";
	const teams = teamPool === "INTL" ? INTL_TEAMS : NHL_TEAMS;
	const assignedTeams = new Set(participants.map((participant) => participant.team_id).filter(Boolean));
	const slots = tournament?.default_participants ?? 0;
	const allLockedWithTeams =
		participants.length === slots && participants.every((participant) => participant.locked && participant.team_id);
	const allGroupMatchesLocked = groupMatches.length > 0 && groupMatches.every((match) => match.result?.locked);

	const loadAll = useCallback(async () => {
		if (!id) return;
		try {
			setLoading(true);
			const [
				tournamentData,
				memberData,
				guestData,
				participantData,
				groupData,
				standingData,
				groupMatchData,
				playoffMatchData,
			] = await Promise.all([
				getTournament(id),
				listTournamentMembers(id),
				listTournamentGuests(id),
				listParticipants(id),
				listGroups(id),
				listGroupStandings(id),
				listMatchesWithResults(id, "GROUP"),
				listMatchesWithResults(id, "PLAYOFF"),
			]);
			setTournament(tournamentData);
			setMembers(memberData);
			setGuests(guestData);
			setParticipants(participantData);
			setGroups(groupData);
			setStandings(standingData);
			setGroupMatches(groupMatchData);
			setPlayoffMatches(playoffMatchData);
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

	useEffect(() => {
		void loadAll();
	}, [loadAll]);

	const runSearchProfiles = async () => {
		if (!user?.id) return;
		const data = await searchProfilesByUsername(inviteQuery, user.id);
		setInviteOptions(data);
		if (data.length > 0 && !selectedInviteUserId) setSelectedInviteUserId(data[0].id);
	};

	const onInvite = async () => {
		if (!id || !selectedInviteUserId || !isHostOrAdmin) return;
		setSaving(true);
		try {
			await inviteMember(id, selectedInviteUserId);
			await createParticipant(id, {
				userId: selectedInviteUserId,
				displayName: inviteOptions.find((item) => item.id === selectedInviteUserId)?.username ?? selectedInviteUserId,
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
		setSaving(true);
		try {
			await addTournamentGuest(id, newGuestName.trim());
			await loadAll();
			setNewGuestName("");
			toast.success("Guest added.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onAssignGuestToSlot = async (guestId: string) => {
		if (!id || !isHostOrAdmin) return;
		const guest = guests.find((item) => item.id === guestId);
		if (!guest) return;
		setSaving(true);
		try {
			await createParticipant(id, { guestId, displayName: `${guest.display_name} (Guest)` });
			await loadAll();
			toast.success("Guest assigned.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onDeleteGuest = async (guestId: string) => {
		if (!id || !isHostOrAdmin) return;
		setSaving(true);
		try {
			await removeTournamentGuest(id, guestId);
			await loadAll();
			toast.success("Guest removed.");
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
		const available = teams.filter((team) => !assignedTeams.has(team));
		if (available.length === 0) return toast.error("No unassigned teams left in pool.");
		const pick = available[Math.floor(Math.random() * available.length)];
		await updateParticipant(participantId, pick);
		await loadAll();
	};

	const onGenerateGroups = async () => {
		if (!id || !isHostOrAdmin) return;
		setSaving(true);
		try {
			await generateGroupsAndMatches(id);
			await loadAll();
			toast.success("Groups and group schedule generated.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onGeneratePlayoffs = async () => {
		if (!id || !isHostOrAdmin) return;
		setSaving(true);
		try {
			await generatePlayoffs(id);
			await loadAll();
			toast.success("Playoff bracket generated.");
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

			<Tabs defaultValue={tournament.preset_id === "playoffs_only" ? "playoff" : "group"}>
				<TabsList>
					{tournament.preset_id !== "playoffs_only" && <TabsTrigger value="group">Group stage</TabsTrigger>}
					<TabsTrigger value="playoff">Playoff bracket</TabsTrigger>
				</TabsList>

				<TabsContent value="group" className="space-y-4">
					<section className="space-y-3 rounded-lg border p-4">
						<h2 className="text-lg font-semibold">Participant + team assignment</h2>
						<p className="text-sm text-muted-foreground">Fill all slots, pick unique teams, then lock each row.</p>
						<div className="overflow-x-auto">
							<table className="w-full min-w-[700px] text-sm">
								<thead>
									<tr className="border-b">
										<th className="px-2 py-2 text-left">Participant</th>
										<th className="px-2 py-2 text-left">Team</th>
										<th className="px-2 py-2 text-left">Actions</th>
									</tr>
								</thead>
								<tbody>
									{participants.map((participant) => (
										<tr key={participant.id} className="border-b">
											<td className="px-2 py-2">{participant.display_name}</td>
											<td className="px-2 py-2">
												<select
													className="h-9 rounded-md border px-2"
													disabled={participant.locked && !isHostOrAdmin}
													value={participant.team_id ?? ""}
													onChange={(event) =>
														void updateParticipant(participant.id, event.target.value || null).then(loadAll)
													}
												>
													<option value="">Select team</option>
													{teams.map((team) => (
														<option
															key={team}
															value={team}
															disabled={assignedTeams.has(team) && participant.team_id !== team}
														>
															{team}
														</option>
													))}
												</select>
											</td>
											<td className="flex gap-2 px-2 py-2">
												<Button size="sm" variant="outline" onClick={() => void onRandomizeTeam(participant.id)}>
													🎲 Team
												</Button>
												<Button
													size="sm"
													disabled={participant.locked || !participant.team_id}
													onClick={() => void lockParticipant(participant.id).then(loadAll)}
												>
													{participant.locked ? "Locked" : "Lock in"}
												</Button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{isHostOrAdmin && participants.length < slots && (
							<p className="text-xs text-muted-foreground">{slots - participants.length} unfilled slots remaining.</p>
						)}
						{isHostOrAdmin && (
							<div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
								<div className="space-y-2">
									<h4 className="font-medium">Invite registered user</h4>
									<div className="flex gap-2">
										<Input value={inviteQuery} onChange={(event) => setInviteQuery(event.target.value)} />
										<Button variant="outline" onClick={() => void runSearchProfiles()}>
											Search
										</Button>
									</div>
									<select
										className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
										value={selectedInviteUserId}
										onChange={(event) => setSelectedInviteUserId(event.target.value)}
									>
										<option value="">Select user</option>
										{inviteOptions.map((option) => (
											<option key={option.id} value={option.id}>
												{option.username}
											</option>
										))}
									</select>
									<Button
										disabled={saving || !selectedInviteUserId || participants.length >= slots}
										onClick={() => void onInvite()}
									>
										Invite + assign slot
									</Button>
								</div>
								<div className="space-y-2">
									<h4 className="font-medium">Guests</h4>
									<div className="flex gap-2">
										<Input
											value={newGuestName}
											onChange={(event) => setNewGuestName(event.target.value)}
											placeholder="Guest name"
										/>
										<Button onClick={() => void onAddGuest()}>Add</Button>
									</div>
									<ul className="space-y-2">
										{guests.map((guest) => (
											<li key={guest.id} className="flex items-center justify-between rounded border px-2 py-1">
												<span>{guest.display_name}</span>
												<div className="flex gap-2">
													<Button
														size="sm"
														variant="outline"
														disabled={participants.length >= slots}
														onClick={() => void onAssignGuestToSlot(guest.id)}
													>
														Assign
													</Button>
													<Button size="sm" variant="outline" onClick={() => void onDeleteGuest(guest.id)}>
														Delete
													</Button>
												</div>
											</li>
										))}
									</ul>
								</div>
							</div>
						)}
						<div className="flex gap-2">
							<Button
								disabled={!allLockedWithTeams || groups.length > 0 || saving}
								onClick={() => void onGenerateGroups()}
							>
								Generate groups + group schedule
							</Button>
							{allLockedWithTeams && groups.length === 0 && (
								<p className="text-sm text-muted-foreground">All rows locked. Generate groups to continue.</p>
							)}
						</div>
					</section>

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
														<td className="py-1">{row.team_id ?? row.display_name}</td>
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
					{isHostOrAdmin && (
						<Button
							disabled={!allGroupMatchesLocked || playoffMatches.length > 0 || saving}
							onClick={() => void onGeneratePlayoffs()}
						>
							Generate playoff bracket
						</Button>
					)}
				</TabsContent>

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
											R{match.round}: {match.home_participant_name} vs {match.away_participant_name}
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
											R{match.round}: {match.home_participant_name} vs {match.away_participant_name}
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
