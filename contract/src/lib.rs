//! $POTATO — "Kentang Panas" (Hot Potato Bomb) — Round-Pot model (v2)
//! NEP-141 memecoin with on-chain mechanics for NEAR HACKATHON.
//!
//! Refined concept (tidied):
//! - Playing is OPT-IN per round: you pay a fixed BUY_IN into that round's pot.
//! - Rounds start lazily on the first `join_round`, so an idle game never punishes
//!   anyone who isn't actively playing (you can "sleep" — no global always-on clock).
//! - The bomb rotates between current-round participants via `pass_bomb`.
//! - At the deadline (`finalize_round`) or on `defuse`, the current holder loses only
//!   their BUY_IN, which is split among the survivors (minus a small global cut).
//! - The global Winner Pool accumulates that cut; survivors can `claim_streak` once
//!   their survival streak is long enough.
//! All rules are deterministic and enforced by the contract, not the UI.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

// ----- Tunable game constants (token units are 18 decimals) -----
const ROUND_SECONDS: u64 = 60; // normal round fuse
const DEMO_ROUND_SECONDS: u64 = 15; // fast fuse so judges see the loop quickly
const DEFAULT_BUY_IN: u128 = 1_000_000_000_000_000_000_000; // 1000 $POTATO default round buy-in
const DEFAULT_TREASURY_CUT_PCT: u64 = 5; // 5% of each pot -> treasury (project revenue)
const FAUCET_AMOUNT: u128 = 100_000_000_000_000_000_000_000; // 100_000 $POTATO (testnet drip)
const GLOBAL_CUT_PCT: u128 = 10; // 10% of each pot -> global Winner Pool
const SURVIVE_STREAK: u64 = 4; // clean rounds -> eligible to claim
const CLAIM_GRANT_PCT: u128 = 50; // claimer takes 50% of the current global pool
const MAX_PLAYERS: u32 = 200;

// Gas budgets for the NEP-141 cross-contract ft_transfer_call flow.
const CALL_GAS: Gas = Gas::from_gas(30_000_000_000_000); // 30 TGas -> receiver.ft_on_transfer
const RESOLVE_GAS: Gas = Gas::from_gas(15_000_000_000_000); // 15 TGas -> ft_resolve_transfer

// Pixel-potato token icon (data-url PNG, generated in-repo).
const ICON: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIBSURBVHhe7dfLbeQwEEVRx+CVA3ByTsWZOZ4JYAwtBDSOKVfpQ4o9Uw+4O+p9CuhFv7yUSqVSqVQqlUqlUqmP3t9e/x5Fr6eRQ67AjCll6R6YOYUsOQI73CJLbfHn62M3emxhp2GyiDjoDHqL3brLAr2Gi1m3HMHgEcPF7GFHMPCO8Y/Yo+sRDLpz+CN26nIEA2YZv2K3y4+guQVmwI6XHUHT0Qf4+nz/gW8W7HjJATQcPX7B8VsHWLDr6SNoZuAIHP/bARbs7KZd0sywETh+2AE0OnoAPSIf30bvW/i921LSxJAs+kRevo3et/B7t6WkiSEZ9Ii8fBe938Lv3ZaSJoZk0Sfy8m30voXfuy0lTQzJok/k5dvofQu/d1soDY6UuBv7uzGUBgbMjN3dlpImhsyM3d2WkiaGzIzd3ZaSJobMjN3dlpImz3QEe7stLY0MmhE7u2mXNDOshX9cHv+8ZD2y71rY2U27pFmmmOPXA2R8Mm9+w+8X3LRbGkbFHL91gAx6R/i9Ww5J06iY4/0JZNE3wu8X3HJYGh8pGJU946vHghtOy4CjZa/GTl3GrzLo7iPYpev4VQbecQizh41fZfDII5g5fPwqC4jFz6C32G2YLNLCMXvQq4WdbpGlsmRHtrDDFLJkD8ycUpa+AjOeRg7Zg17/nP6LkaVSqVQqzalvmkQPjzeqlJ0AAAAASUVORK5CYII=";

