import bolt from "@slack/bolt";
import { OpenProject, OpenProjectError } from "./openproject.js";
import { parseCreateTask, parseLogTime } from "./commands.js";
import { currentWeek, formatHours, parseHours, resolveDate, todayIn, weekContaining } from "./time.js";

const { App, LogLevel } = bolt;

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing env ${name}`);
  return value;
};

const TZ = process.env.BOT_TIMEZONE || "Asia/Karachi";
const BASE_URL = env("OPENPROJECT_URL").replace(/\/$/, "");
const op = new OpenProject({ baseUrl: BASE_URL, apiKey: env("OPENPROJECT_API_KEY") });

const app = new App({
  token: env("SLACK_BOT_TOKEN"),
  appToken: env("SLACK_APP_TOKEN"),
  socketMode: true,
  logLevel: process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
});

class UserFacingError extends Error {}

const wpUrl = (id) => `${BASE_URL}/work_packages/${id}`;
const projectUrl = (p) => `${BASE_URL}/projects/${p.identifier}`;
const escape = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slackEmailCache = new Map();
async function slackEmail(client, slackUserId) {
  if (slackEmailCache.has(slackUserId)) return slackEmailCache.get(slackUserId);
  const { user } = await client.users.info({ user: slackUserId });
  const email = user?.profile?.email ?? null;
  slackEmailCache.set(slackUserId, email);
  return email;
}

async function vynkUser(client, slackUserId) {
  const email = await slackEmail(client, slackUserId);
  if (!email) throw new UserFacingError("I can't see your Slack email. Ask an admin to grant the bot `users:read.email`.");
  const user = await op.userByEmail(email);
  if (!user) throw new UserFacingError(`No Vynk account uses *${escape(email)}*. Ask an admin to invite you at ${BASE_URL}`);
  if (user.status && user.status !== "active") throw new UserFacingError("Your Vynk account is not active.");
  return user;
}

async function requireAdmin(client, slackUserId) {
  const user = await vynkUser(client, slackUserId);
  if (!user.admin) throw new UserFacingError("Only Vynk admins can do that.");
  return user;
}

function errorText(err) {
  if (err instanceof UserFacingError) return `:warning: ${err.message}`;
  if (err instanceof OpenProjectError) return `:x: Vynk said: ${escape(err.message)}`;
  return ":x: Something went wrong. Please try again.";
}

/** Acks immediately (Slack's 3s limit) and replies ephemerally with the handler's result or error. */
function command(name, handler) {
  app.command(name, async ({ ack, command: cmd, client, respond, logger }) => {
    await ack();
    try {
      const reply = await handler({ cmd, client, text: cmd.text?.trim() ?? "" });
      if (reply) await respond(typeof reply === "string" ? { response_type: "ephemeral", text: reply } : { response_type: "ephemeral", ...reply });
    } catch (err) {
      if (!(err instanceof UserFacingError)) logger.error(`${name} failed`, err);
      await respond({ response_type: "ephemeral", text: errorText(err) });
    }
  });
}

// ---------- help ----------

const HELP = [
  "*Vynk commands*",
  "`/log-time 2h #123 fixed login bug` — log time on a task (add `yesterday` or `2026-10-15`; no text opens a form)",
  "`/week-hours` — your hours this week (`/week-hours last` for last week)",
  "`/time-week-logged-times` — same as `/week-hours`",
  "`/my-tasks` — your open tasks",
  "`/create-task website | Fix header` — create a task assigned to you (no text opens a form)",
  "`/projects` — list projects",
  "`/create-project Website Redesign` — create a project _(admin)_",
  "`/team-hours` — everyone's hours this week _(admin, `last` for last week)_",
].join("\n");


// ---------- projects ----------

