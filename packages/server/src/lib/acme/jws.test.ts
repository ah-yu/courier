import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";
import { DER_TAG } from "../tls/der";
import {
  base64url,
  base64urlDecode,
  ecdsaDerToRaw,
  jwkThumbprint,
  publicJwk,
  signJws,
  type Jwk,
} from "./jws";

/**
 * The ACME client's own crypto: the ES256 JWS every request is wrapped in.
 *
 * `client.test.ts` drives `signJws` against a fake ACME server and verifies the
 * signatures it receives, so the happy path is pinned end to end. What it cannot
 * reach are the shapes a signature only *sometimes* has: a DER INTEGER that
 * needed a leading zero byte, a malformed length, the wrong number of
 * components. Those are exactly the branches a hand-written DER reader gets
 * wrong, and they surface only for a fraction of signatures (about one in 256
 * per component), so they are pinned here with crafted input instead.
 */

/** A fresh P-256 account key, as `AcmeClient` takes it. */
function accountKey(): { privateKey: crypto.KeyObject; pem: string } {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** The public half, for checking a raw signature. */
function verifier(privateKey: crypto.KeyObject): crypto.KeyObject {
  return crypto.createPublicKey(privateKey);
}

/** One DER element: tag byte, definite length, content. */
function derElement(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  // Long form, one length byte - enough for a signature-sized element.
  return Buffer.concat([Buffer.from([tag, 0x81, content.length]), content]);
}

/** A DER SEQUENCE of two INTEGERs, the shape `crypto.sign` returns for ECDSA. */
function derSignature(r: Buffer, s: Buffer): Buffer {
  return derElement(
    DER_TAG.SEQUENCE,
    Buffer.concat([derElement(DER_TAG.INTEGER, r), derElement(DER_TAG.INTEGER, s)]),
  );
}

describe("base64url", () => {
  it("encodes without padding or the characters JOSE forbids", () => {
    // Every byte value, so the output would contain `+` and `/` if this were plain base64.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const encoded = base64url(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(base64urlDecode(encoded)).toEqual(bytes);
  });

  it("round-trips a string as UTF-8", () => {
    expect(base64urlDecode(base64url("h\u00e9llo")).toString("utf8")).toBe("h\u00e9llo");
  });
});

describe("publicJwk", () => {
  it("exports the four members a thumbprint reads, and never the private one", () => {
    const { privateKey } = accountKey();
    const jwk = publicJwk(privateKey);
    expect(sortedCopy(Object.keys(jwk))).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk).not.toHaveProperty("d");
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
  });

  it("accepts the PEM form the client is configured with", () => {
    const { privateKey, pem } = accountKey();
    expect(publicJwk(pem)).toEqual(publicJwk(privateKey));
  });

  it("refuses a key the client could not sign ES256 with", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => publicJwk(privateKey)).toThrow(/elliptic-curve/);
  });
});

describe("jwkThumbprint", () => {
  it("matches the RFC 7638 test vector", () => {
    // RFC 7638 section 3.1: the canonical JWK is `{"e":...,"kty":"RSA","n":...}` in that
    // member order, and the published thumbprint is the one below. A JSON.stringify of
    // the JWK object would order the members differently and produce another hash.
    const jwk: Jwk = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
    };
    expect(jwkThumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("hashes the EC members of a real account key in lexicographic order", () => {
    const { privateKey } = accountKey();
    const jwk = publicJwk(privateKey);
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = base64url(crypto.createHash("sha256").update(canonical).digest());
    expect(jwkThumbprint(jwk)).toBe(expected);
  });

  it("refuses a key type it cannot canonicalise", () => {
    expect(() => jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: "abc" })).toThrow(
      /cannot build an RFC 7638 thumbprint/,
    );
  });

  it("refuses a key with a required member missing", () => {
    expect(() => jwkThumbprint({ kty: "EC", crv: "P-256", x: "abc" })).toThrow(
      /missing the "y" member/,
    );
  });
});

