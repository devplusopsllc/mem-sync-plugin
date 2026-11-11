"use strict";

// mem-sync local UI: one plain table of folders in the claude-mem viewer's theme.
// Shared spaces are grouped by project; people, spaces and access are managed in the hub's admin UI (Admin link).
// All hub data reaches the DOM through textContent / DOM APIs only.

const $ = (sel) => document.querySelector(sel);
const THEME_KEY = "mem-sync-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

const state = {
  status: null,
  hubs: [], // HubStatus per hub, in config order (the first is the 0.9 hub)
  me: {}, // hub id -> the signed-in user there
  projects: [],
  spaces: {}, // hub id -> that hub's spaces (space ids are per hub)
  loadError: "",
  claudeMemError: "", // set when the agent can't reach local claude-mem
  syncing: false,
  connecting: false, // first-run: a Cloudflare sign-in is in progress, keep the setup view up
  rows: {}, // per-folder UI state: { pending: value, busy: bool, msg: {kind, text} }
};

/* ---------------------------------------------------------------- api */

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (method !== "GET") {
    init.headers["x-mem-sync"] = "1";
    init.headers["content-type"] = "application/json";
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

/** Ask the agent to run a sync now (fire and forget); the status poll shows its progress. */
async function kickSync() {
  try {
    await api("POST", "/local/sync");
  } catch {
    /* the periodic sync will catch up */
  }
}

/** Turn a raw error message into a sentence. */
function sentence(msg) {
  const s = String(msg || "something went wrong").trim();
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : t + ".";
}

/* ---------------------------------------------------------------- dom helpers */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "disabled" || k === "checked" || k === "selected" || k === "readOnly") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgPaths(svg, ds) {
  svg.replaceChildren(
    ...ds.map((d) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      return p;
    }),
  );
}

/** A decorative 24x24 line icon built from path data. */
function svgIcon(ds) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svgPaths(svg, ds);
  return svg;
}

const ERROR_ICON = ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7.5v5.5", "M12 16.5v.5"];

/** Avatar colors from DESIGN.md; a person always gets the same one. */
const AVATAR_COLORS = 5;
function avatarIndex(key) {
  let n = 0;
  for (const ch of String(key)) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return n % AVATAR_COLORS;
}

function avatar(user) {
  const name = String(user?.name || "").trim();
  const letter = name ? Array.from(name)[0].toUpperCase() : "?";
  const key = user?.id ?? name;
  return h("span", { class: `avatar avatar-${avatarIndex(key)}`, "aria-hidden": "true" }, letter);
}

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

function relTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (diff < 45_000) return "just now";
  if (min < 60) return `${Math.max(min, 1)} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${plural(hr, "hour")} ago`;
  const days = Math.round(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return "on " + new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "in 3 days" style time until `ms`, or "expired" once it has passed. */
function relFuture(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return "expired";
  const min = Math.round(diff / 60_000);
  if (min < 1) return "in under a minute";
  if (min < 60) return `in ${plural(min, "min", "min")}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${plural(hr, "hour")}`;
  return `in ${plural(Math.round(hr / 24), "day")}`;
}

/** Remember which keyed control has focus so a re-render can put it back. */
function captureFocus() {
  return document.activeElement?.dataset?.focus ?? null;
}
function restoreFocus(key) {
  if (!key) return;
  for (const el of document.querySelectorAll("[data-focus]")) {
    if (el.dataset.focus === key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

/** Run an action: show its error inline next to the control, refresh after success. */
async function run(errEl, fn, { button, refresh = true } = {}) {
  const focusKey = captureFocus(); // disabling a focused button drops focus; put it back afterwards
  if (errEl) errEl.textContent = "";
  if (button) button.disabled = true;
  try {
    await fn();
    if (refresh) await refreshAll();
    if (!document.activeElement || document.activeElement === document.body) restoreFocus(focusKey);
    return true;
  } catch (e) {
    if (errEl) errEl.textContent = sentence(e.message);
    return false;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

function switchButton({ on, label, focusKey, disabled, onToggle }) {
  const sw = h(
    "button",
    {
      type: "button",
      class: "switch",
      role: "switch",
      "aria-checked": on ? "true" : "false",
      "aria-label": label,
      disabled,
      dataset: { focus: focusKey },
    },
    h("span", { class: "toggle-switch", "aria-hidden": "true" }, h("span", { class: "toggle-knob" })),
    h("span", { "aria-hidden": "true" }, on ? "on" : "off"),
  );
  sw.addEventListener("click", () => onToggle(sw));
  return sw;
}

/* ---------------------------------------------------------------- theme */

const THEME_ICONS = {
  system: ["M3 5h18v11H3z", "M8 20h8", "M12 16v4"],
  light: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  dark: ["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"],
};
const THEME_NEXT = { system: "light", light: "dark", dark: "system" };
let themeFallback = "system"; // used when localStorage is unavailable

function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
    return "system";
  } catch {
    return themeFallback;
  }
}

function applyTheme() {
  const pref = themePref();
  const resolved = pref === "system" ? (darkQuery.matches ? "dark" : "light") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  const btn = $("#theme-btn");
  const label = `Theme: ${pref}. Switch to ${THEME_NEXT[pref]}.`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  svgPaths($("#theme-icon"), THEME_ICONS[pref]);
}

function initTheme() {
  applyTheme();
  $("#theme-btn").addEventListener("click", () => {
    const next = THEME_NEXT[themePref()];
    themeFallback = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* not persisted; themeFallback keeps it for this page */
    }
    applyTheme();
  });
  darkQuery.addEventListener("change", applyTheme);
}

/* ---------------------------------------------------------------- header status */

/** The header shows the first hub, as in 0.9; the Hubs section shows each hub. */
const firstMe = () => state.me[state.hubs[0]?.id] ?? null;
const isAdmin = () => firstMe()?.role === "admin";
const hubLabel = (id) => state.hubs.find((x) => x.id === id)?.label ?? "another hub";
const looksUnreachable = (msg) => /fetch|connect|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed? ?out|timeout|network|socket/i.test(msg);

const openSignIn = () => openConnection({ mode: "signin" });
const openKey = () => openConnection({ mode: "key" });
const signInNeeded = (st) => st.last_status === "signin" || Boolean(st.pending_access_hub);

function headerStatus(st) {
  if (state.syncing || st.busy) return { tone: "busy", text: "Syncing…" };
  // With several hubs the header speaks for all of them: another hub's problem must not read as "Synced".
  const attention = hubsAttention(st.hubs);
  if (attention) return { tone: "error", text: attention, fix: { label: "See hubs", run: showHubs, header: true } };
  const at = Number(st.last_cycle_at || 0);
  const err = String(st.last_error || "");
  // Sign-in problems come first: the hub calls behind loadError fail for the same reason.
  if (signInNeeded(st)) return { tone: "error", text: "Sign in needed", fix: { label: "Sign in", run: openSignIn, header: true } };
  if (st.last_status === "need_key") {
    return { tone: "error", text: "This hub needs an API key", fix: { label: "Enter key", run: openKey, header: true } };
  }
  if (st.last_status === "not_allowed") return { tone: "error", text: sentence(err || "Your account isn't allowed on this hub") };
  if (state.loadError) {
    return looksUnreachable(state.loadError)
      ? { tone: "error", text: "Hub unreachable — sync paused, will retry" }
      : { tone: "error", text: "Can't load from the hub" };
  }
  if (state.claudeMemError) return { tone: "warn", text: "Local claude-mem isn't running" };
  switch (st.last_status) {
    case "ok":
      if (st.auth === "cloudflare-access" && st.signed_in_as) {
        const exp = Number(st.session_expires_at || 0); // seconds since the epoch
        const ends = !exp ? "" : exp * 1000 > Date.now() ? ` · session ends ${relFuture(exp * 1000)}` : " · session expired";
        return { tone: "ok", text: `Signed in as ${st.signed_in_as}${ends}` };
      }
      return { tone: "ok", text: `Synced ${relTime(at)}` };
    case "unreachable":
      return { tone: "error", text: "Hub unreachable" };
    case "revoked":
      return /disabled/i.test(err)
        ? { tone: "error", text: "Your account is disabled — ask an admin", fix: { label: "Enter a new key", run: openConnection } }
        : { tone: "error", text: "Your key was rejected — ask an admin for a new one", fix: { label: "Enter a new key", run: openConnection } };
    case "paused":
      return { tone: "warn", text: "Sync paused — this claude-mem version isn't supported yet" };
    case "error":
      if (/^local claude-mem isn't running/i.test(err)) return { tone: "warn", text: "Local claude-mem isn't running" };
      if (looksUnreachable(err)) return { tone: "error", text: "Hub unreachable — sync paused, will retry" };
      return { tone: "error", text: "Last sync had problems" };
    default:
      return { tone: "idle", text: "Not synced yet" };
  }
}

function statusFacts(st) {
  const at = Number(st.last_cycle_at || 0);
  const good = Number(st.last_success_at || 0);
  return [
    ...(st.signed_in_as ? [["Signed in as", String(st.signed_in_as)]] : []),
    ["Last sync", at ? relTime(at) : "never"],
    ["Last good sync", good ? relTime(good) : "never"],
    ["Sent", String(Number(st.last_pushed || 0))],
    ["Received", String(Number(st.last_pulled || 0))],
    ["Skipped (no session)", String(Number(st.skipped_orphans || 0))],
    ["Rejected by hub (gave up after 7 days)", String(Number(st.skipped_rejected || 0))],
    ["Set aside (import failed)", String(Number(st.quarantined_pulls || 0))],
  ];
}

function renderHeader() {
  const st = state.status;
  const configured = Boolean(st?.configured);
  $("#sync-status").hidden = !configured;
  $("#conn-btn").hidden = !configured;

  const who = $("#who");
  const me = firstMe();
  if (configured && me) {
    who.replaceChildren(
      ...[
        avatar(me),
        h("span", { class: "who-name", title: me.name }, me.name),
        isAdmin() ? h("span", { class: "card-type badge-prompt" }, "Admin") : null,
      ].filter(Boolean),
    );
    who.hidden = false;
  } else {
    who.hidden = true;
  }

  const adminLink = $("#admin-link");
  const hubUrl = /^https?:\/\//i.test(String(st?.hub_url || "")) ? String(st.hub_url).replace(/\/+$/, "") : "";
  const showAdmin = configured && isAdmin() && hubUrl !== "";
  if (showAdmin) adminLink.href = `${hubUrl}/admin`;
  adminLink.hidden = !showAdmin;
  if (!configured) return;

  const v = headerStatus(st);
  const line = $("#status-line");
  if (line.textContent !== v.text) line.textContent = v.text;
  line.classList.toggle("is-error", v.tone === "error");
  $("#status-dot").className = `status-dot is-${v.tone}`;
  $("#sync-status").title = statusFacts(st).map(([k, val]) => `${k}: ${val}`).join("\n");

  const action = $("#status-action");
  action.hidden = !v.fix?.header;
  if (v.fix?.header) {
    action.textContent = v.fix.label;
    action.onclick = () => v.fix.run();
  }

  const busy = state.syncing || Boolean(st.busy);
  const btn = $("#sync-btn");
  btn.disabled = busy;
  btn.classList.toggle("spinning", busy);
  $("#sync-label").textContent = busy ? "Syncing…" : "Sync now";

  if (!$("#status-details").hidden) renderDetails(v);
}

function renderDetails(v = headerStatus(state.status)) {
  const st = state.status;
  const box = $("#status-details");
  const errors = [];
  if (state.loadError) errors.push(sentence(state.loadError));
  if (state.claudeMemError) errors.push("Local claude-mem isn't running. Start a Claude Code session to start it.");
  if (st.last_error && st.last_status !== "ok" && sentence(st.last_error) !== errors[0]) errors.push(sentence(st.last_error));
  if (st.cloudflared_error) errors.push(`Couldn't get the Cloudflare helper (cloudflared): ${sentence(st.cloudflared_error)}`);
  const fix = v.fix ? h("button", { type: "button", class: "btn", onclick: () => v.fix.run() }, v.fix.label) : null;
  const parts = [h("dl", {}, ...statusFacts(st).flatMap(([k, val]) => [h("dt", {}, k), h("dd", {}, val)]))];
  for (const e of errors) parts.push(h("div", { class: "banner is-error detail-error" }, svgIcon(ERROR_ICON), h("p", { class: "banner-body" }, e)));
  if (fix) parts.push(h("div", { class: "actions" }, fix));
  box.replaceChildren(...parts);
}

function initDetails() {
  const btn = $("#details-btn");
  const box = $("#status-details");
  const close = () => {
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", () => {
    if (!box.hidden) return close();
    renderDetails();
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.hidden) {
      close();
      btn.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!box.hidden && !box.contains(e.target) && e.target !== btn) close();
  });
}

async function syncNow() {
  state.syncing = true;
  renderHeader();
  try {
    await api("POST", "/local/sync");
    // The cycle runs in the background; watch status until it finishes (at most ~2 minutes).
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() - started < 120_000) {
      state.status = await api("GET", "/local/status");
      if (!state.status.busy) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    state.loadError = e.message;
  } finally {
    state.syncing = false;
  }
  await refreshAll();
}

/* ---------------------------------------------------------------- views */

function renderViews() {
  const focusKey = captureFocus();
  renderFolders();
  renderHubs();
  restoreFocus(focusKey);
  showView();
}

/* Two views, switched by location.hash: #catchup and #machine (default: catch up once a folder is shared). */
let catchup = null;
let shownView = "";
function currentView() {
  const hash = location.hash.slice(1);
  if (hash === "catchup" || hash === "machine") return hash;
  // Decided once and pinned in the URL, so sharing or unsharing a folder later doesn't switch the page.
  const view = state.projects.some((p) => p.mapping) ? "catchup" : "machine";
  history.replaceState(null, "", "#" + view);
  return view;
}
function showView() {
  const view = currentView();
  $("#view-catchup").hidden = view !== "catchup";
  $("#view-machine").hidden = view !== "machine";
  for (const v of ["catchup", "machine"]) {
    if (v === view) $(`#nav-${v}`).setAttribute("aria-current", "page");
    else $(`#nav-${v}`).removeAttribute("aria-current");
  }
  if (view === shownView) return;
  if (shownView === "catchup") catchup?.hide();
  shownView = view;
  if (view === "catchup" && window.MemSyncCatchup) {
    catchup ??= window.MemSyncCatchup.mount($("#view-catchup"), { api, h, state, avatar, plural, kickSync, announce });
    catchup.show();
  }
}

/* ---------------------------------------------------------------- folders */

const RANK = { mapped: 0, unmapped: 1, never: 2 };

function sortedProjects() {
  return [...state.projects].sort((a, b) => RANK[a.state] - RANK[b.state] || byName(a.project, b.project));
}

/** The hub says this mapping's space is no longer open to the user (a missing flag means access, for older hubs). */
function hasNoAccess(p) {
  return p.mapping?.space_access === false;
}

function rowState(project) {
  return (state.rows[project] ??= { pending: null, busy: false, msg: null });
}

/** The latest copy of a folder (closures may hold one from an older render). */
function latest(p) {
  return state.projects.find((x) => x.project === p.project) ?? p;
}

/**
 * Every folder change runs through this one chain, so requests never interleave and the
 * read-modify-write of the never-share list can't lose an update.
 */
let changeChain = Promise.resolve();
function enqueue(fn) {
  const result = changeChain.then(fn, fn);
  changeChain = result.catch(() => {});
  return result;
}

/** Mark a row busy (its select and switch disabled) while its change is queued or in flight. */
function setRowBusy(p, busy) {
  rowState(p.project).busy = busy;
  const key = captureFocus();
  renderFolders();
  restoreFocus(key);
}

function findRow(project) {
  return [...document.querySelectorAll("#folder-rows tr")].find((tr) => tr.dataset.project === project) ?? null;
}

function currentValue(p) {
  if (hasNoAccess(p)) return "noaccess";
  if (p.mapping) return window.MemSyncHubs.spaceValue(p.hub_id, p.mapping.space_id);
  return p.state === "never" ? "never" : "none";
}

function labelForValue(value) {
  if (value === "none") return "Don't share";
  if (value === "never") return "Never share";
  const t = window.MemSyncHubs.parseSpaceValue(value);
  const sp = t && (state.spaces[t.hubId] || []).find((x) => x.id === t.spaceId);
  return sp ? sp.name : "";
}

/** The Hub column shows only with more than one hub. */
const multiHub = () => state.hubs.length > 1;

function renderFolders() {
  const body = $("#folder-rows");
  $("#col-hub").hidden = !multiHub();
  if (state.projects.length === 0) {
    const text = state.loadError
      ? `Couldn't load your folders: ${sentence(state.loadError)} Retrying on the next refresh.`
      : "No claude-mem projects on this PC yet. They show up after you use Claude Code in a folder.";
    body.replaceChildren(h("tr", { class: "empty-row" }, h("td", { colspan: multiHub() ? "5" : "4" }, text)));
    return;
  }
  body.replaceChildren(...sortedProjects().map(folderRow));
}

function folderRow(p) {
  const rs = rowState(p.project);
  const archived = Boolean(p.mapping?.space_archived);
  const noAccess = hasNoAccess(p);
  const nameCell = h(
    "td",
    {},
    h("span", { class: "folder-name" }, p.project),
    p.present_locally ? null : h("span", { class: "row-note" }, "not on this PC"),
    archived ? h("span", { class: "row-note is-error" }, "space archived") : null,
    noAccess ? h("span", { class: "row-note is-error" }, "access removed") : null,
  );

  const stack = h("div", { class: "cell-stack" });
  stack.append(spaceSelect(p));
  if (rs.pending) stack.append(unlinkConfirm(p));
  // Announced through the page-level #announcer region; this span is the visible copy.
  const msg = h("span", { class: "row-msg" });
  if (rs.msg) {
    msg.textContent = rs.msg.text;
    msg.classList.add(rs.msg.kind === "error" ? "is-error" : "is-saved");
  }
  stack.append(msg);

  const syncCell = h("td", { class: "col-sync", "data-label": "Sync" });
  if (p.mapping) {
    syncCell.append(
      switchButton({
        on: p.mapping.enabled && !archived && !noAccess,
        label: `Sync ${p.project}`,
        focusKey: `sw:${p.project}`,
        disabled: archived || noAccess || rs.busy,
        onToggle: () => toggleSync(p),
      }),
    );
  } else {
    syncCell.append(h("span", { class: "dash", "aria-label": "Not shared" }, "—"));
  }

  const gitCell = h("td", { class: "col-sync", "data-label": "Git details" });
  // Every folder, linked or not: it can be turned off before the first push after linking.
  gitCell.append(
    switchButton({
      on: p.git_details,
      label: `Share branch and commit for ${p.project}`,
      focusKey: `git:${p.project}`,
      disabled: rs.busy,
      onToggle: () => toggleGitDetails(p),
    }),
  );

  const tr = h(
    "tr",
    { class: [p.present_locally ? "" : "is-missing", rs.busy ? "is-busy" : ""].join(" ").trim(), "aria-busy": rs.busy ? "true" : null },
    nameCell,
    multiHub()
      ? h(
          "td",
          { class: "col-hub", "data-label": "Hub" },
          p.hub_id ? hubLabel(p.hub_id) : "—",
          p.also_linked_on?.length ? h("span", { class: "row-note is-error" }, `also linked on ${p.also_linked_on.map(hubLabel).join(", ")}`) : null,
        )
      : null,
    h("td", { "data-label": "Shared space" }, stack),
    syncCell,
    gitCell,
  );
  tr.dataset.project = p.project;
  return tr;
}

function spaceSelect(p) {
  const rs = rowState(p.project);
  const { spaceValue, hubGroups } = window.MemSyncHubs;
  const usedBy = new Map(state.projects.filter((x) => x.mapping && x.project !== p.project).map((x) => [spaceValue(x.hub_id, x.mapping.space_id), x.project]));
  const opts = [];
  // Spaces from an older hub (no project_name or client_name) stay ungrouped, before the project groups.
  const groupOf = (sp) => sp.project_name || sp.client_name || "";
  const bySpace = (a, b) => byName(groupOf(a), groupOf(b)) || Number(Boolean(b.is_main)) - Number(Boolean(a.is_main)) || byName(a.name, b.name);
  const shown = (hubId) => (state.spaces[hubId] || []).filter((sp) => !sp.archived || currentValue(p) === spaceValue(hubId, sp.id)).sort(bySpace);
  const spacesByHub = Object.fromEntries(state.hubs.map((hb) => [hb.id, shown(hb.id)]));
  for (const hb of hubGroups(state.hubs, spacesByHub)) {
    for (const g of hb.groups) {
      const os = g.items.map(({ value: id }) => {
        const sp = spacesByHub[hb.hubId].find((x) => x.id === id);
        const value = spaceValue(hb.hubId, id);
        const mine = currentValue(p) === value;
        const other = usedBy.get(value);
        let label = sp.is_main ? `${sp.name} (main)` : sp.name;
        if (sp.archived) label += " (archived)";
        else if (other) label += ` (used by ${other})`;
        return h("option", { value, disabled: Boolean(other) && !mine }, label);
      });
      // With several hubs every group names its hub, so space names that repeat across hubs stay apart.
      const label = multiHub() ? [hb.label, g.label].filter(Boolean).join(" · ") : g.label;
      opts.push(...(label ? [h("optgroup", { label }, ...os)] : os));
    }
  }
  if (opts.length) opts.push(h("option", { disabled: true, value: "" }, "──────────"));
  if (hasNoAccess(p)) opts.push(h("option", { value: "noaccess", disabled: true }, "No access"));
  opts.push(h("option", { value: "none" }, "Don't share"), h("option", { value: "never" }, "Never share"));

  const sel = h("select", { "aria-label": `Shared space for ${p.project}`, disabled: rs.busy, dataset: { focus: `sel:${p.project}` } }, ...opts);
  sel.value = rs.pending ?? currentValue(p);
  sel.addEventListener("change", () => onSpaceChange(p, sel.value));
  return sel;
}

function onSpaceChange(p, value) {
  const rs = rowState(p.project);
  rs.msg = null;
  if (p.mapping && value !== currentValue(p)) {
    // Unlinking a shared folder: ask first, inline in the row.
    rs.pending = value;
    renderFolders();
    restoreFocus(`unlink:${p.project}`);
    return;
  }
  applyChoice(p, value);
}

function unlinkConfirm(p) {
  const rs = rowState(p.project);
  const cancel = () => {
    rs.pending = null;
    renderFolders();
    restoreFocus(`sel:${p.project}`);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };
  const target = labelForValue(rs.pending);
  const to = window.MemSyncHubs.parseSpaceValue(rs.pending);
  const move = to && window.MemSyncHubs.isMove(p, to.hubId);
  const what = to ? ` and share it with ${target}` : "";
  const also = p.also_linked_on?.length ? ` It stays linked on ${p.also_linked_on.map(hubLabel).join(", ")}.` : "";
  const text = move
    ? `Move ${p.project} to ${hubLabel(to.hubId)}? It stops syncing with ${hubLabel(p.hub_id)}, and its notes are sent to ${hubLabel(to.hubId)}.`
    : `Unlink ${p.project} from ${p.mapping.space_name ?? "its space"}${what}?${also}`;
  return h(
    "div",
    { class: "row-confirm" },
    h("span", {}, text),
    h("button", { type: "button", class: "btn btn-danger", dataset: { focus: `unlink:${p.project}` }, onkeydown: onKey, onclick: () => applyChoice(p, rs.pending) }, move ? "Move" : "Unlink"),
    h("button", { type: "button", class: "btn", onkeydown: onKey, onclick: cancel }, "Cancel"),
  );
}

/** Say something once through the page-level live region (row spans are re-created on render). */
function announce(text) {
  const el = $("#announcer");
  el.textContent = "";
  // A fresh text node after clearing makes screen readers announce repeats too.
  setTimeout(() => (el.textContent = text), 50);
}

function setRowMsg(p, kind, text, rerender = true) {
  const rs = rowState(p.project);
  rs.msg = { kind, text };
  announce(`${p.project}: ${text}`);
  if (kind === "saved") {
    const stamp = (rs.msg.at = Date.now());
    setTimeout(() => {
      if (rs.msg?.at !== stamp) return;
      rs.msg = null;
      // Clear only this row's message, without a re-render, so focus and open controls are untouched.
      const el = findRow(p.project)?.querySelector(".row-msg.is-saved");
      if (el) el.textContent = "";
    }, 2600);
  }
  if (rerender) {
    const key = captureFocus();
    renderFolders();
    restoreFocus(key);
  } else {
    const el = findRow(p.project)?.querySelector(".row-msg");
    if (el) {
      el.textContent = text;
      el.className = `row-msg ${kind === "error" ? "is-error" : "is-saved"}`;
    }
  }
}

/** "Never share" is laptop-wide: the agent writes it to every hub (and retries a hub that is down). */
async function setNever(project, on) {
  await api("PUT", "/local/never-sync", { project, on });
}

/** A folder's mapping lives on its own hub; its id means nothing on another hub. */
const mappingsPath = (hubId) => `/local/hubs/${encodeURIComponent(hubId)}/me/mappings`;
const unlink = (p) => api("DELETE", `${mappingsPath(p.hub_id)}/${p.mapping.id}`);

/** Apply a Shared space choice for one folder (queued), then sync and refresh. */
function applyChoice(p, value) {
  const rs = rowState(p.project);
  rs.pending = null;
  // A new action makes earlier row errors stale.
  for (const r of Object.values(state.rows)) if (r.msg?.kind === "error") r.msg = null;
  setRowBusy(p, true);
  return enqueue(async () => {
    const cur = latest(p);
    let leftNever = false;
    try {
      const to = window.MemSyncHubs.parseSpaceValue(value);
      if (to) {
        if (cur.state === "never") {
          await setNever(cur.project, false);
          leftNever = true;
        }
        // Moving keeps the folder's current Sync setting; a new link starts with sync on.
        const enabled = cur.mapping ? cur.mapping.enabled : true;
        const move = window.MemSyncHubs.isMove(cur, to.hubId);
        await api("PUT", mappingsPath(to.hubId), { local_project: cur.project, space_id: to.spaceId, enabled, ...(move && { move: true }) });
      } else if (value === "none") {
        if (cur.mapping) await unlink(cur);
        if (cur.state === "never") await setNever(cur.project, false);
      } else if (value === "never") {
        if (cur.mapping) await unlink(cur);
        await setNever(cur.project, true);
      }
      await kickSync();
      rs.msg = null;
      rs.busy = false;
      await refreshAll();
      setRowMsg(p, "saved", "Saved");
    } catch (e) {
      if (leftNever) {
        try {
          await setNever(cur.project, true); // the link failed: put it back on the never-share list
        } catch {
          /* the refresh below shows whatever state the hub has */
        }
      }
      rs.busy = false;
      await refreshAll(); // show the real state again
      setRowMsg(p, "error", sentence(e.message));
    }
    restoreFocus(`sel:${p.project}`);
  });
}

function toggleSync(p) {
  setRowBusy(p, true);
  return enqueue(async () => {
    const cur = latest(p);
    const rs = rowState(p.project);
    try {
      if (!cur.mapping) throw new Error("this folder is no longer shared");
      await api("PUT", mappingsPath(cur.hub_id), { local_project: cur.project, space_id: cur.mapping.space_id, enabled: !cur.mapping.enabled });
      await kickSync();
      rs.busy = false;
      await refreshAll();
      setRowMsg(p, "saved", "Saved");
    } catch (e) {
      rs.busy = false;
      await refreshAll();
      setRowMsg(p, "error", sentence(e.message));
    }
    restoreFocus(`sw:${p.project}`);
  });
}

/** Sharing a folder's branch, commit and PR is a laptop setting, kept by the agent. */
function toggleGitDetails(p) {
  setRowBusy(p, true);
  return enqueue(async () => {
    const cur = latest(p);
    const rs = rowState(p.project);
    try {
      await api("PUT", "/local/git-details", { project: cur.project, on: !cur.git_details });
      rs.busy = false;
      await refreshAll();
      setRowMsg(p, "saved", "Saved");
    } catch (e) {
      rs.busy = false;
      await refreshAll();
      setRowMsg(p, "error", sentence(e.message));
    }
    restoreFocus(`git:${p.project}`);
  });
}

/** Open inline UI that a refresh would destroy: an unlink confirm or a change in flight. */
const uiOpen = () => Object.values(state.rows).some((r) => r.pending || r.busy);

/* ---------------------------------------------------------------- hubs */

/** A hub's State cell: dot tone and text. */
const HUB_STATE = {
  ok: ["ok", "OK"],
  paused: ["warn", "Paused"],
  signin: ["error", "Sign in needed"],
  revoked: ["error", "Key rejected"],
  not_allowed: ["error", "Not allowed"],
  need_key: ["error", "Needs an API key"],
  unreachable: ["error", "Unreachable"],
  error: ["error", "Last sync had problems"],
  unconfigured: ["idle", "Not set up"],
};

/** "<label> needs attention" / "<n> hubs need attention" when a hub isn't ok or paused; null with one hub. */
function hubsAttention(hubs) {
  const bad = (hubs || []).length > 1 ? hubs.filter((x) => x.state !== "ok" && x.state !== "paused") : [];
  if (!bad.length) return null;
  return bad.length === 1 ? `${bad[0].label} needs attention` : `${bad.length} hubs need attention`;
}

/** Opens This machine and moves focus (and the view) to the Hubs section. */
function showHubs() {
  if (location.hash !== "#machine") location.hash = "machine";
  showView();
  $("#hubs-title").focus();
}

/** The hub already at `input`'s address (compared as origins, as the agent does), or null. */
function knownHub(hubs, input) {
  try {
    const origin = new URL(String(input).trim()).origin;
    return hubs.find((x) => x.hub_url === origin) ?? null;
  } catch {
    return null;
  }
}

function renderHubs() {
  $("#hub-rows").replaceChildren(...state.hubs.map(hubRow));
}

function hubRow(hb) {
  const [tone, text] = HUB_STATE[hb.state] ?? HUB_STATE.error;
  const act = (label, onclick) => h("button", { type: "button", class: "link-btn", "aria-label": `${label}: ${hb.label}`, dataset: { focus: `hub:${label}:${hb.id}` }, onclick }, label);
  const access = hb.auth === "cloudflare-access";
  return h(
    "tr",
    {},
    h("td", {}, hb.label),
    h("td", { "data-label": "Address" }, hb.hub_url),
    h(
      "td",
      { "data-label": "State" },
      h("span", { class: "hub-state" }, h("span", { class: `status-dot is-${tone}`, "aria-hidden": "true" }), text),
      hb.state !== "ok" && hb.last_error ? h("span", { class: "row-note" }, sentence(hb.last_error)) : null,
    ),
    h("td", { "data-label": "Signed in as" }, hb.signed_in_as || state.me[hb.id]?.name || "—"),
    h(
      "td",
      {},
      h(
        "div",
        { class: "hub-actions" },
        access
          ? act(hb.state === "signin" || !hb.signed_in_as ? "Sign in" : "Sign in again", () => openConnection({ mode: "signin", hubId: hb.id }))
          : act("Change key", () => openConnection({ mode: "key", hubId: hb.id })),
        act("Rename", () => renameHub(hb)),
        act("Remove", () => removeHub(hb)),
      ),
    ),
  );
}

/** A small form in #del-dialog (the catch-up delete pattern): body, then Cancel and the action. */
function hubDialog(title, body, label, danger, action) {
  const d = $("#del-dialog");
  const err = h("p", { class: "inline-error", "aria-live": "polite" });
  const btn = h("button", { type: "submit", class: danger ? "btn btn-danger" : "btn btn-primary" }, label);
  const submit = async (e) => {
    e.preventDefault();
    if (await run(err, action, { button: btn })) d.close();
  };
  d.replaceChildren(
    h(
      "form",
      { onsubmit: submit, novalidate: true },
      h("div", { class: "modal-header" }, h("h2", { id: "del-title" }, title)),
      h("div", { class: "modal-body" }, ...body, err),
      h("div", { class: "modal-footer" }, h("button", { type: "button", class: "btn", onclick: () => d.close() }, "Cancel"), btn),
    ),
  );
  d.showModal();
}

function renameHub(hb) {
  const input = h("input", { id: "f-hub-label", type: "text", value: hb.label, autocomplete: "off", spellcheck: "false" });
  hubDialog("Rename hub", [h("div", { class: "field" }, h("label", { for: "f-hub-label" }, "Label"), input)], "Rename", false, () =>
    api("PATCH", `/local/hubs/${encodeURIComponent(hb.id)}`, { label: input.value.trim() }),
  );
  input.select();
}

function removeHub(hb) {
  const copy = `Remove ${hb.label}? This machine stops syncing with it. Links and notes on the hub stay, and notes already here stay in claude-mem.`;
  hubDialog("Remove hub", [h("p", {}, copy)], "Remove", true, () => api("DELETE", `/local/hubs/${encodeURIComponent(hb.id)}`));
}

/* ---------------------------------------------------------------- hub connection */

/** The mode the connection dialog was last opened in ("add" refuses an address that is already connected). */
let connMode;

/** Bumped to cancel a running sign-in poll (hub edited, dialog closed, new step shown). */
let flowRun = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drops the step shown (and cancels its poll). `keepSetup` leaves a first-run setup view up while the next step loads. */
function resetNext(keepSetup = false) {
  flowRun++;
  if (!keepSetup) state.connecting = false;
  $("#setup-next").replaceChildren();
}

/** The sign-in finished: sync, close the dialog, show the app. */
async function signedIn() {
  state.connecting = false;
  state.loadError = "";
  await kickSync();
  resetNext();
  const dlg = $("#conn-dialog");
  if (dlg.open) dlg.close();
  await refreshAll();
}

/** Ask the hub which sign-in it wants for `hubUrl` (optionally forcing `method`) and show that step. */
async function connectHub(hubUrl, method) {
  resetNext(true);
  // A new address adds a hub; a known one re-runs that hub's connect.
  const reply = await api("POST", "/local/connect", method ? { hubUrl, method } : { hubUrl });
  showNext(hubUrl, reply);
}

function showNext(hubUrl, reply) {
  const box = $("#setup-next");
  const has = (type) => reply.methods?.some((m) => m.type === type);
  const parts = [];
  // A Cloudflare connect has saved this hub already, so a refresh would see it as configured and swap
  // the setup view for the app. Keep it up for whichever step is shown (sign-in or key form) until
  // that step succeeds or the address is edited.
  if (!$("#conn-dialog").open) state.connecting = true;
  if (reply.method === "cloudflare-access") {
    parts.push(cloudflarePanel("Sign in with Cloudflare", null, reply.hub_id));
    if (has("api-key")) parts.push(switchLink("Use an API key instead", () => connectHub(hubUrl, "api-key")));
  } else {
    parts.push(keyForm(hubUrl, reply.edge));
    if (has("cloudflare-access")) parts.push(switchLink("Sign in with Cloudflare instead", () => connectHub(hubUrl, "cloudflare-access")));
  }
  box.replaceChildren(...parts);
}

function switchLink(label, fn) {
  const err = h("p", { class: "inline-error" });
  const btn = h("button", { type: "button", class: "link-btn" }, label);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      err.textContent = sentence(e.message);
      btn.disabled = false;
    }
  });
  return h("div", { class: "form-stack" }, btn, err);
}

