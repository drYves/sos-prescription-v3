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
    selectedId: 0,
    listLoading: false,
    detailLoading: false,
    notice: null,
    refusalOpen: false,
    refusalReason: '',
    pollHandle: null,
    pollInFlight: false,
    hydratedIds: {},
    pendingActions: {},
    ui: null,
    visibilityBound: false
  };

  if (!restBase || !nonce) {
    root.innerHTML = '<div class="sosprescription-doctor"><div class="dc-error-card">Configuration REST manquante (restBase/nonce).</div></div>';
    return;
  }

  function ensureInlineStyle() {
    if (document.getElementById('sosprescription-doctor-console-inline-style')) return;

    var style = document.createElement('style');
    style.id = 'sosprescription-doctor-console-inline-style';
    style.textContent = [
      '.sosprescription-doctor .dc-shell{grid-template-columns:minmax(248px,280px) minmax(0,1fr)!important;align-items:start!important;}',
      '.sosprescription-doctor .dc-inbox{max-width:280px!important;}',
      '.sosprescription-doctor .dc-inbox__list{max-height:calc(100vh - 240px)!important;overflow-y:auto!important;}',
      '@media (max-width:1180px){.sosprescription-doctor .dc-shell{grid-template-columns:1fr!important;}.sosprescription-doctor .dc-inbox{max-width:none!important;}.sosprescription-doctor .dc-inbox__list{max-height:none!important;}}',
      '.sosprescription-doctor .dc-pdf-card{overflow:hidden!important;}',
      '.sosprescription-doctor .dc-pdf-frame{width:100%!important;height:75vh!important;min-height:540px!important;max-height:82vh!important;aspect-ratio:auto!important;border:1px solid #e5e7eb!important;border-radius:8px!important;background:#ffffff!important;display:block!important;}',
      '.sosprescription-doctor .dc-btn.is-loading{opacity:0.92;cursor:progress;}',
      '.sosprescription-doctor .dc-btn.is-loading::before{content:"";display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.55);border-top-color:#ffffff;border-radius:999px;animation:dcSpin .8s linear infinite;}',
      '.sosprescription-doctor .dc-btn-secondary.is-loading::before{border-color:rgba(15,23,42,.18);border-top-color:#0f172a;}',
      '@keyframes dcSpin{to{transform:rotate(360deg);}}'
    ].join('');
    document.head.appendChild(style);
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
    state.pendingActions[id] = {
      decision: normalizeText(decision).toLowerCase(),
      startedAt: Date.now(),
      snapshot: {
        listIndex: index,
        listItem: cloneValue(index >= 0 ? state.list[index] : null),
        detail: cloneValue(state.details[id]),
        pdf: cloneValue(state.pdf[id])
      }
    };
  }

  function clearPendingAction(id) {
    delete state.pendingActions[id];
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
    var pendingDecision = getPendingDecision(id);
    if (!pendingDecision) {
      return row;
    }
    return overlayDecisionOnRecord(row, pendingDecision);
  }

  function apiUrl(path) {
    return restBase + path;
  }

  function requestJson(method, path, body) {
    var headers = {
      'Accept': 'application/json',
      'X-WP-Nonce': nonce
    };

    var opts = {
      method: method,
      headers: headers,
      credentials: 'same-origin'
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    return fetch(apiUrl(path), opts).then(function (res) {
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
    });
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
    var priority = normalizeText(rx && rx.priority).toLowerCase();
    return priority === 'express' ? 'Express' : 'Standard';
  }

  function computeCaseStatus(source) {
    var row = asObject(source);
    var id = Number(row.id || 0);
    var pendingDecision = getPendingDecision(id);
    if (pendingDecision === 'approved') {
      return { label: 'Validée', variant: 'success' };
    }
    if (pendingDecision === 'rejected') {
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

  function resolveMedicationSchedule(row) {
    var direct = asObject(row && row.schedule);
    if (hasObjectKeys(direct)) {
      return direct;
    }
    var raw = asObject(row && row.raw);
    return asObject(raw.schedule);
  }

  function escapeRegExp(value) {
    return normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripDurationFromPosology(text, durationLabel) {
    var raw = normalizeText(text);
    var duration = normalizeText(durationLabel);
    if (!raw || !duration) return raw;

    var escapedDuration = escapeRegExp(duration).replace(/\s+/g, '\\s+');
    if (!escapedDuration) return raw;

    var cleaned = raw.replace(new RegExp('\\s*(?:,|;|\\.|—|-)?\\s*pendant\\s+' + escapedDuration + '(?=\\b|\\s|$)', 'i'), '');
    cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
    cleaned = cleaned.replace(/[—-]\s*$/, '').trim();

    return cleaned || raw;
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
    var scheduleText = scheduleToText(schedule);
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
    var posology = firstText([
      row.instructions,
      row.scheduleText,
      raw.instructions,
      raw.scheduleText,
      scheduleText,
      row.posologie,
      raw.posologie,
      row.dosage,
      raw.dosage,
      schedule.note
    ]);
    posology = stripDurationFromPosology(posology, duration);

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

    var note = firstText([schedule.note, schedule.text, schedule.label]);
    var nb = toPositiveInt(schedule.nb || schedule.timesPerDay);
    var freqUnit = normalizeScheduleUnit(schedule.freqUnit || schedule.frequencyUnit || schedule.freq);
    var times = safeArray(schedule.times).map(function (v) { return normalizeText(v); }).filter(Boolean);
    var doses = safeArray(schedule.doses).map(function (v) { return normalizeText(v); }).filter(Boolean);

    if (nb > 0 && freqUnit) {
      var base = (nb > 1 ? (nb + ' fois') : '1 fois') + ' par ' + freqUnit;
      var details = [];
      for (var i = 0; i < nb; i += 1) {
        var time = normalizeText(times[i]);
        var dose = normalizeText(doses[i]);
        if (!time && !dose) continue;
        details.push((dose || '1') + '@' + (time || '--:--'));
      }
      if (details.length) base += ' (' + details.join(', ') + ')';
      if (note) base += '. ' + note;
      return base;
    }

    var parts = [];
    [['morning', 'matin'], ['noon', 'midi'], ['evening', 'soir'], ['bedtime', 'coucher']].forEach(function (entry) {
      var value = toPositiveInt(schedule[entry[0]]);
      if (value > 0) parts.push(entry[1] + ': ' + value);
    });

    var everyHours = toPositiveInt(schedule.everyHours);
    if (everyHours > 0) parts.push('Toutes les ' + everyHours + ' h');

    var legacyTimes = toPositiveInt(schedule.timesPerDay);
    if (legacyTimes > 0 && nb < 1) parts.push(legacyTimes + ' prise' + (legacyTimes > 1 ? 's' : '') + ' / jour');

    if (truthy(schedule.asNeeded)) parts.push('si besoin');
    if (note) parts.push(note);

    return parts.join(' — ');
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
    return normalizeText(url);
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

  function renderInboxItemMarkup(row) {
    var id = Number(row && row.id || 0);
    var detail = asObject(state.details[id]);
    var source = hasObjectKeys(detail) ? detail : row;
    var patient = extractPatientData(source);
    var statusInfo = computeCaseStatus(source);
    var urgencyVariant = patient.priority === 'Express' ? 'warn' : 'soft';

    return [
      '<div class="dc-item__row">',
      '  <div class="dc-item__patient">' + escHtml(patient.fullname || ('Dossier #' + id)) + '</div>',
      '  <div class="dc-item__status">' + statusBadge(statusInfo.label, statusInfo.variant) + '</div>',
      '</div>',
      '  <div class="dc-item__meta">' + escHtml(patient.birthDate) + ' • ' + escHtml(patient.createdAgo) + '</div>',
      '  <div class="dc-item__foot">',
      '    ' + statusBadge(patient.priority, urgencyVariant),
      '  </div>'
    ].join('');
  }

  function patchInboxItemNode(node, row) {
    if (!node) return;

    var id = Number(row && row.id || 0);
    var isSelected = Number(state.selectedId) === id;

    node.type = 'button';
    node.className = 'dc-item' + (isSelected ? ' is-selected' : '');
    node.setAttribute('data-action', 'select');
    node.setAttribute('data-id', String(id));
    node.setAttribute('data-role', 'inbox-item');
    node.setAttribute('data-case-id', String(id));
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
      setHtmlIfChanged(container, '<div class="dc-empty">Aucune demande en attente.</div>');
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
    var items = safeArray(detail && detail.items);
    if (items.length < 1) {
      return '<div class="dc-empty dc-empty-compact">Aucun médicament renseigné.</div>';
    }

    return '<div class="dc-meds">' + items.map(function (item) {
      var med = summarizeMedication(item);
      return [
        '<div class="dc-med">',
        '  <div class="dc-med__label">' + escHtml(med.label) + '</div>',
        '  <div class="dc-med__posology">' + escHtml(med.posology) + '</div>',
        med.meta ? '  <div class="dc-med__meta">' + escHtml(med.meta) + '</div>' : '',
        '</div>'
      ].join('');
    }).join('') + '</div>';
  }

  function renderRefusalPanel() {
    if (!state.refusalOpen) return '';

    var activeId = Number(state.selectedId || 0);
    var isRejecting = hasPendingAction(activeId, 'rejected');

    return [
      '<div class="dc-refusal-panel">',
      '  <label class="dc-label" for="dc-refusal-reason">Motif du refus</label>',
      '  <textarea id="dc-refusal-reason" class="dc-textarea" data-role="refusal-reason" placeholder="Précisez le motif clinique ou administratif…"' + (isRejecting ? ' disabled' : '') + '>' + escHtml(state.refusalReason) + '</textarea>',
      '  <div class="dc-refusal-actions">',
      '    <button type="button" class="dc-btn dc-btn-danger' + (isRejecting ? ' is-loading' : '') + '" data-action="confirm-reject"' + (isRejecting ? ' disabled' : '') + '>' + (isRejecting ? 'Refus...' : 'Confirmer le refus') + '</button>',
      '    <button type="button" class="dc-btn dc-btn-secondary" data-action="cancel-reject"' + (isRejecting ? ' disabled' : '') + '>Annuler</button>',
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
      '    <a class="dc-btn dc-btn-secondary dc-pdf-open" href="' + escHtml(downloadUrl) + '" target="_blank" rel="noopener noreferrer">Ouvrir le PDF</a>',
      '  </div>',
      '  <iframe class="dc-pdf-frame" src="' + escHtml(iframeSrcFromDownloadUrl(downloadUrl)) + '" loading="lazy"></iframe>',
      '</div>'
    ].join('');
  }

  function renderPdfInto(slot, detail) {
    if (!slot) return;

    var detailId = Number(detail && detail.id || 0);
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
      '  <div class="dc-summary-card" data-dc-summary-card style="display:none;">',
      '    <div class="dc-card__title">Patient</div>',
      '    <div class="dc-summary-grid">',
      '      <div class="dc-summary-row" data-dc-summary-weight-row style="display:none;"><span>POIDS</span><strong data-dc-summary-weight></strong></div>',
      '    </div>',
      '  </div>',
      '  <div class="dc-meds-card">',
      '    <div class="dc-card__title">Ordonnance</div>',
      '    <div data-dc-meds></div>',
      '  </div>',
      '  <div data-dc-pdf-slot></div>',
      '  <div class="dc-decisionbar">',
      '    <button type="button" class="dc-btn dc-btn-success dc-btn-large" data-action="approve" data-dc-approve>VALIDER</button>',
      '    <button type="button" class="dc-btn dc-btn-danger dc-btn-large" data-action="toggle-reject" data-dc-reject>REFUSER</button>',
      '  </div>',
      '  <div data-dc-refusal-slot></div>',
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

    var headerBadges = detailEl.querySelector('[data-dc-header-badges]');
    if (headerBadges) {
      headerBadges.innerHTML = [
        code ? statusBadge('Code délivrance : ' + code, 'soft') : '',
        statusBadge(patient.priority, patient.priority === 'Express' ? 'warn' : 'soft')
      ].join('');
    }

    var summaryCard = detailEl.querySelector('[data-dc-summary-card]');
    var weightRow = detailEl.querySelector('[data-dc-summary-weight-row]');
    var weightEl = detailEl.querySelector('[data-dc-summary-weight]');
    if (summaryCard && weightRow && weightEl) {
      if (patient.weight) {
        weightEl.textContent = patient.weight;
        weightRow.style.display = '';
        summaryCard.style.display = '';
      } else {
        weightEl.textContent = '';
        weightRow.style.display = 'none';
        summaryCard.style.display = 'none';
      }
    }

    var medsEl = detailEl.querySelector('[data-dc-meds]');
    if (medsEl) medsEl.innerHTML = renderMedicationList(detail);

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
      refusalSlot.innerHTML = canDecide ? renderRefusalPanel() : '';
    }

    var pdfSlot = detailEl.querySelector('[data-dc-pdf-slot]');
    renderPdfInto(pdfSlot, detail);
  }

  function renderDetail() {
    var ui = ensureShell();
    var detailEl = ui.detail;

    if (!state.selectedId) {
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
      detailEl.innerHTML = buildDetailSkeleton(state.selectedId);
    }

    patchDetailContent(detailEl, detail);
  }

  function renderShell() {
    if (state.ui) return state.ui;

    ensureInlineStyle();

    root.innerHTML = [
      '<div class="sosprescription-doctor">',
      '  <div data-dc-notice></div>',
      '  <div class="dc-shell">',
      '    <aside class="dc-inbox">',
      '      <div class="dc-inbox__head">',
      '        <div>',
      '          <div class="dc-overline">Console médecin</div>',
      '          <h1 class="dc-title">Demandes en attente</h1>',
      '          <div class="dc-subtitle">Connecté : ' + escHtml(currentUserName) + ' • synchronisation automatique</div>',
      '        </div>',
      '      </div>',
      '      <div class="dc-inbox__list" data-dc-inbox-list></div>',
      '    </aside>',
      '    <section class="dc-detail" data-dc-detail></section>',
      '  </div>',
      '</div>'
    ].join('');

    state.ui = {
      notice: root.querySelector('[data-dc-notice]'),
      inboxList: root.querySelector('[data-dc-inbox-list]'),
      detail: root.querySelector('[data-dc-detail]')
    };

    root.addEventListener('click', handleRootClick);
    root.addEventListener('input', handleRootInput);

    return state.ui;
  }

  function ensureShell() {
    return renderShell();
  }

  function render() {
    ensureShell();
    renderNoticeInto();
    patchInboxList();
    renderDetail();
  }

  function patchLocalDecisionState(id, decision, responsePayload) {
    var row = hasObjectKeys(state.details[id]) ? cloneValue(state.details[id]) : {};
    row.id = Number(row.id || id);

    if (responsePayload && responsePayload.prescription) {
      row = cloneValue(responsePayload.prescription);
    }

    row = overlayDecisionOnRecord(row, decision);
    state.details[id] = row;

    if (decision === 'approved') {
      if (responsePayload && responsePayload.pdf) {
        state.pdf[id] = responsePayload.pdf;
      } else {
        state.pdf[id] = Object.assign({}, state.pdf[id], { status: 'pending' });
      }
    } else if (decision === 'rejected') {
      state.pdf[id] = Object.assign({}, state.pdf[id], { status: 'failed' });
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

    return requestJson('GET', '/prescriptions?status=pending&limit=50&offset=0').then(function (rows) {
      var nextRows = safeArray(rows).map(applyPendingOverlayToRecord);
      var previousSelectedId = Number(state.selectedId || 0);
      var nextSelectedId = previousSelectedId;

      state.list = nextRows;
      state.listLoading = false;
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
      showNotice('error', error.message || 'Impossible de charger la file de demandes.');
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

    return requestJson('GET', '/prescriptions/' + numericId).then(function (row) {
      var nextRow = applyPendingOverlayToRecord(row);
      state.details[numericId] = nextRow;

      if (Number(state.selectedId) === numericId) {
        state.detailLoading = false;
        if (!opts.skipDetailRender) {
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

    return requestJson('GET', '/prescriptions/' + numericId + '/pdf-status').then(function (payload) {
      state.pdf[numericId] = payload && payload.pdf ? payload.pdf : {};
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return state.pdf[numericId];
    }).catch(function (error) {
      if (!opts.silent) {
        showNotice('error', error.message || 'Impossible de lire le statut PDF.');
      }
      if (Number(state.selectedId) === numericId) {
        renderDetail();
      }
      return null;
    });
  }

  function ensureAssigned(rx) {
    var row = asObject(rx);
    var id = Number(row.id || 0);
    if (id < 1) return Promise.resolve(null);
    var assignedId = Number(row.doctor_user_id || 0);
    if (assignedId > 0 && assignedId === currentUserId) {
      return Promise.resolve(row);
    }

    return requestJson('POST', '/prescriptions/' + id + '/assign', {}).then(function (updated) {
      var nextRow = applyPendingOverlayToRecord(updated);
      state.details[id] = nextRow;
      patchInboxItemById(id);
      if (Number(state.selectedId) === id) {
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
      return ensureAssigned(row).then(function (assignedRow) {
        state.details[numericId] = assignedRow || row;
        if (Number(state.selectedId) === numericId) {
          renderDetail();
        }
        patchInboxItemById(numericId);
        return fetchPdfStatus(numericId, { silent: !!opts.silent });
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
    if (normalizedDecision !== 'approved') {
      payload.reason = reason;
    }

    requestJson('POST', '/prescriptions/' + id + '/decision', payload).then(function (responsePayload) {
      clearPendingAction(id);
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

  function runPollCycle() {
    if (state.pollInFlight) {
      scheduleNextPoll(5000);
      return;
    }

    state.pollInFlight = true;

    Promise.resolve()
      .then(function () {
        return fetchList({ silent: true });
      })
      .then(function () {
        if (state.selectedId) {
          return refreshSelected();
        }
        return null;
      })
      .catch(function () {
        return null;
      })
      .finally(function () {
        state.pollInFlight = false;
        scheduleNextPoll(getPollDelay());
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

    if (action === 'select') {
      selectCase(Number(actionEl.getAttribute('data-id') || 0));
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

  function handleRootInput(event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches('[data-role="refusal-reason"]')) return;
    state.refusalReason = String(target.value || '');
  }

  render();
  fetchList();
  startPolling();
})();
