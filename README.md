# D&H MCP Server

Read-only MCP server for [D&H Distributing](https://www.dandh.com/), for AI assistants and the WYRE Conduit gateway. It covers item search, customer-specific pricing (including volume pricing), availability by branch, carriers, and order status and tracking. It uses D&H's Customer Order Management **REST API** and the **dhXML** integration.

**No tool places, changes or cancels an order.** Every tool is `read` tier, annotated `readOnlyHint: true` / `destructiveHint: false`. The order-entry tools from the first draft (`dandh_create_sales_order`, `dandh_xml_create_order`) have been removed for the read-only launch.

You can configure the REST service, the XML service, or both. If a tool is called for a service that is not configured, the error names that service and the equivalent tool on the other one.

> **Status: not yet verified against live D&H.** D&H's REST reference is behind a login. The REST paths come from a community n8n node, and several details are unconfirmed. See [Unconfirmed against live D&H](#unconfirmed-against-live-dh).

## Tools

| Tool | Surface | Calls |
|---|---|---|
| `dandh_get_item` | REST | `GET …/items/{itemId}` |
| `dandh_search_items` | REST | `GET …/items?` exactly one of `vendorItemId`, `customerItemNumber`, `universalProductCode`, `items`, `vendorItemIds`, `customerItemNumbers` (+ `pageSize`, `scrollId`) |
| `dandh_get_price` | REST | `GET …/items/{itemId}/price?quantity=` |
| `dandh_get_prices_bulk` | REST | `GET …/items/price/bulk?items=&customerItemNumbers=` (max 50 combined) |
| `dandh_get_availability` | REST | `GET …/items/{itemId}/availability` |
| `dandh_get_availability_bulk` | REST | `GET …/items/availability/bulk` (max 50 combined) |
| `dandh_get_price_and_availability` | REST | `GET …/items/{itemId}/priceAndAvailability?quantity=` |
| `dandh_get_price_and_availability_bulk` | REST | `GET …/items/priceAndAvailability/bulk` (max 50 combined) |
| `dandh_list_carriers` | REST | `GET …/carriers?shipMode=parcel\|lessThanTruckload\|fullTruckload` (+ paging) |
| `dandh_get_order_tracking` | REST | `GET …/salesOrders/{orderId}/tracking` |
| `dandh_list_order_tracking` | REST | `GET …/salesOrders/tracking?` exactly one of `orderNumber`, `purchaseOrderNumber`, `invoiceNumber` (+ paging) |
| `dandh_xml_get_price_availability` | XML | `price` / `availability` (max 50 items) or `price-availability` (max 25) |
| `dandh_xml_item_inquiry` | XML | `itemInquiry` by D&H or manufacturer part number, with quantity |
| `dandh_xml_get_order_status` | XML | `orderStatus` by PO, order and/or invoice number (max 50 in total) |

`…` = `/customerOrderManagement/v2/customers/{accountNumber}`. The account number and company always come from the connection's credentials. Tools take no `accountNumber`, `company` or host arguments, and undeclared arguments are dropped before a handler runs.

**Pagination** (`dandh_search_items`, `dandh_list_carriers`, `dandh_list_order_tracking`): each call returns one page plus its `scrollId`. Pass that `scrollId` back to get the next page; the server never pages automatically. `pageSize` is capped at 100. That is a local cap, since D&H's maximum is not published.

The dhXML tools are HTTP POSTs only because dhXML takes every request as a form-POSTed document. Each one is a documented read-only query from D&H's public US XML guide (DH.IS.WEB.XML.1, Dec 2024). Order Entry is not implemented.

## Security contract

- **Fixed hosts.** The REST origins (`https://auth.dandh.com`, `https://api.dandh.com`; test: `https://test.auth.dandh.com`, `https://test.api.dandh.com`) and XML URLs are constants, and no base URL can be supplied. `DANDH_ENVIRONMENT` is a deployment setting that picks between the two REST host pairs; no header or argument can set it. Every REST URL is checked after it is built: it must be on the fixed origin, at exactly the expected path, under `/customerOrderManagement/v2/customers/`.
- **Path segments.** IDs are trimmed and must be 1 to 256 characters. Empty values, `.`, `..`, `/`, `\`, percent-encoded separators or dots, and control characters are rejected. Valid IDs are then percent-encoded.
- **List parameters** are sent as repeated plain keys (`items=A&items=B`), never bracketed. An entry that contains a comma is rejected. Encoding happens in one function (`encodeList` in `src/tools/rest.ts`). D&H's real format is unconfirmed (see below).
- **Requests.** Every call uses `redirect: "manual"`, and any 3xx is an error. Response bodies are capped at 4 MiB while streaming (`DANDH_MAX_UPSTREAM_BYTES`). Each call has a timeout and is cancelled when the MCP client cancels. REST calls are never retried, except for one token refresh after a 401 on a GET. XML calls are never retried.
- **Errors** keep the HTTP status, D&H's message (`message`, `errorName`, `details`, or the `www-authenticate` `error_description` of an empty 401), a `Retry-After` on a 429, and a request id: D&H's `x-correlationid` header, else the body `debugId`, else `x-request-id`, `x-correlation-id`, `request-id` or Cloudflare's `cf-ray`. Credentials and the access token are removed from them after JSON decoding.
- **Redaction.** Tool output, errors and logs are redacted before truncation. Redaction covers exact secrets (the client secret, the XML password, and both the env and the per-request gateway values), plus Bearer tokens, JWTs, `<PASSWORD>` elements, form `client_secret=`/`password=`/`xmlDoc=` fragments, and credential-named JSON keys.
- **XML parsing** rejects `DOCTYPE`/`ENTITY` declarations, so XML external entity (XXE) attacks and entity expansion are blocked. Request values are escaped, and control characters are rejected.
- **OAuth tokens** are cached per credential set. The cache key is a SHA-256 over client id, secret, company and environment. The cache holds at most 500 entries. Callers that need a token at the same time share one token request; it keeps the timeout but is not cancelled when the caller that started it cancels (that caller stops waiting at once).

## Authentication

### REST (Customer Order Management API v2)

1. Sign in to the D&H API Portal ([production](https://apiportal.dandh.com), [test](https://test.apiportal.dandh.com)). This needs an existing D&H dealer account; REST onboarding is arranged through your D&H sales rep.
2. Go to **Applications → Create Application**, tick **Customer Order Management API**, then under *OAuth Credentials* click **Generate** (confidential client). Copy the **Client ID** and **Client Secret**.
3. Note your **10-digit D&H account number** and its **company**: `us` (D&H US), `ca` (D&H Canada) or `dsc` (DSC).

Authentication is OAuth2 client credentials (scope `resource.READ`) against `https://auth.dandh.com/api/oauth/token`, with the credentials sent in the form body. D&H's 2021 OAuth PDF lists `auth.dandh.net`, which no longer answers. API calls send `Authorization: Bearer <token>` and `dandh-tenant: dhus|dhca|dsc`.

### XML

Request XML access in **My D&H → D&H Automation Services**. Authentication is that dandh.com user's `UserCode` and `Password`, sent inside the XML document. The document is posted as the form field `xmlDoc` to `https://www.dandh.com/dhXML/xmlDispatch` (CA: `https://www.dandh.ca/dhXML/xmlDispatch`). When D&H rejects the sign-in it returns a web page instead of XML, and the server reports this as a sign-in problem.

## Configuration

Each service's credentials are **all-or-none**. A partial set is an error that names the missing variables or headers, never their values.

| Variable | Gateway header | Description |
|---|---|---|
| `DANDH_CLIENT_ID` | `X-DandH-Client-Id` | REST: OAuth Client ID. |
| `DANDH_CLIENT_SECRET` | `X-DandH-Client-Secret` | REST: OAuth Client Secret. |
| `DANDH_ACCOUNT_NUMBER` | `X-DandH-Account-Number` | REST: 10-digit account number. |
| `DANDH_COMPANY` | `X-DandH-Company` | REST: `us` (default), `ca`, `dsc`. |
| `DANDH_XML_USER_CODE` | `X-DandH-Xml-User-Code` | XML: dandh.com/dandh.ca UserCode. |
| `DANDH_XML_PASSWORD` | `X-DandH-Xml-Password` | XML: password for the UserCode. |
| `DANDH_XML_COUNTRY` | `X-DandH-Xml-Country` | XML: `us` (default) or `ca`. |
| `DANDH_ENVIRONMENT` | (none) | `production` (default) or `test`: which fixed REST host pair to use. |
| `DANDH_TOOL_TIERS` | (none) | `read` (default and only tier). |
| `AUTH_MODE` | (none) | `gateway` (image default) or `env`. In gateway mode, credentials come **only** from the seven `X-DandH-*` headers on each `/mcp` request, never from `DANDH_*`. A request without at least one complete set gets 401. The process locks into gateway mode once the HTTP server starts. An unparseable `AUTH_MODE` is treated as gateway. |
| `CONDUIT_S2S_SECRET` | (none) | Required for HTTP. Startup refuses an empty value, a known placeholder, anything shorter than 32 characters, or a repeated pattern (generate one with `openssl rand -hex 32`). The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | (none) | Local development only. `1` starts HTTP without the S2S secret and binds `127.0.0.1`. |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | (none) | Bind address (default `127.0.0.1`; the image uses `0.0.0.0`) and port (default `8080`). |
| `MCP_ALLOWED_HOSTS` | (none) | Optional Host-header allowlist for `/mcp`. |
| `DANDH_REQUEST_TIMEOUT_MS`, `DANDH_MAX_RESPONSE_CHARS`, `DANDH_MAX_UPSTREAM_BYTES`, `LOG_LEVEL` | (none) | Limits and logging. |

Conduit may send `X-Conduit-Tool-Tiers` to **narrow** the tool tiers for one request. If the header is present but empty, or names no configured tier, the request sees zero tools.

### HTTP authentication

Every `/mcp` request must carry `X-Gateway-S2S: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t=<unix seconds>" keyed with CONDUIT_S2S_SECRET>`. The timestamp must be within 300 seconds of server time. `/health` is unauthenticated liveness only and reads no credentials. `/mcp` accepts only POST, with bodies up to 1 MiB, and is stateless (no sessions).

## Confirmed against live D&H

Unauthenticated probes on 2026-11-09 (no D&H credentials):

- **REST hosts and auth scheme.** `https://api.dandh.com` and `https://test.api.dandh.com` answer at `/customerOrderManagement/v2/customers/{account}/items/{id}` through a Bearer gateway: HTTP 400 with no token, 401 `invalid_token` with a bogus token. Errors carry an `x-correlationid` header and an Axway body (`errorName`, `debugId`, `message`, `links`, `details`). `https://auth.dandh.com/api/oauth/token` takes credentials in the form body (HTTP 400 `invalid_client` for fake ones). `auth.dandh.net` from the 2021 OAuth PDF does not resolve.
- **Canadian XML host** `https://www.dandh.ca/dhXML/xmlDispatch` is the submission URL in D&H's public Canada XML guide (DH.IS.WEB.XML.2, Feb 2024). Canadian order status uses `PROVINCE`/`POSTALCODE` and `INVTOTAL` `PST`/`HST`/`QST`, returned as `province`, `postalCode`, `pst`, `hst`, `qst`.

## Unconfirmed against live D&H

- **REST paths, parameter names and response shapes** come from the community n8n node (`n8n-nodes-dandh`) and need a dealer's credentials to verify. JSON is returned as received, untyped.
- **List encoding**: lists are sent as repeated keys, matching the n8n node (an array in `qs`). Confirm against the portal Swagger; to change it, edit `encodeList` in `src/tools/rest.ts`.
- **`dandh_get_order_tracking` path id**: the n8n node calls it an "Order Tracking ID"; whether it equals the D&H order number is unknown. The tool steers agents to `dandh_list_order_tracking`.
- **`shipMode` values** (`parcel`, `lessThanTruckload`, `fullTruckload`) come from the n8n node.
- **Account binding**: the account number in REST paths comes from `X-DandH-Account-Number`, separately from the OAuth client. Whether D&H refuses a client's token on another customer's account (`customers/{B}/…` with client A's token should be 403) is unconfirmed. If D&H does not enforce it, Conduit must verify the account number belongs to the tenant at connect time.
- **Test-only credentials**: the Conduit catalog's `validate()` calls the production token URL, so a tenant that has only test-portal credentials fails validation.

Before launch, check these against the portal docs with a dealer's credentials (Linear WYREAI-321).

## Development

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run lint            # eslint + destructive-tool warning lint
npm run lint:destructive
npm run typecheck
npm run smoke           # spawns dist/index.js over stdio; no network
```

Tests mock `fetch` and make no network calls.

## Docker

```bash
docker build --platform linux/amd64 -t dandh-mcp .
docker run -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" -p 127.0.0.1:8080:8080 dandh-mcp
```

The image runs as a non-root user, uses a base image pinned by digest, installs with `npm ci --ignore-scripts`, and bakes in no secrets. It sets `MCP_TRANSPORT=http`, `MCP_HTTP_PORT=8080`, `AUTH_MODE=gateway` and `DANDH_TOOL_TIERS=read`. Compose (`docker compose up`) refuses to start without `CONDUIT_S2S_SECRET` and passes no `DANDH_*` credentials.
