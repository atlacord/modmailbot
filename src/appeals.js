// bot/src/appeals.js
const express = require("express");
const superagent = require("superagent");
const jwt = require("jsonwebtoken");
const config = require("./cfg");
const { getAuthUser } = require("./oauth2");

const router = express.Router();
const REDIRECT_URI = `${config.appealsUrl}/appeals/login`; // e.g. https://appeals.yourdomain.com
const COOKIE = { httpOnly: true, secure: true, sameSite: "lax", path: "/appeals" };

router.use((req, res, next) =>
  req.get("X-Appeals-Secret") === config.appealsProxySecret ? next() : res.sendStatus(403));
router.use(express.json());

router.get("/login", async (req, res) => {
  if (!req.query.code) {
    return res.redirect(`https://discord.com/oauth2/authorize?client_id=${config.clientId}`
      + `&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
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

router.get("/me", requireUser, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, globalName: u.global_name,
    avatarURL: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
                        : "https://cdn.discordapp.com/embed/avatars/0.png",
  });
});

router.post("/", requireUser, async (req, res) => {
  const { banReason, appealReason, behaviorChange } = req.body;
  // validate, check getAppealCooldownRemaining(req.user.id), then post to the modmail/appeals channel
  res.sendStatus(204);
});

module.exports = router;