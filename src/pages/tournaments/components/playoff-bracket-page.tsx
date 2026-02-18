import { type ReactNode, useMemo } from "react";
import type { MatchParticipantDecision, MatchWithResult, Team } from "@/lib/db";
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

function TeamName({ teamName, team }: { teamName: string; team?: Team | null }) {
	return <span className="text-sm font-medium">{team?.name ?? teamName}</span>;
}

export function BracketDiagram({
	title,
	matches,
	teamById,
}: {
	title: string;
	matches: MatchWithResult[];
	teamById: Map<string, Team>;
}) {
	const rounds = useMemo(() => {
		const grouped = new Map<number, MatchWithResult[]>();
		for (const match of matches) {
			const items = grouped.get(match.round) ?? [];
			items.push(match);
			grouped.set(match.round, items);
		}
		return [...grouped.entries()].sort(([a], [b]) => a - b);
	}, [matches]);

	const matchById = useMemo(() => new Map(matches.map((match) => [match.id, match])), [matches]);

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="text-lg font-semibold">{title}</h2>
			<div className="overflow-x-auto">
				<div className="flex min-w-[980px] gap-6">
					{rounds.map(([round, roundMatches]) => (
						<div key={round} className="min-w-[220px] space-y-3">
							<h3 className="text-sm font-semibold text-muted-foreground">
								{round === rounds.length ? "Final" : `Round ${round}`}
							</h3>
							{roundMatches
								.sort((a, b) => (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0))
								.map((match) => {
									const homeTeam = match.home_team_id ? teamById.get(match.home_team_id) : null;
									const awayTeam = match.away_team_id ? teamById.get(match.away_team_id) : null;
									const nextMatch = match.next_match_id ? matchById.get(match.next_match_id) : null;
									return (
										<div key={match.id} className="relative rounded-md border bg-card p-3">
											<div className="space-y-1">
												<div className="flex items-center justify-between gap-2">
													<TeamName team={homeTeam} teamName={match.home_participant_name || "BYE"} />
													<span className="text-sm font-bold">{match.result?.home_score ?? "-"}</span>
												</div>
												<div className="flex items-center justify-between gap-2">
													<TeamName team={awayTeam} teamName={match.away_participant_name || "BYE"} />
													<span className="text-sm font-bold">{match.result?.away_score ?? "-"}</span>
												</div>
											</div>
											<div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
												<span>{match.result?.decision ?? "R"}</span>
												{match.result?.locked && <Badge>Locked</Badge>}
											</div>
											{nextMatch && (
												<div
													className="pointer-events-none absolute -right-5 top-1/2 h-px w-5 bg-border"
													aria-hidden="true"
												/>
											)}
										</div>
									);
								})}
						</div>
					))}
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
}) {
	return (
		<section className="space-y-3 rounded-lg border p-4">
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
					const disabled = !canEditMatch(match);

					return (
						<div key={match.id} className="rounded-xl border bg-gradient-to-b from-card to-muted/10 p-4 shadow-sm">
							<div className="mb-4 flex items-center justify-between gap-3">
								<h3 className="text-xl font-bold">
									Game {match.round}
									{match.bracket_slot ? `.${match.bracket_slot}` : ""}
								</h3>
								{match.result?.locked && <Badge className="text-xs">Locked</Badge>}
							</div>
							<div className="grid grid-cols-[1fr_auto_1fr] items-start gap-4">
								<div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-left">
									<p className="text-xs font-semibold uppercase tracking-wide text-primary">Home Team</p>
									<p className="mt-1 text-base font-semibold">
										{homeTeam?.name ?? (match.home_participant_name || "BYE")}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.home_score ?? "-"} • SOG: {match.result?.home_shots ?? "-"}
									</p>
								</div>
								<div className="flex flex-col items-center justify-center gap-2">
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
								<div className="rounded-lg border border-secondary/40 bg-secondary/10 p-3 text-right">
									<p className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">Away Team</p>
									<p className="mt-1 text-base font-semibold">
										{awayTeam?.name ?? (match.away_participant_name || "BYE")}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Score: {match.result?.away_score ?? "-"} • SOG: {match.result?.away_shots ?? "-"}
									</p>
								</div>
							</div>
							<div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Home Score</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_score: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Away Score</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.away_score}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, away_score: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Home SOG</p>
									<Input
										type="number"
										min={0}
										disabled={disabled}
										value={draft.home_shots}
										placeholder="0"
										onChange={(e) => onResultDraftChange(match.id, { ...draft, home_shots: e.target.value })}
									/>
								</div>
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Away SOG</p>
									<Input
										type="number"
										min={0}
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
								{onEditResult && Boolean(match.result?.locked) && (
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
