import { NavLink } from "react-router";

const updates = [
	"Welcome to Build Better Controls. Follow the latest tournament updates here.",
	"Player profile improvements are now available with cleaner stats cards.",
	"Admin panel access has been restored for administrator accounts.",
	"Notification center now includes in-site notifications and friend requests only.",
];

export default function LandingPage() {
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-6xl bg-background">
			<aside className="w-64 border-r p-6">
				<h1 className="mb-6 text-lg font-semibold">Build Better Controls</h1>
				<nav className="space-y-2">
					<NavLink
						className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
						to="/dashboard/tournaments"
					>
						Tournaments
					</NavLink>
					<NavLink className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent" to="/dashboard/profile">
						Profile
					</NavLink>
				</nav>
			</aside>

			<main className="flex-1 p-8">
				<div className="mb-6">
					<h2 className="text-2xl font-semibold">Latest updates</h2>
					<p className="text-sm text-muted-foreground">Recent changes and product news in one place.</p>
				</div>
				<div className="space-y-3">
					{updates.map((update) => (
						<div key={update} className="rounded-xl border bg-card px-4 py-3 text-sm">
							{update}
						</div>
					))}
				</div>
			</main>
		</div>
	);
}
