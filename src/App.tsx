import { useEffect, useMemo, useState } from "react";
import { VERIFIED_PROOFS } from "./data/verifiedProofs.js";
import {
  MAX_EVM_WINDOW_BLOCKS,
  MAX_EVM_WINDOW_TARGETS,
  MAX_EVM_WINDOW_TXS,
  WEI_PER_UQOR,
  buildAuthenticatorLinkMessage,
  buildMsgCloseEvmWindow,
  buildMsgOpenEvmWindow,
  computeEvmBudgetUqor,
  evaluateAgentIntent,
  validateEvmWindowParams,
  type AgentIntent,
  type EvmWindowParams,
  type SpendingRule,
} from "./lib/policyEngine.js";
import {
  DIANA_CHAIN_ID,
  DIANA_EVM_CHAIN_ID,
  DIANA_EVM_RPC_URL,
  callAiAnomalyCheck,
  callAiRiskScore,
  fetchBlockNumber,
  fetchEvmBalance,
  fetchPqcKeyStatus,
  type PqcKeyStatus,
  type QcaiPreflightResult,
} from "./lib/qoreRpc.js";

const DEFAULT_VAULT_ACCOUNT = "qor1j9gj92ffkmud24p4uzszexhqnuy0dq9sf5ymwp";
const DEFAULT_EVM_TARGET = "0x1111111111111111111111111111111111111111";
const DEFAULT_COSMOS_TARGET = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5q0k8z";

interface QoreXProvider {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  getKey?: (chainId: string) => Promise<{ bech32Address?: string }>;
}

declare global {
  interface Window {
    qorex?: QoreXProvider;
    ethereum?: QoreXProvider;
  }
}