/** Sign-in button, "waiting" line with the captured sign-in link, and a poll of that hub's sign-in. */
function cloudflarePanel(label, onCancel, hubId) {
  const signinPath = hubId ? `/local/hubs/${encodeURIComponent(hubId)}/signin` : "/local/signin";
  const btn = h("button", { type: "button", class: "btn btn-primary" }, label);
  const waiting = h("p", { class: "hint", role: "status" });
  const linkBox = h("p", { class: "hint" });
  const err = h("p", { class: "inline-error", "aria-live": "polite" });
  waiting.hidden = true;

  const update = (s) => {
    if (s.url && /^https:\/\//i.test(String(s.url)) && !linkBox.firstChild) {
      linkBox.append(h("a", { href: String(s.url), target: "_blank", rel: "noopener noreferrer" }, "Open the sign-in page"));
    }
  };

  async function start() {
    const run = ++flowRun;
    err.textContent = "";
    btn.disabled = true;
    waiting.textContent = "Waiting for you to sign in in your browser…";
    waiting.hidden = false;
    linkBox.replaceChildren();
    const fail = (msg) => {
      if (run !== flowRun) return;
      waiting.hidden = true;
      linkBox.replaceChildren();
      err.textContent = sentence(msg || "sign-in didn't finish");
      btn.textContent = "Try again";
      btn.disabled = false;
    };
    try {
      // A click here is an explicit request, so it may start a sign-in even when none is needed (switch account).
      let s = await api("POST", signinPath, { reauth: true });
      for (;;) {
        if (run !== flowRun) return;
        update(s);
        if (s.state === "done") return void (await signedIn());
        if (s.state === "failed") return fail(s.error);
        await sleep(1000);
        s = await api("GET", signinPath);
      }
    } catch (e) {
      fail(e.message);
    }
  }
  btn.addEventListener("click", start);
  // In the connection dialog the address form (and its Cancel) is hidden, so this step brings its own.
  return h(
    "div",
    { class: "form-stack" },
    h("div", { class: "actions" }, onCancel ? h("button", { type: "button", class: "btn", onclick: onCancel }, "Cancel") : null, btn),
    waiting,
    linkBox,
    err,
  );
}

