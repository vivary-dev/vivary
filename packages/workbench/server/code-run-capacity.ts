import { getSetting, putSetting } from "@agent-native/core/settings";
import { codeRunCapacitySchema, DEFAULT_CODE_RUN_CAPACITY, type CodeRunCapacity } from "../shared/code-run-capacity";

export { DEFAULT_CODE_RUN_CAPACITY, type CodeRunCapacity };

/** One host-wide setting, not a per-owner one, because the limit protects the host every owner shares. */
const CAPACITY_SETTING = "vivary-code-run-capacity-v1";

/** The saved capacity. A missing or unreadable value reads as the default. */
export async function readCodeRunCapacity(): Promise<CodeRunCapacity> {
  const parsed = codeRunCapacitySchema.safeParse(await getSetting(CAPACITY_SETTING, { bypassCache: true }));
  return parsed.success ? parsed.data : DEFAULT_CODE_RUN_CAPACITY;
}

export async function writeCodeRunCapacity(next: CodeRunCapacity): Promise<CodeRunCapacity> {
  const value = codeRunCapacitySchema.parse(next);
  await putSetting(CAPACITY_SETTING, value);
  return value;
}
