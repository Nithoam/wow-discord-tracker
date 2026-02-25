import 'dotenv/config';

import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { commands, handleCommand } from './commands';
import Tracker from './tracker';

// Validation des variables d'environnement requises
const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_CHANNEL_ID',
  'BLIZZARD_CLIENT_ID',
  'BLIZZARD_CLIENT_SECRET',
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Variable d'environnement manquante : ${key}`);
    console.error(`Copie .env.example vers .env et remplis les valeurs.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const tracker = new Tracker(client);

// Enregistrement des slash commands au démarrage
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

  try {
    console.log('[Bot] Enregistrement des slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, process.env.DISCORD_GUILD_ID!),
      { body: commands.map((c) => c.toJSON()) }
    );
    console.log('[Bot] Slash commands enregistrées.');
  } catch (err) {
    console.error('[Bot] Erreur enregistrement commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`[Bot] Connecté en tant que ${client.user!.tag}`);
  await registerCommands();
  tracker.start();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction, tracker);
  } catch (err) {
    console.error('[Bot] Erreur commande:', err);
    const reply = { content: 'Une erreur est survenue.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
