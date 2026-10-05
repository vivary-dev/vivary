import { open } from "node:fs/promises";
import { codeAgentRunTranscriptPath, type CodeAgentTranscriptEvent } from "@agent-native/core/code-agents";

export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
export type TranscriptEntry = { event: CodeAgentTranscriptEvent; offset: number; nextOffset: number };

/** Caller must authorize the run before opening its authoritative transcript. Offsets are UTF-8 bytes. */
export async function readCodeTranscriptPage(runId: string, offset = 0, maxEvents = 500, discardLine = false) {
  let file;
  try { file = await open(codeAgentRunTranscriptPath(runId), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], nextOffset: offset, done: true, readBytes: 0, limited: false, discardLine: false }; throw error; }
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_PAGE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const eof = offset + bytesRead >= (await file.stat()).size;
    const entries: TranscriptEntry[] = [];
    let start = 0, limited = discardLine;
    if (discardLine) {
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end < 0) return { entries, nextOffset: offset + bytesRead, done: eof, readBytes: bytesRead, limited: true, discardLine: !eof };
      start = end + 1;
    }
    while (start < bytesRead && entries.length < maxEvents) {
      const end = buffer.subarray(0, bytesRead).indexOf(10, start);
      if (end < 0) break; // A writer may still be appending, even at EOF. Keep this line's offset.
      const next = end + 1;
      const line = buffer.subarray(start, end).toString("utf8");
      if (line.trim()) {
        let event: CodeAgentTranscriptEvent;
        try { event = JSON.parse(line); }
        catch { limited = true; start = next; continue; }
        if (event && typeof event === "object" && event.runId === runId && typeof event.id === "string" && typeof event.message === "string") {
          entries.push({ event, offset: offset + start, nextOffset: offset + next });
        }
      }
      start = next;
    }
    // A line larger than the byte cap is skipped in bounded chunks, with an explicit coverage notice.
    const oversized = start === 0 && bytesRead === buffer.length;
    if (oversized) { start = bytesRead; limited = true; }
    return { entries, nextOffset: offset + start, done: eof && (start === bytesRead || buffer.subarray(start, bytesRead).indexOf(10) < 0),
      readBytes: bytesRead, limited, discardLine: oversized };
  } finally { await file.close(); }
}

/** Read a bounded window around an already-authorized byte anchor, including earlier context. */
export async function readCodeTranscriptWindow(runId: string, anchorOffset: number, maxEvents = 400) {
  const start = Math.max(0, anchorOffset - TRANSCRIPT_PAGE_BYTES);
  const before = anchorOffset ? await readCodeTranscriptPage(runId, start, Number.MAX_SAFE_INTEGER, start > 0) : null;
  const preceding = (before?.entries ?? []).filter(entry => entry.nextOffset <= anchorOffset).slice(-Math.min(60, maxEvents - 1));
  const after = await readCodeTranscriptPage(runId, anchorOffset, maxEvents - preceding.length);
  return { entries: [...preceding, ...after.entries], anchor: after.entries[0]?.event };
}
