import { expect, test } from "bun:test";
import { applicationEvents } from "./application-events.js";
import type { JobRecord } from "../../workspace/src/store.js";

test("one dashboard connection pushes changed application state and releases its listener on disconnect",async()=>{
  const listeners=new Set<()=>void>();
  let reads=0,active=true,state="applying",reason="Opening the application form";
  const response=applicationEvents({listJobs:async()=>{reads++;return [{key:"waterlooworks:123",status:{state,reason}}] as JobRecord[];}},
    {subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},isActive:()=>active},new AbortController().signal);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader=response.body!.getReader();
  const read=async()=>JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /,"").trim());
  expect((await read()).jobs[0]).toMatchObject({key:"waterlooworks:123",active:true,status:{state:"applying"}});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(reads).toBe(1);
  reason="Submitting the application";for(const listener of listeners)listener();
  expect((await read()).jobs[0].status.reason).toBe(reason);
  state="applied";active=false;for(const listener of listeners)listener();
  expect((await read()).jobs[0]).toMatchObject({active:false,status:{state:"applied"}});
  await reader.cancel();expect(listeners.size).toBe(0);
});

test("dashboard abort closes the stream and removes its application observer",async()=>{
  const abort=new AbortController();let detached=0;
  const response=applicationEvents({listJobs:async()=>[]},{subscribe:()=>()=>{detached++;},isActive:()=>false},abort.signal);
  const reader=response.body!.getReader();await reader.read();abort.abort();
  expect((await reader.read()).done).toBe(true);expect(detached).toBe(1);
});
