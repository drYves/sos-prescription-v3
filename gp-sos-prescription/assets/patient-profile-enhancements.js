(function () {
  var cfg = window.SOSPrescription || window.SosPrescription || {};
  if (!cfg || typeof cfg !== 'object') {
    return;
  }

  var PROFILE_ROOT_ID = 'sp-patient-profile-root';
  var PATIENT_ROOT_SELECTOR = '#sosprescription-root-form[data-app="patient"]';
  var PROFILE_PATH = '/patient/profile';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function resolveProfileRestBase() {
    var v4 = normalizeString(cfg.restV4Base || '');
    if (v4 !== '') {
      return v4.replace(/\/+$/, '');
    }

    var base = normalizeString(cfg.restBase || '');
    if (base === '') {
      return '';
    }

    return base.replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').replace(/\/+$/, '');
  }

  function buildProfileUrl() {
    var restBase = resolveProfileRestBase();
    if (restBase === '') {
      throw new Error('Configuration REST V4 absente.');
    }
    return restBase + PROFILE_PATH;
  }

  function shouldBootstrapProfile() {
    var currentUser = cfg.currentUser && typeof cfg.currentUser === 'object' ? cfg.currentUser : {};
    var currentUserId = Number(currentUser.id || 0);
    if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
      return false;
    }

    return !!document.querySelector(PATIENT_ROOT_SELECTOR)
      || !!document.querySelector('#sosprescription-root-form[data-app="form"]')
      || !!document.getElementById(PROFILE_ROOT_ID);
  }


  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function isEmailLike(value) {
    var v = normalizeString(value);
    return v !== '' && EMAIL_RE.test(v);
  }

  function safeHumanValue(value) {
    var v = normalizeString(value).replace(/\s+/g, ' ');
    return v !== '' && !isEmailLike(v) ? v : '';
  }

  function splitDisplayName(value) {
    var clean = safeHumanValue(value);
    if (clean === '') {
      return { firstName: '', lastName: '' };
    }
    var parts = clean.split(/\s+/u).map(function (part) { return part.trim(); }).filter(Boolean);
    if (parts.length === 0) {
      return { firstName: '', lastName: '' };
    }
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' };
    }
    var firstName = parts.shift() || '';
    return { firstName: firstName, lastName: parts.join(' ') };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatIsoToFr(iso) {
    var value = normalizeString(iso);
    var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return value;
    }
    return match[3] + '/' + match[2] + '/' + match[1];
  }

  function parseMetric(value) {
    var raw = normalizeString(value).replace(',', '.');
    if (raw === '') {
      return null;
    }
    var num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function computeBmi(weightKg, heightCm) {
    var weight = parseMetric(weightKg);
    var height = parseMetric(heightCm);
    if (!weight || !height) {
      return null;
    }
    if (weight < 1 || weight > 500 || height < 30 || height > 300) {
      return null;
    }
    var meters = height / 100;
    if (meters <= 0) {
      return null;
    }
    var bmi = weight / (meters * meters);
    if (!Number.isFinite(bmi) || bmi <= 0) {
      return null;
    }
    return Math.round(bmi * 10) / 10;
  }

  function bmiLabel(weightKg, heightCm) {
    var bmi = computeBmi(weightKg, heightCm);
    if (!bmi) {
      return 'IMC —';
    }

    var suffix = 'Corpulence normale';
    if (bmi < 18.5) suffix = 'Insuffisance pondérale';
    else if (bmi < 25) suffix = 'Corpulence normale';
    else if (bmi < 30) suffix = 'Surpoids';
    else if (bmi < 35) suffix = 'Obésité (classe I)';
    else if (bmi < 40) suffix = 'Obésité (classe II)';
    else suffix = 'Obésité (classe III)';

    return 'IMC ' + String(bmi).replace('.', ',') + ' • ' + suffix;
  }

  function buildProfileSeed() {
    var currentUser = cfg.currentUser && typeof cfg.currentUser === 'object' ? cfg.currentUser : {};
    var patientProfile = cfg.patientProfile && typeof cfg.patientProfile === 'object' ? cfg.patientProfile : {};
    var split = splitDisplayName(currentUser.displayName || patientProfile.fullname || '');

    var firstName = safeHumanValue(
      currentUser.firstName || currentUser.first_name || patientProfile.first_name || split.firstName
    );
    var lastName = safeHumanValue(
      currentUser.lastName || currentUser.last_name || patientProfile.last_name || split.lastName
    );
    var fullName = safeHumanValue(
      patientProfile.fullname || [firstName, lastName].filter(Boolean).join(' ')
    );
    var birthIso = normalizeString(
      currentUser.birthDate || currentUser.birthdate || currentUser.sosp_birthdate || patientProfile.birthdate_iso || ''
    );
    var birthFr = normalizeString(patientProfile.birthdate_fr || formatIsoToFr(birthIso));
    var email = normalizeString(patientProfile.email || currentUser.email || '');
    var weightKg = normalizeString(patientProfile.weight_kg || patientProfile.weightKg || '');
    var heightCm = normalizeString(patientProfile.height_cm || patientProfile.heightCm || '');
    var note = normalizeString(patientProfile.note || patientProfile.medical_notes || patientProfile.medicalNotes || '');

    return {
      firstName: firstName,
      lastName: lastName,
      fullName: fullName,
      birthdateIso: birthIso,
      birthdateFr: birthFr,
      email: email,
      weightKg: weightKg,
      heightCm: heightCm,
      note: note,
      bmiLabel: normalizeString(patientProfile.bmi_label || bmiLabel(weightKg, heightCm))
    };
  }

  function updateGlobalProfile(profile) {
    var currentUser = cfg.currentUser && typeof cfg.currentUser === 'object' ? cfg.currentUser : {};
    var patientProfile = cfg.patientProfile && typeof cfg.patientProfile === 'object' ? cfg.patientProfile : {};
    var fullName = safeHumanValue([profile.first_name, profile.last_name].filter(Boolean).join(' '));

    currentUser.firstName = normalizeString(profile.first_name);
    currentUser.first_name = normalizeString(profile.first_name);
    currentUser.lastName = normalizeString(profile.last_name);
    currentUser.last_name = normalizeString(profile.last_name);
    currentUser.birthDate = normalizeString(profile.birthdate_iso);
    currentUser.birthdate = normalizeString(profile.birthdate_iso);
    currentUser.sosp_birthdate = normalizeString(profile.birthdate_iso);
    currentUser.email = normalizeString(profile.email || currentUser.email || '');

    if (fullName !== '' && (!safeHumanValue(currentUser.displayName) || isEmailLike(currentUser.displayName))) {
      currentUser.displayName = fullName;
    }

    patientProfile.first_name = normalizeString(profile.first_name);
    patientProfile.last_name = normalizeString(profile.last_name);
    patientProfile.fullname = fullName;
    patientProfile.birthdate_iso = normalizeString(profile.birthdate_iso);
    patientProfile.birthdate_fr = normalizeString(profile.birthdate_fr);
    patientProfile.email = normalizeString(profile.email);
    patientProfile.weight_kg = normalizeString(profile.weight_kg || profile.weightKg);
    patientProfile.weightKg = patientProfile.weight_kg;
    patientProfile.height_cm = normalizeString(profile.height_cm || profile.heightCm);
    patientProfile.heightCm = patientProfile.height_cm;
    patientProfile.note = normalizeString(profile.note || profile.medical_notes || profile.medicalNotes || '');
    patientProfile.medical_notes = patientProfile.note;
    patientProfile.medicalNotes = patientProfile.note;
    patientProfile.bmi_value = normalizeString(profile.bmi_value);
    patientProfile.bmi_label = normalizeString(profile.bmi_label || bmiLabel(profile.weight_kg, profile.height_cm));

    cfg.currentUser = currentUser;
    cfg.patientProfile = patientProfile;
    window.SOSPrescription = cfg;
    window.SosPrescription = cfg;
  }

  function createMessage(root, type, text) {
    if (!root) {
      return;
    }

    var tone = type === 'success' ? 'success' : 'error';
    var title = tone === 'success' ? 'Profil enregistré' : 'Enregistrement impossible';

    root.hidden = false;
    root.className = 'sp-alert sp-alert--' + tone;
    root.setAttribute('role', tone === 'success' ? 'status' : 'alert');
    root.setAttribute('aria-live', tone === 'success' ? 'polite' : 'assertive');
    root.innerHTML = '';

    var titleNode = document.createElement('p');
    titleNode.className = 'sp-alert__title';
    titleNode.textContent = title;

    var bodyNode = document.createElement('p');
    bodyNode.className = 'sp-alert__body';
    bodyNode.textContent = String(text || '');

    root.appendChild(titleNode);
    root.appendChild(bodyNode);
  }

  function clearMessage(root) {
    if (!root) {
      return;
    }

    root.textContent = '';
    root.className = 'sp-alert';
    root.hidden = true;
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
  }

  function setReactInputValue(input, value) {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
      return;
    }

    var stringValue = String(value == null ? '' : value);
    var prototype = Object.getPrototypeOf(input);
    var descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    var setter = descriptor && typeof descriptor.set === 'function' ? descriptor.set : null;

    if (setter) {
      setter.call(input, stringValue);
    } else {
      input.value = stringValue;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function findInput(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var node = document.querySelector(selectors[i]);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function hydrateFormFromProfile() {
    var seed = buildProfileSeed();
    if (seed.firstName === '' && seed.lastName === '' && seed.birthdateIso === '' && seed.note === '') {
      return;
    }

    var observer = null;
    var applied = false;

    function tryApply() {
      var firstNameInput = findInput([
        '#sosprescription-root-form[data-app="form"] input[name="firstName"]',
        '#sosprescription-root-form[data-app="patient"] input[name="firstName"]',
        'input[name="firstName"]',
        'input[name="first_name"]'
      ]);
      var lastNameInput = findInput([
        '#sosprescription-root-form[data-app="form"] input[name="lastName"]',
        '#sosprescription-root-form[data-app="patient"] input[name="lastName"]',
        'input[name="lastName"]',
        'input[name="last_name"]'
      ]);
      var birthdateInput = findInput([
        '#sosprescription-root-form[data-app="form"] input[name="sp_patient_identity_birthdate"]',
        '#sosprescription-root-form[data-app="patient"] input[name="sp_patient_identity_birthdate"]',
        'input[name="sp_patient_identity_birthdate"]',
        '#sosprescription-root-form[data-app="form"] input[name="birthDate"]',
        '#sosprescription-root-form[data-app="patient"] input[name="birthDate"]',
        'input[name="birthDate"]',
        'input[name="birthdate"]'
      ]);
      var fullNameInput = findInput([
        '#sosprescription-root-form[data-app="form"] input[name="sp_patient_identity_fullname"]',
        '#sosprescription-root-form[data-app="patient"] input[name="sp_patient_identity_fullname"]',
        'input[name="sp_patient_identity_fullname"]',
        '#sosprescription-root-form[data-app="form"] input[name="fullname"]',
        '#sosprescription-root-form[data-app="patient"] input[name="fullname"]',
        'input[name="fullname"]',
        'input[name="fullName"]'
      ]);
      var noteInput = findInput([
        '#sosprescription-root-form[data-app="form"] textarea[name="medical_notes"]',
        '#sosprescription-root-form[data-app="form"] textarea[name="note"]',
        '#sosprescription-root-form[data-app="form"] textarea#sp-patient-medical-notes',
        '#sosprescription-root-form[data-app="patient"] textarea[name="medical_notes"]',
        '#sosprescription-root-form[data-app="patient"] textarea[name="note"]',
        '#sosprescription-root-form[data-app="patient"] textarea#sp-patient-medical-notes',
        'textarea[name="medical_notes"]',
        'textarea[name="note"]',
        'textarea#sp-patient-medical-notes'
      ]);

      if (firstNameInput && normalizeString(firstNameInput.value) === '' && seed.firstName !== '') {
        setReactInputValue(firstNameInput, seed.firstName);
        applied = true;
      }
      if (lastNameInput && normalizeString(lastNameInput.value) === '' && seed.lastName !== '') {
        setReactInputValue(lastNameInput, seed.lastName);
        applied = true;
      }
      if (birthdateInput && normalizeString(birthdateInput.value) === '' && seed.birthdateFr !== '') {
        setReactInputValue(birthdateInput, seed.birthdateFr);
        applied = true;
      }
      if (!firstNameInput && !lastNameInput && fullNameInput && normalizeString(fullNameInput.value) === '' && seed.fullName !== '') {
        setReactInputValue(fullNameInput, seed.fullName);
        applied = true;
      }
      if (noteInput && normalizeString(noteInput.value) === '' && seed.note !== '') {
        setReactInputValue(noteInput, seed.note);
        applied = true;
      }

      if ((firstNameInput || lastNameInput || birthdateInput || fullNameInput || noteInput) && observer) {
        observer.disconnect();
        observer = null;
      }
    }

    tryApply();
    if (applied) {
      return;
    }

    observer = new MutationObserver(function () {
      tryApply();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.setTimeout(function () {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }, 15000);
  }

  function buildProfileMarkup(seed) {
    return '' +
      '<div class="sp-card">' +
      '  <div class="sp-stack">' +
      '    <div class="sp-stack">' +
      '      <h2>Mon profil</h2>' +
      '      <p class="sp-field__help">Ces informations peuvent préremplir votre prochaine demande d’ordonnance. Vous pourrez toujours les modifier si la demande concerne un proche.</p>' +
      '    </div>' +
      '    <div id="sp-profile-feedback" class="sp-alert" hidden role="status" aria-live="polite"></div>' +
      '    <form id="sp-patient-profile-form" class="sp-form" novalidate>' +
      '      <div class="sp-stack">' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-first-name">Prénom</label><input class="sp-input" type="text" id="sp-profile-first-name" name="first_name" maxlength="100" autocomplete="given-name" value="' + escapeHtml(seed.firstName) + '" /></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-last-name">Nom</label><input class="sp-input" type="text" id="sp-profile-last-name" name="last_name" maxlength="120" autocomplete="family-name" value="' + escapeHtml(seed.lastName) + '" /></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-birthdate">Date de naissance</label><input class="sp-input" type="text" id="sp-profile-birthdate" name="birthdate" placeholder="JJ/MM/AAAA" inputmode="numeric" autocomplete="bday" value="' + escapeHtml(seed.birthdateFr) + '" /></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-email">Adresse e-mail</label><input class="sp-input" type="email" id="sp-profile-email" name="email" maxlength="190" autocomplete="email" value="' + escapeHtml(seed.email) + '" /></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-weight">Poids (kg)</label><input class="sp-input" type="number" id="sp-profile-weight" name="weight_kg" min="1" max="500" step="0.1" inputmode="decimal" value="' + escapeHtml(seed.weightKg) + '" /></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-height">Taille (cm)</label><input class="sp-input" type="number" id="sp-profile-height" name="height_cm" min="30" max="300" step="0.1" inputmode="decimal" value="' + escapeHtml(seed.heightCm) + '" /></div>' +
      '        <div class="sp-field"><span class="sp-field__label">IMC</span><div id="sp-profile-bmi" class="sp-alert sp-alert--info" role="status" aria-live="polite">' + escapeHtml(seed.bmiLabel || 'IMC —') + '</div><p class="sp-field__help">Calcul indicatif basé sur votre poids et votre taille.</p></div>' +
      '        <div class="sp-field"><label class="sp-field__label" for="sp-profile-medical-notes">Précisions médicales (optionnel)</label><textarea id="sp-profile-medical-notes" name="note" class="sp-textarea" rows="5" placeholder="Allergies, antécédents, contre-indications ou toute information utile au médecin…">' + escapeHtml(seed.note) + '</textarea></div>' +
      '        <div class="sp-stack"><button class="sp-button sp-button--primary" type="submit">Enregistrer mes informations</button></div>' +
      '      </div>' +
      '    </form>' +
      '    <div class="sp-alert sp-alert--info" role="note"><p class="sp-alert__title">Préremplissage contrôlé</p><p class="sp-alert__body">Les champs Nom, Prénom et Date de naissance servent à préremplir le formulaire, mais restent toujours modifiables avant l’envoi d’une demande.</p></div>' +
      '  </div>' +
      '</div>';
  }

  function normalizeProfilePayload(formData) {
    var firstName = normalizeString(formData.get('first_name')).replace(/\s+/g, ' ');
    var lastName = normalizeString(formData.get('last_name')).replace(/\s+/g, ' ');
    var birthdate = normalizeString(formData.get('birthdate'));
    var email = normalizeString(formData.get('email')).toLowerCase();
    var weightKg = normalizeString(formData.get('weight_kg')).replace(',', '.');
    var heightCm = normalizeString(formData.get('height_cm')).replace(',', '.');
    var note = normalizeString(formData.get('note'));

    return {
      first_name: firstName,
      last_name: lastName,
      birthdate: birthdate,
      email: email,
      weight_kg: weightKg,
      weightKg: weightKg,
      height_cm: heightCm,
      heightCm: heightCm,
      note: note,
      medical_notes: note,
      medicalNotes: note
    };
  }

  async function requestProfile(method, payload) {
    var nonce = normalizeString(cfg.nonce);
    var url = buildProfileUrl();

    if (nonce === '') {
      throw new Error('Nonce WordPress manquant.');
    }

    var upperMethod = String(method || 'GET').toUpperCase();
    var headers = {
      'Accept': 'application/json',
      'X-WP-Nonce': nonce
    };

    var options = {
      method: upperMethod,
      credentials: 'same-origin',
      headers: headers
    };

    if (upperMethod === 'GET') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      url += sep + '_ts=' + String(Date.now());
    } else {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload || {});
    }

    var response = await fetch(url, options);

    var data = null;
    try {
      data = await response.json();
    } catch (_err) {
      data = null;
    }

    if (!response.ok) {
      var message = data && typeof data.message === 'string' && data.message !== ''
        ? data.message
        : (upperMethod === 'GET'
          ? 'Impossible de charger le profil patient.'
          : 'Impossible d’enregistrer le profil patient.');
      throw new Error(message);
    }

    return data && typeof data === 'object' ? data : {};
  }

  function fetchProfile() {
    return requestProfile('GET');
  }

  function submitProfile(payload) {
    return requestProfile('PUT', payload);
  }

  function updateBmiPreview(root) {
    if (!root) {
      return;
    }
    var weightInput = root.querySelector('input[name="weight_kg"]');
    var heightInput = root.querySelector('input[name="height_cm"]');
    var bmiNode = root.querySelector('#sp-profile-bmi');
    if (!weightInput || !heightInput || !bmiNode) {
      return;
    }
    bmiNode.textContent = bmiLabel(weightInput.value, heightInput.value);
  }

  function mountPatientProfileSection() {
    var patientRoot = document.querySelector(PATIENT_ROOT_SELECTOR);
    if (!patientRoot) {
      return;
    }

    var mount = document.getElementById(PROFILE_ROOT_ID);
    if (!mount) {
      mount = document.createElement('div');
      mount.id = PROFILE_ROOT_ID;
      patientRoot.parentNode.insertBefore(mount, patientRoot);
    }

    var seed = buildProfileSeed();
    mount.innerHTML = buildProfileMarkup(seed);

    var form = mount.querySelector('#sp-patient-profile-form');
    var feedback = mount.querySelector('#sp-profile-feedback');
    var submitButton = form ? form.querySelector('button[type="submit"]') : null;
    if (!form || !feedback || !submitButton) {
      return;
    }

    updateBmiPreview(mount);

    Array.prototype.slice.call(form.querySelectorAll('input[name="weight_kg"], input[name="height_cm"]')).forEach(function (input) {
      input.addEventListener('input', function () {
        updateBmiPreview(mount);
      });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearMessage(feedback);

      var payload = normalizeProfilePayload(new FormData(form));
      if (payload.first_name !== '' && isEmailLike(payload.first_name)) {
        createMessage(feedback, 'error', 'Le prénom ne peut pas être une adresse e-mail.');
        return;
      }
      if (payload.last_name !== '' && isEmailLike(payload.last_name)) {
        createMessage(feedback, 'error', 'Le nom ne peut pas être une adresse e-mail.');
        return;
      }
      if (payload.email !== '' && !EMAIL_RE.test(payload.email)) {
        createMessage(feedback, 'error', 'Adresse e-mail invalide.');
        return;
      }

      submitButton.disabled = true;
      var originalText = submitButton.textContent;
      submitButton.textContent = 'Enregistrement…';

      submitProfile(payload)
        .then(function (data) {
          var profile = data && data.profile && typeof data.profile === 'object' ? data.profile : payload;
          updateGlobalProfile(profile);
          updateBmiPreview(mount);
          createMessage(feedback, 'success', 'Profil enregistré avec succès.');
          window.dispatchEvent(new CustomEvent('sosprescription:patient-profile-updated', {
            detail: {
              profile: profile,
              response: data
            }
          }));
        })
        .catch(function (error) {
          createMessage(feedback, 'error', error && error.message ? String(error.message) : 'Impossible d’enregistrer le profil patient.');
        })
        .finally(function () {
          submitButton.disabled = false;
          submitButton.textContent = originalText;
        });
    });
  }

  function onReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  function bootstrapProfile() {
    var finalize = function () {
      hydrateFormFromProfile();
      mountPatientProfileSection();
    };

    if (!shouldBootstrapProfile()) {
      finalize();
      return;
    }

    fetchProfile()
      .then(function (data) {
        if (data && data.profile && typeof data.profile === 'object') {
          updateGlobalProfile(data.profile);
        }
      })
      .catch(function () {
        // Le profil Worker devient la source de vérité quand il est disponible,
        // mais l'UI doit rester utilisable même en cas d'échec transitoire.
      })
      .finally(function () {
        finalize();
      });
  }

  onReady(function () {
    bootstrapProfile();
  });

  window.addEventListener('sosprescription:patient-profile-updated', function () {
    hydrateFormFromProfile();
  });
})();
