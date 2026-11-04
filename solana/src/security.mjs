import { createHash } from "node:crypto";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SECURITY_SOURCE = {
  repository: "https://github.com/solana-program/token-2022",
  revision: "c5d2c28cf997ac880b43ad091c92a794186c4a11",
  files: [
    "interface/src/state.rs",
    "interface/src/extension/mod.rs",
    "interface/src/extension/transfer_fee/mod.rs",
    "interface/src/extension/transfer_hook/mod.rs",
    "interface/src/extension/pausable/mod.rs",
    "interface/src/extension/permanent_delegate.rs",
    "interface/src/extension/permissioned_burn/mod.rs",
  ],
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}
function optionalKey(bytes) {
  return bytes.every((b) => b === 0) ? null : base58(bytes);
}
function authority(bytes, offset) {
  const flag = bytes.readUInt32LE(offset);
  if (flag !== 0 && flag !== 1) throw new Error("INVALID_AUTHORITY_OPTION");
  return flag ? base58(bytes.subarray(offset + 4, offset + 36)) : null;
}
const EXTENSIONS = [
  "Uninitialized",
  "TransferFeeConfig",
  "TransferFeeAmount",
  "MintCloseAuthority",
  "ConfidentialTransferMint",
  "ConfidentialTransferAccount",
  "DefaultAccountState",
  "ImmutableOwner",
  "MemoTransfer",
  "NonTransferable",
  "InterestBearingConfig",
  "CpiGuard",
  "PermanentDelegate",
  "NonTransferableAccount",
  "TransferHook",
  "TransferHookAccount",
  "ConfidentialTransferFeeConfig",
  "ConfidentialTransferFeeAmount",
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "TokenGroup",
  "GroupMemberPointer",
  "TokenGroupMember",
  "ConfidentialMintBurn",
  "ScaledUiAmount",
  "Pausable",
  "PausableAccount",
  "PermissionedBurn",
];
const ACCOUNT_ONLY = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
function extension(type, bytes) {
  const result = {
    type,
    name: EXTENSIONS[type] ?? "UnknownExtension",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    status: "INCOMPLETE",
  };
  const length = (size) => {
    if (bytes.length !== size) throw new Error("INVALID_EXTENSION_LENGTH");
  };
  if (ACCOUNT_ONLY.has(type)) throw new Error("ACCOUNT_EXTENSION_ON_MINT");
  switch (type) {
    case 1: {
      length(108);
      const fee = (off) => ({
        epoch: bytes.readBigUInt64LE(off).toString(),
        maximumFeeRaw: bytes.readBigUInt64LE(off + 8).toString(),
        basisPoints: bytes.readUInt16LE(off + 16),
      });
      Object.assign(result, {
        configAuthority: optionalKey(bytes.subarray(0, 32)),
        withdrawAuthority: optionalKey(bytes.subarray(32, 64)),
        withheldAmountRaw: bytes.readBigUInt64LE(64).toString(),
        olderTransferFee: fee(72),
        newerTransferFee: fee(90),
      });
      if (
        result.olderTransferFee.basisPoints > 10000 ||
        result.newerTransferFee.basisPoints > 10000
      )
        throw new Error("INVALID_TRANSFER_FEE");
      const activeFee = (fee) =>
        fee.basisPoints > 0 && BigInt(fee.maximumFeeRaw) > 0n;
      result.status =
        result.configAuthority ||
        activeFee(result.olderTransferFee) ||
        activeFee(result.newerTransferFee)
          ? "REJECTED"
          : "PASS";
      break;
    }
    case 3:
    case 12:
    case 28:
      length(32);
      result.authority = optionalKey(bytes);
      result.status = result.authority ? "REJECTED" : "PASS";
      break;
    case 6:
      length(1);
      result.defaultAccountState = bytes[0];
      if (![0, 1, 2].includes(bytes[0]))
        throw new Error("INVALID_DEFAULT_ACCOUNT_STATE");
      result.status =
        bytes[0] === 2 ? "REJECTED" : bytes[0] === 1 ? "PASS" : "INCOMPLETE";
      break;
    case 9:
      length(0);
      result.status = "REJECTED";
      break;
    case 14:
      length(64);
      result.authority = optionalKey(bytes.subarray(0, 32));
      result.programId = optionalKey(bytes.subarray(32));
      result.status =
        result.authority || result.programId ? "REJECTED" : "PASS";
      break;
    case 26:
      length(33);
      result.authority = optionalKey(bytes.subarray(0, 32));
      if (bytes[32] > 1) throw new Error("INVALID_PAUSED_FLAG");
      result.paused = bytes[32] === 1;
      result.status = result.paused || result.authority ? "REJECTED" : "PASS";
      break;
    // Display/group metadata cannot prove transfer restrictions absent elsewhere.
    case 18:
    case 20:
    case 22:
      length(64);
      result.authority = optionalKey(bytes.subarray(0, 32));
      result.address = optionalKey(bytes.subarray(32));
      result.status = "PASS";
      break;
  }
  return result;
}

