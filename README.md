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

The frontend can call this backend directly using its public HTTPS URL. The existing frontend has `VITE_API_URL=https://cr7-new.onrender.com`. Admin login returns a short-lived session token; the frontend keeps it in sessionStorage and sends `Authorization: Bearer <token>` on admin API requests. This avoids a dependency on third-party cookies. Existing same-origin cookie authentication is also supported.

Set `FRONTEND_ORIGINS` on the backend to a comma-separated list of exact frontend origins (scheme, hostname, and port; no trailing slash). Unknown browser origins are rejected. When unset, localhost and 127.0.0.1 on ports 3001, 5173 and 5174 are allowed for development. Before public frontend launch, set this explicitly to your actual domain(s), optionally retaining development origins if required. Preflight requests support Content-Type and Authorization headers. No wildcard origins or cross-site credential cookies are used.

The React frontend is configured independently; changing VITE_API_URL requires restarting Vite or rebuilding a hosted frontend. You can alternatively keep using a same-origin `/api` proxy. Direct requests to the hosted backend allow it to see the visitor connection through the hosting network; configure trusted proxy IPs for accurate visitor location as explained below.

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


