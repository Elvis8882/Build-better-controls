import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	createMatch,
	getTournament,
	inviteMember,
	listMatchesWithResults,
	listTournamentMembers,
	lockMatchResult,
	searchProfilesByUsername,
	type MatchWithResult,
	type ProfileOption,
	type Tournament,
	type TournamentMember,
	upsertMatchResult,
} from "@/lib/db";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

type EditableResult = {
	home_score: string;
	away_score: string;
	home_shots: string;
	away_shots: string;
};

const defaultResult: EditableResult = {
	home_score: "0",
	away_score: "0",
	home_shots: "0",
	away_shots: "0",
};

export default function TournamentDetailPage() {
	const { id } = useParams();
	const { user, profile } = useAuth();
	const [loading, setLoading] = useState(true);
	const [tournament, setTournament] = useState<Tournament | null>(null);
	const [members, setMembers] = useState<TournamentMember[]>([]);
	const [matches, setMatches] = useState<MatchWithResult[]>([]);
	const [inviteQuery, setInviteQuery] = useState("");
	const [inviteOptions, setInviteOptions] = useState<ProfileOption[]>([]);
	const [selectedInviteUserId, setSelectedInviteUserId] = useState("");
	const [saving, setSaving] = useState(false);
	const [round, setRound] = useState("1");
	const [homeUserId, setHomeUserId] = useState("");
	const [awayUserId, setAwayUserId] = useState("");
	const [resultDrafts, setResultDrafts] = useState<Record<string, EditableResult>>({});

	const isAdmin = profile?.role === "admin";
	const hostMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && member.role === "host"),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(hostMembership);

	const loadAll = useCallback(async () => {
		if (!id) return;
		try {
			setLoading(true);
			const [tournamentData, memberData, matchData] = await Promise.all([
				getTournament(id),
				listTournamentMembers(id),
				listMatchesWithResults(id),
			]);
			setTournament(tournamentData);
			setMembers(memberData);
			setMatches(matchData);
			if (memberData.length > 1) {
				setHomeUserId(memberData[0].user_id);
				setAwayUserId(memberData[1].user_id);
			}

			const drafts: Record<string, EditableResult> = {};
			for (const match of matchData) {
				drafts[match.id] = {
					home_score: String(match.result?.home_score ?? 0),
					away_score: String(match.result?.away_score ?? 0),
					home_shots: String(match.result?.home_shots ?? 0),
					away_shots: String(match.result?.away_shots ?? 0),
				};
			}
			setResultDrafts(drafts);
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	const runSearchProfiles = async () => {
		try {
			const data = await searchProfilesByUsername(inviteQuery);
			setInviteOptions(data);
		} catch (error) {
			toast.error((error as Error).message);
		}
	};

	const onInvite = async () => {
		if (!id || !selectedInviteUserId) return;
		try {
			setSaving(true);
			await inviteMember(id, selectedInviteUserId);
			toast.success("Member invited.");
			setInviteQuery("");
			setInviteOptions([]);
			setSelectedInviteUserId("");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onCreateMatch = async () => {
		if (!id) return;
		if (!homeUserId || !awayUserId || homeUserId === awayUserId) {
			toast.warning("Choose two different players for this match.");
			return;
		}
		try {
			setSaving(true);
			await createMatch(id, homeUserId, awayUserId, Number(round));
			toast.success("Match added.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const canSaveResult = (match: MatchWithResult) => {
		if (isHostOrAdmin) return true;
		const isParticipant = user?.id === match.home_user_id || user?.id === match.away_user_id;
		return isParticipant && !match.result?.locked;
	};

	const canLockResult = (match: MatchWithResult) => {
		const isParticipant = user?.id === match.home_user_id || user?.id === match.away_user_id;
		if (!(isHostOrAdmin || isParticipant)) return false;
		return Boolean(match.result && !match.result.locked);
	};

	const isLockedForCurrentUser = (match: MatchWithResult) => {
		if (isHostOrAdmin) return false;
		return Boolean(match.result?.locked);
	};

	const onSaveResult = async (matchId: string) => {
		const draft = resultDrafts[matchId] ?? defaultResult;
		try {
			setSaving(true);
			await upsertMatchResult(
				matchId,
				Number(draft.home_score),
				Number(draft.away_score),
				Number(draft.home_shots),
				Number(draft.away_shots),
			);
			toast.success("Result saved.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onLockResult = async (matchId: string) => {
		try {
			setSaving(true);
			await lockMatchResult(matchId);
			toast.success("Result locked.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading tournament...</div>;
	}

	if (!tournament) {
		return <div className="p-6 text-sm text-muted-foreground">Tournament not found.</div>;
	}

	return (
		<div className="space-y-6 p-4 md:p-6">
			<div>
				<h1 className="text-2xl font-semibold">{tournament.name}</h1>
				<p className="text-sm text-muted-foreground">
					Status: {tournament.status ?? "active"} • Created {new Date(tournament.created_at).toLocaleString()}
				</p>
			</div>

			<section className="space-y-3 rounded-lg border p-4">
				<h2 className="text-lg font-semibold">Members</h2>
				<ul className="space-y-2">
					{members.map((member) => (
						<li key={member.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm">
							<span>{member.username}</span>
							<Badge variant="outline">{member.role}</Badge>
						</li>
					))}
				</ul>

				{isHostOrAdmin && (
					<div className="space-y-2 rounded-md border p-3">
						<h3 className="font-medium">Invite member</h3>
						<div className="flex flex-col gap-2 md:flex-row">
							<Input
								value={inviteQuery}
								onChange={(event) => setInviteQuery(event.target.value)}
								placeholder="Search username"
							/>
							<Button variant="outline" onClick={runSearchProfiles}>
								Search
							</Button>
						</div>
						<select
							className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
							value={selectedInviteUserId}
							onChange={(event) => setSelectedInviteUserId(event.target.value)}
						>
							<option value="">Select user</option>
							{inviteOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.username} ({option.role ?? "player"})
								</option>
							))}
						</select>
						<Button onClick={onInvite} disabled={!selectedInviteUserId || saving}>
							Invite
						</Button>
					</div>
				)}
			</section>

			<section className="space-y-3 rounded-lg border p-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">Matches</h2>
				</div>

				{isHostOrAdmin && (
					<div className="grid gap-2 rounded-md border p-3 md:grid-cols-4">
						<select
							className="h-10 rounded-md border bg-transparent px-3 text-sm"
							value={homeUserId}
							onChange={(event) => setHomeUserId(event.target.value)}
						>
							<option value="">Home player</option>
							{members.map((member) => (
								<option key={member.user_id} value={member.user_id}>
									{member.username}
								</option>
							))}
						</select>
						<select
							className="h-10 rounded-md border bg-transparent px-3 text-sm"
							value={awayUserId}
							onChange={(event) => setAwayUserId(event.target.value)}
						>
							<option value="">Away player</option>
							{members.map((member) => (
								<option key={member.user_id} value={member.user_id}>
									{member.username}
								</option>
							))}
						</select>
						<Input type="number" value={round} onChange={(event) => setRound(event.target.value)} min={1} />
						<Button onClick={onCreateMatch} disabled={saving}>
							Add match
						</Button>
					</div>
				)}

				<div className="space-y-3">
					{matches.length === 0 ? (
						<p className="text-sm text-muted-foreground">No matches yet.</p>
					) : (
						matches.map((match) => {
							const homeName = members.find((member) => member.user_id === match.home_user_id)?.username ?? "Unknown";
							const awayName = members.find((member) => member.user_id === match.away_user_id)?.username ?? "Unknown";
							const draft = resultDrafts[match.id] ?? defaultResult;
							const disableInputs = isLockedForCurrentUser(match);
							return (
								<div key={match.id} className="space-y-2 rounded-md border p-3">
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span className="font-medium">
											Round {match.round}: {homeName} vs {awayName}
										</span>
										{match.result?.locked && <Badge>Locked</Badge>}
									</div>
									<div className="grid gap-2 md:grid-cols-4">
										<Input
											type="number"
											placeholder="Home score"
											disabled={disableInputs}
											value={draft.home_score}
											onChange={(event) =>
												setResultDrafts((previous) => ({
													...previous,
													[match.id]: { ...draft, home_score: event.target.value },
												}))
											}
										/>
										<Input
											type="number"
											placeholder="Away score"
											disabled={disableInputs}
											value={draft.away_score}
											onChange={(event) =>
												setResultDrafts((previous) => ({
													...previous,
													[match.id]: { ...draft, away_score: event.target.value },
												}))
											}
										/>
										<Input
											type="number"
											placeholder="Home shots"
											disabled={disableInputs}
											value={draft.home_shots}
											onChange={(event) =>
												setResultDrafts((previous) => ({
													...previous,
													[match.id]: { ...draft, home_shots: event.target.value },
												}))
											}
										/>
										<Input
											type="number"
											placeholder="Away shots"
											disabled={disableInputs}
											value={draft.away_shots}
											onChange={(event) =>
												setResultDrafts((previous) => ({
													...previous,
													[match.id]: { ...draft, away_shots: event.target.value },
												}))
											}
										/>
									</div>
									<div className="flex gap-2">
										<Button
											variant="outline"
											disabled={!canSaveResult(match) || saving}
											onClick={() => onSaveResult(match.id)}
										>
											Save
										</Button>
										<Button disabled={!canLockResult(match) || saving} onClick={() => onLockResult(match.id)}>
											Lock in
										</Button>
									</div>
								</div>
							);
						})
					)}
				</div>
			</section>
		</div>
	);
}
