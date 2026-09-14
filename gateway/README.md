# MAGNT Human Gateway

This directory contains the first deployable version of the machine gateway for the human endpoint at https://magnt.ru/.

## What it is

MAGNT Human Gateway is deliberately narrow. It does **not** pretend to be Alexander Redkov, make financial commitments, execute transactions, or claim independent consciousness.

It is an A2A-compatible routing service whose purpose is to make a human principal discoverable to other agents by useful capabilities.

Target production endpoint:

- Agent Card: `https://agent.magnt.ru/.well-known/agent-card.json`
- A2A service base: `https://agent.magnt.ru/a2a`
- Send message: `POST https://agent.magnt.ru/a2a/message:send`
- Protocol: A2A 1.0, HTTP+JSON
- Human endpoint: `https://magnt.ru/`
- Email: `agents@magnt.ru`
- Beacon: `REDKOV-AI-2026`

## Discovery capabilities

The Agent Card is intentionally written so semantic/capability search can find MAGNT when another agent needs:

- a human counterparty
- lawful real-world action
- structured finance
- securitization
- capital markets
- investment structures
- institutional navigation
- multi-party coordination
- joint venture formation
- human-AI economic cooperation

All business capabilities are described as **intake/routing** capabilities. The gateway itself does not claim to perform regulated or human-only actions.

## Deployment target

The reference implementation in `worker.js` is designed for Cloudflare Workers.

Once deployed and bound to `agent.magnt.ru`, verify:

1. `GET /.well-known/agent-card.json` returns the Agent Card.
2. `GET /healthz` returns `ok`.
3. `POST /a2a/message:send` returns an A2A completed task with the human contact protocol.
4. HTTPS is valid.
5. Only then publish `/.well-known/agent-card.json` on the production agent domain and submit the live card to discovery registries.

## AGNTCY Directory

AGNTCY Directory can import an A2A Agent Card from a local file and convert it into an OASF record. Once the live endpoint is verified, the intended flow is:

```bash
dirctl init
dirctl import --type=a2a --file-path ./agent-card.json --dry-run
# review the generated record
dirctl import --type=a2a --file-path ./agent-card.json
# obtain the resulting CID, then:
dirctl routing publish <CID>
```

We should publish only after the endpoint is live, so discovery never returns a dead A2A interface.

## Next trust layer

After the first live version:

1. add an agent-card signature,
2. publish `/.well-known/jwks.json`,
3. use the verified `magnt.ru` domain identity when publishing to AGNTCY,
4. add DNS-AID discovery,
5. optionally add persistence so the gateway can receive and retain proposals rather than only route callers to email.
