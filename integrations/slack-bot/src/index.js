import bolt from "@slack/bolt";
import { OpenProject, OpenProjectError } from "./openproject.js";
import { parseCreateTask, parseLogTime } from "./commands.js";
import { MAX_HOURS_PER_DAY, MAX_HOURS_PER_ENTRY, currentWeek, formatHours, hoursError, parseHours, resolveDate, todayIn, weekContaining } from "./time.js";
import { loggedView, menuView, prettyDate, projectsView, tasksView, teamView, weekView } from "./views.js";

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
const urls = { wp: wpUrl, project: (p) => `${BASE_URL}/projects/${p.identifier}` };
const prettyWeek = (week) =>
  new Date(`${week.from}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const projectUrl = (p) => `${BASE_URL}/projects/${p.identifier}`;
const escape = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
      if (reply)
        await respond(typeof reply === "string" ? { response_type: "ephemeral", text: reply } : { response_type: "ephemeral", ...reply });
    } catch (err) {
      if (!(err instanceof UserFacingError)) logger.error(`${name} failed`, err);
      await respond({ response_type: "ephemeral", text: errorText(err) });
    }
  });
}

// ---------- projects ----------

async function projectsReply({ cmd, client }) {
  const user = await vynkUser(client, cmd.user_id);
  const week = currentWeek(TZ);
  const [projects, entries] = await Promise.all([
    op.projectsFor(user),
    op.timeEntries({ from: week.from, to: week.to, ...(user.admin ? {} : { userId: user.id }) }),
  ]);
  const mine = new Map();
  const team = new Map();
  for (const e of entries) {
    team.set(e.projectId, (team.get(e.projectId) ?? 0) + e.hours);
    if (e.userId === user.id) mine.set(e.projectId, (mine.get(e.projectId) ?? 0) + e.hours);
  }
  return projectsView({ projects, mine, team, urls, showTeam: Boolean(user.admin) });
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
  return {
    response_type: "in_channel",
    text: `:white_check_mark: Project <${projectUrl(project)}|${escape(project.name)}> created by <@${cmd.user_id}>.`,
  };
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
  return tasksView({ tasks: await op.openTasksFor(user.id, 30), urls });
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

// Slack's trigger_id expires after 3s, so open a loading form first and fill it in once Vynk answers.
async function openForm(client, triggerId, title, build) {
  const shell = { type: "modal", title: { type: "plain_text", text: title }, close: { type: "plain_text", text: "Cancel" } };
  const { view } = await client.views.open({
    trigger_id: triggerId,
    view: { ...shell, blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Loading…" } }] },
  });
  try {
    const { callbackId, submit, blocks, privateMetadata } = await build();
    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        ...shell,
        callback_id: callbackId,
        submit: { type: "plain_text", text: submit },
        ...(privateMetadata ? { private_metadata: privateMetadata } : {}),
        blocks,
      },
    });
  } catch (err) {
    if (!(err instanceof UserFacingError)) app.logger.error(`${title} form failed`, err);
    await client.views.update({
      view_id: view.id,
      view: {
        ...shell,
        close: { type: "plain_text", text: "Close" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: errorText(err) } }],
      },
    });
  }
}

function openCreateTaskModal(client, triggerId, slackUserId, subject) {
  return openForm(client, triggerId, "New task", async () => {
    await vynkUser(client, slackUserId);
    const options = await projectOptions();
    if (!options.length) throw new UserFacingError("There are no projects yet.");
    return {
      callbackId: "create_task",
      submit: "Create",
      blocks: [
        input("project", "Project", { type: "static_select", options }),
        input("subject", "Title", { type: "plain_text_input", ...(subject ? { initial_value: subject } : {}) }),
        input("description", "Description", { type: "plain_text_input", multiline: true }, true),
        input("assignee", "Assignee", { type: "users_select", initial_user: slackUserId }, true),
      ],
    };
  });
}

function openCreateProjectModal(client, triggerId, slackUserId) {
  return openForm(client, triggerId, "New project", async () => {
    await requireAdmin(client, slackUserId);
    return { callbackId: "create_project", submit: "Create", blocks: [input("name", "Project name", { type: "plain_text_input" })] };
  });
}

app.command("/create-task", async ({ ack, command: cmd, client, respond, logger }) => {
  await ack();
  try {
    const { project: projectName, subject } = parseCreateTask(cmd.text);
    if (projectName && subject) {
      const user = await vynkUser(client, cmd.user_id);
      const project = await op.findProject(projectName);
      if (!project) throw new UserFacingError(`No project matches *${escape(projectName)}*. Try \`/projects\`.`);
      const wp = await op.createTask({ projectId: project.id, subject, assigneeId: user.id });
      await respond({
        response_type: "ephemeral",
        text: `:white_check_mark: Created <${wpUrl(wp.id)}|${escape(wp.subject)}> in ${escape(project.name)}.${unassignedNote(wp)}`,
      });
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
    await dm(`:white_check_mark: Created <${wpUrl(wp.id)}|${escape(wp.subject)}>${wp.assigneeSkipped ? "" : who}.${unassignedNote(wp)}`);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("create_task submit failed", err);
    await dm(errorText(err));
  }
});

