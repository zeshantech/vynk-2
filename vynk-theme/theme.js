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

// ---- Sidebar team switcher: Vynk card on top of the sidebar; opens the project switcher ----
function vkSidebarBrand() {
  const sidebar = document.querySelector("#main-menu #menu-sidebar");
  if (!sidebar) return;
  let brand = sidebar.querySelector(".vk-sb-brand");
  if (!brand) {
    brand = document.createElement("div");
    brand.className = "vk-sb-brand";
    brand.innerHTML =
      '<button type="button" class="vk-team" aria-label="Switch project">' +
      '<span class="vk-team-icon"></span>' +
      '<span class="vk-team-text"><span class="vk-team-name">Vynk</span><span class="vk-team-sub"></span></span>' +
      '<svg class="vk-team-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>' +
      "</button>";
    brand.querySelector(".vk-team").addEventListener("click", () => {
      document.querySelector("#projects-menu")?.click();
    });
    sidebar.prepend(brand);
  }
  const project = document.querySelector("#projects-menu")?.textContent.trim() || "All projects";
  const sub = brand.querySelector(".vk-team-sub");
  if (sub.textContent !== project) sub.textContent = project;
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
