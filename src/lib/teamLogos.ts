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

export function getTeamLogoUrl(teamCode: string, teamPool: TeamPool): string {
	if (teamPool === "NHL") {
		return `https://assets.nhle.com/logos/nhl/svg/${teamCode}_light.svg`;
	}

	const flagCode = COUNTRY_FLAG_CODE_BY_TEAM_CODE[teamCode] ?? "un";
	return `https://flagcdn.com/w80/${flagCode}.png`;
}
