(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  if (window.SosDoctorMessagingBridge && typeof window.SosDoctorMessagingBridge.mount === 'function') {
    return;
  }

  var ADMIN_ENTRY_KEY = 'src/entries/admin.tsx';
  var modulePromise = null;
  var manifestPromise = null;
  var lastErrorMessage = '';

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function dynamicImport(url) {
    return Function('u', 'return import(u);')(url);
  }

  function currentScriptSrc() {
    var current = document.currentScript;
    if (current && current.src) {
      return String(current.src);
    }

    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var candidate = scripts[i] && scripts[i].src ? String(scripts[i].src) : '';
      if (candidate.indexOf('/assets/doctor-chat-enhancements.js') !== -1) {
        return candidate;
      }
    }

    return '';
  }

  function resolvePluginBaseUrl() {
    var cfg = window.SOSPrescription || window.SosPrescription || {};
    var direct = normalizeText(cfg && cfg.pluginUrl ? cfg.pluginUrl : '');
    if (direct) {
      return direct.replace(/\/+$/, '');
    }

    var scriptSrc = currentScriptSrc();
    if (!scriptSrc) {
      return '';
    }

    return scriptSrc.replace(/\/assets\/doctor-chat-enhancements\.js(?:\?.*)?$/i, '').replace(/\/+$/, '');
  }

  function joinUrl(base, path) {
    if (/^https?:\/\//i.test(path)) {
      return String(path);
    }

    return String(base || '').replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
  }

  function renderMountError(containerEl, message) {
    if (!(containerEl instanceof HTMLElement)) {
      return;
    }

    containerEl.innerHTML = ''
      + '<div class="dc-message-empty">'
      + (message ? String(message) : 'Impossible de charger la messagerie sécurisée.')
      + '</div>';
  }

  function getMountedApi() {
    var api = window.SosDoctorMessaging;
    if (api && typeof api.mount === 'function' && typeof api.unmount === 'function') {
      return api;
    }
    return null;
  }

  function ensureManifest() {
    if (manifestPromise) {
      return manifestPromise;
    }

    var pluginBaseUrl = resolvePluginBaseUrl();
    if (!pluginBaseUrl) {
      manifestPromise = Promise.reject(new Error('Base plugin introuvable pour charger le bridge React.'));
      return manifestPromise;
    }

    manifestPromise = window.fetch(joinUrl(pluginBaseUrl, 'build/manifest.json'), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    }).then(function (response) {
      if (!response.ok) {
        throw new Error('Manifest Vite indisponible (' + String(response.status) + ').');
      }
      return response.json();
    }).catch(function (error) {
      manifestPromise = null;
      throw error;
    });

    return manifestPromise;
  }

  function resolveEntryUrl() {
    var pluginBaseUrl = resolvePluginBaseUrl();
    if (!pluginBaseUrl) {
      return Promise.reject(new Error('Base plugin introuvable pour charger le bridge React.'));
    }

    return ensureManifest().then(function (manifest) {
      var entry = manifest && typeof manifest === 'object' ? manifest[ADMIN_ENTRY_KEY] : null;
      var file = entry && typeof entry.file === 'string' ? normalizeText(entry.file) : '';
      if (!file) {
        throw new Error('Entrée Vite admin introuvable dans le manifest.');
      }
      return joinUrl(pluginBaseUrl, 'build/' + file);
    });
  }

  function ensureBridgeApi() {
    var mountedApi = getMountedApi();
    if (mountedApi) {
      return Promise.resolve(mountedApi);
    }

    if (modulePromise) {
      return modulePromise;
    }

    modulePromise = resolveEntryUrl().then(function (entryUrl) {
      return dynamicImport(entryUrl);
    }).then(function () {
      var api = getMountedApi();
      if (!api) {
        throw new Error('Bridge React médecin introuvable après chargement du module.');
      }
      lastErrorMessage = '';
      return api;
    }).catch(function (error) {
      modulePromise = null;
      lastErrorMessage = error && error.message ? String(error.message) : 'Impossible de charger le bridge React médecin.';
      throw error;
    });

    return modulePromise;
  }

  function mount(containerEl, prescriptionId) {
    if (!(containerEl instanceof HTMLElement)) {
      return Promise.resolve(null);
    }

    var numericId = Number(prescriptionId || 0);
    if (!Number.isFinite(numericId) || numericId < 1) {
      renderMountError(containerEl, 'Référence de dossier invalide pour la messagerie.');
      return Promise.resolve(null);
    }

    containerEl.setAttribute('data-sp-doctor-chat-ready', '0');

    return ensureBridgeApi().then(function (api) {
      api.mount(containerEl, numericId);
      containerEl.setAttribute('data-sp-doctor-chat-ready', '1');
      containerEl.setAttribute('data-sp-doctor-chat-prescription-id', String(numericId));
      return api;
    }).catch(function (error) {
      renderMountError(containerEl, error && error.message ? String(error.message) : lastErrorMessage);
      containerEl.setAttribute('data-sp-doctor-chat-ready', '0');
      throw error;
    });
  }

  function unmount(containerEl) {
    if (!(containerEl instanceof HTMLElement)) {
      return;
    }

    var api = getMountedApi();
    if (!api) {
      containerEl.removeAttribute('data-sp-doctor-chat-ready');
      containerEl.removeAttribute('data-sp-doctor-chat-prescription-id');
      return;
    }

    try {
      api.unmount(containerEl);
    } catch (error) {
      // no-op defensive cleanup
    }

    containerEl.removeAttribute('data-sp-doctor-chat-ready');
    containerEl.removeAttribute('data-sp-doctor-chat-prescription-id');
  }

  window.SosDoctorMessagingBridge = {
    ensureReady: ensureBridgeApi,
    mount: mount,
    unmount: unmount
  };
})();
