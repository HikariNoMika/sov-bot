require('dotenv').config();
const fs = require('fs');
const path = require('path');

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
const COC_STATE_PATH = path.join(__dirname, 'coc-war-state.json');

const cocWar = {
  type: null,
  phase: null,
  startedAt: null,
  prepEndsAt: null,
  battleEndsAt: null,
  guildId: null,
  timers: []
};

function cocSaveState() {
  const data = {
    type: cocWar.type,
    phase: cocWar.phase,
    startedAt: cocWar.startedAt,
    prepEndsAt: cocWar.prepEndsAt,
    battleEndsAt: cocWar.battleEndsAt,
    guildId: cocWar.guildId
  };
  fs.writeFileSync(COC_STATE_PATH, JSON.stringify(data));
}

function cocLoadState() {
  try {
    if (fs.existsSync(COC_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(COC_STATE_PATH, 'utf8'));
      if (data.phase === 'ended' || data.phase === null) return;
      if (Date.now() >= data.battleEndsAt) {
        cocClearState();
        return;
      }
      Object.assign(cocWar, data);
      console.log(`🔄 Resumed ${cocWar.type} war (${cocWar.phase} phase)`);
    }
  } catch (e) {
    console.log('No saved war state to resume.');
  }
}

function cocClearState() {
  cocWar.type = null;
  cocWar.phase = null;
  cocWar.startedAt = null;
  cocWar.prepEndsAt = null;
  cocWar.battleEndsAt = null;
  cocWar.guildId = null;
  try { fs.unlinkSync(COC_STATE_PATH); } catch {}
}

// Load state on startup
cocLoadState();

function cocSend(guild, content) {
  const channels = [config.cocChannelId, config.generalChannelId].filter(Boolean);
  for (const id of [...new Set(channels)]) {
    const ch = guild.channels.cache.get(id);
    if (ch) {
      ch.send(content).catch(e => console.log('cocSend error:', e.message));
    }
  }
}

