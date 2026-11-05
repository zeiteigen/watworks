/** Binary payloads are bounded by the broker; no credentials use this channel. */
export function wireEncode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!(item instanceof Uint8Array)) return item;
    let binary=""; for(let i=0;i<item.length;i+=8192) binary+=String.fromCharCode(...item.subarray(i,i+8192));
    return {$bytes:btoa(binary)};
  });
}
export function wireDecode(value: unknown): unknown {
  if(Array.isArray(value)) return value.map(wireDecode);
  if(value&&typeof value==="object") {
    const record=value as Record<string,unknown>;
    if(Object.keys(record).length===1&&typeof record.$bytes==="string") {
      if(record.$bytes.length>44_000_000) throw new Error("PDF payload exceeds limit");
      return Uint8Array.from(atob(record.$bytes),c=>c.charCodeAt(0));
    }
    return Object.fromEntries(Object.entries(record).map(([key,child])=>[key,wireDecode(child)]));
  } return value;
}

/** Transport internals must never cross the extension boundary. */
export function publicResult(value: unknown): unknown {
  if(value instanceof Uint8Array) return value;
  if(Array.isArray(value)) return value.map(publicResult);
  if(value&&typeof value==="object") return Object.fromEntries(Object.entries(value).filter(([key])=>!/^raw$|cookie|password|secret|authorization|^action$|privateFields|uploadSaveFields/i.test(key)).map(([key,child])=>[key,publicResult(child)]));
  return value;
}
