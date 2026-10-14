// ─── Session actions: the words people read ───────────────────────────
//
// An action's label and description are interface strings in every
// language pack (sessionActions.action.<id>, .desc); a built-in command
// without an action has its own (agentCommand.<agent>.<slug>.*, see
// ./messages); a command found in the person's files shows what it is
// typed as, and the description the file gives.

import { translate } from "../i18n/registry";
import type { SessionActionId, SessionCommand } from "./catalog";

type T = (key: string, values?: Record<string, string | number>) => string;

/** translate(), or `fallback` when the key has no string in any language. */
function orFallback(t: T, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

export function actionLabel(action: SessionActionId, t: T = translate): string {
  return t(`sessionActions.action.${action}`);
}

export function actionDescription(action: SessionActionId, t: T = translate): string {
  return t(`sessionActions.action.${action}.desc`);
}

export function commandLabel(cmd: SessionCommand, t: T = translate): string {
  if (cmd.action) return actionLabel(cmd.action, t);
  if (cmd.messageKey) return orFallback(t, `${cmd.messageKey}.label`, cmd.label || cmd.text);
  return cmd.label || cmd.text;
}

export function commandDescription(cmd: SessionCommand, t: T = translate): string {
  if (cmd.action) return actionDescription(cmd.action, t);
  if (cmd.messageKey) return orFallback(t, `${cmd.messageKey}.description`, cmd.description);
  return cmd.description;
}

/** What running a destructive command costs, in one plain sentence. */
export function commandConsequence(cmd: SessionCommand, t: T = translate): string {
  if (cmd.consequenceKey) return orFallback(t, cmd.consequenceKey, cmd.consequence ?? "");
  if (cmd.action) return t(`sessionActions.consequence.${cmd.action}`);
  return cmd.consequence ?? "";
}

/** The confirm question and its button for a destructive command. */
export function confirmWords(cmd: SessionCommand, agentName: string, t: T = translate): { question: string; button: string } {
  switch (cmd.action) {
    case "new_chat":
      return { question: t("sessionActions.confirm.newChat"), button: t("sessionActions.action.new_chat") };
    case "exit":
      return { question: t("sessionActions.confirm.exit", { agent: agentName }), button: t("sessionActions.action.exit") };
    case "logout":
      return { question: t("sessionActions.confirm.logout", { agent: agentName }), button: t("sessionActions.action.logout") };
    default: {
      const label = commandLabel(cmd, t);
      return { question: t("sessionActions.confirm.generic", { command: label }), button: label };
    }
  }
}