const NANOS_PER_SEC: u64 = 1_000_000_000;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Balances,
    Streak,
    Participants,
    FaucetUsed,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub decimals: u8,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    total_supply: U128,
    balances: LookupMap<AccountId, U128>,
    metadata: FungibleTokenMetadata,
    // ----- game state -----
    round_number: u64,
    active: bool, // is a round currently running?
    round_deadline: u64, // block timestamp (ns) when the fuse blows
    round_pot: U128, // sum of BUY_INs this round
    global_pool: U128, // accumulated Winner Pool (held by contract)
    bomb_holder: Option<AccountId>,
    participants: Vector<AccountId>, // current round members
    streak: LookupMap<AccountId, u64>, // survives across rounds
    faucet_used: LookupSet<AccountId>,
    demo_mode: bool,
    // ----- economy config (owner-tunable, so we can retune post-deploy) -----
    buy_in: U128, // tokens required to enter a round
    treasury: AccountId, // receives the treasury cut
    treasury_cut_pct: u64, // percent of each pot sent to treasury
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut s = Self {
            owner: owner_id.clone(),
            total_supply,
            balances: LookupMap::new(StorageKey::Balances),
            metadata: FungibleTokenMetadata {
                spec: "ft-1.0.0".to_string(),
                name: "Kentang Panas".to_string(),
                symbol: "POTATO".to_string(),
                icon: Some(ICON.to_string()),
                decimals: 18,
            },
            round_number: 0,
            active: false,
            round_deadline: 0,
            round_pot: U128(0),
            global_pool: U128(0),
            bomb_holder: None,
            participants: Vector::new(StorageKey::Participants),
            streak: LookupMap::new(StorageKey::Streak),
            faucet_used: LookupSet::new(StorageKey::FaucetUsed),
            demo_mode: false,
            buy_in: U128(DEFAULT_BUY_IN),
            treasury: owner_id.clone(),
            treasury_cut_pct: DEFAULT_TREASURY_CUT_PCT,
        };
        // Mint the initial supply to the owner (they seed the economy / faucet).
        s.balances.insert(owner_id, total_supply);
        s
    }

    // ================= NEP-141 =================

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }

    pub fn ft_total_supply(&self) -> U128 {
        self.total_supply
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.get_balance(&account_id))
    }

    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let sender = env::predecessor_account_id();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires exactly 1 yoctoNEAR attached deposit"
        );
        self.internal_transfer(&sender, &receiver_id, amount.0, memo);
    }

    /// NEP-141 transfer-and-call: move tokens, then notify receiver.ft_on_transfer and
    /// refund the sender for whatever the receiver did not use (via ft_resolve_transfer).
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let sender = env::predecessor_account_id();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires exactly 1 yoctoNEAR attached deposit"
        );
        self.internal_transfer(&sender, &receiver_id, amount.0, memo);

        let on_transfer_args = near_sdk::serde_json::to_vec(&json!({
            "sender_id": sender,
            "amount": amount,
            "msg": msg,
        }))
        .expect("valid json");
        let resolve_args = near_sdk::serde_json::to_vec(&json!({
            "sender_id": sender,
            "receiver_id": receiver_id,
            "amount": amount,
        }))
        .expect("valid json");

        let call = Promise::new(receiver_id)
            .function_call("ft_on_transfer", on_transfer_args, NearToken::from_yoctonear(0), CALL_GAS)
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "ft_resolve_transfer",
                    resolve_args,
                    NearToken::from_yoctonear(0),
                    RESOLVE_GAS,
                ),
            );
        PromiseOrValue::Promise(call)
    }

    /// Internal callback (self only): compute used amount, refund the sender the rest.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let _ = &receiver_id;
        let total = amount.0;
        let used: u128 = match env::promise_result(0) {
            // Receiver returns the used amount as a JSON-encoded U128 (a decimal string).
            PromiseResult::Successful(value) => {
                near_sdk::serde_json::from_slice::<U128>(&value)
                    .map(|u| u.0)
                    .unwrap_or(0)
            }
            // Receiver failed / had no ft_on_transfer: treat everything as unused -> full refund.
            PromiseResult::Failed => 0,
        };
        let used = used.min(total);
        let refund = total - used;
        if refund > 0 {
            let bal = self.get_balance(&sender_id);
            self.set_balance(&sender_id, bal + refund);
        }
        env::log_str(
            &json!({
                "event": "ft_resolve_transfer",
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "used": U128(used),
                "refunded": U128(refund),
            })
            .to_string(),
        );
        U128(used)
    }

    // ================= NEP-141 Storage Management =================
    // Gameplay actions stay 0-deposit (so a scoped function-call key can drive play),
    // therefore registration is FREE: bounds are 0 and no NEAR is ever locked. Wallets
    // can still call storage_deposit / read storage_balance_of to list the token.

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(0), max: U128(0) }
    }

    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_cost: Option<U128>,
    ) -> StorageBalance {
        let acct = account_id.unwrap_or_else(env::predecessor_account_id);
        require!(
            registration_cost.map(|c| c.0).unwrap_or(0) == 0,
            "Registration for $POTATO is free (cost must be 0)"
        );
        if !self.balances.contains_key(&acct) {
            self.set_balance(&acct, 0); // create a zero entry to mark registration
        }
        StorageBalance { total: U128(0), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        if self.balances.contains_key(&account_id) {
            Some(StorageBalance { total: U128(0), available: U128(0) })
        } else {
            None
        }
    }

    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        let _ = amount; // nothing is locked under free registration
        StorageBalance { total: U128(0), available: U128(0) }
    }

    pub fn storage_unstake(&mut self, amount: Option<U128>) -> StorageBalance {
        let _ = amount;
        StorageBalance { total: U128(0), available: U128(0) }
    }

    fn internal_transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        amount: u128,
        memo: Option<String>,
    ) {
        require!(receiver != sender, "Cannot transfer tokens to yourself");
        require!(amount > 0, "Transfer amount must be positive");
        let from = self.get_balance(sender);
        require!(from >= amount, "Not enough balance to transfer");
        self.set_balance(sender, from - amount);
        let to = self.get_balance(receiver);
        self.set_balance(receiver, to + amount);
        env::log_str(
            &json!({
                "standard": "nep141",
                "version": "1.0.0",
                "event": "ft_transfer",
                "data": [{ "old_account_id": sender, "new_account_id": receiver, "old_amount": U128(from), "new_amount": U128(to + amount), "amount": U128(amount), "memo": memo }],
            })
            .to_string(),
        );
    }

    // ================= TESTNET faucet =================

    /// One-time drip so judges can actually play on testnet without a pre-funded wallet.
    pub fn faucet(&mut self) {
        let caller = env::predecessor_account_id();
        require!(
            !self.faucet_used.contains(&caller),
            "Faucet already claimed by this account"
        );
        self.faucet_used.insert(caller.clone());
        let cur = self.get_balance(&caller);
        self.set_balance(&caller, cur + FAUCET_AMOUNT);
        self.total_supply = U128(self.total_supply.0 + FAUCET_AMOUNT);
        env::log_str(
            &json!({ "event": "Faucet", "to": caller, "amount": U128(FAUCET_AMOUNT) }).to_string(),
        );
    }

    // ================= GAME: round lifecycle =================

    /// Opt into the current round. Pays BUY_IN into the pot. First joiner holds the bomb.
    /// If no round is active, this lazily starts one (so an idle game costs nobody).
    pub fn join_round(&mut self) {
        let caller = env::predecessor_account_id();
        require!(!self.is_participant(&caller), "Already in this round");
        let buy_in = self.buy_in.0;
        require!(
            self.get_balance(&caller) >= buy_in,
            "Not enough $POTATO for this round's buy-in (use faucet on testnet)"
        );
        if !self.active {
            self.start_round();
        }
        require!(self.participants.len() < MAX_PLAYERS, "Round is full");

        // Move the buy-in from the player's balance into the round pot.
        let bal = self.get_balance(&caller);
        self.set_balance(&caller, bal - buy_in);
        self.round_pot = U128(self.round_pot.0 + buy_in);
        self.participants.push(caller.clone());

        if self.bomb_holder.is_none() {
            self.bomb_holder = Some(caller.clone());
        }
        env::log_str(
            &json!({ "event": "JoinedRound", "account": caller, "round": self.round_number, "pot": self.round_pot })
                .to_string(),
        );
    }

    /// Hot-potato: pass the bomb to another participant. The fuse keeps burning.
    pub fn pass_bomb(&mut self, to: AccountId) {
        let caller = env::predecessor_account_id();
        require!(self.active, "No active round");
        require!(
            self.bomb_holder.as_ref() == Some(&caller),
            "Only the bomb holder can pass"
        );
        require!(to != caller, "Cannot pass to yourself");
        require!(self.is_participant(&to), "Target is not in this round");
        self.bomb_holder = Some(to.clone());
        env::log_str(
            &json!({ "event": "BombPassed", "from": caller, "to": to }).to_string(),
        );
    }

    /// Defuse: holder surrenders their BUY_IN to end the round early; survivors split the pot.
    pub fn defuse(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.active, "No active round");
        require!(
            self.bomb_holder.as_ref() == Some(&caller),
            "Only the bomb holder can defuse"
        );
        env::log_str(&json!({ "event": "BombDefused", "by": caller }).to_string());
        self.end_round(false);
    }

    /// Anyone may call this once the fuse expires. The current holder loses their BUY_IN.
    pub fn finalize_round(&mut self) {
        require!(self.active, "No active round");
        require!(
            env::block_timestamp() >= self.round_deadline,
            "Round is not over yet"
        );
        self.end_round(true);
    }

    /// Claim your share of the global Winner Pool once your streak is long enough.
    pub fn claim_streak(&mut self) {
        let caller = env::predecessor_account_id();
        let s = self.get_streak(&caller);
        require!(s >= SURVIVE_STREAK, "Streak too short to claim");
        require!(self.global_pool.0 > 0, "Winner Pool is empty");
        let grant = self.global_pool.0 * CLAIM_GRANT_PCT / 100;
        self.global_pool = U128(self.global_pool.0 - grant);
        let cur = self.get_balance(&caller);
        self.set_balance(&caller, cur + grant);
        self.streak.insert(caller.clone(), 0); // reset after claim
        env::log_str(
            &json!({ "event": "StreakClaimed", "by": caller, "amount": U128(grant), "pool_left": self.global_pool })
                .to_string(),
        );
    }

    // ================= ADMIN / DEMO =================

    /// Toggle the fast 15s demo fuse so judges can watch multiple explosions quickly.
    pub fn set_demo_mode(&mut self, on: bool) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only owner can toggle demo mode"
        );
        self.demo_mode = on;
    }

    /// Owner can top up the faucet for extra testnet demoing (mints to caller pool owner).
    pub fn owner_mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only owner can mint"
        );
        let cur = self.get_balance(&account_id);
        self.set_balance(&account_id, cur + amount.0);
        self.total_supply = U128(self.total_supply.0 + amount.0);
    }

    /// Owner: change the round buy-in (whole-token units, 18 decimals).
    pub fn set_buy_in(&mut self, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        require!(amount.0 > 0, "Buy-in must be positive");
        self.buy_in = amount;
    }

    /// Owner: move the treasury account that receives the project cut.
    pub fn set_treasury(&mut self, treasury: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        self.treasury = treasury;
    }

    /// Owner: change the treasury cut (percent of each pot, capped at 20%).
    pub fn set_treasury_cut(&mut self, pct: u64) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        require!(pct <= 20, "Treasury cut too high");
        self.treasury_cut_pct = pct;
    }

    // ================= VIEWS =================

    pub fn get_game_state(&self) -> GameState {
        let participants: Vec<PlayerInfo> = self
            .participants
            .iter()
            .map(|p| PlayerInfo {
                account_id: p.clone(),
                balance: U128(self.get_balance(p)),
                streak: self.get_streak(p),
                holding: self.bomb_holder.as_ref() == Some(p),
            })
            .collect();
        GameState {
            round_number: self.round_number,
            active: self.active,
            demo_mode: self.demo_mode,
            bomb_holder: self.bomb_holder.clone(),
            round_deadline: self.round_deadline,
            seconds_left: self.seconds_left(),
            round_seconds: self.round_seconds(),
            round_pot: self.round_pot,
            global_pool: self.global_pool,
            buy_in: self.buy_in,
            participants,
        }
    }

    pub fn get_rules(&self) -> Rules {
        Rules {
            buy_in: self.buy_in,
            faucet_amount: U128(FAUCET_AMOUNT),
            round_seconds: self.round_seconds(),
            normal_round_seconds: ROUND_SECONDS,
            demo_round_seconds: DEMO_ROUND_SECONDS,
            global_cut_pct: GLOBAL_CUT_PCT as u64,
            survive_streak: SURVIVE_STREAK,
            claim_grant_pct: CLAIM_GRANT_PCT as u64,
            max_players: MAX_PLAYERS as u64,
            treasury: self.treasury.clone(),
            treasury_cut_pct: self.treasury_cut_pct,
        }
    }

    pub fn is_player(&self, account_id: AccountId) -> bool {
        self.is_participant(&account_id)
    }
}

