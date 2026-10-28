/**
 * The notification hub (docs/design/notifications.md): actions record events with `notify`, the
 * platforms' one-minute tick calls `drain`, and channels deliver. Everything here is core code over
 * the Store and the Mailer port, the same on every platform.
 */
export type {
  ActorView,
  AnyDeliveryItem,
  Channel,
  DeliveryBatch,
  DeliveryItem,
  DeliveryResult,
  EventDetails,
} from './channel.ts'
export { channelsOf } from './channel.ts'
export { type DrainOptions, type DrainResult, drain } from './drain.ts'
export { emailChannel, renderBatchEmail } from './email.ts'
export { addressHash } from './log.ts'
export {
  type Acting,
  type EventData,
  eventIdOf,
  type NewEvent,
  notify,
  notifyAudienceChange,
  notifyComment,
  notifyMembersAdded,
} from './notify.ts'
export { TEMPLATES } from './templates/index.ts'
export {
  applyUnsubscribe,
  signUnsubscribeToken,
  type UnsubscribeTarget,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './unsubscribe.ts'
