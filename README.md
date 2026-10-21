# 🥔 $POTATO — Hot Potato Bomb (NEAR HACKATHON)

> **The joke needs rules.** A memecoin whose *whole point* is on-chain game mechanics the contract actually enforces — not just a chart.
> Tracks: **`memecoins`** (primary) + **`games`** (the live-arcade dashboard).

An on-chain **hot-potato**. Join a round by staking a small **buy-in** of `$POTATO`. A bomb rotates between the players in that round. Pass it, defuse it, or **get burned** — and when you're burned, your buy-in is split among the survivors. A slice feeds a global **Winner Pool** that streak-survivors can claim. Rounds **start lazily** when players show up, so **nothing punishes you while you're offline**.

Everything is **deterministic and enforced by the contract**, not the UI. Built as a **single contract** (NEP-141 + game state).

---

## TL;DR for the reviewer (AI or human)

| I want to… | Do this | You'll see |
|---|---|---|
| Play instantly, no wallet | `cd web && npm i && npm run dev`, open the preview → it's in **MODE: DEMO** | Pixel-arcade CRT dashboard, round 1 with a live fuse |
| Watch an explosion | In DEMO, wait for the timer to hit 0 (fuse 15s by default) | **"BOOM!"** banner + red flash + screen-shake; survivor pot grows |
| Pass the bomb | Tap another player's row in the Arena (when it's on you) | Bomb moves, that player's row turns "holding" |
| Defuse | Click **DEFUSE** while holding | Round closes; you forfeit your 10; survivors split the pot |
| Play on-chain (LIVE) | Deploy to testnet (below), set `VITE_CONTRACT_ID`, click **MODE: LIVE** | The *same* dashboard now reads real contract state and sends real transactions |
| Prove it's on-chain | Click the **explorer link** in the live ticker | Your `join_round` / `pass_bomb` / `finalize_round` transactions, real balances |

---

## Repo layout
```
contract/           Rust smart contract (near-sdk 5.x) -> potato.wasm
  src/lib.rs
web/                Vite + React pixel-arcade dashboard
  src/game/engine.ts   offline deterministic mirror (DEMO mode)
  src/near/client.ts   NEAR testnet client (RPC views + WalletConnection actions)
  src/near/useLiveGame.ts  poll contract -> mirror into the same UI state
  src/App.tsx          dual-mode UI (DEMO / LIVE)
SPEC.md             full game design spec
```

---

## 1) Run the demo (no wallet, no deploy)
```bash
cd web
npm install
npm run dev          # http://localhost:5173  -> MODE: DEMO
```
DEMO runs the game logic entirely in `web/src/game/engine.ts`. Great for the video & first impressions. Toggle **FUSE 15s/60s** in the topbar; add fake players with the JOIN box.

---

## 2) Build the contract
```bash
cd contract
rustup target add wasm32-unknown-unknown        # once
cargo build --release --target wasm32-unknown-unknown
# -> contract/target/wasm32-unknown-unknown/release/potato.wasm (~325 KB)
```

## 3) Deploy to NEAR testnet

### Option A — `cargo-near` (recommended, interactive wizard)
```bash
cargo install cargo-near
cd contract
cargo near create-dev-account    # optional: makes you a funded testnet account
cargo near deploy                # -> pick network=testnet, your account, init method `new`, then JSON args
```
When it asks for init args, use:
```json
{ "owner_id": "YOUR_ACCOUNT.testnet", "total_supply": "1000000000000000000000000000" }
```
(= 1,000,000,000 `$POTATO`; token has 18 decimals, so multiply by 1e18.)

### Option B — `near-cli-rs` (scripted)
```bash
npm install -g near-cli-rs@latest
near login --networkId testnet
near contract deploy YOUR_ACCOUNT.testnet \
  use-file ./target/wasm32-unknown-unknown/release/potato.wasm \
  with-init-call new \
  json-args '{"owner_id":"YOUR_ACCOUNT.testnet","total_supply":"1000000000000000000000000000"}' utf8-encoding \
  network-config testnet sign-with-keychain send
```
> If your `near-cli-rs` version spells the flags differently, run `near contract deploy --help` — the pieces are: `use-file`, `with-init-call <method>`, `json-args ... utf8-encoding`, `network-config testnet`, `sign-with-keychain send`.

