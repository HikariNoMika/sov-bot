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
const tttGames = new Map();
const rpsGames = new Map();
const WINNERS_PATH = path.join(__dirname, 'winners.json');

function loadWinners() {
  try {
    if (fs.existsSync(WINNERS_PATH)) return JSON.parse(fs.readFileSync(WINNERS_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveWinners(data) {
  fs.writeFileSync(WINNERS_PATH, JSON.stringify(data, null, 2));
}

const serverRules = config.serverRules;

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
  currentRound: 1,
  roundOverrides: {},
  roundStartTimes: [],
  timers: []
};

function cocSaveState() {
  const data = {
    type: cocWar.type,
    phase: cocWar.phase,
    startedAt: cocWar.startedAt,
    prepEndsAt: cocWar.prepEndsAt,
    battleEndsAt: cocWar.battleEndsAt,
    guildId: cocWar.guildId,
    currentRound: cocWar.currentRound,
    roundOverrides: cocWar.roundOverrides,
    roundStartTimes: cocWar.roundStartTimes
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
      if (cocWar.type === 'cwl' && !cocWar.roundStartTimes.length) cocCalcRoundStartTimes();
      console.log(`🔄 Resumed ${cocWar.type} war (${cocWar.phase} phase)`);
    }
  } catch (e) {
    console.log('Could not load saved war state:', e.message);
  }
}

function cocClearState() {
  cocWar.type = null;
  cocWar.phase = null;
  cocWar.startedAt = null;
  cocWar.prepEndsAt = null;
  cocWar.battleEndsAt = null;
  cocWar.guildId = null;
  cocWar.currentRound = 1;
  cocWar.roundOverrides = {};
  cocWar.roundStartTimes = [];
  try { fs.unlinkSync(COC_STATE_PATH); } catch {}
}

// Load state on startup
cocLoadState();

function cocSend(guild, content) {
  const channels = [config.cocChannelId, config.generalChannelId].filter(Boolean);
  if (!channels.length) return console.log('cocSend: no channels configured');
  for (const id of new Set(channels)) {
    const ch = guild.channels.cache.get(id);
    if (ch) {
      ch.send(content).catch(e => console.log('cocSend error to', id, ':', e.message));
    } else {
      console.log('cocSend: channel not found in cache:', id);
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

    // Prep-phase countdown
    const prepRemaining = (label, msBefore) => {
      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `📅 **${label} of preparation remaining!** Get your war bases ready!`);
      }, t(cocWar.prepEndsAt - Date.now() - msBefore)));
    };
    prepRemaining('6 hours', 6 * HOUR);
    prepRemaining('1 hour', HOUR);
    prepRemaining('30 minutes', 30 * 60 * 1000);
    prepRemaining('10 minutes', 10 * 60 * 1000);

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

    // 10m remaining
    cocWar.timers.push(setTimeout(() => {
      cocSend(guild, `🔴 **10 minutes left!** Attack now, the war is almost over!`);
    }, t(cocWar.battleEndsAt - Date.now() - 10 * 60 * 1000)));

    // War over
    cocWar.timers.push(setTimeout(() => {
      cocClearState();
      cocSend(guild, `🏁 **The war has ended!** Great effort, clan!`);
    }, t(cocWar.battleEndsAt - Date.now())));

  } else if (cocWar.type === 'cwl') {
    const roundDuration = DAY;
    if (!cocWar.roundStartTimes.length) cocCalcRoundStartTimes();

    const prepDelay = cocWar.prepEndsAt - Date.now();
    if (prepDelay <= 0 && cocWar.phase === 'preparation') {
      cocWar.phase = 'battle';
      cocWar.currentRound = 1;
    }
    cocWar.timers.push(setTimeout(() => {
      cocWar.phase = 'battle';
      cocWar.currentRound = 1;
      cocSend(guild, `⚔️ **CWL Round 1 has started!** Attack and earn stars for the clan!`);
    }, t(prepDelay)));

    // CWL prep-phase countdown
    const prepRemainingCwl = (label, msBefore) => {
      cocWar.timers.push(setTimeout(() => {
        cocSend(guild, `📅 **${label} of preparation remaining!** Get your war bases ready!`);
      }, t(cocWar.prepEndsAt - Date.now() - msBefore)));
    };
    prepRemainingCwl('6 hours', 6 * HOUR);
    prepRemainingCwl('1 hour', HOUR);
    prepRemainingCwl('30 minutes', 30 * 60 * 1000);
    prepRemainingCwl('10 minutes', 10 * 60 * 1000);

    for (let round = 2; round <= 7; round++) {
      const roundStart = cocWar.roundStartTimes[round];
      const roundDelay = roundStart - Date.now();
      if (roundDelay > 0) {
        cocWar.timers.push(setTimeout(() => {
          cocWar.currentRound = round;
          cocSaveState();
          cocSend(guild, `⚔️ **CWL Round ${round} has started!** Get your attacks in!`);
        }, t(roundDelay)));

        cocWar.timers.push(setTimeout(() => {
          cocSend(guild, `⏰ **CWL Round ${round} - 6 hours left!** Don't forget to attack!`);
        }, t(roundStart + 18 * HOUR - Date.now())));
      }
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
  if (minutes > 0) str += `${minutes}m`;
  return str.trim();
}

function cocCalcRoundStartTimes() {
  const rd = DAY;
  cocWar.roundStartTimes = [null];
  cocWar.roundStartTimes[1] = cocWar.prepEndsAt;
  for (let r = 2; r <= 7; r++) {
    if (cocWar.roundOverrides && cocWar.roundOverrides[r]) {
      cocWar.roundStartTimes[r] = cocWar.roundOverrides[r];
    } else {
      cocWar.roundStartTimes[r] = cocWar.roundStartTimes[r - 1] + rd;
    }
  }
  cocWar.battleEndsAt = cocWar.roundStartTimes[7] + rd;
  cocSaveState();
}

function cocCurrentRound() {
  const now = Date.now();
  if (cocWar.phase === 'preparation') return 0;
  for (let r = 7; r >= 1; r--) {
    if (now >= cocWar.roundStartTimes[r]) return r;
  }
  return 1;
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
    Array.isArray(config.moderatorRoleIds)
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
      `We're glad to have you here. Use the buttons below to get started.\n\n` +
      `⚠️ **No chatting in this channel** — welcomes and commands only. Go to <#${config.generalChannelId}> for discussions.`
    )
    .addFields({
      name: '📌 Quick Tips',
      value:
        '• Click **👋 Welcome** to greet the new member\n' +
        '• Click **📜 Rules** to see the server rules\n' +
        '• Click **📁 Channels** to see channel guides\n' +
        '• Click **🆘 Help** if you need assistance'
    })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`welcome_say_${member.id}`)
      .setLabel('👋 Welcome')
      .setStyle(ButtonStyle.Success),
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
    if (member.user.bot) return;

    const approvalChannel = member.guild.channels.cache.get(config.approvalChannelId);
    if (!approvalChannel) {
      console.log('❌ Approval channel not found.');
      return;
    }

    // Assign restricted role
    if (config.guestRoleId) {
      const role = member.guild.roles.cache.get(config.guestRoleId);
      if (role) await member.roles.add(role).catch(e => console.log('Role assign error:', e.message));
    }

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setTitle('📥 New Member')
      .setDescription(`<@${member.id}> joined the server.`)
      .addFields(
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Joined', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${member.id}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`deny_${member.id}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

    await approvalChannel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Member approval error:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    if (member.user.bot) return;

    const approvalChannel = member.guild.channels.cache.get(config.approvalChannelId);
    if (!approvalChannel) {
      console.log('❌ Approval channel not found for leave notification.');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setTitle('🚪 Member Left')
      .setDescription(`<@${member.id}> left the server.`)
      .addFields(
        { name: 'Joined', value: member.joinedAt ? `<t:${Math.floor(member.joinedAt / 1000)}:R>` : 'Unknown', inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
      )
      .setTimestamp();

    await approvalChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Member leave notification error:', err);
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

    // No-chat enforcement in welcome and prize claim channels
    if (config.welcomeChannelId && message.channel.id === config.welcomeChannelId) {
      if (!message.content.startsWith('!')) {
        await message.delete();
        const warn = await message.channel.send(`⚠️ ${message.author}, this channel is for welcomes and commands only. No chatting. Go to <#${config.generalChannelId}> for discussions.`);
        setTimeout(() => warn.delete().catch(() => {}), 5000);
        return;
      }
    }
    if (config.prizeClaimChannelId && message.channel.id === config.prizeClaimChannelId) {
      if (!message.content.startsWith('!')) {
        if (canReview(message.member)) return;
        const winners = loadWinners();
        const isWinner = winners.some(w => w.userId === message.author.id);
        if (!isWinner) {
          await message.delete();
          const warn = await message.channel.send(`⚠️ ${message.author}, this channel is for prize claims only. No chatting. Go to <#${config.generalChannelId}> for discussions.`);
          setTimeout(() => warn.delete().catch(() => {}), 5000);
          return;
        }
      }
    }

    // Mod-only channels (no chatting, but commands and media/files allowed)
    const modOnlyChannels = Array.isArray(config.modOnlyChannels) ? config.modOnlyChannels : [];
    if (modOnlyChannels.includes(message.channel.id)) {
      if (!message.content.startsWith('!') && !canReview(message.member) && !message.attachments.size) {
        await message.delete();
        const warn = await message.channel.send(`⚠️ ${message.author}, only moderators can chat here. You may post media/files. Go to <#${config.generalChannelId}> for discussions.`);
        setTimeout(() => warn.delete().catch(() => {}), 5000);
        return;
      }
    }

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
          { name: '💰 **GCash**', value:
            '`!winner add @user1 @user2 [reason]` — Record winner(s) (mods)\n' +
            '`!winner list` — Recent winners\n' +
            '`!winner clear` — Clear all (mods)\n' +
            '`!event <name> [description]` — Post event announcement (mods)',
            inline: false },
          { name: '🎮 **Games**', value:
            '`!ttt @user` — Tic Tac Toe\n' +
            '`!rps @user` — Rock Paper Scissors\n' +
            '`!pogi` — Random member picker',
            inline: false },
          { name: '📊 **Community**', value:
            '`!poll <question>` — Create a yes/no poll\n' +
            '`!suggest <idea>` — Submit a suggestion',
            inline: false },
          { name: '🏰 **CoC War**', value:
            '`!coc status` — Current war timer\n' +
            '`!coc start war [time]` — Start normal war (mods)\n' +
            '`!coc start cwl` — Start CWL season (mods)\n' +
            '`!cwl day<N> HH:MM` — Override CWL round start (mods)\n' +
            '`!cwl status` — Show CWL round schedule\n' +
            '`!coc cancel` — Stop war timer (mods)\n' +
            '`!coc end` — Mark war ended (mods)\n' +
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
        const words = config.badWords.length
          ? config.badWords.map((w, i) => `\`${i + 1}.\` ||${w}||`).join('\n')
          : 'None';
        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setAuthor({ name: 'Auto-Moderation' })
          .setTitle('🚫 Filtered Words')
          .setDescription(words)
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
    // GCASH WINNER TRACKER
    // --------------------------------------------
    if (content.startsWith('!winner ')) {
      if (!canReview(message.member)) {
        await message.channel.send('❌ You need the **Sov** role or Admin permissions to use this command.');
        return;
      }

      const args = content.slice(8).trim().split(/\s+/);
      const action = args[0];

      if (action === 'add') {
        const members = message.mentions.members;
        if (!members.size) {
          await message.channel.send('⚠️ Mention at least one user. Usage: `!winner add @user1 @user2 [reason]`');
          return;
        }

        const lastMention = [...members.values()][members.size - 1];
        const mentionRaw = message.content.match(new RegExp(`<@!?${lastMention.id}>`))?.[0];
        const afterLastMention = mentionRaw ? message.content.split(mentionRaw).pop() || '' : '';
        const reason = afterLastMention.trim() || 'Event winner';
        const proof = message.attachments.first()?.url || 'No proof';

        const winners = loadWinners();
        const added = [];
        members.forEach(m => {
          winners.push({
            userId: m.id,
            userTag: m.user.tag,
            reason,
            proof,
            addedBy: message.author.tag,
            date: new Date().toISOString()
          });
          added.push(m.user.tag);
        });
        saveWinners(winners);

        const claimChannel = config.prizeClaimChannelId ? message.guild.channels.cache.get(config.prizeClaimChannelId) : message.channel;
        const mentions = members.map(m => `<@${m.id}>`).join(' ');
        await claimChannel.send(
          `🎉 **Prize Claim**\n${mentions}\n\nYou won the event! Please provide your **GCash number and full name** below.\n_Event: ${reason}_`
        );

        // Individual confirmation embeds for each winner
        for (const m of members.values()) {
          try {
            const avatar = m.user.displayAvatarURL();
            const confirmEmbed = new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('✅ Winner Recorded')
              .setDescription(`${m.user.tag} added as winner`)
              .setThumbnail(avatar)
              .addFields(
                { name: 'Event', value: reason, inline: true },
                { name: 'Recorded by', value: message.author.tag, inline: true }
              )
              .setTimestamp();

            await message.channel.send({ embeds: [confirmEmbed] });
          } catch (e) {
            console.error('Failed to send winner card for', m.user.tag, e.message);
          }
        }

      } else if (action === 'list') {
        const winners = loadWinners();
        if (!winners.length) {
          await message.channel.send('📭 No winners recorded yet.');
          return;
        }

        const recent = winners.slice(-10).reverse();
        const embeds = recent.map((w, i) => {
          const displayTag = w.userTag ? w.userTag.split('#')[0] : 'Unknown';
          return new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle(`🏆 Winner`)
            .setThumbnail(message.guild.members.cache.get(w.userId)?.user.displayAvatarURL() || null)
            .addFields(
              { name: 'Player', value: `<@${w.userId}>`, inline: true },
              { name: 'Reason', value: w.reason || 'Event winner', inline: true },
              { name: 'Recorded by', value: w.addedBy || 'Unknown', inline: true }
            )
            .setFooter({ text: `Winner ${i + 1} of ${recent.length}` });
        });

        await message.channel.send({ embeds });

      } else if (action === 'clear') {
        const winners = loadWinners();
        const count = winners.length;
        saveWinners([]);
        try {
          await message.channel.send(`✅ Cleared **${count}** winner(s).`);
        } catch (e) {
          console.error('Clear notification failed:', e.message);
        }

      } else {
        await message.channel.send(
          '**Winner Commands:**\n' +
          '`!winner add @user1 @user2 [reason]` — Record winner(s) (mods, attach proof)\n' +
          '`!winner list` — Show recent winners\n' +
          '`!winner clear` — Clear all winners (mods)'
        );
      }
      return;
    }
    if (content.startsWith('!event ')) {
      if (!canReview(message.member)) return;

      const text = content.slice(7).trim();
      const parts = text.split(/ (.+)/);
      const name = parts[0];
      const description = parts[1] || '';

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🎉 ' + name)
        .setDescription(description || 'Get ready!')
        .addFields({ name: 'Posted by', value: message.author.toString() });

      const eventChannel = config.prizeClaimChannelId ? message.guild.channels.cache.get(config.prizeClaimChannelId) : message.channel;
      await eventChannel.send({ embeds: [embed] });
      if (eventChannel.id !== message.channel.id) {
        await message.channel.send('✅ Event posted in <#' + eventChannel.id + '>');
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

        let prepMs = 23 * HOUR;
        if (args[2]) {
          const timeMatch = args[2].match(/^(\d{1,2}):(\d{2})$/);
          if (timeMatch) {
            prepMs = parseInt(timeMatch[1]) * HOUR + parseInt(timeMatch[2]) * 60000;
          } else {
            const durMatch = args[2].match(/^(\d+)(h|m|d)$/);
            if (durMatch) {
              let hours = parseInt(durMatch[1]);
              if (durMatch[2] === 'm') hours /= 60;
              else if (durMatch[2] === 'd') hours *= 24;
              prepMs = hours * HOUR;
            } else {
              await message.channel.send('⚠️ Invalid format. Use e.g. `!coc start war 23h`, `!coc start war 90m`, `!coc start war 23:30`');
              return;
            }
          }
        }
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
        cocWar.currentRound = 0;
        cocWar.startedAt = now;
        cocWar.prepEndsAt = now + DAY;
        cocWar.roundOverrides = {};
        cocCalcRoundStartTimes();
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
          );

        if (cocWar.type === 'cwl') {
          const round = cocCurrentRound();
          embed.addFields({ name: '🔄 Current Round', value: round === 0 ? 'Prep' : `Round ${round}`, inline: true });
          if (cocWar.roundStartTimes.length) {
            let schedule = '';
            for (let r = 1; r <= 7; r++) {
              const start = cocWar.roundStartTimes[r];
              const marker = r === round ? '**▶' : '';
              const end = r === round ? '◀**' : '';
              const label = cocWar.roundOverrides[r] ? `~R${r}` : `R${r}`;
              schedule += `${marker}${label}: <t:${Math.floor(start / 1000)}:t>${end}\n`;
            }
            embed.addFields({ name: '📋 Round Schedule', value: schedule.trim(), inline: false });
          }
        }

        embed.setFooter({ text: `Started` }).setTimestamp(cocWar.startedAt);

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

      } else if (args[0] === 'end') {
        if (!cocWar.phase || cocWar.phase === 'ended') {
          await message.channel.send('📭 No ongoing war to end.');
          return;
        }

        cocWar.timers.forEach(clearTimeout);
        cocWar.timers = [];
        cocClearState();

        await message.channel.send('🏁 War ended manually.');
        cocSend(message.guild, `🏁 **The war has ended!** Great effort, clan!`);

      } else {
        await message.channel.send(
          '**CoC Commands:**\n' +
          '`!coc status` - Check war status (everyone)\n' +
          '`!coc commands` - Show this list (everyone)\n' +
          '`!coc start war [time]` - Start normal war (mods only)\n' +
          '`!coc start war 23:30` - With custom prep time (23h 30m)\n' +
          '`!coc start cwl` - Start CWL (mods only)\n' +
          '`!cwl day<N> HH:MM` - Override CWL round time (mods)\n' +
          '`!cwl status` - Show CWL round schedule\n' +
          '`!coc cancel` - Cancel current war (mods only)\n' +
          '`!coc end` - Mark war as ended (mods only)'
        );
      }
      return;
    }

    // --------------------------------------------
    // CWL ROUND OVERRIDES
    // --------------------------------------------
    if (content.startsWith('!cwl ') && canReview(message.member)) {
      const args = content.slice(5).trim().split(/\s+/);

      if (args[0] === 'status') {
        if (cocWar.type !== 'cwl') {
          await message.channel.send('📭 No ongoing CWL season. Start one with `!coc start cwl`.');
          return;
        }
        const now = Date.now();
        const round = cocCurrentRound();
        const lines = [];
        for (let r = 1; r <= 7; r++) {
          const start = cocWar.roundStartTimes[r];
          const marker = r === round ? '▶ ' : '  ';
          const overridden = cocWar.roundOverrides[r] ? ' (overridden)' : '';
          const status = now >= start ? '✅' : '⏳';
          lines.push(`${marker}Round ${r}: ${status} <t:${Math.floor(start / 1000)}:t>${overridden}`);
        }
        await message.channel.send(`**📋 CWL Round Schedule**\n${lines.join('\n')}`);
        return;
      }

      const dayMatch = args[0] && args[0].match(/^day(\d)$/i);
      if (dayMatch) {
        const round = parseInt(dayMatch[1]);
        if (round < 1 || round > 7) {
          await message.channel.send('⚠️ Round must be 1-7.');
          return;
        }

        if (!args[1]) {
          await message.channel.send('⚠️ Specify time, e.g. `!cwl day2 22:58`.');
          return;
        }

        const timeMatch = args[1].match(/^(\d{1,2}):(\d{2})$/);
        if (!timeMatch) {
          await message.channel.send('⚠️ Invalid time. Use `HH:MM` format, e.g. `!cwl day2 22:58`.');
          return;
        }

        if (cocWar.type !== 'cwl') {
          await message.channel.send('📭 No ongoing CWL season. Start one with `!coc start cwl`.');
          return;
        }

        if (round <= cocCurrentRound()) {
          await message.channel.send(`⚠️ Round ${round} has already started or ended. Cannot override.`);
          return;
        }

        const target = new Date();
        target.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
        if (target <= new Date()) target.setDate(target.getDate() + 1);

        // Check it doesn't overlap with previous round
        const prevEnd = cocWar.roundStartTimes[round - 1] + DAY;
        if (target.getTime() < prevEnd) {
          await message.channel.send(`⚠️ Round ${round} cannot start before previous round ends (${new Date(prevEnd).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}).`);
          return;
        }

        cocWar.roundOverrides[round] = target.getTime();
        cocCalcRoundStartTimes();
        cocScheduleNotifications(message.guild);

        await message.channel.send(`✅ **Round ${round}** overridden to start at **${args[1]}**.`);
        return;
      }

      await message.channel.send('Usage: `!cwl day<N> HH:MM` or `!cwl status`');
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
      if (config.gamesChannelId && message.channel.id !== config.gamesChannelId) {
        await message.channel.send(`🎮 Please use this in <#${config.gamesChannelId}>!`);
        return;
      }
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
    // TIC TAC TOE
    // --------------------------------------------
    if (content.startsWith('!ttt ')) {
      if (config.gamesChannelId && message.channel.id !== config.gamesChannelId) {
        await message.channel.send(`🎮 Please use this in <#${config.gamesChannelId}>!`);
        return;
      }
      const opponent = message.mentions.members.first();
      if (!opponent || opponent.user.bot || opponent.id === message.author.id) {
        await message.channel.send('⚠️ Mention another member to play. Usage: `!ttt @user`');
        return;
      }

      const gameId = `${message.author.id}_${opponent.id}_${Date.now()}`;
      const board = Array(9).fill(null);
      const game = {
        board,
        players: { x: message.author.id, o: opponent.id },
        names: { x: message.author.username, o: opponent.user.username },
        turn: 'x',
        message: null
      };
      tttGames.set(gameId, game);

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('❌ Tic Tac Toe ⭕')
        .setDescription(`**${message.author.username}** (X) vs **${opponent.user.username}** (O)\n\nTurn: <@${message.author.id}>`)
        .setFooter({ text: 'Click a button to place your mark' });

      const row1 = new ActionRowBuilder();
      const row2 = new ActionRowBuilder();
      const row3 = new ActionRowBuilder();
      for (let i = 0; i < 9; i++) {
        const btn = new ButtonBuilder()
          .setCustomId(`ttt_${gameId}_${i}`)
          .setLabel('⬜')
          .setStyle(ButtonStyle.Secondary);
        if (i < 3) row1.addComponents(btn);
        else if (i < 6) row2.addComponents(btn);
        else row3.addComponents(btn);
      }

      const sent = await message.channel.send({ embeds: [embed], components: [row1, row2, row3] });
      game.message = sent;

      // Clean up after 5 minutes
      setTimeout(() => {
        if (tttGames.has(gameId)) {
          tttGames.delete(gameId);
          sent.edit({ components: [] }).catch(() => {});
        }
      }, 300000);
      return;
    }

    // --------------------------------------------
    // ROCK PAPER SCISSORS
    // --------------------------------------------
    if (content.startsWith('!rps ')) {
      if (config.gamesChannelId && message.channel.id !== config.gamesChannelId) {
        await message.channel.send(`🎮 Please use this in <#${config.gamesChannelId}>!`);
        return;
      }
      const opponent = message.mentions.members.first();
      if (!opponent || opponent.user.bot || opponent.id === message.author.id) {
        await message.channel.send('⚠️ Mention someone to play. Usage: `!rps @user`');
        return;
      }

      const rpsId = `${message.author.id}_${opponent.id}_${Date.now()}`;
      rpsGames.set(rpsId, {
        players: { 1: message.author.id, 2: opponent.id },
        choices: {},
        turn: 1
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🪨 Rock Paper Scissors ✂️')
        .setDescription(`<@${message.author.id}> challenges <@${opponent.id}>!\n\nMake your choice using the buttons below.`)
        .setFooter({ text: 'Both players pick in secret, then results are revealed!' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rps_${rpsId}_1_rock`).setLabel('🪨 Rock').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rps_${rpsId}_1_paper`).setLabel('📄 Paper').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rps_${rpsId}_1_scissors`).setLabel('✂️ Scissors').setStyle(ButtonStyle.Secondary)
      );

      const sent = await message.channel.send({ embeds: [embed], components: [row] });

      setTimeout(() => {
        rpsGames.delete(rpsId);
        sent.edit({ components: [] }).catch(() => {});
      }, 120000);

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
          { name: '💰 **GCash**', value: '`!winner add` (mods) · `!winner list` · `!event` (mods)' },
          { name: '🎮 **Games**', value: '`!ttt` · `!rps` · `!pogi`' },
          { name: '📊 **Community**', value: '`!poll` · `!suggest`' },
          { name: '🏰 **CoC War**', value: '`!coc status` · `!coc start war` (mods) · `!coc start cwl` (mods) · `!cwl day<N> HH:MM` (mods) · `!coc cancel` (mods) · `!coc end` (mods)' }
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
    if (interaction.customId.startsWith('welcome_say_')) {
      const newMemberId = interaction.customId.split('_')[2];
      await interaction.reply({
        content: `👋 ${interaction.user} warmly welcomed <@${newMemberId}>!`,
        allowedMentions: { users: [] }
      });
      return;
    }

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
    // MEMBER APPROVAL BUTTONS
    // --------------------------------------------
    if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_')) {
      if (!canReview(interaction.member)) {
        return interaction.reply({ content: '❌ Only moderators can approve or deny members.', flags: 64 });
      }

      const targetId = interaction.customId.split('_')[1];
      const target = interaction.guild.members.cache.get(targetId);
      if (!target) {
        return interaction.reply({ content: '⚠️ That member is no longer in the server.', flags: 64 });
      }

      const isApprove = interaction.customId.startsWith('approve_');

      const disabledRow = new ActionRowBuilder().addComponents(
        interaction.message.components[0].components.map(b =>
          ButtonBuilder.from(b).setDisabled(true)
        )
      );

      if (isApprove) {
        if (config.guestRoleId) {
          const guestRole = interaction.guild.roles.cache.get(config.guestRoleId);
          if (guestRole && target.roles.cache.has(config.guestRoleId)) {
            await target.roles.remove(guestRole).catch(e => console.log('Role remove error:', e.message));
          }
        }
        if (config.memberRoleId) {
          const memberRole = interaction.guild.roles.cache.get(config.memberRoleId);
          if (memberRole) await target.roles.add(memberRole).catch(e => console.log('Role add error:', e.message));
        }

        await interaction.update({
          embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x57F287).setTitle('✅ Approved')],
          components: [disabledRow]
        });
        await interaction.followUp({ content: `✅ <@${targetId}> has been approved.`, flags: 64 });
      } else {
        await target.kick('Denied by moderator').catch(e => console.log('Kick error:', e.message));
        await interaction.update({
          embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xED4245).setTitle('❌ Denied')],
          components: [disabledRow]
        });
        await interaction.followUp({ content: `❌ <@${targetId}> has been denied and removed.`, flags: 64 });
      }
      return;
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
    // TIC TAC TOE BUTTONS
    // --------------------------------------------
    if (interaction.customId.startsWith('ttt_')) {
      const parts = interaction.customId.split('_');
      const gameId = parts.slice(1, -1).join('_');
      const idx = parseInt(parts[parts.length - 1]);
      const game = tttGames.get(gameId);

      if (!game) {
        return interaction.reply({ content: '⚠️ This game has expired.', flags: 64 });
      }

      if (game.board[idx] !== null) {
        return interaction.reply({ content: '⚠️ That spot is already taken!', flags: 64 });
      }

      const currentPlayerId = game.players[game.turn];
      if (interaction.user.id !== currentPlayerId) {
        return interaction.reply({ content: '❌ Not your turn!', flags: 64 });
      }

      game.board[idx] = game.turn;

      // Win check
      const winPatterns = [
        [0,1,2], [3,4,5], [6,7,8],
        [0,3,6], [1,4,7], [2,5,8],
        [0,4,8], [2,4,6]
      ];
      let winner = null;
      for (const [a,b,c] of winPatterns) {
        if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
          winner = game.board[a];
          break;
        }
      }

      const draw = !winner && game.board.every(c => c !== null);
      const over = !!(winner || draw);

      let desc;
      if (winner) {
        const xLabel = '❌ X';
        const oLabel = '⭕ O';
        const winnerName = game.names[winner];
        desc = `**${winnerName} (${winner.toUpperCase()}) wins!** 🎉\n\n${game.names.x} ${xLabel} vs ${game.names.o} ${oLabel}`;
      } else if (draw) {
        desc = `It's a draw! 🤝\n\n${game.names.x} ❌ vs ${game.names.o} ⭕`;
      } else {
        game.turn = game.turn === 'x' ? 'o' : 'x';
        desc = `Turn: <@${game.players[game.turn]}>`;
      }

      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setDescription(desc);

      const labels = { x: '❌', o: '⭕', null: '⬜' };
      const rows = [new ActionRowBuilder(), new ActionRowBuilder(), new ActionRowBuilder()];
      for (let i = 0; i < 9; i++) {
        const val = game.board[i];
        const btn = new ButtonBuilder()
          .setCustomId(`ttt_${gameId}_${i}`)
          .setLabel(labels[val] || '⬜')
          .setStyle(val ? ButtonStyle.Secondary : (over ? ButtonStyle.Secondary : ButtonStyle.Primary))
          .setDisabled(over || val !== null);
        if (i < 3) rows[0].addComponents(btn);
        else if (i < 6) rows[1].addComponents(btn);
        else rows[2].addComponents(btn);
      }

      if (over) tttGames.delete(gameId);
      await interaction.update({ embeds: [embed], components: over ? [] : rows });
      return;
    }

    // --------------------------------------------
    // ROCK PAPER SCISSORS BUTTONS
    // --------------------------------------------
    if (interaction.customId.startsWith('rps_')) {
      const parts = interaction.customId.split('_');
      const rpsId = parts.slice(1, -2).join('_');
      const turn = parseInt(parts[parts.length - 2]);
      const choice = parts[parts.length - 1];
      const game = rpsGames.get(rpsId);

      if (!game) {
        return interaction.reply({ content: '⚠️ This game has expired.', flags: 64 });
      }

      if (interaction.user.id !== game.players[turn]) {
        return interaction.reply({ content: '❌ It\'s not your turn to pick.', flags: 64 });
      }

      game.choices[turn] = choice;

      if (turn === 1) {
        game.turn = 2;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rps_${rpsId}_2_rock`).setLabel('🪨 Rock').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rps_${rpsId}_2_paper`).setLabel('📄 Paper').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rps_${rpsId}_2_scissors`).setLabel('✂️ Scissors').setStyle(ButtonStyle.Secondary)
        );

        const embed = EmbedBuilder.from(interaction.message.embeds[0])
          .setDescription(`<@${game.players[1]}> has chosen! Now it's <@${game.players[2]}>'s turn.`);

        await interaction.update({ embeds: [embed], components: [row] });
      } else {
        const p1choice = game.choices[1];
        const p2choice = game.choices[2];
        const p1id = game.players[1];
        const p2id = game.players[2];

        const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
        let result;
        if (p1choice === p2choice) {
          result = `🤝 **It's a draw!** Both chose ${p1choice}.`;
        } else if (beats[p1choice] === p2choice) {
          result = `<@${p1id}> wins! 🎉`;
        } else {
          result = `<@${p2id}> wins! 🎉`;
        }

        const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
          .setDescription(
            `${emojis[p1choice]} <@${p1id}> chose **${p1choice}**\n` +
            `${emojis[p2choice]} <@${p2id}> chose **${p2choice}**\n\n` +
            `**${result}**`
          );

        rpsGames.delete(rpsId);
        await interaction.update({ embeds: [embed], components: [] });
      }
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