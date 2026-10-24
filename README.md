# CR7 backend

Node.js API for CR7 payment reports and the protected admin dashboard. Reports are stored in MongoDB Atlas. This repository contains the backend only; the React customer website and admin dashboard UI remain in the frontend project.

## Run locally

Requires Node.js 22.13 or newer (tested with Node 24).

1. Run `npm ci`.
2. Run `npm run setup:admin`. This creates a random admin password in the ignored `.env.server` file.
3. Open `.env.server` locally and set `MONGODB_URI` to your Atlas driver connection string. Set `MONGODB_DB=cr7` or your chosen database name. Keep the generated `ADMIN_PASSWORD` or replace it with a password of at least 16 characters.
4. In Atlas, allow the API server outbound IP and give the database user read/write access to the application database.
5. Run `npm start` (or `npm run dev` for automatic restart).
6. Check `http://127.0.0.1:3001/api/health`. A working connection returns `{"ok":true,"database":"mongodb"}`.

Never commit connection strings, passwords, or `.env.server`. The example environment file contains no credentials. The API checks MongoDB connectivity before accepting requests and omits connection credentials from startup logs.

## Host the API

Deploy this repository as a Node.js service:

- Install/build command: `npm ci --omit=dev`
- Start command: `npm start`
- Environment secrets: `MONGODB_URI`, `MONGODB_DB`, `ADMIN_PASSWORD`
- Other settings: `NODE_ENV=production`, `HOST=0.0.0.0`
- The host can supply `PORT`; otherwise `API_PORT` or 3001 is used.
- Health check path: `/api/health`

The server does not require a local environment file when the host supplies environment variables. MongoDB Atlas keeps the database remotely, so the API does not need a persistent disk for report storage. Use HTTPS and configure Atlas network access for the host outbound IPs.

Official Atlas connection guidance: https://www.mongodb.com/docs/drivers/node/current/connect/

## Frontend integration

The API expects the frontend and API to share one browser origin. In the frontend development server, proxy `/api` to `http://127.0.0.1:3001`. In production, route `/api` through the frontend origin to this backend using a reverse proxy or hosting rewrite. Cross-origin requests are not enabled by default. This keeps the existing admin session cookies and origin checks working.

The backend repository does not include the `/admin` page. The React frontend renders that page and calls the protected APIs below. Optional static serving in the server works only if a frontend build has separately been placed in `dist/`.

If traffic comes through a trusted reverse proxy, set `TRUSTED_PROXY_IPS` to the exact comma-separated proxy socket IPs. The proxy must overwrite `X-Forwarded-For` with a verified client IP. The server otherwise uses the socket IP. Incorrect proxy settings can show the proxy location instead of the visitor location.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Verify server and MongoDB connectivity |
| POST | `/api/payment-reports` | Save a visitor report |
| POST | `/api/admin/login` | Sign in with `{ "password": "..." }` |
| GET | `/api/admin/session` | Check admin authentication |
| POST | `/api/admin/logout` | End the admin session |
| GET | `/api/admin/reports` | Filtered counts, charts, and paginated report rows |
| GET | `/api/admin/export` | Download filtered CSV (maximum 10,000 rows) |

The report endpoint accepts `eventId` (UUID), `orderId`, `amount` (number, SOL), `currency` (`SOL`), and optional browser `timezone`. It derives token allocation server-side and records the configured recipient wallet, server timestamp, source IP, user agent and language. Keep an event ID stable when retrying a failed request; a deliberate new submission uses a new ID. MongoDB enforces unique event IDs.

Reports are visitor claims, not verified blockchain payments. The API does not request private keys or execute transfers. Inform visitors about collection of IP/browser/order information, as the existing frontend does.

Admin report and export filters: `q` (literal order/IP/location search), `from` and `to` (YYYY-MM-DD, UTC), and `page` (25 rows per page). Sessions use HttpOnly, SameSite=Strict cookies, expire after eight hours, and are cleared on server restart. Production cookies require HTTPS. Login and report endpoints are rate limited.

## Data and location

Database: `MONGODB_DB` (default `cr7`). Collection: `payment_reports`. Date and order indexes are created on startup. Tests and sample content are not inserted into the application collection.

Public IP locations are estimated through HTTPS requests to https://ipwho.is/ with a short timeout and one-hour in-memory cache. Only the IP is sent to the provider. No GPS coordinates are requested or stored. Local/private IPs show Local network. Provider failures do not prevent recording the report. VPNs and mobile networks can make estimates inaccurate. Provider documentation: https://ipwhois.io/documentation

## Test

Run `npm test`. The suite checks authentication, persistence, retry deduplication, reporting totals, filters, CSV, pagination and IP handling. It uses `TEST_MONGODB_URI`, then `MONGODB_URI`, or a temporary local MongoDB if neither is configured. The temporary local option can download a MongoDB binary on its first run.

Every test uses an isolated, randomly named `cr7_test_...` database that is removed afterward. Tests never write reports into `cr7.payment_reports`. The test database user needs permission to create and remove these isolated test databases.
