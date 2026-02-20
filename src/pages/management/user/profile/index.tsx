import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { getProfileOverview, type ProfileOverview } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

export default function UserProfilePage() {
	const [searchParams] = useSearchParams();
	const { user } = useAuth();
	const [profile, setProfile] = useState<ProfileOverview | null>(null);
	const [loading, setLoading] = useState(true);

	const targetUserId = useMemo(() => searchParams.get("userId") ?? user?.id ?? null, [searchParams, user?.id]);

	useEffect(() => {
		if (!targetUserId) return;
		setLoading(true);
		void getProfileOverview(targetUserId)
			.then(setProfile)
			.catch(() => setProfile(null))
			.finally(() => setLoading(false));
	}, [targetUserId]);

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading profile...</div>;
	}

	if (!profile) {
		return <div className="p-6 text-sm text-muted-foreground">Profile not found.</div>;
	}

	return (
		<div className="space-y-4 p-4 md:p-6">
			<h1 className="text-2xl font-semibold">Profile</h1>
			<p className="text-sm text-muted-foreground">Read-only profile view.</p>
			<div className="grid gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Personal profile overview</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						<p>
							<span className="text-muted-foreground">Username:</span> {profile.username ?? "Unknown user"}
						</p>
						<p>
							<span className="text-muted-foreground">Bio:</span> {profile.bio ?? "No bio available."}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Club preferences</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						<p>
							<span className="text-muted-foreground">Favorite club:</span>{" "}
							{profile.favorite_team ?? "No favorite club selected."}
						</p>
						<p>
							<span className="text-muted-foreground">Play style preference:</span>{" "}
							{profile.club_preference ?? "No preferences shared."}
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
