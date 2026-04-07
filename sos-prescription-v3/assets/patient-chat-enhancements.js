(function () {
  'use strict';

  var TAG_NAME = 'sp-patient-text-chat';
  var REFRESH_EVENT = 'sp:patient-chat-refresh';
  var POLL_VISIBLE_MS = 15000;
  var POLL_HIDDEN_MS = 30000;
  var MAX_MESSAGES = 100;
  var COMPONENT_CSS_URL = resolveComponentCssUrl();

  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof customElements === 'undefined') {
    return;
  }

  function normalizeUid(value) {
    var text = String(value || '').trim();
    return /^[A-Za-z0-9_-]{4,128}$/.test(text) ? text : '';
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeMode(value) {
    var mode = normalizeText(value).toUpperCase();
    if (mode === 'PATIENT_REPLY' || mode === 'READ_ONLY' || mode === 'DOCTOR_ONLY') {
      return mode;
    }
    return '';
  }

  function normalizeStatus(value) {
    return normalizeText(value).toUpperCase();
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
    var base = normalizeText(cfg && cfg.restV4Base ? cfg.restV4Base : '');
    if (base) {
      return base.replace(/\/$/, '');
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
    } catch (err) {
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

  function fetchJson(method, url, payload, scope) {
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
        } catch (err) {
          data = null;
        }

        if (!response.ok) {
          var message = data && typeof data.message === 'string'
            ? data.message
            : data && typeof data.code === 'string'
              ? data.code
              : 'Erreur messagerie';
          var error = new Error(message);
          error.status = response.status;
          error.payload = data;
          throw error;
        }

        return {
          status: response.status,
          payload: data
        };
      });
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
    return normalized === 'PATIENT' ? 'Vous' : 'Médecin';
  }

  function roleClass(role) {
    return normalizeText(role).toUpperCase() === 'PATIENT' ? 'is-patient' : 'is-doctor';
  }

  function threadModeMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'En attente d’un message du médecin.';
    }
    if (mode === 'READ_ONLY') {
      return 'Décision médicale rendue. La messagerie est désormais verrouillée en lecture seule.';
    }
    return '';
  }

  function emptyStateMessage(mode) {
    if (mode === 'DOCTOR_ONLY') {
      return 'Le médecin n’a pas encore ouvert l’échange. Vous pourrez répondre dès réception de son premier message.';
    }
    if (mode === 'READ_ONLY') {
      return 'Aucun message n’a été échangé avant la clôture médicale de cette demande.';
    }
    return 'Aucun message pour le moment. Votre réponse apparaîtra ici après envoi.';
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

  function PatientTextChatElement() {
    return Reflect.construct(HTMLElement, [], PatientTextChatElement);
  }

  PatientTextChatElement.prototype = Object.create(HTMLElement.prototype);
  PatientTextChatElement.prototype.constructor = PatientTextChatElement;
  Object.setPrototypeOf(PatientTextChatElement, HTMLElement);

  PatientTextChatElement.observedAttributes = ['data-rx-uid', 'data-rx-status'];

  PatientTextChatElement.prototype.connectedCallback = function () {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    if (!this._booted) {
      this._booted = true;
      this._state = {
        uid: '',
        status: '',
        loading: false,
        sending: false,
        error: '',
        flash: '',
        draft: '',
        payload: null
      };
      this._requestSeq = 0;
      this._pollTimer = 0;
      this._abortController = null;
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
    this.syncFromAttributes(true);
  };

  PatientTextChatElement.prototype.disconnectedCallback = function () {
    this.stopPolling();
    this.abortPending();
    if (this._globalListenersBound) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      window.removeEventListener(REFRESH_EVENT, this._onRefresh);
      this._globalListenersBound = false;
    }
  };

  PatientTextChatElement.prototype.attributeChangedCallback = function (name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) {
      return;
    }
    this.syncFromAttributes(name === 'data-rx-uid');
  };

  PatientTextChatElement.prototype.abortPending = function () {
    if (this._abortController && typeof this._abortController.abort === 'function') {
      try {
        this._abortController.abort();
      } catch (err) {
        return null;
      }
    }
    this._abortController = null;
    return null;
  };

  PatientTextChatElement.prototype.stopPolling = function () {
    if (this._pollTimer) {
      window.clearTimeout(this._pollTimer);
      this._pollTimer = 0;
    }
  };

  PatientTextChatElement.prototype.schedulePolling = function () {
    var self = this;
    this.stopPolling();
    if (!this.isConnected || !this._state.uid) {
      return;
    }

    var delay = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    this._pollTimer = window.setTimeout(function () {
      self.loadThread({ silent: true });
    }, delay);
  };

  PatientTextChatElement.prototype.onVisibilityChange = function () {
    if (!this.isConnected || !this._state.uid) {
      return;
    }
    this.schedulePolling();
  };

  PatientTextChatElement.prototype.onRefresh = function () {
    if (!this.isConnected || !this._state.uid) {
      return;
    }
    this.loadThread({ silent: true, force: true });
  };

  PatientTextChatElement.prototype.syncFromAttributes = function (forceReload) {
    var nextUid = normalizeUid(this.getAttribute('data-rx-uid') || '') || urlUid();
    var nextStatus = normalizeStatus(this.getAttribute('data-rx-status') || '');
    var uidChanged = nextUid !== this._state.uid;
    var statusChanged = nextStatus !== this._state.status;

    if (!uidChanged && !statusChanged && !forceReload) {
      return;
    }

    this._state.uid = nextUid;
    this._state.status = nextStatus;
    this._state.error = '';
    this._state.flash = '';

    if (uidChanged) {
      this._state.draft = '';
      this._state.payload = null;
    }

    if (!nextUid) {
      this.stopPolling();
      this.abortPending();
      this.render();
      return;
    }

    this.loadThread({ force: true });
  };

  PatientTextChatElement.prototype.renderFrame = function () {
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
      mount.className = 'sp-patient-chat-host';

      this.shadowRoot.appendChild(link);
      this.shadowRoot.appendChild(mount);
      this._frame = mount;
    }
  };

  PatientTextChatElement.prototype.loadThread = function (options) {
    var self = this;
    var opts = options && typeof options === 'object' ? options : {};
    var uid = this._state.uid;

    if (!uid) {
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

    var headers = {
      'X-WP-Nonce': restNonce(),
      'X-Sos-Scope': 'patient',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    };

    return fetch(url, {
      method: 'GET',
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this._abortController ? this._abortController.signal : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (err) {
          data = null;
        }

        if (!response.ok) {
          var message = data && typeof data.message === 'string' ? data.message : 'Impossible de charger la messagerie sécurisée.';
          var error = new Error(message);
          error.status = response.status;
          throw error;
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

  PatientTextChatElement.prototype.markReadIfNeeded = function () {
    var payload = this._state.payload;
    var uid = this._state.uid;
    if (!uid || !payload || typeof payload !== 'object') {
      return;
    }

    var threadState = payload.thread_state && typeof payload.thread_state === 'object' ? payload.thread_state : null;
    var unreadCount = threadState ? Number(threadState.unread_count_patient || 0) : 0;
    var lastMessageSeq = threadState ? Number(threadState.last_message_seq || 0) : 0;

    if (unreadCount < 1 || lastMessageSeq < 1) {
      return;
    }

    fetchJson('POST', buildApiUrl(uid, '/messages/read'), {
      read_upto_seq: lastMessageSeq
    }, 'patient').then(function (result) {
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
      this.render();
      return null;
    }.bind(this)).catch(function () {
      return null;
    });
  };

  PatientTextChatElement.prototype.onShadowClick = function (event) {
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

  PatientTextChatElement.prototype.onShadowInput = function (event) {
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.getAttribute('data-role') !== 'composer-body') {
      return;
    }
    this._state.draft = String(target.value || '');
  };

  PatientTextChatElement.prototype.onShadowSubmit = function (event) {
    var form = event.target;
    if (!(form instanceof Element) || form.getAttribute('data-role') !== 'composer-form') {
      return;
    }

    event.preventDefault();
    this.submitMessage();
  };

  PatientTextChatElement.prototype.submitMessage = function () {
    var self = this;
    var uid = this._state.uid;
    var body = String(this._state.draft || '').trim();
    var mode = resolveMode(this.currentThreadState(), this._state.status);

    if (!uid || !body || this._state.sending || mode !== 'PATIENT_REPLY') {
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
      self.render();
      self.loadThread({ silent: true, force: true });
      return null;
    }).catch(function (error) {
      self._state.sending = false;
      self._state.error = error && error.message ? String(error.message) : 'Le message n’a pas pu être envoyé.';
      self.render();
      return null;
    });
  };

  PatientTextChatElement.prototype.currentThreadState = function () {
    var payload = this._state.payload;
    return payload && typeof payload === 'object' && payload.thread_state && typeof payload.thread_state === 'object'
      ? payload.thread_state
      : null;
  };

  PatientTextChatElement.prototype.currentMessages = function () {
    var payload = this._state.payload;
    return payload && typeof payload === 'object' && Array.isArray(payload.messages)
      ? payload.messages
      : [];
  };

  PatientTextChatElement.prototype.render = function () {
    if (!this._frame) {
      this.renderFrame();
    }
    if (!this._frame) {
      return;
    }

    var uid = this._state.uid;
    var mode = resolveMode(this.currentThreadState(), this._state.status);
    var messages = this.currentMessages();
    var flash = this._state.flash ? '<div class="sp-alert sp-alert--success" role="status">' + escapeHtml(this._state.flash) + '</div>' : '';
    var error = this._state.error ? '<div class="sp-alert sp-alert--error" role="alert">' + escapeHtml(this._state.error) + '</div>' : '';
    var modeMessage = threadModeMessage(mode);
    var modeAlert = modeMessage ? '<div class="sp-alert sp-alert--info" role="status">' + escapeHtml(modeMessage) + '</div>' : '';
    var unreadCount = this.currentThreadState() ? Number(this.currentThreadState().unread_count_patient || 0) : 0;
    var unreadNote = unreadCount > 0 ? '<p class="sp-patient-chat__hint">Un nouveau message du médecin vient d’être synchronisé.</p>' : '';

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
      + '      <h2 class="sp-patient-chat__title">Messagerie sécurisée</h2>'
      + '      <p class="sp-patient-chat__subtitle">Échange textuel asynchrone avec votre médecin.</p>'
      + unreadNote
      + '    </div>'
      + '    <button type="button" class="sp-button sp-button--secondary" data-action="refresh"' + (uid ? '' : ' disabled') + '>' + (this._state.loading ? 'Actualisation…' : 'Rafraîchir') + '</button>'
      + '  </div>'
      + flash
      + error
      + modeAlert
      + bodyHtml
      + '</section>';
  };

  PatientTextChatElement.prototype.renderMessages = function (messages, mode) {
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
      var role = normalizeText(message.author_role || 'doctor');
      items.push(''
        + '<article class="sp-patient-chat__message ' + escapeHtml(roleClass(role)) + '">'
        + '  <div class="sp-patient-chat__bubble">'
        + '    <p class="sp-patient-chat__author">' + escapeHtml(roleLabel(role)) + '</p>'
        + '    <div class="sp-patient-chat__body">' + escapeHtml(String(message.body || '')).replace(/\n/g, '<br>') + '</div>'
        + '    <p class="sp-patient-chat__meta">' + escapeHtml(String(message.created_at || '')) + '</p>'
        + '  </div>'
        + '</article>');
    }

    return ''
      + '<div class="sp-patient-chat__panel">'
      + '  <div class="sp-patient-chat__messages">'
      + items.join('')
      + '  </div>'
      + '</div>';
  };

  PatientTextChatElement.prototype.renderComposer = function (mode) {
    if (mode !== 'PATIENT_REPLY') {
      return '';
    }

    var disabled = this._state.sending ? ' disabled' : '';
    return ''
      + '<div class="sp-patient-chat__panel sp-patient-chat__composer-panel">'
      + '  <form class="sp-form sp-patient-chat__composer" data-role="composer-form">'
      + '    <div class="sp-field">'
      + '      <label class="sp-field__label" for="sp-patient-chat-body">Votre réponse</label>'
      + '      <textarea id="sp-patient-chat-body" class="sp-textarea sp-patient-chat__textarea" rows="4" placeholder="Écrivez votre message au médecin…" data-role="composer-body"' + disabled + '>' + escapeHtml(this._state.draft) + '</textarea>'
      + '      <p class="sp-field__help">Messagerie 100% textuelle. Aucun document ne peut être joint dans cet échange.</p>'
      + '    </div>'
      + '    <div class="sp-patient-chat__composer-actions">'
      + '      <button type="submit" class="sp-button sp-button--primary"' + (this._state.sending || String(this._state.draft || '').trim() === '' ? ' disabled' : '') + '>' + (this._state.sending ? 'Envoi en cours…' : 'Envoyer') + '</button>'
      + '    </div>'
      + '  </form>'
      + '</div>';
  };

  if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, PatientTextChatElement);
  }
})();
