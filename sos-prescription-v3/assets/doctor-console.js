// assets/doctor-console.js
(function () {
  'use strict';

  var root = document.getElementById('sosprescription-doctor-console-root');
  if (!root) return;

  var cfg = window.SOSPrescription || window.SosPrescription || {};
  var restBase = String(cfg.restBase || '').replace(/\/+$/, '');
  var nonce = String(cfg.nonce || '');
  var currentUser = (cfg.currentUser && typeof cfg.currentUser === 'object') ? cfg.currentUser : {};
  var currentUserId = Number(currentUser.id || 0);
  var currentUserName = String(currentUser.displayName || currentUser.email || 'Médecin');

  var state = {
    list: [],
    details: {},
    pdf: {},
    threads: {},
    proofs: {},
    detailTab: 'prescription',
    selectedId: 0,
    listFilter: 'pending',
    listLoading: false,
    detailLoading: false,
    notice: null,
    refusalOpen: false,
    refusalReason: '',
    pollHandle: null,
    pollInFlight: false,
    hydratedIds: {},
    pendingActions: {},
    optimisticLocks: {},
    editedItems: {},
    medEditor: null,
    ui: null,
    visibilityBound: false
  };

  var OPTIMISTIC_LOCK_MIN_MS = 15 * 1000;
  var OPTIMISTIC_LOCK_ORPHAN_MS = 6 * 60 * 60 * 1000;
  var REQUEST_TIMEOUT_GET_MS = 12000;
  var REQUEST_TIMEOUT_MUTATION_MS = 20000;

  var DOCTOR_CHAT_UTILITY_STYLE_ID = 'sp-doctor-chat-utility-styles';
  var DOCTOR_CHAT_UTILITY_CSS = [
    '.spu-thread-stack > * + *{margin-top:.75rem;}',
    '.spu-flex{display:flex;}',
    '.spu-flex-col{flex-direction:column;}',
    '.spu-justify-start{justify-content:flex-start;}',
    '.spu-justify-end{justify-content:flex-end;}',
    '.spu-items-start{align-items:flex-start;}',
    '.spu-items-end{align-items:flex-end;}',
    '.spu-gap-1{gap:.25rem;}',
    '.spu-max-w-85{max-width:85%;}',
    '.spu-rounded-2xl{border-radius:16px;}',
    '.spu-px-4{padding-left:1rem;padding-right:1rem;}',
    '.spu-py-3{padding-top:.75rem;padding-bottom:.75rem;}',
    '.spu-text-sm{font-size:.875rem;line-height:1.4;}',
    '.spu-text-xs{font-size:.75rem;line-height:1rem;}',
    '.spu-font-semibold{font-weight:600;}',
    '.spu-uppercase{text-transform:uppercase;}',
    '.spu-tracking-wide{letter-spacing:.05em;}',
    '.spu-whitespace-pre-wrap{white-space:pre-wrap;}',
    '.spu-bg-gray-900{background:#111827;}',
    '.spu-bg-gray-100{background:#f3f4f6;}',
    '.spu-text-white{color:#ffffff;}',
    '.spu-text-gray-900{color:#111827;}',
    '.spu-text-gray-600{color:#4b5563;}',
    '.spu-text-gray-500{color:#6b7280;}',
    '.spu-border{border:1px solid #e5e7eb;}',
    '.spu-bg-white{background:#ffffff;}',
    '.spu-rounded-xl{border-radius:12px;}',
    '.spu-p-4{padding:1rem;}'
  ].join('');
  var DOCTOR_CONSOLE_POLISH_STYLE_ID = 'sp-doctor-console-polish-styles';
  var DOCTOR_CONSOLE_POLISH_CSS = [
    '.sosprescription-doctor .dc-detail-tabs{background:transparent !important;padding:0 20px 14px;gap:18px;border-bottom:1px solid #eef2f7;}',
    '.sosprescription-doctor .dc-detail-tab{padding:0 0 12px;border:0;background:transparent !important;border-radius:0;color:#64748b;font-size:13px;font-weight:600;position:relative;}',
    '.sosprescription-doctor .dc-detail-tab::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:999px;background:transparent;transition:background-color .15s ease;}',
    '.sosprescription-doctor .dc-detail-tab:hover{border-color:transparent;color:#0f172a;background:transparent !important;}',
    '.sosprescription-doctor .dc-detail-tab.is-active{border-color:transparent;background:transparent !important;color:#0f172a;font-weight:800;}',
    '.sosprescription-doctor .dc-detail-tab.is-active::after{background:var(--sp-color-primary,#2b6df8);}',
    '.sosprescription-doctor .dc-item--urgent{background:linear-gradient(180deg, rgba(217,119,6,.08), rgba(255,255,255,1));}',
    '.sosprescription-doctor .dc-item--urgent:hover{background:linear-gradient(180deg, rgba(217,119,6,.14), rgba(255,255,255,1));}',
    '.sosprescription-doctor .dc-item--urgent.is-selected{border-left-color:var(--sp-color-warning,#d97706);}',
    '.sosprescription-doctor .dc-urgency-chip{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid transparent;white-space:nowrap;}',
    '.sosprescription-doctor .dc-urgency-chip__icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;}',
    '.sosprescription-doctor .dc-urgency-chip__icon svg{width:14px;height:14px;}',
    '.sosprescription-doctor .dc-urgency-chip--standard{background:var(--sp-color-primary-light,#edf4ff);border-color:rgba(43,109,248,.18);color:var(--sp-color-primary-dark,#1747b7);}',
    '.sosprescription-doctor .dc-urgency-chip--urgent{background:var(--sp-color-warning-light,#fff8eb);border-color:rgba(217,119,6,.2);color:var(--sp-color-warning,#d97706);}',
    '.sosprescription-doctor .dc-proof-viewer__image-button,.sosprescription-doctor .dc-inline-proof-card__image-button{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in;}',
    '.sosprescription-doctor .dc-proof-lightbox{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;}',
    '.sosprescription-doctor .dc-proof-lightbox[hidden]{display:none !important;}',
    '.sosprescription-doctor .dc-proof-lightbox__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.74);backdrop-filter:blur(3px);}',
    '.sosprescription-doctor .dc-proof-lightbox__dialog{position:relative;z-index:1;width:min(100%, 1180px);max-height:calc(100vh - 48px);display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:20px;background:#ffffff;box-shadow:0 24px 70px rgba(15,23,42,.28);}',
    '.sosprescription-doctor .dc-proof-lightbox__meta{padding-right:44px;font-size:13px;font-weight:700;color:#334155;}',
    '.sosprescription-doctor .dc-proof-lightbox__viewport{display:flex;align-items:center;justify-content:center;overflow:auto;}',
    '.sosprescription-doctor .dc-proof-lightbox__image{display:block;max-width:100%;height:auto;border-radius:16px;}',
    '.sosprescription-doctor .dc-proof-lightbox__close{position:absolute;top:16px;right:16px;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border:1px solid #dbe5f1;border-radius:999px;background:#ffffff;color:#0f172a;font-size:24px;line-height:1;cursor:pointer;}',
    '.sp-plugin-toolbar-meta .is-clinically-hidden{display:none !important;}'
  ].join('');
  var proofLightboxKeydownBound = false;

  function ensureDoctorChatUtilityStyles() {
    if (!document || !document.head || document.getElementById(DOCTOR_CHAT_UTILITY_STYLE_ID)) {
      return;
    }

    var style = document.createElement('style');
    style.id = DOCTOR_CHAT_UTILITY_STYLE_ID;
    style.type = 'text/css';
    style.textContent = DOCTOR_CHAT_UTILITY_CSS;
    document.head.appendChild(style);
  }

  function ensureDoctorConsolePolishStyles() {
    if (!document || !document.head || document.getElementById(DOCTOR_CONSOLE_POLISH_STYLE_ID)) {
      return;
    }

    var style = document.createElement('style');
    style.id = DOCTOR_CONSOLE_POLISH_STYLE_ID;
    style.type = 'text/css';
    style.textContent = DOCTOR_CONSOLE_POLISH_CSS;
    document.head.appendChild(style);
  }

  function cleanupHostToolbarMeta() {
    Array.prototype.slice.call(document.querySelectorAll('.sp-plugin-toolbar-meta')).forEach(function (container) {
      Array.prototype.slice.call(container.querySelectorAll('a, button')).forEach(function (node) {
        var label = normalizeText(node.textContent).toLowerCase();
        if (!label) return;
        if (label.indexOf('mon compte médecin') === -1
          && label.indexOf('mon compte medecin') === -1
          && label.indexOf('se déconnecter') === -1
          && label.indexOf('se deconnecter') === -1) {
          return;
        }
        var wrapper = node.closest('.sp-plugin-toolbar-meta__item, .sp-button, li, .menu-item') || node;
        wrapper.classList.add('is-clinically-hidden');
        wrapper.hidden = true;
        wrapper.setAttribute('aria-hidden', 'true');
      });
    });
  }

  function ensureProofLightbox() {
    var existing = root.querySelector('[data-dc-proof-lightbox]');
    if (existing) {
      return existing;
    }

    var overlay = document.createElement('div');
    overlay.className = 'dc-proof-lightbox';
    overlay.hidden = true;
    overlay.setAttribute('data-dc-proof-lightbox', '1');
    overlay.innerHTML = [
      '<div class="dc-proof-lightbox__backdrop" data-action="close-proof-lightbox"></div>',
      '<div class="dc-proof-lightbox__dialog" role="dialog" aria-modal="true" aria-label="Preuve médicale">',
      '  <button type="button" class="dc-proof-lightbox__close" data-action="close-proof-lightbox" aria-label="Fermer">×</button>',
      '  <div class="dc-proof-lightbox__meta" data-dc-proof-lightbox-meta></div>',
      '  <div class="dc-proof-lightbox__viewport">',
      '    <img class="dc-proof-lightbox__image" data-dc-proof-lightbox-image alt="Preuve médicale" loading="lazy" />',
      '  </div>',
      '</div>'
    ].join('');
    root.appendChild(overlay);

    if (!proofLightboxKeydownBound) {
      document.addEventListener('keydown', function (event) {
        if (event && event.key === 'Escape') {
          closeProofLightbox();
        }
      });
      proofLightboxKeydownBound = true;
    }

    return overlay;
  }

  function openProofLightbox(url, label) {
    var accessUrl = normalizeText(url);
    if (!accessUrl) {
      return;
    }

    var overlay = ensureProofLightbox();
    var image = overlay.querySelector('[data-dc-proof-lightbox-image]');
    var meta = overlay.querySelector('[data-dc-proof-lightbox-meta]');
    if (!image || !meta) {
      return;
    }

    overlay.setAttribute('data-prev-body-overflow', document.body.style.overflow || '');
    document.body.style.overflow = 'hidden';
    image.setAttribute('src', accessUrl);
    image.setAttribute('alt', normalizeText(label) || 'Preuve médicale');
    meta.textContent = normalizeText(label) || 'Preuve médicale';
    overlay.hidden = false;
  }

  function closeProofLightbox() {
    var overlay = root.querySelector('[data-dc-proof-lightbox]');
    if (!overlay) {
      return;
    }

    var image = overlay.querySelector('[data-dc-proof-lightbox-image]');
    var meta = overlay.querySelector('[data-dc-proof-lightbox-meta]');
    if (image) {
      image.removeAttribute('src');
    }
    if (meta) {
      meta.textContent = '';
    }

    document.body.style.overflow = overlay.getAttribute('data-prev-body-overflow') || '';
    overlay.hidden = true;
  }

  function getDoctorMessagingApi() {
    var api = window.SosDoctorMessaging;
    if (api && typeof api.mount === 'function' && typeof api.unmount === 'function') {
      return api;
    }
    return null;
  }

  function getDoctorMessagingBridge() {
    var bridge = window.SosDoctorMessagingBridge;
    var api = getDoctorMessagingApi();

    if (!api) {
      return null;
    }

    if (bridge && typeof bridge.mount === 'function' && typeof bridge.unmount === 'function') {
      return bridge;
    }

    return null;
  }

  function hasDoctorMessagingBridge() {
    return !!getDoctorMessagingBridge();
  }

  function renderDoctorMessagingBridgeError(host, message) {
    if (!(host instanceof HTMLElement)) {
      return;
    }

    host.removeAttribute('data-sp-mounted');
    host.removeAttribute('data-sp-mounted-prescription-id');
    host.removeAttribute('data-sp-pending-token');
    host.innerHTML = '<div class="dc-message-empty">' + escHtml(message || 'Bridge de messagerie introuvable.') + '</div>';
  }

  function findDoctorMessagingHosts(scope) {
    if (!(scope instanceof Element)) {
      return [];
    }

    return Array.prototype.slice.call(scope.querySelectorAll('[data-sp-doctor-chat-root="1"]'));
  }

  function destroyDoctorMessagingHosts(scope, exceptHost) {
    var bridge = getDoctorMessagingBridge();
    var hosts = findDoctorMessagingHosts(scope);

    hosts.forEach(function (host) {
      if (!(host instanceof HTMLElement)) {
        return;
      }

      if (exceptHost && host === exceptHost) {
        return;
      }

      if (bridge) {
        try {
          bridge.unmount(host);
        } catch (error) {
          // no-op defensive cleanup
        }
      }

      host.removeAttribute('data-sp-mounted');
      host.removeAttribute('data-sp-mounted-prescription-id');
      host.removeAttribute('data-sp-pending-token');
    });
  }

  function syncDoctorMessagingMount(detailEl, detail) {
    var bridge = getDoctorMessagingBridge();
    var messagesPanel = detailEl instanceof Element ? detailEl.querySelector('[data-dc-panel="messages"]') : null;

    if (!(messagesPanel instanceof HTMLElement)) {
      destroyDoctorMessagingHosts(detailEl, null);
      return;
    }

    var host = messagesPanel.querySelector('[data-sp-doctor-chat-root="1"]');
    var detailId = Number(detail && detail.id || state.selectedId || 0);
    var isActive = state.detailTab === 'messages' && messagesPanel.classList.contains('is-active');

    if (!(host instanceof HTMLElement)) {
      destroyDoctorMessagingHosts(detailEl, null);
      return;
    }

    if (!isActive) {
      messagesPanel.removeAttribute('data-sp-chat-owned');
      destroyDoctorMessagingHosts(detailEl, null);
      return;
    }

    if (detailId < 1) {
      destroyDoctorMessagingHosts(detailEl, null);
      messagesPanel.setAttribute('data-sp-chat-owned', '1');
      renderDoctorMessagingBridgeError(host, 'Référence de dossier invalide pour la messagerie.');
      return;
    }

    if (!bridge) {
      destroyDoctorMessagingHosts(detailEl, null);
      messagesPanel.setAttribute('data-sp-chat-owned', '1');
      renderDoctorMessagingBridgeError(host, 'Bridge de messagerie introuvable.');
      return;
    }

    destroyDoctorMessagingHosts(detailEl, host);

    var mountedId = normalizeText(host.getAttribute('data-sp-mounted-prescription-id'));
    if (host.getAttribute('data-sp-mounted') === '1' && mountedId === String(detailId)) {
      return;
    }

    var mountToken = String(detailId) + ':' + String(Date.now());
    host.setAttribute('data-sp-pending-token', mountToken);

    Promise.resolve(bridge.mount(host, detailId)).then(function () {
      if (!(host instanceof HTMLElement)) {
        return;
      }

      if (!document.body.contains(host)) {
        try {
          bridge.unmount(host);
        } catch (error) {
          // no-op defensive cleanup
        }
        return;
      }

      if (host.getAttribute('data-sp-pending-token') !== mountToken) {
        try {
          bridge.unmount(host);
        } catch (error) {
          // no-op defensive cleanup
        }
        return;
      }

      host.setAttribute('data-sp-mounted', '1');
      host.setAttribute('data-sp-mounted-prescription-id', String(detailId));
      host.removeAttribute('data-sp-pending-token');
      messagesPanel.setAttribute('data-sp-chat-owned', '1');
    }).catch(function (error) {
      renderDoctorMessagingBridgeError(host, error && error.message ? String(error.message) : 'Bridge de messagerie introuvable.');
    });
  }


  var LIST_FILTERS = [
    { key: 'pending', label: 'En attente', status: '', title: 'Demandes en attente', empty: 'Aucune demande en attente.' },
    { key: 'approved', label: 'Validées', status: 'approved', title: 'Ordonnances validées', empty: 'Aucune ordonnance validée.' },
    { key: 'rejected', label: 'Refusées', status: 'rejected', title: 'Ordonnances refusées', empty: 'Aucune ordonnance refusée.' },
    { key: 'all', label: 'Toutes', status: '', title: 'Toutes les demandes', empty: 'Aucune demande trouvée.' }
  ];

  var PENDING_BUCKET_STATUSES = ['pending', 'payment_pending', 'in_review', 'needs_info'];

  ensureDoctorChatUtilityStyles();
  ensureDoctorConsolePolishStyles();
  cleanupHostToolbarMeta();

  if (!restBase || !nonce) {
    root.innerHTML = '<div class="sosprescription-doctor"><div class="dc-error-card">Configuration REST manquante (restBase/nonce).</div></div>';
    return;
  }

  function escHtml(value) {
    var s = String(value == null ? '' : value);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function hasObjectKeys(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
  }

  function cloneValue(value) {
    try {
      return JSON.parse(JSON.stringify(value == null ? null : value));
    } catch (e) {
      return value;
    }
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function stableSerialize(value) {
    try {
      return JSON.stringify(value == null ? null : value);
    } catch (error) {
      return '';
    }
  }

  function recordsEqual(left, right) {
    return stableSerialize(left) === stableSerialize(right);
  }

  function mergeDetailSnapshot(previous, incoming) {
    var prev = asObject(previous);
    var next = asObject(incoming);
    if (!hasObjectKeys(prev)) {
      return next;
    }
    if (!hasObjectKeys(next)) {
      return cloneValue(prev);
    }

    var merged = cloneValue(next);
    var mergedPayload = asObject(merged.payload);
    var prevPayload = asObject(prev.payload);

    if (!hasObjectKeys(mergedPayload) && hasObjectKeys(prevPayload)) {
      merged.payload = cloneValue(prevPayload);
    } else if (hasObjectKeys(prevPayload)) {
      if (!hasObjectKeys(asObject(mergedPayload.patient)) && hasObjectKeys(asObject(prevPayload.patient))) {
        mergedPayload.patient = cloneValue(prevPayload.patient);
      }
      if (!hasObjectKeys(asObject(mergedPayload.worker)) && hasObjectKeys(asObject(prevPayload.worker))) {
        mergedPayload.worker = cloneValue(prevPayload.worker);
      }
      if (!hasObjectKeys(asObject(mergedPayload.request)) && hasObjectKeys(asObject(prevPayload.request))) {
        mergedPayload.request = cloneValue(prevPayload.request);
      }
      merged.payload = mergedPayload;
    }

    if (safeArray(merged.items).length < 1 && safeArray(prev.items).length > 0) {
      merged.items = cloneValue(prev.items);
    }
    if (safeArray(merged.files).length < 1 && safeArray(prev.files).length > 0) {
      merged.files = cloneValue(prev.files);
    }
    if (safeArray(merged.proofs).length < 1 && safeArray(prev.proofs).length > 0) {
      merged.proofs = cloneValue(prev.proofs);
    }

    [
      'uid',
      'verify_code',
      'priority',
      'created_at',
      'patient_name',
      'patient_birthdate',
      'patient_dob',
      'patient_weight_kg',
      'weight_kg',
      'status',
      'processing_status',
      'doctor_user_id'
    ].forEach(function (key) {
      if (!normalizeText(merged[key]) && normalizeText(prev[key])) {
        merged[key] = cloneValue(prev[key]);
      }
    });

    return merged;
  }

  function firstText(values) {
    for (var i = 0; i < values.length; i += 1) {
      var text = normalizeText(values[i]);
      if (text) return text;
    }
    return '';
  }

  function setHtmlIfChanged(node, html) {
    if (!node) return;
    if (node.innerHTML !== html) {
      node.innerHTML = html;
    }
  }

  function preserveLineBreaksHtml(value) {
    return escHtml(value).replace(/\r?\n/g, '<br />');
  }

  function buildLucideIcon(name) {
    var iconName = normalizeText(name).toLowerCase();
    if (iconName === 'square-pen') {
      return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '  <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>',
        '  <path d="M18.37 2.63a2.12 2.12 0 1 1 3 3L12 15l-4 1 1-4Z"></path>',
        '</svg>'
      ].join('');
    }
    if (iconName === 'pencil') {
      return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '  <path d="M12 20h9"></path>',
        '  <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>',
        '</svg>'
      ].join('');
    }
    if (iconName === 'paperclip') {
      return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.48-8.48"></path>',
        '</svg>'
      ].join('');
    }
    if (iconName === 'zap') {
      return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '  <path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>',
        '</svg>'
      ].join('');
    }
    return '';
  }

  function buildButtonIcon(iconName) {
    var icon = buildLucideIcon(iconName);
    if (!icon) return '';
    return '<span class="sp-button__icon" aria-hidden="true">' + icon + '</span>';
  }


  function getFilterMeta(filterKey) {
    var key = normalizeText(filterKey).toLowerCase();
    for (var i = 0; i < LIST_FILTERS.length; i += 1) {
      if (LIST_FILTERS[i].key === key) {
        return LIST_FILTERS[i];
      }
    }
    return LIST_FILTERS[0];
  }

  function getActiveFilterMeta() {
    return getFilterMeta(state.listFilter);
  }

  function buildListPath() {
    var meta = getActiveFilterMeta();
    var params = ['limit=50', 'offset=0'];
    if (meta.key !== 'pending' && meta.status) {
      params.push('status=' + encodeURIComponent(meta.status));
    }
    return '/prescriptions?' + params.join('&');
  }

  function setListFilter(filterKey) {
    var meta = getFilterMeta(filterKey);
    if (meta.key === state.listFilter) {
      return;
    }
    state.listFilter = meta.key;
    renderHeaderInto();
    fetchList({ silent: false });
  }

  function getBusinessStatusForFilter(row) {
    var record = asObject(row);
    var id = Number(record.id || 0);
    var localDecision = getOverlayDecision(id);
    if (localDecision === 'approved' || localDecision === 'rejected') {
      return localDecision;
    }

    var businessStatus = normalizeText(record.status).toLowerCase();
    if (businessStatus) {
      return businessStatus;
    }

    var payload = asObject(record.payload);
    var worker = asObject(payload.worker);
    var workerStatus = normalizeText(worker.status).toLowerCase();
    var processingStatus = normalizeText(worker.processing_status).toLowerCase();

    if (workerStatus === 'approved' || workerStatus === 'done' || processingStatus === 'done') {
      return 'approved';
    }
    if (workerStatus === 'rejected' || processingStatus === 'failed') {
      return 'rejected';
    }
    if (processingStatus === 'claimed' || processingStatus === 'processing') {
      return 'in_review';
    }

    return 'pending';
  }

  function rowMatchesActiveFilter(row) {
    var meta = getActiveFilterMeta();
    var status = getBusinessStatusForFilter(row);

    if (meta.key === 'all') {
      return true;
    }
    if (meta.key === 'pending') {
      return PENDING_BUCKET_STATUSES.indexOf(status) !== -1;
    }
    return status === meta.key;
  }

  function findListIndexById(id) {
    var numericId = Number(id || 0);
    if (numericId < 1) return -1;
    return safeArray(state.list).findIndex(function (item) {
      return Number(item && item.id || 0) === numericId;
    });
  }

  function findListItemById(id) {
    var index = findListIndexById(id);
    return index >= 0 ? state.list[index] : null;
  }

  function getPendingAction(id) {
    return asObject(state.pendingActions[id]);
  }

  function getPendingDecision(id) {
    return normalizeText(getPendingAction(id).decision).toLowerCase();
  }

  function hasPendingAction(id, decision) {
    var current = getPendingDecision(id);
    if (!current) return false;
    if (!decision) return true;
    return current === normalizeText(decision).toLowerCase();
  }

  function rememberPendingAction(id, decision) {
    var index = findListIndexById(id);
    var normalizedDecision = normalizeText(decision).toLowerCase();
    state.pendingActions[id] = {
      decision: normalizedDecision,
      startedAt: Date.now(),
      snapshot: {
        listIndex: index,
        listItem: cloneValue(index >= 0 ? state.list[index] : null),
        detail: cloneValue(state.details[id]),
        pdf: cloneValue(state.pdf[id])
      }
    };

    rememberOptimisticLock(id, normalizedDecision);
  }

  function clearPendingAction(id) {
    delete state.pendingActions[id];
  }

  function getOptimisticLock(id) {
    return asObject(state.optimisticLocks[id]);
  }

  function clearOptimisticLock(id) {
    delete state.optimisticLocks[id];
  }

  function rememberOptimisticLock(id, decision) {
    var numericId = Number(id || 0);
    var normalizedDecision = normalizeText(decision).toLowerCase();
    if (numericId < 1 || !normalizedDecision) return;

    var now = Date.now();
    var existing = getOptimisticLock(numericId);

    state.optimisticLocks[numericId] = {
      decision: normalizedDecision,
      createdAt: Number(existing.createdAt || now),
      updatedAt: now,
      holdUntil: Math.max(Number(existing.holdUntil || 0), now + OPTIMISTIC_LOCK_MIN_MS),
      expiresAt: Math.max(Number(existing.expiresAt || 0), now + OPTIMISTIC_LOCK_ORPHAN_MS)
    };
  }

  function markOptimisticLockConfirmed(id, decision) {
    rememberOptimisticLock(id, decision);
  }

  function touchOptimisticLock(id) {
    var numericId = Number(id || 0);
    if (numericId < 1) return;

    var lock = getOptimisticLock(numericId);
    if (!hasObjectKeys(lock)) return;

    var now = Date.now();
    lock.updatedAt = now;
    lock.expiresAt = Math.max(Number(lock.expiresAt || 0), now + OPTIMISTIC_LOCK_ORPHAN_MS);
    state.optimisticLocks[numericId] = lock;
  }

  function cleanupOptimisticLocks() {
    var now = Date.now();

    Object.keys(state.optimisticLocks).forEach(function (key) {
      var numericId = Number(key || 0);
      if (numericId < 1) {
        delete state.optimisticLocks[key];
        return;
      }

      if (hasPendingAction(numericId)) {
        return;
      }

      var lock = asObject(state.optimisticLocks[key]);
      var expiresAt = Number(lock.expiresAt || 0);
      var createdAt = Number(lock.createdAt || 0);

      if (expiresAt > 0 && now > expiresAt) {
        delete state.optimisticLocks[key];
        return;
      }

      if (createdAt > 0 && now - createdAt > OPTIMISTIC_LOCK_ORPHAN_MS) {
        delete state.optimisticLocks[key];
      }
    });
  }

  function getOverlayDecision(id) {
    var pendingDecision = getPendingDecision(id);
    if (pendingDecision) return pendingDecision;

    var lock = getOptimisticLock(id);
    return normalizeText(lock.decision).toLowerCase();
  }

  function getAuthoritativeDecision(source) {
    var row = asObject(source);
    var payload = asObject(row.payload);
    var worker = asObject(payload.worker);

    var businessStatus = normalizeText(row.status).toLowerCase();
    var workerStatus = normalizeText(worker.status).toLowerCase();
    var processingStatus = normalizeText(worker.processing_status).toLowerCase();

    if (businessStatus === 'rejected' || workerStatus === 'rejected' || processingStatus === 'failed') {
      return 'rejected';
    }

    if (businessStatus === 'approved' || workerStatus === 'approved' || workerStatus === 'done' || processingStatus === 'done') {
      return 'approved';
    }

    return '';
  }

  function rollbackPendingAction(id) {
    var pending = getPendingAction(id);
    var snapshot = asObject(pending.snapshot);

    if (snapshot.listItem && typeof snapshot.listItem === 'object') {
      var restoredIndex = findListIndexById(id);
      if (restoredIndex >= 0) {
        state.list[restoredIndex] = snapshot.listItem;
      } else {
        var targetIndex = Math.max(0, Math.min(Number(snapshot.listIndex || 0), state.list.length));
        state.list.splice(targetIndex, 0, snapshot.listItem);
      }
    }

    if (snapshot.detail && typeof snapshot.detail === 'object' && Object.keys(snapshot.detail).length > 0) {
      state.details[id] = snapshot.detail;
    } else {
      delete state.details[id];
    }

    if (snapshot.pdf && typeof snapshot.pdf === 'object' && Object.keys(snapshot.pdf).length > 0) {
      state.pdf[id] = snapshot.pdf;
    } else {
      delete state.pdf[id];
    }

    clearPendingAction(id);
    clearOptimisticLock(id);
  }

  function overlayDecisionOnRecord(record, decision) {
    var row = asObject(record);
    if (!hasObjectKeys(row)) {
      row = { id: Number(record && record.id || 0) };
    }

    var payload = asObject(row.payload);
    var worker = asObject(payload.worker);
    var normalizedDecision = normalizeText(decision).toLowerCase();

    if (normalizedDecision === 'approved') {
      row.status = 'approved';
      worker.status = 'APPROVED';
      if (!normalizeText(worker.processing_status)) {
        worker.processing_status = 'pending';
      }
    } else if (normalizedDecision === 'rejected') {
      row.status = 'rejected';
      worker.status = 'REJECTED';
      worker.processing_status = 'failed';
    }

    payload.worker = worker;
    row.payload = payload;
    return row;
  }

  function applyPendingOverlayToRecord(record) {
    var row = cloneValue(record);
    var id = Number(row && row.id || 0);
    if (id < 1) {
      return row;
    }

    var pendingDecision = getPendingDecision(id);
    if (pendingDecision) {
      rememberOptimisticLock(id, pendingDecision);
      return overlayDecisionOnRecord(row, pendingDecision);
    }

    var lock = getOptimisticLock(id);
    if (!hasObjectKeys(lock)) {
      return row;
    }

    var lockDecision = normalizeText(lock.decision).toLowerCase();
    if (!lockDecision) {
      return row;
    }

    var serverDecision = getAuthoritativeDecision(row);
    if (serverDecision !== '') {
      clearOptimisticLock(id);
      return serverDecision === lockDecision ? row : row;
    }

    touchOptimisticLock(id);
    return overlayDecisionOnRecord(row, lockDecision);
  }

  function apiUrl(path) {
    return restBase + path;
  }

  function requestJson(method, path, body, requestOpts) {
    requestOpts = requestOpts || {};

    var requestMethod = String(method || 'GET').toUpperCase();
    var headers = {
      'Accept': 'application/json',
      'X-WP-Nonce': nonce
    };

    var requestUrl = apiUrl(path);
    if (requestMethod === 'GET') {
      try {
        var parsedUrl = new URL(requestUrl, window.location.href);
        parsedUrl.searchParams.set('_ts', String(Date.now()));
        requestUrl = parsedUrl.toString();
      } catch (e) {
        requestUrl += (requestUrl.indexOf('?') === -1 ? '?' : '&') + '_ts=' + String(Date.now());
      }
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers.Pragma = 'no-cache';
    }

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutMs = Math.max(
      4000,
      Number(
        requestOpts.timeoutMs || (/^GET$/i.test(requestMethod) ? REQUEST_TIMEOUT_GET_MS : REQUEST_TIMEOUT_MUTATION_MS)
      )
    );
    var timeoutHandle = 0;

    var fetchOpts = {
      method: requestMethod,
      headers: headers,
      credentials: 'same-origin'
    };

    if (requestMethod === 'GET') {
      fetchOpts.cache = 'no-store';
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }

    if (controller) {
      fetchOpts.signal = controller.signal;
      timeoutHandle = window.setTimeout(function () {
        try {
          controller.abort();
        } catch (e) {}
      }, timeoutMs);
    }

    return fetch(requestUrl, fetchOpts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }

        if (!res.ok) {
          var message = data && data.message ? String(data.message) : ('HTTP ' + res.status);
          var error = new Error(message);
          error.status = res.status;
          error.payload = data;
          throw error;
        }

        return data;
      });
    }).catch(function (error) {
      if (error && error.name === 'AbortError') {
        var timeoutError = new Error('Le serveur met trop de temps à répondre.');
        timeoutError.code = 'timeout';
        timeoutError.status = 0;
        throw timeoutError;
      }
      throw error;
    }).finally(function () {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }


  function normalizeArtifactUploadPurpose(purpose) {
    var raw = normalizeText(purpose).toLowerCase();
    if (raw === 'message' || raw === 'message_attachment' || raw === 'attachment' || raw === 'compose') {
      return {
        purpose: 'message',
        kind: 'MESSAGE_ATTACHMENT'
      };
    }

    return {
      purpose: 'evidence',
      kind: 'PROOF'
    };
  }

  function parseDirectUploadJson(response) {
    return response.text().then(function (text) {
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }

      if (!response.ok) {
        var message = data && data.message ? String(data.message) : (data && data.code ? String(data.code) : ('HTTP ' + response.status));
        var error = new Error(message);
        error.status = response.status;
        error.payload = data;
        throw error;
      }

      return data;
    });
  }

  function apiInitArtifactUpload(file, purpose, prescriptionId) {
    var normalized = normalizeArtifactUploadPurpose(purpose);
    var numericPrescriptionId = Number(prescriptionId || 0);
    var payload = {
      purpose: normalized.purpose,
      kind: normalized.kind,
      original_name: file && file.name ? String(file.name) : 'upload.bin',
      mime_type: file && file.type ? String(file.type) : 'application/octet-stream',
      size_bytes: file && Number(file.size || 0) > 0 ? Number(file.size) : 0
    };

    if (numericPrescriptionId > 0) {
      payload.prescription_id = numericPrescriptionId;
    }

    return requestJson('POST', '/artifacts/init', payload, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS });
  }

  function apiUploadFile(file, purpose, prescriptionId) {
    return apiInitArtifactUpload(file, purpose, prescriptionId).then(function (initPayload) {
      var upload = initPayload && initPayload.upload ? initPayload.upload : null;
      if (!upload || !upload.url) {
        throw new Error('Ticket d’upload Worker invalide.');
      }

      var headers = {};
      if (upload.headers && typeof upload.headers === 'object') {
        Object.keys(upload.headers).forEach(function (key) {
          if (!key) return;
          headers[key] = String(upload.headers[key]);
        });
      }
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = file && file.type ? String(file.type) : 'application/octet-stream';
      }

      return fetch(String(upload.url), {
        method: String(upload.method || 'PUT').toUpperCase(),
        headers: headers,
        body: file,
        mode: 'cors',
        credentials: 'omit'
      }).then(parseDirectUploadJson).then(function (directPayload) {
        var artifact = directPayload && directPayload.artifact ? directPayload.artifact : null;
        if (!artifact || !artifact.id) {
          throw new Error('Réponse artefact Worker incomplète.');
        }

        return {
          id: String(artifact.id),
          prescription_id: artifact.prescription_id ? String(artifact.prescription_id) : '',
          kind: artifact.kind ? String(artifact.kind) : normalizeArtifactUploadPurpose(purpose).kind,
          status: artifact.status ? String(artifact.status) : 'READY',
          original_name: artifact.original_name ? String(artifact.original_name) : (file && file.name ? String(file.name) : 'upload.bin'),
          mime: artifact.mime_type ? String(artifact.mime_type) : (file && file.type ? String(file.type) : 'application/octet-stream'),
          mime_type: artifact.mime_type ? String(artifact.mime_type) : (file && file.type ? String(file.type) : 'application/octet-stream'),
          size_bytes: Number(artifact.size_bytes || (file ? file.size : 0) || 0)
        };
      });
    });
  }

  function uploadComposeFiles(fileList, prescriptionId) {
    var files = safeArray(fileList ? Array.prototype.slice.call(fileList) : []);
    if (files.length < 1) {
      return Promise.resolve([]);
    }

    var uploads = files.map(function (file) {
      return apiUploadFile(file, 'message', prescriptionId);
    });

    return Promise.all(uploads);
  }

  function uploadRxFile(file, prescriptionId) {
    if (!file) {
      return Promise.reject(new Error('Aucun fichier à téléverser.'));
    }
    return apiUploadFile(file, 'evidence', prescriptionId);
  }

  function apiGetMessages(prescriptionId, afterSeq, limit) {
    var numericId = Number(prescriptionId || 0);
    var search = new URLSearchParams();
    search.set('after_seq', String(Math.max(0, Number(afterSeq || 0))));
    search.set('limit', String(Math.max(1, Math.min(100, Number(limit || 50)))));
    return requestJson('GET', '/prescriptions/' + numericId + '/messages?' + search.toString(), undefined, { timeoutMs: REQUEST_TIMEOUT_GET_MS });
  }

  function apiCreateMessage(prescriptionId, body, attachmentArtifactIds) {
    var numericId = Number(prescriptionId || 0);
    var payload = {
      body: String(body || '')
    };
    var ids = safeArray(attachmentArtifactIds).map(function (value) { return normalizeText(value); }).filter(Boolean);
    if (ids.length > 0) {
      payload.attachment_artifact_ids = ids;
    }
    return requestJson('POST', '/prescriptions/' + numericId + '/messages', payload, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS });
  }

  function apiMarkMessagesRead(prescriptionId, readUptoSeq) {
    var numericId = Number(prescriptionId || 0);
    return requestJson('POST', '/prescriptions/' + numericId + '/messages/read', {
      read_upto_seq: Math.max(0, Number(readUptoSeq || 0))
    }, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS });
  }

  function apiGetArtifactAccess(artifactId, prescriptionId, disposition) {
    var artifact = normalizeText(artifactId);
    if (!artifact) {
      return Promise.reject(new Error('Artefact invalide.'));
    }

    var payload = {
      disposition: normalizeText(disposition).toLowerCase() === 'attachment' ? 'attachment' : 'inline'
    };
    var numericId = Number(prescriptionId || 0);
    if (numericId > 0) {
      payload.prescription_id = numericId;
    }

    return requestJson('POST', '/artifacts/' + encodeURIComponent(artifact) + '/access', payload, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS });
  }


  function normalizeArtifactAccessPayload(payload) {
    var raw = asObject(payload);
    var artifact = asObject(raw.artifact);
    var access = asObject(raw.access);
    var url = firstText([
      access.url,
      access.download_url,
      access.downloadUrl,
      raw.url,
      raw.download_url,
      raw.downloadUrl
    ]);
    if (url) {
      access.url = url;
    }
    var mime = firstText([
      access.mime_type,
      access.mime,
      raw.mime_type,
      raw.mime,
      artifact.mime_type,
      artifact.mime
    ]);
    if (mime) {
      access.mime_type = mime;
    }
    var dispositionText = firstText([
      access.disposition,
      raw.disposition
    ]);
    if (dispositionText) {
      access.disposition = dispositionText;
    }
    var expiresIn = Number(access.expires_in || raw.expires_in || 0);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      access.expires_in = expiresIn;
    }
    return {
      artifact: artifact,
      access: access
    };
  }

  function getArtifactAccessUrl(payload) {
    return normalizeText(asObject(normalizeArtifactAccessPayload(payload).access).url);
  }

  function getArtifactAccessMimeType(payload) {
    return normalizeText(asObject(normalizeArtifactAccessPayload(payload).access).mime_type || '').toLowerCase();
  }

  function isPdfMimeType(mime) {
    var normalized = normalizeText(mime).toLowerCase();
    return normalized === 'application/pdf' || /pdf/.test(normalized);
  }

  function renderProofErrorHtml(message, artifactId, placeholderClass) {
    var artifact = normalizeText(artifactId);
    var klass = normalizeText(placeholderClass) || 'dc-proof-placeholder';
    var buttonHtml = artifact
      ? '<div class="dc-proof-error-actions"><button type="button" class="sp-button sp-button--secondary" data-action="retry-proof" data-artifact-id="' + escHtml(artifact) + '">Réessayer</button></div>'
      : '';
    return '<div class="' + escHtml(klass) + '">' + escHtml(message || 'Impossible de charger la preuve.') + buttonHtml + '</div>';
  }

  function getThreadStore(id) {
    var numericId = Number(id || 0);
    var current = asObject(state.threads[numericId]);
    if (!hasObjectKeys(current)) {
      current = {
        messages: [],
        threadState: {},
        loading: false,
        error: '',
        composerBody: '',
        uploads: [],
        uploading: false,
        sending: false,
        initialized: false
      };
    }
    if (!Array.isArray(current.messages)) current.messages = [];
    if (!Array.isArray(current.uploads)) current.uploads = [];
    current.threadState = asObject(current.threadState);
    current.loading = !!current.loading;
    current.uploading = !!current.uploading;
    current.sending = !!current.sending;
    current.initialized = !!current.initialized;
    current.error = normalizeText(current.error);
    current.composerBody = typeof current.composerBody === 'string' ? current.composerBody : '';
    return current;
  }

  function setThreadStore(id, patch) {
    var numericId = Number(id || 0);
    if (numericId < 1) return getThreadStore(0);
    var next = Object.assign({}, getThreadStore(numericId), patch || {});
    state.threads[numericId] = next;
    return next;
  }

  function getProofStore(id) {
    var numericId = Number(id || 0);
    var current = asObject(state.proofs[numericId]);
    if (!hasObjectKeys(current)) {
      current = {
        ids: [],
        selectedId: '',
        accessById: {},
        loading: false,
        error: '',
        accessLoading: false,
        accessError: ''
      };
    }
    if (!Array.isArray(current.ids)) current.ids = [];
    current.accessById = asObject(current.accessById);
    current.loading = !!current.loading;
    current.accessLoading = !!current.accessLoading;
    current.error = normalizeText(current.error);
    current.accessError = normalizeText(current.accessError);
    current.selectedId = normalizeText(current.selectedId);
    return current;
  }

  function setProofStore(id, patch) {
    var numericId = Number(id || 0);
    if (numericId < 1) return getProofStore(0);
    var next = Object.assign({}, getProofStore(numericId), patch || {});
    state.proofs[numericId] = next;
    return next;
  }

  function syncProofStoreFromDetail(detailId, detail) {
    var numericId = Number(detailId || 0);
    if (numericId < 1) return getProofStore(0);
    var ids = extractProofArtifactIds(detail);
    patchLocalEvidenceState(numericId, ids);
    var current = getProofStore(numericId);
    var selectedId = current.selectedId && ids.indexOf(current.selectedId) !== -1 ? current.selectedId : (ids[0] || '');
    return setProofStore(numericId, { ids: ids, selectedId: selectedId });
  }

  function openMessageAttachment(detailId, artifactId) {
    return apiGetArtifactAccess(artifactId, detailId, 'attachment').then(function (payload) {
      var access = payload && payload.access ? payload.access : null;
      if (!access || !access.url) {
        throw new Error('Lien de téléchargement indisponible.');
      }
      var anchor = document.createElement('a');
      anchor.href = String(access.url);
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return payload;
    });
  }

  function loadProofAccess(detailId, artifactId, opts) {
    opts = opts || {};
    var numericId = Number(detailId || 0);
    var proofId = normalizeText(artifactId);
    if (numericId < 1 || !proofId) return Promise.resolve(null);

    var proofStore = syncProofStoreFromDetail(numericId, state.details[numericId]);
    var cached = asObject(proofStore.accessById)[proofId];
    if (getArtifactAccessUrl(cached) && !opts.force) {
      setProofStore(numericId, { selectedId: proofId, accessError: '' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return Promise.resolve(cached);
    }

    setProofStore(numericId, { selectedId: proofId, accessLoading: true, accessError: '' });
    if (Number(state.selectedId) === numericId) {
      renderDetail();
    }

    return apiGetArtifactAccess(proofId, numericId, 'inline').then(function (payload) {
      var nextStore = getProofStore(numericId);
      var accessById = Object.assign({}, asObject(nextStore.accessById));
      accessById[proofId] = normalizeArtifactAccessPayload(payload);
      setProofStore(numericId, { selectedId: proofId, accessById: accessById, accessLoading: false, accessError: '' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return payload;
    }).catch(function (error) {
      setProofStore(numericId, { accessLoading: false, accessError: error && error.message ? String(error.message) : 'Impossible de charger la preuve.' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return null;
    });
  }

  function loadThread(detailId, opts) {
    opts = opts || {};
    var numericId = Number(detailId || 0);
    if (numericId < 1) return Promise.resolve(null);

    var thread = getThreadStore(numericId);
    if (!opts.silent) {
      setThreadStore(numericId, { loading: true, error: '' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
    }

    return apiGetMessages(numericId, 0, 100).then(function (payload) {
      var messages = dedupeThreadMessages(safeArray(payload && payload.messages));
      var threadState = asObject(payload && payload.thread_state);
      var previousThread = getThreadStore(numericId);
      var threadChanged = !recordsEqual(previousThread.messages, messages) || !recordsEqual(previousThread.threadState, threadState) || previousThread.loading;

      setThreadStore(numericId, {
        messages: messages,
        threadState: threadState,
        loading: false,
        error: '',
        initialized: true
      });
      patchLocalThreadState(numericId, threadState);
      if (opts.markRead !== false && Number(threadState.unread_count_doctor || 0) > 0) {
        return apiMarkMessagesRead(numericId, Number(threadState.last_message_seq || 0)).then(function (readPayload) {
          var nextThreadState = asObject(readPayload && readPayload.thread_state);
          var readChanged = false;
          if (hasObjectKeys(nextThreadState)) {
            readChanged = !recordsEqual(getThreadStore(numericId).threadState, nextThreadState);
            setThreadStore(numericId, { threadState: nextThreadState });
            patchLocalThreadState(numericId, nextThreadState);
          }
          if (Number(state.selectedId) === numericId && (threadChanged || readChanged || !opts.silent)) {
            renderDetail();
          }
          return payload;
        }).catch(function () {
          if (Number(state.selectedId) === numericId && (threadChanged || !opts.silent)) {
            renderDetail();
          }
          return payload;
        });
      }

      if (Number(state.selectedId) === numericId && (threadChanged || !opts.silent)) {
        renderDetail();
      }
      return payload;
    }).catch(function (error) {
      var nextError = error && error.message ? String(error.message) : 'Impossible de charger la messagerie.';
      var previousError = normalizeText(getThreadStore(numericId).error);
      setThreadStore(numericId, { loading: false, error: nextError });
      if (Number(state.selectedId) === numericId && (previousError !== nextError || !opts.silent)) {
        renderDetail();
      }
      return null;
    });
  }

  function queueMessageFiles(detailId, fileList) {
    var numericId = Number(detailId || 0);
    if (numericId < 1) return Promise.resolve([]);
    var files = safeArray(fileList ? Array.prototype.slice.call(fileList) : []);
    if (files.length < 1) return Promise.resolve([]);

    setThreadStore(numericId, { uploading: true, error: '' });
    if (Number(state.selectedId) === numericId) {
      renderDetail();
    }

    return uploadComposeFiles(files, numericId).then(function (artifacts) {
      var thread = getThreadStore(numericId);
      setThreadStore(numericId, {
        uploading: false,
        uploads: thread.uploads.concat(safeArray(artifacts))
      });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return artifacts;
    }).catch(function (error) {
      setThreadStore(numericId, { uploading: false, error: error && error.message ? String(error.message) : 'Impossible de téléverser la pièce jointe.' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return [];
    });
  }

  function removeQueuedMessageFile(detailId, artifactId) {
    var numericId = Number(detailId || 0);
    if (numericId < 1) return;
    var thread = getThreadStore(numericId);
    setThreadStore(numericId, { uploads: thread.uploads.filter(function (file) { return normalizeText(file && file.id) !== normalizeText(artifactId); }) });
    if (Number(state.selectedId) === numericId) {
      renderDetail();
    }
  }

  function sendThreadMessage(detailId) {
    var numericId = Number(detailId || 0);
    if (numericId < 1) return Promise.resolve(null);
    var thread = getThreadStore(numericId);
    var body = String(thread.composerBody || '').trim();
    if (!body) return Promise.resolve(null);

    setThreadStore(numericId, { sending: true, error: '' });
    if (Number(state.selectedId) === numericId) {
      renderDetail();
    }

    var attachmentIds = thread.uploads.map(function (file) { return normalizeText(file && file.id); }).filter(Boolean);
    return apiCreateMessage(numericId, body, attachmentIds).then(function (payload) {
      var nextMessages = thread.messages.slice();
      if (payload && payload.message) {
        nextMessages.push(payload.message);
      }
      nextMessages = dedupeThreadMessages(nextMessages);
      var nextThreadState = asObject(payload && payload.thread_state);
      setThreadStore(numericId, {
        sending: false,
        composerBody: '',
        uploads: [],
        messages: nextMessages,
        threadState: hasObjectKeys(nextThreadState) ? nextThreadState : thread.threadState,
        initialized: true
      });
      if (hasObjectKeys(nextThreadState)) {
        patchLocalThreadState(numericId, nextThreadState);
      }
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      fetchList({ silent: true });
      if (Number(state.selectedId) === numericId) {
        loadThread(numericId, { silent: true, markRead: state.detailTab === 'messages' });
      }
      return payload;
    }).catch(function (error) {
      setThreadStore(numericId, { sending: false, error: error && error.message ? String(error.message) : 'Impossible d’envoyer le message.' });
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return null;
    });
  }

  function setDetailTab(tabKey) {
    var normalized = normalizeText(tabKey).toLowerCase();
    if (['proofs', 'messages', 'prescription'].indexOf(normalized) === -1) {
      normalized = 'prescription';
    }
    state.detailTab = normalized;

    var detailId = Number(state.selectedId || 0);
    if (detailId > 0) {
      if (normalized === 'messages') {
        renderDetail();
      } else if (normalized === 'proofs') {
        syncProofStoreFromDetail(detailId, state.details[detailId]);
        var proofStore = getProofStore(detailId);
        if (proofStore.selectedId) {
          loadProofAccess(detailId, proofStore.selectedId);
        } else {
          renderDetail();
        }
      } else {
        renderDetail();
      }
    } else {
      renderDetail();
    }
  }

  function formatDateDisplay(value) {
    var raw = normalizeText(value);
    if (!raw) return '—';
    var m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return m[3] + '/' + m[2] + '/' + m[1];
    }
    return raw;
  }

  function formatRelativeDate(value) {
    var raw = normalizeText(value);
    if (!raw) return 'Date inconnue';

    var dt = new Date(raw);
    if (!Number.isFinite(dt.getTime())) {
      return formatDateDisplay(raw);
    }

    var diffMs = Date.now() - dt.getTime();
    var diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return 'à l’instant';
    if (diffMin < 60) return 'il y a ' + diffMin + ' min';
    var diffH = Math.round(diffMin / 60);
    if (diffH < 24) return 'il y a ' + diffH + ' h';
    return formatDateDisplay(raw);
  }

  function formatMessageTimestamp(value) {
    var raw = normalizeText(value);
    if (!raw) return 'Date inconnue';

    var dt = new Date(raw);
    if (!Number.isFinite(dt.getTime())) {
      return formatDateDisplay(raw);
    }

    function pad2(number) {
      return number < 10 ? '0' + String(number) : String(number);
    }

    return 'Le ' + pad2(dt.getDate()) + '/' + pad2(dt.getMonth() + 1) + '/' + String(dt.getFullYear()) + ' à ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function dedupeThreadMessages(messages) {
    var items = safeArray(messages);
    var seen = Object.create(null);
    var out = [];

    for (var index = 0; index < items.length; index += 1) {
      var message = asObject(items[index]);
      var seq = normalizeText(message.seq);
      var id = normalizeText(message.id);
      var key = id || seq;
      if (!key) {
        key = [normalizeText(message.author_role), normalizeText(message.created_at), normalizeText(message.body)].join('|');
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

  function formatPatientHeadline(value) {
    var raw = normalizeText(value).replace(/\s+/g, ' ');
    if (!raw || /@/.test(raw)) {
      return 'Patient';
    }

    var parts = raw.split(' ');
    if (parts.length < 2) return raw;
    var firstName = parts.shift() || '';
    var lastName = parts.join(' ').toUpperCase();
    return (firstName + ' ' + lastName).trim();
  }

  function formatWeight(value) {
    var raw = normalizeText(value).replace(',', '.');
    if (!raw) return '';
    var num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return '';
    var rounded = Math.round(num * 10) / 10;
    var txt = Math.abs(rounded - Math.round(rounded)) < 0.001
      ? String(Math.round(rounded))
      : String(rounded).replace('.', ',');
    return txt + ' Kgs';
  }

  function statusBadge(label, variant) {
    return '<span class="dc-pill dc-pill-' + escHtml(variant) + '">' + escHtml(label) + '</span>';
  }

  function extractVerifyCode(rx) {
    var payload = asObject(rx && rx.payload);
    var worker = asObject(payload.worker);
    return firstText([
      rx && rx.verify_code,
      worker.verify_code,
      payload.verify_code
    ]);
  }

  function extractPriority(rx) {
    var payload = asObject(rx && rx.payload);
    var requestPayload = asObject(payload.request);
    var priority = firstText([
      rx && rx.priority,
      payload.priority,
      payload.request_priority,
      requestPayload.priority
    ]).toLowerCase();
    return priority === 'express' ? 'Express' : 'Standard';
  }

  function extractCaseUid(rx) {
    var payload = asObject(rx && rx.payload);
    var worker = asObject(payload.worker);
    return firstText([
      rx && rx.uid,
      payload.uid,
      worker.uid
    ]);
  }

  function computeCaseStatus(source) {
    var row = asObject(source);
    var id = Number(row.id || 0);
    var overlayDecision = getOverlayDecision(id);
    if (overlayDecision === 'approved') {
      return { label: 'Validée', variant: 'success' };
    }
    if (overlayDecision === 'rejected') {
      return { label: 'Refusée', variant: 'danger' };
    }

    var payload = asObject(row.payload);
    var worker = asObject(payload.worker);

    var businessStatus = normalizeText(row.status).toLowerCase();
    var workerStatus = normalizeText(worker.status).toLowerCase();
    var processingStatus = normalizeText(worker.processing_status).toLowerCase();

    if (businessStatus === 'approved' || workerStatus === 'approved' || processingStatus === 'done' || workerStatus === 'done') {
      return { label: 'Validée', variant: 'success' };
    }
    if (businessStatus === 'rejected' || workerStatus === 'rejected' || processingStatus === 'failed') {
      return { label: 'Refusée', variant: 'danger' };
    }
    if (processingStatus === 'claimed' || processingStatus === 'processing') {
      return { label: 'En cours', variant: 'warn' };
    }
    if (businessStatus === 'payment_pending') {
      return { label: 'Paiement en attente', variant: 'soft' };
    }
    return { label: 'À traiter', variant: 'soft' };
  }

  function extractPatientData(rx) {
    var payload = asObject(rx && rx.payload);
    var patient = asObject(payload.patient);
    var fullname = firstText([
      patient.fullname,
      patient.fullName,
      [patient.firstName, patient.lastName].filter(Boolean).join(' '),
      rx && rx.patient_name
    ]);
    var birthDate = firstText([
      patient.birthdate,
      patient.birthDate,
      rx && rx.patient_birthdate,
      rx && rx.patient_dob
    ]);
    var weight = firstText([
      patient.weight,
      patient.weight_kg,
      patient.weightKg,
      rx && rx.patient_weight_kg,
      rx && rx.weight_kg
    ]);

    return {
      fullname: formatPatientHeadline(fullname),
      birthDate: formatDateDisplay(birthDate),
      weight: formatWeight(weight),
      createdAt: formatDateDisplay(rx && rx.created_at),
      createdAgo: formatRelativeDate(rx && rx.created_at),
      verifyCode: extractVerifyCode(rx),
      priority: extractPriority(rx)
    };
  }

  function extractPdfState(id) {
    return asObject(state.pdf[id]);
  }

  function extractMedicalNotes(rx) {
    var row = asObject(rx);
    var payload = asObject(row.payload);
    var prescription = asObject(payload.prescription);
    return firstText([
      row.privateNotes,
      row.private_notes,
      prescription.privateNotes,
      prescription.private_notes,
      payload.privateNotes,
      payload.private_notes,
      asObject(payload.patient).note
    ]);
  }

  function extractMedicationNames(source) {
    var record = asObject(source);
    var items = safeArray(record.items);
    var names = [];

    for (var i = 0; i < items.length; i += 1) {
      var item = asObject(items[i]);
      var raw = asObject(item.raw);
      var label = firstText([
        item.label,
        item.denomination,
        item.name,
        raw.label,
        raw.denomination,
        raw.name
      ]);
      if (!label || names.indexOf(label) !== -1) {
        continue;
      }
      names.push(label);
    }

    return names;
  }

  function buildMedicationPreview(source) {
    var names = extractMedicationNames(source);
    if (names.length < 1) {
      return '';
    }

    var preview = names.slice(0, 2).join(' • ');
    if (names.length > 2) {
      preview += ' …';
    }

    return preview;
  }

  function extractShadowRoot(source) {
    var payload = asObject(asObject(source).payload);
    return asObject(payload.shadow);
  }

  function extractThreadShadowState(source) {
    return asObject(extractShadowRoot(source).worker_thread);
  }

  function extractEvidenceShadowState(source) {
    return asObject(extractShadowRoot(source).worker_evidence);
  }

  function extractFlowKey(source) {
    var row = asObject(source);
    var payload = asObject(row.payload);
    var prescription = asObject(payload.prescription);
    return firstText([
      row.flow,
      payload.flow,
      prescription.flow,
      row.flow_key,
      payload.flow_key
    ]).toLowerCase();
  }

  function extractProofArtifactIds(source) {
    var evidence = extractEvidenceShadowState(source);
    var payload = asObject(asObject(source).payload);
    var raw = [];
    if (Array.isArray(evidence.proof_artifact_ids)) {
      raw = evidence.proof_artifact_ids;
    } else if (Array.isArray(payload.proof_artifact_ids)) {
      raw = payload.proof_artifact_ids;
    }

    var out = [];
    for (var i = 0; i < raw.length; i += 1) {
      var current = normalizeText(raw[i]);
      if (!current) continue;
      if (out.indexOf(current) !== -1) continue;
      out.push(current);
    }
    return out;
  }

  function computeInboxUrgency(source) {
    var flowKey = extractFlowKey(source);
    var priority = extractPriority(source);

    if (flowKey === 'depannage_no_proof') {
      return {
        tone: 'urgent',
        label: 'Dépannage SOS',
        icon: 'zap'
      };
    }

    if (priority === 'Express') {
      return {
        tone: 'urgent',
        label: 'Express',
        icon: 'zap'
      };
    }

    return {
      tone: 'standard',
      label: 'Standard',
      icon: ''
    };
  }

  function renderInboxUrgencyBadge(source) {
    var urgency = computeInboxUrgency(source);
    var icon = urgency.icon ? '<span class="dc-urgency-chip__icon" aria-hidden="true">' + buildLucideIcon(urgency.icon) + '</span>' : '';
    return '<span class="dc-urgency-chip dc-urgency-chip--' + escHtml(urgency.tone) + '">' + icon + '<span>' + escHtml(urgency.label) + '</span></span>';
  }

  function buildInboxAlertBadges(source) {
    var badges = [];
    var thread = extractThreadShadowState(source);
    var evidence = extractEvidenceShadowState(source);
    var unread = Number(thread.unread_count_doctor || 0);
    if (unread > 0) {
      badges.push(statusBadge(unread > 9 ? '9+' : String(unread), 'danger'));
    }

    var hasProof = !!evidence.has_proof || Number(evidence.proof_count || 0) > 0 || extractProofArtifactIds(source).length > 0;
    if (hasProof) {
      badges.push(statusBadge('Avec preuve', 'info'));
    } else if (extractFlowKey(source) === 'depannage_no_proof') {
      badges.push(statusBadge('Sans preuve', 'soft'));
    }

    return badges.join('');
  }

  function patchShadowOnRecord(record, patch) {
    var row = asObject(record);
    var payload = asObject(row.payload);
    var shadow = asObject(payload.shadow);
    Object.keys(patch || {}).forEach(function (key) {
      shadow[key] = patch[key];
    });
    shadow.zero_pii = true;
    shadow.mode = 'worker-postgres';
    payload.shadow = shadow;
    row.payload = payload;
    return row;
  }

  function patchLocalThreadState(id, threadState) {
    var numericId = Number(id || 0);
    if (numericId < 1 || !threadState || typeof threadState !== 'object') return;

    var normalized = {
      message_count: Math.max(0, Number(threadState.message_count || 0)),
      last_message_seq: Math.max(0, Number(threadState.last_message_seq || 0)),
      last_message_at: normalizeText(threadState.last_message_at) || null,
      last_message_role: normalizeText(threadState.last_message_role) || null,
      doctor_last_read_seq: Math.max(0, Number(threadState.doctor_last_read_seq || 0)),
      patient_last_read_seq: Math.max(0, Number(threadState.patient_last_read_seq || 0)),
      unread_count_doctor: Math.max(0, Number(threadState.unread_count_doctor || 0)),
      unread_count_patient: Math.max(0, Number(threadState.unread_count_patient || 0))
    };

    if (state.details[numericId]) {
      state.details[numericId] = patchShadowOnRecord(state.details[numericId], { worker_thread: normalized });
    }
    state.list = safeArray(state.list).map(function (item) {
      if (Number(item && item.id || 0) !== numericId) return item;
      return patchShadowOnRecord(cloneValue(item) || {}, { worker_thread: normalized });
    });
  }

  function patchLocalEvidenceState(id, proofArtifactIds) {
    var numericId = Number(id || 0);
    if (numericId < 1) return;

    var ids = safeArray(proofArtifactIds).map(function (value) { return normalizeText(value); }).filter(Boolean);
    var evidence = {
      has_proof: ids.length > 0,
      proof_count: ids.length,
      proof_artifact_ids: ids
    };

    if (state.details[numericId]) {
      var nextDetail = patchShadowOnRecord(state.details[numericId], { worker_evidence: evidence });
      nextDetail.payload = asObject(nextDetail.payload);
      nextDetail.payload.proof_artifact_ids = ids;
      state.details[numericId] = nextDetail;
    }

    state.list = safeArray(state.list).map(function (item) {
      if (Number(item && item.id || 0) !== numericId) return item;
      var nextRow = patchShadowOnRecord(cloneValue(item) || {}, { worker_evidence: evidence });
      nextRow.payload = asObject(nextRow.payload);
      nextRow.payload.proof_artifact_ids = ids;
      return nextRow;
    });
  }

  function isExpressPriorityRecord(source) {
    return extractPriority(source) === 'Express';
  }

  function sortListRowsByPriority(rows) {
    return safeArray(rows)
      .map(function (row, index) {
        return { row: row, index: index };
      })
      .sort(function (left, right) {
        var leftExpress = isExpressPriorityRecord(left.row) ? 1 : 0;
        var rightExpress = isExpressPriorityRecord(right.row) ? 1 : 0;
        if (leftExpress !== rightExpress) {
          return rightExpress - leftExpress;
        }
        return left.index - right.index;
      })
      .map(function (entry) {
        return entry.row;
      });
  }

  function applyLocalDecisionToPdfState(id, pdfState) {
    var numericId = Number(id || 0);
    var pdf = cloneValue(asObject(pdfState));
    if (numericId < 1) {
      return pdf;
    }

    var localDecision = getOverlayDecision(numericId);
    if (!localDecision) {
      return pdf;
    }

    var status = normalizeText(pdf.status || '').toLowerCase();
    var workerStatus = normalizeText(pdf.worker_status || '').toUpperCase();
    var processingStatus = normalizeText(pdf.processing_status || '').toLowerCase();
    var downloadUrl = normalizeText(pdf.download_url || '');

    if (localDecision === 'approved') {
      if (downloadUrl !== '' || status === 'done' || workerStatus === 'DONE' || processingStatus === 'done') {
        pdf.status = 'done';
        pdf.worker_status = 'DONE';
        pdf.processing_status = 'done';
        pdf.s3_ready = true;
        pdf.can_download = downloadUrl !== '';
        pdf.message = downloadUrl !== ''
          ? 'Validation enregistrée. PDF disponible.'
          : (normalizeText(pdf.message) || 'Validation enregistrée. PDF disponible.');
        pdf.last_error_code = null;
        pdf.last_error_message = null;
        return pdf;
      }

      if (status === 'failed' || processingStatus === 'failed') {
        return pdf;
      }

      pdf.status = 'processing';
      pdf.worker_status = 'APPROVED';
      pdf.processing_status = (processingStatus === 'claimed' || processingStatus === 'processing') ? 'processing' : 'pending';
      pdf.s3_ready = false;
      pdf.can_download = false;
      pdf.message = 'Génération du PDF en cours.';
      pdf.last_error_code = null;
      pdf.last_error_message = null;
      return pdf;
    }

    if (localDecision === 'rejected') {
      pdf.status = 'failed';
      pdf.worker_status = 'REJECTED';
      pdf.processing_status = 'failed';
      pdf.message = normalizeText(pdf.message) || 'Ordonnance refusée.';
      pdf.last_error_code = normalizeText(pdf.last_error_code) || 'rejected';
      pdf.last_error_message = normalizeText(pdf.last_error_message) || 'L’ordonnance a été rejetée.';
    }

    return pdf;
  }

  function resolveMedicationSchedule(row) {
    var direct = asObject(row && row.schedule);
    if (hasObjectKeys(direct)) {
      return direct;
    }
    var raw = asObject(row && row.raw);
    return asObject(raw.schedule);
  }

  function normalizeScheduleFreeText(value) {
    return String(value == null ? '' : value)
      .replace(/[  ]/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildFlexibleSpacePattern(value) {
    return normalizeScheduleFreeText(value)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s\\u00A0\\u202F\\r\\n]+');
  }

  function stripDurationFromPosology(text, durationLabel) {
    var raw = normalizeScheduleFreeText(text);
    if (!raw) return '';

    var cleaned = raw;
    var duration = normalizeScheduleFreeText(durationLabel);

    if (duration) {
      var durationPattern = buildFlexibleSpacePattern(duration);
      cleaned = cleaned.replace(new RegExp('(?:\\s|^)(?:,|;|\\.|:|—|-)?\\s*(?:pendant|durant|sur)\\s+' + durationPattern + '(?=(?:\\s|$|[(),.;:]))', 'ig'), ' ');
      cleaned = cleaned.replace(new RegExp('(?:\\s|^)(?:,|;|\\.|:|—|-)?\\s*' + durationPattern + '(?=(?:\\s*$|\\s+[)\\].,;:]|[)\\].,;:]))', 'ig'), ' ');
    }

    cleaned = cleaned.replace(/(?:\s|^)(?:,|;|\.|:|—|-)?\s*(?:pendant|durant|sur)\s+\d+\s*(?:j(?:ours?)?|sem(?:aines?)?|mois)(?=(?:\s|$|[(),.;:]))/ig, ' ');
    cleaned = cleaned
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/[—-]\s*$/, '')
      .replace(/[,.;:]\s*$/, '')
      .trim();

    return cleaned || raw;
  }

  function hasStructuredSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') return false;

    var nb = toPositiveInt(schedule.nb || schedule.timesPerDay);
    var freqUnit = normalizeScheduleUnit(schedule.freqUnit || schedule.frequencyUnit || schedule.freq);
    if (nb > 0 && freqUnit) return true;

    if (toPositiveInt(schedule.everyHours) > 0) return true;
    if (toPositiveInt(schedule.morning) > 0) return true;
    if (toPositiveInt(schedule.noon) > 0) return true;
    if (toPositiveInt(schedule.evening) > 0) return true;
    if (toPositiveInt(schedule.bedtime) > 0) return true;
    if (truthy(schedule.asNeeded)) return true;
    if (safeArray(schedule.times).length > 0) return true;
    if (safeArray(schedule.doses).length > 0) return true;

    return false;
  }

  function sanitizeScheduleNote(value, durationLabel) {
    var note = stripDurationFromPosology(value, durationLabel);
    if (!note) return '';

    var duration = normalizeScheduleFreeText(durationLabel).toLowerCase();
    if (!duration) return note;

    var lower = note.toLowerCase();
    if (lower === duration) return '';
    if (lower === ('pendant ' + duration)) return '';
    if (lower === ('durant ' + duration)) return '';
    if (lower === ('sur ' + duration)) return '';

    return note;
  }

  function summarizeMedication(item) {
    var row = asObject(item);
    var raw = asObject(row.raw);
    var schedule = resolveMedicationSchedule(row);
    var label = firstText([
      row.label,
      row.denomination,
      row.name,
      raw.label,
      raw.denomination,
      raw.name
    ]) || 'Médicament';
    var duration = firstText([
      row.duration_label,
      row.durationLabel,
      row.durationText,
      row.duration,
      row.duree,
      raw.duration_label,
      raw.durationLabel,
      raw.durationText,
      raw.duration,
      raw.duree,
      durationLabelFromSchedule(schedule)
    ]);
    var scheduleText = hasStructuredSchedule(schedule) ? scheduleToText(schedule) : '';
    var posology = scheduleText || firstText([
      row.instructions,
      row.scheduleText,
      raw.instructions,
      raw.scheduleText,
      row.posologie,
      raw.posologie,
      row.dosage,
      raw.dosage,
      sanitizeScheduleNote(schedule.note, duration),
      sanitizeScheduleNote(schedule.text, duration),
      sanitizeScheduleNote(schedule.label, duration)
    ]);
    if (!scheduleText) {
      posology = stripDurationFromPosology(posology, duration);
    }
    posology = normalizeScheduleFreeText(posology);

    var quantite = firstText([
      row.quantite,
      raw.quantite
    ]);

    var meta = [];
    if (duration) meta.push(duration);
    if (quantite) meta.push('Quantité : ' + String(quantite));

    return {
      label: label,
      posology: posology || '—',
      meta: meta.join(' — ')
    };
  }

  function scheduleToText(schedule) {
    if (!schedule || typeof schedule !== 'object') return '';

    var note = sanitizeScheduleNote(firstText([schedule.note, schedule.text, schedule.label]), durationLabelFromSchedule(schedule));
    var freqUnit = normalizeScheduleUnit(schedule.freqUnit || schedule.frequencyUnit || schedule.freq) || 'jour';
    var nb = toPositiveInt(schedule.nb || schedule.timesPerDay);
    var includeDetailedTimes = freqUnit === 'jour';
    var times = includeDetailedTimes ? safeArray(schedule.times).map(function (v) { return normalizeText(v); }).filter(Boolean) : [];
    var doses = includeDetailedTimes ? safeArray(schedule.doses).map(function (v) { return normalizeText(v); }).filter(Boolean) : [];
    var inferredCount = nb > 0 ? nb : (includeDetailedTimes ? Math.max(times.length, doses.length, 0) : 0);

    if (inferredCount > 0) {
      var base = (inferredCount > 1 ? (inferredCount + ' fois') : '1 fois') + ' par ' + freqUnit;
      if (includeDetailedTimes) {
        var details = [];
        for (var i = 0; i < inferredCount; i += 1) {
          var time = normalizeText(times[i]);
          var dose = normalizeText(doses[i]);
          if (!time && !dose) continue;
          details.push((dose || '1') + '@' + (time || '--:--'));
        }
        if (details.length) {
          base += ' (' + details.join(', ') + ')';
        }
      }
      if (note) {
        base += '. ' + note;
      }
      return normalizeScheduleFreeText(base);
    }

    var parts = [];
    [['morning', 'matin'], ['noon', 'midi'], ['evening', 'soir'], ['bedtime', 'coucher']].forEach(function (entry) {
      var value = toPositiveInt(schedule[entry[0]]);
      if (value > 0) parts.push(entry[1] + ': ' + value);
    });

    var everyHours = toPositiveInt(schedule.everyHours);
    if (everyHours > 0) parts.push('Toutes les ' + everyHours + ' h');

    if (truthy(schedule.asNeeded)) parts.push('si besoin');
    if (note) parts.push(note);

    if (parts.length > 0) {
      return normalizeScheduleFreeText(parts.join(' — '));
    }

    return normalizeScheduleFreeText(firstText([schedule.text, schedule.label]));
  }

  function durationLabelFromSchedule(schedule) {
    var durationVal = toPositiveInt(schedule && (schedule.durationVal || schedule.durationValue || schedule.duration));
    var durationUnit = normalizeScheduleUnit(schedule && (schedule.durationUnit || schedule.unit));
    if (durationVal < 1 || !durationUnit) return '';
    return durationVal + ' ' + pluralizeUnit(durationUnit, durationVal);
  }

  function normalizeScheduleUnit(value) {
    var raw = normalizeText(value).toLowerCase();
    if (['jour', 'jours', 'j', 'day', 'days'].indexOf(raw) !== -1) return 'jour';
    if (['semaine', 'semaines', 'sem', 'week', 'weeks'].indexOf(raw) !== -1) return 'semaine';
    if (['mois', 'month', 'months'].indexOf(raw) !== -1) return 'mois';
    return '';
  }

  function pluralizeUnit(unit, value) {
    if (!unit) return '';
    if (value <= 1 || unit === 'mois') return unit;
    return unit + 's';
  }

  function toPositiveInt(value) {
    var n = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.trunc(n);
  }

  function truthy(value) {
    if (typeof value === 'boolean') return value;
    var raw = normalizeText(value).toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'oui';
  }

  function stablePdfDocumentKey(url) {
    var raw = normalizeText(url);
    if (!raw) return '';
    try {
      var parsed = new URL(raw, window.location.href);
      return parsed.origin + parsed.pathname;
    } catch (e) {
      return raw.split('#')[0].split('?')[0];
    }
  }

  function iframeSrcFromDownloadUrl(url) {
    var raw = normalizeText(url);
    if (!raw) return '';

    try {
      var parsed = new URL(raw, window.location.href);
      parsed.hash = 'toolbar=0&view=FitH';
      return parsed.toString();
    } catch (e) {
      return raw.split('#')[0] + '#toolbar=0&view=FitH';
    }
  }

  function showNotice(type, message) {
    state.notice = { type: type || 'info', message: String(message || '') };
    renderNoticeInto();
  }

  function clearNotice() {
    state.notice = null;
    renderNoticeInto();
  }

  function captureInboxScrollAnchor(container) {
    if (!container) return null;

    var children = Array.prototype.slice.call(container.querySelectorAll('[data-role="inbox-item"]'));
    var containerRect = container.getBoundingClientRect();
    var fallback = {
      id: 0,
      offset: 0,
      scrollTop: container.scrollTop
    };

    for (var i = 0; i < children.length; i += 1) {
      var node = children[i];
      var rect = node.getBoundingClientRect();
      if (rect.bottom >= containerRect.top) {
        fallback.id = Number(node.getAttribute('data-id') || 0);
        fallback.offset = rect.top - containerRect.top;
        return fallback;
      }
    }

    return fallback;
  }

  function restoreInboxScrollAnchor(container, anchor) {
    if (!container || !anchor) return;

    if (anchor.id > 0) {
      var node = container.querySelector('[data-role="inbox-item"][data-id="' + String(anchor.id) + '"]');
      if (node) {
        var containerRect = container.getBoundingClientRect();
        var rect = node.getBoundingClientRect();
        container.scrollTop += (rect.top - containerRect.top) - Number(anchor.offset || 0);
        return;
      }
    }

    if (typeof anchor.scrollTop === 'number') {
      container.scrollTop = anchor.scrollTop;
    }
  }

  function renderNotice() {
    if (!state.notice || !state.notice.message) return '';
    var type = normalizeText(state.notice.type || 'info').toLowerCase();
    return '<div class="dc-notice dc-notice-' + escHtml(type) + '">' + escHtml(state.notice.message) + '</div>';
  }

  function renderNoticeInto() {
    var ui = ensureShell();
    setHtmlIfChanged(ui.notice, renderNotice());
  }


  function renderFilterTabs() {
    return LIST_FILTERS.map(function (filter) {
      var isActive = filter.key === state.listFilter;
      return '<button type="button" class="dc-filter-tab' + (isActive ? ' is-active' : '') + '" data-action="set-filter" data-filter="' + escHtml(filter.key) + '">' + escHtml(filter.label) + '</button>';
    }).join('');
  }

  function renderHeaderInto() {
    var ui = ensureShell();
    var meta = getActiveFilterMeta();
    if (ui.title) {
      ui.title.textContent = meta.title;
    }
    if (ui.filterTabs) {
      setHtmlIfChanged(ui.filterTabs, renderFilterTabs());
    }
  }

  function renderInboxItemMarkup(row) {
    var id = Number(row && row.id || 0);
    var detail = asObject(state.details[id]);
    var source = hasObjectKeys(detail) ? detail : row;
    var patient = extractPatientData(source);
    var statusInfo = computeCaseStatus(source);
    var medicationsPreview = buildMedicationPreview(source);
    var alertBadges = buildInboxAlertBadges(source);
    var urgencyBadge = renderInboxUrgencyBadge(source);

    return [
      '<div class="dc-item__row">',
      '  <div class="dc-item__patient">' + escHtml(patient.fullname || ('Dossier #' + id)) + '</div>',
      '  <div class="dc-item__status">' + statusBadge(statusInfo.label, statusInfo.variant) + '</div>',
      '</div>',
      medicationsPreview ? '  <div class="dc-item__meds" title="' + escHtml(medicationsPreview) + '">' + escHtml(medicationsPreview) + '</div>' : '',
      '  <div class="dc-item__meta">' + escHtml(patient.birthDate) + ' • ' + escHtml(patient.createdAgo) + '</div>',
      '  <div class="dc-item__foot">',
      '    ' + urgencyBadge,
      alertBadges ? '    <div class="dc-item__alerts">' + alertBadges + '</div>' : '',
      '  </div>'
    ].join('');
  }

  function patchInboxItemNode(node, row) {
    if (!node) return;

    var id = Number(row && row.id || 0);
    var isSelected = Number(state.selectedId) === id;
    var detail = asObject(state.details[id]);
    var source = hasObjectKeys(detail) ? detail : row;
    var urgency = computeInboxUrgency(source);

    node.type = 'button';
    node.className = 'dc-item dc-item--' + urgency.tone + (isSelected ? ' is-selected' : '');
    node.setAttribute('data-action', 'select');
    node.setAttribute('data-id', String(id));
    node.setAttribute('data-role', 'inbox-item');
    node.setAttribute('data-case-id', String(id));
    node.setAttribute('data-urgency-tone', urgency.tone);
    setHtmlIfChanged(node, renderInboxItemMarkup(row));
  }

  function patchInboxItemById(id) {
    var ui = ensureShell();
    var container = ui.inboxList;
    if (!container) return;

    var numericId = Number(id || 0);
    if (numericId < 1) return;

    var row = findListItemById(numericId);
    if (!row) return;

    var node = container.querySelector('[data-role="inbox-item"][data-id="' + String(numericId) + '"]');
    if (!node) {
      patchInboxList();
      return;
    }

    patchInboxItemNode(node, row);
  }

  function patchInboxList() {
    var ui = ensureShell();
    var container = ui.inboxList;
    if (!container) return;

    if (state.listLoading && state.list.length < 1) {
      setHtmlIfChanged(container, '<div class="dc-empty">Chargement des demandes…</div>');
      return;
    }

    if (state.list.length < 1) {
      setHtmlIfChanged(container, '<div class="dc-empty">' + escHtml(getActiveFilterMeta().empty) + '</div>');
      return;
    }

    var anchor = captureInboxScrollAnchor(container);
    var existing = {};
    Array.prototype.slice.call(container.querySelectorAll('[data-role="inbox-item"]')).forEach(function (node) {
      existing[String(node.getAttribute('data-id') || '')] = node;
    });

    var orderedNodes = [];
    safeArray(state.list).forEach(function (row) {
      var id = Number(row && row.id || 0);
      if (id < 1) return;
      var key = String(id);
      var node = existing[key] || document.createElement('button');
      patchInboxItemNode(node, row);
      orderedNodes.push(node);
      container.appendChild(node);
    });

    Array.prototype.slice.call(container.children).forEach(function (child) {
      if (orderedNodes.indexOf(child) === -1) {
        container.removeChild(child);
      }
    });

    restoreInboxScrollAnchor(container, anchor);
  }

  function renderMedicationList(detail) {
    var detailRow = asObject(detail);
    var detailId = Number(detailRow.id || state.selectedId || 0);
    var detailStatus = normalizeText(detailRow.status || '').toLowerCase();
    var canEdit = detailId > 0 && !hasPendingAction(detailId) && detailStatus !== 'approved' && detailStatus !== 'rejected';
    var items = safeArray(detailRow.items);
    if (items.length < 1) {
      return '<div class="dc-empty dc-empty-compact">Aucun médicament renseigné.</div>';
    }

    return '<div class="dc-meds">' + items.map(function (item, index) {
      var med = summarizeMedication(item);
      return [
        '<div class="dc-med">',
        '  <div class="dc-med__head">',
        '    <div class="dc-med__label">' + escHtml(med.label) + '</div>',
        canEdit
          ? '    <button type="button" class="sp-button sp-button--ghost" data-action="edit-med" data-index="' + String(index) + '" aria-label="Éditer la posologie de ' + escHtml(med.label) + '">' + buildButtonIcon('square-pen') + '<span>Éditer</span></button>'
          : '',
        '  </div>',
        '  <div class="dc-med__posology">' + escHtml(med.posology) + '</div>',
        med.meta ? '  <div class="dc-med__meta">' + escHtml(med.meta) + '</div>' : '',
        '</div>'
      ].join('');
    }).join('') + '</div>';
  }

  function buildDefaultTimes(count) {
    var presets = ['08:00', '13:00', '20:00', '22:00', '23:00', '23:30'];
    var total = Math.max(1, toPositiveInt(count) || 1);
    var out = [];
    for (var i = 0; i < total; i += 1) {
      out.push(presets[i] || presets[presets.length - 1]);
    }
    return out;
  }

  function fitScheduleStringArray(values, count, fallback) {
    var total = Math.max(1, toPositiveInt(count) || 1);
    var source = safeArray(values);
    var fallbackValue = typeof fallback === 'function' ? '' : normalizeText(fallback);
    var out = [];
    for (var i = 0; i < total; i += 1) {
      var current = normalizeText(source[i]);
      if (!current) {
        current = typeof fallback === 'function' ? normalizeText(fallback(i, total)) : fallbackValue;
      }
      out.push(current);
    }
    return out;
  }

  function padTimePart(value) {
    var numeric = Number(value || 0);
    return numeric < 10 ? ('0' + String(numeric)) : String(numeric);
  }

  function isValidTimeValue(value) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));
  }

  function timeToMinutes(value) {
    if (!isValidTimeValue(value)) return null;
    var parts = String(value).split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function minutesToTime(value) {
    var minutes = Math.round(Number(value) || 0);
    if (!Number.isFinite(minutes)) {
      minutes = 0;
    }
    minutes = Math.max(0, Math.min((23 * 60) + 59, minutes));
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    return padTimePart(hours) + ':' + padTimePart(mins);
  }

  function roundTimeMinutes(value, step) {
    var chunk = Math.max(1, Math.floor(Number(step || 5)));
    return Math.round(value / chunk) * chunk;
  }

  function distributeRecommendedTimes(count, start, end, rounding) {
    var warnings = [];
    var total = Math.max(1, toPositiveInt(count) || 1);
    var roundStep = Math.max(1, Math.min(60, toPositiveInt(rounding) || 5));
    var startMinutes = timeToMinutes(start);
    var endMinutes = timeToMinutes(end);

    if (startMinutes == null) startMinutes = 8 * 60;
    if (endMinutes == null) endMinutes = 20 * 60;

    if (endMinutes <= startMinutes) {
      endMinutes = Math.min(startMinutes + 60, (23 * 60) + 55);
      warnings.push('Fenêtre de prise invalide : heure de fin ajustée.');
    }

    var range = endMinutes - startMinutes;

    if (total === 1) {
      var singleStart = minutesToTime(roundTimeMinutes(startMinutes, roundStep));
      var singleEnd = minutesToTime(roundTimeMinutes(endMinutes, roundStep));
      return {
        times: [singleStart],
        start: singleStart,
        end: singleEnd,
        warnings: warnings,
        collisionResolved: false
      };
    }

    if (range < (total - 1) * roundStep) {
      warnings.push('Fenêtre trop courte pour répartir correctement.');
    }
    if (startMinutes > (18 * 60) && total > 1) {
      warnings.push('Première prise tardive : prises rapprochées.');
    }

    var interval = range / (total - 1);
    var rawMinutes = [];
    var collisionResolved = false;
    for (var i = 0; i < total; i += 1) {
      var currentMinutes = startMinutes + (i * interval);
      if (i === 0) currentMinutes = startMinutes;
      if (i === total - 1) currentMinutes = endMinutes;
      currentMinutes = roundTimeMinutes(currentMinutes, roundStep);
      currentMinutes = Math.max(startMinutes, Math.min(endMinutes, currentMinutes));
      rawMinutes.push(currentMinutes);
    }

    for (var j = 1; j < total; j += 1) {
      if (rawMinutes[j] <= rawMinutes[j - 1]) {
        collisionResolved = true;
        rawMinutes[j] = rawMinutes[j - 1] + roundStep;
      }
    }

    if (rawMinutes[total - 1] > endMinutes) {
      collisionResolved = true;
      rawMinutes[total - 1] = roundTimeMinutes(endMinutes, roundStep);
      for (var k = total - 2; k >= 0; k -= 1) {
        if (rawMinutes[k] >= rawMinutes[k + 1]) {
          rawMinutes[k] = rawMinutes[k + 1] - roundStep;
        }
      }
      if (rawMinutes[0] < startMinutes) {
        warnings.push('Horaires trop rapprochés : vérifier la posologie.');
        rawMinutes[0] = roundTimeMinutes(startMinutes, roundStep);
        for (var p = 1; p < total; p += 1) {
          rawMinutes[p] = Math.max(rawMinutes[p], rawMinutes[p - 1]);
        }
      }
    }

    var minGap = Infinity;
    for (var q = 1; q < total; q += 1) {
      minGap = Math.min(minGap, rawMinutes[q] - rawMinutes[q - 1]);
    }
    if (total >= 4 && Number.isFinite(minGap) && minGap < 60) {
      warnings.push('Horaires rapprochés : vérifier la posologie.');
    }

    var times = rawMinutes.map(minutesToTime);
    return {
      times: times,
      start: times[0],
      end: times[times.length - 1],
      warnings: warnings,
      collisionResolved: collisionResolved
    };
  }

  function normalizeMedicationEditorDraft(value) {
    var source = asObject(value);
    var freqUnit = normalizeScheduleUnit(source.freqUnit || source.frequencyUnit || source.freq) === 'semaine' ? 'semaine' : 'jour';
    var maxCount = freqUnit === 'jour' ? 6 : 12;
    var nb = Math.max(1, Math.min(maxCount, toPositiveInt(source.nb || source.timesPerDay) || 1));
    var durationVal = Math.max(1, Math.min(3650, toPositiveInt(source.durationVal || source.durationValue || source.duration) || 5));
    var durationUnit = normalizeScheduleUnit(source.durationUnit || source.unit) === 'mois' ? 'mois' : 'jour';
    var rounding = Math.max(1, Math.min(60, toPositiveInt(source.rounding) || 5));
    var note = normalizeText(source.note !== undefined ? source.note : firstText([source.text, source.label]));
    var times = Array.isArray(source.times) ? source.times : [];
    var doses = Array.isArray(source.doses) ? source.doses : [];
    var start = typeof source.start === 'string' ? source.start : (typeof times[0] === 'string' ? times[0] : '08:00');
    var end = typeof source.end === 'string' ? source.end : (typeof times[times.length - 1] === 'string' ? times[times.length - 1] : '20:00');
    var autoTimesEnabled = source.autoTimesEnabled !== false && freqUnit === 'jour';
    var warnings = [];

    start = isValidTimeValue(start) ? start : '08:00';
    end = isValidTimeValue(end) ? end : '20:00';

    if (freqUnit === 'jour') {
      doses = fitScheduleStringArray(doses, nb, '1');
      if (autoTimesEnabled) {
        var distribution = distributeRecommendedTimes(nb, start, end, rounding);
        times = distribution.times;
        start = distribution.start;
        end = distribution.end;
        warnings = distribution.warnings;
      } else {
        times = fitScheduleStringArray(times, nb, '');
      }
    } else {
      times = [];
      doses = [];
      autoTimesEnabled = false;
      warnings = [];
    }

    var normalized = {
      nb: nb,
      freqUnit: freqUnit,
      durationVal: durationVal,
      durationUnit: durationUnit,
      times: times,
      doses: doses,
      note: note,
      autoTimesEnabled: autoTimesEnabled,
      start: start,
      end: end,
      rounding: rounding,
      warnings: warnings
    };

    return normalized;
  }

  function buildEditableSchedule(item, overrides) {
    var row = asObject(item);
    var raw = asObject(row.raw);
    var current = resolveMedicationSchedule(row);
    var merged = cloneValue(current);
    var nextOverrides = asObject(overrides);

    if (!normalizeText(merged.note)) {
      merged.note = firstText([
        row.note,
        row.instructions_note,
        raw.note,
        current.note,
        current.text,
        current.label
      ]);
    }

    Object.keys(nextOverrides).forEach(function (key) {
      merged[key] = nextOverrides[key];
    });

    if (nextOverrides.note !== undefined) {
      merged.note = nextOverrides.note;
    }

    return normalizeMedicationEditorDraft(merged);
  }

  function sanitizeMedicationScheduleForSave(schedule) {
    var normalized = normalizeMedicationEditorDraft(schedule);
    var persisted = cloneValue(normalized);
    delete persisted.warnings;

    if (persisted.freqUnit !== 'jour') {
      persisted.times = [];
      persisted.doses = [];
      persisted.autoTimesEnabled = false;
      delete persisted.start;
      delete persisted.end;
    }

    if (!normalizeText(persisted.note)) {
      delete persisted.note;
    }

    return persisted;
  }

  function buildUpdatedMedicationItem(item, schedule) {
    var current = cloneValue(asObject(item));
    var raw = cloneValue(asObject(current.raw));
    var nextSchedule = sanitizeMedicationScheduleForSave(schedule);
    var posology = normalizeScheduleFreeText(scheduleToText(nextSchedule));
    var durationLabel = durationLabelFromSchedule(nextSchedule);

    current.schedule = nextSchedule;
    current.posologie = posology || null;
    current.instructions = posology || null;
    current.scheduleText = posology || null;
    current.duration_label = durationLabel || null;
    current.durationLabel = durationLabel || null;

    if (nextSchedule.note) {
      current.note = nextSchedule.note;
    } else {
      delete current.note;
    }

    raw.schedule = nextSchedule;
    raw.posologie = posology || '';
    raw.instructions = posology || '';
    raw.scheduleText = posology || '';
    raw.duration_label = durationLabel || '';
    raw.durationLabel = durationLabel || '';
    if (nextSchedule.note) {
      raw.note = nextSchedule.note;
    } else {
      delete raw.note;
    }
    current.raw = raw;

    return current;
  }

  function getMedicationDialog() {
    var ui = ensureShell();
    return ui && ui.medDialog ? ui.medDialog : root.querySelector('[data-dc-med-dialog]');
  }

  function getMedicationDialogBody() {
    var ui = ensureShell();
    return ui && ui.medDialogBody ? ui.medDialogBody : root.querySelector('[data-dc-med-dialog-body]');
  }

  function renderMedicationDialogInto(focusSpec) {
    var dialog = getMedicationDialog();
    var body = getMedicationDialogBody();
    var editor = asObject(state.medEditor);
    if (!dialog || !body) return;

    if (!editor.detailId) {
      body.innerHTML = '';
      return;
    }

    var draft = normalizeMedicationEditorDraft(editor.draft);
    state.medEditor.draft = draft;

    var rowsHtml = '';
    if (draft.freqUnit === 'jour') {
      var warningsHtml = draft.warnings && draft.warnings.length > 0
        ? '<ul class="dc-modal__schedule-warnings">' + draft.warnings.map(function (warning) {
            return '<li>' + escHtml(warning) + '</li>';
          }).join('') + '</ul>'
        : '';

      rowsHtml = '<div class="dc-modal__panel">'
        + '<div class="dc-modal__schedule-head">'
        + '  <div class="dc-modal__schedule-hint">' + (draft.autoTimesEnabled ? 'Horaires auto (répartis entre la 1ère et la dernière prise)' : 'Horaires personnalisés') + '</div>'
        + '  <div class="dc-modal__schedule-toolbar">'
        + (draft.autoTimesEnabled
            ? '<button type="button" class="sp-button sp-button--ghost" data-action="med-reset-times">Réinitialiser les horaires</button>'
            : '<button type="button" class="sp-button sp-button--ghost" data-action="med-enable-auto">Horaires auto</button>')
        + '  </div>'
        + '</div>'
        + warningsHtml
        + '<div class="dc-modal__schedule-rows">'
        + Array.from({ length: draft.nb }).map(function (_, index) {
            var isFirst = index === 0;
            var isLast = index === draft.nb - 1 && draft.nb > 1;
            var label = isFirst ? '1ère prise' : (isLast ? 'Dernière prise' : ('Prise ' + String(index + 1)));
            var anchor = draft.autoTimesEnabled && (isFirst || isLast) ? '<small>(ancre)</small>' : '';
            return '<div class="dc-modal__schedule-row">'
              + '  <div class="dc-modal__schedule-row-label">' + escHtml(label) + anchor + '</div>'
              + '  <label class="sp-field"><span class="sp-field__label">Heure</span><input type="time" step="300" class="sp-input" data-role="med-editor-time" data-index="' + String(index) + '" value="' + escHtml(draft.times[index] || '') + '" /></label>'
              + '  <label class="sp-field"><span class="sp-field__label">Dose</span><input type="text" class="sp-input" data-role="med-editor-dose" data-index="' + String(index) + '" value="' + escHtml(draft.doses[index] || '1') + '" placeholder="1" /></label>'
              + '</div>';
          }).join('')
        + '</div>'
        + '</div>';
    }

    body.innerHTML = [
      '<div class="dc-modal__card">',
      '  <div class="dc-modal__head">',
      '    <div class="dc-modal__title">Modifier la posologie</div>',
      '    <div class="dc-modal__subtitle">' + escHtml(editor.medicationName || 'Médicament') + '</div>',
      '  </div>',
      '  <div class="sp-form dc-modal__fields">',
      '    <div class="dc-modal__panel">',
      '      <div class="dc-modal__grid">',
      '        <label class="sp-field"><span class="sp-field__label">Nombre de prises</span><input type="number" min="1" max="' + escHtml(draft.freqUnit === 'jour' ? '6' : '12') + '" class="sp-input" data-role="med-editor-nb" value="' + escHtml(String(draft.nb || 1)) + '" /></label>',
      '        <label class="sp-field"><span class="sp-field__label">Fréquence</span><select class="sp-select" data-role="med-editor-freq"><option value="jour"' + (draft.freqUnit === 'jour' ? ' selected' : '') + '>Par jour</option><option value="semaine"' + (draft.freqUnit === 'semaine' ? ' selected' : '') + '>Par semaine</option></select></label>',
      '        <div class="sp-field"><span class="sp-field__label">Durée</span><div class="dc-modal__inline"><input type="number" min="1" class="sp-input" data-role="med-editor-duration" value="' + escHtml(String(draft.durationVal || 1)) + '" /><select class="sp-select" data-role="med-editor-duration-unit"><option value="jour"' + (draft.durationUnit === 'jour' ? ' selected' : '') + '>jours</option><option value="mois"' + (draft.durationUnit === 'mois' ? ' selected' : '') + '>mois</option></select></div></div>',
      '      </div>',
      '    </div>',
           rowsHtml,
      '    <label class="sp-field"><span class="sp-field__label">Précisions de prise (optionnel)</span><textarea class="sp-textarea" rows="4" data-role="med-editor-note" placeholder="Ex: à prendre au cours du repas, le soir uniquement…">' + escHtml(draft.note || '') + '</textarea></label>',
      '  </div>',
      '  <div class="dc-modal__actions">',
      '    <button type="button" class="sp-button sp-button--secondary" data-action="close-med-modal">Annuler</button>',
      '    <button type="button" class="sp-button sp-button--primary" data-action="save-med-modal">Enregistrer</button>',
      '  </div>',
      '</div>'
    ].join('');

    if (focusSpec && focusSpec.role) {
      window.setTimeout(function () {
        var selector = '[data-role="' + String(focusSpec.role) + '"]';
        if (focusSpec.index !== undefined) {
          selector += '[data-index="' + String(focusSpec.index) + '"]';
        }
        var focusNode = body.querySelector(selector);
        if (focusNode && typeof focusNode.focus === 'function') {
          focusNode.focus();
          if (focusNode.select && (focusSpec.role === 'med-editor-dose' || focusSpec.role === 'med-editor-note')) {
            focusNode.select();
          }
        }
      }, 0);
    }
  }

  function closeMedicationEditor() {
    state.medEditor = null;
    var dialog = getMedicationDialog();
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      if (dialog.open) {
        dialog.close();
      }
      return;
    }
    dialog.removeAttribute('open');
  }

  function openMedicationEditor(index) {
    var detailId = Number(state.selectedId || 0);
    if (detailId < 1) return;

    var detail = asObject(state.details[detailId]);
    var items = safeArray(detail.items);
    var item = items[index];
    if (!item) return;

    var dialog = getMedicationDialog();
    if (!dialog) return;

    state.medEditor = {
      detailId: detailId,
      index: index,
      medicationName: firstText([
        item && item.denomination,
        item && item.label,
        asObject(item && item.raw).label,
        'Médicament'
      ]),
      draft: buildEditableSchedule(item)
    };

    renderMedicationDialogInto({ role: 'med-editor-nb' });

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      dialog.setAttribute('open', 'open');
    }
  }

  function syncMedicationEditorDraftFromDialog() {
    var editor = asObject(state.medEditor);
    if (!editor.detailId) {
      return normalizeMedicationEditorDraft({});
    }

    var dialog = getMedicationDialog();
    if (!dialog) {
      return normalizeMedicationEditorDraft(editor.draft);
    }

    var draft = cloneValue(asObject(editor.draft));
    var nbEl = dialog.querySelector('[data-role="med-editor-nb"]');
    var freqEl = dialog.querySelector('[data-role="med-editor-freq"]');
    var durationEl = dialog.querySelector('[data-role="med-editor-duration"]');
    var durationUnitEl = dialog.querySelector('[data-role="med-editor-duration-unit"]');
    var noteEl = dialog.querySelector('[data-role="med-editor-note"]');

    if (nbEl) draft.nb = nbEl.value;
    if (freqEl) draft.freqUnit = freqEl.value;
    if (durationEl) draft.durationVal = durationEl.value;
    if (durationUnitEl) draft.durationUnit = durationUnitEl.value;
    if (noteEl) draft.note = noteEl.value;

    if (normalizeScheduleUnit(draft.freqUnit) !== 'semaine') {
      var timeNodes = dialog.querySelectorAll('[data-role="med-editor-time"]');
      var doseNodes = dialog.querySelectorAll('[data-role="med-editor-dose"]');
      draft.times = Array.prototype.map.call(timeNodes, function (node) {
        return normalizeText(node && node.value);
      });
      draft.doses = Array.prototype.map.call(doseNodes, function (node) {
        return normalizeText(node && node.value) || '1';
      });
      if (draft.times.length > 0) {
        draft.start = normalizeText(draft.times[0]) || draft.start;
        draft.end = normalizeText(draft.times[draft.times.length - 1]) || draft.end;
      }
    }

    draft = normalizeMedicationEditorDraft(draft);
    state.medEditor.draft = draft;
    return draft;
  }

  function saveMedicationEditor() {
    var editor = asObject(state.medEditor);
    var detailId = Number(editor.detailId || 0);
    var index = Number(editor.index || 0);
    if (detailId < 1) return;

    var detail = cloneValue(asObject(state.details[detailId]));
    var items = safeArray(detail.items);
    if (!items[index]) return;

    var schedule = syncMedicationEditorDraftFromDialog();
    items[index] = buildUpdatedMedicationItem(items[index], schedule);
    detail.items = items;
    state.details[detailId] = detail;
    state.editedItems[detailId] = cloneValue(items);

    closeMedicationEditor();
    if (Number(state.selectedId) === detailId) {
      renderDetail();
    }
    patchInboxItemById(detailId);
  }

  function renderRefusalPanel() {
    if (!state.refusalOpen) return '';

    var activeId = Number(state.selectedId || 0);
    var isRejecting = hasPendingAction(activeId, 'rejected');

    return [
      '<div class="dc-refusal-panel">',
      '  <div class="sp-field">',
      '    <label class="sp-field__label" for="dc-refusal-reason">Motif du refus</label>',
      '    <textarea id="dc-refusal-reason" class="sp-textarea" data-role="refusal-reason" placeholder="Précisez le motif clinique ou administratif…"' + (isRejecting ? ' disabled' : '') + '>' + escHtml(state.refusalReason) + '</textarea>',
      '  </div>',
      '  <div class="dc-refusal-actions">',
      '    <button type="button" class="sp-button sp-button--danger' + (isRejecting ? ' is-loading' : '') + '" data-action="confirm-reject"' + (isRejecting ? ' disabled' : '') + '>' + (isRejecting ? 'Refus...' : 'Confirmer le refus') + '</button>',
      '    <button type="button" class="sp-button sp-button--secondary" data-action="cancel-reject"' + (isRejecting ? ' disabled' : '') + '>Annuler</button>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function renderPdfPlaceholder(message) {
    return [
      '<div class="dc-pdf-card">',
      '  <div class="dc-card__title">Ordonnance PDF</div>',
      '  <div class="dc-pdf-placeholder">' + escHtml(message) + '</div>',
      '</div>'
    ].join('');
  }

  function buildPdfCard(downloadUrl) {
    return [
      '<div class="dc-pdf-card">',
      '  <div class="dc-card__title">Ordonnance PDF</div>',
      '  <div class="dc-pdf-actions">',
      '    <a class="sp-button sp-button--secondary dc-pdf-open" href="' + escHtml(downloadUrl) + '" target="_blank" rel="noopener noreferrer">Ouvrir le PDF</a>',
      '  </div>',
      '  <iframe class="dc-pdf-frame" src="' + escHtml(iframeSrcFromDownloadUrl(downloadUrl)) + '" loading="lazy"></iframe>',
      '</div>'
    ].join('');
  }

  function renderPdfInto(slot, detail) {
    if (!slot) return;

    var detailId = Number(detail && detail.id || 0);
    var decisionStatus = normalizeText(detail && detail.status || '').toLowerCase();
    if (decisionStatus !== 'approved') {
      slot.hidden = true;
      slot.innerHTML = '';
      slot.setAttribute('data-rendered-case-id', String(detailId));
      slot.setAttribute('data-pdf-doc-key', '');
      slot.setAttribute('data-pdf-signed-url', '');
      return;
    }

    slot.hidden = false;

    var pdf = extractPdfState(detailId);
    var status = normalizeText(pdf.status || 'pending').toLowerCase();
    var message = firstText([
      pdf.message,
      pdf.last_error_message,
      status === 'done' ? 'PDF prêt.' : (status === 'failed' ? 'Le PDF n’est pas disponible.' : 'PDF en cours de génération.')
    ]);
    var downloadUrl = normalizeText(pdf.download_url);
    var nextDocKey = stablePdfDocumentKey(downloadUrl);
    var currentCaseId = Number(slot.getAttribute('data-rendered-case-id') || 0);
    var currentDocKey = normalizeText(slot.getAttribute('data-pdf-doc-key'));
    var hasCard = !!slot.querySelector('.dc-pdf-card');
    var frame = slot.querySelector('.dc-pdf-frame');
    var openLink = slot.querySelector('.dc-pdf-open');

    if (!downloadUrl) {
      if (status === 'done' && currentCaseId === detailId && hasCard && frame) {
        return;
      }

      var nextPlaceholderHtml = renderPdfPlaceholder(message);
      if (slot.innerHTML !== nextPlaceholderHtml) {
        slot.innerHTML = nextPlaceholderHtml;
      }
      slot.setAttribute('data-rendered-case-id', String(detailId));
      slot.setAttribute('data-pdf-doc-key', '');
      slot.setAttribute('data-pdf-signed-url', '');
      return;
    }

    if (!hasCard || currentCaseId !== detailId || !frame || !openLink) {
      slot.innerHTML = buildPdfCard(downloadUrl);
      slot.setAttribute('data-rendered-case-id', String(detailId));
      slot.setAttribute('data-pdf-doc-key', nextDocKey);
      slot.setAttribute('data-pdf-signed-url', downloadUrl);
      return;
    }

    openLink.setAttribute('href', downloadUrl);
    slot.setAttribute('data-pdf-signed-url', downloadUrl);

    if (currentDocKey === nextDocKey) {
      return;
    }

    frame.setAttribute('src', iframeSrcFromDownloadUrl(downloadUrl));
    slot.setAttribute('data-pdf-doc-key', nextDocKey);
  }

  function renderDetailTabs(detail) {
    var detailId = Number(detail && detail.id || state.selectedId || 0);
    var thread = extractThreadShadowState(detail);
    var evidence = extractEvidenceShadowState(detail);
    var unread = Number(thread.unread_count_doctor || 0);
    var hasProof = !!evidence.has_proof || Number(evidence.proof_count || 0) > 0 || extractProofArtifactIds(detail).length > 0;
    var tabs = [
      { key: 'prescription', label: 'Ordonnance' },
      { key: 'proofs', label: 'Preuves', badge: hasProof ? '•' : '' },
      { key: 'messages', label: 'Messages', badge: unread > 0 ? (unread > 9 ? '9+' : String(unread)) : '' }
    ];

    return tabs.map(function (tab) {
      var active = tab.key === state.detailTab;
      var badgeHtml = tab.badge ? '<span class="dc-pill ' + (tab.key === 'messages' ? 'dc-pill-danger' : 'dc-pill-soft') + '">' + escHtml(tab.badge) + '</span>' : '';
      return '<button type="button" class="dc-detail-tab' + (active ? ' is-active' : '') + '" data-action="set-detail-tab" data-tab="' + escHtml(tab.key) + '">' + escHtml(tab.label) + (badgeHtml ? ' ' + badgeHtml : '') + '</button>';
    }).join('');
  }


  function buildProofViewerHtml(accessPayload, opts) {
    opts = opts || {};
    var normalized = normalizeArtifactAccessPayload(accessPayload);
    var artifact = asObject(normalized.artifact);
    var access = asObject(normalized.access);
    var frameClass = normalizeText(opts.frameClass) || 'dc-proof-viewer__frame';
    var imageClass = normalizeText(opts.imageClass) || 'dc-proof-viewer__image';
    var imageButtonClass = normalizeText(opts.imageButtonClass) || 'dc-proof-viewer__image-button';
    var placeholderClass = normalizeText(opts.placeholderClass) || 'dc-proof-placeholder';
    var emptyMessage = normalizeText(opts.emptyMessage) || 'Sélectionnez une preuve pour l’afficher.';
    var accessUrl = getArtifactAccessUrl(normalized);
    if (!accessUrl) {
      return '<div class="' + escHtml(placeholderClass) + '">' + escHtml(emptyMessage) + '</div>';
    }
    var mime = getArtifactAccessMimeType(normalized);
    var label = normalizeText(opts.label) || normalizeText(artifact.original_name) || 'Preuve médicale';
    if (isPdfMimeType(mime)) {
      return '<iframe class="' + escHtml(frameClass) + '" src="' + escHtml(String(accessUrl)) + '#toolbar=0&view=FitH" loading="lazy"></iframe>';
    }
    return [
      '<button type="button" class="' + escHtml(imageButtonClass) + '" data-action="open-proof-lightbox" data-proof-url="' + escHtml(String(accessUrl)) + '" data-proof-label="' + escHtml(label) + '">',
      '  <img class="' + escHtml(imageClass) + '" src="' + escHtml(String(accessUrl)) + '" alt="' + escHtml(label) + '" loading="lazy" />',
      '</button>'
    ].join('');
  }

  function renderInlineProofPanel(detail) {
    var detailId = Number(detail && detail.id || state.selectedId || 0);
    var proofStore = syncProofStoreFromDetail(detailId, detail);
    var ids = safeArray(proofStore.ids);
    if (ids.length < 1) {
      return '';
    }

    var selectedId = proofStore.selectedId || ids[0];
    var accessPayload = normalizeArtifactAccessPayload(asObject(asObject(proofStore.accessById)[selectedId]));
    var artifact = asObject(accessPayload.artifact);
    var access = asObject(accessPayload.access);
    var viewerHtml = '';

    if (proofStore.accessLoading && !access.url) {
      viewerHtml = '<div class="dc-inline-proof-card__placeholder">Chargement de la preuve…</div>';
    } else if (proofStore.accessError && !getArtifactAccessUrl(accessPayload)) {
      viewerHtml = renderProofErrorHtml(proofStore.accessError, selectedId, 'dc-inline-proof-card__placeholder');
    } else {
      viewerHtml = buildProofViewerHtml(accessPayload, {
        frameClass: 'dc-inline-proof-card__frame',
        imageClass: 'dc-inline-proof-card__image',
        imageButtonClass: 'dc-inline-proof-card__image-button',
        placeholderClass: 'dc-inline-proof-card__placeholder',
        emptyMessage: 'Sélectionnez une preuve pour l’afficher.',
        label: normalizeText(artifact.original_name) || 'Preuve médicale'
      });
    }

    var pickerHtml = ids.length > 1 ? '<div class="dc-inline-proof-card__picker">' + ids.map(function (artifactId, index) {
      var currentPayload = normalizeArtifactAccessPayload(asObject(asObject(proofStore.accessById)[artifactId]));
      var currentArtifact = asObject(currentPayload.artifact);
      var label = normalizeText(currentArtifact.original_name) || ('Preuve ' + String(index + 1));
      var meta = normalizeText(currentArtifact.mime_type) || 'Document';
      return '<button type="button" class="dc-proof-item' + (artifactId === selectedId ? ' is-active' : '') + '" data-action="select-proof" data-artifact-id="' + escHtml(artifactId) + '"><div class="dc-proof-item__title">' + escHtml(label) + '</div><div class="dc-proof-item__meta">' + escHtml(meta) + '</div></button>';
    }).join('') + '</div>' : '';

    var inlineAccessUrl = getArtifactAccessUrl(accessPayload);
    var inlineMime = getArtifactAccessMimeType(accessPayload);
    var openButtonHtml = '';
    if (inlineAccessUrl) {
      openButtonHtml = isPdfMimeType(inlineMime)
        ? '<a class="sp-button sp-button--secondary" href="' + escHtml(String(inlineAccessUrl)) + '" target="_blank" rel="noopener noreferrer">Ouvrir</a>'
        : '<button type="button" class="sp-button sp-button--secondary" data-action="open-proof-lightbox" data-proof-url="' + escHtml(String(inlineAccessUrl)) + '" data-proof-label="' + escHtml(normalizeText(artifact.original_name) || 'Preuve médicale') + '">Agrandir</button>';
    }

    var titleLabel = normalizeText(artifact.original_name) || 'Preuve médicale';
    var titleMeta = normalizeText(artifact.mime_type) || 'Document';

    return [
      '<div class="dc-inline-proof-card">',
      '  <div class="dc-inline-proof-card__head">',
      '    <div>',
      '      <div class="dc-inline-proof-card__title">Preuve médicale</div>',
      '      <div class="dc-inline-proof-card__meta">' + escHtml(titleLabel) + ' • ' + escHtml(titleMeta) + '</div>',
      '    </div>',
      openButtonHtml,
      '  </div>',
      pickerHtml,
      '  <div class="dc-inline-proof-card__viewer">' + viewerHtml + '</div>',
      '</div>'
    ].join('');
  }

  function renderProofPanel(detail) {
    var detailId = Number(detail && detail.id || state.selectedId || 0);
    var flowKey = extractFlowKey(detail);
    var proofStore = syncProofStoreFromDetail(detailId, detail);
    var ids = safeArray(proofStore.ids);

    if (ids.length < 1) {
      if (flowKey === 'depannage_no_proof') {
        return '<div class="dc-proof-placeholder">Aucune preuve fournie : dossier en mode dépannage.</div>';
      }
      return '<div class="dc-proof-placeholder">Aucune preuve disponible pour ce dossier.</div>';
    }

    var selectedId = proofStore.selectedId || ids[0];
    var accessPayload = normalizeArtifactAccessPayload(asObject(asObject(proofStore.accessById)[selectedId]));
    var artifact = asObject(accessPayload.artifact);
    var access = asObject(accessPayload.access);
    var viewerHtml = '';
    if (proofStore.accessLoading && !access.url) {
      viewerHtml = '<div class="dc-proof-placeholder">Chargement de la preuve…</div>';
    } else if (proofStore.accessError && !getArtifactAccessUrl(accessPayload)) {
      viewerHtml = renderProofErrorHtml(proofStore.accessError, selectedId, 'dc-proof-placeholder');
    } else {
      viewerHtml = buildProofViewerHtml(accessPayload, {
        frameClass: 'dc-proof-viewer__frame',
        imageClass: 'dc-proof-viewer__image',
        imageButtonClass: 'dc-proof-viewer__image-button',
        placeholderClass: 'dc-proof-placeholder',
        emptyMessage: 'Sélectionnez une preuve pour l’afficher.',
        label: normalizeText(artifact.original_name) || 'Preuve médicale'
      });
    }

    return [
      '<div class="dc-proof-layout">',
      '  <div class="dc-proof-list">',
      ids.map(function (artifactId, index) {
        var currentPayload = normalizeArtifactAccessPayload(asObject(asObject(proofStore.accessById)[artifactId]));
        var currentArtifact = asObject(currentPayload.artifact);
        var label = normalizeText(currentArtifact.original_name) || ('Preuve ' + String(index + 1));
        var meta = normalizeText(currentArtifact.mime_type) || 'Document';
        return '<button type="button" class="dc-proof-item' + (artifactId === selectedId ? ' is-active' : '') + '" data-action="select-proof" data-artifact-id="' + escHtml(artifactId) + '"><div class="dc-proof-item__title">' + escHtml(label) + '</div><div class="dc-proof-item__meta">' + escHtml(meta) + '</div></button>';
      }).join(''),
      '  </div>',
      '  <div class="dc-proof-viewer">' + viewerHtml + '</div>',
      '</div>'
    ].join('');
  }

  function renderMessagesPanel(detail) {
    var detailId = Number(detail && detail.id || state.selectedId || 0);
    return [
      '<div class="dc-message-react-shell">',
      '  <div class="dc-message-react-host" data-sp-doctor-chat-root="1" data-prescription-id="' + escHtml(detailId) + '">',
      '    <div class="dc-message-empty">Chargement de la messagerie sécurisée…</div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function buildDetailSkeleton(detailId) {
    return [
      '<div class="dc-detail-pane" data-dc-detail-pane data-case-id="' + escHtml(detailId) + '">',
      '  <div class="dc-detail-head">',
      '    <div class="dc-detail-head__main">',
      '      <div class="dc-overline">Dossier patient</div>',
      '      <h2 class="dc-patient-name" data-dc-patient-name></h2>',
      '      <div class="dc-patient-meta" data-dc-patient-meta></div>',
      '    </div>',
      '    <div class="dc-detail-head__aside" data-dc-header-badges></div>',
      '  </div>',
      '  <div class="dc-detail-tabs" data-dc-detail-tabs></div>',
      '  <div class="dc-detail-panel" data-dc-panel="prescription">',
      '    <div class="dc-prescription-layout" data-dc-prescription-layout>',
      '      <div class="dc-prescription-main">',
      '        <div class="dc-summary-card" data-dc-summary-card hidden>',
      '          <div class="dc-card__title">Patient</div>',
      '          <div class="dc-summary-grid">',
      '            <div class="dc-summary-row" data-dc-summary-weight-row hidden><span>POIDS</span><strong data-dc-summary-weight></strong></div>',
      '            <div class="dc-summary-row dc-summary-row--notes" data-dc-summary-notes-row hidden><span>PRÉCISIONS MÉDICALES</span><strong data-dc-summary-notes></strong></div>',
      '          </div>',
      '        </div>',
      '        <div class="dc-meds-card">',
      '          <div class="dc-card__title">Ordonnance</div>',
      '          <div data-dc-meds></div>',
      '        </div>',
      '        <div data-dc-pdf-slot></div>',
      '        <div class="dc-decisionbar">',
      '          <button type="button" class="sp-button sp-button--primary" data-action="approve" data-dc-approve>VALIDER</button>',
      '          <button type="button" class="sp-button sp-button--danger" data-action="toggle-reject" data-dc-reject>REFUSER</button>',
      '        </div>',
      '        <div data-dc-refusal-slot></div>',
      '      </div>',
      '      <aside class="dc-prescription-side">',
      '        <div data-dc-inline-proof-slot></div>',
      '      </aside>',
      '    </div>',
      '  </div>',
      '  <div class="dc-detail-panel" data-dc-panel="proofs"></div>',
      '  <div class="dc-detail-panel" data-dc-panel="messages"></div>',
      '</div>'
    ].join('');
  }

  function patchDetailContent(detailEl, detail) {
    var pane = detailEl.querySelector('[data-dc-detail-pane]');
    if (!pane) return;

    var detailId = Number(detail && detail.id || state.selectedId || 0);
    var patient = extractPatientData(detail);
    var status = normalizeText(detail.status || 'pending').toLowerCase();
    var isCasePending = hasPendingAction(detailId);
    var canDecide = !isCasePending && status !== 'approved' && status !== 'rejected';
    var code = patient.verifyCode;

    var nameEl = detailEl.querySelector('[data-dc-patient-name]');
    if (nameEl) nameEl.textContent = patient.fullname;

    var metaEl = detailEl.querySelector('[data-dc-patient-meta]');
    if (metaEl) metaEl.textContent = patient.birthDate + ' • ' + patient.createdAt;

    var caseUid = extractCaseUid(detail);
    var headerBadges = detailEl.querySelector('[data-dc-header-badges]');
    if (headerBadges) {
      setHtmlIfChanged(headerBadges, [
        caseUid ? statusBadge('Demande : ' + caseUid, 'soft') : '',
        code ? statusBadge('Code délivrance : ' + code, 'soft') : '',
        statusBadge(patient.priority, patient.priority === 'Express' ? 'warn' : 'soft')
      ].join(''));
    }

    var detailTabs = detailEl.querySelector('[data-dc-detail-tabs]');
    if (detailTabs) {
      setHtmlIfChanged(detailTabs, renderDetailTabs(detail));
    }

    Array.prototype.slice.call(detailEl.querySelectorAll('[data-dc-panel]')).forEach(function (panel) {
      panel.classList.toggle('is-active', normalizeText(panel.getAttribute('data-dc-panel') || panel.getAttribute('data-panel')).toLowerCase() === state.detailTab);
    });

    var summaryCard = detailEl.querySelector('[data-dc-summary-card]');
    var weightRow = detailEl.querySelector('[data-dc-summary-weight-row]');
    var weightEl = detailEl.querySelector('[data-dc-summary-weight]');
    var notesRow = detailEl.querySelector('[data-dc-summary-notes-row]');
    var notesEl = detailEl.querySelector('[data-dc-summary-notes]');
    var medicalNotes = extractMedicalNotes(detail);
    if (summaryCard) {
      summaryCard.hidden = false;
    }
    if (weightRow && weightEl) {
      weightEl.textContent = patient.weight || 'Non renseigné';
      weightRow.hidden = false;
    }
    if (notesRow && notesEl) {
      if (medicalNotes) {
        setHtmlIfChanged(notesEl, preserveLineBreaksHtml(medicalNotes));
        notesRow.hidden = false;
      } else {
        setHtmlIfChanged(notesEl, '');
        notesRow.hidden = true;
      }
    }

    var medsEl = detailEl.querySelector('[data-dc-meds]');
    if (medsEl) setHtmlIfChanged(medsEl, renderMedicationList(detail));

    var approveBtn = detailEl.querySelector('[data-dc-approve]');
    if (approveBtn) {
      var approving = hasPendingAction(detailId, 'approved');
      approveBtn.textContent = approving ? 'Validation...' : 'VALIDER';
      approveBtn.disabled = !canDecide;
      approveBtn.classList.toggle('is-loading', approving);
    }

    var rejectBtn = detailEl.querySelector('[data-dc-reject]');
    if (rejectBtn) {
      var rejecting = hasPendingAction(detailId, 'rejected');
      rejectBtn.textContent = rejecting ? 'Refus...' : 'REFUSER';
      rejectBtn.disabled = !canDecide;
      rejectBtn.classList.toggle('is-loading', rejecting);
    }

    var refusalSlot = detailEl.querySelector('[data-dc-refusal-slot]');
    if (refusalSlot) {
      setHtmlIfChanged(refusalSlot, canDecide ? renderRefusalPanel() : '');
    }

    var pdfSlot = detailEl.querySelector('[data-dc-pdf-slot]');
    renderPdfInto(pdfSlot, detail);

    var inlineProofSlot = detailEl.querySelector('[data-dc-inline-proof-slot]');
    var inlineProofHtml = renderInlineProofPanel(detail);
    if (inlineProofSlot) {
      setHtmlIfChanged(inlineProofSlot, inlineProofHtml);
    }
    var prescriptionLayout = detailEl.querySelector('[data-dc-prescription-layout]');
    if (prescriptionLayout) {
      prescriptionLayout.classList.toggle('has-proof', normalizeText(inlineProofHtml) !== '');
    }

    var proofsPanel = detailEl.querySelector('[data-dc-panel="proofs"]');
    if (proofsPanel) {
      setHtmlIfChanged(proofsPanel, renderProofPanel(detail));
    }

    var messagesPanel = detailEl.querySelector('[data-dc-panel="messages"]');
    if (messagesPanel && messagesPanel.getAttribute('data-sp-chat-owned') !== '1') {
      setHtmlIfChanged(messagesPanel, renderMessagesPanel(detail));
    }
    syncDoctorMessagingMount(detailEl, detail);

    if (state.detailTab === 'proofs') {
      var proofStore = syncProofStoreFromDetail(detailId, detail);
      if (proofStore.selectedId && !getArtifactAccessUrl(asObject(asObject(proofStore.accessById)[proofStore.selectedId])) && !proofStore.accessLoading) {
        loadProofAccess(detailId, proofStore.selectedId);
      }
    } else if (state.detailTab === 'prescription') {
      var inlineProofStore = syncProofStoreFromDetail(detailId, detail);
      if (inlineProofStore.selectedId && !getArtifactAccessUrl(asObject(asObject(inlineProofStore.accessById)[inlineProofStore.selectedId])) && !inlineProofStore.accessLoading) {
        loadProofAccess(detailId, inlineProofStore.selectedId);
      }
    }
  }

  function renderDetail() {
    var ui = ensureShell();
    var detailEl = ui.detail;

    if (!state.selectedId) {
      destroyDoctorMessagingHosts(detailEl, null);
      detailEl.innerHTML = '<div class="dc-empty dc-empty-large">Sélectionnez une demande pour ouvrir le dossier.</div>';
      return;
    }

    var detail = asObject(state.details[state.selectedId]);
    if (!hasObjectKeys(detail)) {
      detailEl.innerHTML = state.detailLoading
        ? '<div class="dc-loading">Chargement du dossier…</div>'
        : '<div class="dc-empty dc-empty-large">Chargement du dossier…</div>';
      return;
    }

    var pane = detailEl.querySelector('[data-dc-detail-pane]');
    var renderedCaseId = pane ? Number(pane.getAttribute('data-case-id') || 0) : 0;

    if (!pane || renderedCaseId !== Number(state.selectedId)) {
      destroyDoctorMessagingHosts(detailEl, null);
      detailEl.innerHTML = buildDetailSkeleton(state.selectedId);
    }

    patchDetailContent(detailEl, detail);
  }

  function renderShell() {
    if (state.ui) return state.ui;

    root.innerHTML = [
      '<div class="sosprescription-doctor">',
      '  <div data-dc-notice></div>',
      '  <div class="dc-shell">',
      '    <aside class="dc-inbox">',
      '      <div class="dc-inbox__head">',
      '        <div>',
      '          <div class="dc-overline">Console médecin</div>',
      '          <h1 class="dc-title" data-dc-title>Demandes en attente</h1>',
      '          <div class="dc-subtitle">Connecté : ' + escHtml(currentUserName) + ' • synchronisation automatique</div>',
      '          <div class="dc-filter-tabs" data-dc-filter-tabs></div>',
      '        </div>',
      '      </div>',
      '      <div class="dc-inbox__list" data-dc-inbox-list></div>',
      '    </aside>',
      '    <section class="dc-detail" data-dc-detail></section>',
      '  </div>',
      '  <dialog id="dc-med-modal" class="dc-modal" data-dc-med-dialog>',
      '    <div data-dc-med-dialog-body></div>',
      '  </dialog>',
      '</div>'
    ].join('');

    state.ui = {
      notice: root.querySelector('[data-dc-notice]'),
      title: root.querySelector('[data-dc-title]'),
      filterTabs: root.querySelector('[data-dc-filter-tabs]'),
      inboxList: root.querySelector('[data-dc-inbox-list]'),
      detail: root.querySelector('[data-dc-detail]'),
      medDialog: root.querySelector('[data-dc-med-dialog]'),
      medDialogBody: root.querySelector('[data-dc-med-dialog-body]')
    };

    if (state.ui.medDialog) {
      state.ui.medDialog.addEventListener('close', function () {
        state.medEditor = null;
      });
      state.ui.medDialog.addEventListener('cancel', function () {
        state.medEditor = null;
      });
      state.ui.medDialog.addEventListener('click', function (event) {
        if (event.target === state.ui.medDialog) {
          closeMedicationEditor();
        }
      });
    }

    root.addEventListener('click', handleRootClick);
    root.addEventListener('change', handleRootChange);
    root.addEventListener('input', handleRootInput);

    return state.ui;
  }

  function ensureShell() {
    return renderShell();
  }

  function render() {
    ensureShell();
    cleanupHostToolbarMeta();
    renderHeaderInto();
    renderNoticeInto();
    patchInboxList();
    renderDetail();
  }

  function patchLocalDecisionState(id, decision, responsePayload) {
    var currentDetail = hasObjectKeys(state.details[id]) ? cloneValue(state.details[id]) : {};
    var row = currentDetail;
    row.id = Number(row.id || id);

    if (responsePayload && responsePayload.prescription) {
      row = cloneValue(responsePayload.prescription);
      if (safeArray(currentDetail.items).length > 0) {
        row.items = cloneValue(currentDetail.items);
      }
    }

    if (state.editedItems[id] && safeArray(state.editedItems[id]).length > 0) {
      row.items = cloneValue(state.editedItems[id]);
    }

    rememberOptimisticLock(id, decision);
    row = overlayDecisionOnRecord(row, decision);
    state.details[id] = row;

    if (decision === 'approved') {
      if (responsePayload && responsePayload.pdf) {
        state.pdf[id] = applyLocalDecisionToPdfState(id, responsePayload.pdf);
      } else {
        state.pdf[id] = applyLocalDecisionToPdfState(id, Object.assign({}, state.pdf[id], { status: 'pending' }));
      }
    } else if (decision === 'rejected') {
      state.pdf[id] = applyLocalDecisionToPdfState(id, Object.assign({}, state.pdf[id], { status: 'failed' }));
    }

    state.list = safeArray(state.list).map(function (item) {
      if (Number(item && item.id || 0) !== id) return item;
      var next = cloneValue(item) || {};
      next.id = id;
      return overlayDecisionOnRecord(next, decision);
    });
  }

  function hydrateVisibleCases() {
    safeArray(state.list).slice(0, 20).forEach(function (row) {
      var id = Number(row && row.id || 0);
      if (id < 1 || state.hydratedIds[id]) return;

      state.hydratedIds[id] = 'pending';
      fetchDetail(id, { silent: true, skipDetailRender: true }).then(function (detail) {
        if (detail) {
          state.hydratedIds[id] = true;
        } else {
          delete state.hydratedIds[id];
        }
      });
    });
  }

  function fetchList(opts) {
    opts = opts || {};
    var silent = !!opts.silent;

    if (!silent && state.list.length < 1) {
      state.listLoading = true;
      patchInboxList();
    }

    return requestJson('GET', buildListPath(), undefined, { timeoutMs: REQUEST_TIMEOUT_GET_MS }).then(function (rows) {
      var nextRows = sortListRowsByPriority(
        safeArray(rows)
          .map(applyPendingOverlayToRecord)
          .filter(rowMatchesActiveFilter)
      );
      var previousSelectedId = Number(state.selectedId || 0);
      var nextSelectedId = previousSelectedId;

      state.list = nextRows;
      state.listLoading = false;
      cleanupOptimisticLocks();
      patchInboxList();
      hydrateVisibleCases();

      if (nextRows.length < 1) {
        state.selectedId = 0;
        state.refusalOpen = false;
        state.refusalReason = '';
        state.detailLoading = false;
        renderDetail();
        return null;
      }

      var selectedStillExists = previousSelectedId > 0 && nextRows.some(function (item) {
        return Number(item && item.id || 0) === previousSelectedId;
      });

      if (!selectedStillExists) {
        nextSelectedId = Number(nextRows[0].id || 0);
      }

      if (nextSelectedId > 0 && nextSelectedId !== previousSelectedId) {
        return selectCase(nextSelectedId, { silent: true, preserveNotice: true });
      }

      return null;
    }).catch(function (error) {
      state.listLoading = false;
      patchInboxList();
      if (!silent) {
        showNotice('error', error.message || 'Impossible de charger la file de demandes.');
      }
      return null;
    });
  }

  function fetchDetail(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    var shouldRenderSelected = !opts.skipDetailRender && Number(state.selectedId) === numericId;

    if (shouldRenderSelected && !opts.silent) {
      state.detailLoading = true;
      renderDetail();
    }

    return requestJson('GET', '/prescriptions/' + numericId, undefined, { timeoutMs: REQUEST_TIMEOUT_GET_MS }).then(function (row) {
      var previousRow = asObject(state.details[numericId]);
      var nextRow = mergeDetailSnapshot(previousRow, applyPendingOverlayToRecord(row));
      if (state.editedItems[numericId] && safeArray(state.editedItems[numericId]).length > 0) {
        nextRow.items = cloneValue(state.editedItems[numericId]);
      }
      var detailChanged = !recordsEqual(previousRow, nextRow);
      state.details[numericId] = nextRow;

      if (Number(state.selectedId) === numericId) {
        state.detailLoading = false;
        if (!opts.skipDetailRender && (detailChanged || !opts.silent)) {
          renderDetail();
        }
      }

      patchInboxItemById(numericId);
      return nextRow;
    }).catch(function (error) {
      if (Number(state.selectedId) === numericId) {
        state.detailLoading = false;
        if (!opts.silent) {
          showNotice('error', error.message || 'Impossible de charger le dossier.');
        }
        if (!opts.skipDetailRender) {
          renderDetail();
        }
      }
      return null;
    });
  }

  function fetchPdfStatus(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    return requestJson('GET', '/prescriptions/' + numericId + '/pdf-status', undefined, { timeoutMs: REQUEST_TIMEOUT_GET_MS }).then(function (payload) {
      var currentPdf = asObject(state.pdf[numericId]);
      var nextPdf = payload && payload.pdf ? payload.pdf : {};
      var normalizedPdf = applyLocalDecisionToPdfState(numericId, nextPdf);
      var pdfChanged = !recordsEqual(currentPdf, normalizedPdf);
      state.pdf[numericId] = normalizedPdf;
      if (Number(state.selectedId) === numericId && (pdfChanged || !opts.silent)) {
        renderDetail();
      }
      return state.pdf[numericId];
    }).catch(function (error) {
      if (!opts.silent) {
        showNotice('error', error.message || 'Impossible de lire le statut PDF.');
      }
      if (Number(state.selectedId) === numericId && !opts.silent) {
        renderDetail();
      }
      return null;
    });
  }


  function shouldEnsureAssigned(row) {
    var status = normalizeText(row && row.status).toLowerCase();
    return status === 'pending' || status === 'in_review' || status === 'needs_info';
  }

  function ensureAssigned(rx) {
    var row = asObject(rx);
    var id = Number(row.id || 0);
    if (id < 1) return Promise.resolve(null);
    var assignedId = Number(row.doctor_user_id || 0);
    if (assignedId > 0 && assignedId === currentUserId) {
      return Promise.resolve(row);
    }

    return requestJson('POST', '/prescriptions/' + id + '/assign', {}, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS }).then(function (updated) {
      var previousRow = asObject(state.details[id]);
      var nextRow = mergeDetailSnapshot(previousRow, applyPendingOverlayToRecord(updated));
      var detailChanged = !recordsEqual(previousRow, nextRow);
      state.details[id] = nextRow;
      patchInboxItemById(id);
      if (Number(state.selectedId) === id && detailChanged) {
        renderDetail();
      }
      return nextRow;
    }).catch(function () {
      return row;
    });
  }

  function selectCase(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    var changed = Number(state.selectedId) !== numericId;
    closeProofLightbox();
    closeMedicationEditor();
    state.selectedId = numericId;
    state.refusalOpen = false;
    state.refusalReason = '';
    state.detailLoading = !hasObjectKeys(state.details[numericId]);

    if (!opts.preserveNotice) {
      clearNotice();
    }

    if (changed) {
      patchInboxList();
      renderDetail();
    } else if (state.detailLoading) {
      renderDetail();
    }

    return fetchDetail(numericId, { silent: !!opts.silent }).then(function (row) {
      if (!row) return null;
      if (!shouldEnsureAssigned(row)) {
        patchInboxItemById(numericId);
        return fetchPdfStatus(numericId, { silent: !!opts.silent });
      }
      return ensureAssigned(row).then(function (assignedRow) {
        patchInboxItemById(numericId);
        return fetchPdfStatus(numericId, { silent: !!opts.silent }).then(function () {
          return assignedRow || row;
        });
      });
    });
  }

  function refreshSelected() {
    var numericId = Number(state.selectedId || 0);
    if (numericId < 1) return Promise.resolve(null);
    if (state.refusalOpen && !hasPendingAction(numericId)) {
      return Promise.resolve(null);
    }

    return fetchDetail(numericId, { silent: true }).then(function () {
      if (Number(state.selectedId || 0) !== numericId) {
        return null;
      }

      return fetchPdfStatus(numericId, { silent: true });
    });
  }

  function findNextPendingCaseId(currentId) {
    var rows = safeArray(state.list);
    if (rows.length < 1) return 0;

    var currentIndex = rows.findIndex(function (item) {
      return Number(item && item.id || 0) === Number(currentId || 0);
    });
    if (currentIndex < 0) currentIndex = 0;

    for (var offset = 1; offset <= rows.length; offset += 1) {
      var idx = (currentIndex + offset) % rows.length;
      var row = rows[idx];
      var rowId = Number(row && row.id || 0);
      if (rowId < 1 || rowId === Number(currentId || 0)) continue;

      var detail = asObject(state.details[rowId]);
      var source = hasObjectKeys(detail) ? detail : row;
      var statusInfo = computeCaseStatus(source);
      if (statusInfo.label === 'À traiter') {
        return rowId;
      }
    }

    return 0;
  }

  function submitDecision(decision) {
    var id = Number(state.selectedId || 0);
    if (id < 1 || hasPendingAction(id)) return;

    var normalizedDecision = normalizeText(decision).toLowerCase();
    var reason = state.refusalReason.trim();
    if (normalizedDecision === 'rejected' && reason === '') {
      showNotice('error', 'Merci de renseigner un motif de refus.');
      return;
    }

    var nextPendingId = normalizedDecision === 'approved' ? findNextPendingCaseId(id) : 0;

    rememberPendingAction(id, normalizedDecision);
    patchLocalDecisionState(id, normalizedDecision, null);
    state.refusalOpen = false;
    state.refusalReason = '';

    if (normalizedDecision === 'approved') {
      showNotice('info', nextPendingId > 0 ? 'Validation en cours. Passage automatique au dossier suivant.' : 'Validation en cours.');
      patchInboxList();
      if (nextPendingId > 0) {
        selectCase(nextPendingId, { preserveNotice: true, silent: true });
      } else {
        renderDetail();
      }
    } else {
      showNotice('info', 'Refus en cours d’enregistrement.');
      render();
    }

    var payload = {
      decision: normalizedDecision
    };
    if (normalizedDecision === 'approved') {
      payload.items = cloneValue(safeArray(asObject(state.details[id]).items));
    } else {
      payload.reason = reason;
    }

    requestJson('POST', '/prescriptions/' + id + '/decision', payload, { timeoutMs: REQUEST_TIMEOUT_MUTATION_MS }).then(function (responsePayload) {
      clearPendingAction(id);
      markOptimisticLockConfirmed(id, normalizedDecision);
      patchLocalDecisionState(id, normalizedDecision, responsePayload);
      patchInboxList();
      patchInboxItemById(id);

      if (normalizedDecision === 'approved') {
        showNotice('success', 'Ordonnance validée. Le PDF est en cours de préparation.');
      } else {
        showNotice('warning', 'Ordonnance refusée.');
      }

      if (Number(state.selectedId) === id) {
        renderDetail();
      }

      fetchList({ silent: true });
    }).catch(function (error) {
      rollbackPendingAction(id);
      patchInboxList();
      if (Number(state.selectedId) === id || !state.selectedId) {
        renderDetail();
      }
      showNotice('error', error.message || 'Impossible d’enregistrer la décision.');
    });
  }

  function getPollDelay() {
    return document.hidden ? 30000 : 15000;
  }

  function stopPolling() {
    if (state.pollHandle) {
      clearTimeout(state.pollHandle);
      state.pollHandle = null;
    }
  }

  function scheduleNextPoll(delayMs) {
    stopPolling();
    state.pollHandle = setTimeout(runPollCycle, Math.max(1000, Number(delayMs || getPollDelay())));
  }

  function finalizePollCycle(nextDelay) {
    state.pollInFlight = false;
    scheduleNextPoll(nextDelay);
  }

  function runPollCycle() {
    if (state.pollInFlight) {
      scheduleNextPoll(5000);
      return;
    }

    state.pollInFlight = true;

    var chain;
    try {
      chain = Promise.resolve()
        .then(function () {
          return fetchList({ silent: true });
        })
        .then(function () {
          if (state.selectedId) {
            return refreshSelected();
          }
          return null;
        });
    } catch (error) {
      finalizePollCycle(5000);
      return;
    }

    chain.then(function () {
      finalizePollCycle(getPollDelay());
    }, function () {
      finalizePollCycle(5000);
    });
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      scheduleNextPoll(getPollDelay());
      return;
    }

    if (!state.pollInFlight) {
      scheduleNextPoll(1200);
    }
  }

  function startPolling() {
    stopPolling();

    if (!state.visibilityBound) {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      state.visibilityBound = true;
    }

    scheduleNextPoll(getPollDelay());
  }

  function handleRootClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var actionEl = target.closest('[data-action]');
    if (!actionEl || !root.contains(actionEl)) return;

    var action = normalizeText(actionEl.getAttribute('data-action')).toLowerCase();
    if (!action) return;

    if (action === 'set-filter') {
      closeMedicationEditor();
      setListFilter(actionEl.getAttribute('data-filter') || 'pending');
      return;
    }

    if (action === 'set-detail-tab') {
      setDetailTab(actionEl.getAttribute('data-tab') || 'prescription');
      return;
    }

    if (action === 'select') {
      selectCase(Number(actionEl.getAttribute('data-id') || 0));
      return;
    }

    if (action === 'retry-proof') {
      var retryArtifactId = normalizeText(actionEl.getAttribute('data-artifact-id'));
      var retryDetailId = Number(state.selectedId || 0);
      if (retryDetailId > 0 && retryArtifactId) {
        setProofStore(retryDetailId, { selectedId: retryArtifactId, accessError: '' });
        renderDetail();
        loadProofAccess(retryDetailId, retryArtifactId, { force: true });
      }
      return;
    }

    if (action === 'select-proof') {
      var proofArtifactId = normalizeText(actionEl.getAttribute('data-artifact-id'));
      var proofDetailId = Number(state.selectedId || 0);
      if (proofDetailId > 0 && proofArtifactId) {
        setProofStore(proofDetailId, { selectedId: proofArtifactId, accessError: '' });
        renderDetail();
        loadProofAccess(proofDetailId, proofArtifactId);
      }
      return;
    }

    if (action === 'open-proof-lightbox') {
      openProofLightbox(actionEl.getAttribute('data-proof-url') || '', actionEl.getAttribute('data-proof-label') || 'Preuve médicale');
      return;
    }

    if (action === 'close-proof-lightbox') {
      closeProofLightbox();
      return;
    }

    if (action === 'open-message-attachment') {
      var attachmentId = normalizeText(actionEl.getAttribute('data-artifact-id'));
      var attachmentDetailId = Number(state.selectedId || 0);
      if (attachmentDetailId > 0 && attachmentId) {
        openMessageAttachment(attachmentDetailId, attachmentId).catch(function (error) {
          showNotice('error', error && error.message ? String(error.message) : 'Impossible d’ouvrir la pièce jointe.');
        });
      }
      return;
    }

    if (action === 'pick-message-files') {
      var fileInput = root.querySelector('[data-role="message-file-input"]');
      if (fileInput && typeof fileInput.click === 'function') {
        fileInput.click();
      }
      return;
    }

    if (action === 'remove-message-upload') {
      removeQueuedMessageFile(Number(state.selectedId || 0), actionEl.getAttribute('data-artifact-id') || '');
      return;
    }

    if (action === 'send-message') {
      sendThreadMessage(Number(state.selectedId || 0));
      return;
    }

    if (action === 'mark-messages-read') {
      var detailId = Number(state.selectedId || 0);
      if (detailId > 0) {
        var thread = getThreadStore(detailId);
        var lastSeq = Number(asObject(thread.threadState).last_message_seq || extractThreadShadowState(state.details[detailId]).last_message_seq || 0);
        apiMarkMessagesRead(detailId, lastSeq).then(function (payload) {
          var nextThreadState = asObject(payload && payload.thread_state);
          if (hasObjectKeys(nextThreadState)) {
            setThreadStore(detailId, { threadState: nextThreadState });
            patchLocalThreadState(detailId, nextThreadState);
            renderDetail();
            patchInboxList();
          }
        }).catch(function (error) {
          showNotice('error', error && error.message ? String(error.message) : 'Impossible de marquer les messages comme lus.');
        });
      }
      return;
    }

    if (action === 'edit-med') {
      openMedicationEditor(Number(actionEl.getAttribute('data-index') || 0));
      return;
    }

    if (action === 'close-med-modal') {
      closeMedicationEditor();
      return;
    }

    if (action === 'save-med-modal') {
      saveMedicationEditor();
      return;
    }

    if (action === 'med-reset-times') {
      if (window.confirm('Réinitialiser les horaires recommandés ? Cela écrasera vos horaires personnalisés.')) {
        var resetDraft = cloneValue(asObject(asObject(state.medEditor).draft));
        resetDraft.autoTimesEnabled = true;
        resetDraft.start = '08:00';
        resetDraft.end = '20:00';
        state.medEditor.draft = normalizeMedicationEditorDraft(resetDraft);
        renderMedicationDialogInto({ role: 'med-editor-time', index: 0 });
      }
      return;
    }

    if (action === 'med-enable-auto') {
      var autoDraft = cloneValue(asObject(asObject(state.medEditor).draft));
      autoDraft.autoTimesEnabled = true;
      autoDraft.start = isValidTimeValue(autoDraft.start) ? autoDraft.start : '08:00';
      autoDraft.end = isValidTimeValue(autoDraft.end) ? autoDraft.end : '20:00';
      state.medEditor.draft = normalizeMedicationEditorDraft(autoDraft);
      renderMedicationDialogInto({ role: 'med-editor-time', index: 0 });
      return;
    }

    if (action === 'approve') {
      submitDecision('approved');
      return;
    }

    if (action === 'toggle-reject') {
      if (hasPendingAction(state.selectedId)) return;
      state.refusalOpen = true;
      renderDetail();
      return;
    }

    if (action === 'cancel-reject') {
      if (hasPendingAction(state.selectedId, 'rejected')) return;
      state.refusalOpen = false;
      state.refusalReason = '';
      renderDetail();
      return;
    }

    if (action === 'confirm-reject') {
      submitDecision('rejected');
    }
  }
  function handleRootChange(event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;

    var role = normalizeText(target.getAttribute('data-role')).toLowerCase();

    if (role === 'message-file-input') {
      var selectedId = Number(state.selectedId || 0);
      if (selectedId > 0) {
        queueMessageFiles(selectedId, target.files || null).then(function () {
          try {
            target.value = '';
          } catch (e) {}
        });
      }
      return;
    }

    if (!role || role.indexOf('med-editor-') !== 0) return;
    if (!state.medEditor || !state.medEditor.detailId) return;

    var draft = cloneValue(asObject(state.medEditor.draft));
    var index = Number(target.getAttribute('data-index') || 0);

    if (role === 'med-editor-nb') {
      draft.nb = target.value;
      if (draft.autoTimesEnabled && draft.freqUnit === 'jour') {
        state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      } else {
        draft = normalizeMedicationEditorDraft(draft);
        draft.times = draft.freqUnit === 'jour'
          ? fitScheduleStringArray(draft.times, draft.nb, '')
          : [];
        draft.doses = draft.freqUnit === 'jour'
          ? fitScheduleStringArray(draft.doses, draft.nb, '1')
          : [];
        state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      }
      renderMedicationDialogInto({ role: 'med-editor-nb' });
      return;
    }

    if (role === 'med-editor-freq') {
      draft.freqUnit = target.value;
      if (normalizeScheduleUnit(target.value) !== 'semaine') {
        draft.freqUnit = 'jour';
        draft.doses = fitScheduleStringArray(draft.doses, draft.nb, '1');
        draft.times = fitScheduleStringArray(draft.times, draft.nb, '');
      } else {
        draft.freqUnit = 'semaine';
        draft.autoTimesEnabled = false;
      }
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      renderMedicationDialogInto({ role: 'med-editor-freq' });
      return;
    }

    if (role === 'med-editor-duration') {
      draft.durationVal = target.value;
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      return;
    }

    if (role === 'med-editor-duration-unit') {
      draft.durationUnit = target.value;
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      return;
    }

    if (role === 'med-editor-time') {
      if (draft.freqUnit !== 'jour') {
        return;
      }
      draft.times = fitScheduleStringArray(draft.times, draft.nb, '');
      draft.doses = fitScheduleStringArray(draft.doses, draft.nb, '1');

      if (draft.autoTimesEnabled) {
        if (index === 0) {
          draft.start = normalizeText(target.value) || draft.start;
          state.medEditor.draft = normalizeMedicationEditorDraft(draft);
          renderMedicationDialogInto({ role: 'med-editor-time', index: index });
          return;
        }
        if (index === draft.nb - 1 && draft.nb > 1) {
          draft.end = normalizeText(target.value) || draft.end;
          state.medEditor.draft = normalizeMedicationEditorDraft(draft);
          renderMedicationDialogInto({ role: 'med-editor-time', index: index });
          return;
        }
        draft.autoTimesEnabled = false;
        draft.times[index] = normalizeText(target.value);
        state.medEditor.draft = normalizeMedicationEditorDraft(draft);
        renderMedicationDialogInto({ role: 'med-editor-time', index: index });
        return;
      }

      draft.times[index] = normalizeText(target.value);
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      return;
    }
  }
  function handleRootInput(event) {
    var target = event.target;
    if (!target) return;

    if (target.matches && target.matches('[data-role="refusal-reason"]')) {
      state.refusalReason = String(target.value || '');
      return;
    }

    var role = normalizeText(target.getAttribute && target.getAttribute('data-role')).toLowerCase();

    if (role === 'message-body') {
      var detailId = Number(state.selectedId || 0);
      if (detailId > 0) {
        setThreadStore(detailId, { composerBody: String(target.value || '') });
      }
      return;
    }

    if (!role || role.indexOf('med-editor-') !== 0) return;
    if (!state.medEditor || !state.medEditor.detailId) return;

    var draft = cloneValue(asObject(state.medEditor.draft));

    if (role === 'med-editor-dose') {
      var doseIndex = Number(target.getAttribute('data-index') || 0);
      draft.doses = fitScheduleStringArray(draft.doses, draft.nb, '1');
      draft.doses[doseIndex] = normalizeText(target.value) || '1';
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
      return;
    }

    if (role === 'med-editor-note') {
      draft.note = String(target.value || '');
      state.medEditor.draft = normalizeMedicationEditorDraft(draft);
    }
  }


  render();
  fetchList();
  startPolling();
})();
