import { useEffect, useState } from "react";
import { Button, Input } from "@agent-native/toolkit/ui";
import { SettingsGroup, SettingsRow } from "@agent-native/core/client/settings";
import { useActionQuery, callAction, actionErrorMessage } from "@agent-native/core/client/hooks";

type DesktopSettings = {
  discord: {
    enabled: boolean;
    applicationId: string;
  };
};

export function DiscordPresenceSettings() {
  const query = useActionQuery<DesktopSettings>("vivary-desktop-settings", {}, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [enabled, setEnabled] = useState(false);
  const [applicationId, setApplicationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!query.data || initialized) return;
    setEnabled(query.data.discord.enabled);
    setApplicationId(query.data.discord.applicationId);
    setInitialized(true);
  }, [initialized, query.data]);

  async function save(next: DesktopSettings) {
    setBusy(true);
    setError("");
    try {
      await callAction("vivary-update-desktop-settings", next);
      setEnabled(next.discord.enabled);
      setApplicationId(next.discord.applicationId);
      await query.refetch();
    } catch (cause) {
      const saved = query.data?.discord;
      setEnabled(saved?.enabled ?? false);
      setApplicationId(saved?.applicationId ?? "");
      setError(actionErrorMessage(cause) ?? "Desktop settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (query.isError) {
    return <p className="text-sm text-muted-foreground">Discord presence is available only in the desktop app.</p>;
  }

  return (
    <SettingsGroup title="Discord presence">
      <SettingsRow
        id="discord-enabled"
        label="Share project activity"
        description="Show your active project and phase in Discord. Nothing leaves this computer except what you turn on here."
        control={
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!initialized || busy}
              onChange={(event) => {
                const checked = event.target.checked;
                setEnabled(checked);
                void save({ discord: { enabled: checked, applicationId: applicationId.trim() } });
              }}
            />
            <span>{enabled ? "On" : "Off"}</span>
          </label>
        }
      />
      <SettingsRow
        id="discord-application-id"
        label="Application id"
        description="Create an application in the Discord Developer Portal and paste its numeric id. It is not a secret, but it names your app in Discord."
        control={
          <div className="flex w-full max-w-md flex-col gap-2">
            <Input
              value={applicationId}
              disabled={!initialized || busy}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="123456789012345678"
              aria-label="Discord application id"
              onChange={(event) => setApplicationId(event.target.value)}
              onBlur={() => {
                if (!initialized) return;
                void save({ discord: { enabled, applicationId: applicationId.trim() } });
              }}
            />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!error && busy && <p className="text-sm text-muted-foreground">Saving…</p>}
            {!error && !busy && (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={!initialized}
                onClick={() => { void save({ discord: { enabled, applicationId: applicationId.trim() } }); }}
              >
                Save Discord settings
              </Button>
            )}
          </div>
        }
      />
    </SettingsGroup>
  );
}
