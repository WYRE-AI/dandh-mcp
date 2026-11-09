# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release: a read-only MCP server for D&H Distributing. It uses the Customer Order Management REST API (OAuth2 client credentials) and the dhXML integration (UserCode/Password).
- REST tools: `dandh_get_item`, `dandh_search_items`, `dandh_get_price`, `dandh_get_prices_bulk`, `dandh_get_availability`, `dandh_get_availability_bulk`, `dandh_get_price_and_availability`, `dandh_get_price_and_availability_bulk`, `dandh_list_carriers`, `dandh_get_order_tracking`, `dandh_list_order_tracking`.
- XML tools: `dandh_xml_get_price_availability`, `dandh_xml_item_inquiry`, `dandh_xml_get_order_status`.
- Tool tiers: every tool is `read` (`DANDH_TOOL_TIERS`, default `read`). `X-Conduit-Tool-Tiers` can only narrow the tiers, and a present-but-empty header exposes no tools.
- `shipMode` is enum-validated. `pageSize` is capped at 100. `scrollId` is passed through; the server never pages automatically.
- Fleet CI (`ci.yml`, stdio smoke), `mcp-assert` evals, gitleaks scanning, ESLint, `lint:destructive`, `typecheck` and `smoke` scripts.

### Changed
- Brought the server up to the WYRE MCP template security contract (anthropic-admin-mcp):
  - Every REST URL is checked against a fixed origin and an exact path under `/customerOrderManagement/v2/customers/`.
  - Path IDs are validated (`.`, `..`, `/`, `\`, encoded separators and control characters are rejected) and then percent-encoded.
  - Requests use `redirect: "manual"` and refuse any 3xx.
  - Response bodies are bounded to 4 MiB while streaming.
  - Error messages keep the HTTP status, D&H's message and a request id.
  - Credentials are redacted from tool output, errors and logs, including the per-request gateway secrets.
  - Startup fails closed on a weak `CONDUIT_S2S_SECRET`.
  - `AUTH_MODE=gateway` reads credentials only from the seven `X-DandH-*` headers and locks the process out of env credentials.
- Requests to D&H are no longer retried on 429/5xx/network errors. A REST GET still refreshes its token once after a 401.
- Dockerfile: `node:22-alpine` pinned by digest, `npm ci --ignore-scripts`, sources copied explicitly, non-root user, `DANDH_TOOL_TIERS=read`.
- The release workflow is pinned to `WYRE-AI/reusable-workflows` `mcp-server-release.yml@508ef4dd`, with `actions: read` and `fail-on-severity: HIGH,CRITICAL`.

### Removed
- The order-placing tools `dandh_create_sales_order` and `dandh_xml_create_order`, and their order-safety module (caps, confirm tokens, PO registry). They were never released. The first launch is read-only, and the code remains in this branch's git history.
- The `DANDH_XML_URL` endpoint override. The XML URL is fixed per country, so no base URL can be supplied.
- The `X-DandH-Environment` header. The REST host pair is a deployment setting (`DANDH_ENVIRONMENT`) only.
- Credential headers in `AUTH_MODE=env`. Env mode now uses only `DANDH_*`.
