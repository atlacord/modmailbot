const express = require("express");
const helmet = require("helmet");
const mime = require("mime");
const url = require("url");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const qs = require("querystring");
const path = require("path");
const moment = require("moment");
const config = require("../cfg");
const threads = require("../data/threads");
const attachments = require("../data/attachments");
const { formatters } = require("../formatters");
const { summariseEmbedsAsText } = require("../embedLogging");
const marked = require("marked");

const API_ENDPOINT = "https://discord.com/api/v9";

let bot;

function notfound(res) {
  res.status(404).send("Page Not Found");
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

const mdPrivacyPolicyPath = path.resolve(__dirname, "../../PRIVACY_POLICY.md");
let htmlPrivacyPolicy = null;
if (fs.existsSync(mdPrivacyPolicyPath)) {
  const mdPrivacyPolicy = fs.readFileSync(mdPrivacyPolicyPath, { encoding: "utf8" });
  const parsedPrivacyPolicy = marked.parse(mdPrivacyPolicy);
  htmlPrivacyPolicy = `
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Privacy policy</title>
      <style>
        html {
          font: normal 16px/1.4 system-ui, sans-serif;
        }
        body {
          width: 100%;
          max-width: 900px;
          margin: 32px auto;
          padding: 0 16px;
        }
      </style>
    </head>
    <body>${parsedPrivacyPolicy}</body>
    </html>
  `;
}

function decodeJwt(token) {
  return jwt.decode(token, config.jwtSecret);
};

async function createThread(req, res) {
  console.log("This should be running");
  res.set("Content-Security-Policy", "script-src 'nonce-hawky'")

  if (req.query.t !== undefined) {
    const meta = decodeJwt(req.query.t);
  };

  console.log(req.body);

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

const server = express();
server.use(helmet());

server.get("/logs/:threadId", serveLogs);
server.get("/attachments/:attachmentId/:filename", serveAttachments);
server.get("/threads/create", createThread);
if (htmlPrivacyPolicy) {
  server.get("/privacy-policy", (req, res) => {
    res.set("Content-Type", "text/html; charset=utf8");
    res.send(htmlPrivacyPolicy);
  });
};

server.on("error", err => {
  console.log("[WARN] Web server error:", err.message);
});

module.exports = (mmbot) => {
  bot = mmbot;
  return server;
};
