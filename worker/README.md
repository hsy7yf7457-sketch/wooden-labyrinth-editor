# Save proxy worker

Players save packs through this Cloudflare Worker so they never need a GitHub token.

## One-time setup (GitHub Actions — recommended)

Add three **repository secrets** so deploys run from GitHub (no tokens in chat):

https://github.com/hsy7yf7457-sketch/wooden-labyrinth-editor/settings/secrets/actions

| Secret | Value |
|--------|--------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with **Workers Scripts: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → **Account ID** (right sidebar) |
| `WORKER_GITHUB_TOKEN` | Fine-grained GitHub PAT on **wooden-labyrinth-editor** with **Contents: read & write** |

Create the Cloudflare token: https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Edit Cloudflare Workers** template (or custom with Workers Scripts Edit).

Create the GitHub PAT: https://github.com/settings/tokens?type=beta → fine-grained → repo **wooden-labyrinth-editor** only.

When all three secrets exist, say **“secrets are set”** in the editor chat — the agent will run **Deploy save worker** from Actions. That will:

1. Deploy `wl-editor-save` to Cloudflare
2. Write the real `workers.dev` URL into `save-api.json`
3. Upload `WLLE_GITHUB_TOKEN` to the worker runtime

## Manual fallback (Cloudflare dashboard)

If you already deployed via Cloudflare’s GitHub integration:

1. Add secret **`WLLE_GITHUB_TOKEN`** on the worker (Settings → Variables and Secrets)
2. Set deploy command: `npm install && npm run deploy`
3. Retry the build, or paste the **Visit** URL once in the editor’s “Connect save server” dialog

The editor POSTs to `{url from save-api.json}/save` and GETs `{url}/packs`.
