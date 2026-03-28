// src/pdf/prescriptionHtmlBuilder.ts
import crypto from "node:crypto";
import type { NdjsonLogger } from "../logger";
import type { PrescriptionRenderAggregate } from "../prescriptions/prismaPrescriptionStore";
import { buildCode39DataUri } from "./assets/code39Svg";
import { buildQrDataUri } from "./assets/qrSvg";
import { SignatureDataUriLoader } from "./assets/signatureDataUri";
import { TemplateRegistry, TemplateVariant, normalizeTemplateVariant } from "./templateRegistry";

export interface PrescriptionHtmlBuilderConfig {
  templateRegistry?: TemplateRegistry;
  signatureLoader?: SignatureDataUriLoader | null;
  logger?: NdjsonLogger;
  verifyBaseUrl?: string;
  defaultTemplateVariant?: string;
}

export interface BuildPrescriptionHtmlInput {
  aggregate: PrescriptionRenderAggregate;
  jobId: string;
  reqId?: string;
  templateVariant?: string | null;
}

export interface BuildPrescriptionHtmlResult {
  html: string;
  templateName: string;
  templateVariant: TemplateVariant;
  verifyUrl: string;
}

interface DoctorProfile {
  fullName: string;
  specialty: string;
  rpps: string;
  address: string;
  phone: string;
  diplomaLine: string;
  issuePlace: string;
  signatureS3Key: string | null;
}

interface MedicationViewModel {
  label: string;
  posology: string;
  duration: string;
  meta: string;
}

export class PrescriptionHtmlBuilder {
  private readonly templateRegistry: TemplateRegistry;
  private readonly signatureLoader: SignatureDataUriLoader | null;
  private readonly logger?: NdjsonLogger;
  private readonly verifyBaseUrl: string;
  private readonly defaultTemplateVariant: TemplateVariant;

  constructor(cfg: PrescriptionHtmlBuilderConfig = {}) {
    this.templateRegistry = cfg.templateRegistry ?? new TemplateRegistry();
    this.signatureLoader = cfg.signatureLoader ?? null;
    this.logger = cfg.logger;
    this.verifyBaseUrl = normalizeVerifyBaseUrl(
      cfg.verifyBaseUrl ?? process.env.ML_VERIFY_BASE_URL ?? "https://sosprescription.fr",
    );
    this.defaultTemplateVariant = normalizeTemplateVariant(
      cfg.defaultTemplateVariant ?? process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
    );
  }