async function projectsReply({ cmd, client }) {
  await vynkUser(client, cmd.user_id);
  const projects = await op.projects();
  if (!projects.length) return "No projects yet.";
  return `*Projects (${projects.length})*\n${projects.map((p) => `• <${projectUrl(p)}|${escape(p.name)}>  \`${p.identifier}\``).join("\n")}`;
}

command("/projects", projectsReply);

async function createProjectFor(admin, name) {
  const project = await op.createProject(name);
  await op.addMember({ projectId: project.id, userId: admin.id }).catch(() => null);
  return project;
}

command("/create-project", async ({ cmd, client, text }) => {
  const admin = await requireAdmin(client, cmd.user_id);
  if (!text) return "Usage: `/create-project Project name`";
  const project = await createProjectFor(admin, text);
  return { response_type: "in_channel", text: `:white_check_mark: Project <${projectUrl(project)}|${escape(project.name)}> created by <@${cmd.user_id}>.` };
});

app.view("create_project", async ({ ack, body, view, client, logger }) => {
  const name = view.state.values.name.value.value?.trim();
  if (!name) {
    await ack({ response_action: "errors", errors: { name: "Name is required" } });
    return;
  }
  await ack();
  const dm = (text) => client.chat.postMessage({ channel: body.user.id, text });
  try {
    const admin = await requireAdmin(client, body.user.id);
    const project = await createProjectFor(admin, name);
    await dm(`:white_check_mark: Project <${projectUrl(project)}|${escape(project.name)}> created.`);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("create_project submit failed", err);
    await dm(errorText(err));
  }
});

// ---------- tasks ----------

async function myTasksReply({ cmd, client }) {
  const user = await vynkUser(client, cmd.user_id);
  const tasks = await op.openTasksFor(user.id);
  if (!tasks.length) return "You have no open tasks. :tada:";
  const lines = tasks.map((wp) => {
    const project = wp._links?.project?.title ?? "";
    const status = wp._links?.status?.title ?? "";
    const due = wp.dueDate ? ` · due ${wp.dueDate}` : "";
    return `• <${wpUrl(wp.id)}|#${wp.id} ${escape(wp.subject)}> — ${escape(project)} · _${escape(status)}_${due}`;
  });
  return `*Your open tasks*\n${lines.join("\n")}`;
}

command("/my-tasks", myTasksReply);

const unassignedNote = (wp) => (wp.assigneeSkipped ? " _(left unassigned: that person isn't a member of the project)_" : "");

async function projectOptions() {
  const projects = await op.projects();
  return projects.slice(0, 100).map((p) => ({ text: { type: "plain_text", text: p.name.slice(0, 75) }, value: String(p.id) }));
}

const input = (blockId, label, element, optional = false) => ({
  type: "input",
  block_id: blockId,
  optional,
  label: { type: "plain_text", text: label },
  element: { action_id: "value", ...element },
});

async function openCreateTaskModal(client, triggerId, slackUserId, subject) {
  const options = await projectOptions();
  if (!options.length) throw new UserFacingError("There are no projects yet.");
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "create_task",
      title: { type: "plain_text", text: "New task" },
      submit: { type: "plain_text", text: "Create" },
      blocks: [
        input("project", "Project", { type: "static_select", options }),
        input("subject", "Title", { type: "plain_text_input", ...(subject ? { initial_value: subject } : {}) }),
        input("description", "Description", { type: "plain_text_input", multiline: true }, true),
        input("assignee", "Assignee", { type: "users_select", initial_user: slackUserId }, true),
      ],
    },
  });
}

app.command("/create-task", async ({ ack, command: cmd, client, respond, logger }) => {
  await ack();
  try {
    const user = await vynkUser(client, cmd.user_id);
    const { project: projectName, subject } = parseCreateTask(cmd.text);
    if (projectName && subject) {
      const project = await op.findProject(projectName);
      if (!project) throw new UserFacingError(`No project matches *${escape(projectName)}*. Try \`/projects\`.`);
      const wp = await op.createTask({ projectId: project.id, subject, assigneeId: user.id });
      await respond({ response_type: "ephemeral", text: `:white_check_mark: Created <${wpUrl(wp.id)}|#${wp.id} ${escape(wp.subject)}> in ${escape(project.name)}.${unassignedNote(wp)}` });
      return;
    }
    await openCreateTaskModal(client, cmd.trigger_id, cmd.user_id, subject);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("/create-task failed", err);
    await respond({ response_type: "ephemeral", text: errorText(err) });
  }
});

app.view("create_task", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const subject = values.subject.value.value?.trim();
  if (!subject) {
    await ack({ response_action: "errors", errors: { subject: "Title is required" } });
    return;
  }
  await ack();
  const dm = (text) => client.chat.postMessage({ channel: body.user.id, text });
  try {
    await vynkUser(client, body.user.id);
    const assigneeSlack = values.assignee.value.selected_user;
    const assignee = assigneeSlack ? await vynkUser(client, assigneeSlack).catch(() => null) : null;
    const projectId = Number(values.project.value.selected_option.value);
    const wp = await op.createTask({ projectId, subject, assigneeId: assignee?.id, description: values.description.value.value });
    const who = assignee ? ` for <@${assigneeSlack}>` : "";
    await dm(`:white_check_mark: Created <${wpUrl(wp.id)}|#${wp.id} ${escape(wp.subject)}>${wp.assigneeSkipped ? "" : who}.${unassignedNote(wp)}`);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("create_task submit failed", err);
    await dm(errorText(err));
  }
});

