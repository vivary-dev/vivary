import { z } from 'zod';
export const remotePreviewInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('open'), documentId: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), launchId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('close'), documentId: z.string().uuid() }).strict(),
]);
export const previewHandoff = z.object({ ticket: z.string(), origin: z.string().url(), generation: z.string() });
