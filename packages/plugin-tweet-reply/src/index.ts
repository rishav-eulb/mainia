import { Plugin } from "@elizaos/core";
import { tweetReplyListener } from "./listener";
import { replyAction } from "./actions/reply";

export * from "./types";
export * from "./circuit-breaker";
export * from "./block-fetcher";
export * from "./block-processor";

export const tweetReplyPlugin: Plugin = {
    name: "tweet-reply",
    description: "Plugin for automated tweet replies based on blockchain events",
    actions: [replyAction],
    evaluators: [],
    providers: [],
    services: [tweetReplyListener]
};

export default tweetReplyPlugin; 