function cocScheduleNotifications(guild) {
  cocWar.timers.forEach(clearTimeout);
  cocWar.timers = [];

  const t = (ms) => Math.max(0, ms);

  if (cocWar.type === 'normal') {
    // Battle starts (after prep)
    const prepDelay = cocWar.prepEndsAt - Date.now();
    if (prepDelay <= 0) {
      cocWar.phase = 'battle';
    }
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'battle';
      cocSend(guild, `⚔️ **Battle Day has started!** Attack now to secure victory for the clan!`);
    }, t(prepDelay)));

    // 6h remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `⏰ **6 hours remaining!** Get your attacks in before time runs out!`);
    }, t(cocWar.battleEndsAt - Date.now() - 6 * HOUR)));

    // 1h remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `🔥 **1 hour left!** Final chance to use your attacks!`);
    }, t(cocWar.battleEndsAt - Date.now() - HOUR)));

    // 30m remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `⏳ **30 minutes left!** Hurry and use your remaining attacks!`);
    }, t(cocWar.battleEndsAt - Date.now() - 30 * 60 * 1000)));

    // War over
    cocWar.timers.push(setTimeout(() => {
      cocClearState();
      cocSend(guild, `🏁 **The war has ended!** Great effort, clan!`);
    }, t(cocWar.battleEndsAt - Date.now())));

  } else if (cocWar.type === 'cwl') {
    const roundDuration = 24 * HOUR;

    const prepDelay = cocWar.prepEndsAt - Date.now();
    if (prepDelay <= 0 && cocWar.phase === 'preparation') {
      cocWar.phase = 'battle';
    }
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'battle';
      cocSend(guild, `⚔️ **CWL Round 1 has started!** Attack and earn stars for the clan!`);
    }, t(prepDelay)));

    for (let round = 2; round <= 7; round++) {
      const roundStart = cocWar.prepEndsAt + (round - 1) * roundDuration;
      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `⚔️ **CWL Round ${round} has started!** Get your attacks in!`);
      }, t(roundStart - Date.now())));

      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `⏰ **CWL Round ${round} - 6 hours left!** Don't forget to attack!`);
      }, t(roundStart + 18 * HOUR - Date.now())));
    }

    cocWar.timers.push(setTimeout(() => {
      cocClearState();
      cocSend(guild, `🏁 **CWL has ended!** Well fought, clan! 🎉`);
    }, t(cocWar.battleEndsAt - Date.now())));
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

  // Resume CoC war if saved state exists
  if (cocWar.phase && cocWar.phase !== 'ended' && cocWar.guildId) {
    const guild = client.guilds.cache.get(cocWar.guildId);
    if (guild) {
      console.log(`🔄 Resuming ${cocWar.type} war notifications...`);
      cocScheduleNotifications(guild);
    }
  }
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

    // Ensure member and roles are cached
    if (!message.member) message.member = await message.guild.members.fetch(message.author.id);

    const content = message.content.toLowerCase();

    // --------------------------------------------
    // 0) COMMANDS
    // --------------------------------------------
    if (content === '!welcome' || content.startsWith('!welcome ')) {
      if (!canReview(message.member)) {
        await message.channel.send('❌ You need the **Sov** role or Admin permissions to use this command.');
        return;
      }

      const target = message.mentions.members.first() || message.member;

      await message.channel.send({
        content: `👋 Welcome preview for ${target.user}`,
        ...buildWelcomeLanding(target)
      });
      return;
    }

    if (content === '!rules') {
      const rulesList = serverRules.rules.map((r, i) => `\`${i + 1}.\` ${r}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setAuthor({ name: 'Server Guidelines', iconURL: message.guild.iconURL() })
        .setTitle(serverRules.title)
        .setDescription(serverRules.description)
        .addFields({ name: '📜 Rules', value: rulesList })
        .setFooter({ text: message.guild.name })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (content === '!mods' || content === '!moderators') {
      const userIds = config.moderatorUserIds || [];
      const roleIds = config.moderatorRoleIds || [];

      const userList = userIds.map(id => `<@${id}>`);

      const roleMods = [];
      if (roleIds.length > 0) {
        const members = await message.guild.members.fetch();
        for (const roleId of roleIds) {
          const role = message.guild.roles.cache.get(roleId);
          if (!role) continue;
          members.forEach(m => {
            if (m.roles.cache.has(roleId)) {
              roleMods.push(`<@${m.id}>`);
            }
          });
        }
      }

      const allMods = [...new Set([...userList, ...roleMods])];

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: 'Staff Team', iconURL: message.guild.iconURL() })
        .setTitle('🛡️ Moderators')
        .setDescription(allMods.length > 0 ? allMods.join('\n') : 'None configured')
        .setFooter({ text: `${allMods.length} moderator(s)` })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // POLL
    // --------------------------------------------
    if (content.startsWith('!poll ')) {
      const question = content.slice(6).trim();
      if (!question) {
        await message.channel.send('⚠️ Usage: `!poll Your question here`');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setTitle('📊 Poll')
        .setDescription(question)
        .setFooter({ text: 'Vote using the buttons below' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('poll_yes').setLabel('✅ Yes').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('poll_no').setLabel('❌ No').setStyle(ButtonStyle.Danger)
      );

      await message.channel.send({ embeds: [embed], components: [row] });
      return;
    }

    // --------------------------------------------
    // SUGGEST
    // --------------------------------------------
    if (content.startsWith('!suggest ')) {
      const suggestion = content.slice(9).trim();
      if (!suggestion) {
        await message.channel.send('⚠️ Usage: `!suggest Your suggestion here`');
        return;
      }

      const channel = message.guild.channels.cache.get(config.suggestionChannelId);
      if (!channel) {
        await message.channel.send('⚠️ Suggestions channel not configured.');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setTitle('💡 Suggestion')
        .setDescription(suggestion)
        .setFooter({ text: `ID: ${message.author.id}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('suggest_up').setLabel('👍').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('suggest_down').setLabel('👎').setStyle(ButtonStyle.Danger)
      );

      const sent = await channel.send({ embeds: [embed], components: [row] });
      await message.channel.send(`✅ Your suggestion has been posted in ${channel}.`);
      return;
    }

    // --------------------------------------------
    // MODERATION: BAN
    // --------------------------------------------
    if (content.startsWith('!ban ')) {
      if (!canReview(message.member)) return;

      const member = message.mentions.members.first();
      if (!member) {
        await message.channel.send('⚠️ Mention a user to ban. Usage: `!ban @user [reason]`');
        return;
      }

      if (!member.bannable) {
        await message.channel.send('⚠️ I cannot ban that user. Check my role position.');
        return;
      }

      const reason = content.split(' ').slice(2).join(' ') || 'No reason provided';
      await member.ban({ reason });
      await message.channel.send(`✅ Banned ${member.user.tag}. Reason: ${reason}`);
      return;
    }

    // --------------------------------------------
    // MODERATION: MUTE / TIMEOUT
    // --------------------------------------------
    if (content.startsWith('!mute ') || content.startsWith('!timeout ')) {
      if (!canReview(message.member)) return;

      const member = message.mentions.members.first();
      if (!member) {
        await message.channel.send('⚠️ Mention a user. Usage: `!mute @user <duration> [reason]`\nDurations: 60s, 5m, 1h, 7d (max 28d)');
        return;
      }

      if (!member.moderatable) {
        await message.channel.send('⚠️ I cannot mute that user.');
        return;
      }

      const parts = content.split(/\s+/);
      const durationStr = parts[2];
      if (!durationStr) {
        await message.channel.send('⚠️ Specify duration. e.g. `!mute @user 1h spamming`');
        return;
      }

      const match = durationStr.match(/^(\d+)(s|m|h|d)$/);
      if (!match) {
        await message.channel.send('⚠️ Invalid duration. Use e.g. 60s, 5m, 1h, 7d');
        return;
      }

      const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      const ms = parseInt(match[1]) * multipliers[match[2]];
      if (ms > 28 * 86400000) {
        await message.channel.send('⚠️ Max timeout is 28 days.');
        return;
      }

      const reason = parts.slice(3).join(' ') || 'No reason provided';
      await member.timeout(ms, reason);
      await message.channel.send(`✅ Muted ${member.user.tag} for ${durationStr}. Reason: ${reason}`);
      return;
    }

    // --------------------------------------------
    // UNMUTE
    // --------------------------------------------
    if (content === '!unmute' || content.startsWith('!unmute ')) {
      if (!canReview(message.member)) return;

      const member = message.mentions.members.first();
      if (!member) {
        await message.channel.send('⚠️ Mention a user. Usage: `!unmute @user`');
        return;
      }

      if (!member.moderatable) return;

      await member.timeout(null);
      await message.channel.send(`✅ Unmuted ${member.user.tag}.`);
      return;
    }

    if (content === '!commands') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
        .setTitle('📋 Command Center')
        .setDescription('```\n<> required  ·  [] optional  ·  (mods) = mod only\n```')
        .addFields(
          { name: '👋 **Welcome**', value:
            '`!welcome` — Preview landing page (mods)\n' +
            '`!rules` — Display server rules\n' +
            '`!mods` — List moderators',
            inline: false },
          { name: '🚫 **Moderation**', value:
            '`!ban @user [reason]` — Ban member (mods)\n' +
            '`!mute @user <time> [reason]` — Timeout member (mods)\n' +
            '`!unmute @user` — Remove timeout (mods)\n' +
            '`!badwords list` — View filtered words\n' +
            '`!badwords add <word>` — Add filter (mods)\n' +
            '`!badwords remove <word>` — Remove filter (mods)',
            inline: false },
          { name: '📊 **Community**', value:
            '`!poll <question>` — Create a yes/no poll\n' +
            '`!suggest <idea>` — Submit a suggestion',
            inline: false },
          { name: '🏰 **CoC War**', value:
            '`!coc status` — Current war timer\n' +
            '`!coc start war [time]` — Start normal war (mods)\n' +
            '`!coc start cwl` — Start CWL season (mods)\n' +
            '`!coc cancel` — Stop war timer (mods)\n' +
            '`!coc commands` — CoC help',
            inline: false }
        )
        .setFooter({ text: 'Tip: use !coc commands for detailed CoC help' });

      await message.channel.send({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // BADWORDS MANAGEMENT
    // --------------------------------------------
    if (content.startsWith('!badwords ')) {
      if (!canReview(message.member)) return;

      const parts = content.slice(10).trim().split(/\s+/);
      const action = parts[0];
      const word = parts.slice(1).join(' ').toLowerCase();

      if (action === 'list') {
        const words = config.badWords.map((w, i) => `\`${i + 1}.\` ||${w}||`).join('\n') || 'None';
        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setAuthor({ name: 'Auto-Moderation' })
          .setTitle('🚫 Filtered Words')
          .setDescription(words || 'No words configured')
          .setFooter({ text: `${config.badWords.length} word(s) filtered` });
        await message.channel.send({ embeds: [embed] });

      } else if (action === 'add' && word) {
        if (config.badWords.includes(word)) {
          await message.channel.send(`⚠️ \`${word}\` is already in the list.`);
          return;
        }
        config.badWords.push(word);
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
        await message.channel.send(`✅ Added \`${word}\` to bad words list.`);

      } else if (action === 'remove' && word) {
        const index = config.badWords.indexOf(word);
        if (index === -1) {
          await message.channel.send(`⚠️ \`${word}\` not found in the list.`);
          return;
        }
        config.badWords.splice(index, 1);
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
        await message.channel.send(`✅ Removed \`${word}\` from bad words list.`);

      } else {
        await message.channel.send(
          '**Badwords Commands:**\n' +
          '`!badwords list` - Show all bad words\n' +
          '`!badwords add <word>` - Add a bad word\n' +
          '`!badwords remove <word>` - Remove a bad word'
        );
      }
      return;
    }

    // --------------------------------------------
    // COC WAR COMMANDS
    // --------------------------------------------
    if (content.startsWith('!coc ')) {
      const args = content.slice(5).trim().split(/\s+/);

      // Only status/help/commands is public; everything else requires moderator
      if (!['status', 'help', 'commands'].includes(args[0]) && !canReview(message.member)) {
        await message.channel.send('❌ You need the **Sov** role or Admin permissions to use this command.');
        return;
      }

      if (args[0] === 'start' && args[1] === 'war') {
        if (cocWar.phase && cocWar.phase !== 'ended') {
          await message.channel.send('⚠️ A war is already ongoing! Use `!coc cancel` first.');
          return;
        }

        let prepHours = 23;
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
        cocWar.startedAt = now;
        cocWar.prepEndsAt = now + prepMs;
        cocWar.battleEndsAt = now + prepMs + DAY;
        cocWar.guildId = message.guild.id;
        cocSaveState();

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
        cocWar.startedAt = now;
        cocWar.prepEndsAt = now + DAY;
        cocWar.battleEndsAt = now + DAY + 7 * DAY;
        cocWar.guildId = message.guild.id;
        cocSaveState();

        cocScheduleNotifications(message.guild);

        await message.channel.send(`⚔️ **CWL started!**\n📅 Preparation: 24h\n⚔️ 7 Battle Rounds\nTotal: 8 days`);
        cocSend(message.guild, `🏆 **Clan War League has started!** Prepare for 7 rounds of battles!`);

      } else if (args[0] === 'status') {
        if (!cocWar.phase || cocWar.phase === 'ended') {
          await message.channel.send('📭 No ongoing war.');
          return;
        }

        const now = Date.now();
        const phaseEmoji = cocWar.phase === 'preparation' ? '📅' : '⚔️';
        const phaseName = cocWar.phase === 'preparation' ? 'Preparation' : 'Battle';
        const remaining = cocWar.phase === 'preparation'
          ? cocWar.prepEndsAt - now
          : cocWar.battleEndsAt - now;

        const embed = new EmbedBuilder()
          .setColor(cocWar.type === 'cwl' ? 0xFFD700 : 0x57F287)
          .setAuthor({ name: 'Clash of Clans' })
          .setTitle(`🏰 ${cocWar.type.toUpperCase()} War`)
          .addFields(
            { name: `${phaseEmoji} Phase`, value: phaseName, inline: true },
            { name: '⏳ Time Remaining', value: cocFormatTime(remaining), inline: true },
            { name: '📅 Prep ends', value: `<t:${Math.floor(cocWar.prepEndsAt / 1000)}:R>`, inline: true },
            { name: '⚔️ Battle ends', value: `<t:${Math.floor(cocWar.battleEndsAt / 1000)}:R>`, inline: true }
          )
          .setFooter({ text: `Started` })
          .setTimestamp(cocWar.startedAt);

        await message.channel.send({ embeds: [embed] });

      } else if (args[0] === 'cancel') {
        if (!cocWar.phase || cocWar.phase === 'ended') {
          await message.channel.send('📭 No ongoing war to cancel.');
          return;
        }

        cocWar.timers.forEach(clearTimeout);
        cocWar.timers = [];
        cocClearState();

        await message.channel.send('❌ War cancelled.');
        cocSend(message.guild, `❌ **The war has been cancelled.**`);

      } else {
        await message.channel.send(
          '**CoC Commands:**\n' +
          '`!coc status` - Check war status (everyone)\n' +
          '`!coc commands` - Show this list (everyone)\n' +
          '`!coc start war [time]` - Start normal war (mods only)\n' +
          '`!coc start war 23h` - With custom prep time\n' +
          '`!coc start cwl` - Start CWL (mods only)\n' +
          '`!coc cancel` - Cancel current war (mods only)'
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
    // FUN: POGI (random member)
    // --------------------------------------------
    if (content === '!pogi') {
      const members = await message.guild.members.fetch();
      const humans = members.filter(m => !m.user.bot);
      const random = humans.random();
      const joinPos = [...humans.values()].sort((a, b) => a.joinedAt - b.joinedAt).findIndex(m => m.id === random.id) + 1;

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🌟 POGI CHAMPION')
        .setDescription(`Congratulations <@${random.id}>, you are the **Pogi**! 🎉`)
        .setThumbnail(random.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '👤 User', value: `${random.user.tag}`, inline: true },
          { name: '🆔 ID', value: random.id, inline: true },
          { name: '📅 Join Position', value: `#${joinPos}`, inline: true },
          { name: '📆 Joined', value: `<t:${Math.floor(random.joinedAt / 1000)}:R>`, inline: true }
        )
        .setFooter({ text: `Requested by ${message.author.tag}` })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // UNKNOWN COMMAND CATCH-ALL
    // --------------------------------------------
    if (message.content.startsWith('!')) {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
        .setTitle('❓ Unknown Command')
        .setDescription(`\`${message.content.split(' ')[0]}\` is not a recognized command.`)
        .addFields(
          { name: '👋 **Welcome**', value: '`!welcome` (mods) · `!rules` · `!mods`' },
          { name: '🚫 **Moderation**', value: '`!ban` (mods) · `!mute` (mods) · `!unmute` (mods) · `!badwords`' },
          { name: '📊 **Community**', value: '`!poll` · `!suggest`' },
          { name: '🏰 **CoC War**', value: '`!coc status` · `!coc start war` (mods) · `!coc start cwl` (mods) · `!coc cancel` (mods)' }
        )
        .setFooter({ text: 'Use !commands for full details' });

      await message.channel.send({ embeds: [embed] });
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

    // --------------------------------------------
    // PUBLIC BUTTONS (no mod check)
    // --------------------------------------------
    if (interaction.customId === 'welcome_rules') {
      const rulesList = serverRules.rules.map((r, i) => `\`${i + 1}.\` ${r}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() })
        .setTitle(serverRules.title)
        .setDescription(serverRules.description)
        .addFields({ name: '📜 Rules', value: rulesList });

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (interaction.customId === 'welcome_channels') {
      const mediaChannel = config.mediaChannelId ? `<#${config.mediaChannelId}>` : 'N/A';
      const filesChannel = config.filesChannelId ? `<#${config.filesChannelId}>` : 'N/A';
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: 'Channel Guide', iconURL: interaction.guild.iconURL() })
        .setTitle('📁 Where to Post')
        .setDescription('Use the right channels to keep things organized:')
        .addFields(
          { name: '🖼️ Images & Videos', value: `→ ${mediaChannel}`, inline: true },
          { name: '📄 Documents & Files', value: `→ ${filesChannel}`, inline: true }
        );

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (interaction.customId === 'welcome_help') {
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🆘 Need Help?')
        .setDescription(
          'If you need assistance:\n\n' +
          '💬 Ask in **general chat**\n' +
          '🔔 **Ping a moderator** or admin\n' +
          '📜 Check **server rules** for guidelines'
        );

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // --------------------------------------------
    // POLL BUTTONS
    // --------------------------------------------
    if (interaction.customId === 'poll_yes' || interaction.customId === 'poll_no') {
      const message = interaction.message;
      const embed = EmbedBuilder.from(message.embeds[0]);
      const fieldName = interaction.customId === 'poll_yes' ? '✅ Yes' : '❌ No';
      const existing = embed.data.fields?.find(f => f.name === fieldName);
      const count = existing ? parseInt(existing.value) + 1 : 1;

      const yesField = { name: '✅ Yes', value: interaction.customId === 'poll_yes' ? `${count}` : `${embed.data.fields?.find(f => f.name === '✅ Yes')?.value || 0}`, inline: true };
      const noField = { name: '❌ No', value: interaction.customId === 'poll_no' ? `${count}` : `${embed.data.fields?.find(f => f.name === '❌ No')?.value || 0}`, inline: true };

      embed.spliceFields(0, embed.data.fields?.length || 0);
      embed.addFields(yesField, noField);

      await interaction.update({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // SUGGEST BUTTONS
    // --------------------------------------------
    if (interaction.customId === 'suggest_up' || interaction.customId === 'suggest_down') {
      const message = interaction.message;
      const embed = EmbedBuilder.from(message.embeds[0]);
      const fieldName = interaction.customId === 'suggest_up' ? '👍' : '👎';
      const existing = embed.data.fields?.find(f => f.name === fieldName);
      const count = existing ? parseInt(existing.value) + 1 : 1;

      const upField = { name: '👍', value: interaction.customId === 'suggest_up' ? `${count}` : `${embed.data.fields?.find(f => f.name === '👍')?.value || 0}`, inline: true };
      const downField = { name: '👎', value: interaction.customId === 'suggest_down' ? `${count}` : `${embed.data.fields?.find(f => f.name === '👎')?.value || 0}`, inline: true };

      embed.spliceFields(0, embed.data.fields?.length || 0);
      embed.addFields(upField, downField);

      await interaction.update({ embeds: [embed] });
      return;
    }

    // --------------------------------------------
    // REVIEW BUTTONS (mods only)
    // --------------------------------------------
    if (!canReview(member)) {
      return interaction.reply({
        content: '❌ You are not allowed to review moderated messages.',
        flags: 64
      });
    }

    const [action, ...rest] = interaction.customId.split('_');
    const reviewId = rest.join('_'); // review id contains underscores

    if (!pendingReviews.has(reviewId)) {
      return interaction.reply({
        content: '⚠️ This review is no longer available.',
        flags: 64
      });
    }

    const reviewData = pendingReviews.get(reviewId);
    const targetChannel = interaction.guild.channels.cache.get(reviewData.channelId);

    if (!targetChannel) {
      pendingReviews.delete(reviewId);
      return interaction.reply({
        content: '⚠️ Original channel not found.',
        flags: 64
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
          flags: 64
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while processing that action.',
          flags: 64
        });
      }
    } catch {}
  }
});

client.login(process.env.TOKEN);