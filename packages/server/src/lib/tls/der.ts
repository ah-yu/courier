/**
 * Minimal DER writer for the one structure the deployment needs to build itself:
 * a PKCS#10 certification request (see `csr.ts`).
 *
 * `crypto` can generate keys, export an SPKI and verify a signature, but it
 * cannot assemble a CSR, and the server must not carry an ASN.1 dependency or
 * shell out to `openssl` (the compiled binary ships with neither). So the handful of
 * DER shapes a CSR is made of — described in X.690 — are encoded here, bottom-up
 * from `Buffer`s.
 *
 * Everything is definite-length and minimally encoded, which is what DER (as
 * opposed to BER) requires: the length is never padded and never in the
 * indefinite form, and integers drop redundant leading bytes.
 */

/** Identifier octets (tag bytes) for the universal types this module encodes. */
export const DER_TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/**
 * Encode a definite-form DER length: one byte below 128, otherwise `0x80 | n`
 * followed by the length in n big-endian bytes.
 */
export function derLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`DER length must be a non-negative integer, got ${length}`);
  }
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Wrap `content` in a tag-length-value triple. */
export function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** A constructed context-specific tag (`[n]`) — `0xa0` for explicit `[0]`. */
export function derContextTagged(tagNumber: number, content: Buffer, constructed = true): Buffer {
  if (tagNumber < 0 || tagNumber > 30) {
    throw new Error(`only the low context tag numbers are supported, got [${tagNumber}]`);
  }
  return derTlv((constructed ? 0xa0 : 0x80) | tagNumber, content);
}

export function derSequence(...children: Buffer[]): Buffer {
  return derTlv(DER_TAG.SEQUENCE, Buffer.concat(children));
}

export function derSet(...children: Buffer[]): Buffer {
  return derTlv(DER_TAG.SET, Buffer.concat(children));
}

export function derNull(): Buffer {
  return derTlv(DER_TAG.NULL, Buffer.alloc(0));
}

/**
 * DER INTEGER, restricted to the non-negative values a CSR needs (a version
 * number, an OID-adjacent index). Two's complement: a value whose top bit would
 * read as a sign bit gets a leading zero byte.
 */
export function derInteger(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  if (remaining < 0n) {
    throw new Error(`this DER writer only encodes non-negative integers, got ${value}`);
  }
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  } while (remaining > 0n);
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0x00);
  return derTlv(DER_TAG.INTEGER, Buffer.from(bytes));
}

/** Base-128 encode one OID arc, continuation bit on every byte but the last. */
function pushOidArc(bytes: number[], arc: number): void {
  const chunks = [arc % 128];
  for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
    chunks.unshift((rest % 128) | 0x80);
  }
  bytes.push(...chunks);
}

/** Encode a dotted OID (e.g. `1.2.840.113549.1.9.14`), first two arcs combined. */
export function derOid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`invalid OID "${dotted}"`);
    return Number(part);
  });
  if (arcs.length < 2) throw new Error(`invalid OID "${dotted}"`);
  const [first, second, ...rest] = arcs;
  const bytes: number[] = [];
  pushOidArc(bytes, first * 40 + second);
  for (const arc of rest) pushOidArc(bytes, arc);
  return derTlv(DER_TAG.OID, Buffer.from(bytes));
}

export function derUtf8String(value: string): Buffer {
  return derTlv(DER_TAG.UTF8_STRING, Buffer.from(value, "utf8"));
}

export function derOctetString(content: Buffer): Buffer {
  return derTlv(DER_TAG.OCTET_STRING, content);
}

/** BIT STRING: the leading octet counts the unused bits of the last octet. */
export function derBitString(content: Buffer, unusedBits = 0): Buffer {
  if (unusedBits < 0 || unusedBits > 7) throw new Error(`invalid unused-bit count ${unusedBits}`);
  return derTlv(DER_TAG.BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), content]));
}
