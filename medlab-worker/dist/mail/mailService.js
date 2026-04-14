"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailService = exports.MailServiceError = void 0;
const node_net_1 = __importDefault(require("node:net"));
const node_tls_1 = __importDefault(require("node:tls"));
const node_crypto_1 = require("node:crypto");
const DEFAULT_VERIFY_BASE_URL = "https://sosprescription.fr/auth/verify";
const DEFAULT_PATIENT_PORTAL_URL = "https://sosprescription.fr/espace-patient/";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const SMTP_CONNECT_TIMEOUT_MS = 10_000;
const SMTP_DEFAULT_PORT_SECURE = 465;
const SMTP_DEFAULT_PORT_STARTTLS = 587;
class MailServiceError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message, options) {
        super(message, options);
        this.name = "MailServiceError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.MailServiceError = MailServiceError;
class MailService {
    logger;
    verifyBaseUrl;
    patientPortalUrl;
    webhookUrl;
    webhookBearer;
    requestTimeoutMs;
    fromName;
    smtpConfig;
    smtpConfigured;
    smtpPartiallyConfigured;
    productionMode;
    constructor(cfg = {}) {
        this.logger = cfg.logger;
        this.verifyBaseUrl = normalizeBaseUrl(cfg.verifyBaseUrl
            ?? process.env.ML_MAGIC_LINK_VERIFY_URL
            ?? process.env.MAGIC_LINK_VERIFY_URL
            ?? DEFAULT_VERIFY_BASE_URL, DEFAULT_VERIFY_BASE_URL);
        this.patientPortalUrl = normalizeBaseUrl(cfg.patientPortalUrl
            ?? process.env.ML_PATIENT_PORTAL_URL
            ?? process.env.PATIENT_PORTAL_URL
            ?? DEFAULT_PATIENT_PORTAL_URL, DEFAULT_PATIENT_PORTAL_URL);
        this.webhookUrl = normalizeOptionalString(cfg.webhookUrl
            ?? process.env.ML_MAGIC_LINK_EMAIL_WEBHOOK_URL
            ?? process.env.MAGIC_LINK_EMAIL_WEBHOOK_URL);
        this.webhookBearer = normalizeOptionalString(cfg.webhookBearer
            ?? process.env.ML_MAGIC_LINK_EMAIL_WEBHOOK_BEARER
            ?? process.env.MAGIC_LINK_EMAIL_WEBHOOK_BEARER);
        this.requestTimeoutMs = clampTimeout(cfg.requestTimeoutMs
            ?? readPositiveIntEnv("ML_MAGIC_LINK_EMAIL_TIMEOUT_MS", readPositiveIntEnv("MAGIC_LINK_EMAIL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)));
        this.fromName = normalizeOptionalString(cfg.fromName
            ?? process.env.ML_SMTP_FROM_NAME
            ?? process.env.SMTP_FROM_NAME
            ?? process.env.ML_MAGIC_LINK_FROM_NAME
            ?? process.env.MAGIC_LINK_FROM_NAME) || "SOS Prescription";
        const smtpResolved = resolveSmtpRuntimeConfig({
            smtpHost: cfg.smtpHost,
            smtpPort: cfg.smtpPort,
            smtpSecure: cfg.smtpSecure,
            smtpRequireTls: cfg.smtpRequireTls,
            smtpUsername: cfg.smtpUsername,
            smtpPassword: cfg.smtpPassword,
            smtpFromEmail: cfg.smtpFromEmail,
            smtpFromName: cfg.smtpFromName ?? this.fromName,
            smtpHeloHost: cfg.smtpHeloHost,
            smtpTimeoutMs: cfg.smtpTimeoutMs ?? this.requestTimeoutMs,
        });
        this.smtpConfig = smtpResolved.config;
        this.smtpConfigured = smtpResolved.state === "ready";
        this.smtpPartiallyConfigured = smtpResolved.state === "partial";
        this.productionMode = isProductionRuntime();
    }
    async sendMagicLink(input, reqId) {
        const email = normalizeEmail(input.email);
        const token = normalizeToken(input.token);
        if (email === "" || token === "") {
            throw new MailServiceError("ML_MAGIC_LINK_MAIL_BAD_REQUEST", 400, "magic_link_mail_input_invalid");
        }
        const verifyBaseUrl = normalizeBaseUrl(normalizeOptionalString(input.verifyBaseUrl) || this.verifyBaseUrl, this.verifyBaseUrl);
        const magicUrl = buildMagicUrl(verifyBaseUrl, token);
        const ttlMinutes = Math.max(1, Math.ceil(Math.max(1, input.expiresAt.getTime() - Date.now()) / 60_000));
        return this.dispatchMail({
            email,
            subject: `[${this.fromName}] Votre lien de connexion sécurisé`,
            text: buildMagicLinkPlainTextBody(magicUrl, ttlMinutes),
            html: buildMagicLinkHtmlBody(magicUrl, ttlMinutes),
            meta: {
                channel: "magic_link",
                ttl_minutes: ttlMinutes,
            },
            successLogEvent: "mail.magic_link.dispatched",
            mockLogEvent: "mail.magic_link.mock_dispatched",
            errorLogEvent: "mail.magic_link.dispatch_failed",
            successLogContext: {
                verify_host: safeHost(verifyBaseUrl),
                ttl_minutes: ttlMinutes,
            },
        }, reqId, "ML_MAGIC_LINK_MAIL_FAILED");
    }
    async sendNewMessageNotification(input, reqId) {
        const email = normalizeEmail(input.email);
        if (email === "") {
            throw new MailServiceError("ML_MESSAGE_NOTIFICATION_BAD_REQUEST", 400, "message_notification_input_invalid");
        }
        const portalUrl = buildPatientPortalUrl(this.patientPortalUrl, input.prescriptionUid);
        return this.dispatchMail({
            email,
            subject: `[${this.fromName}] Nouveau message de votre médecin`,
            text: buildNewMessageNotificationPlainTextBody(portalUrl),
            html: buildNewMessageNotificationHtmlBody(portalUrl),
            meta: {
                channel: "patient_new_message",
                prescription_uid: normalizeOptionalString(input.prescriptionUid) || null,
            },
            successLogEvent: "mail.patient_new_message.dispatched",
            mockLogEvent: "mail.patient_new_message.mock_dispatched",
            errorLogEvent: "mail.patient_new_message.dispatch_failed",
            successLogContext: {
                portal_host: safeHost(portalUrl),
            },
        }, reqId, "ML_MESSAGE_NOTIFICATION_FAILED");
    }
    async dispatchMail(input, reqId, failureCode) {
        if (this.productionMode) {
            const smtp = this.requireProductionSmtpConfig(input, reqId, failureCode);
            return this.dispatchViaSmtp(input, smtp, reqId, failureCode);
        }
        if (this.smtpPartiallyConfigured) {
            this.logDispatchFailure(input, reqId, "smtp_configuration_incomplete", "smtp");
            throw new MailServiceError(failureCode, 500, "smtp_configuration_incomplete");
        }
        if (this.smtpConfigured && this.smtpConfig) {
            return this.dispatchViaSmtp(input, this.smtpConfig, reqId, failureCode);
        }
        if (this.webhookUrl !== "") {
            return this.dispatchViaWebhook(input, reqId, failureCode);
        }
        this.logger?.info(input.mockLogEvent, {
            email_fp: fingerprint(input.email),
            delivery_mode: "mock",
            ...input.successLogContext,
        }, reqId);
        return {
            sent: true,
            deliveryMode: "mock",
        };
    }
    requireProductionSmtpConfig(input, reqId, failureCode) {
        if (this.smtpConfigured && this.smtpConfig) {
            return this.smtpConfig;
        }
        const reason = this.smtpPartiallyConfigured ? "smtp_configuration_incomplete" : "smtp_configuration_missing";
        this.logDispatchFailure(input, reqId, reason, "smtp");
        throw new MailServiceError(failureCode, 500, reason);
    }
    async dispatchViaWebhook(input, reqId, failureCode) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            const response = await fetch(this.webhookUrl, {
                method: "POST",
                headers: buildWebhookHeaders(this.webhookBearer),
                body: JSON.stringify({
                    to: input.email,
                    subject: input.subject,
                    text: input.text,
                    html: input.html,
                    meta: input.meta,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new MailServiceError(failureCode, 502, `mail_http_${response.status}`);
            }
            this.logger?.info(input.successLogEvent, {
                email_fp: fingerprint(input.email),
                delivery_mode: "webhook",
                ...input.successLogContext,
            }, reqId);
            return {
                sent: true,
                deliveryMode: "webhook",
            };
        }
        catch (err) {
            if (err instanceof MailServiceError) {
                this.logDispatchFailure(input, reqId, err.message, "webhook", err);
                throw err;
            }
            const message = isAbortError(err) ? "mail_timeout" : err instanceof Error ? err.message : "mail_failed";
            this.logDispatchFailure(input, reqId, message, "webhook", err);
            throw new MailServiceError(failureCode, 502, message, { cause: err instanceof Error ? err : undefined });
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    async dispatchViaSmtp(input, smtp, reqId, failureCode) {
        try {
            await sendMailViaSmtp(smtp, {
                to: input.email,
                subject: input.subject,
                text: input.text,
                html: input.html,
            });
            this.logger?.info(input.successLogEvent, {
                email_fp: fingerprint(input.email),
                delivery_mode: "smtp",
                smtp_host: smtp.host,
                smtp_port: smtp.port,
                ...input.successLogContext,
            }, reqId);
            return {
                sent: true,
                deliveryMode: "smtp",
            };
        }
        catch (err) {
            const message = err instanceof MailServiceError
                ? err.message
                : isAbortError(err)
                    ? "smtp_timeout"
                    : err instanceof Error
                        ? err.message
                        : "smtp_failed";
            this.logDispatchFailure(input, reqId, message, "smtp", err);
            if (err instanceof MailServiceError) {
                throw new MailServiceError(failureCode, err.statusCode, err.message, { cause: err });
            }
            throw new MailServiceError(failureCode, 502, message, { cause: err instanceof Error ? err : undefined });
        }
    }
    logDispatchFailure(input, reqId, reason, deliveryMode, err) {
        this.logger?.error(input.errorLogEvent, {
            email_fp: fingerprint(input.email),
            delivery_mode: deliveryMode,
            reason,
        }, reqId, err);
    }
}
exports.MailService = MailService;
async function sendMailViaSmtp(cfg, envelope) {
    const session = await SmtpSession.connect(cfg);
    try {
        let ehlo = await session.ehlo();
        if (!cfg.secure && (cfg.requireTls || ehlo.features.has("STARTTLS"))) {
            if (!ehlo.features.has("STARTTLS")) {
                throw new MailServiceError("ML_SMTP_TLS_REQUIRED", 502, "smtp_starttls_unavailable");
            }
            await session.startTls();
            ehlo = await session.ehlo();
        }
        if (cfg.username !== "" || cfg.password !== "") {
            await session.authenticate(cfg.username, cfg.password, ehlo.features);
        }
        await session.mailFrom(cfg.fromEmail);
        await session.rcptTo(envelope.to);
        await session.data(buildMimeMessage(cfg, envelope));
        await session.quit();
    }
    catch (err) {
        await session.close();
        throw err;
    }
}
class SmtpSession {
    socket;
    channel;
    cfg;
    constructor(socket, cfg) {
        this.socket = socket;
        this.channel = new SmtpChannel(socket);
        this.cfg = cfg;
    }
    static async connect(cfg) {
        const socket = cfg.secure
            ? await connectTlsSocket(cfg)
            : await connectPlainSocket(cfg);
        const session = new SmtpSession(socket, cfg);
        const greeting = await session.channel.readResponse(cfg.timeoutMs);
        assertSmtpResponse(greeting, [220], "smtp_greeting_invalid");
        return session;
    }
    async ehlo() {
        const response = await this.sendCommand(`EHLO ${this.cfg.heloHost}`, [250], "smtp_ehlo_failed");
        return {
            features: parseEhloFeatures(response.lines),
        };
    }
    async startTls() {
        await this.sendCommand("STARTTLS", [220], "smtp_starttls_failed");
        this.channel.dispose();
        const upgradedSocket = await upgradeSocketToTls(this.socket, this.cfg);
        this.socket = upgradedSocket;
        this.channel = new SmtpChannel(upgradedSocket);
    }
    async authenticate(username, password, features) {
        if (username === "" && password === "") {
            return;
        }
        if (username === "" || password === "") {
            throw new MailServiceError("ML_SMTP_AUTH_CONFIG_INVALID", 500, "smtp_auth_config_invalid");
        }
        const authLine = (features.get("AUTH") ?? "").toUpperCase();
        const methods = authLine.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
        if (methods.includes("PLAIN")) {
            const token = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
            await this.sendCommand(`AUTH PLAIN ${token}`, [235], "smtp_auth_failed");
            return;
        }
        if (methods.includes("LOGIN") || methods.length === 0) {
            const first = await this.sendCommand("AUTH LOGIN", [334], "smtp_auth_failed");
            if (first.code !== 334) {
                throw new MailServiceError("ML_SMTP_AUTH_FAILED", 502, "smtp_auth_failed");
            }
            const userResponse = await this.sendCommand(Buffer.from(username, "utf8").toString("base64"), [334], "smtp_auth_failed");
            if (userResponse.code !== 334) {
                throw new MailServiceError("ML_SMTP_AUTH_FAILED", 502, "smtp_auth_failed");
            }
            await this.sendCommand(Buffer.from(password, "utf8").toString("base64"), [235], "smtp_auth_failed");
            return;
        }
        throw new MailServiceError("ML_SMTP_AUTH_UNSUPPORTED", 502, "smtp_auth_unsupported");
    }
    async mailFrom(fromEmail) {
        await this.sendCommand(`MAIL FROM:<${fromEmail}>`, [250], "smtp_mail_from_failed");
    }
    async rcptTo(toEmail) {
        await this.sendCommand(`RCPT TO:<${toEmail}>`, [250, 251], "smtp_rcpt_to_failed");
    }
    async data(mimeMessage) {
        await this.sendCommand("DATA", [354], "smtp_data_start_failed");
        await this.write(`${dotStuff(mimeMessage)}\r\n.\r\n`);
        const response = await this.channel.readResponse(this.cfg.timeoutMs);
        assertSmtpResponse(response, [250], "smtp_data_commit_failed");
    }
    async quit() {
        try {
            await this.sendCommand("QUIT", [221, 250], "smtp_quit_failed");
        }
        finally {
            await this.close();
        }
    }
    async close() {
        this.channel.dispose();
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }
    async sendCommand(command, acceptedCodes, errorMessage) {
        await this.write(`${command}\r\n`);
        const response = await this.channel.readResponse(this.cfg.timeoutMs);
        assertSmtpResponse(response, acceptedCodes, errorMessage);
        return response;
    }
    async write(chunk) {
        await writeSocketChunk(this.socket, chunk, this.cfg.timeoutMs);
    }
}
class SmtpChannel {
    socket;
    lineQueue = [];
    buffer = "";
    pending = null;
    onDataBound;
    onErrorBound;
    onCloseBound;
    constructor(socket) {
        this.socket = socket;
        this.onDataBound = (chunk) => {
            this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            let newlineIndex = this.buffer.indexOf("\n");
            while (newlineIndex >= 0) {
                const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
                this.buffer = this.buffer.slice(newlineIndex + 1);
                if (line !== "") {
                    this.lineQueue.push(line);
                }
                newlineIndex = this.buffer.indexOf("\n");
            }
            this.flushPending();
        };
        this.onErrorBound = (err) => {
            if (!this.pending) {
                return;
            }
            const pending = this.pending;
            this.pending = null;
            clearTimeout(pending.timer);
            pending.reject(err);
        };
        this.onCloseBound = () => {
            if (!this.pending) {
                return;
            }
            const pending = this.pending;
            this.pending = null;
            clearTimeout(pending.timer);
            pending.reject(new MailServiceError("ML_SMTP_CONNECTION_CLOSED", 502, "smtp_connection_closed"));
        };
        socket.on("data", this.onDataBound);
        socket.on("error", this.onErrorBound);
        socket.on("close", this.onCloseBound);
    }
    dispose() {
        this.socket.off("data", this.onDataBound);
        this.socket.off("error", this.onErrorBound);
        this.socket.off("close", this.onCloseBound);
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new MailServiceError("ML_SMTP_CONNECTION_CLOSED", 502, "smtp_connection_replaced"));
            this.pending = null;
        }
    }
    async readResponse(timeoutMs) {
        if (this.pending) {
            throw new MailServiceError("ML_SMTP_PROTOCOL_ERROR", 502, "smtp_pending_response_exists");
        }
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending) {
                    return;
                }
                this.pending = null;
                reject(new MailServiceError("ML_SMTP_TIMEOUT", 502, "smtp_timeout"));
            }, Math.max(250, Math.min(timeoutMs, MAX_TIMEOUT_MS)));
            this.pending = {
                resolve,
                reject,
                timer,
                lines: [],
                expectedCode: null,
            };
            this.flushPending();
        });
    }
    flushPending() {
        if (!this.pending) {
            return;
        }
        while (this.pending && this.lineQueue.length > 0) {
            const line = this.lineQueue.shift();
            this.pending.lines.push(line);
            const match = line.match(/^(\d{3})([\s-])(.*)$/);
            if (!match) {
                continue;
            }
            if (!this.pending.expectedCode) {
                this.pending.expectedCode = match[1];
            }
            if (match[2] === " " && match[1] === this.pending.expectedCode) {
                const pending = this.pending;
                this.pending = null;
                clearTimeout(pending.timer);
                pending.resolve({
                    code: Number.parseInt(match[1], 10),
                    lines: pending.lines.slice(),
                    message: pending.lines.join("\n"),
                });
                return;
            }
        }
    }
}
function resolveSmtpRuntimeConfig(cfg) {
    const host = normalizeOptionalString(cfg.smtpHost
        ?? process.env.ML_SMTP_HOST
        ?? process.env.SMTP_HOST);
    const rawPort = normalizeSmtpPort(cfg.smtpPort
        ?? readPositiveIntEnv("ML_SMTP_PORT", readPositiveIntEnv("SMTP_PORT", 0)));
    const secure = normalizeBooleanEnv(cfg.smtpSecure, process.env.ML_SMTP_SECURE, process.env.SMTP_SECURE, rawPort === SMTP_DEFAULT_PORT_SECURE);
    const port = rawPort > 0 ? rawPort : (host !== "" ? (secure ? SMTP_DEFAULT_PORT_SECURE : SMTP_DEFAULT_PORT_STARTTLS) : 0);
    const requireTls = normalizeBooleanEnv(cfg.smtpRequireTls, process.env.ML_SMTP_REQUIRE_TLS, process.env.SMTP_REQUIRE_TLS, secure ? false : true);
    const username = normalizeOptionalString(cfg.smtpUsername
        ?? process.env.ML_SMTP_USERNAME
        ?? process.env.SMTP_USERNAME
        ?? process.env.ML_SMTP_USER
        ?? process.env.SMTP_USER);
    const password = normalizeOptionalString(cfg.smtpPassword
        ?? process.env.ML_SMTP_PASSWORD
        ?? process.env.SMTP_PASSWORD
        ?? process.env.ML_SMTP_PASS
        ?? process.env.SMTP_PASS);
    const fromEmail = normalizeEmail(cfg.smtpFromEmail
        ?? process.env.ML_SMTP_FROM_EMAIL
        ?? process.env.SMTP_FROM_EMAIL
        ?? process.env.ML_FROM_EMAIL
        ?? process.env.FROM_EMAIL
        ?? "");
    const fromName = normalizeOptionalString(cfg.smtpFromName
        ?? process.env.ML_SMTP_FROM_NAME
        ?? process.env.SMTP_FROM_NAME) || "SOS Prescription";
    const heloHost = normalizeOptionalString(cfg.smtpHeloHost
        ?? process.env.ML_SMTP_HELO_HOSTNAME
        ?? process.env.SMTP_HELO_HOSTNAME
        ?? process.env.ML_SITE_ID) || "localhost";
    const timeoutMs = clampTimeout(cfg.smtpTimeoutMs
        ?? readPositiveIntEnv("ML_SMTP_TIMEOUT_MS", readPositiveIntEnv("SMTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)));
    const providedFields = [host !== "", port > 0, fromEmail !== "", username !== "", password !== ""];
    const hasAnyConfig = providedFields.some(Boolean);
    if (!hasAnyConfig) {
        return { state: "absent", config: null };
    }
    const authConsistent = (username === "" && password === "") || (username !== "" && password !== "");
    const ready = host !== "" && port > 0 && fromEmail !== "" && authConsistent;
    if (!ready) {
        return { state: "partial", config: null };
    }
    return {
        state: "ready",
        config: {
            host,
            port,
            secure,
            requireTls,
            username,
            password,
            fromEmail,
            fromName,
            heloHost,
            timeoutMs,
        },
    };
}
async function connectPlainSocket(cfg) {
    return await new Promise((resolve, reject) => {
        const socket = node_net_1.default.createConnection({ host: cfg.host, port: cfg.port });
        let settled = false;
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("error", onError);
            clearTimeout(timer);
        };
        const onConnect = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            socket.setNoDelay(true);
            resolve(socket);
        };
        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new MailServiceError("ML_SMTP_CONNECT_FAILED", 502, err.message, { cause: err }));
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            socket.destroy();
            reject(new MailServiceError("ML_SMTP_TIMEOUT", 502, "smtp_connect_timeout"));
        }, Math.max(SMTP_CONNECT_TIMEOUT_MS, Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS)));
        socket.once("connect", onConnect);
        socket.once("error", onError);
    });
}
async function connectTlsSocket(cfg) {
    return await new Promise((resolve, reject) => {
        const socket = node_tls_1.default.connect({
            host: cfg.host,
            port: cfg.port,
            servername: cfg.host,
            minVersion: "TLSv1.2",
        });
        let settled = false;
        const cleanup = () => {
            socket.off("secureConnect", onConnect);
            socket.off("error", onError);
            clearTimeout(timer);
        };
        const onConnect = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            socket.setNoDelay(true);
            resolve(socket);
        };
        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new MailServiceError("ML_SMTP_CONNECT_FAILED", 502, err.message, { cause: err }));
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            socket.destroy();
            reject(new MailServiceError("ML_SMTP_TIMEOUT", 502, "smtp_connect_timeout"));
        }, Math.max(SMTP_CONNECT_TIMEOUT_MS, Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS)));
        socket.once("secureConnect", onConnect);
        socket.once("error", onError);
    });
}
async function upgradeSocketToTls(socket, cfg) {
    return await new Promise((resolve, reject) => {
        const upgraded = node_tls_1.default.connect({
            socket: socket,
            servername: cfg.host,
            minVersion: "TLSv1.2",
        });
        let settled = false;
        const cleanup = () => {
            upgraded.off("secureConnect", onConnect);
            upgraded.off("error", onError);
            clearTimeout(timer);
        };
        const onConnect = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            upgraded.setNoDelay(true);
            resolve(upgraded);
        };
        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new MailServiceError("ML_SMTP_STARTTLS_FAILED", 502, err.message, { cause: err }));
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            upgraded.destroy();
            reject(new MailServiceError("ML_SMTP_TIMEOUT", 502, "smtp_starttls_timeout"));
        }, Math.max(SMTP_CONNECT_TIMEOUT_MS, Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS)));
        upgraded.once("secureConnect", onConnect);
        upgraded.once("error", onError);
    });
}
async function writeSocketChunk(socket, chunk, timeoutMs) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new MailServiceError("ML_SMTP_TIMEOUT", 502, "smtp_write_timeout"));
        }, Math.max(250, Math.min(timeoutMs, MAX_TIMEOUT_MS)));
        socket.write(chunk, "utf8", (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (err) {
                reject(new MailServiceError("ML_SMTP_WRITE_FAILED", 502, err.message, { cause: err }));
                return;
            }
            resolve();
        });
    });
}
function assertSmtpResponse(response, acceptedCodes, message) {
    if (acceptedCodes.includes(response.code)) {
        return;
    }
    throw new MailServiceError("ML_SMTP_RESPONSE_UNEXPECTED", response.code >= 500 ? 502 : 500, `${message}:${response.code}`);
}
function parseEhloFeatures(lines) {
    const features = new Map();
    for (const rawLine of lines) {
        const line = rawLine.replace(/^\d{3}[\s-]?/, "").trim();
        if (line === "") {
            continue;
        }
        const separatorIndex = line.indexOf(" ");
        const key = (separatorIndex >= 0 ? line.slice(0, separatorIndex) : line).trim().toUpperCase();
        const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : "";
        if (key !== "") {
            features.set(key, value);
        }
    }
    return features;
}
function buildMimeMessage(cfg, envelope) {
    const boundary = `=_sp_${(0, node_crypto_1.randomBytes)(12).toString("hex")}`;
    const fromHeader = formatAddressHeader(cfg.fromName, cfg.fromEmail);
    const toHeader = formatAddressHeader("", envelope.to);
    const subjectHeader = encodeHeaderValue(envelope.subject);
    const textBody = encodeMimeBase64(envelope.text);
    const htmlBody = encodeMimeBase64(envelope.html);
    const messageId = buildMessageId(cfg.fromEmail);
    return [
        `From: ${fromHeader}`,
        `To: ${toHeader}`,
        `Subject: ${subjectHeader}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "X-Mailer: SOS Prescription Worker",
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        textBody,
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        htmlBody,
        `--${boundary}--`,
        "",
    ].join("\r\n");
}
function buildWebhookHeaders(bearer) {
    const headers = {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
    };
    if (bearer !== "") {
        headers.Authorization = `Bearer ${bearer}`;
    }
    return headers;
}
function buildMagicLinkPlainTextBody(magicUrl, ttlMinutes) {
    return [
        "Bonjour,",
        "",
        "Cliquez sur le lien ci-dessous pour vous connecter à votre espace SOS Prescription :",
        magicUrl,
        "",
        `Ce lien est valable ${ttlMinutes} minute${ttlMinutes > 1 ? "s" : ""} et ne peut être utilisé qu’une seule fois.`,
        "",
        "Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.",
    ].join("\n");
}
function buildMagicLinkHtmlBody(magicUrl, ttlMinutes) {
    const escapedUrl = escapeHtml(magicUrl);
    const ttlLabel = `${ttlMinutes} minute${ttlMinutes > 1 ? "s" : ""}`;
    return [
        "<!doctype html>",
        '<html lang="fr">',
        "<body>",
        "<p>Bonjour,</p>",
        "<p>Cliquez sur le lien ci-dessous pour vous connecter à votre espace SOS Prescription :</p>",
        `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
        `<p>Ce lien est valable ${escapeHtml(ttlLabel)} et ne peut être utilisé qu’une seule fois.</p>`,
        "<p>Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.</p>",
        "</body>",
        "</html>",
    ].join("");
}
function buildNewMessageNotificationPlainTextBody(portalUrl) {
    return [
        "Bonjour,",
        "",
        "Vous avez un nouveau message de votre médecin sur SOS Prescription.",
        "Connectez-vous à votre espace pour lui répondre.",
        portalUrl,
    ].join("\n");
}
function buildNewMessageNotificationHtmlBody(portalUrl) {
    const escapedUrl = escapeHtml(portalUrl);
    return [
        "<!doctype html>",
        '<html lang="fr">',
        "<body>",
        "<p>Bonjour,</p>",
        "<p>Vous avez un nouveau message de votre médecin sur SOS Prescription.</p>",
        "<p>Connectez-vous à votre espace pour lui répondre.</p>",
        `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
        "</body>",
        "</html>",
    ].join("");
}
function buildMagicUrl(baseUrl, token) {
    const url = new URL(baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
}
function buildPatientPortalUrl(baseUrl, prescriptionUid) {
    const url = new URL(baseUrl);
    const normalizedUid = normalizeOptionalString(prescriptionUid);
    if (normalizedUid !== "") {
        url.searchParams.set("rx_uid", normalizedUid);
    }
    return url.toString();
}
function normalizeBaseUrl(value, fallback) {
    const raw = normalizeOptionalString(value);
    if (raw === "") {
        return fallback;
    }
    try {
        return new URL(raw).toString();
    }
    catch {
        return fallback;
    }
}
function normalizeOptionalString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeEmail(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}
function normalizeToken(value) {
    const normalized = String(value || "").trim();
    if (normalized.length < 32 || normalized.length > 256) {
        return "";
    }
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
        return "";
    }
    return normalized;
}
function normalizeSmtpPort(value) {
    if (!Number.isFinite(value) || value <= 0 || value > 65535) {
        return 0;
    }
    return Math.trunc(value);
}
function clampTimeout(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}
function readPositiveIntEnv(key, fallback) {
    const raw = normalizeOptionalString(process.env[key]);
    if (raw === "") {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function fingerprint(value) {
    return Buffer.from(String(value || ""), "utf8").toString("base64url").slice(0, 12);
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return "unknown";
    }
}
function isAbortError(err) {
    if (!err || typeof err !== "object") {
        return false;
    }
    const candidate = err;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return name === "AbortError" || /abort/i.test(message) || /timeout/i.test(message);
}
function isProductionRuntime() {
    const env = normalizeOptionalString(process.env.SOSPRESCRIPTION_ENV).toLowerCase();
    if (env === "prod" || env === "production") {
        return true;
    }
    return normalizeOptionalString(process.env.NODE_ENV).toLowerCase() === "production";
}
function normalizeBooleanEnv(explicitValue, primaryEnv, secondaryEnv, fallback) {
    if (typeof explicitValue === "boolean") {
        return explicitValue;
    }
    const raw = normalizeOptionalString(primaryEnv) || normalizeOptionalString(secondaryEnv);
    if (raw === "") {
        return fallback;
    }
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
function formatAddressHeader(name, email) {
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === "") {
        throw new MailServiceError("ML_SMTP_ADDRESS_INVALID", 500, "smtp_address_invalid");
    }
    const normalizedName = normalizeOptionalString(name);
    if (normalizedName === "") {
        return `<${normalizedEmail}>`;
    }
    return `${encodeHeaderValue(normalizedName)} <${normalizedEmail}>`;
}
function encodeHeaderValue(value) {
    const normalized = String(value || "").replace(/[\r\n]+/g, " ").trim();
    if (normalized === "") {
        return "";
    }
    if (/^[\x20-\x7E]+$/.test(normalized)) {
        return normalized;
    }
    return `=?UTF-8?B?${Buffer.from(normalized, "utf8").toString("base64")}?=`;
}
function buildMessageId(fromEmail) {
    const domain = normalizeEmail(fromEmail).split("@")[1] || "sosprescription.local";
    return `<${Date.now()}.${(0, node_crypto_1.randomBytes)(8).toString("hex")}@${domain}>`;
}
function encodeMimeBase64(value) {
    return chunkString(Buffer.from(String(value || ""), "utf8").toString("base64"), 76).join("\r\n");
}
function chunkString(value, chunkSize) {
    if (value === "") {
        return [""];
    }
    const chunks = [];
    for (let offset = 0; offset < value.length; offset += chunkSize) {
        chunks.push(value.slice(offset, offset + chunkSize));
    }
    return chunks;
}
function dotStuff(value) {
    return value
        .replace(/\r?\n/g, "\r\n")
        .replace(/(^|\r\n)\./g, "$1..");
}
function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
