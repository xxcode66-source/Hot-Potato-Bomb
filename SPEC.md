# $POTATO — "Kentang Panas" (Hot Potato Bomb)

> Hackathon: NEAR HACKATHON · Track: `memecoins` (+ `games`)
> Prinsip: **The joke needs rules** — meme = mekanik on-chain yang ditegakkan kontrak.

---

## 1. Elevator pitch
Ada "bom" on-chain dengan sumbu. Buat ikut ronde, kamu setor **buy-in** kecil ($POTATO) ke pot ronde itu. Bom dioper di antara peserta; siapa yang **megang pas meledak** kehilangan buy-in-nya — yang langsung **dibagi ke yang selamat**. Sebagian kecil masuk **Winner Pool global**; pemain yang streak-nya panjang boleh **klaim**. Ronde cuma jalan kalau ada yang main (**lazy start**), jadi **tidur = aman**, nggak ada jam global yang ng hukum orang offline. Ledakan tampil **live** di dashboard pixel-arcade. Semua **deterministik di kontrak** — nggak bisa dicurang lewat UI.

**Kenapa diubah dari %saldo → buy-in:** rugi %saldo kejam + nggak adil (orang gede cuma "goyah", orang kecil hancur). Buy-in tetap = semua risiko **sama & terbatas**, dan jelas dibaca juri.

**Dilema gameplay:** *Oper (gratis, aman ronde ini)* vs *Jinak (kamu sengaja ngalah, rela buy-in-mu buat nutup ronde)* vs *Diem (kena boom, buy-in-mu kebagi ke yang lain).*

---

## 2. Mekanik & konstanta (default, tunable di kontrak)
| Konstanta | Default | Fungsi |
|---|---|---|
| `ROUND_SECONDS` | 60 | durasi sumbu 1 ronde (mode normal) |
| `DEMO_ROUND_SECONDS` | 15 | sumbu cepet buat demo/juri (`set_demo_mode(true)`) |
| `BUY_IN` | 1000 $POTATO | setor masuk ronde (risi maksimal/ronde) — **bisa diubah owner via `set_buy_in`** |
| `FAUCET_AMOUNT` | 100_000 $POTATO | tetes sekali/akun di testnet biar juri bisa main |
| `TREASURY_CUT_PCT` | 5% | potongan tiap pot → treasury (pendapatan proyek; owner-tunable, cap 20%) |
| `GLOBAL_CUT_PCT` | 10% | potongan dari sisa pot → Winner Pool global |
| `SURVIVE_STREAK` | 4 | ronde berturut-turut lolos → boleh klaim |
| `CLAIM_GRANT_PCT` | 50% | pengklaim ambil 50% Winner Pool global |
| `MAX_PLAYERS` | 200 | batas peserta per ronde |

*(token = 18 desimal; `1 $POTATO = 1e18`.)*

**Alur ronde (lazy):**
1. `join_round()` bayar `BUY_IN` ke pot. **Orang pertama** yang join → jadi `bomb_holder` (deterministik, tanpa RNG).
2. `pass_bomb(to)` → bom pindah ke peserta lain. Sumbu tetap jalan.
3. `defuse()` (hanya holder) → holder **rela buy-in-nya**, ronde langsung ditutup, pot dibagi ke survivor.
4. Lewat deadline → siapa pun panggil `finalize_round()`: holder kalah (buy-in-nya didistribusi), survivor +1 streak.
5. Ronde jadi **non-active**; ronde berikutnya baru mulai lagi pas ada `join_round()` baru. Kalau nggak ada yang main → nggak ada yang rugi.

**Distribusi pas close:** `pot = Σ buy-in`. Potong `TREASURY_CUT_PCT` → treasury (pendapatan proyek). Sisa potong `GLOBAL_CUT_PCT` → Winner Pool global. Sisanya lagi dibagi **rata ke survivor** (bukan loser); debu pembagian (integer) → global pool.

---

## 3. Kontrak (NEP-141 + game state) — 1 kontrak
### State (`store::`)
- NEP-141 lengkap: `owner`, `total_supply`, `balances: LookupMap<AccountId,U128>`, `ft_metadata` (+ ikon PNG base64 data-url), `ft_total_supply`, `ft_balance_of`, `ft_transfer`, `ft_transfer_call` → `ft_resolve_transfer` (callback `#[private]`, refund sisa), dan Storage Management versi **free-registration** (bound 0, tak ada NEAR dikunci) supaya tetap 0-deposit & jalan dengan function-call key.
- Game: `round_number`, `active: bool`, `round_deadline` (ns), `round_pot: U128`, `global_pool: U128`, `bomb_holder: Option<AccountId>`, `participants: Vector<AccountId>`, `streak: LookupMap<AccountId,u64>`, `faucet_used: LookupSet<AccountId>`, `demo_mode: bool`, `buy_in: U128`, `treasury: AccountId`, `treasury_cut_pct: u64`.

