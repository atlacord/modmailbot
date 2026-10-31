const config = require("../../cfg");

// Not timestamped so it sorts after add_isPrivate_thread.js, which it depends on
exports.up = async function(knex) {
  await knex.schema.table("threads", table => {
    table.renameColumn("isPrivate", "is_private");
  });

  await knex.schema.table("threads", table => {
    table.string("category", 20).nullable().defaultTo(null);
  });

  // Public threads start out in the configured new thread category
  if (config.categoryAutomation && config.categoryAutomation.newThread) {
    await knex("threads").where("is_private", 0).update({ category: config.categoryAutomation.newThread });
  }

  // Private threads go in the admin category
  if (config.adminCategoryId) {
    await knex("threads").where("is_private", 1).update({ category: config.adminCategoryId });
  }
};

exports.down = async function(knex) {
  await knex.schema.table("threads", table => {
    table.dropColumn("category");
  });

  await knex.schema.table("threads", table => {
    table.renameColumn("is_private", "isPrivate");
  });
};
