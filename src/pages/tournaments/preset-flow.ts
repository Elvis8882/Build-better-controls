import type { Tournament, TournamentPresetUi } from "@/lib/db";

type TournamentPreset = Tournament["preset_id"] | TournamentPresetUi | null | undefined;

export const isPlayoffOnlyFlow = (preset: TournamentPreset): boolean =>
	preset === "playoffs_only" || preset === "2v2_playoffs";

export const isGroupThenPlayoffFlow = (preset: TournamentPreset): boolean =>
	preset === "full_no_losers" || preset === "2v2_tournament" || preset === "full_with_losers";

export const hasLosersProgressionFlow = (preset: TournamentPreset): boolean => preset === "full_with_losers";

export const isTwoVTwoFlow = (preset: TournamentPreset): boolean =>
	preset === "2v2_tournament" || preset === "2v2_playoffs";
