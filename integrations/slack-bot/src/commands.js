// Parsing for slash-command text (pure, no I/O).

import { parseHours } from "./time.js";

const DATE_WORD = /^(today|yesterday|\d{4}-\d{2}-\d{2})$/i;

/**
 * "/log-time 2h #123 fixed login bug yesterday"
 * -> { hours: 2, workPackageId: 123, comment: "fixed login bug", date: "yesterday" }
 * Hours and task may come in any order; the date word may be anywhere.
 */
export function parseLogTime(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  let hours = null;
  let workPackageId = null;
  let date = null;
  const rest = [];
  tokens.forEach((token, index) => {
    const bareNumber = /^\d+$/.test(token);
    // Bare numbers only count as a task ID at the start ("2 123", "123 2h"), so "fixed 3 bugs" stays a comment.
    const isTaskId =
      workPackageId === null && (/^#\d+$/.test(token) || (bareNumber && index < 2 && (hours !== null || Number(token) > 24)));
    if (isTaskId) workPackageId = Number(token.replace("#", ""));
    else if (hours === null && index < 2 && parseHours(token) !== null) hours = parseHours(token);
    else if (date === null && DATE_WORD.test(token)) date = token.toLowerCase();
    else rest.push(token);
  });
  return { hours, workPackageId, date, comment: rest.join(" ") };
}

/** "/create-task website | Fix header" -> { project: "website", subject: "Fix header" } */
export function parseCreateTask(text) {
  const raw = String(text ?? "").trim();
  const idx = raw.indexOf("|");
  if (idx === -1) return { project: null, subject: raw || null };
  return { project: raw.slice(0, idx).trim() || null, subject: raw.slice(idx + 1).trim() || null };
}