// ---------- time ----------

async function logTimeFor(user, { hours, workPackageId, spentOn, comment, activityId }, created = []) {
  const wp = await op.workPackage(workPackageId).catch((err) => {
    if (err.status === 404) throw new UserFacingError("That task doesn't exist anymore.");
    throw err;
  });
  const week = weekContaining(spentOn);
  const before = await op.timeEntries({ from: week.from, to: week.to, userId: user.id });
  const dayTotal = before.filter((e) => e.spentOn === spentOn).reduce((sum, e) => sum + e.hours, 0);
  if (dayTotal + hours > MAX_HOURS_PER_DAY + 1e-9) {
    throw new UserFacingError(
      `That would make ${formatHours(dayTotal + hours)} on ${prettyDate(spentOn)}. You can log at most ${MAX_HOURS_PER_DAY}h a day (already ${formatHours(dayTotal)}).`,
    );
  }
  const entry = await op.logTime({ userId: user.id, workPackageId, hours, spentOn, comment, activityId }).catch((err) => {
    if (err.status === 403) throw new UserFacingError("You can't log time here: you're not a member of this project.");
    throw err;
  });
  return loggedView({
    hours,
    wp,
    projectName: wp._links?.project?.title,
    activityName: entry?._links?.activity?.title,
    spentOn,
    weekLabel: week.from === currentWeek(TZ).from ? "This week" : `Week of ${prettyWeek(week)}`,
    weekTotal: before.reduce((sum, e) => sum + e.hours, 0) + hours,
    created,
    urls,
  });
}

const cache = new Map();
async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

const option = (text, value) => ({ text: { type: "plain_text", text: String(text).slice(0, 75) }, value: String(value) });
const plain = (text) => ({ type: "plain_text", text });

async function logTimeData(user, projectId) {
  const projects = await cached(`projects:${user.id}`, 60_000, () => op.projectsFor(user));
  if (!projects.length) throw new UserFacingError("You're not a member of any project yet. Ask an admin to add you.");
  const id = projectId ?? (projects.length === 1 ? projects[0].id : null);
  const [tasks, activities] = id
    ? await Promise.all([
        cached(`tasks:${id}`, 30_000, () => op.projectTasks(id)),
        cached(`activities:${id}`, 300_000, () => op.activities(id)),
      ])
    : [[], []];
  return { projects, projectId: id, tasks, activities };
}

