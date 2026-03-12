import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { deleteTournament, listTournaments, type Tournament } from "@/lib/db";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { CreateTournamentModal } from "./components/create-tournament-modal";

export default function TournamentsPage() {
	const navigate = useNavigate();
	const { isAdmin } = useAuth();
	const [loading, setLoading] = useState(true);
	const [deletingTournamentId, setDeletingTournamentId] = useState<string | null>(null);
	const [openModes, setOpenModes] = useState(false);
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
				<div className="flex items-center gap-2">
					<Button variant="outline" onClick={() => setOpenModes(true)}>
						Tournament modes
					</Button>
					<Button onClick={() => setOpenCreate(true)}>Create tournament</Button>
				</div>
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
										{tournament.preset_id === "playoffs_only"
											? "Playoff only"
											: tournament.preset_id === "2v2_playoffs"
												? "2v2 Playoffs"
												: tournament.preset_id === "2v2_tournament"
													? "2v2 Tournament"
													: tournament.preset_id === "round_robin_tiers"
														? "Round-Robin Tiers"
														: tournament.preset_id === "goal_difference_duel"
															? "Goal Difference Duel"
															: "Full tournament"}
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

			<Dialog open={openModes} onOpenChange={setOpenModes}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Tournament modes</DialogTitle>
					</DialogHeader>
					<div className="space-y-4 text-sm leading-6 text-muted-foreground">
						<section>
							<h3 className="font-medium text-foreground">Full tournament</h3>
							<p>
								Teams first play a group stage where everyone in a group faces each other and earns points for wins and
								results. The top teams from each group advance into a seeded playoff bracket, where each knockout match
								determines who stays alive and who is eliminated until a champion is crowned.
							</p>
						</section>
						<section>
							<h3 className="font-medium text-foreground">Playoff only</h3>
							<p>
								There is no group phase in this mode; teams are placed straight into a knockout bracket from round one.
								Each match is win-or-go-home, so a single loss ends the run while winners continue through
								quarterfinals, semifinals, and final.
							</p>
						</section>
						<section>
							<h3 className="font-medium text-foreground">2v2 Tournament</h3>
							<p>
								Players register in pairs and compete as fixed two-player teams throughout the entire event. The format
								uses a group stage to rank teams before moving top pairs into playoffs, so chemistry across multiple
								rounds matters as much as single-match execution.
							</p>
						</section>
						<section>
							<h3 className="font-medium text-foreground">2v2 Playoffs</h3>
							<p>
								This is the short, high-pressure version for two-player teams with immediate elimination rounds only.
								Pairs are seeded into a bracket, and every result directly advances one team and removes the other until
								the final matchup decides the title.
							</p>
						</section>
						<section>
							<h3 className="font-medium text-foreground">Round-Robin Tiers</h3>
							<p>
								Teams are split into tiers and play repeated round-robin matches inside their assigned tier to build a
								league-style table. After each game cycle, teams are rerolled into different tiers based on win/loss
								results, so strong runs move teams upward while losses can drop teams into lower tiers.
							</p>
						</section>
						<section>
							<h3 className="font-medium text-foreground">Goal Difference Duel</h3>
							<p>
								Matches are scored with extra emphasis on goal difference, so winning by larger margins improves your
								position more than narrow victories. Teams are also rerolled between tiers after each game window based
								on win/loss form, which keeps movement between brackets active and every goal meaningful.
							</p>
						</section>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
