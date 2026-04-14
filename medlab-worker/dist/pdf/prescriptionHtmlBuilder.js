"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrescriptionHtmlBuilder = void 0;
// src/pdf/prescriptionHtmlBuilder.ts
const node_crypto_1 = __importDefault(require("node:crypto"));
const code39Svg_1 = require("./assets/code39Svg");
const qrSvg_1 = require("./assets/qrSvg");
const templateRegistry_1 = require("./templateRegistry");
class PrescriptionHtmlBuilder {
    templateRegistry;
    signatureLoader;
    logger;
    verifyBaseUrl;
    defaultTemplateVariant;
    constructor(cfg = {}) {
        this.templateRegistry = cfg.templateRegistry ?? new templateRegistry_1.TemplateRegistry();
        this.signatureLoader = cfg.signatureLoader ?? null;
        this.logger = cfg.logger;
        this.verifyBaseUrl = normalizeVerifyBaseUrl(cfg.verifyBaseUrl ?? process.env.ML_VERIFY_BASE_URL ?? "https://sosprescription.fr");
        this.defaultTemplateVariant = (0, templateRegistry_1.normalizeTemplateVariant)(cfg.defaultTemplateVariant ?? process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern");
    }
    async buildHtml(input) {
        const templateVariant = (0, templateRegistry_1.normalizeTemplateVariant)(input.templateVariant ?? this.defaultTemplateVariant);
        const template = await this.templateRegistry.getTemplate(templateVariant);
        const aggregate = input.aggregate;
        const doctor = buildDoctorProfile(aggregate);
        const verifyUrl = buildVerificationUrl(this.verifyBaseUrl, aggregate.prescription.verifyToken);
        const qrDataUri = await (0, qrSvg_1.buildQrDataUri)(verifyUrl || `rx:${aggregate.prescription.uid || aggregate.prescription.id}`);
        const normalizedSignatureKey = normalizeSignatureS3Key(doctor.signatureS3Key);
        let signatureDataUri = "";
        if (this.signatureLoader && normalizedSignatureKey !== "") {
            try {
                signatureDataUri = await this.signatureLoader.loadFromKey(normalizedSignatureKey);
            }
            catch (err) {
                this.logger?.warning("pdf.signature.load_failed", {
                    prescription_id: aggregate.prescription.id,
                    doctor_id: doctorKeyForAudit(aggregate),
                    sig_key_tail: signatureKeyTail(normalizedSignatureKey),
                    reason: err instanceof Error ? err.message : "signature_load_failed",
                }, input.reqId, err);
            }
        }
        const rppsBarcodeDataUri = doctor.rpps !== "" ? (0, code39Svg_1.buildCode39DataUri)(doctor.rpps) : "";
        const signatureImgHtml = signatureDataUri !== ""
            ? `<img class="sig-img" src="${escapeHtmlAttr(signatureDataUri)}" alt="Signature du médecin" />`
            : buildSignatureFallbackHtml(doctor);
        const qrImgHtml = `<img class="qr qr-img" src="${escapeHtmlAttr(qrDataUri !== "" ? qrDataUri : blankImageDataUri())}" alt="QR Code de vérification" />`;
        const rppsBarcodeHtml = rppsBarcodeDataUri !== ""
            ? `<img class="doctor-rpps-barcode" src="${escapeHtmlAttr(rppsBarcodeDataUri)}" alt="Code RPPS" />`
            : "";
        const doctorBlock = buildDoctorBlockHtml(doctor, rppsBarcodeDataUri);
        const patientBlock = buildPatientBlockHtml(aggregate);
        const medRows = buildMedicationRowsHtml(aggregate);
        const medBlocks = buildLegacyMedicationBlocksHtml(aggregate);
        const footerBlock = buildFooterBlockHtml(aggregate, verifyUrl, doctor);
        const headerBadgeHtml = buildHeaderBadgeHtml(aggregate.prescription.verifyCode);
        const hashShort = node_crypto_1.default
            .createHash("sha256")
            .update(`${aggregate.prescription.uid}|${aggregate.prescription.verifyToken ?? ""}`, "utf8")
            .digest("hex")
            .slice(0, 12);
        const replacements = {
            "{{DOCTOR_BLOCK}}": doctorBlock,
            "{{PATIENT_BLOCK}}": patientBlock,
            "{{MEDICATIONS_LIST}}": medRows,
            "{{QR_CODE}}": escapeHtmlAttr(qrDataUri !== "" ? qrDataUri : blankImageDataUri()),
            "{{SIGNATURE_IMAGE}}": escapeHtmlAttr(signatureDataUri !== "" ? signatureDataUri : blankImageDataUri()),
            "{{FOOTER_BLOCK}}": footerBlock,
            "{{ADDRESS}}": nl2brEscaped(doctor.address !== "" ? doctor.address : "—"),
            "{{BARCODE_HTML}}": rppsBarcodeHtml !== "" ? rppsBarcodeHtml : qrImgHtml,
            "{{DELIVERY_CODE}}": escapeHtml(aggregate.prescription.verifyCode ?? "—"),
            "{{DIPLOMA_LINE}}": escapeHtml(doctor.diplomaLine),
            "{{DOCTOR_DISPLAY}}": escapeHtml(doctor.fullName),
            "{{HASH_SHORT}}": escapeHtml(hashShort),
            "{{ISSUE_LINE}}": "",
            "{{HEADER_BADGE_HTML}}": headerBadgeHtml,
            "{{MEDICATIONS_HTML}}": medBlocks,
            "{{MED_COUNT}}": escapeHtml(String(countMedicationItems(aggregate.prescription.items) || 1)),
            "{{PATIENT_BIRTH_LABEL}}": escapeHtml(buildPatientBirthLabel(aggregate) || "—"),
            "{{PATIENT_NAME}}": escapeHtml(buildPatientName(aggregate) || "Patient"),
            "{{PATIENT_WH_LABEL}}": escapeHtml(buildPatientWeightLabel(aggregate) || "—"),
            "{{PHONE}}": escapeHtml(doctor.phone || "—"),
            "{{QR_IMG_HTML}}": qrImgHtml,
            "{{RPPS}}": escapeHtml(doctor.rpps || "—"),
            "{{RPPS_BARCODE}}": escapeHtmlAttr(rppsBarcodeDataUri),
            "{{RPPS_BARCODE_HTML}}": rppsBarcodeHtml,
            "{{RX_PUBLIC_ID}}": escapeHtml(verifyUrl !== "" ? verifyUrl : aggregate.prescription.uid),
            "{{SIGNATURE_IMG_HTML}}": signatureImgHtml,
            "{{SPECIALTY}}": escapeHtml(doctor.specialty || "Médecin prescripteur"),
            "{{UID}}": escapeHtml(aggregate.prescription.uid),
        };
        let html = template.html;
        for (const [needle, replacement] of Object.entries(replacements)) {
            html = html.split(needle).join(replacement);
        }
        html = injectPrescriptionGradeStyles(html);
        html = injectMetaAndReadiness(html, aggregate, input.reqId, input.jobId, template.templateName);
        this.logger?.info("pdf.html.built", {
            prescription_id: aggregate.prescription.id,
            doctor_id: doctorKeyForAudit(aggregate),
            job_id: input.jobId,
            template: template.templateName,
            template_variant: template.variant,
            sig_key_present: normalizedSignatureKey !== "",
            sig_present: signatureDataUri !== "",
            verify_enabled: verifyUrl !== "",
            items_count: countMedicationItems(aggregate.prescription.items),
        }, input.reqId);
        return {
            html,
            templateName: template.templateName,
            templateVariant: template.variant,
            verifyUrl,
        };
    }
}
exports.PrescriptionHtmlBuilder = PrescriptionHtmlBuilder;
function buildDoctorProfile(aggregate) {
    const doctor = aggregate.doctor;
    const firstName = normalizeHumanString(doctor.firstName);
    const lastName = normalizeHumanString(doctor.lastName);
    let displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (displayName === "") {
        displayName = "Médecin prescripteur";
    }
    const title = mapDoctorTitle(doctor.title);
    const specialty = normalizeHumanString(doctor.specialty) || "Médecin prescripteur";
    const rpps = sanitizeDigits(doctor.rpps);
    const address = buildDoctorAddress(doctor.address, doctor.zipCode, doctor.city);
    const phone = formatFrenchInternationalPhone(doctor.twilioPhone);
    const university = normalizeString(doctor.university);
    const distinctions = normalizeString(doctor.distinctions);
    const fullName = title !== "" && !displayName.toLowerCase().startsWith(title.toLowerCase())
        ? `${title} ${displayName}`.trim()
        : displayName;
    const diplomaLine = university !== ""
        ? `Diplômé de la faculté de médecine de ${university}`
        : "";
    return {
        fullName,
        specialty,
        rpps,
        address,
        phone,
        university,
        distinctions,
        diplomaLine,
        issuePlace: normalizeString(doctor.city),
        signatureS3Key: doctor.signatureS3Key,
    };
}
function buildDoctorAddress(address, zipCode, city) {
    const base = normalizeString(address);
    const cityLine = [normalizeString(zipCode), normalizeString(city)].filter(Boolean).join(" ").trim();
    if (base !== "" && cityLine !== "") {
        if (base.toLowerCase().includes(cityLine.toLowerCase())) {
            return base;
        }
        return `${base}\n${cityLine}`;
    }
    return base || cityLine;
}
function buildVerificationUrl(baseUrl, verifyToken) {
    const token = normalizeString(verifyToken);
    if (token === "") {
        return "";
    }
    return `${baseUrl}/v/${encodeURIComponent(token)}`;
}
function buildDoctorBlockHtml(doctor, rppsBarcodeDataUri) {
    const lines = [];
    lines.push(`<div class="doctor-name">${escapeHtml(doctor.fullName)}</div>`);
    if (doctor.specialty !== "") {
        lines.push(`<div class="doctor-specialty">${escapeHtml(doctor.specialty)}</div>`);
    }
    if (doctor.diplomaLine !== "") {
        lines.push(`<div class="doctor-diploma">${escapeHtml(doctor.diplomaLine)}</div>`);
    }
    if (doctor.distinctions !== "") {
        lines.push(`<div class="doctor-distinctions">${escapeHtml(`Distinctions : ${doctor.distinctions}`)}</div>`);
    }
    const metaRows = [];
    if (doctor.address !== "") {
        metaRows.push(buildLabeledValueRowHtml("Adresse", nl2brEscaped(doctor.address), true));
    }
    if (doctor.phone !== "") {
        metaRows.push(buildLabeledValueRowHtml("Téléphone", escapeHtml(doctor.phone), true));
    }
    if (doctor.rpps !== "") {
        metaRows.push(buildLabeledValueRowHtml("RPPS", escapeHtml(doctor.rpps), true));
    }
    if (metaRows.length > 0) {
        lines.push(`<div class="doctor-meta-grid">${metaRows.join("\n")}</div>`);
    }
    if (doctor.rpps !== "" && rppsBarcodeDataUri !== "") {
        lines.push([
            '<div class="doctor-rpps-panel">',
            '  <div class="doctor-rpps-heading">Code RPPS</div>',
            `  <img class="doctor-rpps-barcode" src="${escapeHtmlAttr(rppsBarcodeDataUri)}" alt="Code RPPS ${escapeHtmlAttr(doctor.rpps)}" />`,
            '</div>',
        ].join("\n"));
    }
    return lines.join("\n");
}
function buildPatientBlockHtml(aggregate) {
    const rows = [];
    const patientName = buildPatientName(aggregate) || "Patient";
    const birthLabel = buildPatientBirthLabel(aggregate) || "—";
    const weightLabel = buildPatientWeightLabel(aggregate);
    rows.push(buildLabeledValueRowHtml("Nom", escapeHtml(patientName), true));
    rows.push(buildLabeledValueRowHtml("Date de naissance", escapeHtml(birthLabel), true));
    if (weightLabel !== "") {
        rows.push(buildLabeledValueRowHtml("Poids", escapeHtml(weightLabel), true));
    }
    return `<div class="patient-grid">${rows.join("\n")}</div>`;
}
function buildMedicationRowsHtml(aggregate) {
    const items = coerceItemArray(aggregate.prescription.items);
    if (items.length < 1) {
        return '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
    }
    const rows = [];
    for (const item of items) {
        const view = buildMedicationViewModel(item);
        const nameHtml = view.meta !== ""
            ? `<div class="med-name">${escapeHtml(view.label)}</div><div class="med-meta">${escapeHtml(view.meta)}</div>`
            : `<div class="med-name">${escapeHtml(view.label)}</div>`;
        rows.push([
            '<tr>',
            `  <td>${nameHtml}</td>`,
            `  <td><div class="med-posology">${escapeHtml(view.posology)}</div></td>`,
            `  <td><div class="med-duration">${escapeHtml(view.duration)}</div></td>`,
            '</tr>',
        ].join("\n"));
    }
    return rows.length > 0
        ? rows.join("\n")
        : '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
}
function buildLegacyMedicationBlocksHtml(aggregate) {
    const items = coerceItemArray(aggregate.prescription.items);
    if (items.length < 1) {
        return '<div class="med-row"><div class="med-posology">Aucune ligne trouvée.</div></div>';
    }
    const blocks = [];
    for (const item of items) {
        const view = buildMedicationViewModel(item);
        const detailParts = [];
        if (view.posology !== "—") {
            detailParts.push(`Posologie : ${view.posology}`);
        }
        if (view.duration !== "—") {
            detailParts.push(`Durée : ${view.duration}`);
        }
        if (view.meta !== "") {
            detailParts.push(view.meta);
        }
        if (detailParts.length < 1) {
            detailParts.push("Sans précision complémentaire.");
        }
        blocks.push([
            '<div class="med-row">',
            '  <table class="med-table" cellpadding="0" cellspacing="0">',
            '    <tr>',
            '      <td class="med-dot-cell"><div class="med-dot"></div></td>',
            '      <td>',
            `        <div class="med-name-wrap"><span class="med-name">${escapeHtml(view.label)}</span></div>`,
            `        <div class="med-posology">${escapeHtml(detailParts.join(" — "))}</div>`,
            '      </td>',
            '    </tr>',
            '  </table>',
            '</div>',
        ].join("\n"));
    }
    return blocks.join("\n");
}
function buildMedicationViewModel(item) {
    const obj = asRecord(item);
    const raw = asRecord(obj.raw);
    const schedule = asRecord(raw.schedule ?? obj.schedule);
    const label = firstNonEmpty([
        obj.denomination,
        obj.label,
        obj.name,
        obj.medication,
        obj.drug,
        raw.label,
        raw.name,
    ]) || "Médicament";
    let duration = firstNonEmpty([
        obj.duration_label,
        obj.durationLabel,
        obj.durationText,
        obj.duration,
        obj.duree,
        raw.duration_label,
        raw.durationLabel,
        raw.durationText,
        raw.duration,
    ]);
    if (duration === "") {
        duration = extractDurationLabelFromSchedule(schedule);
    }
    if (duration === "") {
        duration = "—";
    }
    const generatedPosology = hasStructuredSchedule(schedule) ? scheduleToText(schedule) : "";
    let posology = generatedPosology || firstNonEmpty([
        obj.posologie,
        obj.instructions,
        obj.instruction,
        obj.dosage,
        obj.scheduleText,
        raw.posologie,
        raw.instructions,
        raw.scheduleText,
        sanitizeScheduleNote(schedule.note, duration),
        sanitizeScheduleNote(schedule.text, duration),
        sanitizeScheduleNote(schedule.label, duration),
    ]);
    if (generatedPosology === "") {
        posology = stripDurationFromPosology(posology, duration);
    }
    posology = normalizeLooseText(posology);
    if (posology === "") {
        posology = "—";
    }
    const metaParts = [];
    const cip13 = sanitizeDigits(firstNonEmpty([obj.cip13, raw.cip13]));
    if (cip13 !== "") {
        metaParts.push(`CIP13 ${cip13}`);
    }
    const quantite = firstNonEmpty([obj.quantite, raw.quantite, obj.quantity, raw.quantity]);
    if (quantite !== "") {
        metaParts.push(`Quantité : ${quantite}`);
    }
    const scheduleNote = sanitizeScheduleNote(stripDurationFromPosology(firstNonEmpty([schedule.note, obj.note, raw.note]), duration), duration);
    if (scheduleNote !== "" && normalizeString(scheduleNote) !== normalizeString(posology)) {
        metaParts.push(scheduleNote);
    }
    return {
        label,
        posology,
        duration,
        meta: metaParts.join(" — "),
    };
}
function hasStructuredSchedule(schedule) {
    const nb = toPositiveInt(schedule.nb ?? schedule.timesPerDay);
    const freqUnit = normalizeScheduleUnit(schedule.freqUnit ?? schedule.frequencyUnit ?? schedule.freq);
    if (nb > 0 && freqUnit !== "") {
        return true;
    }
    if (toPositiveInt(schedule.everyHours) > 0) {
        return true;
    }
    if (toPositiveInt(schedule.morning) > 0) {
        return true;
    }
    if (toPositiveInt(schedule.noon) > 0) {
        return true;
    }
    if (toPositiveInt(schedule.evening) > 0) {
        return true;
    }
    if (toPositiveInt(schedule.bedtime) > 0) {
        return true;
    }
    if (toBoolean(schedule.asNeeded)) {
        return true;
    }
    if (coerceStringArray(schedule.times).length > 0) {
        return true;
    }
    if (coerceStringArray(schedule.doses).length > 0) {
        return true;
    }
    return false;
}
function sanitizeScheduleNote(value, durationLabel) {
    const note = stripDurationFromPosology(value, durationLabel);
    if (note === "") {
        return "";
    }
    const duration = normalizeLooseText(durationLabel).toLowerCase();
    if (duration === "") {
        return note;
    }
    const lowered = note.toLowerCase();
    if (lowered === duration) {
        return "";
    }
    if (lowered === `pendant ${duration}`) {
        return "";
    }
    if (lowered === `durant ${duration}`) {
        return "";
    }
    if (lowered === `sur ${duration}`) {
        return "";
    }
    return note;
}
function normalizeLooseText(value) {
    return String(value ?? "")
        .replace(/[  ]/g, " ")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function buildFlexibleSpacePattern(value) {
    return normalizeLooseText(value)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "[\\s\\u00A0\\u202F\\r\\n]+");
}
function stripDurationFromPosology(text, durationLabel) {
    const raw = normalizeLooseText(text);
    if (raw === "") {
        return "";
    }
    let cleaned = raw;
    const duration = normalizeLooseText(durationLabel);
    if (duration !== "") {
        const durationPattern = buildFlexibleSpacePattern(duration);
        cleaned = cleaned.replace(new RegExp(`(?:\\s|^)(?:,|;|\\.|:|—|-)?\\s*(?:pendant|durant|sur)\\s+${durationPattern}(?=(?:\\s|$|[(),.;:]))`, "ig"), " ");
        cleaned = cleaned.replace(new RegExp(`(?:\\s|^)(?:,|;|\\.|:|—|-)?\\s*${durationPattern}(?=(?:\\s*$|\\s+[)\\].,;:]|[)\\].,;:]))`, "ig"), " ");
    }
    cleaned = cleaned.replace(/(?:\s|^)(?:,|;|\.|:|—|-)?\s*(?:pendant|durant|sur)\s+\d+\s*(?:j(?:ours?)?|sem(?:aines?)?|mois)(?=(?:\s|$|[(),.;:]))/ig, " ");
    cleaned = cleaned
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.;:])/g, "$1")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/[—-]\s*$/, "")
        .replace(/[,.;:]\s*$/, "")
        .trim();
    return cleaned || raw;
}
function scheduleToText(schedule) {
    const nb = toPositiveInt(schedule.nb ?? schedule.timesPerDay);
    const freqUnit = normalizeScheduleUnit(schedule.freqUnit ?? schedule.frequencyUnit ?? schedule.freq);
    const times = coerceStringArray(schedule.times);
    const doses = coerceStringArray(schedule.doses);
    const inferredCount = Math.max(nb, times.length, doses.length);
    if (inferredCount > 0) {
        const unitLabel = freqUnit || "jour";
        const base = `${inferredCount > 1 ? `${inferredCount} fois` : "1 fois"} par ${unitLabel}`;
        const details = [];
        for (let i = 0; i < inferredCount; i += 1) {
            const time = normalizeString(times[i]);
            const dose = normalizeString(doses[i]);
            if (!time && !dose) {
                continue;
            }
            details.push(`${dose || "1"}@${time || "--:--"}`);
        }
        let out = base;
        if (details.length > 0) {
            out += ` (${details.join(", ")})`;
        }
        return normalizeLooseText(out);
    }
    const parts = [];
    const momentMap = [
        ["morning", "matin"],
        ["noon", "midi"],
        ["evening", "soir"],
        ["bedtime", "coucher"],
    ];
    for (const [key, label] of momentMap) {
        const value = toPositiveInt(schedule[key]);
        if (value > 0) {
            parts.push(`${label}: ${value}`);
        }
    }
    const everyHours = toPositiveInt(schedule.everyHours);
    if (everyHours > 0) {
        parts.push(`Toutes les ${everyHours} h`);
    }
    if (toBoolean(schedule.asNeeded)) {
        parts.push("si besoin");
    }
    if (parts.length > 0) {
        return normalizeLooseText(parts.join(" — "));
    }
    return normalizeLooseText(firstNonEmpty([schedule.text, schedule.label]));
}
function extractDurationLabelFromSchedule(schedule) {
    const value = toPositiveInt(schedule.durationVal ?? schedule.durationValue ?? schedule.duration);
    const unit = normalizeScheduleUnit(schedule.durationUnit ?? schedule.unit);
    if (value < 1 || unit === "") {
        return "";
    }
    return `${value} ${pluralizeDurationUnit(unit, value)}`;
}
function pluralizeDurationUnit(unit, value) {
    const normalized = normalizeScheduleUnit(unit);
    if (normalized === "") {
        return "";
    }
    if (value <= 1 || normalized === "mois") {
        return normalized;
    }
    return `${normalized}s`;
}
function normalizeScheduleUnit(value) {
    const normalized = normalizeString(value).toLowerCase();
    if (["jour", "jours", "j", "day", "days"].includes(normalized)) {
        return "jour";
    }
    if (["semaine", "semaines", "sem", "week", "weeks"].includes(normalized)) {
        return "semaine";
    }
    if (["mois", "month", "months"].includes(normalized)) {
        return "mois";
    }
    return "";
}
function coerceStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => normalizeString(entry))
        .filter((entry) => entry !== "");
}
function buildFooterBlockHtml(aggregate, verifyUrl, doctor) {
    const parts = [];
    const issued = formatDateFr(aggregate.prescription.createdAt);
    parts.push('<div style="font-size:8pt;line-height:1.3;color:#475569;">');
    parts.push(`<div><strong>Dossier :</strong> ${escapeHtml(aggregate.prescription.uid)}</div>`);
    if (issued !== "") {
        parts.push(`<div><strong>Date :</strong> ${escapeHtml(issued)}</div>`);
    }
    if (doctor.rpps !== "") {
        parts.push(`<div><strong>RPPS :</strong> ${escapeHtml(doctor.rpps)}</div>`);
    }
    if (verifyUrl !== "") {
        parts.push(`<div style="word-break: break-all; margin-top: 1mm;"><strong>Vérification :</strong> <a href="${escapeHtmlAttr(verifyUrl)}" style="color:#1d4ed8; text-decoration:none;">${escapeHtml(verifyUrl)}</a></div>`);
    }
    parts.push('<div style="margin-top:2mm; font-weight:bold; color:#334155;">Ordonnance numérique sécurisée et hébergée sur un serveur certifié HDS (Hébergeur de Données de Santé).</div>');
    parts.push('</div>');
    return parts.join("\n");
}
function buildHeaderBadgeHtml(deliveryCode) {
    const code = normalizeString(deliveryCode);
    if (code === "") {
        return '<span class="badge badge--muted"><span class="badge__label">Ordonnance numérique</span></span>';
    }
    return `<span class="badge badge--delivery"><span class="badge__label">Code délivrance</span><span class="badge__value">${escapeHtml(code)}</span></span>`;
}
function buildPatientWeightLabel(aggregate) {
    const raw = normalizeString(aggregate.patient.weight_kg ?? aggregate.patient.weightKg);
    if (raw === "") {
        return "";
    }
    const normalized = raw.replace(',', '.');
    const asNumber = Number.parseFloat(normalized);
    if (Number.isFinite(asNumber) && asNumber > 0) {
        const rounded = Math.round(asNumber * 10) / 10;
        const label = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded).replace('.', ',');
        return `${label} Kgs`;
    }
    return `${raw} Kgs`;
}
function buildLabeledValueRowHtml(label, valueHtml, allowHtml = false) {
    const safeLabel = escapeHtml(label);
    const safeValue = allowHtml ? valueHtml : escapeHtml(valueHtml);
    return `<div class="kv-row"><div class="kv-label">${safeLabel}</div><div class="kv-value">${safeValue}</div></div>`;
}
function buildPatientName(aggregate) {
    return [normalizeHumanString(aggregate.patient.firstName), normalizeHumanString(aggregate.patient.lastName)]
        .filter(Boolean)
        .join(" ")
        .trim();
}
function buildPatientBirthLabel(aggregate) {
    return formatDateFr(aggregate.patient.birthDate);
}
function computeAgeLabel(birthDate) {
    const dt = parseDateLike(birthDate);
    if (!dt) {
        return "";
    }
    const now = new Date();
    let age = now.getUTCFullYear() - dt.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - dt.getUTCMonth();
    const dayDelta = now.getUTCDate() - dt.getUTCDate();
    if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
        age -= 1;
    }
    return age >= 0 ? `${age} ans` : "";
}
function countMedicationItems(items) {
    return coerceItemArray(items).length;
}
function coerceItemArray(items) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items.map((item) => asRecord(item));
}
function injectPrescriptionGradeStyles(html) {
    const style = [
        '<style id="ml-pdf-v590-prescription-grade">',
        '.badge{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:2.2mm;min-height:10mm;width:auto!important;max-width:100%;padding:1.2mm 4.2mm!important;border-radius:9999px!important;box-sizing:border-box;white-space:normal!important;overflow:visible!important;text-overflow:clip!important;}',
        '.badge__label{font-weight:600;white-space:nowrap;}',
        '.badge__value{font-weight:700;white-space:nowrap;letter-spacing:0.03em;}',
        '.badge--delivery{flex-wrap:wrap;}',
        '.badge--muted{padding-right:3.6mm!important;padding-left:3.6mm!important;}',
        '.sig-fallback{display:inline-flex!important;flex-direction:column;align-items:flex-end;justify-content:center;min-width:48mm;min-height:18mm;padding-top:3mm;color:#0f172a;}',
        '.sig-fallback__name{font-size:10pt;font-weight:700;line-height:1.2;text-align:right;}',
        '.sig-fallback__label{margin-top:1.2mm;font-size:8pt;line-height:1.2;color:#475569;text-align:right;}',
        '.doctor-distinctions{margin-top:1.2mm;font-size:9pt;line-height:1.35;color:#334155;}',
        '.doctor-rpps-heading{text-transform:none;}',
        '</style>',
    ].join("\n");
    if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `${style}\n</head>`);
    }
    return `${style}\n${html}`;
}
function buildSignatureFallbackHtml(doctor) {
    return [
        '<div class="sig-fallback">',
        `  <div class="sig-fallback__name">${escapeHtml(doctor.fullName)}</div>`,
        '  <div class="sig-fallback__label">Signature numérique</div>',
        '</div>',
    ].join("\n");
}
function doctorKeyForAudit(aggregate) {
    return normalizeString(aggregate.doctor.id) || "doctor:unknown";
}
function normalizeSignatureS3Key(value) {
    const raw = normalizeString(value);
    if (raw === "") {
        return "";
    }
    const lowered = raw.toLowerCase();
    if (lowered.startsWith("wpfile:") || lowered.startsWith("wpmedia:") || lowered.startsWith("wpstorage:")) {
        return raw;
    }
    if (raw.startsWith("s3://")) {
        const normalized = raw.replace(/^s3:\/\//i, "").replace(/^\/+/, "").trim();
        return normalized !== "" ? `s3://${normalized}` : "";
    }
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        const pathSegments = parsed.pathname.split("/").filter(Boolean);
        if (host.includes("amazonaws.com")) {
            const hostedBucket = extractVirtualHostedS3Bucket(host);
            if (hostedBucket !== "") {
                const key = decodeURIComponent(pathSegments.join("/")).replace(/^\/+/, "");
                return key !== "" ? `s3://${hostedBucket}/${key}` : "";
            }
            const isPathStyleHost = host === "s3.amazonaws.com" || host.startsWith("s3.") || host.startsWith("s3-");
            if (isPathStyleHost && pathSegments.length > 1) {
                const bucket = decodeURIComponent(pathSegments[0] ?? "").trim();
                const key = decodeURIComponent(pathSegments.slice(1).join("/")).replace(/^\/+/, "");
                if (bucket !== "" && key !== "") {
                    return `s3://${bucket}/${key}`;
                }
                return key;
            }
            return decodeURIComponent(pathSegments.join("/")).replace(/^\/+/, "");
        }
        return decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    }
    catch {
        // noop: raw value may already be a plain S3 key
    }
    return decodeURIComponent(raw).replace(/^\/+/, "");
}
function extractVirtualHostedS3Bucket(host) {
    const normalizedHost = normalizeString(host).toLowerCase();
    if (normalizedHost === "") {
        return "";
    }
    const separator = normalizedHost.indexOf(".s3.");
    if (separator > 0) {
        return normalizedHost.slice(0, separator).trim();
    }
    return "";
}
function signatureKeyTail(value) {
    const key = normalizeString(value);
    if (key === "") {
        return "";
    }
    return key.length <= 20 ? key : key.slice(-20);
}
function formatFrenchInternationalPhone(value) {
    const raw = normalizeString(value);
    if (raw === "") {
        return "";
    }
    const digits = raw.replace(/\D+/g, "");
    let national = "";
    if (digits.startsWith("0033") && digits.length >= 13) {
        national = digits.slice(4);
    }
    else if (digits.startsWith("33") && digits.length >= 11) {
        national = digits.slice(2);
    }
    else if (digits.startsWith("0") && digits.length >= 10) {
        national = digits.slice(1);
    }
    else if (digits.length == 9) {
        national = digits;
    }
    national = national.replace(/\D+/g, "");
    if (national.startsWith("0") && national.length === 10) {
        national = national.slice(1);
    }
    if (!/^[1-9]\d{8}$/.test(national)) {
        return "";
    }
    return `+33 ${national.slice(0, 1)} ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7, 9)}`;
}
function injectMetaAndReadiness(html, aggregate, reqId, jobId, templateName) {
    const meta = [
        `<meta name="ml:job_id" content="${escapeHtmlAttr(jobId)}">`,
        `<meta name="ml:req_id" content="${escapeHtmlAttr(reqId ?? "")}">`,
        `<meta name="ml:doctor_id" content="${escapeHtmlAttr(doctorKeyForAudit(aggregate))}">`,
        `<meta name="ml:prescription_id" content="${escapeHtmlAttr(aggregate.prescription.id)}">`,
        `<meta name="ml:uid" content="${escapeHtmlAttr(aggregate.prescription.uid)}">`,
        `<meta name="ml:template" content="${escapeHtmlAttr(templateName)}">`,
    ].join("\n");
    const marker = [
        `<!-- job_id: ${escapeHtml(jobId)} prescription_id: ${escapeHtml(aggregate.prescription.id)} -->`,
        '<div data-ml-pdf-ready="1" style="display:none"></div>',
        '<script>window.__ML_PDF_READY__ = true;</script>',
    ].join("\n");
    let out = html;
    if (/<\/head>/i.test(out)) {
        out = out.replace(/<\/head>/i, `${meta}\n</head>`);
    }
    else {
        out = `${meta}\n${out}`;
    }
    if (/<\/body>/i.test(out)) {
        out = out.replace(/<\/body>/i, `${marker}\n</body>`);
    }
    else {
        out = `${out}\n${marker}`;
    }
    return out;
}
function blankImageDataUri() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="72" viewBox="0 0 220 72"><rect width="220" height="72" fill="#ffffff" stroke="#d1d5db"/><line x1="18" y1="54" x2="202" y2="18" stroke="#94a3b8" stroke-width="2"/><text x="110" y="42" font-size="12" text-anchor="middle" fill="#64748b">Signature / QR</text></svg>';
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
function normalizeVerifyBaseUrl(value) {
    const trimmed = String(value ?? "").trim();
    return trimmed.replace(/\/+$/, "") || "https://sosprescription.fr";
}
function mapDoctorTitle(value) {
    const raw = normalizeString(value).toLowerCase();
    if (raw === "professeur" || raw === "pr") {
        return "Pr";
    }
    if (raw === "docteur" || raw === "dr" || raw === "docteur en médecine") {
        return "Dr";
    }
    return raw === "" ? "" : normalizeString(value);
}
function sanitizeDigits(value) {
    return String(value ?? "").replace(/\D+/g, "");
}
function nl2brEscaped(value) {
    return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br />");
}
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function escapeHtmlAttr(value) {
    return escapeHtml(value);
}
function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeHumanString(value) {
    const raw = normalizeString(value);
    if (raw === "" || isEmailLike(raw)) {
        return "";
    }
    return raw;
}
function isEmailLike(value) {
    const raw = normalizeString(value);
    return raw !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}
function firstNonEmpty(values) {
    for (const value of values) {
        const str = normalizeString(value);
        if (str !== "") {
            return str;
        }
    }
    return "";
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function toPositiveInt(value) {
    const raw = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(raw) || raw <= 0) {
        return 0;
    }
    return Math.trunc(raw);
}
function toBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    const raw = String(value ?? "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "oui";
}
function parseDateLike(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }
    const raw = normalizeString(value);
    if (raw === "") {
        return null;
    }
    const isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
    const dt = new Date(isoCandidate);
    return Number.isFinite(dt.getTime()) ? dt : null;
}
function formatDateFr(value) {
    const dt = parseDateLike(value);
    if (!dt) {
        return typeof value === "string" ? normalizeString(value) : "";
    }
    const day = String(dt.getUTCDate()).padStart(2, "0");
    const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const year = String(dt.getUTCFullYear());
    return `${day}/${month}/${year}`;
}
