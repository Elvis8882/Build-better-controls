import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { createTournament, listTournaments, type Tournament } from "@/lib/db";

const PRESET_OPTIONS = [
	{ label: "Classic 1", value: "classic_1" },
	{ label: "Classic 2", value: "classic_2" },
];

export default function TournamentsPage() {
	const navigate = useNavigate();
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [openCreate, setOpenCreate] = useState(false);
	const [name, setName] = useState("");
	const [presetId, setPresetId] = useState(PRESET_OPTIONS[0].value);
	const [tournaments, setTournaments] = useState<Tournament[]>([]);

	const loadTournaments = useCallback(async () => {
		try {
			setLoading(true);
			const items = await listTournaments();
			setTournaments(items);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadTournaments();
	}, [loadTournaments]);

	const onCreate = async () => {
		if (!name.trim()) {
			toast.warning("Tournament name is required.");
			return;
		}
		try {
			setSaving(true);
			const createdTournament = await createTournament(name.trim(), presetId);
			toast.success("Tournament created.");
			setOpenCreate(false);
			setName("");
			navigate(`/dashboard/tournaments/${createdTournament.id}`);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-4 p-4 md:p-6">
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Tournaments</h1>
					<p className="text-sm text-muted-foreground">All tournaments are visible to any authenticated user.</p>
				</div>
				<Button onClick={() => setOpenCreate(true)}>Create tournament</Button>
			</div>

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[700px] text-left text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-4 py-3">Name</th>
							<th className="px-4 py-3">Status</th>
							<th className="px-4 py-3">Created</th>
							<th className="px-4 py-3">Actions</th>
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td className="px-4 py-3" colSpan={4}>
									Loading tournaments...
								</td>
							</tr>
						) : tournaments.length === 0 ? (
							<tr>
								<td className="px-4 py-3" colSpan={4}>
									No tournaments yet.
								</td>
							</tr>
						) : (
							tournaments.map((tournament) => (
								<tr key={tournament.id} className="border-t">
									<td className="px-4 py-3 font-medium">{tournament.name}</td>
									<td className="px-4 py-3">{tournament.status ?? "active"}</td>
									<td className="px-4 py-3">{new Date(tournament.created_at).toLocaleString()}</td>
									<td className="px-4 py-3">
										<Button
											variant="outline"
											size="sm"
											onClick={() => navigate(`/dashboard/tournaments/${tournament.id}`)}
										>
											Open
										</Button>
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<Dialog open={openCreate} onOpenChange={setOpenCreate}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Create tournament</DialogTitle>
					</DialogHeader>
					<div className="space-y-3 py-2">
						<div className="space-y-1">
							<p className="text-sm">Name</p>
							<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="NHL Playoffs" />
						</div>
						<div className="space-y-1">
							<p className="text-sm">Preset</p>
							<select
								className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
								value={presetId}
								onChange={(event) => setPresetId(event.target.value)}
							>
								{PRESET_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpenCreate(false)} disabled={saving}>
							Cancel
						</Button>
						<Button onClick={onCreate} disabled={saving}>
							{saving ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
