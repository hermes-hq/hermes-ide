/** Marks an element whose area takes dropped files itself (the task launcher): the pane or panel under it must not. */
export const FILE_DROP_TARGET = "data-file-drop-target";

/** Whether the page point (CSS pixels) is over an element that takes dropped files itself. */
export function isOverFileDropTarget(x: number, y: number): boolean {
  return !!document.elementFromPoint(x, y)?.closest(`[${FILE_DROP_TARGET}]`);
}
