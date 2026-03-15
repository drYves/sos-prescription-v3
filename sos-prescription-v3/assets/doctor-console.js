(function () {
  'use strict';

  var root = document.getElementById('sosprescription-doctor-console-root');
  if (!root) return;

  var cfg = window.SOSPrescription || window.SosPrescription || {};
  var restBase = String(cfg.restBase || '');
  var nonce = String(cfg.nonce || '');
  var isSandbox = !!(cfg && cfg.sandbox && cfg.sandbox.testing_mode);
  var currentUser = (cfg.currentUser && typeof cfg.currentUser === 'object') ? cfg.currentUser : {};
  var currentUserId = Number(currentUser.id || 0);
  var currentUserName = String(currentUser.displayName || currentUser.email || '');

  if (!restBase || !nonce) {
    root.innerHTML =
      '<div class="sosprescription-doctor">' +
      '  <div class="sp-card">' +
      '    <div class="sp-alert sp-alert-error">Configuration REST manquante (restBase/nonce).</div>' +
      '  </div>' +
      '</div>';
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

  function escAttr(value) {
    return escHtml(value);
  }

  function safeArr(value) {
    return Array.isArray(value) ? value : [];
  }

  function prettyBytes(bytes) {
    var b = Number(bytes || 0);
    if (!isFinite(b) || b <= 0) return '0 o';

    var units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    var i = 0;
    while (b >= 1024 && i < units.length - 1) {
      b = b / 1024;
      i++;
    }

    var val = (i === 0 || b >= 10) ? Math.round(b) : (Math.round(b * 10) / 10);
    return String(val).replace('.', ',') + ' ' + units[i];
  }

  function ensureInlineStyle() {
    if (document.getElementById('sp-doctor-console-inline-style')) return;

    var style = document.createElement('style');
    style.id = 'sp-doctor-console-inline-style';
    style.textContent = [
      '#sosprescription-doctor-console-root .sp-grid{display:grid;grid-template-columns:350px minmax(0,1fr);gap:24px;align-items:start;}',
      '#sosprescription-doctor-console-root .sp-col-list{min-width:0;max-width:350px;width:100%;}',
      '#sosprescription-doctor-console-root .sp-col-detail{min-width:0;}',
      '#sosprescription-doctor-console-root .sp-card{box-sizing:border-box;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#fff;box-shadow:0 2px 10px rgba(17,24,39,.04);}',
      '#sosprescription-doctor-console-root .sp-toolbar{display:flex;flex-wrap:wrap;gap:10px;}',
      '#sosprescription-doctor-console-root .sp-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '#sosprescription-doctor-console-root .sp-stack{display:flex;flex-direction:column;gap:12px;}',
      '#sosprescription-doctor-console-root .sp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '#sosprescription-doctor-console-root .sp-wrap{flex-wrap:wrap;}',
      '#sosprescription-doctor-console-root .sp-file-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #f0f0f1;}',
      '#sosprescription-doctor-console-root .sp-file-row:first-child{border-top:0;padding-top:0;}',
      '#sosprescription-doctor-console-root .sp-file-main{min-width:0;}',
      '#sosprescription-doctor-console-root .sp-file-name{font-weight:600;}',
      '#sosprescription-doctor-console-root .sp-case-id{font-size:18px;font-weight:700;}',
      '#sosprescription-doctor-console-root .sp-meds{margin:0;padding-left:18px;}',
      '#sosprescription-doctor-console-root .sp-med{margin:0 0 8px 0;}',
      '#sosprescription-doctor-console-root .sp-med-name{font-weight:600;}',
      '#sosprescription-doctor-console-root .sp-chat-history{display:flex;flex-direction:column;gap:10px;max-height:280px;overflow:auto;padding-right:4px;}',
      '#sosprescription-doctor-console-root .sp-chat-msg{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff;}',
      '#sosprescription-doctor-console-root .sp-chat-meta{font-size:12px;margin-bottom:6px;}',
      '#sosprescription-doctor-console-root .sp-chat-body{white-space:pre-wrap;word-break:break-word;font-size:13px;}',
      '#sosprescription-doctor-console-root .sp-chat-att{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;}',
      '#sosprescription-doctor-console-root .sp-chat-composer{display:flex;flex-direction:column;gap:10px;}',
      '#sosprescription-doctor-console-root .sp-textarea{width:100%;min-height:96px;}',
      '#sosprescription-doctor-console-root .sp-link{background:none;border:0;padding:0;color:#2271b1;text-decoration:underline;cursor:pointer;}',
      '#sosprescription-doctor-console-root .sp-inline-notice{margin-bottom:12px;}',
      '#sosprescription-doctor-console-root .sp-alert{border-radius:12px;padding:12px 14px;border:1px solid #d0e3ff;background:#f0f6fc;color:#0a3d66;}',
      '#sosprescription-doctor-console-root .sp-alert-error{border-color:#f2a3a3;background:#fff1f2;color:#7a1212;}',
      '#sosprescription-doctor-console-root .sp-alert-success{border-color:#95d5a6;background:#ecfdf3;color:#0d5f2b;}',
      '#sosprescription-doctor-console-root .sp-alert-warning{border-color:#f0c36d;background:#fff7ed;color:#7a3e00;}',
      '#sosprescription-doctor-console-root .sp-badge-soft{border-color:#e5e7eb;background:#f8fafc;color:#374151;}',
      '#sosprescription-doctor-console-root .sp-card-title{font-size:14px;font-weight:600;margin:0 0 10px;}',
      '#sosprescription-doctor-console-root .sp-pdf-download{width:100%;justify-content:center;font-size:15px;padding:12px 16px;}',
      '#sosprescription-doctor-console-root .sp-spinner{display:inline-flex;align-items:center;gap:8px;}',
      '#sosprescription-doctor-console-root .sp-spinner::before{content:"";width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:sp-doctor-spin .8s linear infinite;}',
      '#sosprescription-doctor-console-root .sp-decision-card .sp-btn{min-height:42px;}',
      '#sosprescription-doctor-console-root .sp-list-item{width:100%;text-align:left;}',
      '#sosprescription-doctor-console-root .sp-compose-att{margin-top:8px;font-size:12px;color:#555;}',
      '@media (max-width:1100px){#sosprescription-doctor-console-root .sp-grid{grid-template-columns:1fr;}#sosprescription-doctor-console-root .sp-col-list{max-width:none;}}',
      '@keyframes sp-doctor-spin{to{transform:rotate(360deg);}}'
    ].join('');
    document.head.appendChild(style);
  }

  function renderNoticeHtml(type, text) {
    if (!text) return '';
    var cls = 'sp-alert';
    if (type === 'error') cls += ' sp-alert-error';
    else if (type === 'success') cls += ' sp-alert-success';
    else if (type === 'warning') cls += ' sp-alert-warning';
    return '<div class="' + cls + '">' + escHtml(text) + '</div>';
  }

  function apiJson(path, options) {
    options = options || {};
    var method = String(options.method || 'GET').toUpperCase();
    var urlPath = String(path || '');

    if (method === 'GET') {
      urlPath += (urlPath.indexOf('?') === -1 ? '?' : '&') + '_ts=' + Date.now();
    }

    var url = restBase.replace(/\/$/, '') + urlPath;
    var headers = {
      'X-WP-Nonce': nonce,
      'X-Sos-Scope': 'sosprescription_doctor_console'
    };

    if (options.headers) {
      for (var hk in options.headers) {
        if (Object.prototype.hasOwnProperty.call(options.headers, hk)) {
          headers[hk] = options.headers[hk];
        }
      }
    }

    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: headers,
      body: options.body
    }).then(function (res) {
      var headerRid = res.headers.get('X-SOSPrescription-Request-ID') || res.headers.get('X-SP-Request-ID') || '';

      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }

        if (!res.ok) {
          var rid = data && data._request_id ? data._request_id : headerRid;
          var msg = '';

          if (data && typeof data.message === 'string' && data.message) {
            msg = data.message;
          } else if (text) {
            msg = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          } else {
            msg = res.statusText || 'Erreur API';
          }

          if (res.status === 403) {
            msg = 'Accès refusé (403). Veuillez rafraîchir la page ou vous reconnecter.';
          } else if (res.status === 404) {
            msg = 'Ressource introuvable (404).';
          } else if (res.status >= 500 && !msg) {
            msg = 'Erreur serveur. Réessayez dans quelques instants.';
          }

          var parts = ['HTTP ' + res.status];
          if (rid) parts.push('Req ' + rid);
          parts.push(path);

          var err = new Error(msg + ' — ' + parts.join(' · '));
          err.status = res.status;
          err.requestId = rid;
          err.payload = data;
          err.path = path;
          throw err;
        }

        return data;
      });
    });
  }

  function apiGet(path) {
    return apiJson(path, { method: 'GET' });
  }

  function apiPostJson(path, payload) {
    return apiJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload == null ? {} : payload)
    });
  }

  function apiUploadFile(file, purpose, prescriptionId) {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('purpose', String(purpose || 'message'));
    if (prescriptionId) {
      fd.append('prescription_id', String(prescriptionId));
    }

    return fetch(restBase.replace(/\/$/, '') + '/files', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-WP-Nonce': nonce,
        'X-Sos-Scope': 'sosprescription_doctor_console'
      },
      body: fd
    }).then(function (res) {
      var headerRid = res.headers.get('X-SOSPrescription-Request-ID') || res.headers.get('X-SP-Request-ID') || '';

      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }

        if (!res.ok) {
          var rid = data && data._request_id ? data._request_id : headerRid;
          var msg = data && typeof data.message === 'string' ? data.message : 'Erreur upload';
          var err = new Error(msg);
          err.status = res.status;
          err.requestId = rid;
          err.payload = data;
          throw err;
        }

        return data;
      });
    });
  }

  function isProtectedWpDownload(url) {
    try {
      var parsed = new URL(String(url || ''), window.location.href);
      if (parsed.origin !== window.location.origin) return false;
      return /\/wp-json\/sosprescription\/v1\/files\/\d+\/download$/i.test(parsed.pathname);
    } catch (e) {
      return false;
    }
  }

  function downloadWithNonce(url, filename) {
    if (!url) {
      return Promise.reject(new Error('URL de téléchargement manquante'));
    }

    return fetch(url, {
      method: 'GET',
      headers: { 'X-WP-Nonce': nonce },
      credentials: 'same-origin'
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error(text || ('Erreur téléchargement (' + res.status + ')'));
        });
      }

      return res.blob();
    }).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () {
        URL.revokeObjectURL(objectUrl);
      }, 1500);
    });
  }

  function directDownload(url, filename) {
    if (!url) {
      return Promise.reject(new Error('URL de téléchargement manquante'));
    }

    var a = document.createElement('a');
    a.href = String(url);
    a.rel = 'noopener';
    a.target = '_blank';
    if (filename) {
      a.download = String(filename);
    }
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return Promise.resolve();
  }

  function downloadAny(url, filename) {
    if (isProtectedWpDownload(url)) {
      return downloadWithNonce(url, filename);
    }
    return directDownload(url, filename);
  }

  function statusMeta(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'payment_pending') return { label: 'Paiement en attente', cls: 'sp-badge sp-badge-warn' };
    if (s === 'pending') return { label: 'En attente', cls: 'sp-badge sp-badge-warn' };
    if (s === 'in_review') return { label: 'En cours', cls: 'sp-badge' };
    if (s === 'needs_info') return { label: 'Infos requises', cls: 'sp-badge sp-badge-warn' };
    if (s === 'approved') return { label: 'Validée', cls: 'sp-badge sp-badge-success' };
    if (s === 'rejected') return { label: 'Refusée', cls: 'sp-badge sp-badge-danger' };
    return { label: status || '—', cls: 'sp-badge' };
  }

  function priorityMeta(priority) {
    var p = String(priority || '').toLowerCase();
    if (p === 'express') return { label: 'Express', cls: 'sp-badge sp-badge-warn' };
    if (p === 'standard') return { label: 'Standard', cls: 'sp-badge' };
    return { label: priority || '—', cls: 'sp-badge' };
  }

  function flowMeta(flow) {
    var f = String(flow || '');
    if (f === 'ro_proof' || f === 'renewal') return { label: 'Renouvellement (avec preuve)', value: f };
    if (f === 'depannage_no_proof') return { label: 'Dépannage (sans preuve)', value: f };
    if (!f) return { label: '—', value: '' };
    return { label: f, value: f };
  }

  function normalizePdfState(resp) {
    var pdf = (resp && resp.pdf && typeof resp.pdf === 'object') ? resp.pdf : {};
    var status = String((pdf && pdf.status) || (resp && resp.status) || '').toLowerCase();
    var downloadUrl = String((resp && resp.download_url) || (pdf && pdf.download_url) || '');

    return {
      status: status,
      can_download: !!((pdf && pdf.can_download) || downloadUrl),
      download_url: downloadUrl,
      expires_in: Number((resp && resp.expires_in) || (pdf && pdf.expires_in) || 0),
      job_id: Number((pdf && pdf.job_id) || 0),
      req_id: String((pdf && pdf.req_id) || (resp && resp.req_id) || ''),
      last_error_code: String((pdf && pdf.last_error_code) || ''),
      last_error_message: String((pdf && pdf.last_error_message) || ''),
      s3_ready: !!(pdf && pdf.s3_ready),
      message: String((resp && resp.message) || '')
    };
  }

  var state = {
    filterStatus: 'pending',
    filterAssigned: 'all',
    filterPriority: 'all',
    listLoading: false,
    detailLoading: false,
    list: [],
    selectedId: null,
    selected: null,
    messages: [],
    composeBody: '',
    composeAttachments: [],
    rejectReason: '',
    pdfState: null,
    pdfPolling: false,
    pdfPollingTimer: null,
    noticeType: '',
    noticeText: '',
    noticeScope: 'detail'
  };

  var el = {
    list: null,
    detail: null,
    statusSel: null,
    assignedSel: null,
    prioritySel: null,
    refreshBtn: null
  };

  function setNotice(type, text, scope) {
    state.noticeType = String(type || '');
    state.noticeText = String(text || '');
    state.noticeScope = String(scope || 'detail');
    renderDetail();
  }

  function clearNotice() {
    state.noticeType = '';
    state.noticeText = '';
    state.noticeScope = 'detail';
  }

  function clearPdfPolling() {
    if (state.pdfPollingTimer) {
      window.clearTimeout(state.pdfPollingTimer);
    }
    state.pdfPollingTimer = null;
    state.pdfPolling = false;
  }

  function pdfEndpoint(id) {
    return '/prescriptions/' + id + '/print?pdf=1&dispatch=0';
  }

  function fetchPdfState(options) {
    options = options || {};

    if (!state.selectedId) {
      clearPdfPolling();
      return Promise.resolve(null);
    }

    var expectedId = Number(state.selectedId);

    return apiGet(pdfEndpoint(expectedId)).then(function (resp) {
      if (Number(state.selectedId || 0) !== expectedId) {
        return null;
      }

      state.pdfState = normalizePdfState(resp);
      if (!options.silent) {
        renderDetail();
      }

      return state.pdfState;
    });
  }

  function schedulePdfPolling() {
    clearPdfPolling();

    if (!state.selectedId) {
      return;
    }

    state.pdfPolling = true;
    var expectedId = Number(state.selectedId);

    function tick() {
      if (!state.selectedId || Number(state.selectedId) !== expectedId) {
        clearPdfPolling();
        return;
      }

      fetchPdfState({ silent: true }).then(function (pdfState) {
        if (!pdfState) {
          clearPdfPolling();
          return;
        }

        if (pdfState.can_download && pdfState.download_url) {
          clearPdfPolling();
          setNotice('success', 'PDF prêt au téléchargement.', 'decision');
          renderDetail();
          return;
        }

        if (pdfState.status === 'done' && !pdfState.download_url) {
          clearPdfPolling();
          setNotice(
            'error',
            pdfState.last_error_message || 'Erreur de configuration S3 : lien de téléchargement impossible à générer.',
            'decision'
          );
          renderDetail();
          return;
        }

        if (pdfState.status === 'failed' || pdfState.status === 'degraded') {
          clearPdfPolling();
          setNotice(
            'error',
            pdfState.last_error_message || 'Le PDF est temporairement indisponible.',
            'decision'
          );
          renderDetail();
          return;
        }

        state.pdfPolling = true;
        state.pdfPollingTimer = window.setTimeout(tick, 2000);
        renderDetail();
      }).catch(function () {
        state.pdfPolling = true;
        state.pdfPollingTimer = window.setTimeout(tick, 3000);
      });
    }

    state.pdfPollingTimer = window.setTimeout(tick, 2000);
  }

  function isUserBusy() {
    var ae = document.activeElement;
    if (!ae) return false;

    var id = ae.id || '';
    if (id === 'sp-compose-body' || id === 'sp-reject-reason') return true;

    try {
      if (ae.closest && ae.closest('.sp-chat-composer')) return true;
      if (ae.closest && ae.closest('.sp-decision-card')) return true;
    } catch (e) {}

    return false;
  }

  function renderShell() {
    root.innerHTML =
      '<div class="sosprescription-doctor">' +
      '  <div class="sp-card">' +
      '    <div class="sp-top">' +
      '      <div class="sp-title"><h2>Console médecin' + (isSandbox ? ' <span class="sp-badge sp-badge-warn">Sandbox</span>' : '') + '</h2></div>' +
      '      <div class="sp-toolbar">' +
      '        <select id="sp-filter-status" class="sp-select">' +
      '          <option value="pending">En attente</option>' +
      '          <option value="payment_pending">Paiement en attente</option>' +
      '          <option value="in_review">En cours</option>' +
      '          <option value="needs_info">Infos requises</option>' +
      '          <option value="approved">Validées</option>' +
      '          <option value="rejected">Refusées</option>' +
      '          <option value="all">Tout</option>' +
      '        </select>' +
      '        <select id="sp-filter-assigned" class="sp-select">' +
      '          <option value="all">Toutes</option>' +
      '          <option value="me">Assignées à moi</option>' +
      '          <option value="unassigned">Non assignées</option>' +
      '        </select>' +
      '        <select id="sp-filter-priority" class="sp-select">' +
      '          <option value="all">Toutes priorités</option>' +
      '          <option value="express">Express</option>' +
      '          <option value="standard">Standard</option>' +
      '        </select>' +
      '        <button id="sp-refresh" class="sp-btn sp-btn-secondary" type="button">Rafraîchir</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="sp-muted" style="margin-top:8px;">Connecté : ' + escHtml(currentUserName || '—') + '</div>' +
      '    <div class="sp-grid" style="margin-top:16px;">' +
      '      <div class="sp-col-list">' +
      '        <div class="sp-card-title">File</div>' +
      '        <div id="sp-list" class="sp-list"></div>' +
      '      </div>' +
      '      <div class="sp-col-detail">' +
      '        <div class="sp-card-title">Dossier</div>' +
      '        <div id="sp-detail"></div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    el.list = document.getElementById('sp-list');
    el.detail = document.getElementById('sp-detail');
    el.statusSel = document.getElementById('sp-filter-status');
    el.assignedSel = document.getElementById('sp-filter-assigned');
    el.prioritySel = document.getElementById('sp-filter-priority');
    el.refreshBtn = document.getElementById('sp-refresh');

    el.statusSel.value = state.filterStatus;
    el.assignedSel.value = state.filterAssigned;
    el.prioritySel.value = state.filterPriority;

    el.statusSel.addEventListener('change', function () {
      state.filterStatus = el.statusSel.value || 'pending';
      fetchQueue(false);
    });

    el.assignedSel.addEventListener('change', function () {
      state.filterAssigned = el.assignedSel.value || 'all';
      fetchQueue(false);
    });

    el.prioritySel.addEventListener('change', function () {
      state.filterPriority = el.prioritySel.value || 'all';
      fetchQueue(false);
    });

    el.refreshBtn.addEventListener('click', function () {
      fetchQueue(true);
    });

    renderList();
    renderDetail();
  }

  function renderList() {
    if (!el.list) return;

    if (state.listLoading && !state.list.length) {
      el.list.innerHTML = '<div class="sp-card"><div class="sp-muted">Chargement de la file…</div></div>';
      return;
    }

    var list = safeArr(state.list);
    if (!list.length) {
      el.list.innerHTML = '<div class="sp-card"><div class="sp-muted">Aucun dossier.</div></div>';
      return;
    }

    var filtered = list.filter(function (it) {
      if (!it) return false;

      if (state.filterAssigned === 'me') {
        return Number(it.doctor_user_id || 0) === currentUserId;
      }

      if (state.filterAssigned === 'unassigned') {
        return Number(it.doctor_user_id || 0) < 1;
      }

      return true;
    }).filter(function (it) {
      if (state.filterPriority === 'all') return true;
      return String(it.priority || '').toLowerCase() === String(state.filterPriority).toLowerCase();
    });

    if (!filtered.length) {
      el.list.innerHTML = '<div class="sp-card"><div class="sp-muted">Aucun dossier pour ce filtre.</div></div>';
      return;
    }

    var html = '';
    filtered.forEach(function (it) {
      var id = Number(it.id || 0);
      var uid = String(it.uid || id);
      var st = statusMeta(it.status);
      var pr = priorityMeta(it.priority);
      var selected = Number(state.selectedId || 0) === id ? ' is-selected' : '';
      var assignedBadge = Number(it.doctor_user_id || 0) > 0
        ? '<span class="sp-badge sp-badge-soft">Assigné</span>'
        : '<span class="sp-badge sp-badge-soft">Libre</span>';

      html += ''
        + '<button type="button" class="sp-list-item' + selected + '" data-id="' + id + '">'
        + '  <div class="sp-row">'
        + '    <div class="sp-uid">' + escHtml(uid) + '</div>'
        + '    <span class="' + escAttr(st.cls) + '">' + escHtml(st.label) + '</span>'
        + '  </div>'
        + '  <div class="sp-row" style="margin-top:6px;">'
        + '    <div class="sp-muted">' + escHtml(String(it.created_at || '')) + '</div>'
        + '    <span class="' + escAttr(pr.cls) + '">' + escHtml(pr.label) + '</span>'
        + '  </div>'
        + '  <div class="sp-row" style="margin-top:6px;">'
        + '    <div class="sp-muted">' + escHtml(flowMeta(it.flow).label) + '</div>'
        + '    ' + assignedBadge
        + '  </div>'
        + '</button>';
    });

    el.list.innerHTML = html;

    Array.prototype.slice.call(el.list.querySelectorAll('button[data-id]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-id') || 0);
        if (!id) return;
        selectCase(id);
      });
    });
  }

  function renderDetail() {
    if (!el.detail) return;

    if (!state.selectedId) {
      el.detail.innerHTML = '<div class="sp-card"><div class="sp-muted">Sélectionnez un dossier dans la file.</div></div>';
      return;
    }

    if (state.detailLoading && !state.selected) {
      el.detail.innerHTML = '<div class="sp-card"><div class="sp-muted">Chargement du dossier…</div></div>';
      return;
    }

    var rx = state.selected;
    if (!rx) {
      el.detail.innerHTML = '<div class="sp-card"><div class="sp-muted">Dossier introuvable.</div></div>';
      return;
    }

    var st = statusMeta(rx.status);
    var pr = priorityMeta(rx.priority);
    var fl = flowMeta(rx.flow);

    var detailNoticeHtml = '';
    var decisionNoticeHtml = '';
    if (state.noticeText) {
      if (state.noticeScope === 'decision') {
        decisionNoticeHtml = '<div class="sp-inline-notice">' + renderNoticeHtml(state.noticeType, state.noticeText) + '</div>';
      } else {
        detailNoticeHtml = '<div class="sp-inline-notice">' + renderNoticeHtml(state.noticeType, state.noticeText) + '</div>';
      }
    }

    var patientName = rx.patient_name || 'Patient';
    var age = rx.patient_age_label || '';
    var dob = rx.patient_dob || '';
    var patientLine = escHtml(patientName);
    if (age) patientLine += ' <span class="sp-muted">• ' + escHtml(age) + '</span>';
    if (dob) patientLine += ' <span class="sp-muted">• ' + escHtml(dob) + '</span>';

    var created = rx.created_at ? escHtml(rx.created_at) : '—';
    var uid = rx.uid ? escHtml(rx.uid) : String(state.selectedId);

    var items = Array.isArray(rx.items) ? rx.items : [];
    var medsHtml = items.length
      ? '<ul class="sp-meds">' + items.map(function (it) {
          var denom = it.denomination || it.label || it.name || '—';
          var pos = it.posologie || '';
          return ''
            + '<li class="sp-med">'
            + '  <div class="sp-med-name">' + escHtml(denom) + '</div>'
            + (pos ? '<div class="sp-muted">' + escHtml(pos) + '</div>' : '')
            + '</li>';
        }).join('') + '</ul>'
      : '<div class="sp-muted">Aucun médicament.</div>';

    var files = Array.isArray(rx.files) ? rx.files : [];
    var rxpdfList = files.filter(function (f) { return f && f.purpose === 'rx_pdf'; });
    var rxpdf = rxpdfList.length ? rxpdfList[rxpdfList.length - 1] : null;
    var otherDocs = files.filter(function (f) { return f && f.purpose !== 'rx_pdf'; });

    var docsHtml = '';
    if (otherDocs.length) {
      docsHtml = ''
        + '<div class="sp-card">'
        + '  <div class="sp-card-title">Documents</div>'
        + otherDocs.map(function (f) {
            var badge = f.purpose === 'evidence'
              ? '<span class="sp-badge sp-badge-soft">Preuve</span>'
              : '<span class="sp-badge sp-badge-soft">PJ</span>';

            return ''
              + '<div class="sp-file-row">'
              + '  <div class="sp-file-main">'
              + '    ' + badge + ' <span class="sp-file-name">' + escHtml(f.original_name || 'document') + '</span>'
              + '    <div class="sp-muted">' + escHtml(f.mime || '') + (typeof f.size_bytes === 'number' ? ' • ' + prettyBytes(f.size_bytes) : '') + '</div>'
              + '  </div>'
              + '  <div class="sp-file-actions">'
              + '    <button type="button" class="sp-btn sp-btn-secondary" data-dl-url="' + escAttr(f.download_url || '') + '" data-dl-name="' + escAttr(f.original_name || 'document') + '">Télécharger</button>'
              + '  </div>'
              + '</div>';
        }).join('')
        + '</div>';
    }

    var msgs = safeArr(state.messages);
    var chatHistoryHtml = msgs.length
      ? '<div class="sp-chat-history">' + msgs.map(function (m) {
          var from = m.from === 'doctor' ? 'Médecin' : 'Patient';
          var ts = m.created_at ? escHtml(m.created_at) : '';
          var attachments = Array.isArray(m.attachments) ? m.attachments : [];
          var attHtml = attachments.length
            ? '<div class="sp-chat-att">' + attachments.map(function (a) {
                return '<button type="button" class="sp-link" data-dl-url="' + escAttr(a.download_url || '') + '" data-dl-name="' + escAttr(a.original_name || 'piece-jointe') + '">📎 ' + escHtml(a.original_name || 'pièce jointe') + '</button>';
              }).join('') + '</div>'
            : '';

          return ''
            + '<div class="sp-chat-msg">'
            + '  <div class="sp-chat-meta"><strong>' + escHtml(from) + '</strong>' + (ts ? '<span class="sp-muted"> • ' + ts + '</span>' : '') + '</div>'
            + '  <div class="sp-chat-body">' + escHtml(m.body || '') + '</div>'
            + attHtml
            + '</div>';
        }).join('') + '</div>'
      : '<div class="sp-muted">Espace d’échange sécurisé avec le patient.</div>';

    var pdfState = state.pdfState || {};
    var pdfStatus = String(pdfState.status || '').toLowerCase();
    var pdfDownloadUrl = '';
    var pdfDownloadName = 'ordonnance-' + uid + '.pdf';
    var pdfCanDownload = false;

    if (rxpdf && rxpdf.download_url) {
      pdfCanDownload = true;
      pdfDownloadUrl = String(rxpdf.download_url || '');
      pdfDownloadName = String(rxpdf.original_name || pdfDownloadName);
    }

    if (pdfState && pdfState.download_url) {
      pdfDownloadUrl = String(pdfState.download_url);
      pdfCanDownload = !!pdfState.can_download || pdfDownloadUrl !== '';
    }

    if (pdfState && pdfState.can_download && pdfDownloadUrl) {
      pdfCanDownload = true;
    }

    var pdfBusy = !pdfCanDownload && (state.pdfPolling || pdfStatus === 'pending' || pdfStatus === 'processing');
    var pdfDoneNoLink = !pdfCanDownload && pdfStatus === 'done';
    var pdfFailed = !pdfCanDownload && (pdfStatus === 'failed' || pdfStatus === 'degraded');

    var pdfCardHtml = '';
    if (pdfCanDownload && pdfDownloadUrl) {
      pdfCardHtml = ''
        + '<div class="sp-stack">'
        + '  <div>'
        + '    <div class="sp-card-title" style="margin-bottom:6px;">Ordonnance (PDF)</div>'
        + '    <div class="sp-muted">PDF prêt au téléchargement.</div>'
        + '  </div>'
        + '  <button type="button" class="sp-btn sp-btn-primary sp-pdf-download" id="sp-download-rx" data-dl-url="' + escAttr(pdfDownloadUrl) + '" data-dl-name="' + escAttr(pdfDownloadName) + '">📥 Télécharger l’Ordonnance</button>'
        + (pdfState && pdfState.expires_in ? '<div class="sp-muted">Lien sécurisé temporaire (' + escHtml(String(pdfState.expires_in)) + ' s).</div>' : '')
        + '</div>';
    } else if (pdfDoneNoLink) {
      pdfCardHtml = ''
        + '<div class="sp-stack">'
        + '  <div>'
        + '    <div class="sp-card-title" style="margin-bottom:6px;">Ordonnance (PDF)</div>'
        + '    <div class="sp-muted">Le PDF est marqué comme généré, mais aucun lien de téléchargement n’est disponible.</div>'
        + '  </div>'
        + '  <div class="sp-alert sp-alert-error">' + escHtml(pdfState.last_error_message || 'Erreur de configuration S3 : lien de téléchargement impossible à générer.') + '</div>'
        + '</div>';
    } else if (pdfBusy) {
      pdfCardHtml = ''
        + '<div class="sp-stack">'
        + '  <div class="sp-card-title" style="margin-bottom:6px;">Ordonnance (PDF)</div>'
        + '  <button type="button" class="sp-btn sp-btn-secondary" id="sp-generate-rx" disabled aria-disabled="true" aria-busy="true">'
        + '    <span class="sp-spinner">Génération en cours...</span>'
        + '  </button>'
        + '</div>';
    } else if (pdfFailed) {
      pdfCardHtml = ''
        + '<div class="sp-stack">'
        + '  <div>'
        + '    <div class="sp-card-title" style="margin-bottom:6px;">Ordonnance (PDF)</div>'
        + '    <div class="sp-muted">La dernière génération a échoué ou est temporairement indisponible.</div>'
        + '  </div>'
        + '  <div class="sp-alert sp-alert-error">' + escHtml(pdfState.last_error_message || 'Le PDF est temporairement indisponible.') + '</div>'
        + '  <button type="button" class="sp-btn sp-btn-secondary" id="sp-generate-rx">Relancer la génération</button>'
        + '</div>';
    } else {
      pdfCardHtml = ''
        + '<div class="sp-stack">'
        + '  <div>'
        + '    <div class="sp-card-title" style="margin-bottom:6px;">Ordonnance (PDF)</div>'
        + '    <div class="sp-muted">Avant validation, générez l’ordonnance PDF.</div>'
        + '  </div>'
        + '  <button type="button" class="sp-btn sp-btn-secondary" id="sp-generate-rx">Générer PDF</button>'
        + '</div>';
    }

    var decisionLocked = pdfCanDownload || pdfBusy || pdfDoneNoLink || pdfFailed || String(rx.status || '').toLowerCase() === 'approved' || String(rx.status || '').toLowerCase() === 'rejected';
    var validateLabel = isSandbox
      ? 'Valider (mode test)'
      : (String(rx.payment_status || '') === 'authorized' ? 'Valider (capture paiement)' : 'Valider');

    var decisionButtons = '';
    if (!decisionLocked) {
      decisionButtons = ''
        + '<div class="sp-row sp-wrap" style="margin-top:12px;">'
        + '  <button type="button" class="sp-btn sp-btn-success" id="sp-approve">' + escHtml(validateLabel) + '</button>'
        + '  <button type="button" class="sp-btn sp-btn-danger" id="sp-reject">Refuser</button>'
        + '</div>'
        + '<div style="margin-top:12px;">'
        + '  <label class="sp-muted" for="sp-reject-reason">Motif de refus (visible patient)</label>'
        + '  <textarea id="sp-reject-reason" rows="3" class="sp-input" placeholder="Motif de refus…">' + escHtml(state.rejectReason || '') + '</textarea>'
        + '</div>';
    }

    el.detail.innerHTML =
      detailNoticeHtml +
      '<div class="sp-stack">' +
      '  <div class="sp-card">' +
      '    <div class="sp-card-title">Dossier</div>' +
      '    <div class="sp-row sp-wrap">' +
      '      <div>' +
      '        <div class="sp-case-id"><span class="sp-mono">' + uid + '</span></div>' +
      '        <div class="sp-muted">' + created + (fl && fl.label ? ' • ' + escHtml(fl.label) : '') + '</div>' +
      '      </div>' +
      '      <div class="sp-row sp-wrap">' +
      '        <span class="' + escAttr(st.cls) + '">' + escHtml(st.label) + '</span>' +
      '        <span class="' + escAttr(pr.cls) + '">' + escHtml(pr.label) + '</span>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="sp-card">' +
      '    <div class="sp-card-title">Patient</div>' +
      '    <div>' + patientLine + '</div>' +
      (rx.note ? '<div class="sp-muted" style="margin-top:8px;">Note : ' + escHtml(rx.note) + '</div>' : '') +
      '  </div>' +
      '  <div class="sp-card">' +
      '    <div class="sp-card-title">Médicaments</div>' +
      medsHtml +
      '  </div>' +
      docsHtml +
      '  <div class="sp-card">' +
      '    <div class="sp-card-title">Messagerie</div>' +
      '    <div class="sp-muted" style="margin-bottom:10px;">Canal sécurisé actif.</div>' +
      chatHistoryHtml +
      '    <div class="sp-chat-composer" style="margin-top:12px;">' +
      '      <input type="file" id="sp-compose-files" class="hidden" multiple accept="image/*,.pdf" />' +
      '      <textarea id="sp-compose-body" class="sp-textarea" rows="3" placeholder="Rédigez votre message ici...">' + escHtml(state.composeBody || '') + '</textarea>' +
      '      <div class="sp-row sp-wrap" style="justify-content:flex-start;">' +
      '        <button type="button" class="sp-btn sp-btn-secondary" id="sp-compose-pick">Ajouter un document</button>' +
      '        <button type="button" class="sp-btn sp-btn-primary" id="sp-send">Envoyer</button>' +
      '      </div>' +
      '      <div id="sp-compose-att" class="sp-compose-att"></div>' +
      '      <div class="sp-muted">Échanges chiffrés (TLS).</div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="sp-card">' +
      '    <div class="sp-card-title">Actions</div>' +
      '    <div class="sp-row sp-wrap">' +
      '      <button type="button" class="sp-btn sp-btn-primary" id="sp-assign">Assigner à moi</button>' +
      '      <button type="button" class="sp-btn sp-btn-secondary" id="sp-set-wait">Mettre en attente</button>' +
      '      <button type="button" class="sp-btn sp-btn-secondary" id="sp-set-needs">Demander info</button>' +
      '      <button type="button" class="sp-btn sp-btn-secondary" id="sp-set-review">Marquer en cours</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="sp-card sp-decision-card">' +
      '    <div class="sp-card-title">Décision</div>' +
      decisionNoticeHtml +
      pdfCardHtml +
      decisionButtons +
      '  </div>' +
      '</div>';

    bindDetailActions();
    updateComposeAttachmentHint();
  }

  function bindDetailActions() {
    var btnAssign = document.getElementById('sp-assign');
    if (btnAssign) btnAssign.addEventListener('click', doAssign);

    var btnWait = document.getElementById('sp-set-wait');
    if (btnWait) {
      btnWait.addEventListener('click', function () {
        doSetStatus('pending');
      });
    }

    var btnNeeds = document.getElementById('sp-set-needs');
    if (btnNeeds) {
      btnNeeds.addEventListener('click', function () {
        doSetStatus('needs_info');
      });
    }

    var btnReview = document.getElementById('sp-set-review');
    if (btnReview) {
      btnReview.addEventListener('click', function () {
        doSetStatus('in_review');
      });
    }

    var composeBody = document.getElementById('sp-compose-body');
    if (composeBody) {
      composeBody.addEventListener('input', function () {
        state.composeBody = composeBody.value || '';
      });
    }

    var composeFiles = document.getElementById('sp-compose-files');
    if (composeFiles) {
      composeFiles.addEventListener('change', function () {
        uploadComposeFiles(composeFiles.files || []);
        composeFiles.value = '';
      });
    }

    var btnPick = document.getElementById('sp-compose-pick');
    if (btnPick && composeFiles) {
      btnPick.addEventListener('click', function () {
        composeFiles.click();
      });
    }

    var btnSend = document.getElementById('sp-send');
    if (btnSend) btnSend.addEventListener('click', function () { doSendMessage(false); });

    var btnGenerate = document.getElementById('sp-generate-rx');
    if (btnGenerate) {
      btnGenerate.addEventListener('click', function () {
        if (!btnGenerate.disabled) doGenerateRxPdf();
      });
    }

    var btnApprove = document.getElementById('sp-approve');
    if (btnApprove) btnApprove.addEventListener('click', doApprove);

    var btnReject = document.getElementById('sp-reject');
    if (btnReject) {
      btnReject.addEventListener('click', function () {
        var textarea = document.getElementById('sp-reject-reason');
        state.rejectReason = textarea && typeof textarea.value === 'string' ? textarea.value : (state.rejectReason || '');
        doReject();
      });
    }

    var btnDownloadRx = document.getElementById('sp-download-rx');
    if (btnDownloadRx) {
      btnDownloadRx.addEventListener('click', function () {
        var url = btnDownloadRx.getAttribute('data-dl-url') || '';
        var name = btnDownloadRx.getAttribute('data-dl-name') || 'ordonnance.pdf';
        downloadAny(url, name).catch(function (err) {
          setNotice('error', err && err.message ? err.message : 'Erreur téléchargement', 'decision');
        });
      });
    }

    Array.prototype.slice.call(el.detail.querySelectorAll('[data-dl-url]')).forEach(function (node) {
      if (node.id === 'sp-download-rx') return;
      node.addEventListener('click', function () {
        var url = node.getAttribute('data-dl-url') || '';
        var name = node.getAttribute('data-dl-name') || 'document';
        downloadAny(url, name).catch(function (err) {
          setNotice('error', err && err.message ? err.message : 'Erreur téléchargement', 'detail');
        });
      });
    });
  }

  function updateComposeAttachmentHint() {
    var hint = document.getElementById('sp-compose-att');
    if (!hint) return;

    var ids = safeArr(state.composeAttachments);
    hint.textContent = ids.length ? ('Pièces jointes prêtes : ' + ids.join(', ')) : '';
  }

  function selectCase(id) {
    state.selectedId = Number(id || 0);
    state.selected = null;
    state.messages = [];
    state.composeBody = '';
    state.composeAttachments = [];
    state.rejectReason = '';
    state.pdfState = null;
    clearNotice();
    clearPdfPolling();
    renderList();
    refreshSelected();
  }

  function refreshSelected(options) {
    options = options || {};
    if (!state.selectedId) {
      renderDetail();
      return;
    }

    var selectedId = Number(state.selectedId);
    state.detailLoading = !options.silent;
    if (!options.silent) {
      renderDetail();
    }

    Promise.all([
      apiGet('/prescriptions/' + selectedId),
      apiGet('/prescriptions/' + selectedId + '/messages?limit=200&offset=0').catch(function () { return []; }),
      fetchPdfState({ silent: true }).catch(function () { return null; })
    ]).then(function (results) {
      if (Number(state.selectedId || 0) !== selectedId) return;

      state.selected = results[0];
      state.messages = safeArr(results[1]);
      if (results[2]) state.pdfState = results[2];
      state.detailLoading = false;
      renderDetail();
    }).catch(function (err) {
      state.detailLoading = false;
      setNotice('error', err && err.message ? err.message : 'Erreur chargement dossier', 'detail');
      renderDetail();
    });
  }

  function fetchQueue(keepSelection, options) {
    options = options || {};
    state.listLoading = !options.silent;
    if (!options.silent) {
      renderList();
    }

    var qs = '?limit=200&offset=0';
    if (state.filterStatus && state.filterStatus !== 'all') {
      qs += '&status=' + encodeURIComponent(state.filterStatus);
    }

    apiGet('/prescriptions' + qs).then(function (arr) {
      state.list = safeArr(arr);
      state.listLoading = false;
      renderList();

      if (!state.list.length) {
        state.selectedId = null;
        state.selected = null;
        clearPdfPolling();
        renderDetail();
        return;
      }

      if (!keepSelection || !state.selectedId) {
        state.selectedId = Number(state.list[0].id || 0);
        refreshSelected();
        return;
      }

      var exists = state.list.some(function (it) {
        return Number(it.id || 0) === Number(state.selectedId || 0);
      });

      if (!exists) {
        state.selectedId = Number(state.list[0].id || 0);
      }

      refreshSelected({ silent: !!options.silent });
    }).catch(function (err) {
      state.listLoading = false;
      setNotice('error', err && err.message ? err.message : 'Erreur chargement file', 'detail');
      renderList();
      renderDetail();
    });
  }

  function doAssign() {
    if (!state.selectedId) return;

    apiPostJson('/prescriptions/' + state.selectedId + '/assign', {}).then(function () {
      setNotice('success', 'Dossier assigné à vous.', 'detail');
      fetchQueue(true, { silent: true });
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur assignation', 'detail');
    });
  }

  function doSetStatus(status) {
    if (!state.selectedId) return;

    apiPostJson('/prescriptions/' + state.selectedId + '/status', { status: String(status) }).then(function () {
      setNotice('success', 'Statut mis à jour.', 'detail');
      fetchQueue(true, { silent: true });
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur statut', 'detail');
    });
  }

  function uploadComposeFiles(fileList) {
    if (!state.selectedId) return;

    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var chain = Promise.resolve([]);
    files.forEach(function (file) {
      chain = chain.then(function (acc) {
        return apiUploadFile(file, 'message', state.selectedId).then(function (uploaded) {
          acc.push(uploaded);
          return acc;
        });
      });
    });

    chain.then(function (uploadedArr) {
      var ids = safeArr(uploadedArr).map(function (u) {
        return Number(u && u.id ? u.id : 0);
      }).filter(function (id) {
        return id > 0;
      });

      state.composeAttachments = safeArr(state.composeAttachments).concat(ids);
      setNotice('success', ids.length + ' fichier(s) prêt(s).', 'detail');
      updateComposeAttachmentHint();
      refreshSelected({ silent: true });
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur upload', 'detail');
    });
  }

  function doSendMessage(andNeedsInfo) {
    if (!state.selectedId) return;

    var body = String(state.composeBody || '').trim();
    var att = safeArr(state.composeAttachments);

    if (!body) {
      setNotice('error', 'Message vide.', 'detail');
      return;
    }

    apiPostJson('/prescriptions/' + state.selectedId + '/messages', {
      body: body,
      attachments: att.length ? att : undefined
    }).then(function () {
      state.composeBody = '';
      state.composeAttachments = [];
      updateComposeAttachmentHint();
      setNotice('success', 'Message envoyé.', 'detail');

      if (andNeedsInfo) {
        return apiPostJson('/prescriptions/' + state.selectedId + '/status', { status: 'needs_info' });
      }
    }).then(function () {
      refreshSelected({ silent: true });
      renderDetail();
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur envoi', 'detail');
    });
  }

  function doGenerateRxPdf() {
    if (!state.selectedId) return;

    clearPdfPolling();
    clearNotice();

    state.pdfState = {
      status: 'pending',
      can_download: false,
      download_url: '',
      expires_in: 0,
      job_id: 0,
      req_id: '',
      last_error_code: '',
      last_error_message: '',
      s3_ready: false,
      message: ''
    };
    state.pdfPolling = true;
    renderDetail();

    apiPostJson('/prescriptions/' + state.selectedId + '/rx-pdf', {}).then(function (resp) {
      state.pdfState = normalizePdfState(resp);

      if (state.pdfState.can_download && state.pdfState.download_url) {
        clearPdfPolling();
        setNotice('success', 'PDF prêt au téléchargement.', 'decision');
        refreshSelected({ silent: true });
        renderDetail();
        return;
      }

      if (state.pdfState.status === 'done' && !state.pdfState.download_url) {
        clearPdfPolling();
        setNotice(
          'error',
          state.pdfState.last_error_message || 'Erreur de configuration S3 : lien de téléchargement impossible à générer.',
          'decision'
        );
        renderDetail();
        return;
      }

      refreshSelected({ silent: true });
      schedulePdfPolling();
      renderDetail();
    }).catch(function (err) {
      clearPdfPolling();
      state.pdfState = {
        status: 'failed',
        can_download: false,
        download_url: '',
        expires_in: 0,
        job_id: 0,
        req_id: '',
        last_error_code: '',
        last_error_message: err && err.message ? err.message : 'Erreur génération PDF',
        s3_ready: false,
        message: ''
      };
      setNotice('error', state.pdfState.last_error_message, 'decision');
      renderDetail();
    });
  }

  function doApprove() {
    if (!state.selectedId) return;

    clearNotice();

    apiPostJson('/prescriptions/' + state.selectedId + '/decision', { decision: 'approved' }).then(function (resp) {
      if (resp && resp.pdf) {
        state.pdfState = normalizePdfState(resp);
      }

      if (state.pdfState && state.pdfState.can_download && state.pdfState.download_url) {
        setNotice('success', 'PDF prêt au téléchargement.', 'decision');
      } else if (state.pdfState && state.pdfState.status === 'done' && !state.pdfState.download_url) {
        setNotice(
          'error',
          state.pdfState.last_error_message || 'Erreur de configuration S3 : lien de téléchargement impossible à générer.',
          'decision'
        );
      } else if (state.pdfState && (state.pdfState.status === 'pending' || state.pdfState.status === 'processing')) {
        clearNotice();
      }

      fetchQueue(true, { silent: true });
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur validation', 'decision');
    });
  }

  function doReject() {
    if (!state.selectedId) return;

    var textarea = document.getElementById('sp-reject-reason');
    var reason = textarea && typeof textarea.value === 'string' ? textarea.value : (state.rejectReason || '');

    apiPostJson('/prescriptions/' + state.selectedId + '/decision', {
      decision: 'rejected',
      reason: reason
    }).then(function () {
      state.rejectReason = '';
      setNotice('success', 'Ordonnance refusée.', 'decision');
      clearPdfPolling();
      fetchQueue(true, { silent: true });
    }).catch(function (err) {
      setNotice('error', err && err.message ? err.message : 'Erreur refus', 'decision');
    });
  }

  function startAutoRefresh() {
    function loop() {
      if (!isUserBusy()) {
        fetchQueue(true, { silent: true });
      }
      window.setTimeout(loop, 15000);
    }

    window.setTimeout(loop, 15000);
  }

  ensureInlineStyle();
  renderShell();
  fetchQueue(false);
  startAutoRefresh();
})();
