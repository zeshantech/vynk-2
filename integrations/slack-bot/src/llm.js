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
    title: { type: "string", description: "Short task title in sentence case, max 80 chars (e.g. 'Deploy backend to production')." },
    existing_task_id: {
      type: ["integer", "null"],
      description: "id of an existing open task from the list that is clearly the same work, else null.",
    },
    hours: {
      type: ["number", "null"],
      description: "Time spent in hours only if the message states it for this item, else null. Never guess.",
    },
    notes: { type: "string", description: "Extra detail worth keeping as the time entry comment (may be empty)." },
    date: {
      type: ["string", "null"],
      description:
        "Day this item was done as YYYY-MM-DD: the date heading it is listed under (e.g. 'Monday, October 12, 2026'), else null.",
    },
  },
  required: ["project_id", "project_mention", "title", "existing_task_id", "hours", "notes", "date"],
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
    items: { type: "array", description: "Each distinct piece of work DONE (not planned, not blockers).", items: ITEM_SCHEMA },
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

const SYSTEM = `You turn Slack end-of-day (EOD) reports into time-tracking items for a project management tool.
Rules:
- Only include work that was done. Skip plans for tomorrow, blockers, questions, greetings and meetings with no project unless they clearly belong to a project.
- If the message names a project explicitly (a heading like "PRI:", a prefix, the project name, identifier or an obvious abbreviation), ALWAYS use that project, even when author_is_member is false. author_is_member is informational only; never move work to a different project because of it.
- Otherwise map each item to a project from the list using project names, identifiers, abbreviations, the project's client and its parent company.
  Example: "chris to debug its intelligence app" belongs to the project whose client is Chris and whose name mentions intelligence, not to another Chris project.
  Work for a company in general (not a specific product) belongs to the parent company's own project.
  If several projects fit equally, or none fits, use null.
- Prefer an existing task when it is clearly the same work; otherwise null so a new task is created.
- Do not invent hours. Only copy durations written in the message. A duration written on a project heading, a day heading or the report title belongs in hours_groups, not on the items.
- Reports may cover several days. Give every item the date of the day heading it is listed under.
- Keep titles short and clean (no bullets, emojis, links or durations).`;

export class EodReader {
  constructor({ apiKey, model }) {
    this.model = model;
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
      open_tasks: tasks.map((t) => ({ id: t.id, project_id: t.projectId, title: t.subject })),
    };
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      max_completion_tokens: 12000,
      response_format: { type: "json_schema", json_schema: { name: "eod_report", strict: true, schema: RESULT_SCHEMA } },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Context (JSON):\n${JSON.stringify(context)}\n\nSlack message:\n<<<\n${text.slice(0, 8000)}\n>>>` },
      ],
    });
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned no result");
    return sanitize(JSON.parse(content), projects, tasks);
  }
}

/** Never trust ids or numbers from the model blindly. */
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
        notes: String(i.notes ?? "").slice(0, 500),
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
