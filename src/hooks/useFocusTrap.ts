// ─── Keyboard for a modal dialog ─────────────────────────────────────────
//
// A modal opened from the menu bar (Settings, Keyboard Shortcuts, the Cost
// Dashboard) used to leave the keyboard in the terminal behind it: what the
// person typed next went to the hidden shell, and Esc never reached the
// dialog. While a dialog using this hook is open:
//
//   - the keyboard moves into it (`initialFocus`, else its first control,
//     else the dialog itself);
//   - Tab and Shift+Tab cycle through its controls only;
//   - Esc closes it (`onEscape`), unless something inside the dialog
//     handled that Esc already (a rename field cancels its edit first);
//   - a terminal behind it cannot take the keyboard back (xterm refocuses
//     itself on output, a session switch, a click that lands late): the
//     terminals are inert while it is open;
//   - when it closes, the keyboard goes back to where it was (the terminal
//     it came from), if that is still on screen and nothing else took it.
//
// Dialogs stack: only the most recently opened one reacts to keys.
// Generalised from DirtyWorktreeDialog's trap.

import { useEffect, useRef, type RefObject } from "react";

/** What can take the keyboard inside a dialog, in Tab order. */
export const FOCUSABLE =
	'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
	/** Esc: close the dialog. Not called when an element inside handled that Esc (preventDefault). */
	onEscape?: () => void;
	/** The control to start on (a selector inside the dialog); default: the first one. */
	initialFocus?: string;
	/** Off: the hook does nothing (a dialog rendered but not open). */
	active?: boolean;
}

/** The open traps, oldest first: only the last one handles keys. */
const stack: Array<RefObject<HTMLElement | null>> = [];

/** The controls of `root` that are on screen, in Tab order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => !el.closest("[inert]") && (el.offsetParent !== null || el.getClientRects().length > 0 || el === document.activeElement),
	);
}

/** The terminal's own input (xterm's helper textarea). */
function isTerminalInput(el: Element | null): boolean {
	return !!el && (el.classList.contains("xterm-helper-textarea") || !!el.closest(".xterm"));
}

/**
 * The keyboard is in another dialog or popup that is not inside `root` (a
 * confirmation shown over it, a menu in a portal): its keys are its own.
 */
function inOtherSurface(root: HTMLElement): boolean {
	const at = document.activeElement;
	if (!at || at === document.body || root.contains(at)) return false;
	return !!at.closest('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

/**
 * Make the terminals behind `root` unable to take the keyboard (inert), and
 * return how to undo it. The focusin guard below needs focus events, and a
 * window without the system focus (in the background) gets none: a
 * terminal's focus() there would move the keyboard without a word.
 */
function inertTerminalsOutside(root: HTMLElement): () => void {
	const changed: HTMLElement[] = [];
	for (const el of Array.from(document.querySelectorAll<HTMLElement>(".xterm"))) {
		if (root.contains(el) || el.hasAttribute("inert")) continue;
		el.setAttribute("inert", "");
		changed.push(el);
	}
	return () => {
		for (const el of changed) el.removeAttribute("inert");
	};
}

/** Move the keyboard into `root`: `initialFocus`, its first control, or the dialog itself. */
export function focusInto(root: HTMLElement, initialFocus?: string): void {
	const preferred = initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null;
	const target = preferred ?? focusableIn(root)[0] ?? root;
	if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
	target.focus({ preventScroll: true });
}

/**
 * Trap the keyboard in the dialog `ref` points at while it is mounted (and
 * `active`). See the file header.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, { onEscape, initialFocus, active = true }: FocusTrapOptions = {}): void {
	const escape = useRef(onEscape);
	escape.current = onEscape;

	useEffect(() => {
		if (!active) return;
		const root = ref.current;
		if (!root) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		stack.push(ref);
		const top = () => stack[stack.length - 1] === ref;

		// The dialog takes the keyboard once it is painted (a lazy panel's
		// controls may arrive a frame later).
		const blurTerminal = () => {
			if (isTerminalInput(document.activeElement)) (document.activeElement as HTMLElement).blur();
		};
		blurTerminal();
		const restoreTerminals = inertTerminalsOutside(root);
		focusInto(root, initialFocus);
		const frame = requestAnimationFrame(() => {
			if (top() && !root.contains(document.activeElement)) focusInto(root, initialFocus);
		});

		const onKeyDown = (e: KeyboardEvent) => {
			if (!top() || e.defaultPrevented || inOtherSurface(root)) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				escape.current?.();
				return;
			}
			if (e.key !== "Tab") return;
			const items = focusableIn(root);
			if (items.length === 0) {
				e.preventDefault();
				root.focus({ preventScroll: true });
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const at = document.activeElement as HTMLElement | null;
			const inside = !!at && root.contains(at);
			if (e.shiftKey && (!inside || at === first)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (!inside || at === last)) {
				e.preventDefault();
				first.focus();
			}
		};
		// A terminal behind the dialog never takes the keyboard back.
		const onFocusIn = (e: FocusEvent) => {
			if (!top()) return;
			const target = e.target as Element | null;
			if (isTerminalInput(target) && !root.contains(target)) {
				(target as HTMLElement).blur();
				focusInto(root, initialFocus);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("focusin", onFocusIn, true);

		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("focusin", onFocusIn, true);
			const i = stack.lastIndexOf(ref);
			if (i >= 0) stack.splice(i, 1);
			restoreTerminals();
			// Give the keyboard back, unless something else took it meanwhile.
			const now = document.activeElement;
			const lost = !now || now === document.body || root.contains(now) || !now.isConnected;
			if (lost && previous && previous.isConnected && !root.contains(previous)) {
				previous.focus({ preventScroll: true });
			}
		};
		// The trap is set up once per open; `initialFocus` is read at open.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, ref]);
}

// ─── A modal that is modal for the keyboard and screen readers too ───────
//
// For dialogs that place the keyboard themselves (the task launcher, the
// welcome): while it is open, while it is open, Tab and
// Shift+Tab wrap around inside it, and everything else on the page is inert
// (no Tab stop, no click, hidden from screen readers), so neither the
// keyboard nor a screen reader can wander into the app behind it.

const TABBABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]";

/** The elements Tab stops at inside `root`, in order. */
export function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest("[inert]")) return false;
    // Hidden (display: none on it or an ancestor) or not laid out.
    if (el.getClientRects().length === 0 && el !== document.activeElement) return false;
    return getComputedStyle(el).visibility !== "hidden";
  });
}

/** Marks every element outside `root` inert; returns how to undo it. */
function makeOutsideInert(root: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = root;
  while (node && node !== document.body && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.inert || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      sibling.inert = true;
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

/**
 * Keeps the keyboard inside `ref` while `active`: Tab past the last control
 * goes to the first, Shift+Tab before the first to the last, and the rest of
 * the page is inert.
 */
export function useModalTabTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const restore = makeOutsideInert(root);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const stops = tabbablesIn(root);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement as HTMLElement | null;
      const inside = !!at && root.contains(at);
      if (e.shiftKey && (!inside || at === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || at === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      restore();
    };
  }, [ref, active]);
}
