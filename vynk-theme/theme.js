// Vynk UI behaviour tweaks for OpenProject (UI only, no core changes).

// Click a work package row -> open the details side panel (like Linear/Jira).
// Ctrl/Cmd/Shift clicks keep OpenProject's multi-select behaviour.
document.addEventListener(
  "click",
  (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

    const row = event.target.closest("tr.wp--row[data-work-package-id]");
    if (!row) return;

    const interactive = event.target.closest(
      "a, button, input, select, textarea, label, [contenteditable='true'], " +
        ".inline-edit--active-field, .wp-table--drag-and-drop-handle, .wp-table--hierarchy-indicator, " +
        ".wp-table--hierarchy-span, .wp-table--checkbox, .wp-table-context-menu-icon"
    );
    if (interactive && !interactive.classList.contains("inline-edit--display-field")) return;

    const detailsLink = row.querySelector("a.wp-table--details-link");
    if (!detailsLink) return;

    event.preventDefault();
    event.stopPropagation();
    detailsLink.click();
  },
  true
);

// Move the project switcher from the sidebar into the header, next to the logo.
function vkMoveProjectSwitcher() {
  const trigger = document.querySelector("#main-menu #projects-menu");
  const headerStart = document.querySelector(".op-app-header--start");
  if (!trigger || !headerStart || document.querySelector(".op-app-header .vk-header-project:not(.Overlay *)")) return;

  const block = trigger.closest(".overflow-hidden") || trigger.parentElement;
  const slot = document.createElement("div");
  slot.className = "vk-header-project";
  slot.appendChild(block);

  const logo = [...headerStart.querySelectorAll(":scope > .op-logo, :scope > * > .op-logo")].find(
    (el) => !el.closest(".Overlay") && el.getBoundingClientRect().width > 0
  );
  if (logo) logo.after(slot);
  else headerStart.appendChild(slot);
}

["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((evt) => document.addEventListener(evt, vkMoveProjectSwitcher));
new MutationObserver(vkMoveProjectSwitcher).observe(document.documentElement, { childList: true, subtree: true });
vkMoveProjectSwitcher();

// ---- Sidebar: expanded / collapsed (icon rail) toggle, remembered across pages ----
(function vkSidebar() {
  const KEY = "vk-sidebar";
  const root = document.documentElement;
  try { if (localStorage.getItem(KEY) === "collapsed") root.classList.add("vk-sb-collapsed"); } catch (e) {}

  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

  function ensureToggle() {
    const start = document.querySelector(".op-app-header--start");
    if (!start || start.querySelector(".vk-sb-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vk-sb-toggle";
    btn.title = "Toggle sidebar";
    btn.setAttribute("aria-label", "Toggle sidebar");
    btn.innerHTML = ICON;
    btn.addEventListener("click", () => {
      if (window.matchMedia("(min-width: 900px)").matches) {
        const collapsed = root.classList.toggle("vk-sb-collapsed");
        try { localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded"); } catch (e) {}
        return;
      }
      const hidden = document.querySelector("#main")?.classList.contains("hidden-navigation");
      document.querySelector(hidden ? "#menu-toggle--expand-button" : "#menu-toggle--collapse-button")?.click();
    });
    start.insertBefore(btn, start.querySelector(".op-app-menu") || start.firstChild);
  }

  // tooltips for the icon rail: copy each item's label into a native title
  function labelItems() {
    document.querySelectorAll("#main-menu .op-menu--item-action").forEach((a) => {
      const t = a.querySelector(".op-menu--item-title");
      if (t && !a.title) a.title = t.textContent.trim();
    });
  }

  function tick() { ensureToggle(); labelItems(); }
  ["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, tick));
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  tick();
})();

// ---- Sidebar brand: Vynk wordmark at the top of the sidebar (links home) ----
function vkSidebarBrand() {
  const sidebar = document.querySelector("#main-menu #menu-sidebar");
  if (!sidebar || sidebar.querySelector(".vk-sb-brand")) return;
  const home = document.querySelector(".op-app-header a.op-logo--link")?.getAttribute("href") || "/";
  const brand = document.createElement("div");
  brand.className = "vk-sb-brand";
  brand.innerHTML = '<a class="vk-brand-logo" aria-label="Home"></a>';
  brand.querySelector("a").href = home;
  sidebar.prepend(brand);
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkSidebarBrand));
new MutationObserver(vkSidebarBrand).observe(document.documentElement, { childList: true, subtree: true });
vkSidebarBrand();

// ---- Inline submenus: clicking the chevron of an open item collapses it again ----
document.addEventListener(
  "click",
  (event) => {
    const toggler = event.target.closest("#main-menu .main-menu-toggler");
    if (!toggler) return;
    const li = toggler.closest("li");
    if (!li || !li.classList.contains("open")) return;
    const back = li.querySelector(".main-menu--arrow-left-to-project");
    if (!back) return;
    event.preventDefault();
    event.stopPropagation();
    back.click();
  },
  true
);

// Inline submenus: load the open submenu's lazy frame right away (it may have no size to be "seen" yet)
function vkLoadOpenSubmenus() {
  document.querySelectorAll('#main-menu li.open > ul.main-menu--children turbo-frame[loading="lazy"]').forEach((f) => {
    f.setAttribute("loading", "eager");
  });
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkLoadOpenSubmenus));
new MutationObserver(vkLoadOpenSubmenus).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
vkLoadOpenSubmenus();

// Brand text on signed-out account pages: "OpenProject" -> "Vynk" in the page heading
function vkBrandText() {
  document
    .querySelectorAll("body.controller-account .op-account-registration--subtitle, body.controller-account #content-body h1, body.controller-account #login-form h1")
    .forEach((el) => {
      if (el.textContent.includes("OpenProject")) el.textContent = el.textContent.replace(/OpenProject/g, "Vynk");
    });
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkBrandText));
vkBrandText();

// Simple sign-in error: replace OpenProject's long "blocked due to multiple failed attempts" text
function vkSimpleLoginError() {
  if (!document.body.classList.contains("controller-account")) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (/Invalid user or password/i.test(node.nodeValue) && node.nodeValue !== "Invalid username or password.") {
      node.nodeValue = "Invalid username or password.";
    }
  }
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkSimpleLoginError));
new MutationObserver(vkSimpleLoginError).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
vkSimpleLoginError();

