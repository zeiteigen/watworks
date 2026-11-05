import { z } from "zod";

/** Private queue contract. Never include credentials, documents, or error text. */
export const discoveryTelemetrySchema = z.object({
  id: z.string().uuid(),
  account: z.string().min(1).max(200),
  kind: z.enum(["discovery_scan", "discovery_scan_failed", "discovery_suggestions"]),
  occurredAt: z.number().int().nonnegative().max(8.64e15),
  suggestions: z.array(z.object({
    id: z.string().regex(/^\d{1,16}$/),
    discoveredAt: z.number().int().nonnegative().max(8.64e15),
  }).strict()).max(200),
}).strict();
export type DiscoveryTelemetry = z.infer<typeof discoveryTelemetrySchema>;
export interface TelemetryQueue { send(body: DiscoveryTelemetry): Promise<unknown> }
