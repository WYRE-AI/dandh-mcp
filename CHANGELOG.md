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

### Fixed
- Paging: `scrollId` and `hasNext` (from the body or the `x-scroll-id` header) are now the first fields of a REST page, so a page cut off at `DANDH_MAX_RESPONSE_CHARS` still carries its next-page token.
- REST errors handle D&H's real (Axway) error shape, as returned to live probes of `api.dandh.com` on 2026-11-09: the request id comes from `x-correlationid` (falling back to the body `debugId`), the detail includes `errorName` and `details`, an empty-body 401 reports the `www-authenticate` `error_description`, and a 429 includes `Retry-After` when sent.
- gitleaks: the fake JWT in the redaction test is allowlisted by its exact value, so the history scan is clean.
- Canadian dhXML order status keeps `PROVINCE`/`POSTALCODE` (as `province`/`postalCode`) and the `INVTOTAL` `PST`/`HST`/`QST` breakdown (as `pst`/`hst`/`qst`), per D&H's Canada XML guide (DH.IS.WEB.XML.2). The Canadian dispatcher URL is cited from that guide instead of being marked as assumed.
- REST list parameters (`items`, `customerItemNumbers`, `vendorItemIds`) are sent as repeated keys (`items=A&items=B`), as the n8n reference does, instead of one comma-joined value.
- `dandh_get_order_tracking` no longer claims its path id is the D&H sales order id (unconfirmed) and points agents at `dandh_list_order_tracking` for lookups by order, PO or invoice number.
- README and code comments record the 2026-11-09 live probes: the REST and token hosts and the Bearer scheme are confirmed; paths and response shapes still need real credentials. The cross-account binding check is listed as a pre-launch item.

### Security
- REST error details are redacted after JSON decoding, so an access token D&H echoes JSON-escaped (`a\/b`) no longer reaches the model.
- Gateway mode answers 401 when any `X-DandH-*` credential header is sent more than once, instead of using Node's comma-joined value. A concurrent cross-tenant test (40 interleaved REST and XML calls, 4 tenants) guards per-request credential isolation.
- `zod` (pulled in by `@modelcontextprotocol/sdk`) resolves to 4.6.7, fixing GHSA-mrhx-c7xc-m3w5 (HIGH). `npm audit --omit=dev` reports 0 vulnerabilities.
