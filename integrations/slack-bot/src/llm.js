// An LLM on GroqCloud reads an EOD message and decides what was worked on, for which project and how long.

import Groq from "groq-sdk";

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    project_id: {
      type: ["integer", "null"],
      description: "id of the project from the provided list this work belongs to, or null if none fits.",
    },
    project_mention: { type: "string", description: "How the message referred to the project (empty if not mentioned)." },
    title: {
      type: "string",
      description:
        "Professional task title in sentence case, max 80 chars, that names the outcome (e.g. 'Update signup and login button colours'). Never a copy of the author's wording.",
    },
    description: {
      type: "string",
      description:
        "1-3 plain sentences saying what was done and why it matters, written for a teammate. Empty string when the title says it all.",
    },
    subtasks: {
      type: "array",
      description:
        "Distinct parts of a bigger task worth tracking separately, each a short title. Empty for small tasks or when parts are just details of one change.",
      items: { type: "string" },
    },
    existing_task_id: {
      type: ["integer", "null"],
      description: "id of an existing open task from the list that is clearly the same work, else null.",
    },
    hours: {
      type: ["number", "null"],
      description:
        "Hours for this item: the duration written for it, or, when only a total is written for its group (project section, day or whole report), your estimate of this item's share of that total based on how much work it describes. Null when no duration applies at all.",
    },
    hours_estimated: {
      type: "boolean",
      description: "True when hours is your estimated share of a group total, false when written for the item or null.",
    },
    notes: { type: "string", description: "One short line for the time entry comment: what was done in this time (may be empty)." },
    date: {
      type: ["string", "null"],
      description:
        "Day this item was done as YYYY-MM-DD: the date heading it is listed under (e.g. 'Monday, October 12, 2026'), else null.",
    },
  },
  required: [
    "project_id",
    "project_mention",
    "title",
    "description",
    "subtasks",
    "existing_task_id",
    "hours",
    "hours_estimated",
    "notes",
    "date",
  ],
};

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_eod: {
      type: "boolean",
      description:
        "True only if the message reports work the author did (end-of-day / daily update). False for chit-chat, questions, announcements or plans only.",
    },
    date: { type: ["string", "null"], description: "Day the work was done as YYYY-MM-DD if the message states one, else null." },
    items: {
      type: "array",
      description:
        "The TASKS the author worked on, as a project manager would track them. Related lines are ONE task. Not planned work, not blockers.",
      items: ITEM_SCHEMA,
    },
    hours_groups: {
      type: "array",
      description:
        "Durations written for a group of items rather than one item: a project section ('PRI ~5hrs:'), a day ('Monday 8h') or the whole report ('Oct 12-16, 40h').",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          project_id: { type: ["integer", "null"], description: "Project the duration is for, or null if it spans projects." },
          date: { type: ["string", "null"], description: "Day (YYYY-MM-DD) the duration is for, or null if it spans days." },
          hours: { type: "number", description: "Total hours written for that group." },
        },
        required: ["project_id", "date", "hours"],
      },
    },
  },
  required: ["is_eod", "date", "items", "hours_groups"],
};

const SYSTEM = `You are a careful senior project manager. A teammate posted an end-of-day (EOD) message in Slack. Turn it into the tasks you would record in the team's project tracker, with the time spent.

How to think:
- A task is a unit of work someone would track, not a line of the message. Read the whole message first, then group.
  Lines that are small variations of the same change (for example "change signup button colour" and "change login button colour") are ONE task: "Update signup and login button colours".
  Lines that are different pieces of a larger piece of work (a feature built in several steps) are ONE task with subtasks.
  Unrelated work stays separate tasks.
- Write titles the way a professional would: a short phrase naming the outcome, in sentence case. Do not copy the author's wording, casing, typos or bullet text.
- description: 1-3 plain sentences on what was done, only when it adds something. Otherwise an empty string. Never invent facts that are not in the message.
- subtasks: only when the task has clearly separate parts worth tracking (usually 3 or more lines of one feature). Use short titles; the first subtask must not just repeat the task title. Small tasks have none. At most 6.
  A small unrelated fix (a typo, a config tweak) is its own task, never a subtask of something else.
  A task that has subtasks always gets a description.
- Routine admin with no project value (replying to emails, chatting) is not a task.

Example. Message:
"Vynk: built webhook receiver, added signature check, wrote retry queue, added dead-letter table, wrote tests, fixed typo in readme"
Correct result: TWO tasks.
 1. title "Build webhook delivery pipeline", description "Built the endpoint that receives webhooks, with signature verification, a retry queue for failed deliveries, a dead-letter table and tests.", subtasks ["Webhook receiver with signature check", "Retry queue for failed deliveries", "Dead-letter table", "Tests"]
 2. title "Fix typo in README", description "", subtasks []
Wrong: one task per line, or putting the typo fix under the webhook task.
- notes: one short line for the time entry comment.
- Only include work that was done. Skip plans for tomorrow, blockers, questions, greetings, and meetings with no project unless they clearly belong to a project.

Projects:
- If the message names a project explicitly (a heading like "PRI:", a prefix, the project name, identifier or an obvious abbreviation), ALWAYS use that project, even when author_is_member is false. author_is_member is informational only; never move work to a different project because of it.
- Otherwise map each task to a project from the list using names, identifiers, abbreviations, the project's client and its parent company.
  Example: "chris to debug its intelligence app" belongs to the project whose client is Chris and whose name mentions intelligence, not to another Chris project.
  Work for a company in general (not a specific product) belongs to the parent company's own project.
  If several projects fit equally, or none fits, use null.
- Prefer an existing open task when it is clearly the same work; otherwise null so a new task is created.

Time:
- Never invent time out of nothing: if no duration is written for a task or for any group containing it, hours is null.
- When a total is written for a group (project heading "PRI ~5hrs:", a day, or the report title "Oct 12-16, 40h"), also list it in hours_groups AND give each task in that group an estimated share (hours_estimated=true): bigger or harder work gets more, small work less. Round to 0.25h. The tasks of a group must add up to its total. A total spanning several days with no per-day totals is split evenly across those days first.
- Reports may cover several days. Give every task the date of the day heading it is listed under, or the date written for it. If no date is written anywhere, date is null.`;