/** Pure SPL mint unpacker. Financial quantities stay decimal integer strings. */
export function decodeMintAccount(account) {
  if (
    !account ||
    account.executable ||
    ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account.owner)
  )
    throw new Error("UNSUPPORTED_MINT_OWNER");
  if (
    !Array.isArray(account.data) ||
    account.data[1] !== "base64" ||
    typeof account.data[0] !== "string" ||
    account.data[0].length > 2 * 1024 * 1024
  )
    throw new Error("BASE64_MINT_REQUIRED");
  const encoded = account.data[0];
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length < 82 ||
    bytes.length === 355 ||
    bytes[45] > 1
  )
    throw new Error("INVALID_MINT_LAYOUT");
  if (account.owner === TOKEN_PROGRAM && bytes.length !== 82)
    throw new Error("INVALID_LEGACY_MINT_LENGTH");
  const extensions = [];
  if (bytes.length > 82) {
    // StateWithExtensions<Mint>: mint(82), zero padding to Account::LEN(165), AccountType::Mint(1), TLV.
    if (
      bytes.length < 166 ||
      bytes[165] !== 1 ||
      bytes.subarray(82, 165).some((b) => b !== 0)
    )
      throw new Error("INVALID_TOKEN2022_MINT_PADDING");
    const seen = new Set();
    let at = 166;
    while (at < bytes.length) {
      if (bytes.subarray(at).every((b) => b === 0)) break;
      if (at + 4 > bytes.length) throw new Error("TRUNCATED_EXTENSION_HEADER");
      const type = bytes.readUInt16LE(at);
      const length = bytes.readUInt16LE(at + 2);
      at += 4;
      if (!type || seen.has(type) || at + length > bytes.length)
        throw new Error("INVALID_EXTENSION_TLV");
      seen.add(type);
      extensions.push(extension(type, bytes.subarray(at, at + length)));
      at += length;
    }
  }
  return {
    tokenProgram: account.owner,
    mintAuthority: authority(bytes, 0),
    freezeAuthority: authority(bytes, 46),
    supplyRaw: bytes.readBigUInt64LE(36).toString(),
    decimals: bytes[44],
    initialized: bytes[45] === 1,
    extensions,
    accountDataSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceSource: SECURITY_SOURCE,
  };
}

