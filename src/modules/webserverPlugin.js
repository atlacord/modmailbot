const utils = require('../utils/utils');
const SSE = require("express-sse");

module.exports = ({ config, bot, commands }) => {
  const sse = new SSE();
  const server = require("./webserver")(sse);
  server.listen(config.port, config.host);

  commands.addInboxServerCommand("privacy_policy_link", "", async (msg, args, thread) => {
    const url = await utils.getSelfUrl("privacy-policy");
    utils.postSystemMessageWithFallback(msg.channel, thread, `<${url}>`);
  });
};
