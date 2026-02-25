import { supabase } from "@/lib/supabaseClient";

export type TournamentPreset =
	| "playoffs_only"
	| "full_with_losers"
	| "full_no_losers"
	| "2v2_tournament"
	| "2v2_playoffs";
export type TournamentPresetUi = TournamentPreset;
export type TeamPool = "NHL" | "INTL";
export type TournamentStage = "GROUP" | "PLAYOFF";
export type MatchStage = "GROUP" | "PLAYOFF";
export type BracketType = "WINNERS" | "LOSERS";

export type Tournament = {
	id: string;
	name: string;
	status: string | null;
	created_at: string;
	preset_id: TournamentPreset | null;
	created_by: string;
	team_pool: TeamPool;
	default_participants: number;
	group_count: number | null;
	stage: TournamentStage;
	hosted_by: string;
};

export type TournamentMember = {
	tournament_id: string;
	user_id: string;
	role: string;
	username: string;
};

export type TournamentGuest = {
	id: string;
	tournament_id: string;
	display_name: string;
};

export type MatchParticipantDecision = "R" | "OT" | "SO";

export type Match = {
	id: string;
	tournament_id: string;
	home_participant_id: string | null;
	away_participant_id: string | null;
	round: number;
	bracket_slot: number | null;
	next_match_id: string | null;
	next_match_side: "HOME" | "AWAY" | null;
	created_at: string;
	stage: MatchStage;
	bracket_type: BracketType | null;
};

export type MatchResult = {
	match_id: string;
	home_score: number | null;
	away_score: number | null;
	home_shots: number | null;
	away_shots: number | null;
	decision: MatchParticipantDecision | null;
	locked: boolean;
};

export type MatchWithResult = Match & {
	result: MatchResult | null;
	home_participant_name: string;
	away_participant_name: string;
	home_team_id: string | null;
	away_team_id: string | null;
};

export type ProfileOption = {
	id: string;
	username: string;
	role: string | null;
};

export type TournamentParticipant = {
	id: string;
	tournament_id: string;
	user_id: string | null;
	guest_id: string | null;
	display_name: string;
	team_id: string | null;
	team: Team | null;
	locked: boolean;
	created_at: string;
};

export type Team = {
	id: string;
	code: string;
	name: string;
	short_name: string;
	team_pool: TeamPool;
	primary_color: string;
	secondary_color: string | null;
	text_color: string;
	overall: number;
	off_def_sum: number;
	offense: number;
	defense: number;
	goalie: number;
	ovr_tier: "Top 5" | "Top 10" | "Middle Tier" | "Bottom Tier";
	last_updated: string;
};

export type TeamRatingUpdate = {
	offense: number;
	defense: number;
	goalie: number;
};

export type TournamentGroup = {
	id: string;
	tournament_id: string;
	group_code: string;
};

export type GroupStanding = {
	tournament_id: string;
	group_id: string;
	group_code?: string;
	rank_in_group: number;
	participant_id: string;
	display_name: string;
	team_id: string | null;
	team_code: string | null;
	team_short_name: string | null;
	team_primary_color: string | null;
	team_secondary_color: string | null;
	team_text_color: string | null;
	points: number;
	goals_for: number;
	goals_against: number;
	goal_diff: number;
	shots_diff: number;
};

export type PlayerTeamStat = {
	team_id: string;
	team_code: string;
	team_pool: TeamPool;
	team_name: string;
	games_played: number;
	wins: number;
	losses: number;
	shots_made: number;
	goals_made: number;
	shots_received: number;
	goals_received: number;
	goalie_save_rate: number;
};

export type RegisteredProfile = {
	id: string;
	username: string;
};

export type TournamentTeamStat = PlayerTeamStat & {
	placement: number | null;
	player_name: string | null;
};

export type PublicProfile = {
	id: string;
	username: string | null;
	role: string | null;
};

export type ProfileOverview = {
	id: string;
	username: string | null;
	bio: string | null;
	favorite_team: string | null;
	club_preference: string | null;
};

export type FriendRequest = {
	id: string;
	sender_id: string;
	receiver_id: string;
	status: "pending" | "accepted" | "rejected";
	created_at: string;
	sender_username: string;
};

export type FriendProfile = {
	id: string;
	username: string;
};

function throwOnError(error: { message: string } | null, fallbackMessage: string): void {
	if (error) {
		const message = `${error.message ?? ""}`;
		const maybeAuthError = message.toLowerCase().includes("jwt") || (error as { status?: number }).status === 401;
		if (maybeAuthError) {
			void supabase.auth.signOut().finally(() => {
				if (typeof window !== "undefined" && window.location.pathname !== "/auth/login") {
					window.location.assign("/auth/login");
				}
			});
		}
		throw new Error(error.message || fallbackMessage);
	}
}

export function sanitizeGroupCount(
	participants: number,
	selectedGroups: number,
	options?: { autoExpand?: boolean; maxParticipantsPerGroup?: number },
): { groupCount: number; note: string | null; error: string | null } {
	let groupCount = Math.max(1, Math.min(4, selectedGroups));
	let note: string | null = null;
	const autoExpand = options?.autoExpand ?? true;
	const maxParticipantsPerGroup = options?.maxParticipantsPerGroup ?? 6;

	if (participants < 3) {
		return { groupCount, note, error: "Participants must be at least 3." };
	}
	while (groupCount > 1) {
		const minGroupSize = Math.floor(participants / groupCount);
		if (minGroupSize >= 3) break;
		groupCount -= 1;
		note = `Adjusted to ${groupCount} groups to keep at least 3 participants per group.`;
	}

	if (autoExpand) {
		while (participants > groupCount * maxParticipantsPerGroup && groupCount < 4) {
			groupCount += 1;
			note = `Adjusted to ${groupCount} groups to keep groups at max ${maxParticipantsPerGroup} participants.`;
		}
	}

	if (participants > groupCount * maxParticipantsPerGroup) {
		return {
			groupCount,
			note,
			error: `Too many participants for max 4 groups (max ${maxParticipantsPerGroup} per group).`,
		};
	}

	if (Math.floor(participants / groupCount) < 3) {
		return { groupCount, note, error: "Not enough participants for selected group count." };
	}

	return { groupCount, note, error: null };
}

