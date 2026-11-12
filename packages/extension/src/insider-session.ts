import { currentWaterlooWorksSession } from './waterlooworks-session.js';
export const HOSTED_INSIDER_SESSION_KEY='hosted:verified-session';
export interface InsiderSession {endpoint:string;revision:string;fingerprint:string;email:string;token:string;expiresAt:number}
export async function readInsiderSession(settings:{endpoint:string;revision:string},storageKey=HOSTED_INSIDER_SESSION_KEY):Promise<InsiderSession|null>{
  const stored=(await chrome.storage.session.get(storageKey))[storageKey] as InsiderSession|undefined;
  if(!stored||stored.endpoint!==settings.endpoint||stored.revision!==settings.revision||stored.expiresAt<=Date.now())return null;
  if(stored.fingerprint!==(await currentWaterlooWorksSession()).fingerprint)return null;
  return stored;
}
