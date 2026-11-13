// bot/src/appeals.js
const express = require("express");
const superagent = require("superagent");
const jwt = require("jsonwebtoken");
const config = require("./cfg");
const bot = require("./bot");
const { getAuthUser } = require("./oauth2");
const threads = require("./data/threads");
const blocked = require("./data/blocked");
const utils = require("./utils/utils");
const { getAppealCooldownEndsAt, formatAppealCooldownMessage } = require("./utils/appealCooldown");

const router = express.Router();
const REDIRECT_URI = `${config.appealsUrl}/appeals/login`;
const MAX_FIELD_LENGTH = 1000; // matches the form's maxlength
const COOKIE = { httpOnly: true, secure: true, sameSite: "lax", path: "/appeals" };

router.use((req, res, next) =>
  req.get("X-Appeals-Secret") === config.appealsProxySecret ? next() : res.sendStatus(403));
router.use(express.json());

router.get("/login", async (req, res) => {
  if (!req.query.code) {
    return res.redirect(`https://discord.com/oauth2/authorize?client_id=${config.clientId}`
      + `&response_type=code&scope=${encodeURIComponent("identify guilds.join")}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
  }
  try {
    const { body } = await superagent.post("https://discord.com/api/oauth2/token").type("form").send({
      client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: "authorization_code", code: req.query.code, redirect_uri: REDIRECT_URI,
    });
    const token = jwt.sign({ token: body.access_token }, config.clientSecret);
    res.cookie("appeal_token", token, { ...COOKIE, maxAge: body.expires_in * 1000 });
    res.redirect("/");
  } catch { res.status(401).send("Login failed"); }
});

router.get("/logout", (req, res) => { res.clearCookie("appeal_token", COOKIE); res.redirect("/"); });

async function requireUser(req, res, next) {
  req.user = req.cookies.appeal_token && await getAuthUser(req.cookies.appeal_token);
  return req.user ? next() : res.sendStatus(401);   // the frontend expects 401 from /me
}

router.get("/me", requireUser, async (req, res) => {
  const u = req.user;
  res.json({
    // User appealing via the web form aren't in the guild yet, so we'll ignore the membership check
    appealCooldownEndsAt: await getAppealCooldownEndsAt(u.id),
    id: u.id, username: u.username, globalName: u.global_name,
    avatarURL: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
                        : "https://cdn.discordapp.com/embed/avatars/0.png",
  });
});

router.post("/", requireUser, async (req, res) => {
  const fields = {
    banReason: "Why were you banned?",
    appealReason: "Why should you be unbanned?",
    behaviorChange: "What will you do to avoid being banned in the future?",
  };
  const answers = {};
  for (const key of Object.keys(fields)) {
    const value = typeof req.body?.[key] === "string" ? req.body[key].trim() : "";
    if (! value) return res.status(400).send("Please answer every question.");
    if (value.length > MAX_FIELD_LENGTH) return res.status(400).send(`Answers must be ${MAX_FIELD_LENGTH} characters or fewer.`);
    answers[key] = value;
  }

  const userId = req.user.id;
  if (await blocked.isBlocked(userId))
    return res.status(403).send("You are blocked from submitting appeals.");
  if (await threads.findOpenThreadByUserId(userId))
    return res.status(409).send("You already have an open appeal. Our staff will contact you through modmail.");

  const cooldownEndsAt = await getAppealCooldownEndsAt(userId);
  if (cooldownEndsAt) return res.status(429).send(formatAppealCooldownMessage(cooldownEndsAt - Date.now()));

  // Add the user to the appeals guild. The thread is only created if they're in the guild
  try {
    const { token } = jwt.verify(req.cookies.appeal_token, config.clientSecret);
    await bot.addGuildMember(config.appealGuildId, userId, token);
  } catch (err) {
    console.error(`[appeals] Failed to add ${userId} to ${config.appealGuildId}:`, err.message);
    return res.status(403).send("We couldn't add you to the appeal server. Try joining via https://discord.gg/vVcCbwXEXr");
  }

  let user, thread;
  try {
    user = bot.users.get(userId) || await bot.getRESTUser(userId);
    thread = await threads.createNewThreadForUser(user, { source: "appeal" });
  } catch (err) {
    if (await threads.findOpenThreadByUserId(userId))
      return res.status(409).send("You already have an open appeal. Our staff will contact you through modmail.");
    console.error(`[appeals] Failed to create thread for ${userId}:`, err);
    return res.status(500).send("Something went wrong submitting your appeal. Please try again later.");
  }
  if (! thread) return res.status(403).send("You aren't able to submit an appeal right now.");

  const body = Object.entries(fields)
    .map(([key, question]) => `**${question}**\n${answers[key].split("\n").map(l => `> ${l}`).join("\n")}`)
    .join("\n\n");
  await thread.receiveUserText(user, `**Ban appeal submitted via the website**\n\n${body}`);

  if (config.responseMessage) {
    try {
      await thread.sendSystemMessageToUser(utils.readMultilineConfigValue(config.responseMessage), {
        postToThreadChannel: config.showResponseMessageInThreadChannel,
      });
    } catch (err) {
      await thread.postSystemMessage(`**NOTE:** Could not send auto-response to the user. The error given was: \`${err.message}\``);
    }
  }

  res.sendStatus(204);
});

module.exports = router;