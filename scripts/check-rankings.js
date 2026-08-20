import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

const KEYWORDS_FILE = path.join(
  ROOT,
  "config",
  "keywords.json"
);

const SETTINGS_FILE = path.join(
  ROOT,
  "config",
  "settings.json"
);

const RANKINGS_FILE = path.join(
  ROOT,
  "data",
  "rankings.json"
);

const HISTORY_FILE = path.join(
  ROOT,
  "data",
  "history.json"
);

const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY;

if (!ZENROWS_API_KEY) {
  console.error(
    "ERROR: ZENROWS_API_KEY GitHub secret is missing."
  );

  process.exit(1);
}


async function readJson(file) {
  const content = await fs.readFile(
    file,
    "utf8"
  );

  return JSON.parse(content);
}


async function writeJson(file, data) {
  await fs.writeFile(
    file,
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}


function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


function normalizeDomain(value) {

  let domain = String(value || "")
    .trim()
    .toLowerCase();

  if (!domain) {
    throw new Error("Target domain is empty.");
  }

  if (!domain.startsWith("http://") &&
      !domain.startsWith("https://")) {
    domain = "https://" + domain;
  }

  const parsed = new URL(domain);

  let hostname = parsed.hostname
    .toLowerCase()
    .replace(/^www\./, "");

  if (!hostname) {
    throw new Error("Invalid target domain.");
  }

  return hostname;
}


function normalizeResultUrl(value) {

  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);

    return parsed.hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}


function domainMatches(resultUrl, targetDomain) {

  const resultDomain = normalizeResultUrl(
    resultUrl
  );

  if (!resultDomain) {
    return false;
  }

  return (
    resultDomain === targetDomain ||
    resultDomain.endsWith("." + targetDomain)
  );
}


async function fetchWithTimeout(
  url,
  options,
  timeoutMs
) {

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {

    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

  } finally {

    clearTimeout(timeout);
  }
}


async function getGoogleResults(
  keyword,
  settings
) {

  const encodedQuery =
    encodeURIComponent(keyword);

  /*
   * ZenRows' current Google Search documentation
   * provides this structured endpoint.
   */

  const endpoint =
    `https://serp.api.zenrows.com/v1/targets/google/search/${encodedQuery}`;

  const params = new URLSearchParams();

  params.set(
    "apikey",
    ZENROWS_API_KEY
  );

  /*
   * India localization.
   *
   * ZenRows documents country and TLD
   * customization for localized Google results.
   */

  params.set(
    "country",
    settings.country_code || "in"
  );

  params.set(
    "tld",
    settings.google_tld || ".co.in"
  );

  const requestUrl =
    `${endpoint}?${params.toString()}`;


  let lastError = null;

  const maxRetries =
    Number(settings.max_retries) || 2;


  for (
    let attempt = 0;
    attempt <= maxRetries;
    attempt++
  ) {

    try {

      const response =
        await fetchWithTimeout(
          requestUrl,
          {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          },
          Number(settings.request_timeout_ms) || 60000
        );


      const text =
        await response.text();


      if (!response.ok) {

        throw new Error(
          `ZenRows HTTP ${response.status}: ${text.slice(0, 300)}`
        );
      }


      let data;

      try {

        data = JSON.parse(text);

      } catch {

        throw new Error(
          "ZenRows returned invalid JSON."
        );
      }


      if (
        !data ||
        !Array.isArray(data.organic_results)
      ) {

        throw new Error(
          "ZenRows response does not contain organic_results."
        );
      }


      return data;

    } catch (error) {

      lastError = error;

      console.error(
        `Request failed for "${keyword}" ` +
        `(attempt ${attempt + 1}/${maxRetries + 1}): ` +
        error.message
      );

      if (attempt < maxRetries) {

        await sleep(
          3000 * (attempt + 1)
        );
      }
    }
  }


  throw lastError ||
    new Error("ZenRows request failed.");
}


function findRanking(
  data,
  targetDomain,
  maxPosition
) {

  const organicResults =
    Array.isArray(data.organic_results)
      ? data.organic_results
      : [];


  const results =
    organicResults.slice(
      0,
      maxPosition
    );


  for (
    let index = 0;
    index < results.length;
    index++
  ) {

    const result =
      results[index];

    const link =
      result?.link ||
      result?.url ||
      null;


    if (
      link &&
      domainMatches(
        link,
        targetDomain
      )
    ) {

      return {
        position: index + 1,
        url: link,
        title: result?.title || "",
        snippet: result?.snippet || ""
      };
    }
  }


  return {
    position: null,
    url: null,
    title: null,
    snippet: null
  };
}


function calculateChange(
  current,
  previous
) {

  if (
    current == null ||
    previous == null
  ) {
    return null;
  }

  return previous - current;
}


function cleanKeywords(
  keywords,
  maxKeywords
) {

  if (!Array.isArray(keywords)) {

    throw new Error(
      "config/keywords.json must contain an array."
    );
  }


  if (keywords.length > maxKeywords) {

    throw new Error(
      `Maximum ${maxKeywords} keywords allowed. ` +
      `Found ${keywords.length}.`
    );
  }


  const cleaned = [];

  const seen = new Set();


  for (const keyword of keywords) {

    if (
      typeof keyword !== "string"
    ) {
      continue;
    }


    const value =
      keyword.trim();


    if (!value) {
      continue;
    }


    const key =
      value.toLowerCase();


    if (seen.has(key)) {
      continue;
    }


    seen.add(key);

    cleaned.push(value);
  }


  return cleaned;
}


