function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Recognize both current and legacy bridges without requesting cookies. */
export async function probeBridge(baseUrl: string, signal: AbortSignal): Promise<void> {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, { signal, redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error("Bridge probe failed");
    return response.json();
  };
  const [identity, health] = await Promise.all([read("/"), read("/health")]);
  if (!isRecord(identity) || identity.service !== "waterlooworks-extension-bridge" ||
      !isRecord(health) || health.service !== "waterlooworks-extension-bridge" ||
      typeof health.bridgeConnected !== "boolean") {
    throw new Error("The port does not serve a compatible WaterlooWorks bridge");
  }
}
