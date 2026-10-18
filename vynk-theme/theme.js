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
      const collapsed = root.classList.toggle("vk-sb-collapsed");
      try { localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded"); } catch (e) {}
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

// ---- Sidebar brand: Vynk logo at the top of the sidebar (desktop dashboard layout) ----
function vkSidebarBrand() {
  const sidebar = document.querySelector("#main-menu #menu-sidebar");
  if (!sidebar || sidebar.querySelector(".vk-sb-brand")) return;
  const logo = document.querySelector(".op-app-header a.op-logo--link:not(.op-logo--icon)");
  const brand = document.createElement("div");
  brand.className = "vk-sb-brand";
  const link = document.createElement("a");
  link.className = "op-logo--link";
  link.href = logo ? logo.getAttribute("href") : "/";
  link.setAttribute("aria-label", "Home");
  link.textContent = "Home";
  brand.appendChild(link);
  sidebar.prepend(brand);
}
["DOMContentLoaded", "turbo:load", "turbo:render"].forEach((e) => document.addEventListener(e, vkSidebarBrand));
new MutationObserver(vkSidebarBrand).observe(document.documentElement, { childList: true, subtree: true });
vkSidebarBrand();
