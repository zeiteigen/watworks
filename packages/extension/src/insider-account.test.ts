import {beforeEach,afterEach,test,expect} from 'bun:test';
import {getHostedAccount as getInsiderAccount} from './insider-account.js';
import {hostedSettings} from './hosted-settings.js';
import {readInsiderSession,HOSTED_INSIDER_SESSION_KEY as INSIDER_SESSION_KEY} from './insider-session.js';
const originalFetch=globalThis.fetch,originalChrome=Object.getOwnPropertyDescriptor(globalThis,'chrome'),originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
const endpoint='https://watworks.alishahzad.dev';
let local:Record<string,unknown>,session:Record<string,unknown>,email:string,cookie:string,accountStatus:number,authStatus:number,remoteEmail:string|null,remoteCalls:string[],insider:boolean,settings:{endpoint:string;headers:Record<string,string>;revision:string};
const storage=(data:Record<string,unknown>)=>({get:async(key:string)=>({[key]:data[key]}),set:async(items:Record<string,unknown>)=>{Object.assign(data,structuredClone(items));},remove:async(key:string)=>{delete data[key];},setAccessLevel:async()=>{}});
beforeEach(()=>{
  settings=hostedSettings();local={};session={};email='student@uwaterloo.ca';cookie='private-cookie-'+crypto.randomUUID();accountStatus=200;authStatus=200;remoteEmail=null;remoteCalls=[];insider=true;
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{storage:{local:storage(local),session:storage(session)},cookies:{getAll:async()=>[{name:'session',value:cookie,domain:'waterlooworks.uwaterloo.ca',path:'/',secure:true,httpOnly:true,sameSite:'lax'}]}}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Test browser',locks:{request:async(_key:unknown,_options:unknown,task:()=>Promise<unknown>)=>task()}}});
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.startsWith('https://waterlooworks.uwaterloo.ca/')){
      expect(url).toEndWith('/myAccount/dashboard.htm');expect(init?.method).toBe('POST');
      return new Response(String(init?.body).includes('action=')?`<table><tr><td>Email Address:</td><td>${email}</td></tr></table>`:`<a onclick="orbisAppSr.buildForm({'action':'read-account'}, '', '').submit();">My Account</a>`);
    }
    remoteCalls.push(url);
    if(url===endpoint+'/v1/account'){
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string,string>).authorization).toBe(`Bearer ${'f'.repeat(64)}`);
      return Response.json(accountStatus===200?{email:remoteEmail??email,insider,term:'2026-fall',admin:false}:{error:'Verification required'},{status:accountStatus});
    }
    expect(url).toBe(endpoint+'/v1/auth/waterlooworks');
    if(authStatus!==200)return Response.json({error:'Verification failed'},{status:authStatus});
    expect(JSON.parse(init!.body as string)).not.toHaveProperty('email');
    return Response.json({token:insider?'f'.repeat(64):null,expiresAt:Date.now()+3600000,account:{email:remoteEmail??email,insider,term:'2026-fall',admin:false}});
  }) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=originalFetch;for(const [key,descriptor] of [['chrome',originalChrome],['navigator',originalNavigator]] as const){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
test('Insider is recognized automatically',async()=>{
  expect(await getInsiderAccount()).toMatchObject({email,insider:true});
  expect(remoteCalls).toHaveLength(1);
  expect(await readInsiderSession(settings)).toMatchObject({email});
});
test('automatic recognition scopes token to email, cookies, revision and endpoint without persisting cookies',async()=>{
  expect(await getInsiderAccount()).toMatchObject({email,insider:true});expect(remoteCalls).toHaveLength(1);
  expect(await readInsiderSession(settings)).toMatchObject({email,token:'f'.repeat(64)});
  expect(JSON.stringify(session)).not.toContain(cookie);expect(settings.headers).toEqual({});
  expect(await readInsiderSession({...settings,revision:crypto.randomUUID()})).toBeNull();
  cookie='changed-cookie';expect(await readInsiderSession(settings)).toBeNull();
  email='other@uwaterloo.ca';insider=false;expect(await getInsiderAccount()).toMatchObject({email,insider:false});expect(session[INSIDER_SESSION_KEY]).toBeUndefined();
});
test('mismatched remote identity cannot unlock Insider and preserves local email for display',async()=>{
  remoteEmail='someoneelse@uwaterloo.ca';expect(await getInsiderAccount()).toMatchObject({email,insider:false});expect(session[INSIDER_SESSION_KEY]).toBeUndefined();
});
test('automatic recognition picks up an admin grant when the short cache expires',async()=>{
  insider=false;
  expect((await getInsiderAccount()).insider).toBe(false);
  insider=true;
  expect((await getInsiderAccount()).insider).toBe(false);
  const originalNow=Date.now;
  try{
    Date.now=()=>originalNow()+31000;
    expect((await getInsiderAccount()).insider).toBe(true);
  }finally{Date.now=originalNow;}
  expect(remoteCalls).toHaveLength(2);
});

async function afterCacheExpires<T>(task:()=>Promise<T>):Promise<T>{
  const originalNow=Date.now;
  try{Date.now=()=>originalNow()+31000;return await task();}
  finally{Date.now=originalNow;}
}
test('admin demotion is a confirmed Core plan without a verification warning',async()=>{
  expect((await getInsiderAccount()).insider).toBe(true);
  insider=false;
  const account=await afterCacheExpires(()=>getInsiderAccount());
  expect(account).toMatchObject({email,insider:false});
  expect(account.reason).toBeUndefined();
  expect(remoteCalls).toEqual([endpoint+'/v1/auth/waterlooworks',endpoint+'/v1/account']);
  expect(session[INSIDER_SESSION_KEY]).toBeUndefined();
});
for(const status of [401,403]){
  test(`a rejected saved token (${status}) automatically reverifies a demoted account once`,async()=>{
    expect((await getInsiderAccount()).insider).toBe(true);
    insider=false;accountStatus=status;
    const account=await afterCacheExpires(()=>getInsiderAccount());
    expect(account).toMatchObject({email,insider:false});
    expect(account.reason).toBeUndefined();
    expect(remoteCalls).toEqual([endpoint+'/v1/auth/waterlooworks',endpoint+'/v1/account',endpoint+'/v1/auth/waterlooworks']);
    expect(session[INSIDER_SESSION_KEY]).toBeUndefined();
  });
}
test('a failed re-verification reports its HTTP status without retrying again',async()=>{
  expect((await getInsiderAccount()).insider).toBe(true);
  accountStatus=401;authStatus=503;
  const account=await afterCacheExpires(()=>getInsiderAccount());
  expect(account).toMatchObject({email,insider:false,reason:'Insider verification unavailable (HTTP 503). Try again shortly.'});
  expect(remoteCalls).toHaveLength(3);
  expect(session[INSIDER_SESSION_KEY]).toBeUndefined();
});
test('rate limiting is reported separately from a confirmed Core plan',async()=>{
  authStatus=429;
  expect(await getInsiderAccount()).toMatchObject({email,insider:false,reason:'Insider verification is temporarily rate-limited (HTTP 429). Try again shortly.'});
  expect(remoteCalls).toHaveLength(1);
});