function normalizeTournamentPreset(preset: string | null): TournamentPreset | null {
	if (!preset) return null;
	if (preset === "full_tournament") return "full_no_losers";
	if (
		preset === "playoffs_only" ||
		preset === "full_with_losers" ||
		preset === "full_no_losers" ||
		preset === "2v2_tournament" ||
		preset === "2v2_playoffs"
	)
		return preset;
	return null;
}

export async function listTournaments(): Promise<Tournament[]> {
	const { data, error } = await supabase
		.from("tournaments")
		.select("id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage")
		.order("created_at", { ascending: false });
	throwOnError(error, "Unable to load tournaments");

	const rows = (data ?? []) as Array<Omit<Tournament, "hosted_by">>;
	const creatorIds = [...new Set(rows.map((item) => item.created_by).filter(Boolean))];
	let usernameById = new Map<string, string>();

	if (creatorIds.length > 0) {
		const { data: profileData, error: profileError } = await supabase
			.from("profiles")
			.select("id, username")
			.in("id", creatorIds);
		throwOnError(profileError, "Unable to load tournament hosts");
		usernameById = new Map(
			(profileData ?? []).map((profile) => [profile.id as string, (profile.username as string) ?? "unknown"]),
		);
	}

	return rows.map((item) => ({
		...item,
		preset_id: normalizeTournamentPreset(item.preset_id as string | null),
		hosted_by: usernameById.get(item.created_by) ?? "unknown",
	}));
}

export async function createTournament(payload: {
	name: string;
	presetId: TournamentPresetUi;
	teamPool: TeamPool;
	defaultParticipants: number;
	groupCount: number | null;
}): Promise<Tournament> {
	const { data: authData, error: authError } = await supabase.auth.getUser();
	throwOnError(authError, "Unable to read authenticated user");

	const userId = authData.user?.id;
	if (!userId) {
		throw new Error("User is not authenticated.");
	}

	const insertPayload = {
		name: payload.name,
		preset_id: payload.presetId,
		created_by: userId,
		team_pool: payload.teamPool,
		default_participants: payload.defaultParticipants,
		group_count: payload.groupCount,
		stage: payload.presetId === "playoffs_only" || payload.presetId === "2v2_playoffs" ? "PLAYOFF" : "GROUP",
	};

	const { data, error } = await supabase
		.from("tournaments")
		.insert(insertPayload)
		.select("id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage")
		.single();

	throwOnError(error, "Unable to create tournament");
	const created = data as Omit<Tournament, "hosted_by">;
	return {
		...created,
		preset_id: normalizeTournamentPreset(created.preset_id as string | null),
		hosted_by: "unknown",
	};
}

export async function deleteTournament(tournamentId: string): Promise<void> {
	const { data: matchRows, error: matchesError } = await supabase
		.from("matches")
		.select("id")
		.eq("tournament_id", tournamentId);
	throwOnError(matchesError, "Unable to load tournament matches for deletion");

	const matchIds = (matchRows ?? []).map((match) => match.id as string);
	if (matchIds.length > 0) {
		const { error: matchResultsError } = await supabase.from("match_results").delete().in("match_id", matchIds);
		throwOnError(matchResultsError, "Unable to delete match results");
	}

	const { error: matchesDeleteError } = await supabase.from("matches").delete().eq("tournament_id", tournamentId);
	throwOnError(matchesDeleteError, "Unable to delete matches");

	const { data: groupRows, error: groupsError } = await supabase
		.from("tournament_groups")
		.select("id")
		.eq("tournament_id", tournamentId);
	throwOnError(groupsError, "Unable to load tournament groups for deletion");

	const groupIds = (groupRows ?? []).map((group) => group.id as string);
	if (groupIds.length > 0) {
		const { error: groupMembersDeleteError } = await supabase
			.from("tournament_group_members")
			.delete()
			.in("group_id", groupIds);
		throwOnError(groupMembersDeleteError, "Unable to delete group members");
	}

	const { error: groupsDeleteError } = await supabase
		.from("tournament_groups")
		.delete()
		.eq("tournament_id", tournamentId);
	throwOnError(groupsDeleteError, "Unable to delete groups");

	const { error: participantsDeleteError } = await supabase
		.from("tournament_participants")
		.delete()
		.eq("tournament_id", tournamentId);
	throwOnError(participantsDeleteError, "Unable to delete participants");

	const { error: membersDeleteError } = await supabase
		.from("tournament_members")
		.delete()
		.eq("tournament_id", tournamentId);
	throwOnError(membersDeleteError, "Unable to delete members");

	const { error: picksDeleteError } = await supabase.from("team_picks").delete().eq("tournament_id", tournamentId);
	throwOnError(picksDeleteError, "Unable to delete team picks");

	const { error: guestsDeleteError } = await supabase
		.from("tournament_guests")
		.delete()
		.eq("tournament_id", tournamentId);
	throwOnError(guestsDeleteError, "Unable to delete guests");

	const { error } = await supabase.from("tournaments").delete().eq("id", tournamentId);
	throwOnError(error, "Unable to delete tournament");
}

export async function getTournament(tournamentId: string): Promise<Tournament | null> {
	const { data, error } = await supabase
		.from("tournaments")
		.select("id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage")
		.eq("id", tournamentId)
		.maybeSingle();
	throwOnError(error, "Unable to load tournament");
	if (!data) return null;
	const tournament = data as Omit<Tournament, "hosted_by">;
	const { data: profileData, error: profileError } = await supabase
		.from("profiles")
		.select("username")
		.eq("id", tournament.created_by)
		.maybeSingle();
	throwOnError(profileError, "Unable to load tournament host");
	return {
		...tournament,
		hosted_by: (profileData?.username as string | undefined) ?? "unknown",
	};
}

