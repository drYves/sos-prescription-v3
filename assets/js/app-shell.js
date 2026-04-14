(function () {
  function hydrateBdpmPremiumUi(root) {
    if (!root) {
      return;
    }

    var title = root.querySelector('.sosprescription-bdpm .sp-title h2');
    if (title && title.textContent.trim() !== 'Référentiel Médicaments (BDPM)') {
      title.textContent = 'Référentiel Médicaments (BDPM)';
    }

    var icon = root.querySelector('.sosprescription-bdpm .sp-title img');
    if (icon) {
      icon.classList.add('sp-bdpm-title__icon');
      icon.setAttribute('width', '24');
      icon.setAttribute('height', '24');
      icon.setAttribute('decoding', 'async');
    }

    var searchButton = root.querySelector('#sp-search');
    if (searchButton) {
      searchButton.classList.add('sp-btn-primary');
      searchButton.classList.remove('sp-btn-secondary');
    }
  }

  function getRequestPriorityTarget() {
    if (!document.body || !document.body.classList.contains('sp-page-request')) {
      return '';
    }

    var params = new URLSearchParams(window.location.search || '');
    var rawType = String(params.get('type') || '').trim().toLowerCase();
    var aliases = {
      renewal: 'standard',
      ro_proof: 'standard',
      renouvellement: 'standard',
      standard: 'standard',
      depannage: 'express',
      depannage_no_proof: 'express',
      'depannage-sos': 'express',
      sos: 'express'
    };

    return aliases[rawType] || '';
  }

  function initRequestPriorityBridge() {
    var target = getRequestPriorityTarget();
    if (!target) {
      return;
    }

    var applied = false;
    var buttonLabels = {
      standard: 'standard',
      express: 'express'
    };

    function isSelected(button) {
      return /border-gray-900/.test(button.className || '');
    }

    function findButtons() {
      return Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (button) {
        var text = (button.textContent || '').trim().toLowerCase();
        return text.indexOf('standard') === 0 || text.indexOf('express') === 0;
      });
    }

    function applyPriority() {
      if (applied) {
        return true;
      }

      var buttons = findButtons();
      if (!buttons.length) {
        return false;
      }

      var wanted = buttonLabels[target] || target;
      var targetButton = buttons.find(function (button) {
        var text = (button.textContent || '').trim().toLowerCase();
        return text.indexOf(wanted) === 0;
      });

      if (!targetButton) {
        return false;
      }

      if (!isSelected(targetButton)) {
        targetButton.click();
      }

      applied = true;
      return true;
    }

    if (applyPriority()) {
      return;
    }

    var observer = new MutationObserver(function () {
      if (applyPriority()) {
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('beforeunload', function () {
      observer.disconnect();
    }, { once: true });
  }

  function initBdpmObserver() {
    var root = document.getElementById('sosprescription-bdpm-table-root');
    if (!root) {
      return;
    }

    hydrateBdpmPremiumUi(root);

    if (root.__spBdpmObserver) {
      return;
    }

    var observer = new MutationObserver(function () {
      hydrateBdpmPremiumUi(root);
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });

    root.__spBdpmObserver = observer;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function formatFrenchDateTime(rawValue) {
    var raw = normalizeText(rawValue).replace(/\s+UTC$/i, 'Z');
    if (!raw) {
      return '';
    }

    var date = new Date(raw);
    if (!Number.isFinite(date.getTime())) {
      return rawValue;
    }

    var months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    var day = String(date.getDate());
    var month = months[date.getMonth()] || '';
    var year = String(date.getFullYear());
    var hours = String(date.getHours()).padStart(2, '0');
    var minutes = String(date.getMinutes()).padStart(2, '0');

    return day + ' ' + month + ' ' + year + ' à ' + hours + ':' + minutes;
  }

  function looksLikeIsoDate(rawValue) {
    var raw = normalizeText(rawValue);
    return /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(raw);
  }

  function maybeFormatDateNode(node) {
    if (!(node instanceof HTMLElement) || node.dataset.spDateFormatted === '1') {
      return;
    }

    var raw = normalizeText(node.textContent || '');
    if (!looksLikeIsoDate(raw)) {
      return;
    }

    node.textContent = formatFrenchDateTime(raw);
    node.dataset.spDateFormatted = '1';
  }

  function hasActivePatientRequest(root) {
    if (!(root instanceof HTMLElement)) {
      return false;
    }

    var text = normalizeText(root.textContent || '').toLowerCase();
    if (!text) {
      return false;
    }

    return (
      text.indexOf('paiement à autoriser') !== -1
      || text.indexOf('en cours d’analyse') !== -1
      || text.indexOf('en cours d\'analyse') !== -1
      || text.indexOf('payment_pending') !== -1
      || text.indexOf('in_review') !== -1
      || text.indexOf('needs_info') !== -1
    );
  }

  function setupPatientProfileAccordion() {
    var profileRoot = document.getElementById('sp-patient-profile-root');
    if (!profileRoot) {
      return;
    }

    var card = profileRoot.querySelector('.sp-profile-card');
    if (!card) {
      return;
    }

    var header = card.querySelector('.sp-profile-card__header');
    if (!header) {
      return;
    }

    var body = card.querySelector('.sp-profile-card__body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'sp-profile-card__body';
      while (header.nextSibling) {
        body.appendChild(header.nextSibling);
      }
      card.appendChild(body);
    }

    var toggle = header.querySelector('.sp-profile-card__toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sp-profile-card__toggle';
      toggle.innerHTML = '<span class="sp-profile-card__toggle-label">Afficher</span><span class="sp-profile-card__toggle-icon" aria-hidden="true">▾</span>';
      header.appendChild(toggle);
    }

    function apply(expanded) {
      card.classList.toggle('is-collapsed', !expanded);
      body.hidden = !expanded;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      var label = toggle.querySelector('.sp-profile-card__toggle-label');
      if (label) {
        label.textContent = expanded ? 'Réduire' : 'Ouvrir';
      }
      var icon = toggle.querySelector('.sp-profile-card__toggle-icon');
      if (icon) {
        icon.textContent = expanded ? '▴' : '▾';
      }
    }

    if (!toggle.__spProfileBound) {
      toggle.addEventListener('click', function () {
        card.dataset.spAccordionTouched = '1';
        apply(card.classList.contains('is-collapsed'));
      });
      toggle.__spProfileBound = true;
    }

    if (card.dataset.spAccordionTouched === '1') {
      apply(!card.classList.contains('is-collapsed'));
      return;
    }

    var patientRoot = document.querySelector('#sosprescription-root-form[data-app="patient"]');
    if (!patientRoot || !patientRoot.querySelector('.sp-patient-dashboard-grid, .max-h-\\[560px\\], .sp-patient-chat, .space-y-5')) {
      return;
    }

    apply(!hasActivePatientRequest(patientRoot));
  }

  function decoratePatientDashboard() {
    var root = document.querySelector('#sosprescription-root-form[data-app="patient"]');
    if (!root) {
      return;
    }

    var grid = Array.prototype.slice.call(root.querySelectorAll('div')).find(function (node) {
      var className = String(node.className || '');
      return className.indexOf('grid-cols-1') !== -1 && className.indexOf('lg:grid-cols-3') !== -1;
    });

    if (grid) {
      grid.classList.add('sp-patient-dashboard-grid');
      if (grid.children[0]) {
        grid.children[0].classList.add('sp-patient-requests-card');
      }
      if (grid.children[1]) {
        grid.children[1].classList.add('sp-patient-detail-card');
      }
    }
  }

  function hidePatientAttachmentComposer() {
    var root = document.querySelector('#sosprescription-root-form[data-app="patient"]');
    if (!root) {
      return;
    }

    Array.prototype.slice.call(root.querySelectorAll('button[aria-label="Ajouter un document"], input[type="file"]')).forEach(function (node) {
      if (node instanceof HTMLElement) {
        node.dataset.spHiddenAttachment = '1';
      }
    });

    Array.prototype.slice.call(root.querySelectorAll('button[aria-label^="Retirer "]')).forEach(function (button) {
      var chip = button.closest('span');
      if (chip instanceof HTMLElement) {
        chip.dataset.spHiddenAttachment = '1';
      }
    });
  }

  function enhancePatientConsoleMessages() {
    var root = document.querySelector('#sosprescription-root-form[data-app="patient"]');
    if (!root) {
      return;
    }

    Array.prototype.slice.call(root.querySelectorAll('.flex.justify-end, .flex.justify-start')).forEach(function (row) {
      var bubble = row.firstElementChild;
      if (!(row instanceof HTMLElement) || !(bubble instanceof HTMLElement)) {
        return;
      }

      if (!/rounded-2xl/.test(bubble.className || '')) {
        return;
      }

      var isPatient = /justify-end/.test(row.className || '');
      row.classList.add('sp-app-chat-row');
      row.classList.toggle('is-patient', isPatient);
      row.classList.toggle('is-doctor', !isPatient);
      bubble.classList.add('sp-app-chat-bubble');
      bubble.classList.toggle('is-patient', isPatient);
      bubble.classList.toggle('is-doctor', !isPatient);

      var author = bubble.querySelector('.sp-app-chat-author');
      if (!author) {
        author = document.createElement('p');
        author.className = 'sp-app-chat-author';
        bubble.insertBefore(author, bubble.firstChild);
      }
      author.textContent = isPatient ? 'MOI' : 'MÉDECIN';

      var children = Array.prototype.slice.call(bubble.children);
      var meta = children.reverse().find(function (node) {
        return node instanceof HTMLElement && looksLikeIsoDate(node.textContent || '');
      });
      if (meta) {
        meta.classList.add('sp-app-chat-meta');
        maybeFormatDateNode(meta);
      }
    });
  }

  function enhancePatientShadowChat() {
    Array.prototype.slice.call(document.querySelectorAll('sp-patient-text-chat')).forEach(function (host) {
      if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
        return;
      }

      var root = host.shadowRoot;
      Array.prototype.slice.call(root.querySelectorAll('.sp-patient-chat__message.is-patient .sp-patient-chat__author')).forEach(function (node) {
        node.textContent = 'MOI';
      });
      Array.prototype.slice.call(root.querySelectorAll('.sp-patient-chat__message.is-doctor .sp-patient-chat__author')).forEach(function (node) {
        node.textContent = 'MÉDECIN';
      });
      Array.prototype.slice.call(root.querySelectorAll('.sp-patient-chat__meta')).forEach(function (node) {
        maybeFormatDateNode(node);
      });

      if (!root.getElementById('sp-theme-chat-overrides')) {
        var style = document.createElement('style');
        style.id = 'sp-theme-chat-overrides';
        style.textContent = ''
          + '.sp-patient-chat__bubble{inline-size:auto !important;width:auto !important;max-inline-size:var(--sp-message-bubble-max,70%) !important;max-width:var(--sp-message-bubble-max,70%) !important;}'
          + '.sp-patient-chat__message.is-doctor .sp-patient-chat__bubble{border-color:color-mix(in srgb,var(--sp-chat-accent) 20%,transparent);background:var(--sp-chat-info);}'
          + '.sp-patient-chat__message.is-patient .sp-patient-chat__bubble{border-color:var(--sp-chat-border);background:var(--sp-chat-surface);}'
          + '.sp-patient-chat__author{color:var(--sp-chat-text);}';
        root.appendChild(style);
      }
    });
  }

  function hideConsoleToolbarButtons() {
    var toolbar = document.querySelector('.sp-shell--console .sp-plugin-toolbar-meta--console');
    if (!toolbar) {
      return;
    }

    Array.prototype.slice.call(toolbar.querySelectorAll('a.sp-button, button.sp-button')).forEach(function (node) {
      var label = normalizeText(node.textContent || '').toLowerCase();
      if (label === 'mon compte médecin' || label === 'se déconnecter') {
        var parentForm = node.closest('form');
        if (parentForm instanceof HTMLElement) {
          parentForm.remove();
          return;
        }
        if (node instanceof HTMLElement) {
          node.remove();
        }
      }
    });
  }

  function mapConsoleStatusLabel(label) {
    var text = normalizeText(label).toLowerCase();
    if (!text) {
      return '';
    }
    if (text.indexOf('validée') !== -1) {
      return 'approved';
    }
    if (text.indexOf('refusée') !== -1) {
      return 'rejected';
    }
    if (text.indexOf('paiement') !== -1) {
      return 'payment_pending';
    }
    if (text.indexOf('en cours') !== -1 || text.indexOf('à traiter') !== -1) {
      return 'pending';
    }
    return '';
  }

  function updateConsoleStatusGuards() {
    var shell = document.querySelector('.sp-shell--console');
    if (!shell) {
      return;
    }

    var selectedStatus = '';
    var selectedPill = shell.querySelector('.dc-item.is-selected .dc-item__status .dc-pill');
    if (selectedPill) {
      selectedStatus = mapConsoleStatusLabel(selectedPill.textContent || '');
    }

    Array.prototype.slice.call(shell.querySelectorAll('.dc-detail-pane')).forEach(function (pane) {
      if (!(pane instanceof HTMLElement)) {
        return;
      }
      if (selectedStatus) {
        pane.setAttribute('data-sp-case-status', selectedStatus);
      } else {
        pane.removeAttribute('data-sp-case-status');
      }
    });

    Array.prototype.slice.call(shell.querySelectorAll('.dc-message-meta')).forEach(function (node) {
      maybeFormatDateNode(node);
    });
  }

  function runAppSurfaceEnhancements() {
    decoratePatientDashboard();
    setupPatientProfileAccordion();
    hidePatientAttachmentComposer();
    enhancePatientConsoleMessages();
    enhancePatientShadowChat();
    hideConsoleToolbarButtons();
    updateConsoleStatusGuards();
  }

  function initSurfaceObservers() {
    if (document.body && !document.body.__spSurfaceObserver) {
      var observer = new MutationObserver(function () {
        runAppSurfaceEnhancements();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      document.body.__spSurfaceObserver = observer;
      window.addEventListener('beforeunload', function () {
        observer.disconnect();
      }, { once: true });
    }

    runAppSurfaceEnhancements();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initBdpmObserver();
      initRequestPriorityBridge();
      initSurfaceObservers();
    }, { once: true });
  } else {
    initBdpmObserver();
    initRequestPriorityBridge();
    initSurfaceObservers();
  }
})();
