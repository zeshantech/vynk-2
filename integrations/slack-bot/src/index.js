import crypto from "node:crypto";
import http from "node:http";
import bolt from "@slack/bolt";
import { NotSignedInError, OpenProject, OpenProjectError } from "./openproject.js";
import { Sessions, resultPage } from "./auth.js";
import { cleanSlackText, matchTask, normalize, parseEod } from "./eod.js";
import { EodReader } from "./llm.js";
import { Store } from "./store.js";
import { parseCreateTask, parseLogTime } from "./commands.js";
import {
  MAX_HOURS_PER_DAY,
  MAX_HOURS_PER_ENTRY,
  currentWeek,
  formatHours,
  hoursError,
  parseHours,
  resolveDate,
  todayIn,
  weekContaining,
} from "./time.js";
import {
  membersAddedView,
  projectCreatedView,
  connectView,
  eodConnectView,
  eodDismissedView,
  eodDoneView,
  eodNothingView,
  eodReviewView,
  loggedView,
  menuView,
  prettyDate,
  projectsView,
  tasksView,
  teamView,
  weekView,
} from "./views.js";

const { App, LogLevel } = bolt;

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing env ${name}`);
  return value;
};

const TZ = process.env.BOT_TIMEZONE || "Asia/Karachi";
const BASE_URL = env("OPENPROJECT_URL").replace(/\/$/, "");
const PUBLIC_URL = (process.env.BOT_PUBLIC_URL || BASE_URL).replace(/\/$/, "");
// Service account: only for admin-wide jobs (weekly reminders) and looking up other people.
const op = new OpenProject({ baseUrl: BASE_URL, apiKey: env("OPENPROJECT_API_KEY") });
const sessions = new Sessions({
  baseUrl: BASE_URL,
  clientId: process.env.OPENPROJECT_OAUTH_CLIENT_ID,
  clientSecret: process.env.OPENPROJECT_OAUTH_CLIENT_SECRET,
  redirectUri: `${PUBLIC_URL}/__slack/oauth/callback`,
  dataDir: process.env.DATA_DIR || "/data",
});
const store = new Store(process.env.DATA_DIR || "/data");
const eodReader = new EodReader({ apiKey: process.env.GROQ_API_KEY, model: process.env.EOD_MODEL || "openai/gpt-oss-20b" });

const app = new App({
  token: env("SLACK_BOT_TOKEN"),
  appToken: env("SLACK_APP_TOKEN"),
  socketMode: true,
  logLevel: process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
});

class UserFacingError extends Error {}
class NotConnectedError extends UserFacingError {
  constructor(slackUserId) {
    super("Not connected to Vynk");
    this.slackUserId = slackUserId;
  }
}

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

const meCache = new Map();

/** The signed-in Vynk user for this Slack user, with `api` acting as them. */
async function vynkUser(client, slackUserId) {
  if (!sessions.enabled) return legacyUser(client, slackUserId);
  const api = sessions.client(slackUserId);
  if (!api) throw new NotConnectedError(slackUserId);
  const hit = meCache.get(slackUserId);
  let user = hit && hit.expires > Date.now() ? hit.user : null;
  if (!user) {
    try {
      user = await api.me();
    } catch (err) {
      if (err instanceof NotSignedInError) throw new NotConnectedError(slackUserId);
      throw err;
    }
    meCache.set(slackUserId, { user, expires: Date.now() + 5 * 60_000 });
  }
  if (user.status && user.status !== "active") throw new UserFacingError("Your Vynk account is not active.");
  return { ...user, api };
}

// Until the OAuth app keys are configured: match by email and act through the service account.
async function legacyUser(client, slackUserId) {
  const email = await slackEmail(client, slackUserId);
  if (!email) throw new UserFacingError("I can't see your Slack email. Ask an admin to grant the bot `users:read.email`.");
  const user = await op.userByEmail(email);
  if (!user) throw new UserFacingError(`No Vynk account uses *${escape(email)}*. Ask an admin to invite you at ${BASE_URL}`);
  if (user.status && user.status !== "active") throw new UserFacingError("Your Vynk account is not active.");
  return { ...user, api: op };
}

/** Vynk user id for any Slack user (signed in or not), matched by email. */
async function vynkIdFor(client, slackUserId) {
  const signedIn = await vynkUser(client, slackUserId).catch(() => null);
  if (signedIn) return signedIn.id;
  const email = await slackEmail(client, slackUserId);
  return email ? ((await op.userByEmail(email))?.id ?? null) : null;
}

async function requireAdmin(client, slackUserId) {
  const user = await vynkUser(client, slackUserId);
  if (!user.admin) throw new UserFacingError("Only Vynk admins can do that.");
  return user;
}

function errorText(err) {
  if (err instanceof NotConnectedError)
    return `:link:  <${sessions.connectUrl(err.slackUserId)}|*Connect your Vynk account*> to continue. You only sign in once.`;
  if (err instanceof NotSignedInError) return ":link:  Your Vynk sign-in expired. Type `@Vynk` to connect again.";
  if (err instanceof UserFacingError) return `:warning: ${err.message}`;
  if (err instanceof OpenProjectError) return `:x: Vynk said: ${escape(err.message)}`;
  return ":x: Something went wrong. Please try again.";
}

/** Sends a reply; if Slack rejects the table block, resends with the monospace fallback. */
async function deliver(send, msg) {
  const { fallback, failed, ...main } = msg;
  if (!fallback) return send(main);
  try {
    const res = await send(main);
    if (res?.data?.ok === false) throw new Error(res.data.error);
    return res;
  } catch (err) {
    app.logger.warn(`table block rejected (${err.data?.error ?? err.message}), using fallback`);
    return send({ ...main, ...fallback });
  }
}

/** Acks immediately (Slack's 3s limit) and replies ephemerally with the handler's result or error. */
function command(name, handler) {
  app.command(name, async ({ ack, command: cmd, client, respond, logger }) => {
    await ack();
    try {
      const reply = await handler({ cmd, client, text: cmd.text?.trim() ?? "" });
      if (reply)
        await deliver(
          respond,
          typeof reply === "string" ? { response_type: "ephemeral", text: reply } : { response_type: "ephemeral", ...reply },
        );
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
    user.api.projectsFor(user),
    user.api.timeEntries({ from: week.from, to: week.to, ...(user.admin ? {} : { userId: user.id }) }),
  ]);
  const mine = new Map();
  const team = new Map();
  for (const e of entries) {
    team.set(e.projectId, (team.get(e.projectId) ?? 0) + e.hours);
    if (e.userId === user.id) mine.set(e.projectId, (mine.get(e.projectId) ?? 0) + e.hours);
  }
  const members = await user.api.memberships(projects.slice(0, 100).map((p) => p.id)).catch(() => []);
  return projectsView({ projects, mine, team, members, urls, showTeam: Boolean(user.admin) });
}

command("/projects", projectsReply);

async function createProjectFor(admin, name) {
  const project = await admin.api.createProject(name);
  await admin.api.addMember({ projectId: project.id, userId: admin.id }).catch(() => null);
  return project;
}

const roleOption = (r) => option(r.name, r.id);

async function memberRoles(user) {
  const roles = await cached(`roles:${user.id}`, 10 * 60_000, () => user.api.projectRoles());
  if (!roles.length) throw new UserFacingError("No project roles are set up in Vynk.");
  return { roles, fallback: roles.find((r) => /^member$/i.test(r.name)) ?? roles[0] };
}

/**
 * Adds Slack users to a Vynk project. People without a Vynk account are invited when the
 * actor is a Vynk admin. Permissions are checked by Vynk itself (actor's own session).
 */
async function addPeople({ actor, client, projectId, slackUserIds, roleId }) {
  const result = { added: [], already: [], invited: [], skipped: [], failed: [] };
  const existing = new Set((await actor.api.memberships([projectId]).catch(() => [])).map((m) => m.userId));
  for (const slackUserId of [...new Set(slackUserIds)]) {
    const { user: slackUser } = await client.users.info({ user: slackUserId }).catch(() => ({ user: null }));
    const name = slackUser?.real_name || slackUser?.profile?.real_name || slackUser?.name || "Someone";
    const email = slackUser?.profile?.email;
    if (!slackUser || slackUser.is_bot || slackUser.deleted) {
      result.skipped.push(`${name} (not a person)`);
      continue;
    }
    if (!email) {
      result.skipped.push(`${name} (no email in Slack)`);
      continue;
    }
    try {
      let person = await op.userByEmail(email);
      if (!person) {
        if (!actor.admin) {
          result.skipped.push(`${name} (no Vynk account; ask an admin to invite them)`);
          continue;
        }
        const [firstName, ...rest] = (slackUser.profile?.real_name || name).trim().split(/\s+/);
        person = await op.inviteUser({ email, firstName: firstName || email.split("@")[0], lastName: rest.join(" ") || "-" });
        op.userCache.delete(email.toLowerCase());
        result.invited.push(name);
      }
      if (existing.has(person.id)) {
        result.already.push(name);
        continue;
      }
      await actor.api.addMembership({ projectId, userId: person.id, roleId });
      existing.add(person.id);
      if (!result.invited.includes(name)) result.added.push(name);
    } catch (err) {
      const reason =
        err.status === 403
          ? "you can't manage members of this project"
          : err instanceof OpenProjectError
            ? err.message
            : "something went wrong";
      if (!(err instanceof OpenProjectError)) app.logger.error("adding member failed", err);
      result.failed.push(`${name} (${reason})`);
    }
  }
  cache.delete(`projects:${actor.id}`);
  return result;
}

function peopleBlocks({ roles, fallback, label = "Invite people" }) {
  return [
    input("people", label, { type: "multi_users_select", placeholder: plain("Choose people from Slack") }, true),
    input("role", "Role", { type: "static_select", options: roles.map(roleOption), initial_option: roleOption(fallback) }),
  ];
}

command("/create-project", async ({ cmd, client, text }) => {
  const admin = await requireAdmin(client, cmd.user_id);
  if (!text) return "Usage: `/create-project Project name`";
  const project = await createProjectFor(admin, text);
  return projectCreatedView({ project, result: null, urls, inChannel: true, by: cmd.user_id });
});

app.view("create_project", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const name = values.name.value.value?.trim();
  if (!name) {
    await ack({ response_action: "errors", errors: { name: "Name is required" } });
    return;
  }
  await ack();
  const dm = (msg) => client.chat.postMessage({ channel: body.user.id, ...(typeof msg === "string" ? { text: msg } : msg) });
  try {
    const admin = await requireAdmin(client, body.user.id);
    const project = await createProjectFor(admin, name);
    const people = (values.people?.value.selected_users ?? []).filter((id) => id !== body.user.id);
    const roleId = Number(values.role?.value.selected_option?.value);
    const result =
      people.length && roleId ? await addPeople({ actor: admin, client, projectId: project.id, slackUserIds: people, roleId }) : null;
    await dm(projectCreatedView({ project, result, urls }));
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("create_project submit failed", err);
    await dm(errorText(err));
  }
});

function openMembersModal(client, triggerId, slackUserId, projectId) {
  return openForm(client, triggerId, "Project members", async () => {
    const user = await vynkUser(client, slackUserId);
    const projects = await cached(`projects:${user.id}`, 60_000, () => user.api.projectsFor(user));
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new UserFacingError("That project isn't available to you.");
    const [members, roleInfo] = await Promise.all([user.api.memberships([projectId]), memberRoles(user)]);
    const list = members
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => `${escape(m.name)}  ·  _${escape(m.roles.join(", ") || "No role")}_`);
    return {
      callbackId: "pm_members",
      submit: "Add people",
      privateMetadata: JSON.stringify({ projectId, projectName: project.name }),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${escape(project.name)}*\n${members.length} member${members.length === 1 ? "" : "s"}` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: (list.length ? list.slice(0, 40).join("\n") : "_No members yet_").slice(0, 2900) },
        },
        ...(list.length > 40 ? [{ type: "context", elements: [{ type: "mrkdwn", text: `+${list.length - 40} more` }] }] : []),
        { type: "divider" },
        ...peopleBlocks({ ...roleInfo, label: "Add people" }),
      ],
    };
  });
}

