(function () {
  'use strict';

  var TAG_NAME = 'sp-patient-text-chat';
  var REFRESH_EVENT = 'sp:patient-chat-refresh';
  var POLL_VISIBLE_MS = 15000;
  var POLL_HIDDEN_MS = 30000;
  var MAX_MESSAGES = 100;
  var STALE_VIEW_MS = 10000;
  var FAILURE_WINDOW_MS = 30000;
  var FAILURE_BACKOFF_MS = 15000;
  var BREAKER_THRESHOLD = 3;
  var BREAKER_COOLDOWN_MS = 60000;
  var COMPONENT_CSS_URL = resolveComponentCssUrl();
  var SHARED_STATE_BY_UID = Object.create(null);

  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof customElements === 'undefined') {
    return;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeUid(value) {
    var text = normalizeText(value);
    return /^[A-Za-z0-9_-]{4,128}$/.test(text) ? text : '';
  }

  function normalizeMode(value) {
    var mode = normalizeText(value).toUpperCase();
    if (mode === 'DOCTOR_ONLY' || mode === 'PATIENT_REPLY' || mode === 'READ_ONLY') {
      return mode;
    }
    return '';
  }

  function normalizeStatus(value) {
    return normalizeText(value).toUpperCase();
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

  function urlUid() {
    try {
      return normalizeUid(new URL(window.location.href).searchParams.get('rx_uid') || '');
    } catch (error) {
      return '';
    }
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

  function fetchJson(method, url, payload, scope, signal) {
    var nonce = restNonce();
    if (!nonce) {
      return Promise.reject(new Error('Nonce WordPress introuvable.'));
    }

    var headers = {
      'X-WP-Nonce': nonce,
      'X-Sos-Scope': scope || 'patient'
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

  function resolveMode(threadState, status) {
    var mode = normalizeMode(threadState && threadState.mode ? threadState.mode : '');
    if (mode) {
      return mode;
    }

    var normalizedStatus = normalizeStatus(status);
    if (normalizedStatus === 'APPROVED' || normalizedStatus === 'REJECTED') {
      return 'READ_ONLY';
    }

    return 'DOCTOR_ONLY';
  }

  function roleLabel(role) {
    var normalized = normalizeText(role).toUpperCase();
    return normalized === 'PATIENT' ? 'VOUS' : 'DOCTEUR';
  }

  function roleClass(role) {
    return normalizeText(role).toUpperCase() === 'PATIENT' ? 'is-patient' : 'is-doctor';
  }

  function threadModeMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'En attente d\'un message du médecin.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Vous pouvez répondre au médecin tant que la décision médicale n\'est pas rendue.';
    }
    if (mode === 'READ_ONLY') {
      return 'Décision médicale rendue. La messagerie est désormais disponible en lecture seule.';
    }
    return '';
  }

  function emptyStateMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Le médecin n\'a pas encore ouvert l\'échange. Vous pourrez répondre dès réception de son premier message.';
    }
    if (mode === 'PATIENT_REPLY') {
      return 'Aucun nouveau message pour le moment. Votre réponse apparaîtra ici après envoi.';
    }
    return 'Aucun message n\'a été échangé avant la clôture médicale de cette demande.';
  }

  function infoNote() {
    return 'Information : Cet espace est réservé exclusivement aux messages textuels. L\'envoi de documents ou de photos n\'est pas disponible ici.';
  }

  function resolveComponentCssUrl() {
    var currentScript = document.currentScript;
    var source = currentScript && currentScript.src ? String(currentScript.src) : '';

    if (!source) {
      var fallback = document.querySelector('script[src*="patient-chat-enhancements.js"]');
      source = fallback && fallback.src ? String(fallback.src) : '';
    }

    if (!source) {
      return '';
    }

    return source.replace(/patient-chat-enhancements\.js(?:\?.*)?$/i, 'patient-chat-enhancements.css');
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

  class PatientTextChatElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-rx-uid', 'data-rx-status'];
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
        status: '',
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
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
      }

      if (!this._connected) {
        this.shadowRoot.addEventListener('click', this._onShadowClick);
        this.shadowRoot.addEventListener('input', this._onShadowInput);
        this.shadowRoot.addEventListener('submit', this._onShadowSubmit);
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
        this.shadowRoot.removeEventListener('click', this._onShadowClick);
        this.shadowRoot.removeEventListener('input', this._onShadowInput);
        this.shadowRoot.removeEventListener('submit', this._onShadowSubmit);
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
      this.syncFromAttributes(name === 'data-rx-uid' || name === 'data-rx-status');
    }

    persistSharedState() {
      if (!this._state.uid) {
        return;
      }

      writeSharedState(this._state.uid, {
        draft: this._state.draft,
        payload: this._state.payload,
        fetchedAt: this._state.fetchedAt,
        circuit: this._state.circuit,
        status: this._state.status
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
      var nextUid = normalizeUid(this.getAttribute('data-rx-uid') || '') || urlUid();
      var nextStatus = normalizeStatus(this.getAttribute('data-rx-status') || '');
      var uidChanged = nextUid !== this._state.uid;
      var statusChanged = nextStatus !== this._state.status;

      if (!uidChanged && !statusChanged && !forceReload) {
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
      this._state.status = nextStatus;
      this._state.error = '';
      this._state.flash = '';

      if (!nextUid) {
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
      if (!this.shadowRoot || this._frame) {
        return;
      }

      if (COMPONENT_CSS_URL) {
        var link = document.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', COMPONENT_CSS_URL);
        this.shadowRoot.appendChild(link);
      }

      var mount = document.createElement('div');
      mount.className = 'sp-patient-chat-host';
      this.shadowRoot.appendChild(mount);
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

      if (!this.isConnected || !this._state.uid) {
        return;
      }

      if (resolveMode(this.currentThreadState(), this._state.status) === 'READ_ONLY') {
        return;
      }

      var delay = pollDelayForState(this._state.circuit);
      this._pollTimer = window.setTimeout(function () {
        self.loadThread({ silent: true });
      }, delay);
    }

    onVisibilityChange() {
      if (!this.isConnected || !this._state.uid) {
        return;
      }
      this.schedulePolling();
    }

    onRefresh() {
      if (!this.isConnected || !this._state.uid) {
        return;
      }
      this.loadThread({ manual: true, force: true });
    }

    currentMessages() {
      return readMessages(this._state.payload);
    }

    currentThreadState() {
      return readThreadState(this._state.payload);
    }

    loadThread(options) {
      var self = this;
      var opts = asObject(options || {});
      var uid = this._state.uid;

      if (!uid) {
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
      }), null, 'patient', this._abortController ? this._abortController.signal : undefined).then(function (result) {
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
      var unreadCount = threadState ? Number(threadState.unread_count_patient || 0) : 0;
      var mode = resolveMode(threadState, this._state.status);

      if (!uid || unreadCount < 1 || !Array.isArray(messages) || messages.length === 0 || mode === 'READ_ONLY' || circuitIsOpen(this._state.circuit)) {
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
      }, 'patient').then(function (result) {
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
      var mode = resolveMode(this.currentThreadState(), this._state.status);
      var body = normalizeText(this._state.draft);

      if (!uid || !body || this._state.sending || mode !== 'PATIENT_REPLY' || circuitIsOpen(this._state.circuit)) {
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
      }, 'patient').then(function (result) {
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
          self._state.payload.messages = self._state.payload.messages.concat([createdMessage]);
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
      var mode = resolveMode(this.currentThreadState(), this._state.status);
      var messages = this.currentMessages();
      var unreadCount = this.currentThreadState() ? Number(this.currentThreadState().unread_count_patient || 0) : 0;
      var headerNote = unreadCount > 0
        ? '<p class="sp-patient-chat__hint">Le médecin vous a répondu.</p>'
        : '';
      var flash = this._state.flash
        ? '<div class="sp-alert sp-alert--success" role="status">' + escapeHtml(this._state.flash) + '</div>'
        : '';
      var error = this._state.error
        ? '<div class="sp-alert sp-alert--error" role="alert">' + escapeHtml(this._state.error) + '</div>'
        : '';
      var modeMessage = threadModeMessage(mode);
      var modeAlert = modeMessage
        ? '<div class="sp-alert sp-alert--info" role="status">' + escapeHtml(modeMessage) + '</div>'
        : '';
      var circuitAlert = circuitMessage(this._state.circuit)
        ? '<div class="sp-alert sp-alert--info" role="status">' + escapeHtml(circuitMessage(this._state.circuit)) + '</div>'
        : '';
      var noteAlert = '<div class="sp-alert sp-alert--info" role="status">' + escapeHtml(infoNote()) + '</div>';

      var bodyHtml = '';
      if (!uid) {
        bodyHtml = '<div class="sp-alert sp-alert--info" role="status">Aucune demande sélectionnée pour la messagerie.</div>';
      } else if (this._state.loading && messages.length === 0) {
        bodyHtml = '<div class="sp-patient-chat__loading" aria-live="polite">Chargement de la messagerie sécurisée…</div>';
      } else {
        bodyHtml = this.renderMessages(messages, mode) + this.renderComposer(mode);
      }

      this._frame.innerHTML = ''
        + '<section class="sp-patient-chat" aria-live="polite">'
        + '  <div class="sp-patient-chat__header">'
        + '    <div class="sp-patient-chat__header-copy">'
        + '      <h2 class="sp-patient-chat__title">Échanges avec votre médecin</h2>'
        + '      <p class="sp-patient-chat__subtitle">Espace de discussion sécurisé pour le suivi de votre dossier.</p>'
        + headerNote
        + '    </div>'
        + '    <button type="button" class="sp-button sp-button--secondary" data-action="refresh"' + (uid ? '' : ' disabled') + '>' + (this._state.loading ? 'Actualisation…' : 'Actualiser') + '</button>'
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
          + '<div class="sp-patient-chat__panel">'
          + '  <div class="sp-patient-chat__empty">'
          + '    <p class="sp-patient-chat__empty-title">Aucun message</p>'
          + '    <p class="sp-patient-chat__empty-body">' + escapeHtml(emptyStateMessage(mode)) + '</p>'
          + '  </div>'
          + '</div>';
      }

      var items = [];
      for (var i = 0; i < messages.length; i += 1) {
        var message = messages[i] && typeof messages[i] === 'object' ? messages[i] : {};
        var role = normalizeText(message.author_role || message.authorRole || 'doctor');
        var body = String(message.body || '');
        var createdAt = message.created_at || message.createdAt || '';

        items.push(''
          + '<article class="sp-patient-chat__message ' + escapeHtml(roleClass(role)) + '">'
          + '  <div class="sp-patient-chat__bubble">'
          + '    <p class="sp-patient-chat__author">' + escapeHtml(roleLabel(role)) + '</p>'
          + '    <div class="sp-patient-chat__body">' + escapeHtml(body).replace(/\n/g, '<br>') + '</div>'
          + '    <p class="sp-patient-chat__meta">' + escapeHtml(formatTimestamp(createdAt)) + '</p>'
          + '  </div>'
          + '</article>');
      }

      return ''
        + '<div class="sp-patient-chat__panel">'
        + '  <div class="sp-patient-chat__messages">'
        + items.join('')
        + '  </div>'
        + '</div>';
    }

    renderComposer(mode) {
      if (mode !== 'PATIENT_REPLY') {
        return '';
      }

      var composerDisabled = this._state.sending || circuitIsOpen(this._state.circuit);
      var disabled = composerDisabled ? ' disabled' : '';
      var submitDisabled = composerDisabled || normalizeText(this._state.draft).length < 1;

      return ''
        + '<div class="sp-patient-chat__panel sp-patient-chat__composer-panel">'
        + '  <form class="sp-form sp-patient-chat__composer" data-role="composer-form">'
        + '    <div class="sp-field">'
        + '      <label class="sp-field__label" for="sp-patient-chat-body">Votre message</label>'
        + '      <textarea id="sp-patient-chat-body" class="sp-textarea sp-patient-chat__textarea" rows="4" placeholder="Répondez ici au médecin..." data-role="composer-body"' + disabled + '>' + escapeHtml(this._state.draft) + '</textarea>'
        + '    </div>'
        + '    <div class="sp-patient-chat__composer-actions">'
        + '      <button type="submit" class="sp-button sp-button--primary"' + (submitDisabled ? ' disabled' : '') + '>' + (this._state.sending ? 'Envoi en cours…' : 'Envoyer') + '</button>'
        + '    </div>'
        + '  </form>'
        + '</div>';
    }
  }

  if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, PatientTextChatElement);
  }
})();
