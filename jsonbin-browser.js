/**
 * jsonbin-browser.js
 *
 * A jsonbin.io v3 API wrapper that runs entirely in the browser — no
 * Node.js, no build step, no npm install. Just include this file with
 * a plain <script> tag and use the global `JSONBinClient`.
 *
 * Designed for the common case of ONE shared bin that multiple people /
 * tabs / devices all read and write. client.update() makes that safe
 * without hammering jsonbin.io's rate limits (see below).
 *
 * Docs: https://jsonbin.io/api-reference
 */

(function (global) {
  const REV_KEY = "__rev"; // internal bookkeeping field, managed by update()

  class JSONBinError extends Error {
    constructor(statusCode, message, responseBody = null) {
      super(`[${statusCode}] ${message}`);
      this.name = "JSONBinError";
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }
  }

  /**
   * Thrown by client.update() if two writers changed the bin at the same
   * time and retries were exhausted trying to reconcile it.
   *
   * IMPORTANT CAVEAT: jsonbin.io has no server-side atomic compare-and-swap
   * (no ETag / If-Match support), so this can't be a true lock. Instead,
   * update() stores a small hidden revision number inside the bin's own
   * JSON data (a "__rev" field you'll never need to touch yourself). It
   * reads the bin, remembers the revision, writes back revision+1, then
   * re-reads to confirm nobody else's write landed in between. If someone
   * else's write DID land in between, this error is thrown internally and
   * update() automatically retries with fresh data — you only see
   * JSONBinConflictError if it still couldn't win after maxRetries tries.
   */
  class JSONBinConflictError extends Error {
    constructor(binId, expectedRev, actualRev) {
      super(
        `Conflict on bin ${binId}: expected revision ${expectedRev}, found ${actualRev}. ` +
          `Someone else updated this bin first, and retries were exhausted.`
      );
      this.name = "JSONBinConflictError";
      this.binId = binId;
      this.expectedRev = expectedRev;
      this.actualRev = actualRev;
    }
  }

  class JSONBinClient {
    static BASE_URL = "https://api.jsonbin.io/v3";

    /**
     * @param {Object} options
     * @param {string} options.apiKey - Your X-Master-Key from jsonbin.io/api-keys
     * @param {string} [options.accessKey] - Optional X-Access-Key (for bins with access rules)
     * @param {string} [options.baseUrl] - Override the API base URL
     * @param {number} [options.timeout] - Request timeout in ms (default 15000)
     */
    constructor({ apiKey, accessKey = null, baseUrl = null, timeout = 15000 } = {}) {
      if (!apiKey) {
        throw new Error("apiKey is required");
      }
      this.apiKey = apiKey;
      this.accessKey = accessKey;
      this.baseUrl = (baseUrl || JSONBinClient.BASE_URL).replace(/\/$/, "");
      this.timeout = timeout;
    }

    _headers(extra = {}) {
      const headers = {
        "Content-Type": "application/json",
        "X-Master-Key": this.apiKey,
        ...extra,
      };
      if (this.accessKey) {
        headers["X-Access-Key"] = this.accessKey;
      }
      return headers;
    }

    async _request(method, path, { body = undefined, headers = {} } = {}) {
      const url = `${this.baseUrl}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      let response;
      try {
        response = await fetch(url, {
          method,
          headers: this._headers(headers),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // NOTE: if jsonbin.io rate-limits you (429), it sometimes omits
        // CORS headers on that specific response. Browsers then refuse to
        // expose ANY details about the response (not even the 429 status)
        // and fetch() just throws a generic "NetworkError" / "Failed to
        // fetch". If you see that, and your dev console separately shows
        // a 429 or "CORS Missing Allow Origin" for the same request,
        // you've been rate-limited — slow down / space out your requests.
        throw new JSONBinError(0, `Network error: ${err.message}`);
      }
      clearTimeout(timer);

      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        const message =
          parsed && typeof parsed === "object" && parsed.message ? parsed.message : text;
        throw new JSONBinError(response.status, message, parsed);
      }

      return parsed;
    }

    static _binHeaders({ name, isPrivate, collectionId } = {}) {
      const headers = {};
      if (name !== undefined) headers["X-Bin-Name"] = name;
      if (isPrivate !== undefined) headers["X-Bin-Private"] = isPrivate ? "true" : "false";
      if (collectionId !== undefined) headers["X-Collection-Id"] = collectionId;
      return headers;
    }

    // ---- Basic bin operations -------------------------------------------

    /** Create a new bin. Returns the parsed JSON response (record + metadata). */
    async createBin(data, { name, isPrivate = false, collectionId } = {}) {
      const headers = JSONBinClient._binHeaders({ name, isPrivate, collectionId });
      return this._request("POST", "/b", { body: data, headers });
    }

    /**
     * Read a bin's contents.
     * @param {string} binId
     * @param {Object} [options]
     * @param {number} [options.version] - Read a specific version instead of latest.
     * @param {boolean} [options.meta=true] - If false, omit metadata (record only).
     */
    async readBin(binId, { version, meta = true } = {}) {
      let path = `/b/${binId}`;
      if (version !== undefined) path += `/${version}`;
      const headers = meta ? {} : { "X-Bin-Meta": "false" };
      return this._request("GET", path, { headers });
    }

    /**
     * Overwrite a bin's contents outright. Prefer update() if others might
     * write concurrently. versioning defaults to false here since update()
     * tracks its own revision inside the data and doesn't need jsonbin.io's
     * built-in version history (which also costs extra API quota to check).
     */
    async updateBin(binId, data, { versioning = false } = {}) {
      const headers = versioning ? {} : { "X-Bin-Versioning": "false" };
      return this._request("PUT", `/b/${binId}`, { body: data, headers });
    }

    /** Delete a bin (all versions). */
    async deleteBin(binId) {
      return this._request("DELETE", `/b/${binId}`);
    }

    // ---- Safe concurrent updates for ONE shared bin -----------------------

    /**
     * THE function to call whenever multiple people/tabs/devices update the
     * SAME bin. Prevents the classic "lost update" bug: two writers read
     * the same data, both compute a change, and whoever writes second
     * silently overwrites the first writer's change.
     *
     * `updateFn` receives the CURRENT record (with the internal "__rev"
     * field stripped out — you never see or manage it) and returns the NEW
     * record to write. Keep it pure / side-effect-free, since it may run
     * more than once if there's contention:
     *
     *   await client.update(binId, (current) => {
     *     current.count += 1;
     *     return current;
     *   });
     *
     * Only 3 API calls per attempt (read, write, verify) — deliberately
     * kept minimal since jsonbin.io's free tier rate-limits fairly
     * aggressively:
     *   1. Read the bin, note its "__rev" (defaults to 0 if absent).
     *   2. Run updateFn, write back the result with __rev incremented by 1
     *      (X-Bin-Versioning: false — we don't need jsonbin's own history).
     *   3. Re-read once to confirm __rev is now exactly what we expected.
     *      If it's higher, someone else's write got in first: throw this
     *      attempt away, back off with jittered exponential delay, and
     *      retry from step 1 with fresh data.
     *   4. Give up after maxRetries and throw JSONBinConflictError.
     *
     * @param {string} binId
     * @param {(current: any) => any | Promise<any>} updateFn
     * @param {Object} [options]
     * @param {number} [options.maxRetries=5]
     * @param {number} [options.baseDelayMs=400] - Base delay for exponential backoff.
     * @param {number} [options.maxDelayMs=4000] - Cap on backoff delay.
     * @returns {Promise<any>} the new record (without the internal __rev field).
     */
    async update(binId, updateFn, { maxRetries = 5, baseDelayMs = 400, maxDelayMs = 4000 } = {}) {
      let lastConflict = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
          const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          const jitter = Math.random() * exponential * 0.5;
          await new Promise((resolve) => setTimeout(resolve, exponential + jitter));
        }

        // 1. Read + note revision
        const current = await this.readBin(binId);
        const currentRecord = current.record || {};
        const baseRev = typeof currentRecord[REV_KEY] === "number" ? currentRecord[REV_KEY] : 0;
        const { [REV_KEY]: _omit, ...userVisible } = currentRecord;

        // 2. Compute + write with incremented revision
        const updatedUserData = await updateFn(userVisible);
        const newRecord = { ...updatedUserData, [REV_KEY]: baseRev + 1 };
        await this.updateBin(binId, newRecord, { versioning: false });

        // 3. Verify nobody raced us
        const verify = await this.readBin(binId);
        const actualRev = verify.record?.[REV_KEY];
        if (actualRev !== baseRev + 1) {
          lastConflict = new JSONBinConflictError(binId, baseRev + 1, actualRev);
          continue;
        }

        const { [REV_KEY]: _omit2, ...cleanResult } = verify.record;
        return cleanResult;
      }

      throw lastConflict || new JSONBinConflictError(binId, -1, -1);
    }
  }

  global.JSONBinClient = JSONBinClient;
  global.JSONBinError = JSONBinError;
  global.JSONBinConflictError = JSONBinConflictError;
})(window);