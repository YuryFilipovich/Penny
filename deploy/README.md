# Deploy Penny with Docker Compose

The container serves the built Svelte app and API on port 8787 internally. Compose publishes it on `127.0.0.1:18787` by default. Change `PENNY_BIND_IP` only if trusted devices or a proxy on another host must reach it. Penny has no authentication; anyone who can reach it can use your provider quota and submit stock purchases to Grocy.

## Configure

```sh
cp .env.example .env
```

Set `OPENAI_API_KEY`, `JEV_API_KEY`, `GROCY_URL`, and `GROCY_API_KEY` in `.env`. Never commit `.env`. Set `APP_ORIGINS` to the exact address or addresses used in the browser, including the scheme and port when present. For example, a reverse proxy at `https://penny.example.com` needs `APP_ORIGINS=https://penny.example.com`. If you publish directly on a LAN interface, use that interface in `PENNY_BIND_IP` and its browser origin in `APP_ORIGINS`.

`GROCY_URL` must be reachable **from the Penny container**. `127.0.0.1` inside the container means Penny itself, so replace the sample URL with a reachable Grocy address or a hostname on a shared Docker network. Keep provider and Grocy keys in the backend environment only; never use `VITE_` for secrets.

## Start and check

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:18787/api/health
curl --fail http://127.0.0.1:18787/api/usage
```

Use the published address in those `curl` commands if you changed the binding. `/api/health` reports whether the required keys are configured, not whether provider calls or Grocy access succeed. The sample preview is useful for checking the UI without paid calls or stock writes.

If you already run Caddy on the same host, adapt [Caddyfile.penny](Caddyfile.penny) and merge the site block into your existing Caddyfile. Adjust the site address and upstream to your environment. Add authentication at the proxy before allowing access from untrusted networks. Validate and reload Caddy using its own deployment procedure.

## Limits and storage

The default is 10 accepted extraction attempts per Europe/Warsaw calendar day, shared by all clients. Failed or cancelled scans count after processing starts; invalid uploads, missing API keys, and sample previews do not. Set `DAILY_RECEIPT_LIMIT` and `RECEIPT_TIMEZONE` in `.env` to change this. Apply Compose environment changes with `docker compose up -d`; a container restart alone does not reload them.

The `penny-usage` volume stores only the daily counter. Reviews and PDFs are temporary and disappear when the browser page closes or reloads; Penny does not keep a receipt archive. Do not run `docker compose down -v` unless you intend to erase the counter. Run a single Penny instance because quota reservations and Grocy import locking are process-local.

The container runs as a non-root user with a read-only filesystem, temporary `/tmp`, dropped capabilities, and resource limits. After updating the Node image version in the Dockerfile, pull and rebuild with `docker compose build --pull` and apply it with `docker compose up -d`; inspect logs with `docker compose logs --tail=100 penny`. Keep the image version updated for future security releases.

## Grocy connection check

To test Grocy connectivity without changing stock, make a read request from inside the Penny container. This prints only the HTTP status:

```sh
docker compose exec penny node --input-type=module -e 'const root=process.env.GROCY_URL.replace(/\/+$/, ""); const api=root.endsWith("/api")?root:root+"/api"; const r=await fetch(api+"/system/info",{headers:{"GROCY-API-KEY":process.env.GROCY_API_KEY},signal:AbortSignal.timeout(15000)}); console.log("Grocy HTTP",r.status); process.exit(r.ok?0:1);'
```

The full live flow needs a receipt that you intentionally review and confirm. Check Grocy before retrying a confirmation after losing a page or server state, because late or unlogged writes cannot always be proven duplicate-free.
