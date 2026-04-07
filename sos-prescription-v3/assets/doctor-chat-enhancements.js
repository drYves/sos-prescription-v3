(function () {
  'use strict';

  var TAG_NAME = 'sp-doctor-text-chat';
  var PANEL_SELECTOR = '.dc-detail-panel[data-dc-panel="messages"]';
  var DETAIL_SELECTOR = '.dc-detail-pane[data-case-id]';
  var POLL_VISIBLE_MS = 15000;
  var POLL_HIDDEN_MS = 30000;
  var MAX_MESSAGES = 100;
  var REFRESH_EVENT = 'sp:doctor-chat-refresh';
  var ENHANCED_ATTR = 'data-sp-enhanced';
  var UID_ATTR = 'data-sp-rx-uid';
  var LOCAL_ID_ATTR = 'data-sp-local-id';
  var ACTIVE_ATTR = 'data-sp-chat-active';
  var OWNED_ATTR = 'data-sp-chat-owned';
  var OWNED_PANEL_SELECTOR = PANEL_SELECTOR + '[' + OWNED_ATTR + '="1"]';
  var COMPONENT_CSS_URL = resolveComponentCssUrl();
  var LEGACY_UID_BY_ID = Object.create(null);
  var CHAT_STATE_BY_UID = Object.create(null);

  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof customElements === 'undefined') {
    return;
  }

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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cloneValue(value) {
    try {
      return JSON.parse(JSON.stringify(value == null ? null : value));
    } catch (error) {
      return value;
    }
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

  function resolveComponentCssUrl() {
    var currentScript = document.currentScript;
    var source = currentScript && currentScript.src ? String(currentScript.src) : '';

    if (!source) {
      var fallback = document.querySelector('script[src*="doctor-chat-enhancements.js"]');
      source = fallback && fallback.src ? String(fallback.src) : '';
    }

    if (!source) {
      return '';
    }

    return source.replace(/doctor-chat-enhancements\.js(?:\?.*)?$/i, 'doctor-chat-enhancements.css');
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

  function fetchJson(method, url, payload) {
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
      cache: 'no-store'
    };

    if (init.method === 'GET') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers.Pragma = 'no-cache';
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload || {});
    }

    return fetch(url, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          data = null;
        }

        if (!response.ok) {
          var message = data && typeof data.message === 'string'
            ? data.message
            : data && typeof data.code === 'string'
              ? data.code
              : 'Erreur de messagerie';
          var err = new Error(message);
          err.status = response.status;
          err.payload = data;
          throw err;
        }

        return {
          status: response.status,
          payload: data
        };
      });
    });
  }

  function formatTimestamp(value) {
    var text = normalizeText(value);
    if (!text) {
      return '';
    }

    try {
      var date = new Date(text);
      if (Number.isNaN(date.getTime())) {
        return text;
      }
      return new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date);
    } catch (error) {
      return text;
    }
  }

  function resolveMode(threadState) {
    var mode = normalizeMode(threadState && threadState.mode ? threadState.mode : '');
    return mode || 'DOCTOR_ONLY';
  }

  function roleLabel(role) {
    return normalizeText(role).toUpperCase() === 'DOCTOR' ? 'Vous' : 'Patient';
  }

  function roleClass(role) {
    return normalizeText(role).toUpperCase() === 'DOCTOR' ? 'is-doctor' : 'is-patient';
  }

  function threadModeMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Vous pouvez ouvrir l’échange si une information complémentaire est nécessaire.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Le patient peut répondre dans son espace sécurisé tant que la décision médicale n’est pas rendue.';
    }
    if (mode === 'READ_ONLY') {
      return 'Décision médicale rendue. La messagerie est désormais verrouillée en lecture seule.';
    }
    return '';
  }

  function emptyStateMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Aucun message pour le moment. Vous pouvez envoyer la première demande d’information au patient.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Aucun nouveau message du patient pour le moment.';
    }
    return 'Aucun message n’a été échangé avant la clôture médicale de cette demande.';
  }

  function composerHelp(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Messagerie 100% textuelle. Votre premier message ouvrira la réponse côté patient.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Messagerie 100% textuelle. Aucun document ne peut être joint dans cet échange.';
    }
    return '';
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
    var candidate = normalizeUid(
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
    return candidate;
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
      if (localId > 0 && uid) {
        if (LEGACY_UID_BY_ID[localId] !== uid) {
          LEGACY_UID_BY_ID[localId] = uid;
          changed = true;
        }
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

  var observer = null;
  var observerRoot = null;
  var enhanceTimer = 0;

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

  function isOwnedPanel(node) {
    return node instanceof HTMLElement
      && node.matches(PANEL_SELECTOR)
      && node.getAttribute(OWNED_ATTR) === '1';
  }

  function isShieldedPanel(node) {
    return isOwnedPanel(node) && !!node.shadowRoot;
  }

  function closestShieldedPanel(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    var panel = node.closest(OWNED_PANEL_SELECTOR);
    return isShieldedPanel(panel) ? panel : null;
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

      if (target && (isShieldedPanel(target) || closestShieldedPanel(target))) {
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
    }, 60);
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

    if (panel.__spDoctorChatHost instanceof HTMLElement && panel.__spDoctorChatHost.isConnected) {
      panel.setAttribute(OWNED_ATTR, '1');
      return panel.__spDoctorChatHost;
    }

    var root = panel.shadowRoot || null;
    if (!root && typeof panel.attachShadow === 'function') {
      while (panel.firstChild) {
        panel.removeChild(panel.firstChild);
      }

      try {
        root = panel.attachShadow({ mode: 'open' });
      } catch (error) {
        root = panel.shadowRoot || null;
      }
    }

    if (!root) {
      return null;
    }

    var host = root.querySelector('[data-sp-chat-host="1"]');
    if (!(host instanceof HTMLElement)) {
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      host = document.createElement('div');
      host.setAttribute('data-sp-chat-host', '1');
      root.appendChild(host);
    }

    panel.__spDoctorChatHost = host;
    panel.setAttribute(OWNED_ATTR, '1');
    return host;
  }

  function ensurePanelComponent(panel) {
    if (!(panel instanceof HTMLElement)) {
      return null;
    }

    var host = ensurePanelHost(panel);
    if (host) {
      var shadowElement = host.querySelector(TAG_NAME);
      if (shadowElement instanceof HTMLElement) {
        return shadowElement;
      }
      shadowElement = document.createElement(TAG_NAME);
      host.appendChild(shadowElement);
      return shadowElement;
    }

    var fallbackElement = panel.querySelector(TAG_NAME);
    if (fallbackElement instanceof HTMLElement) {
      panel.setAttribute(OWNED_ATTR, '1');
      return fallbackElement;
    }

    panel.innerHTML = '';
    fallbackElement = document.createElement(TAG_NAME);
    panel.appendChild(fallbackElement);
    panel.setAttribute(OWNED_ATTR, '1');
    return fallbackElement;
  }

  function syncPanelComponent(element, uid, localId, active) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    var normalizedUid = normalizeUid(uid);
    var normalizedLocalId = normalizeLocalId(localId);
    var nextActive = active ? '1' : '0';

    if (element.getAttribute('data-rx-uid') !== normalizedUid) {
      element.setAttribute('data-rx-uid', normalizedUid);
    }
    if (element.getAttribute('data-local-id') !== String(normalizedLocalId)) {
      element.setAttribute('data-local-id', String(normalizedLocalId));
    }
    if (element.getAttribute('data-active') !== nextActive) {
      element.setAttribute('data-active', nextActive);
    }
  }

  function enhancePanel(panel) {
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    var detailPane = panel.closest(DETAIL_SELECTOR);
    var localId = normalizeLocalId(detailPane && detailPane.getAttribute('data-case-id'));
    var active = panel.classList.contains('is-active');
    var mappedUid = localId > 0 ? normalizeUid(LEGACY_UID_BY_ID[localId]) : '';
    var currentUid = normalizeUid(panel.getAttribute(UID_ATTR));
    var uid = mappedUid || currentUid || '';

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
  }

  function readSharedState(uid) {
    var key = normalizeUid(uid);
    return key ? asObject(CHAT_STATE_BY_UID[key]) : {};
  }

  function writeSharedState(uid, nextState) {
    var key = normalizeUid(uid);
    if (!key) {
      return;
    }
    CHAT_STATE_BY_UID[key] = asObject(nextState);
  }

  function DoctorTextChatElement() {
    return Reflect.construct(HTMLElement, [], DoctorTextChatElement);
  }

  DoctorTextChatElement.prototype = Object.create(HTMLElement.prototype);
  DoctorTextChatElement.prototype.constructor = DoctorTextChatElement;
  Object.setPrototypeOf(DoctorTextChatElement, HTMLElement);

  DoctorTextChatElement.observedAttributes = ['data-rx-uid', 'data-local-id', 'data-active'];

  DoctorTextChatElement.prototype.connectedCallback = function () {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    if (!this._booted) {
      this._booted = true;
      this._state = {
        uid: '',
        localId: 0,
        active: false,
        loading: false,
        sending: false,
        error: '',
        flash: '',
        draft: '',
        payload: null,
        fetchedAt: 0
      };
      this._requestSeq = 0;
      this._pollTimer = 0;
      this._abortController = null;
      this._frame = null;
      this._onShadowClick = this.onShadowClick.bind(this);
      this._onShadowInput = this.onShadowInput.bind(this);
      this._onShadowSubmit = this.onShadowSubmit.bind(this);
      this._onVisibilityChange = this.onVisibilityChange.bind(this);
      this._onRefresh = this.onRefresh.bind(this);

      this.shadowRoot.addEventListener('click', this._onShadowClick);
      this.shadowRoot.addEventListener('input', this._onShadowInput);
      this.shadowRoot.addEventListener('submit', this._onShadowSubmit);
    }

    if (!this._globalListenersBound) {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
      window.addEventListener(REFRESH_EVENT, this._onRefresh);
      this._globalListenersBound = true;
    }

    this.renderFrame();
    this.syncFromAttributes(false);
  };

  DoctorTextChatElement.prototype.disconnectedCallback = function () {
    this.persistSharedState();
    this.stopPolling();
    this.abortPending();

    if (this._globalListenersBound) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      window.removeEventListener(REFRESH_EVENT, this._onRefresh);
      this._globalListenersBound = false;
    }
  };

  DoctorTextChatElement.prototype.attributeChangedCallback = function (name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) {
      return;
    }

    if (name === 'data-rx-uid') {
      this.syncFromAttributes(true);
      return;
    }

    this.syncFromAttributes(false);
  };

  DoctorTextChatElement.prototype.abortPending = function () {
    if (this._abortController && typeof this._abortController.abort === 'function') {
      try {
        this._abortController.abort();
      } catch (error) {
        return null;
      }
    }
    this._abortController = null;
    return null;
  };

  DoctorTextChatElement.prototype.stopPolling = function () {
    if (this._pollTimer) {
      window.clearTimeout(this._pollTimer);
      this._pollTimer = 0;
    }
  };

  DoctorTextChatElement.prototype.schedulePolling = function () {
    var self = this;
    this.stopPolling();
    if (!this.isConnected || !this._state.uid || !this._state.active) {
      return;
    }

    var delay = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    this._pollTimer = window.setTimeout(function () {
      self.loadThread({ silent: true });
    }, delay);
  };

  DoctorTextChatElement.prototype.onVisibilityChange = function () {
    if (!this.isConnected || !this._state.uid || !this._state.active) {
      return;
    }
    this.schedulePolling();
  };

  DoctorTextChatElement.prototype.onRefresh = function () {
    if (!this.isConnected || !this._state.uid || !this._state.active) {
      return;
    }
    this.loadThread({ silent: true, force: true });
  };

  DoctorTextChatElement.prototype.restoreSharedState = function (uid) {
    var shared = readSharedState(uid);
    if (!shared || typeof shared !== 'object') {
      return;
    }

    this._state.payload = shared.payload && typeof shared.payload === 'object' ? cloneValue(shared.payload) : null;
    this._state.draft = normalizeText(shared.draft || '') === '' ? String(shared.draft || '') : String(shared.draft || '');
    this._state.fetchedAt = Number(shared.fetchedAt || 0);
  };

  DoctorTextChatElement.prototype.persistSharedState = function () {
    var uid = this._state && this._state.uid ? this._state.uid : '';
    if (!uid) {
      return;
    }

    writeSharedState(uid, {
      payload: this._state.payload && typeof this._state.payload === 'object' ? cloneValue(this._state.payload) : null,
      draft: String(this._state.draft || ''),
      fetchedAt: Number(this._state.fetchedAt || 0)
    });
  };

  DoctorTextChatElement.prototype.syncFromAttributes = function (forceReload) {
    var nextUid = normalizeUid(this.getAttribute('data-rx-uid') || '');
    var nextLocalId = normalizeLocalId(this.getAttribute('data-local-id') || 0);
    var nextActive = String(this.getAttribute('data-active') || '') === '1';

    var uidChanged = nextUid !== this._state.uid;
    var localIdChanged = nextLocalId !== this._state.localId;
    var activeChanged = nextActive !== this._state.active;

    if (!uidChanged && !localIdChanged && !activeChanged && !forceReload) {
      return;
    }

    if (uidChanged) {
      this.persistSharedState();
      this._state.payload = null;
      this._state.draft = '';
      this._state.fetchedAt = 0;
      this.restoreSharedState(nextUid);
    }

    this._state.uid = nextUid;
    this._state.localId = nextLocalId;
    this._state.active = nextActive;
    this._state.error = '';
    this._state.flash = '';

    if (!nextUid) {
      this.stopPolling();
      this.abortPending();
      this.render();
      return;
    }

    if (!nextActive) {
      this.stopPolling();
      this.abortPending();
      this.persistSharedState();
      this.render();
      return;
    }

    if (this._state.payload && !forceReload) {
      this.render();
      this.markReadIfNeeded();
      if (Date.now() - Number(this._state.fetchedAt || 0) < 5000) {
        this.schedulePolling();
        return;
      }
      this.loadThread({ silent: true });
      return;
    }

    this.loadThread({ force: !!forceReload });
  };

  DoctorTextChatElement.prototype.renderFrame = function () {
    if (!this.shadowRoot) {
      return;
    }

    if (!this._frame) {
      var link = document.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      if (COMPONENT_CSS_URL) {
        link.setAttribute('href', COMPONENT_CSS_URL);
      }

      var mount = document.createElement('div');
      mount.className = 'sp-doctor-chat-host';

      this.shadowRoot.appendChild(link);
      this.shadowRoot.appendChild(mount);
      this._frame = mount;
    }
  };

  DoctorTextChatElement.prototype.loadThread = function (options) {
    var self = this;
    var opts = options && typeof options === 'object' ? options : {};
    var uid = this._state.uid;

    if (!uid || !this._state.active) {
      return Promise.resolve(null);
    }

    this.stopPolling();
    this.abortPending();

    var seq = (this._requestSeq || 0) + 1;
    this._requestSeq = seq;

    if (!opts.silent) {
      this._state.loading = true;
      this._state.error = '';
      this.render();
    }

    if (typeof AbortController !== 'undefined') {
      this._abortController = new AbortController();
    }

    var url = buildApiUrl(uid, '/messages', {
      limit: MAX_MESSAGES,
      _ts: Date.now()
    });
    var nonce = restNonce();
    if (!nonce) {
      this._state.loading = false;
      this._state.error = 'Nonce WordPress introuvable.';
      this.render();
      return Promise.resolve(null);
    }

    return fetch(url, {
      method: 'GET',
      headers: {
        'X-WP-Nonce': nonce,
        'X-Sos-Scope': 'doctor',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this._abortController ? this._abortController.signal : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          data = null;
        }

        if (!response.ok) {
          var message = data && typeof data.message === 'string'
            ? data.message
            : 'Impossible de charger la messagerie sécurisée.';
          var err = new Error(message);
          err.status = response.status;
          throw err;
        }

        if (seq !== self._requestSeq) {
          return null;
        }

        self._state.payload = data && typeof data === 'object' ? data : {
          messages: [],
          thread_state: null
        };
        self._state.loading = false;
        self._state.error = '';
        self._state.fetchedAt = Date.now();
        self.persistSharedState();
        self.render();
        self.schedulePolling();
        self.markReadIfNeeded();
        return self._state.payload;
      });
    }).catch(function (error) {
      if (error && (error.name === 'AbortError' || error.code === 20)) {
        return null;
      }

      if (seq !== self._requestSeq) {
        return null;
      }

      self._state.loading = false;
      self._state.error = error && error.message ? String(error.message) : 'Impossible de charger la messagerie sécurisée.';
      self.render();
      self.schedulePolling();
      return null;
    });
  };

  DoctorTextChatElement.prototype.markReadIfNeeded = function () {
    var payload = this._state.payload;
    var uid = this._state.uid;
    if (!uid || !payload || typeof payload !== 'object' || !this._state.active) {
      return;
    }

    var threadState = payload.thread_state && typeof payload.thread_state === 'object' ? payload.thread_state : null;
    var unreadCount = threadState ? Number(threadState.unread_count_doctor || 0) : 0;
    var lastMessageSeq = threadState ? Number(threadState.last_message_seq || 0) : 0;

    if (unreadCount < 1 || lastMessageSeq < 1) {
      return;
    }

    fetchJson('POST', buildApiUrl(uid, '/messages/read'), {
      read_upto_seq: lastMessageSeq
    }).then(function (result) {
      if (!result || !result.payload || typeof result.payload !== 'object') {
        return null;
      }
      var nextThreadState = result.payload.thread_state && typeof result.payload.thread_state === 'object'
        ? result.payload.thread_state
        : null;
      if (!nextThreadState || !payload || payload !== this._state.payload) {
        return null;
      }
      this._state.payload.thread_state = nextThreadState;
      this._state.fetchedAt = Date.now();
      this.persistSharedState();
      this.render();
      return null;
    }.bind(this)).catch(function () {
      return null;
    });
  };

  DoctorTextChatElement.prototype.onShadowClick = function (event) {
    var button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!button) {
      return;
    }

    var action = normalizeText(button.getAttribute('data-action'));
    if (action === 'refresh') {
      event.preventDefault();
      if (!this._state.loading) {
        this.loadThread({ force: true });
      }
    }
  };

  DoctorTextChatElement.prototype.onShadowInput = function (event) {
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.getAttribute('data-role') !== 'composer-body') {
      return;
    }
    this._state.draft = String(target.value || '');
    this.persistSharedState();
    this.syncComposerState();
  };

  DoctorTextChatElement.prototype.onShadowSubmit = function (event) {
    var form = event.target;
    if (!(form instanceof Element) || form.getAttribute('data-role') !== 'composer-form') {
      return;
    }

    event.preventDefault();
    this.submitMessage();
  };

  DoctorTextChatElement.prototype.submitMessage = function () {
    var self = this;
    var uid = this._state.uid;
    var body = String(this._state.draft || '').trim();
    var mode = resolveMode(this.currentThreadState());

    if (!uid || !body || this._state.sending || !this._state.active || mode === 'READ_ONLY') {
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
      var nextThreadState = payload && payload.thread_state && typeof payload.thread_state === 'object' ? payload.thread_state : null;

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
        self._state.payload.messages = self._state.payload.messages.concat([createdMessage]);
      }
      if (nextThreadState) {
        self._state.payload.thread_state = nextThreadState;
      }

      self._state.draft = '';
      self._state.sending = false;
      self._state.flash = 'Message envoyé.';
      self._state.fetchedAt = Date.now();
      self.persistSharedState();
      self.render();
      self.loadThread({ silent: true, force: true });
      return null;
    }).catch(function (error) {
      self._state.sending = false;
      self._state.error = error && error.message ? String(error.message) : 'Le message n’a pas pu être envoyé.';
      self.persistSharedState();
      self.render();
      return null;
    });
  };

  DoctorTextChatElement.prototype.currentThreadState = function () {
    var payload = this._state.payload;
    return payload && typeof payload === 'object' && payload.thread_state && typeof payload.thread_state === 'object'
      ? payload.thread_state
      : null;
  };

  DoctorTextChatElement.prototype.currentMessages = function () {
    var payload = this._state.payload;
    return payload && typeof payload === 'object' && Array.isArray(payload.messages)
      ? payload.messages
      : [];
  };

  DoctorTextChatElement.prototype.syncComposerState = function () {
    if (!this.shadowRoot) {
      return;
    }

    var submitButton = this.shadowRoot.querySelector('[data-role="composer-submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = this._state.sending
        || normalizeText(this._state.draft).length < 1
        || !this._state.active
        || resolveMode(this.currentThreadState()) === 'READ_ONLY';
      submitButton.textContent = this._state.sending ? 'Envoi en cours…' : 'Envoyer';
    }
  };

  DoctorTextChatElement.prototype.render = function () {
    if (!this._frame) {
      this.renderFrame();
    }
    if (!this._frame) {
      return;
    }

    var uid = this._state.uid;
    var mode = resolveMode(this.currentThreadState());
    var messages = this.currentMessages();
    var flash = this._state.flash ? '<div class="sp-alert sp-alert--success" role="status">' + escapeHtml(this._state.flash) + '</div>' : '';
    var error = this._state.error ? '<div class="sp-alert sp-alert--error" role="alert">' + escapeHtml(this._state.error) + '</div>' : '';
    var modeMessage = threadModeMessage(mode);
    var modeAlert = modeMessage ? '<div class="sp-alert sp-alert--info" role="status">' + escapeHtml(modeMessage) + '</div>' : '';
    var unreadCount = this.currentThreadState() ? Number(this.currentThreadState().unread_count_doctor || 0) : 0;
    var unreadNote = unreadCount > 0 ? '<p class="sp-doctor-chat__hint">' + escapeHtml(String(unreadCount)) + ' message(s) du patient à acquitter.</p>' : '';

    var bodyHtml = '';

    if (!uid) {
      bodyHtml = '<div class="sp-alert sp-alert--info" role="status">Référence du dossier sécurisée introuvable pour la messagerie.</div>';
    } else if (!this._state.active) {
      bodyHtml = '<div class="sp-alert sp-alert--info" role="status">Ouvrez l’onglet Messages pour charger l’échange sécurisé.</div>';
    } else if (this._state.loading && messages.length === 0) {
      bodyHtml = '<div class="sp-doctor-chat__loading" aria-live="polite">Chargement de la messagerie sécurisée…</div>';
    } else {
      bodyHtml = this.renderMessages(messages, mode) + this.renderComposer(mode);
    }

    this._frame.innerHTML = ''
      + '<section class="sp-doctor-chat" aria-live="polite">'
      + '  <div class="sp-doctor-chat__header">'
      + '    <div class="sp-doctor-chat__header-copy">'
      + '      <h2 class="sp-doctor-chat__title">Messagerie sécurisée</h2>'
      + '      <p class="sp-doctor-chat__subtitle">Échange textuel asynchrone avec le patient.</p>'
      + unreadNote
      + '    </div>'
      + '    <button type="button" class="sp-button sp-button--secondary" data-action="refresh"' + (uid && this._state.active ? '' : ' disabled') + '>' + (this._state.loading ? 'Actualisation…' : 'Rafraîchir') + '</button>'
      + '  </div>'
      + flash
      + error
      + modeAlert
      + bodyHtml
      + '</section>';
  };

  DoctorTextChatElement.prototype.renderMessages = function (messages, mode) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return ''
        + '<div class="sp-doctor-chat__panel">'
        + '  <div class="sp-doctor-chat__empty">'
        + '    <p class="sp-doctor-chat__empty-title">Aucun message</p>'
        + '    <p class="sp-doctor-chat__empty-body">' + escapeHtml(emptyStateMessage(mode)) + '</p>'
        + '  </div>'
        + '</div>';
    }

    var items = [];
    for (var i = 0; i < messages.length; i += 1) {
      var message = messages[i] && typeof messages[i] === 'object' ? messages[i] : {};
      var role = normalizeText(message.author_role || 'patient');
      items.push(''
        + '<article class="sp-doctor-chat__message ' + escapeHtml(roleClass(role)) + '">'
        + '  <div class="sp-doctor-chat__bubble">'
        + '    <p class="sp-doctor-chat__author">' + escapeHtml(roleLabel(role)) + '</p>'
        + '    <div class="sp-doctor-chat__body">' + escapeHtml(String(message.body || '')).replace(/\n/g, '<br>') + '</div>'
        + '    <p class="sp-doctor-chat__meta">' + escapeHtml(formatTimestamp(message.created_at || '')) + '</p>'
        + '  </div>'
        + '</article>');
    }

    return ''
      + '<div class="sp-doctor-chat__panel">'
      + '  <div class="sp-doctor-chat__messages">'
      + items.join('')
      + '  </div>'
      + '</div>';
  };

  DoctorTextChatElement.prototype.renderComposer = function (mode) {
    if (!this._state.active || mode === 'READ_ONLY') {
      return '';
    }

    var disabled = this._state.sending ? ' disabled' : '';
    var help = composerHelp(mode);

    return ''
      + '<div class="sp-doctor-chat__panel sp-doctor-chat__composer-panel">'
      + '  <form class="sp-form sp-doctor-chat__composer" data-role="composer-form">'
      + '    <div class="sp-field">'
      + '      <label class="sp-field__label" for="sp-doctor-chat-body">Votre message</label>'
      + '      <textarea id="sp-doctor-chat-body" class="sp-textarea sp-doctor-chat__textarea" rows="4" placeholder="Écrivez votre message au patient…" data-role="composer-body"' + disabled + '>' + escapeHtml(this._state.draft) + '</textarea>'
      + (help ? '      <p class="sp-field__help">' + escapeHtml(help) + '</p>' : '')
      + '    </div>'
      + '    <div class="sp-doctor-chat__composer-actions">'
      + '      <button type="submit" class="sp-button sp-button--primary" data-role="composer-submit"' + (this._state.sending || String(this._state.draft || '').trim() === '' ? ' disabled' : '') + '>' + (this._state.sending ? 'Envoi en cours…' : 'Envoyer') + '</button>'
      + '    </div>'
      + '  </form>'
      + '</div>';
  };

  if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, DoctorTextChatElement);
  }
})();
