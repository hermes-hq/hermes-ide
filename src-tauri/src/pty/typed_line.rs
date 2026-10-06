//! Whether the person has text on the shell's command line that they have
//! not entered yet, read from what the terminal sends to the shell.
//!
//! Hermes types an agent's launch line (and the context nudge) into the
//! session's shell on its own. Typed into a line the person is writing, the
//! two run together ("claudeRead the file ...") and neither works, so those
//! writes wait for, or skip, a line with pending text.
//!
//! Only text counts: escape sequences the terminal sends by itself (replies
//! to the shell's queries, focus reports, arrow keys) do not. Enter, Ctrl+C
//! and Ctrl+U end the line. Backspace does not (the line may still hold
//! text), so a line once typed into counts as pending until it ends.

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Esc {
    #[default]
    None,
    /// After ESC.
    Start,
    /// Inside CSI (`ESC [`) until its final byte.
    Csi,
    /// After SS3 (`ESC O`, arrows in application mode): one more byte.
    Ss3,
    /// Inside a string (OSC `ESC ]`, DCS `ESC P`, APC, PM, SOS) until BEL or ST.
    Str,
    /// ESC seen inside a string: `\` ends it.
    StrEnd,
}

#[derive(Debug, Default)]
pub struct TypedLine {
    pending: bool,
    esc: Esc,
}

impl TypedLine {
    /// The command line holds text the person typed or pasted and has not
    /// entered.
    pub fn pending(&self) -> bool {
        self.pending
    }

    /// Read bytes the terminal sent to the shell.
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.esc = match self.esc {
                Esc::None => match b {
                    0x1b => Esc::Start,
                    // Enter, Ctrl+C, Ctrl+U: the line is over.
                    b'\r' | b'\n' | 0x03 | 0x15 => {
                        self.pending = false;
                        Esc::None
                    }
                    // Text (UTF-8 continuation bytes included); other control
                    // keys and Backspace leave the line as it was.
                    0x20..=0x7e | 0x80..=0xff => {
                        self.pending = true;
                        Esc::None
                    }
                    _ => Esc::None,
                },
                Esc::Start => match b {
                    b'[' => Esc::Csi,
                    b'O' => Esc::Ss3,
                    b']' | b'P' | b'_' | b'^' | b'X' => Esc::Str,
                    // Alt+key: moves or edits, puts no text on the line.
                    _ => Esc::None,
                },
                Esc::Ss3 => Esc::None,
                Esc::Csi => match b {
                    0x40..=0x7e => Esc::None,
                    _ => Esc::Csi,
                },
                Esc::Str => match b {
                    0x07 => Esc::None,
                    0x1b => Esc::StrEnd,
                    _ => Esc::Str,
                },
                Esc::StrEnd => match b {
                    b'\\' => Esc::None,
                    _ => Esc::Str,
                },
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(chunks: &[&[u8]]) -> bool {
        let mut t = TypedLine::default();
        for c in chunks {
            t.feed(c);
        }
        t.pending()
    }

    #[test]
    fn typed_text_is_pending_until_entered() {
        assert!(after(&[b"ulimit -n 10240 && claude"]));
        assert!(!after(&[b"ls -la\r"]));
        assert!(after(&[b"ls\r", b"cl"]));
        assert!(!after(&[b"oops", &[0x03]]), "Ctrl+C ends the line");
        assert!(!after(&[b"oops", &[0x15]]), "Ctrl+U clears the line");
        assert!(after(&[b"x", &[0x7f]]), "Backspace: maybe still text");
        assert!(after(&["café".as_bytes()]));
    }

    #[test]
    fn what_the_terminal_sends_on_its_own_is_not_typing() {
        // Cursor position report, device attributes, focus in and out.
        assert!(!after(&[
            b"\x1b[12;1R",
            b"\x1b[?1;2c",
            b"\x1b[I",
            b"\x1b[O"
        ]));
        // An OSC colour reply ended by ST, and one ended by BEL.
        assert!(!after(&[
            b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
            b"\x1b]10;rgb:ffff/ffff/ffff\x07"
        ]));
        // DCS reply (XTGETTCAP), arrows in normal and application mode.
        assert!(!after(&[
            b"\x1bP1+r544e=787465726d\x1b\\",
            b"\x1b[A",
            b"\x1bOB"
        ]));
    }

    #[test]
    fn sequences_split_across_writes_are_still_skipped() {
        assert!(!after(&[b"\x1b[12", b";40R"]));
        assert!(!after(&[b"\x1b]11;rgb:00", b"00/0000/0000\x1b", b"\\"]));
        assert!(after(&[b"\x1b[I", b"g"]), "text after a sequence counts");
    }

    #[test]
    fn a_bracketed_paste_counts_and_its_final_enter_ends_the_line() {
        assert!(after(&[b"\x1b[200~git status\x1b[201~"]));
        assert!(!after(&[b"\x1b[200~git status\r\x1b[201~"]));
    }
}
