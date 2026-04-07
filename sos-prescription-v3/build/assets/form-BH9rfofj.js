import { j as e, r as c, s as Xe, S as V, B as D, A as F, T as Ne, g as we, c as Ze, a as et, b as tt, d as st, u as ze, e as rt, o as nt, l as at, f as it, h as lt, i as ot, k as ct, R as dt } from "./Textarea-DlpwElDt.js";

async function mtReadApi(t, s) {
    const n = we(), l = n.restBase.replace(/\/$/, "") + `/prescriptions/${t}/messages/read`;
    const u = await fetch(l, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-WP-Nonce": n.nonce,
            "X-Sos-Scope": "patient"
        },
        credentials: "same-origin",
        body: JSON.stringify({
            read_upto_seq: s
        })
    });
    const g = await u.text();
    let a = g;
    try {
        a = g ? JSON.parse(g) : null;
    } catch {}
    if (!u.ok) {
        const x = a && typeof a.message == "string" ? a.message : "Erreur messagerie";
        throw new Error(x);
    }
    return a;
}

async function artifactAccessApi(t, s, n = "attachment") {
    const l = we(), u = l.restBase.replace(/\/$/, "") + `/artifacts/${encodeURIComponent(t)}/access`;
    const g = await fetch(u, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-WP-Nonce": l.nonce,
            "X-Sos-Scope": "patient"
        },
        credentials: "same-origin",
        body: JSON.stringify({
            prescription_id: s,
            disposition: n
        })
    });
    const a = await g.text();
    let x = a;
    try {
        x = a ? JSON.parse(a) : null;
    } catch {}
    if (!g.ok) {
        const o = x && typeof x.message == "string" ? x.message : "Accès au document impossible.";
        throw new Error(o);
    }
    return x;
}

async function artifactAnalyzeApi(t) {
    const s = String(t ?? "").trim();
    if (!s) throw new Error("Identifiant d’artefact manquant.");
    const n = we(), l = n.restBase.replace(/\/$/, "") + `/artifacts/${encodeURIComponent(s)}/analyze`, u = typeof AbortController != "undefined" ? new AbortController : null, g = u ? window.setTimeout((() => {
        try {
            u.abort();
        } catch {}
    }), 45e3) : 0;
    try {
        const a = await fetch(l, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-WP-Nonce": n.nonce,
                "X-Sos-Scope": "form"
            },
            credentials: "same-origin",
            signal: u ? u.signal : void 0
        }), x = await a.text();
        let o = x;
        try {
            o = x ? JSON.parse(x) : null;
        } catch {}
        if (!a.ok) {
            const b = o && typeof o.message == "string" ? o.message : o && typeof o.code == "string" ? o.code : "Analyse IA impossible.";
            throw new Error(b);
        }
        return o && o.analysis ? o.analysis : o;
    } catch (a) {
        if (a && typeof a == "object" && a.name === "AbortError") throw new Error("L'analyse automatique du document a expiré. Veuillez réessayer ou fournir un document plus net.");
        throw a;
    } finally {
        g && window.clearTimeout(g);
    }
}

async function spDirectArtifactUpload(t, s, n) {
    const l = String(s || "").toLowerCase(), u = l === "message" || l === "message_attachment" || l === "attachment" || l === "compose" ? "MESSAGE_ATTACHMENT" : "PROOF", g = {
        purpose: u === "PROOF" ? "evidence" : "message",
        kind: u,
        original_name: t && t.name ? String(t.name) : "upload.bin",
        mime_type: t && t.type ? String(t.type) : "application/octet-stream",
        size_bytes: t && typeof t.size == "number" ? t.size : 0
    };
    n && n > 0 && (g.prescription_id = Number(n));
    const a = we(), x = a.restBase.replace(/\/$/, "") + "/artifacts/init", o = await fetch(x, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-WP-Nonce": a.nonce,
            "X-Sos-Scope": "form"
        },
        credentials: "same-origin",
        body: JSON.stringify(g)
    }), b = await o.text();
    let v = b;
    try {
        v = b ? JSON.parse(b) : null;
    } catch {}
    if (!o.ok) {
        const M = v && typeof v.message == "string" ? v.message : v && typeof v.code == "string" ? v.code : "Préparation d’upload impossible.";
        throw new Error(M);
    }
    const C = v && v.upload ? v.upload : null;
    if (!C || !C.url) throw new Error("Ticket d’upload invalide");
    const h = {};
    C.headers && typeof C.headers == "object" && Object.keys(C.headers).forEach((M => {
        h[M] = String(C.headers[M]);
    })), h["Content-Type"] || (h["Content-Type"] = g.mime_type);
    const _ = await fetch(String(C.url), {
        method: String(C.method || "PUT").toUpperCase(),
        headers: h,
        body: t,
        mode: "cors",
        credentials: "omit"
    }), N = await _.text();
    let i = N;
    try {
        i = N ? JSON.parse(N) : null;
    } catch {}
    if (!_.ok) {
        const M = i && typeof i.message == "string" ? i.message : i && typeof i.code == "string" ? i.code : "Erreur upload";
        throw new Error(M);
    }
    const S = i && i.artifact ? i.artifact : null;
    if (!S || !S.id) throw new Error("Réponse artefact incomplète");
    return {
        id: String(S.id),
        original_name: S.original_name || g.original_name,
        purpose: g.purpose,
        mime: S.mime_type || g.mime_type,
        mime_type: S.mime_type || g.mime_type,
        size_bytes: typeof S.size_bytes == "number" ? S.size_bytes : g.size_bytes,
        kind: S.kind || u,
        status: S.status || "READY"
    };
}

async function spV4Api(t, s = {}, n = "form") {
  const l = we(), u = typeof (l == null ? void 0 : l.restV4Base) == "string" && l.restV4Base.trim() ? l.restV4Base.trim() : String((l == null ? void 0 : l.restBase) || "").replace(/\/sosprescription\/v1\/?$/, "/sosprescription/v4").trim();
  if (!u) throw new Error("Configuration REST V4 absente.");
  const g = u.replace(/\/$/, "") + t;
  const a = String((s == null ? void 0 : s.method) || "GET").toUpperCase();
  const x = {
    ...(s == null ? void 0 : s.headers) || {},
    "X-WP-Nonce": l.nonce
  };
  n && (x["X-Sos-Scope"] = n), a === "GET" && (x["Cache-Control"] = "no-cache, no-store, must-revalidate", 
  x.Pragma = "no-cache");
  const o = await fetch(g, {
    ...s,
    method: a,
    headers: x,
    credentials: "same-origin",
    cache: a === "GET" ? "no-store" : s == null ? void 0 : s.cache
  }), b = await o.text();
  let v = b;
  try {
    v = b ? JSON.parse(b) : null;
  } catch {}
  if (!o.ok) {
    const M = v && typeof v.message == "string" ? v.message : v && typeof v.code == "string" ? v.code : "Erreur API";
    throw new Error(M);
  }
  return v;
}

async function spCreateSubmissionApi(t) {
  return spV4Api("/form/submissions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(t)
  }, "form");
}

async function spSubmissionArtifactInitApi(t, s) {
  const n = String(t || "").trim();
  if (!n) throw new Error("Référence de soumission manquante.");
  return spV4Api(`/form/submissions/${encodeURIComponent(n)}/artifacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(s)
  }, "form");
}

async function spDirectSubmissionArtifactUpload(t, s, n = "PROOF") {
  const l = {
    kind: n,
    original_name: t && t.name ? String(t.name) : "upload.bin",
    mime_type: t && t.type ? String(t.type) : "application/octet-stream",
    size_bytes: t && typeof t.size == "number" ? t.size : 0
  }, u = await spSubmissionArtifactInitApi(s, l), g = u && u.upload ? u.upload : null;
  if (!g || !g.url) throw new Error("Ticket d’upload invalide");
  const a = {};
  g.headers && typeof g.headers == "object" && Object.keys(g.headers).forEach((b => {
    a[b] = String(g.headers[b]);
  })), a["Content-Type"] || (a["Content-Type"] = l.mime_type);
  const x = await fetch(String(g.url), {
    method: String(g.method || "PUT").toUpperCase(),
    headers: a,
    body: t,
    mode: "cors",
    credentials: "omit"
  }), o = await x.text();
  let b = o;
  try {
    b = o ? JSON.parse(o) : null;
  } catch {}
  if (!x.ok) {
    const v = b && typeof b.message == "string" ? b.message : b && typeof b.code == "string" ? b.code : "Erreur upload";
    throw new Error(v);
  }
  const v = b && b.artifact ? b.artifact : null;
  if (!v || !v.id) throw new Error("Réponse artefact incomplète");
  return {
    id: String(v.id),
    original_name: v.original_name || l.original_name,
    purpose: "evidence",
    mime: v.mime_type || l.mime_type,
    mime_type: v.mime_type || l.mime_type,
    size_bytes: typeof v.size_bytes == "number" ? v.size_bytes : l.size_bytes,
    kind: v.kind || n,
    status: v.status || "READY"
  };
}

async function spFinalizeSubmissionApi(t, s) {
  const n = String(t || "").trim();
  if (!n) throw new Error("Référence de soumission manquante.");
  return spV4Api(`/form/submissions/${encodeURIComponent(n)}/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(s)
  }, "form");
}

function spPatientChatUidFromLocation() {
    if (typeof window == "undefined") return "";
    try {
        const t = new URL(window.location.href).searchParams.get("rx_uid");
        return typeof t == "string" ? t.trim() : "";
    } catch {
        return "";
    }
}

function spSyncPatientChatLocation(t) {
    if (typeof window == "undefined" || !window.history || typeof window.history.replaceState != "function") return;
    try {
        const s = new URL(window.location.href), n = String(t || "").trim();
        n ? s.searchParams.set("rx_uid", n) : s.searchParams.delete("rx_uid"), s.searchParams.delete("rx");
        const l = s.toString();
        l !== window.location.href && window.history.replaceState(window.history.state, "", l);
    } catch {}
}

function spDispatchPatientChatRefresh(t = {}) {
    if (typeof window == "undefined") return;
    try {
        window.dispatchEvent(new CustomEvent("sp:patient-chat-refresh", {
            detail: t
        }));
    } catch {}
}

function spFrontendLog(t, s = "info", n = {}) {
    try {
        if (typeof window != "undefined" && typeof window.__SosPrescriptionSendLog == "function") {
            window.__SosPrescriptionSendLog(t, s, n || {});
            return;
        }
    } catch {}
    try {
        const l = we(), u = String((l == null ? void 0 : l.restBase) || "").replace(/\/$/, ""), g = String((l == null ? void 0 : l.nonce) || "");
        if (!u || !g || !window.fetch) return;
        window.fetch(u + "/logs/frontend", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-WP-Nonce": g
            },
            body: JSON.stringify({
                shortcode: "sosprescription_form",
                event: t,
                level: s || "info",
                meta: n || {}
            }),
            keepalive: !0
        }).catch((() => {}));
    } catch {}
}

function spResolveFlowFromUrl() {
    try {
        const t = new URLSearchParams(window.location.search).get("type"), s = String(t || "").trim().toLowerCase();
        return s === "renouvellement" || s === "renewal" || s === "ro_proof" ? "ro_proof" : s === "depannage-sos" || s === "depannage_no_proof" || s === "depannage" || s === "sos" ? "depannage_no_proof" : null;
    } catch {
        return null;
    }
}

function spBuildSubmitBlockInfo(t) {
    const s = [];
    if (!t.loggedIn) s.push({
        code: "auth_missing",
        message: "Vous devez être connecté pour soumettre une demande."
    });
    const n = String(t.flow || "").trim(), l = spSafePatientNameValue(t.fullname), u = spSplitPatientNameValue(l), g = String(t.birthdate || "").trim(), a = Number(t.itemsCount || 0), x = Number(t.filesCount || 0);
    !n && s.push({
        code: "flow_missing",
        message: "Merci de choisir un parcours avant de soumettre votre demande."
    }), (l.length < 3 || u.firstName === "" || u.lastName === "") && s.push({
        code: "patient_name_invalid",
        message: "Merci de saisir le prénom et le nom du patient."
    }), !g ? s.push({
        code: "birthdate_missing",
        message: "Merci de renseigner la date de naissance du patient."
    }) : yt(g) || s.push({
        code: "birthdate_invalid",
        message: "Merci de renseigner une date de naissance valide au format JJ/MM/AAAA."
    }), n === "ro_proof" && x < 1 && s.push({
        code: "proof_missing",
        message: "Merci d'ajouter au moins un document justificatif à analyser."
    }), n === "depannage_no_proof" && a < 1 && s.push({
        code: "medication_missing",
        message: "Merci d'ajouter au moins un médicament."
    }), n === "depannage_no_proof" && !t.attestationNoProof && s.push({
        code: "attestation_missing",
        message: "Merci de confirmer l'attestation de dépannage sans preuve."
    });
    if (t.consentRequired) {
        const o = [];
        t.consentTelemedicine || o.push("téléconsultation"), t.consentTruth || o.push("attestation sur l'honneur"), 
        t.consentCgu || o.push("CGU"), t.consentPrivacy || o.push("politique de confidentialité"), 
        o.length > 0 && s.push({
            code: "consent_missing",
            message: "Merci de valider les consentements requis : " + o.join(", ") + "."
        });
    }
    return t.analysisInProgress && s.push({
        code: "analysis_in_progress",
        message: "Veuillez patienter pendant l'analyse du document."
    }), {
        ok: s.length === 0,
        reasons: s,
        code: s.length > 0 ? s[0].code : null,
        message: s.length > 0 ? s[0].message : null
    };
}

