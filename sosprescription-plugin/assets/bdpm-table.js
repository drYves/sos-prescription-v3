(function () {
  var root = document.getElementById('sosprescription-bdpm-table-root')
  if (!root) return

  var cfg = window.SosPrescription || {}
  var restBase = String(cfg.restBase || '')
  var nonce = String(cfg.nonce || '')

  function escHtml(s) {
    s = String(s == null ? '' : s)
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function api(path) {
    var url = restBase.replace(/\/$/, '') + path
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        'X-WP-Nonce': nonce,
        'X-Sos-Scope': 'sosprescription_bdpm_table'
      }
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (e) {
          data = null
        }
        if (!res.ok) {
          var msg = data && typeof data.message === 'string' ? data.message : 'Erreur API'
          throw new Error(msg)
        }
        return data
      })
    })
  }

  if (!restBase || !nonce) {
    root.innerHTML = '<div class="sosprescription-bdpm"><div class="sp-error">Configuration REST manquante (restBase/nonce).</div></div>'
    return
  }

  var defaultPerPage = Number(root.getAttribute('data-per-page') || 20)
  if (!isFinite(defaultPerPage) || defaultPerPage < 10) defaultPerPage = 20
  if (defaultPerPage > 50) defaultPerPage = 50

  var state = {
    q: '',
    page: 1,
    perPage: defaultPerPage,
    total: 0,
    loading: false,
    error: '',
    items: []
  }

  function render() {
    var version = root.getAttribute('data-bdpm-version') || ''
    var imported = root.getAttribute('data-bdpm-imported') || ''

    var meta = ''
    if (version || imported) {
      meta = '<div class="sp-muted">BDPM en base : ' + escHtml(version || '—') + (imported ? ' • importé le ' + escHtml(imported) : '') + '</div>'
    }

    root.innerHTML = ''
    var wrap = document.createElement('div')
    wrap.className = 'sosprescription-bdpm'
    wrap.innerHTML = ''
      + '<div class="sp-card">'
      + '  <div class="sp-title">'
      + '    <img alt="" src="' + escHtml(String(root.getAttribute('data-icon') || '')) + '" style="width:22px;height:22px;" />'
      + '    <h2>Catalogue médicaments (BDPM)</h2>'
      + '  </div>'
      + meta
      + '  <div class="sp-toolbar">'
      + '    <input class="sp-input" id="sp-q" type="text" placeholder="Rechercher : nom, CIS, CIP7, CIP13…" />'
      + '    <select class="sp-select" id="sp-per">'
      + '      <option value="10">10 / page</option>'
      + '      <option value="20">20 / page</option>'
      + '      <option value="50">50 / page</option>'
      + '    </select>'
      + '    <button class="sp-btn" id="sp-search">Rechercher</button>'
      + '    <button class="sp-btn sp-btn-secondary" id="sp-clear">Réinitialiser</button>'
      + '  </div>'
      + '  <div class="sp-muted" style="margin-top:8px;">Astuce : tapez au moins 2 caractères (ou un code CIS/CIP) pour interroger la base.</div>'
      + '  <div id="sp-msg"></div>'
      + '  <div class="sp-table-wrap">'
      + '    <table>'
      + '      <thead>'
      + '        <tr>'
      + '          <th>Dénomination</th>'
      + '          <th>Présentation</th>'
      + '          <th>CIS</th>'
      + '          <th>CIP13</th>'
      + '          <th>Remb.</th>'
      + '          <th>Prix TTC</th>'
      + '        </tr>'
      + '      </thead>'
      + '      <tbody id="sp-tbody"></tbody>'
      + '    </table>'
      + '  </div>'
      + '  <div class="sp-footer">'
      + '    <div class="sp-muted" id="sp-count">—</div>'
      + '    <div class="sp-pagination">'
      + '      <button class="sp-btn sp-btn-secondary" id="sp-prev">Précédent</button>'
      + '      <span class="sp-muted" id="sp-page">Page 1</span>'
      + '      <button class="sp-btn sp-btn-secondary" id="sp-next">Suivant</button>'
      + '    </div>'
      + '  </div>'
      + '</div>'

    root.appendChild(wrap)

    var qEl = document.getElementById('sp-q')
    var perEl = document.getElementById('sp-per')
    var searchBtn = document.getElementById('sp-search')
    var clearBtn = document.getElementById('sp-clear')
    var prevBtn = document.getElementById('sp-prev')
    var nextBtn = document.getElementById('sp-next')

    if (qEl) qEl.value = state.q
    if (perEl) perEl.value = String(state.perPage)

    if (searchBtn) searchBtn.disabled = state.loading
    if (clearBtn) clearBtn.disabled = state.loading
    if (prevBtn) prevBtn.disabled = state.loading || state.page <= 1

    var totalPages = state.total > 0 ? Math.ceil(state.total / state.perPage) : 0
    if (nextBtn) nextBtn.disabled = state.loading || (totalPages ? state.page >= totalPages : state.items.length < state.perPage)

    if (qEl) {
      qEl.addEventListener('keydown', function (e) {
        if (e && e.key === 'Enter') {
          e.preventDefault()
          doSearch()
        }
      })
      qEl.addEventListener('input', debounce(function () {
        // auto-search after debounce if at least 2 chars
        var val = String(qEl.value || '').trim()
        state.q = val
        state.page = 1
        if (shouldQuery(val)) {
          fetchAndRender()
        } else {
          state.items = []
          state.total = 0
          state.error = ''
          renderTable()
        }
      }, 350))
    }

    if (perEl) {
      perEl.addEventListener('change', function () {
        var v = Number(perEl.value || 20)
        if (!isFinite(v) || v < 10) v = 20
        if (v > 50) v = 50
        state.perPage = v
        state.page = 1
        if (shouldQuery(state.q)) {
          fetchAndRender()
        } else {
          renderTable()
        }
      })
    }

    if (searchBtn) {
      searchBtn.addEventListener('click', function (e) {
        e.preventDefault()
        doSearch()
      })
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.preventDefault()
        state.q = ''
        state.page = 1
        state.items = []
        state.total = 0
        state.error = ''
        render()
      })
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', function (e) {
        e.preventDefault()
        if (state.page <= 1) return
        state.page -= 1
        fetchAndRender()
      })
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', function (e) {
        e.preventDefault()
        state.page += 1
        fetchAndRender()
      })
    }

    renderTable()
  }

  function shouldQuery(q) {
    q = String(q || '').trim()
    if (!q) return false
    // autoriser recherche codes
    if (/^\d{7}$/.test(q)) return true
    if (/^\d{13}$/.test(q)) return true
    if (/^\d{6,9}$/.test(q)) return true // CIS souvent 8
    return q.length >= 2
  }

  function debounce(fn, delay) {
    var t = null
    return function () {
      var args = arguments
      clearTimeout(t)
      t = setTimeout(function () {
        fn.apply(null, args)
      }, delay)
    }
  }

  function setMsg(html) {
    var el = document.getElementById('sp-msg')
    if (!el) return
    el.innerHTML = html
  }

  function renderTable() {
    var tbody = document.getElementById('sp-tbody')
    var countEl = document.getElementById('sp-count')
    var pageEl = document.getElementById('sp-page')
    if (!tbody || !countEl || !pageEl) return

    if (!shouldQuery(state.q)) {
      tbody.innerHTML = ''
      setMsg('<div class="sp-empty">Saisissez une recherche pour afficher des résultats.</div>')
      countEl.textContent = '—'
      pageEl.textContent = 'Page 1'
      return
    }

    if (state.loading) {
      setMsg('<div class="sp-empty">Chargement…</div>')
    } else if (state.error) {
      setMsg('<div class="sp-error">' + escHtml(state.error) + '</div>')
    } else if (!state.items || state.items.length < 1) {
      setMsg('<div class="sp-empty">Aucun résultat.</div>')
    } else {
      setMsg('')
    }

    var rows = ''
    for (var i = 0; i < (state.items || []).length; i++) {
      var it = state.items[i] || {}
      var denom = it.denomination ? String(it.denomination) : ''
      var pres = it.libelle_presentation ? String(it.libelle_presentation) : ''
      var cis = it.cis ? String(it.cis) : ''
      var cip13 = it.cip13 ? String(it.cip13) : ''
      var remb = it.taux_remboursement ? String(it.taux_remboursement) : ''
      var prix = (it.prix_ttc !== null && it.prix_ttc !== undefined && it.prix_ttc !== '') ? String(it.prix_ttc) : ''

      rows += '<tr>'
      rows += '<td><strong>' + escHtml(denom) + '</strong></td>'
      rows += '<td>' + (pres ? escHtml(pres) : '<span class="sp-muted">—</span>') + '</td>'
      rows += '<td><span class="sp-pill">' + escHtml(cis) + '</span></td>'
      rows += '<td>' + (cip13 ? '<span class="sp-pill">' + escHtml(cip13) + '</span>' : '<span class="sp-muted">—</span>') + '</td>'
      rows += '<td>' + (remb ? escHtml(remb) : '<span class="sp-muted">—</span>') + '</td>'
      rows += '<td>' + (prix ? escHtml(prix) + ' €' : '<span class="sp-muted">—</span>') + '</td>'
      rows += '</tr>'
    }

    tbody.innerHTML = rows

    var totalPages = state.total > 0 ? Math.ceil(state.total / state.perPage) : 0
    if (state.total > 0) {
      countEl.textContent = state.total + ' résultat(s)'
      pageEl.textContent = 'Page ' + state.page + ' / ' + totalPages
    } else {
      countEl.textContent = (state.items && state.items.length ? state.items.length + ' résultat(s)' : '0 résultat')
      pageEl.textContent = 'Page ' + state.page
    }
  }

  function doSearch() {
    var qEl = document.getElementById('sp-q')
    if (qEl) {
      state.q = String(qEl.value || '').trim()
    }
    state.page = 1
    if (!shouldQuery(state.q)) {
      state.items = []
      state.total = 0
      state.error = ''
      renderTable()
      return
    }
    fetchAndRender()
  }

  function fetchAndRender() {
    if (state.loading) return

    state.loading = true
    state.error = ''
    renderTable()

    var q = encodeURIComponent(String(state.q || ''))
    var page = encodeURIComponent(String(state.page || 1))
    var per = encodeURIComponent(String(state.perPage || 20))

    api('/medications/table?q=' + q + '&page=' + page + '&perPage=' + per)
      .then(function (res) {
        state.loading = false
        state.error = ''
        state.items = (res && res.items && Array.isArray(res.items)) ? res.items : []
        state.total = (res && typeof res.total === 'number') ? res.total : 0
        // if server returns page, sync
        if (res && typeof res.page === 'number' && res.page >= 1) {
          state.page = res.page
        }
        render()
      })
      .catch(function (e) {
        state.loading = false
        state.items = []
        state.total = 0
        state.error = e && e.message ? String(e.message) : 'Erreur chargement'
        render()
      })
  }

  // Inject icon URL for header
  root.setAttribute('data-icon', String(root.getAttribute('data-icon') || (cfg.site && cfg.site.url ? (cfg.site.url + 'wp-content/plugins/sosprescription/assets/caduceus.svg') : '')))

  render()
})()
