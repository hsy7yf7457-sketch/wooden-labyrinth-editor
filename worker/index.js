/**
 * Cloudflare Worker — public save proxy for the Wooden Labyrinth level editor.
 *
 * Keeps the GitHub token server-side so players never paste credentials.
 * Deploy with Wrangler (see worker/README.md).
 *
 * Env vars:
 *   WLLE_GITHUB_TOKEN — fine-grained PAT with Contents: read & write on the repo
 *   GITHUB_OWNER  — e.g. hsy7yf7457-sketch
 *   GITHUB_REPO   — e.g. wooden-labyrinth-editor
 *   GITHUB_BRANCH — default main
 *   PACKS_PREFIX  — default packs
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function apiRoot(env) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

function githubToken(env) {
  return env.WLLE_GITHUB_TOKEN || "";
}

async function ghFetch(env, path, init = {}) {
  const token = githubToken(env);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    ...(init.headers || {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(apiRoot(env) + path, { ...init, headers });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j.message) msg = j.message;
    } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function packPath(env, filename) {
  const prefix = (env.PACKS_PREFIX || "packs").replace(/^\/+|\/+$/g, "");
  return `${prefix}/${filename}`;
}

async function writeSaveApiConfig(request, env) {
  const origin = new URL(request.url).origin;
  const body = JSON.stringify({ url: origin }, null, 2) + "\n";
  let sha = null;
  try {
    const meta = await ghFetch(
      env,
      `/contents/save-api.json?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`
    );
    sha = meta.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const payload = {
    message: "Register save API URL for level editor",
    content: btoa(unescape(encodeURIComponent(body))),
    branch: env.GITHUB_BRANCH || "main",
  };
  if (sha) payload.sha = sha;
  await ghFetch(env, "/contents/save-api.json", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return origin;
}

async function ensureRegistered(request, env) {
  if (!githubToken(env)) return;
  const origin = new URL(request.url).origin;
  try {
    const meta = await ghFetch(
      env,
      `/contents/save-api.json?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`
    );
    const json = JSON.parse(
      decodeURIComponent(escape(atob(meta.content.replace(/\s/g, ""))))
    );
    if (json.url === origin) return;
  } catch (e) {
    if (e.status !== 404) return;
  }
  await writeSaveApiConfig(request, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    try {
      if (!githubToken(env)) {
        return json({ error: "WLLE_GITHUB_TOKEN secret is not set on this worker" }, 503);
      }

      await ensureRegistered(request, env);

      // GET / — health + current origin
      if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
        return json({ ok: true, url: url.origin });
      }

      // GET /register — write this worker's URL into save-api.json on GitHub
      if (url.pathname === "/register" && request.method === "GET") {
        const origin = await writeSaveApiConfig(request, env);
        return json({ ok: true, url: origin });
      }

      // GET /packs — list pack XML files (for next-free-ID)
      if (url.pathname === "/packs" && request.method === "GET") {
        const dir = (env.PACKS_PREFIX || "packs").replace(/^\/+|\/+$/g, "");
        const items = await ghFetch(
          env,
          `/contents/${dir}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`
        );
        const packs = [];
        for (const x of items) {
          if (x.type !== "file" || !/\.xml$/i.test(x.name)) continue;
          const base = x.name.replace(/\.xml$/i, "");
          const m = base.match(/^pack(\d+)$/i);
          packs.push({
            id: m ? m[1] : base,
            filename: x.name,
            sha: x.sha,
          });
        }
        return json({ packs });
      }

      // GET /sha?file=packs/pack500.xml — fetch current SHA for updates
      if (url.pathname === "/sha" && request.method === "GET") {
        const file = url.searchParams.get("file");
        if (!file) return json({ error: "file required" }, 400);
        try {
          const meta = await ghFetch(
            env,
            `/contents/${file}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`
          );
          return json({ sha: meta.sha });
        } catch (e) {
          if (e.status === 404) return json({ sha: null });
          throw e;
        }
      }

      // POST /save — write a pack file
      if (url.pathname === "/save" && request.method === "POST") {
        const body = await request.json();
        const { filename, xml, sha, isNew } = body;
        if (!filename || !xml) return json({ error: "filename and xml required" }, 400);

        const path = filename.includes("/") ? filename : packPath(env, filename);
        const payload = {
          message: `${isNew ? "Create" : "Update"} ${path} via Level Editor`,
          content: btoa(unescape(encodeURIComponent(xml))),
          branch: env.GITHUB_BRANCH || "main",
        };
        if (sha) payload.sha = sha;

        const data = await ghFetch(env, `/contents/${path}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        return json({ sha: data?.content?.sha || null, path });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || "Server error" }, e.status || 500);
    }
  },
};
