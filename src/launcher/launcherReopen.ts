// ⌘N while a launch is still finishing.
//
// After Launch the sheet stays up for a moment (the sessions start, the
// launch is recorded) and then closes itself. A ⌘N pressed in that moment
// found the launcher "already open" and did nothing, and the closing sheet
// then took it away: the key press was lost and no launcher came up. Now
// that press is remembered, and a fresh launcher opens as soon as the
// finished one has closed.

export class LauncherReopen {
  private launching = false;
  private reopen = false;

  /** A launch from the sheet has started. */
  launchStarted(): void {
    this.launching = true;
  }

  /** The launch failed: the sheet stays open to say so, nothing is pending. */
  launchFailed(): void {
    this.launching = false;
    this.reopen = false;
  }

  /**
   * ⌘N (or the + button). True: open the launcher now (or keep the open one).
   * False: a launch is finishing in the open sheet; a fresh one opens when it closes.
   */
  requestOpen(isOpen: boolean): boolean {
    if (isOpen && this.launching) {
      this.reopen = true;
      return false;
    }
    return true;
  }

  /** The sheet closed. True: a ⌘N came while it was launching, so open a fresh one now. */
  closed(): boolean {
    const again = this.launching && this.reopen;
    this.launching = false;
    this.reopen = false;
    return again;
  }
}
