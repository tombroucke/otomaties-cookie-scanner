import { readFileSync } from 'node:fs';
import type { Category, Suggestion } from './types.js';

// Open Cookie Database by jkwakman (Apache-2.0), bundled in data/.
const CSV_PATH = new URL('../data/open-cookie-database.csv', import.meta.url);

const CATEGORY_MAP: Record<string, Category> = {
    necessary: 'necessary',
    // OCD files most first-party session/cart/login cookies under "Functional".
    functional: 'necessary',
    analytics: 'analytics',
    marketing: 'advertising',
    personalization: 'personalization',
    security: 'security',
};

// Cookies missing from the Open Cookie Database that every site using this plugin sets.
const SUPPLEMENT = `ID,Platform,Category,Cookie / Data Key name,Domain,Description,Retention period,Data Controller,User Privacy & GDPR Rights Portals,Wildcard match
,CookieConsent,Necessary,cc_cookie,,Stores the visitor's cookie consent preferences,6 months,,,0
`;

interface Entry {
    platform: string;
    category: string;
    name: string;
    domain: string;
    description: string;
    retention: string;
    wildcard: boolean;
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n') {
                i++;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += char;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

export class CookieDatabase {
    private readonly exact = new Map<string, Entry[]>();
    private readonly prefixes: Entry[] = [];

    constructor(csv: string = readFileSync(CSV_PATH, 'utf8')) {
        const [, ...rows] = parseCsv(csv);
        const [, ...supplement] = parseCsv(SUPPLEMENT);
        for (const [, platform, category, name, domain, description, retention, , , wildcard] of [...supplement, ...rows]) {
            if (!name) {
                continue;
            }
            const entry: Entry = {
                platform: platform ?? '',
                category: category ?? '',
                name: name.trim(),
                domain: domain ?? '',
                description: description?.trim() ?? '',
                retention: retention?.trim() ?? '',
                wildcard: wildcard?.trim() === '1',
            };
            if (entry.wildcard) {
                this.prefixes.push(entry);
            } else {
                this.exact.set(entry.name, [...(this.exact.get(entry.name) ?? []), entry]);
            }
        }
        // Longest prefix wins.
        this.prefixes.sort((a, b) => b.name.length - a.name.length);
    }

    lookup(name: string, domain = ''): Suggestion | null {
        const bareDomain = domain.replace(/^\./, '');
        const candidates = this.exact.get(name);
        const entry =
            candidates?.find((c) => c.domain && bareDomain.endsWith(c.domain.replace(/^\./, ''))) ??
            candidates?.[0] ??
            this.prefixes.find((p) => name.startsWith(p.name));
        if (!entry) {
            return null;
        }
        return {
            category: CATEGORY_MAP[entry.category.toLowerCase()] ?? 'necessary',
            sourceCategory: entry.category,
            platform: entry.platform,
            description: entry.description,
            expiration: entry.retention,
            matchedName: entry.name,
            wildcard: entry.wildcard,
        };
    }
}
