import { type Tweet } from "agent-twitter-client";
import { type IAgentRuntime, type Memory, type Content } from "@elizaos/core";
import { ClientBase } from "../base";

// Interface for defining an action that can be triggered by keywords
export interface IKeywordAction {
    keywords: string[];  // Keywords that trigger this action
    action: (tweet: Tweet, runtime: IAgentRuntime) => Promise<{
        response: string;  // The response to send back
        data?: any;       // Any additional data from the action
        ACTION ?: string;  // The action to take
    }>;
}

export class KeywordActionPlugin {
    private actions: IKeywordAction[] = [];
    private client: ClientBase;
    private runtime: IAgentRuntime;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    // Register a new keyword action
    registerAction(action: IKeywordAction) {
        this.actions.push(action);
    }

    // Check if text contains any of the keywords
    private containsKeywords(text: string, keywords: string[]): boolean {
        const lowerText = text.toLowerCase();
        return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
    }

    // Process a tweet and check for keyword actions
    async processTweet(tweet: Tweet): Promise<{
        hasAction: boolean;
        action?: string;
        response?: string;
        data?: any;
    }> {
        const tweetText = tweet.text?.toLowerCase() || '';

        // Check each registered action
        for (const actionHandler of this.actions) {
            if (this.containsKeywords(tweetText, actionHandler.keywords)) {
                try {
                    const result = await actionHandler.action(tweet, this.runtime);
                    return {
                        hasAction: true,
                        response: result.response,
                        data: result.data,
                        action: result.ACTION
                    };
                } catch (error) {
                    console.error('Error executing keyword action:', error);
                    return {
                        hasAction: true,
                        response: "I encountered an error while processing your request."
                    };
                }
            }
        }

        // No keyword actions matched
        return {
            hasAction: false
        };
    }
}

// Example usage:
/*
const plugin = new KeywordActionPlugin(client, runtime);

// Register an action
plugin.registerAction({
    keywords: ["weather", "forecast"],
    action: async (tweet, runtime) => {
        // Extract location from tweet
        // Call weather API
        // Format response
        return {
            response: "Weather information...",
            data: { temperature: 20, condition: "sunny" }
        };
    }
});

// In your tweet handler:
const result = await plugin.processTweet(tweet);
if (result.hasAction) {
    // Send the response
    await sendTweet(result.response);
} else {
    // Handle normally
    // ...
}
*/ 