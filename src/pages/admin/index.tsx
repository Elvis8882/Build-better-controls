import { useAuth } from "@/auth/AuthProvider";
import Page403 from "@/pages/sys/error/Page403";

export default function AdminPanelPage() {
	const { isAdmin } = useAuth();

	if (!isAdmin) {
		return <Page403 />;
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Admin panel</h1>
				<p className="text-sm text-muted-foreground">
					Manage platform-level controls available only to the admin account.
				</p>
			</div>

			<div className="grid gap-4 md:grid-cols-3">
				<div className="rounded-xl border bg-card p-4">
					<p className="text-sm text-muted-foreground">Active users</p>
					<p className="mt-1 text-2xl font-semibold">128</p>
				</div>
				<div className="rounded-xl border bg-card p-4">
					<p className="text-sm text-muted-foreground">Pending reports</p>
					<p className="mt-1 text-2xl font-semibold">6</p>
				</div>
				<div className="rounded-xl border bg-card p-4">
					<p className="text-sm text-muted-foreground">Open support tickets</p>
					<p className="mt-1 text-2xl font-semibold">14</p>
				</div>
			</div>
		</div>
	);
}