export async function listTournamentMembers(tournamentId: string): Promise<TournamentMember[]> {
	const { data, error } = await supabase
		.from("tournament_members")
		.select("tournament_id, user_id, role")
		.eq("tournament_id", tournamentId)
		.order("role", { ascending: true })
		.order("user_id", { ascending: true });
	throwOnError(error, "Unable to load members");

	const memberRows = data ?? [];
	const userIds = [...new Set(memberRows.map((member) => member.user_id).filter(Boolean))];
	if (userIds.length === 0) {
		return [];
	}

	const { data: profileData, error: profileError } = await supabase
		.from("profiles")
		.select("id, username")
		.in("id", userIds);
	throwOnError(profileError, "Unable to load member profiles");

	const usernameMap = new Map<string, string>();
	for (const profile of profileData ?? []) {
		usernameMap.set(profile.id as string, (profile.username as string) ?? "unknown");
	}

	return memberRows.map((member) => ({
		tournament_id: member.tournament_id as string,
		user_id: member.user_id as string,
		role: member.role as string,
		username: usernameMap.get(member.user_id as string) ?? "unknown",
	}));
}

export async function searchProfilesByUsername(query: string, currentUserId: string): Promise<ProfileOption[]> {
	const term = query.toLowerCase().trim();
	if (!term) return [];
	const { data, error } = await supabase
		.from("profiles")
		.select("id, username, role")
		.ilike("username_norm", `${term}%`)
		.neq("id", currentUserId)
		.limit(10);
	throwOnError(error, "Unable to search profiles");
	return (data ?? []) as ProfileOption[];
}

export async function searchRegisteredProfiles(query: string): Promise<RegisteredProfile[]> {
	const term = query.toLowerCase().trim();
	if (!term) return [];

	const { data, error } = await supabase
		.from("profiles")
		.select("id, username")
		.ilike("username_norm", `${term}%`)
		.order("username", { ascending: true })
		.limit(10);
	throwOnError(error, "Unable to search profiles");

	return (data ?? []) as RegisteredProfile[];
}

export async function getPublicProfile(profileId: string): Promise<PublicProfile | null> {
	const { data, error } = await supabase
		.from("profiles")
		.select("id, username, role")
		.eq("id", profileId)
		.maybeSingle();
	throwOnError(error, "Unable to load profile");
	if (!data) return null;
	return data as PublicProfile;
}

export async function getProfileOverview(profileId: string): Promise<ProfileOverview | null> {
	const { data, error } = await supabase.from("profiles").select("id, username").eq("id", profileId).maybeSingle();
	throwOnError(error, "Unable to load profile");
	if (!data) return null;
	return {
		id: data.id as string,
		username: (data.username as string | null) ?? null,
		bio: null,
		favorite_team: null,
		club_preference: null,
	};
}

export async function inviteMember(tournamentId: string, userId: string): Promise<void> {
	const { error } = await supabase.from("tournament_members").insert({
		tournament_id: tournamentId,
		user_id: userId,
		role: "player",
	});
	throwOnError(error, "Unable to invite member");
}

export async function sendFriendRequest(senderUserId: string, receiverUsername: string): Promise<void> {
	const normalizedUsername = receiverUsername.trim().toLowerCase();
	if (!normalizedUsername) {
		throw new Error("Enter a username.");
	}

	const { data: receiver, error: receiverError } = await supabase
		.from("profiles")
		.select("id, username")
		.eq("username_norm", normalizedUsername)
		.maybeSingle();
	throwOnError(receiverError, "Unable to find user profile");

	if (!receiver?.id) {
		throw new Error("User not found.");
	}
	if (receiver.id === senderUserId) {
		throw new Error("You cannot add yourself as a friend.");
	}

	const { data: existing, error: existingError } = await supabase
		.from("friend_requests")
		.select("id, status")
		.or(
			`and(sender_id.eq.${senderUserId},receiver_id.eq.${receiver.id}),and(sender_id.eq.${receiver.id},receiver_id.eq.${senderUserId})`,
		)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	throwOnError(existingError, "Unable to validate friend request status");

	if (existing?.status === "accepted") {
		throw new Error("You are already friends with this user.");
	}
	if (existing?.status === "pending") {
		throw new Error("A pending friend request already exists.");
	}

	const { error } = await supabase.from("friend_requests").insert({
		sender_id: senderUserId,
		receiver_id: receiver.id,
		status: "pending",
	});
	throwOnError(error, "Unable to send friend request");
}

export async function listPendingFriendRequests(userId: string): Promise<FriendRequest[]> {
	const { data, error } = await supabase
		.from("friend_requests")
		.select("id, sender_id, receiver_id, status, created_at")
		.eq("receiver_id", userId)
		.eq("status", "pending")
		.order("created_at", { ascending: false });
	throwOnError(error, "Unable to load friend requests");

	const rows = (data ?? []) as Array<Omit<FriendRequest, "sender_username">>;
	if (rows.length === 0) return [];

	const senderIds = [...new Set(rows.map((row) => row.sender_id))];
	const { data: profileData, error: profileError } = await supabase
		.from("profiles")
		.select("id, username")
		.in("id", senderIds);
	throwOnError(profileError, "Unable to load sender profiles");

	const usernameById = new Map(
		(profileData ?? []).map((profile) => [profile.id as string, profile.username as string]),
	);

	return rows.map((row) => ({
		...row,
		sender_username: usernameById.get(row.sender_id) ?? "unknown",
	}));
}

export async function acceptFriendRequest(requestId: string, receiverUserId: string): Promise<void> {
	const { error } = await supabase.rpc("accept_friend_request", {
		p_request_id: requestId,
		p_receiver_id: receiverUserId,
	});
	throwOnError(error, "Unable to accept friend request");
}

export async function listFriends(userId: string): Promise<FriendProfile[]> {
	const { data, error } = await supabase.from("friendships").select("friend_id").eq("user_id", userId);
	throwOnError(error, "Unable to load friends");

	const friendIds = [...new Set((data ?? []).map((item) => item.friend_id as string).filter(Boolean))];
	if (friendIds.length === 0) return [];

	const { data: profileData, error: profileError } = await supabase
		.from("profiles")
		.select("id, username")
		.in("id", friendIds)
		.order("username", { ascending: true });
	throwOnError(profileError, "Unable to load friend profiles");

	return (profileData ?? []) as FriendProfile[];
}

