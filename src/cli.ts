#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { input, password, select } from '@inquirer/prompts';
import { collectUrls } from './sitemap.js';
import { scan } from './scanner.js';
import { CookieDatabase } from './cookie-database.js';
import { ConflictError, WordPressClient, findExisting } from './wordpress.js';
import { log, warn } from './log.js';
import { CATEGORIES, type Category, type NewWpCookie, type ScannedCookie, type Suggestion, type WpCookie } from './types.js';

interface Options {
    url: string;
    auth?: string;
    user?: string;
    dryRun: boolean;
    maxPages: number;
    perType: number;
    json: boolean;
    headed: boolean;
    yes: boolean;
}

/** A scanned cookie name, merged across the domains it was seen on. Names are unique in WordPress. */
interface Candidate {
    name: string;
    domains: string[];
    expiration: string;
    firstSeenOn: string;
    setBeforeConsent: boolean;
    thirdParty: boolean;
}

interface Report {
    url: string;
    dryRun: boolean;
    pagesScanned: number;
    failedPages: string[];
    consentApiFound: boolean;
    known: Array<Candidate & { category: Category; matchedEntry: string; wildcard: boolean }>;
    created: Array<Candidate & { entry: NewWpCookie }>;
    skipped: Array<Candidate & { reason: string; suggestion: Suggestion | null }>;
    setBeforeConsent: Array<Candidate & { category: Category | null }>;
}

type Decision = { action: 'create'; entry: NewWpCookie } | { action: 'skip'; reason: string } | { action: 'skip-all' };

const positiveInt = (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new InvalidArgumentError('Must be a positive integer.');
    }
    return parsed;
};

function parseOptions(): Options {
    const program = new Command()
        .name('cookie-scanner')
        .description('Scan a WordPress site for cookies and add new ones to otomaties-cookie-consent.')
        .requiredOption('--url <url>', 'site to scan, e.g. https://example.be')
        .option('--user <name>', 'WordPress username; the application password is asked for')
        .option('--auth <user:password>', 'username and application password in one (or env COOKIE_SCANNER_AUTH); ends up in shell history')
        .option('--dry-run', 'print what would be created, do not push to WordPress', false)
        .option('--max-pages <n>', 'maximum number of pages to visit', positiveInt, 30)
        .option('--per-type <n>', 'pages to sample per post type / taxonomy', positiveInt, 3)
        .option('--json', 'print the report as JSON on stdout', false)
        .option('--headed', 'show the browser', false)
        .option('-y, --yes', 'accept Open Cookie Database suggestions without asking; unknown cookies are skipped', false)
        .parse();
    const options = program.opts<Options>();
    options.auth ??= process.env.COOKIE_SCANNER_AUTH;
    try {
        options.url = new URL(options.url).toString();
    } catch {
        program.error(`Invalid --url: ${options.url}`);
    }
    if (!options.auth && !options.dryRun && !process.stdin.isTTY) {
        program.error('--auth or COOKIE_SCANNER_AUTH is required when not running in a terminal.');
    }
    return options;
}

/**
 * Asks for the credentials that weren't passed. A dry run only asks when --user is given,
 * since it can run without them.
 */
async function resolveAuth(options: Options): Promise<string | undefined> {
    if (options.auth) {
        return options.auth;
    }
    if (!process.stdin.isTTY || (options.dryRun && !options.user)) {
        return undefined;
    }
    const context = { output: process.stderr };
    const user = options.user ?? (await input({ message: 'WordPress username', required: true }, context));
    const secret = await password({ message: `Application password for ${user}`, mask: '*' }, context);
    return `${user}:${secret}`;
}

