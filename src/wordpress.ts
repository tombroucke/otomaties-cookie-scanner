import type { NewWpCookie, WpCookie } from './types.js';

export class ConflictError extends Error {}

export class WordPressClient {
    private readonly endpoint: string;
    private readonly authorization: string;

    constructor(siteUrl: string, auth: string) {
        this.endpoint = new URL('/wp-json/otomaties-cookie-consent/v1/cookies', siteUrl).toString();
        this.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    }

    private async request(method: string, url: string, body?: unknown): Promise<Response> {
        const response = await fetch(url, {
            method,
            headers: {
                Authorization: this.authorization,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 409) {
            throw new ConflictError(await errorMessage(response));
        }
        if (!response.ok) {
            throw new Error(`${method} ${url} → ${response.status}: ${await errorMessage(response)}`);
        }
        return response;
    }

    async list(): Promise<WpCookie[]> {
        const response = await this.request('GET', this.endpoint);
        return (await response.json()) as WpCookie[];
    }

    async create(cookie: NewWpCookie): Promise<WpCookie> {
        const response = await this.request('POST', this.endpoint, cookie);
        return (await response.json()) as WpCookie;
    }

    // PATCH and DELETE are deliberately not implemented: existing entries are curated by humans.
}

async function errorMessage(response: Response): Promise<string> {
    const text = await response.text();
    try {
        const json = JSON.parse(text) as { message?: string; code?: string };
        return json.message ?? json.code ?? text;
    } catch {
        return text.slice(0, 200);
    }
}

/** Converts a wildcard pattern like `_ga_*` into an anchored RegExp. */
export function wildcardToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

/** Finds the existing WordPress entry that covers a scanned cookie name, if any. */
export function findExisting(name: string, existing: WpCookie[]): WpCookie | undefined {
    return (
        existing.find((entry) => !entry.regex && entry.name === name) ??
        existing.find((entry) => entry.regex && wildcardToRegExp(entry.name).test(name))
    );
}