function check(status, reason, value = null) {
  return { status, reason, value };
}
/** Event-driven, bounded read. Largest token accounts are a sample, never a holder census. */
export async function inspectMint(
  rpc,
  mint,
  {
    includeLargestAccounts = false,
    now = Date.now,
    creator = null,
    minContextSlot,
  } = {},
) {
  const checkedAt = new Date(
    typeof now === "function" ? now() : now,
  ).toISOString();
  const report = {
    tokenMint: mint,
    checkedAt,
    contextSlot: null,
    status: "UNKNOWN",
    creator,
    policy: "SOLANA_BASELINE_CONSERVATIVE_V1",
    securityConclusion: null,
    tradeApproved: false,
    creatorEvidence: creator
      ? "CALLER_SUPPLIED_REQUIRES_CREATION_EVENT"
      : "UNKNOWN",
    checks: {},
    holders: { status: "INCOMPLETE", ownerDistributionComplete: false },
    liquidity: { status: "UNKNOWN" },
    authorityHistory: {
      status: "INCOMPLETE",
      reason: "CURRENT_ACCOUNT_STATE_ONLY",
    },
    evidenceSource: SECURITY_SOURCE,
  };
  try {
    const opts = {
      encoding: "base64",
      commitment: "confirmed",
      ...(minContextSlot == null ? {} : { minContextSlot }),
    };
    const response = await rpc.request("getAccountInfo", [mint, opts]);
    if (!response?.value) {
      report.error = "MINT_ACCOUNT_UNAVAILABLE";
      return report;
    }
    report.contextSlot = response.context?.slot ?? null;
    report.mint = decodeMintAccount(response.value);
    const data = report.mint;
    report.checks.initialized = check(
      data.initialized ? "PASS" : "REJECTED",
      "MINT_INITIALIZATION",
      data.initialized,
    );
    report.checks.mintAuthority = check(
      data.mintAuthority ? "REJECTED" : "PASS",
      "ADDITIONAL_MINT_AUTHORITY",
      data.mintAuthority,
    );
    report.checks.freezeAuthority = check(
      data.freezeAuthority ? "REJECTED" : "PASS",
      "FREEZE_AUTHORITY",
      data.freezeAuthority,
    );
    report.checks.extensions = check(
      data.extensions.some((e) => e.status === "REJECTED")
        ? "REJECTED"
        : data.extensions.some((e) => e.status !== "PASS")
          ? "INCOMPLETE"
          : "PASS",
      "EXTENSION_RESTRICTIONS",
      data.extensions,
    );
    report.status = Object.values(report.checks).some(
      (c) => c.status === "REJECTED",
    )
      ? "REJECTED"
      : "INCOMPLETE";
    // An authority-free mint still has unknown liquidity, ownership and history.
    if (includeLargestAccounts) {
      try {
        const largest = await rpc.request("getTokenLargestAccounts", [
          mint,
          { commitment: "confirmed" },
        ]);
        if (!Array.isArray(largest?.value) || largest.value.length > 20)
          throw new Error("INVALID_LARGEST_ACCOUNTS");
        const accounts = largest.value.map((a) => {
          if (
            typeof a.address !== "string" ||
            typeof a.amount !== "string" ||
            !/^\d{1,20}$/.test(a.amount) ||
            BigInt(a.amount) > 18446744073709551615n
          )
            throw new Error("INVALID_ACCOUNT_AMOUNT");
          return { address: a.address, amountRaw: a.amount };
        });
        if (new Set(accounts.map((a) => a.address)).size !== accounts.length)
          throw new Error("DUPLICATE_ACCOUNT");
        report.holders = {
          status: "INCOMPLETE",
          ownerDistributionComplete: false,
          accountSample: accounts,
          contextSlot: largest.context?.slot ?? null,
          supplyContextSlot: report.contextSlot,
          sampledAmountRaw: accounts
            .reduce((sum, a) => sum + BigInt(a.amountRaw), 0n)
            .toString(),
          reason:
            "TOP_TOKEN_ACCOUNTS_ARE_NOT_DISTINCT_HOLDERS_AND_CONTEXTS_MAY_DIFFER",
        };
      } catch {
        report.holders.error = "LARGEST_ACCOUNTS_UNAVAILABLE_OR_INVALID";
      }
    }
    return report;
  } catch (error) {
    // Do not persist provider URLs, headers or raw errors carrying credentials.
    const known =
      /^(INVALID_|UNSUPPORTED_|BASE64_|ACCOUNT_EXTENSION_|TRUNCATED_)/.test(
        error.message ?? "",
      );
    report.error = known ? error.message : "MINT_INSPECTION_FAILED";
    return report;
  }
}
