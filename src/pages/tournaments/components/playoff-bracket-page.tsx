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

function TeamBadge({ teamName, team }: { teamName: string; team?: Team | null }) {
	if (!team) return <span className="text-sm font-medium">{teamName}</span>;
	return (
		<span
			className="inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold"
			style={{
				backgroundColor: team.primary_color,
				color: team.text_color,
				border: `1px solid ${team.secondary_color || team.primary_color}`,
			}}
		>
			{team.short_name}
		</span>
	);
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
													<TeamBadge team={homeTeam} teamName={match.home_participant_name || "BYE"} />
													<span className="text-sm font-bold">{match.result?.home_score ?? "-"}</span>
												</div>
												<div className="flex items-center justify-between gap-2">
													<TeamBadge team={awayTeam} teamName={match.away_participant_name || "BYE"} />
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
}: {
	title: string;
	matches: MatchWithResult[];
	teamById: Map<string, Team>;
	resultDrafts: Record<string, EditableResult>;
	saving: boolean;
	canEditMatch: (match: MatchWithResult) => boolean;
	onResultDraftChange: (matchId: string, next: EditableResult) => void;
	onLockResult: (matchId: string) => Promise<void>;
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
						<div key={match.id} className="rounded border p-3">
							<div className="mb-2 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<TeamBadge team={homeTeam} teamName={match.home_participant_name || "BYE"} />
									<span>vs</span>
									<TeamBadge team={awayTeam} teamName={match.away_participant_name || "BYE"} />
								</div>
								{match.result?.locked && <Badge>Locked</Badge>}
							</div>
							<div className="grid gap-2 md:grid-cols-5">
								<Input
									type="number"
									min={0}
									disabled={disabled}
									value={draft.home_score}
									onChange={(e) => onResultDraftChange(match.id, { ...draft, home_score: e.target.value })}
								/>
								<Input
									type="number"
									min={0}
									disabled={disabled}
									value={draft.away_score}
									onChange={(e) => onResultDraftChange(match.id, { ...draft, away_score: e.target.value })}
								/>
								<Input
									type="number"
									min={0}
									disabled={disabled}
									value={draft.home_shots}
									onChange={(e) => onResultDraftChange(match.id, { ...draft, home_shots: e.target.value })}
								/>
								<Input
									type="number"
									min={0}
									disabled={disabled}
									value={draft.away_shots}
									onChange={(e) => onResultDraftChange(match.id, { ...draft, away_shots: e.target.value })}
								/>
								<select
									className="h-10 rounded-md border bg-transparent px-3"
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
							<div className="mt-2">
								<Button
									disabled={saving || disabled || Boolean(match.result?.locked)}
									onClick={() => void onLockResult(match.id)}
								>
									Lock in
								</Button>
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
