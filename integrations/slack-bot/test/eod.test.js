import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSlackText, findDate, matchTask, parseEod } from "../src/eod.js";

const projects = [
  { id: 1, name: "max", identifier: "max" },
  { id: 2, name: "atlas-chris", identifier: "atlas-chris" },
  { id: 3, name: "Real Estate Pipeline", identifier: "real-estate-pipeline" },
  { id: 4, name: "Quantify AI", identifier: "quantify-ai" },
];
const today = "2026-10-19";
const summary = (r) => r.sections.map((s) => `${s.project?.name ?? `?${s.heading}`}: ${s.items.map((i) => i.text + (i.hours ? ` [${i.hours}]` : "")).join(" | ")}`);

test("headings with colon, bullets, hours, tomorrow section skipped", () => {
  const r = parseEod(
    `*EOD Report – 19 Oct*
*MAX:*
• Deployed backend (2h)
• Fixed radar leads issue - 1.5h
*Atlas Chris*
1. Built login screen
2. 45m code review
*Tomorrow:*
- Start payments
*Blockers:* none`,
    projects,
    { today },
  );
  assert.equal(r.isEod, true);
  assert.equal(r.date, "2026-10-19");
  assert.deepEqual(summary(r), ["max: Deployed backend [2] | Fixed radar leads issue [1.5]", "atlas-chris: Built login screen | code review [0.75]"]);
});

test("inline project lines and Project: prefix", () => {
  const r = parseEod(
    `EOD
Project: Real Estate Pipeline
- scraped listings
Quantify AI: trained model v2 (3h)
max - hotfix deploy`,
    projects,
    { today },
  );
  assert.deepEqual(summary(r), ["Real Estate Pipeline: scraped listings", "Quantify AI: trained model v2 [3]", "max: hotfix deploy"]);
});

test("unknown project heading and items before any project", () => {
  const r = parseEod(
    `EOD update
- standup and emails
Website Revamp:
- new hero section
MAX
- api docs`,
    projects,
    { today },
  );
  assert.deepEqual(r.unassigned.map((i) => i.text), ["standup and emails"]);
  assert.deepEqual(summary(r), ["?Website Revamp: new hero section", "max: api docs"]);
});

test("not an EOD", () => {
  assert.equal(parseEod("good morning everyone", projects, { today }).isEod, false);
  assert.equal(parseEod("anyone free for lunch?", projects, { today, inEodChannel: true }).isEod, false);
  assert.equal(parseEod("max is down again", projects, { today, inEodChannel: true }).isEod, false);
});

test("same project twice merges; numbers without units are not hours", () => {
  const r = parseEod(`EOD\nmax\n- fixed 3 bugs\natlas-chris\n- ui\nmax\n- 2 PRs reviewed (30 min)`, projects, { today });
  assert.deepEqual(summary(r), ["max: fixed 3 bugs | 2 PRs reviewed [0.5]", "atlas-chris: ui"]);
});

test("slack formatting", () => {
  assert.equal(cleanSlackText("<https://x.io|*link*> :rocket: <@U123> ~done~").replace(/\s+/g, " ").trim(), "link done");
  const r = parseEod("EOD\n*MAX*\n• <https://github.com/x/pull/1|PR #1> merged :tada:", projects, { today });
  assert.deepEqual(summary(r), ["max: PR #1 merged"]);
});

test("long headings and short project names", () => {
  const r = parseEod(
    "EODs (Oct 12–16, 40h)\nMonday, October 12, 2026\n PRI / KPI Revenue Center (Backend B04):\n• Planned and reviewed Backend B04\n• Added the weekly scheduler",
    [...projects, { id: 9, name: "PRI (mike's project)", identifier: "pri-mike-s-project" }],
    { today },
  );
  assert.deepEqual(summary(r), ["PRI (mike's project): Planned and reviewed Backend B04 | Added the weekly scheduler"]);
  assert.deepEqual(r.sections[0].items.map((i) => i.date), ["2026-10-12", "2026-10-12"]);
});

test("dates", () => {
  assert.equal(findDate("EOD 18 Oct", today), "2026-10-18");
  assert.equal(findDate("Oct 18, 2026", today), "2026-10-18");
  assert.equal(findDate("eod 18/10", today), "2026-10-18");
  assert.equal(findDate("eod 2026-10-17", today), "2026-10-17");
  assert.equal(findDate("eod 25 Dec", today), "2025-12-25");
  assert.equal(findDate("eod 31 Feb", today), null);
  assert.equal(findDate("no date here", today), null);
});

test("matchTask", () => {
  const tasks = [{ id: 7, subject: "Deployed backend" }, { id: 8, subject: "Radar leads issue fix" }];
  assert.equal(matchTask("deployed backend", tasks)?.id, 7);
  assert.equal(matchTask("Fix radar leads issue", tasks)?.id, 8);
  assert.equal(matchTask("backend", tasks), null);
});
