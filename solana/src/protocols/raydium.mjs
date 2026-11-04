// Layouts are pinned in vendor/raydium-*.json; no application-name heuristics.
export const RAYDIUM_LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTES = new Set([WSOL, USDC]);
const variant = (x) =>
  typeof x === "string"
    ? x
    : (x?.variant ?? x?.name ?? (x && Object.keys(x)[0]));
const raw = (x) => (x === null || x === undefined ? null : String(x));
const accounts = (c) =>
  Object.keys(c.namedAccounts ?? {}).length
    ? c.namedAccounts
    : (c.parentNamedAccounts ?? {});
const instructionName = (c) => c.instructionName ?? c.parentInstructionName;
const decimals = (c, mint) => {
  const values = [
    ...(c.tx?.meta?.preTokenBalances ?? []),
    ...(c.tx?.meta?.postTokenBalances ?? []),
  ]
    .filter((x) => x.mint === mint)
    .map((x) => x.uiTokenAmount?.decimals)
    .filter(Number.isInteger);
  return values.length && new Set(values).size === 1
    ? values[0]
    : mint === WSOL
      ? 9
      : null;
};
function base(type, c, extra) {
  const e = {
    eventType: type,
    tokenMint: null,
    quoteMint: null,
    poolAddress: null,
    wallet: null,
    creator: null,
    amountTokenRaw: null,
    amountQuoteRaw: null,
    tokenDecimals: null,
    quoteDecimals: null,
    eventTimestamp:
      c.tx?.blockTime == null
        ? null
        : new Date(c.tx.blockTime * 1000).toISOString(),
    ...extra,
  };
  e.tokenDecimals ??= decimals(c, e.tokenMint);
  e.quoteDecimals ??= decimals(c, e.quoteMint);
  e.completeness =
    e.tokenMint &&
    e.poolAddress &&
    (!["TOKEN_BOUGHT", "TOKEN_SOLD"].includes(type) ||
      (e.wallet &&
        e.quoteMint &&
        e.amountTokenRaw !== null &&
        e.amountQuoteRaw !== null))
      ? "COMPLETE"
      : "INCOMPLETE";
  return e;
}
function oriented(mint0, mint1, amount0, amount1) {
  // A pair with no unique recognised quote stays unattributed, never guesses direction.
  if (QUOTES.has(mint0) === QUOTES.has(mint1)) return null;
  const quote0 = QUOTES.has(mint0);
  return {
    tokenMint: quote0 ? mint1 : mint0,
    quoteMint: quote0 ? mint0 : mint1,
    amountTokenRaw: raw(quote0 ? amount1 : amount0),
    amountQuoteRaw: raw(quote0 ? amount0 : amount1),
    quote0,
  };
}

