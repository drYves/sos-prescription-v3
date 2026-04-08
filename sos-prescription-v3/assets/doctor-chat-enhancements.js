(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderMountError(containerEl, message) {
    if (!(containerEl instanceof HTMLElement)) {
      return;
    }

    containerEl.innerHTML = ''
      + '<div class="dc-message-empty">'
      + escapeHtml(message ? String(message) : 'Bridge de messagerie introuvable.')
      + '</div>';
  }

  function getMountedApi() {
    var api = window.SosDoctorMessaging;
    if (api && typeof api.mount === 'function' && typeof api.unmount === 'function') {
      return api;
    }
    return null;
  }

  function getDirectBridge() {
    var bridge = window.SosDoctorMessagingBridge;
    var api = getMountedApi();

    if (!api) {
      return null;
    }

    if (bridge && typeof bridge.mount === 'function' && typeof bridge.unmount === 'function') {
      return bridge;
    }

    return null;
  }

  function missingBridgeError() {
    return new Error('Bridge de messagerie introuvable.');
  }

  function ensureBridgeApi() {
    var api = getMountedApi();
    if (api) {
      return Promise.resolve(api);
    }

    return Promise.reject(missingBridgeError());
  }

  function mount(containerEl, prescriptionId) {
    if (!(containerEl instanceof HTMLElement)) {
      return Promise.resolve(null);
    }

    var numericId = Number(prescriptionId || 0);
    if (!Number.isFinite(numericId) || numericId < 1) {
      var invalidError = new Error('Référence de dossier invalide pour la messagerie.');
      renderMountError(containerEl, invalidError.message);
      return Promise.reject(invalidError);
    }

    var directBridge = getDirectBridge();
    if (directBridge && directBridge !== bridge) {
      return Promise.resolve(directBridge.mount(containerEl, numericId)).catch(function (error) {
        renderMountError(containerEl, error && error.message ? String(error.message) : 'Bridge de messagerie introuvable.');
        throw error;
      });
    }

    var api = getMountedApi();
    if (!api) {
      var missingError = missingBridgeError();
      renderMountError(containerEl, missingError.message);
      return Promise.reject(missingError);
    }

    try {
      api.mount(containerEl, numericId);
      containerEl.setAttribute('data-sp-doctor-chat-ready', '1');
      containerEl.setAttribute('data-sp-doctor-chat-prescription-id', String(numericId));
      return Promise.resolve(api);
    } catch (error) {
      renderMountError(containerEl, error && error.message ? String(error.message) : 'Bridge de messagerie introuvable.');
      return Promise.reject(error);
    }
  }

  function unmount(containerEl) {
    if (!(containerEl instanceof HTMLElement)) {
      return Promise.resolve(undefined);
    }

    var directBridge = getDirectBridge();
    if (directBridge && directBridge !== bridge) {
      return Promise.resolve(directBridge.unmount(containerEl)).finally(function () {
        containerEl.removeAttribute('data-sp-doctor-chat-ready');
        containerEl.removeAttribute('data-sp-doctor-chat-prescription-id');
      });
    }

    var api = getMountedApi();
    if (api) {
      try {
        api.unmount(containerEl);
      } catch (error) {
        // no-op defensive cleanup
      }
    }

    containerEl.removeAttribute('data-sp-doctor-chat-ready');
    containerEl.removeAttribute('data-sp-doctor-chat-prescription-id');
    return Promise.resolve(undefined);
  }

  var bridge = {
    ensureReady: ensureBridgeApi,
    mount: mount,
    unmount: unmount
  };

  var directBridge = getDirectBridge();
  if (directBridge) {
    window.SosDoctorMessagingBridge = directBridge;
    return;
  }

  var currentBridge = window.SosDoctorMessagingBridge;
  if (currentBridge && typeof currentBridge.mount === 'function' && typeof currentBridge.unmount === 'function') {
    window.SosDoctorMessagingBridge = bridge;
    return;
  }

  window.SosDoctorMessagingBridge = bridge;
})();