// ----- internal helpers (not part of the ABI) -----
impl Contract {
    fn balance_raw(&self, a: &AccountId) -> u128 {
        self.balances.get(a).map(|v| v.0).unwrap_or(0)
    }

    fn get_balance(&self, a: &AccountId) -> u128 {
        self.balance_raw(a)
    }

    fn set_balance(&mut self, a: &AccountId, v: u128) {
        self.balances.insert(a.clone(), U128(v));
    }

    fn get_streak(&self, a: &AccountId) -> u64 {
        self.streak.get(a).copied().unwrap_or(0)
    }

    fn is_participant(&self, a: &AccountId) -> bool {
        self.participants.iter().any(|x| x == a)
    }

    fn round_seconds(&self) -> u64 {
        if self.demo_mode {
            DEMO_ROUND_SECONDS
        } else {
            ROUND_SECONDS
        }
    }

    fn seconds_left(&self) -> u64 {
        let now = env::block_timestamp();
        if !self.active || now >= self.round_deadline {
            0
        } else {
            (self.round_deadline - now) / NANOS_PER_SEC
        }
    }

    fn start_round(&mut self) {
        self.round_number += 1;
        self.participants.clear();
        self.round_pot = U128(0);
        self.bomb_holder = None;
        self.active = true;
        self.round_deadline = env::block_timestamp() + self.round_seconds() * NANOS_PER_SEC;
        env::log_str(
            &json!({ "event": "NewRound", "round": self.round_number, "seconds": self.round_seconds(), "deadline": self.round_deadline })
                .to_string(),
        );
    }

