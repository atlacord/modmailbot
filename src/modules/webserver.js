const express = require("express");
const SSE = require("express-sse");
const helmet = require("helmet");
const cors = require("cors");
const mime = require("mime");
const url = require("url");
const knex = require("../knex");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const qs = require("querystring");
const path = require("path");
const moment = require("moment");
const oauth2 = require("../oauth2");
const config = require("../cfg");
const threads = require("../data/threads");
const attachments = require("../data/attachments");
const { formatters } = require("../formatters");
const { summariseEmbedsAsText } = require("../embedLogging");
const cookieParser = require('cookie-parser');
const marked = require("marked");
const constants = require("../utils/constants");
const utils = require("../utils/utils");
const bot = require("../bot");

const THREAD_ID = /^[0-9a-f-]+$/;
const ID = /^\d+$/;

const API_ENDPOINT = "https://discord.com/api/v9";

const THREAD_CATEGORIES = {
  moderator: config.categoryAutomation.newThread,
  community: config.communityCategoryId,
  admin: config.adminCategoryId
};
var sse;

function notfound(res) {
  res.status(404).send("Page Not Found");
}

function privateThread(res) {
  res.status(403).send("<pre>403 Forbidden</pre>");
}

/**
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function serveLogs(req, res) {
  const thread = await threads.findById(req.params.threadId);
  if (! thread) return notfound(res);

  let threadMessages = await thread.getThreadMessages();

  threadMessages = threadMessages.map(msg => {
    const embeds = msg.getMetadataValue && msg.getMetadataValue("embeds");
    const forwardedEmbeds = msg.getMetadataValue && msg.getMetadataValue("forwardedEmbeds");
    const embedText = summariseEmbedsAsText(embeds, "User sent an embed");
    const forwardedEmbedText = summariseEmbedsAsText(forwardedEmbeds, "User forwarded an embed");

    if (! embedText && ! forwardedEmbedText) return msg;

    const injected = [msg.body, embedText, forwardedEmbedText].filter(Boolean).join("\n\n");
    msg.body = injected;
    return msg;
  });

  const formatLogResult = await formatters.formatLog(thread, threadMessages, {
    simple: Boolean(req.query.simple),
    verbose: Boolean(req.query.verbose),
  });

  const contentType = formatLogResult.extra && formatLogResult.extra.contentType || "text/plain; charset=UTF-8";

  res.set("Content-Type", contentType);
  res.send(formatLogResult.content);
}


/**
 * @param {express.Request} req
 */
async function viewPrivateThreads(req) {
  const user = await oauth2.getAuthUser(req.cookies.token);
  return oauth2.isDashAdmin(user);
}

/**
 * @param {express.Request} req
 */
async function viewCommunityOnly(req) {
  const user = await oauth2.getAuthUser(req.cookies.token);
  return oauth2.isDashCommunityOnly(user);
};

async function viewModeratorOnly(req) {
  const user = await oauth2.getAuthUser(req.cookies.token);
  return oauth2.isDashModerator(user);
};

/**
 * @param {express.Request} req
 */
async function hideCommunityThreads(req) {
  const user = await oauth2.getAuthUser(req.cookies.token);
  return oauth2.isDashModerator(user);
}

/**
 * Excludes community threads from the query, keeping threads without a category
 * @param {import("knex").Knex.QueryBuilder} q
 */
function excludeCommunityThreads(q) {
  if (!config.communityCategoryId) return;
  q.where(qb => qb.whereNull("category").orWhereNot("category", config.communityCategoryId));
}

async function hideModeratorThreads(req) {
  const user = await oauth2.getAuthUser(req.cookies.token);
  return oauth2.isDashCommunityOnly(user);
}

function excludeModeratorThreads(q) {
  if (!config.categoryAutomation.newThread) return;
  q.where(qb => qb.whereNull("category").orWhereNot("category", config.categoryAutomation.newThread));
};

