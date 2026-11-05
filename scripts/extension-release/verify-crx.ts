import { createPublicKey, verify } from "node:crypto";

/** Decode the length-delimited fields used by the CRX3 protobuf messages. */
function fields(bytes: Buffer): Map<number, Buffer[]> {
  let offset = 0;
  const varint = () => {
    let value = 0, scale = 1;
    for (let i = 0; i < 5 && offset < bytes.length; i++) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new Error("Invalid CRX3 protobuf integer");
  };
  const result = new Map<number, Buffer[]>();
  while (offset < bytes.length) {
    const tag = varint();
    if ((tag & 7) !== 2 || tag < 8) throw new Error("Unsupported CRX3 protobuf field");
    const size = varint();
    if (size > bytes.length - offset) throw new Error("Truncated CRX3 protobuf field");
    const values = result.get(tag >>> 3) ?? [];
    values.push(bytes.subarray(offset, offset + size));
    result.set(tag >>> 3, values);
    offset += size;
  }
  return result;
}

/** Verify the CRX3 signer, extension ID, and signature over the complete ZIP payload. */
export function verifyCrx(bytes: Buffer, expectedKey: string, expectedId: string): Buffer {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "Cr24" || bytes.readUInt32LE(4) !== 3) throw new Error("Expected a CRX3 package");
  const end = 12 + bytes.readUInt32LE(8);
  if (end > bytes.length - 4) throw new Error("Truncated CRX3 package");
  const header = fields(bytes.subarray(12, end));
  const signed = header.get(10000)?.[0];
  if (!signed) throw new Error("Missing CRX3 signed header");
  const id = fields(signed).get(1)?.[0];
  const extensionId = id?.toString("hex").replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  if (extensionId !== expectedId) throw new Error("CRX3 extension ID mismatch");
  const proof = (header.get(2) ?? []).map(fields).find(proof => proof.get(1)?.[0]?.toString("base64") === expectedKey);
  const signature = proof?.get(2)?.[0];
  if (!signature) throw new Error("CRX3 signing key mismatch");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signed.length);
  const zip = bytes.subarray(end);
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0"), length, signed, zip]);
  const publicKey = createPublicKey({key: Buffer.from(expectedKey, "base64"), type: "spki", format: "der"});
  if (!verify("sha256", payload, publicKey, signature)) throw new Error("Invalid CRX3 signature");
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error("CRX3 payload is not a ZIP archive");
  return zip;
}
