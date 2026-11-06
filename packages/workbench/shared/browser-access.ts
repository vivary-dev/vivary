import { z } from 'zod';
export const browserStatus = z.object({
  preview: z.object({ origin: z.string(), port: z.number() }).nullable().optional(),
  enabled: z.boolean(), remote: z.boolean(), instanceId: z.string().uuid(), label: z.string(),
  origin: z.string().nullable(), port: z.number(), fault: z.boolean().optional(), listenerError: z.string().nullable().optional(),
  devices: z.array(z.object({ id: z.string().uuid(), label: z.string(), status: z.string(), expires_at: z.coerce.number() })).optional(),
  pending: z.array(z.object({ id: z.string().uuid(), label: z.string(), code: z.string(), expiresAt: z.number(), approved: z.boolean() })).optional(),
});
export type BrowserStatus = z.infer<typeof browserStatus>;