/**
 * Returns whether the requesting user may view the given thread
 * @param {express.Request} req
 */
async function canViewThread(req, thread) {
  if (await viewCommunityOnly(req)) {
    return ! thread.is_private && thread.category === config.communityCategoryId;
  }
  if (thread.category === config.communityCategoryId && await hideCommunityThreads(req)) {
    return false;
  }
  return ! thread.is_private || await viewPrivateThreads(req);
}

function serveAttachments(req, res) {
  if (req.params.attachmentId.match(/^[0-9]+$/) === null) return notfound(res);
  if (req.params.filename.match(/^[0-9a-z._-]+$/i) === null) return notfound(res);

  const attachmentPath = attachments.getLocalAttachmentPath(req.params.attachmentId);
  fs.access(attachmentPath, (err) => {
    if (err) return notfound(res);

    const filenameParts = req.params.filename.split(".");
    const ext = (filenameParts.length > 1 ? filenameParts[filenameParts.length - 1] : "bin");
    const fileMime = mime.getType(ext);

    res.set("Content-Type", fileMime);

    const read = fs.createReadStream(attachmentPath);
    read.pipe(res);
  })
};

function decodeJwt(token) {
  return jwt.decode(token, config.jwtSecret);
};

async function createThread(bot, req, res) {
  if (req.query.t !== undefined) {
    const meta = decodeJwt(req.query.t);
  };

  const payload = {
    token: req.query.t || undefined
  };

  if (payload.token !== undefined) {
    const ctx = decodeJwt(payload.token);
    const meta = {
      user: ctx.user,
      category: ctx.category,
      content: ctx.content.slice(0, 4000)
    };

    const options = {
      categoryId: meta.category
    }

    threads.createNewThreadForUser(meta.user, options).then(thread => {
      if (thread === undefined) return res.status(400);
      const botUser = bot.guilds.get(config.mailGuildId).members.get(bot.user.id);
      thread._postToThreadChannel(meta.content).then(msg => msg.pin());
    });
      return res.status(200);
  };
  res.status(400);
};

if (!sse) {
  sse = new SSE();
};

const server = express();
server.use(cookieParser());
server.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    imgSrc: ["'self'", "data:", "https://cdn.jsdelivr.net", "https://cdn.discordapp.com"],
    scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
  },
}));
server.use(cors());

server.get(config.redirectPath, oauth2.login);
// Before checkAuth so an expired token can still log out
server.get("/logout", oauth2.logout);
server.use(oauth2.checkAuth);

server.use(express.static(path.join(__dirname, '../dashboard/dist/')));

server.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.flush = () => undefined;
  next();
});

server.get("/threads", async (req, res) => {
  let { limit: lim, page, user, sort_by, reverse, privacy, status, category } = req.query;
  let limit = parseInt(lim) || 50;

  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  page = parseInt(page) || 0;
  reverse = reverse != null;
  
  let q = knex("threads");

  // Send necessary threads only
  const viewAll = await viewPrivateThreads(req);
  const communityOnly = await viewCommunityOnly(req);
  const moderatorOnly = await viewModeratorOnly(req);
  const hideCommunity = await hideCommunityThreads(req);
  const hideModerator = await hideModeratorThreads(req);

  if (moderatorOnly) {
    q.where("is_private", 0).where("category", config.categoryAutomation.newThread || null);
  } else if (!viewAll) {
    q.where("is_private", 0);
  } else {
    if (privacy === "private") q.where("is_private", 1);
    if (privacy === "public") q.where("is_private", 0);
  };

  if (hideModerator) excludeModeratorThreads(q);

  if (communityOnly) {
    q.where("is_private", 0).where("category", config.communityCategoryId || null);
  } else if (!viewAll) {
    q.where("is_private", 0);
  } else {
    if (privacy === "private") q.where("is_private", 1);
    if (privacy === "public") q.where("is_private", 0);
  };

  if (hideCommunity) excludeCommunityThreads(q);
  if (hideModerator) excludeModeratorThreads(q);
    
  if (status === "open") {
    q.where("status", constants.THREAD_STATUS.OPEN);
  } else if (status === "closed") {
    q.where("status", constants.THREAD_STATUS.CLOSED);
  };

  // Only admins may filter by the admin category
  if (!communityOnly && !moderatorOnly && THREAD_CATEGORIES[category] && (category !== "admin" || viewAll)) {
    q.where("category", THREAD_CATEGORIES[category]);
  };

  if (user) {
    q.where("user_id", user);
  } else {
    q.select("*");
  };

  let total = (await q.clone().count())[0]["count(*)"];
  let offset = page * limit;

  if (sort_by) {
    q.orderBy(sort_by, reverse ? "asc" : "desc");
  };

  q.orderBy("created_At", "desc");

  res.json({
    total: total,
    includePrivate: viewAll,
    communityOnly,
    moderatorOnly,
    hideCommunity,
    hideModerator,
    threads: await q.limit(limit).offset(offset)
  });
});

