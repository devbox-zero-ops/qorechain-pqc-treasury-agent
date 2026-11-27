import {
  AI_ANOMALY_CHECK_ADDRESS,
  AI_RISK_SCORE_ADDRESS,
  RISK_LEVEL_UNSAFE_THRESHOLD,
  qorToEvm,
} from "@qorechain/sdk";

export const DIANA_EVM_RPC_URL = "https://evm-testnet.qore.host";
export const DIANA_CHAIN_ID = "qorechain-diana";
export const DIANA_EVM_CHAIN_ID = 9800;

export interface PqcKeyStatus {
  address: string;
  registered: boolean;
  algorithm: string;
  raw: Record<string, unknown> | null;
}

export interface QcaiPreflightResult {
  precompile: "aiRiskScore" | "aiAnomalyCheck";
  address: string;
  status: "LIVE_PRECOMPILE" | "FALLBACK";
  riskScore: number;
  riskLevel: string;
  anomalyDetected: boolean;
  rawHex: string;
  note: string;
}

async function jsonRpc<T>(method: string, params: unknown[], rpcUrl = DIANA_EVM_RPC_URL): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (json.error) {
    throw new Error(json.error.message ?? `RPC error ${json.error.code ?? "unknown"}`);
  }
  if (json.result === undefined) {
    throw new Error(`RPC method ${method} returned empty result`);
  }
  return json.result;
}

export function resolveEvmAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("qor1")) {
    return qorToEvm(trimmed);
  }
  return trimmed;
}

export function formatWeiToQor(weiHexOrDec: string): string {
  try {
    const wei = BigInt(weiHexOrDec);
    const whole = wei / 1_000_000_000_000_000_000n;
    const frac = (wei % 1_000_000_000_000_000_000n) / 1_000_000_000_000_000n; // 3 decimal places
    return `${whole.toLocaleString()}.${frac.toString().padStart(3, "0")} QOR`;
  } catch {
    return "0.000 QOR";
  }
}

export async function fetchBlockNumber(rpcUrl = DIANA_EVM_RPC_URL): Promise<number> {
  const hex = await jsonRpc<string>("eth_blockNumber", [], rpcUrl);
  return Number.parseInt(hex, 16);
}

export async function fetchEvmBalance(address: string, rpcUrl = DIANA_EVM_RPC_URL): Promise<{
  evmAddress: string;
  weiHex: string;
  formattedQor: string;
}> {
  const evmAddress = resolveEvmAddress(address);
  const weiHex = await jsonRpc<string>("eth_getBalance", [evmAddress, "latest"], rpcUrl);
  return {
    evmAddress,
    weiHex,
    formattedQor: formatWeiToQor(weiHex),
  };
}

export async function fetchPqcKeyStatus(address: string, rpcUrl = DIANA_EVM_RPC_URL): Promise<PqcKeyStatus> {
  const evmAddress = resolveEvmAddress(address);
  try {
    const raw = await jsonRpc<Record<string, unknown>>("qor_getPQCKeyStatus", [evmAddress], rpcUrl);
    const registered = Boolean(
      raw?.registered ?? raw?.hasKey ?? raw?.active ?? raw?.publicKey ?? raw?.scheme,
    );
    const algorithm = String(raw?.algorithm ?? raw?.scheme ?? (registered ? "ML-DSA-87" : "Unregistered"));
    return {
      address: evmAddress,
      registered,
      algorithm,
      raw,
    };
  } catch {
    return {
      address: evmAddress,
      registered: false,
      algorithm: "ML-DSA-87 (RPC query unavailable)",
      raw: null,
    };
  }
}

