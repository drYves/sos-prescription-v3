"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutopilotEngine = void 0;
const client_1 = require("@prisma/client");
const CONTROLLED_SUBSTANCE_MARKERS = [
    "stupefiant",
    "assimile aux stupefiants",
    "assimile aux stupefiant",
    "assimile stupefiant",
    "assimiles aux stupefiants",
    "assimiles stupefiants",
];
class AutopilotEngine {
    prisma;
    logger;
    ownsClient;
    constructor(cfg = {}) {
        this.prisma = cfg.prisma ?? new client_1.PrismaClient();
        this.logger = cfg.logger;
        this.ownsClient = !cfg.prisma;
    }
    async close() {
        if (!this.ownsClient) {
            return;
        }
        await this.prisma.$disconnect();
    }
    async evaluatePrescription(prescriptionId) {
        const safePrescriptionId = normalizeRequiredString(prescriptionId, "prescriptionId");
        const current = await this.prisma.prescription.findUnique({
            where: { id: safePrescriptionId },
            include: {
                patient: true,
            },
        });
        if (!current) {
            throw new Error("ML_AUTOPILOT_PRESCRIPTION_NOT_FOUND");
        }
        const reasons = new Set();
        const currentIdentity = normalizePatientIdentity(current.patient);
        const requestedLines = extractMedicationLines(current.items);
        if (requestedLines.length < 1) {
            reasons.add("NO_MEDICATION_LINES");
        }
        const requestedCisList = uniqueNonEmptyStrings(requestedLines.map((line) => line.cis));
        if (requestedLines.some((line) => !line.cis)) {
            reasons.add("MISSING_CIS_IN_REQUEST");
        }
        const history = await this.prisma.prescription.findMany({
            where: {
                patientId: current.patientId,
                status: "APPROVED",
                id: { not: current.id },
            },
            include: {
                patient: true,
            },
            orderBy: [
                { updatedAt: "desc" },
                { createdAt: "desc" },
            ],
        });
        if (history.length < 1) {
            reasons.add("NO_APPROVED_HISTORY_FOR_PATIENT");
        }
        const referenceHistory = history[0] ?? null;
        if (referenceHistory) {
            const historicalIdentity = normalizePatientIdentity(referenceHistory.patient);
            if (!identitiesMatch(currentIdentity, historicalIdentity)) {
                reasons.add("PATIENT_IDENTITY_MISMATCH");
            }
        }
        const latestHistoryByCis = new Map();
        for (const row of history) {
            const historicalLines = extractMedicationLines(row.items);
            for (const line of historicalLines) {
                if (!line.cis) {
                    continue;
                }
                if (!latestHistoryByCis.has(line.cis)) {
                    latestHistoryByCis.set(line.cis, line);
                }
            }
        }
        for (const cis of requestedCisList) {
            if (!latestHistoryByCis.has(cis)) {
                reasons.add(`MEDICATION_NOT_FOUND_IN_APPROVED_HISTORY:${cis}`);
            }
        }
        if (requestedCisList.length > 0) {
            const controlledRows = await this.prisma.bdpmPrescriptionCondition.findMany({
                where: {
                    cis: {
                        in: requestedCisList,
                    },
                },
                select: {
                    cis: true,
                    normalizedCondition: true,
                },
            });
            const blockedCis = new Set();
            for (const row of controlledRows) {
                if (isControlledSubstanceCondition(row.normalizedCondition)) {
                    blockedCis.add(row.cis);
                }
            }
            for (const cis of blockedCis) {
                reasons.add(`CONTROLLED_SUBSTANCE_BLOCKED:${cis}`);
            }
        }
        for (const requestedLine of requestedLines) {
            if (!requestedLine.cis) {
                continue;
            }
            const historicalLine = latestHistoryByCis.get(requestedLine.cis);
            if (!historicalLine) {
                continue;
            }
            if (requestedLine.nb == null || requestedLine.durationVal == null) {
                reasons.add(`REQUEST_DOSAGE_INCOMPLETE:${requestedLine.cis}`);
                continue;
            }
            if (historicalLine.nb == null || historicalLine.durationVal == null) {
                reasons.add(`HISTORICAL_DOSAGE_UNAVAILABLE:${requestedLine.cis}`);
                continue;
            }
            if (requestedLine.nb > historicalLine.nb) {
                reasons.add(`DOSE_NB_INCREASED:${requestedLine.cis}`);
            }
            if (requestedLine.durationVal > historicalLine.durationVal) {
                reasons.add(`DOSE_DURATION_INCREASED:${requestedLine.cis}`);
            }
        }
        const decision = {
            allowed: reasons.size < 1,
            reasons: Array.from(reasons),
        };
        this.logger?.info("autopilot.evaluated", {
            prescription_id: safePrescriptionId,
            allowed: decision.allowed,
            reasons: decision.reasons,
            requested_cis_count: requestedCisList.length,
            history_count: history.length,
        }, undefined);
        return decision;
    }
}
exports.AutopilotEngine = AutopilotEngine;
function extractMedicationLines(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry, index) => normalizeMedicationLine(entry, index));
}
function normalizeMedicationLine(value, index) {
    const row = asRecord(value);
    const raw = asRecord(row.raw);
    const schedule = asRecord(row.schedule ?? raw.schedule);
    return {
        lineNo: toPositiveInt(row.line_no ?? row.lineNo ?? index + 1) ?? index + 1,
        cis: sanitizeDigitsString(firstNonEmptyString([row.cis, raw.cis])) || null,
        nb: toPositiveInt(schedule.nb ?? schedule.timesPerDay),
        durationVal: toPositiveInt(schedule.durationVal ?? schedule.durationValue ?? schedule.duration),
    };
}
function normalizePatientIdentity(patient) {
    return {
        firstName: normalizeIdentityText(patient.firstName),
        lastName: normalizeIdentityText(patient.lastName),
        birthDate: normalizeBirthDate(patient.birthDate),
    };
}
function identitiesMatch(left, right) {
    return left.firstName === right.firstName
        && left.lastName === right.lastName
        && left.birthDate === right.birthDate;
}
function isControlledSubstanceCondition(value) {
    const normalized = normalizeIdentityText(value);
    if (normalized === "") {
        return false;
    }
    return CONTROLLED_SUBSTANCE_MARKERS.some((marker) => normalized.includes(marker));
}
function normalizeRequiredString(value, field) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized === "") {
        throw new Error(`Missing required field: ${field}`);
    }
    return normalized;
}
function normalizeIdentityText(value) {
    return String(value ?? "")
        .normalize("NFD")
        .replace(/\p{Diacritic}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}
function normalizeBirthDate(value) {
    const raw = String(value ?? "").trim();
    if (raw === "") {
        return "";
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw;
    }
    const frMatch = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
    if (frMatch) {
        return `${frMatch[3]}-${frMatch[2]}-${frMatch[1]}`;
    }
    const digits = raw.replace(/\D+/g, "");
    if (digits.length === 8) {
        if (raw.includes("/") || raw.includes("-")) {
            const dd = digits.slice(0, 2);
            const mm = digits.slice(2, 4);
            const yyyy = digits.slice(4, 8);
            return `${yyyy}-${mm}-${dd}`;
        }
        const yyyy = digits.slice(0, 4);
        const mm = digits.slice(4, 6);
        const dd = digits.slice(6, 8);
        return `${yyyy}-${mm}-${dd}`;
    }
    return raw;
}
function uniqueNonEmptyStrings(values) {
    const out = new Set();
    for (const value of values) {
        const normalized = sanitizeDigitsString(String(value ?? ""));
        if (normalized !== "") {
            out.add(normalized);
        }
    }
    return Array.from(out);
}
function firstNonEmptyString(values) {
    for (const value of values) {
        const normalized = normalizeNullableString(value);
        if (normalized) {
            return normalized;
        }
    }
    return "";
}
function normalizeNullableString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized === "" ? null : normalized;
}
function sanitizeDigitsString(value) {
    return value.replace(/\D+/g, "");
}
function toPositiveInt(value) {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.trunc(parsed);
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value;
}
