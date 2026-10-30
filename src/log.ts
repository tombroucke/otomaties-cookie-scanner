// Progress and diagnostics go to stderr so stdout stays clean for --json.
export const log = (...args: unknown[]): void => {
    console.error(...args);
};

export const warn = (message: string): void => {
    console.error(`! ${message}`);
};
