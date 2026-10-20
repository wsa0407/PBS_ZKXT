// Transport/progress receipts remain auditable but are not things an expert said.
export function isConversationMessage(message) {
  return message.payload?.visibility !== "activity" && !["activity", "delivery"].includes(message.payload?.kind);
}
