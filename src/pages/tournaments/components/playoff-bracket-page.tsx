import { type ReactNode, useMemo } from "react";
import type { MatchParticipantDecision, MatchWithResult, Team } from "@/lib/db";
import { getTeamLogoUrl } from "@/lib/teamLogos";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

type EditableResult = {
	home_score: string;
	away_score: string;
	home_shots: string;
	away_shots: string;
	decision: MatchParticipantDecision;
};

type BracketSlot = {
	round: number;
	slot: number;
	match: MatchWithResult | null;
};

function isEmptySlotMatch(match: MatchWithResult | null): boolean {
	if (!match) return true;
	const hasHome = Boolean(match.home_participant_id);
	const hasAway = Boolean(match.away_participant_id);
	const homeName = (match.home_participant_name ?? "").trim().toUpperCase();
	const awayName = (match.away_participant_name ?? "").trim().toUpperCase();
	const hasConcreteHome = hasHome || (homeName !== "" && homeName !== "TBD" && homeName !== "BYE");
	const hasConcreteAway = hasAway || (awayName !== "" && awayName !== "TBD" && awayName !== "BYE");
	return !hasConcreteHome && !hasConcreteAway;
}

function isSkippedMatch(match: MatchWithResult): boolean {
	if (match.result?.locked) return false;
	const hasHome = Boolean(match.home_participant_id);
	const hasAway = Boolean(match.away_participant_id);
	return hasHome !== hasAway;
}

function getPlacementRevealKey(matchId: string, side: "HOME" | "AWAY"): string {
	return `${matchId}:${side}`;
}

function getBracketTeamLabel(match: MatchWithResult, side: "HOME" | "AWAY"): string {
	const participantId = side === "HOME" ? match.home_participant_id : match.away_participant_id;
	const participantName = (side === "HOME" ? match.home_participant_name : match.away_participant_name) ?? "";
	const normalized = participantName.trim().toUpperCase();
	if (participantId || (normalized !== "" && normalized !== "TBD")) {
		return participantName || "TBD";
	}
	return isSkippedMatch(match) ? "-" : "TBD";
}

function TeamName({ teamName, team }: { teamName: string; team?: Team | null }) {
	return <span className="text-sm font-medium">{team?.name ?? teamName}</span>;
}

function getWinningSide(match: MatchWithResult): "HOME" | "AWAY" | null {
	if (!match.result?.locked) return null;
	if ((match.result.home_score ?? 0) > (match.result.away_score ?? 0)) return "HOME";
	if ((match.result.away_score ?? 0) > (match.result.home_score ?? 0)) return "AWAY";
	return null;
}

function getMedalColor(medal?: "gold" | "silver" | "bronze"): string | undefined {
	if (medal === "gold") return "#D4AF37";
	if (medal === "silver") return "#BCC6CC";
	if (medal === "bronze") return "#A97142";
	return undefined;
}

function getRoundLabel(round: number, totalRounds: number): string {
	if (totalRounds === 1) return "Final";
	if (round === totalRounds) return "Final";
	if (round === totalRounds - 1) return "Semi-finals";
	if (round === totalRounds - 2) return "Quarter-finals";
	if (round === totalRounds - 3) return "Round of 16";
	return `Round ${round}`;
}

function PlacementPrefix({ standing, medal }: { standing?: number; medal?: "gold" | "silver" | "bronze" }) {
	if (!standing) return null;
	return (
		<span
			className="mr-2 inline-flex rounded px-1.5 py-0.5 text-xs font-semibold"
			style={{ color: getMedalColor(medal) }}
		>
			#{standing}
		</span>
	);
}

function buildBracketSlots(matches: MatchWithResult[], omitTbdOnlySlots = false): BracketSlot[][] {
	const grouped = new Map<number, MatchWithResult[]>();
	for (const match of matches) {
		const items = grouped.get(match.round) ?? [];
		items.push(match);
		grouped.set(match.round, items);
	}
	const maxRound = Math.max(...matches.map((match) => match.round), 1);
	const firstRoundCount = grouped.get(1)?.length ?? 1;
	const rounds: BracketSlot[][] = [];
	for (let round = 1; round <= maxRound; round += 1) {
		const expectedCount = Math.max(1, Math.ceil(firstRoundCount / 2 ** (round - 1)));
		const bySlot = new Map((grouped.get(round) ?? []).map((match) => [match.bracket_slot ?? 0, match]));
		const slots: BracketSlot[] = [];
		for (let slot = 1; slot <= expectedCount; slot += 1) {
			const slotEntry = { round, slot, match: bySlot.get(slot) ?? null };
			if (omitTbdOnlySlots && isEmptySlotMatch(slotEntry.match)) continue;
			slots.push(slotEntry);
		}
		if (omitTbdOnlySlots && slots.length === 0) continue;
		rounds.push(slots);
	}
	return rounds;
}

