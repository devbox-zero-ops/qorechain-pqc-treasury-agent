# QoreAgent Vault Threat Model

## Security Objective

Enable autonomous treasury agents (DCA bots, recurring bill payers, rebalancers) to execute transactions on QoreChain without granting them custody of the root treasury or exposing the vault to unbounded loss if an agent key or classical ECDSA key is compromised.

## Trust Boundaries & Key Hierarchy

1. **Root Authority (`ML-DSA-87` Post-Quantum Key)**
   - Holds full administrative control over the smart account.
   - Required to update `SpendingRule` parameters (`MsgUpdateSpendingRules`), register or revoke delegated authenticators (`MsgRegisterAuthenticator`), and open or close Scoped EVM Windows (`MsgOpenEVMWindow` / `MsgCloseEVMWindow`).
   - Protected against harvest-now-decrypt-later and quantum signature forgery attacks.

2. **Delegated Agent Key (`Ed25519` Authenticator)**
   - Registered on-chain via a `QoreChain authenticator link v1` signature.
   - Can only submit bounded execution messages (`MsgExecuteCosmos` / `MsgExecuteEVM`) within active `SpendingRule` and `EvmWindow` constraints.

## Attack Scenarios & Mitigations

### 1. Compromised Classical ECDSA Key
- **Threat**: An attacker recovers or breaks a classical ECDSA key associated with an EVM address or legacy signer.
- **Mitigation**: Root smart-account governance and `MsgOpenEVMWindow` authorization are anchored in the **ML-DSA-87** post-quantum key. A classical ECDSA key cannot forge ML-DSA-87 signatures, cannot expand `SpendingRule` limits, and cannot extend or reopen an expired Scoped EVM Window.

### 2. Rogue or Compromised Ed25519 Agent Key
- **Threat**: An attacker steals the agent's hot `Ed25519` key or hijacks the off-chain agent runtime to drain the treasury.
- **Mitigation**:
  - **Per-Transaction Cap (`perTxLimit`)**: Single transactions exceeding `perTxLimit` are rejected deterministically on-chain by the smart-account module.
  - **Rolling 24h Cap (`dailyLimit`)**: Repeated smaller transactions cannot drain more than `dailyLimit` within a 24-hour window.
  - **Target Allowlist (`allowedTargets`)**: Funds can only move to pre-approved `qor1...` or `0x...` destinations; arbitrary exfiltration addresses are blocked.
  - **Denomination Allowlist (`allowedDenoms`)**: Prevents unauthorized movement of non-approved treasury assets.

### 3. Unbounded EVM Contract Calls & Gas Drain
- **Threat**: An agent attempts to call an arbitrary smart contract, invoke `CALL` with malicious calldata, or burn treasury balance via inflated gas fees.
- **Mitigation**:
  - **Scoped EVM Window (`MsgOpenEVMWindow`)**:
    - `blocks` (`1..17280`): Automatically expires after the block horizon.
    - `maxTxs` (`1..1000`): Caps total EVM executions inside the window.
    - `nativeOnly`: When `true`, rejects contract calldata and restricts execution to native value transfers.
    - `allowedTargets` (`<= 16`): Restricts EVM destinations to explicit `0x` addresses.
    - **Fee + Value Budget**: Enforces `ceil((valueWei + gasLimit * maxFeePerGas) / 1e12) <= maxValue` in `uqor`, preventing gas-price manipulation from exceeding the window's value cap.

### 4. Off-Chain Policy Drift & Preflight Screening
- **Mitigation**:
  - `src/lib/policyEngine.ts` mirrors on-chain bounds deterministically in both the browser console and `cli/policy-guard.mjs`.
  - Optional QCAI preflight calls (`aiRiskScore` at `0x...0B01` and `aiAnomalyCheck` at `0x...0B02`) provide an additional risk signal prior to broadcast, with graceful fallback so deterministic `SpendingRule` and `EvmWindow` enforcement always remains authoritative.
