# D&H MCP Server

MCP server for [D&H Distributing](https://www.dandh.com/)'s Customer Order Management **REST API** and **XML integration** - pricing (including volume pricing), availability by distribution center, item search, carriers, order status/tracking, and order placement, for AI assistants and the WYRE Conduit gateway.

Configure the REST service, the XML service, or both. A tool called against an unconfigured service returns an error naming the missing service and the equivalent tool on the other one.

> **Status: not yet verified against live D&H.** Several REST details (production host, response shapes, order body) are inferred from a community client. See [Unconfirmed against live D&H](#unconfirmed-against-live-dh).

## Authentication

### REST (Customer Order Management API v2)

1. Sign in to the D&H API Portal ([production](https://apiportal.dandh.com), [test](https://test.apiportal.dandh.com)). REST onboarding is arranged through your D&H sales representative.
2. **Applications -> Create Application**, tick **Customer Order Management API**, *Save and add authentication*, then under *OAuth Credentials* click **Generate**. Copy the **Client ID** and **Client Secret**.
3. Note your **10-digit D&H account number** and which **company** it belongs to: `us` (D&H US), `ca` (D&H Canada) or `dsc` (DSC).

This server uses the OAuth2 *client credentials* grant (scope `resource.READ`, credentials sent in the request body) against `https://auth.dandh.com/api/oauth/token` (test: `https://test.auth.dandh.com`). Tokens are cached per credentials/company/environment and refreshed before expiry and once on a 401. Every call sends `dandh-tenant: dhus|dhca|dsc`.

### XML

Request XML access in **My D&H -> D&H Automation Services** on dandh.com / dandh.ca. Authentication is the `UserCode` and `Password` of that dandh.com user, sent inside the XML. Documents are posted to `https://www.dandh.com/dhXML/xmlDispatch` as the form field `xmlDoc`. D&H returns a web page (not XML) when sign-in is rejected; the server reports that as an auth failure / maintenance.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below. Each service's set is **all-or-none**: a partial set is a configuration error naming the missing variables.

| Variable | Gateway header | Required | Description |
|---|---|---|---|
| `DANDH_CLIENT_ID` | `X-DandH-Client-Id` | REST | OAuth Client ID. |
| `DANDH_CLIENT_SECRET` | `X-DandH-Client-Secret` | REST | OAuth Client Secret. |
| `DANDH_ACCOUNT_NUMBER` | `X-DandH-Account-Number` | REST | 10-digit account number. |
| `DANDH_COMPANY` | `X-DandH-Company` | No | `us` (default), `ca`, `dsc`. |
| `DANDH_XML_USER_CODE` | `X-DandH-Xml-User-Code` | XML | dandh.com/dandh.ca UserCode. |
| `DANDH_XML_PASSWORD` | `X-DandH-Xml-Password` | XML | Password for the UserCode. |
| `DANDH_XML_COUNTRY` | `X-DandH-Xml-Country` | No | `us` (default) or `ca`. |
| `DANDH_ENVIRONMENT` | `X-DandH-Environment` | No | `production` (default) or `test`; selects REST auth/API hosts only. |
| `DANDH_XML_URL` | - | No | Deployment override of the XML endpoint. Must be `https://` on `dandh.com`, `dandh.ca` or a subdomain of either, with no username/password and no port; anything else is a startup error. |
| `DANDH_MAX_ORDER_LINES` | - | No | Order cap: total lines per order across all shipments/items. Positive whole number. Default `25`. |
| `DANDH_MAX_LINE_QUANTITY` | - | No | Order cap: quantity per line (REST `orderQuantity`, XML `quantity`). Positive whole number. Default `100`. |
| `DANDH_MAX_ORDER_VALUE` | - | No | Order cap: total order value (sum of quantity x unit price) in the account currency. Positive number. Default `5000`. |
| `DANDH_CONFIRM_SECRET` | - | No | Key for the preview `confirmToken` (HMAC-SHA256). Default: 32 random bytes per process. Set the same value on every replica if previews and confirms can hit different ones. At least 32 bytes (UTF-8) or the server refuses to start, e.g. `openssl rand -hex 32`. |
| `DANDH_MAX_UNIT_PRICE` | - | No | Cap on the unit price D&H returns for any order line (a caller-supplied `unitPrice` / `price` is never used for it). Positive number. Default `25000`. |
| `MCP_TRANSPORT` | - | No | `stdio` (default) or `http`. |
| `AUTH_MODE` | - | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires a complete REST and/or XML header set on each `/mcp` request and never falls back to `DANDH_*`. `env` uses those variables after S2S auth succeeds (headers, when present, take precedence). |
| `CONDUIT_S2S_SECRET` | - | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty, a known placeholder, or shorter than 32 bytes (UTF-8), e.g. `openssl rand -hex 32`. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | - | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. Warns, skips `X-Gateway-S2S`, binds `127.0.0.1` only. A placeholder or too-short secret still refuses to start. |
| `MCP_HTTP_HOST` | - | No | Bind address when a secret is configured. Unset means `0.0.0.0`. |
| `MCP_HTTP_PORT` | - | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | - | No | `debug`, `info` (default), `warn`, `error`. |

`/health` stays unauthenticated, does not require `X-Gateway-S2S`, and does not read vendor credentials. Secrets (client secret, tokens, passwords, `Authorization` headers, XML bodies) are never logged and are scrubbed from error messages.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex hmac-sha256>`: HMAC-SHA256 over the exact ASCII string `t=<unix seconds>`, keyed with `CONDUIT_S2S_SECRET`, as 64 lowercase hex characters. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401.

```
X-Gateway-S2S: t=1710000000,v1=<64 lowercase hex chars>
```

Known placeholders are rejected at startup: `changeme`, `change-me`, `secret`, `example`, `placeholder`, `replace-me`, `your-secret`, `your-s2s-secret`, `s2s-secret`, `replace-with-a-real-secret`. Generate a value with `openssl rand -hex 32`.

## Tools

All tools are prefixed `dandh_`. The account number and company always come from the connection's credentials; tools do not accept `accountNumber` / `company` arguments (the order tools reject them as unknown fields, the read tools ignore them).

| Tool | Surface | Calls | Access |
|---|---|---|---|
| `dandh_get_item` | REST | `GET .../items/{itemId}` | read |
| `dandh_search_items` | REST | `GET .../items?vendorItemId\|customerItemNumber\|universalProductCode\|items\|vendorItemIds\|customerItemNumbers` (exactly one) | read |
| `dandh_get_price` | REST | `GET .../items/{itemId}/price?quantity=` | read |
| `dandh_get_prices_bulk` | REST | `GET .../items/price/bulk?items=` (max 50) | read |
| `dandh_get_availability` | REST | `GET .../items/{itemId}/availability` | read |
| `dandh_get_availability_bulk` | REST | `GET .../items/availability/bulk` (max 50) | read |
| `dandh_get_price_and_availability` | REST | `GET .../items/{itemId}/priceAndAvailability?quantity=` | read |
| `dandh_get_price_and_availability_bulk` | REST | `GET .../items/priceAndAvailability/bulk` (max 50) | read |
| `dandh_list_carriers` | REST | `GET .../carriers?shipMode=` | read |
| `dandh_get_order_tracking` | REST | `GET .../salesOrders/{id}/tracking` | read |
| `dandh_list_order_tracking` | REST | `GET .../salesOrders/tracking?orderNumber\|purchaseOrderNumber\|invoiceNumber` | read |
| `dandh_create_sales_order` | REST | `POST .../salesOrders` | **WRITE** |
| `dandh_xml_get_price_availability` | XML | `price` / `availability` (<=50 items) / `price-availability` (<=25) | read |
| `dandh_xml_item_inquiry` | XML | `itemInquiry` (D&H or MFR part number + quantity) | read |
| `dandh_xml_get_order_status` | XML | `orderStatus` by PO / order / invoice (<=50) | read |
| `dandh_xml_create_order` | XML | `orderEntry` | **WRITE** |

`...` = `/customerOrderManagement/v2/customers/{accountNumber}`. Paginated REST tools (`search`, `carriers`, `list_order_tracking`) return one page plus the `scrollId`; pass it back as `scrollId` for the next page. They never loop automatically.

Warehouse/branch values - REST: `BR01` Mid-Atlantic, `BR03` Toronto, `BR04` West Coast, `BR05` Midwest, `BR06` Atlanta, `BR08` Vancouver. XML US: Harrisburg, California, Chicago, Atlanta; XML CA: Toronto, Vancouver. XML carriers: Pickup, UPS, FedEx, USPS; services: Pickup, Ground, 2nd Day Air, Next Day Air, Red Sat Del, FirstClassMail and PriorityMail (USPS only).

## Order safety

`dandh_create_sales_order` and `dandh_xml_create_order` can **place real, billable purchase orders** and are annotated `destructiveHint: true`, `readOnlyHint: false`, `idempotentHint: false`.

**Preview by default.** Without `confirm: true` an order tool only builds and validates the request, runs every cap check and returns a preview (`status: "preview"`, `placed: false`): the lines with quantities, branch and shipping choices, unit prices (with their source: the caller's, or D&H's current price), the estimated total (or `"unknown"`) and the caps that apply. Nothing is sent to D&H's order endpoint; only read-only price lookups are made. Set `confirm: true` to place the order. Previews do not reserve the PO number.

**Preview/confirm binding.** The preview returns a `confirmToken`. A `confirm: true` call must pass it back with the same order; the token is an HMAC-SHA256 over the normalized order (as built after validation, so any change to a line, quantity, branch, PO, shipping choice or caller price invalidates it, regardless of argument order) and a hash of the account identity, plus an issue time. A missing or non-matching token is refused ("This order doesn't match a preview..."); a token older than 30 minutes is refused ("This preview has expired..."). The key is 32 random bytes generated per process, or `DANDH_CONFIRM_SECRET` if set. **A per-process key means the preview and the confirm must reach the same replica**; behind more than one replica, set the same `DANDH_CONFIRM_SECRET` on all of them (tokens also survive a restart then).

- Orders **cannot be cancelled via the API**.
- **PO numbers must be unique** per account; a duplicate is rejected by D&H. In addition, this server remembers confirmed POs in memory (per account number / XML user code, case-insensitive; the PO is Unicode NFKC-normalized, trimmed and inner whitespace runs collapsed, so fullwidth digits or a non-breaking space do not make a "different" PO; 24 hours; at most 200 per account identity) and refuses to send the same PO twice from the same process. The PO stays reserved when the send succeeded or its outcome is unclear (network error or timeout on the order request, 5xx); it is released when D&H definitively rejects the request (4xx, or an XML `failure` response) or when the failure happened before anything was sent (OAuth token failure, bad endpoint configuration, request could not be built). The PO is sent to D&H (in the pre-confirm lookup and the order itself) in that normalized form, with its case kept; only the local duplicate check ignores case, and the confirm token covers the normalized PO. An identity with 200 unexpired POs is refused ("This connection has reached its limit of 200 orders in 24 hours..."). The registry holds at most 5000 entries overall; when full, the oldest entry is evicted. The D&H PO lookup before confirm is the main duplicate check; this registry is a backstop. The registry is **per process (per replica)** and is lost on restart: **run a single replica** until there is a shared store.
- **Pre-confirm PO lookup at D&H.** After the cap checks and the local PO reservation, and before the order is sent, a confirmed order looks the PO up at D&H (REST: `GET .../salesOrders/tracking?purchaseOrderNumber=...`, the same call as `dandh_list_order_tracking`; XML: an `orderStatus` request by `PONUM`, as in `dandh_xml_get_order_status`). If D&H shows an order with that PO, the order is refused and nothing is sent. The check **fails closed**: a lookup error, a 404, or a response that is not clearly "no orders" also refuses the order (with a "couldn't check" message). In both cases the local reservation is released. This also covers a connector restart or another replica having forgotten the PO.
- **Any special instructions / remarks put the order on HOLD** for manual D&H review (XML remarks max 58 characters).
- `allowPartialShipment` / `allowBackOrder` (XML `PARTSHIPALLOW` / `BACKORDERALLOW`) default to *allowed*; setting both to no can make an order fail if it cannot be filled in full.
- Order POSTs are **never retried automatically** (no retry on 5xx, network errors or 401). After an ambiguous failure, look the PO up (`dandh_list_order_tracking` / `dandh_xml_get_order_status`) before resubmitting.
- Fields are validated locally (branches, carriers/services, sizes, quantities) before anything is sent.
- Agents should confirm price and stock first and obtain explicit user confirmation of every line before calling a write tool with `confirm: true`.

**Caps** (env, checked at startup, defaults in the configuration table; an invalid value stops the server): `DANDH_MAX_ORDER_LINES` (25), `DANDH_MAX_LINE_QUANTITY` (100), `DANDH_MAX_ORDER_VALUE` (5000) and `DANDH_MAX_UNIT_PRICE` (25000). Order value is the sum of quantity x **D&H's returned price** (REST `GET .../items/{id}/price`, XML `price` request), looked up for every line in both preview and confirm. A caller-supplied `unitPrice` / `price` is validated and sent to D&H but is never used in the value or unit-price cap math. With `confirm: true`, if D&H returns no price for any line the order is refused and nothing is placed; the preview shows `"unknown"` and says confirm will be refused. Line-count and quantity errors suggest separate user-approved orders or asking whoever runs the connector to raise the variable; the order-value error never suggests splitting.

**Prices** (`unitPrice` / `price`) must be a finite number greater than 0, with at most 2 decimal places. They do not affect the caps.

**Ship-to addresses.** XML `shipTo` text fields (name, attention, address, address2, city, zip) only allow letters (including accented), digits, spaces and `. , ' - # / &`, with the documented maximum lengths (name 25, attention 30, address 30, address2 30, city 18, zip 10); `state` is exactly two letters; `dropShipPassword` is up to 30 printable characters. REST `shipping.address` must be a flat object of text values with only these keys: `name`, `attention`, `address`, `address1`, `address2`, `city`, `state`, `province`, `zip`, `postalCode`, `country` (D&H's real field names are unconfirmed, see below), at most 12 keys, each value at most 60 characters and using the same character set.

## Network hardening

All requests to D&H use `redirect: "error"`, so a redirect response fails the call instead of being followed with credentials. OAuth tokens are cached per credential set, bounded to 500 entries (least recently used evicted, expired entries dropped). Literal secret redaction in logs and errors skips secrets shorter than 6 characters (pattern-based redaction still applies). Unexpected errors in the HTTP transport are logged (redacted) and answered with a 500 `{"error":"Internal server error"}`.

## Unconfirmed against live D&H

This server has not been exercised against live D&H systems. D&H's REST portal documentation is behind login; the REST paths were taken from a community n8n node and a competing connector's tool list, and the XML behaviour from D&H's public US XML guide (DH.IS.WEB.XML.1, Dec 2024).

- **Production REST base URL** `https://api.dandh.com` is a guess; only `https://test.api.dandh.com` appears in the community node.
- **REST response shapes** are unknown. JSON is returned as received, untyped.
- **Bulk query encoding**: lists are sent comma-separated (`items=A,B`); D&H may expect repeated parameters.
- **`quantity`** is sent on `/price` as well as `/priceAndAvailability` (the community node does this).
- **scrollId**: read from the body (`scrollId`) or the `x-scroll-id` header; a header value is added to the returned object when the body has none. `pageSize` is capped locally at 100 (not a D&H limit).
- **Order body** (`customerPurchaseOrder`, `specialInstructions`, `freightBillingAccount`, `shipping{carrier, serviceType, allowPartialShipment, allowBackOrder, address}`, `shipments[{branch, lines[{itemId, orderQuantity, unitPrice}]}]`) mirrors the n8n node; `shipping.address` is validated (flat text values, allow-listed keys and characters; see Order safety) and otherwise sent as given - its field names are a guess. `branch` is required locally per shipment, and `carrier`/`serviceType` must be given together - both are local choices.
- **Price lookup for the order-value cap** (REST): the price response shape is unknown, so the unit price is read from the first of `unitPrice`, `customerPrice`, `yourPrice`, `netPrice` or `price` found in the response (up to 3 levels deep). If none is found for a line, confirmed orders are refused (nothing placed) and the user is told to place it on dandh.com.
- **PO lookup before confirm** (fails closed, so a wrong guess blocks orders rather than risking a duplicate). REST: the `GET .../salesOrders/tracking?purchaseOrderNumber=` response is assumed to be a JSON array of orders, or an object holding the array under one of `salesOrders`, `orders`, `elements`, `content`, `data`, `results`, `items`; only an **empty** such array means "no order". A 404, an empty body or any other shape refuses the order. XML: an `orderStatus` request by `PONUM` is assumed to return `STATUS` success with no `ORDERSTATUS` element (or a `failure` whose whole `MESSAGE` is exactly "No orders found", optional trailing period, any case) when nothing matches, and `ORDERSTATUS` elements with an `ORDERNUM` when it does; anything else refuses the order. If D&H answers differently, confirmed orders will be refused with "Couldn't check D&H..." until this is adjusted.
- **"No orders found" wording (XML)**: UNVERIFIED. The dhXML guide (DH-IS-WEB-XML_US) defines no structured status or code for "no orders", only free-text `MESSAGE`, so detection is an anchored full-message match on that one assumed phrase. Any other failure text refuses the order ("Couldn't check D&H...").
- **Account number** is validated locally as exactly 10 digits; the REST warehouse codes are validated against the six known values regardless of company.
- **Token response** is assumed to contain `access_token` and `expires_in` (5-minute fallback); 400/401 from the token endpoint is treated as bad credentials.
- **HTTP error mapping** (400 request contents/duplicate PO, 401 credentials, 403 entitlement) assumes D&H returns those statuses with a JSON `message`/`error` field.
- **Canadian XML**: the Canadian guide (DH-IS-WEB-XML_CA.pdf) was not available. The endpoint `https://www.dandh.ca/dhXML/xmlDispatch` is assumed (override with `DANDH_XML_URL`); CA branches (Toronto, Vancouver) come from the brief; CA carrier/service values are not enum-validated (length only); `EXPECTEDSHIPDATE` is rejected for CA; other element differences, if any, are unknown.
- **XML test environment**: `DANDH_ENVIRONMENT` does not change the XML endpoint (D&H uses a separate test UserCode, not a separate host, per the automation guide).
- **XML submission** uses the documented form POST (`xmlDoc` field); the raw-body and SOAP methods are not used.
- **Item Inquiry** money fields come back as strings like `$39.72`; they are parsed to numbers.

## Development

```bash
npm install
npm run build
npm test
npm run lint   # tsc --noEmit
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode D&H credentials arrive on each request as `X-DandH-*` headers; they are not read from the environment.

```bash
docker build -t dandh-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:8080:8080 \
  dandh-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, passes no `DANDH_*` credentials, and publishes `127.0.0.1:8080:8080`. A project `.env` is interpolation only - do not add `env_file` to the gateway service.

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_MODE=env \
  -e DANDH_CLIENT_ID=your-client-id \
  -e DANDH_CLIENT_SECRET=your-client-secret \
  -e DANDH_ACCOUNT_NUMBER=0000000000 \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -p 127.0.0.1:8080:8080 \
  dandh-mcp
```

Local HTTP without a secret is development-only (binds `127.0.0.1`, logs a warning):

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

A signed gateway request:

```bash
curl -sS http://127.0.0.1:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-gateway-s2s: $X_GATEWAY_S2S" \
  -H "x-dandh-client-id: $DANDH_CLIENT_ID" \
  -H "x-dandh-client-secret: $DANDH_CLIENT_SECRET" \
  -H "x-dandh-account-number: $DANDH_ACCOUNT_NUMBER" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Verify in the D&H sandbox before live ordering

1. **Does the tracking / order-status endpoint show just-placed orders?** The pre-confirm PO check only protects against duplicates if an order placed a moment ago is already visible to `GET .../salesOrders/tracking?purchaseOrderNumber=` (REST) and to an `orderStatus` request by `PONUM` (XML). If D&H lags, the in-process registry is the only guard.
2. **Which field `extractUnitPrice` should read** from the REST price response. It currently takes the first of `unitPrice`, `customerPrice`, `yourPrice`, `netPrice`, `price`; confirm the real field and tighten it, because this value drives the order-value and unit-price caps.
3. **Quantity-break pricing.** Confirm the per-quantity price lookup (`/items/{id}/price?quantity=N`) matches what D&H bills for an order of that quantity, since the cap math multiplies that unit price by the line quantity.