export async function listParticipants(tournamentId: string): Promise<TournamentParticipant[]> {
	const { data, error } = await supabase
		.from("tournament_participants")
		.select(
			"id, tournament_id, user_id, guest_id, display_name, team_id, locked, created_at, team:teams(id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, off_def_sum, offense, defense, goalie, ovr_tier, last_updated)",
		)
		.eq("tournament_id", tournamentId)
		.order("created_at", { ascending: true });
	throwOnError(error, "Unable to load participants");

	return ((data ?? []) as Array<TournamentParticipant & { team: Team | Team[] | null }>).map((participant) => ({
		...participant,
		team: Array.isArray(participant.team) ? (participant.team[0] ?? null) : participant.team,
	}));
}

export async function fetchTeamsByPool(teamPool: TeamPool): Promise<Team[]> {
	const { data, error } = await supabase
		.from("teams")
		.select(
			"id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, off_def_sum, offense, defense, goalie, ovr_tier, last_updated",
		)
		.eq("team_pool", teamPool)
		.order("name", { ascending: true });
	throwOnError(error, "Unable to load teams");
	return (data ?? []) as Team[];
}

export async function listTeams(): Promise<Team[]> {
	const { data, error } = await supabase
		.from("teams")
		.select(
			"id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, off_def_sum, offense, defense, goalie, ovr_tier, last_updated",
		)
		.order("overall", { ascending: false })
		.order("off_def_sum", { ascending: false })
		.order("goalie", { ascending: false })
		.order("name", { ascending: true });
	throwOnError(error, "Unable to load teams");
	return (data ?? []) as Team[];
}

export async function updateTeamRatings(teamId: string, payload: TeamRatingUpdate): Promise<void> {
	const computedOverall = Math.round((payload.offense + payload.defense + payload.goalie) / 3);
	const { error } = await supabase
		.from("teams")
		.update({
			overall: computedOverall,
			off_def_sum: payload.offense + payload.defense,
			offense: payload.offense,
			defense: payload.defense,
			goalie: payload.goalie,
		})
		.eq("id", teamId);
	throwOnError(error, "Unable to update team ratings");
}

export async function createParticipant(
	tournamentId: string,
	payload: { userId?: string; guestId?: string; displayName: string },
): Promise<void> {
	const { error } = await supabase.from("tournament_participants").insert({
		tournament_id: tournamentId,
		user_id: payload.userId ?? null,
		guest_id: payload.guestId ?? null,
		display_name: payload.displayName,
	});
	throwOnError(error, "Unable to create participant");
}

export async function updateParticipant(participantId: string, teamId: string | null): Promise<void> {
	const { error } = await supabase.from("tournament_participants").update({ team_id: teamId }).eq("id", participantId);
	throwOnError(error, "Unable to update participant");
}

export async function lockParticipant(participantId: string): Promise<void> {
	const { data: authData, error: authError } = await supabase.auth.getUser();
	throwOnError(authError, "Unable to read authenticated user");

	let { error } = await supabase
		.from("tournament_participants")
		.update({ locked: true, locked_by: authData.user?.id ?? null, locked_at: new Date().toISOString() })
		.eq("id", participantId);

	if (error && `${error.message ?? ""}`.toLowerCase().includes("locked_by")) {
		({ error } = await supabase
			.from("tournament_participants")
			.update({ locked: true, locked_by: null, locked_at: new Date().toISOString() })
			.eq("id", participantId));
	}
	throwOnError(error, "Unable to lock participant");
}

export async function removeParticipant(participantId: string): Promise<void> {
	const { error } = await supabase.from("tournament_participants").delete().eq("id", participantId);
	throwOnError(error, "Unable to clear participant slot");
}

export async function listGroups(tournamentId: string): Promise<TournamentGroup[]> {
	const { data, error } = await supabase
		.from("tournament_groups")
		.select("id, tournament_id, group_code")
		.eq("tournament_id", tournamentId)
		.order("group_code", { ascending: true });
	throwOnError(error, "Unable to load groups");
	return (data ?? []) as TournamentGroup[];
}

export async function generateGroupsAndMatches(tournamentId: string): Promise<void> {
	const { error } = await supabase.rpc("generate_group_stage", { p_tournament_id: tournamentId });
	throwOnError(error, "Unable to generate group stage");
}

export async function generatePlayoffs(tournamentId: string): Promise<void> {
	const { error } = await supabase.rpc("generate_playoff_bracket", { p_tournament_id: tournamentId });
	throwOnError(error, "Unable to generate playoff bracket");
}

export async function updateTournamentStatus(tournamentId: string, status: string): Promise<void> {
	const { error } = await supabase.from("tournaments").update({ status }).eq("id", tournamentId);
	throwOnError(error, "Unable to update tournament status");
}

export async function ensurePlayoffBracket(tournamentId: string): Promise<void> {
	const { error } = await supabase.rpc("ensure_playoff_bracket", { p_tournament_id: tournamentId });
	throwOnError(error, "Unable to ensure playoff bracket");
}

export async function listGroupStandings(tournamentId: string): Promise<GroupStanding[]> {
	const { data, error } = await supabase
		.from("v_group_standings")
		.select(
			"tournament_id, group_id, rank_in_group, participant_id, team_id, points, goals_for, goals_against, goal_diff, shots_diff",
		)
		.eq("tournament_id", tournamentId)
		.order("group_id", { ascending: true })
		.order("rank_in_group", { ascending: true });
	throwOnError(error, "Unable to load standings");
	return (data ?? []) as GroupStanding[];
}

