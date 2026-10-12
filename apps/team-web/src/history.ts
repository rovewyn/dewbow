import { visibleMessages as projectMessages } from "@dewbow/core-ui/chat/model";
import type { ChatHistoryState } from "@dewbow/core-ui/chat/model";
export { emptyHistory, mergeHistory, restrictHistory } from "@dewbow/core-ui/chat/model";
export type HistoryState = ChatHistoryState;
export const visibleMessages = (state: HistoryState) => projectMessages(Object.values(state.saved), Object.values(state.live));
