(function () {
  function patchFetch(scope) {
    try {
      if (!scope) return;
      if (!window.fetch) return;

      if (window.__SosPrescriptionFetchPatched) {
        window.__SosPrescriptionScope = scope;
        return;
      }

      var cfg = window.SosPrescription || {};
      var restBase = String(cfg.restBase || '').replace(/\/$/, '');
      if (!restBase) return;

      var originalFetch = window.fetch;
      window.__SosPrescriptionScope = scope;

      function withScopeHeaders(headers) {
        var result = null;
        try {
          if (typeof Headers !== 'undefined') {
            result = new Headers(headers || {});
          }
        } catch (_) {
          result = null;
        }

        var resolvedScope = window.__SosPrescriptionScope || scope;
        if (!result) {
          result = headers || {};
          if (!result['X-Sos-Scope']) {
            result['X-Sos-Scope'] = resolvedScope;
          }
          return result;
        }

        if (!result.has('X-Sos-Scope')) {
          result.set('X-Sos-Scope', resolvedScope);
        }
        return result;
      }

      window.fetch = function (input, init) {
        try {
          var url = '';
          if (typeof input === 'string') {
            url = input;
          } else if (input && typeof input.url === 'string') {
            url = input.url;
          }

          if (url && String(url).indexOf(restBase) === 0) {
            init = init || {};
            init.headers = withScopeHeaders(init.headers);
          }
        } catch (_) {
          // no-op
        }

        return originalFetch(input, init);
      };

      window.__SosPrescriptionFetchPatched = true;
    } catch (_) {
      // no-op
    }
  }

  function sendLog(event, level, meta) {
    try {
      var cfg = window.SosPrescription || {};
      var restBase = cfg.restBase || '';
      var nonce = cfg.nonce || '';
      if (!restBase || !nonce || !window.fetch) {
        return;
      }

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
      }).catch(function () {
        // no-op
      });
    } catch (_) {
      // no-op
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderRootError(rootId, message) {
    try {
      var root = document.getElementById(rootId);
      if (!root) {
        return;
      }

      root.innerHTML = ''
        + '<div class="sp-card">'
        + '  <div class="sp-alert sp-alert--error">'
        + '    <p class="sp-alert__title">SosPrescription — erreur de chargement</p>'
        + '    <div class="sp-alert__body">' + escapeHtml(message) + '</div>'
        + '  </div>'
        + '</div>';
    } catch (_) {
      // no-op
    }
  }

  function renderHostError(containerEl, message) {
    try {
      if (!(containerEl instanceof HTMLElement)) {
        return;
      }

      containerEl.innerHTML = ''
        + '<div class="dc-message-empty">'
        + '  <div class="sp-alert sp-alert--error">'
        + '    <p class="sp-alert__title">Messagerie indisponible</p>'
        + '    <div class="sp-alert__body">' + escapeHtml(message) + '</div>'
        + '  </div>'
        + '</div>';
    } catch (_) {
      // no-op
    }
  }

  function getBootConfig() {
    var bootCfg = window.SOSPrescriptionViteAdmin || window.SosPrescriptionViteAdmin || {};
    return {
      moduleUrl: String(bootCfg.moduleUrl || ''),
      viteClientUrl: String(bootCfg.viteClientUrl || ''),
      rootId: String(bootCfg.rootId || 'sosprescription-root-admin')
    };
  }

  function importViteClientIfNeeded(viteClientUrl) {
    if (!viteClientUrl) {
      return Promise.resolve();
    }

    if (window.__SosPrescriptionViteClientPromise) {
      return window.__SosPrescriptionViteClientPromise;
    }

    window.__SosPrescriptionViteClientPromise = import(viteClientUrl)
      .then(function () {
        return undefined;
      })
      .catch(function (error) {
        window.__SosPrescriptionViteClientPromise = null;
        throw error;
      });

    return window.__SosPrescriptionViteClientPromise;
  }

  function isDoctorMessagingApi(value) {
    return !!value
      && typeof value.mount === 'function'
      && typeof value.unmount === 'function'
      && typeof value.ensureReady !== 'function';
  }

  function isDoctorMessagingBridge(value) {
    return !!value
      && typeof value.ensureReady === 'function'
      && typeof value.mount === 'function'
      && typeof value.unmount === 'function';
  }

  function isLoaderBridge(value) {
    return !!value && value.__spLoaderBridge === true;
  }

  function getImmediateMessagingApi() {
    var api = window.SosDoctorMessaging;
    if (isDoctorMessagingApi(api)) {
      return api;
    }

    return null;
  }

  function getImportedMessagingBridge() {
    var bridge = window.SosDoctorMessagingBridge;
    if (isDoctorMessagingBridge(bridge) && !isLoaderBridge(bridge)) {
      return bridge;
    }

    return null;
  }

  function pickModuleApi(moduleNs) {
    if (!moduleNs || (typeof moduleNs !== 'object' && typeof moduleNs !== 'function')) {
      return null;
    }

    var defaultExport = moduleNs && moduleNs.default ? moduleNs.default : null;
    var candidates = [];

    if (moduleNs) {
      candidates.push(moduleNs.api);
      candidates.push(moduleNs.messagingApi);
      if (typeof moduleNs.mount === 'function' && typeof moduleNs.unmount === 'function') {
        candidates.push(moduleNs);
      }
    }

    if (defaultExport && (typeof defaultExport === 'object' || typeof defaultExport === 'function')) {
      candidates.push(defaultExport.api);
      candidates.push(defaultExport.messagingApi);
      if (typeof defaultExport.mount === 'function' && typeof defaultExport.unmount === 'function') {
        candidates.push(defaultExport);
      }
    }

    for (var i = 0; i < candidates.length; i += 1) {
      if (isDoctorMessagingApi(candidates[i])) {
        return candidates[i];
      }
    }

    return null;
  }

  function pickModuleBridge(moduleNs) {
    if (!moduleNs || (typeof moduleNs !== 'object' && typeof moduleNs !== 'function')) {
      return null;
    }

    var defaultExport = moduleNs && moduleNs.default ? moduleNs.default : null;
    var candidates = [];

    if (moduleNs) {
      candidates.push(moduleNs.bridge);
      candidates.push(moduleNs.messagingBridge);
      if (typeof moduleNs.ensureReady === 'function' && typeof moduleNs.mount === 'function' && typeof moduleNs.unmount === 'function') {
        candidates.push(moduleNs);
      }
    }

    if (defaultExport && (typeof defaultExport === 'object' || typeof defaultExport === 'function')) {
      candidates.push(defaultExport.bridge);
      candidates.push(defaultExport.messagingBridge);
      if (typeof defaultExport.ensureReady === 'function' && typeof defaultExport.mount === 'function' && typeof defaultExport.unmount === 'function') {
        candidates.push(defaultExport);
      }
    }

    for (var i = 0; i < candidates.length; i += 1) {
      if (isDoctorMessagingBridge(candidates[i])) {
        return candidates[i];
      }
    }

    return null;
  }

  function resolveMessagingApi() {
    var immediateApi = getImmediateMessagingApi();
    if (immediateApi) {
      return Promise.resolve(immediateApi);
    }

    var importedBridge = getImportedMessagingBridge();
    if (!importedBridge) {
      return Promise.reject(new Error('Bridge React médecin indisponible après chargement du bundle admin.'));
    }

    return Promise.resolve(importedBridge.ensureReady())
      .then(function (resolvedApi) {
        if (isDoctorMessagingApi(resolvedApi)) {
          window.SosDoctorMessaging = resolvedApi;
          return resolvedApi;
        }

        var globalApi = getImmediateMessagingApi();
        if (globalApi) {
          return globalApi;
        }

        throw new Error('Bridge React médecin indisponible après chargement du bundle admin.');
      });
  }

  function installImportedModule(moduleNs) {
    var exportedApi = pickModuleApi(moduleNs);
    var exportedBridge = pickModuleBridge(moduleNs);

    if (isDoctorMessagingApi(exportedApi)) {
      window.SosDoctorMessaging = exportedApi;
    }

    if (isDoctorMessagingBridge(exportedBridge) && !isLoaderBridge(exportedBridge)) {
      window.SosDoctorMessagingBridge = exportedBridge;
    }

    if (isDoctorMessagingApi(exportedApi)) {
      return Promise.resolve(exportedApi);
    }

    if (isDoctorMessagingBridge(exportedBridge) && !isLoaderBridge(exportedBridge)) {
      return Promise.resolve(exportedBridge.ensureReady())
        .then(function (resolvedApi) {
          if (isDoctorMessagingApi(resolvedApi)) {
            window.SosDoctorMessaging = resolvedApi;
            return resolvedApi;
          }

          return resolveMessagingApi();
        });
    }

    return resolveMessagingApi();
  }

  function ensureBridge() {
    var bootCfg = getBootConfig();
    var state = window.__SosPrescriptionDoctorBridgeState;
    if (!state) {
      state = {
        readyPromise: null,
        moduleUrl: '',
        viteClientUrl: '',
        rootId: '',
        loaderBridge: null
      };
      window.__SosPrescriptionDoctorBridgeState = state;
    }

    state.moduleUrl = bootCfg.moduleUrl;
    state.viteClientUrl = bootCfg.viteClientUrl;
    state.rootId = bootCfg.rootId;

    var existingBridge = getImportedMessagingBridge();
    if (existingBridge) {
      return existingBridge;
    }

    if (!state.loaderBridge) {
      state.loaderBridge = {
        __spLoaderBridge: true,
        ensureReady: function () {
          var immediateApi = getImmediateMessagingApi();
          if (immediateApi) {
            return Promise.resolve(immediateApi);
          }

          if (state.readyPromise) {
            return state.readyPromise;
          }

          if (!state.moduleUrl) {
            return Promise.reject(new Error('URL du module admin manquante.'));
          }

          state.readyPromise = importViteClientIfNeeded(state.viteClientUrl)
            .then(function () {
              return import(state.moduleUrl);
            })
            .then(function (moduleNs) {
              return installImportedModule(moduleNs);
            })
            .catch(function (error) {
              state.readyPromise = null;
              throw error;
            });

          return state.readyPromise;
        },
        mount: function (containerEl, prescriptionId) {
          return this.ensureReady().then(function (api) {
            try {
              api.mount(containerEl, prescriptionId);
              return undefined;
            } catch (error) {
              renderHostError(containerEl, error && error.message ? String(error.message) : 'Impossible de monter la messagerie.');
              throw error;
            }
          });
        },
        unmount: function (containerEl) {
          return Promise.resolve().then(function () {
            try {
              var api = getImmediateMessagingApi();
              if (api) {
                api.unmount(containerEl);
                return;
              }

              var bridge = getImportedMessagingBridge();
              if (bridge) {
                return Promise.resolve(bridge.unmount(containerEl));
              }
            } catch (_) {
              // no-op
            }

            return undefined;
          });
        }
      };
    }

    window.SosDoctorMessagingBridge = state.loaderBridge;
    return state.loaderBridge;
  }

  function boot() {
    var bootCfg = getBootConfig();

    patchFetch('sosprescription_admin');
    ensureBridge();

    sendLog('loader_boot', 'info', {
      page: String(window.location && window.location.href ? window.location.href : ''),
      rootId: bootCfg.rootId,
      moduleUrl: bootCfg.moduleUrl,
      hasViteClientUrl: bootCfg.viteClientUrl !== ''
    });

    if (!bootCfg.moduleUrl) {
      sendLog('loader_missing_module_url', 'error', { rootId: bootCfg.rootId });
      renderRootError(bootCfg.rootId, 'URL du module Vite admin manquante.');
      return;
    }

    window.SosDoctorMessagingBridge.ensureReady().then(function () {
      sendLog('import_ok', 'info', {
        moduleUrl: bootCfg.moduleUrl
      });
    }).catch(function (error) {
      console.error('[SosPrescription] admin import() failed', error);
      sendLog('import_fail', 'error', {
        moduleUrl: bootCfg.moduleUrl,
        message: error && error.message ? String(error.message) : 'import() failed'
      });
      renderRootError(bootCfg.rootId, 'Impossible de charger le bridge React de la console médecin.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
