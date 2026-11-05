import {afterEach,expect,test} from "bun:test";
import {LocalApplicationGateway} from "./local-application-gateway.js";
import {withSubmissionBinding} from "./submission-binding.js";
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
test("reconciliation account and presence reads use only the local browser broker even within another execution scope",async()=>{
  const commands:unknown[]=[];
  globalThis.fetch=(async(url,init)=>{
    expect(String(url)).toBe("http://127.0.0.1:39451/command");
    commands.push(JSON.parse(String(init?.body)));
    return Response.json({result:{jobId:"495376",hasApplication:true,accountKey:"local",accountLabel:"Student"}});
  }) as typeof fetch;
  const gateway=new LocalApplicationGateway();
  await withSubmissionBinding("a".repeat(64),async()=>{await gateway.getAccount();await gateway.getApplicationStatus("495376");await gateway.listApplications();});
  expect(commands).toEqual([
    {method:"localApplicationRead",args:["getAccount",[]]},
    {method:"localApplicationRead",args:["getApplicationStatus",["495376"]]},
    {method:"localApplicationRead",args:["listApplications",[]]},
  ]);
  expect(gateway.capabilities).toMatchObject({upload:false,defaults:false,submit:false});
});
