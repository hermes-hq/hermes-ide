#!/usr/bin/env node
// QA-notices-card: notices from the Hermes team, one quiet card at the bottom
// of the sessions sidebar, above "New group".
//
// The notices file comes from a local server on 127.0.0.1 (the test build
// reads HERMES_E2E_NOTICES_URL; nothing reaches hermes-ide.com, and an
// image under https://hermes-ide.com/notices/ is fetched from the same local
// server). It holds a notice whose link leads off the allow-list, one that
// links to the Hermes site with an image, and one whose image is on another
// site. The landed-task count and the card state are seeded through the
// settings, and the page reloaded so the card reads them again.
//
//   run 1  fresh install, welcome finished.
//          - the notices file and its allowed image are fetched once, with
//            no query string and no cookie; the notice with the foreign link
//            is dropped entirely, the other shows as the card with its image
//            (a data: URL, decoded); × marks it read and it stays gone after
//            a reload, with no second fetch
//          - the notice whose image is on another site shows without it
//          - the star ask: not with 4 landed tasks, not on 2 days, not in the
//            first 7 days; shows with 5 tasks on 3 days after the 7 days,
//            with its bundled illustration
//          - it hides while an agent waits on the person and comes back
//          - Later snoozes it (gone, also after a reload); 30 days on it is
//            back without Later; × closes it for good
//          - Star on GitHub opens github.com/hermes-hq/hermes-ide (the
//            test build records the link instead of opening a browser),
//            thanks, and never shows again
//   run 2  relaunch with the fetch due on every call: the Settings switch
//          "Show notices from the Hermes team" hides the card while
//          Settings is open (a dialog), turned off it stays hidden after
//          Settings closes and after a reload, and nothing is fetched.
//
// Negative control: HERMES_E2E_NOTICES_NEGATIVE=1 seeds 4 landed tasks where
// the scenario expects 5; the star-ask checks must then fail.

import { createServer } from "node:http";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { dismissWhatsNew, invoke } from "../launcher-steps.mjs";

const NAME = "QA-notices-card";
const NEGATIVE = process.env.HERMES_E2E_NOTICES_NEGATIVE === "1";
const DAY = 24 * 60 * 60 * 1000;

const NOTICES = {
  version: 1,
  notices: [
    { id: "foreign-link", title: "Win a prize", body: "Click here.", link: { label: "Claim it", url: "https://evil.example/prize" } },
    {
      id: "whats-new-test",
      title: "Start a project from scratch",
      body: "New folder in the launcher makes the folder, a git repository and an AGENTS.md in one step.",
      link: { label: "Read the release notes", url: "https://hermes-ide.com/changelog" },
      image: { url: "https://hermes-ide.com/notices/test.png", alt: "A test picture" },
    },
    {
      id: "foreign-image",
      title: "A picture from elsewhere",
      body: "The picture is on another site, so the card shows without it.",
      image: { url: "https://evil.example/notices/x.png", alt: "Elsewhere" },
    },
  ],
};

/** A real PNG: w×h pixels of one colour. */
function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const TEST_PNG = solidPng(64, 32, [58, 110, 165]);

