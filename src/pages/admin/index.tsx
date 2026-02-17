import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { listTeams, type Team, updateTeamRatings } from "@/lib/db";
import Page403 from "@/pages/sys/error/Page403";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

type EditableRatings = {
	offense: string;
	defense: string;
	goalie: string;
};

function toOverall(offense: string, defense: string, goalie: string): number {
	const off = Number(offense);
	const def = Number(defense);
	const goa = Number(goalie);
	if ([off, def, goa].some((value) => Number.isNaN(value))) return 0;
	return Math.round((off + def + goa) / 3);
}

export default function AdminPanelPage() {
	const { isAdmin } = useAuth();
	const [teams, setTeams] = useState<Team[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, EditableRatings>>({});

	const loadTeams = useCallback(async () => {
		try {
			setLoading(true);
			const rows = await listTeams();
			setTeams(rows);
			setDrafts(
				Object.fromEntries(
					rows.map((team) => [
						team.id,
						{
							offense: String(team.offense),
							defense: String(team.defense),
							goalie: String(team.goalie),
						},
					]),
				),
			);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!isAdmin) return;
		void loadTeams();
	}, [isAdmin, loadTeams]);

	if (!isAdmin) {
		return <Page403 />;
	}

	const onSave = async (teamId: string) => {
		const draft = drafts[teamId];
		if (!draft) return;
		const payload = {
			offense: Number(draft.offense),
			defense: Number(draft.defense),
			goalie: Number(draft.goalie),
		};
		if (Object.values(payload).some((value) => Number.isNaN(value) || value < 0 || value > 100)) {
			toast.error("Ratings must be numbers between 0 and 100.");
			return;
		}
		setSaving(true);
		try {
			await updateTeamRatings(teamId, payload);
			setEditingTeamId(null);
			await loadTeams();
			toast.success("Team ratings updated.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Admin Panel</h1>
				<p className="text-sm text-muted-foreground">Manage team ratings for tournament balancing.</p>
			</div>

			<div className="rounded-xl border bg-card p-4">
				<h2 className="mb-3 text-lg font-semibold">Teams & Ratings</h2>
				{loading ? (
					<p className="text-sm text-muted-foreground">Loading teams...</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[960px] text-sm">
							<thead>
								<tr className="border-b">
									<th className="px-2 py-2 text-left">Team</th>
									<th className="px-2 py-2 text-left">Tier</th>
									<th className="px-2 py-2 text-left">OVR</th>
									<th className="px-2 py-2 text-left">OFF</th>
									<th className="px-2 py-2 text-left">DEF</th>
									<th className="px-2 py-2 text-left">GOA</th>
									<th className="px-2 py-2 text-left">Actions</th>
								</tr>
							</thead>
							<tbody>
								{teams.map((team) => {
									const draft = drafts[team.id];
									const isEditing = editingTeamId === team.id;
									const overall = draft ? toOverall(draft.offense, draft.defense, draft.goalie) : team.overall;
									return (
										<tr key={team.id} className="border-b">
											<td className="px-2 py-2">{team.name}</td>
											<td className="px-2 py-2">{team.ovr_tier}</td>
											<td className="px-2 py-2 font-medium">{overall}</td>
											<td className="px-2 py-2">
												<Input
													type="number"
													min={0}
													max={100}
													disabled={!isEditing || saving}
													value={draft?.offense ?? "0"}
													onChange={(event) =>
														setDrafts((previous) => ({
															...previous,
															[team.id]: { ...previous[team.id], offense: event.target.value },
														}))
													}
												/>
											</td>
											<td className="px-2 py-2">
												<Input
													type="number"
													min={0}
													max={100}
													disabled={!isEditing || saving}
													value={draft?.defense ?? "0"}
													onChange={(event) =>
														setDrafts((previous) => ({
															...previous,
															[team.id]: { ...previous[team.id], defense: event.target.value },
														}))
													}
												/>
											</td>
											<td className="px-2 py-2">
												<Input
													type="number"
													min={0}
													max={100}
													disabled={!isEditing || saving}
													value={draft?.goalie ?? "0"}
													onChange={(event) =>
														setDrafts((previous) => ({
															...previous,
															[team.id]: { ...previous[team.id], goalie: event.target.value },
														}))
													}
												/>
											</td>
											<td className="px-2 py-2">
												{isEditing ? (
													<div className="flex gap-2">
														<Button size="sm" disabled={saving} onClick={() => void onSave(team.id)}>
															Save
														</Button>
														<Button
															size="sm"
															variant="outline"
															disabled={saving}
															onClick={() => setEditingTeamId(null)}
														>
															Cancel
														</Button>
													</div>
												) : (
													<Button
														size="sm"
														variant="outline"
														disabled={saving}
														onClick={() => setEditingTeamId(team.id)}
													>
														Edit
													</Button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
