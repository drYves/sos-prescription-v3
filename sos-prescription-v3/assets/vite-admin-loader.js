(function () {
  function patchFetch(scope) {
    try {
      if (!scope) return;
      if (!window.fetch) return;

      // Si déjà patché ailleurs, on met juste à jour le scope courant.
      if (window.__SosPrescriptionFetchPatched) {
        window.__SosPrescriptionScope = scope;
        return;
      }

      var cfg = (window.SosPrescription || {});
      var restBase = String(cfg.restBase || '').replace(/\/$/, '');
      if (!restBase) return;

      var orig = window.fetch;
      window.__SosPrescriptionScope = scope;

      function withScopeHeaders(headers) {
        var h;
        try {
          // eslint-disable-next-line no-undef
          if (typeof Headers !== 'undefined') {
            h = new Headers(headers || {});
          }
        } catch (_) {
          h = null;
        }
        if (!h) {
          h = headers || {};
          var sc = window.__SosPrescriptionScope || scope;
          if (!h['X-Sos-Scope']) h['X-Sos-Scope'] = sc;
          return h;
        }
        var sc2 = window.__SosPrescriptionScope || scope;
        if (!h.has('X-Sos-Scope')) h.set('X-Sos-Scope', sc2);
        return h;
      }

      window.fetch = function (input, init) {
        try {
          var url = '';
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;

          if (url && String(url).indexOf(restBase) === 0) {
            init = init || {};
            init.headers = withScopeHeaders(init.headers);
          }
        } catch (_) {
          // no-op
        }
        return orig(input, init);
      };

      window.__SosPrescriptionFetchPatched = true;
    } catch (_) {
      // no-op
    }
  }

  function sendLog(event, level, meta) {
    try {
      var cfg = (window.SosPrescription || {});
      var restBase = cfg.restBase || '';
      var nonce = cfg.nonce || '';
      if (!restBase || !nonce) return;
      if (!window.fetch) return;

      var url = String(restBase).replace(/\/$/, '') + '/logs/frontend';
      var payload = {
        shortcode: 'sosprescription_admin',
        event: event,
        level: level || 'info',
        meta: meta || {}
      };

      window.fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-WP-Nonce': nonce
        },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () { /* no-op */ });
    } catch (_) {
      // no-op
    }
  }

  function renderError(rootId, message) {
    try {
      var el = document.getElementById(rootId);
      if (!el) return;
      el.innerHTML = '' +
        '<div style="max-width:900px;margin:12px auto;padding:14px;border:1px solid #f3c4c4;background:#fff5f5;border-radius:10px;">' +
          '<div style="font-weight:600;margin-bottom:6px;">SosPrescription — erreur de chargement</div>' +
          '<div style="font-size:13px;color:#7a1a1a;">' + message + '</div>' +
          '<div style="margin-top:8px;font-size:12px;color:#7a1a1a;">Ouvrez la console du navigateur (F12) pour voir le détail.</div>' +
        '</div>';
    } catch (_) {
      // no-op
    }
  }

  function boot() {
    var bootCfg = (window.SosPrescriptionViteAdmin || {});
    var rootId = bootCfg.rootId || 'sosprescription-root-admin';
    var moduleUrl = bootCfg.moduleUrl || '';

    patchFetch('sosprescription_admin');

    sendLog('loader_boot', 'info', {
      page: String(window.location && window.location.href ? window.location.href : ''),
      rootId: rootId,
      moduleUrl: moduleUrl
    });

    if (!moduleUrl) {
      sendLog('loader_missing_module_url', 'error', { rootId: rootId });
      renderError(rootId, 'URL du module Vite manquante (moduleUrl).');
      return;
    }

    try {
      import(moduleUrl).then(function () {
        sendLog('import_ok', 'info', { moduleUrl: moduleUrl });
      }).catch(function (err) {
        console.error('[SosPrescription] admin import() failed', err);
        sendLog('import_fail', 'error', {
          moduleUrl: moduleUrl,
          message: (err && err.message) ? String(err.message) : 'import() failed'
        });
        renderError(rootId, 'Impossible de charger le bundle admin (import() a échoué).');
      });
    } catch (err) {
      console.error('[SosPrescription] admin loader failed', err);
      sendLog('loader_error', 'error', {
        message: (err && err.message) ? String(err.message) : 'loader threw'
      });
      renderError(rootId, 'Erreur JavaScript lors du démarrage.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
