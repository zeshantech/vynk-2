import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCreateTask, parseLogTime } from "../src/commands.js";
import { currentWeek, formatHours, fromIsoDuration, parseHours, resolveDate, toIsoDuration } from "../src/time.js";

test("parseHours", () => {
  assert.equal(parseHours("2h"), 2);
  assert.equal(parseHours("1.5"), 1.5);
  assert.equal(parseHours("1h30m"), 1.5);
  assert.equal(parseHours("90m"), 1.5);
  assert.equal(parseHours("abc"), null);
  assert.equal(parseHours("0"), null);
  assert.equal(parseHours(""), null);
});

test("iso durations", () => {
  assert.equal(toIsoDuration(2.5), "PT2H30M");
  assert.equal(toIsoDuration(0.25), "PT15M");
  assert.equal(fromIsoDuration("PT2H30M"), 2.5);
  assert.equal(fromIsoDuration("P1DT1H"), 25);
  assert.equal(formatHours(1.5), "1h 30m");
});

test("parseLogTime", () => {
  assert.deepEqual(parseLogTime("2h #123 fixed login bug yesterday"), { hours: 2, workPackageId: 123, date: "yesterday", comment: "fixed login bug" });
  assert.deepEqual(parseLogTime("#45 1h30m review"), { hours: 1.5, workPackageId: 45, date: null, comment: "review" });
  assert.deepEqual(parseLogTime("2 123"), { hours: 2, workPackageId: 123, date: null, comment: "" });
  assert.deepEqual(parseLogTime("123 2h"), { hours: 2, workPackageId: 123, date: null, comment: "" });
  assert.deepEqual(parseLogTime("2h fixed 3 bugs"), { hours: 2, workPackageId: null, date: null, comment: "fixed 3 bugs" });
  assert.deepEqual(parseLogTime("3h #9 2026-10-15"), { hours: 3, workPackageId: 9, date: "2026-10-15", comment: "" });
  assert.deepEqual(parseLogTime(""), { hours: null, workPackageId: null, date: null, comment: "" });
});

test("parseCreateTask", () => {
  assert.deepEqual(parseCreateTask("website | Fix header"), { project: "website", subject: "Fix header" });
  assert.deepEqual(parseCreateTask("Fix header"), { project: null, subject: "Fix header" });
});

test("dates", () => {
  const w = currentWeek("UTC");
  assert.equal(new Date(`${w.from}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(w.days.length, 7);
  assert.equal(resolveDate("2026-01-02", "UTC"), "2026-01-02");
  assert.equal(resolveDate("nope", "UTC"), null);
});
