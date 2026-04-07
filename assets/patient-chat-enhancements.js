(function () {
  var STATE_KEY = '__spPatientMessagingV4';
  var LEGACY_SCOPE = '/wp-json/sosprescription/v1';
  var V4_SCOPE = '/wp-json/sosprescription/v4';
  var ENHANCED_ATTR = 'data-sp-enhanced';
  var PATIENT_PATH_HINT = '/espace-patient';
  var SVG_PAPERCLIP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>' +
    '</svg>';
  var SVG_SEND =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M22 2 11 13"/>' +
    '<path d="m22 2-7 20-4-9-9-4 20-7Z"/>' +
    '</svg>';

  var uiObserver = null;
  var uiObserverConnected = false;
  var uiPassScheduled = false;

  function getState() {
    if (!window[STATE_KEY]) {
      window[STATE_KEY] = {
        localIdToUid: {},
        uidToLocalId: {},
        pendingUidLookups: {},
        threadStateByUid: {},
        activeUid: normalizeUid(new URL(window.location.href).searchParams.get('rx_uid') || ''),
      };
    }
    return window[STATE_KEY];
  }

  function normalizeUid(value) {
    var uid = String(value || '').trim();
    return /^[A-Za-z0-9_-]{4,128}$/.test(uid) ? uid : '';
  }

  function normalizeLocalId(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(text)) {
      return 0;
    }
    var id = Number(text);
    return Number.isFinite(id) && id > 0 ? Math.trunc(id) : 0;
  }

  function qs(root, selector) {
    try {
      return root.querySelector(selector);
    } catch (err) {
      return null;
    }
  }

  function qsa(root, selector) {
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (err) {
      return [];
    }
  }

  function findPatientRoot() {
    return document.querySelector('#sosprescription-app[data-view="patient"]')
      || document.querySelector('#sosprescription-root-form[data-app="patient"]')
      || null;
  }

  function isPatientUiContext() {
    if (findPatientRoot()) {
      return true;
    }

    var path = String(window.location.pathname || '').toLowerCase();
    return path.indexOf(PATIENT_PATH_HINT) !== -1;
  }

  function markEnhanced(node) {
    if (!node || typeof node.setAttribute !== 'function') {
      return;
    }
    node.setAttribute(ENHANCED_ATTR, '1');
  }

  function isAlreadyEnhanced(node) {
    if (!node || typeof node.getAttribute !== 'function') {
      return false;
    }
    return node.getAttribute(ENHANCED_ATTR) === '1';
  }

  function disconnectUiObserver() {
    if (!uiObserver || !uiObserverConnected) {
      return;
    }
    uiObserver.disconnect();
    uiObserverConnected = false;
  }

  function reconnectUiObserver() {
    if (!uiObserver || !isPatientUiContext()) {
      return;
    }

    var root = findPatientRoot() || document.body;
    if (!root) {
      return;
    }

    uiObserver.observe(root, {
      childList: true,
      subtree: true,
    });
    uiObserverConnected = true;
  }

  function withUiObserverPaused(callback) {
    disconnectUiObserver();
    try {
      return callback();
    } finally {
      reconnectUiObserver();
    }
  }

  function findComposerTextarea(root) {
    var textareas = qsa(root || document, 'textarea');
    for (var i = 0; i < textareas.length; i += 1) {
      var placeholder = String(textareas[i].getAttribute('placeholder') || '').toLowerCase();
      if (placeholder.indexOf('message') !== -1) {
        return textareas[i];
      }
    }
    return null;
  }

  function findComposerRow(textarea) {
    var node = textarea;
    for (var i = 0; i < 8; i += 1) {
      if (!node || !node.parentElement) {
        break;
      }
      node = node.parentElement;
      if (!node || !node.classList) {
        continue;
      }
      if (node.classList.contains('flex') && node.classList.contains('gap-2')) {
        return node;
      }
    }
    return textarea.parentElement || null;
  }

  function findComposerCard(root) {
    var textarea = findComposerTextarea(root);
    if (!textarea) {
      return null;
    }

    var row = findComposerRow(textarea);
    var node = row;
    for (var i = 0; i < 8; i += 1) {
      if (!node || !node.parentElement) {
        break;
      }
      node = node.parentElement;
      if (!node || !node.classList) {
        continue;
      }
      if (node.classList.contains('rounded-xl') && node.classList.contains('border')) {
        return node;
      }
    }

    return row;
  }

  function ensureThreadAlert(card) {
    if (!card || !card.parentElement) {
      return null;
    }

    var alert = card.parentElement.querySelector('.sp-chat-thread-alert');
    if (alert) {
      markEnhanced(alert);
      return alert;
    }

    alert = document.createElement('div');
    alert.className = 'sp-alert sp-alert--info sp-chat-thread-alert';
    alert.setAttribute('role', 'status');
    alert.hidden = true;
    markEnhanced(alert);
    card.parentElement.insertBefore(alert, card);
    return alert;
  }

  function setLegacyComposerHintsHidden(root, hidden) {
    var candidates = qsa(root || document, 'p, div, span');
    for (var i = 0; i < candidates.length; i += 1) {
      var text = String(candidates[i].textContent || '').trim().toLowerCase();
      if (!text) {
        continue;
      }
      if (text.indexOf('vous pouvez envoyer un message à tout moment') !== -1) {
        candidates[i].hidden = !!hidden;
      }
    }
  }

  function threadMessageForMode(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Le médecin n’a pas encore ouvert cet échange. Vous pourrez répondre dès qu’un premier message vous sera adressé.';
    }
    if (mode === 'READ_ONLY') {
      return 'La messagerie est fermée car une décision médicale définitive a été rendue sur cette demande.';
    }
    return '';
  }

  function syncPatientComposer() {
    var state = getState();
    var uid = normalizeUid(state.activeUid || '');
    if (!uid) {
      return;
    }

    var threadState = state.threadStateByUid[uid];
    if (!threadState || typeof threadState !== 'object') {
      return;
    }

    var mode = String(threadState.mode || '').toUpperCase();
    if (!mode) {
      return;
    }

    var root = findPatientRoot();
    if (!root) {
      return;
    }

    var card = findComposerCard(root);
    if (!card) {
      return;
    }

    var alert = ensureThreadAlert(card);
    if (mode === 'PATIENT_REPLY') {
      card.hidden = false;
      if (alert) {
        alert.hidden = true;
        alert.textContent = '';
      }
      setLegacyComposerHintsHidden(root, false);
      return;
    }

    card.hidden = true;
    setLegacyComposerHintsHidden(root, true);
    if (alert) {
      alert.hidden = false;
      alert.textContent = threadMessageForMode(mode);
    }
  }

  function enhanceComposerUi() {
    var root = findPatientRoot();
    if (!root) {
      return;
    }

    var textarea = findComposerTextarea(root);
    if (!textarea) {
      syncPatientComposer();
      return;
    }

    if (!isAlreadyEnhanced(textarea)) {
      textarea.classList.add('sp-chat-textarea');
      markEnhanced(textarea);
    }

    var row = findComposerRow(textarea);
    if (row && row.classList && !isAlreadyEnhanced(row)) {
      row.classList.add('sp-chat-compose-premium');
      markEnhanced(row);
    }

    if (row && row.classList) {
      var attachBtn = qs(row, 'button[aria-label="Ajouter un document"]');
      if (attachBtn && !isAlreadyEnhanced(attachBtn)) {
        attachBtn.classList.add('sp-chat-attach-btn');
        attachBtn.innerHTML = SVG_PAPERCLIP;
        markEnhanced(attachBtn);
      }

      var buttons = qsa(row, 'button');
      for (var i = 0; i < buttons.length; i += 1) {
        var label = String(buttons[i].textContent || '').trim().toLowerCase();
        if (label === 'envoyer' && !isAlreadyEnhanced(buttons[i])) {
          buttons[i].classList.add('sp-chat-send');
          buttons[i].innerHTML = SVG_SEND + '<span>Envoyer</span>';
          markEnhanced(buttons[i]);
        }
      }
    }

    var card = findComposerCard(root);
    if (card && card.classList) {
      if (!isAlreadyEnhanced(card)) {
        card.classList.add('sp-chat-card');
        markEnhanced(card);
      }
      if (!qs(card, '.sp-chat-footnote')) {
        var foot = document.createElement('div');
        foot.className = 'sp-chat-footnote';
        foot.textContent = 'Échanges sécurisés et journalisés.';
        markEnhanced(foot);
        card.appendChild(foot);
      }
    }

    syncPatientComposer();
  }

  function toUrl(value) {
    try {
      if (value instanceof Request) {
        return new URL(value.url, window.location.href);
      }
      return new URL(String(value), window.location.href);
    } catch (err) {
      return null;
    }
  }

  function cloneHeaders(headersLike) {
    var out = {};
    if (!headersLike) {
      return out;
    }

    if (typeof Headers !== 'undefined' && headersLike instanceof Headers) {
      headersLike.forEach(function (value, key) {
        out[key] = value;
      });
      return out;
    }

    if (Array.isArray(headersLike)) {
      for (var i = 0; i < headersLike.length; i += 1) {
        var entry = headersLike[i];
        if (!Array.isArray(entry) || entry.length < 2) {
          continue;
        }
        out[String(entry[0])] = String(entry[1]);
      }
      return out;
    }

    if (typeof headersLike === 'object') {
      var keys = Object.keys(headersLike);
      for (var j = 0; j < keys.length; j += 1) {
        out[keys[j]] = String(headersLike[keys[j]]);
      }
    }

    return out;
  }

  function mergeHeaders(input, init) {
    var headers = {};
    if (input instanceof Request) {
      headers = cloneHeaders(input.headers);
    }
    if (init && init.headers) {
      var override = cloneHeaders(init.headers);
      var keys = Object.keys(override);
      for (var i = 0; i < keys.length; i += 1) {
        headers[keys[i]] = override[keys[i]];
      }
    }
    return headers;
  }

  function getMethod(input, init) {
    var method = init && init.method ? init.method : (input instanceof Request ? input.method : 'GET');
    return String(method || 'GET').toUpperCase();
  }

  function shallowCloneInit(input, init) {
    var out = {};
    if (input instanceof Request) {
      out.method = input.method;
      out.credentials = input.credentials;
      out.cache = input.cache;
      out.mode = input.mode;
      out.redirect = input.redirect;
      out.referrer = input.referrer;
      out.referrerPolicy = input.referrerPolicy;
      out.integrity = input.integrity;
      out.keepalive = input.keepalive;
      out.signal = input.signal;
    }
    if (init && typeof init === 'object') {
      var keys = Object.keys(init);
      for (var i = 0; i < keys.length; i += 1) {
        out[keys[i]] = init[keys[i]];
      }
    }
    return out;
  }

  function matchesLegacyListOrDetail(url, method) {
    if (!url || method !== 'GET') {
      return false;
    }
    return /\/wp-json\/sosprescription\/v1\/prescriptions(?:\/\d+)?$/.test(url.pathname);
  }

  function extractLegacyMessageRoute(url) {
    if (!url) {
      return null;
    }

    var match = url.pathname.match(/\/wp-json\/sosprescription\/v1\/prescriptions\/(\d+)\/messages(?:\/(read))?$/);
    if (!match) {
      return null;
    }

    return {
      localId: normalizeLocalId(match[1]),
      isRead: match[2] === 'read',
    };
  }

  function isLegacyArtifactInit(url, method) {
    return !!url && method === 'POST' && /\/wp-json\/sosprescription\/v1\/artifacts\/init$/.test(url.pathname);
  }

  function captureMappings(value, depth) {
    if (depth > 6 || !value) {
      return;
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        captureMappings(value[i], depth + 1);
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    var localId = normalizeLocalId(value.id);
    var uid = normalizeUid(value.uid);
    if (localId > 0 && uid) {
      var state = getState();
      state.localIdToUid[String(localId)] = uid;
      state.uidToLocalId[uid] = localId;
    }

    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j += 1) {
      captureMappings(value[keys[j]], depth + 1);
    }
  }

  function captureResponseMappings(response) {
    if (!response || typeof response.clone !== 'function') {
      return;
    }

    response.clone().json().then(function (payload) {
      captureMappings(payload, 0);
    }).catch(function () {
      return null;
    });
  }

  function recordThreadState(uid, threadState) {
    var normalizedUid = normalizeUid(uid);
    if (!normalizedUid || !threadState || typeof threadState !== 'object') {
      return;
    }

    var state = getState();
    state.threadStateByUid[normalizedUid] = threadState;
    state.activeUid = normalizedUid;
    withUiObserverPaused(function () {
      syncPatientComposer();
    });
  }

  function captureThreadStateFromResponse(uid, response) {
    if (!response || typeof response.clone !== 'function') {
      return;
    }

    response.clone().json().then(function (payload) {
      if (payload && typeof payload === 'object' && payload.thread_state && typeof payload.thread_state === 'object') {
        recordThreadState(uid, payload.thread_state);
      }
    }).catch(function () {
      return null;
    });
  }

  function resolveUidForLocalId(localId, nonceHeader, originalFetch) {
    var normalizedLocalId = normalizeLocalId(localId);
    if (normalizedLocalId < 1) {
      return Promise.resolve('');
    }

    var state = getState();
    var existing = normalizeUid(state.localIdToUid[String(normalizedLocalId)] || '');
    if (existing) {
      return Promise.resolve(existing);
    }

    if (state.pendingUidLookups[String(normalizedLocalId)]) {
      return state.pendingUidLookups[String(normalizedLocalId)];
    }

    var detailUrl = new URL(LEGACY_SCOPE + '/prescriptions/' + String(normalizedLocalId), window.location.origin);
    detailUrl.searchParams.set('_ts', String(Date.now()));

    state.pendingUidLookups[String(normalizedLocalId)] = originalFetch(detailUrl.toString(), {
      method: 'GET',
      headers: {
        'X-WP-Nonce': String(nonceHeader || ''),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      },
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) {
        return '';
      }
      return response.clone().json().then(function (payload) {
        captureMappings(payload, 0);
        return normalizeUid(getState().localIdToUid[String(normalizedLocalId)] || '');
      }).catch(function () {
        return '';
      });
    }).catch(function () {
      return '';
    }).finally(function () {
      delete getState().pendingUidLookups[String(normalizedLocalId)];
    });

    return state.pendingUidLookups[String(normalizedLocalId)];
  }

  function buildV4PrescriptionUrl(uid, suffix, sourceUrl) {
    var target = new URL(V4_SCOPE + '/prescriptions/' + encodeURIComponent(uid) + suffix, sourceUrl.origin);
    sourceUrl.searchParams.forEach(function (value, key) {
      if (key === '_ts') {
        return;
      }
      target.searchParams.append(key, value);
    });
    return target;
  }

  function rewriteMessageRequest(url, input, init, originalFetch) {
    var route = extractLegacyMessageRoute(url);
    if (!route || route.localId < 1) {
      return Promise.resolve(null);
    }

    var headers = mergeHeaders(input, init);
    var nonceHeader = headers['X-WP-Nonce'] || headers['x-wp-nonce'] || '';

    return resolveUidForLocalId(route.localId, nonceHeader, originalFetch).then(function (uid) {
      uid = normalizeUid(uid);
      if (!uid) {
        return null;
      }

      var targetUrl = buildV4PrescriptionUrl(uid, route.isRead ? '/messages/read' : '/messages', url);
      var nextInit = shallowCloneInit(input, init);
      nextInit.headers = headers;
      return {
        uid: uid,
        url: targetUrl.toString(),
        init: nextInit,
      };
    });
  }

  function parseJsonBody(init) {
    if (!init || typeof init.body !== 'string' || init.body.trim() === '') {
      return null;
    }

    try {
      return JSON.parse(init.body);
    } catch (err) {
      return null;
    }
  }

  function isMessageAttachmentInit(body) {
    if (!body || typeof body !== 'object') {
      return false;
    }

    var kind = String(body.kind || '').toUpperCase();
    var purpose = String(body.purpose || '').toLowerCase();
    return kind === 'MESSAGE_ATTACHMENT'
      || kind === 'MESSAGE'
      || kind === 'ATTACHMENT'
      || purpose === 'message'
      || purpose === 'attachment'
      || purpose === 'compose';
  }

  function rewriteArtifactInitRequest(url, input, init, originalFetch) {
    var nextInit = shallowCloneInit(input, init);
    var headers = mergeHeaders(input, init);
    var body = parseJsonBody(nextInit);
    if (!isMessageAttachmentInit(body)) {
      return Promise.resolve(null);
    }

    var localId = normalizeLocalId(body && body.prescription_id);
    if (localId < 1) {
      return Promise.resolve(null);
    }

    var nonceHeader = headers['X-WP-Nonce'] || headers['x-wp-nonce'] || '';

    return resolveUidForLocalId(localId, nonceHeader, originalFetch).then(function (uid) {
      uid = normalizeUid(uid);
      if (!uid) {
        return null;
      }

      var targetUrl = buildV4PrescriptionUrl(uid, '/messages/attachments', url);
      nextInit.headers = headers;
      nextInit.body = JSON.stringify({
        kind: 'MESSAGE_ATTACHMENT',
        purpose: 'message',
        original_name: body && body.original_name ? body.original_name : '',
        mime_type: body && body.mime_type ? body.mime_type : '',
        size_bytes: body && typeof body.size_bytes === 'number' ? body.size_bytes : Number(body && body.size_bytes ? body.size_bytes : 0),
        meta: body && body.meta && typeof body.meta === 'object' ? body.meta : undefined,
      });
      return {
        uid: uid,
        url: targetUrl.toString(),
        init: nextInit,
      };
    });
  }

  function installFetchBridge() {
    if (typeof window.fetch !== 'function' || window.fetch.__spPatientMessagingV4) {
      return;
    }

    var originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      var url = toUrl(input);
      var method = getMethod(input, init);

      if (!url) {
        return originalFetch(input, init);
      }

      if (matchesLegacyListOrDetail(url, method)) {
        return originalFetch(input, init).then(function (response) {
          captureResponseMappings(response);
          return response;
        });
      }

      var legacyMessageRoute = extractLegacyMessageRoute(url);
      if (legacyMessageRoute) {
        return rewriteMessageRequest(url, input, init, originalFetch).then(function (rewritten) {
          if (!rewritten) {
            return originalFetch(input, init).then(function (response) {
              captureResponseMappings(response);
              return response;
            });
          }

          return originalFetch(rewritten.url, rewritten.init).then(function (response) {
            captureThreadStateFromResponse(rewritten.uid, response);
            return response;
          });
        });
      }

      if (isLegacyArtifactInit(url, method)) {
        return rewriteArtifactInitRequest(url, input, init, originalFetch).then(function (rewritten) {
          if (!rewritten) {
            return originalFetch(input, init);
          }
          return originalFetch(rewritten.url, rewritten.init);
        });
      }

      return originalFetch(input, init);
    };

    window.fetch.__spPatientMessagingV4 = true;
  }

  function nodeContainsRelevantUi(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    if (isAlreadyEnhanced(node)) {
      return false;
    }

    if (node.matches('#sosprescription-root-form[data-app="patient"]')) {
      return true;
    }

    if (node.matches('textarea')) {
      var placeholder = String(node.getAttribute('placeholder') || '').toLowerCase();
      if (placeholder.indexOf('message') !== -1) {
        return true;
      }
    }

    if (node.matches('button[aria-label="Ajouter un document"]')) {
      return true;
    }

    if (node.matches('.flex.items-end.gap-2, .rounded-xl.border')) {
      return true;
    }

    return !!qs(node, 'textarea, button[aria-label="Ajouter un document"], .flex.items-end.gap-2, .rounded-xl.border');
  }

  function shouldProcessMutations(mutations) {
    if (!mutations || !mutations.length || !isPatientUiContext()) {
      return false;
    }

    for (var i = 0; i < mutations.length; i += 1) {
      var mutation = mutations[i];
      if (!mutation || mutation.type !== 'childList') {
        continue;
      }

      if (nodeContainsRelevantUi(mutation.target)) {
        return true;
      }

      var addedNodes = mutation.addedNodes || [];
      for (var j = 0; j < addedNodes.length; j += 1) {
        if (nodeContainsRelevantUi(addedNodes[j])) {
          return true;
        }
      }

      var removedNodes = mutation.removedNodes || [];
      for (var k = 0; k < removedNodes.length; k += 1) {
        if (nodeContainsRelevantUi(removedNodes[k])) {
          return true;
        }
      }
    }

    return false;
  }

  function runUiPass() {
    uiPassScheduled = false;
    if (!isPatientUiContext()) {
      disconnectUiObserver();
      return;
    }

    withUiObserverPaused(function () {
      enhanceComposerUi();
    });
  }

  function scheduleUiPass() {
    if (uiPassScheduled || !isPatientUiContext()) {
      return;
    }

    uiPassScheduled = true;
    var schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : function (callback) { return window.setTimeout(callback, 16); };

    schedule(runUiPass);
  }

  function installUiObserver() {
    if (!isPatientUiContext()) {
      return;
    }

    if (!uiObserver) {
      uiObserver = new MutationObserver(function (mutations) {
        if (!shouldProcessMutations(mutations)) {
          return;
        }
        scheduleUiPass();
      });
    }

    reconnectUiObserver();
  }

  function boot() {
    installFetchBridge();
    if (!isPatientUiContext()) {
      return;
    }
    enhanceComposerUi();
    installUiObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