export class EodReader {
  constructor({ apiKey, model, tokensPerMinute = 8000 }) {
    this.model = model;
    this.tokensPerMinute = tokensPerMinute;
    this.client = apiKey ? new Groq({ apiKey, timeout: 45_000, maxRetries: 2 }) : null;
  }

  get enabled() {
    return Boolean(this.client);
  }

  /**
   * @param text Slack message (plain text)
   * @param projects [{ id, name, identifier, member }]
   * @param tasks [{ id, projectId, subject }]
   */
  async read({ text, projects, tasks, today }) {
    const context = {
      today,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        identifier: p.identifier,
        parent_company: p.company ?? null,
        client: p.client ?? null,
        author_is_member: p.member,
      })),
      open_tasks: tasks.map((t) => ({ id: t.id, project_id: t.projectId, title: t.subject.slice(0, 80) })),
    };
    const userContent = `Context (JSON):\n${JSON.stringify(context)}\n\nSlack message:\n<<<\n${text.slice(0, 8000)}\n>>>`;
    // Groq counts prompt + max answer against the per-minute token limit, so size the answer to fit under it.
    const promptTokens = Math.ceil((SYSTEM.length + JSON.stringify(RESULT_SCHEMA).length + userContent.length) / 3.2);
    const maxAnswer = Math.max(1500, Math.min(6000, this.tokensPerMinute - promptTokens - 300));
    const request = {
      model: this.model,
      temperature: 0,
      reasoning_effort: this.effort ?? "low",
      max_completion_tokens: maxAnswer,
      response_format: { type: "json_schema", json_schema: { name: "eod_report", strict: true, schema: RESULT_SCHEMA } },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent },
      ],
    };
    let completion;
    for (let attempt = 1; ; attempt++) {
      try {
        completion = await this.client.chat.completions.create(request);
        break;
      } catch (err) {
        // Free Groq plans allow a few thousand tokens per minute: wait for the window and try again.
        const wait = Number(err?.headers?.get?.("retry-after") ?? err?.headers?.["retry-after"] ?? 0);
        const rateLimited = err?.status === 429 || err?.error?.error?.code === "rate_limit_exceeded";
        if (!rateLimited || attempt >= 3 || wait > 120) throw err;
        await new Promise((resolve) => setTimeout(resolve, (wait || 20) * 1000 + 500));
      }
    }
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned no result");
    return sanitize(JSON.parse(content), projects, tasks);
  }
}

/** Never trust ids or numbers from the model blindly. */
const plainWords = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Drops subtasks that just repeat the task title; a single leftover subtask is not worth tracking. */
function tidySubtasks(subtasks, title) {
  const t = plainWords(title);
  const kept = subtasks.filter((x) => plainWords(x) !== t).slice(0, 6);
  return kept.length >= 2 ? kept : [];
}

function sanitize(result, projects, tasks) {
  const projectIds = new Set(projects.map((p) => p.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const items = (Array.isArray(result?.items) ? result.items : [])
    .map((i) => {
      const projectId = projectIds.has(i.project_id) ? i.project_id : null;
      const task = taskById.get(i.existing_task_id);
      const hours = Number(i.hours);
      return {
        projectId,
        mention: String(i.project_mention ?? "").slice(0, 80),
        title: String(i.title ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        taskId: task && task.projectId === projectId ? task.id : null,
        taskSubject: task && task.projectId === projectId ? task.subject : null,
        hours: Number.isFinite(hours) && hours > 0 && hours <= 24 ? Math.round(hours * 100) / 100 : null,
        description: String(i.description ?? "")
          .replace(/[ \t]+/g, " ")
          .trim()
          .slice(0, 1200),
        subtasks: tidySubtasks(
          [
            ...new Set(
              (Array.isArray(i.subtasks) ? i.subtasks : [])
                .map((t) =>
                  String(t ?? "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120),
                )
                .filter((t) => t.length >= 2),
            ),
          ],
          i.title,
        ),
        notes: String(i.notes ?? "").slice(0, 500),
        estimated: Boolean(i.hours_estimated),
        date: typeof i.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : null,
      };
    })
    .filter((i) => i.title.length >= 2);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(result?.date ?? "") ? result.date : null;
  const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const hoursGroups = (Array.isArray(result?.hours_groups) ? result.hours_groups : [])
    .filter((g) => (g.project_id === null || projectIds.has(g.project_id)) && Number(g.hours) > 0 && Number(g.hours) <= 24 * 31)
    .map((g) => ({
      projectId: g.project_id ?? null,
      date: isDate(g.date) ? g.date : null,
      hours: Math.round(Number(g.hours) * 100) / 100,
    }));
  return { isEod: Boolean(result?.is_eod) && items.length > 0, date, items, hoursGroups };
}
