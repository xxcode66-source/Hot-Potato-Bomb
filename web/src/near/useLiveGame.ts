//! React hook: polls the $POTATO contract on testnet and mirrors it into the
//! same GameState shape the offline engine uses, so the UI can render LIVE data
//! with no special-casing. Actions go through the wallet, then trigger a refresh.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  actions,
  CONTRACT_ID,
  init,
  signIn,
  signOut,
  shortName,
  tokens,
  view,
  type RawGameState,
} from "./client";
import type { GameState } from "../game/engine";

export interface LiveApi {
  enabled: boolean;
  ready: boolean;
  signedIn: boolean;
  accountId: string;
  error: string;
  busy: boolean;
  game: GameState | null;
  raw: RawGameState | null;
  myBalance: number;
  signIn: () => void;
  signOut: () => void;
  join: () => Promise<void>;
  pass: (to: string) => Promise<void>;
  defuse: () => Promise<void>;
  finalize: () => Promise<void>;
  claim: () => Promise<void>;
  faucet: () => Promise<void>;
}

function mapToGameState(raw: RawGameState): GameState {
  return {
    players: raw.participants.map((p) => ({
      id: p.account_id,
      name: shortName(p.account_id),
      balance: tokens(p.balance),
      streak: p.streak,
    })),
    bombHolder: raw.bomb_holder,
    roundNumber: raw.round_number,
    deadline: raw.active ? Date.now() + raw.seconds_left * 1000 : 0,
    phase: raw.active ? "Active" : "Idle",
    pool: tokens(raw.global_pool),
    roundPot: tokens(raw.round_pot),
    demoMode: raw.demo_mode,
    roundSeconds: raw.round_seconds,
    events: [],
    seq: 0,
    lastExplosion: undefined,
  };
}

export function useLiveGame(enabled: boolean): LiveApi {
  const [ready, setReady] = useState(false);
  const [signedIn, setSigned] = useState(false);
  const [acct, setAcct] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState<RawGameState | null>(null);
  const [myBalance, setMyBalance] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // boot wallet
  useEffect(() => {
    if (!enabled) return;
    init()
      .then((s) => {
        if (!alive.current) return;
        setSigned(s.signedIn);
        setAcct(s.accountId);
        setReady(true);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled || !CONTRACT_ID) return;
    try {
      const g = await view<RawGameState>("get_game_state");
      if (alive.current) {
        setRaw(g);
        setError("");
      }
      if (acct) {
        const bal = await view<string>("ft_balance_of", { account_id: acct });
        if (alive.current) setMyBalance(tokens(bal));
      }
    } catch (e: any) {
      if (alive.current) setError(e?.message ? `RPC: ${e.message}` : "Gagal baca kontrak");
    }
  }, [enabled, acct]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  const run = useCallback(
    async (fn: () => Promise<any>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
        // Wallet redirect flow may reload the page; also refresh optimistically.
        setTimeout(refresh, 1200);
        refresh();
      } catch (e: any) {
        setError(e?.message ? `TX: ${e.message}` : "Transaksi gagal");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return {
    enabled,
    ready,
    signedIn,
    accountId: acct,
    error,
    busy,
    game: raw ? mapToGameState(raw) : null,
    raw,
    myBalance,
    signIn: () => signIn().catch((e) => setError(String(e?.message || e))),
    signOut: () => {
      signOut().then(() => {
        setSigned(false);
        setAcct("");
      });
    },
    join: () => run(actions.join),
    pass: (to: string) => run(() => actions.pass(to)),
    defuse: () => run(actions.defuse),
    finalize: () => run(actions.finalize),
    claim: () => run(actions.claim),
    faucet: () => run(actions.faucet),
  };
}
