# Vynk Slack bot

Slash commands for Vynk (OpenProject) over Slack Socket Mode — no public URL needed.

| Command | What it does |
| --- | --- |
| `/vynk` | Help |
| `/log-time 2h #123 note [yesterday\|YYYY-MM-DD]` | Log time (no text opens a form) |
| `/week-hours [last]`, `/time-week-logged-times [last]` | Your hours, per day and per task |
| `/my-tasks` | Your open tasks |
| `/create-task project \| title` | Create a task assigned to you (no text opens a form) |
| `/projects` | List projects |
| `/create-project Name` | Create a project, you become Project admin *(Vynk admin)* |
| `/team-hours [last]` | Everyone's hours *(Vynk admin)* |

Slack users are matched to Vynk users by email. People can only log time in projects they're members of.

## Setup

1. https://api.slack.com/apps → **Create New App → From a manifest** → paste `slack-manifest.yml` → Install to workspace.
2. Copy **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) and create an **App-Level Token** with `connections:write` (`xapp-…`, Basic Information).
3. In Vynk as admin: avatar → **My account → Access tokens → API → + API token** (`OPENPROJECT_API_KEY`).
4. Add to Infisical (`/vynk-op`): `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPENPROJECT_API_KEY`. Push/redeploy — the bot starts automatically when `SLACK_BOT_TOKEN` exists.

Optional: `BOT_TIMEZONE` (default `Asia/Karachi`), weekly DM reminder `REMINDER_DAY=fri`, `REMINDER_TIME=17:00`, `REMINDER_MIN_HOURS=40`.

Local run: `npm install && OPENPROJECT_URL=… OPENPROJECT_API_KEY=… SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… npm start`. Tests: `npm test`.
