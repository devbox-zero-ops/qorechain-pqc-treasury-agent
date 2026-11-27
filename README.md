# QoreAgent Vault

**QoreAgent Vault** is a Post-Quantum Bounded Treasury Agent console and deterministic policy guard for **QoreChain** (`qorechain-diana`, EVM Chain ID `9800`).

It pairs a quantum-resistant **ML-DSA-87** root key with delegated **Ed25519** agent authenticators, **Smart-Account Spending Rules** (`perTxLimit`, `dailyLimit`, `allowedDenoms`, `allowedTargets`), and **Scoped EVM Windows** (`MsgOpenEVMWindow` / `MsgCloseEVMWindow`) so autonomous DCA and bill-payer agents can operate within strict, protocol-enforced financial bounds.

## Architecture

- **Frontend (`src/App.tsx`, `src/styles.css`)**:
  - **Live Diana Testnet Telemetry**: Queries `https://evm-testnet.qore.host` (CORS-safe EVM JSON-RPC) for `eth_blockNumber`, `eth_getBalance`, and `qor_getPQCKeyStatus`.
  - **Scoped EVM Window Composer**: Validates protocol bounds (`blocks` `1..17280`, `maxTxs` `1..1000`, `maxValue` `> 0 uqor`, `<= 16` `0x` targets), computes worst-case fee+value budgets via `ceil((valueWei + gasLimit * maxFeePerGas) / 1e12)`, and generates copyable `MsgOpenEVMWindow` / `MsgCloseEVMWindow` payloads.
  - **Smart-Account Spending Rules & Intent Simulator**: Evaluates `DCA`, `BILL_PAYER`, and `EVM_REBALANCE` intents (`MsgExecuteCosmos` / `MsgExecuteEVM`), builds `QoreChain authenticator link v1` payloads, and runs QCAI preflight checks against `AI_RISK_SCORE_ADDRESS` (`0x...0B01`) and `AI_ANOMALY_CHECK_ADDRESS` (`0x...0B02`).
  - **Verified On-Chain Proof Ledger (`src/data/verifiedProofs.ts`)**: Displays Diana Testnet transaction receipts for rule initialization, window opening, compliant execution, and over-limit rejection.
- **Deterministic Policy Engine (`src/lib/policyEngine.ts`)**: Shared validation and simulation logic used by the web console, CLI guard, and unit test suite.
- **CLI Policy Guard (`cli/policy-guard.mjs`)**: Standalone Node.js CLI for pre-flight policy verification in automated agent pipelines.

## Verified Diana Testnet Proofs (`qorechain-diana`)

- **Vault Account**: `qor1j9gj92ffkmud24p4uzszexhqnuy0dq9sf5ymwp` (`0x915122A929b6f8d55435E0a02C9aE09F08F680b0`)
- **Registered Ed25519 Agent Pubkey**: `951c4a25d88d07d1f6789f20106e0b81f8b9dc529d258b252b9e99bb56734d3f` (`qoreagent-treasury-bot-v1`)

| Step | Message Type | Outcome | Block | TX Hash |
| --- | --- | --- | --- | --- |
| 1 | `MsgUpdateSpendingRules + MsgRegisterAuthenticator` | Committed (`treasury-cap-v1`: 100k/tx, 500k/day) | `10818158` | `182EBAC89CC20804931EC1B786FD00264BAE36FB55987305C921C80CBA39B1EA` |
| 2 | `MsgOpenEVMWindow` | Committed (600 blocks, 5 txs, 500k uqor) | `10818171` | `7578AB067A0224531D9C66A372309B387BEB8CF6BE7B5B120044F166F1350B05` |
| 3 | `MsgExecuteCosmos` (`10uqor`) | Committed (`success: true`) | `10818215` | `3A2E4A7FC63B4D27FE1CE7F1C0994A50F5CD81DFAAE737023F33C1547D14AD59` |
| 4 | `MsgExecuteCosmos` (`200000uqor` > `100000` cap) | Rejected on-chain (`abstractaccount_execution_failed`) | `10818218` | `DF6863E4A5F3E4F34402FB918B3C632FC42618104BF70F0DAEB7F91AD78131D3` |

Live Demo: `https://devbox-zero-ops.github.io/qorechain-pqc-treasury-agent/`

## Quick Start

```bash
npm install
npm run dev
```

### Build & Test

```bash
npm run build
npm test
```

### CLI Policy Guard Usage

Run the built-in verification suite (compliant DCA, over-limit block, unauthorized-target block):

```bash
node cli/policy-guard.mjs
```

Validate a custom policy and intent JSON:

```bash
node cli/policy-guard.mjs --policy ./policy.json --intent ./intent.json --daily-spent 20000 --json
```

Exit codes:
- `0`: Approved (or built-in suite completed)
- `1`: Invalid policy configuration
- `2`: Custom intent blocked by policy guard

## Threat Model

See [docs/threat-model.md](docs/threat-model.md) for the full security analysis covering compromised classical ECDSA keys, rogue Ed25519 agent keys, Scoped EVM Window containment, and on-chain `SpendingRule` enforcement.

## Credits & Stack

- `@qorechain/sdk` (`^0.14.0`)
- `@qorechain/evm`
- `@qorechain/pqc`
- React 18 & Vite 5

## License

MIT License — Copyright (c) 2026 devbox-zero-ops. See [LICENSE](LICENSE).