app.action(/^pm_manage/, async ({ ack, body, action, client }) => {
  await ack();
  const projectId = Number(action.value ?? action.selected_option?.value);
  await openMembersModal(client, body.trigger_id, body.user.id, projectId);
});

app.view("pm_members", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const meta = JSON.parse(view.private_metadata || "{}");
  const people = values.people?.value.selected_users ?? [];
  if (!people.length) {
    await ack({ response_action: "errors", errors: { people: "Choose at least one person" } });
    return;
  }
  await ack();
  const dm = (msg) => client.chat.postMessage({ channel: body.user.id, ...(typeof msg === "string" ? { text: msg } : msg) });
  try {
    const actor = await vynkUser(client, body.user.id);
    const roleId = Number(values.role.value.selected_option.value);
    const result = await addPeople({ actor, client, projectId: meta.projectId, slackUserIds: people, roleId });
    await dm(membersAddedView({ projectName: meta.projectName, role: values.role.value.selected_option.text.text, result }));
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("pm_members submit failed", err);
    await dm(errorText(err));
  }
});

// ---------- tasks ----------

async function myTasksReply({ cmd, client }) {
  const user = await vynkUser(client, cmd.user_id);
  return tasksView({ tasks: await user.api.openTasksFor(user.id, 30), urls });
}

