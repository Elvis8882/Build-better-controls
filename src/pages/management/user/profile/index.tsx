import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Chart } from "@/components/chart";
import { useAuth } from "@/auth/AuthProvider";
import { getProfileOverview, listUserTeamStats, type ProfileOverview, updateProfileOverview } from "@/lib/db";
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
	const [performanceSeries, setPerformanceSeries] = useState([
		{ name: "Goals", data: [0] },
		{ name: "Shots on goal", data: [0] },
		{ name: "Goals let in", data: [0] },
	]);
	const [performanceCategories, setPerformanceCategories] = useState(["Career"]);
	const [form, setForm] = useState<ProfileFormState>({ bio: "", favorite_team: "", club_preference: "" });

	const targetUserId = useMemo(() => searchParams.get("userId") ?? user?.id ?? null, [searchParams, user?.id]);
	const canEdit = Boolean(user?.id && targetUserId && user.id === targetUserId);

	useEffect(() => {
		if (!targetUserId) return;
		setLoading(true);
		void Promise.all([getProfileOverview(targetUserId), listUserTeamStats(targetUserId)])
			.then(([profileData, stats]) => {
				setProfile(profileData);
				setForm({
					bio: profileData?.bio ?? "",
					favorite_team: profileData?.favorite_team ?? "",
					club_preference: profileData?.club_preference ?? "",
				});

				if (stats.length === 0) {
					setPerformanceCategories(["Career"]);
					setPerformanceSeries([
						{ name: "Goals", data: [0] },
						{ name: "Shots on goal", data: [0] },
						{ name: "Goals let in", data: [0] },
					]);
					return;
				}

				setPerformanceCategories(stats.map((item) => item.team_code));
				setPerformanceSeries([
					{ name: "Goals", data: stats.map((item) => item.goals_made) },
					{ name: "Shots on goal", data: stats.map((item) => item.shots_made) },
					{ name: "Goals let in", data: stats.map((item) => item.goals_received) },
				]);
			})
			.catch(() => {
				setProfile(null);
			})
			.finally(() => setLoading(false));
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

		try {
			setSaving(true);
			await updateProfileOverview(targetUserId, {
				bio: form.bio.trim() || null,
				favorite_team: form.favorite_team.trim() || null,
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
								<Input
									value={form.favorite_team}
									onChange={(event) => setForm((current) => ({ ...current, favorite_team: event.target.value }))}
									placeholder="e.g. Edmonton Oilers"
								/>
							) : (
								<p>{profile.favorite_team ?? "No favorite NHL team selected."}</p>
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
				<CardContent>
					<Chart
						type="bar"
						height={320}
						series={performanceSeries}
						options={{
							chart: { toolbar: { show: false } },
							xaxis: { categories: performanceCategories },
							yaxis: { title: { text: "Total" } },
							legend: { position: "top" },
							plotOptions: { bar: { borderRadius: 4, columnWidth: "55%" } },
						}}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