function spAiSafeText(t) {
    return String(t || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function spAiNormalizeTime(t) {
    const s = spAiSafeText(t).replace(/h/i, ":").replace(/[^0-9:]/g, "");
    if (!s) return null;
    const n = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!n) return null;
    const l = Math.max(0, Math.min(23, parseInt(n[1], 10) || 0)), u = Math.max(0, Math.min(59, parseInt(n[2], 10) || 0));
    return `${String(l).padStart(2, "0")}:${String(u).padStart(2, "0")}`;
}

function spAiBuildScheduleFromText(t) {
    const s = spAiSafeText(t);
    if (!s) return ut({});
    let n = 1, l = "jour", u = 5, g = "jour";
    const a = s.match(/(\d+)\s*(?:fois?|prises?)\s*(?:par\s*|\/\s*)(jour|jours|semaine|semaines)/i) || s.match(/(\d+)\s*fois?\s*par\s*(jour|jours|semaine|semaines)/i);
    a && (n = se(a[1], 1, /sem/i.test(a[2]) ? 12 : 6, 1), l = /sem/i.test(a[2]) ? "semaine" : "jour");
    const x = s.match(/(?:pendant|durant|sur)\s*(\d+)\s*(jour|jours|mois|semaine|semaines)/i);
    x && (u = se(x[1], 1, 3650, 5), g = /mois/i.test(x[2]) ? "mois" : /sem/i.test(x[2]) ? "semaine" : "jour");
    const o = [], b = [], v = /([0-9]+(?:[.,][0-9]+)?)\s*@\s*([01]?\d[:h][0-5]\d)/gi;
    let M = null;
    for (;M = v.exec(s); ) {
        const C = spAiNormalizeTime(M[2]);
        C && (o.push(C), b.push(String(M[1]).replace(",", ".")));
    }
    if (o.length === 0) {
        const C = /([01]?\d|2[0-3])[:h]([0-5]\d)/g;
        let h = null;
        for (;h = C.exec(s); ) {
            const _ = spAiNormalizeTime(`${h[1]}:${h[2]}`);
            _ && o.push(_);
        }
        o.length > 0 && (n = Math.max(n, o.length));
    } else n = Math.max(n, o.length);
    const C = ut({
        nb: n,
        freqUnit: l,
        durationVal: u,
        durationUnit: g,
        autoTimesEnabled: o.length < 1,
        times: o.length > 0 ? o : void 0,
        doses: b.length > 0 ? b : void 0,
        start: o[0] || "08:00",
        end: o[o.length - 1] || "20:00",
        rounding: 5,
        note: ""
    });
    if (o.length > 0) {
        const h = H(o, n, o[o.length - 1] || o[0] || "08:00"), _ = b.length > 0 ? H(b, n, b[b.length - 1] || "1") : H([], n, "1");
        return {
            ...C,
            autoTimesEnabled: !1,
            start: h[0] || "08:00",
            end: h[h.length - 1] || h[0] || "20:00",
            times: h,
            doses: _
        };
    }
    return C;
}

function spAiMedicationsToItems(t) {
    return Array.isArray(t) ? t.map((s => {
        const n = spAiSafeText(s && s.label), l = spAiSafeText(s && s.scheduleText);
        return n ? {
            label: n,
            schedule: spAiBuildScheduleFromText(l)
        } : null;
    })).filter(Boolean) : [];
}

function spAiMergeMedicationItems(t, s) {
    const n = Array.isArray(t) ? t.slice() : [], l = new Set(n.map((u => spAiSafeText(u && u.label).toLowerCase())).filter(Boolean));
    for (const u of Array.isArray(s) ? s : []) {
        const g = spAiSafeText(u && u.label);
        if (!g) continue;
        const a = g.toLowerCase();
        l.has(a) || (l.add(a), n.push(u));
    }
    return n;
}

function Z({className: t = "", ...s}) {
    return e.jsx("input", {
        className: `w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 ${t}`,
        ...s
    });
}

function mt({onSelect: t, disabled: s = !1, disabledHint: n = "Connectez-vous pour rechercher des médicaments."}) {
    const [l, u] = c.useState(""), [g, a] = c.useState([]), [x, o] = c.useState(!1), [b, v] = c.useState(null), [M, C] = c.useState(!1), h = c.useRef(null), _ = c.useMemo((() => l.trim().length >= 2), [ l ]), N = c.useMemo((() => g.some((i => (i == null ? void 0 : i.is_selectable) === !1))), [ g ]);
    return c.useEffect((() => {
        var q;
        if (s) {
            a([]), C(!1), o(!1), v(null);
            return;
        }
        if (!_) {
            a([]), C(!1), v(null);
            return;
        }
        const i = l.trim();
        o(!0), C(!0), (q = h.current) == null || q.abort();
        const S = new AbortController;
        h.current = S;
        const A = window.setTimeout((() => {
            Xe(i, 20).then((I => {
                S.signal.aborted || (v(null), a(I || []));
            })).catch((I => {
                S.signal.aborted || (a([]), v((I == null ? void 0 : I.message) || "Erreur lors de la recherche"));
            })).finally((() => {
                S.signal.aborted || o(!1);
            }));
        }), 200);
        return () => {
            window.clearTimeout(A), S.abort();
        };
    }), [ l, _, s ]), e.jsxs("div", {
        className: "relative",
        children: [ e.jsx(Z, {
            value: l,
            onChange: i => u(i.target.value),
            placeholder: s ? n : "Rechercher un médicament (nom, CIS, CIP7/13)…",
            onFocus: () => !s && l.trim().length >= 2 && C(!0),
            disabled: s
        }), M && e.jsxs("div", {
            className: "absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg",
            children: [ e.jsxs("div", {
                className: "flex items-center justify-between border-b border-gray-100 px-3 py-2 text-xs text-gray-600",
                children: [ e.jsx("span", {
                    children: "Résultats"
                }), x && e.jsx(V, {}) ]
            }), e.jsxs("div", {
                className: "max-h-64 overflow-auto",
                children: [ !x && b && e.jsx("div", {
                    className: "px-3 py-3 text-sm text-red-600",
                    children: b
                }), !x && !b && g.length === 0 && e.jsx("div", {
                    className: "px-3 py-3",
                    children: e.jsxs("div", {
                        className: "rounded-lg border border-gray-200 bg-gray-50 p-3",
                        children: [ e.jsx("div", {
                            className: "text-sm font-medium text-gray-900",
                            children: "Aucun résultat"
                        }), e.jsxs("div", {
                            className: "mt-1 text-xs text-gray-600",
                            children: [ "Si votre médicament n’apparaît pas, c’est souvent lié à :", e.jsxs("ul", {
                                className: "mt-2 list-disc space-y-1 pl-5",
                                children: [ e.jsx("li", {
                                    children: "une BDPM non importée / non prête"
                                }), e.jsx("li", {
                                    children: "une whitelist qui restreint le périmètre (médicaments grisés)"
                                }), e.jsx("li", {
                                    children: "une recherche trop courte (min. 2 caractères, ou CIS/CIP)"
                                }) ]
                            }) ]
                        }) ]
                    })
                }), g.map((i => {
                    const S = (i == null ? void 0 : i.is_selectable) !== !1, A = (i.cip13 || i.cis) + i.label;
                    return e.jsxs("button", {
                        type: "button",
                        disabled: !S,
                        className: S ? "block w-full px-3 py-2 text-left text-sm hover:bg-gray-50" : "block w-full cursor-not-allowed px-3 py-2 text-left text-sm opacity-60",
                        onClick: () => {
                            S && (t(i), u(""), a([]), C(!1));
                        },
                        children: [ e.jsxs("div", {
                            className: "flex items-center justify-between gap-3",
                            children: [ e.jsx("div", {
                                className: S ? "font-medium text-gray-900" : "font-medium text-gray-700",
                                children: i.label
                            }), !S && e.jsx("span", {
                                className: "shrink-0 text-xs text-gray-400",
                                children: "Non disponible en ligne"
                            }) ]
                        }), e.jsxs("div", {
                            className: S ? "mt-0.5 text-xs text-gray-600" : "mt-0.5 text-xs text-gray-500",
                            children: [ i.specialite, " • ", "CIS ", i.cis, i.cip13 ? ` • CIP13 ${i.cip13}` : "", i.tauxRemb ? ` • Remb. ${i.tauxRemb}` : "", typeof i.prixTTC == "number" ? ` • ${i.prixTTC.toFixed(2)}€` : "" ]
                        }) ]
                    }, A);
                })) ]
            }), e.jsx("div", {
                className: "border-t border-gray-100 px-3 py-2 text-xs text-gray-500",
                children: N ? "Les résultats grisés ne sont pas disponibles en ligne." : "Cliquez sur un résultat pour l’ajouter."
            }) ]
        }) ]
    });
}

function se(t, s, n, l) {
    const u = Number.parseInt(String(t ?? ""), 10);
    return Number.isNaN(u) ? l : Math.max(s, Math.min(n, u));
}

function qe(t) {
    return t < 10 ? `0${t}` : String(t);
}

function ie(t) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(t);
}

function Le(t) {
    if (!ie(t)) return null;
    const [s, n] = t.split(":");
    return Number.parseInt(s, 10) * 60 + Number.parseInt(n, 10);
}

function be(t) {
    let s = Math.round(t);
    Number.isFinite(s) || (s = 0), s = Math.max(0, Math.min(23 * 60 + 59, s));
    const n = Math.floor(s / 60), l = s % 60;
    return `${qe(n)}:${qe(l)}`;
}

function re(t, s) {
    const n = Math.max(1, Math.floor(s));
    return Math.round(t / n) * n;
}

function H(t, s, n) {
    const l = Array.isArray(t) ? t.map((u => String(u ?? ""))) : [];
    if (l.length > s) return l.slice(0, s);
    for (;l.length < s; ) l.push(n);
    return l;
}

function ve(t, s, n, l) {
    const u = [], g = se(l, 1, 60, 5), a = Le(s) ?? 8 * 60;
    let x = Le(n) ?? 20 * 60, o = a, b = x;
    b <= o && (b = Math.min(o + 60, 23 * 60 + 55), u.push("Fenêtre de prise invalide : heure de fin ajustée."));
    const v = b - o;
    if (t <= 1) {
        const i = be(re(o, g)), S = be(re(b, g));
        return {
            times: [ i ],
            start: i,
            end: S,
            warnings: u,
            collisionResolved: !1
        };
    }
    v < (t - 1) * g && u.push("Fenêtre trop courte pour répartir correctement."), o > 18 * 60 && t > 1 && u.push("Première prise tardive : prises rapprochées.");
    let M = !1;
    const C = v / (t - 1), h = [];
    for (let i = 0; i < t; i++) {
        let S = o + i * C;
        i === 0 && (S = o), i === t - 1 && (S = b);
        let A = re(S, g);
        A = Math.max(o, Math.min(b, A)), h.push(A);
    }
    for (let i = 1; i < t; i++) h[i] <= h[i - 1] && (M = !0, h[i] = h[i - 1] + g);
    if (h[t - 1] > b) {
        M = !0, h[t - 1] = re(b, g);
        for (let i = t - 2; i >= 0; i--) h[i] >= h[i + 1] && (h[i] = h[i + 1] - g);
        if (h[0] < o) {
            u.push("Horaires trop rapprochés : vérifier la posologie."), h[0] = re(o, g);
            for (let i = 1; i < t; i++) h[i] = Math.max(h[i], h[i - 1]);
        }
    }
    let _ = 1 / 0;
    for (let i = 1; i < t; i++) _ = Math.min(_, h[i] - h[i - 1]);
    t >= 4 && Number.isFinite(_) && _ < 60 && u.push("Horaires rapprochés : vérifier la posologie.");
    const N = h.map(be);
    return {
        times: N,
        start: N[0],
        end: N[N.length - 1],
        warnings: u,
        collisionResolved: M
    };
}

function ut(t) {
    const s = (t == null ? void 0 : t.freqUnit) === "semaine" ? "semaine" : "jour", n = s === "jour" ? 6 : 12, l = se(t == null ? void 0 : t.nb, 1, n, 1), u = se(t == null ? void 0 : t.durationVal, 1, 3650, 5), g = (t == null ? void 0 : t.durationUnit) === "mois" ? "mois" : "jour", a = se(t == null ? void 0 : t.rounding, 1, 60, 5), x = (t == null ? void 0 : t.autoTimesEnabled) !== !1, o = Array.isArray(t == null ? void 0 : t.times) ? t.times : [], b = Array.isArray(t == null ? void 0 : t.doses) ? t.doses : [], v = typeof (t == null ? void 0 : t.start) == "string" ? t.start : typeof o[0] == "string" ? o[0] : "08:00", M = typeof (t == null ? void 0 : t.end) == "string" ? t.end : typeof o[o.length - 1] == "string" ? o[o.length - 1] : "20:00", C = ie(v) ? v : "08:00", h = ie(M) ? M : "20:00";
    let _ = H(o, l, ""), N = H(b, l, "1");
    if (x && s === "jour") {
        const i = ve(l, C, h, a);
        return _ = i.times, {
            nb: l,
            freqUnit: s,
            durationVal: u,
            durationUnit: g,
            times: _,
            doses: N,
            note: "",
            autoTimesEnabled: !0,
            start: i.start,
            end: i.end,
            rounding: a
        };
    }
    return {
        nb: l,
        freqUnit: s,
        durationVal: u,
        durationUnit: g,
        times: _,
        doses: N,
        note: "",
        autoTimesEnabled: x && s === "jour",
        start: C,
        end: h,
        rounding: a
    };
}

