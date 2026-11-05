import { z } from "zod";

export const DiscoveryRuleSchema = z.object({
  field: z.enum(["title", "description", "employer", "skills"]),
  phrase: z.string().trim().min(1).max(300),
  weight: z.number().finite().min(-100).max(100),
}).strict();

export const DiscoveryPolicySchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  hour: z.number().int().min(0).max(23).default(9),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).default("America/Toronto"),
  threshold: z.number().finite().min(0).default(1),
  terms: z.array(z.string().trim().min(1)).optional(),
  locations: z.array(z.string().trim().min(1)).optional(),
  arrangements: z.array(z.string().trim().min(1)).optional(),
  exclude: z.array(z.string().trim().min(1)).default([]),
  rules: z.array(DiscoveryRuleSchema).max(100).default([]),
}).strict();

export type DiscoveryPolicy = z.infer<typeof DiscoveryPolicySchema>;
