import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	createTournament,
	deleteTournament,
	listTournaments,
	sanitizeGroupCount,
	type TeamPool,
	type Tournament,
	type TournamentPreset,
} from "@/lib/db";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";

const PRESET_OPTIONS: Array<{ label: string; value: TournamentPreset }> = [
	{ label: "Playoffs only", value: "playoffs_only" },
	{ label: "Full tournament", value: "full_tournament" },
];

export default function TournamentsPage() {
	const navigate = useNavigate();
	const { isAdmin } = useAuth();
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [deletingTournamentId, setDeletingTournamentId] = useState<string | null>(null);
	const [openCreate, setOpenCreate] = useState(false);
	const [name, setName] = useState("");
	const [presetId, setPresetId] = useState<TournamentPreset>("full_tournament");
	const [teamPool, setTeamPool] = useState<TeamPool>("NHL");
	const [defaultParticipants, setDefaultParticipants] = useState(4);
	const [groupCountInput, setGroupCountInput] = useState(2);
	const [tournaments, setTournaments] = useState<Tournament[]>([]);

	const groupResolution = useMemo(() => {
		if (presetId !== "full_tournament") {
			return { groupCount: null, note: null, error: null };
		}
		return sanitizeGroupCount(defaultParticipants, groupCountInput);
	}, [presetId, defaultParticipants, groupCountInput]);

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
		if (defaultParticipants < 2 || defaultParticipants > 24) {
			toast.warning("Participants must be between 2 and 24.");
			return;
		}
		if (presetId === "full_tournament" && groupResolution.error) {
			toast.error(groupResolution.error);
			return;
		}
		try {
			setSaving(true);
			const createdTournament = await createTournament({
				name: name.trim(),
				presetId,
				teamPool,
				defaultParticipants,
				groupCount: presetId === "full_tournament" ? groupResolution.groupCount : null,
			});
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

	const onDelete = async (tournament: Tournament) => {
		if (!isAdmin) {
			toast.error("Only admins can delete tournaments.");
			return;
		}

		const shouldDelete = window.confirm(`Delete \"${tournament.name}\"? This cannot be undone.`);
		if (!shouldDelete) return;

		try {
			setDeletingTournamentId(tournament.id);
			await deleteTournament(tournament.id);
			setTournaments((current) => current.filter((item) => item.id !== tournament.id));
			toast.success("Tournament deleted.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setDeletingTournamentId(null);
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
							<th className="px-4 py-3">Hosted by</th>
							<th className="px-4 py-3">Status</th>
							<th className="px-4 py-3">Created</th>
							<th className="px-4 py-3">Actions</th>
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td className="px-4 py-3" colSpan={5}>
									Loading tournaments...
								</td>
							</tr>
						) : tournaments.length === 0 ? (
							<tr>
								<td className="px-4 py-3" colSpan={5}>
									No tournaments yet.
								</td>
							</tr>
						) : (
							tournaments.map((tournament) => (
								<tr key={tournament.id} className="border-t">
									<td className="px-4 py-3 font-medium">{tournament.name}</td>
									<td className="px-4 py-3">{tournament.hosted_by}</td>
									<td className="px-4 py-3">{tournament.status ?? "active"}</td>
									<td className="px-4 py-3">{new Date(tournament.created_at).toLocaleString()}</td>
									<td className="px-4 py-3">
										<div className="flex items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												onClick={() => navigate(`/dashboard/tournaments/${tournament.id}`)}
											>
												Open
											</Button>
											{isAdmin && (
												<Button
													variant="destructive"
													size="sm"
													onClick={() => onDelete(tournament)}
													disabled={deletingTournamentId === tournament.id}
												>
													{deletingTournamentId === tournament.id ? "Deleting..." : "Delete"}
												</Button>
											)}
										</div>
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
								onChange={(event) => setPresetId(event.target.value as TournamentPreset)}
							>
								{PRESET_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1">
							<p className="text-sm">Default participants</p>
							<Input
								type="number"
								min={2}
								max={24}
								value={defaultParticipants}
								onChange={(event) => setDefaultParticipants(Number(event.target.value))}
							/>
						</div>
						<div className="space-y-1">
							<p className="text-sm">Team pool</p>
							<select
								className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
								value={teamPool}
								onChange={(event) => setTeamPool(event.target.value as TeamPool)}
							>
								<option value="NHL">NHL</option>
								<option value="INTL">International</option>
							</select>
						</div>
						{presetId === "full_tournament" && (
							<div className="space-y-1">
								<p className="text-sm">Group count</p>
								<Input
									type="number"
									min={1}
									max={4}
									value={groupCountInput}
									onChange={(event) => setGroupCountInput(Math.max(1, Math.min(4, Number(event.target.value) || 1)))}
								/>
								{groupResolution.note && <p className="text-xs text-amber-600">{groupResolution.note}</p>}
								{groupResolution.error && <p className="text-xs text-red-600">{groupResolution.error}</p>}
							</div>
						)}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpenCreate(false)} disabled={saving}>
							Cancel
						</Button>
						<Button onClick={onCreate} disabled={saving || Boolean(groupResolution.error)}>
							{saving ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