command("/my-tasks", myTasksReply);

const unassignedNote = (wp) => (wp.assigneeSkipped ? " _(left unassigned: that person isn't a member of the project)_" : "");

async function projectOptions(user) {
  const projects = await user.api.projectsFor(user);
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
    const user = await vynkUser(client, slackUserId);
    const options = await projectOptions(user);
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
    const admin = await requireAdmin(client, slackUserId);
    return {
      callbackId: "create_project",
      submit: "Create",
      blocks: [
        input("name", "Project name", { type: "plain_text_input", placeholder: plain("e.g. Website Redesign") }),
        { type: "divider" },
        ...peopleBlocks(await memberRoles(admin)),
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "You're added as Project admin. People without a Vynk account get an email invite." }],
        },
      ],
    };
  });
}

app.command("/create-task", async ({ ack, command: cmd, client, respond, logger }) => {
  await ack();
  try {
    const { project: projectName, subject } = parseCreateTask(cmd.text);
    if (projectName && subject) {
      const user = await vynkUser(client, cmd.user_id);
      const project = await user.api.findProject(projectName);
      if (!project) throw new UserFacingError(`No project matches *${escape(projectName)}*. Try \`/projects\`.`);
      const wp = await user.api.createTask({ projectId: project.id, subject, assigneeId: user.id });
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
    const user = await vynkUser(client, body.user.id);
    const assigneeSlack = values.assignee.value.selected_user;
    const assignee = assigneeSlack ? { id: await vynkIdFor(client, assigneeSlack) } : null;
    if (assignee && !assignee.id) assignee.id = null;
    const projectId = Number(values.project.value.selected_option.value);
    const wp = await user.api.createTask({ projectId, subject, assigneeId: assignee?.id, description: values.description.value.value });
    const who = assignee?.id ? ` for <@${assigneeSlack}>` : "";
    await dm(`:white_check_mark: Created <${wpUrl(wp.id)}|${escape(wp.subject)}>${wp.assigneeSkipped ? "" : who}.${unassignedNote(wp)}`);
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("create_task submit failed", err);
    await dm(errorText(err));
  }
});

// ---------- time ----------

const MAX_ENTRIES = 8;

/** Saves several entries; checks the daily limit for all of them before saving any. */
async function logEntries(user, entries) {
  const dates = entries.map((e) => e.spentOn).sort();
  const from = weekContaining(dates[0]).from;
  const to = weekContaining(dates[dates.length - 1]).to;
  const existing = await user.api.timeEntries({ from, to, userId: user.id });
  for (const date of new Set(dates)) {
    const already = existing.filter((e) => e.spentOn === date).reduce((s, e) => s + e.hours, 0);
    const adding = entries.filter((e) => e.spentOn === date).reduce((s, e) => s + e.hours, 0);
    if (already + adding > MAX_HOURS_PER_DAY + 1e-9) {
      throw new UserFacingError(
        `That would make ${formatHours(already + adding)} on ${prettyDate(date)}. You can log at most ${MAX_HOURS_PER_DAY}h a day (already ${formatHours(already)}).`,
      );
    }
  }

  const results = [];
  let failure = null;
  for (const e of entries) {
    try {
      const created = [];
      let wp = e.workPackageId
        ? await user.api.workPackage(e.workPackageId).catch((err) => {
            if (err.status === 404) throw new UserFacingError("That task doesn't exist, or you don't have access to it.");
            throw err;
          })
        : null;
      if (!wp) {
        wp = await user.api.createTask({ projectId: e.projectId, subject: e.newTask, assigneeId: user.id });
        created.push("new task");
      }
      if (e.subtask) {
        wp = await user.api.createTask({
          projectId: e.projectId ?? idFromLink(wp._links?.project),
          subject: e.subtask,
          assigneeId: user.id,
          parentId: wp.id,
        });
        created.push("new subtask");
      }
      const entry = await op
        .logTime({
          userId: user.id,
          workPackageId: wp.id,
          hours: e.hours,
          spentOn: e.spentOn,
          comment: e.comment,
          activityId: e.activityId,
        })
        .catch((err) => {
          if (err.status === 403) throw new UserFacingError("You can't log time here: you're not a member of this project.");
          throw err;
        });
      results.push({ ...e, wp, activityName: entry?._links?.activity?.title, created });
    } catch (err) {
      failure = err;
      break;
    }
  }
  for (const e of entries) if (e.projectId) cache.delete(`tasks:${user.id}:${e.projectId}`);

  const week = weekContaining(dates[0]);
  const weekTotal =
    existing.filter((e) => e.spentOn >= week.from && e.spentOn <= week.to).reduce((s, e) => s + e.hours, 0) +
    results.filter((r) => r.spentOn >= week.from && r.spentOn <= week.to).reduce((s, r) => s + r.hours, 0);
  const view = loggedView({
    results,
    weekLabel: week.from === currentWeek(TZ).from ? "This week" : `Week of ${prettyWeek(week)}`,
    weekTotal,
    urls,
  });
  if (!failure) return view;
  if (!(failure instanceof UserFacingError)) app.logger.error("logging entry failed", failure);
  const note = `${errorText(failure)}${results.length ? ` (${results.length} of ${entries.length} saved)` : ""}`;
  return results.length
    ? { ...view, failed: true, blocks: [...view.blocks, { type: "context", elements: [{ type: "mrkdwn", text: note }] }] }
    : note;
}

const idFromLink = (link) => (link?.href ? Number(link.href.split("/").pop()) : null);

const cache = new Map();
async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

const option = (text, value) => ({ text: { type: "plain_text", text: String(text).slice(0, 75) }, value: String(value).slice(0, 150) });
const plain = (text) => ({ type: "plain_text", text });

async function logTimeData(user, projectId) {
  const projects = await cached(`projects:${user.id}`, 60_000, () => user.api.projectsFor(user));
  if (!projects.length) throw new UserFacingError("You're not a member of any project yet. Ask an admin to add you.");
  const id = projectId ?? (projects.length === 1 ? projects[0].id : null);
  const activities = id ? await cached(`activities:${user.id}:${id}`, 300_000, () => user.api.activities(id)) : [];
  if (id) cached(`tasks:${user.id}:${id}`, 30_000, () => user.api.projectTasks(id)).catch(() => null);
  return { projects, projectId: id, activities };
}

/** Current form values by block id, so they survive re-rendering the form. */
function formState(values = {}) {
  const out = {};
  for (const [blockId, actions] of Object.entries(values)) {
    const v = Object.values(actions)[0] ?? {};
    out[blockId] = { text: v.value ?? undefined, option: v.selected_option ?? undefined, date: v.selected_date ?? undefined };
  }
  return out;
}

function logTimeView({ projects, projectId, activities }, meta, prev = {}) {
  const count = Math.min(Math.max(meta.count ?? 1, 1), MAX_ENTRIES);
  const project = projects.find((p) => p.id === projectId);
  const text = (id) => (prev[id]?.text ? { initial_value: prev[id].text } : {});
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
        options: projects.slice(0, 100).map((p) => option(p.name, p.id)),
        ...(project ? { initial_option: option(project.name, project.id) } : {}),
      },
    },
    input("date", "Date", { type: "datepicker", initial_date: prev.date?.date ?? todayIn(TZ) }),
  ];

  if (!projectId) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Choose a project to add time entries." }] });
  } else {
    for (let n = 1; n <= count; n++) {
      const activity = prev[`e${n}_act`]?.option;
      blocks.push(
        { type: "divider" },
        ...(count > 1 ? [{ type: "section", text: { type: "mrkdwn", text: `*Entry ${n}*` } }] : []),
        {
          type: "input",
          block_id: `e${n}_task`,
          label: plain("Task"),
          hint: plain("Search your project's tasks, or type a name to create a new one"),
          element: {
            type: "external_select",
            action_id: "lt_task",
            min_query_length: 0,
            placeholder: plain("Search or type a new task"),
            ...(prev[`e${n}_task`]?.option ? { initial_option: prev[`e${n}_task`].option } : {}),
          },
        },
        input(
          `e${n}_sub`,
          "Subtask",
          { type: "plain_text_input", placeholder: plain("Optional: a smaller step under this task"), ...text(`e${n}_sub`) },
          true,
        ),
        ...(activities.length
          ? [
              input(`e${n}_act`, "Activity", {
                type: "static_select",
                placeholder: plain("What kind of work?"),
                options: activities.map((a) => option(a.name, a.id)),
                ...(activity && activities.some((a) => String(a.id) === activity.value) ? { initial_option: activity } : {}),
              }),
            ]
          : []),
        {
          ...input(`e${n}_hours`, "Time spent", {
            type: "plain_text_input",
            placeholder: plain("e.g. 2h, 1h30m or 1.5"),
            ...text(`e${n}_hours`),
          }),
          hint: plain(`Up to ${MAX_HOURS_PER_ENTRY}h per entry and per day`),
        },
        input(`e${n}_notes`, "Notes", { type: "plain_text_input", placeholder: plain("What did you do?"), ...text(`e${n}_notes`) }, true),
      );
    }
    const buttons = [];
    if (count < MAX_ENTRIES) buttons.push({ type: "button", action_id: "lt_add", text: plain("+ Add another entry"), value: "add" });
    if (count > 1) buttons.push({ type: "button", action_id: "lt_remove", text: plain("Remove last"), value: "remove" });
    if (buttons.length) blocks.push({ type: "divider" }, { type: "actions", block_id: "entries", elements: buttons });
  }

  return {
    type: "modal",
    callback_id: "log_time",
    private_metadata: JSON.stringify({ projectId, count }),
    title: plain("Log time"),
    submit: plain("Log time"),
    close: plain("Cancel"),
    blocks,
  };
}

