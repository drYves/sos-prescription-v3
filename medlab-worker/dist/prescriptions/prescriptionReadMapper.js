"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prescriptionDetailInclude = exports.prescriptionListInclude = exports.PrescriptionReadRepoError = void 0;
exports.mapPrescriptionListRow = mapPrescriptionListRow;
exports.mapPrescriptionDetail = mapPrescriptionDetail;
const client_1 = require("@prisma/client");
class PrescriptionReadRepoError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message) {
        super(message);
        this.name = "PrescriptionReadRepoError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.PrescriptionReadRepoError = PrescriptionReadRepoError;
exports.prescriptionListInclude = client_1.Prisma.validator()({
    patient: {
        select: {
            wpUserId: true,
            firstName: true,
            lastName: true,
            birthDate: true,
            weightKg: true,
            heightCm: true,
        },
    },
    doctor: {
        select: {
            wpUserId: true,
        },
    },
    artifacts: {
        where: {
            kind: client_1.ArtifactKind.PROOF,
            status: client_1.ArtifactStatus.READY,
            deletedAt: null,
        },
        orderBy: {
            createdAt: "asc",
        },
        select: {
            id: true,
        },
    },
});
exports.prescriptionDetailInclude = client_1.Prisma.validator()({
    patient: {
        select: {
            wpUserId: true,
            firstName: true,
            lastName: true,
            birthDate: true,
            gender: true,
            email: true,
            phone: true,
            weightKg: true,
            heightCm: true,
        },
    },
    doctor: {
        select: {
            wpUserId: true,
        },
    },
    artifacts: {
        where: {
            kind: client_1.ArtifactKind.PROOF,
            status: client_1.ArtifactStatus.READY,
            deletedAt: null,
        },
        orderBy: {
            createdAt: "asc",
        },
        select: {
            id: true,
            prescriptionId: true,
            kind: true,
            mimeType: true,
            originalName: true,
            sizeBytes: true,
            createdAt: true,
        },
    },
});
function mapPrescriptionListRow(record) {
    const flow = normalizeFlowKey(record.flowKey);
    const patientName = buildPatientFullName(record.patient.firstName, record.patient.lastName);
    const proofArtifactIds = record.artifacts.map((artifact) => artifact.id);
    const payload = buildLegacyPayload(record, patientName, proofArtifactIds);
    const status = mapBusinessStatus(record.status);
    const lastActivityAt = record.lastMessageAt ?? record.updatedAt;
    const decidedAt = isDecidedStatus(record.status) ? record.updatedAt : null;
    return {
        id: record.id,
        uid: record.uid,
        patient_user_id: record.patient.wpUserId ?? null,
        doctor_user_id: record.doctor?.wpUserId ?? null,
        status,
        flow,
        priority: record.priority,
        payment_status: null,
        amount_cents: null,
        currency: "EUR",
        last_activity_at: lastActivityAt.toISOString(),
        assigned_at: record.claimedAt ? record.claimedAt.toISOString() : null,
        created_at: record.createdAt.toISOString(),
        updated_at: record.updatedAt.toISOString(),
        decided_at: decidedAt ? decidedAt.toISOString() : null,
        payload,
    };
}
function mapPrescriptionDetail(record) {
    const flow = normalizeFlowKey(record.flowKey);
    const patientName = buildPatientFullName(record.patient.firstName, record.patient.lastName);
    const proofArtifactIds = record.artifacts.map((artifact) => artifact.id);
    const payload = buildLegacyPayload(record, patientName, proofArtifactIds);
    const birthDateFr = formatBirthDateFr(record.patient.birthDate);
    const decidedAt = isDecidedStatus(record.status) ? record.updatedAt : null;
    return {
        id: record.id,
        uid: record.uid,
        patient_user_id: record.patient.wpUserId ?? null,
        patient_name: patientName,
        patient_birthdate: record.patient.birthDate,
        patient_birthdate_fr: birthDateFr,
        patient_age_label: buildPatientAgeLabel(record.patient.birthDate),
        patient_dob: birthDateFr !== "" ? birthDateFr : record.patient.birthDate,
        doctor_user_id: record.doctor?.wpUserId ?? null,
        status: mapBusinessStatus(record.status),
        flow,
        priority: record.priority,
        payment: {
            provider: null,
            status: null,
            amount_cents: null,
            currency: "EUR",
            pricing_snapshot: null,
        },
        client_request_id: null,
        payload,
        decision_reason: null,
        created_at: record.createdAt.toISOString(),
        updated_at: record.updatedAt.toISOString(),
        decided_at: decidedAt ? decidedAt.toISOString() : null,
        verify_token: normalizeNullableString(record.verifyToken),
        verify_code: normalizeNullableString(record.verifyCode),
        dispensed_at: null,
        items: mapPrescriptionItems(record.items),
        files: mapProofFiles(record),
    };
}
function buildLegacyPayload(record, patientName, proofArtifactIds) {
    const flow = normalizeFlowKey(record.flowKey);
    return {
        patient: {
            fullname: patientName,
            fullName: patientName,
            firstName: record.patient.firstName,
            lastName: record.patient.lastName,
            birthdate: record.patient.birthDate,
            birthDate: record.patient.birthDate,
            weight_kg: normalizeNullableString(record.patient.weightKg),
            weightKg: normalizeNullableString(record.patient.weightKg),
            height_cm: normalizeNullableString(record.patient.heightCm),
            heightCm: normalizeNullableString(record.patient.heightCm),
            note: normalizeNullableString(record.privateNotes),
        },
        request: {
            flow,
            priority: record.priority,
        },
        prescription: {
            id: record.id,
            uid: record.uid,
            flow,
            priority: record.priority,
            privateNotes: normalizeNullableString(record.privateNotes),
            private_notes: normalizeNullableString(record.privateNotes),
        },
        worker: {
            prescription_id: record.id,
            status: record.status,
            processing_status: record.processingStatus,
            verify_token: normalizeNullableString(record.verifyToken),
            verify_code: normalizeNullableString(record.verifyCode),
        },
        shadow: {
            zero_pii: true,
            mode: "worker-postgres",
            worker_thread: {
                message_count: record.messageCount,
                last_message_seq: record.lastMessageSeq,
                last_message_at: record.lastMessageAt ? record.lastMessageAt.toISOString() : null,
                last_message_role: normalizeNullableString(record.lastMessageRole),
                doctor_last_read_seq: record.doctorLastReadSeq,
                patient_last_read_seq: record.patientLastReadSeq,
                unread_count_doctor: record.unreadCountDoctor,
                unread_count_patient: record.unreadCountPatient,
            },
            worker_evidence: {
                has_proof: record.hasProof || proofArtifactIds.length > 0,
                proof_count: Math.max(record.proofCount, proofArtifactIds.length),
                proof_artifact_ids: proofArtifactIds,
            },
        },
        flow,
        flow_key: flow,
        priority: record.priority,
        request_priority: record.priority,
        privateNotes: normalizeNullableString(record.privateNotes),
        private_notes: normalizeNullableString(record.privateNotes),
        proof_artifact_ids: proofArtifactIds,
        verify_token: normalizeNullableString(record.verifyToken),
        verify_code: normalizeNullableString(record.verifyCode),
    };
}
function mapPrescriptionItems(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
        const raw = toRecord(value[index]);
        if (!raw) {
            continue;
        }
        out.push({
            line_no: index + 1,
            cis: normalizeNullableString(raw.cis),
            cip13: normalizeNullableString(raw.cip13),
            denomination: pickFirstText([raw.label, raw.denomination, raw.name]) ?? "Médicament",
            posologie: buildPosologie(raw),
            quantite: normalizeNullableString(raw.quantite),
            raw,
        });
    }
    return out;
}
function mapProofFiles(record) {
    return record.artifacts.map((artifact) => ({
        id: artifact.id,
        prescription_id: record.id,
        purpose: "evidence",
        mime: artifact.mimeType,
        original_name: artifact.originalName,
        size_bytes: artifact.sizeBytes,
        created_at: artifact.createdAt.toISOString(),
        download_url: `/wp-json/sosprescription/v1/files/${encodeURIComponent(artifact.id)}/download`,
    }));
}
function buildPatientFullName(firstName, lastName) {
    return [firstName, lastName]
        .map((part) => String(part ?? "").trim())
        .filter((part) => part !== "")
        .join(" ")
        .trim();
}
function normalizeFlowKey(value) {
    const normalized = String(value ?? "").trim();
    return normalized !== "" ? normalized : "renewal";
}
function mapBusinessStatus(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    switch (normalized) {
        case "PENDING":
            return "pending";
        case "APPROVED":
            return "approved";
        case "REJECTED":
            return "rejected";
        default:
            return normalized !== "" ? normalized.toLowerCase() : "pending";
    }
}
function isDecidedStatus(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized === "APPROVED" || normalized === "REJECTED";
}
function formatBirthDateFr(value) {
    const normalized = String(value ?? "").trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return "";
    }
    return `${match[3]}/${match[2]}/${match[1]}`;
}
function buildPatientAgeLabel(value) {
    const normalized = String(value ?? "").trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return "";
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return "";
    }
    const now = new Date();
    let age = now.getUTCFullYear() - year;
    const currentMonth = now.getUTCMonth() + 1;
    const currentDay = now.getUTCDate();
    if (currentMonth < month || (currentMonth === month && currentDay < day)) {
        age -= 1;
    }
    return age > 0 ? `${age} ans` : "";
}
function buildPosologie(raw) {
    const direct = pickFirstText([raw.posologie]);
    if (direct) {
        return direct;
    }
    const schedule = toRecord(raw.schedule);
    if (!schedule) {
        return null;
    }
    const nb = pickFirstText([schedule.nb]);
    const freqUnit = pickFirstText([schedule.freqUnit]);
    const durationVal = pickFirstText([schedule.durationVal]);
    const durationUnit = pickFirstText([schedule.durationUnit]);
    if (!nb || !freqUnit || !durationVal || !durationUnit) {
        return null;
    }
    let out = `${nb} fois par ${freqUnit} pendant ${durationVal} ${durationUnit}`;
    const moment = pickFirstText([schedule.moment]);
    if (moment) {
        out += ` • ${moment}`;
    }
    const comment = pickFirstText([schedule.comment, schedule.note]);
    if (comment) {
        out += ` • ${comment}`;
    }
    return out;
}
function toRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function normalizeNullableString(value) {
    if (value == null) {
        return null;
    }
    const normalized = String(value).trim();
    return normalized !== "" ? normalized : null;
}
function pickFirstText(values) {
    for (const value of values) {
        const normalized = normalizeNullableString(value);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}
