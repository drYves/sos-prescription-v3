(function () {
  'use strict';

  var TAG_NAME = 'sp-doctor-text-chat';
  var PANEL_SELECTOR = '.dc-detail-panel[data-dc-panel="messages"]';
  var DETAIL_SELECTOR = '.dc-detail-pane[data-case-id]';
  var REFRESH_EVENT = 'sp:doctor-chat-refresh';
  var POLL_VISIBLE_MS = 15000;
  var POLL_HIDDEN_MS = 30000;
  var MAX_MESSAGES = 100;
  var STALE_VIEW_MS = 10000;
  var FAILURE_WINDOW_MS = 30000;
  var FAILURE_BACKOFF_MS = 15000;
  var BREAKER_THRESHOLD = 3;
  var BREAKER_COOLDOWN_MS = 60000;
  var ENHANCED_ATTR = 'data-sp-enhanced';
  var UID_ATTR = 'data-sp-rx-uid';
  var LOCAL_ID_ATTR = 'data-sp-local-id';
  var ACTIVE_ATTR = 'data-sp-chat-active';
  var OWNED_ATTR = 'data-sp-chat-owned';
  var DOCTOR_CHAT_UTILITY_STYLE_ID = 'sp-doctor-chat-utility-styles';
  var LEGACY_UID_BY_ID = Object.create(null);
  var SHARED_STATE_BY_UID = Object.create(null);
  var observer = null;
  var observerRoot = null;
  var enhanceTimer = 0;

  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof customElements === 'undefined') {
    return;
  }

  ensureDoctorChatUtilityStyles();
  installPassiveUidInterceptor();
  ensureObserver();
  scheduleEnhancement();

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeUid(value) {
    var text = normalizeText(value);
    return /^[A-Za-z0-9_-]{4,128}$/.test(text) ? text : '';
  }

  function normalizeLocalId(value) {
    var numeric = Number(value || 0);
    return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
  }

  function normalizeMode(value) {
    var mode = normalizeText(value).toUpperCase();
    if (mode === 'DOCTOR_ONLY' || mode === 'PATIENT_REPLY' || mode === 'READ_ONLY') {
      return mode;
    }
    return '';
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function cloneValue(value) {
    try {
      return JSON.parse(JSON.stringify(value == null ? null : value));
    } catch (error) {
      return value;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function config() {
    return window.SOSPrescription || window.SosPrescription || {};
  }

  function restV4Base() {
    var cfg = config();
    var direct = normalizeText(cfg && cfg.restV4Base ? cfg.restV4Base : '');
    if (direct) {
      return direct.replace(/\/$/, '');
    }

    var legacyBase = normalizeText(cfg && cfg.restBase ? cfg.restBase : '');
    if (legacyBase) {
      return legacyBase.replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').replace(/\/$/, '');
    }

    return '';
  }

  function restNonce() {
    var cfg = config();
    return normalizeText(cfg && cfg.nonce ? cfg.nonce : '');
  }

  function buildApiUrl(uid, suffix, params) {
    var base = restV4Base();
    if (!base) {
      throw new Error('Configuration REST V4 absente.');
    }

    var url = base + '/prescriptions/' + encodeURIComponent(uid) + suffix;
    if (!params || typeof params !== 'object') {
      return url;
    }

    var search = new URLSearchParams();
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = params[key];
      if (value == null || value === '') {
        continue;
      }
      search.set(key, String(value));
    }

    var query = search.toString();
    return query ? url + '?' + query : url;
  }

  function createRequestError(data, status, fallbackMessage) {
    var message = fallbackMessage || 'Erreur de messagerie';
    if (data && typeof data.message === 'string' && normalizeText(data.message) !== '') {
      message = data.message;
    } else if (data && typeof data.code === 'string' && normalizeText(data.code) !== '') {
      message = data.code;
    }

    var error = new Error(message);
    error.status = Number(status || 0) || 0;
    error.payload = data;
    return error;
  }

  function fetchJson(method, url, payload, signal) {
    var nonce = restNonce();
    if (!nonce) {
      return Promise.reject(new Error('Nonce WordPress introuvable.'));
    }

    var headers = {
      'X-WP-Nonce': nonce,
      'X-Sos-Scope': 'doctor'
    };

    var init = {
      method: String(method || 'GET').toUpperCase(),
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: signal
    };

    if (init.method === 'GET') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers.Pragma = 'no-cache';
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload || {});
    }

    return window.fetch(url, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          data = null;
        }

        if (!response.ok) {
          throw createRequestError(data, response.status, 'Erreur de messagerie');
        }

        return {
          status: response.status,
          payload: data
        };
      });
    }).catch(function (error) {
      if (error && (error.name === 'AbortError' || error.code === 20)) {
        throw error;
      }

      if (error instanceof Error) {
        throw error;
      }

      throw createRequestError(null, 0, 'Erreur réseau.');
    });
  }


  function buildDoctorChatUtilityCss() {
    return [
      '.spu-thread-stack > * + *{margin-top:.75rem;}',
      '.spu-flex{display:flex;}',
      '.spu-flex-col{flex-direction:column;}',
      '.spu-items-start{align-items:flex-start;}',
      '.spu-items-end{align-items:flex-end;}',
      '.spu-justify-start{justify-content:flex-start;}',
      '.spu-justify-end{justify-content:flex-end;}',
      '.spu-justify-between{justify-content:space-between;}',
      '.spu-gap-1{gap:.25rem;}',
      '.spu-gap-2{gap:.5rem;}',
      '.spu-gap-3{gap:.75rem;}',
      '.spu-max-w-85{max-width:85%;}',
      '.spu-max-h-chat{max-height:28rem;}',
      '.spu-overflow-y-auto{overflow-y:auto;}',
      '.spu-rounded-2xl{border-radius:16px;}',
      '.spu-rounded-xl{border-radius:12px;}',
      '.spu-border{border:1px solid #e5e7eb;}',
      '.spu-border-gray-200{border-color:#e5e7eb;}',
      '.spu-bg-white{background:#ffffff;}',
      '.spu-bg-gray-50{background:#f9fafb;}',
      '.spu-bg-gray-100{background:#f3f4f6;}',
      '.spu-bg-gray-900{background:#111827;}',
      '.spu-bg-red-50{background:#fef2f2;}',
      '.spu-bg-blue-50{background:#eff6ff;}',
      '.spu-text-white{color:#ffffff;}',
      '.spu-text-gray-900{color:#111827;}',
      '.spu-text-gray-700{color:#374151;}',
      '.spu-text-gray-600{color:#4b5563;}',
      '.spu-text-gray-500{color:#6b7280;}',
      '.spu-text-red-700{color:#b91c1c;}',
      '.spu-text-blue-900{color:#1e3a8a;}',
      '.spu-text-sm{font-size:.875rem;line-height:1.4;}',
      '.spu-text-xs{font-size:.75rem;line-height:1rem;}',
      '.spu-font-semibold{font-weight:600;}',
      '.spu-uppercase{text-transform:uppercase;}',
      '.spu-tracking-wide{letter-spacing:.05em;}',
      '.spu-p-4{padding:1rem;}',
      '.spu-px-4{padding-left:1rem;padding-right:1rem;}',
      '.spu-py-3{padding-top:.75rem;padding-bottom:.75rem;}',
      '.spu-mt-3{margin-top:.75rem;}',
      '.spu-whitespace-pre-wrap{white-space:pre-wrap;}',
      '.spu-chat-shell{display:flex;flex-direction:column;gap:1rem;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;}',
      '.spu-chat-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;}',
      '.spu-chat-title{margin:0;font-size:1.125rem;line-height:1.3;font-weight:800;color:#111827;}',
      '.spu-chat-subtitle{margin:.25rem 0 0;font-size:.875rem;line-height:1.4;color:#4b5563;}',
      '.spu-chat-note{margin:0;font-size:.75rem;line-height:1rem;color:#6b7280;}',
      '.spu-chat-panel{background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:1rem;}',
      '.spu-chat-empty{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem;padding:1rem;border:1px dashed #d1d5db;border-radius:16px;background:#f9fafb;}',
      '.spu-chat-empty-title{margin:0;font-size:.875rem;font-weight:700;color:#111827;}',
      '.spu-chat-empty-body{margin:0;font-size:.875rem;line-height:1.4;color:#4b5563;}',
      '.spu-chat-textarea{width:100%;min-height:9rem;padding:.875rem 1rem;border-radius:16px;border:1px solid #d1d5db;background:#ffffff;color:#111827;font:inherit;resize:vertical;}',
      '.spu-chat-textarea:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.18);}',
      '.spu-chat-button{display:inline-flex;align-items:center;justify-content:center;min-height:3rem;padding:.75rem 1.25rem;border-radius:16px;border:1px solid transparent;background:#111827;color:#ffffff;font:inherit;font-weight:700;cursor:pointer;transition:background-color .15s ease,opacity .15s ease;}',
      '.spu-chat-button:hover{background:#1f2937;}',
      '.spu-chat-button:disabled{opacity:.6;cursor:not-allowed;}',
      '.spu-chat-button--secondary{background:#ffffff;border-color:#d1d5db;color:#111827;}',
      '.spu-chat-button--secondary:hover{background:#f3f4f6;}',
      '.spu-chat-alert{border-radius:16px;border:1px solid #dbeafe;padding:.875rem 1rem;font-size:.875rem;line-height:1.4;background:#eff6ff;color:#1e3a8a;}',
      '.spu-chat-alert--error{border-color:#fecaca;background:#fef2f2;color:#b91c1c;}',
      '.spu-chat-actions{display:flex;justify-content:flex-end;gap:.75rem;}',
      '.spu-chat-host{display:block;width:100%;}'
    ].join('');
  }

  function ensureDoctorChatUtilityStyles() {
    if (!document || !document.head || document.getElementById(DOCTOR_CHAT_UTILITY_STYLE_ID)) {
      return;
    }

    var style = document.createElement('style');
    style.id = DOCTOR_CHAT_UTILITY_STYLE_ID;
    style.type = 'text/css';
    style.textContent = buildDoctorChatUtilityCss();
    document.head.appendChild(style);
  }


  function pad2(value) {
    var number = Number(value || 0);
    return number < 10 ? '0' + String(number) : String(number);
  }

  function formatTimestamp(value) {
    var text = normalizeText(value);
    if (!text) {
      return '';
    }

    var date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return text;
    }

    return 'Le ' + pad2(date.getDate())
      + '/' + pad2(date.getMonth() + 1)
      + '/' + String(date.getFullYear())
      + ' à ' + pad2(date.getHours())
      + ':' + pad2(date.getMinutes());
  }

  function resolveMode(threadState) {
    var mode = normalizeMode(threadState && threadState.mode ? threadState.mode : '');
    return mode || 'DOCTOR_ONLY';
  }

  function roleLabel(role) {
    var normalized = normalizeText(role).toUpperCase();
    return normalized === 'DOCTOR' ? 'VOUS' : 'PATIENT';
  }

  function roleClass(role) {
    return normalizeText(role).toUpperCase() === 'DOCTOR' ? 'is-doctor' : 'is-patient';
  }

  function threadModeMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Vous pouvez ouvrir l\'échange si une information complémentaire est nécessaire.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Le patient peut répondre tant que la décision médicale n\'est pas rendue.';
    }
    if (mode === 'READ_ONLY') {
      return 'Décision médicale rendue. La messagerie est désormais disponible en lecture seule.';
    }
    return '';
  }

  function emptyStateMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Aucun message pour le moment. Vous pouvez envoyer la première demande d\'information au patient.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Aucun nouveau message du patient pour le moment.';
    }
    return 'Aucun message n\'a été échangé avant la clôture médicale de cette demande.';
  }

  function infoNote() {
    return 'Information : Cet espace est réservé exclusivement aux messages textuels. L\'envoi de documents ou de photos n\'est pas disponible ici.';
  }

  function readMessages(payload) {
    return payload && typeof payload === 'object' && Array.isArray(payload.messages)
      ? payload.messages
      : [];
  }

  function readThreadState(payload) {
    return payload && typeof payload === 'object' && payload.thread_state && typeof payload.thread_state === 'object'
      ? payload.thread_state
      : null;
  }

  function dedupeMessages(messages) {
    var items = Array.isArray(messages) ? messages : [];
    var seen = Object.create(null);
    var out = [];

    for (var index = 0; index < items.length; index += 1) {
      var message = items[index] && typeof items[index] === 'object' ? items[index] : {};
      var key = normalizeText(message.id || message.seq || '');
      if (!key) {
        key = [normalizeText(message.author_role || message.authorRole || ''), normalizeText(message.created_at || message.createdAt || ''), normalizeText(message.body || '')].join('|');
      }
      if (!key) {
        key = 'idx:' + String(index);
      }
      if (seen[key]) {
        continue;
      }
      seen[key] = true;
      out.push(message);
    }

    return out;
  }

  function readSharedState(uid) {
    var key = normalizeUid(uid);
    return key ? asObject(cloneValue(SHARED_STATE_BY_UID[key] || {})) : {};
  }

  function writeSharedState(uid, nextState) {
    var key = normalizeUid(uid);
    if (!key) {
      return;
    }
    SHARED_STATE_BY_UID[key] = asObject(cloneValue(nextState));
  }

  function ensureCircuitState(raw) {
    var circuit = asObject(raw);

    circuit.failures = Number.isFinite(circuit.failures) && circuit.failures > 0
      ? Math.trunc(circuit.failures)
      : 0;
    circuit.lastFailureAt = Number.isFinite(circuit.lastFailureAt) && circuit.lastFailureAt > 0
      ? Math.trunc(circuit.lastFailureAt)
      : 0;
    circuit.openedUntil = Number.isFinite(circuit.openedUntil) && circuit.openedUntil > 0
      ? Math.trunc(circuit.openedUntil)
      : 0;
    circuit.lastStatus = Number.isFinite(circuit.lastStatus) && circuit.lastStatus > 0
      ? Math.trunc(circuit.lastStatus)
      : 0;

    return circuit;
  }

  function resetCircuitState(circuit) {
    var nextCircuit = ensureCircuitState(circuit);
    nextCircuit.failures = 0;
    nextCircuit.lastFailureAt = 0;
    nextCircuit.openedUntil = 0;
    nextCircuit.lastStatus = 0;
    return nextCircuit;
  }

  function recordCircuitFailure(circuit, status) {
    var nextCircuit = ensureCircuitState(circuit);
    var now = Date.now();

    if (!nextCircuit.lastFailureAt || (now - nextCircuit.lastFailureAt) > FAILURE_WINDOW_MS) {
      nextCircuit.failures = 0;
    }

    nextCircuit.failures += 1;
    nextCircuit.lastFailureAt = now;
    nextCircuit.lastStatus = Number(status || 0) || 0;

    var cooldown = nextCircuit.failures >= BREAKER_THRESHOLD
      ? BREAKER_COOLDOWN_MS
      : FAILURE_BACKOFF_MS * nextCircuit.failures;

    nextCircuit.openedUntil = Math.max(nextCircuit.openedUntil, now + cooldown);
    return nextCircuit;
  }

  function circuitIsOpen(circuit) {
    return ensureCircuitState(circuit).openedUntil > Date.now();
  }

  function circuitRemainingMs(circuit) {
    return Math.max(0, ensureCircuitState(circuit).openedUntil - Date.now());
  }

  function formatDuration(ms) {
    var seconds = Math.max(1, Math.ceil(ms / 1000));
    if (seconds >= 120) {
      return String(Math.ceil(seconds / 60)) + ' min';
    }
    if (seconds >= 60) {
      return '1 min';
    }
    return String(seconds) + ' s';
  }

  function circuitMessage(circuit) {
    if (!circuitIsOpen(circuit)) {
      return '';
    }

    return 'Messagerie temporairement indisponible. Nouvel essai automatique dans ' + formatDuration(circuitRemainingMs(circuit)) + '.';
  }

  function shouldThrottleOnError(error) {
    var status = error && typeof error.status === 'number' ? error.status : 0;
    return status === 0 || status >= 500;
  }

  function pollDelayForState(circuit) {
    if (circuitIsOpen(circuit)) {
      return Math.max(circuitRemainingMs(circuit) + 1000, POLL_VISIBLE_MS);
    }
    return document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  }

  function extractFetchUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input && typeof input.url === 'string') {
      return input.url;
    }
    return '';
  }

  function stripHash(url) {
    return String(url || '').replace(/#.*$/, '');
  }

  function isLegacyPrescriptionPayloadUrl(url) {
    var normalized = stripHash(url);
    return /\/sosprescription\/v1\/prescriptions(?:\?.*)?$/i.test(normalized)
      || /\/sosprescription\/v1\/prescriptions\/\d+(?:\?.*)?$/i.test(normalized);
  }

  function extractUidCandidate(record) {
    var object = asObject(record);
    return normalizeUid(
      object.uid
      || object.rx_uid
      || object.public_uid
      || object.public_id
      || object.reference
      || object.code
      || asObject(object.payload).uid
      || asObject(asObject(object.payload).worker).uid
      || asObject(object.worker).uid
      || ''
    );
  }

  function collectUidMappings(node) {
    var changed = false;

    function walk(value) {
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i += 1) {
          walk(value[i]);
        }
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      var object = asObject(value);
      var localId = normalizeLocalId(object.id);
      var uid = extractUidCandidate(object);
      if (localId > 0 && uid && LEGACY_UID_BY_ID[localId] !== uid) {
        LEGACY_UID_BY_ID[localId] = uid;
        changed = true;
      }

      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j += 1) {
        walk(object[keys[j]]);
      }
    }

    walk(node);
    return changed;
  }

  function inspectLegacyResponse(requestUrl, response) {
    if (!response || !response.ok) {
      return;
    }

    var candidateUrl = normalizeText(response.url || requestUrl);
    if (!isLegacyPrescriptionPayloadUrl(candidateUrl)) {
      return;
    }

    response.clone().text().then(function (text) {
      if (!text) {
        return;
      }

      var data = null;
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = null;
      }

      if (!data) {
        return;
      }

      if (collectUidMappings(data)) {
        scheduleEnhancement();
      }
    }).catch(function () {
      return null;
    });
  }

  function installPassiveUidInterceptor() {
    if (typeof window.fetch !== 'function' || window.__spDoctorChatInterceptorInstalled) {
      return;
    }

    var nativeFetch = window.fetch.bind(window);
    window.fetch = function () {
      var requestUrl = extractFetchUrl(arguments[0]);
      var result = nativeFetch.apply(window, arguments);
      result.then(function (response) {
        inspectLegacyResponse(requestUrl, response);
      }).catch(function () {
        return null;
      });
      return result;
    };
    window.__spDoctorChatInterceptorInstalled = true;
  }

  function currentObserverRoot() {
    return document.getElementById('sosprescription-doctor-console-root') || document.body;
  }

  function observeCurrentRoot() {
    if (!observer || !observerRoot) {
      return;
    }

    observer.observe(observerRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-case-id', 'data-dc-panel']
    });
  }

  function nodeContainsRelevantSurface(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    if (node.matches(PANEL_SELECTOR) || node.matches(DETAIL_SELECTOR)) {
      return true;
    }

    return !!(node.querySelector && (node.querySelector(PANEL_SELECTOR) || node.querySelector(DETAIL_SELECTOR)));
  }

  function nodeListContainsRelevantSurface(nodeList) {
    if (!nodeList || typeof nodeList.length !== 'number') {
      return false;
    }

    for (var i = 0; i < nodeList.length; i += 1) {
      if (nodeContainsRelevantSurface(nodeList[i])) {
        return true;
      }
    }

    return false;
  }

  function isOwnedPanel(node) {
    return node instanceof HTMLElement
      && node.matches(PANEL_SELECTOR)
      && node.getAttribute(OWNED_ATTR) === '1';
  }

  function isShieldedPanel(node) {
    return isOwnedPanel(node);
  }

  function closestOwnedPanel(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    var panel = node.closest(PANEL_SELECTOR);
    return isOwnedPanel(panel) ? panel : null;
  }

  function mutationsNeedEnhancement(records) {
    if (!records || typeof records.length !== 'number') {
      return false;
    }

    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      var target = record && record.target instanceof Element ? record.target : null;

      if (record && record.type === 'attributes') {
        if (target && (target.matches(PANEL_SELECTOR) || target.matches(DETAIL_SELECTOR))) {
          return true;
        }
        continue;
      }

      if (!record || record.type !== 'childList') {
        continue;
      }

      if (target && (isShieldedPanel(target) || closestOwnedPanel(target))) {
        continue;
      }

      if (nodeListContainsRelevantSurface(record.addedNodes) || nodeListContainsRelevantSurface(record.removedNodes)) {
        return true;
      }

      if (target && nodeContainsRelevantSurface(target)) {
        return true;
      }
    }

    return false;
  }

  function ensureObserver() {
    var nextRoot = currentObserverRoot();
    if (!nextRoot) {
      return;
    }

    if (!observer) {
      observer = new MutationObserver(function (records) {
        if (mutationsNeedEnhancement(records)) {
          scheduleEnhancement();
        }
      });
    }

    if (observerRoot === nextRoot) {
      return;
    }

    observer.disconnect();
    observerRoot = nextRoot;
    observeCurrentRoot();
  }

  function scheduleEnhancement() {
    ensureObserver();
    if (enhanceTimer) {
      return;
    }

    enhanceTimer = window.setTimeout(function () {
      enhanceTimer = 0;
      runEnhancements();
    }, 80);
  }

  function runEnhancements() {
    ensureObserver();
    if (!observerRoot) {
      return;
    }

    if (observer) {
      observer.disconnect();
    }

    try {
      var panels = observerRoot.querySelectorAll(PANEL_SELECTOR);
      for (var i = 0; i < panels.length; i += 1) {
        enhancePanel(panels[i]);
      }
    } finally {
      observeCurrentRoot();
    }
  }

  function ensurePanelHost(panel) {
    if (!(panel instanceof HTMLElement)) {
      return null;
    }

    var host = panel.querySelector('[data-sp-chat-host="1"]');
    if (!(host instanceof HTMLElement)) {
      panel.innerHTML = '';
      host = document.createElement('div');
      host.className = 'sp-doctor-chat-host';
      host.setAttribute('data-sp-chat-host', '1');
      panel.appendChild(host);
    }

    panel.setAttribute(OWNED_ATTR, '1');
    return host;
  }

  function ensurePanelComponent(panel) {
    if (!(panel instanceof HTMLElement)) {
      return null;
    }

    var host = ensurePanelHost(panel);
    if (!host) {
      return null;
    }

    var element = host.querySelector(TAG_NAME);
    if (element instanceof HTMLElement) {
      return element;
    }

    element = document.createElement(TAG_NAME);
    host.appendChild(element);
    return element;
  }

  function syncPanelComponent(element, uid, localId, active) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    var normalizedUid = normalizeUid(uid);
    var normalizedLocalId = normalizeLocalId(localId);

    if (element.getAttribute('data-rx-uid') !== normalizedUid) {
      element.setAttribute('data-rx-uid', normalizedUid);
    }
    if (element.getAttribute('data-local-id') !== String(normalizedLocalId)) {
      element.setAttribute('data-local-id', String(normalizedLocalId));
    }
    if (element.getAttribute('data-active') !== (active ? '1' : '0')) {
      element.setAttribute('data-active', active ? '1' : '0');
    }
  }

  function panelSignature(uid, localId, active) {
    return [normalizeUid(uid), String(normalizeLocalId(localId)), active ? '1' : '0'].join('|');
  }

  function enhancePanel(panel) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    var detailPane = panel.closest(DETAIL_SELECTOR);
    var localId = normalizeLocalId(detailPane && detailPane.getAttribute('data-case-id'));
    var active = panel.classList.contains('is-active');
    var uid = '';

    if (localId > 0 && LEGACY_UID_BY_ID[localId]) {
      uid = normalizeUid(LEGACY_UID_BY_ID[localId]);
    }
    if (!uid) {
      uid = normalizeUid(panel.getAttribute(UID_ATTR) || '');
    }

    var signature = panelSignature(uid, localId, active);
    if (panel.getAttribute(ENHANCED_ATTR) === '1' && panel.__spDoctorChatSignature === signature) {
      var existingElement = ensurePanelComponent(panel);
      if (existingElement) {
        syncPanelComponent(existingElement, uid, localId, active);
      }
      return;
    }

    if (localId > 0) {
      panel.setAttribute(LOCAL_ID_ATTR, String(localId));
    } else {
      panel.removeAttribute(LOCAL_ID_ATTR);
    }

    panel.setAttribute(ACTIVE_ATTR, active ? '1' : '0');
    if (uid) {
      panel.setAttribute(UID_ATTR, uid);
    } else {
      panel.removeAttribute(UID_ATTR);
    }

    var element = ensurePanelComponent(panel);
    if (!element) {
      return;
    }

    syncPanelComponent(element, uid, localId, active);
    panel.setAttribute(ENHANCED_ATTR, '1');
    panel.setAttribute(OWNED_ATTR, '1');
    panel.__spDoctorChatSignature = signature;
  }

  class DoctorTextChatElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-rx-uid', 'data-local-id', 'data-active'];
    }

    constructor() {
      super();
      this._frame = null;
      this._requestSeq = 0;
      this._pollTimer = 0;
      this._abortController = null;
      this._connected = false;
      this._state = this.createDefaultState();
      this._onShadowClick = this.onShadowClick.bind(this);
      this._onShadowInput = this.onShadowInput.bind(this);
      this._onShadowSubmit = this.onShadowSubmit.bind(this);
      this._onVisibilityChange = this.onVisibilityChange.bind(this);
      this._onRefresh = this.onRefresh.bind(this);
    }

    createDefaultState() {
      return {
        uid: '',
        localId: 0,
        active: false,
        loading: false,
        sending: false,
        error: '',
        flash: '',
        draft: '',
        payload: null,
        fetchedAt: 0,
        circuit: ensureCircuitState({})
      };
    }

    connectedCallback() {
      if (!this._connected) {
        this.addEventListener('click', this._onShadowClick);
        this.addEventListener('input', this._onShadowInput);
        this.addEventListener('submit', this._onShadowSubmit);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        window.addEventListener(REFRESH_EVENT, this._onRefresh);
        this._connected = true;
      }

      this.renderFrame();
      this.syncFromAttributes(true);
    }

    disconnectedCallback() {
      this.stopPolling();
      this.abortPending();

      if (this._connected) {
        this.removeEventListener('click', this._onShadowClick);
        this.removeEventListener('input', this._onShadowInput);
        this.removeEventListener('submit', this._onShadowSubmit);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        window.removeEventListener(REFRESH_EVENT, this._onRefresh);
        this._connected = false;
      }

      this.persistSharedState();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue === newValue || !this.isConnected) {
        return;
      }
      this.syncFromAttributes(name === 'data-rx-uid' || name === 'data-active');
    }

    persistSharedState() {
      if (!this._state.uid) {
        return;
      }

      writeSharedState(this._state.uid, {
        draft: this._state.draft,
        payload: this._state.payload,
        fetchedAt: this._state.fetchedAt,
        circuit: this._state.circuit
      });
    }

    hydrateSharedState(uid) {
      var shared = readSharedState(uid);
      this._state.draft = typeof shared.draft === 'string' ? shared.draft : '';
      this._state.payload = shared.payload && typeof shared.payload === 'object' ? shared.payload : null;
      this._state.fetchedAt = Number.isFinite(shared.fetchedAt) && shared.fetchedAt > 0 ? Math.trunc(shared.fetchedAt) : 0;
      this._state.circuit = ensureCircuitState(shared.circuit || {});
    }

    syncFromAttributes(forceReload) {
      var nextUid = normalizeUid(this.getAttribute('data-rx-uid') || '');
      var nextLocalId = normalizeLocalId(this.getAttribute('data-local-id') || '');
      var nextActive = this.getAttribute('data-active') === '1';
      var uidChanged = nextUid !== this._state.uid;
      var localIdChanged = nextLocalId !== this._state.localId;
      var activeChanged = nextActive !== this._state.active;

      if (!uidChanged && !localIdChanged && !activeChanged && !forceReload) {
        return;
      }

      this.stopPolling();
      this.abortPending();

      if (uidChanged) {
        this._state = this.createDefaultState();
        this._state.uid = nextUid;
        this.hydrateSharedState(nextUid);
      }

      this._state.uid = nextUid;
      this._state.localId = nextLocalId;
      this._state.active = nextActive;
      this._state.error = '';
      this._state.flash = '';

      if (!nextUid || !nextActive) {
        this.render();
        return;
      }

      var hasFreshPayload = !!(this._state.payload && this._state.fetchedAt > 0 && (Date.now() - this._state.fetchedAt) < STALE_VIEW_MS);
      this.render();

      if (forceReload && !hasFreshPayload && !circuitIsOpen(this._state.circuit)) {
        this.loadThread({ force: true });
        return;
      }

      if (!this._state.payload && !circuitIsOpen(this._state.circuit)) {
        this.loadThread({ force: true });
        return;
      }

      this.schedulePolling();
    }

    renderFrame() {
      ensureDoctorChatUtilityStyles();
      if (this._frame) {
        return;
      }

      var mount = document.createElement('div');
      mount.className = 'sp-doctor-chat-host';
      this.innerHTML = '';
      this.appendChild(mount);
      this._frame = mount;
    }

    abortPending() {
      if (this._abortController && typeof this._abortController.abort === 'function') {
        try {
          this._abortController.abort();
        } catch (error) {
          return null;
        }
      }
      this._abortController = null;
      return null;
    }

    stopPolling() {
      if (this._pollTimer) {
        window.clearTimeout(this._pollTimer);
        this._pollTimer = 0;
      }
    }

    schedulePolling() {
      var self = this;
      this.stopPolling();

      if (!this.isConnected || !this._state.uid || !this._state.active) {
        return;
      }

      if (resolveMode(this.currentThreadState()) === 'READ_ONLY') {
        return;
      }

      var delay = pollDelayForState(this._state.circuit);
      this._pollTimer = window.setTimeout(function () {
        self.loadThread({ silent: true });
      }, delay);
    }

    onVisibilityChange() {
      if (!this.isConnected || !this._state.uid || !this._state.active) {
        return;
      }
      this.schedulePolling();
    }

    onRefresh() {
      if (!this.isConnected || !this._state.uid || !this._state.active) {
        return;
      }
      this.loadThread({ manual: true, force: true });
    }

    currentMessages() {
      return dedupeMessages(readMessages(this._state.payload));
    }

    currentThreadState() {
      return readThreadState(this._state.payload);
    }

    loadThread(options) {
      var self = this;
      var opts = asObject(options || {});
      var uid = this._state.uid;

      if (!uid || !this._state.active) {
        return Promise.resolve(null);
      }

      if (circuitIsOpen(this._state.circuit) && !opts.manual) {
        this._state.loading = false;
        this.render();
        this.schedulePolling();
        return Promise.resolve(null);
      }

      this.stopPolling();
      this.abortPending();

      this._requestSeq += 1;
      var seq = this._requestSeq;

      if (!opts.silent) {
        this._state.loading = true;
        this._state.error = '';
        this.render();
      }

      if (typeof AbortController !== 'undefined') {
        this._abortController = new AbortController();
      }

      return fetchJson('GET', buildApiUrl(uid, '/messages', {
        limit: MAX_MESSAGES,
        _ts: Date.now()
      }), null, this._abortController ? this._abortController.signal : undefined).then(function (result) {
        if (seq !== self._requestSeq) {
          return null;
        }

        self._state.loading = false;
        self._state.error = '';
        self._state.payload = result && result.payload && typeof result.payload === 'object'
          ? result.payload
          : { messages: [], thread_state: null };
        self._state.fetchedAt = Date.now();
        self._state.circuit = resetCircuitState(self._state.circuit);
        self.persistSharedState();
        self.render();
        self.schedulePolling();
        self.markReadIfNeeded();
        return self._state.payload;
      }).catch(function (error) {
        if (error && (error.name === 'AbortError' || error.code === 20)) {
          return null;
        }

        if (seq !== self._requestSeq) {
          return null;
        }

        self._state.loading = false;
        if (shouldThrottleOnError(error)) {
          self._state.circuit = recordCircuitFailure(self._state.circuit, error && error.status);
        }
        self._state.error = error && error.message
          ? String(error.message)
          : 'Impossible de charger la messagerie sécurisée.';
        self.persistSharedState();
        self.render();
        self.schedulePolling();
        return null;
      });
    }

    markReadIfNeeded() {
      var self = this;
      var uid = this._state.uid;
      var threadState = this.currentThreadState();
      var messages = this.currentMessages();
      var unreadCount = threadState ? Number(threadState.unread_count_doctor || 0) : 0;
      var mode = resolveMode(threadState);

      if (!uid || !this._state.active || unreadCount < 1 || !Array.isArray(messages) || messages.length === 0 || mode === 'READ_ONLY' || circuitIsOpen(this._state.circuit)) {
        return Promise.resolve(null);
      }

      var lastMessage = messages[messages.length - 1] && typeof messages[messages.length - 1] === 'object'
        ? messages[messages.length - 1]
        : {};
      var readUptoSeq = Number(lastMessage.seq || 0);
      if (!Number.isFinite(readUptoSeq) || readUptoSeq < 1) {
        return Promise.resolve(null);
      }

      return fetchJson('POST', buildApiUrl(uid, '/messages/read'), {
        read_upto_seq: Math.trunc(readUptoSeq)
      }).then(function (result) {
        if (!result || !result.payload || typeof result.payload !== 'object') {
          return null;
        }

        var nextThreadState = readThreadState(result.payload);
        if (!nextThreadState || !self._state.payload || typeof self._state.payload !== 'object') {
          return null;
        }

        self._state.payload.thread_state = nextThreadState;
        self._state.fetchedAt = Date.now();
        self.persistSharedState();
        self.render();
        return null;
      }).catch(function (error) {
        if (shouldThrottleOnError(error)) {
          self._state.circuit = recordCircuitFailure(self._state.circuit, error && error.status);
          self.persistSharedState();
          self.render();
          self.schedulePolling();
        }
        return null;
      });
    }

    onShadowClick(event) {
      var target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!target) {
        return;
      }

      if (normalizeText(target.getAttribute('data-action')) === 'refresh') {
        event.preventDefault();
        if (!this._state.loading) {
          this.loadThread({ manual: true, force: true });
        }
      }
    }

    onShadowInput(event) {
      var target = event.target;
      if (!(target instanceof Element) || target.getAttribute('data-role') !== 'composer-body') {
        return;
      }
      this._state.draft = String(target.value || '');
      this.persistSharedState();
    }

    onShadowSubmit(event) {
      var form = event.target;
      if (!(form instanceof Element) || form.getAttribute('data-role') !== 'composer-form') {
        return;
      }

      event.preventDefault();
      this.submitMessage();
    }

    submitMessage() {
      var self = this;
      var uid = this._state.uid;
      var mode = resolveMode(this.currentThreadState());
      var body = normalizeText(this._state.draft);

      if (!uid || !this._state.active || !body || this._state.sending || mode === 'READ_ONLY' || circuitIsOpen(this._state.circuit)) {
        return Promise.resolve(null);
      }

      this._state.sending = true;
      this._state.error = '';
      this._state.flash = '';
      this.render();

      return fetchJson('POST', buildApiUrl(uid, '/messages'), {
        message: {
          body: body
        }
      }).then(function (result) {
        if (!result || result.status !== 201) {
          throw new Error('Le message n’a pas été confirmé par le serveur.');
        }

        var payload = result.payload && typeof result.payload === 'object' ? result.payload : null;
        var createdMessage = payload && payload.message && typeof payload.message === 'object' ? payload.message : null;
        var nextThreadState = readThreadState(payload);

        if (!self._state.payload || typeof self._state.payload !== 'object') {
          self._state.payload = {
            messages: [],
            thread_state: nextThreadState || null
          };
        }

        if (!Array.isArray(self._state.payload.messages)) {
          self._state.payload.messages = [];
        }

        if (createdMessage) {
          self._state.payload.messages = dedupeMessages(self._state.payload.messages.concat([createdMessage]));
        }
        if (nextThreadState) {
          self._state.payload.thread_state = nextThreadState;
        }

        self._state.sending = false;
        self._state.draft = '';
        self._state.flash = 'Message envoyé.';
        self._state.error = '';
        self._state.fetchedAt = Date.now();
        self._state.circuit = resetCircuitState(self._state.circuit);
        self.persistSharedState();
        self.render();
        self.loadThread({ silent: true, force: true, manual: true });
        return null;
      }).catch(function (error) {
        self._state.sending = false;
        if (shouldThrottleOnError(error)) {
          self._state.circuit = recordCircuitFailure(self._state.circuit, error && error.status);
        }
        self._state.error = error && error.message ? String(error.message) : 'Le message n’a pas pu être envoyé.';
        self.persistSharedState();
        self.render();
        self.schedulePolling();
        return null;
      });
    }

    render() {
      this.renderFrame();
      if (!this._frame) {
        return;
      }

      var uid = this._state.uid;
      var active = this._state.active;
      var mode = resolveMode(this.currentThreadState());
      var messages = this.currentMessages();
      var unreadCount = this.currentThreadState() ? Number(this.currentThreadState().unread_count_doctor || 0) : 0;
      var unreadNote = unreadCount > 0
        ? '<p class="spu-chat-note">' + escapeHtml(String(unreadCount)) + ' nouveau(x) message(s) du patient.</p>'
        : '';
      var flash = this._state.flash
        ? '<div class="spu-chat-alert" role="status">' + escapeHtml(this._state.flash) + '</div>'
        : '';
      var error = this._state.error
        ? '<div class="spu-chat-alert spu-chat-alert--error" role="alert">' + escapeHtml(this._state.error) + '</div>'
        : '';
      var modeMessage = threadModeMessage(mode);
      var modeAlert = modeMessage
        ? '<div class="spu-chat-alert" role="status">' + escapeHtml(modeMessage) + '</div>'
        : '';
      var circuitAlert = circuitMessage(this._state.circuit)
        ? '<div class="spu-chat-alert" role="status">' + escapeHtml(circuitMessage(this._state.circuit)) + '</div>'
        : '';
      var noteAlert = '<div class="spu-chat-alert" role="status">' + escapeHtml(infoNote()) + '</div>';

      var bodyHtml = '';
      if (!uid) {
        bodyHtml = '<div class="spu-chat-alert" role="status">Référence du dossier sécurisée introuvable pour la messagerie.</div>';
      } else if (!active) {
        bodyHtml = '<div class="spu-chat-alert" role="status">Ouvrez l\'onglet Messages pour charger l\'échange sécurisé.</div>';
      } else if (this._state.loading && messages.length === 0) {
        bodyHtml = '<div class="spu-chat-panel spu-text-sm spu-text-gray-600" aria-live="polite">Chargement de la messagerie sécurisée…</div>';
      } else {
        bodyHtml = this.renderMessages(messages, mode) + this.renderComposer(mode);
      }

      this._frame.innerHTML = ''
        + '<section class="spu-chat-shell" aria-live="polite">'
        + '  <div class="spu-chat-header">'
        + '    <div>'
        + '      <h2 class="spu-chat-title">Échanges avec le patient</h2>'
        + '      <p class="spu-chat-subtitle">Espace de discussion sécurisé pour le suivi de votre dossier.</p>'
        + unreadNote
        + '    </div>'
        + '    <button type="button" class="sp-button sp-button--secondary" data-action="refresh"' + (uid && active ? '' : ' disabled') + '>' + (this._state.loading ? 'Actualisation…' : 'Actualiser') + '</button>'
        + '  </div>'
        + flash
        + error
        + circuitAlert
        + modeAlert
        + noteAlert
        + bodyHtml
        + '</section>';
    }

    renderMessages(messages, mode) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return ''
          + '<div class="spu-chat-panel">'
          + '  <div class="spu-chat-empty">'
          + '    <p class="spu-chat-empty-title">Aucun message</p>'
          + '    <p class="spu-chat-empty-body">' + escapeHtml(emptyStateMessage(mode)) + '</p>'
          + '  </div>'
          + '</div>';
      }

      var items = [];
      for (var i = 0; i < messages.length; i += 1) {
        var message = messages[i] && typeof messages[i] === 'object' ? messages[i] : {};
        var role = normalizeText(message.author_role || message.authorRole || 'patient').toUpperCase();
        var isDoctor = role === 'DOCTOR';
        var bubbleTone = isDoctor ? 'spu-bg-gray-900 spu-text-white' : 'spu-bg-gray-100 spu-text-gray-900';
        var justify = isDoctor ? 'spu-justify-end' : 'spu-justify-start';
        var align = isDoctor ? 'spu-items-end' : 'spu-items-start';
        var body = String(message.body || '');
        var createdAt = message.created_at || message.createdAt || '';

        items.push(''
          + '<article class="spu-flex ' + justify + '">'
          + '  <div class="spu-flex spu-flex-col ' + align + ' spu-gap-1 spu-max-w-85">'
          + '    <p class="spu-text-xs spu-font-semibold spu-uppercase spu-tracking-wide spu-text-gray-600">' + escapeHtml(roleLabel(role)) + '</p>'
          + '    <div class="' + bubbleTone + ' spu-rounded-2xl spu-px-4 spu-py-3 spu-text-sm spu-whitespace-pre-wrap">' + escapeHtml(body).replace(/\n/g, '<br>') + '</div>'
          + '    <p class="spu-text-xs spu-text-gray-500">' + escapeHtml(formatTimestamp(createdAt)) + '</p>'
          + '  </div>'
          + '</article>');
      }

      return ''
        + '<div class="spu-chat-panel">'
        + '  <div class="spu-thread-stack spu-max-h-chat spu-overflow-y-auto">'
        + items.join('')
        + '  </div>'
        + '</div>';
    }

    renderComposer(mode) {
      if (!this._state.active || mode === 'READ_ONLY') {
        return '';
      }

      var composerDisabled = this._state.sending || circuitIsOpen(this._state.circuit);
      var disabled = composerDisabled ? ' disabled' : '';
      var submitDisabled = composerDisabled || normalizeText(this._state.draft).length < 1;

      return ''
        + '<div class="spu-chat-panel">'
        + '  <form class="sp-form" data-role="composer-form">'
        + '    <div class="sp-field">'
        + '      <label class="sp-field__label" for="sp-doctor-chat-body">Votre message</label>'
        + '      <textarea id="sp-doctor-chat-body" class="spu-chat-textarea" rows="4" placeholder="Répondez ici au patient..." data-role="composer-body"' + disabled + '>' + escapeHtml(this._state.draft) + '</textarea>'
        + '    </div>'
        + '    <div class="spu-chat-actions spu-mt-3">'
        + '      <button type="submit" class="spu-chat-button"' + (submitDisabled ? ' disabled' : '') + '>' + (this._state.sending ? 'Envoi…' : 'Envoyer') + '</button>'
        + '    </div>'
        + '  </form>'
        + '</div>';
    }
  }

  if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, DoctorTextChatElement);
  }
})();
