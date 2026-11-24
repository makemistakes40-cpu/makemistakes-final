#!/usr/bin/env node
/**
 * devDatabaseUrl.mjs — Pure, side-effect-free classification of development
 * DATABASE_URL values. Shared by scripts/setup_dev_env.mjs and
 * scripts/verify_dev_environment.mjs so the Atlas/loopback safety rules can
 * never drift apart.
 *
 * Rules (must stay identical between both scripts):
 *   - loopback hosts (localhost/127.0.0.1/::1) are accepted by default;
 *   - MongoDB Atlas SRV URLs are accepted only with --allow-cloud-dev AND the
 *     database name exactly 'makemistakes_dev';
 *   - production database names are always rejected;
 *   - non-Atlas cloud URLs are always rejected;
 *   - only mongodb:// and mongodb+srv:// protocols are considered.
 *
 * No credentials, usernames, passwords or connection strings are ever returned
 * or printed. Only the hostname and database name are exposed.
 */

/** The only database name allowed for a development target. */
export const DEV_DATABASE_NAME = "makemistakes_dev";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
const ALLOWED_PROTOCOLS = new Set(["mongodb:", "mongodb+srv:"]);
const ATLAS_HOST_SUFFIX = /mongodb\.net$/i;

/**
 * Classify a DATABASE_URL value.
 *
 * @param {string} url
 * @param {{allowCloud?: boolean}} [opts]
 * @returns {{
 *   devMode: boolean,
 *   host: string,
 *   dbName: string,
 *   cloud: boolean,
 *   localHost: boolean,
 *   protocol: string,
 *   reason: string
 * }}
 */
export function classifyDevDatabaseUrl(url, { allowCloud = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return {
      devMode: false,
      host: "",
      dbName: "",
      cloud: false,
      localHost: false,
      protocol: "",
      reason: "invalid-url",
    };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const dbName = (u.pathname || "").replace(/^\//, "").split(/[?&#]/)[0];
  const localHost = LOOPBACK_HOSTS.includes(host);
  const cloud = u.protocol === "mongodb+srv:" && ATLAS_HOST_SUFFIX.test(host);

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return {
      devMode: false,
      host,
      dbName,
      cloud: false,
      localHost,
      protocol: u.protocol,
      reason: "invalid-protocol",
    };
  }

  if (localHost) {
    const devMode = dbName === DEV_DATABASE_NAME;
    return {
      devMode,
      host,
      dbName,
      cloud: false,
      localHost: true,
      protocol: u.protocol,
      reason: devMode ? "local-host" : "local-host+non-dev-name",
    };
  }

  if (cloud) {
    const devMode = allowCloud && dbName === DEV_DATABASE_NAME;
    return {
      devMode,
      host,
      dbName,
      cloud: true,
      localHost: false,
      protocol: u.protocol,
      reason:
        "atlas-srv" +
        (dbName === DEV_DATABASE_NAME ? "+makemistakes_dev" : "+non-dev-name") +
        (allowCloud ? "+allow-cloud-dev" : "+flag-missing"),
    };
  }

  return {
    devMode: false,
    host,
    dbName,
    cloud: false,
    localHost: false,
    protocol: u.protocol,
    reason: "unknown/non-dev",
  };
}

/**
 * Convenience wrapper for scripts that want a thrown Error on a disallowed URL
 * (like setup_dev_env.mjs). Mirrors that script's original error messages.
 *
 * @param {string} url
 * @param {{allowCloud?: boolean}} [opts]
 * @returns {{host: string, database: string}}
 * @throws {Error} if the URL is not a valid development target.
 */
export function assertDevDatabaseUrlAllowed(url, { allowCloud = false } = {}) {
  const info = classifyDevDatabaseUrl(url, { allowCloud });

  if (info.reason === "invalid-url") {
    throw new Error("Development DATABASE_URL must be a valid MongoDB URI.");
  }
  if (info.reason === "invalid-protocol") {
    throw new Error("Development DATABASE_URL must use mongodb:// or mongodb+srv://.");
  }
  if (!info.localHost && !(allowCloud && info.cloud)) {
    throw new Error(
      info.localHost
        ? "Only the local MongoDB database 'makemistakes_dev' is allowed for loopback setup."
        : "Atlas development URLs require the --allow-cloud-dev flag and a mongodb+.net SRV hostname."
    );
  }
  if (info.dbName !== DEV_DATABASE_NAME) {
    throw new Error("Only the development database 'makemistakes_dev' is allowed.");
  }
  return { host: info.host, database: info.dbName };
}
