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

const roleRank = (roles) => (roles.some((r) => /admin/i.test(r)) ? 0 : roles.some((r) => /member/i.test(r)) ? 1 : 2);
const shortRole = (roles) => roles.map((r) => r.replace(/^project\s+/i, "").replace(/^./, (c) => c.toUpperCase())).join(", ") || "No role";

function membersCell(list = []) {
  if (!list.length) return "–";
  const sorted = [...list].sort((a, b) => roleRank(a.roles) - roleRank(b.roles) || a.name.localeCompare(b.name));
  const lines = sorted.slice(0, 6).map((m) => `${m.name} (${shortRole(m.roles).toLowerCase()})`);
  if (sorted.length > 6) lines.push(`+${sorted.length - 6} more`);
  return lines.join("\n");
}

export function projectsView({ projects, mine, team, members = [], details = new Map(), urls, showTeam }) {
  const before = [header("Projects"), context(`${projects.length} project${projects.length === 1 ? "" : "s"}  ·  hours this week`)];
  if (!projects.length) return { text: "Projects", blocks: [...before, divider, { type: "section", text: md("No projects yet.") }] };
  const byProject = groupBy(members, (m) => m.projectId);
  const rows = [[bold("Project"), bold("Company"), bold("Client"), bold("Members"), bold("You"), ...(showTeam ? [bold("Team")] : [])]];
  for (const p of projects) {
    const d = details.get(p.id) ?? {};
    rows.push([
      link(p.name, urls.project(p)),
      d.company ?? "–",
      d.client ?? "–",
      membersCell(byProject.get(p.id)),
      hoursOrDash(mine.get(p.id) ?? 0),
      ...(showTeam ? [hoursOrDash(team.get(p.id) ?? 0)] : []),
    ]);
  }
  const listed = projects.slice(0, 100);
  const manage =
    listed.length <= 5
      ? { type: "actions", elements: listed.map((p) => button(`Edit · ${p.name}`.slice(0, 75), `pm_manage_${p.id}`, String(p.id))) }
      : {
          type: "actions",
          elements: [
            {
              type: "static_select",
              action_id: "pm_manage_select",
              placeholder: plain("Edit project…"),
              options: listed.map((p) => ({ text: plain(p.name.slice(0, 75)), value: String(p.id) })),
            },
          ],
        };
  return withTable("Projects", before, rows.slice(0, 100), [null, null, null, null, "right", "right"], [manage]);
}

function peopleSummary(result, role) {
  if (!result) return [];
  const line = (label, list) => (list.length ? [context(`${label}: ${list.map(escape).join(", ")}`)] : []);
  return [
    ...line(`Added as ${escape(role ?? "member")}`, result.added),
    ...line("Invited to Vynk and added", result.invited),
    ...line("Already members", result.already),
    ...line("Skipped", result.skipped),
    ...line(":warning: Couldn't add", result.failed),
  ];
}

export function projectCreatedView({ project, result, urls, inChannel = false, by = null, details = null }) {
  return {
    ...(inChannel ? { response_type: "in_channel" } : {}),
    text: `Project ${project.name} created`,
    blocks: [
      {
        type: "section",
        text: md(`:white_check_mark:  *Project <${urls.project(project)}|${escape(project.name)}> created*${by ? ` by <@${by}>` : ""}`),
      },
      ...(details?.company || details?.client
        ? [
            context(
              [details.company && `Company: *${escape(details.company)}*`, details.client && `Client: *${escape(details.client)}*`]
                .filter(Boolean)
                .join("  ·  "),
            ),
          ]
        : []),
      ...peopleSummary(result),
      {
        type: "actions",
        elements: [button("Edit project", `pm_manage_${project.id}`, String(project.id), "primary")],
      },
    ],
  };
}

