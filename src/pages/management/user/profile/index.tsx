import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Chart } from "@/components/chart";
import defaultAvatar from "@/assets/images/avatars/avatar-1.png";
import { useAuth } from "@/auth/AuthProvider";
import {
	fetchTeamsByPool,
	getProfileOverview,
	listUserTeamTournamentPerformance,
	listUserTournamentPerformance,
	type PlayerTeamTournamentPerformance,
	type ProfileOverview,
	type Team,
	updateProfileOverview,
} from "@/lib/db";
import { getTeamLogoUrl, handleTeamLogoImageError } from "@/lib/teamLogos";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Textarea } from "@/ui/textarea";

type ProfileFormState = {
	bio: string;
	favorite_team: string;
	club_preference: string;
	avatar_url: string;
};

const AVATAR_PREVIEW_SIZE = 120;

async function resizeAvatar(file: File): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("Unable to read image."));
		reader.readAsDataURL(file);
	});

	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve(element);
		element.onerror = () => reject(new Error("Invalid image file."));
		element.src = dataUrl;
	});

	const canvas = document.createElement("canvas");
	canvas.width = AVATAR_PREVIEW_SIZE;
	canvas.height = AVATAR_PREVIEW_SIZE;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Unable to process avatar image.");

	const scale = Math.max(AVATAR_PREVIEW_SIZE / image.width, AVATAR_PREVIEW_SIZE / image.height);
	const drawWidth = image.width * scale;
	const drawHeight = image.height * scale;
	const offsetX = (AVATAR_PREVIEW_SIZE - drawWidth) / 2;
	const offsetY = (AVATAR_PREVIEW_SIZE - drawHeight) / 2;
	context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
	return canvas.toDataURL("image/jpeg", 0.9);
}

