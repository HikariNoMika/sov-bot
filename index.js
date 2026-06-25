require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');

const config = require('./config.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Stores pending bad-word reviews temporarily while bot is running
const pendingReviews = new Map();

// Stores rules embed data
const serverRules = config.serverRules || {
  title: 'Server Rules',
  description: 'Follow the rules to keep the server safe and fun for everyone.',
  rules: [
    'Be respectful to everyone',
    'No explicit or inappropriate content',
    'Follow Discord ToS',
    'Use channels for their intended purpose'
  ]
};

// ----------------------------------------------------
// CoC WAR TIMER SYSTEM
// ----------------------------------------------------
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const cocWar = {
  type: null,
  phase: null,
  prepEndsAt: null,
  battleEndsAt: null,
  timers: []
};

function cocSend(guild, content) {
  const channel = guild.channels.cache.get(config.cocChannelId);
  if (channel) channel.send(content);
}

function cocScheduleNotifications(guild) {
  cocWar.timers.forEach(clearTimeout);
  cocWar.timers = [];

  if (cocWar.type === 'normal') {
    // Battle starts (after 24h prep)
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'battle';
      cocSend(guild, `⚔️ **Battle Day has started!** Attack now to secure victory for the clan!`);
    }, cocWar.prepEndsAt - Date.now()));

    // 12h remaining in battle
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `⏰ **12 hours remaining** in battle! Make sure you've used both attacks!`);
    }, cocWar.battleEndsAt - Date.now() - 12 * HOUR));

    // 6h remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `⏰ **6 hours remaining!** Get your attacks in before time runs out!`);
    }, cocWar.battleEndsAt - Date.now() - 6 * HOUR));

    // 1h remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `🔥 **1 hour left!** Final chance to use your attacks!`);
    }, cocWar.battleEndsAt - Date.now() - HOUR));

    // 30m remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `⏳ **30 minutes left!** Hurry and use your remaining attacks!`);
    }, cocWar.battleEndsAt - Date.now() - 30 * 60 * 1000));

    // War over
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'ended';
      cocSend(guild, `🏁 **The war has ended!** Great effort, clan!`);
    }, cocWar.battleEndsAt - Date.now()));

  } else if (cocWar.type === 'cwl') {
    // CWL has 1 prep day + 7 battle rounds
    const roundDuration = 24 * HOUR; // each round is 24h

    // Phase switch: prep -> battle (start of round 1)
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'battle';
      cocSend(guild, `⚔️ **CWL Round 1 has started!** Attack and earn stars for the clan!`);
    }, cocWar.prepEndsAt - Date.now()));

    // Schedule each round notification
    for (let round = 2; round <= 7; round++) {
      const roundStart = cocWar.prepEndsAt + (round - 1) * roundDuration;
      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `⚔️ **CWL Round ${round} has started!** Get your attacks in!`);
      }, roundStart - Date.now()));

      // 6h reminder for each round
      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `⏰ **CWL Round ${round} - 6 hours left!** Don't forget to attack!`);
      }, roundStart + 18 * HOUR - Date.now()));
    }

    // CWL over
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'ended';
      cocSend(guild, `🏁 **CWL has ended!** Well fought, clan! 🎉`);
    }, cocWar.battleEndsAt - Date.now()));
  }
}

function cocFormatTime(ms) {
  if (ms <= 0) return 'Ended';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / 60000);
  let str = '';
  if (days > 0) str += `${days}d `;
  if (hours > 0) str += `${hours}h `;
  str += `${minutes}m`;
  return str;
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ----------------------------------------------------
// CHECK IF MEMBER CAN REVIEW FLAGGED MESSAGES
// ----------------------------------------------------
function canReview(member) {
  if (!member) return false;

  // 1) Admins can always review
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }

  // 2) Specific allowed users from config.json
  if (
    Array.isArray(config.moderatorUserIds) &&
    config.moderatorUserIds.includes(member.id)
  ) {
    return true;
  }

  // 3) Allowed moderator roles from config.json
  if (
    Array.isArray(config.moderatorRoleIds) &&
    config.moderatorRoleIds.length > 0
  ) {
    return config.moderatorRoleIds.some(roleId => member.roles.cache.has(roleId));
  }

  return false;
}

