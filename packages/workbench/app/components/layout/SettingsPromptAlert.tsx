import { Button } from "@agent-native/toolkit/ui";
import { useEffect, useRef, useState } from "react";
import type { UndeliveredSettingsPrompt } from "@/lib/settings-chat-handoff";

/** Shows a Settings prompt that did not reach a chat, so the owner can copy it. */
export function SettingsPromptAlert({ undelivered, onDismiss }: {
  undelivered: UndeliveredSettingsPrompt;
  onDismiss: () => void;
}) {
  const text = useRef<HTMLTextAreaElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    // The alert can appear seconds after the submit, so remember where the
    // owner was and move focus to the prompt text, selected for copying.
    returnTo.current = document.activeElement;
    text.current?.focus();
    text.current?.select();
  }, []);

  async function copyPrompt() {
    try {
      if (!navigator.clipboard) throw new Error("The clipboard is unavailable.");
      await navigator.clipboard.writeText(undelivered.prompt);
      setCopy("copied");
    } catch {
      setCopy("failed");
      text.current?.focus();
      text.current?.select();
    }
  }

  function dismiss() {
    const previous = returnTo.current;
    const target = previous instanceof HTMLElement && previous.isConnected && previous !== document.body
      ? previous : document.getElementById("workbench-content");
    onDismiss();
    target?.focus();
  }

  return <div className="workspace-recovery" role="alert">
    <span>{undelivered.reason === "selection-failed"
      ? "Vivary could not switch to Personal workspace, so this prompt was not sent."
      : "This prompt did not reach a chat. Copy it and send it from a Native chat."}</span>
    <textarea ref={text} readOnly aria-label="Prompt that was not sent" value={undelivered.prompt} />
    <Button size="sm" variant="outline" onClick={() => void copyPrompt()}>Copy prompt</Button>
    {copy === "copied" && <span>Copied.</span>}
    {copy === "failed" && <span>Copy failed. The text is selected, so copy it with your keyboard.</span>}
    <Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
  </div>;
}
