export interface VerifiedProofEntry {
  id: string;
  title: string;
  msgType: string;
  network: string;
  txHash: string;
  blockHeight: number | null;
  outcome: "COMMITTED" | "REJECTED_ONCHAIN" | "PENDING";
  summary: string;
  authenticator: string;
}

export const VERIFIED_PROOFS: VerifiedProofEntry[] = [
  {
    id: "proof-01-rules-auth",
    title: "Initialize Treasury SpendingRule & Register Ed25519 Agent Key",
    msgType: "MsgUpdateSpendingRules + MsgRegisterAuthenticator",
    network: "qorechain-diana",
    txHash: "182EBAC89CC20804931EC1B786FD00264BAE36FB55987305C921C80CBA39B1EA",
    blockHeight: 10818158,
    outcome: "COMMITTED",
    summary:
      "Binds treasury-cap-v1 (perTxLimit: 100,000 uqor, dailyLimit: 500,000 uqor) to the smart account and registers Ed25519 key 951c4a25...34d3f (label: qoreagent-treasury-bot-v1).",
    authenticator: "ML-DSA-87 Hybrid Root -> Ed25519 Agent",
  },
  {
    id: "proof-02-open-window",
    title: "Open Bounded Scoped EVM Execution Window",
    msgType: "MsgOpenEVMWindow",
    network: "qorechain-diana",
    txHash: "7578AB067A0224531D9C66A372309B387BEB8CF6BE7B5B120044F166F1350B05",
    blockHeight: 10818171,
    outcome: "COMMITTED",
    summary:
      "Opens a 600-block EVM window (expiryHeight: 10818771) with maxTxs: 5, maxValue: 500,000 uqor, and target allowlist [0x915122...680b0].",
    authenticator: "ML-DSA-87 Hybrid Root",
  },
  {
    id: "proof-03-dca-approved",
    title: "Autonomous Transfer Within Policy Bounds",
    msgType: "MsgExecuteCosmos",
    network: "qorechain-diana",
    txHash: "3A2E4A7FC63B4D27FE1CE7F1C0994A50F5CD81DFAAE737023F33C1547D14AD59",
    blockHeight: 10818215,
    outcome: "COMMITTED",
    summary:
      "Ed25519 agent key signs a compliant 10 uqor transfer (nonce 2) under perTxLimit (100,000 uqor) and dailyLimit (500,000 uqor).",
    authenticator: "Ed25519 Agent Authenticator",
  },
  {
    id: "proof-04-cap-blocked",
    title: "On-Chain Rejection of Over-Limit Agent Transfer",
    msgType: "MsgExecuteCosmos",
    network: "qorechain-diana",
    txHash: "DF6863E4A5F3E4F34402FB918B3C632FC42618104BF70F0DAEB7F91AD78131D3",
    blockHeight: 10818218,
    outcome: "REJECTED_ONCHAIN",
    summary:
      "200,000 uqor attempt (nonce 3) deterministically blocked by abstractaccount module: 'per-tx limit 100000uqor exceeded (attempted 200000): spending limit exceeded'.",
    authenticator: "Ed25519 Agent Authenticator",
  },
];
