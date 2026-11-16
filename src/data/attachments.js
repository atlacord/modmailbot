const Eris = require("eris");
const fs = require("fs");
const https = require("https");
const {promisify} = require("util");
const tmp = require("tmp");
const config = require("../cfg");
const utils = require("../utils/utils");
const mv = promisify(require("mv"));
const path = require("path");

const getUtils = () => require("../utils/utils");

const access = promisify(fs.access);
const readFile = promisify(fs.readFile);

const localAttachmentDir = config.attachmentDir || `${__dirname}/../../attachments`;

const attachmentSavePromises = {};

const attachmentStorageTypes = {};

function getErrorResult(msg = null) {
  return {
    url: `Attachment could not be saved${msg ? ": " + msg : ""}`,
    failed: true
  };
}

/**
 * @callback AddAttachmentStorageTypeFn
 * @param {string} name
 * @param {AttachmentStorageTypeHandler} handler
 */

/**
 * @callback AttachmentStorageTypeHandler
 * @param {Eris.Attachment} attachment
 * @return {AttachmentStorageTypeResult|Promise<AttachmentStorageTypeResult>}
 */

/**
 * @typedef {object} AttachmentStorageTypeResult
 * @property {string} url
 */

/**
 * @callback DownloadAttachmentFn
 * @param {Eris.Attachment} attachment
 * @param {number?} tries Used internally, don't pass
 * @return {Promise<DownloadAttachmentResult>}
  */

/**
 * @typedef {object} DownloadAttachmentResult
 * @property {string} path
 * @property {DownloadAttachmentCleanupFn} cleanup
 */

/**
 * @callback DownloadAttachmentCleanupFn
 * @return {void}
 */

/**
 * Saves the given attachment based on the configured storage system
 * @callback SaveAttachmentFn
 * @param {Eris.Attachment} attachment
 * @returns {Promise<{ url: string }>}
 */

/**
 * @type {AttachmentStorageTypeHandler}
 */
let passthroughOriginalAttachment; // Workaround to inconsistent IDE bug with @type and anonymous functions
passthroughOriginalAttachment = (attachment) => {
  return { url: attachment.url };
};

/**
 * An attachment storage option that downloads each attachment and serves them from a local web server
 * @type {AttachmentStorageTypeHandler}
 */
let saveLocalAttachment; // Workaround to inconsistent IDE bug with @type and anonymous functions
saveLocalAttachment = async (attachment) => {
  const targetPath = getLocalAttachmentPath(attachment.id);

  try {
    // If the file already exists, resolve immediately
    await access(targetPath);
    const url = await getLocalAttachmentUrl(attachment.id, attachment.filename);
    return { url };
  } catch (e) {}

  // Download the attachment
  const downloadResult = await downloadAttachment(attachment);

  // Move the temp file to the attachment folder
  await mv(downloadResult.path, targetPath);

  // Resolve the attachment URL
  const url = await getLocalAttachmentUrl(attachment.id, attachment.filename);

  return { url };
};

/**
 * @type {DownloadAttachmentFn}
 */
const downloadAttachment = (attachment, tries = 0) => {
  return new Promise((resolve, reject) => {
    if (tries > 3) {
      console.error("Attachment download failed after 3 tries:", attachment);
      reject("Attachment download failed after 3 tries");
      return;
    }

    tmp.file((err, filepath, fd, cleanupCallback) => {
      if (err) {
        reject(err);
        return;
      }

      const writeStream = fs.createWriteStream(filepath);

      https.get(attachment.url, (res) => {
        res.pipe(writeStream);
        writeStream.on("finish", () => {
          writeStream.end();
          resolve({
            path: filepath,
            cleanup: cleanupCallback
          });
        });
      }).on("error", () => {
        fs.unlink(filepath);
        console.error("Error downloading attachment, retrying");
        resolve(downloadAttachment(attachment, tries++));
      });
    });
  });
};

/**
 * Returns the filesystem path for the given attachment id
 * @param {String} attachmentId
 * @returns {String}
 */
function getLocalAttachmentPath(attachmentId) {
  return `${localAttachmentDir}/${attachmentId}`;
}

