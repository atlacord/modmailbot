const superagent = require("superagent");
const jwt = require("jsonwebtoken");
const config = require("./cfg");
const bot = require("./bot");
const utils = require("./utils/utils");

const authCache = new Map();

function login (req, res) {
  utils.getSelfUrl(config.redirectPath.slice(1)).then(redirectUri => {
    let code = req.query.code;
    const oauth2url = `https://discord.com/oauth2/authorize?client_id=${config.clientId}`
      + `&scope=identify&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=identify`;
    if (! code)
      return res.redirect(oauth2url);
    superagent.post("https://discord.com/api/oauth2/token")
      .type("form")
      .send({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
        scope: "identify"
      }).then(response => {
        let token = jwt.sign({
          token: response.body.access_token
        }, config.clientSecret);
        res.cookie("token", token, {
          maxAge: response.body.expires_in * 1000
        });
        res.redirect("/");
      }).catch(() => {
        res.status(401);
        res.send("<pre>401 Unauthorized</pre>");
      });
  });
}

function logout (req, res) {
  authCache.delete(req.cookies.token);
  res.clearCookie("token");
  res.redirect(config.redirectPath);
}

function isDashAdmin (user) {
  try {
    const guild = bot.guilds.get(config.mainGuildId[0]);
    const member = guild.members.get(user.id);
    if (! member) return false;
    return utils.isAdmin(member);
  } catch (err) {
    return false;
  }
}

// Users with a community role (and no admin role) can only view community threads
function isDashCommunityOnly (user) {
  try {
    const guild = bot.guilds.get(config.mailGuildId);
    const member = guild.members.get(user.id);
    if (! member) return false;
    if (isDashAdmin(user)) return false;
    return member.roles.some(r => config.inboxCommunityRoleIDs.includes(r)) && !member.roles.some(r => config.inboxModeratorRoleIDs.includes(r));
  } catch (err) {
    return false;
  }
}

// Users with a moderator role (and no admin or community role) can't view community threads
function isDashModerator (user) {
  try {
    const guild = bot.guilds.get(config.mailGuildId);
    const member = guild.members.get(user.id);
    if (! member) return false;
    if (isDashAdmin(user)) return false;
    return member.roles.some(r => config.inboxModeratorRoleIDs.includes(r))
      && ! member.roles.some(r => config.inboxCommunityRoleIDs.includes(r));
  } catch (err) {
    return false;
  }
}

async function getAuthUser (token) {
  const cached = authCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;
  let user;

  try {
    let accessToken = jwt.verify(token, config.clientSecret).token;
    let response = await superagent.get("https://discord.com/api/users/@me")
      .set("Authorization", `Bearer ${accessToken}`);

    user = response.body;
  } catch (err) {
    return;
  }

  authCache.set(token, { user, expires: Date.now() + 5 * 60 * 1000 });
  return user;
}

async function checkAuth (req, res, next) {
  if (req.cookies.token) {
    req.user = await getAuthUser(req.cookies.token);

    if (!req.user) {
      return res.redirect("/login");
    } else {
      const guild = bot.guilds.get(config.mailGuildId);
      const member = guild.members.get(req.user.id);

      if (member) {
        let isAuthorized = false;

        if (config.dashAuthRoles)
          isAuthorized = member.roles.some(r => config.dashAuthRoles.includes(r));
        if (config.dashAuthUsers)
          isAuthorized = config.dashAuthUsers.includes(member.id);
        if (member.roles.some(r => config.inboxCommunityRoleIDs.includes(r)))
          isAuthorized = true;

        if (isAuthorized) {
          return next();
        }
      }
      
      res.status(401);
      res.send("<pre>401 Unauthorized</pre>");
    }
  } else {
    res.redirect("/login");
  }
}

module.exports = {
  login,
  logout,
  isDashAdmin,
  isDashCommunityOnly,
  isDashModerator,
  getAuthUser,
  checkAuth,
};