// ---------- time ----------

async function logTimeFor(user, { hours, workPackageId, spentOn, comment }) {
  const wp = await op.workPackage(workPackageId).catch((err) => {
    if (err.status === 404) throw new UserFacingError(`Task #${workPackageId} not found.`);
    throw err;
  });
  await op.logTime({ userId: user.id, workPackageId, hours, spentOn, comment }).catch((err) => {
    if (err.status === 403) throw new UserFacingError(`You can't log time on #${workPackageId}: you're not a member of its project (or time tracking is off there).`);
    throw err;
  });
  const week = weekContaining(spentOn);
  const entries = await op.timeEntries({ from: week.from, to: week.to, userId: user.id });
  const total = entries.reduce((sum, e) => sum + e.hours, 0);
  const weekLabel = week.from === currentWeek(TZ).from ? "This week" : `Week of ${week.from}`;
  return `:stopwatch: Logged *${formatHours(hours)}* on <${wpUrl(wp.id)}|#${wp.id} ${escape(wp.subject)}> for ${spentOn}. ${weekLabel}: *${formatHours(total)}*.`;
}

async function openLogTimeModal(client, triggerId, user, prefill = {}) {
  const tasks = await op.openTasksFor(user.id, 100);
  const taskOptions = tasks.map((wp) => ({
    text: { type: "plain_text", text: `#${wp.id} ${wp.subject}`.slice(0, 75) },
    value: String(wp.id),
  }));
  const blocks = [];
  if (taskOptions.length) {
    blocks.push(input("task", "Task", { type: "static_select", options: taskOptions }, true));
  }
  blocks.push(
    input("task_id", taskOptions.length ? "…or task ID" : "Task ID", {
      type: "plain_text_input",
      placeholder: { type: "plain_text", text: "123" },
      ...(prefill.workPackageId ? { initial_value: String(prefill.workPackageId) } : {}),
    }, taskOptions.length > 0),
    input("hours", "Time spent", {
      type: "plain_text_input",
      placeholder: { type: "plain_text", text: "1.5 or 1h30m" },
      ...(prefill.hours ? { initial_value: String(prefill.hours) } : {}),
    }),
    input("date", "Date", { type: "datepicker", initial_date: todayIn(TZ) }),
    input("comment", "Comment", { type: "plain_text_input", ...(prefill.comment ? { initial_value: prefill.comment } : {}) }, true),
  );
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "log_time",
      title: { type: "plain_text", text: "Log time" },
      submit: { type: "plain_text", text: "Log" },
      blocks,
    },
  });
}

app.command("/log-time", async ({ ack, command: cmd, client, respond, logger }) => {
  await ack();
  try {
    const user = await vynkUser(client, cmd.user_id);
    const parsed = parseLogTime(cmd.text);
    if (parsed.hours === null || parsed.workPackageId === null) {
      await openLogTimeModal(client, cmd.trigger_id, user, parsed);
      return;
    }
    const spentOn = resolveDate(parsed.date, TZ);
    if (!spentOn) throw new UserFacingError("Date must be `today`, `yesterday` or `YYYY-MM-DD`.");
    const text = await logTimeFor(user, { ...parsed, spentOn });
    await respond({ response_type: "ephemeral", text });
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("/log-time failed", err);
    await respond({ response_type: "ephemeral", text: errorText(err) });
  }
});

