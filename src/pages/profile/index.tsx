import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { listUserTeamStats, type PlayerTeamStat } from "@/lib/db";

function formatSaveRate(value: number): string {
	return `${(value * 100).toFixed(3)}%`;
}

export default function ProfilePage() {
	const { user } = useAuth();
	const [loading, setLoading] = useState(true);
	const [stats, setStats] = useState<PlayerTeamStat[]>([]);

	const loadStats = useCallback(async () => {
		if (!user?.id) {
			setStats([]);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			const rows = await listUserTeamStats(user.id);
			setStats(rows);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [user?.id]);

	useEffect(() => {
		loadStats();
	}, [loadStats]);

	return (
		<div className="space-y-4 p-4 md:p-6">
			<div>
				<h1 className="text-2xl font-semibold">Statistics</h1>
				<p className="text-sm text-muted-foreground">
					Performance by team across all tournaments with saved match results.
				</p>
			</div>

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[760px] text-left text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-4 py-3">Team</th>
							<th className="px-4 py-3">Games played</th>
							<th className="px-4 py-3">Shots made</th>
							<th className="px-4 py-3">Goals made</th>
							<th className="px-4 py-3">Goalie save rate</th>
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td className="px-4 py-3" colSpan={5}>
									Loading statistics...
								</td>
							</tr>
						) : stats.length === 0 ? (
							<tr>
								<td className="px-4 py-3" colSpan={5}>
									No statistics available yet.
								</td>
							</tr>
						) : (
							stats.map((row) => (
								<tr key={row.team_id} className="border-t">
									<td className="px-4 py-3 font-medium">{row.team_name}</td>
									<td className="px-4 py-3">{row.games_played}</td>
									<td className="px-4 py-3">{row.shots_made}</td>
									<td className="px-4 py-3">{row.goals_made}</td>
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
