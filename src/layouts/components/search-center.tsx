import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Icon } from "@/components/icon";
import { searchRegisteredProfiles, sendFriendRequest, type RegisteredProfile } from "@/lib/db";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";

export default function SearchCenter() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [users, setUsers] = useState<RegisteredProfile[]>([]);
	const [loadingUsers, setLoadingUsers] = useState(false);
	const [pendingUsernames, setPendingUsernames] = useState<Set<string>>(new Set());
	const { user } = useAuth();

	useEffect(() => {
		const term = query.trim();
		if (!term) {
			setUsers([]);
			return;
		}
		setLoadingUsers(true);
		const timer = window.setTimeout(() => {
			void searchRegisteredProfiles(term)
				.then((data) => setUsers(data))
				.catch((error) => toast.error((error as Error).message))
				.finally(() => setLoadingUsers(false));
		}, 250);
		return () => window.clearTimeout(timer);
	}, [query]);

	return (
		<>
			<Button variant="ghost" size="icon" className="rounded-full" onClick={() => setOpen(true)}>
				<Icon icon="solar:magnifer-bold-duotone" size={22} />
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent side="right" className="sm:max-w-md p-0 [&>button]:hidden flex flex-col">
					<SheetHeader className="flex flex-row items-center justify-between p-4 h-16 shrink-0 border-b">
						<SheetTitle>Search users</SheetTitle>
					</SheetHeader>
					<div className="p-4 pt-3 space-y-3 border-b">
						<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users" />
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Badge className="bg-emerald-500 text-white hover:bg-emerald-500">Registered users</Badge>
						</div>
					</div>

					<ScrollArea className="h-[460px] p-4">
						<div className="space-y-3">
							{loadingUsers && <p className="text-xs text-muted-foreground">Searching…</p>}
							{users.map((item) => {
								const isCurrentUser = item.id === user?.id;
								const isPending = pendingUsernames.has(item.username);
								return (
									<div key={item.id} className="rounded-xl border bg-card/80 p-3 space-y-2">
										<div className="flex items-center justify-between gap-3">
											<p className="text-sm font-medium truncate">{item.username}</p>
											<Badge className="bg-emerald-500 text-white hover:bg-emerald-500">User</Badge>
										</div>
										<Button
											size="sm"
											disabled={isCurrentUser || isPending || !user?.id}
											onClick={() => {
												if (!user?.id || isCurrentUser) return;
												void sendFriendRequest(user.id, item.username)
													.then(() => {
														setPendingUsernames((previous) => new Set(previous).add(item.username));
														toast.success(`Friend request sent to ${item.username}.`);
													})
													.catch((error) => toast.error((error as Error).message));
											}}
										>
											{isCurrentUser ? "You" : isPending ? "Request sent" : "Add friend"}
										</Button>
									</div>
								);
							})}
							{!loadingUsers && query.trim() && users.length === 0 && (
								<p className="text-xs text-muted-foreground">No users found.</p>
							)}
						</div>
					</ScrollArea>
				</SheetContent>
			</Sheet>
		</>
	);
}
