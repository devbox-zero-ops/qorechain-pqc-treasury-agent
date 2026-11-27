export const MAX_EVM_WINDOW_BLOCKS = 17280;
export const MAX_EVM_WINDOW_TXS = 1000;
export const MAX_EVM_WINDOW_TARGETS = 16;
export const WEI_PER_UQOR = 1_000_000_000_000n; // 10^12 wei = 1 uqor (10^6 uqor = 1 QOR = 10^18 wei)

export interface EvmWindowParams {
  blocks: number;
  maxTxs: number;
  maxValueUqor: string;
  nativeOnly: boolean;
  allowedTargets: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SpendingRule {
  perTxLimitUqor: string;
  dailyLimitUqor: string;
  allowedDenoms: string[];
  allowedTargets: string[];
}

export interface AgentIntent {
  id?: string;
  strategy: "DCA" | "BILL_PAYER" | "EVM_REBALANCE" | string;
  target: string;
  amountUqor: string;
  denom: string;
  memo?: string;
  calldataHex?: string;
  gasLimit?: string;
  maxFeePerGasWei?: string;
}

export interface IntentEvaluation {
  decision: "APPROVED" | "BLOCKED";
  codes: string[];
  reasons: string[];
  requestedUqor: string;
  projectedDailySpentUqor: string;
  remainingDailyLimitUqor: string;
  evmBudgetUqor?: string;
}

export interface AuthenticatorLinkInput {
  account: string;
  authenticatorType: "Ed25519" | "Secp256k1" | string;
  pubkeyHex: string;
  chainId: string;
  nonce: number | string;
  label?: string;
}

export function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

export function isValidQorAddress(addr: string): boolean {
  return /^qor1[0-9a-z]{38,58}$/.test(addr.trim());
}

export function isValidTargetAddress(addr: string): boolean {
  return isValidEvmAddress(addr) || isValidQorAddress(addr);
}

export function parsePositiveBigInt(value: string | number | bigint, fieldName: string): bigint {
  try {
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) {
      throw new Error(`${fieldName} must be a non-negative integer`);
    }
    const n = BigInt(s);
    if (n <= 0n) {
      throw new Error(`${fieldName} must be greater than 0`);
    }
    return n;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : `${fieldName} is invalid`);
  }
}

export function parseNonNegativeBigInt(value: string | number | bigint, fieldName: string): bigint {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return BigInt(s);
}

/**
 * Computes the worst-case uqor budget for an EVM transaction:
 * ceil((valueWei + gasLimit * maxFeePerGas) / 1e12)
 */
export function computeEvmBudgetUqor(
  valueWei: string | bigint,
  gasLimit: string | bigint,
  maxFeePerGasWei: string | bigint,
): bigint {
  const v = typeof valueWei === "bigint" ? valueWei : parseNonNegativeBigInt(valueWei, "valueWei");
  const g = typeof gasLimit === "bigint" ? gasLimit : parseNonNegativeBigInt(gasLimit, "gasLimit");
  const f =
    typeof maxFeePerGasWei === "bigint"
      ? maxFeePerGasWei
      : parseNonNegativeBigInt(maxFeePerGasWei, "maxFeePerGasWei");

  const totalWei = v + g * f;
  if (totalWei === 0n) return 0n;
  return (totalWei + WEI_PER_UQOR - 1n) / WEI_PER_UQOR;
}

