// Add or remove the runner public IPv4 in a Hetzner Cloud firewall.
//
// The Hetzner API only offers set_rules, which replaces the whole rule set.
// Many jobs write to the same firewall, so every change reads the current
// rules, edits its own entry, writes back, and then verifies. A losing race
// is retried. An add then waits until Hetzner has applied the rules to the
// server: the rule list changes at once, the server's packet filter later.
//
// Node built-ins only. No npm install, no bundling.

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

const IP_SOURCES = [
  "https://api.ipify.org",
  "https://checkip.amazonaws.com",
  "https://ifconfig.me/ip",
];
const MAX_RULES = 50;
const ATTEMPTS = 6;
const APPLY_TIMEOUT_MS = 60000;
const APPLY_POLL_MS = 1000;

function input(name, fallback = "") {
  const key = `INPUT_${name.toUpperCase()}`;
  const value = process.env[key] ?? process.env[key.replace(/-/g, "_")] ?? "";
  return value.trim() === "" ? fallback : value.trim();
}

function saveState(key, value) {
  if (process.env.GITHUB_STATE) {
    fs.appendFileSync(process.env.GITHUB_STATE, `${key}=${value}\n`);
  }
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function defaultLabel() {
  const repo = process.env.GITHUB_REPOSITORY || "local";
  const run = process.env.GITHUB_RUN_ID || "0";
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  return `gh:${repo}:${run}:${attempt}`;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

async function discoverIp() {
  const forced = input("ip");
  if (forced) {
    if (!IPV4.test(forced)) fail(`input ip is not an IPv4 address: ${forced}`);
    return forced;
  }
  const errors = [];
  for (const url of IP_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).trim();
      if (IPV4.test(body)) return body;
      throw new Error(`not an IPv4 address: ${body.slice(0, 40)}`);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  fail(`could not discover the runner IP. ${errors.join("; ")}`);
}

function api(path, init = {}) {
  const base = input("api-base", "https://api.hetzner.cloud/v1");
  const token = input("token");
  if (!token) fail("input token is empty. Pass the Hetzner API token.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
}

async function getRules(firewallId) {
  const res = await api(`/firewalls/${firewallId}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET firewall ${firewallId} returned ${res.status}: ${JSON.stringify(body.error || body)}`);
  }
  return body.firewall.rules || [];
}

async function putRules(firewallId, rules) {
  const res = await api(`/firewalls/${firewallId}/actions/set_rules`, {
    method: "POST",
    body: JSON.stringify({ rules }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`set_rules returned ${res.status}: ${JSON.stringify(body.error || body)}`);
  }
  return body.actions || [];
}

// set_rules starts set_firewall_rules and, per attached server, an
// apply_firewall action. Until the apply is done, the server still drops this
// runner's packets, and a docker login that follows at once times out. When
// an apply for the server is already running, set_rules returns no
// apply_firewall of its own, and a later apply carries this rule. So the add
// waits for its own actions, then until the firewall runs no action at all.
async function waitApplied(firewallId, actions) {
  const started = Date.now();
  const overdue = (what) => {
    if (Date.now() - started > APPLY_TIMEOUT_MS) {
      throw new Error(`firewall ${firewallId} not applied after ${APPLY_TIMEOUT_MS / 1000} s, still running: ${what}`);
    }
  };
  const get = async (path) => {
    const res = await api(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET ${path} returned ${res.status}: ${JSON.stringify(body.error || body)}`);
    return body;
  };
  const name = (a) => `${a.command}#${a.id}`;
  console.log(`set_rules started: ${actions.map((a) => `${name(a)} ${a.status}`).join(", ") || "no actions"}`);

  const pending = new Map(actions.map((a) => [a.id, a]));
  while (pending.size > 0) {
    for (const [id, known] of pending) {
      const action = known.status === "running" ? (await get(`/firewalls/actions/${id}`)).action : known;
      if (action.status === "error") {
        throw new Error(`${action.command} on firewall ${firewallId} failed: ${JSON.stringify(action.error)}`);
      }
      if (action.status === "success") pending.delete(id);
    }
    if (pending.size === 0) break;
    overdue([...pending.values()].map(name).join(", "));
    await sleep(APPLY_POLL_MS);
  }

  while (true) {
    const running = (await get(`/firewalls/${firewallId}/actions?status=running`)).actions || [];
    if (running.length === 0) break;
    overdue(running.map(name).join(", "));
    await sleep(APPLY_POLL_MS);
  }
  console.log(`firewall ${firewallId} applied in ${Date.now() - started} ms`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mutate(rules) -> next rules; verify(rules) -> boolean
// Returns the actions of the write that verified.
async function reconcile(firewallId, mutate, verify, what) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const current = await getRules(firewallId);
      const next = mutate(current);
      if (next.length > MAX_RULES) {
        fail(`firewall ${firewallId} would hold ${next.length} rules, the limit is ${MAX_RULES}. Stale runner rules probably need a cleanup.`);
      }
      const actions = await putRules(firewallId, next);
      if (verify(await getRules(firewallId))) {
        console.log(`${what} on firewall ${firewallId}`);
        return actions;
      }
      lastError = new Error("another writer replaced the rules");
    } catch (err) {
      if (/\b40[13]\b|unauthorized|forbidden/i.test(err.message)) {
        fail(`${what} failed: ${err.message}`);
      }
      lastError = err;
    }
    await sleep(attempt * 500 + Math.floor(Math.random() * 400));
  }
  fail(`${what} failed after ${ATTEMPTS} attempts: ${lastError && lastError.message}`);
}

// Every leg of a matrix runs with the same label, so the label alone cannot
// identify a rule: leg B would replace leg A's and leg A's post step would
// delete leg B's. The description is therefore "<uuid>#<label>", and the post
// step removes that exact string.
//
// The uuid leads so that the 255 character API limit can only ever eat the
// label. A truncated uuid would break removal; a truncated label costs nothing
// but readability.
const DESC_MAX = 255;
const UUID_LEN = 36;
const LABEL_MAX = DESC_MAX - UUID_LEN - 1;

function describe(label, uuid) {
  return `${uuid}#${label.slice(0, LABEL_MAX)}`;
}

function labelOf(description) {
  const cut = (description || "").indexOf("#");
  return cut < 0 ? null : description.slice(cut + 1);
}

// An explicit operation: remove knows the label but not the id, so it clears
// every leg that carries it. Compare against the same truncation add applies.
function underLabel(rule, label) {
  return labelOf(rule.description) === label.slice(0, LABEL_MAX);
}

async function add(firewallId, port, label, ip, uuid) {
  const source = `${ip}/32`;
  const description = describe(label, uuid);
  const rule = {
    direction: "in",
    protocol: "tcp",
    port,
    source_ips: [source],
    description,
  };
  console.log(`whitelist id ${uuid}`);
  const present = (rules) => rules.some((r) => r.description === description);
  // set_rules has no version check. A writer that read the rules before this
  // write and writes after it drops this rule, and the verify inside reconcile
  // can run before that happens. Such a write lands while this job waits for
  // the apply, so the rule is checked again once the apply is done.
  for (let round = 1; round <= ATTEMPTS; round++) {
    const actions = await reconcile(
      firewallId,
      (rules) => [...rules.filter((r) => r.description !== description), rule],
      present,
      `added ${source} to tcp/${port} as ${description}`,
    );
    await waitApplied(firewallId, actions);
    if (present(await getRules(firewallId))) return description;
    console.log(`another writer dropped ${description} during the apply, adding it again`);
  }
  fail(`${description} was dropped by another writer ${ATTEMPTS} times`);
}

async function removeExact(firewallId, description) {
  await reconcile(
    firewallId,
    (rules) => rules.filter((r) => r.description !== description),
    (rules) => !rules.some((r) => r.description === description),
    `removed ${description}`,
  );
}

async function removeLabel(firewallId, label) {
  await reconcile(
    firewallId,
    (rules) => rules.filter((r) => !underLabel(r, label)),
    (rules) => !rules.some((r) => underLabel(r, label)),
    `removed every rule labelled ${label}`,
  );
}

async function main() {
  const firewallId = input("firewall-id");
  if (!firewallId) fail("input firewall-id is empty. Pass the Hetzner firewall id.");
  const port = input("port", "443");
  const label = input("label") || defaultLabel();
  const operation = input("operation", "add").toLowerCase();

  if (operation === "remove") {
    await removeLabel(firewallId, label);
    setOutput("label", label);
    return;
  }
  if (operation !== "add") fail(`operation must be add or remove, got ${operation}`);

  const ip = await discoverIp();
  const uuid = randomUUID();
  const description = await add(firewallId, port, label, ip, uuid);
  setOutput("ip", ip);
  setOutput("label", label);
  setOutput("uuid", uuid);
  setOutput("description", description);
  saveState("post", "true");
  saveState("description", description);
  saveState("firewall", firewallId);
  saveState("ip", ip);
}

async function post() {
  if (input("auto-remove", "true").toLowerCase() !== "true") {
    console.log("auto-remove is false, leaving the rule in place");
    return;
  }
  const description = process.env.STATE_description;
  const firewallId = process.env.STATE_firewall;
  if (!description || !firewallId) {
    console.log("no rule was added, nothing to remove");
    return;
  }
  await removeExact(firewallId, description);
}

(process.env.STATE_post ? post() : main()).catch((err) => fail(err.message));