### Methods
- `faucet()` — drip `FAUCET_AMOUNT` sekali per akun (testnet).
- `join_round()` — debit `BUY_IN` → pot; lazy-start ronde; peserta pertama pegang bom.
- `pass_bomb(to)` — hanya `bomb_holder`; `to` wajib peserta ronde ini.
- `defuse()` — hanya holder; tutup ronde, holder jadi loser (forfeit buy-in).
- `finalize_round()` — publik; **cek `env::block_timestamp() >= deadline`**; tutup ronde (explode).
- `claim_streak()` — `streak >= SURVIVE_STREAK` & `global_pool>0` → ambil `CLAIM_GRANT_PCT`.
- Owner/admin (butuh full key, bukan function-call key): `set_demo_mode(on)`, `owner_mint(acct, amt)`, `set_buy_in(amount)`, `set_treasury(acct)`, `set_treasury_cut(pct)`.
- Views: `get_game_state`, `get_rules`, `ft_balance_of`, `ft_total_supply`, `ft_metadata`, `storage_balance_of`, `storage_balance_bounds`. (Ubah: `ft_transfer`/`ft_transfer_call` butuh 1 yocto → full wallet, bukan function-call key.)

### Events (log JSON, dibaca frontend/explorer)
`NewRound`, `JoinedRound`, `BombPassed`, `BombDefused`, `BombExploded`/`RoundClosed` (victim, survivors, distributed, global_pool), `Treasury` (to, amount), `StreakClaimed`, `Faucet`, `ft_transfer`, `ft_resolve_transfer`.

> Semua aksi inti **0 deposit NEAR** (token dipindah di dalam kontrak), jadi bisa ditandatangani **function-call key** yang di-scope ke `methodNames` — lihat §7.

---

## 4. Deterministik, tanpa oracle
Ronde lama pakai `env.random_seed()` buat nyasar-in bom. **Dihapus**: model baru nunjuk holder = **peserta pertama** (jelas & deterministik), sisanya lewat `pass_bomb`. Ini **menghilangkan** caveat "seed bisa diintip" → lebih gampang dibela di mata juri keamanan. Satu-satunya "kejahatan" yang tersisa: gas racing buat `finalize_round`, yang untungnya **cuma merugikan loser** (biar dia makin cepet kalah) — bukan merugikan orang lain.

---

## 5. UI/UX — "Pixel Arcade" (keren, JANGAN keliatan AI)
### Hindari (tanda template AI)
Hero gradient ungu-biru, font Inter sansek semua, glassmorphism rata, emoji confetti generik, tombol bulat biru, ikon line-art stok, 3D/clay generik.

### Art direction
- **Tema**: retro CRT arcade. Font `Press Start 2P` (display/HUD) + `VT323` (body). **Bukan Inter.**
- **CRT**: scanlines + vignette + flicker tipis → kerasa kayak layar mesin arcade beneran.
- **Palet neon**: kuning kentang `#ffcf3f`, ember `#ff5a3c`, cyan `#45e6ff`, safe `#37e07a`, danger `#ff2d55` di atas layar `#0d0d1c`, dengan chromatic shadow merah/cyan.
- **Maskot**: kentang vector kustom bermuka (calm → panic → burned/king) — digambar tangan (SVG), bukan emoji. Tetep jadi "maskot" di tengah screen, kontras dengan HUD pixel.
- **Arena**: gaya **high-score table** (`WINNER POOL`, baris peserta + streak 🔥).
- **Motion**: timer hijau → **kedip merah** pas kritis; ledakan = banner **"BOOM!"** pixel + flash merah + **screen-shake** bertahap (steps, 8-bit); kentang bob saat kamu pegang; sumbu + percikan di atas maskot.
- **Sound**: WebAudio blip square-wave (tik/defuse) opsional, bisa di-mute.

