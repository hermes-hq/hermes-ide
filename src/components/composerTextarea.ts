/**
 * The live agent-composer textarea, if one is mounted. Kept apart from
 * SessionComposer so the app shell can read it without loading the
 * composer (which is part of the on-demand agent view).
 */
let composerTextarea: HTMLTextAreaElement | null = null;

export function getComposerTextarea(): HTMLTextAreaElement | null {
  return composerTextarea;
}

export function setComposerTextarea(el: HTMLTextAreaElement | null): void {
  composerTextarea = el;
}
