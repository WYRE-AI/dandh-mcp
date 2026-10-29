# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release: MCP server for D&H Distributing's Customer Order Management REST API (OAuth2 client credentials) and XML integration (UserCode/Password).
- REST tools: `dandh_get_item`, `dandh_search_items`, `dandh_get_price`, `dandh_get_prices_bulk`, `dandh_get_availability`, `dandh_get_availability_bulk`, `dandh_get_price_and_availability`, `dandh_get_price_and_availability_bulk`, `dandh_list_carriers`, `dandh_get_order_tracking`, `dandh_list_order_tracking`, `dandh_create_sales_order`.
- XML tools: `dandh_xml_get_price_availability`, `dandh_xml_item_inquiry`, `dandh_xml_get_order_status`, `dandh_xml_create_order`.
- HTTP transport with fail-closed `X-Gateway-S2S` verification and `AUTH_MODE=env|gateway` credential sourcing from `X-DandH-*` headers.
