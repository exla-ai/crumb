// Exit codes are part of the agent contract (see SPEC.md).
const EXIT = {
    INVALID_ID: 2,
    INVALID_INPUT: 2,
    NOT_FOUND: 3,
    AMBIGUOUS: 3,
    NEEDS_LOGIN: 4,
    NO_DISPLAY: 4,
    LOCKED: 5,
    NOT_RUNNING: 3,
    BROWSER_NOT_FOUND: 6,
    IMPORT_FAILED: 1,
    KEY_UNAVAILABLE: 4,
    EXPORT_DENIED: 5,
    INTERNAL: 1,
};
const HUMAN = new Set(['NEEDS_LOGIN', 'NO_DISPLAY', 'KEY_UNAVAILABLE']);
export class CrumbError extends Error {
    code;
    hint;
    candidates;
    constructor(code, message, hint, candidates) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.candidates = candidates;
    }
    get exitCode() {
        return EXIT[this.code];
    }
    toJSON() {
        return {
            format: 'crumb.error',
            version: 1,
            code: this.code,
            message: this.message,
            ...(this.hint ? { hint: this.hint } : {}),
            needsHuman: HUMAN.has(this.code),
            ...(this.candidates ? { candidates: this.candidates } : {}),
        };
    }
}