export async function listMatchesWithResults(tournamentId: string, stage?: MatchStage): Promise<MatchWithResult[]> {
	let query = supabase
		.from("matches")
		.select(
			"id, tournament_id, home_participant_id, away_participant_id, round, bracket_slot, next_match_id, next_match_side, created_at, stage, bracket_type, home_participant:tournament_participants!matches_home_participant_id_fkey(display_name,team_id), away_participant:tournament_participants!matches_away_participant_id_fkey(display_name,team_id)",
		)
		.eq("tournament_id", tournamentId)
		.order("round", { ascending: true })
		.order("created_at", { ascending: true });
	if (stage) {
		query = query.eq("stage", stage);
	}
	const { data: matches, error: matchesError } = await query;
	throwOnError(matchesError, "Unable to load matches");

	const matchRows = (matches ?? []) as Array<
		Match & {
			home_participant:
				| { display_name: string; team_id: string | null }
				| Array<{ display_name: string; team_id: string | null }>
				| null;
			away_participant:
				| { display_name: string; team_id: string | null }
				| Array<{ display_name: string; team_id: string | null }>
				| null;
		}
	>;
	if (matchRows.length === 0) {
		return [];
	}

	const matchIds = matchRows.map((match) => match.id);
	const { data: results, error: resultsError } = await supabase
		.from("match_results")
		.select("match_id, home_score, away_score, home_shots, away_shots, decision, locked")
		.in("match_id", matchIds);
	throwOnError(resultsError, "Unable to load match results");

	const resultMap = new Map<string, MatchResult>();
	for (const result of results ?? []) {
		resultMap.set(result.match_id as string, {
			match_id: result.match_id as string,
			home_score: result.home_score as number | null,
			away_score: result.away_score as number | null,
			home_shots: result.home_shots as number | null,
			away_shots: result.away_shots as number | null,
			decision: (result.decision as MatchParticipantDecision | null) ?? null,
			locked: Boolean(result.locked),
		});
	}

	return matchRows.map((match) => {
		const homeParticipant = Array.isArray(match.home_participant) ? match.home_participant[0] : match.home_participant;
		const awayParticipant = Array.isArray(match.away_participant) ? match.away_participant[0] : match.away_participant;

		const placeholderName = match.stage === "PLAYOFF" ? "TBD" : "BYE";

		return {
			id: match.id,
			tournament_id: match.tournament_id,
			home_participant_id: match.home_participant_id,
			away_participant_id: match.away_participant_id,
			round: match.round,
			bracket_slot: match.bracket_slot,
			next_match_id: match.next_match_id,
			next_match_side: (match.next_match_side as "HOME" | "AWAY" | null) ?? null,
			created_at: match.created_at,
			stage: match.stage,
			bracket_type: match.bracket_type,
			home_participant_name: homeParticipant?.display_name ?? placeholderName,
			away_participant_name: awayParticipant?.display_name ?? placeholderName,
			home_team_id: homeParticipant?.team_id ?? null,
			away_team_id: awayParticipant?.team_id ?? null,
			result: resultMap.get(match.id) ?? null,
		};
	});
}

export async function upsertMatchResult(
	matchId: string,
	homeScore: number,
	awayScore: number,
	homeShots: number,
	awayShots: number,
	decision: MatchParticipantDecision,
): Promise<void> {
	const { error } = await supabase.from("match_results").upsert(
		{
			match_id: matchId,
			home_score: homeScore,
			away_score: awayScore,
			home_shots: homeShots,
			away_shots: awayShots,
			decision,
		},
		{ onConflict: "match_id" },
	);
	throwOnError(error, "Unable to save match result");
}

export async function listTournamentGuests(tournamentId: string): Promise<TournamentGuest[]> {
	const { data, error } = await supabase
		.from("tournament_guests")
		.select("id, tournament_id, display_name")
		.eq("tournament_id", tournamentId)
		.order("display_name", { ascending: true });
	throwOnError(error, "Unable to load guests");
	return (data ?? []) as TournamentGuest[];
}

export async function addTournamentGuest(tournamentId: string, displayName: string): Promise<TournamentGuest> {
	const { data, error } = await supabase
		.from("tournament_guests")
		.insert({
			tournament_id: tournamentId,
			display_name: displayName,
		})
		.select("id, tournament_id, display_name")
		.single();
	throwOnError(error, "Unable to add guest");
	return data as TournamentGuest;
}

export async function removeTournamentGuest(tournamentId: string, guestId: string): Promise<void> {
	const { error } = await supabase
		.from("tournament_guests")
		.delete()
		.match({ tournament_id: tournamentId, id: guestId });
	throwOnError(error, "Unable to remove guest");
}

export async function lockMatchResult(matchId: string): Promise<void> {
	const { error } = await supabase.from("match_results").update({ locked: true }).eq("match_id", matchId);
	throwOnError(error, "Unable to lock result");
}