export default function UserProfilePage() {
	const [searchParams] = useSearchParams();
	const { user } = useAuth();
	const [profile, setProfile] = useState<ProfileOverview | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [isEditing, setIsEditing] = useState(true);
	const [offenseSeries, setOffenseSeries] = useState([
		{ name: "Shots on goal", data: [0] },
		{ name: "Goals", data: [0] },
	]);
	const [defenseSeries, setDefenseSeries] = useState([
		{ name: "Shots against", data: [0] },
		{ name: "Goals let in", data: [0] },
	]);
	const [performanceCategories, setPerformanceCategories] = useState(["Total"]);
	const [tournamentPerformance, setTournamentPerformance] = useState<
		Array<{
			tournament_id: string;
			tournament_name: string;
			tournament_date: string;
			shots_on_goal: number;
			goals: number;
			shots_against: number;
			goals_against: number;
		}>
	>([]);
	const [teamTournamentPerformance, setTeamTournamentPerformance] = useState<PlayerTeamTournamentPerformance[]>([]);
	const [selectedPerformanceTeamId, setSelectedPerformanceTeamId] = useState("all");
	const [nhlTeams, setNhlTeams] = useState<Array<Pick<Team, "code" | "name">>>([]);
	const [form, setForm] = useState<ProfileFormState>({
		bio: "",
		favorite_team: "",
		club_preference: "",
		avatar_url: "",
	});

	const targetUserId = useMemo(() => searchParams.get("userId") ?? user?.id ?? null, [searchParams, user?.id]);
	const canEdit = Boolean(user?.id && targetUserId && user.id === targetUserId);
	const editLocked = !canEdit || !isEditing;

	const favoriteTeamMeta = useMemo(
		() => nhlTeams.find((team) => team.name.toLowerCase() === form.favorite_team.trim().toLowerCase()) ?? null,
		[form.favorite_team, nhlTeams],
	);
	const teamSuggestions = useMemo(() => {
		const query = form.favorite_team.trim().toLowerCase();
		if (!query) return nhlTeams.slice(0, 8);
		return nhlTeams.filter((team) => team.name.toLowerCase().includes(query)).slice(0, 8);
	}, [form.favorite_team, nhlTeams]);
	const showTeamSuggestions = useMemo(() => {
		if (editLocked) return false;
		const normalizedValue = form.favorite_team.trim().toLowerCase();
		if (!normalizedValue) return false;
		const exactMatch = nhlTeams.some((team) => team.name.toLowerCase() === normalizedValue);
		return !exactMatch && teamSuggestions.length > 0;
	}, [editLocked, form.favorite_team, nhlTeams, teamSuggestions]);

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
					Promise.all([listUserTournamentPerformance(targetUserId), listUserTeamTournamentPerformance(targetUserId)]),
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
					avatar_url: resolvedProfile?.avatar_url ?? "",
				});
				setIsEditing(
					!(
						resolvedProfile?.bio ||
						resolvedProfile?.favorite_team ||
						resolvedProfile?.club_preference ||
						resolvedProfile?.avatar_url
					),
				);

				if (statsResult.status !== "fulfilled" || statsResult.value[0].length === 0) {
					setPerformanceCategories(["Total"]);
					setOffenseSeries([
						{ name: "Shots on goal", data: [0] },
						{ name: "Goals", data: [0] },
					]);
					setDefenseSeries([
						{ name: "Shots against", data: [0] },
						{ name: "Goals let in", data: [0] },
					]);
					setTournamentPerformance([]);
					setTeamTournamentPerformance([]);
					setSelectedPerformanceTeamId("all");

					if (statsResult.status === "rejected") {
						toast.error((statsResult.reason as Error).message);
					}
					return;
				}

				const [tournamentStats, teamStats] = statsResult.value;
				setTournamentPerformance(tournamentStats);
				setPerformanceCategories(tournamentStats.map((item) => item.tournament_name));
				setOffenseSeries([
					{ name: "Shots on goal", data: tournamentStats.map((item) => item.shots_on_goal) },
					{ name: "Goals", data: tournamentStats.map((item) => item.goals) },
				]);
				setDefenseSeries([
					{ name: "Shots against", data: tournamentStats.map((item) => item.shots_against) },
					{ name: "Goals let in", data: tournamentStats.map((item) => item.goals_against) },
				]);
				setTeamTournamentPerformance(teamStats);
				setSelectedPerformanceTeamId("all");
			} catch {
				setProfile(null);
			} finally {
				setLoading(false);
			}
		})();
	}, [targetUserId]);

	useEffect(() => {
		if (tournamentPerformance.length === 0) {
			setPerformanceCategories(["Total"]);
			setOffenseSeries([
				{ name: "Shots on goal", data: [0] },
				{ name: "Goals", data: [0] },
			]);
			setDefenseSeries([
				{ name: "Shots against", data: [0] },
				{ name: "Goals let in", data: [0] },
			]);
			return;
		}

		if (selectedPerformanceTeamId === "all") {
			setPerformanceCategories(tournamentPerformance.map((item) => item.tournament_name));
			setOffenseSeries([
				{ name: "Shots on goal", data: tournamentPerformance.map((item) => item.shots_on_goal) },
				{ name: "Goals", data: tournamentPerformance.map((item) => item.goals) },
			]);
			setDefenseSeries([
				{ name: "Shots against", data: tournamentPerformance.map((item) => item.shots_against) },
				{ name: "Goals let in", data: tournamentPerformance.map((item) => item.goals_against) },
			]);
			return;
		}

		const selectedTeamRows = teamTournamentPerformance.filter((item) => item.team_id === selectedPerformanceTeamId);
		if (selectedTeamRows.length === 0) {
			setPerformanceCategories(["Total"]);
			setOffenseSeries([
				{ name: "Shots on goal", data: [0] },
				{ name: "Goals", data: [0] },
			]);
			setDefenseSeries([
				{ name: "Shots against", data: [0] },
				{ name: "Goals let in", data: [0] },
			]);
			return;
		}
		setPerformanceCategories(selectedTeamRows.map((item) => item.tournament_name));
		setOffenseSeries([
			{ name: "Shots on goal", data: selectedTeamRows.map((item) => item.shots_on_goal) },
			{ name: "Goals", data: selectedTeamRows.map((item) => item.goals) },
		]);
		setDefenseSeries([
			{ name: "Shots against", data: selectedTeamRows.map((item) => item.shots_against) },
			{ name: "Goals let in", data: selectedTeamRows.map((item) => item.goals_against) },
		]);
	}, [selectedPerformanceTeamId, teamTournamentPerformance, tournamentPerformance]);

	const playedTeams = useMemo(
		() =>
			[
				...new Map(
					teamTournamentPerformance.map((item) => [item.team_id, { team_id: item.team_id, team_name: item.team_name }]),
				).values(),
			].sort((a, b) => a.team_name.localeCompare(b.team_name, undefined, { sensitivity: "base" })),
		[teamTournamentPerformance],
	);

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading profile...</div>;
	}

	if (!profile) {
		return <div className="p-6 text-sm text-muted-foreground">Profile not found.</div>;
	}

	const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			const resized = await resizeAvatar(file);
			setForm((current) => ({ ...current, avatar_url: resized }));
		} catch (error) {
			toast.error((error as Error).message);
		}
	};

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
				avatar_url: form.avatar_url.trim() || null,
			});
			setProfile((current) =>
				current
					? {
							...current,
							bio: form.bio.trim() || null,
							favorite_team: form.favorite_team.trim() || null,
							club_preference: form.club_preference.trim() || null,
							avatar_url: form.avatar_url.trim() || null,
						}
					: current,
			);
			setIsEditing(false);
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
					? "Save player card to lock it. Use Edit to update later."
					: "Viewing another member profile. Only the profile owner can edit details."}
			</p>
			<div className="grid gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Locker room identity</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						<div className="flex flex-col items-center space-y-2 text-center">
							<p className="text-muted-foreground">Custom avatar</p>
							<img
								src={form.avatar_url || defaultAvatar}
								alt="Profile avatar"
								className="h-24 w-24 rounded-full border object-cover"
							/>
							{canEdit && (
								<label
									className={`inline-flex h-9 cursor-pointer items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors ${
										editLocked ? "pointer-events-none opacity-50" : "hover:bg-muted"
									}`}
								>
									Choose avatar
									<input
										type="file"
										accept="image/*"
										onChange={(event) => void handleAvatarUpload(event)}
										disabled={editLocked}
										className="hidden"
									/>
								</label>
							)}
						</div>
						<p>
							<span className="text-muted-foreground">Username:</span> {profile.username ?? "Unknown user"}
						</p>
						<div className="space-y-2">
							<p className="text-muted-foreground">Scouting report</p>
							{canEdit ? (
								<Textarea
									className={editLocked ? "bg-muted text-muted-foreground" : undefined}
									value={form.bio}
									onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))}
									placeholder="Describe your style, strengths, and hockey mindset..."
									disabled={editLocked}
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
						{favoriteTeamMeta && (
							<div className="flex justify-center">
								<img
									src={getTeamLogoUrl(favoriteTeamMeta.code, "NHL")}
									alt={`${favoriteTeamMeta.name} logo`}
									className="h-24 w-24 object-contain"
									onError={handleTeamLogoImageError}
								/>
							</div>
						)}
						<div className="space-y-2">
							<p className="text-muted-foreground">Favorite NHL team</p>
							{canEdit ? (
								<div className="space-y-2">
									<Input
										className={editLocked ? "bg-muted text-muted-foreground" : undefined}
										value={form.favorite_team}
										onChange={(event) => setForm((current) => ({ ...current, favorite_team: event.target.value }))}
										placeholder="Start typing NHL team name"
										disabled={editLocked}
									/>
									{showTeamSuggestions && (
										<div className="max-h-36 overflow-y-auto rounded-md border bg-background p-1">
											{teamSuggestions.map((team) => (
												<button
													type="button"
													className="w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-muted"
													onClick={() => setForm((current) => ({ ...current, favorite_team: team.name }))}
													key={team.code}
												>
													{team.name}
												</button>
											))}
										</div>
									)}
								</div>
							) : (
								<p>{profile.favorite_team ?? "No favorite NHL team selected."}</p>
							)}
						</div>
						<div className="space-y-2">
							<p className="text-muted-foreground">Signature game plan</p>
							{canEdit ? (
								<Input
									className={editLocked ? "bg-muted text-muted-foreground" : undefined}
									value={form.club_preference}
									onChange={(event) => setForm((current) => ({ ...current, club_preference: event.target.value }))}
									placeholder="e.g. High-cycle offense + aggressive forecheck"
									disabled={editLocked}
								/>
							) : (
								<p>{profile.club_preference ?? "No game plan shared."}</p>
							)}
						</div>
						{canEdit && (
							<div className="flex gap-2">
								<Button type="button" onClick={() => void handleSave()} disabled={saving || !isEditing}>
									{saving ? "Saving..." : "Save player card"}
								</Button>
								<Button type="button" variant="outline" onClick={() => setIsEditing(true)} disabled={isEditing}>
									Edit
								</Button>
							</div>
						)}
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>Performance tracker</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1">
						<p className="text-sm text-muted-foreground">Team statistics view</p>
						<Select value={selectedPerformanceTeamId} onValueChange={setSelectedPerformanceTeamId}>
							<SelectTrigger className="max-w-sm">
								<SelectValue placeholder="Select team statistics scope" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">Total (all teams)</SelectItem>
								{playedTeams.map((teamStat) => (
									<SelectItem key={teamStat.team_id} value={teamStat.team_id}>
										{teamStat.team_name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-4 md:grid-cols-2">
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
							}}
						/>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
