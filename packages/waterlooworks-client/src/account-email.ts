import { navigationFields } from './application-fields.js';
import { verifiedProfileEmail } from './profile-email.js';
import { AuthenticationExpiredError, ProtocolChangedError } from './errors.js';
import type { FetchLike } from './session.js';
import { WATERLOOWORKS_ORIGIN } from '../../shared/src/protocol.js';
const url=`${WATERLOOWORKS_ORIGIN}/myAccount/dashboard.htm`;
/** Read-only My Account navigation observed on WaterlooWorks; no guessed profile URL. */
export async function readAccountEmail(fetchImpl:FetchLike):Promise<string>{
  async function read(fields:Record<string,string>):Promise<string>{
    const response=await fetchImpl(url,{method:'POST',body:new URLSearchParams(fields),credentials:'include',redirect:'error',cache:'no-store',headers:{'content-type':'application/x-www-form-urlencoded','x-requested-with':'XMLHttpRequest'},signal:AbortSignal.timeout(30000)});
    if(!response.ok||response.type==='opaqueredirect'||response.redirected)throw new AuthenticationExpiredError('Sign in to WaterlooWorks to recognize your account');
    if(response.url&&new URL(response.url).origin!==WATERLOOWORKS_ORIGIN)throw new AuthenticationExpiredError();
    const reader=response.body?.getReader();if(!reader)throw new ProtocolChangedError('Account response is empty');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>12_000_000)throw new ProtocolChangedError('Account response exceeds limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder().decode(bytes);
  }
  // WaterlooWorks' dashboard GET contains an empty POST trampoline.
  const fields=navigationFields(await read({}),'My Account');
  if(!fields.action)throw new ProtocolChangedError('My Account read action unavailable');
  return verifiedProfileEmail(await read(fields));
}
