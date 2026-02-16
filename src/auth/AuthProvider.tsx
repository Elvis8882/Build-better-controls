import type { User } from "@supabase/supabase-js";
import type { PropsWithChildren } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type AuthContextValue = {
	user: User | null;
	isAdmin: boolean;
	loading: boolean;
	signUp: (username: string, password: string) => Promise<void>;
	signIn: (username: string, password: string) => Promise<void>;
	signOut: () => Promise<void>;
};

const AUTH_EMAIL_DOMAIN = (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) || "nhl.local";
const LOCAL_ADMIN_SESSION_KEY = "local-admin-session";

const ADMIN_CREDENTIALS = {
	username: "admin",
	password: "admin",
};

function getPseudoEmail(username: string) {
	return `${username.toLowerCase().trim()}@${AUTH_EMAIL_DOMAIN}`;
}

function getUsernameFromUser(user: User | null) {
	if (!user?.email) return "";
	return user.email.split("@")[0]?.toLowerCase() || "";
}

function isLocalAdminUser(user: User | null) {
	const hasLocalAdminSession = localStorage.getItem(LOCAL_ADMIN_SESSION_KEY) === "true";
	return hasLocalAdminSession && user?.id === "local-admin" && getUsernameFromUser(user) === ADMIN_CREDENTIALS.username;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let isMounted = true;

		const isLocalAdminSession = localStorage.getItem(LOCAL_ADMIN_SESSION_KEY) === "true";
		if (isLocalAdminSession) {
			setUser({
				id: "local-admin",
				email: getPseudoEmail(ADMIN_CREDENTIALS.username),
				app_metadata: {},
				user_metadata: { username: ADMIN_CREDENTIALS.username },
				aud: "authenticated",
				created_at: new Date().toISOString(),
			} as User);
			setLoading(false);
			return () => {
				isMounted = false;
			};
		}

		supabase.auth.getSession().then(({ data }) => {
			if (!isMounted) return;
			setUser(data.session?.user ?? null);
			setLoading(false);
		});

		const {
			data: { subscription },
		} = supabase.auth.onAuthStateChange((_event, session) => {
			setUser(session?.user ?? null);
			setLoading(false);
		});

		return () => {
			isMounted = false;
			subscription.unsubscribe();
		};
	}, []);

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
		if (username.trim().toLowerCase() === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
			localStorage.setItem(LOCAL_ADMIN_SESSION_KEY, "true");
			setUser({
				id: "local-admin",
				email: getPseudoEmail(ADMIN_CREDENTIALS.username),
				app_metadata: {},
				user_metadata: { username: ADMIN_CREDENTIALS.username },
				aud: "authenticated",
				created_at: new Date().toISOString(),
			} as User);
			return;
		}

		localStorage.removeItem(LOCAL_ADMIN_SESSION_KEY);

		const email = getPseudoEmail(username);
		const { error } = await supabase.auth.signInWithPassword({
			email,
			password,
		});
		if (error) throw error;
	}, []);

	const signOut = useCallback(async () => {
		if (localStorage.getItem(LOCAL_ADMIN_SESSION_KEY) === "true") {
			localStorage.removeItem(LOCAL_ADMIN_SESSION_KEY);
			setUser(null);
			return;
		}

		const { error } = await supabase.auth.signOut();
		if (error) throw error;
	}, []);

	const isAdmin = isLocalAdminUser(user);

	const value = useMemo(
		() => ({
			user,
			isAdmin,
			loading,
			signUp,
			signIn,
			signOut,
		}),
		[user, isAdmin, loading, signUp, signIn, signOut],
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