server.get("/threads/:id", async (req, res) => {
  let thread = await knex("threads").where("id", req.params.id).first();
  if (! thread)
    return notfound(res);

  if (! await canViewThread(req, thread))
    return privateThread(res);

  res.json(thread);
});

// The logged in dashboard user, set by checkAuth
server.get("/me", (req, res) => {
  const { id, username, global_name } = req.user;
  res.json({ id, username, globalName: global_name });
});

server.get("/users", async (req, res) => {
  let q = knex("threads").select("user_id", "user_name");
  // Community-only users should only see users who have community threads
  if (await viewCommunityOnly(req))
    q.where("is_private", 0).where("category", config.communityCategoryId || null);
  else if (await hideCommunityThreads(req))
    excludeCommunityThreads(q);
  if (await viewModeratorOnly(req))
    q.where("is_private", 0).where("category", config.categoryAutomation.newThread || null);
  else if (await hideModeratorThreads(req))
    excludeModeratorThreads(q);
  let users = await q.groupBy("user_id").orderBy("created_at", "desc");
  res.json(users.map(u => ({ id: u.user_id, name: u.user_name })));
});

server.get("/logs/:id", async (req, res) => {
  const threadId = req.params.id;
  if (threadId.match(THREAD_ID) === null)
    return notfound(res);

  const thread = await threads.findById(threadId);
  if (! thread)
    return notfound(res);

  if (! await canViewThread(req, thread))
    return privateThread(res);

  const logs = await thread.getThreadMessages();

  res.json(logs);
});

server.get("/avatars/:id", async (req, res) => {
  if (!req.params.id) return;
  if (!utils.isSnowflake(req.params.id)) {
    res.set("Cache-Control", "max-age=3600").redirect('https://discordapp.com/assets/dd4dbc0016779df1378e7812eabaa04d.png');
    return;
  }
  const user = bot.users.get(req.params.id) || await bot.getRESTUser(req.params.id).catch(
    /** @param {import('eris').DiscordRESTError | import('eris').DiscordHTTPError} e */
    (e) => {
      if (e.code === 404 || e.code === 10013) {
        res.status(400).send("<pre>400 Bad Request</pre>");
      } else {
        process.emit("unhandledRejection", e);
        res.status(500).send(`<pre>500 Server Error: ${e}</pre>`);
      }
      return null;
    });
  if (! user) return;
  res.set("Cache-Control", "max-age=3600").redirect(user.avatarURL);
});

server.get("/stream", sse.init);

// Client-side routes from the dashboard's Vue router; serve the app so it can handle them
server.get(["/thread/:id", "/settings/:category"], (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

server.on("error", err => {
  console.log("[WARN] Web server error:", err.message);
});

module.exports = (_sse) => {
  sse = _sse;
  return server;
};