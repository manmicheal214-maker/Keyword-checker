'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const KEYWORDS_FILE = path.join(
  ROOT_DIR,
  'config',
  'keywords.json'
);

const SETTINGS_FILE = path.join(
  ROOT_DIR,
  'config',
  'settings.json'
);

const RANKINGS_FILE = path.join(
  ROOT_DIR,
  'data',
  'rankings.json'
);

const HISTORY_FILE = path.join(
  ROOT_DIR,
  'data',
  'history.json'
);

const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY;

const DEFAULT_SETTINGS = {
  country: 'India',
  country_code: 'in',
  language: 'en',
  search_engine: 'google',
  google_tld: '.co.in',
  max_keywords_per_domain: 50,
  max_domains: 5,
  max_position: 100,
  request_delay_ms: 2000,
  request_timeout_ms: 60000,
  max_retries: 2,
  history_days: 365
};

/**
 * Read JSON file.
 */
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');

    if (!content.trim()) {
      return fallback;
    }

    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path.relative(ROOT_DIR, filePath)}: ${error.message}`
    );
  }
}

/**
 * Write JSON file atomically.
 */
function writeJson(filePath, data) {
  const tempFile = `${filePath}.tmp`;

  fs.writeFileSync(
    tempFile,
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8'
  );

  fs.renameSync(tempFile, filePath);
}

/**
 * Merge settings with defaults.
 */
function loadSettings() {
  const raw = readJson(SETTINGS_FILE, {});

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config/settings.json must contain a JSON object.');
  }

  return {
    ...DEFAULT_SETTINGS,
    ...raw
  };
}

/**
 * Normalize a domain.
 *
 * Examples:
 * example.com
 * www.example.com
 * https://example.com/page
 *
 * all become:
 * example.com
 */
function normalizeDomain(input) {
  if (typeof input !== 'string') {
    return null;
  }

  let value = input.trim();

  if (!value) {
    return null;
  }

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);

    let hostname = url.hostname
      .toLowerCase()
      .trim()
      .replace(/\.$/, '');

    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Determine whether a SERP result belongs to the target domain.
 *
 * Prevents false positives such as:
 *
 * example.com.fake.com
 * fake-example.com
 */
function domainMatches(resultUrl, targetDomain) {
  if (!resultUrl || !targetDomain) {
    return false;
  }

  try {
    const parsed = new URL(resultUrl);

    let hostname = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '');

    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    return (
      hostname === targetDomain ||
      hostname.endsWith(`.${targetDomain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Validate configuration.
 */
function validateConfiguration(keywordsConfig, settings) {
  if (!ZENROWS_API_KEY) {
    throw new Error(
      'ZENROWS_API_KEY environment variable is missing.'
    );
  }

  if (
    !keywordsConfig ||
    typeof keywordsConfig !== 'object' ||
    Array.isArray(keywordsConfig)
  ) {
    throw new Error(
      'config/keywords.json must contain an object with a "domains" array.'
    );
  }

  if (!Array.isArray(keywordsConfig.domains)) {
    throw new Error(
      'config/keywords.json must contain a "domains" array.'
    );
  }

  if (
    keywordsConfig.domains.length < 1
  ) {
    throw new Error(
      'At least one domain must be configured.'
    );
  }

  if (
    keywordsConfig.domains.length >
    Number(settings.max_domains)
  ) {
    throw new Error(
      `Maximum allowed domains: ${settings.max_domains}. ` +
      `Found: ${keywordsConfig.domains.length}.`
    );
  }

  const seenDomains = new Set();

  for (const domainConfig of keywordsConfig.domains) {
    if (
      !domainConfig ||
      typeof domainConfig !== 'object' ||
      Array.isArray(domainConfig)
    ) {
      throw new Error(
        'Each domain entry must be an object.'
      );
    }

    const domain = normalizeDomain(domainConfig.domain);

    if (!domain) {
      throw new Error(
        `Invalid domain: ${domainConfig.domain}`
      );
    }

    if (seenDomains.has(domain)) {
      throw new Error(
        `Duplicate domain: ${domain}`
      );
    }

    seenDomains.add(domain);

    if (!Array.isArray(domainConfig.keywords)) {
      throw new Error(
        `Keywords for ${domain} must be an array.`
      );
    }

    if (
      domainConfig.keywords.length >
      Number(settings.max_keywords_per_domain)
    ) {
      throw new Error(
        `${domain} has ${domainConfig.keywords.length} keywords. ` +
        `Maximum allowed per domain: ${settings.max_keywords_per_domain}.`
      );
    }

    const seenKeywords = new Set();

    for (const keyword of domainConfig.keywords) {
      if (
        typeof keyword !== 'string' ||
        !keyword.trim()
      ) {
        throw new Error(
          `Invalid empty/non-string keyword for ${domain}.`
        );
      }

      const normalizedKeyword =
        keyword.trim().toLowerCase();

      if (seenKeywords.has(normalizedKeyword)) {
        throw new Error(
          `Duplicate keyword "${keyword}" for ${domain}.`
        );
      }

      seenKeywords.add(normalizedKeyword);
    }
  }
}

/**
 * Wait.
 */
function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Fetch JSON with timeout.
 */
async function fetchJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const apiMessage =
        data &&
        typeof data === 'object' &&
        (
          data.message ||
          data.error ||
          data.detail
        );

      throw new Error(
        `ZenRows HTTP ${response.status}` +
        (apiMessage ? `: ${apiMessage}` : '')
      );
    }

    if (!data || typeof data !== 'object') {
      throw new Error(
        'ZenRows returned an invalid JSON response.'
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create the current ZenRows Google Search API URL.
 *
 * Current ZenRows Google Search API:
 *
 * https://serp.api.zenrows.com/v1/targets/google/search/{query}
 *
 * Authentication is sent as the apikey query parameter.
 */
function buildZenRowsUrl(keyword, settings) {
  const encodedQuery =
    encodeURIComponent(keyword);

  const url = new URL(
    `https://serp.api.zenrows.com/v1/targets/google/search/${encodedQuery}`
  );

  url.searchParams.set(
    'apikey',
    ZENROWS_API_KEY
  );

  /*
   * Google India localization.
   *
   * ZenRows documents country and TLD parameters
   * for localized Google searches.
   */
  if (settings.country_code) {
    url.searchParams.set(
      'country',
      String(settings.country_code)
    );
  }

  if (settings.google_tld) {
    url.searchParams.set(
      'tld',
      String(settings.google_tld)
    );
  }

  /*
   * The underlying Google query is also explicitly
   * localized to India and English.
   *
   * These are included through the target URL parameter
   * when supported by the current API.
   */
  return url;
}

/**
 * Get Google organic results from ZenRows.
 */
async function fetchOrganicResults(
  keyword,
  settings
) {
  const url = buildZenRowsUrl(
    keyword,
    settings
  );

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= Number(settings.max_retries);
    attempt++
  ) {
    try {
      const data = await fetchJson(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json'
          }
        },
        Number(settings.request_timeout_ms)
      );

      if (
        !Array.isArray(data.organic_results)
      ) {
        throw new Error(
          'ZenRows response does not contain organic_results.'
        );
      }

      return data.organic_results;
    } catch (error) {
      lastError = error;

      if (
        attempt <
        Number(settings.max_retries)
      ) {
        /*
         * Small exponential backoff.
         */
        const backoff =
          Math.min(
            10000,
            1000 * Math.pow(2, attempt)
          );

        console.warn(
          `Request failed for "${keyword}". ` +
          `Retrying in ${backoff}ms...`
        );

        await sleep(backoff);
      }
    }
  }

  throw lastError || new Error(
    'SERP request failed.'
  );
}

