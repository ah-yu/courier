import crypto from "crypto";
import { isIP } from "net";
import {
  derBitString,
  derContextTagged,
  derInteger,
  derOid,
  derOctetString,
  derSequence,
  derSet,
  derUtf8String,
} from "./der";

/** OIDs a PKCS#10 request for an https certificate needs. */
const OID_COMMON_NAME = "2.5.4.3";
const OID_ORGANIZATION_NAME = "2.5.4.10";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
/** `ecdsa-with-SHA256`: the only signature algorithm this module produces. */
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

export interface CsrOptions {
  /** PKCS#8 PEM of the certificate key (P-256). Its public half goes into the request. */
  privateKeyPem: string;
  /** IPv4/IPv6 literal to put in an `iPAddress` SAN entry. */
  ip?: string;
  /** DNS name to put in a `dNSName` SAN entry. */
  dns?: string;
}

/**
 * Build a PKCS#10 certification request (DER) for one identifier.
 *
 * Let's Encrypt requires the request's SAN set to match the order's identifiers
 * exactly, so this builder encodes exactly the one `ip`/`dns` it is given —
 * never a common name as a fallback SAN, and never both unless both were asked
 * for. The subject's CN repeats the identifier for the benefit of anything that
 * still logs it; the SAN is what a CA validates.
 */
export function createCertificateRequest(options: CsrOptions): Buffer {
  const { privateKeyPem, ip, dns } = options;
  if (!ip && !dns) {
    throw new Error("a certificate request needs at least one of `ip` or `dns`");
  }

  const generalNames: Buffer[] = [];
  if (ip) {
    const bytes = ipToBytes(ip);
    if (!bytes) throw new Error(`"${ip}" is not an IPv4 or IPv6 literal`);
    // GeneralName iPAddress is [7] IMPLICIT OCTET STRING holding the raw address:
    // 4 bytes for IPv4, 16 for IPv6 (RFC 5280 §4.2.1.6).
    generalNames.push(derContextTagged(7, bytes, false));
  }
  if (dns) {
    if (!/^[\x20-\x7e]+$/.test(dns)) throw new Error(`"${dns}" is not an ASCII DNS name`);
    // GeneralName dNSName is [2] IMPLICIT IA5String.
    generalNames.push(derContextTagged(2, Buffer.from(dns, "ascii"), false));
  }

  // Name ::= SEQUENCE OF RDN; RDN ::= SET OF AttributeTypeAndValue. The SAN is
  // what a CA validates, and it carries the identifier either way.
  //
  // A DNS name goes in the CN as well, out of convention. An **IP address must
  // not**: Boulder refuses the request outright — "Error finalizing order :: CSR
  // contains IP address in Common Name" — and the CA/B baseline requirements say
  // the same thing. An address-only request therefore carries a subject with no
  // CN at all (an organization, so the subject stays non-empty: RFC 5280 wants a
  // critical SAN for a genuinely empty subject).
  const subjectAttributes: Buffer[] = [];
  if (dns) {
    subjectAttributes.push(derSequence(derOid(OID_COMMON_NAME), derUtf8String(dns)));
  } else {
    subjectAttributes.push(derSequence(derOid(OID_ORGANIZATION_NAME), derUtf8String("Courier")));
  }
  const subject = derSequence(derSet(...subjectAttributes));

  const subjectPublicKeyInfo = crypto
    .createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "der" });

  // requestedExtensions ::= SEQUENCE { extnID subjectAltName, extnValue OCTET STRING }
  // `critical` is omitted because DEFAULT FALSE; the SAN is not marked critical
  // by CAs for server certificates.
  const extensionRequest = derSequence(
    derSequence(derOid(OID_SUBJECT_ALT_NAME), derOctetString(derSequence(...generalNames))),
  );

  // attributes [0] IMPLICIT SET OF Attribute — the SET tag is replaced by [0],
  // so the DER attribute is tagged `0xa0` with the attribute directly inside.
  const attributes = derContextTagged(
    0,
    derSequence(derOid(OID_EXTENSION_REQUEST), derSet(extensionRequest)),
  );

  const certificationRequestInfo = derSequence(
    derInteger(0), // version v1(0)
    subject,
    subjectPublicKeyInfo,
    attributes,
  );

  // `crypto.sign` returns the DER SEQUENCE { r, s } that a PKCS#10 signature is,
  // so no re-encoding is needed here (the JWS side does need the raw form).
  const signature = crypto.sign("sha256", certificationRequestInfo, privateKeyPem);

  return derSequence(
    certificationRequestInfo,
    derSequence(derOid(OID_ECDSA_WITH_SHA256)), // parameters MUST be absent for ECDSA
    derBitString(signature),
  );
}

/**
 * Convert an IP literal to the raw address bytes a SAN `iPAddress` holds, or
 * null when the value is not an IP literal at all.
 */
export function ipToBytes(value: string): Buffer | null {
  // A zone id ("fe80::1%eth0") scopes a link-local address to one interface and
  // is not part of the address, so it can never appear in a certificate.
  if (value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return ipv4ToBytes(value);
  if (family === 6) return ipv6ToBytes(value);
  return null;
}

function ipv4ToBytes(value: string): Buffer | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes.push(octet);
  }
  return Buffer.from(bytes);
}

/**
 * Convert an IPv6 literal, including `::` compression and an embedded IPv4 tail
 * ("::ffff:127.0.0.1"), to its 16 bytes.
 */
function ipv6ToBytes(value: string): Buffer | null {
  const compression = value.indexOf("::");
  if (compression !== -1 && value.indexOf("::", compression + 1) !== -1) return null;

  const headText = compression === -1 ? value : value.slice(0, compression);
  const tailText = compression === -1 ? null : value.slice(compression + 2);

  const head: number[] = [];
  const tail: number[] = [];
  // An embedded IPv4 address counts as the last two 16-bit groups, so it may
  // only appear in the very last position of the address.
  if (!appendGroups(headText === "" ? [] : headText.split(":"), head, tailText === null)) {
    return null;
  }
  if (tailText !== null && !appendGroups(tailText === "" ? [] : tailText.split(":"), tail, true)) {
    return null;
  }

  if (tailText === null) {
    if (head.length !== 8) return null;
    return groupsToBytes([...head, ...tail]);
  }
  // `::` stands for at least one omitted group; everything it replaces is zero.
  const omittedCount = 8 - head.length - tail.length;
  if (omittedCount < 1) return null;
  const omitted = Array.from({ length: omittedCount }, () => 0);
  return groupsToBytes([...head, ...omitted, ...tail]);
}

function groupsToBytes(groups: number[]): Buffer {
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

/** Append one colon-separated segment's groups; false when it is not valid hex. */
function appendGroups(parts: string[], target: number[], allowEmbeddedIpv4: boolean): boolean {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.includes(".")) {
      if (!allowEmbeddedIpv4 || index !== parts.length - 1) return false;
      const embedded = ipv4ToBytes(part);
      if (!embedded) return false;
      target.push(embedded.readUInt16BE(0), embedded.readUInt16BE(2));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
    target.push(Number.parseInt(part, 16));
  }
  return true;
}
