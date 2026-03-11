(function () {
  var root = document.getElementById('sosprescription-doctor-console-root')
  if (!root) return

  var cfg = window.SosPrescription || {}
  var restBase = String(cfg.restBase || '')
  var nonce = String(cfg.nonce || '')
  var isSandbox = !!(cfg && cfg.sandbox && cfg.sandbox.testing_mode)
  var currentUser = (cfg.currentUser && typeof cfg.currentUser === 'object') ? cfg.currentUser : {}
  var currentUserId = Number(currentUser.id || 0)
  var currentUserName = String(currentUser.displayName || '')

  function escHtml(s) {
    s = String(s == null ? '' : s)
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function escAttr(s) {
    // Escape for HTML attributes (including quotes).
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function prettyBytes(bytes) {
    var b = Number(bytes || 0);
    if (!isFinite(b) || b <= 0) return '0 o';
    var units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    var u = 0;
    while (b >= 1024 && u < units.length - 1) {
      b = b / 1024;
      u++;
    }
    var val = (u === 0 || b >= 10) ? Math.round(b) : (Math.round(b * 10) / 10);
    // French decimal comma for readability.
    return String(val).replace('.', ',') + ' ' + units[u];
  }


  function apiJson(path, opts) {
    opts = opts || {}
    var method = String(opts.method || 'GET').toUpperCase()

    // Cache-busting for GET requests:
    // Some host/CDN setups can cache wp-json responses too aggressively.
    // Adding a timestamp parameter makes each request URL unique.
    // NOTE: We also set fetch cache: 'no-store'.
    var urlPath = String(path || '')
    if (method === 'GET') {
      urlPath += (urlPath.indexOf('?') === -1 ? '?' : '&') + '_ts=' + Date.now()
    }

    var url = restBase.replace(/\/$/, '') + urlPath
    var headers = Object.assign(
      {
        'X-WP-Nonce': nonce,
        'X-Sos-Scope': 'sosprescription_doctor_console'
      },
      opts.headers || {}
    )

    return fetch(url, {
      method: method,
      headers: headers,
      body: opts.body,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      var headerRid = res.headers.get('X-SOSPrescription-Request-ID') || res.headers.get('X-SP-Request-ID') || ''
      return res.text().then(function (text) {
        var data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (e) {
          data = null
        }

        if (!res.ok) {
          var rid = (data && data._request_id) ? data._request_id : headerRid

          var baseMsg = ''
          if (data && typeof data.message === 'string' && data.message) {
            baseMsg = data.message
          } else if (text) {
            baseMsg = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
          } else {
            baseMsg = res.statusText || 'Erreur API'
          }

          // Message plus explicite pour les cas fréquents
          if (res.status === 403) {
            baseMsg = 'Accès refusé (403). Veuillez rafraîchir la page ou vous reconnecter.'
          } else if (res.status === 404) {
            baseMsg = 'Ressource introuvable (404).'
          } else if (res.status >= 500 && !baseMsg) {
            baseMsg = 'Erreur serveur. Réessayez dans quelques instants.'
          }

          var parts = []
          parts.push('HTTP ' + res.status)
          if (rid) parts.push('Req ' + rid)
          parts.push(path)

          var msg = baseMsg + ' — ' + parts.join(' · ')
          var err = new Error(msg)
          err.status = res.status
          err.path = path
          err.url = url
          err.requestId = rid
          err.payload = data

          try {
            console.error('[SOS Prescription] Erreur API', {
              status: res.status,
              path: path,
              requestId: rid,
              payload: data
            })
          } catch (e) {}

          throw err
        }

        return data
      })
    })
  }

  // Convenience wrappers (older code paths expect these helpers).
  // Keep them here so the console doesn't crash on load.
  function apiGet(path) {
    return apiJson(path, { method: 'GET' })
  }

  function apiPostJson(path, payload) {
    var body = (payload == null) ? {} : payload
    return apiJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  function apiUploadFile(file, purpose, prescriptionId) {
    var url = restBase.replace(/\/$/, '') + '/files'
    var fd = new FormData()
    fd.append('file', file)
    fd.append('purpose', String(purpose || 'message'))
    if (prescriptionId) fd.append('prescription_id', String(prescriptionId))

    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-WP-Nonce': nonce,
        'X-Sos-Scope': 'sosprescription_doctor_console'
      },
      body: fd
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (e) {
          data = null
        }
        if (!res.ok) {
          var reqId = res.headers.get('X-SOSPrescription-Request-ID') || res.headers.get('X-SP-Request-ID') || ''
          var rid = (data && data._request_id) ? data._request_id : reqId
          var msg = (data && typeof data.message === 'string') ? data.message : 'Erreur upload'
          var bits = []
          bits.push('HTTP ' + res.status)
          if (rid) bits.push('Req ' + rid)
          throw new Error(msg + (bits.length ? ' — ' + bits.join(' · ') : ''))
        }
        return data
      })
    })
  }

  // Téléchargement protégé : le endpoint /files/:id/download exige le nonce.
  // On télécharge donc via fetch + blob puis on déclenche un download navigateur.
  function downloadWithNonce(url, filename) {
    if (!url) {
      return Promise.reject(new Error('URL de téléchargement manquante'));
    }
    var name = filename || 'document.pdf';
    return fetch(url, {
      method: 'GET',
      headers: { 'X-WP-Nonce': nonce },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error(t || ('Erreur téléchargement (' + res.status + ')'));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        var objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(objectUrl);
        }, 1500);
      });
  }

  function fmtMoney(cents, currency) {
    var n = typeof cents === 'number' ? cents : Number(cents || 0)
    var cur = String(currency || 'EUR').toUpperCase()
    return (n / 100).toFixed(2) + ' ' + cur
  }

  function statusMeta(status) {
    var s = String(status || '').toLowerCase()
    if (s === 'payment_pending') return { label: 'Paiement en attente', cls: 'sp-badge sp-badge-warn' }
    if (s === 'pending') return { label: 'En attente', cls: 'sp-badge sp-badge-warn' }
    if (s === 'in_review') return { label: 'En cours', cls: 'sp-badge' }
    if (s === 'needs_info') return { label: 'Infos requises', cls: 'sp-badge sp-badge-warn' }
    if (s === 'approved') return { label: 'Validée', cls: 'sp-badge sp-badge-success' }
    if (s === 'rejected') return { label: 'Refusée', cls: 'sp-badge sp-badge-danger' }
    return { label: status || '—', cls: 'sp-badge' }
  }

  function priorityMeta(priority) {
    var p = String(priority || '').toLowerCase()
    if (p === 'express') return { label: 'Express', cls: 'sp-badge sp-badge-warn' }
    if (p === 'standard') return { label: 'Standard', cls: 'sp-badge' }
    return { label: priority || '—', cls: 'sp-badge' }
  }

  function flowMeta(flow) {
    var f = String(flow || '')
    if (f === 'ro_proof' || f === 'renewal') {
      return { label: 'Renouvellement (avec preuve)', value: f }
    }
    if (f === 'depannage_no_proof') {
      return { label: 'Dépannage (sans preuve)', value: f }
    }
    if (!f) return { label: '—', value: '' }
    return { label: f, value: f }
  }

  function safeArr(x) {
    return Array.isArray(x) ? x : []
  }

  // Avoid UI "tremble" + input resets during background polling.
  // If the doctor is interacting with critical inputs (messagerie / décision),
  // we postpone rendering updates until the next poll tick.
  function isUserBusy() {
    var ae = document.activeElement
    if (!ae) return false
    var id = ae.id || ''
    if (id === 'sp-compose-body' || id === 'sp-reject-reason') return true
    try {
      if (ae.closest && ae.closest('.sp-chat-composer')) return true
      if (ae.closest && ae.closest('.sp-decision')) return true
    } catch (e) {}
    return false
  }


