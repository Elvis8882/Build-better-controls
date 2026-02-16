import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import {
	addTournamentGuest,
	createMatch,
	getTournament,
	inviteMember,
	listMatchesWithResults,
	listTournamentGuests,
	listTournamentMembers,
	lockMatchResult,
	removeTournamentGuest,
	searchProfilesByUsername,
	type MatchParticipantDecision,
	type MatchWithResult,
	type ProfileOption,
	type Tournament,
	type TournamentGuest,
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
	decision: MatchParticipantDecision;
};

const defaultResult: EditableResult = {
	home_score: "0",
	away_score: "0",
	home_shots: "0",
	away_shots: "0",
	decision: "R",
};

type ParticipantOption = {
	type: "user" | "guest";
	id: string;
	label: string;
};

export default function TournamentDetailPage() {
	const { id } = useParams();
	const { user, profile } = useAuth();
	const [loading, setLoading] = useState(true);
	const [tournament, setTournament] = useState<Tournament | null>(null);
	const [members, setMembers] = useState<TournamentMember[]>([]);
	const [guests, setGuests] = useState<TournamentGuest[]>([]);
	const [matches, setMatches] = useState<MatchWithResult[]>([]);
	const [inviteQuery, setInviteQuery] = useState("");
	const [inviteOptions, setInviteOptions] = useState<ProfileOption[]>([]);
	const [selectedInviteUserId, setSelectedInviteUserId] = useState("");
	const [newGuestName, setNewGuestName] = useState("");
	const [saving, setSaving] = useState(false);
	const [round, setRound] = useState("1");
	const [homeParticipant, setHomeParticipant] = useState("");
	const [awayParticipant, setAwayParticipant] = useState("");
	const [resultDrafts, setResultDrafts] = useState<Record<string, EditableResult>>({});

	const isAdmin = profile?.role === "admin";
	const hostMembership = useMemo(
		() => members.find((member) => member.user_id === user?.id && member.role === "host"),
		[members, user?.id],
	);
	const isHostOrAdmin = isAdmin || Boolean(hostMembership);

	const participantOptions = useMemo<ParticipantOption[]>(
		() => [
			...members.map((member) => ({ type: "user" as const, id: member.user_id, label: member.username })),
			...guests.map((guest) => ({ type: "guest" as const, id: guest.id, label: `${guest.display_name} (Guest)` })),
		],
		[members, guests],
	);

	const loadAll = useCallback(async () => {
		if (!id) return;
		try {
			setLoading(true);
			const [tournamentData, memberData, guestData, matchData] = await Promise.all([
				getTournament(id),
				listTournamentMembers(id),
				listTournamentGuests(id),
				listMatchesWithResults(id),
			]);
			setTournament(tournamentData);
			setMembers(memberData);
			setGuests(guestData);
			setMatches(matchData);
			const loadedParticipantOptions: ParticipantOption[] = [
				...memberData.map((member) => ({ type: "user" as const, id: member.user_id, label: member.username })),
				...guestData.map((guest) => ({ type: "guest" as const, id: guest.id, label: `${guest.display_name} (Guest)` })),
			];
			if (loadedParticipantOptions.length > 1) {
				setHomeParticipant(
					(current) => current || `${loadedParticipantOptions[0].type}:${loadedParticipantOptions[0].id}`,
				);
				setAwayParticipant(
					(current) => current || `${loadedParticipantOptions[1].type}:${loadedParticipantOptions[1].id}`,
				);
			}

			const drafts: Record<string, EditableResult> = {};
			for (const match of matchData) {
				drafts[match.id] = {
					home_score: String(match.result?.home_score ?? 0),
					away_score: String(match.result?.away_score ?? 0),
					home_shots: String(match.result?.home_shots ?? 0),
					away_shots: String(match.result?.away_shots ?? 0),
					decision: match.result?.decision ?? "R",
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
		if (!user?.id) return;
		try {
			const data = await searchProfilesByUsername(inviteQuery, user.id);
			setInviteOptions(data);
			if (data.length > 0 && !selectedInviteUserId) {
				setSelectedInviteUserId(data[0].id);
			}
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
		if (!homeParticipant || !awayParticipant || homeParticipant === awayParticipant) {
			toast.warning("Choose two different players for this match.");
			return;
		}

		const [homeType, homeId] = homeParticipant.split(":");
		const [awayType, awayId] = awayParticipant.split(":");
		try {
			setSaving(true);
			await createMatch(
				id,
				{
					userId: homeType === "user" ? homeId : null,
					guestId: homeType === "guest" ? homeId : null,
				},
				{
					userId: awayType === "user" ? awayId : null,
					guestId: awayType === "guest" ? awayId : null,
				},
				Number(round),
			);
			toast.success("Match added.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onAddGuest = async () => {
		if (!id || !newGuestName.trim()) return;
		try {
			setSaving(true);
			await addTournamentGuest(id, newGuestName.trim());
			setNewGuestName("");
			toast.success("Guest added.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const onDeleteGuest = async (guestId: string) => {
		if (!id) return;
		try {
			setSaving(true);
			await removeTournamentGuest(id, guestId);
			toast.success("Guest removed.");
			await loadAll();
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const isGuestMatch = (match: MatchWithResult) => Boolean(match.home_guest_id || match.away_guest_id);

	const canSaveResult = (match: MatchWithResult) => {
		if (isHostOrAdmin) return true;
		if (isGuestMatch(match)) return false;
		const isParticipant = user?.id === match.home_user_id || user?.id === match.away_user_id;
		return isParticipant && !match.result?.locked;
	};

	const canLockResult = (match: MatchWithResult) => {
		if (isHostOrAdmin) {
			return Boolean(match.result && !match.result.locked);
		}
		if (isGuestMatch(match)) return false;
		const isParticipant = user?.id === match.home_user_id || user?.id === match.away_user_id;
		return isParticipant && Boolean(match.result && !match.result.locked);
	};

	const isLockedForCurrentUser = (match: MatchWithResult) => {
		if (isHostOrAdmin) return false;
		if (isGuestMatch(match)) return true;
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
				draft.decision,
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
						<li
							key={`${member.tournament_id}:${member.user_id}`}
							className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm"
						>
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
								placeholder="Search username prefix"
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
							<option value="">Select user id</option>
							{inviteOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.username} • {option.id} ({option.role ?? "player"})
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
				<h2 className="text-lg font-semibold">Guests / Custom participants</h2>
				<ul className="space-y-2">
					{guests.length === 0 ? (
						<li className="text-sm text-muted-foreground">No guests added.</li>
					) : (
						guests.map((guest) => (
							<li key={guest.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm">
								<span>{guest.display_name}</span>
								{isHostOrAdmin ? (
									<Button variant="outline" size="sm" onClick={() => onDeleteGuest(guest.id)} disabled={saving}>
										Delete
									</Button>
								) : (
									<Badge variant="outline">Guest</Badge>
								)}
							</li>
						))
					)}
				</ul>

				{isHostOrAdmin && (
					<div className="flex flex-col gap-2 md:flex-row">
						<Input
							value={newGuestName}
							onChange={(event) => setNewGuestName(event.target.value)}
							placeholder="Guest display name"
						/>
						<Button onClick={onAddGuest} disabled={!newGuestName.trim() || saving}>
							Add guest
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
							value={homeParticipant}
							onChange={(event) => setHomeParticipant(event.target.value)}
						>
							<option value="">Home participant</option>
							{participantOptions.map((option) => (
								<option key={`home-${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>
									{option.label}
								</option>
							))}
						</select>
						<select
							className="h-10 rounded-md border bg-transparent px-3 text-sm"
							value={awayParticipant}
							onChange={(event) => setAwayParticipant(event.target.value)}
						>
							<option value="">Away participant</option>
							{participantOptions.map((option) => (
								<option key={`away-${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>
									{option.label}
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
							const homeName = match.home_guest_id
								? (guests.find((guest) => guest.id === match.home_guest_id)?.display_name ?? "Unknown guest")
								: (members.find((member) => member.user_id === match.home_user_id)?.username ?? "Unknown");
							const awayName = match.away_guest_id
								? (guests.find((guest) => guest.id === match.away_guest_id)?.display_name ?? "Unknown guest")
								: (members.find((member) => member.user_id === match.away_user_id)?.username ?? "Unknown");
							const draft = resultDrafts[match.id] ?? defaultResult;
							const disableInputs = isLockedForCurrentUser(match);
							return (
								<div key={match.id} className="space-y-2 rounded-md border p-3">
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span className="font-medium">
											Round {match.round}: {homeName} vs {awayName}
										</span>
										<Badge variant="outline">{draft.decision}</Badge>
										{match.result?.locked && <Badge>Locked</Badge>}
									</div>
									<div className="grid gap-2 md:grid-cols-5">
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
										<select
											className="h-10 rounded-md border bg-transparent px-3 text-sm"
											disabled={disableInputs}
											value={draft.decision}
											onChange={(event) =>
												setResultDrafts((previous) => ({
													...previous,
													[match.id]: { ...draft, decision: event.target.value as MatchParticipantDecision },
												}))
											}
										>
											<option value="R">R (Regular)</option>
											<option value="OT">OT (Overtime)</option>
											<option value="SO">SO (Shootout)</option>
										</select>
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