function openLogTimeModal(client, triggerId, slackUserId, prefill = {}) {
  return openForm(client, triggerId, "Log time", async () => {
    const user = await vynkUser(client, slackUserId);
    const prev = {
      ...(prefill.hours ? { e1_hours: { text: String(prefill.hours) } } : {}),
      ...(prefill.comment ? { e1_notes: { text: prefill.comment } } : {}),
    };
    const view = logTimeView(await logTimeData(user), { count: 1 }, prev);
    return { callbackId: view.callback_id, submit: view.submit.text, blocks: view.blocks, privateMetadata: view.private_metadata };
  });
}

async function refreshLogTimeView({ body, client, logger }, change) {
  try {
    const meta = JSON.parse(body.view.private_metadata || "{}");
    const prev = formState(body.view.state?.values);
    const next = change(meta, prev);
    const user = await vynkUser(client, body.user.id);
    const data = await logTimeData(user, next.projectId);
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: logTimeView(data, next, prev) });
  } catch (err) {
    if (err?.data?.error === "hash_conflict") return;
    logger.error("log time refresh failed", err);
  }
}

app.action("lt_project", async ({ ack, body, action, client, logger }) => {
  await ack();
  await refreshLogTimeView({ body, client, logger }, (meta, prev) => {
    for (const key of Object.keys(prev)) if (/^e\d+_(task|sub|act)$/.test(key)) delete prev[key];
    return { ...meta, projectId: Number(action.selected_option.value) };
  });
});

