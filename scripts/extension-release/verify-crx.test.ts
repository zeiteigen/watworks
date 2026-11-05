import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyCrx } from "./verify-crx.js";

const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength:2048});
const key = publicKey.export({type:"spki",format:"der"});
const rawId = createHash("sha256").update(key).digest().subarray(0,16);
const id = rawId.toString("hex").replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char,16)));
function integer(value: number): Buffer {
  const bytes: number[] = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  return Buffer.from(bytes);
}
function field(tag: number, value: Buffer): Buffer { return Buffer.concat([integer(tag * 8 + 2), integer(value.length), value]); }
function packageBytes(): Buffer {
  const signed = field(1,rawId), size = Buffer.alloc(4);
  size.writeUInt32LE(signed.length);
  const zip = Buffer.from("504b030400000000", "hex");
  const signature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0"),size,signed,zip]), privateKey);
  const proof = Buffer.concat([field(1,key),field(2,signature)]);
  const header = Buffer.concat([field(2,proof),field(10000,signed)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24"); prefix.writeUInt32LE(3,4); prefix.writeUInt32LE(header.length,8);
  return Buffer.concat([prefix,header,zip]);
}
test("verifies the signing identity and complete payload", () => {
  const bytes = packageBytes();
  expect(verifyCrx(bytes,key.toString("base64"),id).toString("hex")).toBe("504b030400000000");
  bytes[bytes.length-1] = 1;
  expect(() => verifyCrx(bytes,key.toString("base64"),id)).toThrow("signature");
});
test("refuses a different trusted key or ID and malformed packages", () => {
  const bytes = packageBytes();
  expect(() => verifyCrx(bytes,"wrong key",id)).toThrow("key mismatch");
  expect(() => verifyCrx(bytes,key.toString("base64"),"wrong id")).toThrow("ID mismatch");
  expect(() => verifyCrx(bytes.subarray(0,20),key.toString("base64"),id)).toThrow("Truncated");
  expect(() => verifyCrx(Buffer.alloc(12),key.toString("base64"),id)).toThrow("CRX3");
});