function getPreviousResult(
  previousRankings,
  keyword
) {

  const result =
    previousRankings.find(
      item =>
        String(item.keyword)
          .toLowerCase() ===
        keyword.toLowerCase()
    );

  return result || null;
}


function updateHistory(
  history,
  results,
  date,
  historyDays
) {

  if (
    !history ||
    typeof history !== "object"
  ) {
    history = {};
  }


  if (
    !history.history ||
    typeof history.history !== "object"
  ) {
    history.history = {};
  }


  for (const result of results) {

    const keyword =
      result.keyword;


    if (
      !history.history[keyword]
    ) {

      history.history[keyword] = [];
    }


    history.history[keyword].push({
      date,
      position:
        result.position
    });


    /*
     * Remove duplicate date entries.
     */

    const unique =
      new Map();


    for (
      const entry of
      history.history[keyword]
    ) {

      unique.set(
        entry.date,
        entry
      );
    }


    history.history[keyword] =
      Array.from(
        unique.values()
      )
        .sort(
          (a, b) =>
            a.date.localeCompare(
              b.date
            )
        )
        .slice(-historyDays);
  }


  return history;
}


async function main() {

  console.log(
    "Starting India keyword rank checker..."
  );


  const [
    keywordsConfig,
    settings,
    previousRankings,
    history
  ] = await Promise.all([
    readJson(KEYWORDS_FILE),
    readJson(SETTINGS_FILE),
    readJson(RANKINGS_FILE),
    readJson(HISTORY_FILE)
  ]);


  const targetDomain =
    normalizeDomain(
      settings.domain
    );


  const maxKeywords =
    Number(settings.max_keywords) || 50;


  const maxPosition =
    Number(settings.max_position) || 100;


  const keywords =
    cleanKeywords(
      keywordsConfig,
      maxKeywords
    );


  if (!keywords.length) {

    throw new Error(
      "No keywords found in config/keywords.json."
    );
  }


  console.log(
    `Target domain: ${targetDomain}`
  );

  console.log(
    `Keywords: ${keywords.length}`
  );

  console.log(
    `Country: ${settings.country || "India"}`
  );


  const now =
    new Date();


  const isoNow =
    now.toISOString();


  const date =
    isoNow.slice(0, 10);


  const previousResults =
    Array.isArray(
      previousRankings?.keywords
    )
      ? previousRankings.keywords
      : [];


  const results = [];


  for (
    let i = 0;
    i < keywords.length;
    i++
  ) {

    const keyword =
      keywords[i];


    console.log(
      `\n[${i + 1}/${keywords.length}] ${keyword}`
    );


    const previous =
      getPreviousResult(
        previousResults,
        keyword
      );


    try {

      const serp =
        await getGoogleResults(
          keyword,
          settings
        );


      const ranking =
        findRanking(
          serp,
          targetDomain,
          maxPosition
        );


      const currentPosition =
        ranking.position;


      const previousPosition =
        previous?.position ??
        null;


      const change =
        calculateChange(
          currentPosition,
          previousPosition
        );


      const result = {
        keyword,
        position: currentPosition,
        previous_position:
          previousPosition,
        change,
        url: ranking.url,
        title: ranking.title,
        checked_at: isoNow
      };


      results.push(result);


      if (currentPosition) {

        console.log(
          `Position: ${currentPosition}`
        );

      } else {

        console.log(
          `Position: Not ranking`
        );
      }


      if (change !== null) {

        console.log(
          `Change: ${
            change > 0
              ? "+" + change
              : change
          }`
        );
      }


    } catch (error) {

      console.error(
        `Failed: ${error.message}`
      );


      results.push({
        keyword,
        position: null,
        previous_position:
          previous?.position ??
          null,
        change: null,
        url: null,
        title: null,
        error: error.message,
        checked_at: isoNow
      });
    }


    /*
     * Do not delay after the final request.
     */

    if (
      i < keywords.length - 1
    ) {

      await sleep(
        Number(
          settings.request_delay_ms
        ) || 2000
      );
    }
  }


  const rankingsOutput = {
    last_updated: isoNow,
    domain: targetDomain,
    country:
      settings.country || "India",
    country_code:
      settings.country_code || "in",
    language:
      settings.language || "en",
    max_position: maxPosition,
    keywords: results
  };


  const updatedHistory =
    updateHistory(
      history,
      results,
      date,
      Number(settings.history_days) || 365
    );


  updatedHistory.last_updated =
    isoNow;

  updatedHistory.domain =
    targetDomain;


  await writeJson(
    RANKINGS_FILE,
    rankingsOutput
  );


  await writeJson(
    HISTORY_FILE,
    updatedHistory
  );


  const ranked =
    results.filter(
      item =>
        Number.isInteger(
          item.position
        )
    );


  const failed =
    results.filter(
      item =>
        item.error
    );


  console.log("\n------------------------------");

  console.log("Rank check completed.");

  console.log(
    `Keywords checked: ${results.length}`
  );

  console.log(
    `Ranking: ${ranked.length}`
  );

  console.log(
    `Not ranking: ${
      results.length -
      ranked.length -
      failed.length
    }`
  );

  console.log(
    `Errors: ${failed.length}`
  );

  console.log("------------------------------");
}


main().catch(error => {

  console.error(
    "\nFATAL ERROR:"
  );

  console.error(
    error.message
  );

  process.exit(1);
});
