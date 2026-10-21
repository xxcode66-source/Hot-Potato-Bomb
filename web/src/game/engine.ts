//! $POTATO deterministic game engine — faithful client mirror of contract/src/lib.rs.
//! Powers the offline DEMO so judges can feel the loop instantly without a wallet.
//! Every rule here matches the on-chain contract 1:1 (buy-in round-pot model):
//!   - each participant pays a fixed BUY_IN into the round pot on round start,
//!   - the holder loses only their BUY_IN, split equally among survivors,
//!   - a GLOBAL_CUT_PCT slice (plus integer-division dust) feeds the Winner Pool,
//!   - survivors bank a streak; a 4-streak holder may claim 50% of the Winner Pool.
//! In LIVE mode the same numbers are the single source of truth in the Rust contract.

// ---- shared constants (keep in sync with the Rust contract) ----
export const ROUND_SECONDS = 60; // normal round fuse
export const DEMO_ROUND_SECONDS = 15; // fast fuse so judges see the loop quickly
export const BUY_IN = 1000; // $POTATO to enter a round (contract default: 1000 * 10^18 yocto)
export const FAUCET_AMOUNT = 100_000; // $POTATO testnet drip (contract: 100000 * 10^18)
export const TREASURY_CUT_PCT = 5; // 5% of each pot -> treasury (leaves the player economy)
export const GLOBAL_CUT_PCT = 10; // 10% of the remaining pot -> global Winner Pool
export const SURVIVE_STREAK = 4; // clean rounds -> eligible to claim
export const CLAIM_GRANT_PCT = 50; // claimer takes 50% of the current global pool
export const MAX_PLAYERS = 200;

export type Phase = "Active" | "Idle";

export interface Player {
  id: string;
  name: string;
  balance: number; // whole $POTATO in the wallet (buy-ins are debited from here)
  streak: number;
}

export interface GameEvent {
  id: number;
  kind:
    | "BombPassed"
    | "BombDefused"
    | "BombExploded"
    | "NewRound"
    | "StreakClaimed"
    | "Registered";
  text: string;
  ts: number;
}

export interface GameState {
  players: Player[]; // arena roster (everyone in the current round pays BUY_IN at start)
  bombHolder: string | null;
  roundNumber: number;
  deadline: number; // epoch ms — meaningful only while phase === "Active"
  phase: Phase;
  pool: number; // global Winner Pool (claimable)
  roundPot: number; // $POTATO currently committed in this round's pot
  demoMode: boolean;
  roundSeconds: number;
  events: GameEvent[];
  seq: number;
  lastExplosion?: { victim: string; lost: number; at: number };
}

const YOU = "you";

export function youId(_state?: GameState): string {
  return YOU;
}

// ---- setup ----

export function initialState(demoMode = true): GameState {
  const players: Player[] = [
    { id: YOU, name: "You", balance: 50_000, streak: 0 },
    { id: "bruno", name: "Bruno", balance: 42_000, streak: 1 },
    { id: "sari", name: "Sari", balance: 61_000, streak: 2 },
    { id: "toki", name: "Toki", balance: 33_000, streak: 0 },
    { id: "mira", name: "Mira", balance: 48_000, streak: 3 },
  ];
  const s: GameState = {
    players,
    bombHolder: null,
    roundNumber: 0,
    deadline: 0,
    phase: "Idle",
    pool: 0,
    roundPot: 0,
    demoMode,
    roundSeconds: demoMode ? DEMO_ROUND_SECONDS : ROUND_SECONDS,
    events: [],
    seq: 0,
  };
  beginRound(s, Date.now()); // you join first, so you hold the bomb immediately
  return s;
}

function label(players: Player[], id: string | null): string {
  const p = players.find((x) => x.id === id);
  return p ? p.name : "—";
}

function pushEvent(s: GameState, kind: GameEvent["kind"], text: string): void {
  s.events = [{ id: s.seq, kind, text, ts: Date.now() }, ...s.events].slice(0, 40);
  s.seq += 1;
}

function clone(s: GameState): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p })),
    events: s.events.slice(),
    lastExplosion: s.lastExplosion ? { ...s.lastExplosion } : undefined,
  };
}

// ---- round lifecycle (mirrors start_round / end_round on-chain) ----

/// Open a fresh round: every participant who can afford BUY_IN pays in; the first
/// paying player is handed the bomb (deterministic, exactly like join_round on-chain).
export function beginRound(state: GameState, now: number): GameState {
  const s = clone(state);
  startRoundInPlace(s, now);
  return s;
}

function startRoundInPlace(s: GameState, now: number): void {
  s.roundNumber += 1;
  s.phase = "Active";
  s.deadline = now + s.roundSeconds * 1000;
  s.roundPot = 0;
  s.bombHolder = null;
  const payers = s.players.filter((p) => p.balance >= BUY_IN);
  if (payers.length === 0) {
    // Nobody could afford the buy-in: nothing to play, keep it idle.
    s.phase = "Idle";
    s.deadline = 0;
    return;
  }
  for (const p of payers) {
    p.balance -= BUY_IN;
    s.roundPot += BUY_IN;
  }
  // Rotate who opens holding the bomb (round-based) so the demo isn't always "you".
  // (On-chain the first *joiner* holds — in a live game you choose when to join.)
  s.bombHolder = payers[s.roundNumber % payers.length].id;
  pushEvent(
    s,
    "NewRound",
    `Round ${s.roundNumber} · buy-in ${BUY_IN} each · pot ${s.roundPot} · ${label(s.players, s.bombHolder)} holds`
  );
}