export function BracketDiagram({
	title,
	matches,
	bracketKind,
	teamById,
	standingByParticipantId,
	medalByParticipantId,
	placementRevealKeys,
}: {
	title: string;
	matches: MatchWithResult[];
	bracketKind: "WINNERS" | "PLACEMENT";
	teamById: Map<string, Team>;
	standingByParticipantId?: Map<string, number>;
	medalByParticipantId?: Map<string, "gold" | "silver" | "bronze">;
	placementRevealKeys?: Set<string>;
}) {
	const roundSlots = useMemo(() => buildBracketSlots(matches, bracketKind === "PLACEMENT"), [matches, bracketKind]);
	const totalRoundCount = useMemo(() => roundSlots.length || 1, [roundSlots]);
	return (
		<section className="space-y-3 rounded-lg border p-3 md:p-4">
			<h2 className="text-lg font-semibold">{title}</h2>
			<div className="overflow-x-auto">
				<div className="flex min-w-[760px] gap-4 md:min-w-[980px] md:gap-10">
					{roundSlots.map((slots, roundIndex) => {
						const currentRound = slots[0]?.round ?? roundIndex + 1;
						return (
							<div key={`round-${roundIndex + 1}`} className="min-w-[180px] space-y-3 md:min-w-[220px]">
								<h3 className="text-center text-sm font-semibold text-muted-foreground">
									{getRoundLabel(Math.min(currentRound, totalRoundCount), totalRoundCount)}
								</h3>
								{slots.map((entry, index) => {
									if (!entry.match) {
										return (
											<div
												key={`${entry.round}-${entry.slot}`}
												className="rounded-md border border-dashed bg-muted/20 p-3"
											>
												<div className="space-y-1">
													<div className="rounded px-1 text-sm text-muted-foreground">TBD</div>
													<div className="rounded px-1 text-sm text-muted-foreground">TBD</div>
												</div>
											</div>
										);
									}
									const match = entry.match;
									const homeTeam = match.home_team_id ? teamById.get(match.home_team_id) : null;
									const awayTeam = match.away_team_id ? teamById.get(match.away_team_id) : null;
									const winningSide = getWinningSide(match);
									const homeStanding = match.home_participant_id
										? standingByParticipantId?.get(match.home_participant_id)
										: undefined;
									const awayStanding = match.away_participant_id
										? standingByParticipantId?.get(match.away_participant_id)
										: undefined;
									const homeMedal = match.home_participant_id
										? medalByParticipantId?.get(match.home_participant_id)
										: undefined;
									const awayMedal = match.away_participant_id
										? medalByParticipantId?.get(match.away_participant_id)
										: undefined;

									const skipped = isSkippedMatch(match);
									const showHomePlacement = placementRevealKeys
										? placementRevealKeys.has(getPlacementRevealKey(match.id, "HOME"))
										: true;
									const showAwayPlacement = placementRevealKeys
										? placementRevealKeys.has(getPlacementRevealKey(match.id, "AWAY"))
										: true;

									return (
										<div
											key={match.id}
											className={`relative rounded-md border p-3 ${skipped ? "border-dashed border-muted-foreground/40 bg-muted/40" : "bg-card"}`}
										>
											<div className="space-y-1">
												<div
													className={`flex items-center justify-between gap-2 rounded px-1 ${winningSide === "HOME" ? "bg-green-100/80" : ""}`}
												>
													<div className="flex items-center">
														{showHomePlacement && <PlacementPrefix standing={homeStanding} medal={homeMedal} />}
														<TeamName team={homeTeam} teamName={getBracketTeamLabel(match, "HOME")} />
													</div>
													<span className="text-sm font-bold">{match.result?.home_score ?? "-"}</span>
												</div>
												<div
													className={`flex items-center justify-between gap-2 rounded px-1 ${winningSide === "AWAY" ? "bg-green-100/80" : ""}`}
												>
													<div className="flex items-center">
														{showAwayPlacement && <PlacementPrefix standing={awayStanding} medal={awayMedal} />}
														<TeamName team={awayTeam} teamName={getBracketTeamLabel(match, "AWAY")} />
													</div>
													<span className="text-sm font-bold">{match.result?.away_score ?? "-"}</span>
												</div>
											</div>
											<div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
												<span>{match.result?.decision ?? "R"}</span>
												{skipped && <Badge variant="outline">Skipped</Badge>}
												{match.result?.locked && <Badge>Locked</Badge>}
											</div>
											{roundIndex < roundSlots.length - 1 && (
												<>
													<div
														className="pointer-events-none absolute -right-4 top-1/2 h-px w-4 bg-border"
														aria-hidden="true"
													/>
													{index % 2 === 0 ? (
														<div
															className="pointer-events-none absolute -right-4 top-1/2 h-[calc(100%+0.75rem)] w-px bg-border"
															aria-hidden="true"
														/>
													) : (
														<div
															className="pointer-events-none absolute -right-4 bottom-1/2 h-[calc(100%+0.75rem)] w-px bg-border"
															aria-hidden="true"
														/>
													)}
												</>
											)}
										</div>
									);
								})}
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

export function PlayoffMatchesTable({
	title,
	matches,
	teamById,
	resultDrafts,
	saving,
	canEditMatch,
	onResultDraftChange,
	onLockResult,
	onEditResult,
	canEnableEditResult,
	standingByParticipantId,
	medalByParticipantId,
	placementRevealKeys,
}: {
	title: string;
	matches: MatchWithResult[];
	teamById: Map<string, Team>;
	resultDrafts: Record<string, EditableResult>;
	saving: boolean;
	canEditMatch: (match: MatchWithResult) => boolean;
	onResultDraftChange: (matchId: string, next: EditableResult) => void;
	onLockResult: (matchId: string) => Promise<void>;
	onEditResult?: (matchId: string) => void;
	canEnableEditResult?: (match: MatchWithResult) => boolean;
	standingByParticipantId?: Map<string, number>;
	medalByParticipantId?: Map<string, "gold" | "silver" | "bronze">;
	placementRevealKeys?: Set<string>;
}) {
	const roundDisplayByRound = useMemo(() => {
		const map = new Map<number, number>();
		let nextRound = 1;
		for (const match of matches) {
			if (map.has(match.round)) continue;
			map.set(match.round, nextRound);
			nextRound += 1;
		}
		return map;
	}, [matches]);

	const displaySlotByMatchId = useMemo(() => {
		const byRound = new Map<number, MatchWithResult[]>();
		for (const match of matches) {
			const items = byRound.get(match.round) ?? [];
			items.push(match);
			byRound.set(match.round, items);
		}
		const map = new Map<string, number>();
		for (const roundMatches of byRound.values()) {
			const ordered = [...roundMatches].sort((left, right) => (left.bracket_slot ?? 0) - (right.bracket_slot ?? 0));
			for (const [index, match] of ordered.entries()) {
				map.set(match.id, index + 1);
			}
		}
		return map;
	}, [matches]);
	if (matches.length === 0) {
		return (
			<section className="space-y-3 rounded-lg border p-3 md:p-4">
				<h2 className="text-lg font-semibold">{title}</h2>
				<p className="text-sm text-muted-foreground">No playable matches in this bracket yet.</p>
			</section>
		);
	}

	return (
		<section className="space-y-3 rounded-lg border p-3 md:p-4">
			<h2 className="text-lg font-semibold">{title}</h2>
			<div className="space-y-3">
				{matches.map((match) => {
					const draft = resultDrafts[match.id] ?? {
						home_score: "",
						away_score: "",
						home_shots: "",
						away_shots: "",
						decision: "R" as MatchParticipantDecision,
					};
					const homeTeam = match.home_team_id ? teamById.get(match.home_team_id) : null;
					const awayTeam = match.away_team_id ? teamById.get(match.away_team_id) : null;
					const winningSide = getWinningSide(match);
					const homeStanding = match.home_participant_id
						? standingByParticipantId?.get(match.home_participant_id)
						: undefined;
					const awayStanding = match.away_participant_id
						? standingByParticipantId?.get(match.away_participant_id)
						: undefined;
					const homeMedal = match.home_participant_id
						? medalByParticipantId?.get(match.home_participant_id)
						: undefined;
					const awayMedal = match.away_participant_id
						? medalByParticipantId?.get(match.away_participant_id)
						: undefined;
					const showHomePlacement = placementRevealKeys
						? placementRevealKeys.has(getPlacementRevealKey(match.id, "HOME"))
						: true;
					const showAwayPlacement = placementRevealKeys
						? placementRevealKeys.has(getPlacementRevealKey(match.id, "AWAY"))
						: true;
					const disabled = !canEditMatch(match);

					return (
						<div
							key={match.id}
							className="rounded-xl border bg-gradient-to-b from-card to-muted/10 p-3 shadow-sm md:p-4"
						>
							<div className="mb-4 flex items-center justify-between gap-3">
								<h3 className="text-xl font-bold">
									Game {roundDisplayByRound.get(match.round) ?? match.round}.{displaySlotByMatchId.get(match.id) ?? 1}
								</h3>
								{match.result?.locked && <Badge className="text-xs">Locked</Badge>}
							</div>
							<div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
								<div
									className={`rounded-lg border border-primary/20 p-3 text-left ${winningSide === "HOME" ? "bg-green-100/80" : ""}`}
								>
									<p className="text-xs font-semibold uppercase tracking-wide text-primary">Home Team</p>
									<div className="mt-1 flex items-center gap-2">
										{homeTeam && (
											<img
												src={getTeamLogoUrl(homeTeam.code, homeTeam.team_pool)}
												alt={`${homeTeam.name} logo`}
												className="h-14 w-14 object-contain"
											/>
										)}
										<p className="text-base font-semibold">
											{showHomePlacement && <PlacementPrefix standing={homeStanding} medal={homeMedal} />}
											{homeTeam?.name ?? (match.home_participant_name || "BYE")}
										</p>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.home_score ?? "-"} • SOG: {match.result?.home_shots ?? "-"}
									</p>
								</div>
								<div className="order-first flex flex-col items-center justify-center gap-2 md:order-none">
									<span className="text-2xl font-black">VS</span>
									<select
										className="h-10 rounded-md border bg-background px-3 text-sm"
										disabled={disabled}
										value={draft.decision}
										onChange={(e) =>
											onResultDraftChange(match.id, { ...draft, decision: e.target.value as MatchParticipantDecision })
										}
									>
										<option value="R">R</option>
										<option value="OT">OT</option>
										<option value="SO">SO</option>
									</select>
								</div>
								<div
									className={`rounded-lg border border-primary/20 p-3 text-right ${winningSide === "AWAY" ? "bg-green-100/80" : ""}`}
								>
									<p className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">Away Team</p>
									<div className="mt-1 flex items-center justify-end gap-2">
										<p className="text-base font-semibold">
											{showAwayPlacement && <PlacementPrefix standing={awayStanding} medal={awayMedal} />}
											{awayTeam?.name ?? (match.away_participant_name || "BYE")}
										</p>
										{awayTeam && (
											<img
												src={getTeamLogoUrl(awayTeam.code, awayTeam.team_pool)}
												alt={`${awayTeam.name} logo`}
												className="h-14 w-14 object-contain"
											/>
										)}
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.away_score ?? "-"} • SOG: {match.result?.away_shots ?? "-"}
									</p>
								</div>
							</div>
							<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">Home Goal</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_score: e.target.value })}
									/>
									<p className="text-xs font-medium text-muted-foreground">Home SOG</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_shots: e.target.value })}
									/>
								</div>
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground text-right">Away Goal</p>
									<Input
										type="number"
										min={0}
										className="text-right"
										disabled={disabled}
										value={draft.away_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_score: e.target.value })}
									/>
									<p className="text-xs font-medium text-muted-foreground text-right">Away SOG</p>
									<Input
										type="number"
										min={0}
										className="text-right"
										disabled={disabled}
										value={draft.away_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_shots: e.target.value })}
									/>
								</div>
							</div>
							<div className="mt-3 flex gap-2">
								<Button
									disabled={saving || disabled || Boolean(match.result?.locked)}
									onClick={() => void onLockResult(match.id)}
								>
									Lock in
								</Button>
								{onEditResult && Boolean(match.result?.locked) && (canEnableEditResult?.(match) ?? true) && (
									<Button size="sm" variant="outline" onClick={() => onEditResult(match.id)}>
										Edit
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

export function PlayoffBracketPage({
	banner,
	diagram,
	table,
	placementDiagram,
	placementTable,
}: {
	banner?: string;
	diagram: ReactNode;
	table: ReactNode;
	placementDiagram?: ReactNode;
	placementTable?: ReactNode;
}) {
	return (
		<div className="space-y-4">
			{banner && <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{banner}</div>}
			{diagram}
			{table}
			{placementDiagram}
			{placementTable}
		</div>
	);
}
