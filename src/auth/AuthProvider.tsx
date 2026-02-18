import type { User } from "@supabase/supabase-js";
import type { PropsWithChildren } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type AuthContextValue = {
	user: User | null;
	profile: Profile | null;
	isAdmin: boolean;
	loading: boolean;
	signUp: (username: string, password: string) => Promise<void>;
	signIn: (username: string, password: string) => Promise<void>;
	signOut: () => Promise<void>;
};

type Profile = {
	username: string | null;
	role: string | null;
};

const AUTH_EMAIL_DOMAIN = (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) || "nhl.local";

function getPseudoEmail(username: string) {
	return `${username.toLowerCase().trim()}@${AUTH_EMAIL_DOMAIN}`;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const LOGIN_ROUTE = "/auth/login";

export function AuthProvider({ children }: PropsWithChildren) {
	const [user, setUser] = useState<User | null>(null);
	const [profile, setProfile] = useState<Profile | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchProfile = useCallback(async (authUser: User | null): Promise<Profile | null> => {
		if (!authUser) return null;

		const { data, error } = await supabase
			.from("profiles")
			.select("username, role")
			.eq("id", authUser.id)
			.maybeSingle();

		if (error) {
			console.error("Unable to fetch user profile", error);
			return null;
		}

		return data
			? {
					username: data.username,
					role: data.role,
				}
			: null;
	}, []);

	useEffect(() => {
		let isMounted = true;

		supabase.auth.getSession().then(async ({ data, error }) => {
			if (!isMounted) return;

			if (error) {
				console.error("Unable to get current session", error);
				setUser(null);
				setProfile(null);
				setLoading(false);
				return;
			}

			const currentUser = data.session?.user ?? null;
			if (!data.session && window.location.pathname !== LOGIN_ROUTE) {
				window.location.assign(LOGIN_ROUTE);
			}
			setUser(currentUser);

			const currentProfile = await fetchProfile(currentUser);
			if (!isMounted) return;
			setProfile(currentProfile);
			setLoading(false);
		});

		const {
			data: { subscription },
		} = supabase.auth.onAuthStateChange(async (event, session) => {
			const currentUser = session?.user ?? null;

			if (event === "SIGNED_OUT" || !session) {
				setUser(null);
				setProfile(null);
				setLoading(false);
				if (window.location.pathname !== LOGIN_ROUTE) {
					window.location.assign(LOGIN_ROUTE);
				}
				return;
			}

			setUser(currentUser);

			if (event === "TOKEN_REFRESHED") {
				console.info("Supabase token refreshed");
			}

			const currentProfile = await fetchProfile(currentUser);
			if (!isMounted) return;
			setProfile(currentProfile);
			setLoading(false);
		});

		return () => {
			isMounted = false;
			subscription.unsubscribe();
		};
	}, [fetchProfile]);

	const signUp = useCallback(async (username: string, password: string) => {
		const email = getPseudoEmail(username);
		const { error } = await supabase.auth.signUp({
			email,
			password,
			options: {
				data: { username },
			},
		});
		if (error) throw error;
	}, []);

	const signIn = useCallback(async (username: string, password: string) => {
		const email = getPseudoEmail(username);
		const { error } = await supabase.auth.signInWithPassword({
			email,
			password,
		});
		if (error) throw error;
	}, []);

	const signOut = useCallback(async () => {
		const { error } = await supabase.auth.signOut();
		if (error) throw error;
	}, []);

	const isAdmin = profile?.role === "admin";

	const value = useMemo(
		() => ({
			user,
			profile,
			isAdmin,
			loading,
			signUp,
			signIn,
			signOut,
		}),
		[user, profile, isAdmin, loading, signUp, signIn, signOut],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}