const hits = [];
const server = createServer((req, res) => {
  hits.push({ url: req.url, cookie: req.headers.cookie ?? null });
  if (req.url === "/notices/test.png") {
    res.writeHead(200, { "content-type": "image/png", "content-length": TEST_PNG.length });
    res.end(TEST_PNG);
    return;
  }
  if (req.url !== "/notices.json") {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(NOTICES));
  res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const URL = `http://127.0.0.1:${server.address().port}/notices.json`;

const CARD = ".session-list .notice-card";
const cardState = (bridge) =>
  bridge.eval(`
    const card = e2e.first(${JSON.stringify(CARD)});
    if (!card) return null;
    return {
      id: card.getAttribute("data-notice"),
      text: e2e.norm(card.innerText),
      buttons: e2e.all("button", card).map((b) => e2e.norm(b.getAttribute("aria-label") || b.innerText)),
      aboveNewGroup: !!card.nextElementSibling?.classList.contains("session-list-footer"),
      image: (() => {
        const img = card.querySelector("img.notice-card-image");
        if (!img) return null;
        return { first: card.firstElementChild === img, src: img.getAttribute("src").slice(0, 22), alt: img.alt, decoded: img.complete && img.naturalWidth > 0, ratio: Math.round((img.getBoundingClientRect().width / img.getBoundingClientRect().height) * 100) / 100, fullWidth: Math.abs(img.getBoundingClientRect().width - card.clientWidth) <= 1 };
      })(),
    };
  `);

async function settings(bridge) {
  return invoke(bridge, "get_settings");
}

async function seed(bridge, { state, landed }) {
  if (state) await invoke(bridge, "set_setting", { key: "notices_state", value: JSON.stringify(state) });
  if (landed) await invoke(bridge, "set_setting", { key: "notices_landed", value: JSON.stringify(landed) });
  await bridge.reload();
  await bridge.waitFor("the sessions sidebar after the reload", `return !!e2e.first(".session-list");`, { timeoutMs: 30_000 });
  await dismissWhatsNew(bridge);
}

const waitCard = (bridge, what, id) =>
  bridge.waitFor(what, `const c = e2e.first(${JSON.stringify(CARD)}); return c && c.getAttribute("data-notice") === ${JSON.stringify(id)} ? true : false;`, { timeoutMs: 15_000 }).then(
    () => true,
    () => false,
  );

/** The card stays away for a few re-checks (it re-checks every 1.5 s). */
async function staysAway(bridge) {
  for (let i = 0; i < 4; i++) {
    await sleep(1000);
    if (await bridge.exists(CARD)) return false;
  }
  return true;
}

const landedOn = (count, days) => ({ count, days: days.map((d) => `2026-09-${String(d).padStart(2, "0")}`) });

try {
  await runLauncherQa(
    NAME,
    async ({ bridge, log, check, assert, evidenceDir, relaunch, current }) => {
      await bridge.waitFor("the sessions sidebar", `return !!e2e.first(".session-list");`, { timeoutMs: 30_000 });

      // ── Remote notices ────────────────────────────────────────────────
      const remoteShown = await waitCard(bridge, "the remote notice card", "whats-new-test");
      const remote = await cardState(bridge);
      log(`  card: ${JSON.stringify(remote)}`);
      await bridge.screenshot(join(evidenceDir, "01-remote-notice.png"));
      check(remoteShown, "the notice that links to the Hermes site shows as the card");
      check(remote?.aboveNewGroup, "at the bottom of the sessions sidebar, right above New group");
      check(remote?.text.includes("From the Hermes team") && remote?.text.includes("Start a project from scratch"), "with its header, title and body as plain text");
      check(remote?.buttons.includes("Read the release notes") && remote?.buttons.includes("Close this notice"), "with its link and a × named Close this notice");
      check(
        remote?.image?.first && remote.image.src === "data:image/png;base64," && remote.image.alt === "A test picture" && remote.image.decoded,
        "its image sits at the top of the card as a data: URL with its alt text, and is drawn",
      );
      check(remote?.image?.ratio === 2 && remote.image.fullWidth, `full card width at 2:1 (${remote?.image?.ratio})`);
      const listed = await invoke(bridge, "notices_list");
      check(
        JSON.stringify(listed.map((n) => n.id)) === JSON.stringify(["whats-new-test", "foreign-image"]),
        `the notice with a link off the allow-list is dropped entirely (${JSON.stringify(listed.map((n) => n.id))})`,
      );
      check(!(await bridge.eval(`return document.body.innerText.includes("Win a prize");`)), "and nothing of it is on screen");
      check(listed[1]?.image === null, "the notice whose image is on another site is listed without the image");
      log(`  fetches so far: ${JSON.stringify(hits)}`);
      const fileHits = () => hits.filter((h) => h.url.startsWith("/notices.json")).length;
      check(fileHits() === 1, `the notices file was fetched once (${fileHits()})`);
      check(hits.filter((h) => h.url === "/notices/test.png").length === 1, "and its allowed image once");
      check(hits.length === 2 && hits.every((h) => (h.url === "/notices.json" || h.url === "/notices/test.png") && h.cookie === null), "with no query string and no cookie, and nothing else");

      await bridge.click(`${CARD} [aria-label="Close this notice"]`);
      await bridge.waitFor("the card to go", `return !e2e.first(${JSON.stringify(CARD)});`);
      let st = JSON.parse((await settings(bridge)).notices_state || "{}");
      check(st.read?.includes("whats-new-test"), "× marks the notice read");
      await seed(bridge, {});
      check(await staysAway(bridge), "and it stays gone after a reload");
      check(hits.length === 2, `with no second fetch the same day (${hits.length} requests)`);
      const firstSeen = st.firstSeen;
      check(typeof firstSeen === "number" && Date.now() - firstSeen < 10 * 60 * 1000, "the first run started the 7-day grace");

      // A week on, the next notice: its image is on another site.
      await seed(bridge, { state: { ...st, lastNewAt: Date.now() - 8 * DAY } });
      const foreignShown = await waitCard(bridge, "the notice with a foreign image", "foreign-image");
      const foreign = await cardState(bridge);
      log(`  card: ${JSON.stringify(foreign)}`);
      check(foreignShown && foreign?.text.includes("A picture from elsewhere"), "a notice whose image is on another site still shows");
      check(foreign && foreign.image === null, "without the image");
      await bridge.click(`${CARD} [aria-label="Close this notice"]`);
      await bridge.waitFor("the card to go", `return !e2e.first(${JSON.stringify(CARD)});`);

      // ── The star ask is earned ────────────────────────────────────────
      const now = Date.now();
      const ready = { firstSeen: now - 8 * DAY, lastNewAt: now - 8 * DAY, read: ["whats-new-test", "foreign-image"], star: { shows: 0 } };
      await seed(bridge, { state: ready, landed: landedOn(4, [1, 3, 5]) });
      check(await staysAway(bridge), "no star ask with 4 landed tasks");
      await seed(bridge, { state: ready, landed: landedOn(9, [1, 3, 3]) });
      check(await staysAway(bridge), "no star ask with tasks landed on only 2 days");
      await seed(bridge, { state: { ...ready, firstSeen: now - 6 * DAY }, landed: landedOn(5, [1, 3, 5]) });
      check(await staysAway(bridge), "no star ask in the first 7 days after first launch");
      await seed(bridge, { state: { ...ready, lastNewAt: now - 2 * DAY }, landed: landedOn(5, [1, 3, 5]) });
      check(await staysAway(bridge), "no star ask within a week of the last new card");
      await seed(bridge, { state: ready, landed: landedOn(NEGATIVE ? 4 : 5, [1, 3, 5]) });
      const starShown = await waitCard(bridge, "the star ask", "star");
      const star = await cardState(bridge);
      log(`  card: ${JSON.stringify(star)}`);
      await bridge.screenshot(join(evidenceDir, "02-star-ask.png"));
      check(starShown, "the star ask shows with 5 landed tasks on 3 days after the first 7 days");
      check(star?.text.includes("You've landed 5 tasks with Hermes."), "it says how many tasks were landed");
      check(star?.text.includes("A star on GitHub helps other developers find it."), "and why a star helps");
      check(
        ["Close this notice for good", "Star on GitHub", "Later"].every((b) => star?.buttons.includes(b)),
        `with Star on GitHub, Later and × (${JSON.stringify(star?.buttons)})`,
      );
      check(
        star?.image?.first && star.image.alt === "A glowing star above three terminal windows" && star.image.decoded && star.image.ratio === 2,
        `with its bundled illustration on top (${JSON.stringify(star?.image)})`,
      );

      // ── Polite timing: never while an agent waits on the person ───────
      const itemId = await bridge.eval(
        `return window.__HERMES_E2E__.raiseInboxItem({ kind: "blocked", sessionId: "notices-probe", detail: "Approve: rm -rf build", source: "e2e" }).id;`,
      );
      await bridge.waitFor("the card to step aside", `return !e2e.first(${JSON.stringify(CARD)});`, { timeoutMs: 10_000 }).catch(() => {});
      check(!(await bridge.exists(CARD)), "the card hides while an agent waits on the person");
      await bridge.eval(`return window.__HERMES_E2E__.resolveInboxItem(${JSON.stringify(itemId)});`);
      check(await waitCard(bridge, "the card back", "star"), "and comes back once nothing waits");

      // ── Later: once, 30 days ──────────────────────────────────────────
      await bridge.clickByName("Later", { within: CARD });
      await bridge.waitFor("the card to go", `return !e2e.first(${JSON.stringify(CARD)});`);
      st = JSON.parse((await settings(bridge)).notices_state || "{}");
      log(`  after Later: ${JSON.stringify(st.star)}`);
      check(st.star?.shows === 1 && st.star.snoozedUntil - Date.now() > 29 * DAY && !st.star.done, "Later snoozes the star ask for 30 days");
      await seed(bridge, {});
      check(await staysAway(bridge), "it stays away after a reload");
      // 31 days on (the snooze and the last new card are in the past).
      await seed(bridge, { state: { ...st, lastNewAt: Date.now() - 31 * DAY, star: { ...st.star, snoozedUntil: Date.now() - 1000 } } });
      const againShown = await waitCard(bridge, "the star ask, second showing", "star");
      const again = await cardState(bridge);
      log(`  card: ${JSON.stringify(again)}`);
      check(againShown, "after the snooze the star ask comes back once");
      check(again && !again.buttons.includes("Later") && again.buttons.includes("Star on GitHub"), "without Later: only Star on GitHub and ×");
      await bridge.click(`${CARD} [aria-label="Close this notice for good"]`);
      await bridge.waitFor("the card to go", `return !e2e.first(${JSON.stringify(CARD)});`);
      st = JSON.parse((await settings(bridge)).notices_state || "{}");
      check(st.star?.done === true, "× closes it for good");
      await seed(bridge, { state: { ...st, lastNewAt: Date.now() - 60 * DAY } });
      check(await staysAway(bridge), "and it never shows again");

      // ── Star on GitHub ────────────────────────────────────────────────
      await seed(bridge, { state: ready, landed: landedOn(NEGATIVE ? 4 : 6, [1, 3, 5]) });
      check(await waitCard(bridge, "the star ask", "star"), "the star ask shows (fresh state)");
      await bridge.clickByName("Star on GitHub", { within: CARD });
      const thanks = await bridge
        .waitFor("the thanks", `const c = e2e.first(".session-list .notice-card-thanks"); return c ? e2e.norm(c.innerText) : null;`, { timeoutMs: 5000 })
        .catch(() => null);
      const opened = await bridge.eval(`return window.__HERMES_E2E_OPENED__ ?? [];`);
      log(`  opened: ${JSON.stringify(opened)}; thanks: ${thanks}`);
      check(JSON.stringify(opened) === JSON.stringify(["https://github.com/hermes-hq/hermes-ide"]), "Star on GitHub opens the repository in the browser");
      check(thanks === "Thank you. That helps a lot.", "and says thanks");
      await bridge.waitFor("the thanks to go", `return !e2e.first(".session-list .notice-card");`, { timeoutMs: 10_000 }).catch(() => {});
      check(!(await bridge.exists(CARD)), "briefly");
      st = JSON.parse((await settings(bridge)).notices_state || "{}");
      check(st.star?.done === true, "the star ask is done");
      await seed(bridge, { state: { ...st, lastNewAt: Date.now() - 60 * DAY } });
      check(await staysAway(bridge), "and never shows again");

      // ── Run 2: the Settings switch ────────────────────────────────────
      await current().stop();
      const app2 = await relaunch(2, { HERMES_E2E_NOTICES_INTERVAL_SECS: "0" });
      const b2 = app2.bridge;
      await b2.waitFor("the sessions sidebar (run 2)", `return !!e2e.first(".session-list");`, { timeoutMs: 30_000 });
      await dismissWhatsNew(b2);
      await seed(b2, { state: ready, landed: landedOn(NEGATIVE ? 4 : 5, [1, 3, 5]) });
      check(await waitCard(b2, "the star ask (run 2)", "star"), "run 2: the star ask shows");
      await b2.clickByName("Settings");
      await b2.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
      check(await staysAway(b2), "no card while a dialog (Settings) is open");
      const sw = `[data-setting="notices_enabled"] [role="switch"]`;
      await b2.waitFor("the notices switch", `return !!e2e.first('${sw}');`);
      const label = await b2.eval(`return e2e.norm(e2e.first('[data-setting="notices_enabled"]').innerText);`);
      log(`  switch: ${label}`);
      check(label.includes("Show notices from the Hermes team"), "Settings has Show notices from the Hermes team");
      check((await b2.eval(`return e2e.first('${sw}').getAttribute("aria-checked");`)) === "true", "on by default");
      await b2.screenshot(join(evidenceDir, "03-settings-switch.png"));
      await b2.click(sw);
      await b2.waitFor("the switch saved off", `const raw = await window.__TAURI_INTERNALS__.invoke("get_settings"); return raw.notices_enabled === "off";`);
      await b2.click(".settings-close");
      await b2.waitFor("Settings to close", `return !e2e.first(".settings-title");`);
      check(await staysAway(b2), "turned off, no card after Settings closes");
      const before = hits.length;
      await seed(b2, {});
      check(await staysAway(b2), "nor after a reload");
      const listedOff = await invoke(b2, "notices_list");
      check(listedOff.length === 0, "the notices list is empty while off");
      check(hits.length === before, `and nothing is fetched while off (${hits.length - before} fetches)`);
      await b2.screenshot(join(evidenceDir, "04-switched-off.png"));
      assert(true, "done");
    },
    { env: { HERMES_E2E_NOTICES_URL: URL }, tag: "qa-notices" },
  );
} finally {
  server.close();
}
