import crypto from "crypto";
import { DER_TAG } from "../tls/der";

/**
 * The JWS half of ACME (RFC 8555 §6.2): every request the client sends is a
 * flattened JSON Web Signature (RFC 7515 §7.2.2) in ES256, signed with the
 * account key.
 */

/** RFC 7517 JSON Web Key. Only the members a thumbprint reads are typed. */
export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  e?: string;
  n?: string;
}

/** A JWS in the flattened JSON serialization. */
export interface FlattenedJws {
  protected: string;
  payload: string;
  signature: string;
}

/** base64url without padding — the only encoding JOSE uses. */
export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function base64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * The public JWK of the account key, as ACME's `jwk` header carries it. The
 * private member (`d`) is never part of it — this is the object a client sends
 * unauthenticated on `newAccount`, and what the thumbprint is computed over.
 */
export function publicJwk(privateKey: crypto.KeyObject | string): Jwk {
  const exported = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  if (!exported.kty || !exported.crv || !exported.x || !exported.y) {
    throw new Error("ACME account keys must be elliptic-curve keys (the client signs with ES256)");
  }
  return { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
}

/**
 * The required JWK members per key type, in the lexicographic order RFC 7638 §3
 * mandates for the hash input. A key type that is not listed here cannot be
 * thumbprinted, which is exactly the situation ES256-only clients are in.
 */
const THUMBPRINT_MEMBERS: Record<string, readonly (keyof Jwk)[]> = {
  EC: ["crv", "kty", "x", "y"],
  RSA: ["e", "kty", "n"],
};

/**
 * RFC 7638 JWK thumbprint: base64url(SHA-256(canonical JWK)). The canonical
 * form is the required members only, lexicographically ordered, with no
 * whitespace — the exact octet string matters, so the JSON is assembled by hand
 * instead of with `JSON.stringify` of the JWK object.
 */
export function jwkThumbprint(jwk: Jwk): string {
  const members = THUMBPRINT_MEMBERS[jwk.kty];
  if (!members) {
    throw new Error(`cannot build an RFC 7638 thumbprint for key type "${jwk.kty}"`);
  }
  const pairs = members.map((member) => {
    const value = jwk[member];
    if (typeof value !== "string") throw new Error(`JWK is missing the "${member}" member`);
    return `${JSON.stringify(member)}:${JSON.stringify(value)}`;
  });
  return base64url(new Bun.CryptoHasher("sha256").update(`{${pairs.join(",")}}`).digest());
}

/**
 * Sign one flattened JWS with ES256.
 *
 * `payload` is the raw request body: a JSON document for `newAccount`,
 * `newOrder`, `challenge` and `finalize`, and the **empty string** for a
 * POST-as-GET (RFC 8555 §6.3 — an empty octet string, not `"{}"`).
 */
export function signJws(options: {
  privateKey: crypto.KeyObject | string;
  payload: string;
  header: Record<string, unknown>;
}): FlattenedJws {
  const protectedHeader = base64url(JSON.stringify(options.header));
  const payload = base64url(options.payload);
  // The signature covers the ASCII of `protected.payload`.
  const signingInput = Buffer.from(`${protectedHeader}.${payload}`, "ascii");
  const signature = ecdsaDerToRaw(crypto.sign("sha256", signingInput, options.privateKey));
  return { protected: protectedHeader, payload, signature: base64url(signature) };
}

interface DerElement {
  tag: number;
  content: Buffer;
  /** Offset just past this element, for walking a SEQUENCE's children. */
  end: number;
}

/** Read one DER TLV at `offset` (enough of X.690 for the two-integer signature). */
function readDerElement(input: Buffer, offset: number): DerElement {
  const tag = input[offset];
  const first = input[offset + 1];
  if (tag === undefined || first === undefined) throw new Error("truncated DER element");
  let length = first;
  let cursor = offset + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    length = 0;
    for (let index = 0; index < count; index++) {
      const byte = input[cursor + index];
      if (byte === undefined) throw new Error("truncated DER length");
      length = length * 256 + byte;
    }
    cursor += count;
  }
  return { tag, content: input.subarray(cursor, cursor + length), end: cursor + length };
}

/**
 * ES256 signatures travel as the raw 64-byte `r || s` concatenation
 * (RFC 7518 §3.4), while `crypto.sign` returns the DER SEQUENCE { r, s } a
 * certificate uses. Converting here (instead of asking for
 * `dsaEncoding: "ieee-p1363"`) keeps the wire format explicit and testable.
 */
export function ecdsaDerToRaw(signature: Buffer, size = 32): Buffer {
  const sequence = readDerElement(signature, 0);
  if (sequence.tag !== DER_TAG.SEQUENCE) throw new Error("ECDSA signature is not a DER SEQUENCE");

  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < sequence.content.length) {
    const integer = readDerElement(sequence.content, offset);
    if (integer.tag !== DER_TAG.INTEGER) {
      throw new Error("ECDSA signature component is not a DER INTEGER");
    }
    let value = integer.content;
    // An INTEGER is signed, so a leading 0x00 byte can be padding rather than
    // part of the value; the raw form is fixed-width per component.
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new Error("ECDSA component is longer than the curve order");
    parts.push(Buffer.concat([Buffer.alloc(size - value.length), value]));
    offset = integer.end;
  }
  if (parts.length !== 2) throw new Error("an ECDSA signature has exactly two components");
  return Buffer.concat(parts);
}
