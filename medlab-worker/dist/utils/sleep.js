"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
async function sleep(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
