import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Chart } from "@/components/chart";
import { useAuth } from "@/auth/AuthProvider";
import {
	fetchTeamsByPool,
	getProfileOverview,
	listUserTournamentPerformance,
	type ProfileOverview,
	type Team,
	updateProfileOverview,
} from "@/lib/db";
import { getTeamLogoUrl, handleTeamLogoImageError } from "@/lib/teamLogos";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";

type ProfileFormState = {
	bio: string;
	favorite_team: string;
	club_preference: string;
};

export default function UserProfilePage() {
	const [searchParams] = useSearchParams();
	const { user } = useAuth();
	const [profile, setProfile] = useState<ProfileOverview | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [offenseSeries, setOffenseSeries] = useState([
		{ name: "Shots on goal", data: [0] },
		{ name: "Goals", data: [0] },
	]);
	const [defenseSeries, setDefenseSeries] = useState([
		{ name: "Shots against", data: [0] },
		{ name: "Goals let in", data: [0] },
	]);
	const [performanceCategories, setPerformanceCategories] = useState(["Career"]);
	const [nhlTeams, setNhlTeams] = useState<Array<Pick<Team, "code" | "name">>>([]);
	const [form, setForm] = useState<ProfileFormState>({ bio: "", favorite_team: "", club_preference: "" });

	const targetUserId = useMemo(() => searchParams.get("userId") ?? user?.id ?? null, [searchParams, user?.id]);
	const canEdit = Boolean(user?.id && targetUserId && user.id === targetUserId);

	const favoriteTeamMeta = useMemo(
		() => nhlTeams.find((team) => team.name.toLowerCase() === form.favorite_team.trim().toLowerCase()) ?? null,
		[form.favorite_team, nhlTeams],
	);

	useEffect(() => {
		void (async () => {
			try {
				const teams = await fetchTeamsByPool("NHL");
				setNhlTeams(teams.map((team) => ({ code: team.code, name: team.name })));
			} catch (error) {
				toast.error((error as Error).message);
			}
		})();
	}, []);

	useEffect(() => {
		if (!targetUserId) return;
		setLoading(true);

		void (async () => {
			try {
				const [profileData, statsResult] = await Promise.allSettled([
					getProfileOverview(targetUserId),
					listUserTournamentPerformance(targetUserId),
				]);

				if (profileData.status !== "fulfilled") {
					throw profileData.reason;
				}

				const resolvedProfile = profileData.value;
				setProfile(resolvedProfile);
				setForm({
					bio: resolvedProfile?.bio ?? "",
					favorite_team: resolvedProfile?.favorite_team ?? "",
					club_preference: resolvedProfile?.club_preference ?? "",
				});

				if (statsResult.status !== "fulfilled" || statsResult.value.length === 0) {
					setPerformanceCategories(["Career"]);
					setOffenseSeries([
						{ name: "Shots on goal", data: [0] },
						{ name: "Goals", data: [0] },
					]);
					setDefenseSeries([
						{ name: "Shots against", data: [0] },
						{ name: "Goals let in", data: [0] },
					]);

					if (statsResult.status === "rejected") {
						toast.error((statsResult.reason as Error).message);
					}
					return;
				}

				const stats = statsResult.value;
				setPerformanceCategories(stats.map((item) => item.tournament_name));
				setOffenseSeries([
					{ name: "Shots on goal", data: stats.map((item) => item.shots_on_goal) },
					{ name: "Goals", data: stats.map((item) => item.goals) },
				]);
				setDefenseSeries([
					{ name: "Shots against", data: stats.map((item) => item.shots_against) },
					{ name: "Goals let in", data: stats.map((item) => item.goals_against) },
				]);
			} catch {
				setProfile(null);
			} finally {
				setLoading(false);
			}
		})();
	}, [targetUserId]);

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading profile...</div>;
	}

	if (!profile) {
		return <div className="p-6 text-sm text-muted-foreground">Profile not found.</div>;
	}

	const handleSave = async () => {
		if (!canEdit) return;
		if (!targetUserId) return;
		const normalizedFavoriteTeam = form.favorite_team.trim();
		if (normalizedFavoriteTeam) {
			const isAllowedTeam = nhlTeams.some((team) => team.name.toLowerCase() === normalizedFavoriteTeam.toLowerCase());
			if (!isAllowedTeam) {
				toast.error("Favorite NHL Team must match a valid NHL team.");
				return;
			}
		}

		try {
			setSaving(true);
			await updateProfileOverview(targetUserId, {
				bio: form.bio.trim() || null,
				favorite_team: normalizedFavoriteTeam || null,
				club_preference: form.club_preference.trim() || null,
			});
			setProfile((current) =>
				current
					? {
							...current,
							bio: form.bio.trim() || null,
							favorite_team: form.favorite_team.trim() || null,
							club_preference: form.club_preference.trim() || null,
						}
					: current,
			);
			toast.success("Profile updated.");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-4 p-4 md:p-6">
			<h1 className="text-2xl font-semibold">Player Card</h1>
			<p className="text-sm text-muted-foreground">
				{canEdit
					? "You can edit your own player card details."
					: "Viewing another member profile. Only the profile owner can edit details."}
			</p>
			<div className="grid gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Locker room identity</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						<p>
							<span className="text-muted-foreground">Username:</span> {profile.username ?? "Unknown user"}
						</p>
						<div className="space-y-2">
							<p className="text-muted-foreground">Scouting report</p>
							{canEdit ? (
								<Textarea
									value={form.bio}
									onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))}
									placeholder="Describe your style, strengths, and hockey mindset..."
								/>
							) : (
								<p>{profile.bio ?? "No scouting report available."}</p>
							)}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>NHL preferences</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						<div className="space-y-2">
							<p className="text-muted-foreground">Favorite NHL team</p>
							{canEdit ? (
								<>
									<Input
										value={form.favorite_team}
										onChange={(event) => setForm((current) => ({ ...current, favorite_team: event.target.value }))}
										list="nhl-team-options"
										placeholder="e.g. Edmonton Oilers"
									/>
									<datalist id="nhl-team-options">
										{nhlTeams.map((team) => (
											<option key={team.code} value={team.name} />
										))}
									</datalist>
								</>
							) : (
								<p>{profile.favorite_team ?? "No favorite NHL team selected."}</p>
							)}
							{favoriteTeamMeta && (
								<div className="flex items-center gap-2">
									<img
										src={getTeamLogoUrl(favoriteTeamMeta.code, "NHL")}
										alt={`${favoriteTeamMeta.name} logo`}
										className="h-10 w-10 object-contain"
										onError={handleTeamLogoImageError}
									/>
									<span>{favoriteTeamMeta.name}</span>
								</div>
							)}
						</div>
						<div className="space-y-2">
							<p className="text-muted-foreground">Signature game plan</p>
							{canEdit ? (
								<Input
									value={form.club_preference}
									onChange={(event) => setForm((current) => ({ ...current, club_preference: event.target.value }))}
									placeholder="e.g. High-cycle offense + aggressive forecheck"
								/>
							) : (
								<p>{profile.club_preference ?? "No game plan shared."}</p>
							)}
						</div>
						{canEdit && (
							<Button type="button" onClick={() => void handleSave()} disabled={saving}>
								{saving ? "Saving..." : "Save player card"}
							</Button>
						)}
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>Performance tracker</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-4 md:grid-cols-2">
					<Chart
						type="line"
						height={320}
						series={offenseSeries}
						options={{
							chart: { toolbar: { show: false } },
							xaxis: { categories: performanceCategories },
							yaxis: { title: { text: "Total" } },
							legend: { position: "top" },
							stroke: { curve: "smooth", width: 3 },
							title: { text: "Offense by tournament", align: "left" },
						}}
					/>
					<Chart
						type="line"
						height={320}
						series={defenseSeries}
						options={{
							chart: { toolbar: { show: false } },
							xaxis: { categories: performanceCategories },
							yaxis: { title: { text: "Total" } },
							legend: { position: "top" },
							stroke: { curve: "smooth", width: 3 },
							title: { text: "Defense by tournament", align: "left" },
						}}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
