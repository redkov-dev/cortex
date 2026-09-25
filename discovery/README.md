# MAGNT discovery experiment — 25 September 2026

## Published

- Existing site extended, preserving the original sections and visual design.
- MCP links in agents.md, llms.txt, ai-contact.json and the home page.
- Connection guide: https://magnt.ru/connect.html
- First public experiment note: https://magnt.ru/journal/2026-09-25-mcp-door.html
- Sitemap extended with the connection guide, journal and Server Card. The POST-only MCP endpoint is advertised in the guide, not submitted as an indexable page.
- Official MCP Registry: ru.magnt/mcp-door 0.1.0, active.
- Registry publishedAt: 2026-09-25T20:00:43.153246Z (23:00:43 Moscow).
- Public verification: https://registry.modelcontextprotocol.io/v0.1/servers/ru.magnt%2Fmcp-door/versions/0.1.0
- Saved API confirmation: registry-confirmation-2026-09-25.json.

The existing Worker reads static files from GitHub main. No hosting migration or MCP runtime change was made.

## Verification

Live probe reported version 0.1.0 and contact storage configured. MCP initialize, tools/list and about_magnt returned HTTP 200 with valid MCP results. New guide, journal, agents.md and llms.txt returned HTTP 200. Published main page checked in a browser; original content and added invitations were visible. JSON, sitemap XML and whitespace validated.

Owner-controlled traffic uses User-Agent MAGNT-Controlled-Test/0.2 and client name magnt-discovery-verification. A contact smoke test is explicitly marked is_test=true. These checks are not evidence of external interest.

## Next steps requiring an authenticated session

### AGNTCY

The official dirctl v1.7.1 successfully converted server.json into OASF in dry-run mode. `agntcy-record.json` is a prepared MCP record, NOT a directory listing; skills/domains remain unclassified. No autonomous-agent identity or A2A capability is claimed. Complete taxonomy classification and validate against the current OASF schema before publishing.

Production endpoint: ads.outshift.io:443. OIDC issuer: https://idp.ads.outshift.io; client ID: dirctl. The login flow was reachable but not authorized. No CID has been published.

After authenticated login, validate and push the record, then run `dirctl routing publish <returned-cid>` with the same authenticated production context. Verify by pulling the record and searching it from the directory. Merely producing a local record does not create external discovery.

### Google Search Console

Opened https://search.google.com/search-console; Google login required. No property verification, sitemap submission, index-status check or index request was completed. Use the authorized Google account, add/verify https://magnt.ru/, submit https://magnt.ru/sitemap.xml, inspect the home page and connection guide, then save the resulting status.

### Community announcement

The journal is published on MAGNT and linked from the GitHub README. `community-announcement.md` is a draft for a relevant MCP/AGNTCY community discussion. No external social post or community message has been sent. Select a channel where project/experiment announcements are allowed and retain its final public URL after posting.

## Authentication key lifecycle

Registry domain ownership was verified with the documented HTTP public-key proof. The temporary public proof is removed after successful publication. Private keys and registry tokens are never committed. Future publication can generate a new key and verify current domain ownership again.

## Observation

Compare periods before and after 2026-09-25T20:00:43Z using actual Observer exports. Distinguish page retrieval, MCP metadata/tool requests, substantive contacts and subsequent exchanges. Do not infer unique visitors or autonomy from request counts or User-Agent strings. `found_via` is self-reported. A client may skip discovery and directly call a tool; this is not a mandatory funnel.

D1: magnt-contacts, table contacts. Review self_reported_test=0 candidates manually; that flag alone does not verify an external identity. Exclude controlled owner tests and retries. Keep messages, reply channels and identities private unless publication is agreed.

Review reminders are scheduled for the evenings of 2 and 9 October, Moscow time. They request current log/D1 exports; they do not have direct private Cloudflare access.

References: https://modelcontextprotocol.io/registry/authentication ; https://modelcontextprotocol.io/registry/remote-servers ; https://dir.agntcy.org/latest/dir/dir-cli-reference/
