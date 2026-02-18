import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { deleteTournament, listTournaments, type Tournament } from "@/lib/db";
import { Button } from "@/ui/button";
import { CreateTournamentModal } from "./components/create-tournament-modal";

export default function TournamentsPage() {
	const navigate = useNavigate();
	const { isAdmin } = useAuth();
	const [loading, setLoading] = useState(true);
	const [deletingTournamentId, setDeletingTournamentId] = useState<string | null>(null);
	const [openCreate, setOpenCreate] = useState(false);
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
							<th className="px-4 py-3">Type</th>
							<th className="px-4 py-3">Hosted by</th>
							<th className="px-4 py-3">Status</th>
							<th className="px-4 py-3">Created</th>
							<th className="px-4 py-3">Actions</th>
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td className="px-4 py-3" colSpan={6}>
									Loading tournaments...
								</td>
							</tr>
						) : tournaments.length === 0 ? (
							<tr>
								<td className="px-4 py-3" colSpan={6}>
									No tournaments yet.
								</td>
							</tr>
						) : (
							tournaments.map((tournament) => (
								<tr key={tournament.id} className="border-t">
									<td className="px-4 py-3 font-medium">{tournament.name}</td>
									<td className="px-4 py-3">
										{tournament.preset_id === "playoffs_only" ? "Playoff only" : "Full tournament"}
									</td>
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

			<CreateTournamentModal
				open={openCreate}
				onOpenChange={setOpenCreate}
				onCreated={(tournamentId) => navigate(`/dashboard/tournaments/${tournamentId}`)}
			/>
		</div>
	);
}
