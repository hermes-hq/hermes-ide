/**
 * Extra attributes a screen may put on the focusable element of a control
 * or of one of its options (a radio, a segment, a chip's button): a hook
 * class, an id, a tooltip and data-* attributes, which is what tests and
 * automation find it by. The look still comes from the control: a hook
 * class carries no rules of its own.
 */
export type ControlAttrs = { className?: string; id?: string; title?: string } & {
  [key: `data-${string}`]: string | undefined;
};