/**
 * Returns the self-hosted URL to the given attachment ID
 * @param {String} attachmentId
 * @param {String=null} desiredName Custom name for the attachment as a hint for the browser
 * @returns {Promise<String>}
 */
function getLocalAttachmentUrl(attachmentId, desiredName = null) {
  if (desiredName == null) desiredName = "file.bin";
  return getUtils().getSelfUrl(`attachments/${attachmentId}/${desiredName}`);
}

/**
 * An attachment storage option that downloads each attachment and re-posts them to a specified Discord channel.
 * The re-posted attachment is then linked in the actual thread.
 * @type {AttachmentStorageTypeHandler}
 */
let saveDiscordAttachment; // Workaround to inconsistent IDE bug with @type and anonymous functions
saveDiscordAttachment = async (attachment) => {
  if (attachment.size > 1024 * 1024 * 8) {
    return getErrorResult("attachment too large (max 8MB)");
  }

  const attachmentChannelId = config.attachmentStorageChannelId;
  const inboxGuild = utils.getInboxGuild();

  if (! inboxGuild.channels.has(attachmentChannelId)) {
    throw new Error("Attachment storage channel not found!");
  }

  const attachmentChannel = inboxGuild.channels.get(attachmentChannelId);
  if (! (attachmentChannel instanceof Eris.TextChannel)) {
    throw new Error("Attachment storage channel must be a text channel!");
  }

  const file = await attachmentToDiscordFileObject(attachment);
  const savedAttachment = await createDiscordAttachmentMessage(attachmentChannel, file);
  if (! savedAttachment) return getErrorResult();

  return { url: savedAttachment.url };
};

async function createDiscordAttachmentMessage(channel, file, tries = 0) {
  tries++;

  try {
    const attachmentMessage = await channel.createMessage(undefined, file);
    return attachmentMessage.attachments[0];
  } catch (e) {
    if (tries > 3) {
      console.error(`Attachment storage message could not be created after 3 tries: ${e.message}`);
      return;
    }

    return createDiscordAttachmentMessage(channel, file, tries);
  }
}

/**
 * Turns the given attachment into a file object that can be sent forward as a new attachment
 * @param {Eris.Attachment} attachment
 * @returns {Promise<Eris.MessageFile>}
 */
async function attachmentToDiscordFileObject(attachment) {
  const downloadResult = await downloadAttachment(attachment);
  const data = await readFile(downloadResult.path);
  downloadResult.cleanup();
  // Attachments with duplicate filenames get dropped silently by the API, so give every attachment a unique filename
  // This commonly happens when pasting images as attachments, as they get named "unknown.png"
  const ext = path.extname(attachment.filename) || ".dat";
  const filename = `${attachment.id}${ext}`;
  return { file: data, name: filename };
}

/**
 * @type {SaveAttachmentFn}
 */
const saveAttachment = (attachment) => {
  if (attachmentSavePromises[attachment.id]) {
    return attachmentSavePromises[attachment.id];
  }

  if (attachmentStorageTypes[config.attachmentStorage]) {
    attachmentSavePromises[attachment.id] = Promise.resolve(attachmentStorageTypes[config.attachmentStorage](attachment));
  } else {
    throw new Error(`Unknown attachment storage option: ${config.attachmentStorage}`);
  }

  attachmentSavePromises[attachment.id].then(() => {
    delete attachmentSavePromises[attachment.id];
  });

  return attachmentSavePromises[attachment.id];
};

