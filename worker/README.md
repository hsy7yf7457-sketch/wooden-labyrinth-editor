# Save proxy worker

Players save packs through this Cloudflare Worker so they never need a GitHub token.

If Save shows **“Could not reach the save server”**, this worker has not been deployed yet.

## One-time setup (GitHub Actions — recommended)

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. Create a Cloudflare API token with **Workers Scripts: Edit** permission.
3. Copy your Cloudflare **Account ID** from the dashboard sidebar.
4. Create a fine-grained GitHub PAT with **Contents: read & write** on `wooden-labyrinth-editor`.
5. Add these **repository secrets** on GitHub (`Settings → Secrets → Actions`):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `WORKER_GITHUB_TOKEN` (the PAT from step 4)
6. Open **Actions → Deploy save worker → Run workflow** (or push any change under `worker/`).

The worker URL will be `https://wl-editor-save.<your-cloudflare-subdomain>.workers.dev`.

After the first deploy, open that URL with **`/register`** appended once (while `GITHUB_TOKEN` is set on the worker). That writes the URL into `save-api.json` in the repo so the editor finds it automatically.

If that differs from a URL stored in the browser, clear it:

```js
localStorage.removeItem("wlle.saveApi");
```

## Manual deploy

```bash
cd worker
npm install
wrangler login
wrangler secret put GITHUB_TOKEN   # paste a GitHub PAT with Contents write
wrangler deploy
```

The editor POSTs to `{SAVE_API_URL}/save` and GETs `{SAVE_API_URL}/packs`.