// Dark mode is disabled for now (the proxy serves every page in light mode). Keep the options in
// My account → Interface but greyed out, so a saved Dark/Sync choice falls back to Light.
function vkDisableDarkModeChoice() {
  const select = document.querySelector('select[data-my--look-and-feel-target="themeSelect"]');
  if (!select || select.dataset.vkDarkDisabled) return;
  select.dataset.vkDarkDisabled = "1";
  for (const option of select.options) {
    if (option.value === "dark" || option.value === "sync_with_os") {
      option.disabled = true;
      option.textContent = `${option.textContent} (coming soon)`;
    }
  }
  if (select.selectedOptions[0]?.disabled) {
    select.value = "light";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkDisableDarkModeChoice));
vkDisableDarkModeChoice();

// =====================================================================
// Simple mode: projects on Home, a project opens on its Kanban board,
// and the sidebar only shows what is used all day.
// =====================================================================
const VK_EVENTS = ["DOMContentLoaded", "turbo:load", "turbo:render"];
const vkOnPage = (fn) => {
  VK_EVENTS.forEach((e) => document.addEventListener(e, fn));
  new MutationObserver(fn).observe(document.documentElement, { childList: true, subtree: true });
  fn();
};
const vkStore = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  },
};
const vkEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const vkApi = (path) =>
  fetch(`/api/v3${path}`, { credentials: "same-origin", headers: { Accept: "application/hal+json", "X-Requested-With": "XMLHttpRequest" } })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

// ---- Project -> Kanban board: open the first board, creating a status board if there is none ----
const VK_OVERVIEW = /^\/projects\/([^/]+)\/?$/;
const VK_RESERVED = new Set(["new", "queries", "menu"]);
const vkProjectOf = (path) => {
  const m = VK_OVERVIEW.exec(path);
  return m && !VK_RESERVED.has(m[1]) ? decodeURIComponent(m[1]) : null;
};

