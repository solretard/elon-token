const xrpl = require("xrpl");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Your token details
  CURRENCY: "ELON",          // Max 3 chars OR 20-byte hex. Use hex for longer names
  TOTAL_SUPPLY: "1000",      // 1000 tokens total supply
  AMM_TOKEN_AMOUNT: "500",   // 500 ELON in AMM pool (50%)
  AMM_XRP_AMOUNT: "1",       // 1 XRP liquidity (test launch)
  AMM_TRADING_FEE: 500,      // 0.5% trading fee (in units of 1/100000)

  // Your domain for metadata (set up TOML file here)
  DOMAIN: "elonxrpl.surge.sh",  // surge domain for metadata

  // Network
  NODE: "wss://s1.ripple.com",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function currencyToHex(currency) {
  if (currency.length <= 3) return currency; // short currency code
  // Convert to hex for longer names
  let hex = "";
  for (let i = 0; i < currency.length; i++) {
    hex += currency.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.toUpperCase().padEnd(40, "0");
}

function domainToHex(domain) {
  return Buffer.from(domain).toString("hex").toUpperCase();
}

// ─── MAIN LAUNCH FLOW ─────────────────────────────────────────────────────────
async function launchToken() {
  const client = new xrpl.Client(CONFIG.NODE);
  await client.connect();
  console.log("✅ Connected to XRPL");

  // ── STEP 1: Generate CA wallet ──
  const caWallet = xrpl.Wallet.generate();
  console.log("\n📋 CA WALLET GENERATED — SAVE THESE:");
  console.log(`   Address: ${caWallet.address}`);
  console.log(`   Seed:    ${caWallet.seed}`);
  const minXRP = parseInt(CONFIG.AMM_XRP_AMOUNT) + 3;
  console.log(`\n⚠️  Fund this wallet with at least ${minXRP} XRP before continuing`);
  console.log("   Then press Enter to continue...");

  await new Promise(resolve => process.stdin.once("data", resolve));

  // Check balance
  const info = await client.request({ command: "account_info", account: caWallet.address, ledger_index: "validated" });
  const balance = parseFloat(xrpl.dropsToXrp(info.result.account_data.Balance));
  console.log(`\n💰 Balance: ${balance} XRP`);
  if (balance < parseInt(CONFIG.AMM_XRP_AMOUNT) + 3) {
    throw new Error(`Not enough XRP. Need at least ${parseInt(CONFIG.AMM_XRP_AMOUNT) + 3} XRP`);
  }

  const currency = currencyToHex(CONFIG.CURRENCY);

  // ── STEP 2: Set domain metadata ──
  console.log("\n📡 Setting domain metadata...");
  const domainTx = {
    TransactionType: "AccountSet",
    Account: caWallet.address,
    Domain: domainToHex(CONFIG.DOMAIN),
    SetFlag: 8, // asfDefaultRipple — needed for token issuance
  };
  const domainPrepared = await client.autofill(domainTx);
  const domainSigned = caWallet.sign(domainPrepared);
  const domainResult = await client.submitAndWait(domainSigned.tx_blob);
  console.log(`✅ Domain set: ${domainResult.result.meta.TransactionResult}`);

  // ── STEP 3: Issue tokens (TrustSet from CA to itself isn't needed — just create AMM directly) ──
  // On XRPL, tokens are created when included in AMMCreate — no separate minting step needed

  // ── STEP 4: Create AMM pool ──
  console.log("\n🌊 Creating AMM pool...");
  const ammTx = {
    TransactionType: "AMMCreate",
    Account: caWallet.address,
    Amount: {
      currency,
      issuer: caWallet.address,
      value: CONFIG.AMM_TOKEN_AMOUNT,
    },
    Amount2: xrpl.xrpToDrops(CONFIG.AMM_XRP_AMOUNT),
    TradingFee: CONFIG.AMM_TRADING_FEE,
  };
  const ammPrepared = await client.autofill(ammTx);
  const ammSigned = caWallet.sign(ammPrepared);
  const ammResult = await client.submitAndWait(ammSigned.tx_blob);
  console.log(`✅ AMM created: ${ammResult.result.meta.TransactionResult}`);

  // Get AMM info
  const ammInfo = await client.request({
    command: "amm_info",
    asset: { currency: "XRP" },
    asset2: { currency, issuer: caWallet.address },
  });
  const amm = ammInfo.result.amm;
  console.log(`\n🎉 TOKEN LAUNCHED!`);
  console.log(`   CA:       ${caWallet.address}`);
  console.log(`   Currency: ${CONFIG.CURRENCY} (${currency})`);
  console.log(`   AMM Pool: ${xrpl.dropsToXrp(amm.amount)} XRP + ${amm.amount2.value} ${CONFIG.CURRENCY}`);
  console.log(`   AMM Acct: ${amm.account}`);

  console.log("\n📋 FIRST LEDGER TOML (host this at your domain):");
  console.log(`
[[CURRENCIES]]
code = "${CONFIG.CURRENCY}"
issuer = "${caWallet.address}"
display_decimals = 6
name = "Your Token Name"
desc = "Your token description"
image = "https://${CONFIG.DOMAIN}/logo.png"
  `);

  console.log("\n⏸️  Token is live. Press Enter when ready to BLACKHOLE (lock the CA permanently)...");
  console.log("   (You can exit now and blackhole later using blackhole.js)");

  await new Promise(resolve => process.stdin.once("data", resolve));

  // ── STEP 5: Blackhole the CA ──
  await blackholeCA(client, caWallet);

  await client.disconnect();
}

// ─── BLACKHOLE FUNCTION (can be run separately) ───────────────────────────────
async function blackholeCA(client, wallet) {
  console.log("\n🔒 Blackholing CA...");

  const BLACKHOLE_ADDRESS = "rrrrrrrrrrrrrrrrrrrrBZbvji";

  // Set regular key to null address
  const setKeyTx = {
    TransactionType: "SetRegularKey",
    Account: wallet.address,
    RegularKey: BLACKHOLE_ADDRESS,
  };
  const setKeyPrepared = await client.autofill(setKeyTx);
  const setKeySigned = wallet.sign(setKeyPrepared);
  const setKeyResult = await client.submitAndWait(setKeySigned.tx_blob);
  console.log(`✅ Regular key set to null: ${setKeyResult.result.meta.TransactionResult}`);

  // Disable master key
  const disableTx = {
    TransactionType: "AccountSet",
    Account: wallet.address,
    SetFlag: 4, // asfDisableMaster
  };
  const disablePrepared = await client.autofill(disableTx);
  const disableSigned = wallet.sign(disablePrepared);
  const disableResult = await client.submitAndWait(disableSigned.tx_blob);
  console.log(`✅ Master key disabled: ${disableResult.result.meta.TransactionResult}`);

  console.log("\n🔒 CA IS NOW BLACKHOLED — nobody can ever touch this wallet again");
  console.log("   First Ledger will now show: Blackholed: Yes");
}

// ─── WITHDRAW LIQUIDITY (if token fails) ──────────────────────────────────────
async function withdrawLiquidity(caAddress, caSeed, currency) {
  const client = new xrpl.Client(CONFIG.NODE);
  await client.connect();

  const wallet = xrpl.Wallet.fromSeed(caSeed);

  // Get AMM info to find LP token balance
  const ammInfo = await client.request({
    command: "amm_info",
    asset: { currency: "XRP" },
    asset2: { currency: currencyToHex(currency), issuer: caAddress },
  });

  const lpToken = ammInfo.result.amm.lp_token;
  console.log(`LP Token balance: ${lpToken.value} ${lpToken.currency}`);

  // Withdraw all liquidity
  const withdrawTx = {
    TransactionType: "AMMWithdraw",
    Account: wallet.address,
    Asset: { currency: "XRP" },
    Asset2: { currency: currencyToHex(currency), issuer: caAddress },
    LPTokenIn: lpToken, // withdraw all LP tokens
    Flags: 0x00010000, // tfLPToken
  };

  const prepared = await client.autofill(withdrawTx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  console.log(`✅ Liquidity withdrawn: ${result.result.meta.TransactionResult}`);

  await client.disconnect();
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
launchToken().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});

// Export for separate use
module.exports = { blackholeCA, withdrawLiquidity };