// Signature légère (string) pour détecter si la file de dossiers a changé.
// Objectif UX : éviter les clignotements "Chargement…" toutes les 15s.
function listSignature(list) {
  return safeArr(list)
    .map(function (it) {
      if (!it) return ''
      var id = Number(it.id || 0)
      if (!id) return ''
      return [
        String(id),
        String(it.status || ''),
        String(it.priority || ''),
        String(it.flow || ''),
        String(it.payment_status || ''),
        String(it.doctor_user_id || '')
      ].join(':')
    })
    .filter(function (x) { return x !== '' })
    .join('|')
}

function itemSignature(it) {
  if (!it) return ''
  var id = Number(it.id || 0)
  if (!id) return ''
  return [
    String(id),
    String(it.status || ''),
    String(it.priority || ''),
    String(it.flow || ''),
    String(it.payment_status || ''),
    String(it.doctor_user_id || '')
  ].join(':')
}

// Préserve le scroll de la liste pendant un refresh silencieux.
function renderListKeepScroll() {
  if (!el.list) {
    renderList()
    return
  }
  var top = el.list.scrollTop
  renderList()
  try {
    el.list.scrollTop = top
  } catch (e) {}
}

  var state = {
    filterStatus: 'pending',
    filterAssigned: 'all', // all | me | unassigned
    filterPriority: 'all', // all | standard | express
    listLoading: false,
    list: [],
    selectedId: null,
    selected: null,
    selectedLoading: false,
    messagesLoading: false,
    messages: [],
    composeBody: '',
    composeAttachments: [],
    rejectReason: '',
    info: '',
    error: ''
  }

  var el = {
    msg: null,
    list: null,
    detail: null,
    statusSel: null,
    assignedSel: null,
    prioritySel: null,
    refreshBtn: null
  }

  function setError(msg) {
    state.error = String(msg || '')
    if (state.error) state.info = ''
    renderMsg()
    renderDetail()
  }

  function setInfo(msg) {
    state.info = String(msg || '')
    if (state.info) state.error = ''
    renderMsg()
    renderDetail()
  }

  function renderMsg() {
    if (!el.msg) return
    if (state.error) {
      el.msg.innerHTML = '<div class="sp-alert sp-alert-error">' + escHtml(state.error) + '</div>'
      return
    }
    if (state.info) {
      el.msg.innerHTML = '<div class="sp-alert">' + escHtml(state.info) + '</div>'
      return
    }
    el.msg.innerHTML = ''
  }

  function renderShell() {
    if (!restBase || !nonce) {
      root.innerHTML = '<div class="sosprescription-doctor"><div class="sp-card"><div class="sp-alert sp-alert-error">Configuration REST manquante (restBase/nonce).</div></div></div>'
      return
    }

    root.innerHTML = ''

    var wrap = document.createElement('div')
    wrap.className = 'sosprescription-doctor'

    var sandboxBadge = (cfg && cfg.sandbox && cfg.sandbox.testing_mode)
      ? ' <span class="sp-badge sp-badge-sandbox">Sandbox</span>'
      : '';

    wrap.innerHTML = ''
      + '<div class="sp-card">'
      + '  <div class="sp-top">'
      + '    <div class="sp-title"><h2>Console médecin' + sandboxBadge + '</h2></div>'
      + '    <div class="sp-toolbar">'
      + '      <select id="sp-filter-status" class="sp-select">'
      + '        <option value="pending">En attente</option>'
      + '        <option value="payment_pending">Paiement en attente</option>'
      + '        <option value="in_review">En cours</option>'
      + '        <option value="needs_info">Infos requises</option>'
      + '        <option value="approved">Validées</option>'
      + '        <option value="rejected">Refusées</option>'
      + '        <option value="all">Tout</option>'
      + '      </select>'
      + '      <select id="sp-filter-assigned" class="sp-select">'
      + '        <option value="all">Toutes</option>'
      + '        <option value="me">Assignées à moi</option>'
      + '        <option value="unassigned">Non assignées</option>'
      + '      </select>'
      + '      <select id="sp-filter-priority" class="sp-select">'
      + '        <option value="all">Toutes priorités</option>'
      + '        <option value="express">Express</option>'
      + '        <option value="standard">Standard</option>'
      + '      </select>'
      + '      <button id="sp-refresh" class="sp-btn sp-btn-secondary">Rafraîchir</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="sp-muted">Connecté : ' + escHtml(currentUserName || ('Utilisateur #' + currentUserId)) + '</div>'
      + '  <div id="sp-msg" class="sp-msg"></div>'
      + '  <div class="sp-grid">'
      + '    <div>'
      + '      <div class="sp-section">'
      + '        <h3>File</h3>'
      + '        <div id="sp-list" class="sp-list"></div>'
      + '      </div>'
      + '    </div>'
      + '    <div>'
      + '      <div class="sp-section">'
      + '        <h3>Dossier</h3>'
      + '        <div id="sp-detail" class="sp-detail"></div>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>'

    root.appendChild(wrap)

    el.msg = document.getElementById('sp-msg')
    el.list = document.getElementById('sp-list')
    el.detail = document.getElementById('sp-detail')
    el.statusSel = document.getElementById('sp-filter-status')
    el.assignedSel = document.getElementById('sp-filter-assigned')
    el.prioritySel = document.getElementById('sp-filter-priority')
    el.refreshBtn = document.getElementById('sp-refresh')

    if (el.statusSel) el.statusSel.value = state.filterStatus
    if (el.assignedSel) el.assignedSel.value = state.filterAssigned
    if (el.prioritySel) el.prioritySel.value = state.filterPriority

    if (el.statusSel) {
      el.statusSel.addEventListener('change', function () {
        state.filterStatus = String(el.statusSel.value || 'pending')
        fetchQueue(true)
      })
    }

    if (el.assignedSel) {
      el.assignedSel.addEventListener('change', function () {
        state.filterAssigned = String(el.assignedSel.value || 'all')
        renderList()
      })
    }

    if (el.prioritySel) {
      el.prioritySel.addEventListener('change', function () {
        state.filterPriority = String(el.prioritySel.value || 'all')
        renderList()
      })
    }

    if (el.refreshBtn) {
      el.refreshBtn.addEventListener('click', function (e) {
        e.preventDefault()
        fetchQueue(true)
        refreshSelected()
      })
    }

    renderMsg()
    renderList()
    renderDetail()
  }

  function renderList() {
    if (!el.list) return

    if (state.listLoading) {
      el.list.innerHTML = '<div class="sp-empty">Chargement…</div>'
      return
    }

    var items = safeArr(state.list)

    // client-side filters
    items = items.filter(function (it) {
      if (state.filterAssigned === 'me') {
        return Number(it.doctor_user_id || 0) === currentUserId
      }
      if (state.filterAssigned === 'unassigned') {
        return !it.doctor_user_id
      }
      return true
    })

    items = items.filter(function (it) {
      if (state.filterPriority === 'express') return String(it.priority || '') === 'express'
      if (state.filterPriority === 'standard') return String(it.priority || '') === 'standard'
      return true
    })

    // sort: express first, then newest
    items.sort(function (a, b) {
      var pa = String(a.priority || '') === 'express' ? 0 : 1
      var pb = String(b.priority || '') === 'express' ? 0 : 1
      if (pa !== pb) return pa - pb
      var da = String(a.created_at || '')
      var db = String(b.created_at || '')
      return db.localeCompare(da)
    })

    if (items.length === 0) {
      el.list.innerHTML = '<div class="sp-empty">Aucune demande.</div>'
      return
    }

    var html = ''
    items.forEach(function (it) {
      var id = Number(it.id || 0)
      var uid = String(it.uid || ('#' + id))
      var st = statusMeta(it.status)
      var pr = priorityMeta(it.priority)
      var assignedToMe = Number(it.doctor_user_id || 0) === currentUserId
      var badgeAssigned = assignedToMe ? '<span class="sp-badge">Assignée à moi</span>' : (it.doctor_user_id ? '<span class="sp-badge">Assignée</span>' : '')
      var selected = (state.selectedId && Number(state.selectedId) === id) ? ' is-selected' : ''

      html += ''
        + '<button class="sp-list-item' + selected + '" data-id="' + id + '">'
        + '  <div class="sp-row">'
        + '    <div class="sp-uid">' + escHtml(uid) + '</div>'
        + '    <span class="' + escHtml(st.cls) + '">' + escHtml(st.label) + '</span>'
        + '  </div>'
        + '  <div class="sp-row" style="margin-top:6px;">'
        + '    <div class="sp-muted">' + escHtml(String(it.created_at || '')) + '</div>'
        + '    <span class="' + escHtml(pr.cls) + '">' + escHtml(pr.label) + '</span>'
        + '  </div>'
        + '  <div class="sp-row" style="margin-top:6px;">'
        + '    <div class="sp-muted">' + escHtml(flowMeta(it.flow).label) + '</div>'
        + '    ' + badgeAssigned
        + '  </div>'
        + '</button>'
    })

    el.list.innerHTML = html

    // bind
    Array.prototype.slice.call(el.list.querySelectorAll('button[data-id]')).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault()
        var id = Number(btn.getAttribute('data-id') || 0)
        if (!id) return
        selectCase(id)
      })
    })
  }

  function fileMapFromSelected() {
    var map = {}
    var files = state.selected ? safeArr(state.selected.files) : []
    files.forEach(function (f) {
      if (f && f.id) map[Number(f.id)] = f
    })
    return map
  }

  function renderDetail() {
  if (!el.detail) return

  // No selection yet
  if (!state.selectedId) {
    el.detail.innerHTML =
      '<div class="sp-card"><div class="sp-muted">Sélectionnez un dossier dans la file.</div></div>'
    return
  }

  if (state.selectedLoading) {
    el.detail.innerHTML =
      '<div class="sp-card"><div class="sp-muted">Chargement du dossier…</div></div>'
    return
  }

  var rx = state.selected
  if (!rx) {
    el.detail.innerHTML =
      '<div class="sp-card"><div class="sp-muted">Dossier introuvable.</div></div>'
    return
  }

  var st = statusMeta(rx.status)
  var pr = priorityMeta(rx.priority)
  var fl = flowMeta(rx.flow)

  var patientName = rx.patient_name || 'Patient'
  var age = rx.patient_age_label || ''
  var dob = rx.patient_dob || ''

  var patientLine = escHtml(patientName)
  if (age) patientLine += ' <span class="sp-muted">• ' + escHtml(age) + '</span>'
  if (dob) patientLine += ' <span class="sp-muted">• ' + escHtml(dob) + '</span>'

  var created = rx.created_at ? escHtml(rx.created_at) : '—'
  var uid = rx.uid ? escHtml(rx.uid) : String(state.selectedId)

  var items = Array.isArray(rx.items) ? rx.items : []
  var medsHtml = items.length
    ? '<ul class="sp-meds">' +
      items
        .map(function (it) {
          // API retourne actuellement les items avec "denomination" (source BDPM)
          // On garde des fallbacks pour compat.
          var denom = it.denomination || it.label || it.name || '—'
          var name = escHtml(denom)
          var pos = escHtml(it.posologie || '')
          return (
            '<li class="sp-med">' +
            '<div class="sp-med-name">' +
            name +
            '</div>' +
            (pos ? '<div class="sp-muted sp-med-pos">' + pos + '</div>' : '') +
            '</li>'
          )
        })
        .join('') +
      '</ul>'
    : '<div class="sp-muted">Aucun médicament.</div>'

  var files = Array.isArray(rx.files) ? rx.files : []
  var rxpdfList = files.filter(function (f) {
    return f.purpose === 'rx_pdf'
  })
  var rxpdf = rxpdfList.length ? rxpdfList[rxpdfList.length - 1] : null
  var otherDocs = files.filter(function (f) {
    return f.purpose !== 'rx_pdf'
  })

  // Documents (preuves + pièces jointes chat)
  var docsHtml = ''
  if (otherDocs.length) {
    docsHtml =
      '<div class="sp-card">' +
      '<div class="sp-card-title">Documents</div>' +
      otherDocs
        .map(function (f) {
          var name = escHtml(f.original_name || 'document')
          var badge =
            f.purpose === 'evidence'
              ? '<span class="sp-badge sp-badge-soft">Preuve</span>'
              : '<span class="sp-badge sp-badge-soft">PJ</span>'
          return (
            '<div class="sp-file-row">' +
            '<div class="sp-file-main">' +
            badge +
            ' <span class="sp-file-name">' +
            name +
            '</span>' +
            '<div class="sp-muted sp-file-meta">' +
            escHtml(f.mime || '') +
            (typeof f.size_bytes === 'number' ? ' • ' + prettyBytes(f.size_bytes) : '') +
            '</div>' +
            '</div>' +
            '<div class="sp-file-actions">' +
            '<button type="button" class="sp-btn sp-btn-secondary" data-dl-url="' +
            escAttr(f.download_url) +
            '" data-dl-name="' +
            escAttr(f.original_name || 'document') +
            '">Télécharger</button>' +
            '</div>' +
            '</div>'
          )
        })
        .join('') +
      '</div>'
  }

  // Messagerie (historique)
  // Les messages sont chargés via l'endpoint /prescriptions/:id/messages.
  // L'objet "rx" (prescription) ne contient pas l'historique.
  var msgs = safeArr(state.messages)
  var chatHistoryHtml = ''
  if (msgs.length) {
    chatHistoryHtml =
      '<div class="sp-chat-history">' +
      msgs
        .map(function (m) {
          var from = m.from === 'doctor' ? 'Médecin' : 'Patient'
          var body = escHtml(m.body || '')
          var ts = m.created_at ? escHtml(m.created_at) : ''
          var attachments = Array.isArray(m.attachments) ? m.attachments : []
          var attHtml = attachments.length
            ? '<div class="sp-chat-att">' +
              attachments
                .map(function (a) {
                  var aname = escHtml(a.original_name || 'pièce jointe')
                  return (
                    '<button type="button" class="sp-link" data-dl-url="' +
                    escAttr(a.download_url) +
                    '" data-dl-name="' +
                    escAttr(a.original_name || 'piece-jointe') +
                    '">📎 ' +
                    aname +
                    '</button>'
                  )
                })
                .join('') +
              '</div>'
            : ''
          return (
            '<div class="sp-chat-msg">' +
            '<div class="sp-chat-meta">' +
            '<strong>' +
            from +
            '</strong>' +
            (ts ? '<span class="sp-muted"> • ' + ts + '</span>' : '') +
            '</div>' +
            (body ? '<div class="sp-chat-body">' + body + '</div>' : '') +
            attHtml +
            '</div>'
          )
        })
        .join('') +
      '</div>'
  }

  // Inline messages (important on mobile / colonne étroite)
  var inlineMsg = ''
  if (state.error) {
    inlineMsg = '<div class="sp-alert sp-alert-error">' + escHtml(state.error) + '</div>'
  } else if (state.info) {
    inlineMsg = '<div class="sp-alert sp-alert-info">' + escHtml(state.info) + '</div>'
  }

  // PDF block (génération + download)
  var pdfActions = ''
  if (rxpdf) {
    pdfActions =
      '<div class="sp-row sp-between sp-gap">' +
      '<div>' +
      '<div class="sp-strong">Ordonnance (PDF)</div>' +
      '<div class="sp-muted">Prête : ' +
      escHtml(rxpdf.original_name || 'ordonnance.pdf') +
      '</div>' +
      '</div>' +
      '<div class="sp-row sp-gap">' +
      '<button type="button" class="sp-btn sp-btn-secondary" data-dl-url="' +
      escAttr(rxpdf.download_url) +
      '" data-dl-name="' +
      escAttr(rxpdf.original_name || 'ordonnance.pdf') +
      '">Télécharger</button>' +
      '<button type="button" class="sp-btn sp-btn-secondary" id="sp-generate-rx">Régénérer</button>' +
      '' +
      '</div>' +
      '</div>' +
      ''
  } else {
    pdfActions =
      '<div class="sp-row sp-between sp-gap">' +
      '<div>' +
      '<div class="sp-strong">Ordonnance (PDF)</div>' +
      '<div class="sp-muted">Avant validation, générez l’ordonnance (PDF).</div>' +
      '</div>' +
      '<div class="sp-row sp-gap">' +
      '<button type="button" class="sp-btn sp-btn-secondary" id="sp-generate-rx">Générer PDF</button>' +
      '' +
      '</div>' +
      '</div>' +
      ''
  }

  var validateLabel = isSandbox ? 'Valider (mode test)' : (rx.payment_status === 'authorized' ? 'Valider (capture paiement)' : 'Valider')
  var approveDisabled = rxpdf ? '' : 'disabled'
  var approveTitle = rxpdf
    ? ''
    : ' title="Générez ou importez un PDF avant validation" aria-disabled="true"'

  var noteHtml = rx.note ? '<div class="sp-muted">Note : ' + escHtml(rx.note) + '</div>' : ''

  // Pattern "card stack" (aligné avec l'espace patient)
  var dossierCard =
    '<div class="sp-card">' +
    '<div class="sp-card-title">Dossier</div>' +
    '<div class="sp-row sp-between sp-gap sp-wrap">' +
    '<div>' +
    '<div class="sp-case-id"><span class="sp-mono">' +
    uid +
    '</span></div>' +
    '<div class="sp-muted">' +
    created +
    (fl && fl.label ? ' • ' + escHtml(fl.label) : '') +
    '</div>' +
    '</div>' +
    '<div class="sp-row sp-gap sp-wrap">' +
    '<span class="sp-badge ' +
    st.cls +
    '">' +
    st.label +
    '</span>' +
    '<span class="sp-badge ' +
    pr.cls +
    '">' +
    pr.label +
    '</span>' +
    '</div>' +
    '</div>' +
    '</div>'

  var patientCard =
    '<div class="sp-card">' +
    '<div class="sp-card-title">Patient</div>' +
    '<div class="sp-patient-name">' +
    patientLine +
    '</div>' +
    noteHtml +
    '</div>'

  var medsCard =
    '<div class="sp-card">' +
    '<div class="sp-card-title">Médicaments</div>' +
    medsHtml +
    '</div>'

  // --- Messagerie (UI premium)
  var icoChat = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>'
  var icoPaperclip = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.84 8.84a2 2 0 1 1-2.83-2.83l8.49-8.49"/></svg>'
  var icoSend = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg>'

  var chatTitle = 'Messagerie'
  var chatSubtitle = 'Espace d’échange sécurisé avec le patient.'

  var chatHead =
    '  <div class="sp-card-hdr sp-chat-hdr">' +
    '    <div class="sp-chat-hdr-left">' +
    '      <div class="sp-chat-hdr-icon" aria-hidden="true">' + icoChat + '</div>' +
    '      <div>' +
    '        <div class="sp-chat-title">' + escHtml(chatTitle) + '</div>' +
    '        <div class="sp-chat-subtitle">' + escHtml(chatSubtitle) + '</div>' +
    '      </div>' +
    '    </div>' +
    '    <div class="sp-pill sp-pill-success"><span class="sp-dot" aria-hidden="true"></span><span>Canal sécurisé actif</span></div>' +
    '  </div>'

  var composer =
    '    <div class="sp-chat-composer sp-chat-composer-premium">' +
    '      <input type="file" id="sp-compose-files" class="hidden" multiple accept="image/*,.pdf" />' +
    '      <div class="sp-chat-input-wrap">' +
    '        <button class="sp-chat-inset-btn" id="sp-compose-pick" type="button" aria-label="Ajouter un document">' + icoPaperclip + '</button>' +
    '        <textarea id="sp-compose-body" class="sp-textarea sp-chat-textarea" rows="3" placeholder="Rédigez votre message ici..."></textarea>' +
    '      </div>' +
    '      <button class="sp-btn sp-btn-primary sp-chat-send" id="sp-send" type="button">' + icoSend + '<span>Envoyer</span></button>' +
    '    </div>' +
    '    <div id="sp-compose-att" class="sp-chat-attachments"></div>'

  var readOnlyNote = '    <div class="sp-text-muted">La messagerie est en lecture seule pour un dossier clôturé.</div>'

  // Variables attendues par le template (évite une erreur JS fatale).
  // Historique : si vide, on affiche un placeholder discret.
  var historyHtml = chatHistoryHtml || '<div class="sp-text-muted sp-chat-empty">Espace d’échange sécurisé avec le patient.</div>'
  // Pour l'instant, on laisse la zone d'envoi disponible même après décision
  // (le workflow serveur décidera d'accepter/refuser si besoin).
  var showChat = true

  var chatCard =
    '<div class="sp-card sp-card-chat">' +
    chatHead +
    '  <div class="sp-card-body">' +
    '    <div class="sp-chat-history-wrap">' + historyHtml + '</div>' +
    (showChat ? composer : readOnlyNote) +
    '    <div class="sp-chat-footnote">Échanges chiffrés (TLS).</div>' +
    '  </div>' +
    '</div>'

  var actionsCard =
    '<div class="sp-card">' +
    '<div class="sp-card-title">Actions</div>' +
    '<div class="sp-row sp-gap sp-wrap">' +
    '<button type="button" class="sp-btn sp-btn-primary" id="sp-assign">Assigner à moi</button>' +
    '<button type="button" class="sp-btn sp-btn-secondary" id="sp-set-wait">Mettre en attente</button>' +
    '<button type="button" class="sp-btn sp-btn-secondary" id="sp-set-needs">Demander info</button>' +
    '<button type="button" class="sp-btn sp-btn-secondary" id="sp-set-review">Marquer en cours</button>' +
    '</div>' +
    '</div>'

  var decisionCard =
    '<div class="sp-card">' +
    '<div class="sp-card-title">Décision</div>' +
    '<div class="sp-decision-card">' +
    pdfActions +
    '<div class="sp-row sp-gap sp-wrap sp-mt">' +
    '<button type="button" class="sp-btn sp-btn-success" id="sp-approve" ' +
    approveDisabled +
    approveTitle +
    '>' +
    validateLabel +
    '</button>' +
    '<button type="button" class="sp-btn sp-btn-danger" id="sp-reject">Refuser</button>' +
    '</div>' +
    '<div class="sp-mt">' +
    '<label class="sp-label">Motif de refus (visible patient)</label>' +
    '<textarea id="sp-reject-reason" rows="3" placeholder="Motif de refus…" class="sp-input"></textarea>' +
    '</div>' +
    '</div>' +
    '</div>'

  el.detail.innerHTML =
    inlineMsg +
    '<div class="sp-stack">' +
    dossierCard +
    patientCard +
    medsCard +
    docsHtml +
    chatCard +
    actionsCard +
    decisionCard +
    '</div>'

  // Bind events for new DOM
  bind()
}



