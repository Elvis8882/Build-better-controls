import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { getTeamLogoUrl } from "@/lib/teamLogos";
import { listUserTeamStats, searchRegisteredProfiles, type PlayerTeamStat, type RegisteredProfile } from "@/lib/db";

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
			const rows = await listUserTeamStats(targetUserId);
			setStats(rows);
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

	return (
		<div className="space-y-4 p-4 md:p-6">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold">Statistics</h1>
				<p className="text-sm text-muted-foreground">
					Performance by team across all tournaments with saved match results.
				</p>
				<div className="max-w-md space-y-2">
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
				{selectedUser && (
					<p className="text-sm text-muted-foreground">Showing statistics for: {selectedUser.username}</p>
				)}
			</div>

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[860px] text-left text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-4 py-3">Team</th>
							<th className="px-4 py-3">Games played</th>
							<th className="px-4 py-3">Wins</th>
							<th className="px-4 py-3">Shots made</th>
							<th className="px-4 py-3">Goals made</th>
							<th className="px-4 py-3">Goals against</th>
							<th className="px-4 py-3">Shots against</th>
							<th className="px-4 py-3">Goalie save rate</th>
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td className="px-4 py-3" colSpan={8}>
									Loading statistics...
								</td>
							</tr>
						) : stats.length === 0 ? (
							<tr>
								<td className="px-4 py-3" colSpan={8}>
									No statistics available yet.
								</td>
							</tr>
						) : (
							stats.map((row) => (
								<tr key={row.team_id} className="border-t">
									<td className="px-4 py-3 font-medium">
										<div className="flex items-center gap-2">
											<img
												src={getTeamLogoUrl(row.team_code, row.team_pool)}
												alt={`${row.team_name} logo`}
												className="h-5 w-5 object-contain"
											/>
											<span>{row.team_name}</span>
										</div>
									</td>
									<td className="px-4 py-3">{row.games_played}</td>
									<td className="px-4 py-3">{row.wins}</td>
									<td className="px-4 py-3">{row.shots_made}</td>
									<td className="px-4 py-3">{row.goals_made}</td>
									<td className="px-4 py-3">{row.goals_received}</td>
									<td className="px-4 py-3">{row.shots_received}</td>
									<td className="px-4 py-3">{formatSaveRate(row.goalie_save_rate)}</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
