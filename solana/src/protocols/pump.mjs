export const SOL_MINT = "So11111111111111111111111111111111111111112";
const value = (...xs) => xs.find((x) => x !== undefined && x !== null) ?? null;
export function mapPump(protocol, name, d, c) {
  const candidates = [c.namedAccounts, c.parentNamedAccounts].filter(Boolean);
  // Instruction-only mints must belong to the pool proven by the binary event.
  // Unknown nesting/stackHeight is not evidence that an outer pool owns this trade.
  const accounts =
    protocol === "pump_swap"
      ? (candidates.find((a) => d.pool && a.pool === d.pool) ?? {})
      : (c.parentNamedAccounts ?? c.namedAccounts ?? {});
  const common = {
    tokenMint: value(d.mint, d.base_mint, accounts.base_mint, accounts.mint),
    quoteMint: value(d.quote_mint, accounts.quote_mint),
    poolAddress: value(
      d.pool,
      d.bonding_curve,
      accounts.pool,
      accounts.bonding_curve,
    ),
    wallet: value(d.user),
    creator:
      protocol === "pump_swap"
        ? d.coin_creator &&
          d.coin_creator !== "11111111111111111111111111111111"
          ? d.coin_creator
          : null
        : value(d.creator),
    amountTokenRaw: null,
    amountQuoteRaw: null,
    tokenDecimals: value(d.base_mint_decimals),
    quoteDecimals: value(d.quote_mint_decimals),
    eventTimestamp:
      d.timestamp !== undefined
        ? new Date(Number(d.timestamp) * 1000).toISOString()
        : null,
    reserves: {},
  };
  if (common.quoteMint === "11111111111111111111111111111111") {
    common.protocolQuoteMint = common.quoteMint;
    common.quoteMint = accounts.quote_mint ?? null;
    common.quoteMintEvidence = common.quoteMint
      ? "instruction_quote_mint"
      : null;
  }
  if (common.quoteMint === SOL_MINT && common.quoteDecimals == null)
    common.quoteDecimals = 9;
  if (protocol === "pump_swap" && name === "CreatePoolEvent") {
    common.wallet = d.creator ?? null;
    common.poolCreator = d.creator ?? null;
  }
  if (protocol === "pump_swap" && (!common.tokenMint || !common.quoteMint))
    common.completeness = "INCOMPLETE";
  const event = (eventType, extra = {}) => ({ ...common, eventType, ...extra });
  if (protocol === "pump_fun") {
    // Old event layouts predate quote_mint; they only priced native SOL. Explicitly
    // infer SOL only for legacy instruction variants, never a newer truncated event.
    if (
      !common.quoteMint &&
      ["buy", "sell", "buy_exact_sol_in", "create", "migrate"].includes(
        c.parentInstructionName ?? c.instructionName,
      )
    )
      common.quoteMint = SOL_MINT;
    const reserves = {
      virtualTokenRaw: value(d.virtual_token_reserves),
      virtualQuoteRaw: value(d.virtual_quote_reserves, d.virtual_sol_reserves),
      realTokenRaw: value(d.real_token_reserves),
      realQuoteRaw: value(d.real_quote_reserves, d.real_sol_reserves),
    };
    if (name === "CreateEvent" && d.mint && d.user)
      return [
        event("TOKEN_CREATED", {
          name: d.name,
          symbol: d.symbol,
          uri: d.uri,
          tokenProgram: d.token_program ?? null,
          reserves,
          totalSupplyRaw: d.token_total_supply ?? null,
        }),
      ];
    if (
      name === "TradeEvent" &&
      d.mint &&
      typeof d.is_buy === "boolean" &&
      d.token_amount !== undefined
    ) {
      const trade = event(d.is_buy ? "TOKEN_BOUGHT" : "TOKEN_SOLD", {
        amountTokenRaw: d.token_amount,
        amountQuoteRaw: value(d.quote_amount, d.sol_amount),
        reserves,
        financialSemantics:
          "protocol_trade_amount_excludes_separately_reported_fees",
      });
      return [
        trade,
        event("CURVE_PROGRESS_UPDATED", { reserves, graduationProgress: null }),
      ];
    }
    if (name === "PostCompleteBuyEvent" && d.mint)
      return [
        event("TOKEN_BOUGHT", {
          amountTokenRaw: d.base_out,
          amountQuoteRaw: d.quote_in,
          reserves: {
            realTokenRaw: d.pool_base_reserves_after,
            realQuoteRaw: d.pool_quote_reserves_after,
          },
        }),
      ];
    if (name === "CompleteEvent" && d.mint) return [event("TOKEN_GRADUATED")];
    if (name === "CompletePumpAmmMigrationEvent" && d.mint && d.pool)
      return [
        event("TOKEN_MIGRATED", {
          amountTokenRaw: d.mint_amount,
          amountQuoteRaw: d.sol_amount,
          destinationProtocol: "pump_swap",
        }),
      ];
  }
  if (protocol === "pump_swap") {
    common.reserves = {
      realTokenRaw: value(d.pool_base_token_reserves, d.pool_base_amount),
      realQuoteRaw: value(d.pool_quote_token_reserves, d.pool_quote_amount),
      virtualQuoteRaw: value(d.virtual_quote_reserves),
    };
    if (name === "CreatePoolEvent" && d.pool && d.base_mint && d.quote_mint)
      return [
        event("POOL_CREATED", {
          amountTokenRaw: d.base_amount_in,
          amountQuoteRaw: d.quote_amount_in,
          reserves: common.reserves,
        }),
      ];
    if (name === "BuyEvent" && d.pool && d.base_amount_out !== undefined)
      return [
        event("TOKEN_BOUGHT", {
          amountTokenRaw: d.base_amount_out,
          amountQuoteRaw: value(d.user_quote_amount_in, d.quote_amount_in),
          reserves: common.reserves,
          financialSemantics: "user_quote_including_reported_fees",
        }),
      ];
    if (name === "SellEvent" && d.pool && d.base_amount_in !== undefined)
      return [
        event("TOKEN_SOLD", {
          amountTokenRaw: d.base_amount_in,
          amountQuoteRaw: value(d.user_quote_amount_out, d.quote_amount_out),
          reserves: common.reserves,
          financialSemantics: "user_quote_after_reported_fees",
        }),
      ];
    if (name === "DepositEvent" && d.pool)
      return [
        event("LIQUIDITY_ADDED", {
          amountTokenRaw: d.base_amount_in,
          amountQuoteRaw: d.quote_amount_in,
          reserves: common.reserves,
        }),
      ];
    if (name === "WithdrawEvent" && d.pool)
      return [
        event("LIQUIDITY_REMOVED", {
          amountTokenRaw: d.base_amount_out,
          amountQuoteRaw: d.quote_amount_out,
          reserves: common.reserves,
        }),
      ];
  }
  return [];
}