app.action("lt_add", async ({ ack, body, client, logger }) => {
  await ack();
  await refreshLogTimeView({ body, client, logger }, (meta, prev) => {
    const count = (meta.count ?? 1) + 1;
    if (prev[`e${count - 1}_act`]) prev[`e${count}_act`] = prev[`e${count - 1}_act`];
    return { ...meta, count };
  });
});

app.action("lt_remove", async ({ ack, body, client, logger }) => {
  await ack();
  await refreshLogTimeView({ body, client, logger }, (meta) => ({ ...meta, count: Math.max(1, (meta.count ?? 1) - 1) }));
});

app.options("lt_task", async ({ ack, body }) => {
  try {
    const meta = JSON.parse(body.view?.private_metadata || "{}");
    const entryIndex = Number(String(body.block_id ?? "").match(/^e(\d+)_/)?.[1] ?? 0) - 1;
    const projectId = meta.entries ? meta.entries[entryIndex]?.projectId : meta.projectId;
    const query = String(body.value ?? "").trim();
    const user = await vynkUser(app.client, body.user.id);
    const tasks = projectId ? await cached(`tasks:${user.id}:${projectId}`, 30_000, () => user.api.projectTasks(projectId)) : [];
    const needle = query.toLowerCase();
    const options = tasks
      .filter((t) => !needle || t.subject.toLowerCase().includes(needle))
      .slice(0, 99)
      .map((t) => option(t.subject, `wp:${t.id}`));
    if (query && !tasks.some((t) => t.subject.toLowerCase() === needle)) options.unshift(option(`+ New task: ${query}`, `new:${query}`));
    await ack({ options });
  } catch (err) {
    app.logger.error("task search failed", err);
    await ack({ options: [] });
  }
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
    const reply = await logEntries(user, [{ hours: parsed.hours, workPackageId: parsed.workPackageId, spentOn, comment: parsed.comment }]);
    await deliver(respond, { response_type: "ephemeral", ...(typeof reply === "string" ? { text: reply } : reply) });
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("/log-time failed", err);
    await respond({ response_type: "ephemeral", text: errorText(err) });
  }
});

app.view("log_time", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const meta = JSON.parse(view.private_metadata || "{}");
  const spentOn = values.date?.value.selected_date;
  const errors = {};
  const entries = [];
  if (!meta.projectId) errors.project = "Choose a project";
  for (let n = 1; meta.projectId && n <= (meta.count ?? 1); n++) {
    const task = values[`e${n}_task`]?.lt_task?.selected_option?.value;
    const rawHours = values[`e${n}_hours`]?.value.value;
    const durationError = hoursError(rawHours);
    if (!task) errors[`e${n}_task`] = "Choose a task or type a new one";
    if (durationError) errors[`e${n}_hours`] = durationError;
    if (values[`e${n}_act`] && !values[`e${n}_act`].value.selected_option) errors[`e${n}_act`] = "Choose an activity";
    entries.push({
      projectId: meta.projectId,
      workPackageId: task?.startsWith("wp:") ? Number(task.slice(3)) : null,
      newTask: task?.startsWith("new:") ? task.slice(4).trim() : null,
      subtask: values[`e${n}_sub`]?.value.value?.trim() || null,
      activityId: Number(values[`e${n}_act`]?.value.selected_option?.value) || null,
      hours: parseHours(rawHours),
      spentOn,
      comment: values[`e${n}_notes`]?.value.value ?? "",
    });
  }
  const total = entries.reduce((s, e) => s + (e.hours ?? 0), 0);
  if (!Object.keys(errors).length && total > MAX_HOURS_PER_DAY + 1e-9) {
    errors[`e${entries.length}_hours`] = `These entries add up to ${formatHours(total)}. Max is ${MAX_HOURS_PER_DAY}h a day.`;
  }
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }
  await ack();
  const dm = (msg) => client.chat.postMessage({ channel: body.user.id, ...(typeof msg === "string" ? { text: msg } : msg) });
  try {
    const user = await vynkUser(client, body.user.id);
    await deliver(dm, await logEntries(user, entries));
  } catch (err) {
    if (!(err instanceof UserFacingError)) logger.error("log_time submit failed", err);
    await dm(errorText(err));
  }
});