export async function listUserTeamStats(userId: string): Promise<PlayerTeamStat[]> {
	const { data: participantsData, error: participantsError } = await supabase
		.from("tournament_participants")
		.select("id, tournament_id, team_id, team:teams(id, code, name, team_pool)")
		.eq("user_id", userId)
		.not("team_id", "is", null);
	throwOnError(participantsError, "Unable to load player participants");

	const participants = (participantsData ?? []) as Array<{
		id: string;
		tournament_id: string;
		team_id: string;
		team:
			| { id: string; code: string; name: string; team_pool: TeamPool }
			| Array<{ id: string; code: string; name: string; team_pool: TeamPool }>
			| null;
	}>;

	if (participants.length === 0) {
		return [];
	}

	const participantToTeam = new Map<
		string,
		{ team_id: string; team_code: string; team_pool: TeamPool; team_name: string; tournament_id: string }
	>();
	const tournamentTeamKeys = new Set<string>();
	for (const participant of participants) {
		const team = Array.isArray(participant.team) ? participant.team[0] : participant.team;
		if (!participant.team_id || !team) continue;
		tournamentTeamKeys.add(`${participant.tournament_id}:${participant.team_id}`);
		participantToTeam.set(participant.id, {
			team_id: participant.team_id,
			team_code: team.code,
			team_pool: team.team_pool,
			team_name: team.name,
			tournament_id: participant.tournament_id,
		});
	}

	const tournamentIds = [...new Set([...participantToTeam.values()].map((row) => row.tournament_id))];
	if (participantToTeam.size === 0 || tournamentIds.length === 0) {
		return [];
	}
	const { data: tournamentParticipantsData, error: tournamentParticipantsError } = await supabase
		.from("tournament_participants")
		.select("id, tournament_id, team_id")
		.in("tournament_id", tournamentIds)
		.not("team_id", "is", null);
	throwOnError(tournamentParticipantsError, "Unable to load teammate participants");

	const allowedParticipantIds = new Set<string>();
	const participantMetaById = new Map<string, { tournament_id: string; team_id: string }>();
	for (const row of tournamentParticipantsData ?? []) {
		const participantId = row.id as string;
		const tournamentId = row.tournament_id as string;
		const teamId = row.team_id as string | null;
		if (!participantId || !tournamentId || !teamId) continue;
		participantMetaById.set(participantId, { tournament_id: tournamentId, team_id: teamId });
		if (tournamentTeamKeys.has(`${tournamentId}:${teamId}`)) {
			allowedParticipantIds.add(participantId);
		}
	}

	const teamMetaByTournamentTeam = new Map<
		string,
		{ team_id: string; team_code: string; team_pool: TeamPool; team_name: string; tournament_id: string }
	>();
	for (const value of participantToTeam.values()) {
		teamMetaByTournamentTeam.set(`${value.tournament_id}:${value.team_id}`, value);
	}

	const scopedParticipantIds = [...allowedParticipantIds];
	if (scopedParticipantIds.length === 0) return [];
	const participantsFilter = scopedParticipantIds.join(",");

	const { data: matchesData, error: matchesError } = await supabase
		.from("matches")
		.select("id, tournament_id, stage, bracket_type, round, next_match_id, home_participant_id, away_participant_id")
		.or(`home_participant_id.in.(${participantsFilter}),away_participant_id.in.(${participantsFilter})`);
	throwOnError(matchesError, "Unable to load player matches");

	const matches = (matchesData ?? []) as Array<{
		id: string;
		tournament_id: string;
		stage: MatchStage;
		bracket_type: BracketType | null;
		round: number;
		next_match_id: string | null;
		home_participant_id: string | null;
		away_participant_id: string | null;
	}>;

	if (matches.length === 0) {
		return [];
	}

	const matchIds = matches.map((match) => match.id);
	const { data: resultsData, error: resultsError } = await supabase
		.from("match_results")
		.select("match_id, home_score, away_score, home_shots, away_shots")
		.in("match_id", matchIds);
	throwOnError(resultsError, "Unable to load player match results");

	const resultsByMatch = new Map<
		string,
		{
			home_score: number;
			away_score: number;
			home_shots: number;
			away_shots: number;
		}
	>();

	for (const result of resultsData ?? []) {
		if (
			typeof result.home_score !== "number" ||
			typeof result.away_score !== "number" ||
			typeof result.home_shots !== "number" ||
			typeof result.away_shots !== "number"
		) {
			continue;
		}

		resultsByMatch.set(result.match_id as string, {
			home_score: result.home_score,
			away_score: result.away_score,
			home_shots: result.home_shots,
			away_shots: result.away_shots,
		});
	}

	const aggregates = new Map<string, PlayerTeamStat>();

	for (const match of matches) {
		const result = resultsByMatch.get(match.id);
		if (!result) continue;

		const resolveTeamMeta = (participantId: string | null) => {
			if (!participantId || !allowedParticipantIds.has(participantId)) return null;
			const direct = participantToTeam.get(participantId);
			if (direct) return direct;
			const participantMeta = participantMetaById.get(participantId);
			if (!participantMeta) return null;
			return teamMetaByTournamentTeam.get(`${participantMeta.tournament_id}:${participantMeta.team_id}`) ?? null;
		};

		const isHome = resolveTeamMeta(match.home_participant_id);
		const isAway = resolveTeamMeta(match.away_participant_id);

		if (!isHome && !isAway) continue;

		const row = isHome
			? {
					team_id: isHome.team_id,
					team_code: isHome.team_code,
					team_pool: isHome.team_pool,
					team_name: isHome.team_name,
					shots_made: result.home_shots,
					goals_made: result.home_score,
					shots_received: result.away_shots,
					goals_received: result.away_score,
				}
			: isAway
				? {
						team_id: isAway.team_id,
						team_code: isAway.team_code,
						team_pool: isAway.team_pool,
						team_name: isAway.team_name,
						shots_made: result.away_shots,
						goals_made: result.away_score,
						shots_received: result.home_shots,
						goals_received: result.home_score,
					}
				: null;

		if (!row) continue;

		const current = aggregates.get(row.team_id) ?? {
			team_id: row.team_id,
			team_code: row.team_code,
			team_pool: row.team_pool,
			team_name: row.team_name,
			games_played: 0,
			wins: 0,
			losses: 0,
			shots_made: 0,
			goals_made: 0,
			shots_received: 0,
			goals_received: 0,
			goalie_save_rate: 0,
		};

		current.games_played += 1;
		if (row.goals_made > row.goals_received) {
			current.wins += 1;
		} else if (row.goals_made < row.goals_received) {
			current.losses += 1;
		}
		current.shots_made += row.shots_made;
		current.goals_made += row.goals_made;
		current.shots_received += row.shots_received;
		current.goals_received += row.goals_received;

		aggregates.set(row.team_id, current);
	}

	return [...aggregates.values()]
		.map((stat) => ({
			...stat,
			goalie_save_rate:
				stat.shots_received > 0
					? Number(((stat.shots_received - stat.goals_received) / stat.shots_received).toFixed(3))
					: 0,
		}))
		.sort((a, b) => b.games_played - a.games_played || a.team_name.localeCompare(b.team_name));
}