/**
 * Find target domain in organic results.
 *
 * Organic result array position is treated as the
 * organic ranking position.
 */
function findRanking(
  organicResults,
  targetDomain,
  maxPosition
) {
  if (!Array.isArray(organicResults)) {
    return {
      position: null,
      url: null
    };
  }

  const results = organicResults
    .filter(result => {
      return (
        result &&
        typeof result === 'object' &&
        typeof result.link === 'string' &&
        result.link.trim()
      );
    })
    .slice(0, Number(maxPosition));

  for (
    let index = 0;
    index < results.length;
    index++
  ) {
    const result = results[index];

    if (
      domainMatches(
        result.link,
        targetDomain
      )
    ) {
      return {
        position: index + 1,
        url: result.link
      };
    }
  }

  return {
    position: null,
    url: null
  };
}

/**
 * Get previous ranking for a domain/keyword.
 */
function getPreviousRanking(
  rankings,
  domain,
  keyword
) {
  if (
    !rankings ||
    !rankings.domains ||
    !rankings.domains[domain] ||
    !Array.isArray(
      rankings.domains[domain].keywords
    )
  ) {
    return null;
  }

  const previous =
    rankings.domains[domain].keywords.find(
      item =>
        item &&
        typeof item.keyword === 'string' &&
        item.keyword.trim().toLowerCase() ===
          keyword.trim().toLowerCase()
    );

  if (!previous) {
    return null;
  }

  return previous.position ?? null;
}

/**
 * Calculate ranking change.
 *
 * Positive = improved.
 * Negative = declined.
 * Zero = unchanged.
 *
 * Example:
 * previous 8 -> current 5 = +3
 */
function calculateChange(
  previousPosition,
  currentPosition
) {
  if (
    !Number.isFinite(previousPosition) ||
    !Number.isFinite(currentPosition)
  ) {
    return null;
  }

  return (
    previousPosition -
    currentPosition
  );
}