function bind() {
  // Quick status/actions
  var btnAssign = document.getElementById('sp-assign')
  if (btnAssign) {
    btnAssign.addEventListener('click', function (e) {
      e.preventDefault()
      doAssign()
    })
  }

  var btnWait = document.getElementById('sp-set-wait')
  if (btnWait) {
    btnWait.addEventListener('click', function (e) {
      e.preventDefault()
      doSetStatus('pending')
    })
  }

  var btnReview = document.getElementById('sp-set-review')
  if (btnReview) {
    btnReview.addEventListener('click', function (e) {
      e.preventDefault()
      doSetStatus('in_review')
    })
  }

  var btnNeeds = document.getElementById('sp-set-needs')
  if (btnNeeds) {
    btnNeeds.addEventListener('click', function (e) {
      e.preventDefault()
      doSetStatus('needs_info')
    })
  }

  // Chat composer
  var inpBody = document.getElementById('sp-compose-body')
  if (inpBody) {
    inpBody.value = state.composeBody || ''
    inpBody.addEventListener('input', function () {
      state.composeBody = inpBody.value
    })
  }

  var inpFiles = document.getElementById('sp-compose-files')
  if (inpFiles) {
    inpFiles.addEventListener('change', function () {
      state.composeAttachments = safeArr(inpFiles.files)
      updateComposeAttachmentHint()
    })
  }

  var btnPick = document.getElementById('sp-compose-pick')
  if (btnPick && inpFiles) {
    btnPick.addEventListener('click', function (e) {
      e.preventDefault()
      inpFiles.click()
    })
  }

  var btnSend = document.getElementById('sp-send')
  if (btnSend) {
    btnSend.addEventListener('click', function (e) {
      e.preventDefault()
      doSendMessage()
    })
  }

  // Reject reason (must survive re-renders + used for API validation)
  var inpReject = document.getElementById('sp-reject-reason')
  if (inpReject) {
    inpReject.value = state.rejectReason || ''
    inpReject.addEventListener('input', function () {
      state.rejectReason = inpReject.value
    })
  }

  // PDF generation & upload
  // (Robuste) Bind sur tous les boutons (dans certains layouts, plusieurs boutons peuvent coexister)
  var genBtns = document.querySelectorAll('#sp-generate-rx')
  genBtns.forEach(function (genBtn) {
    genBtn.addEventListener('click', function (e) {
      e.preventDefault()
      doGenerateRxPdf()
    })
  })

  var rxInput = document.getElementById('sp-upload-rx')
  if (rxInput) {
    rxInput.addEventListener('change', function () {
      var f = rxInput.files && rxInput.files[0]
      if (f) uploadRxFile(f)
    })
  }

  var btnPickRx = document.getElementById('sp-pick-rx')
  if (btnPickRx && rxInput) {
    btnPickRx.addEventListener('click', function (e) {
      e.preventDefault()
      rxInput.click()
    })
  }

  // Decision buttons
  var btnApprove = document.getElementById('sp-approve')
  if (btnApprove) {
    btnApprove.addEventListener('click', function (e) {
      e.preventDefault()
      doApprove()
    })
  }

  var btnReject = document.getElementById('sp-reject')
  if (btnReject) {
    btnReject.addEventListener('click', function (e) {
      e.preventDefault()
      doReject()
    })
  }

  // Download links/buttons
  var dl = document.querySelectorAll('[data-dl-url]')
  dl.forEach(function (node) {
    node.addEventListener('click', function (e) {
      e.preventDefault()
      var url = node.getAttribute('data-dl-url')
      var name = node.getAttribute('data-dl-name') || 'document'
      if (url) downloadWithNonce(url, name)
    })
  })
}