export async function countUserTournamentWins(userId: string): Promise<number> {
	const { data: participantsData, error: participantsError } = await supabase
		.from("tournament_participants")
		.select("id, tournament_id, team_id")
		.eq("user_id", userId);
	throwOnError(participantsError, "Unable to load player participants");

	const participantRows = (participantsData ?? []) as Array<{
		id: string;
		tournament_id: string;
		team_id: string | null;
	}>;
	const participantIds = participantRows.map((item) => item.id).filter(Boolean);
	const userTournamentTeamKeys = new Set(
		participantRows.filter((item) => item.team_id).map((item) => `${item.tournament_id}:${item.team_id}`),
	);
	if (participantIds.length === 0 && userTournamentTeamKeys.size === 0) {
		return 0;
	}

	const participantsFilter = participantIds.join(",");
	const { data: finalsData, error: finalsError } = await supabase
		.from("matches")
		.select("id, tournament_id, round, home_participant_id, away_participant_id")
		.eq("stage", "PLAYOFF")
		.is("next_match_id", null)
		.neq("bracket_type", "LOSERS")
		.or(`home_participant_id.in.(${participantsFilter}),away_participant_id.in.(${participantsFilter})`);
	throwOnError(finalsError, "Unable to load playoff finals");

	const finals = (finalsData ?? []) as Array<{
		id: string;
		tournament_id: string;
		round: number;
		home_participant_id: string | null;
		away_participant_id: string | null;
	}>;

	if (finals.length === 0) {
		return 0;
	}

	const { data: resultsData, error: resultsError } = await supabase
		.from("match_results")
		.select("match_id, home_score, away_score")
		.in(
			"match_id",
			finals.map((item) => item.id),
		);
	throwOnError(resultsError, "Unable to load playoff final results");

	const resultByMatch = new Map<string, { home_score: number; away_score: number }>();
	for (const result of resultsData ?? []) {
		if (typeof result.home_score !== "number" || typeof result.away_score !== "number") continue;
		resultByMatch.set(result.match_id as string, {
			home_score: result.home_score,
			away_score: result.away_score,
		});
	}

	const participantIdSet = new Set(participantIds);
	const wonTournaments = new Set<string>();
	const finalsByTournament = new Map<string, typeof finals>();

	const finalParticipantIds = new Set<string>();
	for (const final of finals) {
		if (final.home_participant_id) finalParticipantIds.add(final.home_participant_id);
		if (final.away_participant_id) finalParticipantIds.add(final.away_participant_id);
	}

	const { data: finalParticipantsData, error: finalParticipantsError } = await supabase
		.from("tournament_participants")
		.select("id, tournament_id, team_id")
		.in("id", [...finalParticipantIds]);
	throwOnError(finalParticipantsError, "Unable to load final participants");
	const finalParticipantMetaById = new Map<string, { tournament_id: string; team_id: string | null }>();
	for (const row of finalParticipantsData ?? []) {
		finalParticipantMetaById.set(row.id as string, {
			tournament_id: row.tournament_id as string,
			team_id: (row.team_id as string | null) ?? null,
		});
	}

	for (const final of finals) {
		const current = finalsByTournament.get(final.tournament_id) ?? [];
		current.push(final);
		finalsByTournament.set(final.tournament_id, current);
	}

	for (const [tournamentId, tournamentFinals] of finalsByTournament.entries()) {
		const finalRound = Math.max(...tournamentFinals.map((item) => item.round));
		const candidates = tournamentFinals.filter((item) => item.round === finalRound);

		for (const candidate of candidates) {
			const result = resultByMatch.get(candidate.id);
			if (!result || result.home_score === result.away_score) continue;

			const winnerId =
				result.home_score > result.away_score ? candidate.home_participant_id : candidate.away_participant_id;
			if (!winnerId) continue;
			if (!participantIdSet.has(winnerId)) {
				const winnerMeta = finalParticipantMetaById.get(winnerId);
				const winnerTeamKey = winnerMeta?.team_id ? `${winnerMeta.tournament_id}:${winnerMeta.team_id}` : null;
				if (!winnerTeamKey || !userTournamentTeamKeys.has(winnerTeamKey)) continue;
			}

			wonTournaments.add(tournamentId);
		}
	}

	return wonTournaments.size;
}

export async function listClosedTournaments(): Promise<Array<{ id: string; name: string }>> {
	const { data, error } = await supabase
		.from("tournaments")
		.select("id, name, status")
		.ilike("status", "closed")
		.order("created_at", { ascending: false });
	throwOnError(error, "Unable to load closed tournaments");

	return (data ?? []).map((item) => ({
		id: item.id as string,
		name: item.name as string,
	}));
}

