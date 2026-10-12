# Dewbow Team workspace development

Use Node.js 24.21.0 and npm 12.2.0. Run `npm ci` from the repository root. Team workspaces are the contract (`packages/team-protocol`, `@dewbow/team-protocol`), backend (`apps/team-backend`, `@dewbow/team-backend`), and React Web client (`apps/team-web`, `@dewbow/team-web`). Core and Team share the root lockfile and compiler settings. See [Workspace layout](../workspace.md) for all packages.

Run `npm run build`, `npm run typecheck`, and `npm test`. The backend uses Node's HTTP server and built-in SQLite; no native database dependency is needed. The Web client uses React and Vite.

Run `npm run team:backend` from the root to build the required protocol packages and backend, then start Team. Build the Team Web first with `npm run build --workspace @dewbow/team-web` if serving its interface. Set `DEWBOW_TEAM_OPERATOR_TOKEN` to a private operator credential with 16–512 characters. `npm run team:check` builds the backend and validates configuration without starting a listener or opening storage. The default backend listens on `http://127.0.0.1:3100` and serves the built Web client at the same origin.

Configuration variables are `DEWBOW_TEAM_HOST`, `DEWBOW_TEAM_PORT`, `DEWBOW_TEAM_ORIGIN`, `DEWBOW_TEAM_OPERATOR_TOKEN`, `DEWBOW_TEAM_DATABASE`, and `DEWBOW_TEAM_WEB_DIR`. Configure `DEWBOW_CORE_URL` and `DEWBOW_CORE_TOKEN` together for Core integration; the credential stays on the backend. Defaults for storage and Web assets are `state/team.sqlite` and `apps/team-web/dist`, resolved from the working directory. Run root scripts from the repository root. [team.env.example](../examples/team.env.example) lists configuration placeholders.

`npm run team:web` starts Vite at `http://127.0.0.1:5174` and proxies API/auth requests to port 3100. `npm run team:web:preview` serves only built static assets at port 4174; append `-- --port <port>` to either command to select another free port. Use the backend origin for complete application checks. Listeners use loopback by default; configure a public HTTPS origin and reverse proxy for remote access. Stop each service or preview with Ctrl+C.

For a shared local setup, run `npm run local:init`, then start `npm run local:core:control-plane` and `npm run local:team:backend` in separate terminals after building. Team uses its own `teamOperator` credential and `team.sqlite`; its private `team.env` contains the Core management credential. A daemon is needed only for host execution. See [Local operations](../operations.md).

Team can manage definitions and teams without a running Core. Session operations require the configured Core; unavailable Core state remains visible. Both applications keep separate operator cookies and login flows. The Team contract uses type-only references to Core's public record types and projections, without importing a Core server or SDK implementation into the browser.

The management API uses `POST /api/<operation>`. It accepts a bearer operator credential for programmatic callers or an HttpOnly, SameSite=Strict cookie for Web users. `POST /auth/login` exchanges the operator credential for a 24-hour cookie; `POST /auth/logout` invalidates it. Cookie-backed writes require the configured origin. Sessions expire on backend restart. `GET /health` exposes only the service name and `v1` contract. No Core credential is returned to clients.

Install scripts are denied unless explicitly reviewed and allowed in `package.json`. The optional `fsevents` install script remains denied. Keep all local environment files and storage under ignored paths. Do not commit private credentials or real session data.

Windows can run the Core and Team HTTP services and their built Web clients. Core native execution and its SDK/daemon fixtures use the macOS/Linux setup in [Local operations](../operations.md). Team tests retain POSIX database-mode assertions on those platforms; Windows mode bits do not establish ACL ownership or private access. Keep Windows local state in a directory with appropriate account permissions.