describe("signJws", () => {
  it("signs the protected header and payload, verifiably and with no extras", () => {
    const { privateKey } = accountKey();
    const header = {
      alg: "ES256",
      nonce: "n-1",
      url: "https://acme.example/new-order",
      jwk: publicJwk(privateKey),
    };
    const jws = signJws({ privateKey, payload: '{"a":1}', header });

    expect(sortedCopy(Object.keys(jws))).toEqual(["payload", "protected", "signature"]);
    expect(JSON.parse(base64urlDecode(jws.protected).toString("utf8"))).toEqual(header);
    expect(base64urlDecode(jws.payload).toString("utf8")).toBe('{"a":1}');
    // The signature is the raw 64-byte `r || s`, not the DER sequence `crypto.sign` returns.
    expect(base64urlDecode(jws.signature)).toHaveLength(64);
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"),
        { key: verifier(privateKey), dsaEncoding: "ieee-p1363" },
        base64urlDecode(jws.signature),
      ),
    ).toBe(true);
  });

  it("signs a POST-as-GET's empty payload, not the string {}", () => {
    const { privateKey } = accountKey();
    const jws = signJws({ privateKey, payload: "", header: { alg: "ES256", nonce: "n-2" } });
    // An empty octet string encodes to an empty base64url string (RFC 8555 section 6.3);
    // `{}` would be `e30` and sign a body the server does not expect on a POST-as-GET.
    expect(jws.payload).toBe("");
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${jws.protected}.`, "ascii"),
        { key: verifier(privateKey), dsaEncoding: "ieee-p1363" },
        base64urlDecode(jws.signature),
      ),
    ).toBe(true);
  });

  it("produces a signature a peer's raw-form verifier accepts, at every payload size", () => {
    const { privateKey } = accountKey();
    for (const payload of ["", "x", "y".repeat(200)]) {
      const jws = signJws({ privateKey, payload, header: { alg: "ES256" } });
      expect(base64urlDecode(jws.signature)).toHaveLength(64);
      expect(
        crypto.verify(
          "sha256",
          Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"),
          { key: verifier(privateKey), dsaEncoding: "ieee-p1363" },
          base64urlDecode(jws.signature),
        ),
      ).toBe(true);
    }
  });
});

describe("ecdsaDerToRaw", () => {
  const size = 32;

  it("strips the leading zero DER adds to a high-bit component", () => {
    // DER INTEGERs are signed, so a 32-byte value whose first byte has the high bit set
    // is encoded with a 0x00 prefix (33 bytes). The raw form drops it and keeps 32.
    const value = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(size - 1, 0x11)]);
    const high = Buffer.concat([Buffer.from([0x00]), value]);
    const other = Buffer.alloc(size, 0x11);
    const raw = ecdsaDerToRaw(derSignature(high, other));
    expect(raw).toHaveLength(64);
    // The prefix is gone and the high bit survives: a converter that stripped to 31
    // bytes, or padded from the wrong side, fails here.
    expect(raw.subarray(0, size).equals(value)).toBe(true);
    expect(raw.subarray(size).equals(other)).toBe(true);
  });

  it("left-pads a short component to the curve width", () => {
    // 5 encodes as one byte; `r || s` is fixed-width, so it becomes 31 zeros and a 5.
    const raw = ecdsaDerToRaw(derSignature(Buffer.from([0x05]), Buffer.from([0x00, 0x00, 0x07])));
    expect(raw).toHaveLength(64);
    expect(raw[size - 1]).toBe(0x05);
    expect(raw[2 * size - 1]).toBe(0x07);
  });

  it("drops redundant leading zeros rather than counting them as width", () => {
    const raw = ecdsaDerToRaw(derSignature(Buffer.from([0x00, 0x00, 0x2a]), Buffer.from([0x01])));
    expect(raw[size - 1]).toBe(0x2a);
    expect(raw[2 * size - 1]).toBe(0x01);
  });

  it("reads a long-form DER length", () => {
    // A SEQUENCE whose content is at least 128 bytes needs the long form; P-256 never
    // reaches it, but the reader must not mis-parse one that does.
    const width = 64;
    const sequence = derSignature(Buffer.alloc(width, 0x01), Buffer.alloc(width, 0x02));
    expect(sequence[1]).toBe(0x81);
    const raw = ecdsaDerToRaw(sequence, width);
    expect(raw).toHaveLength(width * 2);
    expect(raw[0]).toBe(0x01);
    expect(raw[width]).toBe(0x02);
  });

  it("refuses a component longer than the curve order", () => {
    expect(() =>
      ecdsaDerToRaw(derSignature(Buffer.alloc(size + 1, 0x01), Buffer.alloc(size))),
    ).toThrow(/longer than the curve order/);
  });

  it("refuses something that is not a SEQUENCE", () => {
    expect(() => ecdsaDerToRaw(derElement(DER_TAG.SET, Buffer.alloc(2)))).toThrow(
      /not a DER SEQUENCE/,
    );
  });

  it("refuses a component that is not an INTEGER", () => {
    const sequence = derElement(
      DER_TAG.SEQUENCE,
      Buffer.concat([
        derElement(DER_TAG.OCTET_STRING, Buffer.alloc(2)),
        derElement(DER_TAG.INTEGER, Buffer.alloc(size)),
      ]),
    );
    expect(() => ecdsaDerToRaw(sequence)).toThrow(/not a DER INTEGER/);
  });

  it("refuses a signature that does not have exactly two components", () => {
    const three = derElement(
      DER_TAG.SEQUENCE,
      Buffer.concat([
        derElement(DER_TAG.INTEGER, Buffer.alloc(4)),
        derElement(DER_TAG.INTEGER, Buffer.alloc(4)),
        derElement(DER_TAG.INTEGER, Buffer.alloc(4)),
      ]),
    );
    expect(() => ecdsaDerToRaw(three)).toThrow(/exactly two components/);
  });

  it("refuses a truncated element instead of reading past the buffer", () => {
    // A SEQUENCE header promising more content than exists.
    expect(() => ecdsaDerToRaw(Buffer.from([DER_TAG.SEQUENCE, 0x10]))).toThrow();
    // A length byte with no value after it.
    expect(() => ecdsaDerToRaw(Buffer.from([DER_TAG.SEQUENCE, 0x81]))).toThrow(/truncated/);
  });
});
