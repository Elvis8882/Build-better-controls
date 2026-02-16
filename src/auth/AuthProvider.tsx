import { supabase } from "@/lib/supabaseClient";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import type { User } from "@supabase/supabase-js";

type AuthContextValue = {
	user: User | null;
	loading: boolean;
	signUp: (username: string, password: string) => Promise<void>;
	signIn: (username: string, password: string) => Promise<void>;
	signOut: () => Promise<void>;
};

const AUTH_EMAIL_DOMAIN = (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) || "nhl.local";

function getPseudoEmail(username: string) {
	return `${username.toLowerCase().trim()}@${AUTH_EMAIL_DOMAIN}`;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let isMounted = true;

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

	const value = useMemo(
		() => ({
			user,
			loading,
			signUp,
			signIn,
			signOut,
		}),
		[user, loading, signUp, signIn, signOut],
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
