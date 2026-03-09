import Logo from "@/components/logo";
import AccountDropdown from "@/layouts/components/account-dropdown";
import NoticeButton from "@/layouts/components/notice";
import SearchCenter from "@/layouts/components/search-center";
import { cn } from "@/utils";
import { down, useMediaQuery } from "@/hooks";
import { useSettings } from "@/store/settingStore";
import { ThemeLayout } from "#/enum";
import Header from "./header";
import Main from "./main";
import { NavHorizontalLayout, NavMobileLayout, NavVerticalLayout, useFilteredNavData } from "./nav";

export default function DashboardLayout() {
	const isMobile = useMediaQuery(down("md"));

	return (
		<div data-slot="slash-layout-root" className="w-full min-h-screen bg-background overflow-x-clip">
			{isMobile ? <MobileLayout /> : <PcLayout />}
		</div>
	);
}

function MobileLayout() {
	const navData = useFilteredNavData();
	return (
		<Main
			topSlot={
				<div
					className={cn(
						"sticky top-0 z-app-bar mb-3",
						"flex items-center justify-between",
						"rounded-xl border bg-background/80 px-2 py-1 backdrop-blur-xl",
					)}
				>
					<NavMobileLayout data={navData} />
					<div className="flex items-center gap-1">
						<SearchCenter />
						<NoticeButton />
						<AccountDropdown />
					</div>
				</div>
			}
		/>
	);
}

function PcLayout() {
	const { themeLayout } = useSettings();

	if (themeLayout === ThemeLayout.Horizontal) return <PcHorizontalLayout />;
	return <PcVerticalLayout />;
}

function PcHorizontalLayout() {
	const navData = useFilteredNavData();
	return (
		<>
			{/* Sticky Header */}
			<Header leftSlot={<Logo />} />
			{/* Sticky Nav */}
			<NavHorizontalLayout data={navData} />

			<Main />
		</>
	);
}

function PcVerticalLayout() {
	const settings = useSettings();
	const { themeLayout } = settings;
	const navData = useFilteredNavData();

	const mainPaddingLeft =
		themeLayout === ThemeLayout.Vertical ? "var(--layout-nav-width)" : "var(--layout-nav-width-mini)";

	return (
		<>
			{/* Fixed Header */}
			<NavVerticalLayout data={navData} />

			<div
				className="relative w-full min-h-screen flex flex-col transition-[padding] duration-300 ease-in-out"
				style={{
					paddingLeft: mainPaddingLeft,
				}}
			>
				<Header />
				<Main />
			</div>
		</>
	);
}
