/** @deprecated Import from ./transports/discord-api.js instead. Kept for test compatibility. */
export {
  REQUIRED_PERMISSIONS,
  REQUIRED_PERMISSION_BITS,
  PERMISSION_NAMES,
  DiscordApiError,
  discordFetch,
  sendEnvelopeToChannel as sendEnvelope,
  fetchMessagesAfter,
  getBotUser,
  getChannel,
  computeEffectivePermissions,
  isChannelPubliclyReadable,
  checkBotPermissions,
} from './transports/discord-api.js';