function logTimeView({ projects, projectId, tasks, activities }, meta, prefill = {}) {
  const mode = meta.mode === "existing" && tasks.length ? "existing" : "new";
  const project = projects.find((p) => p.id === projectId);
  const projectOptions = projects.slice(0, 100).map((p) => option(p.name, p.id));
  const blocks = [
    {
      type: "input",
      block_id: "project",
      dispatch_action: true,
      label: plain("Project"),
      element: {
        type: "static_select",
        action_id: "lt_project",
        placeholder: plain("Choose a project"),
        options: projectOptions,
        ...(project ? { initial_option: option(project.name, project.id) } : {}),
      },
    },
  ];

  if (projectId) {
    if (mode === "new") {
      blocks.push(input("task_title", "Task", { type: "plain_text_input", placeholder: plain("What are you working on?") }));
    } else {
      blocks.push(
        input("task_pick", "Task", {
          type: "static_select",
          placeholder: plain("Choose a task"),
          options: tasks.map((t) => option(t.subject, t.id)),
        }),
      );
    }
    if (tasks.length) {
      blocks.push({
        type: "actions",
        block_id: "task_mode",
        elements: [
          {
            type: "button",
            action_id: "lt_mode",
            text: plain(mode === "new" ? "Pick an existing task" : "Create a new task instead"),
            value: mode === "new" ? "existing" : "new",
          },
        ],
      });
    }
    blocks.push(
      input("subtask", "Subtask", { type: "plain_text_input", placeholder: plain("Optional: a smaller step under this task") }, true),
    );
    if (activities.length) {
      blocks.push(
        input("activity", "Activity", {
          type: "static_select",
          placeholder: plain("What kind of work?"),
          options: activities.map((a) => option(a.name, a.id)),
        }),
      );
    }
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Choose a project to see its tasks." }] });
  }

  blocks.push(
    { type: "divider" },
    {
      ...input("hours", "Time spent", {
        type: "plain_text_input",
        placeholder: plain("e.g. 2h, 1h30m or 1.5"),
        ...(prefill.hours ? { initial_value: String(prefill.hours) } : {}),
      }),
      hint: plain(`Up to ${MAX_HOURS_PER_ENTRY}h per entry and per day`),
    },
    input("date", "Date", { type: "datepicker", initial_date: todayIn(TZ) }),
    input(
      "comment",
      "Notes",
      {
        type: "plain_text_input",
        multiline: true,
        placeholder: plain("What did you do?"),
        ...(prefill.comment ? { initial_value: prefill.comment } : {}),
      },
      true,
    ),
  );

  return {
    type: "modal",
    callback_id: "log_time",
    private_metadata: JSON.stringify({ projectId, mode }),
    title: plain("Log time"),
    submit: plain("Log time"),
    close: plain("Cancel"),
    blocks,
  };
}

function openLogTimeModal(client, triggerId, slackUserId, prefill = {}) {
  return openForm(client, triggerId, "Log time", async () => {
    const user = await vynkUser(client, slackUserId);
    const view = logTimeView(await logTimeData(user), { mode: "new" }, prefill);
    return { callbackId: view.callback_id, submit: view.submit.text, blocks: view.blocks, privateMetadata: view.private_metadata };
  });
}

async function refreshLogTimeView({ body, client, logger }, changes) {
  try {
    const meta = { ...JSON.parse(body.view.private_metadata || "{}"), ...changes };
    const user = await vynkUser(client, body.user.id);
    const data = await logTimeData(user, meta.projectId);
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: logTimeView(data, meta) });
  } catch (err) {
    if (err?.data?.error === "hash_conflict") return;
    logger.error("log time refresh failed", err);
  }
}

app.action("lt_project", async ({ ack, body, action, client, logger }) => {
  await ack();
  await refreshLogTimeView({ body, client, logger }, { projectId: Number(action.selected_option.value), mode: "new" });
});

app.action("lt_mode", async ({ ack, body, action, client, logger }) => {
  await ack();
  await refreshLogTimeView({ body, client, logger }, { mode: action.value });
});

app.command("/log-time", async ({ ack, command: cmd, client, respond, logger }) => {
  await ack();
  try {
    const parsed = parseLogTime(cmd.text);
    if (parsed.hours === null || parsed.workPackageId === null) {
      await openLogTimeModal(client, cmd.trigger_id, cmd.user_id, parsed);
      return;
    }
    if (parsed.hours > MAX_HOURS_PER_ENTRY) throw new UserFacingError(`Maximum is ${MAX_HOURS_PER_ENTRY}h per entry.`);
    const user = await vynkUser(client, cmd.user_id);
    const spentOn = resolveDate(parsed.date, TZ);
    if (!spentOn) throw new UserFacingError("Date must be `today`, `yesterday` or `YYYY-MM-DD`.");
    await respond({ response_type: "ephemeral", ...(await logTimeFor(user, { ...parsed, spentOn })) });
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("/log-time failed", err);
    await respond({ response_type: "ephemeral", text: errorText(err) });
  }
});

function pickedTitle(view, id) {
  const block = view.blocks?.find((b) => b.block_id === "task_pick");
  return block?.element?.options?.find((o) => o.value === String(id))?.text?.text ?? "task";
}