async function vkResolveBoard(project) {
  const base = `/projects/${encodeURIComponent(project)}`;
  const boards = await fetch(`${base}/boards`, { credentials: "same-origin" });
  if (!boards.ok) throw new Error("no boards");
  const doc = new DOMParser().parseFromString(await boards.text(), "text/html");
  const link = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).find((h) => /\/boards\/\d+$/.test(h));
  if (link) return link;

  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  const created = await fetch(`${base}/boards`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": token || "", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ "boards_grid[name]": "Kanban", "boards_grid[attribute]": "status" }),
  });
  if (!created.ok || !/\/boards\/\d+$/.test(new URL(created.url).pathname)) throw new Error("create failed");
  return new URL(created.url).pathname;
}

let vkOpening = null;
function vkOpenProject(project) {
  if (vkOpening === project) return;
  vkOpening = project;
  document.documentElement.classList.add("vk-opening");
  vkResolveBoard(project)
    .catch(() => `/projects/${encodeURIComponent(project)}/work_packages`)
    .then((url) => { location.assign(url); });
}

// Any link to a project's overview (or to its Boards list from the sidebar) opens the board instead.
// ?overview=1 keeps the real overview reachable.
document.addEventListener(
  "click",
  (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const a = event.target.closest("a[href]");
    if (!a || a.target === "_blank") return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.search) return;
    const project = vkProjectOf(url.pathname) ||
      (a.closest('#main-menu li[data-name="boards"], #vk-pbar') && /^\/projects\/([^/]+)\/boards\/?$/.exec(url.pathname)?.[1]);
    if (!project) return;
    event.preventDefault();
    event.stopPropagation();
    vkOpenProject(decodeURIComponent(project));
  },
  true
);

function vkLanding() {
  const project = vkProjectOf(location.pathname);
  if (project && !location.search.includes("overview")) vkOpenProject(project);
  const current = /^\/projects\/([^/]+)/.exec(location.pathname)?.[1];
  if (current && !VK_RESERVED.has(current)) vkRemember(decodeURIComponent(current));
}
VK_EVENTS.forEach((e) => document.addEventListener(e, vkLanding));
vkLanding();

// Recently opened projects float to the top of Home.
function vkRemember(identifier) {
  const recent = vkStore.get("vk-recent", []).filter((p) => p !== identifier);
  recent.unshift(identifier);
  vkStore.set("vk-recent", recent.slice(0, 50));
}

// ---- Home: every project one click away ----
async function vkLoadProjects() {
  const filters = encodeURIComponent(JSON.stringify([{ active: { operator: "=", values: ["t"] } }]));
  const sort = encodeURIComponent(JSON.stringify([["name", "asc"]]));
  const projects = await vkApi(`/projects?pageSize=500&filters=${filters}&sortBy=${sort}`);
  return projects._embedded.elements;
}

async function vkOpenTaskCounts() {
  const filters = encodeURIComponent(JSON.stringify([{ status: { operator: "o", values: null } }]));
  const wps = await vkApi(`/work_packages?pageSize=1&groupBy=project&filters=${filters}`);
  const counts = {};
  (wps.groups || []).forEach((g) => {
    const href = g._links?.valueLink?.[0]?.href;
    if (href) counts[href.split("/").pop()] = g.count;
  });
  return counts;
}

function vkRenderCards(grid, projects, counts, query) {
  const recent = vkStore.get("vk-recent", []);
  const rank = (p) => { const i = recent.indexOf(p.identifier); return i < 0 ? recent.length : i; };
  const q = query.trim().toLowerCase();
  const shown = projects
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  grid.innerHTML = shown.length
    ? shown.map((p) => {
        const id = encodeURIComponent(p.identifier);
        const open = counts[p.id];
        return `<div class="vk-card" data-project="${vkEsc(p.identifier)}" tabindex="0" role="link">
          <span class="vk-card-mark">${vkEsc(p.name.trim().charAt(0).toUpperCase() || "?")}</span>
          <span class="vk-card-body">
            <span class="vk-card-name">${vkEsc(p.name)}</span>
            <span class="vk-card-meta">${open === undefined ? "" : `${open} open task${open === 1 ? "" : "s"}`}</span>
          </span>
          <span class="vk-card-actions">
            <a href="/projects/${id}/work_packages">Tasks</a>
            <a href="/projects/${id}/settings/general">Settings</a>
          </span>
        </div>`;
      }).join("")
    : `<p class="vk-empty">No projects${q ? " match your search" : " yet"}.</p>`;
}

