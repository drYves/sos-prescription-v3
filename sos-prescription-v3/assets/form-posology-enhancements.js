// assets/form-posology-enhancements.js
(function () {
  'use strict';

  /**
   * Correctif de stabilisation V2/V3
   *
   * Le bundle React/Vite contient déjà sa propre logique de posologie.
   * Ce fichier ne doit donc plus modifier la structure DOM du sous-arbre React
   * (pas de MutationObserver, pas d’injection de labels, pas de dispatch
   * synthétique massif) afin d’éviter les collisions au moment où un
   * médicament est sélectionné et ajouté au formulaire.
   *
   * Rôle conservé :
   * - renforcer quelques attributs natifs (min/max/aria/placeholder)
   * - rester strictement passif
   */

  var ROOT_ID = 'sosprescription-root-form';
  var BLOCK_SELECTOR = '.rounded-xl.border.border-gray-200.p-4';
  var MAX_DAILY_TAKES = 6;
  var MAX_WEEKLY_TAKES = 12;
  var MAX_DURATION = 3650;
  var scanScheduled = false;

  function qsa(root, selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function text(node) {
    return String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function clampInt(value, min, max, fallback) {
    var number = parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(number)) {
      number = fallback;
    }

    if (number < min) {
      number = min;
    }
    if (number > max) {
      number = max;
    }

    return number;
  }

  function getRoot() {
    return document.getElementById(ROOT_ID);
  }

  function isPosologyBlock(block) {
    if (!block) {
      return false;
    }

    var content = text(block);
    if (content.indexOf('Fréquence') === -1 || content.indexOf('Durée') === -1) {
      return false;
    }

    return qsa(block, 'input[type="number"]').length >= 2 && qsa(block, 'select').length >= 1;
  }

  function findBlocks(root) {
    return qsa(root, BLOCK_SELECTOR).filter(isPosologyBlock);
  }

  function getControls(block) {
    var numberInputs = qsa(block, 'input[type="number"]');
    var selects = qsa(block, 'select');
    var rowBlocks = qsa(block, '.grid.grid-cols-1.gap-2.md\\:grid-cols-3').filter(function (row) {
      return !!row.querySelector('input[type="time"]') && !!row.querySelector('input[type="text"]');
    });

    return {
      countInput: numberInputs[0] || null,
      durationInput: numberInputs[1] || null,
      frequencySelect: selects[0] || null,
      durationUnitSelect: selects[1] || null,
      rows: rowBlocks,
      timeInputs: rowBlocks.map(function (row) {
        return row.querySelector('input[type="time"]');
      }).filter(Boolean),
      doseInputs: rowBlocks.map(function (row) {
        return row.querySelector('input[type="text"]');
      }).filter(Boolean)
    };
  }

  function getFrequency(controls) {
    return controls.frequencySelect && controls.frequencySelect.value === 'semaine' ? 'semaine' : 'jour';
  }

  function getMaxCount(frequency) {
    return frequency === 'semaine' ? MAX_WEEKLY_TAKES : MAX_DAILY_TAKES;
  }

  function enhanceBlock(block) {
    if (!block || block.getAttribute('data-sp-posology-passive') === '1') {
      // On continue quand même pour refléter les changements de fréquence.
    }

    var controls = getControls(block);
    if (!controls.countInput || !controls.durationInput || !controls.frequencySelect) {
      return;
    }

    var frequency = getFrequency(controls);
    var maxCount = getMaxCount(frequency);

    controls.countInput.setAttribute('min', '1');
    controls.countInput.setAttribute('max', String(maxCount));
    controls.countInput.setAttribute('step', '1');
    controls.countInput.setAttribute('inputmode', 'numeric');
    controls.countInput.setAttribute(
      'title',
      frequency === 'semaine' ? 'Nombre de prises par semaine' : 'Nombre de prises par jour'
    );
    controls.countInput.setAttribute(
      'aria-label',
      frequency === 'semaine' ? 'Nombre de prises par semaine' : 'Nombre de prises par jour'
    );

    controls.durationInput.setAttribute('min', '1');
    controls.durationInput.setAttribute('max', String(MAX_DURATION));
    controls.durationInput.setAttribute('step', '1');
    controls.durationInput.setAttribute('inputmode', 'numeric');
    controls.durationInput.setAttribute('aria-label', 'Durée du traitement');

    var rawDuration = String(controls.durationInput.value == null ? '' : controls.durationInput.value).trim();
    if (rawDuration !== '' && parseInt(rawDuration, 10) <= 0) {
      controls.durationInput.setCustomValidity('La durée doit être supérieure ou égale à 1.');
    } else {
      controls.durationInput.setCustomValidity('');
    }

    if (controls.frequencySelect) {
      controls.frequencySelect.setAttribute('aria-label', 'Fréquence de prise');
    }

    if (controls.durationUnitSelect) {
      controls.durationUnitSelect.setAttribute('aria-label', 'Unité de durée');
    }

    controls.timeInputs.forEach(function (input, index) {
      if (!input) {
        return;
      }
      input.setAttribute('aria-label', 'Horaire de prise ' + String(index + 1));
      input.setAttribute('step', '300');
    });

    controls.doseInputs.forEach(function (input, index) {
      if (!input) {
        return;
      }
      input.setAttribute('aria-label', 'Quantité pour la prise ' + String(index + 1));
      if (!input.getAttribute('placeholder')) {
        input.setAttribute('placeholder', 'Dose');
      }
    });

    block.setAttribute('data-sp-posology-passive', '1');
  }

  function scan() {
    scanScheduled = false;

    var root = getRoot();
    if (!root) {
      return;
    }

    findBlocks(root).forEach(enhanceBlock);
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scan);
      return;
    }

    window.setTimeout(scan, 16);
  }

  function onInput(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    if (target.matches('input[type="number"]')) {
      var controls = getControls(block);
      var frequency = getFrequency(controls);
      var maxCount = getMaxCount(frequency);

      if (controls.countInput === target) {
        var safeCount = clampInt(target.value, 1, maxCount, 1);
        target.setAttribute('max', String(maxCount));
        if (String(target.value).trim() !== '' && parseInt(target.value, 10) > maxCount) {
          target.setCustomValidity('Valeur trop élevée pour cette fréquence.');
        } else {
          target.setCustomValidity('');
        }
        if (!Number.isFinite(parseInt(String(target.value), 10)) && String(target.value).trim() !== '') {
          target.setCustomValidity('Saisissez un nombre entier.');
        }
        // Pas d’écriture de valeur ici : React gère déjà l’état.
        if (safeCount < 1) {
          target.setCustomValidity('La valeur doit être supérieure ou égale à 1.');
        }
      }

      if (controls.durationInput === target) {
        var rawDuration = String(target.value == null ? '' : target.value).trim();
        if (rawDuration !== '' && parseInt(rawDuration, 10) <= 0) {
          target.setCustomValidity('La durée doit être supérieure ou égale à 1.');
        } else {
          target.setCustomValidity('');
        }
      }
    }

    scheduleScan();
  }

  function onChange(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    scheduleScan();
  }

  function onBlur(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    if (target.matches('input[type="number"]')) {
      var controls = getControls(block);
      var frequency = getFrequency(controls);
      var maxCount = getMaxCount(frequency);

      if (controls.countInput === target) {
        var countValue = clampInt(target.value, 1, maxCount, 1);
        if (String(target.value).trim() === '' || parseInt(target.value, 10) !== countValue) {
          target.value = String(countValue);
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      if (controls.durationInput === target) {
        var durationValue = clampInt(target.value, 1, MAX_DURATION, 1);
        if (String(target.value).trim() === '' || parseInt(target.value, 10) !== durationValue) {
          target.value = String(durationValue);
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    scheduleScan();
  }

  function boot() {
    var root = getRoot();
    if (!root) {
      return;
    }

    scan();

    // Pas de MutationObserver : on évite de toucher au cycle React au moment
    // exact où un médicament est sélectionné et injecté dans l’arbre.
    document.addEventListener('focusin', scheduleScan, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('blur', onBlur, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