/**
 * Create an empty rankings object.
 */
function createRankingsDocument(settings) {
  return {
    last_updated: null,
    country: settings.country,
    country_code: settings.country_code,
    language: settings.language,
    search_engine: settings.search_engine,
    max_position: Number(
      settings.max_position
    ),
    domains: {}
  };
}

/**
 * Create an empty history object.
 */
function createHistoryDocument() {
  return {
    last_updated: null,
    history: {}
  };
}

/**
 * Load existing rankings safely.
 */
function loadRankings(settings) {
  const existing = readJson(
    RANKINGS_FILE,
    null
  );

  if (
    !existing ||
    typeof existing !== 'object' ||
    Array.isArray(existing)
  ) {
    return createRankingsDocument(settings);
  }

  if (
    !existing.domains ||
    typeof existing.domains !== 'object' ||
    Array.isArray(existing.domains)
  ) {
    existing.domains = {};
  }

  return existing;
}

/**
 * Load existing history safely.
 */
function loadHistory() {
  const existing = readJson(
    HISTORY_FILE,
    null
  );

  if (
    !existing ||
    typeof existing !== 'object' ||
    Array.isArray(existing)
  ) {
    return createHistoryDocument();
  }

  if (
    !existing.history ||
    typeof existing.history !== 'object' ||
    Array.isArray(existing.history)
  ) {
    existing.history = {};
  }

  return existing;
}

/**
 * Ensure a domain exists in the rankings document.
 */
function ensureDomainRanking(
  rankings,
  domain
) {
  if (
    !rankings.domains[domain] ||
    typeof rankings.domains[domain] !== 'object'
  ) {
    rankings.domains[domain] = {
      domain,
      keywords: []
    };
  }

  if (
    !Array.isArray(
      rankings.domains[domain].keywords
    )
  ) {
    rankings.domains[domain].keywords = [];
  }
}

/**
 * Ensure a domain exists in history.
 */
function ensureDomainHistory(
  history,
  domain
) {
  if (
    !history.history[domain] ||
    typeof history.history[domain] !== 'object'
  ) {
    history.history[domain] = {};
  }
}

/**
 * Update one keyword's historical data.
 */
function updateHistory(
  history,
  domain,
  keyword,
  position,
  date,
  maxDays
) {
  ensureDomainHistory(
    history,
    domain
  );

  if (
    !Array.isArray(
      history.history[domain][keyword]
    )
  ) {
    history.history[domain][keyword] = [];
  }

  const entries =
    history.history[domain][keyword];

  const existingIndex =
    entries.findIndex(
      item =>
        item &&
        item.date === date
    );

  const newEntry = {
    date,
    position:
      Number.isFinite(position)
        ? position
        : null
  };

  if (existingIndex >= 0) {
    entries[existingIndex] =
      newEntry;
  } else {
    entries.push(newEntry);
  }

  entries.sort(
    (a, b) =>
      String(a.date).localeCompare(
        String(b.date)
      )
  );

  /*
   * Keep only the most recent N days.
   */
  if (
    entries.length >
    Number(maxDays)
  ) {
    history.history[domain][keyword] =
      entries.slice(
        -Number(maxDays)
      );
  }
}

/**
 * Run a single keyword.
 */
async function checkKeyword({
  domain,
  keyword,
  previousPosition,
  settings
}) {
  try {
    const organicResults =
      await fetchOrganicResults(
        keyword,
        settings
      );

    const ranking =
      findRanking(
        organicResults,
        domain,
        settings.max_position
      );

    const change =
      calculateChange(
        previousPosition,
        ranking.position
      );

    return {
      keyword,
      position:
        ranking.position,
      previous_position:
        previousPosition,
      change,
      url:
        ranking.url,
      error: null
    };
  } catch (error) {
    return {
      keyword,
      position: null,
      previous_position:
        previousPosition,
      change: null,
      url: null,
      error:
        error instanceof Error
          ? error.message
          : 'SERP request failed'
    };
  }
}

/**
 * Main application.
 */