function mergeByName(cookies: ScannedCookie[]): Candidate[] {
    const byName = new Map<string, Candidate>();
    for (const cookie of cookies) {
        const existing = byName.get(cookie.name);
        if (!existing) {
            byName.set(cookie.name, {
                name: cookie.name,
                domains: [cookie.domain],
                expiration: cookie.expiration,
                firstSeenOn: cookie.firstSeenOn,
                setBeforeConsent: cookie.setBeforeConsent,
                thirdParty: cookie.thirdParty,
            });
            continue;
        }
        existing.domains.push(cookie.domain);
        existing.setBeforeConsent ||= cookie.setBeforeConsent;
        existing.thirdParty &&= cookie.thirdParty;
    }
    return [...byName.values()];
}

function entryFromSuggestion(candidate: Candidate, suggestion: Suggestion): NewWpCookie {
    return {
        category: suggestion.category,
        name: candidate.name,
        domain: candidate.domains.join(', '),
        expiration: suggestion.expiration || candidate.expiration,
        description: suggestion.description,
    };
}

async function ask(candidate: Candidate, suggestion: Suggestion | null): Promise<Decision> {
    const context = { output: process.stderr };
    log('');
    log(`New cookie: ${candidate.name}`);
    log(`  domain:         ${candidate.domains.join(', ')}${candidate.thirdParty ? ' (third-party)' : ''}`);
    log(`  expiration:     ${candidate.expiration}`);
    log(`  first seen on:  ${candidate.firstSeenOn}`);
    log(`  before consent: ${candidate.setBeforeConsent ? 'YES' : 'no'}`);
    if (suggestion) {
        log(`  Open Cookie DB: ${suggestion.platform} / ${suggestion.sourceCategory}${suggestion.wildcard ? ` (wildcard ${suggestion.matchedName}*)` : ''}`);
        log(`                  ${suggestion.description}`);
    } else {
        log('  Open Cookie DB: no match');
    }

    const choice = await select<Category | 'skip' | 'skip-all'>(
        {
            message: `Category for ${candidate.name}`,
            default: suggestion?.category ?? 'skip',
            choices: [
                ...CATEGORIES.map((category) => ({
                    value: category,
                    name: category === suggestion?.category ? `${category} (suggested)` : category,
                })),
                { value: 'skip', name: 'skip' },
                { value: 'skip-all', name: 'skip all remaining' },
            ],
        },
        context,
    );
    if (choice === 'skip') {
        return { action: 'skip', reason: 'skipped by user' };
    }
    if (choice === 'skip-all') {
        return { action: 'skip-all' };
    }
    const description = await input({ message: 'Description', default: suggestion?.description ?? '' }, context);
    const expiration = await input({ message: 'Expiration', default: suggestion?.expiration || candidate.expiration }, context);
    return {
        action: 'create',
        entry: { category: choice, name: candidate.name, domain: candidate.domains.join(', '), expiration, description },
    };
}

function printReport(report: Report): void {
    const out = (line = '') => console.log(line);
    const pad = (value: string, width: number) => value.padEnd(width);
    const width = Math.min(
        40,
        Math.max(10, ...[...report.known, ...report.created, ...report.skipped].map((c) => c.name.length)) + 2,
    );

    out('');
    out(`Scanned ${report.pagesScanned} page(s) on ${report.url}${report.dryRun ? ' (dry run)' : ''}`);
    if (report.failedPages.length) {
        out(`Failed to load: ${report.failedPages.join(', ')}`);
    }
    if (!report.consentApiFound) {
        out('Warning: no cookieconsent API was found, so "accept all" could not be triggered.');
    }

    out('');
    out(`Known (${report.known.length})`);
    for (const c of report.known) {
        out(`  ${pad(c.name, width)}${pad(c.category, 16)}${c.wildcard ? `via ${c.matchedEntry}` : ''}`);
    }

    out('');
    out(`${report.dryRun ? 'New — would create' : 'New — created'} (${report.created.length})`);
    for (const c of report.created) {
        out(`  ${pad(c.name, width)}${pad(c.entry.category, 16)}${pad(c.entry.expiration ?? '', 12)}${c.entry.description ?? ''}`);
    }

    out('');
    out(`Skipped (${report.skipped.length})`);
    for (const c of report.skipped) {
        out(`  ${pad(c.name, width)}${c.reason}`);
    }

    out('');
    out(`Set before consent (${report.setBeforeConsent.length})`);
    for (const c of report.setBeforeConsent) {
        const flag = c.category === 'necessary' || c.category === 'security' ? ' ' : '!';
        out(`${flag} ${pad(c.name, width)}${pad(c.category ?? 'unknown', 16)}${c.domains.join(', ')}  (${c.firstSeenOn})`);
    }
    if (report.setBeforeConsent.some((c) => c.category !== 'necessary' && c.category !== 'security')) {
        out('  ! = not categorised as necessary/security, review whether it may be set before consent');
    }
}

