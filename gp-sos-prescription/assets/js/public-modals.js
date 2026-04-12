(function () {
  'use strict';

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }

    callback();
  }

  ready(function () {
    var body = document.body;
    var modalSelector = '.sp-modal[id]';
    var modals = Array.prototype.slice.call(document.querySelectorAll(modalSelector));
    var lastActiveElement = null;

    if (!body || !modals.length) {
      return;
    }

    function modalIdFromName(name) {
      return 'sp-modal-' + String(name || '').trim();
    }

    function getModal(name) {
      return document.getElementById(modalIdFromName(name));
    }

    function getOpenModals() {
      return Array.prototype.slice.call(document.querySelectorAll('.sp-modal.is-open'));
    }

    function anyModalOpen() {
      return getOpenModals().length > 0;
    }

    function getFocusableElements(modal) {
      if (!modal) {
        return [];
      }

      return Array.prototype.slice.call(
        modal.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(function (element) {
        return element.offsetParent !== null || element === document.activeElement;
      });
    }

    function focusModal(modal) {
      var focusables = getFocusableElements(modal);
      if (focusables.length) {
        focusables[0].focus();
        return;
      }

      var dialog = modal.querySelector('[role="dialog"]');
      if (dialog) {
        if (!dialog.hasAttribute('tabindex')) {
          dialog.setAttribute('tabindex', '-1');
        }
        dialog.focus();
      }
    }

    function syncBodyState() {
      if (anyModalOpen()) {
        body.classList.add('sp-modal-open');
      } else {
        body.classList.remove('sp-modal-open');
      }
    }

    function openModal(name, trigger) {
      var modal = getModal(name);
      if (!modal) {
        return;
      }

      lastActiveElement = trigger || document.activeElement;
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      syncBodyState();
      focusModal(modal);
    }

    function closeModal(name) {
      var modal = getModal(name);
      if (!modal) {
        return;
      }

      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      syncBodyState();

      if (!anyModalOpen() && lastActiveElement && typeof lastActiveElement.focus === 'function') {
        lastActiveElement.focus();
      }
    }

    function closeAllModals() {
      getOpenModals().forEach(function (modal) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
      });
      syncBodyState();

      if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
        lastActiveElement.focus();
      }
    }

    document.addEventListener('click', function (event) {
      var openTrigger = event.target.closest('[data-sp-modal-open]');
      if (openTrigger) {
        event.preventDefault();
        openModal(openTrigger.getAttribute('data-sp-modal-open'), openTrigger);
        return;
      }

      var closeTrigger = event.target.closest('[data-sp-modal-close]');
      if (closeTrigger) {
        event.preventDefault();
        closeModal(closeTrigger.getAttribute('data-sp-modal-close'));
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeAllModals();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      var openModals = getOpenModals();
      if (!openModals.length) {
        return;
      }

      var modal = openModals[openModals.length - 1];
      var focusables = getFocusableElements(modal);
      if (!focusables.length) {
        return;
      }

      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  });
})();
