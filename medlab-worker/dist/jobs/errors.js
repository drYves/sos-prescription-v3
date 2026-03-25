"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HardError = exports.SoftError = void 0;
class SoftError extends Error {
    code;
    messageSafe;
    constructor(code, messageSafe) {
        super(messageSafe);
        this.code = code;
        this.messageSafe = messageSafe;
    }
}
exports.SoftError = SoftError;
class HardError extends Error {
    code;
    messageSafe;
    constructor(code, messageSafe) {
        super(messageSafe);
        this.code = code;
        this.messageSafe = messageSafe;
    }
}
exports.HardError = HardError;
