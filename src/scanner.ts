import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { cookieKey, normaliseCookie } from './normalise.js';
import { log, warn } from './log.js';
import type { ScannedCookie } from './types.js';

export interface ScanOptions {
    headed: boolean;
}

export interface ScanResult {
    cookies: ScannedCookie[];
    consentApiFound: boolean;
    failedPages: string[];
}

const NAVIGATION_TIMEOUT = 30_000;
const SETTLE_TIMEOUT = 8_000;
const CONSENT_TIMEOUT = 10_000;

async function launch(options: ScanOptions): Promise<Browser> {
    try {
        return await chromium.launch({ headless: !options.headed });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Executable doesn't exist|playwright install/i.test(message)) {
            throw new Error('Chromium is not installed for Playwright. Run: npx playwright install chromium');
        }
        throw error;
    }
}

async function newContext(browser: Browser): Promise<BrowserContext> {
    // Some WAFs block the "HeadlessChrome" user agent; present as regular Chrome.
    const userAgent = (await browser.newPage().then(async (page) => {
        const ua = await page.evaluate(() => navigator.userAgent);
        await page.close();
        return ua;
    })).replace('HeadlessChrome', 'Chrome');
    return browser.newContext({ userAgent, locale: 'nl-BE', viewport: { width: 1366, height: 900 } });
}

async function visit(page: Page, url: string): Promise<boolean> {
    try {
        await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT });
        // Give tag managers and consent-gated scripts a moment to run.
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => undefined);
        return true;
    } catch (error) {
        warn(`Failed to load ${url}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
        return false;
    }
}

async function collect(
    context: BrowserContext,
    page: string,
    found: Map<string, ScannedCookie>,
    setBeforeConsent: boolean,
    siteHost: string,
): Promise<number> {
    let added = 0;
    for (const cookie of await context.cookies()) {
        const key = cookieKey(cookie);
        if (!found.has(key)) {
            found.set(key, normaliseCookie(cookie, page, setBeforeConsent, siteHost));
            added++;
        }
    }
    return added;
}

/**
 * Accept all categories through the orestbida/cookieconsent v3 API. The library's UMD build exposes
 * window.CookieConsent; the otomaties-cookie-consent plugin bundles it and exposes it as document.cc.
 */
async function acceptAll(page: Page): Promise<boolean> {
    try {
        await page.waitForFunction(
            () => typeof ((window as any).CookieConsent ?? (document as any).cc)?.acceptCategory === 'function',
            undefined,
            { timeout: CONSENT_TIMEOUT },
        );
    } catch {
        return false;
    }
    await page.evaluate(() => ((window as any).CookieConsent ?? (document as any).cc).acceptCategory('all'));
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => undefined);
    return true;
}

export async function scan(urls: string[], options: ScanOptions): Promise<ScanResult> {
    const siteHost = new URL(urls[0]).hostname;
    const found = new Map<string, ScannedCookie>();
    const failedPages = new Set<string>();
    const browser = await launch(options);

    try {
        log(`\nPre-consent pass (${urls.length} pages)`);
        const preContext = await newContext(browser);
        const prePage = await preContext.newPage();
        for (const [i, url] of urls.entries()) {
            if (!(await visit(prePage, url))) {
                failedPages.add(url);
                continue;
            }
            const added = await collect(preContext, url, found, true, siteHost);
            log(`  [${i + 1}/${urls.length}] ${url}${added ? `  +${added}` : ''}`);
        }
        await preContext.close();

        log(`\nAccept-all pass (${urls.length} pages)`);
        const postContext = await newContext(browser);
        const postPage = await postContext.newPage();
        let consentApiFound = false;
        if (await visit(postPage, urls[0])) {
            consentApiFound = await acceptAll(postPage);
            if (!consentApiFound) {
                warn('No cookieconsent API (window.CookieConsent / document.cc) found; the accept-all pass ran without consent.');
            }
            await collect(postContext, urls[0], found, false, siteHost);
        }
        for (const [i, url] of urls.entries()) {
            if (!(await visit(postPage, url))) {
                failedPages.add(url);
                continue;
            }
            const added = await collect(postContext, url, found, false, siteHost);
            log(`  [${i + 1}/${urls.length}] ${url}${added ? `  +${added}` : ''}`);
        }
        await postContext.close();

        return {
            cookies: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
            consentApiFound,
            failedPages: [...failedPages],
        };
    } finally {
        await browser.close();
    }
}