async function weekHours({ cmd, client, text }) {
  const user = await vynkUser(client, cmd.user_id);
  const weeksBack = /^last/i.test(text) ? 1 : 0;
  const week = currentWeek(TZ, weeksBack);
  const entries = await user.api.timeEntries({ from: week.from, to: week.to, userId: user.id });
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
  const admin = await requireAdmin(client, cmd.user_id);
  const weeksBack = /^last/i.test(text) ? 1 : 0;
  const week = currentWeek(TZ, weeksBack);
  const [entries, users] = await Promise.all([admin.api.timeEntries({ from: week.from, to: week.to }), admin.api.activeUsers()]);
  return teamView({ label: weeksBack ? "Last week" : "This week", week, users, entries });
}

command("/team-hours", teamHours);

// ---------- @vynk menu ----------

const MENU = [
  ["log_time", "Log time"],
  ["week_hours", "My week"],
  ["my_tasks", "My tasks"],
  ["projects", "Projects"],
  ["create_task", "New task"],
];
const ADMIN_MENU = [
  ["create_project", "New project"],
  ["team_hours", "Team hours"],
];

async function menuMessage(client, slackUserId) {
  try {
    const user = await vynkUser(client, slackUserId);
    return menuView(MENU, user.admin ? ADMIN_MENU : [], sessions.enabled ? user.name : null);
  } catch (err) {
    if (err instanceof NotConnectedError || err instanceof NotSignedInError) return connectView(sessions.connectUrl(slackUserId));
    throw err;
  }
}

command("/vynk", async ({ cmd, client, text }) => {
  if (/^(disconnect|logout|sign ?out)$/i.test(text)) {
    await sessions.remove(cmd.user_id);
    meCache.delete(cmd.user_id);
    return "You're signed out of Vynk in Slack. Type `@Vynk` to connect again.";
  }
  return menuMessage(client, cmd.user_id);
});

app.action("connect_vynk", async ({ ack }) => ack());

app.event("app_mention", async ({ event, client, logger }) => {
  try {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...(await menuMessage(client, event.user)),
    });
  } catch (err) {
    logger.error("app_mention failed", err);
  }
});

app.message(async ({ message, say, client, logger }) => {
  if (message.channel_type === "channel" || message.channel_type === "group") {
    await handleEodMessage(message, client).catch((err) => logger.error("EOD handling failed", err));
    return;
  }
  if (message.channel_type !== "im" || message.subtype || message.bot_id) return;
  try {
    await say(await menuMessage(client, message.user));
  } catch (err) {
    logger.error("dm menu failed", err);
  }
});

