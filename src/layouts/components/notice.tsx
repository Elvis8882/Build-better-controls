import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Icon } from "@/components/icon";
import {
	acceptFriendRequest,
	listPendingFriendRequests,
	listTournamentNotifications,
	type FriendRequest,
	type TournamentNotification,
} from "@/lib/db";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

function formatRelativeTime(value: string): string {
	const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
	return `${Math.floor(seconds / 86400)} days ago`;
}

function NoticeList({ items }: { items: TournamentNotification[] }) {
	return (
		<ScrollArea className="h-[420px] pr-2">
			<div className="space-y-3 pb-4">
				{items.length === 0 && <p className="text-xs text-muted-foreground">No tournament notifications yet.</p>}
				{items.map((item) => (
					<div key={item.id} className="rounded-xl border bg-card/80 p-3">
						<div className="flex items-start gap-3">
							<Avatar className="h-8 w-8">
								<AvatarFallback>{item.title.charAt(0)}</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium">{item.title}</p>
								<p className="text-xs text-muted-foreground">{item.description}</p>
								<p className="mt-1 text-xs text-muted-foreground">{formatRelativeTime(item.created_at)}</p>
							</div>
						</div>
					</div>
				))}
			</div>
		</ScrollArea>
	);
}

export default function NoticeButton() {
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [notificationItems, setNotificationItems] = useState<TournamentNotification[]>([]);
	const [friendRequestItems, setFriendRequestItems] = useState<FriendRequest[]>([]);
	const [loadingRequests, setLoadingRequests] = useState(false);
	const { user } = useAuth();

	const refreshFriendRequests = useCallback(async () => {
		if (!user?.id) return;
		setLoadingRequests(true);
		try {
			const data = await listPendingFriendRequests(user.id);
			setFriendRequestItems(data);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoadingRequests(false);
		}
	}, [user?.id]);

	const refreshTournamentNotifications = useCallback(async () => {
		if (!user?.id) return;
		try {
			const data = await listTournamentNotifications(user.id);
			setNotificationItems(data);
		} catch (error) {
			toast.error((error as Error).message);
		}
	}, [user?.id]);

	useEffect(() => {
		if (!drawerOpen) return;
		void refreshFriendRequests();
		void refreshTournamentNotifications();
	}, [drawerOpen, refreshFriendRequests, refreshTournamentNotifications]);
	const totalCount = useMemo(
		() => notificationItems.length + friendRequestItems.length,
		[friendRequestItems.length, notificationItems.length],
	);

	return (
		<>
			<div className="relative">
				<Button variant="ghost" size="icon" className="rounded-full" onClick={() => setDrawerOpen(true)}>
					<Icon icon="solar:bell-bing-bold-duotone" size={24} />
				</Button>
				<Badge variant="destructive" shape="circle" className="absolute -right-2 -top-2">
					{totalCount}
				</Badge>
			</div>
			<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
				<SheetContent side="right" className="sm:max-w-md p-0 [&>button]:hidden flex flex-col">
					<SheetHeader className="flex flex-row items-center justify-between p-4 h-16 shrink-0 border-b">
						<SheetTitle>Notification center</SheetTitle>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setNotificationItems([]);
								setFriendRequestItems([]);
							}}
						>
							Mark all as read
						</Button>
					</SheetHeader>

					<div className="px-4 pt-3 pb-4">
						<Tabs defaultValue="notifications" className="w-full">
							<TabsList className="grid w-full grid-cols-2">
								<TabsTrigger value="notifications">Notifications</TabsTrigger>
								<TabsTrigger value="friend-requests">Friend requests</TabsTrigger>
							</TabsList>
							<TabsContent value="notifications">
								<NoticeList items={notificationItems} />
							</TabsContent>
							<TabsContent value="friend-requests">
								<ScrollArea className="h-[420px] pr-2">
									<div className="space-y-3 pb-4">
										{loadingRequests && <p className="text-xs text-muted-foreground">Loading friend requests…</p>}
										{friendRequestItems.map((item) => (
											<div key={item.id} className="rounded-xl border bg-card/80 p-3">
												<p className="text-sm font-medium">{item.sender_username} sent a friend request</p>
												<p className="mt-1 text-xs text-muted-foreground">Wants to connect and invite you faster.</p>
												<Button
													className="mt-2"
													size="sm"
													onClick={() => {
														if (!user?.id) return;
														void acceptFriendRequest(item.id, user.id)
															.then(refreshFriendRequests)
															.then(() => toast.success("Friend request accepted."))
															.catch((error) => toast.error((error as Error).message));
													}}
												>
													Accept
												</Button>
											</div>
										))}
										{!loadingRequests && friendRequestItems.length === 0 && (
											<p className="text-xs text-muted-foreground">No pending friend requests.</p>
										)}
									</div>
								</ScrollArea>
							</TabsContent>
						</Tabs>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
