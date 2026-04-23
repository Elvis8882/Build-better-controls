import { sanitizeGroupCount } from "@/lib/db";
import {
	hasLosersProgressionPreset,
	isGoalDifferenceDuelPreset,
	isGroupThenPlayoffPreset,
	isPlayoffOnlyPreset,
	isRoundRobinTiersPreset,
	isTwoVTwoPreset,
	type TournamentPreset,
} from "@/lib/tournament-preset-contract";

type TournamentPresetFlowInput = TournamentPreset | null | undefined;

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
	maxEntrantsPerGroup: 7,
};

export const isPlayoffOnlyFlow = (preset: TournamentPresetFlowInput): boolean => isPlayoffOnlyPreset(preset);

export const isGroupThenPlayoffFlow = (preset: TournamentPresetFlowInput): boolean => isGroupThenPlayoffPreset(preset);

export const hasLosersProgressionFlow = (preset: TournamentPresetFlowInput): boolean =>
	hasLosersProgressionPreset(preset);

export const isTwoVTwoFlow = (preset: TournamentPresetFlowInput): boolean => isTwoVTwoPreset(preset);

export const getGroupingSemanticsByPreset = (preset: TournamentPresetFlowInput): GroupingSemantics => {
	if (!isGroupThenPlayoffFlow(preset)) {
		return {
			isGroupStagePreset: false,
			usesTeamEntrants: isTwoVTwoFlow(preset),
			entrantCountDivisor: isTwoVTwoFlow(preset) ? 2 : 1,
			autoExpand: true,
			maxEntrantsPerGroup: 7,
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
		maxEntrantsPerGroup: 7,
	};
};

export const resolvePresetGroupCount = (
	preset: TournamentPresetFlowInput,
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

export const isRoundRobinTiersFlow = (preset: TournamentPresetFlowInput): boolean => isRoundRobinTiersPreset(preset);

export const isGoalDifferenceDuelFlow = (preset: TournamentPresetFlowInput): boolean =>
	isGoalDifferenceDuelPreset(preset);
