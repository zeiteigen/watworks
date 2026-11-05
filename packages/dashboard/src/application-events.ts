import type { Workspace } from "../../workspace/src/store.js";
import type { Applier } from "./applier.js";
import { parseJobKey } from "../../workspace/src/paths.js";

let connections=0;
/** One read-only connection pushes local application state; it never contacts the submission server. */
export function applicationEvents(workspace:Pick<Workspace,"listJobs">,applier:Pick<Applier,"subscribe"|"isActive">,signal:AbortSignal):Response {
  if(connections>=16)return new Response("Too many application streams",{status:503});
  connections++;
  const encoder=new TextEncoder();
  let cancel=()=>{};
  let refresh=()=>{};
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      let open=true,reading=false,dirty=true;
      let unsubscribe=()=>{};
      const heartbeat=setInterval(()=>{
        if(open && (controller.desiredSize??0)>0)controller.enqueue(encoder.encode(": keepalive\n\n"));
      },15_000);
      const close=()=>{
        if(!open)return;
        open=false;connections--;clearInterval(heartbeat);unsubscribe();signal.removeEventListener("abort",close);
        try{controller.close();}catch{/* Already cancelled by the consumer. */}
      };
      cancel=close;
      refresh=()=>{
        if(!open || reading || (controller.desiredSize??0)<=0)return;
        reading=true;
        void (async()=>{
          while(open && dirty && (controller.desiredSize??0)>0){
            dirty=false;
            const jobs=(await workspace.listJobs()).map(job=>({key:job.key,status:job.status,active:applier.isActive(parseJobKey(job.key))}));
            if(open)controller.enqueue(encoder.encode("data: "+JSON.stringify({jobs})+"\n\n"));
          }
        })().catch(close).finally(()=>{reading=false;if(open && dirty)refresh();});
      };
      unsubscribe=applier.subscribe(()=>{dirty=true;refresh();});
      signal.addEventListener("abort",close,{once:true});
      if(signal.aborted)close();else refresh();
    },
    pull(){refresh();},
    cancel(){cancel();},
  });
  return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-store","x-accel-buffering":"no","x-content-type-options":"nosniff"}});
}
