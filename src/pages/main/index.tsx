import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { listMatchesWithResults, type MatchWithResult, type Tournament } from "@/lib/db";
import { supabase } from "@/lib/supabaseClient";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

type TimelineItem = {
	id: string;
	title: string;
	description: string;
	time: string;
	tournamentId?: string;
	showTournamentLink?: boolean;
};

function relativeTime(value: string): string {
	const deltaSeconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
	if (deltaSeconds < 60) return "just now";
	if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
	if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
	return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

export default function MainPage() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const [myTournaments, setMyTournaments] = useState<Tournament[]>([]);
	const [featuredMatches, setFeaturedMatches] = useState<MatchWithResult[]>([]);
	const [participantsByTournamentId, setParticipantsByTournamentId] = useState<Record<string, string[]>>({});
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!user?.id) {
			setMyTournaments([]);
			setFeaturedMatches([]);
			setParticipantsByTournamentId({});
			return;
		}

		const load = async () => {
			setLoading(true);
			try {
				const [membershipResult, createdResult] = await Promise.all([
					supabase.from("tournament_members").select("tournament_id").eq("user_id", user.id),
					supabase
						.from("tournaments")
						.select(
							"id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage",
						)
						.eq("created_by", user.id)
						.order("created_at", { ascending: false }),
				]);

				if (membershipResult.error) throw membershipResult.error;
				if (createdResult.error) throw createdResult.error;

				const membershipIds = [...new Set((membershipResult.data ?? []).map((row) => row.tournament_id as string))];

				const memberTournamentsResult =
					membershipIds.length > 0
						? await supabase
								.from("tournaments")
								.select(
									"id, name, status, created_at, preset_id, created_by, team_pool, default_participants, group_count, stage",
								)
								.in("id", membershipIds)
								.order("created_at", { ascending: false })
						: { data: [], error: null };
				if (memberTournamentsResult.error) throw memberTournamentsResult.error;

				const combined = [...(createdResult.data ?? []), ...(memberTournamentsResult.data ?? [])] as Tournament[];
				const tournamentMap = new Map(combined.map((tournament) => [tournament.id, tournament]));
				const tournaments = [...tournamentMap.values()].sort(
					(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
				);
				setMyTournaments(tournaments);

				const participantResult =
					tournaments.length > 0
						? await supabase
								.from("tournament_participants")
								.select("tournament_id, display_name")
								.in(
									"tournament_id",
									tournaments.map((tournament) => tournament.id),
								)
						: { data: [], error: null };
				if (participantResult.error) throw participantResult.error;

				const nextParticipantsByTournamentId: Record<string, string[]> = {};
				for (const row of participantResult.data ?? []) {
					const tournamentId = row.tournament_id as string;
					const displayName = (row.display_name as string | null) ?? "Unknown participant";
					nextParticipantsByTournamentId[tournamentId] = [
						...(nextParticipantsByTournamentId[tournamentId] ?? []),
						displayName,
					];
				}
				setParticipantsByTournamentId(nextParticipantsByTournamentId);

				const matchBuckets = await Promise.all(
					tournaments.slice(0, 6).map(async (tournament) => {
						const matches = await listMatchesWithResults(tournament.id);
						return matches.map((match) => ({ ...match, tournamentName: tournament.name }));
					}),
				);

				const sortedMatches = matchBuckets
					.flat()
					.filter((match) => Boolean(match.result?.locked))
					.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
					.slice(0, 5);
				setFeaturedMatches(sortedMatches);
			} catch (error) {
				toast.error((error as Error).message);
			} finally {
				setLoading(false);
			}
		};

		void load();
	}, [user?.id]);

	const timeline = useMemo<TimelineItem[]>(() => {
		const items: TimelineItem[] = [];
		const activeTournaments = myTournaments
			.filter((tournament) => (tournament.status ?? "Open").toLowerCase() !== "closed")
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

		for (const tournament of activeTournaments.slice(0, 2)) {
			items.push({
				id: `active-${tournament.id}`,
				title: `${tournament.name} is live`,
				description: "Your bracket is active — open it to check upcoming rounds and standings.",
				time: relativeTime(tournament.created_at),
				tournamentId: tournament.id,
			});
		}

		for (const tournament of myTournaments.slice(0, 4)) {
			const status = tournament.status ?? "Open";
			const lowerStatus = status.toLowerCase();
			const participantNames = participantsByTournamentId[tournament.id] ?? [];
			const participantSnippet =
				participantNames.length === 0
					? "Registration is live and the competition board is being prepared."
					: participantNames.length <= 3
						? `Participants: ${participantNames.join(", ")}.`
						: `Participants: ${participantNames.slice(0, 3).join(", ")} +${participantNames.length - 3} more.`;
			if (lowerStatus === "closed") {
				items.push({
					id: `closed-${tournament.id}`,
					title: `${tournament.name} is closed`,
					description: "Tournament completed. Final standings and playoffs are now locked.",
					time: relativeTime(tournament.created_at),
					tournamentId: tournament.id,
					showTournamentLink: false,
				});
				continue;
			}

			items.push({
				id: `tour-${tournament.id}`,
				title: `Tournament opened: ${tournament.name}`,
				description: participantSnippet,
				time: relativeTime(tournament.created_at),
				tournamentId: tournament.id,
				showTournamentLink: true,
			});
		}
		return items.slice(0, 6);
	}, [myTournaments, participantsByTournamentId]);

	return (
		<div className="space-y-6 p-4 sm:p-6 overflow-x-hidden">
			<section className="rounded-2xl border bg-gradient-to-r from-sky-500/20 via-indigo-500/20 to-fuchsia-500/20 p-6">
				<p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Main</p>
				<h1 className="mt-2 text-3xl font-bold">Your competition pulse</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					A quick look at what&apos;s happening in tournaments you&apos;re hosting or playing.
				</p>
				<div className="mt-4 flex flex-wrap gap-3">
					<Badge variant="secondary">{myTournaments.length} Active/Recent Tournaments</Badge>
					<Badge variant="outline">{featuredMatches.length} Featured Results</Badge>
				</div>
			</section>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Latest activity</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{loading && <p className="text-sm text-muted-foreground">Loading activity…</p>}
						{!loading && timeline.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No activity yet. Join or create a tournament to get started.
							</p>
						)}
						{timeline.map((item) => (
							<div key={item.id} className="rounded-xl border bg-muted/40 p-3 min-w-0">
								<div className="flex items-center justify-between gap-3">
									<p className="text-sm font-medium">{item.title}</p>
									<span className="text-xs text-muted-foreground">{item.time}</span>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
								{item.tournamentId && item.showTournamentLink !== false && (
									<div className="mt-2">
										<button
											type="button"
											onClick={() => navigate(`/dashboard/tournaments/${item.tournamentId}`)}
											className="text-xs font-medium text-primary underline-offset-2 hover:underline"
										>
											Open tournament
										</button>
									</div>
								)}
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Featured matches</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{loading && <p className="text-sm text-muted-foreground">Collecting featured matches…</p>}
						{!loading && featuredMatches.length === 0 && (
							<p className="text-sm text-muted-foreground">No locked results yet.</p>
						)}
						{featuredMatches.map((match) => (
							<div key={match.id} className="rounded-xl border p-3">
								<p className="text-sm font-semibold">
									{match.home_participant_name} vs {match.away_participant_name}
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Score: {match.result?.home_score ?? "-"} - {match.result?.away_score ?? "-"}
								</p>
								<p className="mt-1 text-xs text-muted-foreground">Recorded {relativeTime(match.created_at)}</p>
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
