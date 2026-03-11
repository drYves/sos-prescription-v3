(function () {
  'use strict';

  if (!window.SosPrescription || !window.SosPrescription.ocr || !window.SosPrescription.ocr.client) {
    return;
  }

  var cfg = window.SosPrescription.ocr.client;
  var i18n = (window.SosPrescription && window.SosPrescription.i18n) ? window.SosPrescription.i18n : {};

  var MSG_UNAVAILABLE = (i18n && i18n.ocr_unavailable) ? String(i18n.ocr_unavailable) : 'OCR local indisponible. Merci de réessayer.';
  var MSG_TIMEOUT = (i18n && i18n.ocr_timeout) ? String(i18n.ocr_timeout) : "L'analyse prend trop de temps. L'image est peut-etre trop lourde ou floue. Veuillez reessayer.";

  var TIMEOUT_MS = 15000;
  try {
    if (cfg && cfg.timeout_ms) {
      var ms = parseInt(cfg.timeout_ms, 10);
      if (!isNaN(ms) && ms >= 3000) TIMEOUT_MS = ms;
    }
  } catch (_) {
    // ignore
  }

  function dispatchEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (_) {
      // no-op
    }
  }

  function makeReqId() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 8; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  async function runOcr(file) {
    var reqId = makeReqId();

    dispatchEvent('sosprescription:ocr_status', {
      status: 'starting',
      reqId: reqId
    });

    if (!window.Tesseract || !window.Tesseract.createWorker) {
      dispatchEvent('sosprescription:ocr_error', {
        reqId: reqId,
        code: 'unavailable',
        message: MSG_UNAVAILABLE,
        raw: 'Tesseract missing'
      });
      return { ok: false, reqId: reqId, error: new Error('Tesseract missing') };
    }

    var worker = null;
    var terminated = false;

    async function safeTerminate() {
      if (terminated) return;
      terminated = true;
      try {
        if (worker) {
          await worker.terminate();
        }
      } catch (_) {
        // ignore
      }
    }

    try {
      worker = await window.Tesseract.createWorker({
        logger: function (m) {
          try {
            dispatchEvent('sosprescription:ocr_progress', {
              reqId: reqId,
              progress: m && typeof m.progress === 'number' ? m.progress : null,
              status: m && m.status ? String(m.status) : ''
            });
          } catch (_) {
            // no-op
          }
        },
        workerPath: cfg.worker_path,
        corePath: cfg.core_path,
        langPath: cfg.lang_path
      });

      dispatchEvent('sosprescription:ocr_status', {
        status: 'running',
        reqId: reqId
      });

      await worker.load();
      await worker.loadLanguage('fra');
      await worker.initialize('fra');

      var OCR_TIMEOUT_ERR = 'SOSPRESCRIPTION_OCR_TIMEOUT';
      var timeoutPromise = new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(new Error(OCR_TIMEOUT_ERR));
        }, TIMEOUT_MS);
      });

      var res = await Promise.race([
        worker.recognize(file),
        timeoutPromise
      ]);

      var text = '';
      try {
        if (res && res.data && typeof res.data.text === 'string') text = res.data.text;
        else if (res && typeof res.text === 'string') text = res.text;
      } catch (_) {
        text = '';
      }

      await safeTerminate();

      dispatchEvent('sosprescription:ocr_done', {
        reqId: reqId,
        text: text
      });

      return { ok: true, reqId: reqId, text: text };
    } catch (e) {
      var raw = (e && e.message) ? String(e.message) : '';
      var code = 'unknown';
      var msg = MSG_UNAVAILABLE;

      if (raw === 'SOSPRESCRIPTION_OCR_TIMEOUT') {
        code = 'timeout';
        msg = MSG_TIMEOUT;
      }

      await safeTerminate();

      dispatchEvent('sosprescription:ocr_error', {
        reqId: reqId,
        code: code,
        message: msg,
        raw: raw
      });

      return { ok: false, reqId: reqId, error: e };
    } finally {
      await safeTerminate();
    }
  }

  // Expose a simple API for the form app / React build.
  window.SosPrescription = window.SosPrescription || {};
  window.SosPrescription.ocr = window.SosPrescription.ocr || {};
  window.SosPrescription.ocr.run = runOcr;
})();