app.action(/^(vynk_menu|menu_.+)$/, async ({ ack, body, action, client, respond, logger }) => {
  await ack();
  const userId = body.user.id;
  const cmd = { user_id: userId };
  const reply = (r) =>
    deliver(respond, { response_type: "ephemeral", replace_original: false, ...(typeof r === "string" ? { text: r } : r) });
  try {
    switch (action.selected_option?.value ?? action.value) {
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
    await deliver(respond, {
      replace_original: true,
      ...(await weekHours({ cmd: { user_id: body.user.id }, client, text: action.value })),
    });
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

// ---------- EOD reports ----------
// A report posted in an EOD channel becomes a private review card for its author. On approval the
// author adds the time per item and the bot creates/uses tasks and logs the time as them.

const EOD_CHANNELS = (process.env.EOD_CHANNELS || "eod-updates")
  .split(",")
  .map((s) => s.trim().replace(/^#/, "").toLowerCase())
  .filter(Boolean);
const MAX_EOD_ITEMS = 15;
const channelNames = new Map();

async function isEodChannel(client, channelId) {
  if (EOD_CHANNELS.includes(channelId.toLowerCase())) return true;
  if (!channelNames.has(channelId)) {
    const info = await client.conversations.info({ channel: channelId }).catch(() => null);
    channelNames.set(channelId, info?.channel?.name?.toLowerCase() ?? "");
  }
  return EOD_CHANNELS.includes(channelNames.get(channelId));
}

const dateOfTs = (ts) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Number(ts) * 1000));
const permalink = (channel, ts) => `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;

async function handleEodMessage(message, client) {
  const msg = message.subtype === "message_changed" ? { ...message.message, channel: message.channel } : message;
  if (!msg?.user || msg.bot_id || (msg.subtype && !["file_share", "thread_broadcast"].includes(msg.subtype))) return;
  if (msg.thread_ts && msg.thread_ts !== msg.ts && msg.subtype !== "thread_broadcast") return;
  const text = cleanSlackText(msg.text ?? "").trim();
  if (text.length < 15) return;
  if (!(await isEodChannel(client, msg.channel))) return;
  if (!(await store.firstTime(`${msg.channel}:${msg.ts}`))) return;
  await startEodReview(client, { slackUserId: msg.user, channel: msg.channel, ts: msg.ts, text, createdAt: Date.now() });
}

/** The LLM decides what the report contains; the rule-based parser is only a fallback. */
async function readEod({ user, report, mine }) {
  const all = await cached("projects:all", 5 * 60_000, () => op.projects());
  const projects = all.map((p) => ({ ...p, member: mine.has(p.id) }));
  for (const p of mine.values()) if (!projects.some((x) => x.id === p.id)) projects.push({ ...p, member: true });
  const today = dateOfTs(report.ts);

  if (eodReader.enabled) {
    const text = ` ${normalize(report.text)} `;
    const named = [...mine.values()].filter((p) => [p.name, p.identifier].some((k) => normalize(k) && text.includes(` ${normalize(k)} `)));
    const candidates = (named.length ? named : mine.size <= 5 ? [...mine.values()] : []).slice(0, 10);
    const tasks = [];
    for (const p of candidates) {
      const list = await cached(`tasks:${user.id}:${p.id}`, 30_000, () => user.api.projectTasks(p.id)).catch(() => []);
      tasks.push(...list.slice(0, 60).map((t) => ({ id: t.id, subject: t.subject, projectId: p.id })));
    }
    try {
      return await eodReader.read({ text: report.text, projects, tasks, today });
    } catch (err) {
      app.logger.error("LLM could not read the EOD, using the rule-based parser", err);
    }
  }

  const parsed = parseEod(report.text, projects, { today, inEodChannel: true });
  return {
    isEod: parsed.isEod,
    date: parsed.date,
    items: [
      ...parsed.sections.flatMap((s) =>
        s.items.map((i) => ({ projectId: s.project?.id ?? null, mention: s.heading, title: i.text, hours: i.hours, notes: "" })),
      ),
      ...parsed.unassigned.map((i) => ({ projectId: null, mention: "", title: i.text, hours: i.hours, notes: "" })),
    ],
  };
}

async function startEodReview(client, report) {
  const dm = (msg) => client.chat.postMessage({ channel: report.slackUserId, ...msg });
  const link = `<${permalink(report.channel, report.ts)}|EOD>`;
  let user;
  try {
    user = await vynkUser(client, report.slackUserId);
  } catch (err) {
    if (err instanceof NotConnectedError || err instanceof NotSignedInError) {
      store.data.waiting[report.slackUserId] = report;
      await store.save();
      await dm(eodConnectView({ url: sessions.connectUrl(report.slackUserId), source: link }));
      return;
    }
    if (err instanceof UserFacingError) {
      await dm({ text: `I saw your ${link} but couldn't log it: ${err.message}` });
      return;
    }
    throw err;
  }

  const mine = new Map((await user.api.projectsFor(user)).map((p) => [p.id, p]));
  const result = await readEod({ user, report, mine });
  if (!result.isEod) return;
  const date = result.date && result.date <= dateOfTs(report.ts) ? result.date : dateOfTs(report.ts);

  const all = await cached("projects:all", 5 * 60_000, () => op.projects());
  const items = [];
  const noAccess = new Set();
  const unmatched = [];
  for (const item of result.items) {
    if (!item.projectId) unmatched.push(item.mention ? `${item.mention}: ${item.title}` : item.title);
    else if (!mine.has(item.projectId)) noAccess.add(all.find((p) => p.id === item.projectId)?.name ?? item.mention);
    else items.push({ ...item, text: item.title, projectName: mine.get(item.projectId).name });
  }

  if (!items.length) {
    await dm(eodNothingView({ source: link, noAccess: [...noAccess], unmatched, date }));
    return;
  }

  const extra = Math.max(0, items.length - MAX_EOD_ITEMS);
  const shown = items.slice(0, MAX_EOD_ITEMS);
  for (const projectId of new Set(shown.filter((i) => !i.taskId).map((i) => i.projectId))) {
    const tasks = await cached(`tasks:${user.id}:${projectId}`, 30_000, () => user.api.projectTasks(projectId)).catch(() => []);
    for (const item of shown.filter((i) => i.projectId === projectId && !i.taskId)) {
      const task = matchTask(item.text, tasks);
      if (task) Object.assign(item, { taskId: task.id, taskSubject: task.subject });
    }
  }

  const review = {
    id: crypto.randomUUID(),
    slackUserId: report.slackUserId,
    channel: report.channel,
    ts: report.ts,
    date,
    items: shown,
    noAccess: [...noAccess],
    unmatched,
    extra,
    status: "pending",
    createdAt: Date.now(),
  };
  const posted = await dm(eodReviewView({ review, source: link, urls }));
  Object.assign(review, { dmChannel: posted.channel, dmTs: posted.ts });
  store.data.reviews[review.id] = review;
  await store.save();
}

app.action("eod_review", async ({ ack, body, action, client }) => {
  await ack();
  const review = store.data.reviews[action.value];
  await openForm(client, body.trigger_id, "Log your EOD", async () => {
    if (!review) throw new UserFacingError("This EOD review has expired. Post a new EOD or use Log time.");
    if (review.status !== "pending") throw new UserFacingError("You've already logged this EOD.");
    if (review.slackUserId !== body.user.id) throw new UserFacingError("This EOD belongs to someone else.");
    const user = await vynkUser(client, body.user.id);
    const activities = new Map();
    for (const projectId of new Set(review.items.map((i) => i.projectId))) {
      activities.set(projectId, await cached(`activities:${user.id}:${projectId}`, 300_000, () => user.api.activities(projectId)));
    }
    const blocks = [
      input("date", "Date", { type: "datepicker", initial_date: review.date }),
      { type: "context", elements: [{ type: "mrkdwn", text: "Add the time you spent on each item. Leave it empty to skip an item." }] },
    ];
    review.items.forEach((item, index) => {
      const n = index + 1;
      const acts = activities.get(item.projectId) ?? [];
      blocks.push(
        { type: "divider" },
        { type: "context", elements: [{ type: "mrkdwn", text: `*${escape(item.projectName)}*  ·  ${escape(item.text).slice(0, 150)}` }] },
        {
          type: "input",
          block_id: `e${n}_task`,
          label: plain("Task"),
          element: {
            type: "external_select",
            action_id: "lt_task",
            min_query_length: 0,
            placeholder: plain("Search or type a new task"),
            initial_option: item.taskId
              ? option(item.taskSubject, `wp:${item.taskId}`)
              : option(`+ New task: ${item.text}`, `new:${item.text}`),
          },
        },
        input(
          `e${n}_hours`,
          "Time spent",
          {
            type: "plain_text_input",
            placeholder: plain("e.g. 2h, 1h30m or 1.5"),
            ...(item.hours ? { initial_value: formatHours(item.hours).replace(" ", "") } : {}),
          },
          true,
        ),
        ...(acts.length
          ? [
              input(
                `e${n}_act`,
                "Activity",
                { type: "static_select", placeholder: plain("What kind of work?"), options: acts.map((a) => option(a.name, a.id)) },
                true,
              ),
            ]
          : []),
      );
    });
    return {
      callbackId: "eod_log",
      submit: "Log time",
      blocks,
      privateMetadata: JSON.stringify({ reviewId: review.id, entries: review.items.map((i) => ({ projectId: i.projectId })) }),
    };
  });
});

app.view("eod_log", async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const meta = JSON.parse(view.private_metadata || "{}");
  const review = store.data.reviews[meta.reviewId];
  const spentOn = values.date?.value.selected_date;
  const errors = {};
  const entries = [];
  (meta.entries ?? []).forEach(({ projectId }, index) => {
    const n = index + 1;
    const raw = values[`e${n}_hours`]?.value.value?.trim();
    if (!raw) return;
    const task = values[`e${n}_task`]?.lt_task?.selected_option?.value;
    const durationError = hoursError(raw);
    if (durationError) errors[`e${n}_hours`] = durationError;
    if (!task) errors[`e${n}_task`] = "Choose a task or type a new one";
    if (values[`e${n}_act`] && !values[`e${n}_act`].value.selected_option) errors[`e${n}_act`] = "Choose an activity";
    entries.push({
      n,
      projectId,
      workPackageId: task?.startsWith("wp:") ? Number(task.slice(3)) : null,
      newTask: task?.startsWith("new:") ? task.slice(4).trim() : null,
      activityId: Number(values[`e${n}_act`]?.value.selected_option?.value) || null,
      hours: parseHours(raw),
      spentOn,
      comment: review?.items[index]?.notes || review?.items[index]?.text || "",
    });
  });
  if (!review || review.status !== "pending") errors.date = "This EOD was already logged or has expired.";
  else if (!entries.length) errors.e1_hours = "Add time to at least one item";
  const total = entries.reduce((s, e) => s + (e.hours ?? 0), 0);
  if (!Object.keys(errors).length && total > MAX_HOURS_PER_DAY + 1e-9) {
    errors[`e${entries.at(-1).n}_hours`] = `These add up to ${formatHours(total)}. Max is ${MAX_HOURS_PER_DAY}h a day.`;
  }
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }
  await ack();
  review.status = "logging";
  const dm = (msg) => client.chat.postMessage({ channel: body.user.id, ...(typeof msg === "string" ? { text: msg } : msg) });
  try {
    const user = await vynkUser(client, body.user.id);
    const result = await logEntries(user, entries);
    const ok = typeof result !== "string" && !result.failed;
    review.status = ok ? "done" : "pending";
    await store.save();
    if (ok && review.dmChannel) {
      await client.chat
        .update({
          channel: review.dmChannel,
          ts: review.dmTs,
          ...eodDoneView({ entries, source: `<${permalink(review.channel, review.ts)}|EOD>` }),
        })
        .catch((err) => logger.warn(`could not update EOD card: ${err.message}`));
    }
    await deliver(dm, typeof result === "string" ? { text: result } : result);
  } catch (err) {
    review.status = "pending";
    await store.save();
    if (!(err instanceof UserFacingError)) logger.error("eod_log failed", err);
    await dm(errorText(err));
  }
});

