import { log, warn } from './log.js';

const SITEMAP_CANDIDATES = ['/wp-sitemap.xml', '/sitemap_index.xml'];
const SKIPPED_GROUPS = /^(users?|author)$/;

async function fetchText(url: string): Promise<string | null> {
    try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) {
            return null;
        }
        return await response.text();
    } catch {
        return null;
    }
}

function extractLocs(xml: string, tag: 'sitemap' | 'url'): string[] {
    const blocks = xml.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g')) ?? [];
    return blocks
        .map((block) => block.match(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/)?.[1]?.trim())
        .filter((loc): loc is string => !!loc)
        .map((loc) => loc.replace(/&amp;/g, '&'));
}

/**
 * Derive a group (post type / taxonomy) from a sub-sitemap URL.
 *   core:  wp-sitemap-posts-product-1.xml   → product
 *          wp-sitemap-taxonomies-category-1.xml → category
 *   Yoast: product_cat-sitemap.xml / product-sitemap2.xml → product_cat / product
 */
export function sitemapGroup(url: string): string {
    const file = new URL(url).pathname.split('/').pop() ?? url;
    const core = file.match(/^wp-sitemap-(?:posts|taxonomies)-(.+?)-\d+\.xml$/);
    if (core) {
        return core[1];
    }
    if (/^wp-sitemap-users-\d+\.xml$/.test(file)) {
        return 'users';
    }
    const yoast = file.match(/^(.+?)-sitemap\d*\.xml$/);
    if (yoast) {
        return yoast[1];
    }
    return file;
}

function normaliseUrl(url: string): string {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
}

/**
 * Collect a sample of URLs: the homepage, plus up to `perGroup` URLs from each post type /
 * taxonomy sitemap, picked round-robin so every group is represented before `maxPages` is hit.
 */
export async function collectUrls(baseUrl: string, maxPages: number, perGroup: number): Promise<string[]> {
    const base = new URL(baseUrl);
    const homepage = normaliseUrl(base.origin + '/');
    const groups = new Map<string, string[]>();

    let index: string | null = null;
    for (const candidate of SITEMAP_CANDIDATES) {
        const url = new URL(candidate, base.origin).toString();
        index = await fetchText(url);
        if (index && /<(sitemapindex|urlset)\b/.test(index)) {
            log(`Using sitemap ${url}`);
            break;
        }
        index = null;
    }

    if (!index) {
        warn('No sitemap found; scanning the homepage only.');
        return [homepage];
    }

    const subSitemaps = extractLocs(index, 'sitemap');
    if (subSitemaps.length === 0) {
        // A plain urlset instead of an index.
        groups.set('pages', extractLocs(index, 'url'));
    }
    for (const sub of subSitemaps) {
        const group = sitemapGroup(sub);
        if (SKIPPED_GROUPS.test(group)) {
            continue;
        }
        const xml = await fetchText(sub);
        if (!xml) {
            warn(`Could not fetch ${sub}`);
            continue;
        }
        groups.set(group, [...(groups.get(group) ?? []), ...extractLocs(xml, 'url')]);
    }

    const seen = new Set<string>([homepage]);
    const urls = [homepage];
    const queues = [...groups.entries()].map(([group, list]) => ({
        group,
        list: list.filter((url) => {
            try {
                return new URL(url).origin === base.origin;
            } catch {
                return false;
            }
        }),
        taken: 0,
    }));

    let progressed = true;
    while (urls.length < maxPages && progressed) {
        progressed = false;
        for (const queue of queues) {
            if (urls.length >= maxPages) {
                break;
            }
            while (queue.taken < perGroup && queue.list.length > 0) {
                const url = normaliseUrl(queue.list.shift()!);
                if (seen.has(url)) {
                    continue;
                }
                seen.add(url);
                urls.push(url);
                queue.taken++;
                progressed = true;
                break;
            }
        }
    }

    log(`Collected ${urls.length} URL(s) from ${queues.length} sitemap group(s): ${queues.map((q) => `${q.group} (${q.taken})`).join(', ')}`);
    return urls;
}
