import { useCallback, useEffect, useState } from "react";
import { Button } from "@agent-native/toolkit/ui";

import { useNativeActionCaller } from "../../lib/native-actions";
import type { AutomationFile } from "../../../actions/vivary-automation-files";

// Automation proposals wait here while chats keep using the last accepted instructions.
// Proposed text renders as plain text, so a link or image cannot run.
export function AutomationFileReview() {
  const { call, ready } = useNativeActionCaller();
  const [files, setFiles] = useState<AutomationFile[]>([]);
  const [listFailed, setListFailed] = useState(false);
  const [failedDecisionIds, setFailedDecisionIds] = useState<Set<string>>(() => new Set());
  // The file whose Accept or Discard was refused because it changed since the list showed it. The action answers that
  // refusal, and only that one, with 409.
  const [changedId, setChangedId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFiles((await call<{ files: AutomationFile[] }>("vivary-automation-files", { operation: "list" })).files);
      setListFailed(false);
    } catch {
      setListFailed(true);
    }
  }, [call]);
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);
  async function review(file: AutomationFile, operation: "accept" | "delete") {
    // Reload every decision. A 409 identifies changed text, while other errors leave the outcome unconfirmed.
    try {
      await call("vivary-automation-files", { operation, id: file.id, updatedAt: file.updatedAt });
      setChangedId(null);
      setFailedDecisionIds(ids => {
        const next = new Set(ids);
        next.delete(file.id);
        return next;
      });
    } catch (error: unknown) {
      const changed = typeof error === "object" && error !== null && "status" in error && error.status === 409;
      setChangedId(changed ? file.id : null);
      setFailedDecisionIds(ids => {
        const next = new Set(ids);
        if (changed) next.delete(file.id);
        else next.add(file.id);
        return next;
      });
    }
    await load();
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Automation files</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Instruction, skill, and memory changes written by automation runs wait here. Chats and automation runs keep
          using the previous accepted version. Accept loads the proposed text. Discard restores the saved previous
          version. If none was saved, it removes the proposed file.
        </p>
        {failedDecisionIds.size > 0 && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Your decision could not be confirmed. Check the list and try again if the file is still waiting.
          </p>
        )}
        {listFailed && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            The list of waiting files could not load, so files may still be waiting.
          </p>
        )}
      </div>
      <ul aria-label="Files waiting for review" className="space-y-4">
        {files.map(file => (
          <li key={file.id} className="space-y-3 rounded-md border p-4">
            <h3 className="break-all font-mono text-sm font-medium">{file.path}</h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
              {file.content}
            </pre>
            {file.id === changedId && (
              <p role="alert" className="text-sm text-destructive">
                This file changed since the list showed it. Read it again before you accept or discard it.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void review(file, "accept")}>Accept</Button>
              <Button variant="destructive" size="sm" onClick={() => void review(file, "delete")}>Discard</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
