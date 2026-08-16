module.exports = ({ config, bot, commands }) => {
  const server = require("./webserver")(bot);
  server.listen(config.port, config.host);

  commands.addInboxServerCommand("privacy_policy_link", "", async (msg, args, thread) => {
    const url = await utils.getSelfUrl("privacy-policy");
    utils.postSystemMessageWithFallback(msg.channel, thread, `<${url}>`);
  });
};
