// index.js
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ActivityType
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} from '@discordjs/voice';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, LUKIFY_API } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !LUKIFY_API) {
  console.error('Missing one of DISCORD_TOKEN, CLIENT_ID, GUILD_ID or LUKIFY_API in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('🔑 Најава во Lukify')
    .addStringOption(opt => opt.setName('username').setDescription('Корисничко име').setRequired(true))
    .addStringOption(opt => opt.setName('password').setDescription('Лозинка').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('📻 Прикажи твоите најпуштани песни (или trending ако нема)'),
  new SlashCommandBuilder()
    .setName('trending')
    .setDescription('🔥 Прикажи најпуштаните песни од сите'),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('🔍 Пребарај песни по име или артист')
    .addStringOption(opt => opt.setName('query').setDescription('Термин за пребарување').setRequired(true)),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('▶️ Пушти песна по URL')
    .addStringOption(opt => opt.setName('url').setDescription('URL на песната').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log(`📡 Регистрирам команди за guild: ${GUILD_ID}`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Командите се регистрирани:', commands.map(c => c.name));
  } catch (err) {
    console.error('❌ Грешка при регистрација на команди:', err);
  }
}

// Audio + state
const audioPlayer = createAudioPlayer();
const songSessions = new Map(); // userId -> array of song objects (from API)
const userAuths = new Map();    // userId -> Basic auth header string ("Basic ...")

// Helper headers for user (includes Basic if logged-in)
function headersForUser(userId) {
  if (userAuths.has(userId)) {
    return { Accept: 'application/json', Authorization: userAuths.get(userId) };
  }
  return { Accept: 'application/json' };
}

// Safe fetch JSON
async function fetchJson(url, options = {}) {
  const safeUrl = encodeURI(url);
  const res = await fetch(safeUrl, options);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText} - ${txt}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * recordPlay(song, userId)
 * - Tries &action=plays first (as requested), then falls back to 'played' and 'record_play'.
 * - For each action tries GET first; if GET returns 4xx/5xx it will try POST with JSON body { song_id }.
 * - Uses user's Basic Auth header if present (so API increments played_by_you).
 * - If the API returns JSON with updated counters, updates the corresponding local songSessions entry.
 */
async function recordPlay(song, userId) {
  if (!song || !song.song_id) return false;

  const tryActions = ['plays', 'played', 'record_play'];
  const baseHeaders = headersForUser(userId);

  for (const action of tryActions) {
    const getUrl = `${LUKIFY_API}&action=${action}&song_id=${encodeURIComponent(song.song_id)}`;

    // Try GET
    try {
      const res = await fetch(encodeURI(getUrl), { method: 'GET', headers: baseHeaders });
      if (res.ok) {
        let json = null;
        try { json = await res.json(); } catch {}
        applyPlayUpdateFromResponse(song.song_id, userId, json);
        console.log(`recordPlay: success via GET action=${action} for song_id=${song.song_id}`);
        return true;
      } else {
        // If GET returned not ok, try POST below for the same action
        console.warn(`recordPlay GET action=${action} returned status ${res.status}`);
      }
    } catch (err) {
      console.warn(`recordPlay GET action=${action} failed:`, err.message || err);
    }

    // Try POST with JSON body (some APIs expect POST)
    try {
      const postUrl = `${LUKIFY_API}&action=${action}`;
      const headers = { ...baseHeaders, 'Content-Type': 'application/json' };
      const res = await fetch(encodeURI(postUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ song_id: song.song_id })
      });
      if (res.ok) {
        let json = null;
        try { json = await res.json(); } catch {}
        applyPlayUpdateFromResponse(song.song_id, userId, json);
        console.log(`recordPlay: success via POST action=${action} for song_id=${song.song_id}`);
        return true;
      } else {
        console.warn(`recordPlay POST action=${action} returned status ${res.status}`);
      }
    } catch (err) {
      console.warn(`recordPlay POST action=${action} failed:`, err.message || err);
    }
    // next action
  }

  console.warn(`recordPlay: all attempts failed for song_id=${song.song_id}`);
  return false;
}

// Update local session counters based on API response (or increment best-effort)
function applyPlayUpdateFromResponse(songId, userId, apiResponse) {
  const sessions = songSessions.get(userId);
  if (!sessions) return;

  const local = sessions.find(s => s.song_id === songId);
  if (!local) return;

  // If API returned explicit counters, use them
  if (apiResponse && typeof apiResponse === 'object') {
    // Try a few likely fields
    if (typeof apiResponse.played_by_all === 'number') local.played_by_all = apiResponse.played_by_all;
    if (typeof apiResponse.played_by_you === 'number') local.played_by_you = apiResponse.played_by_you;
    if (typeof apiResponse.played_count === 'number') local.played_by_all = apiResponse.played_count;
    // Some APIs might return nested results
    if (apiResponse.result && typeof apiResponse.result === 'object') {
      if (typeof apiResponse.result.played_by_all === 'number') local.played_by_all = apiResponse.result.played_by_all;
      if (typeof apiResponse.result.played_by_you === 'number') local.played_by_you = apiResponse.result.played_by_you;
    }
  } else {
    // Best-effort increment if no explicit response
    local.played_by_all = (typeof local.played_by_all === 'number') ? local.played_by_all + 1 : (local.played_by_all || 0) + 1;
    if (userAuths.has(userId)) {
      local.played_by_you = (typeof local.played_by_you === 'number') ? local.played_by_you + 1 : (local.played_by_you || 0) + 1;
    }
  }

  // Save back
  songSessions.set(userId, sessions);
}

// Play helpers
async function playSongDirect(interaction, songUrl, title, songObject = null) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '⚠️ Треба да бидеш во voice канал за да пуштаме песна.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // Try fetching stream first
  let streamRes;
  try {
    streamRes = await fetch(songUrl);
    if (!streamRes.ok) throw new Error(`Failed to fetch audio: ${streamRes.status}`);
  } catch (err) {
    console.error('Fetch song error:', err);
    await interaction.editReply('❌ Не можам да ја преземам песната (невалиден или блокиран URL).');
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator
  });

  const resource = createAudioResource(streamRes.body, { inputType: StreamType.Arbitrary });
  audioPlayer.play(resource);
  connection.subscribe(audioPlayer);

  try {
    await interaction.editReply({ content: `▶️ Сега пуштам: **${title || songUrl}**` });
  } catch {}

  // If we have song object with song_id, try record play (uses 'plays' first)
  if (songObject && songObject.song_id) {
    try {
      await recordPlay(songObject, interaction.user.id);
    } catch (err) {
      console.warn('recordPlay error:', err);
    }
  }

  const cleanup = () => {
    try { connection.destroy(); } catch {}
  };
  audioPlayer.once(AudioPlayerStatus.Idle, cleanup);
  audioPlayer.once('error', (err) => {
    console.error('Audio player error:', err);
    cleanup();
  });
}

