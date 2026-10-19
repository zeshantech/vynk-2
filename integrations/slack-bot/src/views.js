// Block Kit layouts for every bot reply (pure: data in, blocks out).

import { formatHours } from "./time.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const escape = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const plain = (text) => ({ type: "plain_text", text, emoji: true });
const md = (text) => ({ type: "mrkdwn", text });
const header = (text) => ({ type: "header", text: plain(text.slice(0, 150)) });
const context = (text) => ({ type: "context", elements: [md(text)] });
const divider = { type: "divider" };
const fields = (...items) => ({ type: "section", fields: items.map(md) });
const button = (text, actionId, value, style) => ({
  type: "button",
  text: plain(text),
  action_id: actionId,
  ...(value ? { value } : {}),
  ...(style ? { style } : {}),
});

export function prettyDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function prettyRange(from, to) {
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const end = a.getUTCMonth() === b.getUTCMonth() ? String(b.getUTCDate()) : b.toLocaleDateString("en-US", opts);
  return `${a.toLocaleDateString("en-US", opts)} – ${end}`;
}

// Slack "table" block (one per message). Each view also carries a monospace fallback
// in case a client/workspace rejects table blocks.
const cell = (rawText, { bold = false, url } = {}) => {
  const text = String(rawText ?? "") || " ";
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          url
            ? { type: "link", url, text: String(text), ...(bold ? { style: { bold: true } } : {}) }
            : { type: "text", text: String(text), ...(bold ? { style: { bold: true } } : {}) },
        ],
      },
    ],
  };
};

function table(rows, align = []) {
  return {
    type: "table",
    column_settings: align.map((a) => ({ align: a ?? "left" })),
    rows: rows.map((row) => row.map((c) => (typeof c === "object" ? cell(c.text, c) : cell(c)))),
  };
}

function monospace(rows, align = []) {
  const plainRows = rows.map((row) => row.map((c) => String(typeof c === "object" ? c.text : c)));
  const widths = plainRows[0].map((_, i) => Math.min(28, Math.max(...plainRows.map((r) => r[i].length))));
  const line = (r) =>
    r
      .map((v, i) =>
        v.length > widths[i] ? `${v.slice(0, widths[i] - 1)}…` : align[i] === "right" ? v.padStart(widths[i]) : v.padEnd(widths[i]),
      )
      .join("  ");
  const out = [line(plainRows[0]), widths.map((w) => "─".repeat(w)).join("  "), ...plainRows.slice(1).map(line)];
  return { type: "section", text: md("```" + out.join("\n") + "```") };
}

/** Message with a table, plus `fallback` (same message with a monospace table). */
function withTable(text, before, rows, align, after = []) {
  return {
    text,
    blocks: [...before, table(rows, align), ...after],
    fallback: { text, blocks: [...before, monospace(rows, align), ...after] },
  };
}

