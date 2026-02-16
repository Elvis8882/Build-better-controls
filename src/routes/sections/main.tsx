import { lazy, Suspense } from "react";
import { Navigate, Outlet, type RouteObject } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { LineLoading } from "@/components/loading";
import SimpleLayout from "@/layouts/simple";

const Page403 = lazy(() => import("@/pages/sys/error/Page403"));
const Page404 = lazy(() => import("@/pages/sys/error/Page404"));
const Page500 = lazy(() => import("@/pages/sys/error/Page500"));

function RootRouteRedirect() {
	const { user, loading } = useAuth();

	if (loading) {
		return <LineLoading />;
	}

	if (user) {
		return <Navigate to="/dashboard/main" replace />;
	}

	return <Navigate to="/auth/login" replace />;
}

export const mainRoutes: RouteObject[] = [
	{
		path: "/",
		element: (
			<SimpleLayout>
				<Suspense fallback={<LineLoading />}>
					<Outlet />
				</Suspense>
			</SimpleLayout>
		),
		children: [
			{ index: true, element: <RootRouteRedirect /> },
			{ path: "500", element: <Page500 /> },
			{ path: "404", element: <Page404 /> },
			{ path: "403", element: <Page403 /> },
		],
	},
];