function updateComposeAttachmentHint() {
  var elHint = document.getElementById('sp-compose-att')
  if (!elHint) return

  var files = safeArr(state.composeAttachments)
  if (!files.length) {
    elHint.textContent = ''
    return
  }

  var names = files
    .map(function (f) {
      return f && f.name ? String(f.name) : 'fichier'
    })
    .join(', ')

  elHint.textContent = 'Pièces jointes : ' + names
}

// Guards to avoid overlapping network calls (especially with auto-refresh).
var queueInFlight = false
var detailInFlight = false
var lastQueueSig = ''
var pendingQueue = null
var pendingQueueSig = ''

function fetchQueue(keepSelection, opts) {
  opts = opts || {}
  var silent = !!opts.silent

  // Avoid overlapping calls
  if (queueInFlight) return
  queueInFlight = true

  var initial = safeArr(state.list).length === 0

  // UX: show "Chargement…" only on first load or explicit refresh.
  if (!silent || initial) {
    state.listLoading = true
    renderList()
    setError('')
  }

  var qs = '?limit=200&offset=0'
  if (state.filterStatus && state.filterStatus !== 'all') {
    qs += '&status=' + encodeURIComponent(state.filterStatus)
  }

  // Snapshot: used to decide if we should refresh the selected detail.
  var prevList = safeArr(state.list)
  var prevSelectedId = state.selectedId ? Number(state.selectedId) : null
  var prevSelectedFromList = null
  if (prevSelectedId) {
    for (var i = 0; i < prevList.length; i++) {
      var it = prevList[i]
      if (Number(it && it.id ? it.id : 0) === prevSelectedId) {
        prevSelectedFromList = it
        break
      }
    }
  }
  var prevSelectedSig = itemSignature(prevSelectedFromList)

  apiGet('/prescriptions' + qs)
    .then(function (data) {
      var newList = safeArr(data)
      var newSig = listSignature(newList)
      var changed = newSig !== lastQueueSig
      lastQueueSig = newSig

      state.listLoading = false
      queueInFlight = false

      // Silent refresh: if nothing changed, do nothing (avoid UI "blink").
      if (silent && !initial && !changed) {
        return
      }

      // If the doctor is currently typing or editing a decision, postpone any DOM updates.
      // This prevents the UI from "trembling" and avoids wiping in-progress text.
      if (silent && !initial && changed && isUserBusy()) {
        pendingQueue = newList
        pendingQueueSig = newSig
        return
      }

      // We are applying an update now -> clear any pending refresh snapshot.
      pendingQueue = null
      pendingQueueSig = ''

      state.list = newList

      // Selection policy
      if (!keepSelection) {
        if (
          state.selectedId &&
          safeArr(state.list).some(function (x) {
            return Number(x.id || 0) === Number(state.selectedId)
          })
        ) {
          // keep current selection
        } else {
          var first = safeArr(state.list)[0]
          state.selectedId = first ? Number(first.id || 0) : null
        }
      } else {
        // keep selection, but if nothing is selected yet and list has items, select first.
        if ((!state.selectedId || Number(state.selectedId) < 1) && safeArr(state.list).length) {
          state.selectedId = Number(state.list[0].id || 0)
        }
      }

      // Render list (preserve scroll on silent refresh)
      if (silent && !initial) {
        renderListKeepScroll()
      } else {
        renderList()
      }

      // Refresh selected detail only when needed (avoid "Chargement du dossier…" every 15s).
      if (state.selectedId) {
        var sid = Number(state.selectedId)
        var newSelectedFromList = null
        for (var j = 0; j < newList.length; j++) {
          var it2 = newList[j]
          if (Number(it2 && it2.id ? it2.id : 0) === sid) {
            newSelectedFromList = it2
            break
          }
        }
        var newSelectedSig = itemSignature(newSelectedFromList)

        var shouldRefreshDetail = !silent
        if (silent) {
          shouldRefreshDetail = newSelectedSig !== '' && newSelectedSig !== prevSelectedSig
        }

        if (shouldRefreshDetail) {
          refreshSelected({ silent: silent })
        }
      } else {
        renderDetail()
      }
    })
    .catch(function (err) {
      state.listLoading = false
      queueInFlight = false

      if (!silent || initial) {
        renderList()
        setError(err && err.message ? err.message : 'Erreur chargement file')
      } else {
        // Silent refresh: do not spam UI, keep previous list.
        try {
          console.warn('[SOSPrescription] auto-refresh error', err)
        } catch (e) {}
      }
    })
}