// ----------------------------------------------------
// BUILD WELCOME LANDING PAGE
// ----------------------------------------------------
function buildWelcomeLanding(member) {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`🎉 Welcome to ${member.guild.name}!`)
    .setDescription(
      `Hello ${member}, welcome!\n\n` +
      `We're glad to have you here. Use the buttons below to get started.`
    )
    .addFields({
      name: '📌 Quick Tips',
      value:
        '• Click **📜 Rules** to see the server rules\n' +
        '• Click **📁 Channels** to see channel guides\n' +
        '• Click **🆘 Help** if you need assistance'
    })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('welcome_rules')
      .setLabel('📜 Rules')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('welcome_channels')
      .setLabel('📁 Channels')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('welcome_help')
      .setLabel('🆘 Help')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

// ----------------------------------------------------
// WELCOME LANDING PAGE
// ----------------------------------------------------
client.on('guildMemberAdd', async (member) => {
  try {
    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel) {
      console.log('❌ Welcome channel not found.');
      return;
    }

    await channel.send({
      content: `${member}`,
      ...buildWelcomeLanding(member)
    });
  } catch (err) {
    console.error('Welcome error:', err);
  }
});

// ----------------------------------------------------
// MESSAGE MODERATION
// ----------------------------------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const content = message.content.toLowerCase();

    // --------------------------------------------
    // 0) COMMANDS
    // --------------------------------------------
    if (content === '!welcome') {
      if (!canReview(message.member)) return;

      await message.channel.send({
        content: `👋 Welcome preview for ${message.author}`,
        ...buildWelcomeLanding(message.member)
      });
      return;
    }

    if (content === '!rules') {
      const rulesList = serverRules.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(serverRules.title)
        .setDescription(serverRules.description)
        .addFields({ name: '📜 Rules', value: rulesList });

      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (content === '!mods' || content === '!moderators') {
      const userIds = config.moderatorUserIds.map(id => `<@${id}>`).join('\n') || 'None';
      const roleIds = config.moderatorRoleIds.map(id => `<@&${id}>`).join('\n') || 'None';

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛡️ Moderators')
        .addFields(
          { name: 'Users', value: userIds, inline: true },
          { name: 'Roles', value: roleIds, inline: true }
        );

      await message.channel.send({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // COC WAR COMMANDS
    // --------------------------------------------
    if (content.startsWith('!coc ')) {
      const args = content.slice(5).trim().split(/\s+/);

      // Only status is public; everything else requires moderator
      if (args[0] !== 'status' && !canReview(message.member)) return;

      if (args[0] === 'start' && args[1] === 'war') {
        if (cocWar.phase && cocWar.phase !== 'ended') {
          await message.channel.send('⚠️ A war is already ongoing! Use `!coc cancel` first.');
          return;
        }

        let prepHours = 24;
        if (args[2]) {
          const match = args[2].match(/^(\d+)(h|m|d)$/);
          if (match) {
            if (match[2] === 'h') prepHours = parseInt(match[1]);
            else if (match[2] === 'm') prepHours = parseInt(match[1]) / 60;
            else if (match[2] === 'd') prepHours = parseInt(match[1]) * 24;
          } else {
            await message.channel.send('⚠️ Invalid format. Use e.g. `!coc start war 23h`, `!coc start war 90m`');
            return;
          }
        }

        const prepMs = prepHours * HOUR;
        const now = Date.now();
        cocWar.type = 'normal';
        cocWar.phase = 'preparation';
        cocWar.prepEndsAt = now + prepMs;
        cocWar.battleEndsAt = now + prepMs + DAY;

        cocScheduleNotifications(message.guild);

        await message.channel.send(`⚔️ **Normal War started!**\n📅 Preparation: ${cocFormatTime(prepMs)}\n⚔️ Battle: 24h\nTotal: ${cocFormatTime(prepMs + DAY)}`);
        cocSend(message.guild, `🏰 **A Clan War has started!** Preparation phase is active. Get your bases ready!`);

      } else if (args[0] === 'start' && args[1] === 'cwl') {
        if (cocWar.phase && cocWar.phase !== 'ended') {
          await message.channel.send('⚠️ A war is already ongoing! Use `!coc cancel` first.');
          return;
        }

        const now = Date.now();
        cocWar.type = 'cwl';
        cocWar.phase = 'preparation';
        cocWar.prepEndsAt = now + DAY;
        cocWar.battleEndsAt = now + DAY + 7 * DAY;

        cocScheduleNotifications(message.guild);

        await message.channel.send(`⚔️ **CWL started!**\n📅 Preparation: 24h\n⚔️ 7 Battle Rounds\nTotal: 8 days`);
        cocSend(message.guild, `🏆 **Clan War League has started!** Prepare for 7 rounds of battles!`);

      } else if (args[0] === 'status') {
        if (!cocWar.phase || cocWar.phase === 'ended') {
          await message.channel.send('📭 No ongoing war.');
          return;
        }

        const now = Date.now();
        let desc;

        if (cocWar.phase === 'preparation') {
          desc = `📅 **Preparation Phase**\nTime left: ${cocFormatTime(cocWar.prepEndsAt - now)}`;
        } else if (cocWar.phase === 'battle') {
          desc = `⚔️ **Battle Phase**\nTime left: ${cocFormatTime(cocWar.battleEndsAt - now)}`;
        } else {
          desc = '🏁 War has ended.';
        }

        const embed = new EmbedBuilder()
          .setColor(cocWar.type === 'cwl' ? 0xFFD700 : 0x57F287)
          .setTitle(`🏰 ${cocWar.type.toUpperCase()} War Status`)
          .setDescription(desc)
          .addFields(
            { name: '📅 Prep ends', value: `<t:${Math.floor(cocWar.prepEndsAt / 1000)}:R>`, inline: true },
            { name: '⚔️ Battle ends', value: `<t:${Math.floor(cocWar.battleEndsAt / 1000)}:R>`, inline: true }
          );

        await message.channel.send({ embeds: [embed] });

      } else if (args[0] === 'cancel') {
        if (!cocWar.phase || cocWar.phase === 'ended') {
          await message.channel.send('📭 No ongoing war to cancel.');
          return;
        }

        cocWar.timers.forEach(clearTimeout);
        cocWar.timers = [];
        cocWar.phase = 'ended';

        await message.channel.send('❌ War cancelled.');
        cocSend(message.guild, `❌ **The war has been cancelled.**`);

      } else {
        await message.channel.send(
          '**CoC Commands:**\n' +
          '`!coc start war [time]` - Start normal war (24h prep, 24h battle)\n' +
          '`!coc start war 23h` - With custom prep time\n' +
          '`!coc start cwl` - Start CWL (8 days)\n' +
          '`!coc status` - Check war status\n' +
          '`!coc cancel` - Cancel current war'
        );
      }
      return;
    }

    // --------------------------------------------
    // 1) BAD WORD REVIEW (OPTION A: SAME CHANNEL)
    // --------------------------------------------
    const foundBadWord = config.badWords.some(word =>
      content.includes(word.toLowerCase())
    );

    if (foundBadWord) {
      const originalContent = message.content;
      const originalChannelId = message.channel.id;
      const authorId = message.author.id;
      const authorTag = message.author.tag;

      // Delete original flagged message
      try {
        await message.delete();
      } catch (e) {
        console.log('Could not delete flagged message.');
      }

      // Create a unique review ID
      const reviewId = `review_${Date.now()}_${message.id}`;

      // Save review data in memory
      pendingReviews.set(reviewId, {
        content: originalContent,
        channelId: originalChannelId,
        userId: authorId,
        userTag: authorTag
      });

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('⚠️ Message Held for Review')
        .setDescription(
          `A message from <@${authorId}> was held for moderator review.\n\n` +
          `**Reason:** Contains a flagged word or phrase.`
        )
        .addFields(
          { name: 'User', value: `<@${authorId}>`, inline: true },
          { name: 'Channel', value: `<#${originalChannelId}>`, inline: true }
        )
        .setFooter({ text: `Review ID: ${reviewId}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${reviewId}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${reviewId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`warn_${reviewId}`)
          .setLabel('Warn User')
          .setStyle(ButtonStyle.Secondary)
      );

      await message.channel.send({
        content: `⚠️ Moderators, a message from <@${authorId}> is under review.`,
        embeds: [embed],
        components: [row]
      });

      return;
    }

    // --------------------------------------------
    // 2) ATTACHMENT / FILE / VIDEO REDIRECT
    // --------------------------------------------
    const hasAttachments = message.attachments.size > 0;
    if (!hasAttachments) return;

    const isBlockedChannel = config.blockedAttachmentChannels.includes(message.channel.id);
    if (!isBlockedChannel) return;

    const mediaChannel = `<#${config.mediaChannelId}>`;
    const filesChannel = `<#${config.filesChannelId}>`;

    if (config.deleteWrongAttachments) {
      try {
        await message.delete();
      } catch (e) {
        console.log('Could not delete attachment message.');
      }
    }

    await message.channel.send(
      `📁 ${message.author}, files/videos/images are not allowed here.\n` +
      `Please post media in ${mediaChannel} and documents/files in ${filesChannel}.`
    );

  } catch (err) {
    console.error('Message moderation error:', err);
  }
});

// ----------------------------------------------------
// BUTTON INTERACTIONS FOR REVIEW
// ----------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.guild) return;

    const member = interaction.member;

    if (!canReview(member)) {
      return interaction.reply({
        content: '❌ You are not allowed to review moderated messages.',
        ephemeral: true
      });
    }

    // --------------------------------------------
    // WELCOME LANDING PAGE BUTTONS
    // --------------------------------------------
    if (interaction.customId === 'welcome_rules') {
      const rulesList = serverRules.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(serverRules.title)
        .setDescription(serverRules.description)
        .addFields({ name: '📜 Rules', value: rulesList });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'welcome_channels') {
      const mediaChannel = config.mediaChannelId ? `<#${config.mediaChannelId}>` : 'N/A';
      const filesChannel = config.filesChannelId ? `<#${config.filesChannelId}>` : 'N/A';
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📁 Channel Guide')
        .setDescription('Here are the main channels and what they are for:')
        .addFields(
          { name: '🖼️ Media', value: `Post images/videos in ${mediaChannel}`, inline: true },
          { name: '📄 Files', value: `Post documents in ${filesChannel}`, inline: true }
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'welcome_help') {
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🆘 Need Help?')
        .setDescription(
          'If you need assistance, you can:\n\n' +
          '• Ask in the general chat\n' +
          '• Ping a moderator or admin\n' +
          '• Check the rules for guidelines'
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const [action, ...rest] = interaction.customId.split('_');
    const reviewId = rest.join('_'); // review id contains underscores

    if (!pendingReviews.has(reviewId)) {
      return interaction.reply({
        content: '⚠️ This review is no longer available.',
        ephemeral: true
      });
    }

    const reviewData = pendingReviews.get(reviewId);
    const targetChannel = interaction.guild.channels.cache.get(reviewData.channelId);

    if (!targetChannel) {
      pendingReviews.delete(reviewId);
      return interaction.reply({
        content: '⚠️ Original channel not found.',
        ephemeral: true
      });
    }

    // --------------------------------------------
    // APPROVE
    // --------------------------------------------
    if (action === 'approve') {
      await targetChannel.send(
        `✅ **Approved message from <@${reviewData.userId}>:**\n${reviewData.content}`
      );

      pendingReviews.delete(reviewId);

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x57F287)
        .setTitle('✅ Message Approved')
        .setDescription(
          `The flagged message from <@${reviewData.userId}> was approved and reposted.`
        );

      await interaction.update({
        embeds: [updatedEmbed],
        components: []
      });

      return;
    }

    // --------------------------------------------
    // REJECT
    // --------------------------------------------
    if (action === 'reject') {
      pendingReviews.delete(reviewId);

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xED4245)
        .setTitle('❌ Message Rejected')
        .setDescription(
          `The flagged message from <@${reviewData.userId}> was rejected and remains blocked.`
        );

      await interaction.update({
        embeds: [updatedEmbed],
        components: []
      });

      return;
    }

    // --------------------------------------------
    // WARN USER
    // --------------------------------------------
    if (action === 'warn') {
      try {
        const user = await client.users.fetch(reviewData.userId);
        await user.send(
          `⚠️ Your message in the server was flagged and reviewed by moderators. Please avoid explicit or inappropriate language.`
        );
      } catch (e) {
        console.log('Could not DM warned user.');
      }

      pendingReviews.delete(reviewId);

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x5865F2)
        .setTitle('⚠️ User Warned')
        .setDescription(
          `<@${reviewData.userId}> was warned. The flagged message remains blocked.`
        );

      await interaction.update({
        embeds: [updatedEmbed],
        components: []
      });

      return;
    }

  } catch (err) {
    console.error('Interaction error:', err);

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'An error occurred while processing that action.',
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while processing that action.',
          ephemeral: true
        });
      }
    } catch {}
  }
});

client.login(process.env.TOKEN);