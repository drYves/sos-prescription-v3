/* SOS Prescription – Doctor Profile Enhancements V8.10.0 (profile save, RPPS persistence, signature UX) */

(function () {
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function normalizeString(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeDigits(value) {
    return String(value == null ? '' : value).replace(/\D+/g, '').trim();
  }

  function safeJsonParse(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    try {
      return JSON.parse(value);
    } catch (_err) {
      return null;
    }
  }

  function getConfig() {
    var cfg = window.SOSPrescriptionDoctorProfile || null;
    return cfg && typeof cfg === 'object' ? cfg : null;
  }

  function getStrings(config) {
    var strings = config && config.strings && typeof config.strings === 'object' ? config.strings : {};
    return {
      verifyLabel: normalizeString(strings.verifyLabel) || 'Vérifier',
      verifyingLabel: normalizeString(strings.verifyingLabel) || 'Vérification…',
      saveLabel: normalizeString(strings.saveLabel) || 'Enregistrer les modifications',
      savingLabel: normalizeString(strings.savingLabel) || 'Enregistrement…',
      saveSuccess: normalizeString(strings.saveSuccess) || 'Les modifications ont été enregistrées.',
      saveError: normalizeString(strings.saveError) || 'Les modifications n\'ont pas pu être enregistrées.',
      invalidLength: normalizeString(strings.invalidLength) || 'Identifiant RPPS inconnu ou invalide. Veuillez vérifier votre saisie ou consulter l\'Annuaire Santé officiel.',
      invalidLookup: normalizeString(strings.invalidLookup) || 'Identifiant RPPS inconnu ou invalide. Veuillez vérifier votre saisie ou consulter l\'Annuaire Santé officiel.',
      serviceUnavailable: normalizeString(strings.serviceUnavailable) || 'La vérification RPPS est temporairement indisponible.',
      initialHelp: normalizeString(strings.initialHelp) || 'Saisissez votre identifiant RPPS pour certifier votre profil. Cette étape est indispensable pour la conformité légale de vos prescriptions.',
      verifiedTitle: normalizeString(strings.verifiedTitle) || '✓ Identité professionnelle certifiée',
      verifiedFooterPrefix: normalizeString(strings.verifiedFooterPrefix) || 'Vérification effectuée avec succès via l\'Annuaire Santé le ',
      deleteAccountConfirm: normalizeString(strings.deleteAccountConfirm) || 'Vous êtes sur le point de supprimer définitivement ce compte médecin. L’accès à l’espace sécurisé sera fermé et les données médicales strictement nécessaires resteront conservées sous forme d\'archives inactives afin de respecter les obligations légales de traçabilité. Souhaitez-vous confirmer cette suppression ?',
      deleteAccountBusy: normalizeString(strings.deleteAccountBusy) || 'Suppression…',
      deleteAccountError: normalizeString(strings.deleteAccountError) || 'La suppression du compte a échoué. Merci de réessayer.',
      signatureInvalidType: normalizeString(strings.signatureInvalidType) || 'Format non supporté. Merci d\'utiliser JPG ou PNG uniquement.',
      signatureTooLarge: normalizeString(strings.signatureTooLarge) || 'Fichier trop lourd. La limite est de 1 Mo.',
      signatureRemoveConfirm: normalizeString(strings.signatureRemoveConfirm) || 'Vous êtes sur le point de retirer la signature actuellement enregistrée. Ce retrait sera appliqué lors de l\'enregistrement du formulaire. Souhaitez-vous confirmer ce retrait ?',
      signatureRemoveLabel: normalizeString(strings.signatureRemoveLabel) || 'Retirer la signature actuelle',
      signatureKeepLabel: normalizeString(strings.signatureKeepLabel) || 'Conserver la signature actuelle',
      signatureRemoveState: normalizeString(strings.signatureRemoveState) || 'La signature actuelle sera retirée lors de l\'enregistrement.'
    };
  }

  function createElement(tagName, className, text) {
    var el = document.createElement(tagName);
    if (className) {
      el.className = className;
    }
    if (typeof text === 'string') {
      el.textContent = text;
    }
    return el;
  }

  function clearAlert(feedback) {
    if (!feedback) {
      return;
    }
    feedback.hidden = true;
    feedback.className = 'sp-alert';
    feedback.replaceChildren();
    feedback.setAttribute('role', 'status');
  }

  function setAlert(feedback, variant, title, bodyContent) {
    if (!feedback) {
      return;
    }

    feedback.hidden = false;
    feedback.className = 'sp-alert';
    if (variant === 'success') {
      feedback.classList.add('sp-alert--success');
      feedback.setAttribute('role', 'status');
    } else if (variant === 'error') {
      feedback.classList.add('sp-alert--error');
      feedback.setAttribute('role', 'alert');
    } else {
      feedback.classList.add('sp-alert--info');
      feedback.setAttribute('role', 'status');
    }

    feedback.replaceChildren();

    if (title) {
      feedback.appendChild(createElement('p', 'sp-alert__title', title));
    }

    if (bodyContent instanceof Node) {
      feedback.appendChild(bodyContent);
      return;
    }

    if (typeof bodyContent === 'string' && bodyContent) {
      feedback.appendChild(createElement('p', 'sp-alert__body', bodyContent));
    }
  }

  function formatVerifiedAt(value) {
    if (!value) {
      return '';
    }

    var date = value instanceof Date ? value : new Date(value);
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return '';
    }

    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    var yyyy = String(date.getFullYear());
    var hh = String(date.getHours()).padStart(2, '0');
    var min = String(date.getMinutes()).padStart(2, '0');

    return dd + '/' + mm + '/' + yyyy + ' à ' + hh + ':' + min;
  }

  function stripDuplicateParenthetical(value) {
    var text = normalizeString(value);
    if (!text) {
      return '';
    }

    var withoutParentheses = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return withoutParentheses || text;
  }

  function toTitleCase(value) {
    var text = stripDuplicateParenthetical(value).toLowerCase();
    if (!text) {
      return '';
    }

    return text.split(' ').map(function (part) {
      if (!part) {
        return '';
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
  }

  function normalizeUpperName(value) {
    return stripDuplicateParenthetical(value).toUpperCase();
  }

  function normalizeLinePart(value) {
    return stripDuplicateParenthetical(value).replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
  }

  function isSameText(a, b) {
    return normalizeLinePart(a).toLowerCase() === normalizeLinePart(b).toLowerCase();
  }

  function buildDoctorLine(data) {
    var firstName = toTitleCase(data && data.firstName);
    var lastName = normalizeUpperName(data && data.lastName);
    var parts = [firstName, lastName].filter(Boolean);
    if (!parts.length) {
      return '';
    }
    return 'Dr ' + parts.join(' ');
  }

  function buildProfessionLine(data, form) {
    var profession = normalizeLinePart(data && data.profession);
    var specialty = normalizeLinePart((data && data.specialty) || getInputValue(form, '#sp_doc_specialty'));

    if (profession && specialty && !isSameText(profession, specialty)) {
      return profession + ' — ' + specialty;
    }
    return profession || specialty;
  }

  function parseAddressCity(address) {
    var text = normalizeString(address);
    if (!text) {
      return '';
    }

    var lines = String(address || '').split(/\r?\n/).map(function (line) {
      return normalizeString(line);
    }).filter(Boolean);
    if (!lines.length) {
      return '';
    }

    var lastLine = lines[lines.length - 1];
    var cleaned = lastLine.replace(/^\d{4,6}\s+/, '').trim();
    if (cleaned) {
      return cleaned;
    }

    var segments = lastLine.split(',').map(function (segment) {
      return normalizeString(segment);
    }).filter(Boolean);
    return segments.length ? segments[segments.length - 1] : '';
  }

  function buildLocationLine(data, form) {
    var explicit = normalizeLinePart(data && data.locationLabel);
    if (explicit) {
      return explicit;
    }

    var issuePlace = normalizeLinePart(getInputValue(form, '#sp_doc_issue_place'));
    var city = normalizeLinePart((data && data.city) || parseAddressCity(getInputValue(form, '#sp_doc_address')));

    if (issuePlace && city && !isSameText(issuePlace, city)) {
      return issuePlace + ' — ' + city;
    }
    return issuePlace || city;
  }

  function getInputValue(form, selector) {
    if (!form || !selector) {
      return '';
    }
    var el = form.querySelector(selector);
    return el && typeof el.value === 'string' ? el.value : '';
  }

  function isTruthyInputValue(input) {
    if (!input) {
      return false;
    }

    var type = normalizeString(input.getAttribute('type') || input.type).toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      return !!input.checked;
    }

    var value = normalizeString(input.value).toLowerCase();
    return value === '1' || value === 'true';
  }

  function normalizeStoredRppsData(value) {
    var raw = value;
    if (typeof raw === 'string') {
      raw = safeJsonParse(raw);
    }
    if (!raw || typeof raw !== 'object') {
      return {};
    }

    return {
      valid: !!raw.valid,
      rpps: normalizeDigits(raw.rpps),
      firstName: normalizeString(raw.firstName || raw.first_name),
      lastName: normalizeString(raw.lastName || raw.last_name),
      profession: normalizeString(raw.profession),
      specialty: normalizeString(raw.specialty),
      city: normalizeString(raw.city),
      locationLabel: normalizeString(raw.locationLabel || raw.location_label),
      verified_at: normalizeString(raw.verified_at || raw.verifiedAt)
    };
  }

  function syncHiddenRppsState(form, state) {
    if (!form || !state) {
      return;
    }

    var verifiedInput = form.querySelector('#sp_doc_rpps_verified');
    var dataInput = form.querySelector('#sp_doc_rpps_data');

    if (verifiedInput) {
      verifiedInput.value = state.rppsVerified ? '1' : '0';
    }
    if (dataInput) {
      try {
        dataInput.value = state.rppsVerified && state.rppsData ? JSON.stringify(state.rppsData) : '{}';
      } catch (_err) {
        dataInput.value = '{}';
      }
    }
  }

  function maybeHydrateDoctorFields(form, result) {
    if (!form || !result) {
      return;
    }

    var specialtyInput = form.querySelector('#sp_doc_specialty');
    if (specialtyInput && !normalizeString(specialtyInput.value)) {
      specialtyInput.value = normalizeString(result.profession);
    }

    var displayNameInput = form.querySelector('#sp_doc_display_name');
    var identity = buildDoctorLine({
      firstName: result.firstName,
      lastName: result.lastName
    });
    if (displayNameInput && !normalizeString(displayNameInput.value) && identity) {
      displayNameInput.value = identity;
    }
  }

  function buildRppsStateFromLookup(result, form) {
    return {
      valid: true,
      rpps: normalizeDigits(result.rpps),
      firstName: normalizeString(result.firstName || result.first_name),
      lastName: normalizeString(result.lastName || result.last_name),
      profession: normalizeString(result.profession),
      specialty: normalizeString(getInputValue(form, '#sp_doc_specialty')),
      city: normalizeLinePart(parseAddressCity(getInputValue(form, '#sp_doc_address'))),
      locationLabel: buildLocationLine({}, form),
      verified_at: new Date().toISOString()
    };
  }

  function renderRppsState(form, state, strings) {
    if (!form || !state) {
      return;
    }

    var feedback = form.querySelector('#sp_doc_rpps_verify_feedback');
    var footer = form.querySelector('#sp_doc_rpps_verify_footer');
    if (!feedback || !footer) {
      return;
    }

    clearAlert(feedback);

    if (!state.rppsVerified || !state.rppsData || !state.rppsData.rpps) {
      footer.textContent = strings.initialHelp;
      return;
    }

    var details = createElement('div', 'sp-stack');
    var line1 = buildDoctorLine(state.rppsData);
    var line2 = buildProfessionLine(state.rppsData, form);
    var line3 = buildLocationLine(state.rppsData, form);

    if (line1) {
      details.appendChild(createElement('p', 'sp-alert__body', line1));
    }
    if (line2) {
      details.appendChild(createElement('p', 'sp-alert__body', line2));
    }
    if (line3) {
      details.appendChild(createElement('p', 'sp-alert__body', '📍 ' + line3));
    }

    setAlert(feedback, 'success', strings.verifiedTitle, details);

    var verifiedAt = formatVerifiedAt(state.rppsData.verified_at);
    footer.textContent = verifiedAt ? strings.verifiedFooterPrefix + verifiedAt + '.' : strings.verifiedFooterPrefix.replace(/\s+$/, '') + '.';
  }

  function setBusyButton(button, busy, busyLabel, idleLabel) {
    if (!button) {
      return;
    }
    button.disabled = !!busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    button.textContent = busy ? busyLabel : idleLabel;
  }

  function performJsonRequest(url, options) {
    options = options || {};
    options.headers = Object.assign({
      'X-Sos-Scope': 'sosprescription_doctor_account'
    }, options.headers || {});

    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var data = safeJsonParse(text) || {};
        return {
          ok: response.ok,
          status: response.status,
          data: data
        };
      });
    });
  }

  function initSimpleRppsInput(input, config, strings) {
    if (!input || input.dataset.spRppsEnhanced === '1' || input.dataset.spRppsManaged === '1') {
      return;
    }
    if (!config || !config.verifyRppsEndpoint || !config.restNonce || typeof window.fetch !== 'function') {
      return;
    }

    input.dataset.spRppsEnhanced = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('maxlength', '11');
    input.setAttribute('autocomplete', 'off');

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-button sp-button--secondary sp-doctor-account__rpps-button';
    button.textContent = strings.verifyLabel;

    var feedback = document.createElement('div');
    feedback.className = 'sp-alert';
    feedback.hidden = true;
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');

    var actionsHost = input.parentElement;
    if (actionsHost) {
      actionsHost.appendChild(button);
      actionsHost.appendChild(feedback);
    }

    input.addEventListener('input', function () {
      var digits = normalizeDigits(input.value).slice(0, 11);
      if (input.value !== digits) {
        input.value = digits;
      }
      clearAlert(feedback);
    });

    button.addEventListener('click', function () {
      var rpps = normalizeDigits(input.value);
      input.value = rpps;
      clearAlert(feedback);

      if (rpps.length !== 11) {
        setAlert(feedback, 'error', '', strings.invalidLookup);
        return;
      }

      setBusyButton(button, true, strings.verifyingLabel, strings.verifyLabel);
      performJsonRequest(config.verifyRppsEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'X-WP-Nonce': config.restNonce
        },
        body: JSON.stringify({ rpps: rpps })
      }).then(function (result) {
        if (result.ok && result.data && result.data.valid === true) {
          var message = buildDoctorLine(result.data) || 'RPPS valide';
          var profession = normalizeString(result.data.profession);
          setAlert(feedback, 'success', '✓ Identité professionnelle certifiée', profession ? message + ' — ' + profession : message);
          return;
        }

        if (result.status >= 500) {
          setAlert(feedback, 'error', '', strings.serviceUnavailable);
          return;
        }

        setAlert(feedback, 'error', '', strings.invalidLookup);
      }).catch(function () {
        setAlert(feedback, 'error', '', strings.serviceUnavailable);
      }).finally(function () {
        setBusyButton(button, false, strings.verifyingLabel, strings.verifyLabel);
      });
    });
  }

  function initProfileForm() {
    var config = getConfig();
    if (!config || !config.profileEndpoint || !config.verifyRppsEndpoint || !config.restNonce || typeof window.fetch !== 'function') {
      return;
    }

    var strings = getStrings(config);
    var form = document.getElementById('sp_doc_profile_form');
    if (!form) {
      return;
    }

    var emailInput = form.querySelector('#sp_doc_email_current');
    var rppsInput = form.querySelector('#sp_doc_rpps');
    var actionsHost = form.querySelector('[data-sp-rpps-actions="1"]');
    var saveButton = form.querySelector('#sp_doc_profile_save');
    var profileFeedback = form.querySelector('#sp_doc_profile_feedback');
    var removeSignatureInput = form.querySelector('input[name="remove_signature"]');
    var signatureInput = form.querySelector('#signature_file');

    if (rppsInput) {
      rppsInput.dataset.spRppsManaged = '1';
      rppsInput.setAttribute('inputmode', 'numeric');
      rppsInput.setAttribute('maxlength', '11');
      rppsInput.setAttribute('autocomplete', 'off');
    }

    var state = {
      rppsVerified: !!(config.initialProfile && config.initialProfile.rpps_verified),
      rppsData: normalizeStoredRppsData(config.initialProfile && config.initialProfile.rpps_data),
      lastVerifyError: ''
    };

    if (emailInput && config.initialProfile && config.initialProfile.email) {
      emailInput.value = normalizeString(config.initialProfile.email);
    }
    if (rppsInput && state.rppsData && state.rppsData.rpps && !normalizeDigits(rppsInput.value)) {
      rppsInput.value = state.rppsData.rpps;
    }

    syncHiddenRppsState(form, state);
    renderRppsState(form, state, strings);
    clearAlert(profileFeedback);

    if (actionsHost && rppsInput) {
      var verifyButton = createElement('button', 'sp-button sp-button--secondary sp-doctor-account__rpps-button', strings.verifyLabel);
      verifyButton.type = 'button';
      actionsHost.replaceChildren(verifyButton);

      rppsInput.addEventListener('input', function () {
        var digits = normalizeDigits(rppsInput.value).slice(0, 11);
        if (rppsInput.value !== digits) {
          rppsInput.value = digits;
        }

        if (state.rppsVerified && state.rppsData && normalizeDigits(state.rppsData.rpps) !== digits) {
          state.rppsVerified = false;
          state.rppsData = {};
          syncHiddenRppsState(form, state);
          renderRppsState(form, state, strings);
        }
      });

      verifyButton.addEventListener('click', function () {
        clearAlert(profileFeedback);
        var rpps = normalizeDigits(rppsInput.value);
        rppsInput.value = rpps;

        if (rpps.length !== 11) {
          state.rppsVerified = false;
          state.rppsData = {};
          syncHiddenRppsState(form, state);
          setAlert(form.querySelector('#sp_doc_rpps_verify_feedback'), 'error', '', strings.invalidLookup);
          form.querySelector('#sp_doc_rpps_verify_footer').textContent = strings.initialHelp;
          return;
        }

        setBusyButton(verifyButton, true, strings.verifyingLabel, strings.verifyLabel);
        performJsonRequest(config.verifyRppsEndpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json',
            'X-WP-Nonce': config.restNonce
          },
          body: JSON.stringify({ rpps: rpps })
        }).then(function (result) {
          if (result.ok && result.data && result.data.valid === true) {
            maybeHydrateDoctorFields(form, result.data);
            state.rppsVerified = true;
            state.rppsData = buildRppsStateFromLookup(result.data, form);
            syncHiddenRppsState(form, state);
            renderRppsState(form, state, strings);
            return;
          }

          state.rppsVerified = false;
          state.rppsData = {};
          syncHiddenRppsState(form, state);

          if (result.status >= 500) {
            setAlert(form.querySelector('#sp_doc_rpps_verify_feedback'), 'error', '', strings.serviceUnavailable);
            form.querySelector('#sp_doc_rpps_verify_footer').textContent = strings.initialHelp;
            return;
          }

          setAlert(form.querySelector('#sp_doc_rpps_verify_feedback'), 'error', '', strings.invalidLookup);
          form.querySelector('#sp_doc_rpps_verify_footer').textContent = strings.initialHelp;
        }).catch(function () {
          state.rppsVerified = false;
          state.rppsData = {};
          syncHiddenRppsState(form, state);
          setAlert(form.querySelector('#sp_doc_rpps_verify_feedback'), 'error', '', strings.serviceUnavailable);
          form.querySelector('#sp_doc_rpps_verify_footer').textContent = strings.initialHelp;
        }).finally(function () {
          setBusyButton(verifyButton, false, strings.verifyingLabel, strings.verifyLabel);
        });
      });
    }

    form.addEventListener('submit', function (event) {
      syncHiddenRppsState(form, state);

      var hasSignatureUpload = !!(signatureInput && signatureInput.files && signatureInput.files.length > 0);
      if (hasSignatureUpload) {
        return;
      }

      event.preventDefault();
      clearAlert(profileFeedback);

      var payload = {
        target_user_id: normalizeString(config.targetUserId || getInputValue(form, 'input[name="target_user_id"]')),
        email_current: getInputValue(form, '#sp_doc_email_current'),
        display_name: getInputValue(form, '#sp_doc_display_name'),
        doctor_title: getInputValue(form, '#sp_doc_title'),
        rpps: getInputValue(form, '#sp_doc_rpps'),
        specialty: getInputValue(form, '#sp_doc_specialty'),
        diploma_label: getInputValue(form, '#sp_doc_diploma_label'),
        diploma_university_location: getInputValue(form, '#sp_doc_diploma_university'),
        diploma_honors: getInputValue(form, '#sp_doc_diploma_honors'),
        issue_place: getInputValue(form, '#sp_doc_issue_place'),
        address: getInputValue(form, '#sp_doc_address'),
        phone: getInputValue(form, '#sp_doc_phone'),
        remove_signature: isTruthyInputValue(removeSignatureInput),
        rpps_verified: !!state.rppsVerified,
        rpps_data: state.rppsVerified && state.rppsData ? state.rppsData : {}
      };

      setBusyButton(saveButton, true, strings.savingLabel, strings.saveLabel);
      performJsonRequest(config.profileEndpoint, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'X-WP-Nonce': config.restNonce
        },
        body: JSON.stringify(payload)
      }).then(function (result) {
        var data = result.data || {};
        if (result.ok && data.ok === true && data.profile && typeof data.profile === 'object') {
          if (emailInput && normalizeString(data.profile.email)) {
            emailInput.value = normalizeString(data.profile.email);
          }
          if (rppsInput && normalizeDigits(data.profile.rpps)) {
            rppsInput.value = normalizeDigits(data.profile.rpps);
          }
          state.rppsVerified = !!data.profile.rpps_verified;
          state.rppsData = normalizeStoredRppsData(data.profile.rpps_data);
          syncHiddenRppsState(form, state);
          renderRppsState(form, state, strings);
          setAlert(profileFeedback, 'success', 'Profil enregistré', strings.saveSuccess);
          return;
        }

        var message = normalizeString(data.message) || strings.saveError;
        setAlert(profileFeedback, 'error', 'Enregistrement impossible', message);
      }).catch(function () {
        setAlert(profileFeedback, 'error', 'Enregistrement impossible', strings.saveError);
      }).finally(function () {
        setBusyButton(saveButton, false, strings.savingLabel, strings.saveLabel);
      });
    });
  }

  function initSignatureUpload() {
    var config = getConfig();
    var strings = getStrings(config || {});
    var input = document.getElementById('signature_file');
    var feedback = document.getElementById('sp_signature_feedback');
    var meta = document.getElementById('sp_signature_meta');
    var preview = document.getElementById('sp_signature_preview');
    var previewImg = document.getElementById('sp_signature_preview_img');
    var clearButton = document.getElementById('sp_signature_clear');
    var currentCard = document.getElementById('sp_signature_current');
    var currentImg = document.getElementById('sp_signature_current_img');
    var removeInput = document.getElementById('sp_signature_remove');
    var removeButton = document.getElementById('sp_signature_mark_remove');
    var stateNote = document.getElementById('sp_signature_state');

    if (!input && !removeButton) {
      return;
    }

    function syncStoredSignatureState() {
      if (!removeInput) {
        return;
      }

      var active = isTruthyInputValue(removeInput);
      if (currentCard) {
        currentCard.classList.toggle('is-pending-removal', active);
      }
      if (removeButton) {
        removeButton.textContent = active ? strings.signatureKeepLabel : strings.signatureRemoveLabel;
        removeButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (stateNote) {
        stateNote.hidden = !active;
        stateNote.textContent = active ? strings.signatureRemoveState : '';
      }
    }

    function resetSignatureUi() {
      clearAlert(feedback);
      if (meta) {
        meta.hidden = true;
        meta.textContent = '';
      }
      if (preview) {
        preview.hidden = true;
      }
      if (previewImg) {
        previewImg.removeAttribute('src');
      }
      if (clearButton) {
        clearButton.hidden = true;
      }
    }

    function showSignatureError(message) {
      setAlert(feedback, 'error', 'Signature invalide', message);
      if (meta) {
        meta.hidden = true;
        meta.textContent = '';
      }
      if (preview) {
        preview.hidden = true;
      }
      if (previewImg) {
        previewImg.removeAttribute('src');
      }
      if (clearButton) {
        clearButton.hidden = true;
      }
    }

    if (removeButton && removeInput) {
      syncStoredSignatureState();
      removeButton.addEventListener('click', function () {
        if (isTruthyInputValue(removeInput)) {
          removeInput.value = '0';
          syncStoredSignatureState();
          return;
        }

        if (!window.confirm(strings.signatureRemoveConfirm)) {
          return;
        }

        removeInput.value = '1';
        syncStoredSignatureState();
      });
    }

    if (currentImg && stateNote) {
      currentImg.addEventListener('error', function () {
        if (isTruthyInputValue(removeInput)) {
          return;
        }
        stateNote.hidden = false;
        stateNote.textContent = 'La signature actuelle n’a pas pu être affichée ici. Utilisez “Ouvrir l’image” pour la consulter.';
      });
    }

    if (!input) {
      return;
    }

    input.addEventListener('change', function () {
      resetSignatureUi();
      var file = input.files && input.files[0] ? input.files[0] : null;
      if (!file) {
        return;
      }

      var allowed = ['image/png', 'image/jpeg'];
      var isAllowed = (file.type && allowed.indexOf(file.type) !== -1)
        || /\.(png|jpe?g)$/i.test(file.name || '');
      if (!isAllowed) {
        input.value = '';
        showSignatureError(strings.signatureInvalidType);
        return;
      }

      if (file.size > 1048576) {
        input.value = '';
        showSignatureError(strings.signatureTooLarge);
        return;
      }

      if (meta) {
        meta.hidden = false;
        meta.textContent = 'Fichier prêt : ' + normalizeString(file.name || 'signature') + ' — ' + Math.max(1, Math.round(file.size / 1024)) + ' ko';
      }
      setAlert(feedback, 'success', 'Signature prête', 'La nouvelle signature sera enregistrée lors de l\'envoi du formulaire.');
      if (clearButton) {
        clearButton.hidden = false;
      }

      if (preview && previewImg && typeof FileReader !== 'undefined') {
        var reader = new FileReader();
        reader.onload = function (event) {
          preview.hidden = false;
          previewImg.src = event && event.target && event.target.result ? String(event.target.result) : '';
        };
        reader.readAsDataURL(file);
      }
    });

    if (clearButton) {
      clearButton.hidden = true;
      clearButton.addEventListener('click', function () {
        input.value = '';
        resetSignatureUi();
      });
    }
  }

  function initAccountDeletion() {
    var config = getConfig();
    if (!config || !config.deleteAccountEndpoint || !config.restNonce || typeof window.fetch !== 'function') {
      return;
    }

    var strings = getStrings(config);
    var button = document.getElementById('sp-delete-account-btn');
    var feedback = document.getElementById('sp-delete-account-feedback');
    if (!button || !feedback) {
      return;
    }

    var idleLabel = normalizeString(button.textContent) || 'Supprimer mon compte';

    button.addEventListener('click', function () {
      clearAlert(feedback);
      if (!window.confirm(strings.deleteAccountConfirm)) {
        return;
      }

      setBusyButton(button, true, strings.deleteAccountBusy, idleLabel);
      performJsonRequest(config.deleteAccountEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'X-WP-Nonce': config.restNonce
        },
        body: JSON.stringify({})
      }).then(function (result) {
        var data = result.data || {};
        if (result.ok && data.ok === true && data.deleted === true) {
          setAlert(feedback, 'success', 'Compte supprimé', 'Redirection en cours…');
          window.location.assign('/');
          return;
        }

        setAlert(feedback, 'error', 'Suppression impossible', normalizeString(data.message) || strings.deleteAccountError);
      }).catch(function () {
        setAlert(feedback, 'error', 'Suppression impossible', strings.deleteAccountError);
      }).finally(function () {
        setBusyButton(button, false, strings.deleteAccountBusy, idleLabel);
      });
    });
  }

  function initAuxiliaryRppsInputs() {
    var config = getConfig();
    if (!config) {
      return;
    }

    var strings = getStrings(config);
    var inputs = document.querySelectorAll('input[name="rpps"]');
    Array.prototype.forEach.call(inputs, function (input) {
      if (input && input.id !== 'sp_doc_rpps') {
        initSimpleRppsInput(input, config, strings);
      }
    });
  }

  ready(function () {
    initProfileForm();
    initSignatureUpload();
    initAccountDeletion();
    initAuxiliaryRppsInputs();
  });
})();
