/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Injects COOP/COEP response headers so the page becomes cross-origin isolated,
// which enables SharedArrayBuffer and lets onnxruntime-web run multithreaded
// WASM. Needed because GitHub Pages cannot set these headers server-side.
//
// Locally patched (task-19, Codexレビュー I1/I2a) vs. upstream v0.1.7: the
// `updatefound` handler below no longer reloads immediately. It now (1) only
// reloads for the very first install of this SW (not for later version
// updates — those take effect on the next navigation instead, so a background
// deploy can't interrupt an in-progress session) and (2) waits for the new
// worker to reach `activated` before reloading (reloading earlier could leave
// the page still uncontrolled/non-isolated after the reload while also
// suppressing re-registration via `coiReloadedBySelf`).
let coepCredentialless = false;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) {
      return;
    } else if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
      return;
    }

    const request =
      coepCredentialless && r.mode === "no-cors" ? new Request(r, { credentials: "omit" }) : r;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
          );
          if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf == "coepdegrade";

    // You can customize the behavior of this script through a global `coi` variable.
    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => true,
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };

    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;

    // Record the failure if the page is served by serviceWorker.
    if (controlling && !window.crossOriginIsolated) {
      window.sessionStorage.setItem("coiCoepHasFailed", "true");
    }
    const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

    if (controlling) {
      // Reload only on the first failure.
      const reloadToDegrade = coi.coepDegrade() && !(coepDegrading || window.crossOriginIsolated);
      n.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value:
          reloadToDegrade || (coepHasFailed && coi.coepDegrade())
            ? false
            : coi.coepCredentialless(),
      });
      if (reloadToDegrade) {
        !coi.quiet && console.log("Reloading page to degrade COEP.");
        window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
        coi.doReload("coepdegrade");
      }
    } else if (coi.shouldRegister()) {
      if (!window.isSecureContext) {
        !coi.quiet &&
          console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      } else {
        n.serviceWorker &&
          n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
              !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

              registration.addEventListener("updatefound", () => {
                const newWorker = registration.installing;
                if (!newWorker) return;

                // `registration.active` still refers to the *previous* worker at the
                // moment `updatefound` fires (it only flips to the new one once that
                // one activates), so its presence here means some SW was already
                // active for this scope before — i.e. this is a version update, not
                // the first-ever install (Codexレビュー I2a). Don't reload for
                // updates: skipWaiting()/clients.claim() on the SW side mean the new
                // worker takes over on its own, and it'll be picked up cleanly on the
                // next navigation instead of interrupting the current session.
                if (registration.active) {
                  !coi.quiet &&
                    console.log(
                      "New COOP/COEP Service Worker installed; it will take effect on next navigation."
                    );
                  return;
                }

                // First-ever install for this scope: wait for the new worker to
                // reach `activated` before reloading (Codexレビュー I1). Reloading
                // any earlier can leave the page uncontrolled/non-isolated even
                // after the reload, while `coiReloadedBySelf` blocks the next
                // registration attempt until a later manual navigation.
                const reloadWhenActivated = () => {
                  if (newWorker.state !== "activated") return;
                  !coi.quiet &&
                    console.log("Reloading page to make use of newly activated COOP/COEP Service Worker.");
                  window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                  coi.doReload();
                };
                newWorker.addEventListener("statechange", reloadWhenActivated);
                reloadWhenActivated(); // already activated by the time we attached (unlikely but cheap to cover)
              });

              // If the registration is active, but it's not controlling the page
              if (registration.active && !n.serviceWorker.controller) {
                !coi.quiet &&
                  console.log("Reloading page to make use of COOP/COEP Service Worker.");
                window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                coi.doReload();
              }
            },
            (err) => {
              !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
          );
      }
    }
  })();
}