/// Close the round. `exploded` = fuse hit zero; otherwise the holder defused (forfeit).
function endRound(s: GameState, exploded: boolean, now: number): void {
  const loser = s.bombHolder;

  let pot = s.roundPot;
  s.roundPot = 0;

  // Treasury cut comes off the top (leaves the player economy, like the contract),
  // then a global cut feeds the Winner Pool. Integer math mirrors the on-chain split.
  const treasuryCut = Math.floor((pot * TREASURY_CUT_PCT) / 100);
  pot -= treasuryCut;
  const cut = Math.floor((pot * GLOBAL_CUT_PCT) / 100);
  s.pool += cut;
  pot -= cut;

  if (!loser) {
    // Defensive: no holder but pot exists -> don't strand tokens.
    s.pool += pot;
    s.phase = "Idle";
    s.deadline = 0;
    return;
  }

  const survivors = s.players.filter((p) => p.id !== loser);
  if (survivors.length === 0) {
    // Solo holder: nobody to pay, the whole pot rolls into the global pool.
    s.pool += pot;
  } else {
    const n = survivors.length;
    const share = Math.floor(pot / n);
    const rem = pot - share * n; // dust -> Winner Pool (matches contract remainder)
    s.pool += rem;
    for (const p of survivors) {
      p.balance += share;
      p.streak += 1;
    }
  }

  // Loser already forfeited their BUY_IN at round start; only the streak resets.
  const loserP = s.players.find((p) => p.id === loser);
  if (loserP) loserP.streak = 0;

  if (exploded) {
    s.lastExplosion = { victim: loser, lost: BUY_IN, at: now };
    pushEvent(s, "BombExploded", `💥 ${label(s.players, loser)} got hit — lost ${BUY_IN} $POTATO`);
  } else {
    pushEvent(s, "BombDefused", `${label(s.players, loser)} defused — forfeited ${BUY_IN} $POTATO`);
  }

  s.bombHolder = null;
  s.phase = "Idle";
  s.deadline = 0;
}

// ---- actions ----

export function passBomb(state: GameState, fromId: string, toId: string): GameState {
  if (state.phase !== "Active" || state.bombHolder !== fromId) return state;
  if (fromId === toId) return state;
  const target = state.players.find((p) => p.id === toId);
  if (!target || toId === fromId) return state; // can only pass to another participant
  const s = clone(state);
  s.bombHolder = toId;
  pushEvent(s, "BombPassed", `${label(s.players, fromId)} passed the bomb to ${label(s.players, toId)}`);
  return s;
}

export function defuse(state: GameState): GameState {
  if (state.phase !== "Active" || !state.bombHolder) return state;
  const s = clone(state);
  endRound(s, false, Date.now()); // holder forfeits their buy-in, round closes early
  return s;
}

export function onExplode(state: GameState, now: number): GameState {
  if (state.phase !== "Active" || now < state.deadline) return state;
  const s = clone(state);
  endRound(s, true, now);
  return s;
}

export function claimStreak(state: GameState, id: string): GameState {
  const p = state.players.find((x) => x.id === id);
  if (!p || p.streak < SURVIVE_STREAK || state.pool <= 0) return state;
  const s = clone(state);
  const me = s.players.find((x) => x.id === id)!;
  const grant = Math.floor((s.pool * CLAIM_GRANT_PCT) / 100);
  s.pool -= grant;
  me.balance += grant;
  me.streak = 0;
  pushEvent(s, "StreakClaimed", `${me.name} claimed ${grant} $POTATO from the Winner Pool 👑`);
  return s;
}

/// A challenger joins: they buy into the current round if one is live, otherwise they
/// wait for the next round to open (lazy rounds — exactly like the on-chain model).
export function addPlayer(state: GameState, name: string): GameState {
  if (state.players.length >= MAX_PLAYERS) return state;
  if (state.players.some((p) => p.name === name)) return state;
  const s = clone(state);
  const id = "p" + s.players.length + "_" + Math.floor(Math.random() * 1000);
  const np: Player = { id, name, balance: 25_000, streak: 0 };
  if (s.phase === "Active" && np.balance >= BUY_IN) {
    np.balance -= BUY_IN; // joining an in-progress round still costs the buy-in
    s.roundPot += BUY_IN;
    if (!s.bombHolder) s.bombHolder = id;
  }
  s.players.push(np);
  pushEvent(s, "Registered", `${name} joined the arena (buy-in ${BUY_IN})`);
  return s;
}

export function setDemoMode(state: GameState, on: boolean): GameState {
  const s = clone(state);
  s.demoMode = on;
  s.roundSeconds = on ? DEMO_ROUND_SECONDS : ROUND_SECONDS;
  if (s.phase === "Active") s.deadline = Date.now() + s.roundSeconds * 1000;
  return s;
}

/// Demo-only: let the current bot holder hurl the bomb along so the table feels alive.
/// Never changes any economic rule — just a `pass_bomb` between participants.
export function maybeBotPass(state: GameState): GameState {
  if (state.phase !== "Active" || !state.bombHolder) return state;
  if (state.bombHolder === YOU) return state; // your turn, bots wait
  const others = state.players.filter((p) => p.id !== state.bombHolder);
  if (others.length === 0) return state;
  const target = others[Math.floor(Math.random() * others.length)];
  return passBomb(state, state.bombHolder, target.id);
}

// ---- selectors for UI ----

export function secondsLeft(state: GameState, now: number): number {
  if (state.phase !== "Active") return 0;
  return Math.max(0, Math.ceil((state.deadline - now) / 1000));
}

export function critical(state: GameState, now: number): boolean {
  return state.phase === "Active" && secondsLeft(state, now) <= 5;
}

export function currentYou(state: GameState): Player | undefined {
  return state.players.find((p) => p.id === YOU);
}
