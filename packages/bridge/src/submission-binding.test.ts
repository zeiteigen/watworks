import {afterEach,expect,test} from "bun:test";
import {ExtensionApplicationGateway} from "./extension-proxy.js";
import {withSubmissionBinding} from "./submission-binding.js";
import { commandStream, COMMAND_STREAM_TYPE } from "../../shared/src/command-stream.js";
import type { ApplicationProgress } from "../../shared/src/application-progress.js";
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
test("scoped application transport carries the binding without affecting research or other executions",async()=>{
  const calls:unknown[]=[];
  globalThis.fetch=(async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return Response.json({result:{accountKey:"account",accountLabel:"Student"}});}) as typeof fetch;
  const gateway=new ExtensionApplicationGateway();
  await Promise.all([withSubmissionBinding("a".repeat(64),()=>gateway.getAccount()),withSubmissionBinding("b".repeat(64),()=>gateway.getAccount())]);
  expect(calls).toEqual([{method:"submissionCommand",args:["a".repeat(64),"getAccount",[]]},{method:"submissionCommand",args:["b".repeat(64),"getAccount",[]]}]);
  await gateway.getAccount();
  expect(calls[2]).toEqual({method:"getAccount",args:[]});
});

test("the bound gateway delivers progress on the existing mutation request without status reads",async()=>{
  const gateway=new ExtensionApplicationGateway(),attempt=crypto.randomUUID(),binding="a".repeat(64);
  const progress:ApplicationProgress[]=[],calls:Array<{method:string;args:unknown[]}>=[];
  const stop=gateway.watchOperationProgress(attempt,value=>progress.push(value));
  let emit:((value:ApplicationProgress)=>void)|undefined,finish:((value:string)=>void)|undefined;
  globalThis.fetch=(async(_url,init)=>{
    expect(new Headers(init?.headers).get("accept")).toBe(COMMAND_STREAM_TYPE);
    calls.push(JSON.parse(String(init?.body)));
    return commandStream(()=>new Promise(resolve=>{finish=resolve;}),listener=>{emit=listener;return ()=>{};});
  }) as typeof fetch;
  const pending=withSubmissionBinding(binding,()=>gateway.uploadDocument("67","Resume",{filename:"resume.pdf",size:1,sha256:"b".repeat(64),bytes:Uint8Array.of(1)},"account",attempt));
  while(!emit || !finish)await Bun.sleep(1);
  emit({phase:"uploading_document",document:"resume"});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(progress).toEqual([{phase:"uploading_document",document:"resume"}]);
  finish(JSON.stringify({result:{id:"100"}}));
  expect(await pending).toMatchObject({id:"100"});stop();
  expect(calls).toHaveLength(1);expect(calls[0]!.method).toBe("submissionCommand");
  expect(calls[0]!.args.slice(0,2)).toEqual([binding,"uploadDocument"]);
  expect((calls[0]!.args[2] as unknown[])[4]).toBe(attempt);
});