app.view("log_time", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const hours = parseHours(values.hours.value.value);
  const typedId = values.task_id.value.value?.trim().replace("#", "");
  const workPackageId = Number(typedId || values.task?.value.selected_option?.value);
  const errors = {};
  if (!hours) errors.hours = "Use a number like 1.5 or 1h30m";
  if (!workPackageId) errors[values.task ? "task" : "task_id"] = "Pick a task or type its ID";
  else if (typedId && !/^\d+$/.test(typedId)) errors.task_id = "Task ID must be a number";
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }
  await ack();
  const dm = (text) => client.chat.postMessage({ channel: body.user.id, text });
  try {
    const user = await vynkUser(client, body.user.id);
    const text = await logTimeFor(user, {
      hours,
      workPackageId,
      spentOn: values.date.value.selected_date,
      comment: values.comment.value.value ?? "",
    });
    await dm(text);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("log_time submit failed", err);
    await dm(errorText(err));
  }
});

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function weekHours({ cmd, client, text }) {
  const user = await vynkUser(client, cmd.user_id);
  const weeksBack = /^last/i.test(text) ? 1 : 0;
  const week = currentWeek(TZ, weeksBack);
  const entries = await op.timeEntries({ from: week.from, to: week.to, userId: user.id });
  const total = entries.reduce((sum, e) => sum + e.hours, 0);
  const label = weeksBack ? "Last week" : "This week";
  if (!entries.length) return `*${label}* (${week.from} → ${week.to}): no time logged yet. Use \`/log-time\`.`;

  const perDay = week.days.map((day, i) => {
    const h = entries.filter((e) => e.spentOn === day).reduce((sum, e) => sum + e.hours, 0);
    return `${DAY_NAMES[i]} ${day.slice(5)}  ${h ? `*${formatHours(h)}*` : "—"}`;
  });
  const perTask = new Map();
  for (const e of entries) {
    const key = e.workPackageId ?? 0;
    const current = perTask.get(key) ?? { title: e.workPackageTitle ?? "Other", hours: 0 };
    current.hours += e.hours;
    perTask.set(key, current);
  }
  const taskLines = [...perTask.entries()]
    .sort((a, b) => b[1].hours - a[1].hours)
    .map(([id, t]) => `• ${id ? `<${wpUrl(id)}|#${id} ${escape(t.title)}>` : escape(t.title)} — ${formatHours(t.hours)}`);

  return {
    text: `${label}: ${formatHours(total)}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${label}* (${week.from} → ${week.to}) — *${formatHours(total)}* total` } },
      { type: "section", text: { type: "mrkdwn", text: perDay.join("\n") } },
      { type: "section", text: { type: "mrkdwn", text: `*By task*\n${taskLines.slice(0, 25).join("\n")}` } },
    ],
  };
}

command("/week-hours", weekHours);
command("/time-week-logged-times", weekHours);

async function teamHours({ cmd, client, text }) {
  await requireAdmin(client, cmd.user_id);
  const weeksBack = /^last/i.test(text) ? 1 : 0;
  const week = currentWeek(TZ, weeksBack);
  const [entries, users] = await Promise.all([op.timeEntries({ from: week.from, to: week.to }), op.activeUsers()]);
  const totals = new Map(users.map((u) => [u.id, { name: u.name, hours: 0 }]));
  for (const e of entries) {
    const row = totals.get(e.userId) ?? { name: e.userName ?? `User ${e.userId}`, hours: 0 };
    row.hours += e.hours;
    totals.set(e.userId, row);
  }
  const rows = [...totals.values()].sort((a, b) => b.hours - a.hours);
  const sum = rows.reduce((s, r) => s + r.hours, 0);
  const label = weeksBack ? "Last week" : "This week";
  return `*Team hours — ${label}* (${week.from} → ${week.to}) — *${formatHours(sum)}*\n${rows
    .map((r) => `• ${escape(r.name)} — ${r.hours ? `*${formatHours(r.hours)}*` : "_none_"}`)
    .join("\n")}`;
}

command("/team-hours", teamHours);

// ---------- @vynk menu ----------

const MENU = [
  ["log_time", ":stopwatch: Log time"],
  ["week_hours", ":calendar: My hours this week"],
  ["last_week_hours", ":calendar: My hours last week"],
  ["my_tasks", ":clipboard: My open tasks"],
  ["create_task", ":heavy_plus_sign: Create a task"],
  ["projects", ":file_folder: Projects"],
  ["create_project", ":sparkles: Create a project (admin)"],
  ["team_hours", ":busts_in_silhouette: Team hours this week (admin)"],
];