const clock = (h) => {
  if (!h) return "–";
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const bold = (text, url) => ({ text, bold: true, ...(url ? { url } : {}) });
const link = (text, url) => ({ text, ...(url ? { url } : {}) });

const sum = (list) => list.reduce((s, e) => s + e.hours, 0);
const hoursOrDash = (h) => (h ? formatHours(h) : "–");

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** Timesheet grid: one row per task (grouped by project), one column per day. */
export function weekView({ label, week, entries, urls, otherWeekLabel, otherWeekValue }) {
  const total = sum(entries);
  const before = [header(`${label}  ·  ${formatHours(total)}`), context(`${prettyRange(week.from, week.to)}  ·  hours as h:mm`)];
  const after = [
    {
      type: "actions",
      elements: [button("Log time", "open_log_time", "log", "primary"), button(otherWeekLabel, "show_week", otherWeekValue)],
    },
  ];
  if (!entries.length)
    return {
      text: `${label}: nothing logged`,
      blocks: [...before, divider, { type: "section", text: md("Nothing logged yet.") }, ...after],
    };

  const dayCells = (list, asBold) =>
    week.days.map((d) => {
      const h = sum(list.filter((e) => e.spentOn === d));
      return asBold && h ? bold(clock(h)) : clock(h);
    });
  const rows = [["Project", "Task", ...DAY_NAMES, "Total"].map((t) => bold(t))];
  const projects = [...groupBy(entries, (e) => e.projectTitle ?? "Other").entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  for (const [project, list] of projects) {
    const tasks = [...groupBy(list, (e) => e.workPackageId ?? 0).values()].sort((a, b) => sum(b) - sum(a));
    tasks.forEach((t, index) => {
      rows.push([
        index === 0 ? bold(project) : "",
        link(t[0].workPackageTitle ?? "Other", t[0].workPackageId ? urls.wp(t[0].workPackageId) : null),
        ...dayCells(t),
        clock(sum(t)),
      ]);
    });
    if (tasks.length > 1) rows.push(["", bold(`${project} total`), ...dayCells(list, true), bold(clock(sum(list)))]);
  }
  rows.push([bold("Total"), "", ...dayCells(entries, true), bold(clock(total))]);
  return withTable(
    `${label}: ${formatHours(total)}`,
    before,
    rows.slice(0, 100),
    [null, null, ...DAY_NAMES.map(() => "right"), "right"],
    after,
  );
}

export function loggedView({ results, weekLabel, weekTotal, urls }) {
  const total = sum(results);
  const footer = context(`${weekLabel}: *${formatHours(weekTotal)}*`);
  if (results.length === 1) {
    const [r] = results;
    return {
      text: `Logged ${formatHours(r.hours)} on ${r.wp.subject}`,
      blocks: [
        { type: "section", text: md(`:white_check_mark:  *${formatHours(r.hours)} logged*`) },
        fields(
          `*Task*\n<${urls.wp(r.wp.id)}|${escape(r.wp.subject)}>`,
          `*Project*\n${escape(r.wp._links?.project?.title ?? "–")}`,
          `*Date*\n${prettyDate(r.spentOn)}`,
          ...(r.activityName ? [`*Activity*\n${escape(r.activityName)}`] : []),
        ),
        context([...(r.created.length ? [r.created.join(" + ")] : []), `${weekLabel}: *${formatHours(weekTotal)}*`].join("  ·  ")),
      ],
    };
  }
  const rows = [[bold("Task"), bold("Project"), bold("Activity"), bold("Date"), bold("Hours")]];
  for (const r of results) {
    rows.push([
      link(r.wp.subject + (r.created.length ? "  (new)" : ""), urls.wp(r.wp.id)),
      r.wp._links?.project?.title ?? "–",
      r.activityName ?? "–",
      prettyDate(r.spentOn),
      formatHours(r.hours),
    ]);
  }
  rows.push([bold("Total"), "", "", "", bold(formatHours(total))]);
  return withTable(
    `Logged ${results.length} entries (${formatHours(total)})`,
    [{ type: "section", text: md(`:white_check_mark:  *${results.length} entries logged  ·  ${formatHours(total)}*`) }],
    rows,
    [null, null, null, null, "right"],
    [footer],
  );
}

export function projectsView({ projects, mine, team, urls, showTeam }) {
  const before = [header("Projects"), context(`${projects.length} project${projects.length === 1 ? "" : "s"}  ·  hours this week`)];
  if (!projects.length) return { text: "Projects", blocks: [...before, divider, { type: "section", text: md("No projects yet.") }] };
  const rows = [[bold("Project"), bold("You"), ...(showTeam ? [bold("Team")] : [])]];
  for (const p of projects) {
    rows.push([link(p.name, urls.project(p)), hoursOrDash(mine.get(p.id) ?? 0), ...(showTeam ? [hoursOrDash(team.get(p.id) ?? 0)] : [])]);
  }
  return withTable("Projects", before, rows.slice(0, 100), [null, "right", "right"]);
}

export function tasksView({ tasks, urls }) {
  const blocks = [header("Your open tasks"), context(`${tasks.length} open`)];
  if (!tasks.length) {
    blocks.push(divider, { type: "section", text: md("You're all caught up. :sparkles:") });
    return { text: "No open tasks", blocks };
  }
  for (const [project, list] of groupBy(tasks, (wp) => wp._links?.project?.title ?? "Other")) {
    blocks.push(divider, { type: "section", text: md(`*${escape(project)}*`) });
    blocks.push({
      type: "section",
      text: md(
        list
          .slice(0, 8)
          .map((wp) => {
            const meta = [wp._links?.status?.title, wp.dueDate ? `due ${prettyDate(wp.dueDate)}` : null].filter(Boolean).join("  ·  ");
            return `<${urls.wp(wp.id)}|${escape(wp.subject)}>${meta ? `   _${escape(meta)}_` : ""}`;
          })
          .join("\n"),
      ),
    });
    if (list.length > 8) blocks.push(context(`+${list.length - 8} more in ${escape(project)}`));
  }
  return { text: "Your open tasks", blocks };
}

/** Hours per person, broken down by project. */
export function teamView({ label, week, users, entries }) {
  const total = sum(entries);
  const before = [header(`Team  ·  ${label}  ·  ${formatHours(total)}`), context(prettyRange(week.from, week.to))];
  const byUser = groupBy(entries, (e) => e.userId);
  const people = users
    .map((u) => ({ name: u.name, list: byUser.get(u.id) ?? [] }))
    .concat(
      [...byUser.entries()]
        .filter(([id]) => !users.some((u) => u.id === id))
        .map(([, list]) => ({ name: list[0].userName ?? "Unknown", list })),
    )
    .sort((a, b) => sum(b.list) - sum(a.list));

  const rows = [[bold("Person"), bold("Project"), bold("Hours")]];
  for (const person of people) {
    const projects = [...groupBy(person.list, (e) => e.projectTitle ?? "Other").entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
    if (!projects.length) {
      rows.push([person.name, "–", "–"]);
      continue;
    }
    projects.forEach(([project, list], index) => rows.push([index === 0 ? bold(person.name) : "", project, formatHours(sum(list))]));
    if (projects.length > 1) rows.push(["", bold("Total"), bold(formatHours(sum(person.list)))]);
  }

  const suspicious = people.filter((p) => [...groupBy(p.list, (e) => e.spentOn).values()].some((day) => sum(day) > 24)).map((p) => p.name);
  const after = suspicious.length
    ? [context(`:warning:  Over 24h in a single day: ${suspicious.map(escape).join(", ")}. Please check those entries in Vynk.`)]
    : [];
  return withTable(`Team hours: ${formatHours(total)}`, before, rows.slice(0, 100), [null, null, "right"], after);
}

export function menuView(options, adminOptions = [], signedInAs = null) {
  const buttons = (list, primaryFirst) =>
    list.map(([value, label], i) => button(label, `menu_${value}`, value, primaryFirst && i === 0 ? "primary" : undefined));
  return {
    text: "What would you like to do?",
    blocks: [
      { type: "section", text: md("*Vynk*\nWhat would you like to do?") },
      { type: "actions", block_id: "menu", elements: buttons(options, true) },
      ...(adminOptions.length
        ? [context("Admin"), { type: "actions", block_id: "menu_admin", elements: buttons(adminOptions, false) }]
        : []),
      ...(signedInAs ? [context(`Signed in as *${escape(signedInAs)}*  ·  \`/vynk disconnect\` to sign out`)] : []),
    ],
  };
}

export function connectView(url) {
  return {
    text: "Connect your Vynk account",
    blocks: [
      {
        type: "section",
        text: md("*Connect your Vynk account*\nSign in once so everything you do here is saved as you, with your own access."),
      },
      { type: "actions", elements: [{ ...button("Connect Vynk", "connect_vynk", "connect", "primary"), url }] },
      context("The link works for 15 minutes. Use the same email as your Slack account."),
    ],
  };
}

export function noticeView(text) {
  return { text, blocks: [{ type: "section", text: md(text) }] };
}
