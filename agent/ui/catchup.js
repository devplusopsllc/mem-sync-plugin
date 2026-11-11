"use strict";

// Catch up view: what teammates did in a project's space, ask it a question, delete your own notes for everyone.
// Hub data reaches the DOM through textContent / DOM APIs only. app.js hands in its helpers via mount().
(function () {
  const DAY = 86_400_000;
  const RANGES = [
    { id: "visit", label: "Since my last visit" },
    { id: "3", label: "3 days" },
    { id: "7", label: "7 days" },
  ];
  const FILTERS = [
    ["all", "Everything"],
    ["team", "From teammates"],
    ["decision", "Decisions"],
    ["bugfix", "Bugfixes"],
    ["mine", "Mine"],
  ];
  const TEST = {
    all: () => true,
    team: (n) => !n.mine,
    decision: (n) => n.type === "decision",
    bugfix: (n) => n.type === "bugfix",
    mine: (n) => n.mine,
  };
  const DELETE_WARNING = "This deletes the note from the hub and from every teammate's machine on their next sync. It can't be undone.";

  /** One entry per author, teammates first, then newest activity first. Input is newest first. */
  function groupByAuthor(notes) {
    const by = new Map();
    for (const n of notes) {
      const key = n.author.id;
      let g = by.get(key);
      if (!g) by.set(key, (g = { author: n.author.name, mine: n.mine, count: 0, last: 0, titles: [], files: [], branches: [] }));
      g.count++;
      g.last = Math.max(g.last, n.created_at_epoch);
      const title = n.title || n.subtitle;
      if (title && g.titles.length < 3) g.titles.push(title);
      for (const f of n.files_modified || []) if (!g.files.includes(f)) g.files.push(f);
      const git = n.git;
      if (git && typeof git === "object" && !g.branches.some((b) => b.remote === git.remote && b.branch === git.branch)) {
        g.branches.push({ remote: git.remote, branch: git.branch, commit: git.commit, pr: git.pr });
      }
    }
    return [...by.values()].sort((a, b) => Number(a.mine) - Number(b.mine) || b.last - a.last);
  }

  /** Notes bucketed by local calendar day, newest day first; order inside a day is kept. */
  function groupByDay(notes) {
    const days = new Map();
    for (const n of notes) {
      const d = new Date(n.created_at_epoch);
      const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
      if (!days.has(key)) days.set(key, { key, label: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }), notes: [] });
      days.get(key).notes.push(n);
    }
    return [...days.values()].sort((a, b) => b.key - a.key).map(({ label, notes: ns }) => ({ label, notes: ns }));
  }

  // Space ids are per hub; the 0.9 key (space id alone) belonged to the first hub.
  const visitKey = (hubId, spaceId) => `memsync.lastVisit.${hubId}.${spaceId}`;
  function lastVisit(hubId, spaceId, firstHub) {
    try {
      const v = Number(localStorage.getItem(visitKey(hubId, spaceId)) ?? (firstHub ? localStorage.getItem(`memsync.lastVisit.${spaceId}`) : null));
      return v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }
  /** What to store as the last visit: the time of the last successful load, so notes that arrived while the page sat open still count as new. */
  function nextLastVisit(loadedAt, prev) {
    return loadedAt || prev || 0;
  }
  function markVisit(hubId, spaceId, loadedAt) {
    try {
      const t = nextLastVisit(loadedAt, 0);
      if (hubId && spaceId && t) localStorage.setItem(visitKey(hubId, spaceId), String(t));
    } catch {
      /* private mode: the range falls back to 7 days */
    }
  }

  /** Names of the enabled standards as one line; "" when there are none. */
  const standardsLine = (list) => (list || []).map((x) => x.name).join(", ");

  /** A git remote's repo name ("git@github.com:o/repo.git" → "repo"); "" without one. */
  const repoName = (remote) =>
    typeof remote === "string" ? (remote.replace(/\.git$/, "").split(/[\/:]/).filter(Boolean).pop() ?? "") : "";

  /**
   * A file as it reads inside its project, like a path on GitHub: everything after the last folder
   * named like one of `roots` (folder, space or repo names, any case), with forward slashes. A
   * relative path stays as it is; an absolute path outside every root shows by file name only.
   */
  function shortPath(path, roots) {
    if (typeof path !== "string" || !path) return "";
    const p = path.replace(/\\/g, "/");
    if (!/^([A-Za-z]:\/|\/)/.test(p)) return p.replace(/^\.\//, "");
    const segs = p.split("/").filter(Boolean);
    const names = new Set((roots || []).filter(Boolean).map((r) => String(r).toLowerCase()));
    for (let i = segs.length - 2; i >= 0; i--) if (names.has(segs[i].toLowerCase())) return segs.slice(i + 1).join("/");
    return `…/${segs[segs.length - 1] ?? p}`;
  }

  /** Option values are strings; space ids are numbers (a string id never matches `===`). */
  const toSpaceId = (v) => Number(v);

  /** Picker contents: spaces grouped by project (label "" = no project), with the loaded space marked selected. */
  function pickerGroups(spaces, selectedId) {
    const by = new Map();
    for (const s of spaces) {
      const k = s.project_name || s.client_name || "";
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ value: s.id, name: s.name, selected: s.id === selectedId });
    }
    return [...by].map(([label, items]) => ({ label, items }));
  }

  // Web paths per allowed host for a branch and a commit.
  const GIT_PATHS = { "github.com": ["tree", "commit"], "gitlab.com": ["-/tree", "-/commit"], "bitbucket.org": ["src", "commits"] };
  const PR_STATES = { OPEN: "Open", DRAFT: "Draft", MERGED: "Merged", CLOSED: "Closed" };

  /** The URL when it is https on an allowed host (no port, credentials, query or fragment), at most 300 chars; else null. */
  function safeGitUrl(u) {
    if (typeof u !== "string" || u.length > 300) return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    const ok = url.protocol === "https:" && Object.hasOwn(GIT_PATHS, url.host) && !url.username && !url.password && !url.search && !url.hash;
    return ok ? url.href : null;
  }

  /** Texts and links for a note's git field; a link only from a safe remote or PR url, the text kept either way. */
  function gitLinks(git) {
    if (!git || typeof git !== "object") return {};
    const remote = safeGitUrl(git.remote);
    const [tree, commits] = remote ? GIT_PATHS[new URL(remote).host] : [];
    const out = {};
    if (typeof git.branch === "string" && git.branch) {
      const segs = git.branch.split("/");
      // A "." or ".." segment would climb out of the repo once the browser resolves the link (git forbids both).
      const climbs = segs.some((x) => x === "." || x === "..");
      out.branch = { text: git.branch, href: remote && !climbs ? `${remote}/${tree}/${segs.map(encodeURIComponent).join("/")}` : null, title: git.branch };
    }
    if (typeof git.commit === "string" && git.commit) out.commit = { text: git.commit, href: remote && /^[0-9a-f]{7,40}$/.test(git.commit) ? `${remote}/${commits}/${git.commit}` : null };
    const pr = git.pr;
    if (pr && Number.isSafeInteger(pr.number) && pr.number > 0) {
      const prUrl = safeGitUrl(pr.url);
      // Only a PR of this note's own repo gets a link.
      const ownRepo = remote && prUrl && prUrl.toLowerCase().startsWith(`${remote.toLowerCase()}/`);
      out.pr = { text: `PR #${pr.number}`, href: ownRepo ? prUrl : null, state: PR_STATES[pr.state] || "", asOf: Number.isSafeInteger(pr.checked_at) ? `as of ${dayTime(pr.checked_at)}` : "" };
    }
    return out;
  }

  /** A person card's git chips: the newest branch's branch, commit and PR, then "+N more" naming the other branches. */
  function gitChips(branches) {
    if (!branches?.length) return [];
    const l = gitLinks(branches[0]);
    const chips = [l.branch, l.commit].filter(Boolean);
    if (l.pr) chips.push({ text: l.pr.state ? `${l.pr.text} · ${l.pr.state}` : l.pr.text, href: l.pr.href, title: l.pr.asOf || undefined });
    if (branches.length > 1) chips.push({ text: `+${branches.length - 1} more`, href: null, title: branches.slice(1).map((b) => b.branch || "detached").join(", ") });
    return chips;
  }

  /** "<branch> · <commit>" for a note, either part alone; "" without git. */
  function gitLine(git) {
    const l = gitLinks(git);
    return [l.branch?.text, l.commit?.text].filter(Boolean).join(" · ");
  }

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  const dayTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function mount(root, ctx) {
    const { api, h, state, avatar, plural, kickSync, announce } = ctx;
    const v = { hubId: "", spaceId: "", range: "visit", filter: "all", since: 0, notes: [], loading: false, error: "", ask: null, asking: false, question: "", askOk: null, confirm: null };
    let token = 0;

    const hubPath = () => `/local/hubs/${encodeURIComponent(v.hubId)}`;
    const visitOf = (id) => lastVisit(v.hubId, id, state.hubs[0]?.id === v.hubId);
    const spaceOptions = () => {
      const mapped = state.projects.filter((p) => p.mapping && p.hub_id === v.hubId).map((p) => p.mapping.space_id);
      const live = (state.spaces[v.hubId] || []).filter((s) => !s.archived || mapped.includes(s.id));
      const order = (a, b) => Number(mapped.includes(b.id)) - Number(mapped.includes(a.id)) || (a.name || "").localeCompare(b.name || "");
      return live.sort(order);
    };

    function leave() {
      markVisit(v.hubId, v.spaceId, v.loadedAt);
    }

    function sinceFor(id) {
      if (v.range === "3") return Date.now() - 3 * DAY;
      if (v.range === "7") return Date.now() - 7 * DAY;
      return v.visit || Date.now() - 7 * DAY;
    }

    async function load() {
      if (!v.spaceId) return render();
      const mine = ++token;
      v.loading = true;
      v.error = "";
      v.since = sinceFor(v.spaceId);
      const startedAt = Date.now();
      render();
      try {
        const [data, feat, std] = await Promise.all([
          api("GET", `${hubPath()}/spaces/${encodeURIComponent(v.spaceId)}/notes?since=${v.since}&limit=500`),
          v.features ? v.features : api("GET", `${hubPath()}/features`).catch(() => ({ ask: false })),
          api("GET", `${hubPath()}/spaces/${encodeURIComponent(v.spaceId)}/standards`).catch(() => ({ standards: [] })), // 404 or an older hub: show nothing
        ]);
        if (mine !== token) return;
        v.notes = data.notes;
        v.features = feat;
        v.standards = std.standards || [];
        v.loadedAt = startedAt;
      } catch (e) {
        if (mine !== token) return;
        v.notes = [];
        v.standards = [];
        v.error = e.message;
      }
      v.loading = false;
      render();
    }

    /** The first shared folder's space on the picked hub, else its first space. */
    function firstSpace() {
      const opts = spaceOptions();
      const first = state.projects.find((p) => p.mapping && p.hub_id === v.hubId)?.mapping.space_id;
      v.spaceId = opts.some((s) => s.id === first) ? first : opts[0]?.id || "";
      v.visit = visitOf(v.spaceId);
    }

    function pickHub(id) {
      leave();
      v.hubId = id;
      v.features = null; // features are per hub
      v.loadedAt = 0;
      v.ask = null;
      v.question = "";
      firstSpace();
      load();
    }

    function pick(id) {
      id = toSpaceId(id);
      leave();
      v.spaceId = id;
      v.loadedAt = 0;
      v.visit = visitOf(id);
      v.ask = null;
      v.question = "";
      load();
    }

    async function askNow(q) {
      q = q.trim();
      if (!q || v.asking) return;
      v.question = q;
      v.asking = true;
      v.ask = null;
      render();
      try {
        v.ask = await api("POST", `${hubPath()}/spaces/${encodeURIComponent(v.spaceId)}/ask`, { question: q });
        v.askErr = "";
      } catch (e) {
        v.askErr = e.message;
      }
      v.asking = false;
      render();
      root.querySelector("#cu-answer")?.focus();
    }

    async function doDelete(n) {
      const c = v.confirm;
      if (!c || c.busy) return;
      c.busy = true;
      renderConfirm();
      try {
        await api("DELETE", `${hubPath()}/records/${n.seq}`);
      } catch (e) {
        c.busy = false;
        c.error = e.message;
        if (v.confirm === c) renderConfirm();
        return;
      }
      v.notes = v.notes.filter((x) => x.seq !== n.seq);
      closeConfirm();
      announce("Note deleted for everyone.");
      render();
      kickSync();
    }

    function closeConfirm() {
      v.confirm = null;
      const d = document.querySelector("#del-dialog");
      if (d.open) d.close();
    }

    function renderConfirm() {
      const d = document.querySelector("#del-dialog");
      const n = v.confirm.note;
      d.replaceChildren(
        h("div", { class: "modal-header" }, h("h2", { id: "del-title" }, "Delete for everyone?")),
        h(
          "div",
          { class: "modal-body" },
          h("p", {}, n.title || "This note"),
          h("p", { class: "hint" }, DELETE_WARNING),
          h("p", { class: "inline-error", "aria-live": "polite" }, v.confirm.error || ""),
        ),
        h(
          "div",
          { class: "modal-footer" },
          h("button", { type: "button", class: "btn", onclick: closeConfirm }, "Cancel"),
          h("button", { type: "button", class: "btn btn-danger", disabled: v.confirm.busy, onclick: () => doDelete(n) }, "Delete for everyone"),
        ),
      );
      if (!d.open) d.showModal();
    }

    /** Names a file path can start from in this space: its linked folders here and the space's name. */
    function viewRoots() {
      const folders = state.projects.filter((p) => p.mapping && p.hub_id === v.hubId && p.mapping.space_id === v.spaceId).map((p) => p.project);
      const space = (state.spaces[v.hubId] || []).find((s) => s.id === v.spaceId)?.name;
      return [...folders, space];
    }

    /** A note's files as short paths separated by " · ", each with its full path on hover. */
    const fileList = (files, roots) =>
      files.flatMap((f, i) => [i ? " · " : null, h("span", { title: f }, shortPath(f, roots))]).filter((x) => x !== null);

    /** Up to 6 file chips; two paths that shorten alike show once. */
    function fileChips(files, roots) {
      const seen = new Set();
      const out = [];
      for (const f of files) {
        const s = shortPath(f, roots);
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(h("span", { class: "tag", title: f }, s));
        if (out.length === 6) break;
      }
      return out;
    }

    function noteRow(n) {
      const canDelete = n.mine || state.me[v.hubId]?.role === "admin";
      const body = n.narrative || n.subtitle;
      return h(
        "article",
        { class: "cu-note", id: `note-${n.seq}` },
        h("span", { class: "cu-type" }, n.kind === "summary" ? "Summary" : cap(n.type) || "Note"),
        h(
          "div",
          { class: "cu-note-main" },
          h("div", { class: "cu-note-title" }, n.title || "Untitled"),
          gitLine(n.git) ? h("div", { class: "cu-git-line" }, gitLine(n.git)) : null,
          body ? h("p", { class: "cu-note-body" }, body) : null,
          n.files_modified?.length ? h("div", { class: "cu-files" }, ...fileList(n.files_modified, [...viewRoots(), repoName(n.git?.remote)])) : null,
        ),
        h(
          "div",
          { class: "cu-note-side" },
          h("span", {}, n.mine ? "You · shared" : `shared by ${n.author.name}`),
          canDelete
            ? h("button", { type: "button", class: "btn btn-danger", "aria-label": `Delete for everyone: ${n.title || "note"}`, onclick: () => { v.confirm = { note: n, error: "" }; renderConfirm(); } }, "Delete for everyone")
            : null,
          h("span", { class: "cu-time" }, dayTime(n.created_at_epoch)),
        ),
      );
    }

    function render() {
      const opts = spaceOptions();
      const space = opts.find((s) => s.id === v.spaceId);
      const groups = groupByAuthor(v.notes);
      const mates = groups.filter((g) => !g.mine);
      const decisions = v.notes.filter((n) => n.type === "decision").length;
      const shown = v.notes.filter(TEST[v.filter]);
      const since = v.range === "visit" && !v.visit ? "in the last 7 days" : `since ${new Date(v.since).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;

      // With several hubs, pick the hub first; its spaces fill the Space picker.
      const hubPicker = state.hubs.length > 1
        ? h("div", { class: "field cu-picker" }, h("label", { for: "cu-hub" }, "Hub"),
            h("select", { id: "cu-hub", "aria-label": "Hub", onchange: (e) => pickHub(e.target.value) }, ...state.hubs.map((hb) => h("option", { value: hb.id, selected: hb.id === v.hubId }, hb.label))))
        : null;
      const picker = h("select", { id: "cu-space", "aria-label": "Space", onchange: (e) => pick(toSpaceId(e.target.value)) });
      for (const g of pickerGroups(opts, v.spaceId)) {
        const os = g.items.map((i) => h("option", { value: i.value, selected: i.selected }, i.name));
        picker.append(...(g.label ? [h("optgroup", { label: g.label }, ...os)] : os));
      }

      const kids = [
        h(
          "div",
          { class: "page-head" },
          h(
            "div",
            { class: "page-head-main" },
            hubPicker,
            h("div", { class: "field cu-picker" }, h("label", { for: "cu-space" }, "Space"), picker),
            h("h1", { class: "page-title" }, space ? `Catch up on ${space.name}` : "Catch up"),
            space && !v.loading && !v.error
              ? h("p", { class: "section-note" }, `${since}: ${plural(mates.length, "teammate")}, ${plural(v.notes.length, "note")}, ${plural(decisions, "decision")}.`)
              : null,
            space && !v.loading && !v.error && standardsLine(v.standards)
              ? h("p", { class: "section-note cu-standards" }, `Team standards in this project: ${standardsLine(v.standards)}`)
              : null,
          ),
          h(
            "div",
            { class: "cu-range", role: "group", "aria-label": "Time range" },
            ...RANGES.map((r) => h("button", { type: "button", class: "cu-pill", "aria-pressed": String(v.range === r.id), onclick: () => { v.range = r.id; load(); } }, r.label)),
          ),
        ),
      ];

      if (!opts.length) {
        kids.push(h("p", { class: "hint" }, "No spaces to catch up on yet. Share a folder from This machine first."));
      } else if (v.error) {
        kids.push(h("div", { class: "banner is-error", role: "alert" }, h("div", { class: "banner-body" }, h("span", { class: "banner-title" }, "Can't load this space"), v.error)));
      } else if (v.loading) {
        kids.push(h("p", { class: "loading", "aria-live": "polite" }, "Loading…"));
      } else {
        if (v.features?.ask) kids.push(askBox());
        kids.push(
          h(
            "section",
            { class: "cu-section", "aria-labelledby": "cu-who" },
            h("h2", { id: "cu-who", class: "section-title" }, "What teammates did"),
            groups.length ? h("div", { class: "cu-people" }, ...groups.map(personCard)) : h("p", { class: "hint" }, "Nothing new in this range."),
          ),
          h(
            "section",
            { class: "cu-section", "aria-labelledby": "cu-notes" },
            h(
              "div",
              { class: "cu-feed-head" },
              h("h2", { id: "cu-notes", class: "section-title" }, "Notes"),
              h("div", { class: "cu-filters", role: "group", "aria-label": "Filter notes" }, ...FILTERS.map(([id, label]) => h("button", { type: "button", class: "cu-pill", "aria-pressed": String(v.filter === id), onclick: () => { v.filter = id; render(); } }, label))),
            ),
            shown.length
              ? h("div", { class: "panel cu-feed" }, ...groupByDay(shown).map((d) => h("div", {}, h("div", { class: "cu-day" }, d.label), ...d.notes.map(noteRow))))
              : h("p", { class: "hint" }, "No notes match."),
          ),
        );
      }
      const focus = document.activeElement?.id;
      root.replaceChildren(...kids);
      if (focus && root.contains(document.getElementById(focus))) document.getElementById(focus).focus();
    }

    function askBox() {
      const input = h("input", { id: "cu-ask", type: "text", maxlength: "2000", value: v.question, "aria-label": "Your question", placeholder: "What did we decide about…?" });
      const answer = v.asking
        ? h("p", { class: "hint", "aria-live": "polite" }, "Thinking…")
        : v.askErr
          ? h("p", { class: "inline-error", role: "alert" }, v.askErr)
          : v.ask
            ? h(
                "div",
                { id: "cu-answer", class: "cu-answer", tabindex: "-1" },
                ...v.ask.answer.split(/\n{2,}/).map((p) => h("p", {}, p)),
                v.ask.sources.length
                  ? h("ul", { class: "cu-sources" }, ...v.ask.sources.map((s) => h("li", {}, `[${s.n}] ${s.title || "Untitled"}`, h("span", { class: "row-note" }, `${s.author} · ${dayTime(s.created_at_epoch)}`))))
                  : null,
              )
            : null;
      return h(
        "section",
        { class: "cu-ask", "aria-labelledby": "cu-ask-h" },
        h("h2", { id: "cu-ask-h", class: "section-title" }, "Ask this space"),
        h("form", { class: "cu-ask-form", onsubmit: (e) => { e.preventDefault(); v.askErr = ""; askNow(input.value); } }, input, h("button", { type: "submit", class: "btn btn-primary", disabled: v.asking }, "Ask")),
        answer,
      );
    }

    const gitTag = (c) =>
      c.href
        ? h("a", { class: "tag", href: c.href, target: "_blank", rel: "noopener noreferrer", title: c.title }, c.text)
        : h("span", { class: "tag", title: c.title }, c.text);

    function personCard(g) {
      const chips = gitChips(g.branches);
      return h(
        "article",
        { class: "cu-person" },
        h("div", { class: "cu-person-head" }, avatar({ id: g.author, name: g.author }), h("div", {}, h("div", { class: "cu-person-name" }, g.mine ? "You" : g.author), h("div", { class: "row-note" }, `${plural(g.count, "note")} · last ${dayTime(g.last)}`))),
        h("ul", {}, ...g.titles.map((t) => h("li", {}, t))),
        g.files.length ? h("div", { class: "cu-chips" }, ...fileChips(g.files, [...viewRoots(), ...g.branches.map((b) => repoName(b.remote))])) : null,
        chips.length ? h("div", { class: "cu-chips cu-git" }, ...chips.map(gitTag)) : null,
      );
    }

    return {
      /** Called when the view is shown. */
      show() {
        if (!state.hubs.some((hb) => hb.id === v.hubId)) {
          v.hubId = state.projects.find((p) => p.mapping)?.hub_id ?? state.hubs[0]?.id ?? "";
          v.spaceId = "";
        }
        if (!spaceOptions().some((s) => s.id === v.spaceId)) firstSpace();
        load();
      },
      hide: leave,
    };
  }

  window.MemSyncCatchup = { repoName, shortPath, GIT_PATHS, safeGitUrl, gitLinks, gitChips, gitLine, toSpaceId, standardsLine, groupByAuthor, groupByDay, nextLastVisit, pickerGroups, visitKey, lastVisit, mount };
})();
