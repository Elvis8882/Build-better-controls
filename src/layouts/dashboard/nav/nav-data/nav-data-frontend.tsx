import { Icon } from "@/components/icon";
import type { NavProps } from "@/components/nav";

export const frontendNavData: NavProps["data"] = [
	{
		name: "Fantasy",
		items: [
			{
				title: "Main",
				path: "/dashboard/main",
				icon: <Icon icon="local:ic-main" size="24" />,
			},
			{
				title: "Tournaments",
				path: "/dashboard/tournaments",
				icon: <Icon icon="local:ic-workbench" size="24" />,
			},
			{
				title: "Statistics",
				path: "/dashboard/profile",
				icon: <Icon icon="local:ic-analysis" size="24" />,
			},
		],
	},
];
