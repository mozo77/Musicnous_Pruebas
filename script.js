/*
 * MusicNous Official — comportamiento de la web.
 *  1) Menú móvil.
 *  2) Cuenta regresiva hacia el lanzamiento (hora de Colombia).
 *  3) Estado del botón de descarga del APK.
 *
 * El estado de la descarga NO se decide aquí: lo escribe el comando «lanzamiento-oficial»
 * (carpeta tools/) en release.json, solo después de publicar y verificar el APK.
 * Este archivo es público: nunca debe contener tokens ni contraseñas.
 */
(function () {
  "use strict";

  const CONFIG = {
    repo: "mozo77/Musicnous_Pruebas",
    // 31/10/2026 00:00 en Colombia (UTC-5, sin horario de verano) = 05:00 UTC.
    launchAt: "2026-10-31T00:00:00-05:00",
    releaseFile: "release.json",
    apiTimeoutMs: 6000,
    preflightTimeoutMs: 8000,
    pollMs: 60000,
  };

  const STORE_KEY = "musicnous:descarga-asegurada";
  const BRAND = '<span class="nt" translate="no">MusicNous</span>';
  const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
  const SHA_RE = /^[0-9a-f]{64}$/;

  // ---------- Lógica pura (se puede probar sin navegador) ----------

  function splitRemaining(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return { done: true, days: 0, hours: 0, minutes: 0, seconds: 0 };
    const total = Math.ceil(ms / 1000);
    return {
      done: false,
      days: Math.floor(total / 86400),
      hours: Math.floor((total % 86400) / 3600),
      minutes: Math.floor((total % 3600) / 60),
      seconds: total % 60,
    };
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function formatSize(bytes) {
    return (bytes / 1048576).toLocaleString("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " MB";
  }

  // Valida release.json. Solo devuelve "available" si TODOS los datos son coherentes
  // y la URL apunta a un APK de las publicaciones de este repositorio.
  function evaluateRelease(data, repo) {
    if (!data || typeof data !== "object") return { state: "unavailable" };
    if (data.status !== "available") return { state: "coming-soon" };
    try {
      const url = new URL(String(data.apk_url));
      const m = url.pathname.match(/^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+\.apk)$/);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash || url.username || url.password || !m) return { state: "unavailable" };
      const tag = decodeURIComponent(m[2]);
      const apkName = decodeURIComponent(m[3]);
      if (m[1].toLowerCase() !== String(repo).toLowerCase()) return { state: "unavailable" };
      if (tag !== data.tag || apkName !== data.apk_name) return { state: "unavailable" };
      if (typeof data.version !== "string" || !VERSION_RE.test(data.version)) return { state: "unavailable" };
      if (!Number.isSafeInteger(data.size_bytes) || data.size_bytes <= 0) return { state: "unavailable" };
      if (typeof data.sha256 !== "string" || !SHA_RE.test(data.sha256)) return { state: "unavailable" };
      return {
        state: "available",
        version: data.version,
        sizeBytes: data.size_bytes,
        sha256: data.sha256,
        url: url.href,
        tag: tag,
        apkName: apkName,
        releaseUrl: "https://github.com/" + repo + "/releases/tag/" + encodeURIComponent(tag),
      };
    } catch (e) {
      return { state: "unavailable" };
    }
  }

  // Comprueba en la API pública de GitHub que el archivo existe de verdad en una
  // publicación visible. "unknown" (sin red, límite de la API) se resuelve confiando
  // en release.json, que el script de publicación ya verificó.
  async function verifyWithGitHub(info, repo) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, CONFIG.apiTimeoutMs) : null;
    try {
      const res = await fetch("https://api.github.com/repos/" + repo + "/releases/tags/" + encodeURIComponent(info.tag), {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: controller ? controller.signal : undefined,
      });
      if (res.status === 404) return "missing";
      if (!res.ok) return "unknown";
      const rel = await res.json();
      if (rel.draft || rel.prerelease) return "missing";
      const asset = (rel.assets || []).find(function (a) { return a.name === info.apkName; });
      if (!asset || asset.state !== "uploaded" || asset.size !== info.sizeBytes) return "missing";
      return "ok";
    } catch (e) {
      return "unknown";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function preflight(url) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, CONFIG.preflightTimeoutMs) : null;
    try {
      await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: controller ? controller.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Solicitud de descarga asegurada: se guarda SOLO en este navegador (no se envía a ningún servidor).
  function readSecured() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : null;
    } catch (e) { return null; }
  }
  function writeSecured(value) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); return readSecured() !== null; } catch (e) { return false; }
  }
  function clearSecured() { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* sin almacenamiento */ } }

  // ---------- Interfaz ----------

  function init() {
    const $ = function (id) { return document.getElementById(id); };
    const el = {
      eyebrow: $("download-eyebrow"), countdown: $("countdown"), note: $("countdown-note"),
      days: $("cd-days"), hours: $("cd-hours"), minutes: $("cd-minutes"), seconds: $("cd-seconds"),
      launch: $("launch-message"), launchTitle: $("launch-title"), launchText: $("launch-text"),
      button: $("download-button"), label: $("download-button-label"), status: $("download-status"),
      info: $("download-info"), integrity: $("download-integrity"), sha: $("download-sha"), alt: $("download-alt"),
      secureBox: $("secure-box"), secureButton: $("secure-button"), secureText: $("secure-text"), secureCancel: $("secure-cancel"),
    };
    const launchTime = Date.parse(CONFIG.launchAt);
    const state = { release: { state: "coming-soon" }, launched: false, timer: null, poll: null, busy: false, secured: readSecured(), autoTried: false, secureError: false };

    function setStatus(html) { if (el.status) el.status.innerHTML = html; }

    function renderSecure(available, rel) {
      if (!el.secureBox) return;
      el.secureBox.hidden = available;      // con la descarga disponible ya no hace falta asegurarla
      if (available) return;
      const secured = !!state.secured;
      el.secureButton.textContent = secured ? "✓ Descarga asegurada" : "Asegurar tu descarga";
      el.secureButton.setAttribute("aria-pressed", String(secured));
      if (el.secureCancel) el.secureCancel.hidden = !secured;
      if (state.secureError) {
        el.secureText.textContent = "Tu navegador no permite guardar esto (modo privado o datos bloqueados). Añade el recordatorio al calendario o vuelve a esta página el día del lanzamiento.";
      } else if (secured) {
        el.secureText.textContent = "Listo. Guardamos tu lugar en este dispositivo: cuando la descarga esté disponible, empezará al abrir esta página en este mismo navegador. Si borras los datos del navegador, tendrás que asegurarla de nuevo. Android te pedirá confirmar la instalación.";
      } else {
        el.secureText.textContent = "Guarda tu lugar en este dispositivo. Cuando la versión oficial esté publicada y verificada, la descarga empezará al abrir esta página. Android te pedirá confirmar la instalación.";
      }
    }

    function render() {
      if (!el.button) return;
      const rel = state.release;
      const available = rel.state === "available";
      const launched = state.launched;

      if (el.eyebrow) el.eyebrow.textContent = available ? "YA DISPONIBLE" : launched ? "LANZAMIENTO OFICIAL" : "PRÓXIMAMENTE";
      if (el.countdown) el.countdown.hidden = available || !Number.isFinite(launchTime);
      if (el.note) el.note.hidden = available || launched;

      if (el.launch) {
        el.launch.hidden = !(available || launched);
        if (available) {
          el.launchTitle.innerHTML = "¡" + BRAND + " ya está disponible!";
          el.launchText.textContent = "Descarga la versión oficial para Android.";
        } else if (launched) {
          el.launchTitle.textContent = "¡Hoy es el gran día!";
          el.launchText.innerHTML = "Gracias por acompañarnos en el lanzamiento oficial de " + BRAND + ".";
        }
      }

      renderSecure(available, rel);

      if (available) {
        el.button.href = rel.url;
        el.button.removeAttribute("aria-disabled");
        el.label.innerHTML = "Descargar " + BRAND;
        setStatus("Archivo APK oficial publicado en GitHub. Android puede pedirte permiso para instalar aplicaciones de esta fuente.");
        if (el.info) { el.info.hidden = false; el.info.textContent = "Versión " + rel.version + " · " + formatSize(rel.sizeBytes) + " · Android"; }
        if (el.integrity) { el.integrity.hidden = false; el.sha.textContent = rel.sha256; }
      } else {
        el.button.href = "#descarga";
        el.button.setAttribute("aria-disabled", "true");
        el.label.textContent = rel.state === "unavailable" ? "No disponible por ahora" : "Próximamente";
        if (el.info) el.info.hidden = true;
        if (el.integrity) el.integrity.hidden = true;
        if (el.alt) el.alt.hidden = true;
        if (rel.state === "unavailable") {
          setStatus('La descarga no está disponible en este momento. Inténtalo de nuevo en unos minutos o escribe a <a href="#soporte">soporte</a>.');
        } else if (launched) {
          setStatus("Estamos terminando de publicar la descarga. Esta página se actualizará sola cuando esté lista.");
        } else {
          setStatus("La descarga se activará cuando la versión oficial esté publicada y verificada.");
        }
      }
    }

    async function loadRelease() {
      try {
        const res = await fetch(CONFIG.releaseFile + "?t=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        let info = evaluateRelease(await res.json(), CONFIG.repo);
        if (info.state === "available" && (await verifyWithGitHub(info, CONFIG.repo)) === "missing") info = { state: "unavailable" };
        state.release = info;
        render();
        await maybeAutoStart();
        return;
      } catch (e) {
        // Sin release.json legible nunca se ofrece una descarga.
        if (state.release.state !== "available") state.release = { state: "coming-soon" };
      }
      render();
    }

    function startPolling() {
      if (state.poll) return;
      state.poll = setInterval(function () {
        if (state.release.state === "available") { clearInterval(state.poll); state.poll = null; return; }
        loadRelease();
      }, CONFIG.pollMs);
    }

    function paint(parts) {
      if (!el.days) return;
      el.days.textContent = pad(parts.days);
      el.hours.textContent = pad(parts.hours);
      el.minutes.textContent = pad(parts.minutes);
      el.seconds.textContent = pad(parts.seconds);
    }

    function tick() {
      const ms = launchTime - Date.now();
      const parts = splitRemaining(ms);
      paint(parts);
      if (parts.done) {
        // El contador se detiene y no vuelve a programarse: nunca muestra tiempos negativos.
        state.launched = true;
        state.timer = null;
        render();
        loadRelease();
        startPolling();
        return;
      }
      state.timer = setTimeout(tick, (ms % 1000) + 5);
    }

    // Inicia la descarga del APK verificado. auto=true cuando la dispara una descarga asegurada.
    async function startDownload(auto) {
      const rel = state.release;
      if (rel.state !== "available" || state.busy) return false;
      state.busy = true;
      setStatus(auto ? "Tu descarga asegurada está lista. Preparando…" : "Preparando la descarga…");
      try {
        await preflight(rel.url);
      } catch (e) {
        setStatus("No se pudo iniciar la descarga. Comprueba tu conexión e inténtalo de nuevo.");
        if (el.alt) { el.alt.href = rel.releaseUrl; el.alt.hidden = false; }
        state.busy = false;
        return false;
      }
      setStatus(auto
        ? "Tu descarga asegurada empezó automáticamente. Si no ves la descarga, toca «Descargar " + BRAND + "»."
        : "Descarga iniciada. Si no empieza, abre la página de esta versión y descarga el APK desde allí.");
      if (el.alt) { el.alt.href = rel.releaseUrl; el.alt.hidden = false; }
      window.location.assign(rel.url);
      state.busy = false;
      return true;
    }

    // Descarga asegurada + APK publicado y verificado: un único intento automático por versión.
    async function maybeAutoStart() {
      const rel = state.release;
      if (rel.state !== "available" || !state.secured || state.autoTried) return;
      if (state.secured.done === rel.version) return;
      state.autoTried = true;
      if (await startDownload(true)) {
        state.secured = { savedAt: state.secured.savedAt, done: rel.version };
        writeSecured(state.secured);
      }
    }

    if (el.button) {
      el.button.addEventListener("click", function (event) {
        event.preventDefault();
        startDownload(false);
      });
    }

    if (el.secureButton) {
      el.secureButton.addEventListener("click", function () {
        if (state.secured) return;
        const value = { savedAt: new Date().toISOString(), done: null };
        if (writeSecured(value)) { state.secured = value; state.secureError = false; }
        else { state.secured = null; state.secureError = true; }
        render();
      });
    }
    if (el.secureCancel) {
      el.secureCancel.addEventListener("click", function () {
        clearSecured(); state.secured = null; state.secureError = false; render();
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (!state.launched && Number.isFinite(launchTime)) { clearTimeout(state.timer); tick(); }
      loadRelease();
    });

    // Copiar el correo de soporte (útil en computadoras sin cliente de correo).
    const copyButton = $("copy-email");
    const feedback = $("support-feedback");
    if (copyButton) {
      copyButton.addEventListener("click", async function () {
        const email = copyButton.getAttribute("data-email");
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(email); ok = true; }
        } catch (e) { ok = false; }
        if (!ok) {
          try {
            const area = document.createElement("textarea");
            area.value = email; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
            document.body.appendChild(area); area.select(); ok = document.execCommand("copy"); document.body.removeChild(area);
          } catch (e) { ok = false; }
        }
        if (feedback) feedback.textContent = ok ? "Correo copiado." : "No se pudo copiar. Selecciónalo y cópialo manualmente.";
      });
    }

    // Menú móvil
    const menuToggle = document.querySelector(".menu-toggle");
    const mainNav = $("main-nav");
    if (menuToggle && mainNav) {
      menuToggle.addEventListener("click", function () {
        const isOpen = mainNav.classList.toggle("open");
        menuToggle.setAttribute("aria-expanded", String(isOpen));
        menuToggle.setAttribute("aria-label", isOpen ? "Cerrar menú" : "Abrir menú");
      });
      mainNav.querySelectorAll("a").forEach(function (link) {
        link.addEventListener("click", function () {
          mainNav.classList.remove("open");
          menuToggle.setAttribute("aria-expanded", "false");
          menuToggle.setAttribute("aria-label", "Abrir menú");
        });
      });
    }

    const year = $("year");
    if (year) year.textContent = String(new Date().getFullYear());

    render();
    loadRelease();
    if (Number.isFinite(launchTime)) tick();
  }

  const api = { splitRemaining, evaluateRelease, formatSize, verifyWithGitHub, init, CONFIG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") init();
})();
