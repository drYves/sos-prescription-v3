(function () {
  'use strict';
  // Lot B stateless deployment marker.

  var GLOBAL_KEY = 'sosPrescriptionDoctorConsole';
  var DEFAULTS = {
    pollIntervalMs: 2000,
    openMode: 'new-tab',
    prescriptionId: 0,
    nonce: '',
    routes: {
      decision: '',
      rxPdf: '',
      pdfStatus: '',
      jobStatus: '',
      jobResult: ''
    }
  };

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function deepMerge(target, source) {
    var output = isPlainObject(target) ? target : {};
    Object.keys(source || {}).forEach(function (key) {
      var sourceValue = source[key];
      var targetValue = output[key];

      if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
        output[key] = deepMerge(targetValue, sourceValue);
        return;
      }

      if (isPlainObject(sourceValue)) {
        output[key] = deepMerge({}, sourceValue);
        return;
      }

      output[key] = sourceValue;
    });

    return output;
  }

  function parseJsonMaybe(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function templateUrl(template, vars) {
    if (typeof template === 'function') {
      return template(vars || {});
    }

    if (typeof template !== 'string' || template === '') {
      return '';
    }

    return template.replace(/\{([^}]+)\}/g, function (_, key) {
      return encodeURIComponent(vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '');
    });
  }

  function buildUrlWithQuery(url, params) {
    if (!url) {
      return '';
    }

    var parsed = new URL(url, window.location.origin);
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') {
        return;
      }
      parsed.searchParams.set(key, value);
    });

    return parsed.toString();
  }

  function serializeForm(form) {
    var formData = new FormData(form);
    var payload = {};

    formData.forEach(function (value, key) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        if (!Array.isArray(payload[key])) {
          payload[key] = [payload[key]];
        }
        payload[key].push(value);
        return;
      }

      payload[key] = value;
    });

    return payload;
  }

  function pickNested(object, path) {
    if (!object || !path) {
      return undefined;
    }

    var current = object;
    var parts = path.split('.');

    for (var i = 0; i < parts.length; i += 1) {
      if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, parts[i])) {
        return undefined;
      }
      current = current[parts[i]];
    }

    return current;
  }

  function coerceNumber(value, fallback) {
    var number = parseInt(value, 10);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeStatus(payload, httpStatus) {
    var candidates = [
      pickNested(payload, 'status'),
      pickNested(payload, 'job_status'),
      pickNested(payload, 'job.status'),
      pickNested(payload, 'pdf.status'),
      pickNested(payload, 'dispatch.status'),
      pickNested(payload, 'state')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof candidates[i] === 'string' && candidates[i].trim() !== '') {
        return candidates[i].trim().toLowerCase();
      }
    }

    if (httpStatus === 202) {
      return 'pending';
    }

    if (httpStatus >= 200 && httpStatus < 300) {
      return 'completed';
    }

    if (httpStatus >= 400) {
      return 'failed';
    }

    return '';
  }

  function isPendingStatus(status, httpStatus) {
    return [
      'pending',
      'queued',
      'claiming',
      'claimed',
      'running',
      'processing',
      'in_progress',
      'in-progress',
      'retry'
    ].indexOf(status) !== -1 || httpStatus === 202;
  }

  function isCompletedStatus(status, httpStatus) {
    return [
      'completed',
      'complete',
      'done',
      'succeeded',
      'success',
      'available'
    ].indexOf(status) !== -1 || (httpStatus >= 200 && httpStatus < 300 && status === 'ready');
  }

  function isFailedStatus(status, httpStatus) {
    return [
      'failed',
      'error',
      'cancelled',
      'canceled',
      'expired',
      'degraded'
    ].indexOf(status) !== -1 || httpStatus >= 400;
  }

  function resolveResultUrl(payload) {
    var candidates = [
      pickNested(payload, 'result_url'),
      pickNested(payload, 'download_url'),
      pickNested(payload, 'pdf.result_url'),
      pickNested(payload, 'pdf.download_url'),
      pickNested(payload, 'result.url'),
      pickNested(payload, 'data.result_url')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof candidates[i] === 'string' && candidates[i].trim() !== '') {
        return candidates[i].trim();
      }
    }

    return '';
  }

  function resolveJobUid(payload) {
    var candidates = [
      pickNested(payload, 'job_uid'),
      pickNested(payload, 'jobUid'),
      pickNested(payload, 'job_id'),
      pickNested(payload, 'jobId'),
      pickNested(payload, 'job.uid'),
      pickNested(payload, 'job.id'),
      pickNested(payload, 'dispatch.job_uid'),
      pickNested(payload, 'dispatch.job_id'),
      pickNested(payload, 'dispatch.jobId'),
      pickNested(payload, 'pdf.job_uid'),
      pickNested(payload, 'pdf.job_id'),
      pickNested(payload, 'pdf.jobId')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] !== undefined && candidates[i] !== null && String(candidates[i]).trim() !== '') {
        return String(candidates[i]).trim();
      }
    }

    return '';
  }

  function resolvePrescriptionId(payload, fallback) {
    var candidates = [
      pickNested(payload, 'prescription_id'),
      pickNested(payload, 'prescriptionId'),
      pickNested(payload, 'id'),
      pickNested(payload, 'prescription.id')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      var value = coerceNumber(candidates[i], 0);
      if (value > 0) {
        return value;
      }
    }

    return coerceNumber(fallback, 0);
  }

  function resolveMessage(payload, fallback) {
    var candidates = [
      pickNested(payload, 'message'),
      pickNested(payload, 'error'),
      pickNested(payload, 'data.message'),
      pickNested(payload, 'pdf.message')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof candidates[i] === 'string' && candidates[i].trim() !== '') {
        return candidates[i].trim();
      }
    }

    return fallback || '';
  }

  function toPayloadObject(source) {
    if (typeof source === 'string') {
      return parseJsonMaybe(source) || {};
    }

    if (isPlainObject(source)) {
      return source;
    }

    return {};
  }

  function parseResponse(text, contentType) {
    if (typeof text !== 'string' || text === '') {
      return {};
    }

    if (contentType && contentType.indexOf('application/json') !== -1) {
      try {
        return JSON.parse(text);
      } catch (error) {
        return { message: text };
      }
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return { message: text };
    }
  }

  function DoctorConsole(root) {
    this.root = root || document;
    this.statusNode = this.root.querySelector ? this.root.querySelector('[data-sosprescription-status]') : null;
    this.config = this.resolveConfig();
    this.pollTimer = null;
    this.currentPoll = null;
    this.bind();
  }

  DoctorConsole.prototype.resolveConfig = function () {
    var globalConfig = isPlainObject(window[GLOBAL_KEY]) ? window[GLOBAL_KEY] : {};
    var dataset = this.root && this.root.dataset ? this.root.dataset : {};
    var datasetConfig = {
      nonce: dataset.wpNonce || dataset.nonce || '',
      prescriptionId: coerceNumber(dataset.prescriptionId, coerceNumber(globalConfig.prescriptionId, 0)),
      pollIntervalMs: coerceNumber(dataset.pollIntervalMs, coerceNumber(globalConfig.pollIntervalMs, DEFAULTS.pollIntervalMs)),
      openMode: dataset.openMode || globalConfig.openMode || DEFAULTS.openMode,
      routes: {
        decision: dataset.decisionEndpoint || '',
        rxPdf: dataset.rxPdfEndpoint || '',
        pdfStatus: dataset.pdfStatusEndpoint || '',
        jobStatus: dataset.jobStatusEndpointTemplate || '',
        jobResult: dataset.jobResultEndpointTemplate || ''
      }
    };

    return deepMerge(deepMerge({}, DEFAULTS), deepMerge(globalConfig, datasetConfig));
  };

  DoctorConsole.prototype.bind = function () {
    var self = this;

    document.addEventListener('submit', function (event) {
      var form = event.target.closest('[data-sosprescription-api-form]');
      if (!form) {
        return;
      }

      if (self.root !== document && !self.root.contains(form)) {
        return;
      }

      event.preventDefault();
      self.handleFormSubmit(form);
    });

    document.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-sosprescription-api-action]');
      if (!trigger) {
        return;
      }

      if (self.root !== document && !self.root.contains(trigger)) {
        return;
      }

      event.preventDefault();
      self.handleActionClick(trigger);
    });
  };

  DoctorConsole.prototype.handleFormSubmit = async function (form) {
    var payload = serializeForm(form);
    var formAction = form.dataset.sosprescriptionAction || form.dataset.action || '';
    var prescriptionId = this.getPrescriptionId(form, payload);
    var endpoint = form.action || form.dataset.endpoint || this.resolveEndpoint(formAction, prescriptionId);
    var method = (form.method || form.dataset.method || 'POST').toUpperCase();
    var openMode = form.dataset.openMode || this.config.openMode;

    await this.submitRequest({
      endpoint: endpoint,
      method: method,
      payload: payload,
      trigger: form,
      action: formAction,
      prescriptionId: prescriptionId,
      openMode: openMode
    });
  };

  DoctorConsole.prototype.handleActionClick = async function (trigger) {
    var action = trigger.dataset.sosprescriptionApiAction || trigger.dataset.action || '';
    var relatedForm = trigger.closest('form');
    var payload = relatedForm ? serializeForm(relatedForm) : {};

    if (trigger.dataset.payload) {
      payload = deepMerge(payload, toPayloadObject(trigger.dataset.payload));
    }

    if (action === 'approve' || action === 'validate' || trigger.dataset.decision === 'approved') {
      payload.decision = 'approved';
    }

    if (action === 'reject' || trigger.dataset.decision === 'rejected') {
      payload.decision = 'rejected';
    }

    var prescriptionId = this.getPrescriptionId(trigger, payload);
    var endpoint = trigger.dataset.endpoint || (relatedForm && relatedForm.action) || this.resolveEndpoint(action, prescriptionId);
    var method = (trigger.dataset.method || (relatedForm && relatedForm.method) || 'POST').toUpperCase();
    var openMode = trigger.dataset.openMode || this.config.openMode;

    await this.submitRequest({
      endpoint: endpoint,
      method: method,
      payload: payload,
      trigger: trigger,
      action: action,
      prescriptionId: prescriptionId,
      openMode: openMode
    });
  };

  DoctorConsole.prototype.resolveEndpoint = function (action, prescriptionId) {
    var routes = this.config.routes || {};
    var vars = {
      id: prescriptionId,
      prescription_id: prescriptionId,
      prescriptionId: prescriptionId
    };

    if (action === 'approve' || action === 'validate' || action === 'reject') {
      return templateUrl(routes.decision, vars);
    }

    if (action === 'generate-pdf' || action === 'rx-pdf' || action === 'pdf') {
      return templateUrl(routes.rxPdf, vars);
    }

    if (action === 'pdf-status') {
      return templateUrl(routes.pdfStatus, vars);
    }

    return '';
  };

  DoctorConsole.prototype.getPrescriptionId = function (element, payload) {
    var payloadId = coerceNumber(payload && (payload.prescription_id || payload.prescriptionId || payload.id), 0);
    if (payloadId > 0) {
      return payloadId;
    }

    var dataId = coerceNumber(element && element.dataset ? element.dataset.prescriptionId : 0, 0);
    if (dataId > 0) {
      return dataId;
    }

    if (this.root && this.root.dataset) {
      dataId = coerceNumber(this.root.dataset.prescriptionId, 0);
      if (dataId > 0) {
        return dataId;
      }
    }

    return coerceNumber(this.config.prescriptionId, 0);
  };

  DoctorConsole.prototype.fetchJson = async function (url, options) {
    var method = (options.method || 'GET').toUpperCase();
    var headers = new Headers(options.headers || {});
    var body = null;

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    if (!headers.has('X-WP-Nonce') && this.config.nonce) {
      headers.set('X-WP-Nonce', this.config.nonce);
    }

    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.payload || {});
    }

    var response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin'
    });

    var text = await response.text();
    var data = parseResponse(text, response.headers.get('content-type'));

    return {
      ok: response.ok,
      status: response.status,
      data: data
    };
  };

  DoctorConsole.prototype.submitRequest = async function (request) {
    if (!request.endpoint) {
      this.setStatus('Endpoint API introuvable.', 'error');
      return;
    }

    this.setBusy(true);
    this.setStatus('Transmission en cours…', 'loading');

    try {
      var response = await this.fetchJson(request.endpoint, {
        method: request.method,
        payload: request.payload
      });

      var responseData = isPlainObject(response.data) ? response.data : {};
      var status = normalizeStatus(responseData, response.status);
      var message = resolveMessage(responseData, '');
      var resultUrl = resolveResultUrl(responseData);
      var jobUid = resolveJobUid(responseData);
      var prescriptionId = resolvePrescriptionId(responseData, request.prescriptionId);

      if (resultUrl && isCompletedStatus(status, response.status)) {
        this.setStatus(message || 'PDF disponible.', 'success');
        this.finishWithUrl(resultUrl, request.openMode);
        return;
      }

      if (response.status === 202 || isPendingStatus(status, response.status) || jobUid) {
        var poll = this.buildPollContext(responseData, request, jobUid, prescriptionId);
        this.startPolling(poll);
        return;
      }

      if (!response.ok || isFailedStatus(status, response.status)) {
        this.setBusy(false);
        this.setStatus(message || 'La requête a échoué.', 'error');
        return;
      }

      this.setBusy(false);
      this.setStatus(message || 'Action enregistrée.', 'success');
    } catch (error) {
      this.setBusy(false);
      this.setStatus(error && error.message ? error.message : 'Erreur réseau.', 'error');
    }
  };

  DoctorConsole.prototype.buildPollContext = function (responseData, request, jobUid, prescriptionId) {
    var statusUrl = '';
    var resultUrlEndpoint = '';
    var routes = this.config.routes || {};
    var vars = {
      id: prescriptionId,
      prescription_id: prescriptionId,
      prescriptionId: prescriptionId,
      job_uid: jobUid,
      jobUid: jobUid
    };

    if (typeof responseData.status_url === 'string' && responseData.status_url !== '') {
      statusUrl = responseData.status_url;
    } else if (typeof responseData.poll_url === 'string' && responseData.poll_url !== '') {
      statusUrl = responseData.poll_url;
    } else if (typeof pickNested(responseData, 'job.status_url') === 'string' && pickNested(responseData, 'job.status_url') !== '') {
      statusUrl = pickNested(responseData, 'job.status_url');
    } else if (jobUid && routes.jobStatus) {
      statusUrl = templateUrl(routes.jobStatus, vars);
    } else if (prescriptionId > 0 && routes.pdfStatus) {
      statusUrl = templateUrl(routes.pdfStatus, vars);
    }

    if (typeof responseData.result_url_endpoint === 'string' && responseData.result_url_endpoint !== '') {
      resultUrlEndpoint = responseData.result_url_endpoint;
    } else if (typeof pickNested(responseData, 'job.result_url_endpoint') === 'string' && pickNested(responseData, 'job.result_url_endpoint') !== '') {
      resultUrlEndpoint = pickNested(responseData, 'job.result_url_endpoint');
    } else if (jobUid && routes.jobResult) {
      resultUrlEndpoint = templateUrl(routes.jobResult, vars);
    } else if (prescriptionId > 0 && routes.rxPdf) {
      resultUrlEndpoint = buildUrlWithQuery(templateUrl(routes.rxPdf, vars), { dispatch: 0 });
    }

    return {
      jobUid: jobUid,
      prescriptionId: prescriptionId,
      statusUrl: statusUrl,
      resultUrlEndpoint: resultUrlEndpoint,
      openMode: request.openMode,
      action: request.action || '',
      attempts: 0
    };
  };

  DoctorConsole.prototype.startPolling = function (poll) {
    if (!poll.statusUrl && !poll.resultUrlEndpoint) {
      this.setBusy(false);
      this.setStatus('Aucun endpoint de suivi n’est configuré pour le job PDF.', 'error');
      return;
    }

    this.clearPolling();
    this.currentPoll = poll;
    this.setStatus('PDF en cours de génération…', 'loading');
    this.scheduleNextPoll(0);
  };

  DoctorConsole.prototype.scheduleNextPoll = function (delay) {
    var self = this;
    this.pollTimer = window.setTimeout(function () {
      self.runPollingCycle();
    }, delay);
  };

  DoctorConsole.prototype.runPollingCycle = async function () {
    if (!this.currentPoll) {
      return;
    }

    var poll = this.currentPoll;
    var endpoint = poll.statusUrl || poll.resultUrlEndpoint;

    try {
      var response = await this.fetchJson(endpoint, { method: 'GET' });
      var payload = isPlainObject(response.data) ? response.data : {};
      var status = normalizeStatus(payload, response.status);
      var resultUrl = resolveResultUrl(payload);
      var message = resolveMessage(payload, '');

      poll.attempts += 1;

      if (isCompletedStatus(status, response.status)) {
        if (!resultUrl) {
          resultUrl = await this.fetchFinalResultUrl(poll);
        }

        if (resultUrl) {
          this.setStatus(message || 'PDF prêt.', 'success');
          this.finishWithUrl(resultUrl, poll.openMode);
          return;
        }
      }

      if (isFailedStatus(status, response.status)) {
        this.clearPolling();
        this.setBusy(false);
        this.setStatus(message || 'La génération du PDF a échoué.', 'error');
        return;
      }

      if (resultUrl) {
        this.setStatus(message || 'PDF prêt.', 'success');
        this.finishWithUrl(resultUrl, poll.openMode);
        return;
      }

      this.setStatus(message || 'PDF en cours de génération…', 'loading');
      this.scheduleNextPoll(this.config.pollIntervalMs);
    } catch (error) {
      poll.attempts += 1;
      this.setStatus('Suivi du job PDF en cours…', 'loading');
      this.scheduleNextPoll(this.config.pollIntervalMs);
    }
  };

  DoctorConsole.prototype.fetchFinalResultUrl = async function (poll) {
    if (!poll.resultUrlEndpoint) {
      return '';
    }

    try {
      var response = await this.fetchJson(poll.resultUrlEndpoint, { method: 'GET' });
      return resolveResultUrl(response.data || {});
    } catch (error) {
      return '';
    }
  };

  DoctorConsole.prototype.finishWithUrl = function (url, openMode) {
    this.clearPolling();
    this.setBusy(false);

    if (!url) {
      return;
    }

    if ((openMode || this.config.openMode) === 'same-tab') {
      window.location.assign(url);
      return;
    }

    var opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      window.location.assign(url);
    }
  };

  DoctorConsole.prototype.clearPolling = function () {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPoll = null;
  };

  DoctorConsole.prototype.setBusy = function (busy) {
    var root = this.root === document ? document : this.root;
    var nodes = root.querySelectorAll('[data-sosprescription-api-action], [data-sosprescription-api-form] button, [data-sosprescription-api-form] input[type="submit"]');

    Array.prototype.forEach.call(nodes, function (node) {
      if ('disabled' in node) {
        node.disabled = !!busy;
      }
      node.setAttribute('aria-busy', busy ? 'true' : 'false');
      node.classList.toggle('is-loading', !!busy);
    });
  };

  DoctorConsole.prototype.setStatus = function (message, type) {
    if (!this.statusNode) {
      return;
    }

    this.statusNode.textContent = message || '';
    this.statusNode.dataset.state = type || 'info';
    this.statusNode.classList.remove('is-loading', 'is-success', 'is-error', 'is-info');
    this.statusNode.classList.add(type === 'loading' ? 'is-loading' : '');
    this.statusNode.classList.add(type === 'success' ? 'is-success' : '');
    this.statusNode.classList.add(type === 'error' ? 'is-error' : '');
    this.statusNode.classList.add(!type || type === 'info' ? 'is-info' : '');
  };

  function boot() {
    var roots = document.querySelectorAll('[data-sosprescription-doctor-console]');
    if (!roots.length) {
      if (window[GLOBAL_KEY]) {
        new DoctorConsole(document);
      }
      return;
    }

    Array.prototype.forEach.call(roots, function (root) {
      new DoctorConsole(root);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SOSPrescriptionDoctorConsole = {
    boot: boot,
    version: '2.2.0-stateless'
  };
})();
