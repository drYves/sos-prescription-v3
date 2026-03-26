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
    actionLoading: false,
    notice: null,
    refusalOpen: false,
    refusalReason: '',
    pollHandle: null,
    hydratedIds: {}
  };

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

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function toArray(value) {
    return Array.prototype.slice.call(value || []);
  }

  function firstText(values) {
    for (var i = 0; i < values.length; i += 1) {
      var text = normalizeText(values[i]);
      if (text) return text;
    }
    return '';
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

  function summarizeMedication(item) {
    var row = asObject(item);
    var label = firstText([row.label, row.denomination, row.name]) || 'Médicament';
    var schedule = asObject(row.schedule);
    var posology = firstText([
      row.posologie,
      row.instructions,
      row.scheduleText,
      row.dosage,
      schedule.note,
      scheduleToText(schedule)
    ]);
    var duration = firstText([
      row.duration_label,
      row.durationLabel,
      row.durationText,
      row.duration,
      row.duree,
      durationLabelFromSchedule(schedule)
    ]);

    var meta = [];
    if (duration) meta.push(duration);
    if (row.quantite) meta.push('Quantité : ' + String(row.quantite));

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
    var durationVal = toPositiveInt(schedule.durationVal || schedule.durationValue || schedule.duration);
    var durationUnit = normalizeScheduleUnit(schedule.durationUnit || schedule.unit);
    var times = safeArray(schedule.times).map(function (v) { return normalizeText(v); }).filter(Boolean);
    var doses = safeArray(schedule.doses).map(function (v) { return normalizeText(v); }).filter(Boolean);

    if (nb > 0 && freqUnit && durationVal > 0 && durationUnit) {
      var base = (nb > 1 ? (nb + ' fois') : '1 fois') + ' par ' + freqUnit + ' pendant ' + durationVal + ' ' + pluralizeUnit(durationUnit, durationVal);
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

  function showNotice(type, message) {
    state.notice = { type: type, message: message };
    render();
  }

  function clearNotice() {
    state.notice = null;
  }

  function fetchList() {
    state.listLoading = true;
    render();

    return requestJson('GET', '/prescriptions?status=pending&limit=50&offset=0').then(function (rows) {
      state.list = safeArray(rows);
      state.listLoading = false;

      if (state.list.length > 0) {
        if (!state.selectedId || !state.list.some(function (item) { return Number(item.id) === Number(state.selectedId); })) {
          state.selectedId = Number(state.list[0].id || 0);
        }

        hydrateVisibleCases();
      } else {
        state.selectedId = 0;
      }

      render();

      if (state.selectedId) {
        return selectCase(state.selectedId, { silent: true });
      }
      return null;
    }).catch(function (error) {
      state.listLoading = false;
      showNotice('error', error.message || 'Impossible de charger la file de demandes.');
    });
  }

  function hydrateVisibleCases() {
    safeArray(state.list).slice(0, 20).forEach(function (row) {
      var id = Number(row && row.id || 0);
      if (id > 0 && !state.hydratedIds[id]) {
        state.hydratedIds[id] = true;
        fetchDetail(id, { silent: true });
      }
    });
  }

  function fetchDetail(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    if (!opts.silent) {
      state.detailLoading = true;
      render();
    }

    return requestJson('GET', '/prescriptions/' + numericId).then(function (row) {
      state.details[numericId] = row;
      if (!opts.silent) state.detailLoading = false;
      render();
      return row;
    }).catch(function (error) {
      if (!opts.silent) {
        state.detailLoading = false;
        showNotice('error', error.message || 'Impossible de charger le dossier.');
      }
      return null;
    });
  }

  function fetchPdf(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    return requestJson('POST', '/prescriptions/' + numericId + '/rx-pdf', { dispatch: 0 }).then(function (payload) {
      state.pdf[numericId] = payload && payload.pdf ? payload.pdf : {};
      if (!opts.silent) render();
      return state.pdf[numericId];
    }).catch(function () {
      if (!opts.silent) render();
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
      state.details[id] = updated;
      return updated;
    }).catch(function () {
      return row;
    });
  }

  function selectCase(id, opts) {
    opts = opts || {};
    var numericId = Number(id || 0);
    if (numericId < 1) return Promise.resolve(null);

    state.selectedId = numericId;
    state.refusalOpen = false;
    state.refusalReason = '';
    clearNotice();
    render();

    return fetchDetail(numericId, { silent: !!opts.silent }).then(function (row) {
      if (!row) return null;
      return ensureAssigned(row).then(function (assignedRow) {
        state.details[numericId] = assignedRow || row;
        render();
        return fetchPdf(numericId, { silent: !!opts.silent });
      });
    });
  }

  function refreshSelected() {
    if (!state.selectedId) return Promise.resolve(null);
    return fetchDetail(state.selectedId, { silent: true }).then(function () {
      return fetchPdf(state.selectedId, { silent: true });
    }).then(function () {
      render();
    });
  }

  function submitDecision(decision) {
    var id = Number(state.selectedId || 0);
    if (id < 1 || state.actionLoading) return;

    var reason = state.refusalReason.trim();
    if (decision === 'rejected' && reason === '') {
      showNotice('error', 'Merci de renseigner un motif de refus.');
      return;
    }

    state.actionLoading = true;
    render();

    requestJson('POST', '/prescriptions/' + id + '/decision', {
      decision: decision,
      reason: reason || null
    }).then(function (payload) {
      state.actionLoading = false;
      state.refusalOpen = false;
      state.refusalReason = '';

      if (payload && payload.prescription) {
        state.details[id] = payload.prescription;
      }
      if (payload && payload.pdf) {
        state.pdf[id] = payload.pdf;
      }

      showNotice(decision === 'approved' ? 'success' : 'warning', decision === 'approved'
        ? 'Ordonnance validée. Le PDF est en cours de préparation.'
        : 'Ordonnance refusée.');

      return fetchList();
    }).catch(function (error) {
      state.actionLoading = false;
      showNotice('error', error.message || 'Impossible d’enregistrer la décision.');
    });
  }

  function startPolling() {
    if (state.pollHandle) {
      clearInterval(state.pollHandle);
    }

    state.pollHandle = setInterval(function () {
      fetchList();
      if (state.selectedId) {
        refreshSelected();
      }
    }, 15000);
  }

  function renderNotice() {
    if (!state.notice || !state.notice.message) return '';
    var type = normalizeText(state.notice.type || 'info').toLowerCase();
    return '<div class="dc-notice dc-notice-' + escHtml(type) + '">' + escHtml(state.notice.message) + '</div>';
  }

  function renderInboxItem(row) {
    var id = Number(row && row.id || 0);
    var detail = asObject(state.details[id]);
    var source = Object.keys(detail).length ? detail : row;
    var patient = extractPatientData(source);
    var isSelected = Number(state.selectedId) === id;
    var status = normalizeText(source.status || 'pending').toLowerCase();
    var statusLabel = status === 'payment_pending'
      ? 'Paiement en attente'
      : status === 'approved'
        ? 'Validée'
        : status === 'rejected'
          ? 'Refusée'
          : 'À traiter';
    var statusVariant = status === 'approved' ? 'success' : (status === 'rejected' ? 'danger' : 'soft');
    var urgencyVariant = patient.priority === 'Express' ? 'warn' : 'soft';

    return [
      '<button type="button" class="dc-item' + (isSelected ? ' is-selected' : '') + '" data-action="select" data-id="' + escHtml(id) + '">',
      '  <div class="dc-item__row">',
      '    <div class="dc-item__patient">' + escHtml(patient.fullname || ('Dossier #' + id)) + '</div>',
      '    <div class="dc-item__status">' + statusBadge(statusLabel, statusVariant) + '</div>',
      '  </div>',
      '  <div class="dc-item__meta">' + escHtml(patient.birthDate) + ' • ' + escHtml(patient.createdAgo) + '</div>',
      '  <div class="dc-item__foot">',
      '    ' + statusBadge(patient.priority, urgencyVariant),
      '  </div>',
      '</button>'
    ].join('');
  }

  function renderInbox() {
    if (state.listLoading && state.list.length < 1) {
      return '<div class="dc-empty">Chargement des demandes…</div>';
    }

    if (state.list.length < 1) {
      return '<div class="dc-empty">Aucune demande en attente.</div>';
    }

    return state.list.map(renderInboxItem).join('');
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

  function renderPdfPanel(detail) {
    var pdf = extractPdfState(detail && detail.id);
    var status = normalizeText(pdf.status || 'pending').toLowerCase();
    var message = firstText([
      pdf.message,
      pdf.last_error_message,
      status === 'done' ? 'PDF prêt.' : (status === 'failed' ? 'Le PDF n’est pas disponible.' : 'PDF en cours de génération.')
    ]);
    var downloadUrl = normalizeText(pdf.download_url);

    if (downloadUrl) {
      return [
        '<div class="dc-pdf-card">',
        '  <div class="dc-card__title">Ordonnance PDF</div>',
        '  <div class="dc-pdf-actions">',
        '    <a class="dc-btn dc-btn-secondary" href="' + escHtml(downloadUrl) + '" target="_blank" rel="noopener noreferrer">Ouvrir le PDF</a>',
        '  </div>',
        '  <iframe class="dc-pdf-frame" src="' + escHtml(downloadUrl) + '#toolbar=0&navpanes=0&scrollbar=1" loading="lazy"></iframe>',
        '</div>'
      ].join('');
    }

    return [
      '<div class="dc-pdf-card">',
      '  <div class="dc-card__title">Ordonnance PDF</div>',
      '  <div class="dc-pdf-placeholder">' + escHtml(message) + '</div>',
      '</div>'
    ].join('');
  }

  function renderRefusalPanel() {
    if (!state.refusalOpen) return '';

    return [
      '<div class="dc-refusal-panel">',
      '  <label class="dc-label" for="dc-refusal-reason">Motif du refus</label>',
      '  <textarea id="dc-refusal-reason" class="dc-textarea" data-role="refusal-reason" placeholder="Précisez le motif clinique ou administratif…">' + escHtml(state.refusalReason) + '</textarea>',
      '  <div class="dc-refusal-actions">',
      '    <button type="button" class="dc-btn dc-btn-danger" data-action="confirm-reject">Confirmer le refus</button>',
      '    <button type="button" class="dc-btn dc-btn-secondary" data-action="cancel-reject">Annuler</button>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function renderDetail() {
    if (!state.selectedId) {
      return '<div class="dc-empty dc-empty-large">Sélectionnez une demande pour ouvrir le dossier.</div>';
    }

    var detail = asObject(state.details[state.selectedId]);
    if (Object.keys(detail).length < 1) {
      return '<div class="dc-empty dc-empty-large">Chargement du dossier…</div>';
    }

    var patient = extractPatientData(detail);
    var status = normalizeText(detail.status || 'pending').toLowerCase();
    var canDecide = status !== 'approved' && status !== 'rejected';
    var code = patient.verifyCode;

    return [
      '<div class="dc-detail-pane">',
      '  <div class="dc-detail-head">',
      '    <div class="dc-detail-head__main">',
      '      <div class="dc-overline">Dossier patient</div>',
      '      <h2 class="dc-patient-name">' + escHtml(patient.fullname) + '</h2>',
      '      <div class="dc-patient-meta">' + escHtml(patient.birthDate) + ' • ' + escHtml(patient.createdAt) + '</div>',
      '    </div>',
      '    <div class="dc-detail-head__aside">',
      code ? ('      ' + statusBadge('Code délivrance : ' + code, 'soft')) : '',
      '      ' + statusBadge(patient.priority, patient.priority === 'Express' ? 'warn' : 'soft'),
      '    </div>',
      '  </div>',
      '  <div class="dc-summary-card">',
      '    <div class="dc-card__title">Patient</div>',
      '    <div class="dc-summary-grid">',
      '      <div class="dc-summary-row"><span>NOM</span><strong>' + escHtml(patient.fullname) + '</strong></div>',
      '      <div class="dc-summary-row"><span>DATE DE NAISSANCE</span><strong>' + escHtml(patient.birthDate) + '</strong></div>',
      patient.weight ? '      <div class="dc-summary-row"><span>POIDS</span><strong>' + escHtml(patient.weight) + '</strong></div>' : '',
      '      <div class="dc-summary-row"><span>CRÉÉE LE</span><strong>' + escHtml(patient.createdAt) + '</strong></div>',
      code ? ('      <div class="dc-summary-row"><span>CODE DÉLIVRANCE</span><strong>' + escHtml(code) + '</strong></div>') : '',
      '    </div>',
      '  </div>',
      '  <div class="dc-meds-card">',
      '    <div class="dc-card__title">Ordonnance</div>',
      renderMedicationList(detail),
      '  </div>',
      '  ' + renderPdfPanel(detail),
      '  <div class="dc-decisionbar">',
      canDecide
        ? '    <button type="button" class="dc-btn dc-btn-success dc-btn-large" data-action="approve">VALIDER L’ORDONNANCE</button>'
        : '    <button type="button" class="dc-btn dc-btn-success dc-btn-large" disabled>ORDONNANCE VALIDÉE</button>',
      canDecide
        ? '    <button type="button" class="dc-btn dc-btn-danger dc-btn-large" data-action="toggle-reject">REFUSER</button>'
        : (status === 'rejected'
            ? '    <button type="button" class="dc-btn dc-btn-danger dc-btn-large" disabled>ORDONNANCE REFUSÉE</button>'
            : '    <button type="button" class="dc-btn dc-btn-danger dc-btn-large" disabled>REFUSER</button>'),
      '  </div>',
      '  ' + renderRefusalPanel(),
      '</div>'
    ].join('');
  }

  function render() {
    var selected = state.selectedId ? asObject(state.details[state.selectedId]) : null;
    var code = selected && Object.keys(selected).length ? extractVerifyCode(selected) : '';

    root.innerHTML = [
      '<div class="sosprescription-doctor">',
      renderNotice(),
      '  <div class="dc-shell">',
      '    <aside class="dc-inbox">',
      '      <div class="dc-inbox__head">',
      '        <div>',
      '          <div class="dc-overline">Console médecin</div>',
      '          <h1 class="dc-title">Demandes en attente</h1>',
      '          <div class="dc-subtitle">Connecté : ' + escHtml(currentUserName) + '</div>',
      '        </div>',
      '        <div class="dc-inbox__actions">',
      code ? ('<div class="dc-current-code">' + statusBadge('Code délivrance : ' + code, 'soft') + '</div>') : '',
      '          <button type="button" class="dc-btn dc-btn-secondary" data-action="refresh">Actualiser</button>',
      '        </div>',
      '      </div>',
      '      <div class="dc-inbox__list">' + renderInbox() + '</div>',
      '    </aside>',
      '    <section class="dc-detail">',
      state.detailLoading ? '<div class="dc-loading">Chargement du dossier…</div>' : renderDetail(),
      '    </section>',
      '  </div>',
      '</div>'
    ].join('');

    bindEvents();
  }

  function bindEvents() {
    toArray(root.querySelectorAll('[data-action="select"]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectCase(Number(btn.getAttribute('data-id') || 0));
      });
    });

    var refresh = root.querySelector('[data-action="refresh"]');
    if (refresh) {
      refresh.addEventListener('click', function () {
        fetchList();
      });
    }

    var approve = root.querySelector('[data-action="approve"]');
    if (approve) {
      approve.addEventListener('click', function () {
        submitDecision('approved');
      });
    }

    var toggleReject = root.querySelector('[data-action="toggle-reject"]');
    if (toggleReject) {
      toggleReject.addEventListener('click', function () {
        state.refusalOpen = true;
        render();
      });
    }

    var cancelReject = root.querySelector('[data-action="cancel-reject"]');
    if (cancelReject) {
      cancelReject.addEventListener('click', function () {
        state.refusalOpen = false;
        state.refusalReason = '';
        render();
      });
    }

    var confirmReject = root.querySelector('[data-action="confirm-reject"]');
    if (confirmReject) {
      confirmReject.addEventListener('click', function () {
        var textarea = root.querySelector('[data-role="refusal-reason"]');
        state.refusalReason = textarea ? String(textarea.value || '') : state.refusalReason;
        submitDecision('rejected');
      });
    }

    var refusal = root.querySelector('[data-role="refusal-reason"]');
    if (refusal) {
      refusal.addEventListener('input', function () {
        state.refusalReason = String(refusal.value || '');
      });
    }
  }

  render();
  fetchList();
  startPolling();
})();
