import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { createCertificateRequest, ipToBytes } from "./csr";

/**
 * An independent, minimal DER reader.
 *
 * The point of this file is to check the encoder against something other than
 * itself, so the parser below is written from X.690 rather than shared with
 * `der.ts`: it walks tag-length-value triples, keeps absolute offsets (so a
 * byte can be patched and the signature re-checked), and knows nothing about
 * certificate requests.
 */
interface DerElement {
  tag: number;
  /** The content octets. */
  content: Buffer;
  /** Absolute offset of the tag octet in the buffer the element came from. */
  tlvStart: number;
  /** Absolute offset of the content in the buffer the element came from. */
  start: number;
  /** Absolute offset just past the element. */
  end: number;
}

function readElement(input: Buffer, offset: number): DerElement {
  const tag = input[offset];
  const first = input[offset + 1];
  if (tag === undefined || first === undefined) throw new Error("test parser: truncated element");
  let length = first;
  let start = offset + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    length = 0;
    for (let index = 0; index < count; index++) {
      const byte = input[start + index];
      if (byte === undefined) throw new Error("test parser: truncated length");
      length = length * 256 + byte;
    }
    start += count;
  }
  return {
    tag,
    content: input.subarray(start, start + length),
    tlvStart: offset,
    start,
    end: start + length,
  };
}

/** The direct children of `element`, addressed in the same buffer. */
function childrenOf(root: Buffer, element: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let offset = element.start;
  while (offset < element.end) {
    const child = readElement(root, offset);
    children.push(child);
    offset = child.end;
  }
  return children;
}