app.view("log_time", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const meta = JSON.parse(view.private_metadata || "{}");
  const hours = parseHours(values.hours?.value.value);
  const durationError = hoursError(values.hours?.value.value);
  const taskTitle = values.task_title?.value.value?.trim();
  const pickedId = Number(values.task_pick?.value.selected_option?.value);
  const subtask = values.subtask?.value.value?.trim();
  const activityId = Number(values.activity?.value.selected_option?.value) || null;
  const errors = {};
  if (!meta.projectId) errors.project = "Choose a project";
  else if (meta.mode === "existing" && !pickedId) errors.task_pick = "Choose a task";
  else if (meta.mode !== "existing" && !taskTitle) errors.task_title = "Name the task";
  if (durationError) errors.hours = durationError;
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }
  await ack();
  const dm = (msg) => client.chat.postMessage({ channel: body.user.id, ...(typeof msg === "string" ? { text: msg } : msg) });
  try {
    const user = await vynkUser(client, body.user.id);
    const notes = [];
    let targetId = pickedId;
    if (!targetId) {
      const wp = await op.createTask({ projectId: meta.projectId, subject: taskTitle, assigneeId: user.id });
      targetId = wp.id;
      notes.push("New task created");
    }
    if (subtask) {
      const sub = await op.createTask({ projectId: meta.projectId, subject: subtask, assigneeId: user.id, parentId: targetId });
      targetId = sub.id;
      notes.push(`Subtask of ${escape(taskTitle || pickedTitle(view, pickedId))}`);
    }
    cache.delete(`tasks:${meta.projectId}`);
    await dm(
      await logTimeFor(
        user,
        {
          hours,
          workPackageId: targetId,
          activityId,
          spentOn: values.date.value.selected_date,
          comment: values.comment?.value.value ?? "",
        },
        notes,
      ),
    );
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("log_time submit failed", err);
    await dm(errorText(err));
  }
});

async function weekHours({ cmd, client, text }) {
  const user = await vynkUser(client, cmd.user_id);
  const weeksBack = /^last/i.test(text) ? 1 : 0;
  const week = currentWeek(TZ, weeksBack);
  const entries = await op.timeEntries({ from: week.from, to: week.to, userId: user.id });
  return weekView({
    label: weeksBack ? "Last week" : "This week",
    week,
    entries,
    urls,
    otherWeekLabel: weeksBack ? "This week" : "Last week",
    otherWeekValue: weeksBack ? "this" : "last",
  });
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
    const row = totals.get(e.userId) ?? { name: e.userName ?? "Unknown", hours: 0 };
    row.hours += e.hours;
    totals.set(e.userId, row);
  }
  const rows = [...totals.values()].sort((a, b) => b.hours - a.hours);
  return teamView({ label: weeksBack ? "Last week" : "This week", week, rows });
}

command("/team-hours", teamHours);

// ---------- @vynk menu ----------

const MENU = [
  ["log_time", "Log time"],
  ["week_hours", "My week"],
  ["my_tasks", "My tasks"],
  ["projects", "Projects"],
  ["create_task", "New task"],
  ["create_project", "New project  ·  admin"],
  ["team_hours", "Team hours  ·  admin"],
];

const menuMessage = () => menuView(MENU);

command("/vynk", async () => menuMessage());

app.event("app_mention", async ({ event, client, logger }) => {
  try {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...menuMessage(),
    });
  } catch (err) {
    logger.error("app_mention failed", err);
  }
});

app.message(async ({ message, say, logger }) => {
  if (message.channel_type !== "im" || message.subtype || message.bot_id) return;
  try {
    await say(menuMessage());
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
        await openLogTimeModal(client, body.trigger_id, userId);
        break;
      case "create_task":
        await openCreateTaskModal(client, body.trigger_id, userId);
        break;
      case "create_project":
        await openCreateProjectModal(client, body.trigger_id, userId);
        break;
      case "week_hours":
        await reply(await weekHours({ cmd, client, text: "" }));
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

app.action("open_log_time", async ({ ack, body, client }) => {
  await ack();
  await openLogTimeModal(client, body.trigger_id, body.user.id);
});

app.action("show_week", async ({ ack, body, action, client, respond, logger }) => {
  await ack();
  try {
    await respond({ replace_original: true, ...(await weekHours({ cmd: { user_id: body.user.id }, client, text: action.value })) });
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("show_week failed", err);
    await respond({ response_type: "ephemeral", replace_original: false, text: errorText(err) });
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
