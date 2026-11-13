const Eris = require("eris");
const humanizeDuration = require("humanize-duration");
const bot = require("../bot");
const config = require("../cfg");

const APPEAL_GUILD_ID = "736344840253472830";
const APPEAL_COOLDOWN_MS = 367 * 60 * 1000; // 6 hours 7 minutes

async function isMemberOf(guildId, userId) {
  const guild = bot.guilds.get(guildId);
  if (! guild) return false;
  if (guild.members.has(userId)) return true;
  try {
    await bot.getRESTGuildMember(guildId, userId);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Finds when the user was banned from the given guild, searching only audit log
 * entries within the cooldown window. Returns null if no ban within the window was found.
 * Requires the bot to have the View Audit Log permission in that guild.
 * @returns {Promise<number|null>}
 */
async function getRecentBanTimestamp(guildId, userId) {
  const cutoff = Date.now() - APPEAL_COOLDOWN_MS;
  let before;

  // Page through ban entries (newest first) until we pass the cooldown window
  for (let page = 0; page < 10; page++) {
    const { entries } = await bot.getGuildAuditLog(guildId, {
      actionType: Eris.Constants.AuditLogActions.MEMBER_BAN_ADD,
      limit: 100,
      before,
    });
    if (! entries.length) return null;

    for (const entry of entries) {
      if (entry.createdAt < cutoff) return null;
      if (entry.targetID === userId) return entry.createdAt;
    }

    if (entries.length < 100) return null;
    before = entries[entries.length - 1].id;
  }

  return null;
}

/**
 * Whether the user is currently banned from the main guild.
 * Throws if the ban couldn't be checked (e.g. the bot is missing Ban Members there).
 * @returns {Promise<boolean>}
 */
async function isBannedFromMainGuild(userId) {
  const mainGuildId = config.mainServerId && config.mainServerId[0];
  if (! mainGuildId) return false;
  try {
    await bot.getGuildBan(mainGuildId, userId);
    return true;
  } catch (e) {
    if (e.code === 10026) return false; // Unknown Ban
    throw e;
  }
}

/**
 * If the user was banned from the main guild less than the cooldown ago, returns when
 * the cooldown ends (ms timestamp). Otherwise returns null.
 * @returns {Promise<number|null>}
 */
async function getAppealCooldownEndsAt(userId) {
  const mainGuildId = config.mainServerId && config.mainServerId[0];
  if (! mainGuildId) return null;

  try {
    if (! await isBannedFromMainGuild(userId)) return null;
  } catch (e) {
    return null; // Ban couldn't be fetched
  }

  let bannedAt;
  try {
    bannedAt = await getRecentBanTimestamp(mainGuildId, userId);
  } catch (e) {
    console.warn(`[WARN] Could not read audit log for appeal cooldown: ${e.message}`);
    return null;
  }
  if (! bannedAt) return null;

  const endsAt = bannedAt + APPEAL_COOLDOWN_MS;
  return endsAt > Date.now() ? endsAt : null;
}

/**
 * If the user is in the appeal guild and was banned from the main guild less than
 * the cooldown ago, returns the remaining cooldown in ms. Otherwise returns 0.
 * @returns {Promise<number>}
 */
async function getAppealCooldownRemaining(userId) {
  if (! await isMemberOf(APPEAL_GUILD_ID, userId)) return 0;
  const endsAt = await getAppealCooldownEndsAt(userId);
  return endsAt ? Math.max(0, endsAt - Date.now()) : 0;
}

function formatAppealCooldownMessage(remainingMs) {
  const humanized = humanizeDuration(remainingMs, { largest: 2, round: true, conjunction: " and " });
  return `You can't submit a ban appeal until 24 hours after your ban. Please try again in **${humanized}**.`;
}

module.exports = {
  isBannedFromMainGuild,
  getAppealCooldownEndsAt,
  getAppealCooldownRemaining,
  formatAppealCooldownMessage,
};
