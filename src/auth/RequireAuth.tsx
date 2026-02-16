import { useAuth } from "@/auth/AuthProvider";
import { Navigate, Outlet } from "react-router";

export default function RequireAuth() {
	const { user, loading } = useAuth();

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading authentication...</div>;
	}

	if (!user) {
		return <Navigate to="/auth/login" replace />;
	}

	return <Outlet />;
}
