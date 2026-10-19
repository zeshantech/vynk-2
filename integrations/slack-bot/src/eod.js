// Parses an end-of-day report written in Slack into projects and work items (pure, no I/O).

import { parseHours } from "./time.js";

const EOD_WORDS =
  /\b(eods?|e\.o\.d|end[\s-]of[\s-](the[\s-])?day|daily\s+(update|report|status)|day\s+report|today'?s?\s+(work|update|progress|report))\b/i;
// Sections that describe future work or problems, not work done today.
const SKIP_SECTION =
  /^(tomorrow|tmrw|next\s*(day|steps?)?|plans?(\s+for\s+tomorrow)?|planned|planning|upcoming|to\s*-?\s*do|todo|pending|blockers?|blocked|issues?|challenges?|impediments?|questions?|notes?|concerns?|risks?)\b/i;
const DONE_SECTION = /^(done|completed|today|work\s+done|tasks?(\s+done)?|accomplishments?|progress|updates?)\b/i;
const BULLET = /^\s*(?:[-–—•*+▪◦●○➤➢►→✓✔☑✅]|\d{1,2}[.)]|[a-z][.)])\s+/i;
const HOURS_TOKEN = String.raw`(?:\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?)(?:\s*\d{1,2}\s*(?:m|min|mins))?|\d{1,4}\s*(?:m|min|mins|minutes)|\d{1,2}:[0-5]\d)`;
const HOURS_END = new RegExp(String.raw`\s*[([{]?\s*(?:[-–—:|~]\s*)?(${HOURS_TOKEN})\s*[)\]}]?\s*\.?$`, "i");
const HOURS_START = new RegExp(String.raw`^[([{]?\s*(${HOURS_TOKEN})\s*[)\]}]?\s*(?:[-–—:|]\s*)?(?=\S)`, "i");
const MAX_ITEM_LENGTH = 200;

/** Slack mrkdwn -> plain text. */
export function cleanSlackText(text) {
  return String(text ?? "")
    .replace(/<(?:https?|mailto):[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<(?:https?|mailto):([^>]+)>/g, "$1")
    .replace(/<[@#!][^>|]*\|([^>]+)>/g, "$1")
    .replace(/<[@#!][^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/```/g, "")
    .replace(/(^|\s)[*_~`]+|[*_~`]+(?=\s|$|[:.,!?)])/g, "$1")
    .replace(/[ \t]+/g, " ");
}

export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function projectMatcher(projects) {
  const keys = [];
  for (const p of projects) {
    // "PRI (mike's project)" is usually written as just "PRI".
    const base = normalize(p.name.replace(/\([^)]*\)/g, " "));
    for (const key of new Set([normalize(p.name), normalize(p.identifier), base])) if (key) keys.push({ key, project: p });
  }
  keys.sort((a, b) => b.key.length - a.key.length);
  return {
    exact(text) {
      const n = normalize(text);
      return keys.find((k) => k.key === n)?.project ?? null;
    },
    /** A project named inside a short heading, e.g. "Project MAX (backend)". */
    within(text) {
      const n = ` ${normalize(text)} `;
      return keys.find((k) => k.key.length >= 3 && n.includes(` ${k.key} `))?.project ?? null;
    },
  };
}

function splitHours(text) {
  let hours = null;
  let rest = text;
  const end = rest.match(HOURS_END);
  if (end) {
    hours = parseHours(end[1].replace(/\s+/g, ""));
    if (hours !== null) rest = rest.slice(0, end.index);
  }
  if (hours === null) {
    const start = rest.match(HOURS_START);
    if (start) {
      hours = parseHours(start[1].replace(/\s+/g, ""));
      if (hours !== null) rest = rest.slice(start[0].length);
    }
  }
  return { text: rest.replace(/[\s:;,.–—-]+$/, "").trim(), hours: hours && hours <= 24 ? hours : null };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Finds a report date like "19 Oct", "Oct 19, 2026", "19/10", "2026-10-19" (returns YYYY-MM-DD or null). */
export function findDate(text, today) {
  const year = Number(today.slice(0, 4));
  const pad = (n) => String(n).padStart(2, "0");
  const build = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let iso = `${y || year}-${pad(m)}-${pad(d)}`;
    if (!y && iso > today) iso = `${year - 1}-${pad(m)}-${pad(d)}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.getUTCDate() !== d ? null : iso;
  };
  let m = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  const monthRe = MONTHS.join("|");
  m = text.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${monthRe})[a-z]*\.?,?\s*(20\d{2})?\b`, "i"));
  if (m) return build(m[3] ? Number(m[3]) : 0, MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1, Number(m[1]));
  m = text.match(new RegExp(String.raw`\b(${monthRe})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})?\b`, "i"));
  if (m) return build(m[3] ? Number(m[3]) : 0, MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, Number(m[2]));
  m = text.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](20\d{2}|\d{2}))?\b/);
  if (m) {
    const y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : 0;
    return build(y, Number(m[2]), Number(m[1]));
  }
  return null;
}