### Layout dashboard "Live Bomb"
1. Topbar: brand + toggle **MODE: DEMO/LIVE** + (demo) FUSE 15s/60s · (live) CONNECT/akun + SFX.
2. Hero: kentang + sumbu + timer + badge pemegang bom + kontrol (`DEFUSE`/`CLAIM`/`JOIN`/`CONNECT`).
3. Arena list: peserta ronde + saldo + streak + badge "you" + "throw →" buat ngoper.
4. Winner Pool + status live (saldo wallet, error, link explorer).
5. Ticker: feed kejadian (demo) / status on-chain + link explorer (live).

Target rasa: **"game show"**, bukan "dApp".

---

## 6. Skrip demo 60 detik (buat video X + juri)
1. 0-5s: mode DEMO fuse 15s. Bom di kentang A, sumbu nyala, timer jalan.
2. 6-15s: **OPER** A → B (badge holder pindah, arena update).
3. 16-30s: B diem → **BOOM!** banner + screen-shake → buy-in B kebagi ke survivor, A/C naik streak, pot → pool.
4. 31-45s: C **DEFUSE** (rela 10) → ronde nutup → ronde baru nunggu pemain.
5. 46-55s: **CLAIM** streak 4 → kaching dari Winner Pool 👑 (kentang topi king).
6. 55-60s: switch **MODE: LIVE** → connect wallet testnet → `JOIN ROUND` → shot explorer: tx & state = bukti semua on-chain.

---

## 7. MODE: DEMO vs LIVE
- **DEMO** (default, offline): mesin deterministik di browser (`web/src/game/engine.ts`), **tanpa wallet**, buat juri nyoba instan + rekam video. Economía model buy-in disederhanakan di sisi klien.
- **LIVE** (testnet): `web/src/near/client.ts` + `useLiveGame.ts`.
  - **Baca** state → JSON-RPC `get_game_state` (poll 2s) → di-mirror ke shape yang sama → UI reuse.
  - **Tulis** → `near-api-js` `WalletConnection` (browser wallet/Sender testnet) `requestSignIn({contractId, methodNames, keyType})`.
  - Kunci login = **function-call key** di-scope ke `join_round/pass_bomb/defuse/finalize_round/claim_streak/faucet/set_demo_mode`. Karena semua itu **0-deposit**, function-call key sah (kunci ini **nggak bisa** transfer NEAR/attach deposit — itu batasan protokol, bukan bug kita).
  - Butuh `VITE_CONTRACT_ID` di `.env`.

---

## 8. Cara deploy & jalanin LIVE (ringkas — detail di `README.md`)
```bash
# 1. bangun wasm
cd contract && cargo build --release --target wasm32-unknown-unknown   # -> target/wasm32-unknown-unknown/release/potato.wasm

# 2A. deploy interaktif (rekomendasi; bikin akun testnet + init wizard)
cargo install cargo-near
cargo near deploy            # pilih network testnet, akun, init method "new", args

# 2B. ATAU via near-cli-rs (scripted; kalau flag beda ikutkan `near contract deploy --help`)
npm i -g near-cli-rs@latest
near login --networkId testnet
near contract deploy <you>.testnet use-file ./target/wasm32-unknown-unknown/release/potato.wasm \
     with-init-call new json-args '{"owner_id":"<you>.testnet","total_supply":"1000000000000000000000000000"}' utf8-encoding \
     network-config testnet sign-with-keychain send

# 3. frontend LIVE
cp web/.env.example web/.env      # isi VITE_CONTRACT_ID=<you>.testnet
cd web && npm i && npm run dev    # buka http://localhost:5173, klik MODE: LIVE
```

---

## 9. Roadmap build (status)
1. ✅ Repo scaffold (`contract/` + `web/`) + `.env.example`.
2. ✅ Kontrak v2: NEP-141 lengkap (transfer + transfer_call + resolve + storage free-reg + ikon) + round-pot (buy-in, lazy rounds, faucet) — **wasm hijau (382 KB)**. DEMO engine (`web/src/game/engine.ts`) mirror aturan yang sama (buy-in, cut 10%, split rata + dust→pool, streak, claim 50%).
3. ✅ Frontend pixel-arcade + maskot vector + mode DEMO/LIVE (dual engine) — **build hijau**.
4. ✅ Layer live: RPC view + WalletConnection + function-call key.
5. ⏭️ Deploy ke testnet (perlu akun & login kamu — lihat README §8).
6. ⏭️ README "do X → see Y" final + video 60 detik.

> Repo publik sebelum **2026-11-14T23:59Z**. Demo post di X (video + "built at NEAR HACKATHON"). Secrets di env var, JANGAN commit.
