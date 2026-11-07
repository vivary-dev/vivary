import { z } from "zod";

/** Null observes a legacy absence. Neither an omitted value nor null grants wildcard consent. */
export const codeSwitchIdentitySchema = z.string().min(1).max(128)
  .refine(value => value.trim().length > 0).nullable();

export type CodeSwitchConsent = {
  expectedSwitchGeneration: string | null;
} & ({ stop: true; expectedTurnId: string | null } | { stop?: false; expectedTurnId?: never });
