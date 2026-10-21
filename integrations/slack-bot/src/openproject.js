// Minimal OpenProject API v3 client: either the service account (API key) or a signed-in user (OAuth token).

import { fromIsoDuration, toIsoDuration } from "./time.js";

export class OpenProjectError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const filters = (list) => encodeURIComponent(JSON.stringify(list));
const idFromHref = (href) => (href ? Number(String(href).split("/").pop()) : null);

export class NotSignedInError extends Error {}

export class OpenProject {
  constructor({ baseUrl, apiKey, token }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKeyAuth = apiKey ? `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}` : null;
    this.token = token;
    this.userCache = new Map();
  }

  async authHeader(force = false) {
    if (this.apiKeyAuth) return this.apiKeyAuth;
    const token = await this.token({ force });
    if (!token) throw new NotSignedInError("Not signed in to Vynk");
    return `Bearer ${token}`;
  }

  async request(method, path, body, retried = false) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: await this.authHeader(retried), Accept: "application/hal+json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && this.token && !retried) return this.request(method, path, body, true);
    if (res.status === 401 && this.token) throw new NotSignedInError("Vynk sign-in expired");
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    if (!res.ok) {
      const detail = data?._embedded?.errors?.map((e) => e.message).join("; ");
      throw new OpenProjectError(detail || data?.message || `${res.status} ${res.statusText}`, res.status, data);
    }
    return data;
  }

  me() {
    return this.request("GET", "/api/v3/users/me");
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  // ---------- users ----------
  async userByEmail(email) {
    const key = email.toLowerCase();
    const cached = this.userCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.user;
    const data = await this.request(
      "GET",
      `/api/v3/users?pageSize=50&filters=${filters([{ any_name_attribute: { operator: "~", values: [email] } }])}`,
    );
    const user = (data?._embedded?.elements ?? []).find((u) => (u.email ?? "").toLowerCase() === key) ?? null;
    this.userCache.set(key, { user, expires: Date.now() + 10 * 60 * 1000 });
    return user;
  }

  async activeUsers() {
    const data = await this.request(
      "GET",
      `/api/v3/users?pageSize=500&filters=${filters([{ status: { operator: "=", values: ["active"] } }])}`,
    );
    return data?._embedded?.elements ?? [];
  }

  // ---------- projects ----------
  async projects() {
    const data = await this.request(
      "GET",
      `/api/v3/projects?pageSize=200&sortBy=${encodeURIComponent('[["name","asc"]]')}&filters=${filters([
        { active: { operator: "=", values: ["t"] } },
      ])}`,
    );
    return data?._embedded?.elements ?? [];
  }

  async projectsFor(user) {
    if (user.admin) return this.projects();
    const data = await this.request(
      "GET",
      `/api/v3/projects?pageSize=200&sortBy=${encodeURIComponent('[["name","asc"]]')}&filters=${filters([
        { active: { operator: "=", values: ["t"] } },
        { principal: { operator: "=", values: [String(user.id)] } },
      ])}`,
    );
    return data?._embedded?.elements ?? [];
  }

  async findProject(nameOrIdentifier) {
    const needle = String(nameOrIdentifier ?? "")
      .trim()
      .toLowerCase();
    if (!needle) return null;
    const all = await this.projects();
    return (
      all.find((p) => p.identifier.toLowerCase() === needle || p.name.toLowerCase() === needle) ??
      all.find((p) => p.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  async createProject(name, { parentId } = {}) {
    const identifier = name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90);
    return this.request("POST", "/api/v3/projects", {
      name,
      identifier: identifier || undefined,
      public: false,
      ...(parentId ? { _links: { parent: { href: `/api/v3/projects/${parentId}` } } } : {}),
    });
  }

  updateProject(id, body) {
    return this.request("PATCH", `/api/v3/projects/${id}`, body);
  }

  setParent(id, parentId) {
    return this.updateProject(id, { _links: { parent: { href: parentId ? `/api/v3/projects/${parentId}` : null } } });
  }

  /** Key of a "Client" project attribute if an admin created one (e.g. "customField3"), else null. */
  async clientFieldKey() {
    const schema = await this.request("GET", "/api/v3/projects/schema");
    return (
      Object.entries(schema ?? {}).find(([k, v]) => k.startsWith("customField") && /^client(\s*name)?$/i.test(v?.name ?? ""))?.[0] ?? null
    );
  }

  async addMember({ projectId, userId, roleName = "Project admin" }) {
    const data = await this.request("GET", "/api/v3/roles");
    const roles = (data?._embedded?.elements ?? []).filter((r) => !/non member|anonymous/i.test(r.name));
    const role = roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) ?? roles.find((r) => /admin/i.test(r.name)) ?? roles[0];
    if (!role) return null;
    return this.request("POST", "/api/v3/memberships", {
      _links: {
        principal: { href: `/api/v3/users/${userId}` },
        project: { href: `/api/v3/projects/${projectId}` },
        roles: [{ href: role._links.self.href }],
      },
    });
  }

  /** Ids of projects where the user may do any of the given actions (e.g. "time_entries/create_own"). */
  async capabilityProjects(userId, actions) {
    const data = await this.request(
      "GET",
      `/api/v3/capabilities?pageSize=1000&filters=${filters([
        { principal: { operator: "=", values: [String(userId)] } },
        { action: { operator: "=", values: actions } },
      ])}`,
    );
    const ids = new Set();
    for (const c of data?._embedded?.elements ?? []) {
      const href = c._links?.context?.href ?? "";
      if (href.includes("/projects/")) ids.add(idFromHref(href));
    }
    return ids;
  }

  /** Roles that can be given to project members (e.g. Project admin, Member, Reader). */
  async projectRoles() {
    const data = await this.request(
      "GET",
      `/api/v3/roles?filters=${filters([{ grantable: { operator: "=", values: ["t"] } }, { unit: { operator: "=", values: ["project"] } }])}`,
    ).catch(() => this.request("GET", "/api/v3/roles"));
    return (data?._embedded?.elements ?? []).filter((r) => !/non member|anonymous/i.test(r.name)).map((r) => ({ id: r.id, name: r.name }));
  }

  /** Members of the given projects: [{ id, projectId, userId, name, roles: [names] }]. */
  async memberships(projectIds) {
    if (!projectIds.length) return [];
    const data = await this.request(
      "GET",
      `/api/v3/memberships?pageSize=1000&filters=${filters([{ project: { operator: "=", values: projectIds.map(String) } }])}`,
    );
    return (data?._embedded?.elements ?? []).map((m) => ({
      id: m.id,
      projectId: idFromHref(m._links?.project?.href),
      userId: idFromHref(m._links?.principal?.href),
      name: m._links?.principal?.title ?? "Unknown",
      roles: (m._links?.roles ?? []).map((r) => r.title),
    }));
  }

  addMembership({ projectId, userId, roleId }) {
    return this.request("POST", "/api/v3/memberships", {
      _links: {
        principal: { href: `/api/v3/users/${userId}` },
        project: { href: `/api/v3/projects/${projectId}` },
        roles: [{ href: `/api/v3/roles/${roleId}` }],
      },
    });
  }

  /** Creates an invited user (Vynk emails them an invitation). Needs admin rights. */
  inviteUser({ email, firstName, lastName }) {
    return this.request("POST", "/api/v3/users", { email, login: email, firstName, lastName, status: "invited" });
  }

  // ---------- work packages ----------
  async taskType(projectId) {
    const data = await this.request("GET", `/api/v3/projects/${projectId}/types`);
    const types = data?._embedded?.elements ?? [];
    return types.find((t) => t.name.toLowerCase() === "task") ?? types[0] ?? null;
  }

  async createTask({ projectId, subject, assigneeId, description, parentId }) {
    const type = await this.taskType(projectId);
    const links = {};
    if (type) links.type = { href: type._links.self.href };
    if (parentId) links.parent = { href: `/api/v3/work_packages/${parentId}` };
    const create = (withAssignee) =>
      this.request("POST", `/api/v3/projects/${projectId}/work_packages`, {
        subject,
        ...(description ? { description: { raw: description } } : {}),
        _links: withAssignee && assigneeId ? { ...links, assignee: { href: `/api/v3/users/${assigneeId}` } } : links,
      });
    try {
      return await create(true);
    } catch (err) {
      // Assignee must be a project member; still create the task, just unassigned.
      if (!assigneeId || err.data?._embedded?.details?.attribute !== "assignee") throw err;
      const wp = await create(false);
      wp.assigneeSkipped = true;
      return wp;
    }
  }

  async workPackage(id) {
    return this.request("GET", `/api/v3/work_packages/${id}`);
  }

  async openTasksFor(userId, limit = 15) {
    const data = await this.request(
      "GET",
      `/api/v3/work_packages?pageSize=${limit}&sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}&filters=${filters([
        { assignee: { operator: "=", values: [String(userId)] } },
        { status: { operator: "o", values: [] } },
      ])}`,
    );
    return data?._embedded?.elements ?? [];
  }

  async taskPicker(userId, limit = 100) {
    const data = await this.request(
      "GET",
      `/api/v3/work_packages?pageSize=${limit}&select=total,elements/id,elements/subject&sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}&filters=${filters(
        [{ assignee: { operator: "=", values: [String(userId)] } }, { status: { operator: "o", values: [] } }],
      )}`,
    );
    return data?._embedded?.elements ?? [];
  }

  async projectTasks(projectId, limit = 100) {
    const data = await this.request(
      "GET",
      `/api/v3/projects/${projectId}/work_packages?pageSize=${limit}&select=total,elements/id,elements/subject&sortBy=${encodeURIComponent(
        '[["updatedAt","desc"]]',
      )}&filters=${filters([{ status: { operator: "o", values: [] } }])}`,
    );
    return data?._embedded?.elements ?? [];
  }

  async activities(projectId) {
    const form = await this.request("POST", "/api/v3/time_entries/form", {
      _links: { project: { href: `/api/v3/projects/${projectId}` } },
    });
    return (form?._embedded?.schema?.activity?._embedded?.allowedValues ?? []).map((a) => ({ id: a.id, name: a.name }));
  }

  // ---------- time ----------
  async logTime({ userId, workPackageId, hours, spentOn, comment, activityId }) {
    const body = {
      hours: toIsoDuration(hours),
      spentOn,
      comment: { raw: comment ?? "" },
      _links: {
        user: { href: `/api/v3/users/${userId}` },
        workPackage: { href: `/api/v3/work_packages/${workPackageId}` },
        ...(activityId ? { activity: { href: `/api/v3/time_entries/activities/${activityId}` } } : {}),
      },
    };
    try {
      return await this.request("POST", "/api/v3/time_entries", body);
    } catch (err) {
      // Some setups require an activity: pick the first allowed one from the form and retry.
      if (err.status !== 422 || !/activity/i.test(err.message)) throw err;
      const form = await this.request("POST", "/api/v3/time_entries/form", body);
      const activity = form?._embedded?.schema?.activity?._embedded?.allowedValues?.[0];
      if (!activity) throw err;
      body._links.activity = { href: activity._links.self.href };
      return this.request("POST", "/api/v3/time_entries", body);
    }
  }

  // Filtering by person happens here, not in Vynk: Members get "User filter has invalid values" for it.
  async timeEntries({ from, to, userId }) {
    const list = [{ spent_on: { operator: "<>d", values: [from, to] } }];
    const data = await this.request("GET", `/api/v3/time_entries?pageSize=1000&filters=${filters(list)}`);
    return (data?._embedded?.elements ?? [])
      .map((e) => ({
        hours: fromIsoDuration(e.hours),
        spentOn: e.spentOn,
        userId: idFromHref(e._links?.user?.href),
        userName: e._links?.user?.title,
        workPackageId: idFromHref(e._links?.workPackage?.href ?? e._links?.entity?.href),
        workPackageTitle: e._links?.workPackage?.title ?? e._links?.entity?.title,
        projectId: idFromHref(e._links?.project?.href),
        projectTitle: e._links?.project?.title,
        comment: e.comment?.raw ?? "",
      }))
      .filter((e) => !userId || e.userId === Number(userId));
  }
}