app.action("eod_dismiss", async ({ ack, body, action, client }) => {
  await ack();
  const review = store.data.reviews[action.value];
  if (review && review.slackUserId === body.user.id && review.status === "pending") {
    delete store.data.reviews[action.value];
    await store.save();
  }
  await client.chat
    .update({ channel: body.channel.id, ts: body.message.ts, text: "EOD dismissed", blocks: eodDismissedView().blocks })
    .catch(() => null);
});

// Sign-in callback (proxied from https://<vynk>/__slack/ by the nginx in front of Vynk).
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const send = (status, page) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(resultPage(page));
  };
  if (url.pathname === "/__slack/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (url.pathname !== "/__slack/oauth/callback") {
    res.writeHead(404).end("Not found");
    return;
  }
  if (url.searchParams.get("error")) {
    send(400, { ok: false, title: "Sign-in cancelled", message: "Nothing was connected. You can close this tab." });
    return;
  }
  try {
    const { slackUserId, tokens } = await sessions.complete(url.searchParams.get("state"), url.searchParams.get("code"));
    const me = await new OpenProject({ baseUrl: BASE_URL, token: async () => tokens.accessToken }).me();
    const slackMail = (await slackEmail(app.client, slackUserId))?.toLowerCase();
    if (!me.email || me.email.toLowerCase() !== slackMail) {
      send(403, {
        ok: false,
        title: "Accounts don't match",
        message: `You signed in to Vynk as ${me.email ?? me.name}, but your Slack email is ${slackMail ?? "hidden"}. Sign in with the same email.`,
      });
      return;
    }
    await sessions.store(slackUserId, {
      ...tokens,
      vynkUserId: me.id,
      name: me.name,
      email: me.email,
      connectedAt: new Date().toISOString(),
    });
    meCache.delete(slackUserId);
    const waiting = store.data.waiting[slackUserId];
    if (waiting) {
      delete store.data.waiting[slackUserId];
      await store.save();
    }
    send(200, { ok: true, title: "You're connected", message: `Signed in as ${me.name}. You can close this tab and go back to Slack.` });
    await app.client.chat
      .postMessage({ channel: slackUserId, text: `Connected as ${me.name}`, ...(await menuMessage(app.client, slackUserId)) })
      .catch((err) => app.logger.warn(`welcome DM failed: ${err.message}`));
    if (waiting) await startEodReview(app.client, waiting).catch((err) => app.logger.error("EOD review after sign-in failed", err));
  } catch (err) {
    app.logger.error("oauth callback failed", err);
    send(400, { ok: false, title: "Couldn't connect", message: err.message || "Please try again from Slack." });
  }
});

await sessions.load();
await store.load();
server.listen(Number(process.env.PORT || 3000));
await app.start();
startReminderLoop();
app.logger.info(`Vynk Slack bot running (Socket Mode) → ${BASE_URL}`);
