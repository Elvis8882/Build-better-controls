import { useCallback, useEffect, useMemo, useState } from "react";
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
import { ArrowUpDown } from "lucide-react";
=======
>>>>>>> main
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { listTeams, type Team, updateTeamRatings } from "@/lib/db";
import Page403 from "@/pages/sys/error/Page403";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

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

function formatLastUpdated(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toISOString().slice(0, 10);
}

export default function AdminPanelPage() {
	const { isAdmin } = useAuth();
	const [teams, setTeams] = useState<Team[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, EditableRatings>>({});
	const [teamNameFilter, setTeamNameFilter] = useState("");
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
	const [sortMode, setSortMode] = useState<{ key: "name" | "overall"; direction: "asc" | "desc" }>({
		key: "name",
		direction: "asc",
	});
=======
	const [teamNameSort, setTeamNameSort] = useState<"asc" | "desc">("asc");
>>>>>>> main

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

	const normalizedFilter = teamNameFilter.trim().toLowerCase();
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
	const getDisplayedOverall = useCallback(
		(team: Team) => {
			const draft = drafts[team.id];
			return draft ? toOverall(draft.offense, draft.defense, draft.goalie) : team.overall;
		},
		[drafts],
	);
=======
>>>>>>> main
	const visibleTeams = useMemo(
		() =>
			teams
				.filter((team) => (normalizedFilter ? team.name.toLowerCase().includes(normalizedFilter) : true))
				.sort((a, b) =>
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
					sortMode.key === "name"
						? sortMode.direction === "asc"
							? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
							: b.name.localeCompare(a.name, undefined, { sensitivity: "base" })
						: sortMode.direction === "asc"
							? getDisplayedOverall(a) - getDisplayedOverall(b) ||
								a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
							: getDisplayedOverall(b) - getDisplayedOverall(a) ||
								a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
				),
		[getDisplayedOverall, normalizedFilter, sortMode, teams],
	);
	const nhlTeams = useMemo(() => visibleTeams.filter((team) => team.team_pool === "NHL"), [visibleTeams]);
	const internationalTeams = useMemo(() => visibleTeams.filter((team) => team.team_pool === "INTL"), [visibleTeams]);

	const toggleSort = (key: "name" | "overall") => {
		setSortMode((previous) =>
			previous.key === key
				? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
				: { key, direction: "asc" },
		);
	};

	const sortDirectionLabel = sortMode.direction === "asc" ? "ascending" : "descending";
=======
					teamNameSort === "asc"
						? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
						: b.name.localeCompare(a.name, undefined, { sensitivity: "base" }),
				),
		[normalizedFilter, teamNameSort, teams],
	);
	const nhlTeams = useMemo(() => visibleTeams.filter((team) => team.team_pool === "NHL"), [visibleTeams]);
	const internationalTeams = useMemo(() => visibleTeams.filter((team) => team.team_pool === "INTL"), [visibleTeams]);
>>>>>>> main

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

	const renderTeamsTable = (poolTeams: Team[]) => (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[960px] text-sm">
				<thead>
					<tr className="border-b">
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
						<th className="px-2 py-2 text-left">
							<div className="inline-flex items-center gap-1">
								Team
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-6 w-6"
									onClick={() => toggleSort("name")}
									aria-label={`Sort by team name (${sortMode.key === "name" ? sortDirectionLabel : "ascending"})`}
								>
									<ArrowUpDown className="h-3.5 w-3.5" />
								</Button>
							</div>
						</th>
						<th className="px-2 py-2 text-left">Tier</th>
						<th className="px-2 py-2 text-left">
							<div className="inline-flex items-center gap-1">
								OVR
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-6 w-6"
									onClick={() => toggleSort("overall")}
									aria-label={`Sort by overall (${sortMode.key === "overall" ? sortDirectionLabel : "ascending"})`}
								>
									<ArrowUpDown className="h-3.5 w-3.5" />
								</Button>
							</div>
						</th>
=======
						<th className="px-2 py-2 text-left">Team</th>
						<th className="px-2 py-2 text-left">Tier</th>
						<th className="px-2 py-2 text-left">OVR</th>
>>>>>>> main
						<th className="px-2 py-2 text-left">OFF</th>
						<th className="px-2 py-2 text-left">DEF</th>
						<th className="px-2 py-2 text-left">GOA</th>
						<th className="px-2 py-2 text-left">Last updated</th>
						<th className="px-2 py-2 text-left">Actions</th>
					</tr>
				</thead>
				<tbody>
					{poolTeams.map((team) => {
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
								<td className="px-2 py-2 whitespace-nowrap">{formatLastUpdated(team.last_updated)}</td>
								<td className="px-2 py-2">
									{isEditing ? (
										<div className="flex gap-2">
											<Button size="sm" disabled={saving} onClick={() => void onSave(team.id)}>
												Save
											</Button>
											<Button size="sm" variant="outline" disabled={saving} onClick={() => setEditingTeamId(null)}>
												Cancel
											</Button>
										</div>
									) : (
										<Button size="sm" variant="outline" disabled={saving} onClick={() => setEditingTeamId(team.id)}>
											Edit
										</Button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{poolTeams.length === 0 ? (
				<p className="pt-3 text-sm text-muted-foreground">
					{normalizedFilter ? "No teams match the current filter." : "No teams available."}
				</p>
			) : null}
		</div>
	);

	if (!isAdmin) {
		return <Page403 />;
	}

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
					<div className="space-y-4">
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
						<div className="flex flex-col gap-2">
=======
						<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
>>>>>>> main
							<Input
								value={teamNameFilter}
								onChange={(event) => setTeamNameFilter(event.target.value)}
								placeholder="Filter by team name..."
								className="md:max-w-xs"
							/>
<<<<<<< codex/enhance-admin-panel-and-profile-tracker
=======
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									variant={teamNameSort === "asc" ? "default" : "outline"}
									onClick={() => setTeamNameSort("asc")}
								>
									Name A→Z
								</Button>
								<Button
									type="button"
									size="sm"
									variant={teamNameSort === "desc" ? "default" : "outline"}
									onClick={() => setTeamNameSort("desc")}
								>
									Name Z→A
								</Button>
							</div>
>>>>>>> main
						</div>
						<Tabs defaultValue="nhl" className="space-y-3">
							<TabsList>
								<TabsTrigger value="nhl">NHL ({nhlTeams.length})</TabsTrigger>
								<TabsTrigger value="intl">International ({internationalTeams.length})</TabsTrigger>
							</TabsList>
							<TabsContent value="nhl">{renderTeamsTable(nhlTeams)}</TabsContent>
							<TabsContent value="intl">{renderTeamsTable(internationalTeams)}</TabsContent>
						</Tabs>
					</div>
				)}
			</div>
		</div>
	);
}