export function membersAddedView({ projectName, role, result, notes = [] }) {
  const changed = result.added.length + result.invited.length;
  if (!changed && notes.length && !result.already.length && !result.skipped.length && !result.failed.length) {
    return {
      text: `${projectName} updated`,
      blocks: [
        { type: "section", text: md(`:white_check_mark:  *${escape(projectName)}* updated`) },
        context(notes.map(escape).join("  ·  ")),
      ],
    };
  }
  return {
    text: `${projectName}: ${changed} member${changed === 1 ? "" : "s"} added`,
    blocks: [
      {
        type: "section",
        text: md(`${changed ? ":white_check_mark:" : ":information_source:"}  *${escape(projectName)}*  ·  ${changed} added`),
      },
      ...(notes.length ? [context(notes.map(escape).join("  ·  "))] : []),
      ...peopleSummary(result, role),
    ],
  };
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
export function teamView({ label, week, users, entries, urls }) {
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

  const rows = [[bold("Person"), bold("Project"), bold("Task"), bold("Hours")]];
  let truncated = false;
  for (const person of people) {
    const projects = [...groupBy(person.list, (e) => e.projectTitle ?? "Other").entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
    if (!projects.length) {
      rows.push([person.name, "–", "–", "–"]);
      continue;
    }
    let first = true;
    for (const [project, list] of projects) {
      const tasks = [...groupBy(list, (e) => e.workPackageId ?? 0).values()].sort((a, b) => sum(b) - sum(a));
      tasks.forEach((t, index) => {
        rows.push([
          first ? bold(person.name) : "",
          index === 0 ? project : "",
          link(t[0].workPackageTitle ?? "Other", t[0].workPackageId ? urls?.wp(t[0].workPackageId) : null),
          formatHours(sum(t)),
        ]);
        first = false;
      });
    }
    rows.push(["", "", bold(`${person.name.split(" ")[0]} total`), bold(formatHours(sum(person.list)))]);
  }
  if (rows.length > 100) {
    rows.length = 99;
    truncated = true;
  }

  const suspicious = people.filter((p) => [...groupBy(p.list, (e) => e.spentOn).values()].some((day) => sum(day) > 24)).map((p) => p.name);
  const after = [
    ...(suspicious.length
      ? [context(`:warning:  Over 24h in a single day: ${suspicious.map(escape).join(", ")}. Please check those entries in Vynk.`)]
      : []),
    ...(truncated ? [context("Showing the first 98 rows. Open Vynk for the full report.")] : []),
  ];
  return withTable(`Team hours: ${formatHours(total)}`, before, rows, [null, null, null, "right"], after);
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

export function eodReviewView({ review, source, urls }) {
  const projects = new Set(review.items.map((i) => i.projectName));
  const rows = [[bold("Date"), bold("Project"), bold("Item"), bold("Task"), bold("Time")]];
  for (const item of review.items) {
    rows.push([
      item.date ? prettyDate(item.date) : "–",
      item.projectName,
      item.text,
      item.taskId ? link(item.taskSubject, urls.wp(item.taskId)) : "New task",
      item.hours ? `${item.suggested ? "≈ " : ""}${formatHours(item.hours)}` : "–",
    ]);
  }
  const notes = [];
  if (review.items.some((i) => i.suggested))
    notes.push("≈ = estimated from the total in your EOD, by how big each item looks. Adjust it when you review.");
  if (review.items.some((i) => !i.date)) notes.push("Some items have no date in your EOD; pick it when you review.");
  if (review.extra) notes.push(`+${review.extra} more item${review.extra === 1 ? "" : "s"} not shown (max 60 per EOD).`);
  if (review.noAccess.length) notes.push(`Skipped, you can't log time in: ${review.noAccess.map(escape).join(", ")}.`);
  if (review.unmatched.length)
    notes.push(
      `No Vynk project found for: ${review.unmatched
        .slice(0, 5)
        .map((t) => `"${escape(t).slice(0, 60)}"`)
        .join(", ")}${review.unmatched.length > 5 ? "…" : ""}`,
    );
  const before = [
    header(
      `Your EOD${review.date ? `  ·  ${review.dateTo && review.dateTo !== review.date ? prettyRange(review.date, review.dateTo) : prettyDate(review.date)}` : ""}`,
    ),
    context(
      `${review.items.length} item${review.items.length === 1 ? "" : "s"} in ${projects.size} project${projects.size === 1 ? "" : "s"}  ·  from your ${source}`,
    ),
  ];
  const after = [
    ...notes.map((n) => context(n)),
    {
      type: "actions",
      elements: [button("Review & log time", "eod_review", review.id, "primary"), button("Dismiss", "eod_dismiss", review.id)],
    },
  ];
  return withTable(
    `Your EOD for ${prettyDate(review.date)}: ${review.items.length} items to log`,
    before,
    rows,
    [null, null, null, "right"],
    after,
  );
}

export function eodNothingView({ source, noAccess, unmatched, date }) {
  const lines = [];
  if (noAccess.length)
    lines.push(`You can't log time in: *${noAccess.map(escape).join(", ")}*. Ask a project admin for a role that allows logging time.`);
  if (unmatched.length)
    lines.push(
      `No Vynk project matched: ${unmatched
        .slice(0, 5)
        .map((t) => `"${escape(t).slice(0, 60)}"`)
        .join(", ")}`,
    );
  lines.push("Tip: start each project's items with its name on its own line, e.g. `MAX:`");
  return {
    text: "I couldn't match your EOD to your projects",
    blocks: [
      { type: "section", text: md(`*I couldn't match your ${source} for ${prettyDate(date)} to any of your projects.*`) },
      ...lines.map((l) => context(l)),
      { type: "actions", elements: [button("Log time manually", "open_log_time", "log", "primary")] },
    ],
  };
}

export function eodConnectView({ url, source }) {
  return {
    text: "Connect Vynk to log your EOD",
    blocks: [
      { type: "section", text: md(`*I saw your ${source}.*\nConnect your Vynk account once and I'll turn it into time entries for you.`) },
      { type: "actions", elements: [{ ...button("Connect Vynk", "connect_vynk", "connect", "primary"), url }] },
      context("Use the same email as your Slack account. The link works for 15 minutes; your EOD waits for you."),
    ],
  };
}

export function eodDoneView({ entries, source }) {
  const total = entries.reduce((s, e) => s + e.hours, 0);
  return {
    text: `EOD logged: ${formatHours(total)}`,
    blocks: [
      { type: "section", text: md(`:white_check_mark:  *EOD logged  ·  ${formatHours(total)}*`) },
      context(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} from your ${source}`),
    ],
  };
}

export function eodDismissedView() {
  return { blocks: [context("EOD dismissed. Nothing was logged.")] };
}

export function noticeView(text) {
  return { text, blocks: [{ type: "section", text: md(text) }] };
}
