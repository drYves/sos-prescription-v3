(function () {
  var cfg = window.SOSPrescription || window.SosPrescription || {};
  if (!cfg || typeof cfg !== 'object') {
    return;
  }

  var PROFILE_ROOT_ID = 'sp-patient-profile-root';
  var FORM_ROOT_SELECTOR = '#sosprescription-root-form[data-app="form"]';
  var PATIENT_ROOT_SELECTOR = '#sosprescription-root-form[data-app="patient"]';
  var FULLNAME_INPUT_ID = 'sp-patient-fullname';
  var BIRTHDATE_INPUT_ID = 'sp-patient-birthdate';
  var PROFILE_ENDPOINT = '/patient/profile';

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function isEmailLike(value) {
    var v = normalizeString(value);
    return v !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
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

  function formatIsoToFr(iso) {
    var value = normalizeString(iso);
    var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return value;
    }
    return match[3] + '/' + match[2] + '/' + match[1];
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
    var phone = normalizeString(currentUser.phone || patientProfile.phone || '');

    return {
      firstName: firstName,
      lastName: lastName,
      fullName: fullName,
      birthdateIso: birthIso,
      birthdateFr: birthFr,
      phone: phone
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
    currentUser.phone = normalizeString(profile.phone);

    if (fullName !== '' && (!safeHumanValue(currentUser.displayName) || isEmailLike(currentUser.displayName))) {
      currentUser.displayName = fullName;
    }

    patientProfile.first_name = normalizeString(profile.first_name);
    patientProfile.last_name = normalizeString(profile.last_name);
    patientProfile.fullname = fullName;
    patientProfile.birthdate_iso = normalizeString(profile.birthdate_iso);
    patientProfile.birthdate_fr = normalizeString(profile.birthdate_fr);
    patientProfile.phone = normalizeString(profile.phone);

    cfg.currentUser = currentUser;
    cfg.patientProfile = patientProfile;
    window.SOSPrescription = cfg;
    window.SosPrescription = cfg;
  }

  function createMessage(root, type, text) {
    root.textContent = text;
    root.className = type === 'success' ? 'sp-flash sp-flash--success' : 'sp-flash sp-flash--error';
    root.style.display = 'block';
  }

  function clearMessage(root) {
    root.textContent = '';
    root.className = 'sp-flash';
    root.style.display = 'none';
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
  }

  function hydrateFormFromProfile() {
    var seed = buildProfileSeed();
    if (seed.fullName === '' && seed.birthdateFr === '') {
      return;
    }

    var applied = false;
    var observer = null;

    function tryApply() {
      var fullnameInput = document.getElementById(FULLNAME_INPUT_ID);
      var birthdateInput = document.getElementById(BIRTHDATE_INPUT_ID);
      var touched = false;

      if (fullnameInput && normalizeString(fullnameInput.value) === '' && seed.fullName !== '') {
        setReactInputValue(fullnameInput, seed.fullName);
        touched = true;
      }
      if (birthdateInput && normalizeString(birthdateInput.value) === '' && seed.birthdateFr !== '') {
        setReactInputValue(birthdateInput, seed.birthdateFr);
        touched = true;
      }

      if ((fullnameInput || birthdateInput) && observer) {
        observer.disconnect();
        observer = null;
      }

      if (touched) {
        applied = true;
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
      '<div class="sp-profile-card">' +
      '  <div class="sp-profile-card__header">' +
      '    <div class="sp-profile-card__title">Mon Profil</div>' +
      '    <div class="sp-profile-card__meta">Ces informations peuvent préremplir votre prochaine demande d’ordonnance. Vous pourrez toujours les modifier si la demande concerne un proche.</div>' +
      '  </div>' +
      '  <div id="sp-profile-feedback" class="sp-flash" style="display:none"></div>' +
      '  <form id="sp-patient-profile-form" novalidate>' +
      '    <div class="sp-profile-grid">' +
      '      <label class="sp-field"><span>Prénom</span><input type="text" name="first_name" maxlength="100" autocomplete="given-name" value="' + escapeHtml(seed.firstName) + '" /></label>' +
      '      <label class="sp-field"><span>Nom</span><input type="text" name="last_name" maxlength="120" autocomplete="family-name" value="' + escapeHtml(seed.lastName) + '" /></label>' +
      '      <label class="sp-field"><span>Date de naissance</span><input type="text" name="birthdate" placeholder="JJ/MM/AAAA" inputmode="numeric" autocomplete="bday" value="' + escapeHtml(seed.birthdateFr) + '" /></label>' +
      '      <label class="sp-field"><span>Téléphone</span><input type="tel" name="phone" maxlength="40" autocomplete="tel" value="' + escapeHtml(seed.phone) + '" /></label>' +
      '    </div>' +
      '    <div class="sp-profile-actions"><button class="sp-btn sp-btn--primary" type="submit">Enregistrer mes informations</button></div>' +
      '  </form>' +
      '  <div class="sp-profile-hint">Les champs Nom, Prénom et Date de naissance servent à préremplir le formulaire, mais restent toujours modifiables avant l’envoi d’une demande.</div>' +
      '</div>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeProfilePayload(formData) {
    var firstName = normalizeString(formData.get('first_name')).replace(/\s+/g, ' ');
    var lastName = normalizeString(formData.get('last_name')).replace(/\s+/g, ' ');
    var birthdate = normalizeString(formData.get('birthdate'));
    var phone = normalizeString(formData.get('phone')).replace(/\s+/g, ' ');

    return {
      first_name: firstName,
      last_name: lastName,
      birthdate: birthdate,
      phone: phone
    };
  }

  async function submitProfile(payload) {
    var restBase = normalizeString(cfg.restBase);
    var nonce = normalizeString(cfg.nonce);

    if (restBase === '') {
      throw new Error('Configuration REST absente.');
    }
    if (nonce === '') {
      throw new Error('Nonce WordPress manquant.');
    }

    var response = await fetch(restBase.replace(/\/+$/, '') + PROFILE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-WP-Nonce': nonce
      },
      body: JSON.stringify(payload)
    });

    var data = null;
    try {
      data = await response.json();
    } catch (_err) {
      data = null;
    }

    if (!response.ok) {
      var message = data && typeof data.message === 'string' && data.message !== ''
        ? data.message
        : 'Impossible d’enregistrer le profil patient.';
      throw new Error(message);
    }

    return data && typeof data === 'object' ? data : {};
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

      submitButton.disabled = true;
      var originalText = submitButton.textContent;
      submitButton.textContent = 'Enregistrement…';

      submitProfile(payload)
        .then(function (data) {
          var profile = data && data.profile && typeof data.profile === 'object' ? data.profile : payload;
          updateGlobalProfile(profile);
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

  onReady(function () {
    hydrateFormFromProfile();
    mountPatientProfileSection();
  });

  window.addEventListener('sosprescription:patient-profile-updated', function () {
    hydrateFormFromProfile();
  });
})();
