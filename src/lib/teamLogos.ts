import type { SyntheticEvent } from "react";

import type { TeamPool } from "@/lib/db";

const COUNTRY_FLAG_CODE_BY_TEAM_CODE: Record<string, string> = {
	AUT: "at",
	CAN: "ca",
	CZE: "cz",
	DEN: "dk",
	FIN: "fi",
	FRA: "fr",
	GBR: "gb",
	GER: "de",
	ITA: "it",
	LAT: "lv",
	NOR: "no",
	POL: "pl",
	SVK: "sk",
	SUI: "ch",
	SWE: "se",
	USA: "us",
};

export const TEAM_LOGO_FALLBACK_URL = "/flags/default.svg";

export function getTeamLogoUrl(teamCode: string, teamPool: TeamPool): string {
	if (teamPool === "NHL") {
		return `https://assets.nhle.com/logos/nhl/svg/${teamCode}_light.svg`;
	}

	const flagCode = COUNTRY_FLAG_CODE_BY_TEAM_CODE[teamCode] ?? "us";
	return `https://flagcdn.com/w80/${flagCode}.png`;
}

export function handleTeamLogoImageError(event: SyntheticEvent<HTMLImageElement>) {
	const img = event.currentTarget;
	if (img.src.endsWith(TEAM_LOGO_FALLBACK_URL)) {
		return;
	}
	img.src = TEAM_LOGO_FALLBACK_URL;
}