export function mapRaydium(protocol, name, d, c) {
  const a = accounts(c);
  const launch =
    protocol === "raydium-launchlab" ||
    protocol === "raydium_launchlab" ||
    protocol === "launchlab";
  if (launch) {
    if (name === "PoolCreateEvent") {
      if (a.pool_state !== d.pool_state) return [];
      const common = {
        tokenMint: a.base_mint ?? null,
        quoteMint: a.quote_mint ?? null,
        poolAddress: d.pool_state,
        wallet: a.payer ?? null,
        creator: d.creator,
        tokenDecimals: d.base_mint_param?.decimals ?? null,
        protocolData: {
          name: d.base_mint_param?.name,
          symbol: d.base_mint_param?.symbol,
          curve: d.curve_param,
          vesting: d.vesting_param,
        },
      };
      return [
        base("TOKEN_CREATED", c, common),
        base("POOL_CREATED", c, common),
      ];
    }
    if (name === "TradeEvent") {
      const direction = variant(d.trade_direction);
      if (!["Buy", "Sell"].includes(direction)) return [];
      const matched = a.pool_state === d.pool_state;
      const common = {
        tokenMint: matched ? (a.base_token_mint ?? null) : null,
        quoteMint: matched ? (a.quote_token_mint ?? null) : null,
        poolAddress: d.pool_state,
        wallet: matched ? (a.payer ?? null) : null,
        amountTokenRaw: raw(direction === "Buy" ? d.amount_out : d.amount_in),
        amountQuoteRaw: raw(direction === "Buy" ? d.amount_in : d.amount_out),
        reserves: {
          soldTokenRaw: raw(d.real_base_after),
          raisedQuoteRaw: raw(d.real_quote_after),
          virtualTokenRaw: raw(d.virtual_base),
          virtualQuoteRaw: raw(d.virtual_quote),
          totalBaseSellRaw: raw(d.total_base_sell),
        },
        protocolData: {
          tradeDirection: direction,
          poolStatus: variant(d.pool_status),
          exactIn: d.exact_in,
          protocolFeeRaw: raw(d.protocol_fee),
          platformFeeRaw: raw(d.platform_fee),
          creatorFeeRaw: raw(d.creator_fee),
          shareFeeRaw: raw(d.share_fee),
        },
      };
      const events = [
        base(direction === "Buy" ? "TOKEN_BOUGHT" : "TOKEN_SOLD", c, common),
        base("CURVE_PROGRESS_UPDATED", c, {
          ...common,
          amountTokenRaw: null,
          amountQuoteRaw: null,
        }),
      ];
      if (variant(d.pool_status) === "Migrate")
        events.push(
          base("TOKEN_GRADUATED", c, {
            ...common,
            amountTokenRaw: null,
            amountQuoteRaw: null,
          }),
        );
      return events;
    }
    return [];
  }
  if (name === "SwapEvent") {
    const pair = oriented(
      d.input_mint,
      d.output_mint,
      d.input_amount,
      d.output_amount,
    );
    if (!pair) return []; // observable raw evidence remains available, canonical side cannot be proven.
    const matched =
      a.pool_state === d.pool_id &&
      a.input_token_mint === d.input_mint &&
      a.output_token_mint === d.output_mint;
    return [
      base(pair.quote0 ? "TOKEN_BOUGHT" : "TOKEN_SOLD", c, {
        ...pair,
        poolAddress: d.pool_id,
        wallet: matched ? (a.payer ?? null) : null,
        protocolData: {
          inputMint: d.input_mint,
          outputMint: d.output_mint,
          inputAmountRaw: raw(d.input_amount),
          outputAmountRaw: raw(d.output_amount),
          inputTransferFeeRaw: raw(d.input_transfer_fee),
          outputTransferFeeRaw: raw(d.output_transfer_fee),
          tradeFeeRaw: raw(d.trade_fee),
          creatorFeeRaw: raw(d.creator_fee),
          inputReserveBeforeRaw: raw(d.input_vault_before),
          outputReserveBeforeRaw: raw(d.output_vault_before),
        },
      }),
    ];
  }
  if (name === "LpChangeEvent") {
    if (![0, 1].includes(Number(d.change_type))) return [];
    const matched = a.pool_state === d.pool_id;
    const pair = matched
      ? oriented(
          a.vault_0_mint,
          a.vault_1_mint,
          d.token_0_amount,
          d.token_1_amount,
        )
      : null;
    return [
      base(
        Number(d.change_type) === 0 ? "LIQUIDITY_ADDED" : "LIQUIDITY_REMOVED",
        c,
        {
          ...pair,
          poolAddress: d.pool_id,
          wallet: matched ? (a.owner ?? null) : null,
          protocolData: {
            token0AmountRaw: raw(d.token_0_amount),
            token1AmountRaw: raw(d.token_1_amount),
            token0TransferFeeRaw: raw(d.token_0_transfer_fee),
            token1TransferFeeRaw: raw(d.token_1_transfer_fee),
            lpSupplyBeforeRaw: raw(d.lp_amount_before),
            token0ReserveBeforeRaw: raw(d.token_0_vault_before),
            token1ReserveBeforeRaw: raw(d.token_1_vault_before),
          },
        },
      ),
    ];
  }
  return [];
}

// These successful instructions have no dedicated event in the pinned IDL.
export function mapRaydiumInstruction(protocol, c) {
  const a = accounts(c),
    name = instructionName(c);
  if (
    ["raydium-cpmm", "raydium_cpmm"].includes(protocol) &&
    ["initialize", "initialize_with_permission"].includes(name)
  ) {
    if (!a.pool_state || !a.token_0_mint || !a.token_1_mint) return [];
    const pair = oriented(a.token_0_mint, a.token_1_mint, null, null);
    return [
      base("POOL_CREATED", c, {
        ...pair,
        poolAddress: a.pool_state,
        wallet: a.creator ?? null,
        protocolData: {
          token0Mint: a.token_0_mint,
          token1Mint: a.token_1_mint,
          lpMint: a.lp_mint,
        },
      }),
    ];
  }
  if (
    ["raydium-launchlab", "raydium_launchlab"].includes(protocol) &&
    ["migrate_to_cpswap", "migrate_to_amm"].includes(name)
  ) {
    if (!a.base_mint || !a.pool_state) return [];
    return [
      base("TOKEN_MIGRATED", c, {
        tokenMint: a.base_mint,
        quoteMint: a.quote_mint ?? null,
        poolAddress: a.cpswap_pool ?? a.amm_pool ?? null,
        wallet: a.payer ?? null,
        protocolData: {
          sourcePool: a.pool_state,
          targetProtocol:
            name === "migrate_to_cpswap" ? "raydium-cpmm" : "raydium-amm-v4",
        },
      }),
    ];
  }
  return [];
}