// Auto-refresh (polling) so new requests appear without manual refresh.
// UX: refresh silencieux => pas de "blink" list/detail.
// IMPORTANT: use setTimeout (not setInterval) to avoid overlapping ticks.
// We also slow down slightly to make the refresh imperceptible.
var autoRefreshTimer = null
function startAutoRefresh() {
  if (autoRefreshTimer) return

  var intervalMs = 20000

  function tick() {
    try {
      if (document && document.hidden) {
        // Keep the loop alive, but do nothing when tab is hidden.
        return
      }
      if (queueInFlight) return

      // If a silent refresh snapshot was deferred while the doctor was typing,
      // apply it as soon as the UI is idle (no extra network call needed).
      if (pendingQueue && !isUserBusy()) {
        var prevList = safeArr(state.list)
        var prevSid = Number(state.selectedId || 0)
        var prevIt = null
        if (prevSid) {
          for (var i = 0; i < prevList.length; i++) {
            var it = prevList[i]
            if (Number(it && it.id ? it.id : 0) === prevSid) {
              prevIt = it
              break
            }
          }
        }
        var prevSig = itemSignature(prevIt)

        var newList = pendingQueue
        pendingQueue = null
        pendingQueueSig = ''

        state.list = safeArr(newList)
        state.listLoading = false

        if ((!state.selectedId || Number(state.selectedId) < 1) && state.list.length) {
          state.selectedId = Number(state.list[0].id || 0)
        }

        renderListKeepScroll()

        if (state.selectedId) {
          var sid = Number(state.selectedId)
          var newIt = null
          for (var j = 0; j < state.list.length; j++) {
            var it2 = state.list[j]
            if (Number(it2 && it2.id ? it2.id : 0) === sid) {
              newIt = it2
              break
            }
          }
          var newSig = itemSignature(newIt)
          if (newSig && newSig !== prevSig) {
            refreshSelected({ silent: true })
          }
        } else {
          renderDetail()
        }
        return
      }

      fetchQueue(true, { silent: true })
    } catch (e) {
      // best-effort
    }
  }

  function loop() {
    tick()
    autoRefreshTimer = window.setTimeout(loop, intervalMs)
  }

  loop()
}

