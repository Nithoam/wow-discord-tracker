import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import * as store from './store';
import * as blizzard from './blizzard';
import type Tracker from './tracker';

export const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Suivre un personnage WoW')
    .addStringOption((opt) =>
      opt.setName('personnage').setDescription('Nom du personnage').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('royaume').setDescription('Nom du royaume (ex: hyjal, ysondre)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Arrêter de suivre un personnage WoW')
    .addStringOption((opt) =>
      opt.setName('personnage').setDescription('Nom du personnage').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('royaume').setDescription('Nom du royaume').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Lister les personnages suivis'),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Forcer une vérification immédiate de tous les personnages'),

  new SlashCommandBuilder()
    .setName('simulate')
    .setDescription('Prévisualiser le rendu des alertes avec des données fictives'),
];

export async function handleCommand(interaction: ChatInputCommandInteraction, tracker: Tracker): Promise<void> {
  const { commandName } = interaction;

  if (commandName === 'track') {
    const name = interaction.options.getString('personnage', true);
    const realm = interaction.options.getString('royaume', true);
    const realmSlug = realm.toLowerCase().replace(/\s+/g, '-');

    await interaction.deferReply();

    // Vérifier que le personnage existe sur l'API Blizzard
    const info = await blizzard.getCharacterInfo(realmSlug, name);
    if (!info) {
      await interaction.editReply(
        `Personnage **${name}-${realm}** introuvable sur l'API Blizzard. Vérifie le nom et le royaume.`
      );
      return;
    }

    const added = store.addCharacter(name, realm);
    if (!added) {
      await interaction.editReply(`**${info.name}-${info.realm}** est déjà suivi.`);
      return;
    }

    await interaction.editReply(
      `**${info.name}-${info.realm}** (${info.class} ${info.level}) est maintenant suivi !`
    );
    return;
  }

  if (commandName === 'untrack') {
    const name = interaction.options.getString('personnage', true);
    const realm = interaction.options.getString('royaume', true);

    const removed = store.removeCharacter(name, realm);
    if (!removed) {
      await interaction.reply({ content: `Ce personnage n'est pas dans la liste.`, ephemeral: true });
      return;
    }

    await interaction.reply(`**${name}-${realm}** n'est plus suivi.`);
    return;
  }

  if (commandName === 'list') {
    const characters = store.getCharacters();
    if (characters.length === 0) {
      await interaction.reply({ content: 'Aucun personnage suivi. Utilise `/track` pour en ajouter.', ephemeral: true });
      return;
    }

    const lines = characters.map(
      (c) => `- **${c.name}**-${c.realm} | M+ : ${Math.round(c.lastRating)}`
    );

    await interaction.reply({
      content: `**Personnages suivis (${characters.length}) :**\n${lines.join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  if (commandName === 'check') {
    await interaction.deferReply({ ephemeral: true });
    if (tracker) {
      await tracker.checkAll();
    }
    await interaction.editReply('Vérification terminée !');
    return;
  }

  if (commandName === 'simulate') {
    await interaction.deferReply({ ephemeral: true });
    await tracker.simulate();
    await interaction.editReply('Simulation envoyée !');
    return;
  }
}
