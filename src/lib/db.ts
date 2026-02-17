import { supabase } from "@/lib/supabaseClient";

export type TournamentPreset = "playoffs_only" | "full_tournament";
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
	offense: number;
	defense: number;
	goalie: number;
	ovr_tier: "Top 5" | "Top 10" | "Middle Tier" | "Bottom Tier";
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
	group_code: string;
	participant_id: string;
	display_name: string;
	team_id: string | null;
	team_code: string | null;
	team_short_name: string | null;
	team_primary_color: string | null;
	team_secondary_color: string | null;
	team_text_color: string | null;
	points: number;
	goal_diff: number;
	shots_diff: number;
};

function throwOnError(error: { message: string } | null, fallbackMessage: string): void {
	if (error) {
		throw new Error(error.message || fallbackMessage);
	}
}

export function sanitizeGroupCount(
	participants: number,
	selectedGroups: number,
): { groupCount: number; note: string | null; error: string | null } {
	let groupCount = selectedGroups;
	let note: string | null = null;
	while (groupCount > 1) {
		const minGroupSize = Math.floor(participants / groupCount);
		if (minGroupSize >= 3) break;
		groupCount -= 1;
		note = `Adjusted to ${groupCount} groups to keep at least 3 participants per group.`;
	}

	while (participants > groupCount * 6 && groupCount < 4) {
		groupCount += 1;
		note = `Adjusted to ${groupCount} groups to keep groups at max 6 participants.`;
	}

	if (participants > groupCount * 6) {
		return { groupCount, note, error: "Too many participants for max 4 groups (max 6 per group)." };
	}

	if (Math.floor(participants / groupCount) < 3) {
		return { groupCount, note, error: "Not enough participants for selected group count." };
	}

	return { groupCount, note, error: null };
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
		hosted_by: usernameById.get(item.created_by) ?? "unknown",
	}));
}

export async function createTournament(payload: {
	name: string;
	presetId: TournamentPreset;
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

	const { data, error } = await supabase
		.from("tournaments")
		.insert({
			name: payload.name,
			preset_id: payload.presetId,
			created_by: userId,
			team_pool: payload.teamPool,
			default_participants: payload.defaultParticipants,
			group_count: payload.groupCount,
			stage: payload.presetId === "playoffs_only" ? "PLAYOFF" : "GROUP",
		})
		.select("id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage")
		.single();

	throwOnError(error, "Unable to create tournament");
	return {
		...(data as Omit<Tournament, "hosted_by">),
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

export async function inviteMember(tournamentId: string, userId: string): Promise<void> {
	const { error } = await supabase.from("tournament_members").insert({
		tournament_id: tournamentId,
		user_id: userId,
		role: "player",
	});
	throwOnError(error, "Unable to invite member");
}

export async function listParticipants(tournamentId: string): Promise<TournamentParticipant[]> {
	const { data, error } = await supabase
		.from("tournament_participants")
		.select(
			"id, tournament_id, user_id, guest_id, display_name, team_id, locked, created_at, team:teams(id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, offense, defense, goalie, ovr_tier)",
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
			"id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, offense, defense, goalie, ovr_tier",
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
			"id, code, name, short_name, team_pool, primary_color, secondary_color, text_color, overall, offense, defense, goalie, ovr_tier",
		)
		.order("overall", { ascending: false })
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
	const { error } = await supabase.from("tournament_participants").update({ locked: true }).eq("id", participantId);
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

export async function listGroupStandings(tournamentId: string): Promise<GroupStanding[]> {
	const { data, error } = await supabase
		.from("v_group_standings")
		.select(
			"tournament_id, group_id, group_code, participant_id, display_name, team_id, team_code, team_short_name, team_primary_color, team_secondary_color, team_text_color, points, goal_diff, shots_diff",
		)
		.eq("tournament_id", tournamentId)
		.order("group_code", { ascending: true })
		.order("points", { ascending: false })
		.order("goal_diff", { ascending: false })
		.order("shots_diff", { ascending: false });
	throwOnError(error, "Unable to load standings");
	return (data ?? []) as GroupStanding[];
}

export async function listMatchesWithResults(tournamentId: string, stage?: MatchStage): Promise<MatchWithResult[]> {
	let query = supabase
		.from("matches")
		.select(
			"id, tournament_id, home_participant_id, away_participant_id, round, created_at, stage, bracket_type, home_participant:tournament_participants!matches_home_participant_id_fkey(display_name,team_id), away_participant:tournament_participants!matches_away_participant_id_fkey(display_name,team_id)",
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

		return {
			id: match.id,
			tournament_id: match.tournament_id,
			home_participant_id: match.home_participant_id,
			away_participant_id: match.away_participant_id,
			round: match.round,
			created_at: match.created_at,
			stage: match.stage,
			bracket_type: match.bracket_type,
			home_participant_name: homeParticipant?.display_name ?? "BYE",
			away_participant_name: awayParticipant?.display_name ?? "BYE",
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