function stopAutoRefresh() {
  if (!autoRefreshTimer) return
  try {
    window.clearTimeout(autoRefreshTimer)
  } catch (e) {}
  autoRefreshTimer = null
}

  function selectCase(id) {
    if (!id) return
    state.selectedId = Number(id)
    state.selected = null
    state.messages = []
    state.composeAttachments = []
    state.composeBody = ''
    state.rejectReason = ''

    renderList()
    refreshSelected()
  }

function refreshSelected(opts) {
  opts = opts || {}
  var silent = !!opts.silent

  if (!state.selectedId) {
    renderDetail()
    return
  }

  if (detailInFlight) return
  detailInFlight = true

  if (!silent) {
    state.selectedLoading = true
    state.messagesLoading = true
    renderDetail()
  }

  var id = state.selectedId

  Promise.all([
    apiGet('/prescriptions/' + id),
    apiGet('/prescriptions/' + id + '/messages?limit=200&offset=0')
  ])
    .then(function (res) {
      state.selected = res[0]
      state.messages = safeArr(res[1])
      state.selectedLoading = false
      state.messagesLoading = false
      detailInFlight = false

      // En refresh silencieux, éviter de casser la saisie en cours.
      if (silent) {
        var ae = document && document.activeElement
        if (ae && (ae.id === 'sp-compose-body' || ae.id === 'sp-reject-reason')) {
          return
        }
      }

      renderDetail()
    })
    .catch(function (err) {
      state.selectedLoading = false
      state.messagesLoading = false
      detailInFlight = false

      if (!silent) {
        setError(err && err.message ? err.message : 'Erreur chargement dossier')
        // Important : sortir de l'état "Chargement du dossier…" et afficher l'erreur.
        renderDetail()
      } else {
        try {
          console.warn('[SOSPrescription] silent detail refresh error', err)
        } catch (e) {}
      }
    })
}

  function doAssign() {
    if (!state.selectedId) return
    setError('')
    setInfo('Assignation…')

    apiPostJson('/prescriptions/' + state.selectedId + '/assign', {})
      .then(function () {
        setInfo('Assignée à vous.')
        fetchQueue(true)
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur assignation')
      })
  }

  function doSetStatus(status) {
    if (!state.selectedId) return
    setError('')
    setInfo('Mise à jour statut…')

    apiPostJson('/prescriptions/' + state.selectedId + '/status', { status: String(status) })
      .then(function () {
        setInfo('Statut mis à jour.')
        fetchQueue(true)
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur statut')
      })
  }

  function uploadComposeFiles(fileList) {
    if (!state.selectedId) return
    var files = Array.prototype.slice.call(fileList)
    if (files.length === 0) return

    setError('')
    setInfo('Upload…')

    var chain = Promise.resolve([])
    files.forEach(function (f) {
      chain = chain.then(function (acc) {
        return apiUploadFile(f, 'message', state.selectedId).then(function (uploaded) {
          acc.push(uploaded)
          return acc
        })
      })
    })

    chain
      .then(function (uploadedArr) {
        var ids = safeArr(uploadedArr).map(function (u) { return Number(u.id || 0) }).filter(function (x) { return x > 0 })
        state.composeAttachments = safeArr(state.composeAttachments).concat(ids)
        setInfo(ids.length + ' fichier(s) prêt(s).')
        updateComposeAttachmentHint()
        // refresh to include in file list mapping
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur upload')
      })
  }

  function doSendMessage(andNeedsInfo) {
    if (!state.selectedId) return
    var body = String(state.composeBody || '').trim()
    var att = safeArr(state.composeAttachments)

    if (!body) {
      setError('Message vide.')
      return
    }

    setError('')
    setInfo('Envoi…')

    apiPostJson('/prescriptions/' + state.selectedId + '/messages', {
      body: body,
      attachments: att.length ? att : undefined
    })
      .then(function () {
        state.composeBody = ''
        state.composeAttachments = []
        updateComposeAttachmentHint()
        setInfo('Message envoyé.')
        if (andNeedsInfo) {
          return apiPostJson('/prescriptions/' + state.selectedId + '/status', { status: 'needs_info' })
        }
      })
      .then(function () {
        fetchQueue(true)
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur envoi')
      })
  }

  function uploadRxFile(file) {
    if (!state.selectedId) return
    if (!file) return

    setError('')
    setInfo('Upload ordonnance…')

    apiUploadFile(file, 'rx_pdf', state.selectedId)
      .then(function () {
        setInfo('Ordonnance déposée.')
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur upload ordonnance')
      })
  }

  function doGenerateRxPdf() {
    if (!state.selectedId) return

    setError('')
    setInfo('Génération PDF…')

    apiPostJson('/prescriptions/' + state.selectedId + '/rx-pdf', {})
      .then(function (resp) {
        setInfo('PDF généré.')

        // Option: auto-download for immediate feedback (doctor)
        // L'API retourne soit {file_id}, soit directement l'objet fichier {id,...}
        var fileId = resp && (resp.file_id || resp.id)
        if (fileId) {
          apiGet('/files/' + fileId)
            .then(function (file) {
              if (file && file.download_url) {
                downloadWithNonce(file.download_url, file.original_name || 'ordonnance.pdf')
              }
            })
            .catch(function () {})
        }

        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur génération PDF')
      })
  }

  function doReject() {
    if (!state.selectedId) return
    // Read from DOM first (polling/re-render safe), then from state fallback.
    var reason = ''
    var elReason = document.getElementById('sp-reject-reason')
    if (elReason && typeof elReason.value === 'string') {
      reason = elReason.value
    }
    if (!reason) {
      reason = state.rejectReason || ''
    }
    reason = String(reason).trim()
    state.rejectReason = reason
    if (!reason) {
      setError('Motif de refus requis.')
      return
    }
    if (!window.confirm('Confirmer le refus ?')) return

    setError('')
    setInfo('Refus…')

    apiPostJson('/prescriptions/' + state.selectedId + '/decision', {
      decision: 'rejected',
      reason: reason
    })
      .then(function () {
        setInfo('Demande refusée.')
        fetchQueue(true)
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur refus')
      })
  }

  function doApprove() {
    if (!state.selectedId) return
    if (!window.confirm('Confirmer la validation ? (capture paiement si applicable)')) return

    setError('')
    setInfo('Validation…')

    apiPostJson('/prescriptions/' + state.selectedId + '/decision', {
      decision: 'approved'
    })
      .then(function () {
        setInfo('Demande validée.')
        fetchQueue(true)
        refreshSelected()
      })
      .catch(function (err) {
        setError(err && err.message ? err.message : 'Erreur validation')
      })
  }

  // init
  renderShell()

  if (!currentUserId || currentUserId < 1) {
    setError('Connexion requise. Merci de vous connecter.')
    return
  }

  fetchQueue(false)
  startAutoRefresh()
})()