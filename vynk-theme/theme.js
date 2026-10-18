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