async function main() {
  console.log(
    '=========================================='
  );

  console.log(
    'India Google Rank Checker'
  );

  console.log(
    '=========================================='
  );

  const settings =
    loadSettings();

  const keywordsConfig =
    readJson(
      KEYWORDS_FILE,
      null
    );

  validateConfiguration(
    keywordsConfig,
    settings
  );

  const previousRankings =
    loadRankings(settings);

  const history =
    loadHistory();

  const rankings =
    createRankingsDocument(
      settings
    );

  /*
   * Preserve metadata.
   */
  rankings.last_updated =
    new Date().toISOString();

  history.last_updated =
    rankings.last_updated;

  const checkedAt =
    rankings.last_updated;

  const today =
    checkedAt.slice(0, 10);

  let totalKeywords = 0;
  let successfulKeywords = 0;
  let failedKeywords = 0;

  for (
    const domainConfig
    of keywordsConfig.domains
  ) {
    const domain =
      normalizeDomain(
        domainConfig.domain
      );

    console.log(
      `\nDomain: ${domain}`
    );

    ensureDomainRanking(
      rankings,
      domain
    );

    ensureDomainHistory(
      history,
      domain
    );

    for (
      let index = 0;
      index <
      domainConfig.keywords.length;
      index++
    ) {
      const keyword =
        domainConfig.keywords[index]
          .trim();

      totalKeywords++;

      console.log(
        `[${index + 1}/${domainConfig.keywords.length}] ` +
        `${keyword}`
      );

      const previousPosition =
        getPreviousRanking(
          previousRankings,
          domain,
          keyword
        );

      const result =
        await checkKeyword({
          domain,
          keyword,
          previousPosition,
          settings
        });

      const rankingRecord = {
        keyword:
          result.keyword,

        position:
          result.position,

        previous_position:
          result.previous_position,

        change:
          result.change,

        url:
          result.url,

        checked_at:
          checkedAt
      };

      if (result.error) {
        rankingRecord.error =
          result.error;

        failedKeywords++;

        console.error(
          `  ERROR: ${result.error}`
        );
      } else {
        successfulKeywords++;

        if (
          result.position === null
        ) {
          console.log(
            '  Not ranking in top ' +
            `${settings.max_position}`
          );
        } else {
          console.log(
            `  Position: ${result.position}` +
            ` | Previous: ` +
            `${result.previous_position ?? 'N/A'}` +
            ` | Change: ` +
            `${result.change ?? 'N/A'}`
          );
        }
      }

      rankings.domains[
        domain
      ].keywords.push(
        rankingRecord
      );

      updateHistory(
        history,
        domain,
        keyword,
        result.position,
        today,
        settings.history_days
      );

      /*
       * Do not delay after the final request.
       */
      const isLastKeyword =
        index ===
        domainConfig.keywords.length - 1;

      const isLastDomain =
        domainConfig ===
        keywordsConfig.domains[
          keywordsConfig.domains.length - 1
        ];

      if (
        !isLastKeyword ||
        !isLastDomain
      ) {
        const delay =
          Math.max(
            0,
            Number(
              settings.request_delay_ms
            )
          );

        if (delay > 0) {
          await sleep(delay);
        }
      }
    }
  }

  /*
   * Remove domains that no longer exist
   * from current rankings.
   *
   * This prevents stale domains from being
   * displayed by the frontend.
   */
  const configuredDomains =
    new Set(
      keywordsConfig.domains.map(
        item =>
          normalizeDomain(
            item.domain
          )
      )
    );

  for (
    const existingDomain
    of Object.keys(
      rankings.domains
    )
  ) {
    if (
      !configuredDomains.has(
        existingDomain
      )
    ) {
      delete rankings.domains[
        existingDomain
      ];
    }
  }

  /*
   * Ensure all history arrays remain
   * within the configured limit.
   */
  for (
    const domain of Object.keys(
      history.history
    )
  ) {
    const keywords =
      history.history[domain];

    if (
      !keywords ||
      typeof keywords !== 'object'
    ) {
      continue;
    }

    for (
      const keyword of Object.keys(
        keywords
      )
    ) {
      if (
        !Array.isArray(
          keywords[keyword]
        )
      ) {
        delete keywords[keyword];
        continue;
      }

      keywords[keyword] =
        keywords[keyword]
          .sort(
            (a, b) =>
              String(a.date)
                .localeCompare(
                  String(b.date)
                )
          )
          .slice(
            -Number(
              settings.history_days
            )
          );
    }
  }

  writeJson(
    RANKINGS_FILE,
    rankings
  );

  writeJson(
    HISTORY_FILE,
    history
  );

  console.log(
    '\n=========================================='
  );

  console.log(
    'Ranking check completed'
  );

  console.log(
    '=========================================='
  );

  console.log(
    `Domains: ${keywordsConfig.domains.length}`
  );

  console.log(
    `Keywords checked: ${totalKeywords}`
  );

  console.log(
    `Successful: ${successfulKeywords}`
  );

  console.log(
    `Failed: ${failedKeywords}`
  );

  console.log(
    `Updated: ${checkedAt}`
  );

  console.log(
    '=========================================='
  );

  /*
   * Do not fail the entire GitHub Action just
   * because individual keywords failed.
   *
   * Configuration/API-key failures are still
   * thrown before this point.
   */
}

main().catch(error => {
  console.error(
    '\nFATAL ERROR:'
  );

  console.error(
    error instanceof Error
      ? error.message
      : error
  );

  process.exit(1);
});
