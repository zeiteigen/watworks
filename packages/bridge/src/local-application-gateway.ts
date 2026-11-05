import {ExtensionApplicationGateway,ExtensionCommandProxy} from "./extension-proxy.js";
import type {ExtensionMethod} from "../../shared/src/extension-protocol.js";

/** Explicit read-only route: reconciliation never imports credentials or calls the submission host. */
class LocalReadProxy extends ExtensionCommandProxy {
  override callWithProgress<T>():Promise<T>{return Promise.reject(new Error("Local browser gateway supports reconciliation reads only"));}
  override call<T>(method:ExtensionMethod,...args:unknown[]):Promise<T> {
    return super.call<T>("localApplicationRead",method,args);
  }
}
export class LocalApplicationGateway extends ExtensionApplicationGateway {
  override readonly capabilities={upload:false,defaults:false,submit:false,reason:"Local browser gateway supports reconciliation reads only"};
  constructor(){super(new LocalReadProxy());}
}
