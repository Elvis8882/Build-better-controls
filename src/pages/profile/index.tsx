import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	countUserTournamentWins,
	listClosedTournaments,
	listFriends,
	listTournamentTeamStats,
	listUserTeamStats,
	type PlayerTeamStat,
	type RegisteredProfile,
	searchRegisteredProfiles,
	type TournamentTeamStat,
} from "@/lib/db";
import { getTeamLogoUrl } from "@/lib/teamLogos";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

function formatSaveRate(value: number): string {
	return value.toFixed(3);
}

export default function ProfilePage() {
	const { user, profile } = useAuth();
	const [loading, setLoading] = useState(true);
	const [stats, setStats] = useState<PlayerTeamStat[]>([]);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<RegisteredProfile[]>([]);
	const [selectedUser, setSelectedUser] = useState<RegisteredProfile | null>(null);
	const [friends, setFriends] = useState<RegisteredProfile[]>([]);
	const [friendSelection, setFriendSelection] = useState("");
	const [activeTab, setActiveTab] = useState<"players" | "tournaments">("players");
	const [closedTournaments, setClosedTournaments] = useState<Array<{ id: string; name: string }>>([]);
	const [selectedTournamentId, setSelectedTournamentId] = useState("");
	const [tournamentStats, setTournamentStats] = useState<TournamentTeamStat[]>([]);
	const [tournamentStatsLoading, setTournamentStatsLoading] = useState(false);
	const [tournamentWins, setTournamentWins] = useState(0);

	useEffect(() => {
		if (!user?.id || !profile?.username) return;
		setSelectedUser({ id: user.id, username: profile.username });
	}, [profile?.username, user?.id]);

	const loadStats = useCallback(async (targetUserId: string | undefined) => {
		if (!targetUserId) {
			setStats([]);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			const [rows, totalTournamentWins] = await Promise.all([
				listUserTeamStats(targetUserId),
				countUserTournamentWins(targetUserId),
			]);
			setStats(rows);
			setTournamentWins(totalTournamentWins);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadStats(selectedUser?.id);
	}, [loadStats, selectedUser?.id]);

	useEffect(() => {
		if (!user?.id) return;

		void (async () => {
			try {
				const [friendRows, tournamentRows] = await Promise.all([listFriends(user.id), listClosedTournaments()]);
				setFriends(friendRows.map((item) => ({ id: item.id, username: item.username })));
				setClosedTournaments(tournamentRows);
				if (tournamentRows.length > 0) {
					setSelectedTournamentId((current) => current || tournamentRows[0].id);
				}
			} catch (error) {
				toast.error((error as Error).message);
			}
		})();
	}, [user?.id]);

	useEffect(() => {
		if (!selectedTournamentId) {
			setTournamentStats([]);
			return;
		}

		void (async () => {
			try {
				setTournamentStatsLoading(true);
				const rows = await listTournamentTeamStats(selectedTournamentId);
				setTournamentStats(rows);
			} catch (error) {
				toast.error((error as Error).message);
			} finally {
				setTournamentStatsLoading(false);
			}
		})();
	}, [selectedTournamentId]);

	useEffect(() => {
		const term = query.trim();
		if (!term) {
			setResults([]);
			return;
		}

		const timeoutId = window.setTimeout(async () => {
			try {
				const found = await searchRegisteredProfiles(term);
				setResults(found);
			} catch (error) {
				toast.error((error as Error).message);
			}
		}, 250);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [query]);

	const mostPlayedTeam = stats.reduce<PlayerTeamStat | null>((best, current) => {
		if (!best) return current;
		if (current.games_played > best.games_played) return current;
		return best;
	}, null);

	const mostSkinnerMomentsTeam = stats.reduce<PlayerTeamStat | null>((worst, current) => {
		if (!worst) return current;
		if (current.goalie_save_rate < worst.goalie_save_rate) return current;
		return worst;
	}, null);

	const bestGoalieTeam = tournamentStats.reduce<TournamentTeamStat | null>((best, current) => {
		if (!best) return current;
		if (current.goalie_save_rate > best.goalie_save_rate) return current;
		return best;
	}, null);

	const mostWinsTeam = tournamentStats.reduce<TournamentTeamStat | null>((best, current) => {
		if (!best) return current;
		if (current.wins > best.wins) return current;
		return best;
	}, null);

	const tournamentMostSkinnerMomentsTeam = tournamentStats.reduce<TournamentTeamStat | null>((worst, current) => {
		if (!worst) return current;
		if (current.goalie_save_rate < worst.goalie_save_rate) return current;
		return worst;
	}, null);

	return (
		<div className="space-y-4 p-4 md:p-6">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold">Statistics</h1>
				<p className="text-sm text-muted-foreground">
					Performance by team across all tournaments and within selected closed tournaments with saved match results.
				</p>
			</div>

			<Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "players" | "tournaments")}>
				<TabsList>
					<TabsTrigger value="players">Players</TabsTrigger>
					<TabsTrigger value="tournaments">Tournaments</TabsTrigger>
				</TabsList>

				<TabsContent value="players" className="space-y-4">
					<div className="grid max-w-3xl gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<label className="text-sm font-medium" htmlFor="profile-search">
								Search member
							</label>
							<input
								id="profile-search"
								className="w-full rounded-md border bg-background px-3 py-2 text-sm"
								placeholder="Type username..."
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
							{results.length > 0 && (
								<div className="rounded-md border bg-background">
									{results.map((item) => (
										<button
											key={item.id}
											type="button"
											className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
											onClick={() => {
												setSelectedUser(item);
												setFriendSelection("");
												setQuery(item.username);
												setResults([]);
											}}
										>
											{item.username}
										</button>
									))}
								</div>
							)}
						</div>
						<div className="space-y-2">
							<label className="text-sm font-medium" htmlFor="friend-select">
								Quick select friend
							</label>
							<select
								id="friend-select"
								value={friendSelection}
								onChange={(event) => {
									const selectedId = event.target.value;
									setFriendSelection(selectedId);
									const friend = friends.find((item) => item.id === selectedId);
									if (!friend) return;
									setSelectedUser(friend);
									setQuery("");
									setResults([]);
								}}
								className="w-full rounded-md border bg-background px-3 py-2 text-sm"
							>
								<option value="">Select friend...</option>
								{friends.map((friend) => (
									<option key={friend.id} value={friend.id}>
										{friend.username}
									</option>
								))}
							</select>
						</div>
					</div>
					{selectedUser && (
						<p className="text-sm text-muted-foreground">Showing statistics for: {selectedUser.username}</p>
					)}

					<div className="grid gap-4 rounded-lg border p-4 text-center md:grid-cols-3">
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								{mostPlayedTeam ? (
									<img
										src={getTeamLogoUrl(mostPlayedTeam.team_code, mostPlayedTeam.team_pool)}
										alt={`${mostPlayedTeam.team_name} logo`}
										className="h-16 w-16 object-contain"
									/>
								) : (
									<span className="text-3xl font-semibold">-</span>
								)}
							</div>
							<p className="text-sm text-muted-foreground">Most played</p>
						</div>
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								<span className="text-4xl font-semibold">{tournamentWins}</span>
							</div>
							<p className="text-sm text-muted-foreground">Tournament wins</p>
						</div>
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								{mostSkinnerMomentsTeam ? (
									<img
										src={getTeamLogoUrl(mostSkinnerMomentsTeam.team_code, mostSkinnerMomentsTeam.team_pool)}
										alt={`${mostSkinnerMomentsTeam.team_name} logo`}
										className="h-16 w-16 object-contain"
									/>
								) : (
									<span className="text-3xl font-semibold">-</span>
								)}
							</div>
							<p className="text-sm text-muted-foreground">Most Skinner Moments</p>
						</div>
					</div>

					<div className="overflow-x-auto rounded-lg border">
						<table className="w-full min-w-[860px] text-sm">
							<thead className="bg-muted/50 text-muted-foreground">
								<tr>
									<th className="px-4 py-3 text-center">Team</th>
									<th className="px-4 py-3 text-center">Games played</th>
									<th className="px-4 py-3 text-center">Wins</th>
									<th className="px-4 py-3 text-center">Losses</th>
									<th className="px-4 py-3 text-center">Shots made</th>
									<th className="px-4 py-3 text-center">Goals made</th>
									<th className="px-4 py-3 text-center">Goals against</th>
									<th className="px-4 py-3 text-center">Shots against</th>
									<th className="px-4 py-3 text-center">Goalie save rate</th>
								</tr>
							</thead>
							<tbody>
								{loading ? (
									<tr>
										<td className="px-4 py-3" colSpan={9}>
											Loading statistics...
										</td>
									</tr>
								) : stats.length === 0 ? (
									<tr>
										<td className="px-4 py-3" colSpan={9}>
											No statistics available yet.
										</td>
									</tr>
								) : (
									stats.map((row) => (
										<tr key={row.team_id} className="border-t">
											<td className="px-4 py-3 text-center font-medium">
												<div className="flex items-center justify-center gap-2">
													<img
														src={getTeamLogoUrl(row.team_code, row.team_pool)}
														alt={`${row.team_name} logo`}
														className="h-5 w-5 object-contain"
													/>
													<span>{row.team_name}</span>
												</div>
											</td>
											<td className="px-4 py-3 text-center">{row.games_played}</td>
											<td className="px-4 py-3 text-center">{row.wins}</td>
											<td className="px-4 py-3 text-center">{row.losses}</td>
											<td className="px-4 py-3 text-center">{row.shots_made}</td>
											<td className="px-4 py-3 text-center">{row.goals_made}</td>
											<td className="px-4 py-3 text-center">{row.goals_received}</td>
											<td className="px-4 py-3 text-center">{row.shots_received}</td>
											<td className="px-4 py-3 text-center">{formatSaveRate(row.goalie_save_rate)}</td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
				</TabsContent>

				<TabsContent value="tournaments" className="space-y-4">
					<div className="max-w-md space-y-2">
						<label className="text-sm font-medium" htmlFor="closed-tournament-select">
							Closed tournament
						</label>
						<select
							id="closed-tournament-select"
							value={selectedTournamentId}
							onChange={(event) => setSelectedTournamentId(event.target.value)}
							className="w-full rounded-md border bg-background px-3 py-2 text-sm"
						>
							{closedTournaments.length === 0 ? (
								<option value="">No closed tournaments</option>
							) : (
								closedTournaments.map((tournament) => (
									<option key={tournament.id} value={tournament.id}>
										{tournament.name}
									</option>
								))
							)}
						</select>
					</div>

					<div className="grid gap-4 rounded-lg border p-4 text-center md:grid-cols-3">
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								{bestGoalieTeam ? (
									<img
										src={getTeamLogoUrl(bestGoalieTeam.team_code, bestGoalieTeam.team_pool)}
										alt={`${bestGoalieTeam.team_name} logo`}
										className="h-16 w-16 object-contain"
									/>
								) : (
									<span className="text-3xl font-semibold">-</span>
								)}
							</div>
							<p className="text-sm text-muted-foreground">Best Goalie</p>
						</div>
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								{mostWinsTeam ? (
									<img
										src={getTeamLogoUrl(mostWinsTeam.team_code, mostWinsTeam.team_pool)}
										alt={`${mostWinsTeam.team_name} logo`}
										className="h-16 w-16 object-contain"
									/>
								) : (
									<span className="text-3xl font-semibold">-</span>
								)}
							</div>
							<p className="text-sm text-muted-foreground">Most wins</p>
						</div>
						<div className="flex flex-col items-center justify-start gap-2">
							<div className="flex h-16 items-center justify-center">
								{tournamentMostSkinnerMomentsTeam ? (
									<img
										src={getTeamLogoUrl(
											tournamentMostSkinnerMomentsTeam.team_code,
											tournamentMostSkinnerMomentsTeam.team_pool,
										)}
										alt={`${tournamentMostSkinnerMomentsTeam.team_name} logo`}
										className="h-16 w-16 object-contain"
									/>
								) : (
									<span className="text-3xl font-semibold">-</span>
								)}
							</div>
							<p className="text-sm text-muted-foreground">Most Skinner Moments</p>
						</div>
					</div>

					<div className="overflow-x-auto rounded-lg border">
						<table className="w-full min-w-[900px] text-sm">
							<thead className="bg-muted/50 text-muted-foreground">
								<tr>
									<th className="px-4 py-3 text-center">Placement</th>
									<th className="px-4 py-3 text-center">Player</th>
									<th className="px-4 py-3 text-center">Team</th>
									<th className="px-4 py-3 text-center">Games played</th>
									<th className="px-4 py-3 text-center">Wins</th>
									<th className="px-4 py-3 text-center">Losses</th>
									<th className="px-4 py-3 text-center">Shots made</th>
									<th className="px-4 py-3 text-center">Goals made</th>
									<th className="px-4 py-3 text-center">Goals against</th>
									<th className="px-4 py-3 text-center">Shots against</th>
									<th className="px-4 py-3 text-center">Goalie save rate</th>
								</tr>
							</thead>
							<tbody>
								{tournamentStatsLoading ? (
									<tr>
										<td className="px-4 py-3" colSpan={11}>
											Loading tournament statistics...
										</td>
									</tr>
								) : tournamentStats.length === 0 ? (
									<tr>
										<td className="px-4 py-3" colSpan={11}>
											No tournament statistics available yet.
										</td>
									</tr>
								) : (
									tournamentStats.map((row, index) => (
										<tr key={row.team_id} className="border-t">
											<td className="px-4 py-3 text-center">{row.placement ?? index + 1}</td>
											<td className="px-4 py-3 text-center">{row.player_name ?? "-"}</td>
											<td className="px-4 py-3 text-center font-medium">
												<div className="flex items-center justify-center gap-2">
													<img
														src={getTeamLogoUrl(row.team_code, row.team_pool)}
														alt={`${row.team_name} logo`}
														className="h-5 w-5 object-contain"
													/>
													<span>{row.team_name}</span>
												</div>
											</td>
											<td className="px-4 py-3 text-center">{row.games_played}</td>
											<td className="px-4 py-3 text-center">{row.wins}</td>
											<td className="px-4 py-3 text-center">{row.losses}</td>
											<td className="px-4 py-3 text-center">{row.shots_made}</td>
											<td className="px-4 py-3 text-center">{row.goals_made}</td>
											<td className="px-4 py-3 text-center">{row.goals_received}</td>
											<td className="px-4 py-3 text-center">{row.shots_received}</td>
											<td className="px-4 py-3 text-center">{formatSaveRate(row.goalie_save_rate)}</td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