function xt({value: t, onChange: s}) {
    const n = c.useMemo((() => ut(t)), [ t ]);
    c.useEffect((() => {
        const m = t;
        (m == null || typeof m != "object" || m.nb == null || m.freqUnit == null || m.durationVal == null || m.durationUnit == null || !Array.isArray(m.times) || !Array.isArray(m.doses) || m.start == null || m.end == null || m.rounding == null) && s(n);
    }), []);
    const l = n.nb, u = n.freqUnit, g = n.durationVal, a = n.durationUnit, x = n.rounding ?? 5, o = n.autoTimesEnabled !== !1 && u === "jour", b = n.start ?? "08:00", v = n.end ?? "20:00", M = c.useMemo((() => o ? ve(l, b, v, x) : null), [ o, l, b, v, x ]), C = o && M ? M.times : H(n.times, l, ""), h = H(n.doses, l, "1"), _ = o && M ? M.warnings : [], N = m => {
        s({
            ...n,
            ...m
        });
    }, i = (m, j, f) => {
        const P = ve(m.nb, j, f, m.rounding ?? 5);
        s({
            ...m,
            autoTimesEnabled: !0,
            start: P.start,
            end: P.end,
            times: P.times,
            doses: H(m.doses, m.nb, "1")
        });
    }, S = m => {
        const f = se(m, 1, u === "jour" ? 6 : 12, 1);
        if (o) {
            const E = {
                ...n,
                nb: f,
                rounding: x
            };
            i(E, b, v);
            return;
        }
        const P = H(n.times, f, ""), k = H(n.doses, f, "1");
        N({
            nb: f,
            times: P,
            doses: k
        });
    }, A = (m, j) => {
        const f = j;
        if (o) {
            if (m === 0) {
                const E = {
                    ...n,
                    start: f,
                    rounding: x
                };
                i(E, f, v);
                return;
            }
            if (m === l - 1 && l > 1) {
                const E = {
                    ...n,
                    end: f,
                    rounding: x
                };
                i(E, b, f);
                return;
            }
            const k = [ ...C ];
            k[m] = f, N({
                autoTimesEnabled: !1,
                times: k
            });
            return;
        }
        const P = H(n.times, l, "");
        P[m] = f, N({
            times: P
        });
    }, q = (m, j) => {
        const f = H(n.doses, l, "1");
        f[m] = j, N({
            doses: f
        });
    }, I = () => {
        if (!window.confirm("Réinitialiser les horaires recommandés ? Cela écrasera vos horaires personnalisés.")) return;
        const j = {
            ...n,
            autoTimesEnabled: !0,
            start: "08:00",
            end: "20:00",
            rounding: x
        };
        i(j, "08:00", "20:00");
    }, O = () => {
        const m = ie(b) ? b : "08:00", j = ie(v) ? v : "20:00", f = {
            ...n,
            autoTimesEnabled: !0,
            start: m,
            end: j,
            rounding: x
        };
        i(f, m, j);
    };
    return e.jsxs("div", {
        className: "rounded-xl border border-gray-200 p-4",
        children: [ e.jsxs("div", {
            className: "grid gap-3 md:grid-cols-3",
            children: [ e.jsxs("div", {
                children: [ e.jsx("div", {
                    className: "text-sm font-medium text-gray-900",
                    children: "Nombre de prises"
                }), e.jsx(Z, {
                    className: "mt-2",
                    type: "number",
                    min: 1,
                    max: u === "jour" ? 6 : 12,
                    value: l,
                    onChange: m => S(m.target.value)
                }) ]
            }), e.jsxs("div", {
                children: [ e.jsx("div", {
                    className: "text-sm font-medium text-gray-900",
                    children: "Fréquence"
                }), e.jsxs("select", {
                    className: "mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm",
                    value: u,
                    onChange: m => N({
                        freqUnit: m.target.value
                    }),
                    children: [ e.jsx("option", {
                        value: "jour",
                        children: "Par jour"
                    }), e.jsx("option", {
                        value: "semaine",
                        children: "Par semaine"
                    }) ]
                }) ]
            }), e.jsxs("div", {
                children: [ e.jsx("div", {
                    className: "text-sm font-medium text-gray-900",
                    children: "Durée"
                }), e.jsxs("div", {
                    className: "mt-2 flex gap-2",
                    children: [ e.jsx(Z, {
                        type: "number",
                        min: 1,
                        value: g,
                        onChange: m => N({
                            durationVal: se(m.target.value, 1, 3650, 5)
                        })
                    }), e.jsxs("select", {
                        className: "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm",
                        value: a,
                        onChange: m => N({
                            durationUnit: m.target.value
                        }),
                        children: [ e.jsx("option", {
                            value: "jour",
                            children: "jours"
                        }), e.jsx("option", {
                            value: "mois",
                            children: "mois"
                        }) ]
                    }) ]
                }) ]
            }) ]
        }), u === "jour" && e.jsxs("div", {
            className: "mt-4",
            children: [ e.jsxs("div", {
                className: "flex flex-wrap items-center justify-between gap-2",
                children: [ e.jsx("div", {
                    className: "text-xs text-gray-600",
                    children: o ? e.jsx(e.Fragment, {
                        children: "Horaires auto (répartis entre la 1ère et la dernière prise)"
                    }) : e.jsx(e.Fragment, {
                        children: "Horaires personnalisés"
                    })
                }), e.jsx("div", {
                    className: "flex gap-2",
                    children: o ? e.jsx(D, {
                        type: "button",
                        variant: "secondary",
                        onClick: I,
                        children: "Réinitialiser les horaires"
                    }) : e.jsx(D, {
                        type: "button",
                        variant: "secondary",
                        onClick: O,
                        children: "Horaires auto"
                    })
                }) ]
            }), _.length > 0 && e.jsx("div", {
                className: "mt-3",
                children: e.jsx(F, {
                    variant: "warning",
                    title: "Vérification recommandée",
                    children: e.jsx("ul", {
                        className: "list-disc pl-5",
                        children: _.map(((m, j) => e.jsx("li", {
                            children: m
                        }, j)))
                    })
                })
            }), e.jsx("div", {
                className: "mt-3 space-y-2",
                children: Array.from({
                    length: l
                }).map(((m, j) => {
                    const f = j === 0, P = j === l - 1 && l > 1, k = f ? "1ère prise" : P ? "Dernière prise" : `Prise ${j + 1}`;
                    return e.jsxs("div", {
                        className: "grid grid-cols-1 gap-2 md:grid-cols-3",
                        children: [ e.jsxs("div", {
                            className: "text-sm text-gray-800 md:pt-2",
                            children: [ e.jsx("span", {
                                className: "font-medium",
                                children: k
                            }), o && (f || P) && e.jsx("span", {
                                className: "ml-2 text-xs text-gray-500",
                                children: "(ancre)"
                            }) ]
                        }), e.jsx(Z, {
                            type: "time",
                            step: 300,
                            value: C[j] || "",
                            onChange: E => A(j, E.target.value)
                        }), e.jsx(Z, {
                            type: "text",
                            placeholder: "Dose",
                            value: h[j] || "1",
                            onChange: E => q(j, E.target.value)
                        }) ]
                    }, j);
                }))
            }) ]
        }), null ]
    });
}

function ht(t, s) {
    const n = typeof t == "number" ? t : 0, l = (s || "EUR").toUpperCase();
    return `${(n / 100).toFixed(2)} ${l}`;
}

let ue = null;

function gt() {
    return window.Stripe ? Promise.resolve() : ue || (ue = new Promise(((t, s) => {
        const n = document.querySelector('script[data-stripe-js="1"]');
        if (n) {
            n.addEventListener("load", (() => t())), n.addEventListener("error", (() => s(new Error("Impossible de charger Stripe.js"))));
            return;
        }
        const l = document.createElement("script");
        l.src = "https://js.stripe.com/v3/", l.async = !0, l.dataset.stripeJs = "1", l.addEventListener("load", (() => t())), 
        l.addEventListener("error", (() => s(new Error("Impossible de charger Stripe.js")))), 
        document.body.appendChild(l);
    })), ue);
}

function Ve({prescriptionId: t, priority: s, onPaid: n}) {
    const l = we(), u = c.useRef(null), g = c.useRef(null), a = c.useRef(null), [x, o] = c.useState(!0), [b, v] = c.useState(!1), [M, C] = c.useState(null), [h, _] = c.useState(null), [N, i] = c.useState(null), [S, A] = c.useState(null), [q, I] = c.useState("EUR");
    c.useEffect((() => {
        let m = !1;
        async function j() {
            C(null), o(!0);
            try {
                const f = await Ze(t, s);
                if (m) return;
                if (_(f.client_secret), i(f.payment_intent_id), A(f.amount_cents), I(f.currency), 
                !f.publishable_key) throw new Error("Stripe n'est pas configuré (clé publique manquante).");
                if (await gt(), m) return;
                if (!window.Stripe) throw new Error("Stripe.js indisponible.");
                if (g.current = g.current || window.Stripe(f.publishable_key), !u.current) throw new Error("Zone de paiement introuvable.");
                const P = g.current.elements();
                if (a.current) {
                    try {
                        a.current.destroy();
                    } catch {}
                    a.current = null;
                }
                a.current = P.create("card"), a.current.mount(u.current);
            } catch (f) {
                m || C(f != null && f.message ? String(f.message) : "Erreur initialisation paiement");
            } finally {
                m || o(!1);
            }
        }
        return j(), () => {
            if (m = !0, a.current) {
                try {
                    a.current.destroy();
                } catch {}
                a.current = null;
            }
        };
    }), [ t, s ]);
    const O = async () => {
        var m, j;
        if (C(null), !h) {
            C("Client secret manquant.");
            return;
        }
        if (!g.current || !a.current) {
            C("Stripe n'est pas prêt.");
            return;
        }
        v(!0);
        try {
            const f = ((m = l.currentUser) == null ? void 0 : m.displayName) || void 0, P = ((j = l.currentUser) == null ? void 0 : j.email) || void 0, k = await g.current.confirmCardPayment(h, {
                payment_method: {
                    card: a.current,
                    billing_details: {
                        name: f,
                        email: P
                    }
                }
            });
            if (k != null && k.error) throw new Error(k.error.message || "Paiement refusé.");
            const E = k == null ? void 0 : k.paymentIntent;
            if (!(E != null && E.id)) throw new Error("PaymentIntent invalide.");
            await et(t, E.id), n();
        } catch (f) {
            C(f != null && f.message ? String(f.message) : "Erreur paiement");
        } finally {
            v(!1);
        }
    };
    return e.jsxs("div", {
        className: "rounded-xl border border-gray-200 bg-white p-4",
        children: [ e.jsx("div", {
            className: "mb-2 text-sm font-semibold text-gray-900",
            children: "Paiement sécurisé"
        }), e.jsxs("div", {
            className: "mb-3 text-sm text-gray-700",
            children: [ "Montant : ", e.jsx("span", {
                className: "font-semibold",
                children: ht(S, q)
            }) ]
        }), M && e.jsx("div", {
            className: "mb-3",
            children: e.jsx(F, {
                variant: "error",
                children: M
            })
        }), e.jsx("div", {
            className: "rounded-lg border border-gray-300 bg-white p-3",
            children: x ? e.jsxs("div", {
                className: "flex items-center gap-2 text-sm text-gray-600",
                children: [ e.jsx(V, {}), " Initialisation…" ]
            }) : e.jsx("div", {
                ref: u
            })
        }), e.jsxs("div", {
            className: "mt-4 flex flex-wrap items-center gap-2",
            children: [ e.jsx(D, {
                type: "button",
                onClick: O,
                disabled: x || b,
                children: b ? e.jsx(V, {}) : "Autoriser le paiement"
            }), N && e.jsxs("div", {
                className: "text-xs text-gray-500",
                children: [ "Référence paiement : ", N ]
            }) ]
        }), e.jsx("div", {
            className: "mt-3 text-xs text-gray-500",
            children: "La carte n’est débitée qu’après validation médicale (capture manuelle)."
        }) ]
    });
}

function ft({siteKey: t, enabled: s, onToken: n}) {
    const l = c.useRef(null), u = c.useRef(null), [g, a] = c.useState(null);
    return c.useEffect((() => {
        if (!s) {
            a(null), n("");
            return;
        }
        if (!t) {
            a(null), n("");
            return;
        }
        let x = 0, o = null, b = !1;
        const v = () => {
            x++;
            const M = window;
            if (!l.current) return;
            if (M.turnstile && typeof M.turnstile.render == "function") {
                try {
                    u.current = M.turnstile.render(l.current, {
                        sitekey: t,
                        callback: C => {
                            a(null), n(C || "");
                        },
                        "expired-callback": () => {
                            a(null), n("");
                        },
                        "error-callback": () => {
                            a(null), n("");
                        }
                    }), a(null);
                } catch {
                    a(null), n("");
                }
                o && window.clearInterval(o), o = null, b = !0;
                return;
            }
            x > 50 && !b && (a(null), n(""), 
            o && window.clearInterval(o), o = null);
        };
        return a(null), o = window.setInterval(v, 100), v(), () => {
            try {
                const M = window;
                M.turnstile && u.current != null && typeof M.turnstile.remove == "function" && M.turnstile.remove(u.current);
            } catch {}
            o && window.clearInterval(o), u.current = null;
        };
    }), [ s, t, n ]), g ? e.jsx(F, {
        variant: "error",
        children: g
    }) : e.jsx("div", {
        ref: l
    });
}