    /// Close the round: loser = current holder. Their BUY_IN funds the survivors.
    fn end_round(&mut self, exploded: bool) {
        let loser = match self.bomb_holder.clone() {
            Some(l) => l,
            None => {
                // Defensive: no holder but a pot exists -> don't strand tokens.
                let orphan = self.round_pot.0;
                self.round_pot = U128(0);
                self.global_pool = U128(self.global_pool.0 + orphan);
                self.reset_round();
                return;
            }
        };

        let mut pot = self.round_pot.0;
        self.round_pot = U128(0);

        // Treasury (project) cut comes off the top, then the Winner Pool global cut.
        let tcut = pot * self.treasury_cut_pct as u128 / 100;
        if tcut > 0 {
            let tr = self.treasury.clone();
            let tb = self.get_balance(&tr);
            self.set_balance(&tr, tb + tcut);
            pot -= tcut;
            env::log_str(
                &json!({ "event": "Treasury", "to": tr, "amount": U128(tcut) }).to_string(),
            );
        }

        // Small global cut feeds the Winner Pool.
        let cut = pot * GLOBAL_CUT_PCT / 100;
        self.global_pool = U128(self.global_pool.0 + cut);
        pot -= cut;

        let survivors: Vec<AccountId> = self
            .participants
            .iter()
            .filter(|p| *p != &loser)
            .cloned()
            .collect();

        if survivors.is_empty() {
            // Solo holder: nobody to pay, pot rolls into the global pool.
            self.global_pool = U128(self.global_pool.0 + pot);
        } else {
            let n = survivors.len() as u128;
            let share = pot / n;
            let rem = pot - share * n;
            self.global_pool = U128(self.global_pool.0 + rem);
            for s in survivors {
                let b = self.get_balance(&s);
                self.set_balance(&s, b + share);
                let st = self.get_streak(&s) + 1;
                self.streak.insert(s, st);
            }
        }

        // Loser's streak resets (their BUY_IN is already gone into the pot).
        self.streak.insert(loser.clone(), 0);

        let survivors_count = self.participants.iter().filter(|p| *p != &loser).count() as u64;
        env::log_str(
            &json!({
                "event": if exploded { "BombExploded" } else { "RoundClosed" },
                "victim": loser,
                "survivors": survivors_count,
                "distributed": U128(pot),
                "global_pool": self.global_pool,
            })
            .to_string(),
        );

        self.reset_round();
    }

