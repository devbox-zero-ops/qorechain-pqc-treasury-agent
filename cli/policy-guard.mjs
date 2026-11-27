#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildAuthenticatorLinkMessage,
  computeEvmBudgetUqor,
  evaluateAgentIntent,
  validateEvmWindowParams,
  validateSpendingRule,
} from "../src/lib/policyEngine.ts";

const DEFAULT_POLICY = {
  vaultAccount: "qor1j9gj92ffkmud24p4uzszexhqnuy0dq9sf5ymwp",
  chainId: "qorechain-diana",
  spendingRule: {
    perTxLimitUqor: "50000",
    dailyLimitUqor: "150000",
    allowedDenoms: ["uqor"],
    allowedTargets: [
      "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z",
      "0x1111111111111111111111111111111111111111",
    ],
  },
  evmWindow: {
    blocks: 1200,
    maxTxs: 10,
    maxValueUqor: "100000",
    nativeOnly: true,
    allowedTargets: ["0x1111111111111111111111111111111111111111"],
  },
};

const SAMPLE_INTENTS = [
  {
    id: "intent-dca-01",
    strategy: "DCA",
    target: "0x1111111111111111111111111111111111111111",
    amountUqor: "25000",
    denom: "uqor",
    memo: "Scheduled DCA tranche #1",
    gasLimit: "21000",
    maxFeePerGasWei: "20000000000",
  },
  {
    id: "intent-over-limit-02",
    strategy: "BILL_PAYER",
    target: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z",
    amountUqor: "90000",
    denom: "uqor",
    memo: "Rogue or oversized payout above perTxLimit",
  },
  {
    id: "intent-unauth-target-03",
    strategy: "BILL_PAYER",
    target: "0x9999999999999999999999999999999999999999",
    amountUqor: "10000",
    denom: "uqor",
    memo: "Exfiltration attempt to unapproved target",
  },
];

function parseArgs(argv) {
  const args = { policyPath: null, intentPath: null, dailySpent: "0", json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--policy" && argv[i + 1]) {
      args.policyPath = argv[++i];
    } else if (token === "--intent" && argv[i + 1]) {
      args.intentPath = argv[++i];
    } else if (token === "--daily-spent" && argv[i + 1]) {
      args.dailySpent = argv[++i];
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

function readJsonFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "QoreAgent Vault — Policy Guard CLI",
        "",
        "Usage:",
        "  node cli/policy-guard.mjs [--policy <policy.json>] [--intent <intent.json>] [--daily-spent <uqor>] [--json]",
        "",
        "Without --intent, runs the built-in DCA / over-limit / unauthorized-target verification suite.",
      ].join("\n"),
    );
    process.exit(0);
  }

  const policy = args.policyPath ? readJsonFile(args.policyPath) : DEFAULT_POLICY;
  const ruleCheck = validateSpendingRule(policy.spendingRule);
  const winCheck = policy.evmWindow ? validateEvmWindowParams(policy.evmWindow) : { valid: true, errors: [] };

  if (!ruleCheck.valid || !winCheck.valid) {
    console.error("Invalid policy configuration:", [...ruleCheck.errors, ...winCheck.errors]);
    process.exit(1);
  }

  const intents = args.intentPath ? [readJsonFile(args.intentPath)] : SAMPLE_INTENTS;
  let runningDailySpent = BigInt(args.dailySpent);

  const results = intents.map((intent) => {
    const windowToCheck =
      policy.evmWindow && intent.target.startsWith("0x") ? policy.evmWindow : undefined;
    const evaluation = evaluateAgentIntent(
      policy.spendingRule,
      intent,
      runningDailySpent.toString(),
      windowToCheck,
    );
    if (evaluation.decision === "APPROVED") {
      runningDailySpent += BigInt(intent.amountUqor);
    }
    return {
      intentId: intent.id ?? "(unnamed)",
      strategy: intent.strategy,
      target: intent.target,
      amountUqor: intent.amountUqor,
      ...evaluation,
    };
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          vaultAccount: policy.vaultAccount,
          chainId: policy.chainId,
          sampleBudgetCheckUqor: computeEvmBudgetUqor("25000000000000000", "21000", "20000000000").toString(),
          authenticatorLinkPreview: buildAuthenticatorLinkMessage({
            account: policy.vaultAccount,
            authenticatorType: "Ed25519",
            pubkeyHex: "00".repeat(32),
            chainId: policy.chainId,
            nonce: 1,
          }),
          results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("=== QoreAgent Vault :: Deterministic Policy Guard ===");
    console.log(`Vault: ${policy.vaultAccount} | Chain: ${policy.chainId}`);
    console.log(
      `Rule: perTx=${policy.spendingRule.perTxLimitUqor} uqor, daily=${policy.spendingRule.dailyLimitUqor} uqor`,
    );
    console.log("");
    for (const r of results) {
      const badge = r.decision === "APPROVED" ? "[APPROVED]" : "[BLOCKED ]";
      console.log(`${badge} ${r.intentId} (${r.strategy}) -> ${r.amountUqor} uqor to ${r.target}`);
      if (r.reasons.length > 0) {
        for (const reason of r.reasons) {
          console.log(`           reason: ${reason}`);
        }
      } else {
        console.log(`           remainingDailyLimit: ${r.remainingDailyLimitUqor} uqor`);
      }
    }
  }

  if (args.intentPath && results[0]?.decision === "BLOCKED") {
    process.exit(2);
  }
}

main();
