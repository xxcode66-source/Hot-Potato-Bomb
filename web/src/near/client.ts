//! NEAR testnet client for $POTATO live mode.
//! - Views go straight to the RPC (robust, no wallet needed to read).
//! - Actions go through the browser Wallet (near-api-js WalletConnection).
//! Contract id comes from VITE_CONTRACT_ID (.env).
//! near-api-js is imported DYNAMICALLY (only when a wallet is actually needed), so the
//! offline DEMO bundle never ships the heavy wallet dependency.

const NETWORK_ID = "testnet";
const RPC_URL = "https://rpc.testnet.near.org";
const WALLET_URL = "https://wallet.testnet.near.org";
const HELPER_URL = "https://helper.testnet.near.org";
export const CONTRACT_ID: string = (import.meta.env.VITE_CONTRACT_ID as string) || "";
export const EXPLORER = "https://testnet.nearblocks.io";

// Methods the wallet's function-access-key is allowed to sign. Every one of these
// is deposit-free (the game moves $POTATO inside the contract), which is exactly what
// a function-call key permits (it can NOT attach a NEAR deposit).
const CHANGE_METHODS = [
  "join_round",
  "pass_bomb",
  "defuse",
  "finalize_round",
  "claim_streak",
  "faucet",
  "set_demo_mode",
];

let _near: any = null;
let _wallet: any = null;

async function getWallet(): Promise<any> {
  if (_wallet) return _wallet;
  const nearApi = await import("near-api-js");
  const keyStore = new nearApi.keyStores.BrowserLocalStorageKeyStore();
  _near = await nearApi.connect({
    networkId: NETWORK_ID,
    keyStore,
    nodeUrl: RPC_URL,
    walletUrl: WALLET_URL,
    helperUrl: HELPER_URL,
  });
  _wallet = new nearApi.WalletConnection(_near, "potato");
  return _wallet;
}

export function signedIn(): boolean {
  return !!_wallet && _wallet.isSignedIn();
}

export function accountId(): string {
  return _wallet ? _wallet.getAccountId() : "";
}

/** Boot the wallet connection once; returns current sign-in status. */
export async function init(): Promise<{ signedIn: boolean; accountId: string }> {
  const w = await getWallet();
  return { signedIn: w.isSignedIn(), accountId: w.getAccountId() };
}

export async function signIn(): Promise<void> {
  if (!CONTRACT_ID) throw new Error("VITE_CONTRACT_ID belum di-set");
  const w = await getWallet();
  w.requestSignIn({
    contractId: CONTRACT_ID,
    methodNames: CHANGE_METHODS,
    successUrl: window.location.origin,
    failureUrl: window.location.origin,
    keyType: "ed25519",
  });
}

export async function signOut(): Promise<void> {
  const w = await getWallet();
  w.signOut();
}

// ---- raw view via JSON-RPC ----
export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: "1",
    method: "query",
    params: {
      request_method: "call",
      request_data: {
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    },
  };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const txt = new TextDecoder().decode(new Uint8Array(j.result));
  return JSON.parse(txt) as T;
}

// ---- action via wallet ----
async function call(method: string, args: Record<string, unknown> = {}, deposit = "0"): Promise<any> {
  const w = await getWallet();
  const account = w.account() as any;
  return account.functionCall({
    contractId: CONTRACT_ID,
    methodName: method,
    args,
    gas: "150000000000000", // 150 TGas (generous for a 325KB contract)
    attachedDeposit: deposit,
  });
}

export const actions = {
  faucet: () => call("faucet"),
  join: () => call("join_round"),
  pass: (to: string) => call("pass_bomb", { to }),
  defuse: () => call("defuse"),
  finalize: () => call("finalize_round"),
  claim: () => call("claim_streak"),
  setDemo: (on: boolean) => call("set_demo_mode", { on }),
};

// ---- contract shape (snake_case, mirrors src/lib.rs views) ----
export interface RawPlayer {
  account_id: string;
  balance: string; // U128
  streak: number;
  holding: boolean;
}
export interface RawGameState {
  round_number: number;
  active: boolean;
  demo_mode: boolean;
  bomb_holder: string | null;
  round_deadline: string | number;
  seconds_left: number;
  round_seconds: number;
  round_pot: string; // U128
  global_pool: string; // U128
  buy_in: string; // U128
  participants: RawPlayer[];
}
export interface RawRules {
  buy_in: string;
  faucet_amount: string;
  round_seconds: number;
  normal_round_seconds: number;
  demo_round_seconds: number;
  global_cut_pct: number;
  survive_streak: number;
  claim_grant_pct: number;
  max_players: number;
  treasury: string;
  treasury_cut_pct: number;
}

// yocto token (18 decimals) -> whole number for display
export function tokens(u: string | number | undefined): number {
  if (u === undefined || u === null) return 0;
  const s = String(u).padStart(19, "0");
  const whole = s.slice(0, s.length - 18) || "0";
  return Number(whole);
}

export function shortName(id: string): string {
  return id ? id.split(".")[0] : "—";
}
