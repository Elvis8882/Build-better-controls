import { sanitizeGroupCount, type Tournament, type TournamentPresetUi } from "@/lib/db";

type TournamentPreset = Tournament["preset_id"] | TournamentPresetUi | null | undefined;

type GroupingSemantics = {
	isGroupStagePreset: boolean;
	usesTeamEntrants: boolean;
	entrantCountDivisor: number;
	autoExpand: boolean;
	maxEntrantsPerGroup: number;
};

const TWO_V_TWO_TOURNAMENT_GROUPING: GroupingSemantics = {
	isGroupStagePreset: true,
	usesTeamEntrants: true,
	entrantCountDivisor: 2,
	autoExpand: true,
	maxEntrantsPerGroup: 6,
};

export const isPlayoffOnlyFlow = (preset: TournamentPreset): boolean =>
	preset === "playoffs_only" || preset === "2v2_playoffs";

export const isGroupThenPlayoffFlow = (preset: TournamentPreset): boolean =>
	preset === "full_no_losers" || preset === "2v2_tournament" || preset === "full_with_losers";

export const hasLosersProgressionFlow = (preset: TournamentPreset): boolean => preset === "full_with_losers";

export const isTwoVTwoFlow = (preset: TournamentPreset): boolean =>
	preset === "2v2_tournament" || preset === "2v2_playoffs";

export const getGroupingSemanticsByPreset = (preset: TournamentPreset): GroupingSemantics => {
	if (!isGroupThenPlayoffFlow(preset)) {
		return {
			isGroupStagePreset: false,
			usesTeamEntrants: isTwoVTwoFlow(preset),
			entrantCountDivisor: isTwoVTwoFlow(preset) ? 2 : 1,
			autoExpand: true,
			maxEntrantsPerGroup: 6,
		};
	}

	if (preset === "2v2_tournament") {
		return TWO_V_TWO_TOURNAMENT_GROUPING;
	}

	return {
		isGroupStagePreset: true,
		usesTeamEntrants: false,
		entrantCountDivisor: 1,
		autoExpand: true,
		maxEntrantsPerGroup: 6,
	};
};

export const resolvePresetGroupCount = (
	preset: TournamentPreset,
	defaultParticipants: number,
	selectedGroupCount: number,
): { groupCount: number | null; note: string | null; error: string | null } => {
	const semantics = getGroupingSemanticsByPreset(preset);
	if (!semantics.isGroupStagePreset) {
		return { groupCount: null, note: null, error: null };
	}

	const entrantCount = Math.floor(defaultParticipants / semantics.entrantCountDivisor);
	const resolution = sanitizeGroupCount(entrantCount, selectedGroupCount, {
		autoExpand: semantics.autoExpand,
		maxParticipantsPerGroup: semantics.maxEntrantsPerGroup,
	});

	return {
		groupCount: resolution.groupCount,
		note: resolution.note,
		error: resolution.error,
	};
};