async function playSongById(interaction, songId) {
  const list = songSessions.get(interaction.user.id);
  if (!list) {
    await interaction.reply({ content: '⚠️ Нема зачувана листа — користи /list, /trending или /search прво.', ephemeral: true });
    return;
  }
  const song = list.find(s => s.song_id === songId);
  if (!song) {
    await interaction.reply({ content: '⚠️ Песната не е пронајдена во последната листа.', ephemeral: true });
    return;
  }
  await playSongDirect(interaction, song.song_url, `${song.display_artist} — ${song.title}`, song);
}

// Build embeds (one per song)
function embedsFromSongs(title, songs) {
  return songs.map((song, i) => {
    const played = song.played_by_you ?? song.played_by_all ?? song.played_count ?? 0;
    return new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle(`${song.display_artist} — ${song.title}`)
      .setDescription(`▶️ ${played} пати`)
      .setThumbnail(song.cover_artwork_uri || null)
      .setFooter({ text: `${title} • ${i + 1}/${songs.length}` });
  });
}

// Interaction handler
client.on('interactionCreate', async (interaction) => {
  try {
    // /login
    if (interaction.isChatInputCommand() && interaction.commandName === 'login') {
      const username = interaction.options.getString('username');
      const password = interaction.options.getString('password');
      await interaction.deferReply({ ephemeral: true });

      const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      try {
        const testUrl = `${LUKIFY_API}&action=most_played_by_you`;
        const data = await fetchJson(testUrl, { headers: { Accept: 'application/json', Authorization: authHeader } });

        if (data?.summary?.authenticated_user) {
          userAuths.set(interaction.user.id, authHeader);
          const uname = (data.summary.authenticated_user?.username) ? data.summary.authenticated_user.username : data.summary.authenticated_user;
          await interaction.editReply(`✅ Успешно најавени како **${uname}**`);
        } else {
          await interaction.editReply('❌ Неуспешна најава — API не потврди автентикација.');
        }
      } catch (err) {
        console.error('Login test error:', err);
        await interaction.editReply('❌ Неуспешна најава (провери корисничко име/лозинка или API).');
      }
      return;
    }

    // /list -> most_played_by_you (fallback to trending)
    if (interaction.isChatInputCommand() && interaction.commandName === 'list') {
      await interaction.deferReply();
      try {
        const headers = headersForUser(interaction.user.id);
        const url = `${LUKIFY_API}&action=most_played_by_you`;
        const data = await fetchJson(url, { headers });

        let songs = data.most_played_by_all ?? [];
        if (!songs || songs.length === 0) {
          // fallback to trending (most_played_by_all)
          const trendingUrl = `${LUKIFY_API}&action=most_played_by_all`;
          const tdata = await fetchJson(trendingUrl, { headers: headersForUser(interaction.user.id) });
          songs = tdata.most_played_by_all ?? [];
          if (!songs || songs.length === 0) {
            await interaction.editReply('⚠️ Нема најдени песни (ни твои, ни trending).');
            return;
          }
        }

        const top = songs.slice(0, 5);
        const embeds = embedsFromSongs('Топ', top);
        const options = top.map(s => ({
          label: `${s.display_artist} — ${s.title}`.slice(0, 100),
          description: `▶️ ${s.played_by_you ?? s.played_by_all ?? 0} пати`.slice(0, 100),
          value: s.song_id
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('song_select')
            .setPlaceholder('Избери песна за слушање...')
            .addOptions(options)
        );

        await interaction.editReply({ embeds, components: [row] });
        songSessions.set(interaction.user.id, top);
      } catch (err) {
        console.error('List error:', err);
        await interaction.editReply('❌ Грешка при земање на листата.');
      }
      return;
    }

    // /trending -> most_played_by_all
    if (interaction.isChatInputCommand() && interaction.commandName === 'trending') {
      await interaction.deferReply();
      try {
        const url = `${LUKIFY_API}&action=most_played_by_all`;
        const data = await fetchJson(url, { headers: headersForUser(interaction.user.id) });

        const songs = data.most_played_by_all ?? [];
        if (!songs || songs.length === 0) {
          await interaction.editReply('⚠️ Нема trending песни.');
          return;
        }

        const top = songs.slice(0, 5);
        const embeds = embedsFromSongs('Trending', top);
        const options = top.map(s => ({
          label: `${s.display_artist} — ${s.title}`.slice(0, 100),
          description: `▶️ ${s.played_by_all ?? 0} пати`.slice(0, 100),
          value: s.song_id
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('song_select')
            .setPlaceholder('Избери песна за слушање...')
            .addOptions(options)
        );

        await interaction.editReply({ embeds, components: [row] });
        songSessions.set(interaction.user.id, top);
      } catch (err) {
        console.error('Trending error:', err);
        await interaction.editReply('❌ Грешка при враќање на trending.');
      }
      return;
    }

    // /search
    if (interaction.isChatInputCommand() && interaction.commandName === 'search') {
      const query = interaction.options.getString('query');
      await interaction.deferReply();
      try {
        const url = `${LUKIFY_API}&action=search&search=${encodeURIComponent(query)}`;
        const data = await fetchJson(url, { headers: headersForUser(interaction.user.id) });

        const results = data.search_results ?? [];
        if (results.length === 0) {
          await interaction.editReply(`⚠️ Не се најдоа резултати за **${query}**.`);
          return;
        }

        const top = results.slice(0, 5);
        const embeds = embedsFromSongs(`Search: ${query}`, top);
        const options = top.map(s => ({
          label: `${s.display_artist} — ${s.title}`.slice(0, 100),
          description: `▶️ ${s.played_by_all ?? 0} пати`.slice(0, 100),
          value: s.song_id
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('song_select')
            .setPlaceholder('Избери песна за слушање...')
            .addOptions(options)
        );

        await interaction.editReply({ embeds, components: [row] });
        songSessions.set(interaction.user.id, top);
      } catch (err) {
        console.error('Search error:', err);
        await interaction.editReply('❌ Грешка при пребарување.');
      }
      return;
    }

    // /play (direct URL)
    if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
      const url = interaction.options.getString('url');
      await playSongDirect(interaction, url, url);
      return;
    }

    // select menu handler
    if (interaction.isStringSelectMenu() && interaction.customId === 'song_select') {
      const songId = interaction.values[0];
      await playSongById(interaction, songId);
      return;
    }

  } catch (err) {
    console.error('Unhandled interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply('❌ Внатрешна грешка при обработка.'); } catch {}
    } else {
      try { await interaction.reply({ content: '❌ Внатрешна грешка при обработка.', ephemeral: true }); } catch {}
    }
  }
});

// Presence: use clientReady to avoid deprecation warnings in v15
client.once('clientReady', () => {
  console.log(`🤖 Bot е online! Логиран како ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'Lukify Music', type: ActivityType.Listening }],
    status: 'online'
  });
});

// start
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
