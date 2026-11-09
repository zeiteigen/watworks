import { z } from 'zod';
import { getSubmissionSettings, isSelfHostedSubmission } from './submission-client.js';
import { readAccountEmail } from '../../waterlooworks-client/src/account-email.js';
import { browserFetch } from './research.js';
import { currentWaterlooWorksSession } from './waterlooworks-session.js';
import { INSIDER_SESSION_KEY, HOSTED_INSIDER_SESSION_KEY, readInsiderSession } from './insider-session.js';
import { hostedSettings } from './hosted-settings.js';
export type InsiderAccount={email:string|null;insider:boolean;term:string|null;admin:boolean;selfHosted?:boolean;reason?:string};
const accountSchema=z.object({email:z.string().email(),insider:z.boolean(),term:z.string().nullable(),admin:z.boolean()});
const resultSchema=z.object({token:z.string().regex(/^[a-f0-9]{64}$/).nullable(),expiresAt:z.number().optional(),account:accountSchema});
type RecognitionState={pending?:Promise<InsiderAccount>;cached?:{key:string;until:number;account:InsiderAccount}};
const configured:RecognitionState={},hosted:RecognitionState={};
export function getInsiderAccount(options:{hosted?:boolean;force?:boolean}={}):Promise<InsiderAccount>{
  const state=options.hosted?hosted:configured;
  if(state.pending)return state.pending;
  state.pending=recognize(state,options).finally(()=>{delete state.pending;});return state.pending;
}
export function getHostedAccount(force=false):Promise<InsiderAccount>{return getInsiderAccount({hosted:true,force});}
async function recognize(state:RecognitionState,options:{hosted?:boolean;force?:boolean}):Promise<InsiderAccount>{
  const core=(email:string|null,reason?:string):InsiderAccount=>({email,insider:false,term:null,admin:false,...(reason ? {reason} : {})});
  const getSettings=options.hosted?async()=>hostedSettings():getSubmissionSettings;
  const sessionKey=options.hosted?HOSTED_INSIDER_SESSION_KEY:INSIDER_SESSION_KEY;
  const settings=await getSettings();
  const {payload,fingerprint}=await currentWaterlooWorksSession();
  const key=JSON.stringify([settings.endpoint,settings.revision,fingerprint]);
  const cached=state.cached;
  if(!options.force&&cached?.key===key&&cached.until>Date.now()&&(!cached.account.insider||await readInsiderSession(settings,sessionKey)))return cached.account;
  let account:InsiderAccount;
  let email:string|null=null;
  try{
    email=await readAccountEmail(browserFetch);
    if(isSelfHostedSubmission(settings))account={...core(email,'Self-hosted server · no hosted account required'),selfHosted:true};
    else {
      let stored=await readInsiderSession(settings,sessionKey);
      const verify=()=>fetch(`${settings.endpoint}/v1/${stored?'account':'auth/waterlooworks'}`,{
        method:stored?'GET':'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60000),
        headers:{...settings.headers,'content-type':'application/json',...(stored?{authorization:`Bearer ${stored.token}`}:{})},
        ...(stored?{}:{body:JSON.stringify(payload)}),
      });
      let response=await verify();
      // A rejected bearer is stale identity evidence, not proof of a Core plan.
      // Recheck the browser identity once; this never dispatches application writes.
      if(stored&&(response.status===401||response.status===403)){
        await chrome.storage.session.remove(sessionKey);
        stored=null;
        response=await verify();
      }
      if(!response.ok)throw new Error(response.status===429
        ? 'Insider verification is temporarily rate-limited (HTTP 429). Try again shortly.'
        : `Insider verification unavailable (HTTP ${response.status}). Try again shortly.`);
      const data=stored?{token:stored.token,expiresAt:stored.expiresAt,account:await response.json()}:await response.json();
      const result=resultSchema.parse(data);
      if(result.account.email!==email)throw new Error('WaterlooWorks account changed. Checking again is required.');
      // Discard a response if endpoint or browser credentials changed in flight.
      const latest=await getSettings();
      if(latest.revision!==settings.revision||latest.endpoint!==settings.endpoint||(await currentWaterlooWorksSession()).fingerprint!==fingerprint)throw new Error('WaterlooWorks connection changed.');
      account=result.account;
      if(result.token&&result.account.insider&&result.expiresAt){
        await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
        await chrome.storage.session.set({[sessionKey]:{endpoint:settings.endpoint,revision:settings.revision,fingerprint,email,token:result.token,expiresAt:result.expiresAt}});
      }else await chrome.storage.session.remove(sessionKey);
    }
  }catch(error){
    await chrome.storage.session.remove(sessionKey);
    // Local identity can be read again next time; errors never unlock premium access.
    account=core(email,error instanceof Error&&error.message.startsWith('Insider')?error.message:'Sign in to WaterlooWorks to recognize your account.');
  }
  state.cached={key,until:Date.now()+30000,account};
  return account;
}
