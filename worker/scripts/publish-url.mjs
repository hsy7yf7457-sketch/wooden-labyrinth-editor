/**
 * After `wrangler deploy`, parse the workers.dev URL from stdout and
 * write save-api.json to GitHub. Used by Cloudflare Builds and GitHub Actions.
 *
 * Env: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)
 */
import { readFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER || "hsy7yf7457-sketch";
const repo = process.env.GITHUB_REPO || "wooden-labyrinth-editor";
const branch = process.env.GITHUB_BRANCH || "main";

if (!token) {
  console.warn("publish-url: GITHUB_TOKEN not set — skipping save-api.json update");
  process.exit(0);
}

let url = process.env.WORKER_URL || "";
if (!url) {
  const input = readFileSync(0, "utf8");
  const m = input.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/);
  if (m) url = m[0];
}

if (!url) {
  console.warn("publish-url: could not find workers.dev URL in deploy output");
  process.exit(0);
}

url = url.replace(/\/$/, "");
const body = JSON.stringify({ url }, null, 2) + "\n";
const content = Buffer.from(body, "utf8").toString("base64");

const api = `https://api.github.com/repos/${owner}/${repo}/contents/save-api.json`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

let sha = null;
const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
if (getRes.ok) sha = (await getRes.json()).sha;
else if (getRes.status !== 404) {
  console.error("publish-url: GET failed", getRes.status, await getRes.text());
  process.exit(1);
}

const putRes = await fetch(api, {
  method: "PUT",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Set save API URL after worker deploy",
    content,
    branch,
    ...(sha ? { sha } : {}),
  }),
});

if (!putRes.ok) {
  console.error("publish-url: PUT failed", putRes.status, await putRes.text());
  process.exit(1);
}

console.log(`publish-url: wrote ${url} to save-api.json`);