const menuMessage = (slackUserId) => ({
  text: "What do you want to do in Vynk?",
  blocks: [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Hi <@${slackUserId}>, what do you want to do in Vynk?` },
      accessory: {
        type: "static_select",
        action_id: "vynk_menu",
        placeholder: { type: "plain_text", text: "Choose an action" },
        options: MENU.map(([value, label]) => ({ text: { type: "plain_text", text: label, emoji: true }, value })),
      },
    },
  ],
});

command("/vynk", async ({ cmd }) => ({ ...menuMessage(cmd.user_id), blocks: [...menuMessage(cmd.user_id).blocks, { type: "context", elements: [{ type: "mrkdwn", text: HELP.split("\n").slice(1).join("  ·  ") }] }] }));

app.event("app_mention", async ({ event, client, logger }) => {
  try {
    await client.chat.postEphemeral({ channel: event.channel, user: event.user, ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}), ...menuMessage(event.user) });
  } catch (err) {
    logger.error("app_mention failed", err);
  }
});

app.message(async ({ message, say, logger }) => {
  if (message.channel_type !== "im" || message.subtype || message.bot_id) return;
  try {
    await say(menuMessage(message.user));
  } catch (err) {
    logger.error("dm menu failed", err);
  }
});

app.action("vynk_menu", async ({ ack, body, action, client, respond, logger }) => {
  await ack();
  const userId = body.user.id;
  const cmd = { user_id: userId };
  const reply = (r) => respond({ response_type: "ephemeral", replace_original: false, ...(typeof r === "string" ? { text: r } : r) });
  try {
    switch (action.selected_option.value) {
      case "log_time":
        await openLogTimeModal(client, body.trigger_id, await vynkUser(client, userId));
        break;
      case "create_task":
        await vynkUser(client, userId);
        await openCreateTaskModal(client, body.trigger_id, userId);
        break;
      case "create_project":
        await requireAdmin(client, userId);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "create_project",
            title: { type: "plain_text", text: "New project" },
            submit: { type: "plain_text", text: "Create" },
            blocks: [input("name", "Project name", { type: "plain_text_input" })],
          },
        });
        break;
      case "week_hours":
        await reply(await weekHours({ cmd, client, text: "" }));
        break;
      case "last_week_hours":
        await reply(await weekHours({ cmd, client, text: "last" }));
        break;
      case "my_tasks":
        await reply(await myTasksReply({ cmd, client }));
        break;
      case "projects":
        await reply(await projectsReply({ cmd, client }));
        break;
      case "team_hours":
        await reply(await teamHours({ cmd, client, text: "" }));
        break;
    }
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("vynk_menu failed", err);
    await reply(errorText(err));
  }
});

// ---------- weekly reminder ----------
// REMINDER_DAY (mon..sun) + REMINDER_TIME (HH:MM, BOT_TIMEZONE). Users below REMINDER_MIN_HOURS get a DM.

const REMINDER_DAY = (process.env.REMINDER_DAY || "").toLowerCase().slice(0, 3);
const REMINDER_TIME = process.env.REMINDER_TIME || "17:00";
const REMINDER_MIN_HOURS = Number(process.env.REMINDER_MIN_HOURS || 40);
let lastReminder = null;

function nowParts() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.weekday.toLowerCase(), time: `${parts.hour}:${parts.minute}` };
}

async function sendReminders() {
  const week = currentWeek(TZ);
  const [entries, users] = await Promise.all([op.timeEntries({ from: week.from, to: week.to }), op.activeUsers()]);
  for (const user of users) {
    if (!user.email) continue;
    const hours = entries.filter((e) => e.userId === user.id).reduce((s, e) => s + e.hours, 0);
    if (hours >= REMINDER_MIN_HOURS) continue;
    try {
      const { user: slackUser } = await app.client.users.lookupByEmail({ email: user.email });
      await app.client.chat.postMessage({
        channel: slackUser.id,
        text: `:wave: Friendly reminder: you've logged *${formatHours(hours)}* this week (target ${REMINDER_MIN_HOURS}h). Use \`/log-time\` to catch up.`,
      });
    } catch (err) {
      if (err?.data?.error !== "users_not_found") app.logger.warn(`reminder for ${user.email} failed: ${err.message}`);
    }
  }
}

function startReminderLoop() {
  if (!REMINDER_DAY) return;
  setInterval(() => {
    const { day, time } = nowParts();
    const key = `${todayIn(TZ)} ${time}`;
    if (day === REMINDER_DAY && time === REMINDER_TIME && lastReminder !== key) {
      lastReminder = key;
      sendReminders().catch((err) => app.logger.error("reminders failed", err));
    }
  }, 30 * 1000);
  app.logger.info(`Weekly reminder: ${REMINDER_DAY} ${REMINDER_TIME} ${TZ}, under ${REMINDER_MIN_HOURS}h`);
}

await app.start();
startReminderLoop();
app.logger.info(`Vynk Slack bot running (Socket Mode) → ${BASE_URL}`);
