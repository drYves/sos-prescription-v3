(function () {
  var cfg = window.SosPrescriptionImport || {}
  var restBase = String(cfg.restBase || '')
  var nonce = String(cfg.nonce || '')

  var fileInput = document.getElementById('sosprescription-import-file')
  var btnUpload = document.getElementById('sosprescription-import-upload')
  var btnStart = document.getElementById('sosprescription-import-start')
  var btnReset = document.getElementById('sosprescription-import-reset')

  var statusEl = document.getElementById('sosprescription-import-status')
  var progressBarEl = document.getElementById('sosprescription-import-progress-bar')
  var progressTextEl = document.getElementById('sosprescription-import-progress-text')
  var filesEl = document.getElementById('sosprescription-import-files')
  var metaEl = document.getElementById('sosprescription-import-meta')
  var historyEl = document.getElementById('sosprescription-import-history')

  var testInput = document.getElementById('sosprescription-import-test-q')
  var testDropdown = document.getElementById('sosprescription-import-test-dropdown')
  var testPicked = document.getElementById('sosprescription-import-test-picked')

  if (!restBase || !nonce) {
    if (statusEl) statusEl.textContent = 'Configuration REST manquante (restBase/nonce).'
    return
  }

  var running = false
  // Sur certains hébergements (mutualisés / WAF), une boucle trop agressive peut
  // faire échouer les appels REST. On garde une cadence raisonnable.
  var LOOP_DELAY_MS = 650
  var searchTimer = null
  var searchReqId = 0

  function escHtml(s) {
    s = String(s == null ? '' : s)
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = String(msg)
  }

  function setProgress(pct) {
    var v = Math.max(0, Math.min(100, Math.round(Number(pct || 0))))
    if (progressBarEl) progressBarEl.style.width = v + '%'
    if (progressTextEl) progressTextEl.textContent = v + '%'
  }

  function api(path, init) {
    init = init || {}
    var headers = init.headers || {}
    headers['X-WP-Nonce'] = nonce
    init.headers = headers
    init.credentials = 'same-origin'

    return fetch(restBase.replace(/\/$/, '') + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = text
        try {
          data = text ? JSON.parse(text) : null
        } catch (e) {}

        if (!res.ok) {
          var msg = data && typeof data.message === 'string' ? data.message : 'Erreur API'
          throw new Error(msg)
        }
        return data
      })
    })
  }

  function formatNumber(n) {
    n = Number(n || 0)
    if (!isFinite(n)) n = 0
    try {
      return new Intl.NumberFormat('fr-FR').format(n)
    } catch (e) {
      return String(Math.round(n))
    }
  }

  function hideDropdown() {
    if (!testDropdown) return
    testDropdown.style.display = 'none'
    testDropdown.innerHTML = ''
  }

  function showDropdownLoading() {
    if (!testDropdown) return
    var html = ''
    html += '<div class="sp-dropdown-header">'
    html += '<span>Résultats</span>'
    html += '<span>Recherche…</span>'
    html += '</div>'
    html += '<div class="sp-dropdown-body">'
    html += '<div style="padding:10px;" class="sp-muted">Chargement…</div>'
    html += '</div>'

    testDropdown.innerHTML = html
    testDropdown.style.display = 'block'
  }

  function renderDropdownItems(items) {
    if (!testDropdown) return

    var html = ''
    html += '<div class="sp-dropdown-header">'
    html += '<span>Résultats</span>'
    html += '<span class="sp-muted">Cliquez pour afficher le détail</span>'
    html += '</div>'
    html += '<div class="sp-dropdown-body">'

    if (!items || !items.length) {
      html += '<div style="padding:10px;" class="sp-muted">Aucun résultat.</div>'
    } else {
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {}
        var label = it.label ? String(it.label) : ''
        var specialite = it.specialite ? String(it.specialite) : ''
        var cis = it.cis ? String(it.cis) : ''
        var cip13 = it.cip13 ? String(it.cip13) : ''
        var taux = it.tauxRemb ? String(it.tauxRemb) : ''
        var prix = typeof it.prixTTC === 'number' ? it.prixTTC : null

        html += '<button type="button" class="sp-dropdown-item" data-idx="' + i + '">'
        html += '<div class="sp-dropdown-item-title">' + escHtml(label) + '</div>'
        html += '<div class="sp-dropdown-item-meta">'
        if (specialite) html += escHtml(specialite) + ' • '
        html += 'CIS ' + escHtml(cis)
        if (cip13) html += ' • CIP13 ' + escHtml(cip13)
        if (taux) html += ' • Remb. ' + escHtml(taux)
        if (prix !== null && isFinite(prix)) html += ' • ' + escHtml(prix.toFixed(2)) + '€'
        html += '</div>'
        html += '</button>'
      }
    }

    html += '</div>'

    testDropdown.innerHTML = html
    testDropdown.style.display = 'block'

    // Bind clicks
    var btns = testDropdown.querySelectorAll('button.sp-dropdown-item')
    for (var j = 0; j < btns.length; j++) {
      ;(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault()
          var idx = Number(btn.getAttribute('data-idx') || '0')
          var it = items && items[idx] ? items[idx] : null
          if (it) {
            renderPicked(it)
          }
          hideDropdown()
        })
      })(btns[j])
    }
  }

  function renderPicked(it) {
    if (!testPicked) return

    var label = it.label ? String(it.label) : '—'
    var specialite = it.specialite ? String(it.specialite) : ''
    var cis = it.cis ? String(it.cis) : ''
    var cip13 = it.cip13 ? String(it.cip13) : ''
    var taux = it.tauxRemb ? String(it.tauxRemb) : ''
    var prix = typeof it.prixTTC === 'number' ? it.prixTTC : null

    var html = ''
    html += '<div style="font-weight:700;">' + escHtml(label) + '</div>'
    html += '<div class="sp-muted" style="margin-top:4px;">'
    if (specialite) html += escHtml(specialite) + ' • '
    if (cis) html += 'CIS ' + escHtml(cis)
    if (cip13) html += ' • CIP13 ' + escHtml(cip13)
    if (taux) html += ' • Remb. ' + escHtml(taux)
    if (prix !== null && isFinite(prix)) html += ' • ' + escHtml(prix.toFixed(2)) + '€'
    html += '</div>'
    html += '<div class="sp-muted" style="margin-top:8px;">✅ Recherche BDPM opérationnelle.</div>'

    testPicked.innerHTML = html
  }

  function renderHistory(history) {
    if (!historyEl) return

    if (!history || !history.length) {
      historyEl.innerHTML = '<div class="sp-empty">Aucun historique disponible.</div>'
      return
    }

    var rows = ''
    for (var i = 0; i < history.length && i < 10; i++) {
      var h = history[i] || {}
      var v = h.bdpm_version ? String(h.bdpm_version) : '—'
      var at = h.imported_at ? String(h.imported_at) : '—'
      var zip = h.zip_name ? String(h.zip_name) : '—'
      var sid = h.session_id ? String(h.session_id) : '—'
      var total = typeof h.total_rows === 'number' ? h.total_rows : 0

      rows += '<tr>'
      rows += '<td><code>' + escHtml(v) + '</code></td>'
      rows += '<td>' + escHtml(at) + '</td>'
      rows += '<td>' + escHtml(zip) + '</td>'
      rows += '<td><code>' + escHtml(sid) + '</code></td>'
      rows += '<td style="text-align:right;">' + escHtml(formatNumber(total)) + '</td>'
      rows += '</tr>'
    }

    var html = ''
    html += '<div class="sp-table-wrap">'
    html += '<table class="widefat striped">'
    html += '<thead><tr>'
    html += '<th>BDPM en base</th>'
    html += '<th>Importé le</th>'
    html += '<th>ZIP</th>'
    html += '<th>Session</th>'
    html += '<th style="text-align:right;">Total lignes</th>'
    html += '</tr></thead>'
    html += '<tbody>' + rows + '</tbody>'
    html += '</table>'
    html += '</div>'

    historyEl.innerHTML = html
  }

  function renderMeta(meta, state) {
    if (!metaEl) return

    var m = meta && typeof meta === 'object' ? meta : null

    var version = m && m.bdpm_version ? String(m.bdpm_version) : '—'
    var importedAt = m && m.imported_at ? String(m.imported_at) : '—'
    var session = m && m.session_id ? String(m.session_id) : '—'
    var zip = m && m.zip_name ? String(m.zip_name) : '—'
    var total = m && typeof m.total_rows === 'number' ? m.total_rows : 0

    var activeSession = state && state.session_id ? String(state.session_id) : ''
    var activeVersion = state && state.bdpm_version ? String(state.bdpm_version) : ''

    var html = ''
    html += '<div><strong>Version BDPM en base :</strong> <code>' + escHtml(version) + '</code></div>'
    html += '<div><strong>Dernier import :</strong> ' + escHtml(importedAt) + '</div>'
    html += '<div><strong>Dernière session :</strong> <code>' + escHtml(session) + '</code></div>'
    html += '<div><strong>ZIP source :</strong> ' + escHtml(zip) + '</div>'
    html += '<div><strong>Total lignes importées :</strong> ' + escHtml(formatNumber(total)) + '</div>'

    if (activeSession && activeSession !== session) {
      html += '<div style="margin-top:10px; padding-top:10px; border-top:1px solid #dcdcde;">'
      html += '<div><strong>Session active :</strong> <code>' + escHtml(activeSession) + '</code></div>'
      if (activeVersion) {
        html += '<div style="margin-top:6px;"><strong>Version (session) :</strong> <code>' + escHtml(activeVersion) + '</code></div>'
      }
      html += '</div>'
    }

    metaEl.innerHTML = html
  }

  function renderFiles(files) {
    if (!filesEl) return

    if (!files || !files.length) {
      filesEl.innerHTML = '<div class="sp-empty">Aucun fichier reconnu / aucune session active.</div>'
      return
    }

    var rows = ''
    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {}
      var name = f.name ? String(f.name) : ''
      var table = f.table ? String(f.table) : ''
      var size = typeof f.size === 'number' ? f.size : 0
      var offset = typeof f.offset === 'number' ? f.offset : 0
      var done = !!f.done
      var rcount = typeof f.rows === 'number' ? f.rows : 0

      var pct = size > 0 ? Math.round((offset / size) * 100) : 0
      if (pct < 0) pct = 0
      if (pct > 100) pct = 100

      var badge = done
        ? '<span class="sp-badge sp-badge-ok">OK</span>'
        : pct > 0
          ? '<span class="sp-badge sp-badge-warn">…</span>'
          : '<span class="sp-badge">…</span>'

      rows += '<tr>'
      rows += '<td><code>' + escHtml(name) + '</code></td>'
      rows += '<td><code>' + escHtml(table) + '</code></td>'
      rows += '<td style="text-align:right;">' + escHtml(formatNumber(rcount)) + '</td>'
      rows += '<td>'
      rows += '<div style="display:flex; align-items:center; gap:10px;">'
      rows += '<div style="width:140px; height:10px; background:#e5e7eb; border:1px solid #dcdcde; border-radius:999px; overflow:hidden;">'
      rows += '<div style="width:' + escHtml(pct) + '%; height:100%; background:#2271b1;"></div>'
      rows += '</div>'
      rows += '<span class="sp-muted">' + escHtml(pct) + '%</span>'
      rows += '</div>'
      rows += '</td>'
      rows += '<td>' + badge + '</td>'
      rows += '</tr>'
    }

    var html = ''
    html += '<div style="margin-top:12px;">'
    html += '<div class="sp-card-subtitle">Détails fichiers</div>'
    html += '<div class="sp-table-wrap">'
    html += '<table class="widefat striped">'
    html += '<thead><tr>'
    html += '<th>Fichier</th>'
    html += '<th>Table</th>'
    html += '<th style="text-align:right;">Lignes importées</th>'
    html += '<th>Progress</th>'
    html += '<th>OK</th>'
    html += '</tr></thead>'
    html += '<tbody>' + rows + '</tbody>'
    html += '</table>'
    html += '</div>'
    html += '</div>'

    filesEl.innerHTML = html
  }

  function renderState(state) {
    renderMeta(state && state.meta ? state.meta : null, state)
    renderFiles(state && state.files ? state.files : [])
    renderHistory(state && state.meta_history ? state.meta_history : null)

    if (state && state.idle) {
      setStatus('Aucune session active. Uploadez un ZIP BDPM puis démarrez l’import.')
      setProgress(0)
      return
    }

    var pct = state && typeof state.progress === 'number' ? state.progress : 0
    setProgress(pct)

    var cur = state && state.current_file ? String(state.current_file) : ''
    var curPct = state && typeof state.current_file_progress === 'number' ? state.current_file_progress : 0

    if (state && state.done) {
      var sid = state && state.session_id ? String(state.session_id) : ''
      setStatus('Import terminé ✅' + (sid ? ' (session ' + sid + ')' : ''))
      setProgress(100)
      return
    }

    if (cur) {
      setStatus('Import… fichier: ' + cur + ' (' + Math.round(curPct) + '%) — global ' + Math.round(pct) + '%')
    } else {
      setStatus('Import… global ' + Math.round(pct) + '%')
    }
  }

  function uploadZip() {
    if (!fileInput || !fileInput.files || fileInput.files.length < 1) {
      setStatus('Veuillez sélectionner un fichier ZIP.')
      return
    }

    var file = fileInput.files[0]
    var fd = new FormData()
    fd.append('file', file)

    setStatus('Upload en cours…')
    api('/import/upload', { method: 'POST', body: fd })
      .then(function (state) {
        renderState(state)
        setStatus('Upload OK. Session: ' + (state && state.session_id ? state.session_id : '—') + ' — cliquez “Démarrer / Reprendre”.')
      })
      .catch(function (e) {
        // Fallback compat : certains hébergements bloquent les uploads via REST.
        // Dans ce cas, on retente en soumettant le formulaire classique (admin-post.php).
        try {
          var fallback = document.getElementById('sosprescription-import-upload-form')
          if (fallback && typeof fallback.submit === 'function') {
            setStatus('Upload REST indisponible. Tentative via formulaire classique…')
            fallback.submit()
            return
          }
        } catch (_) {}

        setStatus('Upload erreur: ' + (e && e.message ? e.message : '—'))
      })
  }

  function stepLoop() {
    if (running) return
    running = true
    setStatus('Démarrage import…')

    function stepOnce() {
      if (!running) return
      api('/import/step', { method: 'POST' })
        .then(function (state) {
          renderState(state)
          if (state && state.done) {
            running = false
            setTimeout(refreshStatus, 300)
            return
          }
          setTimeout(stepOnce, LOOP_DELAY_MS)
        })
        .catch(function (e) {
          running = false
          setStatus('Erreur import: ' + (e && e.message ? e.message : '—'))
        })
    }

    stepOnce()
  }

  function resetImport() {
    running = false
    setStatus('Réinitialisation…')
    setProgress(0)

    api('/import/reset', { method: 'POST' })
      .then(function () {
        setStatus('Import réinitialisé. Uploadez un ZIP puis démarrez.')
        refreshStatus()
      })
      .catch(function (e) {
        setStatus('Reset erreur: ' + (e && e.message ? e.message : '—'))
      })
  }

  function refreshStatus() {
    api('/import/status', { method: 'GET' })
      .then(function (state) {
        renderState(state)
      })
      .catch(function () {})
  }

  function doAutocompleteSearch() {
    if (!testInput || !testDropdown) return

    var q = String(testInput.value || '').trim()

    if (q.length < 2) {
      hideDropdown()
      return
    }

    var myId = ++searchReqId
    showDropdownLoading()

    api('/medications/search?q=' + encodeURIComponent(q) + '&limit=20', { method: 'GET' })
      .then(function (items) {
        if (myId !== searchReqId) return
        renderDropdownItems(items || [])
      })
      .catch(function (e) {
        if (myId !== searchReqId) return
        if (!testDropdown) return
        testDropdown.innerHTML = '<div class="sp-dropdown-header"><span>Résultats</span><span>Erreur</span></div><div style="padding:10px;" class="sp-muted">' + escHtml(e && e.message ? e.message : 'Erreur') + '</div>'
        testDropdown.style.display = 'block'
      })
  }

  if (btnUpload) {
    btnUpload.addEventListener('click', function (e) {
      e.preventDefault()
      uploadZip()
    })
  }
  if (btnStart) {
    btnStart.addEventListener('click', function (e) {
      e.preventDefault()
      stepLoop()
    })
  }
  if (btnReset) {
    btnReset.addEventListener('click', function (e) {
      e.preventDefault()
      resetImport()
    })
  }

  if (testInput) {
    testInput.addEventListener('input', function () {
      if (searchTimer) window.clearTimeout(searchTimer)
      searchTimer = window.setTimeout(doAutocompleteSearch, 200)
    })

    testInput.addEventListener('focus', function () {
      if (String(testInput.value || '').trim().length >= 2) {
        doAutocompleteSearch()
      }
    })

    testInput.addEventListener('keydown', function (e) {
      if (e && e.key === 'Escape') {
        hideDropdown()
      }
    })
  }

  document.addEventListener('click', function (e) {
    if (!testDropdown || !testInput) return
    var t = e && e.target ? e.target : null
    if (!t) return

    // click outside => close
    if (t === testInput || testInput.contains(t) || testDropdown.contains(t)) {
      return
    }
    hideDropdown()
  })

  refreshStatus()
})()