async function vkHome() {
  if (!document.body.classList.contains("controller-homescreen")) return;
  const body = document.querySelector("#content-body");
  if (!body || body.querySelector("#vk-home")) return;

  const root = document.createElement("section");
  root.id = "vk-home";
  root.innerHTML = `
    <div class="vk-home-bar">
      <h1>Projects</h1>
      <input type="search" class="vk-home-search" placeholder="Search projects  ( / )" aria-label="Search projects" autocomplete="off">
      <a class="vk-home-new" href="/projects/new">+ New client</a>
    </div>
    <div class="vk-cards" aria-live="polite"></div>`;
  body.prepend(root);

  const grid = root.querySelector(".vk-cards");
  const search = root.querySelector(".vk-home-search");
  let projects = [];
  let counts = {};
  const render = () => vkRenderCards(grid, projects, counts, search.value);

  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") grid.querySelector(".vk-card")?.click();
  });
  const open = (card) => card && vkOpenProject(card.dataset.project);
  grid.addEventListener("click", (e) => { if (!e.target.closest(".vk-card-actions")) open(e.target.closest(".vk-card")); });
  grid.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("vk-card")) open(e.target); });

  try { projects = await vkLoadProjects(); } catch (e) { grid.innerHTML = '<p class="vk-empty">Could not load projects. Reload to retry.</p>'; return; }
  render();
  search.focus();
  vkOpenTaskCounts().then((c) => { counts = c; render(); }).catch(() => {});
}
vkOnPage(vkHome);

// "/" focuses the project search on Home.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.target.closest("input, textarea, select, [contenteditable='true']")) return;
  const search = document.querySelector(".vk-home-search");
  if (search) { e.preventDefault(); search.focus(); }
});