function ne(t, s) {
    const n = (s || "EUR").toUpperCase();
    return `${(t / 100).toFixed(2)} ${n}`;
}

function pt(t) {
    const s = (t || "").replace(/\D/g, "").slice(0, 8), n = [];
    return s.length <= 2 ? s : (n.push(s.slice(0, 2)), s.length <= 4 ? `${n[0]}/${s.slice(2)}` : (n.push(s.slice(2, 4)), 
    n.push(s.slice(4)), n.join("/")));
}

function yt(t) {
    const s = (t || "").trim(), n = /^([0-3]\d)\/([01]\d)\/(\d{4})$/.exec(s);
    if (!n) return null;
    const l = Number(n[1]), u = Number(n[2]), g = Number(n[3]);
    if (u < 1 || u > 12 || l < 1 || l > 31) return null;
    const a = new Date(Date.UTC(g, u - 1, l));
    if (a.getUTCFullYear() !== g || a.getUTCMonth() !== u - 1 || a.getUTCDate() !== l) return null;
    const x = String(u).padStart(2, "0"), o = String(l).padStart(2, "0");
    return `${g}-${x}-${o}`;
}

function bt(t) {
    const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!s) return null;
    const n = Number(s[1]), l = Number(s[2]), u = Number(s[3]), g = new Date(Date.UTC(n, l - 1, u)), a = new Date, x = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
    if (g.getTime() > x.getTime()) return null;
    const o = 24 * 60 * 60 * 1e3, b = Math.floor((x.getTime() - g.getTime()) / o);
    if (b < 28) return `${b} jour${b > 1 ? "s" : ""}`;
    let v = x.getUTCFullYear() - g.getUTCFullYear(), M = x.getUTCMonth() - g.getUTCMonth(), C = x.getUTCDate() - g.getUTCDate();
    if (C < 0) {
        const _ = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 0));
        C += _.getUTCDate(), M -= 1;
    }
    M < 0 && (M += 12, v -= 1);
    const h = v * 12 + M;
    return h < 24 ? `${Math.max(1, h)} mois` : v < 18 ? `${v} an${v > 1 ? "s" : ""}${M > 0 ? ` ${M} mois` : ""}` : `${v} an${v > 1 ? "s" : ""}`;
}

function jt(t) {
    const s = yt(t);
    return s && bt(s) || "";
}

