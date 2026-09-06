import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();

const serverEnv = path.join(root, "server", ".env");
const serverExample = path.join(root, "server", ".env.example");
const clientEnv = path.join(root, "client", ".env.local");
const clientExample = path.join(root, "client", ".env.local.example");

function ensureFile(target, source, fallback) {
  if (fs.existsSync(target)) return;
  if (fs.existsSync(source)) fs.copyFileSync(source, target);
  else fs.writeFileSync(target, fallback, "utf8");
}

ensureFile(
  serverEnv,
  serverExample,
  `PORT=4000
JWT_SECRET=${crypto.randomBytes(48).toString("base64url")}
JWT_EXPIRES_IN=7d
CLIENT_ORIGIN=http://localhost:3000
CLIENT_ORIGINS=http://localhost:3000
TRUST_PROXY=0
DB_PATH=./data/sakhya.db
`
);

if (fs.existsSync(serverEnv)) {
  const current = fs.readFileSync(serverEnv, "utf8");
  if (current.includes("change_this_to_a_long_random_string")) {
    fs.writeFileSync(serverEnv, current.replace("change_this_to_a_long_random_string", crypto.randomBytes(48).toString("base64url")), "utf8");
  }
}

ensureFile(
  clientEnv,
  clientExample,
  `NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
`
);

console.log("Sakhya environment files are ready.");
