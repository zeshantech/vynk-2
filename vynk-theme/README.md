# Vynk modern theme for OpenProject

shadcn/ui-inspired restyle (zinc neutrals, burgundy accent, Inter, rounded cards, soft shadows). Appearance only, no core changes.

## Preview locally (no rebuild needed)
1. OpenProject running on :8081 with `OPENPROJECT_HOST__NAME=localhost:8082`.
2. `docker run -d --name vynk-theme-proxy --add-host=host.docker.internal:host-gateway -p 8082:80 -v $PWD/vynk-theme/nginx.conf:/etc/nginx/conf.d/default.conf:ro -v $PWD/vynk-theme:/theme:ro nginx:alpine`
3. Open http://localhost:8082 and edit `theme.css`; refresh to see changes.

## Ship it
Load `theme.css` (+ `logo.svg`, `fonts/Inter.woff2`) from the app layout in a custom build, or keep the proxy approach in front of the production container.
