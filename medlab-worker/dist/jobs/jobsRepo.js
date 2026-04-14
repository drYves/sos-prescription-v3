"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobsRepoActionError = void 0;
class JobsRepoActionError extends Error {
    code;
    statusCode;
    stage;
    details;
    constructor(init) {
        super(init.message);
        this.name = "JobsRepoActionError";
        this.code = init.code;
        this.statusCode = init.statusCode ?? 500;
        this.stage = init.stage ?? "unknown";
        this.details = init.details;
        if (init.cause !== undefined) {
            this.cause = init.cause;
        }
    }
}
exports.JobsRepoActionError = JobsRepoActionError;
