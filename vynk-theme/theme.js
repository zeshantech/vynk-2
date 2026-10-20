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
