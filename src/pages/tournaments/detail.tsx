import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createParticipant,
	fetchTeamsByPool,
	ensurePlayoffBracket,
	type GroupStanding,
	generateGroupsAndMatches,
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
	updateTournamentStatus,
	upsertMatchResult,
} from "@/lib/db";
import {
	GroupMatchesTable,
	GroupStagePage,
	GroupStandings,
	ParticipantsTable,
} from "@/pages/tournaments/components/group-stage-page";
import {
	BracketDiagram,
	PlayoffBracketPage,
	PlayoffMatchesTable,
} from "@/pages/tournaments/components/playoff-bracket-page";
import { Button } from "@/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

type EditableResult = {
	home_score: string;
	away_score: string;
	home_shots: string;
	away_shots: string;
	decision: MatchParticipantDecision;
};

type ParsedResult = {
	homeScore: number;
	awayScore: number;
	homeShots: number;
	awayShots: number;
	decision: MatchParticipantDecision;
};

type TeamFilter = "ALL" | Team["ovr_tier"];

const defaultResult: EditableResult = {
	home_score: "",
	away_score: "",
	home_shots: "",
	away_shots: "",
	decision: "R",
};

const isFullPreset = (presetId: Tournament["preset_id"]) =>
	presetId === "full_with_losers" || presetId === "full_no_losers";

const isMatchDisplayable = (match: MatchWithResult) => {
	const hasResult = Boolean(match.result);
	const hasHome = Boolean(match.home_participant_id);
	const hasAway = Boolean(match.away_participant_id);
	if (hasResult) return true;
	if (hasHome && hasAway) return true;
	if (!match.next_match_id) return hasHome || hasAway;
	return false;
};

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