/** API key fields; the Access client ID and secret only when the hub's edge wants a service token. */
function keyForm(hubUrl, edge) {
  const needToken = edge === "cloudflare-service-token";
  const err = h("p", { class: "inline-error", "aria-live": "polite" });
  const field = (id, label, name, type, hint) =>
    h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, name, type, autocomplete: "off", spellcheck: "false", required: true, "aria-describedby": hint }));
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Connect");
  const form = h(
    "form",
    { class: "form-stack", novalidate: true },
    keyField(hubUrl, field("f-key", "Your API key", "apiKey", "password")),
    needToken
      ? h(
          "fieldset",
          { class: "field-group" },
          h("legend", {}, "Cloudflare Access"),
          h("p", { id: "cf-help", class: "hint" }, "From your admin, needed because this hub is behind Cloudflare Access."),
          field("f-cfid", "Access client ID", "cfClientId", "text", "cf-help"),
          field("f-cfsecret", "Access client secret", "cfClientSecret", "password", "cf-help"),
        )
      : null,
    err,
    h("div", { class: "actions" }, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const val = (k) => String(data[k] || "").trim();
    if (!val("apiKey") || (needToken && (!val("cfClientId") || !val("cfClientSecret")))) {
      err.textContent = needToken ? "Enter your API key and the Access client ID and secret." : "Enter your API key.";
      return;
    }
    submit.textContent = "Connecting…";
    const ok = await run(
      err,
      async () => {
        // Adds the hub, or changes the key of the hub at that address.
        await api("POST", "/local/hubs", {
          hubUrl,
          apiKey: val("apiKey"),
          ...(needToken ? { cfClientId: val("cfClientId"), cfClientSecret: val("cfClientSecret") } : {}),
          auth: "api-key",
        });
        state.loadError = "";
        await kickSync();
      },
      { button: submit },
    );
    submit.textContent = "Connect";
    if (ok) {
      resetNext();
      $("#setup-form").reset();
      const dlg = $("#conn-dialog");
      if (dlg.open) dlg.close();
      render(); // the setup view was held up while this step was shown
    }
  });
  return form;
}

