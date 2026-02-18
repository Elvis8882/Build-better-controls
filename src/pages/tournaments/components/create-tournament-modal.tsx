import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createTournament, sanitizeGroupCount, type TeamPool, type TournamentPresetUi } from "@/lib/db";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";

const PRESET_OPTIONS: Array<{ label: string; value: TournamentPresetUi }> = [
	{ label: "Playoffs only", value: "playoffs_only" },
	{ label: "Full tournament (with losers bracket)", value: "full_with_losers" },
	{ label: "Full tournament (no losers bracket)", value: "full_no_losers" },
];

const isFullPreset = (presetId: TournamentPresetUi) => presetId.startsWith("full_");

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (tournamentId: string) => void;
};

export function CreateTournamentModal({ open, onOpenChange, onCreated }: Props) {
	const [saving, setSaving] = useState(false);
	const [name, setName] = useState("");
	const [presetId, setPresetId] = useState<TournamentPresetUi>("full_with_losers");
	const [teamPool, setTeamPool] = useState<TeamPool>("NHL");
	const [defaultParticipants, setDefaultParticipants] = useState(4);
	const [groupCountInput, setGroupCountInput] = useState(2);

	const groupResolution = useMemo(() => {
		if (!isFullPreset(presetId)) {
			return { groupCount: null, note: null, error: null };
		}
		return sanitizeGroupCount(defaultParticipants, groupCountInput);
	}, [presetId, defaultParticipants, groupCountInput]);

	const onCreate = async () => {
		if (!name.trim()) {
			toast.warning("Tournament name is required.");
			return;
		}
		if (defaultParticipants < 3 || defaultParticipants > 24) {
			toast.warning("Participants must be between 3 and 24.");
			return;
		}
		if (isFullPreset(presetId) && groupResolution.error) {
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
				groupCount: isFullPreset(presetId) ? groupResolution.groupCount : null,
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
							min={3}
							max={24}
							value={defaultParticipants}
							onChange={(event) => setDefaultParticipants(Number(event.target.value))}
						/>
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
					{isFullPreset(presetId) && (
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