function spIsEmailLikeValue(t) {
    const s = String(t ?? "").trim();
    return s !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function spSafePatientNameValue(t) {
    const s = String(t ?? "").trim();
    return s !== "" && !spIsEmailLikeValue(s) ? s : "";
}

function spSplitPatientNameValue(t) {
    const s = spSafePatientNameValue(t);
    if (s === "") return {
        firstName: "",
        lastName: ""
    };
    const n = s.split(/\s+/u).map((l => l.trim())).filter(Boolean);
    if (n.length < 2) return {
        firstName: n[0] || "",
        lastName: ""
    };
    const l = n.shift() || "";
    return {
        firstName: l,
        lastName: n.join(" ")
    };
}

function vt() {
    var Ae, Ie, Re, $e, De;
    const t = we(), s = t.notices || {}, n = !!(s != null && s.enabled_form), l = (s != null && s.title ? String(s.title) : "").trim(), u = String((s == null ? void 0 : s.items_text) || "").split(/\r?\n/).map((r => r.trim())).filter(Boolean), [g, a] = c.useState((() => spResolveFlowFromUrl() ? "form" : "choose")), [x, o] = c.useState(null), [b, v] = c.useState(null), [M, C] = c.useState(!0), [h, _] = c.useState((() => spResolveFlowFromUrl())), [N, i] = c.useState("standard"), [S, A] = c.useState((() => {
        var w;
        return spSafePatientNameValue(((w = t == null ? void 0 : t.patientProfile) == null ? void 0 : w.fullname) || "");
    })), [q, I] = c.useState((() => {
        var w;
        const r = t, y = (w = r == null ? void 0 : r.patientProfile) == null ? void 0 : w.birthdate_fr;
        return y ? String(y) : "";
    })), [O, m] = c.useState((() => {
        var w, z, $;
        return String((((w = t == null ? void 0 : t.patientProfile) == null ? void 0 : w.note) || ((z = t == null ? void 0 : t.patientProfile) == null ? void 0 : z.medical_notes) || (($ = t == null ? void 0 : t.patientProfile) == null ? void 0 : $.medicalNotes) || "")).trim();
    })), [j, f] = c.useState([]), [P, k] = c.useState(""), [E, Y] = c.useState([]), [G, le] = c.useState(!1), [W, ee] = c.useState(!1), U = t.compliance || {}, K = !!(U != null && U.consent_required), [d, p] = c.useState(!1), [R, T] = c.useState(!1), [L, Q] = c.useState(!1), [te, Oe] = c.useState(!1), [Je, Se] = c.useState(!1), [xe, he] = c.useState([]), [Ce, oe] = c.useState(null), [ge, Me] = c.useState(!1), [ke, X] = c.useState(null), [J, ce] = c.useState(null), [Be, de] = c.useState(!1);
    c.useEffect((() => {
        let r = !1;
        async function y() {
            C(!0);
            try {
                const [w, z] = await Promise.all([ tt(), st() ]);
                if (r) return;
                o(w), v(z);
            } catch {
                r || v({
                    enabled: !1,
                    publishable_key: "",
                    provider: "stripe",
                    capture_method: "manual"
                });
            } finally {
                r || C(!1);
            }
        }
        return y(), () => {
            r = !0;
        };
    }), []);
    const B = ((Ie = t.currentUser) == null ? void 0 : Ie.id) && t.currentUser.id > 0, _e = c.useMemo((() => x ? N === "express" ? x.express_cents : x.standard_cents : null), [ x, N ]), spBlockInfo = c.useMemo((() => {
        var r, y;
        return spBuildSubmitBlockInfo({
            loggedIn: !!B,
            flow: h,
            fullname: S,
            birthdate: q,
            itemsCount: j.length,
            filesCount: E.length,
            attestationNoProof: W,
            consentRequired: K,
            consentTelemedicine: d,
            consentTruth: R,
            consentCgu: L,
            consentPrivacy: te,
            turnstileEnabled: (r = t.turnstile) != null && r.enabled,
            turnstileSiteKey: (y = t.turnstile) != null && y.siteKey,
            turnstileToken: P,
            analysisInProgress: G
        });
    }), [ B, h, S, q, j.length, E.length, W, K, d, R, L, te, (Re = t.turnstile) == null ? void 0 : Re.enabled, t.turnstile == null ? void 0 : t.turnstile.siteKey, P, G ]), Ee = spBlockInfo.ok, Pe = c.useMemo((() => jt(q)), [ q ]), pe = r => {
        const y = {
            cis: r.cis,
            cip13: r.cip13 || null,
            label: r.label,
            schedule: {
                nb: 1,
                freqUnit: "jour",
                durationVal: 5,
                durationUnit: "jour",
                times: [ "08:00" ],
                doses: [ "1" ],
                note: "",
                autoTimesEnabled: !0,
                start: "08:00",
                end: "20:00",
                rounding: 5
            }
        };
        f((w => w.some(($ => $.cis && y.cis ? $.cis === y.cis : $.label.trim().toLowerCase() === y.label.trim().toLowerCase())) ? w : [ ...w, y ]));
    }, He = (r, y) => {
        f((w => w.map(((z, $) => $ === r ? {
            ...z,
            ...y
        } : z))));
    }, Ye = r => {
        f((y => y.filter(((w, z) => z !== r))));
    }, Ge = async r => {
        Se(!0);
        try {
            return null;
        } catch {
            return null;
        } finally {
            Se(!1);
        }
    }, We = async r => {
        if (!(!r || r.length === 0)) {
            X(null), oe(null), he([]);
            const y = Array.from(r).map((w => ({
                id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
                file: w,
                original_name: w && w.name ? String(w.name) : "upload.bin",
                mime: w && w.type ? String(w.type) : "application/octet-stream",
                mime_type: w && w.type ? String(w.type) : "application/octet-stream",
                size_bytes: w && typeof w.size == "number" ? w.size : 0,
                kind: "PROOF",
                status: "QUEUED"
            })));
            Y((w => [ ...w, ...y ])), oe("Documents ajoutés. L'analyse automatique sera lancée lors de la soumission.");
        }
    }, Qe = async () => {
        var r;
        X(null);
        const y = spBuildSubmitBlockInfo({
            loggedIn: !!B,
            flow: h,
            fullname: S,
            birthdate: q,
            itemsCount: j.length,
            filesCount: E.length,
            attestationNoProof: W,
            consentRequired: K,
            consentTelemedicine: d,
            consentTruth: R,
            consentCgu: L,
            consentPrivacy: te,
            turnstileEnabled: !!((r = t.turnstile) != null && r.enabled),
            turnstileSiteKey: !!(t.turnstile != null && t.turnstile.siteKey),
            turnstileToken: P,
            analysisInProgress: G
        });
        spFrontendLog("submit_clicked", "info", {
            flow: h || null,
            stage: g,
            logged_in: !!B,
            meds_count: Array.isArray(j) ? j.length : 0,
            files_count: Array.isArray(E) ? E.length : 0,
            turnstile_token_present: !!P
        });
        if (!y.ok || !h) {
            const w = Array.isArray(y.reasons) ? y.reasons.map((z => z.code)) : [], z = !y.ok ? y.code : "flow_missing", $ = y.message || "Le formulaire est incomplet. Merci de vérifier les champs requis.";
            spFrontendLog("submit_blocked", "warning", {
                flow: h || null,
                stage: g,
                reason_code: z || "unknown",
                reasons: w,
                message: $,
                logged_in: !!B,
                meds_count: Array.isArray(j) ? j.length : 0,
                files_count: Array.isArray(E) ? E.length : 0,
                attestation_no_proof: !!W,
                consent_required: !!K,
                consent_telemedicine: !!d,
                consent_truth: !!R,
                consent_cgu: !!L,
                consent_privacy: !!te,
                turnstile_token_present: !!P
            }), X($);
            return;
        }
        Me(!0);
        try {
            const w = spSafePatientNameValue(S), z = spSplitPatientNameValue(w);
            if (w.length < 3 || z.firstName === "" || z.lastName === "") {
                spFrontendLog("submit_blocked", "warning", {
                    flow: h,
                    stage: g,
                    reason_code: "patient_name_invalid",
                    message: "Merci de saisir le prénom et le nom du patient, et non une adresse e-mail."
                }), X("Merci de saisir le prénom et le nom du patient, et non une adresse e-mail."), Me(!1);
                return;
            }
            spFrontendLog("submission_init_start", "info", {
                flow: h,
                priority: N,
                meds_count: Array.isArray(j) ? j.length : 0,
                files_count: Array.isArray(E) ? E.length : 0
            });
            const $ = {
                flow: h,
                priority: N,
                turnstileToken: P || ""
            };
            delete $.turnstileToken;
            const A = await spCreateSubmissionApi($), ee = String((A == null ? void 0 : A.submission_ref) || "").trim();
            if (!ee) throw new Error("Référence de soumission manquante.");
            spFrontendLog("submission_init_ok", "info", {
                flow: h,
                submission_ref_present: !!ee
            });
            let se = Array.isArray(j) ? j.slice() : [];
            if (h === "ro_proof") {
                const re = Array.isArray(E) ? E.filter((ue => ue && ue.file)) : [], ie = [], ye = [], Te = [], Ke = [];
                le(!0), Se(!0), X(null), oe(null), he([]);
                try {
                    for (const ue of re) try {
                        const Fe = ue.file;
                        spFrontendLog("submission_artifact_start", "debug", {
                            flow: h,
                            original_name: Fe && Fe.name ? String(Fe.name) : "upload.bin"
                        });
                        const qe = await spDirectSubmissionArtifactUpload(Fe, ee, "PROOF");
                        spFrontendLog("submission_artifact_uploaded", "info", {
                            flow: h,
                            artifact_id: String((qe == null ? void 0 : qe.id) || "")
                        });
                        const Le = await artifactAnalyzeApi(String((qe == null ? void 0 : qe.id) || "")), Oe = !!(Le && Le.ok === !1), qeItems = spAiMedicationsToItems(Le == null ? void 0 : Le.medications), Je = !!(Le && (Le.is_prescription === !0 || qeItems.length > 0));
                        spFrontendLog("submission_artifact_analyzed", "info", {
                            flow: h,
                            artifact_id: String((qe == null ? void 0 : qe.id) || ""),
                            is_prescription: !!(Le && Le.is_prescription === !0),
                            medications_count: Array.isArray(Le == null ? void 0 : Le.medications) ? Le.medications.length : 0
                        });
                        if (Oe) {
                            Te.push(ue), Ke.push(typeof (Le == null ? void 0 : Le.message) == "string" && Le.message.trim() ? Le.message.trim() : "L'analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net.");
                            continue;
                        }
                        ie.push(qe), Je && qeItems.length > 0 && ye.push(...qeItems), Je || Te.push(ue);
                    } catch (Fe) {
                        Te.push(ue), Ke.push(Fe != null && Fe.message ? String(Fe.message) : "L'analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net."), spFrontendLog("submission_artifact_error", "warning", {
                            flow: h,
                            message: Fe != null && Fe.message ? String(Fe.message) : "artifact_error"
                        });
                    }
                    ie.length > 0 && oe(ye.length > 0 ? "✅ Document reconnu. Les médicaments ont été ajoutés automatiquement." : "✅ Document reconnu."), Te.length > 0 && he(Te.map((Fe => Fe.file || Fe))), Ke.length > 0 && X(Ke[0]), ye.length > 0 && (se = spAiMergeMedicationItems(se, ye), f(se));
                } finally {
                    Se(!1), le(!1);
                }
                if (ie.length < 1) {
                    spFrontendLog("submit_blocked", "warning", {
                        flow: h,
                        stage: g,
                        reason_code: "proof_upload_missing",
                        message: Ke[0] || "Aucun document exploitable n'a été accepté.",
                        files_count: Array.isArray(E) ? E.length : 0
                    }), Me(!1);
                    return;
                }
            }
            const ne = {
                patient: {
                    fullname: w,
                    firstName: z.firstName,
                    lastName: z.lastName,
                    birthdate: q.trim(),
                    birthDate: q.trim(),
                    note: O.trim() || void 0,
                    medical_notes: O.trim() || void 0,
                    medicalNotes: O.trim() || void 0
                },
                items: se.map((ue => {
                    const Fe = {
                        label: (ue.label || "").trim(),
                        schedule: ue.schedule && typeof ue.schedule == "object" ? ue.schedule : {}
                    };
                    return ue.cis && (Fe.cis = String(ue.cis)), ue.cip13 && (Fe.cip13 = String(ue.cip13)), ue.quantite && (Fe.quantite = String(ue.quantite)), Fe;
                })),
                privateNotes: O.trim() || void 0,
                consent: K ? {
                    telemedicine: d,
                    truth: R,
                    cgu: L,
                    privacy: te,
                    timestamp: (new Date).toISOString(),
                    cgu_version: U != null && U.cgu_version ? String(U.cgu_version) : "",
                    privacy_version: U != null && U.privacy_version ? String(U.privacy_version) : ""
                } : void 0,
                attestation_no_proof: h === "depannage_no_proof" ? W : void 0
            };
            if (!Array.isArray(ne.items) || ne.items.length < 1) {
                const ue = h === "ro_proof" ? "Aucun médicament n'a pu être identifié. Merci d'importer un document plus net ou d'utiliser la saisie manuelle." : "Merci d'ajouter au moins un médicament.";
                spFrontendLog("submit_blocked", "warning", {
                    flow: h,
                    stage: g,
                    reason_code: "medication_missing_after_analysis",
                    message: ue,
                    items_count: Array.isArray(ne.items) ? ne.items.length : 0
                });
                throw new Error(ue);
            }
            spFrontendLog("submission_finalize_start", "info", {
                flow: h,
                items_count: ne.items.length,
                files_count: Array.isArray(E) ? E.length : 0
            });
            const ae = await spFinalizeSubmissionApi(ee, ne), oeResult = {
                id: (ae == null ? void 0 : ae.prescription_id) || ae.id,
                uid: ae.uid,
                status: ae.status,
                created_at: ae.created_at
            };
            spFrontendLog("submission_finalize_ok", "info", {
                flow: h,
                prescription_id: oeResult.id || null,
                uid: oeResult.uid || null,
                status: oeResult.status || null
            }), ce(oeResult), a("done");
        } catch (w) {
            const z = w != null && w.message ? String(w.message) : "Erreur soumission";
            spFrontendLog("submission_error", "error", {
                flow: h || null,
                stage: g,
                message: z,
                meds_count: Array.isArray(j) ? j.length : 0,
                files_count: Array.isArray(E) ? E.length : 0
            }), X(z);
        } finally {
            Me(!1);
        }
    }, ye = (($e = t == null ? void 0 : t.urls) == null ? void 0 : $e.patientPortal) || null, Te = J && ye ? `${ye}${ye.includes("?") ? "&" : "?"}rx_uid=${encodeURIComponent(String((J == null ? void 0 : J.uid) || (J == null ? void 0 : J.id) || ""))}` : null, Ke = async () => {
        if (J != null && J.uid) try {
            await navigator.clipboard.writeText(J.uid), de(!0), window.setTimeout((() => de(!1)), 1500);
        } catch {
            de(!1);
        }
    }, Ue = () => {
        var r, y, w;
        a("choose"), _(null), i("standard"), A(spSafePatientNameValue(((r = t == null ? void 0 : t.patientProfile) == null ? void 0 : r.fullname) || "")), 
        I(((w = t == null ? void 0 : t.patientProfile) == null ? void 0 : w.birthdate_fr) || ""), 
        m(String((((y = t == null ? void 0 : t.patientProfile) == null ? void 0 : y.note) || ((r = t == null ? void 0 : t.patientProfile) == null ? void 0 : r.medical_notes) || ((w = t == null ? void 0 : t.patientProfile) == null ? void 0 : w.medicalNotes) || "")).trim()), f([]), Y([]), he([]), oe(null), ee(!1), p(!1), T(!1), Q(!1), Oe(!1), X(null), 
        ce(null), de(!1);
    };
    return e.jsxs("div", {
        className: "mx-auto max-w-3xl p-4",
        children: [ e.jsxs("div", {
            className: "mb-4 flex items-start justify-between gap-4",
            children: [ e.jsxs("div", {
                children: [ e.jsx("div", {
                    className: "text-xl font-semibold text-gray-900",
                    children: "SOS Prescription"
                }), e.jsx("div", {
                    className: "text-sm text-gray-600",
                    children: "Évaluation médicale asynchrone • formulaire sécurisé"
                }) ]
            }), e.jsxs("div", {
                className: "flex flex-col items-end gap-2",
                children: [ e.jsxs("div", {
                    className: "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs " + (B ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"),
                    children: [ e.jsx("span", {
                        className: "font-semibold",
                        children: B ? "Connecté" : "Non connecté"
                    }), B && ((De = t.currentUser) == null ? void 0 : De.displayName) && e.jsx("span", {
                        className: "text-emerald-900",
                        children: t.currentUser.displayName
                    }) ]
                }), x && e.jsxs("div", {
                    className: "rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700",
                    children: [ e.jsx("div", {
                        className: "font-semibold",
                        children: "Tarif"
                    }), e.jsxs("div", {
                        children: [ "Standard : ", ne(x.standard_cents, x.currency), e.jsx("br", {}), "Express : ", ne(x.express_cents, x.currency) ]
                    }) ]
                }) ]
            }) ]
        }), n && u.length > 0 && e.jsx("div", {
            className: "mb-4",
            children: e.jsxs(F, {
                variant: "info",
                children: [ l && e.jsx("div", {
                    className: "font-semibold",
                    children: l
                }), e.jsx("ul", {
                    className: l ? "mt-2 list-disc space-y-1 pl-5" : "list-disc space-y-1 pl-5",
                    children: u.map(((r, y) => e.jsx("li", {
                        children: r
                    }, y)))
                }) ]
            })
        }), e.jsx("div", {
            className: "mb-4",
            children: e.jsxs(F, {
                variant: "warning",
                children: [ "Service réservé au ", e.jsx("strong", {
                    children: "renouvellement / continuité d’un traitement déjà connu"
                }), ".", e.jsx("br", {}), "Aucune urgence vitale, pas d’arrêt de travail, et aucun médicament classé comme stupéfiant." ]
            })
        }), !B && e.jsx("div", {
            className: "mb-4",
            children: e.jsxs(F, {
                variant: "info",
                children: [ "Vous êtes en ", e.jsx("strong", {
                    children: "mode aperçu"
                }), ". Connectez-vous (ou créez un compte) pour soumettre votre demande.", e.jsx("br", {}), "La recherche de médicaments et l’import de justificatifs sont désactivés tant que vous n’êtes pas connecté." ]
            })
        }), ke && e.jsx("div", {
            className: "mb-4",
            children: e.jsx(F, {
                variant: "error",
                children: ke
            })
        }), g === "choose" && e.jsxs("div", {
            className: "rounded-xl border border-gray-200 bg-white p-4",
            children: [ e.jsx("div", {
                className: "mb-3 text-sm font-semibold text-gray-900",
                children: "Choisissez votre demande"
            }), e.jsxs("div", {
                className: "grid grid-cols-1 gap-3 sm:grid-cols-2",
                children: [ e.jsxs("button", {
                    type: "button",
                    className: `rounded-xl border p-4 text-left transition hover:bg-gray-50 ${h === "ro_proof" ? "border-gray-900" : "border-gray-200"}`,
                    onClick: () => {
                        _("ro_proof"), ee(!1), X(null), ce(null), a("form");
                    },
                    children: [ e.jsx("div", {
                        className: "text-sm font-semibold text-gray-900",
                        children: "Renouvellement avec preuve"
                    }), e.jsx("div", {
                        className: "mt-1 text-sm text-gray-600",
                        children: "Vous avez une ancienne ordonnance ou une boîte de médicament."
                    }), e.jsx("div", {
                        className: "mt-2 text-xs text-gray-500",
                        children: "Temps estimé : ~ 3 min"
                    }) ]
                }), e.jsxs("button", {
                    type: "button",
                    className: `rounded-xl border p-4 text-left transition hover:bg-gray-50 ${h === "depannage_no_proof" ? "border-gray-900" : "border-gray-200"}`,
                    onClick: () => {
                        _("depannage_no_proof"), Y([]), he([]), oe(null), ee(!1), X(null), ce(null), a("form");
                    },
                    children: [ e.jsx("div", {
                        className: "text-sm font-semibold text-gray-900",
                        children: "Dépannage sans preuve"
                    }), e.jsx("div", {
                        className: "mt-1 text-sm text-gray-600",
                        children: "En cas de perte, d’oubli ou de voyage (traitement habituel)."
                    }), e.jsx("div", {
                        className: "mt-2 text-xs text-gray-500",
                        children: "Temps estimé : ~ 5 min"
                    }) ]
                }) ]
            }) ]
        }), g === "form" && e.jsxs("div", {
            className: "space-y-4",
            children: [ e.jsxs("div", {
                className: "rounded-xl border border-gray-200 bg-white p-4",
                children: [ e.jsxs("div", {
                    className: "mb-3 flex items-center justify-between gap-2",
                    children: [ e.jsx("div", {
                        className: "text-sm font-semibold text-gray-900",
                        children: "Informations patient"
                    }), e.jsx(D, {
                        type: "button",
                        variant: "secondary",
                        onClick: () => a("choose"),
                        children: "Modifier le type"
                    }) ]
                }), e.jsxs("div", {
                    className: "grid grid-cols-1 gap-3 sm:grid-cols-2",
                    children: [ e.jsxs("div", {
                        className: "relative",
                        children: [ e.jsx("input", {
                            type: "text",
                            tabIndex: -1,
                            autoComplete: "username",
                            name: "sp_trap_username",
                            style: {
                                position: "absolute",
                                left: "-9999px",
                                top: "auto",
                                width: "1px",
                                height: "1px",
                                overflow: "hidden",
                                opacity: 0,
                                pointerEvents: "none"
                            },
                            "aria-hidden": "true"
                        }), e.jsx("input", {
                            type: "password",
                            tabIndex: -1,
                            autoComplete: "new-password",
                            name: "sp_trap_password",
                            style: {
                                position: "absolute",
                                left: "-9999px",
                                top: "auto",
                                width: "1px",
                                height: "1px",
                                overflow: "hidden",
                                opacity: 0,
                                pointerEvents: "none"
                            },
                            "aria-hidden": "true"
                        }), e.jsx("label", {
                            className: "mb-1 block text-xs font-medium text-gray-700",
                            children: "Nom complet"
                        }), e.jsx(Z, {
                            value: S,
                            onChange: r => A(r.target.value),
                            placeholder: "Prénom NOM",
                            name: "sp_patient_identity_fullname",
                            id: "sp-patient-fullname",
                            autoComplete: "new-password",
                            "data-lpignore": "true",
                            "data-form-type": "other",
                            spellCheck: !1,
                            autoCorrect: "off",
                            autoCapitalize: "words"
                        }) ]
                    }), e.jsxs("div", {
                        children: [ e.jsx("label", {
                            className: "mb-1 block text-xs font-medium text-gray-700",
                            children: "Date de naissance (JJ/MM/AAAA)"
                        }), e.jsx(Z, {
                            value: q,
                            onChange: r => I(pt(r.target.value)),
                            placeholder: "JJ/MM/AAAA",
                            inputMode: "numeric",
                            pattern: "[0-9]{2}/[0-9]{2}/[0-9]{4}",
                            name: "sp_patient_identity_birthdate",
                            id: "sp-patient-birthdate",
                            autoComplete: "off",
                            "data-lpignore": "true",
                            "data-form-type": "other"
                        }), Pe && e.jsxs("div", {
                            className: "mt-1 text-xs text-gray-500",
                            children: [ "Âge : ", Pe ]
                        }) ]
                    }) ]
                }), e.jsxs("div", {
                    className: "mt-3",
                    children: [ e.jsx("label", {
                        className: "mb-1 block text-xs font-medium text-gray-700",
                        children: "Précisions médicales (optionnel)"
                    }), e.jsx(Ne, {
                        id: "sp-patient-medical-notes",
                        name: "medical_notes",
                        value: O,
                        onChange: r => m(r.target.value),
                        placeholder: "Allergies, antécédents, contre-indications ou toute information utile au médecin...."
                    }) ]
                }) ]
            }), h === "ro_proof" && e.jsxs("div", {
                className: "rounded-xl border border-gray-200 bg-white p-4",
                children: [ e.jsx("div", {
                    className: "mb-1 text-sm font-semibold text-gray-900",
                    children: "Justificatifs médicaux (Obligatoire)"
                }), e.jsx("div", {
                    className: "text-sm text-gray-600",
                    children: "Importez votre ordonnance ou une photo de la boîte. Cela nous permet de vérifier votre traitement et de pré-remplir le formulaire."
                }), e.jsxs("div", {
                    className: "mt-3",
                    children: [ e.jsx("input", {
                        id: "sp-evidence-input",
                        type: "file",
                        className: "hidden",
                        accept: "image/jpeg,image/png,application/pdf",
                        multiple: !0,
                        disabled: !B || G,
                        onChange: r => {
                            We(r.target.files), r.currentTarget.value = "";
                        }
                    }), e.jsxs("div", {
                        className: "flex flex-wrap items-center gap-3",
                        children: [ e.jsx(D, {
                            type: "button",
                            variant: "secondary",
                            className: "border-blue-600 text-blue-700 hover:bg-blue-50 hover:!text-blue-700",
                            disabled: !B || G,
                            onClick: () => {
                                const r = document.getElementById("sp-evidence-input");
                                r == null || r.click();
                            },
                            children: G ? "Import en cours…" : "Ajouter un document"
                        }), Je && e.jsxs("div", {
                            className: "flex items-center gap-2 text-sm text-gray-600",
                            children: [ e.jsx(V, {}), " Analyse automatique…" ]
                        }) ]
                    }), e.jsx("div", {
                        className: "mt-1 text-xs text-gray-400",
                        children: "JPG, PNG ou PDF (Max 5 Mo)"
                    }), !B && e.jsx("div", {
                        className: "mt-2 text-xs text-amber-700",
                        children: "Connectez-vous pour importer un justificatif."
                    }) ]
                }), E.length > 0 && e.jsx("div", {
                    className: "mt-3 space-y-2",
                    children: E.map((r => e.jsxs("div", {
                        className: "flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2",
                        children: [ e.jsxs("div", {
                            className: "min-w-0",
                            children: [ e.jsx("div", {
                                className: "truncate text-sm font-medium text-gray-900",
                                children: r.original_name
                            }), e.jsxs("div", {
                                className: "text-xs text-gray-600",
                                children: [ r.mime, " • ", Math.round(r.size_bytes / 1024), " Ko" ]
                            }) ]
                        }), e.jsx("button", {
                            type: "button",
                            className: "inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-100",
                            "aria-label": "Retirer ce document",
                            title: "Retirer",
                            onClick: () => Y((y => y.filter((w => w.id !== r.id)))),
                            children: "×"
                        }) ]
                    }, r.id)))
                }), Ce && e.jsx("div", {
                    className: "mt-3",
                    children: e.jsx(F, {
                        variant: Ce.startsWith("✅") ? "success" : "warning",
                        children: Ce
                    })
                }), xe.length > 0 && e.jsxs("div", {
                    className: "mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3",
                    children: [ e.jsxs("div", {
                        className: "flex items-center justify-between gap-3",
                        children: [ e.jsxs("div", {
                            children: [ e.jsx("div", {
                                className: "text-sm font-semibold text-amber-900",
                                children: "Document refusé par l’analyse IA"
                            }), e.jsx("div", {
                                className: "text-xs text-amber-900/80",
                                children: "L'intelligence artificielle n'a détecté aucune prescription médicale lisible sur ce document. Veuillez retirer ce fichier et importer une photo nette de votre ordonnance."
                            }) ]
                        }), e.jsxs(e.Fragment, {
                            children: [ e.jsx(D, {
                                type: "button",
                                variant: "ghost",
                                disabled: G,
                                onClick: () => {
                                    _("depannage_no_proof");
                                    Y([]);
                                    he([]);
                                    oe(null);
                                },
                                children: "Saisie manuelle (Dépannage)"
                            }), e.jsx(D, {
                                type: "button",
                                variant: "ghost",
                                disabled: G,
                                onClick: () => {
                                    he([]), oe(null);
                                },
                                children: "Retirer"
                            }) ]
                        }) ]
                    }), e.jsx("ul", {
                        className: "mt-2 list-disc pl-5 text-xs text-amber-900/90",
                        children: xe.map(((r, w) => e.jsx("li", {
                            children: r && r.name ? r.name : "Document"
                        }, w)))
                    }) ]
                }) ]
            }), (h !== "ro_proof" || j.length > 0) && e.jsxs("div", {
                className: "rounded-xl border border-gray-200 bg-white p-4",
                children: [ e.jsx("div", {
                    className: "mb-2 text-sm font-semibold text-gray-900",
                    children: "Médicaments"
                }), e.jsx("div", {
                    className: "text-sm text-gray-600",
                    children: h === "ro_proof" && j.length > 0 ? "Médicaments reconnus par l'IA" : "Recherchez et ajoutez les médicaments concernés."
                }), h !== "ro_proof" && e.jsx("div", {
                    className: "mt-3",
                    children: e.jsx(mt, {
                        onSelect: pe,
                        disabled: !B
                    })
                }), j.length > 0 && e.jsx("div", {
                    className: "mt-4 space-y-3",
                    children: j.map(((r, y) => e.jsxs("div", {
                        className: "rounded-xl border border-gray-100 bg-gray-50 p-3",
                        children: [ e.jsxs("div", {
                            className: "flex items-start justify-between gap-3",
                            children: [ e.jsxs("div", {
                                className: "min-w-0",
                                children: [ e.jsx("div", {
                                    className: "truncate text-sm font-semibold text-gray-900",
                                    children: r.label
                                }), e.jsxs("div", {
                                    className: "mt-0.5 text-xs text-gray-600",
                                    children: [ r.cis ? `CIS ${r.cis}` : "", r.cip13 ? ` • CIP13 ${r.cip13}` : "" ]
                                }) ]
                            }), e.jsx(D, {
                                type: "button",
                                variant: "secondary",
                                onClick: () => Ye(y),
                                children: "Retirer"
                            }) ]
                        }), e.jsxs("div", {
                            className: "mt-4",
                            children: [ e.jsx("div", {
                                className: "mb-2 text-xs font-medium text-gray-700",
                                children: "Posologie"
                            }), e.jsx(xt, {
                                value: r.schedule || {},
                                onChange: w => He(y, {
                                    schedule: w
                                })
                            }), e.jsx("div", {
                                className: "mt-3 text-xs text-gray-500",
                                children: "Les champs CIS/CIP sont enregistrés pour traçabilité."
                            }) ]
                        }) ]
                    }, y)))
                }) ]
            }), e.jsxs("div", {
                className: "rounded-xl border border-gray-200 bg-white p-4",
                children: [ e.jsx("div", {
                    className: "mb-2 text-sm font-semibold text-gray-900",
                    children: "Délai & tarif"
                }), M ? e.jsxs("div", {
                    className: "flex items-center gap-2 text-sm text-gray-600",
                    children: [ e.jsx(V, {}), " Chargement…" ]
                }) : e.jsxs("div", {
                    className: "space-y-3",
                    children: [ e.jsxs("div", {
                        className: "grid grid-cols-1 gap-3 sm:grid-cols-2",
                        children: [ e.jsxs("button", {
                            type: "button",
                            className: `rounded-xl border p-4 text-left transition hover:bg-gray-50 ${N === "standard" ? "border-gray-900" : "border-gray-200"}`,
                            onClick: () => i("standard"),
                            children: [ e.jsx("div", {
                                className: "text-sm font-semibold text-gray-900",
                                children: "Standard"
                            }), e.jsx("div", {
                                className: "mt-1 text-sm text-gray-600",
                                children: "Traitement en file normale"
                            }), x && e.jsx("div", {
                                className: "mt-2 text-xs text-gray-500",
                                children: ne(x.standard_cents, x.currency)
                            }) ]
                        }), e.jsxs("button", {
                            type: "button",
                            className: `rounded-xl border p-4 text-left transition hover:bg-gray-50 ${N === "express" ? "border-gray-900" : "border-gray-200"}`,
                            onClick: () => i("express"),
                            children: [ e.jsx("div", {
                                className: "text-sm font-semibold text-gray-900",
                                children: "Express"
                            }), e.jsx("div", {
                                className: "mt-1 text-sm text-gray-600",
                                children: "Prioritaire (selon disponibilité)"
                            }), x && e.jsx("div", {
                                className: "mt-2 text-xs text-gray-500",
                                children: ne(x.express_cents, x.currency)
                            }) ]
                        }) ]
                    }), b != null && b.enabled ? e.jsxs(F, {
                        variant: "info",
                        children: [ "Paiement : une ", e.jsx("strong", {
                            children: "autorisation"
                        }), " est demandée à la soumission. La carte n’est débitée qu’après validation médicale." ]
                    }) : e.jsx(F, {
                        variant: "info",
                        children: "Paiement désactivé (mode test)."
                    }) ]
                }) ]
            }), h === "depannage_no_proof" && e.jsxs("div", {
                className: "rounded-xl border border-yellow-200 bg-yellow-50 p-4",
                children: [ e.jsx("div", {
                    className: "text-sm font-semibold text-gray-900",
                    children: "Attestation sur l'honneur (Obligatoire)"
                }), e.jsx("div", {
                    className: "mt-1 text-sm text-gray-700",
                    children: "En cas de perte, d'oubli ou de voyage, vous devez certifier que ce traitement vous a déjà été prescrit."
                }), e.jsxs("label", {
                    className: "mt-3 flex items-start gap-2 text-sm text-gray-900",
                    children: [ e.jsx("input", {
                        type: "checkbox",
                        checked: W,
                        onChange: r => ee(r.target.checked),
                        className: "mt-1 h-4 w-4"
                    }), e.jsx("span", {
                        children: "Je certifie sur l'honneur que les informations renseignées sont exactes et que ce traitement m'a déjà été prescrit par un médecin."
                    }) ]
                }) ]
            }), K && e.jsxs("div", {
                className: "rounded-xl border border-gray-200 bg-white p-4",
                children: [ e.jsx("div", {
                    className: "text-sm font-semibold text-gray-900",
                    children: "Consentements requis"
                }), e.jsx("div", {
                    className: "mt-1 text-xs text-gray-600",
                    children: "Avant de soumettre, vous devez accepter les points ci-dessous."
                }), e.jsxs("div", {
                    className: "mt-4 space-y-3",
                    children: [ e.jsxs("label", {
                        className: "flex items-start gap-2 text-sm text-gray-900",
                        children: [ e.jsx("input", {
                            id: "sp-consent-medical",
                            type: "checkbox",
                            className: "mt-1 h-4 w-4 rounded border-gray-300",
                            checked: d,
                            onChange: r => p(r.target.checked)
                        }), e.jsx("span", {
                            children: "J'accepte que ma demande et mes informations médicales soient traitées dans le cadre de la téléconsultation."
                        }) ]
                    }), e.jsxs("label", {
                        className: "flex items-start gap-2 text-sm text-gray-900",
                        children: [ e.jsx("input", {
                            id: "sp-consent-truth",
                            type: "checkbox",
                            className: "mt-1 h-4 w-4 rounded border-gray-300",
                            checked: R,
                            onChange: r => T(r.target.checked)
                        }), e.jsx("span", {
                            children: "Je certifie que les informations renseignées sont exactes."
                        }) ]
                    }), e.jsxs("label", {
                        className: "flex items-start gap-2 text-sm text-gray-900",
                        children: [ e.jsx("input", {
                            id: "sp-consent-cgu",
                            type: "checkbox",
                            className: "mt-1 h-4 w-4 rounded border-gray-300",
                            checked: L,
                            onChange: r => Q(r.target.checked)
                        }), e.jsxs("span", {
                            children: [ "J'ai lu et j'accepte", " ", e.jsx("a", {
                                href: (U == null ? void 0 : U.cgu_url) || "#",
                                target: "_blank",
                                rel: "noreferrer",
                                className: "underline",
                                children: "les CGU"
                            }), "." ]
                        }) ]
                    }), e.jsxs("label", {
                        className: "flex items-start gap-2 text-sm text-gray-900",
                        children: [ e.jsx("input", {
                            id: "sp-consent-privacy",
                            type: "checkbox",
                            className: "mt-1 h-4 w-4 rounded border-gray-300",
                            checked: te,
                            onChange: r => Oe(r.target.checked)
                        }), e.jsxs("span", {
                            children: [ "J'ai lu", " ", e.jsx("a", {
                                href: (U == null ? void 0 : U.privacy_url) || "#",
                                target: "_blank",
                                rel: "noreferrer",
                                className: "underline",
                                children: "la politique de confidentialité"
                            }), "." ]
                        }) ]
                    }) ]
                }) ]
            }), e.jsxs("div", {
                className: "flex items-center justify-between gap-3",
                children: [ e.jsx(D, {
                    type: "button",
                    variant: "secondary",
                    onClick: () => a("choose"),
                    disabled: ge,
                    children: "Retour"
                }), e.jsx(D, {
                    type: "button",
                    onClick: Qe,
                    disabled: ge,
                    children: ge ? e.jsxs(e.Fragment, {
                        children: [ e.jsx(V, {}), " Soumission…" ]
                    }) : "Soumettre au médecin"
                }) ]
            }), _e != null && x && e.jsxs("div", {
                className: "text-xs text-gray-500",
                children: [ "Montant sélectionné : ", ne(_e, x.currency) ]
            }) ]
        }), g === "pay" && J && e.jsxs("div", {
            className: "space-y-4",
            children: [ e.jsxs(F, {
                variant: "success",
                children: [ "Demande créée (réf. ", e.jsx("strong", {
                    children: J.uid
                }), "). Merci d’autoriser le paiement pour l’envoyer en traitement." ]
            }), e.jsx(Ve, {
                prescriptionId: J.id,
                priority: N,
                onPaid: () => {
                    a("done");
                }
            }), e.jsxs("div", {
                className: "flex items-center justify-between",
                children: [ e.jsx(D, {
                    type: "button",
                    variant: "secondary",
                    onClick: () => {
                        a("form");
                    },
                    children: "Modifier la demande"
                }), e.jsx("div", {
                    className: "text-xs text-gray-500",
                    children: "Vous pourrez toujours compléter via la messagerie (prochaine étape)."
                }) ]
            }) ]
        }), g === "done" && J && e.jsxs("div", {
            className: "space-y-5",
            children: [ e.jsxs("div", {
                className: "rounded-2xl border border-green-200 bg-green-50 p-6 text-center text-green-950",
                children: [ e.jsx("div", {
                    className: "text-lg font-semibold",
                    children: "Merci ! Votre demande est enregistrée."
                }), e.jsx("div", {
                    className: "mt-4 text-sm text-green-900/80",
                    children: "Numéro de dossier"
                }), e.jsxs("div", {
                    className: "mt-1 flex items-center justify-center gap-2",
                    children: [ e.jsx("div", {
                        className: "font-mono text-3xl font-extrabold tracking-wider",
                        children: J.uid
                    }), e.jsx("button", {
                        type: "button",
                        className: "rounded-md border border-green-300 bg-white px-2 py-1 text-xs font-medium text-green-900 hover:bg-green-100",
                        onClick: Ke,
                        "aria-label": "Copier le numéro de dossier",
                        title: "Copier",
                        children: Be ? "Copié" : "Copier"
                    }) ]
                }), e.jsxs("div", {
                    className: "mt-3 text-sm text-green-900/90",
                    children: [ "Statut : ", e.jsx("span", {
                        className: "font-semibold",
                        children: "en attente d’analyse médicale"
                    }), "." ]
                }) ]
            }), e.jsxs("div", {
                className: "rounded-2xl border border-gray-200 bg-white p-4",
                children: [ e.jsx("div", {
                    className: "text-sm font-semibold text-gray-900",
                    children: "Prochaines étapes"
                }), e.jsxs("ol", {
                    className: "mt-4 space-y-3",
                    children: [ e.jsxs("li", {
                        className: "flex gap-3",
                        children: [ e.jsx("div", {
                            className: "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white",
                            children: "1"
                        }), e.jsxs("div", {
                            className: "text-sm text-gray-700",
                            children: [ e.jsxs("div", {
                                className: "font-medium text-gray-900",
                                children: [ "Analyse médicale en cours", " ", e.jsxs("span", {
                                    className: "font-normal text-gray-500",
                                    children: [ "(délai estimé : ", N === "express" ? "~4h" : "~24h", ")" ]
                                }) ]
                            }), e.jsx("div", {
                                className: "text-gray-600",
                                children: "Un médecin examine votre demande."
                            }) ]
                        }) ]
                    }), e.jsxs("li", {
                        className: "flex gap-3",
                        children: [ e.jsx("div", {
                            className: "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white",
                            children: "2"
                        }), e.jsxs("div", {
                            className: "text-sm text-gray-700",
                            children: [ e.jsx("div", {
                                className: "font-medium text-gray-900",
                                children: "Question éventuelle"
                            }), e.jsx("div", {
                                className: "text-gray-600",
                                children: "Surveillez vos emails : le médecin peut vous poser une question dans votre espace patient."
                            }) ]
                        }) ]
                    }), e.jsxs("li", {
                        className: "flex gap-3",
                        children: [ e.jsx("div", {
                            className: "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white",
                            children: "3"
                        }), e.jsxs("div", {
                            className: "text-sm text-gray-700",
                            children: [ e.jsx("div", {
                                className: "font-medium text-gray-900",
                                children: "Décision & ordonnance"
                            }), e.jsx("div", {
                                className: "text-gray-600",
                                children: "Après décision, votre ordonnance (PDF) sera disponible."
                            }) ]
                        }) ]
                    }) ]
                }) ]
            }), e.jsx("div", {
                className: "flex flex-wrap items-center justify-center gap-3",
                children: Te ? e.jsx("a", {
                    href: Te,
                    className: "inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2",
                    children: "Suivre ma demande"
                }) : e.jsx(D, {
                    type: "button",
                    onClick: Ue,
                    children: "Retour à l'accueil"
                })
            }), e.jsxs(F, {
                variant: "warning",
                children: [ e.jsx("div", {
                    className: "font-semibold",
                    children: "Note importante"
                }), e.jsx("div", {
                    className: "mt-1",
                    children: "Votre dossier est en cours de traitement. Merci de ne pas soumettre de demande en double."
                }) ]
            }) ]
        }) ]
    });
}

function ae(t) {
    const s = (t || "").toLowerCase();
    return s === "payment_pending" ? {
        variant: "warning",
        label: "Paiement à autoriser",
        hint: "Votre demande est créée. Autorisez le paiement pour l’envoyer en analyse médicale."
    } : s === "pending" ? {
        variant: "info",
        label: "En cours d’analyse",
        hint: "Un médecin examine votre dossier. Vous serez notifié ici si une précision est nécessaire."
    } : s === "approved" ? {
        variant: "success",
        label: "Validée",
        hint: "Votre ordonnance est en préparation ou disponible dans le bloc ci-dessous."
    } : s === "rejected" ? {
        variant: "error",
        label: "Refusée",
        hint: "La demande a été refusée. Le motif (si renseigné) apparaît ci-dessous."
    } : {
        variant: "info",
        label: t || "—",
        hint: ""
    };
}

function Nt(t) {
    const s = String(t || "").toLowerCase();
    return s === "approved" || s === "rejected" ? 2 : s === "in_review" || s === "needs_info" ? 1 : 0;
}

function wt({status: t}) {
    const s = Nt(t), n = [ {
        key: "received",
        label: "Reçu"
    }, {
        key: "review",
        label: "Analyse"
    }, {
        key: "decision",
        label: "Décision"
    } ];
    return e.jsx("div", {
        className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4",
        children: n.map(((l, u) => {
            const g = u <= s, a = u === s;
            return e.jsxs("div", {
                className: "flex items-center gap-3",
                children: [ e.jsx("div", {
                    className: "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold " + (g ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 bg-white text-gray-500"),
                    "aria-hidden": "true",
                    children: u + 1
                }), e.jsx("div", {
                    className: "text-sm " + (g ? "text-gray-900" : "text-gray-400") + (a ? " font-semibold" : ""),
                    children: l.label
                }), u < n.length - 1 ? e.jsx("div", {
                    className: "hidden h-px w-10 sm:block " + (u < s ? "bg-blue-600" : "bg-gray-200"),
                    "aria-hidden": "true"
                }) : null ]
            }, l.key);
        }))
    });
}

async function Fe(t, s, n) {
    const l = await fetch(t, {
        method: "GET",
        headers: {
            "X-WP-Nonce": n
        },
        credentials: "same-origin"
    });
    if (!l.ok) throw new Error("Téléchargement impossible (accès refusé ou fichier indisponible).");
    const u = await l.blob(), g = URL.createObjectURL(u), a = document.createElement("a");
    a.href = g, a.download = s || "download", document.body.appendChild(a), a.click(), 
    a.remove(), URL.revokeObjectURL(g);
}

function fetchPatientPdfStatus(t) {
    const s = we(), n = s.restBase.replace(/\/$/, "") + `/prescriptions/${t}/pdf-status?_ts=${Date.now()}`;
    return fetch(n, {
        method: "GET",
        headers: {
            "X-WP-Nonce": s.nonce,
            "X-Sos-Scope": "patient",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache"
        },
        credentials: "same-origin"
    }).then((async l => {
        const u = await l.text();
        let g = u;
        try {
            g = u ? JSON.parse(u) : null;
        } catch {}
        if (!l.ok) {
            const a = g && typeof g.message == "string" ? g.message : "Erreur chargement ordonnance";
            throw new Error(a);
        }
        return g && g.pdf ? g.pdf : null;
    }));
}

function renderPatientPdfCard({pdf: t, pdfLoading: s, pdfError: n}) {
    const l = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500", u = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 bg-white text-gray-900 border border-gray-300 hover:bg-gray-50 hover:text-gray-900 hover:border-gray-400 focus:ring-gray-400", g = typeof (t == null ? void 0 : t.download_url) == "string" && t.download_url.length > 0, a = String((t == null ? void 0 : t.status) || "").toLowerCase(), x = (t == null ? void 0 : t.message) || "Validation médicale confirmée. L’ordonnance est en cours de préparation.";
    return g ? e.jsxs("div", {
        children: [ e.jsx("div", {
            className: "mb-2 text-sm font-semibold text-gray-900",
            children: "Ordonnance"
        }), e.jsxs("div", {
            className: "rounded-xl border border-green-200 bg-green-50 p-4",
            children: [ e.jsx("div", {
                className: "text-sm font-semibold text-green-900",
                children: "Ordonnance disponible"
            }), e.jsx("div", {
                className: "mt-1 text-sm text-green-800",
                children: "Téléchargez ou ouvrez votre ordonnance sécurisée."
            }), e.jsxs("div", {
                className: "mt-3 flex flex-wrap gap-2",
                children: [ e.jsx("a", {
                    href: t.download_url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: l,
                    children: "Télécharger mon ordonnance"
                }), e.jsx("a", {
                    href: t.download_url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: u,
                    children: "Ouvrir le PDF"
                }) ]
            }) ]
        }) ]
    }) : s ? e.jsxs("div", {
        children: [ e.jsx("div", {
            className: "mb-2 text-sm font-semibold text-gray-900",
            children: "Ordonnance"
        }), e.jsx(F, {
            variant: "info",
            children: e.jsxs("div", {
                className: "flex items-center gap-2",
                children: [ e.jsx(V, {}), e.jsx("span", {
                    children: "Validation médicale confirmée. Génération de l’ordonnance en cours…"
                }) ]
            })
        }) ]
    }) : n || a === "failed" ? e.jsxs("div", {
        children: [ e.jsx("div", {
            className: "mb-2 text-sm font-semibold text-gray-900",
            children: "Ordonnance"
        }), e.jsx(F, {
            variant: "error",
            children: n || ((t == null ? void 0 : t.last_error_message) || "L’ordonnance n’est pas encore disponible. Réessayez dans un instant.")
        }) ]
    }) : e.jsxs("div", {
        children: [ e.jsx("div", {
            className: "mb-2 text-sm font-semibold text-gray-900",
            children: "Ordonnance"
        }), e.jsx(F, {
            variant: "info",
            children: x
        }) ]
    });
}

function St() {
    var K;
    const t = we(), s = ((K = t.currentUser) == null ? void 0 : K.id) && t.currentUser.id > 0, [n, l] = c.useState([]), [u, g] = c.useState(!1), [a, x] = c.useState(null), [o, b] = c.useState(null), [v, M] = c.useState(!1), [B, H] = c.useState(null), [J, X] = c.useState(!1), [oe, pe] = c.useState(null), [C, h] = c.useState([]), [ye, He] = c.useState(null), [_, N] = c.useState(!1), [i, S] = c.useState(""), [A, q] = c.useState(!1), [I, O] = c.useState([]), [m, j] = c.useState(!1), f = c.useRef(null), te = c.useRef(null), [P, k] = c.useState(null), ce = () => {
        te.current && (window.clearTimeout(te.current), te.current = null);
    }, me = async (d, p = !1) => {
        if (!d) return null;
        ce(), p || X(!0), pe(null);
        try {
            const R = await fetchPatientPdfStatus(d);
            return H(R || null), R || null;
        } catch (R) {
            const T = R != null && R.message ? String(R.message) : "Erreur chargement ordonnance";
            return p || pe(T), H(null), null;
        } finally {
            p || X(!1);
        }
    }, E = async () => {
        k(null), g(!0);
        try {
            const d = await at(), p = d || [];
            l(p);
            let R = a;
            if (p.length > 0) if (R != null && p.some((L => Number(L == null ? void 0 : L.id) === Number(R)))) ; else {
                const L = spPatientChatUidFromLocation(), Q = L ? p.find((te => String((te == null ? void 0 : te.uid) || "") === L)) : null, fe = new URLSearchParams(window.location.search).get("rx"), Ie = fe ? Number.parseInt(fe, 10) : NaN, be = Number.isFinite(Ie) ? p.find((te => Number(te == null ? void 0 : te.id) === Ie)) : null;
                R = Number((Q || be || p[0]).id);
            } else R = null;
            return x(R), R;
        } catch (d) {
            return k(d != null && d.message ? String(d.message) : "Erreur chargement"), l([]), 
            x(null), null;
        } finally {
            g(!1);
        }
    }, Y = async d => {
        k(null), M(!0);
        try {
            const p = await it(d);
            return b(p), spSyncPatientChatLocation(String((p == null ? void 0 : p.uid) || "")), p;
        } catch (p) {
            return k(p != null && p.message ? String(p.message) : "Erreur chargement"), b(null), 
            spSyncPatientChatLocation(""), null;
        } finally {
            M(!1);
        }
    }, G = async d => {
        k(null), N(!0);
        try {
            const p = await lt(d), R = Array.isArray(p == null ? void 0 : p.messages) ? p.messages : [], T = p && typeof p.thread_state == "object" ? p.thread_state : null;
            h(R), He(T);
            if (T && Number(T.unread_count_patient || 0) > 0) try {
                const L = await mtReadApi(d, Number(T.last_message_seq || 0)), Q = L && typeof L.thread_state == "object" ? L.thread_state : T;
                He(Q);
            } catch {}
            return R;
        } catch (p) {
            return k(p != null && p.message ? String(p.message) : "Erreur messagerie"), h([]), 
            He(null), [];
        } finally {
            N(!1);
        }
    }, de = () => {
        E(), a && (Y(a), me(a, !0)), spDispatchPatientChatRefresh({
            reason: "manual_refresh"
        });
    };
    c.useEffect((() => {
        if (!s) return;
        E();
        return ce;
    }), [ s ]), c.useEffect((() => {
        if (!s) return;
        if (!a) {
            b(null), h([]), He(null), H(null), pe(null), ce(), spSyncPatientChatLocation(""), spDispatchPatientChatRefresh({
                reason: "selection_cleared"
            });
            return;
        }
        b(null), h([]), He(null), H(null), pe(null), Y(a), S(""), O([]), spDispatchPatientChatRefresh({
            reason: "selection_changed"
        });
    }), [ a, s ]);
    const le = c.useMemo((() => {
        const d = {};
        return ((o == null ? void 0 : o.files) || []).forEach((p => {
            d[p.id] = p;
        })), I.forEach((p => {
            d[p.id] = p;
        })), d;
    }), [ o == null ? void 0 : o.files, I ]), W = c.useMemo((() => n.find((d => d.id === a)) || null), [ n, a ]);
    c.useEffect((() => {
        const d = String((o == null ? void 0 : o.status) || ((W == null ? void 0 : W.status) || "")).toLowerCase();
        if (!s || !a) {
            ce(), H(null), pe(null);
            return;
        }
        if (d !== "approved") {
            ce(), H(null), pe(null);
            return;
        }
        me(a);
        return ce;
    }), [ a, s, o == null ? void 0 : o.status, W == null ? void 0 : W.status ]), c.useEffect((() => {
        const d = String((o == null ? void 0 : o.status) || ((W == null ? void 0 : W.status) || "")).toLowerCase(), p = String((B == null ? void 0 : B.status) || "").toLowerCase(), R = !!(B != null && B.download_url);
        if (ce(), !s || !a || d !== "approved" || R || p === "failed") return;
        return te.current = window.setTimeout((() => {
            me(a, !0);
        }), 12e3), ce;
    }), [ a, s, o == null ? void 0 : o.status, W == null ? void 0 : W.status, B == null ? void 0 : B.status, B == null ? void 0 : B.download_url ]);
    const ee = async d => {
        if (!(!d || d.length === 0 || !a)) {
            k(null), j(!0);
            try {
                const p = Array.from(d), R = [];
                for (const T of p) {
                    const L = await ze(T, "message", a);
                    R.push(L);
                }
                O((T => [ ...T, ...R ]));
            } catch (p) {
                k(p != null && p.message ? String(p.message) : "Erreur upload");
            } finally {
                j(!1);
            }
        }
    }, U = async () => {
        if (!a) return;
        const d = i.trim();
        if (d) {
            k(null), q(!0);
            try {
                const p = I.map((T => String(T.id))).filter(Boolean), R = await ot(a, d, p.length > 0 ? p : void 0), T = R && R.message ? R.message : null, L = R && typeof R.thread_state == "object" ? R.thread_state : null;
                T && h((Q => [ ...Q, T ])), L && He(L), S(""), O([]), await G(a), E();
            } catch (p) {
                k(p != null && p.message ? String(p.message) : "Erreur envoi");
            } finally {
                q(!1);
            }
        }
    }, GeOpen = async d => {
        if (!a || !d) return;
        try {
            const p = await artifactAccessApi(d, a, "attachment"), R = p && p.access && p.access.url;
            if (!R) throw new Error("Accès au document impossible.");
            const T = document.createElement("a");
            T.href = String(R), T.target = "_blank", T.rel = "noopener noreferrer", document.body.appendChild(T), 
            T.click(), T.remove();
        } catch (p) {
            k(p != null && p.message ? String(p.message) : "Erreur document");
        }
    }, JeRead = async () => {
        if (!a) return;
        try {
            const d = Number((ye == null ? void 0 : ye.last_message_seq) || 0), p = await mtReadApi(a, d), R = p && typeof p.thread_state == "object" ? p.thread_state : null;
            R && He(R), E();
        } catch (p) {
            k(p != null && p.message ? String(p.message) : "Erreur messagerie");
        }
    };
    return s ? e.jsxs("div", {
        className: "mx-auto max-w-6xl p-4",
        children: [ e.jsxs("div", {
            className: "mb-4 flex flex-wrap items-start justify-between gap-3",
            children: [ e.jsxs("div", {
                children: [ e.jsx("div", {
                    className: "text-xl font-semibold text-gray-900",
                    children: "Espace patient"
                }), e.jsx("div", {
                    className: "text-sm text-gray-600",
                    children: "Suivi de vos demandes • messagerie asynchrone"
                }) ]
            }), e.jsx("div", {
                className: "flex items-center gap-2",
                children: e.jsx(D, {
                    type: "button",
                    variant: "secondary",
                    onClick: de,
                    disabled: u || v || _ || J,
                    children: u || v || _ || J ? e.jsx(V, {}) : "Rafraîchir"
                })
            }) ]
        }), P && e.jsx("div", {
            className: "mb-4",
            children: e.jsx(F, {
                variant: "error",
                children: P
            })
        }), e.jsxs("div", {
            className: "grid grid-cols-1 gap-4 lg:grid-cols-3",
            children: [ e.jsx("div", {
                className: "lg:col-span-1",
                children: e.jsxs("div", {
                    className: "rounded-xl border border-gray-200 bg-white",
                    children: [ e.jsx("div", {
                        className: "border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900",
                        children: "Mes demandes"
                    }), e.jsxs("div", {
                        className: "max-h-[560px] overflow-auto",
                        children: [ n.length === 0 && e.jsx("div", {
                            className: "px-4 py-3 text-sm text-gray-600",
                            children: u ? "Chargement…" : "Aucune demande."
                        }), n.map((d => {
                            const p = ae(d.status);
                            return e.jsxs("button", {
                                type: "button",
                                className: `block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${a === d.id ? "bg-blue-50" : ""}`,
                                onClick: () => x(d.id),
                                children: [ e.jsx("div", {
                                    className: "text-sm font-semibold text-gray-900",
                                    children: d.uid
                                }), e.jsx("div", {
                                    className: "mt-1 text-xs text-gray-600",
                                    children: p.label
                                }), e.jsx("div", {
                                    className: "mt-1 text-xs text-gray-500",
                                    children: d.created_at
                                }) ]
                            }, d.id);
                        })) ]
                    }) ]
                })
            }), e.jsx("div", {
                className: "lg:col-span-2",
                children: e.jsxs("div", {
                    className: "rounded-xl border border-gray-200 bg-white p-4",
                    children: [ !a && e.jsx("div", {
                        className: "text-sm text-gray-600",
                        children: "Sélectionnez une demande à gauche."
                    }), a && v && e.jsxs("div", {
                        className: "flex items-center gap-2 text-sm text-gray-600",
                        children: [ e.jsx(V, {}), " Chargement…" ]
                    }), a && o && e.jsxs("div", {
                        className: "space-y-5",
                        children: [ e.jsx("div", {
                            children: e.jsxs("div", {
                                className: "text-lg font-semibold text-gray-900",
                                children: [ "Demande ", o.uid ]
                            })
                        }), e.jsx(F, {
                            variant: ae(o.status).variant,
                            children: e.jsxs("div", {
                                className: "flex flex-col gap-3",
                                children: [ e.jsx(wt, {
                                    status: o.status
                                }), e.jsxs("div", {
                                    children: [ e.jsx("div", {
                                        className: "font-semibold",
                                        children: ae(o.status).label
                                    }), ae(o.status).hint && e.jsx("div", {
                                        className: "mt-1",
                                        children: ae(o.status).hint
                                    }) ]
                                }) ]
                            })
                        }), o.status === "approved" && e.jsx(renderPatientPdfCard, {
                            pdf: B,
                            pdfLoading: J,
                            pdfError: oe
                        }), o.status === "payment_pending" && e.jsx(Ve, {
                            prescriptionId: o.id,
                            priority: (W == null ? void 0 : W.priority) === "express" || o.priority === "express" ? "express" : "standard",
                            onPaid: () => {
                                a && (Y(a), E());
                            }
                        }), o.status === "rejected" && o.decision_reason && e.jsxs(F, {
                            variant: "error",
                            children: [ e.jsx("div", {
                                className: "font-semibold",
                                children: "Motif"
                            }), e.jsx("div", {
                                className: "mt-1 whitespace-pre-wrap",
                                children: o.decision_reason
                            }) ]
                        }), e.jsxs("div", {
                            children: [ e.jsx("div", {
                                className: "mb-2 text-sm font-semibold text-gray-900",
                                children: "Documents"
                            }), (o.files || []).length === 0 ? e.jsx("div", {
                                className: "text-sm text-gray-600",
                                children: "Aucun document pour le moment."
                            }) : e.jsx("div", {
                                className: "space-y-2",
                                children: (o.files || []).map((d => e.jsxs("div", {
                                    className: "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2",
                                    children: [ e.jsxs("div", {
                                        className: "min-w-0",
                                        children: [ e.jsx("div", {
                                            className: "truncate text-sm font-medium text-gray-900",
                                            children: d.original_name
                                        }), e.jsxs("div", {
                                            className: "text-xs text-gray-600",
                                            children: [ filePurposeLabel(d.purpose), " • ", d.mime, " • ", Math.round((d.size_bytes || 0) / 1024), " Ko" ]
                                        }) ]
                                    }), e.jsx(D, {
                                        type: "button",
                                        variant: "secondary",
                                        onClick: () => Fe(d.download_url, d.original_name, t.nonce),
                                        children: "Télécharger"
                                    }) ]
                                }, d.id)))
                            }) ]
                        }), e.jsxs("div", {
                            children: [ e.jsx("div", {
                                className: "mb-2 text-sm font-semibold text-gray-900",
                                children: "Médicaments"
                            }), e.jsxs("div", {
                                className: "space-y-2",
                                children: [ o.items.map(((d, p) => e.jsxs("div", {
                                    className: "rounded-lg border border-gray-100 bg-gray-50 p-3",
                                    children: [ e.jsx("div", {
                                        className: "text-sm font-semibold text-gray-900",
                                        children: d.denomination
                                    }), d.posologie && e.jsxs("div", {
                                        className: "mt-1 text-sm text-gray-700",
                                        children: [ "Posologie : ", d.posologie ]
                                    }), d.quantite && e.jsxs("div", {
                                        className: "mt-1 text-sm text-gray-700",
                                        children: [ "Quantité : ", d.quantite ]
                                    }) ]
                                }, p))), o.items.length === 0 && e.jsx("div", {
                                    className: "text-sm text-gray-600",
                                    children: "—"
                                }) ]
                            }) ]
                        }), e.jsx("div", {
                            children: e.jsx("sp-patient-text-chat", {
                                "data-rx-uid": String((o == null ? void 0 : o.uid) || ""),
                                "data-rx-status": String((o == null ? void 0 : o.status) || "")
                            })
                        }) ]
                    }) ]
                })
            }) ]
        }) ]
    }) : e.jsx("div", {
        className: "mx-auto max-w-3xl p-4",
        children: e.jsx(F, {
            variant: "warning",
            children: "Connexion requise. Merci de vous connecter pour accéder à votre espace patient."
        })
    });
}

const je = document.getElementById("sosprescription-root-form");

if (je) {
    const t = (je.getAttribute("data-app") || "").toLowerCase();
    ct.createRoot(je).render(e.jsx(dt.StrictMode, {
        children: t === "patient" ? e.jsx(St, {}) : e.jsx(vt, {})
    }));
}
