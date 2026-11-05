import { z } from 'zod';
import { getSubmissionSettings, isSelfHostedSubmission } from './submission-client.js';
import { readAccountEmail } from '../../waterlooworks-client/src/account-email.js';
import { browserFetch } from './research.js';
import { currentWaterlooWorksSession } from './waterlooworks-session.js';
import { INSIDER_SESSION_KEY, readInsiderSession } from './insider-session.js';
export type InsiderAccount={email:string|null;insider:boolean;term:string|null;admin:boolean;selfHosted?:boolean;reason?:string};
const accountSchema=z.object({email:z.string().email(),insider:z.boolean(),term:z.string().nullable(),admin:z.boolean()});
const resultSchema=z.object({token:z.string().regex(/^[a-f0-9]{64}$/).nullable(),expiresAt:z.number().optional(),account:accountSchema});
let pending:Promise<InsiderAccount>|undefined;
let cached:{key:string;until:number;account:InsiderAccount}|undefined;
export function getInsiderAccount():Promise<InsiderAccount>{
  if(pending)return pending;
  pending=recognize().finally(()=>{pending=undefined;});return pending;
}
async function recognize():Promise<InsiderAccount>{
  const core=(email:string|null,reason?:string):InsiderAccount=>({email,insider:false,term:null,admin:false,...(reason ? {reason} : {})});
  const settings=await getSubmissionSettings();
  const {payload,fingerprint}=await currentWaterlooWorksSession();
  const key=JSON.stringify([settings.endpoint,settings.revision,fingerprint]);
  if(cached?.key===key&&cached.until>Date.now()&&(!cached.account.insider||await readInsiderSession(settings)))return cached.account;
  let account:InsiderAccount;
  let email:string|null=null;
  try{
    email=await readAccountEmail(browserFetch);
    if(isSelfHostedSubmission(settings))account={...core(email,'Self-hosted server · no hosted account required'),selfHosted:true};
    else {
      let stored=await readInsiderSession(settings);
      const verify=()=>fetch(`${settings.endpoint}/v1/${stored?'account':'auth/waterlooworks'}`,{
        method:stored?'GET':'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60000),
        headers:{...settings.headers,'content-type':'application/json',...(stored?{authorization:`Bearer ${stored.token}`}:{})},
        ...(stored?{}:{body:JSON.stringify(payload)}),
      });
      let response=await verify();
      // A rejected bearer is stale identity evidence, not proof of a Core plan.
      // Recheck the browser identity once; this never dispatches application writes.
      if(stored&&(response.status===401||response.status===403)){
        await chrome.storage.session.remove(INSIDER_SESSION_KEY);
        stored=null;
        response=await verify();
      }
      if(!response.ok)throw new Error(response.status===429
        ? 'Insider verification is temporarily rate-limited (HTTP 429). Core features remain available.'
        : `Insider verification unavailable (HTTP ${response.status}). Core features remain available.`);
      const data=stored?{token:stored.token,expiresAt:stored.expiresAt,account:await response.json()}:await response.json();
      const result=resultSchema.parse(data);
      if(result.account.email!==email)throw new Error('WaterlooWorks account changed. Checking again is required.');
      // Discard a response if endpoint or browser credentials changed in flight.
      const latest=await getSubmissionSettings();
      if(latest.revision!==settings.revision||latest.endpoint!==settings.endpoint||(await currentWaterlooWorksSession()).fingerprint!==fingerprint)throw new Error('WaterlooWorks connection changed.');
      account=result.account;
      if(result.token&&result.account.insider&&result.expiresAt){
        await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
        await chrome.storage.session.set({[INSIDER_SESSION_KEY]:{endpoint:settings.endpoint,revision:settings.revision,fingerprint,email,token:result.token,expiresAt:result.expiresAt}});
      }else await chrome.storage.session.remove(INSIDER_SESSION_KEY);
    }
  }catch(error){
    await chrome.storage.session.remove(INSIDER_SESSION_KEY);
    // Local identity can be read again next time; errors never unlock premium access.
    account=core(email,error instanceof Error&&error.message.startsWith('Insider')?error.message:'Sign in to WaterlooWorks to recognize your account.');
  }
  cached={key,until:Date.now()+30000,account};
  return account;
}
