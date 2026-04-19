type AppConfig = {
  restBase?: string;
  nonce?: string;
};

type SmartPulseKind = 'doctor_inbox' | 'doctor_prescription';

type SmartPulseCacheEntry = {
  key: string;
  kind: SmartPulseKind;
  requestUrl: string;
  bodyText: string;
  status: number;
  headers: Record<string, string>;
  collectionHash?: string;
  stateHash?: string;
  lastNetworkAt: number;
  stableCount: number;
  stable: boolean;
  historyQuery: boolean;
  statusValue?: string;
  processingStatus?: string;
  clinicalResolved?: boolean;
  technicalPending?: boolean;
};

type FetchPatchState = {
  originalFetch: typeof fetch;
  installed: boolean;
  smartPulseCache?: Map<string, SmartPulseCacheEntry>;
  smartPulseListenersInstalled?: boolean;
  smartPulseWakeAt?: number;
  smartPulseVisiblePrefetchInFlight?: boolean;
};

type GlobalWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  __SosPrescriptionFetchPatch?: FetchPatchState;
};

type TrackedRequest = {
  key: string;
  kind: SmartPulseKind;
  networkUrl: string;
  hashParam: 'known_collection_hash' | 'known_state_hash';
  historyQuery: boolean;
};

type TrackedEntrySemantics = {
  historyQuery: boolean;
  statusValue?: string;
  processingStatus?: string;
  clinicalResolved: boolean;
  technicalPending: boolean;
};

function getGlobalWindow(): GlobalWindow {
  return (typeof globalThis !== 'undefined' ? globalThis : window) as unknown as GlobalWindow;
}

function ensureSmartPulseState(state: FetchPatchState): Required<Pick<FetchPatchState, 'smartPulseCache' | 'smartPulseListenersInstalled' | 'smartPulseWakeAt' | 'smartPulseVisiblePrefetchInFlight'>> {
  if (!(state.smartPulseCache instanceof Map)) {
    state.smartPulseCache = new Map<string, SmartPulseCacheEntry>();
  }
  if (typeof state.smartPulseListenersInstalled !== 'boolean') {
    state.smartPulseListenersInstalled = false;
  }
  if (typeof state.smartPulseWakeAt !== 'number') {
    state.smartPulseWakeAt = 0;
  }
  if (typeof state.smartPulseVisiblePrefetchInFlight !== 'boolean') {
    state.smartPulseVisiblePrefetchInFlight = false;
  }

  return {
    smartPulseCache: state.smartPulseCache,
    smartPulseListenersInstalled: state.smartPulseListenersInstalled,
    smartPulseWakeAt: state.smartPulseWakeAt,
    smartPulseVisiblePrefetchInFlight: state.smartPulseVisiblePrefetchInFlight,
  };
}

function getConfigOrNull(): AppConfig | null {
  const g = getGlobalWindow();
  const cfg = g.SosPrescription || g.SOSPrescription;
  if (!cfg || typeof cfg !== 'object') {
    return null;
  }
  return cfg;
}

function normalizeRestBase(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/$/, '') : '';
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }

  return '';
}

function absolutizeUrl(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'https://sosprescription.local';
    return new URL(value, origin).toString();
  } catch {
    return String(value || '');
  }
}

function isTargetRestUrl(url: string, restBase: string): boolean {
  const normalizedUrl = absolutizeUrl(url);
  const normalizedRestBase = absolutizeUrl(restBase);
  return normalizedUrl !== '' && normalizedRestBase !== '' && normalizedUrl.startsWith(normalizedRestBase);
}

function applyHeaders(target: Headers, source?: HeadersInit): void {
  if (!source) {
    return;
  }

  try {
    new Headers(source).forEach((value, key) => {
      target.set(key, value);
    });
  } catch {
    // Ignore invalid external headers and fall back to a permissive pass-through.
  }
}

function detectScope(): string {
  try {
    if (typeof document !== 'undefined') {
      if (document.getElementById('sosprescription-root-form')) {
        return 'sosprescription_form';
      }

      if (
        document.getElementById('sosprescription-doctor-console-root')
        || document.querySelector('[data-sp-doctor-chat-root="1"]')
      ) {
        return 'sosprescription_admin';
      }

      const currentScript = document.currentScript;
      if (currentScript instanceof HTMLScriptElement) {
        const src = String(currentScript.getAttribute('src') || currentScript.src || '').toLowerCase();
        if (src.endsWith('/form.js') || src.endsWith('form.js') || src.includes('/form-')) {
          return 'sosprescription_form';
        }
        if (src.endsWith('/admin.js') || src.endsWith('admin.js') || src.includes('/admin-')) {
          return 'sosprescription_admin';
        }
      }
    }
  } catch {
    // Ignore detection failures and fall back to the safest admin scope.
  }

  return 'sosprescription_admin';
}