function oidToString(element: DerElement): string {
  const first = element.content[0];
  if (first === undefined) throw new Error("test parser: empty OID");
  const arcs = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of element.content.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

function utf8String(element: DerElement): string {
  return element.content.toString("utf8");
}

/** The subject's common name, with its offsets so a test can patch it. */
function commonName(root: Buffer, tbs: DerElement): DerElement {
  const subject = childrenOf(root, tbs)[1];
  const rdn = childrenOf(root, subject)[0];
  const attribute = childrenOf(root, rdn)[0];
  const [type, value] = childrenOf(root, attribute);
  expect(oidToString(type)).toBe("2.5.4.3");
  return value;
}

/** The subjectAltName entries of the requested extensions. */
function subjectAltNames(root: Buffer, tbs: DerElement): DerElement[] {
  const attributes = childrenOf(root, tbs)[3];
  expect(attributes.tag).toBe(0xa0); // [0] IMPLICIT SET OF Attribute
  const attribute = childrenOf(root, attributes)[0];
  const [attributeType, values] = childrenOf(root, attribute);
  expect(oidToString(attributeType)).toBe("1.2.840.113549.1.9.14"); // extensionRequest
  const extensions = childrenOf(root, childrenOf(root, values)[0]);
  const sanExtension = extensions.find(
    (extension) => oidToString(childrenOf(root, extension)[0]) === "2.5.29.17",
  );
  if (!sanExtension) throw new Error("test parser: no subjectAltName extension");
  const extnValue = childrenOf(root, sanExtension)[1];
  // The OCTET STRING's content is the DER of GeneralNames, starting exactly at
  // `extnValue.start` in the same buffer.
  return childrenOf(root, readElement(root, extnValue.start));
}

function verifyRequest(der: Buffer, publicKey: crypto.KeyObject): boolean {
  const request = readElement(der, 0);
  expect(request.tag).toBe(0x30);
  const [tbs, algorithm, signature] = childrenOf(der, request);
  expect(algorithm.tag).toBe(0x30);
  expect(signature.tag).toBe(0x03);
  const signatureBytes = signature.content.subarray(1); // drop the unused-bits octet
  // A PKCS#10 signature covers the DER of the whole `CertificationRequestInfo`
  // element — tag and length included — so the slice starts at the tag octet,
  // not at the content.
  return crypto.verify("sha256", der.subarray(tbs.tlvStart, tbs.end), publicKey, signatureBytes);
}

/** A fresh P-256 key pair, as the deployment generates one. */
function generateKey(): { privateKeyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

describe("createCertificateRequest", () => {
  it("builds a verifiable request whose SAN holds the IP address", () => {
    const { privateKeyPem, publicKey } = generateKey();
    const der = createCertificateRequest({ privateKeyPem, ip: "127.0.0.1" });

    // The signature covers the CertificationRequestInfo and verifies with the
    // public half of the key that signed it.
    expect(verifyRequest(der, publicKey)).toBe(true);

    const request = readElement(der, 0);
    const [tbs, algorithm, signature] = childrenOf(der, request);

    // ecdsa-with-SHA256, parameters absent (RFC 5758 §3.2).
    expect(oidToString(childrenOf(der, algorithm)[0])).toBe("1.2.840.10045.4.3.2");
    expect(childrenOf(der, algorithm)).toHaveLength(1);
    expect(signature.content[0]).toBe(0); // no unused bits

    const [version, , spki, attributes] = childrenOf(der, tbs);
    expect(version.content).toEqual(Buffer.from([0]));
    expect(attributes.tag).toBe(0xa0);

    // The SPKI element is exactly what `crypto` exports for the same key
    // (`export` returns the DER including the SEQUENCE header).
    expect(der.subarray(spki.tlvStart, spki.end)).toEqual(
      crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "der" }),
    );

    // **No common name for an IP address.** Boulder refuses the request
    // otherwise ("CSR contains IP address in Common Name"), which is a rule no
    // amount of well-formed DER can satisfy: the address belongs in the SAN.
    const subject = childrenOf(der, tbs)[1];
    const subjectAttributes = childrenOf(der, childrenOf(der, subject)[0]);
    const attributeOids = subjectAttributes.map((attribute) =>
      oidToString(childrenOf(der, attribute)[0]),
    );
    expect(attributeOids).not.toContain("2.5.4.3"); // commonName
    expect(attributeOids).toContain("2.5.4.10"); // organizationName
    expect(utf8String(childrenOf(der, subjectAttributes[0])[1])).toBe("Courier");

    // One identifier in, one SAN entry out, and iPAddress is the raw 4 bytes.
    const entries = subjectAltNames(der, tbs);
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe(0x87); // [7] IMPLICIT OCTET STRING
    expect(entries[0].content).toEqual(Buffer.from([127, 0, 0, 1]));
  });

  it("carries a dNSName entry for a DNS identifier", () => {
    const { privateKeyPem, publicKey } = generateKey();
    const der = createCertificateRequest({ privateKeyPem, dns: "vault.example.com" });

    expect(verifyRequest(der, publicKey)).toBe(true);
    const tbs = childrenOf(der, readElement(der, 0))[0];
    expect(utf8String(commonName(der, tbs))).toBe("vault.example.com");

    const entries = subjectAltNames(der, tbs);
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe(0x82); // [2] IMPLICIT IA5String
    expect(entries[0].content.toString("ascii")).toBe("vault.example.com");
  });

  it("encodes an IPv6 identifier as 16 raw bytes", () => {
    const { privateKeyPem } = generateKey();
    const tbs = (der: Buffer) => childrenOf(der, readElement(der, 0))[0];

    const plain = createCertificateRequest({ privateKeyPem, ip: "2001:db8::1" });
    expect(subjectAltNames(plain, tbs(plain))[0].content).toEqual(
      Buffer.from("20010db8000000000000000000000001", "hex"),
    );

    const mapped = createCertificateRequest({ privateKeyPem, ip: "::ffff:127.0.0.1" });
    expect(subjectAltNames(mapped, tbs(mapped))[0].content).toEqual(
      Buffer.from("00000000000000000000ffff7f000001", "hex"),
    );
  });

  it("fails verification when the subject name is patched (the parser really sees it)", () => {
    const { privateKeyPem, publicKey } = generateKey();
    // A DNS identifier: the subject of an IP request has no CN to patch, by
    // design, so the subject that can be patched is the DNS one.
    const der = createCertificateRequest({ privateKeyPem, dns: "vault.example.com" });

    // Positive control for the negative below: the untouched request verifies.
    expect(verifyRequest(der, publicKey)).toBe(true);

    const tbs = childrenOf(der, readElement(der, 0))[0];
    const name = commonName(der, tbs);
    expect(utf8String(name)).toBe("vault.example.com");

    // Same length, so the DER structure (and every offset) stays intact: the
    // only thing that changed is a byte the signature covers.
    const patched = Buffer.from(der);
    patched.write("vault.example.org", name.start, "utf8");

    const patchedTbs = childrenOf(patched, readElement(patched, 0))[0];
    expect(patchedTbs.content.length).toBe(tbs.content.length);
    expect(utf8String(commonName(patched, patchedTbs))).toBe("vault.example.org");
    expect(verifyRequest(patched, publicKey)).toBe(false);
  });

  it("refuses a request with no identifier", () => {
    const { privateKeyPem } = generateKey();
    expect(() => createCertificateRequest({ privateKeyPem })).toThrow(/ip.*dns|dns.*ip/);
    expect(() => createCertificateRequest({ privateKeyPem, ip: "not-an-ip" })).toThrow(
      /not an IPv4 or IPv6/,
    );
  });
});

describe("ipToBytes", () => {
  it("encodes IPv4 and IPv6 literals", () => {
    expect(ipToBytes("203.0.113.7")).toEqual(Buffer.from([203, 0, 113, 7]));
    expect(ipToBytes("::1")).toEqual(Buffer.from("00000000000000000000000000000001", "hex"));
    expect(ipToBytes("fe80::")).toEqual(Buffer.from("fe800000000000000000000000000000", "hex"));
    // An IPv6 address without `::` can still end in an embedded IPv4 address.
    expect(ipToBytes("0:0:0:0:0:ffff:1.2.3.4")).toEqual(
      Buffer.from("00000000000000000000ffff01020304", "hex"),
    );
  });

  it("rejects anything that is not an address", () => {
    expect(ipToBytes("vault.example.com")).toBeNull();
    expect(ipToBytes("999.1.1.1")).toBeNull();
    expect(ipToBytes("1.2.3")).toBeNull();
    expect(ipToBytes("fe80::1%eth0")).toBeNull();
    expect(ipToBytes("2001:db8:::1")).toBeNull();
  });
});