## 4) Point the dashboard at your contract (LIVE mode)
```bash
cd web
cp .env.example .env         # set VITE_CONTRACT_ID=YOUR_ACCOUNT.testnet
npm run dev
# open the preview, click "MODE: LIVE", then "CONNECT WALLET"
```
- **First time in LIVE:** click **GET $POTATO** (calls `faucet()`) so you have tokens, then **JOIN ROUND** (pays 1000 `$POTATO` buy-in).
- Pass/defuse/finalize/claim all work as real transactions; the explorer link in the ticker opens your contract account.

## 5) Drive the contract from the CLI (no browser needed)
```bash
near view   $CONTRACT get_game_state      --networkId testnet
near view   $CONTRACT get_rules           --networkId testnet
near view   $CONTRACT ft_balance_of '{"account_id":"bob.testnet"}' --networkId testnet

near call   $CONTRACT faucet          --useAccount bob.testnet --networkId testnet
near call   $CONTRACT join_round      --useAccount bob.testnet --networkId testnet
near call   $CONTRACT pass_bomb '{"to":"alice.testnet"}' --useAccount bob.testnet --networkId testnet
near call   $CONTRACT defuse          --useAccount bob.testnet --networkId testnet
near call   $CONTRACT finalize_round  --useAccount anyone.testnet --networkId testnet   # only after the fuse
near call   $CONTRACT claim_streak    --useAccount alice.testnet --networkId testnet
near call   $CONTRACT set_demo_mode '{"on":true}' --useAccount $OWNER --networkId testnet  # 15s rounds
```

---

## Game rules (the "why this isn't just a meme" part)
| Constant | Default | Meaning |
|---|---|---|
| `BUY_IN` | 1000 `$POTATO` *(owner-tunable via `set_buy_in`)* | cost to enter a round = **max you can lose in a round** |
| `ROUND_SECONDS` / `DEMO_ROUND_SECONDS` | 60 / 15 | fuse length |
| `TREASURY_CUT_PCT` | 5% | of each pot → treasury (project revenue; owner-tunable, capped 20%) |
| `GLOBAL_CUT_PCT` | 10% | of the remaining pot → global Winner Pool |
| `SURVIVE_STREAK` / `CLAIM_GRANT_PCT` | 4 / 50% | streak to claim, and how much you take |
| `FAUCET_AMOUNT` | 100_000 `$POTATO` | one-time testnet drip per account |
| `MAX_PLAYERS` | 200 | participants per round cap |

**Flow:** `join_round` (first joiner holds) → `pass_bomb`/`defuse` → after the deadline anyone calls `finalize_round`. Loser's buy-in is split among survivors; everyone except the loser gains a streak. When nobody's playing, there's **no active round** and **nobody is charged**.

---

## Security & honesty notes (we lean on the chain, not the UI)
- **Function-call key, not full access.** LIVE mode signs with a wallet function-access key scoped to `join_round, pass_bomb, defuse, finalize_round, claim_streak, faucet, set_demo_mode`. Every one of these takes **0 NEAR deposit**, so the key can't move NEAR or attach deposits — a nice property of this game design.
- **No randomness oracle.** The holder is the first joiner (deterministic); the rest is player-chosen passes. We *removed* the old `random_seed` target selection, so there's no "seed could be peeked" caveat to defend.
- **The only attack surface** is gas-racing `finalize_round` — and it can only hurt the *current holder* (makes them lose sooner). It can't steal from others; the pot split is computed in the contract.
- **State is on-chain & readable**: `get_game_state`, `get_rules`, `ft_balance_of` — the frontend just mirrors them; it can't fake a balance or a streak.

## Tech used
NEAR smart contract (Rust, `near-sdk` 5.x, `store::` collections) · full **NEP-141** FT (transfer + transfer_call + resolve + free-registration storage + data-url icon) · `near-api-js` WalletConnection (lazy-loaded) · JSON-RPC views · Vite + React + TypeScript. Design doc in [`SPEC.md`](./SPEC.md).

---

## Deadline
Public repo before **2026-11-14T23:59Z**. Post the demo on X (video + "built at NEAR HACKATHON"). Keep secrets in `.env` — never commit them.
