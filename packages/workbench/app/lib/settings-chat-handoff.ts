import { AGENT_CHAT_SUBMIT_RESULT_EVENT, parseSubmitChatMessage } from "@agent-native/core/client/agent-chat";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useProjects } from "@/components/projects/ProjectContext";

// Core keeps a same-window submit this long so a chat that mounts later can
// replay it (SELF_SUBMIT_BUFFER_TTL_MS in @agent-native/core agent-chat).
const CORE_SUBMIT_BUFFER_MS = 8_000;
// Core fires this once a chat picks the thread for a submit. The public
// agent-chat entry does not export the constant, so it is repeated here.
const SUBMIT_TARGET_EVENT = "agentNative.chatSubmitTarget";
export const SETTINGS_CHAT_PATH = "/?runtime=native&history=project";

export type UndeliveredSettingsPrompt = {
  submitMessageId: string | null;
  prompt: string;
  reason: "selection-failed" | "not-delivered";
};

// A submit moves from switching to Personal, to an opened Native chat, to a
// thread Core picked for it.
type Handoff = {
  prompt: string;
  phase: "switching" | "opened" | "targeted";
  timer?: ReturnType<typeof setTimeout>;
};

function submitIdOf(event: Event): string | null {
  const id = (event as CustomEvent<{ submitMessageId?: unknown }>).detail?.submitMessageId;
  return typeof id === "string" ? id : null;
}

/**
 * Settings pages mount no chat. Core controls there, such as New automation and
 * the Resources create menu, post their prompt to this window and buffer it for
 * a chat that mounts later. While `active`, this hook switches to Personal
 * workspace and opens a Native chat, so Core replays the prompt, with its
 * context, into a new Personal thread. A prompt that no chat claims before the
 * buffer expires is returned so the layout can show it for copying.
 */
export function useSettingsChatHandoff(active: boolean) {
  const navigate = useNavigate();
  const { activeProject, checking, historyAvailable, selectProject } = useProjects();
  // Personal is known only once the saved selection has loaded. A project that
  // is still loading, missing, or unreadable is not treated as Personal.
  const personal = !checking && activeProject === null && historyAvailable;
  const latest = useRef({ checking, personal, selectProject, navigate });
  latest.current = { checking, personal, selectProject, navigate };
  const settleWaiters = useRef(new Set<() => void>());
  const switching = useRef<Promise<boolean> | null>(null);
  const handoffs = useRef(new Map<string, Handoff>());
  const [undelivered, setUndelivered] = useState<UndeliveredSettingsPrompt | null>(null);

  useEffect(() => {
    if (checking) return;
    for (const settle of settleWaiters.current) settle();
    settleWaiters.current.clear();
  }, [checking]);

  // Resolves false when the projects are still loading as Core's buffer expires.
  const projectsSettled = useCallback(() => new Promise<boolean>(resolve => {
    if (!latest.current.checking) {
      resolve(true);
      return;
    }
    const settle = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      settleWaiters.current.delete(settle);
      resolve(false);
    }, CORE_SUBMIT_BUFFER_MS);
    settleWaiters.current.add(settle);
  }), []);

  // Submits that arrive together share one switch, because a second selection
  // request makes Project context abandon the first.
  const switchToPersonal = useCallback((): Promise<boolean> => {
    switching.current ??= (async () => {
      try {
        if (!await projectsSettled()) return false;
        const { personal: alreadyPersonal, selectProject: select } = latest.current;
        return alreadyPersonal || await select(null);
      } finally {
        switching.current = null;
      }
    })();
    return switching.current;
  }, [projectsSettled]);

  useEffect(() => {
    const pending = handoffs.current;
    const targeted = (event: Event) => {
      const id = submitIdOf(event);
      if (!id) return;
      const handoff = pending.get(id);
      if (handoff) {
        clearTimeout(handoff.timer);
        handoff.phase = "targeted";
      }
      // A late delivery still counts, so withdraw an alert already shown for it.
      setUndelivered(current => current?.submitMessageId === id ? null : current);
    };
    const resulted = (event: Event) => {
      const id = submitIdOf(event);
      const handoff = id ? pending.get(id) : undefined;
      if (!id || !handoff) return;
      clearTimeout(handoff.timer);
      pending.delete(id);
      // Core rejects some submits at once, for example when the composer is
      // disabled or the thread cannot be created.
      if ((event as CustomEvent<{ delivered?: unknown }>).detail?.delivered === false) {
        setUndelivered({ submitMessageId: id, prompt: handoff.prompt, reason: "not-delivered" });
      }
    };
    window.addEventListener(SUBMIT_TARGET_EVENT, targeted);
    window.addEventListener(AGENT_CHAT_SUBMIT_RESULT_EVENT, resulted);
    return () => {
      window.removeEventListener(SUBMIT_TARGET_EVENT, targeted);
      window.removeEventListener(AGENT_CHAT_SUBMIT_RESULT_EVENT, resulted);
      for (const handoff of pending.values()) clearTimeout(handoff.timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const pending = handoffs.current;
    const handOff = async (submitMessageId: string | undefined, prompt: string) => {
      // Core buffers only submits that carry an id, so nothing can replay this one.
      if (!submitMessageId) {
        setUndelivered({ submitMessageId: null, prompt, reason: "not-delivered" });
        return;
      }
      if (pending.has(submitMessageId)) return;
      const handoff: Handoff = { prompt, phase: "switching" };
      handoff.timer = setTimeout(() => {
        pending.delete(submitMessageId);
        setUndelivered({ submitMessageId, prompt,
          reason: handoff.phase === "switching" ? "selection-failed" : "not-delivered" });
      }, CORE_SUBMIT_BUFFER_MS);
      pending.set(submitMessageId, handoff);
      const switched = await switchToPersonal();
      // The buffer expired or Core answered while the switch was running.
      if (pending.get(submitMessageId) !== handoff) return;
      if (!switched) {
        clearTimeout(handoff.timer);
        pending.delete(submitMessageId);
        setUndelivered({ submitMessageId, prompt, reason: "selection-failed" });
        return;
      }
      handoff.phase = "opened";
      latest.current.navigate(SETTINGS_CHAT_PATH);
    };
    const received = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const submit = parseSubmitChatMessage(event);
      if (submit) void handOff(submit.submitMessageId, submit.message);
    };
    window.addEventListener("message", received);
    return () => window.removeEventListener("message", received);
  }, [active, switchToPersonal]);

  const dismiss = useCallback(() => setUndelivered(null), []);
  return { undelivered, dismiss };
}
