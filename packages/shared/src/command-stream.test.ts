import { expect, test } from "bun:test";
import { commandStream, readCommandStream } from "./command-stream.js";
import type { ApplicationProgress } from "./application-progress.js";

test("one open command delivers progress before its terminal result and detaches observers",async()=>{
  let emit!:(progress:ApplicationProgress)=>void, finish!:(value:string)=>void, detached=0;
  const response=commandStream(()=>new Promise(resolve=>{finish=resolve;}),listener=>{emit=listener;return ()=>{detached++;};});
  const progress:ApplicationProgress[]=[];
  const result=readCommandStream(response,value=>progress.push(value));
  emit({phase:"uploading_document",document:"resume"});
  for(let i=0;i<5;i++)await Promise.resolve();
  expect(progress).toEqual([{phase:"uploading_document",document:"resume"}]);
  finish(JSON.stringify({result:{status:"submitted"}}));
  expect(await result).toEqual({result:{status:"submitted"}});
  expect(detached).toBe(1);
});

test("cancelling telemetry detaches it without cancelling or replaying the approved command",async()=>{
  let calls=0,finished=false,finish!:(value:string)=>void,detached=0;
  const response=commandStream(()=>{calls++;return new Promise(resolve=>{finish=resolve;}).then(value=>{finished=true;return value as string;});},()=>()=>{detached++;});
  await Promise.resolve();
  await response.body!.cancel();
  expect(detached).toBe(1);expect(calls).toBe(1);expect(finished).toBe(false);
  finish('{"result":null}');await Promise.resolve();await Promise.resolve();
  expect(finished).toBe(true);expect(calls).toBe(1);
});

test("decoder accepts split frames and heartbeats but rejects malformed and incomplete streams",async()=>{
  const bytes=new TextEncoder().encode('{"heartbeat":true}\n{"progress":{"phase":"submitting"}}\n{"result":{"name":"é"}}\n');
  const progress:ApplicationProgress[]=[];
  expect(await readCommandStream(new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}})),value=>progress.push(value))).toEqual({result:{name:"é"}});
  expect(progress).toEqual([{phase:"submitting"}]);
  for(const body of ['{"progress":{"phase":"page text"}}\n','{"heartbeat":true}\n','{"result":null,"error":"ambiguous"}\n'])await expect(readCommandStream(new Response(body))).rejects.toThrow();
});