function padAddress32(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function padUint256Hex(val: bigint): string {
  return val.toString(16).padStart(64, "0");
}

export async function callAiRiskScore(
  targetAddress: string,
  amountUqor: string,
  rpcUrl = DIANA_EVM_RPC_URL,
): Promise<QcaiPreflightResult> {
  const evmTarget = resolveEvmAddress(targetAddress);
  const valueWei = BigInt(amountUqor || "0") * 1_000_000_000_000n;
  // ABI-encoded payload (address target, uint256 valueWei)
  const data = `0x${padAddress32(evmTarget)}${padUint256Hex(valueWei)}`;

  try {
    const rawHex = await jsonRpc<string>(
      "eth_call",
      [{ to: AI_RISK_SCORE_ADDRESS, data }, "latest"],
      rpcUrl,
    );
    const clean = rawHex.replace(/^0x/, "");
    if (!clean || /^0+$/.test(clean)) {
      return {
        precompile: "aiRiskScore",
        address: AI_RISK_SCORE_ADDRESS,
        status: "FALLBACK",
        riskScore: 1,
        riskLevel: "LOW (Fallback Baseline)",
        anomalyDetected: false,
        rawHex,
        note: "Precompile returned zero-word on testnet; bounded policy guard remains authoritative.",
      };
    }
    const word = BigInt(`0x${clean.slice(0, 64)}`);
    const score = Number(word % 100n);
    const unsafe = score >= RISK_LEVEL_UNSAFE_THRESHOLD * 25;
    return {
      precompile: "aiRiskScore",
      address: AI_RISK_SCORE_ADDRESS,
      status: "LIVE_PRECOMPILE",
      riskScore: score,
      riskLevel: unsafe ? "ELEVATED" : "SAFE",
      anomalyDetected: unsafe,
      rawHex,
      note: "Live QCAI eth_call response decoded.",
    };
  } catch (err) {
    return {
      precompile: "aiRiskScore",
      address: AI_RISK_SCORE_ADDRESS,
      status: "FALLBACK",
      riskScore: 1,
      riskLevel: "LOW (Fallback)",
      anomalyDetected: false,
      rawHex: "0x",
      note: err instanceof Error ? `Precompile fallback: ${err.message}` : "Precompile fallback active.",
    };
  }
}

export async function callAiAnomalyCheck(
  targetAddress: string,
  amountUqor: string,
  rpcUrl = DIANA_EVM_RPC_URL,
): Promise<QcaiPreflightResult> {
  const evmTarget = resolveEvmAddress(targetAddress);
  const valueWei = BigInt(amountUqor || "0") * 1_000_000_000_000n;
  const data = `0x${padAddress32(evmTarget)}${padUint256Hex(valueWei)}`;

  try {
    const rawHex = await jsonRpc<string>(
      "eth_call",
      [{ to: AI_ANOMALY_CHECK_ADDRESS, data }, "latest"],
      rpcUrl,
    );
    const clean = rawHex.replace(/^0x/, "");
    if (!clean || /^0+$/.test(clean)) {
      return {
        precompile: "aiAnomalyCheck",
        address: AI_ANOMALY_CHECK_ADDRESS,
        status: "FALLBACK",
        riskScore: 0,
        riskLevel: "NORMAL (Fallback Baseline)",
        anomalyDetected: false,
        rawHex,
        note: "Precompile returned zero-word on testnet; deterministic SpendingRule guard enforced.",
      };
    }
    const word = BigInt(`0x${clean.slice(0, 64)}`);
    const flagged = word > 0n;
    return {
      precompile: "aiAnomalyCheck",
      address: AI_ANOMALY_CHECK_ADDRESS,
      status: "LIVE_PRECOMPILE",
      riskScore: flagged ? 80 : 5,
      riskLevel: flagged ? "ANOMALY_FLAGGED" : "NORMAL",
      anomalyDetected: flagged,
      rawHex,
      note: "Live QCAI anomaly precompile decoded.",
    };
  } catch (err) {
    return {
      precompile: "aiAnomalyCheck",
      address: AI_ANOMALY_CHECK_ADDRESS,
      status: "FALLBACK",
      riskScore: 0,
      riskLevel: "NORMAL (Fallback)",
      anomalyDetected: false,
      rawHex: "0x",
      note: err instanceof Error ? `Precompile fallback: ${err.message}` : "Precompile fallback active.",
    };
  }
}
