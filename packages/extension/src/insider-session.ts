import { currentWaterlooWorksSession } from './waterlooworks-session.js';
export const INSIDER_SESSION_KEY='insider:verified-session';
export interface InsiderSession {endpoint:string;revision:string;fingerprint:string;email:string;token:string;expiresAt:number}
export async function readInsiderSession(settings:{endpoint:string;revision:string}):Promise<InsiderSession|null>{
  const stored=(await chrome.storage.session.get(INSIDER_SESSION_KEY))[INSIDER_SESSION_KEY] as InsiderSession|undefined;
  if(!stored||stored.endpoint!==settings.endpoint||stored.revision!==settings.revision||stored.expiresAt<=Date.now())return null;
  if(stored.fingerprint!==(await currentWaterlooWorksSession()).fingerprint)return null;
  return stored;
}
