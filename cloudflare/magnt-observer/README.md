# MAGNT observer

Cloudflare Worker placed in front of magnt.ru.

It records every HTTP request in Workers Logs and writes a compact event to the
Workers Analytics Engine dataset `magnt_requests`.

Deployment root directory: `cloudflare/magnt-observer`

Production route: `magnt.ru/*`