/**
 * Parses a report.
 * @param text Slack message text
 * @param projects [{ id, name, identifier }] all projects that may be mentioned
 * @returns { isEod, date, sections: [{ project, heading, items: [{ text, hours }] }], unassigned: [{ text, hours }] }
 */
export function parseEod(text, projects, { today, inEodChannel = true } = {}) {
  const match = projectMatcher(projects);
  const raw = cleanSlackText(text);
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const sections = [];
  const unassigned = [];
  let current = null;
  let skipping = false;
  let currentDate = null;
  const sectionFor = (project, heading) => {
    let s = sections.find((x) => x.project && project && x.project.id === project.id);
    if (!s) {
      s = { project, heading, items: [] };
      sections.push(s);
    }
    return s;
  };
  const addItem = (itemText) => {
    const item = splitHours(itemText.replace(BULLET, "").trim());
    if (!item.text || item.text.length < 2 || !/[a-z]/i.test(item.text)) return;
    item.text = item.text.slice(0, MAX_ITEM_LENGTH);
    item.date = currentDate;
    if (current) current.items.push(item);
    else unassigned.push(item);
  };

  for (const line of lines) {
    if (!line) continue;
    const isBullet = BULLET.test(line);
    const body = line.replace(BULLET, "").trim();
    const label = body.replace(/^project\s*(name)?\s*[:\-–—]?\s*/i, "");
    const [, beforeColon, afterColon] = label.match(/^([^:]{1,60}?)\s*(?::|\s[-–—|]\s)\s*(.*)$/) ?? [];

    // "Monday, October 12, 2026" starts a new day.
    const dayDate = !isBullet && body.split(/\s+/).length <= 6 && !/:\s*\S/.test(body) ? findDate(body, today) : null;
    if (dayDate) {
      currentDate = dayDate;
      skipping = false;
      continue;
    }
    if (!isBullet && SKIP_SECTION.test(body) && (/:\s*$/.test(body) || body.split(/\s+/).length <= 3)) {
      skipping = true;
      continue;
    }
    if (DONE_SECTION.test(body) && /:?$/.test(body) && body.split(/\s+/).length <= 4 && !afterColon) {
      skipping = false;
      continue;
    }

    // "MAX" / "MAX:" / "Project: MAX" / "Project MAX (backend)" on its own line
    const headingText = label.replace(/[:\-–—]+$/, "");
    const headingLike = !isBullet && !afterColon && (headingText.split(/\s+/).length <= 6 || /:\s*$/.test(label));
    const wholeHeading =
      match.exact(headingText) ?? (headingLike ? (match.within(headingText.split(/[/|(]/)[0]) ?? match.within(headingText)) : null);
    if (wholeHeading) {
      current = sectionFor(wholeHeading, label);
      skipping = false;
      continue;
    }
    // "MAX: did something" / "MAX - did something"
    const inline = beforeColon ? match.exact(beforeColon) : null;
    if (inline && afterColon) {
      current = sectionFor(inline, beforeColon);
      skipping = false;
      addItem(afterColon);
      continue;
    }
    if (skipping) continue;
    // Report title lines ("EOD Report - 19 Oct") are not work items.
    if (EOD_WORDS.test(body) && body.split(/\s+/).length <= 8) continue;
    // Unknown heading-like line ("Website:" for a project that doesn't exist): start an unmatched section.
    if (!isBullet && /:$/.test(body) && body.split(/\s+/).length <= 5) {
      current = { project: null, heading: body.replace(/:$/, ""), items: [] };
      sections.push(current);
      continue;
    }
    addItem(body);
  }

  const withItems = sections.filter((s) => s.items.length);
  const itemCount = withItems.reduce((n, s) => n + s.items.length, 0) + unassigned.length;
  const mentionsEod = EOD_WORDS.test(raw);
  const isEod = itemCount > 0 && (mentionsEod || (inEodChannel && withItems.some((s) => s.project)));
  return { isEod, date: findDate(raw, today), sections: withItems, unassigned };
}

/** Best open task in a project for an EOD item, or null (exact or near-identical title). */
export function matchTask(itemText, tasks) {
  const n = normalize(itemText);
  if (!n) return null;
  const exact = tasks.find((t) => normalize(t.subject) === n);
  if (exact) return exact;
  const words = new Set(n.split(" ").filter((w) => w.length > 2));
  if (words.size < 2) return null;
  let best = null;
  for (const t of tasks) {
    const tw = new Set(
      normalize(t.subject)
        .split(" ")
        .filter((w) => w.length > 2),
    );
    if (tw.size < 2) continue;
    const common = [...words].filter((w) => tw.has(w)).length;
    const score = common / Math.max(words.size, tw.size);
    if (score >= 0.8 && (!best || score > best.score)) best = { task: t, score };
  }
  return best?.task ?? null;
}