export async function listTournamentTeamStats(tournamentId: string): Promise<TournamentTeamStat[]> {
	const { data: participantsData, error: participantsError } = await supabase
		.from("tournament_participants")
		.select("id, team_id, guest_id, display_name, team:teams(id, code, name, team_pool)")
		.eq("tournament_id", tournamentId)
		.not("team_id", "is", null);
	throwOnError(participantsError, "Unable to load tournament participants");

	const participantTeamMeta = new Map<
		string,
		{ team_id: string; team_code: string; team_name: string; team_pool: TeamPool }
	>();
	const teamPlayerNameByTeamId = new Map<string, string>();

	for (const row of participantsData ?? []) {
		const participantId = row.id as string;
		const teamId = row.team_id as string | null;
		const isGuest = Boolean(row.guest_id as string | null);
		const displayName = (row.display_name as string | null)?.trim() ?? null;
		const teamRaw = row.team as
			| { id: string; code: string; name: string; team_pool: TeamPool }
			| Array<{ id: string; code: string; name: string; team_pool: TeamPool }>
			| null;
		const team = Array.isArray(teamRaw) ? teamRaw[0] : teamRaw;
		if (!participantId || !teamId || !team) continue;
		participantTeamMeta.set(participantId, {
			team_id: teamId,
			team_code: team.code,
			team_name: team.name,
			team_pool: team.team_pool,
		});

		if (!displayName) continue;
		const existingName = teamPlayerNameByTeamId.get(teamId);
		if (!existingName || isGuest) {
			teamPlayerNameByTeamId.set(teamId, displayName);
		}
	}

	if (participantTeamMeta.size === 0) return [];

	const { data: matchesData, error: matchesError } = await supabase
		.from("matches")
		.select("id, round, stage, bracket_type, next_match_id, bracket_slot, home_participant_id, away_participant_id")
		.eq("tournament_id", tournamentId);
	throwOnError(matchesError, "Unable to load tournament matches");

	const matches = (matchesData ?? []) as Array<{
		id: string;
		round: number;
		stage: MatchStage;
		bracket_type: BracketType | null;
		next_match_id: string | null;
		bracket_slot: number | null;
		home_participant_id: string | null;
		away_participant_id: string | null;
	}>;
	if (matches.length === 0) return [];

	const { data: resultsData, error: resultsError } = await supabase
		.from("match_results")
		.select("match_id, home_score, away_score, home_shots, away_shots")
		.in(
			"match_id",
			matches.map((item) => item.id),
		);
	throwOnError(resultsError, "Unable to load tournament match results");

	const resultsByMatchId = new Map<
		string,
		{ home_score: number; away_score: number; home_shots: number; away_shots: number }
	>();
	for (const result of resultsData ?? []) {
		if (
			typeof result.home_score !== "number" ||
			typeof result.away_score !== "number" ||
			typeof result.home_shots !== "number" ||
			typeof result.away_shots !== "number"
		) {
			continue;
		}
		resultsByMatchId.set(result.match_id as string, {
			home_score: result.home_score,
			away_score: result.away_score,
			home_shots: result.home_shots,
			away_shots: result.away_shots,
		});
	}

	const aggregates = new Map<string, TournamentTeamStat>();
	for (const match of matches) {
		const result = resultsByMatchId.get(match.id);
		if (!result || result.home_score === result.away_score) continue;

		const homeMeta = match.home_participant_id ? participantTeamMeta.get(match.home_participant_id) : null;
		const awayMeta = match.away_participant_id ? participantTeamMeta.get(match.away_participant_id) : null;
		if (!homeMeta || !awayMeta) continue;

		for (const [meta, goalsMade, goalsReceived, shotsMade, shotsReceived] of [
			[homeMeta, result.home_score, result.away_score, result.home_shots, result.away_shots],
			[awayMeta, result.away_score, result.home_score, result.away_shots, result.home_shots],
		] as const) {
			const current = aggregates.get(meta.team_id) ?? {
				team_id: meta.team_id,
				team_code: meta.team_code,
				team_pool: meta.team_pool,
				team_name: meta.team_name,
				games_played: 0,
				wins: 0,
				losses: 0,
				shots_made: 0,
				goals_made: 0,
				shots_received: 0,
				goals_received: 0,
				goalie_save_rate: 0,
				placement: null,
				player_name: teamPlayerNameByTeamId.get(meta.team_id) ?? null,
			};

			current.games_played += 1;
			if (goalsMade > goalsReceived) current.wins += 1;
			if (goalsMade < goalsReceived) current.losses += 1;
			current.shots_made += shotsMade;
			current.goals_made += goalsMade;
			current.shots_received += shotsReceived;
			current.goals_received += goalsReceived;
			aggregates.set(meta.team_id, current);
		}
	}

	const playoffMatches = matches.filter((match) => match.stage === "PLAYOFF");
	const placementByParticipantId = new Map<string, number>();
	const resolveWinnerLoser = (matchId: string, homeId: string | null, awayId: string | null) => {
		const result = resultsByMatchId.get(matchId);
		if (!result || !homeId || !awayId || result.home_score === result.away_score) return null;
		return result.home_score > result.away_score
			? { winner: homeId, loser: awayId }
			: { winner: awayId, loser: homeId };
	};

	const finals = playoffMatches.filter((match) => !match.next_match_id && match.bracket_type !== "LOSERS");
	const finalRound = finals.length > 0 ? Math.max(...finals.map((item) => item.round)) : null;
	if (finalRound !== null) {
		const finalMatch = finals.find(
			(item) =>
				item.round === finalRound && resolveWinnerLoser(item.id, item.home_participant_id, item.away_participant_id),
		);
		if (finalMatch) {
			const outcome = resolveWinnerLoser(finalMatch.id, finalMatch.home_participant_id, finalMatch.away_participant_id);
			if (outcome) {
				placementByParticipantId.set(outcome.winner, 1);
				placementByParticipantId.set(outcome.loser, 2);
			}
		}
	}

	const placementMatches = playoffMatches.filter((match) => match.bracket_type === "LOSERS");
	if (placementMatches.length > 0) {
		const placementFinalRound = Math.max(...placementMatches.map((item) => item.round));
		const bronze = placementMatches.find(
			(item) => item.round === placementFinalRound && (item.bracket_slot ?? 0) === 1,
		);
		const fifth = placementMatches.find((item) => item.round === placementFinalRound && (item.bracket_slot ?? 0) === 2);
		const bronzeOutcome = bronze
			? resolveWinnerLoser(bronze.id, bronze.home_participant_id, bronze.away_participant_id)
			: null;
		if (bronzeOutcome) {
			if (!placementByParticipantId.has(bronzeOutcome.winner)) placementByParticipantId.set(bronzeOutcome.winner, 3);
			if (!placementByParticipantId.has(bronzeOutcome.loser)) placementByParticipantId.set(bronzeOutcome.loser, 4);
		}

		const fifthOutcome = fifth
			? resolveWinnerLoser(fifth.id, fifth.home_participant_id, fifth.away_participant_id)
			: null;
		if (fifthOutcome) {
			if (!placementByParticipantId.has(fifthOutcome.winner)) placementByParticipantId.set(fifthOutcome.winner, 5);
			if (!placementByParticipantId.has(fifthOutcome.loser)) placementByParticipantId.set(fifthOutcome.loser, 6);
		}
	}

	for (const [participantId, placement] of placementByParticipantId.entries()) {
		const teamId = participantTeamMeta.get(participantId)?.team_id;
		if (!teamId) continue;
		const row = aggregates.get(teamId);
		if (!row || row.placement === 1) continue;
		if (row.placement === null || placement < row.placement) row.placement = placement;
	}

	return [...aggregates.values()]
		.map((stat) => ({
			...stat,
			goalie_save_rate:
				stat.shots_received > 0
					? Number(((stat.shots_received - stat.goals_received) / stat.shots_received).toFixed(3))
					: 0,
		}))
		.sort((a, b) => {
			if (a.placement !== null && b.placement !== null) return a.placement - b.placement;
			if (a.placement !== null) return -1;
			if (b.placement !== null) return 1;
			return b.wins - a.wins || b.games_played - a.games_played || a.team_name.localeCompare(b.team_name);
		});
}
