// Generate a THROWAWAY full-access keypair and print the wallet authorize URL.
// The private key is written ONLY to a local gitignored file (never to chat).
// After you authorize in the wallet, run:  node deploy.mjs
//
// Usage: node genkey.mjs [account.testnet]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = (process.argv[2] || "potatohot.testnet").trim();

if (!accountId.endsWith(".testnet")) {
  console.error(`Refusing: "${accountId}" is not a .testnet account.`);
  process.exit(1);
}

const keyPair = KeyPair.fromRandom("ed25519");
const publicKey = keyPair.getPublicKey().toString();
const secret = keyPair.toString(); // full "ed25519:<secret>" — stays local only

const keyFile = path.resolve(__dirname, ".deploy_key");
const accFile = path.resolve(__dirname, ".deploy_account_id");
fs.writeFileSync(keyFile, secret, { mode: 0o600 });
fs.writeFileSync(accFile, accountId);

console.log(`Account   : ${accountId}`);
console.log(`Public key: ${publicKey}`);
console.log(`Secret -> saved locally at: ${keyFile} (gitignored). NOT printed. NOT sent anywhere.`);
console.log("\n--- STEP: authorize this key in your wallet ---");
console.log("Open this URL, sign in as " + accountId + ", then click Authorize (Full Access):");
console.log();
console.log(
  "https://testnet.mynearwallet.com/login/?referrer=Hot%20Potato%20Bomb&public_key=" +
    encodeURIComponent(publicKey)
);
console.log();
console.log("When it shows success, come back here and say 'done', then we run: node deploy.mjs");
