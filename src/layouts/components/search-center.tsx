import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { useSocialStore } from "@/store/socialStore";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";

type SearchItem =
	| {
			type: "topic";
			id: string;
			name: string;
			description: string;
	  }
	| {
			type: "user";
			id: string;
			name: string;
			role: "admin" | "user";
			bio: string;
	  };

const SEARCH_ITEMS: SearchItem[] = [
	{ type: "topic", id: "topic-1", name: "NHL Playoffs", description: "Bracket predictions and team form discussions." },
	{
		type: "topic",
		id: "topic-2",
		name: "Goalie Analysis",
		description: "Performance comparisons and save percentage trends.",
	},
	{
		type: "user",
		id: "user-1",
		name: "Alex Morgan",
		role: "user",
		bio: "Follows Eastern conference trades and stats.",
	},
	{ type: "user", id: "user-2", name: "Taylor Kim", role: "admin", bio: "Club moderator and tournament organizer." },
	{
		type: "user",
		id: "user-3",
		name: "Jamie Scott",
		role: "user",
		bio: "Enjoys sharing match clips and post-game analysis.",
	},
];

export default function SearchCenter() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedUser, setSelectedUser] = useState<SearchItem | null>(null);
	const [sentRequests, setSentRequests] = useState<string[]>([]);
	const { addFriendRequest } = useSocialStore();

	const filteredItems = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return SEARCH_ITEMS;
		return SEARCH_ITEMS.filter((item) => {
			if (item.type === "topic") {
				return item.name.toLowerCase().includes(normalized) || item.description.toLowerCase().includes(normalized);
			}
			return item.name.toLowerCase().includes(normalized) || item.bio.toLowerCase().includes(normalized);
		});
	}, [query]);

	return (
		<>
			<Button variant="ghost" size="icon" className="rounded-full" onClick={() => setOpen(true)}>
				<Icon icon="solar:magnifer-bold-duotone" size={22} />
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent side="right" className="sm:max-w-md p-0 [&>button]:hidden flex flex-col">
					<SheetHeader className="flex flex-row items-center justify-between p-4 h-16 shrink-0 border-b">
						<SheetTitle>Search center</SheetTitle>
					</SheetHeader>
					<div className="p-4 pt-3 space-y-3 border-b">
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search topics or users"
						/>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Badge className="bg-blue-500 text-white hover:bg-blue-500">Topic</Badge>
							<Badge className="bg-emerald-500 text-white hover:bg-emerald-500">User</Badge>
						</div>
					</div>

					<ScrollArea className="h-[460px] p-4">
						<div className="space-y-3">
							{filteredItems.map((item) => (
								<div key={item.id} className="rounded-xl border bg-card/80 p-3 space-y-2">
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0">
											<p className="text-sm font-medium truncate">{item.name}</p>
											<p className="text-xs text-muted-foreground">
												{item.type === "topic" ? item.description : item.bio}
											</p>
										</div>
										<Badge
											className={
												item.type === "topic"
													? "bg-blue-500 text-white hover:bg-blue-500"
													: "bg-emerald-500 text-white hover:bg-emerald-500"
											}
										>
											{item.type === "topic" ? "Topic" : `User • ${item.role}`}
										</Badge>
									</div>
									{item.type === "user" ? (
										<div className="flex gap-2">
											<Button variant="outline" size="sm" onClick={() => setSelectedUser(item)}>
												View info
											</Button>
											<Button
												size="sm"
												disabled={sentRequests.includes(item.id)}
												onClick={() => {
													addFriendRequest(item.name);
													setSentRequests((prev) => [...prev, item.id]);
												}}
											>
												{sentRequests.includes(item.id) ? "Request sent" : "Add friend"}
											</Button>
										</div>
									) : null}
								</div>
							))}
						</div>
					</ScrollArea>

					{selectedUser && selectedUser.type === "user" ? (
						<div className="border-t p-4 bg-muted/30">
							<p className="text-sm font-semibold">{selectedUser.name}</p>
							<p className="text-xs text-muted-foreground">Role: {selectedUser.role}</p>
							<p className="mt-2 text-xs">{selectedUser.bio}</p>
						</div>
					) : null}
				</SheetContent>
			</Sheet>
		</>
	);
}
