import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EVM_WINDOW_BLOCKS,
  MAX_EVM_WINDOW_TARGETS,
  MAX_EVM_WINDOW_TXS,
  buildAuthenticatorLinkMessage,
  computeEvmBudgetUqor,
  evaluateAgentIntent,
  validateEvmWindowParams,
} from "../src/lib/policyEngine.ts";

const BASE_RULE = {
  perTxLimitUqor: "50000",
  dailyLimitUqor: "120000",
  allowedDenoms: ["uqor"],
  allowedTargets: [
    "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z",
    "0x1111111111111111111111111111111111111111",
  ],
};

test("validates scoped EVM window within protocol bounds", () => {
  const res = validateEvmWindowParams({
    blocks: 1200,
    maxTxs: 10,
    maxValueUqor: "100000",
    nativeOnly: true,
    allowedTargets: ["0x1111111111111111111111111111111111111111"],
  });
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, []);
});

test("rejects out-of-range EVM window bounds and >16 targets", () => {
  const tooManyTargets = Array.from({ length: MAX_EVM_WINDOW_TARGETS + 1 }, (_, i) => {
    const hex = (i + 1).toString(16).padStart(40, "0");
    return `0x${hex}`;
  });

  const res = validateEvmWindowParams({
    blocks: MAX_EVM_WINDOW_BLOCKS + 1,
    maxTxs: MAX_EVM_WINDOW_TXS + 1,
    maxValueUqor: "0",
    nativeOnly: false,
    allowedTargets: tooManyTargets,
  });

  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("blocks")));
  assert.ok(res.errors.some((e) => e.includes("maxTxs")));
  assert.ok(res.errors.some((e) => e.includes("greater than 0")));
  assert.ok(res.errors.some((e) => e.includes(`${MAX_EVM_WINDOW_TARGETS}`)));
});

test("computes EVM fee+value budget with exact ceiling division to uqor", () => {
  // value = 1e12 wei (1 uqor), gas = 21000, maxFee = 1 -> total = 1e12 + 21000 -> ceil = 2 uqor
  const roundedUp = computeEvmBudgetUqor("1000000000000", "21000", "1");
  assert.equal(roundedUp, 2n);

  // exact multiple: 2e12 wei + 0 gas -> 2 uqor
  const exact = computeEvmBudgetUqor("2000000000000", "0", "0");
  assert.equal(exact, 2n);
});

test("approves valid DCA intent within per-tx, daily, and target allowlist", () => {
  const evalRes = evaluateAgentIntent(
    BASE_RULE,
    {
      strategy: "DCA",
      target: "0x1111111111111111111111111111111111111111",
      amountUqor: "40000",
      denom: "uqor",
    },
    "20000",
  );
  assert.equal(evalRes.decision, "APPROVED");
  assert.equal(evalRes.projectedDailySpentUqor, "60000");
  assert.equal(evalRes.remainingDailyLimitUqor, "60000");
});

test("blocks intent exceeding perTxLimit", () => {
  const evalRes = evaluateAgentIntent(
    BASE_RULE,
    {
      strategy: "BILL_PAYER",
      target: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z",
      amountUqor: "50001",
      denom: "uqor",
    },
    "0",
  );
  assert.equal(evalRes.decision, "BLOCKED");
  assert.ok(evalRes.codes.includes("PER_TX_LIMIT_EXCEEDED"));
});

test("blocks intent exceeding dailyLimit even when under perTxLimit", () => {
  const evalRes = evaluateAgentIntent(
    BASE_RULE,
    {
      strategy: "DCA",
      target: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z",
      amountUqor: "30000",
      denom: "uqor",
    },
    "100000",
  );
  assert.equal(evalRes.decision, "BLOCKED");
  assert.ok(evalRes.codes.includes("DAILY_LIMIT_EXCEEDED"));
});

test("blocks intent targeting an address outside allowedTargets", () => {
  const evalRes = evaluateAgentIntent(
    BASE_RULE,
    {
      strategy: "BILL_PAYER",
      target: "0x9999999999999999999999999999999999999999",
      amountUqor: "10000",
      denom: "uqor",
    },
    "0",
  );
  assert.equal(evalRes.decision, "BLOCKED");
  assert.ok(evalRes.codes.includes("UNAUTHORIZED_TARGET"));
});

test("builds canonical QoreChain authenticator link v1 payload", () => {
  const msg = buildAuthenticatorLinkMessage({
    account: "qor1j9gj92ffkmud24p4uzszexhqnuy0dq9sf5ymwp",
    authenticatorType: "Ed25519",
    pubkeyHex: "0xAABBCC",
    chainId: "qorechain-diana",
    nonce: 7,
    label: "treasury-dca-bot",
  });
  assert.ok(msg.startsWith("QoreChain authenticator link v1\n"));
  assert.ok(msg.includes("pubkey_hex: aabbcc"));
  assert.ok(msg.includes("nonce: 7"));
});
