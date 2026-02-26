/**
 * Source-of-truth tournament preset contract.
 * Keep in sync with docs/tournament-preset-contract.md and supabase/routines/normalize_tournament_preset.sql.
 */
export const TOURNAMENT_PRESET_VALUES = [
	"playoffs_only",
	"full_with_losers",
	"full_no_losers",
	"2v2_tournament",
	"2v2_playoffs",
	"round_robin_tiers",
] as const;

export type TournamentPreset = (typeof TOURNAMENT_PRESET_VALUES)[number];

const TOURNAMENT_PRESET_SET = new Set<string>(TOURNAMENT_PRESET_VALUES);

export const isPlayoffOnlyPreset = (preset: TournamentPreset | null | undefined): boolean =>
	preset === "playoffs_only" || preset === "2v2_playoffs";

export const isGroupThenPlayoffPreset = (preset: TournamentPreset | null | undefined): boolean =>
	preset === "full_no_losers" || preset === "2v2_tournament" || preset === "full_with_losers";

export const hasLosersProgressionPreset = (preset: TournamentPreset | null | undefined): boolean =>
	preset === "full_with_losers";

export const isTwoVTwoPreset = (preset: TournamentPreset | null | undefined): boolean =>
	preset === "2v2_tournament" || preset === "2v2_playoffs";

export function normalizeTournamentPreset(preset: string | null, context: string): TournamentPreset | null {
	if (!preset) return null;
	if (preset === "full_tournament") {
		throw new Error(
			`Legacy preset \"full_tournament\" is no longer accepted (${context}). Run preset migration and fix upstream writer.`,
		);
	}
	if (TOURNAMENT_PRESET_SET.has(preset)) {
		return preset as TournamentPreset;
	}
	throw new Error(`Unknown tournament preset \"${preset}\" encountered (${context}).`);
}

export const isRoundRobinTiersPreset = (preset: TournamentPreset | null | undefined): boolean =>
	preset === "round_robin_tiers";
