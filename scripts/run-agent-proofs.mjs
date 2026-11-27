import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import * as sdk from "file:///e:/ai赚钱/projects/qorechain-quantum-pass/node_modules/@qorechain/sdk/dist/index.js";

const require = createRequire("e:/ai赚钱/projects/qorechain-quantum-pass/package.json");
const { StargateClient } = require("@cosmjs/stargate");

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EVM_RPC = "https://evm-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";

const TESTNET_WALLET_PATH = "e:/ai赚钱/.secrets/qorechain-testnet.json";
const AGENT_KEY_PATH = "e:/ai赚钱/.secrets/qorechain-agent-ed25519.json";
const OUTPUT_PATH = "e:/ai赚钱/projects/qorechain-pqc-treasury-agent/proof-output.json";

const customFetch = (url, init) =>
  fetch(url, {
    ...init,
    headers: {
      "User-Agent": "Mozilla/5.0",
      ...(init?.headers ?? {}),
    },
  });

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return "0x" + Buffer.from(v).toString("hex");
      return v;
    })
  );
}

function loadOrCreateAgentEd25519() {
  if (fs.existsSync(AGENT_KEY_PATH)) {
    const saved = JSON.parse(fs.readFileSync(AGENT_KEY_PATH, "utf8"));
    const seed = Buffer.from(saved.privateKeyHex, "hex");
    const pub = Buffer.from(saved.pubkeyHex, "hex");
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privateKeyObj = crypto.createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, seed]),
      format: "der",
      type: "pkcs8",
    });
    return {
      reused: true,
      seed: new Uint8Array(seed),
      pubkey: new Uint8Array(pub),
      pubkeyHex: saved.pubkeyHex,
      privateKeyObj,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const pubBytes = new Uint8Array(spki.subarray(spki.length - 32));
  const seedBytes = new Uint8Array(pkcs8.subarray(pkcs8.length - 32));
  const pubkeyHex = Buffer.from(pubBytes).toString("hex");
  const privateKeyHex = Buffer.from(seedBytes).toString("hex");

  fs.mkdirSync(path.dirname(AGENT_KEY_PATH), { recursive: true });
  fs.writeFileSync(
    AGENT_KEY_PATH,
    JSON.stringify(
      {
        scheme: "ed25519",
        pubkeyHex,
        privateKeyHex,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return {
    reused: false,
    seed: seedBytes,
    pubkey: pubBytes,
    pubkeyHex,
    privateKeyObj: privateKey,
  };
}

async function getAuth(address) {
  const res = await customFetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) {
    throw new Error(`Auth query failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const baseAcct = json.account?.base_account ?? json.account;
  return {
    accountNumber: BigInt(baseAcct.account_number ?? 0),
    sequence: BigInt(baseAcct.sequence ?? 0),
  };
}

async function evmRpc(method, params = []) {
  const res = await customFetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`${method} RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function main() {
  const wallet = JSON.parse(fs.readFileSync(TESTNET_WALLET_PATH, "utf8"));
  const acct = await sdk.deriveUnifiedAccount(wallet.mnemonic);
  if (acct.cosmos !== wallet.qor) {
    throw new Error(`Address mismatch: ${acct.cosmos} !== ${wallet.qor}`);
  }
  const account = acct.cosmos;
  const ethAddress = acct.evm ?? acct.ethAddress ?? wallet.evm;
  const svmAddress = acct.svm ?? acct.svmAddress ?? wallet.svm;

  const agentKey = loadOrCreateAgentEd25519();
  const transport = await StargateClient.connect(RPC);
  const hybridSigner = new sdk.EthNativeSigner(acct, {
    signMode: "hybrid",
    rest: REST,
    fetch: customFetch,
  });

  const output = {
    network: CHAIN_ID,
    rest: REST,
    rpc: RPC,
    evmRpc: EVM_RPC,
    executedAt: new Date().toISOString(),
    vaultAccount: {
      qorAddress: acct.cosmos,
      ethAddress,
      svmAddress,
    },
    agentAuthenticator: {
      scheme: "ed25519",
      pubkeyHex: agentKey.pubkeyHex,
      label: "qoreagent-treasury-bot-v1",
      keyReused: agentKey.reused,
    },
    steps: {},
  };

  try {
    // Step 4a: Possession proof
    const linkProof = sdk.signAuthenticatorLinkEd25519({
      chainId: CHAIN_ID,
      account,
      privateKey: agentKey.seed,
    });
    const verifiedLocally = sdk.verifyAuthenticatorLinkProof({
      chainId: CHAIN_ID,
      account,
      scheme: "ed25519",
      pubkey: linkProof.pubkey,
      possessionProof: linkProof.possessionProof,
    });
    if (!verifiedLocally) {
      throw new Error("Local verifyAuthenticatorLinkProof returned false");
    }
    output.steps.possessionProof = {
      verifiedLocally,
      pubkeyHex: Buffer.from(linkProof.pubkey).toString("hex"),
      proofLengthBytes: linkProof.possessionProof.length,
    };
    console.log("STEP_4A_OK:", JSON.stringify(output.steps.possessionProof));

    // Step 4b: Link authenticator + spending rules
    const expiryUnix = Math.floor(Date.now() / 1000) + 30 * 86400;
    const spendingRule = {
      id: "treasury-cap-v1",
      enabled: true,
      perTxLimit: "100000",
      dailyLimit: "500000",
      allowedDenoms: ["uqor"],
      allowedEvmCalls: [],
      denomLimits: [
        {
          denom: "uqor",
          perTxLimit: "100000",
          dailyLimit: "500000",
        },
      ],
    };

    let existingAuths = [];
    try {
      existingAuths = await sdk.fetchAuthenticators({
        rest: REST,
        address: account,
        fetch: customFetch,
      });
    } catch (err) {
      if (!String(err?.message ?? err).includes("404")) throw err;
    }
    const alreadyLinked = existingAuths.some(
      (a) =>
        a.scheme === "ed25519" &&
        a.pubkeyHex.toLowerCase().replace(/^0x/, "") === agentKey.pubkeyHex.toLowerCase() &&
        !a.revoked
    );

    if (alreadyLinked) {
      output.steps.linkAuthenticator = {
        status: "already_registered",
        txHash: "182EBAC89CC20804931EC1B786FD00264BAE36FB55987305C921C80CBA39B1EA",
        height: 10818158,
        existingAuthenticatorsCount: existingAuths.length,
      };
      console.log("STEP_4B_ALREADY_LINKED");
    } else {
      const msgs = sdk.linkAuthenticatorMsgs({
        owner: account,
        account,
        chainId: CHAIN_ID,
        scheme: "ed25519",
        pubkey: linkProof.pubkey,
        permissions: ["send", "evm"],
        expiryUnix,
        label: "qoreagent-treasury-bot-v1",
        possessionProof: linkProof.possessionProof,
        spendingRule,
      });
      const auth4b = await getAuth(account);
      const res4b = await hybridSigner.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        accountNumber: auth4b.accountNumber,
        sequence: auth4b.sequence,
        messages: msgs,
        fee: { amount: [{ denom: "uqor", amount: "80000" }], gas: "800000" },
        memo: "qoreagent-vault:link-authenticator",
      });
      output.steps.linkAuthenticator = {
        status: res4b.code === 0 ? "confirmed" : "failed",
        txHash: res4b.transactionHash,
        height: res4b.height,
        code: res4b.code,
        rawLog: res4b.code !== 0 ? res4b.rawLog : undefined,
        permissions: ["send", "evm"],
        expiryUnix,
        spendingRule,
      };
      console.log("STEP_4B_TX:", JSON.stringify(jsonSafe(output.steps.linkAuthenticator)));
      if (res4b.code !== 0) {
        throw new Error(`Step 4b failed with code ${res4b.code}: ${res4b.rawLog}`);
      }
    }

    // Step 4c: Open EVM Window (or reuse if already live)
    const preWindow = await sdk.fetchEvmWindow({
      rest: REST,
      address: account,
      fetch: customFetch,
    });
    if (preWindow.found && preWindow.live) {
      output.steps.openEvmWindow = {
        status: "already_live",
        txHash: "7578AB067A0224531D9C66A372309B387BEB8CF6BE7B5B120044F166F1350B05",
        height: 10818171,
        liveWindow: preWindow,
      };
      console.log("STEP_4C_ALREADY_LIVE");
    } else {
      const openWinMsg = sdk.openEvmWindowMsg({
        sender: account,
        blocks: 600,
        maxTxs: 5,
        maxValue: "500000",
        allowedTargets: [ethAddress],
      });
      const auth4c = await getAuth(account);
      const res4c = await hybridSigner.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        accountNumber: auth4c.accountNumber,
        sequence: auth4c.sequence,
        messages: [openWinMsg],
        fee: { amount: [{ denom: "uqor", amount: "50000" }], gas: "500000" },
        memo: "qoreagent-vault:open-evm-window",
      });
      const liveWindow4c = await sdk.fetchEvmWindow({
        rest: REST,
        address: account,
        fetch: customFetch,
      });
      output.steps.openEvmWindow = {
        status: res4c.code === 0 ? "confirmed" : "failed",
        txHash: res4c.transactionHash,
        height: res4c.height,
        code: res4c.code,
        liveWindow: liveWindow4c,
      };
      console.log("STEP_4C_TX:", JSON.stringify(jsonSafe(output.steps.openEvmWindow)));
      if (res4c.code !== 0) {
        throw new Error(`Step 4c failed with code ${res4c.code}: ${res4c.rawLog}`);
      }
    }

    const treasuryRecipient = sdk.bytesToBech32(
      new Uint8Array(crypto.createHash("sha256").update("qoreagent-treasury-sink-v1").digest().subarray(0, 20)),
      "qor"
    );

    // Step 4d: Execute Cosmos via Ed25519 Agent (10 uqor, within cap)
    const authsBefore4d = await sdk.fetchAuthenticators({
      rest: REST,
      address: account,
      fetch: customFetch,
    });
    const nonceBefore4d = await sdk.fetchAuthNonce({
      rest: REST,
      address: account,
      pubkey: linkProof.pubkey,
      fetch: customFetch,
    });
    const signBytes4d = sdk.cosmosAuthSignBytes({
      chainId: CHAIN_ID,
      account,
      pubkey: linkProof.pubkey,
      to: treasuryRecipient,
      amount: "10uqor",
      nonce: nonceBefore4d.nonce,
    });
    const sig4d = new Uint8Array(crypto.sign(null, signBytes4d, agentKey.privateKeyObj));
    const execMsg4d = sdk.executeCosmosMsg({
      relayer: account,
      account,
      scheme: "ed25519",
      pubkey: linkProof.pubkey,
      signature: sig4d,
      to: treasuryRecipient,
      amount: "10uqor",
      nonce: nonceBefore4d.nonce,
    });
    const auth4d = await getAuth(account);
    const res4d = await hybridSigner.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber: auth4d.accountNumber,
      sequence: auth4d.sequence,
      messages: [execMsg4d],
      fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "600000" },
      memo: "qoreagent-vault:agent-exec-10uqor",
    });
    const decoded4d = sdk.assertAuthenticatorExecutionsSucceeded(res4d, [execMsg4d]);
    output.steps.agentExecuteWithinCap = {
      txHash: res4d.transactionHash,
      height: res4d.height,
      code: res4d.code,
      nonceUsed: nonceBefore4d.nonce,
      to: treasuryRecipient,
      amount: "10uqor",
      authenticatorsQueried: authsBefore4d.length,
      executionResults: decoded4d,
    };
    console.log("STEP_4D_TX:", JSON.stringify(jsonSafe(output.steps.agentExecuteWithinCap)));

    // Step 4e: Test spending-rule cap enforcement on-chain (200000uqor > 100000 perTxLimit)
    const nonceBefore4e = await sdk.fetchAuthNonce({
      rest: REST,
      address: account,
      pubkey: linkProof.pubkey,
      fetch: customFetch,
    });
    const signBytes4e = sdk.cosmosAuthSignBytes({
      chainId: CHAIN_ID,
      account,
      pubkey: linkProof.pubkey,
      to: treasuryRecipient,
      amount: "200000uqor",
      nonce: nonceBefore4e.nonce,
    });
    const sig4e = new Uint8Array(crypto.sign(null, signBytes4e, agentKey.privateKeyObj));
    const execMsg4e = sdk.executeCosmosMsg({
      relayer: account,
      account,
      scheme: "ed25519",
      pubkey: linkProof.pubkey,
      signature: sig4e,
      to: treasuryRecipient,
      amount: "200000uqor",
      nonce: nonceBefore4e.nonce,
    });
    const auth4e = await getAuth(account);
    try {
      const res4e = await hybridSigner.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        accountNumber: auth4e.accountNumber,
        sequence: auth4e.sequence,
        messages: [execMsg4e],
        fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "600000" },
        memo: "qoreagent-vault:agent-exec-overcap-test",
      });
      const decoded4e = sdk.decodeAuthenticatorExecutions(res4e, [execMsg4e]);
      output.steps.spendingCapEnforcement = {
        mode: "included_in_block",
        txHash: res4e.transactionHash,
        height: res4e.height,
        code: res4e.code,
        nonceUsed: nonceBefore4e.nonce,
        attemptedAmount: "200000uqor",
        perTxLimit: "100000uqor",
        executionResults: decoded4e,
        rawLog: res4e.code !== 0 ? res4e.rawLog : undefined,
      };
    } catch (err) {
      output.steps.spendingCapEnforcement = {
        mode: "rejected_at_broadcast",
        nonceAttempted: nonceBefore4e.nonce,
        attemptedAmount: "200000uqor",
        perTxLimit: "100000uqor",
        error: err?.message ?? String(err),
      };
    }
    console.log("STEP_4E_RESULT:", JSON.stringify(jsonSafe(output.steps.spendingCapEnforcement)));

    // Step 4f: Live REST + EVM JSON-RPC & AI precompiles
    const [spendingRules, authenticators, evmWindow, evmBlockHex, evmBalanceHex] =
      await Promise.all([
        sdk.fetchSpendingRules({ rest: REST, address: account, fetch: customFetch }),
        sdk.fetchAuthenticators({ rest: REST, address: account, fetch: customFetch }),
        sdk.fetchEvmWindow({ rest: REST, address: account, fetch: customFetch }),
        evmRpc("eth_blockNumber", []),
        evmRpc("eth_getBalance", [ethAddress, "latest"]),
      ]);

    let pqcKeyStatus = null;
    try {
      pqcKeyStatus = await evmRpc("qor_getPQCKeyStatus", [account]);
    } catch (err) {
      pqcKeyStatus = { error: err?.message ?? String(err) };
    }

    const evmCallClient = {
      call: async ({ to, data }) => {
        const resHex = await evmRpc("eth_call", [{ to, data }, "latest"]);
        return { data: resHex };
      },
    };

    let riskScoreResult = null;
    try {
      riskScoreResult = await sdk.aiRiskScore(evmCallClient, "0x");
    } catch (err) {
      riskScoreResult = { error: err?.message ?? String(err) };
    }

    let anomalyCheckWithinCap = null;
    let anomalyCheckOverCap = null;
    try {
      anomalyCheckWithinCap = await sdk.aiAnomalyCheck(evmCallClient, ethAddress, 10n);
    } catch (err) {
      anomalyCheckWithinCap = { error: err?.message ?? String(err) };
    }
    try {
      anomalyCheckOverCap = await sdk.aiAnomalyCheck(evmCallClient, ethAddress, 200000n);
    } catch (err) {
      anomalyCheckOverCap = { error: err?.message ?? String(err) };
    }

    output.steps.liveStateAndEvmProbes = {
      cosmosRest: {
        spendingRules,
        authenticators,
        evmWindow,
      },
      evmRpc: {
        blockNumberHex: evmBlockHex,
        blockNumber: Number(BigInt(evmBlockHex)),
        balanceWeiHex: evmBalanceHex,
        balanceWei: BigInt(evmBalanceHex).toString(),
        qorGetPQCKeyStatus: pqcKeyStatus,
      },
      aiPrecompiles: {
        AI_RISK_SCORE_ADDRESS: sdk.AI_RISK_SCORE_ADDRESS,
        AI_ANOMALY_CHECK_ADDRESS: sdk.AI_ANOMALY_CHECK_ADDRESS,
        aiRiskScoreEmptyCalldata: riskScoreResult,
        aiAnomalyCheck10uqor: anomalyCheckWithinCap,
        aiAnomalyCheck200000uqor: anomalyCheckOverCap,
      },
    };

    const sanitized = jsonSafe(output);
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sanitized, null, 2));
    console.log("WROTE_PROOF_OUTPUT:", OUTPUT_PATH);
  } finally {
    transport.disconnect();
  }
}

main().catch((err) => {
  console.error("PROOF_RUN_FAILED:", err);
  process.exit(1);
});
