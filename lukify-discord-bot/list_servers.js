import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const { DISCORD_TOKEN } = process.env;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`🤖 Bot е online! Логиран како ${client.user.tag}`);

  console.log('📜 Листата на сервери каде е ботот:');
  client.guilds.cache.forEach(guild => {
    console.log(`- ${guild.name} (ID: ${guild.id})`);
  });
});

client.login(DISCORD_TOKEN);
