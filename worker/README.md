# Save proxy worker

Players save packs through this Cloudflare Worker so they never need a GitHub token.

## One-time setup

1. Install Wrangler: `npm install -g wrangler`
2. Log in: `wrangler login`
3. Create a fine-grained GitHub PAT with **Contents: read & write** on `wooden-labyrinth-editor`
4. Deploy:

```bash
cd worker
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

5. Copy the worker URL (e.g. `https://wl-editor-save.<account>.workers.dev`) into `SAVE_API_URL` in `editor.js`, or route it on your domain.

The editor POSTs to `{SAVE_API_URL}/save` and GETs `{SAVE_API_URL}/packs`.
