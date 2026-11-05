import { expect, test } from "bun:test";
import { wireEncode, wireDecode, publicResult } from "./wire.js";

test("binary wire values round trip while private protocol fields stay in the browser",()=>{
 const bytes=new Uint8Array([0,255,128]);
 expect(wireDecode(JSON.parse(wireEncode({bytes})))).toEqual({bytes});
 expect(publicResult({id:"123",raw:{action:"private"},cookie:"secret",privateFields:{state:"private"},bytes})).toEqual({id:"123",bytes});
});

test("resume-only submission omits the optional staged argument on the JSON wire",async()=>{
 const {ExtensionApplicationGateway}=await import("../../bridge/src/extension-proxy.js");
 const {validateExtensionArgs}=await import("../../shared/src/extension-protocol.js");
 let called=false;
 const proxy={call:async(method:string,...args:unknown[])=>{
  expect(called).toBe(true);
  expect(method).toBe("submitApplication");
  expect(args).toHaveLength(2);
  expect(validateExtensionArgs("submitApplication",JSON.parse(JSON.stringify(args)))).toBe(true);
  return {};
 }};
 const gateway=new ExtensionApplicationGateway(proxy as unknown as import("../../bridge/src/extension-proxy.js").ExtensionCommandProxy);
 await gateway.submitApplication({} as import("../../application-workflow/src/types.js").ApplicationManifest,new Map(),()=>{called=true;});
});
