/*!
 * hara-control · console · app.js
 *
 * Single-page console. No framework, no build. Responsibilities:
 *   1. i18n engine  — three dicts loaded as window.HARA_I18N.{en,zh-CN,zh-TW}.
 *   2. Hash router  — seven views (overview/orgs/fleet/usage/enroll/users/security).
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

  function formatMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2;
    return `$${amount.toLocaleString(I18N.current, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function formatCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count.toLocaleString(I18N.current, { maximumFractionDigits: 0 }) : "—";
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

  let orgChoices = null;
  let orgChoicesPromise = null;

  function paintOrgChoices() {
    if (!Array.isArray(orgChoices)) return;
    const datalist = $("#org-options");
    datalist.innerHTML = orgChoices.map((org) =>
      `<option value="${escapeHtml(org.id)}" label="${escapeHtml(org.name)}"></option>`).join("");

    const select = $("#usage-orgid");
    const previous = select.value;
    select.innerHTML = `<option value="">${escapeHtml(I18N.t("usage.org.choose"))}</option>` +
      orgChoices.map((org) =>
        `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)} · ${escapeHtml(org.type)}</option>`).join("");
    const preferred = previous || (me && me.orgId) || (orgChoices.length === 1 ? orgChoices[0].id : "");
    if (preferred && orgChoices.some((org) => org.id === preferred)) select.value = preferred;
    if (me && me.orgId) {
      if (!$("#fleet-orgid").value) $("#fleet-orgid").value = me.orgId;
      if (!$("#ec-orgid").value) $("#ec-orgid").value = me.orgId;
    }
  }

  async function getOrgChoices(force = false) {
    if (force) {
      orgChoices = null;
      orgChoicesPromise = null;
    }
    if (orgChoices) return orgChoices;
    if (!orgChoicesPromise) {
      orgChoicesPromise = api("GET", "/admin/orgs")
        .then((rows) => {
          orgChoices = Array.isArray(rows) ? rows : [];
          paintOrgChoices();
          return orgChoices;
        })
        .finally(() => { orgChoicesPromise = null; });
    }
    return orgChoicesPromise;
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
      getOrgChoices().catch(() => undefined);
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
    const ROUTES = ["overview", "orgs", "fleet", "usage", "enroll", "users", "security"];
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
    if (r === "usage" && lastUsageReport) renderUsage(lastUsageReport);
    if (r === "users") loadUsers();
    if (r === "orgs" && lastInspectId) inspectOrg(lastInspectId);
    if (r === "enroll") {
      if (managedModelCatalog) paintManagedModelCatalog();
      if (lastEnrollResult) paintEnrollResult(lastEnrollResult);
    }
    if (r === "overview") refreshOverview();
    if (r === "security" && me && me.role === "SUPERADMIN") loadProviderStatus();
    paintOrgChoices();
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
    const parentId = $("#org-parent").value.trim() || undefined;
    if (!name) { toast(I18N.t("err.name_required"), "err"); return; }
    try {
      const body = parentId ? { name, type, parentId } : { name, type };
      const org = await api("POST", "/admin/orgs", body);
      $("#org-create-out").innerHTML =
        `<span class="small">${escapeHtml(I18N.t("orgs.new.created"))}:</span> <code class="pill">${escapeHtml(org.id)}</code>`;
      $("#org-name").value = "";
      $("#org-parent").value = "";
      getOrgChoices(true).catch(() => undefined);
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
              <th>${escapeHtml(I18N.t("fleet.col.policy"))}</th>
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
                <td class="num">${escapeHtml(formatSpend(d))}</td>
                <td>
                  <div>${escapeHtml(d.expires_at
                    ? I18N.t("fleet.policy.expires", { date: formatDateTime(d.expires_at) })
                    : I18N.t("fleet.policy.no_expiry"))}</div>
                  <div class="small">${escapeHtml(formatBudgetSummary(d.budget_limits))}</div>
                  <div class="small">${escapeHtml(formatRateSummary(d.rpm_limit, d.tpm_limit))}</div>
                </td>
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
  // ║ 11.  Usage + quota flight recorder                                ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  let usageRange = "24h";
  let lastUsageReport = null;
  let usageRequestId = 0;

  router.on("usage", async () => {
    try {
      const orgs = await getOrgChoices();
      const select = $("#usage-orgid");
      if (!select.value && orgs.length) select.value = (me && me.orgId) || orgs[0].id;
      if (select.value) loadUsage();
      else renderUsagePrompt();
    } catch (error) {
      toast(error.message, "err");
      renderUsagePrompt();
    }
  });

  $("#usage-refresh").addEventListener("click", loadUsage);
  $("#usage-orgid").addEventListener("change", loadUsage);
  $$('[data-usage-range]').forEach((button) => {
    button.addEventListener("click", () => {
      usageRange = button.getAttribute("data-usage-range");
      $$('[data-usage-range]').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("segmented__item--active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      loadUsage();
    });
  });

  function renderUsagePrompt() {
    lastUsageReport = null;
    $("#usage-total-spend").textContent = "—";
    $("#usage-total-tokens").textContent = "—";
    $("#usage-total-requests").textContent = "—";
    $("#usage-latest").textContent = "—";
    $("#usage-updated").textContent = "—";
    $("#usage-unavailable").classList.add("hidden");
    $("#usage-chart").innerHTML = `<div class="empty">${escapeHtml(I18N.t("usage.empty.choose_org"))}</div>`;
    $("#usage-quotas").innerHTML = `<div class="empty empty--inline">${escapeHtml(I18N.t("usage.empty.choose_org"))}</div>`;
    $("#usage-breakdown").innerHTML = `<div class="empty empty--inline">${escapeHtml(I18N.t("usage.empty.choose_org"))}</div>`;
  }

  async function loadUsage() {
    const orgId = $("#usage-orgid").value;
    if (!orgId) { renderUsagePrompt(); return; }
    const requestId = ++usageRequestId;
    $("#usage-refresh").disabled = true;
    try {
      const report = await api("GET", `/admin/usage?orgId=${encodeURIComponent(orgId)}&range=${encodeURIComponent(usageRange)}`);
      if (requestId !== usageRequestId) return;
      lastUsageReport = report;
      renderUsage(report);
    } catch (error) {
      if (requestId === usageRequestId) toast(error.message, "err");
    } finally {
      if (requestId === usageRequestId) $("#usage-refresh").disabled = false;
    }
  }

  function renderUsage(report) {
    const available = report && report.available === true;
    const totals = report && report.totals ? report.totals : {};
    $("#usage-unavailable").classList.toggle("hidden", available);
    $("#usage-total-spend").textContent = available ? formatMoney(totals.spend) : "—";
    $("#usage-total-tokens").textContent = available ? formatCount(totals.totalTokens) : "—";
    $("#usage-total-requests").textContent = available ? formatCount(totals.requests) : "—";
    $("#usage-latest").textContent = available ? formatDateTime(totals.latestRequestAt) : "—";
    $("#usage-updated").textContent = I18N.t("usage.updated", { time: formatDateTime(new Date()) });
    renderUsageChart(report);
    renderUsageQuotas(report && report.quotas);
    renderUsageBreakdown(report && report.breakdown, available);
  }

  function chartTimeLabel(value, range) {
    const date = new Date(value);
    const options = range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit" };
    return new Intl.DateTimeFormat(I18N.current, options).format(date);
  }

  function renderUsageChart(report) {
    const host = $("#usage-chart");
    const series = report && report.available === true && Array.isArray(report.series) ? report.series : [];
    if (!series.length) {
      host.innerHTML = `<div class="empty">${escapeHtml(report && report.available === false
        ? I18N.t("usage.unavailable")
        : I18N.t("usage.empty.no_activity"))}</div>`;
      return;
    }
    const width = 960;
    const height = 280;
    const margin = { top: 18, right: 18, bottom: 34, left: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const spends = series.map((row) => Math.max(0, Number(row.spend) || 0));
    const tokens = series.map((row) => Math.max(0, Number(row.totalTokens) || 0));
    const maxSpend = Math.max(...spends, 0);
    const maxTokens = Math.max(...tokens, 0);
    const x = (index) => margin.left + (series.length === 1 ? plotWidth / 2 : index * plotWidth / (series.length - 1));
    const spendY = (value) => margin.top + plotHeight - (maxSpend > 0 ? value / maxSpend * plotHeight * .88 : 0);
    const tokenY = (value) => margin.top + plotHeight - (maxTokens > 0 ? value / maxTokens * plotHeight * .72 : 0);
    const grid = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const y = margin.top + ratio * plotHeight;
      const label = formatMoney(maxSpend * (1 - ratio));
      return `<line class="usage-chart__grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"/>` +
        `<text class="usage-chart__axis" x="${margin.left - 8}" y="${y + 3}" text-anchor="end">${escapeHtml(label)}</text>`;
    }).join("");
    const barStep = plotWidth / Math.max(series.length, 1);
    const barWidth = Math.max(3, Math.min(18, barStep * .48));
    const bars = series.map((row, index) => {
      const top = tokenY(tokens[index]);
      const bottom = margin.top + plotHeight;
      const title = `${chartTimeLabel(row.at, report.range)} · ${formatCount(tokens[index])} ${I18N.t("usage.chart.tokens").toLowerCase()}`;
      return `<rect class="usage-chart__bar" x="${x(index) - barWidth / 2}" y="${top}" width="${barWidth}" height="${Math.max(0, bottom - top)}"><title>${escapeHtml(title)}</title></rect>`;
    }).join("");
    const points = series.map((row, index) => `${x(index)},${spendY(spends[index])}`).join(" ");
    const area = `${margin.left},${margin.top + plotHeight} ${points} ${width - margin.right},${margin.top + plotHeight}`;
    const markers = series.map((row, index) => {
      if (!spends[index]) return "";
      const title = `${chartTimeLabel(row.at, report.range)} · ${formatMoney(spends[index])} · ${formatCount(row.requests)} ${I18N.t("usage.kpi.requests").toLowerCase()}`;
      return `<circle class="usage-chart__point" cx="${x(index)}" cy="${spendY(spends[index])}" r="3"><title>${escapeHtml(title)}</title></circle>`;
    }).join("");
    const labelStep = report.range === "24h" ? 4 : report.range === "7d" ? 1 : 5;
    const labels = series.map((row, index) => {
      if (index % labelStep !== 0 && index !== series.length - 1) return "";
      return `<text class="usage-chart__axis" x="${x(index)}" y="${height - 10}" text-anchor="middle">${escapeHtml(chartTimeLabel(row.at, report.range))}</text>`;
    }).join("");
    const emptyLabel = maxSpend === 0 && maxTokens === 0
      ? `<text class="usage-chart__empty" x="${margin.left + plotWidth / 2}" y="${margin.top + plotHeight / 2}" text-anchor="middle">${escapeHtml(I18N.t("usage.empty.no_activity"))}</text>`
      : "";
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <defs><linearGradient id="usage-spend-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b5c" stop-opacity=".22"/><stop offset="1" stop-color="#ff6b5c" stop-opacity="0"/></linearGradient></defs>
      ${grid}${bars}<polygon class="usage-chart__area" points="${area}"/><polyline class="usage-chart__line" points="${points}"/>${markers}${labels}${emptyLabel}
    </svg>`;
  }

  function renderUsageQuotas(quotas) {
    const host = $("#usage-quotas");
    if (!Array.isArray(quotas) || !quotas.length) {
      host.innerHTML = `<div class="empty empty--inline">${escapeHtml(I18N.t("usage.empty.no_quotas"))}</div>`;
      return;
    }
    host.innerHTML = `<div class="usage-quota-list">${quotas.map((quota) => {
      const meters = Array.isArray(quota.limits) ? quota.limits.map((limit) => {
        const percent = Number(limit.percent);
        const safePercent = Number.isFinite(percent) ? Math.max(0, percent) : null;
        const barPercent = safePercent == null ? 0 : Math.min(100, safePercent);
        const level = safePercent == null ? "" : safePercent >= 95 ? " usage-meter__fill--critical" : safePercent >= 80 ? " usage-meter__fill--warn" : "";
        const value = limit.usedUsd == null
          ? I18N.t("usage.quota.unavailable")
          : I18N.t("usage.quota.value", {
              used: formatMoney(limit.usedUsd),
              max: formatMoney(limit.maxUsd),
              percent: safePercent.toFixed(1),
            });
        return `<div class="usage-meter">
          <div class="usage-meter__head"><span class="usage-meter__label">${escapeHtml(I18N.t(`enroll.policy.window.${limit.window}`))}</span><span class="usage-meter__value">${escapeHtml(value)}</span></div>
          <div class="usage-meter__track"><div class="usage-meter__fill${level}" style="width:${barPercent}%"></div></div>
        </div>`;
      }).join("") : "";
      const rates = [
        quota.rpmLimit ? `<span class="pill pill--muted">${escapeHtml(`${quota.rpmLimit} RPM`)}</span>` : "",
        quota.tpmLimit ? `<span class="pill pill--muted">${escapeHtml(`${formatCount(quota.tpmLimit)} TPM`)}</span>` : "",
      ].join("");
      return `<article class="usage-quota">
        <div class="usage-quota__identity">
          <div class="usage-quota__name">${escapeHtml(quota.principal || quota.deviceName || "—")}</div>
          <div class="usage-quota__meta">${escapeHtml(quota.deviceName || "—")} · ${escapeHtml(quota.model || "—")}</div>
          <div class="usage-quota__meta">${escapeHtml(I18N.t("usage.quota.expires", { date: formatDateTime(quota.expiresAt) }))}</div>
          ${rates ? `<div class="usage-rate-pills">${rates}</div>` : ""}
        </div>
        <div class="usage-quota__meters">${meters || `<span class="small">${escapeHtml(I18N.t("usage.quota.rate_only"))}</span>`}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function renderUsageBreakdown(rows, available) {
    const host = $("#usage-breakdown");
    if (!available) {
      host.innerHTML = `<div class="empty empty--inline">${escapeHtml(I18N.t("usage.unavailable"))}</div>`;
      return;
    }
    if (!Array.isArray(rows) || !rows.length) {
      host.innerHTML = `<div class="empty empty--inline">${escapeHtml(I18N.t("usage.empty.no_activity"))}</div>`;
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>${escapeHtml(I18N.t("usage.col.person"))}</th><th>${escapeHtml(I18N.t("usage.col.device"))}</th><th>${escapeHtml(I18N.t("usage.col.model"))}</th><th class="num">${escapeHtml(I18N.t("usage.col.spend"))}</th><th class="num">${escapeHtml(I18N.t("usage.col.tokens"))}</th><th class="num">${escapeHtml(I18N.t("usage.col.requests"))}</th><th>${escapeHtml(I18N.t("usage.col.last"))}</th></tr></thead>
      <tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.principal || "—")}</td><td>${escapeHtml(row.deviceName || "—")}</td><td><span class="pill pill--muted">${escapeHtml(row.model || "—")}</span></td><td class="num">${escapeHtml(formatMoney(row.spend))}</td><td class="num">${escapeHtml(formatCount(row.totalTokens))}</td><td class="num">${escapeHtml(formatCount(row.requests))}</td><td class="mono">${escapeHtml(formatDateTime(row.lastRequestAt))}</td></tr>`).join("")}</tbody>
    </table></div>`;
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 12.  Enroll codes                                                 ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  let lastEnrollResult = null;
  let managedModelCatalog = null;
  let managedModelCatalogPromise = null;

  function modelOptionLabel(model) {
    const localized = I18N.t(`enroll.model.option.${model.tier}`);
    return localized.startsWith("enroll.model.option.")
      ? model.id
      : localized;
  }

  function modelOptionDetail(model) {
    const localized = I18N.t(`enroll.model.detail.${model.tier}`);
    if (!localized.startsWith("enroll.model.detail.")) return localized;
    return model.contextWindowTokens && model.maxOutputTokens
      ? `${model.id} · ${formatCount(model.contextWindowTokens)} context · ${formatCount(model.maxOutputTokens)} output`
      : model.id;
  }

  function paintManagedModelCatalog() {
    if (!managedModelCatalog) return;
    const select = $("#ec-model");
    const models = Array.isArray(managedModelCatalog.models) ? managedModelCatalog.models : [];
    const previous = select.value;
    select.innerHTML = models.map((model) => {
      const label = modelOptionLabel(model);
      const text = label === model.id ? model.id : `${label} · ${model.id}`;
      return `<option value="${escapeHtml(model.id)}">${escapeHtml(text)}</option>`;
    }).join("");
    const selected = models.some((model) => model.id === previous)
      ? previous
      : managedModelCatalog.defaultModel;
    if (selected && models.some((model) => model.id === selected)) select.value = selected;
    select.disabled = models.length === 0;
    const active = models.find((model) => model.id === select.value);
    $("#ec-model-hint").textContent = active
      ? modelOptionDetail(active)
      : I18N.t("enroll.model.unavailable");
    $("#ec-create").disabled = !active;
  }

  async function loadManagedModelCatalog(force = false) {
    if (force) {
      managedModelCatalog = null;
      managedModelCatalogPromise = null;
    }
    if (managedModelCatalog) {
      paintManagedModelCatalog();
      return managedModelCatalog;
    }
    if (!managedModelCatalogPromise) {
      managedModelCatalogPromise = api("GET", "/admin/model-options")
        .then((catalog) => {
          managedModelCatalog = catalog;
          paintManagedModelCatalog();
          return catalog;
        })
        .catch((error) => {
          const select = $("#ec-model");
          select.innerHTML = `<option value="">${escapeHtml(I18N.t("enroll.model.unavailable"))}</option>`;
          select.disabled = true;
          $("#ec-model-hint").textContent = error.message;
          $("#ec-create").disabled = true;
          throw error;
        })
        .finally(() => { managedModelCatalogPromise = null; });
    }
    return managedModelCatalogPromise;
  }

  router.on("enroll", () => {
    getOrgChoices().catch(() => undefined);
    loadManagedModelCatalog().catch(() => undefined);
  });

  $("#ec-model").addEventListener("change", paintManagedModelCatalog);

  function readOptionalPositiveNumber(id, { integer = false, max }) {
    const raw = $(id).value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(I18N.t("enroll.policy.invalid_number"));
    }
    return value;
  }

  function formatBudgetSummary(limits) {
    if (!Array.isArray(limits) || !limits.length) return I18N.t("enroll.policy.unlimited");
    return limits.map((entry) => {
      const label = I18N.t(`enroll.policy.window.${entry.window}`);
      return `${label} · $${Number(entry.maxUsd ?? 0).toFixed(2)}`;
    }).join(" / ");
  }

  function formatSpend(device) {
    const spend = Number(device?.spend);
    return device?.spend_available === true && Number.isFinite(spend)
      ? `$${spend.toFixed(2)}`
      : I18N.t("fleet.spend.unavailable");
  }

  function formatRateSummary(rpmLimit, tpmLimit) {
    const rates = [];
    if (rpmLimit) rates.push(`${rpmLimit} RPM`);
    if (tpmLimit) rates.push(`${tpmLimit} TPM`);
    return rates.length
      ? I18N.t("fleet.policy.rates", { rates: rates.join(" · ") })
      : I18N.t("fleet.policy.rates_unlimited");
  }

  function formatAccessPolicy(policy) {
    if (!policy) return "—";
    const days = Number(policy.tokenTtlMinutes ?? 0) / (24 * 60);
    const lines = [
      I18N.t("enroll.result.policy.validity", { days: Number.isInteger(days) ? days : days.toFixed(2) }),
      I18N.t("enroll.result.policy.budgets", { budgets: formatBudgetSummary(policy.budgetLimits) }),
    ];
    const rates = [];
    if (policy.rpmLimit) rates.push(`${policy.rpmLimit} RPM`);
    if (policy.tpmLimit) rates.push(`${policy.tpmLimit} TPM`);
    if (rates.length) lines.push(I18N.t("enroll.result.policy.rates", { rates: rates.join(" · ") }));
    return lines.join("\n");
  }

  $("#ec-create").addEventListener("click", async () => {
    const orgId = $("#ec-orgid").value.trim();
    const model = $("#ec-model").value.trim();
    const gateway = $("#ec-gateway").value.trim().replace(/\/$/, "");
    if (!orgId) { toast(I18N.t("err.orgid_required"), "err"); return; }
    if (!model) { toast(I18N.t("err.model_required"), "err"); return; }
    try {
      const tokenDays = readOptionalPositiveNumber("#ec-token-days", { integer: true, max: 365 }) ?? 7;
      const budgetLimits = [
        ["5h", "#ec-budget-5h"],
        ["week", "#ec-budget-week"],
        ["month", "#ec-budget-month"],
      ].flatMap(([window, selector]) => {
        const maxUsd = readOptionalPositiveNumber(selector, { max: 1_000_000 });
        return maxUsd == null ? [] : [{ window, maxUsd }];
      });
      const rpmLimit = readOptionalPositiveNumber("#ec-rpm", { integer: true, max: 1_000_000 });
      const tpmLimit = readOptionalPositiveNumber("#ec-tpm", { integer: true, max: 1_000_000_000 });
      const r = await api("POST", "/admin/enroll-codes", {
        orgId,
        model,
        tokenTtlMinutes: tokenDays * 24 * 60,
        budgetLimits,
        rpmLimit,
        tpmLimit,
      });
      lastEnrollResult = {
        code: r.code,
        model: r.model || model,
        gateway,
        expiresAt: r.expiresAt,
        accessPolicy: r.accessPolicy,
      };
      paintEnrollResult(lastEnrollResult);
      toast(I18N.t("ok.enroll_minted"), "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  function paintEnrollResult({ code, model, gateway, expiresAt, accessPolicy }) {
    $("#ec-code-text").textContent = code;
    $("#ec-cmd-text").textContent = `hara enroll ${gateway} --code ${code}`;
    $("#ec-expires").textContent = formatDateTime(expiresAt);
    $("#ec-result-model").textContent = model || "—";
    $("#ec-policy-result").textContent = formatAccessPolicy(accessPolicy);
    $("#ec-result").classList.remove("hidden");
  }

  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║ 13.  Users (SUPERADMIN only)                                      ║
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
