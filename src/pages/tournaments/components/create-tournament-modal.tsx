import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createTournament, type TeamPool, type TournamentPresetUi } from "@/lib/db";
import { isGroupThenPlayoffFlow, resolvePresetGroupCount } from "@/pages/tournaments/preset-flow";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";

const PRESET_OPTIONS: Array<{ label: string; value: TournamentPresetUi }> = [
	{ label: "Playoffs only", value: "playoffs_only" },
	{ label: "2v2 Playoffs", value: "2v2_playoffs" },
	{ label: "Full tournament (with losers bracket)", value: "full_with_losers" },
	{ label: "Full tournament (no losers bracket)", value: "full_no_losers" },
	{ label: "2v2 Tournament", value: "2v2_tournament" },
	{ label: "Round-Robin Tiers", value: "round_robin_tiers" },
	{ label: "Goal Difference Duel (1v1)", value: "goal_difference_duel" },
];

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (tournamentId: string) => void;
};

export function CreateTournamentModal({ open, onOpenChange, onCreated }: Props) {
	const [saving, setSaving] = useState(false);
	const [name, setName] = useState("");
	const [presetId, setPresetId] = useState<TournamentPresetUi>("full_with_losers");
	const isTwoVTwoPreset = presetId === "2v2_playoffs" || presetId === "2v2_tournament";
	const isRoundRobinTiersPreset = presetId === "round_robin_tiers";
	const isGoalDifferenceDuelPreset = presetId === "goal_difference_duel";
	const [teamPool, setTeamPool] = useState<TeamPool>("NHL");
	const [defaultParticipants, setDefaultParticipants] = useState(4);
	const [groupCountInput, setGroupCountInput] = useState(1);
	const [roundRobinMode, setRoundRobinMode] = useState<"single" | "double">("single");
	const [goalDifferenceTarget, setGoalDifferenceTarget] = useState(5);

	useEffect(() => {
		if (presetId === "goal_difference_duel") {
			setDefaultParticipants(2);
			return;
		}

		if (presetId === "2v2_playoffs" || presetId === "2v2_tournament") {
			setDefaultParticipants(6);
			return;
		}

		setDefaultParticipants(4);
	}, [presetId]);

	const twoVTwoMinParticipantsError =
		isTwoVTwoPreset && defaultParticipants < 6 ? "Participants must be at least 6" : null;

	const groupResolution = useMemo(
		() => resolvePresetGroupCount(presetId, defaultParticipants, groupCountInput),
		[presetId, defaultParticipants, groupCountInput],
	);

	const onCreate = async () => {
		if (!name.trim()) {
			toast.warning("Tournament name is required.");
			return;
		}
		if (isTwoVTwoPreset && (defaultParticipants < 6 || defaultParticipants > 16)) {
			toast.warning("2v2 tournaments require between 6 and 16 default participants (minimum 3 teams).");
			return;
		}
		if (isGoalDifferenceDuelPreset && defaultParticipants !== 2) {
			toast.warning("Goal difference duel requires exactly 2 participants.");
			return;
		}
		if (isRoundRobinTiersPreset && (defaultParticipants < 4 || defaultParticipants > 8)) {
			toast.warning("Round-robin tiers mode requires between 4 and 8 participants.");
			return;
		}
		if (
			!isTwoVTwoPreset &&
			!isRoundRobinTiersPreset &&
			!isGoalDifferenceDuelPreset &&
			(defaultParticipants < 3 || defaultParticipants > 16)
		) {
			toast.warning("Participants must be between 3 and 16.");
			return;
		}
		if (isTwoVTwoPreset && defaultParticipants % 2 !== 0) {
			toast.warning("2v2 tournaments require an even default participant count.");
			return;
		}
		if (isGroupThenPlayoffFlow(presetId) && groupResolution.error) {
			toast.error(groupResolution.error);
			return;
		}
		try {
			setSaving(true);
			const createdTournament = await createTournament({
				name: name.trim(),
				presetId,
				teamPool,
				defaultParticipants,
				groupCount: isGroupThenPlayoffFlow(presetId)
					? groupResolution.groupCount
					: isRoundRobinTiersPreset
						? roundRobinMode === "double"
							? 2
							: 1
						: isGoalDifferenceDuelPreset
							? goalDifferenceTarget
							: null,
			});
			toast.success("Tournament created.");
			onOpenChange(false);
			setName("");
			onCreated(createdTournament.id);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create tournament</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 py-2">
					<div className="space-y-1">
						<p className="text-sm">Tournament name</p>
						<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="NHL Playoffs" />
					</div>
					<div className="space-y-1">
						<p className="text-sm">Preset</p>
						<select
							className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
							value={presetId}
							onChange={(event) => setPresetId(event.target.value as TournamentPresetUi)}
						>
							{PRESET_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-1">
						<p className="text-sm">Default participants</p>
						<Input
							type="number"
							min={isGoalDifferenceDuelPreset ? 2 : isTwoVTwoPreset ? 6 : isRoundRobinTiersPreset ? 4 : 3}
							max={isGoalDifferenceDuelPreset ? 2 : isRoundRobinTiersPreset ? 8 : 16}
							value={defaultParticipants}
							onChange={(event) => setDefaultParticipants(Number(event.target.value))}
							disabled={isGoalDifferenceDuelPreset}
						/>
						{twoVTwoMinParticipantsError && <p className="text-xs text-red-600">{twoVTwoMinParticipantsError}</p>}
					</div>
					<div className="space-y-1">
						<p className="text-sm">Team pool</p>
						<select
							className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
							value={teamPool}
							onChange={(event) => setTeamPool(event.target.value as TeamPool)}
						>
							<option value="NHL">NHL</option>
							<option value="INTL">International</option>
						</select>
					</div>

					{isGoalDifferenceDuelPreset && (
						<div className="space-y-1">
							<p className="text-sm">Goal difference target</p>
							<select
								className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
								value={goalDifferenceTarget}
								onChange={(event) => setGoalDifferenceTarget(Number(event.target.value))}
							>
								{[5, 10, 15, 20].map((target) => (
									<option key={target} value={target}>
										{target}
									</option>
								))}
							</select>
						</div>
					)}

					{isRoundRobinTiersPreset && (
						<div className="space-y-1">
							<p className="text-sm">Round robin mode</p>
							<select
								className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
								value={roundRobinMode}
								onChange={(event) => setRoundRobinMode(event.target.value as "single" | "double")}
							>
								<option value="single">Single</option>
								<option value="double">Double</option>
							</select>
						</div>
					)}
					{isGroupThenPlayoffFlow(presetId) && (
						<div className="space-y-1">
							<p className="text-sm">Group count</p>
							<select
								className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
								value={groupCountInput}
								onChange={(event) => setGroupCountInput(Number(event.target.value))}
							>
								{[1, 2, 3, 4].map((count) => (
									<option key={count} value={count}>
										{count}
									</option>
								))}
							</select>
							{groupResolution.note && <p className="text-xs text-amber-600">{groupResolution.note}</p>}
							{groupResolution.error && <p className="text-xs text-red-600">{groupResolution.error}</p>}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
						Cancel
					</Button>
					<Button onClick={() => void onCreate()} disabled={saving || Boolean(groupResolution.error)}>
						{saving ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
