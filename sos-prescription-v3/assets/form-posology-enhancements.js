// assets/form-posology-enhancements.js
(function () {
  'use strict';

  var ROOT_ID = 'sosprescription-root-form';
  var BLOCK_SELECTOR = '.rounded-xl.border.border-gray-200.p-4';
  var timers = new WeakMap();

  var MAX_DAILY_TAKES = 6;
  var MAX_WEEKLY_TAKES = 12;
  var MAX_DURATION = 3650;

  var PRESET_TIMES = {
    1: ['08:00'],
    2: ['08:00', '20:00'],
    3: ['08:00', '12:00', '20:00'],
    4: ['08:00', '12:00', '16:00', '20:00'],
    5: ['08:00', '11:00', '14:00', '17:00', '20:00'],
    6: ['08:00', '10:30', '13:00', '15:30', '18:00', '20:30']
  };

  function qsa(root, selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function clampInt(value, min, max, fallback) {
    var number = parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(number)) {
      number = fallback;
    }

    number = Math.max(min, number);
    number = Math.min(max, number);

    return number;
  }

  function text(node) {
    return String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
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

  function getRowBlocks(block) {
    return qsa(block, '.grid.grid-cols-1.gap-2.md\\:grid-cols-3').filter(function (row) {
      return !!row.querySelector('input[type="time"]') && !!row.querySelector('input[type="text"]');
    });
  }

  function getControls(block) {
    var numberInputs = qsa(block, 'input[type="number"]');
    var selects = qsa(block, 'select');
    var rows = getRowBlocks(block);

    return {
      countInput: numberInputs[0] || null,
      durationInput: numberInputs[1] || null,
      frequencySelect: selects[0] || null,
      durationUnitSelect: selects[1] || null,
      rows: rows,
      timeInputs: rows.map(function (row) {
        return row.querySelector('input[type="time"]');
      }).filter(Boolean),
      doseInputs: rows.map(function (row) {
        return row.querySelector('input[type="text"]');
      }).filter(Boolean),
      buttons: qsa(block, 'button')
    };
  }

  function getFrequency(controls) {
    return controls.frequencySelect && controls.frequencySelect.value === 'semaine' ? 'semaine' : 'jour';
  }

  function getMaxCount(frequency) {
    return frequency === 'semaine' ? MAX_WEEKLY_TAKES : MAX_DAILY_TAKES;
  }

  function isAutoMode(block) {
    return qsa(block, 'button').some(function (button) {
      return text(button).indexOf('Réinitialiser horaires recommandés') !== -1;
    });
  }

  function setNativeValue(element, value) {
    var prototype = Object.getPrototypeOf(element);
    var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchValueUpdate(element, value) {
    if (!element) {
      return;
    }

    setNativeValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function recommendedTimes(count) {
    var safeCount = clampInt(count, 1, MAX_DAILY_TAKES, 1);

    if (PRESET_TIMES[safeCount]) {
      return PRESET_TIMES[safeCount].slice();
    }

    return PRESET_TIMES[1].slice();
  }

  function ordinalLabel(index) {
    var rank = index + 1;
    if (rank === 1) {
      return '1ère prise';
    }
    if (rank === 2) {
      return '2ème prise';
    }
    if (rank === 3) {
      return '3ème prise';
    }
    if (rank === 4) {
      return '4ème prise';
    }
    if (rank === 5) {
      return '5ème prise';
    }
    if (rank === 6) {
      return '6ème prise';
    }
    if (rank === 7) {
      return '7ème prise';
    }
    if (rank === 8) {
      return '8ème prise';
    }
    if (rank === 9) {
      return '9ème prise';
    }
    return String(rank) + 'ème prise';
  }

  function cleanupDuplicates(container, selector, keepNode) {
    qsa(container, selector).forEach(function (node) {
      if (node !== keepNode) {
        node.remove();
      }
    });
  }

  function ensureNode(container, selector, tagName, className, textValue, prepend) {
    var node = container.querySelector(selector);
    if (!node) {
      node = document.createElement(tagName);
      if (prepend && container.firstChild) {
        container.insertBefore(node, container.firstChild);
      } else {
        container.appendChild(node);
      }
    }

    node.className = className;
    node.textContent = textValue;

    return node;
  }

  function ensureTopHelper(block, frequency) {
    var controls = getControls(block);
    if (!controls.countInput) {
      return;
    }

    var grid = controls.countInput.closest('.grid');
    if (!grid) {
      return;
    }

    var helper = block.querySelector('[data-sp-posology-helper="1"]');
    if (!helper) {
      helper = document.createElement('div');
      helper.setAttribute('data-sp-posology-helper', '1');
      helper.className = 'mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900';
      grid.insertAdjacentElement('afterend', helper);
    }

    if (frequency === 'semaine') {
      helper.textContent = 'La fréquence indique ici le nombre de prises par semaine. Les horaires détaillés ne s’appliquent qu’au mode “Par jour”.';
    } else {
      helper.textContent = 'La fréquence indique le nombre de prises par jour. La quantité à prendre se renseigne plus bas, prise par prise.';
    }
  }

  function ensureTopLabels(block) {
    var controls = getControls(block);
    var frequency = getFrequency(controls);
    var maxCount = getMaxCount(frequency);
    var labelNodes = qsa(block, 'div.text-sm.font-medium.text-gray-900');

    if (labelNodes[0]) {
      labelNodes[0].textContent = 'Nombre de prises';
    }
    if (labelNodes[1]) {
      labelNodes[1].textContent = 'Fréquence';
    }
    if (labelNodes[2]) {
      labelNodes[2].textContent = 'Durée du traitement';
    }

    if (controls.countInput) {
      controls.countInput.setAttribute('aria-label', 'Nombre de prises');
      controls.countInput.setAttribute('min', '1');
      controls.countInput.setAttribute('max', String(maxCount));
      controls.countInput.setAttribute('step', '1');
      controls.countInput.setAttribute('inputmode', 'numeric');
      controls.countInput.setAttribute('title', frequency === 'semaine' ? 'Nombre de prises par semaine' : 'Nombre de prises par jour');
    }

    if (controls.frequencySelect) {
      controls.frequencySelect.setAttribute('aria-label', 'Fréquence de prise');
    }

    if (controls.durationInput) {
      controls.durationInput.setAttribute('aria-label', 'Durée du traitement');
      controls.durationInput.setAttribute('min', '1');
      controls.durationInput.setAttribute('max', String(MAX_DURATION));
      controls.durationInput.setAttribute('step', '1');
      controls.durationInput.setAttribute('inputmode', 'numeric');

      var raw = String(controls.durationInput.value == null ? '' : controls.durationInput.value).trim();
      if (raw !== '' && parseInt(raw, 10) <= 0) {
        controls.durationInput.setCustomValidity('La durée doit être supérieure ou égale à 1.');
      } else {
        controls.durationInput.setCustomValidity('');
      }
    }

    if (controls.durationUnitSelect) {
      controls.durationUnitSelect.setAttribute('aria-label', 'Unité de durée');
    }

    ensureTopHelper(block, frequency);
  }

  function ensureRowLabels(block) {
    var controls = getControls(block);
    var frequency = getFrequency(controls);
    var maxCount = getMaxCount(frequency);
    var count = clampInt(controls.countInput && controls.countInput.value, 1, maxCount, 1);
    var autoMode = isAutoMode(block) && frequency === 'jour';

    controls.rows.forEach(function (row, index) {
      var headerCell = row.children[0] || row.querySelector('div');
      var timeInput = row.querySelector('input[type="time"]');
      var doseInput = row.querySelector('input[type="text"]');

      if (!headerCell || !timeInput || !doseInput) {
        return;
      }

      row.setAttribute('data-sp-row-index', String(index + 1));

      var titleNode = headerCell.querySelector('[data-sp-posology-row-title="1"]') || headerCell.querySelector('span.font-medium');
      if (!titleNode) {
        titleNode = document.createElement('span');
        headerCell.insertBefore(titleNode, headerCell.firstChild);
      }
      titleNode.setAttribute('data-sp-posology-row-title', '1');
      titleNode.className = 'font-medium';
      titleNode.textContent = ordinalLabel(index);
      cleanupDuplicates(headerCell, '[data-sp-posology-row-title="1"]', titleNode);

      var noteText = autoMode && (index === 0 || index === count - 1) ? '(ancre)' : '';
      var noteNode = headerCell.querySelector('[data-sp-posology-row-note="1"]');

      if (noteText !== '') {
        if (!noteNode) {
          noteNode = document.createElement('span');
          noteNode.setAttribute('data-sp-posology-row-note', '1');
          headerCell.appendChild(noteNode);
        }
        noteNode.className = 'ml-2 text-xs text-gray-500';
        noteNode.textContent = noteText;
      } else if (noteNode) {
        noteNode.remove();
      }

      var timeCell = timeInput.parentElement;
      var doseCell = doseInput.parentElement;

      if (timeCell) {
        var timeLabel = ensureNode(
          timeCell,
          '[data-sp-field-label="time"]',
          'div',
          'mb-1 text-xs font-medium text-gray-600',
          'Horaire',
          true
        );
        timeLabel.setAttribute('data-sp-field-label', 'time');
        cleanupDuplicates(timeCell, '[data-sp-field-label="time"]', timeLabel);
      }

      if (doseCell) {
        var doseLabel = ensureNode(
          doseCell,
          '[data-sp-field-label="dose"]',
          'div',
          'mb-1 text-xs font-medium text-gray-600',
          'Quantité / prise',
          true
        );
        doseLabel.setAttribute('data-sp-field-label', 'dose');
        cleanupDuplicates(doseCell, '[data-sp-field-label="dose"]', doseLabel);
      }

      doseInput.setAttribute('placeholder', 'Ex : 1 comprimé');
      doseInput.setAttribute('aria-label', 'Quantité pour ' + ordinalLabel(index));
      timeInput.setAttribute('aria-label', 'Horaire pour ' + ordinalLabel(index));

      if (index >= count) {
        row.style.display = 'none';
      } else {
        row.style.removeProperty('display');
      }
    });
  }

  function normalizeNumericFields(block, hard) {
    var controls = getControls(block);
    if (!controls.countInput || !controls.durationInput || !controls.frequencySelect) {
      return;
    }

    var frequency = getFrequency(controls);
    var maxCount = getMaxCount(frequency);
    var countValue = clampInt(controls.countInput.value, 1, maxCount, 1);
    var durationValue = clampInt(controls.durationInput.value, 1, MAX_DURATION, 1);

    controls.countInput.setAttribute('max', String(maxCount));

    if (hard && String(controls.countInput.value) !== String(countValue)) {
      dispatchValueUpdate(controls.countInput, String(countValue));
      return;
    }

    if (hard && String(controls.durationInput.value) !== String(durationValue)) {
      dispatchValueUpdate(controls.durationInput, String(durationValue));
      return;
    }

    if (String(controls.durationInput.value).trim() !== '' && parseInt(controls.durationInput.value, 10) <= 0) {
      controls.durationInput.setCustomValidity('La durée doit être supérieure ou égale à 1.');
    } else {
      controls.durationInput.setCustomValidity('');
    }
  }

  function applyRecommendedTimes(block) {
    var controls = getControls(block);
    if (!controls.frequencySelect || getFrequency(controls) !== 'jour') {
      return;
    }

    var count = clampInt(controls.countInput && controls.countInput.value, 1, MAX_DAILY_TAKES, 1);
    var times = recommendedTimes(count);
    var timeInputs = controls.timeInputs.slice(0, count);

    if (!timeInputs.length) {
      return;
    }

    timeInputs.forEach(function (input, index) {
      var value = times[index] || times[times.length - 1] || '08:00';
      dispatchValueUpdate(input, value);
    });
  }

  function patchBlock(block, hard) {
    if (!block) {
      return;
    }

    ensureTopLabels(block);
    normalizeNumericFields(block, !!hard);
    ensureRowLabels(block);
  }

  function schedulePatch(block, hard, delay, withRecommendedTimes) {
    if (!block) {
      return;
    }

    if (timers.has(block)) {
      window.clearTimeout(timers.get(block));
    }

    var timeout = window.setTimeout(function () {
      timers.delete(block);
      patchBlock(block, hard);
      if (withRecommendedTimes) {
        applyRecommendedTimes(block);
      }
    }, typeof delay === 'number' ? delay : 120);

    timers.set(block, timeout);
  }

  function scan() {
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    findBlocks(root).forEach(function (block) {
      patchBlock(block, false);
    });
  }

  function onDocumentClick(event) {
    var button = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!button) {
      return;
    }

    var block = button.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    var label = text(button);
    if (label.indexOf('Réinitialiser horaires recommandés') !== -1 || label.indexOf('Horaires auto') !== -1) {
      schedulePatch(block, true, 160, true);
    }
  }

  function onDocumentInput(event) {
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

      if (controls.durationInput === target) {
        var rawDuration = String(target.value == null ? '' : target.value).trim();
        if (rawDuration !== '' && parseInt(rawDuration, 10) <= 0) {
          target.setCustomValidity('La durée doit être supérieure ou égale à 1.');
        } else {
          target.setCustomValidity('');
        }
      }
    }

    patchBlock(block, false);
  }

  function onDocumentChange(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    normalizeNumericFields(block, true);
    patchBlock(block, true);

    if (target.matches('input[type="number"], select')) {
      if (isAutoMode(block)) {
        schedulePatch(block, true, 140, true);
      } else {
        schedulePatch(block, true, 80, false);
      }
    }
  }

  function onDocumentBlur(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    normalizeNumericFields(block, true);
    patchBlock(block, true);
  }

  function observe() {
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    var observer = new MutationObserver(function () {
      scan();
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function boot() {
    scan();
    observe();
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('input', onDocumentInput, true);
    document.addEventListener('change', onDocumentChange, true);
    document.addEventListener('blur', onDocumentBlur, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