    fn reset_round(&mut self) {
        self.bomb_holder = None;
        self.participants.clear();
        self.active = false;
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct GameState {
    pub round_number: u64,
    pub active: bool,
    pub demo_mode: bool,
    pub bomb_holder: Option<AccountId>,
    pub round_deadline: u64,
    pub seconds_left: u64,
    pub round_seconds: u64,
    pub round_pot: U128,
    pub global_pool: U128,
    pub buy_in: U128,
    pub participants: Vec<PlayerInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct PlayerInfo {
    pub account_id: AccountId,
    pub balance: U128,
    pub streak: u64,
    pub holding: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Rules {
    pub buy_in: U128,
    pub faucet_amount: U128,
    pub round_seconds: u64,
    pub normal_round_seconds: u64,
    pub demo_round_seconds: u64,
    pub global_cut_pct: u64,
    pub survive_streak: u64,
    pub claim_grant_pct: u64,
    pub max_players: u64,
    pub treasury: AccountId,
    pub treasury_cut_pct: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: U128,
}

// ----- tests -----
// Host unit tests require near-sdk's `unit-testing` feature, which pulls heavy
// crypto deps (aws-lc-sys -> NASM) that are awkward on Windows. Game mechanics are
// validated via testnet deployment + the frontend demo instead. See README.