function parsePayloadFromText(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeConsoleError(...args: unknown[]): void {
  try {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(...args);
    }
  } catch {
    // Ignore console failures in hostile browser environments.
  }
}

async function logRejectedResponse(url: string, response: Response): Promise<void> {
  const targetUrl = response.url || url || '(inconnue)';

  try {
    const rawText = await response.clone().text();
    const payload = parsePayloadFromText(rawText);

    if (payload !== null && payload !== '') {
      safeConsoleError(`[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status}`, {
        status: response.status,
        url: targetUrl,
        payload,
      });
      return;
    }

    safeConsoleError(`[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status}`, {
      status: response.status,
      url: targetUrl,
    });
  } catch (error) {
    safeConsoleError(
      `[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status} (lecture du payload impossible)`,
      error,
    );
  }
}

function normalizeHash(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{12,128}$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

const DOCTOR_ACTIVE_STATUS = 'pending';
const DOCTOR_HISTORY_STATUS = 'approved';
const HISTORY_VISIBLE_CACHE_TTL_MS = 90_000;
const RESOLVED_DETAIL_VISIBLE_CACHE_TTL_MS = 90_000;

function normalizeSemanticStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isClinicallyResolvedStatus(status: string): boolean {
  const normalized = normalizeSemanticStatus(status);
  return normalized === 'approved'
    || normalized === 'done'
    || normalized === 'rejected'
    || normalized === 'closed'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'archived'
    || normalized === 'completed'
    || normalized === 'expired';
}

function isTechnicalPendingStatus(processingStatus: string, pdfReady = false): boolean {
  const normalized = String(processingStatus || '').trim().toUpperCase();
  if (pdfReady || normalized === '') {
    return false;
  }

  return normalized !== 'DONE'
    && normalized !== 'FAILED'
    && normalized !== 'REJECTED'
    && normalized !== 'CANCELLED'
    && normalized !== 'CANCELED';
}

function isHistoryStatusQuery(status: string): boolean {
  const normalized = normalizeSemanticStatus(status);
  return normalized === 'approved'
    || normalized === 'done'
    || normalized === 'completed'
    || normalized === 'closed'
    || normalized === 'archived'
    || normalized === 'history'
    || normalized === 'historique'
    || normalized === 'treated'
    || normalized === 'rejected'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'expired';
}

function canonicalizeDoctorInboxStatus(status: string): string {
  const normalized = normalizeSemanticStatus(status);
  if (
    normalized === ''
    || normalized === 'active'
    || normalized === 'pending'
    || normalized === 'todo'
    || normalized === 'to_treat'
    || normalized === 'a_traiter'
  ) {
    return DOCTOR_ACTIVE_STATUS;
  }

  if (
    normalized === 'approved'
    || normalized === 'done'
    || normalized === 'completed'
    || normalized === 'closed'
    || normalized === 'archived'
    || normalized === 'history'
    || normalized === 'historique'
    || normalized === 'treated'
  ) {
    return DOCTOR_HISTORY_STATUS;
  }

  return normalized;
}

function normalizeDoctorInboxTrackedUrl(input: URL): URL {
  const output = stripDynamicSearchParams(input);
  const normalizedStatus = canonicalizeDoctorInboxStatus(output.searchParams.get('status') || '');
  if (normalizedStatus) {
    output.searchParams.set('status', normalizedStatus);
  } else {
    output.searchParams.delete('status');
  }
  output.search = normalizeTrackedQuery(output);
  return output;
}

function normalizeTrackedQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (key === '_ts' || key === 'known_collection_hash' || key === 'known_state_hash') {
      return;
    }
    pairs.push([key, value]);
  });

  pairs.sort((left, right) => {
    if (left[0] === right[0]) {
      return left[1].localeCompare(right[1]);
    }
    return left[0].localeCompare(right[0]);
  });

  if (pairs.length < 1) {
    return '';
  }

  return `?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

function stripDynamicSearchParams(input: URL): URL {
  const output = new URL(input.toString());
  output.search = normalizeTrackedQuery(output);
  return output;
}

function classifyTrackedRequest(requestUrl: string, restBase: string, scope: string): TrackedRequest | null {
  if (scope !== 'sosprescription_admin' || !requestUrl || !restBase) {
    return null;
  }

  try {
    const absoluteRequestUrl = new URL(absolutizeUrl(requestUrl));
    const absoluteRestBase = new URL(absolutizeUrl(restBase));
    if (!absoluteRequestUrl.toString().startsWith(absoluteRestBase.toString())) {
      return null;
    }

    const relativePathRaw = absoluteRequestUrl.pathname.startsWith(absoluteRestBase.pathname)
      ? absoluteRequestUrl.pathname.slice(absoluteRestBase.pathname.length)
      : '';
    const relativePath = relativePathRaw.startsWith('/') ? relativePathRaw : `/${relativePathRaw}`;

    if (relativePath === '/prescriptions') {
      const trackedRequestUrl = normalizeDoctorInboxTrackedUrl(absoluteRequestUrl);
      const trackedStatus = normalizeSemanticStatus(trackedRequestUrl.searchParams.get('status') || '');
      return {
        key: `doctor_inbox:${trackedRequestUrl.pathname}${trackedRequestUrl.search}`,
        kind: 'doctor_inbox',
        networkUrl: trackedRequestUrl.toString(),
        hashParam: 'known_collection_hash',
        historyQuery: isHistoryStatusQuery(trackedStatus),
      };
    }

    if (/^\/prescriptions\/\d+$/.test(relativePath)) {
      const strippedRequestUrl = stripDynamicSearchParams(absoluteRequestUrl);
      return {
        key: `doctor_prescription:${strippedRequestUrl.pathname}${strippedRequestUrl.search}`,
        kind: 'doctor_prescription',
        networkUrl: strippedRequestUrl.toString(),
        hashParam: 'known_state_hash',
        historyQuery: false,
      };
    }
  } catch {
    // Ignore malformed URLs and fallback to native fetch behavior.
  }

  return null;
}

function getTrackedHash(entry: SmartPulseCacheEntry | undefined, tracked: TrackedRequest): string | undefined {
  if (!entry) {
    return undefined;
  }

  return tracked.kind === 'doctor_inbox' ? entry.collectionHash : entry.stateHash;
}

function buildTrackedRequestInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  tracked: TrackedRequest,
  nonce: string,
  scope: string,
  knownHash?: string,
): { url: string; init: RequestInit } {
  const headers = new Headers();
  const sourceRequest = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  if (sourceRequest) {
    applyHeaders(headers, sourceRequest.headers);
  }
  applyHeaders(headers, init?.headers);
  headers.set('X-Sos-Scope', scope);
  if (nonce) {
    headers.set('X-WP-Nonce', nonce);
  }

  const url = new URL(tracked.networkUrl);
  if (knownHash) {
    url.searchParams.set(tracked.hashParam, knownHash);
  }

  return {
    url: url.toString(),
    init: {
      ...init,
      method: 'GET',
      headers,
      credentials: init?.credentials ?? sourceRequest?.credentials ?? 'same-origin',
      cache: 'no-store',
      signal: init?.signal ?? sourceRequest?.signal,
    },
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function buildResponseFromCache(entry: SmartPulseCacheEntry, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers(entry.headers);
  if (extraHeaders) {
    Object.entries(extraHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }

  return new Response(entry.bodyText, {
    status: entry.status,
    headers,
  });
}

function readPayloadObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractTrackedSemantics(tracked: TrackedRequest, payload: unknown): TrackedEntrySemantics {
  if (tracked.kind !== 'doctor_prescription') {
    return {
      historyQuery: tracked.historyQuery,
      clinicalResolved: false,
      technicalPending: false,
    };
  }

  const root = readPayloadObject(payload);
  const worker = readPayloadObject(root?.worker);
  const pdf = readPayloadObject(root?.pdf);
  const statusValue = normalizeSemanticStatus(root?.status ?? worker?.status ?? '');
  const processingStatus = String(root?.processing_status ?? worker?.processing_status ?? '').trim().toUpperCase();
  const pdfReady = Boolean(root?.pdf_ready)
    || Boolean(pdf && (
      normalizeSemanticStatus(pdf.status) === 'done'
      || pdf.can_download === true
      || (typeof pdf.download_url === 'string' && pdf.download_url.trim() !== '')
    ));
  const clinicalResolved = isClinicallyResolvedStatus(statusValue);
  const technicalPending = (statusValue === 'approved' || statusValue === 'done')
    && isTechnicalPendingStatus(processingStatus, pdfReady);

  return {
    historyQuery: tracked.historyQuery || clinicalResolved,
    statusValue: statusValue || undefined,
    processingStatus: processingStatus || undefined,
    clinicalResolved,
    technicalPending,
  };
}

function extractTrackedPrescriptionId(requestUrl: string): string {
  try {
    const parsed = new URL(absolutizeUrl(requestUrl));
    const match = parsed.pathname.match(/\/prescriptions\/(\d+)(?:\/)?$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function syncDoctorMessagingHostFromTrackedEntry(entry: SmartPulseCacheEntry): void {
  if (entry.kind !== 'doctor_prescription' || typeof document === 'undefined') {
    return;
  }

  const prescriptionId = extractTrackedPrescriptionId(entry.requestUrl);
  if (!prescriptionId) {
    return;
  }

  const host = document.querySelector(`[data-sp-doctor-chat-root="1"][data-prescription-id="${prescriptionId}"]`);
  if (!(host instanceof HTMLElement)) {
    return;
  }

  if (entry.statusValue) {
    host.dataset.prescriptionStatus = entry.statusValue;
  }
  if (entry.processingStatus) {
    host.dataset.prescriptionProcessingStatus = entry.processingStatus;
  }
}

function shouldServeTrackedCacheWhileHidden(entry: SmartPulseCacheEntry): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.hidden && (entry.stable || entry.historyQuery || Boolean(entry.clinicalResolved));
}

function shouldServeTrackedCacheWhileVisible(entry: SmartPulseCacheEntry): boolean {
  if (typeof document === 'undefined' || document.hidden) {
    return false;
  }

  const age = Date.now() - entry.lastNetworkAt;
  if (entry.kind === 'doctor_inbox' && entry.historyQuery) {
    return age < HISTORY_VISIBLE_CACHE_TTL_MS;
  }

  if (entry.kind === 'doctor_prescription' && entry.clinicalResolved) {
    return age < RESOLVED_DETAIL_VISIBLE_CACHE_TTL_MS;
  }

  return false;
}

function updateTrackedCache(
  state: FetchPatchState,
  tracked: TrackedRequest,
  response: Response,
  bodyText: string,
  payload: unknown,
): SmartPulseCacheEntry | undefined {
  const cache = ensureSmartPulseState(state).smartPulseCache;
  const previous = cache.get(tracked.key);
  const unchangedHeader = response.headers.get('X-SOSPrescription-Unchanged');
  const unchangedBody = payload && typeof payload === 'object' && 'unchanged' in (payload as { unchanged?: unknown })
    ? Boolean((payload as { unchanged?: unknown }).unchanged)
    : false;
  const unchanged = unchangedHeader === '1' || unchangedBody;
  const collectionHash = normalizeHash(response.headers.get('X-SOSPrescription-Collection-Hash') || '');
  const stateHash = normalizeHash(response.headers.get('X-SOSPrescription-State-Hash') || '');
  const nextHash = tracked.kind === 'doctor_inbox' ? collectionHash : stateHash;
  const previousHash = previous ? getTrackedHash(previous, tracked) : undefined;
  const sameHash = Boolean(nextHash && previousHash && nextHash === previousHash);
  const nextSemantics = extractTrackedSemantics(tracked, payload);
  const detailSemanticsAvailable = tracked.kind === 'doctor_prescription'
    && (typeof nextSemantics.statusValue === 'string' || typeof nextSemantics.processingStatus === 'string');

  if (unchanged) {
    if (!previous) {
      return undefined;
    }

    const replayEntry: SmartPulseCacheEntry = {
      ...previous,
      collectionHash: collectionHash || previous.collectionHash,
      stateHash: stateHash || previous.stateHash,
      lastNetworkAt: Date.now(),
      stableCount: previous.stableCount + 1,
      stable: true,
      historyQuery: nextSemantics.historyQuery || previous.historyQuery,
      statusValue: detailSemanticsAvailable ? nextSemantics.statusValue : previous.statusValue,
      processingStatus: detailSemanticsAvailable ? nextSemantics.processingStatus : previous.processingStatus,
      clinicalResolved: detailSemanticsAvailable ? nextSemantics.clinicalResolved : previous.clinicalResolved,
      technicalPending: detailSemanticsAvailable ? nextSemantics.technicalPending : previous.technicalPending,
      headers: {
        ...previous.headers,
        ...headersToObject(response.headers),
      },
    };
    cache.set(tracked.key, replayEntry);
    return replayEntry;
  }

  const stableCount = sameHash && previous ? previous.stableCount + 1 : 0;
  const nextEntry: SmartPulseCacheEntry = {
    key: tracked.key,
    kind: tracked.kind,
    requestUrl: tracked.networkUrl,
    bodyText,
    status: response.status,
    headers: headersToObject(response.headers),
    collectionHash: tracked.kind === 'doctor_inbox' ? collectionHash : undefined,
    stateHash: tracked.kind === 'doctor_prescription' ? stateHash : undefined,
    lastNetworkAt: Date.now(),
    stableCount,
    stable: stableCount >= 1,
    historyQuery: nextSemantics.historyQuery,
    statusValue: nextSemantics.statusValue,
    processingStatus: nextSemantics.processingStatus,
    clinicalResolved: nextSemantics.clinicalResolved,
    technicalPending: nextSemantics.technicalPending,
  };

  cache.set(tracked.key, nextEntry);
  return nextEntry;
}

async function performTrackedNetworkFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  state: FetchPatchState,
  nonce: string,
  scope: string,
  tracked: TrackedRequest,
): Promise<Response> {
  const cache = ensureSmartPulseState(state).smartPulseCache;
  const cachedEntry = cache.get(tracked.key);
  const knownHash = getTrackedHash(cachedEntry, tracked);
  const request = buildTrackedRequestInit(input, init, tracked, nonce, scope, knownHash);
  const response = await state.originalFetch(request.url, request.init);
  const bodyText = await response.clone().text();
  const payload = parsePayloadFromText(bodyText);
  const updatedEntry = updateTrackedCache(state, tracked, response, bodyText, payload);
  if (updatedEntry) {
    syncDoctorMessagingHostFromTrackedEntry(updatedEntry);
  }

  if (response.status >= 400) {
    await logRejectedResponse(request.url, response);
  }

  const unchangedHeader = response.headers.get('X-SOSPrescription-Unchanged');
  const unchangedBody = payload && typeof payload === 'object' && 'unchanged' in (payload as { unchanged?: unknown })
    ? Boolean((payload as { unchanged?: unknown }).unchanged)
    : false;
  const unchanged = unchangedHeader === '1' || unchangedBody;

  if (unchanged && updatedEntry) {
    return buildResponseFromCache(updatedEntry, {
      'X-SOSPrescription-Cache-Replay': '1',
      'X-SOSPrescription-Unchanged': '1',
    });
  }

  return response;
}

async function prefetchVisibleTrackedEndpoints(state: FetchPatchState): Promise<void> {
  const smartState = ensureSmartPulseState(state);
  if (typeof document === 'undefined' || document.hidden || smartState.smartPulseVisiblePrefetchInFlight) {
    return;
  }

  const now = Date.now();
  if (now - smartState.smartPulseWakeAt < 1500) {
    return;
  }

  state.smartPulseWakeAt = now;
  state.smartPulseVisiblePrefetchInFlight = true;

  try {
    const cfg = getConfigOrNull();
    const nonce = typeof cfg?.nonce === 'string' ? cfg.nonce : '';
    const entries = Array.from(smartState.smartPulseCache.values());

    for (const entry of entries) {
      const tracked: TrackedRequest = {
        key: entry.key,
        kind: entry.kind,
        networkUrl: entry.requestUrl,
        hashParam: entry.kind === 'doctor_inbox' ? 'known_collection_hash' : 'known_state_hash',
        historyQuery: entry.historyQuery,
      };

      try {
        await performTrackedNetworkFetch(entry.requestUrl, { method: 'GET', credentials: 'same-origin' }, state, nonce, 'sosprescription_admin', tracked);
      } catch {
        // Best effort wake-up refresh.
      }
    }

    try {
      window.dispatchEvent(new CustomEvent('sosprescription:doctor-pulse-wakeup'));
    } catch {
      // Ignore dispatch failures.
    }
  } finally {
    state.smartPulseVisiblePrefetchInFlight = false;
  }
}

function installSmartPulseListeners(state: FetchPatchState): void {
  const smartState = ensureSmartPulseState(state);
  if (smartState.smartPulseListenersInstalled || typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const wakeUp = (): void => {
    void prefetchVisibleTrackedEndpoints(state);
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && !document.hidden) {
      wakeUp();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', wakeUp);
  state.smartPulseListenersInstalled = true;
}

function installFetchPatch(): void {
  const g = getGlobalWindow();
  if (typeof g.fetch !== 'function') {
    return;
  }

  const existingState = g.__SosPrescriptionFetchPatch;
  if (existingState && existingState.installed && typeof existingState.originalFetch === 'function') {
    ensureSmartPulseState(existingState);
    installSmartPulseListeners(existingState);
    return;
  }

  const state: FetchPatchState = {
    originalFetch: g.fetch.bind(g),
    installed: true,
  };

  g.__SosPrescriptionFetchPatch = state;
  ensureSmartPulseState(state);
  installSmartPulseListeners(state);

  const patchedFetch: typeof fetch = async (input, init) => {
    const activeWindow = getGlobalWindow();
    const activeState = activeWindow.__SosPrescriptionFetchPatch || state;
    ensureSmartPulseState(activeState);

    try {
      const activeConfig = getConfigOrNull();
      const activeRestBase = normalizeRestBase(activeConfig?.restBase);
      const activeNonce = typeof activeConfig?.nonce === 'string' ? activeConfig.nonce : '';
      const requestUrl = resolveFetchUrl(input);
      const scope = detectScope();
      const isTargetRequest = Boolean(requestUrl && activeRestBase && isTargetRestUrl(requestUrl, activeRestBase));

      if (!isTargetRequest) {
        return activeState.originalFetch(input, init);
      }

      const tracked = classifyTrackedRequest(requestUrl, activeRestBase, scope);
      if (tracked) {
        const cache = ensureSmartPulseState(activeState).smartPulseCache;
        const cachedEntry = cache.get(tracked.key);

        if (cachedEntry && shouldServeTrackedCacheWhileHidden(cachedEntry)) {
          syncDoctorMessagingHostFromTrackedEntry(cachedEntry);
          return buildResponseFromCache(cachedEntry, {
            'X-SOSPrescription-Cache-Replay': '1',
            'X-SOSPrescription-Hidden-Suppressed': '1',
          });
        }

        if (cachedEntry && shouldServeTrackedCacheWhileVisible(cachedEntry)) {
          syncDoctorMessagingHostFromTrackedEntry(cachedEntry);
          return buildResponseFromCache(cachedEntry, {
            'X-SOSPrescription-Cache-Replay': '1',
            'X-SOSPrescription-Visible-Semantic-Suppressed': '1',
          });
        }

        try {
          return await performTrackedNetworkFetch(input, init, activeState, activeNonce, scope, tracked);
        } catch (error) {
          if (cachedEntry) {
            syncDoctorMessagingHostFromTrackedEntry(cachedEntry);
            return buildResponseFromCache(cachedEntry, {
              'X-SOSPrescription-Cache-Replay': '1',
              'X-SOSPrescription-Network-Fallback': '1',
            });
          }
          throw error;
        }
      }

      const headers = new Headers();
      if (typeof Request !== 'undefined' && input instanceof Request) {
        applyHeaders(headers, input.headers);
      }
      applyHeaders(headers, init?.headers);
      headers.set('X-Sos-Scope', scope);
      if (activeNonce) {
        headers.set('X-WP-Nonce', activeNonce);
      }

      const nextInit: RequestInit = {
        ...init,
        headers,
      };

      const response = typeof Request !== 'undefined' && input instanceof Request
        ? await activeState.originalFetch(new Request(input, nextInit))
        : await activeState.originalFetch(input, nextInit);

      if (response.status >= 400) {
        await logRejectedResponse(requestUrl, response);
      }

      return response;
    } catch (error) {
      const requestUrl = resolveFetchUrl(input);
      safeConsoleError(`[FetchPatch] Erreur réseau sur l'URL ${requestUrl || '(inconnue)'}`, {
        url: requestUrl || '(inconnue)',
        error,
      });
      throw error;
    }
  };

  g.fetch = patchedFetch;
}

try {
  installFetchPatch();
} catch {
  // Fail-closed: if the environment forbids patching fetch, keep native fetch untouched.
}
