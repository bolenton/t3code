import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  canOpenLinksInApp,
  getBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";
import { openUrlInPreview } from "./openFileInPreview";

const NO_MODIFIER = { metaKey: false, ctrlKey: false } as const;

/**
 * Opens a URL where the "Open links in" setting says, for buttons that sit
 * beside a thread but are not markdown anchors: CI check details, a pull
 * request that has no project to open in the panel. Without a thread there is
 * nowhere to put an in-app tab, so the link goes to the system browser.
 *
 * The in-app open falling over is reported through the returned promise, so
 * the caller decides whether that deserves a toast; the system-browser path
 * rejects the same way `shell.openExternal` does.
 */
export function useOpenLink(
  threadRef: ScopedThreadRef | null | undefined,
): (
  url: string,
  event?: { readonly metaKey: boolean; readonly ctrlKey: boolean },
) => Promise<void> {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return useCallback(
    async (url, event = NO_MODIFIER) => {
      const target = resolveLinkTarget({
        url,
        event,
        preference: getBrowserLinkTargetPreference(),
        canOpenInApp: canOpenLinksInApp(Boolean(threadRef)),
      });
      if (target === "app" && threadRef) {
        const result = await openUrlInPreview({ threadRef, url, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        throw new Error("Unable to open the link in T3 Code.", { cause: result.cause });
      }
      const api = readLocalApi();
      if (!api) throw new Error("Link opening is unavailable.");
      await api.shell.openExternal(url);
    },
    [openPreview, threadRef],
  );
}
