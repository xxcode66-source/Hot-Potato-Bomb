// Deploy $POTATO contract to NEAR testnet using a TEMPORARY full-access key.
//
// Usage (PowerShell, from web/):
//   node deploy.mjs
//
// Credentials come from env vars, or from gitignored local files:
//   $env:DEPLOY_ACCOUNT_ID   = "alice.testnet"
//   $env:DEPLOY_SECRET_KEY   = "ed25519:..."      # throwaway key, revoke after!
// or files: .deploy_account_id  /  .deploy_key   (both gitignored)
//
// Steps: connect -> deploy wasm -> call new(owner_id, total_supply) -> verify ft_metadata.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair } from "near-api-js";

const HOME = process.env.HOME || process.env.USERPROFILE; // keychain fallback dir

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NETWORK_ID = "testnet";
// Official rpc.testnet.near.org is rate-limiting (429); use a working provider with fallback.
const RPCS = ["https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
const NODE_URL = RPCS[0];
const EXPLORER = "https://testnet.nearblocks.io";

// 1 billion $POTATO with 18 decimals = 1e9 * 1e18 = 1e27 (string to keep exactness).
const TOTAL_SUPPLY = "1000000000000000000000000000";

const WASM_PATH = path.resolve(
  __dirname,
  "../contract/target/wasm32-unknown-unknown/release/potato.wasm"
);

function readSecret(name, file) {
  if (process.env[name]) return process.env[name].trim();
  const p = path.resolve(__dirname, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return null;
}

const accountId = readSecret("DEPLOY_ACCOUNT_ID", ".deploy_account_id");
let secretKey = readSecret("DEPLOY_SECRET_KEY", ".deploy_key");

// Fallback: an existing near-cli keychain entry, e.g. ~/.near-credentials/testnet/<acct>.json
// (nothing gets copied anywhere; we just read the file the login flow already made).
if (accountId && !secretKey) {
  const cred = path.join(HOME || "", ".near-credentials", NETWORK_ID, `${accountId}.json`);
  if (fs.existsSync(cred)) {
    secretKey = fs.readFileSync(cred, "utf8").trim();
    console.log(`Using keychain credential: ${cred}`);
  }
}

if (!accountId || !secretKey) {
  console.error(
    [
      "MISSING CREDENTIALS.",
      "Set env DEPLOY_ACCOUNT_ID + DEPLOY_SECRET_KEY, or create local files",
      "web/.deploy_account_id and web/.deploy_key (both are gitignored).",
      "",
      "SAFETY: use a THROWAWAY full-access key you added to your testnet account,",
      "never your main key, and NEVER paste it into chat. Revoke it after deploy.",
    ].join("\n")
  );
  process.exit(1);
}

if (!accountId.endsWith(".testnet")) {
  console.error(`Account "${accountId}" is not a .testnet account. Aborting.`);
  process.exit(1);
}
if (!fs.existsSync(WASM_PATH)) {
  console.error(`Wasm not found at ${WASM_PATH}. Build it first:\n  cd ../contract && cargo build --target wasm32-unknown-unknown --release`);
  process.exit(1);
}

// Parse the key locally; print only the PUBLIC half so nothing secret leaves the terminal.
let keyPair;
let keySource = "env/file";
if (secretKey.startsWith("{")) {
  // ~/.near-credentials style JSON: {"account_id": "...", "private_key": "ed25519:..."}
  const j = JSON.parse(secretKey);
  keyPair = KeyPair.fromString(j.private_key);
  keySource = `keystore json (${j.account_id || "account_id field"})`;
} else {
  keyPair = KeyPair.fromString(secretKey); // raw "ed25519:..." / " Curve25519:..."
}
console.log(`Account:  ${accountId}`);
console.log(`Key from: ${keySource}`);
console.log(`Network:  ${NETWORK_ID}`);
console.log(`Pubkey:   ${keyPair.getPublicKey().toString()}`);
console.log(`Wasm:     ${path.relative(__dirname, WASM_PATH)} (${fs.statSync(WASM_PATH).size} bytes)`);

const keyStore = new keyStores.InMemoryKeyStore();
keyStore.setKey(NETWORK_ID, accountId, keyPair);

const near = await connect({
  networkId: NETWORK_ID,
  nodeUrl: NODE_URL, // single provider (drpc); near-api-js v4 connect does not take an array here
  keyStore,
});

const account = await near.account(accountId);

const balance = await account.getAccountBalance(); // { total, stateStaked, staked, available } in yocto
const totalNear = Number(BigInt(balance.total)) / 1e24;
console.log(`Balance:  ${totalNear} NEAR (total)`);
if (BigInt(balance.available) < 100000000000000000000000n) {
  console.warn("⚠ Under ~0.1 NEAR available — deploy+init may run out of gas. Use the testnet faucet first.");
}

console.log("\n[1/4] Deploying contract wasm...");
await account.deployContract(fs.readFileSync(WASM_PATH));
console.log("      ok");

console.log("[2/4] Initializing contract (new)...");
try {
  await account.functionCall({
    contractId: accountId,
    methodName: "new",
    args: { owner_id: accountId, total_supply: TOTAL_SUPPLY },
    gas: "100000000000000", // 100 TGas
  });
  console.log("      ok");
} catch (e) {
  // Safe re-run: if already initialized, keep going and just re-verify.
  console.log("      skipped/already-initialized:", String(e).slice(0, 120));
}

console.log("[3/4] Verifying ft_metadata (view)...");
const meta = await view(accountId, "ft_metadata");
console.log(`      name="${meta.name}" symbol=${meta.symbol} decimals=${meta.decimals} icon=${meta.icon ? "yes" : "no"}`);

console.log("[4/4] Verifying game state (view)...");
const rules = await view(accountId, "get_rules");
console.log(`      buy_in=${BigInt(rules.buy_in)/10n**18n} TREASURY_CUT=${rules.treasury_cut_pct}% GLOBAL_CUT=${rules.global_cut_pct}% streak=${rules.survive_streak} faucet=${BigInt(rules.faucet_amount ?? 0)/10n**18n}`);

async function view(contractId, method, args = {}) {
  let lastErr = null;
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "deploy-verify",
          method: "query",
          params: {
            request_type: "call_function",
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
            finality: "optimistic",
          },
        }),
      }).then((r) => r.json());
      if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
      // RPC returns the result as an array of byte values (older) or base64 string (newer).
      const raw = res.result.result;
      const bytes = Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(raw, "base64");
      return JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      lastErr = e; // try next provider
    }
  }
  throw lastErr;
}

console.log("\nDEPLOYED ✅");
console.log(`  Contract account : ${accountId}`);
console.log(`  Explorer         : ${EXPLORER}/accounts/${accountId}`);
console.log(`  Set this in Vercel env:  VITE_CONTRACT_ID=${accountId}`);
console.log(`  Then REVOKE the temporary key: ${keyPair.getPublicKey().toString()}`);
