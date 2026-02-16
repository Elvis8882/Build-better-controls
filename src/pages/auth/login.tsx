import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import Logo from "@/components/logo";
import { GLOBAL_CONFIG } from "@/global-config";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

export default function AuthLoginPage() {
	const navigate = useNavigate();
	const { user, loading, signIn, signUp } = useAuth();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	if (!loading && user) {
		return <Navigate to="/dashboard/main" replace />;
	}

	const handleSignIn = async () => {
		if (!username.trim()) {
			setStatus("Username is required.");
			return;
		}
		setIsSubmitting(true);
		setStatus(null);
		try {
			await signIn(username, password);
			setStatus("Signed in successfully.");
			navigate("/dashboard/main", { replace: true });
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Unable to sign in.");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSignUp = async () => {
		if (!username.trim()) {
			setStatus("Username is required.");
			return;
		}
		if (password.length < 8) {
			setStatus("Password must be at least 8 characters for sign up.");
			return;
		}
		setIsSubmitting(true);
		setStatus(null);
		try {
			await signUp(username, password);
			setStatus("Sign up successful. You can now sign in.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Unable to sign up.");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="min-h-svh flex items-center justify-center p-6 bg-background">
			<div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-sm">
				<div className="flex flex-col items-center justify-center text-center gap-2">
					<Logo size={42} />
					<h1 className="text-xl font-semibold">{GLOBAL_CONFIG.appName}</h1>
				</div>
				<p className="text-sm text-center text-muted-foreground">Use your username and password.</p>

				<div className="space-y-2">
					<label className="text-sm" htmlFor="username">
						Username
					</label>
					<Input
						id="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						placeholder="username"
					/>
				</div>

				<div className="space-y-2">
					<label className="text-sm" htmlFor="password">
						Password
					</label>
					<Input
						id="password"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						placeholder="password"
					/>
				</div>

				<div className="flex gap-2">
					<Button className="flex-1" disabled={isSubmitting} onClick={handleSignIn}>
						Sign in
					</Button>
					<Button type="button" variant="outline" className="flex-1" disabled={isSubmitting} onClick={handleSignUp}>
						Sign up
					</Button>
				</div>

				{status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
			</div>
		</div>
	);
}
