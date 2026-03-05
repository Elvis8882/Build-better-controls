import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createParticipant,
	ensurePlayoffBracket,
	type FriendProfile,
	fetchTeamsByPool,
	type GroupStanding,
	generateGroupsAndMatches,
	generateRoundRobinTiersStage,
	getTournament,
	inviteMember,
	listFriends,
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
	removeTournamentGuest,
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
import {
	hasLosersProgressionFlow,
	isGroupThenPlayoffFlow,
	isRoundRobinTiersFlow,
	isTwoVTwoFlow,
} from "@/pages/tournaments/preset-flow";
import {
	computeRoundRobinStandings,
	pickRerolledTeam,
	resolveTierFromTeam,
	TIER_ORDER,
} from "@/pages/tournaments/round-robin-tiers";
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

const getPresetTypeLabel = (presetId: Tournament["preset_id"]): string => {
	if (presetId === "playoffs_only") return "Playoff only (without loser bracket)";
	if (presetId === "2v2_playoffs") return "2v2 Playoffs";
	if (presetId === "full_with_losers") return "Full tournament (with loser bracket)";
	if (presetId === "full_no_losers") return "Full tournament (without loser bracket)";
	if (presetId === "2v2_tournament") return "2v2 Tournament";
	if (presetId === "round_robin_tiers") return "Round-Robin Tiers";
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
	const [twoVTwoPairOrderById, setTwoVTwoPairOrderById] = useState<Map<string, number>>(new Map());
	const ensuringPlayoffBracketRef = useRef(false);

	const isAdmin = profile?.role === "admin";
	const managerMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && (member.role === "host" || member.role === "admin")),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(managerMembership);

	useEffect(() => {
		if (!user?.id || !isHostOrAdmin) return;
		void listFriends(user.id)
			.then(setFriends)
			.catch((error) => toast.error((error as Error).message));
	}, [user?.id, isHostOrAdmin]);

	const displayParticipants = useMemo(() => {
		if (!tournament) return participants;
		const sortedByDefaultOrder = [...participants].sort((left, right) => {
			const leftIsHost = left.user_id === tournament.created_by;
			const rightIsHost = right.user_id === tournament.created_by;
			if (leftIsHost && !rightIsHost) return -1;
			if (!leftIsHost && rightIsHost) return 1;
			return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
		});
		if (!isTwoVTwoFlow(tournament.preset_id) || twoVTwoPairOrderById.size === 0) {
			return sortedByDefaultOrder;
		}
		return sortedByDefaultOrder.sort((left, right) => {
			const leftOrder = twoVTwoPairOrderById.get(left.id);
			const rightOrder = twoVTwoPairOrderById.get(right.id);
			if (leftOrder === undefined && rightOrder === undefined) return 0;
			if (leftOrder === undefined) return 1;
			if (rightOrder === undefined) return -1;
			return leftOrder - rightOrder;
		});
	}, [participants, tournament, twoVTwoPairOrderById]);
	const participantsWithHostLabel = useMemo(
		() =>
			displayParticipants.map((participant) => {
				if (!tournament || participant.user_id !== tournament.created_by) return participant;
				if (participant.display_name.includes("(Host)")) return participant;
				return { ...participant, display_name: `${participant.display_name} (Host)` };
			}),
		[displayParticipants, tournament],
	);
	const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
	const twoVTwoPreset = isTwoVTwoFlow(tournament?.preset_id ?? null);
	const roundRobinTiersPreset = isRoundRobinTiersFlow(tournament?.preset_id ?? null);
	const assignedTeamCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const participant of displayParticipants) {
			if (!participant.team_id) continue;
			counts.set(participant.team_id, (counts.get(participant.team_id) ?? 0) + 1);
		}
		return counts;
	}, [displayParticipants]);
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
		displayParticipants.every((participant) => participant.locked && (roundRobinTiersPreset || participant.team_id));
	const teamsValidForPreset = useMemo(() => {
		if (!twoVTwoPreset) return true;
		if (!allLockedWithTeams) return false;
		for (const count of assignedTeamCounts.values()) {
			if (count !== 2) return false;
		}
		return assignedTeamCounts.size * 2 === displayParticipants.length;
	}, [twoVTwoPreset, allLockedWithTeams, assignedTeamCounts, displayParticipants.length]);
	const canRandomizeTwoVTwoPairs =
		twoVTwoPreset &&
		displayParticipants.length >= 2 &&
		displayParticipants.every((participant) => !participant.team_id);
	const allGroupMatchesLocked = groupMatches.length > 0 && groupMatches.every((match) => Boolean(match.result?.locked));
	const fullPreset = isGroupThenPlayoffFlow(tournament?.preset_id ?? null);
	const canGenerateGroups = fullPreset && allLockedWithTeams && teamsValidForPreset && groups.length === 0;
	const canGenerateRoundRobinTiers =
		roundRobinTiersPreset && allLockedWithTeams && teamsValidForPreset && groupMatches.length === 0;
	const groupStageAvailable = (fullPreset || roundRobinTiersPreset) && (groups.length > 0 || groupMatches.length > 0);
	const playoffStageAvailable = roundRobinTiersPreset
		? false
		: fullPreset
			? allGroupMatchesLocked
			: allLockedWithTeams && teamsValidForPreset;
	const anyGroupLocked = groupMatches.some((match) => Boolean(match.result?.locked));
	const anyPlayoffLocked = playoffMatches.some((match) => Boolean(match.result?.locked));
	const lockedPlayoffMatchIds = useMemo(
		() => new Set(playoffMatches.filter((match) => Boolean(match.result?.locked)).map((match) => match.id)),
		[playoffMatches],
	);
	const playoffDependencyChildrenByMatchId = useMemo(() => {
		const childrenByMatchId = new Map<string, string[]>();
		const addChildEdge = (matchId: string, dependencyMatchId: string) => {
			const items = childrenByMatchId.get(matchId) ?? [];
			if (items.includes(dependencyMatchId)) return;
			items.push(dependencyMatchId);
			childrenByMatchId.set(matchId, items);
		};

		for (const match of playoffMatches) {
			if (!match.next_match_id) continue;
			addChildEdge(match.id, match.next_match_id);
		}

		const singlePlacementPreset =
			tournament?.preset_id &&
			!hasLosersProgressionFlow(tournament.preset_id) &&
			playoffMatches.some((match) => match.bracket_type === "LOSERS");
		if (singlePlacementPreset) {
			const winnersMatches = playoffMatches.filter((match) => match.bracket_type !== "LOSERS");
			const maxWinnersRound =
				winnersMatches.length > 0 ? Math.max(...winnersMatches.map((match) => match.round)) : null;
			const semifinalRound = maxWinnersRound ? Math.max(maxWinnersRound - 1, 1) : null;
			const semifinalMatches =
				semifinalRound !== null ? winnersMatches.filter((match) => match.round === semifinalRound) : [];
			const thirdPlaceMatch = playoffMatches.find(
				(match) => match.bracket_type === "LOSERS" && match.round === 1 && (match.bracket_slot ?? 0) === 1,
			);
			if (thirdPlaceMatch) {
				for (const semifinalMatch of semifinalMatches) {
					addChildEdge(semifinalMatch.id, thirdPlaceMatch.id);
				}
			}
		}

		return childrenByMatchId;
	}, [playoffMatches, tournament?.preset_id]);
	const hasLockedDescendantByMatchId = useMemo(() => {
		const memo = new Map<string, boolean>();
		const visit = (matchId: string): boolean => {
			if (memo.has(matchId)) return memo.get(matchId) ?? false;
			const descendants = playoffDependencyChildrenByMatchId.get(matchId) ?? [];
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
	}, [playoffMatches, playoffDependencyChildrenByMatchId, lockedPlayoffMatchIds]);
	const allPlayoffMatchesLockedByStage =
		playoffMatches.length > 0 &&
		playoffMatches.filter(isMatchDisplayable).every((match) => Boolean(match.result?.locked));
	const tournamentStarted =
		allLockedWithTeams && (fullPreset || roundRobinTiersPreset ? groupMatches.length > 0 : playoffMatches.length > 0);
	const tournamentCanClose = roundRobinTiersPreset
		? allGroupMatchesLocked
		: allPlayoffMatchesLockedByStage && (fullPreset ? allGroupMatchesLocked : true);
	const tournamentClosed = tournament?.status === "Closed";
	const participantFieldsLocked =
		tournamentClosed || (fullPreset || roundRobinTiersPreset ? groupStageAvailable : playoffMatches.length > 0);
	const groupStageEditingLocked = tournamentClosed || (!roundRobinTiersPreset && anyPlayoffLocked);

	useEffect(() => {
		if (!id) return;
		const participantsPath = `/dashboard/tournaments/${id}/participants`;
		const segments = location.pathname.split("/").filter(Boolean);
		const lastSegment = segments[segments.length - 1];
		if (lastSegment === "participants") {
			setActiveTab("participants");
			return;
		}
		if (lastSegment === "group-stage") {
			if (!groupStageAvailable) {
				setActiveTab("participants");
				navigate(participantsPath, { replace: true });
				return;
			}
			setActiveTab("group");
			return;
		}
		if (lastSegment === "playoff-bracket") {
			if (!playoffStageAvailable) {
				setActiveTab("participants");
				navigate(participantsPath, { replace: true });
				return;
			}
			setActiveTab("playoff");
			return;
		}
		setActiveTab("participants");
	}, [id, location.pathname, groupStageAvailable, playoffStageAvailable, navigate]);

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

	const isRetryableRefreshError = useCallback((error: unknown) => {
		if (typeof error !== "object" || error === null) return false;
		const status = (error as { status?: number }).status;
		if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
		const message = (error as { message?: string }).message?.toLowerCase() ?? "";
		return ["network", "timeout", "timed out", "temporar", "rate limit"].some((needle) => message.includes(needle));
	}, []);

	const runSectionRefresh = useCallback(
		async (name: "participants" | "group" | "playoff", fn: () => Promise<void>) => {
			try {
				await fn();
			} catch (error) {
				const retryable = isRetryableRefreshError(error);
				console.debug(`[tournament-detail] ${name} refresh failed`, error);
				if (!retryable) {
					toast.error(`Failed to refresh ${name} section: ${(error as Error).message}`);
					return;
				}
				console.debug(`[tournament-detail] ${name} refresh retrying once after retryable error`);
				try {
					await fn();
				} catch (retryError) {
					console.debug(`[tournament-detail] ${name} refresh retry failed`, retryError);
					toast.error(`Failed to refresh ${name} section after retry: ${(retryError as Error).message}`);
				}
			}
		},
		[isRetryableRefreshError],
	);

	const onTabChange = (nextTab: "participants" | "group" | "playoff") => {
		if (nextTab === "group" && !groupStageAvailable) return;
		if (nextTab === "playoff" && !playoffStageAvailable) return;
		setActiveTab(nextTab);
		if (!id) return;
		if (nextTab === "participants") {
			navigate(`/dashboard/tournaments/${id}/participants`);
			void runSectionRefresh("participants", refreshParticipantsSection);
			return;
		}
		if (nextTab === "group") {
			navigate(`/dashboard/tournaments/${id}/group-stage`);
			void runSectionRefresh("group", refreshGroupStageSections);
			return;
		}
		navigate(`/dashboard/tournaments/${id}/playoff-bracket`);
		void runSectionRefresh("playoff", refreshPlayoffSection);
	};

	const ensurePlayoffBracketSafe = useCallback(async () => {
		if (!id || ensuringPlayoffBracketRef.current) return false;
		ensuringPlayoffBracketRef.current = true;
		try {
			await ensurePlayoffBracket(id);
			await refreshPlayoffSection();
			return true;
		} finally {
			ensuringPlayoffBracketRef.current = false;
		}
	}, [id, refreshPlayoffSection]);

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
		if (!id || !isHostOrAdmin || saving || !canGenerateRoundRobinTiers) return;
		if (tournamentClosed) {
			toast.error("Cannot regenerate round-robin tiers for a closed tournament.");
			return;
		}
		if (anyGroupLocked || anyPlayoffLocked) {
			toast.error("Cannot regenerate round-robin tiers after match results are locked.");
			return;
		}
		setSaving(true);
		void generateRoundRobinTiersStage(id)
			.then(loadAll)
			.then(() => toast.success("Round-robin schedule generated."))
			.catch((error) => toast.error((error as Error).message))
			.finally(() => setSaving(false));
	}, [
		id,
		isHostOrAdmin,
		saving,
		canGenerateRoundRobinTiers,
		loadAll,
		tournamentClosed,
		anyGroupLocked,
		anyPlayoffLocked,
	]);

	useEffect(() => {
		if (!id || activeTab !== "playoff" || anyPlayoffLocked || !playoffStageAvailable) return;
		setSaving(true);
		void ensurePlayoffBracketSafe()
			.catch((error) => toast.error((error as Error).message))
			.finally(() => setSaving(false));
	}, [id, activeTab, anyPlayoffLocked, playoffStageAvailable, ensurePlayoffBracketSafe]);

	useEffect(() => {
		if (!id) return;

		const refreshActiveTabData = () => {
			if (document.visibilityState !== "visible") return;
			if (activeTab === "participants") {
				void runSectionRefresh("participants", refreshParticipantsSection);
				return;
			}
			if (activeTab === "group") {
				void runSectionRefresh("group", refreshGroupStageSections);
				return;
			}
			void runSectionRefresh("playoff", refreshPlayoffSection);
		};

		document.addEventListener("visibilitychange", refreshActiveTabData);
		window.addEventListener("focus", refreshActiveTabData);

		return () => {
			document.removeEventListener("visibilitychange", refreshActiveTabData);
			window.removeEventListener("focus", refreshActiveTabData);
		};
	}, [id, activeTab, refreshParticipantsSection, refreshGroupStageSections, refreshPlayoffSection, runSectionRefresh]);

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

	const onLockParticipant = async (participantId: string) => {
		setSaving(true);
		try {
			await lockParticipant(participantId);
			await refreshParticipantsSection();

			if (!id || !roundRobinTiersPreset) return;
			if (tournamentClosed) {
				toast.error("Cannot regenerate round-robin tiers for a closed tournament.");
				return;
			}
			if (anyGroupLocked || anyPlayoffLocked) {
				toast.error("Cannot regenerate round-robin tiers after match results are locked.");
				return;
			}
			const latestParticipants = await listParticipants(id);
			const allSlotsLocked =
				latestParticipants.length === slots && latestParticipants.every((participant) => participant.locked);
			if (!allSlotsLocked) return;

			const existingGroupMatches = await listMatchesWithResults(id, "GROUP");
			if (existingGroupMatches.length > 0) return;

			await generateRoundRobinTiersStage(id);
			await refreshGroupStageSections();
			toast.success("Round-robin schedule generated.");
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

	const rerollRoundRobinWaveIfNeeded = async (lockedMatchId: string, parsed: ParsedResult) => {
		if (!roundRobinTiersPreset) return;
		const lockedMatch = groupMatches.find((match) => match.id === lockedMatchId);
		if (!lockedMatch) return;
		const waveMatches = groupMatches.filter((match) => match.round === lockedMatch.round);
		const waveComplete = waveMatches.every((match) =>
			match.id === lockedMatchId ? true : Boolean(match.result?.locked),
		);
		if (!waveComplete) return;

		const deltas = new Map<string, number>();
		for (const match of waveMatches) {
			const homeId = match.home_participant_id;
			const awayId = match.away_participant_id;
			if (!homeId || !awayId) continue;
			const homeScore = match.id === lockedMatchId ? parsed.homeScore : (match.result?.home_score ?? 0);
			const awayScore = match.id === lockedMatchId ? parsed.awayScore : (match.result?.away_score ?? 0);
			const winnerId = homeScore > awayScore ? homeId : awayId;
			const loserId = winnerId === homeId ? awayId : homeId;
			deltas.set(winnerId, 1);
			deltas.set(loserId, -1);
		}

		const latestTeamByParticipantId = new Map(participants.map((participant) => [participant.id, participant.team_id]));

		for (const [participantId, delta] of deltas.entries()) {
			const participant = participants.find((row) => row.id === participantId);
			if (!participant) continue;

			const currentTeamId = latestTeamByParticipantId.get(participant.id) ?? participant.team_id;
			const currentTier = resolveTierFromTeam(currentTeamId, teams);
			const currentIndex = TIER_ORDER.indexOf(currentTier);
			const nextIndex = Math.min(TIER_ORDER.length - 1, Math.max(0, currentIndex + delta));

			const occupiedTeamIds = new Set(
				[...latestTeamByParticipantId.entries()]
					.filter(([id, teamId]) => id !== participantId && Boolean(teamId))
					.map(([, teamId]) => teamId as string),
			);
			const attemptedTeamIds = new Set<string>();

			for (let attempt = 0; attempt < 5; attempt += 1) {
				const nextTeamId = pickRerolledTeam({
					teams,
					targetTier: TIER_ORDER[nextIndex],
					previousTeamId: currentTeamId,
					excludedTeamIds: new Set([...occupiedTeamIds, ...attemptedTeamIds]),
				});
				if (!nextTeamId || attemptedTeamIds.has(nextTeamId)) break;

				attemptedTeamIds.add(nextTeamId);
				try {
					await updateParticipant(participantId, nextTeamId);
					latestTeamByParticipantId.set(participantId, nextTeamId);
					break;
				} catch (error) {
					const message = `${(error as Error).message ?? ""}`.toLowerCase();
					if (!message.includes("tournament_participants_team_unique") && !message.includes("duplicate key value")) {
						throw error;
					}
					if (attempt === 4) {
						throw error;
					}
				}
			}
		}
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
			const matchForSnapshot =
				groupMatches.find((match) => match.id === matchId) ?? playoffMatches.find((match) => match.id === matchId);
			const homeTeamIdForResult =
				participants.find((participant) => participant.id === matchForSnapshot?.home_participant_id)?.team_id ??
				matchForSnapshot?.home_team_id ??
				null;
			const awayTeamIdForResult =
				participants.find((participant) => participant.id === matchForSnapshot?.away_participant_id)?.team_id ??
				matchForSnapshot?.away_team_id ??
				null;
			await lockMatchResult(matchId, homeTeamIdForResult, awayTeamIdForResult);
			await rerollRoundRobinWaveIfNeeded(matchId, parsed);
			setEditingMatchIds((previous) => {
				const next = new Set(previous);
				next.delete(matchId);
				return next;
			});
			if (isGroupMatch) {
				if (roundRobinTiersPreset) {
					await refreshParticipantsSection();
				}
				if (activeTab === "group") {
					await refreshGroupStageSections();
				} else if (activeTab === "playoff" && !anyPlayoffLocked && id) {
					await ensurePlayoffBracketSafe();
				}
			}
			if (isPlayoffMatch) {
				await ensurePlayoffBracketSafe();
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

	const onRandomizeTeam = async (
		participant: TournamentParticipant,
		teamFilter: TeamFilter,
	): Promise<string | null> => {
		const maxPerTeam = twoVTwoPreset ? 2 : 1;
		const available = teams.filter(
			(team) =>
				(assignedTeamCounts.get(team.id) ?? 0) < maxPerTeam && (teamFilter === "ALL" || team.ovr_tier === teamFilter),
		);
		if (available.length === 0) {
			toast.error(
				twoVTwoPreset
					? "No available team slots left for the selected filter."
					: "No unassigned teams left for the selected filter.",
			);
			return null;
		}
		const pick = available[Math.floor(Math.random() * available.length)];
		const pickId = pick?.id;
		if (!pickId) return null;
		setSaving(true);
		try {
			await updateParticipant(participant.id, pickId);
			await refreshParticipantsSection();
			return pickId;
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

	const onRandomizeTwoVTwoTeams = async () => {
		if (!canRandomizeTwoVTwoPairs) return;
		setTwoVTwoPairOrderById(() => {
			const shuffled = [...displayParticipants];
			for (let index = shuffled.length - 1; index > 0; index -= 1) {
				const swapIndex = Math.floor(Math.random() * (index + 1));
				const temp = shuffled[index];
				shuffled[index] = shuffled[swapIndex];
				shuffled[swapIndex] = temp;
			}
			return new Map(shuffled.map((participant, index) => [participant.id, index]));
		});
		toast.success("2v2 pairs randomized.");
	};

	const onClearParticipant = async (participant: TournamentParticipant) => {
		if (!isHostOrAdmin) return;
		setSaving(true);
		try {
			await removeParticipant(participant.id);
			if (id && participant.guest_id) {
				await removeTournamentGuest(id, participant.guest_id);
			}
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

	const roundRobinStandings = useMemo(
		() => computeRoundRobinStandings(groupMatches, participants),
		[groupMatches, participants],
	);
	const showRoundRobinPlacement =
		roundRobinTiersPreset && groupMatches.length > 0 && groupMatches.every((match) => Boolean(match.result?.locked));

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
		hasLosersProgressionFlow(tournament.preset_id) || placementBracketMatchesRaw.length > 0;
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

	const fifthPlaceMatch = [...placementBracketMatches]
		.filter(
			(match) =>
				Boolean(match.result?.locked) && (match.round ?? 0) === placementFinalRound && (match.bracket_slot ?? 0) === 2,
		)
		.sort((a, b) => (a.id > b.id ? 1 : -1))[0];
	if (fifthPlaceMatch) {
		const fifthWinner = resolveWinner(fifthPlaceMatch);
		const fifthLoser = resolveLoser(fifthPlaceMatch);
		if (fifthWinner && !standingByParticipantId.has(fifthWinner)) standingByParticipantId.set(fifthWinner, 5);
		if (fifthLoser && !standingByParticipantId.has(fifthLoser)) standingByParticipantId.set(fifthLoser, 6);
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
			return { participantId, placement, name: team?.name ?? participant?.display_name ?? "Unknown", team };
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
					{(fullPreset || roundRobinTiersPreset) && (
						<TabsTrigger value="group" disabled={!groupStageAvailable}>
							{roundRobinTiersPreset ? "Round-robin" : "Group Stage"}
						</TabsTrigger>
					)}
					{!roundRobinTiersPreset && (
						<TabsTrigger value="playoff" disabled={!playoffStageAvailable}>
							Playoff sheet
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="participants" className="space-y-4">
					{twoVTwoPreset && (
						<p className="text-sm text-muted-foreground">
							2v2 preset enabled: each team must have exactly 2 participants before the tournament can start.
						</p>
					)}
					{roundRobinTiersPreset ? (
						<section className="space-y-3 rounded-lg border p-3 md:p-4">
							<h2 className="text-lg font-semibold">Participants</h2>
							{displayParticipants.length < tournament.default_participants && !participantFieldsLocked && (
								<div className="grid gap-3 md:grid-cols-3">
									<div className="space-y-2">
										<p className="text-sm">Quick invite friend</p>
										<div className="flex gap-2">
											<select
												className="h-9 w-full rounded-md border px-2 text-sm"
												disabled={inviteableFriends.length === 0}
												value={selectedFriendId}
												onChange={(event) => setSelectedFriendId(event.target.value)}
											>
												<option value="">
													{inviteableFriends.length === 0 ? "No friends available" : "Select friend"}
												</option>
												{inviteableFriends.map((friend) => (
													<option key={friend.id} value={friend.id}>
														{friend.username}
													</option>
												))}
											</select>
											<Button
												size="sm"
												disabled={saving || !selectedFriendId || inviteableFriends.length === 0}
												onClick={() => void onInviteFriend()}
											>
												Invite
											</Button>
										</div>
									</div>
									<div className="space-y-2">
										<p className="text-sm">Invite registered user</p>
										<div className="flex gap-2">
											<input
												className="h-9 w-full rounded-md border px-2 text-sm"
												value={inviteQuery}
												onChange={(event) => {
													setInviteQuery(event.target.value);
													setSelectedInviteUserId("");
												}}
												list="invite-user-options-min"
											/>
											<Button
												disabled={saving || displayParticipants.length >= tournament.default_participants}
												onClick={() => void onInvite()}
											>
												Add
											</Button>
										</div>
										<datalist id="invite-user-options-min">
											{inviteOptions.map((option) => (
												<option key={option.id} value={option.username} />
											))}
										</datalist>
									</div>
									<div className="space-y-2">
										<p className="text-sm">Create guest</p>
										<div className="flex gap-2">
											<input
												className="h-9 w-full rounded-md border px-2 text-sm"
												value={newGuestName}
												onChange={(event) => setNewGuestName(event.target.value)}
												placeholder="Guest name"
											/>
											<Button
												disabled={saving || displayParticipants.length >= tournament.default_participants}
												onClick={() => void onAddGuest()}
											>
												Add
											</Button>
										</div>
									</div>
								</div>
							)}
							<div className="space-y-2">
								{participantsWithHostLabel.map((participant) => (
									<div key={participant.id} className="flex items-center justify-between gap-2 rounded border p-2">
										<span className="truncate text-sm">{participant.display_name}</span>
										<div className="flex items-center gap-2">
											{isHostOrAdmin && !participant.locked && !participantFieldsLocked && (
												<Button
													variant="ghost"
													size="icon"
													disabled={saving}
													onClick={() => void onClearParticipant(participant)}
													aria-label={`Remove ${participant.display_name}`}
												>
													×
												</Button>
											)}
											<Button
												size="sm"
												disabled={participant.locked || saving || participantFieldsLocked}
												onClick={() => void onLockParticipant(participant.id)}
											>
												{participant.locked ? "Locked" : "Lock in"}
											</Button>
										</div>
									</div>
								))}
								{placeholderRows.map((placeholder) => (
									<div
										key={placeholder.id}
										className="flex items-center justify-between gap-2 rounded border border-dashed p-2 text-muted-foreground"
									>
										<span className="truncate text-sm">{placeholder.label}</span>
									</div>
								))}
							</div>
						</section>
					) : (
						<ParticipantsTable
							tournament={tournament}
							participants={participantsWithHostLabel}
							placeholderRows={placeholderRows}
							teams={teams}
							assignedTeamCounts={assignedTeamCounts}
							twoVTwoPreset={twoVTwoPreset}
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
							onRandomizeTwoVTwoTeams={onRandomizeTwoVTwoTeams}
							canRandomizeTwoVTwoPairs={canRandomizeTwoVTwoPairs}
							onLockParticipant={onLockParticipant}
							onEditParticipant={(participantId) =>
								setEditingParticipantIds((previous) => new Set(previous).add(participantId))
							}
							onClearParticipant={onClearParticipant}
						/>
					)}
					{!allLockedWithTeams && (
						<p className="text-sm text-muted-foreground">Waiting for all participants to lock in.</p>
					)}
				</TabsContent>

				{(fullPreset || roundRobinTiersPreset) && (
					<TabsContent value="group" className="space-y-4">
						<GroupStagePage
							standingsTable={
								roundRobinTiersPreset ? (
									<section className="space-y-3 rounded-lg border p-4">
										<h2 className="text-lg font-semibold">Standings</h2>
										<div className="overflow-x-auto">
											<table className="w-auto min-w-[460px] text-sm">
												<thead>
													<tr className="border-b">
														<th className="py-1 text-left">Participant</th>
														<th className="py-1 text-right">GP</th>
														<th className="py-1 text-right">W</th>
														<th className="py-1 text-right">L</th>
														<th className="py-1 text-right">GF:GA</th>
														<th className="py-1 text-right">Pts</th>
														{showRoundRobinPlacement && <th className="py-1 text-right">Placement</th>}
													</tr>
												</thead>
												<tbody>
													{roundRobinStandings.map((row, index) => (
														<tr key={row.id} className="border-b">
															<td className="py-1">{row.name}</td>
															<td className="py-1 text-right">{row.gp}</td>
															<td className="py-1 text-right">{row.w}</td>
															<td className="py-1 text-right">{row.l}</td>
															<td className="py-1 text-right">
																{row.gf}:{row.ga}
															</td>
															<td className="py-1 text-right font-semibold">{row.pts}</td>
															{showRoundRobinPlacement && (
																<td className="py-1 text-right font-semibold">#{index + 1}</td>
															)}
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</section>
								) : (
									<GroupStandings
										groups={groups}
										standings={standings}
										teamById={teamById}
										showPlacement={allGroupMatchesLocked}
										groupMatches={groupMatches}
									/>
								)
							}
							matchesTable={
								roundRobinTiersPreset ? (
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
										useParticipantNames
										limitUpcomingMatches
									/>
								) : (
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
								)
							}
						/>
					</TabsContent>
				)}

				{!roundRobinTiersPreset && (
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
				)}
			</Tabs>
		</div>
	);
}
