import type { Cookie } from 'playwright';
import type { ScannedCookie } from './types.js';

const UNITS: Array<[string, number]> = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
];

/** Turn a cookie's `expires` (epoch seconds, -1 for session) into a lifetime like "13 months". */
export function humanExpiration(expires: number, now = Date.now()): string {
    if (expires === -1) {
        return 'session';
    }
    const seconds = Math.round(expires - now / 1000);
    if (seconds <= 0) {
        return 'expired';
    }
    for (const [unit, size] of UNITS) {
        // Prefer "18 months" over "1 year" when it's not a whole number of years.
        const value = seconds / size;
        if (value >= 1 && (unit !== 'year' || Math.abs(value - Math.round(value)) < 0.05)) {
            const rounded = Math.round(value);
            return `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
        }
    }
    return `${seconds} seconds`;
}

export function isThirdParty(cookieDomain: string, siteHost: string): boolean {
    const domain = cookieDomain.replace(/^\./, '').toLowerCase();
    const host = siteHost.replace(/^www\./, '').toLowerCase();
    return !(domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
}

export const cookieKey = (cookie: { name: string; domain: string }): string => `${cookie.name}@${cookie.domain}`;

export function normaliseCookie(cookie: Cookie, page: string, setBeforeConsent: boolean, siteHost: string): ScannedCookie {
    return {
        name: cookie.name,
        domain: cookie.domain,
        expiration: humanExpiration(cookie.expires),
        firstSeenOn: page,
        setBeforeConsent,
        httpOnly: cookie.httpOnly,
        thirdParty: isThirdParty(cookie.domain, siteHost),
    };
}