export default function TournamentDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
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
	const [editingMatchIds, setEditingMatchIds] = useState<Set<string>>(new Set());
	const [activeTab, setActiveTab] = useState<"participants" | "group" | "playoff">("participants");

	const isAdmin = profile?.role === "admin";
	const hostMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && member.role === "host"),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(hostMembership);

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
	const assignedTeams = new Set(
		displayParticipants.map((participant) => participant.team_id).filter((teamId): teamId is string => Boolean(teamId)),
	);
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
	const allGroupMatchesLocked = groupMatches.length > 0 && groupMatches.every((match) => Boolean(match.result?.locked));
	const fullPreset = isFullPreset(tournament?.preset_id ?? null);
	const canGenerateGroups = fullPreset && allLockedWithTeams && groups.length === 0;
	const groupStageAvailable = fullPreset && (groups.length > 0 || groupMatches.length > 0);
	const playoffStageAvailable = fullPreset ? allGroupMatchesLocked : allLockedWithTeams;
	const anyPlayoffLocked = playoffMatches.some((match) => Boolean(match.result?.locked));
	const allPlayoffMatchesLockedByStage =
		playoffMatches.length > 0 &&
		playoffMatches.filter(isMatchDisplayable).every((match) => Boolean(match.result?.locked));
	const tournamentStarted = allLockedWithTeams && (fullPreset ? groupMatches.length > 0 : playoffMatches.length > 0);
	const tournamentCanClose = allPlayoffMatchesLockedByStage && (fullPreset ? allGroupMatchesLocked : true);

	useEffect(() => {
		if (!id) return;
		const segments = location.pathname.split("/").filter(Boolean);
		const lastSegment = segments[segments.length - 1];
		if (lastSegment === "participants") {
			setActiveTab("participants");
			return;
		}
		if (lastSegment === "group-stage") {
			if (!groupStageAvailable) {
				setActiveTab("participants");
				return;
			}
			setActiveTab("group");
			return;
		}
		if (lastSegment === "playoff-bracket") {
			if (!playoffStageAvailable) {
				setActiveTab("participants");
				return;
			}
			setActiveTab("playoff");
			return;
		}
		setActiveTab("participants");
	}, [id, location.pathname, groupStageAvailable, playoffStageAvailable]);

	const onTabChange = (nextTab: "participants" | "group" | "playoff") => {
		if (nextTab === "group" && !groupStageAvailable) return;
		if (nextTab === "playoff" && !playoffStageAvailable) return;
		setActiveTab(nextTab);
		if (!id) return;
		if (nextTab === "participants") {
			navigate(`/dashboard/tournaments/${id}/participants`);
			void refreshParticipantsSection();
			return;
		}
		if (nextTab === "group") {
			navigate(`/dashboard/tournaments/${id}/group-stage`);
			void refreshGroupStageSections();
			return;
		}
		navigate(`/dashboard/tournaments/${id}/playoff-bracket`);
		void refreshPlayoffSection();
	};

	const mergeResultDrafts = useCallback((matches: MatchWithResult[]) => {
		setResultDrafts((previous) => {
			const next = { ...previous };
			for (const match of matches) {
				next[match.id] = {
					home_score: match.result?.home_score != null ? String(match.result.home_score) : "",
					away_score: match.result?.away_score != null ? String(match.result.away_score) : "",
					home_shots: match.result?.home_shots != null ? String(match.result.home_shots) : "",
					away_shots: match.result?.away_shots != null ? String(match.result.away_shots) : "",
					decision: match.result?.decision ?? "R",
				};
			}
			return next;
		});
	}, []);

	const refreshGroupStageSections = useCallback(async () => {
		if (!id) return;
		const [standingData, groupMatchData] = await Promise.all([
			listGroupStandings(id),
			listMatchesWithResults(id, "GROUP"),
		]);
		setStandings(standingData);
		setGroupMatches(groupMatchData);
		mergeResultDrafts(groupMatchData);
	}, [id, mergeResultDrafts]);

	const refreshParticipantsSection = useCallback(async () => {
		if (!id) return;
		const participantData = await listParticipants(id);
		setParticipants(participantData);
	}, [id]);

	const refreshPlayoffSection = useCallback(async () => {
		if (!id) return;
		const playoffMatchData = await listMatchesWithResults(id, "PLAYOFF");
		setPlayoffMatches(playoffMatchData);
		mergeResultDrafts(playoffMatchData);
	}, [id, mergeResultDrafts]);

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
			mergeResultDrafts([...groupMatchData, ...playoffMatchData]);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [id, mergeResultDrafts]);

	useEffect(() => {
		void loadAll();
	}, [loadAll]);

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
		if (!id || activeTab !== "playoff" || anyPlayoffLocked || !playoffStageAvailable) return;
		setSaving(true);
		void ensurePlayoffBracket(id)
			.then(refreshPlayoffSection)
			.catch((error) => toast.error((error as Error).message))
			.finally(() => setSaving(false));
	}, [id, activeTab, anyPlayoffLocked, playoffStageAvailable, refreshPlayoffSection]);

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
			await refreshParticipantsSection();
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
			await refreshParticipantsSection();
			setNewGuestName("");
			toast.success("Guest added to participant list.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const parseResultDraft = (matchId: string): ParsedResult | null => {
		const draft = resultDrafts[matchId] ?? defaultResult;
		if ([draft.home_score, draft.away_score, draft.home_shots, draft.away_shots].some((value) => value.trim() === "")) {
			toast.warning("Fill in score and SOG for both teams before locking in.");
			return null;
		}

		const parsed = {
			homeScore: Number(draft.home_score),
			awayScore: Number(draft.away_score),
			homeShots: Number(draft.home_shots),
			awayShots: Number(draft.away_shots),
			decision: draft.decision,
		};

		if (
			[parsed.homeScore, parsed.awayScore, parsed.homeShots, parsed.awayShots].some(
				(value) => !Number.isFinite(value) || value < 0,
			)
		) {
			toast.warning("Scores and SOG must be non-negative numbers.");
			return null;
		}

		if (parsed.homeShots < parsed.homeScore || parsed.awayShots < parsed.awayScore) {
			toast.warning("SOG cannot be lower than score for either team.");
			return null;
		}

		if (parsed.homeScore === parsed.awayScore) {
			toast.warning("Games must end with a winner. Ties are not allowed.");
			return null;
		}

		return parsed;
	};

	const onLockResult = async (matchId: string) => {
		const parsed = parseResultDraft(matchId);
		if (!parsed) return;
		const isGroupMatch = groupMatches.some((match) => match.id === matchId);
		const isPlayoffMatch = playoffMatches.some((match) => match.id === matchId);

		setSaving(true);
		try {
			await upsertMatchResult(
				matchId,
				parsed.homeScore,
				parsed.awayScore,
				parsed.homeShots,
				parsed.awayShots,
				parsed.decision,
			);
			await lockMatchResult(matchId);
			setEditingMatchIds((previous) => {
				const next = new Set(previous);
				next.delete(matchId);
				return next;
			});
			if (isGroupMatch) {
				if (activeTab === "group") {
					await refreshGroupStageSections();
				} else if (activeTab === "playoff" && !anyPlayoffLocked && id) {
					await ensurePlayoffBracket(id);
					await refreshPlayoffSection();
				}
			}
			if (isPlayoffMatch) {
				if (id) await ensurePlayoffBracket(id);
				await refreshPlayoffSection();
			}
			toast.success("Result locked.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const canEditGroupMatch = (match: MatchWithResult) => {
		if (isHostOrAdmin) return !match.result?.locked || editingMatchIds.has(match.id);
		if (!user?.id || match.result?.locked) return false;
		const myParticipant = participants.find((participant) => participant.user_id === user.id);
		if (!myParticipant) return false;
		return match.home_participant_id === myParticipant.id || match.away_participant_id === myParticipant.id;
	};

	const canEditPlayoffMatch = (match: MatchWithResult) => {
		if (isHostOrAdmin) return !match.result?.locked || editingMatchIds.has(match.id);
		if (!user?.id || match.result?.locked) return false;
		const myParticipant = participants.find((participant) => participant.user_id === user.id);
		if (!myParticipant) return false;
		return match.home_participant_id === myParticipant.id || match.away_participant_id === myParticipant.id;
	};

	const onRandomizeTeam = async (participant: TournamentParticipant, teamFilter: TeamFilter) => {
		const available = teams.filter(
			(team) => !assignedTeams.has(team.id) && (teamFilter === "ALL" || team.ovr_tier === teamFilter),
		);
		if (available.length === 0) {
			toast.error("No unassigned teams left for the selected filter.");
			return;
		}
		const pick = available[Math.floor(Math.random() * available.length)];
		const pickId = pick?.id;
		if (!pickId) return;
		setSaving(true);
		try {
			await updateParticipant(participant.id, pickId);
			await refreshParticipantsSection();
		} finally {
			setSaving(false);
		}
	};

	const onParticipantTeamChange = async (participant: TournamentParticipant, teamId: string | null) => {
		setSaving(true);
		try {
			await updateParticipant(participant.id, teamId);
			if (editingParticipantIds.has(participant.id)) {
				await lockParticipant(participant.id);
				setEditingParticipantIds((previous) => {
					const next = new Set(previous);
					next.delete(participant.id);
					return next;
				});
			}
			await refreshParticipantsSection();
		} finally {
			setSaving(false);
		}
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
			await refreshParticipantsSection();
			toast.success("Participant slot cleared.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	useEffect(() => {
		if (
			!id ||
			!isHostOrAdmin ||
			!tournamentStarted ||
			tournament?.status === "Ongoing" ||
			tournament?.status === "Closed"
		)
			return;
		void updateTournamentStatus(id, "Ongoing")
			.then(loadAll)
			.catch((error) => toast.error((error as Error).message));
	}, [id, isHostOrAdmin, tournamentStarted, tournament?.status, loadAll]);

	const onCloseTournament = async () => {
		if (!id || !isHostOrAdmin || !tournamentCanClose || tournament?.status === "Closed") return;
		setSaving(true);
		try {
			await updateTournamentStatus(id, "Closed");
			await loadAll();
			toast.success("Tournament closed.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading tournament...</div>;
	if (!tournament) return <div className="p-6 text-sm text-muted-foreground">Tournament not found.</div>;

	const winnersBracketMatchesRaw = playoffMatches
		.filter((match) => match.bracket_type === "WINNERS")
		.sort((left, right) => left.round - right.round || (left.bracket_slot ?? 0) - (right.bracket_slot ?? 0));
	const winnersBracketMatches = winnersBracketMatchesRaw.filter(isMatchDisplayable);
	const placementBracketMatchesRaw = playoffMatches
		.filter((match) => match.bracket_type === "LOSERS")
		.sort((left, right) => left.round - right.round || (left.bracket_slot ?? 0) - (right.bracket_slot ?? 0));
	const placementBracketMatches = placementBracketMatchesRaw.filter(isMatchDisplayable);
	const shouldShowPlacementBracket =
		tournament.preset_id === "full_with_losers" || placementBracketMatchesRaw.length > 0;
	const allPlayoffMatchesLocked =
		(winnersBracketMatches.length > 0 || placementBracketMatches.length > 0) &&
		[...winnersBracketMatches, ...placementBracketMatches].every((match) => Boolean(match.result?.locked));

	const standingByParticipantId = new Map<string, number>();
	if (allPlayoffMatchesLocked) {
		const winnersFinal = [...winnersBracketMatches].sort((a, b) => b.round - a.round)[0];
		if (winnersFinal) {
			const winner = resolveWinner(winnersFinal);
			const loser = resolveLoser(winnersFinal);
			if (winner) standingByParticipantId.set(winner, 1);
			if (loser) standingByParticipantId.set(loser, 2);
		}

		const placementFinal = [...placementBracketMatches].sort(
			(a, b) => b.round - a.round || (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0),
		)[0];
		if (placementFinal) {
			const winner = resolveWinner(placementFinal);
			const loser = resolveLoser(placementFinal);
			if (winner) standingByParticipantId.set(winner, 3);
			if (loser) standingByParticipantId.set(loser, 4);
		}

		const unresolvedIds = new Set<string>();
		for (const match of [...winnersBracketMatches, ...placementBracketMatches]) {
			if (match.home_participant_id && !standingByParticipantId.has(match.home_participant_id)) {
				unresolvedIds.add(match.home_participant_id);
			}
			if (match.away_participant_id && !standingByParticipantId.has(match.away_participant_id)) {
				unresolvedIds.add(match.away_participant_id);
			}
		}

		let nextStanding = standingByParticipantId.size + 1;
		for (const participantId of unresolvedIds) {
			standingByParticipantId.set(participantId, nextStanding);
			nextStanding += 1;
		}
	}

	const medalByParticipantId = new Map<string, "gold" | "silver" | "bronze">();
	for (const [participantId, standing] of standingByParticipantId.entries()) {
		if (standing === 1) medalByParticipantId.set(participantId, "gold");
		if (standing === 2) medalByParticipantId.set(participantId, "silver");
		if (standing === 3) medalByParticipantId.set(participantId, "bronze");
	}

	return (
		<div className="space-y-6 p-4 md:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold">{tournament.name}</h1>
					<p className="text-sm text-muted-foreground">
						Type: {tournament.preset_id === "playoffs_only" ? "Playoff only" : "Full tournament"} • Team pool:{" "}
						{tournament.team_pool} • Slots: {tournament.default_participants} • Status: {tournament.status ?? "Draft"}
					</p>
				</div>
				{isHostOrAdmin && tournament.status !== "Closed" && (
					<Button disabled={!tournamentCanClose || saving} onClick={() => void onCloseTournament()}>
						Close tournament
					</Button>
				)}
			</div>

			<Tabs value={activeTab} onValueChange={(value) => onTabChange(value as "participants" | "group" | "playoff")}>
				<TabsList>
					<TabsTrigger value="participants">Participants</TabsTrigger>
					{fullPreset && (
						<TabsTrigger value="group" disabled={!groupStageAvailable}>
							Group Stage
						</TabsTrigger>
					)}
					<TabsTrigger value="playoff" disabled={!playoffStageAvailable}>
						Playoff sheet
					</TabsTrigger>
				</TabsList>

				<TabsContent value="participants" className="space-y-4">
					<ParticipantsTable
						tournament={tournament}
						participants={displayParticipants}
						placeholderRows={placeholderRows}
						teams={teams}
						assignedTeams={assignedTeams}
						saving={saving}
						isHostOrAdmin={isHostOrAdmin}
						editingParticipantIds={editingParticipantIds}
						inviteQuery={inviteQuery}
						inviteOptions={inviteOptions}
						newGuestName={newGuestName}
						onInviteQueryChange={(value) => {
							setInviteQuery(value);
							setSelectedInviteUserId("");
						}}
						onNewGuestNameChange={setNewGuestName}
						onInvite={onInvite}
						onAddGuest={onAddGuest}
						onTeamChange={onParticipantTeamChange}
						onRandomizeTeam={onRandomizeTeam}
						onLockParticipant={async (participantId) => {
							setSaving(true);
							try {
								await lockParticipant(participantId);
								setEditingParticipantIds((previous) => {
									const next = new Set(previous);
									next.delete(participantId);
									return next;
								});
								await refreshParticipantsSection();
							} catch (error) {
								toast.error((error as Error).message);
							} finally {
								setSaving(false);
							}
						}}
						onEditParticipant={(participantId) =>
							setEditingParticipantIds((previous) => new Set(previous).add(participantId))
						}
						onClearParticipant={onClearParticipant}
					/>
					{!allLockedWithTeams && (
						<p className="text-sm text-muted-foreground">Waiting for all participants to lock teams.</p>
					)}
				</TabsContent>

				{fullPreset && (
					<TabsContent value="group" className="space-y-4">
						<GroupStagePage
							standingsTable={
								<GroupStandings
									groups={groups}
									standings={standings}
									teamById={teamById}
									showPlacement={allGroupMatchesLocked}
									groupMatches={groupMatches}
								/>
							}
							matchesTable={
								<GroupMatchesTable
									matches={groupMatches}
									teamById={teamById}
									resultDrafts={resultDrafts}
									saving={saving}
									canEditMatch={canEditGroupMatch}
									onResultDraftChange={(matchId, next) =>
										setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
									}
									onLockResult={onLockResult}
									onEditResult={
										isHostOrAdmin
											? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
											: undefined
									}
								/>
							}
						/>
						{!groupStageAvailable && (
							<p className="text-sm text-muted-foreground">
								Group Stage unlocks after all teams are locked and groups are generated.
							</p>
						)}
						{fullPreset && allLockedWithTeams && groups.length === 0 && (
							<p className="text-sm text-muted-foreground">Generating groups...</p>
						)}
						{allGroupMatchesLocked && <p className="text-sm text-muted-foreground">Group stage complete.</p>}
					</TabsContent>
				)}

				<TabsContent value="playoff" className="space-y-4">
					<PlayoffBracketPage
						banner={
							fullPreset
								? anyPlayoffLocked
									? "Bracket frozen"
									: "Bracket can update until first playoff game is locked"
								: anyPlayoffLocked
									? "Bracket frozen"
									: undefined
						}
						diagram={
							<BracketDiagram
								title="Winners bracket"
								matches={winnersBracketMatchesRaw}
								teamById={teamById}
								standingByParticipantId={standingByParticipantId}
								medalByParticipantId={medalByParticipantId}
							/>
						}
						table={
							<PlayoffMatchesTable
								title="Winners bracket matches"
								matches={winnersBracketMatches}
								teamById={teamById}
								resultDrafts={resultDrafts}
								saving={saving}
								canEditMatch={canEditPlayoffMatch}
								onResultDraftChange={(matchId, next) =>
									setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
								}
								onLockResult={onLockResult}
								onEditResult={
									isHostOrAdmin
										? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
										: undefined
								}
								standingByParticipantId={standingByParticipantId}
								medalByParticipantId={medalByParticipantId}
							/>
						}
						placementDiagram={
							shouldShowPlacementBracket ? (
								<BracketDiagram
									title="Placement bracket"
									matches={placementBracketMatchesRaw}
									teamById={teamById}
									standingByParticipantId={standingByParticipantId}
									medalByParticipantId={medalByParticipantId}
								/>
							) : undefined
						}
						placementTable={
							shouldShowPlacementBracket ? (
								<PlayoffMatchesTable
									title="Placement bracket matches"
									matches={placementBracketMatches}
									teamById={teamById}
									resultDrafts={resultDrafts}
									saving={saving}
									canEditMatch={canEditPlayoffMatch}
									onResultDraftChange={(matchId, next) =>
										setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
									}
									onLockResult={onLockResult}
									onEditResult={
										isHostOrAdmin
											? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
											: undefined
									}
									standingByParticipantId={standingByParticipantId}
									medalByParticipantId={medalByParticipantId}
								/>
							) : undefined
						}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
