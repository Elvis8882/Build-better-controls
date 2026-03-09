import type { ReactNode } from "react";
import { useSettings } from "@/store/settingStore";
import { cn } from "@/utils";
import AccountDropdown from "../components/account-dropdown";
import BreadCrumb from "../components/bread-crumb";
import NoticeButton from "../components/notice";
import SearchCenter from "../components/search-center";

interface HeaderProps {
	leftSlot?: ReactNode;
}

export default function Header({ leftSlot }: HeaderProps) {
	const { breadCrumb } = useSettings();
	return (
		<header
			data-slot="slash-layout-header"
			className={cn(
				"sticky top-0 left-0 right-0 z-app-bar",
				"w-full overflow-x-clip",
				"flex flex-col items-stretch gap-1 px-3 py-2 grow-0 shrink-0",
				"md:flex-row md:items-center md:justify-between md:px-2 md:py-0 md:gap-0",
				"bg-background/60 backdrop-blur-xl",
				"h-auto md:h-[var(--layout-header-height)]",
			)}
		>
			<div className="flex items-center min-w-0">
				{leftSlot}

				<div className="hidden md:block ml-4">{breadCrumb && <BreadCrumb />}</div>
			</div>

			<div className="flex items-center justify-end gap-1 w-full md:w-auto">
				<SearchCenter />
				<NoticeButton />
				<AccountDropdown />
			</div>
		</header>
	);
}