/** The key field, with a "Get a key" link beside its label for a hosted (getmemsync.com) hub. */
function keyField(hubUrl, el) {
  const keys = keysUrl(hubUrl);
  if (keys) el.prepend(h("div", { class: "field-head" }, el.querySelector("label"), h("a", { href: keys, target: "_blank", rel: "noopener" }, "Get a key")));
  return el;
}

/** Where a hosted hub (`<slug>.getmemsync.com`) hands out laptop keys, else null. */
function keysUrl(hubUrl) {
  let host = "";
  try {
    host = new URL(String(hubUrl)).hostname;
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.getmemsync\.com$/i.exec(host);
  return m ? `https://getmemsync.com/app/t/${m[1].toLowerCase()}/keys` : null;
}

/** The hub address in a `#connect=<url>` link (Claude's connect_hub opens one), or null; http(s) only. */
function connectHashHub(hash) {
  if (!String(hash).startsWith("#connect=")) return null;
  try {
    const u = new URL(decodeURIComponent(String(hash).slice("#connect=".length)));
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Reads a `#connect=` link and drops it from the URL, so a reload doesn't reopen the step. */
function takeConnectHash() {
  if (!location.hash.startsWith("#connect=")) return null;
  const hubUrl = connectHashHub(location.hash);
  history.replaceState(null, "", location.pathname + location.search);
  return hubUrl;
}

/**
 * A known hub's address opens its Sign in or Change key step; a new one the API-key step that adds it
 * (dialog when configured, first-run setup otherwise). Saves nothing until Connect.
 */
function connectFromLink(hubUrl) {
  if (!hubUrl || !state.status) return;
  if (state.status.configured) {
    if ($("#conn-dialog").open) $("#conn-dialog").close();
    const known = state.hubs.find((x) => x.hub_url === hubUrl);
    if (known) return openConnection({ mode: known.auth === "cloudflare-access" ? "signin" : "key", hubId: known.id });
    return openConnection({ mode: "key", hubUrl });
  }
  $("#f-hub").value = hubUrl;
  $("#setup-error").textContent = "";
  connectHub(hubUrl, "api-key").then(
    () => $("#f-key")?.focus(),
    (e) => ($("#setup-error").textContent = sentence(e.message)),
  );
}

/**
 * Open the connection dialog (when already configured). mode "signin": Cloudflare sign-in; mode "key":
 * API key; mode "add": an empty hub address form; otherwise the hub address form (a Cloudflare first hub
 * shows its address and "Sign in again" instead). Acts on hub `hubId`, else the first hub; `hubUrl`
 * (with mode "key") names a hub not added yet.
 */
function openConnection(opts = {}) {
  const mode = opts && typeof opts === "object" && "mode" in opts ? opts.mode : undefined;
  const hub = state.hubs.find((x) => x.id === opts.hubId);
  const add = mode === "add";
  connMode = mode;
  const st = add ? {} : hub ? { hub_url: hub.hub_url, auth: hub.auth } : state.status || {};
  const hubId = hub?.id ?? (add ? undefined : state.hubs[0]?.id);
  $("#conn-title").textContent = add || (opts.hubUrl && !state.hubs.some((x) => x.hub_url === opts.hubUrl)) ? "Add a hub" : "Hub connection";
  const form = $("#setup-form");
  $("#status-details").hidden = true;
  $("#details-btn").setAttribute("aria-expanded", "false");
  $("#conn-body").append($("#setup-wrap"));
  $("#setup-cancel").hidden = false;
  $("#setup-error").textContent = "";
  resetNext();
  form.hidden = false;
  const hubUrl = String(opts.hubUrl || st.pending_access_hub || st.hub_url || "");
  $("#f-hub").value = String(opts.hubUrl || st.hub_url || "");
  const cloudflareHub = mode === "signin" || (mode === undefined && st.auth === "cloudflare-access");
  if (cloudflareHub && hubUrl) {
    form.hidden = true;
    const change = h("button", { type: "button", class: "link-btn" }, "Use a different hub");
    change.addEventListener("click", () => {
      resetNext();
      form.hidden = false;
      $("#f-hub").focus();
    });
    $("#setup-next").replaceChildren(
      h("p", { class: "hint" }, `Hub: ${hubUrl}`),
      cloudflarePanel(mode === "signin" ? "Sign in" : "Sign in again", () => $("#conn-dialog").close(), hubId),
      change,
    );
  } else if (mode === "key" && hubUrl) {
    connectHub(hubUrl, "api-key").then(
      () => $("#f-key")?.focus(),
      (e) => ($("#setup-error").textContent = sentence(e.message)),
    );
  }
  $("#conn-dialog").showModal();
  (form.hidden ? $("#setup-next button") : $("#f-hub"))?.focus();
}

function initSetup() {
  const form = $("#setup-form");
  const dlg = $("#conn-dialog");
  dlg.addEventListener("close", () => {
    resetNext();
    form.hidden = false;
    $("#setup-home").append($("#setup-wrap"));
    $("#setup-cancel").hidden = true;
    $("#setup-error").textContent = "";
    form.reset();
    $("#conn-btn").focus();
  });
  $("#setup-cancel").addEventListener("click", () => dlg.close());
  $("#conn-btn").addEventListener("click", () => openConnection());
  $("#add-hub").addEventListener("click", () => openConnection({ mode: "add" }));
  // Editing the address invalidates the step shown for the old one.
  $("#f-hub").addEventListener("input", () => {
    if ($("#setup-next").firstChild) resetNext();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#setup-error");
    const hubUrl = String(new FormData(form).get("hubUrl") || "").trim();
    if (!hubUrl) {
      err.textContent = "Enter the hub address.";
      return;
    }
    const known = connMode === "add" ? knownHub(state.hubs, hubUrl) : null;
    if (known) {
      err.textContent = `${known.label} is already connected. Use Change key or Sign in on its row.`;
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.textContent = "Connecting…";
    await run(err, () => connectHub(hubUrl), { button: btn, refresh: false });
    btn.textContent = "Continue";
  });
}

/* ---------------------------------------------------------------- render + refresh */

function render() {
  const st = state.status;
  if (!st) return;
  $("#loading").hidden = true;
  renderHeader();
  const showApp = st.configured && !state.connecting;
  $("#view-setup").hidden = showApp;
  $("#app-views").hidden = !showApp;
  if (showApp) renderViews();
}

async function refreshAll() {
  try {
    state.status = await api("GET", "/local/status");
  } catch {
    $("#loading").hidden = false;
    $("#loading").textContent = "Can't reach the mem-sync agent on this machine. Is it still running?";
    return;
  }
  if (state.status.configured) {
    try {
      state.hubs = (await api("GET", "/local/hubs")).hubs;
      // One hub failing keeps its last copy; the others still load.
      const usable = state.hubs.filter((hb) => hb.usable);
      const read = (hb, path) => api("GET", `/local/hubs/${encodeURIComponent(hb.id)}/${path}`).catch((e) => e);
      const [pr, ...perHub] = await Promise.all([api("GET", "/local/projects"), ...usable.map((hb) => Promise.all([read(hb, "me"), read(hb, "spaces")]))]);
      const me = {};
      const spaces = {};
      let hubError = "";
      usable.forEach((hb, i) => {
        const [m, sp] = perHub[i];
        // The header speaks for the first hub, as in 0.9; the Hubs section shows the others' states.
        if (i === 0) hubError = [m, sp].find((x) => x instanceof Error)?.message ?? "";
        me[hb.id] = m instanceof Error ? state.me[hb.id] : m.user;
        spaces[hb.id] = sp instanceof Error ? state.spaces[hb.id] : sp.spaces;
      });
      state.me = me;
      state.spaces = spaces;
      state.projects = pr.projects;
      state.claudeMemError = pr.claude_mem_error || "";
      state.loadError = hubError;
    } catch (e) {
      state.loadError = e.message;
    }
  }
  render();
}

async function pollStatus() {
  if (document.visibilityState !== "visible" || state.syncing) return;
  try {
    const next = await api("GET", "/local/status");
    const wasConfigured = state.status?.configured;
    state.status = next;
    if (next.hubs) state.hubs = next.hubs;
    if (next.configured !== wasConfigured) await refreshAll();
    else {
      renderHeader();
      const key = captureFocus();
      renderHubs();
      restoreFocus(key);
    }
  } catch {
    /* the next full refresh reports it */
  }
}

function startTimers() {
  setInterval(pollStatus, 15_000);
  setInterval(() => state.status && renderHeader(), 30_000);
  setInterval(() => {
    if (document.visibilityState !== "visible" || state.syncing || uiOpen()) return;
    if ($("#conn-dialog").open) return;
    if (document.activeElement?.closest?.("form, select")) return;
    refreshAll();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollStatus();
  });
}

/* ---------------------------------------------------------------- boot */

// Pure helpers, for tests.
window.MemSyncConnect = { connectHashHub, keysUrl, hubsAttention, knownHub };

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initDetails();
  initSetup();
  $("#sync-btn").addEventListener("click", syncNow);
  // Read before the first render, which pins the view in the hash. Runs before the view listener below.
  const linked = takeConnectHash();
  window.addEventListener("hashchange", () => connectFromLink(takeConnectHash()));
  window.addEventListener("hashchange", () => state.status?.configured && showView());
  window.addEventListener("pagehide", () => shownView === "catchup" && catchup?.hide());
  refreshAll().then(() => connectFromLink(linked));
  startTimers();
});
