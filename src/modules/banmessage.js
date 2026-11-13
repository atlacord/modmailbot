const utils = require("../utils/utils");

module.exports = ({ bot, knex, config, commands }) => {
  commands.addInboxServerCommand("banmessage", [], async (msg, args, thread) => {
    let embed = {
      title: "Ban Appeals",
      description: "The Earth King welcomes you to Lake Laogai. You are here because you were banned from the main Avatar server and submitted our [appeal form](https://appeals.atlacord.com). The purpose of this server is to allow the mod team to communicate with you when reviewing your appeal.",
      author: {
        name: msg.channel.guild.name,
        icon_url: msg.channel.guild.iconURL,
      },
      thumbnail: {
        "url": `https://vignette.wikia.nocookie.net/avatar/images/1/1f/Joo_Dee.png/revision/latest/top-crop/width/720/height/900?cb=20140422090643`
      },
      color: 16738657,
      fields: [
        {
          name: "Communication",
          value: "All communication will occur through <@718577208687460482>, our modmail bot. Any abuse of this bot will you being unable to appeal in the future", 
        },
        {
          name: "If your appeal is accepted",
          value: "You can rejoin the server at https://discord.gg/avatar",
        },
        {
          name: "If your appeal is rejected",
          value: "You will be blocked from appealing for up to 3 months, after which you are welcome to appeal again. The cooldown may increase with subsequent denials, up to and including the permanent inability to appeal."
        },
      ],
      footer: {
        timestamp: new Date
      }
    } 
  
    let message = await bot.guilds.get('736344840253472830').channels.get('736344840253472833').getMessage('801246595248816149');
    await message.edit({ embeds: [embed]}).then(msg.channel.createMessage('Success!'));
  utils.postSystemMessageWithFallback(msg.channel, thread, embed);
  });
};
