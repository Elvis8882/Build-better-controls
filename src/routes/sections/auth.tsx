import { useAuth } from "@/auth/AuthProvider";
import { LineLoading } from "@/components/loading";
import { Suspense, lazy } from "react";
import { Navigate, Outlet } from "react-router";
import type { RouteObject } from "react-router";

const LoginPage = lazy(() => import("@/pages/auth/login"));

function LoginRoute() {
	const { user, loading } = useAuth();

	if (loading) {
		return <LineLoading />;
	}

	if (user) {
		return <Navigate to="/dashboard/main" replace />;
	}

	return <LoginPage />;
}

export const authRoutes: RouteObject[] = [
	{
		path: "auth",
		element: (
			<Suspense fallback={<LineLoading />}>
				<Outlet />
			</Suspense>
		),
		children: [
			{
				path: "login",
				element: <LoginRoute />,
			},
		],
	},
];
