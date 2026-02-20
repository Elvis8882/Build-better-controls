import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createParticipant,
	ensurePlayoffBracket,
	fetchTeamsByPool,
	type FriendProfile,
	type GroupStanding,
	generateGroupsAndMatches,
	getTournament,
	listFriends,
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
	type Team,
	type Tournament,
	type TournamentMember,
	type TournamentParticipant,
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

const getPresetTypeLabel = (presetId: Tournament["preset_id"]): string => {
	if (presetId === "playoffs_only") return "Playoff only (without loser bracket)";
	if (presetId === "full_with_losers") return "Full tournament (with loser bracket)";
	if (presetId === "full_no_losers") return "Full tournament (without loser bracket)";
	return "Tournament";
};

const isSkippedPlayoffMatch = (match: MatchWithResult) => {
	if (match.result?.locked) return false;
	const hasHome = Boolean(match.home_participant_id);
	const hasAway = Boolean(match.away_participant_id);
	return hasHome !== hasAway;
};

const isMatchDisplayable = (match: MatchWithResult) => {
	if (isSkippedPlayoffMatch(match)) return false;
	const hasResult = Boolean(match.result);
	const hasHome = Boolean(match.home_participant_id);
	const hasAway = Boolean(match.away_participant_id);
	if (hasResult) return true;
	if (!hasHome && !hasAway) return true;
	return hasHome && hasAway;
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
	const [friends, setFriends] = useState<FriendProfile[]>([]);
	const [selectedFriendId, setSelectedFriendId] = useState("");
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

	useEffect(() => {
		if (!user?.id || !isHostOrAdmin) return;
		void listFriends(user.id)
			.then(setFriends)
			.catch((error) => toast.error((error as Error).message));
	}, [user?.id, isHostOrAdmin]);

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
	const lockedPlayoffMatchIds = useMemo(
		() => new Set(playoffMatches.filter((match) => Boolean(match.result?.locked)).map((match) => match.id)),
		[playoffMatches],
	);
	const hasLockedDescendantByMatchId = useMemo(() => {
		const childrenByMatchId = new Map<string, string[]>();
		for (const match of playoffMatches) {
			if (!match.next_match_id) continue;
			const items = childrenByMatchId.get(match.id) ?? [];
			items.push(match.next_match_id);
			childrenByMatchId.set(match.id, items);
		}
		const memo = new Map<string, boolean>();
		const visit = (matchId: string): boolean => {
			if (memo.has(matchId)) return memo.get(matchId) ?? false;
			const descendants = childrenByMatchId.get(matchId) ?? [];
			for (const descendantId of descendants) {
				if (lockedPlayoffMatchIds.has(descendantId) || visit(descendantId)) {
					memo.set(matchId, true);
					return true;
				}
			}
			memo.set(matchId, false);
			return false;
		};
		for (const match of playoffMatches) visit(match.id);
		return memo;
	}, [playoffMatches, lockedPlayoffMatchIds]);
	const allPlayoffMatchesLockedByStage =
		playoffMatches.length > 0 &&
		playoffMatches.filter(isMatchDisplayable).every((match) => Boolean(match.result?.locked));
	const tournamentStarted = allLockedWithTeams && (fullPreset ? groupMatches.length > 0 : playoffMatches.length > 0);
	const tournamentCanClose = allPlayoffMatchesLockedByStage && (fullPreset ? allGroupMatchesLocked : true);
	const tournamentClosed = tournament?.status === "Closed";
	const participantFieldsLocked = tournamentClosed || (fullPreset ? groupStageAvailable : playoffMatches.length > 0);
	const groupStageEditingLocked = tournamentClosed || anyPlayoffLocked;

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
		if (!id) return;

		const refreshActiveTabData = () => {
			if (document.visibilityState !== "visible") return;
			if (activeTab === "participants") {
				void refreshParticipantsSection();
				return;
			}
			if (activeTab === "group") {
				void refreshGroupStageSections();
				return;
			}
			void refreshPlayoffSection();
		};

		document.addEventListener("visibilitychange", refreshActiveTabData);
		window.addEventListener("focus", refreshActiveTabData);

		return () => {
			document.removeEventListener("visibilitychange", refreshActiveTabData);
			window.removeEventListener("focus", refreshActiveTabData);
		};
	}, [id, activeTab, refreshParticipantsSection, refreshGroupStageSections, refreshPlayoffSection]);

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
		const alreadyMember = members.some((member) => member.user_id === pickedOption.id);
		const alreadyParticipant = participants.some((participant) => participant.user_id === pickedOption.id);
		if (alreadyParticipant) {
			toast.warning("User is already in the participant list.");
			return;
		}
		setSaving(true);
		try {
			if (!alreadyMember) {
				await inviteMember(id, pickedOption.id);
			}
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
		const guestName = newGuestName.trim();
		const normalizedGuestName = guestName.toLocaleLowerCase();
		const duplicateGuestNameExists = participants.some((participant) => {
			if (!participant.guest_id) return false;
			const baseName = participant.display_name
				.replace(/\s*\(Guest\)$/i, "")
				.trim()
				.toLocaleLowerCase();
			return baseName === normalizedGuestName;
		});
		if (duplicateGuestNameExists) {
			toast.warning("Guest name already exists in this tournament.");
			return;
		}
		setSaving(true);
		try {
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

	const onInviteFriend = async () => {
		if (!id || !isHostOrAdmin) return;
		if (!selectedFriendId) {
			toast.warning("Select a friend to invite.");
			return;
		}
		const pickedFriend = inviteableFriends.find((friend) => friend.id === selectedFriendId);
		if (!pickedFriend) {
			toast.warning("Selected friend is already invited or no longer available.");
			return;
		}
		const alreadyMember = members.some((member) => member.user_id === pickedFriend.id);
		const alreadyParticipant = participants.some((participant) => participant.user_id === pickedFriend.id);
		if (alreadyParticipant) {
			toast.warning("Friend is already in the participant list.");
			return;
		}
		setSaving(true);
		try {
			if (!alreadyMember) {
				await inviteMember(id, pickedFriend.id);
			}
			await createParticipant(id, {
				userId: pickedFriend.id,
				displayName: pickedFriend.username + (pickedFriend.id === tournament?.created_by ? " (Host)" : ""),
			});
			setSelectedFriendId("");
			await refreshParticipantsSection();
			toast.success("Friend invited to tournament.");
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
		if (groupStageEditingLocked) return false;
		if (isHostOrAdmin) return !match.result?.locked || editingMatchIds.has(match.id);
		if (!user?.id || match.result?.locked) return false;
		const myParticipant = participants.find((participant) => participant.user_id === user.id);
		if (!myParticipant) return false;
		return match.home_participant_id === myParticipant.id || match.away_participant_id === myParticipant.id;
	};

	const canEditPlayoffMatch = (match: MatchWithResult) => {
		if (tournamentClosed) return false;
		const matchLocked = Boolean(match.result?.locked);
		const hasLockedDescendant = hasLockedDescendantByMatchId.get(match.id) ?? false;
		if (isHostOrAdmin) {
			if (!matchLocked) return true;
			if (hasLockedDescendant) return false;
			return editingMatchIds.has(match.id);
		}
		if (!user?.id || matchLocked || hasLockedDescendant) return false;
		const myParticipant = participants.find((participant) => participant.user_id === user.id);
		if (!myParticipant) return false;
		return match.home_participant_id === myParticipant.id || match.away_participant_id === myParticipant.id;
	};

	const canEnableEditPlayoffResult = (match: MatchWithResult) => {
		if (tournamentClosed || !isHostOrAdmin || !match.result?.locked) return false;
		const hasLockedDescendant = hasLockedDescendantByMatchId.get(match.id) ?? false;
		return !hasLockedDescendant;
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
	const inviteableFriends = friends.filter(
		(friend) =>
			!members.some((member) => member.user_id === friend.id) &&
			!participants.some((participant) => participant.user_id === friend.id),
	);

	const standingByParticipantId = new Map<string, number>();
	const playoffStatsByParticipantId = new Map<string, { goalsFor: number; goalsAgainst: number; goalDiff: number }>();
	for (const match of [...winnersBracketMatches, ...placementBracketMatches]) {
		if (!match.result?.locked || !match.home_participant_id || !match.away_participant_id) continue;
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

	const winnersFinal = [...winnersBracketMatches].sort((a, b) => b.round - a.round)[0];
	if (winnersFinal?.result?.locked) {
		const winner = resolveWinner(winnersFinal);
		const loser = resolveLoser(winnersFinal);
		if (winner) standingByParticipantId.set(winner, 1);
		if (loser) standingByParticipantId.set(loser, 2);
	}

	const placementFinalRound = placementBracketMatches.reduce((maxRound, match) => {
		if (!match.result?.locked) return maxRound;
		return Math.max(maxRound, match.round ?? 0);
	}, 0);
	const thirdPlaceMatch =
		[...placementBracketMatches]
			.filter(
				(match) =>
					Boolean(match.result?.locked) &&
					(match.round ?? 0) === placementFinalRound &&
					(match.bracket_slot ?? 1) === 1,
			)
			.sort((a, b) => (a.id > b.id ? 1 : -1))[0] ??
		[...placementBracketMatches]
			.filter((match) => Boolean(match.result?.locked) && (match.round ?? 0) === placementFinalRound)
			.sort((a, b) => (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0))[0];
	if (thirdPlaceMatch) {
		const bronzeWinner = resolveWinner(thirdPlaceMatch);
		const bronzeLoser = resolveLoser(thirdPlaceMatch);
		if (bronzeWinner && !standingByParticipantId.has(bronzeWinner)) standingByParticipantId.set(bronzeWinner, 3);
		if (bronzeLoser && !standingByParticipantId.has(bronzeLoser)) standingByParticipantId.set(bronzeLoser, 4);
	}

	if (allPlayoffMatchesLocked) {
		const unresolvedIds = new Set<string>();
		const eliminationByParticipantId = new Map<string, { bracketType: "WINNERS" | "LOSERS"; round: number }>();
		for (const match of [...winnersBracketMatches, ...placementBracketMatches]) {
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

		let nextStanding = standingByParticipantId.size + 1;
		for (const participantId of unresolvedRanked) {
			standingByParticipantId.set(participantId, nextStanding);
			nextStanding += 1;
		}
	}

	const placementRevealKeys = new Set<string>();
	if (allPlayoffMatchesLocked) {
		for (const match of [...winnersBracketMatchesRaw, ...placementBracketMatchesRaw]) {
			if (match.home_participant_id) placementRevealKeys.add(`${match.id}:HOME`);
			if (match.away_participant_id) placementRevealKeys.add(`${match.id}:AWAY`);
		}
	}

	const medalByParticipantId = new Map<string, "gold" | "silver" | "bronze">();
	for (const [participantId, standing] of standingByParticipantId.entries()) {
		if (standing === 1) medalByParticipantId.set(participantId, "gold");
		if (standing === 2) medalByParticipantId.set(participantId, "silver");
		if (standing === 3) medalByParticipantId.set(participantId, "bronze");
	}
	const finalStandings = [...standingByParticipantId.entries()]
		.map(([participantId, placement]) => {
			const participant = displayParticipants.find((row) => row.id === participantId);
			const team = participant?.team_id ? teamById.get(participant.team_id) : null;
			return { participantId, placement, name: team?.name ?? participant?.display_name ?? "Unknown" };
		})
		.sort((left, right) => left.placement - right.placement);

	return (
		<div className="space-y-6 p-4 md:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold">{tournament.name}</h1>
					<p className="text-sm text-muted-foreground">
						Type: {getPresetTypeLabel(tournament.preset_id)} • Team pool: {tournament.team_pool} • Slots:{" "}
						{tournament.default_participants} • Status: {tournament.status ?? "Draft"}
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
						participantFieldsLocked={participantFieldsLocked}
						editingParticipantIds={editingParticipantIds}
						inviteQuery={inviteQuery}
						inviteOptions={inviteOptions}
						friendOptions={inviteableFriends}
						selectedFriendId={selectedFriendId}
						newGuestName={newGuestName}
						onInviteQueryChange={(value) => {
							setInviteQuery(value);
							setSelectedInviteUserId("");
						}}
						onNewGuestNameChange={setNewGuestName}
						onInvite={onInvite}
						onFriendSelectionChange={setSelectedFriendId}
						onInviteFriend={onInviteFriend}
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
										isHostOrAdmin && !groupStageEditingLocked
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
								placementRevealKeys={placementRevealKeys}
								finalStandings={allPlayoffMatchesLocked ? finalStandings : undefined}
							/>
						}
						table={
							<Tabs defaultValue="upcoming" className="space-y-3">
								<TabsList>
									<TabsTrigger value="upcoming">Upcoming games</TabsTrigger>
									<TabsTrigger value="finished">Finished games</TabsTrigger>
								</TabsList>
								<TabsContent value="upcoming">
									<PlayoffMatchesTable
										title="Winners bracket matches"
										matches={winnersBracketMatches.filter((match) => !match.result?.locked)}
										teamById={teamById}
										resultDrafts={resultDrafts}
										saving={saving}
										canEditMatch={canEditPlayoffMatch}
										onResultDraftChange={(matchId, next) =>
											setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
										}
										onLockResult={onLockResult}
										onEditResult={
											isHostOrAdmin && !tournamentClosed
												? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
												: undefined
										}
										canEnableEditResult={canEnableEditPlayoffResult}
										standingByParticipantId={standingByParticipantId}
										medalByParticipantId={medalByParticipantId}
										placementRevealKeys={placementRevealKeys}
									/>
								</TabsContent>
								<TabsContent value="finished">
									<PlayoffMatchesTable
										title="Winners bracket matches"
										matches={winnersBracketMatches.filter((match) => Boolean(match.result?.locked))}
										teamById={teamById}
										resultDrafts={resultDrafts}
										saving={saving}
										canEditMatch={canEditPlayoffMatch}
										onResultDraftChange={(matchId, next) =>
											setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
										}
										onLockResult={onLockResult}
										onEditResult={
											isHostOrAdmin && !tournamentClosed
												? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
												: undefined
										}
										canEnableEditResult={canEnableEditPlayoffResult}
										standingByParticipantId={standingByParticipantId}
										medalByParticipantId={medalByParticipantId}
										placementRevealKeys={placementRevealKeys}
									/>
								</TabsContent>
							</Tabs>
						}
						placementDiagram={
							shouldShowPlacementBracket ? (
								<BracketDiagram
									title="Placement bracket"
									matches={placementBracketMatchesRaw}
									teamById={teamById}
									standingByParticipantId={standingByParticipantId}
									medalByParticipantId={medalByParticipantId}
									placementRevealKeys={placementRevealKeys}
								/>
							) : undefined
						}
						placementTable={
							shouldShowPlacementBracket ? (
								<Tabs defaultValue="upcoming" className="space-y-3">
									<TabsList>
										<TabsTrigger value="upcoming">Upcoming games</TabsTrigger>
										<TabsTrigger value="finished">Finished games</TabsTrigger>
									</TabsList>
									<TabsContent value="upcoming">
										<PlayoffMatchesTable
											title="Placement bracket matches"
											matches={placementBracketMatches.filter((match) => !match.result?.locked)}
											teamById={teamById}
											resultDrafts={resultDrafts}
											saving={saving}
											canEditMatch={canEditPlayoffMatch}
											onResultDraftChange={(matchId, next) =>
												setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
											}
											onLockResult={onLockResult}
											onEditResult={
												isHostOrAdmin && !tournamentClosed
													? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
													: undefined
											}
											canEnableEditResult={canEnableEditPlayoffResult}
											standingByParticipantId={standingByParticipantId}
											medalByParticipantId={medalByParticipantId}
											placementRevealKeys={placementRevealKeys}
										/>
									</TabsContent>
									<TabsContent value="finished">
										<PlayoffMatchesTable
											title="Placement bracket matches"
											matches={placementBracketMatches.filter((match) => Boolean(match.result?.locked))}
											teamById={teamById}
											resultDrafts={resultDrafts}
											saving={saving}
											canEditMatch={canEditPlayoffMatch}
											onResultDraftChange={(matchId, next) =>
												setResultDrafts((previous) => ({ ...previous, [matchId]: next }))
											}
											onLockResult={onLockResult}
											onEditResult={
												isHostOrAdmin && !tournamentClosed
													? (matchId) => setEditingMatchIds((previous) => new Set(previous).add(matchId))
													: undefined
											}
											canEnableEditResult={canEnableEditPlayoffResult}
											standingByParticipantId={standingByParticipantId}
											medalByParticipantId={medalByParticipantId}
											placementRevealKeys={placementRevealKeys}
										/>
									</TabsContent>
								</Tabs>
							) : undefined
						}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
