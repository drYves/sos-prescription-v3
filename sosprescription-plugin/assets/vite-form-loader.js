(function () {
  // ---------------------------------------------------------------------------
  // Compat shim
  // ---------------------------------------------------------------------------
  // The Vite bundle (React app) uses a helper `filePurposeLabel(purpose)` to
  // render human-friendly labels for uploaded documents. In some builds the
  // helper may be missing which breaks the entire UI (form, patient portal,...
  // doctor console).
  //
  // We provide a minimal global implementation to guarantee rendering.
  // This helper is intentionally simple and safe: unknown purposes fallback to
  // a generic label.
  try {
    if (typeof window.filePurposeLabel !== 'function') {
      window.filePurposeLabel = function (purpose) {
        try {
          var p = String(purpose || '').toLowerCase();
          if (!p) return 'Document';
          if (p === 'proof') return 'Justificatif';
          if (p === 'rx_pdf') return 'Ordonnance';
          if (p === 'doctor_signature') return 'Signature';
          if (p === 'doctor_stamp') return 'Cachet';
          if (p === 'chat_attachment' || p === 'chat') return 'Pièce jointe';
          // Default: keep short and neutral
          return 'Document';
        } catch (_) {
          return 'Document';
        }
      };
    }
  } catch (_) {
    // no-op
  }


  // ---------------------------------------------------------------------------
  // Unified UI error surface (patient/form)
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    try {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    } catch (_) {
      return '';
    }
  }





  // ---------------------------------------------------------------------------
  // i18n-lite (strings injected by wp_localize_script)
  // ---------------------------------------------------------------------------
  var spI18n = (window.SosPrescription && window.SosPrescription.i18n) ? window.SosPrescription.i18n : {};
  function t(key, fallback) {
    try {
      var v = spI18n && spI18n[key];
      if (typeof v === 'string' && v.length) {
        return v;
      }
    } catch (e) {}
    return fallback;
  }
  // Génère un identifiant court (8 caractères) pour le support (ReqID)
  // Utilisé côté front pour corréler une erreur UI avec les logs serveur.
  function generateReqId8() {
    try {
      var bytes = new Uint8Array(4);
      (window.crypto || crypto).getRandomValues(bytes);
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        var h = bytes[i].toString(16);
        if (h.length < 2) h = '0' + h;
        out += h;
      }
      return out.toUpperCase();
    } catch (_) {
      // Fallback pseudo-aléatoire (best effort)
      var s = Math.random().toString(16).replace('0.', '').toUpperCase();
      return (s + '00000000').slice(0, 8);
    }
  }
  function getErrorSurface() {
    return document.getElementById('sp-error-surface-form')
      || document.getElementById('sp-error-surface-patient')
      || document.getElementById('sp-error-surface');
  }

  function showUnifiedError(title, message, reqId) {
    try {
      var el = getErrorSurface();
      if (!el) return;

      var supportLabel = escapeHtml(t('label_support_id', 'ID de support :'));
      var copyLabel = escapeHtml(t('btn_copy', 'Copier'));
      var copiedLabel = t('btn_copied', 'Copié !');

      var safeTitle = escapeHtml(title || t('error_generic_title', 'Erreur'));
      var safeMessage = escapeHtml(message || t('error_generic_message', 'Une erreur est survenue.'));
      var rawReq = reqId ? String(reqId) : '';
      var safeReq = rawReq ? escapeHtml(rawReq) : '';

      el.style.display = 'block';
      el.innerHTML = ''
        + '<div style="flex:1;">'
        +   '<strong>' + safeTitle + '</strong>'
        +   '<div style="margin-top:4px;">' + safeMessage + '</div>'
        +   (safeReq
              ? '<div style="margin-top:8px;font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                +   '<span>' + supportLabel + '</span>'
                +   '<code class="sp-code">' + safeReq + '</code>'
                +   '<button type="button" class="sp-btn sp-btn-secondary" data-sp-copy-reqid="' + safeReq + '" style="padding:4px 8px;font-size:12px;border-radius:10px;">' + copyLabel + '</button>'
              + '</div>'
              : '')
        + '</div>';

      // Bouton Copier (ReqID)
      if (rawReq) {
        var btn = el.querySelector('[data-sp-copy-reqid]');
        if (btn) {
          btn.addEventListener('click', function () {
            var label = btn.textContent;
            var setFeedback = function (text) {
              btn.textContent = text;
              window.setTimeout(function () { btn.textContent = label; }, 1200);
            };

            try {
              if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(rawReq).then(function () {
                  setFeedback(copiedLabel);
                }).catch(function () {
                  // Fallback
                  var ta = document.createElement('textarea');
                  ta.value = rawReq;
                  ta.setAttribute('readonly', 'readonly');
                  ta.style.position = 'absolute';
                  ta.style.left = '-9999px';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                  setFeedback(copiedLabel);
                });
              } else {
                var ta2 = document.createElement('textarea');
                ta2.value = rawReq;
                ta2.setAttribute('readonly', 'readonly');
                ta2.style.position = 'absolute';
                ta2.style.left = '-9999px';
                document.body.appendChild(ta2);
                ta2.select();
                document.execCommand('copy');
                document.body.removeChild(ta2);
                setFeedback(copiedLabel);
              }
            } catch (_) {
              // Si tout échoue, on laisse le ReqID visible
            }
          });
        }
      }
    } catch (_) {
      // no-op
    }
  }

  function clearUnifiedError() {
    try {
      var el = getErrorSurface();
      if (!el) return;
      el.style.display = 'none';
      el.innerHTML = '';
    } catch (_) {
      // no-op
    }
  }
  function patchFetch(scope) {
    try {
      if (window.__SosPrescriptionFetchPatched) return;
      window.__SosPrescriptionFetchPatched = true;

      var origFetch = window.fetch;
      if (!origFetch) return;

      window.fetch = function (input, init) {
        // Determine if this request targets our REST API.
        var restBase = (window.SosPrescription && window.SosPrescription.rest_base)
          ? String(window.SosPrescription.rest_base)
          : '';
        var restHint = '/wp-json/sosprescription/v1/';

        var url = '';
        try {
          url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
        } catch (_) {
          url = '';
        }

        var isApi = false;
        try {
          if (url) {
            isApi = (restBase && url.indexOf(restBase) === 0) || (url.indexOf(restHint) !== -1);
          }
        } catch (_) {
          isApi = false;
        }

        var localReqId = '';

        if (isApi) {
          init = init || {};
          init.headers = init.headers || {};

          // ReqID: identifiant de support généré côté client (8 chars) pour corrélation UI/logs.
          try {
            var headersObj = (init.headers instanceof Headers) ? init.headers : new Headers(init.headers);
            var existing = headersObj.get('X-SOSPrescription-ReqID') || '';
            localReqId = existing ? String(existing) : generateReqId8();
            headersObj.set('X-SOSPrescription-ReqID', localReqId);
            init.headers = headersObj;
          } catch (e) {
            localReqId = generateReqId8();
            try { init.headers['X-SOSPrescription-ReqID'] = localReqId; } catch(_) {}
          }

          // Avoid stale REST responses caused by aggressive caches (browser / proxy / CDN).
          // We force GET calls to be uncacheable and we add a cache-busting query param.
          // This is especially important for the patient portal (status changes) and for any polling.
          try {
            var method = 'GET';
            try {
              method = (init && init.method) ? String(init.method) : ((input && input.method) ? String(input.method) : 'GET');
            } catch (_) {
              method = 'GET';
            }
            method = String(method || 'GET').toUpperCase();

            if (method === 'GET' && url) {
              try {
                var u = new URL(url, window.location && window.location.origin ? window.location.origin : undefined);
                u.searchParams.set('_ts', String(Date.now()));
                var newUrl = u.toString();
                // Update the fetch input without breaking Request objects.
                if (typeof input === 'string') {
                  input = newUrl;
                } else if (input && input.url) {
                  input = new Request(newUrl, input);
                }
                url = newUrl;
              } catch (_) {
                // ignore
              }
              // Browser cache bypass (best-effort)
              try { init.cache = 'no-store'; } catch (_) {}
              // Some proxies respect these headers on requests.
              try {
                if (init.headers instanceof Headers) {
                  init.headers.set('Cache-Control', 'no-cache');
                  init.headers.set('Pragma', 'no-cache');
                } else if (Array.isArray(init.headers)) {
                  init.headers.push(['Cache-Control', 'no-cache']);
                  init.headers.push(['Pragma', 'no-cache']);
                } else {
                  init.headers['Cache-Control'] = 'no-cache';
                  init.headers['Pragma'] = 'no-cache';
                }
              } catch (_) {
                // ignore
              }
            }
          } catch (_) {
            // ignore
          }

          if (init.headers instanceof Headers) {
            init.headers.set('X-Sos-Scope', scope);
          } else if (Array.isArray(init.headers)) {
            init.headers.push(['X-Sos-Scope', scope]);
          } else {
            init.headers['X-Sos-Scope'] = scope;
          }
        }

        return origFetch(input, init)
          .then(function (resp) {
            try {
              if (!isApi || !resp) return resp;

              if (resp.ok) {
                clearUnifiedError();
                return resp;
              }

              var reqId = '';
              try {
                reqId = resp.headers.get('X-SOSPrescription-Request-ID') || localReqId || '';
              } catch (_) {
                reqId = '';
              }

              // Try to enrich the error banner with JSON body data, without consuming the response.
              try {
                resp.clone().json().then(function (data) {
                  try {
                    var msg = '';
                    if (data && typeof data === 'object') {
                      if (data.message) msg = String(data.message);
                      else if (data.data && data.data.message) msg = String(data.data.message);
                      if (data._request_id) reqId = String(data._request_id);
                    }
                    if (!msg) msg = t('error_api_title', 'Erreur API') + ' (' + (resp.status || '??') + ')';
                    showUnifiedError(t('error_api_title', 'Erreur API'), msg, reqId);
                  } catch (_) {
                    showUnifiedError(t('error_api_title', 'Erreur API'), t('error_api_title', 'Erreur API') + ' (' + (resp.status || '??') + ')', reqId);
                  }
                }).catch(function () {
                  showUnifiedError(t('error_api_title', 'Erreur API'), t('error_api_title', 'Erreur API') + ' (' + (resp.status || '??') + ')', reqId);
                });
              } catch (_) {
                showUnifiedError(t('error_api_title', 'Erreur API'), t('error_api_title', 'Erreur API') + ' (' + (resp.status || '??') + ')', reqId);
              }
            } catch (_) {
              // no-op
            }

            return resp;
          })
          .catch(function (err) {
            try {
              if (isApi) {
                showUnifiedError(t('error_network_title', 'Erreur réseau'), t('error_network_message', 'Connexion impossible. Merci de réessayer.'), localReqId || '');
              }
            } catch (_) {
              // no-op
            }
            throw err;
          });
      };
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
        shortcode: 'sosprescription_form',
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
      showUnifiedError(t('error_loading_title', 'Erreur de chargement'), message, '');

      var el = document.getElementById(rootId);
      if (!el) return;

      el.innerHTML = ''
        + '<div class="sp-ui" style="max-width:900px;margin:12px auto;">'
        +   '<div class="sp-card">'
        +     '<div class="sp-card-title">' + escapeHtml(t('error_loading_title', 'Erreur de chargement')) + '</div>'
        +     '<div class="sp-muted" style="margin-top:6px;">' + escapeHtml(message) + '</div>'
        +     '<div class="sp-muted-2" style="margin-top:10px;font-size:12px;">' + escapeHtml(t('error_loading_console_hint', 'Ouvrez la console du navigateur (F12) pour voir le détail.')) + '</div>'
        +   '</div>'
        + '</div>';
    } catch (_) {
      // no-op
    }
  }

  function installGlobalErrorHandlers() {
    try {
      if (window.__SosPrescriptionGlobalErrorsInstalled) return;
      window.__SosPrescriptionGlobalErrorsInstalled = true;

      window.addEventListener('error', function (e) {
        try {
          // On ne loggue que les erreurs provenant du plugin (évite le bruit).
          var filename = String((e && e.filename) ? e.filename : '');
          if (filename && filename.indexOf('/wp-content/plugins/sosprescription/') === -1) return;

          sendLog('window_error', 'error', {
            message: String((e && e.message) ? e.message : 'error'),
            filename: filename,
            lineno: (e && e.lineno) ? Number(e.lineno) : 0,
            colno: (e && e.colno) ? Number(e.colno) : 0,
            stack: (e && e.error && e.error.stack) ? String(e.error.stack).slice(0, 1200) : ''
          });
        } catch (_) {
          // no-op
        }
      });

      window.addEventListener('unhandledrejection', function (e) {
        try {
          var reason = (e && e.reason) ? e.reason : null;
          var msg = '';
          var stack = '';
          if (reason && typeof reason === 'object') {
            msg = String(reason.message || 'unhandledrejection');
            stack = reason.stack ? String(reason.stack) : '';
          } else {
            msg = String(reason || 'unhandledrejection');
          }

          // Filtrage léger : on ne loggue que si le message/stack mentionne le plugin.
          var hay = (msg + ' ' + stack);
          if (hay.indexOf('sosprescription') === -1 && hay.indexOf('SosPrescription') === -1 && hay.indexOf('/wp-content/plugins/sosprescription/') === -1) {
            return;
          }

          sendLog('window_unhandledrejection', 'error', {
            message: msg,
            stack: stack.slice(0, 1200)
          });
        } catch (_) {
          // no-op
        }
      });
    } catch (_) {
      // no-op
    }
  }

  function boot() {
    var bootCfg = (window.SosPrescriptionViteForm || {});
    var rootId = bootCfg.rootId || 'sosprescription-root-form';
    var moduleUrl = bootCfg.moduleUrl || '';

    patchFetch('sosprescription_form');

    // OCR: si le scan local (Tesseract.js) échoue, nous affichons un ID de support côté patient.
    try {
      if (!window.__sosprescription_ocr_support_hook) {
        window.__sosprescription_ocr_support_hook = 1;
        window.addEventListener('sosprescription:ocr_error', function (ev) {
          try {
            var d = (ev && ev.detail) ? ev.detail : {};
            var reqId = d.reqId ? String(d.reqId) : '';
            var msg = d.message ? String(d.message) : t('ocr_unavailable', 'OCR local indisponible. Merci de réessayer.');
            showUnifiedError(t('error_ocr_title', 'Erreur OCR'), msg, reqId);
          } catch (_) { }
        });
      }
    } catch (_) { }

    installGlobalErrorHandlers();

    sendLog('loader_boot', 'info', {
      page: String(window.location && window.location.href ? window.location.href : ''),
      rootId: rootId,
      moduleUrl: moduleUrl
    });

    if (!moduleUrl) {
      sendLog('loader_missing_module_url', 'error', { rootId: rootId });
      renderError(rootId, t('error_bundle_missing', 'URL du module Vite manquante (moduleUrl).'));
      return;
    }

    try {
      import(moduleUrl).then(function () {
        sendLog('import_ok', 'info', { moduleUrl: moduleUrl });
      }).catch(function (err) {
        console.error('[SosPrescription] form import() failed', err);
        sendLog('import_fail', 'error', {
          moduleUrl: moduleUrl,
          message: (err && err.message) ? String(err.message) : 'import() failed'
        });
        renderError(rootId, t('error_bundle_load_failed', 'Impossible de charger le bundle front (import() a échoué).'));
      });
    } catch (err) {
      console.error('[SosPrescription] form loader failed', err);
      sendLog('loader_error', 'error', {
        message: (err && err.message) ? String(err.message) : 'loader threw'
      });
      renderError(rootId, t('error_js_boot', 'Erreur JavaScript lors du démarrage.'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
