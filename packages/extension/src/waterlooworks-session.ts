import { WATERLOOWORKS_ORIGIN } from '../../shared/src/protocol.js';
import { sha256 } from '../../shared/src/sha256.js';
/** Credentials are transient: only the fingerprint may enter trusted session storage. */
export async function currentWaterlooWorksSession(){
  const host=new URL(WATERLOOWORKS_ORIGIN).hostname;
  const cookies=(await chrome.cookies.getAll({domain:host})).filter(cookie=>cookie.domain.replace(/^\./,'')===host).map(cookie=>({
    name:cookie.name,value:cookie.value,domain:cookie.domain,path:cookie.path,secure:cookie.secure,httpOnly:cookie.httpOnly,
    ...(cookie.sameSite==='strict'?{sameSite:'Strict' as const}:cookie.sameSite==='lax'?{sameSite:'Lax' as const}:cookie.sameSite==='no_restriction'?{sameSite:'None' as const}:{}),
    ...(cookie.expirationDate===undefined?{}:{expires:cookie.expirationDate}),
  })).sort((a,b)=>`${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));
  return {payload:{cookies,userAgent:navigator.userAgent},fingerprint:sha256(JSON.stringify(cookies))};
}
