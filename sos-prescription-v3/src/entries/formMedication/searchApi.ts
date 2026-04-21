type AppConfig = {
  restBase: string;
  restV4Base?: string;
  nonce: string;
};

type FormWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
};

function getConfigOrThrow(): AppConfig {
  const formWindow = window as FormWindow;
  const cfg = (typeof window !== 'undefined' ? (formWindow.SosPrescription || formWindow.SOSPrescription) : null) || null;
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    throw new Error('Configuration SosPrescription introuvable (window.SosPrescription / window.SOSPrescription).');
  }
  return cfg;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // Keep raw text when JSON parsing fails.
  }
  return data;
}

async function v4PublicApi(path: string, init: RequestInit = {}, scope: 'form' | 'patient' | 'admin' = 'form'): Promise<unknown> {
  const cfg = getConfigOrThrow();
  const fallbackBase = String(cfg.restBase || '').replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').trim();
  const restV4Base = typeof cfg.restV4Base === 'string' && cfg.restV4Base.trim() ? cfg.restV4Base.trim() : fallbackBase;
  if (!restV4Base) {
    throw new Error('Configuration REST V4 absente.');
  }

  const method = String(init.method || 'GET').toUpperCase();
  let url = restV4Base.replace(/\/$/, '') + path;

  if (method === 'GET') {
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set('_ts', String(Date.now()));
      url = parsed.toString();
    } catch {
      url += (url.includes('?') ? '&' : '?') + '_ts=' + String(Date.now());
    }
  }

  const headers = new Headers(init.headers || undefined);
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    credentials: 'omit',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message?: string }).message)
      : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
        ? String((data as { code?: string }).code)
        : 'Erreur API';
    throw new Error(message);
  }

  return data;
}

export async function searchMedicationsApi(query: string, limit = 20): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return v4PublicApi(`/medications/search?${params.toString()}`, { method: 'GET' }, 'form');
}
