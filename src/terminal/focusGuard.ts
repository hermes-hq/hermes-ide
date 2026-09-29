// A terminal never takes the keyboard from an open modal dialog: a session
// that starts while one is open (the task launcher's Launch & next keeps its
// sheet open for the next task) would otherwise pull the focus into its
// terminal, and the next keys typed would go to the agent.

/** Whether the keyboard is in an open modal dialog that does not hold this terminal. */
export function dialogHoldsKeyboard(terminalContainer: Element, active: Element | null = document.activeElement): boolean {
  const dialog = active?.closest('[aria-modal="true"]');
  return !!dialog && !dialog.contains(terminalContainer);
}
