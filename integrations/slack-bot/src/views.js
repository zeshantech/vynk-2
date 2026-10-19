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

/** One card per project with its total and per-task breakdown. */
export function weekView({ label, week, entries, urls, otherWeekLabel, otherWeekValue }) {
  const total = sum(entries);
  const blocks = [header(`${label}  ·  ${formatHours(total)}`), context(prettyRange(week.from, week.to))];

  if (!entries.length) {
    blocks.push(divider, { type: "section", text: md("Nothing logged yet.") });
  } else {
    blocks.push(
      context(
        week.days
          .map((day, i) => {
            const h = sum(entries.filter((e) => e.spentOn === day));
            return h ? `*${DAY_NAMES[i]}* ${formatHours(h)}` : `${DAY_NAMES[i]} –`;
          })
          .join("     "),
      ),
    );
    const projects = [...groupBy(entries, (e) => e.projectTitle ?? "Other").entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
    for (const [project, list] of projects) {
      const tasks = [...groupBy(list, (e) => e.workPackageId ?? 0).values()].sort((a, b) => sum(b) - sum(a));
      blocks.push(
        divider,
        fields(`*${escape(project)}*`, `*${formatHours(sum(list))}*`),
        context(
          tasks
            .slice(0, 8)
            .map((t) => {
              const title = escape(t[0].workPackageTitle ?? "Other");
              const link = t[0].workPackageId ? `<${urls.wp(t[0].workPackageId)}|${title}>` : title;
              return `${link}  ${formatHours(sum(t))}`;
            })
            .join("     ·     "),
        ),
      );
    }
  }

  blocks.push(divider, {
    type: "actions",
    elements: [button("Log time", "open_log_time", "log", "primary"), button(otherWeekLabel, "show_week", otherWeekValue)],
  });
  return { text: `${label}: ${formatHours(total)}`, blocks };
}

export function loggedView({ hours, wp, projectName, activityName, spentOn, weekLabel, weekTotal, created, urls }) {
  const extra = created.length ? `${created.join("  ·  ")}  ·  ` : "";
  return {
    text: `Logged ${formatHours(hours)} on ${wp.subject}`,
    blocks: [
      { type: "section", text: md(`:white_check_mark:  *${formatHours(hours)} logged*`) },
      fields(
        `*Task*\n<${urls.wp(wp.id)}|${escape(wp.subject)}>`,
        `*Project*\n${escape(projectName ?? "–")}`,
        `*Date*\n${prettyDate(spentOn)}`,
        ...(activityName ? [`*Activity*\n${escape(activityName)}`] : []),
      ),
      context(`${extra}${weekLabel}: *${formatHours(weekTotal)}*`),
    ],
  };
}

export function projectsView({ projects, mine, team, urls, showTeam }) {
  const blocks = [header("Projects"), context(`${projects.length} project${projects.length === 1 ? "" : "s"}  ·  hours this week`)];
  if (!projects.length) blocks.push(divider, { type: "section", text: md("No projects yet.") });
  for (const p of projects) {
    const you = mine.get(p.id) ?? 0;
    const value = showTeam ? `*${hoursOrDash(team.get(p.id) ?? 0)}* team  ·  ${hoursOrDash(you)} you` : `*${hoursOrDash(you)}*`;
    blocks.push(divider, fields(`*<${urls.project(p)}|${escape(p.name)}>*`, value));
  }
  return { text: "Projects", blocks };
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

export function teamView({ label, week, rows }) {
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const blocks = [header(`Team  ·  ${label}  ·  ${formatHours(total)}`), context(prettyRange(week.from, week.to))];
  for (let i = 0; i < rows.length; i += 5) {
    blocks.push(divider, fields(...rows.slice(i, i + 5).flatMap((r) => [escape(r.name), r.hours ? `*${formatHours(r.hours)}*` : "–"])));
  }
  return { text: `Team hours: ${formatHours(total)}`, blocks };
}

export function menuView(options) {
  return {
    text: "What would you like to do?",
    blocks: [
      {
        type: "section",
        text: md("*Vynk*\nWhat would you like to do?"),
        accessory: {
          type: "static_select",
          action_id: "vynk_menu",
          placeholder: plain("Choose an action"),
          options: options.map(([value, label]) => ({ text: plain(label), value })),
        },
      },
    ],
  };
}

export function noticeView(text) {
  return { text, blocks: [{ type: "section", text: md(text) }] };
}
