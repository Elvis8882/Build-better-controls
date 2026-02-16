import { create } from "zustand";

export type SocialNoticeItem = {
	id: string;
	title: string;
	description: string;
	time: string;
};

type SocialStore = {
	friendRequestItems: SocialNoticeItem[];
	addFriendRequest: (username: string) => void;
	clearFriendRequests: () => void;
};

const INITIAL_FRIEND_REQUESTS: SocialNoticeItem[] = [
	{
		id: "friend-1",
		title: "Alex Morgan sent a friend request",
		description: "Wants to connect and follow your tournament activity.",
		time: "12 mins ago",
	},
	{
		id: "friend-2",
		title: "Taylor Kim sent a friend request",
		description: "Wants to team up for upcoming qualifiers.",
		time: "1 hour ago",
	},
];

export const useSocialStore = create<SocialStore>((set) => ({
	friendRequestItems: INITIAL_FRIEND_REQUESTS,
	addFriendRequest: (username) => {
		set((state) => {
			const exists = state.friendRequestItems.some((item) => item.id === `friend-${username.toLowerCase()}`);
			if (exists) return state;

			return {
				friendRequestItems: [
					{
						id: `friend-${username.toLowerCase()}`,
						title: `${username} sent a friend request`,
						description: "Requested to follow your matches and topic updates.",
						time: "just now",
					},
					...state.friendRequestItems,
				],
			};
		});
	},
	clearFriendRequests: () => set({ friendRequestItems: [] }),
}));
