#!/usr/bin/env node
// Talk to an already-running test app from a terminal. Meant for agents and
// for debugging a scenario step by step.
//
//   HERMES_E2E_BRIDGE_FILE=<run dir>/bridge.json node e2e/app/cli.mjs <command>
//
//   health                     is the app up?
//   window                     window title, size, focus state, window id
//   eval '<js>'                run the body of an async function in the app
//   click '<css selector>'
//   click-name '<button text or accessible name>'
//   terminals                  session ids that have a terminal
//   read <sessionId>           print what a terminal shows
//   type <sessionId> '<text>'  type into a terminal (\n = Enter)
//   screenshot <file.png>
//   quit

import { Bridge } from "./harness.mjs";

const file = process.env.HERMES_E2E_BRIDGE_FILE;
if (!file) {
  console.error("set HERMES_E2E_BRIDGE_FILE to the bridge.json of the running test app");
  process.exit(2);
}
const bridge = Bridge.fromFile(file);
const [command, ...args] = process.argv.slice(2);

const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

try {
  switch (command) {
    case "health":
      print(await bridge.health());
      break;
    case "window":
      print(await bridge.windowInfo());
      break;
    case "eval":
      print(await bridge.eval(args[0], { timeoutMs: Number(args[1] ?? 10_000) }));
      break;
    case "click":
      print(await bridge.click(args[0]));
      break;
    case "click-name":
      print(await bridge.clickByName(args[0], { within: args[1] }));
      break;
    case "terminals":
      print(await bridge.terminalIds());
      break;
    case "read":
      print(((await bridge.readTerminal(args[0])) ?? ["<no such terminal>"]).join("\n"));
      break;
    case "type":
      print(await bridge.typeInTerminal(args[0], args[1].replace(/\\n/g, "\n")));
      break;
    case "screenshot":
      print(await bridge.screenshot(args[0]));
      break;
    case "quit":
      await bridge.quit();
      print("quit requested");
      break;
    default:
      console.error(`unknown command: ${command ?? "(none)"}`);
      process.exit(2);
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exit(1);
}
