const {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  FileUploadBuilder,
} = require('discord.js');

function buildCoreModal() {
  const title = new LabelBuilder()
    .setLabel('Title')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
    );

  const description = new LabelBuilder()
    .setLabel('Bug description')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setRequired(true),
    );

  const steps = new LabelBuilder()
    .setLabel('Steps to reproduce')
    .setDescription('Optional')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('steps').setStyle(TextInputStyle.Paragraph).setRequired(false),
    );

  const device = new LabelBuilder()
    .setLabel('Device')
    .setStringSelectMenuComponent(
      new StringSelectMenuBuilder()
        .setCustomId('device')
        .setRequired(true)
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('PC').setValue('PC'),
          new StringSelectMenuOptionBuilder().setLabel('Mobile').setValue('Mobile'),
          new StringSelectMenuOptionBuilder().setLabel('Tablet').setValue('Tablet'),
          new StringSelectMenuOptionBuilder().setLabel('Console').setValue('Console'),
        ),
    );

  const priority = new LabelBuilder()
    .setLabel('Priority tag')
    .setStringSelectMenuComponent(
      new StringSelectMenuBuilder()
        .setCustomId('priority')
        .setRequired(true)
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Low').setValue('LOW'),
          new StringSelectMenuOptionBuilder().setLabel('Medium').setValue('MEDIUM'),
          new StringSelectMenuOptionBuilder().setLabel('High').setValue('HIGH'),
          new StringSelectMenuOptionBuilder().setLabel('Critical').setValue('CRITICAL'),
        ),
    );

  return new ModalBuilder()
    .setCustomId('bugReportModal1')
    .setTitle('Report a bug (1 of 2)')
    .addLabelComponents(title, description, steps, device, priority);
}

function buildEvidenceModal() {
  const evidenceFile = new LabelBuilder()
    .setLabel('Evidence (upload)')
    .setDescription('Optional if you provide a link below')
    .setFileUploadComponent(
      new FileUploadBuilder().setCustomId('evidenceFile').setMinValues(0).setMaxValues(1).setRequired(false),
    );

  const evidenceLink = new LabelBuilder()
    .setLabel('Evidence link')
    .setDescription('Medal, Drive, Streamable, etc. Optional if you uploaded a file above')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('evidenceLink').setStyle(TextInputStyle.Short).setRequired(false),
    );

  const f9File = new LabelBuilder()
    .setLabel('F9 (upload)')
    .setDescription('Optional if you provide a link below')
    .setFileUploadComponent(
      new FileUploadBuilder().setCustomId('f9File').setMinValues(0).setMaxValues(1).setRequired(false),
    );

  const f9Link = new LabelBuilder()
    .setLabel('F9 link')
    .setDescription('Medal, Drive, Streamable, etc. Optional if you uploaded a file above')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('f9Link').setStyle(TextInputStyle.Short).setRequired(false),
    );

  const additionalInfo = new LabelBuilder()
    .setLabel('Additional info')
    .setDescription('Optional')
    .setTextInputComponent(
      new TextInputBuilder().setCustomId('additionalInfo').setStyle(TextInputStyle.Paragraph).setRequired(false),
    );

  return new ModalBuilder()
    .setCustomId('bugReportModal2')
    .setTitle('Report a bug (2 of 2)')
    .addLabelComponents(evidenceFile, evidenceLink, f9File, f9Link, additionalInfo);
}

module.exports = { buildCoreModal, buildEvidenceModal };