async function main(): Promise<void> {
    const options = parseOptions();
    const auth = await resolveAuth(options);
    const client = auth ? new WordPressClient(options.url, auth) : null;
    const database = new CookieDatabase();

    let existing: WpCookie[] = [];
    if (client) {
        existing = await client.list();
        log(`Fetched ${existing.length} existing cookie definition(s) from WordPress`);
    } else {
        warn('No --auth given: every scanned cookie is treated as new.');
    }

    const urls = await collectUrls(options.url, options.maxPages, options.perType);
    const result = await scan(urls, { headed: options.headed });
    const candidates = mergeByName(result.cookies);

    const report: Report = {
        url: options.url,
        dryRun: options.dryRun,
        pagesScanned: urls.length - result.failedPages.length,
        failedPages: result.failedPages,
        consentApiFound: result.consentApiFound,
        known: [],
        created: [],
        skipped: [],
        setBeforeConsent: [],
    };

    const interactive = !options.dryRun && !options.yes && process.stdin.isTTY;
    if (!options.dryRun && !options.yes && !interactive) {
        warn('stdin is not a TTY and --yes is not set: new cookies will be skipped.');
    }

    const knownCategory = new Map<string, Category>();
    let skipAll = false;
    for (const candidate of candidates) {
        const match = findExisting(candidate.name, existing);
        if (match) {
            knownCategory.set(candidate.name, match.category);
            report.known.push({ ...candidate, category: match.category, matchedEntry: match.name, wildcard: match.regex });
            continue;
        }

        const suggestion = database.lookup(candidate.name, candidate.domains[0]);
        let decision: Decision;
        if (skipAll) {
            decision = { action: 'skip', reason: 'skipped by user' };
        } else if (options.dryRun || options.yes) {
            decision = suggestion
                ? { action: 'create', entry: entryFromSuggestion(candidate, suggestion) }
                : { action: 'skip', reason: 'unknown to Open Cookie Database' };
        } else if (interactive) {
            decision = await ask(candidate, suggestion);
        } else {
            decision = { action: 'skip', reason: 'no TTY to ask for a category' };
        }

        if (decision.action === 'skip-all') {
            skipAll = true;
            decision = { action: 'skip', reason: 'skipped by user' };
        }
        if (decision.action === 'skip') {
            report.skipped.push({ ...candidate, reason: decision.reason, suggestion });
            continue;
        }

        if (options.dryRun || !client) {
            knownCategory.set(candidate.name, decision.entry.category);
            report.created.push({ ...candidate, entry: decision.entry });
            continue;
        }
        try {
            await client.create(decision.entry);
            knownCategory.set(candidate.name, decision.entry.category);
            report.created.push({ ...candidate, entry: decision.entry });
        } catch (error) {
            if (error instanceof ConflictError) {
                report.skipped.push({ ...candidate, reason: `already exists in WordPress (${error.message})`, suggestion });
            } else {
                report.skipped.push({ ...candidate, reason: `create failed: ${(error as Error).message}`, suggestion });
            }
        }
    }

    report.setBeforeConsent = candidates
        .filter((c) => c.setBeforeConsent)
        .map((c) => ({ ...c, category: knownCategory.get(c.name) ?? null }));

    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printReport(report);
    }
}

main().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'ExitPromptError') {
        console.error('\nAborted.');
        process.exit(130);
    }
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