export function validateEvmWindowParams(params: EvmWindowParams): ValidationResult {
  const errors: string[] = [];

  if (!Number.isInteger(params.blocks) || params.blocks < 1 || params.blocks > MAX_EVM_WINDOW_BLOCKS) {
    errors.push(`blocks must be an integer between 1 and ${MAX_EVM_WINDOW_BLOCKS}.`);
  }

  if (!Number.isInteger(params.maxTxs) || params.maxTxs < 1 || params.maxTxs > MAX_EVM_WINDOW_TXS) {
    errors.push(`maxTxs must be an integer between 1 and ${MAX_EVM_WINDOW_TXS}.`);
  }

  try {
    parsePositiveBigInt(params.maxValueUqor, "maxValueUqor");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "maxValueUqor must be > 0 uqor.");
  }

  if (params.allowedTargets.length > MAX_EVM_WINDOW_TARGETS) {
    errors.push(`allowedTargets cannot exceed ${MAX_EVM_WINDOW_TARGETS} addresses.`);
  }

  const seen = new Set<string>();
  for (const raw of params.allowedTargets) {
    const trimmed = raw.trim();
    if (!isValidEvmAddress(trimmed)) {
      errors.push(`Invalid EVM target address: "${raw}". Expected 0x followed by 40 hex chars.`);
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      errors.push(`Duplicate EVM target address: "${trimmed}".`);
    }
    seen.add(lower);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateSpendingRule(rule: SpendingRule): ValidationResult {
  const errors: string[] = [];
  let perTx = 0n;
  let daily = 0n;

  try {
    perTx = parsePositiveBigInt(rule.perTxLimitUqor, "perTxLimitUqor");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Invalid perTxLimitUqor.");
  }

  try {
    daily = parsePositiveBigInt(rule.dailyLimitUqor, "dailyLimitUqor");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Invalid dailyLimitUqor.");
  }

  if (perTx > 0n && daily > 0n && daily < perTx) {
    errors.push("dailyLimitUqor must be greater than or equal to perTxLimitUqor.");
  }

  if (!Array.isArray(rule.allowedDenoms) || rule.allowedDenoms.length === 0) {
    errors.push("allowedDenoms must include at least one denomination (e.g. uqor).");
  }

  for (const target of rule.allowedTargets) {
    if (!isValidTargetAddress(target)) {
      errors.push(`Invalid target address in spending rule: "${target}".`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function normalizeTarget(addr: string): string {
  const trimmed = addr.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

export function evaluateAgentIntent(
  rule: SpendingRule,
  intent: AgentIntent,
  dailySpentSoFarUqor = "0",
  evmWindow?: EvmWindowParams,
): IntentEvaluation {
  const codes: string[] = [];
  const reasons: string[] = [];

  const ruleCheck = validateSpendingRule(rule);
  if (!ruleCheck.valid) {
    codes.push("INVALID_RULE");
    reasons.push(...ruleCheck.errors);
  }

  let amount = 0n;
  try {
    amount = parsePositiveBigInt(intent.amountUqor, "amountUqor");
  } catch (err) {
    codes.push("INVALID_AMOUNT");
    reasons.push(err instanceof Error ? err.message : "Invalid intent amount.");
  }

  let spent = 0n;
  try {
    spent = parseNonNegativeBigInt(dailySpentSoFarUqor, "dailySpentSoFarUqor");
  } catch (err) {
    codes.push("INVALID_DAILY_SPENT");
    reasons.push(err instanceof Error ? err.message : "Invalid dailySpentSoFarUqor.");
  }

  if (!rule.allowedDenoms.includes(intent.denom)) {
    codes.push("DENOM_NOT_ALLOWED");
    reasons.push(`Denomination "${intent.denom}" is not in allowedDenoms [${rule.allowedDenoms.join(", ")}].`);
  }

  if (!isValidTargetAddress(intent.target)) {
    codes.push("INVALID_TARGET");
    reasons.push(`Target "${intent.target}" is not a valid qor1... or 0x... address.`);
  } else if (rule.allowedTargets.length > 0) {
    const allowedSet = new Set(rule.allowedTargets.map(normalizeTarget));
    if (!allowedSet.has(normalizeTarget(intent.target))) {
      codes.push("UNAUTHORIZED_TARGET");
      reasons.push(`Target ${intent.target} is not in the on-chain SpendingRule allowlist.`);
    }
  }

  let perTxLimit = 0n;
  let dailyLimit = 0n;
  try {
    perTxLimit = parsePositiveBigInt(rule.perTxLimitUqor, "perTxLimitUqor");
    dailyLimit = parsePositiveBigInt(rule.dailyLimitUqor, "dailyLimitUqor");
  } catch {
    // Already captured by validateSpendingRule
  }

  if (amount > 0n && perTxLimit > 0n && amount > perTxLimit) {
    codes.push("PER_TX_LIMIT_EXCEEDED");
    reasons.push(`Requested ${amount.toString()} uqor exceeds per-tx cap of ${perTxLimit.toString()} uqor.`);
  }

  const projectedDaily = spent + amount;
  if (amount > 0n && dailyLimit > 0n && projectedDaily > dailyLimit) {
    codes.push("DAILY_LIMIT_EXCEEDED");
    reasons.push(
      `Projected 24h spend (${projectedDaily.toString()} uqor) exceeds daily cap of ${dailyLimit.toString()} uqor.`,
    );
  }

  let evmBudgetUqor: string | undefined;
  if (evmWindow) {
    const winCheck = validateEvmWindowParams(evmWindow);
    if (!winCheck.valid) {
      codes.push("INVALID_EVM_WINDOW");
      reasons.push(...winCheck.errors);
    }

    if (evmWindow.nativeOnly && intent.calldataHex && intent.calldataHex !== "0x") {
      codes.push("EVM_NATIVE_ONLY_VIOLATION");
      reasons.push("Scoped EVM Window has nativeOnly=true; contract calldata is prohibited.");
    }

    if (evmWindow.allowedTargets.length > 0 && isValidEvmAddress(intent.target)) {
      const winTargets = new Set(evmWindow.allowedTargets.map((t) => t.trim().toLowerCase()));
      if (!winTargets.has(intent.target.trim().toLowerCase())) {
        codes.push("EVM_WINDOW_TARGET_DENIED");
        reasons.push(`EVM target ${intent.target} is outside the Scoped EVM Window allowlist.`);
      }
    }

    if (amount > 0n) {
      const valueWei = amount * WEI_PER_UQOR;
      const gasLimit = intent.gasLimit ? parseNonNegativeBigInt(intent.gasLimit, "gasLimit") : 21000n;
      const maxFee = intent.maxFeePerGasWei
        ? parseNonNegativeBigInt(intent.maxFeePerGasWei, "maxFeePerGasWei")
        : 20_000_000_000n;
      const budget = computeEvmBudgetUqor(valueWei, gasLimit, maxFee);
      evmBudgetUqor = budget.toString();

      try {
        const winMax = parsePositiveBigInt(evmWindow.maxValueUqor, "maxValueUqor");
        if (budget > winMax) {
          codes.push("EVM_WINDOW_BUDGET_EXCEEDED");
          reasons.push(
            `Worst-case EVM fee+value budget (${budget.toString()} uqor) exceeds window maxValue (${winMax.toString()} uqor).`,
          );
        }
      } catch {
        // Already captured by validateEvmWindowParams
      }
    }
  }

  const remaining = dailyLimit > projectedDaily ? dailyLimit - projectedDaily : 0n;

  return {
    decision: codes.length === 0 ? "APPROVED" : "BLOCKED",
    codes,
    reasons,
    requestedUqor: amount.toString(),
    projectedDailySpentUqor: projectedDaily.toString(),
    remainingDailyLimitUqor: remaining.toString(),
    ...(evmBudgetUqor !== undefined ? { evmBudgetUqor } : {}),
  };
}

export function buildMsgOpenEvmWindow(granter: string, params: EvmWindowParams) {
  return {
    typeUrl: "/qorechain.evm.v1.MsgOpenEVMWindow",
    value: {
      granter,
      blocks: params.blocks,
      maxTxs: params.maxTxs,
      maxValue: {
        denom: "uqor",
        amount: params.maxValueUqor,
      },
      nativeOnly: params.nativeOnly,
      allowedTargets: params.allowedTargets.map((t) => t.trim()),
    },
  };
}

export function buildMsgCloseEvmWindow(granter: string) {
  return {
    typeUrl: "/qorechain.evm.v1.MsgCloseEVMWindow",
    value: {
      granter,
    },
  };
}

export function buildAuthenticatorLinkMessage(input: AuthenticatorLinkInput): string {
  const cleanPubkey = input.pubkeyHex.trim().replace(/^0x/i, "").toLowerCase();
  const label = (input.label ?? "qoreagent-treasury-bot").trim();
  return [
    "QoreChain authenticator link v1",
    `chain_id: ${input.chainId.trim()}`,
    `account: ${input.account.trim()}`,
    `authenticator_type: ${input.authenticatorType.trim()}`,
    `pubkey_hex: ${cleanPubkey}`,
    `label: ${label}`,
    `nonce: ${String(input.nonce).trim()}`,
  ].join("\n");
}
