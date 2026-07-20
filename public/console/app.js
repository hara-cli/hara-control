/*!
 * hara-control · console · app.js
 *
 * Single-page console. No framework, no build. Responsibilities:
 *   1. i18n engine  — three dicts loaded as window.HARA_I18N.{en,zh-CN,zh-TW}.
 *   2. Hash router  — six views (overview/orgs/fleet/enroll/users/security).
 *   3. Auth flow    — email+password → optional TOTP code → JWT (8h).
 *   4. API client   — every endpoint from _legacy_index.html, contract-identical.
 *   5. QR codes     — window.HaraQR.toSvg() called for the 2FA enrollment view.
 *
 * Storage: only `hara_jwt` + `hara_me` + `hara_lang` live in localStorage.
 * Security: every interpolated value runs through escapeHtml() before reaching innerHTML.
 */
(() => {
  "use strict";

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 1.  i18n engine                                                   ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const I18N = (() => {
    const LANGS = ["en", "zh-CN", "zh-TW"];
    const STORE_KEY = "hara_lang";

    // pick the best dict for the current visitor based on the browser locale
    // (zh-TW / zh-HK → zh-TW; other zh → zh-CN; everything else → en)
    function detect() {
      const stored = localStorage.getItem(STORE_KEY);
      if (stored && LANGS.includes(stored)) return stored;
      const raw = (navigator.language || "en").toLowerCase();
      if (raw.startsWith("zh-tw") || raw.startsWith("zh-hk") || raw.startsWith("zh-mo") || raw === "zh-hant") return "zh-TW";
      if (raw.startsWith("zh")) return "zh-CN";
      return "en";
    }

    let current = detect();
    const dicts = window.HARA_I18N || {};

    function t(key, params) {
      let str = (dicts[current] && dicts[current][key]) || (dicts.en && dicts.en[key]);
      if (str == null) return key;
      if (params) {
        Object.keys(params).forEach((k) => {
          str = str.replace(new RegExp("\\{" + k + "\\}", "g"), params[k]);
        });
      }
      return str;
    }

    // Walk every flagged DOM node and stamp the localised string in place.
    // Three attribute conventions are supported so we don't have to fork
    // markup for placeholders / title attributes.
    function apply(root) {
      root = root || document;
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.getAttribute("data-i18n"));
      });
      root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
      });
      root.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
      });
      document.documentElement.setAttribute("lang", current);
    }

    function set(lang) {
      if (!LANGS.includes(lang)) return;
      current = lang;
      localStorage.setItem(STORE_KEY, lang);
      apply();
      updateLangSwitcher();
      // re-render any view that paints text from JS (tables, toasts already gone)
      if (typeof window.__rerenderCurrentView === "function") window.__rerenderCurrentView();
    }

    function updateLangSwitcher() {
      document.querySelectorAll(".topbar__lang-opt").forEach((btn) => {
        const active = btn.getAttribute("data-lang") === current;
        btn.classList.toggle("topbar__lang-opt--active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }

    return {
      get current() { return current; },
      t,
      apply,
      set,
      updateLangSwitcher,
    };
  })();

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 2.  helpers                                                        ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function truncateMid(s, head = 12, tail = 4) {
    if (!s || s.length <= head + tail + 1) return s;
    return s.slice(0, head) + "…" + s.slice(-tail);
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toISOString().slice(0, 10); } catch { return String(iso); }
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return String(iso); }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    // Fallback for non-secure context (http://console.nanhara.tech still works since browsers
    // recognise localhost-ish hosts as secure, but be defensive).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); return true; } catch { return false; }
    finally { document.body.removeChild(ta); }
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 3.  toast                                                         ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg, kind = "ok") {
    toastEl.textContent = msg;
    toastEl.className = "toast toast--" + kind;
    toastEl.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 4.  API client — every endpoint name + payload is pinned to       ║
  // ║                  the live NestJS contract (do NOT change without  ║
  // ║                  changing the server).                            ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const TOKEN_KEY = "hara_jwt";
  const ME_KEY = "hara_me";

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearAuth = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); };

  async function api(method, path, body) {
    const headers = { "content-type": "application/json" };
    const tok = getToken();
    if (tok) headers["authorization"] = "Bearer " + tok;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      throw new Error(I18N.t("err.network"));
    }
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (res.status === 401) {
      clearAuth();
      showLogin();
      throw new Error((data && data.message) || I18N.t("err.unauthorized"));
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || (typeof data === "string" ? data : I18N.t("err.generic"));
      throw new Error(Array.isArray(msg) ? msg.join("; ") : msg);
    }
    return data;
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 5.  screen toggles + boot                                         ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const loginScreen = $("#login-screen");
  const appScreen = $("#app-screen");

  function showLogin() {
    loginScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
  }
  function showApp() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
  }

  let me = null; // { id, email, role, twofa_enabled, ... }

  async function boot() {
    try {
      me = await api("GET", "/auth/me");
      $("#who-email").textContent = me.email;
      const roleEl = $("#who-role");
      roleEl.textContent = me.role;
      roleEl.className = "pill topbar__role pill--role-" + me.role;

      // SUPERADMIN gets the Users nav item; others don't even see it
      if (me.role === "SUPERADMIN") {
        $("#nav-users").classList.remove("hidden");
      } else {
        $("#nav-users").classList.add("hidden");
      }

      showApp();
      router.dispatch();   // honour whatever hash the user landed on
    } catch (e) {
      showLogin();
    }
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 6.  login screen (2-step: password → optional TOTP)               ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const loginForm = $("#login-form");
  const liErr = $("#li-err");
  const li2faWrap = $("#li-2fa-wrap");
  const liCodeInput = $("#li-code");
  const liSubmitBtn = $("#li-submit");

  function resetLoginForm() {
    li2faWrap.classList.remove("login__2fa--shown");
    liCodeInput.value = "";
    liSubmitBtn.textContent = I18N.t("login.submit");
    liErr.textContent = "";
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    liErr.textContent = "";
    const email = $("#li-email").value.trim();
    const password = $("#li-password").value;
    const code = li2faWrap.classList.contains("login__2fa--shown") ? liCodeInput.value.trim() : undefined;
    try {
      // exact API contract:
      //   POST /auth/login {email, password}              → either {access_token,...} or {requires_2fa:true}
      //   POST /auth/login {email, password, code}        → {access_token,...} (or 401)
      const r = await api("POST", "/auth/login", code ? { email, password, code } : { email, password });
      if (r && r.requires_2fa) {
        li2faWrap.classList.add("login__2fa--shown");
        liSubmitBtn.textContent = I18N.t("login.verify");
        liCodeInput.focus();
        return;
      }
      setToken(r.access_token);
      localStorage.setItem(ME_KEY, JSON.stringify({ email: r.email, role: r.role }));
      resetLoginForm();
      await boot();
    } catch (err) {
      liErr.textContent = err.message || I18N.t("err.generic");
    }
  });

  $("#logout").addEventListener("click", () => {
    clearAuth();
    resetLoginForm();
    me = null;
    showLogin();
  });

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 7.  hash router                                                   ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  const router = (() => {
    const ROUTES = ["overview", "orgs", "fleet", "enroll", "users", "security"];
    const handlers = {};   // optional onEnter hooks per view

    let last = null;
    function current() {
      const raw = (location.hash || "").replace(/^#\/?/, "").split("/")[0];
      return ROUTES.includes(raw) ? raw : "overview";
    }

    function navigate(name) {
      if (!ROUTES.includes(name)) name = "overview";
      if (location.hash !== "#/" + name) {
        location.hash = "#/" + name;   // dispatch via hashchange
      } else {
        dispatch();
      }
    }

    function dispatch() {
      const name = current();
      // Authorize: Users tab is SUPERADMIN-only. Sneaky URLs land on overview.
      if (name === "users" && (!me || me.role !== "SUPERADMIN")) {
        navigate("overview");
        return;
      }
      $$(".view").forEach((v) => v.classList.add("hidden"));
      const target = $("#view-" + name);
      if (target) target.classList.remove("hidden");
      $$(".sidebar__item").forEach((a) => {
        a.classList.toggle("sidebar__item--active", a.getAttribute("data-route") === name);
      });
      const crumb = $("#crumb-current");
      if (crumb) {
        crumb.setAttribute("data-i18n", "crumb." + name);
        crumb.textContent = I18N.t("crumb." + name);
      }
      last = name;
      if (handlers[name]) handlers[name]();
    }

    function on(name, fn) { handlers[name] = fn; }

    window.addEventListener("hashchange", dispatch);

    return { navigate, dispatch, on, get current() { return last || current(); } };
  })();

  // expose a re-render hook so the i18n language switcher can refresh
  // tables that were painted from JS strings (Fleet / Users / Orgs subtree).
  window.__rerenderCurrentView = () => {
    const r = router.current;
    if (r === "fleet" && lastFleetRows) renderFleet();
    if (r === "users") loadUsers();
    if (r === "orgs" && lastInspectId) inspectOrg(lastInspectId);
    if (r === "enroll" && lastEnrollResult) paintEnrollResult(lastEnrollResult);
    if (r === "overview") refreshOverview();
    if (r === "security" && me && me.role === "SUPERADMIN") loadProviderStatus();
    // login + the remaining security copy is data-i18n-driven so apply() handles it
  };

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 8.  Overview view                                                 ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  router.on("overview", refreshOverview);

  async function refreshOverview() {
    // KPI: derive from the lists we already have endpoints for.
    // /admin/orgs and /admin/users exist; /admin/fleet needs an orgId so we
    // can't count global devices yet — show "—" with the placeholder hint.
    $("#kpi-devices-online").textContent = "—";
    $("#kpi-activity-today").textContent = "—";

    // Orgs count — best-effort; if there's no list endpoint (server only
    // exposes inspect-by-id), leave a dash. Try `/admin/orgs` defensively.
    try {
      const orgs = await api("GET", "/admin/orgs");
      if (Array.isArray(orgs)) $("#kpi-orgs").textContent = String(orgs.length);
    } catch { /* endpoint may not exist — keep "—" */ }

    if (me && me.role === "SUPERADMIN") {
      try {
        const users = await api("GET", "/admin/users");
        if (Array.isArray(users)) $("#kpi-users").textContent = String(users.length);
      } catch { /* keep "—" */ }
    } else {
      $("#kpi-users").textContent = "—";
    }
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 9.  Orgs view                                                     ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  let lastInspectId = null;

  $("#org-create").addEventListener("click", async () => {
    const name = $("#org-name").value.trim();
    const type = $("#org-type").value;
    const parentOrgId = $("#org-parent").value.trim() || undefined;
    if (!name) { toast(I18N.t("err.name_required"), "err"); return; }
    try {
      const body = parentOrgId ? { name, type, parentOrgId } : { name, type };
      const org = await api("POST", "/admin/orgs", body);
      $("#org-create-out").innerHTML =
        `<span class="small">${escapeHtml(I18N.t("orgs.new.created"))}:</span> <code class="pill">${escapeHtml(org.id)}</code>`;
      $("#org-name").value = "";
      $("#org-parent").value = "";
      toast(I18N.t("ok.org_created"), "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  $("#org-inspect").addEventListener("click", () => {
    const id = $("#org-id").value.trim();
    if (!id) { $("#org-inspect-out").innerHTML = ""; return; }
    inspectOrg(id);
  });

  let subtreeShowAll = false;

  async function inspectOrg(id) {
    lastInspectId = id;
    const out = $("#org-inspect-out");
    try {
      const [ancestors, subtree] = await Promise.all([
        api("GET", `/admin/orgs/${encodeURIComponent(id)}/ancestors`),
        api("GET", `/admin/orgs/${encodeURIComponent(id)}/subtree`),
      ]);
      // ancestors comes back self→root; we want root→self for natural reading.
      const path = Array.isArray(ancestors) ? ancestors.slice().reverse() : [];
      const sep = '<span class="crumbpath__sep">›</span>';
      const trail = path.length
        ? path.map((o) => `
            <span class="crumbpath__node">
              <span class="crumbpath__name">${escapeHtml(o.name)}</span>
              <span class="pill pill--muted">${escapeHtml(I18N.t("orgs.type." + o.type) || o.type)}</span>
            </span>`).join(sep)
        : `<span class="muted">${escapeHtml(I18N.t("orgs.inspect.empty"))}</span>`;

      const ids = Array.isArray(subtree) ? subtree : [];
      const showAll = subtreeShowAll || ids.length <= 20;
      const visible = showAll ? ids : ids.slice(0, 20);
      const extra = ids.length - visible.length;
      const toggleLabel = showAll
        ? I18N.t("orgs.inspect.subtree.show_less")
        : I18N.t("orgs.inspect.subtree.show_all");

      out.innerHTML = `
        <div class="small mb-1">${escapeHtml(I18N.t("orgs.inspect.ancestors"))}</div>
        <div class="crumbpath mb-2">${trail}</div>
        <div class="flex ai-center jc-between mb-1">
          <div class="small">${escapeHtml(I18N.t("orgs.inspect.subtree.count", { n: ids.length }))}</div>
          ${ids.length > 20 ? `<button type="button" class="btn-link" id="subtree-toggle">${escapeHtml(toggleLabel)}</button>` : ""}
        </div>
        <pre class="copybox">${escapeHtml(visible.join("\n"))}${!showAll && extra > 0 ? `\n${escapeHtml(I18N.t("orgs.inspect.subtree.more", { n: extra }))}` : ""}</pre>
      `;

      const toggleBtn = $("#subtree-toggle");
      if (toggleBtn) toggleBtn.addEventListener("click", () => {
        subtreeShowAll = !subtreeShowAll;
        inspectOrg(id);
      });
    } catch (e) { toast(e.message, "err"); }
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 10.  Fleet view                                                   ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  let lastFleetRows = null;
  let lastFleetOrgId = null;
  let fleetFilter = { search: "", model: "", onlineOnly: false };

  $("#fleet-load").addEventListener("click", loadFleet);

  ["fleet-filter-search", "fleet-filter-model"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      fleetFilter.search = $("#fleet-filter-search").value.trim().toLowerCase();
      fleetFilter.model = $("#fleet-filter-model").value.trim().toLowerCase();
      renderFleet();
    });
  });
  $("#fleet-filter-online").addEventListener("change", (e) => {
    fleetFilter.onlineOnly = e.target.checked;
    renderFleet();
  });

  async function loadFleet() {
    const orgId = $("#fleet-orgid").value.trim();
    const wrap = $("#fleet-table");
    const filterHost = $("#fleet-filter-host");
    if (!orgId) {
      wrap.innerHTML = `<div class="empty">${escapeHtml(I18N.t("fleet.empty.no_org"))}</div>`;
      filterHost.classList.add("hidden");
      lastFleetRows = null;
      return;
    }
    try {
      const rows = await api("GET", `/admin/fleet?orgId=${encodeURIComponent(orgId)}`);
      lastFleetRows = Array.isArray(rows) ? rows : [];
      lastFleetOrgId = orgId;
      if (!lastFleetRows.length) {
        filterHost.classList.add("hidden");
        wrap.innerHTML = `<div class="empty">${escapeHtml(I18N.t("fleet.empty.no_devices"))}</div>`;
        return;
      }
      filterHost.classList.remove("hidden");
      renderFleet();
    } catch (e) { toast(e.message, "err"); }
  }

  function renderFleet() {
    const wrap = $("#fleet-table");
    if (!lastFleetRows) return;
    const filtered = lastFleetRows.filter((d) => {
      if (fleetFilter.onlineOnly && !d.online) return false;
      if (fleetFilter.search && !(String(d.name || "").toLowerCase().includes(fleetFilter.search))) return false;
      if (fleetFilter.model && !(String(d.model || "").toLowerCase().includes(fleetFilter.model))) return false;
      return true;
    });
    if (!filtered.length) {
      wrap.innerHTML = `<div class="empty">${escapeHtml(I18N.t("fleet.empty.no_match"))}</div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 18px;"></th>
              <th>${escapeHtml(I18N.t("fleet.col.name"))}</th>
              <th>${escapeHtml(I18N.t("fleet.col.os"))}</th>
              <th>${escapeHtml(I18N.t("fleet.col.model"))}</th>
              <th class="num">${escapeHtml(I18N.t("fleet.col.spend"))}</th>
              <th>${escapeHtml(I18N.t("fleet.col.id"))}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((d) => `
              <tr class="${d.online ? "row--online" : "row--offline"}">
                <td></td>
                <td>${escapeHtml(d.name || "—")}</td>
                <td>${escapeHtml(d.os || "—")}</td>
                <td>${escapeHtml(d.model || "—")}</td>
                <td class="num">$${Number(d.spend ?? 0).toFixed(2)}</td>
                <td>
                  <span class="id-cell" title="${escapeHtml(d.device_id)}">
                    <span>${escapeHtml(truncateMid(d.device_id))}</span>
                    <button type="button" class="btn-icon id-cell__copy" data-copy="${escapeHtml(d.device_id)}"
                            title="${escapeHtml(I18N.t("fleet.copy.id"))}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
                    </button>
                  </span>
                </td>
                <td>
                  <div class="row-actions">
                    ${d.token_active
                      ? `<button type="button" class="btn-danger" data-revoke="${escapeHtml(d.device_id)}">${escapeHtml(I18N.t("fleet.revoke"))}</button>`
                      : `<span class="small">${escapeHtml(I18N.t("fleet.revoked"))}</span>`}
                  </div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    wrap.querySelectorAll("button[data-revoke]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.getAttribute("data-revoke");
        if (!confirm(I18N.t("fleet.revoke.confirm", { id }))) return;
        try {
          const r = await api("POST", `/admin/devices/${encodeURIComponent(id)}/revoke`);
          toast(I18N.t("fleet.revoke.toast", { n: r.revoked }), "ok");
          loadFleet();
        } catch (e) { toast(e.message, "err"); }
      });
    });

    wrap.querySelectorAll("button[data-copy]").forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (await copyText(b.getAttribute("data-copy"))) toast(I18N.t("common.copied"), "ok");
      });
    });
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 11.  Enroll codes                                                 ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  let lastEnrollResult = null;

  $("#ec-create").addEventListener("click", async () => {
    const orgId = $("#ec-orgid").value.trim();
    const model = $("#ec-model").value.trim();
    const gateway = $("#ec-gateway").value.trim().replace(/\/$/, "");
    if (!orgId) { toast(I18N.t("err.orgid_required"), "err"); return; }
    try {
      const r = await api("POST", "/admin/enroll-codes", { orgId, model: model || undefined });
      lastEnrollResult = { code: r.code, gateway, expiresAt: r.expiresAt };
      paintEnrollResult(lastEnrollResult);
      toast(I18N.t("ok.enroll_minted"), "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  function paintEnrollResult({ code, gateway, expiresAt }) {
    $("#ec-code-text").textContent = code;
    $("#ec-cmd-text").textContent = `hara enroll ${gateway} --code ${code}`;
    $("#ec-expires").textContent = formatDateTime(expiresAt);
    $("#ec-result").classList.remove("hidden");
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 12.  Users (SUPERADMIN only)                                      ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  router.on("users", loadUsers);

  $("#users-new-btn").addEventListener("click", () => openNewUserModal());

  async function loadUsers() {
    const wrap = $("#users-table");
    try {
      const users = await api("GET", "/admin/users");
      if (!Array.isArray(users) || !users.length) {
        wrap.innerHTML = `<div class="empty">${escapeHtml(I18N.t("users.empty"))}</div>`;
        return;
      }
      wrap.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th style="width: 18px;"></th>
                <th>${escapeHtml(I18N.t("users.col.email"))}</th>
                <th>${escapeHtml(I18N.t("users.col.role"))}</th>
                <th>${escapeHtml(I18N.t("users.col.org"))}</th>
                <th>${escapeHtml(I18N.t("users.col.status"))}</th>
                <th>${escapeHtml(I18N.t("users.col.created"))}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${users.map((u) => {
                const isDisabled = !!u.disabledAt;
                const rowClass = isDisabled ? "row--disabled" : "row--online";
                return `
                  <tr class="${rowClass}">
                    <td></td>
                    <td>${escapeHtml(u.email)}</td>
                    <td><span class="pill pill--role-${escapeHtml(u.role)}">${escapeHtml(u.role)}</span></td>
                    <td class="mono">${escapeHtml(u.orgId || "—")}</td>
                    <td>${isDisabled
                      ? `<span style="color:var(--err)">${escapeHtml(I18N.t("users.status.disabled"))}</span>`
                      : `<span style="color:var(--ok)">${escapeHtml(I18N.t("users.status.active"))}</span>`}</td>
                    <td class="mono">${escapeHtml(formatDate(u.createdAt))}</td>
                    <td>
                      <div class="row-actions">
                        <button type="button" class="btn-ghost" data-toggle="${escapeHtml(u.id)}" data-disabled="${isDisabled ? "1" : "0"}">
                          ${escapeHtml(isDisabled ? I18N.t("users.action.enable") : I18N.t("users.action.disable"))}
                        </button>
                        <button type="button" class="btn-ghost" data-role="${escapeHtml(u.id)}" data-current="${escapeHtml(u.role)}" data-email="${escapeHtml(u.email)}">
                          ${escapeHtml(I18N.t("users.action.role"))}
                        </button>
                        <button type="button" class="btn-ghost" data-pw="${escapeHtml(u.id)}" data-email="${escapeHtml(u.email)}">
                          ${escapeHtml(I18N.t("users.action.password"))}
                        </button>
                      </div>
                    </td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`;

      // disable/enable
      wrap.querySelectorAll("button[data-toggle]").forEach((b) => {
        b.addEventListener("click", async () => {
          const id = b.getAttribute("data-toggle");
          const isDisabled = b.getAttribute("data-disabled") === "1";
          try {
            await api("PATCH", `/admin/users/${encodeURIComponent(id)}`, { disabled: !isDisabled });
            toast(isDisabled ? I18N.t("users.toast.enabled") : I18N.t("users.toast.disabled"), "ok");
            loadUsers();
          } catch (e) { toast(e.message, "err"); }
        });
      });

      // change role (modal, not prompt())
      wrap.querySelectorAll("button[data-role]").forEach((b) => {
        b.addEventListener("click", () => {
          openRoleModal(b.getAttribute("data-role"), b.getAttribute("data-current"), b.getAttribute("data-email"));
        });
      });

      // reset password (modal, not prompt())
      wrap.querySelectorAll("button[data-pw]").forEach((b) => {
        b.addEventListener("click", () => {
          openPasswordModal(b.getAttribute("data-pw"), b.getAttribute("data-email"));
        });
      });

    } catch (e) {
      // 401 already redirects; only show toast for non-auth errors. 403 happens
      // when a non-SUPERADMIN reaches here via stale hash — we already block that
      // in router.dispatch but err on the side of being explicit.
      toast(e.message, "err");
    }
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 13.  modal helper                                                  ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  function openModal({ title, body, fields, primaryLabel, primaryClass = "btn", onConfirm }) {
    const host = $("#modal-host");
    const id = "modal-" + Math.random().toString(36).slice(2, 9);
    const fieldsHtml = (fields || []).map((f, i) => `
      <div class="field">
        <label class="field__label" for="${id}-f${i}">${escapeHtml(f.label)}</label>
        ${f.type === "select"
          ? `<select class="select" id="${id}-f${i}">
              ${f.options.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === f.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
            </select>`
          : `<input class="input ${f.mono ? "input--mono" : ""}" id="${id}-f${i}" type="${escapeHtml(f.type || "text")}" value="${escapeHtml(f.value || "")}" placeholder="${escapeHtml(f.placeholder || "")}" ${f.minlength ? `minlength="${f.minlength}"` : ""} ${f.maxlength ? `maxlength="${f.maxlength}"` : ""}>`}
        ${f.hint ? `<div class="field__hint">${escapeHtml(f.hint)}</div>` : ""}
      </div>`).join("");
    host.innerHTML = `
      <div class="modal-backdrop" id="${id}-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
          <h2 class="modal__title" id="${id}-title">${escapeHtml(title)}</h2>
          ${body ? `<p class="modal__body">${escapeHtml(body)}</p>` : ""}
          ${fieldsHtml}
          <div class="modal__actions">
            <button type="button" class="btn-ghost" id="${id}-cancel">${escapeHtml(I18N.t("common.cancel"))}</button>
            <button type="button" class="${primaryClass}" id="${id}-confirm">${escapeHtml(primaryLabel)}</button>
          </div>
        </div>
      </div>`;
    function close() { host.innerHTML = ""; }
    $("#" + id + "-cancel").addEventListener("click", close);
    $("#" + id + "-backdrop").addEventListener("click", (e) => { if (e.target.id === id + "-backdrop") close(); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
    $("#" + id + "-confirm").addEventListener("click", () => {
      const values = (fields || []).map((_, i) => $("#" + id + "-f" + i).value);
      const out = onConfirm(values, close);
      // onConfirm may return a promise; close is the caller's job
    });
    // focus first field
    setTimeout(() => { const first = host.querySelector("input, select"); if (first) first.focus(); }, 30);
  }

  function openNewUserModal() {
    openModal({
      title: I18N.t("users.new"),
      fields: [
        { label: I18N.t("users.new.email"), type: "email", placeholder: I18N.t("users.new.email.placeholder") },
        { label: I18N.t("users.new.password"), type: "password", placeholder: I18N.t("users.new.password.placeholder"), minlength: 12 },
        {
          label: I18N.t("users.new.role"), type: "select", value: "ADMIN",
          options: [
            { value: "SUPERADMIN", label: I18N.t("common.role.SUPERADMIN") },
            { value: "ADMIN", label: I18N.t("common.role.ADMIN") },
            { value: "MEMBER", label: I18N.t("common.role.MEMBER") },
          ],
        },
        { label: I18N.t("users.new.orgid"), mono: true, placeholder: I18N.t("users.new.orgid.placeholder") },
      ],
      primaryLabel: I18N.t("users.new.create"),
      onConfirm: async (vals, close) => {
        const [email, password, role, orgId] = vals;
        if (!email || !password) { toast(I18N.t("err.email_password_required"), "err"); return; }
        if (password.length < 12) { toast(I18N.t("err.short_password"), "err"); return; }
        try {
          await api("POST", "/admin/users", { email, password, role, orgId: orgId || undefined });
          toast(I18N.t("users.toast.created"), "ok");
          close();
          loadUsers();
        } catch (e) { toast(e.message, "err"); }
      },
    });
  }

  function openRoleModal(id, current, email) {
    openModal({
      title: I18N.t("users.role.title"),
      body: I18N.t("users.role.body", { email }),
      fields: [{
        label: I18N.t("users.new.role"), type: "select", value: current,
        options: [
          { value: "SUPERADMIN", label: I18N.t("common.role.SUPERADMIN") },
          { value: "ADMIN", label: I18N.t("common.role.ADMIN") },
          { value: "MEMBER", label: I18N.t("common.role.MEMBER") },
        ],
      }],
      primaryLabel: I18N.t("common.save"),
      onConfirm: async (vals, close) => {
        const [role] = vals;
        if (!role || !["SUPERADMIN", "ADMIN", "MEMBER"].includes(role)) { toast(I18N.t("err.bad_role"), "err"); return; }
        try {
          await api("PATCH", `/admin/users/${encodeURIComponent(id)}`, { role });
          toast(I18N.t("users.toast.role_updated"), "ok");
          close();
          loadUsers();
        } catch (e) { toast(e.message, "err"); }
      },
    });
  }

  function openPasswordModal(id, email) {
    openModal({
      title: I18N.t("users.password.title"),
      body: I18N.t("users.password.body", { email }),
      fields: [{ label: I18N.t("users.password.field"), type: "password", placeholder: I18N.t("users.new.password.placeholder"), minlength: 12 }],
      primaryLabel: I18N.t("common.save"),
      onConfirm: async (vals, close) => {
        const [password] = vals;
        if (!password || password.length < 12) { toast(I18N.t("err.short_password"), "err"); return; }
        try {
          await api("PATCH", `/admin/users/${encodeURIComponent(id)}`, { password });
          toast(I18N.t("users.toast.password_reset"), "ok");
          close();
        } catch (e) { toast(e.message, "err"); }
      },
    });
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 14.  Security (own 2FA)                                            ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  router.on("security", renderSecurity);

  let pendingSecret = "";   // held in memory only, never localStorage
  let pendingUri = "";

  function renderSecurity() {
    const enabled = !!(me && me.twofa_enabled);
    const statusEl = $("#sec-status-msg");
    statusEl.textContent = enabled ? I18N.t("security.status.on") : I18N.t("security.status.off");
    $("#sec-enable-wrap").classList.toggle("hidden", enabled);
    $("#sec-disable-wrap").classList.toggle("hidden", !enabled);
    if (!enabled) {
      $("#sec-enable-step2").classList.add("hidden");
      pendingSecret = "";
      pendingUri = "";
    }
    const providerCard = $("#provider-security-card");
    const canManageProvider = !!(me && me.role === "SUPERADMIN");
    providerCard.classList.toggle("hidden", !canManageProvider);
    if (canManageProvider) loadProviderStatus();
  }

  async function loadProviderStatus() {
    const out = $("#provider-status");
    out.textContent = I18N.t("common.loading");
    try {
      const status = await api("GET", "/admin/providers/deepseek");
      const yesNo = (value) => I18N.t(value ? "provider.status.yes" : "provider.status.no");
      const readable = status.stored && !status.storage_readable
        ? I18N.t("provider.status.unreadable")
        : yesNo(status.stored);
      const note = status.requires_activation
        ? I18N.t("provider.status.needs_activation")
        : status.active
          ? I18N.t("provider.status.ready")
          : "";
      out.textContent = [
        `${I18N.t("provider.status.stored")}: ${readable}`,
        `${I18N.t("provider.status.runtime")}: ${yesNo(status.runtime_configured)}`,
        `${I18N.t("provider.status.reachable")}: ${yesNo(status.runtime_reachable)}`,
        `${I18N.t("provider.status.active")}: ${yesNo(status.active)}`,
        note,
      ].filter(Boolean).join(" · ");
      $("#provider-test-stored").disabled = !status.stored || !status.storage_readable;
      $("#provider-test-runtime").disabled = !status.runtime_configured;
    } catch (e) {
      out.textContent = e.message;
    }
  }

  $("#provider-refresh").addEventListener("click", loadProviderStatus);

  $("#provider-replace").addEventListener("click", () => {
    openModal({
      title: I18N.t("provider.key.title"),
      body: I18N.t("provider.key.body"),
      fields: [{
        label: I18N.t("provider.key.label"),
        type: "password",
        placeholder: I18N.t("provider.key.placeholder"),
        minlength: 8,
        maxlength: 4096,
      }],
      primaryLabel: I18N.t("common.save"),
      onConfirm: async (values, close) => {
        const apiKey = values[0];
        if (!apiKey) {
          toast(I18N.t("provider.err.key_required"), "err");
          return;
        }
        try {
          await api("PUT", "/admin/providers/deepseek/credential", { apiKey });
          values[0] = "";
          close();
          toast(I18N.t("provider.toast.saved"), "ok");
          await loadProviderStatus();
        } catch (e) {
          toast(e.message, "err");
        }
      },
    });
  });

  async function testProviderCredential(target) {
    try {
      await api("POST", "/admin/providers/deepseek/credential/test", { target });
      toast(I18N.t("provider.toast.test_ok"), "ok");
      await loadProviderStatus();
    } catch (e) {
      toast(e.message, "err");
    }
  }

  $("#provider-test-stored").addEventListener("click", () => testProviderCredential("stored"));
  $("#provider-test-runtime").addEventListener("click", () => testProviderCredential("runtime"));

  $("#sec-enable-start").addEventListener("click", async () => {
    try {
      const r = await api("POST", "/auth/2fa/setup");
      pendingSecret = r.secret;
      pendingUri = r.otpauth_uri;
      $("#sec-secret").textContent = r.secret;
      $("#sec-uri").textContent = r.otpauth_uri;
      // paint QR via vendored generator
      try {
        const svg = window.HaraQR.toSvg(r.otpauth_uri, { margin: 2, dark: "#0b0e14", light: "#fff" });
        $("#sec-qr-box").innerHTML = svg;
      } catch (qrErr) {
        // fallback: surface the URI in a copybox if QR generation fails
        $("#sec-qr-box").innerHTML = `<div class="small">QR: ${escapeHtml(qrErr.message)}</div>`;
      }
      $("#sec-enable-step2").classList.remove("hidden");
      $("#sec-enable-code").focus();
    } catch (e) { toast(e.message, "err"); }
  });

  $("#sec-enable-cancel").addEventListener("click", () => {
    pendingSecret = "";
    pendingUri = "";
    $("#sec-secret").textContent = "";
    $("#sec-uri").textContent = "";
    $("#sec-qr-box").innerHTML = "";
    $("#sec-enable-code").value = "";
    $("#sec-enable-step2").classList.add("hidden");
  });

  $("#sec-enable-confirm").addEventListener("click", async () => {
    const code = $("#sec-enable-code").value.trim();
    if (!/^\d{6}$/.test(code)) { toast(I18N.t("err.invalid_code"), "err"); return; }
    if (!pendingSecret) { toast(I18N.t("err.no_pending_secret"), "err"); return; }
    try {
      await api("POST", "/auth/2fa/enable", { secret: pendingSecret, code });
      pendingSecret = "";
      pendingUri = "";
      $("#sec-enable-code").value = "";
      $("#sec-qr-box").innerHTML = "";
      toast(I18N.t("security.toast.enabled"), "ok");
      me = await api("GET", "/auth/me");
      renderSecurity();
    } catch (e) { toast(e.message, "err"); }
  });

  $("#sec-disable-go").addEventListener("click", async () => {
    const code = $("#sec-disable-code").value.trim();
    if (!/^\d{6}$/.test(code)) { toast(I18N.t("err.invalid_code"), "err"); return; }
    if (!confirm(I18N.t("security.disable.confirm"))) return;
    try {
      await api("POST", "/auth/2fa/disable", { code });
      $("#sec-disable-code").value = "";
      toast(I18N.t("security.toast.disabled"), "ok");
      me = await api("GET", "/auth/me");
      renderSecurity();
    } catch (e) { toast(e.message, "err"); }
  });

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 15.  global copy-button delegation                                ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-copy-from]");
    if (!t) return;
    const sel = t.getAttribute("data-copy-from");
    const src = document.querySelector(sel);
    if (!src) return;
    if (await copyText(src.textContent)) toast(I18N.t("common.copied"), "ok");
  });

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 16.  language switcher                                            ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  $$(".topbar__lang-opt").forEach((btn) => {
    btn.addEventListener("click", () => I18N.set(btn.getAttribute("data-lang")));
  });

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 17.  on load                                                       ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  I18N.apply();
  I18N.updateLangSwitcher();
  if (getToken()) {
    boot();
  } else {
    showLogin();
  }
})();
