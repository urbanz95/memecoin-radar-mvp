const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes) {
  const b = Buffer.from(bytes);
  let n = BigInt("0x" + (b.toString("hex") || "0")),
    out = "";
  while (n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const v of b) {
    if (v !== 0) break;
    out = "1" + out;
  }
  return out;
}
export function base58Decode(value) {
  if (typeof value !== "string" || value.length > 200000)
    throw new Error("Invalid base58");
  let n = 0n;
  for (const c of value) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error("Invalid base58");
    n = n * 58n + BigInt(i);
  }
  let b = n
    ? Buffer.from(
        n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0"),
        "hex",
      )
    : Buffer.alloc(0);
  const leading = value.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leading), b]);
}
export function decodeBorsh(fields, buffer, types = []) {
  const b = Buffer.from(buffer);
  let offset = 0;
  const take = (n) => {
    if (n < 0 || offset + n > b.length)
      throw new Error("Truncated Borsh field");
    const v = b.subarray(offset, offset + n);
    offset += n;
    return v;
  };
  const read = (t) => {
    if (typeof t === "string") {
      if (t === "pubkey" || t === "publicKey") return base58Encode(take(32));
      if (t === "bool") {
        const n = take(1)[0];
        if (n > 1) throw new Error("Invalid Borsh bool");
        return !!n;
      }
      if (t === "string") {
        const n = take(4).readUInt32LE();
        if (n > 65536) throw new Error("Borsh string too large");
        return take(n).toString("utf8");
      }
      if (/^[ui](8|16|32|64|128|256)$/.test(t)) {
        const size = Number(t.slice(1)) / 8,
          bytes = take(size);
        let n = 0n;
        for (let i = size - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
        if (t[0] === "i" && bytes[size - 1] & 128) n -= 1n << BigInt(size * 8);
        return size <= 4 ? Number(n) : n.toString();
      }
    }
    if (t?.defined) {
      const name = typeof t.defined === "string" ? t.defined : t.defined.name;
      const type = types.find((x) => x.name === name)?.type;
      if (!type) throw new Error("Unknown Borsh type " + name);
      return read(type);
    }
    if (t?.option) {
      const present = take(1)[0];
      if (present > 1) throw new Error("Invalid option");
      return present ? read(t.option) : null;
    }
    if (t?.array) {
      if (t.array[1] > 4096) throw new Error("Array too large");
      return Array.from({ length: t.array[1] }, () => read(t.array[0]));
    }
    if (t?.vec) {
      const n = take(4).readUInt32LE();
      if (n > 4096) throw new Error("Vector too large");
      return Array.from({ length: n }, () => read(t.vec));
    }
    if (t?.kind === "struct")
      return Object.fromEntries(t.fields.map((f) => [f.name, read(f.type)]));
    if (t?.kind === "enum") {
      const index = take(1)[0],
        v = t.variants[index];
      if (!v) throw new Error("Unknown Borsh enum");
      return {
        variant: v.name,
        ...(v.fields ? { fields: v.fields.map((f) => read(f.type ?? f)) } : {}),
      };
    }
    throw new Error("Unsupported Borsh layout " + JSON.stringify(t));
  };
  const data = {},
    missingFields = [];
  for (const f of fields) {
    if (offset === b.length) missingFields.push(f.name);
    else data[f.name] = read(f.type);
  }
  return { data, missingFields, trailingBytes: b.length - offset };
}