// ---- Sidebar: Home / Inbox / My work, your projects, system ----
const VK_NAV_ICONS = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  work: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
};
const vkIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${VK_NAV_ICONS[name]}</svg>`;
let vkProjectList = null;

function vkNavItem(href, label, icon, active) {
  return `<a class="vk-nav-item${active ? " is-active" : ""}" href="${href}" title="${vkEsc(label)}">${icon}<span>${vkEsc(label)}</span></a>`;
}

function vkRenderNav(nav) {
  const path = location.pathname;
  const current = /^\/projects\/([^/]+)/.exec(path)?.[1];
  const recent = vkStore.get("vk-recent", []);
  const rank = (p) => { const i = recent.indexOf(p.identifier); return i < 0 ? recent.length : i; };
  const projects = (vkProjectList || []).slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const admin = document.querySelector('a[href="/admin"]');
  nav.innerHTML = `
    <div class="vk-nav-label">General</div>
    ${vkNavItem("/", "Home", vkIcon("home"), path === "/")}
    ${vkNavItem("/notifications", "Inbox", vkIcon("inbox"), path.startsWith("/notifications"))}
    ${vkNavItem("/my/work?date=today", "My work", vkIcon("work"), path.startsWith("/my/work"))}
    <div class="vk-nav-label">Projects <a class="vk-nav-add" href="/projects/new" title="New client">+</a></div>
    <div class="vk-nav-projects">${projects.map((p) => `<a class="vk-nav-item vk-nav-project${decodeURIComponent(current || "") === p.identifier ? " is-active" : ""}" data-project="${vkEsc(p.identifier)}" href="/projects/${encodeURIComponent(p.identifier)}" title="${vkEsc(p.name)}"><span class="vk-dot">${vkEsc(p.name.trim().charAt(0).toUpperCase())}</span><span>${vkEsc(p.name)}</span></a>`).join("")}</div>
    <div class="vk-nav-spacer"></div>
    <div class="vk-nav-label">System</div>
    ${vkNavItem("/my/account", "Settings", vkIcon("gear"), path.startsWith("/my/account"))}
    ${admin ? vkNavItem("/admin", "Admin", vkIcon("gear"), path.startsWith("/admin")) : ""}
    ${vkNavItem("https://www.openproject.org/docs/", "Help", vkIcon("help"), false)}`;
}

function vkNav() {
  const sidebar = document.querySelector("#main-menu #menu-sidebar");
  if (!sidebar) return;
  let nav = sidebar.querySelector(":scope > .vk-nav");
  const key = location.pathname;
  if (nav && nav.dataset.path === key) return;
  if (!nav) {
    nav = document.createElement("nav");
    nav.className = "vk-nav";
    sidebar.append(nav);
  }
  nav.dataset.path = key;
  vkRenderNav(nav);
  if (!vkProjectList) {
    vkProjectList = [];
    vkLoadProjects().then((list) => { vkProjectList = list; nav.dataset.path = ""; vkNav(); }).catch(() => { vkProjectList = null; });
  }
}
vkOnPage(vkNav);

// ---- Project header: name, people, view tabs (Kanban / List / Calendar), Create Task ----
const VK_TABS = [
  { key: "boards", label: "Kanban", test: /\/boards/, board: true },
  { key: "work_packages", label: "List", test: /\/work_packages/, path: "/work_packages" },
  { key: "calendars", label: "Calendar", test: /\/calendars/, path: "/calendars" },
  { key: "members", label: "Members", test: /\/members/, path: "/members" },
  { key: "settings", label: "Settings", test: /\/settings/, path: "/settings/general" },
];

function vkProjectBar() {
  const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(location.pathname);
  const content = document.querySelector("#content");
  const existing = document.querySelector("#vk-pbar");
  if (!m || VK_RESERVED.has(m[1]) || !m[2] || m[2] === "/" || !content) { existing?.remove(); return; }
  const project = decodeURIComponent(m[1]);
  if (existing && existing.dataset.project === project) {
    existing.querySelectorAll(".vk-tab").forEach((t) => t.classList.toggle("is-active", VK_TABS.find((x) => x.key === t.dataset.tab).test.test(location.pathname)));
    return;
  }
  existing?.remove();
  const base = `/projects/${encodeURIComponent(project)}`;
  const bar = document.createElement("header");
  bar.id = "vk-pbar";
  bar.dataset.project = project;
  bar.innerHTML = `
    <div class="vk-pbar-top">
      <span class="vk-pbar-mark">${vkEsc(project.charAt(0).toUpperCase())}</span>
      <div class="vk-pbar-title"><h2>${vkEsc(project)}</h2><p></p></div>
      <div class="vk-people"></div>
      <a class="vk-btn" href="${base}/members">Invite</a>
      <a class="vk-btn vk-btn-primary" href="${base}/work_packages/create_new">+ Create Task</a>
    </div>
    <nav class="vk-tabs">${VK_TABS.map((t) => `<a class="vk-tab${t.test.test(location.pathname) ? " is-active" : ""}" data-tab="${t.key}" href="${t.board ? `${base}/boards` : base + t.path}">${t.label}</a>`).join("")}</nav>`;
  content.prepend(bar);

  vkApi(`/projects/${encodeURIComponent(project)}`).then((p) => {
    if (bar.dataset.project !== project) return;
    bar.querySelector("h2").textContent = p.name;
    bar.querySelector(".vk-pbar-mark").textContent = p.name.trim().charAt(0).toUpperCase();
    bar.querySelector("p").textContent = (p.description?.raw || "").split("\n")[0].slice(0, 140);
    const filters = encodeURIComponent(JSON.stringify([{ project: { operator: "=", values: [String(p.id)] } }]));
    return vkApi(`/memberships?pageSize=50&filters=${filters}`).then((ms) => {
      const names = [...new Set(ms._embedded.elements.map((e) => e._links.principal?.title).filter(Boolean))];
      const people = bar.querySelector(".vk-people");
      people.innerHTML = names.slice(0, 5).map((n) => `<span title="${vkEsc(n)}">${vkEsc(n.trim().charAt(0).toUpperCase())}</span>`).join("") +
        (names.length > 5 ? `<span class="vk-people-more">+${names.length - 5}</span>` : "");
    });
  }).catch(() => {});
}
vkOnPage(vkProjectBar);
