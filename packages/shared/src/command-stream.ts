import { applicationProgressSchema, type ApplicationProgress } from "./application-progress.js";

export const COMMAND_STREAM_TYPE = "application/x-ndjson";

/** Telemetry cancellation detaches the observer; it must never cancel or retry a write. */
export function commandStream(run: () => Promise<string>, subscribe: (emit: (progress: ApplicationProgress) => void) => () => void, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let unsubscribe = () => {};
      const heartbeat = setInterval(() => send({heartbeat:true}), 15_000);
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        signal?.removeEventListener("abort", close);
        try{controller.close();}catch{/* The consumer may already have cancelled. */}
      };
      const send = (frame: unknown) => {
        if (open && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      };
      stop = close;
      signal?.addEventListener("abort", close, {once:true});
      unsubscribe = subscribe(progress => send({progress:applicationProgressSchema.parse(progress)}));
      send({heartbeat:true});
      if(signal?.aborted)close();
      void Promise.resolve().then(run).then(terminal => {
        if(open)controller.enqueue(encoder.encode(terminal + "\n"));
      }, () => {
        if(open)controller.enqueue(encoder.encode(JSON.stringify({error:"Command stream failed; inspect the original operation"}) + "\n"));
      }).finally(close);
    },
    cancel() { stop(); },
  });
  return new Response(body, {headers:{"content-type":COMMAND_STREAM_TYPE,"cache-control":"no-store","x-accel-buffering":"no"}});
}

/** Bounded incremental decoding supports split UTF-8 and frames across network chunks. */
export async function readCommandStream(response: Response, onProgress: (progress: ApplicationProgress) => void = () => {}): Promise<Record<string,unknown>> {
  if (!response.body) throw new Error("Command stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", size = 0;
  const parse = (line: string): Record<string,unknown> | undefined => {
    const frame:unknown = JSON.parse(line);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid command stream frame");
    const value=frame as Record<string,unknown>;
    if(Object.keys(value).length===1 && value.heartbeat===true)return;
    if(Object.keys(value).length===1 && "progress" in value){const progress=applicationProgressSchema.parse(value.progress);try{onProgress(progress);}catch{/* Observers cannot interrupt an approved command. */}return;}
    if(Object.keys(value).some(key=>!["result","error","failure"].includes(key)) || ("result" in value)===("error" in value) || ("error" in value && (typeof value.error!=="string" || value.error.length>1000)))throw new Error("Invalid command stream frame");
    return value;
  };
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(value){size+=value.byteLength;if(size>48*1024*1024)throw new Error("Command stream exceeded size limit");}
      pending+=decoder.decode(value,{stream:!done});
      let newline;
      while((newline=pending.indexOf("\n"))>=0){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        if(!line.trim())continue;
        const terminal=parse(line);if(terminal)return terminal;
      }
      if(done){if(pending.trim()){const terminal=parse(pending);if(terminal)return terminal;}throw new Error("Command stream ended without a result");}
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