// Discord CDN attachment URLs are signed and expire (~24h). As long as the original message still exists
// (e.g. the user's DM), the API can re-sign them via POST /attachments/refresh-urls.
const DISCORD_ATTACHMENT_URL_REGEX = /https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:ephemeral-)?attachments\/\d+\/\d+\/[^\s<>()[\]"'`]+/g;
const REFRESH_URLS_BATCH_SIZE = 50;
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // Refresh URLs that expire within the next hour

/** @type {Map<string, string>} Unsigned URL -> latest signed URL */
const refreshedUrlCache = new Map();

function isDiscordAttachmentUrl(url) {
  return typeof url === "string" && url.match(DISCORD_ATTACHMENT_URL_REGEX) !== null;
}

function getUnsignedUrl(url) {
  const parsed = new URL(url);
  for (const param of ["ex", "is", "hm"]) parsed.searchParams.delete(param);
  return parsed.toString();
}

function signedUrlIsFresh(url) {
  const ex = new URL(url).searchParams.get("ex");
  if (! ex) return false;
  const expiresAt = parseInt(ex, 16) * 1000;
  return expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

/**
 * Returns a map of each given Discord attachment URL to a currently valid signed URL.
 * URLs that could not be refreshed (e.g. the original message was deleted) map to themselves.
 * @param {string[]} urls
 * @returns {Promise<Map<string, string>>}
 */
async function refreshDiscordAttachmentUrls(urls) {
  const result = new Map();
  const toRefresh = new Map(); // unsigned -> original URLs that map to it

  for (const url of new Set(urls.filter(isDiscordAttachmentUrl))) {
    let unsigned;
    try {
      unsigned = getUnsignedUrl(url);
    } catch (e) {
      result.set(url, url);
      continue;
    }

    const cached = refreshedUrlCache.get(unsigned);
    if (cached && signedUrlIsFresh(cached)) {
      result.set(url, cached);
    } else if (signedUrlIsFresh(url)) {
      result.set(url, url);
    } else {
      if (! toRefresh.has(unsigned)) toRefresh.set(unsigned, []);
      toRefresh.get(unsigned).push(url);
    }
  }

  const unsignedUrls = Array.from(toRefresh.keys());
  const bot = require("../bot");

  for (let i = 0; i < unsignedUrls.length; i += REFRESH_URLS_BATCH_SIZE) {
    const batch = unsignedUrls.slice(i, i + REFRESH_URLS_BATCH_SIZE);
    try {
      const response = await bot.requestHandler.request("POST", "/attachments/refresh-urls", true, {
        attachment_urls: batch,
      });

      for (const { original, refreshed } of response.refreshed_urls || []) {
        if (! refreshed) continue;
        const unsigned = getUnsignedUrl(original);
        refreshedUrlCache.set(unsigned, refreshed);
        for (const url of toRefresh.get(unsigned) || []) result.set(url, refreshed);
      }
    } catch (e) {
      console.error(`[WARN] Failed to refresh attachment URLs: ${e.message}`);
    }
  }

  // Anything left over couldn't be refreshed; keep the original URL
  for (const originals of toRefresh.values()) {
    for (const url of originals) {
      if (! result.has(url)) result.set(url, url);
    }
  }

  return result;
}

/**
 * Replaces expired Discord attachment URLs in the given thread messages (attachments, small_attachments and body)
 * with freshly signed ones. Mutates and returns the given messages.
 * @param {import("./ThreadMessage")[]} threadMessages
 * @returns {Promise<import("./ThreadMessage")[]>}
 */
async function refreshThreadMessageAttachmentUrls(threadMessages) {
  const urls = [];
  for (const msg of threadMessages) {
    urls.push(...(msg.attachments || []), ...(msg.small_attachments || []));
    if (typeof msg.body === "string") urls.push(...(msg.body.match(DISCORD_ATTACHMENT_URL_REGEX) || []));
  }

  if (urls.length === 0) return threadMessages;

  const refreshed = await refreshDiscordAttachmentUrls(urls);
  const replace = url => refreshed.get(url) || url;

  for (const msg of threadMessages) {
    if (Array.isArray(msg.attachments)) msg.attachments = msg.attachments.map(replace);
    if (Array.isArray(msg.small_attachments)) msg.small_attachments = msg.small_attachments.map(replace);
    if (typeof msg.body === "string") msg.body = msg.body.replace(DISCORD_ATTACHMENT_URL_REGEX, replace);
  }

  return threadMessages;
}

/**
 * @type AddAttachmentStorageTypeFn
 */
const addStorageType = (name, handler) => {
  attachmentStorageTypes[name] = handler;
};

addStorageType("original", passthroughOriginalAttachment);
addStorageType("local", saveLocalAttachment);
addStorageType("discord", saveDiscordAttachment);

module.exports = {
  getLocalAttachmentPath,
  attachmentToDiscordFileObject,
  saveAttachment,
  addStorageType,
  downloadAttachment,
  refreshDiscordAttachmentUrls,
  refreshThreadMessageAttachmentUrls
};
