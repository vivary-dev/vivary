import { z } from "zod";

/**
 * The host-wide limit on Code runs working at once, and what a send does when every slot is taken. The owner decided on
 * 2026-10-19 that the limit is configurable above six. The default of three is a starting value, not a measured safety
 * limit. API chat has no coding worker, so it does not count.
 */
export const CODE_RUN_LIMIT_MIN = 1;
export const CODE_RUN_LIMIT_MAX = 16;
export const CODE_RUN_LIMIT_DEFAULT = 3;
export const CODE_RUN_WHEN_FULL = ["queue", "refuse"] as const;

export const codeRunCapacitySchema = z.object({
  limit: z.number().int().min(CODE_RUN_LIMIT_MIN).max(CODE_RUN_LIMIT_MAX),
  whenFull: z.enum(CODE_RUN_WHEN_FULL),
}).strict();
export type CodeRunCapacity = z.infer<typeof codeRunCapacitySchema>;

export const DEFAULT_CODE_RUN_CAPACITY: CodeRunCapacity = { limit: CODE_RUN_LIMIT_DEFAULT, whenFull: "queue" };
