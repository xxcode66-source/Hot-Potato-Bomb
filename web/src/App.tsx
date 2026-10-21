import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  GameState,
  initialState,
  onExplode,
  passBomb,
  defuse,
  claimStreak,
  addPlayer,
  beginRound,
  maybeBotPass,
  setDemoMode,
  secondsLeft,
  SURVIVE_STREAK,
  BUY_IN,
  youId,
} from "./game/engine";
import { Potato, Mood } from "./components/Potato";
import { useLiveGame } from "./near/useLiveGame";
import { CONTRACT_ID, EXPLORER, shortName } from "./near/client";

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const BLANK: GameState = {
  players: [],
  bombHolder: null,
  roundNumber: 0,
  deadline: 0,
  phase: "Idle",
  pool: 0,
  roundPot: 0,
  demoMode: false,
  roundSeconds: 60,
  events: [],
  seq: 0,
};

export default function App() {
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [demoState, setDemoState] = useState<GameState>(() => initialState(true));
  const [shake, setShake] = useState(false);
  const [flash, setFlash] = useState(false);
  const [sound, setSound] = useState(true);
  const lastBoom = useRef<number>(0);
  const lastBotMove = useRef<number>(0);

  const live = useLiveGame(mode === "live");
  const now = useNow(true);

  // ----- DEMO: auto-explode when the fuse runs out -----
  useEffect(() => {
    if (mode !== "demo") return;
    if (demoState.phase === "Active" && now >= demoState.deadline) {
      setDemoState((s) => onExplode(s, Date.now()));
    }
  }, [now, mode, demoState.phase, demoState.deadline]);

  // ----- DEMO: react to a fresh explosion -> shake + red flash -----
  useEffect(() => {
    if (mode !== "demo") return;
    const at = demoState.lastExplosion?.at ?? 0;
    if (at && at !== lastBoom.current) {
      lastBoom.current = at;
      setShake(true);
      setFlash(true);
      if (sound) beep(140, 0.18);
      setTimeout(() => setShake(false), 620);
      setTimeout(() => setFlash(false), 460);
    }
  }, [demoState.lastExplosion, sound, mode]);

  // ----- DEMO: auto-open the next round shortly after a boom/defuse (lazy rounds) -----
  useEffect(() => {
    if (mode !== "demo" || demoState.phase !== "Idle") return;
    if (!demoState.players.some((p) => p.balance >= BUY_IN)) return;
    const since = now - (demoState.lastExplosion?.at ?? 0);
    if (since >= 1000) {
      setDemoState((s) => (s.phase === "Idle" ? beginRound(s, Date.now()) : s));
    }
  }, [now, mode, demoState.phase, demoState.lastExplosion, demoState.players]);

  // ----- DEMO: bots hurl the bomb along so the table feels alive ----- 
  useEffect(() => {
    if (mode !== "demo" || demoState.phase !== "Active") return;
    if (!demoState.bombHolder || demoState.bombHolder === youId(demoState)) return;
    if (now - lastBotMove.current < 1500) return;
    lastBotMove.current = now;
    setDemoState((s) => maybeBotPass(s));
  }, [now, mode, demoState.phase, demoState.bombHolder]);

  // ----- shared derived view state (demo OR live) -----
  const game = mode === "live" ? live.game ?? BLANK : demoState;
  const youAcct = mode === "live" ? live.accountId : youId(demoState);
  const you = game.players.find((p) => p.id === youAcct);
  const youHold = !!game.bombHolder && game.bombHolder === youAcct;
  const left = secondsLeft(game, now);
  const roundActive = game.phase === "Active";
  const crit = roundActive && left <= 5;
  const holder = game.players.find((p) => p.id === game.bombHolder);
  const boom = mode === "demo" && !!demoState.lastExplosion && now - demoState.lastExplosion.at < 650;

  const youMood: Mood = useMemo(() => {
    if (!you) return "calm";
    if (mode === "demo" && demoState.lastExplosion && demoState.lastExplosion.victim === you.id && now - demoState.lastExplosion.at < 900)
      return "burned";
    if (youHold) return "panic";
    if (you.streak >= SURVIVE_STREAK) return "king";
    return "calm";
  }, [you, youHold, mode, demoState.lastExplosion, now]);

  // ----- actions branch by mode -----
  const doPass = (toId: string) => {
    if (mode === "live") void live.pass(toId);
    else {
      setDemoState((s) => passBomb(s, youId(s), toId));
      if (sound) beep(520, 0.07);
    }
  };
  const doDefuse = () => {
    if (mode === "live") void live.defuse();
    else {
      setDemoState((s) => defuse(s));
      if (sound) beep(880, 0.12);
    }
  };
  const doClaim = () => {
    if (mode === "live") void live.claim();
    else {
      setDemoState((s) => claimStreak(s, youId(s)));
      if (sound) beep(1040, 0.18);
    }
  };
  const doDemoJoin = (name: string) => setDemoState((s) => addPlayer(s, name));

  const busy = mode === "live" && live.busy;
  const canClaim = !!you && you.streak >= SURVIVE_STREAK && game.pool > 0 && !busy;

  const pot = game.roundPot;

  return (
    <div className={`app ${shake ? "shake" : ""}`}>
      {flash && <div className="boom-flash" />}
      {boom && <div className="boom-banner">BOOM!</div>}
      <header className="topbar">
        <div className="brand">
          <span className="spud-chip" />
          <h1>$POTATO</h1>
          <span className="tag">▚ HOT POTATO ARCADE</span>
        </div>
        <div className="topright">
          <button
            className="ghost"
            onClick={() => setMode((m) => (m === "demo" ? "live" : "demo"))}
            title="Switch offline demo vs on-chain testnet"
          >
            {mode === "live" ? "MODE: LIVE" : "MODE: DEMO"}
          </button>
          {mode === "demo" ? (
            <button
              className="ghost"
              onClick={() => setDemoState((s) => setDemoMode(s, !s.demoMode))}
              title="Demo fuse length"
            >
              {demoState.demoMode ? "FUSE 15s" : "FUSE 60s"}
            </button>
          ) : live.signedIn ? (
            <button className="ghost" onClick={live.signOut} title="Sign out of wallet">
              {shortName(live.accountId)} ▸ EXIT
            </button>
          ) : (
            <button className="ghost" onClick={live.signIn}>
              CONNECT WALLET
            </button>
          )}
          <button className="ghost" onClick={() => setSound((v) => !v)}>
            {sound ? "SFX ON" : "SFX OFF"}
          </button>
        </div>
      </header>

      <main className="stage">
        {/* HERO */}
        <section className={`hero ${crit ? "critical" : ""}`}>
          <div className="holder-badge">
            {mode === "live" && !roundActive
              ? "** WAITING FOR PLAYERS — JOIN TO START **"
              : holder
              ? `▶ ${holder.name} HOLDS THE BOMB`
              : "** NO ACTIVE ROUND **"}
          </div>
          <div className={`potato-wrap ${youHold ? "is-you" : ""}`}>
            <Potato mood={youHold ? youMood : holder ? "panic" : "calm"} size={210} />
            {roundActive && (
              <div className="fuse">
                <div
                  className="fuse-spark"
                  style={{ left: `${(left / game.roundSeconds) * 100}%` }}
                />
                <div
                  className="fuse-line"
                  style={{ width: `${(left / game.roundSeconds) * 100}%` }}
                />
              </div>
            )}
          </div>

          <div className={`timer ${crit ? "crit" : ""}`}>
            <span className="t-num">{String(left).padStart(2, "0")}</span>
            <span className="t-unit">sec</span>
          </div>
          <div className="round">
            ROUND {game.roundNumber} {pot > 0 ? `· POT 🥔 ${Math.round(pot)}` : ""}
          </div>

          {/* LIVE: not deployed/configured -> setup notice */}
          {mode === "live" && !CONTRACT_ID ? (
            <div className="controls">
              <button className="btn defuse" disabled>
                SETUP REQUIRED
                <small>deploy + set VITE_CONTRACT_ID</small>
              </button>
            </div>
          ) : /* LIVE: not signed in -> connect */
          mode === "live" && !live.signedIn ? (
            <div className="controls">
              <button className="btn defuse" onClick={live.signIn}>
                CONNECT
                <small>NEAR testnet wallet</small>
              </button>
            </div>
          ) : /* LIVE: signed in but not in this round -> join / faucet */
          mode === "live" && !you ? (
            <div className="controls">
              <button className="btn defuse" disabled={busy} onClick={() => void live.join()}>
                JOIN ROUND
                <small>pay {BUY_IN} $POTATO</small>
              </button>
              {live.myBalance < BUY_IN && (
                <button className="btn claim" disabled={busy} onClick={() => void live.faucet()}>
                  GET $POTATO
                  <small>testnet faucet</small>
                </button>
              )}
            </div>
          ) : (
            /* DEMO, or LIVE with a seat at the table */
            <div className="controls">
              <button className="btn defuse" disabled={!youHold || busy} onClick={doDefuse}>
                DEFUSE
                <small>forfeit your {BUY_IN}</small>
              </button>
              <button className="btn claim" disabled={!canClaim} onClick={doClaim}>
                CLAIM 👑
                <small>+50% of pool</small>
              </button>
            </div>
          )}

          <p className="hint">
            {busy ? (
              <>Signing with your wallet… watch for the redirect.</>
            ) : mode === "live" && !live.signedIn ? (
              <>LIVE mode reads real state from <code>{CONTRACT_ID || "testnet contract"}</code>. Connect to play.</>
            ) : youHold ? (
              <>You&apos;re holding it! Tap a rival to <b>PASS</b> or <b>DEFUSE</b> (you lose your {BUY_IN}).</>
            ) : (
              <>Bomb is on <b>{holder?.name ?? "—"}</b>. Survive the boom to bank a streak — or join to get in on it.</>
            )}
          </p>

          {mode === "live" && (live.error || live.myBalance > 0) && (
            <div className="livestatus">
              {live.myBalance > 0 && (
                <span className="bal">WALLET: {Math.round(live.myBalance)} $POTATO</span>
              )}
              {live.error && <span className="err">⚠ {live.error}</span>}
            </div>
          )}
        </section>

        {/* ARENA */}
        <aside className="side">
          <div className="pool">
            <span className="pool-label">WINNER POOL</span>
            <span className="pool-num">🥇 {Math.round(game.pool)}</span>
          </div>

          <h3 className="side-h">The Arena ({game.players.length})</h3>
          <ul className="arena">
            {game.players.length === 0 && (
              <li className="p-row">
                <span className="p-name">nobody yet — be the first spud 🥔</span>
              </li>
            )}
            {game.players.map((p) => {
              const holding = p.id === game.bombHolder;
              const isYou = p.id === youAcct;
              const clickable = youHold && !holding && !isYou;
              return (
                <li
                  key={p.id}
                  className={`p-row ${holding ? "holding" : ""} ${isYou ? "you" : ""}`}
                  onClick={() => clickable && doPass(p.id)}
                >
                  <Potato mood={holding ? "panic" : p.streak >= SURVIVE_STREAK ? "king" : "calm"} size={44} />
                  <div className="p-meta">
                    <span className="p-name">
                      {p.name} {isYou && <em>(you)</em>}
                    </span>
                    <span className="p-bal">{Math.round(p.balance)} $POTATO</span>
                  </div>
                  <div className="p-streak" title="rounds survived">
                    🔥{p.streak}
                  </div>
                  {clickable && <span className="throw">throw →</span>}
                </li>
              );
            })}
          </ul>

          {mode === "demo" ? (
            <JoinForm onJoin={doDemoJoin} />
          ) : (
            <div className="join">
              <input readOnly value={live.signedIn ? live.accountId : "not connected"} />
              {!you && live.signedIn ? (
                <button disabled={busy} onClick={() => void live.join()}>
                  JOIN
                </button>
              ) : (
                <button disabled={!youHold || busy} onClick={doDefuse}>
                  END
                </button>
              )}
            </div>
          )}

          <div className="ticker">
            {mode === "live" ? (
              <>
                <div className="tk tk-NewRound">
                  <span className="tk-dot" /> live via {CONTRACT_ID ? shortName(CONTRACT_ID) : "testnet"}
                </div>
                <div className="tk tk-BombPassed">
                  <span className="tk-dot" /> {roundActive ? `fuse ${left}s · ${game.players.length} in round` : "idle: no active round"}
                </div>
                <a className="tk tk-StreakClaimed" href={`${EXPLORER}/accounts/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
                  <span className="tk-dot" /> view contract on explorer ↗
                </a>
              </>
            ) : (
              demoState.events.slice(0, 8).map((e) => (
                <div key={e.id} className={`tk tk-${e.kind}`}>
                  <span className="tk-dot" /> {e.text}
                </div>
              ))
            )}
          </div>
        </aside>
      </main>

      <footer className="foot">
        Built for NEAR HACKATHON · track <b>memecoins</b> + <b>games</b> · buy-in rounds, loser&apos;s stake to survivors ·
        rules enforced on-chain (<code>contract/src/lib.rs</code>)
      </footer>
    </div>
  );
}

function JoinForm({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="join"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onJoin(name.trim().slice(0, 12));
          setName("");
        }
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name a challenger…"
        maxLength={12}
      />
      <button type="submit">+ JOIN</button>
    </form>
  );
}

// Tiny WebAudio blip so we don't ship binary assets. Safe no-op if unsupported.
function beep(freq: number, dur: number) {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.type = "square";
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, dur * 1000);
  } catch {
    /* ignore */
  }
}
