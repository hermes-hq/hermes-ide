// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { dialogHoldsKeyboard, mayRefocusTerminalOnReturn } from "../terminal/focusGuard";

afterEach(() => {
  document.body.innerHTML = "";
});

function setup(dialogHtml: string) {
  document.body.innerHTML = `<div id="pane"><div id="term"><textarea class="xterm-helper-textarea"></textarea></div></div>${dialogHtml}`;
  return document.getElementById("term") as HTMLElement;
}

describe("a terminal never takes the keyboard from an open modal dialog", () => {
  it("the task launcher's field holds the keyboard: a new session's terminal does not take it", () => {
    const term = setup(`<div role="dialog" aria-modal="true"><textarea class="task-launcher-task"></textarea></div>`);
    (document.querySelector(".task-launcher-task") as HTMLElement).focus();
    expect(dialogHoldsKeyboard(term)).toBe(true);
  });

  it("no dialog, or a dialog that is not modal (the attention inbox), or nothing focused: the terminal may take it", () => {
    const term = setup(`<div role="dialog"><button id="b">x</button></div>`);
    expect(dialogHoldsKeyboard(term)).toBe(false);
    (document.getElementById("b") as HTMLElement).focus();
    expect(dialogHoldsKeyboard(term)).toBe(false);
    (term.querySelector("textarea") as HTMLElement).focus();
    expect(dialogHoldsKeyboard(term)).toBe(false);
  });

  it("a terminal inside the open modal may take the keyboard", () => {
    document.body.innerHTML = `<div role="dialog" aria-modal="true"><input id="i"><div id="term"></div></div>`;
    (document.getElementById("i") as HTMLElement).focus();
    expect(dialogHoldsKeyboard(document.getElementById("term") as HTMLElement)).toBe(false);
  });

  it("once the dialog is gone the terminal takes it again", () => {
    const term = setup(`<div id="d" role="dialog" aria-modal="true"><input id="i"></div>`);
    (document.getElementById("i") as HTMLElement).focus();
    expect(dialogHoldsKeyboard(term)).toBe(true);
    document.getElementById("d")?.remove();
    expect(dialogHoldsKeyboard(term)).toBe(false);
  });
});

describe("coming back to the window leaves the keyboard in a text field outside the terminal", () => {
  it("the Library search, a sidebar rename or the commit message keep it", () => {
    document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div><input id="search" type="text"><textarea id="commit"></textarea><div id="name" contenteditable="true"></div>`;
    for (const id of ["search", "commit"]) {
      (document.getElementById(id) as HTMLElement).focus();
      expect(mayRefocusTerminalOnReturn(false), id).toBe(false);
    }
    const name = document.getElementById("name") as HTMLElement;
    Object.defineProperty(name, "isContentEditable", { value: true });
    expect(mayRefocusTerminalOnReturn(false, name)).toBe(false);
  });

  it("the terminal itself, a button or nothing focused: the terminal takes it back", () => {
    document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div><button id="b">x</button>`;
    (document.querySelector(".xterm-helper-textarea") as HTMLElement).focus();
    expect(mayRefocusTerminalOnReturn(false)).toBe(true);
    (document.getElementById("b") as HTMLElement).focus();
    expect(mayRefocusTerminalOnReturn(false)).toBe(true);
    (document.getElementById("b") as HTMLElement).blur();
    expect(mayRefocusTerminalOnReturn(false)).toBe(true);
  });

  it("an open overlay keeps it whatever is focused", () => {
    expect(mayRefocusTerminalOnReturn(true, document.body)).toBe(false);
  });

});