  async buildHtml(input: BuildPrescriptionHtmlInput): Promise<BuildPrescriptionHtmlResult> {
    const templateVariant = normalizeTemplateVariant(input.templateVariant ?? this.defaultTemplateVariant);
    const template = await this.templateRegistry.getTemplate(templateVariant);
    const aggregate = input.aggregate;
    const doctor = buildDoctorProfile(aggregate);
    const verifyUrl = buildVerificationUrl(this.verifyBaseUrl, aggregate.prescription.verifyToken);
    const qrDataUri = await buildQrDataUri(verifyUrl || `rx:${aggregate.prescription.uid || aggregate.prescription.id}`);
    const signatureDataUri = this.signatureLoader && doctor.signatureS3Key
      ? await this.signatureLoader.loadFromKey(doctor.signatureS3Key)
      : "";
    const rppsBarcodeDataUri = doctor.rpps !== "" ? buildCode39DataUri(doctor.rpps) : "";

    const signatureImgHtml = signatureDataUri !== ""
      ? `<img class="sig-img" src="${escapeHtmlAttr(signatureDataUri)}" alt="Signature du médecin" />`
      : '<div class="sig-fallback">Signature non renseignée.</div>';
    const qrImgHtml = `<img class="qr qr-img" src="${escapeHtmlAttr(qrDataUri !== "" ? qrDataUri : blankImageDataUri())}" alt="QR Code de vérification" />`;
    const rppsBarcodeHtml = rppsBarcodeDataUri !== ""
      ? `<img class="doctor-rpps-barcode" src="${escapeHtmlAttr(rppsBarcodeDataUri)}" alt="Code barre RPPS" />`
      : "";

    const doctorBlock = buildDoctorBlockHtml(doctor, rppsBarcodeDataUri);
    const patientBlock = buildPatientBlockHtml(aggregate);
    const medRows = buildMedicationRowsHtml(aggregate);
    const medBlocks = buildLegacyMedicationBlocksHtml(aggregate);
    const footerBlock = buildFooterBlockHtml(aggregate, verifyUrl, doctor);
    const headerBadgeHtml = buildHeaderBadgeHtml(aggregate.prescription.verifyCode);
    const hashShort = crypto
      .createHash("sha256")
      .update(`${aggregate.prescription.uid}|${aggregate.prescription.verifyToken ?? ""}`, "utf8")
      .digest("hex")
      .slice(0, 12);

    const replacements: Record<string, string> = {
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

    html = injectMetaAndReadiness(html, aggregate, input.reqId, input.jobId, template.templateName);

    this.logger?.info(
      "pdf.html.built",
      {
        prescription_id: aggregate.prescription.id,
        job_id: input.jobId,
        template: template.templateName,
        template_variant: template.variant,
        sig_present: signatureDataUri !== "",
        verify_enabled: verifyUrl !== "",
        items_count: countMedicationItems(aggregate.prescription.items),
      },
      input.reqId,
    );

    return {
      html,
      templateName: template.templateName,
      templateVariant: template.variant,
      verifyUrl,
    };
  }
}

function buildDoctorProfile(aggregate: PrescriptionRenderAggregate): DoctorProfile {
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
  const phone = normalizeString(doctor.phone);
  const fullName = title !== "" && !displayName.toLowerCase().startsWith(title.toLowerCase())
    ? `${title} ${displayName}`.trim()
    : displayName;

  return {
    fullName,
    specialty,
    rpps,
    address,
    phone,
    diplomaLine: "",
    issuePlace: normalizeString(doctor.city),
    signatureS3Key: doctor.signatureS3Key,
  };
}

function buildDoctorAddress(address: string | null, zipCode: string | null, city: string | null): string {
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

function buildVerificationUrl(baseUrl: string, verifyToken: string | null): string {
  const token = normalizeString(verifyToken);
  if (token === "") {
    return "";
  }
  return `${baseUrl}/v/${encodeURIComponent(token)}`;
}

function buildDoctorBlockHtml(doctor: DoctorProfile, rppsBarcodeDataUri: string): string {
  const lines: string[] = [];
  lines.push(`<div class="doctor-name">${escapeHtml(doctor.fullName)}</div>`);
  if (doctor.specialty !== "") {
    lines.push(`<div class="doctor-specialty">${escapeHtml(doctor.specialty)}</div>`);
  }
  if (doctor.diplomaLine !== "") {
    lines.push(`<div class="doctor-diploma">${escapeHtml(doctor.diplomaLine)}</div>`);
  }

  const metaRows: string[] = [];
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
    lines.push(
      [
        '<div class="doctor-rpps-panel">',
        '  <div class="doctor-rpps-heading">Code barre RPPS</div>',
        `  <img class="doctor-rpps-barcode" src="${escapeHtmlAttr(rppsBarcodeDataUri)}" alt="Code barre RPPS ${escapeHtmlAttr(doctor.rpps)}" />`,
        '</div>',
      ].join("\n"),
    );
  }

  return lines.join("\n");
}

function buildPatientBlockHtml(aggregate: PrescriptionRenderAggregate): string {
  const rows: string[] = [];
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

function buildMedicationRowsHtml(aggregate: PrescriptionRenderAggregate): string {
  const items = coerceItemArray(aggregate.prescription.items);
  if (items.length < 1) {
    return '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
  }

  const rows: string[] = [];
  for (const item of items) {
    const view = buildMedicationViewModel(item);
    const nameHtml = view.meta !== ""
      ? `<div class="med-name">${escapeHtml(view.label)}</div><div class="med-meta">${escapeHtml(view.meta)}</div>`
      : `<div class="med-name">${escapeHtml(view.label)}</div>`;

    rows.push(
      [
        '<tr>',
        `  <td>${nameHtml}</td>`,
        `  <td><div class="med-posology">${escapeHtml(view.posology)}</div></td>`,
        `  <td><div class="med-duration">${escapeHtml(view.duration)}</div></td>`,
        '</tr>',
      ].join("\n"),
    );
  }

  return rows.length > 0
    ? rows.join("\n")
    : '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
}

function buildLegacyMedicationBlocksHtml(aggregate: PrescriptionRenderAggregate): string {
  const items = coerceItemArray(aggregate.prescription.items);
  if (items.length < 1) {
    return '<div class="med-row"><div class="med-posology">Aucune ligne trouvée.</div></div>';
  }

  const blocks: string[] = [];
  for (const item of items) {
    const view = buildMedicationViewModel(item);
    const detailParts: string[] = [];
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

    blocks.push(
      [
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
      ].join("\n"),
    );
  }

  return blocks.join("\n");
}

function buildMedicationViewModel(item: unknown): MedicationViewModel {
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
  posology = stripDurationFromPosology(posology, duration);
  posology = normalizeLooseText(posology);
  if (posology === "") {
    posology = "—";
  }

  const metaParts: string[] = [];
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

function hasStructuredSchedule(schedule: Record<string, unknown>): boolean {
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

function sanitizeScheduleNote(value: unknown, durationLabel: string): string {
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

function normalizeLooseText(value: unknown): string {
  return String(value ?? "")
    .replace(/[  ]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFlexibleSpacePattern(value: string): string {
  return normalizeLooseText(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[\\s\\u00A0\\u202F\\r\\n]+");
}

function stripDurationFromPosology(text: unknown, durationLabel: string): string {
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

function scheduleToText(schedule: Record<string, unknown>): string {
  const durationLabel = extractDurationLabelFromSchedule(schedule);
  const note = sanitizeScheduleNote(firstNonEmpty([schedule.note]), durationLabel);
  const fallbackText = sanitizeScheduleNote(firstNonEmpty([schedule.text, schedule.label]), durationLabel);
  const nb = toPositiveInt(schedule.nb ?? schedule.timesPerDay);
  const freqUnit = normalizeScheduleUnit(schedule.freqUnit ?? schedule.frequencyUnit ?? schedule.freq);
  const times = coerceStringArray(schedule.times);
  const doses = coerceStringArray(schedule.doses);

  if (nb > 0 && freqUnit !== "") {
    const base = `${nb > 1 ? `${nb} fois` : "1 fois"} par ${freqUnit}`;
    const details: string[] = [];

    for (let i = 0; i < nb; i += 1) {
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
    if (note !== "") {
      out += `. ${note}`;
    }
    return normalizeLooseText(out);
  }

  const parts: string[] = [];
  const momentMap: Array<[string, string]> = [
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

  const legacyTimesPerDay = toPositiveInt(schedule.timesPerDay);
  if (legacyTimesPerDay > 0 && nb < 1) {
    parts.push(`${legacyTimesPerDay} prise${legacyTimesPerDay > 1 ? "s" : ""} / jour`);
  }

  const asNeeded = toBoolean(schedule.asNeeded);
  if (asNeeded) {
    parts.push("si besoin");
  }

  if (note !== "") {
    parts.push(note);
  }

  if (parts.length > 0) {
    return normalizeLooseText(parts.join(" — "));
  }

  return stripDurationFromPosology(fallbackText, durationLabel);
}

function extractDurationLabelFromSchedule(schedule: Record<string, unknown>): string {
  const value = toPositiveInt(schedule.durationVal ?? schedule.durationValue ?? schedule.duration);
  const unit = normalizeScheduleUnit(schedule.durationUnit ?? schedule.unit);
  if (value < 1 || unit === "") {
    return "";
  }
  return `${value} ${pluralizeDurationUnit(unit, value)}`;
}

function pluralizeDurationUnit(unit: string, value: number): string {
  const normalized = normalizeScheduleUnit(unit);
  if (normalized === "") {
    return "";
  }
  if (value <= 1 || normalized === "mois") {
    return normalized;
  }
  return `${normalized}s`;
}

function normalizeScheduleUnit(value: unknown): string {
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

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeString(entry))
    .filter((entry) => entry !== "");
}

function buildFooterBlockHtml(
  aggregate: PrescriptionRenderAggregate,
  verifyUrl: string,
  doctor: DoctorProfile,
): string {
  const parts: string[] = [];
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

function buildHeaderBadgeHtml(deliveryCode: string | null): string {
  const code = normalizeString(deliveryCode);
  if (code === "") {
    return '<span class="badge badge--muted">Ordonnance numérique</span>';
  }
  return `<span class="badge">Code délivrance : ${escapeHtml(code)}</span>`;
}

function buildPatientWeightLabel(aggregate: PrescriptionRenderAggregate): string {
  const raw = normalizeString((aggregate.patient as { weight_kg?: string | null; weightKg?: string | null }).weight_kg ?? aggregate.patient.weightKg);
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

function buildLabeledValueRowHtml(label: string, valueHtml: string, allowHtml = false): string {
  const safeLabel = escapeHtml(label);
  const safeValue = allowHtml ? valueHtml : escapeHtml(valueHtml);
  return `<div class="kv-row"><div class="kv-label">${safeLabel}</div><div class="kv-value">${safeValue}</div></div>`;
}

function buildPatientName(aggregate: PrescriptionRenderAggregate): string {
  return [normalizeHumanString(aggregate.patient.firstName), normalizeHumanString(aggregate.patient.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildPatientBirthLabel(aggregate: PrescriptionRenderAggregate): string {
  return formatDateFr(aggregate.patient.birthDate);
}

function computeAgeLabel(birthDate: string): string {
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

function countMedicationItems(items: unknown): number {
  return coerceItemArray(items).length;
}

function coerceItemArray(items: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => asRecord(item));
}

function injectMetaAndReadiness(
  html: string,
  aggregate: PrescriptionRenderAggregate,
  reqId: string | undefined,
  jobId: string,
  templateName: string,
): string {
  const meta = [
    `<meta name="ml:job_id" content="${escapeHtmlAttr(jobId)}">`,
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
  } else {
    out = `${meta}\n${out}`;
  }

  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${marker}\n</body>`);
  } else {
    out = `${out}\n${marker}`;
  }

  return out;
}

function blankImageDataUri(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="72" viewBox="0 0 220 72"><rect width="220" height="72" fill="#ffffff" stroke="#d1d5db"/><line x1="18" y1="54" x2="202" y2="18" stroke="#94a3b8" stroke-width="2"/><text x="110" y="42" font-size="12" text-anchor="middle" fill="#64748b">Signature / QR</text></svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function normalizeVerifyBaseUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/\/+$/, "") || "https://sosprescription.fr";
}

function mapDoctorTitle(value: string | null): string {
  const raw = normalizeString(value).toLowerCase();
  if (raw === "professeur" || raw === "pr") {
    return "Pr";
  }
  if (raw === "docteur" || raw === "dr" || raw === "docteur en médecine") {
    return "Dr";
  }
  return raw === "" ? "" : normalizeString(value);
}

function sanitizeDigits(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}

function nl2brEscaped(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br />");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(value: unknown): string {
  return escapeHtml(value);
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHumanString(value: unknown): string {
  const raw = normalizeString(value);
  if (raw === "" || isEmailLike(raw)) {
    return "";
  }

  return raw;
}

function isEmailLike(value: string): boolean {
  const raw = normalizeString(value);
  return raw !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function firstNonEmpty(values: unknown[]): string {
  for (const value of values) {
    const str = normalizeString(value);
    if (str !== "") {
      return str;
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toPositiveInt(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.trunc(raw);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "oui";
}

function parseDateLike(value: string | Date): Date | null {
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

function formatDateFr(value: string | Date): string {
  const dt = parseDateLike(value);
  if (!dt) {
    return typeof value === "string" ? normalizeString(value) : "";
  }

  const day = String(dt.getUTCDate()).padStart(2, "0");
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const year = String(dt.getUTCFullYear());
  return `${day}/${month}/${year}`;
}
