import { supabase } from "@/lib/supabaseClient";

export type Tournament = {
	id: string;
	name: string;
	status: string | null;
	created_at: string;
	preset_id: string | null;
	created_by: string;
};

export type TournamentMember = {
	id: string;
	tournament_id: string;
	user_id: string;
	role: string;
	username: string;
};

export type Match = {
	id: string;
	tournament_id: string;
	home_user_id: string;
	away_user_id: string;
	round: number;
	created_at: string;
};

export type MatchResult = {
	id: string;
	match_id: string;
	home_score: number | null;
	away_score: number | null;
	home_shots: number | null;
	away_shots: number | null;
	locked: boolean;
};

export type MatchWithResult = Match & {
	result: MatchResult | null;
};

export type ProfileOption = {
	id: string;
	username: string;
	role: string | null;
};

function throwOnError(error: { message: string } | null, fallbackMessage: string): void {
	if (error) {
		throw new Error(error.message || fallbackMessage);
	}
}

export async function listTournaments(): Promise<Tournament[]> {
	const { data, error } = await supabase
		.from("tournaments")
		.select("id, name, status, created_at, preset_id, created_by")
		.order("created_at", { ascending: false });
	throwOnError(error, "Unable to load tournaments");
	return (data ?? []) as Tournament[];
}

export async function createTournament(name: string, presetId: string): Promise<Tournament> {
	const { data: authData, error: authError } = await supabase.auth.getUser();
	throwOnError(authError, "Unable to read authenticated user");

	const userId = authData.user?.id;
	if (!userId) {
		throw new Error("User is not authenticated.");
	}

	const { data, error } = await supabase
		.from("tournaments")
		.insert({
			name,
			preset_id: presetId,
			created_by: userId,
		})
		.select("id, name, status, created_at, preset_id, created_by")
		.single();

	throwOnError(error, "Unable to create tournament");
	return data as Tournament;
}

export async function getTournament(tournamentId: string): Promise<Tournament | null> {
	const { data, error } = await supabase
		.from("tournaments")
		.select("id, name, status, created_at, preset_id, created_by")
		.eq("id", tournamentId)
		.maybeSingle();
	throwOnError(error, "Unable to load tournament");
	return (data as Tournament | null) ?? null;
}

export async function listTournamentMembers(tournamentId: string): Promise<TournamentMember[]> {
	const { data, error } = await supabase
		.from("tournament_members")
		.select("id, tournament_id, user_id, role")
		.eq("tournament_id", tournamentId)
		.order("created_at", { ascending: true });
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
		id: member.id as string,
		tournament_id: member.tournament_id as string,
		user_id: member.user_id as string,
		role: member.role as string,
		username: usernameMap.get(member.user_id as string) ?? "unknown",
	}));
}

export async function searchProfilesByUsername(query: string): Promise<ProfileOption[]> {
	if (!query.trim()) return [];
	const { data, error } = await supabase
		.from("profiles")
		.select("id, username, role")
		.ilike("username", `%${query.trim()}%`)
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

export async function listMatchesWithResults(tournamentId: string): Promise<MatchWithResult[]> {
	const { data: matches, error: matchesError } = await supabase
		.from("matches")
		.select("id, tournament_id, home_user_id, away_user_id, round, created_at")
		.eq("tournament_id", tournamentId)
		.order("round", { ascending: true })
		.order("created_at", { ascending: true });
	throwOnError(matchesError, "Unable to load matches");

	const matchRows = (matches ?? []) as Match[];
	if (matchRows.length === 0) {
		return [];
	}

	const matchIds = matchRows.map((match) => match.id);
	const { data: results, error: resultsError } = await supabase
		.from("match_results")
		.select("id, match_id, home_score, away_score, home_shots, away_shots, locked")
		.in("match_id", matchIds);
	throwOnError(resultsError, "Unable to load match results");

	const resultMap = new Map<string, MatchResult>();
	for (const result of results ?? []) {
		resultMap.set(result.match_id as string, {
			id: result.id as string,
			match_id: result.match_id as string,
			home_score: result.home_score as number | null,
			away_score: result.away_score as number | null,
			home_shots: result.home_shots as number | null,
			away_shots: result.away_shots as number | null,
			locked: Boolean(result.locked),
		});
	}

	return matchRows.map((match) => ({
		...match,
		result: resultMap.get(match.id) ?? null,
	}));
}

export async function createMatch(
	tournamentId: string,
	homeUserId: string,
	awayUserId: string,
	round: number,
): Promise<void> {
	const { error } = await supabase.from("matches").insert({
		tournament_id: tournamentId,
		home_user_id: homeUserId,
		away_user_id: awayUserId,
		round,
	});
	throwOnError(error, "Unable to create match");
}

export async function upsertMatchResult(
	matchId: string,
	homeScore: number,
	awayScore: number,
	homeShots: number,
	awayShots: number,
): Promise<void> {
	const { error } = await supabase.from("match_results").upsert(
		{
			match_id: matchId,
			home_score: homeScore,
			away_score: awayScore,
			home_shots: homeShots,
			away_shots: awayShots,
		},
		{ onConflict: "match_id" },
	);
	throwOnError(error, "Unable to save match result");
}

export async function lockMatchResult(matchId: string): Promise<void> {
	const { error } = await supabase.from("match_results").update({ locked: true }).eq("match_id", matchId);
	throwOnError(error, "Unable to lock result");
}