export function App(): JSX.Element {
  // Telemetry state
  const [vaultAddress, setVaultAddress] = useState<string>(DEFAULT_VAULT_ACCOUNT);
  const [blockHeight, setBlockHeight] = useState<number | null>(null);
  const [balanceQor, setBalanceQor] = useState<string>("—");
  const [evmAddress, setEvmAddress] = useState<string>("—");
  const [pqcStatus, setPqcStatus] = useState<PqcKeyStatus | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [loadingTelemetry, setLoadingTelemetry] = useState<boolean>(false);

  // Scoped EVM Window Composer state
  const [blocks, setBlocks] = useState<number>(1200);
  const [maxTxs, setMaxTxs] = useState<number>(12);
  const [maxValueUqor, setMaxValueUqor] = useState<string>("100000");
  const [nativeOnly, setNativeOnly] = useState<boolean>(true);
  const [windowTargetsText, setWindowTargetsText] = useState<string>(DEFAULT_EVM_TARGET);
  const [gasLimit, setGasLimit] = useState<string>("21000");
  const [maxFeePerGasWei, setMaxFeePerGasWei] = useState<string>("20000000000");
  const [sampleValueUqor, setSampleValueUqor] = useState<string>("25000");
  const [windowMsgMode, setWindowMsgMode] = useState<"open" | "close">("open");
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);

  // Smart-Account Spending Rules & Intent Simulator state
  const [perTxLimitUqor, setPerTxLimitUqor] = useState<string>("50000");
  const [dailyLimitUqor, setDailyLimitUqor] = useState<string>("150000");
  const [dailySpentUqor, setDailySpentUqor] = useState<string>("20000");
  const [allowedDenomsText, setAllowedDenomsText] = useState<string>("uqor");
  const [ruleTargetsText, setRuleTargetsText] = useState<string>(
    `${DEFAULT_COSMOS_TARGET}\n${DEFAULT_EVM_TARGET}`,
  );

  const [intentStrategy, setIntentStrategy] = useState<"DCA" | "BILL_PAYER" | "EVM_REBALANCE">("DCA");
  const [intentExecRail, setIntentExecRail] = useState<"MsgExecuteCosmos" | "MsgExecuteEVM">("MsgExecuteCosmos");
  const [intentTarget, setIntentTarget] = useState<string>(DEFAULT_EVM_TARGET);
  const [intentAmountUqor, setIntentAmountUqor] = useState<string>("25000");
  const [intentDenom, setIntentDenom] = useState<string>("uqor");
  const [agentPubkeyHex, setAgentPubkeyHex] = useState<string>("a1b2c3d4".repeat(8));
  const [agentNonce, setAgentNonce] = useState<string>("1");

  // QCAI preflight state
  const [qcaiLoading, setQcaiLoading] = useState<boolean>(false);
  const [qcaiResults, setQcaiResults] = useState<QcaiPreflightResult[]>([]);

  async function refreshTelemetry(targetAddr = vaultAddress): Promise<void> {
    setLoadingTelemetry(true);
    setRpcError(null);
    try {
      const [height, bal, pqc] = await Promise.all([
        fetchBlockNumber(DIANA_EVM_RPC_URL),
        fetchEvmBalance(targetAddr, DIANA_EVM_RPC_URL),
        fetchPqcKeyStatus(targetAddr, DIANA_EVM_RPC_URL),
      ]);
      setBlockHeight(height);
      setBalanceQor(bal.formattedQor);
      setEvmAddress(bal.evmAddress);
      setPqcStatus(pqc);
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTelemetry(false);
    }
  }

  useEffect(() => {
    void refreshTelemetry(DEFAULT_VAULT_ACCOUNT);
  }, []);

  async function connectQoreX(): Promise<void> {
    const provider = window.qorex ?? window.ethereum;
    if (!provider) {
      setRpcError("QoreX browser extension not detected; inspecting Diana Testnet via public EVM RPC.");
      return;
    }
    try {
      let addr = "";
      if (provider.getKey) {
        const key = await provider.getKey(DIANA_CHAIN_ID);
        addr = key?.bech32Address ?? "";
      }
      if (!addr && provider.request) {
        const res = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        addr = res?.[0] ?? "";
      }
      if (addr) {
        setVaultAddress(addr);
        await refreshTelemetry(addr);
      }
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : String(err));
    }
  }

  const parsedWindowTargets = useMemo(
    () =>
      windowTargetsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [windowTargetsText],
  );

  const windowParams: EvmWindowParams = useMemo(
    () => ({
      blocks,
      maxTxs,
      maxValueUqor,
      nativeOnly,
      allowedTargets: parsedWindowTargets,
    }),
    [blocks, maxTxs, maxValueUqor, nativeOnly, parsedWindowTargets],
  );

  const windowValidation = useMemo(() => validateEvmWindowParams(windowParams), [windowParams]);

  const computedBudgetUqor = useMemo(() => {
    try {
      const valueWei = BigInt(sampleValueUqor || "0") * WEI_PER_UQOR;
      return computeEvmBudgetUqor(valueWei, gasLimit || "0", maxFeePerGasWei || "0").toString();
    } catch {
      return "Invalid";
    }
  }, [sampleValueUqor, gasLimit, maxFeePerGasWei]);

  const windowPayloadJson = useMemo(() => {
    const msg =
      windowMsgMode === "open"
        ? buildMsgOpenEvmWindow(vaultAddress, windowParams)
        : buildMsgCloseEvmWindow(vaultAddress);
    return JSON.stringify(msg, null, 2);
  }, [windowMsgMode, vaultAddress, windowParams]);

  const spendingRule: SpendingRule = useMemo(
    () => ({
      perTxLimitUqor,
      dailyLimitUqor,
      allowedDenoms: allowedDenomsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      allowedTargets: ruleTargetsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    [perTxLimitUqor, dailyLimitUqor, allowedDenomsText, ruleTargetsText],
  );

  const currentIntent: AgentIntent = useMemo(
    () => ({
      strategy: intentStrategy,
      target: intentTarget,
      amountUqor: intentAmountUqor,
      denom: intentDenom,
      gasLimit,
      maxFeePerGasWei,
    }),
    [intentStrategy, intentTarget, intentAmountUqor, intentDenom, gasLimit, maxFeePerGasWei],
  );

  const intentEvaluation = useMemo(
    () =>
      evaluateAgentIntent(
        spendingRule,
        currentIntent,
        dailySpentUqor,
        intentExecRail === "MsgExecuteEVM" ? windowParams : undefined,
      ),
    [spendingRule, currentIntent, dailySpentUqor, intentExecRail, windowParams],
  );

  const authenticatorLinkPayload = useMemo(
    () =>
      buildAuthenticatorLinkMessage({
        account: vaultAddress,
        authenticatorType: "Ed25519",
        pubkeyHex: agentPubkeyHex,
        chainId: DIANA_CHAIN_ID,
        nonce: agentNonce,
        label: "qoreagent-treasury-vault",
      }),
    [vaultAddress, agentPubkeyHex, agentNonce],
  );

  async function runQcaiPreflight(): Promise<void> {
    setQcaiLoading(true);
    try {
      const [risk, anomaly] = await Promise.all([
        callAiRiskScore(intentTarget, intentAmountUqor, DIANA_EVM_RPC_URL),
        callAiAnomalyCheck(intentTarget, intentAmountUqor, DIANA_EVM_RPC_URL),
      ]);
      setQcaiResults([risk, anomaly]);
    } finally {
      setQcaiLoading(false);
    }
  }

  function applyPreset(preset: "dca" | "overlimit" | "unauthorized"): void {
    if (preset === "dca") {
      setIntentStrategy("DCA");
      setIntentExecRail("MsgExecuteCosmos");
      setIntentTarget(DEFAULT_EVM_TARGET);
      setIntentAmountUqor("25000");
      setIntentDenom("uqor");
    } else if (preset === "overlimit") {
      setIntentStrategy("BILL_PAYER");
      setIntentExecRail("MsgExecuteCosmos");
      setIntentTarget(DEFAULT_COSMOS_TARGET);
      setIntentAmountUqor("90000");
      setIntentDenom("uqor");
    } else {
      setIntentStrategy("EVM_REBALANCE");
      setIntentExecRail("MsgExecuteEVM");
      setIntentTarget("0x9999999999999999999999999999999999999999");
      setIntentAmountUqor("10000");
      setIntentDenom("uqor");
    }
  }

  async function copyText(label: string, text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    setCopiedMsg(label);
    setTimeout(() => setCopiedMsg(null), 1800);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>
            QoreAgent Vault
            <span className="pill emerald">ML-DSA-87 + Ed25519</span>
          </h1>
          <p>Post-Quantum Bounded Treasury Agent — Scoped EVM Windows &amp; Smart-Account Spending Rules</p>
        </div>
        <div className="btn-row">
          <span className="pill cyan">
            {DIANA_CHAIN_ID} · EVM {DIANA_EVM_CHAIN_ID}
          </span>
          <button type="button" onClick={() => void connectQoreX()}>
            Connect QoreX
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void refreshTelemetry()}
            disabled={loadingTelemetry}
          >
            {loadingTelemetry ? "Syncing..." : "Refresh Telemetry"}
          </button>
        </div>
      </header>

      {/* Section 1: Live Diana Testnet Telemetry Bar */}
      <section className="telemetry-bar" aria-label="Live Diana Testnet Telemetry">
        <div className="telemetry-card">
          <div className="telemetry-label">Network &amp; RPC</div>
          <div className="telemetry-value">Chain {DIANA_EVM_CHAIN_ID}</div>
          <div className="telemetry-sub">{DIANA_EVM_RPC_URL}</div>
        </div>
        <div className="telemetry-card">
          <div className="telemetry-label">Live Block Height</div>
          <div className="telemetry-value">{blockHeight !== null ? `#${blockHeight.toLocaleString()}` : "Syncing..."}</div>
          <div className="telemetry-sub">eth_blockNumber</div>
        </div>
        <div className="telemetry-card">
          <div className="telemetry-label">Vault Balance</div>
          <div className="telemetry-value">{balanceQor}</div>
          <div className="telemetry-sub mono">{evmAddress}</div>
        </div>
        <div className="telemetry-card">
          <div className="telemetry-label">ML-DSA-87 PQC Status</div>
          <div className="telemetry-value">
            {pqcStatus ? (pqcStatus.registered ? "Active PQC Root" : "Unregistered / Standby") : "Checking..."}
          </div>
          <div className="telemetry-sub">{pqcStatus?.algorithm ?? "qor_getPQCKeyStatus"}</div>
        </div>
      </section>

      <div className="address-bar">
        <span className="telemetry-label" style={{ margin: 0 }}>
          Inspected Vault Account
        </span>
        <input
          type="text"
          value={vaultAddress}
          onChange={(e) => setVaultAddress(e.target.value)}
          placeholder="qor1... or 0x..."
        />
        <button type="button" onClick={() => void refreshTelemetry(vaultAddress)} disabled={loadingTelemetry}>
          Inspect Account
        </button>
        {rpcError && <span className="pill rose">{rpcError}</span>}
      </div>

      <div className="grid-two">
        {/* Section 2: Scoped EVM Window Composer */}
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Scoped EVM Window Composer</h2>
              <p>Root ML-DSA-87 key grants a time- and budget-bounded EVM execution envelope.</p>
            </div>
            <span className={`pill ${windowValidation.valid ? "emerald" : "rose"}`}>
              {windowValidation.valid ? "VALID BOUNDS" : "INVALID BOUNDS"}
            </span>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="win-blocks">Blocks (1..{MAX_EVM_WINDOW_BLOCKS})</label>
              <input
                id="win-blocks"
                type="number"
                value={blocks}
                onChange={(e) => setBlocks(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="win-max-txs">Max Txs (1..{MAX_EVM_WINDOW_TXS})</label>
              <input
                id="win-max-txs"
                type="number"
                value={maxTxs}
                onChange={(e) => setMaxTxs(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="win-max-val">Max Value (uqor)</label>
              <input
                id="win-max-val"
                type="text"
                value={maxValueUqor}
                onChange={(e) => setMaxValueUqor(e.target.value)}
              />
            </div>
            <div className="checkbox-row">
              <input
                id="win-native-only"
                type="checkbox"
                checked={nativeOnly}
                onChange={(e) => setNativeOnly(e.target.checked)}
              />
              <label htmlFor="win-native-only">nativeOnly (block contract calldata)</label>
            </div>
          </div>

          <div className="field">
            <label htmlFor="win-targets">
              Allowed EVM Targets (max {MAX_EVM_WINDOW_TARGETS}, comma or newline separated)
            </label>
            <textarea
              id="win-targets"
              value={windowTargetsText}
              onChange={(e) => setWindowTargetsText(e.target.value)}
            />
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="est-val">Sample Value (uqor)</label>
              <input
                id="est-val"
                type="text"
                value={sampleValueUqor}
                onChange={(e) => setSampleValueUqor(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="est-gas">Gas Limit</label>
              <input
                id="est-gas"
                type="text"
                value={gasLimit}
                onChange={(e) => setGasLimit(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="est-fee">Max Fee / Gas (wei)</label>
              <input
                id="est-fee"
                type="text"
                value={maxFeePerGasWei}
                onChange={(e) => setMaxFeePerGasWei(e.target.value)}
              />
            </div>
          </div>

          <div className={`status-box ${windowValidation.valid ? "approved" : "blocked"}`}>
            <strong>
              Worst-Case Fee+Value Budget: <span className="mono">{computedBudgetUqor} uqor</span>
            </strong>
            <div className="telemetry-sub">Formula: ceil((valueWei + gasLimit * maxFeePerGas) / 1e12)</div>
            {!windowValidation.valid && (
              <ul>
                {windowValidation.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="btn-row">
            <button
              type="button"
              onClick={() => setWindowMsgMode("open")}
              className={windowMsgMode === "open" ? "primary" : ""}
            >
              MsgOpenEVMWindow
            </button>
            <button
              type="button"
              onClick={() => setWindowMsgMode("close")}
              className={windowMsgMode === "close" ? "primary" : ""}
            >
              MsgCloseEVMWindow
            </button>
            <button type="button" onClick={() => void copyText("window", windowPayloadJson)}>
              {copiedMsg === "window" ? "Copied JSON" : "Copy Message JSON"}
            </button>
          </div>

          <pre className="code-block">{windowPayloadJson}</pre>
        </section>

        {/* Section 3: Smart-Account Spending Rules & Agent Intent Simulator */}
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Smart-Account Spending Rules &amp; Agent Simulator</h2>
              <p>Test Ed25519 agent intents against on-chain SpendingRule caps &amp; QCAI preflight.</p>
            </div>
            <span className={`pill ${intentEvaluation.decision === "APPROVED" ? "emerald" : "rose"}`}>
              {intentEvaluation.decision}
            </span>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="rule-pertx">perTxLimit (uqor)</label>
              <input
                id="rule-pertx"
                type="text"
                value={perTxLimitUqor}
                onChange={(e) => setPerTxLimitUqor(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rule-daily">dailyLimit (uqor)</label>
              <input
                id="rule-daily"
                type="text"
                value={dailyLimitUqor}
                onChange={(e) => setDailyLimitUqor(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rule-spent">24h Spent So Far (uqor)</label>
              <input
                id="rule-spent"
                type="text"
                value={dailySpentUqor}
                onChange={(e) => setDailySpentUqor(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rule-denoms">Allowed Denoms</label>
              <input
                id="rule-denoms"
                type="text"
                value={allowedDenomsText}
                onChange={(e) => setAllowedDenomsText(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="rule-targets">SpendingRule Allowed Targets (qor1... or 0x...)</label>
            <textarea
              id="rule-targets"
              value={ruleTargetsText}
              onChange={(e) => setRuleTargetsText(e.target.value)}
            />
          </div>

          <div className="btn-row">
            <button type="button" onClick={() => applyPreset("dca")}>
              Preset: Compliant DCA
            </button>
            <button type="button" onClick={() => applyPreset("overlimit")}>
              Preset: Over-Limit Cap Attack
            </button>
            <button type="button" onClick={() => applyPreset("unauthorized")}>
              Preset: Unauthorized Target
            </button>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="intent-rail">Execution Message</label>
              <select
                id="intent-rail"
                value={intentExecRail}
                onChange={(e) => setIntentExecRail(e.target.value as "MsgExecuteCosmos" | "MsgExecuteEVM")}
              >
                <option value="MsgExecuteCosmos">MsgExecuteCosmos (Ed25519)</option>
                <option value="MsgExecuteEVM">MsgExecuteEVM (Scoped Window)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="intent-amount">Intent Amount (uqor)</label>
              <input
                id="intent-amount"
                type="text"
                value={intentAmountUqor}
                onChange={(e) => setIntentAmountUqor(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="intent-denom">Denom</label>
              <input
                id="intent-denom"
                type="text"
                value={intentDenom}
                onChange={(e) => setIntentDenom(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="intent-target">Intent Target Address</label>
            <input
              id="intent-target"
              type="text"
              value={intentTarget}
              onChange={(e) => setIntentTarget(e.target.value)}
            />
          </div>

          <div className={`status-box ${intentEvaluation.decision === "APPROVED" ? "approved" : "blocked"}`}>
            <strong>
              Guard Verdict: {intentEvaluation.decision} · Remaining 24h Allowance:{" "}
              <span className="mono">{intentEvaluation.remainingDailyLimitUqor} uqor</span>
            </strong>
            {intentEvaluation.evmBudgetUqor && (
              <div className="telemetry-sub">
                EVM Fee+Value Budget Checked: {intentEvaluation.evmBudgetUqor} uqor
              </div>
            )}
            {intentEvaluation.reasons.length > 0 && (
              <ul>
                {intentEvaluation.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="btn-row">
            <button type="button" className="primary" onClick={() => void runQcaiPreflight()} disabled={qcaiLoading}>
              {qcaiLoading ? "Querying QCAI Precompiles..." : "Run QCAI Preflight (0x0B01 / 0x0B02)"}
            </button>
          </div>

          {qcaiResults.length > 0 && (
            <div className="status-box">
              <strong>QCAI Precompile Preflight</strong>
              <ul>
                {qcaiResults.map((res) => (
                  <li key={res.precompile}>
                    <span className="mono">{res.precompile}</span> ({res.status}): score={res.riskScore},{" "}
                    level={res.riskLevel} — {res.note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="auth-pub">Ed25519 Agent Pubkey (Hex)</label>
              <input
                id="auth-pub"
                type="text"
                value={agentPubkeyHex}
                onChange={(e) => setAgentPubkeyHex(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="auth-nonce">Link Nonce</label>
              <input
                id="auth-nonce"
                type="text"
                value={agentNonce}
                onChange={(e) => setAgentNonce(e.target.value)}
              />
            </div>
          </div>

          <div className="btn-row">
            <button type="button" onClick={() => void copyText("auth", authenticatorLinkPayload)}>
              {copiedMsg === "auth" ? "Copied Link Payload" : "Copy Authenticator Link v1"}
            </button>
          </div>
          <pre className="code-block">{authenticatorLinkPayload}</pre>
        </section>
      </div>

      {/* Section 4: Verified On-Chain Proof Ledger */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Verified On-Chain Proof Ledger</h2>
            <p>
              Diana Testnet (<span className="mono">qorechain-diana</span>) receipts for SpendingRules,
              Authenticator Registration, Scoped EVM Windows, and Policy Enforcement.
            </p>
          </div>
          <span className="pill amber">On-Chain Audit Trail</span>
        </div>

        <div className="proof-table-wrap">
          <table className="proof-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Message Type</th>
                <th>Authenticator</th>
                <th>Height</th>
                <th>TX Hash</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {VERIFIED_PROOFS.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.title}</strong>
                    <div className="telemetry-sub">{entry.summary}</div>
                  </td>
                  <td className="mono">{entry.msgType}</td>
                  <td>{entry.authenticator}</td>
                  <td className="mono">{entry.blockHeight !== null ? `#${entry.blockHeight}` : "Pending"}</td>
                  <td className="mono">{entry.txHash}</td>
                  <td>
                    <span
                      className={`pill ${
                        entry.outcome === "COMMITTED"
                          ? "emerald"
                          : entry.outcome === "REJECTED_ONCHAIN"
                            ? "rose"
                            : "amber"
                      }`}
                    >
                      {entry.outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="footer">
        <span>QoreAgent Vault · MIT License · 2026 devbox-zero-ops</span>
        <span>Built with @qorechain/sdk, @qorechain/evm, @qorechain/pqc, React &amp; Vite</span>
      </footer>
    </div>
  );
}
