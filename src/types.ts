export const CATEGORIES = ['necessary', 'analytics', 'advertising', 'personalization', 'security'] as const;
export type Category = (typeof CATEGORIES)[number];

/** A cookie as observed in the browser, deduplicated by name + domain. */
export interface ScannedCookie {
    name: string;
    domain: string;
    /** Human readable lifetime, e.g. "1 year", "30 days" or "session". */
    expiration: string;
    firstSeenOn: string;
    setBeforeConsent: boolean;
    httpOnly: boolean;
    thirdParty: boolean;
}

/** An entry as returned by the otomaties-cookie-consent REST API. */
export interface WpCookie {
    category: Category;
    name: string;
    domain: string;
    expiration: string;
    description: string;
    regex: boolean;
}

export interface NewWpCookie {
    category: Category;
    name: string;
    domain?: string;
    expiration?: string;
    description?: string;
}

export interface Suggestion {
    category: Category;
    sourceCategory: string;
    platform: string;
    description: string;
    expiration: string;
    /** The Open Cookie Database entry name that matched (may be a wildcard prefix). */
    matchedName: string;
    wildcard: boolean;
}
